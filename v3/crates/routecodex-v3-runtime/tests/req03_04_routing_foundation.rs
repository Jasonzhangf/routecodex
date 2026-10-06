//! Public-boundary regression for the REQ03/REQ04 routing foundation.
//!
//! REQ03 selects one opaque target. REQ04 interprets that target, expands it to
//! concrete candidates, and produces a typed execution mode. This test uses
//! public constructors and a real compiled config. It does not reach into
//! private state or inspect source text.

use routecodex_v3_config::{compile_v3_config_05_manifest, parse_v3_config_02_authoring};
use routecodex_v3_error::V3ProviderFailureSessionScope;
use routecodex_v3_provider_responses::{
    V3ProviderSchedulingProjection, V3ProviderSchedulingReader,
};
use routecodex_v3_runtime::{
    build_v3_execution_11_protocol_decision_from_v3_target_10,
    plan_v3_responses_protocol_execution_with_provider_health, V3Execution11ProtocolDecisionMode,
    V3HubProviderWireProtocol, V3ProviderFailureRuntimeHealth, V3Server03HttpRequestRaw,
};
use routecodex_v3_target::V3TargetInterpreter;
use routecodex_v3_virtual_router::V3VirtualRouter;
use serde_json::{json, Value};

fn manifest_for(
    entry_provider: &str,
    allowed_modes: &[&str],
    explicit_chat_process: bool,
) -> routecodex_v3_config::V3Config05ManifestPublished {
    let allowed = allowed_modes
        .iter()
        .map(|mode| format!("\"{mode}\""))
        .collect::<Vec<_>>()
        .join(", ");
    let process = if explicit_chat_process {
        "responses = { process = \"chat\", streaming = \"always\" }"
    } else {
        ""
    };
    let source = format!(
        r#"
version = 3

[servers.test]
bind = "127.0.0.1"
port = 4444
routing_group = "default"

[servers.test.execution]
allowed_modes = [{allowed}]
allowed_invocation_sources = ["client", "servertool_followup", "dry_run"]
allowed_transports = ["json", "sse"]

[providers.entry]
type = "{entry_provider}"
base_url = "http://entry.invalid/v1"
default_model = "entry-model"
auth = {{ type = "api_key", entries = [{{ alias = "key", env = "ENTRY_KEY" }}] }}
{process}

[providers.entry.models.entry-model]
wire_name = "wire-entry"
capabilities = ["text", "tools"]

[route_groups.default.pools.default]
selection = {{ strategy = "priority" }}
targets = [{{ kind = "provider_model", provider = "entry", model = "entry-model", key = "key", priority = 1 }}]
"#,
    );
    compile_v3_config_05_manifest(parse_v3_config_02_authoring(&source).unwrap()).unwrap()
}

fn raw_request(body: Value) -> V3Server03HttpRequestRaw {
    V3Server03HttpRequestRaw {
        server_id: "test".to_string(),
        port: Some(4444),
        pipeline_id: Some("req03-04-contract-pipeline".to_string()),
        failure_session_scope: V3ProviderFailureSessionScope::new(
            "test",
            "default",
            "req03-04-contract-session",
        )
        .unwrap(),
        request_id: "req03-04-contract-request".to_string(),
        execution_id: "req03-04-contract-execution".to_string(),
        method: "POST".to_string(),
        path: "/v1/responses".to_string(),
        request_purpose: routecodex_v3_runtime::V3RequestPurpose::Conversation,
        body,
    }
}

fn request_body() -> Value {
    json!({
        "model": "entry-model",
        "input": "preserve this body",
        "tools": [
            {
                "type": "function",
                "name": "contract_probe",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "value": { "type": "string" }
                    }
                }
            }
        ],
        "metadata": {
            "opaque": {
                "nested": [1, 2, 3]
            }
        }
    })
}

#[test]
fn opaque_router_target_hit_stays_opaque_and_preserves_plan() {
    let manifest = manifest_for("responses", &["direct", "relay"], false);
    let router = V3VirtualRouter::default();
    let classified = router
        .classify_request(&manifest, "test", "/v1/responses")
        .expect("REQ03 classified request");

    // REQ03 output is an opaque target hit. It identifies the selected target
    // plan but does not expose a concrete provider selection.
    let route_plan = router
        .resolve_route_pool_plan(&manifest, classified)
        .expect("REQ03 route pool plan");
    let hit = router
        .hit_opaque_target_plan_once(route_plan, 0)
        .expect("REQ03 opaque target hit");
    assert_eq!(
        hit.target_kind,
        routecodex_v3_config::V3RouteTargetKind::ProviderModel
    );
    assert_eq!(hit.target_plan.len(), 1);
    assert_eq!(hit.target_plan[0].target_kind, hit.target_kind);
    assert!(hit.target_plan[0].target_id.is_none());
}

#[test]
fn public_plan_selects_same_protocol_direct_and_preserves_payload() {
    let manifest = manifest_for("responses", &["direct", "relay"], false);
    let body = request_body();
    let raw = raw_request(body.clone());
    let plan = plan_v3_responses_protocol_execution_with_provider_health(
        &manifest,
        raw.clone(),
        V3ProviderFailureRuntimeHealth::from_manifest_for_isolated_tests(&manifest),
        100,
    )
    .expect("public protocol plan");

    assert_eq!(
        plan.decision.mode,
        V3Execution11ProtocolDecisionMode::SameProtocolDirect
    );
    assert_eq!(
        plan.decision.entry_protocol,
        V3HubProviderWireProtocol::Responses
    );
    assert_eq!(
        plan.decision.selected_provider_protocol,
        V3HubProviderWireProtocol::Responses
    );
    assert_eq!(plan.decision.target.candidate.provider_id, "entry");
    assert_eq!(plan.decision.target.candidate.model_id, "entry-model");
    assert_eq!(
        raw.body, body,
        "planning must not mutate the request payload"
    );
}

