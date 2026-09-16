use crate::*;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::io::{BufRead, BufReader, Write};
use std::os::unix::fs::FileTypeExt;
use std::os::unix::fs::MetadataExt;
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// Identity of the control socket this server bound. Cleanup compares it
/// against the current path so shutdown can never unlink a replacement that
/// another process created after this server bound the pathname.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct ControlSocketIdentity {
    device: u64,
    inode: u64,
    is_socket: bool,
}

fn control_socket_identity(path: &Path) -> Option<ControlSocketIdentity> {
    let metadata = std::fs::symlink_metadata(path).ok()?;
    let file_type = metadata.file_type();
    Some(ControlSocketIdentity {
        device: metadata.dev(),
        inode: metadata.ino(),
        is_socket: file_type.is_socket(),
    })
}

/// Bind the control socket owner-only. The control boundary exposes handler
/// mounting, message forwarding, schedule mutation, delivery evidence, and
/// shutdown, so only the owning user may connect. The socket is created with
/// mode 0600 rather than relying on the process umask or a private parent
/// directory; this is the unique owner of the control boundary.
fn bind_control_socket(socket_path: &Path) -> std::io::Result<UnixListener> {
    let listener = UnixListener::bind(socket_path)?;
    if let Err(error) =
        std::fs::set_permissions(socket_path, std::fs::Permissions::from_mode(0o600))
    {
        // Never leave a control socket reachable with wider permissions than
        // intended: fail closed and remove the just-created path.
        let _ = std::fs::remove_file(socket_path);
        return Err(error);
    }
    Ok(listener)
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "method", content = "params", rename_all = "snake_case")]
pub enum ControlRequest {
    Health,
    RegisterHandler {
        handler_id: String,
        hook_kind: String,
    },
    MountHandler {
        handler_id: String,
        hook_kind: String,
        strategy: HookHandlerStrategy,
    },
    UnregisterHandler {
        hook_kind: String,
    },
    ForwardMessage {
        intent: Box<MessageIntent>,
    },
    DispatchHookEvent {
        event: Box<HookEvent>,
        state: Box<HookState>,
    },
    ScheduleUpsert {
        schedule: Box<ScheduledMessage>,
    },
    SchedulePause {
        schedule_id: String,
    },
    ScheduleResume {
        schedule_id: String,
    },
    ScheduleRemove {
        schedule_id: String,
    },
    DeliveryEvidence {
        intent: Box<MessageIntent>,
        baseline: Vec<String>,
    },
    SessionStatus {
        target: Box<SessionTarget>,
    },
    IntentEvidence {
        intent_id: String,
    },
    RunDueSchedules {
        now_iso8601: String,
    },
    Shutdown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ControlResponse {
    pub protocol: String,
    pub ok: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl ControlResponse {
    pub fn ok(result: serde_json::Value) -> Self {
        Self {
            protocol: PROTOCOL.to_string(),
            ok: true,
            result: Some(result),
            error: None,
        }
    }

    pub fn err(error: String) -> Self {
        Self {
            protocol: PROTOCOL.to_string(),
            ok: false,
            result: None,
            error: Some(error),
        }
    }
}

pub fn handle_control_request<T: AppServerTransport>(
    core: &mut HooksSidecarCore<T>,
    request: ControlRequest,
) -> ControlResponse {
    match request {
        ControlRequest::Health => ControlResponse::ok(json!({ "status": "ok" })),
        ControlRequest::RegisterHandler {
            handler_id,
            hook_kind,
        } => {
            core.register_handler(&handler_id, &hook_kind);
            ControlResponse::ok(json!({ "registered": true, "hook_kind": hook_kind }))
        }
        ControlRequest::MountHandler {
            handler_id,
            hook_kind,
            strategy,
        } => {
            mount_configured_handler(
                core,
                &HookHandlerConfig {
                    handler_id,
                    hook_kind,
                    strategy,
                },
            );
            match core.persist_state() {
                Ok(()) => ControlResponse::ok(json!({ "mounted": true })),
                Err(error) => ControlResponse::err(error.to_string()),
            }
        }
        ControlRequest::UnregisterHandler { hook_kind } => {
            core.unregister_handler(&hook_kind);
            match core.persist_state() {
                Ok(()) => {
                    ControlResponse::ok(json!({ "unregistered": true, "hook_kind": hook_kind }))
                }
                Err(error) => ControlResponse::err(error.to_string()),
            }
        }
        ControlRequest::ForwardMessage { intent } => match core.forward(*intent) {
            Ok(DispatchOutcome::Sent(evidence)) => ControlResponse::ok(json!({
                "outcome": "sent",
                "evidence": evidence
            })),
            Ok(DispatchOutcome::NoOp) => ControlResponse::ok(json!({ "outcome": "no_op" })),
            Ok(DispatchOutcome::UnknownDelivery { intent_id, reason }) => {
                ControlResponse::ok(json!({
                    "outcome": "unknown_delivery",
                    "intent_id": intent_id,
                    "reason": reason
                }))
            }
            Ok(DispatchOutcome::Deferred { target, reason }) => ControlResponse::ok(json!({
                "outcome": "deferred",
                "target": target,
                "reason": reason
            })),
            Err(error) => ControlResponse::err(error.to_string()),
        },
        ControlRequest::DispatchHookEvent { event, state } => {
            match core.dispatch_hook_event(&event, &state) {
                Ok(decision) => ControlResponse::ok(json!({ "decision": decision })),
                Err(error) => ControlResponse::err(error.to_string()),
            }
        }
        ControlRequest::ScheduleUpsert { schedule } => match core.upsert_schedule(*schedule) {
            Ok(()) => match core.persist_state() {
                Ok(()) => ControlResponse::ok(json!({ "scheduled": true })),
                Err(error) => ControlResponse::err(error.to_string()),
            },
            Err(error) => ControlResponse::err(error),
        },
        ControlRequest::SchedulePause { schedule_id } => {
            if !core.pause_schedule(&schedule_id) {
                return ControlResponse::err(format!("schedule not found: {schedule_id}"));
            }
            match core.persist_state() {
                Ok(()) => {
                    ControlResponse::ok(json!({ "paused": true, "schedule_id": schedule_id }))
                }
                Err(error) => ControlResponse::err(error.to_string()),
            }
        }
        ControlRequest::ScheduleResume { schedule_id } => {
            if !core.resume_schedule(&schedule_id) {
                return ControlResponse::err(format!(
                    "schedule not found or not paused: {schedule_id}"
                ));
            }
            match core.persist_state() {
                Ok(()) => {
                    ControlResponse::ok(json!({ "resumed": true, "schedule_id": schedule_id }))
                }
                Err(error) => ControlResponse::err(error.to_string()),
            }
        }
        ControlRequest::ScheduleRemove { schedule_id } => {
            if !core.remove_schedule(&schedule_id) {
                return ControlResponse::err(format!("schedule not found: {schedule_id}"));
            }
            match core.persist_state() {
                Ok(()) => {
                    ControlResponse::ok(json!({ "removed": true, "schedule_id": schedule_id }))
                }
                Err(error) => ControlResponse::err(error.to_string()),
            }
        }
        ControlRequest::DeliveryEvidence { intent, baseline } => {
            match core.delivery_evidence(&intent, &baseline) {
                Ok(evidence) => ControlResponse::ok(json!({ "evidence": evidence })),
                Err(error) => ControlResponse::err(error.to_string()),
            }
        }
        ControlRequest::SessionStatus { target } => match core.session_status(&target) {
            Ok(status) => ControlResponse::ok(json!({ "target": target, "status": status })),
            Err(error) => ControlResponse::err(error.to_string()),
        },
        ControlRequest::IntentEvidence { intent_id } => match core.intent_evidence(&intent_id) {
            Ok(record) => ControlResponse::ok(json!({ "intent": record })),
            Err(error) => ControlResponse::err(error.to_string()),
        },
        ControlRequest::RunDueSchedules { now_iso8601 } => {
            let outcomes = core
                .run_due_schedules(&now_iso8601)
                .into_iter()
                .map(|outcome| match outcome {
                    Ok(outcome) => json!({ "ok": true, "outcome": outcome }),
                    Err(error) => json!({ "ok": false, "error": error.to_string() }),
                })
                .collect::<Vec<_>>();
            let failed = outcomes.iter().any(|value| value["ok"] != true);
            if failed {
                ControlResponse::err(
                    serde_json::to_string(&outcomes).unwrap_or_else(|_| {
                        "timer delivery produced at least one error".to_string()
                    }),
                )
            } else {
                ControlResponse::ok(json!({ "outcomes": outcomes }))
            }
        }
        ControlRequest::Shutdown => ControlResponse::ok(json!({ "shutdown": true })),
    }
}

pub struct ControlServer {
    listener: UnixListener,
    socket_path: std::path::PathBuf,
    socket_identity: ControlSocketIdentity,
    core: Arc<Mutex<HooksSidecarCore<AnyAppServerTransport>>>,
}

impl ControlServer {
    pub fn new(socket_path: &Path) -> std::io::Result<Self> {
        Self::with_state(socket_path, None)
    }

    pub fn with_state(socket_path: &Path, state_path: Option<&Path>) -> std::io::Result<Self> {
        let transport = AnyAppServerTransport::Disabled(DisabledTransport);
        let core = match state_path {
            Some(state_path) => HooksSidecarCore::with_state_file(transport, state_path)
                .map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidData, error))?,
            None => HooksSidecarCore::new(transport),
        };
        Ok(Self {
            listener: bind_control_socket(socket_path)?,
            socket_path: socket_path.to_path_buf(),
            socket_identity: control_socket_identity(socket_path).ok_or_else(|| {
                std::io::Error::new(
                    std::io::ErrorKind::NotFound,
                    "bound control socket identity is unavailable",
                )
            })?,
            core: Arc::new(Mutex::new(core)),
        })
    }

