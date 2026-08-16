use super::*;
use routecodex_v3_config::{compile_v3_config_05_manifest, parse_v3_config_02_authoring};
use serde_json::json;

fn test_provider_failure_scope(
    server_id: &str,
    routing_group: &str,
    session_id: &str,
) -> Result<V3ProviderFailureSessionScope, String> {
    V3ProviderFailureSessionScope::new(server_id, routing_group, session_id)
}

fn target_resolution_manifest(scope: &str) -> V3Config05ManifestPublished {
    let source = r#"
version = 3
[servers.__SCOPE__]
bind = "127.0.0.1"
port = 5555
routing_group = "__SCOPE__"
endpoints = ["responses"]
[providers.primary]
type = "responses"
base_url = "http://primary.invalid/v1"
default_model = "gpt-test"
auth = { type = "api_key", entries = [{ alias = "key1", env = "PRIMARY_KEY" }] }
[providers.primary.models.gpt-test]
wire_name = "gpt-test"
supports_streaming = true
supports_thinking = true
capabilities = ["text", "tools", "reasoning"]
[route_groups.__SCOPE__.pools.client_responses]
selection = { strategy = "priority" }
match = { precedence = 10, entry_protocol = "responses", models = ["client-responses"] }
targets = [
  { kind = "provider_model", provider = "primary", model = "gpt-test", key = "key1", priority = 1 }
]
[route_groups.__SCOPE__.pools.default]
selection = { strategy = "priority" }
targets = [
  { kind = "provider_model", provider = "primary", model = "gpt-test", key = "key1", priority = 1 }
]
"#
    .replace("__SCOPE__", scope);
    compile_v3_config_05_manifest(
        parse_v3_config_02_authoring(&source).expect("target-resolution authoring"),
    )
    .expect("target-resolution manifest")
}

fn global_pool_alive_manifest(scope: &str) -> V3Config05ManifestPublished {
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
  { kind = "provider_model", provider = "first", model = "gpt-test", key = "key1", priority = 1 },
  { kind = "provider_model", provider = "second", model = "gpt-test", key = "key1", priority = 2 }
]
[route_groups.__SCOPE__.pools.default]
selection = { strategy = "priority" }
targets = [
  { kind = "provider_model", provider = "first", model = "gpt-test", key = "key1", priority = 1 },
  { kind = "provider_model", provider = "second", model = "gpt-test", key = "key1", priority = 2 }
]
"#
    .replace("__SCOPE__", scope);
    compile_v3_config_05_manifest(
        parse_v3_config_02_authoring(&source).expect("global-pool-alive authoring"),
    )
    .expect("global-pool-alive manifest")
}

fn account_threshold_manifest() -> V3Config05ManifestPublished {
    let source = r#"
version = 3

[[error.provider_error_action_policy]]
policy_id = "account_http_401_two_errors"
[error.provider_error_action_policy.match]
http_status = 401
[[error.provider_error_action_policy.path]]
step = "wait_retry"
retry_mode = "reselect_before_client_projection"
max_attempts = 2
backoff_ms = 1000
[[error.provider_error_action_policy.path]]
step = "cooldown"
scope = "auth_key"
duration_ms = 900000
[[error.provider_error_action_policy.path]]
step = "project"
status = 502
reason_code = "provider_account_http_401"
message_mode = "code_only"

[[error.provider_error_action_policy]]
policy_id = "account_http_403_two_errors"
[error.provider_error_action_policy.match]
http_status = 403
[[error.provider_error_action_policy.path]]
step = "wait_retry"
retry_mode = "reselect_before_client_projection"
max_attempts = 2
backoff_ms = 1000
[[error.provider_error_action_policy.path]]
step = "cooldown"
scope = "auth_key"
duration_ms = 900000
[[error.provider_error_action_policy.path]]
step = "project"
status = 502
reason_code = "provider_account_http_403"
message_mode = "code_only"

[servers.account_threshold]
bind = "127.0.0.1"
port = 5555
routing_group = "account_threshold"
endpoints = ["responses"]
[providers.primary]
type = "responses"
base_url = "http://primary.invalid/v1"
default_model = "gpt-test"
auth = { type = "api_key", entries = [{ alias = "key1", env = "PRIMARY_KEY" }] }
[providers.primary.models.gpt-test]
wire_name = "gpt-test"
capabilities = ["text"]
[route_groups.account_threshold.pools.default]
selection = { strategy = "priority" }
targets = [{ kind = "provider_model", provider = "primary", model = "gpt-test", key = "key1", priority = 1 }]
"#;
    compile_v3_config_05_manifest(
        parse_v3_config_02_authoring(source).expect("account threshold authoring"),
    )
    .expect("account threshold manifest")
}

