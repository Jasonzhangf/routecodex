#[tokio::test]
async fn unmatched_transient_last_candidate_recovery_is_admissible() {
    let scope = "unmatched_transient_terminal";
    let source = r#"
version = 3
[servers.__SCOPE__]
bind = "127.0.0.1"
port = 5555
routing_group = "__SCOPE__"
endpoints = ["responses"]
[providers.first]
type = "responses"
base_url = "http://first.invalid/v1"
default_model = "gpt-test"
auth = { type = "api_key", entries = [{ alias = "key1", env = "FIRST_KEY" }] }
[providers.first.models.gpt-test]
wire_name = "gpt-test"
capabilities = ["text", "tools"]
[route_groups.__SCOPE__.pools.default]
selection = { strategy = "priority" }
targets = [
  { kind = "provider_model", provider = "first", model = "gpt-test", key = "key1", priority = 1 }
]
"#
    .replace("__SCOPE__", scope);
    let manifest = compile_v3_config_05_manifest(
        parse_v3_config_02_authoring(&source).expect("unmatched-transient authoring"),
    )
    .expect("unmatched-transient manifest");
    let health = V3ProviderFailureRuntimeHealth::from_manifest(&manifest);
    let selected = match resolve_target(&manifest, scope, &BTreeSet::new(), &health) {
        V3RelayProviderTargetResolution::Selected(selected) => selected,
        _ => panic!("valid fixture must select the provider"),
    };
    let mut failed_candidates = BTreeSet::new();
    let mut same_candidate_retries = BTreeMap::new();
    let mut trace = Vec::new();
    let context = V3RelayProviderFailurePolicyContext {
        manifest: &manifest,
        captured_target_09: None,
        failure_session_scope: test_provider_failure_scope(
            scope,
            scope,
            "session-unmatched-transient",
        )
        .expect("test failure session scope"),
        provider_health: &health,
        retry_policy: V3RelayProviderFailureRetryPolicy::default(),
        deterministic_sample: 0,
    };
    let result = run_v3_relay_provider_failure_policy(
        &context,
        selected,
        "V3ProviderRespInbound01Raw",
        200,
        Some("wrapped_provider_error".to_string()),
        "transient SSE body without a configured response policy".to_string(),
        None,
        &mut V3RelayProviderFailurePolicyState {
            failed_candidates: &mut failed_candidates,
            same_candidate_retries: &mut same_candidate_retries,
            trace: &mut trace,
            last_external_http: &mut None,
        },
    )
    .await
    .expect("unmatched transient must project through the policy");

    assert_eq!(result.event.action, "retry_last_routable");
    assert_eq!(result.event.wait_ms, Some(1_000));
    assert!(same_candidate_retries.is_empty());
    assert!(result.terminal_projection.is_none());
    let V3Error05ExecutionAction::WaitThenRetrySame { recovery } = &result.decision.action else {
        panic!("last candidate must retain its recovery witness");
    };
    let transition = health
        .wait_for_error05_recovery(
            recovery,
            result
                .retry_selected
                .as_ref()
                .expect("last candidate retained"),
            std::time::Instant::now() + std::time::Duration::from_secs(3),
        )
        .await
        .expect("unmatched transient recovery must remain admissible");
    assert!(matches!(
        transition,
        crate::provider_action_gate::V3ProviderActionRecoveryTransition::Admitted(_)
    ));
}

#[tokio::test]
async fn unmatched_transient_reselect_keeps_returned_recovery_witness_admissible() {
    let manifest = transport_thrash_manifest("unmatched_transient_reselect");
    let health = V3ProviderFailureRuntimeHealth::from_manifest(&manifest);
    let selected = match resolve_target(
        &manifest,
        "unmatched_transient_reselect",
        &BTreeSet::new(),
        &health,
    ) {
        V3RelayProviderTargetResolution::Selected(selected) => selected,
        _ => panic!("valid fixture must select a provider"),
    };
    assert_eq!(selected.candidate.provider_id, "first");
    assert_eq!(selected.candidate.auth_alias, "key1");
    let target = V3TargetInterpreter::default();
    let captured_target_09 = target
        .expand_candidates(&manifest, target.classify_kind(selected.route.clone()), 0)
        .expect("capture Target09 before execution");
    let mut failed_candidates = BTreeSet::new();
    let mut same_candidate_retries = BTreeMap::new();
    let mut trace = Vec::new();
    let context = V3RelayProviderFailurePolicyContext {
        manifest: &manifest,
        captured_target_09: Some(&captured_target_09),
        failure_session_scope: test_provider_failure_scope(
            "unmatched_transient_reselect",
            "unmatched_transient_reselect",
            "session-unmatched-transient-reselect",
        )
        .expect("test failure session scope"),
        provider_health: &health,
        retry_policy: V3RelayProviderFailureRetryPolicy::default(),
        deterministic_sample: 0,
    };
    let result = run_v3_relay_provider_failure_policy(
        &context,
        selected,
        "V3ProviderRespInbound01Raw",
        200,
        Some("wrapped_provider_error".to_string()),
        "transient SSE body without a configured response policy".to_string(),
        None,
        &mut V3RelayProviderFailurePolicyState {
            failed_candidates: &mut failed_candidates,
            same_candidate_retries: &mut same_candidate_retries,
            trace: &mut trace,
            last_external_http: &mut None,
        },
    )
    .await
    .expect("unmatched transient must project through the policy");

    assert_eq!(result.event.action, "switch_provider");
    assert!(result.event.wait_ms.is_some());
    let reselected = result
        .retry_selected
        .as_ref()
        .expect("unmatched transient with an alternative must reselect");
    assert_ne!(
        v3_relay_provider_candidate_key(&reselected.candidate),
        v3_relay_provider_candidate_key(&result.event.candidate)
    );
    let V3Error05ExecutionAction::WaitThenReselect { recovery } = &result.decision.action else {
        panic!("unmatched transient alternative must return a reselect recovery witness");
    };

    let transition = tokio::time::timeout(
        Duration::from_secs(30),
        health.wait_for_error05_recovery(
            recovery,
            reselected,
            std::time::Instant::now() + Duration::from_secs(30),
        ),
    )
    .await
    .expect("unmatched transient reselect must not hang on recovery admission")
    .expect("recovery wait must not fail");
    assert!(
        matches!(transition, V3ProviderActionRecoveryTransition::Admitted(_)),
        "returned recovery witness must remain admissible, got: {transition:?}"
    );
}
