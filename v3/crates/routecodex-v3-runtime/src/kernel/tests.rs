include!("../../tests/support/kernel_unit.rs");

async fn assert_first_byte_timeout_excludes_same_provider_siblings(
    source_stage: &'static str,
    code: &'static str,
) {
    use crate::provider_failure_runtime_policy::V3ProviderFailureRuntimeHealth;
    use routecodex_v3_error::V3Error05ExecutionAction;

    let manifest = provider_concurrency_two_key_then_other_provider_manifest(
        "hang_sibling_a",
        "hang_sibling_b",
        80,
    );
    let health = V3ProviderFailureRuntimeHealth::from_manifest_for_isolated_tests(&manifest);
    let scope = test_failure_session_scope("default");
    let raw = crate::nodes::build_v3_server_03_http_request_raw(
        "test".into(),
        scope.clone(),
        "hang-sibling".into(),
        "hang-sibling-exec".into(),
        "POST".into(),
        "/v1/responses".into(),
        json!({"model":"client-model","input":"hello"}),
    );
    let plan = test_protocol_plan(&manifest, raw, health.clone(), 0);
    let selected = routecodex_v3_target::V3Target10ConcreteProviderSelected {
        route: plan.expanded.route.clone(),
        candidate: plan.expanded.candidates[0].clone(),
        candidate_count: plan.expanded.candidates.len(),
        unavailable_candidates: Vec::new(),
        attempts: 1,
        default_floor_protected: false,
    };
    let selected_key = candidate_key(&selected.candidate);
    let sibling_key = candidate_key(&plan.expanded.candidates[1]);
    let other_provider_key = candidate_key(&plan.expanded.candidates[2]);
    assert_eq!(selected.candidate.provider_id, "hang_sibling_a");
    assert_eq!(selected.candidate.auth_alias, "key1");
    assert_eq!(sibling_key, format!("hang_sibling_a:default:key2:test"));
    assert_eq!(
        other_provider_key,
        format!("hang_sibling_b:default:key:test")
    );

    let availability = health.session_bound_availability(&scope);
    let source = crate::shared::direct_external_error(
        V3ErrorSourceKind::ProviderFailure,
        source_stage,
        code,
        "provider did not produce a first byte within the configured first-frame timeout",
        V3ExternalErrorLink {
            kind: V3ExternalErrorKind::Provider,
            status: None,
            code: Some(code.to_string()),
            provider_id: Some("hang_sibling_a".to_string()),
            upstream_request_id: None,
            message: Some(
                "provider did not produce a first byte within the configured first-frame timeout"
                    .to_string(),
            ),
        },
    )
    .expect("typed first-byte timeout source");
    let mut failed_candidates = BTreeSet::new();
    let mut retries = std::collections::BTreeMap::new();
    let mut trace = Vec::new();
    let result = run_v3_direct_provider_failure_policy(
        &V3DirectProviderFailurePolicyContext {
            failure_session_scope: &scope,
            provider_health: &health,
            availability: &availability,
            expanded: Some(&plan.expanded),
            provider_pinned: false,
            now_epoch_ms: 0,
        },
        &selected,
        source,
        502,
        &mut V3DirectProviderFailurePolicyState {
            failed_candidates: &mut failed_candidates,
            same_candidate_retries: &mut retries,
            trace: &mut trace,
        },
    )
    .await
    .expect("first-byte timeout policy");
    let matches_reselect = matches!(
        result.decision.action,
        V3Error05ExecutionAction::WaitThenReselect { .. }
            | V3Error05ExecutionAction::ReevaluateTarget
    );
    if !matches_reselect {
        panic!(
            "{code} must reselect away from the failed provider: {:?}",
            result.decision.action,
        );
    }
    let retry_key = result
        .event
        .as_ref()
        .and_then(|event| event.next_provider_key.clone())
        .expect("first-byte timeout must publish the concrete next candidate");
    assert_eq!(
        retry_key, other_provider_key,
        "{code} must skip the same provider's sibling auth key"
    );
    assert!(
        failed_candidates.contains(&selected_key),
        "the failed exact key stays request-local excluded"
    );
    assert!(
        failed_candidates.contains(&sibling_key),
        "the same provider's sibling auth key is excluded for this request"
    );
    assert!(
        !failed_candidates.contains(&other_provider_key),
        "another provider stays eligible for this request"
    );
}

