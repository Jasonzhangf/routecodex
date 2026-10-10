//! Actual Direct Responses listener -> controlled WebSocketV2 provider.
//! The nondefault configured interval includes handshake and semantic output.

#[path = "../../../crates/routecodex-v3-runtime/tests/support/hub_v1_fixture.rs"]
mod hub_v1_fixture;
#[path = "../../../crates/routecodex-v3-runtime/tests/support/test_ports.rs"]
mod test_ports;

use futures_util::{SinkExt, StreamExt};
use routecodex_v3_config::{compile_v3_config_05_manifest, parse_v3_config_02_authoring};
use routecodex_v3_server::spawn_v3_server_aggregate;
use serde_json::{json, Value};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use tokio::{
    net::TcpListener,
    time::{sleep, timeout, Duration, Instant},
};
use tokio_tungstenite::{
    accept_hdr_async,
    tungstenite::{
        handshake::server::{Request, Response},
        Message,
    },
};

static TEST_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
const FIRST_WORD_MS: u64 = 500;

struct IsolatedHome {
    path: std::path::PathBuf,
    previous: Option<std::ffi::OsString>,
}
impl IsolatedHome {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "rcc-ws-first-word-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&path).unwrap();
        let previous = std::env::var_os("HOME");
        std::env::set_var("HOME", &path);
        Self { path, previous }
    }
}
impl Drop for IsolatedHome {
    fn drop(&mut self) {
        match &self.previous {
            Some(previous) => std::env::set_var("HOME", previous),
            None => std::env::remove_var("HOME"),
        }
        let _ = std::fs::remove_dir_all(&self.path);
    }
}

