use routecodex_v4_base_node::Scope;
use routecodex_v4_cli::{
    Cli, ConfigIntent, ConfigPathIntent, InitIntent, ManagedChildIntent, RestartIntent,
    ServerIntent, ServerStartIntent, ServertoolIntent, SnapshotIntent, StartIntent, StopIntent,
    V4CommandIntent,
};
use routecodex_v4_config::{
    compile_runtime_config_file, default_runtime_config_path, load_runtime_manifest,
    write_runtime_authoring, write_runtime_manifest_atomic, RuntimeConfigManifest,
    RuntimeInitOptions, RuntimeProductConfig, RuntimeProductRouteGroup,
};
use routecodex_v4_debug::{DiagnosticEventEnvelope, SubscriptionTopic, V4Debug02BusSubscription};
use routecodex_v4_error::ErrorChain;
use routecodex_v4_error::{DecisionAction, ExecutionDecision, RetryPolicy};
use routecodex_v4_lifecycle::{
    exec_managed_restart, release_for_foreground, repair_stale, request_restart, request_stop,
    start_managed, status_managed, LifecycleError, ManagedAction, ManagedControlPlane,
    ManagedInstanceRecord, ManagedSpawnOptions, V4LifecyclePaths,
};
use routecodex_v4_node_container::ExecutionEpochSnapshot;
use routecodex_v4_provider::{
    write_provider_profile, ProviderInitAuth, ProviderInitOptions, ProviderResponseStream,
    V4Availability01SessionScoped,
};
use routecodex_v4_router::{
    apply_product_error_policy, select_product_target_excluding, select_target,
};
use routecodex_v4_runtime::{
    project_runtime_fault, project_runtime_fault_with_policy, ResponseStreamDisposition,
    ResponseStreamProcessor, RuntimeFault, SkeletonRuntime,
};
use routecodex_v4_server::{
    AsyncHttpHandler, AsyncHttpServer, HttpHandler, HttpRequest, HttpResponse, ResponseStream,
};
use routecodex_v4_servertool::{build_run_projection, ServertoolRunInput};
use routecodex_v4_standard_plugins::diagnostic;
use routecodex_v4_standard_plugins::sse_transport::{
    SseEgressPlugin, SseIngressPlugin, SseTransportPolicy,
};
use std::future::Future;
use std::io::Write;
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;
use sha2::{Digest, Sha256};
use tokio_util::sync::CancellationToken;

const VERSION: &str = concat!(env!("CARGO_PKG_VERSION"), "-v4");
pub const RCCV4_BINARY_IDENTITY: &str = "rccv4";

fn main() {
    let cli = match Cli::parse_with_version(std::env::args_os(), VERSION) {
        Ok(cli) => cli,
        Err(error) => error.exit(),
    };
    match dispatch(cli.command_or_start()) {
        Ok(Some(output)) => println!("{output}"),
        Ok(None) => {}
        Err(error) => {
            eprintln!("rccv4: {error}");
            std::process::exit(1);
        }
    }
}

fn dispatch(command: V4CommandIntent) -> Result<Option<String>, String> {
    match command {
        V4CommandIntent::Config {
            command: ConfigIntent::Check(intent),
        } => check_config(intent).map(Some),
        V4CommandIntent::Init(intent) => initialize(intent).map(Some),
        V4CommandIntent::Start(intent) => start(intent).map(Some),
        V4CommandIntent::Status(intent) => status(intent).map(Some),
        V4CommandIntent::RepairStale(intent) => repair_stale_state(intent).map(Some),
        V4CommandIntent::Restart(intent) => restart(intent).map(Some),
        V4CommandIntent::Stop(intent) => stop(intent).map(Some),
        V4CommandIntent::Servertool {
            command: ServertoolIntent::Run(intent),
        } => run_servertool(intent).map(Some),
        V4CommandIntent::Server { command } => dispatch_server(command),
    }
}

fn initialize(intent: InitIntent) -> Result<String, String> {
    let config = config_path(ConfigPathIntent {
        config: intent.config,
    })?;
    if config.exists() && !intent.force {
        return Err(format!(
            "runtime config {} already exists; pass --force to replace it",
            config.display()
        ));
    }
    let provider_id = intent.provider.unwrap_or_else(|| "openai".to_string());
    let base_url = match intent.base_url {
        Some(value) => value,
        None if provider_id == "openai" => "https://api.openai.com/v1".to_string(),
        None => return Err("--base-url is required for a non-openai provider".to_string()),
    };
    let model = match intent.model {
        Some(value) => value,
        None if provider_id == "openai" => "gpt-5.5".to_string(),
        None => return Err("--model is required for a non-openai provider".to_string()),
    };
    let port = intent
        .port
        .ok_or_else(|| "--port is required; V4 has no hardcoded listener port".to_string())?;
    let auth = match (intent.api_key, intent.env, intent.token_file) {
        (Some(value), None, None) if !value.trim().is_empty() => ProviderInitAuth::Inline(value),
        (None, Some(value), None) if !value.trim().is_empty() => ProviderInitAuth::Env(value),
        (None, None, Some(value)) => ProviderInitAuth::TokenFile(value.display().to_string()),
        _ => {
            return Err(
                "exactly one non-empty --api-key, --env, or --token-file is required".to_string(),
            )
        }
    };
    let directory = config
        .parent()
        .ok_or_else(|| "runtime config path has no parent".to_string())?;
    let provider_path = write_provider_profile(
        directory,
        &ProviderInitOptions {
            provider_id: provider_id.clone(),
            base_url,
            model: model.clone(),
            auth,
        },
        intent.force,
    )
    .map_err(|error| error.to_string())?;
    let manifest = write_runtime_authoring(
        &config,
        &RuntimeInitOptions {
            provider_id,
            provider_config_path: provider_path.display().to_string(),
            model,
            port,
        },
        intent.force,
    )
    .map_err(|error| error.to_string())?;
    Ok(format!(
        "initialized config={} provider={} digest={}",
        config.display(),
        provider_path.display(),
        manifest.manifest_digest
    ))
}

fn run_servertool(intent: routecodex_v4_cli::ServertoolRunIntent) -> Result<String, String> {
    let input = serde_json::from_str(&intent.input_json)
        .map_err(|error| format!("SERVERTOOL_CLI_INVALID_JSON: {error}"))?;
    let projection = build_run_projection(ServertoolRunInput {
        tool_name: intent.tool_name,
        input,
        flow_id: intent.flow,
        session_id: intent.session_id,
        request_id: intent.request_id,
    })
    .map_err(|error| error.to_string())?;
    let _control = projection.control;
    serde_json::to_string(&projection.output).map_err(|error| error.to_string())
}

fn dispatch_server(command: ServerIntent) -> Result<Option<String>, String> {
    match command {
        ServerIntent::Start(intent) => server_start(intent).map(Some),
        ServerIntent::Status(intent) => status(intent).map(Some),
        ServerIntent::Restart(intent) => restart(intent).map(Some),
        ServerIntent::Stop(intent) => stop(intent).map(Some),
        ServerIntent::RunManagedChild(intent) => {
            run_managed_child(intent)?;
            Ok(None)
        }
    }
}

fn config_path(intent: ConfigPathIntent) -> Result<PathBuf, String> {
    intent
        .config
        .map(Ok)
        .unwrap_or_else(|| default_runtime_config_path().map_err(|error| error.to_string()))
}

fn check_config(intent: ConfigPathIntent) -> Result<String, String> {
    let path = config_path(intent)?;
    let manifest = compile_runtime_config_file(&path).map_err(|error| error.to_string())?;
    Ok(format!(
        "config ok: {} listeners={} providers={} routes={} digest={}",
        path.display(),
        manifest.listeners.len(),
        manifest.providers.len(),
        manifest.routes.len(),
        manifest.manifest_digest
    ))
}

fn compile_for_lifecycle(
    config: Option<PathBuf>,
) -> Result<(PathBuf, RuntimeConfigManifest, V4LifecyclePaths), String> {
    let config = config_path(ConfigPathIntent { config })?;
    let manifest = compile_runtime_config_file(&config).map_err(|error| error.to_string())?;
    let paths = V4LifecyclePaths::resolve().map_err(|error| error.to_string())?;
    paths.prepare().map_err(|error| error.to_string())?;
    write_runtime_manifest_atomic(&manifest, &paths.manifest_path)
        .map_err(|error| error.to_string())?;
    Ok((config, manifest, paths))
}

