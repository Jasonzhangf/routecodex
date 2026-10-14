//! fa22072 r34: isolate one filesystem diagnostic-write failure from the business
//! result of the SAME client request.
//!
//! Accepted plan: `/private/tmp/routecodex-fa22072-01a133d7/provider-continuation-plan-r34/plan.md`.
//!
//! This child module owns one narrow public-entry fixture. It reuses the parent
//! module's peers, helpers, manifest and payload through `use super::*`; it adds
//! no new framework and no production field.
//!
//! Goal of this node: prove, through the public `/v1/chat/completions` HTTP
//! entry, that when the per-request diagnostic write of
//! `provider-failed-attempts.json` fails on a real filesystem error, the
//! recovered business result from the distinct declared Provider B still
//! completes to the client, no extra attempt is made, and the existing
//! diagnostic failure ledger reports the exact failed write. Diagnostic
//! persistence has no edge into candidate selection or client framing.
//!
//! Stable test ID: `fa22072_failed_attempt_write_failure_isolated_public_entry`.
//!
//! The deliberate filesystem failure is injected by creating a DIRECTORY at the
//! exact `provider-failed-attempts.json` path while Provider B is held (after the
//! per-request sample directory already exists). The asynchronous diagnostic
//! writer for that one file then fails on `File::create` (EISDIR), while the
//! ordinary request/response sample files stay valid.

use super::*;

/// One real representational failure of the first declared provider. `Http503` is
/// a provider HTTP/error-channel response, which must never reach the model
/// client; the Error chain must continue the same request on the next eligible
/// declared provider.
const FAILURE_CASE: &str = "json_write_failure_isolated";

