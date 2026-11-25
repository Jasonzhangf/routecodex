//! Issue #231 public-entry black box for stale business-recovery ownership.
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
//! 1. A real authentication failure on `cooled` commits the identity's
//!    cooldown, and completes on `healthy`.
//! 2. The cooldown and recovery cadence expire, making one recovery trial due.
//! 3. A real client request owns the trial and is held at `cooled`; concurrent
//!    requests use `healthy`.
//! 4. A later operator cooldown replaces the owning deadline while the trial is
//!    in flight.
//! 5. Releasing the trial (business success or business failure) must not
//!    clear the newer cooldown or mutate its sibling; it releases the trial
//!    slot, and the next request still uses `healthy`.
//! 6. A separately pinned single candidate projects its final real HTTP error
//!    while a concurrent healthy request still completes.
//!
//! Owner: `v3.provider_key_health_scoring` (Provider health / probe state) with
//! the Runtime `provider_cooldown_rescue` consumer. No runtime change is
//! required; this test binds the existing contract.

include!("issue231_stale_probe_fixture.rs");

use std::sync::atomic::{AtomicU64, Ordering};

async fn issue231_stale_probe_witness(outcome: StaleProbeOutcome) {
    // This case counts upstream attempts, so the Chat Process continuation
    // must not add an extra execution.
    routecodex_v3_config::internal::v3_test_only_set_chat_process_refill_max_override(Some(0));
    let _home_guard = TestHomeGuard::new("issue231-stale-probe");
    std::env::set_var(AUTH_ENV, AUTH_SECRET);
    let cooled_peer = Arc::new(Peer {
        captures: Mutex::new(Vec::new()),
        business_entered: Semaphore::new(0),
        business_release: Semaphore::new(0),
        first_probe_outcome: outcome,
    });
    let healthy_peer = Arc::new(Peer {
        captures: Mutex::new(Vec::new()),
        business_entered: Semaphore::new(0),
        business_release: Semaphore::new(0),
        first_probe_outcome: StaleProbeOutcome::Failure,
    });
    let (cooled_base, cooled_shutdown) =
        spawn_provider_router(post(cooled_provider), cooled_peer.clone()).await;
    let (healthy_base, healthy_shutdown) =
        spawn_provider_router(post(healthy_provider), healthy_peer.clone()).await;
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64;
    let clock = Arc::new(Issue231ObservationClock(AtomicU64::new(now_ms)));
    let handle = routecodex_v3_server::spawn_v3_server_aggregate_with_health_observation_clock(
        issue231_manifest(free_port(), free_port(), &cooled_base, &healthy_base),
        clock.clone(),
    )
    .await
    .unwrap();
    let base = format!("http://{}", handle.listeners[0].addr);
    let endpoint = format!("{base}/v1/responses");
    let client = reqwest::Client::new();

    // 1. A real business request commits the preferred identity's cooldown.
    let first = client
        .post(&endpoint)
        .json(&json!({
            "model": "wire-test",
            "input": INITIAL_FAILURE_MARKER,
            "stream": false
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(first.status(), 200);
    let first_body: Value = first.json().await.unwrap();
    assert_eq!(first_body["output_text"], HEALTHY_PAYLOAD);
    let committed = cooled_probe_entry(&cooldown_pool(&client, &base).await)
        .expect("a real cooled failure must commit the exact cooldown")
        .clone();
    assert_eq!(committed["state"], "blocked");

    // 2. The first exact cooldown reaches its recovery trial deadline.
    let initial_deadline = committed["until_ms"].as_u64().unwrap();
    schedule_real_trial(&client, &base).await;
    clock.0.store(initial_deadline + 1, Ordering::SeqCst);

    // 3. A real request owns the recovery trial and is held at the upstream.
    let pooled_client = client.clone();
    let pooled_endpoint = endpoint.clone();
    let mut pooled = tokio::spawn(async move {
        pooled_client
            .post(pooled_endpoint)
            .json(&json!({
                "model": "wire-test",
                "input": BUSINESS_FAILURE_MARKER,
                "stream": false
            }))
            .send()
            .await
    });
    timeout(
        Duration::from_secs(5),
        cooled_peer.business_entered.acquire(),
    )
    .await
    .expect("the expired cooldown must let the real request become the trial")
    .unwrap()
    .forget();
    let held = cooled_probe_entry(&cooldown_pool(&client, &base).await)
        .expect("the owning trial must remain the cooled identity")
        .clone();
    assert_eq!(held["state"], "probing", "{held}");

    // A concurrent request cannot borrow the single trial slot. It uses the
    // healthy later tier while the owned request remains in flight.
    let concurrent = client
        .post(&endpoint)
        .json(&json!({
            "model": "wire-test",
            "input": POOLED_MARKER,
            "stream": false
        }))
        .send()
        .await
        .unwrap();
    assert_no_client_error_projection("concurrent", &concurrent);
    assert_eq!(concurrent.status(), 200);
    let pooled_body: Value = concurrent.json().await.unwrap();
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
        "cooled preferred tier must not serve the pooled request while its trial is in flight"
    );

    // 4. A newer cooldown replaces the owning deadline before settlement.
    let extended = add_cooldown(&client, &base, 3_720_000).await;
    let extended_deadline = extended["until_ms"].as_u64().unwrap();
    assert!(extended_deadline > initial_deadline);

    // 5. Release the trial. Its stale result must not clear the newer hold.
    cooled_peer.business_release.add_permits(1);
    let trial_response = timeout(Duration::from_secs(5), &mut pooled)
        .await
        .expect("released trial must complete")
        .unwrap()
        .expect("the owned trial must produce its real provider outcome");
    assert_eq!(trial_response.status(), 200);
    let trial_body: Value = trial_response.json().await.unwrap();
    let expected_trial_output = match outcome {
        StaleProbeOutcome::Success => TRIAL_SUCCESS_PAYLOAD,
        StaleProbeOutcome::Failure => HEALTHY_PAYLOAD,
    };
    assert_eq!(trial_body["output_text"], expected_trial_output);

    let settled = cooldown_pool(&client, &base).await;
    let settled_entry = cooled_probe_entry(&settled)
        .expect("the stale trial must not clear the newer cooled cooldown")
        .clone();
    assert_eq!(settled_entry["until_ms"], extended_deadline);
    assert!(
        settled_entry["state"] != "probing",
        "the completed stale trial must release its permit: {settled_entry}"
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
        "the stale cooled trial must not create or mutate a healthy sibling entry"
    );
    let after_stale = client
        .post(&endpoint)
        .json(&json!({
            "model": "wire-test",
            "input": BUSINESS_FAILURE_MARKER,
            "stream": false
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(after_stale.status(), 200);
    let after_stale_body: Value = after_stale.json().await.unwrap();
    assert_eq!(after_stale_body["output_text"], HEALTHY_PAYLOAD);
    assert!(
        cooled_peer.captures.lock().await.len() == 2,
        "the retained newer cooldown must keep a fresh request away from cooled"
    );

    // 6. At the extended deadline the pinned identity may try again and
    //    project its complete final HTTP error. Its sibling stays independent.
    schedule_real_trial(&client, &base).await;
    clock.0.store(extended_deadline + 1, Ordering::SeqCst);
    let exhausted = tokio::spawn(send_for_outcome(
        client.clone(),
        endpoint.clone(),
        "cooled.wire-test",
        TERMINAL_MARKER,
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
        Ok(Ok(ClientOutcome::TransportBreak)) => {
            panic!("the final real Provider error must reach the client");
        }
        Ok(Ok(ClientOutcome::Response(response))) => {
            let status = response.status();
            let text = response.text().await.expect("unexpected response body");
            assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
            assert_eq!(
                text,
                r#"{"error":{"message":"issue231 owned cooled failure"}}"#
            );
        }
    }

    handle.shutdown().await;
    cooled_shutdown.send(()).unwrap();
    healthy_shutdown.send(()).unwrap();
    std::env::remove_var(AUTH_ENV);
}

/// Issue #231 public-entry regression: a stale business-recovery trial
/// completion (both the success and failure branches) must not clear a newer
/// same-identity cooldown, must release only its own permit, and must not abort
/// target reselection on the real `/v1/responses` Relay entry.
#[tokio::test]
async fn issue231_responses_relay_stale_probe_public_blackbox() {
    let _test_guard = TEST_LOCK.lock().await;
    issue231_stale_probe_witness(StaleProbeOutcome::Success).await;
    issue231_stale_probe_witness(StaleProbeOutcome::Failure).await;
}
