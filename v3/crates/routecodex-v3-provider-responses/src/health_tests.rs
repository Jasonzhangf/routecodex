use super::*;
use routecodex_v3_config::{compile_v3_config_05_manifest, parse_v3_config_02_authoring};

fn session(session_id: &str) -> V3ProviderFailureSessionScope {
    V3ProviderFailureSessionScope::new("server-a", "group-a", session_id).unwrap()
}

fn probe_stored_snapshot(
    store: &V3ProviderHealthStore,
    permit: &V3ProviderHealthProbePermit,
) -> (String, String) {
    let state = store.state.read().unwrap();
    let key = provider_cooldown_probe_key_for_interface(
        permit.provider_id(),
        permit.interface_id(),
        permit.auth_alias(),
        permit.model_id(),
    );
    let mut probe = state.provider_cooldown_probes[&key].clone();
    probe.active_probe = None;
    (
        format!("{probe:?}"),
        format!("{:?}", state.adaptive_history.get(&key)),
    )
}

fn finish_owned_probe(
    store: &V3ProviderHealthStore,
    permit: &V3ProviderHealthProbePermit,
    outcome: &str,
) {
    match outcome {
        "cancel" => store.cancel_provider_cooldown_probe(permit).unwrap(),
        "success" => store
            .complete_provider_cooldown_probe_success_with_permit(permit, 300)
            .unwrap(),
        "failure" => store
            .complete_provider_cooldown_probe_failure_with_permit(permit, 300)
            .unwrap(),
        _ => unreachable!(),
    }
}

#[test]
fn old_probe_outcomes_release_only_their_owner_and_preserve_stored_health() {
    for outcome in ["cancel", "success", "failure"] {
        let store = V3ProviderHealthStore::default();
        let mut action = V3ProviderFailureAction::recoverable("transport");
        action.failure_threshold = 1;
        store
            .record_provider_failure_action_for_interface("p", "alternate", "k", "m", &action, 100)
            .unwrap();
        let a = store
            .acquire_provider_cooldown_rescue_probe_for_interface(
                "p",
                "alternate",
                Some("k"),
                Some("m"),
            )
            .unwrap()
            .unwrap();
        let newer = store
            .record_provider_failure_action_for_interface("p", "alternate", "k", "m", &action, 200)
            .unwrap();
        assert!(newer.score_generation > a.expected_generation());
        assert!(store
            .acquire_provider_cooldown_probe_for_interface("p", "alternate", Some("k"), Some("m"))
            .unwrap()
            .is_none());
        let before = probe_stored_snapshot(&store, &a);
        finish_owned_probe(&store, &a, outcome);
        assert_eq!(
            before,
            probe_stored_snapshot(&store, &a),
            "{outcome} changed stored health/schedule"
        );
        let state = store.state.read().unwrap();
        let key = provider_cooldown_probe_key_for_interface("p", "alternate", Some("k"), Some("m"));
        let probe = &state.provider_cooldown_probes[&key];
        assert!(
            probe.active_probe.is_none(),
            "{outcome} left ownerless probing"
        );
        assert!(
            probe.rescue_probe_attempted,
            "cancellation must not rearm rescue"
        );
        let due = probe.next_probe_at_ms.unwrap();
        drop(state);
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
        assert_ne!(a.acquisition_id, b.acquisition_id);
        store.cancel_provider_cooldown_probe(&b).unwrap();
    }
}

