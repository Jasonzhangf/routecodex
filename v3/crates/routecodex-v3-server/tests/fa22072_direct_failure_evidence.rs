//! Public Direct failure-evidence diagnostic target (fa22072).
//!
//! Stable test IDs:
//! - `fa22072_pinned_direct_step5_known_failure_evidence_public_entry`
//! - `fa22072_direct_attempt_zero_original_source_public_entry`
//!
//! This target only wires the owned fixture and the two public HTTP entry
//! cases. Shared helpers live here; each case lives in its own submodule so
//! every file stays under the repository line cap.
use routecodex_v3_config::{compile_v3_config_05_manifest, parse_v3_config_02_authoring};
use serde_json::{json, Value};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::Mutex;

#[path = "../../../crates/routecodex-v3-runtime/tests/support/hub_v1_fixture.rs"]
mod hub_v1_fixture;
#[path = "support/fa22072_test_home.rs"]
mod test_home;
#[path = "../../../crates/routecodex-v3-runtime/tests/support/test_ports.rs"]
mod test_ports;

#[path = "fa22072_direct_failure_evidence/attempt_zero.rs"]
mod attempt_zero;
#[path = "fa22072_direct_failure_evidence/compaction.rs"]
mod compaction;
#[path = "fa22072_direct_failure_evidence/pin.rs"]
mod pin;
#[path = "fa22072_direct_failure_evidence/recovery.rs"]
mod recovery;
#[path = "fa22072_direct_failure_evidence/recovery_fixture.rs"]
mod recovery_fixture;
#[path = "fa22072_direct_failure_evidence/write_isolation.rs"]
mod write_isolation;

static LOCK: test_home::ServerTestLock = test_home::ServerTestLock::new();
const KEY_ENV: &str = "FA22072_DIRECT_E1_KEY";
const KEY: &str = "owned-direct-fixture-key";
const MODEL: &str = "step-5-preview";
const TEXT: &str = "RCC_STEP5_OK";

#[derive(Debug, Clone)]
struct Capture {
    path: String,
    body: Value,
    authorization: String,
}

async fn read_request(socket: &mut TcpStream) -> Option<Capture> {
    let mut wire = Vec::new();
    let mut chunk = [0u8; 4096];
    let (head, offset, length) = loop {
        let n = socket.read(&mut chunk).await.ok()?;
        if n == 0 {
            return None;
        }
        wire.extend_from_slice(&chunk[..n]);
        if let Some(at) = wire.windows(4).position(|w| w == b"\r\n\r\n") {
            let head = String::from_utf8_lossy(&wire[..at]).into_owned();
            let length = head
                .lines()
                .find_map(|line| {
                    let (key, value) = line.split_once(':')?;
                    (key.eq_ignore_ascii_case("content-length"))
                        .then(|| value.trim().parse::<usize>().ok())
                        .flatten()
                })
                .unwrap_or(0);
            break (head, at + 4, length);
        }
    };
    while wire.len() < offset + length {
        let n = socket.read(&mut chunk).await.ok()?;
        if n == 0 {
            return None;
        }
        wire.extend_from_slice(&chunk[..n]);
    }
    let path = head.lines().next()?.split_whitespace().nth(1)?.to_owned();
    let authorization = head
        .lines()
        .find_map(|line| {
            let (key, value) = line.split_once(':')?;
            key.eq_ignore_ascii_case("authorization")
                .then(|| value.trim().to_owned())
        })
        .unwrap_or_default();
    Some(Capture {
        path,
        body: serde_json::from_slice(&wire[offset..offset + length]).ok()?,
        authorization,
    })
}