#[tokio::test]
async fn transport_hang_excludes_same_provider_sibling_keys_for_the_request() {
    assert_first_byte_timeout_excludes_same_provider_siblings(
        "V3Transport13ResponsesHttpRequest",
        routecodex_v3_error::V3_TRANSIENT_TRANSPORT_HANG_CODE,
    )
    .await;
}

#[tokio::test]
async fn sse_first_event_timeout_excludes_same_provider_sibling_keys_for_the_request() {
    assert_first_byte_timeout_excludes_same_provider_siblings(
        "V3ProviderResp14Raw",
        "provider_response_sse_first_event_timeout",
    )
    .await;
}

#[tokio::test]
async fn relay_serialized_tool_recovery_is_typed_exact_and_health_neutral() {
    use crate::provider_failure_runtime_policy::{
        run_v3_relay_provider_failure_policy_with_response_source,
        V3RelayProviderFailurePolicyContext, V3RelayProviderFailurePolicyState,
        V3RelayProviderFailureRetryPolicy,
    };
    let manifest =
        provider_concurrency_two_provider_manifest("relay_markup_a", "relay_markup_b", 50);
    let health = V3ProviderFailureRuntimeHealth::from_manifest_for_isolated_tests(&manifest);
    let scope = test_failure_session_scope("default");
    let raw = crate::nodes::build_v3_server_03_http_request_raw(
        "test".into(),
        scope.clone(),
        "relay-markup".into(),
        "relay-markup-exec".into(),
        "POST".into(),
        "/v1/responses".into(),
        json!({"model":"client-model","input":"hello"}),
    );
    let plan = test_protocol_plan(&manifest, raw, health.clone(), 0);
    let selected = routecodex_v3_target::V3Target10ConcreteProviderSelected {
        route: plan.expanded.route.clone(),
        candidate: plan.expanded.candidates[0].clone(),
        candidate_count: 2,
        unavailable_candidates: vec![],
        attempts: 1,
        default_floor_protected: false,
    };
    let key = candidate_key(&selected.candidate);
    let before: Vec<_> = plan
        .expanded
        .candidates
        .iter()
        .map(|candidate| {
            health.availability_for_interface(
                &candidate.provider_id,
                &candidate.interface_id,
                Some(&candidate.auth_alias),
                Some(&candidate.model_id),
                0,
            )
        })
        .collect();
    let mut failed = BTreeSet::new();
    let mut retries = std::collections::BTreeMap::new();
    let mut trace = Vec::new();
    let mut last = None;
    let result = run_v3_relay_provider_failure_policy_with_response_source(
        &V3RelayProviderFailurePolicyContext {
            manifest: &manifest,
            captured_target_09: Some(&plan.expanded),
            failure_session_scope: scope.clone(),
            provider_health: &health,
            retry_policy: V3RelayProviderFailureRetryPolicy::default(),
            deterministic_sample: 0,
        },
        selected,
        "V3HubRespChatProcess03Governed",
        502,
        Some("relay_unharvestable_tool_markup".into()),
        "recognized partial invocation".into(),
        None,
        &mut V3RelayProviderFailurePolicyState {
            failed_candidates: &mut failed,
            same_candidate_retries: &mut retries,
            trace: &mut trace,
            last_external_http: &mut last,
        },
        Some(routecodex_v3_error::V3InternalErrorCode::V3HubRelayResp03UnharvestableToolMarkup),
        None,
        None,
        None,
    )
    .await
    .expect("typed Relay recovery");
    let V3Error05ExecutionAction::WaitThenReselect { recovery } = result.decision.action else {
        panic!("expected reselection")
    };
    assert_eq!(recovery.provider_runtime_identity(), key);
    assert_eq!(recovery.failure_session_scope(), &scope);
    assert_eq!(failed, BTreeSet::from([key]));
    assert!(retries.is_empty());
    assert_eq!(
        result.event.diagnostic_source.source_kind,
        V3ErrorSourceKind::RuntimeFailure
    );
    assert_eq!(
        result
            .event
            .diagnostic_source
            .internal_error
            .as_ref()
            .unwrap()
            .internal_code,
        "500-231"
    );
    assert_eq!(result.event.status, 502);
    assert_eq!(result.event.health_record.failure_count, 0);
    assert_eq!(result.event.health_record.cooldown_until_ms, None);
    for (candidate, before) in plan.expanded.candidates.iter().zip(before) {
        assert_eq!(
            health.availability_for_interface(
                &candidate.provider_id,
                &candidate.interface_id,
                Some(&candidate.auth_alias),
                Some(&candidate.model_id),
                0
            ),
            before
        );
    }
}

