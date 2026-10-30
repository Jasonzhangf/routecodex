use super::*;
use crate::provider_failure_runtime_policy::apply_v3_internal_provider_failure_policy;
use routecodex_v3_error::build_v3_provider_failure_action_from_v3_error_02;
use routecodex_v3_error::{
    build_v3_error_01_source_raised_external, build_v3_error_02_classified_from_v3_error_01,
    V3ErrorSourceKind, V3ExternalErrorKind, V3ExternalErrorLink,
};
use routecodex_v3_provider_responses::V3ProviderRecoveryKind;

#[test]
fn classified_global_health_keeps_429_neutral_and_auth_terminal() {
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
    let classified =
        classified_provider_error("V3ProviderRespInbound01Raw", "provider_http_error", 429);
    // An early 429 is capacity backpressure, not a health exclusion.
    recoverable_health
        .record_provider_global_health_for_classified_error(
            &scope,
            "first",
            "default",
            Some("key1"),
            Some("gpt-test"),
            &classified,
            10_000,
        )
        .expect("classified 429 failure should record");
    assert!(
        recoverable_health
            .store()
            .availability_for_session(&scope, "first", Some("key1"), Some("gpt-test"), 10_000)
            .available,
        "early 429 must leave health routable"
    );
    // Business success resets this unresolved episode.
    recoverable_health
        .store()
        .record_provider_key_success("first", "key1", "gpt-test", 10_001)
        .expect("business success resets the early episode");
    assert!(
        recoverable_health
            .store()
            .availability_for_session(&scope, "first", Some("key1"), Some("gpt-test"), 10_001)
            .available,
        "business success preserves health availability"
    );
    // A new episode requires another actual 429 across the full window.
    recoverable_health
        .record_provider_global_health_for_classified_error(
            &scope,
            "first",
            "default",
            Some("key1"),
            Some("gpt-test"),
            &classified,
            20_000,
        )
        .expect("second classified 429 failure should record");
    assert!(
        recoverable_health
            .store()
            .availability_for_session(&scope, "first", Some("key1"), Some("gpt-test"), 20_000)
            .available,
        "a fresh early episode must remain health-neutral"
    );
    assert!(
        recoverable_health
            .store()
            .availability_for_session(
                &scope,
                "first",
                Some("key1"),
                Some("gpt-test"),
                20_000 + 60_001,
            )
            .available,
        "time alone cannot upgrade the episode"
    );
    recoverable_health
        .record_provider_global_health_for_classified_error(
            &scope,
            "first",
            "default",
            Some("key1"),
            Some("gpt-test"),
            &classified,
            140_000,
        )
        .expect("new actual 429 across two minutes");
    assert!(
        !recoverable_health
            .store()
            .availability_for_session(&scope, "first", Some("key1"), Some("gpt-test"), 140_000,)
            .available
    );
    assert!(
        recoverable_health
            .store()
            .availability_for_session(&scope, "first", Some("key2"), Some("gpt-test"), 140_000,)
            .available
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
    assert_eq!(action_401.failure_threshold, 1);
    unrecoverable_health
        .record_provider_global_health_for_classified_error(
            &scope,
            "first",
            "default",
            Some("key1"),
            Some("gpt-test"),
            &classified_401,
            10_000,
        )
        .expect("classified unrecoverable failure should record");
    assert!(
        !unrecoverable_health
            .store()
            .availability_for_session(&scope, "first", Some("key1"), Some("gpt-test"), 10_000,)
            .available,
        "401 must be blocked after its first provider failure"
    );
    unrecoverable_health
        .record_provider_global_health_for_classified_error(
            &scope,
            "first",
            "default",
            Some("key1"),
            Some("gpt-test"),
            &classified_401,
            10_001,
        )
        .expect("repeated classified 401 failure should remain isolated");
    let second_401 = unrecoverable_health.store().availability_for_session(
        &scope,
        "first",
        Some("key1"),
        Some("gpt-test"),
        10_001,
    );
    assert!(
        !second_401.available,
        "401 must remain blocked while cooldown is active: {second_401:?}"
    );

    let payment_health = V3ProviderFailureRuntimeHealth::from_manifest(&manifest);
    let classified_402 =
        classified_provider_error("V3ProviderRespInbound01Raw", "payment_required", 402);
    for now_ms in [20_000] {
        payment_health
            .record_provider_global_health_for_classified_error(
                &scope,
                "first",
                "default",
                Some("key1"),
                Some("gpt-test"),
                &classified_402,
                now_ms,
            )
            .expect("classified 402 failure should record");
    }
    assert!(
        !payment_health
            .store()
            .availability_for_session(&scope, "first", Some("key1"), Some("gpt-test"), 20_000)
            .available,
        "402 must reach global health and cool after its first failure"
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
fn early_http_429_does_not_enter_global_cooldown() {
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

    // Repeated actual429 responses inside the window stay health-neutral.
    for attempt in 0..6 {
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
            .expect("ordinary provider policy failure must remain distinct from a Source01 fault");
        let projection = health
            .store()
            .scheduling_projection("first", "key1", "gpt-test", 100, 1, now_ms)
            .expect("health projection");
        let available = projection.available;
        assert!(
            available,
            "429 must not cool provider health; attempt={attempt}"
        );
    }
    assert!(
        health
            .store()
            .provider_cooldown_probe_keys_due(u64::MAX)
            .expect("probe keys")
            .is_empty(),
        "an early429 must not create a health recovery probe"
    );
    // The passage of time without a new provider response cannot cool health.
    let projection = health
        .store()
        .scheduling_projection("first", "key1", "gpt-test", 100, 1, 10_000 + 5 + 60_001)
        .expect("post-window projection");
    assert!(
        projection.available,
        "an unchanged early episode remains routable"
    );
}
