use routecodex_v4_base_node::Scope;
use routecodex_v4_cordis_bridge::{HandleRegistry, PluginHandle};
use routecodex_v4_skeleton::SkeletonPlan;
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
    start_managed, status_managed, LifecycleError, ManagedAction, ManagedControlPlane,
    ManagedInstanceRecord, ManagedSpawnOptions, V4LifecyclePaths,
};
use routecodex_v4_node_container::ExecutionEpochSnapshot;
use routecodex_v4_provider::{
    send_target_nonstream as provider_send_target_nonstream,
    send_target_streaming as provider_send_target_streaming, write_provider_profile,
    ProviderInitAuth, ProviderInitOptions, ProviderResponseStream, V4Availability01SessionScoped,
};
use routecodex_v4_router::{
    apply_product_error_policy,
    TargetSelectionHandle, DIRECT_TARGET_SELECTION_PLUGIN_ID, TARGET_SELECTION_PLUGIN_ID,
};
use routecodex_v4_runtime::{
    parse_request_admission_facts, project_runtime_fault, project_runtime_fault_with_policy,
    ResponseStreamDisposition, ResponseStreamProcessor, RuntimeFault, SkeletonRuntime,
};
use routecodex_v4_server::{
    AsyncHttpHandler, AsyncHttpServer, HttpHandler, HttpRequest, HttpResponse, ResponseStream,
};
use routecodex_v4_servertool::{build_run_projection, ServertoolRunInput};
use routecodex_v4_standard_plugins::diagnostic;
use routecodex_v4_standard_plugins::StandardHandleRegistry;
use serde_json::Value;
use routecodex_v4_standard_plugins::sse_transport::{
    production_transport_pair, SseEgressPlugin, SseIngressPlugin,
};
use std::future::Future;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;
use tokio_util::sync::CancellationToken;

#[derive(Debug, Clone, PartialEq, Eq)]
struct CordisAdmission {
    generation: u64,
    graph_hash: String,
}

impl CordisAdmission {
    fn admit(
        expected_graph_hash: &str,
        expected_manifest_hash: &str,
        expected_epoch_id: &str,
    ) -> Result<Self, String> {
        use std::os::unix::net::UnixStream;
        let socket_path = std::env::var("RCCV4_CORDIS_HOST_SOCKET")
            .map_err(|_| "Cordis admission requires RCCV4_CORDIS_HOST_SOCKET".to_string())?;
        let mut handshake_stream = UnixStream::connect(&socket_path)
            .map_err(|error| format!("Cordis admission socket connect failed: {error}"))?;
        handshake_stream
            .write_all(format!("{{\"op\":\"handshake\",\"protocolVersion\":1,\"graphHash\":\"{expected_graph_hash}\"}}\n").as_bytes())
            .map_err(|error| format!("Cordis admission request failed: {error}"))?;
        let mut handshake = String::new();
        handshake_stream.read_to_string(&mut handshake).map_err(|error| error.to_string())?;
        let value: Value = serde_json::from_str(handshake.trim()).map_err(|error| error.to_string())?;
        if value.get("ok") != Some(&Value::Bool(true)) {
            return Err("Cordis admission handshake rejected".to_string());
        }
        let generation = value["snapshot"]["generation"]
            .as_u64().ok_or_else(|| "Cordis admission snapshot has no generation".to_string())?;
        let mut stream = UnixStream::connect(&socket_path).map_err(|error| error.to_string())?;
        let request = serde_json::json!({
            "op": "admission", "protocolVersion": 1, "generation": generation,
            "graphHash": expected_graph_hash, "manifestHash": expected_manifest_hash,
            "epochId": expected_epoch_id,
        });
        stream.write_all(format!("{request}\n").as_bytes()).map_err(|error| error.to_string())?;
        let mut response = String::new();
        stream.read_to_string(&mut response).map_err(|error| error.to_string())?;
        let response: Value = serde_json::from_str(response.trim()).map_err(|error| error.to_string())?;
        if response.get("ok") != Some(&Value::Bool(true)) {
            return Err(format!("Cordis admission rejected: {}", response["message"].as_str().unwrap_or("unknown error")));
        }
        let active = response["admission"]["active_epoch"].clone();
        if active["graph_hash"].as_str() != Some(expected_graph_hash)
            || active["manifest_hash"].as_str() != Some(expected_manifest_hash)
            || active["epoch_id"].as_str() != Some(expected_epoch_id) {
            return Err("Cordis admission active epoch identity mismatch".to_string());
        }
        Ok(Self { generation, graph_hash: expected_graph_hash.to_string() })
    }
}

