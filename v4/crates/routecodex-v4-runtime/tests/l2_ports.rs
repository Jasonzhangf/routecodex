use routecodex_v4_node_container::{
    ActiveEpochStore, ActiveExecutionEpoch, ExecutionEpochIdentity, NodeContainer, PlanBindings,
};
use routecodex_v4_plugin_plan::NodePluginPlan;
use routecodex_v4_runtime::{execution_binding, request_port::RequestPortLease, response_error_port};
use routecodex_v4_skeleton::{BindingContract, SkeletonPlan};

fn plan() -> SkeletonPlan {
    SkeletonPlan {
        schema_version: 1,
        contract_id: "ports".into(),
        status: "active".into(),
        owner_feature_id: "ports".into(),
        skeleton_version: "v4-skeleton-1".into(),
        binding: BindingContract { required: false, fields: vec![] },
        manifest_hash: "manifest-7".into(),
        plan_epoch: 7,
        plan_hash: "plan-hash".into(),
        chains: vec![],
    }
}

fn store() -> ActiveEpochStore {
    let plugin_plan = NodePluginPlan {
        node_id: "ports".into(), position: 1, role_id: "role".into(),
        chain: "request".into(), entries: vec![], selection_groups: vec![], hash: String::new(),
    };
    let hash = plugin_plan.plan_hash();
    let mut container = NodeContainer::declare(
        "ports",
        NodePluginPlan { hash: hash.clone(), ..plugin_plan },
        PlanBindings { graph_hash: hash.clone(), manifest_hash: hash.clone(), loaded_plan_hash: hash },
    ).unwrap();
    container.context_created().unwrap();
    container.plugins_mounted().unwrap();
    container.publish().unwrap();
    ActiveEpochStore::new(ActiveExecutionEpoch::new(
        container,
        ExecutionEpochIdentity { plan_epoch: 7, manifest_hash: "manifest-7".into(), execution_identity: "exec-7".into() },
    ).unwrap())
}

#[test]
fn request_admission_pins_binding_and_response_consumes_same_lease() {
    let p = plan();
    let request = RequestPortLease::admit(&store(), "req-1", &p).unwrap();
    let binding = execution_binding(&p);
    let receipt = response_error_port::consume_response(&request, &binding).unwrap();
    assert!(receipt.terminal);
    assert_eq!(receipt.request_id, "req-1");
}

#[test]
fn error_port_rejects_binding_drift() {
    let p = plan();
    let request = RequestPortLease::admit(&store(), "req-2", &p).unwrap();
    let mut binding = execution_binding(&p);
    binding.plan_epoch += 1;
    let error = response_error_port::consume_error(&request, &binding).unwrap_err();
    assert_eq!(error.code, "response_error_epoch_binding");
}

#[test]
fn request_admission_rejects_plan_epoch_drift_before_response_port() {
    let mut p = plan();
    p.plan_epoch += 1;
    let error = match RequestPortLease::admit(&store(), "req-3", &p) {
        Ok(_) => panic!("plan epoch drift must be rejected"),
        Err(error) => error,
    };
    assert_eq!(error.code, "request_epoch_binding");
}

#[test]
fn response_receipt_preserves_immutable_execution_identity() {
    let p = plan();
    let request = RequestPortLease::admit(&store(), "req-4", &p).unwrap();
    let receipt = response_error_port::consume_response(&request, &execution_binding(&p)).unwrap();
    assert_eq!(receipt.binding.plan_epoch, 7);
    assert_eq!(request.lease_snapshot().execution_identity, "exec-7");
}
