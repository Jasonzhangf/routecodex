include!("../../tests/support/kernel_unit.rs");

#[tokio::test]
async fn provider_health_observes_failure_without_request_alternative() {
    use crate::provider_failure_runtime_policy::{
        run_v3_relay_provider_failure_policy, V3RelayProviderFailurePolicyContext,
        V3RelayProviderFailurePolicyState,
    };
    for direct in [true, false] {
        let manifest = provider_concurrency_two_provider_manifest(
            if direct { "isolated_health_direct" } else { "isolated_health_relay" },
            "unused_health_peer", 50,
        );
        let health = V3ProviderFailureRuntimeHealth::from_manifest_for_isolated_tests(&manifest);
        let scope = test_failure_session_scope("default");
        let raw = crate::nodes::build_v3_server_03_http_request_raw(
            "test".into(), scope.clone(), "independent-health".into(),
            "independent-health-exec".into(), "POST".into(), "/v1/responses".into(),
            json!({"model":"client-model","input":"hello"}),
        );
        let plan = test_protocol_plan(&manifest, raw, health.clone(), 0);
        let mut expanded = plan.expanded;
        expanded.candidates.truncate(1);
        let selected = routecodex_v3_target::V3Target10ConcreteProviderSelected {
            route: expanded.route.clone(), candidate: expanded.candidates[0].clone(),
            candidate_count: 1, unavailable_candidates: vec![], attempts: 1,
            default_floor_protected: false,
        };
        let selected_key = candidate_key(&selected.candidate);
        let mut failed = BTreeSet::new();
        let mut trace = vec![];
        let record = if direct {
            let source = build_v3_error_01_source_raised_external(
                V3ErrorSourceKind::ProviderFailure, "V3ProviderRespInbound01Raw",
                "provider_http_503", "real provider failure without an alternative",
                V3ExternalErrorLink {
                    kind: V3ExternalErrorKind::Provider, status: Some(503),
                    code: Some("HTTP_503".into()),
                    provider_id: Some(selected.candidate.provider_id.clone()),
                    upstream_request_id: None, message: Some("provider unavailable".into()),
                },
            );
            run_v3_direct_provider_failure_policy(
                &V3DirectProviderFailurePolicyContext {
                    failure_session_scope: &scope, provider_health: &health,
                    availability: &health.session_bound_availability(&scope),
                    expanded: Some(&expanded), provider_pinned: false, now_epoch_ms: 0,
                },
                &selected, source, 503,
                &mut V3DirectProviderFailurePolicyState {
                    failed_candidates: &mut failed, trace: &mut trace,
                    capacity_skipped: &BTreeSet::new(),
                },
                None,
            ).await.expect("Direct failure policy").event.unwrap().health_state
        } else {
            run_v3_relay_provider_failure_policy(
                &V3RelayProviderFailurePolicyContext {
                    manifest: &manifest, captured_target_09: Some(&expanded),
                    failure_session_scope: scope, provider_health: &health,
                    deterministic_sample: 0,
                },
                selected, "V3ProviderRespInbound01Raw", 503, Some("HTTP_503".into()),
                "real provider failure without an alternative".into(), None,
                &mut V3RelayProviderFailurePolicyState {
                    failed_candidates: &mut failed, trace: &mut trace,
                    last_external_http: &mut None,
                },
            ).await.expect("Relay failure policy").event.health_record.state
        };
        assert_eq!(record, "last_candidate_terminal",
            "a proven last candidate must terminate without a health mutation; direct={direct}");
        assert!(failed.contains(&selected_key),
            "the real failed identity must stay excluded from this request; direct={direct}");
    }
}

