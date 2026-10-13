use routecodex_v3_provider_responses::V3ProviderHealthStore;

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
                .scheduling_projection_for_key_with_interface("p", "alternate", "k", "m", 1, 1, due)
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
                    "p",
                    "alternate",
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
fn business_success_immediately_recovers_429_cooldown() {
    let store = V3ProviderHealthStore::default();
    let mut action = routecodex_v3_provider_responses::V3ProviderFailureAction::recoverable("429");
    action.failure_threshold = 3;
    action.failure_fingerprint =
        routecodex_v3_error::build_v3_provider_global_error_fingerprint(429).unwrap();
    for time in 100..103 {
        let projection = store
            .record_provider_failure_action("p", "a", "m", &action, time)
            .unwrap();
        assert_eq!(projection.cooldown, time == 102);
    }
    let recovered = store
        .record_provider_key_success("p", "a", "m", 103)
        .unwrap();
    assert!(recovered.available);
    assert!(!recovered.cooldown);
    assert_eq!(recovered.success_streak, 1, "one real success counts once");
}

#[test]
fn consecutive_429_codes_share_count_and_success_invalidates_old_probe() {
    let store = V3ProviderHealthStore::default();
    let mut action = routecodex_v3_provider_responses::V3ProviderFailureAction::recoverable("429");
    action.failure_threshold = 3;
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
        assert_eq!(projection.failure_streak, (time - 99) as u32);
        assert_eq!(projection.cooldown, time == 102);
    }
    let permit = store
        .acquire_provider_cooldown_probe("p", Some("a"), Some("m"))
        .unwrap()
        .unwrap();
    let availability_generation = store.availability_generation();
    store
        .record_provider_key_success("p", "a", "m", 104)
        .unwrap();
    assert_ne!(store.availability_generation(), availability_generation);
    store
        .complete_provider_cooldown_probe_failure_with_permit(&permit, 105)
        .unwrap();
    assert!(
        store
            .scheduling_projection("p", "a", "m", 1, 1, 106)
            .unwrap()
            .available
    );
    assert!(store
        .provider_cooldown_probe_keys_due(1_000_000)
        .unwrap()
        .is_empty());
    for time in [107, 108] {
        assert!(
            store
                .record_provider_failure_action("p", "a", "m", &action, time)
                .unwrap()
                .available
        );
    }
}

#[test]
fn business_success_preserves_non_429_cause_after_later_429_diagnostic() {
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
    action.failure_threshold = 3;
    action.failure_fingerprint =
        routecodex_v3_error::build_v3_provider_global_error_fingerprint(429).unwrap();
    store
        .record_provider_failure_action("p", "a", "m", &action, 101)
        .unwrap();
    assert!(
        store
            .record_provider_key_success("p", "a", "m", 102)
            .unwrap()
            .cooldown
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
