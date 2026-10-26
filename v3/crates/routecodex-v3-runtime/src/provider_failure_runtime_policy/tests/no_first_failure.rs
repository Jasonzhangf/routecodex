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
fn no_first_failure_429_retains_diagnostics_without_health_cooldown() {
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
            .available,
        "a business success before any cooldown must leave the exact identity eligible"
    );
    for now_ms in 102..=104 {
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
                .available,
            true
        );
    }
    assert!(
        health
            .availability("first", Some("key1"), Some("gpt-test"), 102)
            .available
    );
    assert!(
        health
            .availability("first", Some("key2"), Some("gpt-test"), 102)
            .available
    );
    assert!(
        health
            .availability("first", Some("key1"), Some("other"), 102)
            .available
    );
    assert!(
        health
            .availability("second", Some("key1"), Some("gpt-test"), 102)
            .available
    );
    assert!(
        health
            .store()
            .provider_cooldown_probe_keys_due(5_104)
            .unwrap()
            .is_empty(),
        "429 backpressure must not create a cooldown probe"
    );
    assert!(
        health
            .availability("first", Some("key1"), Some("gpt-test"), 104)
            .available
    );
    assert!(
        health
            .availability("first", Some("key1"), Some("gpt-test"), 5_105)
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
fn no_first_failure_irrecoverable_quota_and_auth_keep_immediate_boundary() {
    for (status, code) in [(401, "invalid_api_key"), (0, "account_disabled")] {
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
        assert_eq!(
            action.failure_threshold, 1,
            "real terminal boundary must not wait for repeat: {code}"
        );
        let store = V3ProviderHealthStore::default();
        assert!(
            store
                .record_provider_failure_action("p", "k", "m", &action, 100)
                .unwrap()
                .cooldown
        );
    }
}

#[test]
fn quota_429_stays_health_neutral_before_and_after_business_success() {
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
    for time in 100..103 {
        assert_eq!(
            store
                .record_provider_failure_action("p", "k", "m", &action, time)
                .unwrap()
                .cooldown,
            false
        );
    }
    assert!(
        store
            .record_provider_key_success("p", "k", "m", 103)
            .unwrap()
            .available
    );
}