#[test]
fn editable_401_403_policy_uses_two_errors_while_default_uses_three() {
    let manifest = account_threshold_manifest();
    for status in [401, 403] {
        let health = V3ProviderFailureRuntimeHealth::from_manifest(&manifest);
        let session = test_provider_failure_scope(
            "account_threshold",
            "account_threshold",
            &format!("account-threshold-{status}"),
        )
        .unwrap();
        for index in 0..2 {
            let record = health
                .record_provider_failure_record_with_policy(
                    &manifest,
                    &session,
                    "primary",
                    Some("responses"),
                    Some("key1"),
                    Some("gpt-test"),
                    Some("account failure"),
                    status,
                    Some("provider_http_error"),
                    "account failure",
                    100 + index,
                )
                .unwrap();
            assert_eq!(record.failure_count, (index + 1) as u32);
            assert_eq!(
                record.state,
                if index == 0 { "healthy" } else { "cooldown" }
            );
        }
    }

    let other_health = V3ProviderFailureRuntimeHealth::from_manifest(&manifest);
    let session = test_provider_failure_scope(
        "account_threshold",
        "account_threshold",
        "ordinary-threshold-session",
    )
    .unwrap();
    for index in 0..3 {
        let record = other_health
            .record_provider_failure_record_with_policy(
                &manifest,
                &session,
                "primary",
                Some("responses"),
                Some("key1"),
                Some("gpt-test"),
                Some("ordinary failure"),
                500,
                Some("provider_http_error"),
                "ordinary failure",
                200 + index,
            )
            .unwrap();
        assert_eq!(record.state, if index < 2 { "healthy" } else { "cooldown" });
    }
}

fn resolve_target(
    manifest: &V3Config05ManifestPublished,
    server_id: &str,
    excluded: &BTreeSet<String>,
    health: &V3ProviderFailureRuntimeHealth,
) -> V3RelayProviderTargetResolution {
    let failure_session_scope =
        test_provider_failure_scope(server_id, server_id, "target-resolution-session")
            .expect("target resolution session scope");
    resolve_target_for_scope(
        manifest,
        server_id,
        excluded,
        health,
        &failure_session_scope,
        1,
    )
}

fn resolve_target_for_scope(
    manifest: &V3Config05ManifestPublished,
    server_id: &str,
    excluded: &BTreeSet<String>,
    health: &V3ProviderFailureRuntimeHealth,
    failure_session_scope: &V3ProviderFailureSessionScope,
    now_ms: u64,
) -> V3RelayProviderTargetResolution {
    resolve_v3_relay_target_outcome(V3RelayProviderTargetResolutionInput {
        manifest,
        server_id,
        failure_session_scope,
        entry_kind: "responses",
        endpoint_path: "/v1/responses",
        body: &json!({"model":"client-responses","input":"hello"}),
        request_local_excluded_candidates: excluded,
        provider_health: health,
        now_ms,
        deterministic_sample: 0,
    })
}

#[test]
fn global_default_floor_cannot_bypass_provider_cooldown_probe_pending() {
    let scope = "global_pool_alive";
    let manifest = global_pool_alive_manifest(scope);
    let health = V3ProviderFailureRuntimeHealth::from_manifest(&manifest);
    let session = test_provider_failure_scope(scope, scope, "session-all-cooldown")
        .expect("failure session scope");
    let now = 2_000_000;
    for provider_id in ["first", "second"] {
        for offset in 0..3 {
            health
                .record_provider_failure_record(
                    &session,
                    provider_id,
                    Some("key1"),
                    Some("gpt-test"),
                    Some("controlled session-only failure"),
                    now + offset,
                )
                .expect("session failure should be recorded");
        }
    }

    let resolution = resolve_target_for_scope(
        &manifest,
        scope,
        &BTreeSet::new(),
        &health,
        &session,
        now + 10,
    );
    let V3RelayProviderTargetResolution::Exhausted {
        attempted_candidates,
    } = resolution
    else {
        panic!("provider cooldown probe state must block every availability projection");
    };
    assert_eq!(attempted_candidates.len(), 2);
    assert!(attempted_candidates
        .iter()
        .all(|candidate| candidate.contains("provider_cooldown_probe_pending")));
}

