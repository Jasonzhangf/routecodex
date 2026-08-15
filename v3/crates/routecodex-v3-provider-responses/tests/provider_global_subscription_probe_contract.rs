use routecodex_v3_error::{V3ProviderErrorFingerprint, V3ProviderFailureSessionScope};
use routecodex_v3_provider_responses::{
    V3ProviderGlobalSubscriptionDecision, V3ProviderGlobalSubscriptionHealthStore,
    V3ProviderGlobalSubscriptionPolicy, V3ProviderHealthStore,
};

fn scope(session_id: &str) -> V3ProviderFailureSessionScope {
    V3ProviderFailureSessionScope::new("server-a", "group-a", session_id).unwrap()
}

fn invalid_subscription_fingerprint(
    provider_code: &str,
) -> V3ProviderErrorFingerprint {
    V3ProviderErrorFingerprint::new(
        "subscription_invalid_without_token",
        provider_code,
        401,
        "missing_token|subscription_invalid",
    )
    .unwrap()
}

#[test]
fn success_does_not_revive_provider_cooldown_until_probe_passes() {
    let store = V3ProviderHealthStore::default();
    let session_a = scope("session-a");
    let session_b = scope("session-b");

    store
        .record_provider_success_in_session(
            &session_b,
            "provider-a",
            Some("key-a"),
            Some("model-a"),
            1,
        )
        .unwrap();

    for now_ms in 10..=12 {
        store
            .record_provider_failure_in_session(
                &session_a,
                "provider-a",
                Some("key-a"),
                Some("model-a"),
                Some("subscription_invalid_without_token"),
                now_ms,
            )
            .unwrap();
    }

    assert!(
        !store
            .availability_for_session(
                &session_a,
                "provider-a",
                Some("key-a"),
                Some("model-a"),
                13,
            )
            .available,
        "session A is cooled after three failures"
    );

    // 业务成功不再复活 provider 级冷却：冷却中 provider 不可达业务请求，
    // 恢复唯一路径是后台 probe 通过。
    store
        .record_provider_success_in_session(
            &session_b,
            "provider-a",
            Some("key-a"),
            Some("model-a"),
            14,
        )
        .unwrap();
    assert!(!store
        .availability_for_session(
            &session_a,
            "provider-a",
            Some("key-a"),
            Some("model-a"),
            15,
        )
        .available,
        "provider-level cooldown must not be cleared by a sibling session success");
    assert!(!store
        .availability_for_session(
            &session_b,
            "provider-a",
            Some("key-a"),
            Some("model-a"),
            15,
        )
        .available,
        "provider-level cooldown suppresses every session including the succeeding one");

    // 首次 probe 在冷却到期立即执行；失败后才按 probe interval 推迟下一次。
    assert!(
        store
            .provider_cooldown_probe_keys_due(13 + 15 * 60_000 + 1)
            .unwrap()
            .contains(&("provider-a".to_string(), Some("key-a".to_string()), Some("model-a".to_string()))),
        "cooled provider must appear in probe-due keys after cooldown expiry"
    );
    assert!(
        store
            .try_acquire_provider_cooldown_probe("provider-a", Some("key-a"), Some("model-a"))
            .unwrap()
    );
    store
        .complete_provider_cooldown_probe_success("provider-a", Some("key-a"), Some("model-a"))
        .unwrap();
    assert!(store
        .availability_for_session(
            &session_a,
            "provider-a",
            Some("key-a"),
            Some("model-a"),
            20,
        )
        .available,
        "probe success must revive provider for all sessions");
}

#[test]
fn same_fingerprint_three_times_blocks_provider_globally() {
    let store = V3ProviderGlobalSubscriptionHealthStore::default();
    let policy = V3ProviderGlobalSubscriptionPolicy::default();
    let session = scope("session-a");

    assert!(matches!(
        store
            .record_invalid_subscription_response(
                &session,
                "provider-a",
                Some("key-a"),
                Some("model-a"),
                invalid_subscription_fingerprint("missing_token"),
                1,
                &policy,
            )
            .unwrap(),
        V3ProviderGlobalSubscriptionDecision::SessionFailure { count: 1 }
    ));
    assert!(matches!(
        store
            .record_invalid_subscription_response(
                &session,
                "provider-a",
                Some("key-a"),
                Some("model-a"),
                invalid_subscription_fingerprint("missing_token"),
                2,
                &policy,
            )
            .unwrap(),
        V3ProviderGlobalSubscriptionDecision::SessionFailure { count: 2 }
    ));
    assert_eq!(
        store
            .record_invalid_subscription_response(
                &session,
                "provider-a",
                Some("key-a"),
                Some("model-a"),
                invalid_subscription_fingerprint("missing_token"),
                3,
                &policy,
            )
            .unwrap(),
        V3ProviderGlobalSubscriptionDecision::ProviderBlocked {
            blocked_until_ms: 3 + policy.cooldown_ms
        }
    );
    assert_eq!(
        store
            .availability("provider-a", Some("key-a"), Some("model-a"), 3)
            .unwrap()
            .blocked_until_ms,
        Some(3 + policy.cooldown_ms)
    );
}

