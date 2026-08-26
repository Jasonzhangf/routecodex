//! routecodex-v4-runtime — minimal skeleton runtime vertical slice (Phase 4).
//!
//! Owns:
//! - `NodeContainer` + `NodePluginPlan` compiled from the immutable
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
use routecodex_v4_error::{
    ClientProjection, DecisionAction, ErrorCenter, ErrorChain, ErrorChainError, ExecutionDecision,
    RetryPolicy,
};
use routecodex_v4_skeleton::SkeletonPlan;
use serde_json::Value;
use std::cell::RefCell;
use std::collections::HashMap;
use std::collections::HashSet;
use std::fmt;


mod control_resources;

pub mod request_port;
pub mod response_error_port;

pub use control_resources::*;
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

/// Adjacent relay request projection owned by the Rust Hub runtime. Unknown
/// client data fields are preserved; only protocol-defined Chat fields are
/// renamed or structurally converted for a Responses upstream.
pub fn project_chat_request_to_responses(client_body: &Value) -> Result<Value, RuntimeFault> {
    let object = client_body.as_object().ok_or_else(|| {
        RuntimeFault::new("chat_request_invalid", "Chat request must be an object")
    })?;
    let messages = object
        .get("messages")
        .and_then(Value::as_array)
        .ok_or_else(|| RuntimeFault::new("chat_request_invalid", "messages must be an array"))?;
    let mut projected = object.clone();
    projected.remove("messages");
    projected.insert("input".to_string(), Value::Array(messages.clone()));
    if let Some(max_tokens) = object.get("max_tokens") {
        projected.remove("max_tokens");
        projected.insert("max_output_tokens".to_string(), max_tokens.clone());
    }
    if let Some(tools) = object.get("tools").and_then(Value::as_array) {
        let tools = tools
            .iter()
            .map(|tool| {
                let function = tool.get("function").ok_or_else(|| {
                    RuntimeFault::new("chat_request_invalid", "function tool body is required")
                })?;
                Ok(serde_json::json!({
                    "type": "function",
                    "name": function.get("name").cloned().unwrap_or(Value::Null),
                    "description": function.get("description").cloned().unwrap_or(Value::Null),
                    "parameters": function.get("parameters").cloned().unwrap_or_else(|| serde_json::json!({}))
                }))
            })
            .collect::<Result<Vec<_>, RuntimeFault>>()?;
        projected.insert("tools".to_string(), Value::Array(tools));
    }
    Ok(Value::Object(projected))
}

#[derive(Debug, Clone, PartialEq)]
pub enum ResponsesProviderPayload {
    Json(Value),
    Sse(Vec<u8>),
}

#[derive(Debug, Clone, PartialEq)]
pub struct ResponsesSseFrame {
    pub events: Vec<Value>,
    pub terminal: bool,
}

/// Validate one complete Responses SSE frame. Returns true only for a
/// terminal `response.completed` or `response.failed` event.
pub fn validate_responses_sse_frame(frame: &[u8]) -> Result<bool, RuntimeFault> {
    parse_responses_sse_frame(frame).map(|parsed| parsed.terminal)
}

