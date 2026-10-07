use super::*;

async fn assert_busy_candidate_preserves_peer_recovery(direct: bool) {
    let _guard = TEST_LOCK.lock().await;
    let (first_url, mut first_captures, first_release, first_shutdown) =
        start_controlled_held_upstream().await;
    let (second_url, mut second_captures, second_shutdown) =
        start_controlled_responses_relay_upstream().await;
    std::env::set_var("V3_P6_TEST_KEY", "pool-recovery-test-key");
    let mut manifest = concurrency_switch_manifest(&first_url, &second_url);
    let first_id = format!("concurrency_first_{}", manifest.servers["a"].port);
    let second_id = format!("concurrency_second_{}", manifest.servers["a"].port);
    if direct {
        for provider in manifest.providers.values_mut() {
            provider.responses = None;
        }
    }
    let handle = spawn_v3_server_aggregate(manifest).await.unwrap();
    let base = format!("http://{}", handle.listeners[0].addr);
    let endpoint = format!("{base}/v1/responses");
    let first = spawn_concurrency_client(&endpoint, "pool-recovery-held");
    timeout(Duration::from_secs(2), first_captures.recv())
        .await
        .unwrap()
        .unwrap();

    let client = reqwest::Client::new();
    let cooled = client
        .post(format!("{base}/_routecodex/health/cooldown-pool/add"))
        .json(
            &json!({"provider_id":second_id,"auth_alias":"key","model_id":"test",
            "kind":"probe","duration_ms":60_000}),
        )
        .send()
        .await
        .unwrap();
    assert_eq!(cooled.status(), StatusCode::OK);
    let response = timeout(
        Duration::from_secs(2),
        client
            .post(&endpoint)
            .header("session-id", "pool-recovery-new")
            .json(&json!({"model":"client-test","input":"recover cooled peer","stream":true}))
            .send(),
    )
    .await
    .expect("peer recovery must not wait for busy capacity")
    .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = timeout(Duration::from_secs(2), response.text())
        .await
        .expect("the same consumer must finish through the recovered peer")
        .expect("a recoverable peer must prevent a pool-empty transport break");
    assert!(body.contains("response.completed"), "{body}");
    assert!(!body.contains("response.failed"), "{body}");
    assert!(
        !first.is_finished(),
        "recovery must not wait for the held request"
    );
    assert!(
        first_captures.try_recv().is_err(),
        "full provider must receive no extra send"
    );
    timeout(Duration::from_secs(1), second_captures.recv())
        .await
        .unwrap()
        .unwrap();
    timeout(Duration::from_secs(1), second_captures.recv())
        .await
        .expect("the peer must receive both a semantic probe and the business request")
        .unwrap();
    let health: Value = client
        .get(format!("{base}/_routecodex/health/cooldown-pool"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert!(health["entries"].as_array().unwrap().iter().all(|entry| {
        entry["provider_id"] != first_id && entry["provider_id"] != second_id
    }), "capacity must remain health-neutral and a successful probe must clear peer cooldown: {health}");

    first_release.add_permits(1);
    let (status, body) = timeout(Duration::from_secs(2), first)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(status, StatusCode::OK);
    assert!(body.contains("response.completed"), "{body}");
    let after = spawn_concurrency_client(&endpoint, "pool-recovery-after-release");
    timeout(Duration::from_secs(1), first_captures.recv())
        .await
        .unwrap()
        .unwrap();
    first_release.add_permits(1);
    let (status, body) = timeout(Duration::from_secs(2), after)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(status, StatusCode::OK);
    assert!(body.contains("response.completed"), "{body}");
    handle.shutdown().await;
    first_shutdown.send(()).unwrap();
    second_shutdown.send(()).unwrap();
    std::env::remove_var("V3_P6_TEST_KEY");
}

#[tokio::test]
async fn pool_empty_recovery_relay_busy_preferred_keeps_cooled_peer() {
    assert_busy_candidate_preserves_peer_recovery(false).await;
}

#[tokio::test]
async fn pool_empty_recovery_direct_busy_preferred_keeps_cooled_peer() {
    assert_busy_candidate_preserves_peer_recovery(true).await;
}
