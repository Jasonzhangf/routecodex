use routecodex_v3_provider_responses::{V3ProviderHealthStore, V3ProviderInterfaceIdentity};

#[test]
fn acquired_owner_release_preserves_due_time_and_rejects_late_a_after_actual_b() {
    for late in ["cancel", "success", "failure"] {
        let store = V3ProviderHealthStore::default();
        let mut action =
            routecodex_v3_provider_responses::V3ProviderFailureAction::recoverable("transport");
        action.failure_threshold = 1;
        store
            .record_provider_failure_action_for_interface("p", "alternate", "k", "m", &action, 100)
            .unwrap();
        let a = store
            .acquire_provider_cooldown_probe_for_interface("p", "alternate", Some("k"), Some("m"))
            .unwrap()
            .unwrap();
        let newer = store
            .record_provider_failure_action_for_interface("p", "alternate", "k", "m", &action, 200)
            .unwrap();
        assert!(newer.score_generation > a.expected_generation());
        store.cancel_provider_cooldown_probe(&a).unwrap();
        let due = store
            .provider_cooldown_probe_next_deadline_ms_for_interface(
                "p",
                "alternate",
                Some("k"),
                Some("m"),
            )
            .unwrap()
            .unwrap();
        assert_eq!(due, 5_200);
        assert!(store
            .acquire_provider_cooldown_probe_if_due_for_interface(
                "p",
                "alternate",
                Some("k"),
                Some("m"),
                due - 1
            )
            .unwrap()
            .is_none());
        let b = store
            .acquire_provider_cooldown_probe_if_due_for_interface(
                "p",
                "alternate",
                Some("k"),
                Some("m"),
                due,
            )
            .unwrap()
            .unwrap();
        match late {
            "cancel" => store.cancel_provider_cooldown_probe(&a).unwrap(),
            "success" => store
                .complete_provider_cooldown_probe_success_with_permit(&a, due)
                .unwrap(),
            "failure" => store
                .complete_provider_cooldown_probe_failure_with_permit(&a, due)
                .unwrap(),
            _ => unreachable!(),
        }
        assert!(store
            .acquire_provider_cooldown_probe_for_interface("p", "alternate", Some("k"), Some("m"))
            .unwrap()
            .is_none());
        assert_eq!(
            store
                .scheduling_projection_for_key_with_interface(
                    V3ProviderInterfaceIdentity::new("p", "alternate"),
                    "k",
                    "m",
                    1,
                    1,
                    due,
                )
                .unwrap()
                .score_generation,
            newer.score_generation
        );
        store
            .complete_provider_cooldown_probe_failure_with_permit(&b, due)
            .unwrap();
        assert_eq!(
            store
                .provider_cooldown_probe_next_deadline_ms_for_interface(
                    "p",
                    "alternate",
                    Some("k"),
                    Some("m")
                )
                .unwrap(),
            Some(due + 10_000)
        );
        let c = store
            .acquire_provider_cooldown_probe_if_due_for_interface(
                "p",
                "alternate",
                Some("k"),
                Some("m"),
                due + 10_000,
            )
            .unwrap()
            .unwrap();
        // A failed probe does not advance health generation: B cannot release C either.
        assert_eq!(b.expected_generation(), c.expected_generation());
        store.cancel_provider_cooldown_probe(&b).unwrap();
        assert!(store
            .acquire_provider_cooldown_probe_for_interface("p", "alternate", Some("k"), Some("m"))
            .unwrap()
            .is_none());
        store
            .complete_provider_cooldown_probe_success_with_permit(&c, due + 10_000)
            .unwrap();
        assert!(
            store
                .scheduling_projection_for_key_with_interface(
                    V3ProviderInterfaceIdentity::new("p", "alternate"),
                    "k",
                    "m",
                    1,
                    1,
                    due + 10_000
                )
                .unwrap()
                .available
        );
    }
}

#[test]
fn a_single_429_latches_a_bounded_hold_released_by_success_or_expiry() {
    // HTTP 429 latches a bounded rate-limit hold on its exact identity: the first
    // 429 holds the identity out of selection for the policy window (~1 minute),
    // a real business success releases it immediately, and the hold also expires
    // on its own so the key is never pinned to the long ladder.
    let store = V3ProviderHealthStore::default();
    let mut action = routecodex_v3_provider_responses::V3ProviderFailureAction::recoverable("429");
    action.recovery = routecodex_v3_provider_responses::V3ProviderRecoveryKind::RecoverableCounted;
    action.failure_threshold = 1;
    action.cooldown_ms = 60_000;
    action.failure_fingerprint =
        routecodex_v3_error::build_v3_provider_global_error_fingerprint(429).unwrap();
    let held = store
        .record_provider_failure_action("p", "a", "m", &action, 100)
        .unwrap();
    assert!(held.cooldown, "the first 429 must latch the bounded hold");
    assert!(
        !held.available,
        "the held identity leaves selection during the window"
    );
    let projection = store
        .scheduling_projection("p", "a", "m", 1, 1, 100 + 59_000)
        .unwrap();
    assert!(!projection.available, "still held near the window end");
    let projection = store
        .scheduling_projection("p", "a", "m", 1, 1, 100 + 60_000)
        .unwrap();
    assert!(
        projection.available,
        "the hold auto-releases at window expiry"
    );
    // A real business success releases the hold early, before expiry.
    let released = store
        .record_provider_key_success("p", "a", "m", 200)
        .unwrap();
    assert!(released.available);
    assert!(!released.cooldown);
}

