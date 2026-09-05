//! Red tests for the typed error chain stage plugins.
//!
//! The error chain is owned by `v4.std.error.typed_intake` at
//! `V4Error01SourceRaised`. The downstream stages must read that typed chain
//! and advance the stage field without letting control facts enter data.
//! Error chain execution stays external to the data-plane runtime.

use routecodex_v4_cordis_bridge::{BridgeError, NodeExecutionInput};
use routecodex_v4_node_container::{NodeContainer, NodeContainerError, PlanBindings};
use routecodex_v4_standard_plugins::{compile_standard_plan, StandardHandleRegistry};
use serde_json::{json, Value};

fn execute(
    node_id: &str,
    role_id: &str,
    position: u32,
    plugin_id: &str,
    control: Value,
) -> Result<routecodex_v4_cordis_bridge::NodeExecutionOutput, NodeContainerError> {
    let plan = compile_standard_plan(node_id, role_id, "error", position, &[plugin_id])
        .expect("error stage plan compiles");
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
            data: json!({}),
            control,
            information: json!({}),
            transport: None,
        },
        &StandardHandleRegistry::new(),
    );
    container.drain().unwrap();
    container.dispose().unwrap();
    output
}

fn chain_input() -> Value {
    json!({"error_chain": {"code":"provider_failure","message":"upstream failed"}})
}

#[test]
fn positive_error_stages_advance_typed_chain() {
    let stages = [
        ("V4Error02HostCaptured", "error_source", 2, "v4.std.error.host_capture", "host_captured"),
        ("V4Error03RuntimeClassified", "error_classify", 3, "v4.std.error.runtime_classify", "runtime_classified"),
        ("V4Error04RouterPolicyApplied", "error_policy", 4, "v4.std.error.router_policy", "router_policy_applied"),
        ("V4Error05ExecutionDecision", "error_decision", 5, "v4.std.error.execution_decision", "execution_decision"),
    ];
    for (node_id, role_id, position, plugin_id, expected_stage) in stages {
        let output = execute(node_id, role_id, position, plugin_id, chain_input())
            .expect("error stage must advance");
        assert_eq!(
            output.control["error_chain"]["stage"],
            json!(expected_stage),
            "{plugin_id} must set stage {expected_stage}"
        );
        assert!(
            output.data.as_object().unwrap().get("error_chain").is_none(),
            "error chain must never enter data"
        );
    }
}

#[test]
fn negative_error_stages_fail_without_typed_chain_resource() {
    for (node_id, role_id, position, plugin_id) in [
        ("V4Error02HostCaptured", "error_source", 2, "v4.std.error.host_capture"),
        ("V4Error03RuntimeClassified", "error_classify", 3, "v4.std.error.runtime_classify"),
        ("V4Error04RouterPolicyApplied", "error_policy", 4, "v4.std.error.router_policy"),
        ("V4Error05ExecutionDecision", "error_decision", 5, "v4.std.error.execution_decision"),
    ] {
        let error = execute(node_id, role_id, position, plugin_id, json!({}))
            .expect_err("error stage requires existing typed error chain");
        assert!(matches!(
            error,
            NodeContainerError::Bridge(BridgeError::HandleError { .. })
        ));
    }
}

#[test]
fn negative_error_stage_rejects_control_chain_missing_code() {
    let error = execute(
        "V4Error02HostCaptured",
        "error_source",
        2,
        "v4.std.error.host_capture",
        json!({"error_chain": {"message":"no code"}}),
    )
    .expect_err("error stage must require typed error code");
    assert!(matches!(
        error,
        NodeContainerError::Bridge(BridgeError::HandleError { .. })
    ));
}