fn start(intent: StartIntent) -> Result<String, String> {
    let config = config_path(ConfigPathIntent {
        config: intent.config,
    })?;
    if intent.foreground {
        let manifest = compile_runtime_config_file(&config).map_err(|error| error.to_string())?;
        print_startup(&manifest);
        let paths = V4LifecyclePaths::resolve().map_err(|error| error.to_string())?;
        release_for_foreground(&paths, Duration::from_secs(15))
            .map_err(|error| error.to_string())?;
        run_foreground(manifest)?;
        return Ok("state=stopped identity=rccv4 foreground=true".to_string());
    }
    let (config, manifest, paths) = compile_for_lifecycle(Some(config))?;
    print_startup(&manifest);
    let executable = std::env::current_exe().map_err(|error| error.to_string())?;
    let record = start_managed(
        &paths,
        &executable,
        &config,
        &paths.manifest_path,
        &spawn_options(&intent.snapshot),
        Duration::from_secs(15),
    )
    .map_err(|error| error.to_string())?;
    println!(
        "state=running identity=rccv4 pid={} listeners={}",
        record.pid,
        record.listeners.join(",")
    );
    Ok(format_status("running", &record))
}

fn status(intent: ConfigPathIntent) -> Result<String, String> {
    if let Some(path) = intent.config {
        compile_runtime_config_file(&path).map_err(|error| error.to_string())?;
    }
    let paths = V4LifecyclePaths::resolve().map_err(|error| error.to_string())?;
    let status = status_managed(&paths).map_err(|error| error.to_string())?;
    Ok(match status.record {
        Some(record) => format_status(&status.state, &record),
        None => "state=stopped identity=rccv4".to_string(),
    })
}

fn repair_stale_state(intent: ConfigPathIntent) -> Result<String, String> {
    if let Some(path) = intent.config {
        compile_runtime_config_file(&path).map_err(|error| error.to_string())?;
    }
    let paths = V4LifecyclePaths::resolve().map_err(|error| error.to_string())?;
    repair_stale(&paths).map_err(|error| error.to_string())?;
    Ok("state=stopped identity=rccv4 repaired=stale".to_string())
}

fn restart(intent: RestartIntent) -> Result<String, String> {
    let (config, manifest, paths) = compile_for_lifecycle(intent.config)?;
    let timeout = Duration::from_millis(intent.timeout_ms);
    match request_restart(&paths, &manifest.manifest_digest, timeout) {
        Ok(record) => Ok(format_status("restarted", &record)),
        Err(LifecycleError::NotRunning) => {
            let executable = std::env::current_exe().map_err(|error| error.to_string())?;
            let record = start_managed(
                &paths,
                &executable,
                &config,
                &paths.manifest_path,
                &ManagedSpawnOptions::default(),
                timeout,
            )
            .map_err(|error| error.to_string())?;
            Ok(format_status("running", &record))
        }
        Err(error) => Err(error.to_string()),
    }
}

fn stop(intent: StopIntent) -> Result<String, String> {
    if let Some(path) = intent.config {
        compile_runtime_config_file(&path).map_err(|error| error.to_string())?;
    }
    let paths = V4LifecyclePaths::resolve().map_err(|error| error.to_string())?;
    request_stop(&paths, Duration::from_millis(intent.timeout_ms))
        .map_err(|error| error.to_string())?;
    Ok("state=stopped identity=rccv4".to_string())
}

fn server_start(intent: ServerStartIntent) -> Result<String, String> {
    if !intent.foreground {
        return start(StartIntent {
            config: intent.config,
            foreground: false,
            snapshot: intent.snapshot,
        });
    }
    let config = config_path(ConfigPathIntent {
        config: intent.config,
    })?;
    let manifest = compile_runtime_config_file(&config).map_err(|error| error.to_string())?;
    print_startup(&manifest);
    run_foreground(manifest)?;
    Ok("state=stopped identity=rccv4 foreground=true".to_string())
}

fn print_startup(manifest: &RuntimeConfigManifest) {
    let listeners = manifest
        .listeners
        .iter()
        .map(|listener| listener.address.clone())
        .collect::<Vec<_>>();
    let binary = std::env::current_exe()
        .map(|path| path.display().to_string())
        .unwrap_or_else(|_| "unknown".to_string());
    let (headline, debug) =
        diagnostic::format_startup(&manifest.runtime_identity, VERSION, &binary, &listeners);
    println!("{headline}");
    println!("{debug}");
    let _ = std::io::stdout().flush();
}

fn run_managed_child(intent: ManagedChildIntent) -> Result<(), String> {
    let manifest = load_runtime_manifest(&intent.manifest).map_err(|error| error.to_string())?;
    let servers = bind_servers(&manifest)?;
    let paths = V4LifecyclePaths::resolve().map_err(|error| error.to_string())?;
    if paths.manifest_path != intent.manifest {
        return Err("managed manifest path does not match V4 lifecycle owner".to_string());
    }
    let record = ManagedInstanceRecord {
        runtime_identity: manifest.runtime_identity.clone(),
        pid: std::process::id(),
        generation_nonce: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|error| error.to_string())?
            .as_nanos(),
        config_path: intent.config.display().to_string(),
        manifest_path: intent.manifest.display().to_string(),
        manifest_digest: manifest.manifest_digest.clone(),
        listeners: manifest
            .listeners
            .iter()
            .map(|listener| listener.address.clone())
            .collect(),
    };
    let control = ManagedControlPlane::bind(paths, record).map_err(|error| error.to_string())?;
    let listeners = manifest
        .listeners
        .iter()
        .map(|listener| listener.address.clone())
        .collect::<Vec<_>>();
    let binary = std::env::current_exe()
        .map(|path| path.display().to_string())
        .unwrap_or_else(|_| "unknown".to_string());
    let (headline, debug) =
        diagnostic::format_startup(&manifest.runtime_identity, VERSION, &binary, &listeners);
    println!("{headline}");
    println!("{debug}");
    let _ = std::io::stdout().flush();
    let stop = Arc::new(AtomicBool::new(false));
    let handles = spawn_servers(servers, manifest.clone(), Arc::clone(&stop));
    let action = loop {
        if handles.iter().any(thread::JoinHandle::is_finished) {
            stop.store(true, Ordering::Release);
            join_servers(handles)?;
            control.clear_record().map_err(|error| error.to_string())?;
            return Err("V4 listener exited before lifecycle stop or restart".to_string());
        }
        match control.poll().map_err(|error| error.to_string())? {
            ManagedAction::Continue => thread::sleep(Duration::from_millis(10)),
            action => break action,
        }
    };
    stop.store(true, Ordering::Release);
    join_servers_for_shutdown(handles)?;
    control.clear_record().map_err(|error| error.to_string())?;
    drop(control);
    if action == ManagedAction::Restart {
        // macOS may retain the just-closed TCP listener briefly after the
        // shutdown join. Give the kernel a bounded handoff window before the
        // exec image binds the same aggregate listener again.
        thread::sleep(Duration::from_millis(100));
        let executable = std::env::current_exe().map_err(|error| error.to_string())?;
        let error = exec_managed_restart(
            &executable,
            &intent.config,
            &intent.manifest,
            &spawn_options(&intent.snapshot),
        );
        return Err(error.to_string());
    }
    Ok(())
}

fn run_foreground(manifest: RuntimeConfigManifest) -> Result<(), String> {
    let servers = bind_servers(&manifest)?;
    let stop = Arc::new(AtomicBool::new(false));
    join_servers(spawn_servers(servers, manifest, stop))
}

fn bind_servers(manifest: &RuntimeConfigManifest) -> Result<Vec<String>, String> {
    Ok(manifest
        .listeners
        .iter()
        .map(|listener| listener.address.clone())
        .collect())
}

fn spawn_servers(
    servers: Vec<String>,
    manifest: RuntimeConfigManifest,
    stop: Arc<AtomicBool>,
) -> Vec<thread::JoinHandle<Result<(), String>>> {
    servers
        .into_iter()
        .map(|server| {
            let manifest = manifest.clone();
            let stop = Arc::clone(&stop);
            thread::spawn(move || {
                let runtime = tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                    .map_err(|error| error.to_string())?;
                let result = runtime.block_on(async move {
                    let server = AsyncHttpServer::bind_persisted(&server)
                        .await
                        .map_err(|error| error.to_string())?;
                    let handler = Arc::new(PipelineHandler::new(manifest)?);
                    let cancellation = CancellationToken::new();
                    let watcher = cancellation.clone();
                    tokio::spawn(async move {
                        while !stop.load(Ordering::Acquire) {
                            tokio::time::sleep(Duration::from_millis(10)).await;
                        }
                        watcher.cancel();
                    });
                    server
                        .run_until(handler, cancellation)
                        .await
                        .map_err(|error| error.to_string())
                });
                // A disconnected client can leave a synchronous provider
                // call in spawn_blocking. Do not let runtime drop wait
                // forever for that task during managed restart; the bounded
                // shutdown preserves lifecycle progress and the process
                // replacement reclaims any remaining worker threads.
                runtime.shutdown_timeout(Duration::from_secs(1));
                result
            })
        })
        .collect()
}

fn join_servers(handles: Vec<thread::JoinHandle<Result<(), String>>>) -> Result<(), String> {
    for handle in handles {
        handle
            .join()
            .map_err(|_| "V4 listener thread panicked".to_string())??;
    }
    Ok(())
}