    pub fn with_native(socket_path: &Path, appserver_socket: &Path) -> std::io::Result<Self> {
        Self::with_native_and_handlers(socket_path, appserver_socket, None)
    }

    pub fn with_native_and_handlers(
        socket_path: &Path,
        appserver_socket: &Path,
        handlers_config: Option<HookHandlersConfig>,
    ) -> std::io::Result<Self> {
        Self::with_native_sockets_and_handlers(
            socket_path,
            AppServerSocketConfig::single(appserver_socket.to_string_lossy()),
            handlers_config,
        )
    }

    pub fn with_native_sockets_and_handlers(
        socket_path: &Path,
        appserver_sockets: AppServerSocketConfig,
        handlers_config: Option<HookHandlersConfig>,
    ) -> std::io::Result<Self> {
        Self::with_native_sockets_handlers_and_state(
            socket_path,
            appserver_sockets,
            handlers_config,
            None,
        )
    }

    pub fn with_native_sockets_handlers_and_state(
        socket_path: &Path,
        appserver_sockets: AppServerSocketConfig,
        handlers_config: Option<HookHandlersConfig>,
        state_path: Option<&Path>,
    ) -> std::io::Result<Self> {
        let transport = AnyAppServerTransport::Native(NativeAppServerTransport::with_sockets(
            appserver_sockets,
        ));
        Self::with_transport_handlers_and_state(socket_path, transport, handlers_config, state_path)
    }

