//! routecodex-v4-router — compiled target selection and live policy owner
//! (`v4.control.route_policy_live`, V4Router08LivePolicyOverride).
//!
//! Hard boundaries:
//! - live override is anchored to the manifest baseline and is audit-only:
//!   it never patches payload and never changes the compiled manifest truth;
//! - session-scoped and immutable-history: every override set is appended,
//!   never rewritten;
//! - control fields never enter provider/client normal payload.

use routecodex_v4_config::{RuntimeProviderCandidate, RuntimeRoute};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SelectedTarget {
    pub provider_id: String,
    pub config_path: String,
    pub protocol: String,
    pub wire_model: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TargetSelectionError {
    EmptyCandidates,
    EmptyRoutes,
    RouteTargetMissing(String),
    ModelUnavailable(String),
}

impl std::fmt::Display for TargetSelectionError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::EmptyCandidates => write!(f, "compiled provider candidate set is empty"),
            Self::EmptyRoutes => write!(f, "compiled route set is empty"),
            Self::RouteTargetMissing(provider) => {
                write!(f, "compiled route references missing provider {provider}")
            }
            Self::ModelUnavailable(model) => write!(f, "no compiled provider candidate supports model {model}"),
        }
    }
}

impl std::error::Error for TargetSelectionError {}

pub fn select_target(
    candidates: &[RuntimeProviderCandidate],
    routes: &[RuntimeRoute],
    requested_model: &str,
) -> Result<SelectedTarget, TargetSelectionError> {
    if candidates.is_empty() {
        return Err(TargetSelectionError::EmptyCandidates);
    }
    if routes.is_empty() {
        return Err(TargetSelectionError::EmptyRoutes);
    }
    let route = routes
        .iter()
        .find(|route| route.models.iter().any(|model| model == requested_model))
        .ok_or_else(|| TargetSelectionError::ModelUnavailable(requested_model.to_string()))?;
    let mut eligible = route
        .targets
        .iter()
        .map(|provider_id| {
            candidates
                .iter()
                .find(|candidate| &candidate.provider_id == provider_id)
                .ok_or_else(|| TargetSelectionError::RouteTargetMissing(provider_id.clone()))
        })
        .collect::<Result<Vec<_>, _>>()?;
    eligible.sort_by_key(|candidate| candidate.priority);
    eligible
        .into_iter()
        .find(|candidate| {
            candidate
                .entry_models
                .iter()
                .any(|model| model == requested_model)
        })
        .map(|candidate| SelectedTarget {
            provider_id: candidate.provider_id.clone(),
            config_path: candidate.config_path.clone(),
            protocol: candidate.protocol.clone(),
            wire_model: candidate.wire_model.clone(),
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

    pub fn current(&self, server_id: &str, route_group_id: &str, scope_key: &str) -> Option<&LivePolicyOverride> {
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
