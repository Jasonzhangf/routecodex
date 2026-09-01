//! Red tests for routing fact producer/consumer and control owner plugins.
//!
//! These plugins must write only typed control resources. Business payload
//! never carries route facts or target selection.

use routecodex_v4_cordis_bridge::NodeExecutionInput;
use routecodex_v4_node_container::{NodeContainer, NodeContainerError, PlanBindings};
use routecodex_v4_standard_plugins::{compile_standard_plan, StandardHandleRegistry};
use serde_json::{json, Value};

fn execute(
    node_id: &str,
    position: u32,
    plugin_id: &str,
    control: Value,
) -> Result<routecodex_v4_cordis_bridge::NodeExecutionOutput, NodeContainerError> {
    let plan = compile_standard_plan(node_id, "request_execution", "request", position, &[plugin_id])
        .expect("routing plan compiles");
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
            data: json!({"model":"m"}),
            control,
            information: json!({}),
        },
        &StandardHandleRegistry::new(),
    );
    container.drain().unwrap();
    container.dispose().unwrap();
    output
}

#[test]
fn positive_route_facts_producer_writes_typed_control() {
    let output = execute(
        "V4HubReqExecution04Planned",
        4,
        "v4.std.routing.route_facts_producer",
        json!({}),
    )
    .expect("route facts producer executes");
    assert_eq!(output.control["route_facts"], json!({"keyless": true}));
    assert!(
        output.data.as_object().unwrap().get("route_facts").is_none(),
        "route facts must never enter data"
    );
}

#[test]
fn positive_route_facts_consumer_resolves_target_from_typed_facts() {
    let output = execute(
        "V4HubReqTarget05Resolved",
        5,
        "v4.std.routing.route_facts_consumer",
        json!({"route_facts": {"keyless": true}}),
    )
    .expect("route facts consumer executes");
    assert_eq!(output.control["target_selection"], json!({"selected":"keyless_mock"}));
    assert!(
        output.data.as_object().unwrap().get("target_selection").is_none(),
        "target selection must never enter data"
    );
}

#[test]
fn negative_route_facts_consumer_fails_without_typed_facts() {
    let error = execute(
        "V4HubReqTarget05Resolved",
        5,
        "v4.std.routing.route_facts_consumer",
        json!({}),
    )
    .expect_err("route facts consumer requires typed facts");
    assert!(matches!(
        error,
        NodeContainerError::Bridge(routecodex_v4_cordis_bridge::BridgeError::HandleError { .. })
    ));
}
