//! Red tests for the request inbound protocol parser.
//!
//! The parser is the first relay request node. It must run through the typed
//! handle, preserve a valid request object, and reject control/debug payload
//! leakage before any ChatProcess or routing decision.

use routecodex_v4_cordis_bridge::NodeExecutionInput;
use routecodex_v4_node_container::{NodeContainer, NodeContainerError, PlanBindings};
use routecodex_v4_standard_plugins::{compile_standard_plan, StandardHandleRegistry};
use serde_json::{json, Value};

fn execute(data: Value) -> Result<routecodex_v4_cordis_bridge::NodeExecutionOutput, NodeContainerError> {
    let plan = compile_standard_plan(
        "V4ServerReqInbound01ClientRaw",
        "request_inbound",
        "request",
        1,
        &["v4.std.request.protocol_parse"],
    )
    .expect("protocol parse plan compiles");
    let hash = plan.plan_hash();
    let bindings = PlanBindings {
        graph_hash: hash.clone(),
        manifest_hash: hash.clone(),
        loaded_plan_hash: hash.clone(),
    };
    let mut container = NodeContainer::declare(
        "V4ServerReqInbound01ClientRaw",
        plan,
        bindings,
    )
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
            transport: None,
        },
        &StandardHandleRegistry::new(),
    );
    container.drain().unwrap();
    container.dispose().unwrap();
    output
}

#[test]
fn positive_protocol_parse_preserves_valid_request() {
    let output = execute(json!({"model":"m","messages":[]})).expect("valid request parses");
    assert_eq!(output.data["model"], json!("m"));
    assert_eq!(output.control, json!({}));
}

#[test]
fn negative_protocol_parse_rejects_missing_model() {
    let error = execute(json!({"messages":[]})).expect_err("missing model must fail");
    assert!(matches!(
        error,
        NodeContainerError::Bridge(routecodex_v4_cordis_bridge::BridgeError::HandleError { .. })
    ));
}

#[test]
fn negative_protocol_parse_rejects_control_payload_leak() {
    let error = execute(json!({"model":"m","route_facts":{}}))
        .expect_err("control side channel must not enter request data");
    assert!(matches!(
        error,
        NodeContainerError::Bridge(routecodex_v4_cordis_bridge::BridgeError::HandleError { .. })
    ));
}
