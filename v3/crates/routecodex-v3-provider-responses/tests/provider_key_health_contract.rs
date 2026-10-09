use routecodex_v3_config::{compile_v3_config_05_manifest, parse_v3_config_02_authoring};
use routecodex_v3_error::{
    build_v3_provider_global_error_fingerprint, build_v3_provider_global_failure_policy,
    V3ProviderErrorFingerprint, V3ProviderFailureSessionScope,
};

#[test]
fn ordinary_429_requires_three_consecutive_failures_of_exact_identity() {
    let store = V3ProviderKeyHealthStore::default();
    let mut action = V3ProviderFailureAction::recoverable("rate_limit_error");
    action.failure_threshold = build_v3_provider_global_failure_policy(429)
        .unwrap()
        .failure_threshold;
    action.failure_fingerprint = build_v3_provider_global_error_fingerprint(429).unwrap();
    assert_eq!(action.failure_threshold, 3);
    for time in [100, 101] {
        let state = store
            .record_provider_failure_action("p", "a", "m", &action, time)
            .unwrap();
        assert!(state.available);
        assert!(!state.cooldown);
    }
    for (provider, key, model) in [("p", "b", "m"), ("p", "a", "n"), ("q", "a", "m")] {
        let state = store
            .record_provider_failure_action(provider, key, model, &action, 102)
            .unwrap();
        assert!(state.available, "sibling {provider}.{model}.{key}");
    }
    let third = store
        .record_provider_failure_action("p", "a", "m", &action, 103)
        .unwrap();
    assert!(third.cooldown);
    assert!(!third.available);
    store.complete_probe_success("p", "a", "m", 104).unwrap();
    store
        .record_provider_key_success("p", "a", "m", 104)
        .unwrap();
    for time in [105, 106] {
        assert!(
            store
                .record_provider_failure_action("p", "a", "m", &action, time)
                .unwrap()
                .available
        );
    }
    let mut different = action.clone();
    different.failure_fingerprint = Some(
        V3ProviderErrorFingerprint::new("recoverable_upstream", "different", 429, "different")
            .unwrap(),
    );
    assert!(
        store
            .record_provider_failure_action("p", "a", "m", &different, 107)
            .unwrap()
            .available
    );
}
use routecodex_v3_provider_responses::{
    V3ProviderFailureAction, V3ProviderFailureCooldownScope, V3ProviderFailurePolicy,
    V3ProviderHealthStore, V3ProviderKeyHealthStore, V3ProviderRecoveryKind,
    V3ProviderSchedulingProjection,
};

#[test]
fn health_projection_without_history_uses_contract_default_score() {
    let store = V3ProviderKeyHealthStore::default();
    let projection = store
        .scheduling_projection("provider-a", "key-a", "model-a", 100, 1, 100)
        .expect("initial projection");
    assert_eq!(projection.score_milli, 100);
}

#[test]
fn low_priority_baseline_does_not_collapse_threshold_to_one_failure() {
    // Regression: score baseline is the configured priority, so a priority-1 key
    // reaches score 0 after a single -5 delta. A thresholded recoverable failure
    // must still wait for `failure_threshold` consecutive failures instead of
    // cooling down after one transient error.
    let manifest = compile_v3_config_05_manifest(
        parse_v3_config_02_authoring(
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
[providers.p.models.m]
[route_groups.g.pools.default]
targets = [{ kind = "provider_model", provider = "p", model = "m", key = "a", priority = 1 }]
"#,
        )
        .expect("parse manifest authoring"),
    )
    .expect("compile manifest");
    let store = V3ProviderHealthStore::from_manifest_without_persistence(&manifest);
    let mut action = V3ProviderFailureAction::recoverable("provider_502");
    action.failure_threshold = 3;

    let first = store
        .record_provider_failure_action("p", "a", "m", &action, 100)
        .expect("first recoverable failure");
    assert_eq!(first.score_milli, 0);
    assert!(
        !first.cooldown,
        "the health store consumes the typed threshold as declared; a low-priority key stays available until threshold 3"
    );
    assert!(first.available);
    let first_scheduling = store
        .scheduling_projection("p", "a", "m", 1, 1, 100)
        .expect("first scheduling projection");
    assert!(first_scheduling.available);
    assert_eq!(first_scheduling.score_milli, 0);
    assert_eq!(first_scheduling.effective_weight_milli, 1);
    assert!(first_scheduling.blocked_scopes.is_empty());

    store
        .record_provider_failure_action("p", "a", "m", &action, 101)
        .expect("second recoverable failure");
    let third = store
        .record_provider_failure_action("p", "a", "m", &action, 102)
        .expect("third recoverable failure");
    assert!(third.cooldown, "threshold must still cool the key down");
    assert!(!third.available);
    let third_scheduling = store
        .scheduling_projection("p", "a", "m", 1, 1, 102)
        .expect("third scheduling projection");
    assert!(!third_scheduling.available);
    assert_eq!(
        third_scheduling.blocked_scopes,
        vec!["provider_key_health_cooldown".to_string()]
    );
}

