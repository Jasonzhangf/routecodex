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

#[tokio::test]
async fn early_429_uses_the_ordinary_recoverable_cooldown_path() {
    let mut manifest = global_pool_alive_manifest("no_first_failure_counted");
    normalize_global_pool_priorities(&mut manifest);
    let health = V3ProviderFailureRuntimeHealth::from_manifest_for_isolated_tests(&manifest);
    let scope =
        test_provider_failure_scope("no_first_failure_counted", "no_first_failure_counted", "s")
            .unwrap();
    let failure = source(V3ErrorSourceKind::ProviderFailure, "provider_http_429", 429);
    // v31: a 429 is an ordinary recoverable failure. Each consecutive
    // same-fingerprint request failure is counted immediately for the complete
    // identity; there is no 429-specific health-neutral window, and the ladder
    // only changes visibility once it commits.
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
    assert_eq!(first_failure.state, "pre_cool_observation");
    assert_eq!(first_failure.cooldown_until_ms, None);
    assert!(
        health
            .availability("first", Some("key1"), Some("gpt-test"), 101)
            .available,
        "below the ladder threshold the identity stays visible"
    );
    assert!(
        health
            .availability("first", Some("key2"), Some("gpt-test"), 101)
            .available
    );
    assert!(
        health
            .availability("first", Some("key1"), Some("other"), 101)
            .available
    );
    assert!(
        health
            .availability("second", Some("key1"), Some("gpt-test"), 101)
            .available
    );
    let second = health
        .record_provider_failure_record_from_source(
            &scope,
            "first",
            Some("key1"),
            Some("gpt-test"),
            &failure,
            102,
        )
        .unwrap();
    assert_eq!(second.state, "pre_cool_observation");
    assert_eq!(second.failure_count, 2);
    assert_eq!(second.cooldown_until_ms, None);
    assert!(
        health
            .availability("first", Some("key1"), Some("gpt-test"), 102)
            .available
    );
    let third = health
        .record_provider_failure_record_from_source(
            &scope,
            "first",
            Some("key1"),
            Some("gpt-test"),
            &failure,
            103,
        )
        .unwrap();
    assert_eq!(third.state, "cooldown");
    assert_eq!(third.failure_count, 3);
    assert_eq!(
        third.cooldown_until_ms,
        Some(10_103),
        "the third consecutive 429 commits the shared 10s ladder floor"
    );
    assert!(
        !health
            .availability("first", Some("key1"), Some("gpt-test"), 104)
            .available
    );
    assert!(
        health
            .availability("first", Some("key2"), Some("gpt-test"), 104)
            .available,
        "only the exact failed identity cools"
    );
}

#[tokio::test]
async fn sustained_request_failures_cross_the_shared_ladder_and_failed_probes_do_not() {
    let mut manifest = global_pool_alive_manifest("sustained_request_failures");
    normalize_global_pool_priorities(&mut manifest);
    let health = V3ProviderFailureRuntimeHealth::from_manifest_for_isolated_tests(&manifest);
    let scope =
        test_provider_failure_scope("sustained_request_failures", "sustained_requests", "s")
            .unwrap();
    let failure = source(V3ErrorSourceKind::ProviderFailure, "provider_http_429", 429);
    let first = health
        .record_provider_failure_record_from_source(
            &scope,
            "first",
            Some("key1"),
            Some("gpt-test"),
            &failure,
            100,
        )
        .unwrap();
    // v31: the ordinary request failure is counted immediately for the complete
    // identity. The pre-cool hold is only its observability substate, so the
    // identity stays routable below the ladder threshold.
    assert_eq!(first.state, "pre_cool_observation");
    assert_eq!(
        first.failure_count, 1,
        "the ordinary request failure is counted at deferral time"
    );
    assert!(
        health
            .availability("first", Some("key1"), Some("gpt-test"), 101)
            .available,
        "below the ladder threshold the identity stays routable"
    );
    // A failed recovery observation advances only its own probe cadence: it is
    // not business evidence and must never cross the business cooldown ladder.
    for cycle in 0..4u64 {
        complete_due_precool_failures(&health, 101 + cycle).await;
        assert!(
            health
                .store()
                .cooldown_entries(102 + cycle)
                .into_iter()
                .all(|entry| entry.until_ms.is_none()),
            "a failed probe must not advance the business cooldown ladder"
        );
        assert!(
            health
                .availability("first", Some("key1"), Some("gpt-test"), 102 + cycle)
                .available,
            "a failed probe alone must not hide the identity"
        );
    }
    let second = health
        .record_provider_failure_record_from_source(
            &scope,
            "first",
            Some("key1"),
            Some("gpt-test"),
            &failure,
            200,
        )
        .unwrap();
    assert_eq!(second.state, "pre_cool_observation");
    assert_eq!(second.failure_count, 2);
    let third = health
        .record_provider_failure_record_from_source(
            &scope,
            "first",
            Some("key1"),
            Some("gpt-test"),
            &failure,
            201,
        )
        .unwrap();
    // The third consecutive same-fingerprint request failure crosses the shared
    // ladder and commits the ordinary 10s floor for exactly this identity.
    assert_eq!(third.state, "cooldown");
    assert_eq!(third.failure_count, 3);
    assert_eq!(
        third.cooldown_until_ms,
        Some(10_201),
        "the third consecutive request failure commits the 10s ladder floor"
    );
    assert!(
        !health
            .availability("first", Some("key1"), Some("gpt-test"), 202)
            .available
    );
    assert!(
        health
            .availability("first", Some("key2"), Some("gpt-test"), 202)
            .available,
        "only the exact failed identity cools"
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
fn early_quota_429_follows_account_failure_policy() {
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
    assert_eq!(action.failure_threshold, 1);
    for time in 100..103 {
        assert!(
            store
                .record_provider_failure_action("p", "k", "m", &action, time)
                .unwrap()
                .cooldown
        );
    }
    assert!(
        store
            .record_provider_key_success("p", "k", "m", 106)
            .unwrap()
            .available
    );
}
