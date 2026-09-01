//! Red tests for contract validators that are production-bound but lack
//! independent positive/negative NodeContainer execution coverage.
//!
//! These tests prove the validators run through their typed handles and reject
//! malformed payload shapes while preserving valid data. They also lock the
//! diagnostic facts emitted by the owner.

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
        .expect("plugin plan compiles");
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
        },
        &StandardHandleRegistry::new(),
    );
    container.drain().unwrap();
    container.dispose().unwrap();
    output
}

#[test]
fn positive_input_validator_preserves_valid_request() {
    let output = execute(
        "V4HubReqInbound02Normalized",
        "request_inbound",
        "request",
        2,
        "v4.std.contract.input_validate",
        json!({"model":"m","messages":[]}),
    )
    .expect("valid request input is accepted");
    assert_eq!(output.data["model"], json!("m"));
    assert_eq!(output.control, json!({}));
    let kinds: Vec<&str> = output
        .diagnostics
        .iter()
        .map(|fact| fact.kind.as_str())
        .collect();
    assert!(
        kinds.iter().any(|kind| *kind == "node.input_validated"),
        "input validator must emit typed diagnostic: {kinds:?}"
    );
}

#[test]
fn negative_input_validator_rejects_non_object_request() {
    let error = execute(
        "V4HubReqInbound02Normalized",
        "request_inbound",
        "request",
        2,
        "v4.std.contract.input_validate",
        json!([{"model":"m"}]),
    )
    .expect_err("non-object request must fail fast");
    assert!(matches!(
        error,
        NodeContainerError::Bridge(routecodex_v4_cordis_bridge::BridgeError::HandleError { .. })
    ));
}

#[test]
fn positive_output_validator_preserves_valid_response() {
    let output = execute(
        "V4HubRespOutbound05ClientSemantic",
        "response_outbound",
        "response",
        5,
        "v4.std.contract.output_validate",
        json!({"id":"resp-1","choices":[]}),
    )
    .expect("valid response is accepted");
    assert_eq!(output.data["id"], json!("resp-1"));
    assert_eq!(output.control, json!({}));
    let kinds: Vec<&str> = output
        .diagnostics
        .iter()
        .map(|fact| fact.kind.as_str())
        .collect();
    assert!(
        kinds.iter().any(|kind| *kind == "node.output_validated"),
        "output validator must emit typed diagnostic: {kinds:?}"
    );
}

#[test]
fn negative_output_validator_rejects_non_object_response() {
    let error = execute(
        "V4HubRespOutbound05ClientSemantic",
        "response_outbound",
        "response",
        5,
        "v4.std.contract.output_validate",
        json!("not-an-object"),
    )
    .expect_err("non-object response must fail fast");
    assert!(matches!(
        error,
        NodeContainerError::Bridge(routecodex_v4_cordis_bridge::BridgeError::HandleError { .. })
    ));
}

#[test]
fn negative_validators_reject_control_side_channel_in_payload() {
    let error = execute(
        "V4HubReqInbound02Normalized",
        "request_inbound",
        "request",
        2,
        "v4.std.contract.input_validate",
        json!({"model":"m","error_chain":{"stage":"source_raised"}}),
    )
    .expect_err("control side channel must never enter data");
    assert!(matches!(
        error,
        NodeContainerError::Bridge(routecodex_v4_cordis_bridge::BridgeError::HandleError { .. })
    ));
}
