use super::*;
use routecodex_v3_error::{V3ExternalErrorKind, V3ExternalErrorLink, V3ProviderRecoveryKind};

fn source(kind: V3ErrorSourceKind, code: &str, status: u16) -> V3Error01SourceRaised {
    if kind == V3ErrorSourceKind::RuntimeFailure {
        return routecodex_v3_error::build_v3_error_01_source_raised_internal(
            kind,
            "V3DirectResp14ProviderProjectionPrepared",
            code,
            "local response codec failure",
            routecodex_v3_error::V3InternalErrorCode::V3DirectResp14ProviderProjectionPrepared,
        );
    }
    build_v3_error_01_source_raised_external(
        kind,
        "V3ProviderRespInbound01Raw",
        code,
        "truthful failure",
        V3ExternalErrorLink {
            kind: V3ExternalErrorKind::Provider,
            status: Some(status),
            code: Some(code.to_string()),
            provider_id: Some("first".to_string()),
            upstream_request_id: None,
            message: None,
        },
    )
}

#[test]
fn rate_limit_failure_record_carries_revision_at_its_health_transition() {
    let manifest = global_pool_alive_manifest("failure_revision_snapshot");
    let health = V3ProviderFailureRuntimeHealth::from_manifest_for_isolated_tests(&manifest);
    let scope = test_provider_failure_scope("failure_revision_snapshot", "failure_revision_snapshot", "s").unwrap();
    let store = health.store();
    store.record_provider_key_success("first", "key1", "gpt-test", 100).unwrap();
    let failure = source(V3ErrorSourceKind::ProviderFailure, "provider_http_429", 429);
    let record = health.record_provider_failure_record_from_source(
        &scope, "first", Some("key1"), Some("gpt-test"), &failure, 101,
    ).unwrap();
    assert_eq!(record.recovery_success_revision, Some(1));
    store.record_provider_key_success("first", "key1", "gpt-test", 102).unwrap();
    assert_eq!(store.recovery_success_revision_for_interface("first", "default", "key1", "gpt-test").unwrap(), 2);
    assert_eq!(record.recovery_success_revision, Some(1), "later success must not rewrite the failure witness");
}

#[test]
fn matching_business_success_restores_only_its_429_identity() {
    let manifest = global_pool_alive_manifest("business_success_429_identity");
    let health = V3ProviderFailureRuntimeHealth::from_manifest_for_isolated_tests(&manifest);
    let scope = test_provider_failure_scope("business_success_429_identity", "business_success_429_identity", "s").unwrap();
    let failure = source(V3ErrorSourceKind::ProviderFailure, "provider_http_429", 429);
    for now in [100, 101, 102] {
        for key in ["key1", "key2"] {
            health.record_provider_failure_record_from_source(
                &scope, "first", Some(key), Some("gpt-test"), &failure, now,
            ).unwrap();
        }
    }
    let session = health.session_bound_availability(&scope);
    assert!(!session.availability("first", Some("key1"), Some("gpt-test"), 103).unwrap().available);
    assert!(!session.availability("first", Some("key2"), Some("gpt-test"), 103).unwrap().available);
    health.record_provider_success_in_failure_scope_for_interface(
        &crate::nodes::V3AttemptSuccessReceipt::from_buffered_terminal_attempt(),
        &scope, "first", "default", Some("key1"), Some("gpt-test"), 103,
    ).unwrap();
    assert!(session.availability("first", Some("key1"), Some("gpt-test"), 104).unwrap().available);
    assert!(!session.availability("first", Some("key2"), Some("gpt-test"), 104).unwrap().available);
}

#[test]
fn early_429_retains_diagnostics_without_health_cooldown() {
    let mut manifest = global_pool_alive_manifest("no_first_failure_counted");
    normalize_global_pool_priorities(&mut manifest);
    let health = V3ProviderFailureRuntimeHealth::from_manifest_for_isolated_tests(&manifest);
    let scope =
        test_provider_failure_scope("no_first_failure_counted", "no_first_failure_counted", "s")
            .unwrap();
    let failure = source(V3ErrorSourceKind::ProviderFailure, "provider_http_429", 429);
    let first_failure = health
        .record_provider_failure_record_from_source(
            &scope,
            "first",
            Some("key1"),
            Some("gpt-test"),
            &failure,
            100,
        )
        .unwrap();
    // The early 429 window is capacity backpressure. The returned record must
    // stay neutral with streak 0 instead of counting a provider failure.
    assert_eq!(first_failure.failure_count, 0);
    assert_eq!(first_failure.state, "rate_limit_capacity_wait");
    assert_eq!(first_failure.cooldown_until_ms, None);
    let recovered_by_business = health
        .store()
        .record_provider_key_success("first", "key1", "gpt-test", 101)
        .unwrap();
    assert_eq!(
        recovered_by_business.failure_streak, 0,
        "429 backpressure must not leave a provider failure streak"
    );
    health
        .store()
        .record_provider_success_in_session(&scope, "first", Some("key1"), Some("gpt-test"), 101)
        .unwrap();
    assert!(
        health
            .availability("first", Some("key1"), Some("gpt-test"), 101)
            .unwrap()
            .available,
        "a business success before any cooldown must leave the exact identity eligible"
    );
    for now_ms in 102..=103 {
        let record = health
            .record_provider_failure_record_from_source(
                &scope,
                "first",
                Some("key1"),
                Some("gpt-test"),
                &failure,
                now_ms,
            )
            .unwrap();
        assert_eq!(
            record.failure_count, 0,
            "repeated 429s inside the early window must keep streak 0"
        );
        assert_eq!(record.state, "rate_limit_capacity_wait");
        assert_eq!(
            health
                .availability("first", Some("key1"), Some("gpt-test"), now_ms)
                .unwrap()
                .available,
            true
        );
    }
    assert!(
        health
            .availability("first", Some("key1"), Some("gpt-test"), 102)
            .unwrap()
            .available
    );
    assert!(
        health
            .availability("first", Some("key2"), Some("gpt-test"), 102)
            .unwrap()
            .available
    );
    assert!(
        health
            .availability("first", Some("key1"), Some("other"), 102)
            .unwrap()
            .available
    );
    assert!(
        health
            .availability("second", Some("key1"), Some("gpt-test"), 102)
            .unwrap()
            .available
    );
    assert!(
        health
            .store()
            .provider_cooldown_probe_keys_due(103)
            .unwrap()
            .is_empty(),
        "429 backpressure must not create a cooldown probe"
    );
    health.record_provider_success_in_failure_scope_for_interface(
        &crate::nodes::V3AttemptSuccessReceipt::from_buffered_terminal_attempt(),
        &scope, "first", "default", Some("key1"), Some("gpt-test"), 104,
    ).unwrap();
    assert!(
        health
            .availability("first", Some("key1"), Some("gpt-test"), 5_105)
            .unwrap()
            .available
    );
    let after_recovery = health
        .record_provider_failure_record_from_source(
            &scope,
            "first",
            Some("key1"),
            Some("gpt-test"),
            &failure,
            5_106,
        )
        .unwrap();
    // This source wrapper retains request/session error bookkeeping even though
    // provider health stays routable and never needs a recovery probe.
    assert_eq!(after_recovery.failure_count, 0);
    assert_eq!(after_recovery.state, "rate_limit_capacity_wait");
    assert!(
        health
            .availability("first", Some("key1"), Some("gpt-test"), 5_106)
            .unwrap()
            .available
    );
}

