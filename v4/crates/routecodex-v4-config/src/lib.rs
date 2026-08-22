use std::collections::{BTreeMap, BTreeSet};

use routecodex_v4_base_node::{BaseNode, NodeIdentity};
use routecodex_v4_edge::{
    validate_edge, Axis, EdgeError, EdgeSpec, NodeRef, ResourceRef, ScopeRegistry,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs;
use std::path::{Path, PathBuf};

pub mod v2;

pub const CONFIG_CHAIN_VERSION: &str = "v4-config-1";

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ConfigError {
    #[error("config parse failed: {0}")]
    Parse(String),
    #[error("manifest version must be non-zero")]
    InvalidManifestVersion,
    #[error("duplicate config identifier")]
    DuplicateIdentifier,
    #[error("config node reference is not declared")]
    UnknownNode,
    #[error("config operator reference is not declared")]
    UnknownOperator,
    #[error("config plugin reference is not declared")]
    UnknownPlugin,
    #[error("operator and node plugin bindings differ")]
    OperatorPluginMismatch,
    #[error("config hook reference is not declared")]
    UnknownHook,
    #[error("config resource reference is not declared")]
    UnknownResource,
    #[error("config information edge must be adjacent")]
    NonAdjacentEdge,
    #[error("config information edge requires information-axis resources")]
    ResourceAxisMismatch,
    #[error("business payload resources cannot be bound into config compilation")]
    PayloadBindingForbidden,
    #[error("secret material is forbidden; use an env or token-file handle")]
    SecretMaterialForbidden,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AuthoringParsed {
    version: u32,
    nodes: Vec<NodeAuthoring>,
    edges: Vec<EdgeAuthoring>,
    operators: Vec<OperatorAuthoring>,
    plugins: Vec<PluginAuthoring>,
    hooks: Vec<HookAuthoring>,
    resources: Vec<ResourceAuthoring>,
    #[serde(default)]
    auth_handles: Vec<AuthHandleAuthoring>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct NodeAuthoring {
    node_id: String,
    operator_id: String,
    plugin_id: String,
    #[serde(default)]
    entry_hooks: Vec<String>,
    #[serde(default)]
    exit_hooks: Vec<String>,
    #[serde(default)]
    resources_read: Vec<String>,
    #[serde(default)]
    resources_written: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct EdgeAuthoring {
    edge_id: String,
    from: String,
    to: String,
    resource_id: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct OperatorAuthoring {
    operator_id: String,
    plugin_id: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct PluginAuthoring {
    plugin_id: String,
    action: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HookKind {
    Entry,
    Exit,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct HookAuthoring {
    hook_id: String,
    kind: HookKind,
    owner: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ResourceAxis {
    Information,
    Control,
    Data,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct ResourceAuthoring {
    resource_id: String,
    axis: ResourceAxis,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct AuthHandleAuthoring {
    provider_id: String,
    alias: String,
    source: String,
}

#[derive(Debug, Clone)]
pub struct SchemaValidated {
    authoring: AuthoringParsed,
    node_positions: BTreeMap<String, u32>,
}

#[derive(Debug, Clone)]
pub struct ResourceRegistryBuilt {
    validated: SchemaValidated,
    resources: BTreeMap<String, ResourceAxis>,
}

#[derive(Debug, Clone)]
pub struct V4Config01AuthoringFileSource {
    base: BaseNode,
    source_id: String,
    raw: String,
}

impl V4Config01AuthoringFileSource {
    pub fn new(source_id: &str, raw: &str) -> Self {
        Self {
            base: config_node("V4Config01AuthoringFileSource", 1),
            source_id: source_id.to_string(),
            raw: raw.to_string(),
        }
    }

    pub fn base(&self) -> &BaseNode {
        &self.base
    }

    pub fn source_id(&self) -> &str {
        &self.source_id
    }
}

#[derive(Debug, Clone)]
pub struct V4Config02AuthoringParsed {
    base: BaseNode,
    authoring: AuthoringParsed,
}

impl V4Config02AuthoringParsed {
    pub fn base(&self) -> &BaseNode {
        &self.base
    }
}

#[derive(Debug, Clone)]
pub struct V4Config03SchemaValidated {
    base: BaseNode,
    validated: SchemaValidated,
}

impl V4Config03SchemaValidated {
    pub fn base(&self) -> &BaseNode {
        &self.base
    }
}

#[derive(Debug, Clone)]
pub struct V4Config04ResourceRegistryBuilt {
    base: BaseNode,
    registry: ResourceRegistryBuilt,
}

impl V4Config04ResourceRegistryBuilt {
    pub fn base(&self) -> &BaseNode {
        &self.base
    }
}

#[derive(Debug, Clone)]
pub struct V4Config05ManifestPublished {
    base: BaseNode,
    manifest: ConfigManifest,
}

impl V4Config05ManifestPublished {
    pub fn base(&self) -> &BaseNode {
        &self.base
    }

    pub fn manifest(&self) -> &ConfigManifest {
        &self.manifest
    }

    pub fn into_manifest(self) -> ConfigManifest {
        self.manifest
    }
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub struct ManifestNode {
    pub node_id: String,
    pub position: u32,
    pub operator_id: String,
    pub plugin_id: String,
    pub entry_hooks: Vec<String>,
    pub exit_hooks: Vec<String>,
    pub resources_read: Vec<String>,
    pub resources_written: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub struct ManifestEdge {
    pub edge_id: String,
    pub from: String,
    pub to: String,
    pub resource_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub struct ManifestOperator {
    pub operator_id: String,
    pub plugin_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub struct ManifestPlugin {
    pub plugin_id: String,
    pub action: String,
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub struct ManifestHook {
    pub hook_id: String,
    pub kind: HookKind,
    pub owner: String,
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub struct ManifestResource {
    pub resource_id: String,
    pub axis: ResourceAxis,
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub struct AuthHandle {
    pub provider_id: String,
    pub alias: String,
    pub source: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConfigManifest {
    manifest_version: u32,
    chain_version: &'static str,
    nodes: Vec<ManifestNode>,
    edges: Vec<ManifestEdge>,
    operators: Vec<ManifestOperator>,
    plugins: Vec<ManifestPlugin>,
    hooks: Vec<ManifestHook>,
    resources: Vec<ManifestResource>,
    auth_handles: Vec<AuthHandle>,
    hash: String,
}

impl ConfigManifest {
    pub fn manifest_version(&self) -> u32 {
        self.manifest_version
    }

    pub fn chain_version(&self) -> &str {
        self.chain_version
    }

    pub fn nodes(&self) -> &[ManifestNode] {
        &self.nodes
    }

    pub fn edges(&self) -> &[ManifestEdge] {
        &self.edges
    }

    pub fn operators(&self) -> &[ManifestOperator] {
        &self.operators
    }

    pub fn plugins(&self) -> &[ManifestPlugin] {
        &self.plugins
    }

    pub fn hooks(&self) -> &[ManifestHook] {
        &self.hooks
    }

    pub fn resources(&self) -> &[ManifestResource] {
        &self.resources
    }

    pub fn auth_handles(&self) -> &[AuthHandle] {
        &self.auth_handles
    }

    pub fn hash(&self) -> &str {
        &self.hash
    }

    pub fn to_canonical_string(&self) -> String {
        format!("{}\nhash={}", self.canonical_body(), self.hash)
    }

    fn canonical_body(&self) -> String {
        let mut lines = vec![
            format!("manifest_version={}", self.manifest_version),
            format!("chain_version={}", self.chain_version),
        ];
        for node in &self.nodes {
            lines.push(format!(
                "node|{}|{}|{}|{}|{}|{}|{}|{}",
                node.position,
                node.node_id,
                node.operator_id,
                node.plugin_id,
                node.entry_hooks.join(","),
                node.exit_hooks.join(","),
                node.resources_read.join(","),
                node.resources_written.join(",")
            ));
        }
        for edge in &self.edges {
            lines.push(format!(
                "edge|{}|{}|{}|{}",
                edge.edge_id, edge.from, edge.to, edge.resource_id
            ));
        }
        for operator in &self.operators {
            lines.push(format!(
                "operator|{}|{}",
                operator.operator_id, operator.plugin_id
            ));
        }
        for plugin in &self.plugins {
            lines.push(format!("plugin|{}|{}", plugin.plugin_id, plugin.action));
        }
        for hook in &self.hooks {
            lines.push(format!(
                "hook|{}|{:?}|{}",
                hook.hook_id, hook.kind, hook.owner
            ));
        }
        for resource in &self.resources {
            lines.push(format!(
                "resource|{}|{:?}",
                resource.resource_id, resource.axis
            ));
        }
        for handle in &self.auth_handles {
            lines.push(format!(
                "auth_handle|{}|{}|{}",
                handle.provider_id, handle.alias, handle.source
            ));
        }
        lines.join("\n")
    }
}

pub fn parse_v4_config_02_from_v4_config_01(
    source: V4Config01AuthoringFileSource,
) -> Result<V4Config02AuthoringParsed, ConfigError> {
    let authoring =
        toml::from_str(&source.raw).map_err(|error| ConfigError::Parse(error.to_string()))?;
    Ok(V4Config02AuthoringParsed {
        base: config_node("V4Config02AuthoringParsed", 2),
        authoring,
    })
}

pub fn validate_v4_config_03_from_v4_config_02(
    parsed: V4Config02AuthoringParsed,
) -> Result<V4Config03SchemaValidated, ConfigError> {
    let validated = validate_authoring(parsed.authoring)?;
    Ok(V4Config03SchemaValidated {
        base: config_node("V4Config03SchemaValidated", 3),
        validated,
    })
}

fn validate_authoring(authoring: AuthoringParsed) -> Result<SchemaValidated, ConfigError> {
    if authoring.version == 0 {
        return Err(ConfigError::InvalidManifestVersion);
    }

    let node_positions = unique_positions(&authoring.nodes)?;
    let operators = unique_map(
        authoring
            .operators
            .iter()
            .map(|operator| (operator.operator_id.clone(), operator.plugin_id.clone())),
    )?;
    let plugins = unique_set(
        authoring
            .plugins
            .iter()
            .map(|plugin| plugin.plugin_id.clone()),
    )?;
    let hooks = unique_map(
        authoring
            .hooks
            .iter()
            .map(|hook| (hook.hook_id.clone(), hook.kind)),
    )?;
    let resources = unique_map(
        authoring
            .resources
            .iter()
            .map(|resource| (resource.resource_id.clone(), resource.axis)),
    )?;
    let _edges = unique_set(authoring.edges.iter().map(|edge| edge.edge_id.clone()))?;
    let _auth_handles = unique_set(
        authoring
            .auth_handles
            .iter()
            .map(|handle| (handle.provider_id.clone(), handle.alias.clone())),
    )?;

    for operator in &authoring.operators {
        if !plugins.contains(operator.plugin_id.as_str()) {
            return Err(ConfigError::UnknownPlugin);
        }
    }

    for node in &authoring.nodes {
        let operator_plugin = operators
            .get(node.operator_id.as_str())
            .ok_or(ConfigError::UnknownOperator)?;
        if !plugins.contains(node.plugin_id.as_str()) {
            return Err(ConfigError::UnknownPlugin);
        }
        if *operator_plugin != node.plugin_id.as_str() {
            return Err(ConfigError::OperatorPluginMismatch);
        }
        for hook_id in &node.entry_hooks {
            if hooks.get(hook_id.as_str()) != Some(&HookKind::Entry) {
                return Err(ConfigError::UnknownHook);
            }
        }
        for hook_id in &node.exit_hooks {
            if hooks.get(hook_id.as_str()) != Some(&HookKind::Exit) {
                return Err(ConfigError::UnknownHook);
            }
        }
        for resource_id in node.resources_read.iter().chain(&node.resources_written) {
            let axis = resources
                .get(resource_id.as_str())
                .ok_or(ConfigError::UnknownResource)?;
            reject_payload_binding(resource_id, *axis)?;
        }
    }

    validate_edges(&authoring, &node_positions, &resources)?;

    for handle in &authoring.auth_handles {
        if !is_secret_handle(&handle.source) {
            return Err(ConfigError::SecretMaterialForbidden);
        }
    }

    Ok(SchemaValidated {
        authoring,
        node_positions,
    })
}

pub fn build_v4_config_04_from_v4_config_03(
    stage: V4Config03SchemaValidated,
) -> Result<V4Config04ResourceRegistryBuilt, ConfigError> {
    let registry = build_resource_registry(stage.validated)?;
    Ok(V4Config04ResourceRegistryBuilt {
        base: config_node("V4Config04ResourceRegistryBuilt", 4),
        registry,
    })
}

fn build_resource_registry(
    validated: SchemaValidated,
) -> Result<ResourceRegistryBuilt, ConfigError> {
    let resources = validated
        .authoring
        .resources
        .iter()
        .map(|resource| (resource.resource_id.clone(), resource.axis))
        .collect();
    Ok(ResourceRegistryBuilt {
        validated,
        resources,
    })
}

pub fn publish_v4_config_05_from_v4_config_04(
    stage: V4Config04ResourceRegistryBuilt,
) -> Result<V4Config05ManifestPublished, ConfigError> {
    let manifest = publish_manifest(stage.registry)?;
    Ok(V4Config05ManifestPublished {
        base: config_node("V4Config05ManifestPublished", 5),
        manifest,
    })
}

fn publish_manifest(registry: ResourceRegistryBuilt) -> Result<ConfigManifest, ConfigError> {
    let ResourceRegistryBuilt {
        validated,
        resources,
    } = registry;
    let AuthoringParsed {
        version,
        nodes,
        edges,
        operators,
        plugins,
        hooks,
        resources: _,
        auth_handles,
    } = validated.authoring;

    let mut manifest = ConfigManifest {
        manifest_version: version,
        chain_version: CONFIG_CHAIN_VERSION,
        nodes: nodes
            .into_iter()
            .map(|node| ManifestNode {
                position: validated.node_positions[&node.node_id],
                node_id: node.node_id,
                operator_id: node.operator_id,
                plugin_id: node.plugin_id,
                entry_hooks: sorted(node.entry_hooks),
                exit_hooks: sorted(node.exit_hooks),
                resources_read: sorted(node.resources_read),
                resources_written: sorted(node.resources_written),
            })
            .collect(),
        edges: edges
            .into_iter()
            .map(|edge| ManifestEdge {
                edge_id: edge.edge_id,
                from: edge.from,
                to: edge.to,
                resource_id: edge.resource_id,
            })
            .collect(),
        operators: operators
            .into_iter()
            .map(|operator| ManifestOperator {
                operator_id: operator.operator_id,
                plugin_id: operator.plugin_id,
            })
            .collect(),
        plugins: plugins
            .into_iter()
            .map(|plugin| ManifestPlugin {
                plugin_id: plugin.plugin_id,
                action: plugin.action,
            })
            .collect(),
        hooks: hooks
            .into_iter()
            .map(|hook| ManifestHook {
                hook_id: hook.hook_id,
                kind: hook.kind,
                owner: hook.owner,
            })
            .collect(),
        resources: resources
            .into_iter()
            .map(|(resource_id, axis)| ManifestResource { resource_id, axis })
            .collect(),
        auth_handles: auth_handles
            .into_iter()
            .map(|handle| AuthHandle {
                provider_id: handle.provider_id,
                alias: handle.alias,
                source: handle.source,
            })
            .collect(),
        hash: String::new(),
    };
    manifest.nodes.sort();
    manifest.edges.sort();
    manifest.operators.sort();
    manifest.plugins.sort();
    manifest.hooks.sort();
    manifest.resources.sort();
    manifest.auth_handles.sort();
    manifest.hash = format!(
        "sha256:{:x}",
        Sha256::digest(manifest.canonical_body().as_bytes())
    );
    Ok(manifest)
}

pub fn compile_authoring(raw: &str) -> Result<ConfigManifest, ConfigError> {
    publish_v4_config_05_from_v4_config_04(build_v4_config_04_from_v4_config_03(
        validate_v4_config_03_from_v4_config_02(parse_v4_config_02_from_v4_config_01(
            V4Config01AuthoringFileSource::new("inline", raw),
        )?)?,
    )?)
    .map(V4Config05ManifestPublished::into_manifest)
}

fn config_node(node_id: &str, position: u32) -> BaseNode {
    BaseNode::new(NodeIdentity::new(
        node_id,
        "config",
        CONFIG_CHAIN_VERSION,
        position,
        "routecodex-v4-config",
    ))
}

fn validate_edges(
    authoring: &AuthoringParsed,
    node_positions: &BTreeMap<String, u32>,
    resources: &BTreeMap<String, ResourceAxis>,
) -> Result<(), ConfigError> {
    let node_refs: Vec<NodeRef> = node_positions
        .iter()
        .map(|(node_id, position)| {
            NodeRef::new(node_id, "config", CONFIG_CHAIN_VERSION, *position, false)
        })
        .collect();
    let resource_refs: Vec<ResourceRef> = resources
        .iter()
        .map(|(resource_id, axis)| ResourceRef::new(resource_id, edge_axis(*axis)))
        .collect();
    let mut scopes = ScopeRegistry::new();
    for edge in &authoring.edges {
        let axis = resources
            .get(edge.resource_id.as_str())
            .ok_or(ConfigError::UnknownResource)?;
        reject_payload_binding(&edge.resource_id, *axis)?;
        let spec = EdgeSpec::information_flow(
            &edge.edge_id,
            "config",
            CONFIG_CHAIN_VERSION,
            &edge.from,
            &edge.to,
            &edge.resource_id,
            &edge.resource_id,
        );
        validate_edge(&spec, &node_refs, &resource_refs, &[], &mut scopes)
            .map_err(map_edge_error)?;
        if node_positions[&edge.from] >= node_positions[&edge.to] {
            return Err(ConfigError::NonAdjacentEdge);
        }
    }
    Ok(())
}

fn edge_axis(axis: ResourceAxis) -> Axis {
    match axis {
        ResourceAxis::Information => Axis::Information,
        ResourceAxis::Control => Axis::Control,
        ResourceAxis::Data => Axis::Data,
    }
}

fn map_edge_error(error: EdgeError) -> ConfigError {
    match error {
        EdgeError::UnknownNode => ConfigError::UnknownNode,
        EdgeError::UnknownResource => ConfigError::UnknownResource,
        EdgeError::NonAdjacentEdge => ConfigError::NonAdjacentEdge,
        EdgeError::ResourceAxisMismatch => ConfigError::ResourceAxisMismatch,
        _ => ConfigError::ResourceAxisMismatch,
    }
}

fn unique_positions(nodes: &[NodeAuthoring]) -> Result<BTreeMap<String, u32>, ConfigError> {
    let mut positions = BTreeMap::new();
    let mut seen_positions = BTreeSet::new();
    for node in nodes {
        let position = config_node_position(&node.node_id).ok_or(ConfigError::UnknownNode)?;
        if positions.insert(node.node_id.clone(), position).is_some()
            || !seen_positions.insert(position)
        {
            return Err(ConfigError::DuplicateIdentifier);
        }
    }
    Ok(positions)
}

fn config_node_position(node_id: &str) -> Option<u32> {
    let suffix = node_id.strip_prefix("V4Config")?;
    let digits: String = suffix.chars().take_while(char::is_ascii_digit).collect();
    if digits.len() != 2 {
        return None;
    }
    digits.parse().ok()
}

fn unique_set<'a, K>(values: impl Iterator<Item = K>) -> Result<BTreeSet<K>, ConfigError>
where
    K: Ord,
{
    let mut result = BTreeSet::new();
    for value in values {
        if !result.insert(value) {
            return Err(ConfigError::DuplicateIdentifier);
        }
    }
    Ok(result)
}

fn unique_map<'a, K, V>(values: impl Iterator<Item = (K, V)>) -> Result<BTreeMap<K, V>, ConfigError>
where
    K: Ord,
{
    let mut result = BTreeMap::new();
    for (key, value) in values {
        if result.insert(key, value).is_some() {
            return Err(ConfigError::DuplicateIdentifier);
        }
    }
    Ok(result)
}

fn reject_payload_binding(resource_id: &str, axis: ResourceAxis) -> Result<(), ConfigError> {
    if axis == ResourceAxis::Data
        || resource_id.starts_with("v4.request.")
        || resource_id.starts_with("v4.response.")
        || resource_id.contains("payload")
    {
        return Err(ConfigError::PayloadBindingForbidden);
    }
    Ok(())
}

fn is_secret_handle(source: &str) -> bool {
    source.strip_prefix("env:").is_some_and(valid_handle_value)
        || source
            .strip_prefix("token_file:")
            .is_some_and(valid_handle_value)
}

fn valid_handle_value(value: &str) -> bool {
    !value.is_empty()
        && value
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || "_./-".contains(character))
}

fn sorted<T: Ord>(mut values: Vec<T>) -> Vec<T> {
    values.sort();
    values
}

pub const RUNTIME_CONFIG_CHAIN_VERSION: &str = "v4-runtime-config-1";

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum RuntimeConfigError {
    #[error("runtime config path requires HOME or an explicit -c path")]
    HomeMissing,
    #[error("runtime config read failed for {path}: {message}")]
    Read { path: String, message: String },
    #[error("runtime config parse failed: {0}")]
    Parse(String),
    #[error("runtime identity must be rccv4")]
    RuntimeIdentity,
    #[error("runtime config requires at least one listener")]
    ListenerMissing,
    #[error("runtime listener id/address must be non-empty")]
    ListenerInvalid,
    #[error("runtime listener ids and addresses must be unique")]
    ListenerDuplicate,
    #[error("runtime config requires at least one provider candidate")]
    ProviderMissing,
    #[error("provider id/config_path/protocol/wire_model must be non-empty")]
    ProviderInvalid,
    #[error("provider ids must be unique")]
    ProviderDuplicate,
    #[error("provider entry_models must be non-empty and include only non-empty models")]
    ProviderEntryModels,
    #[error("runtime config requires at least one route")]
    RouteMissing,
    #[error("route id/models/targets must be non-empty")]
    RouteInvalid,
    #[error("route ids must be unique")]
    RouteDuplicate,
    #[error("route {route_id} references unknown provider target {target}")]
    RouteTargetUnknown { route_id: String, target: String },
    #[error("route {route_id} model {model} is not declared by any target")]
    RouteModelUnserved { route_id: String, model: String },
    #[error("runtime manifest encode failed: {0}")]
    Encode(String),
    #[error("runtime manifest digest drift: expected {expected}, actual {actual}")]
    DigestDrift { expected: String, actual: String },
    #[error("runtime manifest write failed for {path}: {message}")]
    Write { path: String, message: String },
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct RuntimeAuthoring {
    version: u32,
    runtime: RuntimeAuthoringIdentity,
    listeners: Vec<RuntimeListener>,
    providers: Vec<RuntimeProviderCandidate>,
    routes: Vec<RuntimeRoute>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct RuntimeAuthoringIdentity {
    id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RuntimeListener {
    pub id: String,
    pub address: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RuntimeProviderCandidate {
    pub provider_id: String,
    pub config_path: String,
    pub protocol: String,
    pub wire_model: String,
    pub priority: u32,
    pub entry_models: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RuntimeRoute {
    pub id: String,
    pub models: Vec<String>,
    pub targets: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RuntimeConfigManifest {
    pub schema_version: u32,
    pub chain_version: String,
    pub runtime_identity: String,
    pub listeners: Vec<RuntimeListener>,
    pub providers: Vec<RuntimeProviderCandidate>,
    pub routes: Vec<RuntimeRoute>,
    pub manifest_digest: String,
}

#[derive(Serialize)]
struct UnsignedRuntimeConfigManifest<'a> {
    schema_version: u32,
    chain_version: &'a str,
    runtime_identity: &'a str,
    listeners: &'a [RuntimeListener],
    providers: &'a [RuntimeProviderCandidate],
    routes: &'a [RuntimeRoute],
}

impl RuntimeConfigManifest {
    pub fn verify(&self) -> Result<(), RuntimeConfigError> {
        let actual = runtime_manifest_digest(
            self.schema_version,
            &self.chain_version,
            &self.runtime_identity,
            &self.listeners,
            &self.providers,
            &self.routes,
        )?;
        if actual != self.manifest_digest {
            return Err(RuntimeConfigError::DigestDrift {
                expected: self.manifest_digest.clone(),
                actual,
            });
        }
        Ok(())
    }

    pub fn to_json(&self) -> Result<Vec<u8>, RuntimeConfigError> {
        serde_json::to_vec_pretty(self).map_err(|error| RuntimeConfigError::Encode(error.to_string()))
    }
}

pub fn default_runtime_config_path() -> Result<PathBuf, RuntimeConfigError> {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .map(|home| home.join(".rcc/config.v4.toml"))
        .ok_or(RuntimeConfigError::HomeMissing)
}

pub fn compile_runtime_config_file(path: &Path) -> Result<RuntimeConfigManifest, RuntimeConfigError> {
    let raw = fs::read_to_string(path).map_err(|error| RuntimeConfigError::Read {
        path: path.display().to_string(),
        message: error.to_string(),
    })?;
    compile_runtime_config(&raw, path.parent())
}

pub fn compile_runtime_config(
    raw: &str,
    config_dir: Option<&Path>,
) -> Result<RuntimeConfigManifest, RuntimeConfigError> {
    let authoring: RuntimeAuthoring =
        toml::from_str(raw).map_err(|error| RuntimeConfigError::Parse(error.to_string()))?;
    if authoring.version != 4 || authoring.runtime.id != "rccv4" {
        return Err(RuntimeConfigError::RuntimeIdentity);
    }
    validate_runtime_authoring(&authoring)?;
    let mut listeners = authoring.listeners;
    let mut providers = authoring.providers;
    let mut routes = authoring.routes;
    for provider in &mut providers {
        provider.config_path = resolve_authoring_path(&provider.config_path, config_dir)?
            .display()
            .to_string();
        provider.entry_models.sort();
    }
    listeners.sort_by(|left, right| left.id.cmp(&right.id));
    providers.sort_by(|left, right| left.provider_id.cmp(&right.provider_id));
    for route in &mut routes {
        route.models.sort();
    }
    routes.sort_by(|left, right| left.id.cmp(&right.id));
    let manifest_digest = runtime_manifest_digest(
        authoring.version,
        RUNTIME_CONFIG_CHAIN_VERSION,
        &authoring.runtime.id,
        &listeners,
        &providers,
        &routes,
    )?;
    Ok(RuntimeConfigManifest {
        schema_version: authoring.version,
        chain_version: RUNTIME_CONFIG_CHAIN_VERSION.to_string(),
        runtime_identity: authoring.runtime.id,
        listeners,
        providers,
        routes,
        manifest_digest,
    })
}

pub fn write_runtime_manifest_atomic(
    manifest: &RuntimeConfigManifest,
    path: &Path,
) -> Result<(), RuntimeConfigError> {
    manifest.verify()?;
    let parent = path.parent().ok_or_else(|| RuntimeConfigError::Write {
        path: path.display().to_string(),
        message: "manifest path has no parent".to_string(),
    })?;
    fs::create_dir_all(parent).map_err(|error| RuntimeConfigError::Write {
        path: parent.display().to_string(),
        message: error.to_string(),
    })?;
    let temporary = parent.join(format!(
        ".{}.{}.tmp",
        path.file_name().and_then(|name| name.to_str()).unwrap_or("manifest"),
        std::process::id()
    ));
    let mut bytes = manifest.to_json()?;
    bytes.push(b'\n');
    fs::write(&temporary, bytes).map_err(|error| RuntimeConfigError::Write {
        path: temporary.display().to_string(),
        message: error.to_string(),
    })?;
    fs::rename(&temporary, path).map_err(|error| RuntimeConfigError::Write {
        path: path.display().to_string(),
        message: error.to_string(),
    })
}

pub fn load_runtime_manifest(path: &Path) -> Result<RuntimeConfigManifest, RuntimeConfigError> {
    let bytes = fs::read(path).map_err(|error| RuntimeConfigError::Read {
        path: path.display().to_string(),
        message: error.to_string(),
    })?;
    let manifest: RuntimeConfigManifest = serde_json::from_slice(&bytes)
        .map_err(|error| RuntimeConfigError::Parse(error.to_string()))?;
    manifest.verify()?;
    Ok(manifest)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RuntimeInitOptions {
    pub provider_id: String,
    pub provider_config_path: String,
    pub model: String,
    pub port: u16,
}

pub fn write_runtime_authoring(
    path: &Path,
    options: &RuntimeInitOptions,
    force: bool,
) -> Result<RuntimeConfigManifest, RuntimeConfigError> {
    if path.exists() && !force {
        return Err(RuntimeConfigError::Write {
            path: path.display().to_string(),
            message: "runtime config already exists; pass --force to replace it".to_string(),
        });
    }
    if options.port == 0 {
        return Err(RuntimeConfigError::ListenerInvalid);
    }
    let authoring = RuntimeAuthoring {
        version: 4,
        runtime: RuntimeAuthoringIdentity {
            id: "rccv4".to_string(),
        },
        listeners: vec![RuntimeListener {
            id: "primary".to_string(),
            address: format!("127.0.0.1:{}", options.port),
        }],
        providers: vec![RuntimeProviderCandidate {
            provider_id: options.provider_id.clone(),
            config_path: options.provider_config_path.clone(),
            protocol: "responses".to_string(),
            wire_model: options.model.clone(),
            priority: 1,
            entry_models: vec![options.model.clone()],
        }],
        routes: vec![RuntimeRoute {
            id: "default".to_string(),
            models: vec![options.model.clone()],
            targets: vec![options.provider_id.clone()],
        }],
    };
    let mut bytes = toml::to_string_pretty(&authoring)
        .map_err(|error| RuntimeConfigError::Encode(error.to_string()))?
        .into_bytes();
    bytes.push(b'\n');
    let raw = std::str::from_utf8(&bytes)
        .map_err(|error| RuntimeConfigError::Encode(error.to_string()))?;
    let manifest = compile_runtime_config(raw, path.parent())?;
    let parent = path.parent().ok_or_else(|| RuntimeConfigError::Write {
        path: path.display().to_string(),
        message: "runtime config path has no parent".to_string(),
    })?;
    fs::create_dir_all(parent).map_err(|error| RuntimeConfigError::Write {
        path: parent.display().to_string(),
        message: error.to_string(),
    })?;
    let temporary = parent.join(format!(".config.v4.{}.tmp", std::process::id()));
    fs::write(&temporary, bytes).map_err(|error| RuntimeConfigError::Write {
        path: temporary.display().to_string(),
        message: error.to_string(),
    })?;
    fs::rename(&temporary, path).map_err(|error| RuntimeConfigError::Write {
        path: path.display().to_string(),
        message: error.to_string(),
    })?;
    Ok(manifest)
}

fn validate_runtime_authoring(authoring: &RuntimeAuthoring) -> Result<(), RuntimeConfigError> {
    if authoring.listeners.is_empty() {
        return Err(RuntimeConfigError::ListenerMissing);
    }
    if authoring.providers.is_empty() {
        return Err(RuntimeConfigError::ProviderMissing);
    }
    if authoring.routes.is_empty() {
        return Err(RuntimeConfigError::RouteMissing);
    }
    let mut listener_ids = BTreeSet::new();
    let mut listener_addresses = BTreeSet::new();
    for listener in &authoring.listeners {
        if listener.id.trim().is_empty() || listener.address.trim().is_empty() {
            return Err(RuntimeConfigError::ListenerInvalid);
        }
        if !listener_ids.insert(listener.id.as_str())
            || !listener_addresses.insert(listener.address.as_str())
        {
            return Err(RuntimeConfigError::ListenerDuplicate);
        }
    }
    let mut provider_ids = BTreeSet::new();
    for provider in &authoring.providers {
        if provider.provider_id.trim().is_empty()
            || provider.config_path.trim().is_empty()
            || provider.protocol.trim().is_empty()
            || provider.wire_model.trim().is_empty()
        {
            return Err(RuntimeConfigError::ProviderInvalid);
        }
        if !provider_ids.insert(provider.provider_id.as_str()) {
            return Err(RuntimeConfigError::ProviderDuplicate);
        }
        if provider.entry_models.is_empty()
            || provider.entry_models.iter().any(|model| model.trim().is_empty())
        {
            return Err(RuntimeConfigError::ProviderEntryModels);
        }
    }
    let mut route_ids = BTreeSet::new();
    for route in &authoring.routes {
        if route.id.trim().is_empty() || route.models.is_empty() || route.targets.is_empty() {
            return Err(RuntimeConfigError::RouteInvalid);
        }
        if !route_ids.insert(route.id.as_str()) {
            return Err(RuntimeConfigError::RouteDuplicate);
        }
        for target in &route.targets {
            let provider = authoring
                .providers
                .iter()
                .find(|provider| provider.provider_id == *target)
                .ok_or_else(|| RuntimeConfigError::RouteTargetUnknown {
                    route_id: route.id.clone(),
                    target: target.clone(),
                })?;
            for model in &route.models {
                if !provider.entry_models.contains(model)
                    && !authoring.providers.iter().any(|candidate| {
                        route.targets.contains(&candidate.provider_id)
                            && candidate.entry_models.contains(model)
                    })
                {
                    return Err(RuntimeConfigError::RouteModelUnserved {
                        route_id: route.id.clone(),
                        model: model.clone(),
                    });
                }
            }
        }
    }
    Ok(())
}

fn resolve_authoring_path(value: &str, config_dir: Option<&Path>) -> Result<PathBuf, RuntimeConfigError> {
    if let Some(rest) = value.strip_prefix("~/") {
        return std::env::var_os("HOME")
            .map(PathBuf::from)
            .map(|home| home.join(rest))
            .ok_or(RuntimeConfigError::HomeMissing);
    }
    let path = PathBuf::from(value);
    if path.is_absolute() {
        Ok(path)
    } else {
        Ok(config_dir.unwrap_or_else(|| Path::new(".")).join(path))
    }
}

fn runtime_manifest_digest(
    schema_version: u32,
    chain_version: &str,
    runtime_identity: &str,
    listeners: &[RuntimeListener],
    providers: &[RuntimeProviderCandidate],
    routes: &[RuntimeRoute],
) -> Result<String, RuntimeConfigError> {
    let unsigned = UnsignedRuntimeConfigManifest {
        schema_version,
        chain_version,
        runtime_identity,
        listeners,
        providers,
        routes,
    };
    let bytes = serde_json::to_vec(&unsigned)
        .map_err(|error| RuntimeConfigError::Encode(error.to_string()))?;
    Ok(format!("sha256:{:x}", Sha256::digest(bytes)))
}
