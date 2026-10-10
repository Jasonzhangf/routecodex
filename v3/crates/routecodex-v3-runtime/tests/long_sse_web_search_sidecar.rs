//! Real runtime entry, HTTP provider and Unix sidecar operation receipts.
//! No private execution-policy flag or private hook-request builder is used.

use futures_util::StreamExt;
use routecodex_v3_config::{compile_v3_config_05_manifest, parse_v3_config_02_authoring};
use routecodex_v3_error::V3ProviderFailureSessionScope;
use routecodex_v3_hooks::{ControlRequest, ControlResponse};
use routecodex_v3_provider_responses::ProviderResponsesTransport;
use routecodex_v3_runtime::{
    execute_v3_responses_relay_runtime_with_transport_health_and_server_tool_state,
    V3ResponsesRelayClientBody, V3ResponsesRelayProviderHealthHandle, V3ResponsesRelayRuntimeInput,
    V3ResponsesRelayServerToolScope, V3ResponsesRelayServerToolState,
};
use serde_json::{json, Value};
use servertool_core::web_search_contract::{
    WebSearchHookOutcome, WebSearchHookRequest, WebSearchResult, WebSearchResultStatus,
    WebSearchSource,
};
use std::{
    env,
    path::PathBuf,
    time::{SystemTime, UNIX_EPOCH},
};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    net::{TcpListener, TcpStream, UnixListener},
    sync::oneshot,
    task::JoinHandle,
    time::{sleep, timeout, Duration, Instant},
};

static TEST_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
const ALLOWANCE_MS: u64 = 300;
const PROVIDER_STREAM_MS: u64 = 700;

fn epoch_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64
}

fn manifest(port: u16) -> routecodex_v3_config::V3Config05ManifestPublished {
    let source = format!(
        r#"
version = 3
[servers.controlled]
bind = "127.0.0.1"
port = 5555
routing_group = "controlled"
endpoints = ["responses"]
[servers.controlled.execution]
allowed_modes = ["relay"]
allowed_invocation_sources = ["client", "servertool_followup", "dry_run"]
allowed_transports = ["json", "sse"]
attempt_store = {{ request_max_attempts = 1, residence_timeout_ms = {ALLOWANCE_MS} }}
[providers.mm]
type = "anthropic"
base_url = "http://127.0.0.1:{port}/anthropic"
default_model = "MiniMax-M3"
request_timeout_ms = 1500
sse_first_frame_timeout_ms = 200
auth = {{ type = "api_key", entries = [{{ alias = "key1", env = "RCC_LATE_SIDECAR_TEST_KEY" }}] }}
[providers.mm.models.MiniMax-M3]
wire_name = "MiniMax-M3"
capabilities = ["text", "tools", "multimodal", "vision", "web_search"]
web_search_execution_mode = "metadata_center_local_search"
web_search_backend = "MiniMax-M3"
[route_groups.controlled.pools.web_search]
selection = {{ strategy = "priority" }}
match = {{ precedence = 20, required_capabilities = ["web_search"] }}
targets = [{{ kind = "provider_model", provider = "mm", model = "MiniMax-M3", key = "key1", priority = 1 }}]
[route_groups.controlled.pools.default]
selection = {{ strategy = "priority" }}
targets = [{{ kind = "provider_model", provider = "mm", model = "MiniMax-M3", key = "key1", priority = 1 }}]
"#
    );
    compile_v3_config_05_manifest(parse_v3_config_02_authoring(&source).unwrap()).unwrap()
}