fn join_servers_for_shutdown(
    handles: Vec<thread::JoinHandle<Result<(), String>>>,
) -> Result<(), String> {
    for handle in handles {
        let result = handle
            .join()
            .map_err(|_| "V4 listener thread panicked".to_string())?;
        if let Err(error) = result {
            if error != "HTTP accept failed: Invalid argument (os error 22)" {
                return Err(error);
            }
        }
    }
    Ok(())
}

fn spawn_options(snapshot: &SnapshotIntent) -> ManagedSpawnOptions {
    ManagedSpawnOptions {
        snap: snapshot.snap,
        snapall: snapshot.snapall,
        snap_stages: snapshot.snap_stages.clone(),
        debug: snapshot.debug,
        sse_dump: snapshot.sse_dump,
    }
}

fn format_status(state: &str, record: &ManagedInstanceRecord) -> String {
    format!(
        "state={state} identity={} pid={} listeners={} digest={}",
        record.runtime_identity,
        record.pid,
        record.listeners.join(","),
        record.manifest_digest
    )
}

#[derive(Clone)]
struct PipelineHandler {
    manifest: RuntimeConfigManifest,
    runtime: Arc<Mutex<SkeletonRuntime>>,
    execution_epoch: ExecutionEpochSnapshot,
    availability: Arc<Mutex<V4Availability01SessionScoped>>,
    event_bus: Arc<Mutex<V4Debug02BusSubscription>>,
}

impl PipelineHandler {
    fn new(manifest: RuntimeConfigManifest) -> Result<Self, String> {
        let runtime =
            SkeletonRuntime::from_compiled_plan(manifest.execution_epoch.skeleton.clone())
                .map_err(|error| error.to_string())?;
        let transaction_id = format!("runtime-config:{}", &manifest.manifest_digest[7..23]);
        runtime
            .prepare_compiled_execution_epoch(
                &transaction_id,
                0,
                routecodex_v4_node_container::ZERO_BASE_MANIFEST_HASH,
                &manifest.execution_epoch.candidate,
                &manifest.execution_epoch.graph_hash,
                &manifest.execution_epoch.manifest_hash,
            )
            .map_err(|error| error.to_string())?;
        runtime
            .commit_execution_epoch(&transaction_id)
            .map_err(|error| error.to_string())?;
        let execution_epoch = runtime
            .admit_request("runtime-epoch-readiness")
            .map_err(|error| error.to_string())?
            .snapshot();
        Ok(Self {
            manifest,
            runtime: Arc::new(Mutex::new(runtime)),
            execution_epoch,
            availability: Arc::new(Mutex::new(V4Availability01SessionScoped::new())),
            event_bus: Arc::new(Mutex::new(V4Debug02BusSubscription::new())),
        })
    }
}

impl PipelineHandler {
    fn handle_request(&self, request: HttpRequest) -> HttpResponse {
        debug_assert_eq!(
            self.execution_epoch.state,
            routecodex_v4_node_container::ExecutionEpochState::Active
        );
        match (request.method.as_str(), request.path.as_str()) {
            ("GET", "/health") => json_response(
                200,
                serde_json::json!({
                    "id": self.manifest.runtime_identity,
                    "version": VERSION,
                    "manifest_digest": self.manifest.manifest_digest,
                }),
            ),
            ("GET", "/v1/models") => models_response(&self.manifest),
            ("POST", "/v1/responses") => handle_responses(
                &self.manifest,
                &self.runtime,
                &self.availability,
                &self.event_bus,
                &request,
                "responses",
                "direct",
            )
            .unwrap_or_else(|response| response),
            ("POST", "/v1/chat/completions") => handle_responses(
                &self.manifest,
                &self.runtime,
                &self.availability,
                &self.event_bus,
                &request,
                "chat",
                "relay",
            )
            .unwrap_or_else(|response| response),
            _ => project_fault(
                &request,
                RuntimeFault::new("route_not_found", "route not found"),
                404,
            ),
        }
    }
}

impl HttpHandler for PipelineHandler {
    fn handle(&mut self, request: HttpRequest) -> HttpResponse {
        self.handle_request(request)
    }
}

impl AsyncHttpHandler for PipelineHandler {
    fn handle_async<'a>(
        &'a self,
        request: HttpRequest,
        _cancellation: CancellationToken,
    ) -> Pin<Box<dyn Future<Output = HttpResponse> + Send + 'a>> {
        let handler = self.clone();
        let request_for_fault = request.clone();
        Box::pin(async move {
            tokio::task::spawn_blocking(move || handler.handle_request(request))
                .await
                .unwrap_or_else(|error| {
                    project_fault(
                        &request_for_fault,
                        RuntimeFault::new("request_worker_panicked", error.to_string()),
                        500,
                    )
                })
        })
    }
}

fn models_response(manifest: &RuntimeConfigManifest) -> HttpResponse {
    let mut models = if let Some(product) = &manifest.product {
        product
            .providers
            .iter()
            .flat_map(|provider| {
                provider.models.iter().flat_map(|model| {
                    std::iter::once(model.model_id.as_str())
                        .chain(model.aliases.iter().map(String::as_str))
                })
            })
            .collect::<Vec<_>>()
    } else {
        manifest
            .routes
            .iter()
            .flat_map(|route| route.models.iter().map(String::as_str))
            .collect::<Vec<_>>()
    };
    models.sort();
    models.dedup();
    json_response(
        200,
        serde_json::json!({
            "object": "list",
            "data": models.into_iter().map(|model| serde_json::json!({
                "id": model,
                "object": "model",
                "owned_by": "routecodex-v4"
            })).collect::<Vec<_>>()
        }),
    )
}

fn execute_retry_wire(
    runtime: &Arc<Mutex<SkeletonRuntime>>,
    request_body: &str,
    entry_protocol: &str,
    target: &routecodex_v4_router::SelectedTarget,
    stream: bool,
    request_id: &str,
    port: u16,
    session_scope: &str,
    conversation_scope: &str,
    continuation_owner: &str,
    lease: &routecodex_v4_runtime::RuntimeLease,
) -> Result<serde_json::Value, RuntimeFault> {
    let report = runtime
        .lock()
        .map_err(|_| RuntimeFault::new("request_runtime_lock", "request runtime lock poisoned"))?
        .execute_request_json_scoped_for_target_with_lease(
            request_body,
            entry_protocol,
            &target.protocol,
            &target.wire_model,
            stream,
            request_id,
            port,
            session_scope,
            conversation_scope,
            Some(continuation_owner),
            Some(lease),
        )?;
    report
        .provider_wire_value
        .ok_or_else(|| RuntimeFault::new("request_wire_missing", "retry request chain produced no provider wire"))
}

fn route_group_for_request<'a>(
    product: &'a RuntimeProductConfig,
    request: &HttpRequest,
) -> Result<&'a RuntimeProductRouteGroup, RuntimeFault> {
    let requested = request.header("x-rccv4-route-group-id");
    match requested {
        Some(route_group_id) => product
            .route_groups
            .iter()
            .find(|group| group.route_group_id == route_group_id)
            .ok_or_else(|| {
                RuntimeFault::new(
                    "product_route_group_missing",
                    "requested route group is not configured",
                )
            }),
        None if product.route_groups.len() == 1 => Ok(&product.route_groups[0]),
        None => Err(RuntimeFault::new(
            "product_route_group_ambiguous",
            "route group header is required when multiple route groups are configured",
        )),
    }
}

