//! Recovery-specific peers, manifests and shared helpers for the fa22072
//! Direct/Relay ordered failure-evidence cases (P4-P7).
//!
//! Everything is test-owned: loopback peers, a synthetic key, an isolated HOME
//! and the parent target's `read_request` parser. No live provider, production
//! config or production API is touched. The peers stay reusable for the later
//! P8/P9 module (a held success peer plus its capture sequence) without
//! duplicating the server transport or the request parsers.
use super::*;
use futures_util::StreamExt;
use routecodex_v3_config::{
    compile_v3_config_05_manifest, parse_v3_config_02_authoring, V3Config05ManifestPublished,
};
use routecodex_v3_error::{
    build_v3_error_01_source_raised_external, V3Error01SourceRaised, V3ErrorSourceKind,
    V3ExternalErrorKind, V3ExternalErrorLink,
};
use routecodex_v3_server::{spawn_v3_server_aggregate, V3ServerAggregateHandle};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::sync::Mutex;

#[path = "recovery_peer.rs"]
mod peer;

pub(crate) use peer::{peer_listener, spawn_peer, Peer, PeerReply};

pub(super) const ALPHA_WIRE: &str = "alpha-wire";
pub(super) const BETA_WIRE: &str = "beta-wire";
pub(super) const GAMMA_WIRE: &str = "gamma-wire";
pub(super) const B_TEXT: &str = "B_RECOVERY_DONE";
pub(super) const C_TEXT: &str = "C_RECOVERY_DONE";
pub(super) const TOOL_CALL_ID: &str = "call_owned_recovery";
pub(super) const TOOL_RESULT: &str = "OWNED_RECOVERY_HISTORY_RESULT";

pub(super) type OrderLog = Arc<Mutex<Vec<String>>>;

/// The two fixed, test-owned HTTP 503 bodies. Their `error.type` is the
/// protocol error type the current Relay extractor reads; `message` stays
/// private to the provider-failed-attempt evidence.
pub(super) fn owned_a_503_body() -> Value {
    json!({"error": {"type": "owned_a_503", "code": "owned_a_code", "message": "OWNED_A_503_PRIVATE"}})
}

pub(super) fn owned_b_503_body() -> Value {
    json!({"error": {"type": "owned_b_503", "code": "owned_b_code", "message": "OWNED_B_503_PRIVATE"}})
}

/// Direct default-transport HTTP 503 typed source, built from the current
/// public Error01 constructor contract (never from the artifact or a
/// serializer helper).
pub(super) fn expected_direct_a() -> V3Error01SourceRaised {
    build_v3_error_01_source_raised_external(
        V3ErrorSourceKind::ProviderFailure,
        "V3Transport13ResponsesHttpRequest",
        "provider_http_503",
        "provider returned HTTP 503",
        V3ExternalErrorLink {
            kind: V3ExternalErrorKind::Provider,
            status: Some(503),
            code: Some("HTTP_503".into()),
            provider_id: Some("alpha".into()),
            upstream_request_id: None,
            message: Some("provider returned HTTP 503".into()),
        },
    )
}

/// Chat Relay HTTP-error typed source for the fixed B body.
pub(super) fn expected_relay_b() -> V3Error01SourceRaised {
    build_v3_error_01_source_raised_external(
        V3ErrorSourceKind::ProviderFailure,
        "V3ProviderReqOutbound09TransportRequest",
        "owned_b_503",
        "OWNED_B_503_PRIVATE",
        V3ExternalErrorLink {
            kind: V3ExternalErrorKind::Provider,
            status: None,
            code: Some("owned_b_503".into()),
            provider_id: Some("beta".into()),
            upstream_request_id: None,
            message: Some("OWNED_B_503_PRIVATE".into()),
        },
    )
}

