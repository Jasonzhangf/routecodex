//! routecodex-v4-runtime-inspector — read-only projection of plugin-chain
//! management state.
//!
//! Produces snapshots of active chain, candidate summaries, failed
//! summaries, container lifecycle state, and audit records. Never reads
//! request/response/provider/client payload, MetadataCenter content, secret
//! material, or native handles.

use routecodex_v4_plugin_manager::{
    AuditAction, AuditRecord, AuditResult, CandidateState, LifecyclePort, PluginCandidate,
    PluginManager,
};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ActiveSummary {
    pub candidate_id: String,
    pub hash: String,
    pub node_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CandidateSummary {
    pub id: String,
    pub hash: String,
    pub state: String,
    pub node_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct FailedSummary {
    pub id: String,
    pub hash: String,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ContainerLifecycle {
    pub mounted_node_ids: Vec<String>,
    pub rejected_node_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AuditSummary {
    pub sequence: u64,
    pub actor: String,
    pub action: String,
    pub candidate_id: Option<String>,
    pub base_hash: Option<String>,
    pub candidate_hash: Option<String>,
    pub result: String,
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RuntimeSnapshot {
    pub active: Option<ActiveSummary>,
    pub candidates: Vec<CandidateSummary>,
    pub failed: Vec<FailedSummary>,
    pub container_lifecycle: ContainerLifecycle,
    pub audit: Vec<AuditSummary>,
    pub active_pointer_kind: String,
}

pub fn snapshot<L: LifecyclePort>(manager: &PluginManager<L>) -> RuntimeSnapshot {
    let active = manager.active().map(|chain| ActiveSummary {
        candidate_id: chain.candidate_id.as_str().to_string(),
        hash: chain.hash.clone(),
        node_ids: chain.node_ids.clone(),
    });
    let mut candidates: Vec<CandidateSummary> = manager
        .candidates()
        .iter()
        .filter(|c| !matches!(c.state, CandidateState::Failed | CandidateState::Discarded))
        .map(candidate_summary)
        .collect();
    candidates.sort_by(|a, b| a.id.cmp(&b.id));

    let failed: Vec<FailedSummary> = manager
        .candidates()
        .iter()
        .filter(|c| matches!(c.state, CandidateState::Failed))
        .map(|c| FailedSummary {
            id: c.id.as_str().to_string(),
            hash: c.hash(),
            reason: audit_failure_reason(&manager.audit(), c.id.as_str()),
        })
        .collect();

    let container_lifecycle = ContainerLifecycle {
        mounted_node_ids: manager.mounted_node_ids(),
        rejected_node_ids: manager.rejected_node_ids(),
    };

    let audit: Vec<AuditSummary> = manager.audit().iter().map(audit_summary).collect();

    RuntimeSnapshot {
        active,
        candidates,
        failed,
        container_lifecycle,
        audit,
        active_pointer_kind: routecodex_v4_plugin_manager::ACTIVE_POINTER_KIND.to_string(),
    }
}

fn candidate_summary(c: &PluginCandidate) -> CandidateSummary {
    CandidateSummary {
        id: c.id.as_str().to_string(),
        hash: c.hash(),
        state: state_name(c.state).to_string(),
        node_ids: c.node_ids.clone(),
    }
}

fn state_name(state: CandidateState) -> &'static str {
    match state {
        CandidateState::Draft => "draft",
        CandidateState::Compiled => "compiled",
        CandidateState::Validated => "validated",
        CandidateState::SmokePassed => "smoke_passed",
        CandidateState::Published => "published",
        CandidateState::Failed => "failed",
        CandidateState::Discarded => "discarded",
    }
}

fn audit_summary(r: &AuditRecord) -> AuditSummary {
    AuditSummary {
        sequence: r.sequence,
        actor: r.actor.clone(),
        action: action_name(r.action).to_string(),
        candidate_id: r.candidate_id.clone(),
        base_hash: r.base_hash.clone(),
        candidate_hash: r.candidate_hash.clone(),
        result: result_name(r.result).to_string(),
        message: r.message.clone(),
    }
}

fn action_name(action: AuditAction) -> &'static str {
    match action {
        AuditAction::CandidateCreated => "candidate_created",
        AuditAction::CandidateCompiled => "candidate_compiled",
        AuditAction::CandidateValidated => "candidate_validated",
        AuditAction::SmokePassed => "smoke_passed",
        AuditAction::Published => "published",
        AuditAction::PublishRejected => "publish_rejected",
        AuditAction::CandidateDiscarded => "candidate_discarded",
        AuditAction::ExecutionFailure => "execution_failure",
    }
}

fn result_name(result: AuditResult) -> &'static str {
    match result {
        AuditResult::Ok => "ok",
        AuditResult::Rejected => "rejected",
        AuditResult::Failure => "failure",
    }
}

fn audit_failure_reason(records: &[AuditRecord], candidate_id: &str) -> String {
    records
        .iter()
        .rev()
        .find(|r| {
            r.candidate_id.as_deref() == Some(candidate_id)
                && matches!(r.action, AuditAction::PublishRejected)
        })
        .and_then(|r| r.message.clone())
        .unwrap_or_else(|| "unknown".to_string())
}