#[test]
fn late_probe_outcomes_cannot_release_replacement_or_sibling_owners() {
    for outcome in ["cancel", "success", "failure"] {
        let store = V3ProviderHealthStore::default();
        let mut siblings = Vec::new();
        for (p, i, k, m) in [
            ("p", "alternate", "k", "m"),
            ("p", "default", "k", "m"),
            ("p", "alternate", "sibling", "m"),
            ("p", "alternate", "k", "sibling"),
            ("sibling", "alternate", "k", "m"),
        ] {
            store
                .add_cooldown_entry_for_interface(
                    V3ProviderInterfaceIdentity::new(p, i),
                    Some(k),
                    Some(m),
                    "probe",
                    60_000,
                    100,
                )
                .unwrap();
            siblings.push(
                store
                    .acquire_provider_cooldown_probe_for_interface(p, i, Some(k), Some(m))
                    .unwrap()
                    .unwrap(),
            );
        }
        let a = siblings.remove(0);
        store.cancel_provider_cooldown_probe(&a).unwrap();
        let b = store
            .acquire_provider_cooldown_probe_for_interface("p", "alternate", Some("k"), Some("m"))
            .unwrap()
            .unwrap();
        assert_eq!(a.expected_generation(), b.expected_generation());
        assert_ne!(a.acquisition_id, b.acquisition_id);
        siblings.push(b);
        let snapshots: Vec<_> = siblings
            .iter()
            .map(|p| probe_stored_snapshot(&store, p))
            .collect();
        finish_owned_probe(&store, &a, outcome);
        for (permit, snapshot) in siblings.iter().zip(snapshots) {
            assert_eq!(probe_stored_snapshot(&store, permit), snapshot);
            let state = store.state.read().unwrap();
            let key = provider_cooldown_probe_key_for_interface(
                permit.provider_id(),
                permit.interface_id(),
                permit.auth_alias(),
                permit.model_id(),
            );
            assert_eq!(
                state.provider_cooldown_probes[&key].active_probe,
                Some(permit.acquisition_id)
            );
            drop(state);
            store.cancel_provider_cooldown_probe(permit).unwrap();
        }
    }
}

#[test]
fn probe_acquisition_exhaustion_is_explicit_without_owning_or_reusing() {
    let store = V3ProviderHealthStore::default();
    store
        .add_cooldown_entry_for_interface(
            V3ProviderInterfaceIdentity::new("p", "default"),
            Some("k"),
            Some("m"),
            "probe",
            60_000,
            100,
        )
        .unwrap();
    store.state.write().unwrap().last_probe_acquisition_id = u64::MAX;
    assert!(matches!(
        store.acquire_provider_cooldown_probe("p", Some("k"), Some("m")),
        Err(V3ProviderHealthError::ProbeAcquisitionExhausted)
    ));
    assert_ne!(store.cooldown_entries(100)[0].state, "probing");
}

#[test]
fn probe_acquisition_is_not_reused_after_cooldown_removal() {
    let store = V3ProviderHealthStore::default();
    store
        .add_cooldown_entry_for_interface(
            V3ProviderInterfaceIdentity::new("p", "default"),
            Some("k"),
            Some("m"),
            "probe",
            60_000,
            100,
        )
        .unwrap();
    let a = store
        .acquire_provider_cooldown_probe("p", Some("k"), Some("m"))
        .unwrap()
        .unwrap();
    // Explicit administrative removal has its declared scope; it is not an
    // acquired-probe completion. Reinsert the same identity while A still exists.
    store
        .remove_cooldown_entry_for_interface("p", "default", Some("k"), Some("m"), "probe")
        .unwrap();
    store
        .add_cooldown_entry_for_interface(
            V3ProviderInterfaceIdentity::new("p", "default"),
            Some("k"),
            Some("m"),
            "probe",
            60_000,
            200,
        )
        .unwrap();
    let b = store
        .acquire_provider_cooldown_probe("p", Some("k"), Some("m"))
        .unwrap()
        .unwrap();
    assert_ne!(a.acquisition_id, b.acquisition_id);
    for outcome in ["cancel", "success", "failure"] {
        finish_owned_probe(&store, &a, outcome);
        assert!(store
            .acquire_provider_cooldown_probe("p", Some("k"), Some("m"))
            .unwrap()
            .is_none());
    }
    store.cancel_provider_cooldown_probe(&b).unwrap();
}