#[test]
fn successful_probe_clears_provider_failures_before_next_session_window() {
    let store = V3ProviderGlobalSubscriptionHealthStore::default();
    let policy = V3ProviderGlobalSubscriptionPolicy::default();
    let session = scope("session-a");
    for now_ms in 1..=3 {
        store
            .record_invalid_subscription_response(
                &session,
                "provider-a",
                Some("key-a"),
                Some("model-a"),
                invalid_subscription_fingerprint("missing_token"),
                now_ms,
                &policy,
            )
            .unwrap();
    }
    let permit = store
        .try_acquire_probe("provider-a", Some("key-a"), Some("model-a"), 3 + policy.cooldown_ms)
        .unwrap()
        .unwrap();
    store.complete_probe_success(permit).unwrap();
    assert_eq!(
        store
            .record_invalid_subscription_response(
                &session,
                "provider-a",
                Some("key-a"),
                Some("model-a"),
                invalid_subscription_fingerprint("missing_token"),
                4 + policy.cooldown_ms,
                &policy,
            )
            .unwrap(),
        V3ProviderGlobalSubscriptionDecision::SessionFailure { count: 1 }
    );
}

#[test]
fn due_probe_preserves_scoped_auth_and_model_key() {
    let store = V3ProviderGlobalSubscriptionHealthStore::default();
    let policy = V3ProviderGlobalSubscriptionPolicy::default();
    let session = scope("session-a");

    for now_ms in 1..=3 {
        store
            .record_invalid_subscription_response(
                &session,
                "provider-a",
                Some("key-a"),
                Some("model-a"),
                invalid_subscription_fingerprint("missing_token"),
                now_ms,
                &policy,
            )
            .unwrap();
    }

    assert_eq!(
        store
            .provider_keys_with_probe_due(3 + policy.cooldown_ms)
            .unwrap(),
        vec![(
            "provider-a".to_string(),
            Some("key-a".to_string()),
            Some("model-a".to_string()),
        )]
    );
}

#[test]
fn session_success_clears_only_that_sessions_fingerprint_counter() {
    let store = V3ProviderGlobalSubscriptionHealthStore::default();
    let policy = V3ProviderGlobalSubscriptionPolicy::default();
    let session_a = scope("session-a");
    let session_b = scope("session-b");
    for now_ms in 1..=2 {
        store
            .record_invalid_subscription_response(
                &session_a,
                "provider-a",
                Some("key-a"),
                Some("model-a"),
                invalid_subscription_fingerprint("missing_token"),
                now_ms,
                &policy,
            )
            .unwrap();
        store
            .record_invalid_subscription_response(
                &session_b,
                "provider-a",
                Some("key-a"),
                Some("model-a"),
                invalid_subscription_fingerprint("missing_token"),
                now_ms,
                &policy,
            )
            .unwrap();
    }
    store
        .record_provider_success("provider-a", Some("key-a"), Some("model-a"), &session_a)
        .unwrap();
    assert_eq!(
        store
            .record_invalid_subscription_response(
                &session_a,
                "provider-a",
                Some("key-a"),
                Some("model-a"),
                invalid_subscription_fingerprint("missing_token"),
                3,
                &policy,
            )
            .unwrap(),
        V3ProviderGlobalSubscriptionDecision::SessionFailure { count: 1 }
    );
    assert!(matches!(
        store
            .record_invalid_subscription_response(
                &session_b,
                "provider-a",
                Some("key-a"),
                Some("model-a"),
                invalid_subscription_fingerprint("missing_token"),
                3,
                &policy,
            )
            .unwrap(),
        V3ProviderGlobalSubscriptionDecision::ProviderBlocked { .. }
    ));
}

