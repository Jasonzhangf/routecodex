//! Public HTTP and real Runtime consumer evidence for the fa22072 Direct/Relay
//! ordered failure recording (P4, P5, P6 and the P7 clean-success omission).
//!
//! Each case uses owned loopback peers, a synthetic key and an isolated HOME
//! under the shared parent lock. Business, order, count and privacy assertions
//! stay in `controls`; the private provider-failed-attempt evidence stays in
//! `diagnostics`, so the current baseline RED is the missing artifact rather
//! than a new fixture failure. `controls` and `diagnostics` are both checked
//! before any cleanup so a failure still tears its peers and server down.
//!
//! The shared imports and helpers stay here; each case lives in a child module
//! under `recovery/` so every file stays under the repository line cap.
use super::*;
use crate::recovery_fixture::*;
use routecodex_v3_config::V3Config05ManifestPublished;
use routecodex_v3_error::V3ProviderFailureSessionScope;
use routecodex_v3_runtime::{
    default_responses_transport, execute_v3_direct_runtime_kernel_core,
    execute_v3_openai_chat_relay_runtime_with_default_transport_provider_health_and_handoff,
    V3ChatDirectCodec, V3OpenAiChatRelayRuntimeError, V3OpenAiChatRelayRuntimeInput,
    V3OpenAiChatRelayRuntimeOutput, V3ProviderFailureRuntimeHealth, V3ResponsesDirectRuntimeOutput,
    V3ResponsesProtocolRelayHandoff, V3RuntimeProviderFailureEventSink,
    V3RuntimeProviderFailureObservation,
};
use serde_json::Value;
use std::sync::Arc;
use tokio::sync::Mutex;

type ObservedFailures = Arc<std::sync::Mutex<Vec<V3RuntimeProviderFailureObservation>>>;
type RelayOutcome = Result<V3OpenAiChatRelayRuntimeOutput, V3OpenAiChatRelayRuntimeError>;

fn session_scope(server_id: &str, session_id: &str, port: u16) -> V3ProviderFailureSessionScope {
    V3ProviderFailureSessionScope::new(server_id, server_id, session_id)
        .unwrap()
        .with_transport_handoff_scope(format!("{session_id}-pipeline"), port, 1)
        .unwrap()
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64
}

fn direct_raw(
    server_id: &str,
    port: u16,
    request_id: &str,
    payload: Value,
) -> routecodex_v3_runtime::V3Server03HttpRequestRaw {
    let mut raw = routecodex_v3_runtime::build_v3_server_03_http_request_raw(
        server_id.into(),
        session_scope(server_id, request_id, port),
        request_id.into(),
        format!("{request_id}-execution"),
        "POST".into(),
        "/v1/chat/completions".into(),
        payload,
    );
    raw.port = Some(port);
    raw.pipeline_id = Some(format!("{request_id}-pipeline"));
    raw
}

/// Runs the Direct producer with the real default transport and returns its
/// output plus the failure events its public sink observed.
async fn run_direct_producer(
    manifest: &V3Config05ManifestPublished,
    server_id: &str,
    port: u16,
    request_id: &str,
    payload: Value,
) -> (V3ResponsesDirectRuntimeOutput, ObservedFailures) {
    let observed: ObservedFailures = Arc::new(std::sync::Mutex::new(Vec::new()));
    let sink = observed.clone();
    let failure_sink: V3RuntimeProviderFailureEventSink =
        Arc::new(move |_, event| sink.lock().unwrap().push(event.clone()));
    let output = execute_v3_direct_runtime_kernel_core::<V3ChatDirectCodec, _>(
        (),
        manifest,
        direct_raw(server_id, port, request_id, payload),
        default_responses_transport(),
        V3ProviderFailureRuntimeHealth::from_manifest_for_isolated_tests(manifest),
        now_ms(),
        true,
        Some(&failure_sink),
        None,
    )
    .await;
    (output, observed)
}