#[test]
fn public_plan_selects_hub_relay_for_cross_protocol_candidate() {
    let manifest = manifest_for("openai_chat", &["direct", "relay"], false);
    let body = request_body();
    let raw = raw_request(body.clone());
    let plan = plan_v3_responses_protocol_execution_with_provider_health(
        &manifest,
        raw.clone(),
        V3ProviderFailureRuntimeHealth::from_manifest_for_isolated_tests(&manifest),
        200,
    )
    .expect("public protocol plan");

    assert_eq!(
        plan.decision.mode,
        V3Execution11ProtocolDecisionMode::HubRelay
    );
    assert_eq!(
        plan.decision.entry_protocol,
        V3HubProviderWireProtocol::Responses
    );
    assert_eq!(
        plan.decision.selected_provider_protocol,
        V3HubProviderWireProtocol::OpenAiChat
    );
    assert_eq!(
        raw.body, body,
        "planning must not mutate the request payload"
    );
}

#[test]
fn public_plan_selects_hub_relay_for_explicit_relay_only_same_protocol() {
    let manifest = manifest_for("responses", &["relay"], false);
    let body = request_body();
    let raw = raw_request(body.clone());
    let plan = plan_v3_responses_protocol_execution_with_provider_health(
        &manifest,
        raw.clone(),
        V3ProviderFailureRuntimeHealth::from_manifest_for_isolated_tests(&manifest),
        300,
    )
    .expect("public protocol plan");

    assert_eq!(
        plan.decision.mode,
        V3Execution11ProtocolDecisionMode::HubRelay
    );
    assert_eq!(
        plan.decision.entry_protocol,
        V3HubProviderWireProtocol::Responses
    );
    assert_eq!(
        plan.decision.selected_provider_protocol,
        V3HubProviderWireProtocol::Responses
    );
    assert_eq!(
        raw.body, body,
        "planning must not mutate the request payload"
    );
}

#[test]
fn public_plan_selects_hub_relay_for_responses_process_chat() {
    let manifest = manifest_for("responses", &["relay"], true);
    let body = request_body();
    let raw = raw_request(body.clone());
    let plan = plan_v3_responses_protocol_execution_with_provider_health(
        &manifest,
        raw.clone(),
        V3ProviderFailureRuntimeHealth::from_manifest_for_isolated_tests(&manifest),
        400,
    )
    .expect("public protocol plan");

    assert_eq!(
        plan.decision.mode,
        V3Execution11ProtocolDecisionMode::HubRelay
    );
    assert_eq!(
        plan.decision.selected_provider_protocol,
        V3HubProviderWireProtocol::Responses
    );
    assert_eq!(
        raw.body, body,
        "planning must not mutate the request payload"
    );
}

#[test]
fn target_public_boundary_reports_typed_selection_exhaustion() {
    struct UnavailableScheduling;

    impl V3ProviderSchedulingReader for UnavailableScheduling {
        fn scheduling_projection(
            &self,
            provider_id: &str,
            auth_alias: &str,
            model_id: &str,
            priority: i32,
            base_weight: u32,
            _now_ms: u64,
        ) -> V3ProviderSchedulingProjection {
            let mut projection = V3ProviderSchedulingProjection::new(
                provider_id,
                auth_alias,
                model_id,
                priority,
                1_000,
                base_weight,
            );
            projection.available = false;
            projection
                .blocked_scopes
                .push("health_cooldown".to_string());
            projection
        }
    }

    let manifest = manifest_for("responses", &["direct", "relay"], false);
    let router = V3VirtualRouter::default();
    let classified = router
        .classify_request(&manifest, "test", "/v1/responses")
        .expect("REQ03 classified request");
    let route_plan = router
        .resolve_route_pool_plan(&manifest, classified)
        .expect("REQ03 route pool plan");
    let hit = router
        .hit_opaque_target_plan_once(route_plan, 0)
        .expect("REQ03 opaque target hit");
    let target = V3TargetInterpreter::default();
    let expanded = target
        .expand_candidates(&manifest, target.classify_kind(hit), 0)
        .expect("REQ04 target expansion");
    let exhausted = target
        .select_available_with_health(expanded, &UnavailableScheduling, 500, 0)
        .expect_err("unavailable concrete candidates must return typed exhaustion");

    assert_eq!(
        exhausted.attempted_candidates,
        vec!["entry:key:entry-model:availability(health_cooldown)"]
    );
}

#[test]
fn public_decision_rejects_same_protocol_without_an_allowed_mode() {
    let manifest = manifest_for("responses", &["direct", "relay"], false);
    let body = request_body();
    let raw = raw_request(body.clone());
    let plan = plan_v3_responses_protocol_execution_with_provider_health(
        &manifest,
        raw.clone(),
        V3ProviderFailureRuntimeHealth::from_manifest_for_isolated_tests(&manifest),
        600,
    )
    .expect("baseline public protocol plan");
    assert_eq!(
        raw.body, body,
        "planning must not mutate the request payload"
    );

    let error = build_v3_execution_11_protocol_decision_from_v3_target_10(
        plan.decision.target,
        "responses",
        &[],
    )
    .expect_err("same-protocol target without direct or relay must fail");

    assert_eq!(error.code, "protocol_same_execution_mode_not_allowed");
}
