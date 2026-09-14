//! End-to-end replay of the `rccv3-hooksd` control + native transport path.
//!
//! This test stands up a mock App Server on a real Unix socket that speaks the
//! same WebSocket JSON-RPC protocol as the Codex default App Server. It is a
//! protocol fixture, not a self-hosted App Server: production still talks only
//! to the Codex default TUI/Desktop App Server.

use routecodex_v3_hooks::{
    AppServerTransport, ControlRequest, ControlResponse, ControlServer, HooksSidecarCore,
    MessageIntent, Namespace, NativeAppServerTransport, ScheduledMessage, SendMode, SessionTarget,
};
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Read, Write};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Default)]
struct MockAppServerState {
    accepted: Vec<(String, String)>,
}

#[derive(Default)]
struct MockAppServerOptions {
    thread_status: Option<Value>,
    read_include_turns_error: Option<Value>,
    items_error: Option<Value>,
    turns_error: Option<Value>,
    read_turns_from_accepted: bool,
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

fn unique_socket(label: &str) -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos()
        % 1_000_000_000;
    // Unix-domain sockets are limited to ~104 bytes; keep the path short.
    PathBuf::from("/tmp").join(format!(
        "rcc-hk-{label}-{}-{nanos}.sock",
        std::process::id()
    ))
}

#[test]
fn native_transport_resolves_receipt_and_reply_over_unix_websocket() {
    let socket_path = unique_socket("appserver");
    let listener = UnixListener::bind(&socket_path).unwrap();
    let state = Arc::new(Mutex::new(MockAppServerState::default()));
    let stop = Arc::new(AtomicBool::new(false));
    let server = spawn_mock_app_server(listener, Arc::clone(&state), Arc::clone(&stop));

    let mut transport = NativeAppServerTransport::new(socket_path.to_string_lossy());
    let intent = MessageIntent {
        intent_id: "intent-native-1".to_string(),
        source: target("source"),
        target: target("target"),
        body: "probe".to_string(),
        send_mode: SendMode::WorkingAllowed,
    };
    let accepted = transport.send_message(&intent).unwrap();
    assert_eq!(accepted.state, routecodex_v3_hooks::DeliveryState::Accepted);

    let evidence = transport.delivery_evidence(&intent, &[]).unwrap();
    assert_eq!(evidence.intent_id, "intent-native-1");
    assert_eq!(evidence.state, routecodex_v3_hooks::DeliveryState::Read);
    assert_eq!(evidence.read_item_id.as_deref(), Some("reply-1"));
    assert_eq!(evidence.cursor.as_deref(), Some("cursor-1"));

    stop.store(true, Ordering::Relaxed);
    server.join().unwrap();
    let _ = std::fs::remove_file(&socket_path);
}

#[test]
fn native_transport_allows_unmaterialized_first_send_with_empty_baseline() {
    let socket_path = unique_socket("empty-baseline");
    let listener = UnixListener::bind(&socket_path).unwrap();
    let state = Arc::new(Mutex::new(MockAppServerState::default()));
    let stop = Arc::new(AtomicBool::new(false));
    let options = MockAppServerOptions {
        thread_status: Some(json!({ "type": "idle" })),
        read_include_turns_error: None,
        items_error: Some(json!({
            "code": -32601,
            "message": "thread/items/list is not supported yet"
        })),
        turns_error: Some(json!({
            "code": -32601,
            "message": "thread thread-1 is not materialized yet; thread/turns/list is unavailable before first user message"
        })),
        read_turns_from_accepted: false,
    };
    let server = spawn_mock_app_server_with_options(
        listener,
        Arc::clone(&state),
        Arc::clone(&stop),
        options,
    );

    let mut transport = NativeAppServerTransport::new(socket_path.to_string_lossy());
    let intent = MessageIntent {
        intent_id: "empty-baseline-intent".to_string(),
        source: target("source"),
        target: target("target"),
        body: "probe".to_string(),
        send_mode: SendMode::WorkingAllowed,
    };
    let accepted = transport.send_message(&intent).unwrap();
    assert_eq!(accepted.state, routecodex_v3_hooks::DeliveryState::Accepted);
    assert_eq!(
        state.lock().unwrap().accepted,
        vec![("target".to_string(), "empty-baseline-intent".to_string())]
    );

    stop.store(true, Ordering::Relaxed);
    server.join().unwrap();
    let _ = std::fs::remove_file(&socket_path);
}