fn assert_resolution_failure(
    resolution: V3RelayProviderTargetResolution,
    expected_stage: &str,
    expected_code: &str,
) {
    let V3RelayProviderTargetResolution::Failed(source) = resolution else {
        panic!("expected independent target-resolution source failure");
    };
    assert_eq!(source.source_kind, V3ErrorSourceKind::RuntimeFailure);
    assert_eq!(source.source_stage, expected_stage);
    assert_eq!(source.code, expected_code);
}

#[test]
fn classifier_failure_preserves_its_own_error01_stage_and_code() {
    let manifest = target_resolution_manifest("resolution_classifier");
    let health = V3ProviderFailureRuntimeHealth::from_manifest(&manifest);

    assert_resolution_failure(
        resolve_target(&manifest, "missing-server", &BTreeSet::new(), &health),
        "V3Router05RequestClassified",
        "target_resolution_classification_failed",
    );
}

#[test]
fn route_plan_failure_preserves_its_own_error01_stage_and_code() {
    let mut manifest = target_resolution_manifest("resolution_plan");
    manifest
        .route_groups
        .get_mut("resolution_plan")
        .expect("route group")
        .pools
        .remove("default");
    let health = V3ProviderFailureRuntimeHealth::from_manifest(&manifest);

    assert_resolution_failure(
        resolve_target(&manifest, "resolution_plan", &BTreeSet::new(), &health),
        "V3Router06RoutePoolResolved",
        "target_resolution_route_plan_failed",
    );
}

#[test]
fn candidate_expansion_failure_preserves_its_own_error01_stage_and_code() {
    let mut manifest = target_resolution_manifest("resolution_expand");
    manifest.providers.remove("primary");
    let health = V3ProviderFailureRuntimeHealth::from_manifest(&manifest);

    assert_resolution_failure(
        resolve_target(&manifest, "resolution_expand", &BTreeSet::new(), &health),
        "V3Target09CandidateSetExpanded",
        "target_resolution_candidate_expansion_failed",
    );
}

#[test]
fn unavailable_candidate_is_exhaustion_not_runtime_failure() {
    let manifest = target_resolution_manifest("resolution_exhausted");
    let health = V3ProviderFailureRuntimeHealth::from_manifest(&manifest);
    let mut excluded = BTreeSet::new();
    excluded.insert(v3_relay_provider_candidate_key_parts(
        "primary",
        Some("key1"),
        Some("gpt-test"),
    ));

    let V3RelayProviderTargetResolution::Exhausted {
        attempted_candidates,
    } = resolve_target(&manifest, "resolution_exhausted", &excluded, &health)
    else {
        panic!("unavailable selected candidates must produce typed exhaustion");
    };
    assert!(!attempted_candidates.is_empty());
}

