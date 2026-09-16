use routecodex_v3_hooks::{ControlRequest, ControlResponse, HookEvent, HookState};
use serde_json::Value;
use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

fn unique_path(label: &str) -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    std::env::temp_dir().join(format!("rcc-hk-{label}-{}-{nanos}", std::process::id()))
}

fn unique_socket(label: &str) -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    PathBuf::from("/tmp").join(format!(
        "rcc-hk-{label}-{}-{nanos}.sock",
        std::process::id()
    ))
}

fn send_request(stream: &mut UnixStream, request: &ControlRequest) -> ControlResponse {
    writeln!(stream, "{}", serde_json::to_string(request).unwrap()).unwrap();
    let mut line = String::new();
    BufReader::new(stream.try_clone().unwrap())
        .read_line(&mut line)
        .unwrap();
    serde_json::from_str(&line).unwrap()
}

fn wait_for_socket(path: &std::path::Path) {
    let deadline = Instant::now() + Duration::from_secs(5);
    while Instant::now() < deadline {
        if path.exists() {
            return;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    panic!("socket did not appear: {}", path.display());
}

#[test]
fn binary_loads_mounted_handler_config_and_fails_closed_for_unknown_hook() {
    let control_socket = unique_socket("handler-control");
    let handlers_config = unique_path("handlers.json");
    std::fs::write(
        &handlers_config,
        r#"{"schema_version":1,"handlers":[{"handler_id":"stopless-handler","hook_kind":"stop","strategy":{"type":"no_op"}}]}"#,
    )
    .unwrap();

    let mut child = Command::new(env!("CARGO_BIN_EXE_rccv3-hooksd"))
        .arg("--socket")
        .arg(&control_socket)
        .arg("--handlers-config")
        .arg(&handlers_config)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("rccv3-hooksd should start");
    let stdout = child.stdout.take().expect("sidecar stdout");
    let mut readiness_line = String::new();
    BufReader::new(stdout)
        .read_line(&mut readiness_line)
        .expect("read readiness");
    let readiness: Value = serde_json::from_str(&readiness_line).unwrap();
    assert_eq!(readiness["protocol"], "rcc-hooks-sidecar/v1");
    assert_eq!(readiness["ready"], true);

    wait_for_socket(&control_socket);
    let mut stream = UnixStream::connect(&control_socket).unwrap();
    let mounted = send_request(
        &mut stream,
        &ControlRequest::DispatchHookEvent {
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
    assert!(mounted.ok, "{mounted:?}");
    assert_eq!(
        mounted.result.unwrap()["decision"],
        serde_json::json!("no_op")
    );

    let unknown = send_request(
        &mut stream,
        &ControlRequest::DispatchHookEvent {
            event: Box::new(HookEvent {
                event_name: "Unknown".to_string(),
                hook_kind: "unknown".to_string(),
                source: None,
            }),
            state: Box::new(HookState {
                status: "idle".to_string(),
                detail: None,
            }),
        },
    );
    assert!(!unknown.ok, "{unknown:?}");
    assert!(unknown.error.unwrap().contains("no handler mounted"));

    let shutdown = send_request(&mut stream, &ControlRequest::Shutdown);
    assert!(shutdown.ok, "{shutdown:?}");
    let status = child.wait().unwrap();
    assert!(status.success(), "{status:?}");
    let _ = std::fs::remove_file(control_socket);
    let _ = std::fs::remove_file(handlers_config);
}

#[test]
fn binary_handler_only_config_has_no_native_socket_and_fails_closed_on_send() {
    let control_socket = unique_socket("handler-only-control");
    let handlers_config = unique_path("handler-only-handlers.json");
    // A command handler that returns a send decision. With no App Server
    // socket configured, the dispatch must fail closed instead of reporting a
    // successful send through a native transport that cannot reach anything.
    let decision = serde_json::json!({
        "send_message": {
            "intent_id": "handler-only-send",
            "source": {
                "namespace": "codex_tui",
                "appserver_id": "tui",
                "scope_id": "default",
                "session_id": "a",
                "thread_id": "a"
            },
            "target": {
                "namespace": "codex_tui",
                "appserver_id": "tui",
                "scope_id": "default",
                "session_id": "b",
                "thread_id": "b"
            },
            "body": "ping",
            "send_mode": "idle_only"
        }
    });
    let handlers = serde_json::json!({
        "schema_version": 1,
        "handlers": [{
            "handler_id": "handler-only",
            "hook_kind": "stop",
            "strategy": {
                "type": "command",
                "command": "/bin/sh",
                "args": ["-c", format!("cat >/dev/null; printf %s '{decision}'")]
            }
        }]
    });
    std::fs::write(&handlers_config, handlers.to_string()).unwrap();

    let mut child = Command::new(env!("CARGO_BIN_EXE_rccv3-hooksd"))
        .arg("--socket")
        .arg(&control_socket)
        .arg("--handlers-config")
        .arg(&handlers_config)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("rccv3-hooksd should start");
    let stdout = child.stdout.take().expect("sidecar stdout");
    let mut readiness_line = String::new();
    BufReader::new(stdout)
        .read_line(&mut readiness_line)
        .expect("read readiness");
    let readiness: Value = serde_json::from_str(&readiness_line).unwrap();
    assert_eq!(readiness["ready"], true);

    wait_for_socket(&control_socket);
    let mut stream = UnixStream::connect(&control_socket).unwrap();
    let dispatch = send_request(
        &mut stream,
        &ControlRequest::DispatchHookEvent {
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
    assert!(
        !dispatch.ok,
        "handler-only config must fail closed on send, got {dispatch:?}"
    );
    assert!(
        dispatch.error.unwrap().contains("socket"),
        "error should name the missing App Server socket"
    );

    let shutdown = send_request(&mut stream, &ControlRequest::Shutdown);
    assert!(shutdown.ok, "{shutdown:?}");
    let status = child.wait().unwrap();
    assert!(status.success(), "{status:?}");
    let _ = std::fs::remove_file(control_socket);
    let _ = std::fs::remove_file(handlers_config);
}

#[test]
fn binary_handler_config_invalid_schema_fails_before_readiness() {
    let control_socket = unique_socket("invalid-handler-control");
    let handlers_config = unique_path("invalid-handlers.json");
    std::fs::write(&handlers_config, r#"{"schema_version":2,"handlers":[]}"#).unwrap();

    let mut child = Command::new(env!("CARGO_BIN_EXE_rccv3-hooksd"))
        .arg("--socket")
        .arg(&control_socket)
        .arg("--handlers-config")
        .arg(&handlers_config)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let status = child.wait().unwrap();
    assert!(!status.success());
    let mut stderr = String::new();
    use std::io::Read;
    child
        .stderr
        .take()
        .unwrap()
        .read_to_string(&mut stderr)
        .unwrap();
    assert!(
        stderr.contains("unsupported hooks handlers config schema version"),
        "{stderr}"
    );
    assert!(!control_socket.exists());
    let _ = std::fs::remove_file(handlers_config);
}
