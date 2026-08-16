//! Append-only audit ledger. Records the actor, action, base/candidate
//! hashes and result; never accepts business payload or secret material.

use serde::{Deserialize, Serialize};
use thiserror::Error;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum AuditAction {
    CandidateCreated,
    CandidateCompiled,
    CandidateValidated,
    SmokePassed,
    Published,
    PublishRejected,
    CandidateDiscarded,
    ExecutionFailure,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AuditRecord {
    pub sequence: u64,
    pub actor: String,
    pub action: AuditAction,
    pub candidate_id: Option<String>,
    pub base_hash: Option<String>,
    pub candidate_hash: Option<String>,
    pub result: AuditResult,
    pub message: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum AuditResult {
    Ok,
    Rejected,
    Failure,
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum AuditError {
    #[error("audit forbidden field: {0}")]
    ForbiddenField(&'static str),
    #[error("audit ledger is full and immutable")]
    Immutable,
}

#[derive(Debug, Default)]
pub struct AuditSink {
    records: Vec<AuditRecord>,
    next_sequence: u64,
}

impl AuditSink {
    pub fn append(&mut self, record: AuditRecord) -> Result<u64, AuditError> {
        if record.actor.is_empty() {
            return Err(AuditError::ForbiddenField("actor"));
        }
        if matches!(record.action, AuditAction::ExecutionFailure) && record.candidate_id.is_none() {
            return Err(AuditError::ForbiddenField("candidate_id_for_failure"));
        }
        let sequence = self.next_sequence;
        self.next_sequence += 1;
        self.records.push(AuditRecord { sequence, ..record });
        Ok(sequence)
    }

    pub fn records(&self) -> &[AuditRecord] {
        &self.records
    }

    pub fn len(&self) -> usize {
        self.records.len()
    }

    pub fn is_empty(&self) -> bool {
        self.records.is_empty()
    }
}
