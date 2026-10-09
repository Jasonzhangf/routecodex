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
    assert_eq!(first_failure.failure_count, 1);
    health
        .store()
        .record_provider_key_success("first", "key1", "gpt-test", 101)
        .unwrap();
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
        assert_eq!(record.failure_count, (now_ms - 101) as u32);
        assert_eq!(
            health
                .availability("first", Some("key1"), Some("gpt-test"), now_ms)
                .available,
            now_ms < 104
        );
    }
    assert!(
        !health
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
            .iter()
            .any(|(provider, key, model)| {
                provider == "first"
                    && key.as_deref() == Some("key1")
                    && model.as_deref() == Some("gpt-test")
            }),
        "an existing cooldown must remain recoverable by an exact-identity semantic probe"
    );
    assert!(
        !health
            .availability("first", Some("key1"), Some("gpt-test"), 104)
            .available
    );
    let permit = health
        .store()
        .acquire_provider_cooldown_probe_if_due("first", Some("key1"), Some("gpt-test"), 5_104)
        .unwrap()
        .expect("matching due semantic probe");
    health
        .store()
        .complete_provider_cooldown_probe_success_at_generation(
            permit.provider_id(),
            permit.auth_alias(),
            permit.model_id(),
            5_105,
            Some(permit.expected_generation()),
        )
        .unwrap();
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
    // This source wrapper returns session bookkeeping. Semantic recovery
    // resets the global health streak, while retaining the session history.
    assert_eq!(after_recovery.failure_count, 4);
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
