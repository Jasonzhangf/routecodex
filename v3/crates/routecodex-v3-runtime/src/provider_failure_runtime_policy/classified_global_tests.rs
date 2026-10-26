use super::*;
use crate::provider_failure_runtime_policy::apply_v3_internal_provider_failure_policy;
use routecodex_v3_config::V3ProviderHealthAuthoringConfig;
use routecodex_v3_error::build_v3_provider_failure_action_from_v3_error_02;
use routecodex_v3_error::{
    build_v3_error_01_source_raised_external, build_v3_error_02_classified_from_v3_error_01,
    V3ErrorSourceKind, V3ExternalErrorKind, V3ExternalErrorLink,
};
use routecodex_v3_provider_responses::V3ProviderRecoveryKind;

#[test]
fn classified_global_health_honors_recoverable_repeat_and_terminal_first_failure() {
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
    for attempt in 0..3 {
        let now_ms = 10_000 + attempt as u64;
        recoverable_health
            .record_provider_global_health_for_classified_error(
                &scope,
                "first",
                "default",
                Some("key1"),
                Some("gpt-test"),
                &classified,
                now_ms,
            )
            .expect("classified 429 failure should record");
        let available = recoverable_health
            .store()
            .availability_for_session(&scope, "first", Some("key1"), Some("gpt-test"), now_ms)
            .available;
        assert_eq!(
            available,
            attempt < 2,
            "429 cools only after the third same-class failure; attempt={attempt}"
        );
    }

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
fn configured_provider_health_governs_transport_failure_exclusion_and_probe_recovery() {
    let scope_name = "configured_health_runtime_transport";
    let mut manifest = global_pool_alive_manifest(scope_name);
    for group in manifest.route_groups.values_mut() {
        for pool in group.pools.values_mut() {
            for target in &mut pool.targets {
                target.priority = if target.provider.as_deref() == Some("first") {
                    Some(100)
                } else {
                    Some(1)
                };
            }
        }
    }
    manifest
        .providers
        .get_mut("first")
        .expect("first provider")
        .health = Some(V3ProviderHealthAuthoringConfig {
        enabled: true,
        failure_threshold: 3,
        cooldown_ms: 900_000,
        probe_interval_ms: None,
    });
    let health = V3ProviderFailureRuntimeHealth::from_manifest(&manifest);
    let scope = test_provider_failure_scope(scope_name, scope_name, "configured-health-transport")
        .expect("failure session scope");
    let now_ms = v3_relay_provider_policy_now_epoch_ms().expect("policy now");

    // A provider transport failure without an upstream status is a typed
    // RecoverableCounted action with a class-code fingerprint.
    let source = build_v3_error_01_source_raised(
        V3ErrorSourceKind::ProviderFailure,
        "V3ProviderReqOutbound09TransportRequest",
        "provider_transport_failure",
        "connection closed before response completed",
    );

    let selected = resolve_target_for_scope(
        &manifest,
        scope_name,
        &BTreeSet::new(),
        &health,
        &scope,
        now_ms,
    );
    let V3RelayProviderTargetResolution::Selected(selected) = selected else {
        panic!("the configured provider must be selected initially");
    };
    assert_eq!(selected.candidate.provider_id, "first");

    // The configured threshold keeps the exact provider+interface+auth+model
    // identity available for the first two failures.
    for _ in 0..2 {
        health
            .record_provider_failure_record_from_source_for_interface(
                &scope,
                "first",
                "default",
                Some("key1"),
                Some("gpt-test"),
                &source,
                now_ms,
            )
            .expect("transport failure record");
        let selected = resolve_target_for_scope(
            &manifest,
            scope_name,
            &BTreeSet::new(),
            &health,
            &scope,
            now_ms,
        );
        let V3RelayProviderTargetResolution::Selected(selected) = selected else {
            panic!("configured provider must stay selectable before the declared threshold");
        };
        assert_eq!(
            selected.candidate.provider_id, "first",
            "configured health policy must not cool the identity before the third failure"
        );
    }

    health
        .record_provider_failure_record_from_source_for_interface(
            &scope,
            "first",
            "default",
            Some("key1"),
            Some("gpt-test"),
            &source,
            now_ms,
        )
        .expect("third transport failure record");

    let entry = health
        .store
        .cooldown_entries(now_ms)
        .into_iter()
        .find(|entry| {
            entry.provider_id == "first"
                && entry.interface_id == "default"
                && entry.auth_alias.as_deref() == Some("key1")
                && entry.model_id.as_deref() == Some("gpt-test")
                && entry.kind == "probe"
        })
        .expect("configured cooldown entry");
    assert_eq!(
        entry.state, "blocked",
        "the declared threshold must create a blocked cooldown entry on the third failure"
    );
    let blocked_until = entry.until_ms.expect("configured cooldown deadline");
    assert!(
        (now_ms..=now_ms + 5_000).contains(&(blocked_until - 900_000)),
        "configured cooldown_ms must govern the blocked deadline: {entry:?}"
    );

    let selected = resolve_target_for_scope(
        &manifest,
        scope_name,
        &BTreeSet::new(),
        &health,
        &scope,
        now_ms,
    );
    let V3RelayProviderTargetResolution::Selected(selected) = selected else {
        panic!("the sibling candidate must remain selectable after the configured identity cools");
    };
    assert_eq!(
        selected.candidate.provider_id, "second",
        "the cooled exact identity must be excluded from runtime target selection"
    );

    health
        .store
        .complete_probe_success("first", "key1", "gpt-test", now_ms)
        .expect("probe recovery");
    let selected = resolve_target_for_scope(
        &manifest,
        scope_name,
        &BTreeSet::new(),
        &health,
        &scope,
        now_ms,
    );
    let V3RelayProviderTargetResolution::Selected(selected) = selected else {
        panic!("probe success must restore the configured identity for selection");
    };
    assert_eq!(
        selected.candidate.provider_id, "first",
        "a successful probe must restore only the exact configured identity"
    );
}

#[test]
fn recoverable_http_429_blocks_after_third_global_failure() {
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
            .expect("ordinary provider policy failure must remain distinct from a Source01 fault");
        let projection = health
            .store()
            .scheduling_projection("first", "key1", "gpt-test", 100, 1, now_ms)
            .expect("health projection");
        let available = projection.available;
        assert_eq!(
            available,
            attempt < 2,
            "provider must cool only after consecutive third 429; attempt={attempt}"
        );
    }
}