async fn read_provider_request(socket: &mut TcpStream, stream: bool) -> Value {
    let mut bytes = Vec::new();
    let mut buffer = [0; 8192];
    loop {
        let count = socket.read(&mut buffer).await.unwrap();
        assert!(count > 0);
        bytes.extend_from_slice(&buffer[..count]);
        let Some(end) = bytes.windows(4).position(|part| part == b"\r\n\r\n") else {
            continue;
        };
        let headers = std::str::from_utf8(&bytes[..end]).unwrap();
        let request_line = headers.lines().next().unwrap();
        assert!(
            request_line.starts_with("POST /anthropic/v1/messages?beta=true "),
            "unexpected provider request line: {request_line}"
        );
        let accept = headers
            .lines()
            .find_map(|line| {
                let (name, value) = line.split_once(':')?;
                name.eq_ignore_ascii_case("accept").then(|| value.trim())
            })
            .expect("provider transport carries explicit typed intent as Accept");
        assert_eq!(
            accept,
            if stream {
                "text/event-stream"
            } else {
                "application/json"
            }
        );
        let length = headers
            .lines()
            .find_map(|line| {
                let (name, value) = line.split_once(':')?;
                name.eq_ignore_ascii_case("content-length")
                    .then(|| value.trim().parse::<usize>().unwrap())
            })
            .unwrap();
        if bytes.len() >= end + 4 + length {
            let body: Value = serde_json::from_slice(&bytes[end + 4..end + 4 + length]).unwrap();
            let keys: Vec<_> = body.as_object().unwrap().keys().collect();
            eprintln!("LATE_SIDECAR_WIRE accept={accept} body_keys={keys:?}");
            return body;
        }
    }
}

async fn send_chunk(socket: &mut TcpStream, bytes: &[u8]) -> std::io::Result<()> {
    socket
        .write_all(format!("{:x}\r\n", bytes.len()).as_bytes())
        .await?;
    socket.write_all(bytes).await?;
    socket.write_all(b"\r\n").await
}

fn event(name: &str, value: Value) -> Vec<u8> {
    format!("event: {name}\ndata: {value}\n\n").into_bytes()
}

