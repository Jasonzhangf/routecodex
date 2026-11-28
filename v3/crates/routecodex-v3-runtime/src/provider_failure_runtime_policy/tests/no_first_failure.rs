use super::*;
use routecodex_v3_error::build_v3_error_02_classified_from_v3_error_01;
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
    // A real 429 contributes to the shared recoverable streak, but the first
    // observation remains below the ten-failure cooldown threshold.
    assert_eq!(first_failure.failure_count, 1);
    assert_eq!(first_failure.state, "provider_failure_observed");
    assert_eq!(first_failure.cooldown_until_ms, None);
    let recovered_by_business = health
        .store()
        .record_provider_key_success("first", "key1", "gpt-test", 101)
        .unwrap();
    assert_eq!(
        recovered_by_business.failure_streak, 0,
        "business success must reset the recoverable provider failure streak"
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
            record.failure_count,
            (now_ms - 101) as u32,
            "business success must restart the recoverable streak at one"
        );
        assert_eq!(record.state, "provider_failure_observed");
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
            .provider_cooldown_probe_keys_due(u64::MAX)
            .unwrap()
            .is_empty(),
        "sub-threshold 429s must not create a cooldown probe"
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
    // This source wrapper retains request/session error bookkeeping while the
    // shared recoverable streak remains below the cooldown threshold.
    assert_eq!(after_recovery.failure_count, 4);
    assert_eq!(after_recovery.state, "provider_failure_observed");
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
        projection.score_milli, 125,
        "local codec failure must not mutate provider score"
    );
}

#[test]
fn no_first_failure_irrecoverable_quota_and_auth_keep_immediate_boundary() {
    for (status, code, expected_threshold) in
        [(401, "invalid_api_key", 5), (0, "account_disabled", 5)]
    {
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
            action.failure_threshold, expected_threshold,
            "configured terminal boundary must match: {code}"
        );
        let store = V3ProviderHealthStore::default();
        let mut cooled = false;
        for i in 0..expected_threshold {
            cooled = store
                .record_provider_failure_action("p", "k", "m", &action, 100 + u64::from(i))
                .unwrap()
                .cooldown;
        }
        assert!(cooled);
    }
}

#[test]
fn typed_quota_failure_cools_immediately_and_success_cannot_reopen_it() {
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
        V3ProviderRecoveryKind::IrrecoverableGlobalCooldown
    );
    assert_eq!(action.failure_threshold, 5);
    let mut failure = store
        .record_provider_failure_action("p", "k", "m", &action, 100)
        .unwrap();
    for attempt in 1..5 {
        assert!(!failure.cooldown);
        failure = store
            .record_provider_failure_action("p", "k", "m", &action, 100 + attempt)
            .unwrap();
    }
    assert!(failure.cooldown);
    assert_eq!(failure.cooldown_until_ms, Some(3_600_104));
    let success = store
        .record_provider_key_success("p", "k", "m", 106)
        .unwrap();
    assert_eq!(success.failure_streak, 0);
    assert!(
        !success.available,
        "matching success must not shorten the committed one-hour minimum"
    );
}
