//! Spec contract (v29): the business cooldown is the consecutive-failure
//! ladder 3 -> 10s, 5 -> 30s, 10 -> 1h, and it is a floor for probe
//! admission. Recovery probes keep the ordinary aggressive backoff ladder
//! 5s -> 10s -> 30s -> 60s -> 120s -> 900s -> 1800s capped at 30m, measured
//! from the cooldown floor onward.
//! Restart semantics (probe history reset) are owned by the persistence
//! module and start the same probe ladder from the cooldown floor.
use routecodex_v3_error::{
    V3ProviderFailureAction, V3ProviderFailureSessionScope, V3ProviderHealthScope,
    V3ProviderRecoveryKind,
};
use routecodex_v3_provider_responses::{V3ProviderFailureCooldownScope, V3ProviderHealthStore};

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
fn first_probe_is_due_exactly_at_the_cooldown_minimum_and_probe_success_resurrects() {
    let store = V3ProviderHealthStore::default();
    fail(&store, 1);
    fail(&store, 2);
    fail(&store, 3);
    // The third consecutive failure commits the v29 cooldown minimum; the
    // first recovery probe cannot fire before that 10s pool entry expires.
    let first_due = 3 + 10_000;
    assert!(
        store
            .provider_cooldown_probe_keys_due(first_due - 1)
            .unwrap()
            .is_empty(),
        "first probe must respect the committed 10s cooldown minimum"
    );
    assert_eq!(
        store
            .provider_cooldown_probe_keys_due(first_due)
            .unwrap()
            .len(),
        1,
        "first probe must be due exactly when the cooldown pool entry expires"
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
            .available,
        "probe success must resurrect a globally cooled exact identity"
    );
}

#[test]
fn continuous_failure_ladder_is_isolated_per_provider_key() {
    let store = V3ProviderHealthStore::default();
    let mut action = V3ProviderFailureAction::recoverable("transport");
    action.failure_threshold = 1;

    let fast = store
        .record_provider_failure_action("provider-fast", "key", "model", &action, 100)
        .expect("first provider failure");
    let mut slow = None;
    for now_ms in 100..=104 {
        slow = Some(
            store
                .record_provider_failure_action("provider-slow", "key", "model", &action, now_ms)
                .expect("continuous provider failure"),
        );
    }

    let slow = slow.expect("slow provider projection");
    assert!(fast.cooldown);
    assert!(slow.cooldown);
    let entries = store.cooldown_entries(104);
    let fast_until = entries
        .iter()
        .find(|entry| entry.provider_id == "provider-fast")
        .and_then(|entry| entry.until_ms);
    let slow_until = entries
        .iter()
        .find(|entry| entry.provider_id == "provider-slow")
        .and_then(|entry| entry.until_ms);
    // The v29 cooldown ladder is driven purely by each exact identity's own
    // consecutive count: 1 -> 10s, 5 -> 30s, with no cross-key coupling.
    assert_eq!(fast_until, Some(10_100));
    assert_eq!(slow_until, Some(30_104));
}

