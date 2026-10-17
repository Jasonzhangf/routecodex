//! fa22072 P8: Direct caller representative for the diagnostic-write isolation
//! proof.
//!
//! Stable test ID:
//! `fa22072_direct_failure_recording_write_failure_isolated_public_entry`.
//!
//! This child module owns one bounded public-entry fixture. It reuses the shared
//! `recovery_fixture` peers/manifest/HTTP helpers through
//! `use crate::recovery_fixture::*` and the parent target helpers through
//! `use super::*`. It adds no production field and no new framework.
//!
//! Goal: prove through the public `/v1/chat/completions` entry that a real
//! filesystem failure of the per-request diagnostic write
//! `provider-failed-attempts.json` (EISDIR) cannot change the SAME client
//! request's business result or provider attempt count. Provider A answers the
//! fixed HTTP 503; the same-protocol Provider B returns the real business
//! result. When B is held, a DIRECTORY is created at the exact artifact path, so
//! the asynchronous diagnostic writer then fails on `File::create`. The client
//! must still complete from B with A=1/B=1/decoy=0, and the existing persistence
//! barrier and shutdown ledger must report the real failure only for the blocked
//! run. The unblocked control run proves no false failure is reported: its
//! barrier succeeds, its ledger is empty and the exact A artifact is present.

use super::*;
use crate::recovery_fixture::*;
use routecodex_v3_server::spawn_v3_server_aggregate;
use std::collections::BTreeSet;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::Mutex;

/// The exact per-request diagnostic artifact whose write this case fails.
const FAILED_ATTEMPT_FILE: &str = "provider-failed-attempts.json";

/// Enumerates the per-request sample directories (each named for its request id).
fn sample_request_ids(port: u16) -> BTreeSet<String> {
    match std::fs::read_dir(samples_port_dir(port)) {
        Ok(entries) => entries
            .flatten()
            .filter(|entry| entry.path().is_dir())
            .filter_map(|entry| entry.file_name().into_string().ok())
            .collect(),
        Err(_) => BTreeSet::new(),
    }
}

/// Identifies the one new request directory after the persistence barrier.
fn new_request_id(port: u16, before: &BTreeSet<String>) -> Option<String> {
    let fresh: Vec<String> = sample_request_ids(port)
        .difference(before)
        .cloned()
        .collect();
    (fresh.len() == 1).then(|| fresh[0].clone())
}

/// Checks the same client request still completed from B's real business wire.
fn check_business(
    label: &str,
    stream: bool,
    status: u16,
    wire: &[u8],
    completed: bool,
    controls: &mut Vec<String>,
) {
    let text = String::from_utf8_lossy(wire);
    if status != 200
        || !completed
        || !text.contains(B_TEXT)
        || !text.contains(BETA_WIRE)
        || !text.contains("stop")
        || !text.contains("\"total_tokens\":5")
        || (stream && !text.contains("[DONE]"))
        || text.contains("\"error\"")
        || text.contains(KEY)
    {
        controls.push(format!(
            "{label}: genuine successor B business/privacy failed: {status} {text}"
        ));
    }
}

/// Checks one provider received exactly the fixture request once.
fn check_capture(
    label: &str,
    captures: &[Capture],
    wire: &str,
    marker: &str,
    controls: &mut Vec<String>,
) {
    if captures.len() != 1
        || captures[0].path != "/v1/chat/completions"
        || captures[0].body["model"] != wire
        || captures[0].authorization != format!("Bearer {KEY}")
        || !captures[0].body.to_string().contains(marker)
    {
        controls.push(format!(
            "{label}: provider attempt identity/history was not the fixture plan: {captures:?}"
        ));
    }
}