#[tokio::test]
async fn direct_policy_grants_last_candidate_only_to_ordinary_terminal_http_errors() {
    let manifest =
        provider_concurrency_two_provider_manifest("direct_terminal_qualified", "unused_peer", 50);
    let health = V3ProviderFailureRuntimeHealth::from_manifest_for_isolated_tests(&manifest);
    let scope = test_failure_session_scope("default");
    let raw = crate::nodes::build_v3_server_03_http_request_raw(
        "test".into(),
        scope.clone(),
        "direct-terminal-qualified".into(),
        "direct-terminal-qualified-exec".into(),
        "POST".into(),
        "/v1/responses".into(),
        json!({"model":"client-model","input":"hello"}),
    );
    let plan = test_protocol_plan(&manifest, raw, health.clone(), 0);
    let mut expanded = plan.expanded;
    expanded.candidates.truncate(1);
    let selected = routecodex_v3_target::V3Target10ConcreteProviderSelected {
        route: expanded.route.clone(),
        candidate: expanded.candidates[0].clone(),
        candidate_count: 1,
        unavailable_candidates: vec![],
        attempts: 1,
        default_floor_protected: false,
    };
    let witness = V3ExternalHttpWitness::new(
        400,
        vec![("content-type".to_string(), b"application/json".to_vec())],
        br#"{"error":{"message":"request failed"}}"#.to_vec(),
    );
    let availability = health.session_bound_availability(&scope);
    let context = V3DirectProviderFailurePolicyContext {
        failure_session_scope: &scope,
        provider_health: &health,
        availability: &availability,
        expanded: Some(&expanded),
        provider_pinned: false,
        now_epoch_ms: 0,
    };

    let ordinary = run_v3_direct_provider_failure_policy(
        &context,
        &selected,
        build_v3_error_01_source_raised_external(
            V3ErrorSourceKind::ProviderFailure,
            "V3ProviderRespInbound01Raw",
            "provider_http_400",
            "ordinary provider HTTP error",
            V3ExternalErrorLink {
                kind: V3ExternalErrorKind::Provider,
                status: Some(400),
                code: Some("provider_http_400".to_string()),
                provider_id: Some(selected.candidate.provider_id.clone()),
                upstream_request_id: None,
                message: Some("ordinary provider HTTP error".to_string()),
            },
        ),
        400,
        &mut V3DirectProviderFailurePolicyState {
            failed_candidates: &mut BTreeSet::new(),
            trace: &mut Vec::new(),
            capacity_skipped: &BTreeSet::new(),
        },
        Some(&witness),
    )
    .await
    .expect("ordinary terminal provider error");
    assert_eq!(
        ordinary.terminal_disposition,
        Some(V3ProviderTerminalDisposition::LastCandidateExternalHttp(
            witness.clone()
        ))
    );

    let request_local = run_v3_direct_provider_failure_policy(
        &context,
        &selected,
        build_v3_error_01_source_raised_external(
            V3ErrorSourceKind::ProviderFailure,
            "ProviderReqCompat06ProviderCompat",
            "provider_request_compat_error",
            "request-local provider compatibility failure",
            V3ExternalErrorLink {
                kind: V3ExternalErrorKind::Provider,
                status: Some(400),
                code: Some("provider_request_compat_error".to_string()),
                provider_id: Some(selected.candidate.provider_id.clone()),
                upstream_request_id: None,
                message: Some("request-local provider compatibility failure".to_string()),
            },
        ),
        400,
        &mut V3DirectProviderFailurePolicyState {
            failed_candidates: &mut BTreeSet::new(),
            trace: &mut Vec::new(),
            capacity_skipped: &BTreeSet::new(),
        },
        Some(&witness),
    )
    .await
    .expect("request-local terminal provider error");
    assert_eq!(
        request_local.terminal_disposition,
        Some(V3ProviderTerminalDisposition::ExternalHttp(witness)),
        "a complete witness must not upgrade a request-local compat terminal"
    );
}

async fn assert_first_byte_timeout_preserves_untried_siblings(
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
            capacity_skipped: &BTreeSet::new(),
            trace: &mut trace,
        },
        None,
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
        retry_key, sibling_key,
        "{code} must preserve the next untried complete identity"
    );
    assert!(
        failed_candidates.contains(&selected_key),
        "the failed exact key stays request-local excluded"
    );
    assert!(
        !failed_candidates.contains(&sibling_key),
        "an untried sibling auth key must remain eligible"
    );
    assert!(
        !failed_candidates.contains(&other_provider_key),
        "another provider stays eligible for this request"
    );
}

#[tokio::test]
async fn transport_hang_preserves_untried_sibling_keys_for_the_request() {
    assert_first_byte_timeout_preserves_untried_siblings(
        "V3Transport13ResponsesHttpRequest",
        routecodex_v3_error::V3_TRANSIENT_TRANSPORT_HANG_CODE,
    )
    .await;
}

