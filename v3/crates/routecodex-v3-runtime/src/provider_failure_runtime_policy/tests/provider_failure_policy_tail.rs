use super::*;

fn transport_thrash_manifest(scope: &str) -> V3Config05ManifestPublished {
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
auth = { type = "api_key", entries = [{ alias = "key1", env = "FIRST_KEY1" }, { alias = "key2", env = "FIRST_KEY2" }] }
[providers.first.models.gpt-test]
wire_name = "gpt-test"
capabilities = ["text", "tools", "reasoning"]
[providers.second]
type = "responses"
base_url = "http://second.invalid/v1"
default_model = "gpt-test"
auth = { type = "api_key", entries = [{ alias = "key1", env = "SECOND_KEY" }] }
[providers.second.models.gpt-test]
wire_name = "gpt-test"
capabilities = ["text", "tools", "reasoning"]
[route_groups.__SCOPE__.pools.client_responses]
selection = { strategy = "priority" }
match = { precedence = 10, entry_protocol = "responses", models = ["client-responses"] }
targets = [
  { kind = "provider_model", provider = "first", model = "gpt-test", key = "key1", priority = 3 },
  { kind = "provider_model", provider = "first", model = "gpt-test", key = "key2", priority = 2 },
  { kind = "provider_model", provider = "second", model = "gpt-test", key = "key1", priority = 1 }
]
[route_groups.__SCOPE__.pools.default]
selection = { strategy = "priority" }
targets = [
  { kind = "provider_model", provider = "first", model = "gpt-test", key = "key1", priority = 3 },
  { kind = "provider_model", provider = "first", model = "gpt-test", key = "key2", priority = 2 },
  { kind = "provider_model", provider = "second", model = "gpt-test", key = "key1", priority = 1 }
]
"#
    .replace("__SCOPE__", scope);
    compile_v3_config_05_manifest(
        parse_v3_config_02_authoring(&source).expect("transport-thrash authoring"),
    )
    .expect("transport-thrash manifest")
}

#[tokio::test]
async fn transport_error_excludes_only_the_failed_provider_key() {
    let manifest = transport_thrash_manifest("transport_thrash");
    let health = V3ProviderFailureRuntimeHealth::from_manifest(&manifest);
    let selected = match resolve_target(&manifest, "transport_thrash", &BTreeSet::new(), &health) {
        V3RelayProviderTargetResolution::Selected(selected) => selected,
        _ => panic!("valid fixture must select the first provider"),
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
            "transport_thrash",
            "transport_thrash",
            "session-transport-thrash",
        )
        .expect("test failure session scope"),
        provider_health: &health,
        retry_policy: V3RelayProviderFailureRetryPolicy::default(),
        deterministic_sample: 0,
    };
    let mut state = V3RelayProviderFailurePolicyState {
        failed_candidates: &mut failed_candidates,
        same_candidate_retries: &mut same_candidate_retries,
        trace: &mut trace,
    };

    let result = run_v3_relay_provider_failure_policy(
        &context,
        selected,
        "V3ProviderReqOutbound09TransportRequest",
        502,
        Some("provider_transport_error".to_string()),
        "error sending request for url".to_string(),
        None,
        &mut state,
    )
    .await
    .expect("transport failure must project through the policy");

    let reselected = result
        .retry_selected
        .expect("transport failure must reselect");
    assert_eq!(
        reselected.candidate.provider_id, "first",
        "transport failure must leave the same provider's other key selectable"
    );
    assert_eq!(
        state.failed_candidates.len(),
        1,
        "transport error must exclude only the failed provider key"
    );
    assert!(state
        .failed_candidates
        .contains(&"first:key1:gpt-test".to_string()));
    assert!(!state
        .failed_candidates
        .contains(&"first:key2:gpt-test".to_string()));
}

