use routecodex_v3_error::V3ProviderFailureSessionScope;
use routecodex_v3_provider_responses::{V3ProviderAvailabilityReader, V3ProviderHealthStore};

fn session_scope() -> V3ProviderFailureSessionScope {
    V3ProviderFailureSessionScope::new("server", "group", "session-a").unwrap()
}

fn record_global_errors(
    store: &V3ProviderHealthStore,
    provider_id: &str,
    interface_id: &str,
    auth_alias: &str,
    model_id: &str,
    status: Option<u16>,
    first_at_ms: u64,
    count: u64,
) {
    for offset in 0..count {
        store
            .record_real_provider_failure_for_interface(
                provider_id,
                interface_id,
                auth_alias,
                model_id,
                status,
                first_at_ms + offset,
            )
            .unwrap();
    }
}

fn establish_non429_global_cooldown(
    store: &V3ProviderHealthStore,
    provider_id: &str,
    interface_id: &str,
    auth_alias: &str,
    model_id: &str,
    first_at_ms: u64,
) -> u64 {
    record_global_errors(
        store,
        provider_id,
        interface_id,
        auth_alias,
        model_id,
        Some(503),
        first_at_ms,
        10,
    );
    let cooled_at = first_at_ms + 9;
    assert!(
        !store
            .scheduling_projection_for_key_with_interface(
                provider_id,
                interface_id,
                auth_alias,
                model_id,
                1,
                1,
                cooled_at,
            )
            .unwrap()
            .available,
        "ten real non-429 errors must establish the global cooldown"
    );
    cooled_at
}

#[test]
fn acquired_owner_release_preserves_due_time_and_rejects_late_a_after_actual_b() {
    for late in ["cancel", "success", "failure"] {
        let store = V3ProviderHealthStore::default();
        establish_non429_global_cooldown(&store, "p", "alternate", "k", "m", 100);
        let a = store
            .acquire_provider_cooldown_probe_for_interface("p", "alternate", Some("k"), Some("m"))
            .unwrap()
            .unwrap();
        store
            .record_real_provider_failure_for_interface("p", "alternate", "k", "m", Some(503), 200)
            .unwrap();
        let newer = store
            .scheduling_projection_for_key_with_interface("p", "alternate", "k", "m", 1, 1, 200)
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
fn business_success_resets_early_429_window_without_count_based_cooling() {
    let store = V3ProviderHealthStore::default();
    let session = session_scope();
    for time in [100, 101] {
        let projection = store
            .record_session_rate_limit_for_interface(&session, "p", "responses", "a", "m", time)
            .unwrap();
        assert!(
            projection.available,
            "the first two 429s stay session-local"
        );
    }
    let cooled = store
        .record_session_rate_limit_for_interface(&session, "p", "responses", "a", "m", 102)
        .unwrap();
    assert!(!cooled.available);
    assert_eq!(cooled.cooldown_until_ms, Some(10_102));
    store
        .record_provider_success_in_session_for_interface(
            &session,
            "p",
            "responses",
            Some("a"),
            Some("m"),
            103,
        )
        .unwrap();
    assert!(
        store
            .availability_for_session_for_interface(
                &session,
                "p",
                "responses",
                Some("a"),
                Some("m"),
                103,
            )
            .unwrap()
            .available,
        "matching session success must reset the session 429 episode"
    );

    record_global_errors(&store, "p", "responses", "a", "m", Some(429), 1_000, 10);
    assert!(
        store
            .availability_for_interface("p", "responses", Some("a"), Some("m"), 1_009)
            .unwrap()
            .available,
        "ten 429s within two minutes must not establish a global cooldown"
    );
    store
        .record_real_provider_failure_for_interface("p", "responses", "a", "m", Some(429), 121_001)
        .unwrap();
    assert!(
        !store
            .availability_for_interface("p", "responses", Some("a"), Some("m"), 121_001)
            .unwrap()
            .available,
        "the tenth 429 more than two minutes after the first must cool globally"
    );
    store
        .record_provider_key_success_for_interface("p", "responses", "a", "m", 121_002)
        .unwrap();
    assert!(
        store
            .availability_for_interface("p", "responses", Some("a"), Some("m"), 121_002)
            .unwrap()
            .available,
        "matching business success must reset the global 429 episode"
    );
}

#[test]
fn consecutive_429_codes_share_window_and_post_minimum_success_invalidates_old_probe() {
    let store = V3ProviderHealthStore::default();
    record_global_errors(&store, "p", "default", "a", "m", Some(429), 100, 9);
    assert!(
        store
            .scheduling_projection("p", "a", "m", 1, 1, 108)
            .unwrap()
            .available,
        "nine real 429s must not establish the global cooldown"
    );
    store
        .record_real_provider_failure_for_interface("p", "default", "a", "m", Some(429), 120_101)
        .unwrap();
    assert!(
        !store
            .scheduling_projection("p", "a", "m", 1, 1, 120_101)
            .unwrap()
            .available,
        "the tenth 429 more than two minutes after the first must cool globally"
    );
    for (key, model) in [("a", "other-model"), ("sibling", "m")] {
        assert!(
            store
                .scheduling_projection("p", key, model, 1, 1, 120_101)
                .unwrap()
                .available,
            "a cooled exact identity must not block sibling identities"
        );
    }
    let permit = store
        .acquire_provider_cooldown_probe("p", Some("a"), Some("m"))
        .unwrap()
        .unwrap();
    let availability_generation = store.availability_generation();
    store
        .record_provider_key_success("p", "a", "m", 1920101)
        .unwrap();
    assert_ne!(store.availability_generation(), availability_generation);
    store
        .complete_provider_cooldown_probe_failure_with_permit(&permit, 1920102)
        .unwrap();
    assert!(
        store
            .scheduling_projection("p", "a", "m", 1, 1, 1920103)
            .unwrap()
            .available
    );
    assert!(store
        .provider_cooldown_probe_keys_due(2_000_000)
        .unwrap()
        .is_empty());
    for time in [1920104, 1920105] {
        store
            .record_real_provider_failure_for_interface("p", "default", "a", "m", Some(429), time)
            .unwrap();
        assert!(
            store
                .scheduling_projection("p", "a", "m", 1, 1, time)
                .unwrap()
                .available
        );
    }
}

#[test]
fn early_429_preserves_non429_cooldown_until_matching_business_success() {
    let store = V3ProviderHealthStore::default();
    establish_non429_global_cooldown(&store, "p", "default", "a", "m", 100);
    store
        .record_real_provider_failure_for_interface("p", "default", "a", "m", Some(429), 110)
        .unwrap();
    assert!(
        !store
            .scheduling_projection("p", "a", "m", 1, 1, 110)
            .unwrap()
            .available,
        "a429 diagnostic cannot release the existing503 exclusion"
    );
    assert!(
        store
            .record_provider_key_success("p", "a", "m", 111)
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
