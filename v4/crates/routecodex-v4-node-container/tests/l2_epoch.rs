use routecodex_v4_node_container::{
    ActiveEpochStore, ActiveExecutionEpoch, EpochError, ExecutionEpochIdentity,
    ExecutionEpochState, NodeContainer, PlanBindings,
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
            execution_identity: format!("execution-{node_id}-{plan_epoch}"),
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
    assert!(matches!(
        old_epoch.admit(),
        Err(EpochError::LeaseUnavailable)
    ));
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
    assert_eq!(
        first.snapshot().manifest_hash,
        rebuilt.snapshot().manifest_hash
    );
    assert_eq!(
        first.snapshot().execution_identity,
        rebuilt.snapshot().execution_identity
    );
}

#[test]
fn empty_store_rejects_admission_until_epoch_is_published() {
    let store = ActiveEpochStore::empty();
    assert!(matches!(store.admit(), Err(EpochError::LeaseUnavailable)));
    assert!(store.active_snapshot().is_none());
}

#[test]
fn transaction_prepare_commit_drain_is_idempotent_and_preserves_old_lease() {
    let store = ActiveEpochStore::new(epoch("old", 1));
    let old_lease = store.admit().unwrap();
    let candidate = epoch("candidate", 2);
    let prepared = store
        .prepare("tx-1", 1, "manifest-1", candidate.clone(), "manifest-2")
        .unwrap();
    assert_eq!(
        prepared.state,
        routecodex_v4_node_container::EpochTransactionState::Prepared
    );
    assert_eq!(
        store
            .prepare("tx-1", 1, "manifest-1", candidate, "manifest-2")
            .unwrap(),
        prepared
    );
    let committed = store.commit("tx-1").unwrap();
    assert_eq!(
        committed.state,
        routecodex_v4_node_container::EpochTransactionState::Committed
    );
    assert_eq!(store.active_snapshot().unwrap().plan_epoch, 2);
    assert_eq!(
        store.drain("tx-1").unwrap().state,
        routecodex_v4_node_container::EpochTransactionState::Draining
    );
    assert_eq!(
        store.drain("tx-1").unwrap().state,
        routecodex_v4_node_container::EpochTransactionState::Draining
    );
    assert_eq!(
        old_lease.release().unwrap().state,
        ExecutionEpochState::Disposed
    );
}

#[test]
fn transaction_rejects_stale_base_and_candidate_hash_drift_without_switching_active() {
    let store = ActiveEpochStore::new(epoch("active", 3));
    let stale = store.prepare(
        "stale",
        2,
        "manifest-2",
        epoch("candidate", 4),
        "manifest-4",
    );
    assert!(matches!(stale, Err(EpochError::StaleBase { .. })));
    let drift = store.prepare(
        "drift",
        3,
        "manifest-3",
        epoch("candidate", 4),
        "wrong-hash",
    );
    assert!(matches!(drift, Err(EpochError::HashMismatch { .. })));
    assert_eq!(store.active_snapshot().unwrap().plan_epoch, 3);
}

#[test]
fn transaction_id_reuse_with_different_candidate_is_rejected() {
    let store = ActiveEpochStore::new(epoch("active", 3));
    store
        .prepare(
            "same-id",
            3,
            "manifest-3",
            epoch("candidate-a", 4),
            "manifest-4",
        )
        .unwrap();
    let conflict = store.prepare(
        "same-id",
        3,
        "manifest-3",
        epoch("candidate-b", 4),
        "manifest-4",
    );
    assert!(matches!(
        conflict,
        Err(EpochError::IdempotencyConflict { .. })
    ));
    assert_eq!(store.active_snapshot().unwrap().plan_epoch, 3);
}

#[test]
fn transaction_abort_and_rollback_are_explicit_and_do_not_fallback() {
    let store = ActiveEpochStore::new(epoch("active", 5));
    store
        .prepare(
            "abort",
            5,
            "manifest-5",
            epoch("candidate", 6),
            "manifest-6",
        )
        .unwrap();
    assert_eq!(
        store.abort("abort").unwrap().state,
        routecodex_v4_node_container::EpochTransactionState::Aborted
    );
    assert_eq!(
        store.abort("abort").unwrap().state,
        routecodex_v4_node_container::EpochTransactionState::Aborted
    );

    store
        .prepare(
            "rollback",
            5,
            "manifest-5",
            epoch("candidate", 6),
            "manifest-6",
        )
        .unwrap();
    store.commit("rollback").unwrap();
    assert_eq!(
        store.rollback("rollback").unwrap().state,
        routecodex_v4_node_container::EpochTransactionState::RolledBack
    );
    assert_eq!(store.active_snapshot().unwrap().plan_epoch, 5);
    assert!(matches!(
        store.commit("rollback"),
        Err(EpochError::InvalidTransactionState { .. })
    ));
    assert_eq!(store.active_snapshot().unwrap().plan_epoch, 5);
}
