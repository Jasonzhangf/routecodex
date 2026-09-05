//! Red tests for request/response payload console observers.
//!
//! These diagnostics are observation-only: they must preserve the payload,
//! never write control/data, and emit a compact `console.payload_ready` fact.

use routecodex_v4_cordis_bridge::NodeExecutionInput;
use routecodex_v4_node_container::{NodeContainer, NodeContainerError, PlanBindings};
use routecodex_v4_standard_plugins::{compile_standard_plan, StandardHandleRegistry};
use serde_json::{json, Value};

fn execute(
    node_id: &str,
    role_id: &str,
    chain: &str,
    position: u32,
    plugin_id: &str,
    data: Value,
) -> Result<routecodex_v4_cordis_bridge::NodeExecutionOutput, NodeContainerError> {
    let plan = compile_standard_plan(node_id, role_id, chain, position, &[plugin_id])
        .expect("payload console plan compiles");
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
            information: json!({}),
            transport: None,
        },
        &StandardHandleRegistry::new(),
    );
    container.drain().unwrap();
    container.dispose().unwrap();
    output
}

#[test]
fn positive_request_console_render_preserves_payload_and_emits_compact_fact() {
    let payload = json!({
        "model":"m",
        "stream":true,
        "messages":[{},{}],
        "tools":[{}],
        "secret":"must-not-leak"
    });
    let output = execute(
        "V4HubReqChatProcess03Governed",
        "request_chat_process",
        "request",
        3,
        "v4.std.diagnostic.request_payload_console_render",
        payload.clone(),
    )
    .expect("request console render executes");
    assert_eq!(output.data, payload, "observer must preserve payload");
    assert_eq!(output.control, json!({}), "observer must not touch control");
    let facts: Vec<&str> = output
        .diagnostics
        .iter()
        .map(|fact| fact.kind.as_str())
        .collect();
    assert!(
        facts.iter().any(|kind| *kind == "console.payload_ready"),
        "request console render must emit payload fact: {facts:?}"
    );
    let message = output
        .diagnostics
        .iter()
        .find(|fact| fact.kind == "console.payload_ready")
        .map(|fact| fact.message.as_str())
        .expect("payload fact message exists");
    assert!(
        message.contains("model=m") && !message.contains("must-not-leak"),
        "payload console fact must be compact and leak-free: {message}"
    );
}

#[test]
fn negative_request_console_render_fails_on_non_object_payload() {
    let error = execute(
        "V4HubReqChatProcess03Governed",
        "request_chat_process",
        "request",
        3,
        "v4.std.diagnostic.request_payload_console_render",
        json!(["not-object"]),
    )
    .expect_err("payload console render requires object");
    assert!(matches!(
        error,
        NodeContainerError::Bridge(routecodex_v4_cordis_bridge::BridgeError::HandleError { .. })
    ));
}

#[test]
fn positive_response_console_render_preserves_payload_and_emits_fact() {
    let payload = json!({
        "id":"resp-1",
        "model":"m",
        "output":[{"type":"message","content":[]}],
        "usage":{"input_tokens":3,"output_tokens":5},
        "private":"must-not-leak"
    });
    let output = execute(
        "V4HubRespChatProcess04Governed",
        "response_chat_process",
        "response",
        4,
        "v4.std.diagnostic.response_payload_console_render",
        payload.clone(),
    )
    .expect("response console render executes");
    assert_eq!(output.data, payload, "observer must preserve payload");
    assert_eq!(output.control, json!({}));
    let message = output
        .diagnostics
        .iter()
        .find(|fact| fact.kind == "console.payload_ready")
        .map(|fact| fact.message.as_str())
        .expect("response payload fact exists");
    assert!(
        message.contains("model=m") && !message.contains("must-not-leak"),
        "response payload console fact must be compact and leak-free: {message}"
    );
}

#[test]
fn negative_response_console_render_fails_on_non_object_payload() {
    let error = execute(
        "V4HubRespChatProcess04Governed",
        "response_chat_process",
        "response",
        4,
        "v4.std.diagnostic.response_payload_console_render",
        json!("not-object"),
    )
    .expect_err("response payload console render requires object");
    assert!(matches!(
        error,
        NodeContainerError::Bridge(routecodex_v4_cordis_bridge::BridgeError::HandleError { .. })
    ));
}