#[tokio::test]
async fn direct_tool_markup_recovery_is_exact_and_health_neutral() {
    let manifest = provider_concurrency_two_provider_manifest("markup_a", "markup_b", 50);
    let health = V3ProviderFailureRuntimeHealth::from_manifest_for_isolated_tests(&manifest);
    let scope = test_failure_session_scope("default");
    let raw = crate::nodes::build_v3_server_03_http_request_raw(
        "test".into(),
        scope.clone(),
        "markup-policy".into(),
        "markup-execution".into(),
        "POST".into(),
        "/v1/responses".into(),
        json!({"model":"client-model","input":"hello"}),
    );
    let plan = test_protocol_plan(&manifest, raw, health.clone(), 0);
    let selected = routecodex_v3_target::V3Target10ConcreteProviderSelected {
        route: plan.expanded.route.clone(),
        candidate: plan.expanded.candidates[0].clone(),
        candidate_count: 2,
        unavailable_candidates: vec![],
        attempts: 1,
        default_floor_protected: false,
    };
    let availability = health.session_bound_availability(&scope);
    let before: Vec<_> = plan
        .expanded
        .candidates
        .iter()
        .map(|c| {
            health.availability_for_interface(
                &c.provider_id,
                &c.interface_id,
                Some(&c.auth_alias),
                Some(&c.model_id),
                0,
            )
        })
        .collect();
    let source = crate::hooks::direct_complete_response_hook_failure_source(
        crate::direct_response_hooks::V3DirectResponseHookFailure::UnharvestableToolMarkup,
    )
    .expect("typed markup source");
    assert_eq!(source.source_kind, V3ErrorSourceKind::RuntimeFailure);
    let mut failed_candidates = BTreeSet::new();
    let mut retries = std::collections::BTreeMap::new();
    let mut trace = vec![];
    let result = run_v3_direct_provider_failure_policy(
        &V3DirectProviderFailurePolicyContext {
            failure_session_scope: &scope,
            provider_health: &health,
            availability: &availability,
            expanded: Some(&plan.expanded),
            provider_pinned: false,
            now_epoch_ms: 0,
        },
        &selected,
        source.clone(),
        200,
        &mut V3DirectProviderFailurePolicyState {
            failed_candidates: &mut failed_candidates,
            same_candidate_retries: &mut retries,
            trace: &mut trace,
        },
    )
    .await
    .expect("response processing recovery");
    let V3Error05ExecutionAction::WaitThenReselect { recovery } = &result.decision.action else {
        panic!(
            "must reselect through Error05: {:?}",
            result.decision.action
        );
    };
    assert_eq!(recovery.normalized_error_family(), source.code);
    assert_eq!(recovery.failure_session_scope(), &scope);
    assert_eq!(
        recovery.provider_runtime_identity(),
        candidate_key(&selected.candidate)
    );
    assert_eq!(
        failed_candidates,
        BTreeSet::from([candidate_key(&selected.candidate)])
    );
    assert!(retries.is_empty());
    assert!(trace.contains(&"V3Error01SourceRaised"));
    assert!(trace.contains(&"V3Error05ExecutionDecision"));
    let event = result.event.expect("typed failure observation");
    assert_eq!(event.status, 599);
    assert_eq!(event.external_error_status, Some(200));
    assert_eq!(event.internal_code.as_deref(), Some("500-211"));
    assert_eq!(event.failure_count, 0);
    assert_eq!(event.cooldown_until_ms, None);
    for (candidate, before) in plan.expanded.candidates.iter().zip(before) {
        let after = health.availability_for_interface(
            &candidate.provider_id,
            &candidate.interface_id,
            Some(&candidate.auth_alias),
            Some(&candidate.model_id),
            0,
        );
        assert_eq!(after, before, "no provider health mutation");
    }
}

