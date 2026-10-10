//! Controlled TCP peer and actual managed-listener fixture for first-word cases.

use routecodex_v3_config::V3ConfigStore;
use routecodex_v3_server::{spawn_v3_server_aggregate_with_admin, V3ServerAggregateHandle};
use serde_json::{json, Value};
use std::{
    env, fs,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    sync::oneshot,
    task::JoinHandle,
    time::{sleep, timeout, Duration, Instant},
};

use super::{hub_v1_fixture, test_ports};

static TEST_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
const FIRST_WORD_MS: u64 = 800;
const PROVIDER_TOTAL_MS: u64 = 1200;
const RESIDENCE_MS: u64 = 1500;

#[derive(Clone, Copy, Debug)]
pub(super) enum Case {
    Content,
    Reasoning,
    ToolArguments,
    Pause,
    NoWord,
    Eof,
    BodyError,
}

fn frame(delta: Value, finish: Option<&str>) -> Vec<u8> {
    format!(
        "data: {}\n\n",
        json!({"id":"chat-first-word","object":"chat.completion.chunk","created":1,
            "model":"test","choices":[{"index":0,"delta":delta,"finish_reason":finish}]})
    )
    .into_bytes()
}

async fn chunk(socket: &mut TcpStream, bytes: &[u8]) -> std::io::Result<()> {
    socket
        .write_all(format!("{:x}\r\n", bytes.len()).as_bytes())
        .await?;
    socket.write_all(bytes).await?;
    socket.write_all(b"\r\n").await?;
    socket.flush().await
}

/// Capture the actual provider wire request before sending any response headers.
async fn read_request(socket: &mut TcpStream) -> Value {
    let mut bytes = Vec::new();
    let mut buffer = [0; 8192];
    loop {
        let count = socket.read(&mut buffer).await.unwrap();
        assert!(count > 0, "provider closed before writing its request");
        bytes.extend_from_slice(&buffer[..count]);
        let Some(end) = bytes.windows(4).position(|window| window == b"\r\n\r\n") else {
            continue;
        };
        let headers = std::str::from_utf8(&bytes[..end]).unwrap();
        assert!(headers.starts_with("POST /v1/chat/completions "));
        assert!(headers
            .to_ascii_lowercase()
            .contains("authorization: bearer controlled-first-word"));
        let length = headers
            .lines()
            .find_map(|line| {
                let (name, value) = line.split_once(':')?;
                name.eq_ignore_ascii_case("content-length")
                    .then(|| value.trim().parse::<usize>().unwrap())
            })
            .expect("JSON provider request has content-length");
        if bytes.len() >= end + 4 + length {
            return serde_json::from_slice(&bytes[end + 4..end + 4 + length]).unwrap();
        }
    }
}

async fn serve_case(
    listener: TcpListener,
    case: Case,
    receipt: oneshot::Sender<Value>,
    terminal_sent: Arc<AtomicBool>,
) -> std::io::Result<()> {
    let (mut socket, _) = listener.accept().await?;
    let body = read_request(&mut socket).await;
    receipt.send(body).unwrap();
    if matches!(case, Case::NoWord) {
        // Header acquisition consumes the SAME first-word interval as comments.
        sleep(Duration::from_millis(300)).await;
    }
    socket
        .write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n")
        .await?;
    // Deliberately precede semantics with two forms of transport-only progress.
    chunk(&mut socket, b": upstream keepalive\n\n").await?;
    chunk(
        &mut socket,
        &frame(json!({"role":"assistant","content":""}), None),
    )
    .await?;
    sleep(Duration::from_millis(50)).await;
    if matches!(case, Case::NoWord) {
        // More frequent than first-word/old idle limits; these must NOT renew it.
        for _ in 0..30 {
            chunk(&mut socket, b": still no semantic word\n\n").await?;
            chunk(
                &mut socket,
                &frame(json!({"role":"assistant","content":""}), None),
            )
            .await?;
            sleep(Duration::from_millis(100)).await;
        }
        return Ok(());
    }
    let first = match case {
        Case::Reasoning => json!({"reasoning_content":"FIRST_REASONING"}),
        Case::ToolArguments => json!({"tool_calls":[{"index":0,"id":"call_first_word",
            "type":"function","function":{"name":"write_file","arguments":"{\"path\":"}}]}),
        _ => json!({"content":"FIRST_CONTENT"}),
    };
    chunk(&mut socket, &frame(first, None)).await?;
    match case {
        Case::Eof => {
            // Clean HTTP EOF, but no semantic finish_reason: never success.
            socket.write_all(b"0\r\n\r\n").await?;
            return Ok(());
        }
        Case::BodyError => {
            // Genuine truncated HTTP chunk after semantic progress.
            socket.write_all(b"100\r\ntruncated").await?;
            socket.shutdown().await?;
            return Ok(());
        }
        Case::Pause => sleep(Duration::from_millis(2300)).await,
        _ => {
            for _ in 0..24 {
                sleep(Duration::from_millis(100)).await;
                let delta = match case {
                    Case::Reasoning => json!({"reasoning_content":"."}),
                    // Valid tool JSON remains unchanged during the long stream.
                    Case::ToolArguments => json!({"tool_calls":[{"index":0,
                        "function":{"arguments":" "}}]}),
                    _ => json!({"content":"."}),
                };
                chunk(&mut socket, &frame(delta, None)).await?;
            }
        }
    }
    let (last, finish) = if matches!(case, Case::ToolArguments) {
        (
            json!({"tool_calls":[{"index":0,"function":{"arguments":"\"out.txt\",\"content\":\"FINAL_CONTENT\"}"}}]}),
            "tool_calls",
        )
    } else {
        (json!({"content":"FINAL_CONTENT"}), "stop")
    };
    chunk(&mut socket, &frame(last, None)).await?;
    let mut terminal = frame(json!({}), Some(finish));
    terminal.extend_from_slice(b"data: [DONE]\n\n");
    chunk(&mut socket, &terminal).await?;
    terminal_sent.store(true, Ordering::SeqCst);
    socket.write_all(b"0\r\n\r\n").await?;
    Ok(())
}

