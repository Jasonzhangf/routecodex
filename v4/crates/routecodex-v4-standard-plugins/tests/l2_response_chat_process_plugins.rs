//! L2 tests for V4 response ChatProcess group plugins.
//!
//! Positive: the group plan compiles and executes with response governance,
//! tool harvest and continuation commit; valid continuation scope facts
//! commit at the group owner; terminal/no-continuation responses release or
//! no-op; tool facts are harvested without stripping.
//! Negative: malformed tool identity, duplicate tool identity, control-state
//! leakage in normal payload, missing full input, owner/protocol mismatch and
//! scope mismatch fail fast.

use routecodex_v4_cordis_bridge::{BridgeError, NodeExecutionInput};
use routecodex_v4_node_container::{NodeContainer, NodeContainerError, PlanBindings};
use routecodex_v4_standard_plugins::{
    compile_standard_plan, StandardHandleRegistry,
};
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
            "v4.std.chat_process.continuation_commit",
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

fn valid_response_with_tools_and_continuation() -> Value {
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
        }],
        "continuation": {
            "entry_protocol": "responses",
            "continuation_owner": "direct",
            "port": 5555,
            "session_scope": "session-1",
            "conversation_scope": "conversation-1",
            "full_input_hash": "sha256:input",
            "allow_continuation": true
        }
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
    assert_eq!(ids[0], "v4.std.chat_process.continuation_commit");
    assert_eq!(ids[1], "v4.std.chat_process.response_governance");
    assert_eq!(ids[2], "v4.std.chat_process.tool_harvest");

    let output = execute(
        &plan,
        valid_response_with_tools_and_continuation(),
        json!({}),
    )
    .expect("response group executes");

    let data = output.data.as_object().expect("data is object");
    assert_eq!(data["governance"], json!("response_governance"));
    assert_eq!(
        data["harvest"],
        json!({"tool_calls": 1, "tool_outputs": 0})
    );
    for key in [
        "control",
        "metadata_center",
        "error_chain",
        "route_facts",
        "target_selection",
        "stopless_state",
        "payload_cycle",
    ] {
        assert!(data.get(key).is_none(), "{key} leaked into normal payload");
    }
    assert_eq!(output.control, json!({}), "control stays side-channel");

    let kinds: Vec<&str> = output
        .diagnostics
        .iter()
        .map(|fact| fact.kind.as_str())
        .collect();
    assert!(
        kinds.contains(&"continuation_commit_ready"),
        "continuation commit observed: {kinds:?}"
    );
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
fn positive_terminal_response_releases_continuation_without_harvest_error() {
    let plan = response_plan();
    let mut data = valid_response_with_tools_and_continuation();
    data["continuation"]["allow_continuation"] = json!(false);
    let output = execute(&plan, data, json!({})).expect("terminal response executes");
    let kinds: Vec<&str> = output
        .diagnostics
        .iter()
        .map(|fact| fact.kind.as_str())
        .collect();
    assert!(
        kinds.contains(&"continuation_release_ready"),
        "terminal response must release continuation: {kinds:?}"
    );
}

#[test]
fn positive_no_continuation_scope_is_noop() {
    let plan = response_plan();
    let mut data = valid_response_with_tools_and_continuation();
    data.as_object_mut()
        .expect("response object")
        .remove("continuation");
    let output = execute(&plan, data, json!({})).expect("no-continuation response executes");
    let kinds: Vec<&str> = output
        .diagnostics
        .iter()
        .map(|fact| fact.kind.as_str())
        .collect();
    assert!(
        !kinds.contains(&"continuation_commit_ready"),
        "no continuation must not commit"
    );
    assert!(
        !kinds.contains(&"continuation_release_ready"),
        "no continuation must not release"
    );
}

#[test]
fn negative_control_state_in_normal_response_payload_fails_fast() {
    let plan = response_plan();
    let mut data = valid_response_with_tools_and_continuation();
    data["error_chain"] = json!({"stage": "source_raised"});
    let error = execute(&plan, data, json!({})).expect_err("control leak must fail");
    assert!(matches!(
        error,
        NodeContainerError::Bridge(BridgeError::HandleError { .. })
    ));
}

#[test]
fn negative_malformed_tool_call_fails_fast() {
    let plan = response_plan();
    let mut data = valid_response_with_tools_and_continuation();
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
    let mut data = valid_response_with_tools_and_continuation();
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

#[test]
fn negative_continuation_missing_full_input_fails_fast() {
    let plan = response_plan();
    let mut data = valid_response_with_tools_and_continuation();
    data["continuation"]
        .as_object_mut()
        .expect("continuation object")
        .remove("full_input_hash");
    let error = execute(&plan, data, json!({})).expect_err("missing full input must fail");
    assert!(matches!(
        error,
        NodeContainerError::Bridge(BridgeError::HandleError { .. })
    ));
}

#[test]
fn negative_continuation_owner_protocol_mismatch_fails_fast() {
    let plan = response_plan();
    let mut data = valid_response_with_tools_and_continuation();
    data["continuation"]["continuation_owner"] = json!("relay");
    let error = execute(&plan, data, json!({})).expect_err("owner mismatch must fail");
    assert!(matches!(
        error,
        NodeContainerError::Bridge(BridgeError::HandleError { .. })
    ));
}

#[test]
fn negative_continuation_scope_mismatch_fails_fast() {
    let plan = response_plan();
    let mut data = valid_response_with_tools_and_continuation();
    data["continuation"]["session_scope"] = json!("");
    let error = execute(&plan, data, json!({})).expect_err("scope mismatch must fail");
    assert!(matches!(
        error,
        NodeContainerError::Bridge(BridgeError::HandleError { .. })
    ));
}
