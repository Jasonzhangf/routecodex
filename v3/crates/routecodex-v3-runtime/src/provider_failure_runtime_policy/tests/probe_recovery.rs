use super::*;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::Notify;

#[test]
fn unpolled_probe_cancellation_releases_exact_generation() {
    let manifest = target_resolution_manifest("unpolled_probe_guard");
    let health = V3ProviderFailureRuntimeHealth::from_manifest(&manifest);
    health
        .store
        .record_provider_cooldown_failure(
            "primary",
            Some("key1"),
            Some("gpt-test"),
            "test cooldown",
            1,
            60_000,
        )
        .unwrap();
    let permit = health
        .store
        .acquire_provider_cooldown_probe("primary", Some("key1"), Some("gpt-test"))
        .unwrap()
        .unwrap();
    let work = execute_provider_health_probe(health.store.clone(), permit, |_, _, _, _| async {
        std::future::pending::<Result<(), V3ProviderHealthProbeFailure>>().await
    });
    drop(work);
    let entries = health.store.cooldown_entries(1);
    let probe = entries.iter().find(|entry| entry.kind == "probe").unwrap();
    assert_ne!(
        probe.state, "probing",
        "dropping an unpolled handoff must cancel its health permit"
    );
    assert_eq!(probe.failure_count, Some(0));
    assert!(health
        .store
        .acquire_provider_cooldown_probe("primary", Some("key1"), Some("gpt-test"))
        .unwrap()
        .is_some());
}

#[tokio::test]
async fn managed_probe_shutdown_releases_health_transport_and_capacity() {
    managed_probe_lifecycle_witness(None, false).await;
}

#[tokio::test]
async fn managed_probe_stale_success_preserves_newer_cooldown() {
    managed_probe_lifecycle_witness(Some(200), true).await;
}

#[tokio::test]
async fn managed_probe_stale_failure_preserves_newer_cooldown() {
    managed_probe_lifecycle_witness(Some(503), true).await;
}

#[tokio::test]
async fn managed_probe_stale_cancellation_preserves_newer_cooldown() {
    managed_probe_lifecycle_witness(None, true).await;
}

#[tokio::test]
async fn managed_probe_status_only_success_restores_exact_identity() {
    managed_probe_lifecycle_witness(Some(204), false).await;
}

