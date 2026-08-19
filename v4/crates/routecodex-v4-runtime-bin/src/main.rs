use routecodex_v4_base_node::Scope;
use routecodex_v4_cli::{
    Cli, ConfigIntent, ConfigPathIntent, InitIntent, ManagedChildIntent, RestartIntent, ServerIntent,
    ServerStartIntent, ServertoolIntent, SnapshotIntent, StartIntent, StopIntent, V4CommandIntent,
};
use routecodex_v4_config::{
    compile_runtime_config_file, default_runtime_config_path, load_runtime_manifest,
    write_runtime_authoring, write_runtime_manifest_atomic, RuntimeConfigManifest,
    RuntimeInitOptions,
};
use routecodex_v4_error::ErrorChain;
use routecodex_v4_lifecycle::{
    exec_managed_restart, request_restart, request_stop, start_managed, status_managed,
    ManagedAction, ManagedControlPlane, ManagedInstanceRecord, ManagedSpawnOptions,
    V4LifecyclePaths,
};
use routecodex_v4_provider::{
    send_responses, send_responses_streaming, write_provider_profile, ProviderInitAuth,
    ProviderInitOptions, ProviderResponseStream,
};
use routecodex_v4_router::select_target;
use routecodex_v4_runtime::{
    build_responses_wire_request, parse_responses_provider_payload, project_runtime_fault,
    ResponsesProviderPayload, RuntimeFault, SkeletonRuntime,
};
use routecodex_v4_server::{
    HttpHandler, HttpRequest, HttpResponse, ResponseStream, V4HttpServer,
};
use routecodex_v4_servertool::{build_run_output, ServertoolRunInput};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

const VERSION: &str = concat!(env!("CARGO_PKG_VERSION"), "-v4");
const SKELETON_PLAN: &str = include_str!("../../../contracts/skeleton-plan.contract.json");
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
        (None, None, Some(value)) => {
            ProviderInitAuth::TokenFile(value.display().to_string())
        }
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
    let output = build_run_output(ServertoolRunInput {
        tool_name: intent.tool_name,
        input,
        flow_id: intent.flow,
        session_id: intent.session_id,
        request_id: intent.request_id,
    })
    .map_err(|error| error.to_string())?;
    serde_json::to_string(&output).map_err(|error| error.to_string())
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
    let (config, _, paths) = compile_for_lifecycle(intent.config)?;
    let executable = std::env::current_exe().map_err(|error| error.to_string())?;
    let options = spawn_options(&intent.snapshot);
    let record = start_managed(
        &paths,
        &executable,
        &config,
        &paths.manifest_path,
        &options,
        Duration::from_secs(15),
    )
    .map_err(|error| error.to_string())?;
    Ok(format_status("started", &record))
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
            snapshot: intent.snapshot,
        });
    }
    let config = config_path(ConfigPathIntent {
        config: intent.config,
    })?;
    let manifest = compile_runtime_config_file(&config).map_err(|error| error.to_string())?;
    run_foreground(manifest)?;
    Ok("state=stopped identity=rccv4 foreground=true".to_string())
}

