use routecodex_v3_error::V3ProviderFailureSessionScope;
use routecodex_v3_provider_responses::{
    V3ProviderFailureAction, V3ProviderFailureCooldownScope, V3ProviderFailurePolicy,
    V3ProviderHealthStore, V3ProviderKeyHealthStore, V3ProviderRecoveryKind,
    V3ProviderSchedulingProjection,
};

#[test]
fn recoverable_failures_lower_score_then_cool_on_third_failure() {
    let store = V3ProviderKeyHealthStore::default();
    let action = V3ProviderFailureAction::recoverable("transport");

    let first = store
        .record_provider_failure_action("provider-a", "key-a", "model-a", &action, 100)
        .expect("first failure");
    assert_eq!(first.score_milli, 950);
    assert_eq!(first.success_streak, 0);
    assert!(first.available);

    let second = store
        .record_provider_failure_action("provider-a", "key-a", "model-a", &action, 101)
        .expect("second failure");
    assert_eq!(second.score_milli, 900);
    assert!(!second.cooldown);

    let third = store
        .record_provider_failure_action("provider-a", "key-a", "model-a", &action, 102)
        .expect("third failure");
    assert_eq!(third.score_milli, 850);
    assert!(third.cooldown);
    assert!(!third.available);
}

#[test]
fn adaptive_provider_probe_starts_at_one_minute_after_three_same_key_failures() {
    let store = V3ProviderHealthStore::default();
    let session = V3ProviderFailureSessionScope::new("server-a", "group-a", "session-a")
        .expect("session scope");
    let policy = V3ProviderFailurePolicy {
        failure_threshold: 3,
        cooldown_ms: 60_000,
        probe_interval_ms: 60_000,
        until_restart: false,
        cooldown_scope: V3ProviderFailureCooldownScope::AuthKey,
    };
    for now_ms in 100..103 {
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
        vec![(
            "provider-a".into(),
            Some("key-a".into()),
            Some("model-a".into())
        )]
    );
}

#[test]
fn session_scoped_recoverable_failures_do_not_create_global_key_cooldown() {
    let store = V3ProviderKeyHealthStore::default();
    let action = V3ProviderFailureAction::recoverable_session("transport");
    for now_ms in 100..103 {
        store
            .record_provider_failure_action("provider-a", "key-a", "model-a", &action, now_ms)
            .expect("session-scoped failure");
    }

    let projection = store
        .scheduling_projection("provider-a", "key-a", "model-b", 1, 1, 103)
        .expect("session-scoped projection");
    assert_eq!(projection.score_milli, 1_000);
    assert!(projection.available);
    assert_eq!(projection.blocked_scopes, Vec::<String>::new());
}

#[test]
fn success_increases_score_but_probe_success_controls_cooldown_recovery() {
    let store = V3ProviderKeyHealthStore::default();
    let action = V3ProviderFailureAction::recoverable("transport");
    for now_ms in 100..103 {
        store
            .record_provider_failure_action("provider-a", "key-a", "model-a", &action, now_ms)
            .expect("failure");
    }

    let blocked_success = store
        .record_provider_success("provider-a", "key-a", "model-a", 103)
        .expect("success evidence");
    assert_eq!(blocked_success.score_milli, 860);
    assert_eq!(blocked_success.success_streak, 1);
    assert!(blocked_success.cooldown);
    assert!(!blocked_success.available);

    let recovered = store
        .complete_probe_success("provider-a", "key-a", "model-a", 104)
        .expect("probe success");
    assert!(recovered.available);
    assert!(recovered.score_milli >= 600);
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
        .record_provider_success("p", "k", "m", 101)
        .expect("success");
    assert_eq!(success.score_milli, 0);
    for now_ms in 102..202 {
        store
            .record_provider_success("p", "k", "m", now_ms)
            .expect("success");
    }
    let after = store
        .scheduling_projection("p", "k", "m", 100, 1, 202)
        .expect("projection");
    assert_eq!(after.score_milli, 1_500);
}

#[test]
fn successful_calls_cap_health_at_150() {
    let store = V3ProviderHealthStore::default();
    for now_ms in 0..100 {
        store
            .record_provider_success("p", "k", "m", now_ms)
            .expect("success");
    }
    assert_eq!(
        store
            .scheduling_projection("p", "k", "m", 100, 1, 100)
            .unwrap()
            .score_milli,
        1_500
    );
}