    /// Select the transport from the actual App Server socket configuration.
    /// Handlers and persisted state are loaded either way, so a handler-only
    /// configuration still mounts its registry instead of silently routing
    /// sends into a native transport that has no socket to reach.
    pub fn with_appserver_sockets_handlers_and_state(
        socket_path: &Path,
        appserver_sockets: AppServerSocketConfig,
        handlers_config: Option<HookHandlersConfig>,
        state_path: Option<&Path>,
    ) -> std::io::Result<Self> {
        let transport = if appserver_sockets.has_any_socket() {
            AnyAppServerTransport::Native(NativeAppServerTransport::with_sockets(appserver_sockets))
        } else {
            AnyAppServerTransport::Disabled(DisabledTransport)
        };
        Self::with_transport_handlers_and_state(socket_path, transport, handlers_config, state_path)
    }

    fn with_transport_handlers_and_state(
        socket_path: &Path,
        transport: AnyAppServerTransport,
        handlers_config: Option<HookHandlersConfig>,
        state_path: Option<&Path>,
    ) -> std::io::Result<Self> {
        let mut core = match state_path {
            Some(state_path) => HooksSidecarCore::with_state_file(transport, state_path)
                .map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidData, error))?,
            None => HooksSidecarCore::new(transport),
        };
        if let Some(config) = handlers_config {
            mount_handlers_from_config(&mut core, &config)
                .map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidData, error))?;
        }
        Ok(Self {
            listener: bind_control_socket(socket_path)?,
            socket_path: socket_path.to_path_buf(),
            socket_identity: control_socket_identity(socket_path).ok_or_else(|| {
                std::io::Error::new(
                    std::io::ErrorKind::NotFound,
                    "bound control socket identity is unavailable",
                )
            })?,
            core: Arc::new(Mutex::new(core)),
        })
    }

    pub fn serve_forever(self) -> std::io::Result<()> {
        self.listener.set_nonblocking(true)?;
        let running = Arc::new(AtomicBool::new(true));
        let timer = {
            let running = Arc::clone(&running);
            let core = Arc::clone(&self.core);
            std::thread::spawn(move || {
                while running.load(Ordering::Relaxed) {
                    std::thread::sleep(Duration::from_secs(TIMER_TICK_INTERVAL_SECS));
                    if !running.load(Ordering::Relaxed) {
                        break;
                    }
                    let mut core = core.lock().expect("hooks sidecar core mutex poisoned");
                    let outcomes = timer_tick(&mut core, &now_iso8601_utc());
                    if !outcomes.is_empty() {
                        eprintln!("rccv3-hooksd timer tick: {outcomes:?}");
                    }
                }
            })
        };
        let mut result = Ok(());
        while running.load(Ordering::Relaxed) {
            match self.listener.accept() {
                Ok((mut stream, _)) => {
                    // The listener is non-blocking so the accept loop can also
                    // drive timers; the accepted connection must go back to
                    // blocking reads for the JSON-lines protocol.
                    if let Err(error) = stream.set_nonblocking(false) {
                        eprintln!("rccv3-hooksd control stream setup failed: {error}");
                        continue;
                    }
                    let core = Arc::clone(&self.core);
                    let running = Arc::clone(&running);
                    std::thread::spawn(move || match serve_connection(&core, &mut stream) {
                        Ok(true) => {}
                        Ok(false) => running.store(false, Ordering::Relaxed),
                        Err(error) => {
                            eprintln!("rccv3-hooksd control connection failed: {error}")
                        }
                    });
                }
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    std::thread::sleep(Duration::from_millis(20));
                }
                Err(error) => {
                    result = Err(error);
                    running.store(false, Ordering::Relaxed);
                }
            }
        }
        let _ = timer.join();
        // The server owns this path. Removing it after the loop exits keeps a
        // clean restart from failing with AddrInUse on a stale socket left by
        // an explicit shutdown. The identity check keeps shutdown from
        // unlinking a replacement socket another process created on the same
        // pathname while this server was running.
        remove_owned_control_socket(&self.socket_path, self.socket_identity)?;
        result
    }
}

