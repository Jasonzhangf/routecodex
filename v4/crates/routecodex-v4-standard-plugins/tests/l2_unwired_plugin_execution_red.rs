//! Red tests for standard plugins that were not covered by an independent
//! `NodeContainer` execution red/green pair in this crate.
//!
//! Every plugin listed here is declared by `standard_plugins()` and registered
//! in `StandardHandleRegistry`. This file locks the typed handle behaviour for
//! the direct console observer plugins so future regressions cannot silently
//! turn them into dead code.

use routecodex_v4_cordis_bridge::{BridgeError, NodeExecutionInput};
use routecodex_v4_node_container::{NodeContainer, NodeContainerError, PlanBindings};
use routecodex_v4_plugin_plan::NodePluginPlan;
use routecodex_v4_standard_plugins::{
    compile_standard_plan, compile_production_execution_plans, standard_plugins,
    StandardHandleRegistry,
};
use routecodex_v4_skeleton::SkeletonPlan;
use serde_json::{json, Value};
use std::collections::BTreeSet;
use std::fs;

/// Plugins covered by this file.
const UNWIRED_PLUGINS: &[&str] = &[
    "v4.std.diagnostic.direct_request_payload_console_render",
    "v4.std.diagnostic.direct_response_payload_console_render",
    "v4.std.provider.transport_mock",
];

fn plan_bindings(plan: &NodePluginPlan) -> PlanBindings {
    let hash = plan.plan_hash();
    PlanBindings {
        graph_hash: hash.clone(),
        manifest_hash: hash.clone(),
        loaded_plan_hash: hash,
    }
}

fn publish_container(mut container: NodeContainer) -> NodeContainer {
    container.context_created().unwrap();
    container.plugins_mounted().unwrap();
    container.publish().unwrap();
    container
}

fn execute_plugin(
    node_id: &str,
    role_id: &str,
    chain_id: &str,
    position: u32,
    plugin_id: &str,
    data: Value,
    control: Value,
    information: Value,
) -> Result<routecodex_v4_cordis_bridge::NodeExecutionOutput, NodeContainerError> {
    let plan = compile_standard_plan(node_id, role_id, chain_id, position, &[plugin_id])
        .expect("plugin plan compiles");
    let hash = plan.plan_hash();
    let mut container = NodeContainer::declare(node_id, plan.clone(), plan_bindings(&plan))
        .expect("binding passes");
    container = publish_container(container);
    let registry = StandardHandleRegistry::new();
    let output = container.execute_with_plan_hash(
        &hash,
        NodeExecutionInput {
            data,
            control,
            information,
        },
        &registry,
    );
    container.drain().unwrap();
    container.dispose().unwrap();
    output
}

fn production_skeleton() -> SkeletonPlan {
    let path = format!(
        "{}/../../contracts/skeleton-plan.contract.json",
        env!("CARGO_MANIFEST_DIR")
    );
    let text = fs::read_to_string(&path).expect("production contract readable");
    SkeletonPlan::from_contract_json(&text).expect("production skeleton compiles")
}

fn production_plan_ids() -> BTreeSet<String> {
    let compiled = compile_production_execution_plans(&production_skeleton())
        .expect("production plans compile");
    compiled
        .plans
        .iter()
        .flat_map(|plan| plan.entries.iter().map(|entry| entry.plugin_id.clone()))
        .collect()
}

#[test]
fn unwired_matrix_matches_declared_standard_plugins() {
    let plugins = standard_plugins();
    let declared: BTreeSet<&str> = plugins
        .iter()
        .map(|plugin| plugin.plugin_id.as_str())
        .collect();
    let missing: Vec<&&str> = UNWIRED_PLUGINS
        .iter()
        .filter(|id| !declared.contains(**id))
        .collect();
    assert!(
        missing.is_empty(),
        "UNWIRED_PLUGINS lists ids that are no longer declared: {missing:?}"
    );
}

#[test]
fn every_unwired_plugin_has_a_typed_handle() {
    let registry = StandardHandleRegistry::new();
    let mut missing = Vec::new();
    for plugin_id in UNWIRED_PLUGINS {
        if registry.get_handle(plugin_id).is_none() {
            missing.push(*plugin_id);
        }
    }
    assert!(
        missing.is_empty(),
        "unwired plugins missing typed handle: {missing:?}"
    );
}