#[tokio::test]
async fn fa22072_failed_attempt_write_failure_isolated_public_entry() {
    let (home, _lock) = TEST_LOCK.lock().await;
    std::env::set_var(ALPHA_KEY_ENV, ALPHA_KEY);
    std::env::set_var(BETA_KEY_ENV, BETA_KEY);

    let alpha_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let alpha_port = alpha_listener.local_addr().unwrap().port();
    let beta_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let beta_port = beta_listener.local_addr().unwrap().port();

    let order: Arc<Mutex<Vec<&'static str>>> = Arc::new(Mutex::new(Vec::new()));
    let alpha = Arc::new(AlphaPeer::new(order.clone()));
    let beta = Arc::new(BetaPeer::new(order.clone()));
    let alpha_task = tokio::spawn(serve_alpha(alpha_listener, alpha.clone()));
    let beta_task = tokio::spawn(serve_beta(beta_listener, beta.clone()));

    let server_port = test_ports::free_port();
    let manifest = manifest(server_port, alpha_port, beta_port);
    let handle = spawn_v3_server_aggregate(manifest).await.unwrap();
    let listener_port = handle.listeners[0].addr.port();

    eprintln!(
        "fa22072-r34 write-failure fixture pid={} alpha=127.0.0.1:{} beta=127.0.0.1:{} server=127.0.0.1:{}",
        std::process::id(),
        alpha_port,
        beta_port,
        listener_port
    );

    // Provider A returns a real HTTP 503 error response.
    alpha.set_behavior(AlphaBehavior::Http503).await;

    let mut controls: Vec<String> = Vec::new();

    let before = request_dirs(listener_port);
    let (arrived_tx, arrived_rx) = oneshot::channel::<()>();
    let (release_tx, release_rx) = oneshot::channel::<()>();
    *beta.arrived.lock().await = Some(arrived_tx);
    *beta.release.lock().await = Some(release_rx);

    let order_before = order.lock().await.len();
    let probe = issue_client(listener_port, false).await;

    // Provider B captures the continuation attempt while A has already failed.
    match timeout(Duration::from_secs(20), arrived_rx).await {
        Ok(Ok(())) => {}
        other => controls.push(format!(
            "{FAILURE_CASE}: distinct declared provider B never received the continuation \
             attempt: {other:?}"
        )),
    }

    // While B is held, the per-request sample directory already exists (request.json
    // was persisted at request start). Create a DIRECTORY at the exact
    // provider-failed-attempts.json path so the one asynchronous diagnostic writer
    // for that file fails on a real filesystem error.
    let mut request_id: Option<String> = None;
    if controls.is_empty() {
        match wait_new_request_dir(listener_port, &before, Duration::from_secs(10)).await {
            Some(found) => {
                let artifact_path = samples_port_dir(listener_port)
                    .join(&found)
                    .join(FAILED_ATTEMPT_FILE);
                match std::fs::create_dir(&artifact_path) {
                    Ok(()) => request_id = Some(found),
                    Err(error) => controls.push(format!(
                        "{FAILURE_CASE}: could not inject the directory at {artifact_path:?}: {error}"
                    )),
                }
            }
            None => controls.push(format!(
                "{FAILURE_CASE}: no per-request sample directory appeared while B was held"
            )),
        }
    }

    // Before releasing B: the client transport must still be open and clean.
    let markers = client_leak_markers();
    let pre = probe.snapshot().await;
    let pre_text = String::from_utf8_lossy(&pre).to_string();
    let pre_clean = !probe.is_closed()
        && !pre_text.contains(BETA_BUSINESS_TEXT)
        && !pre_text.contains("[DONE]")
        && !pre_text.contains("\"error\"")
        && !pre_text.contains(ALPHA_PRIVATE_CAUSE)
        && markers.iter().all(|marker| !pre_text.contains(marker));
    if !pre_clean {
        controls.push(format!(
            "{FAILURE_CASE}: client transport was not held cleanly before B released \
             (closed={} bytes={pre_text:?})",
            probe.is_closed()
        ));
    }

    // Release B and let the same client request complete from B's real business JSON.
    let _ = release_tx.send(());
    wait_closed(&probe, Duration::from_secs(20)).await;
    let wire = probe.snapshot().await;
    probe.abort();
    let text = String::from_utf8_lossy(&wire).to_string();

    // The client must receive B's real business JSON result, not a provider error.
    match json_body(&wire) {
        None => controls.push(format!(
            "{FAILURE_CASE}: JSON client body was not a decodable business result: {text:?}"
        )),
        Some(body) => {
            if body["choices"][0]["message"]["content"].as_str() != Some(BETA_BUSINESS_TEXT) {
                controls.push(format!(
                    "{FAILURE_CASE}: JSON client content must be exactly B's business text, got {:?}",
                    body["choices"][0]["message"]["content"]
                ));
            }
            if body["choices"][0]["finish_reason"].as_str() != Some("stop") {
                controls.push(format!(
                    "{FAILURE_CASE}: JSON client finish_reason must be stop, got {:?}",
                    body["choices"][0]["finish_reason"]
                ));
            }
            if body["usage"]["total_tokens"].as_u64() != Some(5) {
                controls.push(format!(
                    "{FAILURE_CASE}: JSON client usage must be projected from B, got {:?}",
                    body["usage"]
                ));
            }
            if body["model"].as_str() != Some(BETA_WIRE) {
                controls.push(format!(
                    "{FAILURE_CASE}: JSON client model must be representable, got {:?}",
                    body["model"]
                ));
            }
        }
    }
    if !text.contains("HTTP/1.1 200") {
        controls.push(format!(
            "{FAILURE_CASE}: client transport did not complete with a real 200"
        ));
    }
    for marker in &markers {
        if text.contains(marker) {
            controls.push(format!(
                "{FAILURE_CASE}: client payload leaked private/provider error marker {marker:?}: \
                 {text:?}"
            ));
        }
    }

    // A=1/B=1 and the ordered observation [alpha, beta]: the diagnostic failure
    // must not add an attempt or change candidate selection.
    let alpha_calls = alpha.count().await;
    let beta_calls = beta.count().await;
    if alpha_calls != 1 {
        controls.push(format!(
            "{FAILURE_CASE}: first declared provider must be attempted exactly once, observed \
             {alpha_calls}"
        ));
    }
    if beta_calls != 1 {
        controls.push(format!(
            "{FAILURE_CASE}: distinct successor provider must be attempted exactly once, observed \
             {beta_calls}"
        ));
    }
    let ordered = order.lock().await.clone();
    let observed_order: &[&'static str] = &ordered[order_before..];
    let expected_order: &[&str] = &["alpha", "beta"];
    if observed_order != expected_order {
        controls.push(format!(
            "{FAILURE_CASE}: the ordered provider attempts must be [alpha, beta], got \
             {observed_order:?}"
        ));
    }

    // Own cleanup only: shut down the owned aggregate, abort+join the owned peer
    // tasks, then restore HOME/env before the final assertions.
    let persist_failures = handle.shutdown().await;
    alpha_task.abort();
    beta_task.abort();
    let _ = alpha_task.await;
    let _ = beta_task.await;
    std::env::remove_var(ALPHA_KEY_ENV);
    std::env::remove_var(BETA_KEY_ENV);
    drop(home);

    assert!(
        controls.is_empty(),
        "fa22072-r34 write-failure isolation business controls failed: {controls:?}"
    );

    // The existing diagnostic failure ledger must report exactly the injected
    // filesystem write failure for this exact request and file. Any unrelated
    // diagnostic failure must not be accepted as proof.
    let rid = request_id.as_deref().unwrap_or_default();
    let mut ledger_failures: Vec<String> = Vec::new();
    let matching: Vec<_> = persist_failures
        .iter()
        .filter(|failure| failure.request_id == rid && failure.file_name == FAILED_ATTEMPT_FILE)
        .collect();
    if matching.len() != 1 {
        ledger_failures.push(format!(
            "exactly one {FAILED_ATTEMPT_FILE} persist failure for request {rid} is required, \
             got {} (ledger={persist_failures:?})",
            matching.len()
        ));
    } else if matching[0].reason.trim().is_empty() {
        ledger_failures.push(format!(
            "the filesystem failure reason must be non-empty (ledger={persist_failures:?})"
        ));
    }
    if persist_failures.len() != matching.len() {
        ledger_failures.push(format!(
            "unrelated diagnostic failures must not be accepted as proof of the injected write \
             failure (ledger={persist_failures:?})"
        ));
    }
    assert!(
        ledger_failures.is_empty(),
        "fa22072-r34 RED: the isolated diagnostic write failure is not reported by the existing \
         ledger. Business controls passed (one client request completed from B's real result, \
         A=1/B=1 in order, no error leak), but the injected filesystem failure for the exact \
         request/file was not recorded: {ledger_failures:?}"
    );
}
