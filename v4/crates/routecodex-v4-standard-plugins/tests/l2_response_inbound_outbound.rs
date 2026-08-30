//! Relay response codec and terminal frame boundary tests.
//!
//! SSE transport has separate opaque-byte tests and is intentionally absent.

use routecodex_v4_cordis_bridge::{BridgeError, NodeExecutionInput};
use routecodex_v4_node_container::{NodeContainer, NodeContainerError, PlanBindings};
use routecodex_v4_plugin_plan::{compile_node_plan, PlanError};
use routecodex_v4_standard_plugins::{
    compile_standard_plan, standard_authoring, standard_container_services,
    standard_node_allowed_reads, standard_node_allowed_writes, standard_resource_registry,
    StandardHandleRegistry,
};
use serde_json::{json, Value};

fn execute(
    node_id: &str,
    position: u32,
    plugin_id: &str,
    data: Value,
    information: Value,
) -> Result<Value, NodeContainerError> {
    let plan = compile_standard_plan(
        node_id,
        if node_id == "V4HubRespInbound03Normalized" {
            "response_inbound"
        } else {
            "response_outbound"
        },
        "response",
        position,
        &[plugin_id],
    )
    .expect("response plan compiles");
    let hash = plan.plan_hash();
    let bindings = PlanBindings {
        graph_hash: hash.clone(),
        manifest_hash: hash.clone(),
        loaded_plan_hash: hash,
    };
    let mut container = NodeContainer::declare(node_id, plan, bindings).expect("binding passes");
    container.context_created().unwrap();
    container.plugins_mounted().unwrap();
    container.publish().unwrap();
    let output = container.execute(
        NodeExecutionInput {
            data,
            control: json!({}),
            information,
        },
        &StandardHandleRegistry::new(),
    );
    container.drain().unwrap();
    container.dispose().unwrap();
    output.map(|value| value.data)
}

#[test]
fn protocol_decode_preserves_provider_business_response() {
    let response = json!({
        "id":"resp-1",
        "output":[
            {"type":"message","content":[{"type":"output_text","text":"hello"}]},
            {"type":"function_call","call_id":"call-1","name":"lookup","arguments":"{}"}
        ],
        "usage":{"input_tokens":10,"output_tokens":2},
        "metadata":{"client_visible":true}
    });
    let decoded = execute(
        "V4HubRespInbound03Normalized",
        3,
        "v4.std.response.protocol_decode",
        response.clone(),
        json!({}),
    )
    .unwrap();
    assert_eq!(decoded, response);
}

#[test]
fn protocol_decode_rejects_invalid_shape_and_control_leakage() {
    for response in [
        json!([]),
        json!({"output":{}}),
        json!({"output":[{}]}),
        json!({"output":[],"error_chain":{}}),
    ] {
        let error = execute(
            "V4HubRespInbound03Normalized",
            3,
            "v4.std.response.protocol_decode",
            response,
            json!({}),
        )
        .expect_err("invalid response must fail fast");
        assert!(matches!(
            error,
            NodeContainerError::Bridge(BridgeError::HandleError { .. })
        ));
    }
}

#[test]
fn relay_response_hook_projects_only_registered_protocol_pair() {
    let projected = execute(
        "V4HubRespOutbound05ClientSemantic",
        5,
        "v4.hook.relay.response",
        json!({
            "id":"resp-1",
            "model":"m",
            "output":[{"type":"message","content":[{"type":"output_text","text":"hello"}]}]
        }),
        json!({"provider_protocol":"openai-responses","client_protocol":"openai-chat"}),
    )
    .unwrap();
    assert_eq!(projected["choices"][0]["message"]["content"], json!("hello"));

    assert!(execute(
        "V4HubRespOutbound05ClientSemantic",
        5,
        "v4.hook.relay.response",
        json!({"id":"resp-2"}),
        json!({"provider_protocol":"openai-responses","client_protocol":"gemini"}),
    )
    .is_err());
}

#[test]
fn frame_build_preserves_client_semantic_payload() {
    let payload = json!({"id":"resp-1","object":"chat.completion","choices":[]});
    let frame = execute(
        "V4ServerRespOutbound06ClientFrame",
        6,
        "v4.std.response.frame_build",
        payload.clone(),
        json!({}),
    )
    .unwrap();
    assert_eq!(frame, payload);
}

#[test]
fn frame_build_rejects_control_plane_fields() {
    let error = execute(
        "V4ServerRespOutbound06ClientFrame",
        6,
        "v4.std.response.frame_build",
        json!({"id":"resp-1","route_facts":{}}),
        json!({}),
    )
    .expect_err("control leakage must fail fast");
    assert!(matches!(
        error,
        NodeContainerError::Bridge(BridgeError::HandleError { .. })
    ));
}

#[test]
fn frame_builder_cannot_bind_to_chat_process_node() {
    let authoring = standard_authoring(&["v4.std.response.frame_build"]).unwrap();
    let error = compile_node_plan(
        "V4HubRespChatProcess04Governed",
        "response_chat_process",
        "response",
        4,
        &authoring,
        &standard_node_allowed_reads("V4HubRespChatProcess04Governed"),
        &standard_node_allowed_writes("V4HubRespChatProcess04Governed"),
        &standard_resource_registry(),
        &standard_container_services(),
    )
    .expect_err("non-adjacent node selector must fail");
    assert!(matches!(
        error,
        PlanError::NodeSelectorMismatch { .. }
            | PlanError::NodeSelectorPositionMismatch { .. }
            | PlanError::NodeRoleMismatch { .. }
    ));
}
