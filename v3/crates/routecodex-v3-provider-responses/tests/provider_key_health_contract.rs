use routecodex_v3_error::V3ProviderFailureSessionScope;
use routecodex_v3_provider_responses::{
    V3ProviderAvailabilityReader, V3ProviderFailureAction, V3ProviderHealthStore,
    V3ProviderKeyHealthStore, V3ProviderRecoveryKind,
};

fn session(name: &str) -> V3ProviderFailureSessionScope {
    V3ProviderFailureSessionScope::new("server", "group", name).expect("valid session scope")
}

fn record_global_errors(
    store: &V3ProviderHealthStore,
    interface: &str,
    key: &str,
    model: &str,
    status: Option<u16>,
    first_at_ms: u64,
) {
    for offset in 0..10 {
        store
            .record_real_provider_failure_for_interface(
                "provider",
                interface,
                key,
                model,
                status,
                first_at_ms + offset,
            )
            .expect("record real provider failure");
    }
}

#[test]
fn three_429_cool_only_the_matching_session_for_ten_seconds() {
    let store = V3ProviderHealthStore::default();
    let a = session("a");
    let b = session("b");

    for now_ms in [1_000, 2_000] {
        let projection = store
            .record_session_rate_limit_for_interface(
                &a,
                "provider",
                "responses",
                "key",
                "model",
                now_ms,
            )
            .expect("record 429");
        assert!(
            projection.available,
            "the first two 429s remain session-local capacity pressure"
        );
    }

    let cooled = store
        .record_session_rate_limit_for_interface(&a, "provider", "responses", "key", "model", 3_000)
        .expect("record third 429");
    assert!(!cooled.available);
    assert_eq!(cooled.cooldown_until_ms, Some(13_000));
    assert!(
        !store
            .availability_for_session_for_interface(
                &a,
                "provider",
                "responses",
                Some("key"),
                Some("model"),
                3_000,
            )
            .unwrap()
            .available
    );
    assert!(
        store
            .availability_for_session_for_interface(
                &b,
                "provider",
                "responses",
                Some("key"),
                Some("model"),
                3_000,
            )
            .unwrap()
            .available
    );
    assert!(
        store
            .availability_for_session_for_interface(
                &a,
                "provider",
                "responses",
                Some("other-key"),
                Some("model"),
                3_000,
            )
            .unwrap()
            .available
    );
}

#[test]
fn session_429_cooldown_doubles_and_tenth_uses_hourly_mode() {
    let store = V3ProviderHealthStore::default();
    let scope = session("a");
    let mut now_ms = 1_000;

    for count in 1..=10 {
        let projection = store
            .record_session_rate_limit_for_interface(
                &scope,
                "provider",
                "responses",
                "key",
                "model",
                now_ms,
            )
            .expect("record 429");
        if count >= 3 {
            let duration_ms = if count == 10 {
                3_600_000
            } else {
                10_000u64 << (count - 3)
            };
            assert_eq!(
                projection.cooldown_until_ms,
                Some(now_ms + duration_ms),
                "429 observation {count}"
            );
            now_ms += duration_ms;
        } else {
            assert!(projection.available);
            now_ms += 1;
        }
    }
}

#[test]
fn matching_business_success_recovers_session_429_immediately() {
    let store = V3ProviderHealthStore::default();
    let a = session("a");
    let b = session("b");
    for now_ms in [1_000, 2_000, 3_000] {
        store
            .record_session_rate_limit_for_interface(
                &a,
                "provider",
                "responses",
                "key",
                "model",
                now_ms,
            )
            .expect("record 429");
    }
    assert!(
        !store
            .availability_for_session_for_interface(
                &a,
                "provider",
                "responses",
                Some("key"),
                Some("model"),
                3_000,
            )
            .unwrap()
            .available
    );

    store
        .record_provider_success_in_session_for_interface(
            &b,
            "provider",
            "responses",
            Some("key"),
            Some("model"),
            3_100,
        )
        .expect("record matching business success");
    assert!(
        store
            .availability_for_session_for_interface(
                &a,
                "provider",
                "responses",
                Some("key"),
                Some("model"),
                3_100,
            )
            .unwrap()
            .available
    );
}

#[test]
fn ten_real_non429_errors_trigger_exact_identity_global_cooldown() {
    let store = V3ProviderHealthStore::default();
    for offset in 0..9 {
        store
            .record_real_provider_failure_for_interface(
                "provider",
                "responses",
                "key",
                "model",
                Some(503),
                1_000 + offset,
            )
            .expect("record real provider failure");
    }
    assert!(
        store
            .availability_for_interface("provider", "responses", Some("key"), Some("model"), 1_008,)
            .unwrap()
            .available
    );

    store
        .record_real_provider_failure_for_interface(
            "provider",
            "responses",
            "key",
            "model",
            Some(503),
            1_009,
        )
        .expect("record tenth real provider failure");
    assert!(
        !store
            .availability_for_interface("provider", "responses", Some("key"), Some("model"), 1_009,)
            .unwrap()
            .available
    );
    assert!(
        store
            .availability_for_interface(
                "provider",
                "responses",
                Some("other-key"),
                Some("model"),
                1_009,
            )
            .unwrap()
            .available
    );
}