#[test]
fn recoverable_failure_cools_after_repeat_without_changing_score_contract() {
    let store = V3ProviderKeyHealthStore::default();
    let action = V3ProviderFailureAction::recoverable("transport");

    let first = store
        .record_provider_failure_action("provider-a", "key-a", "model-a", &action, 100)
        .expect("first failure");
    assert_eq!(first.score_milli, 95);
    assert_eq!(first.success_streak, 0);
    assert!(!first.available);
    assert!(first.cooldown);
    assert_eq!(first.cooldown_until_ms, Some(5_100));
    let first_probe = store
        .provider_cooldown_probe_keys_due(5_099)
        .expect("probe due query");
    assert!(first_probe.is_empty(), "first probe must wait 5s");
    assert_eq!(
        store
            .provider_cooldown_probe_keys_due(5_100)
            .expect("probe due query"),
        vec![(
            "provider-a".into(),
            Some("key-a".into()),
            Some("model-a".into())
        )]
    );
    store
        .complete_probe_success("provider-a", "key-a", "model-a", 5_101)
        .expect("probe success must restore exact identity");
    let second = store
        .record_provider_failure_action("provider-a", "key-a", "model-a", &action, 101)
        .expect("repeated failure");
    assert_eq!(second.score_milli, 95);
    assert!(!second.available);
    assert!(second.cooldown);
    assert_eq!(second.cooldown_until_ms, Some(5_101));
}

#[test]
fn dynamic_probe_ladder_starts_at_5s_after_the_first_cooldown() {
    let store = V3ProviderHealthStore::default();
    let session = V3ProviderFailureSessionScope::new("server-a", "group-a", "session-a")
        .expect("session scope");
    let policy = V3ProviderFailurePolicy {
        failure_threshold: 1,
        cooldown_ms: 60_000,
        probe_interval_ms: 60_000,
        max_probe_interval_ms: None,
        long_probe_backoff: false,
        until_restart: false,
        cooldown_scope: V3ProviderFailureCooldownScope::ProviderKeyModel,
    };
    for now_ms in 100..=100 {
        store
            .record_provider_failure_in_session_with_policy(
                &session,
                "provider-a",
                Some("key-a"),
                Some("model-a"),
                Some("transport"),
                None,
                now_ms,
                Some(policy),
            )
            .expect("same-key failure");
    }

    assert!(store
        .provider_cooldown_probe_keys_due(5_099)
        .expect("probe due query")
        .is_empty());
    assert_eq!(
        store
            .provider_cooldown_probe_keys_due(5_100)
            .expect("probe due query"),
        vec![(
            "provider-a".into(),
            Some("key-a".into()),
            Some("model-a".into()),
        )]
    );
}