struct Managed {
    handle: Option<V3ServerAggregateHandle>,
    home: PathBuf,
    previous_home: Option<std::ffi::OsString>,
    previous_key: Option<std::ffi::OsString>,
    base: String,
    listener_port: u16,
}

impl Managed {
    async fn start(upstream_port: u16) -> Self {
        let home = env::temp_dir().join(format!(
            "rcc-first-word-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&home).unwrap();
        let previous_home = env::var_os("HOME");
        let previous_key = env::var_os("V3_FIRST_WORD_TEST_KEY");
        env::set_var("HOME", &home);
        env::set_var("V3_FIRST_WORD_TEST_KEY", "controlled-first-word");
        let declaration = hub_v1_fixture::hub_v1_test_declaration()
            .replace("execution_mode = \"direct\", protocol_profile_owner = \"v3.entry_protocol_registry_contract\", implemented = true, forbidden_reentry_behavior = \"Responses endpoint must not fall through to relay or pending runtime.\", runtime_owner_symbol = \"execute_v3_responses_direct_runtime_kernel_with_shared_state_and_default_transport_debug\", runtime_owner_path = \"v3/crates/routecodex-v3-runtime/src/kernel.rs\"",
                "execution_mode = \"relay\", protocol_profile_owner = \"v3.hub_relay_runtime_closeout\", implemented = true, forbidden_reentry_behavior = \"Responses endpoint must enter Hub Relay runtime and must not fall through to Direct/P6 or pending runtime.\", runtime_owner_symbol = \"execute_v3_responses_relay_runtime_with_default_transport\", runtime_owner_path = \"v3/crates/routecodex-v3-runtime/src/hub_v1/responses_relay_runtime.rs\"");
        assert!(declaration.contains("execute_v3_responses_relay_runtime_with_default_transport"));
        let server_port = test_ports::free_port();
        let execution = hub_v1_fixture::hub_v1_server_execution("main");
        let path = home.join("config.toml");
        let log_file = home.join("first-word.log");
        fs::write(&path, format!(r#"
version = 3
[debug]
log_file = "{}"
{declaration}
[servers.main]
bind = "127.0.0.1"
port = {server_port}
routing_group = "default"
endpoints = ["responses"]
{execution}
attempt_store = {{ request_max_attempts = 1, residence_timeout_ms = {RESIDENCE_MS} }}
[providers.test]
type = "openai_chat"
base_url = "http://127.0.0.1:{upstream_port}/v1"
default_model = "test"
request_timeout_ms = {PROVIDER_TOTAL_MS}
sse_first_frame_timeout_ms = {FIRST_WORD_MS}
auth = {{ type = "api_key", entries = [{{ alias = "key", env = "V3_FIRST_WORD_TEST_KEY" }}] }}
[providers.test.models.test]
[route_groups.default.pools.default]
selection = {{ strategy = "priority" }}
targets = [{{ kind = "provider_model", provider = "test", model = "test", key = "key", priority = 1 }}]
"#, log_file.display())).unwrap();
        let snapshot = V3ConfigStore::new(&path)
            .load_snapshot_with_source_identity()
            .unwrap();
        let handle = spawn_v3_server_aggregate_with_admin(
            snapshot.manifest,
            snapshot.admin_webui,
            Some(path),
        )
        .await
        .unwrap();
        let listener = handle
            .listeners
            .iter()
            .find(|listener| listener.server_id == "main")
            .unwrap();
        let base = format!("http://{}", listener.addr);
        let listener_port = listener.addr.port();
        Self {
            handle: Some(handle),
            home,
            previous_home,
            previous_key,
            base,
            listener_port,
        }
    }

    async fn finish(mut self) {
        if let Some(handle) = self.handle.take() {
            handle.shutdown().await;
        }
    }
}

impl Drop for Managed {
    fn drop(&mut self) {
        if let Some(value) = self.previous_home.take() {
            env::set_var("HOME", value);
        } else {
            env::remove_var("HOME");
        }
        if let Some(value) = self.previous_key.take() {
            env::set_var("V3_FIRST_WORD_TEST_KEY", value);
        } else {
            env::remove_var("V3_FIRST_WORD_TEST_KEY");
        }
        let _ = fs::remove_dir_all(&self.home);
    }
}

struct PeerTask(JoinHandle<std::io::Result<()>>);
impl Drop for PeerTask {
    fn drop(&mut self) {
        self.0.abort();
    }
}

pub(super) async fn run_case(case: Case, success: bool) {
    let _guard = TEST_LOCK.lock().await;
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let (tx, rx) = oneshot::channel();
    let terminal_sent = Arc::new(AtomicBool::new(false));
    let _peer = PeerTask(tokio::spawn(serve_case(
        listener,
        case,
        tx,
        terminal_sent.clone(),
    )));
    let managed = Managed::start(port).await;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(8))
        .build()
        .unwrap();
    let begin = Instant::now();
    let mut response = client
        .post(format!("{}/v1/responses", managed.base))
        .json(
            &json!({"model":"test","input":"exercise first-word timeout","stream":true,
            "tools":[{"type":"function","name":"write_file","parameters":{"type":"object",
                "properties":{"path":{"type":"string"},"content":{"type":"string"}},
                "required":["path","content"]}}]}),
        )
        .send()
        .await
        .unwrap();
    let wire = timeout(Duration::from_secs(2), rx).await.unwrap().unwrap();
    assert_eq!(wire["model"], "test");
    assert_eq!(wire["stream"], true);
    assert_eq!(wire["tools"][0]["function"]["name"], "write_file");
    let mut bytes = Vec::new();
    let body_error = loop {
        match response.chunk().await {
            Ok(Some(chunk)) => {
                bytes.extend_from_slice(&chunk);
                // The listener may accept early or hold headers until commit.
                // Compare each actual business-byte arrival with the peer's
                // observed terminal write rather than guessing from send().
                if bytes.windows(5).any(|window| window == b"data:") {
                    assert!(
                        terminal_sent.load(Ordering::SeqCst),
                        "client business data arrived before upstream terminal: {}",
                        String::from_utf8_lossy(&bytes)
                    );
                }
            }
            Ok(None) => break None,
            Err(error) => break Some(error),
        }
    };
    let elapsed = begin.elapsed();
    let text = String::from_utf8(bytes).unwrap();
    if success {
        assert!(
            body_error.is_none(),
            "normal semantic terminal must not disconnect client: {body_error:?}; {text}"
        );
        assert!(
            elapsed > Duration::from_millis(RESIDENCE_MS),
            "fixture must outlive both old deadlines: {elapsed:?}"
        );
        assert!(
            text.contains("event: response.completed"),
            "missing complete client terminal: {text}"
        );
        let completed = text
            .split("\n\n")
            .filter_map(|event| {
                event
                    .lines()
                    .find_map(|line| line.strip_prefix("data: "))
                    .and_then(|data| serde_json::from_str::<Value>(data).ok())
            })
            .find(|event| event["type"] == "response.completed")
            .unwrap();
        assert_eq!(completed["response"]["status"], "completed");
        if matches!(case, Case::ToolArguments) {
            let output = completed["response"]["output"].as_array().unwrap();
            let tool = output
                .iter()
                .find(|item| item["type"] == "function_call")
                .unwrap();
            assert_eq!(tool["call_id"], "call_first_word");
            assert_eq!(tool["name"], "write_file");
            let args: Value = serde_json::from_str(tool["arguments"].as_str().unwrap()).unwrap();
            assert_eq!(args, json!({"path":"out.txt","content":"FINAL_CONTENT"}));
        } else {
            assert!(
                completed.to_string().contains("FINAL_CONTENT"),
                "final content lost: {completed}"
            );
            if matches!(case, Case::Reasoning) {
                assert!(
                    text.contains("FIRST_REASONING"),
                    "reasoning first word lost: {text}"
                );
            } else {
                assert!(completed.to_string().contains("FIRST_CONTENT"));
            }
        }
        assert!(
            terminal_sent.load(Ordering::SeqCst),
            "upstream semantic terminal must be transmitted before client success"
        );
    } else {
        assert!(
            !text.contains("event: response.completed"),
            "incomplete provider attempt became success: {text}"
        );
        assert!(
            !text.contains("FIRST_CONTENT"),
            "failed attempt leaked business output: {text}"
        );
        let error =
            body_error.expect("accepted SSE channel must break on incomplete provider attempt");
        assert!(
            !error.is_timeout(),
            "test client's diagnostic timeout must not be the failure: {error:?}"
        );
        assert!(
            error.is_decode() || error.is_body(),
            "expected real client transport break: {error:?}"
        );
        eprintln!("PUBLIC_FIRST_WORD_FAILURE case={case:?} elapsed_ms={} client_error={error:?} client_prefix={text:?}", elapsed.as_millis());
        if matches!(case, Case::NoWord) {
            // Distinguishes first-word deadline from the later provider/residence limits.
            assert!(
                elapsed < Duration::from_millis(PROVIDER_TOTAL_MS),
                "nonsemantic activity renewed first-word timer: {elapsed:?}; {text}"
            );
            assert!(
                elapsed >= Duration::from_millis(FIRST_WORD_MS - 150),
                "headers must not fail immediately: {elapsed:?}"
            );
        }
        let pool: Value = client
            .get(format!("{}/_routecodex/health/cooldown-pool", managed.base))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        eprintln!("PUBLIC_FIRST_WORD_POOL case={case:?} pool={pool}");
        if matches!(case, Case::Eof | Case::BodyError) {
            assert!(
                pool["entries"]
                    .as_array()
                    .is_some_and(|entries| entries
                        .iter()
                        .any(|entry| entry["provider_id"] == "test"
                            && entry["auth_alias"] == "key"
                            && entry["model_id"] == "test")),
                "exact failed provider.model.key missing from cooldown: {pool}"
            );
        }
        let log = fs::read_to_string(managed.home.join("first-word.log")).unwrap();
        eprintln!("PUBLIC_FIRST_WORD_RUNTIME_LOG case={case:?}\n{log}");
        if matches!(case, Case::NoWord) {
            // The public error projection intentionally hides its source message.
            // Keep typed runtime failure and its timing, rather than demanding
            // an undisclosed source string in a diagnostic surface.
            let records_path = managed.home.join(format!(
                "server-v3-{}.request-records.jsonl",
                managed.listener_port
            ));
            let records = timeout(Duration::from_secs(1), async {
                loop {
                    let records = fs::read_to_string(&records_path).unwrap_or_default();
                    if records.contains("request.failed") {
                        break records;
                    }
                    sleep(Duration::from_millis(10)).await;
                }
            })
            .await
            .expect("real request failure must reach the configured records sink");
            eprintln!("PUBLIC_FIRST_WORD_REQUEST_RECORDS case={case:?}\n{records}");
            let failed: Value = records
                .lines()
                .filter_map(|line| serde_json::from_str::<Value>(line).ok())
                .find(|record| record["row"]["event_type"] == "request.failed")
                .unwrap();
            assert_eq!(failed["row"]["result"], "error");
            assert_eq!(failed["row"]["meta"]["provider_id"], "test");
            assert_eq!(failed["row"]["meta"]["auth_alias"], "key");
            assert_eq!(
                failed["row"]["meta"]["observed_error"]["external_error_code"],
                "provider_transport_error"
            );
            let duration_ms = failed["row"]["duration_ms"].as_u64().unwrap();
            assert!(
                duration_ms >= FIRST_WORD_MS - 150 && duration_ms < PROVIDER_TOTAL_MS,
                "typed failure must occur at first-word budget before provider total: {failed}"
            );
        }
    }
    managed.finish().await;
}