#[tokio::test]
async fn fa22072_direct_failure_recording_write_failure_isolated_public_entry() {
    let (home, _lock) = LOCK.lock().await;
    std::env::set_var(KEY_ENV, KEY);

    let mut controls = Vec::new();
    let mut diagnostics = Vec::new();
    for (block, stream) in [(true, false), (true, true), (false, false), (false, true)] {
        let label = format!("blocked={block} stream={stream}");
        let (case_controls, case_diagnostics) = run_direct_case(block, stream, &label).await;
        controls.extend(case_controls);
        diagnostics.extend(case_diagnostics);
    }

    std::env::remove_var(KEY_ENV);
    drop(home);

    assert!(
        controls.is_empty(),
        "fa22072-r41 P8 Direct write-failure isolation business controls failed: {controls:?}"
    );
    assert!(
        diagnostics.is_empty(),
        "fa22072-r41 P8 Direct write-failure isolation diagnostic assertions failed: \
         {diagnostics:?}"
    );
}

/// One bounded Direct A(503)->B case. `block` holds B and injects the EISDIR
/// directory before B release; `stream` selects the JSON or SSE client framing.
/// All assertions are collected, not asserted, so the owned peers and server are
/// fully closed before the caller reports any failure.
async fn run_direct_case(block: bool, stream: bool, label: &str) -> (Vec<String>, Vec<String>) {
    let mut controls = Vec::new();
    let mut diagnostics = Vec::new();

    let order: OrderLog = Arc::new(Mutex::new(Vec::new()));
    let (alpha_listener, alpha_port) = peer_listener();
    let (beta_listener, beta_port) = peer_listener();
    let (decoy_listener, decoy_port) = peer_listener();

    let alpha = spawn_peer(
        alpha_listener,
        "alpha",
        PeerReply::HttpError {
            status: 503,
            body: owned_a_503_body(),
        },
        false,
        order.clone(),
    );
    let mut beta = spawn_peer(
        beta_listener,
        "beta",
        PeerReply::Business {
            text: B_TEXT,
            wire: BETA_WIRE,
        },
        block,
        order.clone(),
    );
    let decoy = spawn_peer(
        decoy_listener,
        "decoy",
        PeerReply::Business {
            text: "DECOY",
            wire: "decoy-wire",
        },
        false,
        order.clone(),
    );

    let specs = [
        ProviderSpec {
            id: "alpha",
            wire: ALPHA_WIRE,
            interface: "openai_chat",
            port: alpha_port,
            priority: Some(2),
        },
        ProviderSpec {
            id: "beta",
            wire: BETA_WIRE,
            interface: "openai_chat",
            port: beta_port,
            priority: Some(1),
        },
        ProviderSpec {
            id: "decoy",
            wire: "decoy-wire",
            interface: "openai_chat",
            port: decoy_port,
            priority: Some(0),
        },
    ];
    let handle = spawn_v3_server_aggregate(recovery_manifest(
        "direct_write_isolation",
        test_ports::free_port(),
        &specs,
    ))
    .await
    .unwrap();
    let port = handle.listeners[0].addr.port();

    let marker = format!("OWNED_WRITE_ISOLATION_BLOCK{block}_STREAM{stream}");
    let before = sample_request_ids(port);
    let client = recovery_client();
    let body = recovery_chat_request(&marker, stream);
    let client_task = tokio::spawn(async move { post_chat(&client, port, &body).await });

    // The blocked run holds B, derives the exact request id from the owned
    // per-request sample directory and builds the artifact path as a directory
    // before releasing B.
    let mut request_id: Option<String> = None;
    if block {
        match tokio::time::timeout(Duration::from_secs(20), beta.arrived.take().unwrap()).await {
            Ok(Ok(_)) => {}
            other => controls.push(format!(
                "{label}: held successor provider B never received the continuation attempt: \
                 {other:?}"
            )),
        }
        if controls.is_empty() {
            if let Err(error) = handle.wait_for_codex_sample_persistence().await {
                controls.push(format!(
                    "{label}: pre-injection persistence barrier failed: {error}"
                ));
            }
            match new_request_id(port, &before) {
                Some(found) => {
                    let artifact_path = samples_port_dir(port)
                        .join(&found)
                        .join(FAILED_ATTEMPT_FILE);
                    match std::fs::create_dir(&artifact_path) {
                        Ok(()) => request_id = Some(found),
                        Err(error) => controls.push(format!(
                            "{label}: could not inject a directory at {artifact_path:?}: {error}"
                        )),
                    }
                }
                None => controls.push(format!(
                    "{label}: the persistence barrier did not yield one request directory while B was held"
                )),
            }
        }
        let _ = beta.release.take().unwrap().send(());
    }

    let (status, wire, completed) = match client_task.await {
        Ok(result) => result,
        Err(error) => {
            controls.push(format!("{label}: client task failed: {error}"));
            (0, Vec::new(), false)
        }
    };
    check_business(label, stream, status, &wire, completed, &mut controls);
    let alpha_captures = alpha.captured().await;
    let beta_captures = beta.captured().await;
    check_capture(label, &alpha_captures, ALPHA_WIRE, &marker, &mut controls);
    check_capture(label, &beta_captures, BETA_WIRE, &marker, &mut controls);

    let counts = [
        alpha_captures.len(),
        beta_captures.len(),
        decoy.captured().await.len(),
    ];
    let observed_order = order.lock().await.clone();
    if counts != [1, 1, 0] || observed_order != ["alpha", "beta"] {
        controls.push(format!(
            "{label}: the filesystem failure must not change selection: counts={counts:?} \
             order={observed_order:?}"
        ));
    }

    // Persistence barrier: report the real write failure only when blocked.
    let barrier = handle.wait_for_codex_sample_persistence().await;
    if block {
        if barrier.is_ok() {
            diagnostics.push(format!(
                "{label}: persistence barrier must report the real write failure when blocked, got Ok"
            ));
        }
    } else if let Err(error) = &barrier {
        diagnostics.push(format!(
            "{label}: unblocked persistence barrier must be clean, got {error}"
        ));
    }

    // Unblocked control: the exact A artifact must be present and complete.
    if !block {
        let dirs = request_dirs(port, &marker);
        if dirs.len() != 1 {
            diagnostics.push(format!("{label}: exact request sample missing: {dirs:?}"));
        } else {
            match failure_artifact(&dirs) {
                Some(artifact) => {
                    let expected = vec![serde_json::to_value(expected_direct_a()).unwrap()];
                    if artifact["object"] != "routecodex.v3.provider_failed_attempt_evidence"
                        || artifact_sources(&artifact) != expected
                        || artifact["attempts"][0]["provider_status"] != 503
                        || !artifact["terminal_source"].is_null()
                    {
                        diagnostics.push(format!(
                            "{label}: unblocked control must keep exactly the A source: {artifact:?}"
                        ));
                    }
                }
                None => diagnostics.push(format!(
                    "{label}: unblocked control lost its exact A artifact"
                )),
            }
        }
    }

    // Own cleanup only: shut down the owned aggregate and abort+join the owned
    // peers before any caller assertion runs.
    let failures = handle.shutdown().await;
    alpha.abort().await;
    beta.abort().await;
    decoy.abort().await;

    if block {
        let rid = request_id.as_deref().unwrap_or_default();
        let matching: Vec<_> = failures
            .iter()
            .filter(|failure| failure.request_id == rid && failure.file_name == FAILED_ATTEMPT_FILE)
            .collect();
        if matching.len() != 1 {
            diagnostics.push(format!(
                "{label}: exactly one {FAILED_ATTEMPT_FILE} persist failure for request {rid} is \
                 required, got {} (ledger={failures:?})",
                matching.len()
            ));
        } else if matching[0].reason.trim().is_empty() {
            diagnostics.push(format!(
                "{label}: the filesystem failure reason must be non-empty (ledger={failures:?})"
            ));
        }
        if failures.len() != matching.len() {
            diagnostics.push(format!(
                "{label}: unrelated diagnostic failures must not be accepted (ledger={failures:?})"
            ));
        }
    } else if !failures.is_empty() {
        diagnostics.push(format!(
            "{label}: unblocked control ledger must be empty, got {failures:?}"
        ));
    }

    (controls, diagnostics)
}
