//! Rust side of the V4 NodeContainer boundary.
//!
//! Cordis owns Context/Fiber/Effect creation and disposal in the host module.
//! This crate owns only the immutable typed plan binding and the lifecycle
//! port consumed by management code. It never creates a Cordis-like runtime,
//! scans plugins, or chooses plugin order.

use routecodex_v4_cordis_bridge::{
    execute_plan, BridgeError, HandleRegistry, NodeExecutionInput, NodeExecutionOutput,
};
use routecodex_v4_plugin_plan::NodePluginPlan;
use sha2::{Digest, Sha256};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NodeContainerState {
    Declared,
    ContextCreated,
    PluginsMounted,
    Accepting,
    Draining,
    Disposed,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlanBindings {
    pub graph_hash: String,
    pub manifest_hash: String,
    pub loaded_plan_hash: String,
}

impl PlanBindings {
    pub fn verify(&self) -> bool {
        !self.graph_hash.is_empty()
            && self.graph_hash == self.manifest_hash
            && self.manifest_hash == self.loaded_plan_hash
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NodeContainerError {
    InvalidState {
        state: NodeContainerState,
        operation: &'static str,
    },
    PlanHashMismatch,
    BindingMismatch,
    HostLifecycle(String),
    Bridge(BridgeError),
}

impl std::fmt::Display for NodeContainerError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidState { state, operation } => {
                write!(f, "cannot {operation} while node container is {state:?}")
            }
            Self::PlanHashMismatch => write!(f, "node plugin plan hash mismatch"),
            Self::BindingMismatch => write!(f, "Cordis graph/manifest/loaded plan hashes differ"),
            Self::HostLifecycle(message) => write!(f, "host lifecycle failed: {message}"),
            Self::Bridge(error) => write!(f, "typed bridge failed: {error}"),
        }
    }
}

impl std::error::Error for NodeContainerError {}

impl From<BridgeError> for NodeContainerError {
    fn from(error: BridgeError) -> Self {
        Self::Bridge(error)
    }
}

/// Host-owned lifecycle port. Implementations must call the real Cordis host;
/// a Rust implementation is intentionally not supplied by this crate.
pub trait NodeContainerLifecyclePort {
    fn mount_candidate(
        &mut self,
        node_id: &str,
        plan_hash: &str,
        graph_hash: &str,
    ) -> Result<(), String>;
    fn drain(&mut self, node_id: &str) -> Result<(), String>;
    fn dispose(&mut self, node_id: &str) -> Result<(), String>;
}

#[derive(Debug)]
pub struct NodeContainer {
    node_id: String,
    plan: NodePluginPlan,
    bindings: PlanBindings,
    state: NodeContainerState,
}

impl NodeContainer {
    pub fn declare(
        node_id: impl Into<String>,
        plan: NodePluginPlan,
        bindings: PlanBindings,
    ) -> Result<Self, NodeContainerError> {
        if !plan.verify() {
            return Err(NodeContainerError::PlanHashMismatch);
        }
        if !bindings.verify() || bindings.loaded_plan_hash != plan.hash {
            return Err(NodeContainerError::BindingMismatch);
        }
        Ok(Self {
            node_id: node_id.into(),
            plan,
            bindings,
            state: NodeContainerState::Declared,
        })
    }

    pub fn node_id(&self) -> &str {
        &self.node_id
    }

    pub fn plan(&self) -> &NodePluginPlan {
        &self.plan
    }

    pub fn bindings(&self) -> &PlanBindings {
        &self.bindings
    }

    pub fn state(&self) -> NodeContainerState {
        self.state
    }

    pub fn context_created(&mut self) -> Result<(), NodeContainerError> {
        self.transition(
            NodeContainerState::Declared,
            NodeContainerState::ContextCreated,
            "context_created",
        )
    }

    pub fn plugins_mounted(&mut self) -> Result<(), NodeContainerError> {
        self.transition(
            NodeContainerState::ContextCreated,
            NodeContainerState::PluginsMounted,
            "plugins_mounted",
        )
    }