fn handle_responses(
    manifest: &RuntimeConfigManifest,
    runtime: &Arc<Mutex<SkeletonRuntime>>,
    availability: &Arc<Mutex<V4Availability01SessionScoped>>,
    event_bus: &Arc<Mutex<V4Debug02BusSubscription>>,
    request: &HttpRequest,
    entry_protocol: &str,
    continuation_owner: &str,
) -> Result<HttpResponse, HttpResponse> {
    let started_at = std::time::Instant::now();
    let body: serde_json::Value = serde_json::from_slice(&request.body).map_err(|error| {
        project_fault(
            request,
            RuntimeFault::new("invalid_request", format!("invalid JSON: {error}")),
            400,
        )
    })?;
    if entry_protocol == "responses"
        && continuation_owner == "relay"
        && body.get("previous_response_id").is_some()
    {
        return Err(project_fault(
            request,
            RuntimeFault::new(
                "continuation_unsupported",
                "local relay continuation is not implemented",
            ),
            400,
        ));
    }
    if entry_protocol != "responses" && body.get("previous_response_id").is_some() {
        return Err(project_fault(
            request,
            RuntimeFault::new(
                "continuation_entry_protocol_mismatch",
                "previous_response_id is only valid on the Responses entry protocol",
            ),
            400,
        ));
    }
    let session_scope = request
        .header("x-rccv4-session-id")
        .unwrap_or(&request.request_id);
    let conversation_scope = request
        .header("x-rccv4-conversation-id")
        .unwrap_or(session_scope);
    let model = body
        .get("model")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| {
            project_fault(
                request,
                RuntimeFault::new("invalid_request", "model is required"),
                400,
            )
        })?;
    let stream_mode = body
        .get("stream")
        .map(|value| {
            value.as_bool().ok_or_else(|| {
                project_fault(
                    request,
                    RuntimeFault::new("invalid_request", "stream must be a boolean"),
                    400,
                )
            })
        })
        .transpose()?
        .unwrap_or(false);
    let unavailable_provider_ids = if let Some(product) = &manifest.product {
        let group = route_group_for_request(product, request)
            .map_err(|error| project_fault(request, error, 500))?;
        let availability_guard = availability.lock().map_err(|_| {
            project_fault(
                request,
                RuntimeFault::new("availability_lock", "provider availability lock poisoned"),
                500,
            )
        })?;
        product
            .providers
            .iter()
            .filter(|provider| {
                !availability_guard.is_eligible(
                    &request.port.to_string(),
                    &group.route_group_id,
                    session_scope,
                    &provider.provider_id,
                )
            })
            .map(|provider| provider.provider_id.clone())
            .collect::<Vec<_>>()
    } else {
        Vec::new()
    };
    let mut target = if let Some(product) = &manifest.product {
        let route_group = route_group_for_request(product, request)
            .map_err(|error| project_fault(request, error, 500))?;
        select_product_target_excluding(
            product,
            &route_group.route_group_id,
            model,
            entry_protocol,
            &[],
            0,
            &unavailable_provider_ids
                .iter()
                .map(String::as_str)
                .collect::<Vec<_>>(),
        )
    } else {
        select_target(&manifest.providers, &manifest.routes, model)
    }
    .map_err(|error| {
        let status = if !unavailable_provider_ids.is_empty()
            && matches!(
                error,
                routecodex_v4_router::TargetSelectionError::ProductPoolUnavailable(_)
            ) {
            503
        } else {
            404
        };
        project_fault(
            request,
            RuntimeFault::new(
                if status == 503 {
                    "provider_pool_exhausted"
                } else {
                    "model_unavailable"
                },
                format!("{} (requested_model={})", error, model),
            ),
            status,
        )
    })?;
    let continuation_owner = if entry_protocol == "responses" {
        // V4 retains only provider-owned Direct Responses continuation.
        // Local/relay continuation is retired and must never be inferred from
        // provider profile configuration.
        "direct".to_string()
    } else {
        continuation_owner.to_string()
    };
    let request_id = request.request_id.clone();
    let request_lease = runtime
        .lock()
        .map_err(|_| {
            project_fault(
                request,
                RuntimeFault::new("request_runtime_lock", "request runtime lock poisoned"),
                500,
            )
        })?
        .admit_request(&request_id)
        .map_err(|fault| project_fault(request, fault, 598))?;
    let request_report = runtime
        .lock()
        .map_err(|_| {
            project_fault(
                request,
                RuntimeFault::new("request_runtime_lock", "request runtime lock poisoned"),
                500,
            )
        })?
        .execute_request_json_scoped_for_target_with_lease(
            &String::from_utf8_lossy(&request.body),
            entry_protocol,
            &target.protocol,
            &target.wire_model,
            stream_mode,
            &request_id,
            request.port,
            session_scope,
            conversation_scope,
            Some(&continuation_owner),
            Some(&request_lease),
        )
        .map_err(|fault| project_fault(request, fault, 598))?;
    emit_payload_console_events(
        event_bus,
        &request_report.trace,
        request,
        &request.path,
        &target.provider_id,
        &target.wire_model,
        stream_mode,
        None,
        started_at.elapsed(),
    );
    let request_scope = request_report.scope.clone();
    let semantic_body = request_report.provider_wire_value.ok_or_else(|| {
        project_fault(
            request,
            RuntimeFault::new(
                "request_wire_missing",
                "request chain produced no provider wire",
            ),
            598,
        )
    })?;
    let wire_body = semantic_body;
    if stream_mode {
        let mut stream = routecodex_v4_provider::send_target_streaming(
            &target.protocol, &target.config_path, target.auth_alias.as_deref(),
            &target.wire_model, &wire_body,
        ).map_err(|error| {
            project_fault(
                request,
                RuntimeFault::new(error.code.as_str(), error.message)
                    .with_status(error.status.unwrap_or(502)),
                error.status.unwrap_or(502),
            )
        })?;
        if stream.status() >= 400 {
            if let Some(product) = manifest.product.as_ref() {
                if let Some(policy) =
                    apply_product_error_policy(product, &target.provider_id, stream.status(), "")
                {
                    let route_group = route_group_for_request(product, request)
                        .map_err(|error| project_fault(request, error, 500))?;
                    record_provider_failure(
                        availability,
                        request,
                        Some(route_group.route_group_id.as_str()),
                        session_scope,
                        &target.provider_id,
                        policy.cooldown,
                        policy.failure_threshold,
                    )?;
                    if policy.retry {
                        let mut excluded = unavailable_provider_ids.clone();
                        excluded.push(target.provider_id.clone());
                        if let Ok(candidate) = select_product_target_excluding(
                            product,
                            &route_group.route_group_id,
                            model,
                            entry_protocol,
                            &[],
                            0,
                            &excluded.iter().map(String::as_str).collect::<Vec<_>>(),
                        ) {
                            let retry_body = execute_retry_wire(
                                runtime,
                                &String::from_utf8_lossy(&request.body),
                                entry_protocol,
                                &candidate,
                                true,
                                &request_id,
                                request.port,
                                session_scope,
                                conversation_scope,
                                &continuation_owner,
                                &request_lease,
                            )
                            .map_err(|fault| project_fault(request, fault, 598))?;
                            target = candidate;
                            stream = routecodex_v4_provider::send_target_streaming(
                                &target.protocol, &target.config_path, target.auth_alias.as_deref(),
                                &target.wire_model, &retry_body,
                            ).map_err(|error| {
                                    project_provider_fault(
                                        request,
                                        RuntimeFault::new(&error.code, error.message),
                                        error.status.unwrap_or(502),
                                        manifest.product.as_ref(),
                                        &target.provider_id,
                                        "",
                                    )
                                })?;
                        }
                    }
                }
            }
        }
        let status = stream.status();
        if status >= 400 {
            return Err(project_provider_fault(
                request,
                RuntimeFault::new(
                    "provider_http_error",
                    format!("upstream provider returned HTTP {status}"),
                )
                .with_status(status),
                status,
                manifest.product.as_ref(),
                &target.provider_id,
                "",
            ));
        }
        if !stream
            .content_type()
            .to_ascii_lowercase()
            .contains("text/event-stream")
        {
            return Err(project_fault(
                request,
                RuntimeFault::new(
                    "provider_sse_content_type",
                    format!(
                        "streaming Responses returned unsupported content type {}",
                        stream.content_type()
                    ),
                ),
                502,
            ));
        }
        let client_status = if (200..300).contains(&status) {
            200
        } else {
            status
        };
        let _ = std::io::stdout().flush();
        let response_processor = ResponseStreamProcessor::new(
            request_lease,
            request_scope,
            request.port,
            entry_protocol,
            &target.protocol,
            &continuation_owner,
            session_scope,
            conversation_scope,
        )
        .map_err(|fault| project_fault(request, fault, 599))?;
        let response_stream = CordisSseTransportStream::new(
            stream,
            Arc::clone(runtime),
            response_processor,
            request.clone(),
            target.provider_id.clone(),
            target.wire_model.clone(),
            Arc::clone(event_bus),
        );
        return Ok(HttpResponse::streaming(
            client_status,
            "text/event-stream",
            Box::new(response_stream),
        ));
    }
    let mut raw = routecodex_v4_provider::send_target(
        &target.protocol, &target.config_path, target.auth_alias.as_deref(),
        &target.wire_model, &wire_body, false,
    ).map_err(|error| {
        project_provider_fault(
            request,
            RuntimeFault::new(error.code.as_str(), error.message),
            error.status.unwrap_or(502),
            manifest.product.as_ref(),
            &target.provider_id,
            "",
        )
    })?;
    let mut matched_policy = manifest.product.as_ref().and_then(|product| {
        apply_product_error_policy(
            product,
            &target.provider_id,
            raw.status,
            &String::from_utf8_lossy(&raw.body),
        )
    });
    let mut reselected = false;
    if let Some(product) = manifest.product.as_ref() {
        if let Some(policy) = matched_policy.as_ref() {
            let route_group = route_group_for_request(product, request)
                .map_err(|error| project_fault(request, error, 500))?;
            record_provider_failure(
                availability,
                request,
                Some(route_group.route_group_id.as_str()),
                session_scope,
                &target.provider_id,
                policy.cooldown,
                policy.failure_threshold,
            )?;
            if policy.retry {
                let mut excluded = unavailable_provider_ids.clone();
                excluded.push(target.provider_id.clone());
                if let Ok(candidate) = select_product_target_excluding(
                    product,
                    &route_group.route_group_id,
                    model,
                    entry_protocol,
                    &[],
                    0,
                    &excluded.iter().map(String::as_str).collect::<Vec<_>>(),
                ) {
                    let retry_body = execute_retry_wire(
                        runtime,
                        &String::from_utf8_lossy(&request.body),
                        entry_protocol,
                        &candidate,
                        false,
                        &request_id,
                        request.port,
                        session_scope,
                        conversation_scope,
                        &continuation_owner,
                        &request_lease,
                    )
                    .map_err(|fault| project_fault(request, fault, 598))?;
                    target = candidate;
                    reselected = true;
                    raw = routecodex_v4_provider::send_target(
                        &target.protocol, &target.config_path, target.auth_alias.as_deref(),
                        &target.wire_model, &retry_body, false,
                    ).map_err(|error| {
                        project_provider_fault(
                            request,
                            RuntimeFault::new(&error.code, error.message),
                            error.status.unwrap_or(502),
                            manifest.product.as_ref(),
                            &target.provider_id,
                            "",
                        )
                    })?;
                    matched_policy = apply_product_error_policy(
                        product,
                        &target.provider_id,
                        raw.status,
                        &String::from_utf8_lossy(&raw.body),
                    );
                }
            }
        }
    }
    if raw.status >= 400 || (matched_policy.is_some() && !reselected) {
        return Err(project_provider_fault(
            request,
            RuntimeFault::new(
                "provider_http_error",
                format!("upstream provider returned HTTP {}", raw.status),
            )
            .with_status(raw.status),
            raw.status,
            manifest.product.as_ref(),
            &target.provider_id,
            String::from_utf8_lossy(&raw.body).as_ref(),
        ));
    }
    if let Some(product) = manifest.product.as_ref() {
        let _ = availability
            .lock()
            .map_err(|_| {
                project_fault(
                    request,
                    RuntimeFault::new("availability_lock", "provider availability lock poisoned"),
                    500,
                )
            })?
            .mark_success(
                &request.port.to_string(),
                product
                    .route_groups
                    .first()
                    .map(|group| group.route_group_id.as_str())
                    .unwrap_or("default"),
                session_scope,
                &target.provider_id,
            );
    }
    if raw.content_type.to_ascii_lowercase().contains("text/event-stream") {
        return Err(project_fault(
            request,
            RuntimeFault::new(
                "provider_sse_unexpected",
                "non-stream Responses transport returned SSE payload",
            ),
            502,
        ));
    }
    // Keep the complete provider response as a raw transport envelope. The
    // response inbound NodePluginPlan owns JSON parsing and protocol
    // normalization; runtime-bin must not decode provider semantics here.
    let provider_raw = serde_json::json!({
        "_provider_http_status": raw.status,
        "_provider_http_content_type": raw.content_type,
        "_provider_http_body": String::from_utf8_lossy(&raw.body),
    })
    .to_string();
            let report = runtime
                .lock()
                .map_err(|_| {
                    project_fault(
                        request,
                        RuntimeFault::new(
                            "response_runtime_lock",
                            "response runtime lock poisoned",
                        ),
                        500,
                    )
                })?
                .execute_provider_response_scoped_for_target_with_lease(
                    &provider_raw,
                    &request_id,
                    request.port,
                    session_scope,
                    conversation_scope,
                    entry_protocol,
                    &target.protocol,
                    &continuation_owner,
                    Some(&request_lease),
                )
                .map_err(|fault| project_fault(request, fault, 502))?;
            let frame = report.client_frame.ok_or_else(|| {
                project_fault(
                    request,
                    RuntimeFault::new(
                        "response_frame_missing",
                        "response chain produced no client frame",
                    ),
                    502,
                )
            })?;
            let projected = serde_json::from_str(&frame).map_err(|error| {
                project_fault(
                    request,
                    RuntimeFault::new("response_frame_invalid", error.to_string()),
                    502,
                )
            })?;
            let client_status = if (200..300).contains(&raw.status) {
                200
            } else {
                raw.status
            };
            emit_payload_console_events(
                event_bus,
                &report.trace,
                request,
                &request.path,
                &target.provider_id,
                &target.wire_model,
                stream_mode,
                Some(client_status),
                started_at.elapsed(),
            );
            let _ = std::io::stdout().flush();
            Ok(json_response(client_status, projected))
}