fn remove_owned_control_socket(
    socket_path: &Path,
    identity: ControlSocketIdentity,
) -> std::io::Result<()> {
    if control_socket_identity(socket_path) != Some(identity) {
        return Ok(());
    }
    match std::fs::remove_file(socket_path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
    }
}

fn serve_connection<T: AppServerTransport>(
    core: &Arc<Mutex<HooksSidecarCore<T>>>,
    stream: &mut UnixStream,
) -> std::io::Result<bool> {
    let mut reader = BufReader::new(stream.try_clone()?);
    let mut line = String::new();
    loop {
        line.clear();
        let read = reader.read_line(&mut line)?;
        if read == 0 {
            return Ok(true);
        }
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let request: ControlRequest = match serde_json::from_str(trimmed) {
            Ok(request) => request,
            Err(error) => {
                write_control_response(
                    stream,
                    ControlResponse::err(format!("invalid control request: {error}")),
                )?;
                continue;
            }
        };
        let mut core = core.lock().expect("hooks sidecar core mutex poisoned");
        let response = handle_control_request(&mut core, request.clone());
        drop(core);
        write_control_response(stream, response)?;
        if matches!(request, ControlRequest::Shutdown) {
            return Ok(false);
        }
    }
}

fn write_control_response(
    stream: &mut UnixStream,
    response: ControlResponse,
) -> std::io::Result<()> {
    writeln!(stream, "{}", serde_json::to_string(&response)?)?;
    stream.flush()
}

#[cfg(test)]
mod tests {
    use super::*;

    struct ControlStubTransport;

    impl AppServerTransport for ControlStubTransport {
        fn session_status(
            &mut self,
            _target: &SessionTarget,
        ) -> Result<SessionStatus, AppServerError> {
            Ok(SessionStatus {
                state: SessionState::Idle,
                input_active: false,
            })
        }

