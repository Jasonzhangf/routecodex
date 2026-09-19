//! Spec contract: ordinary provider cooldown probes use a fixed,
//! observable ladder capped at 15m. Long cadence is reserved for typed
//! 401/402/403/503 policy actions. The first probe after a key enters cooldown is
//! due 5s later.
//! Restart semantics (probe history reset) are owned by the persistence
//! module and start the same ladder from 5s.
use routecodex_v3_error::{
    V3ProviderFailureAction, V3ProviderFailureSessionScope, V3ProviderHealthScope,
    V3ProviderRecoveryKind,
};
use routecodex_v3_provider_responses::V3ProviderHealthStore;

const LADDER_MS: [u64; 7] = [
    5_000,   // first probe after block (probe failure count 0)
    30_000,  // after probe failure 1
    60_000,  // after probe failure 2
    180_000, // after probe failure 3
    900_000, // after probe failure 4
    900_000, // after probe failure 5 (capped)
    900_000, // after probe failure 6 (capped)
];

const LONG_LADDER_MS: [u64; 6] = [5_000, 30_000, 60_000, 180_000, 900_000, 1_800_000];

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
fn first_probe_is_due_exactly_5s_after_block_and_probe_success_resurrects() {
    let store = V3ProviderHealthStore::default();
    for now_ms in 1..=3 {
        fail(&store, now_ms);
    }
    // Block was created at now_ms = 3; first probe due at 3 + 5_000.
    let first_due = 3 + 5_000;
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
            .available
    );
    store
        .acquire_provider_cooldown_probe("provider-a", Some("key-a"), None)
        .unwrap()
        .expect("due auth-key probe must be acquirable");
    store
        .complete_provider_cooldown_probe_success_at("provider-a", Some("key-a"), None, first_due)
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
        "probe success must resurrect a globally cooled auth key"
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
fn model_success_does_not_clear_auth_key_cooldown() {
    let store = V3ProviderHealthStore::default();
    for now_ms in 1..=3 {
        fail(&store, now_ms);
    }
    store
        .record_provider_key_success("provider-a", "key-a", "model-a", 30_003)
        .expect("model success");
    assert!(
        !store
            .availability_for_session(
                &scope(),
                "provider-a",
                Some("key-a"),
                Some("model-b"),
                30_004,
            )
            .available,
        "a model-scoped success must not clear an auth-key cooldown"
    );
    assert_eq!(
        store.provider_cooldown_probe_keys_due(5_003).unwrap().len(),
        1,
        "the auth-key probe remains the only recovery owner"
    );
}

#[test]
fn model_success_resets_auth_key_consecutive_failures() {
    let store = V3ProviderHealthStore::default();
    fail(&store, 1);
    fail(&store, 2);
    store
        .record_provider_key_success("provider-a", "key-a", "model-a", 3)
        .expect("model success");
    fail(&store, 4);
    assert!(
        store
            .availability_for_session(&scope(), "provider-a", Some("key-a"), Some("model-a"), 5,)
            .available,
        "a success between failures must reset the auth-key failure streak"
    );
}

#[test]
fn probe_failures_cap_ordinary_errors_at_fifteen_minutes() {
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
                .acquire_provider_cooldown_probe("provider-a", Some("key-a"), None)
                .unwrap()
                .is_some(),
            "probe permit missing at step {index}"
        );
        store
            .complete_provider_cooldown_probe_failure("provider-a", Some("key-a"), None, now_ms)
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
        recovery: V3ProviderRecoveryKind::RecoverableCounted,
        scope: V3ProviderHealthScope::GlobalProviderKey,
        score_delta_milli: -5,
        failure_threshold: 1,
        cooldown_ms: 60 * 60_000,
        long_probe_backoff: true,
    };
    store
        .record_provider_failure_action("provider-a", "key-a", "model-a", &action, 1)
        .unwrap();
    let mut now_ms = 1;
    for delta in LONG_LADDER_MS {
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
            .complete_provider_cooldown_probe_failure_at_generation(
                "provider-a",
                Some("key-a"),
                Some("model-a"),
                due_at,
                Some(permit.expected_generation()),
            )
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
    for (step, delta) in [5_000, 30_000, 120_000, 120_000].into_iter().enumerate() {
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
            .acquire_provider_cooldown_probe("p", Some("a"), None)
            .unwrap()
            .expect("fast-recovery probe permit");
        store
            .complete_provider_cooldown_probe_failure_at_generation(
                "p",
                Some("a"),
                None,
                due_at,
                Some(permit.expected_generation()),
            )
            .unwrap();
        now_ms = due_at;
    }
}
