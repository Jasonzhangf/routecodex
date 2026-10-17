use super::*;
use routecodex_v3_config::{
    compile_v3_config_05_manifest, parse_v3_config_02_authoring,
};
use serde_json::json;

fn manifest(scope: &str) -> V3Config05ManifestPublished {
    let source = format!(
        r#"
version = 3
[servers.{scope}]
bind = "127.0.0.1"
port = 5555
routing_group = "{scope}"
endpoints = ["responses"]
[providers.primary]
type = "responses"
base_url = "http://primary.invalid/v1"
default_model = "gpt-test"
auth = {{ type = "api_key", entries = [{{ alias = "key1", env = "PRIMARY_KEY" }}] }}
[providers.primary.models.gpt-test]
wire_name = "gpt-test"
capabilities = ["text"]
[route_groups.{scope}]
compact_route_object = "compact"
[route_groups.{scope}.pools.client_responses]
selection = {{ strategy = "priority" }}
match = {{ precedence = 10, entry_protocol = "responses", models = ["client-responses"] }}
targets = [
  {{ kind = "provider_model", provider = "primary", model = "gpt-test", key = "key1", priority = 1 }}
]
[route_groups.{scope}.pools.default]
selection = {{ strategy = "priority" }}
targets = [
  {{ kind = "provider_model", provider = "primary", model = "gpt-test", key = "key1", priority = 1 }}
]
[route_groups.{scope}.pools.compact]
route_object = "compact"
selection = {{ strategy = "priority" }}
match = {{ precedence = 20, entry_protocol = "responses", models = ["compact-only"] }}
targets = [
  {{ kind = "provider_model", provider = "primary", model = "gpt-test", key = "key1", priority = 1 }}
]
"#
    );
    compile_v3_config_05_manifest(
        parse_v3_config_02_authoring(&source).expect("resolve target manifest authoring"),
    )
    .expect("resolve target manifest")
}

fn relay_mode(
    manifest: Arc<V3Config05ManifestPublished>,
    scope: &str,
) -> V3ResolveTargetExecutionMode {
    V3ResolveTargetExecutionMode::RelayFresh {
        manifest,
        server_id: scope.to_string(),
        entry_kind: "responses".to_string(),
        endpoint_path: "/v1/responses".to_string(),
        requested_model: None,
        deterministic_sample: 0,
    }
}

fn direct_mode(
    manifest: Arc<V3Config05ManifestPublished>,
    scope: &str,
    request_id: &str,
) -> V3ResolveTargetExecutionMode {
    V3ResolveTargetExecutionMode::DirectFresh {
        manifest,
        server_id: scope.to_string(),
        endpoint_path: "/v1/responses".to_string(),
        entry_protocol: "responses".to_string(),
        request_id: request_id.to_string(),
        session_id: format!("{scope}-session"),
        conversation_id: format!("{scope}-conversation"),
        port: "5555".to_string(),
        longcontext_threshold_tokens: None,
        is_compaction: false,
        now_epoch_ms: 1,
    }
}

fn body(model: &str) -> Value {
    json!({
        "model": model,
        "input": [{
            "role": "user",
            "content": "preserve this complete canonical request"
        }],
        "tools": [{
            "type": "function",
            "name": "opaque_probe",
            "parameters": {
                "type": "object",
                "properties": {"value": {"type": "string"}}
            }
        }],
        "extension": {"nested": [1, null, {"keep": true}]}
    })
}

fn classify_error(
    request: Value,
    mode: V3ResolveTargetExecutionMode,
) -> (String, V3Error01SourceRaised) {
    let side_output = Arc::new(Mutex::new(None));
    let error = ResolveTargetOperator {
        mode,
        side_output: Arc::clone(&side_output),
    }
    .execute(
        request,
        &OperatorContext {
            identity: pipeline_runtime::Identity {
                project_id: "routecodex-v3".to_string(),
                graph_id: "resolve-target-error-test".to_string(),
                graph_version: "1".to_string(),
                execution_id: "resolve-target-error".to_string(),
                attempt_id: "client-entry".to_string(),
            },
            node_id: "resolve_target".to_string(),
        },
    )
    .expect_err("invalid routing input must fail the operator");
    let typed = side_output
        .lock()
        .expect("side output lock")
        .take()
        .expect("typed error is required");
    let Err(typed) = typed else {
        panic!("side output must preserve the typed error");
    };
    (error, typed)
}

#[test]
fn relay_fresh_uses_sdk_input_for_resolution_and_preserves_complete_value() {
    let scope = "resolve_target_sdk_input";
    let manifest = Arc::new(manifest(scope));
    let matched = body("client-responses");
    let unmatched = body("unmatched-model");

    let (matched_output, matched_side) = run_v3_resolve_target_operator(
        matched.clone(),
        relay_mode(Arc::clone(&manifest), scope),
    )
    .expect("matched SDK request must resolve");
    let (unmatched_output, unmatched_side) =
        run_v3_resolve_target_operator(unmatched.clone(), relay_mode(manifest, scope))
            .expect("unmatched SDK request must resolve");

    assert_eq!(matched_output, matched);
    assert_eq!(unmatched_output, unmatched);
    assert_eq!(matched_side.opaque_hit.pool_id, "client_responses");
    assert_eq!(unmatched_side.opaque_hit.pool_id, "default");
    assert_ne!(matched_side.opaque_hit.pool_id, unmatched_side.opaque_hit.pool_id);
}

