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
fn no_first_failure_rate_limit_holds_exact_identity_until_success() {
    let mut manifest = global_pool_alive_manifest("no_first_failure_counted");
    normalize_global_pool_priorities(&mut manifest);
    let health = V3ProviderFailureRuntimeHealth::from_manifest_for_isolated_tests(&manifest);
    let scope =
        test_provider_failure_scope("no_first_failure_counted", "no_first_failure_counted", "s")
            .unwrap();
    let failure = source(V3ErrorSourceKind::ProviderFailure, "provider_http_429", 429);
    // HTTP 429 latches a bounded hold: the exact identity is excluded during
    // the ~1 minute window and scheduled for a recovery probe.
    for now_ms in 100..106 {
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
        assert_eq!(record.failure_count, (now_ms - 99) as u32);
        assert!(
            !health
                .availability("first", Some("key1"), Some("gpt-test"), now_ms)
                .available,
            "a 429 must hold the exact identity during its window; attempt={now_ms}"
        );
    }
    assert!(
        health
            .store()
            .provider_cooldown_probe_keys_due(u64::MAX)
            .unwrap()
            .contains(&("first".into(), Some("key1".into()), Some("gpt-test".into()))),
        "a 429 hold must schedule a recovery probe for the held identity"
    );
    // Identity isolation still holds: siblings were never touched.
    for (provider, key, model) in [
        ("first", "key2", "gpt-test"),
        ("first", "key1", "other"),
        ("second", "key1", "gpt-test"),
    ] {
        assert!(
            health
                .availability(provider, Some(key), Some(model), 105)
                .available,
            "sibling {provider}.{key}.{model} must stay eligible"
        );
    }
    // Business success releases the exact hold immediately.
    let success = health
        .store()
        .record_provider_key_success("first", "key1", "gpt-test", 106)
        .unwrap();
    assert!(success.available);
    assert_eq!(success.success_streak, 1, "one real success counts once");
    assert_eq!(
        health
            .availability("first", Some("key1"), Some("gpt-test"), 106)
            .available,
        true
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
fn quota_429_enters_a_bounded_hold_and_releases_on_success() {
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
    // A 429 latches a bounded recoverable hold with a ~1 minute window.
    assert_eq!(action.recovery, V3ProviderRecoveryKind::RecoverableCounted);
    assert_eq!(action.failure_threshold, 1);
    assert_eq!(action.cooldown_ms, 60_000);
    for time in 100..106 {
        let projection = store
            .record_provider_failure_action("p", "k", "m", &action, time)
            .unwrap();
        assert!(
            !projection.available,
            "a 429 must hold the exact identity during its window; attempt={time}"
        );
    }
    assert!(
        store
            .record_provider_key_success("p", "k", "m", 106)
            .unwrap()
            .available
    );
}
