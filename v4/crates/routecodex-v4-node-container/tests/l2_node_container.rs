//! L2 regression for the NodeContainer lifecycle boundary (Track A).
//!
//! Positive: a compiled plan with three-way matching hashes declares and runs
//! the full lifecycle through publish, execute, drain and dispose.
//! Negative pairs prove the guards fail fast:
//! - stale/drifting plan or binding hash is rejected before any state change;
//! - lifecycle transitions outside the declared order are rejected;
//! - execute before publish is rejected;
//! - dispose outside draining/failed is rejected.

use routecodex_v4_cordis_bridge::{HandleRegistry, NodeExecutionInput, PluginHandle};
use routecodex_v4_node_container::{
    graph_hash, NodeContainer, NodeContainerError, NodeContainerState, PlanBindings,
};
use routecodex_v4_plugin_plan::NodePluginPlan;

fn empty_plan() -> NodePluginPlan {
    let mut plan = NodePluginPlan {
        node_id: "node-a".to_string(),
        position: 1,
        role_id: "request_chat_process".to_string(),
        chain: "request".to_string(),
        entries: vec![],
        selection_groups: vec![],
        hash: String::new(),
    };
    plan.hash = plan.plan_hash();
    plan
}

fn binding_for(plan: &NodePluginPlan) -> PlanBindings {
    let hash = plan.plan_hash();
    PlanBindings {
        graph_hash: hash.clone(),
        manifest_hash: hash.clone(),
        loaded_plan_hash: hash,
    }
}

fn full_lifecycle(mut container: NodeContainer) -> NodeContainer {
    container.context_created().unwrap();
    container.plugins_mounted().unwrap();
    container.publish().unwrap();
    container
}

struct EmptyRegistry;

impl HandleRegistry for EmptyRegistry {
    fn get(&self, _plugin_id: &str) -> Option<&dyn PluginHandle> {
        None
    }
}

#[test]
fn positive_full_lifecycle_with_matching_hashes() {
    let plan = empty_plan();
    let bindings = binding_for(&plan);
    let mut container =
        NodeContainer::declare("node-a", plan, bindings).expect("three-way hash binding must pass");
    assert_eq!(container.state(), NodeContainerState::Declared);

    container.context_created().unwrap();
    container.plugins_mounted().unwrap();
    container.publish().unwrap();
    assert_eq!(container.state(), NodeContainerState::Accepting);

    let output = container
        .execute(
            NodeExecutionInput {
                data: Default::default(),
                control: Default::default(),
            },
            &EmptyRegistry,
        )
        .expect("empty plan executes through typed bridge");
    assert!(output.data.is_null());
    assert!(output.diagnostics.is_empty());

    container.drain().unwrap();
    assert_eq!(container.state(), NodeContainerState::Draining);
    container.dispose().unwrap();
    assert_eq!(container.state(), NodeContainerState::Disposed);
    container.dispose().unwrap();
    assert_eq!(container.state(), NodeContainerState::Disposed);
}

#[test]
fn negative_drifting_plan_hash_is_rejected_before_state_change() {
    let mut plan = empty_plan();
    let bindings = binding_for(&plan);
    plan.hash = "0".repeat(64);
    let error = NodeContainer::declare("node-a", plan, bindings).unwrap_err();
    assert!(matches!(error, NodeContainerError::PlanHashMismatch));
}

#[test]
fn negative_three_way_binding_mismatch_is_rejected() {
    let plan = empty_plan();
    let hash = plan.plan_hash();
    let bindings = PlanBindings {
        graph_hash: hash.clone(),
        manifest_hash: hash.clone(),
        loaded_plan_hash: "1".repeat(64),
    };
    let error = NodeContainer::declare("node-a", plan, bindings).unwrap_err();
    assert!(matches!(error, NodeContainerError::BindingMismatch));
}

