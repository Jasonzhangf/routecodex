include!("../../tests/support/kernel_unit.rs");

#[test]
fn protocol_plan_operator_fault_keeps_original_cause_without_running_error_projection() {
    let original = routecodex_v3_error::build_v3_error_01_source_raised(
        V3ErrorSourceKind::RuntimeFailure,
        "V3Execution11ProtocolDecision",
        "protocol_plan_failure",
        "the original planning failure",
    );
    // Seed the typed fault at the planning boundary; this does not claim that
    // a public request can force an SDK01 rejection with the fixed catalog.
    let fault = crate::provider_failure_runtime_policy::finish_v3_relay_error_projection(
        original.clone(),
        Ok(None),
    )
    .expect_err("missing terminal projection is an actual typed operator fault");
    let failure =
        protocol_plan_operator_fault(fault.clone(), vec!["V3Execution11ProtocolDecision"]);
    let returned = project_v3_protocol_execution_plan_failure(failure)
        .expect_err("an operator fault must not become a successful Error06 projection");
    assert_eq!(returned, fault);
    assert_eq!(returned.original_source, Some(original));
}

#[test]
fn protocol_plan_failure_preserves_source_status_and_pool_exhausted() {
    let routing_group = "protocol_plan_failure";
    let mut manifest = scoped_test_manifest(responses_process_chat_manifest(), routing_group);
    manifest
        .servers
        .get_mut("test")
        .expect("test server")
        .execution
        .as_mut()
        .expect("test execution policy")
        .allowed_modes = vec!["direct".to_string()];
    let provider_health = V3ProviderFailureRuntimeHealth::from_manifest(&manifest);
    let failure = plan_v3_responses_protocol_execution_with_provider_health(
        &manifest,
        test_plan_http_request(
            routing_group,
            "protocol-plan-failure-producer",
            "protocol-plan-failure-producer-execution",
        ),
        provider_health,
        100,
    )
    .expect_err("process=chat with Direct-only policy must produce a real protocol-plan failure");

    let original_source = failure.source.clone();
    let projected = project_v3_protocol_execution_plan_failure(failure)
        .expect("a normal protocol-plan source must finish through Error02..06");

    assert_eq!(
        original_source.source_kind,
        V3ErrorSourceKind::RuntimeFailure
    );
    assert_eq!(
        original_source.source_stage,
        "V3Execution11ProtocolDecision"
    );
    assert_eq!(
        original_source.code,
        "responses_process_chat_relay_not_allowed"
    );
    assert_eq!(projected.diagnostic_source, original_source);
    assert_eq!(projected.status, 598);
    assert_eq!(projected.pool_exhausted, false);
    assert_eq!(
        projected.chain,
        routecodex_v3_error::V3_ERROR_CHAIN_NODE_IDS
    );
}

#[test]
fn residence_expiry_is_not_a_local_store_598_and_never_commits_an_error() {
    let source = direct_attempt_store_error_source(
        crate::nodes::V3AttemptStoreError::ResidenceDeadlineExceeded("expired".into()),
        "V3ExecutionAttemptPayloadStore",
        "direct_sse_attempt_store_rejected",
    );
    assert_eq!(source.code, "request_residence_deadline_exceeded");
    let output = error_output(
        source,
        Vec::new(),
        &crate::hooks::register_responses_direct_hooks(),
    );
    assert_ne!(output.client_payload.status, 598);
    assert_eq!(
        output.terminal_disposition,
        Some(V3ProviderTerminalDisposition::NoResponse)
    );
    assert_eq!(output.error_chain.as_ref().unwrap().len(), 6);

    let source = direct_attempt_store_error_source(
        crate::nodes::V3AttemptStoreError::LocalResourceExhausted("byte cap".into()),
        "V3ExecutionAttemptPayloadStore",
        "direct_sse_attempt_store_rejected",
    );
    assert_eq!(source.source_kind, V3ErrorSourceKind::RuntimeFailure);
    assert_eq!(source.code, "direct_sse_attempt_store_rejected");
}

#[cfg(test)]
#[tokio::test]
async fn normal_direct_request_does_not_consume_unrelated_provider_failure_gate() {
    run_normal_direct_request_does_not_consume_unrelated_provider_failure_gate().await;
}

#[test]
fn direct_provider_failure_blocks_after_configured_threshold() {
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
        interface: None,
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

    for offset in 0..1 {
        record_v3_direct_provider_failure_record(
            &health,
            &session,
            &plan.decision.target,
            &source,
            100 + offset,
        )
        .expect("direct failure must be recorded");
        let projection = health
            .store()
            .scheduling_projection("openai", "key1", "gpt-test", 100, 100, 200)
            .expect("direct health projection");
        assert_eq!(
            projection.available, false,
            "one typed recoverable 502 failure cools the exact identity"
        );
    }

    let projection = health
        .store()
        .scheduling_projection("openai", "key1", "gpt-test", 100, 100, 200)
        .expect("direct health projection");
    assert_eq!(projection.score_milli, 95);
    // 统一错误模型：typed recoverable 失败当前共享 threshold=1；429 另有三次阈值。
    assert!(
        !projection.available,
        "one typed 502 failure must trigger threshold cooldown"
    );
}

#[test]
fn direct_provider_failure_thresholds_cover_400_and_401_classes() {
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
        interface: None,
        priority: Some(100),
        weight: Some(1),
    };

    // Every typed provider failure enters the shared health history. A
    // typed recoverable and irrecoverable classes both cool on their first
    // failure under the current policy; ordinary 429 is covered separately.
    for (status, code, threshold) in [
        (400u16, "provider_http_400", 1u32),
        (401, "provider_http_401", 1),
    ] {
        let health = V3ProviderFailureRuntimeHealth::from_manifest(&manifest);
        let session =
            test_failure_session_scope_for("default", &format!("direct-health-threshold-{status}"));
        let plan = plan_v3_responses_protocol_execution_with_provider_health(
            &manifest,
            test_plan_http_request(
                "default",
                &format!("direct-health-threshold-{status}-request"),
                &format!("direct-health-threshold-{status}-execution"),
            ),
            health.clone(),
            100,
        )
        .expect("direct test plan");
        let source = build_v3_error_01_source_raised_external(
            V3ErrorSourceKind::ProviderFailure,
            "V3ProviderRespInbound01Raw",
            code,
            "controlled direct provider failure",
            V3ExternalErrorLink {
                kind: V3ExternalErrorKind::Provider,
                status: Some(status),
                code: Some(code.to_string()),
                provider_id: Some("openai".to_string()),
                upstream_request_id: None,
                message: Some("controlled direct provider failure".to_string()),
            },
        );
        for offset in 0..threshold {
            record_v3_direct_provider_failure_record(
                &health,
                &session,
                &plan.decision.target,
                &source,
                100 + u64::from(offset),
            )
            .expect("direct failure must be recorded");
            let projection = health
                .store()
                .scheduling_projection("openai", "key1", "gpt-test", 100, 100, 300)
                .expect("direct health projection");
            assert_eq!(
                projection.available,
                offset + 1 < threshold,
                "status {status} must stay selectable until {threshold} consecutive same-class failures are recorded"
            );
        }
    }
}