#[test]
fn direct_fresh_returns_typed_target_and_keeps_complete_business_value() {
    let scope = "resolve_target_direct";
    let manifest = Arc::new(manifest(scope));
    let request = body("client-responses");

    let (output, side) = run_v3_resolve_target_operator(
        request.clone(),
        direct_mode(manifest, scope, "resolve-target-direct-request"),
    )
    .expect("DirectFresh must execute the real canonical operator");

    assert_eq!(output, request);
    assert_eq!(side.opaque_hit.pool_id, "client_responses");
    assert!(side.route_policy_pending.is_some());
    assert_eq!(
        side.route_policy_scope
            .as_ref()
            .map(|scope| scope.conversation_id.as_str()),
        Some("resolve_target_direct-conversation")
    );
}

#[test]
fn captured_handoff_does_not_classify_or_hit_again() {
    let scope = "resolve_target_handoff";
    let captured_manifest = Arc::new(manifest(scope));
    let request = body("client-responses");
    let (_, captured) = run_v3_resolve_target_operator(
        request.clone(),
        relay_mode(Arc::clone(&captured_manifest), scope),
    )
    .expect("capture an opaque hit before handoff");

    let (output, handed_off) = run_v3_resolve_target_operator(
        request.clone(),
        V3ResolveTargetExecutionMode::CapturedHandoff {
            opaque_hit: captured.opaque_hit.clone(),
            route_policy_pending: None,
            route_policy_scope: None,
        },
    )
    .expect("handoff must accept the captured hit");

    assert_eq!(output, request);
    assert_eq!(handed_off.opaque_hit, captured.opaque_hit);
    assert_eq!(handed_off.opaque_hit.server_id, scope);
    assert_ne!(handed_off.opaque_hit.server_id, "different_scope");
}

#[test]
fn relay_without_model_uses_endpoint_model_only_for_routing() {
    let scope = "resolve_target_endpoint_model";
    let manifest = Arc::new(manifest(scope));
    let request = json!({
        "input": [{"role": "user", "content": "gemini style endpoint model"}],
        "extension": {"preserve": true}
    });
    let mode = V3ResolveTargetExecutionMode::RelayFresh {
        manifest,
        server_id: scope.to_string(),
        entry_kind: "responses".to_string(),
        endpoint_path: "/v1/responses".to_string(),
        requested_model: Some("client-responses".to_string()),
        deterministic_sample: 0,
    };

    let (output, side) =
        run_v3_resolve_target_operator(request.clone(), mode).expect("routing view succeeds");

    assert_eq!(output, request);
    assert_eq!(side.opaque_hit.pool_id, "client_responses");
    assert_eq!(output.get("model"), None);
}

#[test]
fn relay_error_keeps_the_existing_typed_resolver_error() {
    let scope = "resolve_target_typed_error";
    let manifest = Arc::new(manifest(scope));
    let request = body("client-responses");
    let expected = crate::provider_failure_runtime_policy::resolve_v3_relay_opaque_target_once(
        &manifest,
        "missing-server",
        "responses",
        "/v1/responses",
        &request,
        0,
    )
    .expect_err("missing server must produce the existing resolver error");
    let Err(observed) = run_v3_resolve_target_operator(
        request,
        V3ResolveTargetExecutionMode::RelayFresh {
            manifest,
            server_id: "missing-server".to_string(),
            entry_kind: "responses".to_string(),
            endpoint_path: "/v1/responses".to_string(),
            requested_model: None,
            deterministic_sample: 0,
        },
    ) else {
        panic!("missing server must fail the operator");
    };
    let V3ResolveTargetOperatorError::Typed(observed) = observed else {
        panic!("resolver failure must preserve its typed error");
    };
    assert_eq!(observed, expected);
}

#[test]
fn direct_compaction_uses_existing_facts_and_clears_client_model() {
    let scope = "resolve_target_direct_compaction";
    let manifest = Arc::new(manifest(scope));
    let request = json!({
        "model": "client-responses",
        "input": [{"type": "compaction", "encrypted_content": "opaque"}],
        "extension": {"preserve": true}
    });
    let mode = V3ResolveTargetExecutionMode::DirectFresh {
        manifest,
        server_id: scope.to_string(),
        endpoint_path: "/v1/responses/compact".to_string(),
        entry_protocol: "responses".to_string(),
        request_id: "resolve-target-direct-compaction".to_string(),
        session_id: format!("{scope}-session"),
        conversation_id: format!("{scope}-conversation"),
        port: "5555".to_string(),
        longcontext_threshold_tokens: None,
        is_compaction: true,
        now_epoch_ms: 1,
    };

    let (output, side) = run_v3_resolve_target_operator(request.clone(), mode)
        .expect("Direct compaction must resolve through the canonical operator");

    assert_eq!(output, request);
    assert_eq!(side.opaque_hit.pool_id, "compact");
    assert_eq!(side.opaque_hit.request_client_model, None);
}

#[test]
fn direct_compaction_purpose_routes_without_compact_endpoint_or_payload_marker() {
    let scope = "resolve_target_compaction_purpose";
    let manifest = Arc::new(manifest(scope));
    let request = body("client-responses");
    let mut mode = direct_mode(manifest, scope, "resolve-target-compaction-purpose");
    let V3ResolveTargetExecutionMode::DirectFresh { is_compaction, .. } = &mut mode else {
        unreachable!();
    };
    *is_compaction = true;

    let (output, side) = run_v3_resolve_target_operator(request.clone(), mode)
        .expect("typed compaction purpose must select its declared route object");
    assert_eq!(output, request);
    assert_eq!(side.opaque_hit.pool_id, "compact");
    assert_eq!(side.opaque_hit.request_client_model, None);
}
