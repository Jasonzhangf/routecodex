//! fa22072 E1: Chat Relay provider-terminal diagnostic-loss causal control.
//!
//! Accepted plan: `/private/tmp/routecodex-fa22072-01a133d7/noresponse-plan-r32/plan.md`
//! section 4. This file implements only that section.
//!
//! One synthetic Chat Relay listener runs against one synthetic provider peer.
//! The peer offers two behaviors that differ only by whether it sends a legal
//! HTTP response head:
//!
//! - GOOD: capture the full provider request, then answer a real Chat 200 with
//!   `owned step5 complete` and a legal `finish_reason=stop`.
//! - DROP: capture the full provider request, then close its own upstream
//!   connection before any HTTP response head.
//!
//! The test collects the whole GOOD -> DROP -> GOOD behavior for both JSON and
//! SSE, reads the public Runtime consumer receipt and the public Server wire, and
//! only then applies the aggregate diagnostic assertion.
//!
//! Stable test ID: `fa22072_chat_noresponse_cause_public_entry`.
//!
//! E1 RED: Runtime exposes a classification and traversal chain for the DROP,
//! while the Server does not record that chain. The generic `provider_error`
//! detail is not an actual cause. A separate public Error consumer checks that
//! the original typed source survives the Error05 -> Error06 boundary.

use routecodex_v3_config::{
    compile_v3_config_05_manifest, parse_v3_config_02_authoring, V3Config05ManifestPublished,
};
use routecodex_v3_error::{
    build_v3_error_01_source_raised, V3ErrorActionScope, V3ErrorHandlingCenter,
    V3ErrorHandlingCenterInput, V3ErrorSourceKind, V3ProviderFailureSessionScope,
};
use routecodex_v3_runtime::{
    execute_v3_openai_chat_relay_runtime_with_default_transport_provider_health_and_execution_mode,
    project_v3_openai_chat_relay_runtime_failure, V3HubExecutionMode,
    V3OpenAiChatRelayRuntimeInput, V3OpenAiChatRelayRuntimeOutput, V3ProviderFailureRuntimeHealth,
};
use routecodex_v3_server::spawn_v3_server_aggregate;
use serde_json::{json, Value};
use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::Mutex;
use tokio::time::timeout;

#[path = "../../../crates/routecodex-v3-runtime/tests/support/hub_v1_fixture.rs"]
mod hub_v1_fixture;
#[path = "support/fa22072_test_home.rs"]
mod test_home;
#[path = "../../../crates/routecodex-v3-runtime/tests/support/test_ports.rs"]
mod test_ports;

static TEST_LOCK: test_home::ServerTestLock = test_home::ServerTestLock::new();

const AUTH_ENV: &str = "FA22072_CAUSE_KEY";
const AUTH_VALUE: &str = "owned-fixture-key";
const CLIENT_MODEL: &str = "test.step-5-preview";
const WIRE_MODEL: &str = "step-5-preview";
const REQUEST_MARKER: &str = "owned step5 request";
const BUSINESS_TEXT: &str = "owned step5 complete";

/// The single peer knob. The only difference between the two behaviors is whether
/// a legal HTTP response head and business payload are sent.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum PeerBehavior {
    Good,
    Drop,
}

#[derive(Clone, Debug)]
struct PeerCapture {
    authorization: Option<String>,
    body: Value,
}

struct Peer {
    behavior: Mutex<PeerBehavior>,
    captures: Mutex<Vec<PeerCapture>>,
}

impl Peer {
    fn new() -> Self {
        Self {
            behavior: Mutex::new(PeerBehavior::Good),
            captures: Mutex::new(Vec::new()),
        }
    }

    async fn set_behavior(&self, behavior: PeerBehavior) {
        *self.behavior.lock().await = behavior;
    }

    async fn captures(&self) -> Vec<PeerCapture> {
        self.captures.lock().await.clone()
    }
}

/// Owned synthetic provider peer. It binds an ephemeral loopback port and never
/// touches any live runtime, config, or secret.
async fn serve_peer(listener: TcpListener, peer: Arc<Peer>) {
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
            let authorization = head.lines().find_map(|line| {
                let (name, value) = line.split_once(':')?;
                name.eq_ignore_ascii_case("authorization")
                    .then(|| value.trim().to_string())
            });
            let request_body: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
            let behavior = *peer.behavior.lock().await;
            peer.captures.lock().await.push(PeerCapture {
                authorization,
                body: request_body.clone(),
            });
            if behavior == PeerBehavior::Drop {
                // Close this owned upstream connection before any HTTP response
                // head. Dropping the socket is the whole failure; no timeout, no
                // error status, no illegal business payload, no signal.
                drop(socket);
                return;
            }
            let _ = write_good_response(&mut socket, &request_body).await;
        });
    }
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

