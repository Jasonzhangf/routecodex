//! REQ04 typed Target owner regression.
//!
//! `expand_v3_relay_target_candidates_from_opaque_hit` consumes a real
//! `V3Router07OpaqueTargetHitOnce` from the public Virtual Router and produces
//! the existing `V3Target09CandidateSetExpanded`. It must preserve the route
//! facts and deterministic sample, keep candidate order, and keep the existing
//! typed expansion failure stage/code.

use super::*;
use routecodex_v3_config::{
    compile_v3_config_05_manifest, parse_v3_config_02_authoring, V3RouteTargetKind,
};
use routecodex_v3_error::V3ProviderFailureSessionScope;
use routecodex_v3_virtual_router::V3Router07OpaqueTargetHitOnce;
use serde_json::json;
use std::collections::BTreeSet;

fn req04_target_manifest(scope: &str) -> V3Config05ManifestPublished {
    let source = r#"
version = 3
[servers.__SCOPE__]
bind = "127.0.0.1"
port = 5555
routing_group = "__SCOPE__"
endpoints = ["responses"]
[providers.alpha]
type = "responses"
base_url = "http://alpha.invalid/v1"
default_model = "alpha-model"
auth = { type = "api_key", entries = [
  { alias = "alpha-key-1", env = "ALPHA_KEY_1" },
  { alias = "alpha-key-2", env = "ALPHA_KEY_2" }
] }
[providers.alpha.models.alpha-model]
wire_name = "alpha-wire"
capabilities = ["text"]
[providers.beta]
type = "responses"
base_url = "http://beta.invalid/v1"
default_model = "beta-model"
auth = { type = "api_key", entries = [{ alias = "beta-key", env = "BETA_KEY" }] }
[providers.beta.models.beta-model]
wire_name = "beta-wire"
capabilities = ["text"]
[route_groups.__SCOPE__.pools.default]
selection = { strategy = "priority" }
targets = [
  { kind = "provider_model", provider = "alpha", model = "alpha-model", priority = 2 },
  { kind = "provider_model", provider = "beta", model = "beta-model", key = "beta-key", priority = 1 }
]
"#
    .replace("__SCOPE__", scope);
    compile_v3_config_05_manifest(
        parse_v3_config_02_authoring(&source).expect("req04 target authoring"),
    )
    .expect("req04 target manifest")
}

fn req04_target_body(model: &str) -> Value {
    json!({
        "model": model,
        "input": "preserve this target body",
        "metadata": { "opaque": { "nested": [1, 2, 3] } }
    })
}

fn req04_target_hit(
    manifest: &V3Config05ManifestPublished,
    scope: &str,
    deterministic_sample: u64,
) -> V3Router07OpaqueTargetHitOnce {
    let body = req04_target_body("client-model");
    let facts = crate::build_v3_router_request_facts_for_entry_with_manifest(
        &body,
        "responses",
        crate::configured_v3_longcontext_threshold_tokens(manifest, scope),
        manifest,
    );
    let router = V3VirtualRouter::default();
    let classified = router
        .classify_request_with_facts(manifest, scope, "/v1/responses", facts)
        .expect("req04 target classification");
    let plan = router
        .resolve_route_pool_plan(manifest, classified)
        .expect("req04 target route plan");
    router
        .hit_opaque_target_plan_once(plan, deterministic_sample)
        .expect("req04 target opaque hit")
}

#[test]
fn req04_target_expands_multi_provider_auth_model_in_route_order() {
    let manifest = req04_target_manifest("req04_target_order");
    let hit = req04_target_hit(&manifest, "req04_target_order", 0);
    let expected_route = hit.clone();

    let expanded = expand_v3_relay_target_candidates_from_opaque_hit(&manifest, hit, 0)
        .expect("req04 target expansion");

    assert_eq!(
        expanded.route, expected_route,
        "Target expansion must preserve the complete opaque route facts"
    );
    assert_eq!(expanded.route.target_kind, V3RouteTargetKind::ProviderModel);
    assert_eq!(expanded.route.target_plan.len(), 2);
    assert_eq!(
        expanded
            .candidates
            .iter()
            .map(|candidate| (
                candidate.provider_id.as_str(),
                candidate.auth_alias.as_str(),
                candidate.model_id.as_str(),
                candidate.wire_model.as_str(),
            ))
            .collect::<Vec<_>>(),
        vec![
            ("alpha", "alpha-key-1", "alpha-model", "alpha-wire"),
            ("alpha", "alpha-key-2", "alpha-model", "alpha-wire"),
            ("beta", "beta-key", "beta-model", "beta-wire"),
        ],
        "provider, auth, and model order must come from the opaque target plan"
    );
}

#[test]
fn req04_target_threads_deterministic_sample_to_auth_expansion() {
    let manifest = req04_target_manifest("req04_target_sample");

    let sample_zero_hit = req04_target_hit(&manifest, "req04_target_sample", 0);
    let sample_zero =
        expand_v3_relay_target_candidates_from_opaque_hit(&manifest, sample_zero_hit, 0)
            .expect("sample zero expansion");
    assert_eq!(
        sample_zero
            .candidates
            .iter()
            .map(|candidate| candidate.auth_alias.as_str())
            .collect::<Vec<_>>(),
        vec!["alpha-key-1", "alpha-key-2", "beta-key"]
    );

    let sample_one_hit = req04_target_hit(&manifest, "req04_target_sample", 1);
    let sample_one =
        expand_v3_relay_target_candidates_from_opaque_hit(&manifest, sample_one_hit, 1)
            .expect("sample one expansion");
    assert_eq!(
        sample_one
            .candidates
            .iter()
            .map(|candidate| candidate.auth_alias.as_str())
            .collect::<Vec<_>>(),
        vec!["alpha-key-2", "alpha-key-1", "beta-key"],
        "the deterministic sample must reach existing auth-entry expansion"
    );
}

#[test]
fn req04_target_preserves_existing_expansion_failure_stage_and_code() {
    let manifest = req04_target_manifest("req04_target_failure");
    let hit = req04_target_hit(&manifest, "req04_target_failure", 0);
    let different_manifest = req04_target_manifest("req04_target_other");

    let source = expand_v3_relay_target_candidates_from_opaque_hit(&different_manifest, hit, 0)
        .expect_err("a real hit expanded against a different manifest must fail");

    assert_eq!(source.source_kind, V3ErrorSourceKind::RuntimeFailure);
    assert_eq!(source.source_stage, "V3Target09CandidateSetExpanded");
    assert_eq!(source.code, "target_resolution_candidate_expansion_failed");
}

#[test]
fn req04_target_coordinator_selects_without_changing_payload() {
    let manifest = req04_target_manifest("req04_target_coordinator");
    let body = req04_target_body("client-model");
    let snapshot = body.clone();
    let health = V3ProviderFailureRuntimeHealth::from_manifest(&manifest);
    let scope = V3ProviderFailureSessionScope::new(
        "req04_target_coordinator",
        "req04_target_coordinator",
        "req04-target-session",
    )
    .expect("req04 target session scope");

    let resolution = resolve_v3_relay_target_outcome(V3RelayProviderTargetResolutionInput {
        manifest: &manifest,
        server_id: "req04_target_coordinator",
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
        "the coordinator must select through the shared Target expansion helper"
    );
    assert_eq!(
        body, snapshot,
        "Target expansion and selection must not mutate the request payload"
    );
}
