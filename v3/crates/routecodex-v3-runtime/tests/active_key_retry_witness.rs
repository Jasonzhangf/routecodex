//! Real default-transport consumers of the last actual attempt boundary.
use routecodex_v3_config::{
    compile_v3_config_05_manifest, parse_v3_config_02_authoring, V3ActiveKeyFailureAction,
    V3ActiveKeyMember, V3ActiveKeyPolicy, V3Config05ManifestPublished, V3SelectionStrategy,
};
use routecodex_v3_error::{V3ProviderFailureSessionScope, V3ProviderTerminalDisposition};
use routecodex_v3_runtime::*;
use routecodex_v3_target::{
    V3ActiveKeyEpisode, V3ActiveKeyFailureFeedback, V3ActiveKeyIdentity, V3ActiveKeyScope,
    V3ActiveKeySelectionState,
};
use serde_json::json;
use std::collections::BTreeSet;
use std::sync::{
    atomic::{AtomicBool, AtomicUsize, Ordering},
    Arc, Mutex,
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

const FIRST: &[u8] = b"{\"error\":{\"type\":\"server_error\",\"code\":\"server_error\",\"message\":\"actual A first\"}}";
const SECOND: &[u8] = b"{\"error\":{\"type\":\"server_error\",\"code\":\"server_error\",\"message\":\"actual A second\"}}";

#[derive(Debug, Clone, Copy)]
enum Entry {
    Responses,
    Chat,
    Gemini,
    Anthropic,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Scenario {
    SkipRetry,
    SecondHttp,
    SecondTransport,
    SecondTruncated,
}

fn identity() -> V3ActiveKeyIdentity {
    V3ActiveKeyIdentity {
        provider_id: "witness".into(),
        interface_id: "default".into(),
        model_id: "wire".into(),
        auth_alias: "A".into(),
    }
}
fn scope() -> V3ActiveKeyScope {
    V3ActiveKeyScope {
        listener_id: "witness".into(),
        routing_group_id: "witness".into(),
        pool_id: "default".into(),
    }
}
fn episode(keys: &V3ActiveKeySelectionState) -> V3ActiveKeyEpisode {
    let selection = keys
        .choose(
            &scope(),
            &BTreeSet::from([identity()]),
            &BTreeSet::new(),
            None,
        )
        .unwrap()
        .unwrap();
    let mut episode = V3ActiveKeyEpisode::new(selection);
    episode.begin_attempt().unwrap();
    episode
}

#[derive(Debug)]
struct FourthFailureClock {
    keys: Arc<V3ActiveKeySelectionState>,
    armed: AtomicBool,
    reads: AtomicUsize,
    pending: Mutex<Option<V3ActiveKeyEpisode>>,
    transition: Mutex<Option<(usize, V3ActiveKeyFailureFeedback)>>,
}
impl V3ProviderHealthObservationClock for FourthFailureClock {
    fn now_epoch_ms(&self) -> u64 {
        if self.armed.load(Ordering::SeqCst) {
            let read = self.reads.fetch_add(1, Ordering::SeqCst) + 1;
            if read == 2 {
                if let Some(mut sibling) = self.pending.lock().unwrap().take() {
                    let feedback = self.keys.record_delivery_failure(&mut sibling).unwrap();
                    *self.transition.lock().unwrap() = Some((read, feedback));
                }
            }
        }
        1_800_000_000_000
    }
}

fn manifest(port: u16) -> V3Config05ManifestPublished {
    let source = format!(
        r#"
version = 3
[servers.witness]
bind = "127.0.0.1"
port = 5555
routing_group = "witness"
endpoints = ["responses", "openai_chat", "gemini", "anthropic"]
[servers.witness.execution]
allowed_modes = ["relay"]
allowed_invocation_sources = ["client", "refill", "dry_run"]
allowed_transports = ["json", "sse"]
attempt_store = {{}}
[providers.witness]
type = "responses"
base_url = "http://127.0.0.1:{port}/v1"
default_model = "wire"
auth = {{type="api_key",entries=[{{alias="A",api_key="witness-test-A"}}]}}
[providers.witness.models.wire]
wire_name = "wire"
capabilities = ["text", "tools"]
[route_groups.witness.pools.default]
selection = {{strategy="active_queue"}}
active_keys = {{members=[{{provider="witness",alias="A"}}],retries=1,on_failure="hold"}}
targets = [{{kind="provider_model",provider="witness",model="wire",key="A",priority=1}}]
"#
    );
    compile_v3_config_05_manifest(parse_v3_config_02_authoring(&source).unwrap()).unwrap()
}

async fn execute(
    entry: Entry,
    manifest: &V3Config05ManifestPublished,
    health: &V3ResponsesRelayProviderHealthHandle,
    keys: Arc<V3ActiveKeySelectionState>,
) -> Option<V3ProviderTerminalDisposition> {
    let session = V3ProviderFailureSessionScope::new("witness", "witness", "subject").unwrap();
    match entry {
        Entry::Responses => execute_v3_responses_relay_runtime_with_transport_health(manifest, V3ResponsesRelayRuntimeInput {
            server_id: "witness".into(), failure_session_scope: session, request_id: "subject".into(), payload: json!({"model":"client","input":"hello","stream":false}),
        }, default_responses_transport(), health).await.unwrap().terminal_disposition,
        Entry::Chat => execute_v3_openai_chat_relay_runtime_with_active_keys(manifest, V3OpenAiChatRelayRuntimeInput {
            server_id: "witness".into(), failure_session_scope: session, request_id: "subject".into(), payload: json!({"model":"client","messages":[{"role":"user","content":"hello"}],"stream":false}),
        }, health.runtime_health(), Some(keys)).await.unwrap().terminal_disposition,
        Entry::Gemini => execute_v3_gemini_relay_runtime_with_active_keys(manifest, V3GeminiRelayRuntimeInput {
            server_id: "witness".into(), failure_session_scope: session, request_id: "subject".into(), endpoint_path: "/v1beta/models/client:generateContent".into(), payload: json!({"contents":[{"role":"user","parts":[{"text":"hello"}]}]}),
        }, health.runtime_health(), Some(keys)).await.unwrap().terminal_disposition,
        Entry::Anthropic => execute_v3_anthropic_relay_runtime_with_active_keys(manifest, V3AnthropicRelayRuntimeInput {
            server_id: "witness".into(), failure_session_scope: session, request_id: "subject".into(), payload: json!({"model":"client","max_tokens":32,"messages":[{"role":"user","content":"hello"}],"stream":false}),
        }, vec![], health.runtime_health(), Some(keys)).await.unwrap().terminal_disposition,
    }
}

async fn verify(entry: Entry, scenario: Scenario) {
    let keys = Arc::new(V3ActiveKeySelectionState::default());
    keys.configure(
        scope(),
        V3ActiveKeyPolicy {
            members: vec![V3ActiveKeyMember {
                provider: "witness".into(),
                alias: "A".into(),
            }],
            retries: 1,
            on_failure: V3ActiveKeyFailureAction::Hold,
        },
        V3SelectionStrategy::ActiveQueue,
        &[identity()],
    )
    .unwrap();
    let pending = if scenario == Scenario::SkipRetry {
        for _ in 0..2 {
            keys.record_delivery_failure(&mut episode(&keys)).unwrap();
        }
        Some(episode(&keys))
    } else {
        None
    };
    let clock = Arc::new(FourthFailureClock {
        keys: keys.clone(),
        armed: AtomicBool::new(false),
        reads: AtomicUsize::new(0),
        pending: Mutex::new(pending),
        transition: Mutex::new(None),
    });
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    assert!(![4444, 7777].contains(&addr.port()));
    let calls = Arc::new(Mutex::new(Vec::new()));
    let server_calls = calls.clone();
    let server_clock = clock.clone();
    let task = tokio::spawn(async move {
        loop {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut bytes = Vec::new();
            let mut chunk = [0; 4096];
            loop {
                let n = socket.read(&mut chunk).await.unwrap();
                if n == 0 {
                    break;
                }
                bytes.extend_from_slice(&chunk[..n]);
                if let Some(end) = bytes.windows(4).position(|w| w == b"\r\n\r\n") {
                    let head = String::from_utf8_lossy(&bytes[..end]).to_ascii_lowercase();
                    let length: usize = head
                        .lines()
                        .find_map(|line| {
                            line.strip_prefix("content-length:")
                                .map(|v| v.trim().parse().unwrap())
                        })
                        .unwrap();
                    if bytes.len() >= end + 4 + length {
                        break;
                    }
                }
            }
            let request = String::from_utf8(bytes).unwrap();
            let count = {
                let mut calls = server_calls.lock().unwrap();
                calls.push(request);
                calls.len()
            };
            if count == 1 {
                server_clock.armed.store(true, Ordering::SeqCst);
            }
            if count == 2 && scenario == Scenario::SecondTransport {
                continue;
            }
            let body = if count == 1 { FIRST } else { SECOND };
            let status = if count == 1 { 503 } else { 502 };
            let length =
                body.len() + usize::from(count == 2 && scenario == Scenario::SecondTruncated) * 100;
            let head = format!("HTTP/1.1 {status} Server Error\r\ncontent-type: application/json\r\nx-f4-witness: actual-A-{count}\r\ncontent-length: {length}\r\nconnection: close\r\n\r\n");
            socket.write_all(head.as_bytes()).await.unwrap();
            socket.write_all(body).await.unwrap();
            socket.shutdown().await.unwrap();
        }
    });
    let manifest = manifest(addr.port());
    let health = V3ResponsesRelayProviderHealthHandle::from_manifest_without_persistence(&manifest)
        .with_observation_clock(clock.clone())
        .with_active_keys(Some(keys.clone()));
    let output = tokio::time::timeout(
        std::time::Duration::from_secs(30),
        execute(entry, &manifest, &health, keys.clone()),
    )
    .await;
    task.abort();
    assert!(task.await.unwrap_err().is_cancelled());
    let closed = tokio::net::TcpListener::bind(addr)
        .await
        .expect("owned upstream socket released");
    drop(closed);
    eprintln!("fixture upstream closed: {addr}; entry={entry:?}; scenario={scenario:?}");
    let output = output.expect("bounded Runtime consumer completes");
    let calls = calls.lock().unwrap();
    assert_eq!(
        calls.len(),
        if scenario == Scenario::SkipRetry {
            1
        } else {
            2
        },
        "{entry:?} {scenario:?}"
    );
    for request in calls.iter() {
        assert!(request
            .to_ascii_lowercase()
            .contains("authorization: bearer witness-test-a"));
        assert!(request.starts_with("POST /v1/responses "), "{request}");
        assert!(request.contains("\"model\":\"wire\""));
    }
    if scenario == Scenario::SkipRetry {
        let feedback = clock
            .transition
            .lock()
            .unwrap()
            .clone()
            .expect("sibling fourth failure ran");
        assert_eq!(feedback.0, 2);
        assert!(feedback.1.applied && feedback.1.transitioned);
        assert_eq!(feedback.1.consecutive_failures, 4);
        assert!(keys.snapshot(&scope()).unwrap().held.contains(&identity()));
    } else {
        assert!(clock.transition.lock().unwrap().is_none());
        assert!(keys.snapshot(&scope()).unwrap().held.is_empty());
    }
    match scenario {
        Scenario::SkipRetry | Scenario::SecondHttp => {
            let Some(V3ProviderTerminalDisposition::ProjectExternalHttp(witness)) = output else {
                panic!("{entry:?} {scenario:?}: final actual HTTP error must qualify: {output:?}");
            };
            let first = scenario == Scenario::SkipRetry;
            assert_eq!(witness.status(), if first { 503 } else { 502 });
            assert_eq!(witness.body(), if first { FIRST } else { SECOND });
            assert_eq!(witness.body_read_failure(), None);
            assert!(witness
                .headers()
                .iter()
                .any(|(name, value)| name == "x-f4-witness"
                    && value == if first { b"actual-A-1" } else { b"actual-A-2" }));
        }
        _ => assert!(
            !matches!(
                output,
                Some(V3ProviderTerminalDisposition::ProjectExternalHttp(_))
            ),
            "later actual failure must replace the first complete HTTP witness"
        ),
    }
}

#[tokio::test]
async fn responses_skipped_retry_preserves_final_actual_http_witness() {
    verify(Entry::Responses, Scenario::SkipRetry).await;
}
#[tokio::test]
async fn chat_skipped_retry_preserves_final_actual_http_witness() {
    verify(Entry::Chat, Scenario::SkipRetry).await;
}
#[tokio::test]
async fn gemini_skipped_retry_preserves_final_actual_http_witness() {
    verify(Entry::Gemini, Scenario::SkipRetry).await;
}
#[tokio::test]
async fn anthropic_skipped_retry_preserves_final_actual_http_witness() {
    verify(Entry::Anthropic, Scenario::SkipRetry).await;
}
#[tokio::test]
async fn no_transition_qualifies_second_actual_http_error() {
    for entry in [
        Entry::Responses,
        Entry::Chat,
        Entry::Gemini,
        Entry::Anthropic,
    ] {
        verify(entry, Scenario::SecondHttp).await;
    }
}
#[tokio::test]
async fn later_actual_transport_never_projects_earlier_http_error() {
    for entry in [
        Entry::Responses,
        Entry::Chat,
        Entry::Gemini,
        Entry::Anthropic,
    ] {
        verify(entry, Scenario::SecondTransport).await;
    }
}
#[tokio::test]
async fn later_actual_truncation_never_projects_earlier_http_error() {
    for entry in [
        Entry::Responses,
        Entry::Chat,
        Entry::Gemini,
        Entry::Anthropic,
    ] {
        verify(entry, Scenario::SecondTruncated).await;
    }
}
