use routecodex_v3_config::{compile_v3_config_05_manifest, parse_v3_config_02_authoring};
use routecodex_v3_error::V3ProviderFailureSessionScope;
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
        "one thresholded failure must not cool down a low-priority key"
    );
    assert!(first.available);
    assert!(store
        .provider_cooldown_probe_keys(100, false)
        .expect("probe keys after first failure")
        .is_empty());
    let first_scheduling = store
        .scheduling_projection("p", "a", "m", 1, 1, 100)
        .expect("first scheduling projection");
    assert!(
        first_scheduling.available,
        "score zero without a cooldown must remain schedulable"
    );
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
fn recoverable_failures_lower_score_then_cool_at_zero() {
    let store = V3ProviderKeyHealthStore::default();
    let action = V3ProviderFailureAction::recoverable("transport");

    let first = store
        .record_provider_failure_action("provider-a", "key-a", "model-a", &action, 100)
        .expect("first failure");
    assert_eq!(first.score_milli, 95);
    assert_eq!(first.success_streak, 0);
    assert!(first.available);

    let second = store
        .record_provider_failure_action("provider-a", "key-a", "model-a", &action, 101)
        .expect("second failure");
    assert_eq!(second.score_milli, 90);
    assert!(!second.cooldown);

    for now_ms in 102..120 {
        store
            .record_provider_failure_action("provider-a", "key-a", "model-a", &action, now_ms)
            .expect("recoverable failure");
    }
    let twentieth = store
        .record_provider_failure_action("provider-a", "key-a", "model-a", &action, 120)
        .expect("twentieth failure");
    assert_eq!(twentieth.score_milli, 0);
    assert!(twentieth.cooldown);
    assert!(!twentieth.available);
}

#[test]
fn fixed_probe_ladder_starts_at_30s_after_three_same_key_failures() {
    let store = V3ProviderHealthStore::default();
    let session = V3ProviderFailureSessionScope::new("server-a", "group-a", "session-a")
        .expect("session scope");
    let policy = V3ProviderFailurePolicy {
        failure_threshold: 3,
        cooldown_ms: 60_000,
        probe_interval_ms: 60_000,
        long_probe_backoff: false,
        until_restart: false,
        cooldown_scope: V3ProviderFailureCooldownScope::AuthKey,
    };
    for now_ms in 100..120 {
        store
            .record_provider_failure_in_session_with_policy(
                &session,
                "provider-a",
                Some("key-a"),
                Some("model-a"),
                Some("transport"),
                now_ms,
                Some(policy),
            )
            .expect("same-key failure");
    }

    assert!(store
        .provider_cooldown_probe_keys_due(60_101)
        .expect("probe due query")
        .is_empty());
    assert_eq!(
        store
            .provider_cooldown_probe_keys_due(60_102)
            .expect("probe due query"),
        vec![("provider-a".into(), Some("key-a".into()), None,)]
    );
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
fn key_success_revives_global_cooldown_immediately() {
    let store = V3ProviderKeyHealthStore::default();
    let action = V3ProviderFailureAction::recoverable("transport");
    for now_ms in 100..120 {
        store
            .record_provider_failure_action("provider-a", "key-a", "model-a", &action, now_ms)
            .expect("failure");
    }

    // 全局复活契约（bug 61863a0）：冷却中的 key 收到真实成功调用时必须立即
    // 解除全局冷却并清理探针状态，其余 session 不必等探针周期；探针成功
    // （complete_probe_success）仍是无人成功调用时的恢复路径。
    let revived = store
        .record_provider_key_success("provider-a", "key-a", "model-a", 103)
        .expect("success revival");
    assert!(revived.available, "success must clear global cooldown");
    assert!(!revived.cooldown);
    assert_eq!(revived.success_streak, 1);
    assert_eq!(revived.score_milli, 100);

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
    // 成功即全局复活（bug 61863a0）：分数重置回 configured_priority 基线，
    // 窗口同时清空；后续 100 次成功仍只按最近 100 次调用计分。
    assert_eq!(success.score_milli, 100);
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
fn one_502_does_not_enter_cooldown() {
    let store = V3ProviderHealthStore::default();
    store
        .scheduling_projection("p", "k", "m", 100, 1, 100)
        .expect("initial projection");
    let result = store
        .record_provider_failure_action(
            "p",
            "k",
            "m",
            &V3ProviderFailureAction::recoverable("provider_502"),
            101,
        )
        .expect("502 failure");
    assert!(!result.cooldown);
    assert_eq!(
        store
            .scheduling_projection("p", "k", "m", 100, 1, 102)
            .unwrap()
            .score_milli,
        95
    );
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
    let error = store
        .complete_probe_success_at_generation(
            "provider-a",
            "key-a",
            "model-a",
            104,
            Some(permit.expected_generation()),
        )
        .expect_err("stale probe must not clear newer state");
    assert!(error.contains("stale provider key health probe generation"));
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

    let error = store
        .complete_provider_cooldown_probe_failure_at_generation(
            "provider-a",
            Some("key-a"),
            Some("model-a"),
            104,
            Some(permit.expected_generation()),
        )
        .expect_err("stale failed probe must not mutate newer state");
    assert!(error
        .to_string()
        .contains("stale provider health probe generation"));
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
