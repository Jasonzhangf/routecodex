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
use serde::Deserialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, RwLock};

pub const ZERO_BASE_MANIFEST_HASH: &str =
    "sha256:0000000000000000000000000000000000000000000000000000000000000000";

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MaterializationError {
    Parse(String),
    InvalidIdentity(String),
    GraphHashMismatch,
    ManifestHashMismatch,
    PlanHashMismatch(String),
    PipelineMismatch(String),
    UnknownHandle(String),
    Container(NodeContainerError),
    Epoch(EpochError),
}

impl std::fmt::Display for MaterializationError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Parse(message) => write!(
                formatter,
                "compiled epoch candidate parse failed: {message}"
            ),
            Self::InvalidIdentity(field) => {
                write!(formatter, "compiled epoch candidate has invalid {field}")
            }
            Self::GraphHashMismatch => write!(
                formatter,
                "Cordis graph hash does not match the expected graph"
            ),
            Self::ManifestHashMismatch => write!(
                formatter,
                "compiled manifest hash does not match the expected manifest"
            ),
            Self::PlanHashMismatch(node_id) => {
                write!(formatter, "compiled plan hash mismatch for node {node_id}")
            }
            Self::PipelineMismatch(chain) => write!(
                formatter,
                "compiled pipeline order mismatch for chain {chain}"
            ),
            Self::UnknownHandle(plugin_id) => write!(
                formatter,
                "compiled epoch references unknown plugin handle {plugin_id}"
            ),
            Self::Container(error) => {
                write!(formatter, "compiled node materialization failed: {error}")
            }
            Self::Epoch(error) => {
                write!(formatter, "compiled epoch materialization failed: {error}")
            }
        }
    }
}

