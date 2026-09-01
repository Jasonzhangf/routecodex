//! routecodex-v4-runtime — minimal skeleton runtime vertical slice (Phase 4).
//!
//! Owns:
//! - protocol, continuation and resource views for the immutable
//!   `SkeletonPlan` (owned by routecodex-v4-skeleton);
//! - the typed carrier (`ExecutionContext` with data/control/information/
//!   diagnostic views; Phase 7: MetadataCenter is owned by `control_view`);
//! - a static plugin registry (no dynamic plugin discovery);
//! - request/response chain execution for the minimal slice.
//!
//! Hard boundaries:
//! - error chain and config chain plugins are owned by routecodex-v4-error /
//!   routecodex-v4-config; the runtime never executes them inline
//!   (`external_owner_violation` fail-fast);
//! - faults route into `routecodex_v4_error::ErrorChain` via
//!   `project_runtime_fault` (01 -> 02 -> 03 -> 04 -> 05 -> 06, terminal);
//! - no fallback, no silent strip, no payload reconstruction of control state;
//! - control fields never enter provider/client wire.

use routecodex_v4_base_node::Scope;
use routecodex_v4_control::MetadataCenter;
use routecodex_v4_cordis_bridge::{ScopeSessionCommand, ScopeSessionOperation};
use routecodex_v4_error::{
    ClientProjection, DecisionAction, ErrorCenter, ErrorChain, ErrorChainError, ExecutionDecision,
    RetryPolicy,
};
use routecodex_v4_node_container::{ActiveEpochStore, ExecutionEpochBundle};
use routecodex_v4_skeleton::SkeletonPlan;
use routecodex_v4_standard_plugins::{
    response_inbound::{decode_provider_sse_frame, ProviderSseEventDisposition},
    response_outbound::{encode_client_error_sse_frame, encode_client_sse_frame},
    sse_transport::SseTransportFrame,
    StandardHandleRegistry,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::cell::RefCell;
use std::collections::HashMap;
use std::collections::HashSet;
use std::fmt;

mod control_resources;
mod execution_engine;

pub mod request_port;
pub mod response_error_port;

pub use control_resources::*;
pub use execution_engine::{ExecutionEngine, ExecutionError, NodeExecutionFrame, NodeOutcome};
// Single source of truth: `PluginKind` is owned by routecodex-v4-plugin-contract
// (v4/contracts/node-plugin.contract.json kinds). The runtime never defines a
// second plugin-kind taxonomy; it only re-exports the contract type.
pub use routecodex_v4_plugin_contract::PluginKind;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResponsesWireRequest {
    pub body: Vec<u8>,
    pub model: String,
    pub stream: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub enum ResponsesProviderPayload {
    Json(Value),
    Sse(Vec<u8>),
}

/// Build the only provider-bound Responses request shape. The input is the
/// client data-plane object; runtime writes only the selected upstream model
/// and stream flag. Control carriers are never serialized here.
pub fn build_responses_wire_request(
    client_body: &Value,
    wire_model: &str,
    stream: bool,
) -> Result<ResponsesWireRequest, RuntimeFault> {
    let mut body = client_body.clone();
    let object = body.as_object_mut().ok_or_else(|| {
        RuntimeFault::new(
            "responses_request_invalid",
            "Responses request must be a JSON object",
        )
    })?;
    if wire_model.trim().is_empty() {
        return Err(RuntimeFault::new(
            "provider_wire_model_missing",
            "selected provider wire model is empty",
        ));
    }
    for key in [
        "requestId",
        "control",
        "metadata_center",
        "error_chain",
        "route_facts",
        "target_selection",
        "debug",
        "diagnostics",
        "snapshot",
        "providerId",
    ] {
        if object.contains_key(key) {
            return Err(RuntimeFault::new(
                "provider_wire_control_leak",
                format!("provider wire contains internal control field {key}"),
            ));
        }
    }
    object.insert("model".to_string(), Value::String(wire_model.to_string()));
    object.insert("stream".to_string(), Value::Bool(stream));
    let body = serde_json::to_vec(&body)
        .map_err(|error| RuntimeFault::new("provider_wire_encode", error.to_string()))?;
    Ok(ResponsesWireRequest {
        body,
        model: wire_model.to_string(),
        stream,
    })
}

/// Classify a non-stream provider response at the response-inbound owner.
/// Streaming bytes remain opaque here and are consumed only by
/// `SseIngressPlugin -> ResponseStreamProcessor`.
pub fn parse_responses_provider_payload(
    status: u16,
    content_type: &str,
    body: &[u8],
    stream: bool,
) -> Result<ResponsesProviderPayload, RuntimeFault> {
    if status >= 400 {
        return Err(RuntimeFault::new(
            "provider_http_error",
            format!("upstream Responses returned HTTP {status}"),
        )
        .with_status(status));
    }
    if stream
        || content_type
            .to_ascii_lowercase()
            .contains("text/event-stream")
    {
        return Ok(ResponsesProviderPayload::Sse(body.to_vec()));
    }
    let value: Value = serde_json::from_slice(body)
        .map_err(|error| RuntimeFault::new("provider_json_parse", error.to_string()))?;
    value.as_object().ok_or_else(|| {
        RuntimeFault::new(
            "provider_json_shape",
            "Responses provider JSON must be an object",
        )
    })?;
    if !value.is_object() {
        return Err(RuntimeFault::new(
            "provider_json_shape",
            "Responses provider JSON must be an object",
        ));
    }
    Ok(ResponsesProviderPayload::Json(value))
}

/// Typed runtime fault. Never contains business payload content; carries only
/// stage/code/node identity (error-chain contract).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RuntimeFault {
    pub code: String,
    pub message: String,
    pub node_id: Option<String>,
    pub status: Option<u16>,
}

impl RuntimeFault {
    pub fn new(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.to_string(),
            message: message.into(),
            node_id: None,
            status: None,
        }
    }

    pub fn with_node(mut self, node_id: &str) -> Self {
        self.node_id = Some(node_id.to_string());
        self
    }

    pub fn with_status(mut self, status: u16) -> Self {
        self.status = Some(status);
        self
    }
}

impl fmt::Display for RuntimeFault {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match &self.node_id {
            Some(node) => write!(formatter, "{} at {}: {}", self.code, node, self.message),
            None => write!(formatter, "{}: {}", self.code, self.message),
        }
    }
}

/// Execution binding (Gate 4): a request entering the skeleton stays bound to
/// skeleton_version + manifest_hash + plan_epoch + plan_hash for the whole run.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExecutionBinding {
    pub skeleton_version: String,
    pub manifest_hash: String,
    pub plan_epoch: u64,
    pub plan_hash: String,
}

pub fn execution_binding(plan: &SkeletonPlan) -> ExecutionBinding {
    ExecutionBinding {
        skeleton_version: plan.skeleton_version.clone(),
        manifest_hash: plan.manifest_hash.clone(),
        plan_epoch: plan.plan_epoch,
        plan_hash: plan.plan_hash.clone(),
    }
}

/// Typed continuation facts. Selection may only use these facts; provider id,
/// model prefix and payload-shape guessing are forbidden by contract.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ContinuationFacts {
    pub entry_protocol: String,
    pub provider_wire_protocol: String,
    pub continuation_owner: String,
    pub execution_mode: String,
}

impl ContinuationFacts {
    pub fn new(
        entry_protocol: &str,
        provider_wire_protocol: &str,
        continuation_owner: &str,
        execution_mode: &str,
    ) -> Self {
        Self {
            entry_protocol: entry_protocol.to_string(),
            provider_wire_protocol: provider_wire_protocol.to_string(),
            continuation_owner: continuation_owner.to_string(),
            execution_mode: execution_mode.to_string(),
        }
    }
}

/// Relay / Direct operator decision derived only from typed facts.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RelayOperator {
    Relay,
    Direct,
}

/// Select the relay/direct operator from typed facts only. Same-protocol
/// responses + direct owner selects Direct; an explicit relay owner selects
/// Relay for supported entries, including V4-local Responses materialization.
/// Unsupported pairs fail fast: there is no fallback and no provider-specific
/// selection. Responses relay/local continuation is intentionally unsupported;
/// only direct provider-owned Responses continuation is accepted.
pub fn select_relay_operator(facts: &ContinuationFacts) -> Result<RelayOperator, RuntimeFault> {
    if facts.entry_protocol == "responses" && facts.continuation_owner == "direct" {
        Ok(RelayOperator::Direct)
    } else if facts.continuation_owner == "relay"
        && matches!(
            facts.entry_protocol.as_str(),
            "chat" | "messages" | "anthropic" | "gemini"
        )
    {
        Ok(RelayOperator::Relay)
    } else {
        Err(RuntimeFault::new(
            "relay_operator_select",
            format!(
                "no typed-facts match (entry={} owner={}); provider-specific selection is forbidden",
                facts.entry_protocol, facts.continuation_owner
            ),
        ))
    }
}

/// Three-key continuation restore key: entry protocol + continuation owner +
/// session/conversation (+ port/group). Session-only restore is impossible by
/// construction because the key always carries all three dimensions.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct ContinuationKey {
    pub entry_protocol: String,
    pub continuation_owner: String,
    pub port: u16,
    pub session_scope: String,
    pub conversation_scope: String,
}

impl ContinuationKey {
    pub fn new(
        entry_protocol: &str,
        continuation_owner: &str,
        port: u16,
        session_scope: &str,
        conversation_scope: &str,
    ) -> Self {
        Self {
            entry_protocol: entry_protocol.to_string(),
            continuation_owner: continuation_owner.to_string(),
            port,
            session_scope: session_scope.to_string(),
            conversation_scope: conversation_scope.to_string(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ScopeError {
    AlreadyBound,
    NotBound,
    LocalContinuationUnsupported,
    InvalidBridgeControl,
    OwnerMismatch,
    EntryProtocolMismatch,
    PortMismatch,
    SessionMismatch,
    ConversationMismatch,
    CrossRequestReuse,
    FullInputMissing,
    ImmutableIntervalViolation,
    RestoreAfterRelease,
}

impl fmt::Display for ScopeError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let message = match self {
            Self::AlreadyBound => "continuation key already bound",
            Self::NotBound => "continuation key not bound",
            Self::LocalContinuationUnsupported => "local continuation is unsupported",
            Self::InvalidBridgeControl => "invalid typed continuation bridge control",
            Self::OwnerMismatch => "continuation owner mismatch (direct/relay cross-continuation)",
            Self::EntryProtocolMismatch => {
                "entry protocol mismatch (chat/messages hit responses continuation)"
            }
            Self::PortMismatch => "port/group mismatch",
            Self::SessionMismatch => "session scope mismatch",
            Self::ConversationMismatch => "conversation scope mismatch",
            Self::CrossRequestReuse => "cross-request reuse of continuation binding",
            Self::FullInputMissing => "full input missing for continuation restore",
            Self::ImmutableIntervalViolation => {
                "continuation restored more than once (immutable interval)"
            }
            Self::RestoreAfterRelease => "continuation restored after release",
        };
        write!(formatter, "{message}")
    }
}

/// One bound continuation scope with immutable three-key isolation. The
/// binding is created only at response chat process commit and consumed only
/// at the next request chat process restore.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScopeBinding {
    pub key: ContinuationKey,
    pub request_id: String,
    pub full_input_hash: Option<String>,
    pub restored: bool,
    pub released: bool,
}

/// Immutable audit record for scope bind/restore/release.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScopeRecord {
    pub record_id: String,
    pub key: ContinuationKey,
    pub operation: String,
    pub request_id: String,
    pub sequence: u64,
}

