//! routecodex-v4-admin — typed query/command surface for plugin-chain
//! management.
//!
//! Commands are delegated to PluginManager; queries are delegated to
//! RuntimeInspector. This crate does not own sorting, permissions, business
//! semantics, or Cordis lifecycle. The DTO layer statically forbids
//! request/response/provider/client payload, MetadataCenter content, secret
//! material, and native handles.

use routecodex_v4_plugin_manager::{CandidateId, LifecyclePort, PluginManager};
use routecodex_v4_plugin_plan::NodePluginPlan;
use routecodex_v4_runtime_inspector::{snapshot, RuntimeSnapshot};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CreateCandidateCommand {
    pub actor: String,
    pub candidate_id: String,
    pub plan: NodePluginPlan,
    pub graph_hash: String,
    pub manifest_hash: String,
    pub node_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PublishCommand {
    pub actor: String,
    pub candidate_id: String,
    pub expected_base_hash: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct TransitionCommand {
    pub actor: String,
    pub candidate_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RecordFailureCommand {
    pub actor: String,
    pub candidate_id: String,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub enum AdminCommand {
    CreateCandidate(CreateCandidateCommand),
    Compile(TransitionCommand),
    Validate(TransitionCommand),
    MarkSmokePassed(TransitionCommand),
    MarkFailed(TransitionCommand),
    Discard(TransitionCommand),
    Publish(PublishCommand),
    RecordExecutionFailure(RecordFailureCommand),
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub enum AdminQuery {
    InspectRuntime,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub enum AdminResponse {
    Runtime(RuntimeSnapshot),
    Published {
        candidate_id: String,
        active_hash: String,
    },
    Ok {
        candidate_id: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AdminError {
    UnauthorizedActor,
    Manager(String),
}

pub fn execute<L: LifecyclePort>(
    manager: &mut PluginManager<L>,
    command: AdminCommand,
) -> Result<AdminResponse, AdminError> {
    let actor = command_actor(&command).to_string();
    if actor.is_empty() {
        return Err(AdminError::UnauthorizedActor);
    }
    match command {
        AdminCommand::CreateCandidate(command) => {
            manager
                .create_candidate(
                    CandidateId(command.candidate_id.clone()),
                    command.plan,
                    command.graph_hash,
                    command.manifest_hash,
                    command.node_ids,
                )
                .map_err(|e| AdminError::Manager(e.to_string()))?;
            Ok(AdminResponse::Ok {
                candidate_id: command.candidate_id,
            })
        }
        AdminCommand::Compile(command) => {
            manager
                .compile(&command.candidate_id)
                .map_err(|e| AdminError::Manager(e.to_string()))?;
            Ok(AdminResponse::Ok {
                candidate_id: command.candidate_id,
            })
        }
        AdminCommand::Validate(command) => {
            manager
                .validate(&command.candidate_id)
                .map_err(|e| AdminError::Manager(e.to_string()))?;
            Ok(AdminResponse::Ok {
                candidate_id: command.candidate_id,
            })
        }
        AdminCommand::MarkSmokePassed(command) => {
            manager
                .mark_smoke_passed(&command.candidate_id)
                .map_err(|e| AdminError::Manager(e.to_string()))?;
            Ok(AdminResponse::Ok {
                candidate_id: command.candidate_id,
            })
        }
        AdminCommand::MarkFailed(command) => {
            manager
                .mark_failed(&command.candidate_id, "admin_marked_failed")
                .map_err(|e| AdminError::Manager(e.to_string()))?;
            Ok(AdminResponse::Ok {
                candidate_id: command.candidate_id,
            })
        }
        AdminCommand::Discard(command) => {
            manager
                .discard(&command.candidate_id)
                .map_err(|e| AdminError::Manager(e.to_string()))?;
            Ok(AdminResponse::Ok {
                candidate_id: command.candidate_id,
            })
        }
        AdminCommand::Publish(command) => {
            let outcome = manager
                .publish(&command.candidate_id, command.expected_base_hash.as_deref())
                .map_err(|e| AdminError::Manager(e.to_string()))?;
            Ok(AdminResponse::Published {
                candidate_id: command.candidate_id,
                active_hash: outcome.next.hash,
            })
        }
        AdminCommand::RecordExecutionFailure(command) => {
            manager
                .record_execution_failure(&command.candidate_id, &command.reason)
                .map_err(|e| AdminError::Manager(e.to_string()))?;
            Ok(AdminResponse::Ok {
                candidate_id: command.candidate_id,
            })
        }
    }
}

pub fn query<L: LifecyclePort>(manager: &PluginManager<L>, query: AdminQuery) -> AdminResponse {
    match query {
        AdminQuery::InspectRuntime => AdminResponse::Runtime(snapshot(manager)),
    }
}

fn command_actor(command: &AdminCommand) -> &str {
    match command {
        AdminCommand::CreateCandidate(c) => &c.actor,
        AdminCommand::Compile(c) => &c.actor,
        AdminCommand::Validate(c) => &c.actor,
        AdminCommand::MarkSmokePassed(c) => &c.actor,
        AdminCommand::MarkFailed(c) => &c.actor,
        AdminCommand::Discard(c) => &c.actor,
        AdminCommand::Publish(c) => &c.actor,
        AdminCommand::RecordExecutionFailure(c) => &c.actor,
    }
}
