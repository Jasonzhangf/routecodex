include!("../../tests/support/kernel_unit.rs");

#[cfg(test)]
#[tokio::test]
async fn normal_direct_request_does_not_consume_unrelated_provider_failure_gate() {
    run_normal_direct_request_does_not_consume_unrelated_provider_failure_gate().await;
}

#[test]
fn direct_provider_failure_uses_health_score_without_legacy_threshold_cooldown() {
    let mut manifest = test_manifest();
    manifest
        .forwarders
        .get_mut("responses")
        .expect("responses forwarder")
        .targets[0]
        .priority = Some(100);
    manifest
        .route_groups
        .get_mut("default")
        .expect("default route group")
        .pools
        .get_mut("default")
        .expect("default pool")
        .targets[0] = V3RoutePoolTargetManifest {
            kind: V3RouteTargetKind::ProviderModel,
            id: None,
            provider: Some("openai".to_string()),
            model: Some("gpt-test".to_string()),
            key: Some("key1".to_string()),
            priority: Some(100),
            weight: Some(1),
        };
    let health = V3ProviderFailureRuntimeHealth::from_manifest(&manifest);
    let session = test_failure_session_scope_for("default", "direct-health-single-owner");
    let plan = plan_v3_responses_protocol_execution_with_provider_health(
        &manifest,
        test_plan_http_request(
            "default",
            "direct-health-single-owner-request",
            "direct-health-single-owner-execution",
        ),
        health.clone(),
        100,
    )
    .expect("direct test plan");
    let source = build_v3_error_01_source_raised_external(
        V3ErrorSourceKind::ProviderFailure,
        "V3ProviderRespInbound01Raw",
        "provider_http_502",
        "controlled direct provider 502",
        V3ExternalErrorLink {
            kind: V3ExternalErrorKind::Provider,
            status: Some(502),
            code: Some("HTTP_502".to_string()),
            provider_id: Some("openai".to_string()),
            upstream_request_id: None,
            message: Some("controlled direct provider 502".to_string()),
        },
    );

    for offset in 0..3 {
        record_v3_direct_provider_failure_record(
            &health,
            &session,
            &plan.decision.target,
            &source,
            100 + offset,
        )
        .expect("direct failure must be recorded");
    }

    let projection = health.store().scheduling_projection(
        "openai",
        "key1",
        "gpt-test",
        100,
        100,
        200,
    )
    .expect("direct health projection");
    assert_eq!(projection.score_milli, 85);
    assert!(
        projection.available,
        "health score should be non-zero after three recoverable failures"
    );
}