async fn serve_peer(
    listener: TcpListener,
    drop_head: Arc<AtomicBool>,
    captures: Arc<Mutex<Vec<Capture>>>,
) {
    loop {
        let (mut socket, _) = match listener.accept().await {
            Ok(value) => value,
            Err(_) => return,
        };
        let Some(capture) = read_request(&mut socket).await else {
            continue;
        };
        let responses = capture.path.ends_with("/responses");
        let stream = capture.body["stream"] == true;
        captures.lock().await.push(capture);
        if drop_head.load(Ordering::SeqCst) {
            continue;
        }
        let response = json!({"id":"resp-owned-step5","object":"response","status":"completed","model":MODEL,
            "output":[{"id":"msg-owned","type":"message","role":"assistant","status":"completed",
                "content":[{"type":"output_text","text":TEXT,"annotations":[]}]}],
            "usage":{"input_tokens":3,"output_tokens":2,"total_tokens":5}});
        let chat = json!({"id":"chatcmpl-owned-step5","object":"chat.completion","model":MODEL,
            "choices":[{"index":0,"message":{"role":"assistant","content":TEXT},"finish_reason":"stop"}],
            "usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}});
        let (content_type, body) = if !stream {
            (
                "application/json",
                if responses {
                    response.to_string()
                } else {
                    chat.to_string()
                },
            )
        } else if responses {
            (
                "text/event-stream",
                format!(
                    "data: {}\n\ndata: {}\n\ndata: {}\n\n",
                    json!({"type":"response.created","response":{"id":"resp-owned-step5","status":"in_progress","model":MODEL,"output":[]}}),
                    json!({"type":"response.output_text.delta","response_id":"resp-owned-step5","output_index":0,"content_index":0,"item_id":"msg-owned","delta":TEXT}),
                    json!({"type":"response.completed","response":response})
                ),
            )
        } else {
            (
                "text/event-stream",
                format!(
                    "data: {}\n\ndata: {}\n\ndata: [DONE]\n\n",
                    json!({"id":"chatcmpl-owned-step5","object":"chat.completion.chunk","model":MODEL,
                    "choices":[{"index":0,"delta":{"role":"assistant","content":TEXT},"finish_reason":null}]}),
                    json!({"id":"chatcmpl-owned-step5","object":"chat.completion.chunk","model":MODEL,
                    "choices":[{"index":0,"delta":{},"finish_reason":"stop"}],
                    "usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}})
                ),
            )
        };
        let head = format!("HTTP/1.1 200 OK\r\ncontent-type: {content_type}\r\ncontent-length: {}\r\nconnection: close\r\n\r\n", body.len());
        let _ = socket.write_all(head.as_bytes()).await;
        let _ = socket.write_all(body.as_bytes()).await;
        let _ = socket.flush().await;
    }
}

fn manifest(port: u16, peer: u16, decoy: u16) -> routecodex_v3_config::V3Config05ManifestPublished {
    let declaration = hub_v1_fixture::hub_v1_test_declaration();
    let execution = hub_v1_fixture::hub_v1_server_execution("direct_step5");
    let source = format!(
        r#"
version = 3
{declaration}
[servers.direct_step5]
bind = "127.0.0.1"
port = {port}
routing_group = "direct_step5"
endpoints = ["openai_chat"]
{execution}
[servers.direct_step5.execution.attempt_store]
request_max_attempts = 1
[providers.lifeai]
default_model = "step-5-preview"
auth = {{ type = "api_key", entries = [{{ alias = "key1", env = "{KEY_ENV}" }}] }}
health = {{ enabled = false, failure_threshold = 1, cooldown_ms = 5000 }}
[providers.lifeai.models.step-5-preview]
wire_name = "step-5-preview"
capabilities = ["text", "reasoning", "tools", "longcontext"]
supports_streaming = true
supports_thinking = true
thinking = "medium"
max_tokens = 64000
max_context_tokens = 1000000
[providers.lifeai.interfaces.chat]
type = "openai_chat"
base_url = "http://127.0.0.1:{peer}/v1"
[providers.decoy]
type = "openai_chat"
base_url = "http://127.0.0.1:{decoy}/v1"
default_model = "decoy-wire"
auth = {{ type = "api_key", entries = [{{ alias = "key1", env = "{KEY_ENV}" }}] }}
health = {{ enabled = false, failure_threshold = 1, cooldown_ms = 5000 }}
[providers.decoy.models.decoy-wire]
wire_name = "decoy-wire"
capabilities = ["text"]
supports_streaming = true
[route_groups.direct_step5.pools.default]
targets = [{{ kind = "provider_model", provider = "decoy", model = "decoy-wire", key = "key1", priority = 1 }}]
[debug]
log_console = false
snapshots = true
codex_samples = true
"#
    );
    compile_v3_config_05_manifest(parse_v3_config_02_authoring(&source).unwrap()).unwrap()
}
