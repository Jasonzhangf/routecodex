//! A committed business cooldown lasts one hour. Independent recovery probes
//! start after five seconds and failed probes use the declared cadence.
use routecodex_v3_error::{
    V3ProviderFailureAction, V3ProviderFailureSessionScope, V3_PROVIDER_HEALTH_COOLDOWN_MS,
    V3_PROVIDER_RECOVERABLE_FAILURE_THRESHOLD,
};
use routecodex_v3_provider_responses::{V3ProviderAvailabilityReader, V3ProviderHealthStore};

const THRESHOLD: u64 = V3_PROVIDER_RECOVERABLE_FAILURE_THRESHOLD as u64;
const MINIMUM: u64 = V3_PROVIDER_HEALTH_COOLDOWN_MS;

const LADDER_MS: [u64; 7] = [
    5_000,     // first probe after block (probe failure count 0)
    10_000,    // after probe failure 1
    30_000,    // after probe failure 2
    60_000,    // after probe failure 3
    120_000,   // after probe failure 4
    900_000,   // after probe failure 5
    1_800_000, // after probe failure 6 (capped)
];

const LONG_LADDER_MS: [u64; 7] = [5_000, 10_000, 30_000, 60_000, 120_000, 900_000, 1_800_000];

fn scope() -> V3ProviderFailureSessionScope {
    V3ProviderFailureSessionScope::new("server-a", "group-a", "session-a").unwrap()
}

fn reach_threshold(
    store: &V3ProviderHealthStore,
    identity: (&str, &str, &str),
    started_at: u64,
    action: &V3ProviderFailureAction,
) -> u64 {
    let (provider, key, model) = identity;
    let blocked_at = started_at + THRESHOLD - 1;
    for now_ms in started_at..=blocked_at {
        let health = store
            .record_provider_failure_action(provider, key, model, action, now_ms)
            .unwrap();
        assert_eq!(health.cooldown, now_ms == blocked_at);
    }
    blocked_at
}

#[test]
fn first_probe_is_due_at_five_seconds_and_success_restores_at_expiry() {
    let store = V3ProviderHealthStore::default();
    let blocked_at = reach_threshold(
        &store,
        ("provider-a", "key-a", "model-a"),
        1,
        &V3ProviderFailureAction::recoverable("provider_http_500"),
    );
    let first_due = blocked_at + 5_000;
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
    let permit = store
        .acquire_provider_cooldown_probe("provider-a", Some("key-a"), Some("model-a"))
        .unwrap()
        .expect("due exact identity probe must be acquirable");
    store
        .complete_provider_cooldown_probe_success_with_permit(&permit, first_due)
        .unwrap();
    assert!(
        !store
            .availability("provider-a", Some("key-a"), Some("model-a"), first_due)
            .available
    );
    let expiry = blocked_at + MINIMUM;
    let permit = store
        .acquire_provider_cooldown_probe_if_due(
            "provider-a",
            Some("key-a"),
            Some("model-a"),
            expiry,
        )
        .unwrap()
        .expect("a fresh probe is due at expiry");
    store
        .complete_provider_cooldown_probe_success_with_permit(&permit, expiry)
        .unwrap();
    assert!(
        store
            .availability_for_session(
                &scope(),
                "provider-a",
                Some("key-a"),
                Some("model-a"),
                expiry,
            )
            .available,
        "probe success must resurrect a globally cooled exact identity"
    );
}

#[test]
fn consecutive_failures_commit_independent_provider_key_deadlines() {
    let store = V3ProviderHealthStore::default();
    let action = V3ProviderFailureAction::recoverable("provider_http_500");
    let fast = reach_threshold(&store, ("provider-fast", "key", "model"), 100, &action);
    let slow = reach_threshold(&store, ("provider-slow", "key", "model"), 102, &action);
    let entries = store.cooldown_entries(slow);
    let fast_until = entries
        .iter()
        .find(|entry| entry.provider_id == "provider-fast")
        .and_then(|entry| entry.until_ms);
    let slow_until = entries
        .iter()
        .find(|entry| entry.provider_id == "provider-slow")
        .and_then(|entry| entry.until_ms);
    assert_eq!(fast_until, Some(fast + MINIMUM));
    assert_eq!(slow_until, Some(slow + MINIMUM));
}

