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

use routecodex_v4_plugin_plan::NodePluginPlan;
use sha2::{Digest, Sha256};
use thiserror::Error;

use crate::audit::{AuditAction, AuditRecord, AuditResult, AuditSink};

/// Typed contract for the per-node host lifecycle. The real adapter is owned
/// by the node-container crate (Track A); this crate ships a strict fake
/// (`NullLifecyclePort`) for unit tests and integration tests.
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
    candidates: BTreeMap<String, PluginCandidate>,
    active: Option<ActiveChain>,
    audit: AuditSink,
    actor: String,
    publish_lock: bool,
    port: L,
}

impl<L: LifecyclePort> PluginManager<L> {
    pub fn new(actor: impl Into<String>, port: L) -> Self {
        Self {
            candidates: BTreeMap::new(),
            active: None,
            audit: AuditSink::default(),
            actor: actor.into(),
            publish_lock: false,
            port,
        }
    }

    pub fn actor(&self) -> &str {
        &self.actor
    }

    pub fn active(&self) -> Option<&ActiveChain> {
        self.active.as_ref()
    }

    pub fn candidates(&self) -> impl Iterator<Item = &PluginCandidate> {
        self.candidates.values()
    }

    pub fn candidate(&self, id: &str) -> Option<&PluginCandidate> {
        self.candidates.get(id)
    }

    pub fn audit(&self) -> &AuditSink {
        &self.audit
    }

    pub fn port(&self) -> &L {
        &self.port
    }

    pub fn port_mut(&mut self) -> &mut L {
        &mut self.port
    }