#[tokio::test]
async fn provider_project_step_cannot_override_terminal_projection_status() {
    let scope = "path_project_override";
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
[route_groups.__SCOPE__.pools.client_responses]
selection = { strategy = "priority" }
match = { precedence = 10, entry_protocol = "responses", models = ["client-responses"] }
targets = [
  { kind = "provider_model", provider = "first", model = "gpt-test", key = "key1", priority = 1 }
]
[route_groups.__SCOPE__.pools.default]
selection = { strategy = "priority" }
targets = [
  { kind = "provider_model", provider = "first", model = "gpt-test", key = "key1", priority = 1 }
]
[[error.provider_error_action_policy]]
policy_id = "path_only"
scope = { provider_type = "responses", model_id = "gpt-test" }
match = { http_status = 429 }
[[error.provider_error_action_policy.path]]
step = "project"
status = 429
reason_code = "path_rate_limit"
public_code = "E_PATH_RATE_LIMIT"
message_mode = "code_only"
"#
    .replace("__SCOPE__", scope);
    let manifest = compile_v3_config_05_manifest(
        parse_v3_config_02_authoring(&source).expect("path-project authoring"),
    )
    .expect("path-project manifest");
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
        failure_session_scope: test_provider_failure_scope(scope, scope, "session-path-project")
            .expect("test failure session scope"),
        provider_health: &health,
        retry_policy: V3RelayProviderFailureRetryPolicy::default(),
        deterministic_sample: 0,
    };
    let mut state = V3RelayProviderFailurePolicyState {
        failed_candidates: &mut failed_candidates,
        same_candidate_retries: &mut same_candidate_retries,
        trace: &mut trace,
    };

    let result = run_v3_relay_provider_failure_policy(
        &context,
        selected,
        "V3ProviderReqOutbound09TransportRequest",
        429,
        Some("provider_http_429".to_string()),
        "quota exceeded".to_string(),
        None,
        &mut state,
    )
    .await
    .expect("429 must project through the policy");

    let projection = result
        .terminal_projection
        .expect("default-floor exhausted 429 must be terminal");
    assert_eq!(
        projection.status, 502,
        "terminal pool exhaustion must use the declared public network error"
    );
    assert_eq!(
        projection.body["error"]["code"], "network_error",
        "project step public_code must not override terminal pool exhaustion"
    );
}

#[tokio::test]
async fn matched_response_policy_identity_drives_retry_without_message_rematch() {
    let scope = "response_policy_identity";
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
[[providers.first.response_error_policy]]
policy_id = "exact_response_policy"
[providers.first.response_error_policy.match]
http_status = 200
content_contains_any = ["original diagnostic payload"]
[[providers.first.response_error_policy.path]]
step = "wait_retry"
retry_mode = "retry_same"
max_attempts = 3
backoff_ms = 7000
backoff_multiplier = 2
[[providers.first.response_error_policy.path]]
step = "project"
status = 503
reason_code = "wrapped_provider_error"
public_code = "E_WRAPPED_PROVIDER"
message_mode = "code_only"
[[providers.first.response_error_policy]]
policy_id = "reselect_then_retry_policy"
[providers.first.response_error_policy.match]
http_status = 429
[[providers.first.response_error_policy.path]]
step = "wait_retry"
retry_mode = "reselect_before_client_projection"
max_attempts = 3
backoff_ms = 5000
[[providers.first.response_error_policy.path]]
step = "project"
status = 503
reason_code = "reselect_exhausted"
public_code = "E_RESELECT_EXHAUSTED"
message_mode = "code_only"
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
        parse_v3_config_02_authoring(&source).expect("response-policy authoring"),
    )
    .expect("response-policy manifest");
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
        failure_session_scope: test_provider_failure_scope(scope, scope, "session-policy-id")
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
        "compressed message no longer contains configured keyword".to_string(),
        None,
        &mut V3RelayProviderFailurePolicyState {
            failed_candidates: &mut failed_candidates,
            same_candidate_retries: &mut same_candidate_retries,
            trace: &mut trace,
        },
    )
    .await
    .expect("exact matched policy must drive Error05");

    assert_eq!(result.event.action, "policy_retry_same");
    assert_eq!(result.event.wait_ms, Some(7000));
    assert!(result.retry_selected.is_some());
    assert_eq!(same_candidate_retries.values().copied().next(), Some(1));
}