#[test]
fn mixed_recoverable_fingerprints_do_not_share_an_identity() {
    // exact provider key model failure identity is `(provider, auth_alias, model)`:
    // 1) 不同指纹必须各自重启连续计数，混合指纹永远不得相加触发冷却；
    // 2) 同一 auth alias 下不同 model 各持独立身份，同指纹也不会跨模型叠加。
    let store = V3ProviderHealthStore::default();
    let session = V3ProviderFailureSessionScope::new("server-a", "group-a", "session-a")
        .expect("session scope");
    let policy = V3ProviderFailurePolicy {
        failure_threshold: 3,
        cooldown_ms: 5_000,
        probe_interval_ms: 5_000,
        max_probe_interval_ms: None,
        long_probe_backoff: false,
        until_restart: false,
        cooldown_scope: V3ProviderFailureCooldownScope::ProviderKeyModel,
    };
    let fingerprint = |status: u16| {
        build_v3_provider_global_error_fingerprint(status)
            .expect("classification")
            .expect("fingerprint")
    };
    let record = |model_id: &'static str, status: u16, now_ms: u64| {
        store
            .record_provider_failure_in_session_with_policy(
                &session,
                "provider-a",
                Some("key-a"),
                Some(model_id),
                Some("transport"),
                Some(fingerprint(status)),
                now_ms,
                Some(policy),
            )
            .expect("recoverable failure")
    };
    // 500 / 502 / 503 各一次：每次换指纹都重启连续计数，三次都是"第 1 次"，
    // 不得凑成一次 auth-key 冷却。
    record("model-a", 500, 100);
    record("model-b", 502, 101);
    record("model-c", 503, 102);
    for model_id in ["model-a", "model-b", "model-c"] {
        assert!(
            store
                .availability_for_session(
                    &session,
                    "provider-a",
                    Some("key-a"),
                    Some(model_id),
                    102,
                )
                .available,
            "{model_id} must stay available: distinct recoverable fingerprints must not sum into a cooldown"
        );
    }
    assert!(
        store
            .provider_cooldown_probe_keys_due(102)
            .expect("probe due query")
            .is_empty(),
        "no exact identity cooldown probe may be scheduled before three same-fingerprint failures"
    );
    // 同一 500 指纹、三个不同模型各一次：每个 provider+key+model 都独立计
    // 数；随后只让 model-a 达到阈值，其他模型必须保持可用。
    record("model-a", 500, 200);
    record("model-b", 500, 201);
    record("model-c", 500, 202);
    record("model-a", 500, 203);
    for (model_id, expected) in [("model-a", false), ("model-b", true), ("model-c", true)] {
        assert_eq!(
            store
                .availability_for_session(
                    &session,
                    "provider-a",
                    Some("key-a"),
                    Some(model_id),
                    203,
                )
                .available,
            expected,
            "exact provider+key+model identity isolation: model={model_id}"
        );
    }
}

#[test]
fn session_scoped_recoverable_failures_do_not_create_global_key_cooldown() {
    let store = V3ProviderKeyHealthStore::default();
    let action = V3ProviderFailureAction::recoverable_session("transport");
    for now_ms in 100..120 {
        store
            .record_provider_failure_action("provider-a", "key-a", "model-a", &action, now_ms)
            .expect("session-scoped failure");
    }

    let projection = store
        .scheduling_projection("provider-a", "key-a", "model-a", 1, 1, 120)
        .expect("session-scoped projection");
    assert_eq!(projection.score_milli, 0);
    assert!(projection.available);
    assert_eq!(projection.blocked_scopes, Vec::<String>::new());
    assert!(store
        .provider_cooldown_probe_keys(120, false)
        .expect("session-scoped actions must not create a global probe")
        .is_empty());
}

#[test]
fn disabled_health_does_not_record_global_failure_actions() {
    let manifest = compile_v3_config_05_manifest(
        parse_v3_config_02_authoring(
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
auth = { type = "api_key", entries = [{ alias = "k", env = "KEY" }] }
health = { enabled = false, failure_threshold = 1, cooldown_ms = 1 }
[providers.p.models.m]
[route_groups.g.pools.default]
targets = [{ kind = "provider_model", provider = "p", model = "m", key = "k", priority = 1 }]
"#,
        )
        .expect("parse manifest authoring"),
    )
    .expect("compile manifest");
    let store = V3ProviderHealthStore::from_manifest_without_persistence(&manifest);

    for (reason, now_ms) in [("provider_429", 100), ("provider_502", 101)] {
        let projection = store
            .record_provider_failure_action(
                "p",
                "k",
                "m",
                &V3ProviderFailureAction::recoverable(reason),
                now_ms,
            )
            .expect("disabled health failure action");
        assert_eq!(projection.score_milli, 1);
        assert_eq!(projection.failure_streak, 0);
        assert!(!projection.cooldown);
        assert!(projection.available);
    }

    let projection = store
        .scheduling_projection("p", "k", "m", 1, 1, 102)
        .expect("disabled health projection");
    assert_eq!(projection.score_milli, 1);
    assert!(projection.available);
    assert!(store
        .provider_cooldown_probe_keys(102, false)
        .expect("disabled health probe keys")
        .is_empty());
}