fn run_managed_child(intent: ManagedChildIntent) -> Result<(), String> {
    let manifest = load_runtime_manifest(&intent.manifest).map_err(|error| error.to_string())?;
    SkeletonRuntime::load(SKELETON_PLAN).map_err(|error| error.to_string())?;
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
    join_servers(handles)?;
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

fn bind_servers(manifest: &RuntimeConfigManifest) -> Result<Vec<V4HttpServer>, String> {
    manifest
        .listeners
        .iter()
        .map(|listener| V4HttpServer::bind(&listener.address).map_err(|error| error.to_string()))
        .collect()
}

fn spawn_servers(
    servers: Vec<V4HttpServer>,
    manifest: RuntimeConfigManifest,
    stop: Arc<AtomicBool>,
) -> Vec<thread::JoinHandle<Result<(), String>>> {
    servers
        .into_iter()
        .map(|server| {
            let manifest = manifest.clone();
            let stop = Arc::clone(&stop);
            thread::spawn(move || {
                let mut handler = PipelineHandler::new(manifest)?;
                server
                    .run_until(&mut handler, || stop.load(Ordering::Acquire))
                    .map_err(|error| error.to_string())
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
    skeleton: Arc<Mutex<SkeletonRuntime>>,
}

impl PipelineHandler {
    fn new(manifest: RuntimeConfigManifest) -> Result<Self, String> {
        let skeleton = Arc::new(Mutex::new(
            SkeletonRuntime::load(SKELETON_PLAN).map_err(|error| error.to_string())?,
        ));
        Ok(Self { manifest, skeleton })
    }
}

impl HttpHandler for PipelineHandler {
    fn handle(&mut self, request: HttpRequest) -> HttpResponse {
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
            ("POST", "/v1/responses") => {
                handle_responses(&self.manifest, &self.skeleton, &request)
                    .unwrap_or_else(|response| response)
            }
            _ => project_fault(
                &request,
                RuntimeFault::new("route_not_found", "route not found"),
                404,
            ),
        }
    }
}

fn models_response(manifest: &RuntimeConfigManifest) -> HttpResponse {
    let mut models = manifest
        .routes
        .iter()
        .flat_map(|route| route.models.iter())
        .collect::<Vec<_>>();
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

fn handle_responses(
    manifest: &RuntimeConfigManifest,
    skeleton: &Arc<Mutex<SkeletonRuntime>>,
    request: &HttpRequest,
) -> Result<HttpResponse, HttpResponse> {
    let body: serde_json::Value = serde_json::from_slice(&request.body).map_err(|error| {
        project_fault(
            request,
            RuntimeFault::new("invalid_request", format!("invalid JSON: {error}")),
            400,
        )
    })?;
    let raw_entry = format!("responses:{}", String::from_utf8_lossy(&request.body));
    let session_scope = request
        .header("x-rccv4-session-id")
        .unwrap_or(&request.request_id);
    let conversation_scope = request
        .header("x-rccv4-conversation-id")
        .unwrap_or(session_scope);
    skeleton
        .lock()
        .map_err(|_| {
            project_fault(
                request,
                RuntimeFault::new("request_runtime_lock", "request runtime lock poisoned"),
                500,
            )
        })?
        .execute_request_scoped(
            &raw_entry,
            &request.request_id,
            request.port,
            session_scope,
            conversation_scope,
        )
        .map_err(|fault| project_fault(request, fault, 400))?;
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
    let target = select_target(&manifest.providers, &manifest.routes, model).map_err(|error| {
        project_fault(
            request,
            RuntimeFault::new("model_unavailable", error.to_string()),
            404,
        )
    })?;
    let wire = build_responses_wire_request(&body, &target.wire_model, stream_mode)
        .map_err(|fault| project_fault(request, fault, 400))?;
    let wire_body: serde_json::Value = serde_json::from_slice(&wire.body).map_err(|error| {
        project_fault(
            request,
            RuntimeFault::new("provider_wire_encode", error.to_string()),
            500,
        )
    })?;
    if stream_mode {
        let stream = send_responses_streaming(&target.config_path, &target.wire_model, &wire_body)
            .map_err(|error| {
                project_fault(
                    request,
                    RuntimeFault::new(error.code.as_str(), error.message)
                        .with_status(error.status.unwrap_or(502)),
                    error.status.unwrap_or(502),
                )
            })?;
        let status = stream.status();
        if status >= 400 {
            return Err(project_fault(
                request,
                RuntimeFault::new(
                    "provider_http_error",
                    format!("upstream Responses returned HTTP {status}"),
                )
                .with_status(status),
                status,
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
        let response_stream = ResponsesSseStream::new(
            stream,
            Arc::clone(skeleton),
            request.request_id.clone(),
            request.port,
            session_scope.to_string(),
            conversation_scope.to_string(),
        );
        return Ok(HttpResponse::streaming(
            status,
            "text/event-stream",
            Box::new(response_stream),
        ));
    }
    let raw = send_responses(&target.config_path, &target.wire_model, &wire_body, false)
        .map_err(|error| {
            project_fault(
                request,
                RuntimeFault::new(error.code.as_str(), error.message),
                error.status.unwrap_or(502),
            )
        })?;
    match parse_responses_provider_payload(raw.status, &raw.content_type, &raw.body, false)
        .map_err(|fault| project_fault(request, fault, 502))?
    {
        ResponsesProviderPayload::Json(value) => {
            let provider_raw = serde_json::to_string(&value).map_err(|error| {
                project_fault(
                    request,
                    RuntimeFault::new("provider_json_encode", error.to_string()),
                    500,
                )
            })?;
            skeleton
                .lock()
                .map_err(|_| {
                    project_fault(
                        request,
                        RuntimeFault::new("response_runtime_lock", "response runtime lock poisoned"),
                        500,
                    )
                })?
                .execute_provider_response_scoped(
                    &provider_raw,
                    &format!("{}-response", request.request_id),
                    request.port,
                    session_scope,
                    conversation_scope,
                    "responses",
                    "direct",
                )
                .map_err(|fault| project_fault(request, fault, 502))?;
            Ok(json_response(raw.status, value))
        }
        ResponsesProviderPayload::Sse(_) => Err(project_fault(
            request,
            RuntimeFault::new("provider_protocol_mismatch", "non-stream request returned SSE"),
            502,
        )),
    }
}

struct ResponsesSseStream {
    stream: ProviderResponseStream,
    skeleton: Arc<Mutex<SkeletonRuntime>>,
    pending: Vec<u8>,
    frame_buffer: Vec<u8>,
    terminal_seen: bool,
    frame_sequence: u64,
    request_id: String,
    port: u16,
    session_scope: String,
    conversation_scope: String,
}

impl ResponsesSseStream {
    fn new(
        stream: ProviderResponseStream,
        skeleton: Arc<Mutex<SkeletonRuntime>>,
        request_id: String,
        port: u16,
        session_scope: String,
        conversation_scope: String,
    ) -> Self {
        Self {
            stream,
            skeleton,
            pending: Vec::new(),
            frame_buffer: Vec::new(),
            terminal_seen: false,
            frame_sequence: 0,
            request_id,
            port,
            session_scope,
            conversation_scope,
        }
    }
}

impl ResponseStream for ResponsesSseStream {
    fn next_chunk(&mut self, chunk: &mut Vec<u8>) -> Result<bool, std::io::Error> {
        loop {
            if !self.pending.is_empty() {
                chunk.extend_from_slice(&self.pending);
                self.pending.clear();
                return Ok(true);
            }
            let mut bytes = [0u8; 8192];
            let count = self.stream.read_chunk(&mut bytes).map_err(io_fault)?;
            if count == 0 {
                if !self.terminal_seen {
                    return Err(std::io::Error::new(
                        std::io::ErrorKind::InvalidData,
                        "provider SSE ended before response.completed or response.failed",
                    ));
                }
                self.stream.wait().map_err(io_fault)?;
                return Ok(false);
            }
            self.frame_buffer.extend_from_slice(&bytes[..count]);
            while let Some(end) = find_frame_end(&self.frame_buffer) {
                let frame = self.frame_buffer[..end].to_vec();
                self.frame_buffer.drain(..end);
                let parsed = routecodex_v4_runtime::parse_responses_sse_frame(&frame)
                    .map_err(|fault| {
                        std::io::Error::new(std::io::ErrorKind::InvalidData, fault.to_string())
                    })?;
                if parsed.terminal {
                    let event = parsed
                        .events
                        .iter()
                        .find(|event| {
                            matches!(
                                event.get("type").and_then(serde_json::Value::as_str),
                                Some("response.completed" | "response.failed")
                            )
                        })
                        .ok_or_else(|| {
                            std::io::Error::new(
                                std::io::ErrorKind::InvalidData,
                                "terminal SSE frame has no terminal event",
                            )
                        })?;
                    self.frame_sequence += 1;
                    let provider_raw = serde_json::to_string(&event).map_err(io_fault)?;
                    self.skeleton
                        .lock()
                        .map_err(|_| std::io::Error::other("response runtime lock poisoned"))?
                        .execute_provider_response_scoped(
                            &provider_raw,
                            &format!("{}-sse-{}", self.request_id, self.frame_sequence),
                            self.port,
                            &self.session_scope,
                            &self.conversation_scope,
                            "responses",
                            "direct",
                        )
                        .map_err(|fault| {
                            std::io::Error::new(std::io::ErrorKind::InvalidData, fault.to_string())
                        })?;
                }
                self.terminal_seen |= parsed.terminal;
                self.pending.extend_from_slice(&frame);
            }
        }
    }
}

fn io_fault(error: impl std::fmt::Display) -> std::io::Error {
    std::io::Error::other(error.to_string())
}

fn find_frame_end(bytes: &[u8]) -> Option<usize> {
    bytes
        .windows(2)
        .position(|window| window == b"\n\n")
        .map(|position| position + 2)
}

fn project_fault(request: &HttpRequest, fault: RuntimeFault, status: u16) -> HttpResponse {
    let scope = Scope::new(&request.request_id, "v4-pipeline", request.port, "", "");
    let mut chain = ErrorChain::new(scope);
    match project_runtime_fault(&mut chain, fault.clone()) {
        Ok(projection) => HttpResponse::error(status, projection.message),
        Err(error) => HttpResponse::error(
            500,
            format!("error chain projection failed for {}: {error:?}", fault.code),
        ),
    }
}

fn json_response(status: u16, value: serde_json::Value) -> HttpResponse {
    let body = serde_json::to_vec(&value).expect("JSON response value is serializable");
    HttpResponse::json(status, body)
}
