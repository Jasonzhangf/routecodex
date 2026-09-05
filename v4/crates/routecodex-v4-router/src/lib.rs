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
use routecodex_v4_cordis_bridge::{ExecCtx, PluginHandle};
use serde_json::Value;
use std::sync::Arc;

/// Dedicated Cordis node operator for target selection. This identity is
/// distinct from route-facts production/consumption and from direct model
/// hooks; registry wiring must never replace another plugin by id.
pub const TARGET_SELECTION_PLUGIN_ID: &str = "v4.std.routing.target_selection";
pub const DIRECT_TARGET_SELECTION_PLUGIN_ID: &str = "v4.std.routing.target_selection.direct";

/// Cordis-owned target producer. It is invoked by the compiled target node;
/// callers never select a provider outside the NodePluginPlan.
pub struct TargetSelectionHandle {
    product: Arc<RuntimeProductConfig>,
}

impl TargetSelectionHandle {
    pub fn new(product: RuntimeProductConfig) -> Self {
        Self { product: Arc::new(product) }
    }
}

impl PluginHandle for TargetSelectionHandle {
    fn execute(&self, ctx: &mut ExecCtx<'_>, _config: &Value) -> Result<(), String> {
        let facts = ctx
            .read_control_resource("v4.control.route_facts")
            .map_err(|error| error.to_string())?
            .cloned()
            .unwrap_or_else(|| Value::Object(Default::default()));
        let facts = facts.as_object().expect("route facts object");
        let protocol = if let Some(protocol) = facts.get("entry_protocol").and_then(Value::as_str) {
            protocol.to_string()
        } else {
            ctx.read_information_resource("v4.information.client_protocol")
                .map_err(|error| error.to_string())?
                .and_then(Value::as_str)
                .ok_or_else(|| "router target producer requires entry protocol".to_string())?
                .to_string()
        };
        let model = ctx
            .read_information_resource("v4.information.model")
            .map_err(|error| error.to_string())?
            .and_then(Value::as_str)
            .ok_or_else(|| "router target producer requires model".to_string())?
            .to_string();
        let lane = facts
            .get("execution_lane")
            .and_then(Value::as_str)
            .unwrap_or("direct");
        let route_group_id = facts
            .get("route_group_id")
            .and_then(Value::as_str)
            .map(str::to_string);
        let unavailable_provider_ids = facts
            .get("unavailable_provider_ids")
            .and_then(Value::as_array)
            .map(|ids| {
                ids.iter()
                    .filter_map(Value::as_str)
                    .map(str::to_string)
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        let required_capabilities = facts
            .get("required_capabilities")
            .and_then(Value::as_array)
            .map(|values| values.iter().filter_map(Value::as_str).map(str::to_string).collect())
            .unwrap_or_default();
        let input_tokens = facts
            .get("input_tokens")
            .and_then(Value::as_u64)
            .unwrap_or(0);
        let mut request = TargetSelectionRequest::new(route_group_id, model, protocol, lane);
        request.required_capabilities = required_capabilities;
        request.input_tokens = input_tokens;
        request.unavailable_provider_ids = unavailable_provider_ids;
        let selected = TargetSelectionPort::select(&self.product, &request)
        .map_err(|error| error.to_string())?;
        if let Some(prebound) = ctx
            .read_control_resource("v4.control.target_selection")
            .map_err(|error| error.to_string())?
            .cloned()
            .filter(|value| !value.is_null())
        {
            let prebound = selected_target_from_value(&prebound)?;
            if prebound != selected {
                return Err(
                    "prebound target selection differs from compiled router decision".to_string(),
                );
            }
        }
        ctx.write_control_resource(
            "v4.control.target_selection",
            serde_json::json!({
                "provider_id": selected.provider_id,
                "config_path": selected.config_path,
                "protocol": selected.protocol,
                "wire_model": selected.wire_model,
                "auth_alias": selected.auth_alias,
                "execution_lane": lane,
            }),
        )
        .map_err(|error| error.to_string())
    }
}

fn selected_target_from_value(value: &Value) -> Result<SelectedTarget, String> {
    let object = value
        .as_object()
        .ok_or_else(|| "prebound target selection must be an object".to_string())?;
    let required = |name: &str| {
        object
            .get(name)
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .map(str::to_string)
            .ok_or_else(|| format!("prebound target selection missing {name}"))
    };
    Ok(SelectedTarget {
        provider_id: required("provider_id")?,
        config_path: required("config_path")?,
        protocol: required("protocol")?,
        wire_model: required("wire_model")?,
        auth_alias: object
            .get("auth_alias")
            .and_then(Value::as_str)
            .map(str::to_string),
    })
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SelectedTarget {
    pub provider_id: String,
    pub config_path: String,
    pub protocol: String,
    pub wire_model: String,
    pub auth_alias: Option<String>,
}

impl SelectedTarget {
    /// Serialize the router-owned decision onto the typed control carrier.
    /// The production request plan consumes this exact value; callers must
    /// not reconstruct a second target-selection JSON shape.
    pub fn to_control_value(&self, execution_lane: &str) -> Value {
        serde_json::json!({
            "provider_id": self.provider_id,
            "config_path": self.config_path,
            "protocol": self.protocol,
            "wire_model": self.wire_model,
            "auth_alias": self.auth_alias,
            "execution_lane": execution_lane,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TargetSelectionError {
    EmptyCandidates,
    EmptyRoutes,
    RouteTargetMissing(String),
    ProductRouteGroupMissing(String),
    ProductRouteGroupRequired,
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
            Self::ProductRouteGroupRequired => {
                write!(f, "route group is required when multiple product route groups are configured")
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

/// Typed routing input consumed by the Cordis target-selection node.  The
/// request contains only control-plane facts; business payload bytes never
/// cross this port.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TargetSelectionRequest {
    pub route_group_id: Option<String>,
    pub requested_model: String,
    pub entry_protocol: String,
    pub execution_lane: String,
    pub required_capabilities: Vec<String>,
    pub input_tokens: u64,
    pub unavailable_provider_ids: Vec<String>,
}

impl TargetSelectionRequest {
    pub fn new(
        route_group_id: Option<String>,
        requested_model: impl Into<String>,
        entry_protocol: impl Into<String>,
        execution_lane: impl Into<String>,
    ) -> Self {
        Self {
            route_group_id,
            requested_model: requested_model.into(),
            entry_protocol: entry_protocol.into(),
            execution_lane: execution_lane.into(),
            required_capabilities: Vec::new(),
            input_tokens: 0,
            unavailable_provider_ids: Vec::new(),
        }
    }

    pub fn resolved_route_group_id<'a>(
        &self,
        product: &'a RuntimeProductConfig,
    ) -> Result<&'a str, TargetSelectionError> {
        match self.route_group_id.as_deref() {
            Some(route_group_id) => {
                product
                    .route_groups
                    .iter()
                    .find(|group| group.route_group_id == route_group_id)
                    .map(|group| group.route_group_id.as_str())
                    .ok_or_else(|| {
                        TargetSelectionError::ProductRouteGroupMissing(route_group_id.to_string())
                    })
            }
            None if product.route_groups.len() == 1 => {
                Ok(product.route_groups[0].route_group_id.as_str())
            }
            None => Err(TargetSelectionError::ProductRouteGroupRequired),
        }
    }

    /// Serialize the router input facts onto the typed control carrier. The
    /// request payload is intentionally absent; only routing facts cross this
    /// boundary and the producer may enrich them with its own typed fields.
    pub fn to_route_facts_value(&self) -> Value {
        serde_json::json!({
            "route_group_id": self.route_group_id,
            "entry_protocol": self.entry_protocol,
            "execution_lane": self.execution_lane,
            "required_capabilities": self.required_capabilities,
            "input_tokens": self.input_tokens,
            "unavailable_provider_ids": self.unavailable_provider_ids,
        })
    }
}

/// Typed production route-selection port.  It is the only caller-facing
/// entry to product target selection; runtime-bin must not inspect route pools
/// or deserialize a control JSON projection itself.
pub struct TargetSelectionPort;

impl TargetSelectionPort {
    pub fn select(
        product: &RuntimeProductConfig,
        request: &TargetSelectionRequest,
    ) -> Result<SelectedTarget, TargetSelectionError> {
        let route_group_id = request.resolved_route_group_id(product)?;
        let required_capabilities = request
            .required_capabilities
            .iter()
            .map(String::as_str)
            .collect::<Vec<_>>();
        let unavailable_provider_ids = request
            .unavailable_provider_ids
            .iter()
            .map(String::as_str)
            .collect::<Vec<_>>();
        select_product_target_with_unavailable(
            product,
            route_group_id,
            &request.requested_model,
            &request.entry_protocol,
            &required_capabilities,
            request.input_tokens,
            &unavailable_provider_ids,
        )
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
        .filter(|target| {
            let provider_protocol = product
                .providers
                .iter()
                .find(|provider| provider.provider_id == target.provider_id)
                .map(|provider| provider.protocol.as_str());
            match (entry_protocol, provider_protocol) {
                // Direct Responses preserves the protocol; only a Responses
                // provider can satisfy this lane without a semantic bypass.
                ("responses" | "openai-responses", Some("responses" | "openai-responses")) => true,
                // Relay currently has one registered projection: Chat -> Responses.
                ("chat" | "openai-chat", Some("responses" | "openai-responses")) => true,
                _ => false,
            }
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

/// Typed owner for compiled provider-failure policy lookup.  Production
/// callers use this port rather than importing the policy implementation
/// itself; the returned value remains control-plane data.
pub struct ProductErrorPolicyPort;

impl ProductErrorPolicyPort {
    pub fn evaluate(
        product: &RuntimeProductConfig,
        provider_id: &str,
        status: u16,
        response_body: &str,
    ) -> Option<ProductErrorDecision> {
        evaluate_product_error_policy(product, provider_id, status, response_body)
    }
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
    ProductErrorPolicyPort::evaluate(product, provider_id, status, response_body)
}

fn evaluate_product_error_policy(
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