#[test]
fn no_first_failure_local_response_source_never_becomes_transport_health() {
    let mut manifest = global_pool_alive_manifest("no_first_failure_local");
    normalize_global_pool_priorities(&mut manifest);
    let health = V3ProviderFailureRuntimeHealth::from_manifest_for_isolated_tests(&manifest);
    let scope =
        test_provider_failure_scope("no_first_failure_local", "no_first_failure_local", "s")
            .unwrap();
    let local = source(
        V3ErrorSourceKind::RuntimeFailure,
        "provider_response_event_codec_failure",
        502,
    );
    let classified = build_v3_error_02_classified_from_v3_error_01(local.clone());
    let action = apply_v3_internal_provider_failure_policy(
        build_v3_provider_failure_action_from_v3_error_02(&classified),
        local.source_stage,
        502,
        &local.code,
    );
    assert_eq!(action.recovery, V3ProviderRecoveryKind::NotProviderHealth);
    assert_eq!(action.scope, V3ProviderHealthScope::None);
    for now in 100..104 {
        health
            .record_provider_failure_record_from_source(
                &scope,
                "first",
                Some("key1"),
                Some("gpt-test"),
                &local,
                now,
            )
            .unwrap();
        health
            .record_post_commit_provider_stream_failure_from_source(
                &scope,
                "first",
                Some("key1"),
                Some("gpt-test"),
                &local,
            )
            .unwrap();
    }
    assert!(
        health
            .availability("first", Some("key1"), Some("gpt-test"), 104)
            .unwrap()
            .available
    );
    assert!(health
        .store()
        .provider_cooldown_probe_keys(104, false)
        .unwrap()
        .is_empty());
    let projection = health
        .store()
        .record_provider_key_success("first", "key1", "gpt-test", 105)
        .unwrap();
    assert_eq!(projection.success_streak, 1);
    assert_eq!(
        projection.score_milli, 101,
        "local codec failure must not mutate provider score"
    );
}

#[test]
fn irrecoverable_quota_and_auth_follow_global_ten_error_threshold() {
    for (status, code) in [(401, "invalid_api_key"), (403, "account_disabled")] {
        let failure = source(V3ErrorSourceKind::ProviderFailure, code, status);
        let classified = build_v3_error_02_classified_from_v3_error_01(failure);
        let action = apply_v3_internal_provider_failure_policy(
            build_v3_provider_failure_action_from_v3_error_02(&classified),
            classified.source.source_stage,
            status,
            code,
        );
        assert_eq!(
            action.recovery,
            V3ProviderRecoveryKind::IrrecoverableGlobalCooldown
        );
        let store = V3ProviderHealthStore::default();
        for now in 100..109 {
            store.record_real_provider_failure_for_interface("p", "default", "k", "m", Some(status), now).unwrap();
            assert!(store.availability("p", Some("k"), Some("m"), now).unwrap().available,
                "a real failure before the tenth must not globally cool {code}");
        }
        store.record_real_provider_failure_for_interface("p", "default", "k", "m", Some(status), 109).unwrap();
        assert!(!store.availability("p", Some("k"), Some("m"), 109).unwrap().available,
            "the tenth real failure must globally cool {code}");
        assert!(store.availability("p", Some("other"), Some("m"), 109).unwrap().available);
    }
}

#[test]
fn early_quota_429_stays_health_neutral_before_and_after_business_success() {
    let store = V3ProviderHealthStore::default();
    let failure = source(
        V3ErrorSourceKind::ProviderFailure,
        "insufficient_quota",
        429,
    );
    let classified = build_v3_error_02_classified_from_v3_error_01(failure);
    let action = apply_v3_internal_provider_failure_policy(
        build_v3_provider_failure_action_from_v3_error_02(&classified),
        classified.source.source_stage,
        429,
        "insufficient_quota",
    );
    assert_eq!(
        action.recovery,
        V3ProviderRecoveryKind::HealthNeutralTransient
    );
    assert_eq!(action.failure_threshold, 0);
    for time in 100..102 {
        assert_eq!(
            store
                .record_provider_failure_action("p", "k", "m", &action, time)
                .unwrap()
                .cooldown,
            false
        );
    }
    assert!(store.record_provider_failure_action("p", "k", "m", &action, 102).unwrap().cooldown);
    assert!(
        store
            .record_provider_key_success("p", "k", "m", 106)
            .unwrap()
            .available
    );
}

