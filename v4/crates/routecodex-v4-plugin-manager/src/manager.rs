//! Plugin candidate transaction state machine.
//!
//! ```text
//! draft -> compiled -> validated -> smoke_passed -> published
//!   \-> failed
//!   \-> discarded
//! ```
//!
//! The Manager owns the unique active pointer (`Option<ActiveChain>`). The
//! only path that mutates it is `publish`, which compares the expected base
//! hash, calls the typed `LifecyclePort::mount_candidate` for each Manifest-
//! supplied node id, then atomically swaps the active pointer and records
//! an audit entry. Published execution failures only record an
//! `ExecutionFailure` audit entry — the active pointer is never auto-rolled.

use std::collections::BTreeMap;
use std::sync::{Mutex, MutexGuard};

use routecodex_v4_plugin_plan::NodePluginPlan;
use sha2::{Digest, Sha256};
use thiserror::Error;

use crate::audit::{AuditAction, AuditRecord, AuditResult, AuditSink};

/// Typed contract for the per-node host lifecycle. The real JS host-to-Rust
/// binding remains `binding pending` until the M8 native bridge is wired;
/// this crate ships `NullLifecyclePort` only as a strict test double.
pub trait LifecyclePort {
    fn mount_candidate(
        &mut self,
        node_id: &str,
        plan_hash: &str,
        graph_hash: &str,
    ) -> Result<(), String>;
    fn drain(&mut self, node_id: &str) -> Result<(), String>;
    fn dispose(&mut self, node_id: &str) -> Result<(), String>;
    fn mounted_node_ids(&self) -> Vec<String>;
    fn rejected_node_ids(&self) -> Vec<String>;
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CandidateState {
    Draft,
    Compiled,
    Validated,
    SmokePassed,
    Published,
    Failed,
    Discarded,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CandidateId(pub String);

impl CandidateId {
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

#[derive(Debug, Clone)]
pub struct PluginCandidate {
    pub id: CandidateId,
    pub plan: NodePluginPlan,
    pub graph_hash: String,
    pub manifest_hash: String,
    pub node_ids: Vec<String>,
    pub state: CandidateState,
}

impl PluginCandidate {
    pub fn hash(&self) -> String {
        let mut hasher = Sha256::new();
        hasher.update(self.id.0.as_bytes());
        hasher.update(b"|");
        hasher.update(self.plan.hash.as_bytes());
        hasher.update(b"|");
        hasher.update(self.graph_hash.as_bytes());
        hasher.update(b"|");
        hasher.update(self.manifest_hash.as_bytes());
        for node_id in &self.node_ids {
            hasher.update(b"|");
            hasher.update(node_id.as_bytes());
        }
        format!("{:x}", hasher.finalize())
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ActiveChain {
    pub candidate_id: CandidateId,
    pub hash: String,
    pub node_ids: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct PublishOutcome {
    pub previous: Option<ActiveChain>,
    pub next: ActiveChain,
}

#[derive(Debug, Clone)]
pub struct ManagerView {
    pub active: Option<ActiveChain>,
    pub candidates: Vec<PluginCandidate>,
    pub audit: Vec<AuditRecord>,
    pub mounted_node_ids: Vec<String>,
    pub rejected_node_ids: Vec<String>,
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum ManagerError {
    #[error("candidate already exists")]
    DuplicateCandidate,
    #[error("candidate not found")]
    UnknownCandidate,
    #[error("invalid transition from {from:?} via {action}")]
    InvalidTransition {
        from: CandidateState,
        action: &'static str,
    },
    #[error("candidate plan hash mismatch: graph={graph} manifest={manifest} plan={plan}")]
    HashMismatch {
        graph: String,
        manifest: String,
        plan: String,
    },
    #[error("stale base hash: expected {expected:?} actual {actual:?}")]
    StaleBase {
        expected: Option<String>,
        actual: Option<String>,
    },
    #[error("lifecycle port rejected mount: {0}")]
    Lifecycle(String),
    #[error("active pointer already locked by concurrent publish")]
    ConcurrentPublish,
    #[error("publish requires candidate in SmokePassed state")]
    NotSmokePassed,
}

pub struct PluginManager<L: LifecyclePort> {
    inner: Mutex<ManagerInner<L>>,
    publish_gate: Mutex<()>,
}

struct ManagerInner<L: LifecyclePort> {
    candidates: BTreeMap<String, PluginCandidate>,
    active: Option<ActiveChain>,
    audit: AuditSink,
    actor: String,
    port: L,
}

impl<L: LifecyclePort> PluginManager<L> {
    pub fn new(actor: impl Into<String>, port: L) -> Self {
        Self {
            inner: Mutex::new(ManagerInner {
                candidates: BTreeMap::new(),
                active: None,
                audit: AuditSink::default(),
                actor: actor.into(),
                port,
            }),
            publish_gate: Mutex::new(()),
        }
    }

    fn lock(&self) -> MutexGuard<'_, ManagerInner<L>> {
        self.inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    pub fn actor(&self) -> String {
        self.lock().actor.clone()
    }

    pub fn active(&self) -> Option<ActiveChain> {
        self.lock().active.clone()
    }

    pub fn candidates(&self) -> Vec<PluginCandidate> {
        self.lock().candidates.values().cloned().collect()
    }

    pub fn candidate(&self, id: &str) -> Option<PluginCandidate> {
        self.lock().candidates.get(id).cloned()
    }

    pub fn audit(&self) -> Vec<AuditRecord> {
        self.lock().audit.records().to_vec()
    }

    pub fn mounted_node_ids(&self) -> Vec<String> {
        self.lock().port.mounted_node_ids()
    }

    pub fn rejected_node_ids(&self) -> Vec<String> {
        self.lock().port.rejected_node_ids()
    }

    /// Single-lock read of every management fact the inspector projects, so a
    /// snapshot cannot observe torn state across concurrent transitions.
    pub fn view(&self) -> ManagerView {
        let inner = self.lock();
        ManagerView {
            active: inner.active.clone(),
            candidates: inner.candidates.values().cloned().collect(),
            audit: inner.audit.records().to_vec(),
            mounted_node_ids: inner.port.mounted_node_ids(),
            rejected_node_ids: inner.port.rejected_node_ids(),
        }
    }

    pub fn create_candidate(
        &self,
        id: CandidateId,
        plan: NodePluginPlan,
        graph_hash: String,
        manifest_hash: String,
        node_ids: Vec<String>,
    ) -> Result<(), ManagerError> {
        let mut inner = self.lock();
        if inner.candidates.contains_key(id.as_str()) {
            return Err(ManagerError::DuplicateCandidate);
        }
        if graph_hash.is_empty() || manifest_hash.is_empty() {
            return Err(ManagerError::HashMismatch {
                graph: graph_hash,
                manifest: manifest_hash,
                plan: plan.hash.clone(),
            });
        }
        if graph_hash != manifest_hash || manifest_hash != plan.hash {
            return Err(ManagerError::HashMismatch {
                graph: graph_hash,
                manifest: manifest_hash,
                plan: plan.hash,
            });
        }
        if node_ids.is_empty() {
            return Err(ManagerError::InvalidTransition {
                from: CandidateState::Draft,
                action: "create_with_no_node_ids",
            });
        }
        let candidate = PluginCandidate {
            id: id.clone(),
            plan,
            graph_hash,
            manifest_hash,
            node_ids,
            state: CandidateState::Draft,
        };
        let actor = inner.actor.clone();
        let base_hash = inner.active.as_ref().map(|a| a.hash.clone());
        inner
            .audit
            .append(AuditRecord {
                sequence: 0,
                actor,
                action: AuditAction::CandidateCreated,
                candidate_id: Some(id.0.clone()),
                base_hash,
                candidate_hash: Some(candidate.hash()),
                result: AuditResult::Ok,
                message: None,
            })
            .expect("actor is set");
        inner.candidates.insert(id.0.clone(), candidate);
        Ok(())
    }

    pub fn compile(&self, id: &str) -> Result<(), ManagerError> {
        self.transition(
            id,
            CandidateState::Draft,
            CandidateState::Compiled,
            AuditAction::CandidateCompiled,
        )
    }

    pub fn validate(&self, id: &str) -> Result<(), ManagerError> {
        self.transition(
            id,
            CandidateState::Compiled,
            CandidateState::Validated,
            AuditAction::CandidateValidated,
        )
    }

    pub fn mark_smoke_passed(&self, id: &str) -> Result<(), ManagerError> {
        self.transition(
            id,
            CandidateState::Validated,
            CandidateState::SmokePassed,
            AuditAction::SmokePassed,
        )
    }

    pub fn mark_failed(&self, id: &str, reason: &str) -> Result<(), ManagerError> {
        let mut inner = self.lock();
        let candidate = inner
            .candidates
            .get(id)
            .ok_or(ManagerError::UnknownCandidate)?
            .clone();
        if !matches!(
            candidate.state,
            CandidateState::Draft
                | CandidateState::Compiled
                | CandidateState::Validated
                | CandidateState::SmokePassed
        ) {
            return Err(ManagerError::InvalidTransition {
                from: candidate.state,
                action: "mark_failed",
            });
        }
        let actor = inner.actor.clone();
        let base_hash = inner.active.as_ref().map(|a| a.hash.clone());
        inner
            .audit
            .append(AuditRecord {
                sequence: 0,
                actor,
                action: AuditAction::PublishRejected,
                candidate_id: Some(candidate.id.0.clone()),
                base_hash,
                candidate_hash: Some(candidate.hash()),
                result: AuditResult::Failure,
                message: Some(reason.to_string()),
            })
            .expect("actor is set");
        let entry = inner.candidates.get_mut(id).expect("present");
        entry.state = CandidateState::Failed;
        Ok(())
    }

    pub fn discard(&self, id: &str) -> Result<(), ManagerError> {
        let mut inner = self.lock();
        let candidate = inner
            .candidates
            .get(id)
            .ok_or(ManagerError::UnknownCandidate)?
            .clone();
        if matches!(
            candidate.state,
            CandidateState::Published | CandidateState::Discarded
        ) {
            return Err(ManagerError::InvalidTransition {
                from: candidate.state,
                action: "discard",
            });
        }
        let actor = inner.actor.clone();
        let base_hash = inner.active.as_ref().map(|a| a.hash.clone());
        inner
            .audit
            .append(AuditRecord {
                sequence: 0,
                actor,
                action: AuditAction::CandidateDiscarded,
                candidate_id: Some(candidate.id.0.clone()),
                base_hash,
                candidate_hash: Some(candidate.hash()),
                result: AuditResult::Ok,
                message: None,
            })
            .expect("actor is set");
        let entry = inner.candidates.get_mut(id).expect("present");
        entry.state = CandidateState::Discarded;
        Ok(())
    }

    pub fn publish(
        &self,
        id: &str,
        expected_base_hash: Option<&str>,
    ) -> Result<PublishOutcome, ManagerError> {
        // Only a genuinely held gate is a concurrent publish. A poisoned gate
        // (a prior publisher panicked while holding it) must not be mislabeled
        // as a transient race and must not permanently block publishing; the
        // recovered guard is safe because the interior lock also recovers.
        let _gate = match self.publish_gate.try_lock() {
            Ok(guard) => guard,
            Err(std::sync::TryLockError::WouldBlock) => {
                return Err(ManagerError::ConcurrentPublish);
            }
            Err(std::sync::TryLockError::Poisoned(poisoned)) => poisoned.into_inner(),
        };
        let mut inner = self.lock();
        Self::publish_locked(&mut inner, id, expected_base_hash)
    }

    fn publish_locked(
        inner: &mut ManagerInner<L>,
        id: &str,
        expected_base_hash: Option<&str>,
    ) -> Result<PublishOutcome, ManagerError> {
        let candidate = inner
            .candidates
            .get(id)
            .ok_or(ManagerError::UnknownCandidate)?
            .clone();
        if candidate.state != CandidateState::SmokePassed {
            return Err(ManagerError::NotSmokePassed);
        }
        let actual_base = inner.active.as_ref().map(|a| a.hash.clone());
        if actual_base.as_deref() != expected_base_hash {
            let actor = inner.actor.clone();
            inner
                .audit
                .append(AuditRecord {
                    sequence: 0,
                    actor,
                    action: AuditAction::PublishRejected,
                    candidate_id: Some(candidate.id.0.clone()),
                    base_hash: actual_base.clone(),
                    candidate_hash: Some(candidate.hash()),
                    result: AuditResult::Rejected,
                    message: Some("stale_base_hash".to_string()),
                })
                .expect("actor is set");
            return Err(ManagerError::StaleBase {
                expected: expected_base_hash.map(|s| s.to_string()),
                actual: actual_base,
            });
        }
        let mut mounted_node_ids = Vec::with_capacity(candidate.node_ids.len());
        for node_id in &candidate.node_ids {
            match inner
                .port
                .mount_candidate(node_id, &candidate.hash(), &candidate.graph_hash)
            {
                Ok(()) => mounted_node_ids.push(node_id.clone()),
                Err(message) => {
                    let actor = inner.actor.clone();
                    inner
                        .audit
                        .append(AuditRecord {
                            sequence: 0,
                            actor,
                            action: AuditAction::PublishRejected,
                            candidate_id: Some(candidate.id.0.clone()),
                            base_hash: actual_base.clone(),
                            candidate_hash: Some(candidate.hash()),
                            result: AuditResult::Failure,
                            message: Some(format!("mount_failed:{node_id}")),
                        })
                        .ok();
                    for mounted in mounted_node_ids.iter().rev() {
                        let _ = inner.port.dispose(mounted);
                    }
                    return Err(ManagerError::Lifecycle(message));
                }
            }
        }
        let next = ActiveChain {
            candidate_id: candidate.id.clone(),
            hash: candidate.hash(),
            node_ids: mounted_node_ids,
        };
        let previous = inner.active.replace(next.clone());
        let entry = inner.candidates.get_mut(id).expect("present");
        entry.state = CandidateState::Published;
        let actor = inner.actor.clone();
        inner
            .audit
            .append(AuditRecord {
                sequence: 0,
                actor,
                action: AuditAction::Published,
                candidate_id: Some(candidate.id.0.clone()),
                base_hash: previous.as_ref().map(|p| p.hash.clone()),
                candidate_hash: Some(candidate.hash()),
                result: AuditResult::Ok,
                message: None,
            })
            .expect("actor is set");
        Ok(PublishOutcome { previous, next })
    }

    pub fn record_execution_failure(
        &self,
        candidate_id: &str,
        reason: &str,
    ) -> Result<(), ManagerError> {
        let mut inner = self.lock();
        if !inner.candidates.contains_key(candidate_id) {
            return Err(ManagerError::UnknownCandidate);
        }
        let active_before = inner.active.clone();
        let actor = inner.actor.clone();
        let candidate_hash = inner.candidates.get(candidate_id).map(|c| c.hash());
        inner
            .audit
            .append(AuditRecord {
                sequence: 0,
                actor,
                action: AuditAction::ExecutionFailure,
                candidate_id: Some(candidate_id.to_string()),
                base_hash: active_before.as_ref().map(|a| a.hash.clone()),
                candidate_hash,
                result: AuditResult::Failure,
                message: Some(reason.to_string()),
            })
            .expect("actor is set");
        debug_assert_eq!(
            inner.active, active_before,
            "execution failure must not mutate active pointer"
        );
        Ok(())
    }

    fn transition(
        &self,
        id: &str,
        from: CandidateState,
        to: CandidateState,
        action: AuditAction,
    ) -> Result<(), ManagerError> {
        let mut inner = self.lock();
        let candidate = inner
            .candidates
            .get(id)
            .ok_or(ManagerError::UnknownCandidate)?
            .clone();
        if candidate.state != from {
            return Err(ManagerError::InvalidTransition {
                from: candidate.state,
                action: action_name(action),
            });
        }
        let actor = inner.actor.clone();
        let base_hash = inner.active.as_ref().map(|a| a.hash.clone());
        inner
            .audit
            .append(AuditRecord {
                sequence: 0,
                actor,
                action,
                candidate_id: Some(candidate.id.0.clone()),
                base_hash,
                candidate_hash: Some(candidate.hash()),
                result: AuditResult::Ok,
                message: None,
            })
            .expect("actor is set");
        let entry = inner.candidates.get_mut(id).expect("present");
        entry.state = to;
        Ok(())
    }
}

fn action_name(action: AuditAction) -> &'static str {
    match action {
        AuditAction::CandidateCreated => "create",
        AuditAction::CandidateCompiled => "compile",
        AuditAction::CandidateValidated => "validate",
        AuditAction::SmokePassed => "smoke",
        AuditAction::Published => "publish",
        AuditAction::PublishRejected => "publish_rejected",
        AuditAction::CandidateDiscarded => "discard",
        AuditAction::ExecutionFailure => "execution_failure",
    }
}