/// The ordered `diagnostic_source` list carried by one artifact.
pub(super) fn artifact_sources(artifact: &Value) -> Vec<Value> {
    artifact["attempts"]
        .as_array()
        .map(|attempts| {
            attempts
                .iter()
                .map(|attempt| attempt["diagnostic_source"].clone())
                .collect()
        })
        .unwrap_or_default()
}

/// One declared provider. `priority = None` declares the provider without
/// adding it to the selected pool (an unrelated candidate that must stay at
/// zero attempts).
pub(super) struct ProviderSpec {
    pub id: &'static str,
    pub wire: &'static str,
    pub interface: &'static str,
    pub port: u16,
    pub priority: Option<u32>,
}

pub(super) fn recovery_manifest(
    server_id: &str,
    port: u16,
    providers: &[ProviderSpec],
) -> V3Config05ManifestPublished {
    let declaration = hub_v1_fixture::hub_v1_test_declaration();
    let execution = hub_v1_fixture::hub_v1_server_execution(server_id);
    let mut blocks = String::new();
    for provider in providers {
        blocks.push_str(&format!(
            r#"
[providers.{id}]
type = "{interface}"
base_url = "http://127.0.0.1:{peer}/v1"
default_model = "{wire}"
auth = {{ type = "api_key", entries = [{{ alias = "key1", env = "{KEY_ENV}" }}] }}
health = {{ enabled = false, failure_threshold = 1, cooldown_ms = 5000 }}
[providers.{id}.models.{wire}]
wire_name = "{wire}"
capabilities = ["text", "tools"]
supports_streaming = true
"#,
            id = provider.id,
            interface = provider.interface,
            peer = provider.port,
            wire = provider.wire,
        ));
    }
    let targets = providers
        .iter()
        .filter_map(|provider| provider.priority.map(|priority| (provider, priority)))
        .map(|(provider, priority)| {
            format!(
                "{{ kind = \"provider_model\", provider = \"{}\", model = \"{}\", key = \"key1\", priority = {} }}",
                provider.id, provider.wire, priority
            )
        })
        .collect::<Vec<_>>()
        .join(",\n  ");
    let source = format!(
        r#"
version = 3
{declaration}
[servers.{server_id}]
bind = "127.0.0.1"
port = {port}
routing_group = "{server_id}"
endpoints = ["openai_chat"]
{execution}
{blocks}
[route_groups.{server_id}.pools.default]
selection = {{ strategy = "priority" }}
targets = [
  {targets}
]
[debug]
log_console = false
snapshots = true
codex_samples = true
"#
    );
    compile_v3_config_05_manifest(parse_v3_config_02_authoring(&source).unwrap()).unwrap()
}

pub(super) fn recovery_client() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(12))
        .build()
        .unwrap()
}

/// Chat request with the paired tool history the handoff must preserve.
pub(super) fn recovery_chat_request(marker: &str, stream: bool) -> Value {
    json!({
        "model": "auto",
        "messages": [
            {"role": "user", "content": marker},
            {"role": "assistant", "tool_calls": [{"id": TOOL_CALL_ID, "type": "function",
                "function": {"name": "lookup", "arguments": "{\"q\":\"owned\"}"}}]},
            {"role": "tool", "tool_call_id": TOOL_CALL_ID, "content": TOOL_RESULT}
        ],
        "tools": [{"type": "function", "function": {"name": "lookup",
            "parameters": {"type": "object", "properties": {"q": {"type": "string"}}}}}],
        "stream": stream,
        "stream_options": {"include_usage": true}
    })
}

/// Posts one Chat request and drains the whole response body.
pub(super) async fn post_chat(
    client: &reqwest::Client,
    port: u16,
    body: &Value,
) -> (u16, Vec<u8>, bool) {
    let Ok(response) = client
        .post(format!("http://127.0.0.1:{port}/v1/chat/completions"))
        .json(body)
        .send()
        .await
    else {
        return (0, Vec::new(), false);
    };
    let status = response.status().as_u16();
    let mut wire = Vec::new();
    let mut completed = true;
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        match chunk {
            Ok(chunk) => wire.extend_from_slice(&chunk),
            Err(_) => {
                completed = false;
                break;
            }
        }
    }
    (status, wire, completed)
}

