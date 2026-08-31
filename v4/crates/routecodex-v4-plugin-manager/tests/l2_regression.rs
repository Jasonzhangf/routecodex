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
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::Duration;

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
                node_id: "V4HubReqInbound02Normalized".to_string(),
                position: 2,
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
        "V4HubReqInbound02Normalized",
        "request_inbound",
        "request",
        2,
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
    let node_ids = vec!["V4HubReqInbound03Normalized".to_string()];
    let candidate_hash = PluginCandidate::hash(&PluginCandidate {
        id: CandidateId("cand-a".to_string()),
        plan: plan.clone(),
        graph_hash: hash.clone(),
        manifest_hash: hash.clone(),
        node_ids: node_ids.clone(),
        state: CandidateState::Draft,
    });
    let manager = PluginManager::new("actor-a", NullLifecyclePort::default());
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
    let records = manager.audit();
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
    let manager = PluginManager::new("actor-b", NullLifecyclePort::default());
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
    let manager = PluginManager::new("actor-d", NullLifecyclePort::default());
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
    let manager = PluginManager::new("actor-e", NullLifecyclePort::default());
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
    let records = manager.audit();
    assert!(records
        .iter()
        .any(|r| matches!(r.action, AuditAction::ExecutionFailure)));
}

#[test]
fn duplicate_candidate_id_rejected() {
    let plan = compile_plan("plugin-f").expect("compile plan");
    let hash = plan.hash.clone();
    let manager = PluginManager::new("actor-f", NullLifecyclePort::default());
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
    let manager = PluginManager::new("actor-g", NullLifecyclePort::default());
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
    let manager = PluginManager::new("actor-h", PartialLifecycle);
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
    let records = manager.audit();
    assert!(records.iter().any(|r| {
        matches!(r.action, AuditAction::PublishRejected)
            && matches!(r.result, AuditResult::Failure)
            && r.message.as_deref() == Some("mount_failed:v4.request.inbound.typed")
    }));
}

#[test]
fn published_candidate_cannot_be_failed_or_discarded() {
    let plan = compile_plan("plugin-published").expect("compile plan");
    let hash = plan.hash.clone();
    let manager = PluginManager::new("actor-published", NullLifecyclePort::default());
    manager
        .create_candidate(
            CandidateId("cand-published".to_string()),
            plan,
            hash.clone(),
            hash,
            vec!["v4.request.inbound.normalized".to_string()],
        )
        .expect("create");
    manager.compile("cand-published").expect("compile");
    manager.validate("cand-published").expect("validate");
    manager.mark_smoke_passed("cand-published").expect("smoke");
    manager.publish("cand-published", None).expect("publish");

    let fail_err = manager
        .mark_failed("cand-published", "late failure")
        .expect_err("published candidate must not be marked failed");
    assert!(matches!(
        fail_err,
        ManagerError::InvalidTransition {
            from: CandidateState::Published,
            action: "mark_failed"
        }
    ));
    let discard_err = manager
        .discard("cand-published")
        .expect_err("published candidate must not be discarded");
    assert!(matches!(
        discard_err,
        ManagerError::InvalidTransition {
            from: CandidateState::Published,
            action: "discard"
        }
    ));
    assert!(matches!(
        manager
            .candidate("cand-published")
            .expect("candidate present")
            .state,
        CandidateState::Published
    ));
    assert_eq!(
        manager.active().expect("active").candidate_id.as_str(),
        "cand-published",
        "active pointer must keep referencing the published candidate"
    );
}

#[test]
fn failed_candidate_can_be_discarded() {
    let plan = compile_plan("plugin-discard").expect("compile plan");
    let hash = plan.hash.clone();
    let manager = PluginManager::new("actor-discard", NullLifecyclePort::default());
    manager
        .create_candidate(
            CandidateId("cand-discard".to_string()),
            plan,
            hash.clone(),
            hash,
            vec!["v4.request.inbound.normalized".to_string()],
        )
        .expect("create");
    manager
        .mark_failed("cand-discard", "typed_error")
        .expect("mark failed");
    manager.discard("cand-discard").expect("discard failed");
    assert!(matches!(
        manager
            .candidate("cand-discard")
            .expect("candidate present")
            .state,
        CandidateState::Discarded
    ));
}

/// Lifecycle port that blocks the first mount until the test releases it, so
/// a second publisher provably hits the live publish gate.
#[derive(Clone)]
struct BlockingPort {
    mounted: Arc<Mutex<Vec<String>>>,
    release: Arc<Mutex<Option<mpsc::Receiver<()>>>>,
}