async fn write_good_response(socket: &mut TcpStream, request: &Value) -> std::io::Result<()> {
    let streaming = request.get("stream").and_then(Value::as_bool) == Some(true);
    let (content_type, body) = if streaming {
        (
            "text/event-stream",
            concat!(
                "data: {\"id\":\"chatcmpl-owned\",\"object\":\"chat.completion.chunk\",\"model\":\"step-5-preview\",\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"content\":\"owned step5 complete\"},\"finish_reason\":null}]}\n\n",
                "data: {\"id\":\"chatcmpl-owned\",\"object\":\"chat.completion.chunk\",\"model\":\"step-5-preview\",\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n",
                "data: [DONE]\n\n",
            )
            .to_string(),
        )
    } else {
        (
            "application/json",
            serde_json::to_string(&json!({
                "id": "chatcmpl-owned",
                "object": "chat.completion",
                "model": WIRE_MODEL,
                "choices": [{
                    "index": 0,
                    "message": {"role": "assistant", "content": BUSINESS_TEXT},
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

/// Explicit Chat Relay entry, one candidate, provider health disabled.
fn manifest(server_port: u16, peer_port: u16) -> V3Config05ManifestPublished {
    let direct_binding = r#"{ entry_protocol = "openai_chat", endpoint_patterns = ["/v1/chat/completions"], execution_mode = "direct", protocol_profile_owner = "v3.entry_protocol_registry_contract", implemented = true, forbidden_reentry_behavior = "OpenAI Chat endpoint must not fall through to Responses Direct or pending runtime.", runtime_owner_symbol = "execute_v3_openai_chat_direct_server_outcome", runtime_owner_path = "v3/crates/routecodex-v3-server/src/executors.rs" }"#;
    let relay_binding = r#"{ entry_protocol = "openai_chat", endpoint_patterns = ["/v1/chat/completions"], execution_mode = "relay", protocol_profile_owner = "v3.entry_protocol_registry_contract", implemented = true, forbidden_reentry_behavior = "OpenAI Chat endpoint must not fall through to Responses Direct or pending runtime.", runtime_owner_symbol = "execute_v3_openai_chat_relay_runtime_with_default_transport", runtime_owner_path = "v3/crates/routecodex-v3-runtime/src/hub_v1/openai_chat_relay_runtime.rs" }"#;
    let declaration =
        hub_v1_fixture::hub_v1_test_declaration().replace(direct_binding, relay_binding);
    assert!(
        declaration.contains("execution_mode = \"relay\""),
        "the openai_chat entry must be pinned to Chat Relay"
    );
    let execution = hub_v1_fixture::hub_v1_server_execution("owned");
    let source = format!(
        r#"
version = 3
{declaration}
[servers.owned]
bind = "127.0.0.1"
port = {server_port}
routing_group = "owned"
endpoints = ["openai_chat"]
{execution}
[servers.owned.execution.attempt_store]
request_max_attempts = 1
[providers.test]
type = "openai_chat"
base_url = "http://127.0.0.1:{peer_port}/v1"
default_model = "{wire_model}"
auth = {{ type = "api_key", entries = [{{ alias = "key", env = "{auth_env}" }}] }}
health = {{ enabled = false, failure_threshold = 1, cooldown_ms = 5000 }}
[providers.test.models.{wire_model}]
wire_name = "{wire_model}"
capabilities = ["text"]
max_context_tokens = 1000000
[debug]
log_console = false
snapshots = false
codex_samples = true
[route_groups.owned.pools.default]
selection = {{ strategy = "priority" }}
targets = [{{ kind = "provider_model", provider = "test", model = "{wire_model}", key = "key", priority = 1 }}]
"#,
        declaration = declaration,
        execution = execution,
        server_port = server_port,
        peer_port = peer_port,
        wire_model = WIRE_MODEL,
        auth_env = AUTH_ENV,
    );
    compile_v3_config_05_manifest(parse_v3_config_02_authoring(&source).unwrap()).unwrap()
}

fn step5_payload(stream: bool) -> Value {
    json!({
        "model": CLIENT_MODEL,
        "messages": [{"role": "user", "content": REQUEST_MARKER}],
        "stream": stream
    })
}

/// Public Runtime consumer. It reuses the same declaration and peer behavior as
/// the HTTP listener. If the runtime returns a typed error, it is projected
/// through the public failure projection so the receipt keeps the same fields the
/// Server sees.
async fn runtime_drop(
    manifest: &V3Config05ManifestPublished,
    request_id: &str,
    payload: &Value,
) -> (V3OpenAiChatRelayRuntimeOutput, bool) {
    let health = V3ProviderFailureRuntimeHealth::from_manifest_for_isolated_tests(manifest);
    let input = V3OpenAiChatRelayRuntimeInput {
        server_id: "owned".to_string(),
        failure_session_scope: V3ProviderFailureSessionScope::new("owned", "owned", request_id)
            .expect("typed failure session scope"),
        request_id: request_id.to_string(),
        payload: payload.clone(),
    };
    match execute_v3_openai_chat_relay_runtime_with_default_transport_provider_health_and_execution_mode(
        manifest,
        input,
        health,
        V3HubExecutionMode::Relay,
    )
    .await
    {
        Ok(output) => (output, false),
        Err(error) => (project_v3_openai_chat_relay_runtime_failure(error), true),
    }
}

/// Raw Server entry. The raw client keeps the exact wire so the assertion can
/// state "zero bytes" or "transport head plus comment then break".
async fn raw_server_request(port: u16, stream: bool) -> Vec<u8> {
    let body = step5_payload(stream).to_string();
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
    let mut bytes = Vec::new();
    let result = timeout(Duration::from_secs(15), socket.read_to_end(&mut bytes))
        .await
        .expect("an owned request must terminate");
    if let Err(error) = result {
        assert!(
            matches!(
                error.kind(),
                std::io::ErrorKind::ConnectionReset | std::io::ErrorKind::UnexpectedEof
            ),
            "unexpected read error: {error}"
        );
    }
    bytes
}

fn body_section(bytes: &[u8]) -> String {
    let text = String::from_utf8_lossy(bytes).to_string();
    text.split_once("\r\n\r\n")
        .map(|(_, body)| body.to_string())
        .unwrap_or_default()
}

fn samples_port_dir(port: u16) -> PathBuf {
    PathBuf::from(std::env::var("HOME").expect("fixture HOME must be set"))
        .join(".rcc")
        .join("codex-samples")
        .join("openai-chat-completions")
        .join("ports")
        .join(port.to_string())
}

fn read_terminal_evidence(dir: &Path) -> Option<Value> {
    let entries = std::fs::read_dir(dir).ok()?;
    for entry in entries.flatten() {
        let path = entry.path().join("provider-terminal.json");
        if let Ok(raw) = std::fs::read_to_string(&path) {
            if let Ok(value) = serde_json::from_str::<Value>(&raw) {
                return Some(value);
            }
        }
    }
    None
}

async fn wait_for_terminal_evidence(dir: &Path) -> Option<Value> {
    // File waiting stays in this test observer only; it never couples to a
    // production completion path.
    for _ in 0..200 {
        if let Some(value) = read_terminal_evidence(dir) {
            return Some(value);
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    None
}

fn capture_projection(capture: &PeerCapture) -> (String, Value, bool) {
    (
        capture.body["model"]
            .as_str()
            .unwrap_or_default()
            .to_string(),
        capture.body["messages"].clone(),
        capture.body["stream"].as_bool().unwrap_or(false),
    )
}

/// Collects every GOOD/DROP/GOOD behavior for JSON and SSE, then applies one
/// aggregate diagnostic assertion. Causal controls are recorded and asserted
/// before the diagnostic assertion so they survive the expected RED.
#[tokio::test]
async fn fa22072_chat_noresponse_cause_public_entry() {
    let (_home, _lock) = TEST_LOCK.lock().await;
    std::env::set_var(AUTH_ENV, AUTH_VALUE);

    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let peer_port = listener.local_addr().unwrap().port();
    let peer = Arc::new(Peer::new());
    let peer_task = tokio::spawn(serve_peer(listener, peer.clone()));

    let server_port = test_ports::free_port();
    let manifest = manifest(server_port, peer_port);
    let handle = spawn_v3_server_aggregate(manifest.clone()).await.unwrap();
    let listener_port = handle.listeners[0].addr.port();
    let base = format!("http://{}", handle.listeners[0].addr);
    let client = reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(15))
        .build()
        .unwrap();

    eprintln!(
        "fa22072-e1 fixture pid={} peer=127.0.0.1:{} server=127.0.0.1:{}",
        std::process::id(),
        peer_port,
        listener_port
    );

    // JSON GOOD -> DROP(runtime + server) -> GOOD.
    peer.set_behavior(PeerBehavior::Good).await;
    let json_good = raw_server_request(listener_port, false).await;
    peer.set_behavior(PeerBehavior::Drop).await;
    let (runtime_json_drop, runtime_json_drop_is_err) = runtime_drop(
        &manifest,
        "owned-e1-runtime-json-drop",
        &step5_payload(false),
    )
    .await;
    let json_drop = raw_server_request(listener_port, false).await;
    peer.set_behavior(PeerBehavior::Good).await;
    let json_good_again = raw_server_request(listener_port, false).await;

    // SSE GOOD -> DROP(runtime + server) -> GOOD.
    peer.set_behavior(PeerBehavior::Good).await;
    let sse_good = raw_server_request(listener_port, true).await;
    peer.set_behavior(PeerBehavior::Drop).await;
    let (runtime_sse_drop, runtime_sse_drop_is_err) =
        runtime_drop(&manifest, "owned-e1-runtime-sse-drop", &step5_payload(true)).await;
    let sse_drop = raw_server_request(listener_port, true).await;
    peer.set_behavior(PeerBehavior::Good).await;
    let sse_good_again = raw_server_request(listener_port, true).await;

    let captures = peer.captures().await;

    // Public Server internal diagnostic: the listener debug log plus the fixture
    // provider-terminal evidence file.
    let logs_body: Value = client
        .get(format!("{base}/_routecodex/debug/logs"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let events = logs_body["logs"].as_array().cloned().unwrap_or_default();
    let request_ids: BTreeSet<String> = events
        .iter()
        .filter_map(|event| event["request_id"].as_str().map(str::to_string))
        .collect();
    let server_chain_events: Vec<Value> = events
        .iter()
        .filter(|event| event["node_id"] == "V3Error06ClientProjected")
        .map(|event| event["details"]["error_chain"].clone())
        .collect();
    let sample_dir = samples_port_dir(listener_port);
    let mut terminal_sources = Vec::new();
    for entry in std::fs::read_dir(&sample_dir).unwrap().flatten() {
        if !entry.path().join("provider-terminal.json").is_file() {
            continue;
        }
        let request_id = entry.file_name().to_string_lossy().to_string();
        let raw = std::fs::read(entry.path().join("provider-failed-attempts.json"));
        let artifact = raw
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok());
        terminal_sources.push((request_id, artifact));
    }
    let server_retains_error_chain = terminal_sources.len() == 2
        && terminal_sources.iter().all(|(id, artifact)| {
            let Some(artifact) = artifact else {
                return false;
            };
            let source = &artifact["terminal_source"];
            request_ids.contains(id)
                && artifact["request_id"].as_str() == Some(id.as_str())
                && source["source_kind"] == "provider_failure"
                && source["source_stage"] == "V3ProviderReqOutbound09TransportRequest"
                && source["code"] == "provider_error"
                && source["message"]
                    .as_str()
                    .is_some_and(|message| message.contains("error sending request"))
        });
    let terminal_evidence = wait_for_terminal_evidence(&samples_port_dir(listener_port)).await;

    let runtime_json_detail = runtime_json_drop.error_detail.clone().unwrap_or_default();
    let runtime_sse_detail = runtime_sse_drop.error_detail.clone().unwrap_or_default();

    eprintln!(
        "fa22072-e1 runtime json-drop: terminal={:?} error_class={:?} error_detail={:?} error_chain={:?} node_trace={:?} projected_err={}",
        runtime_json_drop.terminal_disposition,
        runtime_json_drop.error_class,
        runtime_json_drop.error_detail,
        runtime_json_drop.error_chain,
        runtime_json_drop.node_trace,
        runtime_json_drop_is_err
    );
    eprintln!(
        "fa22072-e1 runtime sse-drop: terminal={:?} error_class={:?} error_detail={:?} error_chain={:?} node_trace={:?} projected_err={}",
        runtime_sse_drop.terminal_disposition,
        runtime_sse_drop.error_class,
        runtime_sse_drop.error_detail,
        runtime_sse_drop.error_chain,
        runtime_sse_drop.node_trace,
        runtime_sse_drop_is_err
    );
    eprintln!(
        "fa22072-e1 server wire: json_good={} json_drop={} json_good_again={} sse_good={} sse_drop={} sse_good_again={}",
        json_good.len(),
        json_drop.len(),
        json_good_again.len(),
        sse_good.len(),
        sse_drop.len(),
        sse_good_again.len()
    );
    eprintln!(
        "fa22072-e1 server diagnostic: request_ids={:?} error06_events={} server_retains_cause={} terminal_evidence={:?}",
        request_ids, server_chain_events.len(), server_retains_error_chain, terminal_evidence
    );

    // Causal controls. Every observation is recorded before the diagnostic
    // assertion so the GOOD/DROP/GOOD structure survives the expected RED.
    let mut control_failures: Vec<String> = Vec::new();
    let mut record = |name: &str, ok: bool, detail: String| {
        eprintln!("fa22072-e1 control {name}: ok={ok} {detail}");
        if !ok {
            control_failures.push(format!("{name}: {detail}"));
        }
    };

    let json_good_text = String::from_utf8_lossy(&json_good).to_string();
    record(
        "json_good",
        json_good_text.contains("HTTP/1.1 200")
            && json_good_text.contains(BUSINESS_TEXT)
            && json_good_text.contains("\"finish_reason\":\"stop\""),
        format!("{json_good_text:?}"),
    );
    let json_good_again_text = String::from_utf8_lossy(&json_good_again).to_string();
    record(
        "json_good_again",
        json_good_again_text.contains("HTTP/1.1 200")
            && json_good_again_text.contains(BUSINESS_TEXT),
        format!("{json_good_again_text:?}"),
    );
    let sse_good_text = String::from_utf8_lossy(&sse_good).to_string();
    record(
        "sse_good",
        sse_good_text.contains("HTTP/1.1 200")
            && sse_good_text.contains("text/event-stream")
            && sse_good_text.contains(BUSINESS_TEXT)
            && sse_good_text.contains("[DONE]"),
        format!("{sse_good_text:?}"),
    );
    let sse_good_again_text = String::from_utf8_lossy(&sse_good_again).to_string();
    record(
        "sse_good_again",
        sse_good_again_text.contains("HTTP/1.1 200")
            && sse_good_again_text.contains(BUSINESS_TEXT)
            && sse_good_again_text.contains("[DONE]"),
        format!("{sse_good_again_text:?}"),
    );

    record(
        "json_drop_wire",
        json_drop.is_empty(),
        format!("json_drop_bytes={}", json_drop.len()),
    );
    let sse_drop_text = String::from_utf8_lossy(&sse_drop).to_string();
    let sse_drop_body = body_section(&sse_drop);
    record(
        "sse_drop_wire",
        sse_drop_text.contains("HTTP/1.1 200")
            && sse_drop_text.contains("text/event-stream")
            && sse_drop_body.contains(":\n\n")
            && !sse_drop_text.contains("data:")
            && !sse_drop_text.contains("[DONE]")
            && !sse_drop_text.contains(BUSINESS_TEXT)
            && !sse_drop_text.contains("event: error"),
        format!("sse_drop={sse_drop_text:?}"),
    );

    let runtime_classification_present = !runtime_json_detail.is_empty()
        && !runtime_sse_detail.is_empty()
        && runtime_json_drop
            .error_chain
            .as_ref()
            .is_some_and(|chain| !chain.is_empty())
        && runtime_sse_drop
            .error_chain
            .as_ref()
            .is_some_and(|chain| !chain.is_empty())
        && runtime_json_drop.terminal_disposition.is_some()
        && runtime_sse_drop.terminal_disposition.is_some();
    record(
        "runtime_original_source_present",
        [&runtime_json_drop, &runtime_sse_drop]
            .iter()
            .all(|output| {
                output.diagnostic_source.as_ref().is_some_and(|source| {
                    source.source_kind == V3ErrorSourceKind::ProviderFailure
                        && source.source_stage == "V3ProviderReqOutbound09TransportRequest"
                        && source.code == "provider_error"
                        && source.message.contains("error sending request")
                })
            }),
        "typed original transport cause, not a generic reason code".to_string(),
    );
    record(
        "runtime_classification_present",
        runtime_classification_present,
        format!("json_detail={runtime_json_detail:?} sse_detail={runtime_sse_detail:?}"),
    );

    let captures_ok = captures.len() == 8
        && captures
            .iter()
            .all(|capture| capture.authorization.as_deref() == Some("Bearer owned-fixture-key"))
        && captures
            .iter()
            .all(|capture| capture.body["messages"][0]["content"] == REQUEST_MARKER);
    record(
        "peer_captures",
        captures_ok,
        format!("count={} captures={:?}", captures.len(), captures),
    );

    let projection_ok = captures.len() == 8
        && capture_projection(&captures[1]) == capture_projection(&captures[2])
        && capture_projection(&captures[5]) == capture_projection(&captures[6]);
    record(
        "runtime_server_projection_match",
        projection_ok,
        format!(
            "runtime_json={:?} server_json={:?} runtime_sse={:?} server_sse={:?}",
            captures.get(1).map(capture_projection),
            captures.get(2).map(capture_projection),
            captures.get(5).map(capture_projection),
            captures.get(6).map(capture_projection),
        ),
    );

    let preparation = timeout(Duration::from_secs(5), handle.prepare_exec_attempt())
        .await
        .expect("a finished request must release its activity/lease");
    record(
        "activity_released",
        preparation.is_ok(),
        format!("prepare_exec_attempt={preparation:?}"),
    );
    drop(preparation);
    drop(record);

    // Drain and stop every owned fixture resource before asserting, so the
    // expected RED panic cannot race the sample worker or the test HOME cleanup.
    let persist_failures = handle.shutdown().await;
    peer_task.abort();
    let _ = peer_task.await;
    std::env::remove_var(AUTH_ENV);

    assert!(
        control_failures.is_empty(),
        "E1 causal controls failed before the diagnostic assertion: {control_failures:?}"
    );
    assert!(
        persist_failures.is_empty(),
        "fixture sample persist failures: {persist_failures:?}"
    );

    // Exhaustion is separate from recovery: verify the original typed source for
    // both exact terminal requests without changing the existing pin policy.
    assert!(
        server_retains_error_chain,
        "E1 RED: Runtime retained the Chat Relay provider-terminal classification \
         (json detail={runtime_json_detail:?}, sse detail={runtime_sse_detail:?}), but \
         Server did not record its Error chain. These generic details are not causes. \
         error06_events={server_chain_events:?} request_ids={request_ids:?} \
         terminal_evidence={terminal_evidence:?} terminal_sources={terminal_sources:?}"
    );
}

/// A control-plane consumer counterexample, not an injected business error.
/// The actual-source requirement must not pass for a generic reason code.
#[test]
fn fa22072_error_terminal_preserves_original_typed_source() {
    let source = build_v3_error_01_source_raised(
        V3ErrorSourceKind::ProviderFailure,
        "V3ProviderReqOutbound09TransportRequest",
        "provider_error",
        "owned detailed transport failure before the response head",
    );
    let decision = V3ErrorHandlingCenter::decide_provider(
        V3ErrorHandlingCenterInput {
            source: source.clone(),
            action_scope: V3ErrorActionScope::ProviderInstance {
                provider_id: "owned-provider".to_string(),
            },
            candidates_remaining: 0,
            source_status: None,
        },
        false,
        false,
        None,
    );
    let terminal = decision.try_into_terminal().expect("terminal failure");
    assert_eq!(
        terminal
            .execution()
            .exhaustion
            .local_action
            .classified
            .source,
        source,
        "Error05 must still own the complete original source"
    );
    let projected = V3ErrorHandlingCenter::project_terminal_decision(terminal);

    // The original typed source survives Error05 -> Error06 as an internal
    // diagnostic member. It is cloned from the Error05 source, not
    // reconstructed from code, body, health, or logs.
    assert_eq!(
        projected.diagnostic_source, source,
        "Error06 must retain the exact original typed source raised at Error01"
    );

    // Old output-field semantics stay fixed.
    assert_eq!(projected.error_detail, "provider_error");
    assert_eq!(projected.body["error"]["message"], "network error");

    // The retained source stays private: public serialization exposes neither
    // the diagnostic member nor the full raw provider message.
    let public_json = serde_json::to_string(&projected).expect("Error06 must serialize");
    assert!(
        !public_json.contains("diagnostic_source") && !public_json.contains(&source.message),
        "Error06 public serialization leaked the internal source: {public_json}"
    );
    assert!(!projected.body.to_string().contains(&source.message));
}
