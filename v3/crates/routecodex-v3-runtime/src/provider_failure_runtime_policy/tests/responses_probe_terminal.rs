use super::*;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

/// Serve every provider probe the runtime sends until the listener stays idle,
/// so the case stays correct for any number of probed identities.
async fn serve_responses_probes_until_idle(
    listener: TcpListener,
    body: &'static str,
    served: Arc<AtomicUsize>,
) {
    loop {
        let accepted = tokio::time::timeout(Duration::from_millis(400), listener.accept()).await;
        let Ok(Ok((mut socket, _))) = accepted else {
            return;
        };
        let mut request = Vec::new();
        let mut chunk = [0_u8; 4096];
        loop {
            let read = tokio::time::timeout(Duration::from_secs(1), socket.read(&mut chunk))
                .await
                .expect("provider probe request headers must arrive")
                .expect("provider probe request must be readable");
            if read == 0 {
                break;
            }
            request.extend_from_slice(&chunk[..read]);
            if request.windows(4).any(|window| window == b"\r\n\r\n") {
                break;
            }
        }
        served.fetch_add(1, Ordering::SeqCst);
        let response = format!(
            "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
            body.len()
        );
        socket
            .write_all(response.as_bytes())
            .await
            .expect("provider probe response must be writable");
    }
}

/// Drive the real provider-health probe transport against a mock Responses
/// provider that answers `body`, then report whether every probed identity
/// released its cooldown. The cooldown only clears when the probe accepted the
/// response, so this is the externally observable probe outcome.
async fn responses_probe_terminal_clears_cooldown(scope: &str, body: &'static str) -> bool {
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .expect("provider probe listener must bind");
    let base_url = format!(
        "http://{}/v1",
        listener
            .local_addr()
            .expect("provider probe listener address")
    );
    let mut manifest = global_pool_alive_manifest(scope);
    let provider = manifest.providers.get_mut("first").expect("first provider");
    provider.base_url = base_url;
    provider.auth.entries[0].env = Some("ROUTECODEX_V3_RESPONSES_PROBE_TERMINAL_KEY".into());
    std::env::set_var(
        "ROUTECODEX_V3_RESPONSES_PROBE_TERMINAL_KEY",
        "routecodex-test-key",
    );
    let health = V3ProviderFailureRuntimeHealth::from_manifest(&manifest);
    let failure_session_scope =
        test_provider_failure_scope(scope, scope, "responses-probe-terminal-session")
            .expect("failure session scope");
    let expanded = match build_v3_relay_target_candidates(&V3RelayProviderTargetResolutionInput {
        manifest: &manifest,
        server_id: scope,
        failure_session_scope: &failure_session_scope,
        entry_kind: "responses",
        endpoint_path: "/v1/responses",
        body: &json!({"model":"client-responses","input":"hello"}),
        request_local_excluded_candidates: &BTreeSet::new(),
        provider_health: &health,
        now_ms: 20_001,
        deterministic_sample: 0,
    }) {
        Ok(expanded) => expanded,
        Err(_) => panic!("expanded candidates failed"),
    };
    assert!(
        !expanded.candidates.is_empty(),
        "the responses probe terminal case must resolve a candidate"
    );
    for candidate in &expanded.candidates {
        health
            .store
            .record_provider_cooldown_failure(
                &candidate.provider_id,
                Some(&candidate.auth_alias),
                Some(&candidate.model_id),
                "controlled responses probe terminal cooldown",
                10_000,
                10_000,
            )
            .expect("provider cooldown setup");
    }
    let served = Arc::new(AtomicUsize::new(0));
    let probe_server = tokio::spawn(serve_responses_probes_until_idle(
        listener,
        body,
        Arc::clone(&served),
    ));
    health
        .run_exhaustion_rescue_probes(&manifest, &expanded, 20_001)
        .await
        .expect("exhaustion rescue probes must not fail");
    tokio::time::timeout(Duration::from_secs(2), probe_server)
        .await
        .expect("responses probe terminal case must finish its probe server")
        .expect("provider probe task must not panic");
    assert!(
        served.load(Ordering::SeqCst) > 0,
        "the responses probe terminal case must exercise the real probe transport"
    );
    let probed = expanded
        .candidates
        .iter()
        .find(|candidate| candidate.provider_id == "first")
        .expect("the mock provider must stay in the expanded candidate set");
    routecodex_v3_provider_responses::V3ProviderSchedulingReader::scheduling_projection(
        &health,
        &probed.provider_id,
        &probed.auth_alias,
        &probed.model_id,
        1,
        1,
        20_001,
    )
    .available
}

#[tokio::test]
async fn responses_output_cap_probe_terminal_clears_provider_cooldown() {
    assert!(
        responses_probe_terminal_clears_cooldown(
            "responses_probe_terminal_output_cap",
            r#"{"status":"incomplete","incomplete_details":{"reason":"max_output_tokens"}}"#,
        )
        .await,
        "a Responses output-cap probe terminal must clear the provider cooldown"
    );
}

#[tokio::test]
async fn responses_content_filter_probe_terminal_preserves_provider_cooldown() {
    assert!(
        !responses_probe_terminal_clears_cooldown(
            "responses_probe_terminal_content_filter",
            r#"{"status":"incomplete","incomplete_details":{"reason":"content_filter"}}"#,
        )
        .await,
        "a rejected Responses probe terminal must preserve the provider cooldown"
    );
}

#[tokio::test]
async fn responses_unknown_probe_terminal_preserves_provider_cooldown() {
    assert!(
        !responses_probe_terminal_clears_cooldown(
            "responses_probe_terminal_unknown_reason",
            r#"{"status":"incomplete","incomplete_details":{"reason":"mystery"}}"#,
        )
        .await,
        "an unknown Responses probe terminal must preserve the provider cooldown"
    );
}