#[tokio::test]
async fn request_local_provider_compat_default_floor_exhausts_without_wait_or_health_mutation() {
    let manifest = target_resolution_manifest("compat_default_floor");
    let health = V3ProviderFailureRuntimeHealth::from_manifest(&manifest);
    let selected =
        match resolve_target(&manifest, "compat_default_floor", &BTreeSet::new(), &health) {
            V3RelayProviderTargetResolution::Selected(selected) => selected,
            _ => panic!("valid fixture must select the default-floor provider"),
        };
    let mut failed_candidates = BTreeSet::new();
    let mut same_candidate_retries = BTreeMap::new();
    let mut trace = Vec::new();
    let context = V3RelayProviderFailurePolicyContext {
        manifest: &manifest,
        captured_target_09: None,
        failure_session_scope: test_provider_failure_scope(
            "compat_default_floor",
            "compat_default_floor",
            "session-compat-default-floor",
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
        "ProviderReqCompat06ProviderCompat",
        502,
        Some("provider_request_compat_error".to_string()),
        "arguments must be valid JSON".to_string(),
        &mut state,
    )
    .await
    .expect("request-local compat exhaustion must project without recovery wait");

    assert_eq!(
        result.event.health_record.state,
        "request_local_provider_compat"
    );
    assert_eq!(result.event.health_record.failure_count, 0);
    assert_eq!(result.event.health_record.cooldown_until_ms, None);
    assert_eq!(result.event.wait_ms, None);
    assert_eq!(
        result.event.action,
        "terminal_request_local_provider_compat_exhausted"
    );
    assert!(result.retry_selected.is_none());
    assert!(result.terminal_projection.is_some());
    assert!(state.same_candidate_retries.is_empty());
}

#[tokio::test]
async fn target_resolution_failure_projects_itself_instead_of_prior_provider_429() {
    let mut manifest = target_resolution_manifest("resolution_policy");
    let health = V3ProviderFailureRuntimeHealth::from_manifest(&manifest);
    let selected = match resolve_target(&manifest, "resolution_policy", &BTreeSet::new(), &health) {
        V3RelayProviderTargetResolution::Selected(selected) => selected,
        _ => panic!("valid fixture must select a provider"),
    };
    manifest.providers.remove("primary");
    let mut failed_candidates = BTreeSet::new();
    let mut same_candidate_retries = BTreeMap::new();
    let mut trace = Vec::new();
    let context = V3RelayProviderFailurePolicyContext {
        manifest: &manifest,
        captured_target_09: None,
        failure_session_scope: test_provider_failure_scope(
            "resolution_policy",
            "resolution_policy",
            "session-resolution-policy",
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
        429,
        Some("provider_transport_error".to_string()),
        "prior provider returned 429".to_string(),
        &mut state,
    )
    .await
    .expect("target-resolution source failure must remain projectable");

    assert_eq!(
        result
            .decision
            .exhaustion
            .local_action
            .classified
            .source
            .code,
        "captured_target_plan_expansion_failed"
    );
    assert_eq!(
        result
            .decision
            .exhaustion
            .local_action
            .classified
            .source
            .source_stage,
        "V3Target09CandidateSetExpanded"
    );
    let projection = result
        .terminal_projection
        .expect("non-provider target-resolution failure is terminal");
    assert_eq!(projection.status, 500);
    assert_ne!(projection.status, 429);
    assert_eq!(
        projection.body["error"]["code"],
        "captured_target_plan_expansion_failed"
    );
    assert!(!projection
        .body
        .to_string()
        .contains("prior provider returned 429"));
}

#[test]
fn captured_relay_protocol_admission_does_not_truncate_failure_reselection() {
    let mut manifest = global_pool_alive_manifest("relay_protocol_filter");
    let health = V3ProviderFailureRuntimeHealth::from_manifest(&manifest);
    let selected = match resolve_target(
        &manifest,
        "relay_protocol_filter",
        &BTreeSet::new(),
        &health,
    ) {
        V3RelayProviderTargetResolution::Selected(selected) => selected,
        _ => panic!("fixture must select the first provider"),
    };
    let selected_key = v3_relay_provider_candidate_key(&selected.candidate);
    let target = V3TargetInterpreter::default();
    let captured_target_09 = target
        .expand_candidates(&manifest, target.classify_kind(selected.route.clone()), 0)
        .expect("capture Target09 before execution");
    manifest.providers.clear();
    let context = V3RelayProviderFailurePolicyContext {
        manifest: &manifest,
        captured_target_09: Some(&captured_target_09),
        failure_session_scope: test_provider_failure_scope(
            "relay_protocol_filter",
            "relay_protocol_filter",
            "session-relay-protocol-filter",
        )
        .expect("test failure session scope"),
        provider_health: &health,
        retry_policy: V3RelayProviderFailureRetryPolicy::default(),
        deterministic_sample: 0,
    };

    let resolution = reselect_from_captured_target_plan(
        &context,
        &selected,
        &BTreeSet::from([selected_key.clone()]),
        1,
    );
    let V3RelayProviderTargetResolution::Selected(reselected) = resolution else {
        panic!("provider failure must reselect from the full captured route pool");
    };
    assert_ne!(
        v3_relay_provider_candidate_key(&reselected.candidate),
        selected_key
    );
}

#[test]
fn openai_chat_image_url_request_selects_multimodal_pool() {
    let scope = "chat_image_multimodal";
    let source = r#"
version = 3
[servers.__SCOPE__]
bind = "127.0.0.1"
port = 5555
routing_group = "__SCOPE__"
endpoints = ["openai_chat", "responses"]
[providers.multimodal]
type = "anthropic"
base_url = "http://multimodal.invalid/v1"
default_model = "mini-m3"
auth = { type = "api_key", entries = [{ alias = "key1", env = "MM_KEY" }] }
[providers.multimodal.models.mini-m3]
wire_name = "mini-m3"
capabilities = ["text", "tools", "multimodal", "vision"]
[providers.text]
type = "openai_chat"
base_url = "http://text.invalid/v1"
default_model = "ds-flash"
auth = { type = "api_key", entries = [{ alias = "key1", env = "TXT_KEY" }] }
[providers.text.models.ds-flash]
wire_name = "ds-flash"
capabilities = ["text", "tools"]
[route_groups.__SCOPE__.pools.multimodal]
selection = { strategy = "priority" }
match = { precedence = 0, required_capabilities = ["multimodal"] }
targets = [
  { kind = "provider_model", provider = "multimodal", model = "mini-m3", key = "key1", priority = 1 }
]
[route_groups.__SCOPE__.pools.default]
selection = { strategy = "priority" }
targets = [
  { kind = "provider_model", provider = "text", model = "ds-flash", key = "key1", priority = 1 }
]
"#
    .replace("__SCOPE__", scope);
    let manifest = compile_v3_config_05_manifest(
        parse_v3_config_02_authoring(&source).expect("chat image multimodal authoring"),
    )
    .expect("chat image multimodal manifest");
    let health = V3ProviderFailureRuntimeHealth::from_manifest(&manifest);
    let failure_session_scope = V3ProviderFailureSessionScope::new(scope, scope, "image-session")
        .expect("image session scope");
    let body = json!({
        "model": "ds-flash",
        "messages": [{
            "role": "user",
            "content": [
                {"type": "text", "text": "what is this?"},
                {"type": "image_url", "image_url": {"url": "https://example.com/cat.jpg"}}
            ]
        }]
    });
    let resolution = resolve_v3_relay_target_outcome(V3RelayProviderTargetResolutionInput {
        manifest: &manifest,
        server_id: scope,
        failure_session_scope: &failure_session_scope,
        entry_kind: "openai_chat",
        endpoint_path: "/v1/chat/completions",
        body: &body,
        request_local_excluded_candidates: &BTreeSet::new(),
        provider_health: &health,
        now_ms: 1,
        deterministic_sample: 0,
    });
    match resolution {
        V3RelayProviderTargetResolution::Selected(selected) => {
            assert_eq!(
                selected.candidate.provider_id, "multimodal",
                "openai_chat image_url request must select the multimodal pool target"
            );
        }
        _other => panic!("openai_chat image_url request must resolve to a target"),
    }
}

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
  { kind = "provider_model", provider = "first", model = "gpt-test", key = "key1", priority = 1 },
  { kind = "provider_model", provider = "first", model = "gpt-test", key = "key2", priority = 2 },
  { kind = "provider_model", provider = "second", model = "gpt-test", key = "key1", priority = 3 }
]
[route_groups.__SCOPE__.pools.default]
selection = { strategy = "priority" }
targets = [
  { kind = "provider_model", provider = "first", model = "gpt-test", key = "key1", priority = 1 },
  { kind = "provider_model", provider = "first", model = "gpt-test", key = "key2", priority = 2 },
  { kind = "provider_model", provider = "second", model = "gpt-test", key = "key1", priority = 3 }
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
async fn path_only_policy_project_step_overrides_terminal_projection() {
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
        &mut state,
    )
    .await
    .expect("429 must project through the policy");

    let projection = result
        .terminal_projection
        .expect("default-floor exhausted 429 must be terminal");
    assert_eq!(
        projection.status, 429,
        "project step status must override the terminal projection"
    );
    assert_eq!(
        projection.body["error"]["code"], "E_PATH_RATE_LIMIT",
        "project step public_code must override the projected client code"
    );
}
