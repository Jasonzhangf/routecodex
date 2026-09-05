//! Red tests for provider response inbound plugins.
//!
//! The raw validator and SSE frame boundary are the first relay response
//! nodes. They must parse opaque transport frames through the plugin owner and
//! classify continue/complete/failure without letting control facts into data.

use routecodex_v4_cordis_bridge::{NodeExecutionInput, SharedTransportCarrier};
use routecodex_v4_node_container::{NodeContainer, NodeContainerError, PlanBindings};
use routecodex_v4_standard_plugins::{compile_standard_plan, StandardHandleRegistry};
use serde_json::{json, Value};
use std::sync::Arc;

fn execute(
    plugin_id: &str,
    data: Value,
) -> Result<routecodex_v4_cordis_bridge::NodeExecutionOutput, NodeContainerError> {
    execute_with_transport(plugin_id, data, None)
}

fn execute_sse(
    plugin_id: &str,
    frame: &[u8],
) -> Result<routecodex_v4_cordis_bridge::NodeExecutionOutput, NodeContainerError> {
    execute_with_transport(
        plugin_id,
        json!({}),
        Some(SharedTransportCarrier::from_shared_bytes(Arc::from(frame))),
    )
}

fn execute_with_transport(
    plugin_id: &str,
    data: Value,
    transport: Option<SharedTransportCarrier>,
) -> Result<routecodex_v4_cordis_bridge::NodeExecutionOutput, NodeContainerError> {
    let (node_id, chain_id) = if plugin_id == "v4.std.direct.response.sse_frame_boundary" {
        ("V4DirectResp01ProviderRaw", "direct_response")
    } else {
        ("V4ProviderRespInbound01Raw", "relay_response")
    };
    let plan = compile_standard_plan(node_id, "response_inbound", chain_id, 1, &[plugin_id])
        .expect("provider inbound plan compiles");
    let hash = plan.plan_hash();
    let bindings = PlanBindings {
        graph_hash: hash.clone(),
        manifest_hash: hash.clone(),
        loaded_plan_hash: hash.clone(),
    };
    let mut container = NodeContainer::declare(node_id, plan, bindings)
        .expect("binding passes");
    container.context_created().unwrap();
    container.plugins_mounted().unwrap();
    container.publish().unwrap();
    let output = container.execute_with_plan_hash(
        &hash,
        NodeExecutionInput {
            data,
            control: json!({}),
            information: json!({}),
            transport,
        },
        &StandardHandleRegistry::new(),
    );
    container.drain().unwrap();
    container.dispose().unwrap();
    output
}

#[test]
fn positive_provider_raw_validate_preserves_raw_envelope() {
    let raw = json!({"id":"resp-1","output":[]});
    let output = execute("v4.std.response.provider_raw_validate", raw.clone())
        .expect("valid provider raw is accepted");
    assert_eq!(output.data, raw);
    assert_eq!(output.control, json!({}));
}

#[test]
fn negative_provider_raw_validate_rejects_non_object() {
    let error = execute("v4.std.response.provider_raw_validate", json!(["bad"]))
        .expect_err("provider raw must be object");
    assert!(matches!(
        error,
        NodeContainerError::Bridge(routecodex_v4_cordis_bridge::BridgeError::HandleError { .. })
    ));
}

#[test]
fn positive_provider_sse_boundary_decodes_continue_frame() {
    let frame = b"event: response.output_text.delta\ndata: {\"type\":\"response.output_text.delta\",\"delta\":\"hi\"}\n\n";
    let output = execute_sse("v4.std.response.sse_frame_boundary", frame)
    .expect("SSE frame boundary decodes");
    assert_eq!(output.data["type"], json!("response.output_text.delta"));
    assert_eq!(output.data["delta"], json!("hi"));
    let kinds: Vec<&str> = output.diagnostics.iter().map(|f| f.kind.as_str()).collect();
    assert!(
        kinds.iter().any(|k| *k == "provider_sse_disposition"),
        "SSE boundary must emit disposition: {kinds:?}"
    );
}

#[test]
fn negative_provider_sse_boundary_rejects_malformed_frame() {
    let frame = b"event: response.output_text.delta\ndata: {bad}\n\n";
    let error = execute_sse("v4.std.response.sse_frame_boundary", frame)
    .expect_err("malformed SSE frame must fail fast");
    assert!(matches!(
        error,
        NodeContainerError::Bridge(routecodex_v4_cordis_bridge::BridgeError::HandleError { .. })
    ));
}

#[test]
fn positive_direct_sse_boundary_decodes_frame_without_relay_semantics() {
    let frame = b"event: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp-1\"}}\n\n";
    let output = execute_sse("v4.std.direct.response.sse_frame_boundary", frame)
    .expect("direct SSE boundary decodes");
    assert_eq!(output.data["type"], json!("response.completed"));
    let kinds: Vec<&str> = output.diagnostics.iter().map(|f| f.kind.as_str()).collect();
    assert!(
        kinds.iter().any(|k| *k == "provider_sse_disposition"),
        "direct SSE boundary must emit disposition: {kinds:?}"
    );
}
