use routecodex_v3_provider_responses::V3ProviderHealthStore;

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
    let generation = store
        .scheduling_projection("p", "a", "m", 1, 1, 103)
        .unwrap()
        .score_generation;
    store
        .acquire_provider_cooldown_probe("p", Some("a"), Some("m"))
        .unwrap()
        .unwrap();
    let availability_generation = store.availability_generation();
    store
        .record_provider_key_success("p", "a", "m", 104)
        .unwrap();
    assert_ne!(store.availability_generation(), availability_generation);
    store
        .complete_provider_cooldown_probe_failure_at_generation(
            "p",
            Some("a"),
            Some("m"),
            105,
            Some(generation),
        )
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
    store
        .acquire_provider_cooldown_probe("provider-a", Some("key-a"), Some("gpt-5.5"))
        .expect("acquire probe")
        .expect("probe permit");
    store
        .complete_provider_cooldown_probe_failure("provider-a", Some("key-a"), Some("gpt-5.5"), 200)
        .expect("complete probe failure");
    let after = store
        .scheduling_projection("provider-a", "key-a", "gpt-5.5", 1, 1, 200)
        .expect("health projection after probe");
    assert_eq!(after.score_milli, before.score_milli);
    assert_eq!(after.score_generation, before.score_generation);
}