    pub fn publish(&mut self) -> Result<(), NodeContainerError> {
        // publish 即进入可接收状态：新请求使用新 plan，旧 in-flight 由 drain 收敛。
        // 不保留不可观测的 Published 中间态（生命周期表以可观测状态为准）。
        self.transition(
            NodeContainerState::PluginsMounted,
            NodeContainerState::Accepting,
            "publish",
        )
    }

    pub fn execute(
        &self,
        input: NodeExecutionInput,
        registry: &dyn HandleRegistry,
    ) -> Result<NodeExecutionOutput, NodeContainerError> {
        if self.state != NodeContainerState::Accepting {
            return Err(NodeContainerError::InvalidState {
                state: self.state,
                operation: "execute",
            });
        }
        execute_plan(&self.plan, input, registry).map_err(Into::into)
    }

    pub fn drain(&mut self) -> Result<(), NodeContainerError> {
        self.transition(
            NodeContainerState::Accepting,
            NodeContainerState::Draining,
            "drain",
        )
    }

    pub fn dispose(&mut self) -> Result<(), NodeContainerError> {
        match self.state {
            NodeContainerState::Disposed => Ok(()),
            NodeContainerState::Draining | NodeContainerState::Failed => {
                self.state = NodeContainerState::Disposed;
                Ok(())
            }
            state => Err(NodeContainerError::InvalidState {
                state,
                operation: "dispose",
            }),
        }
    }

    fn transition(
        &mut self,
        expected: NodeContainerState,
        next: NodeContainerState,
        operation: &'static str,
    ) -> Result<(), NodeContainerError> {
        if self.state != expected {
            return Err(NodeContainerError::InvalidState {
                state: self.state,
                operation,
            });
        }
        self.state = next;
        Ok(())
    }
}

/// Deterministic graph hash helper used by the real host adapter.
pub fn graph_hash(canonical_graph: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(canonical_graph.as_bytes());
    hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hash_binding_requires_three_equal_hashes() {
        let plan = routecodex_v4_plugin_plan::NodePluginPlan {
            node_id: "node".into(),
            position: 1,
            role_id: "role".into(),
            chain: "request".into(),
            entries: vec![],
            selection_groups: vec![],
            hash: String::new(),
        };
        let hash = plan.plan_hash();
        let plan = routecodex_v4_plugin_plan::NodePluginPlan {
            hash: hash.clone(),
            ..plan
        };
        let bindings = PlanBindings {
            graph_hash: hash.clone(),
            manifest_hash: hash.clone(),
            loaded_plan_hash: hash.clone(),
        };
        let container = NodeContainer::declare("node", plan, bindings).expect("valid binding");
        assert_eq!(container.state(), NodeContainerState::Declared);
    }

    #[test]
    fn lifecycle_is_strict_and_dispose_is_idempotent() {
        let plan = routecodex_v4_plugin_plan::NodePluginPlan {
            node_id: "node".into(),
            position: 1,
            role_id: "role".into(),
            chain: "request".into(),
            entries: vec![],
            selection_groups: vec![],
            hash: String::new(),
        };
        let hash = plan.plan_hash();
        let mut container = NodeContainer::declare(
            "node",
            routecodex_v4_plugin_plan::NodePluginPlan {
                hash: hash.clone(),
                ..plan
            },
            PlanBindings {
                graph_hash: hash.clone(),
                manifest_hash: hash.clone(),
                loaded_plan_hash: hash,
            },
        )
        .expect("valid binding");
        assert!(matches!(
            container.dispose(),
            Err(NodeContainerError::InvalidState { .. })
        ));
        container.context_created().unwrap();
        container.plugins_mounted().unwrap();
        container.publish().unwrap();
        container.drain().unwrap();
        container.dispose().unwrap();
        container.dispose().unwrap();
        assert_eq!(container.state(), NodeContainerState::Disposed);
    }
}
