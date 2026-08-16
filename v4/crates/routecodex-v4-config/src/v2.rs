//! Config v2 — NodePluginPlan-compatible authoring -> immutable manifest.
//!
//! Config v1 (operators/hooks) remains the legacy authoring surface; v2 is the
//! publishable model that matches `node-plugin.contract.json` /
//! `node-container.contract.json` and the skeleton chain semantics:
//!
//! - node role (+ chain + allowed capabilities);
//! - plugin bindings (plugin_id/effect/phase per node);
//! - selection groups (exactly one active variant per group);
//! - capabilities (must be allowed by the node role);
//! - resource permissions (per-node read/write registry);
//! - semantic checkpoints (node_id/semantic/owner, owner mandatory).
//!
//! The published `ConfigManifestV2` is immutable and carries three hashes:
//! `plan_hash`, `checkpoint_hash`, `artifact_hash`. `verify()` re-derives all
//! three from canonical bodies; any tamper fails fast.

use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};

pub const CONFIG_V2_CHAIN_VERSION: &str = "v4-config-2";

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ConfigV2Error {
    #[error("config v2 parse failed: {0}")]
    Parse(String),
    #[error("config v2 manifest version {0} not supported (expected 2)")]
    VersionNotSupported(u32),
    #[error("duplicate role {0}")]
    DuplicateRole(String),
    #[error("node {0} references unknown role {1}")]
    UnknownRole(String, String),
    #[error("duplicate node {0}")]
    DuplicateNode(String),
    #[error("chain {0} node positions are not consecutive")]
    NonConsecutivePosition(String),
    #[error("node {0} references unknown capability {1}")]
    UnknownCapability(String, String),
    #[error("duplicate selection group {0}")]
    DuplicateSelectionGroup(String),
    #[error("selection group {0} has zero active variants")]
    SelectionGroupNotActive(String),
    #[error("selection group {0} has multiple active variants")]
    SelectionGroupMultipleActive(String),
    #[error("selection group {0} active variant {1} is not declared")]
    SelectionGroupUnknownVariant(String, String),
    #[error("node {0} declares no resource permissions")]
    MissingResourcePermissions(String),
    #[error("node {0} has duplicate resource permission {1}")]
    DuplicateResourcePermission(String, String),
    #[error("checkpoint on node {0} has empty owner")]
    CheckpointMissingOwner(String),
    #[error("edge references unknown node {0}")]
    EdgeUnknownNode(String),
    #[error("edge {0}->{1} is not forward-adjacent")]
    EdgeNonAdjacent(String, String),
    #[error("chain {0} has more than one terminal node")]
    SecondTerminal(String),
    #[error("chain {0} has more than one kernel node")]
    SecondKernel(String),
    #[error("manifest hash mismatch: plan {0} checkpoint {1} artifact {2}")]
    HashMismatch(String, String, String),
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AuthoringV2 {
    pub version: u32,
    #[serde(default)]
    pub roles: Vec<RoleAuthoring>,
    #[serde(default)]
    pub nodes: Vec<NodeV2Authoring>,
    #[serde(default)]
    pub selection_groups: Vec<SelectionGroupAuthoring>,
    #[serde(default)]
    pub edges: Vec<EdgeV2Authoring>,
    #[serde(default)]
    pub codex_sample: Option<CodexSampleAuthoring>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RoleAuthoring {
    pub role_id: String,
    pub chain: String,
    #[serde(default)]
    pub allowed_capabilities: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PluginBindingAuthoring {
    pub plugin_id: String,
    pub effect: String,
    pub phase: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ResourcePermissionAuthoring {
    pub resource_id: String,
    #[serde(default)]
    pub read: bool,
    #[serde(default)]
    pub write: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CheckpointAuthoring {
    pub node_id: String,
    pub semantic: String,
    pub owner: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NodeV2Authoring {
    pub node_id: String,
    pub chain: String,
    pub position: u32,
    pub role_id: String,
    #[serde(default)]
    pub terminal: bool,
    #[serde(default)]
    pub kernel: bool,
    #[serde(default)]
    pub selection_group: String,
    #[serde(default)]
    pub plugin_bindings: Vec<PluginBindingAuthoring>,
    #[serde(default)]
    pub capabilities: Vec<String>,
    #[serde(default)]
    pub resource_permissions: Vec<ResourcePermissionAuthoring>,
    #[serde(default)]
    pub checkpoints: Vec<CheckpointAuthoring>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SelectionGroupAuthoring {
    pub group_id: String,
    #[serde(default)]
    pub variants: Vec<String>,
    #[serde(default)]
    pub active: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EdgeV2Authoring {
    pub from: String,
    pub to: String,
    pub direction: String,
    #[serde(default)]
    pub resource_id: String,
}

/// Diagnostic codex-sample capture authorization published by the manifest.
/// This is configuration truth, never a live runtime control input; it must
/// not enter provider/client payload.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CodexSampleAuthoring {
    pub managed_instance_id: String,
    #[serde(default)]
    pub codex_samples_enabled: bool,
    #[serde(default)]
    pub direct_snapshots_enabled: bool,
    #[serde(default)]
    pub snapshot_stages: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CodexSampleAuthorization {
    pub managed_instance_id: String,
    pub codex_samples_enabled: bool,
    pub direct_snapshots_enabled: bool,
    pub snapshot_stages: Vec<String>,
}

impl CodexSampleAuthorization {
    pub fn from_authoring(authoring: &Option<CodexSampleAuthoring>) -> Option<Self> {
        authoring.as_ref().map(|sample| {
            let mut stages = sample.snapshot_stages.clone();
            stages.sort();
            stages.dedup();
            CodexSampleAuthorization {
                managed_instance_id: sample.managed_instance_id.clone(),
                codex_samples_enabled: sample.codex_samples_enabled,
                direct_snapshots_enabled: sample.direct_snapshots_enabled,
                snapshot_stages: stages,
            }
        })
    }

    pub fn should_capture_snapshot_stage(&self, stage: &str) -> bool {
        self.codex_samples_enabled && self.snapshot_stages.iter().any(|s| s == stage)
    }
}

#[derive(Debug, Clone)]
pub struct ValidatedV2 {
    authoring: AuthoringV2,
    node_positions: BTreeMap<String, u32>,
}

impl ValidatedV2 {
    pub fn authoring(&self) -> &AuthoringV2 {
        &self.authoring
    }
}

#[derive(Debug, Clone)]
pub struct RegistryV2 {
    validated: ValidatedV2,
    permissions: BTreeMap<String, BTreeMap<String, (bool, bool)>>,
}

impl RegistryV2 {
    pub fn validated(&self) -> &ValidatedV2 {
        &self.validated
    }

    pub fn can_read(&self, node_id: &str, resource_id: &str) -> bool {
        self.permissions
            .get(node_id)
            .and_then(|map| map.get(resource_id))
            .map(|(read, _)| *read)
            .unwrap_or(false)
    }

    pub fn can_write(&self, node_id: &str, resource_id: &str) -> bool {
        self.permissions
            .get(node_id)
            .and_then(|map| map.get(resource_id))
            .map(|(_, write)| *write)
            .unwrap_or(false)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub struct ManifestNodeV2 {
    pub node_id: String,
    pub chain: String,
    pub position: u32,
    pub role_id: String,
    pub terminal: bool,
    pub kernel: bool,
    pub selection_group: String,
    pub plugin_bindings: Vec<String>,
    pub capabilities: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub struct ManifestEdgeV2 {
    pub from: String,
    pub to: String,
    pub direction: String,
    pub resource_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub struct ManifestSelectionGroupV2 {
    pub group_id: String,
    pub variants: Vec<String>,
    pub active: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub struct ManifestCheckpointV2 {
    pub node_id: String,
    pub semantic: String,
    pub owner: String,
}

/// Immutable published manifest. `plan_hash` locks the compiled plan body,
/// `checkpoint_hash` locks the semantic checkpoint set, `artifact_hash` locks
/// the full published artifact (plan + checkpoints + hashes).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConfigManifestV2 {
    manifest_version: u32,
    chain_version: &'static str,
    nodes: Vec<ManifestNodeV2>,
    edges: Vec<ManifestEdgeV2>,
    selection_groups: Vec<ManifestSelectionGroupV2>,
    checkpoints: Vec<ManifestCheckpointV2>,
    codex_sample: Option<CodexSampleAuthorization>,
    plan_hash: String,
    checkpoint_hash: String,
    artifact_hash: String,
}

impl ConfigManifestV2 {
    pub fn manifest_version(&self) -> u32 {
        self.manifest_version
    }

    pub fn chain_version(&self) -> &'static str {
        self.chain_version
    }

    pub fn nodes(&self) -> &[ManifestNodeV2] {
        &self.nodes
    }

    pub fn edges(&self) -> &[ManifestEdgeV2] {
        &self.edges
    }

    pub fn selection_groups(&self) -> &[ManifestSelectionGroupV2] {
        &self.selection_groups
    }

    pub fn checkpoints(&self) -> &[ManifestCheckpointV2] {
        &self.checkpoints
    }

    pub fn codex_sample(&self) -> Option<&CodexSampleAuthorization> {
        self.codex_sample.as_ref()
    }

    pub fn plan_hash(&self) -> &str {
        &self.plan_hash
    }

    pub fn checkpoint_hash(&self) -> &str {
        &self.checkpoint_hash
    }

    pub fn artifact_hash(&self) -> &str {
        &self.artifact_hash
    }

    pub fn plan_body(&self) -> String {
        let mut lines = vec![
            format!("manifest_version={}", self.manifest_version),
            format!("chain_version={}", self.chain_version),
        ];
        for node in &self.nodes {
            lines.push(format!(
                "node|{}|{}|{}|{}|{}|{}|{}|{}|{}",
                node.chain,
                node.position,
                node.node_id,
                node.role_id,
                node.terminal,
                node.kernel,
                node.selection_group,
                node.plugin_bindings.join(","),
                node.capabilities.join(",")
            ));
        }
        for edge in &self.edges {
            lines.push(format!(
                "edge|{}|{}|{}|{}",
                edge.from, edge.to, edge.direction, edge.resource_id
            ));
        }
        for group in &self.selection_groups {
            lines.push(format!(
                "selection_group|{}|{}|{}",
                group.group_id,
                group.variants.join(","),
                group.active.join(",")
            ));
        }
        if let Some(sample) = &self.codex_sample {
            lines.push(format!(
                "codex_sample|{}|{}|{}|{}",
                sample.managed_instance_id,
                sample.codex_samples_enabled,
                sample.direct_snapshots_enabled,
                sample.snapshot_stages.join(",")
            ));
        }
        lines.join("\n")
    }

    pub fn checkpoint_body(&self) -> String {
        let mut lines: Vec<String> = self
            .checkpoints
            .iter()
            .map(|checkpoint| {
                format!(
                    "checkpoint|{}|{}|{}",
                    checkpoint.node_id, checkpoint.semantic, checkpoint.owner
                )
            })
            .collect();
        lines.sort();
        lines.join("\n")
    }

    pub fn to_manifest_json(&self) -> String {
        format!(
            "{{\"manifest_version\":{},\"chain_version\":\"{}\",\"plan_hash\":\"{}\",\"checkpoint_hash\":\"{}\",\"artifact_hash\":\"{}\"}}",
            self.manifest_version,
            self.chain_version,
            self.plan_hash,
            self.checkpoint_hash,
            self.artifact_hash
        )
    }

    /// Re-derive all three hashes from canonical bodies and compare them
    /// against externally supplied expected values; fail-fast on tamper.
    pub fn verify_against(
        &self,
        expected_plan: &str,
        expected_checkpoint: &str,
        expected_artifact: &str,
    ) -> Result<(), ConfigV2Error> {
        let plan = sha256_hex(self.plan_body().as_bytes());
        let checkpoint = sha256_hex(self.checkpoint_body().as_bytes());
        let artifact_body = format!(
            "{}\ncheckpoint_hash={}\nplan_hash={}\n",
            self.plan_body(),
            checkpoint,
            plan
        );
        let artifact = sha256_hex(artifact_body.as_bytes());
        if plan != expected_plan
            || checkpoint != expected_checkpoint
            || artifact != expected_artifact
        {
            return Err(ConfigV2Error::HashMismatch(plan, checkpoint, artifact));
        }
        Ok(())
    }

    /// Re-derive all three hashes from canonical bodies and compare them
    /// against the stored manifest hashes; fail-fast on tamper.
    pub fn verify(&self) -> Result<(), ConfigV2Error> {
        self.verify_against(&self.plan_hash, &self.checkpoint_hash, &self.artifact_hash)
    }
}

fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("sha256:{}", hex(&hasher.finalize()))
}

fn hex(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

pub fn parse_v2_authoring(raw: &str) -> Result<AuthoringV2, ConfigV2Error> {
    toml::from_str(raw).map_err(|error| ConfigV2Error::Parse(error.to_string()))
}

pub fn validate_v2_authoring(authoring: AuthoringV2) -> Result<ValidatedV2, ConfigV2Error> {
    if authoring.version != 2 {
        return Err(ConfigV2Error::VersionNotSupported(authoring.version));
    }
    let mut roles = BTreeMap::new();
    for role in &authoring.roles {
        if roles.insert(role.role_id.clone(), role).is_some() {
            return Err(ConfigV2Error::DuplicateRole(role.role_id.clone()));
        }
    }
    let mut node_positions = BTreeMap::new();
    for node in &authoring.nodes {
        if node_positions
            .insert(node.node_id.clone(), node.position)
            .is_some()
        {
            return Err(ConfigV2Error::DuplicateNode(node.node_id.clone()));
        }
        let role = roles.get(&node.role_id).ok_or_else(|| {
            ConfigV2Error::UnknownRole(node.node_id.clone(), node.role_id.clone())
        })?;
        if role.chain != node.chain {
            return Err(ConfigV2Error::UnknownRole(
                node.node_id.clone(),
                node.role_id.clone(),
            ));
        }
        let allowed: BTreeSet<&str> = role
            .allowed_capabilities
            .iter()
            .map(String::as_str)
            .collect();
        for capability in &node.capabilities {
            if !allowed.contains(capability.as_str()) {
                return Err(ConfigV2Error::UnknownCapability(
                    node.node_id.clone(),
                    capability.clone(),
                ));
            }
        }
        if node.resource_permissions.is_empty() {
            return Err(ConfigV2Error::MissingResourcePermissions(
                node.node_id.clone(),
            ));
        }
        let mut seen = BTreeSet::new();
        for permission in &node.resource_permissions {
            if !seen.insert(permission.resource_id.as_str()) {
                return Err(ConfigV2Error::DuplicateResourcePermission(
                    node.node_id.clone(),
                    permission.resource_id.clone(),
                ));
            }
        }
        for checkpoint in &node.checkpoints {
            if checkpoint.owner.trim().is_empty() {
                return Err(ConfigV2Error::CheckpointMissingOwner(node.node_id.clone()));
            }
        }
    }
    let mut groups = BTreeMap::new();
    for group in &authoring.selection_groups {
        if groups.insert(group.group_id.clone(), group).is_some() {
            return Err(ConfigV2Error::DuplicateSelectionGroup(
                group.group_id.clone(),
            ));
        }
        if group.active.is_empty() {
            return Err(ConfigV2Error::SelectionGroupNotActive(
                group.group_id.clone(),
            ));
        }
        if group.active.len() > 1 {
            return Err(ConfigV2Error::SelectionGroupMultipleActive(
                group.group_id.clone(),
            ));
        }
        for variant in &group.active {
            if !group.variants.contains(variant) {
                return Err(ConfigV2Error::SelectionGroupUnknownVariant(
                    group.group_id.clone(),
                    variant.clone(),
                ));
            }
        }
    }
    let chains = chain_positions(&authoring.nodes);
    for (chain, positions) in &chains {
        if positions.len() > 1 {
            for window in positions.windows(2) {
                if window[1] != window[0] + 1 {
                    return Err(ConfigV2Error::NonConsecutivePosition(chain.clone()));
                }
            }
        }
    }
    for chain_node in &authoring.nodes {
        let terminal_count = authoring
            .nodes
            .iter()
            .filter(|node| node.chain == chain_node.chain && node.terminal)
            .count();
        if terminal_count > 1 {
            return Err(ConfigV2Error::SecondTerminal(chain_node.chain.clone()));
        }
        let kernel_count = authoring
            .nodes
            .iter()
            .filter(|node| node.chain == chain_node.chain && node.kernel)
            .count();
        if kernel_count > 1 {
            return Err(ConfigV2Error::SecondKernel(chain_node.chain.clone()));
        }
    }
    for edge in &authoring.edges {
        let from = authoring
            .nodes
            .iter()
            .find(|node| node.node_id == edge.from)
            .ok_or_else(|| ConfigV2Error::EdgeUnknownNode(edge.from.clone()))?;
        let to = authoring
            .nodes
            .iter()
            .find(|node| node.node_id == edge.to)
            .ok_or_else(|| ConfigV2Error::EdgeUnknownNode(edge.to.clone()))?;
        if edge.direction != "forward" || from.chain != to.chain || to.position != from.position + 1
        {
            return Err(ConfigV2Error::EdgeNonAdjacent(
                edge.from.clone(),
                edge.to.clone(),
            ));
        }
    }
    Ok(ValidatedV2 {
        authoring,
        node_positions,
    })
}

fn chain_positions(nodes: &[NodeV2Authoring]) -> BTreeMap<String, Vec<u32>> {
    let mut by_chain: BTreeMap<&str, Vec<u32>> = BTreeMap::new();
    for node in nodes {
        by_chain
            .entry(node.chain.as_str())
            .or_default()
            .push(node.position);
    }
    by_chain
        .into_iter()
        .map(|(chain, mut positions)| {
            positions.sort_unstable();
            (chain.to_string(), positions)
        })
        .collect()
}

pub fn build_v2_registry(validated: ValidatedV2) -> Result<RegistryV2, ConfigV2Error> {
    let mut permissions = BTreeMap::new();
    for node in &validated.authoring.nodes {
        let mut map = BTreeMap::new();
        for permission in &node.resource_permissions {
            map.insert(
                permission.resource_id.clone(),
                (permission.read, permission.write),
            );
        }
        permissions.insert(node.node_id.clone(), map);
    }
    Ok(RegistryV2 {
        validated,
        permissions,
    })
}

pub fn publish_v2_manifest(registry: RegistryV2) -> Result<ConfigManifestV2, ConfigV2Error> {
    let authoring = &registry.validated.authoring;
    let mut nodes: Vec<ManifestNodeV2> = authoring
        .nodes
        .iter()
        .map(|node| {
            let mut bindings: Vec<String> = node
                .plugin_bindings
                .iter()
                .map(|binding| binding.plugin_id.clone())
                .collect();
            bindings.sort();
            let mut capabilities = node.capabilities.clone();
            capabilities.sort();
            ManifestNodeV2 {
                node_id: node.node_id.clone(),
                chain: node.chain.clone(),
                position: node.position,
                role_id: node.role_id.clone(),
                terminal: node.terminal,
                kernel: node.kernel,
                selection_group: node.selection_group.clone(),
                plugin_bindings: bindings,
                capabilities,
            }
        })
        .collect();
    nodes.sort_by(|a, b| {
        a.chain
            .cmp(&b.chain)
            .then(a.position.cmp(&b.position))
            .then(a.node_id.cmp(&b.node_id))
    });
    let mut edges: Vec<ManifestEdgeV2> = authoring
        .edges
        .iter()
        .map(|edge| ManifestEdgeV2 {
            from: edge.from.clone(),
            to: edge.to.clone(),
            direction: edge.direction.clone(),
            resource_id: edge.resource_id.clone(),
        })
        .collect();
    edges.sort_by(|a, b| {
        a.from
            .cmp(&b.from)
            .then(a.to.cmp(&b.to))
            .then(a.resource_id.cmp(&b.resource_id))
    });
    let mut selection_groups: Vec<ManifestSelectionGroupV2> = authoring
        .selection_groups
        .iter()
        .map(|group| ManifestSelectionGroupV2 {
            group_id: group.group_id.clone(),
            variants: group.variants.clone(),
            active: group.active.clone(),
        })
        .collect();
    selection_groups.sort_by(|a, b| a.group_id.cmp(&b.group_id));
    let mut checkpoints: Vec<ManifestCheckpointV2> = authoring
        .nodes
        .iter()
        .flat_map(|node| {
            node.checkpoints
                .iter()
                .map(|checkpoint| ManifestCheckpointV2 {
                    node_id: checkpoint.node_id.clone(),
                    semantic: checkpoint.semantic.clone(),
                    owner: checkpoint.owner.clone(),
                })
        })
        .collect();
    checkpoints.sort_by(|a, b| {
        a.node_id
            .cmp(&b.node_id)
            .then(a.semantic.cmp(&b.semantic))
            .then(a.owner.cmp(&b.owner))
    });
    let mut manifest = ConfigManifestV2 {
        manifest_version: 2,
        chain_version: CONFIG_V2_CHAIN_VERSION,
        nodes,
        edges,
        selection_groups,
        checkpoints,
        codex_sample: CodexSampleAuthorization::from_authoring(&authoring.codex_sample),
        plan_hash: String::new(),
        checkpoint_hash: String::new(),
        artifact_hash: String::new(),
    };
    let plan = sha256_hex(manifest.plan_body().as_bytes());
    let checkpoint = sha256_hex(manifest.checkpoint_body().as_bytes());
    let artifact_body = format!(
        "{}\ncheckpoint_hash={}\nplan_hash={}\n",
        manifest.plan_body(),
        checkpoint,
        plan
    );
    let artifact = sha256_hex(artifact_body.as_bytes());
    manifest.plan_hash = plan;
    manifest.checkpoint_hash = checkpoint;
    manifest.artifact_hash = artifact;
    Ok(manifest)
}

/// Full v2 chain: authoring source -> parse -> validate -> registry -> manifest.
pub fn compile_v2(raw: &str) -> Result<ConfigManifestV2, ConfigV2Error> {
    let authoring = parse_v2_authoring(raw)?;
    let validated = validate_v2_authoring(authoring)?;
    let registry = build_v2_registry(validated)?;
    let manifest = publish_v2_manifest(registry)?;
    manifest.verify()?;
    Ok(manifest)
}