async fn provider(
    listener: TcpListener,
    stream: bool,
    receipt: oneshot::Sender<Value>,
) -> std::io::Result<()> {
    let (mut socket, _) = listener.accept().await?;
    let body = read_provider_request(&mut socket, stream).await;
    assert_eq!(body["model"], "MiniMax-M3");
    receipt.send(body).unwrap();
    if !stream {
        let body = json!({"id":"msg_ws","type":"message","role":"assistant","model":"MiniMax-M3",
            "content":[{"type":"tool_use","id":"call_ws_late","name":"web_search","input":{"query":"routecodex"}}],
            "stop_reason":"tool_use","usage":{"input_tokens":11,"output_tokens":5}}).to_string();
        socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len()).as_bytes()).await?;
        sleep(Duration::from_millis(PROVIDER_STREAM_MS)).await;
        return socket.write_all(body.as_bytes()).await;
    }
    socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n").await?;
    send_chunk(
        &mut socket,
        &event(
            "message_start",
            json!({"type":"message_start","message":{
        "id":"msg_ws","type":"message","role":"assistant","model":"MiniMax-M3","content":[],
        "usage":{"input_tokens":11,"output_tokens":0}}}),
        ),
    )
    .await?;
    send_chunk(&mut socket, &event("content_block_start", json!({"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}))).await?;
    sleep(Duration::from_millis(25)).await;
    send_chunk(&mut socket, &event("content_block_delta", json!({"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Searching"}}))).await?;
    sleep(Duration::from_millis(PROVIDER_STREAM_MS)).await;
    send_chunk(
        &mut socket,
        &event(
            "content_block_stop",
            json!({"type":"content_block_stop","index":0}),
        ),
    )
    .await?;
    send_chunk(&mut socket, &event("content_block_start", json!({"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"call_ws_late","name":"web_search","input":{}}}))).await?;
    send_chunk(&mut socket, &event("content_block_delta", json!({"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\"query\":\"routecodex\"}"}}))).await?;
    send_chunk(
        &mut socket,
        &event(
            "content_block_stop",
            json!({"type":"content_block_stop","index":1}),
        ),
    )
    .await?;
    send_chunk(&mut socket, &event("message_delta", json!({"type":"message_delta","delta":{"stop_reason":"tool_use","stop_sequence":null},"usage":{"output_tokens":5}}))).await?;
    send_chunk(
        &mut socket,
        &event("message_stop", json!({"type":"message_stop"})),
    )
    .await?;
    socket.write_all(b"0\r\n\r\n").await
}

async fn sidecar(
    listener: UnixListener,
    stall: bool,
    receipt: oneshot::Sender<(WebSearchHookRequest, Instant)>,
) {
    let (stream, _) = listener.accept().await.unwrap();
    let mut reader = BufReader::new(stream);
    let mut line = String::new();
    reader.read_line(&mut line).await.unwrap();
    let ControlRequest::ExecuteWebSearch { request } = serde_json::from_str(line.trim()).unwrap()
    else {
        panic!("actual runtime must dispatch typed ExecuteWebSearch");
    };
    let call_id = request.call_id.clone();
    receipt.send((*request, Instant::now())).unwrap();
    if stall {
        // Exceed the fresh allowance without EOF or a response to trigger its read bound.
        sleep(Duration::from_millis(ALLOWANCE_MS * 4)).await;
    } else {
        let response = ControlResponse::ok(
            json!({"outcome": WebSearchHookOutcome::Completed(WebSearchResult {
                call_id, status: WebSearchResultStatus::Completed, content: Some("LATE_SEARCH_SUCCESS".into()),
                sources: vec![WebSearchSource {ref_id:"source-1".into(),url:Some("https://example.com".into()),title:Some("Example".into())}],
                metadata:None,error:None,
            })}),
        );
        reader
            .get_mut()
            .write_all(format!("{}\n", serde_json::to_string(&response).unwrap()).as_bytes())
            .await
            .unwrap();
    }
}

struct Cleanup {
    socket: PathBuf,
    previous_key: Option<std::ffi::OsString>,
    tasks: Vec<JoinHandle<()>>,
}
impl Drop for Cleanup {
    fn drop(&mut self) {
        for task in &self.tasks {
            task.abort();
        }
        let _ = std::fs::remove_file(&self.socket);
        if let Some(value) = self.previous_key.take() {
            env::set_var("RCC_LATE_SIDECAR_TEST_KEY", value);
        } else {
            env::remove_var("RCC_LATE_SIDECAR_TEST_KEY");
        }
    }
}

async fn run(stream: bool, stall: bool) {
    let _lock = TEST_LOCK.lock().await;
    let socket = PathBuf::from(format!(
        "/tmp/rcc-late-ws-{}-{}.sock",
        std::process::id(),
        epoch_ms()
    ));
    let unix = UnixListener::bind(&socket).unwrap();
    let tcp = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = tcp.local_addr().unwrap().port();
    let manifest = manifest(port);
    let (provider_tx, provider_rx) = oneshot::channel();
    let (sidecar_tx, mut sidecar_rx) = oneshot::channel();
    let previous_key = env::var_os("RCC_LATE_SIDECAR_TEST_KEY");
    env::set_var("RCC_LATE_SIDECAR_TEST_KEY", "controlled-sidecar-secret");
    let _cleanup = Cleanup {
        socket: socket.clone(),
        previous_key,
        tasks: vec![
            tokio::spawn(async move {
                let _ = provider(tcp, stream, provider_tx).await;
            }),
            tokio::spawn(sidecar(unix, stall, sidecar_tx)),
        ],
    };
    let state = V3ResponsesRelayServerToolState::default().with_hooks_sidecar_socket(Some(socket));
    let health = V3ResponsesRelayProviderHealthHandle::from_manifest(&manifest);
    let begin = Instant::now();
    let start_epoch = epoch_ms();
    let result = timeout(Duration::from_secs(4), execute_v3_responses_relay_runtime_with_transport_health_and_server_tool_state(
        &manifest,
        V3ResponsesRelayRuntimeInput {
            server_id:"controlled".into(), request_id:format!("late-ws-{stream}-{stall}"),
            failure_session_scope:V3ProviderFailureSessionScope::new("controlled", "controlled", format!("late-ws-{stream}-{stall}")).unwrap(),
            payload:json!({"model":"MiniMax-M3","input":[{"type":"web_search","query":"routecodex"},
                {"type":"message","role":"user","content":[{"type":"input_text","text":"search routecodex"}]}],"stream":stream}),
        },
        &ProviderResponsesTransport::default(), &health, &state,
        V3ResponsesRelayServerToolScope::new("/v1/responses", "late-sidecar-session", "late-sidecar-conversation", 5555, "controlled"),
    )).await.expect("test diagnostic cap cannot satisfy auxiliary timeout assertions");
    let elapsed = begin.elapsed();
    let wire = provider_rx
        .await
        .expect("one real provider request must occur");
    assert_eq!(wire["model"], "MiniMax-M3");
    if !stream {
        assert!(
            timeout(Duration::from_millis(50), &mut sidecar_rx)
                .await
                .is_err(),
            "expired JSON must not reach auxiliary dispatch"
        );
        match result {
            Err(error) => eprintln!("LATE_SIDECAR_JSON_FAILURE elapsed={elapsed:?} error={error}"),
            Ok(output) => {
                let V3ResponsesRelayClientBody::Json(body) = output.client_body else {
                    panic!("JSON must retain JSON error projection");
                };
                assert!(
                    body.get("error").is_some(),
                    "expired JSON became business success: {body}"
                );
                eprintln!("LATE_SIDECAR_JSON_FAILURE elapsed={elapsed:?} body={body}");
            }
        }
        assert!(elapsed >= Duration::from_millis(ALLOWANCE_MS - 100));
        return;
    }
    let (request, dispatched) = sidecar_rx
        .await
        .expect("long SSE must actually dispatch to Unix sidecar");
    assert_eq!(request.call_id, "call_ws_late");
    assert_eq!(request.query, "routecodex");
    assert!(dispatched.duration_since(begin) > Duration::from_millis(ALLOWANCE_MS));
    assert!(request.deadline_unix_ms > start_epoch + PROVIDER_STREAM_MS);
    eprintln!("LATE_SIDECAR_OPERATION stream={stream} stall={stall} elapsed={elapsed:?} request={request:?}");
    if stall {
        let error =
            result.expect_err("stalled actual sidecar must expire its fresh operation allowance");
        assert!(
            error.to_string().contains("sidecar") && error.to_string().contains("read"),
            "wrong failure boundary: {error}"
        );
        let auxiliary_elapsed = begin
            .elapsed()
            .saturating_sub(dispatched.duration_since(begin));
        assert!(auxiliary_elapsed >= Duration::from_millis(ALLOWANCE_MS - 100));
        assert!(
            auxiliary_elapsed < Duration::from_millis(ALLOWANCE_MS * 3),
            "stalled sidecar lacks bounded fresh allowance: {auxiliary_elapsed:?}"
        );
        eprintln!(
            "LATE_SIDECAR_STALL_FAILURE auxiliary_elapsed={auxiliary_elapsed:?} error={error}"
        );
    } else {
        let output = result.expect("late SSE sidecar completion must project");
        let V3ResponsesRelayClientBody::Sse(mut body) = output.client_body else {
            panic!("SSE entry must project SSE");
        };
        let mut bytes = Vec::new();
        while let Some(chunk) = body.next().await {
            bytes.extend_from_slice(&chunk);
        }
        let text = String::from_utf8(bytes).unwrap();
        assert!(
            text.contains("response.completed"),
            "no complete client terminal: {text}"
        );
        assert!(text.contains("web_search_call_ws_late") && text.contains("call_ws_late"));
        assert!(text.contains("LATE_SEARCH_SUCCESS") && text.contains("https://example.com"));
        assert!(!text.contains("\"type\":\"function_call\",\"name\":\"web_search\""));
        eprintln!("LATE_SIDECAR_SUCCESS client={text}");
    }
}

#[tokio::test]
async fn long_sse_search_dispatch_completes_with_fresh_auxiliary_allowance() {
    run(true, false).await;
}
#[tokio::test]
async fn long_sse_stalled_search_expires_fresh_auxiliary_allowance() {
    run(true, true).await;
}
#[tokio::test]
async fn expired_json_preserves_parent_residence_and_never_dispatches_search() {
    run(false, false).await;
}
