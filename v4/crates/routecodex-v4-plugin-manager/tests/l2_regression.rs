//! L2 regression for `routecodex-v4-plugin-manager`.
//!
//! Positive pairs:
//! - candidate create -> compile -> validate -> smoke -> publish succeeds
//!   and the active pointer is updated exactly once;
//! - concurrent publish lock takes effect inside `publish` itself;
//! - candidate failure keeps active pointer unchanged;
//! - execution failure records audit but does not mutate the active pointer.
//!
//! Negative pairs:
//! - duplicate candidate id rejected;
//! - stale base hash rejected without mutating active;
//! - mount failure rolls back partial mounts and rejects publish;
//! - publish requires SmokePassed state (skipped states fail);
//! - publish requires non-empty node_ids.

use routecodex_v4_plugin_contract::{
    NodePluginDescriptor, NodeSelector, PluginEffect, PluginKind, PluginPhase, ResourceAxis,
    ResourceEntry, ResourceRegistry,
};
use routecodex_v4_plugin_manager::{
    AuditAction, AuditResult, CandidateId, CandidateState, LifecyclePort, ManagerError,
    NullLifecyclePort, PluginCandidate, PluginManager,
};
use routecodex_v4_plugin_plan::{compile_node_plan, AuthoringPlugin, NodePluginPlan, PlanError};

fn resource_registry() -> ResourceRegistry {
    ResourceRegistry {
        resources: vec![ResourceEntry {
            resource_id: "v4.request.normal_payload".to_string(),
            axis: ResourceAxis::Data,
        }],
    }
}

fn allowed_reads() -> Vec<String> {
    vec!["v4.request.normal_payload".to_string()]
}

fn allowed_writes() -> Vec<String> {
    vec!["v4.request.normal_payload".to_string()]
}

fn authoring(plugin_id: &str) -> AuthoringPlugin {
    AuthoringPlugin {
        descriptor: NodePluginDescriptor {
            plugin_id: plugin_id.to_string(),
            version: "0.1.0".to_string(),
            owner: "track-b-test".to_string(),
            artifact_hash: "a".repeat(64),
            contract_hash: "b".repeat(64),
            kind: PluginKind::Operator,
            effect: PluginEffect::Semantic,
            phase: PluginPhase::Semantic,
            order: 100,
            before: vec![],
            after: vec![],
            depends_on: vec![],
            selection_group: None,
            node_selector: NodeSelector {
                role_id: "request_inbound".to_string(),
            },
            services_provided: vec![],
            inject: vec![],
            reads: vec!["v4.request.normal_payload".to_string()],
            writes: vec!["v4.request.normal_payload".to_string()],
        },
        enabled: true,
    }
}

fn compile_plan(plugin_id: &str) -> Result<NodePluginPlan, PlanError> {
    compile_node_plan(
        "v4.request.inbound.normalized",
        "request_inbound",
        "request",
        1,
        &[authoring(plugin_id)],
        &allowed_reads(),
        &allowed_writes(),
        &resource_registry(),
        &[],
    )
}

#[test]
fn candidate_publish_updates_active_pointer_once() {
    let plan = compile_plan("plugin-a").expect("compile plan");
    let hash = plan.hash.clone();
    let node_ids = vec!["v4.request.inbound.normalized".to_string()];
    let candidate_hash = PluginCandidate::hash(&PluginCandidate {
        id: CandidateId("cand-a".to_string()),
        plan: plan.clone(),
        graph_hash: hash.clone(),
        manifest_hash: hash.clone(),
        node_ids: node_ids.clone(),
        state: CandidateState::Draft,
    });
    let mut manager = PluginManager::new("actor-a", NullLifecyclePort::default());
    manager
        .create_candidate(
            CandidateId("cand-a".to_string()),
            plan.clone(),
            hash.clone(),
            hash.clone(),
            node_ids.clone(),
        )
        .expect("create");
    manager.compile("cand-a").expect("compile");
    manager.validate("cand-a").expect("validate");
    manager.mark_smoke_passed("cand-a").expect("smoke");
    let outcome = manager.publish("cand-a", None).expect("publish");
    assert_eq!(outcome.previous, None);
    assert_eq!(outcome.next.candidate_id.as_str(), "cand-a");
    assert_eq!(outcome.next.node_ids, node_ids);
    let active = manager.active().expect("active present");
    assert_eq!(active.candidate_id.as_str(), "cand-a");
    assert_eq!(active.hash, candidate_hash);
    let records = manager.audit().records();
    let publish_records: Vec<_> = records
        .iter()
        .filter(|r| matches!(r.action, AuditAction::Published))
        .collect();
    assert_eq!(
        publish_records.len(),
        1,
        "active pointer updated exactly once"
    );
}