#[test]
fn business_success_resets_streak_and_only_matching_probe_releases_cooldown() {
    let store = V3ProviderKeyHealthStore::default();
    let action = V3ProviderFailureAction::recoverable("transport");
    for now_ms in 100..120 {
        store
            .record_provider_failure_action("provider-a", "key-a", "model-a", &action, now_ms)
            .expect("failure");
    }

    // A business success breaks the streak. Recovery of an existing cooldown
    // remains owned by a successful semantic probe of the matching identity.
    let revived = store
        .record_provider_key_success("provider-a", "key-a", "model-a", 103)
        .expect("success revival");
    assert!(
        !revived.available,
        "business success cannot bypass pending probe recovery"
    );
    assert!(revived.cooldown);
    assert_eq!(revived.failure_streak, 0);
    assert_eq!(revived.success_streak, 1);
    assert_eq!(revived.score_milli, 1);

    let probe_recovered = store
        .complete_probe_success("provider-a", "key-a", "model-a", 104)
        .expect("probe success stays available");
    assert!(probe_recovered.available);
    let post_probe_success = store
        .record_provider_key_success("provider-a", "key-a", "model-a", 105)
        .expect("post-probe success");
    assert_eq!(post_probe_success.score_milli, 101);
}

#[test]
fn health_score_uses_only_the_latest_100_calls() {
    let store = V3ProviderHealthStore::default();
    let failure = V3ProviderFailureAction::recoverable("transport");
    for now_ms in 0..100 {
        store
            .record_provider_failure_action("p", "k", "m", &failure, now_ms)
            .expect("failure");
    }
    let before = store
        .scheduling_projection("p", "k", "m", 100, 1, 100)
        .expect("projection");
    assert_eq!(before.score_milli, 0);
    let success = store
        .record_provider_key_success("p", "k", "m", 101)
        .expect("success");
    // The first success remains inside the latest 100-call score window; it
    // resets the failure streak without deleting prior observations.
    assert_eq!(success.score_milli, 0);
    assert_eq!(success.failure_streak, 0);
    for now_ms in 102..202 {
        store
            .record_provider_key_success("p", "k", "m", now_ms)
            .expect("success");
    }
    let after = store
        .scheduling_projection("p", "k", "m", 100, 1, 202)
        .expect("projection");
    assert_eq!(after.score_milli, 150);
}

#[test]
fn health_score_uses_configured_priority_as_its_baseline() {
    let store = V3ProviderHealthStore::default();
    let failure = V3ProviderFailureAction::recoverable("provider_502");
    let initial = store
        .scheduling_projection("p", "k", "m", 80, 1, 100)
        .expect("initial projection");
    assert_eq!(initial.score_milli, 80);

    store
        .record_provider_failure_action("p", "k", "m", &failure, 101)
        .expect("recoverable failure");
    let after_failure = store
        .scheduling_projection("p", "k", "m", 80, 1, 102)
        .expect("projection after failure");
    assert_eq!(after_failure.score_milli, 75);
}

#[test]
fn two_502_failures_enter_cooldown() {
    let store = V3ProviderHealthStore::default();
    store
        .scheduling_projection("p", "k", "m", 100, 1, 100)
        .expect("initial projection");
    let action = V3ProviderFailureAction::recoverable("provider_502");

    let first = store
        .record_provider_failure_action("p", "k", "m", &action, 101)
        .expect("first 502 failure");
    assert!(
        first.cooldown,
        "first typed provider failure cools exact identity"
    );
    assert_eq!(
        store
            .scheduling_projection("p", "k", "m", 100, 1, 102)
            .unwrap()
            .score_milli,
        95
    );

    let second = store
        .record_provider_failure_action("p", "k", "m", &action, 102)
        .expect("second 502 failure");
    assert!(second.cooldown);
    assert_eq!(second.cooldown_until_ms, Some(5_102));
}

#[test]
fn successful_calls_cap_health_at_150() {
    let store = V3ProviderHealthStore::default();
    for now_ms in 0..100 {
        store
            .record_provider_key_success("p", "k", "m", now_ms)
            .expect("success");
    }
    assert_eq!(
        store
            .scheduling_projection("p", "k", "m", 100, 1, 100)
            .unwrap()
            .score_milli,
        150
    );
}