/// Scope session registry: bind (save at resp chat process), restore (three-key
/// at next req chat process), release. Cross-request reuse, owner mismatch,
/// entry-protocol mismatch and session-only restore fail fast.
#[derive(Debug, Default)]
pub struct ScopeRegistry {
    bindings: HashMap<ContinuationKey, ScopeBinding>,
    records: Vec<ScopeRecord>,
    next_sequence: u64,
}

impl ScopeRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn bind(
        &mut self,
        key: ContinuationKey,
        request_id: &str,
        full_input_hash: Option<&str>,
    ) -> Result<ScopeRecord, ScopeError> {
        if let Some(binding) = self.bindings.get(&key) {
            if !binding.released {
                return Err(ScopeError::AlreadyBound);
            }
            self.bindings.remove(&key);
        }
        let full_input_hash = match full_input_hash {
            Some(hash) => Some(hash.to_string()),
            None => return Err(ScopeError::FullInputMissing),
        };
        if key.entry_protocol != "responses" || key.continuation_owner != "direct" {
            return Err(ScopeError::LocalContinuationUnsupported);
        }
        self.bindings.insert(
            key.clone(),
            ScopeBinding {
                key: key.clone(),
                request_id: request_id.to_string(),
                full_input_hash,
                restored: false,
                released: false,
            },
        );
        Ok(self.append_record(key, "bind", request_id))
    }

    /// Three-key restore. The key must match entry protocol + owner + session/
    /// conversation(+port/group) exactly; a binding found on the same
    /// session trio with a different owner or entry protocol returns the
    /// explicit isolation error. Full input is mandatory.
    pub fn restore(
        &mut self,
        key: &ContinuationKey,
        request_id: &str,
        full_input_hash: Option<&str>,
    ) -> Result<&ScopeBinding, ScopeError> {
        if let Some(binding) = self.bindings.get(key) {
            if binding.released {
                return Err(ScopeError::RestoreAfterRelease);
            }
            if binding.restored {
                return Err(ScopeError::ImmutableIntervalViolation);
            }
            if full_input_hash.is_none() {
                return Err(ScopeError::FullInputMissing);
            }
            self.bindings.get_mut(key).expect("binding exists").restored = true;
            self.append_record(key.clone(), "restore", request_id);
            return Ok(self.bindings.get(key).expect("binding exists"));
        }
        // Explicit isolation diagnostics: same session trio, different
        // entry/owner dimensions.
        for bound_key in self.bindings.keys() {
            if bound_key.port == key.port
                && bound_key.session_scope == key.session_scope
                && bound_key.conversation_scope == key.conversation_scope
            {
                if bound_key.continuation_owner != key.continuation_owner {
                    return Err(ScopeError::OwnerMismatch);
                }
                if bound_key.entry_protocol != key.entry_protocol {
                    return Err(ScopeError::EntryProtocolMismatch);
                }
            }
            if bound_key.entry_protocol == key.entry_protocol
                && bound_key.continuation_owner == key.continuation_owner
            {
                if bound_key.session_scope == key.session_scope
                    && bound_key.conversation_scope == key.conversation_scope
                    && bound_key.port != key.port
                {
                    return Err(ScopeError::PortMismatch);
                }
                if bound_key.port == key.port
                    && bound_key.conversation_scope == key.conversation_scope
                    && bound_key.session_scope != key.session_scope
                {
                    return Err(ScopeError::SessionMismatch);
                }
                if bound_key.port == key.port
                    && bound_key.session_scope == key.session_scope
                    && bound_key.conversation_scope != key.conversation_scope
                {
                    return Err(ScopeError::ConversationMismatch);
                }
            }
        }
        Err(ScopeError::NotBound)
    }

    pub fn release(
        &mut self,
        key: &ContinuationKey,
        request_id: &str,
    ) -> Result<ScopeRecord, ScopeError> {
        {
            let binding = self.bindings.get_mut(key).ok_or(ScopeError::NotBound)?;
            if binding.released {
                return Err(ScopeError::RestoreAfterRelease);
            }
            binding.released = true;
        }
        Ok(self.append_record(key.clone(), "release", request_id))
    }

    pub fn is_bound(&self, key: &ContinuationKey) -> bool {
        self.bindings.contains_key(key)
    }

    pub fn is_restored(&self, key: &ContinuationKey) -> bool {
        self.bindings
            .get(key)
            .is_some_and(|binding| binding.restored && !binding.released)
    }

    /// Whether any binding exists on the same port/session/conversation trio.
    /// Used to distinguish a fresh turn (no binding at all) from a three-key
    /// isolation violation (binding exists but entry/owner mismatch).
    pub fn session_trio_bound(
        &self,
        port: u16,
        session_scope: &str,
        conversation_scope: &str,
    ) -> bool {
        self.bindings.keys().any(|key| {
            key.port == port
                && key.session_scope == session_scope
                && key.conversation_scope == conversation_scope
        })
    }

    pub fn records(&self) -> impl Iterator<Item = &ScopeRecord> {
        self.records.iter()
    }

    fn append_record(
        &mut self,
        key: ContinuationKey,
        operation: &str,
        request_id: &str,
    ) -> ScopeRecord {
        self.next_sequence += 1;
        let record = ScopeRecord {
            record_id: format!("scope-{}", self.next_sequence),
            key,
            operation: operation.to_string(),
            request_id: request_id.to_string(),
            sequence: self.next_sequence,
        };
        self.records.push(record.clone());
        record
    }
}

fn scope_session_from_control(
    control: &serde_json::Value,
    expected_operation: ScopeSessionOperation,
) -> Result<ScopeSessionCommand, ScopeError> {
    let value = control
        .get("scope_command")
        .cloned()
        .ok_or(ScopeError::NotBound)?;
    let scope = ScopeSessionCommand::parse(&value).map_err(|_| ScopeError::InvalidBridgeControl)?;
    if scope.operation != expected_operation {
        return Err(ScopeError::InvalidBridgeControl);
    }
    Ok(scope)
}

pub fn bind_scope_via_bridge(
    control: &serde_json::Value,
    registry: &mut ScopeRegistry,
) -> Result<ScopeRecord, ScopeError> {
    let scope = scope_session_from_control(control, ScopeSessionOperation::Bind)?;
    registry.bind(
        ContinuationKey::new(
            scope.entry_protocol.as_str(),
            scope.continuation_owner.as_str(),
            scope.port,
            &scope.session_scope,
            &scope.conversation_scope,
        ),
        &scope.request_id,
        Some(&scope.full_input_hash),
    )
}

pub fn release_scope_via_bridge(
    control: &serde_json::Value,
    registry: &mut ScopeRegistry,
) -> Result<ScopeRecord, ScopeError> {
    let scope = scope_session_from_control(control, ScopeSessionOperation::Release)?;
    registry.release(
        &ContinuationKey::new(
            scope.entry_protocol.as_str(),
            scope.continuation_owner.as_str(),
            scope.port,
            &scope.session_scope,
            &scope.conversation_scope,
        ),
        &scope.request_id,
    )
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PayloadCycleState {
    Open,
    SuccessTerminal,
    ErrorTerminal,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PayloadCycleError {
    OpenTwice,
    CloseWithoutOpen,
    AlreadyTerminal,
    MergeAfterTerminal,
}

impl fmt::Display for PayloadCycleError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let message = match self {
            Self::OpenTwice => "payload cycle opened twice for one request",
            Self::CloseWithoutOpen => "payload cycle closed without open",
            Self::AlreadyTerminal => "payload cycle already terminal",
            Self::MergeAfterTerminal => "retry merge after terminal payload cycle",
        };
        write!(formatter, "{message}")
    }
}

/// Original request payload lifecycle registry. switch/cooldown/reroute merge
/// into the same cycle; the cycle terminates only on client-entry success or
/// error terminal.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PayloadCycle {
    pub request_id: String,
    pub original_request_hash: String,
    pub state: PayloadCycleState,
    pub attempts: u64,
}

#[derive(Debug, Default)]
pub struct PayloadCycleRegistry {
    cycles: HashMap<String, PayloadCycle>,
}

impl PayloadCycleRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn open(
        &mut self,
        request_id: &str,
        original_request_hash: &str,
    ) -> Result<&PayloadCycle, PayloadCycleError> {
        if self.cycles.contains_key(request_id) {
            return Err(PayloadCycleError::OpenTwice);
        }
        self.cycles.insert(
            request_id.to_string(),
            PayloadCycle {
                request_id: request_id.to_string(),
                original_request_hash: original_request_hash.to_string(),
                state: PayloadCycleState::Open,
                attempts: 1,
            },
        );
        Ok(self.cycles.get(request_id).expect("cycle inserted"))
    }

    pub fn merge_retry(&mut self, request_id: &str) -> Result<&PayloadCycle, PayloadCycleError> {
        let cycle = self
            .cycles
            .get_mut(request_id)
            .ok_or(PayloadCycleError::CloseWithoutOpen)?;
        if cycle.state != PayloadCycleState::Open {
            return Err(PayloadCycleError::MergeAfterTerminal);
        }
        cycle.attempts += 1;
        Ok(cycle)
    }

    pub fn close_success(&mut self, request_id: &str) -> Result<&PayloadCycle, PayloadCycleError> {
        let cycle = self
            .cycles
            .get_mut(request_id)
            .ok_or(PayloadCycleError::CloseWithoutOpen)?;
        if cycle.state != PayloadCycleState::Open {
            return Err(PayloadCycleError::AlreadyTerminal);
        }
        cycle.state = PayloadCycleState::SuccessTerminal;
        Ok(cycle)
    }

    pub fn close_error(&mut self, request_id: &str) -> Result<&PayloadCycle, PayloadCycleError> {
        let cycle = self
            .cycles
            .get_mut(request_id)
            .ok_or(PayloadCycleError::CloseWithoutOpen)?;
        if cycle.state != PayloadCycleState::Open {
            return Err(PayloadCycleError::AlreadyTerminal);
        }
        cycle.state = PayloadCycleState::ErrorTerminal;
        Ok(cycle)
    }

    pub fn get(&self, request_id: &str) -> Option<&PayloadCycle> {
        self.cycles.get(request_id)
    }
}

/// Data plane view: only business request/response semantics.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct DataView {
    pub raw_entry: Option<String>,
    pub request_method: Option<String>,
    pub request_path: Option<String>,
    pub request_headers: Option<Vec<(String, String)>>,
    pub normalized_request: Option<String>,
    pub provider_semantic: Option<String>,
    pub provider_wire: Option<String>,
    pub provider_raw: Option<String>,
    pub provider_frame_payload: Option<String>,
    pub parsed_response: Option<String>,
    pub client_semantic: Option<String>,
    pub client_sse_frame: Option<String>,
    pub client_frame: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct ControlFrame {
    continuation_scope: Option<String>,
    continuation_owner: Option<String>,
    execution_mode: Option<String>,
    relay_operator_selected: bool,
    governance_applied: bool,
    execution_plan: Option<String>,
    route_facts: Option<String>,
    target_selection: Option<String>,
    route_exit: Option<String>,
    continuation_committed: bool,
    continuation_restored: bool,
}