#[test]
fn protocol_candidate_keys_raise_only_actual_failures() {
    let manifest = test_manifest();
    let raw = crate::nodes::build_v3_server_03_http_request_raw(
        "test".into(),
        test_failure_session_scope("default"),
        "protocol-candidate-errors".into(),
        "protocol-candidate-errors-exec".into(),
        "POST".into(),
        "/v1/responses".into(),
        json!({"model":"client-model","input":"hello"}),
    );
    let plan = plan_v3_responses_protocol_execution_with_provider_health(
        &manifest,
        raw,
        V3ProviderFailureRuntimeHealth::from_manifest(&manifest),
        0,
    )
    .expect("baseline plan");
    let mut expanded = plan.expanded;
    let mut relay_only = expanded.candidates[0].clone();
    relay_only.model_id = "relay-only".into();
    relay_only.responses_process = Some("chat".into());
    expanded.candidates.push(relay_only);
    let allowed_modes = vec!["direct".to_string()];
    let count = crate::operation_runner::err01_execution_count_for_test;
    let before = count();
    let keys = protocol_candidate_keys_for_decision_mode(
        &expanded,
        "responses",
        &allowed_modes,
        V3Execution11ProtocolDecisionMode::SameProtocolDirect,
    )
    .expect("retain the compatible candidate");
    assert_eq!(keys.len(), 1);
    assert_eq!(count() - before, 0, "candidate exclusions are not failures");

    let before = count();
    let source = expect_ordinary_source(protocol_candidate_keys_for_decision_mode(
        &expanded,
        "unsupported",
        &allowed_modes,
        V3Execution11ProtocolDecisionMode::SameProtocolDirect,
    ));
    assert_eq!(source.code, "entry_protocol_unresolved");
    assert_eq!(count() - before, 1);

    let before = count();
    let source = expect_ordinary_source(protocol_candidate_keys_for_decision_mode(
        &expanded,
        "gemini",
        &allowed_modes,
        V3Execution11ProtocolDecisionMode::SameProtocolDirect,
    ));
    assert_eq!(source.code, "protocol_mode_candidate_set_empty");
    assert_eq!(count() - before, 1, "only the empty-set outcome is raised");
}