#[test]
fn native_transport_uses_thread_read_turns_when_history_lists_are_unsupported() {
    let socket_path = unique_socket("read-turns");
    let listener = UnixListener::bind(&socket_path).unwrap();
    let state = Arc::new(Mutex::new(MockAppServerState::default()));
    let stop = Arc::new(AtomicBool::new(false));
    let options = MockAppServerOptions {
        items_error: Some(json!({
            "code": -32601,
            "message": "thread/items/list is not supported yet"
        })),
        turns_error: Some(json!({
            "code": -32601,
            "message": "thread/turns/list is not supported yet"
        })),
        read_turns_from_accepted: true,
        ..MockAppServerOptions::default()
    };
    let server = spawn_mock_app_server_with_options(
        listener,
        Arc::clone(&state),
        Arc::clone(&stop),
        options,
    );

    let mut transport = NativeAppServerTransport::new(socket_path.to_string_lossy());
    let intent = MessageIntent {
        intent_id: "read-turns-intent".to_string(),
        source: target("source"),
        target: target("target"),
        body: "probe".to_string(),
        send_mode: SendMode::WorkingAllowed,
    };
    let accepted = transport.send_message(&intent).unwrap();
    assert_eq!(accepted.state, routecodex_v3_hooks::DeliveryState::Accepted);
    let evidence = transport.delivery_evidence(&intent, &[]).unwrap();
    assert_eq!(evidence.state, routecodex_v3_hooks::DeliveryState::Replied);
    assert!(evidence.read_item_id.is_none());
    assert!(evidence.cursor.is_none());

    stop.store(true, Ordering::Relaxed);
    server.join().unwrap();
    let _ = std::fs::remove_file(&socket_path);
}

#[test]
fn native_transport_falls_back_to_history_lists_when_thread_read_turns_is_unsupported() {
    let socket_path = unique_socket("read-turns-fallback");
    let listener = UnixListener::bind(&socket_path).unwrap();
    let state = Arc::new(Mutex::new(MockAppServerState::default()));
    let stop = Arc::new(AtomicBool::new(false));
    let options = MockAppServerOptions {
        read_include_turns_error: Some(json!({
            "code": -32601,
            "message": "list_turns is not supported yet"
        })),
        ..MockAppServerOptions::default()
    };
    let server = spawn_mock_app_server_with_options(
        listener,
        Arc::clone(&state),
        Arc::clone(&stop),
        options,
    );

    let mut transport = NativeAppServerTransport::new(socket_path.to_string_lossy());
    let intent = MessageIntent {
        intent_id: "read-turns-fallback-intent".to_string(),
        source: target("source"),
        target: target("target"),
        body: "probe".to_string(),
        send_mode: SendMode::WorkingAllowed,
    };
    let accepted = transport.send_message(&intent).unwrap();
    assert_eq!(accepted.state, routecodex_v3_hooks::DeliveryState::Accepted);
    assert_eq!(
        state.lock().unwrap().accepted,
        vec![(
            "target".to_string(),
            "read-turns-fallback-intent".to_string()
        )]
    );
    let evidence = transport.delivery_evidence(&intent, &[]).unwrap();
    assert_eq!(evidence.state, routecodex_v3_hooks::DeliveryState::Read);
    assert_eq!(evidence.read_item_id.as_deref(), Some("reply-1"));
    assert_eq!(evidence.cursor.as_deref(), Some("cursor-1"));

    stop.store(true, Ordering::Relaxed);
    server.join().unwrap();
    let _ = std::fs::remove_file(&socket_path);
}