#[test]
fn success_streak_increments_and_failure_resets_it() {
    let store = V3ProviderKeyHealthStore::default();
    let first = store
        .record_provider_key_success("provider-a", "key-a", "model-a", 100)
        .unwrap();
    let second = store
        .record_provider_key_success("provider-a", "key-a", "model-a", 101)
        .unwrap();
    assert_eq!(first.success_streak, 1);
    assert_eq!(second.success_streak, 2);

    let failure = store
        .record_provider_failure_action(
            "provider-a",
            "key-a",
            "model-a",
            &V3ProviderFailureAction::recoverable("transport"),
            102,
        )
        .unwrap();
    assert_eq!(failure.success_streak, 0);
}

#[test]
fn health_score_does_not_change_configured_priority_or_weight() {
    let healthy =
        V3ProviderSchedulingProjection::new("provider-a", "key-a", "model-a", 1, 1000, 100);
    let degraded =
        V3ProviderSchedulingProjection::new("provider-b", "key-b", "model-b", 1, 500, 100);
    let lower_priority =
        V3ProviderSchedulingProjection::new("provider-c", "key-c", "model-c", 2, 1000, 100);

    assert_eq!(
        healthy.effective_weight_milli,
        degraded.effective_weight_milli
    );
    assert_eq!(healthy.priority, degraded.priority);
    assert_eq!(healthy.effective_priority, degraded.effective_priority);
    assert!(lower_priority.priority > healthy.priority);
    assert!(lower_priority.effective_priority > healthy.effective_priority);
}

#[test]
fn health_score_preserves_configured_priority() {
    let healthy =
        V3ProviderSchedulingProjection::new("provider-a", "key-a", "model-a", 10, 1_020, 1);
    let degraded =
        V3ProviderSchedulingProjection::new("provider-b", "key-b", "model-b", 10, 900, 1);

    assert_eq!(healthy.effective_priority, 10);
    assert_eq!(degraded.effective_priority, 10);
}

#[test]
fn health_score_controls_weight_without_changing_priority_bucket() {
    let store = V3ProviderHealthStore::default();
    store
        .scheduling_projection("provider-a", "key-a", "model-a", 100, 1, 100)
        .expect("initial projection");
    store
        .record_provider_failure_action(
            "provider-a",
            "key-a",
            "model-a",
            &V3ProviderFailureAction::recoverable("provider_502"),
            101,
        )
        .expect("recoverable failure");
    let degraded = store
        .scheduling_projection("provider-a", "key-a", "model-a", 100, 1, 102)
        .expect("degraded projection");
    assert_eq!(degraded.effective_priority, 100);
    assert_eq!(degraded.score_milli, 95);
    assert_eq!(degraded.effective_weight_milli, 95);
}

#[test]
fn extreme_positive_health_score_preserves_configured_priority() {
    let projection =
        V3ProviderSchedulingProjection::new("provider-a", "key-a", "model-a", 10, 5_000, 1);

    assert_eq!(projection.effective_priority, 10);
}

#[test]
fn odd_configured_priorities_are_not_health_adjusted() {
    let priority_one =
        V3ProviderSchedulingProjection::new("provider-a", "key-a", "model-a", 1, 5_000, 1);
    let priority_three =
        V3ProviderSchedulingProjection::new("provider-b", "key-b", "model-b", 3, 5_000, 1);

    assert_eq!(priority_one.effective_priority, 1);
    assert_eq!(priority_three.effective_priority, 3);
}

#[test]
fn zero_configured_priority_is_not_health_adjusted() {
    let projection =
        V3ProviderSchedulingProjection::new("provider-a", "key-a", "model-a", 0, 5_000, 1);

    assert_eq!(projection.effective_priority, 0);
}

#[test]
fn score_zero_keeps_a_positive_minimum_scheduling_weight() {
    let projection = V3ProviderSchedulingProjection::new("provider-a", "key-a", "model-a", 1, 0, 7);
    assert_eq!(projection.effective_weight_milli, 7);
    assert!(projection.available);
}

#[test]
fn transient_failure_preserves_configured_priority_recovery_path() {
    let store = V3ProviderKeyHealthStore::default();
    let action = V3ProviderFailureAction::recoverable("transport");
    let failed = store
        .record_provider_failure_action("provider-a", "key-a", "model-a", &action, 100)
        .expect("failure");

    assert_eq!(failed.score_milli, 95);
    let scheduling = store
        .scheduling_projection("provider-a", "key-a", "model-a", 1, 1, 100)
        .expect("scheduling projection");
    assert_eq!(scheduling.effective_priority, 1);
}

