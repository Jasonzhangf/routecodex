use super::*;
use routecodex_v3_config::{compile_v3_config_05_manifest, parse_v3_config_02_authoring};
use routecodex_v3_error::{
    V3ErrorSourceKind, V3ProviderErrorFingerprint, V3ProviderHealthScope,
    build_v3_error_01_source_raised,
};
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
                    None,
                    &manifest,
                    &session,
                    "primary",
                    Some("responses"),
                    Some("key1"),
                    Some("gpt-test"),
                    Some("account failure"),
                    "V3ProviderRespInbound01Raw",
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
                None,
                &manifest,
                &session,
                "primary",
                Some("responses"),
                Some("key1"),
                Some("gpt-test"),
                Some("ordinary failure"),
                "V3ProviderRespInbound01Raw",
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
fn runtime_policy_maps_account_and_recoverable_http_classes_to_global_health() {
    let manifest = global_pool_alive_manifest("global_status_policy");
    let cases = [(401, 2), (403, 2), (429, 3), (500, 3), (502, 3), (599, 3)];
    for (status, threshold) in cases {
        let health = V3ProviderFailureRuntimeHealth::from_manifest(&manifest);
        let scope = test_provider_failure_scope(
            "global_status_policy",
            "global_status_policy",
            "runtime-policy-status",
        )
        .expect("failure session scope");
        for attempt in 0..threshold {
            health
                .record_provider_failure_record_with_policy(
                    None,
                    &manifest,
                    &scope,
                    "first",
                    Some("responses"),
                    Some("key1"),
                    Some("gpt-test"),
                    Some("provider status failure"),
                    "V3ProviderRespInbound01Raw",
                    status,
                    Some("provider_http_error"),
                    "upstream status",
                    10_000 + attempt as u64,
                )
                .expect("runtime provider failure policy should record");
        }
        assert!(
            !health
                .store()
                .availability_for_session(&scope, "first", Some("key1"), Some("gpt-test"), 10_000)
                .available,
            "status {status} must block only after its declared threshold"
        );
    }

    let health = V3ProviderFailureRuntimeHealth::from_manifest(&manifest);
    let scope = test_provider_failure_scope(
        "global_status_policy",
        "global_status_policy",
        "runtime-policy-negative",
    )
    .expect("failure session scope");
    health
        .record_provider_failure_record_with_policy(
            None,
            &manifest,
            &scope,
            "first",
            Some("responses"),
            Some("key1"),
            Some("gpt-test"),
            Some("request-shaped failure"),
            "V3ProviderReqOutbound09TransportRequest",
            400,
            Some("provider_http_error"),
            "request rejected",
            20_000,
        )
        .expect("request-shaped failure should remain session-scoped");
    assert!(
        health
            .store()
            .availability_for_session(&scope, "first", Some("key1"), Some("gpt-test"), 20_000)
            .available
    );
}

#[test]
fn configured_semantic_global_failure_keeps_manifest_cooldown_policy() {
    let manifest = global_pool_alive_manifest("semantic_global_policy");
    let health = V3ProviderFailureRuntimeHealth::from_manifest(&manifest);
    let scope = test_provider_failure_scope(
        "semantic_global_policy",
        "semantic_global_policy",
        "semantic-session",
    )
    .expect("failure session scope");
    let fingerprint = V3ProviderErrorFingerprint::new(
        "provider_diagnostic_zero_usage",
        "semantic_error",
        200,
        "diagnostic_zero_usage",
    )
    .expect("semantic fingerprint");
    for attempt in 0..3 {
        health
            .record_provider_global_subscription_failure(
                &scope,
                "first",
                Some("key1"),
                Some("gpt-test"),
                fingerprint.clone(),
                Some(1234),
                30_000 + attempt,
            )
            .expect("configured semantic global failure should be accepted");
    }
    assert!(
        !health
            .store()
            .availability_for_session(&scope, "first", Some("key1"), Some("gpt-test"), 30_000)
            .available
    );
    let no_duration = health.record_provider_global_subscription_failure(
        &scope,
        "first",
        Some("key1"),
        Some("gpt-test"),
        fingerprint,
        None,
        40_000,
    );
    assert_eq!(
        no_duration,
        Err("unsupported provider global health error class".to_string())
    );
}