#[test]
fn consecutive_429_codes_share_one_bounded_hold_identity() {
    // Different 429 provider codes are separate diagnostics of the same
    // backpressure signal. Each still latches the bounded hold, but the hold is
    // keyed by the exact provider+key+model identity, not by the diagnostic code.
    let store = V3ProviderHealthStore::default();
    let mut action = routecodex_v3_provider_responses::V3ProviderFailureAction::recoverable("429");
    action.recovery = routecodex_v3_provider_responses::V3ProviderRecoveryKind::RecoverableCounted;
    action.failure_threshold = 1;
    action.cooldown_ms = 60_000;
    for (time, code) in [
        (100, "rate_limit"),
        (101, "insufficient_quota"),
        (102, "other"),
    ] {
        action.failure_fingerprint = Some(
            routecodex_v3_error::V3ProviderErrorFingerprint::new(
                "recoverable_upstream",
                code,
                429,
                code,
            )
            .unwrap(),
        );
        let projection = store
            .record_provider_failure_action("p", "a", "m", &action, time)
            .unwrap();
        assert!(projection.cooldown, "every 429 latches the bounded hold");
        assert!(!projection.available);
    }
    // Sibling keys/models of the same provider stay healthy and selectable.
    assert!(
        store
            .scheduling_projection("p", "a", "other-model", 1, 1, 102)
            .unwrap()
            .available
    );
    assert!(
        store
            .scheduling_projection("p", "sibling", "m", 1, 1, 102)
            .unwrap()
            .available
    );
}

#[test]
fn a_429_hold_still_ends_on_a_real_success_while_a_health_cooldown_is_outstanding() {
    // A 429 hold seen while a real 5xx cooldown is outstanding keeps the identity
    // excluded and re-stamps the bounded rate-limit window. Any real success on
    // the exact identity still releases the whole exclusion immediately, which is
    // the declared recovery rule for a rate-limit hold.
    let store = V3ProviderHealthStore::default();
    let mut action = routecodex_v3_provider_responses::V3ProviderFailureAction::recoverable("503");
    action.failure_threshold = 1;
    action.failure_fingerprint =
        routecodex_v3_error::build_v3_provider_global_error_fingerprint(503).unwrap();
    assert!(
        store
            .record_provider_failure_action("p", "a", "m", &action, 100)
            .unwrap()
            .cooldown
    );
    let mut rate_limited =
        routecodex_v3_provider_responses::V3ProviderFailureAction::recoverable("429");
    rate_limited.recovery =
        routecodex_v3_provider_responses::V3ProviderRecoveryKind::RecoverableCounted;
    rate_limited.failure_threshold = 1;
    rate_limited.cooldown_ms = 60_000;
    rate_limited.failure_fingerprint =
        routecodex_v3_error::build_v3_provider_global_error_fingerprint(429).unwrap();
    let after_429 = store
        .record_provider_failure_action("p", "a", "m", &rate_limited, 101)
        .unwrap();
    assert!(
        after_429.cooldown,
        "a 429 hold must not clear an outstanding health cooldown"
    );
    assert!(
        store
            .record_provider_key_success("p", "a", "m", 102)
            .unwrap()
            .available,
        "a business success releases the whole exclusion"
    );
}

#[test]
fn failed_cooldown_probe_does_not_mutate_transport_health_history() {
    let store = V3ProviderHealthStore::default();
    store
        .record_provider_cooldown_failure(
            "provider-a",
            Some("key-a"),
            Some("gpt-5.5"),
            "transport failure",
            100,
            900_000,
        )
        .expect("record provider failure");
    let before = store
        .scheduling_projection("provider-a", "key-a", "gpt-5.5", 1, 1, 100)
        .expect("health projection before probe");
    let permit = store
        .acquire_provider_cooldown_probe("provider-a", Some("key-a"), Some("gpt-5.5"))
        .expect("acquire probe")
        .expect("probe permit");
    store
        .complete_provider_cooldown_probe_failure_with_permit(&permit, 200)
        .expect("complete probe failure");
    let after = store
        .scheduling_projection("provider-a", "key-a", "gpt-5.5", 1, 1, 200)
        .expect("health projection after probe");
    assert_eq!(after.score_milli, before.score_milli);
    assert_eq!(after.score_generation, before.score_generation);
}
