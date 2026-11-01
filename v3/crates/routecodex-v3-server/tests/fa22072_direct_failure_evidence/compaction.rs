//! P9: existing Chat Direct compaction early return, exercised through the real
//! public entry `/v1/chat/completions` with the registered compaction header.
//!
//! The consumer branch under test lives in
//! `src/executors.rs::execute_v3_openai_chat_direct_server_outcome`: when the
//! Direct kernel hands off to a Responses Relay candidate and the request
//! purpose is compaction, the Server records the preceding provider-failure
//! sources once and returns before the seeded Relay runs.
//!
//! Cases:
//! - preceding A(503) then handoff: the artifact keeps exactly the Direct A
//!   source once, and the Relay candidate B is never dispatched;
//! - clean Beta-only handoff: no dispatch and no failure artifact;
//! - a no-header positive control on the same A -> B route proves B would
//!   actually be dispatched and complete without the compaction header.
//!
//! The client behavior stays baseline: the compaction early return breaks the
//! client transport without an error payload, a private cause or a fabricated
//! completion. No production API or injection is used.
use super::*;
use crate::recovery_fixture::*;
use routecodex_v3_config::{
    compile_v3_config_05_manifest, parse_v3_config_02_authoring, V3Config05ManifestPublished,
};
use routecodex_v3_server::{spawn_v3_server_aggregate, V3ServerAggregateHandle};
use std::time::Duration;

const COMPACTION_PURPOSE_HEADER: &str = "x-routecodex-request-purpose";
const COMPACTION_PURPOSE_VALUE: &str = "compaction";

