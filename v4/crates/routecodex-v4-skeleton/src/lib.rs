//! V4 Skeleton — immutable pipeline skeleton definition (Phase 5).
//!
//! Owns only the skeleton truth: `SkeletonDefinition`, `NodeSlot`, `Edge`,
//! `SemanticCheckpoint` and the compiled, immutable `SkeletonPlan`.
//!
//! Hard boundaries:
//! - never executes business plugins;
//! - never judges provider or route semantics;
//! - never touches business payload;
//! - never mutates a loaded plan (immutable after compile + hash).

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

pub const SKELETON_VERSION: &str = "v4-skeleton-1";
pub const PLAN_CONTRACT_PATH: &str = "v4/contracts/skeleton-plan.contract.json";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BindingContract {
    pub required: bool,
    pub fields: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PluginBinding {
    pub plugin_id: String,
    pub effects: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NodeSlot {
    pub node_id: String,
    pub chain: String,
    pub position: u32,
    pub role_id: String,
    #[serde(default)]
    pub terminal: bool,
    #[serde(default)]
    pub kernel: bool,
    #[serde(default)]
    pub plugins: Vec<PluginBinding>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Edge {
    pub from: String,
    pub to: String,
    pub direction: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SemanticCheckpoint {
    pub node_id: String,
    pub semantic: String,
    pub owner: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChainDefinition {
    pub chain_id: String,
    pub nodes: Vec<NodeSlot>,
    pub edges: Vec<Edge>,
    pub checkpoints: Vec<SemanticCheckpoint>,
}

/// Compiled immutable skeleton plan. `plan_hash` covers the canonical JSON of
/// the whole plan with the `plan_hash` field removed; `manifest_hash` binds the
/// config v2 manifest, `plan_epoch` gives the immutable plan generation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SkeletonPlan {
    pub schema_version: u32,
    pub contract_id: String,
    pub status: String,
    pub owner_feature_id: String,
    pub skeleton_version: String,
    pub binding: BindingContract,
    pub manifest_hash: String,
    pub plan_epoch: u64,
    pub plan_hash: String,
    pub chains: Vec<ChainDefinition>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SkeletonError {
    UnknownNode(String),
    CrossChainEdge(String, String),
    ReverseEdge(String, String),
    NonAdjacentEdge(String, String),
    SecondTerminal(String),
    SecondKernel(String),
    PluginCallsNextNode(String),
    PlanHashMismatch,
    NonCanonicalVersion(String),
}

impl std::fmt::Display for SkeletonError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::UnknownNode(id) => write!(formatter, "unknown node {id}"),
            Self::CrossChainEdge(from, to) => write!(formatter, "cross-chain edge {from}->{to}"),
            Self::ReverseEdge(from, to) => write!(formatter, "reverse edge {from}->{to}"),
            Self::NonAdjacentEdge(from, to) => write!(formatter, "non-adjacent edge {from}->{to}"),
            Self::SecondTerminal(chain) => write!(formatter, "second terminal in chain {chain}"),
            Self::SecondKernel(chain) => {
                write!(formatter, "second runtime kernel in chain {chain}")
            }
            Self::PluginCallsNextNode(plugin) => {
                write!(formatter, "plugin {plugin} calls next_node")
            }
            Self::PlanHashMismatch => write!(formatter, "plan hash mismatch"),
            Self::NonCanonicalVersion(version) => {
                write!(formatter, "non-canonical skeleton version {version}")
            }
        }
    }
}

impl std::error::Error for SkeletonError {}

fn canonical_json(value: &serde_json::Value) -> String {
    match value {
        serde_json::Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort();
            let body: Vec<String> = keys
                .into_iter()
                .map(|key| {
                    format!(
                        "{}:{}",
                        serde_json::Value::String(key.clone()).to_string(),
                        canonical_json(&map[key])
                    )
                })
                .collect();
            format!("{{{}}}", body.join(","))
        }
        serde_json::Value::Array(items) => {
            let body: Vec<String> = items.iter().map(canonical_json).collect();
            format!("[{}]", body.join(","))
        }
        other => other.to_string(),
    }
}

fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("{:x}", hasher.finalize())
}