#[test]
fn health_neutral_action_does_not_change_score_or_cooldown() {
    let store = V3ProviderKeyHealthStore::default();
    let action = V3ProviderFailureAction {
        recovery: V3ProviderRecoveryKind::HealthNeutralTransient,
        ..V3ProviderFailureAction::recoverable("sse_stall")
    };
    let result = store
        .record_provider_failure_action("provider-a", "key-a", "model-a", &action, 100)
        .expect("health neutral");
    assert_eq!(result.score_milli, 100);
    assert_eq!(result.score_generation, 0);
    assert!(!result.cooldown);
    assert!(result.available);
}

#[test]
fn cooldown_expiry_only_opens_probe_and_probe_failure_reschedules() {
    let store = V3ProviderKeyHealthStore::default();
    let action = V3ProviderFailureAction::recoverable("transport");
    for now_ms in 100..120 {
        store
            .record_provider_failure_action("provider-a", "key-a", "model-a", &action, now_ms)
            .expect("failure");
    }
    let expired = store
        .scheduling_projection("provider-a", "key-a", "model-a", 1, 1, 900_103)
        .expect("projection");
    assert!(!expired.available);
    let rescheduled = store
        .complete_probe_failure("provider-a", "key-a", "model-a", 900_104, 900_000)
        .expect("probe failure");
    assert!(rescheduled.cooldown);
    assert!(!rescheduled.available);
}

#[test]
fn recoverable_key_probe_is_single_flight_and_global_probe_is_not_duplicated() {
    let store = V3ProviderKeyHealthStore::default();
    let recoverable = V3ProviderFailureAction::recoverable("transport");
    for now_ms in 100..120 {
        store
            .record_provider_failure_action("provider-a", "key-a", "model-a", &recoverable, now_ms)
            .expect("recoverable failure");
    }
    let irrecoverable = V3ProviderFailureAction {
        recovery: V3ProviderRecoveryKind::IrrecoverableGlobalCooldown,
        scope: routecodex_v3_provider_responses::V3ProviderHealthScope::GlobalProviderKey,
        score_delta_milli: -20,
        failure_threshold: 0,
        cooldown_ms: 60_000,
        long_probe_backoff: false,
        class_code: "invalid_api_key".to_string(),
        failure_fingerprint: None,
    };
    store
        .record_provider_failure_action("provider-b", "key-b", "model-b", &irrecoverable, 100)
        .expect("irrecoverable failure");
    let globally_blocked = store
        .scheduling_projection("provider-b", "key-b", "model-b", 1, 1, 100)
        .expect("global cooldown projection");
    assert!(!globally_blocked.available);
    let globally_recovered = store
        .complete_probe_success("provider-b", "key-b", "model-b", 101)
        .expect("global probe success");
    assert!(globally_recovered.available);
    assert!(!globally_recovered.cooldown);

    let startup_keys = store
        .provider_cooldown_probe_keys(0, true)
        .expect("startup probe candidates");
    assert_eq!(
        startup_keys,
        vec![(
            "provider-a".into(),
            Some("key-a".into()),
            Some("model-a".into())
        )]
    );
    let permit = store
        .acquire_provider_cooldown_probe("provider-a", Some("key-a"), Some("model-a"))
        .expect("probe acquisition")
        .expect("first probe owns key");
    assert!(store
        .acquire_provider_cooldown_probe("provider-a", Some("key-a"), Some("model-a"))
        .expect("single-flight check")
        .is_none());
    store
        .complete_probe_success_at_generation(
            permit.provider_id(),
            permit.auth_alias().expect("permit auth alias"),
            permit.model_id().expect("permit model id"),
            104,
            Some(permit.expected_generation()),
        )
        .expect("probe success");
}