/// Control plane view: typed side-channel only; never projected into payload.
/// Phase 7: `MetadataCenter` is the `control_view` owner, bound to the
/// request closed-loop scope.
#[derive(Debug, Clone)]
pub struct ControlView {
    pub continuation_scope: Option<String>,
    pub continuation_owner: Option<String>,
    pub execution_mode: Option<String>,
    pub relay_operator_selected: bool,
    pub governance_applied: bool,
    pub execution_plan: Option<String>,
    pub route_facts: Option<String>,
    pub target_selection: Option<String>,
    pub route_exit: Option<String>,
    pub continuation_committed: bool,
    pub continuation_restored: bool,
    pub metadata: MetadataCenter,
}

/// Information plane view: protocol facts that may legitimately shape
/// projection (entry protocol, endpoint, model).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct InformationView {
    #[serde(rename = "entry_protocol")]
    pub protocol: Option<String>,
    pub execution_lane: Option<String>,
    pub client_protocol: Option<String>,
    pub provider_protocol: Option<String>,
    pub endpoint: Option<String>,
    pub model: Option<String>,
}

fn canonical_protocol_information(protocol: &str) -> Result<&'static str, RuntimeFault> {
    match protocol {
        "responses" | "openai-responses" => Ok("openai-responses"),
        "chat" | "openai-chat" => Ok("openai-chat"),
        "anthropic" => Ok("anthropic"),
        other => Err(RuntimeFault::new(
            "protocol_information_invalid",
            format!("unsupported protocol information {other}"),
        )),
    }
}

/// Diagnostic view: execution trace, observability only, never live-path input.
#[derive(Debug, Clone, Default)]
pub struct DiagnosticView {
    pub trace: Vec<String>,
}

/// Typed carrier per request closed loop. Never global, never shared across
/// request ids.
#[derive(Debug, Clone)]
pub struct ExecutionContext {
    request_id: String,
    binding: ExecutionBinding,
    scope: Scope,
    port: u16,
    session_scope: String,
    conversation_scope: String,
    pub data: DataView,
    pub control: ControlView,
    pub information: InformationView,
    pub diagnostic: DiagnosticView,
}

impl ExecutionContext {
    pub fn new(request_id: &str, binding: ExecutionBinding) -> Self {
        // Default request-bound scope; hosts with real session/conversation
        // dimensions use `with_scope` so continuation restore can bind the
        // three keys (entry protocol + owner + session/conversation(+port)).
        Self::with_scope(request_id, binding, 0, "", "")
    }

    /// Scoped constructor for real port/session/conversation dimensions. The
    /// scope stays closed-loop bound so control state never crosses requests.
    pub fn with_scope(
        request_id: &str,
        binding: ExecutionBinding,
        port: u16,
        session_scope: &str,
        conversation_scope: &str,
    ) -> Self {
        let scope = Scope::new(
            request_id,
            "v4-skeleton",
            port,
            session_scope,
            conversation_scope,
        );
        Self {
            request_id: request_id.to_string(),
            binding,
            scope: scope.clone(),
            port,
            session_scope: session_scope.to_string(),
            conversation_scope: conversation_scope.to_string(),
            data: DataView::default(),
            control: ControlView {
                continuation_scope: None,
                continuation_owner: None,
                execution_mode: None,
                relay_operator_selected: false,
                governance_applied: false,
                execution_plan: None,
                route_facts: None,
                target_selection: None,
                route_exit: None,
                continuation_committed: false,
                continuation_restored: false,
                metadata: MetadataCenter::new(scope),
            },
            information: InformationView::default(),
            diagnostic: DiagnosticView::default(),
        }
    }

    pub fn request_id(&self) -> &str {
        &self.request_id
    }

    pub fn binding(&self) -> &ExecutionBinding {
        &self.binding
    }

    pub fn scope(&self) -> &Scope {
        &self.scope
    }

    pub fn port(&self) -> u16 {
        self.port
    }

    pub fn session_scope(&self) -> &str {
        &self.session_scope
    }

    pub fn conversation_scope(&self) -> &str {
        &self.conversation_scope
    }

    pub fn binding_mut(&mut self) -> &mut ExecutionBinding {
        &mut self.binding
    }

    pub fn record_trace(&mut self, entry: impl Into<String>) {
        self.diagnostic.trace.push(entry.into());
    }

    /// Project the adjacent business payload back into the legacy report
    /// surface. Request/response data remains the exact payload object; scope
    /// and lifecycle facts stay in the typed control frame.
    fn from_frame(
        &self,
        chain_id: &str,
        frame: &crate::NodeExecutionFrame,
    ) -> Result<Self, RuntimeFault> {
        let mut context = self.clone();
        let encoded = serde_json::to_string(&frame.data)
            .map_err(|error| RuntimeFault::new("execution_frame_data", error.to_string()))?;
        match chain_id {
            "request" | "direct_request" | "relay_request" => {
                context.data.provider_wire = Some(encoded)
            }
            "response" | "direct_response" | "relay_response" => {
                context.data.client_frame = Some(encoded)
            }
            other => {
                return Err(RuntimeFault::new(
                    "execution_chain_external_owner",
                    format!("chain {other} is not owned by SkeletonRuntime"),
                ));
            }
        }
        let control_object = frame.control.as_object().ok_or_else(|| {
            RuntimeFault::new("execution_frame_control", "control frame must be an object")
        })?;
        let control_string = |name: &str| {
            control_object.get(name).and_then(|value| {
                value
                    .as_str()
                    .map(str::to_string)
                    .or_else(|| (!value.is_null()).then(|| value.to_string()))
            })
        };
        let control = ControlFrame {
            continuation_scope: control_string("continuation_scope"),
            continuation_owner: control_string("continuation_owner"),
            execution_mode: control_string("execution_mode"),
            relay_operator_selected: control_object
                .get("relay_operator_selected")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            governance_applied: control_object
                .get("governance_applied")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            execution_plan: control_string("execution_plan"),
            route_facts: control_string("route_facts"),
            target_selection: control_string("target_selection"),
            route_exit: control_string("route_exit"),
            continuation_committed: control_object
                .get("continuation_committed")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            continuation_restored: control_object
                .get("continuation_restored")
                .and_then(Value::as_bool)
                .unwrap_or(false),
        };
        context.control.continuation_scope = control.continuation_scope;
        context.control.continuation_owner = control.continuation_owner;
        context.control.execution_mode = control.execution_mode;
        context.control.relay_operator_selected = control.relay_operator_selected;
        context.control.governance_applied = control.governance_applied;
        context.control.execution_plan = control.execution_plan;
        context.control.route_facts = control.route_facts;
        context.control.target_selection = control.target_selection;
        context.control.route_exit = control.route_exit;
        context.control.continuation_committed = control.continuation_committed;
        context.control.continuation_restored = control.continuation_restored;
        context.information = serde_json::from_value(frame.information.clone())
            .map_err(|error| RuntimeFault::new("execution_frame_information", error.to_string()))?;
        context.diagnostic.trace.extend(
            frame
                .events
                .iter()
                .map(|event| format!("{}:{}:{}", event.plugin_id, event.kind, event.message)),
        );
        Ok(context)
    }

    fn into_frame(self, chain_id: &str) -> Result<crate::NodeExecutionFrame, RuntimeFault> {
        let control = ControlFrame {
            continuation_scope: self.control.continuation_scope,
            continuation_owner: self.control.continuation_owner,
            execution_mode: self.control.execution_mode,
            relay_operator_selected: self.control.relay_operator_selected,
            governance_applied: self.control.governance_applied,
            execution_plan: self.control.execution_plan,
            route_facts: self.control.route_facts,
            target_selection: self.control.target_selection,
            route_exit: self.control.route_exit,
            continuation_committed: self.control.continuation_committed,
            continuation_restored: self.control.continuation_restored,
        };
        let raw_payload = match chain_id {
            "request" | "direct_request" | "relay_request" => self.data.raw_entry.as_deref(),
            "response" | "direct_response" | "relay_response" => self.data.provider_raw.as_deref(),
            other => {
                return Err(RuntimeFault::new(
                    "execution_chain_external_owner",
                    format!("chain {other} is not owned by SkeletonRuntime"),
                ));
            }
        }
        .ok_or_else(|| RuntimeFault::new("execution_frame_data", "business payload is missing"))?;
        let data = serde_json::from_str(raw_payload).map_err(|error| {
            RuntimeFault::new(
                if matches!(chain_id, "response" | "direct_response" | "relay_response") {
                    "raw_parse"
                } else {
                    "execution_frame_data"
                },
                error.to_string(),
            )
        })?;
        Ok(crate::NodeExecutionFrame::with_information(
            data,
            serde_json::to_value(control)
                .map_err(|error| RuntimeFault::new("execution_frame_control", error.to_string()))?,
            serde_json::to_value(self.information).map_err(|error| {
                RuntimeFault::new("execution_frame_information", error.to_string())
            })?,
        ))
    }
}

/// Plane isolation is structural: data and control are disjoint typed views.
/// Payload field names never reconstruct or identify runtime control state.
pub fn assert_no_control_leak(ctx: &ExecutionContext) -> Result<(), RuntimeFault> {
    const CONTROL_KEYS: [&str; 11] = [
        "continuation_scope",
        "route_facts",
        "route_hint",
        "provider_selection",
        "provider_key",
        "health",
        "retry",
        "snapshot",
        "scope",
        "stopless",
        "servertool",
    ];
    fn contains_control_key(value: &Value) -> Option<&'static str> {
        match value {
            Value::Object(map) => {
                for key in CONTROL_KEYS {
                    if map.contains_key(key) {
                        return Some(key);
                    }
                }
                map.values().find_map(contains_control_key)
            }
            Value::Array(values) => values.iter().find_map(contains_control_key),
            _ => None,
        }
    }
    for (lane, wire) in [
        ("provider_wire", ctx.data.provider_wire.as_deref()),
        ("client_frame", ctx.data.client_frame.as_deref()),
    ] {
        let Some(wire) = wire else { continue };
        let Ok(value) = serde_json::from_str::<Value>(wire) else {
            continue;
        };
        if let Some(key) = contains_control_key(&value) {
            return Err(RuntimeFault::new(
                "control_payload_leak",
                format!("{lane} contains control field {key}"),
            ));
        }
    }
    Ok(())
}

/// Static plugin capability boundary. Plugins are node-local: they only touch
/// their declared view through `ExecutionContext`; no next_node effect exists.
pub struct RuntimeRegistries<'a> {
    pub scope: &'a mut ScopeRegistry,
    pub payload_cycle: &'a mut PayloadCycleRegistry,
}

/* legacy runtime-local operators removed: production execution is owned by
 * NodeContainer/NodePluginPlan and dispatched through PluginHandle. */
