//! Request-side P0 plugin positive and negative contract coverage.

use routecodex_v4_cordis_bridge::NodeExecutionInput;
use routecodex_v4_node_container::{NodeContainer, PlanBindings, NodeContainerError};
use routecodex_v4_standard_plugins::{compile_standard_plan, StandardHandleRegistry};
use serde_json::{json, Value};

fn execute(node: &str, role: &str, position: u32, plugin: &str, data: Value) -> Result<Value, NodeContainerError> {
    let plan = compile_standard_plan(node, role, "request", position, &[plugin]).unwrap();
    let hash = plan.plan_hash();
    let bindings = PlanBindings { graph_hash: hash.clone(), manifest_hash: hash.clone(), loaded_plan_hash: hash.clone() };
    let mut container = NodeContainer::declare(node, plan, bindings).unwrap();
    container.context_created().unwrap();
    container.plugins_mounted().unwrap();
    container.publish().unwrap();
    let output = container.execute_with_plan_hash(&hash, NodeExecutionInput { data, control: json!({}) }, &StandardHandleRegistry::new());
    container.drain().unwrap();
    container.dispose().unwrap();
    output.map(|value| value.data)
}

#[test]
fn positive_request_plugins_preserve_adjacent_semantics() {
    let normalized = execute("V4HubReqInbound03Normalized", "request_inbound", 3, "v4.std.request.responses_normalize", json!({"requestId":"req-1","input":[{"role":"user","content":"hi"}]})).unwrap();
    assert_eq!(normalized["requestId"], json!("req-1"));
    let projected = execute("V4HubReqChatProcess04Governed", "request_chat_process", 4, "v4.std.request.chat_to_responses", json!({"requestId":"req-1","model":"m","messages":[{"role":"user","content":"hi"}]})).unwrap();
    assert_eq!(projected["protocol"], json!("responses"));
    assert!(projected.get("messages").is_none());
    let governed = execute("V4HubReqChatProcess04Governed", "request_chat_process", 4, "v4.std.request.governance", projected).unwrap();
    let semantic = execute("V4HubReqOutbound05ProviderSemantic", "request_outbound", 5, "v4.std.request.provider_semantic", governed).unwrap();
    let wire = execute("V4ProviderReqCompat06Compat", "request_outbound", 6, "v4.std.request.responses_wire_build", semantic).unwrap();
    assert_eq!(wire["model"], json!("m"));
}

#[test]
fn negative_request_plugins_reject_control_leakage_and_invalid_shapes() {
    assert!(execute("V4HubReqInbound03Normalized", "request_inbound", 3, "v4.std.request.responses_normalize", json!({"requestId":"r","input":[],"metadata_center":{}})).is_err());
    assert!(execute("V4HubReqChatProcess04Governed", "request_chat_process", 4, "v4.std.request.chat_to_responses", json!({"requestId":"r","messages":{}})).is_err());
    assert!(execute("V4HubReqOutbound05ProviderSemantic", "request_outbound", 5, "v4.std.request.provider_semantic", json!({"input":[]})).is_err());
    assert!(execute("V4ProviderReqCompat06Compat", "request_outbound", 6, "v4.std.request.responses_wire_build", json!({"model":"m","input":[],"error_chain":{}})).is_err());
}

#[test]
fn direct_and_relay_model_hooks_are_protocol_scoped() {
    let direct = execute(
        "V4HubReqChatProcess04Governed",
        "request_chat_process",
        4,
        "v4.std.hook.direct_model_passthrough",
        json!({"protocol":"responses","model":"gpt-5.6-sol","input":"hi"}),
    )
    .unwrap();
    assert_eq!(direct["model"], json!("gpt-5.6-sol"));
    assert!(execute(
        "V4HubReqChatProcess04Governed",
        "request_chat_process",
        4,
        "v4.std.hook.direct_model_passthrough",
        json!({"protocol":"responses","model":"m","messages":[]}),
    )
    .is_err());
    let relay = execute(
        "V4HubReqChatProcess04Governed",
        "request_chat_process",
        4,
        "v4.std.hook.relay_model_projection",
        json!({"model":"m","messages":[{"role":"user","content":"hi"}]}),
    )
    .unwrap();
    assert_eq!(relay["protocol"], json!("responses"));
    assert!(relay.get("messages").is_none());
}