// Latest direct user contract: after one or two real HTTP 429, other
// independent requests (same session and different session) must remain
// eligible for that exact identity. The failed request paces its own retry.
// Third consecutive real 429 enters the exact-identity health cooldown.
// This red test records one real typed 429 through the actual failure-policy
// path, then proves a new same-session and a new different-session request can
// still select/admit the same identity before the old shared 1000ms delay
// expires. The current implementation returns Blocked, which is the intended
// behavioral red: no soft single-429 gate may block independent requests.
#[tokio::test]
async fn single_real_429_must_not_block_independent_request_admission() {
    let scope_label = "no_soft_cooldown_admission";
    let manifest = transport_thrash_manifest(scope_label);
    let health = V3ProviderFailureRuntimeHealth::from_manifest_for_isolated_tests(&manifest);
    let failed_scope = test_provider_failure_scope(scope_label, scope_label, "failed-session")
        .expect("failed-session scope");
    let selected = match resolve_target(&manifest, scope_label, &BTreeSet::new(), &health) {
        V3RelayProviderTargetResolution::Selected(selected) => selected,
        _ => panic!("valid fixture must select the failed provider"),
    };
    assert_eq!(selected.candidate.provider_id, "first");
    assert_eq!(selected.candidate.auth_alias, "key1");
    let candidate = selected.candidate.clone();
    let target = V3TargetInterpreter::default();
    let captured_target_09 = target
        .expand_candidates(&manifest, target.classify_kind(selected.route.clone()), 0)
        .expect("capture Target09 before execution");
    let context = V3RelayProviderFailurePolicyContext {
        manifest: &manifest,
        captured_target_09: Some(&captured_target_09),
        attempt_budget: None,
        failure_session_scope: failed_scope.clone(),
        provider_health: &health,
        retry_policy: V3RelayProviderFailureRetryPolicy::default(),
        deterministic_sample: 0,
    };
    let mut failed_candidates = BTreeSet::new();
    let mut same_candidate_retries = BTreeMap::new();
    let mut trace = Vec::new();
    let mut last_external_http = None;
    let result = run_v3_relay_provider_failure_policy(
        &context,
        selected,
        "V3ProviderRespInbound01Raw",
        429,
        Some("provider_http_429".to_string()),
        "rate limited by upstream".to_string(),
        None,
        &mut V3RelayProviderFailurePolicyState {
            failed_candidates: &mut failed_candidates,
            same_candidate_retries: &mut same_candidate_retries,
            trace: &mut trace,
            last_external_http: &mut last_external_http,
        },
    )
    .await
    .expect("one real typed 429 must enter the Relay failure policy");
    assert_eq!(
        result.event.action, "switch_provider",
        "the 429 must reach the reselection branch"
    );
    assert!(
        health
            .availability(
                &candidate.provider_id,
                Some(&candidate.auth_alias),
                Some(&candidate.model_id),
                2,
            )
            .unwrap()
            .available,
        "one real 429 must stay capacity-neutral in provider health"
    );
    let same_session =
        test_provider_failure_scope(scope_label, scope_label, "failed-session").expect("same scope");
    let different_session =
        test_provider_failure_scope(scope_label, scope_label, "other-session").expect("other scope");
    for scope in [&same_session, &different_session] {
        let selection = resolve_target_for_scope(&manifest, scope_label, &BTreeSet::new(), &health, scope, 2);
        let V3RelayProviderTargetResolution::Selected(selected) = selection else {
            panic!("a new request must still select the healthy identity");
        };
        assert_eq!(selected.candidate.provider_id, candidate.provider_id);
        assert_eq!(selected.candidate.auth_alias, candidate.auth_alias);
    }
}

#[test]
fn ordinary_error_does_not_gate_new_request_in_same_session() {
    let label = "ordinary_request_independence";
    let manifest = transport_thrash_manifest(label);
    let health = V3ProviderFailureRuntimeHealth::from_manifest_for_isolated_tests(&manifest);
    let scope = test_provider_failure_scope(label, label, "same-session").unwrap();
    let selected = match resolve_target(&manifest, label, &BTreeSet::new(), &health) {
        V3RelayProviderTargetResolution::Selected(selected) => selected,
        _ => panic!("fixture must select a provider"),
    };
    let candidate = selected.candidate;
    let failure = source(V3ErrorSourceKind::ProviderFailure, "provider_http_error", 500);
    health.record_provider_failure_record_from_source(
        &scope, &candidate.provider_id, Some(&candidate.auth_alias), Some(&candidate.model_id),
        &failure, 100,
    ).unwrap();
    assert!(health.session_bound_availability(&scope).availability_for_interface(
        &candidate.provider_id, &candidate.interface_id, Some(&candidate.auth_alias),
        Some(&candidate.model_id), 101,
    ).unwrap().available, "another request must not inherit a pending observation");
    let selection = resolve_target_for_scope(&manifest, label, &BTreeSet::new(), &health, &scope, 101);
    let V3RelayProviderTargetResolution::Selected(selected) = selection else {
        panic!("another request must still select an eligible candidate");
    };
    assert_eq!(selected.candidate.provider_id, candidate.provider_id);
}

