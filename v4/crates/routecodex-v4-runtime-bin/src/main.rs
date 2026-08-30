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
use routecodex_v4_error::ErrorChain;
use routecodex_v4_error::{DecisionAction, ExecutionDecision, RetryPolicy};
use routecodex_v4_lifecycle::{
    exec_managed_restart, release_for_foreground, repair_stale, request_restart, request_stop,
    start_managed, status_managed, ManagedAction, ManagedControlPlane, ManagedInstanceRecord,
    ManagedSpawnOptions, V4LifecyclePaths,
};
use routecodex_v4_node_container::direct_relay::{
    DirectRelayContainer, DirectRelayError, DirectRelayInformation, DirectRequestHook,
    DirectResponseHook, ProtocolId, SharedPayload,
};
use routecodex_v4_node_container::ExecutionEpochSnapshot;
use routecodex_v4_provider::{
    build_retry_wire,
    send_anthropic_messages, send_anthropic_messages_streaming, send_openai_chat,
    send_openai_chat_streaming, send_responses, send_responses_streaming, validate_auth_alias,
    write_provider_profile, ProviderInitAuth, ProviderInitOptions, ProviderResponseStream,
    V4Availability01SessionScoped,
};
use routecodex_v4_router::{
    apply_product_error_policy, select_product_target_excluding, select_target,
};
use routecodex_v4_runtime::{
    parse_responses_provider_payload, project_runtime_fault, project_runtime_fault_with_policy,
    ResponsesProviderPayload, RuntimeFault, RuntimeLease, SkeletonRuntime,
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
    let (_, manifest, paths) = compile_for_lifecycle(intent.config)?;
    let record = request_restart(
        &paths,
        &manifest.manifest_digest,
        Duration::from_millis(intent.timeout_ms),
    )
    .map_err(|error| error.to_string())?;
    Ok(format_status("restarted", &record))
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
                runtime.block_on(async move {
                    let server = AsyncHttpServer::bind(&server)
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
                })
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

struct PipelineHandler {
    manifest: RuntimeConfigManifest,
    runtime: Arc<Mutex<SkeletonRuntime>>,
    execution_epoch: ExecutionEpochSnapshot,
    availability: Arc<Mutex<V4Availability01SessionScoped>>,
    direct_relay: Arc<DirectRelayContainer>,
}

struct DirectRequestPassthrough;

impl DirectRequestHook for DirectRequestPassthrough {
    fn apply(&self, payload: SharedPayload) -> Result<SharedPayload, DirectRelayError> {
        if !payload.is_object() {
            return Err(DirectRelayError::RequestHook(
                "direct request payload must be an object".to_string(),
            ));
        }
        Ok(payload)
    }
}

struct DirectResponsePassthrough;

impl DirectResponseHook for DirectResponsePassthrough {
    fn apply(&self, payload: SharedPayload) -> Result<SharedPayload, DirectRelayError> {
        if !payload.is_object() {
            return Err(DirectRelayError::ResponseHook(
                "direct response payload must be an object".to_string(),
            ));
        }
        Ok(payload)
    }
}

impl PipelineHandler {
    fn new(manifest: RuntimeConfigManifest) -> Result<Self, String> {
        let runtime = SkeletonRuntime::from_compiled_plan(
            manifest.execution_epoch.skeleton.clone(),
        )
        .map_err(|error| error.to_string())?;
        let transaction_id = format!(
            "runtime-config:{}",
            &manifest.manifest_digest[7..23]
        );
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
            direct_relay: Arc::new(DirectRelayContainer::new(
                vec![Arc::new(DirectRequestPassthrough)],
                vec![Arc::new(DirectResponsePassthrough)],
            )),
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
                &self.direct_relay,
                &request,
                "responses",
                "direct",
            )
            .unwrap_or_else(|response| response),
            ("POST", "/v1/chat/completions") => handle_responses(
                &self.manifest,
                &self.runtime,
                &self.availability,
                &self.direct_relay,
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
        Box::pin(async move { self.handle_request(request) })
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
    direct_relay: &Arc<DirectRelayContainer>,
    request: &HttpRequest,
    entry_protocol: &str,
    continuation_owner: &str,
) -> Result<HttpResponse, HttpResponse> {
    let body: serde_json::Value = serde_json::from_slice(&request.body).map_err(|error| {
        project_fault(
            request,
            RuntimeFault::new("invalid_request", format!("invalid JSON: {error}")),
            400,
        )
    })?;
    let direct_information = if entry_protocol == "responses" {
        Some(
            DirectRelayInformation::direct(
                ProtocolId::new("openai-responses").map_err(|error| {
                    project_fault(request, RuntimeFault::new("direct_relay_protocol", format!("{error:?}")), 598)
                })?,
                ProtocolId::new("openai-responses").map_err(|error| {
                    project_fault(request, RuntimeFault::new("direct_relay_protocol", format!("{error:?}")), 598)
                })?,
            )
            .map_err(|error| {
                project_fault(request, RuntimeFault::new("direct_relay_protocol", format!("{error:?}")), 598)
            })?,
        )
    } else {
        None
    };
    let body = if let Some(information) = direct_information.as_ref() {
        let shared = Arc::new(body);
        direct_relay
            .execute_request(information, shared)
            .map_err(|error| project_fault(request, RuntimeFault::new("direct_relay_request", format!("{error:?}")), 598))
            .map(|value| (*value).clone())?
    } else {
        body
    };
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
    println!(
        "{}",
        diagnostic::format_request(
            request.path.as_str(),
            &request.request_id,
            model,
            &target.provider_id,
        )
    );
    let _ = std::io::stdout().flush();
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
    let wire_body = build_retry_wire(
        &target.protocol,
        &semantic_body,
        &target.wire_model,
        stream_mode,
    )
    .map_err(|error| {
        project_fault(
            request,
            RuntimeFault::new(&error.code, error.message),
            error.status.unwrap_or(598),
        )
    })?;
    if stream_mode {
        let mut stream = send_target_streaming(&target, &wire_body).map_err(|error| {
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
                            let retry_body = build_retry_wire(
                                &candidate.protocol,
                                &wire_body,
                                &candidate.wire_model,
                                true,
                            )
                            .map_err(|error| {
                                project_fault(
                                    request,
                                    RuntimeFault::new(&error.code, error.message),
                                    error.status.unwrap_or(400),
                                )
                            })?;
                            target = candidate;
                            stream =
                                send_target_streaming(&target, &retry_body).map_err(|error| {
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
        println!(
            "{}",
            diagnostic::format_response(
                request.path.as_str(),
                &request.request_id,
                client_status,
                model,
            )
        );
        let _ = std::io::stdout().flush();
        let response_stream = ResponsesSseStream::new(
            stream,
            Arc::clone(runtime),
            request_lease,
            request.request_id.clone(),
            request.port,
            entry_protocol.to_string(),
            continuation_owner.to_string(),
            target.protocol.clone(),
            session_scope.to_string(),
            conversation_scope.to_string(),
            Arc::clone(direct_relay),
        );
        return Ok(HttpResponse::streaming(
            client_status,
            "text/event-stream",
            Box::new(response_stream),
        ));
    }
    let mut raw = send_target_nonstream(&target, &wire_body).map_err(|error| {
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
                    let retry_body = build_retry_wire(
                        &candidate.protocol,
                        &wire_body,
                        &candidate.wire_model,
                        false,
                    )
                    .map_err(|error| {
                        project_fault(
                            request,
                            RuntimeFault::new(&error.code, error.message),
                            error.status.unwrap_or(400),
                        )
                    })?;
                    target = candidate;
                    reselected = true;
                    raw = send_target_nonstream(&target, &retry_body).map_err(|error| {
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
    match parse_responses_provider_payload(raw.status, &raw.content_type, &raw.body, false)
    .map_err(|fault| {
        project_provider_fault(
            request,
            fault,
            if raw.status == 0 { 502 } else { raw.status },
            manifest.product.as_ref(),
            &target.provider_id,
            String::from_utf8_lossy(&raw.body).as_ref(),
        )
    })? {
        ResponsesProviderPayload::Json(value) => {
            let provider_raw = serde_json::to_string(&value).map_err(|error| {
                project_fault(
                    request,
                    RuntimeFault::new("provider_json_encode", error.to_string()),
                    500,
                )
            })?;
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
            let projected = if let Some(information) = direct_information.as_ref() {
                direct_relay
                    .execute_response(information, Arc::new(projected))
                    .map_err(|error| {
                        project_fault(
                            request,
                            RuntimeFault::new("direct_relay_response", format!("{error:?}")),
                            599,
                        )
                    })
                    .map(|value| (*value).clone())?
            } else {
                projected
            };
            let client_status = if (200..300).contains(&raw.status) {
                200
            } else {
                raw.status
            };
            println!(
                "{}",
                diagnostic::format_response(
                    request.path.as_str(),
                    &request.request_id,
                    client_status,
                    model,
                )
            );
            let _ = std::io::stdout().flush();
            Ok(json_response(client_status, projected))
        }
        ResponsesProviderPayload::Sse(_) => Err(project_fault(
            request,
            RuntimeFault::new(
                "provider_sse_unexpected",
                "non-stream Responses transport returned SSE payload",
            ),
            502,
        )),
    }
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

struct ResponsesSseStream<S = ProviderResponseStream> {
    stream: S,
    runtime: Arc<Mutex<SkeletonRuntime>>,
    request_lease: RuntimeLease,
    request_id: String,
    port: u16,
    entry_protocol: String,
    continuation_owner: String,
    provider_protocol: String,
    session_scope: String,
    conversation_scope: String,
    direct_relay: Arc<DirectRelayContainer>,
    frame_sequence: u64,
    pending: Vec<u8>,
    ingress: SseIngressPlugin,
    egress: SseEgressPlugin,
    terminal_seen: bool,
    close_after_pending: bool,
    chat_role_emitted: bool,
}

impl<S: ProviderSseSource> ResponsesSseStream<S> {
    fn new(
        stream: S,
        runtime: Arc<Mutex<SkeletonRuntime>>,
        request_lease: RuntimeLease,
        request_id: String,
        port: u16,
        entry_protocol: String,
        continuation_owner: String,
        provider_protocol: String,
        session_scope: String,
        conversation_scope: String,
        direct_relay: Arc<DirectRelayContainer>,
    ) -> Self {
        Self {
            stream,
            runtime,
            request_lease,
            request_id,
            port,
            entry_protocol,
            continuation_owner,
            provider_protocol,
            session_scope,
            conversation_scope,
            direct_relay,
            frame_sequence: 0,
            pending: Vec::new(),
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
            terminal_seen: false,
            close_after_pending: false,
            chat_role_emitted: false,
        }
    }

    fn queue_error(&mut self, message: impl Into<String>) {
        let encoded = routecodex_v4_standard_plugins::response_outbound::encode_client_error_sse_frame(
            &self.entry_protocol,
            &message.into(),
        )
        .expect("client SSE error projection must be serializable");
        let frame = routecodex_v4_standard_plugins::sse_transport::SseTransportFrame::from_complete_bytes(encoded)
            .expect("client SSE error projection must produce a complete frame");
        self.egress
            .enqueue(frame, std::time::Instant::now())
            .expect("client SSE error frame must fit transport queue");
        self.close_after_pending = true;
    }

    fn project_frame(&mut self, frame: &[u8], terminal: bool) -> Result<(), RuntimeFault> {
        self.frame_sequence += 1;
        if self.entry_protocol == "chat"
            && std::str::from_utf8(frame)
                .ok()
                .and_then(|value| value.lines().find_map(|line| line.strip_prefix("event:")))
                .map(str::trim)
                == Some("response.in_progress")
            && self.chat_role_emitted
        {
            return Ok(());
        }
        if self.provider_protocol != "responses" {
            return Err(RuntimeFault::new(
                "provider_sse_protocol_unsupported",
                format!("unsupported provider SSE protocol {}", self.provider_protocol),
            ));
        }
        let decoded = routecodex_v4_standard_plugins::response_inbound::decode_provider_sse_frame(
            frame,
        )
        .map_err(|error| RuntimeFault::new("provider_sse_decode", error))?;
        if decoded.terminal != terminal {
            return Err(RuntimeFault::new(
                "provider_sse_terminal_drift",
                "provider SSE terminal classification drift",
            ));
        }
        let provider_semantic = serde_json::to_string(&decoded.semantic)
            .map_err(|error| RuntimeFault::new("provider_sse_encode", error.to_string()))?;
        let report = self
            .runtime
            .lock()
            .map_err(|_| {
                RuntimeFault::new("response_runtime_lock", "response runtime lock poisoned")
            })?
            .execute_provider_response_scoped_for_target_with_lease(
                &provider_semantic,
                &self.request_id,
                self.port,
                &self.session_scope,
                &self.conversation_scope,
                &self.entry_protocol,
                &self.provider_protocol,
                &self.continuation_owner,
                Some(&self.request_lease),
            )?;
        let client_frame = report.client_frame.ok_or_else(|| {
            RuntimeFault::new(
                "response_frame_missing",
                "response chain produced no client frame",
            )
        })?;
        let client_semantic: serde_json::Value = serde_json::from_str(&client_frame)
            .map_err(|error| RuntimeFault::new("client_sse_semantic", error.to_string()))?;
        let client_semantic = if self.entry_protocol == "responses" {
            let information = DirectRelayInformation::direct(
                ProtocolId::new("openai-responses")
                    .map_err(|error| RuntimeFault::new("direct_relay_protocol", format!("{error:?}")))?,
                ProtocolId::new("openai-responses")
                    .map_err(|error| RuntimeFault::new("direct_relay_protocol", format!("{error:?}")))?,
            )
            .map_err(|error| RuntimeFault::new("direct_relay_protocol", format!("{error:?}")))?;
            self.direct_relay
                .execute_response(&information, Arc::new(client_semantic))
                .map_err(|error| RuntimeFault::new("direct_relay_response", format!("{error:?}")))
                .map(|value| (*value).clone())?
        } else {
            client_semantic
        };
        let encoded = routecodex_v4_standard_plugins::response_outbound::encode_client_sse_frame(
            &self.entry_protocol,
            &client_semantic,
            terminal,
        )
        .map_err(|error| RuntimeFault::new("client_sse_encode", error))?;
        let frame = routecodex_v4_standard_plugins::sse_transport::SseTransportFrame::from_complete_bytes(encoded)
            .map_err(|error| RuntimeFault::new("client_sse_transport", format!("{error:?}")))?;
        self.egress
            .enqueue(frame, std::time::Instant::now())
            .map_err(|error| RuntimeFault::new("client_sse_backpressure", format!("{error:?}")))?;
        Ok(())
    }
}

impl<S: ProviderSseSource> ResponseStream for ResponsesSseStream<S> {
    fn next_chunk(&mut self, chunk: &mut Vec<u8>) -> Result<bool, std::io::Error> {
        loop {
            if let Some(frame) = self.egress.pop() {
                chunk.extend_from_slice(frame.as_bytes());
                return Ok(true);
            }
            if !self.pending.is_empty() {
                chunk.extend_from_slice(&self.pending);
                self.pending.clear();
                return Ok(true);
            }
            if self.close_after_pending {
                return Ok(false);
            }
            let mut bytes = [0u8; 8192];
            let count = match self.stream.read_chunk(&mut bytes) {
                Ok(count) => count,
                Err(error) => {
                    self.queue_error(format!("provider SSE read failed: {error}"));
                    continue;
                }
            };
            if count == 0 {
                if let Err(error) = self.ingress.finish() {
                    let message = match error {
                        routecodex_v4_standard_plugins::sse_transport::SseTransportError::IncompleteFrame =>
                            "incomplete provider SSE frame at end of stream".to_string(),
                        other => format!("provider SSE framing failed: {other:?}"),
                    };
                    self.queue_error(message);
                    continue;
                }
                if !self.terminal_seen {
                    self.queue_error(
                        "provider SSE ended before response.completed or response.failed",
                    );
                    continue;
                }
                if let Err(error) = self.stream.wait() {
                    self.queue_error(format!("provider SSE closeout failed: {error}"));
                    continue;
                }
                return Ok(false);
            }
            let frames = match self.ingress.push_chunk(&bytes[..count], std::time::Instant::now()) {
                Ok(frames) => frames,
                Err(error) => {
                    self.queue_error(format!("provider SSE framing failed: {error:?}"));
                    continue;
                }
            };
            for frame in frames {
                let frame_bytes = frame.as_bytes();
                let terminal = match routecodex_v4_runtime::validate_responses_sse_frame(frame_bytes) {
                    Ok(terminal) => terminal,
                    Err(fault) => {
                        self.queue_error(fault.to_string());
                        break;
                    }
                };
                self.terminal_seen |= terminal;
                if let Err(fault) = self.project_frame(frame_bytes, terminal) {
                    self.queue_error(fault.to_string());
                    break;
                }
            }
        }
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

fn send_target_nonstream(
    target: &routecodex_v4_router::SelectedTarget,
    wire_body: &serde_json::Value,
) -> Result<
    routecodex_v4_provider::ProviderRawResponse,
    routecodex_v4_provider::ProviderTransportError,
> {
    validate_auth_alias(&target.config_path, target.auth_alias.as_deref())?;
    match target.protocol.as_str() {
        "responses" => send_responses(&target.config_path, &target.wire_model, wire_body, false),
        "openai" | "chat" => send_openai_chat(&target.config_path, wire_body),
        "anthropic" => send_anthropic_messages(&target.config_path, wire_body),
        other => Err(routecodex_v4_provider::ProviderTransportError {
            code: "provider_protocol_unsupported".to_string(),
            message: format!("provider protocol {other} has no transport owner"),
            status: None,
        }),
    }
}

fn send_target_streaming(
    target: &routecodex_v4_router::SelectedTarget,
    wire_body: &serde_json::Value,
) -> Result<ProviderResponseStream, routecodex_v4_provider::ProviderTransportError> {
    validate_auth_alias(&target.config_path, target.auth_alias.as_deref())?;
    match target.protocol.as_str() {
        "responses" => send_responses_streaming(&target.config_path, &target.wire_model, wire_body),
        "openai" | "chat" => send_openai_chat_streaming(&target.config_path, wire_body),
        "anthropic" => send_anthropic_messages_streaming(&target.config_path, wire_body),
        other => Err(routecodex_v4_provider::ProviderTransportError {
            code: "provider_protocol_unsupported".to_string(),
            message: format!("provider protocol {other} has no streaming transport owner"),
            status: None,
        }),
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
    fn direct_responses_admission_owns_relay_container_and_shared_payload() {
        let information = DirectRelayInformation::direct(
            ProtocolId::new("openai-responses").expect("client protocol"),
            ProtocolId::new("openai-responses").expect("provider protocol"),
        )
        .expect("same protocol direct lane");
        let container = DirectRelayContainer::new(
            vec![Arc::new(DirectRequestPassthrough)],
            vec![Arc::new(DirectResponsePassthrough)],
        );
        let payload = Arc::new(serde_json::json!({"model":"gpt-5.5"}));
        let provider = container
            .execute_request(&information, Arc::clone(&payload))
            .expect("direct request relay");
        assert!(Arc::ptr_eq(&payload, &provider));
        let client = container
            .execute_response(&information, Arc::clone(&provider))
            .expect("direct response relay");
        assert!(Arc::ptr_eq(&provider, &client));
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

    fn stream(chunks: Vec<Result<Vec<u8>, String>>) -> ResponsesSseStream<MockSseSource> {
        stream_for(chunks, "responses", "direct")
    }

    fn stream_for(
        chunks: Vec<Result<Vec<u8>, String>>,
        entry_protocol: &str,
        continuation_owner: &str,
    ) -> ResponsesSseStream<MockSseSource> {
        stream_for_with_runtime(runtime(), chunks, entry_protocol, continuation_owner)
    }

    fn stream_for_with_runtime(
        runtime: Arc<Mutex<SkeletonRuntime>>,
        chunks: Vec<Result<Vec<u8>, String>>,
        entry_protocol: &str,
        continuation_owner: &str,
    ) -> ResponsesSseStream<MockSseSource> {
        let request_lease = runtime
            .lock()
            .expect("test runtime lock")
            .admit_request("request-1")
            .expect("test stream admission");
        ResponsesSseStream::new(
            MockSseSource {
                chunks: chunks.into(),
                wait_result: Ok(()),
            },
            runtime,
            request_lease,
            "request-1".to_string(),
            u16::from_ne_bytes([0, 1]),
            entry_protocol.to_string(),
            continuation_owner.to_string(),
            "responses".to_string(),
            "session-1".to_string(),
            "conversation-1".to_string(),
            Arc::new(DirectRelayContainer::new(
                vec![Arc::new(DirectRequestPassthrough)],
                vec![Arc::new(DirectResponsePassthrough)],
            )),
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
        assert!(text.contains("provider_sse_malformed"));
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
        let projected = routecodex_v4_standard_plugins::request_plugins::project_chat_request_to_responses(&body)
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