#[test]
fn successful_recovery_restarts_repeat_admission_at_the_cooldown_floor() {
    let store = V3ProviderHealthStore::default();
    let action = V3ProviderFailureAction::recoverable("transport");

    for now_ms in 100..=102 {
        store
            .record_provider_failure_action("provider-a", "key", "model", &action, now_ms)
            .expect("continuous failure");
    }
    assert_eq!(
        store
            .cooldown_entries(102)
            .iter()
            .find(|entry| entry.provider_id == "provider-a")
            .and_then(|entry| entry.until_ms),
        Some(10_102),
        "three consecutive failures commit the v29 10s cooldown minimum"
    );

    store
        .complete_probe_success("provider-a", "key", "model", 103)
        .expect("successful recovery");
    let after_recovery = store
        .record_provider_failure_action("provider-a", "key", "model", &action, 104)
        .expect("failure after recovery");
    assert!(
        after_recovery.available && !after_recovery.cooldown,
        "a fresh streak starts below the consecutive threshold"
    );
    store
        .record_provider_failure_action("provider-a", "key", "model", &action, 105)
        .expect("second failure of the fresh streak");
    let after_repeat = store
        .record_provider_failure_action("provider-a", "key", "model", &action, 106)
        .expect("third failure of the fresh streak");
    assert_eq!(
        after_repeat.cooldown_until_ms,
        Some(10_106),
        "the repeat admission commits the same v29 minimum after the reset"
    );
    assert!(
        store
            .provider_cooldown_probe_keys_due(10_105)
            .unwrap()
            .is_empty(),
        "the first recovery probe respects the committed cooldown minimum"
    );
    assert_eq!(
        store
            .provider_cooldown_probe_keys_due(10_106)
            .unwrap()
            .len(),
        1,
        "the recovery probe becomes due exactly at the cooldown floor"
    );
    assert_eq!(
        store
            .cooldown_entries(106)
            .iter()
            .find(|entry| entry.provider_id == "provider-a")
            .and_then(|entry| entry.until_ms),
        Some(10_106),
        "the repeat cooldown entry carries the v29 minimum"
    );
}

#[test]
fn session_business_success_does_not_remove_pending_probe() {
    let store = V3ProviderHealthStore::default();
    let session = scope();
    fail(&store, 1);
    fail(&store, 2);
    fail(&store, 3);
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
fn model_success_recovers_exact_model_without_clearing_sibling_probe() {
    let store = V3ProviderHealthStore::default();
    fail(&store, 1);
    fail(&store, 2);
    fail(&store, 3);
    for now in [1, 2, 3] {
        store
            .record_provider_failure_in_session(
                &scope(),
                "provider-a",
                Some("key-a"),
                Some("model-c"),
                Some("provider_error"),
                now,
            )
            .unwrap();
    }
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
            .available,
        "a failed model cannot block a sibling model"
    );
    assert_eq!(
        store.provider_cooldown_probe_keys_due(10_003).unwrap(),
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
            .available,
        "a success between failures must reset the exact identity failure streak"
    );
}

#[test]
fn probe_failures_cap_all_provider_errors_at_thirty_minutes() {
    let store = V3ProviderHealthStore::default();
    fail(&store, 1);
    fail(&store, 2);
    fail(&store, 3);
    // The first probe waits for the committed v29 cooldown minimum (10s);
    // every later step is the ordinary probe backoff ladder.
    let mut now_ms = 3;
    for (index, delta) in [10_000, 10_000, 30_000, 60_000, 120_000, 900_000, 1_800_000]
        .into_iter()
        .enumerate()
    {
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
                .available,
            "failed probe must keep the key blocked at step {index}"
        );
    }
}

#[test]
fn long_policy_probe_is_capped_at_thirty_minutes() {
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
    let mut now_ms = 1;
    // The first probe waits for the committed v31 cooldown minimum (10s);
    // every later step is the ordinary long-cadence probe ladder.
    for delta in [10_000, 10_000, 30_000, 60_000, 120_000, 900_000, 1_800_000] {
        let due_at = now_ms + delta;
        assert_eq!(
            store
                .provider_cooldown_probe_keys_due(due_at)
                .unwrap()
                .len(),
            1
        );
        let permit = store
            .acquire_provider_cooldown_probe("provider-a", Some("key-a"), Some("model-a"))
            .unwrap()
            .expect("long cadence probe permit");
        store
            .complete_provider_cooldown_probe_failure_with_permit(&permit, due_at)
            .unwrap();
        now_ms = due_at;
    }
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
    for now_ms in 1..=3 {
        store
            .record_provider_failure_in_session(
                &scope(),
                "p",
                Some("a"),
                Some("m"),
                Some("provider_error"),
                now_ms,
            )
            .unwrap();
    }
    let mut now_ms = 3;
    // The first probe waits for the committed v31 cooldown minimum (10s);
    // every later step is the probe ladder capped at the configured 120s.
    for (step, delta) in [10_000, 10_000, 30_000, 60_000, 120_000, 120_000, 120_000]
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