#[test]
fn direct_source_fault_preserves_http_witness_observability_and_snapshots() {
    let source = routecodex_v3_error::build_v3_error_01_source_raised(
        V3ErrorSourceKind::RuntimeFailure,
        "V3Provider12ResponsesWirePayload",
        "seeded_direct_source",
        "seeded direct source",
    );
    let fault = crate::provider_failure_runtime_policy::finish_v3_relay_error_projection(
        source.clone(),
        Ok(None),
    )
    .expect_err("missing terminal Error06 is a typed SDK fault");
    let diagnostic_source = fault.policy_failure.clone();
    let diagnostic_cause = fault
        .original_source
        .clone()
        .expect("the SDK fault keeps its original source");
    assert_eq!(diagnostic_cause, source);
    let witness = routecodex_v3_error::V3ExternalHttpWitness::new(
        429,
        vec![("retry-after".to_string(), b"3".to_vec())],
        br#"{"error":{"type":"rate_limit_error"}}"#.to_vec(),
    );
    let observability = V3RuntimeObservability {
        entry_protocol: "responses".to_string(),
        execution_mode: "direct".to_string(),
        transport: "sse".to_string(),
        attempts: Some(2),
        ..Default::default()
    };
    let request_snapshot = json!({"model":"route-alias","tools":[{"name":"echo"}]});
    let trace = vec!["V3Target10ConcreteProviderSelected"];

    let output = source_failure_output_with_observability_and_snapshots(
        Err(fault),
        Some(witness.clone()),
        trace.clone(),
        &crate::hooks::register_responses_direct_hooks(),
        Some(observability.clone()),
        Some(request_snapshot.clone()),
        None,
    );

    assert_eq!(output.observability, Some(observability));
    assert_eq!(
        output.terminal_disposition,
        Some(V3ProviderTerminalDisposition::ExternalHttp(witness))
    );
    assert_eq!(output.provider_request_snapshot, Some(request_snapshot));
    assert!(output.error_chain.is_none());
    assert_eq!(output.node_trace, trace);
    assert_eq!(output.diagnostic_source, Some(diagnostic_source));
    assert_eq!(output.diagnostic_cause, Some(diagnostic_cause));
    assert_eq!(output.client_payload.status, 599);
    assert!(matches!(
        &output.client_payload.body,
        crate::nodes::V3ClientBody::Json(value) if value.is_null()
    ));
}

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
    let source = match direct_attempt_store_error_source(
        crate::nodes::V3AttemptStoreError::ResidenceDeadlineExceeded("expired".into()),
        "V3ExecutionAttemptPayloadStore",
        "direct_sse_attempt_store_rejected",
    ) {
        Ok(source) => source,
        Err(fault) => panic!("unexpected SDK fault: {fault:?}"),
    };
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

    let source = match direct_attempt_store_error_source(
        crate::nodes::V3AttemptStoreError::LocalResourceExhausted("byte cap".into()),
        "V3ExecutionAttemptPayloadStore",
        "direct_sse_attempt_store_rejected",
    ) {
        Ok(source) => source,
        Err(fault) => panic!("unexpected SDK fault: {fault:?}"),
    };
    assert_eq!(source.source_kind, V3ErrorSourceKind::RuntimeFailure);
    assert_eq!(source.code, "direct_sse_attempt_store_rejected");
}

#[cfg(test)]
#[tokio::test]
async fn normal_direct_request_does_not_consume_unrelated_provider_failure_gate() {
    run_normal_direct_request_does_not_consume_unrelated_provider_failure_gate().await;
}

