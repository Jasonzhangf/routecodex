//! Issue #231 public-entry black box for the Responses Relay stale
//! provider-cooldown rescue probe race.
//!
//! Stable public test ID: `issue231_responses_relay_stale_probe_public_blackbox`.
//!
//! The entry is a real `/v1/responses` listener on a spawned aggregate whose
//! pipeline binds the Responses endpoint to the Relay runtime. A `responses`
//! type provider (`cooled`) is the preferred candidate and a second
//! `responses` type provider (`healthy`) is the later tier.
//!
//! Sequence under test (no product test-only business fields; every marker is
//! ordinary client input text the controlled upstream keys on):
//!
//! 1. A pooled business request with two eligible candidates is parked in the controlled
//!    upstream before any cooldown exists, so it selects `cooled` normally.
//! 2. A manual cooldown `probe` is seeded through the public
//!    `/_routecodex/health/cooldown-pool/add` operator hook.
//! 3. A pooled client request now selects `healthy` while the runtime starts a
//!    single-flight cooldown rescue probe for the cooled preferred tier and
//!    holds it in flight upstream (probe A).
//! 4. The parked `cooled` business request is released and fails with a genuine
//!    provider HTTP error, advancing the same identity's health generation
//!    while probe A is still in flight, then completes on `healthy`.
//! 5. Probe A is released (stale success 2xx or stale failure 503). Its
//!    completion must be a no-op that keeps the newer cooldown, releases only
//!    its own permit, and never mutates the sibling/replacement identity.
//! 6. The client already received the true `healthy` business payload, with no
//!    598, no `target_resolution_failure` and no replacement error payload.
//! 7. A single-provider failure closes only its own transport while a concurrent
//!    healthy request still completes.
//!
//! Owner: `v3.provider_key_health_scoring` (Provider health / probe state) with
//! the Runtime `provider_cooldown_rescue` consumer. No runtime change is
//! required; this test binds the existing contract.

include!("issue231_stale_probe_fixture.rs");

