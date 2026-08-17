//! Rust side of the V4 NodeContainer boundary.
//!
//! Cordis owns Context/Fiber/Effect creation and disposal in the host module.
//! This crate owns only the immutable typed plan binding and lifecycle state
//! machine consumed by management code. It never creates a Cordis-like
//! runtime, scans plugins, or chooses plugin order.

use routecodex_v4_cordis_bridge::{
    execute_plan, BridgeError, HandleRegistry, NodeExecutionInput, NodeExecutionOutput,
};
use routecodex_v4_plugin_plan::NodePluginPlan;
use sha2::{Digest, Sha256};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

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
    InFlightExecutions(usize),
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
            Self::InFlightExecutions(count) => {
                write!(
                    f,
                    "cannot drain node container while {count} execution(s) are in flight"
                )
            }
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

#[derive(Debug)]
pub struct NodeContainer {
    node_id: String,
    plan: NodePluginPlan,
    bindings: PlanBindings,
    state: NodeContainerState,
    in_flight: Arc<AtomicUsize>,
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
            in_flight: Arc::new(AtomicUsize::new(0)),
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

    pub fn in_flight(&self) -> usize {
        self.in_flight.load(Ordering::Acquire)
    }

    pub fn enter_execution(&self) -> Result<NodeExecutionGuard, NodeContainerError> {
        if self.state != NodeContainerState::Accepting {
            return Err(NodeContainerError::InvalidState {
                state: self.state,
                operation: "enter_execution",
            });
        }
        self.in_flight.fetch_add(1, Ordering::AcqRel);
        Ok(NodeExecutionGuard {
            in_flight: Arc::clone(&self.in_flight),
        })
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

    /// Reject a candidate before publish. Published containers must follow
    /// the normal accepting -> draining -> disposed path.
    pub fn fail(&mut self) -> Result<(), NodeContainerError> {
        match self.state {
            NodeContainerState::Declared
            | NodeContainerState::ContextCreated
            | NodeContainerState::PluginsMounted => {
                self.state = NodeContainerState::Failed;
                Ok(())
            }
            state => Err(NodeContainerError::InvalidState {
                state,
                operation: "fail",
            }),
        }
    }

    pub fn execute(
        &self,
        input: NodeExecutionInput,
        registry: &dyn HandleRegistry,
    ) -> Result<NodeExecutionOutput, NodeContainerError> {
        let _guard = self.enter_execution()?;
        execute_plan(&self.plan, input, registry).map_err(Into::into)
    }

    pub fn drain(&mut self) -> Result<(), NodeContainerError> {
        let in_flight = self.in_flight();
        if in_flight != 0 {
            return Err(NodeContainerError::InFlightExecutions(in_flight));
        }
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

#[derive(Debug)]
pub struct NodeExecutionGuard {
    in_flight: Arc<AtomicUsize>,
}

impl Drop for NodeExecutionGuard {
    fn drop(&mut self) {
        let previous = self.in_flight.fetch_sub(1, Ordering::AcqRel);
        debug_assert!(previous > 0, "node execution guard underflow");
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
