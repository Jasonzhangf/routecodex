//! The single Rust data-plane execution owner.
//!
//! The engine deliberately receives an already ordered node path.  It never
//! scans authoring directories, sorts plugins, or reconstructs a graph.  A
//! node may return only one of the four contract outcomes; `Continue` carries
//! the data/control pair to the adjacent node, `Branch` follows a declared
//! edge, and `Terminal`/`Failure` close the request explicitly.

use crate::RuntimeFault;
use routecodex_v4_cordis_bridge::{
    DiagnosticFact, HandleRegistry, NodeExecutionInput, SharedTransportCarrier,
};
use routecodex_v4_node_container::{EpochLease, ExecutionEpochState};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashSet;
use std::fmt;

/// Production stage checkpoints emitted by the node execution owner. These
/// are diagnostic facts only; they never enter business data or control.
fn stage_ids_for_node(chain: &str, node_id: &str) -> &'static [&'static str] {
    match (chain, node_id) {
        ("relay_request", "V4ServerReqInbound01ClientRaw") => &["request.inbound_normalize"],
        ("relay_request", "V4HubReqInbound02Normalized") => &["request.continuation_classify"],
        ("relay_request", "V4HubReqChatProcess03Governed") => &["request.chat_process"],
        ("relay_request", "V4HubReqExecution04Planned") => {
            &["request.execution_plan", "request.route_facts"]
        }
        ("relay_request", "V4HubReqTarget05Resolved") => &["request.target_resolve"],
        ("relay_request", "V4HubReqOutbound06ProviderSemantic") => &["request.provider_semantic"],
        ("relay_request", "V4ProviderReqOutbound08WirePayload") => &["request.wire_build"],
        ("relay_request", "V4ProviderReqOutbound09TransportRequest") => &["request.transport"],
        ("relay_response", "V4ProviderRespInbound01Raw") => &["response.provider_inbound"],
        ("relay_response", "V4HubRespInbound03Normalized") => &["response.normalize"],
        ("relay_response", "V4HubRespChatProcess04Governed") => {
            &["response.response_process", "response.continuation_commit"]
        }
        ("relay_response", "V4HubRespOutbound05ClientSemantic") => &["response.client_projection"],
        ("relay_response", "V4ServerRespOutbound06ClientFrame") => &["response.frame"],
        _ => &[],
    }
}

/// The request-local frame crossing adjacent nodes.  Data and control are
/// separate fields by type and are never merged into a metadata/payload blob.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct NodeExecutionFrame {
    pub data: Value,
    pub control: Value,
    pub information: Value,
    pub events: Vec<DiagnosticFact>,
    #[serde(skip)]
    pub shared_data: crate::ImmutableDataCarrier,
    #[serde(skip)]
    pub shared_information: crate::ImmutableInformationCarrier,
    #[serde(skip)]
    pub shared_diagnostic: crate::ImmutableDiagnosticCarrier,
    #[serde(skip)]
    pub transport: Option<SharedTransportCarrier>,
}

impl NodeExecutionFrame {
    pub fn new(data: Value, control: Value) -> Self {
        let shared_data = crate::ImmutableDataCarrier::from_value(&data)
            .expect("JSON data must be encodable");
        Self {
            data,
            control,
            information: Value::Object(Default::default()),
            events: Vec::new(),
            shared_data,
            shared_information: crate::ImmutableInformationCarrier::new("unknown", "unknown"),
            shared_diagnostic: crate::ImmutableDiagnosticCarrier::new("unbound"),
            transport: None,
        }
    }

    pub fn with_information(data: Value, control: Value, information: Value) -> Self {
        let shared_data = crate::ImmutableDataCarrier::from_value(&data)
            .expect("JSON data must be encodable");
        Self {
            data,
            control,
            information,
            events: Vec::new(),
            shared_data,
            shared_information: crate::ImmutableInformationCarrier::new("unknown", "unknown"),
            shared_diagnostic: crate::ImmutableDiagnosticCarrier::new("unbound"),
            transport: None,
        }
    }

