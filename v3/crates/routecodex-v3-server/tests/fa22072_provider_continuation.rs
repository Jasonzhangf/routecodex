//! fa22072 r34: Chat Relay failed-attempt continuation with internal source retention.
//!
//! Accepted plan: `/private/tmp/routecodex-fa22072-01a133d7/provider-continuation-plan-r34/plan.md`.
//! Latest user correction: "出现错误,客户端不要关闭,是切provider,只改变记录错误的行为"
//! / "内部记录错误,客户端继续切换provider继续执行".
//!
//! Goal of this node: prove, through the public `/v1/chat/completions` HTTP entry,
//! that ONE client request whose declared Provider A fails is continued on a
//! DISTINCT declared Provider B, on the same client transport, while the failed
//! attempt's ORIGINAL typed source is retained internally.
//!
//! Stable test ID: `fa22072_chat_failed_attempt_recovers_with_source_public_entry`.
//!
//! The test is deliberately ordered:
//!   1. Continuation controls run first and are all evaluated (client is held,
//!      not EOF, receives only B's real business result; A=1/B=1 upstream
//!      business calls in order; exactly one client request per case; synthetic
//!      per-provider auth; unpinned two-provider priority route).
//!   2. Only then does the frozen private-artifact assertion run. Under prepatch
//!      source the per-request `provider-failed-attempts.json` is absent, so that
//!      assertion is the EXPECTED RED for the missing failed-attempt source.
//!
//! This file only READS product behaviour. It adds no production field, no
//! semantic validator, no fallback and no client error payload. All peers are
//! owned ephemeral loopback fixtures; no live runtime, config, secret or
//! lifecycle action is touched.

use routecodex_v3_config::{
    compile_v3_config_05_manifest, parse_v3_config_02_authoring, V3Config05ManifestPublished,
};
use routecodex_v3_server::spawn_v3_server_aggregate;
use serde_json::{json, Value};
use std::collections::BTreeSet;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{oneshot, Mutex};
use tokio::time::timeout;

#[path = "../../../crates/routecodex-v3-runtime/tests/support/hub_v1_fixture.rs"]
mod hub_v1_fixture;
#[path = "fa22072_provider_continuation/local_buffer_failure.rs"]
mod local_buffer_failure;
#[path = "support/fa22072_test_home.rs"]
mod test_home;
#[path = "../../../crates/routecodex-v3-runtime/tests/support/test_ports.rs"]
mod test_ports;
#[path = "fa22072_provider_continuation/write_failure.rs"]
mod write_failure;

static TEST_LOCK: test_home::ServerTestLock = test_home::ServerTestLock::new();

const ALPHA_KEY_ENV: &str = "FA22072_CONT_ALPHA_KEY";
const BETA_KEY_ENV: &str = "FA22072_CONT_BETA_KEY";
const ALPHA_KEY: &str = "alpha-owned-fixture-key";
const BETA_KEY: &str = "beta-owned-fixture-key";
const CLIENT_MODEL: &str = "step-5-preview";
const ALPHA_WIRE: &str = "alpha-wire";
const BETA_WIRE: &str = "beta-wire";
const REQUEST_MARKER: &str = "owned continuation request";
const BETA_BUSINESS_TEXT: &str = "owned beta continuation complete";
const ALPHA_PRIVATE_CAUSE: &str = "alpha private cause fa22072";
const ALPHA_NONCREDENTIAL_HEADER: &str = "owned-alpha-503-header";
const ALPHA_RESPONSE_SECRET: &str = "owned-alpha-response-secret";
const TOOL_CALL_ID: &str = "call_owned_1";
const FAILED_ATTEMPT_ATTEMPT_ID: usize = 1;

/// The private diagnostic artifact this node freezes for the failed-attempt source.
const FAILED_ATTEMPT_FILE: &str = "provider-failed-attempts.json";
const FAILED_ATTEMPT_OBJECT: &str = "routecodex.v3.provider_failed_attempt_evidence";

/// How the first declared provider (alpha) fails for one case. Every variant is a
/// real representational failure that reaches the shared provider-failure
/// handler; none is a locally invented semantic validator.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum AlphaBehavior {
    /// Close the upstream connection before any HTTP response head.
    PreHeadDrop,
    /// Answer a real HTTP 503 with a provider-private JSON body.
    Http503,
    /// Send a real 200 head and only part of its declared body.
    PostHeadBodyReadFailure,
    /// Send a 200 head with a well-formed content-length but malformed JSON body.
    PostHeadMalformedJson,
}

#[derive(Clone, Debug)]
struct PeerCapture {
    authorization: Option<String>,
    body: Value,
}

struct AlphaPeer {
    behavior: Mutex<AlphaBehavior>,
    captures: Mutex<Vec<PeerCapture>>,
    /// Test-only observation of the order in which the owned providers captured a
    /// full request. It is fixture evidence only; it is never runtime control or
    /// business metadata.
    order: Arc<Mutex<Vec<&'static str>>>,
}

impl AlphaPeer {
    fn new(order: Arc<Mutex<Vec<&'static str>>>) -> Self {
        Self {
            behavior: Mutex::new(AlphaBehavior::PreHeadDrop),
            captures: Mutex::new(Vec::new()),
            order,
        }
    }

    async fn set_behavior(&self, behavior: AlphaBehavior) {
        *self.behavior.lock().await = behavior;
    }

    async fn count(&self) -> usize {
        self.captures.lock().await.len()
    }

    async fn last(&self) -> Option<PeerCapture> {
        self.captures.lock().await.last().cloned()
    }
}

struct BetaPeer {
    captures: Mutex<Vec<PeerCapture>>,
    /// Signalled after beta captures the continuation attempt and is about to wait.
    arrived: Mutex<Option<oneshot::Sender<()>>>,
    /// Awaited (holding the provider attempt) until the test releases beta.
    release: Mutex<Option<oneshot::Receiver<()>>>,
    /// Test-only observation shared with `AlphaPeer`; see its doc comment.
    order: Arc<Mutex<Vec<&'static str>>>,
}

impl BetaPeer {
    fn new(order: Arc<Mutex<Vec<&'static str>>>) -> Self {
        Self {
            captures: Mutex::new(Vec::new()),
            arrived: Mutex::new(None),
            release: Mutex::new(None),
            order,
        }
    }

