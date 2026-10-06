//! REQ03 opaque-route owner regression.
//!
//! `resolve_v3_relay_opaque_target_once` must own exactly the
//! facts -> classify -> route-pool plan -> opaque hit chain and return a real
//! `V3Router07OpaqueTargetHitOnce`. It must not read provider health, expand
//! concrete candidates, or select a provider. These tests drive that helper and
//! the original coordinator through a real compiled config and the public
//! Virtual Router / Target boundary.

use super::*;
use routecodex_v3_config::{
    compile_v3_config_05_manifest, parse_v3_config_02_authoring, V3RouteTargetKind,
};
use routecodex_v3_error::V3ProviderFailureSessionScope;
use routecodex_v3_virtual_router::{V3Router07OpaqueTargetHitOnce, V3VirtualRouter};
use serde_json::json;
use std::collections::BTreeSet;

fn req03_opaque_manifest(scope: &str) -> V3Config05ManifestPublished {
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
capabilities = ["text", "tools"]
[providers.secondary]
type = "responses"
base_url = "http://secondary.invalid/v1"
default_model = "gpt-test"
auth = { type = "api_key", entries = [{ alias = "key1", env = "SECONDARY_KEY" }] }
[providers.secondary.models.gpt-test]
wire_name = "gpt-test"
capabilities = ["text", "tools"]
[route_groups.__SCOPE__.pools.client_responses]
selection = { strategy = "priority" }
match = { precedence = 10, entry_protocol = "responses", models = ["client-responses"] }
targets = [
  { kind = "provider_model", provider = "primary", model = "gpt-test", key = "key1", priority = 1 }
]
[route_groups.__SCOPE__.pools.default]
selection = { strategy = "priority" }
targets = [
  { kind = "provider_model", provider = "primary", model = "gpt-test", key = "key1", priority = 2 },
  { kind = "provider_model", provider = "secondary", model = "gpt-test", key = "key1", priority = 1 }
]
"#
    .replace("__SCOPE__", scope);
    compile_v3_config_05_manifest(
        parse_v3_config_02_authoring(&source).expect("req03 opaque authoring"),
    )
    .expect("req03 opaque manifest")
}

fn req03_body(model: &str) -> Value {
    json!({
        "model": model,
        "input": "preserve this opaque body",
        "tools": [
            {
                "type": "function",
                "name": "opaque_probe",
                "parameters": {
                    "type": "object",
                    "properties": { "value": { "type": "string" } }
                }
            }
        ],
        "metadata": { "opaque": { "nested": [1, 2, 3] } }
    })
}

fn req03_scope(scope: &str, session: &str) -> V3ProviderFailureSessionScope {
    V3ProviderFailureSessionScope::new(scope, scope, session).expect("req03 session scope")
}

#[test]
fn opaque_helper_returns_multi_target_opaque_plan() {
    let manifest = req03_opaque_manifest("req03_opaque_plan");
    let body = req03_body("some-other-model");
    let hit = resolve_v3_relay_opaque_target_once(
        &manifest,
        "req03_opaque_plan",
        "responses",
        "/v1/responses",
        &body,
        0,
    )
    .expect("opaque target hit");

    assert_eq!(hit.server_id, "req03_opaque_plan");
    assert_eq!(hit.routing_group_id, "req03_opaque_plan");
    assert_eq!(hit.pool_id, "default");
    assert_eq!(hit.hit_count, 1);
    assert_eq!(
        hit.target_plan.len(),
        2,
        "both default targets must stay in the opaque plan"
    );
    assert_eq!(hit.target_kind, V3RouteTargetKind::ProviderModel);
    for entry in &hit.target_plan {
        assert_eq!(entry.pool_id, "default");
        assert_eq!(entry.target_kind, V3RouteTargetKind::ProviderModel);
        assert!(
            entry.target_id.is_none(),
            "the opaque plan must not expose a concrete target id"
        );
    }
    // Priority order: primary (priority 2) first, secondary (priority 1) next.
    assert_eq!(hit.target_plan[0].target_index, 0);
    assert_eq!(hit.target_plan[1].target_index, 1);
}

#[test]
fn opaque_helper_leaves_request_body_unchanged() {
    let manifest = req03_opaque_manifest("req03_opaque_body");
    let body = req03_body("client-responses");
    let snapshot = body.clone();

    let _ = resolve_v3_relay_opaque_target_once(
        &manifest,
        "req03_opaque_body",
        "responses",
        "/v1/responses",
        &body,
        0,
    )
    .expect("opaque hit");
    assert_eq!(
        body, snapshot,
        "the REQ03 helper must not mutate the request body"
    );

    let health = V3ProviderFailureRuntimeHealth::from_manifest(&manifest);
    let scope = req03_scope("req03_opaque_body", "req03-body-session");
    let resolution = resolve_v3_relay_target_outcome(V3RelayProviderTargetResolutionInput {
        manifest: &manifest,
        server_id: "req03_opaque_body",
        entry_kind: "responses",
        endpoint_path: "/v1/responses",
        body: &body,
        request_local_excluded_candidates: &BTreeSet::new(),
        failure_session_scope: &scope,
        provider_health: &health,
        now_ms: 1,
        deterministic_sample: 0,
    });
    assert!(
        matches!(resolution, V3RelayProviderTargetResolution::Selected(_)),
        "the coordinator must still select through Target expansion"
    );
    assert_eq!(
        body, snapshot,
        "the coordinator must not mutate the request body"
    );
}