#[test]
fn different_fingerprints_do_not_combine_and_probe_failure_reschedules_after_interval() {
    let store = V3ProviderGlobalSubscriptionHealthStore::default();
    let policy = V3ProviderGlobalSubscriptionPolicy::default();
    let session = scope("session-a");

    for (now_ms, code) in [(1, "code-a"), (2, "code-b"), (3, "code-c")] {
        let decision = store
            .record_invalid_subscription_response(
                &session,
                "provider-a",
                Some("key-a"),
                Some("model-a"),
                invalid_subscription_fingerprint(code),
                now_ms,
                &policy,
            )
            .unwrap();
        assert_eq!(decision, V3ProviderGlobalSubscriptionDecision::SessionFailure { count: 1 });
    }

    let blocked = store
        .record_invalid_subscription_response(
            &session,
            "provider-a",
            Some("key-a"),
            Some("model-a"),
            invalid_subscription_fingerprint("code-a"),
            4,
            &policy,
        )
        .unwrap();
    assert_eq!(blocked, V3ProviderGlobalSubscriptionDecision::SessionFailure { count: 2 });

    let blocked = store
        .record_invalid_subscription_response(
            &session,
            "provider-a",
            Some("key-a"),
            Some("model-a"),
            invalid_subscription_fingerprint("code-a"),
            5,
            &policy,
        )
        .unwrap();
    assert!(matches!(
        blocked,
        V3ProviderGlobalSubscriptionDecision::ProviderBlocked { .. }
    ));

    let permit = store
        .try_acquire_probe("provider-a", Some("key-a"), Some("model-a"), 5 + policy.cooldown_ms)
        .unwrap()
        .unwrap();
    store.complete_probe_failure(permit).unwrap();
    assert!(
        store
            .try_acquire_probe(
                "provider-a",
                Some("key-a"),
                Some("model-a"),
                5 + policy.cooldown_ms,
            )
            .unwrap()
            .is_none(),
        "failed probe must not be retried before its rescheduled interval"
    );
    assert!(
        store
            .provider_keys_with_probe_due(5 + policy.cooldown_ms + policy.probe_interval_ms + 1)
            .unwrap()
            .contains(&(
                "provider-a".to_string(),
                Some("key-a".to_string()),
                Some("model-a".to_string())
            )),
        "failed probe must become due again after the probe interval"
    );
    store.reset_after_restart().unwrap();
    assert!(
        store
            .availability("provider-a", Some("key-a"), Some("model-a"), u64::MAX)
            .unwrap()
            .blocked_until_ms
            .is_none()
    );
}

#[test]
fn stream_failure_cools_provider_immediately_and_probe_failure_keeps_excluded() {
    let store = V3ProviderHealthStore::default();
    let session_a = scope("session-a");

    // post-commit SSE 流失败直接写 provider 级冷却（不等 session 计数）。
    store
        .record_provider_stream_failure_in_provider_scope(
            "provider-a",
            Some("key-a"),
            Some("model-a"),
            "provider_response_sse_event_invalid",
            100,
        )
        .unwrap();
    assert!(
        !store
            .availability_for_session(
                &session_a,
                "provider-a",
                Some("key-a"),
                Some("model-a"),
                101,
            )
            .available,
        "single post-commit stream failure must cool provider immediately"
    );

    // 冷却到期后仍不可用，恢复唯一路径是 probe 通过。
    assert!(
        !store
            .availability_for_session(
                &session_a,
                "provider-a",
                Some("key-a"),
                Some("model-a"),
                100 + 900_000 + 1,
            )
            .available,
        "expired cooldown must stay excluded until probe passes"
    );
    assert_eq!(
        store
            .provider_cooldown_probe_keys_due(100 + 900_000 + 1)
            .unwrap()
            .len(),
        1,
        "cooldown expiry must probe immediately"
    );

    // 首次 probe → 失败 → 保持冷却并推后下一次探针。
    let due = store
        .provider_cooldown_probe_keys_due(100 + 900_000 + 1)
        .unwrap();
    assert_eq!(due.len(), 1, "cooled provider must be probe-due after interval");
    assert!(
        store
            .try_acquire_provider_cooldown_probe("provider-a", Some("key-a"), Some("model-a"))
            .unwrap()
    );
    store
        .complete_provider_cooldown_probe_failure(
            "provider-a",
            Some("key-a"),
            Some("model-a"),
            100 + 900_000 + 1,
        )
        .unwrap();
    assert!(
        store
            .provider_cooldown_probe_keys_due(100 + 900_000 + 1)
            .unwrap()
            .is_empty(),
        "failed probe must push next probe forward"
    );
    assert!(
        !store
            .availability_for_session(
                &session_a,
                "provider-a",
                Some("key-a"),
                Some("model-a"),
                100 + 900_000 + 15 * 60_000 + 2,
            )
            .available,
        "provider must stay excluded after failed probe"
    );

    // 下一次 probe 通过 → 恢复。
    assert!(
        store
            .provider_cooldown_probe_keys_due(100 + 900_000 + 15 * 60_000 + 1)
            .unwrap()
            .contains(&("provider-a".to_string(), Some("key-a".to_string()), Some("model-a".to_string())))
    );
    assert!(
        store
            .try_acquire_provider_cooldown_probe("provider-a", Some("key-a"), Some("model-a"))
            .unwrap()
    );
    store
        .complete_provider_cooldown_probe_success("provider-a", Some("key-a"), Some("model-a"))
        .unwrap();
    assert!(store
        .availability_for_session(
            &session_a,
            "provider-a",
            Some("key-a"),
            Some("model-a"),
            100 + 900_000 + 15 * 60_000 + 2,
        )
        .available);
}
