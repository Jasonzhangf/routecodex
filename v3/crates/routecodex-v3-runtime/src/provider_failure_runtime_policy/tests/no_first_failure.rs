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
fn no_first_failure_default_counts_real_failure_and_success_resets_exact_identity() {
    let mut manifest = global_pool_alive_manifest("no_first_failure_counted");
    normalize_global_pool_priorities(&mut manifest);
    let health = V3ProviderFailureRuntimeHealth::from_manifest_for_isolated_tests(&manifest);
    let scope =
        test_provider_failure_scope("no_first_failure_counted", "no_first_failure_counted", "s")
            .unwrap();
    let failure = source(V3ErrorSourceKind::ProviderFailure, "provider_http_500", 500);
    for now in [100, 102] {
        health
            .record_provider_failure_record_from_source(
                &scope,
                "first",
                Some("key1"),
                Some("gpt-test"),
                &failure,
                now,
            )
            .unwrap();
        let projection = health
            .store()
            .scheduling_projection("first", "key1", "gpt-test", 100, 1, now)
            .unwrap();
        assert!(
            projection.available,
            "isolated real failure must leave key eligible"
        );
        assert!(health
            .store()
            .provider_cooldown_probe_keys(now, false)
            .unwrap()
            .is_empty());
        if now == 100 {
            health
                .store()
                .record_provider_key_success("first", "key1", "gpt-test", 101)
                .unwrap();
        }
    }
    health
        .record_provider_failure_record_from_source(
            &scope,
            "first",
            Some("key1"),
            Some("gpt-test"),
            &failure,
            103,
        )
        .unwrap();
    assert!(
        !health
            .availability("first", Some("key1"), Some("gpt-test"), 103)
            .available
    );
    assert!(
        health
            .availability("first", Some("key2"), Some("gpt-test"), 103)
            .available
    );
    assert!(
        health
            .availability("first", Some("key1"), Some("other"), 103)
            .available
    );
    assert!(
        health
            .availability("second", Some("key1"), Some("gpt-test"), 103)
            .available
    );
    health
        .store()
        .record_provider_key_success("first", "key1", "gpt-test", 104)
        .unwrap();
    health
        .record_provider_failure_record_from_source(
            &scope,
            "first",
            Some("key1"),
            Some("gpt-test"),
            &failure,
            105,
        )
        .unwrap();
    assert!(
        health
            .availability("first", Some("key1"), Some("gpt-test"), 105)
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
    for (status, code) in [
        (401, "invalid_api_key"),
        (429, "insufficient_quota"),
        (0, "account_disabled"),
    ] {
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