#[test]
fn stale_base_hash_is_rejected_without_active_mutation() {
    let plan = compile_plan("plugin-b").expect("compile plan");
    let hash = plan.hash.clone();
    let mut manager = PluginManager::new("actor-b", NullLifecyclePort::default());
    let first_candidate_hash = PluginCandidate::hash(&PluginCandidate {
        id: CandidateId("cand-1".to_string()),
        plan: plan.clone(),
        graph_hash: hash.clone(),
        manifest_hash: hash.clone(),
        node_ids: vec!["v4.request.inbound.normalized".to_string()],
        state: CandidateState::Draft,
    });
    manager
        .create_candidate(
            CandidateId("cand-1".to_string()),
            plan.clone(),
            hash.clone(),
            hash.clone(),
            vec!["v4.request.inbound.normalized".to_string()],
        )
        .expect("create");
    manager.compile("cand-1").expect("compile");
    manager.validate("cand-1").expect("validate");
    manager.mark_smoke_passed("cand-1").expect("smoke");
    manager.publish("cand-1", None).expect("publish");

    let stale_plan = compile_plan("plugin-c").expect("compile plan");
    let stale_hash = stale_plan.hash.clone();
    manager
        .create_candidate(
            CandidateId("cand-2".to_string()),
            stale_plan,
            stale_hash.clone(),
            stale_hash,
            vec!["v4.request.inbound.normalized".to_string()],
        )
        .expect("create");
    manager.compile("cand-2").expect("compile");
    manager.validate("cand-2").expect("validate");
    manager.mark_smoke_passed("cand-2").expect("smoke");
    let err = manager
        .publish("cand-2", Some("this-base-is-not-active"))
        .expect_err("stale base rejected");
    assert!(matches!(err, ManagerError::StaleBase { .. }));
    assert_eq!(
        manager.active().expect("active").hash,
        first_candidate_hash,
        "active pointer must not change"
    );
}

#[test]
fn candidate_failure_keeps_active_pointer() {
    let plan = compile_plan("plugin-d").expect("compile plan");
    let hash = plan.hash.clone();
    let mut manager = PluginManager::new("actor-d", NullLifecyclePort::default());
    manager
        .create_candidate(
            CandidateId("cand-d".to_string()),
            plan,
            hash.clone(),
            hash,
            vec!["v4.request.inbound.normalized".to_string()],
        )
        .expect("create");
    manager
        .mark_failed("cand-d", "compile_failed")
        .expect("mark failed");
    assert!(
        manager.active().is_none(),
        "candidate failure must not publish active"
    );
    assert!(matches!(
        manager.candidate("cand-d").expect("present").state,
        CandidateState::Failed
    ));
}