#[test]
fn manifest_disabled_provider_is_projected_as_unavailable_by_provider_owner() {
    let manifest = compile_v3_config_05_manifest(
        parse_v3_config_02_authoring(
            r#"
version = 3
[servers.s]
bind = "127.0.0.1"
port = 1
routing_group = "g"
[providers.disabled]
enabled = false
type = "responses"
base_url = "http://disabled.invalid/v1"
default_model = "m"
auth = { type = "api_key", entries = [{ alias = "k", env = "KEY" }] }
[providers.disabled.models.m]
[providers.enabled]
type = "responses"
base_url = "http://enabled.invalid/v1"
default_model = "m"
auth = { type = "api_key", entries = [{ alias = "k", env = "KEY" }] }
[providers.enabled.models.m]
[route_groups.g.pools.default]
targets = [{ kind = "provider_model", provider = "enabled", model = "m", key = "k", priority = 1 }]
"#,
        )
        .unwrap(),
    )
    .unwrap();
    let availability = V3ProviderAvailabilityRegistry::from_manifest(&manifest);
    assert!(
        !availability
            .availability("disabled", Some("k"), Some("m"), 0)
            .available
    );
    assert!(
        availability
            .availability("enabled", Some("k"), Some("m"), 0)
            .available
    );
}

#[test]
fn three_failures_cool_the_same_provider_key_across_sessions() {
    let store = V3ProviderHealthStore::default();
    store
        .record_provider_failure_in_session(
            &session("session-a"),
            "provider-a",
            Some("key-a"),
            Some("gpt-5.5"),
            Some("controlled failure"),
            100,
        )
        .unwrap();
    for now_ms in 101..103 {
        store
            .record_provider_failure_in_session(
                &session("session-b"),
                "provider-a",
                Some("key-a"),
                Some("gpt-5.5"),
                Some("controlled failure"),
                now_ms,
            )
            .unwrap();
    }
    assert!(
        !store
            .availability_for_session(
                &session("session-a"),
                "provider-a",
                Some("key-a"),
                Some("gpt-5.5"),
                103,
            )
            .available
    );
    assert!(
        !store
            .availability_for_session(
                &session("session-b"),
                "provider-a",
                Some("key-a"),
                Some("gpt-5.5"),
                103,
            )
            .available
    );
}

#[test]
fn operator_can_remove_exact_identity_cooldown_and_probe_state() {
    let store = V3ProviderHealthStore::default();
    store
        .record_provider_failure_in_session(
            &session("session-a"),
            "provider-a",
            Some("key-a"),
            Some("gpt-5.5"),
            Some("controlled failure"),
            100,
        )
        .unwrap();
    for now_ms in 101..103 {
        store
            .record_provider_failure_in_session(
                &session("session-b"),
                "provider-a",
                Some("key-a"),
                Some("gpt-5.5"),
                Some("controlled failure"),
                now_ms,
            )
            .unwrap();
    }
    assert!(store
        .cooldown_entries(103)
        .iter()
        .any(|entry| entry.kind == "probe" && entry.model_id.as_deref() == Some("gpt-5.5")));
    assert!(store
        .remove_cooldown_entry("provider-a", Some("key-a"), Some("gpt-5.5"), "probe")
        .unwrap());
    assert!(!store
        .cooldown_entries(103)
        .iter()
        .any(|entry| entry.kind == "probe" && entry.model_id.as_deref() == Some("gpt-5.5")));
    assert!(
        store
            .availability("provider-a", Some("key-a"), Some("gpt-5.5"), 103)
            .available
    );
}

#[test]
fn session_cooldown_projection_preserves_interface_identity() {
    let store = V3ProviderHealthStore::default();
    let policy = V3ProviderFailurePolicy {
        failure_threshold: 1,
        cooldown_ms: 60_000,
        probe_interval_ms: 5_000,
        max_probe_interval_ms: None,
        long_probe_backoff: false,
        until_restart: false,
        cooldown_scope: V3ProviderFailureCooldownScope::Session,
    };
    store
        .record_provider_failure_in_session_with_policy_for_interface(
            &session("session-a"),
            "provider-a",
            "chat",
            Some("key-a"),
            Some("gpt-5.5"),
            Some("controlled failure"),
            None,
            100,
            Some(policy),
        )
        .unwrap();

    let entry = store
        .cooldown_entries(100)
        .into_iter()
        .find(|entry| entry.kind == "session")
        .expect("session cooldown must be projected");
    assert_eq!(entry.provider_id, "provider-a");
    assert_eq!(entry.interface_id, "chat");
    assert_eq!(entry.auth_alias.as_deref(), Some("key-a"));
    assert_eq!(entry.model_id.as_deref(), Some("gpt-5.5"));
}

