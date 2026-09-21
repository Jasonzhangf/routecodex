use super::*;

fn provider_compat_sibling_manifest(scope: &str) -> V3Config05ManifestPublished {
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
default_model = "test"
auth = { type = "api_key", entries = [{ alias = "key", env = "FIRST_KEY" }] }
[providers.first.models.test]
wire_name = "wire-first"
[providers.first.models.sibling]
wire_name = "wire-sibling"
[forwarders.responses]
model = "client-model"
selection = { strategy = "priority" }
targets = [
  { kind = "provider_model", provider = "first", model = "test", key = "key", priority = 2 },
  { kind = "provider_model", provider = "first", model = "sibling", key = "key", priority = 1 }
]
[route_groups.__SCOPE__.pools.default]
selection = { strategy = "priority" }
targets = [{ kind = "forwarder", id = "responses", priority = 1 }]
"#
    .replace("__SCOPE__", scope);
    compile_v3_config_05_manifest(
        parse_v3_config_02_authoring(&source).expect("provider-compat sibling authoring"),
    )
    .expect("provider-compat sibling manifest")
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
        None,
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
async fn relay_provider_compat_failure_keeps_same_provider_sibling_health_neutral() {
    let scope = "relay_provider_compat_sibling";
    let manifest = provider_compat_sibling_manifest(scope);
    let health = V3ProviderFailureRuntimeHealth::from_manifest(&manifest);
    let selected = match resolve_target(&manifest, scope, &BTreeSet::new(), &health) {
        V3RelayProviderTargetResolution::Selected(selected) => selected,
        _ => panic!("valid fixture must select the first model"),
    };
    assert_eq!(selected.candidate.provider_id, "first");
    assert_eq!(selected.candidate.model_id, "test");
    let failed_key = v3_relay_provider_candidate_key(&selected.candidate);
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
            scope,
            scope,
            "session-provider-compat-sibling",
        )
        .expect("test failure session scope"),
        provider_health: &health,
        retry_policy: V3RelayProviderFailureRetryPolicy::default(),
        deterministic_sample: 0,
    };

    let result = run_v3_relay_provider_failure_policy(
        &context,
        selected,
        "ProviderReqCompat06ProviderCompat",
        400,
        Some("provider_request_compat_error".to_string()),
        "prompt is too long".to_string(),
        None,
        &mut V3RelayProviderFailurePolicyState {
            failed_candidates: &mut failed_candidates,
            same_candidate_retries: &mut same_candidate_retries,
            trace: &mut trace,
        },
    )
    .await
    .expect("relay compat failure must reselect a same-provider sibling");

    let reselected = result
        .retry_selected
        .expect("compat failure must reselect the sibling model");
    assert_eq!(reselected.candidate.provider_id, "first");
    assert_eq!(reselected.candidate.auth_alias, "key");
    assert_eq!(reselected.candidate.model_id, "sibling");
    assert_eq!(
        failed_candidates,
        BTreeSet::from([failed_key.clone()]),
        "compat failure must exclude only the exact failed candidate"
    );
    assert_eq!(
        result.event.health_record.state,
        "request_local_provider_compat"
    );
    assert_eq!(result.event.health_record.failure_count, 0);
    assert_eq!(result.event.health_record.cooldown_until_ms, None);
    assert_eq!(result.event.action, "switch_provider");
    assert_eq!(
        result.event.next_provider_key.as_deref(),
        Some("first:key:sibling")
    );
    assert!(
        health
            .store()
            .availability_for_session(
                &context.failure_session_scope,
                "first",
                Some("key"),
                Some("test"),
                v3_relay_provider_policy_now_epoch_ms().expect("current epoch"),
            )
            .available
    );
    assert!(
        health
            .store()
            .availability_for_session(
                &context.failure_session_scope,
                "first",
                Some("key"),
                Some("sibling"),
                v3_relay_provider_policy_now_epoch_ms().expect("current epoch"),
            )
            .available
    );
    assert!(same_candidate_retries.is_empty());
    assert!(!trace.contains(&"V3TargetPolicyRetriedSame"));
}

#[tokio::test]
async fn relay_generic_provider_http_400_excludes_provider_family_and_records_health() {
    let scope = "relay_generic_provider_http_400";
    let manifest = provider_compat_sibling_manifest(scope);
    let health = V3ProviderFailureRuntimeHealth::from_manifest(&manifest);
    let selected = match resolve_target(&manifest, scope, &BTreeSet::new(), &health) {
        V3RelayProviderTargetResolution::Selected(selected) => selected,
        _ => panic!("valid fixture must select the first model"),
    };
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
            scope,
            scope,
            "session-generic-provider-http-400",
        )
        .expect("test failure session scope"),
        provider_health: &health,
        retry_policy: V3RelayProviderFailureRetryPolicy::default(),
        deterministic_sample: 0,
    };

    let result = run_v3_relay_provider_failure_policy(
        &context,
        selected,
        "V3ProviderReqOutbound09TransportRequest",
        400,
        Some("provider_http_error".to_string()),
        "upstream rejected request".to_string(),
        None,
        &mut V3RelayProviderFailurePolicyState {
            failed_candidates: &mut failed_candidates,
            same_candidate_retries: &mut same_candidate_retries,
            trace: &mut trace,
        },
    )
    .await
    .expect("generic provider HTTP 400 must follow provider-scoped health handling");

    assert_eq!(
        failed_candidates,
        BTreeSet::from([
            "first:key:test".to_string(),
            "first:key:sibling".to_string(),
        ]),
        "generic provider HTTP 400 must exclude every candidate in the provider family"
    );
    assert_ne!(
        result.event.health_record.state,
        "request_local_provider_compat"
    );
    assert_eq!(result.event.health_record.failure_count, 1);
    assert!(result.event.health_record.cooldown_until_ms.is_some());
    assert_eq!(result.event.action, "terminal_route_and_default_exhausted");
    assert!(result.retry_selected.is_none());
    assert!(result.terminal_projection.is_some());
    assert!(same_candidate_retries.is_empty());
    assert!(!trace.contains(&"V3TargetPolicyRetriedSame"));
}