struct ProductionHandleRegistry {
    standard: StandardHandleRegistry,
    router_target: Option<TargetSelectionHandle>,
}

impl ProductionHandleRegistry {
    fn new(product: Option<&RuntimeProductConfig>) -> Self {
        Self {
            standard: StandardHandleRegistry::new(),
            router_target: product.cloned().map(TargetSelectionHandle::new),
        }
    }
}

impl HandleRegistry for ProductionHandleRegistry {
    fn get(&self, plugin_id: &str) -> Option<&dyn PluginHandle> {
        if plugin_id == TARGET_SELECTION_PLUGIN_ID
            || plugin_id == DIRECT_TARGET_SELECTION_PLUGIN_ID
            || plugin_id == "v4.std.routing.route_facts_consumer"
        {
            if let Some(handle) = self.router_target.as_ref() {
                return Some(handle as &dyn PluginHandle);
            }
        }
        self.standard.get(plugin_id)
    }

    fn encode_client_error_sse(&self, entry_protocol: &str, message: &str) -> Result<Vec<u8>, String> {
        self.standard.encode_client_error_sse(entry_protocol, message)
    }

}

/// Cordis service readiness report produced by `cordis_service_readiness`.
/// The numbers mirror what a CordisBoundNodeHost would observe after
/// `mount()` + `beginExecution()` on the production plan.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CordisReadinessReport {
    pub bound_plugin_count: usize,
    pub missing_plugin_ids: Vec<String>,
    pub service_binding_count: usize,
    pub plan_node_count: usize,
}

/// Mirror of the CordisBoundNodeHost.mount() precondition for production.
/// The runtime-bin production entry calls this before binding any TCP
/// listener. A failure aborts startup with a typed error that names every
/// runtime plugin missing a typed handle so the operator can repair the
/// catalog before serving traffic. Compile-time config operators are already
/// consumed by `compile_runtime_config` and are not runtime bindings.
pub fn cordis_service_readiness(
    skeleton: &SkeletonPlan,
    registry: &dyn HandleRegistry,
    service_binding_count: usize,
) -> Result<CordisReadinessReport, String> {
    let mut plugin_ids = std::collections::BTreeSet::new();
    let mut plan_node_count = 0usize;
    for chain in &skeleton.chains {
        for node in &chain.nodes {
            plan_node_count += 1;
            if chain.chain_id == "config" {
                continue;
            }
            for plugin in &node.plugins {
                plugin_ids.insert(plugin.plugin_id.clone());
            }
        }
    }
    let mut bound_plugin_count = 0usize;
    let mut missing_plugin_ids = Vec::new();
    for plugin_id in &plugin_ids {
        if registry.contains(plugin_id.as_str()) {
            bound_plugin_count += 1;
        } else {
            missing_plugin_ids.push(plugin_id.clone());
        }
    }
    missing_plugin_ids.sort();
    let report = CordisReadinessReport {
        bound_plugin_count,
        missing_plugin_ids: missing_plugin_ids.clone(),
        service_binding_count,
        plan_node_count,
    };
    if !missing_plugin_ids.is_empty() {
        return Err(format!(
            "cordis service readiness failed: missing plugin handles for {} of {} compiled plugins: {}",
            missing_plugin_ids.len(),
            plugin_ids.len(),
            missing_plugin_ids.join(", ")
        ));
    }
    Ok(report)
}

/// Test helper that shadows a real registry with one whose first compiled
/// plugin id resolves to None. Used by the negative red test.
pub struct MissingStandardHandleRegistry<'a, R: HandleRegistry + ?Sized> {
    inner: &'a R,
    missing_plugin_id: String,
}

impl<'a, R: HandleRegistry + ?Sized> MissingStandardHandleRegistry<'a, R> {
    pub fn new(inner: &'a R, missing_plugin_id: impl Into<String>) -> Self {
        Self {
            inner,
            missing_plugin_id: missing_plugin_id.into(),
        }
    }
}

impl<'a, R: HandleRegistry + ?Sized> HandleRegistry for MissingStandardHandleRegistry<'a, R> {
    fn get(&self, plugin_id: &str) -> Option<&dyn routecodex_v4_cordis_bridge::PluginHandle> {
        if plugin_id == self.missing_plugin_id {
            None
        } else {
            self.inner.get(plugin_id)
        }
    }

    fn encode_client_error_sse(&self, entry_protocol: &str, message: &str) -> Result<Vec<u8>, String> {
        self.inner.encode_client_error_sse(entry_protocol, message)
    }
}

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
    preflight_cordis_admission(&manifest)?;
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

