use super::*;
use crate::provider_failure_runtime_policy::apply_v3_internal_provider_failure_policy;
use routecodex_v3_error::build_v3_provider_failure_action_from_v3_error_02;
use routecodex_v3_error::{
    build_v3_error_01_source_raised_external, build_v3_error_02_classified_from_v3_error_01,
    V3ErrorSourceKind, V3ExternalErrorKind, V3ExternalErrorLink,
};
use routecodex_v3_provider_responses::V3ProviderRecoveryKind;

#[test]
fn classified_global_health_applies_typed_recoverable_and_unrecoverable_thresholds() {
    let mut manifest = global_pool_alive_manifest("global_status_policy_classified");
    for group in manifest.route_groups.values_mut() {
        for pool in group.pools.values_mut() {
            for target in &mut pool.targets {
                target.priority = Some(100);
            }
        }
    }
    let scope = test_provider_failure_scope(
        "global_status_policy_classified",
        "global_status_policy_classified",
        "runtime-policy-classified",
    )
    .expect("failure session scope");

    let recoverable_health = V3ProviderFailureRuntimeHealth::from_manifest(&manifest);
    for attempt in 0..2 {
        let classified =
            classified_provider_error("V3ProviderRespInbound01Raw", "provider_http_error", 429);
        recoverable_health
            .record_provider_global_health_for_classified_error(
                &scope,
                "first",
                Some("key1"),
                Some("gpt-test"),
                &classified,
                10_000 + attempt as u64,
            )
            .expect("classified recoverable failure should record");
        assert!(
            recoverable_health
                .store()
                .availability_for_session(
                    &scope,
                    "first",
                    Some("key1"),
                    Some("gpt-test"),
                    10_000 + attempt as u64,
                )
                .available,
            "429 must remain available before configured recoverable threshold"
        );
    }
    recoverable_health
        .record_provider_global_health_for_classified_error(
            &scope,
            "first",
            Some("key1"),
            Some("gpt-test"),
            &classified_provider_error("V3ProviderRespInbound01Raw", "provider_http_error", 429),
            10_002,
        )
        .expect("classified 429 threshold failure should record");
    assert!(
        !recoverable_health
            .store()
            .availability_for_session(&scope, "first", Some("key1"), Some("gpt-test"), 10_002,)
            .available,
        "429 must block after configured recoverable threshold"
    );

    let unrecoverable_health = V3ProviderFailureRuntimeHealth::from_manifest(&manifest);
    let classified_401 =
        classified_provider_error("V3ProviderRespInbound01Raw", "invalid_api_key", 401);
    let action_401 = apply_v3_internal_provider_failure_policy(
        build_v3_provider_failure_action_from_v3_error_02(&classified_401),
        classified_401.source.source_stage,
        401,
        &classified_401.source.code,
    );
    assert_eq!(
        action_401.recovery,
        V3ProviderRecoveryKind::IrrecoverableGlobalCooldown
    );
    assert_eq!(action_401.failure_threshold, 2);
    unrecoverable_health
        .record_provider_global_health_for_classified_error(
            &scope,
            "first",
            Some("key1"),
            Some("gpt-test"),
            &classified_401,
            10_000,
        )
        .expect("classified unrecoverable failure should record");
    assert!(
        unrecoverable_health
            .store()
            .availability_for_session(&scope, "first", Some("key1"), Some("gpt-test"), 10_000,)
            .available,
        "401 must remain available before configured unrecoverable threshold"
    );
    unrecoverable_health
        .record_provider_global_health_for_classified_error(
            &scope,
            "first",
            Some("key1"),
            Some("gpt-test"),
            &classified_401,
            10_001,
        )
        .expect("classified 401 threshold failure should record");
    let second_401 = unrecoverable_health.store().availability_for_session(
        &scope,
        "first",
        Some("key1"),
        Some("gpt-test"),
        10_001,
    );
    assert!(
        !second_401.available,
        "401 must block after configured unrecoverable threshold: {second_401:?}"
    );
}

fn classified_provider_error(
    stage: &'static str,
    code: &str,
    status: u16,
) -> routecodex_v3_error::V3Error02Classified {
    let source = build_v3_error_01_source_raised_external(
        V3ErrorSourceKind::ProviderFailure,
        stage,
        code,
        "provider failure",
        V3ExternalErrorLink {
            kind: V3ExternalErrorKind::Provider,
            status: Some(status),
            code: Some(code.to_string()),
            provider_id: Some("first".to_string()),
            upstream_request_id: None,
            message: Some("provider failure".to_string()),
        },
    );
    build_v3_error_02_classified_from_v3_error_01(source)
}

#[test]
fn recoverable_http_429_blocks_after_configured_global_threshold() {
    let mut manifest = global_pool_alive_manifest("recoverable_http_429_global_threshold");
    for group in manifest.route_groups.values_mut() {
        for pool in group.pools.values_mut() {
            for target in &mut pool.targets {
                target.priority = Some(100);
            }
        }
    }
    let health = V3ProviderFailureRuntimeHealth::from_manifest(&manifest);
    let scope = test_provider_failure_scope(
        "recoverable_http_429_global_threshold",
        "recoverable_http_429_global_threshold",
        "runtime-policy-429",
    )
    .expect("failure session scope");
    health
        .store()
        .scheduling_projection("first", "key1", "gpt-test", 100, 1, 0)
        .expect("initial health projection");

    for attempt in 0..3 {
        let now_ms = 10_000 + attempt as u64;
        health
            .record_provider_failure_record_with_policy(
                None,
                &manifest,
                &scope,
                "first",
                Some("responses"),
                Some("key1"),
                Some("gpt-test"),
                Some("upstream rate limit"),
                "V3ProviderReqOutbound09TransportRequest",
                429,
                Some("provider_http_error"),
                "rate limited",
                now_ms,
            )
            .expect("runtime provider failure policy should record");
        let projection = health
            .store()
            .scheduling_projection("first", "key1", "gpt-test", 100, 1, now_ms)
            .expect("health projection");
        let available = projection.available;
        if attempt < 2 {
            assert!(
                available,
                "provider must remain available before the 429 threshold is reached; attempt={attempt}, available={available:?}"
            );
        } else {
            assert!(
                !available,
                "provider must be excluded after the configured 429 threshold; attempt={attempt}, available={available:?}"
            );
        }
    }
}