/// Runs the seeded Chat Relay consumer on the real default transport.
async fn run_relay_consumer(
    manifest: &V3Config05ManifestPublished,
    server_id: &str,
    port: u16,
    request_id: &str,
    payload: Value,
    handoff: V3ResponsesProtocolRelayHandoff,
) -> RelayOutcome {
    tokio::time::timeout(
        std::time::Duration::from_secs(8),
        execute_v3_openai_chat_relay_runtime_with_default_transport_provider_health_and_handoff(
            manifest,
            V3OpenAiChatRelayRuntimeInput {
                server_id: server_id.into(),
                failure_session_scope: session_scope(server_id, request_id, port),
                request_id: request_id.into(),
                payload,
            },
            V3ProviderFailureRuntimeHealth::from_manifest_for_isolated_tests(manifest),
            handoff,
        ),
    )
    .await
    .expect("the seeded Relay consumer must finish within the recovery budget")
}

fn source_json(event: &V3RuntimeProviderFailureObservation) -> Value {
    serde_json::to_value(&event.diagnostic_source).unwrap()
}

/// The authoritative ordered failure sources the receiving Relay consumer
/// carries, whether it completed or exhausted.
fn relay_ordered_sources(outcome: &RelayOutcome) -> Vec<Value> {
    match outcome {
        Ok(output) => match output.observability.as_ref() {
            Some(observability) => observability
                .provider_failure_events
                .iter()
                .map(source_json)
                .collect(),
            None => output
                .provider_failure_attempts
                .iter()
                .map(source_json)
                .collect(),
        },
        Err(V3OpenAiChatRelayRuntimeError::WithProviderFailureEvidence { attempts, .. }) => {
            attempts.iter().map(source_json).collect()
        }
        Err(_) => Vec::new(),
    }
}

fn expected_pair() -> Vec<Value> {
    vec![
        serde_json::to_value(expected_direct_a()).unwrap(),
        serde_json::to_value(expected_relay_b()).unwrap(),
    ]
}

/// Reads the exact request-qualified artifact and returns `(dirs, artifact)`.
fn read_case_artifact(
    port: u16,
    marker: &str,
    controls: &mut Vec<String>,
    label: &str,
) -> (Vec<std::path::PathBuf>, Option<Value>) {
    let dirs = request_dirs(port, marker);
    if dirs.len() != 1 {
        controls.push(format!("{label}: exact request sample missing: {dirs:?}"));
        return (dirs, None);
    }
    let artifact = failure_artifact(&dirs);
    (dirs, artifact)
}

fn check_business(
    label: &str,
    stream: bool,
    status: u16,
    wire: &[u8],
    completed: bool,
    text: &str,
    model: &str,
    controls: &mut Vec<String>,
) {
    let body = String::from_utf8_lossy(wire);
    if status != 200
        || !completed
        || !body.contains(text)
        || !body.contains(model)
        || !body.contains("stop")
        || !body.contains("\"total_tokens\":5")
        || (stream && !body.contains("[DONE]"))
        || body.contains("\"error\"")
        || body.contains(KEY)
    {
        controls.push(format!(
            "{label}: genuine provider business/privacy failed: {status} {body}"
        ));
    }
}

fn check_capture(
    label: &str,
    captures: &[Capture],
    path: &str,
    wire: &str,
    marker: &str,
    controls: &mut Vec<String>,
) {
    if captures.len() != 1
        || captures[0].path != path
        || captures[0].body["model"] != wire
        || captures[0].authorization != format!("Bearer {KEY}")
        || !captures[0].body.to_string().contains(marker)
    {
        controls.push(format!(
            "{label}: provider attempt identity/history was not the fixture plan: {captures:?}"
        ));
    }
}

#[path = "recovery/consumers.rs"]
mod consumers;
#[path = "recovery/direct.rs"]
mod direct;
#[path = "recovery/seeded.rs"]
mod seeded;
#[path = "recovery/terminal.rs"]
mod terminal;