trait ProviderSseSource: Send {
    fn read_chunk(&mut self, chunk: &mut [u8]) -> Result<usize, String>;
    fn wait(&mut self) -> Result<(), String>;
}

impl ProviderSseSource for ProviderResponseStream {
    fn read_chunk(&mut self, chunk: &mut [u8]) -> Result<usize, String> {
        ProviderResponseStream::read_chunk(self, chunk).map_err(|error| error.to_string())
    }

    fn wait(&mut self) -> Result<(), String> {
        ProviderResponseStream::wait(self).map_err(|error| error.to_string())
    }
}

struct CordisSseTransportStream<S = ProviderResponseStream> {
    stream: S,
    runtime: Arc<Mutex<SkeletonRuntime>>,
    processor: ResponseStreamProcessor,
    ingress: SseIngressPlugin,
    egress: SseEgressPlugin,
    close_after_pending: bool,
    request: HttpRequest,
    provider: String,
    model: String,
    started_at: std::time::Instant,
    event_bus: Arc<Mutex<V4Debug02BusSubscription>>,
}

impl<S: ProviderSseSource> CordisSseTransportStream<S> {
    fn new(
        stream: S,
        runtime: Arc<Mutex<SkeletonRuntime>>,
        processor: ResponseStreamProcessor,
        request: HttpRequest,
        provider: String,
        model: String,
        event_bus: Arc<Mutex<V4Debug02BusSubscription>>,
    ) -> Self {
        Self {
            stream,
            runtime,
            processor,
            ingress: SseIngressPlugin::new(
                SseTransportPolicy::new(1024 * 1024, 1024 * 1024, Duration::from_secs(30))
                    .expect("constant SSE transport policy"),
                std::time::Instant::now(),
            ),
            egress: SseEgressPlugin::new(
                SseTransportPolicy::new(1024 * 1024, 1024 * 1024, Duration::from_secs(30))
                    .expect("constant SSE transport policy"),
                std::time::Instant::now(),
            ),
            close_after_pending: false,
            request,
            provider,
            model,
            started_at: std::time::Instant::now(),
            event_bus,
        }
    }

    fn enqueue_disposition(
        &mut self,
        disposition: ResponseStreamDisposition,
    ) -> Result<(), std::io::Error> {
        let (frame, failed) = match disposition {
            ResponseStreamDisposition::Continue { frame } => (frame, false),
            ResponseStreamDisposition::Terminal { frame } => (frame, false),
            ResponseStreamDisposition::Failure { frame } => (frame, true),
        };
        self.egress
            .enqueue(frame, std::time::Instant::now())
            .map_err(|error| {
                std::io::Error::other(format!("client SSE transport failed: {error:?}"))
            })?;
        self.close_after_pending |= failed;
        Ok(())
    }

    fn enqueue_runtime_failure(&mut self, fault: RuntimeFault) -> Result<(), std::io::Error> {
        let disposition = {
            let runtime = self
                .runtime
                .lock()
                .map_err(|_| std::io::Error::other("response runtime lock poisoned"))?;
            self.processor
                .project_failure(&runtime, fault)
                .map_err(|error| std::io::Error::other(error.to_string()))?
        };
        self.enqueue_disposition(disposition)
    }
}