pub fn plan_hash(plan: &SkeletonPlan) -> String {
    let mut value = serde_json::to_value(plan).expect("plan serializes");
    value
        .as_object_mut()
        .expect("plan is object")
        .remove("plan_hash");
    format!("sha256:{}", sha256_hex(canonical_json(&value).as_bytes()))
}

fn validate_chain(chain: &ChainDefinition) -> Result<(), SkeletonError> {
    let by_id: std::collections::HashMap<&str, &NodeSlot> = chain
        .nodes
        .iter()
        .map(|node| (node.node_id.as_str(), node))
        .collect();
    let terminals = chain.nodes.iter().filter(|node| node.terminal).count();
    if terminals > 1 {
        return Err(SkeletonError::SecondTerminal(chain.chain_id.clone()));
    }
    let kernels = chain.nodes.iter().filter(|node| node.kernel).count();
    if kernels > 1 {
        return Err(SkeletonError::SecondKernel(chain.chain_id.clone()));
    }
    for edge in &chain.edges {
        let from = by_id
            .get(edge.from.as_str())
            .ok_or_else(|| SkeletonError::UnknownNode(edge.from.clone()))?;
        let to = by_id
            .get(edge.to.as_str())
            .ok_or_else(|| SkeletonError::UnknownNode(edge.to.clone()))?;
        if from.chain != chain.chain_id || to.chain != chain.chain_id {
            return Err(SkeletonError::CrossChainEdge(
                edge.from.clone(),
                edge.to.clone(),
            ));
        }
        if edge.direction != "forward" {
            return Err(SkeletonError::ReverseEdge(
                edge.from.clone(),
                edge.to.clone(),
            ));
        }
        if to.position != from.position + 1 {
            return Err(SkeletonError::NonAdjacentEdge(
                edge.from.clone(),
                edge.to.clone(),
            ));
        }
    }
    for node in &chain.nodes {
        for plugin in &node.plugins {
            if plugin.effects.iter().any(|effect| effect == "next_node") {
                return Err(SkeletonError::PluginCallsNextNode(plugin.plugin_id.clone()));
            }
        }
    }
    Ok(())
}

impl SkeletonPlan {
    /// Load a compiled plan from its canonical contract JSON and verify
    /// topology + immutable hash. The hash is recomputed over the canonical
    /// JSON with `plan_hash` removed and must match the stored value.
    pub fn from_contract_json(json: &str) -> Result<Self, SkeletonError> {
        let mut plan: SkeletonPlan =
            serde_json::from_str(json).map_err(|_| SkeletonError::PlanHashMismatch)?;
        if plan.skeleton_version != SKELETON_VERSION {
            return Err(SkeletonError::NonCanonicalVersion(
                plan.skeleton_version.clone(),
            ));
        }
        for chain in &plan.chains {
            validate_chain(chain)?;
        }
        let expected = plan.plan_hash.clone();
        let recomputed = plan_hash(&plan);
        if expected != recomputed {
            return Err(SkeletonError::PlanHashMismatch);
        }
        plan.plan_hash = recomputed;
        Ok(plan)
    }

    /// Verify an already-loaded plan: topology + hash remain valid.
    pub fn verify(&self) -> Result<(), SkeletonError> {
        if self.skeleton_version != SKELETON_VERSION {
            return Err(SkeletonError::NonCanonicalVersion(
                self.skeleton_version.clone(),
            ));
        }
        for chain in &self.chains {
            validate_chain(chain)?;
        }
        if plan_hash(self) != self.plan_hash {
            return Err(SkeletonError::PlanHashMismatch);
        }
        Ok(())
    }

