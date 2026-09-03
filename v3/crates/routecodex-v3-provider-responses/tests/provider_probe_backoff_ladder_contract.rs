//! Spec contract: the provider cooldown probe cadence is the fixed,
//! observable ladder 30s / 1m / 3m / 15m / 1h / 3h, looping after the
//! 3h step. The first probe after a key enters cooldown is due 30s later.
//! Restart semantics (probe history reset) are owned by the persistence
//! module and start the same ladder from 30s.
use routecodex_v3_error::V3ProviderFailureSessionScope;
use routecodex_v3_provider_responses::V3ProviderHealthStore;

const LADDER_MS: [u64; 7] = [
    30_000, // first probe after block (probe failure count 0)
    60_000, // after probe failure 1
    180_000, // after probe failure 2
    900_000, // after probe failure 3
    3_600_000, // after probe failure 4
    10_800_000, // after probe failure 5
    30_000, // after probe failure 6: the ladder loops
];

fn scope() -> V3ProviderFailureSessionScope {
    V3ProviderFailureSessionScope::new("server-a", "group-a", "session-a").unwrap()
}

fn fail(store: &V3ProviderHealthStore, now_ms: u64) {
    store
        .record_provider_failure_in_session(
            &scope(),
            "provider-a",
            Some("key-a"),
            Some("model-a"),
            Some("provider_error"),
            now_ms,
        )
        .unwrap();
}

#[test]
fn first_probe_is_due_exactly_30s_after_block_and_only_probe_resurrects() {
    let store = V3ProviderHealthStore::default();
    for now_ms in 1..=3 {
        fail(&store, now_ms);
    }
    // Block was created at now_ms = 3; first probe due at 3 + 30_000.
    let first_due = 3 + 30_000;
    assert!(
        store
            .provider_cooldown_probe_keys_due(first_due - 1)
            .unwrap()
            .is_empty(),
        "first probe must not be due before 30s"
    );
    assert_eq!(
        store.provider_cooldown_probe_keys_due(first_due).unwrap().len(),
        1,
        "first probe must be due at 30s"
    );
    // While the probe entry exists the key stays unavailable for every
    // session; a business success alone must not resurrect it.
    assert!(
        !store
            .availability_for_session(
                &scope(),
                "provider-a",
                Some("key-a"),
                Some("model-a"),
                first_due,
            )
            .available
    );
    store
        .record_provider_success("provider-a", "key-a", "model-a", first_due)
        .unwrap();
    assert!(
        !store
            .availability_for_session(
                &scope(),
                "provider-a",
                Some("key-a"),
                Some("model-a"),
                first_due + 1,
            )
            .available,
        "business success must not resurrect a key that still owns a probe entry"
    );
    // The probe itself is the only in-code resurrection path.
    assert!(
        store
            .acquire_provider_cooldown_probe("provider-a", Some("key-a"), Some("model-a"))
            .unwrap()
            .is_some()
    );
    store
        .complete_provider_cooldown_probe_success(
            "provider-a",
            Some("key-a"),
            Some("model-a"),
        )
        .unwrap();
    assert!(
        store
            .availability_for_session(
                &scope(),
                "provider-a",
                Some("key-a"),
                Some("model-a"),
                first_due + 2,
            )
            .available,
        "successful probe must resurrect the key"
    );
}

#[test]
fn session_business_success_does_not_remove_pending_probe() {
    let store = V3ProviderHealthStore::default();
    let session = scope();
    for now_ms in 1..=3 {
        fail(&store, now_ms);
    }
    store
        .record_provider_success_in_session(
            &session,
            "provider-a",
            Some("key-a"),
            Some("model-a"),
            30_003,
        )
        .unwrap();
    assert!(
        !store
            .availability_for_session(
                &session,
                "provider-a",
                Some("key-a"),
                Some("model-a"),
                30_004,
            )
            .available,
        "business success must not remove a pending probe"
    );
}

#[test]
fn probe_failures_stretch_1m_3m_15m_1h_3h_then_loop_back_to_30s() {
    let store = V3ProviderHealthStore::default();
    for now_ms in 1..=3 {
        fail(&store, now_ms);
    }
    let mut now_ms = 3;
    for (index, delta) in LADDER_MS.iter().enumerate() {
        let due_at = now_ms + delta;
        assert!(
            store
                .provider_cooldown_probe_keys_due(due_at - 1)
                .unwrap()
                .is_empty(),
            "step {index} must not be due before {due_at} (delta {delta})"
        );
        assert_eq!(
            store
                .provider_cooldown_probe_keys_due(due_at)
                .unwrap()
                .len(),
            1,
            "step {index} must be due at {due_at} (delta {delta})"
        );
        now_ms = due_at;
        assert!(
            store
                .acquire_provider_cooldown_probe("provider-a", Some("key-a"), Some("model-a"))
                .unwrap()
                .is_some(),
            "probe permit missing at step {index}"
        );
        store
            .complete_provider_cooldown_probe_failure(
                "provider-a",
                Some("key-a"),
                Some("model-a"),
                now_ms,
            )
            .unwrap();
        assert!(
            !store
                .availability_for_session(
                    &scope(),
                    "provider-a",
                    Some("key-a"),
                    Some("model-a"),
                    now_ms + 1,
                )
                .available,
            "failed probe must keep the key blocked at step {index}"
        );
    }
}
