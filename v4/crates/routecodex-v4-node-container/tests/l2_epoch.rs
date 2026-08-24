use routecodex_v4_node_container::{
    ActiveEpochStore, ActiveExecutionEpoch, ExecutionEpochIdentity, ExecutionEpochState,
    EpochError, NodeContainer, PlanBindings,
};
use routecodex_v4_plugin_plan::NodePluginPlan;

fn accepting_container(node_id: &str) -> NodeContainer {
    let plan = NodePluginPlan {
        node_id: node_id.into(),
        position: 1,
        role_id: "role".into(),
        chain: "request".into(),
        entries: vec![],
        selection_groups: vec![],
        hash: String::new(),
    };
    let hash = plan.plan_hash();
    let mut container = NodeContainer::declare(
        node_id,
        NodePluginPlan {
            hash: hash.clone(),
            ..plan
        },
        PlanBindings {
            graph_hash: hash.clone(),
            manifest_hash: hash.clone(),
            loaded_plan_hash: hash,
        },
    )
    .expect("container declaration must validate immutable plan bindings");
    container.context_created().unwrap();
    container.plugins_mounted().unwrap();
    container.publish().unwrap();
    container
}

fn epoch(node_id: &str, plan_epoch: u64) -> ActiveExecutionEpoch {
    ActiveExecutionEpoch::new(
        accepting_container(node_id),
        ExecutionEpochIdentity {
            plan_epoch,
            manifest_hash: format!("manifest-{plan_epoch}"),
            execution_identity: format!("execution-{plan_epoch}"),
        },
    )
    .unwrap()
}

#[test]
fn publish_swaps_admission_but_drains_old_epoch_after_last_lease() {
    let store = ActiveEpochStore::new(epoch("old", 1));
    let old = store.admit().unwrap();
    let published = store.publish(epoch("new", 2)).unwrap();
    assert_eq!(published.plan_epoch, 2);
    assert_eq!(old.snapshot().state, ExecutionEpochState::Retired);
    assert_eq!(old.snapshot().in_flight_leases, 1);
    assert_eq!(old.release().unwrap().state, ExecutionEpochState::Disposed);
    assert_eq!(store.active_snapshot().unwrap().plan_epoch, 2);
}

#[test]
fn failure_record_is_passive_and_active_pointer_is_stable() {
    let store = ActiveEpochStore::new(epoch("active", 7));
    let before = store.active_snapshot().unwrap();
    let failure = store.record_execution_failure().unwrap();
    assert_eq!(failure.plan_epoch, before.plan_epoch);
    assert_eq!(failure.failure_count, 1);
    let active = store.active_snapshot().unwrap();
    assert_eq!(active.state, ExecutionEpochState::Active);
    assert_eq!(active.failure_count, 1);
}

#[test]
fn retired_epoch_rejects_new_admission_after_publish() {
    let old_epoch = epoch("active", 1);
    let store = ActiveEpochStore::new(old_epoch.clone());
    let old = store.admit().unwrap();
    let _ = store.publish(epoch("candidate", 2)).unwrap();
    assert!(matches!(old_epoch.admit(), Err(EpochError::LeaseUnavailable)));
    drop(old);
}

#[test]
fn candidate_identity_failure_cannot_replace_active_epoch() {
    let store = ActiveEpochStore::new(epoch("active", 3));
    let result = ActiveExecutionEpoch::new(
        accepting_container("candidate"),
        ExecutionEpochIdentity {
            plan_epoch: 4,
            manifest_hash: String::new(),
            execution_identity: "candidate".into(),
        },
    );
    assert!(matches!(result, Err(EpochError::InvalidIdentity)));
    assert_eq!(store.active_snapshot().unwrap().plan_epoch, 3);
}

#[test]
fn rebuild_keeps_execution_identity_stable() {
    let identity = ExecutionEpochIdentity {
        plan_epoch: 11,
        manifest_hash: "manifest-stable".into(),
        execution_identity: "execution-stable".into(),
    };
    let first = ActiveExecutionEpoch::new(accepting_container("first"), identity.clone()).unwrap();
    let rebuilt = ActiveExecutionEpoch::new(accepting_container("rebuilt"), identity).unwrap();
    assert_eq!(first.snapshot().plan_epoch, rebuilt.snapshot().plan_epoch);
    assert_eq!(first.snapshot().manifest_hash, rebuilt.snapshot().manifest_hash);
    assert_eq!(first.snapshot().execution_identity, rebuilt.snapshot().execution_identity);
}