#[test]
fn stale_probe_generation_cannot_clear_newer_failure_state() {
    let store = V3ProviderKeyHealthStore::default();
    let action = V3ProviderFailureAction::recoverable("transport");
    for now_ms in 100..120 {
        store
            .record_provider_failure_action("provider-a", "key-a", "model-a", &action, now_ms)
            .expect("failure");
    }
    let permit = store
        .acquire_provider_cooldown_probe("provider-a", Some("key-a"), Some("model-a"))
        .expect("probe acquisition")
        .expect("probe permit");
    store
        .record_provider_failure_action("provider-a", "key-a", "model-a", &action, 103)
        .expect("newer failure");
    store
        .complete_probe_success_at_generation(
            "provider-a",
            "key-a",
            "model-a",
            104,
            Some(permit.expected_generation()),
        )
        .expect("stale probe completion is ignored without clearing newer state");
    assert!(store
        .acquire_provider_cooldown_probe("provider-a", Some("key-a"), Some("model-a"))
        .expect("stale completion releases single-flight permit")
        .is_some());
}

#[test]
fn stale_failed_probe_cannot_mutate_newer_failure_state() {
    let store = V3ProviderKeyHealthStore::default();
    let action = V3ProviderFailureAction::recoverable("transport");
    for now_ms in 100..120 {
        store
            .record_provider_failure_action("provider-a", "key-a", "model-a", &action, now_ms)
            .expect("failure");
    }
    let permit = store
        .acquire_provider_cooldown_probe("provider-a", Some("key-a"), Some("model-a"))
        .expect("probe acquisition")
        .expect("probe permit");
    let newer = store
        .record_provider_failure_action("provider-a", "key-a", "model-a", &action, 103)
        .expect("newer failure");

    store
        .complete_provider_cooldown_probe_failure_at_generation(
            "provider-a",
            Some("key-a"),
            Some("model-a"),
            104,
            Some(permit.expected_generation()),
        )
        .expect("stale failed-probe completion is ignored without mutating newer state");
    let after = store
        .scheduling_projection("provider-a", "key-a", "model-a", 1, 1, 104)
        .expect("projection after stale failed probe");
    assert_eq!(after.score_milli, newer.score_milli);
    assert_eq!(after.score_generation, newer.score_generation);
    assert!(store
        .acquire_provider_cooldown_probe("provider-a", Some("key-a"), Some("model-a"))
        .expect("stale completion releases single-flight permit")
        .is_some());
}

#[test]
fn account_error_reaches_cooldown_at_zero() {
    let store = V3ProviderKeyHealthStore::default();
    let action = V3ProviderFailureAction {
        recovery: V3ProviderRecoveryKind::IrrecoverableGlobalCooldown,
        scope: routecodex_v3_provider_responses::V3ProviderHealthScope::GlobalProviderKey,
        score_delta_milli: -20,
        failure_threshold: 0,
        cooldown_ms: 60_000,
        long_probe_backoff: false,
        class_code: "invalid_api_key".to_string(),
        failure_fingerprint: None,
    };
    for now_ms in 100..105 {
        store
            .record_provider_failure_action("provider-a", "key-a", "model-a", &action, now_ms)
            .expect("account failure");
    }
    let result = store
        .record_provider_failure_action("provider-a", "key-a", "model-a", &action, 105)
        .expect("account failure");
    assert!(result.cooldown);
    assert!(!result.available);
    assert_eq!(result.score_milli, 0);
}

#[test]
fn score_and_cooldown_are_isolated_per_provider_key_and_model() {
    let store = V3ProviderKeyHealthStore::default();
    let action = V3ProviderFailureAction::recoverable("transport");
    for now_ms in 100..120 {
        store
            .record_provider_failure_action("provider-a", "key-a", "model-a", &action, now_ms)
            .expect("failure");
    }

    let unaffected_auth_key = store
        .scheduling_projection("provider-a", "key-b", "model-a", 1, 1, 900_103)
        .expect("unaffected auth key");
    let same_key_different_model = store
        .scheduling_projection("provider-a", "key-a", "model-b", 1, 1, 900_103)
        .expect("same key on another model");
    let cooled_key = store
        .scheduling_projection("provider-a", "key-a", "model-a", 1, 1, 900_103)
        .expect("cooled key");

    assert!(unaffected_auth_key.available);
    assert!(same_key_different_model.available);
    assert_eq!(same_key_different_model.score_milli, 1);
    assert!(!cooled_key.available);
}

fn typed_failure_fingerprint(status: u16) -> V3ProviderErrorFingerprint {
    V3ProviderErrorFingerprint::new(
        "recoverable_upstream",
        "recoverable_upstream",
        status,
        "recoverable_upstream",
    )
    .expect("typed fingerprint")
}