async fn managed_probe_lifecycle_witness(status: Option<u16>, newer_generation: bool) {
    let scope_name = format!("managed_probe_{}_{}", status.unwrap_or(0), newer_generation);
    let provider_id = scope_name.clone();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let mut manifest = global_pool_alive_manifest_with_provider_names(
        &scope_name,
        None,
        &provider_id,
        "unused_lifecycle_sibling",
    );
    let provider = manifest.providers.get_mut(&provider_id).unwrap();
    provider.interfaces.get_mut("default").unwrap().base_url =
        format!("http://{}/v1", listener.local_addr().unwrap());
    provider.auth.entries[0].env = Some("V3_MANAGED_LIFECYCLE_TEST_KEY".into());
    std::env::set_var("V3_MANAGED_LIFECYCLE_TEST_KEY", "fixture-only");
    let health = V3ProviderFailureRuntimeHealth::from_manifest_for_isolated_tests(&manifest);
    let scope = test_provider_failure_scope(&scope_name, &scope_name, "lifecycle").unwrap();
    let now_ms = v3_relay_provider_policy_now_epoch_ms().unwrap();
    let expanded = build_v3_relay_target_candidates(&V3RelayProviderTargetResolutionInput {
        manifest: &manifest,
        server_id: &scope_name,
        failure_session_scope: &scope,
        entry_kind: "responses",
        endpoint_path: "/v1/responses",
        body: &json!({"model":"client-responses","input":"test"}),
        request_local_excluded_candidates: &BTreeSet::new(),
        provider_health: &health,
        now_ms,
        deterministic_sample: 0,
    })
    .unwrap_or_else(|_| panic!("lifecycle candidate expansion"));
    let candidate = expanded
        .candidates
        .iter()
        .find(|candidate| candidate.provider_id == provider_id)
        .unwrap();
    health
        .store
        .record_provider_cooldown_failure(
            &provider_id,
            Some("key1"),
            Some("gpt-test"),
            "held probe",
            now_ms,
            60_000,
        )
        .unwrap();
    let (shutdown, shutdown_rx) = tokio::sync::oneshot::channel();
    let lifecycle = health
        .aggregate_provider_probe_lifecycle(Arc::new(manifest.clone()), shutdown_rx)
        .unwrap();
    let owner = health.probe_owner.lock().unwrap().clone().unwrap();
    let slots = (0..V3_PROVIDER_HEALTH_PROBE_MAX_CONCURRENCY)
        .map(|_| owner.capacity.clone().try_acquire_owned().unwrap())
        .collect::<Vec<_>>();
    assert!(matches!(
        health
            .initiate_cooldown_rescue_probe(&manifest, candidate, now_ms)
            .await
            .unwrap(),
        V3ProbeInitiation::CapacityUnavailable
    ));
    assert!(health
        .store
        .cooldown_entries(now_ms)
        .iter()
        .all(|entry| entry.state != "probing"));
    drop(slots);
    assert!(matches!(
        health
            .initiate_cooldown_rescue_probe(&manifest, candidate, now_ms)
            .await
            .unwrap(),
        V3ProbeInitiation::Initiated
    ));
    let task = tokio::spawn(lifecycle);
    let (mut socket, _) = tokio::time::timeout(Duration::from_secs(2), listener.accept())
        .await
        .unwrap()
        .unwrap();
    let mut headers = Vec::new();
    tokio::time::timeout(Duration::from_secs(2), async {
        let mut byte = [0];
        while !headers.ends_with(b"\r\n\r\n") {
            socket.read_exact(&mut byte).await.unwrap();
            headers.push(byte[0]);
        }
    })
    .await
    .unwrap();
    assert!(String::from_utf8_lossy(&headers).contains("Bearer fixture-only"));
    assert!(matches!(
        health
            .initiate_cooldown_rescue_probe(&manifest, candidate, now_ms)
            .await
            .unwrap(),
        V3ProbeInitiation::AlreadyOwned
    ));
    let capacity_key = format!("{provider_id}:key1");
    let controller = V3AdaptiveConcurrencyController::process_shared();
    assert_eq!(controller.snapshot(&capacity_key).unwrap().in_flight, 1);
    if newer_generation {
        health
            .store
            .record_provider_failure_action(
                &provider_id,
                "key1",
                "gpt-test",
                &V3ProviderFailureAction::recoverable("transport"),
                now_ms + 1,
            )
            .unwrap();
    }
    let newer_entries = health.store.cooldown_entries(now_ms + 1);
    let newer_probe = newer_entries
        .iter()
        .find(|entry| entry.kind == "probe")
        .unwrap();
    let newer_score_generation = health
        .store
        .scheduling_projection_for_key(&provider_id, "key1", "gpt-test", 1, 1, now_ms + 1)
        .unwrap()
        .score_generation;
    let mut replacement_socket = None;
    if let Some(status) = status {
        socket.write_all(format!("HTTP/1.1 {status} Test\r\nContent-Type: application/octet-stream\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").as_bytes()).await.unwrap();
        tokio::time::timeout(Duration::from_secs(2), async {
            tokio::select! {
                _ = async {
                    while owner.capacity.available_permits() != V3_PROVIDER_HEALTH_PROBE_MAX_CONCURRENCY {
                        tokio::task::yield_now().await;
                    }
                } => {
                    assert_eq!(controller.snapshot(&capacity_key).unwrap().in_flight, 0);
                }
                accepted = listener.accept(), if newer_generation => {
                    let (mut replacement, _) = accepted.unwrap();
                    let mut headers = Vec::new();
                    let mut byte = [0];
                    while !headers.ends_with(b"\r\n\r\n") {
                        replacement.read_exact(&mut byte).await.unwrap();
                        headers.push(byte[0]);
                    }
                    let headers = String::from_utf8(headers).unwrap();
                    assert!(headers.starts_with("POST /v1/responses HTTP/1.1\r\n"));
                    assert!(headers.contains("Bearer fixture-only"));
                    let content_length = headers.lines().find_map(|line| {
                        line.strip_prefix("content-length: ").map(|length| length.parse::<usize>().unwrap())
                    }).unwrap();
                    let mut body = vec![0; content_length];
                    replacement.read_exact(&mut body).await.unwrap();
                    let body: serde_json::Value = serde_json::from_slice(&body).unwrap();
                    assert_eq!(body["model"], "gpt-test");
                    // A real successor proves the old health acquisition ended.
                    // One occupied slot/transport proves the old resources ended,
                    // even when the aggregate's all-free state was transient.
                    while owner.capacity.available_permits() != V3_PROVIDER_HEALTH_PROBE_MAX_CONCURRENCY - 1
                        || controller.snapshot(&capacity_key).unwrap().in_flight != 1
                    {
                        tokio::task::yield_now().await;
                    }
                    let entries = health.store.cooldown_entries(now_ms + 1);
                    let probe = entries.iter().find(|entry| entry.kind == "probe").unwrap();
                    assert_eq!(probe.state, "probing");
                    assert_eq!(probe.failure_count, newer_probe.failure_count);
                    assert_eq!(probe.until_ms, newer_probe.until_ms);
                    assert_eq!(probe.remaining_ms, newer_probe.remaining_ms);
                    assert_eq!(health.store.scheduling_projection_for_key(&provider_id, "key1", "gpt-test", 1, 1, now_ms + 1).unwrap().score_generation, newer_score_generation);
                    eprintln!("completed old probe; authenticated successor owns one manager slot and one transport: {capacity_key}");
                    replacement_socket = Some(replacement);
                }
            }
        })
        .await
        .expect("status-only completion must release old manager and transport capacity");
    }
    shutdown.send(()).unwrap();
    tokio::time::timeout(Duration::from_secs(2), task)
        .await
        .expect("shutdown must not wait for held socket release")
        .unwrap();
    drop(replacement_socket);
    assert_eq!(controller.snapshot(&capacity_key).unwrap().in_flight, 0);
    assert_eq!(
        owner.capacity.available_permits(),
        V3_PROVIDER_HEALTH_PROBE_MAX_CONCURRENCY
    );
    assert!(owner.sender.is_closed());
    if newer_generation {
        let entries = health.store.cooldown_entries(now_ms + 1);
        let probe = entries.iter().find(|entry| entry.kind == "probe").unwrap();
        // The old owner and any observed successor have exited. Their in-flight
        // markers must be released while newer cooldown stays intact.
        assert_ne!(probe.state, "probing", "aggregate cancellation left an ownerless probe marker after health generation advanced");
        assert_eq!(probe.failure_count, newer_probe.failure_count);
        assert_eq!(probe.until_ms, newer_probe.until_ms);
        assert_eq!(probe.remaining_ms, newer_probe.remaining_ms);
        assert_eq!(
            health
                .store
                .scheduling_projection_for_key(&provider_id, "key1", "gpt-test", 1, 1, now_ms + 1)
                .unwrap()
                .score_generation,
            newer_score_generation
        );
        assert!(
            !health
                .availability(&provider_id, Some("key1"), Some("gpt-test"), now_ms + 1)
                .available
        );
    } else if status.is_some() {
        assert!(
            health
                .availability(&provider_id, Some("key1"), Some("gpt-test"), now_ms + 1)
                .available
        );
    } else {
        let entries = health.store.cooldown_entries(now_ms);
        let probe = entries.iter().find(|entry| entry.kind == "probe").unwrap();
        assert_ne!(probe.state, "probing");
        assert_eq!(probe.failure_count, Some(0));
        assert!(
            !health
                .availability(&provider_id, Some("key1"), Some("gpt-test"), now_ms)
                .available
        );
    }
    assert!(matches!(
        health
            .initiate_cooldown_rescue_probe(&manifest, candidate, now_ms)
            .await
            .unwrap(),
        V3ProbeInitiation::OwnerUnavailable
    ));
}