#[test]
fn three_session_429s_cool_only_that_session_for_ten_seconds() {
    let mut manifest = global_pool_alive_manifest("session_429_scope");
    normalize_global_pool_priorities(&mut manifest);
    let health = V3ProviderFailureRuntimeHealth::from_manifest_for_isolated_tests(&manifest);
    let session_a = test_provider_failure_scope("listener", "route", "session-a").unwrap();
    let session_b = test_provider_failure_scope("listener", "route", "session-b").unwrap();
    let failure = source(V3ErrorSourceKind::ProviderFailure, "provider_http_429", 429);
    let mut last = None;
    for now_ms in [100, 101, 102] {
        last = Some(health.record_provider_failure_record_from_source(
            &session_a, "first", Some("key1"), Some("gpt-test"), &failure, now_ms,
        ).unwrap());
        if now_ms < 102 {
            assert!(health.session_bound_availability(&session_a)
                .availability("first", Some("key1"), Some("gpt-test"), now_ms).unwrap().available);
        }
    }
    let session_b_health = health.session_bound_availability(&session_b)
        .availability("first", Some("key1"), Some("gpt-test"), 102)
        .unwrap();
    assert!(session_b_health.available,
        "another session must not inherit the observed session's cooldown: {session_b_health:?}");
    assert!(!health.session_bound_availability(&session_a)
        .availability("first", Some("key1"), Some("gpt-test"), 102).unwrap().available);
    assert_eq!(last.unwrap().cooldown_until_ms, Some(10_102));
    for now_ms in [103, 104, 105] {
        health.record_provider_failure_record_from_source(
            &session_b, "first", Some("key1"), Some("gpt-test"), &failure, now_ms,
        ).unwrap();
    }
    health.record_provider_success_in_failure_scope_for_interface(
        &crate::nodes::V3AttemptSuccessReceipt::from_buffered_terminal_attempt(),
        &session_a, "first", "default", Some("key1"), Some("gpt-test"), 106,
    ).unwrap();
    assert!(health.session_bound_availability(&session_a)
        .availability("first", Some("key1"), Some("gpt-test"), 106).unwrap().available,
        "matching success must restore the session that succeeded");
    assert!(health.session_bound_availability(&session_b)
        .availability("first", Some("key1"), Some("gpt-test"), 106).unwrap().available,
        "real success for the identity must restore it in other sessions");
}

#[test]
fn successful_session_probe_recovers_same_identity_in_other_sessions() {
    let mut manifest = global_pool_alive_manifest("session_probe_cross_recovery");
    normalize_global_pool_priorities(&mut manifest);
    let health = V3ProviderFailureRuntimeHealth::from_manifest_for_isolated_tests(&manifest);
    let a = test_provider_failure_scope("listener", "route", "session-a").unwrap();
    let b = test_provider_failure_scope("listener", "route", "session-b").unwrap();
    let failure = source(V3ErrorSourceKind::ProviderFailure, "provider_http_429", 429);
    for now_ms in 100..103 {
        for scope in [&a, &b] {
            health.record_provider_failure_record_from_source(
                scope, "first", Some("key1"), Some("gpt-test"), &failure, now_ms,
            ).unwrap();
        }
    }
    let key = health.store().provider_cooldown_scoped_probe_keys(10_102, false).unwrap()
        .into_iter().find(|key| key.scope ==
            routecodex_v3_provider_responses::V3ProviderCooldownHealthScope::from_session(&a))
        .expect("session A cooldown must have a due probe");
    let permit = health.store().acquire_provider_cooldown_probe_for_key(&key, Some(10_102), false)
        .unwrap().expect("session A probe must be acquired");
    assert!(health.store().complete_provider_cooldown_probe_success_if_current_with_permit(
        &permit, 10_102,
    ).unwrap());
    assert!(health.session_bound_availability(&b)
        .availability("first", Some("key1"), Some("gpt-test"), 10_102).unwrap().available,
        "a valid probe success must restore the same identity across sessions");
}

#[tokio::test]
async fn issue44cc3af_migrated_probe_restores_identity_after_ordinary_failure() {
    let mut manifest = global_pool_alive_manifest("cooldown_probe_precool_recovery");
    normalize_global_pool_priorities(&mut manifest);
    let health = V3ProviderFailureRuntimeHealth::from_manifest_for_isolated_tests(&manifest);
    let a = test_provider_failure_scope("listener", "route", "session-a").unwrap();
    let b = test_provider_failure_scope("listener", "route", "session-b").unwrap();
    let ordinary = source(V3ErrorSourceKind::ProviderFailure, "provider_http_error", 500);
    health.record_provider_failure_record_from_source(
        &a, "first", Some("key1"), Some("gpt-test"), &ordinary, 100,
    ).unwrap();
    let rate_limit = source(V3ErrorSourceKind::ProviderFailure, "provider_http_429", 429);
    for now_ms in 101..104 {
        health.record_provider_failure_record_from_source(
            &b, "first", Some("key1"), Some("gpt-test"), &rate_limit, now_ms,
        ).unwrap();
    }
    assert!(!health.session_bound_availability(&b)
        .availability("first", Some("key1"), Some("gpt-test"), 103).unwrap().available);
    let key = health.store().provider_cooldown_scoped_probe_keys(10_103, false).unwrap()
        .into_iter().find(|key| key.scope ==
            routecodex_v3_provider_responses::V3ProviderCooldownHealthScope::from_session(&b))
        .expect("session B cooldown must have a due probe");
    let permit = health.store().acquire_provider_cooldown_probe_for_key(&key, Some(10_103), false)
        .unwrap().unwrap();
    let cancellation = V3ProviderProbeCancellationGuard { store: health.store.clone(), permit };
    assert!(matches!(complete_v3_provider_health_probe(&cancellation, &health, Ok(()), 10_103).unwrap(),
        V3ProbeCompletion::Recovered));
    assert!(health.session_bound_availability(&b)
        .availability("first", Some("key1"), Some("gpt-test"), 10_103).unwrap().available,
        "successful identity probe must restore the cooled session");
}

