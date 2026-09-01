//! RED tests: every production standard plugin must be reachable through the
//! compiled skeleton plan contract (`v4/contracts/skeleton-plan.contract.json`).
//!
//! Current baseline intentionally fails on the request, response, direct,
//! error and control binding surfaces. The runtime compiler (`routecodex-v4-
//! config`) derives production `NodePluginPlan`s from node ids, while the
//! compiled contract still lists runtime-local aliases (`normalize`,
//! `governance`, `wire_build`, ...) for most production nodes. These tests
//! lock the exact plugin->node expectations before any wiring changes, so each
//! chain can be repaired independently.

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

/// Expected production plugin bindings. Plugins that are deliberately mock or
/// superseded (`EXCLUDED_PLUGINS` in `compile_production_execution_plans`) are
/// not listed here; control-center resources are covered by their own test.
fn expected_production_bindings() -> &'static [(&'static str, &'static str)] {
    &[
        // relay_request
        (
            "v4.std.contract.input_validate",
            "V4HubReqInbound02Normalized",
        ),
        (
            "v4.std.request.responses_normalize",
            "V4HubReqInbound02Normalized",
        ),
        (
            "v4.std.diagnostic.debug_observe",
            "V4HubReqChatProcess03Governed",
        ),
        (
            "v4.std.diagnostic.timing",
            "V4HubReqChatProcess03Governed",
        ),
        (
            "v4.std.diagnostic.snapshot_record",
            "V4HubReqChatProcess03Governed",
        ),
        (
            "v4.std.diagnostic.request_payload_console_render",
            "V4HubReqChatProcess03Governed",
        ),
        (
            "v4.std.chat_process.request_governance",
            "V4HubReqChatProcess03Governed",
        ),
        (
            "v4.std.routing.route_facts_producer",
            "V4HubReqExecution04Planned",
        ),
        (
            "v4.std.routing.route_facts_consumer",
            "V4HubReqTarget05Resolved",
        ),
        (
            "v4.std.request.responses_wire_build",
            "V4ProviderReqCompat07ProviderCompat",
        ),
        (
            "v4.std.provider.wire_build",
            "V4ProviderReqOutbound08WirePayload",
        ),
        ("v4.hook.relay.request", "V4HubReqOutbound06ProviderSemantic"),
        // relay_response
        (
            "v4.std.response.provider_compat",
            "V4ProviderRespCompat02ProviderCompat",
        ),
        (
            "v4.std.response.protocol_decode",
            "V4HubRespInbound03Normalized",
        ),
        (
            "v4.std.diagnostic.response_payload_console_render",
            "V4HubRespChatProcess04Governed",
        ),
        (
            "v4.std.chat_process.response_governance",
            "V4HubRespChatProcess04Governed",
        ),
        (
            "v4.std.chat_process.tool_harvest",
            "V4HubRespChatProcess04Governed",
        ),
        (
            "v4.std.contract.output_validate",
            "V4HubRespOutbound05ClientSemantic",
        ),
        (
            "v4.std.response.frame_build",
            "V4ServerRespOutbound06ClientFrame",
        ),
        (
            "v4.hook.relay.response",
            "V4HubRespOutbound05ClientSemantic",
        ),
        // direct_request
        (
            "v4.std.diagnostic.direct_request_payload_console_render",
            "V4DirectReq01ClientProtocol",
        ),
        (
            "v4.hook.direct.request",
            "V4DirectReq02RelayContainer",
        ),
        // direct_response
        (
            "v4.std.diagnostic.direct_response_payload_console_render",
            "V4DirectResp01ProviderRaw",
        ),
        (
            "v4.hook.direct.response",
            "V4DirectResp02RelayContainer",
        ),
        // error
        ("v4.std.error.typed_intake", "V4Error01SourceRaised"),
        (
            "v4.std.error.projection_adapter",
            "V4Error06ClientProjected",
        ),
    ]
}

fn missing_for_chain(
    contract: &Value,
    chain_id: &str,
    bindings: &[(&str, &str)],
) -> Vec<String> {
    let by_node = plugin_ids_by_node(contract);
    let mut missing = Vec::new();
    for (plugin_id, node_id) in bindings {
        let node_chain = contract["chains"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|chain| chain["chain_id"].as_str() == Some(chain_id))
            .flat_map(|chain| chain["nodes"].as_array().into_iter().flatten())
            .find(|node| node["node_id"].as_str() == Some(node_id))
            .is_some();
        if !node_chain {
            continue;
        }
        let bound = by_node
            .get(*node_id)
            .map(|plugins| plugins.iter().any(|id| id == plugin_id))
            .unwrap_or(false);
        if !bound {
            missing.push(format!("{} -> {}", plugin_id, node_id));
        }
    }
    missing
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

    for plugin in standard_plugins() {
        if is_mock_or_superseded(&plugin.plugin_id) {
            continue;
        }
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

fn is_mock_or_superseded(plugin_id: &str) -> bool {
    matches!(
        plugin_id,
        "v4.std.provider.capability_mock"
            | "v4.std.provider.auth_handle_mock"
            | "v4.std.provider.wire_mock"
            | "v4.std.provider.transport_mock"
            | "v4.std.protocol.wire_codec_proto"
            | "v4.std.request.governance"
    )
}

#[test]
fn relay_request_production_bindings_are_present() {
    let contract = production_contract();
    let missing = missing_for_chain(&contract, "relay_request", expected_production_bindings());
    assert!(
        missing.is_empty(),
        "relay_request production bindings missing:\n{}",
        missing.join("\n")
    );
}

#[test]
fn relay_response_production_bindings_are_present() {
    let contract = production_contract();
    let missing = missing_for_chain(&contract, "relay_response", expected_production_bindings());
    assert!(
        missing.is_empty(),
        "relay_response production bindings missing:\n{}",
        missing.join("\n")
    );
}

#[test]
fn direct_request_production_bindings_are_present() {
    let contract = production_contract();
    let missing = missing_for_chain(&contract, "direct_request", expected_production_bindings());
    assert!(
        missing.is_empty(),
        "direct_request production bindings missing:\n{}",
        missing.join("\n")
    );
}

#[test]
fn direct_response_production_bindings_are_present() {
    let contract = production_contract();
    let missing = missing_for_chain(&contract, "direct_response", expected_production_bindings());
    assert!(
        missing.is_empty(),
        "direct_response production bindings missing:\n{}",
        missing.join("\n")
    );
}

#[test]
fn error_production_bindings_are_present() {
    let contract = production_contract();
    let missing = missing_for_chain(&contract, "error", expected_production_bindings());
    assert!(
        missing.is_empty(),
        "error production bindings missing:\n{}",
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
