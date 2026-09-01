//! RED tests: every standard plugin must be reachable through the production
//! chain contract (`v4/contracts/skeleton-plan.contract.json`).
//!
//! Current baseline intentionally fails: `standard_plugins()` registers 29
//! typed handles, but production chains still bind runtime-local plugin ids
//! (`normalize`, `governance`, `wire_build`, ...) instead of the immutable
//! `v4.std.*` plugin ids. These tests lock that wiring gap as behavior_red
//! before any implementation is changed.

use routecodex_v4_standard_plugins::{standard_plugins, StandardHandleRegistry};
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

    // Control-center projections, codec alternates, and *_mock descriptors
    // are not production chain nodes. They have separate owners or are
    // explicitly ineligible for publication; requiring them in this graph
    // would turn the red gate into a false positive.
    let side_channel_or_ineligible = [
        "v4.std.control.scope_consume",
        "v4.std.control.payload_cycle_record",
        "v4.std.protocol.wire_codec_proto",
        "v4.std.provider.capability_mock",
        "v4.std.provider.auth_handle_mock",
        "v4.std.provider.wire_mock",
        "v4.std.provider.transport_mock",
        "v4.std.request.governance",
    ];
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