/*
impl RuntimeOperator for ProtocolParse {
    fn plugin_id(&self) -> &'static str {
        "protocol_parse"
    }
    fn kind(&self) -> PluginKind {
        PluginKind::Operator
    }
    fn execute(
        &self,
        ctx: &mut ExecutionContext,
        _registries: &mut RuntimeRegistries<'_>,
    ) -> Result<(), RuntimeFault> {
        let raw = ctx
            .data
            .raw_entry
            .as_deref()
            .ok_or_else(|| RuntimeFault::new("protocol_parse", "raw entry missing"))?;
        let protocol = if raw.starts_with('{') {
            ctx.information.protocol.as_deref().unwrap_or("responses")
        } else if raw.starts_with("chat:") {
            "chat"
        } else if raw.starts_with("responses:") {
            "responses"
        } else {
            "unknown"
        };
        ctx.information.protocol = Some(protocol.to_string());
        Ok(())
    }
}

struct Normalize;
impl RuntimeOperator for Normalize {
    fn plugin_id(&self) -> &'static str {
        "normalize"
    }
    fn kind(&self) -> PluginKind {
        PluginKind::Operator
    }
    fn execute(
        &self,
        ctx: &mut ExecutionContext,
        _registries: &mut RuntimeRegistries<'_>,
    ) -> Result<(), RuntimeFault> {
        let protocol = ctx
            .information
            .protocol
            .as_deref()
            .ok_or_else(|| RuntimeFault::new("normalize", "protocol not parsed"))?;
        ctx.data.normalized_request = Some(if let Some(raw) = ctx.data.raw_entry.as_deref() {
            if raw.starts_with('{') {
                raw.to_string()
            } else {
                format!("normalized:{protocol}:{}", ctx.request_id())
            }
        } else {
            format!("normalized:{protocol}:{}", ctx.request_id())
        });
        Ok(())
    }
}

struct InputValidate;
impl RuntimeOperator for InputValidate {
    fn plugin_id(&self) -> &'static str {
        "input_validate"
    }
    fn kind(&self) -> PluginKind {
        PluginKind::Validator
    }
    fn execute(
        &self,
        ctx: &mut ExecutionContext,
        _registries: &mut RuntimeRegistries<'_>,
    ) -> Result<(), RuntimeFault> {
        let raw = ctx
            .data
            .raw_entry
            .as_deref()
            .ok_or_else(|| RuntimeFault::new("input_validate", "raw entry missing"))?;
        let protocol_bound_json = ctx
            .information
            .protocol
            .as_deref()
            .map(|protocol| {
                matches!(protocol, "chat" | "responses") && raw.trim_start().starts_with('{')
            })
            .unwrap_or(false);
        if !(raw.starts_with("chat:") || raw.starts_with("responses:") || protocol_bound_json) {
            return Err(RuntimeFault::new(
                "input_validate",
                format!("invalid entry protocol {raw:?}"),
            ));
        }
        if ctx.data.normalized_request.is_none() {
            return Err(RuntimeFault::new(
                "input_validate",
                "normalized request missing",
            ));
        }
        Ok(())
    }
}

struct Governance;
impl RuntimeOperator for Governance {
    fn plugin_id(&self) -> &'static str {
        "governance"
    }
    fn kind(&self) -> PluginKind {
        PluginKind::Control
    }
    fn execute(
        &self,
        ctx: &mut ExecutionContext,
        _registries: &mut RuntimeRegistries<'_>,
    ) -> Result<(), RuntimeFault> {
        ctx.control.governance_applied = true;
        Ok(())
    }
}

struct ExecutionPlan;
impl RuntimeOperator for ExecutionPlan {
    fn plugin_id(&self) -> &'static str {
        "execution_plan"
    }
    fn kind(&self) -> PluginKind {
        PluginKind::Control
    }
    fn execute(
        &self,
        ctx: &mut ExecutionContext,
        _registries: &mut RuntimeRegistries<'_>,
    ) -> Result<(), RuntimeFault> {
        ctx.control.execution_plan = Some(format!("plan:{}", ctx.binding().plan_hash));
        // Router facts, target selection and route exit are typed, opaque
        // control facts; they are never projected into payload and never
        // mutated here.
        ctx.control.route_facts = Some(format!("facts:{}:classified", ctx.binding().plan_hash));
        ctx.control.target_selection = Some(format!("opaque:{}:selected", ctx.binding().plan_hash));
        // Route exit is bound to the typed-facts operator decision (relay or
        // direct); it is never a hardcoded value and never derived from
        // provider id / model / payload shape.
        ctx.control.route_exit = Some(if ctx.control.relay_operator_selected {
            "relay_policy_bound".to_string()
        } else {
            "direct_policy_bound".to_string()
        });
        Ok(())
    }
}

struct SemanticProjection;
impl RuntimeOperator for SemanticProjection {
    fn plugin_id(&self) -> &'static str {
        "semantic_projection"
    }
    fn kind(&self) -> PluginKind {
        PluginKind::Operator
    }
    fn execute(
        &self,
        ctx: &mut ExecutionContext,
        _registries: &mut RuntimeRegistries<'_>,
    ) -> Result<(), RuntimeFault> {
        let normalized = ctx.data.normalized_request.as_deref().ok_or_else(|| {
            RuntimeFault::new("semantic_projection", "normalized request missing")
        })?;
        let model = ctx.information.model.as_deref().unwrap_or("unselected");
        ctx.data.provider_semantic = Some(if normalized.starts_with('{') {
            normalized.to_string()
        } else {
            format!("semantic:{model}:{normalized}")
        });
        Ok(())
    }
}

struct WireBuild;
impl RuntimeOperator for WireBuild {
    fn plugin_id(&self) -> &'static str {
        "wire_build"
    }
    fn kind(&self) -> PluginKind {
        PluginKind::Operator
    }
    fn execute(
        &self,
        ctx: &mut ExecutionContext,
        _registries: &mut RuntimeRegistries<'_>,
    ) -> Result<(), RuntimeFault> {
        let semantic = ctx
            .data
            .provider_semantic
            .as_deref()
            .ok_or_else(|| RuntimeFault::new("wire_build", "provider semantic missing"))?;
        ctx.data.provider_wire = Some(if semantic.starts_with('{') {
            semantic.to_string()
        } else {
            format!("wire:{semantic}")
        });
        assert_no_control_leak(ctx)
    }
}

struct OutputValidate;
impl RuntimeOperator for OutputValidate {
    fn plugin_id(&self) -> &'static str {
        "output_validate"
    }
    fn kind(&self) -> PluginKind {
        PluginKind::Validator
    }
    fn execute(
        &self,
        ctx: &mut ExecutionContext,
        _registries: &mut RuntimeRegistries<'_>,
    ) -> Result<(), RuntimeFault> {
        if ctx.data.provider_wire.is_none() {
            return Err(RuntimeFault::new(
                "output_validate",
                "provider wire missing",
            ));
        }
        assert_no_control_leak(ctx)
    }
}

struct FrameParse;
impl RuntimeOperator for FrameParse {
    fn plugin_id(&self) -> &'static str {
        "frame_parse"
    }
    fn kind(&self) -> PluginKind {
        PluginKind::Operator
    }
    fn execute(
        &self,
        ctx: &mut ExecutionContext,
        _registries: &mut RuntimeRegistries<'_>,
    ) -> Result<(), RuntimeFault> {
        let raw = ctx
            .data
            .provider_raw
            .as_deref()
            .ok_or_else(|| RuntimeFault::new("raw_parse", "provider raw missing"))?;
        let payload = if raw.lines().any(|line| line.starts_with("data:")) {
            raw.lines()
                .find_map(|line| line.strip_prefix("data:"))
                .map(str::trim_start)
                .filter(|data| !data.is_empty() && *data != "[DONE]")
                .ok_or_else(|| {
                    RuntimeFault::new("frame_parse", "provider SSE frame has no JSON data payload")
                })?
        } else {
            raw
        };
        ctx.data.provider_frame_payload = Some(payload.to_string());
        Ok(())
    }
}

struct JsonParse;
impl RuntimeOperator for JsonParse {
    fn plugin_id(&self) -> &'static str {
        "json_parse"
    }
    fn kind(&self) -> PluginKind {
        PluginKind::Operator
    }
    fn execute(
        &self,
        ctx: &mut ExecutionContext,
        _registries: &mut RuntimeRegistries<'_>,
    ) -> Result<(), RuntimeFault> {
        let payload = ctx
            .data
            .provider_frame_payload
            .as_deref()
            .ok_or_else(|| RuntimeFault::new("json_parse", "provider frame payload missing"))?;
        let parsed: serde_json::Value = serde_json::from_str(payload).map_err(|error| {
            RuntimeFault::new("json_parse", format!("malformed provider JSON: {error}"))
        })?;
        if !parsed.is_object() {
            return Err(RuntimeFault::new(
                "json_parse",
                "provider JSON must be an object",
            ));
        }
        if parsed.get("type").and_then(Value::as_str) == Some("response.failed") {
            return Err(RuntimeFault::new(
                "provider_response_failed",
                "provider emitted response.failed",
            ));
        }
        ctx.data.provider_frame_payload = Some(
            serde_json::to_string(&parsed)
                .map_err(|error| RuntimeFault::new("json_parse", error.to_string()))?,
        );
        Ok(())
    }
}

struct ProtocolDecode;
impl RuntimeOperator for ProtocolDecode {
    fn plugin_id(&self) -> &'static str {
        "protocol_decode"
    }
    fn kind(&self) -> PluginKind {
        PluginKind::Operator
    }
    fn execute(
        &self,
        ctx: &mut ExecutionContext,
        _registries: &mut RuntimeRegistries<'_>,
    ) -> Result<(), RuntimeFault> {
        let payload = ctx.data.provider_frame_payload.as_deref().ok_or_else(|| {
            RuntimeFault::new("protocol_decode", "provider frame payload missing")
        })?;
        ctx.data.parsed_response = Some(payload.to_string());
        Ok(())
    }
}

struct ResponseGovernance;
impl RuntimeOperator for ResponseGovernance {
    fn plugin_id(&self) -> &'static str {
        "response_governance"
    }
    fn kind(&self) -> PluginKind {
        PluginKind::Control
    }
    fn execute(
        &self,
        ctx: &mut ExecutionContext,
        _registries: &mut RuntimeRegistries<'_>,
    ) -> Result<(), RuntimeFault> {
        ctx.control.governance_applied = true;
        Ok(())
    }
}

struct ToolHarvest;
impl RuntimeOperator for ToolHarvest {
    fn plugin_id(&self) -> &'static str {
        "tool_harvest"
    }
    fn kind(&self) -> PluginKind {
        PluginKind::Observer
    }
    fn execute(
        &self,
        ctx: &mut ExecutionContext,
        _registries: &mut RuntimeRegistries<'_>,
    ) -> Result<(), RuntimeFault> {
        // Harvest is semantic: extracted tool facts are observed and carried;
        // they are never stripped and never silently dropped.
        let parsed = ctx
            .data
            .parsed_response
            .as_deref()
            .ok_or_else(|| RuntimeFault::new("tool_harvest", "parsed response missing"))?;
        let value: serde_json::Value = serde_json::from_str(parsed).map_err(|error| {
            RuntimeFault::new(
                "tool_harvest",
                format!("parsed response is invalid JSON: {error}"),
            )
        })?;
        let tool_calls = value
            .get("output")
            .and_then(serde_json::Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter(|item| {
                        matches!(
                            item.get("type").and_then(serde_json::Value::as_str),
                            Some("function_call" | "custom_tool_call" | "web_search_call")
                        )
                    })
                    .count()
            })
            .unwrap_or(0);
        let chat_tool_calls = value
            .get("choices")
            .and_then(serde_json::Value::as_array)
            .map(|choices| {
                choices
                    .iter()
                    .filter_map(|choice| choice.get("message"))
                    .filter_map(|message| message.get("tool_calls"))
                    .filter_map(serde_json::Value::as_array)
                    .map(Vec::len)
                    .sum::<usize>()
            })
            .unwrap_or(0);
        let tools = tool_calls + chat_tool_calls;
        if tools > 0 {
            ctx.diagnostic
                .trace
                .push(format!("harvested_tools:{tools}"));
        }
        Ok(())
    }
}

struct FrameBuild;
impl RuntimeOperator for FrameBuild {
    fn plugin_id(&self) -> &'static str {
        "frame_build"
    }
    fn kind(&self) -> PluginKind {
        PluginKind::Operator
    }
    fn execute(
        &self,
        ctx: &mut ExecutionContext,
        _registries: &mut RuntimeRegistries<'_>,
    ) -> Result<(), RuntimeFault> {
        let semantic = ctx
            .data
            .client_sse_frame
            .as_deref()
            .ok_or_else(|| RuntimeFault::new("frame_build", "client SSE frame missing"))?;
        ctx.data.client_frame = Some(semantic.to_string());
        assert_no_control_leak(ctx)
    }
}
*/