#[test]
fn post_commit_sse_failure_enters_provider_cooldown_after_one_same_error() {
    let manifest = target_resolution_manifest("post_commit_sse_single_retryable");
    let health = V3ProviderFailureRuntimeHealth::from_manifest(&manifest);
    let session = test_provider_failure_scope(
        "post_commit_sse_single_retryable",
        "post_commit_sse_single_retryable",
        "single-failure-session",
    )
    .expect("single failure session scope");
    let source = build_v3_error_01_source_raised(
        V3ErrorSourceKind::ProviderFailure,
        "V3ProviderRespInbound01Raw",
        "provider_response_sse_stream",
        "Responses SSE event must be a JSON object",
    );

    for _attempt in 0..1 {
        health
            .record_post_commit_provider_stream_failure_from_source(
                &session,
                "primary",
                Some("key1"),
                Some("gpt-test"),
                &source,
            )
            .expect("post-commit SSE failure must remain a recoverable observation");

        let projection =
            routecodex_v3_provider_responses::V3ProviderSchedulingReader::scheduling_projection(
                &health,
                "primary",
                "key1",
                "gpt-test",
                1,
                1,
                v3_relay_provider_policy_now_epoch_ms().expect("current epoch"),
            );
        assert!(
            !projection.available,
            "one typed recoverable post-commit SSE failure must cool the exact identity"
        );
        assert!(projection
            .blocked_scopes
            .iter()
            .any(|scope| scope == "provider_cooldown_probe_pending"));
    }
}