    pub fn create_candidate(
        &mut self,
        id: CandidateId,
        plan: NodePluginPlan,
        graph_hash: String,
        manifest_hash: String,
        node_ids: Vec<String>,
    ) -> Result<&PluginCandidate, ManagerError> {
        if self.candidates.contains_key(id.as_str()) {
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
        self.audit
            .append(AuditRecord {
                sequence: 0,
                actor: self.actor.clone(),
                action: AuditAction::CandidateCreated,
                candidate_id: Some(id.0.clone()),
                base_hash: self.active.as_ref().map(|a| a.hash.clone()),
                candidate_hash: Some(candidate.hash()),
                result: AuditResult::Ok,
                message: None,
            })
            .expect("actor is set");
        self.candidates.insert(id.0.clone(), candidate);
        Ok(self.candidates.get(id.as_str()).expect("just inserted"))
    }

    pub fn compile(&mut self, id: &str) -> Result<(), ManagerError> {
        self.transition(
            id,
            CandidateState::Draft,
            CandidateState::Compiled,
            AuditAction::CandidateCompiled,
        )
    }

    pub fn validate(&mut self, id: &str) -> Result<(), ManagerError> {
        self.transition(
            id,
            CandidateState::Compiled,
            CandidateState::Validated,
            AuditAction::CandidateValidated,
        )
    }

    pub fn mark_smoke_passed(&mut self, id: &str) -> Result<(), ManagerError> {
        self.transition(
            id,
            CandidateState::Validated,
            CandidateState::SmokePassed,
            AuditAction::SmokePassed,
        )
    }

    pub fn mark_failed(&mut self, id: &str, reason: &str) -> Result<(), ManagerError> {
        let candidate = self
            .candidates
            .get(id)
            .ok_or(ManagerError::UnknownCandidate)?
            .clone();
        self.audit
            .append(AuditRecord {
                sequence: 0,
                actor: self.actor.clone(),
                action: AuditAction::PublishRejected,
                candidate_id: Some(candidate.id.0.clone()),
                base_hash: self.active.as_ref().map(|a| a.hash.clone()),
                candidate_hash: Some(candidate.hash()),
                result: AuditResult::Failure,
                message: Some(reason.to_string()),
            })
            .expect("actor is set");
        let entry = self.candidates.get_mut(id).expect("present");
        entry.state = CandidateState::Failed;
        Ok(())
    }

    pub fn discard(&mut self, id: &str) -> Result<(), ManagerError> {
        let candidate = self
            .candidates
            .get(id)
            .ok_or(ManagerError::UnknownCandidate)?
            .clone();
        self.audit
            .append(AuditRecord {
                sequence: 0,
                actor: self.actor.clone(),
                action: AuditAction::CandidateDiscarded,
                candidate_id: Some(candidate.id.0.clone()),
                base_hash: self.active.as_ref().map(|a| a.hash.clone()),
                candidate_hash: Some(candidate.hash()),
                result: AuditResult::Ok,
                message: None,
            })
            .expect("actor is set");
        let entry = self.candidates.get_mut(id).expect("present");
        entry.state = CandidateState::Discarded;
        Ok(())
    }

    pub fn publish(
        &mut self,
        id: &str,
        expected_base_hash: Option<&str>,
    ) -> Result<PublishOutcome, ManagerError> {
        if self.publish_lock {
            return Err(ManagerError::ConcurrentPublish);
        }
        self.publish_lock = true;
        let result = self.publish_locked(id, expected_base_hash);
        self.publish_lock = false;
        result
    }

    fn publish_locked(
        &mut self,
        id: &str,
        expected_base_hash: Option<&str>,
    ) -> Result<PublishOutcome, ManagerError> {
        let candidate = self
            .candidates
            .get(id)
            .ok_or(ManagerError::UnknownCandidate)?
            .clone();
        if candidate.state != CandidateState::SmokePassed {
            return Err(ManagerError::NotSmokePassed);
        }
        let actual_base = self.active.as_ref().map(|a| a.hash.clone());
        if actual_base.as_deref() != expected_base_hash {
            self.audit
                .append(AuditRecord {
                    sequence: 0,
                    actor: self.actor.clone(),
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
            match self
                .port
                .mount_candidate(node_id, &candidate.hash(), &candidate.graph_hash)
            {
                Ok(()) => mounted_node_ids.push(node_id.clone()),
                Err(message) => {
                    self.audit
                        .append(AuditRecord {
                            sequence: 0,
                            actor: self.actor.clone(),
                            action: AuditAction::PublishRejected,
                            candidate_id: Some(candidate.id.0.clone()),
                            base_hash: actual_base.clone(),
                            candidate_hash: Some(candidate.hash()),
                            result: AuditResult::Failure,
                            message: Some(format!("mount_failed:{node_id}")),
                        })
                        .ok();
                    for mounted in mounted_node_ids.iter().rev() {
                        let _ = self.port.dispose(mounted);
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
        let previous = self.active.replace(next.clone());
        let entry = self.candidates.get_mut(id).expect("present");
        entry.state = CandidateState::Published;
        self.audit
            .append(AuditRecord {
                sequence: 0,
                actor: self.actor.clone(),
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
        &mut self,
        candidate_id: &str,
        reason: &str,
    ) -> Result<(), ManagerError> {
        if !self.candidates.contains_key(candidate_id) {
            return Err(ManagerError::UnknownCandidate);
        }
        let active_before = self.active.clone();
        self.audit
            .append(AuditRecord {
                sequence: 0,
                actor: self.actor.clone(),
                action: AuditAction::ExecutionFailure,
                candidate_id: Some(candidate_id.to_string()),
                base_hash: active_before.as_ref().map(|a| a.hash.clone()),
                candidate_hash: self.candidates.get(candidate_id).map(|c| c.hash()),
                result: AuditResult::Failure,
                message: Some(reason.to_string()),
            })
            .expect("actor is set");
        debug_assert_eq!(
            self.active, active_before,
            "execution failure must not mutate active pointer"
        );
        Ok(())
    }

    fn transition(
        &mut self,
        id: &str,
        from: CandidateState,
        to: CandidateState,
        action: AuditAction,
    ) -> Result<(), ManagerError> {
        let candidate = self
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
        self.audit
            .append(AuditRecord {
                sequence: 0,
                actor: self.actor.clone(),
                action,
                candidate_id: Some(candidate.id.0.clone()),
                base_hash: self.active.as_ref().map(|a| a.hash.clone()),
                candidate_hash: Some(candidate.hash()),
                result: AuditResult::Ok,
                message: None,
            })
            .expect("actor is set");
        let entry = self.candidates.get_mut(id).expect("present");
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