#[tokio::test]
async fn relay_upstream_invalid_request_error_keeps_same_provider_sibling_health_neutral() {
    let scope = "relay_upstream_invalid_request_error_sibling";
    let manifest = provider_compat_sibling_manifest(scope);
    let health = V3ProviderFailureRuntimeHealth::from_manifest(&manifest);
    let selected = match resolve_target(&manifest, scope, &BTreeSet::new(), &health) {
        V3RelayProviderTargetResolution::Selected(selected) => selected,
        _ => panic!("valid fixture must select the first model"),
    };
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
            scope,
            scope,
            "session-upstream-invalid-request-error",
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
        502,
        Some("invalid_request_error".to_string()),
        "DeepSeek chat completion failed with 403: request illegal (code 11140)".to_string(),
        None,
        &mut V3RelayProviderFailurePolicyState {
            failed_candidates: &mut failed_candidates,
            same_candidate_retries: &mut same_candidate_retries,
            trace: &mut trace,
        },
    )
    .await
    .expect("upstream invalid-request error must be request-local and reselect sibling");

    let reselected = result
        .retry_selected
        .expect("invalid_request_error must reselect the sibling model");
    assert_eq!(reselected.candidate.provider_id, "first");
    assert_eq!(reselected.candidate.auth_alias, "key");
    assert_eq!(reselected.candidate.model_id, "sibling");
    assert_eq!(
        failed_candidates,
        BTreeSet::from(["first:key:test".to_string()]),
        "invalid_request_error must exclude only the exact failed candidate"
    );
    assert_eq!(
        result.event.health_record.state,
        "request_local_provider_compat"
    );
    assert_eq!(result.event.health_record.failure_count, 0);
    assert_eq!(result.event.health_record.cooldown_until_ms, None);
    assert_eq!(result.event.action, "switch_provider");
    assert_eq!(
        result.event.next_provider_key.as_deref(),
        Some("first:key:sibling")
    );
    assert!(result.terminal_projection.is_none());
    assert!(same_candidate_retries.is_empty());
    assert!(!trace.contains(&"V3TargetPolicyRetriedSame"));
}

#[tokio::test]
async fn relay_provider_failure_projects_target_expansion_error() {
    let scope = "relay_provider_expansion_failure";
    let mut manifest = global_pool_alive_manifest(scope);
    let health = V3ProviderFailureRuntimeHealth::from_manifest(&manifest);
    let selected = match resolve_target(&manifest, scope, &BTreeSet::new(), &health) {
        V3RelayProviderTargetResolution::Selected(selected) => selected,
        _ => panic!("valid fixture must select a provider"),
    };
    manifest.providers.clear();
    let mut failed_candidates = BTreeSet::new();
    let mut same_candidate_retries = BTreeMap::new();
    let mut trace = Vec::new();
    let context = V3RelayProviderFailurePolicyContext {
        manifest: &manifest,
        captured_target_09: None,
        failure_session_scope: test_provider_failure_scope(
            scope,
            scope,
            "session-provider-expansion-failure",
        )
        .expect("test failure session scope"),
        provider_health: &health,
        retry_policy: V3RelayProviderFailureRetryPolicy::default(),
        deterministic_sample: 0,
    };

    let result = run_v3_relay_provider_failure_policy(
        &context,
        selected,
        "V3ProviderReqOutbound09TransportRequest",
        502,
        Some("provider_transport_error".to_string()),
        "transport failed".to_string(),
        None,
        &mut V3RelayProviderFailurePolicyState {
            failed_candidates: &mut failed_candidates,
            same_candidate_retries: &mut same_candidate_retries,
            trace: &mut trace,
        },
    )
    .await
    .expect("provider-scoped expansion failure must project explicitly");

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
    assert_eq!(result.event.action, "project_target_resolution_failure");
    assert!(result.retry_selected.is_none());
    let projection = result
        .terminal_projection
        .expect("target expansion failure must project a terminal error");
    assert_eq!(projection.status, 598);
    assert_eq!(
        projection.body["error"]["code"],
        "captured_target_plan_expansion_failed"
    );
    assert_eq!(failed_candidates.len(), 1);
}
