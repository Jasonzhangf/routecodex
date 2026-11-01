//! Spec contract: provider cooldown and recovery probes use the same aggressive,
//! observable ladder capped at 30m. The first probe after a key enters cooldown
//! is due 5s later.
//! Restart semantics (probe history reset) are owned by the persistence
//! module and start the same ladder from 5s.
use routecodex_v3_error::{
    V3ProviderFailureAction, V3ProviderFailureSessionScope, V3ProviderHealthScope,
    V3ProviderRecoveryKind,
};
use routecodex_v3_provider_responses::{V3ProviderFailureCooldownScope, V3ProviderHealthStore};

const LADDER_MS: [u64; 7] = [
    5_000,     // first probe after block (probe failure count 0)
    10_000,    // after probe failure 1
    30_000,    // after probe failure 2
    60_000,    // after probe failure 3
    120_000,   // after probe failure 4
    900_000,   // after probe failure 5
    1_800_000, // after probe failure 6 (capped)
];

fn scope() -> V3ProviderFailureSessionScope {
    V3ProviderFailureSessionScope::new("server-a", "group-a", "session-a").unwrap()
}

fn record_global_failure(
    store: &V3ProviderHealthStore,
    provider_id: &str,
    auth_alias: &str,
    model_id: &str,
    now_ms: u64,
) {
    store
        .record_real_provider_failure_for_interface(
            provider_id,
            "default",
            auth_alias,
            model_id,
            Some(503),
            now_ms,
        )
        .unwrap();
}

fn establish_global_cooldown(
    store: &V3ProviderHealthStore,
    provider_id: &str,
    auth_alias: &str,
    model_id: &str,
    first_at_ms: u64,
) -> u64 {
    for offset in 0..10 {
        record_global_failure(
            store,
            provider_id,
            auth_alias,
            model_id,
            first_at_ms + offset,
        );
    }
    let cooled_at = first_at_ms + 9;
    assert!(
        !store
            .scheduling_projection(provider_id, auth_alias, model_id, 1, 1, cooled_at)
            .unwrap()
            .available,
        "ten real errors must establish the global cooldown"
    );
    cooled_at
}