/// A compaction-aware manifest. The shared `recovery_manifest` cannot declare a
/// compact pool, and a compaction request resolves `compact_route_object`
/// instead of the default pool, so the chat entry only reaches the early return
/// when the route group binds a compact pool. Both pools carry the same targets,
/// which keeps the header the single variable of the counterfactual.
fn compaction_manifest(
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
[route_groups.{server_id}]
compact_route_object = "compact"
[route_groups.{server_id}.pools.default]
selection = {{ strategy = "priority" }}
targets = [
  {targets}
]
[route_groups.{server_id}.pools.compact]
route_object = "compact"
selection = {{ strategy = "priority" }}
match = {{ precedence = 5, entry_protocol = "openai_chat" }}
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

/// One owned public HTTP case on a compaction-aware manifest.
struct CompactionCase {
    port: u16,
    order: OrderLog,
    peers: Vec<Peer>,
    handle: V3ServerAggregateHandle,
}

impl CompactionCase {
    async fn counts(&self) -> Vec<usize> {
        let mut counts = Vec::new();
        for peer in &self.peers {
            counts.push(peer.captured().await.len());
        }
        counts
    }

    /// Exact persistence barrier before any artifact read.
    async fn barrier(&self) -> Result<(), String> {
        self.handle.wait_for_codex_sample_persistence().await
    }

    async fn shutdown(self, controls: &mut Vec<String>) {
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

async fn start_compaction_case(server_id: &'static str, entries: &[CasePeer]) -> CompactionCase {
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
    let handle = spawn_v3_server_aggregate(compaction_manifest(
        server_id,
        test_ports::free_port(),
        &specs,
    ))
    .await
    .unwrap();
    let port = handle.listeners[0].addr.port();
    CompactionCase {
        port,
        order,
        peers,
        handle,
    }
}

/// Raw Chat POST that carries the registered compaction purpose header, framed
/// with an exact `Content-Length`. The compaction early return breaks the client
/// transport, so the whole exchange is drained raw instead of through reqwest.
/// Returns the drained bytes and whether the server closed the transport inside
/// the budget.
async fn raw_post_compaction(port: u16, body: &Value) -> (Vec<u8>, bool) {
    let body = body.to_string();
    let mut socket = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
    socket
        .write_all(
            format!(
                "POST /v1/chat/completions HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\n{COMPACTION_PURPOSE_HEADER}: {COMPACTION_PURPOSE_VALUE}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            )
            .as_bytes(),
        )
        .await
        .unwrap();
    socket.flush().await.unwrap();
    let mut bytes = Vec::new();
    match tokio::time::timeout(Duration::from_secs(5), socket.read_to_end(&mut bytes)).await {
        Ok(Ok(_)) => (bytes, true),
        Ok(Err(error)) => (
            bytes,
            matches!(
                error.kind(),
                std::io::ErrorKind::ConnectionReset | std::io::ErrorKind::UnexpectedEof
            ),
        ),
        Err(_) => (bytes, false),
    }
}

/// The compaction early return must stay baseline: the client transport breaks
/// without an error payload, a private cause or a fabricated completion.
fn check_compaction_client_baseline(label: &str, wire: &[u8], controls: &mut Vec<String>) {
    let text = String::from_utf8_lossy(wire);
    if !wire.is_empty() {
        controls.push(format!(
            "{label}: compaction early return must close without HTTP response framing or payload: {text}"
        ));
    }
}

/// P9 case 1: a preceding Direct A(503) hands off to a Responses Relay candidate
/// B. The early return records A exactly once before the handoff move and never
/// dispatches B.
#[tokio::test]
async fn fa22072_direct_compaction_early_return_failure_evidence_public_entry() {
    let (home, _lock) = LOCK.lock().await;
    std::env::set_var(KEY_ENV, KEY);
    let mut controls = Vec::new();
    let mut diagnostics = Vec::new();
    let case = start_compaction_case(
        "chat_compaction_early_return",
        &[
            CasePeer {
                id: "alpha",
                wire: ALPHA_WIRE,
                interface: "openai_chat",
                priority: Some(2),
                reply: PeerReply::HttpError {
                    status: 503,
                    body: owned_a_503_body(),
                },
            },
            CasePeer {
                id: "beta",
                wire: BETA_WIRE,
                interface: "responses",
                priority: Some(1),
                reply: PeerReply::Business {
                    text: B_TEXT,
                    wire: BETA_WIRE,
                },
            },
        ],
    )
    .await;
    let label = "compaction-preceding-A".to_string();
    let marker = "OWNED_COMPACTION_P9_PRECEDING_A".to_string();
    let (raw, closed) =
        raw_post_compaction(case.port, &recovery_chat_request(&marker, false)).await;
    if !closed {
        controls.push(format!(
            "{label}: the compaction early return must close the client transport"
        ));
    }
    check_compaction_client_baseline(&label, &raw, &mut controls);
    let counts = case.counts().await;
    let order = case.order.lock().await.clone();
    if counts != [1, 0] || order != ["alpha"] {
        controls.push(format!(
            "{label}: the compaction early return must attempt alpha once and never dispatch beta: counts={counts:?} order={order:?}"
        ));
    }
    if let Err(error) = case.barrier().await {
        controls.push(format!("{label}: diagnostic worker did not drain: {error}"));
    }
    let dirs = request_dirs(case.port, &marker);
    if dirs.len() != 1 {
        controls.push(format!("{label}: exact request sample missing: {dirs:?}"));
    }
    match failure_artifact(&dirs) {
        Some(artifact) => {
            let expected = vec![serde_json::to_value(expected_direct_a()).unwrap()];
            if artifact["object"] != "routecodex.v3.provider_failed_attempt_evidence"
                || artifact_sources(&artifact) != expected
                || artifact["attempts"]
                    .as_array()
                    .map(|attempts| attempts.len())
                    != Some(1)
                || artifact["attempts"][0]["provider_status"] != 503
                || !artifact["terminal_source"].is_null()
            {
                diagnostics.push(format!(
                    "{label}: the compaction early return must keep exactly the preceding A source once: {artifact:?}"
                ));
            }
        }
        None => diagnostics.push(format!(
            "{label}: the compaction early return lost its preceding A artifact"
        )),
    }
    case.shutdown(&mut controls).await;
    std::env::remove_var(KEY_ENV);
    drop(home);
    assert!(
        controls.is_empty(),
        "compaction preceding-A controls failed: {controls:?}"
    );
    assert!(
        diagnostics.is_empty(),
        "compaction preceding-A diagnostic RED: {diagnostics:?}"
    );
}

/// P9 case 2: a clean Beta-only handoff has no preceding failure, so the early
/// return writes no artifact and never dispatches B.
#[tokio::test]
async fn fa22072_direct_compaction_clean_handoff_omission_public_entry() {
    let (home, _lock) = LOCK.lock().await;
    std::env::set_var(KEY_ENV, KEY);
    let mut controls = Vec::new();
    let mut diagnostics = Vec::new();
    let case = start_compaction_case(
        "chat_compaction_clean_handoff",
        &[CasePeer {
            id: "beta",
            wire: BETA_WIRE,
            interface: "responses",
            priority: Some(1),
            reply: PeerReply::Business {
                text: B_TEXT,
                wire: BETA_WIRE,
            },
        }],
    )
    .await;
    let label = "compaction-clean-handoff".to_string();
    let marker = "OWNED_COMPACTION_P9_CLEAN_HANDOFF".to_string();
    let (raw, closed) =
        raw_post_compaction(case.port, &recovery_chat_request(&marker, false)).await;
    if !closed {
        controls.push(format!(
            "{label}: the clean compaction handoff must close the client transport"
        ));
    }
    check_compaction_client_baseline(&label, &raw, &mut controls);
    let counts = case.counts().await;
    if counts != [0] {
        controls.push(format!(
            "{label}: the clean compaction handoff must not dispatch beta: counts={counts:?}"
        ));
    }
    if let Err(error) = case.barrier().await {
        controls.push(format!("{label}: diagnostic worker did not drain: {error}"));
    }
    let dirs = request_dirs(case.port, &marker);
    if dirs.len() != 1 {
        controls.push(format!("{label}: exact request sample missing: {dirs:?}"));
    }
    if failure_artifact(&dirs).is_some() {
        diagnostics.push(format!(
            "{label}: a clean compaction handoff must not create failure evidence"
        ));
    }
    case.shutdown(&mut controls).await;
    std::env::remove_var(KEY_ENV);
    drop(home);
    assert!(
        controls.is_empty(),
        "compaction clean handoff controls failed: {controls:?}"
    );
    assert!(
        diagnostics.is_empty(),
        "compaction clean handoff diagnostic RED: {diagnostics:?}"
    );
}

/// Counterfactual control: the same A -> B route without the compaction header
/// actually dispatches B and completes with B's business result, so the header
/// is what selects the early return.
#[tokio::test]
async fn fa22072_direct_non_compaction_handoff_dispatch_control_public_entry() {
    let (home, _lock) = LOCK.lock().await;
    std::env::set_var(KEY_ENV, KEY);
    let mut controls = Vec::new();
    for stream in [false, true] {
        let case = start_compaction_case(
            "chat_handoff_control",
            &[
                CasePeer {
                    id: "alpha",
                    wire: ALPHA_WIRE,
                    interface: "openai_chat",
                    priority: Some(2),
                    reply: PeerReply::HttpError {
                        status: 503,
                        body: owned_a_503_body(),
                    },
                },
                CasePeer {
                    id: "beta",
                    wire: BETA_WIRE,
                    interface: "responses",
                    priority: Some(1),
                    reply: PeerReply::Business {
                        text: B_TEXT,
                        wire: BETA_WIRE,
                    },
                },
            ],
        )
        .await;
        let label = format!("handoff-control stream={stream}");
        let marker = format!("OWNED_COMPACTION_P9_CONTROL_{stream}");
        let (status, wire, completed) = post_chat(
            &recovery_client(),
            case.port,
            &recovery_chat_request(&marker, stream),
        )
        .await;
        let body = String::from_utf8_lossy(&wire);
        if status != 200
            || !completed
            || !body.contains(B_TEXT)
            || !body.contains(BETA_WIRE)
            || body.contains("\"error\"")
            || body.contains(KEY)
            || (stream && !body.contains("[DONE]"))
        {
            controls.push(format!(
                "{label}: the no-header control must dispatch and complete B: {status} {body}"
            ));
        }
        let counts = case.counts().await;
        let order = case.order.lock().await.clone();
        if counts != [1, 1] || order != ["alpha", "beta"] {
            controls.push(format!(
                "{label}: the no-header control must attempt alpha once then beta once: counts={counts:?} order={order:?}"
            ));
        }
        case.shutdown(&mut controls).await;
    }
    std::env::remove_var(KEY_ENV);
    drop(home);
    assert!(
        controls.is_empty(),
        "handoff dispatch control failed: {controls:?}"
    );
}