    pub fn with_side_channels(
        data: Value,
        control: Value,
        information: Value,
        events: Vec<DiagnosticFact>,
    ) -> Self {
        let shared_data = crate::ImmutableDataCarrier::from_value(&data)
            .expect("JSON data must be encodable");
        Self {
            data,
            control,
            information,
            events,
            shared_data,
            shared_information: crate::ImmutableInformationCarrier::new("unknown", "unknown"),
            shared_diagnostic: crate::ImmutableDiagnosticCarrier::new("unbound"),
            transport: None,
        }
    }

    pub fn with_shared_carriers(
        data: Value,
        control: Value,
        information: Value,
        events: Vec<DiagnosticFact>,
        shared_data: crate::ImmutableDataCarrier,
        shared_information: crate::ImmutableInformationCarrier,
        shared_diagnostic: crate::ImmutableDiagnosticCarrier,
    ) -> Self {
        Self {
            data,
            control,
            information,
            events,
            shared_data,
            shared_information,
            shared_diagnostic,
            transport: None,
        }
    }

    pub fn with_transport(mut self, transport: SharedTransportCarrier) -> Self {
        self.transport = Some(transport);
        self
    }

    pub fn shares_immutable_carriers_with(&self, other: &Self) -> bool {
        self.shared_data.shares_storage_with(&other.shared_data)
            && self.shared_information.shares_storage_with(&other.shared_information)
            && self.shared_diagnostic.shares_storage_with(&other.shared_diagnostic)
    }

    pub fn shared_data(&self) -> &crate::ImmutableDataCarrier {
        &self.shared_data
    }

    pub fn shared_information(&self) -> &crate::ImmutableInformationCarrier {
        &self.shared_information
    }

    pub fn shared_diagnostic(&self) -> &crate::ImmutableDiagnosticCarrier {
        &self.shared_diagnostic
    }

