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
fn default_failure_blocks_exact_key_model_across_sessions() {
    let store = V3ProviderHealthStore::default();
    fail(&store, "session-a", "model-a", 10);
    assert!(
        !store
            .availability_for_session(
                &scope("session-a"),
                "provider-a",
                Some("key-a"),
                Some("model-a"),
                10,
            )
            .available
    );
    fail(&store, "session-b", "model-a", 11);
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
    fail(&store, "session-a", "model-a", 1);
    fail(&store, "session-a", "model-a", 2);
    let first_due = 5_002;
    assert!(store
        .provider_cooldown_probe_keys_due(first_due - 1)
        .unwrap()
        .is_empty());
    assert!(store
        .provider_cooldown_probe_keys_due(first_due)
        .unwrap()
        .iter()
        .any(|(_, auth, model)| {
            auth.as_deref() == Some("key-a") && model.as_deref() == Some("model-a")
        }));
    assert!(
        !store
            .availability_for_session(
                &scope("session-a"),
                "provider-a",
                Some("key-a"),
                Some("model-a"),
                first_due,
            )
            .available
    );
    assert!(store
        .acquire_provider_cooldown_probe("provider-a", Some("key-a"), Some("model-a"))
        .unwrap()
        .is_some());
    store
        .complete_provider_cooldown_probe_success_at(
            "provider-a",
            Some("key-a"),
            Some("model-a"),
            first_due + 1,
        )
        .unwrap();
    assert!(
        store
            .availability_for_session(
                &scope("session-a"),
                "provider-a",
                Some("key-a"),
                Some("model-a"),
                first_due + 2,
            )
            .available
    );
}

#[test]
fn failed_probe_keeps_blocked_and_stretches_next_deadline() {
    let store = V3ProviderHealthStore::default();
    fail(&store, "session-a", "model-a", 1);
    fail(&store, "session-a", "model-a", 2);
    let first_due = 5_002;
    assert!(store
        .acquire_provider_cooldown_probe("provider-a", Some("key-a"), Some("model-a"))
        .unwrap()
        .is_some());
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
    assert!(store
        .provider_cooldown_probe_keys_due(first_due + 10_000 - 1)
        .unwrap()
        .is_empty());
    assert_eq!(
        store
            .provider_cooldown_probe_keys_due(first_due + 10_000)
            .unwrap()
            .len(),
        1
    );
    let blocked = store
        .cooldown_entries(first_due + 10_000 - 1)
        .into_iter()
        .find(|entry| entry.provider_id == "provider-a")
        .expect("provider-a cooldown entry");
    assert_eq!(blocked.until_ms, None);
}

#[test]
fn probe_acquisition_is_single_flight() {
    let store = V3ProviderHealthStore::default();
    fail(&store, "session-a", "model-a", 1);
    fail(&store, "session-a", "model-a", 2);
    assert!(store
        .acquire_provider_cooldown_probe("provider-a", Some("key-a"), Some("model-a"))
        .unwrap()
        .is_some());
    assert!(!store
        .acquire_provider_cooldown_probe("provider-a", Some("key-a"), Some("model-a"))
        .unwrap()
        .is_some());
}