#[test]
fn failures_in_other_session_share_provider_key_cooldown() {
    let store = V3ProviderHealthStore::default();
    let first = store
        .record_provider_failure_in_session(
            &session("session-a"),
            "provider-a",
            Some("key-a"),
            Some("gpt-5.5"),
            Some("controlled failure"),
            100,
        )
        .unwrap();
    assert_eq!(first.state, "cooldown");
    assert_eq!(first.failure_count, 1);
    let repeated = store
        .record_provider_failure_in_session(
            &session("session-b"),
            "provider-a",
            Some("key-a"),
            Some("gpt-5.5"),
            Some("controlled failure"),
            101,
        )
        .unwrap();
    assert_eq!(repeated.state, "cooldown");
    assert_eq!(repeated.failure_count, 2);
    for (key, available) in [("key-a", false), ("key-b", true)] {
        assert_eq!(
            store
                .availability_for_session(
                    &session("session-b"),
                    "provider-a",
                    Some(key),
                    Some("gpt-5.5"),
                    105,
                )
                .available,
            available
        );
    }
}

#[test]
fn provider_key_model_policy_isolates_models_across_sessions() {
    let store = V3ProviderHealthStore::default();
    let policy = V3ProviderFailurePolicy {
        failure_threshold: 2,
        cooldown_ms: 3_600_000,
        probe_interval_ms: 5_000,
        max_probe_interval_ms: None,
        long_probe_backoff: false,
        until_restart: false,
        cooldown_scope: V3ProviderFailureCooldownScope::ProviderKeyModel,
    };
    let first = store
        .record_provider_failure_in_session_with_policy(
            &session("session-a"),
            "provider-a",
            Some("key-a"),
            Some("gpt-5.5"),
            Some("HTTP_401"),
            None,
            100,
            Some(policy),
        )
        .unwrap();
    assert_eq!(first.failure_count, 1);
    let second = store
        .record_provider_failure_in_session_with_policy(
            &session("session-b"),
            "provider-a",
            Some("key-a"),
            Some("gpt-5.5"),
            Some("HTTP_401"),
            None,
            101,
            Some(policy),
        )
        .unwrap();
    assert_eq!(second.state, "cooldown");
    assert_eq!(second.cooldown_until_ms, Some(5_101));
    assert_eq!(
        store.provider_cooldown_probe_keys_due(5_101).unwrap(),
        vec![(
            "provider-a".to_string(),
            Some("key-a".to_string()),
            Some("gpt-5.5".to_string()),
        )]
    );
    assert_eq!(
        store
            .provider_cooldown_probe_next_deadline_ms("provider-a", Some("key-a"), Some("gpt-5.5"),)
            .unwrap(),
        Some(5_101),
        "a model candidate must resolve the auth-key probe deadline"
    );
    let permit = store
        .acquire_provider_cooldown_probe_if_due("provider-a", Some("key-a"), Some("gpt-5.5"), 5_101)
        .unwrap()
        .expect("a model candidate must acquire the due exact identity probe");
    assert_eq!(permit.auth_alias(), Some("key-a"));
    assert_eq!(
        permit.model_id(),
        Some("gpt-5.5"),
        "the exact identity probe permit must retain the model dimension"
    );
    assert_eq!(
        store
            .provider_cooldown_probe_next_deadline_ms("provider-a", Some("key-a"), Some("gpt-5.5"),)
            .unwrap(),
        None,
        "an in-flight probe must not expose its expired due time as a retry deadline"
    );
    store
        .complete_provider_cooldown_probe_failure_with_permit(&permit, 5_101)
        .unwrap();
    assert!(
        !store
            .availability_for_session(
                &session("session-a"),
                "provider-a",
                Some("key-a"),
                Some("gpt-5.5"),
                102,
            )
            .available
    );
    assert!(
        store
            .availability_for_session(
                &session("session-c"),
                "provider-a",
                Some("key-a"),
                Some("other-model"),
                102,
            )
            .available,
        "provider+key+model identity must not block another model"
    );
    assert!(
        store
            .availability_for_session(
                &session("session-c"),
                "provider-a",
                Some("key-b"),
                Some("gpt-5.5"),
                102,
            )
            .available
    );
    store
        .record_provider_key_success("provider-a", "key-a", "gpt-5.5", 103)
        .unwrap();
    assert!(
        !store
            .availability_for_session(
                &session("session-a"),
                "provider-a",
                Some("key-a"),
                Some("gpt-5.5"),
                104,
            )
            .available,
        "a sibling success must not reset the exact identity cooldown"
    );
    store
        .complete_provider_cooldown_probe_success("provider-a", Some("key-a"), Some("gpt-5.5"))
        .unwrap();
    assert!(
        store
            .availability_for_session(
                &session("session-a"),
                "provider-a",
                Some("key-a"),
                Some("gpt-5.5"),
                180_102,
            )
            .available
    );
}