#[tokio::test]
async fn sse_first_event_timeout_preserves_untried_sibling_keys_for_the_request() {
    assert_first_byte_timeout_preserves_untried_siblings(
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
    let mut trace = Vec::new();
    let mut last = None;
    let result = run_v3_relay_provider_failure_policy_with_response_source(
        &V3RelayProviderFailurePolicyContext {
            manifest: &manifest,
            captured_target_09: Some(&plan.expanded),
            failure_session_scope: scope.clone(),
            provider_health: &health,
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
    assert!(
        result.decision.action.recovery_witness().is_none(),
        "Relay reselection must not carry a Provider lifecycle witness"
    );
    assert_eq!(result.decision.action, V3Error05ExecutionAction::ReevaluateTarget);
    assert_eq!(failed, BTreeSet::from([key]));
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
            capacity_skipped: &BTreeSet::new(),
            trace: &mut trace,
        },
        None,
    )
    .await
    .expect("response processing recovery");
    assert!(
        result.decision.action.recovery_witness().is_none(),
        "request-local reselection must not carry a Provider lifecycle witness"
    );
    assert_eq!(
        result.decision.action,
        V3Error05ExecutionAction::ReevaluateTarget
    );
    assert_eq!(
        failed_candidates,
        BTreeSet::from([candidate_key(&selected.candidate)])
    );
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
    // v31: the ordinary request failure is counted immediately. The pre-cool
    // hold is only its observability substate, so the identity stays visible
    // below the ladder threshold and its own failures keep counting.
    assert_eq!(record.state, "pre_cool_observation");
    assert_eq!(record.failure_count, 1);
    assert_eq!(record.cooldown_until_ms, None);
    assert!(
        health
            .store()
            .scheduling_projection("openai", "key1", "gpt-test", 100, 100, 100)
            .unwrap()
            .available,
        "below the ladder threshold the identity stays visible"
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
        health
            .pending_precool_observations()
            .iter()
            .any(|observation| observation.provider_id == "openai"
                && observation.auth_alias.as_deref() == Some("key1")
                && observation.model_id.as_deref() == Some("gpt-test")),
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
    assert!(
        health
            .pending_precool_observations()
            .iter()
            .all(|observation| !(observation.provider_id == "openai"
                && observation.auth_alias.as_deref() == Some("key1")
                && observation.model_id.as_deref() == Some("gpt-test"))),
        "matching success cancels pending; an old observation must not revive it"
    );
    crate::provider_failure_runtime_policy::tests::complete_due_precool_failures(&health, 103)
        .await;
    assert!(
        health
            .availability("openai", Some("key1"), Some("gpt-test"), 103)
            .available,
        "a cancelled hold keeps the identity routable"
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
    let projection = health
        .store()
        .scheduling_projection("openai", "key1", "gpt-test", 100, 100, 105)
        .expect("direct health projection");
    assert_eq!(projection.score_milli, score_before_failure - 5);
    assert!(
        projection.available,
        "one effective negative observation stays below the shared threshold"
    );
    // The shared recoverable ladder counts ordinary request failures, so the
    // third consecutive same-fingerprint failure commits the cooldown.
    for cycle in 0..2u64 {
        record_v3_direct_provider_failure_record(
            &health,
            &session,
            &plan.decision.target,
            &source,
            106 + cycle,
        )
        .expect("a repeated failure counts immediately");
    }
    assert!(
        !health
            .store()
            .scheduling_projection("openai", "key1", "gpt-test", 100, 100, 108)
            .expect("direct health projection")
            .available,
        "the third consecutive request failure commits the shared threshold"
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

    // A typed 401 keeps its threshold-one committed policy. A generic typed
    // 400 is an ordinary recoverable failure and shares the consecutive
    // threshold of three. Pending observation is separate and may be canceled
    // by matching success before any commitment.
    for (status, code, threshold) in [
        (400u16, "provider_http_400", 3u32),
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
            assert_eq!(
                record.failure_count,
                u32::try_from(offset).expect("offset fits") + 1,
                "status{status} counts each ordinary request failure immediately"
            );
            let projection = health
                .store()
                .scheduling_projection("openai", "key1", "gpt-test", 100, 100, 300)
                .expect("direct health projection");
            if offset + 1 < threshold {
                assert_eq!(record.state, "pre_cool_observation");
                assert_eq!(record.cooldown_until_ms, None);
                assert!(
                    projection.available,
                    "status{status} stays visible below the ladder threshold"
                );
            } else {
                assert_eq!(
                    record.state, "cooldown",
                    "status{status} commits its ladder step at the declared threshold"
                );
                assert!(record.cooldown_until_ms.is_some());
                assert!(!projection.available);
            }
        }
        // Each qualified observation completes one deferred failure. While a
        // hold is pending the exact identity is held for observation, so the
        // below-threshold probe happens on the sibling identity after each
        // cycle instead.
        for cycle in 0..threshold {
            crate::provider_failure_runtime_policy::tests::complete_due_precool_failures(
                &health,
                101 + u64::from(cycle),
            )
            .await;
            if cycle + 1 < threshold {
                assert!(
                    health
                        .availability("openai", Some("key1"), Some("other-model"), 102)
                        .available,
                    "status{status} observations must not cool a sibling identity"
                );
            }
        }
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