    async fn count(&self) -> usize {
        self.captures.lock().await.len()
    }

    async fn last(&self) -> Option<PeerCapture> {
        self.captures.lock().await.last().cloned()
    }
}

/// Owned synthetic provider peer for the first declared provider. It records the
/// full inbound provider request, then fails in the behaviour selected by the
/// test. The failure is the entire effect: no timeout, no signal, no invented
/// status and no business payload are used to force it.
async fn serve_alpha(listener: TcpListener, peer: Arc<AlphaPeer>) {
    loop {
        let (mut socket, _) = match listener.accept().await {
            Ok(accepted) => accepted,
            Err(_) => continue,
        };
        let peer = peer.clone();
        tokio::spawn(async move {
            let Some((head, body)) = read_http_request(&mut socket).await else {
                return;
            };
            let authorization = authorization_header(&head);
            let request_body: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
            let behavior = *peer.behavior.lock().await;
            peer.captures.lock().await.push(PeerCapture {
                authorization,
                body: request_body,
            });
            peer.order.lock().await.push("alpha");
            match behavior {
                AlphaBehavior::PreHeadDrop => {
                    // Close this owned upstream connection before any HTTP head.
                    drop(socket);
                }
                AlphaBehavior::Http503 => {
                    let payload = format!(
                        "{{\"error\":{{\"type\":\"server_error\",\"code\":\"alpha_owned_failure\",\"message\":\"{ALPHA_PRIVATE_CAUSE}\",\"api_key\":\"{ALPHA_RESPONSE_SECRET}\"}}}}"
                    );
                    let head = format!(
                        "HTTP/1.1 503 Service Unavailable\r\ncontent-type: application/json\r\nx-routecodex-fixture: {ALPHA_NONCREDENTIAL_HEADER}\r\nauthorization: Bearer {ALPHA_RESPONSE_SECRET}\r\nset-cookie: session={ALPHA_RESPONSE_SECRET}\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
                        payload.len()
                    );
                    let _ = socket.write_all(head.as_bytes()).await;
                    let _ = socket.write_all(payload.as_bytes()).await;
                    let _ = socket.flush().await;
                }
                AlphaBehavior::PostHeadBodyReadFailure => {
                    let partial_payload =
                        format!("{{\"error\":{{\"message\":\"{ALPHA_PRIVATE_CAUSE}\"}}");
                    let head = format!(
                        "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\nx-routecodex-fixture: {ALPHA_NONCREDENTIAL_HEADER}\r\ncontent-length: 512\r\nconnection: close\r\n\r\n"
                    );
                    let _ = socket.write_all(head.as_bytes()).await;
                    let _ = socket.write_all(partial_payload.as_bytes()).await;
                    let _ = socket.flush().await;
                }
                AlphaBehavior::PostHeadMalformedJson => {
                    // A 200 head whose declared content-length matches, but whose
                    // body is not decodable JSON. The decode failure is the
                    // representational failure; the raw bytes never reach the client.
                    let payload = format!(
                        "{{\"id\":\"chatcmpl-alpha\",\"object\":\"chat.completion\",\"model\":\"{ALPHA_WIRE}\",\"choices\":[{{\"index\":0,\"message\":{{\"role\":\"assistant\",\"content\":\"{ALPHA_PRIVATE_CAUSE}\"}}"
                    );
                    let head = format!(
                        "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
                        payload.len()
                    );
                    let _ = socket.write_all(head.as_bytes()).await;
                    let _ = socket.write_all(payload.as_bytes()).await;
                    let _ = socket.flush().await;
                }
            }
        });
    }
}

/// Owned synthetic provider peer for the distinct second declared provider. It
/// records the preserved projected request, announces arrival, holds the attempt
/// behind a test-controlled barrier, and only then emits a distinctive legitimate
/// Chat result.
async fn serve_beta(listener: TcpListener, peer: Arc<BetaPeer>) {
    loop {
        let (mut socket, _) = match listener.accept().await {
            Ok(accepted) => accepted,
            Err(_) => continue,
        };
        let peer = peer.clone();
        tokio::spawn(async move {
            let Some((head, body)) = read_http_request(&mut socket).await else {
                return;
            };
            let authorization = authorization_header(&head);
            let request_body: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
            peer.captures.lock().await.push(PeerCapture {
                authorization,
                body: request_body.clone(),
            });
            peer.order.lock().await.push("beta");
            let arrived = peer.arrived.lock().await.take();
            if let Some(sender) = arrived {
                let _ = sender.send(());
            }
            let release = peer.release.lock().await.take();
            if let Some(receiver) = release {
                let _ = receiver.await;
            }
            let _ = write_beta_response(&mut socket, &request_body).await;
        });
    }
}

fn authorization_header(head: &str) -> Option<String> {
    head.lines().find_map(|line| {
        let (name, value) = line.split_once(':')?;
        name.eq_ignore_ascii_case("authorization")
            .then(|| value.trim().to_string())
    })
}

async fn read_http_request(socket: &mut TcpStream) -> Option<(String, Vec<u8>)> {
    let mut buffer = Vec::new();
    let mut chunk = [0u8; 4096];
    let head_end = loop {
        if let Some(position) = buffer.windows(4).position(|window| window == b"\r\n\r\n") {
            break position + 4;
        }
        let read = socket.read(&mut chunk).await.ok()?;
        if read == 0 {
            return None;
        }
        buffer.extend_from_slice(&chunk[..read]);
    };
    let head = String::from_utf8_lossy(&buffer[..head_end]).to_string();
    let content_length = head
        .lines()
        .find_map(|line| {
            let (name, value) = line.split_once(':')?;
            if name.eq_ignore_ascii_case("content-length") {
                value.trim().parse::<usize>().ok()
            } else {
                None
            }
        })
        .unwrap_or(0);
    while buffer.len() < head_end + content_length {
        let read = socket.read(&mut chunk).await.ok()?;
        if read == 0 {
            break;
        }
        buffer.extend_from_slice(&chunk[..read]);
    }
    let body = buffer[head_end..].to_vec();
    Some((head, body))
}