/// Result of one chain execution: bound identity + produced wire + control
/// facts + diagnostic trace.
#[derive(Debug, Clone)]
pub struct ExecutionReport {
    pub request_id: String,
    pub binding: ExecutionBinding,
    pub scope: Scope,
    pub provider_wire: Option<String>,
    /// Parsed provider wire owned by the request chain. Consumers must not
    /// reconstruct protocol payloads from the original client body.
    pub provider_wire_value: Option<Value>,
    pub client_frame: Option<String>,
    pub continuation_scope: Option<String>,
    pub continuation_owner: Option<String>,
    pub execution_mode: Option<String>,
    pub relay_operator_selected: bool,
    pub route_exit: Option<String>,
    pub continuation_committed: bool,
    pub continuation_restored: bool,
    pub trace: Vec<String>,
}

/// Skeleton runtime: loads the hash-locked immutable plan and delegates every
/// node path to the single `ExecutionEngine`.  Protocol, continuation and
/// resource stores remain here; graph execution does not.
pub struct SkeletonRuntime {
    plan: SkeletonPlan,
    epoch_store: ActiveEpochStore,
    handle_registry: StandardHandleRegistry,
    active_requests: RefCell<HashSet<String>>,
    payload_cycles: RefCell<PayloadCycleRegistry>,
}

/// Request-owned admission lease retained through provider and response
/// stages; dropping it is the exactly-once epoch release point.
pub struct RuntimeLease {
    request_id: String,
    binding: ExecutionBinding,
    lease: routecodex_v4_node_container::EpochLease,
}

impl RuntimeLease {
    pub fn request_id(&self) -> &str {
        &self.request_id
    }
    pub fn binding(&self) -> &ExecutionBinding {
        &self.binding
    }
    pub fn snapshot(&self) -> routecodex_v4_node_container::ExecutionEpochSnapshot {
        self.lease.snapshot()
    }
    fn epoch_lease(&self) -> &routecodex_v4_node_container::EpochLease {
        &self.lease
    }
}

/// Typed response-stream event emitted by the runtime semantic owner. The
/// frame remains Arc-backed opaque bytes for the transport layer; terminal
/// and failure truth never has to be reconstructed from the payload.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ResponseStreamDisposition {
    Continue { frame: SseTransportFrame },
    Terminal { frame: SseTransportFrame },
    Failure { frame: SseTransportFrame },
}

/// Owns provider-event decode, Direct/Relay response-chain execution, client
/// protocol projection and semantic closeout for one admitted request. The
/// request lease stays here until the stream object is dropped.
pub struct ResponseStreamProcessor {
    request_lease: RuntimeLease,
    request_scope: Scope,
    port: u16,
    entry_protocol: String,
    provider_protocol: String,
    continuation_owner: String,
    session_scope: String,
    conversation_scope: String,
    semantic_terminal: bool,
    failure_projected: bool,
}

impl ResponseStreamProcessor {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        request_lease: RuntimeLease,
        request_scope: Scope,
        port: u16,
        entry_protocol: &str,
        provider_protocol: &str,
        continuation_owner: &str,
        session_scope: &str,
        conversation_scope: &str,
    ) -> Result<Self, RuntimeFault> {
        let entry_protocol = match canonical_protocol_information(entry_protocol)? {
            "openai-responses" => "responses",
            "openai-chat" => "chat",
            other => {
                return Err(RuntimeFault::new(
                    "client_sse_protocol_unsupported",
                    format!("unsupported client SSE protocol {other}"),
                ))
            }
        };
        let provider_protocol = match canonical_protocol_information(provider_protocol)? {
            "openai-responses" => "responses",
            other => {
                return Err(RuntimeFault::new(
                    "provider_sse_protocol_unsupported",
                    format!("unsupported provider SSE protocol {other}"),
                ))
            }
        };
        if !matches!(continuation_owner, "direct" | "relay") {
            return Err(RuntimeFault::new(
                "execution_lane_invalid",
                format!("unsupported execution lane {continuation_owner}"),
            ));
        }
        if continuation_owner == "direct" && entry_protocol != provider_protocol {
            return Err(RuntimeFault::new(
                "direct_protocol_mismatch",
                "Direct SSE requires identical client and provider protocols",
            ));
        }
        Ok(Self {
            request_lease,
            request_scope,
            port,
            entry_protocol: entry_protocol.to_string(),
            provider_protocol: provider_protocol.to_string(),
            continuation_owner: continuation_owner.to_string(),
            session_scope: session_scope.to_string(),
            conversation_scope: conversation_scope.to_string(),
            semantic_terminal: false,
            failure_projected: false,
        })
    }

    pub fn lease_snapshot(&self) -> routecodex_v4_node_container::ExecutionEpochSnapshot {
        self.request_lease.snapshot()
    }

    pub fn execute_provider_response_scoped(
        &mut self,
        runtime: &SkeletonRuntime,
        frame: SseTransportFrame,
    ) -> Result<(ResponseStreamDisposition, Option<ExecutionReport>), RuntimeFault> {
        if self.semantic_terminal || self.failure_projected {
            return Err(RuntimeFault::new(
                "response_stream_after_terminal",
                "provider emitted a semantic frame after stream terminal",
            ));
        }
        let decoded = decode_provider_sse_frame(frame.as_bytes())
            .map_err(|error| RuntimeFault::new("provider_sse_decode", error))?;
        if let ProviderSseEventDisposition::Failed { message } = decoded.disposition {
            return Ok((
                self.project_failure(RuntimeFault::new("provider_response_failed", message))?,
                None,
            ));
        }
        let terminal = matches!(decoded.disposition, ProviderSseEventDisposition::Completed);
        let provider_semantic = serde_json::to_string(&decoded.semantic)
            .map_err(|error| RuntimeFault::new("provider_sse_encode", error.to_string()))?;
        let report = runtime.execute_provider_response_scoped_for_target_with_lease(
            &provider_semantic,
            self.request_lease.request_id(),
            self.port,
            &self.session_scope,
            &self.conversation_scope,
            &self.entry_protocol,
            &self.provider_protocol,
            &self.continuation_owner,
            Some(&self.request_lease),
        )?;
        let client_frame = report.client_frame.clone().ok_or_else(|| {
            RuntimeFault::new(
                "response_frame_missing",
                "response chain produced no client frame",
            )
        })?;
        let client_semantic: Value = serde_json::from_str(&client_frame)
            .map_err(|error| RuntimeFault::new("client_sse_semantic", error.to_string()))?;
        let encoded = encode_client_sse_frame(&self.entry_protocol, &client_semantic, terminal)
            .map_err(|error| RuntimeFault::new("client_sse_encode", error))?;
        let frame = SseTransportFrame::from_complete_bytes(encoded)
            .map_err(|error| RuntimeFault::new("client_sse_transport", format!("{error:?}")))?;
        if terminal {
            self.semantic_terminal = true;
            Ok((ResponseStreamDisposition::Terminal { frame }, Some(report)))
        } else {
            Ok((ResponseStreamDisposition::Continue { frame }, Some(report)))
        }
    }

    pub fn process_frame(
        &mut self,
        runtime: &SkeletonRuntime,
        frame: SseTransportFrame,
    ) -> Result<ResponseStreamDisposition, RuntimeFault> {
        self.execute_provider_response_scoped(runtime, frame)
            .map(|(disposition, _report)| disposition)
    }

    pub fn finish(&mut self) -> Result<(), RuntimeFault> {
        if self.semantic_terminal || self.failure_projected {
            Ok(())
        } else {
            Err(RuntimeFault::new(
                "provider_sse_eof_before_terminal",
                "provider SSE ended before response.completed or response.failed",
            ))
        }
    }

    pub fn project_failure(
        &mut self,
        fault: RuntimeFault,
    ) -> Result<ResponseStreamDisposition, RuntimeFault> {
        if self.failure_projected {
            return Err(RuntimeFault::new(
                "response_stream_failure_duplicate",
                "response stream failure was already projected",
            ));
        }
        let mut chain = ErrorChain::new(self.request_scope.clone());
        let projection = project_runtime_fault(&mut chain, fault).map_err(|error| {
            RuntimeFault::new(
                "response_error_projection",
                format!("error chain projection failed: {error:?}"),
            )
        })?;
        let encoded = encode_client_error_sse_frame(&self.entry_protocol, &projection.message)
            .map_err(|error| RuntimeFault::new("client_sse_error_encode", error))?;
        let frame = SseTransportFrame::from_complete_bytes(encoded)
            .map_err(|error| RuntimeFault::new("client_sse_transport", format!("{error:?}")))?;
        self.failure_projected = true;
        Ok(ResponseStreamDisposition::Failure { frame })
    }
}

impl SkeletonRuntime {
    pub fn load(contract_json: &str) -> Result<Self, RuntimeFault> {
        let plan = SkeletonPlan::from_contract_json(contract_json)
            .map_err(|error| RuntimeFault::new("plan_invalid", error.to_string()))?;
        Self::from_compiled_plan(plan)
    }

    pub fn from_compiled_plan(plan: SkeletonPlan) -> Result<Self, RuntimeFault> {
        plan.verify()
            .map_err(|error| RuntimeFault::new("plan_invalid", error.to_string()))?;
        Ok(Self {
            plan,
            epoch_store: ActiveEpochStore::empty(),
            handle_registry: StandardHandleRegistry::new(),
            active_requests: RefCell::new(HashSet::new()),
            payload_cycles: RefCell::new(PayloadCycleRegistry::new()),
        })
    }