#[test]
fn target_resolution_does_not_expose_default_floor_error_while_global_pool_is_alive() {
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
    assert!(
        attempted_candidates
            .iter()
            .all(|candidate| candidate.contains("provider_cooldown_probe_pending"))
    );
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

#[test]
fn post_commit_response_stream_failure_updates_global_key_health() {
    let manifest = target_resolution_manifest("post_commit_sse_counted");
    let health = V3ProviderFailureRuntimeHealth::from_manifest(&manifest);
    let session = test_provider_failure_scope(
        "post_commit_sse_counted",
        "post_commit_sse_counted",
        "counted-session",
    )
    .expect("counted session scope");
    let source = build_v3_error_01_source_raised(
        V3ErrorSourceKind::ProviderFailure,
        "V3ProviderRespInbound01Raw",
        "provider_response_sse_stream",
        "Responses SSE event must be a JSON object",
    );

    for _ in 0..3 {
        health
            .record_post_commit_provider_stream_failure_from_source(
                &session,
                "primary",
                Some("key1"),
                Some("gpt-test"),
                &source,
            )
            .expect("post-commit response stream failure must update key health");
    }

    let projection =
        routecodex_v3_provider_responses::V3ProviderSchedulingReader::scheduling_projection(
            &health,
            "primary",
            "key1",
            "gpt-test",
            1,
            1,
            v3_relay_provider_policy_now_epoch_ms().expect("current epoch"),
        );
    assert_eq!(projection.score_milli, 700);
    assert!(!projection.available);
}

#[test]
fn incomplete_key_identity_fails_before_provider_cooldown_write() {
    let manifest = target_resolution_manifest("incomplete_key_identity");
    let health = V3ProviderFailureRuntimeHealth::from_manifest(&manifest);
    let action = V3ProviderFailureAction {
        class_code: "provider_auth_failure".to_string(),
        recovery: V3ProviderRecoveryKind::IrrecoverableGlobalCooldown,
        scope: V3ProviderHealthScope::GlobalProviderKey,
        score_delta_milli: -400,
        failure_threshold: 1,
        cooldown_ms: 60 * 60_000,
    };
    let scope = test_provider_failure_scope(
        "incomplete_key_identity",
        "incomplete_key_identity",
        "scope",
    )
    .expect("failure session scope");

    let result = health.record_provider_key_failure_action(
        "primary",
        None,
        None,
        &action,
        v3_relay_provider_policy_now_epoch_ms().expect("current epoch"),
    );
    assert!(result.is_err());
    assert!(
        health
            .store()
            .availability_for_session(&scope, "primary", None, None, u64::MAX)
            .available
    );
}

#[test]
fn post_commit_sse_failures_never_cool_provider_or_block_fresh_session() {
    let manifest = target_resolution_manifest("post_commit_sse_transient");
    let health = V3ProviderFailureRuntimeHealth::from_manifest(&manifest);
    let failed_session = test_provider_failure_scope(
        "post_commit_sse_transient",
        "post_commit_sse_transient",
        "failed-session",
    )
    .expect("failed session scope");
    let fresh_session = test_provider_failure_scope(
        "post_commit_sse_transient",
        "post_commit_sse_transient",
        "fresh-session",
    )
    .expect("fresh session scope");
    let before =
        routecodex_v3_provider_responses::V3ProviderSchedulingReader::scheduling_projection(
            &health, "primary", "key1", "gpt-test", 1, 1, 2_000_000,
        );

    for _ in 0..3 {
        health
            .record_post_commit_provider_stream_failure(
                &failed_session,
                "primary",
                Some("key1"),
                Some("gpt-test"),
                "provider_response_sse_inter_event_timeout",
                "controlled post-commit SSE EOF",
            )
            .expect("post-commit SSE observation must close cleanly");
    }

    let now_ms = v3_relay_provider_policy_now_epoch_ms().expect("current epoch");
    assert!(
        health
            .store()
            .availability_for_session(
                &fresh_session,
                "primary",
                Some("key1"),
                Some("gpt-test"),
                now_ms,
            )
            .available,
        "SSE transport/decode/EOF failures must not blacklist a provider for another session"
    );
    assert!(
        health
            .store()
            .provider_cooldown_probe_keys_due(u64::MAX)
            .expect("provider cooldown probe query")
            .is_empty(),
        "SSE transient failures must not create provider cooldown probe state"
    );
    let after = routecodex_v3_provider_responses::V3ProviderSchedulingReader::scheduling_projection(
        &health, "primary", "key1", "gpt-test", 1, 1, 2_000_000,
    );
    assert_eq!(after.available, before.available);
    assert_eq!(after.effective_weight_milli, before.effective_weight_milli);
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
async fn provider_invalid_request_error_is_health_neutral_even_when_wrapped_as_502() {
    let manifest = target_resolution_manifest("invalid_request_health_neutral");
    let health = V3ProviderFailureRuntimeHealth::from_manifest(&manifest);
    let selected = match resolve_target(
        &manifest,
        "invalid_request_health_neutral",
        &BTreeSet::new(),
        &health,
    ) {
        V3RelayProviderTargetResolution::Selected(selected) => selected,
        _ => panic!("valid fixture must select a provider"),
    };
    let mut failed_candidates = BTreeSet::new();
    let mut same_candidate_retries = BTreeMap::new();
    let mut trace = Vec::new();
    let context = V3RelayProviderFailurePolicyContext {
        manifest: &manifest,
        captured_target_09: None,
        failure_session_scope: test_provider_failure_scope(
            "invalid_request_health_neutral",
            "invalid_request_health_neutral",
            "session-invalid-request",
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
        502,
        Some("invalid_request_error".to_string()),
        "provider response event: prompt is too long".to_string(),
        None,
        &mut state,
    )
    .await
    .expect("invalid request must be handled without provider health mutation");

    assert_eq!(
        result.event.health_record.state,
        "request_local_provider_compat"
    );
    assert_eq!(result.event.health_record.failure_count, 0);
    assert_eq!(result.event.health_record.cooldown_until_ms, None);
    assert!(result.retry_selected.is_none());
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
        None,
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
    assert_eq!(projection.status, 598);
    assert_ne!(projection.status, 429);
    assert_eq!(
        projection.body["error"]["code"],
        "captured_target_plan_expansion_failed"
    );
    assert!(
        !projection
            .body
            .to_string()
            .contains("prior provider returned 429")
    );
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
    assert!(
        state
            .failed_candidates
            .contains(&"first:key1:gpt-test".to_string())
    );
    assert!(
        !state
            .failed_candidates
            .contains(&"first:key2:gpt-test".to_string())
    );
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
        "provider terminal projection must remain 502 regardless of configured project status"
    );
    assert_eq!(
        projection.body["error"]["code"], "E_PATH_RATE_LIMIT",
        "project step public_code must override the projected client code"
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