async fn write_beta_response(socket: &mut TcpStream, request: &Value) -> std::io::Result<()> {
    let streaming = request.get("stream").and_then(Value::as_bool) == Some(true);
    let (content_type, body) = if streaming {
        (
            "text/event-stream",
            concat!(
                "data: {\"id\":\"chatcmpl-beta\",\"object\":\"chat.completion.chunk\",\"model\":\"beta-wire\",\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"content\":\"owned beta continuation complete\"},\"finish_reason\":null}]}\n\n",
                "data: {\"id\":\"chatcmpl-beta\",\"object\":\"chat.completion.chunk\",\"model\":\"beta-wire\",\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n",
                "data: [DONE]\n\n",
            )
            .to_string(),
        )
    } else {
        (
            "application/json",
            serde_json::to_string(&json!({
                "id": "chatcmpl-beta",
                "object": "chat.completion",
                "model": BETA_WIRE,
                "choices": [{
                    "index": 0,
                    "message": {"role": "assistant", "content": BETA_BUSINESS_TEXT},
                    "finish_reason": "stop"
                }],
                "usage": {"prompt_tokens": 3, "completion_tokens": 2, "total_tokens": 5}
            }))
            .unwrap(),
        )
    };
    let head = format!(
        "HTTP/1.1 200 OK\r\ncontent-type: {content_type}\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
        body.len()
    );
    socket.write_all(head.as_bytes()).await?;
    socket.write_all(body.as_bytes()).await?;
    socket.flush().await?;
    Ok(())
}

/// Explicit Chat Relay entry. Two distinct declared Providers, deterministic
/// priority selection (alpha priority 2 wins first), provider health disabled so
/// failure is request-local, synthetic per-provider auth, isolated fixture HOME.
fn manifest(server_port: u16, alpha_port: u16, beta_port: u16) -> V3Config05ManifestPublished {
    let direct_binding = r#"{ entry_protocol = "openai_chat", endpoint_patterns = ["/v1/chat/completions"], execution_mode = "direct", protocol_profile_owner = "v3.entry_protocol_registry_contract", implemented = true, forbidden_reentry_behavior = "OpenAI Chat endpoint must not fall through to Responses Direct or pending runtime.", runtime_owner_symbol = "execute_v3_openai_chat_direct_server_outcome", runtime_owner_path = "v3/crates/routecodex-v3-server/src/executors.rs" }"#;
    let relay_binding = r#"{ entry_protocol = "openai_chat", endpoint_patterns = ["/v1/chat/completions"], execution_mode = "relay", protocol_profile_owner = "v3.entry_protocol_registry_contract", implemented = true, forbidden_reentry_behavior = "OpenAI Chat endpoint must not fall through to Responses Direct or pending runtime.", runtime_owner_symbol = "execute_v3_openai_chat_relay_runtime_with_default_transport", runtime_owner_path = "v3/crates/routecodex-v3-runtime/src/hub_v1/openai_chat_relay_runtime.rs" }"#;
    let declaration =
        hub_v1_fixture::hub_v1_test_declaration().replace(direct_binding, relay_binding);
    assert!(
        declaration.contains("execution_mode = \"relay\""),
        "the openai_chat entry must be pinned to Chat Relay"
    );
    let execution = hub_v1_fixture::hub_v1_server_execution("step5");
    let source = format!(
        r#"
version = 3
{declaration}
[servers.step5]
bind = "127.0.0.1"
port = {server_port}
routing_group = "step5"
endpoints = ["openai_chat"]
{execution}
[providers.alpha]
type = "openai_chat"
base_url = "http://127.0.0.1:{alpha_port}/v1"
default_model = "{alpha_wire}"
auth = {{ type = "api_key", entries = [{{ alias = "alpha", env = "{alpha_env}" }}] }}
health = {{ enabled = false, failure_threshold = 1, cooldown_ms = 5000 }}
[providers.alpha.models.{alpha_wire}]
wire_name = "{alpha_wire}"
capabilities = ["text", "tools"]
supports_streaming = true
[providers.beta]
type = "openai_chat"
base_url = "http://127.0.0.1:{beta_port}/v1"
default_model = "{beta_wire}"
auth = {{ type = "api_key", entries = [{{ alias = "beta", env = "{beta_env}" }}] }}
health = {{ enabled = false, failure_threshold = 1, cooldown_ms = 5000 }}
[providers.beta.models.{beta_wire}]
wire_name = "{beta_wire}"
capabilities = ["text", "tools"]
supports_streaming = true
[route_groups.step5.pools.step5]
selection = {{ strategy = "priority" }}
match = {{ precedence = 10, entry_protocol = "openai_chat", models = ["{client_model}"] }}
targets = [
  {{ kind = "provider_model", provider = "alpha", model = "{alpha_wire}", key = "alpha", priority = 2 }},
  {{ kind = "provider_model", provider = "beta", model = "{beta_wire}", key = "beta", priority = 1 }},
]
[route_groups.step5.pools.default]
selection = {{ strategy = "priority" }}
targets = [
  {{ kind = "provider_model", provider = "alpha", model = "{alpha_wire}", key = "alpha", priority = 2 }},
  {{ kind = "provider_model", provider = "beta", model = "{beta_wire}", key = "beta", priority = 1 }},
]
[debug]
log_console = false
snapshots = true
codex_samples = true
"#,
        declaration = declaration,
        execution = execution,
        server_port = server_port,
        alpha_port = alpha_port,
        beta_port = beta_port,
        alpha_wire = ALPHA_WIRE,
        beta_wire = BETA_WIRE,
        alpha_env = ALPHA_KEY_ENV,
        beta_env = BETA_KEY_ENV,
        client_model = CLIENT_MODEL,
    );
    compile_v3_config_05_manifest(parse_v3_config_02_authoring(&source).unwrap()).unwrap()
}

/// Unpinned client request. The client `model` is not a `provider.model` pin, so
/// the virtual router selects the declared step5 pool (alpha first, beta next).
/// A minimal tool call plus its paired tool result ride along so the projection
/// can be asserted without extra payload machinery.
fn chat_payload(stream: bool) -> Value {
    json!({
        "model": CLIENT_MODEL,
        "messages": [
            {"role": "user", "content": REQUEST_MARKER},
            {"role": "assistant", "tool_calls": [{
                "id": TOOL_CALL_ID,
                "type": "function",
                "function": {"name": "lookup", "arguments": "{\"q\":\"owned\"}"}
            }]},
            {"role": "tool", "tool_call_id": TOOL_CALL_ID, "content": "owned tool result"}
        ],
        "tools": [{"type": "function", "function": {
            "name": "lookup",
            "parameters": {"type": "object", "properties": {"q": {"type": "string"}}}
        }}],
        "stream": stream
    })
}

