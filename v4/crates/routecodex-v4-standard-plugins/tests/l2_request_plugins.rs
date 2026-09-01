//! Request-side P0 plugin positive and negative contract coverage.

use routecodex_v4_cordis_bridge::NodeExecutionInput;
use routecodex_v4_node_container::{NodeContainer, NodeContainerError, PlanBindings};
use routecodex_v4_standard_plugins::{compile_standard_plan, StandardHandleRegistry};
use serde_json::{json, Value};

fn execute(
    node: &str,
    role: &str,
    position: u32,
    plugin: &str,
    data: Value,
) -> Result<Value, NodeContainerError> {
    let plan = compile_standard_plan(node, role, "request", position, &[plugin]).unwrap();
    let hash = plan.plan_hash();
    let bindings = PlanBindings {
        graph_hash: hash.clone(),
        manifest_hash: hash.clone(),
        loaded_plan_hash: hash.clone(),
    };
    let mut container = NodeContainer::declare(node, plan, bindings).unwrap();
    container.context_created().unwrap();
    container.plugins_mounted().unwrap();
    container.publish().unwrap();
    let information = if plugin == "v4.std.request.responses_wire_build" {
        json!({
            "client_protocol": if data.get("messages").is_some() { "chat" } else { "responses" },
            "provider_protocol": "responses"
        })
    } else {
        json!({})
    };
    let output = container.execute_with_plan_hash(
        &hash,
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

fn execute_with_information(
    node: &str,
    role: &str,
    position: u32,
    plugin: &str,
    data: Value,
    information: Value,
) -> Result<Value, NodeContainerError> {
    let plan = compile_standard_plan(node, role, "request", position, &[plugin]).unwrap();
    let hash = plan.plan_hash();
    let bindings = PlanBindings {
        graph_hash: hash.clone(),
        manifest_hash: hash.clone(),
        loaded_plan_hash: hash.clone(),
    };
    let mut container = NodeContainer::declare(node, plan, bindings).unwrap();
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
fn positive_request_plugins_preserve_adjacent_semantics() {
    let normalized = execute(
        "V4HubReqInbound02Normalized",
        "request_inbound",
        2,
        "v4.std.request.responses_normalize",
        json!({"model":"m","messages":[{"role":"user","content":"hi"}]}),
    )
    .unwrap();
    assert!(normalized.get("requestId").is_none());
    let governed = execute(
        "V4HubReqChatProcess03Governed",
        "request_chat_process",
        3,
        "v4.std.request.governance",
        normalized,
    )
    .unwrap();
    let semantic = execute_with_information(
        "V4HubReqOutbound06ProviderSemantic",
        "request_outbound",
        6,
        "v4.hook.relay.request",
        governed,
        json!({"client_protocol":"openai-chat","provider_protocol":"openai-responses"}),
    )
    .unwrap();
    assert_eq!(semantic["protocol"], json!("responses"));
    assert!(semantic.get("messages").is_none());
    let wire = execute(
        "V4ProviderReqCompat07ProviderCompat",
        "request_outbound",
        7,
        "v4.std.request.responses_wire_build",
        semantic,
    )
    .unwrap();
    assert_eq!(wire["model"], json!("m"));
}

#[test]
fn negative_request_plugins_reject_control_leakage_and_invalid_shapes() {
    assert!(execute(
        "V4HubReqInbound02Normalized",
        "request_inbound",
        2,
        "v4.std.request.responses_normalize",
        json!({"input":[],"requestId":"control-must-not-enter-payload"})
    )
    .is_err());
    assert!(execute(
        "V4HubReqChatProcess03Governed",
        "request_chat_process",
        3,
        "v4.std.request.governance",
        json!({"messages":[],"tools":{}})
    )
    .is_err());
    assert!(execute_with_information(
        "V4HubReqOutbound06ProviderSemantic",
        "request_outbound",
        6,
        "v4.hook.relay.request",
        json!({"model":"m","messages":[]}),
        json!({"client_protocol":"openai-chat","provider_protocol":"anthropic-messages"})
    )
    .is_err());
    assert!(execute(
        "V4ProviderReqCompat07ProviderCompat",
        "request_outbound",
        7,
        "v4.std.request.responses_wire_build",
        json!({"model":"m","input":[],"error_chain":{}})
    )
    .is_err());
}

#[test]
fn responses_wire_builder_preserves_protocol_continuation_fields() {
    let wire = execute(
        "V4ProviderReqCompat07ProviderCompat",
        "request_outbound",
        7,
        "v4.std.request.responses_wire_build",
        json!({
            "model": "m",
            "input": "next",
            "previous_response_id": "resp_previous",
            "store": true
        }),
    )
    .expect("wire builder preserves valid Responses fields");
    assert_eq!(wire["previous_response_id"], "resp_previous");
    assert_eq!(wire["store"], true);
}

#[test]
fn wire_builder_preserves_chat_shape_for_same_protocol() {
    let wire = execute_with_information(
        "V4ProviderReqCompat07ProviderCompat",
        "request_outbound",
        7,
        "v4.std.request.responses_wire_build",
        json!({"model": "m", "messages": [{"role": "user", "content": "hello"}]}),
        json!({"client_protocol": "chat", "provider_protocol": "chat"}),
    )
    .expect("same-protocol Chat wire must remain Chat-shaped");
    assert_eq!(wire["messages"][0]["content"], "hello");
    assert!(wire.get("input").is_none());
}

#[test]
fn wire_builder_rejects_missing_protocol_side_channel() {
    assert!(execute_with_information(
        "V4ProviderReqCompat07ProviderCompat",
        "request_outbound",
        7,
        "v4.std.request.responses_wire_build",
        json!({"model": "m", "messages": []}),
        json!({}),
    )
    .is_err());
}

#[test]
fn direct_and_relay_model_hooks_are_protocol_scoped() {
    let direct = execute_with_information(
        "V4DirectReq02RelayContainer",
        "request_outbound",
        2,
        "v4.hook.direct.request",
        json!({"model":"gpt-5.6-sol","input":"hi"}),
        json!({"client_protocol":"openai-responses","provider_protocol":"openai-responses"}),
    )
    .unwrap();
    assert_eq!(direct["model"], json!("gpt-5.6-sol"));
    assert!(execute_with_information(
        "V4DirectReq02RelayContainer",
        "request_outbound",
        2,
        "v4.hook.direct.request",
        json!({"model":"m","input":[]}),
        json!({"client_protocol":"openai-responses","provider_protocol":"openai-chat"}),
    )
    .is_err());
    let relay = execute_with_information(
        "V4HubReqOutbound06ProviderSemantic",
        "request_outbound",
        6,
        "v4.hook.relay.request",
        json!({"model":"m","messages":[{"role":"user","content":"hi"}]}),
        json!({"client_protocol":"openai-chat","provider_protocol":"openai-responses"}),
    )
    .unwrap();
    assert_eq!(relay["protocol"], json!("responses"));
    assert!(relay.get("messages").is_none());
}