async fn issue231_stale_probe_witness(outcome: StaleProbeOutcome) {
    let _home_guard = TestHomeGuard::new("issue231-stale-probe");
    std::env::set_var(AUTH_ENV, AUTH_SECRET);
    let cooled_peer = Arc::new(Peer {
        captures: Mutex::new(Vec::new()),
        probe_attempts: Mutex::new(0),
        probe_entered: Semaphore::new(0),
        probe_release: Semaphore::new(0),
        business_entered: Semaphore::new(0),
        business_release: Semaphore::new(0),
        first_probe_outcome: outcome,
    });
    let healthy_peer = Arc::new(Peer {
        captures: Mutex::new(Vec::new()),
        probe_attempts: Mutex::new(0),
        probe_entered: Semaphore::new(0),
        probe_release: Semaphore::new(0),
        business_entered: Semaphore::new(0),
        business_release: Semaphore::new(0),
        first_probe_outcome: StaleProbeOutcome::Failure,
    });
    let (cooled_base, cooled_shutdown) =
        spawn_provider_router(post(cooled_provider), cooled_peer.clone()).await;
    let (healthy_base, healthy_shutdown) =
        spawn_provider_router(post(healthy_provider), healthy_peer.clone()).await;
    let handle = spawn_v3_server_aggregate(issue231_manifest(
        free_port(),
        free_port(),
        &cooled_base,
        &healthy_base,
    ))
    .await
    .unwrap();
    let base = format!("http://{}", handle.listeners[0].addr);
    let endpoint = format!("{base}/v1/responses");
    let client = reqwest::Client::new();

    // 1. Park the pooled same-identity business request while `cooled` has no
    //    cooldown yet, so it selects the preferred provider as a normal
    //    business attempt and reaches the controlled upstream.
    let earlier_business = tokio::spawn(send_for_outcome(
        client.clone(),
        endpoint.clone(),
        "wire-test",
        BUSINESS_FAILURE_MARKER,
    ));
    timeout(
        Duration::from_secs(5),
        cooled_peer.business_entered.acquire(),
    )
    .await
    .expect("pooled same-identity business request must reach the preferred provider")
    .unwrap()
    .forget();

    // 2. Seed the preferred identity's cooldown probe through the public
    //    operator hook.
    let add = client
        .post(format!("{base}/_routecodex/health/cooldown-pool/add"))
        .json(&json!({
            "provider_id": "cooled",
            "interface_id": "default",
            "auth_alias": "key",
            "model_id": "wire-test",
            "kind": "probe",
            "duration_ms": 60000
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(add.status(), 200);
    // Make the seeded probe due now so the aggregate's own scheduled probe
    // loop sends it through the real provider wire. The manual add alone
    // schedules the probe for the cooldown deadline.
    let probe = client
        .post(format!("{base}/_routecodex/health/cooldown-pool/probe"))
        .json(&json!({
            "provider_id": "cooled",
            "interface_id": "default",
            "auth_alias": "key",
            "model_id": "wire-test"
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(probe.status(), 200);

    // 3. The pooled request skips the cooled preferred tier (its probe is
    //    in flight) and completes on the healthy later tier.
    let pooled_client = client.clone();
    let pooled_endpoint = endpoint.clone();
    let mut pooled = tokio::spawn(async move {
        pooled_client
            .post(pooled_endpoint)
            .json(&json!({
                "model": "wire-test",
                "input": POOLED_MARKER,
                "stream": false
            }))
            .send()
            .await
    });
    match timeout(Duration::from_secs(5), cooled_peer.probe_entered.acquire()).await {
        Ok(permit) => permit.unwrap().forget(),
        Err(_) => panic!("the runtime must start a real cooldown rescue probe for the cooled tier"),
    }

    // The pooled request already carries the true healthy business payload
    // even though probe A is held.
    let pooled_response = timeout(Duration::from_secs(5), &mut pooled)
        .await
        .expect("healthy later tier must complete while the cooled probe is held")
        .unwrap()
        .unwrap();
    assert_no_client_error_projection("pooled", &pooled_response);
    assert_eq!(pooled_response.status(), 200);
    let pooled_body: Value = pooled_response.json().await.unwrap();
    assert_eq!(pooled_body["status"], "completed", "{pooled_body}");
    let pooled_text = pooled_body["output_text"].as_str().unwrap_or_default();
    assert!(
        pooled_text.contains(HEALTHY_PAYLOAD),
        "client must receive the true healthy business payload: {pooled_body}"
    );
    assert!(
        !pooled_body
            .to_string()
            .contains("target_resolution_failure"),
        "no target_resolution_failure may reach the client"
    );
    // The healthy provider really served it; the cooled provider only saw the
    // probe (and the pinned failure), never the pooled business request.
    let healthy_saw_pooled = healthy_peer
        .captures
        .lock()
        .await
        .iter()
        .any(|body| body.to_string().contains(POOLED_MARKER));
    assert!(
        healthy_saw_pooled,
        "healthy provider must serve the pooled request"
    );
    let cooled_saw_pooled = cooled_peer
        .captures
        .lock()
        .await
        .iter()
        .any(|body| body.to_string().contains(POOLED_MARKER));
    assert!(
        !cooled_saw_pooled,
        "cooled preferred tier must not serve the pooled request while its probe is in flight"
    );

    // 4. Release the parked business failure so the same identity's health
    //    generation advances while probe A is still in flight.
    cooled_peer.business_release.add_permits(1);
    let earlier_outcome = timeout(Duration::from_secs(5), earlier_business)
        .await
        .expect("business failure must be processed")
        .unwrap();
    match earlier_outcome {
        ClientOutcome::TransportBreak => panic!("eligible healthy fallback must complete"),
        ClientOutcome::Response(response) => {
            assert_no_client_error_projection("earlier fallback", &response);
            assert_eq!(response.status(), 200);
            let body: Value = response.json().await.unwrap();
            assert_eq!(body["output_text"], HEALTHY_PAYLOAD);
        }
    }

    // The newer failure is now the owning state; probe A is still in flight.
    let pending = cooldown_pool(&client, &base).await;
    let pending_entry = cooled_probe_entry(&pending)
        .expect("cooled exact identity must remain in the cooldown pool")
        .clone();
    assert_eq!(
        pending_entry["state"], "probing",
        "probe A must still be in flight after the newer failure"
    );

    // 5. Release the stale probe. Its completion is a no-op: newer cooldown
    //    retained, permit released, sibling identity untouched.
    cooled_peer.probe_release.add_permits(8);
    timeout(Duration::from_secs(5), async {
        loop {
            let pool = cooldown_pool(&client, &base).await;
            if cooled_probe_entry(&pool).is_some_and(|entry| entry["state"] != "probing") {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("released stale probe must complete and release its permit");

    let settled = cooldown_pool(&client, &base).await;
    let settled_entry = cooled_probe_entry(&settled)
        .expect("stale probe must not clear the newer cooled cooldown")
        .clone();
    assert_eq!(
        settled_entry["failure_count"], pending_entry["failure_count"],
        "the stale probe must not mutate the newer ownership state: {settled_entry}"
    );
    assert!(
        settled_entry["state"] != "probing",
        "the completed stale probe must release its permit: {settled_entry}"
    );
    assert!(
        settled_entry["until_ms"].as_u64().unwrap_or(0) > 0,
        "cooled must retain its newer cooldown deadline: {settled_entry}"
    );
    assert!(
        !settled["entries"]
            .as_array()
            .unwrap()
            .iter()
            .any(|entry| entry["provider_id"] == "healthy"),
        "the stale cooled probe must not create or mutate a healthy sibling entry"
    );

    // 6. A singleton bypasses automatic cooldown and its real failure closes
    // only its own transport; a concurrent healthy
    //    request still completes.
    let exhausted = tokio::spawn(send_for_outcome(
        client.clone(),
        endpoint.clone(),
        "cooled.wire-test",
        "issue231 singleton terminal failure",
    ));
    let sibling = client
        .post(&endpoint)
        .json(&json!({
            "model": "healthy.wire-test",
            "input": "issue231 healthy sibling",
            "stream": false
        }))
        .send()
        .await
        .unwrap();
    assert_no_client_error_projection("healthy sibling", &sibling);
    assert_eq!(sibling.status(), 200);
    let sibling_body: Value = sibling.json().await.unwrap();
    assert_eq!(sibling_body["status"], "completed", "{sibling_body}");
    assert!(
        sibling_body["output_text"]
            .as_str()
            .unwrap_or_default()
            .contains(HEALTHY_PAYLOAD),
        "concurrent healthy request must complete while another request is exhausted: {sibling_body}"
    );
    match timeout(Duration::from_secs(5), exhausted).await {
        Err(_) => panic!("singleton terminal failure must not wait for future recovery"),
        Ok(Err(join_error)) => panic!("exhausted request task must not fail: {join_error}"),
        Ok(Ok(ClientOutcome::TransportBreak)) => {}
        Ok(Ok(ClientOutcome::Response(response))) => {
            let status = response.status();
            let text = response.text().await.expect("unexpected response body");
            panic!("exhaustion must close transport, got {status}: {text}");
        }
    }

    handle.shutdown().await;
    cooled_shutdown.send(()).unwrap();
    healthy_shutdown.send(()).unwrap();
    std::env::remove_var(AUTH_ENV);
}

/// Issue #231 public-entry regression: a stale provider cooldown rescue probe
/// completion (both the success and failure branches) must not clear the newer
/// same-identity failure, must release only its own permit, and must not abort
/// target reselection to the healthy candidate on the real `/v1/responses`
/// Relay entry.
#[tokio::test]
async fn issue231_responses_relay_stale_probe_public_blackbox() {
    let _test_guard = TEST_LOCK.lock().await;
    issue231_stale_probe_witness(StaleProbeOutcome::Success).await;
    issue231_stale_probe_witness(StaleProbeOutcome::Failure).await;
}