/// A client transport probe: one raw POST whose reader records bytes and closure
/// without ever treating a timeout as a result.
struct ClientProbe {
    bytes: Arc<Mutex<Vec<u8>>>,
    closed: Arc<AtomicBool>,
    reader: tokio::task::JoinHandle<()>,
}

impl ClientProbe {
    async fn snapshot(&self) -> Vec<u8> {
        self.bytes.lock().await.clone()
    }

    fn is_closed(&self) -> bool {
        self.closed.load(Ordering::SeqCst)
    }

    fn abort(self) {
        self.reader.abort();
    }
}

async fn issue_client(port: u16, stream: bool) -> ClientProbe {
    let body = chat_payload(stream).to_string();
    let mut socket = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
    socket
        .write_all(
            format!(
                "POST /v1/chat/completions HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            )
            .as_bytes(),
        )
        .await
        .unwrap();
    socket.flush().await.unwrap();
    let bytes = Arc::new(Mutex::new(Vec::new()));
    let closed = Arc::new(AtomicBool::new(false));
    let reader_bytes = bytes.clone();
    let reader_closed = closed.clone();
    let reader = tokio::spawn(async move {
        let mut chunk = [0u8; 4096];
        loop {
            match socket.read(&mut chunk).await {
                Ok(0) => {
                    reader_closed.store(true, Ordering::SeqCst);
                    break;
                }
                Ok(read) => reader_bytes.lock().await.extend_from_slice(&chunk[..read]),
                Err(_) => {
                    reader_closed.store(true, Ordering::SeqCst);
                    break;
                }
            }
        }
    });
    ClientProbe {
        bytes,
        closed,
        reader,
    }
}

async fn wait_closed(probe: &ClientProbe, limit: Duration) {
    let deadline = tokio::time::Instant::now() + limit;
    while !probe.is_closed() && tokio::time::Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

/// Decodes the JSON body of a raw HTTP/1.1 client response. The fixture server
/// frames the client body with `transfer-encoding: chunked`, so the chunk-size
/// lines and terminating zero chunk are removed before parsing. A known-length
/// (non-chunked) body is parsed as-is.
fn json_body(wire: &[u8]) -> Option<Value> {
    let text = String::from_utf8_lossy(wire).to_string();
    let (head, rest) = text.split_once("\r\n\r\n")?;
    let chunked = head.lines().any(|line| {
        let line = line.to_ascii_lowercase();
        line.starts_with("transfer-encoding:") && line.contains("chunked")
    });
    let body = if chunked {
        decode_chunked_body(rest)?
    } else {
        rest.to_string()
    };
    serde_json::from_str(&body).ok()
}

/// Removes HTTP/1.1 chunked framing, concatenating the chunk payloads until the
/// terminating zero-size chunk.
fn decode_chunked_body(raw: &str) -> Option<String> {
    let mut out = String::new();
    let mut rest = raw;
    loop {
        let (size_line, tail) = rest.split_once("\r\n")?;
        let size_field = size_line.split(';').next().unwrap_or(size_line).trim();
        let size = usize::from_str_radix(size_field, 16).ok()?;
        if size == 0 {
            return Some(out);
        }
        out.push_str(tail.get(..size)?);
        let after = tail.get(size..)?;
        rest = after.strip_prefix("\r\n").unwrap_or(after);
    }
}

/// Pure control for the client-wire decoder. The fixture server frames the client
/// JSON body with `transfer-encoding: chunked` (confirmed by the host prepatch
/// run), so `json_body` must strip the chunk framing before parsing. This runs
/// with no loopback bind, so it isolates the decode from the continuation cases.
#[test]
fn fa22072_client_wire_json_body_decodes_chunked_framing() {
    let body = r#"{"choices":[{"finish_reason":"stop","index":0,"message":{"content":"owned beta continuation complete","role":"assistant"}}],"id":"chatcmpl-beta","model":"beta-wire","object":"chat.completion","usage":{"completion_tokens":2,"prompt_tokens":3,"total_tokens":5}}"#;
    let wire = format!(
        "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\nconnection: close\r\ntransfer-encoding: chunked\r\ndate: Wed, 14 Oct 2026 09:13:18 GMT\r\n\r\n{:x}\r\n{}\r\n0\r\n\r\n",
        body.len(),
        body
    );
    let decoded = json_body(wire.as_bytes()).expect("chunked client wire must decode");
    assert_eq!(
        decoded["choices"][0]["message"]["content"].as_str(),
        Some(BETA_BUSINESS_TEXT)
    );
    assert_eq!(
        decoded["choices"][0]["finish_reason"].as_str(),
        Some("stop")
    );
    assert_eq!(decoded["usage"]["total_tokens"].as_u64(), Some(5));
    assert_eq!(decoded["model"].as_str(), Some(BETA_WIRE));
}

/// The single owner of the per-request sample directory for this fixture HOME.
fn samples_port_dir(port: u16) -> PathBuf {
    PathBuf::from(std::env::var("HOME").expect("fixture HOME must be set"))
        .join(".rcc")
        .join("codex-samples")
        .join("openai-chat-completions")
        .join("ports")
        .join(port.to_string())
}

/// Enumerates the per-request sample directories (each named for its request id).
fn request_dirs(port: u16) -> BTreeSet<String> {
    match std::fs::read_dir(samples_port_dir(port)) {
        Ok(entries) => entries
            .flatten()
            .filter(|entry| entry.path().is_dir())
            .filter_map(|entry| entry.file_name().into_string().ok())
            .collect(),
        Err(_) => BTreeSet::new(),
    }
}

/// Waits for the one new request directory this case's client request produced.
async fn wait_new_request_dir(
    port: u16,
    before: &BTreeSet<String>,
    limit: Duration,
) -> Option<String> {
    let deadline = tokio::time::Instant::now() + limit;
    loop {
        let now = request_dirs(port);
        let fresh: Vec<String> = now.difference(before).cloned().collect();
        if let Some(first) = fresh.first() {
            return Some(first.clone());
        }
        if tokio::time::Instant::now() >= deadline {
            return None;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
}

/// Reads the frozen failed-attempt artifact for one exact request directory.
fn read_failed_attempt_artifact(port: u16, request_id: &str) -> Option<Value> {
    let path = samples_port_dir(port)
        .join(request_id)
        .join(FAILED_ATTEMPT_FILE);
    let raw = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&raw).ok()
}

/// Waits (bounded) for the failed-attempt artifact of one exact request. The
/// diagnostic write is asynchronous, so a brief bounded poll keeps the assertion
/// about retention rather than about scheduling.
async fn wait_failed_attempt_artifact(
    port: u16,
    request_id: &str,
    limit: Duration,
) -> Option<Value> {
    let deadline = tokio::time::Instant::now() + limit;
    loop {
        if let Some(artifact) = read_failed_attempt_artifact(port, request_id) {
            return Some(artifact);
        }
        if tokio::time::Instant::now() >= deadline {
            return None;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
}

struct CaseOutcome {
    name: &'static str,
    request_id: Option<String>,
    artifact: Option<Value>,
}

/// Validates the frozen failed-attempt artifact for one case. Every failure is
/// recorded rather than panicked so all cases are reported together.
fn validate_case_artifact(case: &CaseOutcome, failures: &mut Vec<String>) {
    let Some(request_id) = case.request_id.as_ref() else {
        failures.push(format!(
            "{}: no per-request sample record was found under the isolated sample store, \
             so the failed-attempt artifact cannot be read for this exact request",
            case.name
        ));
        return;
    };
    let Some(artifact) = case.artifact.as_ref() else {
        failures.push(format!(
            "{}: {FAILED_ATTEMPT_FILE} is absent for request {request_id}; the failed \
             attempt's original typed source is not retained (expected prepatch RED)",
            case.name
        ));
        return;
    };
    if artifact["object"].as_str() != Some(FAILED_ATTEMPT_OBJECT) {
        failures.push(format!(
            "{}: artifact object must be {FAILED_ATTEMPT_OBJECT}, got {:?}",
            case.name, artifact["object"]
        ));
    }
    if artifact["request_id"].as_str() != Some(request_id.as_str()) {
        failures.push(format!(
            "{}: artifact request_id {:?} must equal the exact request {request_id}",
            case.name, artifact["request_id"]
        ));
    }
    let attempts = artifact["attempts"].as_array();
    let Some(attempts) = attempts else {
        failures.push(format!(
            "{}: artifact has no ordered attempts array",
            case.name
        ));
        return;
    };
    if attempts.len() != 1 {
        failures.push(format!(
            "{}: exactly one failed business attempt must be recorded, got {}",
            case.name,
            attempts.len()
        ));
        return;
    }
    let attempt = &attempts[0];
    if attempt["provider_id"].as_str() != Some("alpha") {
        failures.push(format!(
            "{}: failed attempt provider_id must be the first declared provider, got {:?}",
            case.name, attempt["provider_id"]
        ));
    }
    if attempt["model_id"].as_str() != Some(ALPHA_WIRE) {
        failures.push(format!(
            "{}: failed attempt model_id must be {ALPHA_WIRE}, got {:?}",
            case.name, attempt["model_id"]
        ));
    }
    if attempt["auth_alias"].as_str() != Some("alpha") {
        failures.push(format!(
            "{}: failed attempt auth_alias must be alpha, got {:?}",
            case.name, attempt["auth_alias"]
        ));
    }
    if attempt["action"].as_str() != Some("switch_provider") {
        failures.push(format!(
            "{}: failed attempt action must be switch_provider, got {:?}",
            case.name, attempt["action"]
        ));
    }
    let next_provider_key = attempt["next_provider_key"].as_str().unwrap_or_default();
    if next_provider_key != "beta:default:beta:beta-wire" {
        failures.push(format!(
            "{}: failed attempt next_provider_key must name the distinct successor beta, got {:?}",
            case.name, attempt["next_provider_key"]
        ));
    }
    // A projected internal status is not evidence of a real upstream head.
    let expected_status = match case.name {
        "json_http_503" => Some(503),
        "json_post_head_malformed" => Some(200),
        _ => None,
    };
    if attempt["provider_status"].as_u64() != expected_status {
        failures.push(format!(
            "{}: real upstream status must be {:?}, got {:?}; never substitute internal status",
            case.name, expected_status, attempt["provider_status"]
        ));
    }
    // Original typed Error01 source, never a reconstructed generic provider_error.
    let source = &attempt["diagnostic_source"];
    for field in ["source_kind", "source_stage", "code", "message"] {
        if source[field]
            .as_str()
            .map(str::trim)
            .map(str::is_empty)
            .unwrap_or(true)
        {
            failures.push(format!(
                "{}: diagnostic_source.{field} must be present and non-empty",
                case.name
            ));
        }
    }
    if matches!(
        source["message"].as_str(),
        Some("network error" | "provider_error" | "provider_failure")
    ) {
        failures.push(format!(
            "{}: diagnostic_source.message is the reduced generic projection, not the original source",
            case.name
        ));
    }
    if source["source_kind"].as_str() != Some("provider_failure") {
        failures.push(format!(
            "{}: typed source kind differs from the raised provider failure",
            case.name
        ));
    }
    let expected_stage = if case.name == "json_post_head_malformed" {
        "V3ProviderRespInbound01Raw"
    } else {
        "V3ProviderReqOutbound09TransportRequest"
    };
    if source["source_stage"].as_str() != Some(expected_stage) {
        failures.push(format!(
            "{}: original stage must be {expected_stage}, got {:?}",
            case.name, source["source_stage"]
        ));
    }
    if case.name == "json_post_head_malformed"
        && !source["message"]
            .as_str()
            .unwrap_or_default()
            .contains("provider JSON response decode failed:")
    {
        failures.push(format!("{}: response decoding cause was lost", case.name));
    }
    if case.name.ends_with("pre_head_drop")
        && !source["message"]
            .as_str()
            .unwrap_or_default()
            .contains("error sending request")
    {
        failures.push(format!("{}: original transport cause was lost", case.name));
    }
    if case.name == "json_http_503" {
        // The original Error01 link deliberately has no policy status assigned
        // as upstream HTTP. The independently retained provider_status proves
        // the real received head; preserve this original link without forging it.
        let external = &source["external_error"];
        if !external["status"].is_null()
            || external["provider_id"].as_str() != Some("alpha")
            || external["code"].as_str() != Some("server_error")
            || external["message"].as_str() != Some(ALPHA_PRIVATE_CAUSE)
        {
            failures.push(format!(
                "{}: original typed external link must survive unchanged, got {:?}",
                case.name, external
            ));
        }
        if !source["message"]
            .as_str()
            .unwrap_or_default()
            .contains(ALPHA_PRIVATE_CAUSE)
        {
            failures.push(format!(
                "{}: HTTP 503 attempt must preserve the provider response body/witness",
                case.name
            ));
        }
    }
    if matches!(
        case.name,
        "json_http_503" | "json_post_head_body_read_failure"
    ) {
        let evidence = &attempt["failed_attempt_evidence"];
        if evidence["attempt"].as_u64() != Some(FAILED_ATTEMPT_ATTEMPT_ID as u64) {
            failures.push(format!(
                "{}: failed attempt must retain the actual admitted transport ordinal {}, got {:?}",
                case.name, FAILED_ATTEMPT_ATTEMPT_ID, evidence["attempt"]
            ));
        }
        let request = &evidence["provider_request"];
        if request["method"].as_str() != Some("POST")
            || request["body"]["messages"][0]["content"].as_str() != Some(REQUEST_MARKER)
            || request["body"]["model"].as_str() != Some(ALPHA_WIRE)
        {
            failures.push(format!(
                "{}: failed attempt must retain the exact admitted provider request projection, got {:?}",
                case.name, request
            ));
        }
        let request_headers = request["headers"].as_object().cloned().unwrap_or_default();
        if request_headers
            .values()
            .any(|value| value.as_str().unwrap_or_default().contains(ALPHA_KEY))
        {
            failures.push(format!(
                "{}: failed attempt request headers retained a synthetic credential",
                case.name
            ));
        }
        let response = &evidence["provider_response"];
        let expected_response_status = if case.name == "json_http_503" {
            503
        } else {
            200
        };
        if response["kind"].as_str() != Some("external_http")
            || response["status"].as_u64() != Some(expected_response_status)
        {
            failures.push(format!(
                "{}: failed attempt must retain the real HTTP {} response head, got {:?}",
                case.name, expected_response_status, response
            ));
        }
        let bytes = response["body"]["bytes"]
            .as_array()
            .map(|bytes| {
                bytes
                    .iter()
                    .filter_map(serde_json::Value::as_u64)
                    .map(|byte| byte as u8)
                    .collect::<Vec<u8>>()
            })
            .unwrap_or_default();
        let raw_body = String::from_utf8_lossy(&bytes);
        if case.name == "json_http_503" && !raw_body.contains(ALPHA_PRIVATE_CAUSE) {
            failures.push(format!(
                "{}: failed attempt body must preserve the provider failure bytes, got {:?}",
                case.name, response["body"]
            ));
        }
        if case.name == "json_http_503"
            && (!raw_body.contains("alpha_owned_failure")
                || response["body"]["redacted"].as_bool() != Some(true)
                || raw_body.contains(ALPHA_RESPONSE_SECRET))
        {
            failures.push(format!(
                "{}: failed attempt body must preserve the 503 business bytes with credential fields redacted, got {:?}",
                case.name, response["body"]
            ));
        }
        let response_headers = response["headers"].as_array().cloned().unwrap_or_default();
        if !response_headers.iter().any(|header| {
            header["name"].as_str() == Some("x-routecodex-fixture")
                && header["value"].as_str() == Some(ALPHA_NONCREDENTIAL_HEADER)
        }) || response_headers.iter().any(|header| {
            header["value"]
                .as_str()
                .unwrap_or_default()
                .contains(ALPHA_RESPONSE_SECRET)
        }) {
            failures.push(format!(
                "{}: failed attempt headers must retain noncredential evidence and remove credentials, got {:?}",
                case.name, response_headers
            ));
        }
        if case.name == "json_post_head_body_read_failure" {
            if !bytes.is_empty()
                || response["body"]["redacted"].as_bool() != Some(false)
                || response["body_read_failure"]
                    .as_str()
                    .unwrap_or_default()
                    .is_empty()
            {
                failures.push(format!(
                    "{}: received head must retain an empty unreadable body and explicit body-read failure, got {:?}",
                    case.name, response
                ));
            }
        }
    }
    if case.name.ends_with("pre_head_drop") {
        let evidence = &attempt["failed_attempt_evidence"];
        if evidence["attempt"].as_u64() != Some(FAILED_ATTEMPT_ATTEMPT_ID as u64)
            || evidence["provider_request"]["method"].as_str() != Some("POST")
            || evidence["provider_response"]["kind"].as_str() != Some("no_response")
        {
            failures.push(format!(
                "{}: post-admission pre-head failure must retain attempt 1, request, and no_response without borrowing another response, got {:?}",
                case.name, evidence
            ));
        }
    }
}

/// Private markers that must never reach the client. They cover the typed source
/// channel, the policy action, the reduced generic projection and provider auth.
fn client_leak_markers() -> Vec<&'static str> {
    vec![
        ALPHA_PRIVATE_CAUSE,
        "diagnostic_source",
        "switch_provider",
        "provider_error",
        "network error",
        ALPHA_KEY,
        BETA_KEY,
    ]
}

/// Collects every failed-attempt continuation case, evaluates all continuation
/// controls, then applies the frozen private-artifact assertion last.
#[tokio::test]
async fn fa22072_chat_failed_attempt_recovers_with_source_public_entry() {
    let (home, _lock) = TEST_LOCK.lock().await;
    std::env::set_var(ALPHA_KEY_ENV, ALPHA_KEY);
    std::env::set_var(BETA_KEY_ENV, BETA_KEY);

    let alpha_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let alpha_port = alpha_listener.local_addr().unwrap().port();
    let beta_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let beta_port = beta_listener.local_addr().unwrap().port();
    // One ordered sequence shared by both owned providers. The fixture records
    // the provider label each time it captures a full request so every case can
    // assert the observed attempt order, not merely two separate counts.
    let order: Arc<Mutex<Vec<&'static str>>> = Arc::new(Mutex::new(Vec::new()));
    let alpha = Arc::new(AlphaPeer::new(order.clone()));
    let beta = Arc::new(BetaPeer::new(order.clone()));
    let alpha_task = tokio::spawn(serve_alpha(alpha_listener, alpha.clone()));
    let beta_task = tokio::spawn(serve_beta(beta_listener, beta.clone()));

    let server_port = test_ports::free_port();
    let manifest = manifest(server_port, alpha_port, beta_port);
    let handle = spawn_v3_server_aggregate(manifest).await.unwrap();
    let listener_port = handle.listeners[0].addr.port();
    let base = format!("http://{}", handle.listeners[0].addr);

    eprintln!(
        "fa22072-r34 fixture pid={} alpha=127.0.0.1:{} beta=127.0.0.1:{} server=127.0.0.1:{}",
        std::process::id(),
        alpha_port,
        beta_port,
        listener_port
    );

    let case_defs: [(&'static str, AlphaBehavior, bool); 5] = [
        ("json_pre_head_drop", AlphaBehavior::PreHeadDrop, false),
        ("sse_pre_head_drop", AlphaBehavior::PreHeadDrop, true),
        ("json_http_503", AlphaBehavior::Http503, false),
        (
            "json_post_head_body_read_failure",
            AlphaBehavior::PostHeadBodyReadFailure,
            false,
        ),
        (
            "json_post_head_malformed",
            AlphaBehavior::PostHeadMalformedJson,
            false,
        ),
    ];

    let mut controls: Vec<String> = Vec::new();
    let mut cases: Vec<CaseOutcome> = Vec::new();
    let markers = client_leak_markers();

    for (name, behavior, stream) in case_defs {
        alpha.set_behavior(behavior).await;
        let before = request_dirs(listener_port);
        let alpha_before = alpha.count().await;
        let beta_before = beta.count().await;
        let order_before = order.lock().await.len();

        let (arrived_tx, arrived_rx) = oneshot::channel::<()>();
        let (release_tx, release_rx) = oneshot::channel::<()>();
        *beta.arrived.lock().await = Some(arrived_tx);
        *beta.release.lock().await = Some(release_rx);

        let probe = issue_client(listener_port, stream).await;

        match timeout(Duration::from_secs(20), arrived_rx).await {
            Ok(Ok(())) => {}
            other => {
                controls.push(format!(
                    "{name}: the distinct declared provider B never received the continuation \
                     attempt (arrival={other:?})"
                ));
                let _ = release_tx.send(());
                wait_closed(&probe, Duration::from_secs(5)).await;
                probe.abort();
                cases.push(CaseOutcome {
                    name,
                    request_id: None,
                    artifact: None,
                });
                continue;
            }
        }

        // Before releasing B: the client transport must still be open and must not
        // show completion, business content, an error payload or any private cause.
        // A transport-only SSE keepalive is allowed.
        let pre = probe.snapshot().await;
        let pre_text = String::from_utf8_lossy(&pre).to_string();
        let pre_clean = !pre_text.contains("[DONE]")
            && !pre_text.contains("data:")
            && !pre_text.contains(BETA_BUSINESS_TEXT)
            && !pre_text.contains("event: error")
            && !pre_text.contains("\"error\"")
            && !pre_text.contains(ALPHA_PRIVATE_CAUSE)
            && markers.iter().all(|marker| !pre_text.contains(marker));
        if probe.is_closed() || !pre_clean {
            controls.push(format!(
                "{name}: client transport was not held cleanly before provider B released \
                 (closed={} bytes={pre_text:?})",
                probe.is_closed()
            ));
        }

        let _ = release_tx.send(());
        wait_closed(&probe, Duration::from_secs(20)).await;
        let wire = probe.snapshot().await;
        probe.abort();
        let text = String::from_utf8_lossy(&wire).to_string();

        // After release: exactly B's real business result, and no private leak.
        let beta_ok = text.contains("HTTP/1.1 200")
            && text.contains(BETA_BUSINESS_TEXT)
            && text.contains("\"finish_reason\":\"stop\"");
        if !beta_ok {
            controls.push(format!(
                "{name}: client did not receive provider B's real business result: {text:?}"
            ));
        }
        if stream && !text.contains("[DONE]") {
            controls.push(format!(
                "{name}: SSE client result did not terminate with [DONE]"
            ));
        }
        if !stream && text.contains("text/event-stream") {
            controls.push(format!("{name}: JSON client received an SSE transport"));
        }
        if !stream {
            // The exact B content/model/finish/usage the client protocol can
            // faithfully represent.
            match json_body(&wire) {
                None => controls.push(format!(
                    "{name}: JSON client body was not a decodable JSON result: {text:?}"
                )),
                Some(body) => {
                    if body["choices"][0]["message"]["content"].as_str() != Some(BETA_BUSINESS_TEXT)
                    {
                        controls.push(format!(
                            "{name}: JSON client content must be exactly B's business text, got {:?}",
                            body["choices"][0]["message"]["content"]
                        ));
                    }
                    if body["choices"][0]["finish_reason"].as_str() != Some("stop") {
                        controls.push(format!(
                            "{name}: JSON client finish_reason must be stop, got {:?}",
                            body["choices"][0]["finish_reason"]
                        ));
                    }
                    if body["usage"]["total_tokens"].as_u64() != Some(5) {
                        controls.push(format!(
                            "{name}: JSON client usage must be projected from B, got {:?}",
                            body["usage"]
                        ));
                    }
                    if body["model"].as_str() != Some(BETA_WIRE) {
                        controls.push(format!(
                            "{name}: JSON client model must be representable, got {:?}",
                            body["model"]
                        ));
                    }
                    eprintln!(
                        "fa22072-r34 case={name} json_client_model={:?}",
                        body["model"]
                    );
                }
            }
        }
        for marker in &markers {
            if text.contains(marker) {
                controls.push(format!(
                    "{name}: client payload leaked private/provider error marker {marker:?}: {text:?}"
                ));
            }
        }

        let alpha_after = alpha.count().await;
        let beta_after = beta.count().await;
        if alpha_after - alpha_before != 1 {
            controls.push(format!(
                "{name}: first declared provider must be attempted exactly once, observed {}",
                alpha_after - alpha_before
            ));
        }
        if beta_after - beta_before != 1 {
            controls.push(format!(
                "{name}: distinct successor provider must be attempted exactly once, observed {}",
                beta_after - beta_before
            ));
        }
        // Ordered observation for this case: alpha must capture the first attempt
        // and beta the continuation, not merely the same totals in any order.
        let ordered = order.lock().await.clone();
        let observed_order: &[&'static str] = &ordered[order_before..];
        let expected_order: &[&str] = &["alpha", "beta"];
        if observed_order != expected_order {
            controls.push(format!(
                "{name}: the ordered provider attempts must be [alpha, beta], got {observed_order:?}"
            ));
        }

        // Synthetic per-provider auth plus preserved model/messages/tools/history.
        let expected_beta_auth = format!("Bearer {BETA_KEY}");
        let expected_alpha_auth = format!("Bearer {ALPHA_KEY}");
        match beta.last().await {
            None => controls.push(format!("{name}: no successor provider capture recorded")),
            Some(capture) => {
                if capture.authorization.as_deref() != Some(expected_beta_auth.as_str()) {
                    controls.push(format!(
                        "{name}: successor auth must be bound to its own synthetic key, got {:?}",
                        capture.authorization
                    ));
                }
                if capture.body["model"].as_str() != Some(BETA_WIRE) {
                    controls.push(format!(
                        "{name}: successor wire model must be {BETA_WIRE}, got {:?}",
                        capture.body["model"]
                    ));
                }
                if capture.body["messages"][0]["content"].as_str() != Some(REQUEST_MARKER) {
                    controls.push(format!(
                        "{name}: successor did not preserve the client request messages"
                    ));
                }
                if capture.body["tools"][0]["function"]["name"].as_str() != Some("lookup") {
                    controls.push(format!(
                        "{name}: successor did not preserve the declared tools"
                    ));
                }
                let message_count = capture.body["messages"]
                    .as_array()
                    .map(|messages| messages.len())
                    .unwrap_or(0);
                if message_count != 3 {
                    controls.push(format!(
                        "{name}: successor did not preserve the paired history (got {message_count} messages)"
                    ));
                }
                if capture.body["messages"][1]["tool_calls"][0]["id"].as_str() != Some(TOOL_CALL_ID)
                {
                    controls.push(format!(
                        "{name}: successor did not preserve the tool-call id/history"
                    ));
                }
            }
        }
        match alpha.last().await {
            None => controls.push(format!("{name}: no first provider capture recorded")),
            Some(capture) => {
                if capture.authorization.as_deref() != Some(expected_alpha_auth.as_str()) {
                    controls.push(format!(
                        "{name}: first provider auth must be bound to its own synthetic key, got {:?}",
                        capture.authorization
                    ));
                }
                if capture.body["model"].as_str() != Some(ALPHA_WIRE) {
                    controls.push(format!(
                        "{name}: first provider wire model must be {ALPHA_WIRE}, got {:?}",
                        capture.body["model"]
                    ));
                }
                if capture.body["messages"][0]["content"].as_str() != Some(REQUEST_MARKER) {
                    controls.push(format!(
                        "{name}: first provider did not receive the client request messages"
                    ));
                }
            }
        }

        // Exactly one client request produced exactly one new request sample dir.
        let request_id =
            wait_new_request_dir(listener_port, &before, Duration::from_secs(10)).await;
        if request_id.is_none() {
            controls.push(format!(
                "{name}: no new per-request sample record appeared for the client request"
            ));
        }
        let artifact = match request_id.as_ref() {
            Some(request_id) => {
                wait_failed_attempt_artifact(listener_port, request_id, Duration::from_secs(3))
                    .await
            }
            None => None,
        };
        cases.push(CaseOutcome {
            name,
            request_id,
            artifact,
        });
    }

    // Public Server diagnostic record: enumerate the exact request ids the runtime
    // observed, so the artifact read is bound to each exact request, not the first file.
    let client = reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(5))
        .build()
        .unwrap();
    let logs_body: Value = client
        .get(format!("{base}/_routecodex/debug/logs"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let diagnostic_request_ids: BTreeSet<String> = logs_body["logs"]
        .as_array()
        .cloned()
        .unwrap_or_default()
        .iter()
        .filter_map(|event| event["request_id"].as_str().map(str::to_string))
        .collect();
    let case_request_ids: BTreeSet<String> = cases
        .iter()
        .filter_map(|case| case.request_id.clone())
        .collect();
    eprintln!(
        "fa22072-r34 diagnostic request_ids={diagnostic_request_ids:?} case_request_ids={case_request_ids:?}"
    );
    for case in &cases {
        eprintln!(
            "fa22072-r34 case={} request_id={:?} artifact_present={}",
            case.name,
            case.request_id,
            case.artifact.is_some()
        );
    }

    // Release the owned activity/lease, then drain every owned fixture resource
    // before the aggregate assertions so the expected RED cannot race cleanup.
    let preparation = timeout(Duration::from_secs(5), handle.prepare_exec_attempt()).await;
    let lease_released = matches!(&preparation, Ok(Ok(_)));
    drop(preparation);
    let persist_failures = handle.shutdown().await;
    alpha_task.abort();
    beta_task.abort();
    let _ = alpha_task.await;
    let _ = beta_task.await;
    std::env::remove_var(ALPHA_KEY_ENV);
    std::env::remove_var(BETA_KEY_ENV);
    drop(home);

    assert!(
        lease_released,
        "owned request activity/lease was not released before shutdown"
    );
    assert!(
        persist_failures.is_empty(),
        "fixture sample persist failures: {persist_failures:?}"
    );
    assert!(
        controls.is_empty(),
        "fa22072-r34 failed-attempt continuation controls failed: {controls:?}"
    );

    // Frozen private-artifact acceptance. Prepatch source retains no failed-attempt
    // source/artifact, so this is the EXPECTED RED, evaluated after every
    // continuation control above has already been checked.
    let mut artifact_failures: Vec<String> = Vec::new();
    if case_request_ids.len() != cases.len() {
        artifact_failures.push(format!(
            "each continuation case must bind to exactly one distinct per-request sample \
             record so the failed-attempt artifact is read for EACH exact request, not the \
             first file: cases={:?} request_ids={case_request_ids:?}",
            cases.iter().map(|case| case.name).collect::<Vec<_>>()
        ));
    }
    for case in &cases {
        validate_case_artifact(case, &mut artifact_failures);
    }
    assert!(
        artifact_failures.is_empty(),
        "fa22072-r34 RED: failed-attempt original source/artifact not retained. \
         Continuation controls passed (one client request, A=1/B=1 in order, held \
         transport, real B result), but the internal evidence is missing or incomplete: \
         {artifact_failures:?}"
    );
}