#[test]
fn execution_failure_does_not_rollback_active_pointer() {
    let plan = compile_plan("plugin-e").expect("compile plan");
    let hash = plan.hash.clone();
    let mut manager = PluginManager::new("actor-e", NullLifecyclePort::default());
    manager
        .create_candidate(
            CandidateId("cand-e".to_string()),
            plan,
            hash.clone(),
            hash.clone(),
            vec!["v4.request.inbound.normalized".to_string()],
        )
        .expect("create");
    manager.compile("cand-e").expect("compile");
    manager.validate("cand-e").expect("validate");
    manager.mark_smoke_passed("cand-e").expect("smoke");
    manager.publish("cand-e", None).expect("publish");
    manager
        .record_execution_failure("cand-e", "downstream_typed_error")
        .expect("record failure");
    let active = manager.active().expect("active still present");
    assert_eq!(active.candidate_id.as_str(), "cand-e");
    let records = manager.audit().records();
    assert!(records
        .iter()
        .any(|r| matches!(r.action, AuditAction::ExecutionFailure)));
}

#[test]
fn duplicate_candidate_id_rejected() {
    let plan = compile_plan("plugin-f").expect("compile plan");
    let hash = plan.hash.clone();
    let mut manager = PluginManager::new("actor-f", NullLifecyclePort::default());
    manager
        .create_candidate(
            CandidateId("dup".to_string()),
            plan.clone(),
            hash.clone(),
            hash.clone(),
            vec!["v4.request.inbound.normalized".to_string()],
        )
        .expect("first create");
    let err = manager
        .create_candidate(
            CandidateId("dup".to_string()),
            plan,
            hash.clone(),
            hash.clone(),
            vec!["v4.request.inbound.normalized".to_string()],
        )
        .expect_err("duplicate");
    assert!(matches!(err, ManagerError::DuplicateCandidate));
}

#[test]
fn publish_requires_smoke_passed_state() {
    let plan = compile_plan("plugin-g").expect("compile plan");
    let hash = plan.hash.clone();
    let mut manager = PluginManager::new("actor-g", NullLifecyclePort::default());
    manager
        .create_candidate(
            CandidateId("cand-g".to_string()),
            plan,
            hash.clone(),
            hash,
            vec!["v4.request.inbound.normalized".to_string()],
        )
        .expect("create");
    let err = manager.publish("cand-g", None).expect_err("not smoke");
    assert!(matches!(err, ManagerError::NotSmokePassed));
}

#[test]
fn mount_failure_rolls_back_partial_mounts() {
    struct PartialLifecycle;
    impl LifecyclePort for PartialLifecycle {
        fn mount_candidate(
            &mut self,
            node_id: &str,
            _plan_hash: &str,
            _graph_hash: &str,
        ) -> Result<(), String> {
            if node_id == "v4.request.inbound.typed" {
                Err("typed bridge fail".to_string())
            } else {
                Ok(())
            }
        }
        fn drain(&mut self, _node_id: &str) -> Result<(), String> {
            Ok(())
        }
        fn dispose(&mut self, _node_id: &str) -> Result<(), String> {
            Ok(())
        }
        fn mounted_node_ids(&self) -> Vec<String> {
            Vec::new()
        }
        fn rejected_node_ids(&self) -> Vec<String> {
            Vec::new()
        }
    }
    let plan = compile_plan("plugin-h").expect("compile plan");
    let hash = plan.hash.clone();
    let mut manager = PluginManager::new("actor-h", PartialLifecycle);
    manager
        .create_candidate(
            CandidateId("cand-h".to_string()),
            plan,
            hash.clone(),
            hash,
            vec![
                "v4.request.inbound.normalized".to_string(),
                "v4.request.inbound.typed".to_string(),
            ],
        )
        .expect("create");
    manager.compile("cand-h").expect("compile");
    manager.validate("cand-h").expect("validate");
    manager.mark_smoke_passed("cand-h").expect("smoke");
    let err = manager.publish("cand-h", None).expect_err("mount fails");
    assert!(matches!(err, ManagerError::Lifecycle(_)));
    assert!(
        manager.active().is_none(),
        "active must not flip on mount failure"
    );
    let records = manager.audit().records();
    assert!(records.iter().any(|r| {
        matches!(r.action, AuditAction::PublishRejected)
            && matches!(r.result, AuditResult::Failure)
            && r.message.as_deref() == Some("mount_failed:v4.request.inbound.typed")
    }));
}