impl<S: ProviderSseSource> ResponseStream for CordisSseTransportStream<S> {
    fn next_chunk(&mut self, chunk: &mut Vec<u8>) -> Result<bool, std::io::Error> {
        loop {
            if let Some(frame) = self.egress.pop() {
                chunk.extend_from_slice(frame.as_bytes());
                return Ok(true);
            }
            if self.close_after_pending {
                return Ok(false);
            }
            let mut bytes = [0u8; 8192];
            let count = match self.stream.read_chunk(&mut bytes) {
                Ok(count) => count,
                Err(error) => {
                    self.enqueue_runtime_failure(RuntimeFault::new(
                        "provider_sse_read",
                        format!("provider SSE read failed: {error}"),
                    ))?;
                    continue;
                }
            };
            if count == 0 {
                if let Err(error) = self.ingress.finish() {
                    let fault = match error {
                        routecodex_v4_standard_plugins::sse_transport::SseTransportError::IncompleteFrame =>
                            RuntimeFault::new(
                                "provider_sse_incomplete_frame",
                                "incomplete provider SSE frame at end of stream",
                            ),
                        other => RuntimeFault::new(
                            "provider_sse_transport",
                            format!("provider SSE framing failed: {other:?}"),
                        ),
                    };
                    self.enqueue_runtime_failure(fault)?;
                    continue;
                }
                if let Err(error) = self.stream.wait() {
                    self.enqueue_runtime_failure(RuntimeFault::new(
                        "provider_sse_closeout",
                        format!("provider SSE closeout failed: {error}"),
                    ))?;
                    continue;
                }
                match self.processor.finish() {
                    Ok(()) => return Ok(false),
                    Err(fault) => {
                        self.enqueue_runtime_failure(fault)?;
                        continue;
                    }
                }
            }
            let frames = match self
                .ingress
                .push_chunk(&bytes[..count], std::time::Instant::now())
            {
                Ok(frames) => frames,
                Err(error) => {
                    self.enqueue_runtime_failure(RuntimeFault::new(
                        "provider_sse_transport",
                        format!("provider SSE framing failed: {error:?}"),
                    ))?;
                    continue;
                }
            };
            for frame in frames {
                let disposition = match self.runtime.lock() {
                    Ok(runtime) => {
                        match self
                            .processor
                            .execute_provider_response_scoped(&runtime, frame)
                        {
                            Ok((disposition, report)) => {
                                if let Some(report) = report.as_ref() {
                                    emit_payload_console_events(
                                        &self.event_bus,
                                        &report.trace,
                                        &self.request,
                                        &self.request.path,
                                        &self.provider,
                                        &self.model,
                                        true,
                                        None,
                                        self.started_at.elapsed(),
                                    );
                                }
                                if let Some(report) = report {
                                    if report.client_frame.is_none() {
                                        Err(RuntimeFault::new(
                                            "response_frame_missing",
                                            "response chain produced no client frame",
                                        ))
                                    } else {
                                        Ok(disposition)
                                    }
                                } else {
                                    Ok(disposition)
                                }
                            }
                            Err(fault) => Err(fault),
                        }
                    }
                    Err(_) => Err(RuntimeFault::new(
                        "response_runtime_lock",
                        "response runtime lock poisoned",
                    )),
                };
                match disposition {
                    Ok(disposition) => self.enqueue_disposition(disposition)?,
                    Err(fault) => {
                        self.enqueue_runtime_failure(fault)?;
                        break;
                    }
                }
            }
        }
    }
}

fn emit_payload_console_events(
    event_bus: &Arc<Mutex<V4Debug02BusSubscription>>,
    trace: &[String],
    request: &HttpRequest,
    endpoint: &str,
    provider: &str,
    model: &str,
    stream: bool,
    status: Option<u16>,
    elapsed: std::time::Duration,
) {
    publish_diagnostic_events(event_bus, request, trace);
    for event in trace {
        if let Some(line) = render_payload_console_event(
            event, request, endpoint, provider, model, stream, status, elapsed,
        ) {
            println!("{line}");
            let _ = std::io::stdout().flush();
        }
    }
}

/// Publish diagnostic facts to the process-local read-only event bus before
/// rendering them. The bus is a side-channel observer: payload bytes and
/// control decisions never cross this boundary, and dispatch is scoped to the
/// immutable request id.
fn publish_diagnostic_events(
    event_bus: &Arc<Mutex<V4Debug02BusSubscription>>,
    request: &HttpRequest,
    trace: &[String],
) {
    let Ok(mut bus) = event_bus.lock() else {
        return;
    };
    let _ = bus.subscribe(
        &format!("console:{}", request.request_id),
        SubscriptionTopic::Diagnostic,
        &request.request_id,
    );
    for entry in trace {
        let Some((plugin_id, _)) = entry.split_once(':') else {
            continue;
        };
        let mut hasher = Sha256::new();
        hasher.update(entry.as_bytes());
        let payload_hash = format!("sha256:{:x}", hasher.finalize());
        let _ = bus.publish(DiagnosticEventEnvelope::new(
            SubscriptionTopic::Diagnostic,
            &request.request_id,
            plugin_id,
            &payload_hash,
        ));
    }
    let _ = bus.dispatch(&SubscriptionTopic::Diagnostic, &request.request_id);
}

fn render_payload_console_event(
    trace_entry: &str,
    request: &HttpRequest,
    endpoint: &str,
    provider: &str,
    model: &str,
    stream: bool,
    status: Option<u16>,
    elapsed: std::time::Duration,
) -> Option<String> {
    let (plugin_id, rest) = trace_entry.split_once(':')?;
    let (kind, message) = rest.split_once(':')?;
    let direct_hook = matches!(plugin_id, "v4.hook.direct.request" | "v4.hook.direct.response");
    if (!(plugin_id.ends_with("payload_console_render") || direct_hook)
        || kind != "console.payload_ready") {
        return None;
    }
    // TTY diagnostics may prefix the payload summary with ANSI color codes.
    // Normalize only the diagnostic presentation carrier; never touch the
    // business payload or control side-channel.
    let message = message.trim_start_matches(|ch: char| ch == '\u{1b}' || ch == '[' || ch.is_ascii_digit() || ch == ';' || ch == 'm');
    if message.starts_with("▶ [req]") {
        let headline = diagnostic::format_request(
            endpoint,
            &request.request_id,
            model,
            &format!("{provider}/{model}"),
        );
        let debug = format!(
            "event=started stream={} chain=req_inbound>req_chatprocess>req_outbound>provider elapsedMs={} transport={}",
            stream,
            elapsed.as_millis(),
            if stream { "sse" } else { "json" }
        );
        Some(format_console_layered(headline, debug))
    } else if message.starts_with("✅ [resp]") {
        // Streaming response nodes emit empty observations before the terminal
        // client frame.  They carry no user-visible information and must not
        // become one console line per chunk; the terminal report below remains
        // the single response summary.
        if message.contains("output_items=0") {
            return None;
        }
        let headline = diagnostic::format_response(
            endpoint,
            &request.request_id,
            status.unwrap_or(200),
            model,
        );
        let details = message
            .split_once("output_items=")
            .map(|(_, rest)| format!("output_items={rest}"))
            .unwrap_or_else(|| "response".to_string());
        let debug = format!(
            "event=completed responseStatus=completed finish_reason=stop provider={} model={} chain=provider>resp_inbound>resp_chatprocess>resp_outbound {} elapsedMs={} transport={}",
            provider,
            model,
            details,
            elapsed.as_millis(),
            if stream { "sse" } else { "json" }
        );
        Some(format_console_layered(headline, debug))
    } else {
        None
    }
}

fn format_console_layered(headline: String, debug: String) -> String {
    let color_disabled = std::env::var_os("NO_COLOR").is_some()
        || matches!(std::env::var("FORCE_COLOR").ok().as_deref(), Some("0"));
    if color_disabled {
        format!("{headline}\n\n  {debug}")
    } else {
        format!("{headline}\n\n\x1b[2;90m  {debug}\x1b[0m")
    }
}

fn project_fault(request: &HttpRequest, fault: RuntimeFault, status: u16) -> HttpResponse {
    let scope = Scope::new(&request.request_id, "v4-pipeline", request.port, "", "");
    let mut chain = ErrorChain::new(scope);
    match project_runtime_fault(&mut chain, fault.clone()) {
        Ok(projection) => HttpResponse::error(status, projection.message),
        Err(error) => HttpResponse::error(
            500,
            format!(
                "error chain projection failed for {}: {error:?}",
                fault.code
            ),
        ),
    }
}

fn project_provider_fault(
    request: &HttpRequest,
    fault: RuntimeFault,
    status: u16,
    product: Option<&routecodex_v4_config::RuntimeProductConfig>,
    provider_id: &str,
    response_body: &str,
) -> HttpResponse {
    let Some(product) = product else {
        return project_fault(request, fault, status);
    };
    let Some(policy) = apply_product_error_policy(product, provider_id, status, response_body)
    else {
        return project_fault(request, fault, status);
    };
    let action = if policy.retry {
        DecisionAction::Reroute
    } else if policy.cooldown {
        DecisionAction::Cooldown
    } else {
        DecisionAction::Terminal
    };
    let scope = Scope::new(&request.request_id, "v4-pipeline", request.port, "", "");
    let mut chain = ErrorChain::new(scope);
    let projection = project_runtime_fault_with_policy(
        &mut chain,
        fault.clone(),
        RetryPolicy {
            policy_id: policy.policy_id.clone(),
            provider_scope: provider_id.to_string(),
            matcher: format!("http_status={status}"),
            action_class: if policy.retry { "retry" } else { "terminal" }.to_string(),
            reason_code: policy
                .reason_code
                .clone()
                .unwrap_or_else(|| fault.code.clone()),
        },
        ExecutionDecision {
            decision_id: format!("decision.{}", policy.policy_id),
            action,
            reason_code: policy
                .reason_code
                .clone()
                .unwrap_or_else(|| fault.code.clone()),
        },
    );
    match projection {
        Ok(value) => HttpResponse::error(policy.project_status.unwrap_or(status), value.message),
        Err(error) => HttpResponse::error(
            500,
            format!("provider error policy projection failed: {error:?}"),
        ),
    }
}