#[test]
fn first_probe_is_due_exactly_5s_after_block_and_probe_success_resurrects() {
    let store = V3ProviderHealthStore::default();
    let cooled_at = establish_global_cooldown(&store, "provider-a", "key-a", "model-a", 1);
    let first_due = cooled_at + 5_000;
    assert!(
        store
            .provider_cooldown_probe_keys_due(first_due - 1)
            .unwrap()
            .is_empty(),
        "first probe must not be due before 5s"
    );
    assert_eq!(
        store
            .provider_cooldown_probe_keys_due(first_due)
            .unwrap()
            .len(),
        1,
        "first probe must be due at 5s"
    );
    // While the probe entry exists the key stays unavailable for every
    // session until the typed probe owner reports success.
    assert!(
        !store
            .availability_for_session(
                &scope(),
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
        .expect("due exact identity probe must be acquirable");
    store
        .complete_provider_cooldown_probe_success_with_permit(&permit, first_due)
        .unwrap();
    assert!(
        store
            .availability_for_session(
                &scope(),
                "provider-a",
                Some("key-a"),
                Some("model-a"),
                first_due + 1,
            )
            .unwrap()
            .available,
        "probe success must resurrect a globally cooled exact identity"
    );
}

#[test]
fn continuous_failure_ladder_is_isolated_per_provider_key() {
    let store = V3ProviderHealthStore::default();
    establish_global_cooldown(&store, "provider-fast", "key", "model", 100);
    establish_global_cooldown(&store, "provider-slow", "key", "model", 100);
    let entries = store.cooldown_entries(109);
    let fast_until = entries
        .iter()
        .find(|entry| entry.provider_id == "provider-fast")
        .and_then(|entry| entry.until_ms);
    let slow_until = entries
        .iter()
        .find(|entry| entry.provider_id == "provider-slow")
        .and_then(|entry| entry.until_ms);
    assert_eq!(fast_until, Some(5_109));
    assert_eq!(slow_until, Some(5_109));

    let fast_due = store
        .provider_cooldown_probe_next_deadline_ms("provider-fast", Some("key"), Some("model"))
        .unwrap()
        .unwrap();
    let permit = store
        .acquire_provider_cooldown_probe_if_due(
            "provider-fast",
            Some("key"),
            Some("model"),
            fast_due,
        )
        .unwrap()
        .expect("fast provider probe permit");
    store
        .complete_provider_cooldown_probe_failure_with_permit(&permit, fast_due)
        .unwrap();
    assert_eq!(
        store
            .provider_cooldown_probe_next_deadline_ms("provider-fast", Some("key"), Some("model"))
            .unwrap(),
        Some(15_109)
    );
    assert_eq!(
        store
            .provider_cooldown_probe_next_deadline_ms("provider-slow", Some("key"), Some("model"))
            .unwrap(),
        Some(5_109)
    );
}

#[test]
fn successful_recovery_restarts_repeat_admission_and_five_second_probe() {
    let store = V3ProviderHealthStore::default();
    let cooled_at = establish_global_cooldown(&store, "provider-a", "key", "model", 100);

    store
        .complete_probe_success("provider-a", "key", "model", cooled_at + 1)
        .expect("successful recovery");
    for offset in 0..9 {
        record_global_failure(&store, "provider-a", "key", "model", 111 + offset);
    }
    assert!(
        store
            .scheduling_projection("provider-a", "key", "model", 1, 1, 119)
            .unwrap()
            .available,
        "recovery must restart real-error accumulation below the threshold"
    );
    record_global_failure(&store, "provider-a", "key", "model", 120);
    assert!(
        !store
            .scheduling_projection("provider-a", "key", "model", 1, 1, 120)
            .unwrap()
            .available
    );
    assert_eq!(
        store
            .provider_cooldown_probe_next_deadline_ms("provider-a", Some("key"), Some("model"))
            .unwrap(),
        Some(5_120),
        "the recovered identity starts again with the five-second probe"
    );
}

#[test]
fn business_success_restores_exact_identity_and_old_probe_cannot_resurrect() {
    let store = V3ProviderHealthStore::default();
    let cooled_at = establish_global_cooldown(&store, "provider-a", "key-a", "model-a", 1);
    let due = cooled_at + 5_000;
    let permit = store
        .acquire_provider_cooldown_probe_if_due("provider-a", Some("key-a"), Some("model-a"), due)
        .unwrap()
        .expect("pending probe permit");
    store
        .record_provider_key_success("provider-a", "key-a", "model-a", due + 1)
        .unwrap();
    assert!(
        store
            .availability_for_session(
                &scope(),
                "provider-a",
                Some("key-a"),
                Some("model-a"),
                due + 1,
            )
            .unwrap()
            .available,
        "matching business success must restore the exact identity immediately"
    );
    store
        .complete_provider_cooldown_probe_failure_with_permit(&permit, due + 2)
        .unwrap();
    assert!(
        store
            .availability_for_session(
                &scope(),
                "provider-a",
                Some("key-a"),
                Some("model-a"),
                due + 3,
            )
            .unwrap()
            .available,
        "a late probe failure must not resurrect a superseded cooldown"
    );
}

#[test]
fn model_success_recovers_exact_model_without_clearing_sibling_probe() {
    let store = V3ProviderHealthStore::default();
    establish_global_cooldown(&store, "provider-a", "key-a", "model-a", 1);
    establish_global_cooldown(&store, "provider-a", "key-a", "model-c", 1);
    store
        .record_provider_key_success("provider-a", "key-a", "model-a", 30_003)
        .expect("model success");
    assert!(
        store
            .availability_for_session(
                &scope(),
                "provider-a",
                Some("key-a"),
                Some("model-b"),
                30_004,
            )
            .unwrap()
            .available,
        "a failed model cannot block a sibling model"
    );
    assert_eq!(
        store.provider_cooldown_probe_keys_due(15_010).unwrap(),
        vec![(
            "provider-a".into(),
            Some("key-a".into()),
            Some("model-c".into())
        )],
        "matching business success clears only model-a, not the sibling probe"
    );
    assert!(
        store
            .scheduling_projection("provider-a", "key-a", "model-a", 1, 1, 30004)
            .unwrap()
            .available
    );
}

#[test]
fn model_success_resets_exact_identity_consecutive_failures() {
    let store = V3ProviderHealthStore::default();
    let policy = routecodex_v3_provider_responses::V3ProviderFailurePolicy {
        failure_threshold: 3,
        cooldown_ms: 900_000,
        probe_interval_ms: 5_000,
        max_probe_interval_ms: None,
        long_probe_backoff: false,
        until_restart: false,
        advisory_probe: false,
        cooldown_scope: V3ProviderFailureCooldownScope::ProviderKeyModel,
    };
    for now_ms in [1, 2] {
        store
            .record_provider_failure_in_session_with_policy(
                &scope(),
                "provider-a",
                Some("key-a"),
                Some("model-a"),
                Some("provider_error"),
                None,
                now_ms,
                Some(policy),
            )
            .unwrap();
    }
    store
        .record_provider_key_success("provider-a", "key-a", "model-a", 3)
        .expect("model success");
    store
        .record_provider_failure_in_session_with_policy(
            &scope(),
            "provider-a",
            Some("key-a"),
            Some("model-a"),
            Some("provider_error"),
            None,
            4,
            Some(policy),
        )
        .unwrap();
    assert!(
        store
            .availability_for_session(&scope(), "provider-a", Some("key-a"), Some("model-a"), 5,)
            .unwrap()
            .available,
        "a success between failures must reset the exact identity failure streak"
    );
}

#[test]
fn probe_failures_cap_all_provider_errors_at_thirty_minutes() {
    let store = V3ProviderHealthStore::default();
    let mut now_ms = establish_global_cooldown(&store, "provider-a", "key-a", "model-a", 1);
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
        let permit = store
            .acquire_provider_cooldown_probe("provider-a", Some("key-a"), Some("model-a"))
            .unwrap()
            .unwrap_or_else(|| panic!("probe permit missing at step {index}"));
        store
            .complete_provider_cooldown_probe_failure_with_permit(&permit, now_ms)
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
                .unwrap()
                .available,
            "failed probe must keep the key blocked at step {index}"
        );
    }
}