#[test]
fn business_success_resets_post_commit_sse_streak_without_releasing_cooldown() {
    let manifest = target_resolution_manifest("post_commit_sse_success_reset");
    let health = V3ProviderFailureRuntimeHealth::from_manifest(&manifest);
    let session = test_provider_failure_scope(
        "post_commit_sse_success_reset",
        "post_commit_sse_success_reset",
        "success-reset-session",
    )
    .expect("success reset session scope");
    let source = build_v3_error_01_source_raised(
        V3ErrorSourceKind::ProviderFailure,
        "V3ProviderRespInbound01Raw",
        "provider_response_sse_stream",
        "Responses SSE event must be a JSON object",
    );

    for _ in 0..1 {
        health
            .record_post_commit_provider_stream_failure_from_source(
                &session,
                "primary",
                Some("key1"),
                Some("gpt-test"),
                &source,
            )
            .expect("post-commit SSE failure observation");
    }
    health
        .store()
        .record_provider_key_success(
            "primary",
            "key1",
            "gpt-test",
            v3_relay_provider_policy_now_epoch_ms().expect("current epoch"),
        )
        .expect("successful retry must clear failure state");

    let projection =
        routecodex_v3_provider_responses::V3ProviderSchedulingReader::scheduling_projection(
            &health,
            "primary",
            "key1",
            "gpt-test",
            1,
            1,
            v3_relay_provider_policy_now_epoch_ms().expect("current epoch"),
        );
    assert!(!projection.available);
    assert!(
        health
            .store()
            .provider_cooldown_probe_keys_due(u64::MAX)
            .expect("provider cooldown probe query")
            .iter()
            .any(|(provider, key, model)| {
                provider == "primary"
                    && key.as_deref() == Some("key1")
                    && model.as_deref() == Some("gpt-test")
            }),
        "a business success must not release the exact existing cooldown"
    );

    let permit = health
        .store()
        .acquire_provider_cooldown_probe("primary", Some("key1"), Some("gpt-test"))
        .unwrap()
        .expect("matching semantic recovery permit");
    health
        .store()
        .complete_provider_cooldown_probe_success_with_permit(
            &permit,
            v3_relay_provider_policy_now_epoch_ms().unwrap(),
        )
        .unwrap();
    assert!(
        health
            .availability("primary", Some("key1"), Some("gpt-test"), u64::MAX)
            .available
    );

    for _ in 0..1 {
        health
            .record_post_commit_provider_stream_failure_from_source(
                &session,
                "primary",
                Some("key1"),
                Some("gpt-test"),
                &source,
            )
            .expect("post-success failure observation");
    }
    let after_post_success_failures =
        routecodex_v3_provider_responses::V3ProviderSchedulingReader::scheduling_projection(
            &health,
            "primary",
            "key1",
            "gpt-test",
            1,
            1,
            v3_relay_provider_policy_now_epoch_ms().expect("current epoch"),
        );
    assert!(
        !after_post_success_failures.available,
        "after semantic recovery, one non-429 provider failure must cool again"
    );
}