#[test]
fn burst_429_needs_new_failure_after_two_minutes_to_cool_globally() {
    let mut manifest = global_pool_alive_manifest("session_429_global_escalation");
    normalize_global_pool_priorities(&mut manifest);
    let health = V3ProviderFailureRuntimeHealth::from_manifest_for_isolated_tests(&manifest);
    let session_a = test_provider_failure_scope("listener", "route", "session-a").unwrap();
    let session_b = test_provider_failure_scope("listener", "route", "session-b").unwrap();
    let failure = source(V3ErrorSourceKind::ProviderFailure, "provider_http_429", 429);
    for now_ms in 100..110 {
        health.record_provider_failure_record_from_source(
            &session_a, "first", Some("key1"), Some("gpt-test"), &failure, now_ms,
        ).unwrap();
        assert!(health.session_bound_availability(&session_b)
            .availability("first", Some("key1"), Some("gpt-test"), now_ms).unwrap().available,
            "a burst within two minutes must not trigger global cooldown");
    }
    assert!(health.session_bound_availability(&session_b)
        .availability("first", Some("key1"), Some("gpt-test"), 120_101).unwrap().available,
        "time alone must not trigger global cooldown");
    health.record_provider_failure_record_from_source(
        &session_a, "first", Some("key1"), Some("gpt-test"), &failure, 120_101,
    ).unwrap();
    assert!(!health.session_bound_availability(&session_b)
        .availability("first", Some("key1"), Some("gpt-test"), 120_101).unwrap().available,
        "a new real 429 after ten errors and two minutes must cool globally");
    health.record_provider_success_in_failure_scope_for_interface(
        &crate::nodes::V3AttemptSuccessReceipt::from_buffered_terminal_attempt(),
        &session_b, "first", "default", Some("key1"), Some("gpt-test"), 120_102,
    ).unwrap();
    assert!(health.session_bound_availability(&session_a)
        .availability("first", Some("key1"), Some("gpt-test"), 120_102).unwrap().available,
        "a real identity success must promptly restore all sessions");
}

#[test]
fn mixed_real_errors_cool_identity_globally_only_at_ten() {
    let mut manifest = global_pool_alive_manifest("global_mixed_errors");
    normalize_global_pool_priorities(&mut manifest);
    let health = V3ProviderFailureRuntimeHealth::from_manifest_for_isolated_tests(&manifest);
    let a = test_provider_failure_scope("listener", "route", "session-a").unwrap();
    let b = test_provider_failure_scope("listener", "route", "session-b").unwrap();
    for (index, status) in [500, 503, 502, 400, 401, 402, 500, 503, 502, 400].into_iter().enumerate() {
        let scope = if index % 2 == 0 { &a } else { &b };
        let failure = source(V3ErrorSourceKind::ProviderFailure, "provider_http_error", status);
        health.record_provider_failure_record_from_source(
            scope, "first", Some("key1"), Some("gpt-test"), &failure, 100 + index as u64,
        ).unwrap();
        if index < 9 {
            let other = test_provider_failure_scope("listener", "route", "untried").unwrap();
            assert!(health.session_bound_availability(&other)
                .availability("first", Some("key1"), Some("gpt-test"), 100 + index as u64).unwrap().available,
                "fewer than ten real errors must not globally cool the identity: {index}");
        }
    }
    let other = test_provider_failure_scope("listener", "route", "untried").unwrap();
    assert!(!health.session_bound_availability(&other)
        .availability("first", Some("key1"), Some("gpt-test"), 109).unwrap().available,
        "ten mixed real errors must globally cool the exact identity");
}

#[test]
fn transport_failures_count_without_inventing_an_http_status() {
    let mut manifest = global_pool_alive_manifest("global_transport_errors");
    normalize_global_pool_priorities(&mut manifest);
    let health = V3ProviderFailureRuntimeHealth::from_manifest_for_isolated_tests(&manifest);
    let scope = test_provider_failure_scope("listener", "route", "untried").unwrap();
    let mut transport = source(V3ErrorSourceKind::ProviderFailure, "transport_error", 502);
    let external = transport.external_error.as_mut().unwrap();
    external.kind = V3ExternalErrorKind::Transport;
    external.status = None;
    for now_ms in 100..109 {
        health.record_real_provider_error_for_interface(
            "first", "default", Some("key1"), Some("gpt-test"), &transport, now_ms,
        ).unwrap();
    }
    let local = source(V3ErrorSourceKind::RuntimeFailure, "local_error", 599);
    health.record_real_provider_error_for_interface(
        "first", "default", Some("key1"), Some("gpt-test"), &local, 109,
    ).unwrap();
    assert!(health.session_bound_availability(&scope)
        .availability("first", Some("key1"), Some("gpt-test"), 109).unwrap().available);
    health.record_real_provider_error_for_interface(
        "first", "default", Some("key1"), Some("gpt-test"), &transport, 110,
    ).unwrap();
    assert!(!health.session_bound_availability(&scope)
        .availability("first", Some("key1"), Some("gpt-test"), 110).unwrap().available);
}

#[test]
fn invalid_and_success_http_statuses_do_not_count_as_real_errors() {
    let mut manifest = global_pool_alive_manifest("global_status_provenance");
    normalize_global_pool_priorities(&mut manifest);
    let health = V3ProviderFailureRuntimeHealth::from_manifest_for_isolated_tests(&manifest);
    let scope = test_provider_failure_scope("listener", "route", "observer").unwrap();
    for now_ms in 100..110 {
        for status in [0, 200] {
            health.store().record_real_provider_failure_for_interface(
                "first", "default", "key1", "gpt-test", Some(status), now_ms,
            ).unwrap();
        }
    }
    for now_ms in 110..119 {
        health.store().record_real_provider_failure_for_interface(
            "first", "default", "key1", "gpt-test", Some(503), now_ms,
        ).unwrap();
    }
    assert!(health.session_bound_availability(&scope)
        .availability("first", Some("key1"), Some("gpt-test"), 118).unwrap().available);
    health.store().record_real_provider_failure_for_interface(
        "first", "default", "key1", "gpt-test", Some(302), 119,
    ).unwrap();
    assert!(!health.session_bound_availability(&scope)
        .availability("first", Some("key1"), Some("gpt-test"), 119).unwrap().available,
        "a real non-2xx HTTP response is the tenth error");
}