    pub fn plan(&self) -> &SkeletonPlan {
        &self.plan
    }

    pub fn prepare_execution_epoch(
        &self,
        transaction_id: &str,
        base_epoch: u64,
        base_manifest_hash: &str,
        candidate: ExecutionEpochBundle,
        candidate_hash: &str,
    ) -> Result<routecodex_v4_node_container::EpochTransactionSnapshot, RuntimeFault> {
        self.epoch_store
            .prepare(
                transaction_id,
                base_epoch,
                base_manifest_hash,
                candidate,
                candidate_hash,
            )
            .map_err(|error| RuntimeFault::new("execution_epoch_prepare", error.to_string()))
    }

    /// Verify and materialize the exact compiled Cordis candidate before
    /// opening the Rust active-pointer transaction. Runtime never compiles,
    /// sorts, or repairs the graph; malformed identity and unknown handles
    /// fail before `ActiveEpochStore::prepare` can mutate transaction state.
    pub fn prepare_compiled_execution_epoch(
        &self,
        transaction_id: &str,
        base_epoch: u64,
        base_manifest_hash: &str,
        candidate: &Value,
        expected_graph_hash: &str,
        expected_manifest_hash: &str,
    ) -> Result<routecodex_v4_node_container::EpochTransactionSnapshot, RuntimeFault> {
        let bundle = routecodex_v4_node_container::materialize_execution_epoch_bundle(
            candidate,
            expected_graph_hash,
            expected_manifest_hash,
            &self.handle_registry,
        )
        .map_err(|error| RuntimeFault::new("execution_epoch_materialize", error.to_string()))?;
        self.prepare_execution_epoch(
            transaction_id,
            base_epoch,
            base_manifest_hash,
            bundle,
            expected_manifest_hash,
        )
    }

    pub fn commit_execution_epoch(
        &self,
        transaction_id: &str,
    ) -> Result<routecodex_v4_node_container::EpochTransactionSnapshot, RuntimeFault> {
        self.epoch_store
            .commit(transaction_id)
            .map_err(|error| RuntimeFault::new("execution_epoch_commit", error.to_string()))
    }

    pub fn admit_request(&self, request_id: &str) -> Result<RuntimeLease, RuntimeFault> {
        let lease = self
            .epoch_store
            .admit()
            .map_err(|error| RuntimeFault::new("execution_epoch", error.to_string()))?;
        let snapshot = lease.snapshot();
        let binding = ExecutionBinding {
            skeleton_version: self.plan.skeleton_version.clone(),
            manifest_hash: snapshot.manifest_hash,
            plan_epoch: snapshot.plan_epoch,
            plan_hash: snapshot.execution_identity,
        };
        Ok(RuntimeLease {
            request_id: request_id.to_string(),
            binding,
            lease,
        })
    }

    /// Scope claim: a request id may only have one active closed loop.
    /// Cross-request reuse fails fast (Phase 7 scope isolation).
    pub fn claim(&self, request_id: &str) -> Result<(), RuntimeFault> {
        let mut active = self.active_requests.borrow_mut();
        if !active.insert(request_id.to_string()) {
            return Err(RuntimeFault::new(
                "cross_request_reuse",
                format!("request_id {request_id} already active in this runtime"),
            ));
        }
        Ok(())
    }

    pub fn release(&self, request_id: &str) {
        self.active_requests.borrow_mut().remove(request_id);
    }

    /// Fixed request slice: server entry -> Hub governance -> provider boundary.
    pub fn execute_request(
        &self,
        raw_entry: &str,
        request_id: &str,
    ) -> Result<ExecutionReport, RuntimeFault> {
        self.execute_request_scoped(raw_entry, request_id, 0, "", "")
    }

    /// Request slice with explicit port/session/conversation dimensions so the
    /// continuation restore key can carry the full three-key scope.
    pub fn execute_request_scoped(
        &self,
        raw_entry: &str,
        request_id: &str,
        port: u16,
        session_scope: &str,
        conversation_scope: &str,
    ) -> Result<ExecutionReport, RuntimeFault> {
        self.execute_request_scoped_with_owner(
            raw_entry,
            request_id,
            port,
            session_scope,
            conversation_scope,
            None,
        )
    }

    /// Request slice with an explicit continuation owner selected by the
    /// compiled provider transport contract. `None` preserves the protocol
    /// default; a supplied owner is typed control state and is never inferred
    /// from payload shape.
    pub fn execute_request_scoped_with_owner(
        &self,
        raw_entry: &str,
        request_id: &str,
        port: u16,
        session_scope: &str,
        conversation_scope: &str,
        continuation_owner: Option<&str>,
    ) -> Result<ExecutionReport, RuntimeFault> {
        self.claim(request_id)?;
        let result = self.execute_path(
            "request",
            request_id,
            port,
            session_scope,
            conversation_scope,
            |ctx| {
                ctx.data.raw_entry = Some(raw_entry.to_string());
                ctx.information.model = Some("unselected".to_string());
                if let Some(owner) = continuation_owner {
                    ctx.control.continuation_owner = Some(owner.to_string());
                }
            },
            None,
        );
        self.release(request_id);
        result
    }

    /// Production request entry: execute the complete request chain and return
    /// its provider wire output. The runtime-bin must consume this value;
    /// rebuilding the provider body in the binary is a P0 bypass.
    pub fn execute_request_json_scoped(
        &self,
        body: &str,
        protocol: &str,
        wire_model: &str,
        stream: bool,
        request_id: &str,
        port: u16,
        session_scope: &str,
        conversation_scope: &str,
        continuation_owner: Option<&str>,
    ) -> Result<ExecutionReport, RuntimeFault> {
        self.execute_request_json_scoped_with_lease(
            body,
            protocol,
            wire_model,
            stream,
            request_id,
            port,
            session_scope,
            conversation_scope,
            continuation_owner,
            None,
        )
    }

    pub fn execute_request_json_scoped_with_lease(
        &self,
        body: &str,
        protocol: &str,
        wire_model: &str,
        stream: bool,
        request_id: &str,
        port: u16,
        session_scope: &str,
        conversation_scope: &str,
        continuation_owner: Option<&str>,
        request_lease: Option<&RuntimeLease>,
    ) -> Result<ExecutionReport, RuntimeFault> {
        self.execute_request_json_scoped_for_target_with_lease(
            body,
            protocol,
            protocol,
            wire_model,
            stream,
            request_id,
            port,
            session_scope,
            conversation_scope,
            continuation_owner,
            request_lease,
        )
    }

    pub fn execute_request_json_scoped_for_target_with_lease(
        &self,
        body: &str,
        client_protocol: &str,
        provider_protocol: &str,
        wire_model: &str,
        stream: bool,
        request_id: &str,
        port: u16,
        session_scope: &str,
        conversation_scope: &str,
        continuation_owner: Option<&str>,
        request_lease: Option<&RuntimeLease>,
    ) -> Result<ExecutionReport, RuntimeFault> {
        if let Some(lease) = request_lease {
            if lease.request_id() != request_id {
                return Err(RuntimeFault::new(
                    "execution_epoch_scope",
                    "request lease id mismatch",
                ));
            }
        }
        let mut value: Value = serde_json::from_str(body)
            .map_err(|error| RuntimeFault::new("request_json_invalid", error.to_string()))?;
        let object = value.as_object_mut().ok_or_else(|| {
            RuntimeFault::new("request_json_invalid", "request body must be an object")
        })?;
        object.insert("model".to_string(), Value::String(wire_model.to_string()));
        object.insert("stream".to_string(), Value::Bool(stream));
        let raw = serde_json::to_string(&value)
            .map_err(|error| RuntimeFault::new("request_json_encode", error.to_string()))?;
        if request_lease.is_none() {
            self.claim(request_id)?;
        }
        let client_protocol = canonical_protocol_information(client_protocol)?;
        let provider_protocol = canonical_protocol_information(provider_protocol)?;
        let execution_lane = continuation_owner.ok_or_else(|| {
            RuntimeFault::new(
                "execution_lane_missing",
                "Direct/Relay execution lane is required",
            )
        })?;
        let chain_id = match execution_lane {
            "direct" => "direct_request",
            "relay" => "relay_request",
            other => {
                return Err(RuntimeFault::new(
                    "execution_lane_invalid",
                    format!("unsupported execution lane {other}"),
                ))
            }
        };
        let result = self.execute_path(
            chain_id,
            request_id,
            port,
            session_scope,
            conversation_scope,
            |ctx| {
                ctx.data.raw_entry = Some(raw);
                ctx.information.protocol = Some(client_protocol.to_string());
                ctx.information.execution_lane = Some(execution_lane.to_string());
                ctx.information.client_protocol = Some(client_protocol.to_string());
                ctx.information.provider_protocol = Some(provider_protocol.to_string());
                ctx.information.model = Some(wire_model.to_string());
                if let Some(owner) = continuation_owner {
                    ctx.control.continuation_owner = Some(owner.to_string());
                }
            },
            request_lease.map(RuntimeLease::epoch_lease),
        );
        if request_lease.is_none() {
            self.release(request_id);
        }
        result
    }

    /// Request inbound entry for a typed keyless fixture. Protocol fields stay
    /// in the data/information views; only the fixture body enters the normal
    /// request chain as its raw entry.
    pub fn execute_request_fixture_scoped(
        &self,
        fixture: &KeylessChatFixture,
        request_id: &str,
        port: u16,
        session_scope: &str,
        conversation_scope: &str,
    ) -> Result<ExecutionReport, RuntimeFault> {
        self.claim(request_id)?;
        let chain_id = if fixture.path.starts_with("/v1/responses") {
            "direct_request"
        } else {
            "relay_request"
        };
        let result = self.execute_path(
            chain_id,
            request_id,
            port,
            session_scope,
            conversation_scope,
            |ctx| {
                ctx.data.raw_entry = Some(fixture.body.clone());
                ctx.data.request_method = Some(fixture.method.clone());
                ctx.data.request_path = Some(fixture.path.clone());
                ctx.data.request_headers = Some(fixture.headers.clone());
                ctx.information.endpoint = Some(fixture.path.clone());
                ctx.information.execution_lane = Some(chain_id.to_string());
                ctx.information.client_protocol = Some(
                    if chain_id == "direct_request" {
                        "openai-responses"
                    } else {
                        "openai-chat"
                    }
                    .to_string(),
                );
                ctx.information.provider_protocol = Some("openai-responses".to_string());
                ctx.information.model = Some(fixture.model.clone());
            },
            None,
        );
        self.release(request_id);
        result
    }

    /// Fixed response slice with a provider frame:
    /// provider boundary -> Hub governance -> server projection.
    pub fn execute_provider_response(
        &self,
        provider_raw: &str,
        request_id: &str,
    ) -> Result<ExecutionReport, RuntimeFault> {
        self.execute_provider_response_scoped(
            provider_raw,
            request_id,
            0,
            "",
            "",
            "responses",
            "relay",
        )
    }