#[test]
fn three_post_commit_sse_failures_start_recovery_probe_after_five_seconds() {
    let manifest = target_resolution_manifest("post_commit_sse_probe_due");
    let health = V3ProviderFailureRuntimeHealth::from_manifest(&manifest);
    let session = test_provider_failure_scope(
        "post_commit_sse_probe_due",
        "post_commit_sse_probe_due",
        "probe-due-session",
    )
    .expect("probe due session scope");
    let source = build_v3_error_01_source_raised(
        V3ErrorSourceKind::ProviderFailure,
        "V3ProviderRespInbound01Raw",
        "provider_response_sse_stream",
        "Responses SSE event must be a JSON object",
    );
    let before_failures_ms = v3_relay_provider_policy_now_epoch_ms().expect("current epoch");

    for _ in 0..3 {
        health
            .record_post_commit_provider_stream_failure_from_source(
                &session,
                "primary",
                Some("key1"),
                Some("gpt-test"),
                &source,
            )
            .expect("post-commit SSE failure observation");
    }

    assert!(
        health
            .store()
            .provider_cooldown_probe_keys_due(before_failures_ms + 4_999)
            .expect("provider cooldown probe query")
            .is_empty(),
        "the recovery probe must not be due before five seconds"
    );
    let after_failures_ms = v3_relay_provider_policy_now_epoch_ms().expect("current epoch");
    let probe_keys = health
        .store()
        .provider_cooldown_probe_keys_due(after_failures_ms + 5_000)
        .expect("provider cooldown probe query");
    assert_eq!(
        probe_keys,
        vec![(
            "primary".to_string(),
            Some("key1".to_string()),
            Some("gpt-test".to_string()),
        )],
        "three post-commit SSE failures must enter the 429-equivalent recovery ladder at 5s"
    );
}

#[tokio::test]
async fn provider_probe_failure_is_local_and_does_not_fail_the_probe_batch() {
    let manifest = global_pool_alive_manifest("probe_failure_is_local");
    let health = V3ProviderFailureRuntimeHealth::from_manifest(&manifest);
    health
        .store
        .record_provider_cooldown_failure(
            "first",
            Some("key1"),
            Some("gpt-test"),
            "provider startup probe failed",
            0,
            1,
        )
        .expect("provider cooldown setup");

    health
        .run_due_provider_health_probes(u64::MAX, true, |_, _, _, _| async {
            Err(V3ProviderHealthProbeFailure::Provider(
                "HTTP 503".to_string(),
            ))
        })
        .await
        .expect("provider-local probe failure must not fail the probe batch");

    assert!(health
        .store
        .has_provider_cooldown_probe_pending("first", Some("key1"), Some("gpt-test"))
        .expect("provider cooldown state"));
}