pub fn parse_responses_sse_frame(frame: &[u8]) -> Result<ResponsesSseFrame, RuntimeFault> {
    let text = std::str::from_utf8(frame)
        .map_err(|error| RuntimeFault::new("provider_sse_utf8", error.to_string()))?;
    let mut events = Vec::new();
    let mut terminal = false;
    for line in text.lines() {
        let line = line.strip_suffix('\r').unwrap_or(line);
        if let Some(value) = line.strip_prefix("data:") {
            let value = value.trim();
            if value == "[DONE]" {
                continue;
            }
            let event: Value = serde_json::from_str(value)
                .map_err(|error| RuntimeFault::new("provider_sse_malformed", error.to_string()))?;
            let event_type = event
                .get("type")
                .and_then(Value::as_str)
                .unwrap_or_default();
            if matches!(event_type, "response.completed" | "response.failed") {
                terminal = true;
            }
            events.push(event);
        }
    }
    if events.is_empty() {
        return Err(RuntimeFault::new(
            "provider_sse_missing_data",
            "Responses SSE frame has no data field",
        ));
    }
    Ok(ResponsesSseFrame { events, terminal })
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

/// Parse and validate the provider response at the response-inbound owner.
/// The returned bytes/JSON remain data-plane content; transport and error
/// facts stay outside the payload.
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
        validate_responses_sse(body)?;
        return Ok(ResponsesProviderPayload::Sse(body.to_vec()));
    }
    let value: Value = serde_json::from_slice(body)
        .map_err(|error| RuntimeFault::new("provider_json_parse", error.to_string()))?;
    let object = value.as_object().ok_or_else(|| {
        RuntimeFault::new(
            "provider_json_shape",
            "Responses provider JSON must be an object",
        )
    })?;
    let response_status = object
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if response_status != "completed" {
        return Err(RuntimeFault::new(
            "provider_json_not_terminal",
            format!("Responses provider JSON terminal status must be completed, got {response_status:?}"),
        ));
    }
    let response_error = object.get("error").filter(|value| !value.is_null());
    if let Some(error) = response_error {
        return Err(RuntimeFault::new(
            "provider_response_failed",
            format!("Responses provider JSON returned a failed response: {error}"),
        ));
    }
    if !value.is_object() {
        return Err(RuntimeFault::new(
            "provider_json_shape",
            "Responses provider JSON must be an object",
        ));
    }
    Ok(ResponsesProviderPayload::Json(value))
}

fn validate_responses_sse(body: &[u8]) -> Result<(), RuntimeFault> {
    let text = std::str::from_utf8(body)
        .map_err(|error| RuntimeFault::new("provider_sse_utf8", error.to_string()))?;
    let mut data_lines = 0usize;
    for line in text.lines() {
        let line = line.trim_end_matches('\r');
        if let Some(data) = line.strip_prefix("data:") {
            let data = data.trim();
            if data != "[DONE]" {
                serde_json::from_str::<Value>(data).map_err(|error| {
                    RuntimeFault::new("provider_sse_malformed", error.to_string())
                })?;
            }
            data_lines += 1;
        }
    }
    if data_lines == 0 {
        return Err(RuntimeFault::new(
            "provider_sse_empty",
            "provider SSE contained no data frames",
        ));
    }
    Ok(())
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
#[derive(Debug, Clone, Default)]
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

/// Control plane view: typed side-channel only; never projected into payload.
/// Phase 7: `MetadataCenter` is the `control_view` owner, bound to the
/// request closed-loop scope.
#[derive(Debug, Clone)]
pub struct ControlView {
    pub governance_applied: bool,
    pub execution_plan: Option<String>,
    pub route_facts: Option<String>,
    pub target_selection: Option<String>,
    pub metadata: MetadataCenter,
}

/// Information plane view: protocol facts that may legitimately shape
/// projection (entry protocol, endpoint, model).
#[derive(Debug, Clone, Default)]
pub struct InformationView {
    pub protocol: Option<String>,
    pub endpoint: Option<String>,
    pub model: Option<String>,
}

/// Diagnostic view: execution trace, observability only, never live-path input.
#[derive(Debug, Clone, Default)]
pub struct DiagnosticView {
    pub trace: Vec<String>,
}

/// Typed carrier per request closed loop. Never global, never shared across
/// request ids.
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
        // dimensions use `with_scope` for closed-loop request isolation.
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
                governance_applied: false,
                execution_plan: None,
                route_facts: None,
                target_selection: None,
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
}

/// Plane isolation is structural: data and control are disjoint typed views.
/// Payload field names never reconstruct or identify runtime control state.
pub fn assert_no_control_leak(ctx: &ExecutionContext) -> Result<(), RuntimeFault> {
    let _ = (&ctx.data, &ctx.control);
    Ok(())
}

/// Static plugin capability boundary. Plugins are node-local: they only touch
/// their declared view through `ExecutionContext`; no next_node effect exists.
pub struct RuntimeRegistries<'a> {
    pub payload_cycle: &'a mut PayloadCycleRegistry,
}