    /// Response slice with continuation facts so commit can bind the three-key
    /// save (entry protocol + owner + session/conversation(+port/group)).
    pub fn execute_provider_response_scoped(
        &self,
        provider_raw: &str,
        request_id: &str,
        port: u16,
        session_scope: &str,
        conversation_scope: &str,
        entry_protocol: &str,
        continuation_owner: &str,
    ) -> Result<ExecutionReport, RuntimeFault> {
        self.execute_provider_response_scoped_with_lease(
            provider_raw,
            request_id,
            port,
            session_scope,
            conversation_scope,
            entry_protocol,
            continuation_owner,
            None,
        )
    }

    pub fn execute_provider_response_scoped_with_lease(
        &self,
        provider_raw: &str,
        request_id: &str,
        port: u16,
        session_scope: &str,
        conversation_scope: &str,
        entry_protocol: &str,
        continuation_owner: &str,
        request_lease: Option<&RuntimeLease>,
    ) -> Result<ExecutionReport, RuntimeFault> {
        let provider_protocol = if entry_protocol == "chat" {
            "responses"
        } else {
            entry_protocol
        };
        self.execute_provider_response_scoped_for_target_with_lease(
            provider_raw,
            request_id,
            port,
            session_scope,
            conversation_scope,
            entry_protocol,
            provider_protocol,
            continuation_owner,
            request_lease,
        )
    }

    pub fn execute_provider_response_scoped_for_target_with_lease(
        &self,
        provider_raw: &str,
        request_id: &str,
        port: u16,
        session_scope: &str,
        conversation_scope: &str,
        entry_protocol: &str,
        provider_protocol: &str,
        continuation_owner: &str,
        request_lease: Option<&RuntimeLease>,
    ) -> Result<ExecutionReport, RuntimeFault> {
        if let Some(lease) = request_lease {
            if lease.request_id() != request_id {
                return Err(RuntimeFault::new(
                    "execution_epoch_scope",
                    "request lease id mismatch",
                ));
            }
        }
        if request_lease.is_none() {
            self.claim(request_id)?;
        }
        let entry_protocol = canonical_protocol_information(entry_protocol)?;
        let provider_protocol = canonical_protocol_information(provider_protocol)?;
        let chain_id = match continuation_owner {
            "direct" => "direct_response",
            "relay" => "relay_response",
            other => {
                return Err(RuntimeFault::new(
                    "execution_lane_invalid",
                    format!("unsupported execution lane {other}"),
                ))
            }
        };
        let result = self.execute_path(
            chain_id,
            request_id,
            port,
            session_scope,
            conversation_scope,
            |ctx| {
                ctx.data.provider_raw = Some(provider_raw.to_string());
                ctx.information.protocol = Some(entry_protocol.to_string());
                ctx.information.execution_lane = Some(continuation_owner.to_string());
                ctx.information.client_protocol = Some(entry_protocol.to_string());
                ctx.information.provider_protocol = Some(provider_protocol.to_string());
                ctx.control.continuation_owner = Some(continuation_owner.to_string());
                ctx.control.execution_mode = Some(if continuation_owner == "relay" {
                    "relay".to_string()
                } else {
                    "direct".to_string()
                });
            },
            request_lease.map(RuntimeLease::epoch_lease),
        );
        if request_lease.is_none() {
            self.release(request_id);
        }
        result
    }

    /// Open a payload cycle (request_sent) for a request id.
    pub fn open_payload_cycle(
        &self,
        request_id: &str,
        original_request_hash: &str,
    ) -> Result<(), RuntimeFault> {
        self.payload_cycles
            .borrow_mut()
            .open(request_id, original_request_hash)
            .map(|_| ())
            .map_err(|error| RuntimeFault::new("payload_cycle", error.to_string()))
    }

    /// Merge a retry into the same payload cycle.
    pub fn merge_payload_cycle(&self, request_id: &str) -> Result<(), RuntimeFault> {
        self.payload_cycles
            .borrow_mut()
            .merge_retry(request_id)
            .map(|_| ())
            .map_err(|error| RuntimeFault::new("payload_cycle", error.to_string()))
    }

    /// Close a payload cycle as success terminal.
    pub fn close_payload_cycle_success(&self, request_id: &str) -> Result<(), RuntimeFault> {
        self.payload_cycles
            .borrow_mut()
            .close_success(request_id)
            .map(|_| ())
            .map_err(|error| RuntimeFault::new("payload_cycle", error.to_string()))
    }

    /// Close a payload cycle as error terminal.
    pub fn close_payload_cycle_error(&self, request_id: &str) -> Result<(), RuntimeFault> {
        self.payload_cycles
            .borrow_mut()
            .close_error(request_id)
            .map(|_| ())
            .map_err(|error| RuntimeFault::new("payload_cycle", error.to_string()))
    }

    /// Generic chain execution. External-owned chains (error/config) must not
    /// be executed here; invoking them fails fast.
    pub fn execute_chain(
        &self,
        chain_id: &str,
        request_id: &str,
    ) -> Result<ExecutionReport, RuntimeFault> {
        self.claim(request_id)?;
        let result = self.execute_path(chain_id, request_id, 0, "", "", |_| {}, None);
        self.release(request_id);
        result
    }

    fn execute_path(
        &self,
        chain_id: &str,
        request_id: &str,
        port: u16,
        session_scope: &str,
        conversation_scope: &str,
        seed: impl FnOnce(&mut ExecutionContext),
        provided_lease: Option<&routecodex_v4_node_container::EpochLease>,
    ) -> Result<ExecutionReport, RuntimeFault> {
        let owned_lease = if provided_lease.is_none() {
            Some(
                self.epoch_store
                    .admit()
                    .map_err(|error| RuntimeFault::new("execution_epoch", error.to_string()))?,
            )
        } else {
            None
        };
        let lease = provided_lease.or(owned_lease.as_ref()).ok_or_else(|| {
            RuntimeFault::new("execution_epoch", "execution epoch lease is missing")
        })?;
        let snapshot = lease.snapshot();
        let binding = ExecutionBinding {
            skeleton_version: self.plan.skeleton_version.clone(),
            manifest_hash: snapshot.manifest_hash,
            plan_epoch: snapshot.plan_epoch,
            plan_hash: snapshot.execution_identity,
        };
        let mut ctx = ExecutionContext::with_scope(
            request_id,
            binding,
            port,
            session_scope,
            conversation_scope,
        );
        seed(&mut ctx);
        let initial_frame = ctx.clone().into_frame(chain_id)?;
        let outcome = ExecutionEngine::execute_pinned_node(
            chain_id,
            initial_frame,
            lease,
            &self.handle_registry,
        )
        .map_err(|error| RuntimeFault::new("execution_engine", error.to_string()))?;
        if let NodeOutcome::Failure { error } = &outcome {
            let mut fault = RuntimeFault::new(
                error
                    .get("code")
                    .and_then(Value::as_str)
                    .unwrap_or("execution_failure"),
                error
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or("execution failed"),
            );
            if let Some(node_id) = error.get("node_id").and_then(Value::as_str) {
                fault = fault.with_node(node_id);
            }
            return Err(fault);
        }
        ctx = match outcome {
            NodeOutcome::Continue {
                data,
                control,
                information,
                events,
            } => ctx.from_frame(
                chain_id,
                &NodeExecutionFrame::with_side_channels(data, control, information, events),
            )?,
            NodeOutcome::Terminal { .. } => {
                ctx.data = DataView::default();
                ctx
            }
            NodeOutcome::Failure { .. } => unreachable!("failure returned above"),
            NodeOutcome::Branch { .. } => {
                return Err(RuntimeFault::new(
                    "execution_branch_unresolved",
                    "execution chain ended on branch",
                ));
            }
        };
        Ok(ExecutionReport {
            request_id: request_id.to_string(),
            binding: ctx.binding().clone(),
            scope: ctx.scope().clone(),
            provider_wire: ctx.data.provider_wire.clone(),
            provider_wire_value: ctx
                .data
                .provider_wire
                .as_deref()
                .filter(|wire| wire.trim_start().starts_with('{'))
                .map(serde_json::from_str)
                .transpose()
                .map_err(|error| RuntimeFault::new("provider_wire_decode", error.to_string()))?,
            client_frame: ctx.data.client_frame.clone(),
            continuation_scope: ctx.control.continuation_scope.clone(),
            continuation_owner: ctx.control.continuation_owner.clone(),
            execution_mode: ctx.control.execution_mode.clone(),
            relay_operator_selected: ctx.control.relay_operator_selected,
            route_exit: ctx.control.route_exit.clone(),
            continuation_committed: ctx.control.continuation_committed,
            continuation_restored: ctx.control.continuation_restored,
            trace: ctx.diagnostic.trace.clone(),
        })
    }
}

/// Route a runtime fault through the single error chain owner
/// (`routecodex-v4-error`): raise -> capture -> classify (witness) -> policy ->
/// decision -> terminal client projection. No fallback, no silent strip.
pub fn project_runtime_fault(
    chain: &mut ErrorChain,
    fault: RuntimeFault,
) -> Result<ClientProjection, ErrorChainError> {
    let reason_code = fault.code.clone();
    project_runtime_fault_with_policy(
        chain,
        fault,
        RetryPolicy {
            policy_id: "policy.no-retry.terminal".to_string(),
            provider_scope: "all".to_string(),
            matcher: "runtime-fault".to_string(),
            action_class: "terminal".to_string(),
            reason_code: reason_code.clone(),
        },
        ExecutionDecision {
            decision_id: "decision.terminal".to_string(),
            action: DecisionAction::Terminal,
            reason_code,
        },
    )
}

/// Project a runtime fault through the fixed ErrorErr01-06 chain with a
/// typed policy and execution decision supplied by the owning policy layer.
/// The policy is side-channel data; payload content is never inspected.
pub fn project_runtime_fault_with_policy(
    chain: &mut ErrorChain,
    fault: RuntimeFault,
    policy: RetryPolicy,
    decision: ExecutionDecision,
) -> Result<ClientProjection, ErrorChainError> {
    let scope = chain.scope().clone();
    let mut center = ErrorCenter::new(scope);
    let node = fault.node_id.as_deref().unwrap_or("unknown");
    let control_digest = sha256_control_digest(&format!("fault:{}:node:{}", fault.code, node));
    chain.raise(
        &fault.code,
        Some(&control_digest),
        Some(&format!("node:{node}")),
    )?;
    let captured = chain.capture()?;
    let witness = center.classify(captured)?;
    chain.classify(witness)?;
    chain.apply_policy(policy)?;
    chain.decide(decision)?;
    chain.project(&fault.message)
}

/// Hash only typed error/control identity. Business payload bytes never enter
/// the error-chain digest.
fn sha256_control_digest(value: &str) -> String {
    format!("sha256:{:x}", Sha256::digest(value.as_bytes()))
}

// ---------------------------------------------------------------------------
// M8 first-slice surface: keyless fixture + mock transport.
// ---------------------------------------------------------------------------

/// Lightweight request identity token produced by the mock transport slice.
/// Mirrors the server crate's `V4RequestIdCounter` contract intentionally so
/// the runtime slice stays free of frozen Active crate imports.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MockTransportIdentity {
    pub request_id: String,
    pub server_id: String,
    pub local_day: String,
}

/// In-memory request identity counter used by the mock transport slice.
/// The counter is monotonically increasing per (server_id, local_day); both
/// keys must be non-empty.
#[derive(Debug, Default)]
pub struct MockTransportIdentityCounter {
    counters: std::collections::BTreeMap<(String, String), u64>,
}