#[test]
fn success_in_one_session_clears_sibling_session_cooldown_for_exact_key_model() {
    let store = V3ProviderHealthStore::default();
    store
        .record_provider_transient_bypass_in_session(
            &session("session-a"),
            "provider-a",
            Some("key-a"),
            Some("gpt-5.5"),
            Some("controlled transient failure"),
            100,
        )
        .unwrap();
    assert!(
        !store
            .availability_for_session(
                &session("session-a"),
                "provider-a",
                Some("key-a"),
                Some("gpt-5.5"),
                103,
            )
            .available
    );
    // session-b 的真实成功恢复同一 provider:key:model 的 session 冷却。
    store
        .record_provider_success_in_session(
            &session("session-b"),
            "provider-a",
            Some("key-a"),
            Some("gpt-5.5"),
            104,
        )
        .unwrap();
    assert!(
        store
            .availability_for_session(
                &session("session-a"),
                "provider-a",
                Some("key-a"),
                Some("gpt-5.5"),
                105,
            )
            .available,
        "sibling session success must recover the exact provider key/model"
    );
    assert!(
        store
            .availability_for_session(
                &session("session-b"),
                "provider-a",
                Some("key-a"),
                Some("gpt-5.5"),
                105,
            )
            .available,
        "the successful session must remain available"
    );
    assert!(
        store
            .availability_for_session(
                &session("session-a"),
                "provider-a",
                Some("key-a"),
                Some("gpt-5.5"),
                106,
            )
            .available,
        "a different model must not be changed by this recovery"
    );
}

#[tokio::test]
async fn success_in_any_session_publishes_availability_change_for_waiters() {
    let store = V3ProviderHealthStore::default();
    store
        .record_provider_failure_in_session(
            &session("session-a"),
            "provider-a",
            Some("key-a"),
            Some("gpt-5.5"),
            Some("controlled failure"),
            100,
        )
        .unwrap();
    let observed_generation = store.availability_generation();
    store
        .record_provider_success_in_session(
            &session("session-b"),
            "provider-a",
            Some("key-a"),
            Some("gpt-5.5"),
            101,
        )
        .unwrap();
    let changed = tokio::time::timeout(
        std::time::Duration::from_secs(1),
        store.wait_for_availability_change(observed_generation),
    )
    .await
    .expect("session success must wake anyone waiting for availability change")
    .expect("availability watch must remain live");
    assert_ne!(
        changed, observed_generation,
        "success in any session must publish a new availability generation"
    );
}

#[test]
fn success_in_any_session_does_not_recover_provider_cooldown_without_probe() {
    let store = V3ProviderHealthStore::default();
    store
        .record_provider_cooldown_failure(
            "provider-a",
            Some("key-a"),
            Some("gpt-5.5"),
            "post-commit stream failure",
            100,
            10,
        )
        .unwrap();
    // 未到期的 provider cooldown 不得由业务成功清除。
    store
        .record_provider_success_in_session(
            &session("session-a"),
            "provider-a",
            Some("key-a"),
            Some("gpt-5.5"),
            105,
        )
        .unwrap();
    assert!(
        !store
            .availability_for_session(
                &session("session-a"),
                "provider-a",
                Some("key-a"),
                Some("gpt-5.5"),
                105,
            )
            .available,
        "a real success must not recover provider cooldown without probe success"
    );

    let permit = store
        .acquire_provider_cooldown_probe("provider-a", Some("key-a"), Some("gpt-5.5"))
        .unwrap()
        .expect("pending provider cooldown must acquire a probe");
    store
        .complete_provider_cooldown_probe_success_with_permit(&permit, 106)
        .unwrap();
    assert!(
        store
            .availability_for_session(
                &session("session-a"),
                "provider-a",
                Some("key-a"),
                Some("gpt-5.5"),
                107,
            )
            .available,
        "successful probe must recover the exact provider key/model"
    );
}