#[test]
fn long_probe_backoff_action_does_not_bypass_real_failure_threshold() {
    let store = V3ProviderHealthStore::default();
    let action = V3ProviderFailureAction {
        class_code: "provider_http_503".to_string(),
        failure_fingerprint: None,
        recovery: V3ProviderRecoveryKind::RecoverableCounted,
        scope: V3ProviderHealthScope::GlobalProviderKey,
        score_delta_milli: -5,
        failure_threshold: 1,
        cooldown_ms: 60 * 60_000,
        long_probe_backoff: true,
        advisory_probe: false,
    };
    store
        .record_provider_failure_action("provider-a", "key-a", "model-a", &action, 1)
        .unwrap();
    assert!(
        store
            .scheduling_projection("provider-a", "key-a", "model-a", 1, 1, 1)
            .unwrap()
            .available,
        "classification bookkeeping alone cannot establish a cooldown"
    );
}

#[test]
fn configured_fast_recovery_probe_caps_the_ladder_at_two_minutes() {
    let manifest = routecodex_v3_config::compile_v3_config_05_manifest(
        routecodex_v3_config::parse_v3_config_02_authoring(
            r#"
version = 3
[servers.s]
bind = "127.0.0.1"
port = 1
routing_group = "g"
[providers.p]
type = "responses"
base_url = "http://provider.invalid/v1"
default_model = "m"
auth = { type = "api_key", entries = [{ alias = "a", env = "KEY" }] }
health = { enabled = true, failure_threshold = 3, cooldown_ms = 900000, probe_interval_ms = 120000 }
[providers.p.models.m]
[route_groups.g.pools.default]
targets = [{ kind = "provider_model", provider = "p", model = "m", key = "a", priority = 1 }]
"#,
        )
        .expect("parse fast-recovery manifest"),
    )
    .expect("compile fast-recovery manifest");
    let store = V3ProviderHealthStore::from_manifest_without_persistence(&manifest);
    for offset in 0..10 {
        store
            .record_real_provider_failure_for_interface(
                "p",
                "default",
                "a",
                "m",
                Some(503),
                1 + offset,
            )
            .unwrap();
    }
    let mut now_ms = 10;
    for (step, delta) in [5_000, 10_000, 30_000, 60_000, 120_000, 120_000, 120_000]
        .into_iter()
        .enumerate()
    {
        let due_at = now_ms + delta;
        assert_eq!(
            store
                .provider_cooldown_probe_keys_due(due_at)
                .unwrap()
                .len(),
            1,
            "fast-recovery probe step {step} must be due at {delta}ms"
        );
        let permit = store
            .acquire_provider_cooldown_probe("p", Some("a"), Some("m"))
            .unwrap()
            .expect("fast-recovery probe permit");
        store
            .complete_provider_cooldown_probe_failure_with_permit(&permit, due_at)
            .unwrap();
        now_ms = due_at;
    }
}