#[test]
fn timer_fires_through_core_and_sends_back_to_registrant() {
    let socket_path = unique_socket("timer");
    let listener = UnixListener::bind(&socket_path).unwrap();
    let state = Arc::new(Mutex::new(MockAppServerState::default()));
    let stop = Arc::new(AtomicBool::new(false));
    let server = spawn_mock_app_server(listener, Arc::clone(&state), Arc::clone(&stop));

    let mut core =
        HooksSidecarCore::new(NativeAppServerTransport::new(socket_path.to_string_lossy()));
    core.upsert_schedule(routecodex_v3_hooks::ScheduledMessage {
        id: "timer-native-1".to_string(),
        at_iso8601: "2026-09-14T09:00:00Z".to_string(),
        registrant: target("target"),
        body: "wake".to_string(),
        send_mode: SendMode::IdleOnly,
    })
    .unwrap();
    let outcomes = core.run_due_schedules("2026-09-14T10:00:00Z");
    assert_eq!(outcomes.len(), 1);
    match outcomes.into_iter().next().unwrap().unwrap() {
        routecodex_v3_hooks::DispatchOutcome::Sent(evidence) => {
            assert_eq!(
                evidence.intent_id,
                "timer:timer-native-1:2026-09-14T09:00:00Z"
            );
        }
        other => panic!("expected timer send, got {other:?}"),
    }

    stop.store(true, Ordering::Relaxed);
    server.join().unwrap();
    let _ = std::fs::remove_file(&socket_path);
}

#[test]
fn control_server_timer_tick_sends_due_schedule_to_native_transport() {
    let appserver_socket = unique_socket("timer-control-appserver");
    let control_socket = unique_socket("timer-control");
    let listener = UnixListener::bind(&appserver_socket).unwrap();
    let appserver_state = Arc::new(Mutex::new(MockAppServerState::default()));
    let appserver_stop = Arc::new(AtomicBool::new(false));
    let appserver = spawn_mock_app_server(
        listener,
        Arc::clone(&appserver_state),
        Arc::clone(&appserver_stop),
    );
    let server = ControlServer::with_native(&control_socket, &appserver_socket).unwrap();
    let control_thread = thread::spawn(move || server.serve_forever().unwrap());
    wait_for_socket(&control_socket);

    let mut stream = UnixStream::connect(&control_socket).unwrap();
    let schedule = ControlRequest::ScheduleUpsert {
        schedule: Box::new(ScheduledMessage {
            id: "control-timer-1".to_string(),
            at_iso8601: "2000-01-01T00:00:00Z".to_string(),
            registrant: target("target"),
            body: "wake".to_string(),
            send_mode: SendMode::IdleOnly,
        }),
    };
    writeln!(stream, "{}", serde_json::to_string(&schedule).unwrap()).unwrap();
    let mut reader = BufReader::new(stream.try_clone().unwrap());
    let mut line = String::new();
    reader.read_line(&mut line).unwrap();
    let response: ControlResponse = serde_json::from_str(&line).unwrap();
    assert!(response.ok, "{response:?}");

    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    loop {
        let accepted = appserver_state.lock().unwrap().accepted.clone();
        assert!(
            std::time::Instant::now() < deadline,
            "timer tick did not send due schedule to native transport"
        );
        if accepted
            .iter()
            .any(|(_, client_id)| client_id.starts_with("timer:control-timer-1"))
        {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(50));
    }

    writeln!(stream, "{{\"method\":\"shutdown\"}}").unwrap();
    let mut line = String::new();
    reader.read_line(&mut line).unwrap();
    let response: ControlResponse = serde_json::from_str(&line).unwrap();
    assert!(response.ok, "{response:?}");

    control_thread.join().unwrap();
    appserver_stop.store(true, Ordering::Relaxed);
    appserver.join().unwrap();
    let _ = std::fs::remove_file(&control_socket);
    let _ = std::fs::remove_file(&appserver_socket);
}