#[test]
fn cooldown_probe_pending_scope_is_projected_once_for_exact_and_auth_key_probes() {
    let store = V3ProviderHealthStore::default();
    store
        .record_provider_cooldown_failure(
            "provider-a",
            Some("key-a"),
            Some("gpt-5.5"),
            "exact model probe",
            100,
            900_000,
        )
        .unwrap();
    store
        .record_provider_cooldown_failure(
            "provider-a",
            Some("key-a"),
            None,
            "auth-key probe",
            100,
            900_000,
        )
        .unwrap();

    let projection = store.availability_for_session(
        &session("session-a"),
        "provider-a",
        Some("key-a"),
        Some("gpt-5.5"),
        101,
    );
    assert_eq!(
        projection
            .blocked_scopes
            .iter()
            .filter(|scope| scope.as_str() == "provider_cooldown_probe_pending")
            .count(),
        1
    );
}

#[test]
fn cancelled_probe_releases_single_flight_for_the_same_generation() {
    let store = V3ProviderHealthStore::default();
    store
        .record_provider_cooldown_failure(
            "provider-a",
            Some("key-a"),
            Some("gpt-5.5"),
            "post-commit stream failure",
            100,
            900_000,
        )
        .unwrap();
    let permit = store
        .acquire_provider_cooldown_probe("provider-a", Some("key-a"), Some("gpt-5.5"))
        .unwrap()
        .expect("blocked provider must acquire one probe");
    store.cancel_provider_cooldown_probe(&permit).unwrap();
    assert!(
        store
            .acquire_provider_cooldown_probe("provider-a", Some("key-a"), Some("gpt-5.5"))
            .unwrap()
            .is_some(),
        "cancellation must release the single-flight permit"
    );
}

#[tokio::test]
async fn cancelled_probe_wakes_cooldown_exhaustion_waiter() {
    let store = V3ProviderHealthStore::default();
    store
        .record_provider_cooldown_failure(
            "provider-a",
            Some("key-a"),
            Some("gpt-5.5"),
            "post-commit stream failure",
            100,
            900_000,
        )
        .unwrap();
    let permit = store
        .acquire_provider_cooldown_probe("provider-a", Some("key-a"), Some("gpt-5.5"))
        .unwrap()
        .expect("blocked provider must acquire one probe");

    let observed_generation = store.availability_generation();
    let wait = store.wait_for_availability_change(observed_generation);
    tokio::pin!(wait);
    assert!(
        tokio::time::timeout(std::time::Duration::from_millis(5), &mut wait)
            .await
            .is_err()
    );

    store.cancel_provider_cooldown_probe(&permit).unwrap();

    let next_generation = tokio::time::timeout(std::time::Duration::from_millis(100), &mut wait)
        .await
        .expect("probe cancellation must wake exhaustion rescue so it can reselect")
        .expect("availability-change notification must remain readable");
    assert_ne!(next_generation, observed_generation);
}

#[test]
fn stale_probe_cancellation_cannot_release_a_replacement_owner() {
    let store = V3ProviderHealthStore::default();
    store
        .record_provider_cooldown_failure(
            "provider-a",
            Some("key-a"),
            Some("gpt-5.5"),
            "post-commit stream failure",
            100,
            900_000,
        )
        .unwrap();
    let permit = store
        .acquire_provider_cooldown_probe("provider-a", Some("key-a"), Some("gpt-5.5"))
        .unwrap()
        .expect("blocked provider must acquire one probe");
    store.cancel_provider_cooldown_probe(&permit).unwrap();
    let replacement = store
        .acquire_provider_cooldown_probe("provider-a", Some("key-a"), Some("gpt-5.5"))
        .unwrap()
        .unwrap();
    assert_eq!(
        permit.expected_generation(),
        replacement.expected_generation()
    );
    store.cancel_provider_cooldown_probe(&permit).unwrap();
    assert!(
        store
            .acquire_provider_cooldown_probe("provider-a", Some("key-a"), Some("gpt-5.5"))
            .unwrap()
            .is_none(),
        "stale cancellation must not release a replacement probe at the same health generation"
    );
}

