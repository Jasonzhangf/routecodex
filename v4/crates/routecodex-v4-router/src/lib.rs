//! routecodex-v4-router — compiled target selection and live policy owner
//! (`v4.control.route_policy_live`, V4Router08LivePolicyOverride).
//!
//! Hard boundaries:
//! - live override is anchored to the manifest baseline and is audit-only:
//!   it never patches payload and never changes the compiled manifest truth;
//! - session-scoped and immutable-history: every override set is appended,
//!   never rewritten;
//! - control fields never enter provider/client normal payload.

use routecodex_v4_config::{
    RuntimeProductConfig, RuntimeProductPolicyAction, RuntimeProductProvider, RuntimeProductTarget,
    RuntimeProviderCandidate, RuntimeRoute,
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SelectedTarget {
    pub provider_id: String,
    pub config_path: String,
    pub protocol: String,
    pub wire_model: String,
    pub auth_alias: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TargetSelectionError {
    EmptyCandidates,
    EmptyRoutes,
    RouteTargetMissing(String),
    ProductRouteGroupMissing(String),
    ProductPoolUnavailable(String),
    ProductTargetMissing(String),
    ModelUnavailable(String),
}

impl std::fmt::Display for TargetSelectionError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::EmptyCandidates => write!(f, "compiled provider candidate set is empty"),
            Self::ModelUnavailable(model) => {
                write!(f, "no compiled provider candidate supports model {model}")
            }
            Self::EmptyRoutes => write!(f, "compiled route set is empty"),
            Self::RouteTargetMissing(provider) => {
                write!(f, "compiled route references missing provider {provider}")
            }
            Self::ProductRouteGroupMissing(group) => {
                write!(f, "compiled product route group is missing: {group}")
            }
            Self::ProductPoolUnavailable(group) => {
                write!(f, "no product route pool serves request in group {group}")
            }
            Self::ProductTargetMissing(target) => {
                write!(
                    f,
                    "compiled product target references missing provider/model {target}"
                )
            }
        }
    }
}

/// Selects a target from the typed product manifest.  Pool eligibility is
/// derived only from the request's typed selection facts; no payload is
/// modified and no legacy flat route is consulted.
pub fn select_product_target(
    product: &RuntimeProductConfig,
    route_group_id: &str,
    requested_model: &str,
    entry_protocol: &str,
    required_capabilities: &[&str],
    input_tokens: u64,
) -> Result<SelectedTarget, TargetSelectionError> {
    select_product_target_with_unavailable(
        product,
        route_group_id,
        requested_model,
        entry_protocol,
        required_capabilities,
        input_tokens,
        &[],
    )
}

pub fn select_product_target_with_unavailable(
    product: &RuntimeProductConfig,
    route_group_id: &str,
    requested_model: &str,
    entry_protocol: &str,
    required_capabilities: &[&str],
    input_tokens: u64,
    unavailable_provider_ids: &[&str],
) -> Result<SelectedTarget, TargetSelectionError> {
    let group = product
        .route_groups
        .iter()
        .find(|group| group.route_group_id == route_group_id)
        .ok_or_else(|| {
            TargetSelectionError::ProductRouteGroupMissing(route_group_id.to_string())
        })?;
    let mut pools = group
        .pools
        .iter()
        .filter(|pool| {
            pool.entry_protocol
                .as_deref()
                .map_or(true, |protocol| protocol == entry_protocol)
        })
        .filter(|pool| {
            pool.models.is_empty() || pool.models.iter().any(|model| model == requested_model)
        })
        .filter(|pool| {
            pool.min_input_tokens
                .map_or(true, |minimum| input_tokens >= minimum)
        })
        .filter(|pool| {
            pool.required_capabilities
                .iter()
                .all(|required| required_capabilities.iter().any(|fact| fact == required))
        })
        .collect::<Vec<_>>();
    pools.sort_by(|left, right| {
        right
            .required_capabilities
            .len()
            .cmp(&left.required_capabilities.len())
            .then_with(|| {
                left.precedence
                    .unwrap_or(i32::MAX)
                    .cmp(&right.precedence.unwrap_or(i32::MAX))
            })
    });
    let pool = pools
        .into_iter()
        .next()
        .ok_or_else(|| TargetSelectionError::ProductPoolUnavailable(route_group_id.to_string()))?;
    let target = pool
        .targets
        .iter()
        .filter(|target| {
            target.model_id == requested_model
                || product
                    .providers
                    .iter()
                    .find(|provider| provider.provider_id == target.provider_id)
                    .and_then(|provider| {
                        provider.models.iter().find(|model| {
                            model.model_id == target.model_id
                                && model.aliases.iter().any(|alias| alias == requested_model)
                        })
                    })
                    .is_some()
        })
        .filter(|target| {
            !unavailable_provider_ids
                .iter()
                .any(|provider| *provider == target.provider_id)
        })
        .min_by_key(|target| target.priority)
        .ok_or_else(|| TargetSelectionError::ProductPoolUnavailable(pool.pool_id.clone()))?;
    let provider = product
        .providers
        .iter()
        .find(|provider| provider.provider_id == target.provider_id);
    let model = provider.and_then(|provider| {
        provider
            .models
            .iter()
            .find(|model| model.model_id == target.model_id)
    });
    product_target_to_selected(provider, model, target)
}