#[test]
fn success_streak_increments_and_failure_resets_it() {
    let store = V3ProviderKeyHealthStore::default();
    let first = store
        .record_provider_success("provider-a", "key-a", "model-a", 100)
        .unwrap();
    let second = store
        .record_provider_success("provider-a", "key-a", "model-a", 101)
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
fn health_adjusted_priority_favors_healthier_key_without_changing_weight() {
    let healthy =
        V3ProviderSchedulingProjection::new("provider-a", "key-a", "model-a", 1, 1000, 100);
    let degraded =
        V3ProviderSchedulingProjection::new("provider-b", "key-b", "model-b", 1, 500, 100);
    let lower_priority =
        V3ProviderSchedulingProjection::new("provider-c", "key-c", "model-c", 2, 1000, 100);

    assert_eq!(healthy.effective_weight_milli, degraded.effective_weight_milli);
    assert_eq!(healthy.priority, degraded.priority);
    assert!(healthy.effective_priority > degraded.effective_priority);
    assert!(lower_priority.priority > healthy.priority);
    assert!(lower_priority.effective_priority > healthy.effective_priority);
}

#[test]
fn health_adjusts_priority_around_the_configured_baseline() {
    let healthy = V3ProviderSchedulingProjection::new("provider-a", "key-a", "model-a", 10, 1_020, 1);
    let degraded = V3ProviderSchedulingProjection::new("provider-b", "key-b", "model-b", 10, 900, 1);

    assert_eq!(healthy.effective_priority, 30);
    assert_eq!(degraded.effective_priority, -90);
}

#[test]
fn score_zero_keeps_a_positive_minimum_scheduling_weight() {
    let projection = V3ProviderSchedulingProjection::new("provider-a", "key-a", "model-a", 1, 0, 7);
    assert_eq!(projection.effective_weight_milli, 7);
    assert!(projection.available);
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
    assert_eq!(result.score_milli, 1000);
    assert_eq!(result.score_generation, 0);
    assert!(!result.cooldown);
    assert!(result.available);
}

#[test]
fn cooldown_expiry_only_opens_probe_and_probe_failure_reschedules() {
    let store = V3ProviderKeyHealthStore::default();
    let action = V3ProviderFailureAction::recoverable("transport");
    for now_ms in 100..103 {
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
    for now_ms in 100..103 {
        store
            .record_provider_failure_action("provider-a", "key-a", "model-a", &recoverable, now_ms)
            .expect("recoverable failure");
    }
    let irrecoverable = V3ProviderFailureAction {
        recovery: V3ProviderRecoveryKind::IrrecoverableGlobalCooldown,
        scope: routecodex_v3_provider_responses::V3ProviderHealthScope::GlobalProviderKey,
        score_delta_milli: -400,
        failure_threshold: 1,
        cooldown_ms: 60_000,
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
        .provider_key_health_probe_keys(0, true)
        .expect("startup probe candidates");
    assert_eq!(
        startup_keys,
        vec![("provider-a".into(), "key-a".into(), "model-a".into())]
    );
    let permit = store
        .acquire_provider_key_health_probe("provider-a", "key-a", "model-a")
        .expect("probe acquisition")
        .expect("first probe owns key");
    assert!(store
        .acquire_provider_key_health_probe("provider-a", "key-a", "model-a")
        .expect("single-flight check")
        .is_none());
    store
        .complete_probe_success_at_generation(
            permit.provider_id(),
            permit.auth_alias(),
            permit.model_id(),
            104,
            Some(permit.expected_generation()),
        )
        .expect("probe success");
}

#[test]
fn stale_probe_generation_cannot_clear_newer_failure_state() {
    let store = V3ProviderKeyHealthStore::default();
    let action = V3ProviderFailureAction::recoverable("transport");
    let failed = store
        .record_provider_failure_action("provider-a", "key-a", "model-a", &action, 100)
        .expect("failure");
    store
        .record_provider_failure_action("provider-a", "key-a", "model-a", &action, 101)
        .expect("newer failure");
    let error = store
        .complete_probe_success_at_generation(
            "provider-a",
            "key-a",
            "model-a",
            102,
            Some(failed.score_generation),
        )
        .expect_err("stale probe must not clear newer state");
    assert!(error.contains("stale provider key health probe generation"));
}

#[test]
fn irrecoverable_action_enters_cooldown_on_first_failure() {
    let store = V3ProviderKeyHealthStore::default();
    let action = V3ProviderFailureAction {
        recovery: V3ProviderRecoveryKind::IrrecoverableGlobalCooldown,
        scope: routecodex_v3_provider_responses::V3ProviderHealthScope::GlobalProviderKey,
        score_delta_milli: -400,
        failure_threshold: 1,
        cooldown_ms: 60_000,
        class_code: "invalid_api_key".to_string(),
    };
    let result = store
        .record_provider_failure_action("provider-a", "key-a", "model-a", &action, 100)
        .expect("irrecoverable failure");
    assert!(result.cooldown);
    assert!(!result.available);
    assert_eq!(result.score_milli, 600);
}

#[test]
fn score_and_cooldown_are_isolated_per_provider_key_and_model() {
    let store = V3ProviderKeyHealthStore::default();
    let action = V3ProviderFailureAction::recoverable("transport");
    for now_ms in 100..103 {
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
    assert_eq!(same_key_different_model.score_milli, 1_000);
    assert!(!cooled_key.available);
}