#[test]
fn cooldown_reupsert_preserves_in_flight_probe_single_flight() {
    let store = V3ProviderHealthStore::default();
    store
        .record_provider_cooldown_failure(
            "provider-a",
            Some("key-a"),
            Some("gpt-5.5"),
            "first failure",
            100,
            900_000,
        )
        .unwrap();
    assert!(store
        .provider_cooldown_probe_keys_due(100 + 900_000 + 1)
        .unwrap()
        .contains(&(
            "provider-a".to_string(),
            Some("key-a".to_string()),
            Some("gpt-5.5".to_string())
        )));
    assert!(
        store
            .acquire_provider_cooldown_probe("provider-a", Some("key-a"), Some("gpt-5.5"))
            .unwrap()
            .is_some(),
        "probe must be acquirable once"
    );
    // 探针在途时并发失败 re-upsert：不得清掉 in-flight 单飞锁。
    store
        .record_provider_cooldown_failure(
            "provider-a",
            Some("key-a"),
            Some("gpt-5.5"),
            "concurrent failure",
            200,
            900_000,
        )
        .unwrap();
    assert!(
        !store
            .provider_cooldown_probe_keys_due(200 + 900_000 + 1)
            .unwrap()
            .contains(&(
                "provider-a".to_string(),
                Some("key-a".to_string()),
                Some("gpt-5.5".to_string())
            )),
        "in-flight probe must not be re-enqueued by re-upsert"
    );
    assert!(
        store
            .acquire_provider_cooldown_probe("provider-a", Some("key-a"), Some("gpt-5.5"))
            .unwrap()
            .is_none(),
        "second concurrent probe acquisition must be denied"
    );
}

#[test]
fn failure_count_is_provider_key_scoped_for_default_policy() {
    let store = V3ProviderHealthStore::default();
    for (index, session_id) in ["session-a", "session-b", "session-b"]
        .into_iter()
        .enumerate()
    {
        let record = store
            .record_provider_failure_in_session(
                &session(session_id),
                "provider-a",
                Some("key-a"),
                Some("gpt-5.5"),
                None,
                100,
            )
            .unwrap();
        assert_eq!(record.state, "cooldown");
        assert_eq!(record.failure_count, index as u32 + 1);
    }
    for (key, available) in [("key-a", false), ("key-b", true)] {
        assert_eq!(
            store
                .availability_for_session(
                    &session("session-a"),
                    "provider-a",
                    Some(key),
                    Some("gpt-5.5"),
                    101,
                )
                .available,
            available
        );
    }
}

#[test]
fn session_transient_bypass_isolated_between_models_while_active() {
    let store = V3ProviderHealthStore::default();
    store
        .record_provider_transient_bypass_in_session(
            &session("session-a"),
            "provider-a",
            Some("key-a"),
            Some("model-a"),
            Some("transient exhaustion"),
            100,
        )
        .unwrap();
    assert!(
        !store
            .availability_for_session(
                &session("session-a"),
                "provider-a",
                Some("key-a"),
                Some("model-a"),
                100,
            )
            .available
    );
    assert!(
        store
            .availability_for_session(
                &session("session-a"),
                "provider-a",
                Some("key-a"),
                Some("model-b"),
                100,
            )
            .available
    );
}