/// Validate the complete external Cordis admission before taking over a
/// managed listener. A connectable but stale/rejecting socket must not stop a
/// healthy V4 child only to discover that its replacement cannot admit.
fn preflight_cordis_admission(manifest: &RuntimeConfigManifest) -> Result<(), String> {
    let epoch_id = manifest.execution_epoch.candidate["epoch_id"]
        .as_str()
        .ok_or_else(|| "runtime candidate has no epoch_id".to_string())?;
    CordisAdmission::admit(
        &manifest.execution_epoch.graph_hash,
        &manifest.execution_epoch.manifest_hash,
        epoch_id,
    )
    .map(|_| ())
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
                    let handler = Arc::new(PipelineHandler::new_production(manifest)?);
                    let server = AsyncHttpServer::bind_persisted(&server)
                        .await
                        .map_err(|error| error.to_string())?;
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
        env: std::env::vars()
            .filter(|(name, _)| name == "RCCV4_CORDIS_HOST_SOCKET")
            .collect(),
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
}

impl PipelineHandler {
    fn new(manifest: RuntimeConfigManifest) -> Result<Self, String> {
        Self::new_with_admission(manifest, false)
    }

    fn new_production(manifest: RuntimeConfigManifest) -> Result<Self, String> {
        Self::new_with_admission(manifest, true)
    }