fn record_provider_failure(
    availability: &Arc<Mutex<V4Availability01SessionScoped>>,
    request: &HttpRequest,
    route_group: Option<&str>,
    session_scope: &str,
    provider_id: &str,
    cooldown_policy: bool,
    failure_threshold: u64,
) -> Result<(), HttpResponse> {
    let Some(route_group) = route_group else {
        return Ok(());
    };
    let mut guard = availability.lock().map_err(|_| {
        project_fault(
            request,
            RuntimeFault::new("availability_lock", "provider availability lock poisoned"),
            500,
        )
    })?;
    let previous = guard
        .get(
            &request.port.to_string(),
            route_group,
            session_scope,
            provider_id,
        )
        .map(|record| record.consecutive_errors)
        .unwrap_or(0);
    let consecutive_errors = previous.saturating_add(1);
    let cooldown = cooldown_policy && consecutive_errors >= failure_threshold;
    guard
        .mark_failure(
            &request.port.to_string(),
            route_group,
            session_scope,
            provider_id,
            cooldown,
            consecutive_errors,
        )
        .map_err(|error| {
            project_fault(
                request,
                RuntimeFault::new("availability_record", error.to_string()),
                500,
            )
        })
}

fn json_response(status: u16, value: serde_json::Value) -> HttpResponse {
    let body = serde_json::to_vec(&value).expect("JSON response value is serializable");
    HttpResponse::json(status, body)
}

#[cfg(test)]
mod tests {
    use super::*;
    use routecodex_v4_config::compile_runtime_config;
    use std::collections::VecDeque;

    fn diagnostic_request() -> HttpRequest {
        HttpRequest {
            method: "POST".to_string(),
            path: "/v1/responses".to_string(),
            headers: Vec::new(),
            body: Vec::new(),
            request_id: "test-server-day-00000001".to_string(),
            server_id: "rccv4".to_string(),
            port: 5500,
        }
    }

    #[test]
    fn console_projection_aggregates_scope_and_suppresses_empty_stream_frames() {
        let request = diagnostic_request();
        let empty = "v4.std.diagnostic.response_payload_console_render:console.payload_ready:✅ [resp] model=- output_items=0";
        assert!(render_payload_console_event(
            empty,
            &request,
            "responses",
            "cc-sol",
            "gpt-5.5",
            true,
            Some(200),
            std::time::Duration::from_millis(4),
        )
        .is_none());
        let empty_with_usage =
            "v4.std.diagnostic.response_payload_console_render:console.payload_ready:✅ [resp] model=- output_items=0 usage=12+0=12";
        assert!(render_payload_console_event(
            empty_with_usage,
            &request,
            "responses",
            "cc-sol",
            "gpt-5.5",
            true,
            Some(200),
            std::time::Duration::from_millis(5),
        )
        .is_none());
        let request_event = "v4.std.diagnostic.request_payload_console_render:console.payload_ready:▶ [req] model=gpt-5.5 stream=true messages=1 tools=0";
        let rendered = render_payload_console_event(
            request_event,
            &request,
            "responses",
            "cc-sol",
            "gpt-5.5",
            true,
            None,
            std::time::Duration::from_millis(7),
        )
        .expect("request summary is rendered");
        assert!(rendered.contains("req=test-server-day-00000001"));
        assert!(rendered.contains("target=cc-sol/gpt-5.5"));
        assert!(rendered.contains("elapsedMs=7"));

        let tty_request_event = "v4.std.diagnostic.request_payload_console_render:console.payload_ready:\u{1b}[36m▶ [req] model=gpt-5.5 stream=true messages=1 tools=0\u{1b}[0m";
        assert!(render_payload_console_event(
            tty_request_event,
            &request,
            "responses",
            "cc-sol",
            "gpt-5.5",
            true,
            None,
            std::time::Duration::from_millis(8),
        )
        .is_some());
        let direct_request_event = "v4.hook.direct.request:console.payload_ready:▶ [req] model=gpt-5.5 stream=false messages=1 tools=0";
        assert!(render_payload_console_event(
            direct_request_event,
            &request,
            "responses",
            "cc-sol",
            "gpt-5.5",
            false,
            None,
            std::time::Duration::from_millis(9),
        )
        .is_some());
        let direct_response_event =
            "v4.std.diagnostic.direct_response_payload_console_render:console.payload_ready:✅ [resp] model=gpt-5.5 output_items=1 usage=4+2=6";
        let rendered = render_payload_console_event(
            direct_response_event,
            &request,
            "/v1/responses",
            "cc-sol",
            "gpt-5.5",
            false,
            Some(200),
            std::time::Duration::from_millis(10),
        )
        .expect("direct Responses response summary is rendered");
        assert!(rendered.contains("[/v1/responses]"));
        assert!(rendered.contains("responseStatus=completed"));
    }

    #[test]
    fn production_trace_publishes_scoped_diagnostic_events() {
        let bus = Arc::new(Mutex::new(V4Debug02BusSubscription::new()));
        let request = HttpRequest {
            method: "POST".to_string(),
            path: "/v1/responses".to_string(),
            headers: Vec::new(),
            body: Vec::new(),
            request_id: "req-event-bus".to_string(),
            server_id: "rccv4".to_string(),
            port: 5500,
        };
        publish_diagnostic_events(
            &bus,
            &request,
            &["node-a:plugin.executed:typed handle executed".to_string()],
        );
        let guard = bus.lock().expect("event bus lock");
        assert_eq!(guard.published_facts().len(), 1);
        let view = guard
            .subscriber_view("console:req-event-bus")
            .expect("console subscriber view");
        assert_eq!(view.events().len(), 1);
        assert_eq!(view.scope_key(), "req-event-bus");
    }

    fn test_manifest() -> RuntimeConfigManifest {
        compile_runtime_config(
            r#"
version = 4

[runtime]
id = "rccv4"

[[listeners]]
id = "primary"
address = "127.0.0.1:0"

[[providers]]
provider_id = "mock"
config_path = "provider.toml"
protocol = "responses"
wire_model = "mock-model"
priority = 1
entry_models = ["mock-model"]

[[routes]]
id = "default"
models = ["mock-model"]
targets = ["mock"]
"#,
            None,
        )
        .expect("test runtime manifest compiles")
    }

    #[test]
    fn production_pipeline_uses_the_single_runtime_execution_owner() {
        let mut handler = PipelineHandler::new(test_manifest()).expect("handler initializes");
        assert!(
            handler
                .runtime
                .lock()
                .expect("runtime lock")
                .plan()
                .chains
                .len()
                >= 2
        );
        let response = handler.handle(HttpRequest {
            method: "POST".to_string(),
            path: "/unknown".to_string(),
            headers: Vec::new(),
            body: br#"{"model":"mock-model","input":"hello"}"#.to_vec(),
            request_id: "request-engine-test".to_string(),
            server_id: "test".to_string(),
            port: u16::from_ne_bytes([0, 1]),
        });
        assert_eq!(
            response.status, 404,
            "request node must run before route projection"
        );
    }

    #[test]
    fn production_epoch_pins_the_complete_plugin_plan_set() {
        let handler = PipelineHandler::new(test_manifest()).expect("handler initializes");
        let plugin_ids = handler
            .runtime
            .lock()
            .expect("runtime lock")
            .epoch_plugin_ids();
        assert!(plugin_ids.len() > 2, "production must not admit only inbound plugins");
        for required in [
            "v4.std.request.responses_normalize",
            "v4.std.request.responses_wire_build",
            "v4.std.response.sse_frame_boundary",
            "v4.std.response.frame_build",
        ] {
            assert!(
                plugin_ids.iter().any(|plugin_id| plugin_id == required),
                "compiled production epoch is missing {required}"
            );
        }
    }

    struct MockSseSource {
        chunks: VecDeque<Result<Vec<u8>, String>>,
        wait_result: Result<(), String>,
    }

    impl ProviderSseSource for MockSseSource {
        fn read_chunk(&mut self, chunk: &mut [u8]) -> Result<usize, String> {
            match self.chunks.pop_front() {
                Some(Ok(bytes)) => {
                    let count = bytes.len();
                    chunk[..count].copy_from_slice(&bytes);
                    Ok(count)
                }
                Some(Err(error)) => Err(error),
                None => Ok(0),
            }
        }

        fn wait(&mut self) -> Result<(), String> {
            self.wait_result.clone()
        }
    }

    fn runtime() -> Arc<Mutex<SkeletonRuntime>> {
        PipelineHandler::new(test_manifest())
            .expect("compiled response plan must load")
            .runtime
    }

    fn stream(chunks: Vec<Result<Vec<u8>, String>>) -> CordisSseTransportStream<MockSseSource> {
        stream_for(chunks, "responses", "direct")
    }