async fn run_case(late_first_word: bool) {
    let _guard = TEST_LOCK.lock().await;
    let home = IsolatedHome::new();
    let provider = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let provider_addr = provider.local_addr().unwrap();
    let terminal_sent = Arc::new(AtomicBool::new(false));
    let peer_terminal = terminal_sent.clone();
    let websocket_request_seen = Arc::new(AtomicBool::new(false));
    let peer_request_seen = websocket_request_seen.clone();
    let peer = tokio::spawn(async move {
        let (tcp, _) = provider.accept().await.unwrap();
        // Receiving upgrade headers is transport progress, not semantic output.
        sleep(Duration::from_millis(if late_first_word {
            300
        } else {
            150
        }))
        .await;
        let mut socket = accept_hdr_async(tcp, |request: &Request, response: Response| {
            assert_eq!(request.uri().path(), "/v1/responses");
            assert_eq!(
                request.headers()["authorization"],
                "Bearer ws-first-word-secret"
            );
            assert_eq!(
                request.headers()["openai-beta"],
                "responses_websockets=2026-02-06"
            );
            Ok(response)
        })
        .await
        .unwrap();
        let request = socket.next().await.unwrap().unwrap();
        let request: Value = serde_json::from_str(request.to_text().unwrap()).unwrap();
        assert_eq!(request["type"], "response.create");
        assert_eq!(request["model"], "wire-ws");
        peer_request_seen.store(true, Ordering::Release);
        socket
            .send(Message::Text(
                json!({"type":"response.created","response":{
                    "id":"resp_ws_first_word","status":"in_progress","output":[]
                }})
                .to_string(),
            ))
            .await
            .unwrap();
        sleep(Duration::from_millis(if late_first_word {
            300
        } else {
            50
        }))
        .await;
        let first = json!({"type":"response.output_text.delta","response_id":"resp_ws_first_word",
            "item_id":"msg_ws","output_index":0,"content_index":0,"delta":"WS_FIRST_WORD"});
        if socket.send(Message::Text(first.to_string())).await.is_err() {
            return;
        }
        if !late_first_word {
            // No post-word idle or request/residence cutoff is allowed.
            sleep(Duration::from_millis(600)).await;
        }
        peer_terminal.store(true, Ordering::Release);
        let terminal = json!({"type":"response.completed","response":{
            "id":"resp_ws_first_word","object":"response","status":"completed",
            "output":[{"type":"message","id":"msg_ws","role":"assistant","status":"completed",
                "content":[{"type":"output_text","text":"WS_FIRST_WORD","annotations":[]}]}]
        }});
        let _ = socket.send(Message::Text(terminal.to_string())).await;
        let _ = socket.close(None).await;
    });
    let port = test_ports::free_port();
    let declaration = hub_v1_fixture::hub_v1_test_declaration();
    let execution = hub_v1_fixture::hub_v1_server_execution("main");
    let log_file = home.path.join("first-word.log");
    let source = format!(
        r#"
version = 3
[debug]
log_file = "{}"
{declaration}
[servers.main]
bind = "127.0.0.1"
port = {port}
routing_group = "default"
endpoints = ["responses"]
{execution}
attempt_store = {{ request_max_attempts = 1, residence_timeout_ms = 400 }}
[providers.test]
type = "responses"
base_url = "http://controlled.invalid/v1"
default_model = "test"
request_timeout_ms = 100
sse_first_frame_timeout_ms = {FIRST_WORD_MS}
auth = {{ type = "api_key", entries = [{{ alias = "key", api_key = "ws-first-word-secret" }}] }}
responses = {{ process = "direct", streaming = "always", transport = "websocket_v2", websocket_v2_url = "ws://{provider_addr}/v1/responses" }}
[providers.test.models.test]
wire_name = "wire-ws"
capabilities = ["text"]
supports_streaming = true
[route_groups.default.pools.default]
targets = [{{ kind = "provider_model", provider = "test", model = "test", key = "key", priority = 1 }}]
"#,
        log_file.display()
    );
    let manifest =
        compile_v3_config_05_manifest(parse_v3_config_02_authoring(&source).unwrap()).unwrap();
    let handle = spawn_v3_server_aggregate(manifest).await.unwrap();
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(5))
        .build()
        .unwrap();
    let started = Instant::now();
    let response = client
        .post(format!("http://{}/v1/responses", handle.listeners[0].addr))
        .json(&json!({"model":"test.test","input":"show first word","stream":true}))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    let mut stream = response.bytes_stream();
    let mut bytes = Vec::new();
    let mut failed = false;
    while let Some(chunk) = stream.next().await {
        match chunk {
            Ok(chunk) => {
                if chunk.windows(5).any(|part| part == b"data:") {
                    assert!(
                        terminal_sent.load(Ordering::Acquire),
                        "business bytes escaped before upstream terminal"
                    );
                }
                bytes.extend_from_slice(&chunk);
            }
            Err(error) => {
                assert!(
                    error.is_body() || error.is_decode(),
                    "must be a real typed runtime failure, not test timeout: {error}"
                );
                failed = true;
                break;
            }
        }
    }
    let elapsed = started.elapsed();
    let body = String::from_utf8(bytes).unwrap();
    assert!(
        websocket_request_seen.load(Ordering::Acquire),
        "configured provider must receive the actual WebSocket response.create request"
    );
    let records_path = home
        .path
        .join(format!("server-v3-{port}.request-records.jsonl"));
    // Exhausted Direct SSE terminates the client transport after publishing its
    // typed attempt failure. It does not publish a client terminal error row.
    let expected_event = if late_first_word && failed {
        "request.provider_attempt_failed"
    } else {
        "request.completed"
    };
    let request_record = timeout(Duration::from_secs(1), async {
        loop {
            let records = std::fs::read_to_string(&records_path).unwrap_or_default();
            if let Some(record) = records
                .lines()
                .filter_map(|line| serde_json::from_str::<Value>(line).ok())
                .find(|record| record["row"]["event_type"] == expected_event)
            {
                break record;
            }
            sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap_or_else(|error| {
        panic!(
            "actual public request must publish {expected_event}: {error}; records={}",
            std::fs::read_to_string(&records_path).unwrap_or_default()
        )
    });
    let meta = &request_record["row"]["meta"];
    assert_eq!(meta["execution_mode"], "direct");
    assert_eq!(meta["entry_protocol"], "responses");
    assert_eq!(meta["provider_id"], "test");
    assert_eq!(meta["auth_alias"], "key");
    assert_eq!(meta["model"], "test");
    assert_eq!(meta["wire_model"], "wire-ws");
    // This field describes the client transport. The provider's WebSocket
    // identity is established by the real upgrade and response.create above.
    assert_eq!(meta["transport"], "sse");
    eprintln!(
        "PUBLIC_WS_FIRST_WORD_RECORD provider_transport=websocket_v2 record={request_record}"
    );
    handle.shutdown().await;
    peer.abort();
    if late_first_word {
        assert!(failed, "configured500ms deadline must reject semantics arriving after300ms handshake+300ms wait");
        assert!(
            elapsed < Duration::from_millis(800),
            "handshake must not reset the first-word interval: {elapsed:?}"
        );
        assert!(!body.contains("response.completed") && !body.contains("WS_FIRST_WORD"));
    } else {
        assert!(!failed, "configured first word was timely: {body}");
        assert!(
            elapsed >= Duration::from_millis(750),
            "post-first-word pause was not exercised: {elapsed:?}"
        );
        assert!(
            body.contains("response.completed") && body.contains("WS_FIRST_WORD"),
            "missing actual semantic terminal: {body}"
        );
    }
    eprintln!("PUBLIC_WS_FIRST_WORD late={late_first_word} configured_ms={FIRST_WORD_MS} elapsed_ms={} failed={failed}", elapsed.as_millis());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn websocket_configured_first_word_includes_handshake_time() {
    run_case(true).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn websocket_configured_first_word_allows_post_word_pause() {
    run_case(false).await;
}