impl MockTransportIdentityCounter {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn next_identity(
        &mut self,
        server_id: &str,
        local_day: &str,
    ) -> Result<MockTransportIdentity, String> {
        if server_id.is_empty() {
            return Err("server_id is empty".to_string());
        }
        if local_day.is_empty() {
            return Err("local_day is empty".to_string());
        }
        let key = (server_id.to_string(), local_day.to_string());
        let next = self.counters.get(&key).copied().unwrap_or(0) + 1;
        self.counters.insert(key, next);
        Ok(MockTransportIdentity {
            request_id: format!("mock.{server_id}-{local_day}-{next:08}"),
            server_id: server_id.to_string(),
            local_day: local_day.to_string(),
        })
    }
}

/// Keyless chat fixture mirror. The runtime slice is intentionally keyless
/// and mock-transport only; the runtime mirror keeps the runtime tests
/// self-contained. The `routecodex-v4-server::KeylessChatFixture` type
/// remains the field-level owner for the production path.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KeylessChatFixture {
    pub method: String,
    pub path: String,
    pub headers: Vec<(String, String)>,
    pub body: String,
    pub model: String,
}

impl KeylessChatFixture {
    pub fn new(
        method: impl Into<String>,
        path: impl Into<String>,
        headers: Vec<(String, String)>,
        body: impl Into<String>,
        model: impl Into<String>,
    ) -> Self {
        Self {
            method: method.into(),
            path: path.into(),
            headers,
            body: body.into(),
            model: model.into(),
        }
    }

    /// Convenience constructor for chat completion requests. The body is the
    /// raw text the request chain parses for the entry protocol prefix.
    pub fn chat(body: impl Into<String>, model: impl Into<String>) -> Self {
        Self::new("POST", "/v1/chat/completions", Vec::new(), body, model)
    }
}

/// Fault codes the mock transport slice may emit. Anything else fails fast
/// via `unknown_mock_transport_fault_code`.
pub const MOCK_TRANSPORT_FAULT_CODES: &[&str] = &[
    "keyless_fixture_invalid",
    "duplicate_request_id",
    "cross_request_reuse",
    "raw_parse",
    "json_parse",
    "unknown_mock_transport_fault_code",
];

/// True when the supplied fault code is one of the mock transport slice's
/// recognised codes.
pub fn is_known_mock_transport_fault_code(code: &str) -> bool {
    MOCK_TRANSPORT_FAULT_CODES
        .iter()
        .any(|known| *known == code)
}

/// Typed projection of a mock transport slice fault. The slice surfaces
/// fault codes and node ids so the test consumer can assert fail-fast
/// contract behaviour.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MockTransportError {
    pub fault_code: String,
    pub node_id: String,
    pub message: String,
    pub client_projection_message: String,
}

/// Result of a single M8 first-slice mock transport run: bound identity,
/// typed request/response wire pair, continuation commit state, optional
/// error projection, and the captured diagnostic trace.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MockTransportReport {
    pub request_id: String,
    pub request_binding: ExecutionBinding,
    pub provider_wire: String,
    pub client_frame: String,
    pub continuation_committed: bool,
    pub continuation_owner: String,
    pub fixture_method: String,
    pub fixture_path: String,
    pub fixture_model: String,
    pub fixture_headers: Vec<(String, String)>,
    pub relay_operator_accepted: bool,
    pub error_projection_scope: Option<routecodex_v4_base_node::Scope>,
    pub trace: Vec<String>,
    pub error: Option<MockTransportError>,
}

/// One-shot run of the M8 first-slice mock transport. A server-side keyless
/// chat fixture enters the request chain; a mock provider frame enters the
/// response chain; the typed `MockTransportReport` collapses both halves.
/// The three-key continuation scope is bound at the response commit step.
/// The slice does NOT touch real provider wire, real credentials, or any
/// outbound network.
pub fn execute_mock_transport_slice(
    runtime: &SkeletonRuntime,
    identity_counter: &mut MockTransportIdentityCounter,
    fixture: &KeylessChatFixture,
    mock_provider_frame: &str,
    server_id: &str,
    local_day: &str,
    port: u16,
    session_scope: &str,
    conversation_scope: &str,
    entry_protocol: &str,
    continuation_owner: &str,
) -> Result<MockTransportReport, RuntimeFault> {
    if server_id.is_empty()
        || local_day.is_empty()
        || fixture.method.is_empty()
        || fixture.path.is_empty()
        || fixture.body.is_empty()
        || fixture.model.is_empty()
        || session_scope.is_empty()
        || conversation_scope.is_empty()
        || entry_protocol.is_empty()
        || continuation_owner.is_empty()
    {
        return Err(RuntimeFault::new(
            "keyless_fixture_invalid",
            "fixture, continuation, and protocol identity fields must be non-empty",
        ));
    }
    if mock_provider_frame.trim().is_empty() {
        return Err(RuntimeFault::new(
            "keyless_fixture_invalid",
            "mock_provider_frame must be non-empty",
        ));
    }
    let operator = select_relay_operator(&ContinuationFacts::new(
        entry_protocol,
        entry_protocol,
        continuation_owner,
        if continuation_owner == "relay" {
            "relay"
        } else {
            "direct"
        },
    ))
    .map_err(|error| {
        RuntimeFault::new(
            "keyless_fixture_invalid",
            format!(
                "entry_protocol={entry_protocol} continuation_owner={continuation_owner} not accepted: {error}"
            ),
        )
    })?;
    let relay_operator_accepted = matches!(operator, RelayOperator::Relay | RelayOperator::Direct);
    let expected_path_prefix = match entry_protocol {
        "chat" => "/v1/chat/completions",
        "responses" => "/v1/responses",
        _ => {
            return Err(RuntimeFault::new(
                "keyless_fixture_invalid",
                format!("entry_protocol {entry_protocol} is not a recognised mock slice entry"),
            ))
        }
    };
    if !fixture.path.starts_with(expected_path_prefix) {
        return Err(RuntimeFault::new(
            "keyless_fixture_invalid",
            format!(
                "fixture path {} does not match entry_protocol {entry_protocol} (expected prefix {expected_path_prefix})",
                fixture.path
            ),
        ));
    }
    let fixture_body: Value = serde_json::from_str(&fixture.body).map_err(|error| {
        RuntimeFault::new(
            "keyless_fixture_invalid",
            format!("fixture body must be protocol JSON: {error}"),
        )
    })?;
    let required_field = if entry_protocol == "chat" {
        "messages"
    } else {
        "input"
    };
    if !fixture_body
        .get(required_field)
        .is_some_and(Value::is_array)
    {
        return Err(RuntimeFault::new(
            "keyless_fixture_invalid",
            format!(
                "fixture body does not match entry_protocol {entry_protocol} (expected {required_field} array)"
            ),
        ));
    }
    let identity = identity_counter
        .next_identity(server_id, local_day)
        .map_err(|error| {
            RuntimeFault::new(
                "keyless_fixture_invalid",
                format!("request identity counter failed: {error}"),
            )
        })?;
    let bound = execution_binding(runtime.plan());
    // Real fixture fields enter the request chain via the typed request
    // inbound entry, not via a body-only path. This keeps the request
    // outbound wire pinned to the exact (method, path, headers, model) the
    // caller declared; the model field is no longer silently rewritten
    // to "mock-provider".
    let request_report = runtime.execute_request_fixture_scoped(
        fixture,
        &identity.request_id,
        port,
        session_scope,
        conversation_scope,
    )?;
    if request_report.binding != bound {
        return Err(RuntimeFault::new(
            "unknown_mock_transport_fault_code",
            "request execution binding drifted from skeleton plan",
        ));
    }
    // The request chain is the single source of truth for the scope the
    // error chain must consume. We never fabricate a synthetic scope; the
    // error projection below uses the exact scope the request chain bound
    // for this same request id.
    let request_scope = request_report.scope.clone();
    let response_result = runtime.execute_provider_response_scoped(
        mock_provider_frame,
        &identity.request_id,
        port,
        session_scope,
        conversation_scope,
        entry_protocol,
        continuation_owner,
    );
    let mut trace = request_report.trace.clone();
    let response_report = match response_result {
        Ok(report) => report,
        Err(fault) => {
            trace.push(format!(
                "fault:{}-at-{}",
                fault.code,
                fault.node_id.clone().unwrap_or_default()
            ));
            let projection = error_chain_client_projection_message(&fault, &request_scope)?;
            return Ok(MockTransportReport {
                request_id: identity.request_id,
                request_binding: request_report.binding,
                provider_wire: request_report.provider_wire.clone().unwrap_or_default(),
                client_frame: String::new(),
                continuation_committed: false,
                continuation_owner: continuation_owner.to_string(),
                fixture_method: fixture.method.clone(),
                fixture_path: fixture.path.clone(),
                fixture_model: fixture.model.clone(),
                fixture_headers: fixture.headers.clone(),
                relay_operator_accepted,
                error_projection_scope: Some(request_scope),
                trace,
                error: Some(MockTransportError {
                    fault_code: fault.code.clone(),
                    node_id: fault.node_id.clone().unwrap_or_default(),
                    message: fault.message.clone(),
                    client_projection_message: projection,
                }),
            });
        }
    };
    if response_report.binding != request_report.binding {
        return Err(RuntimeFault::new(
            "unknown_mock_transport_fault_code",
            "response execution binding drifted from request binding",
        ));
    }
    let provider_wire = request_report.provider_wire.clone().ok_or_else(|| {
        RuntimeFault::new("unknown_mock_transport_fault_code", "missing provider wire")
    })?;
    let client_frame = response_report.client_frame.clone().ok_or_else(|| {
        RuntimeFault::new("unknown_mock_transport_fault_code", "missing client frame")
    })?;
    trace.extend(response_report.trace.iter().cloned());
    Ok(MockTransportReport {
        request_id: identity.request_id,
        request_binding: request_report.binding,
        provider_wire,
        client_frame,
        continuation_committed: response_report.continuation_committed,
        continuation_owner: continuation_owner.to_string(),
        fixture_method: fixture.method.clone(),
        fixture_path: fixture.path.clone(),
        fixture_model: fixture.model.clone(),
        fixture_headers: fixture.headers.clone(),
        relay_operator_accepted,
        error_projection_scope: None,
        trace,
        error: None,
    })
}

fn error_chain_client_projection_message(
    fault: &RuntimeFault,
    request_scope: &routecodex_v4_base_node::Scope,
) -> Result<String, RuntimeFault> {
    // The error chain consumes the real scope produced by the request chain
    // for the same request id. We never fabricate a scope from a static
    // placeholder; the previous "mock-transport-slice/port=0" synthetic
    // scope made the error chain indistinguishable from a fabricated one
    // and is removed.
    let mut chain = ErrorChain::new(request_scope.clone());
    match project_runtime_fault(&mut chain, fault.clone()) {
        Ok(projection) => Ok(projection.message),
        Err(error) => Err(RuntimeFault::new(
            "unknown_mock_transport_fault_code",
            format!("error-chain projection failed: {error:?}"),
        )),
    }
}