    fn stream_for(
        chunks: Vec<Result<Vec<u8>, String>>,
        entry_protocol: &str,
        continuation_owner: &str,
    ) -> CordisSseTransportStream<MockSseSource> {
        stream_for_with_runtime(runtime(), chunks, entry_protocol, continuation_owner)
    }

    fn stream_for_with_runtime(
        runtime: Arc<Mutex<SkeletonRuntime>>,
        chunks: Vec<Result<Vec<u8>, String>>,
        entry_protocol: &str,
        continuation_owner: &str,
    ) -> CordisSseTransportStream<MockSseSource> {
        let port = u16::from_ne_bytes([0, 1]);
        let (request_lease, request_scope) = {
            let runtime = runtime.lock().expect("test runtime lock");
            let request_lease = runtime
                .admit_request("request-1")
                .expect("test stream admission");
            let body = if entry_protocol == "chat" {
                r#"{"model":"m","messages":[{"role":"user","content":"hello"}]}"#
            } else {
                r#"{"model":"m","input":[]}"#
            };
            let report = runtime
                .execute_request_json_scoped_for_target_with_lease(
                    body,
                    entry_protocol,
                    "responses",
                    "m",
                    true,
                    "request-1",
                    port,
                    "session-1",
                    "conversation-1",
                    Some(continuation_owner),
                    Some(&request_lease),
                )
                .expect("test request establishes stream scope");
            (request_lease, report.scope)
        };
        let processor = ResponseStreamProcessor::new(
            request_lease,
            request_scope,
            port,
            entry_protocol,
            "responses",
            continuation_owner,
            "session-1",
            "conversation-1",
        )
        .expect("test stream processor");
        CordisSseTransportStream::new(
            MockSseSource {
                chunks: chunks.into(),
                wait_result: Ok(()),
            },
            runtime,
            processor,
            HttpRequest {
                method: "POST".to_string(),
                path: "/v1/responses".to_string(),
                headers: Vec::new(),
                body: Vec::new(),
                request_id: "request-1".to_string(),
                server_id: "127.0.0.1:5500-day-test".to_string(),
                port,
            },
            "test-provider".to_string(),
            "m".to_string(),
            Arc::new(Mutex::new(V4Debug02BusSubscription::new())),
        )
    }

    #[test]
    fn terminal_frame_runs_response_chain_and_is_rebuilt() {
        let frame = b"event: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"id\":\"abc\"}}\n\n";
        let mut stream = stream(vec![Ok(frame.to_vec())]);
        let mut chunk = Vec::new();
        assert!(stream.next_chunk(&mut chunk).expect("frame must project"));
        assert_ne!(chunk, frame, "client frame must be rebuilt, not piped");
        assert!(String::from_utf8_lossy(&chunk).contains("event: response.completed"));
        let projected: serde_json::Value = serde_json::from_str(
            chunk
                .split(|byte| *byte == b'\n')
                .find_map(|line| line.strip_prefix(b"data: "))
                .and_then(|line| std::str::from_utf8(line).ok())
                .expect("projected data line must exist"),
        )
        .expect("projected data must be JSON");
        assert_eq!(
            projected,
            serde_json::json!({
                "type": "response.completed", "response": {"id": "abc"}
            })
        );
        chunk.clear();
        assert!(!stream.next_chunk(&mut chunk).expect("stream must close"));
    }

    #[test]
    fn premature_eof_emits_explicit_error_event_before_close() {
        let mut stream = stream(Vec::new());
        let mut chunk = Vec::new();
        assert!(stream
            .next_chunk(&mut chunk)
            .expect("error event must emit"));
        let text = String::from_utf8(chunk).expect("error event must be UTF-8");
        assert!(text.starts_with("event: error\ndata: "));
        assert!(text.contains("ended before response.completed or response.failed"));
        let mut closed = Vec::new();
        assert!(!stream.next_chunk(&mut closed).expect("stream must close"));
    }

    #[test]
    fn truncated_tail_after_terminal_emits_explicit_error_event() {
        let terminal = b"event: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"id\":\"abc\"}}\n\n";
        let mut bytes = terminal.to_vec();
        bytes.extend_from_slice(b"event: response.output_text.delta\ndata: {\"type\":");
        let mut stream = stream(vec![Ok(bytes)]);
        let mut terminal_chunk = Vec::new();
        assert!(stream
            .next_chunk(&mut terminal_chunk)
            .expect("terminal frame must project"));
        assert!(String::from_utf8(terminal_chunk)
            .expect("terminal frame must be UTF-8")
            .contains("event: response.completed"));
        let mut error_chunk = Vec::new();
        assert!(stream
            .next_chunk(&mut error_chunk)
            .expect("truncated tail error must emit"));
        let text = String::from_utf8(error_chunk).expect("error event must be UTF-8");
        assert!(text.starts_with("event: error\ndata: "));
        assert!(text.contains("incomplete provider SSE frame"));
    }

    #[test]
    fn crlf_terminal_frame_is_accepted_and_rebuilt() {
        let frame = b"event: response.completed\r\ndata: {\"type\":\"response.completed\",\"response\":{\"id\":\"abc\"}}\r\n\r\n";
        let mut stream = stream(vec![Ok(frame.to_vec())]);
        let mut chunk = Vec::new();
        assert!(stream
            .next_chunk(&mut chunk)
            .expect("CRLF frame must project"));
        let text = String::from_utf8(chunk).expect("projected frame must be UTF-8");
        assert!(text.contains("event: response.completed"));
        assert!(!text.contains("event: error"));
    }

    #[test]
    fn malformed_frame_emits_explicit_error_event() {
        let mut stream = stream(vec![Ok(
            b"event: response.output_text.delta\ndata: {bad}\n\n".to_vec(),
        )]);
        let mut chunk = Vec::new();
        assert!(stream
            .next_chunk(&mut chunk)
            .expect("error event must emit"));
        let text = String::from_utf8(chunk).expect("error event must be UTF-8");
        assert!(text.starts_with("event: error\ndata: "));
        assert!(text.contains("invalid JSON"));
    }

    #[test]
    fn provider_failed_event_projects_error_once_without_success_terminal() {
        let frame = b"event: response.failed\ndata: {\"type\":\"response.failed\",\"response\":{\"error\":{\"message\":\"upstream failed\"}}}\n\n";
        let mut stream = stream(vec![Ok(frame.to_vec())]);
        let mut chunk = Vec::new();
        assert!(stream
            .next_chunk(&mut chunk)
            .expect("failure event must emit"));
        let text = String::from_utf8(chunk).expect("failure event must be UTF-8");
        assert!(text.starts_with("event: error\ndata: "));
        assert!(text.contains("upstream failed"));
        assert!(!text.contains("response.completed"));
        let mut closed = Vec::new();
        assert!(!stream
            .next_chunk(&mut closed)
            .expect("failed stream must close"));
        assert!(closed.is_empty());
    }

    #[test]
    fn provider_read_failure_emits_explicit_error_event() {
        let mut stream = stream(vec![Err("read exploded".to_string())]);
        let mut chunk = Vec::new();
        assert!(stream
            .next_chunk(&mut chunk)
            .expect("error event must emit"));
        let text = String::from_utf8(chunk).expect("error event must be UTF-8");
        assert!(text.starts_with("event: error\ndata: "));
        assert!(text.contains("provider SSE read failed: read exploded"));
    }

    #[test]
    fn chat_request_projects_to_responses_input_without_control_reconstruction() {
        let body = serde_json::json!({
            "model": "m",
            "messages": [{"role": "user", "content": "hello"}],
            "debug": {"business": true},
            "tools": [{"type": "function", "function": {
                "name": "lookup", "description": "lookup", "parameters": {"type": "object"}
            }}]
        });
        let projected =
            routecodex_v4_standard_plugins::request_plugins::project_chat_request_to_responses(
                &body,
            )
            .expect("chat request must project to Responses input");
        assert_eq!(projected["input"], body["messages"]);
        assert_eq!(projected["tools"][0]["name"], "lookup");
        assert_eq!(projected["debug"], body["debug"]);
    }

    #[test]
    fn chat_terminal_frame_projects_chunk_and_done_without_continuation() {
        let frame = b"event: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_1\",\"model\":\"m\"}}\n\n";
        let mut stream = stream_for(vec![Ok(frame.to_vec())], "chat", "relay");
        let mut chunk = Vec::new();
        assert!(stream
            .next_chunk(&mut chunk)
            .expect("relay frame must project"));
        let text = String::from_utf8(chunk).expect("relay frame must be UTF-8");
        assert!(!text.contains("event: response.completed"));
        assert!(
            text.contains("\"object\":\"chat.completion.chunk\""),
            "unexpected chat projection: {text}"
        );
        assert!(text.ends_with("data: [DONE]\n\n"));
    }
}
