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

fn fail_n(
    store: &V3ProviderHealthStore,
    session_id: &str,
    model_id: &str,
    start_ms: u64,
    count: usize,
) {
    for offset in 0..count {
        fail(store, session_id, model_id, start_ms + offset as u64);
    }
}

#[test]
fn default_failure_blocks_exact_key_model_across_sessions() {
    let store = V3ProviderHealthStore::default();
    fail_n(&store, "session-a", "model-a", 10, 10);
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
    fail_n(&store, "session-b", "model-a", 30, 10);
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
    fail_n(&store, "session-a", "model-a", 1, 10);
    let first_due = 5_010;
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
    let permit = store
        .acquire_provider_cooldown_probe("provider-a", Some("key-a"), Some("model-a"))
        .unwrap()
        .unwrap();
    store
        .complete_provider_cooldown_probe_success_with_permit(&permit, 3_600_010)
        .unwrap();
    assert!(
        store
            .availability_for_session(
                &scope("session-a"),
                "provider-a",
                Some("key-a"),
                Some("model-a"),
                3_600_010,
            )
            .available
    );
}

#[test]
fn due_and_inflight_probes_stay_in_pool_until_exact_success() {
    let store = V3ProviderHealthStore::default();
    fail_n(&store, "session-a", "model-a", 1, 10);
    let due = store
        .cooldown_entries(2)
        .into_iter()
        .find(|entry| entry.kind == "probe")
        .unwrap()
        .until_ms
        .unwrap();
    let mut permit = None;
    for in_flight in [false, true] {
        if in_flight {
            permit = Some(
                store
                    .acquire_provider_cooldown_probe("provider-a", Some("key-a"), Some("model-a"))
                    .unwrap()
                    .unwrap(),
            );
        }
        for now in [due, due + 60_000] {
            let entries = store.cooldown_entries(now);
            let entry = entries
                .iter()
                .find(|entry| entry.kind == "probe")
                .expect("unrecovered identity must remain in the cooldown pool after deadlines");
            assert_eq!(entry.provider_id, "provider-a");
            assert_eq!(entry.auth_alias.as_deref(), Some("key-a"));
            assert_eq!(entry.model_id.as_deref(), Some("model-a"));
            assert_eq!(entry.state, if in_flight { "probing" } else { "waiting" });
            assert!(
                !store
                    .scheduling_projection_for_key("provider-a", "key-a", "model-a", 1, 1, now)
                    .unwrap()
                    .available
            );
            for (provider, key, model) in [
                ("provider-a", "key-b", "model-a"),
                ("provider-a", "key-a", "model-b"),
                ("provider-b", "key-a", "model-a"),
            ] {
                assert!(
                    store
                        .scheduling_projection_for_key(provider, key, model, 1, 1, now)
                        .unwrap()
                        .available
                );
            }
        }
    }
    store
        .complete_provider_cooldown_probe_success_with_permit(&permit.unwrap(), 3_600_010)
        .unwrap();
    assert!(store
        .cooldown_entries(3_600_011)
        .iter()
        .all(|entry| entry.kind != "probe"));
    assert!(
        store
            .scheduling_projection_for_key("provider-a", "key-a", "model-a", 1, 1, 3_600_011)
            .unwrap()
            .available
    );
}

#[test]
fn failed_probe_keeps_blocked_and_stretches_next_deadline() {
    let store = V3ProviderHealthStore::default();
    fail_n(&store, "session-a", "model-a", 1, 10);
    let first_due = 5_010;
    let permit = store
        .acquire_provider_cooldown_probe("provider-a", Some("key-a"), Some("model-a"))
        .unwrap()
        .unwrap();
    store
        .complete_provider_cooldown_probe_failure_with_permit(&permit, first_due)
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
        .cooldown_entries(3_600_009)
        .into_iter()
        .find(|entry| entry.provider_id == "provider-a")
        .expect("provider-a cooldown entry");
    assert_eq!(blocked.until_ms, Some(3_600_010));
    let waiting = store
        .cooldown_entries(3_600_020)
        .into_iter()
        .find(|entry| entry.provider_id == "provider-a")
        .expect("provider-a cooldown entry");
    assert_eq!(waiting.until_ms, None);
}

#[test]
fn probe_acquisition_is_single_flight() {
    let store = V3ProviderHealthStore::default();
    fail_n(&store, "session-a", "model-a", 1, 10);
    assert!(store
        .acquire_provider_cooldown_probe("provider-a", Some("key-a"), Some("model-a"))
        .unwrap()
        .is_some());
    assert!(!store
        .acquire_provider_cooldown_probe("provider-a", Some("key-a"), Some("model-a"))
        .unwrap()
        .is_some());
}