impl LifecyclePort for BlockingPort {
    fn mount_candidate(
        &mut self,
        node_id: &str,
        _plan_hash: &str,
        _graph_hash: &str,
    ) -> Result<(), String> {
        self.mounted
            .lock()
            .expect("mounted lock")
            .push(node_id.to_string());
        let guard = self.release.lock().expect("release lock");
        if let Some(rx) = guard.as_ref() {
            let _ = rx.recv();
        }
        Ok(())
    }

    fn drain(&mut self, _node_id: &str) -> Result<(), String> {
        Ok(())
    }

    fn dispose(&mut self, _node_id: &str) -> Result<(), String> {
        Ok(())
    }

    fn mounted_node_ids(&self) -> Vec<String> {
        self.mounted.lock().expect("mounted lock").clone()
    }

    fn rejected_node_ids(&self) -> Vec<String> {
        Vec::new()
    }
}

#[test]
fn concurrent_publish_rejects_second_caller() {
    let (release_tx, release_rx) = mpsc::channel::<()>();
    let port = BlockingPort {
        mounted: Arc::new(Mutex::new(Vec::new())),
        release: Arc::new(Mutex::new(Some(release_rx))),
    };
    let watch = port.clone();
    let plan = compile_plan("plugin-concurrent").expect("compile plan");
    let hash = plan.hash.clone();
    let manager = Arc::new(PluginManager::new("actor-concurrent", port));
    manager
        .create_candidate(
            CandidateId("cand-concurrent".to_string()),
            plan,
            hash.clone(),
            hash,
            vec!["v4.request.inbound.normalized".to_string()],
        )
        .expect("create");
    manager.compile("cand-concurrent").expect("compile");
    manager.validate("cand-concurrent").expect("validate");
    manager.mark_smoke_passed("cand-concurrent").expect("smoke");

    let first = manager.clone();
    let first_thread = thread::spawn(move || first.publish("cand-concurrent", None));

    let mut mounted = false;
    for _ in 0..200 {
        if !watch.mounted.lock().expect("mounted lock").is_empty() {
            mounted = true;
            break;
        }
        thread::sleep(Duration::from_millis(10));
    }
    assert!(mounted, "first publish must hold the gate inside mount");

    let second_result = manager.publish("cand-concurrent", None);
    assert!(
        matches!(second_result, Err(ManagerError::ConcurrentPublish)),
        "second concurrent publish must be rejected, got {second_result:?}"
    );

    let _ = release_tx.send(());
    let first_result = first_thread.join().expect("first publish thread");
    assert!(matches!(first_result, Ok(_)));
    let records = manager.audit();
    assert_eq!(
        records
            .iter()
            .filter(|r| matches!(r.action, AuditAction::Published))
            .count(),
        1,
        "active pointer updated exactly once"
    );
}

/// Lifecycle port whose first mount panics while the publish gate and the
/// interior lock are held, so the test can prove the manager recovers from a
/// poisoned gate instead of permanently misreporting concurrent publish.
#[derive(Clone)]
struct PanicOncePort {
    armed: Arc<AtomicBool>,
    mounted: Arc<Mutex<Vec<String>>>,
    disposed: Arc<Mutex<Vec<String>>>,
}

impl LifecyclePort for PanicOncePort {
    fn mount_candidate(
        &mut self,
        node_id: &str,
        _plan_hash: &str,
        _graph_hash: &str,
    ) -> Result<(), String> {
        if self.armed.swap(false, Ordering::SeqCst) {
            panic!("mid-mount panic while publish gate held");
        }
        self.mounted
            .lock()
            .expect("mounted lock")
            .push(node_id.to_string());
        Ok(())
    }

    fn drain(&mut self, _node_id: &str) -> Result<(), String> {
        Ok(())
    }

    fn dispose(&mut self, node_id: &str) -> Result<(), String> {
        self.disposed
            .lock()
            .expect("disposed lock")
            .push(node_id.to_string());
        Ok(())
    }

    fn mounted_node_ids(&self) -> Vec<String> {
        self.mounted.lock().expect("mounted lock").clone()
    }

    fn rejected_node_ids(&self) -> Vec<String> {
        Vec::new()
    }
}