#[test]
fn global_429_requires_ten_errors_and_more_than_two_minutes() {
    let burst = V3ProviderHealthStore::default();
    record_global_errors(&burst, "responses", "key", "model", Some(429), 1_000);
    assert!(
        burst
            .availability_for_interface("provider", "responses", Some("key"), Some("model"), 1_009,)
            .unwrap()
            .available
    );

    let spaced = V3ProviderHealthStore::default();
    for now_ms in [
        1_000, 2_000, 3_000, 4_000, 5_000, 6_000, 7_000, 8_000, 9_000,
    ] {
        spaced
            .record_real_provider_failure_for_interface(
                "provider",
                "responses",
                "key",
                "model",
                Some(429),
                now_ms,
            )
            .expect("record real 429");
    }
    spaced
        .record_real_provider_failure_for_interface(
            "provider",
            "responses",
            "key",
            "model",
            Some(429),
            121_001,
        )
        .expect("record tenth spaced 429");
    assert!(
        !spaced
            .availability_for_interface(
                "provider",
                "responses",
                Some("key"),
                Some("model"),
                121_001,
            )
            .unwrap()
            .available
    );
}

#[test]
fn matching_business_success_recovers_only_its_non429_cooldown() {
    let store = V3ProviderHealthStore::default();
    for (index, (interface, key, model)) in [
        ("default", "a", "m"),
        ("default", "b", "m"),
        ("default", "a", "other"),
        ("chat", "a", "m"),
    ]
    .into_iter()
    .enumerate()
    {
        record_global_errors(
            &store,
            interface,
            key,
            model,
            Some(503),
            1_000 + (index as u64 * 100),
        );
        assert!(
            !store
                .availability_for_interface("provider", interface, Some(key), Some(model), 2_000,)
                .unwrap()
                .available
        );
    }

    store
        .record_provider_key_success_for_interface("provider", "default", "a", "m", 2_001)
        .expect("record matching success");
    assert!(
        store
            .availability_for_interface("provider", "default", Some("a"), Some("m"), 2_001,)
            .unwrap()
            .available
    );
    for (interface, key, model) in [
        ("default", "b", "m"),
        ("default", "a", "other"),
        ("chat", "a", "m"),
    ] {
        assert!(
            !store
                .availability_for_interface("provider", interface, Some(key), Some(model), 2_001,)
                .unwrap()
                .available
        );
    }
}

#[test]
fn provider_health_cooldown_is_isolated_between_interfaces() {
    let store = V3ProviderHealthStore::default();
    record_global_errors(&store, "responses", "key", "model", Some(503), 1_000);
    assert!(
        !store
            .availability_for_interface("provider", "responses", Some("key"), Some("model"), 1_009,)
            .unwrap()
            .available
    );
    assert!(
        store
            .availability_for_interface("provider", "default", Some("key"), Some("model"), 1_009,)
            .unwrap()
            .available
    );
}

#[test]
fn valid_probe_success_restores_exact_global_identity() {
    let store = V3ProviderHealthStore::default();
    record_global_errors(&store, "responses", "key", "model", Some(503), 1_000);
    let permit = store
        .acquire_provider_cooldown_probe_for_interface(
            "provider",
            "responses",
            Some("key"),
            Some("model"),
        )
        .expect("acquire probe")
        .expect("cooled identity owns a probe slot");
    store
        .complete_provider_cooldown_probe_success_with_permit(&permit, 1_010)
        .expect("complete successful probe");
    assert!(
        store
            .availability_for_interface("provider", "responses", Some("key"), Some("model"), 1_010,)
            .unwrap()
            .available
    );
}

#[test]
fn diagnostic_score_does_not_trigger_global_cooldown() {
    let store = V3ProviderKeyHealthStore::default();
    let action = V3ProviderFailureAction {
        recovery: V3ProviderRecoveryKind::RecoverableCounted,
        score_delta_milli: -100,
        failure_threshold: 1,
        ..V3ProviderFailureAction::recoverable("controlled")
    };
    let projection = store
        .record_provider_failure_action("provider", "key", "model", &action, 1_000)
        .expect("record diagnostic observation");
    assert_eq!(projection.score_milli, 0);
    assert!(projection.available);
    assert!(!projection.cooldown);
}