pub trait NodePlugin: Send + Sync {
    fn plugin_id(&self) -> &'static str;
    fn kind(&self) -> PluginKind;
    fn execute(
        &self,
        ctx: &mut ExecutionContext,
        registries: &mut RuntimeRegistries<'_>,
    ) -> Result<(), RuntimeFault>;
}

struct ProtocolParse;
impl NodePlugin for ProtocolParse {
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
        let protocol = if raw.starts_with("chat:") {
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
impl NodePlugin for Normalize {
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
        ctx.data.normalized_request = Some(format!("normalized:{protocol}:{}", ctx.request_id()));
        Ok(())
    }
}

struct InputValidate;
impl NodePlugin for InputValidate {
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
        if !(raw.starts_with("chat:") || raw.starts_with("responses:")) {
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
impl NodePlugin for Governance {
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
impl NodePlugin for ExecutionPlan {
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
        Ok(())
    }
}

struct SemanticProjection;
impl NodePlugin for SemanticProjection {
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
        ctx.data.provider_semantic = Some(format!("semantic:{model}:{normalized}"));
        Ok(())
    }
}

struct WireBuild;
impl NodePlugin for WireBuild {
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
        ctx.data.provider_wire = Some(format!("wire:{semantic}"));
        assert_no_control_leak(ctx)
    }
}

struct OutputValidate;
impl NodePlugin for OutputValidate {
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
impl NodePlugin for FrameParse {
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
impl NodePlugin for JsonParse {
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
impl NodePlugin for ProtocolDecode {
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
impl NodePlugin for ResponseGovernance {
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
impl NodePlugin for ToolHarvest {
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

struct ClientSemanticProjection;

fn responses_text(value: &Value) -> String {
    value
        .get("output")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|item| item.get("type").and_then(Value::as_str) == Some("message"))
        .filter_map(|item| item.get("content").and_then(Value::as_array))
        .flatten()
        .filter(|part| part.get("type").and_then(Value::as_str) == Some("output_text"))
        .filter_map(|part| part.get("text").and_then(Value::as_str))
        .collect::<Vec<_>>()
        .join("")
}

fn responses_tool_calls(value: &Value) -> Vec<Value> {
    value
        .get("output")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|item| item.get("type").and_then(Value::as_str) == Some("function_call"))
        .map(|item| {
            serde_json::json!({
                "id": item.get("call_id").or_else(|| item.get("id")).cloned().unwrap_or(Value::Null),
                "type": "function",
                "function": {
                    "name": item.get("name").cloned().unwrap_or(Value::Null),
                    "arguments": item.get("arguments").cloned().unwrap_or_else(|| Value::String(String::new()))
                }
            })
        })
        .collect()
}

fn project_responses_usage_to_chat(value: &Value) -> Value {
    let Some(usage) = value.get("usage").and_then(Value::as_object) else {
        return Value::Null;
    };
    let mut projected = serde_json::Map::new();
    for (source, target) in [
        ("input_tokens", "prompt_tokens"),
        ("output_tokens", "completion_tokens"),
        ("total_tokens", "total_tokens"),
        ("input_tokens_details", "prompt_tokens_details"),
        ("output_tokens_details", "completion_tokens_details"),
    ] {
        if let Some(field) = usage.get(source) {
            projected.insert(target.to_string(), field.clone());
        }
    }
    Value::Object(projected)
}

fn project_responses_json_to_chat(value: &Value) -> Value {
    let tool_calls = responses_tool_calls(value);
    let text = responses_text(value);
    let mut message = serde_json::json!({
        "role": "assistant",
        "content": if text.is_empty() { Value::Null } else { Value::String(text) }
    });
    if !tool_calls.is_empty() {
        message
            .as_object_mut()
            .expect("chat message is an object")
            .insert("tool_calls".to_string(), Value::Array(tool_calls.clone()));
    }
    let usage = project_responses_usage_to_chat(value);
    serde_json::json!({
        "id": value.get("id").cloned().unwrap_or_else(|| Value::String(String::new())),
        "object": "chat.completion",
        "created": value.get("created_at").cloned().unwrap_or_else(|| Value::Number(0.into())),
        "model": value.get("model").cloned().unwrap_or_else(|| Value::String(String::new())),
        "choices": [{
            "index": 0,
            "message": message,
            "finish_reason": if tool_calls.is_empty() { "stop" } else { "tool_calls" }
        }],
        "usage": usage
    })
}

fn project_responses_event_to_chat(value: &Value) -> Value {
    let event_type = value
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let response = value.get("response").unwrap_or(value);
    let mut delta = serde_json::Map::new();
    let mut finish_reason = Value::Null;
    match event_type {
        "response.created" | "response.in_progress" => {
            delta.insert("role".to_string(), Value::String("assistant".to_string()));
            delta.insert("content".to_string(), Value::String(String::new()));
        }
        "response.output_text.delta" => {
            delta.insert(
                "content".to_string(),
                value
                    .get("delta")
                    .cloned()
                    .unwrap_or_else(|| Value::String(String::new())),
            );
        }
        "response.output_item.added"
            if value
                .get("item")
                .and_then(|item| item.get("type"))
                .and_then(Value::as_str)
                == Some("function_call") =>
        {
            let item = &value["item"];
            delta.insert(
                "tool_calls".to_string(),
                Value::Array(vec![serde_json::json!({
                    "index": value.get("output_index").cloned().unwrap_or_else(|| Value::Number(0.into())),
                    "id": item.get("call_id").or_else(|| item.get("id")).cloned().unwrap_or(Value::Null),
                    "type": "function",
                    "function": {
                        "name": item.get("name").cloned().unwrap_or(Value::Null),
                        "arguments": item.get("arguments").cloned().unwrap_or_else(|| Value::String(String::new()))
                    }
                })]),
            );
        }
        "response.function_call_arguments.delta" => {
            delta.insert(
                "tool_calls".to_string(),
                Value::Array(vec![serde_json::json!({
                    "index": value.get("output_index").cloned().unwrap_or_else(|| Value::Number(0.into())),
                    "function": {
                        "arguments": value.get("delta").cloned().unwrap_or_else(|| Value::String(String::new()))
                    }
                })]),
            );
        }
        "response.completed" => {
            finish_reason = Value::String(
                if responses_tool_calls(response).is_empty() {
                    "stop"
                } else {
                    "tool_calls"
                }
                .to_string(),
            )
        }
        _ => {}
    }
    serde_json::json!({
        "id": response.get("id").cloned().unwrap_or_else(|| Value::String(String::new())),
        "object": "chat.completion.chunk",
        "created": response.get("created_at").cloned().unwrap_or_else(|| Value::Number(0.into())),
        "model": response.get("model").cloned().unwrap_or_else(|| Value::String(String::new())),
        "choices": [{"index": 0, "delta": Value::Object(delta), "finish_reason": finish_reason}]
    })
}

impl NodePlugin for ClientSemanticProjection {
    fn plugin_id(&self) -> &'static str {
        "client_semantic_projection"
    }
    fn kind(&self) -> PluginKind {
        PluginKind::Operator
    }
    fn execute(
        &self,
        ctx: &mut ExecutionContext,
        _registries: &mut RuntimeRegistries<'_>,
    ) -> Result<(), RuntimeFault> {
        let parsed = ctx.data.parsed_response.as_deref().ok_or_else(|| {
            RuntimeFault::new("client_semantic_projection", "parsed response missing")
        })?;
        let protocol = ctx.information.protocol.as_deref().unwrap_or("responses");
        let semantic = match protocol {
            "responses" => parsed.to_string(),
            "chat" | "openai_chat" => {
                let value: Value = serde_json::from_str(parsed).map_err(|error| {
                    RuntimeFault::new("client_semantic_projection", error.to_string())
                })?;
                let projected = if value.get("type").is_some() {
                    project_responses_event_to_chat(&value)
                } else {
                    project_responses_json_to_chat(&value)
                };
                serde_json::to_string(&projected).map_err(|error| {
                    RuntimeFault::new("client_semantic_projection", error.to_string())
                })?
            }
            other => {
                return Err(RuntimeFault::new(
                    "client_protocol_unsupported",
                    format!("unsupported client response protocol {other}"),
                ))
            }
        };
        ctx.data.client_semantic = Some(semantic);
        Ok(())
    }
}

struct SseFrame;
impl NodePlugin for SseFrame {
    fn plugin_id(&self) -> &'static str {
        "sse_frame"
    }
    fn kind(&self) -> PluginKind {
        PluginKind::Operator
    }
    fn execute(
        &self,
        ctx: &mut ExecutionContext,
        _registries: &mut RuntimeRegistries<'_>,
    ) -> Result<(), RuntimeFault> {
        let semantic =
            ctx.data.client_semantic.as_deref().ok_or_else(|| {
                RuntimeFault::new("sse_frame", "client semantic response missing")
            })?;
        let provider_raw = ctx
            .data
            .provider_raw
            .as_deref()
            .ok_or_else(|| RuntimeFault::new("sse_frame", "provider raw missing"))?;
        let is_sse = provider_raw
            .lines()
            .any(|line| line.strip_suffix('\r').unwrap_or(line).starts_with("data:"));
        if !is_sse {
            ctx.data.client_sse_frame = Some(semantic.to_string());
            return Ok(());
        }
        let protocol = ctx.information.protocol.as_deref().unwrap_or("responses");
        let mut frame = String::new();
        if protocol == "responses" {
            if let Some(event) = provider_raw.lines().find_map(|line| {
                line.strip_suffix('\r')
                    .unwrap_or(line)
                    .strip_prefix("event:")
                    .map(str::trim)
                    .filter(|event| !event.is_empty())
            }) {
                frame.push_str("event: ");
                frame.push_str(event);
                frame.push('\n');
            }
        }
        frame.push_str("data: ");
        frame.push_str(semantic);
        frame.push_str("\n\n");
        if protocol == "chat" {
            frame.push_str("data: [DONE]\n\n");
        }
        ctx.data.client_sse_frame = Some(frame);
        Ok(())
    }
}

struct FrameBuild;
impl NodePlugin for FrameBuild {
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

/// Static plugin registry: every request/response plugin is declared here.
/// Dynamic plugin discovery is forbidden.
pub static PLUGIN_REGISTRY: &[&dyn NodePlugin] = &[
    &ProtocolParse,
    &Normalize,
    &InputValidate,
    &Governance,
    &ExecutionPlan,
    &SemanticProjection,
    &WireBuild,
    &OutputValidate,
    &FrameParse,
    &JsonParse,
    &ProtocolDecode,
    &ResponseGovernance,
    &ToolHarvest,
    &ClientSemanticProjection,
    &SseFrame,
    &FrameBuild,
];

/// Chain plugins owned by other crates. The runtime never executes them; a
/// plan containing them is compiled into `PluginRef::External` and executing
/// such a node fails fast (`external_owner_violation`).
pub const EXTERNAL_CHAIN_PLUGINS: &[(&str, &str)] = &[
    ("error_source_capture", "routecodex-v4-error"),
    ("error_classify", "routecodex-v4-error"),
    ("error_policy_apply", "routecodex-v4-error"),
    ("execution_decision", "routecodex-v4-error"),
    ("client_projection", "routecodex-v4-error"),
    ("config_parse", "routecodex-v4-config"),
    ("config_validate", "routecodex-v4-config"),
    ("registry_build", "routecodex-v4-config"),
    ("manifest_publish", "routecodex-v4-config"),
];

fn resolve_local_plugin(plugin_id: &str) -> Option<&'static dyn NodePlugin> {
    PLUGIN_REGISTRY
        .iter()
        .copied()
        .find(|plugin| plugin.plugin_id() == plugin_id)
}

fn resolve_plugin(plugin_id: &str) -> Result<PluginRef, RuntimeFault> {
    if let Some((id, owner)) = EXTERNAL_CHAIN_PLUGINS
        .iter()
        .copied()
        .find(|(candidate, _)| *candidate == plugin_id)
    {
        return Ok(PluginRef::External {
            plugin_id: id,
            owner,
        });
    }
    resolve_local_plugin(plugin_id)
        .map(PluginRef::Local)
        .ok_or_else(|| {
            RuntimeFault::new(
                "unknown_plugin",
                format!("plugin {plugin_id} is not in the static registry"),
            )
        })
}

/// Resolved plugin slot: either a local static plugin or an externally owned
/// chain plugin (error/config owner).
#[derive(Clone, Copy)]
pub enum PluginRef {
    Local(&'static dyn NodePlugin),
    External {
        plugin_id: &'static str,
        owner: &'static str,
    },
}

impl fmt::Debug for PluginRef {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Local(plugin) => write!(formatter, "Local({})", plugin.plugin_id()),
            Self::External { plugin_id, owner } => {
                write!(formatter, "External({plugin_id}@{owner})")
            }
        }
    }
}

/// One compiled skeleton node with its resolved plugin slots.
#[derive(Debug)]
pub struct NodeContainer {
    pub node_id: String,
    pub chain: String,
    pub position: u32,
    pub role_id: String,
    pub terminal: bool,
    pub kernel: bool,
    pub plugins: Vec<PluginRef>,
}

/// Immutable compiled plugin plan: the runtime-consumable form of the skeleton.
#[derive(Debug)]
pub struct NodePluginPlan {
    chains: Vec<(String, Vec<NodeContainer>)>,
}

impl NodePluginPlan {
    /// Compile the skeleton plan into per-chain node containers. Fails fast on
    /// unknown plugins and non-consecutive positions (topology is already
    /// hash-locked by `SkeletonPlan::from_contract_json`; this is the second
    /// gate at the runtime boundary).
    pub fn build(plan: &SkeletonPlan) -> Result<Self, RuntimeFault> {
        let mut chains = Vec::with_capacity(plan.chains.len());
        for chain in &plan.chains {
            let nodes: Vec<NodeContainer> = chain
                .nodes
                .iter()
                .map(|slot| -> Result<NodeContainer, RuntimeFault> {
                    Ok(NodeContainer {
                        node_id: slot.node_id.clone(),
                        chain: slot.chain.clone(),
                        position: slot.position,
                        role_id: slot.role_id.clone(),
                        terminal: slot.terminal,
                        kernel: slot.kernel,
                        plugins: slot
                            .plugins
                            .iter()
                            .map(|binding| resolve_plugin(&binding.plugin_id))
                            .collect::<Result<Vec<_>, _>>()?,
                    })
                })
                .collect::<Result<Vec<_>, _>>()?;
            let mut positions: Vec<u32> = nodes.iter().map(|node| node.position).collect();
            positions.sort_unstable();
            for window in positions.windows(2) {
                if window[1] != window[0] + 1 {
                    return Err(RuntimeFault::new(
                        "non_adjacent_chain",
                        format!("chain {} positions are not consecutive", chain.chain_id),
                    ));
                }
            }
            chains.push((chain.chain_id.clone(), nodes));
        }
        Ok(Self { chains })
    }

