//! The single Rust data-plane execution owner.
//!
//! The engine deliberately receives an already ordered node path.  It never
//! scans authoring directories, sorts plugins, or reconstructs a graph.  A
//! node may return only one of the four contract outcomes; `Continue` carries
//! the data/control pair to the adjacent node, `Branch` follows a declared
//! edge, and `Terminal`/`Failure` close the request explicitly.

use crate::RuntimeFault;
use routecodex_v4_cordis_bridge::{HandleRegistry, NodeExecutionInput};
use routecodex_v4_node_container::{EpochLease, ExecutionEpochState};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::fmt;
use std::sync::Arc;

/// The request-local frame crossing adjacent nodes.  Data and control are
/// separate fields by type and are never merged into a metadata/payload blob.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct NodeExecutionFrame {
    pub data: Value,
    pub control: Value,
}

impl NodeExecutionFrame {
    pub fn new(data: Value, control: Value) -> Self {
        Self { data, control }
    }

    fn validate(&self) -> Result<(), ExecutionError> {
        if !self.data.is_object() || !self.control.is_object() {
            return Err(ExecutionError::InvalidFrame(
                "node frame data/control must be JSON objects".to_string(),
            ));
        }
        Ok(())
    }
}

/// Typed outcome of one node dispatch.  The variants intentionally mirror
/// `v4/contracts/node-outcome.schema.json` and carry no hidden control fields.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum NodeOutcome {
    Continue { data: Value, control: Value },
    Branch {
        edge_id: String,
        data: Value,
        control: Value,
    },
    Terminal { response: Value },
    Failure { error: Value },
}

impl NodeOutcome {
    fn validate(&self) -> Result<(), ExecutionError> {
        match self {
            Self::Branch { edge_id, .. } if edge_id.trim().is_empty() => {
                return Err(ExecutionError::InvalidOutcome(
                    "branch edge_id must not be empty".to_string(),
                ));
            }
            Self::Continue { data, control } | Self::Branch { data, control, .. } => {
                if !data.is_object() || !control.is_object() {
                    return Err(ExecutionError::InvalidOutcome(
                        "continue/branch data and control must be JSON objects".to_string(),
                    ));
                }
            }
            Self::Terminal { response } if !response.is_object() => {
                return Err(ExecutionError::InvalidOutcome(
                    "terminal response must be a JSON object".to_string(),
                ));
            }
            Self::Failure { error } if !error.is_object() => {
                return Err(ExecutionError::InvalidOutcome(
                    "failure error must be a JSON object".to_string(),
                ));
            }
            _ => {}
        }
        Ok(())
    }
}

type NodeFn = dyn Fn(NodeExecutionFrame) -> NodeOutcome + Send + Sync + 'static;

/// One pre-bound node implementation.  The path order is supplied by the
/// Cordis/plan owner; this type only stores declared branch edges.
pub struct ExecutionNode {
    node_id: String,
    edges: HashMap<String, String>,
    run: Arc<NodeFn>,
}

impl fmt::Debug for ExecutionNode {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ExecutionNode")
            .field("node_id", &self.node_id)
            .field("edges", &self.edges)
            .finish_non_exhaustive()
    }
}

impl ExecutionNode {
    pub fn new<F>(node_id: impl Into<String>, run: F) -> Self
    where
        F: Fn(NodeExecutionFrame) -> NodeOutcome + Send + Sync + 'static,
    {
        Self {
            node_id: node_id.into(),
            edges: HashMap::new(),
            run: Arc::new(run),
        }
    }

    pub fn continue_with<F>(node_id: impl Into<String>, run: F) -> Self
    where
        F: Fn(NodeExecutionFrame) -> NodeOutcome + Send + Sync + 'static,
    {
        Self::new(node_id, run)
    }

    pub fn terminal<F>(node_id: impl Into<String>, run: F) -> Self
    where
        F: Fn(NodeExecutionFrame) -> NodeOutcome + Send + Sync + 'static,
    {
        Self::new(node_id, run)
    }

    /// Declare one branch edge.  Edge targets are names from the same ordered
    /// path; no target is inferred from payload or plugin output.
    pub fn with_edge(mut self, edge_id: impl Into<String>, target_node: impl Into<String>) -> Self {
        self.edges.insert(edge_id.into(), target_node.into());
        self
    }

    pub fn node_id(&self) -> &str {
        &self.node_id
    }

}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ExecutionError {
    InvalidFrame(String),
    InvalidOutcome(String),
    EmptyEntrypoint,
    UnknownEntrypoint(String),
    DuplicateNode(String),
    UnknownNode(String),
    UndeclaredEdge { node_id: String, edge_id: String },
    RetiredLease(ExecutionEpochState),
    LeaseUnavailable(String),
    RuntimeFault(RuntimeFault),
}

impl fmt::Display for ExecutionError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidFrame(message) | Self::InvalidOutcome(message) => write!(formatter, "{message}"),
            Self::EmptyEntrypoint => write!(formatter, "entrypoint must not be empty"),
            Self::UnknownEntrypoint(entrypoint) => write!(formatter, "unknown entrypoint {entrypoint}"),
            Self::DuplicateNode(node_id) => write!(formatter, "duplicate execution node {node_id}"),
            Self::UnknownNode(node_id) => write!(formatter, "unknown execution node {node_id}"),
            Self::UndeclaredEdge { node_id, edge_id } => write!(formatter, "node {node_id} returned undeclared edge {edge_id}"),
            Self::RetiredLease(state) => write!(formatter, "execution epoch lease is {state:?}"),
            Self::LeaseUnavailable(message) => write!(formatter, "execution epoch lease unavailable: {message}"),
            Self::RuntimeFault(fault) => write!(formatter, "runtime fault: {fault}"),
        }
    }
}

