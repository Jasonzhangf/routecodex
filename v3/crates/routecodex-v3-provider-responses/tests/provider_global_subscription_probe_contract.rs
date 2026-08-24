use routecodex_v3_error::V3ProviderFailureSessionScope;
use routecodex_v3_provider_responses::V3ProviderHealthStore;

fn scope(session_id: &str) -> V3ProviderFailureSessionScope {
    V3ProviderFailureSessionScope::new("server-a", "group-a", session_id).unwrap()
}

fn fail(store: &V3ProviderHealthStore, session_id: &str, model_id: &str, now_ms: u64) {
    store
        .record_provider_failure_in_session(
            &scope(session_id),
            "provider-a",
            Some("key-a"),
            Some(model_id),
            Some("subscription_invalid"),
            now_ms,
        )
        .unwrap();
}

#[test]
fn two_failures_stay_available_and_third_same_key_blocks_all_sessions() {
    let store = V3ProviderHealthStore::default();
    fail(&store, "session-a", "model-a", 10);
    fail(&store, "session-b", "model-a", 11);
    assert!(
        store
            .availability_for_session(
                &scope("session-a"),
                "provider-a",
                Some("key-a"),
                Some("model-a"),
                12,
            )
            .available
    );
    fail(&store, "session-a", "model-a", 12);
    assert!(
        !store
            .availability_for_session(
                &scope("session-b"),
                "provider-a",
                Some("key-a"),
                Some("model-a"),
                13,
            )
            .available
    );
}

#[test]
fn different_keys_and_models_do_not_combine() {
    let store = V3ProviderHealthStore::default();
    fail(&store, "session-a", "model-a", 10);
    fail(&store, "session-b", "model-b", 11);
    fail(&store, "session-a", "model-a", 12);
    assert!(
        store
            .availability_for_session(
                &scope("session-a"),
                "provider-a",
                Some("key-b"),
                Some("model-a"),
                13,
            )
            .available
    );
    assert!(
        store
            .availability_for_session(
                &scope("session-a"),
                "provider-a",
                Some("key-a"),
                Some("model-b"),
                13,
            )
            .available
    );
}

#[test]
fn cooldown_expiry_only_makes_probe_due_and_success_probe_restores() {
    let store = V3ProviderHealthStore::default();
    for now_ms in 1..=3 {
        fail(&store, "session-a", "model-a", now_ms);
    }
    assert!(
        store
            .provider_cooldown_probe_keys_due(60_004)
            .unwrap()
            .iter()
            .any(|(_, auth, model)| {
                auth.as_deref() == Some("key-a") && model.as_deref() == Some("model-a")
            })
    );
    assert!(
        !store
            .availability_for_session(
                &scope("session-a"),
                "provider-a",
                Some("key-a"),
                Some("model-a"),
                60_004,
            )
            .available
    );
    assert!(
        store
            .try_acquire_provider_cooldown_probe("provider-a", Some("key-a"), Some("model-a"))
            .unwrap()
    );
    store
        .complete_provider_cooldown_probe_success_at(
            "provider-a",
            Some("key-a"),
            Some("model-a"),
            60_005,
        )
        .unwrap();
    assert!(
        store
            .availability_for_session(
                &scope("session-a"),
                "provider-a",
                Some("key-a"),
                Some("model-a"),
                60_006,
            )
            .available
    );
}

#[test]
fn failed_probe_keeps_blocked_and_stretches_next_deadline() {
    let store = V3ProviderHealthStore::default();
    for now_ms in 1..=3 {
        fail(&store, "session-a", "model-a", now_ms);
    }
    let first_due = 60_004;
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
            first_due,
        )
        .unwrap();
    assert!(
        !store
            .availability_for_session(
                &scope("session-a"),
                "provider-a",
                Some("key-a"),
                Some("model-a"),
                first_due + 1,
            )
            .available
    );
    assert!(
        store
            .provider_cooldown_probe_keys_due(first_due + 60 * 60_000 - 1)
            .unwrap()
            .is_empty()
    );
}

#[test]
fn probe_acquisition_is_single_flight() {
    let store = V3ProviderHealthStore::default();
    for now_ms in 1..=3 {
        fail(&store, "session-a", "model-a", now_ms);
    }
    assert!(
        store
            .try_acquire_provider_cooldown_probe("provider-a", Some("key-a"), Some("model-a"))
            .unwrap()
    );
    assert!(
        !store
            .try_acquire_provider_cooldown_probe("provider-a", Some("key-a"), Some("model-a"))
            .unwrap()
    );
}