#[test]
fn negative_out_of_order_transition_is_rejected() {
    let plan = empty_plan();
    let bindings = binding_for(&plan);
    let mut container = NodeContainer::declare("node-a", plan, bindings).expect("valid binding");
    let error = container.plugins_mounted().unwrap_err();
    assert!(matches!(
        error,
        NodeContainerError::InvalidState {
            state: NodeContainerState::Declared,
            ..
        }
    ));
}

#[test]
fn negative_execute_before_publish_is_rejected() {
    let plan = empty_plan();
    let bindings = binding_for(&plan);
    let mut container = NodeContainer::declare("node-a", plan, bindings).expect("valid binding");
    container.context_created().unwrap();
    container.plugins_mounted().unwrap();
    let error = container
        .execute(
            NodeExecutionInput {
                data: Default::default(),
                control: Default::default(),
            },
            &EmptyRegistry,
        )
        .unwrap_err();
    assert!(matches!(
        error,
        NodeContainerError::InvalidState {
            state: NodeContainerState::PluginsMounted,
            ..
        }
    ));
}

#[test]
fn negative_dispose_outside_draining_or_failed_is_rejected() {
    let plan = empty_plan();
    let bindings = binding_for(&plan);
    let mut container = NodeContainer::declare("node-a", plan, bindings).expect("valid binding");
    let error = container.dispose().unwrap_err();
    assert!(matches!(
        error,
        NodeContainerError::InvalidState {
            state: NodeContainerState::Declared,
            ..
        }
    ));
}

#[test]
fn positive_failed_candidate_can_dispose() {
    let plan = empty_plan();
    let bindings = binding_for(&plan);
    let mut container = NodeContainer::declare("node-a", plan, bindings).expect("valid binding");
    container.context_created().unwrap();
    container.plugins_mounted().unwrap();
    container.fail().unwrap();
    assert_eq!(container.state(), NodeContainerState::Failed);
    container.dispose().unwrap();
    assert_eq!(container.state(), NodeContainerState::Disposed);
}

#[test]
fn negative_fail_after_publish_is_rejected() {
    let plan = empty_plan();
    let bindings = binding_for(&plan);
    let mut container =
        full_lifecycle(NodeContainer::declare("node-a", plan, bindings).expect("valid binding"));
    let error = container.fail().unwrap_err();
    assert!(matches!(
        error,
        NodeContainerError::InvalidState {
            state: NodeContainerState::Accepting,
            ..
        }
    ));
}

#[test]
fn graph_hash_is_deterministic_sha256() {
    let a = graph_hash("canonical-graph");
    let b = graph_hash("canonical-graph");
    let c = graph_hash("other");
    assert_eq!(a, b);
    assert_ne!(a, c);
    assert_eq!(a.len(), 64);
}

#[test]
fn positive_in_flight_guard_tracks_and_releases_execution() {
    let plan = empty_plan();
    let bindings = binding_for(&plan);
    let container =
        full_lifecycle(NodeContainer::declare("node-a", plan, bindings).expect("valid binding"));
    let guard = container
        .enter_execution()
        .expect("accepting container enters execution");
    assert_eq!(container.in_flight(), 1);
    drop(guard);
    assert_eq!(container.in_flight(), 0);
}

#[test]
fn negative_drain_rejects_measured_in_flight_execution() {
    let plan = empty_plan();
    let bindings = binding_for(&plan);
    let mut container =
        full_lifecycle(NodeContainer::declare("node-a", plan, bindings).expect("valid binding"));
    let guard = container
        .enter_execution()
        .expect("accepting container enters execution");
    let error = container.drain().unwrap_err();
    assert!(matches!(error, NodeContainerError::InFlightExecutions(1)));
    assert_eq!(container.state(), NodeContainerState::Accepting);
    drop(guard);
    container
        .drain()
        .expect("drain succeeds after the guard is released");
    assert_eq!(container.state(), NodeContainerState::Draining);
}