    fn new_with_admission(
        manifest: RuntimeConfigManifest,
        require_cordis_admission: bool,
    ) -> Result<Self, String> {
        let registry = Arc::new(ProductionHandleRegistry::new(manifest.product.as_ref()));
        let cordis_admission_receipt = if require_cordis_admission {
            Some(CordisAdmission::admit(
                &manifest.execution_epoch.graph_hash,
                &manifest.execution_epoch.manifest_hash,
                manifest.execution_epoch.candidate["epoch_id"].as_str()
                    .ok_or_else(|| "runtime candidate has no epoch_id".to_string())?,
            )?)
        } else {
            None
        };
        let runtime =
            SkeletonRuntime::from_compiled_plan_with_registry(manifest.execution_epoch.skeleton.clone(), registry)
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
        if let Some(receipt) = cordis_admission_receipt {
            if receipt.graph_hash != manifest.execution_epoch.graph_hash || receipt.generation == 0 {
                return Err("Cordis admission receipt is invalid".to_string());
            }
        }
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
                &request,
                "responses",
                "direct",
            )
            .unwrap_or_else(|response| response),
            ("POST", "/v1/chat/completions") => handle_responses(
                &self.manifest,
                &self.runtime,
                &self.availability,
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

fn select_target_via_cordis(
    runtime: &Arc<Mutex<SkeletonRuntime>>,
    request: &HttpRequest,
    entry_protocol: &str,
    model: &str,
    session_scope: &str,
    conversation_scope: &str,
    route_group_id: &str,
    unavailable_provider_ids: &[String],
) -> Result<routecodex_v4_router::SelectedTarget, RuntimeFault> {
    let selection = runtime
        .lock()
        .map_err(|_| RuntimeFault::new("request_runtime_lock", "request runtime lock poisoned"))?
        .execute_target_selection(
            &request.request_id,
            request.port,
            session_scope,
            conversation_scope,
            entry_protocol,
            if entry_protocol == "responses" { "direct" } else { "relay" },
            model,
            route_group_id,
            unavailable_provider_ids,
        )?;
    let object = selection.as_object().ok_or_else(|| RuntimeFault::new("target_selection", "Cordis target selection is not an object"))?;
    Ok(routecodex_v4_router::SelectedTarget {
        provider_id: object.get("provider_id").and_then(Value::as_str).ok_or_else(|| RuntimeFault::new("target_selection", "Cordis target selection missing provider_id"))?.to_string(),
        config_path: object.get("config_path").and_then(Value::as_str).ok_or_else(|| RuntimeFault::new("target_selection", "Cordis target selection missing config_path"))?.to_string(),
        protocol: object.get("protocol").and_then(Value::as_str).ok_or_else(|| RuntimeFault::new("target_selection", "Cordis target selection missing protocol"))?.to_string(),
        wire_model: object.get("wire_model").and_then(Value::as_str).ok_or_else(|| RuntimeFault::new("target_selection", "Cordis target selection missing wire_model"))?.to_string(),
        auth_alias: object.get("auth_alias").and_then(Value::as_str).map(str::to_string),
    })
}

fn handle_responses(
    manifest: &RuntimeConfigManifest,
    runtime: &Arc<Mutex<SkeletonRuntime>>,
    availability: &Arc<Mutex<V4Availability01SessionScoped>>,
    request: &HttpRequest,
    entry_protocol: &str,
    continuation_owner: &str,
) -> Result<HttpResponse, HttpResponse> {
    let started_at = std::time::Instant::now();
    let admission = parse_request_admission_facts(
        &request.body,
        entry_protocol,
        continuation_owner,
    )
    .map_err(|fault| project_fault(request, fault, 400))?;
    let session_scope = request
        .header("x-rccv4-session-id")
        .unwrap_or(&request.request_id);
    let conversation_scope = request
        .header("x-rccv4-conversation-id")
        .unwrap_or(session_scope);
    let model = admission.model.as_str();
    let stream_mode = admission.stream;
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
        select_target_via_cordis(
            runtime,
            request,
            entry_protocol,
            model,
            session_scope,
            conversation_scope,
            &route_group.route_group_id,
            &unavailable_provider_ids,
        )
        .map_err(|error| routecodex_v4_router::TargetSelectionError::ProductPoolUnavailable(error.message))
    } else {
        return Err(project_fault(
            request,
            RuntimeFault::new(
                "product_route_config_missing",
                "production Cordis routing requires a compiled product route graph",
            ),
            500,
        ));
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
        let mut stream = provider_send_target_streaming(
            &target.protocol,
            &target.config_path,
            &target.wire_model,
            target.auth_alias.as_deref(),
            &wire_body,
        )
        .map_err(|error| {
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
                        if let Ok(candidate) = select_target_via_cordis(
                            runtime,
                            request,
                            entry_protocol,
                            model,
                            session_scope,
                            conversation_scope,
                            &route_group.route_group_id,
                            &excluded,
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
                            stream =
                                provider_send_target_streaming(
                                    &target.protocol,
                                    &target.config_path,
                                    &target.wire_model,
                                    target.auth_alias.as_deref(),
                                    &retry_body,
                                )
                                .map_err(|error| {
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
        let response_stream =
            CordisSseTransportStream::new(stream, Arc::clone(runtime), response_processor);
        return Ok(HttpResponse::streaming(
            client_status,
            "text/event-stream",
            Box::new(response_stream),
        ));
    }
    let mut raw = provider_send_target_nonstream(
        &target.protocol,
        &target.config_path,
        &target.wire_model,
        target.auth_alias.as_deref(),
        &wire_body,
    )
    .map_err(|error| {
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
                if let Ok(candidate) = select_target_via_cordis(
                    runtime,
                    request,
                    entry_protocol,
                    model,
                    session_scope,
                    conversation_scope,
                    &route_group.route_group_id,
                    &excluded,
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
                    raw = provider_send_target_nonstream(
                        &target.protocol,
                        &target.config_path,
                        &target.wire_model,
                        target.auth_alias.as_deref(),
                        &retry_body,
                    )
                    .map_err(|error| {
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
}

impl<S: ProviderSseSource> CordisSseTransportStream<S> {
    fn new(
        stream: S,
        runtime: Arc<Mutex<SkeletonRuntime>>,
        processor: ResponseStreamProcessor,
    ) -> Self {
        let (ingress, egress) = production_transport_pair(std::time::Instant::now())
            .expect("constant SSE transport policy");
        Self {
            stream,
            runtime,
            processor,
            ingress,
            egress,
            close_after_pending: false,
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
    trace: &[String],
    request: &HttpRequest,
    endpoint: &str,
    provider: &str,
    model: &str,
    stream: bool,
    status: Option<u16>,
    elapsed: std::time::Duration,
) {
    for event in trace {
        if let Some(line) = render_payload_console_event(
            event, request, endpoint, provider, model, stream, status, elapsed,
        ) {
            println!("{line}");
            let _ = std::io::stdout().flush();
        }
    }
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
            port: 5520,
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

    #[test]
    fn production_request_report_witnesses_real_cordis_handles() {
        let handler = PipelineHandler::new(test_manifest()).expect("handler initializes");
        let runtime = handler.runtime.lock().expect("runtime lock");
        let lease = runtime.admit_request("request-plugin-witness").expect("request lease");
        let report = runtime
            .execute_request_json_scoped_for_target_with_lease(
                r#"{"model":"mock-model","messages":[{"role":"user","content":"hello"}]}"#,
                "chat",
                "responses",
                "mock-model",
                false,
                "request-plugin-witness",
                5520,
                "session-plugin-witness",
                "conversation-plugin-witness",
                Some("relay"),
                Some(&lease),
            )
            .expect("request chain executes");
        for plugin_id in [
            "v4.std.request.protocol_parse",
            "v4.std.request.responses_normalize",
            "v4.std.chat_process.request_governance",
            "v4.std.request.responses_wire_build",
            "v4.std.provider.wire_build",
        ] {
            assert!(
                report.trace.iter().any(|entry| {
                    entry.starts_with(plugin_id) && entry.contains("plugin.executed")
                }),
                "production request report missing typed handle witness for {plugin_id}: {:?}",
                report.trace
            );
        }
        let published = runtime
            .diagnostic_bus()
            .lock()
            .expect("diagnostic bus lock")
            .published_facts()
            .len();
        assert!(published > 0, "production plugin execution must publish diagnostic facts");
    }

    #[test]
    fn production_response_report_witnesses_real_cordis_handles() {
        let handler = PipelineHandler::new(test_manifest()).expect("handler initializes");
        let runtime = handler.runtime.lock().expect("runtime lock");
        let lease = runtime.admit_request("response-plugin-witness").expect("response lease");
        let report = runtime
            .execute_provider_response_scoped_for_target_with_lease(
                r#"{"id":"resp_1","model":"mock-model","output":[{"type":"message","content":[{"type":"output_text","text":"hello"}]}]}"#,
                "response-plugin-witness",
                5520,
                "session-response-plugin-witness",
                "conversation-response-plugin-witness",
                "chat",
                "responses",
                "relay",
                Some(&lease),
            )
            .expect("response chain executes");
        for plugin_id in [
            "v4.std.response.provider_raw_validate",
            "v4.std.response.provider_compat",
            "v4.std.response.protocol_decode",
            "v4.std.chat_process.response_governance",
            "v4.std.chat_process.tool_harvest",
            "v4.hook.relay.response",
            "v4.std.response.frame_build",
        ] {
            assert!(
                report.trace.iter().any(|entry| {
                    entry.starts_with(plugin_id) && entry.contains("plugin.executed")
                }),
                "production response report missing typed handle witness for {plugin_id}: {:?}",
                report.trace
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

    #[test]
    fn production_entry_cordis_service_readiness_binds_every_compiled_plugin() {
        let manifest = test_manifest();
        let registry = ProductionHandleRegistry::new(manifest.product.as_ref());
        let plan = {
            let handler = PipelineHandler::new(test_manifest())
                .expect("production handler must initialize");
            let plan = handler.runtime.lock().expect("runtime lock").plan().clone();
            plan
        };
        let report = super::cordis_service_readiness(&plan, &registry, 0)
            .expect("production readiness must succeed with the standard registry");
        let compiled_plugin_ids: std::collections::BTreeSet<&str> = plan
            .chains
            .iter()
            .filter(|chain| chain.chain_id != "config")
            .flat_map(|chain| chain.nodes.iter())
            .flat_map(|node| node.plugins.iter())
            .map(|plugin| plugin.plugin_id.as_str())
            .collect();
        let missing_in_compiled_plan: std::collections::BTreeSet<&str> = report
            .missing_plugin_ids
            .iter()
            .map(|id| id.as_str())
            .collect();
        assert!(
            missing_in_compiled_plan.is_empty(),
            "readiness must report every compiled plugin bound: missing={:?}",
            missing_in_compiled_plan
        );
        assert!(
            report.bound_plugin_count >= compiled_plugin_ids.len(),
            "readiness must bind every compiled plugin ({} expected, {} bound)",
            compiled_plugin_ids.len(),
            report.bound_plugin_count
        );
        assert_eq!(report.service_binding_count, 0);
    }

    #[test]
    fn production_entry_cordis_service_readiness_fails_when_a_plugin_handle_is_missing() {
        let manifest = test_manifest();
        let registry = ProductionHandleRegistry::new(manifest.product.as_ref());
        let plan = {
            let handler = PipelineHandler::new(test_manifest())
                .expect("production handler must initialize");
            let plan = handler.runtime.lock().expect("runtime lock").plan().clone();
            plan
        };
        let missing_plugin_id = plan
            .chains
            .iter()
            .flat_map(|chain| chain.nodes.iter())
            .flat_map(|node| node.plugins.iter())
            .map(|plugin| plugin.plugin_id.clone())
            .next()
            .expect("test plan must contain a compiled plugin");
        let broken_registry = MissingStandardHandleRegistry::new(&registry, missing_plugin_id);
        let error = super::cordis_service_readiness(&plan, &broken_registry, 1)
            .expect_err("readiness must fail when a plugin handle is missing");
        assert!(
            error.contains("missing plugin handles"),
            "error must identify the readiness gap: {error}"
        );
    }
}
