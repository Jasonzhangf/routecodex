use super::*;
use routecodex_v3_config::{compile_v3_config_05_manifest, parse_v3_config_02_authoring};

#[tokio::test]
async fn transient_terminal_projection_releases_action_admission() {
    let scope = "transient_terminal_projection";
    let manifest = target_resolution_manifest(scope);
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
            "session-transient-terminal",
        )
        .expect("test failure session scope"),
        provider_health: &health,
        retry_policy: V3RelayProviderFailureRetryPolicy::default(),
        deterministic_sample: 0,
    };

    let result = tokio::time::timeout(
        std::time::Duration::from_secs(6),
        run_v3_relay_provider_failure_policy(
            &context,
            selected,
            "V3ProviderRespInbound01Raw",
            200,
            Some("wrapped_provider_error".to_string()),
            "provider returned an embedded error".to_string(),
            None,
            &mut V3RelayProviderFailurePolicyState {
                failed_candidates: &mut failed_candidates,
                same_candidate_retries: &mut same_candidate_retries,
                trace: &mut trace,
            },
        ),
    )
    .await
    .expect("terminal projection must not wait on its own transient admission")
    .expect("transient provider failure must project through Error05");

    assert!(
        matches!(
            result.event.action.as_str(),
            "terminal_default_floor_exhausted" | "terminal_route_and_default_exhausted"
        ),
        "unexpected terminal action: {}",
        result.event.action
    );
    assert!(result.retry_selected.is_none());
    assert!(result.terminal_projection.is_some());
}

#[tokio::test]
async fn reselect_before_client_projection_does_not_retry_same_when_pool_exhausted() {
    let scope = "response_policy_reselect_exhausted";
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
    let matched_policy = manifest
        .error
        .provider_error_action_policy
        .iter()
        .find(|policy| policy.policy_id == "reselect_then_retry_policy")
        .expect("compiled reselect policy");
    let result = run_v3_relay_provider_failure_policy(
        &context,
        selected,
        "V3ProviderRespInbound01Raw",
        429,
        Some("provider_http_429".to_string()),
        "provider rate limited and no alternative remains".to_string(),
        Some(matched_policy),
        &mut V3RelayProviderFailurePolicyState {
            failed_candidates: &mut failed_candidates,
            same_candidate_retries: &mut same_candidate_retries,
            trace: &mut trace,
        },
    )
    .await
    .expect("reselect-before-projection policy must drive Error05");

    assert!(
        matches!(
            result.event.action.as_str(),
            "terminal_default_floor_exhausted" | "terminal_route_and_default_exhausted"
        ),
        "unexpected terminal action: {}",
        result.event.action
    );
    assert!(result.retry_selected.is_none());
    assert!(
        same_candidate_retries.values().all(|retries| *retries == 0),
        "reselect exhaustion must not consume a same-candidate retry budget"
    );
    assert!(!trace.contains(&"V3TargetLocalRetried"));
    assert!(!trace.contains(&"V3DefaultFloorBackoffWait"));
}

#[tokio::test]
async fn request_local_compat_with_retry_same_policy_does_not_retry_same() {
    let scope = "request_local_retry_same";
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
policy_id = "retry_same_policy"
[providers.first.response_error_policy.match]
http_status = 502
[[providers.first.response_error_policy.path]]
step = "wait_retry"
retry_mode = "retry_same"
max_attempts = 3
backoff_ms = 7000
[[providers.first.response_error_policy.path]]
step = "project"
status = 503
reason_code = "request_local_retry_exhausted"
public_code = "E_REQUEST_LOCAL"
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
        retry_policy: V3RelayProviderFailureRetryPolicy {
            same_candidate_retries: 3,
        },
        deterministic_sample: 0,
    };
    let matched_policy = manifest
        .error
        .provider_error_action_policy
        .iter()
        .find(|policy| policy.policy_id == "retry_same_policy")
        .expect("compiled retry policy");
    let result = run_v3_relay_provider_failure_policy(
        &context,
        selected,
        "ProviderReqCompat06ProviderCompat",
        502,
        Some("provider_request_compat_error".to_string()),
        "arguments must be valid JSON".to_string(),
        Some(matched_policy),
        &mut V3RelayProviderFailurePolicyState {
            failed_candidates: &mut failed_candidates,
            same_candidate_retries: &mut same_candidate_retries,
            trace: &mut trace,
        },
    )
    .await
    .expect("request-local compat failure must project terminally");

    assert_eq!(
        result.event.action,
        "terminal_request_local_provider_compat_exhausted"
    );
    assert!(result.retry_selected.is_none());
    assert!(
        same_candidate_retries.values().all(|retries| *retries == 0),
        "request-local compat must not consume a same-candidate retry budget"
    );
    assert!(!trace.contains(&"V3TargetPolicyRetriedSame"));
}