        fn send_message(
            &mut self,
            intent: &MessageIntent,
        ) -> Result<DeliveryEvidenceRecord, AppServerError> {
            Ok(DeliveryEvidenceRecord {
                intent_id: intent.intent_id.clone(),
                message_id: format!("receipt:{}", intent.intent_id),
                state: DeliveryState::Delivered,
                cursor: None,
                read_item_id: None,
            })
        }

        fn delivery_evidence(
            &mut self,
            intent: &MessageIntent,
            _baseline: &[String],
        ) -> Result<DeliveryEvidenceRecord, AppServerError> {
            Ok(DeliveryEvidenceRecord {
                intent_id: intent.intent_id.clone(),
                message_id: format!("receipt:{}", intent.intent_id),
                state: DeliveryState::Replied,
                cursor: None,
                read_item_id: None,
            })
        }
    }

    fn target(thread_id: &str) -> SessionTarget {
        SessionTarget {
            namespace: Namespace::CodexTui,
            appserver_id: "tui-appserver".to_string(),
            scope_id: format!("local:{thread_id}"),
            session_id: thread_id.to_string(),
            thread_id: thread_id.to_string(),
        }
    }

    #[test]
    fn control_run_due_schedules_sends_back_to_registrant() {
        let mut core = HooksSidecarCore::new(ControlStubTransport);
        core.upsert_schedule(ScheduledMessage {
            id: "timer-control".to_string(),
            at_iso8601: "2026-09-14T09:00:00Z".to_string(),
            registrant: target("a"),
            body: "wake".to_string(),
            send_mode: SendMode::WorkingAllowed,
        })
        .unwrap();
        let response = handle_control_request(
            &mut core,
            ControlRequest::RunDueSchedules {
                now_iso8601: "2026-09-14T10:00:00Z".to_string(),
            },
        );
        assert!(response.ok, "{response:?}");
        let outcomes = response.result.unwrap()["outcomes"].clone();
        assert_eq!(outcomes.as_array().unwrap().len(), 1);
        assert_eq!(outcomes[0]["ok"], true);
        assert_eq!(
            outcomes[0]["outcome"]["sent"]["state"],
            serde_json::json!("delivered")
        );
    }

    #[test]
    fn control_delivery_evidence_returns_native_state() {
        let mut core = HooksSidecarCore::new(ControlStubTransport);
        let intent = MessageIntent {
            intent_id: "intent-control".to_string(),
            source: target("a"),
            target: target("b"),
            body: "probe".to_string(),
            send_mode: SendMode::WorkingAllowed,
        };
        core.forward(intent.clone()).unwrap();
        let response = handle_control_request(
            &mut core,
            ControlRequest::DeliveryEvidence {
                intent: Box::new(intent),
                baseline: Vec::new(),
            },
        );
        assert!(response.ok, "{response:?}");
        let evidence = response.result.unwrap()["evidence"].clone();
        assert_eq!(evidence["state"], serde_json::json!("replied"));
        assert_eq!(
            evidence["message_id"],
            serde_json::json!("receipt:intent-control")
        );
        assert_eq!(evidence["cursor"], serde_json::Value::Null);
    }

    #[test]
    fn control_mount_handler_dispatches_noop_decision() {
        let mut core = HooksSidecarCore::new(ControlStubTransport);
        let mount = ControlRequest::MountHandler {
            handler_id: "stopless-handler".to_string(),
            hook_kind: "stop".to_string(),
            strategy: HookHandlerStrategy::NoOp,
        };
        assert!(handle_control_request(&mut core, mount).ok);

        let response = handle_control_request(
            &mut core,
            ControlRequest::DispatchHookEvent {
                event: Box::new(HookEvent {
                    event_name: "Stop".to_string(),
                    hook_kind: "stop".to_string(),
                    source: None,
                }),
                state: Box::new(HookState {
                    status: "idle".to_string(),
                    detail: None,
                }),
            },
        );
        assert!(response.ok, "{response:?}");
        assert_eq!(
            response.result.unwrap()["decision"],
            serde_json::json!("no_op")
        );
    }

