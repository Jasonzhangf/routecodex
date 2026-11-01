//! Review P1: earlier Provider A evidence must survive B's local SSE-store error.
use super::*;

#[tokio::test]
async fn fa22072_prior_provider_cause_survives_local_buffer_error_public_entry() {
    let (home, _lock) = TEST_LOCK.lock().await;
    std::env::set_var(ALPHA_KEY_ENV, ALPHA_KEY);
    std::env::set_var(BETA_KEY_ENV, BETA_KEY);
    let alpha_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let alpha_port = alpha_listener.local_addr().unwrap().port();
    let beta_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let beta_port = beta_listener.local_addr().unwrap().port();
    let order = Arc::new(Mutex::new(Vec::new()));
    let alpha = Arc::new(AlphaPeer::new(order.clone()));
    let beta = Arc::new(BetaPeer::new(order.clone()));
    let alpha_task = tokio::spawn(serve_alpha(alpha_listener, alpha.clone()));
    let beta_task = tokio::spawn(serve_beta(beta_listener, beta.clone()));
    alpha.set_behavior(AlphaBehavior::Http503).await;
    let mut controls = Vec::new();
    let mut diagnostics = Vec::new();

    // Same provider wire and client payload; only the declared frame allowance
    // changes. Healthy controls surround the actual local-resource failure.
    for frame_limit in [64, 1, 64] {
        let mut selected_manifest = manifest(test_ports::free_port(), alpha_port, beta_port);
        selected_manifest
            .servers
            .get_mut("step5")
            .unwrap()
            .execution
            .as_mut()
            .unwrap()
            .attempt_store
            .attempt_max_frames = frame_limit;
        let handle = spawn_v3_server_aggregate(selected_manifest).await.unwrap();
        let port = handle.listeners[0].addr.port();
        let before = request_dirs(port);
        let a_before = alpha.count().await;
        let b_before = beta.count().await;
        let order_before = order.lock().await.len();
        let (arrived_tx, arrived_rx) = oneshot::channel();
        let (release_tx, release_rx) = oneshot::channel();
        *beta.arrived.lock().await = Some(arrived_tx);
        *beta.release.lock().await = Some(release_rx);
        let probe = issue_client(port, true).await;
        if !matches!(
            timeout(Duration::from_secs(20), arrived_rx).await,
            Ok(Ok(()))
        ) {
            controls.push(format!(
                "frames={frame_limit}: B did not receive the successor"
            ));
        }
        let pre = String::from_utf8_lossy(&probe.snapshot().await).into_owned();
        if probe.is_closed()
            || pre.contains(BETA_BUSINESS_TEXT)
            || pre.contains("[DONE]")
            || client_leak_markers()
                .iter()
                .any(|marker| pre.contains(marker))
        {
            controls.push(format!("frames={frame_limit}: client was not held cleanly"));
        }
        let request_id = wait_new_request_dir(port, &before, Duration::from_secs(10)).await;
        let _ = release_tx.send(());
        wait_closed(&probe, Duration::from_secs(20)).await;
        let wire = String::from_utf8_lossy(&probe.snapshot().await).into_owned();
        if !probe.is_closed() {
            controls.push(format!("frames={frame_limit}: client did not terminate"));
            probe.reader.abort();
        }
        let _ = probe.reader.await;
        for marker in client_leak_markers() {
            if wire.contains(marker) {
                controls.push(format!("frames={frame_limit}: leaked {marker}"));
            }
        }
        if alpha.count().await != a_before + 1 || beta.count().await != b_before + 1 {
            controls.push(format!("frames={frame_limit}: expected exactly A1/B1"));
        }
        if order.lock().await[order_before..] != ["alpha", "beta"] {
            controls.push(format!("frames={frame_limit}: attempt order changed"));
        }
        let artifact = match request_id.as_deref() {
            Some(id) => wait_failed_attempt_artifact(port, id, Duration::from_secs(10)).await,
            None => None,
        };
        if frame_limit == 1 {
            if wire.contains(BETA_BUSINESS_TEXT)
                || wire.contains("[DONE]")
                || wire.contains("event: error")
                || wire.contains("\"error\"")
            {
                controls
                    .push("local-buffer failure leaked content or fabricated completion".into());
            }
            let terminal = artifact.as_ref().map(|a| &a["terminal_source"]);
            if !terminal.is_some_and(|source| {
                source["source_kind"] == "runtime_failure"
                    && source["source_stage"] == "V3HubRuntime"
                    && source["message"]
                        .as_str()
                        .is_some_and(|message| message.contains("relay local resource failure"))
            }) {
                controls.push(format!(
                    "failure was not the controlled local-store exit: {terminal:?}"
                ));
            }
        } else if !wire.contains(BETA_BUSINESS_TEXT) || !wire.contains("[DONE]") {
            controls.push(format!(
                "frames={frame_limit}: real B SSE control did not complete"
            ));
        }
        eprintln!(
            "local-buffer-control frames={frame_limit} request={request_id:?} A1/B1={} B_business={} DONE={} terminal={:?}",
            alpha.count().await == a_before + 1 && beta.count().await == b_before + 1,
            wire.contains(BETA_BUSINESS_TEXT),
            wire.contains("[DONE]"),
            artifact.as_ref().map(|a| &a["terminal_source"])
        );
        // Reuse the exact original 503 source/status/auth/model/switch assertions.
        // The controlled generic exit is expected RED on the earlier A record.
        validate_case_artifact(
            &CaseOutcome {
                name: "json_http_503",
                request_id,
                artifact,
            },
            &mut diagnostics,
        );
        let failures = handle.shutdown().await;
        if !failures.is_empty() {
            controls.push(format!("unexpected persistence failure: {failures:?}"));
        }
    }
    alpha_task.abort();
    beta_task.abort();
    let _ = alpha_task.await;
    let _ = beta_task.await;
    std::env::remove_var(ALPHA_KEY_ENV);
    std::env::remove_var(BETA_KEY_ENV);
    drop(home);
    assert!(
        controls.is_empty(),
        "local-buffer public controls: {controls:?}"
    );
    assert!(
        diagnostics.is_empty(),
        "earlier A diagnostic source lost: {diagnostics:?}"
    );
}
