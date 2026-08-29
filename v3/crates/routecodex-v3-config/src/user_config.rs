// feature_id: v3.simplified_user_config
// Strict, user-facing config.toml syntax. This module owns only parsing and
// projection into V3Config02AuthoringParsed; Config03-05 remain the unique
// validation, registry, and Manifest compiler chain.

use crate::{
    compile_v3_config_05_manifest, provider_directory::V3Config02AuthoringResolved,
    store::build_v3_config_loaded_snapshot, store::source_closure_sha256, validation,
    V3Config02AuthoringParsed, V3Config05ManifestPublished, V3ConfigError, V3ConfigLoadedSnapshot,
    V3RoutePoolTargetAuthoringConfig, V3RouteTargetKind, V3SelectionPolicy, V3SelectionStrategy,
};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct V3UserConfig01FileSource {
    pub path: std::path::PathBuf,
    pub raw_toml: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct V3UserConfig02RoutingSelectionParsed {
    pub version: u16,
    pub route_groups: BTreeMap<String, BTreeMap<String, V3UserRoutePool>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct V3UserRoutePool {
    pub tiers: Vec<Vec<V3UserRouteMember>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct V3UserRouteMember {
    #[serde(rename = "use")]
    use_ref: String,
    #[serde(skip)]
    pub provider: String,
    #[serde(skip)]
    pub model: String,
    #[serde(default)]
    pub weight: Option<u32>,
}

#[derive(Debug, Clone)]
pub struct V3UserConfigStore {
    path: PathBuf,
    internal_authoring: V3Config02AuthoringParsed,
}

impl V3UserConfigStore {
    pub fn new(path: impl Into<PathBuf>) -> Self {
        Self {
            path: path.into(),
            internal_authoring: crate::internal::v3_internal_user_config_authoring(),
        }
    }

    pub fn with_internal_authoring(
        path: impl Into<PathBuf>,
        internal_authoring: V3Config02AuthoringParsed,
    ) -> Self {
        Self {
            path: path.into(),
            internal_authoring,
        }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn read_routing_selection(
        &self,
    ) -> Result<V3UserConfig02RoutingSelectionParsed, V3ConfigError> {
        let raw_toml = fs::read_to_string(&self.path)?;
        parse_v3_user_config_02_routing(&raw_toml)
    }

    pub fn read_authoring(&self) -> Result<V3Config02AuthoringParsed, V3ConfigError> {
        if !self.internal_authoring.providers.is_empty() {
            return Err(validation(
                "internal user-config authoring must not contain inline providers",
            ));
        }
        let user = self.read_routing_selection()?;
        Ok(self.project_routing_selection_with_sources(user)?.authoring)
    }

    pub fn project_routing_selection(
        &self,
        user: V3UserConfig02RoutingSelectionParsed,
    ) -> Result<V3Config02AuthoringParsed, V3ConfigError> {
        Ok(self.project_routing_selection_with_sources(user)?.authoring)
    }

    fn project_routing_selection_with_sources(
        &self,
        user: V3UserConfig02RoutingSelectionParsed,
    ) -> Result<V3Config02AuthoringResolved, V3ConfigError> {
        if !self.internal_authoring.providers.is_empty() {
            return Err(validation(
                "internal user-config authoring must not contain inline providers",
            ));
        }
        let referenced_models = collect_user_provider_models(&user);
        let config_dir = self.path.parent().ok_or_else(|| {
            validation(format!(
                "user config path {} has no parent directory",
                self.path.display()
            ))
        })?;
        let (providers, provider_sources) =
            crate::v2_compat::compile_v2_provider_directory(config_dir, &referenced_models)?;
        for (provider_id, provider) in &providers {
            if !provider.enabled {
                return Err(validation(format!(
                    "user config references disabled provider {provider_id:?}"
                )));
            }
        }
        let catalogue = providers
            .iter()
            .map(|(provider_id, provider)| {
                (
                    provider_id.clone(),
                    provider.models.keys().cloned().collect::<BTreeSet<_>>(),
                )
            })
            .collect();
        let mut authoring =
            project_v3_user_config_03_authoring(user, self.internal_authoring.clone(), &catalogue)?;
        if let Some(log_file) = authoring.debug.log_file.as_deref() {
            let log_file = Path::new(log_file);
            if log_file.is_relative() {
                authoring.debug.log_file = Some(config_dir.join(log_file).display().to_string());
            }
        }
        authoring.providers = providers;
        Ok(V3Config02AuthoringResolved {
            authoring,
            provider_sources,
        })
    }

    pub fn validate_routing_selection(
        &self,
        user: V3UserConfig02RoutingSelectionParsed,
    ) -> Result<V3Config05ManifestPublished, V3ConfigError> {
        compile_v3_config_05_manifest(self.project_routing_selection(user)?)
    }

    pub fn load_manifest(&self) -> Result<V3Config05ManifestPublished, V3ConfigError> {
        Ok(self.load_snapshot_with_source_identity()?.manifest)
    }

    pub fn load_snapshot_with_source_identity(
        &self,
    ) -> Result<V3ConfigLoadedSnapshot, V3ConfigError> {
        let raw_toml = fs::read_to_string(&self.path)?;
        let canonical_path = fs::canonicalize(&self.path)?;
        let user = parse_v3_user_config_02_routing(&raw_toml)?;
        let resolved = self.project_routing_selection_with_sources(user)?;
        let source_sha256 =
            source_closure_sha256(&canonical_path, &raw_toml, &resolved.provider_sources);
        build_v3_config_loaded_snapshot(canonical_path, source_sha256, resolved.authoring)
    }
}

impl V3UserRouteMember {
    pub fn new(provider: impl Into<String>, model: impl Into<String>, weight: Option<u32>) -> Self {
        let provider = provider.into();
        let model = model.into();
        Self {
            use_ref: format!("{provider}/{model}"),
            provider,
            model,
            weight,
        }
    }

    pub fn use_ref(&self) -> &str {
        &self.use_ref
    }
}

pub fn generate_v3_user_config_02_routing(
    config: &V3UserConfig02RoutingSelectionParsed,
) -> Result<String, V3ConfigError> {
    let serialized = toml::to_string_pretty(config)?;
    parse_v3_user_config_02_routing(&serialized)?;
    Ok(serialized)
}

pub fn parse_v3_user_config_02_routing(
    raw: &str,
) -> Result<V3UserConfig02RoutingSelectionParsed, V3ConfigError> {
    validate_v3_user_config_02_routing(toml::from_str(raw)?)
}

fn validate_v3_user_config_02_routing(
    mut parsed: V3UserConfig02RoutingSelectionParsed,
) -> Result<V3UserConfig02RoutingSelectionParsed, V3ConfigError> {
    if parsed.version != 3 {
        return Err(validation("user config version must be 3"));
    }
    if parsed.route_groups.is_empty() {
        return Err(validation("user config route_groups must not be empty"));
    }

    for (group_id, pools) in &mut parsed.route_groups {
        if group_id.trim().is_empty() {
            return Err(validation("user config route group id must not be empty"));
        }
        if !pools.contains_key("default") {
            return Err(validation(format!(
                "user config route group {group_id:?} must declare default pool"
            )));
        }
        for (pool_id, pool) in pools {
            validate_pool(group_id, pool_id, pool)?;
        }
    }
    Ok(parsed)
}

pub fn project_v3_user_config_03_authoring(
    user: V3UserConfig02RoutingSelectionParsed,
    mut internal: V3Config02AuthoringParsed,
    provider_catalogue: &BTreeMap<String, BTreeSet<String>>,
) -> Result<V3Config02AuthoringParsed, V3ConfigError> {
    let user = validate_v3_user_config_02_routing(user)?;
    let mut projected_targets = BTreeMap::new();
    let declared_groups = user.route_groups.keys().cloned().collect::<BTreeSet<_>>();
    for group_id in &declared_groups {
        if !internal.route_groups.contains_key(group_id) {
            return Err(validation(format!(
                "user config references unknown route group {group_id:?}"
            )));
        }
    }
    for server in internal.servers.values() {
        if !declared_groups.contains(&server.routing_group) {
            return Err(validation(format!(
                "user config must declare internally enabled route group {:?}",
                server.routing_group
            )));
        }
    }

    for (group_id, user_pools) in user.route_groups {
        let internal_group = internal.route_groups.get(&group_id).ok_or_else(|| {
            validation(format!(
                "user config references unknown route group {group_id:?}"
            ))
        })?;

        for (pool_id, user_pool) in user_pools {
            if !internal_group.pools.contains_key(&pool_id) {
                return Err(validation(format!(
                    "user config references unknown route pool {group_id}.{pool_id}"
                )));
            }

            let targets = compile_pool_targets(user_pool, provider_catalogue)?;
            projected_targets.insert((group_id.clone(), pool_id), targets);
        }

        let default_targets = projected_targets
            .get(&(group_id.clone(), "default".to_string()))
            .expect("parser requires each route group to declare default")
            .clone();
        for pool_id in internal_group.pools.keys() {
            projected_targets
                .entry((group_id.clone(), pool_id.clone()))
                .or_insert_with(|| default_targets.clone());
        }
    }

    for ((group_id, pool_id), targets) in projected_targets {
        let pool = internal
            .route_groups
            .get_mut(&group_id)
            .and_then(|group| group.pools.get_mut(&pool_id))
            .expect("validated route group and pool must remain present");
        pool.selection = V3SelectionPolicy {
            strategy: V3SelectionStrategy::Priority,
        };
        pool.targets = targets;
    }

    Ok(internal)
}

fn compile_pool_targets(
    user_pool: V3UserRoutePool,
    provider_catalogue: &BTreeMap<String, BTreeSet<String>>,
) -> Result<Vec<V3RoutePoolTargetAuthoringConfig>, V3ConfigError> {
    let tier_count = i32::try_from(user_pool.tiers.len())
        .map_err(|_| validation("user config contains too many route tiers"))?;
    let mut targets = Vec::new();
    for (tier_index, tier) in user_pool.tiers.into_iter().enumerate() {
        let priority = tier_count
            - i32::try_from(tier_index)
                .map_err(|_| validation("user config contains too many route tiers"))?;
        let equal_weight = tier.len() > 1 && tier[0].weight.is_none();

        for member in tier {
            let known_models = provider_catalogue.get(&member.provider).ok_or_else(|| {
                validation(format!(
                    "user config references unknown provider/model {}/{}",
                    member.provider, member.model
                ))
            })?;
            if !known_models.contains(&member.model) {
                return Err(validation(format!(
                    "user config references unknown provider/model {}/{}",
                    member.provider, member.model
                )));
            }

            targets.push(V3RoutePoolTargetAuthoringConfig {
                kind: V3RouteTargetKind::ProviderModel,
                id: None,
                provider: Some(member.provider),
                model: Some(member.model),
                key: None,
                priority: Some(priority),
                weight: member.weight.or(equal_weight.then_some(1)),
            });
        }
    }
    Ok(targets)
}

fn collect_user_provider_models(
    user: &V3UserConfig02RoutingSelectionParsed,
) -> BTreeMap<String, BTreeSet<String>> {
    let mut referenced = BTreeMap::<String, BTreeSet<String>>::new();
    for pools in user.route_groups.values() {
        for pool in pools.values() {
            for tier in &pool.tiers {
                for member in tier {
                    referenced
                        .entry(member.provider.clone())
                        .or_default()
                        .insert(member.model.clone());
                }
            }
        }
    }
    referenced
}

fn validate_pool(
    group_id: &str,
    pool_id: &str,
    pool: &mut V3UserRoutePool,
) -> Result<(), V3ConfigError> {
    if pool_id.trim().is_empty() {
        return Err(validation(format!(
            "user config route group {group_id:?} contains an empty pool id"
        )));
    }
    if pool.tiers.is_empty() {
        return Err(validation(format!(
            "user config pool {group_id}.{pool_id} must contain at least one tier"
        )));
    }

    let mut pool_members = BTreeSet::new();
    for (tier_index, tier) in pool.tiers.iter_mut().enumerate() {
        if tier.is_empty() {
            return Err(validation(format!(
                "user config pool {group_id}.{pool_id} tier {} must not be empty",
                tier_index + 1
            )));
        }
        let has_explicit_weight = tier.iter().any(|member| member.weight.is_some());
        let has_implicit_weight = tier.iter().any(|member| member.weight.is_none());
        if tier.len() > 1 && has_explicit_weight && has_implicit_weight {
            return Err(validation(format!(
                "user config pool {group_id}.{pool_id} tier {} must either set every weight or omit every weight",
                tier_index + 1
            )));
        }

        for member in tier {
            if matches!(member.weight, Some(0)) {
                return Err(validation(format!(
                    "user config pool {group_id}.{pool_id} weights must be positive"
                )));
            }
            let (provider, model) = parse_provider_model_ref(&member.use_ref).map_err(|message| {
                validation(format!(
                    "user config pool {group_id}.{pool_id} has invalid use reference {:?}: {message}",
                    member.use_ref
                ))
            })?;
            member.provider = provider.to_string();
            member.model = model.to_string();
            if !pool_members.insert((member.provider.clone(), member.model.clone())) {
                return Err(validation(format!(
                    "user config pool {group_id}.{pool_id} repeats provider/model {}/{}",
                    member.provider, member.model
                )));
            }
        }
    }
    Ok(())
}

fn parse_provider_model_ref(value: &str) -> Result<(&str, &str), &'static str> {
    if value.trim() != value {
        return Err("leading or trailing whitespace is not allowed");
    }
    let Some((provider, model)) = value.split_once('/') else {
        return Err("expected <provider-id>/<model-id>");
    };
    if provider.is_empty() || model.is_empty() {
        return Err("provider id and model id must both be non-empty");
    }
    Ok((provider, model))
}
