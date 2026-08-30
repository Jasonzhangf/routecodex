use routecodex_v4_node_container::{
    ActiveEpochStore, EpochError, ExecutionEpochBundle, ExecutionEpochIdentity, ExecutionEpochNode,
    ExecutionEpochState, NodeContainer, PlanBindings, ZERO_BASE_MANIFEST_HASH,
};
use routecodex_v4_plugin_plan::NodePluginPlan;
use std::collections::HashMap;

fn accepting_container(node_id: &str) -> NodeContainer {
    accepting_container_at(node_id, "request", 1)
}

fn accepting_container_at(node_id: &str, chain: &str, position: u32) -> NodeContainer {
    let plan = NodePluginPlan {
        node_id: node_id.into(),
        position,
        role_id: "role".into(),
        chain: chain.into(),
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

#[test]
fn empty_store_accepts_only_the_explicit_zero_base_transaction() {
    let store = ActiveEpochStore::empty();
    let candidate = epoch("first", 1);
    let prepared = store
        .prepare("first", 0, ZERO_BASE_MANIFEST_HASH, candidate, "manifest-1")
        .expect("canonical zero base must allow the first prepare");
    assert_eq!(prepared.plan_epoch, 1);
    assert_eq!(store.commit("first").unwrap().plan_epoch, 1);
    assert_eq!(store.active_snapshot().unwrap().plan_epoch, 1);

    let wrong_epoch = ActiveEpochStore::empty().prepare(
        "wrong-epoch",
        1,
        ZERO_BASE_MANIFEST_HASH,
        epoch("wrong-epoch", 1),
        "manifest-1",
    );
    assert!(matches!(wrong_epoch, Err(EpochError::StaleBase { .. })));
    let wrong_hash = ActiveEpochStore::empty().prepare(
        "wrong-hash",
        0,
        "manifest-not-zero",
        epoch("wrong-hash", 1),
        "manifest-1",
    );
    assert!(matches!(wrong_hash, Err(EpochError::StaleBase { .. })));
}

#[test]
fn ordered_bundle_exposes_exact_chain_order_and_declared_branch_edges() {
    let bundle = ExecutionEpochBundle::from_ordered_nodes(
        vec![
            ExecutionEpochNode::new(
                accepting_container_at("request-a", "request", 1),
                HashMap::from([("skip".to_string(), "request-c".to_string())]),
            ),
            ExecutionEpochNode::new(
                accepting_container_at("request-b", "request", 2),
                HashMap::new(),
            ),
            ExecutionEpochNode::new(
                accepting_container_at("request-c", "request", 3),
                HashMap::new(),
            ),
            ExecutionEpochNode::new(
                accepting_container_at("response-a", "response", 1),
                HashMap::new(),
            ),
        ],
        ExecutionEpochIdentity {
            plan_epoch: 9,
            manifest_hash: "manifest-9".into(),
            execution_identity: "execution-9".into(),
        },
    )
    .unwrap();
    let lease = bundle.admit().unwrap();
    assert_eq!(lease.entrypoint("request").unwrap(), "request-a");
    assert_eq!(
        lease.next_node("request", "request-a").unwrap(),
        Some("request-b".to_string())
    );
    assert_eq!(lease.next_node("request", "request-c").unwrap(), None);
    assert_eq!(
        lease.branch_target("request-a", "skip").unwrap(),
        "request-c"
    );
    assert!(lease.branch_target("request-a", "missing").is_err());
    assert_eq!(lease.entrypoint("response").unwrap(), "response-a");
}

fn epoch(node_id: &str, plan_epoch: u64) -> ExecutionEpochBundle {
    ExecutionEpochBundle::new(
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
    let result = ExecutionEpochBundle::new(
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
fn zero_plan_epoch_is_not_an_executable_epoch_identity() {
    let rejected = ExecutionEpochBundle::new(
        accepting_container("candidate-zero"),
        ExecutionEpochIdentity {
            plan_epoch: 0,
            manifest_hash: "manifest-zero".into(),
            execution_identity: "execution-zero".into(),
        },
    );
    assert!(matches!(rejected, Err(EpochError::InvalidIdentity)));
}

#[test]
fn rebuild_keeps_execution_identity_stable() {
    let identity = ExecutionEpochIdentity {
        plan_epoch: 11,
        manifest_hash: "manifest-stable".into(),
        execution_identity: "execution-stable".into(),
    };
    let first = ExecutionEpochBundle::new(accepting_container("first"), identity.clone()).unwrap();
    let rebuilt = ExecutionEpochBundle::new(accepting_container("rebuilt"), identity).unwrap();
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