#[test]
fn issue44cc3af_non429_failure_recorded_without_observation_gate() {
    let mut manifest = global_pool_alive_manifest("immediate_non429_observation");
    normalize_global_pool_priorities(&mut manifest);
    let health = V3ProviderFailureRuntimeHealth::from_manifest_for_isolated_tests(&manifest);
    let scope = test_provider_failure_scope("listener", "route", "session-a").unwrap();
    let failure = source(V3ErrorSourceKind::ProviderFailure, "provider_http_error", 500);
    let record = health.record_provider_failure_record_from_source(
        &scope, "first", Some("key1"), Some("gpt-test"), &failure, 100,
    ).unwrap();
    assert_eq!(record.failure_count, 1, "the real failure must be recorded immediately");
    assert_ne!(record.state, "pre_cool_observation", "health accounting must not await a gate");
    assert!(health.session_bound_availability(&scope)
        .availability("first", Some("key1"), Some("gpt-test"), 100).unwrap().available,
        "a single failure must not globally cool the identity");
}

#[test]
fn issue44cc3af_non_429_interrupts_session_429_streak_immediately() {
    let mut manifest = global_pool_alive_manifest("immediate_health_observation");
    normalize_global_pool_priorities(&mut manifest);
    let health = V3ProviderFailureRuntimeHealth::from_manifest_for_isolated_tests(&manifest);
    let scope = test_provider_failure_scope("listener", "route", "session-a").unwrap();
    for (offset, status) in [429, 429, 500, 429].into_iter().enumerate() {
        let failure = source(V3ErrorSourceKind::ProviderFailure, "provider_http_error", status);
        health.record_provider_failure_record_from_source(
            &scope, "first", Some("key1"), Some("gpt-test"), &failure, 100 + offset as u64,
        ).unwrap();
    }
    assert!(health.session_bound_availability(&scope)
        .availability("first", Some("key1"), Some("gpt-test"), 103).unwrap().available,
        "a real non-429 between 429 responses must immediately interrupt their consecutive streak");
}

#[test]
fn issue44cc3af_non_429_does_not_interrupt_other_session_429_streak() {
    let mut manifest = global_pool_alive_manifest("independent_health_observation");
    normalize_global_pool_priorities(&mut manifest);
    let health = V3ProviderFailureRuntimeHealth::from_manifest_for_isolated_tests(&manifest);
    let a = test_provider_failure_scope("listener", "route", "session-a").unwrap();
    let b = test_provider_failure_scope("listener", "route", "session-b").unwrap();
    for (scope, status, now) in [(&b, 429, 100), (&b, 429, 101), (&a, 500, 102), (&b, 429, 103)] {
        let failure = source(V3ErrorSourceKind::ProviderFailure, "provider_http_error", status);
        health.record_provider_failure_record_from_source(
            scope, "first", Some("key1"), Some("gpt-test"), &failure, now,
        ).unwrap();
    }
    assert!(!health.session_bound_availability(&b)
        .availability("first", Some("key1"), Some("gpt-test"), 103).unwrap().available,
        "a different session's non-429 must not interrupt this session's three 429s");
    assert!(health.session_bound_availability(&a)
        .availability("first", Some("key1"), Some("gpt-test"), 103).unwrap().available,
        "the 429 cooldown must remain scoped to the failing session");
}

#[test]
fn issue44cc3af_local_failure_does_not_interrupt_real_429_streak() {
    let mut manifest = global_pool_alive_manifest("local_failure_not_provider_observation");
    normalize_global_pool_priorities(&mut manifest);
    let health = V3ProviderFailureRuntimeHealth::from_manifest_for_isolated_tests(&manifest);
    let scope = test_provider_failure_scope("listener", "route", "session-a").unwrap();
    for (kind, status, now) in [
        (V3ErrorSourceKind::ProviderFailure, 429, 100),
        (V3ErrorSourceKind::ProviderFailure, 429, 101),
        (V3ErrorSourceKind::RuntimeFailure, 599, 102),
        (V3ErrorSourceKind::ProviderFailure, 429, 103),
    ] {
        let failure = source(kind, "provider_http_error", status);
        health.record_provider_failure_record_from_source(
            &scope, "first", Some("key1"), Some("gpt-test"), &failure, now,
        ).unwrap();
    }
    assert!(!health.session_bound_availability(&scope)
        .availability("first", Some("key1"), Some("gpt-test"), 103).unwrap().available,
        "a local failure is not a real provider response and must not interrupt its 429 streak");
}

#[tokio::test]
async fn ordinary_failure_does_not_globally_cool_other_session_before_ten() {
    let mut manifest = global_pool_alive_manifest("failed_observation_isolation");
    normalize_global_pool_priorities(&mut manifest);
    let health = V3ProviderFailureRuntimeHealth::from_manifest_for_isolated_tests(&manifest);
    let a = test_provider_failure_scope("listener", "route", "session-a").unwrap();
    let b = test_provider_failure_scope("listener", "route", "session-b").unwrap();
    let failure = source(V3ErrorSourceKind::ProviderFailure, "provider_http_error", 500);
    health.record_provider_failure_record_from_source(
        &a, "first", Some("key1"), Some("gpt-test"), &failure, 100,
    ).unwrap();
    assert!(health.session_bound_availability(&b)
        .availability("first", Some("key1"), Some("gpt-test"), 10_100).unwrap().available,
        "one failed observation must not globally cool another session");
}