impl std::error::Error for MaterializationError {}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct CompiledExecutionEpochCandidate {
    schema_version: u32,
    candidate_id: String,
    epoch_id: String,
    plan_epoch: u64,
    manifest_hash: String,
    graph_hash: String,
    plugin_artifact_set_hash: String,
    entrypoints: HashMap<String, String>,
    pipelines: HashMap<String, Vec<String>>,
    nodes: Vec<CompiledExecutionNode>,
    policies: Value,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct CompiledExecutionNode {
    node_id: String,
    plan_hash: String,
    input_resource: String,
    output_resource: String,
    allowed_edges: HashMap<String, String>,
    plan: NodePluginPlan,
}

fn is_sha256(value: &str) -> bool {
    value.len() == 71
        && value.starts_with("sha256:")
        && value[7..]
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

/// Materialize one exact Cordis-compiled candidate. This is the sole bridge
/// from the serialized production graph into immutable Rust containers. It
/// validates external graph/manifest identity, preserves the supplied node
/// order, resolves every typed handle before publication, and never compiles
/// or sorts authoring input.
pub fn materialize_execution_epoch_bundle(
    value: &Value,
    expected_graph_hash: &str,
    expected_manifest_hash: &str,
    registry: &dyn HandleRegistry,
) -> Result<ExecutionEpochBundle, MaterializationError> {
    let candidate: CompiledExecutionEpochCandidate = serde_json::from_value(value.clone())
        .map_err(|error| MaterializationError::Parse(error.to_string()))?;
    if candidate.schema_version != 1
        || candidate.candidate_id.trim().is_empty()
        || candidate.epoch_id.trim().is_empty()
        || candidate.plan_epoch == 0
        || !is_sha256(&candidate.plugin_artifact_set_hash)
        || !candidate.policies.is_object()
    {
        return Err(MaterializationError::InvalidIdentity(
            "bundle identity".to_string(),
        ));
    }
    if candidate.graph_hash != expected_graph_hash || !is_sha256(&candidate.graph_hash) {
        return Err(MaterializationError::GraphHashMismatch);
    }
    if candidate.manifest_hash != expected_manifest_hash || !is_sha256(&candidate.manifest_hash) {
        return Err(MaterializationError::ManifestHashMismatch);
    }
    let mut node_ids = HashSet::new();
    let mut actual_pipelines = HashMap::<String, Vec<String>>::new();
    for node in &candidate.nodes {
        if node.node_id.trim().is_empty()
            || node.input_resource.trim().is_empty()
            || node.output_resource.trim().is_empty()
            || !node_ids.insert(node.node_id.clone())
        {
            return Err(MaterializationError::InvalidIdentity(
                "node identity".to_string(),
            ));
        }
        if node.node_id != node.plan.node_id
            || node.plan_hash != node.plan.hash
            || !node.plan.verify()
        {
            return Err(MaterializationError::PlanHashMismatch(node.node_id.clone()));
        }
        for entry in &node.plan.entries {
            if !registry.contains(&entry.plugin_id) {
                return Err(MaterializationError::UnknownHandle(entry.plugin_id.clone()));
            }
        }
        actual_pipelines
            .entry(node.plan.chain.clone())
            .or_default()
            .push(node.node_id.clone());
    }
    if candidate.nodes.is_empty() {
        return Err(MaterializationError::InvalidIdentity("nodes".to_string()));
    }
    for chain in ["request", "response", "error"] {
        let expected = candidate
            .pipelines
            .get(chain)
            .ok_or_else(|| MaterializationError::PipelineMismatch(chain.to_string()))?;
        let actual = actual_pipelines
            .get(chain)
            .ok_or_else(|| MaterializationError::PipelineMismatch(chain.to_string()))?;
        if expected != actual || candidate.entrypoints.get(chain) != expected.first() {
            return Err(MaterializationError::PipelineMismatch(chain.to_string()));
        }
    }
    if candidate.pipelines.len() != 3 || candidate.entrypoints.len() != 3 {
        return Err(MaterializationError::PipelineMismatch(
            "unknown".to_string(),
        ));
    }
    let mut nodes = Vec::with_capacity(candidate.nodes.len());
    for node in candidate.nodes {
        let plan_hash = node.plan.hash.clone();
        let mut container = NodeContainer::declare(
            node.node_id,
            node.plan,
            PlanBindings {
                graph_hash: plan_hash.clone(),
                manifest_hash: plan_hash.clone(),
                loaded_plan_hash: plan_hash,
            },
        )
        .map_err(MaterializationError::Container)?;
        container
            .context_created()
            .map_err(MaterializationError::Container)?;
        container
            .plugins_mounted()
            .map_err(MaterializationError::Container)?;
        container
            .publish()
            .map_err(MaterializationError::Container)?;
        nodes.push(ExecutionEpochNode::new(container, node.allowed_edges));
    }
    ExecutionEpochBundle::from_ordered_nodes(
        nodes,
        ExecutionEpochIdentity {
            plan_epoch: candidate.plan_epoch,
            manifest_hash: candidate.manifest_hash,
            execution_identity: candidate.epoch_id,
        },
    )
    .map_err(MaterializationError::Epoch)
}

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
    NodeIdentityMismatch,
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
            Self::NodeIdentityMismatch => {
                write!(
                    f,
                    "node container identity differs from the compiled plugin plan"
                )
            }
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
        let node_id = node_id.into();
        if node_id.is_empty() || node_id != plan.node_id {
            return Err(NodeContainerError::NodeIdentityMismatch);
        }
        if !plan.verify() {
            return Err(NodeContainerError::PlanHashMismatch);
        }
        if !bindings.verify() || bindings.loaded_plan_hash != plan.hash {
            return Err(NodeContainerError::BindingMismatch);
        }
        Ok(Self {
            node_id,
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

    /// Execute only against the immutable plan the caller names. The host
    /// port sends a plan hash instead of a second plan body so the active
    /// container plan remains the only plan truth for a request.
    pub fn execute_with_plan_hash(
        &self,
        expected_plan_hash: &str,
        input: NodeExecutionInput,
        registry: &dyn HandleRegistry,
    ) -> Result<NodeExecutionOutput, NodeContainerError> {
        if expected_plan_hash != self.plan.hash {
            return Err(NodeContainerError::PlanHashMismatch);
        }
        self.execute(input, registry)
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

/// Immutable identity carried by one executable epoch. The identity is
/// created before publication and never changes while the epoch is live.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExecutionEpochIdentity {
    pub plan_epoch: u64,
    pub manifest_hash: String,
    pub execution_identity: String,
}

impl ExecutionEpochIdentity {
    pub fn validate(&self) -> Result<(), EpochError> {
        if self.plan_epoch == 0
            || self.manifest_hash.is_empty()
            || self.execution_identity.is_empty()
        {
            return Err(EpochError::InvalidIdentity);
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExecutionEpochState {
    Active,
    Retired,
    Disposed,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExecutionEpochSnapshot {
    pub plan_epoch: u64,
    pub manifest_hash: String,
    pub execution_identity: String,
    pub in_flight_leases: usize,
    pub failure_count: u64,
    pub state: ExecutionEpochState,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EpochError {
    InvalidIdentity,
    CandidateNotAccepting,
    PublishBusy,
    LeaseUnavailable,
    NotRetired,
    InFlightLeases(usize),
    EmptyTransactionId,
    EmptyNodeSet,
    DuplicateNode(String),
    InvalidNodeOrder {
        chain: String,
        node_id: String,
    },
    UnknownChain(String),
    UnknownNode(String),
    UndeclaredEdge {
        node_id: String,
        edge_id: String,
    },
    StaleBase {
        expected_epoch: u64,
        actual_epoch: u64,
    },
    HashMismatch {
        expected: String,
        actual: String,
    },
    IdempotencyConflict {
        transaction_id: String,
    },
    UnknownTransaction {
        transaction_id: String,
    },
    InvalidTransactionState {
        transaction_id: String,
        state: EpochTransactionState,
        operation: &'static str,
    },
    Container(NodeContainerError),
}

impl std::fmt::Display for EpochError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidIdentity => write!(f, "execution epoch identity is incomplete"),
            Self::CandidateNotAccepting => write!(f, "execution epoch candidate is not accepting"),
            Self::PublishBusy => write!(f, "execution epoch publication is already in progress"),
            Self::LeaseUnavailable => write!(f, "active execution epoch is unavailable"),
            Self::NotRetired => write!(f, "execution epoch must be retired before disposal"),
            Self::InFlightLeases(count) => write!(f, "cannot dispose execution epoch with {count} lease(s)"),
            Self::EmptyTransactionId => write!(f, "execution epoch transaction id is required"),
            Self::EmptyNodeSet => write!(f, "execution epoch requires at least one compiled node"),
            Self::DuplicateNode(node_id) => write!(f, "execution epoch contains duplicate node {node_id}"),
            Self::InvalidNodeOrder { chain, node_id } => write!(f, "execution epoch node {node_id} is out of compiled order for chain {chain}"),
            Self::UnknownChain(chain) => write!(f, "execution epoch chain {chain} is unavailable"),
            Self::UnknownNode(node_id) => write!(f, "execution epoch node {node_id} is unavailable"),
            Self::UndeclaredEdge { node_id, edge_id } => write!(f, "execution epoch node {node_id} has no declared edge {edge_id}"),
            Self::StaleBase { expected_epoch, actual_epoch } => write!(f, "execution epoch transaction base is stale: expected {expected_epoch}, active {actual_epoch}"),
            Self::HashMismatch { expected, actual } => write!(f, "execution epoch candidate hash mismatch: expected {expected}, actual {actual}"),
            Self::IdempotencyConflict { transaction_id } => write!(f, "execution epoch transaction id {transaction_id} was reused with different input"),
            Self::UnknownTransaction { transaction_id } => write!(f, "unknown execution epoch transaction {transaction_id}"),
            Self::InvalidTransactionState { transaction_id, state, operation } => write!(f, "cannot {operation} execution epoch transaction {transaction_id} while {state:?}"),
            Self::Container(error) => write!(f, "execution epoch container failed: {error}"),
        }
    }
}

impl std::error::Error for EpochError {}

impl From<NodeContainerError> for EpochError {
    fn from(error: NodeContainerError) -> Self {
        Self::Container(error)
    }
}

struct EpochInner {
    identity: ExecutionEpochIdentity,
    nodes: Mutex<Option<Vec<ExecutionEpochNode>>>,
    state: Mutex<ExecutionEpochState>,
    leases: AtomicUsize,
    failures: AtomicU64,
    rollback_hold: std::sync::atomic::AtomicBool,
}

/// One Cordis-compiled node in exact bundle order. Runtime consumers may
/// execute the container or follow declared edges, but cannot reorder nodes.
#[derive(Debug)]
pub struct ExecutionEpochNode {
    container: NodeContainer,
    allowed_edges: HashMap<String, String>,
}

impl ExecutionEpochNode {
    pub fn new(container: NodeContainer, allowed_edges: HashMap<String, String>) -> Self {
        Self {
            container,
            allowed_edges,
        }
    }

    pub fn node_id(&self) -> &str {
        self.container.node_id()
    }

    pub fn chain(&self) -> &str {
        &self.container.plan().chain
    }

    pub fn position(&self) -> u32 {
        self.container.plan().position
    }
}

/// One immutable execution epoch. Admission pins this object with a lease;
/// publication only changes the store pointer, never the epoch identity.
#[derive(Clone)]
pub struct ExecutionEpochBundle {
    inner: Arc<EpochInner>,
}

impl std::fmt::Debug for ExecutionEpochBundle {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ExecutionEpochBundle")
            .field("snapshot", &self.snapshot())
            .finish()
    }
}

impl ExecutionEpochBundle {
    pub fn new(
        container: NodeContainer,
        identity: ExecutionEpochIdentity,
    ) -> Result<Self, EpochError> {
        Self::from_ordered_nodes(
            vec![ExecutionEpochNode::new(container, HashMap::new())],
            identity,
        )
    }

    pub fn from_ordered_nodes(
        nodes: Vec<ExecutionEpochNode>,
        identity: ExecutionEpochIdentity,
    ) -> Result<Self, EpochError> {
        identity.validate()?;
        if nodes.is_empty() {
            return Err(EpochError::EmptyNodeSet);
        }
        let mut seen = std::collections::HashSet::new();
        let mut last_chain = None::<String>;
        let mut closed_chains = std::collections::HashSet::new();
        let mut previous_position = 0;
        for node in &nodes {
            if node.container.state() != NodeContainerState::Accepting {
                return Err(EpochError::CandidateNotAccepting);
            }
            if !seen.insert(node.node_id().to_string()) {
                return Err(EpochError::DuplicateNode(node.node_id().to_string()));
            }
            if last_chain.as_deref() != Some(node.chain()) {
                if let Some(chain) = last_chain.replace(node.chain().to_string()) {
                    closed_chains.insert(chain);
                }
                if closed_chains.contains(node.chain()) {
                    return Err(EpochError::InvalidNodeOrder {
                        chain: node.chain().to_string(),
                        node_id: node.node_id().to_string(),
                    });
                }
                previous_position = 0;
            }
            if node.position() <= previous_position {
                return Err(EpochError::InvalidNodeOrder {
                    chain: node.chain().to_string(),
                    node_id: node.node_id().to_string(),
                });
            }
            previous_position = node.position();
        }
        for node in &nodes {
            if let Some(target) = node
                .allowed_edges
                .values()
                .find(|target| !seen.contains(*target))
            {
                return Err(EpochError::UnknownNode(target.clone()));
            }
        }
        if nodes
            .iter()
            .any(|node| node.container.state() != NodeContainerState::Accepting)
        {
            return Err(EpochError::CandidateNotAccepting);
        }
        Ok(Self {
            inner: Arc::new(EpochInner {
                identity,
                nodes: Mutex::new(Some(nodes)),
                state: Mutex::new(ExecutionEpochState::Active),
                leases: AtomicUsize::new(0),
                failures: AtomicU64::new(0),
                rollback_hold: std::sync::atomic::AtomicBool::new(false),
            }),
        })
    }

    pub fn snapshot(&self) -> ExecutionEpochSnapshot {
        let state = *self.inner.state.lock().expect("epoch state lock poisoned");
        ExecutionEpochSnapshot {
            plan_epoch: self.inner.identity.plan_epoch,
            manifest_hash: self.inner.identity.manifest_hash.clone(),
            execution_identity: self.inner.identity.execution_identity.clone(),
            in_flight_leases: self.inner.leases.load(Ordering::Acquire),
            failure_count: self.inner.failures.load(Ordering::Acquire),
            state,
        }
    }

    pub fn record_execution_failure(&self) -> ExecutionEpochSnapshot {
        self.inner.failures.fetch_add(1, Ordering::AcqRel);
        self.snapshot()
    }

    pub fn admit(&self) -> Result<EpochLease, EpochError> {
        self.acquire()
    }

    fn acquire(&self) -> Result<EpochLease, EpochError> {
        let state = self.inner.state.lock().expect("epoch state lock poisoned");
        if *state != ExecutionEpochState::Active {
            return Err(EpochError::LeaseUnavailable);
        }
        self.inner.leases.fetch_add(1, Ordering::AcqRel);
        drop(state);
        Ok(EpochLease {
            epoch: self.clone(),
            released: false,
        })
    }

    fn retire(&self) -> Result<ExecutionEpochSnapshot, EpochError> {
        let mut state = self.inner.state.lock().expect("epoch state lock poisoned");
        if *state != ExecutionEpochState::Active {
            return Err(EpochError::PublishBusy);
        }
        *state = ExecutionEpochState::Retired;
        drop(state);
        self.try_dispose()?;
        Ok(self.snapshot())
    }

    fn release_lease(&self) -> Result<ExecutionEpochSnapshot, EpochError> {
        let previous = self.inner.leases.fetch_sub(1, Ordering::AcqRel);
        if previous == 0 {
            self.inner.leases.fetch_add(1, Ordering::Release);
            return Err(EpochError::LeaseUnavailable);
        }
        self.try_dispose()?;
        Ok(self.snapshot())
    }

    fn hold_for_rollback(&self) {
        self.inner.rollback_hold.store(true, Ordering::Release);
    }

    fn restore_active(&self) -> Result<(), EpochError> {
        let mut state = self.inner.state.lock().expect("epoch state lock poisoned");
        if *state != ExecutionEpochState::Retired {
            return Err(EpochError::NotRetired);
        }
        self.inner.rollback_hold.store(false, Ordering::Release);
        *state = ExecutionEpochState::Active;
        Ok(())
    }

    fn release_rollback_hold(&self) -> Result<ExecutionEpochSnapshot, EpochError> {
        self.inner.rollback_hold.store(false, Ordering::Release);
        self.try_dispose()?;
        Ok(self.snapshot())
    }

    fn try_dispose(&self) -> Result<(), EpochError> {
        if *self.inner.state.lock().expect("epoch state lock poisoned")
            != ExecutionEpochState::Retired
        {
            return Ok(());
        }
        if self.inner.rollback_hold.load(Ordering::Acquire) {
            return Ok(());
        }
        let leases = self.inner.leases.load(Ordering::Acquire);
        if leases != 0 {
            return Ok(());
        }
        let mut nodes = self.inner.nodes.lock().expect("epoch nodes lock poisoned");
        if let Some(nodes) = nodes.as_mut() {
            for node in nodes {
                node.container.drain()?;
                node.container.dispose()?;
            }
        }
        *nodes = None;
        *self.inner.state.lock().expect("epoch state lock poisoned") =
            ExecutionEpochState::Disposed;
        Ok(())
    }
}

pub struct EpochLease {
    epoch: ExecutionEpochBundle,
    released: bool,
}

impl std::fmt::Debug for EpochLease {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("EpochLease")
            .field("snapshot", &self.epoch.snapshot())
            .field("released", &self.released)
            .finish()
    }
}

impl EpochLease {
    pub fn snapshot(&self) -> ExecutionEpochSnapshot {
        self.epoch.snapshot()
    }

    /// Execute against the immutable container pinned by this lease.  The
    /// lease owns the epoch admission; callers cannot substitute another plan
    /// or container while the request is in flight.
    pub fn execute(
        &self,
        node_id: &str,
        input: NodeExecutionInput,
        registry: &dyn HandleRegistry,
    ) -> Result<NodeExecutionOutput, EpochError> {
        if self.snapshot().state == ExecutionEpochState::Disposed {
            return Err(EpochError::Container(NodeContainerError::InvalidState {
                state: NodeContainerState::Disposed,
                operation: "execute",
            }));
        }
        let nodes = self
            .epoch
            .inner
            .nodes
            .lock()
            .expect("epoch nodes lock poisoned");
        let nodes =
            nodes
                .as_ref()
                .ok_or(EpochError::Container(NodeContainerError::InvalidState {
                    state: NodeContainerState::Disposed,
                    operation: "execute",
                }))?;
        let node = nodes
            .iter()
            .find(|node| node.node_id() == node_id)
            .ok_or_else(|| EpochError::UnknownNode(node_id.to_string()))?;
        node.container
            .execute(input, registry)
            .map_err(EpochError::Container)
    }

    pub fn plan_hash(&self, node_id: &str) -> Result<String, EpochError> {
        let nodes = self
            .epoch
            .inner
            .nodes
            .lock()
            .expect("epoch nodes lock poisoned");
        let nodes =
            nodes
                .as_ref()
                .ok_or(EpochError::Container(NodeContainerError::InvalidState {
                    state: NodeContainerState::Disposed,
                    operation: "read_plan_hash",
                }))?;
        nodes
            .iter()
            .find(|node| node.node_id() == node_id)
            .map(|node| node.container.plan().hash.clone())
            .ok_or_else(|| EpochError::UnknownNode(node_id.to_string()))
    }

    pub fn entrypoint(&self, chain: &str) -> Result<String, EpochError> {
        let nodes = self
            .epoch
            .inner
            .nodes
            .lock()
            .expect("epoch nodes lock poisoned");
        let nodes = nodes.as_ref().ok_or(EpochError::LeaseUnavailable)?;
        nodes
            .iter()
            .find(|node| node.chain() == chain)
            .map(|node| node.node_id().to_string())
            .ok_or_else(|| EpochError::UnknownChain(chain.to_string()))
    }

    pub fn next_node(&self, chain: &str, node_id: &str) -> Result<Option<String>, EpochError> {
        let nodes = self
            .epoch
            .inner
            .nodes
            .lock()
            .expect("epoch nodes lock poisoned");
        let nodes = nodes.as_ref().ok_or(EpochError::LeaseUnavailable)?;
        let index = nodes
            .iter()
            .position(|node| node.node_id() == node_id && node.chain() == chain)
            .ok_or_else(|| EpochError::UnknownNode(node_id.to_string()))?;
        Ok(nodes
            .get(index + 1)
            .filter(|next| next.chain() == chain)
            .map(|next| next.node_id().to_string()))
    }

    pub fn branch_target(&self, node_id: &str, edge_id: &str) -> Result<String, EpochError> {
        let nodes = self
            .epoch
            .inner
            .nodes
            .lock()
            .expect("epoch nodes lock poisoned");
        let nodes = nodes.as_ref().ok_or(EpochError::LeaseUnavailable)?;
        let node = nodes
            .iter()
            .find(|node| node.node_id() == node_id)
            .ok_or_else(|| EpochError::UnknownNode(node_id.to_string()))?;
        node.allowed_edges
            .get(edge_id)
            .cloned()
            .ok_or_else(|| EpochError::UndeclaredEdge {
                node_id: node_id.to_string(),
                edge_id: edge_id.to_string(),
            })
    }

    pub fn release(mut self) -> Result<ExecutionEpochSnapshot, EpochError> {
        if self.released {
            return Err(EpochError::LeaseUnavailable);
        }
        self.released = true;
        self.epoch.release_lease()
    }
}

impl Drop for EpochLease {
    fn drop(&mut self) {
        if !self.released {
            let _ = self.epoch.release_lease();
            self.released = true;
        }
    }
}

/// Atomic active-pointer owner. Candidate publication retires the old epoch;
/// only lease release can make the old physical container disposable.
pub struct ActiveEpochStore {
    active: RwLock<Option<ExecutionEpochBundle>>,
    transactions: Mutex<HashMap<String, EpochTransactionRecord>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EpochTransactionState {
    Prepared,
    Committed,
    Aborted,
    Draining,
    RolledBack,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EpochTransactionSnapshot {
    pub transaction_id: String,
    pub state: EpochTransactionState,
    pub plan_epoch: u64,
    pub manifest_hash: String,
}

struct EpochTransactionRecord {
    base_epoch: u64,
    base_manifest_hash: String,
    candidate_hash: String,
    candidate: ExecutionEpochBundle,
    previous: Option<ExecutionEpochBundle>,
    state: EpochTransactionState,
}

impl EpochTransactionRecord {
    fn snapshot(&self, transaction_id: &str) -> EpochTransactionSnapshot {
        let candidate = self.candidate.snapshot();
        EpochTransactionSnapshot {
            transaction_id: transaction_id.to_string(),
            state: self.state,
            plan_epoch: candidate.plan_epoch,
            manifest_hash: candidate.manifest_hash,
        }
    }
}

impl std::fmt::Debug for ActiveEpochStore {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ActiveEpochStore")
            .field("active", &self.active_snapshot())
            .finish()
    }
}

impl ActiveEpochStore {
    /// Construct a store before Cordis has committed an epoch. Admission
    /// must fail closed until a validated candidate is published.
    pub fn empty() -> Self {
        Self {
            active: RwLock::new(None),
            transactions: Mutex::new(HashMap::new()),
        }
    }

    pub fn new(active: ExecutionEpochBundle) -> Self {
        Self {
            active: RwLock::new(Some(active)),
            transactions: Mutex::new(HashMap::new()),
        }
    }

    pub fn active_snapshot(&self) -> Option<ExecutionEpochSnapshot> {
        self.active
            .read()
            .expect("active epoch lock poisoned")
            .as_ref()
            .map(ExecutionEpochBundle::snapshot)
    }

    /// Return the exact immutable bundle currently admitted by the store.
    /// Consumers receive the same Arc-backed bundle; they cannot rebuild its
    /// identity or substitute a second active configuration.
    pub fn active_bundle(&self) -> Option<ExecutionEpochBundle> {
        self.active
            .read()
            .expect("active epoch lock poisoned")
            .clone()
    }

    pub fn admit(&self) -> Result<EpochLease, EpochError> {
        let active = self
            .active
            .read()
            .expect("active epoch lock poisoned")
            .clone()
            .ok_or(EpochError::LeaseUnavailable)?;
        active.acquire()
    }

    pub fn record_execution_failure(&self) -> Result<ExecutionEpochSnapshot, EpochError> {
        let active = self
            .active
            .read()
            .expect("active epoch lock poisoned")
            .clone()
            .ok_or(EpochError::LeaseUnavailable)?;
        Ok(active.record_execution_failure())
    }

    pub fn publish(
        &self,
        candidate: ExecutionEpochBundle,
    ) -> Result<ExecutionEpochSnapshot, EpochError> {
        let mut active = self.active.write().expect("active epoch lock poisoned");
        if candidate.snapshot().state != ExecutionEpochState::Active {
            return Err(EpochError::CandidateNotAccepting);
        }
        let previous = active.replace(candidate);
        drop(active);
        if let Some(previous) = previous {
            previous.retire()?;
        }
        self.active_snapshot().ok_or(EpochError::LeaseUnavailable)
    }

    /// Opens a single immutable epoch transaction; callers must explicitly commit or abort.
    pub fn prepare(
        &self,
        transaction_id: impl Into<String>,
        base_epoch: u64,
        base_manifest_hash: &str,
        candidate: ExecutionEpochBundle,
        candidate_hash: &str,
    ) -> Result<EpochTransactionSnapshot, EpochError> {
        let transaction_id = transaction_id.into();
        if transaction_id.is_empty() {
            return Err(EpochError::EmptyTransactionId);
        }
        let candidate_snapshot = candidate.snapshot();
        if candidate_snapshot.manifest_hash != candidate_hash {
            return Err(EpochError::HashMismatch {
                expected: candidate_hash.to_string(),
                actual: candidate_snapshot.manifest_hash,
            });
        }
        let active = self
            .active
            .read()
            .expect("active epoch lock poisoned")
            .clone();
        match active.as_ref().map(ExecutionEpochBundle::snapshot) {
            Some(active_snapshot)
                if active_snapshot.plan_epoch == base_epoch
                    && active_snapshot.manifest_hash == base_manifest_hash => {}
            Some(active_snapshot) => {
                return Err(EpochError::StaleBase {
                    expected_epoch: base_epoch,
                    actual_epoch: active_snapshot.plan_epoch,
                });
            }
            None if base_epoch == 0 && base_manifest_hash == ZERO_BASE_MANIFEST_HASH => {}
            None => {
                return Err(EpochError::StaleBase {
                    expected_epoch: base_epoch,
                    actual_epoch: 0,
                });
            }
        }
        let mut transactions = self
            .transactions
            .lock()
            .expect("epoch transaction lock poisoned");
        if let Some(existing) = transactions.get(&transaction_id) {
            if existing.base_epoch != base_epoch
                || existing.base_manifest_hash != base_manifest_hash
                || existing.candidate_hash != candidate_hash
                || existing.candidate.snapshot() != candidate_snapshot
            {
                return Err(EpochError::IdempotencyConflict { transaction_id });
            }
            return Ok(existing.snapshot(&transaction_id));
        }
        let record = EpochTransactionRecord {
            base_epoch,
            base_manifest_hash: base_manifest_hash.to_string(),
            candidate_hash: candidate_hash.to_string(),
            candidate,
            previous: None,
            state: EpochTransactionState::Prepared,
        };
        let snapshot = record.snapshot(&transaction_id);
        transactions.insert(transaction_id, record);
        Ok(snapshot)
    }

    pub fn commit(&self, transaction_id: &str) -> Result<EpochTransactionSnapshot, EpochError> {
        let mut transactions = self
            .transactions
            .lock()
            .expect("epoch transaction lock poisoned");
        let record =
            transactions
                .get_mut(transaction_id)
                .ok_or_else(|| EpochError::UnknownTransaction {
                    transaction_id: transaction_id.to_string(),
                })?;
        if record.state == EpochTransactionState::Committed {
            return Ok(record.snapshot(transaction_id));
        }
        if record.state != EpochTransactionState::Prepared {
            return Err(EpochError::InvalidTransactionState {
                transaction_id: transaction_id.to_string(),
                state: record.state,
                operation: "commit",
            });
        }
        let mut active = self.active.write().expect("active epoch lock poisoned");
        match active.as_ref().map(ExecutionEpochBundle::snapshot) {
            Some(current_snapshot)
                if current_snapshot.plan_epoch == record.base_epoch
                    && current_snapshot.manifest_hash == record.base_manifest_hash => {}
            Some(current_snapshot) => {
                return Err(EpochError::StaleBase {
                    expected_epoch: record.base_epoch,
                    actual_epoch: current_snapshot.plan_epoch,
                });
            }
            None if record.base_epoch == 0
                && record.base_manifest_hash == ZERO_BASE_MANIFEST_HASH => {}
            None => {
                return Err(EpochError::StaleBase {
                    expected_epoch: record.base_epoch,
                    actual_epoch: 0,
                });
            }
        }
        let previous = active.replace(record.candidate.clone());
        if let Some(previous) = previous.as_ref() {
            previous.hold_for_rollback();
            previous.retire()?;
        }
        record.previous = previous;
        record.state = EpochTransactionState::Committed;
        Ok(record.snapshot(transaction_id))
    }

    pub fn abort(&self, transaction_id: &str) -> Result<EpochTransactionSnapshot, EpochError> {
        let mut transactions = self
            .transactions
            .lock()
            .expect("epoch transaction lock poisoned");
        let record =
            transactions
                .get_mut(transaction_id)
                .ok_or_else(|| EpochError::UnknownTransaction {
                    transaction_id: transaction_id.to_string(),
                })?;
        if record.state == EpochTransactionState::Aborted {
            return Ok(record.snapshot(transaction_id));
        }
        if record.state != EpochTransactionState::Prepared {
            return Err(EpochError::InvalidTransactionState {
                transaction_id: transaction_id.to_string(),
                state: record.state,
                operation: "abort",
            });
        }
        record.state = EpochTransactionState::Aborted;
        Ok(record.snapshot(transaction_id))
    }

    pub fn drain(&self, transaction_id: &str) -> Result<EpochTransactionSnapshot, EpochError> {
        let mut transactions = self
            .transactions
            .lock()
            .expect("epoch transaction lock poisoned");
        let record =
            transactions
                .get_mut(transaction_id)
                .ok_or_else(|| EpochError::UnknownTransaction {
                    transaction_id: transaction_id.to_string(),
                })?;
        if record.state == EpochTransactionState::Draining {
            return Ok(record.snapshot(transaction_id));
        }
        if record.state != EpochTransactionState::Committed {
            return Err(EpochError::InvalidTransactionState {
                transaction_id: transaction_id.to_string(),
                state: record.state,
                operation: "drain",
            });
        }
        if let Some(previous) = record.previous.as_ref() {
            previous.release_rollback_hold()?;
        }
        record.state = EpochTransactionState::Draining;
        Ok(record.snapshot(transaction_id))
    }

    pub fn rollback(&self, transaction_id: &str) -> Result<EpochTransactionSnapshot, EpochError> {
        let mut transactions = self
            .transactions
            .lock()
            .expect("epoch transaction lock poisoned");
        let record =
            transactions
                .get_mut(transaction_id)
                .ok_or_else(|| EpochError::UnknownTransaction {
                    transaction_id: transaction_id.to_string(),
                })?;
        if record.state != EpochTransactionState::Committed {
            return Err(EpochError::InvalidTransactionState {
                transaction_id: transaction_id.to_string(),
                state: record.state,
                operation: "rollback",
            });
        }
        let previous = record.previous.clone().ok_or(EpochError::NotRetired)?;
        let mut active = self.active.write().expect("active epoch lock poisoned");
        if active.as_ref().map(|value| value.snapshot()) != Some(record.candidate.snapshot()) {
            return Err(EpochError::StaleBase {
                expected_epoch: record.candidate.snapshot().plan_epoch,
                actual_epoch: active
                    .as_ref()
                    .map(|value| value.snapshot().plan_epoch)
                    .unwrap_or(0),
            });
        }
        record.candidate.retire()?;
        record.candidate.try_dispose()?;
        previous.restore_active()?;
        *active = Some(previous);
        record.state = EpochTransactionState::RolledBack;
        Ok(record.snapshot(transaction_id))
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

    fn accepting_container(node_id: &str) -> NodeContainer {
        let plan = routecodex_v4_plugin_plan::NodePluginPlan {
            node_id: node_id.into(),
            position: 1,
            role_id: "role".into(),
            chain: "request".into(),
            entries: vec![],
            selection_groups: vec![],
            hash: String::new(),
        };
        let hash = plan.plan_hash();
        let mut container = NodeContainer::declare(
            node_id,
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
        container.context_created().unwrap();
        container.plugins_mounted().unwrap();
        container.publish().unwrap();
        container
    }

    fn epoch(node_id: &str, plan_epoch: u64) -> ExecutionEpochBundle {
        ExecutionEpochBundle::new(
            accepting_container(node_id),
            ExecutionEpochIdentity {
                plan_epoch,
                manifest_hash: format!("manifest-{plan_epoch}"),
                execution_identity: format!("execution-{plan_epoch}"),
            },
        )
        .unwrap()
    }

    #[test]
    fn publish_keeps_old_epoch_until_last_lease_releases() {
        let store = ActiveEpochStore::new(epoch("old", 1));
        let old_lease = store.admit().unwrap();
        let published = store.publish(epoch("new", 2)).unwrap();
        assert_eq!(published.plan_epoch, 2);
        assert_eq!(old_lease.snapshot().state, ExecutionEpochState::Retired);
        assert_eq!(old_lease.snapshot().in_flight_leases, 1);
        let released = old_lease.release().unwrap();
        assert_eq!(released.state, ExecutionEpochState::Disposed);
        assert_eq!(store.active_snapshot().unwrap().plan_epoch, 2);
    }

    #[test]
    fn execution_failure_is_passive_and_does_not_change_active_epoch() {
        let store = ActiveEpochStore::new(epoch("active", 7));
        let active = store.active_snapshot().unwrap();
        let lease = store.admit().unwrap();
        let failure = store.record_execution_failure().unwrap();
        assert_eq!(failure.failure_count, 1);
        assert_eq!(failure.plan_epoch, active.plan_epoch);
        assert_eq!(
            store.active_snapshot().unwrap().state,
            ExecutionEpochState::Active
        );
        lease.release().unwrap();
    }

    #[test]
    fn candidate_rejection_does_not_mutate_active_pointer() {
        let store = ActiveEpochStore::new(epoch("active", 3));
        let rejected = ExecutionEpochBundle::new(
            accepting_container("candidate"),
            ExecutionEpochIdentity {
                plan_epoch: 4,
                manifest_hash: String::new(),
                execution_identity: "candidate".into(),
            },
        );
        assert!(matches!(rejected, Err(EpochError::InvalidIdentity)));
        assert_eq!(store.active_snapshot().unwrap().plan_epoch, 3);
    }

    #[test]
    fn rebuild_preserves_immutable_execution_identity() {
        let identity = ExecutionEpochIdentity {
            plan_epoch: 11,
            manifest_hash: "manifest-stable".into(),
            execution_identity: "execution-stable".into(),
        };
        let first =
            ExecutionEpochBundle::new(accepting_container("first"), identity.clone()).unwrap();
        let rebuilt = ExecutionEpochBundle::new(accepting_container("rebuilt"), identity).unwrap();
        assert_eq!(first.snapshot().plan_epoch, rebuilt.snapshot().plan_epoch);
        assert_eq!(
            first.snapshot().manifest_hash,
            rebuilt.snapshot().manifest_hash
        );
        assert_eq!(
            first.snapshot().execution_identity,
            rebuilt.snapshot().execution_identity
        );
    }
}