    pub fn checkpoint_ids(&self) -> Vec<&str> {
        self.chains
            .iter()
            .flat_map(|chain| chain.checkpoints.iter())
            .map(|checkpoint| checkpoint.node_id.as_str())
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn slot(node_id: &str, chain: &str, position: u32, terminal: bool, kernel: bool) -> NodeSlot {
        NodeSlot {
            node_id: node_id.to_string(),
            chain: chain.to_string(),
            position,
            role_id: "test_role".to_string(),
            terminal,
            kernel,
            plugins: vec![],
        }
    }

    #[test]
    fn positive_linear_chain_builds() {
        let json = std::fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../contracts/skeleton-plan.contract.json"
        ))
        .expect("contract file");
        let plan = SkeletonPlan::from_contract_json(&json).expect("real contract must load");
        assert_eq!(plan.skeleton_version, SKELETON_VERSION);
        assert_eq!(plan.chains.len(), 4);
        assert!(plan.verify().is_ok());
    }

    fn test_plan(chains: Vec<ChainDefinition>) -> SkeletonPlan {
        SkeletonPlan {
            schema_version: 1,
            contract_id: "v4-skeleton-plan".to_string(),
            status: "active".to_string(),
            owner_feature_id: "v4.skeleton".to_string(),
            skeleton_version: SKELETON_VERSION.to_string(),
            binding: BindingContract {
                required: true,
                fields: vec![
                    "skeleton_version".to_string(),
                    "manifest_hash".to_string(),
                    "plan_epoch".to_string(),
                    "plan_hash".to_string(),
                ],
            },
            manifest_hash: "sha256:m".to_string(),
            plan_epoch: 1,
            plan_hash: String::new(),
            chains,
        }
    }

    #[test]
    fn red_non_adjacent_edge_fails() {
        let plan = test_plan(vec![ChainDefinition {
            chain_id: "request".to_string(),
            nodes: vec![
                slot("a", "request", 1, false, true),
                slot("b", "request", 2, false, false),
                slot("c", "request", 3, true, false),
            ],
            edges: vec![Edge {
                from: "a".to_string(),
                to: "c".to_string(),
                direction: "forward".to_string(),
            }],
            checkpoints: vec![],
        }]);
        assert_eq!(
            plan.verify(),
            Err(SkeletonError::NonAdjacentEdge("a".into(), "c".into()))
        );
    }

    #[test]
    fn red_reverse_edge_fails() {
        let plan = test_plan(vec![ChainDefinition {
            chain_id: "request".to_string(),
            nodes: vec![
                slot("a", "request", 1, false, true),
                slot("b", "request", 2, true, false),
            ],
            edges: vec![Edge {
                from: "b".to_string(),
                to: "a".to_string(),
                direction: "reverse".to_string(),
            }],
            checkpoints: vec![],
        }]);
        assert_eq!(
            plan.verify(),
            Err(SkeletonError::ReverseEdge("b".into(), "a".into()))
        );
    }

    #[test]
    fn red_second_terminal_fails() {
        let plan = test_plan(vec![ChainDefinition {
            chain_id: "request".to_string(),
            nodes: vec![
                slot("a", "request", 1, true, true),
                slot("b", "request", 2, true, false),
            ],
            edges: vec![],
            checkpoints: vec![],
        }]);
        assert_eq!(
            plan.verify(),
            Err(SkeletonError::SecondTerminal("request".into()))
        );
    }

    #[test]
    fn red_second_kernel_fails() {
        let plan = test_plan(vec![ChainDefinition {
            chain_id: "request".to_string(),
            nodes: vec![
                slot("a", "request", 1, false, true),
                slot("b", "request", 2, true, true),
            ],
            edges: vec![],
            checkpoints: vec![],
        }]);
        assert_eq!(
            plan.verify(),
            Err(SkeletonError::SecondKernel("request".into()))
        );
    }

    #[test]
    fn red_plugin_next_node_fails() {
        let plan = test_plan(vec![ChainDefinition {
            chain_id: "request".to_string(),
            nodes: vec![NodeSlot {
                node_id: "a".to_string(),
                chain: "request".to_string(),
                position: 1,
                role_id: "test_role".to_string(),
                terminal: true,
                kernel: true,
                plugins: vec![PluginBinding {
                    plugin_id: "bad".to_string(),
                    effects: vec!["next_node".to_string()],
                }],
            }],
            edges: vec![],
            checkpoints: vec![],
        }]);
        assert_eq!(
            plan.verify(),
            Err(SkeletonError::PluginCallsNextNode("bad".into()))
        );
    }

    #[test]
    fn positive_plan_hash_is_stable() {
        let plan = test_plan(vec![ChainDefinition {
            chain_id: "request".to_string(),
            nodes: vec![slot("a", "request", 1, true, true)],
            edges: vec![],
            checkpoints: vec![],
        }]);
        let first = plan_hash(&plan);
        let second = plan_hash(&plan);
        assert_eq!(first, second);
        assert!(first.starts_with("sha256:"));
    }
}