#[tokio::test]
async fn issue44cc3af_migrated_real_success_resets_failures_across_sessions() {
    let mut manifest = global_pool_alive_manifest("precool_probe_cross_recovery");
    normalize_global_pool_priorities(&mut manifest);
    let health = V3ProviderFailureRuntimeHealth::from_manifest_for_isolated_tests(&manifest);
    let a = test_provider_failure_scope("listener", "route", "session-a").unwrap();
    let b = test_provider_failure_scope("listener", "route", "session-b").unwrap();
    let failure = source(V3ErrorSourceKind::ProviderFailure, "provider_http_error", 500);
    for now in 100..110 {
        let scope = if now % 2 == 0 { &a } else { &b };
        health.record_provider_failure_record_from_source(
            scope, "first", Some("key1"), Some("gpt-test"), &failure, now,
        ).unwrap();
    }
    assert!(!health.session_bound_availability(&b)
        .availability("first", Some("key1"), Some("gpt-test"), 109).unwrap().available);
    health.record_provider_success_in_failure_scope_for_interface(
        &crate::nodes::V3AttemptSuccessReceipt::from_buffered_terminal_attempt(),
        &a, "first", "default", Some("key1"), Some("gpt-test"), 200,
    ).unwrap();
    assert!(health.session_bound_availability(&b)
        .availability("first", Some("key1"), Some("gpt-test"), 1_300).unwrap().available,
        "matching real success must restore the identity for the other session");
}

#[tokio::test]
async fn issue44cc3af_migrated_ordinary_failure_is_recorded_without_a_probe() {
    let mut manifest = global_pool_alive_manifest("local_due_precool");
    normalize_global_pool_priorities(&mut manifest);
    let health = V3ProviderFailureRuntimeHealth::from_manifest_for_isolated_tests(&manifest);
    let scope = test_provider_failure_scope("listener", "route", "session-a").unwrap();
    let failure = source(V3ErrorSourceKind::ProviderFailure, "provider_http_error", 500);
    let record = health.record_provider_failure_record_from_source(
        &scope, "first", Some("key1"), Some("gpt-test"), &failure, 100,
    ).unwrap();
    assert_eq!(record.failure_count, 1, "the failure is recorded immediately");
    let observed = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let captured = observed.clone();
    health.run_due_provider_health_probes(1_200, false, move |_, _, _, _| {
        captured.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        async { Ok(()) }
    }).await.unwrap();
    assert_eq!(observed.load(std::sync::atomic::Ordering::SeqCst), 0,
        "an uncooled identity must not be probed");
}

#[tokio::test]
async fn fresh_health_startup_sweep_skips_uncooled_identities() {
    let mut manifest = global_pool_alive_manifest("fresh_startup_probe");
    normalize_global_pool_priorities(&mut manifest);
    let health = V3ProviderFailureRuntimeHealth::from_manifest_for_isolated_tests(&manifest);
    let observed = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
    let captured = observed.clone();
    health.run_due_provider_health_probes(100, true, move |provider, interface, auth, model| {
        captured.lock().unwrap().push((provider, interface, auth, model));
        async { Ok(()) }
    }).await.unwrap();
    assert!(observed.lock().unwrap().is_empty(),
        "an empty cooldown pool must not probe configured healthy identities");
}

#[test]
fn recovery_probe_transport_failure_counts_as_tenth_global_error() {
    let mut manifest = global_pool_alive_manifest("recovery_probe_global_count");
    normalize_global_pool_priorities(&mut manifest);
    let health = V3ProviderFailureRuntimeHealth::from_manifest_for_isolated_tests(&manifest);
    let scope = test_provider_failure_scope("recovery_probe_global_count", "recovery_probe_global_count", "s").unwrap();
    let failure = source(V3ErrorSourceKind::ProviderFailure, "provider_http_429", 429);
    for now in [100, 101, 102] {
        health.record_provider_failure_record_from_source(&scope, "first", Some("key1"), Some("gpt-test"), &failure, now).unwrap();
    }
    for now in 103..109 {
        health.store.record_real_provider_failure_for_interface("first", "default", "key1", "gpt-test", Some(503), now).unwrap();
    }
    assert!(health.availability("first", Some("key1"), Some("gpt-test"), 109).unwrap().available);
    let key = session_precool_identity(&scope, "first", "default", Some("key1"), Some("gpt-test"));
    let permit = health.store.acquire_provider_cooldown_probe_for_key(&key, Some(10_102), false).unwrap().unwrap();
    let cancellation = V3ProviderProbeCancellationGuard { store: health.store.clone(), permit };
    complete_v3_provider_health_probe(&cancellation, &health, Err(V3ProviderHealthProbeFailure::Provider(
        V3ProviderError::Transport { request_id: "probe".into(), provider_id: "first".into(), reason: "connection closed".into() }
    )), 10_102).unwrap();
    assert!(!health.availability("first", Some("key1"), Some("gpt-test"), 10_103).unwrap().available,
        "the real transport failure from the current recovery probe is the tenth global error");
    assert!(health.availability("first", Some("other"), Some("gpt-test"), 10_103).unwrap().available);
    health.store.record_provider_success_in_session(&scope, "first", Some("key1"), Some("gpt-test"), 10_104).unwrap();
    health.store.record_provider_key_success("first", "key1", "gpt-test", 10_104).unwrap();
    complete_v3_provider_health_probe(&cancellation, &health, Err(V3ProviderHealthProbeFailure::Provider(
        V3ProviderError::Transport { request_id: "stale-probe".into(), provider_id: "first".into(), reason: "late completion".into() }
    )), 10_105).unwrap();
    assert!(health.availability("first", Some("key1"), Some("gpt-test"), 10_105).unwrap().available,
        "a stale probe must not restore the previous cooldown after success");
}