#[test]
fn opaque_helper_uses_facts_to_select_matching_pool() {
    let manifest = req03_opaque_manifest("req03_opaque_facts");

    let matched = req03_body("client-responses");
    let hit = resolve_v3_relay_opaque_target_once(
        &manifest,
        "req03_opaque_facts",
        "responses",
        "/v1/responses",
        &matched,
        0,
    )
    .expect("matched-model hit");
    assert_eq!(hit.pool_id, "client_responses");
    // The matched pool leads the plan and the default pool stays as fallback.
    assert_eq!(hit.target_plan[0].pool_id, "client_responses");
    assert_eq!(hit.target_plan[1].pool_id, "default");

    let unmatched = req03_body("some-other-model");
    let hit = resolve_v3_relay_opaque_target_once(
        &manifest,
        "req03_opaque_facts",
        "responses",
        "/v1/responses",
        &unmatched,
        0,
    )
    .expect("default-pool hit");
    assert_eq!(hit.pool_id, "default");
    assert_eq!(
        hit.target_plan.len(),
        2,
        "the unmatched request must fall back to both default targets"
    );
}

#[test]
fn opaque_helper_threads_deterministic_sample() {
    let manifest = req03_opaque_manifest("req03_opaque_sample");
    let body = req03_body("some-other-model");

    let first = resolve_v3_relay_opaque_target_once(
        &manifest,
        "req03_opaque_sample",
        "responses",
        "/v1/responses",
        &body,
        7,
    )
    .expect("first opaque hit");
    let second = resolve_v3_relay_opaque_target_once(
        &manifest,
        "req03_opaque_sample",
        "responses",
        "/v1/responses",
        &body,
        7,
    )
    .expect("second opaque hit");
    assert_eq!(
        first, second,
        "the same deterministic sample must produce the same opaque hit"
    );

    // Equivalence to the public router path with the same sample: the helper
    // must forward the sample to `hit_opaque_target_plan_once` unchanged.
    let facts = crate::build_v3_router_request_facts_for_entry_with_manifest(
        &body,
        "responses",
        crate::configured_v3_longcontext_threshold_tokens(&manifest, "req03_opaque_sample"),
        &manifest,
    );
    let router = V3VirtualRouter::process_shared();
    let classified = router
        .classify_request_with_facts(&manifest, "req03_opaque_sample", "/v1/responses", facts)
        .expect("classified");
    let plan = router
        .resolve_route_pool_plan(&manifest, classified)
        .expect("plan");
    let expected: V3Router07OpaqueTargetHitOnce = router
        .hit_opaque_target_plan_once(plan, 7)
        .expect("direct public hit");
    assert_eq!(
        first, expected,
        "helper output must equal the public router path with the same sample"
    );
}

#[test]
fn opaque_helper_missing_server_reports_router_stage() {
    let manifest = req03_opaque_manifest("req03_opaque_missing_server");
    let body = req03_body("some-other-model");

    let source = resolve_v3_relay_opaque_target_once(
        &manifest,
        "missing-server",
        "responses",
        "/v1/responses",
        &body,
        0,
    )
    .expect_err("a missing server must raise a typed source");
    assert_eq!(source.source_kind, V3ErrorSourceKind::RuntimeFailure);
    assert_eq!(source.source_stage, "V3Router05RequestClassified");
    assert_eq!(source.code, "target_resolution_classification_failed");
}

#[test]
fn opaque_helper_endpoint_protocol_mismatch_reports_router_stage() {
    let manifest = req03_opaque_manifest("req03_opaque_endpoint");
    let body = req03_body("some-other-model");

    let source = resolve_v3_relay_opaque_target_once(
        &manifest,
        "req03_opaque_endpoint",
        "responses",
        "/v1/messages",
        &body,
        0,
    )
    .expect_err("an endpoint/entry protocol mismatch must raise a typed source");
    assert_eq!(source.source_kind, V3ErrorSourceKind::RuntimeFailure);
    assert_eq!(source.source_stage, "V3Router05RequestClassified");
    assert_eq!(source.code, "target_resolution_classification_failed");
}

#[test]
fn coordinator_preserves_classification_stage_on_missing_server() {
    let manifest = req03_opaque_manifest("req03_opaque_coordinator");
    let body = req03_body("some-other-model");
    let health = V3ProviderFailureRuntimeHealth::from_manifest(&manifest);
    let scope = req03_scope("req03_opaque_coordinator", "req03-coordinator-session");

    let resolution = resolve_v3_relay_target_outcome(V3RelayProviderTargetResolutionInput {
        manifest: &manifest,
        server_id: "missing-server",
        entry_kind: "responses",
        endpoint_path: "/v1/responses",
        body: &body,
        request_local_excluded_candidates: &BTreeSet::new(),
        failure_session_scope: &scope,
        provider_health: &health,
        now_ms: 1,
        deterministic_sample: 0,
    });
    let V3RelayProviderTargetResolution::Failed(source) = resolution else {
        panic!("a missing server must fail through the coordinator");
    };
    assert_eq!(source.source_stage, "V3Router05RequestClassified");
    assert_eq!(source.code, "target_resolution_classification_failed");
}
