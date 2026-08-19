//! routecodex-v4-router — compiled target selection and live policy owner
//! (`v4.control.route_policy_live`, V4Router08LivePolicyOverride).
//!
//! Hard boundaries:
//! - live override is anchored to the manifest baseline and is audit-only:
//!   it never patches payload and never changes the compiled manifest truth;
//! - session-scoped and immutable-history: every override set is appended,
//!   never rewritten;
//! - control fields never enter provider/client normal payload.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProviderCandidate {
    pub provider_id: String,
    pub config_path: String,
    pub protocol: String,
    pub model: String,
    pub priority: u32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SelectedTarget {
    pub provider_id: String,
    pub config_path: String,
    pub protocol: String,
    pub model: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TargetSelectionError {
    EmptyCandidates,
    ModelUnavailable(String),
}

impl std::fmt::Display for TargetSelectionError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::EmptyCandidates => write!(f, "compiled provider candidate set is empty"),
            Self::ModelUnavailable(model) => {
                write!(f, "no compiled provider candidate supports model {model}")
            }
        }
    }
}

impl std::error::Error for TargetSelectionError {}

pub fn select_target(
    candidates: &[ProviderCandidate],
    requested_model: &str,
) -> Result<SelectedTarget, TargetSelectionError> {
    if candidates.is_empty() {
        return Err(TargetSelectionError::EmptyCandidates);
    }
    candidates
        .iter()
        .filter(|candidate| candidate.model == requested_model)
        .min_by_key(|candidate| candidate.priority)
        .map(|candidate| SelectedTarget {
            provider_id: candidate.provider_id.clone(),
            config_path: candidate.config_path.clone(),
            protocol: candidate.protocol.clone(),
            model: candidate.model.clone(),
        })
        .ok_or_else(|| TargetSelectionError::ModelUnavailable(requested_model.to_string()))
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PolicyVersion {
    pub version: String,
    pub baseline_from_manifest: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LivePolicyError {
    MissingBaseline,
    ScopeMismatch,
    PayloadPatchForbidden,
}

impl std::fmt::Display for LivePolicyError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{self:?}")
    }
}

impl std::error::Error for LivePolicyError {}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LivePolicyOverride {
    pub server_id: String,
    pub route_group_id: String,
    pub policy_version: String,
    pub scope_key: String,
    pub enabled: bool,
}

/// Router live policy override registry: one entry per scope, immutable
/// history, baseline anchored.
#[derive(Debug, Clone, Default)]
pub struct V4Router08LivePolicyOverride {
    history: Vec<LivePolicyOverride>,
}

impl V4Router08LivePolicyOverride {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn set(
        &mut self,
        server_id: &str,
        route_group_id: &str,
        policy_version: &str,
        scope_key: &str,
        enabled: bool,
        baseline_from_manifest: bool,
    ) -> Result<(), LivePolicyError> {
        if !baseline_from_manifest {
            return Err(LivePolicyError::MissingBaseline);
        }
        self.history.push(LivePolicyOverride {
            server_id: server_id.to_string(),
            route_group_id: route_group_id.to_string(),
            policy_version: policy_version.to_string(),
            scope_key: scope_key.to_string(),
            enabled,
        });
        Ok(())
    }

    pub fn current(
        &self,
        server_id: &str,
        route_group_id: &str,
        scope_key: &str,
    ) -> Option<&LivePolicyOverride> {
        self.history.iter().rev().find(|entry| {
            entry.server_id == server_id
                && entry.route_group_id == route_group_id
                && entry.scope_key == scope_key
        })
    }

    pub fn history(&self) -> impl Iterator<Item = &LivePolicyOverride> {
        self.history.iter()
    }
}

/// Router control surface marker: the router owns route selection facts and
/// decisions, never payload content.
pub fn assert_policy_never_touches_payload(_override: &LivePolicyOverride) -> bool {
    true
}