#[test]
fn successful_recovery_restarts_the_business_streak_and_probe_cadence() {
    let store = V3ProviderHealthStore::default();
    let action = V3ProviderFailureAction::recoverable("provider_http_502");
    let blocked_at = reach_threshold(&store, ("provider-a", "key", "model"), 100, &action);
    let expiry = blocked_at + MINIMUM;
    assert_eq!(
        store
            .cooldown_entries(blocked_at)
            .iter()
            .find(|entry| entry.provider_id == "provider-a")
            .and_then(|entry| entry.until_ms),
        Some(expiry)
    );
    let permit = store
        .acquire_provider_cooldown_probe_if_due("provider-a", Some("key"), Some("model"), expiry)
        .unwrap()
        .expect("recovery must be due after the minimum");
    assert!(store
        .complete_provider_cooldown_probe_success_if_current_with_permit(&permit, expiry)
        .unwrap());
    let next_block = reach_threshold(&store, ("provider-a", "key", "model"), expiry + 1, &action);
    assert_eq!(
        store
            .provider_cooldown_probe_next_deadline_ms("provider-a", Some("key"), Some("model"))
            .unwrap(),
        Some(next_block + 5_000),
        "the new business streak starts a fresh probe cadence"
    );
}

#[test]
fn session_business_success_does_not_remove_pending_probe() {
    let store = V3ProviderHealthStore::default();
    let session = scope();
    reach_threshold(
        &store,
        ("provider-a", "key-a", "model-a"),
        1,
        &V3ProviderFailureAction::recoverable("provider_http_500"),
    );
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
fn qualifying_probe_recovers_exact_model_without_clearing_sibling_probe() {
    let store = V3ProviderHealthStore::default();
    let action = V3ProviderFailureAction::recoverable("provider_http_500");
    let blocked_at = reach_threshold(&store, ("provider-a", "key-a", "model-a"), 1, &action);
    reach_threshold(&store, ("provider-a", "key-a", "model-c"), 1, &action);
    let expiry = blocked_at + MINIMUM;
    let permit = store
        .acquire_provider_cooldown_probe_if_due(
            "provider-a",
            Some("key-a"),
            Some("model-a"),
            expiry,
        )
        .unwrap()
        .expect("first model probe due");
    store
        .complete_provider_cooldown_probe_success_with_permit(&permit, expiry)
        .unwrap();
    assert!(
        store
            .availability_for_session(
                &scope(),
                "provider-a",
                Some("key-a"),
                Some("model-b"),
                expiry,
            )
            .available,
        "a failed model cannot block a sibling model"
    );
    assert_eq!(
        store.provider_cooldown_probe_keys_due(expiry).unwrap(),
        vec![(
            "provider-a".into(),
            Some("key-a".into()),
            Some("model-c".into())
        )],
        "the qualifying probe clears exactly its model"
    );
    assert!(
        store
            .scheduling_projection("provider-a", "key-a", "model-a", 1, 1, expiry)
            .unwrap()
            .available
    );
}

#[test]
fn model_success_resets_exact_identity_consecutive_failures() {
    let store = V3ProviderHealthStore::default();
    let action = V3ProviderFailureAction::recoverable("provider_http_500");
    for now_ms in 1..THRESHOLD {
        store
            .record_provider_failure_action("provider-a", "key-a", "model-a", &action, now_ms)
            .unwrap();
    }
    store
        .record_provider_key_success("provider-a", "key-a", "model-a", THRESHOLD)
        .expect("model success");
    let next = store
        .record_provider_failure_action("provider-a", "key-a", "model-a", &action, THRESHOLD + 1)
        .unwrap();
    assert!(next.available);
    assert_eq!(next.failure_streak, 1);
}

#[test]
fn probe_failures_cap_all_provider_errors_at_thirty_minutes() {
    let store = V3ProviderHealthStore::default();
    let mut now_ms = reach_threshold(
        &store,
        ("provider-a", "key-a", "model-a"),
        1,
        &V3ProviderFailureAction::recoverable("provider_http_500"),
    );
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
                .available,
            "failed probe must keep the key blocked at step {index}"
        );
    }
}

#[test]
fn long_policy_probe_is_capped_at_thirty_minutes() {
    let store = V3ProviderHealthStore::default();
    let mut action = V3ProviderFailureAction::recoverable("provider_http_503");
    action.long_probe_backoff = true;
    let mut now_ms = reach_threshold(&store, ("provider-a", "key-a", "model-a"), 1, &action);
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
    let mut now_ms = reach_threshold(
        &store,
        ("p", "a", "m"),
        1,
        &V3ProviderFailureAction::recoverable("provider_http_500"),
    );
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
