//! Red tests for direct request/response boundary validators.
//!
//! These plugins are production-bound at Direct wire and client protocol
//! stages. They must validate the typed adjacent boundary without reading
//! control state or changing data.

use routecodex_v4_cordis_bridge::NodeExecutionInput;
use routecodex_v4_node_container::{NodeContainer, NodeContainerError, PlanBindings};
use routecodex_v4_standard_plugins::{compile_standard_plan, StandardHandleRegistry};
use serde_json::{json, Value};

fn execute(
    node_id: &str,
    role_id: &str,
    chain_id: &str,
    position: u32,
    plugin_id: &str,
    data: Value,
    information: Value,
) -> Result<routecodex_v4_cordis_bridge::NodeExecutionOutput, NodeContainerError> {
    let plan = compile_standard_plan(node_id, role_id, chain_id, position, &[plugin_id])
        .expect("direct boundary plan compiles for its declared lane");
    let hash = plan.plan_hash();
    let bindings = PlanBindings {
        graph_hash: hash.clone(),
        manifest_hash: hash.clone(),
        loaded_plan_hash: hash.clone(),
    };
    let mut container = NodeContainer::declare(node_id, plan, bindings).expect("binding passes");
    container.context_created().unwrap();
    container.plugins_mounted().unwrap();
    container.publish().unwrap();
    let output = container.execute_with_plan_hash(
        &hash,
        NodeExecutionInput {
            data,
            control: json!({}),
            information,
            transport: None,
        },
        &StandardHandleRegistry::new(),
    );
    container.drain().unwrap();
    container.dispose().unwrap();
    output
}

#[test]
fn positive_direct_request_wire_validate_preserves_wire_payload() {
    let payload = json!({"model":"m","input":"hello"});
    let output = execute(
        "V4DirectReq03ProviderWire",
        "request_outbound",
        "direct_request",
        3,
        "v4.std.direct.request.wire_validate",
        payload.clone(),
        json!({}),
    )
    .expect("valid direct wire is accepted");
    assert_eq!(output.data, payload);
    assert_eq!(output.control, json!({}));
    let kinds: Vec<&str> = output.diagnostics.iter().map(|f| f.kind.as_str()).collect();
    assert!(
        kinds.iter().any(|k| *k == "direct.request.wire_validated"),
        "direct wire validator must emit diagnostic: {kinds:?}"
    );
}

#[test]
fn negative_direct_request_wire_validate_rejects_missing_model() {
    let error = execute(
        "V4DirectReq03ProviderWire",
        "request_outbound",
        "direct_request",
        3,
        "v4.std.direct.request.wire_validate",
        json!({"input":"hello"}),
        json!({}),
    )
    .expect_err("missing model must fail");
    assert!(matches!(
        error,
        NodeContainerError::Bridge(routecodex_v4_cordis_bridge::BridgeError::HandleError { .. })
    ));
}

#[test]
fn positive_direct_response_client_validate_preserves_payload_and_emits_fact() {
    let payload = json!({"type":"response.output_text.delta","id":"resp-1","delta":"hi"});
    let output = execute(
        "V4DirectResp03ClientProtocol",
        "response_outbound",
        "direct_response",
        3,
        "v4.std.direct.response.client_validate",
        payload.clone(),
        json!({"client_protocol":"openai-responses","provider_protocol":"openai-responses","entry_protocol":"responses","stream_terminal":false}),
    )
    .expect("valid direct client response is accepted");
    assert_eq!(output.data, payload);
    let kinds: Vec<&str> = output.diagnostics.iter().map(|f| f.kind.as_str()).collect();
    assert!(
        kinds.iter().any(|k| *k == "direct.response.client_validated"),
        "direct client validator must emit diagnostic: {kinds:?}"
    );
}

#[test]
fn negative_direct_response_client_validate_rejects_protocol_mismatch() {
    let error = execute(
        "V4DirectResp03ClientProtocol",
        "response_outbound",
        "direct_response",
        3,
        "v4.std.direct.response.client_validate",
        json!({"id":"resp-1"}),
        json!({"client_protocol":"openai-chat","provider_protocol":"openai-responses","entry_protocol":"responses","stream_terminal":false}),
    )
    .expect_err("Direct protocol mismatch must fail");
    assert!(matches!(
        error,
        NodeContainerError::Bridge(routecodex_v4_cordis_bridge::BridgeError::HandleError { .. })
    ));
}