fn wait_for_socket(path: &std::path::Path) {
    for _ in 0..100 {
        if path.exists() {
            return;
        }
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    panic!("socket did not appear: {}", path.display());
}

fn spawn_mock_app_server(
    listener: UnixListener,
    state: Arc<Mutex<MockAppServerState>>,
    stop: Arc<AtomicBool>,
) -> thread::JoinHandle<()> {
    spawn_mock_app_server_with_options(listener, state, stop, MockAppServerOptions::default())
}

fn spawn_mock_app_server_with_options(
    listener: UnixListener,
    state: Arc<Mutex<MockAppServerState>>,
    stop: Arc<AtomicBool>,
    options: MockAppServerOptions,
) -> thread::JoinHandle<()> {
    listener.set_nonblocking(true).unwrap();
    thread::spawn(move || {
        let mut workers = Vec::new();
        while !stop.load(Ordering::Relaxed) {
            match listener.accept() {
                Ok((stream, _)) => {
                    stream.set_nonblocking(false).unwrap();
                    let state = Arc::clone(&state);
                    let options = MockAppServerOptions {
                        thread_status: options.thread_status.clone(),
                        read_include_turns_error: options.read_include_turns_error.clone(),
                        items_error: options.items_error.clone(),
                        turns_error: options.turns_error.clone(),
                        read_turns_from_accepted: options.read_turns_from_accepted,
                    };
                    workers.push(thread::spawn(move || {
                        serve_mock_app_server(stream, state, options)
                    }));
                }
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    thread::sleep(std::time::Duration::from_millis(5));
                }
                Err(error) => panic!("mock App Server accept failed: {error}"),
            }
        }
        for worker in workers {
            let _ = worker.join();
        }
    })
}

fn serve_mock_app_server(
    mut stream: UnixStream,
    state: Arc<Mutex<MockAppServerState>>,
    options: MockAppServerOptions,
) {
    upgrade_websocket(&mut stream);
    let mut reader = BufReader::new(stream.try_clone().unwrap());
    loop {
        let Some(frame) = read_client_frame(&mut reader) else {
            return;
        };
        if frame.opcode == 0x8 {
            return;
        }
        if frame.opcode != 0x1 {
            continue;
        }
        let request: Value = serde_json::from_slice(&frame.payload).unwrap();
        let method = request["method"].as_str().unwrap_or_default();
        let Some(id) = request.get("id").and_then(Value::as_u64) else {
            // Notification (for example `initialized`): no response.
            continue;
        };
        let response = match method {
            "initialize" => json!({ "result": { "userAgent": "mock-app-server" } }),
            "thread/read" => {
                if request["params"]
                    .get("includeTurns")
                    .and_then(Value::as_bool)
                    == Some(true)
                {
                    if let Some(error) = options.read_include_turns_error.clone() {
                        let mut response = json!({ "error": error });
                        response["id"] = json!(id);
                        write_server_frame(&mut stream, &response.to_string());
                        continue;
                    }
                }
                let mut thread = json!({
                    "id": request["params"]["threadId"],
                    "status": options.thread_status.clone().unwrap_or_else(|| json!({ "type": "idle" })),
                    "turns": []
                });
                if options.read_turns_from_accepted
                    && request["params"]
                        .get("includeTurns")
                        .and_then(Value::as_bool)
                        == Some(true)
                {
                    let accepted = state.lock().unwrap().accepted.clone();
                    let mut turns = vec![json!({
                        "id": "baseline-turn",
                        "status": "completed",
                        "items": [
                            {
                                "id": "baseline-item",
                                "type": "userMessage",
                                "clientUserMessageId": "baseline-client-id",
                                "text": "baseline"
                            }
                        ]
                    })];
                    turns.extend(accepted.iter().map(|(_, client_id)| {
                        json!({
                            "id": format!("turn-{client_id}"),
                            "status": "completed",
                            "items": [
                                {
                                    "id": format!("receipt-{client_id}"),
                                    "type": "userMessage",
                                    "clientUserMessageId": client_id,
                                    "text": "probe"
                                },
                                {
                                    "id": format!("reply-{client_id}"),
                                    "type": "agentMessage",
                                    "text": "reply"
                                }
                            ]
                        })
                    }));
                    thread["turns"] = Value::Array(turns);
                }
                json!({ "result": { "thread": thread } })
            }
            "thread/loaded/list" => json!({ "result": { "data": ["target"] } }),
            "thread/queue/add" => {
                let thread_id = request["params"]["threadId"].as_str().unwrap().to_string();
                let client_id = request["params"]["clientUserMessageId"]
                    .as_str()
                    .unwrap()
                    .to_string();
                state
                    .lock()
                    .unwrap()
                    .accepted
                    .push((thread_id, client_id.clone()));
                json!({ "result": { "queuedSubmission": { "clientUserMessageId": client_id } } })
            }
            "thread/items/list" => {
                if let Some(error) = options.items_error.clone() {
                    json!({ "error": error })
                } else {
                    let accepted = state.lock().unwrap().accepted.clone();
                    let data = accepted
                        .iter()
                        .flat_map(|(_, client_id)| {
                            [
                                json!({
                                    "item": {
                                        "id": format!("receipt-{client_id}"),
                                        "type": "userMessage",
                                        "clientUserMessageId": client_id,
                                        "text": "probe"
                                    },
                                    "turnId": "turn-1"
                                }),
                                json!({
                                    "item": {
                                        "id": "reply-1",
                                        "type": "agentMessage",
                                        "text": "reply"
                                    },
                                    "turnId": "turn-1"
                                }),
                            ]
                        })
                        .collect::<Vec<_>>();
                    json!({ "result": { "data": data, "nextCursor": "cursor-1" } })
                }
            }
            "thread/turns/list" => {
                if let Some(error) = options.turns_error.clone() {
                    json!({ "error": error })
                } else {
                    json!({ "result": { "data": [], "nextCursor": null } })
                }
            }
            other => panic!("unexpected mock App Server method: {other}"),
        };
        let mut response = response;
        response["id"] = json!(id);
        write_server_frame(&mut stream, &response.to_string());
    }
}