impl std::error::Error for ExecutionError {}

impl From<RuntimeFault> for ExecutionError {
    fn from(fault: RuntimeFault) -> Self {
        Self::RuntimeFault(fault)
    }
}

/// The unique execution owner.  `nodes` is an immutable, already compiled
/// path; the engine performs no discovery, sorting, or fallback dispatch.
#[derive(Debug)]
pub struct ExecutionEngine {
    nodes: Vec<ExecutionNode>,
    indices: HashMap<String, usize>,
}

impl ExecutionEngine {
    pub fn new(nodes: Vec<ExecutionNode>) -> Self {
        let mut indices = HashMap::new();
        for (index, node) in nodes.iter().enumerate() {
            indices.entry(node.node_id.clone()).or_insert(index);
        }
        Self { nodes, indices }
    }

    pub fn try_new(nodes: Vec<ExecutionNode>) -> Result<Self, ExecutionError> {
        let mut seen = HashSet::new();
        for node in &nodes {
            if node.node_id.trim().is_empty() {
                return Err(ExecutionError::UnknownNode(node.node_id.clone()));
            }
            if !seen.insert(node.node_id.clone()) {
                return Err(ExecutionError::DuplicateNode(node.node_id.clone()));
            }
        }
        Ok(Self::new(nodes))
    }

    /// Execute against one immutable epoch lease. The caller owns the lease
    /// for the complete request lifecycle and may reuse it across stages.
    pub fn execute(
        &self,
        entrypoint: &str,
        frame: NodeExecutionFrame,
        lease: &EpochLease,
    ) -> Result<NodeOutcome, ExecutionError> {
        let snapshot = lease.snapshot();
        if snapshot.state == ExecutionEpochState::Disposed {
            return Err(ExecutionError::RetiredLease(snapshot.state));
        }
        self.execute_inner(entrypoint, frame)
    }

    fn execute_inner(
        &self,
        entrypoint: &str,
        mut frame: NodeExecutionFrame,
    ) -> Result<NodeOutcome, ExecutionError> {
        frame.validate()?;
        if entrypoint.trim().is_empty() {
            return Err(ExecutionError::EmptyEntrypoint);
        }
        if self.nodes.is_empty() {
            return Err(ExecutionError::UnknownEntrypoint(entrypoint.to_string()));
        }
        let mut index = self
            .indices
            .get(entrypoint)
            .copied()
            .or_else(|| (entrypoint == "entry").then_some(0))
            .ok_or_else(|| ExecutionError::UnknownEntrypoint(entrypoint.to_string()))?;
        let mut visited = HashSet::new();
        loop {
            let node = self
                .nodes
                .get(index)
                .ok_or_else(|| ExecutionError::UnknownNode(index.to_string()))?;
            if !visited.insert(index) {
                return Err(ExecutionError::RuntimeFault(RuntimeFault::new(
                    "execution_cycle",
                    format!("execution path revisited node {}", node.node_id),
                )));
            }
            let outcome = (node.run)(frame.clone());
            outcome.validate()?;
            match outcome {
                NodeOutcome::Continue { data, control } => {
                    frame = NodeExecutionFrame { data, control };
                    index += 1;
                    if index >= self.nodes.len() {
                        return Ok(NodeOutcome::Continue {
                            data: frame.data,
                            control: frame.control,
                        });
                    }
                }
                NodeOutcome::Branch { edge_id, data, control } => {
                    let target = node
                        .edges
                        .get(&edge_id)
                        .ok_or_else(|| ExecutionError::UndeclaredEdge {
                            node_id: node.node_id.clone(),
                            edge_id: edge_id.clone(),
                        })?;
                    index = *self
                        .indices
                        .get(target)
                        .ok_or_else(|| ExecutionError::UnknownNode(target.clone()))?;
                    frame = NodeExecutionFrame { data, control };
                }
                terminal @ NodeOutcome::Terminal { .. } => return Ok(terminal),
                failure @ NodeOutcome::Failure { .. } => return Ok(failure),
            }
        }
    }

    /// Execute the node container pinned by an epoch lease and project its
    /// typed bridge output into the same NodeOutcome contract.  This is the
    /// production adapter for a plan-backed node; it does not retain or clone
    /// a second container.
    pub fn execute_pinned_node(
        entrypoint: &str,
        frame: NodeExecutionFrame,
        lease: EpochLease,
        registry: &dyn HandleRegistry,
    ) -> Result<NodeOutcome, ExecutionError> {
        if entrypoint.trim().is_empty() {
            return Err(ExecutionError::EmptyEntrypoint);
        }
        frame.validate()?;
        let output = lease
            .execute(
                NodeExecutionInput {
                    data: frame.data,
                    control: frame.control,
                },
                registry,
            )
            .map_err(|error| ExecutionError::LeaseUnavailable(error.to_string()))?;
        let outcome = NodeOutcome::Continue {
            data: output.data,
            control: output.control,
        };
        outcome.validate()?;
        Ok(outcome)
    }
}