    #[test]
    fn control_server_binds_socket_owner_only() {
        let socket_path = std::path::Path::new("/tmp").join(format!(
            "rccv3-hooksd-mode-{}-{}.sock",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let server = ControlServer::new(&socket_path).expect("bind control socket");
        let mode = std::fs::metadata(&socket_path)
            .expect("control socket metadata")
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(
            mode, 0o600,
            "control socket must be owner-only, not group/other reachable"
        );
        drop(server);
        let _ = std::fs::remove_file(socket_path);
    }

    #[test]
    fn control_server_serves_health_and_shutdown_over_unix_socket() {
        let socket_path = std::path::Path::new("/tmp").join(format!(
            "rccv3-hooksd-{}-{}.sock",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let server_path = socket_path.clone();
        let server = std::thread::spawn(move || {
            ControlServer::new(&server_path)
                .expect("bind control socket")
                .serve_forever()
                .expect("serve control requests")
        });

        // The socket inode can appear just before the listener accepts
        // connections, so retry the connect under bounded load instead of
        // assuming the first attempt after bind succeeds.
        let mut stream = None;
        for _ in 0..100 {
            match UnixStream::connect(&socket_path) {
                Ok(connected) => {
                    stream = Some(connected);
                    break;
                }
                Err(error)
                    if matches!(
                        error.kind(),
                        std::io::ErrorKind::ConnectionRefused | std::io::ErrorKind::NotFound
                    ) =>
                {
                    std::thread::sleep(std::time::Duration::from_millis(10));
                }
                Err(error) => panic!("connect to control socket: {error}"),
            }
        }
        let mut stream = stream.expect("connect to control socket within bounded retries");
        writeln!(stream, "{{\"method\":\"health\"}}").unwrap();
        let mut response = String::new();
        BufReader::new(stream.try_clone().unwrap())
            .read_line(&mut response)
            .unwrap();
        let health: ControlResponse = serde_json::from_str(&response).unwrap();
        assert!(health.ok);
        assert_eq!(health.result.unwrap()["status"], "ok");

        writeln!(stream, "{{\"method\":\"shutdown\"}}").unwrap();
        let mut shutdown_response = String::new();
        BufReader::new(stream.try_clone().unwrap())
            .read_line(&mut shutdown_response)
            .unwrap();
        let shutdown: ControlResponse = serde_json::from_str(&shutdown_response).unwrap();
        assert!(shutdown.ok);

        server
            .join()
            .expect("control server should exit gracefully");
        // A graceful shutdown must not leave the owned socket behind: the next
        // daemon binds the same path without external cleanup.
        assert!(
            !socket_path.exists(),
            "shutdown must remove the owned control socket"
        );
        ControlServer::new(&socket_path).expect("rebind after shutdown");
        let rebound = std::fs::metadata(&socket_path);
        assert!(rebound.is_ok(), "rebound control socket must exist");
        let _ = std::fs::remove_file(socket_path);
    }

    #[test]
    fn control_server_shutdown_never_unlinks_a_replacement_socket() {
        let socket_path = std::path::Path::new("/tmp").join(format!(
            "rccv3-hooksd-replaced-{}-{}.sock",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let server_path = socket_path.clone();
        let server = std::thread::spawn(move || {
            ControlServer::new(&server_path)
                .expect("bind control socket")
                .serve_forever()
                .expect("serve control requests")
        });

        let mut stream = None;
        for _ in 0..100 {
            match UnixStream::connect(&socket_path) {
                Ok(connected) => {
                    stream = Some(connected);
                    break;
                }
                Err(error)
                    if matches!(
                        error.kind(),
                        std::io::ErrorKind::ConnectionRefused | std::io::ErrorKind::NotFound
                    ) =>
                {
                    std::thread::sleep(std::time::Duration::from_millis(10));
                }
                Err(error) => panic!("connect to control socket: {error}"),
            }
        }
        let mut stream = stream.expect("connect to control socket within bounded retries");

        // Replace the pathname with a different socket while the daemon runs.
        std::fs::remove_file(&socket_path).expect("remove original socket path");
        let replacement = UnixListener::bind(&socket_path).expect("bind replacement socket");
        let replacement_identity =
            std::fs::symlink_metadata(&socket_path).expect("replacement metadata");

        writeln!(stream, "{{\"method\":\"shutdown\"}}").unwrap();
        let mut shutdown_response = String::new();
        BufReader::new(stream.try_clone().unwrap())
            .read_line(&mut shutdown_response)
            .unwrap();
        let shutdown: ControlResponse = serde_json::from_str(&shutdown_response).unwrap();
        assert!(shutdown.ok);
        server
            .join()
            .expect("control server should exit gracefully");

        let after = std::fs::symlink_metadata(&socket_path).expect("replacement must survive");
        assert_eq!(
            after.ino(),
            replacement_identity.ino(),
            "shutdown must not unlink a replacement socket"
        );
        drop(replacement);
        let _ = std::fs::remove_file(socket_path);
    }

    #[test]
    fn control_server_refuses_to_hijack_live_socket() {
        let socket_path = std::path::Path::new("/tmp").join(format!(
            "rccv3-hooksd-live-{}-{}.sock",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let server_path = socket_path.clone();
        let server = std::thread::spawn(move || {
            ControlServer::new(&server_path)
                .expect("bind control socket")
                .serve_forever()
                .expect("serve control requests")
        });

        // Wait until a connection is accepted so the first daemon is provably
        // live, then assert a second daemon cannot unlink and rebind the path.
        let mut stream = None;
        for _ in 0..100 {
            match UnixStream::connect(&socket_path) {
                Ok(connected) => {
                    stream = Some(connected);
                    break;
                }
                Err(error)
                    if matches!(
                        error.kind(),
                        std::io::ErrorKind::ConnectionRefused | std::io::ErrorKind::NotFound
                    ) =>
                {
                    std::thread::sleep(std::time::Duration::from_millis(10));
                }
                Err(error) => panic!("connect to control socket: {error}"),
            }
        }
        let mut stream = stream.expect("first daemon should accept a connection");

        let second = ControlServer::new(&socket_path);
        assert!(
            second.is_err(),
            "second daemon must not hijack a live control socket"
        );
        assert_eq!(second.err().unwrap().kind(), std::io::ErrorKind::AddrInUse);

        // The first daemon's socket inode must be untouched by the refused
        // bind, so its own listener still owns the advertised path.
        assert!(socket_path.exists());

        // The original daemon remains reachable on the same path.
        writeln!(stream, "{{\"method\":\"health\"}}").unwrap();
        let mut response = String::new();
        BufReader::new(stream.try_clone().unwrap())
            .read_line(&mut response)
            .unwrap();
        let health: ControlResponse = serde_json::from_str(&response).unwrap();
        assert!(health.ok);
        assert_eq!(health.result.unwrap()["status"], "ok");

        writeln!(stream, "{{\"method\":\"shutdown\"}}").unwrap();
        let mut shutdown_response = String::new();
        BufReader::new(stream.try_clone().unwrap())
            .read_line(&mut shutdown_response)
            .unwrap();
        let shutdown: ControlResponse = serde_json::from_str(&shutdown_response).unwrap();
        assert!(shutdown.ok);

        server
            .join()
            .expect("control server should exit gracefully");
        let _ = std::fs::remove_file(socket_path);
    }

    #[test]
    fn control_mounted_handler_survives_state_restart() {
        let state_path = std::path::Path::new("/tmp").join(format!(
            "rccv3-hooksd-state-{}-{}.json",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        {
            let mut core = HooksSidecarCore::with_state_file(DisabledTransport, &state_path)
                .expect("load empty state");
            let mount = ControlRequest::MountHandler {
                handler_id: "stopless-handler".to_string(),
                hook_kind: "stop".to_string(),
                strategy: HookHandlerStrategy::NoOp,
            };
            assert!(handle_control_request(&mut core, mount).ok);
        }

        // After restart from the persisted state, the handler mounted through
        // the control path must dispatch, not fail closed with NoHandler.
        let mut restarted = HooksSidecarCore::with_state_file(DisabledTransport, &state_path)
            .expect("restore persisted state");
        let response = handle_control_request(
            &mut restarted,
            ControlRequest::DispatchHookEvent {
                event: Box::new(HookEvent {
                    event_name: "Stop".to_string(),
                    hook_kind: "stop".to_string(),
                    source: None,
                }),
                state: Box::new(HookState {
                    status: "idle".to_string(),
                    detail: None,
                }),
            },
        );
        assert!(response.ok, "{response:?}");
        assert_eq!(
            response.result.unwrap()["decision"],
            serde_json::json!("no_op")
        );
        let _ = std::fs::remove_file(state_path);
    }
}
