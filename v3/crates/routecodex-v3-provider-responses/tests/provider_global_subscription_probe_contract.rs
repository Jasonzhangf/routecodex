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
fn session_success_must_not_clear_another_session_cooldown() {
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
        "session A remains cooled after session B success"
    );
    assert!(store
        .availability_for_session(
            &session_b,
            "provider-a",
            Some("key-a"),
            Some("model-a"),
            13,
        )
        .available);
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
fn different_fingerprints_do_not_combine_and_probe_failure_suspends_until_restart() {
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
                5 + policy.cooldown_ms + policy.probe_interval_ms,
            )
            .unwrap()
            .is_none(),
        "failed probe must not be retried before restart"
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