/// Raw Chat POST for an exhausted transport: it must close without a future
/// recovery wait.
pub(super) async fn raw_post_chat(port: u16, body: &Value) -> Vec<u8> {
    let body = body.to_string();
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
    let mut bytes = Vec::new();
    let result = tokio::time::timeout(Duration::from_secs(3), socket.read_to_end(&mut bytes))
        .await
        .expect("exhausted request transport must close without waiting for recovery");
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

pub(super) fn samples_port_dir(port: u16) -> PathBuf {
    PathBuf::from(std::env::var_os("HOME").unwrap())
        .join(".rcc/codex-samples/openai-chat-completions/ports")
        .join(port.to_string())
}

/// The exact request-qualified sample directories for one marker.
pub(super) fn request_dirs(port: u16, marker: &str) -> Vec<PathBuf> {
    std::fs::read_dir(samples_port_dir(port))
        .map(|entries| {
            entries
                .flatten()
                .map(|entry| entry.path())
                .filter(|path| {
                    std::fs::read_to_string(path.join("request.json"))
                        .is_ok_and(|request| request.contains(marker))
                })
                .collect()
        })
        .unwrap_or_default()
}

pub(super) fn read_json(path: &Path) -> Option<Value> {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
}

pub(super) fn failure_artifact(dirs: &[PathBuf]) -> Option<Value> {
    read_json(&dirs.first()?.join("provider-failed-attempts.json"))
}

/// One provider of a public HTTP case together with the reply its peer returns.
pub(super) struct CasePeer {
    pub id: &'static str,
    pub wire: &'static str,
    pub interface: &'static str,
    pub priority: Option<u32>,
    pub reply: PeerReply,
}

/// A running public HTTP case: one owned loopback peer per provider plus the
/// spawned server aggregate on its own free port.
pub(super) struct HttpCase {
    pub port: u16,
    pub order: OrderLog,
    pub peers: Vec<Peer>,
    handle: V3ServerAggregateHandle,
}

impl HttpCase {
    pub(super) async fn captures(&self, index: usize) -> Vec<Capture> {
        self.peers[index].captured().await
    }

    pub(super) async fn counts(&self) -> Vec<usize> {
        let mut counts = Vec::new();
        for peer in &self.peers {
            counts.push(peer.captured().await.len());
        }
        counts
    }

    /// Exact persistence barrier before any artifact read.
    pub(super) async fn barrier(&self) -> Result<(), String> {
        self.handle.wait_for_codex_sample_persistence().await
    }

    pub(super) async fn shutdown(self, controls: &mut Vec<String>) {
        for peer in self.peers {
            peer.abort().await;
        }
        let failures = self.handle.shutdown().await;
        if !failures.is_empty() {
            controls.push(format!(
                "owned diagnostic shutdown reported failures: {failures:?}"
            ));
        }
    }
}

pub(super) async fn start_http_case(server_id: &'static str, entries: &[CasePeer]) -> HttpCase {
    let order: OrderLog = Arc::new(Mutex::new(Vec::new()));
    let mut peers = Vec::new();
    let mut specs = Vec::new();
    for entry in entries {
        let (listener, port) = peer_listener();
        peers.push(spawn_peer(
            listener,
            entry.id,
            entry.reply.clone(),
            false,
            order.clone(),
        ));
        specs.push(ProviderSpec {
            id: entry.id,
            wire: entry.wire,
            interface: entry.interface,
            port,
            priority: entry.priority,
        });
    }
    let handle = spawn_v3_server_aggregate(recovery_manifest(
        server_id,
        test_ports::free_port(),
        &specs,
    ))
    .await
    .unwrap();
    let port = handle.listeners[0].addr.port();
    HttpCase {
        port,
        order,
        peers,
        handle,
    }
}