    pub fn chain(&self, chain_id: &str) -> Result<&[NodeContainer], RuntimeFault> {
        self.chains
            .iter()
            .find(|(id, _)| id == chain_id)
            .map(|(_, nodes)| nodes.as_slice())
            .ok_or_else(|| RuntimeFault::new("unknown_chain", format!("chain {chain_id} missing")))
    }
}

/// Result of one chain execution: bound identity + produced wire + control
/// facts + diagnostic trace.
#[derive(Debug, Clone)]
pub struct ExecutionReport {
    pub request_id: String,
    pub binding: ExecutionBinding,
    pub scope: Scope,
    pub provider_wire: Option<String>,
    pub client_frame: Option<String>,
    pub trace: Vec<String>,
}

/// Skeleton runtime: loads the hash-locked immutable plan, compiles the plugin
/// plan, and executes chains with per-request scope isolation.
pub struct SkeletonRuntime {
    plan: SkeletonPlan,
    containers: NodePluginPlan,
    active_requests: RefCell<HashSet<String>>,
    payload_cycles: RefCell<PayloadCycleRegistry>,
}

impl SkeletonRuntime {
    pub fn load(contract_json: &str) -> Result<Self, RuntimeFault> {
        let plan = SkeletonPlan::from_contract_json(contract_json)
            .map_err(|error| RuntimeFault::new("plan_invalid", error.to_string()))?;
        let containers = NodePluginPlan::build(&plan)?;
        Ok(Self {
            plan,
            containers,
            active_requests: RefCell::new(HashSet::new()),
            payload_cycles: RefCell::new(PayloadCycleRegistry::new()),
        })
    }