#[tokio::test]
async fn internal_probe_failure_remains_observable() {
    let manifest = global_pool_alive_manifest("probe_internal_failure");
    let health = V3ProviderFailureRuntimeHealth::from_manifest(&manifest);
    health
        .store
        .record_provider_cooldown_failure(
            "first",
            Some("key1"),
            Some("gpt-test"),
            "provider startup probe target failed",
            0,
            1,
        )
        .expect("provider cooldown setup");

    let error = health
        .run_due_provider_health_probes(u64::MAX, true, |_, _, _, _| async {
            Err(V3ProviderHealthProbeFailure::Internal(
                "invalid probe target".to_string(),
            ))
        })
        .await
        .expect_err("internal probe failure must fail the probe batch");

    assert!(error.contains("invalid probe target"));
    assert!(health
        .store
        .has_provider_cooldown_probe_pending("first", Some("key1"), Some("gpt-test"))
        .expect("provider cooldown state"));
}

#[tokio::test]
async fn completed_probe_updates_health_before_slower_probe_finishes() {
    let manifest = global_pool_alive_manifest("probe_completion_order");
    let health = V3ProviderFailureRuntimeHealth::from_manifest(&manifest);
    for provider_id in ["first", "second"] {
        for now_ms in 1..=3 {
            health
                .store
                .record_provider_cooldown_failure(
                    provider_id,
                    Some("key1"),
                    Some("gpt-test"),
                    "pending provider probe",
                    now_ms,
                    1,
                )
                .expect("provider cooldown setup");
        }
    }
    let fast_done = Arc::new(Notify::new());
    let release_slow = Arc::new(Notify::new());
    let running = {
        let health = health.clone();
        let fast_done = fast_done.clone();
        let release_slow = release_slow.clone();
        tokio::spawn(async move {
            health
                .run_due_provider_health_probes(u64::MAX, false, move |provider_id, _, _, _| {
                    let fast_done = fast_done.clone();
                    let release_slow = release_slow.clone();
                    async move {
                        if provider_id == "first" {
                            fast_done.notify_one();
                            Ok(())
                        } else {
                            release_slow.notified().await;
                            Ok(())
                        }
                    }
                })
                .await
        })
    };
    fast_done.notified().await;
    assert!(
        health
            .store
            .availability_for_session(
                &test_provider_failure_scope(
                    "probe_completion_order",
                    "probe_completion_order",
                    "session",
                )
                .expect("probe completion scope"),
                "first",
                Some("key1"),
                Some("gpt-test"),
                0,
            )
            .available,
        "a completed probe must clear its provider cooldown before slower probes finish"
    );
    release_slow.notify_one();
    running
        .await
        .expect("probe runner task must join")
        .expect("probe runner must complete");
}

#[tokio::test]
async fn failed_probe_backoff_starts_at_probe_completion_time() {
    let manifest = global_pool_alive_manifest("probe_completion_time");
    let health = V3ProviderFailureRuntimeHealth::from_manifest(&manifest);
    for now_ms in 1..=3 {
        health
            .store
            .record_provider_cooldown_failure(
                "first",
                Some("key1"),
                Some("gpt-test"),
                "pending provider probe",
                now_ms,
                1,
            )
            .expect("provider cooldown setup");
    }
    let completion_ms = Arc::new(AtomicU64::new(0));
    let completion_marker = completion_ms.clone();
    let started_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("test clock must follow Unix epoch")
        .as_millis() as u64;
    health
        .run_due_provider_health_probes(started_ms, false, move |_, _, _, _| {
            let completion_marker = completion_marker.clone();
            async move {
                tokio::time::sleep(Duration::from_millis(1_500)).await;
                let finished_ms = SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .expect("test clock must follow Unix epoch")
                    .as_millis() as u64;
                completion_marker.store(finished_ms, Ordering::Relaxed);
                Err(V3ProviderHealthProbeFailure::Provider(
                    "controlled probe failure".to_string(),
                ))
            }
        })
        .await
        .expect("provider-local probe failure must not fail the probe batch");
    let finished_ms = completion_ms.load(Ordering::Relaxed);
    assert!(
        finished_ms > started_ms + 1_000,
        "probe must have a measurable duration"
    );
    assert!(
        health
            .store
            .provider_cooldown_probe_keys_due(finished_ms + 9_000)
            .expect("probe schedule projection")
            .is_empty(),
        "failure backoff must start after probe completion, not batch start"
    );
}