#[test]
fn different_recoverable_fingerprints_do_not_add_up_to_one_cooldown() {
    // Three *same* errors are required: recoverable failures with different typed
    // fingerprints each start their own consecutive-failure streak and must never
    // be summed into one cooldown.
    let store = V3ProviderKeyHealthStore::default();
    let mut action = V3ProviderFailureAction::recoverable("provider_http_error");
    action.failure_threshold = 3;

    for (offset, status) in [429_u16, 500, 502].into_iter().enumerate() {
        action.failure_fingerprint = Some(typed_failure_fingerprint(status));
        let projection = store
            .record_provider_failure_action(
                "provider-a",
                "key-a",
                "model-a",
                &action,
                100 + offset as u64,
            )
            .expect("recoverable failure");
        assert_eq!(projection.failure_streak, 1, "status={status}");
        assert!(
            !projection.cooldown,
            "a different fingerprint must not extend the streak: status={status}"
        );
        assert!(projection.cooldown_until_ms.is_none(), "status={status}");
        assert!(projection.available, "status={status}");
    }

    // The same fingerprint three times in a row still cools the exact identity.
    action.failure_fingerprint = Some(typed_failure_fingerprint(503));
    for now_ms in 200..202 {
        let projection = store
            .record_provider_failure_action("provider-a", "key-a", "model-a", &action, now_ms)
            .expect("same-fingerprint failure");
        assert!(!projection.cooldown, "now_ms={now_ms}");
        assert!(projection.available, "now_ms={now_ms}");
    }
    let third = store
        .record_provider_failure_action("provider-a", "key-a", "model-a", &action, 202)
        .expect("third same-fingerprint failure");
    assert_eq!(third.failure_streak, 3);
    assert!(third.cooldown, "three same-fingerprint failures must cool");
    assert!(!third.available);
}

// 生产 builder 身份回归：5xx 保留真实上游状态，500 与 502 不能共用一条
// 连续失败序列；没有上游状态的失败落到失败类别，不同类别同样不同源。
#[test]
fn production_failure_actions_keep_distinct_5xx_and_class_identities() {
    let store = V3ProviderKeyHealthStore::default();
    let server_error = build_v3_provider_global_error_fingerprint(500)
        .expect("500 fingerprint classification")
        .expect("500 must reach global health");
    let gateway_error = build_v3_provider_global_error_fingerprint(502)
        .expect("502 fingerprint classification")
        .expect("502 must reach global health");
    assert_ne!(server_error, gateway_error);

    let mut action = V3ProviderFailureAction::recoverable("provider_http_error");
    action.failure_threshold = 3;
    for (offset, status) in [0_u64, 1, 2].into_iter().zip([500_u16, 502, 500]) {
        action.failure_fingerprint = Some(
            build_v3_provider_global_error_fingerprint(status)
                .expect("fingerprint classification")
                .expect("status must reach global health"),
        );
        let projection = store
            .record_provider_failure_action("provider-a", "key-a", "model-a", &action, offset)
            .expect("alternating 5xx failure");
        assert_eq!(
            projection.failure_streak, 1,
            "alternating 500/502 must restart the streak: offset={offset}"
        );
        assert!(!projection.cooldown, "alternating 500/502 must never cool");
    }

    // 类别回退身份：本地 decode 失败与 request compat 失败没有上游状态，但
    // 类别不同，不能合并成一条 streak。
    let mut sse_decode = V3ProviderFailureAction::recoverable("provider.sse_decode");
    let mut compat = V3ProviderFailureAction::recoverable("provider_request_compat_error");
    sse_decode.failure_threshold = 3;
    compat.failure_threshold = 3;
    assert_ne!(sse_decode.failure_fingerprint, compat.failure_fingerprint);
    assert_eq!(
        sse_decode.failure_fingerprint.as_ref().unwrap().http_status,
        0
    );
    for (offset, action) in [(10_u64, &sse_decode), (11, &compat), (12, &sse_decode)] {
        let projection = store
            .record_provider_failure_action("provider-b", "key-b", "model-b", action, offset)
            .expect("mixed-class failure");
        assert_eq!(
            projection.failure_streak, 1,
            "mixed classes must restart the streak"
        );
        assert!(!projection.cooldown);
    }
}