    pub fn plan(&self) -> &SkeletonPlan {
        &self.plan
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

    /// Request slice with explicit port/session/conversation dimensions for
    /// closed-loop request isolation.
    pub fn execute_request_scoped(
        &self,
        raw_entry: &str,
        request_id: &str,
        port: u16,
        session_scope: &str,
        conversation_scope: &str,
    ) -> Result<ExecutionReport, RuntimeFault> {
        self.claim(request_id)?;
        let result = self.run_chain(
            "request",
            request_id,
            port,
            session_scope,
            conversation_scope,
            |ctx| {
                ctx.data.raw_entry = Some(raw_entry.to_string());
                ctx.information.model = Some("unselected".to_string());
            },
        );
        self.release(request_id);
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
        let result = self.run_chain("request", request_id, port, session_scope, conversation_scope, |ctx| {
            ctx.data.raw_entry = Some(fixture.body.clone());
            ctx.data.request_method = Some(fixture.method.clone());
            ctx.data.request_path = Some(fixture.path.clone());
            ctx.data.request_headers = Some(fixture.headers.clone());
            ctx.information.endpoint = Some(fixture.path.clone());
            ctx.information.model = Some(fixture.model.clone());
        });
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
            provider_raw, request_id, 0, "", "", "responses",
        )
    }

