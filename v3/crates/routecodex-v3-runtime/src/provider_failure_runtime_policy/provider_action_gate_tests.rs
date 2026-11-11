#[tokio::test]
async fn unmatched_transient_error_releases_transient_admission_before_terminal_wait() {
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

    assert_eq!(result.event.action, "terminal_route_and_default_exhausted");
    assert!(result.retry_selected.is_none());
    assert!(same_candidate_retries.is_empty());
    let projection = result
        .terminal_projection
        .expect("unmatched transient exhaustion must be terminal");
    assert_eq!(projection.status, 502);
    assert_eq!(projection.body["error"]["code"], "network_error");
}
