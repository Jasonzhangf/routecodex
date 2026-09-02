//! RED tests: every standard plugin must be reachable through the production
//! chain contract (`v4/contracts/skeleton-plan.contract.json`).
//!
//! These tests lock the production contract: every published node plan must
//! carry its immutable `v4.std.*` bindings and every binding must resolve to a
//! runtime handle. A narrow two-plan runtime must fail this suite.

use routecodex_v4_skeleton::SkeletonPlan;
use routecodex_v4_standard_plugins::{
    compile_production_execution_plans, standard_plugins, StandardHandleRegistry,
};
use serde_json::Value;
use std::collections::HashMap;
use std::fs;

fn production_contract() -> Value {
    let path = format!(
        "{}/../../contracts/skeleton-plan.contract.json",
        env!("CARGO_MANIFEST_DIR")
    );
    let text = fs::read_to_string(&path)
        .expect("skeleton plan contract must be readable from v4 root");
    serde_json::from_str(&text).expect("skeleton plan contract must parse as JSON")
}

fn plugin_ids_by_node(contract: &Value) -> HashMap<String, Vec<String>> {
    let mut by_node = HashMap::new();
    for chain in contract["chains"].as_array().into_iter().flatten() {
        for node in chain["nodes"].as_array().into_iter().flatten() {
            let node_id = node["node_id"]
                .as_str()
                .expect("production node_id is a string")
                .to_string();
            let plugins = node["plugins"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|binding| binding["plugin_id"].as_str())
                .map(str::to_string)
                .collect::<Vec<_>>();
            by_node.insert(node_id, plugins);
        }
    }
    by_node
}

#[test]
fn every_standard_plugin_is_registered_with_typed_handle() {
    let registry = StandardHandleRegistry::new();
    for plugin in standard_plugins() {
        assert!(
            registry.get_handle(&plugin.plugin_id).is_some(),
            "{} has no typed handle in StandardHandleRegistry",
            plugin.plugin_id
        );
    }
}

#[test]
fn every_standard_plugin_is_bound_in_production_chain_contract() {
    let contract = production_contract();
    let by_node = plugin_ids_by_node(&contract);
    let mut missing = Vec::new();

    // Codec alternates and *_mock descriptors are not production chain nodes.
    // They have separate owners or are explicitly ineligible for publication;
    // requiring them in this graph would turn the red gate into a false
    // positive.
    let side_channel_or_ineligible: [&str; 0] = [];
    for plugin in standard_plugins()
        .into_iter()
        .filter(|plugin| !side_channel_or_ineligible.contains(&plugin.plugin_id.as_str()))
    {
        let node_id = &plugin.descriptor.node_selector.node_id;
        let bound = by_node
            .get(node_id)
            .map(|plugins| plugins.iter().any(|id| id == &plugin.plugin_id))
            .unwrap_or(false);
        if !bound {
            missing.push(format!("{} -> {}", plugin.plugin_id, node_id));
        }
    }

    assert!(
        missing.is_empty(),
        "standard plugins not bound into production chain contract:\n{}",
        missing.join("\n")
    );
}

#[test]
fn production_contract_has_no_duplicate_standard_plugin_binding() {
    let contract = production_contract();
    let mut seen = HashMap::new();
    for chain in contract["chains"].as_array().into_iter().flatten() {
        for node in chain["nodes"].as_array().into_iter().flatten() {
            let node_id = node["node_id"].as_str().unwrap_or_default();
            for binding in node["plugins"].as_array().into_iter().flatten() {
                let plugin_id = binding["plugin_id"].as_str().unwrap_or_default();
                let entry = seen.entry(plugin_id.to_string()).or_insert_with(Vec::new);
                entry.push(node_id.to_string());
            }
        }
    }
    let duplicates: Vec<(String, Vec<String>)> = seen
        .into_iter()
        .filter(|(_, nodes)| nodes.len() > 1)
        .collect();
    assert!(
        duplicates.is_empty(),
        "standard plugin ids bound to multiple production nodes: {duplicates:?}"
    );
}

#[test]
fn every_compiled_production_entry_has_a_runtime_handle() {
    let contract = production_contract();
    let skeleton = SkeletonPlan::from_contract_json(
        &serde_json::to_string(&contract).expect("contract serializes"),
    )
    .expect("production skeleton compiles");
    let compiled = compile_production_execution_plans(&skeleton)
        .expect("production plans compile");
    let registry = StandardHandleRegistry::new();
    let mut missing = Vec::new();
    for plan in compiled.plans {
        for entry in plan.entries {
            if registry.get_handle(&entry.plugin_id).is_none() {
                missing.push(format!("{} -> {}", plan.node_id, entry.plugin_id));
            }
        }
    }
    assert!(missing.is_empty(), "compiled production entries lack handles: {missing:?}");
}

#[test]
fn compiled_production_plans_cover_every_runtime_node() {
    let contract = production_contract();
    let skeleton = SkeletonPlan::from_contract_json(
        &serde_json::to_string(&contract).expect("contract serializes"),
    )
    .expect("production skeleton compiles");
    let compiled = compile_production_execution_plans(&skeleton)
        .expect("production plans compile");
    let expected_nodes = skeleton
        .chains
        .iter()
        .filter(|chain| matches!(
            chain.chain_id.as_str(),
            "direct_request" | "direct_response" | "relay_request" | "relay_response" | "error" | "control"
        ))
        .map(|chain| chain.nodes.len())
        .sum::<usize>();
    assert_eq!(compiled.plans.len(), expected_nodes);
    let bound_plugins = compiled
        .plans
        .iter()
        .flat_map(|plan| plan.entries.iter().map(|entry| entry.plugin_id.as_str()))
        .filter(|plugin_id| plugin_id.starts_with("v4.std."))
        .count();
    assert!(bound_plugins > 2, "production wiring must not collapse to two plugin entries");
}

#[test]
fn request_chat_process_has_executable_governance_handle() {
    let contract = production_contract();
    let skeleton = SkeletonPlan::from_contract_json(
        &serde_json::to_string(&contract).expect("contract serializes"),
    )
    .expect("production skeleton compiles");
    let compiled = compile_production_execution_plans(&skeleton)
        .expect("production plans compile");
    let plan = compiled
        .plans
        .iter()
        .find(|plan| plan.node_id == "V4HubReqChatProcess03Governed")
        .expect("request Chat Process plan must exist");
    assert!(
        plan.entries.iter().any(|entry| {
            entry.plugin_id == "v4.std.chat_process.request_governance"
                && !matches!(entry.effect, routecodex_v4_plugin_contract::PluginEffect::DiagnosticOnly)
        }),
        "request Chat Process must execute governance through its plugin handle"
    );
}
