//! L2 tests for V4 response ChatProcess group plugins.
//!
//! Positive: the group plan compiles and executes with response governance,
//! tool harvest; tool facts are observed without rewriting response data.
//! Continuation control remains owned by the runtime typed scope path.
//! Negative: malformed and duplicate tool identity fail fast.

use routecodex_v4_cordis_bridge::{BridgeError, NodeExecutionInput};
use routecodex_v4_node_container::{NodeContainer, NodeContainerError, PlanBindings};
use routecodex_v4_standard_plugins::{compile_standard_plan, StandardHandleRegistry};
use serde_json::{json, Value};

fn plan_bindings(plan: &routecodex_v4_plugin_plan::NodePluginPlan) -> PlanBindings {
    let hash = plan.plan_hash();
    PlanBindings {
        graph_hash: hash.clone(),
        manifest_hash: hash.clone(),
        loaded_plan_hash: hash,
    }
}

fn publish(mut container: NodeContainer) -> NodeContainer {
    container.context_created().unwrap();
    container.plugins_mounted().unwrap();
    container.publish().unwrap();
    container
}

fn response_plan() -> routecodex_v4_plugin_plan::NodePluginPlan {
    compile_standard_plan(
        "V4HubRespChatProcess03Governed",
        "response_chat_process",
        "response",
        3,
        &[
            "v4.std.chat_process.response_governance",
            "v4.std.chat_process.tool_harvest",
        ],
    )
    .expect("response chat-process group plan compiles")
}

fn execute(
    plan: &routecodex_v4_plugin_plan::NodePluginPlan,
    data: Value,
    control: Value,
) -> Result<routecodex_v4_cordis_bridge::NodeExecutionOutput, NodeContainerError> {
    let hash = plan.plan_hash();
    let mut container = NodeContainer::declare(
        "V4HubRespChatProcess03Governed",
        plan.clone(),
        plan_bindings(plan),
    )
    .expect("binding passes");
    container = publish(container);
    container.execute_with_plan_hash(
        &hash,
        NodeExecutionInput { data, control },
        &StandardHandleRegistry::new(),
    )
}

fn valid_response_with_tools() -> Value {
    json!({
        "requestId": "req-1",
        "choices": [{
            "message": {
                "role": "assistant",
                "content": null,
                "tool_calls": [{
                    "id": "call-1",
                    "type": "function",
                    "function": {"name": "search", "arguments": "{\"q\":\"v4\"}"}
                }]
            }
        }]
    })
}

#[test]
fn positive_response_chat_process_group_plan_compiles_and_executes() {
    let plan = response_plan();
    assert!(plan.verify());
    let ids: Vec<&str> = plan
        .entries
        .iter()
        .map(|entry| entry.plugin_id.as_str())
        .collect();
    assert_eq!(ids[0], "v4.std.chat_process.response_governance");
    assert_eq!(ids[1], "v4.std.chat_process.tool_harvest");

    let input = valid_response_with_tools();
    let output = execute(&plan, input.clone(), json!({})).expect("response group executes");

    assert_eq!(output.data, input, "ChatProcess preserves response data");
    assert_eq!(output.control, json!({}), "control stays side-channel");

    let kinds: Vec<&str> = output
        .diagnostics
        .iter()
        .map(|fact| fact.kind.as_str())
        .collect();
    assert!(kinds.contains(&"response_governance"));
    assert!(
        kinds.contains(&"tool_harvest_count"),
        "tool harvest observed: {kinds:?}"
    );

    let mut container = NodeContainer::declare(
        "V4HubRespChatProcess03Governed",
        plan.clone(),
        plan_bindings(&plan),
    )
    .expect("binding passes");
    container = publish(container);
    container.drain().unwrap();
    container.dispose().unwrap();
}

#[test]
fn payload_control_lookalike_is_data_and_cannot_write_control() {
    let plan = response_plan();
    let mut data = valid_response_with_tools();
    data["error_chain"] = json!({"stage": "source_raised"});
    let output = execute(&plan, data.clone(), json!({})).expect("payload remains business data");
    assert_eq!(output.data, data);
    assert_eq!(output.control, json!({}));
}

#[test]
fn negative_malformed_tool_call_fails_fast() {
    let plan = response_plan();
    let mut data = valid_response_with_tools();
    data["choices"][0]["message"]["tool_calls"][0]["function"]["name"] = json!("");
    let error = execute(&plan, data, json!({})).expect_err("malformed tool must fail");
    assert!(matches!(
        error,
        NodeContainerError::Bridge(BridgeError::HandleError { .. })
    ));
}

#[test]
fn negative_duplicate_tool_identity_fails_fast() {
    let plan = response_plan();
    let mut data = valid_response_with_tools();
    data["choices"][0]["message"]["tool_calls"] = json!([
        {
            "id": "call-dup",
            "type": "function",
            "function": {"name": "search", "arguments": "{}"}
        },
        {
            "id": "call-dup",
            "type": "function",
            "function": {"name": "read", "arguments": "{}"}
        }
    ]);
    let error = execute(&plan, data, json!({})).expect_err("duplicate tool identity must fail");
    assert!(matches!(
        error,
        NodeContainerError::Bridge(BridgeError::HandleError { .. })
    ));
}
