use super::*;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::sync::Notify;

#[test]
fn one_post_commit_sse_failure_enters_provider_cooldown_immediately() {
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

    health
        .record_post_commit_provider_stream_failure_from_source(
            &session,
            "primary",
            Some("key1"),
            Some("gpt-test"),
            &source,
        )
        .expect("one post-commit SSE failure must remain a recoverable observation");

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
        "one post-commit SSE failure must enter the adaptive provider cooldown"
    );
    assert!(projection
        .blocked_scopes
        .iter()
        .any(|scope| scope == "provider_cooldown_probe_pending"));
}

#[test]
fn successful_retry_clears_post_commit_sse_failure_state() {
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

    for _ in 0..2 {
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
    assert!(projection.available);
    assert!(
        health
            .store()
            .provider_cooldown_probe_keys_due(u64::MAX)
            .expect("provider cooldown probe query")
            .is_empty(),
        "a successful retry must not leave a pending cooldown probe"
    );

    for _ in 0..2 {
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
        "after recovery, the next provider failure must cool immediately"
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
        .run_due_provider_health_probes(u64::MAX, true, |_, _, _| async {
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
        .run_due_provider_health_probes(u64::MAX, true, |_, _, _| async {
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
                .run_due_provider_health_probes(u64::MAX, false, move |provider_id, _, _| {
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
        .run_due_provider_health_probes(started_ms, false, move |_, _, _| {
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