#[test]
fn poisoned_publish_gate_recovers_and_is_not_misclassified() {
    let port = PanicOncePort {
        armed: Arc::new(AtomicBool::new(true)),
        mounted: Arc::new(Mutex::new(Vec::new())),
        disposed: Arc::new(Mutex::new(Vec::new())),
    };
    let watch = port.clone();
    let plan = compile_plan("plugin-poison").expect("compile plan");
    let hash = plan.hash.clone();
    let manager = PluginManager::new("actor-poison", port);
    manager
        .create_candidate(
            CandidateId("cand-poison".to_string()),
            plan,
            hash.clone(),
            hash,
            vec!["v4.request.inbound.normalized".to_string()],
        )
        .expect("create");
    manager.compile("cand-poison").expect("compile");
    manager.validate("cand-poison").expect("validate");
    manager.mark_smoke_passed("cand-poison").expect("smoke");

    // Precondition: a panic while mount is running poisons both locks.
    let panic_outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        manager.publish("cand-poison", None)
    }));
    assert!(
        panic_outcome.is_err(),
        "mid-publish panic must poison the publish gate"
    );

    // Negative: the panic must not leave partial mounts or a flipped active
    // pointer, and the next publish must not be misreported as ConcurrentPublish.
    assert!(
        watch.mounted.lock().expect("mounted lock").is_empty(),
        "no mount may survive a mid-mount panic"
    );
    assert!(watch.disposed.lock().expect("disposed lock").is_empty());
    assert!(
        manager.active().is_none(),
        "active pointer must not flip on a mid-publish panic"
    );
    assert!(matches!(
        manager.candidate("cand-poison").expect("present").state,
        CandidateState::SmokePassed
    ));

    // Positive: the poisoned gate recovers (into_inner) and publish succeeds;
    // it is neither ConcurrentPublish nor permanently blocked.
    match manager.publish("cand-poison", None) {
        Ok(_) => {}
        Err(err) => panic!("poisoned gate must recover, got {err:?}"),
    }
    assert_eq!(
        manager.active().expect("active").candidate_id.as_str(),
        "cand-poison"
    );
    assert!(matches!(
        manager.candidate("cand-poison").expect("present").state,
        CandidateState::Published
    ));
    assert_eq!(
        watch.mounted.lock().expect("mounted lock").clone(),
        vec!["v4.request.inbound.normalized".to_string()]
    );
    assert!(watch.disposed.lock().expect("disposed lock").is_empty());
    assert_eq!(
        manager
            .audit()
            .iter()
            .filter(|r| matches!(r.action, AuditAction::Published))
            .count(),
        1,
        "exactly one Published audit record after recovery"
    );
}

#[test]
fn manager_view_is_atomic_across_concurrent_publish() {
    let (release_tx, release_rx) = mpsc::channel::<()>();
    let port = BlockingPort {
        mounted: Arc::new(Mutex::new(Vec::new())),
        release: Arc::new(Mutex::new(Some(release_rx))),
    };
    let watch = port.clone();
    let plan = compile_plan("plugin-view").expect("compile plan");
    let hash = plan.hash.clone();
    let manager = Arc::new(PluginManager::new("actor-view", port));
    manager
        .create_candidate(
            CandidateId("cand-view".to_string()),
            plan,
            hash.clone(),
            hash,
            vec!["v4.request.inbound.normalized".to_string()],
        )
        .expect("create");
    manager.compile("cand-view").expect("compile");
    manager.validate("cand-view").expect("validate");
    manager.mark_smoke_passed("cand-view").expect("smoke");

    let first = manager.clone();
    let first_thread = thread::spawn(move || first.publish("cand-view", None));

    let mut mounted = false;
    for _ in 0..200 {
        if !watch.mounted.lock().expect("mounted lock").is_empty() {
            mounted = true;
            break;
        }
        thread::sleep(Duration::from_millis(10));
    }
    assert!(
        mounted,
        "publish must hold the interior lock inside mount before view is read"
    );

    let (done_tx, done_rx) = mpsc::channel::<()>();
    let second = manager.clone();
    let view_thread = thread::spawn(move || {
        let view = second.view();
        done_tx.send(()).expect("send view");
        view
    });

    // Negative: a view issued while publish is mid-mount must not return a
    // torn snapshot; it waits for the single interior lock.
    assert!(
        done_rx.recv_timeout(Duration::from_millis(250)).is_err(),
        "view must not observe mid-publish state"
    );

    let _ = release_tx.send(());
    let first_result = first_thread.join().expect("first publish thread");
    assert!(matches!(first_result, Ok(_)));

    // Positive: after the transition the single-lock view is complete and
    // internally consistent: active matches the published candidate, the
    // candidate state and mount facts agree.
    let view = view_thread.join().expect("view thread");
    let active = view.active.expect("active present after publish");
    assert_eq!(active.candidate_id.as_str(), "cand-view");
    assert_eq!(active.hash, view.candidates[0].hash());
    assert!(matches!(
        view.candidates[0].state,
        CandidateState::Published
    ));
    assert_eq!(
        view.mounted_node_ids,
        vec!["v4.request.inbound.normalized".to_string()]
    );
}