struct ClientFrame {
    opcode: u8,
    payload: Vec<u8>,
}

fn read_client_frame(reader: &mut BufReader<UnixStream>) -> Option<ClientFrame> {
    let mut first = [0_u8; 2];
    reader.read_exact(&mut first).ok()?;
    let opcode = first[0] & 0x0f;
    let masked = first[1] & 0x80 != 0;
    let mut len = (first[1] & 0x7f) as usize;
    if len == 126 {
        let mut extended = [0_u8; 2];
        reader.read_exact(&mut extended).ok()?;
        len = u16::from_be_bytes(extended) as usize;
    } else if len == 127 {
        let mut extended = [0_u8; 8];
        reader.read_exact(&mut extended).ok()?;
        len = u64::from_be_bytes(extended) as usize;
    }
    let mask = if masked {
        let mut key = [0_u8; 4];
        reader.read_exact(&mut key).ok()?;
        Some(key)
    } else {
        None
    };
    let mut payload = vec![0_u8; len];
    reader.read_exact(&mut payload).ok()?;
    if let Some(key) = mask {
        for (index, byte) in payload.iter_mut().enumerate() {
            *byte ^= key[index % 4];
        }
    }
    Some(ClientFrame { opcode, payload })
}

fn write_server_frame(stream: &mut UnixStream, payload: &str) {
    let bytes = payload.as_bytes();
    let mut header = vec![0x81];
    let len = bytes.len();
    if len < 126 {
        header.push(len as u8);
    } else if len < 65_536 {
        header.push(126);
        header.extend_from_slice(&(len as u16).to_be_bytes());
    } else {
        header.push(127);
        header.extend_from_slice(&(len as u64).to_be_bytes());
    }
    stream.write_all(&header).unwrap();
    stream.write_all(bytes).unwrap();
    stream.flush().unwrap();
}

fn upgrade_websocket(stream: &mut UnixStream) {
    let mut reader = BufReader::new(stream.try_clone().unwrap());
    let mut request = String::new();
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line).unwrap() == 0 {
            return;
        }
        request.push_str(&line);
        if line == "\r\n" || line == "\n" {
            break;
        }
    }
    let response = concat!(
        "HTTP/1.1 101 Switching Protocols\r\n",
        "Upgrade: websocket\r\n",
        "Connection: Upgrade\r\n",
        "Sec-WebSocket-Accept: c3R1YmJlZA==\r\n\r\n"
    );
    stream.write_all(response.as_bytes()).unwrap();
    stream.flush().unwrap();
}
