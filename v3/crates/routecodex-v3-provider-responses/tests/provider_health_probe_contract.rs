use routecodex_v3_provider_responses::V3ProviderHealthStore;

fn real_http_failure_action(
    status: u16,
    code: &str,
) -> routecodex_v3_provider_responses::V3ProviderFailureAction {
    let classified = routecodex_v3_error::build_v3_error_02_classified_from_v3_error_01(
        routecodex_v3_error::build_v3_error_01_source_raised_external(
            routecodex_v3_error::V3ErrorSourceKind::ProviderFailure,
            "V3ProviderResp14Raw",
            code,
            "controlled provider failure",
            routecodex_v3_error::V3ExternalErrorLink {
                kind: routecodex_v3_error::V3ExternalErrorKind::Provider,
                status: Some(status),
                code: Some(code.into()),
                provider_id: Some("p".into()),
                upstream_request_id: None,
                message: Some("controlled provider failure".into()),
            },
        ),
    );
    routecodex_v3_error::build_v3_provider_failure_action_from_v3_error_02(&classified)
}

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
fn business_success_resets_early_429_cooldown_without_window() {
    let store = V3ProviderHealthStore::default();
    let action = real_http_failure_action(429, "rate_limit_error");
    let failed = store
        .record_provider_failure_action("p", "a", "m", &action, 100)
        .unwrap();
    assert!(failed.cooldown && !failed.available, "429 uses the ordinary recoverable control path");
    assert_eq!(failed.cooldown_until_ms, Some(5_100));
    assert!(
        store
            .scheduling_projection("p", "sibling", "m", 1, 1, 101)
            .unwrap()
            .available,
        "a sibling identity is not affected"
    );

    let recovered = store
        .record_provider_key_success("p", "a", "m", 101)
        .unwrap();
    assert!(recovered.available);
    assert!(!recovered.cooldown);
    assert_eq!(recovered.success_streak, 1, "one real success counts once");

    let repeated = store
        .record_provider_failure_action("p", "a", "m", &action, 102)
        .unwrap();
    assert!(repeated.cooldown && !repeated.available, "matching success starts a fresh failure streak");
    let permit = store
        .acquire_provider_cooldown_probe("p", Some("a"), Some("m"))
        .expect("probe acquisition")
        .expect("cooldown owns the probe slot");
    store
        .record_provider_key_success("p", "a", "m", 103)
        .expect("matching business success");
    store
        .complete_provider_cooldown_probe_success_with_permit(&permit, 104)
        .expect("current probe completion");
    let projection = store
        .scheduling_projection("p", "a", "m", 1, 1, 104)
        .expect("projection after recovery");
    assert!(projection.available);
}

#[test]
fn consecutive_429_fingerprints_each_start_their_own_streak() {
    let store = V3ProviderHealthStore::default();
    let mut action = routecodex_v3_provider_responses::V3ProviderFailureAction::recoverable("429");
    action.failure_threshold = 3;
    for (time, code) in [(100, "rate_limit"), (101, "insufficient_quota"), (102, "other")] {
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
        assert_eq!(
            projection.failure_streak, 1,
            "each typed 429 fingerprint starts its own streak"
        );
        assert!(!projection.cooldown, "failure_threshold is 3 and these fingerprints do not add up");
        for (key, model) in [("a", "other-model"), ("sibling", "m")] {
            assert!(
                store
                    .scheduling_projection("p", key, model, 1, 1, time)
                    .unwrap()
                    .available
            );
        }
    }
}

#[test]
fn early_429_preserves_non429_cooldown_until_matching_business_success() {
    let store = V3ProviderHealthStore::default();
    let mut action = real_http_failure_action(503, "provider_http_503");
    action.failure_threshold = 1;
    assert!(
        store
            .record_provider_failure_action("p", "a", "m", &action, 100)
            .unwrap()
            .cooldown
    );
    action = real_http_failure_action(429, "rate_limit_error");
    store
        .record_provider_failure_action("p", "a", "m", &action, 101)
        .unwrap();
    assert!(
        !store
            .scheduling_projection("p", "a", "m", 1, 1, 101)
            .unwrap()
            .available,
        "a429 diagnostic cannot release the existing503 exclusion"
    );
    assert!(
        store
            .record_provider_key_success("p", "a", "m", 102)
            .unwrap()
            .available
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