#[tokio::test]
async fn direct_provider_failure_blocks_after_configured_threshold() {
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
    let health = V3ProviderFailureRuntimeHealth::from_manifest_for_isolated_tests(&manifest);
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

    let record = record_v3_direct_provider_failure_record(
        &health,
        &session,
        &plan.decision.target,
        &source,
        100,
    )
    .expect("direct failure must enter observation");
    assert_eq!(record.state, "pre_cool_observation");
    assert_eq!(record.failure_count, 0);
    assert_eq!(record.cooldown_until_ms, None);
    assert!(
        health
            .store()
            .scheduling_projection("openai", "key1", "gpt-test", 100, 100, 100)
            .unwrap()
            .available,
        "observation must not commit health cooldown"
    );
    let receipt = V3AttemptSuccessReceipt::from_buffered_terminal_attempt();
    health
        .record_provider_success_in_failure_scope(
            &receipt,
            &session,
            "openai",
            Some("key1"),
            Some("other-model"),
            101,
        )
        .unwrap();
    assert!(
        !health
            .availability("openai", Some("key1"), Some("gpt-test"), 101)
            .available,
        "another model's success cannot release this exact pending identity"
    );
    health
        .record_provider_success_in_failure_scope(
            &receipt,
            &session,
            "openai",
            Some("key1"),
            Some("gpt-test"),
            102,
        )
        .unwrap();
    crate::provider_failure_runtime_policy::tests::complete_due_precool_failures(&health, 103)
        .await;
    assert!(
        health
            .availability("openai", Some("key1"), Some("gpt-test"), 103)
            .available,
        "matching success cancels pending; an old observation must not revive it"
    );
    let score_before_failure = health
        .store()
        .scheduling_projection("openai", "key1", "gpt-test", 100, 100, 103)
        .unwrap()
        .score_milli;
    record_v3_direct_provider_failure_record(
        &health,
        &session,
        &plan.decision.target,
        &source,
        104,
    )
    .expect("a new failure opens its own observation");
    crate::provider_failure_runtime_policy::tests::complete_due_precool_failures(&health, 105)
        .await;
    let projection = health
        .store()
        .scheduling_projection("openai", "key1", "gpt-test", 100, 100, 105)
        .expect("direct health projection");
    assert_eq!(projection.score_milli, score_before_failure - 5);
    assert!(
        !projection.available,
        "threshold1 applies only after an effective negative observation"
    );
}

#[tokio::test]
async fn direct_provider_failure_thresholds_cover_400_and_401_classes() {
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

    // Threshold1 remains a committed health policy. Pending observation is
    // separate and may be canceled by matching success before any commitment.
    for (status, code, threshold) in [
        (400u16, "provider_http_400", 1u32),
        (401, "provider_http_401", 1),
    ] {
        let health = V3ProviderFailureRuntimeHealth::from_manifest_for_isolated_tests(&manifest);
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
            let record = record_v3_direct_provider_failure_record(
                &health,
                &session,
                &plan.decision.target,
                &source,
                100 + u64::from(offset),
            )
            .expect("direct failure must be recorded");
            assert_eq!(record.state, "pre_cool_observation");
            assert_eq!(record.cooldown_until_ms, None);
            let projection = health
                .store()
                .scheduling_projection("openai", "key1", "gpt-test", 100, 100, 300)
                .expect("direct health projection");
            assert!(
                projection.available,
                "status{status} must not commit cooldown before observation"
            );
        }
        crate::provider_failure_runtime_policy::tests::complete_due_precool_failures(&health, 101)
            .await;
        assert!(
            !health
                .store()
                .scheduling_projection("openai", "key1", "gpt-test", 100, 100, 102)
                .unwrap()
                .available,
            "status{status} commits the original failure after negative observation"
        );
        assert!(
            health
                .availability("openai", Some("key1"), Some("other-model"), 102)
                .available,
            "the observed failure cannot cool a sibling identity"
        );
        health
            .record_provider_success_in_failure_scope(
                &V3AttemptSuccessReceipt::from_buffered_terminal_attempt(),
                &session,
                "openai",
                Some("key1"),
                Some("gpt-test"),
                103,
            )
            .unwrap();
        assert!(
            health
                .availability("openai", Some("key1"), Some("gpt-test"), 103)
                .available
        );
    }
}

#[test]
fn responses_direct_transport_header_timeout_keeps_120_second_budget() {
    let manifest =
        provider_concurrency_two_key_then_other_provider_manifest("remote_a", "remote_b", 80);
    assert_eq!(
        super::default_transport::responses_direct_transport_response_timeout(
            &manifest, "remote_a"
        ),
        Duration::from_millis(60_000),
        "a provider without an explicit override keeps the published default"
    );
    assert_eq!(
        super::default_transport::responses_direct_transport_response_timeout(&manifest, "absent"),
        Duration::from_millis(120_000),
        "a missing provider entry keeps the remote first-byte budget"
    );
}
