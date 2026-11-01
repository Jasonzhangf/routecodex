use routecodex_v3_error::V3ProviderFailureSessionScope;
use routecodex_v3_provider_responses::V3ProviderHealthStore;

fn scope(session_id: &str) -> V3ProviderFailureSessionScope {
    V3ProviderFailureSessionScope::new("server-a", "group-a", session_id).unwrap()
}

fn record_global_failures(
    store: &V3ProviderHealthStore,
    model_id: &str,
    status: u16,
    first_at_ms: u64,
    count: u64,
) {
    for offset in 0..count {
        store
            .record_real_provider_failure_for_interface(
                "provider-a",
                "default",
                "key-a",
                model_id,
                Some(status),
                first_at_ms + offset,
            )
            .unwrap();
    }
}

fn establish_global_cooldown(
    store: &V3ProviderHealthStore,
    model_id: &str,
    first_at_ms: u64,
) -> u64 {
    record_global_failures(store, model_id, 503, first_at_ms, 10);
    let cooled_at = first_at_ms + 9;
    assert!(
        !store
            .availability_for_session(
                &scope("session-a"),
                "provider-a",
                Some("key-a"),
                Some(model_id),
                cooled_at,
            )
            .unwrap()
            .available,
        "ten real errors must establish the global cooldown"
    );
    cooled_at
}

#[test]
fn default_failure_blocks_exact_key_model_across_sessions() {
    let store = V3ProviderHealthStore::default();
    record_global_failures(&store, "model-a", 401, 10, 9);
    assert!(
        store
            .availability_for_session(
                &scope("session-a"),
                "provider-a",
                Some("key-a"),
                Some("model-a"),
                18,
            )
            .unwrap()
            .available
    );
    assert!(
        store
            .availability_for_session(
                &scope("session-b"),
                "provider-a",
                Some("key-a"),
                Some("model-a"),
                18,
            )
            .unwrap()
            .available
    );

    record_global_failures(&store, "model-a", 401, 19, 1);
    for session_id in ["session-a", "session-b"] {
        assert!(
            !store
                .availability_for_session(
                    &scope(session_id),
                    "provider-a",
                    Some("key-a"),
                    Some("model-a"),
                    19,
                )
                .unwrap()
                .available,
            "the tenth real error must cool the matching identity across sessions"
        );
    }
}

#[test]
fn different_keys_and_models_do_not_combine() {
    let store = V3ProviderHealthStore::default();
    record_global_failures(&store, "model-a", 503, 10, 9);
    record_global_failures(&store, "model-b", 503, 10, 9);
    assert!(
        store
            .availability_for_session(
                &scope("session-a"),
                "provider-a",
                Some("key-a"),
                Some("model-a"),
                18,
            )
            .unwrap()
            .available,
        "nine errors on each model must not combine into a global cooldown"
    );
    assert!(
        store
            .availability_for_session(
                &scope("session-a"),
                "provider-a",
                Some("key-b"),
                Some("model-a"),
                18,
            )
            .unwrap()
            .available
    );
    assert!(
        store
            .availability_for_session(
                &scope("session-a"),
                "provider-a",
                Some("key-a"),
                Some("model-b"),
                18,
            )
            .unwrap()
            .available
    );
}

#[test]
fn cooldown_expiry_only_makes_probe_due_and_success_probe_restores() {
    let store = V3ProviderHealthStore::default();
    let cooled_at = establish_global_cooldown(&store, "model-a", 1);
    let first_due = cooled_at + 5_000;
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
            .unwrap()
            .available
    );
    let permit = store
        .acquire_provider_cooldown_probe("provider-a", Some("key-a"), Some("model-a"))
        .unwrap()
        .unwrap();
    store
        .complete_provider_cooldown_probe_success_with_permit(&permit, first_due + 1)
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
            .unwrap()
            .available
    );
}

#[test]
fn due_and_inflight_probes_stay_in_pool_until_exact_success() {
    let store = V3ProviderHealthStore::default();
    let cooled_at = establish_global_cooldown(&store, "model-a", 1);
    let due = store
        .cooldown_entries(cooled_at)
        .into_iter()
        .find(|entry| entry.kind == "probe")
        .unwrap()
        .until_ms
        .unwrap();
    assert_eq!(due, cooled_at + 5_000);
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
        .complete_provider_cooldown_probe_success_with_permit(&permit.unwrap(), due + 60_001)
        .unwrap();
    assert!(store
        .cooldown_entries(due + 60_002)
        .iter()
        .all(|entry| entry.kind != "probe"));
    assert!(
        store
            .scheduling_projection_for_key("provider-a", "key-a", "model-a", 1, 1, due + 60_002)
            .unwrap()
            .available
    );
}

#[test]
fn failed_probe_keeps_blocked_and_stretches_next_deadline() {
    let store = V3ProviderHealthStore::default();
    let cooled_at = establish_global_cooldown(&store, "model-a", 1);
    let first_due = cooled_at + 5_000;
    let permit = store
        .acquire_provider_cooldown_probe_if_due(
            "provider-a",
            Some("key-a"),
            Some("model-a"),
            first_due,
        )
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
            .unwrap()
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
    let cooled_at = establish_global_cooldown(&store, "model-a", 1);
    let due = cooled_at + 5_000;
    assert!(store
        .acquire_provider_cooldown_probe_if_due("provider-a", Some("key-a"), Some("model-a"), due,)
        .unwrap()
        .is_some());
    assert!(!store
        .acquire_provider_cooldown_probe_if_due("provider-a", Some("key-a"), Some("model-a"), due,)
        .unwrap()
        .is_some());
}