    /// Response slice with explicit port/session/conversation dimensions for
    /// closed-loop response isolation.
    pub fn execute_provider_response_scoped(
        &self,
        provider_raw: &str,
        request_id: &str,
        port: u16,
        session_scope: &str,
        conversation_scope: &str,
        entry_protocol: &str,
    ) -> Result<ExecutionReport, RuntimeFault> {
        self.claim(request_id)?;
        let result = self.run_chain(
            "response",
            request_id,
            port,
            session_scope,
            conversation_scope,
            |ctx| {
                ctx.data.provider_raw = Some(provider_raw.to_string());
                ctx.information.protocol = Some(entry_protocol.to_string());
            },
        );
        self.release(request_id);
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
        let result = self.run_chain(chain_id, request_id, 0, "", "", |_| {});
        self.release(request_id);
        result
    }

    fn run_chain(
        &self,
        chain_id: &str,
        request_id: &str,
        port: u16,
        session_scope: &str,
        conversation_scope: &str,
        seed: impl FnOnce(&mut ExecutionContext),
    ) -> Result<ExecutionReport, RuntimeFault> {
        let nodes = self.containers.chain(chain_id)?;
        let mut ctx = ExecutionContext::with_scope(
            request_id,
            execution_binding(&self.plan),
            port,
            session_scope,
            conversation_scope,
        );
        let mut payload_cycles = self.payload_cycles.borrow_mut();
        let mut registries = RuntimeRegistries {
            payload_cycle: &mut payload_cycles,
        };
        seed(&mut ctx);
        for node in nodes {
            let binding_before = ctx.binding().clone();
            for plugin in &node.plugins {
                match plugin {
                    PluginRef::Local(plugin) => plugin
                        .execute(&mut ctx, &mut registries)
                        .map_err(|fault| fault.with_node(&node.node_id))?,
                    PluginRef::External { plugin_id, owner } => {
                        return Err(RuntimeFault::new(
                            "external_owner_violation",
                            format!(
                                "plugin {plugin_id} owned by {owner} must not execute inside the skeleton runtime; route through its owner"
                            ),
                        )
                        .with_node(&node.node_id));
                    }
                }
            }
            if ctx.binding() != &binding_before {
                return Err(RuntimeFault::new(
                    "binding_drift",
                    format!("execution binding changed at {}", node.node_id),
                )
                .with_node(&node.node_id));
            }
            ctx.record_trace(node.node_id.clone());
        }
        Ok(ExecutionReport {
            request_id: request_id.to_string(),
            binding: ctx.binding().clone(),
            scope: ctx.scope().clone(),
            provider_wire: ctx.data.provider_wire.clone(),
            client_frame: ctx.data.client_frame.clone(),
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
    chain.raise(
        &fault.code,
        Some("sha256:execution-fault"),
        Some(&format!("node:{node}")),
    )?;
    let captured = chain.capture()?;
    let witness = center.classify(captured)?;
    chain.classify(witness)?;
    chain.apply_policy(policy)?;
    chain.decide(decision)?;
    chain.project(&fault.message)
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
    MOCK_TRANSPORT_FAULT_CODES.iter().any(|known| *known == code)
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
/// typed request/response wire pair, optional error projection, and the
/// captured diagnostic trace.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MockTransportReport {
    pub request_id: String,
    pub request_binding: ExecutionBinding,
    pub provider_wire: String,
    pub client_frame: String,
    pub fixture_method: String,
    pub fixture_path: String,
    pub fixture_model: String,
    pub fixture_headers: Vec<(String, String)>,
    pub error_projection_scope: Option<routecodex_v4_base_node::Scope>,
    pub trace: Vec<String>,
    pub error: Option<MockTransportError>,
}

/// One-shot run of the M8 first-slice mock transport. A server-side keyless
/// chat fixture enters the request chain; a mock provider frame enters the
/// response chain; the typed `MockTransportReport` collapses both halves.
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
    {
        return Err(RuntimeFault::new(
            "keyless_fixture_invalid",
            "fixture and protocol identity fields must be non-empty",
        ));
    }
    if mock_provider_frame.trim().is_empty() {
        return Err(RuntimeFault::new(
            "keyless_fixture_invalid",
            "mock_provider_frame must be non-empty",
        ));
    }
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
    let expected_body_prefix = match entry_protocol {
        "chat" => "chat:",
        _ => "responses:",
    };
    if !fixture.body.starts_with(expected_body_prefix) {
        return Err(RuntimeFault::new(
            "keyless_fixture_invalid",
            format!(
                "fixture body does not match entry_protocol {entry_protocol} (expected body prefix {expected_body_prefix})"
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
                fixture_method: fixture.method.clone(),
                fixture_path: fixture.path.clone(),
                fixture_model: fixture.model.clone(),
                fixture_headers: fixture.headers.clone(),
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
        fixture_method: fixture.method.clone(),
        fixture_path: fixture.path.clone(),
        fixture_model: fixture.model.clone(),
        fixture_headers: fixture.headers.clone(),
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

#[cfg(test)]
mod admission_sse_tests {
    use super::{parse_responses_sse_frame, validate_responses_sse_frame};

    #[test]
    fn completed_frame_is_terminal() {
        let frame = "event: response.completed\ndata: {\"type\":\"response.completed\"}\n\n";
        assert!(validate_responses_sse_frame(frame.as_bytes()).expect("completed frame is valid"));
    }

    #[test]
    fn failed_frame_is_terminal() {
        let frame = "event: response.failed\ndata: {\"type\":\"response.failed\",\"response\":{\"error\":{\"code\":\"upstream\"}}}\n\n";
        assert!(validate_responses_sse_frame(frame.as_bytes()).expect("failed frame is valid"));
    }

    #[test]
    fn intermediate_frame_is_not_terminal() {
        let frame = "event: response.output_text.delta\ndata: {\"type\":\"response.output_text.delta\",\"delta\":\"hi\"}\n\n";
        assert!(!validate_responses_sse_frame(frame.as_bytes()).expect("delta frame is valid"));
        let parsed = parse_responses_sse_frame(frame.as_bytes()).expect("parsed frame");
        assert_eq!(parsed.events[0]["delta"], "hi");
    }

    #[test]
    fn malformed_data_fails_fast() {
        let frame = "data: {not-json}\n\n";
        let error =
            validate_responses_sse_frame(frame.as_bytes()).expect_err("malformed JSON must fail");
        assert_eq!(error.code, "provider_sse_malformed");
    }

    #[test]
    fn frame_without_data_fails_fast() {
        let frame = "event: ping\n\n";
        let error = validate_responses_sse_frame(frame.as_bytes())
            .expect_err("frame without data must fail");
        assert_eq!(error.code, "provider_sse_missing_data");
    }
}