#[test]
fn configured_and_unseen_identities_start_at_score_100() {
    let store = V3ProviderKeyHealthStore::default();
    let projection = store
        .scheduling_projection("provider", "key", "model", 3, 2, 1_000)
        .expect("initial projection");
    assert_eq!(projection.score_milli, 100);
    assert_eq!(projection.priority, 3);
    assert_eq!(projection.effective_priority, 3);
}

#[test]
fn score_is_clamped_per_event_without_hidden_credit() {
    let store = V3ProviderKeyHealthStore::default();
    for now_ms in 0..100 {
        store
            .record_provider_key_success("provider", "key", "model", now_ms)
            .expect("record success");
    }
    assert_eq!(
        store
            .scheduling_projection("provider", "key", "model", 1, 1, 100)
            .expect("capped projection")
            .score_milli,
        150
    );
    store
        .record_provider_failure_action(
            "provider",
            "key",
            "model",
            &V3ProviderFailureAction::recoverable("controlled"),
            101,
        )
        .expect("record failure");
    assert_eq!(
        store
            .scheduling_projection("provider", "key", "model", 1, 1, 101)
            .expect("post-failure projection")
            .score_milli,
        145
    );
}

#[test]
fn probe_health_does_not_change_scheduling_weight() {
    let store = V3ProviderKeyHealthStore::default();
    let baseline = store
        .scheduling_projection("provider", "key", "model", 3, 7, 1_000)
        .expect("baseline projection");
    for now_ms in 1_001..1_051 {
        store
            .record_provider_key_success("provider", "key", "model", now_ms)
            .expect("record score-changing health success");
    }
    let changed = store
        .scheduling_projection("provider", "key", "model", 3, 7, 1_051)
        .expect("changed health projection");
    assert_ne!(baseline.score_milli, changed.score_milli);
    assert_eq!(baseline.effective_priority, changed.effective_priority);
    assert_eq!(
        baseline.effective_weight_milli, changed.effective_weight_milli,
        "health and probe state must not rewrite configured scheduling weight"
    );
}

#[test]
fn health_neutral_action_changes_neither_score_nor_cooldown() {
    let store = V3ProviderKeyHealthStore::default();
    let action = V3ProviderFailureAction {
        recovery: V3ProviderRecoveryKind::HealthNeutralTransient,
        ..V3ProviderFailureAction::recoverable("controlled")
    };
    let projection = store
        .record_provider_failure_action("provider", "key", "model", &action, 1_000)
        .expect("record neutral action");
    assert_eq!(projection.score_milli, 100);
    assert_eq!(projection.score_generation, 0);
    assert!(projection.available);
    assert!(!projection.cooldown);
}

#[test]
fn global_429_boundary_is_strict_two_minutes_and_time_alone_does_not_cool() {
    let first_at_ms = 1_000;
    for elapsed_ms in [119_999, 120_000] {
        let last_at_ms = first_at_ms + elapsed_ms;
        let store = V3ProviderHealthStore::default();
        for now_ms in [
            1_000, 2_000, 3_000, 4_000, 5_000, 6_000, 7_000, 8_000, 9_000,
        ] {
            store
                .record_real_provider_failure_for_interface(
                    "provider",
                    "responses",
                    "key",
                    "model",
                    Some(429),
                    now_ms,
                )
                .expect("record early real 429");
        }
        store
            .record_real_provider_failure_for_interface(
                "provider",
                "responses",
                "key",
                "model",
                Some(429),
                last_at_ms,
            )
            .expect("record tenth real 429");
        assert!(
            store
                .availability_for_interface(
                    "provider",
                    "responses",
                    Some("key"),
                    Some("model"),
                    last_at_ms,
                )
                .unwrap()
                .available,
            "first-to-last {elapsed_ms}ms must not satisfy the strict >120000ms condition"
        );
        assert!(
            store
                .availability_for_interface(
                    "provider",
                    "responses",
                    Some("key"),
                    Some("model"),
                    last_at_ms + 1_000,
                )
                .unwrap()
                .available,
            "passing time without a new real 429 must not create a global cooldown"
        );
    }

    let store = V3ProviderHealthStore::default();
    for now_ms in [
        1_000, 2_000, 3_000, 4_000, 5_000, 6_000, 7_000, 8_000, 9_000,
    ] {
        store
            .record_real_provider_failure_for_interface(
                "provider",
                "responses",
                "key",
                "model",
                Some(429),
                now_ms,
            )
            .expect("record early real 429");
    }
    store
        .record_real_provider_failure_for_interface(
            "provider",
            "responses",
            "key",
            "model",
            Some(429),
            first_at_ms + 120_001,
        )
        .expect("record tenth real 429");
    assert!(
        !store
            .availability_for_interface(
                "provider",
                "responses",
                Some("key"),
                Some("model"),
                first_at_ms + 120_001,
            )
            .unwrap()
            .available,
        "a first-to-last difference of 120001ms must commit the global 429 cooldown"
    );
}