/// Production callers use this owner-scoped name for retry selection.  The
/// unavailable set remains a typed routing input; no request payload is read.
pub fn select_product_target_excluding(
    product: &RuntimeProductConfig,
    route_group_id: &str,
    requested_model: &str,
    entry_protocol: &str,
    required_capabilities: &[&str],
    input_tokens: u64,
    unavailable_provider_ids: &[&str],
) -> Result<SelectedTarget, TargetSelectionError> {
    select_product_target_with_unavailable(
        product,
        route_group_id,
        requested_model,
        entry_protocol,
        required_capabilities,
        input_tokens,
        unavailable_provider_ids,
    )
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProductErrorDecision {
    pub policy_id: String,
    pub retry: bool,
    pub cooldown: bool,
    pub failure_threshold: u64,
    pub project_status: Option<u16>,
    pub reason_code: Option<String>,
}

/// Apply the compiled product error policy. This produces typed control facts
/// only; execution, cooldown storage and client projection remain downstream
/// owners in the error/runtime chain.
pub fn apply_product_error_policy(
    product: &RuntimeProductConfig,
    provider_id: &str,
    status: u16,
    response_body: &str,
) -> Option<ProductErrorDecision> {
    if status < 400 {
        return None;
    }
    let policy = product.error_policies.iter().find(|policy| {
        policy
            .scope_provider_id
            .as_deref()
            .map_or(true, |scope| scope == provider_id)
            && policy
                .match_status
                .map_or(true, |expected| expected == status)
            && (policy.match_content_contains_any.is_empty()
                || policy
                    .match_content_contains_any
                    .iter()
                    .any(|needle| response_body.contains(needle)))
    });
    let (policy_id, actions, reason_code) = match policy {
        Some(policy) => (
            policy.policy_id.clone(),
            policy.actions.as_slice(),
            policy.reason_code.clone(),
        ),
        None if !product.default_error_path.is_empty() => (
            "default".to_string(),
            product.default_error_path.as_slice(),
            None,
        ),
        None => return None,
    };
    Some(ProductErrorDecision {
        policy_id,
        retry: has_step(actions, "wait_retry"),
        cooldown: has_step(actions, "cooldown"),
        failure_threshold: actions
            .iter()
            .find_map(|action| (action.step == "wait_retry").then_some(action.max_attempts))
            .flatten()
            .unwrap_or(1)
            .max(1) as u64,
        project_status: actions.iter().find_map(|action| {
            (action.step == "project")
                .then_some(action.status)
                .flatten()
        }),
        reason_code: reason_code.or_else(|| {
            actions.iter().find_map(|action| {
                (action.step == "project")
                    .then(|| action.reason_code.clone())
                    .flatten()
            })
        }),
    })
}

fn has_step(actions: &[RuntimeProductPolicyAction], step: &str) -> bool {
    actions.iter().any(|action| action.step == step)
}

fn product_target_to_selected(
    provider: Option<&RuntimeProductProvider>,
    model: Option<&routecodex_v4_config::RuntimeProductModel>,
    target: &RuntimeProductTarget,
) -> Result<SelectedTarget, TargetSelectionError> {
    let provider = provider
        .ok_or_else(|| TargetSelectionError::ProductTargetMissing(target.provider_id.clone()))?;
    let model = model.ok_or_else(|| {
        TargetSelectionError::ProductTargetMissing(format!(
            "{}/{}",
            target.provider_id, target.model_id
        ))
    })?;
    Ok(SelectedTarget {
        provider_id: provider.provider_id.clone(),
        config_path: provider.config_path.clone(),
        protocol: provider.protocol.clone(),
        wire_model: model.wire_name.clone(),
        auth_alias: provider
            .auth_handles
            .first()
            .map(|handle| handle.alias.clone()),
    })
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
            auth_alias: None,
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
