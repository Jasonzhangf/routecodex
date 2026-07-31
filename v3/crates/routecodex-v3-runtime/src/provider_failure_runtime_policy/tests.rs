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
fn relay_initial_exhaustion_revives_one_in_plan_provider_from_sibling_success() {
    let manifest = target_resolution_manifest("relay_revive");
    let health = V3ProviderFailureRuntimeHealth::from_manifest(&manifest);
    let session_a = test_provider_failure_scope("relay_revive", "relay_revive", "session-a")
        .expect("session A scope");
    let session_b = test_provider_failure_scope("relay_revive", "relay_revive", "session-b")
        .expect("session B scope");
    health
        .store()
        .record_provider_success_in_session(
            &session_b,
            "primary",
            Some("key1"),
            Some("gpt-test"),
            90,
        )
        .expect("session B success evidence");
    for now_ms in 100..103 {
        health
            .store()
            .record_provider_failure_in_session(
                &session_a,
                "primary",
                Some("key1"),
                Some("gpt-test"),
                Some("controlled failure"),
                now_ms,
            )
            .expect("session A failure");
    }

    let first = resolve_target_for_scope(
        &manifest,
        "relay_revive",
        &BTreeSet::new(),
        &health,
        &session_a,
        103,
    );
    let V3RelayProviderTargetResolution::Selected(selected) = first else {
        panic!("healthy sibling must grant one in-plan revive");
    };
    assert_eq!(selected.candidate.provider_id, "primary");

    let second = resolve_target_for_scope(
        &manifest,
        "relay_revive",
        &BTreeSet::new(),
        &health,
        &session_a,
        104,
    );
    assert!(matches!(
        second,
        V3RelayProviderTargetResolution::Exhausted { .. }
    ));
}

#[tokio::test]
async fn relay_failed_revive_preserves_deadline_and_returns_no_second_retry() {
    let manifest = target_resolution_manifest("relay_failed_revive");
    let health = V3ProviderFailureRuntimeHealth::from_manifest(&manifest);
    let session_a =
        test_provider_failure_scope("relay_failed_revive", "relay_failed_revive", "session-a")
            .expect("session A scope");
    let session_b =
        test_provider_failure_scope("relay_failed_revive", "relay_failed_revive", "session-b")
            .expect("session B scope");
    let now_ms = v3_relay_provider_policy_now_epoch_ms().expect("current epoch");
    health
        .store()
        .record_provider_success_in_session(
            &session_b,
            "primary",
            Some("key1"),
            Some("gpt-test"),
            now_ms.saturating_sub(10),
        )
        .expect("session B success evidence");
    for failed_at in [now_ms.saturating_sub(2), now_ms.saturating_sub(1)] {
        health
            .store()
            .record_provider_failure_in_session(
                &session_a,
                "primary",
                Some("key1"),
                Some("gpt-test"),
                Some("controlled failure"),
                failed_at,
            )
            .expect("session A pre-cooldown failure");
    }
    let selected = match resolve_target_for_scope(
        &manifest,
        "relay_failed_revive",
        &BTreeSet::new(),
        &health,
        &session_a,
        now_ms,
    ) {
        V3RelayProviderTargetResolution::Selected(selected) => selected,
        _ => panic!("provider must be selectable before the third failure"),
    };
    let context = V3RelayProviderFailurePolicyContext {
        manifest: &manifest,
        failure_session_scope: session_a,
        provider_health: &health,
        retry_policy: V3RelayProviderFailureRetryPolicy::default(),
        deterministic_sample: 0,
    };
    let mut failed_candidates = BTreeSet::new();
    let mut same_candidate_retries = BTreeMap::new();
    let mut trace = Vec::new();
    let first = run_v3_relay_provider_failure_policy(
        &context,
        selected.clone(),
        "V3ProviderReqOutbound09TransportRequest",
        503,
        Some("provider_transport".to_string()),
        "third failure".to_string(),
        &mut V3RelayProviderFailurePolicyState {
            failed_candidates: &mut failed_candidates,
            same_candidate_retries: &mut same_candidate_retries,
            trace: &mut trace,
        },
    )
    .await
    .expect("third failure policy");
    assert_eq!(first.event.action, "cross_session_revive");
    assert!(first.retry_selected.is_some());
    let original_deadline = first.event.health_record.cooldown_until_ms;

    let second = run_v3_relay_provider_failure_policy(
        &context,
        selected,
        "V3ProviderReqOutbound09TransportRequest",
        503,
        Some("provider_transport".to_string()),
        "revive failed".to_string(),
        &mut V3RelayProviderFailurePolicyState {
            failed_candidates: &mut failed_candidates,
            same_candidate_retries: &mut same_candidate_retries,
            trace: &mut trace,
        },
    )
    .await
    .expect("failed revive policy");
    assert!(
        second.retry_selected.is_none(),
        "failed revive must not retry"
    );
    assert_eq!(
        second.event.health_record.cooldown_until_ms,
        original_deadline
    );
    assert!(second.terminal_projection.is_some());
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
        "V3ProviderRespInbound01Raw",
        429,
        Some("rate_limit".to_string()),
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