    fn validate(&self) -> Result<(), ExecutionError> {
        if !self.data.is_object() || !self.control.is_object() || !self.information.is_object() {
            return Err(ExecutionError::InvalidFrame(
                "node frame data/control/information must be JSON objects".to_string(),
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
    Continue {
        data: Value,
        control: Value,
        information: Value,
        events: Vec<DiagnosticFact>,
    },
    Branch {
        edge_id: String,
        data: Value,
        control: Value,
        information: Value,
        events: Vec<DiagnosticFact>,
    },
    Terminal {
        response: Value,
    },
    Failure {
        error: Value,
    },
}

impl NodeOutcome {
    fn validate(&self) -> Result<(), ExecutionError> {
        match self {
            Self::Branch { edge_id, .. } if edge_id.trim().is_empty() => {
                return Err(ExecutionError::InvalidOutcome(
                    "branch edge_id must not be empty".to_string(),
                ));
            }
            Self::Continue { data, control, information, .. }
            | Self::Branch { data, control, information, .. } => {
                if !data.is_object() || !control.is_object() || !information.is_object() {
                    return Err(ExecutionError::InvalidOutcome(
                        "continue/branch data, control and information must be JSON objects".to_string(),
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
            Self::InvalidFrame(message) | Self::InvalidOutcome(message) => {
                write!(formatter, "{message}")
            }
            Self::EmptyEntrypoint => write!(formatter, "entrypoint must not be empty"),
            Self::UnknownEntrypoint(entrypoint) => {
                write!(formatter, "unknown entrypoint {entrypoint}")
            }
            Self::DuplicateNode(node_id) => write!(formatter, "duplicate execution node {node_id}"),
            Self::UnknownNode(node_id) => write!(formatter, "unknown execution node {node_id}"),
            Self::UndeclaredEdge { node_id, edge_id } => write!(
                formatter,
                "node {node_id} returned undeclared edge {edge_id}"
            ),
            Self::RetiredLease(state) => write!(formatter, "execution epoch lease is {state:?}"),
            Self::LeaseUnavailable(message) => {
                write!(formatter, "execution epoch lease unavailable: {message}")
            }
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

/// The unique execution owner. The engine has no local graph or registry; it
/// consumes only the exact ordered nodes pinned by the admitted epoch lease.
#[derive(Debug, Default)]
pub struct ExecutionEngine;

impl ExecutionEngine {
    /// Execute the complete compiled chain pinned by an epoch lease. Each
    /// adjacent output becomes the next node input; order comes only from the
    /// bundle and is never reconstructed or sorted here.
    pub fn execute_pinned_node(
        chain: &str,
        frame: NodeExecutionFrame,
        lease: &EpochLease,
        registry: &dyn HandleRegistry,
    ) -> Result<NodeOutcome, ExecutionError> {
        Self::execute_pinned_node_until(chain, frame, lease, registry, None)
    }

    /// Execute a compiled chain through a declared node boundary. This is
    /// used for control-only pre-dispatch slices (for example route facts and
    /// target selection) while preserving the same NodeContainer/PluginHandle
    /// execution owner as full request/response paths.
    pub fn execute_pinned_node_until(
        chain: &str,
        mut frame: NodeExecutionFrame,
        lease: &EpochLease,
        registry: &dyn HandleRegistry,
        stop_node: Option<&str>,
    ) -> Result<NodeOutcome, ExecutionError> {
        Self::execute_pinned_node_from(chain, None, frame, lease, registry, stop_node)
    }

    /// Execute a declared suffix of a compiled chain.  This is used only for
    /// production control pre-dispatch slices whose predecessor already ran
    /// in the same request owner; it never reconstructs or sorts graph state.
    pub fn execute_pinned_node_from(
        chain: &str,
        start_node: Option<&str>,
        mut frame: NodeExecutionFrame,
        lease: &EpochLease,
        registry: &dyn HandleRegistry,
        stop_node: Option<&str>,
    ) -> Result<NodeOutcome, ExecutionError> {
        if chain.trim().is_empty() {
            return Err(ExecutionError::EmptyEntrypoint);
        }
        frame.validate()?;
        let snapshot = lease.snapshot();
        if snapshot.state == ExecutionEpochState::Disposed {
            return Err(ExecutionError::RetiredLease(snapshot.state));
        }
        let mut node_id = match start_node {
            Some(node_id) => {
                lease
                    .plan_hash(node_id)
                    .map_err(|error| ExecutionError::LeaseUnavailable(error.to_string()))?;
                node_id.to_string()
            }
            None => lease
                .entrypoint(chain)
                .map_err(|error| ExecutionError::LeaseUnavailable(error.to_string()))?,
        };
        let mut visited = HashSet::new();
        loop {
            if !visited.insert(node_id.clone()) {
                return Err(ExecutionError::RuntimeFault(RuntimeFault::new(
                    "execution_cycle",
                    format!("execution path revisited node {node_id}"),
                )));
            }
            let mut events = frame.events;
            for stage_id in stage_ids_for_node(chain, &node_id) {
                events.push(DiagnosticFact {
                    kind: "stage.checkpoint".to_string(),
                    plugin_id: "routecodex-v4-runtime".to_string(),
                    message: (*stage_id).to_string(),
                });
            }
            events.push(DiagnosticFact {
                kind: "node.entry".to_string(),
                plugin_id: node_id.clone(),
                message: chain.to_string(),
            });
            let output = lease
                .execute(
                    &node_id,
                    NodeExecutionInput {
                        data: frame.data,
                        control: frame.control,
                        information: frame.information,
                        transport: frame.transport.clone(),
                    },
                    registry,
                )
                .map_err(|error| ExecutionError::LeaseUnavailable(error.to_string()))?;
            events.extend(output.diagnostics);
            events.push(DiagnosticFact {
                kind: "node.exit".to_string(),
                plugin_id: node_id.clone(),
                message: chain.to_string(),
            });
            events.push(DiagnosticFact {
                kind: "state.transition".to_string(),
                plugin_id: node_id.clone(),
                message: "executed".to_string(),
            });
            let transport = frame.transport;
            frame = NodeExecutionFrame::with_shared_carriers(
                output.data,
                output.control,
                output.information,
                events,
                frame.shared_data,
                frame.shared_information,
                frame.shared_diagnostic,
            );
            frame.transport = transport;
            frame.validate()?;
            if stop_node.is_some_and(|stop| stop == node_id) {
                break;
            }
            match lease
                .next_node(chain, &node_id)
                .map_err(|error| ExecutionError::LeaseUnavailable(error.to_string()))?
            {
                Some(next) => node_id = next,
                None => break,
            }
        }
        let outcome = NodeOutcome::Continue {
            data: frame.data,
            control: frame.control,
            information: frame.information,
            events: frame.events,
        };
        outcome.validate()?;
        Ok(outcome)
    }
}