#[test]
fn recovery_probe_429_counts_globally_only_after_two_minutes() {
    let mut manifest = global_pool_alive_manifest("recovery_probe_429_global_count");
    normalize_global_pool_priorities(&mut manifest);
    let health = V3ProviderFailureRuntimeHealth::from_manifest_for_isolated_tests(&manifest);
    let scope = test_provider_failure_scope("recovery_probe_429_global_count", "recovery_probe_429_global_count", "s").unwrap();
    let failure = source(V3ErrorSourceKind::ProviderFailure, "provider_http_429", 429);
    for now in [100, 101, 102] {
        health.record_provider_failure_record_from_source(&scope, "first", Some("key1"), Some("gpt-test"), &failure, now).unwrap();
    }
    for now in 103..109 {
        health.store.record_real_provider_failure_for_interface("first", "default", "key1", "gpt-test", Some(503), now).unwrap();
    }
    let key = session_precool_identity(&scope, "first", "default", Some("key1"), Some("gpt-test"));
    for (now, should_be_available) in [(120_100, true), (140_100, false)] {
        let permit = health.store.acquire_provider_cooldown_probe_for_key(&key, Some(now), false).unwrap().unwrap();
        let cancellation = V3ProviderProbeCancellationGuard { store: health.store.clone(), permit };
        let error = V3ProviderError::HttpStatus { response: Box::new(routecodex_v3_provider_responses::V3ProviderHttpFailure {
            request_id: "probe".into(), provider_id: "first".into(), status: 429,
            headers: vec![], body: b"rate limit".to_vec(), body_read_failure: None,
        }) };
        complete_v3_provider_health_probe(&cancellation, &health, Err(V3ProviderHealthProbeFailure::Provider(error)), now).unwrap();
        assert_eq!(health.availability("first", Some("key1"), Some("gpt-test"), now).unwrap().available, should_be_available,
            "global cooling needs a new real 429 strictly after two minutes");
    }
}

#[tokio::test]
async fn cooldown_sweep_cancellation_keeps_only_unfinished_identities() {
    let mut manifest = global_pool_alive_manifest("startup_cancel_resume");
    normalize_global_pool_priorities(&mut manifest);
    let health = V3ProviderFailureRuntimeHealth::from_manifest_for_isolated_tests(&manifest);
    for provider in ["first", "second"] {
        for now in 90..100 {
            health.store.record_real_provider_failure_for_interface(
                provider, "default", "key1", "gpt-test", Some(503), now,
            ).unwrap();
        }
    }
    let running = health.clone();
    let (sent, mut received) = tokio::sync::mpsc::unbounded_channel();
    let task = tokio::spawn(async move {
        running.run_due_provider_health_probes(100, true, move |provider, _, _, _| {
            let sent = sent.clone();
            async move {
                sent.send(provider.clone()).unwrap();
                if provider == "first" { Ok(()) } else { std::future::pending().await }
            }
        }).await
    });
    tokio::time::timeout(std::time::Duration::from_secs(2), async {
        received.recv().await.unwrap();
        received.recv().await.unwrap();
        while health.store.provider_cooldown_probe_next_deadline_ms_for_interface(
            "first", "default", Some("key1"), Some("gpt-test"),
        ).unwrap().is_some() {
            tokio::task::yield_now().await;
        }
    }).await.expect("cooldown sweep did not complete the first identity");
    task.abort();
    let _ = task.await;
    let seen = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
    let capture = seen.clone();
    health.run_due_provider_health_probes(200, true, move |provider, _, _, _| {
        capture.lock().unwrap().push(provider);
        async { Ok(()) }
    }).await.unwrap();
    assert_eq!(*seen.lock().unwrap(), vec!["second".to_string()]);
    assert!(health.store.provider_cooldown_probe_keys_with_interface(200, true).unwrap().is_empty());
}

// Control for the same contract: the third consecutive real 429 must still
// enter the exact-identity provider-health cooldown. Removing the single-429
// action gate must not bypass this health owner.
#[tokio::test]
async fn third_real_429_enters_exact_identity_cooldown_control() {
    let mut manifest = global_pool_alive_manifest("third_429_cooldown_control");
    normalize_global_pool_priorities(&mut manifest);
    let health = V3ProviderFailureRuntimeHealth::from_manifest_for_isolated_tests(&manifest);
    let scope =
        test_provider_failure_scope("third_429_cooldown_control", "third_429_cooldown_control", "s")
            .expect("test scope");
    let failure = source(V3ErrorSourceKind::ProviderFailure, "provider_http_429", 429);
    let mut third_cooldown_until: Option<u64> = None;
    for (index, now_ms) in [100, 101, 102].into_iter().enumerate() {
        let record = health
            .record_provider_failure_record_from_source(
                &scope,
                "first",
                Some("key1"),
                Some("gpt-test"),
                &failure,
                now_ms,
            )
            .unwrap();
        if index < 2 {
            assert_eq!(
                record.state, "rate_limit_capacity_wait",
                "the first two 429s must stay health-neutral"
            );
            assert!(
                health
                    .availability("first", Some("key1"), Some("gpt-test"), now_ms)
                    .unwrap()
                    .available
            );
        } else {
            assert_eq!(
                record.state, "rate_limit_cooldown",
                "the third 429 must commit the exact-identity cooldown"
            );
            assert!(
                !health
                    .session_bound_availability(&scope)
                    .availability("first", Some("key1"), Some("gpt-test"), now_ms)
                    .unwrap()
                    .available,
                "the third 429 must exclude the exact identity for this session"
            );
            third_cooldown_until = record.cooldown_until_ms;
        }
    }
    assert_eq!(third_cooldown_until, Some(10_102));
    assert!(health.store().provider_cooldown_probe_keys_due(10_101).unwrap().is_empty());
    assert!(health.store().provider_cooldown_probe_keys_due(10_102).unwrap().iter().any(
        |(provider, key, model)| provider == "first" && key.as_deref() == Some("key1") && model.as_deref() == Some("gpt-test")
    ));
}