#[test]
fn real_success_resets_pre_cooldown_failure_window_for_declared_policy() {
    for cooldown_scope in [
        V3ProviderFailureCooldownScope::Session,
        V3ProviderFailureCooldownScope::ProviderKeyModel,
    ] {
        let store = V3ProviderHealthStore::default();
        let scope = session("success-reset");
        let policy = V3ProviderFailurePolicy {
            failure_threshold: 3,
            cooldown_scope,
            ..Default::default()
        };
        let record = |now| {
            store
                .record_provider_failure_in_session_with_policy(
                    &scope,
                    "provider-a",
                    Some("key-a"),
                    Some("model-a"),
                    Some("real failure"),
                    None,
                    now,
                    Some(policy),
                )
                .unwrap()
        };
        assert_eq!(record(100).failure_count, 1);
        assert_eq!(record(101).failure_count, 2);
        store
            .record_provider_success_in_session(
                &scope,
                "provider-a",
                Some("key-a"),
                Some("model-a"),
                102,
            )
            .unwrap();
        let after_success = record(103);
        assert_eq!(
            after_success.failure_count, 1,
            "real success must break a consecutive failure window"
        );
        assert_eq!(after_success.state, "healthy");
        assert_eq!(record(104).state, "healthy");
        assert_eq!(
            record(105).state,
            "cooldown",
            "explicit threshold 3 must remain effective"
        );
    }
}

#[test]
fn neutral_failure_action_preserves_real_success_streak_and_score() {
    let store = V3ProviderHealthStore::default();
    let before = store
        .record_provider_key_success("p", "k", "m", 100)
        .unwrap();
    let mut action = V3ProviderFailureAction::recoverable("local_response_codec_failure");
    action.recovery = V3ProviderRecoveryKind::NotProviderHealth;
    action.scope = V3ProviderHealthScope::None;
    let after = store
        .record_provider_failure_action("p", "k", "m", &action, 101)
        .unwrap();
    assert_eq!(
        before, after,
        "a typed local failure must not mutate provider health"
    );
}

#[test]
fn quota_concurrency_and_diagnostics_are_provider_owned_inputs() {
    let store = V3ProviderHealthStore::default();
    store
        .update_quota_state(
            &V3ErrorActionScope::ProviderKeyModel {
                provider_id: "provider-a".to_string(),
                auth_alias: "key-a".to_string(),
                model_id: "gpt-5.5".to_string(),
            },
            0,
            Some(1_000),
        )
        .unwrap();
    assert!(
        !store
            .availability("provider-a", Some("key-a"), Some("gpt-5.5"), 101)
            .available
    );
    assert!(
        store
            .availability("provider-a", Some("key-a"), Some("other-model"), 101)
            .available
    );
    store.update_concurrency_state("provider-b", 2, 2).unwrap();
    assert!(
        !store
            .availability("provider-b", Some("key-a"), Some("gpt-5.5"), 101)
            .available
    );
    assert!(
        store
            .availability("third", Some("key-a"), Some("gpt-5.5"), 101)
            .available
    );
    assert_eq!(
        explain_provider_health_reasons(&store, "provider-a", Some("key-a"), Some("gpt-5.5"), 101,),
        vec!["quota:provider_key:provider-a:default:key-a:gpt-5.5:exhausted"]
    );
}

#[test]
fn legacy_quota_scope_migrates_to_default_interface_only() {
    let store = V3ProviderHealthStore::default();
    store
        .update_quota_state(
            &V3ErrorActionScope::ProviderKeyModel {
                provider_id: "provider-a".to_string(),
                auth_alias: "key-a".to_string(),
                model_id: "gpt-5.5".to_string(),
            },
            0,
            Some(1_000),
        )
        .unwrap();

    assert!(
        !store
            .availability_for_interface(
                "provider-a",
                "default",
                Some("key-a"),
                Some("gpt-5.5"),
                101,
            )
            .available
    );
    assert!(
        store
            .availability_for_interface("provider-a", "chat", Some("key-a"), Some("gpt-5.5"), 101,)
            .available
    );
}

#[test]
fn concurrency_budget_is_shared_across_interfaces() {
    let store = V3ProviderHealthStore::default();
    store.update_concurrency_state("provider-a", 2, 2).unwrap();

    assert!(
        !store
            .availability_for_interface(
                "provider-a",
                "default",
                Some("key-a"),
                Some("gpt-5.5"),
                101,
            )
            .available
    );
    assert!(
        !store
            .availability_for_interface("provider-a", "chat", Some("key-a"), Some("gpt-5.5"), 101,)
            .available
    );
}