#[test]
fn ineligible_unwired_plugins_must_not_appear_in_production_plans() {
    let ineligible = [
        "v4.std.provider.transport_mock",
    ];
    let in_production = production_plan_ids();
    let leaks: Vec<&&str> = ineligible
        .iter()
        .filter(|id| in_production.contains(**id))
        .collect();
    assert!(
        leaks.is_empty(),
        "ineligible plugins leaked into production plans: {leaks:?}"
    );
}

#[test]
fn positive_direct_request_console_preserves_payload_and_emits_fact() {
    let payload = json!({
        "model": "m",
        "stream": false,
        "input": [{"role": "user", "content": "hi"}],
        "secret": "must-not-leak"
    });
    let output = execute_plugin(
        "V4DirectReq01ClientProtocol",
        "request_inbound",
        "direct_request",
        1,
        "v4.std.diagnostic.direct_request_payload_console_render",
        payload.clone(),
        json!({}),
        json!({}),
    )
    .expect("direct request console executes");
    assert_eq!(
        output.data, payload,
        "observer must preserve the request payload"
    );
    assert_eq!(output.control, json!({}));
    let message = output
        .diagnostics
        .iter()
        .find(|fact| fact.kind == "console.payload_ready")
        .map(|fact| fact.message.as_str())
        .expect("console payload fact exists");
    assert!(
        message.contains("model=m") && !message.contains("must-not-leak"),
        "console fact must be compact and leak-free: {message}"
    );
}

#[test]
fn negative_direct_request_console_rejects_non_object_payload() {
    let error = execute_plugin(
        "V4DirectReq01ClientProtocol",
        "request_inbound",
        "direct_request",
        1,
        "v4.std.diagnostic.direct_request_payload_console_render",
        json!(["not-object"]),
        json!({}),
        json!({}),
    )
    .expect_err("direct console requires object payload");
    assert!(matches!(
        error,
        NodeContainerError::Bridge(BridgeError::HandleError { .. })
    ));
}

#[test]
fn positive_direct_response_console_preserves_payload_and_emits_fact() {
    let payload = json!({
        "id": "resp-1",
        "model": "m",
        "output": [{"type": "message", "content": []}],
        "usage": {"input_tokens": 3, "output_tokens": 5},
        "private": "must-not-leak"
    });
    let output = execute_plugin(
        "V4DirectResp01ProviderRaw",
        "response_inbound",
        "direct_response",
        1,
        "v4.std.diagnostic.direct_response_payload_console_render",
        payload.clone(),
        json!({}),
        json!({}),
    )
    .expect("direct response console executes");
    assert_eq!(output.data, payload);
    assert_eq!(output.control, json!({}));
    let message = output
        .diagnostics
        .iter()
        .find(|fact| fact.kind == "console.payload_ready")
        .map(|fact| fact.message.as_str())
        .expect("console payload fact exists");
    assert!(
        message.contains("model=m") && !message.contains("must-not-leak"),
        "console fact must be compact and leak-free: {message}"
    );
}

#[test]
fn negative_direct_response_console_rejects_non_object_payload() {
    let error = execute_plugin(
        "V4DirectResp01ProviderRaw",
        "response_inbound",
        "direct_response",
        1,
        "v4.std.diagnostic.direct_response_payload_console_render",
        json!("not-object"),
        json!({}),
        json!({}),
    )
    .expect_err("direct response console requires object payload");
    assert!(matches!(
        error,
        NodeContainerError::Bridge(BridgeError::HandleError { .. })
    ));
}

#[test]
fn positive_transport_mock_emits_typed_transport_fact() {
    let output = execute_plugin(
        "V4ProviderReqOutbound09TransportRequest",
        "request_outbound",
        "relay_request",
        9,
        "v4.std.provider.transport_mock",
        json!({"model": "m", "input": "hi"}),
        json!({}),
        json!({}),
    )
    .expect("transport mock executes");
    let kinds: Vec<&str> = output.diagnostics.iter().map(|f| f.kind.as_str()).collect();
    assert!(
        kinds
            .iter()
            .any(|k| *k == "node.provider_transport_validated"),
        "transport mock must emit its typed diagnostic: {kinds:?}"
    );
    assert_eq!(output.control, json!({}));
}

#[test]
fn negative_transport_mock_rejects_non_object_payload() {
    let error = execute_plugin(
        "V4ProviderReqOutbound09TransportRequest",
        "request_outbound",
        "relay_request",
        9,
        "v4.std.provider.transport_mock",
        json!(["not-object"]),
        json!({}),
        json!({}),
    )
    .expect_err("transport mock requires object wire payload");
    assert!(matches!(
        error,
        NodeContainerError::Bridge(BridgeError::HandleError { .. })
    ));
}
