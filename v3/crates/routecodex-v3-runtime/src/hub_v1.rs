use crate::{
    V3LocalContinuationError, V3LocalContinuationResp04SaveInput, V3LocalContinuationScopeKey,
    V3LocalContinuationStore, V3LocalContinuationTerminalOutcome,
};
use serde_json::{Map, Value};
use std::{collections::BTreeSet, sync::Arc};

mod relay_request;
pub use relay_request::*;
mod servertool_hooks;
pub use servertool_hooks::*;
mod anthropic_codec;
pub use anthropic_codec::*;
mod openai_chat_codec;
pub use openai_chat_codec::*;
mod gemini_codec;
pub use gemini_codec::*;
mod gemini_relay_runtime;
pub use gemini_relay_runtime::*;
mod openai_chat_relay_runtime;
pub use openai_chat_relay_runtime::*;
mod responses_relay_runtime;
pub use responses_relay_runtime::*;
mod anthropic_relay_hooks;
pub use anthropic_relay_hooks::*;
mod anthropic_relay_runtime;
pub use anthropic_relay_runtime::*;
mod anthropic_relay_runtime_codec;
pub use anthropic_relay_runtime_codec::*;
mod resource_hooks;
pub use resource_hooks::*;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum V3HubEntryProtocol {
    Responses,
    Anthropic,
    Gemini,
    OpenAiChat,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum V3HubContinuationOwnership {
    New,
    RemoteProviderOwned,
    RouteCodexLocalOwned,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum V3HubExecutionMode {
    Direct,
    Relay,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum V3HubProviderWireProtocol {
    Responses,
    Anthropic,
    Gemini,
    OpenAiChat,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum V3HubTargetResolution {
    Routed,
    Pinned,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum V3HubInvocationSource {
    Client,
    ServertoolFollowup,
    DryRun,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum V3HubTransportIntent {
    Json,
    Sse,
}

#[derive(Debug, Clone, PartialEq)]
struct V3HubOpaquePayload(Value);

#[derive(Debug, Clone, PartialEq)]
struct V3HubResponsePayload(Arc<Value>);

#[derive(Debug, Clone, PartialEq)]
pub struct V3HubReqInbound01ClientRaw {
    payload: V3HubOpaquePayload,
    entry_protocol: V3HubEntryProtocol,
    invocation_source: V3HubInvocationSource,
    transport_intent: V3HubTransportIntent,
}

#[derive(Debug, Clone, PartialEq)]
pub struct V3HubReqInbound02Normalized {
    previous: V3HubReqInbound01ClientRaw,
    semantic_protocol: V3HubRequestSemanticProtocol,
}

#[derive(Debug, Clone, PartialEq)]
pub struct V3HubReqContinuation03Classified {
    previous: V3HubReqInbound02Normalized,
    continuation: V3HubContinuationOwnership,
}

#[derive(Debug, Clone, PartialEq)]
pub struct V3HubReqChatProcess04Governed {
    previous: V3HubReqContinuation03Classified,
}

#[derive(Debug, Clone, PartialEq)]
pub struct V3HubReqExecution05Planned {
    previous: V3HubReqChatProcess04Governed,
    execution: V3HubExecutionMode,
}

#[derive(Debug, Clone, PartialEq)]
pub struct V3HubReqTarget06Resolved {
    previous: V3HubReqExecution05Planned,
    target_resolution: V3HubTargetResolution,
    selected_target: routecodex_v3_target::V3TargetCandidate,
}

#[derive(Debug, Clone, PartialEq)]
pub struct V3HubReqOutbound07ProviderSemantic {
    previous: V3HubReqTarget06Resolved,
    provider_protocol: V3HubProviderWireProtocol,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ProviderReqCompat06ProviderCompat {
    previous: V3HubReqOutbound07ProviderSemantic,
    profile: V3ProviderCompatProfileId,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum V3ProviderCompatProfileId {
    Passthrough,
}

#[derive(Debug, Clone, PartialEq)]
pub struct V3ProviderReqOutbound08WirePayload {
    previous: ProviderReqCompat06ProviderCompat,
}

#[derive(Debug, Clone, PartialEq)]
pub struct V3ProviderReqOutbound09TransportRequest {
    previous: V3ProviderReqOutbound08WirePayload,
}

#[derive(Debug, Clone, PartialEq)]
pub struct V3ProviderRespInbound01Raw {
    payload: V3HubResponsePayload,
    entry_protocol: V3HubEntryProtocol,
    provider_protocol: V3HubProviderWireProtocol,
    continuation: V3HubContinuationOwnership,
    execution: V3HubExecutionMode,
    invocation_source: V3HubInvocationSource,
    transport_intent: V3HubTransportIntent,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ProviderRespCompat02ProviderCompat {
    previous: V3ProviderRespInbound01Raw,
    profile: V3ProviderCompatProfileId,
}

#[derive(Debug, Clone, PartialEq)]
pub struct V3HubRespInbound02Normalized {
    previous: ProviderRespCompat02ProviderCompat,
    normalized_kind: V3HubResponseNormalizedKind,
}

#[derive(Debug, Clone, PartialEq)]
pub struct V3HubRespChatProcess03Governed {
    previous: V3HubRespInbound02Normalized,
    terminality: V3HubResponseTerminality,
    tool_calls: Vec<V3HubResponseToolCall>,
    servertool_action: V3HubServertoolResponseAction,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum V3HubResponseNormalizedKind {
    Json,
    Sse,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum V3HubResponseTerminality {
    Terminal,
    NonTerminal,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum V3HubServertoolResponseAction {
    None,
    FollowupRequired,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum V3HubRelayToolKind {
    Function,
    Custom,
    Servertool,
    ApplyPatch,
    Mcp,
    Native,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct V3HubResponseToolCall {
    call_id: String,
    name: String,
    kind: V3HubRelayToolKind,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum V3HubContinuationCommit {
    None,
    RemoteBinding,
    LocalContext,
}

#[derive(Debug, Clone, PartialEq)]
pub struct V3HubRespContinuation04Committed {
    previous: V3HubRespChatProcess03Governed,
    action: V3HubContinuationCommit,
    canonical_context: Option<V3HubRelayCanonicalResponseContext>,
}

#[derive(Debug, Clone, PartialEq)]
struct V3HubRelayCanonicalResponseContext {
    payload: Arc<Value>,
    terminality: V3HubResponseTerminality,
    tool_calls: Vec<V3HubResponseToolCall>,
    servertool_action: V3HubServertoolResponseAction,
}

#[derive(Debug, Clone, PartialEq)]
pub struct V3HubRespOutbound05ClientSemantic {
    previous: V3HubRespContinuation04Committed,
}

#[derive(Debug, Clone, PartialEq)]
pub struct V3ServerRespOutbound06ClientFrame {
    previous: V3HubRespOutbound05ClientSemantic,
}

pub fn build_v3_hub_req_inbound_01_client_raw(
    payload: Value,
    entry_protocol: V3HubEntryProtocol,
    invocation_source: V3HubInvocationSource,
    transport_intent: V3HubTransportIntent,
) -> V3HubReqInbound01ClientRaw {
    V3HubReqInbound01ClientRaw {
        payload: V3HubOpaquePayload(payload),
        entry_protocol,
        invocation_source,
        transport_intent,
    }
}

pub fn build_v3_hub_req_inbound_02_from_v3_hub_req_inbound_01(
    input: V3HubReqInbound01ClientRaw,
) -> V3HubReqInbound02Normalized {
    V3HubReqInbound02Normalized {
        previous: input,
        semantic_protocol: V3HubRequestSemanticProtocol::Chat,
    }
}

pub fn build_v3_hub_req_continuation_03_from_v3_hub_req_inbound_02(
    input: V3HubReqInbound02Normalized,
    continuation: V3HubContinuationOwnership,
) -> V3HubReqContinuation03Classified {
    V3HubReqContinuation03Classified {
        previous: input,
        continuation,
    }
}

pub fn build_v3_hub_req_chat_process_04_from_v3_hub_req_continuation_03(
    input: V3HubReqContinuation03Classified,
) -> V3HubReqChatProcess04Governed {
    V3HubReqChatProcess04Governed { previous: input }
}

pub fn build_v3_hub_req_execution_05_from_v3_hub_req_chat_process_04(
    input: V3HubReqChatProcess04Governed,
    execution: V3HubExecutionMode,
) -> V3HubReqExecution05Planned {
    V3HubReqExecution05Planned {
        previous: input,
        execution,
    }
}

pub fn build_v3_hub_req_target_06_from_v3_hub_req_execution_05(
    input: V3HubReqExecution05Planned,
    target_resolution: V3HubTargetResolution,
    selected_target: routecodex_v3_target::V3TargetCandidate,
) -> V3HubReqTarget06Resolved {
    V3HubReqTarget06Resolved {
        previous: input,
        target_resolution,
        selected_target,
    }
}

pub fn build_v3_hub_req_outbound_07_from_v3_hub_req_target_06(
    input: V3HubReqTarget06Resolved,
    provider_protocol: V3HubProviderWireProtocol,
) -> V3HubReqOutbound07ProviderSemantic {
    V3HubReqOutbound07ProviderSemantic {
        previous: input,
        provider_protocol,
    }
}

pub fn build_provider_req_compat_06_from_v3_hub_req_outbound_07(
    input: V3HubReqOutbound07ProviderSemantic,
) -> ProviderReqCompat06ProviderCompat {
    ProviderReqCompat06ProviderCompat {
        previous: input,
        profile: V3ProviderCompatProfileId::Passthrough,
    }
}

pub fn build_v3_provider_req_outbound_08_from_provider_req_compat_06(
    input: ProviderReqCompat06ProviderCompat,
) -> V3ProviderReqOutbound08WirePayload {
    V3ProviderReqOutbound08WirePayload { previous: input }
}

pub fn build_v3_provider_req_outbound_09_from_v3_provider_req_outbound_08(
    input: V3ProviderReqOutbound08WirePayload,
) -> V3ProviderReqOutbound09TransportRequest {
    V3ProviderReqOutbound09TransportRequest { previous: input }
}

impl V3HubReqOutbound07ProviderSemantic {
    fn selected_target(&self) -> &routecodex_v3_target::V3TargetCandidate {
        &self.previous.selected_target
    }

    fn provider_semantic_payload(&self) -> &Value {
        &self
            .previous
            .previous
            .previous
            .previous
            .previous
            .previous
            .payload
            .0
    }
}

impl ProviderReqCompat06ProviderCompat {
    pub fn profile(&self) -> V3ProviderCompatProfileId {
        self.profile
    }

    fn provider_semantic_payload(&self) -> &Value {
        self.previous.provider_semantic_payload()
    }
}

impl V3ProviderReqOutbound09TransportRequest {
    fn into_provider_semantic_payload(self) -> Value {
        self.previous.previous.provider_semantic_payload().clone()
    }
}

impl V3ProviderCompatProfileId {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Passthrough => "compat:passthrough",
        }
    }
}

impl V3ProviderReqOutbound08WirePayload {
    fn compat_profile(&self) -> V3ProviderCompatProfileId {
        self.previous.profile()
    }
}

impl V3ProviderReqOutbound09TransportRequest {
    pub fn compat_profile_id(&self) -> &'static str {
        self.previous.compat_profile().as_str()
    }
}

pub fn build_provider_resp_compat_02_from_v3_provider_resp_inbound_01(
    input: V3ProviderRespInbound01Raw,
) -> ProviderRespCompat02ProviderCompat {
    ProviderRespCompat02ProviderCompat {
        previous: input,
        profile: V3ProviderCompatProfileId::Passthrough,
    }
}

impl ProviderRespCompat02ProviderCompat {
    pub fn profile(&self) -> V3ProviderCompatProfileId {
        self.profile
    }

    fn raw(&self) -> &V3ProviderRespInbound01Raw {
        &self.previous
    }

    fn raw_mut(&mut self) -> &mut V3ProviderRespInbound01Raw {
        &mut self.previous
    }
}

impl V3HubRespInbound02Normalized {
    pub fn provider_raw(&self) -> &V3ProviderRespInbound01Raw {
        self.previous.raw()
    }

    fn provider_raw_mut(&mut self) -> &mut V3ProviderRespInbound01Raw {
        self.previous.raw_mut()
    }

    fn provider_payload(&self) -> &Arc<Value> {
        &self.provider_raw().payload.0
    }

    fn provider_payload_mut(&mut self) -> &mut Arc<Value> {
        &mut self.provider_raw_mut().payload.0
    }
}

pub fn build_v3_provider_resp_inbound_01_raw(
    payload: Value,
    entry_protocol: V3HubEntryProtocol,
    provider_protocol: V3HubProviderWireProtocol,
    continuation: V3HubContinuationOwnership,
    execution: V3HubExecutionMode,
    invocation_source: V3HubInvocationSource,
    transport_intent: V3HubTransportIntent,
) -> V3ProviderRespInbound01Raw {
    V3ProviderRespInbound01Raw {
        payload: V3HubResponsePayload(Arc::new(payload)),
        entry_protocol,
        provider_protocol,
        continuation,
        execution,
        invocation_source,
        transport_intent,
    }
}

pub fn build_v3_hub_resp_inbound_02_from_provider_resp_compat_02(
    input: ProviderRespCompat02ProviderCompat,
) -> V3HubRespInbound02Normalized {
    let normalized_kind = match input.raw().transport_intent {
        V3HubTransportIntent::Json => V3HubResponseNormalizedKind::Json,
        V3HubTransportIntent::Sse => V3HubResponseNormalizedKind::Sse,
    };
    V3HubRespInbound02Normalized {
        previous: input,
        normalized_kind,
    }
}

pub fn build_v3_hub_resp_chat_process_03_from_v3_hub_resp_inbound_02(
    input: V3HubRespInbound02Normalized,
) -> V3HubRespChatProcess03Governed {
    V3HubRespChatProcess03Governed {
        previous: input,
        terminality: V3HubResponseTerminality::Terminal,
        tool_calls: Vec::new(),
        servertool_action: V3HubServertoolResponseAction::None,
    }
}

pub fn build_v3_hub_resp_continuation_04_from_v3_hub_resp_chat_process_03(
    input: V3HubRespChatProcess03Governed,
    action: V3HubContinuationCommit,
) -> V3HubRespContinuation04Committed {
    V3HubRespContinuation04Committed {
        previous: input,
        action,
        canonical_context: None,
    }
}

pub fn build_v3_hub_resp_outbound_05_from_v3_hub_resp_continuation_04(
    input: V3HubRespContinuation04Committed,
) -> V3HubRespOutbound05ClientSemantic {
    V3HubRespOutbound05ClientSemantic { previous: input }
}

pub fn build_v3_server_resp_outbound_06_from_v3_hub_resp_outbound_05(
    input: V3HubRespOutbound05ClientSemantic,
) -> V3ServerRespOutbound06ClientFrame {
    V3ServerRespOutbound06ClientFrame { previous: input }
}

impl V3HubRespInbound02Normalized {
    pub fn normalized_kind(&self) -> V3HubResponseNormalizedKind {
        self.normalized_kind
    }
}

impl V3HubRespChatProcess03Governed {
    pub fn terminality(&self) -> V3HubResponseTerminality {
        self.terminality
    }

    pub fn tool_call_count(&self) -> usize {
        self.tool_calls.len()
    }

    pub fn servertool_action(&self) -> V3HubServertoolResponseAction {
        self.servertool_action
    }

    pub fn tool_call_kinds(&self) -> Vec<V3HubRelayToolKind> {
        self.tool_calls
            .iter()
            .map(|tool_call| tool_call.kind)
            .collect()
    }
}

impl V3HubRespContinuation04Committed {
    pub fn action(&self) -> V3HubContinuationCommit {
        self.action
    }

    pub fn canonical_context_count(&self) -> usize {
        usize::from(self.canonical_context.is_some())
    }

    pub fn canonical_context_shares_finalized_payload(&self) -> bool {
        self.canonical_context.as_ref().is_some_and(|context| {
            Arc::ptr_eq(&context.payload, self.previous.previous.provider_payload())
        })
    }

    pub fn canonical_tool_call_kinds(&self) -> Vec<V3HubRelayToolKind> {
        self.canonical_context
            .as_ref()
            .map(|context| {
                context
                    .tool_calls
                    .iter()
                    .map(|tool_call| tool_call.kind)
                    .collect()
            })
            .unwrap_or_default()
    }

    pub fn canonical_context_payload(&self) -> Option<&Value> {
        self.canonical_context
            .as_ref()
            .map(|context| context.payload.as_ref())
    }

    pub fn finalized_payload(&self) -> &Value {
        self.previous.previous.provider_payload().as_ref()
    }
}

impl V3ServerRespOutbound06ClientFrame {
    pub fn response_exit_node(&self) -> &'static str {
        "V3ServerRespOutbound06ClientFrame"
    }

    pub fn transport_intent(&self) -> V3HubTransportIntent {
        self.previous
            .previous
            .previous
            .previous
            .provider_raw()
            .transport_intent
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct V3HubRelayResponseHookProfile {
    servertool_names: BTreeSet<String>,
    stopless_reasoning_stop: bool,
}

impl V3HubRelayResponseHookProfile {
    pub fn new<I, S>(servertool_names: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: AsRef<str>,
    {
        Self {
            servertool_names: servertool_names
                .into_iter()
                .map(|name| name.as_ref().to_owned())
                .collect(),
            stopless_reasoning_stop: false,
        }
    }

    pub fn empty() -> Self {
        Self::new(std::iter::empty::<&'static str>())
    }

    pub fn with_stopless_reasoning_stop(mut self) -> Self {
        self.stopless_reasoning_stop = true;
        self
    }

    pub fn stopless_reasoning_stop_enabled(&self) -> bool {
        self.stopless_reasoning_stop
    }
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum V3HubRelayResponseError {
    #[error("Relay response hook received a non-Relay response")]
    ExecutionModeNotRelay,
    #[error("provider response must be an object")]
    ProviderResponseNotObject,
    #[error("provider response leaked RouteCodex side-channel field: {key}")]
    SideChannelLeaked { key: &'static str },
    #[error("provider response output must be an array")]
    ProviderResponseOutputNotArray,
    #[error("malformed tool call at output index {index}: {reason}")]
    MalformedToolCall { index: usize, reason: &'static str },
    #[error("provider response status is required")]
    MissingStatus,
    #[error("unsupported provider response status: {status}")]
    UnsupportedStatus { status: String },
    #[error("stopless response hook projection failed: {reason}")]
    StoplessProjectionFailed { reason: &'static str },
}

#[derive(Debug, Clone, Copy)]
pub struct V3HubRelayResponseHookRegistry {
    normalize: fn(
        V3ProviderRespInbound01Raw,
    ) -> Result<V3HubRespInbound02Normalized, V3HubRelayResponseError>,
    govern: fn(
        V3HubRespInbound02Normalized,
        &V3HubRelayResponseHookProfile,
    ) -> Result<V3HubRespChatProcess03Governed, V3HubRelayResponseError>,
    commit: fn(
        V3HubRespChatProcess03Governed,
    ) -> Result<V3HubRespContinuation04Committed, V3HubRelayResponseError>,
}

impl V3HubRelayResponseHookRegistry {
    pub fn normalize(
        &self,
        input: V3ProviderRespInbound01Raw,
    ) -> Result<V3HubRespInbound02Normalized, V3HubRelayResponseError> {
        (self.normalize)(input)
    }

    pub fn govern(
        &self,
        input: V3HubRespInbound02Normalized,
        profile: &V3HubRelayResponseHookProfile,
    ) -> Result<V3HubRespChatProcess03Governed, V3HubRelayResponseError> {
        (self.govern)(input, profile)
    }

    pub fn commit(
        &self,
        input: V3HubRespChatProcess03Governed,
    ) -> Result<V3HubRespContinuation04Committed, V3HubRelayResponseError> {
        (self.commit)(input)
    }
}

pub fn compile_v3_hub_relay_response_hooks() -> V3HubRelayResponseHookRegistry {
    V3HubRelayResponseHookRegistry {
        normalize: normalize_v3_hub_relay_response,
        govern: govern_v3_hub_relay_response,
        commit: commit_v3_hub_relay_response,
    }
}

fn normalize_v3_hub_relay_response(
    input: V3ProviderRespInbound01Raw,
) -> Result<V3HubRespInbound02Normalized, V3HubRelayResponseError> {
    if input.execution != V3HubExecutionMode::Relay {
        return Err(V3HubRelayResponseError::ExecutionModeNotRelay);
    }
    if !input.payload.0.is_object() {
        return Err(V3HubRelayResponseError::ProviderResponseNotObject);
    }
    if let Some(key) = find_v3_hub_side_channel_key(&input.payload.0) {
        return Err(V3HubRelayResponseError::SideChannelLeaked { key });
    }
    let compat = build_provider_resp_compat_02_from_v3_provider_resp_inbound_01(input);
    Ok(build_v3_hub_resp_inbound_02_from_provider_resp_compat_02(
        compat,
    ))
}

fn govern_v3_hub_relay_response(
    input: V3HubRespInbound02Normalized,
    profile: &V3HubRelayResponseHookProfile,
) -> Result<V3HubRespChatProcess03Governed, V3HubRelayResponseError> {
    let input = apply_v3_stopless_response_hook_at_resp03(input, profile)?;
    let input = project_v3_apply_patch_freeform_calls_at_resp03(input);
    let object = input
        .provider_payload()
        .as_object()
        .ok_or(V3HubRelayResponseError::ProviderResponseNotObject)?;
    let output = match object.get("output") {
        Some(Value::Array(output)) => output.as_slice(),
        Some(_) => return Err(V3HubRelayResponseError::ProviderResponseOutputNotArray),
        None => &[],
    };
    let mut tool_calls = Vec::new();
    let mut seen_call_ids = BTreeSet::new();
    for (index, item) in output.iter().enumerate() {
        let Some(item) = item.as_object() else {
            continue;
        };
        let kind = item.get("type").and_then(Value::as_str).unwrap_or_default();
        if !matches!(kind, "function_call" | "custom_tool_call" | "tool_call") {
            continue;
        }
        let call_id = item
            .get("call_id")
            .or_else(|| item.get("id"))
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .ok_or(V3HubRelayResponseError::MalformedToolCall {
                index,
                reason: "missing call_id/id",
            })?;
        if !seen_call_ids.insert(call_id.to_owned()) {
            return Err(V3HubRelayResponseError::MalformedToolCall {
                index,
                reason: "duplicate call_id/id",
            });
        }
        let name = item
            .get("name")
            .and_then(Value::as_str)
            .or_else(|| {
                item.get("function")
                    .and_then(Value::as_object)
                    .and_then(|function| function.get("name"))
                    .and_then(Value::as_str)
            })
            .filter(|value| !value.is_empty())
            .ok_or(V3HubRelayResponseError::MalformedToolCall {
                index,
                reason: "missing name/function.name",
            })?;
        tool_calls.push(V3HubResponseToolCall {
            call_id: call_id.to_owned(),
            name: name.to_owned(),
            kind: classify_v3_hub_relay_tool_kind(kind, name),
        });
    }
    let status = object
        .get("status")
        .and_then(Value::as_str)
        .ok_or(V3HubRelayResponseError::MissingStatus)?;
    let status_terminality = match status {
        "completed" => V3HubResponseTerminality::Terminal,
        "requires_action" | "in_progress" | "queued" => V3HubResponseTerminality::NonTerminal,
        _ => {
            return Err(V3HubRelayResponseError::UnsupportedStatus {
                status: status.to_owned(),
            });
        }
    };
    let terminality = if tool_calls.is_empty() {
        status_terminality
    } else {
        V3HubResponseTerminality::NonTerminal
    };
    let servertool_action = if tool_calls
        .iter()
        .any(|tool_call| profile.servertool_names.contains(&tool_call.name))
    {
        V3HubServertoolResponseAction::FollowupRequired
    } else {
        V3HubServertoolResponseAction::None
    };
    Ok(V3HubRespChatProcess03Governed {
        previous: input,
        terminality,
        tool_calls,
        servertool_action,
    })
}

pub(crate) fn classify_v3_hub_relay_tool_kind(raw_kind: &str, name: &str) -> V3HubRelayToolKind {
    if name == "apply_patch" {
        return V3HubRelayToolKind::ApplyPatch;
    }
    if raw_kind == "custom_tool_call" {
        return V3HubRelayToolKind::Custom;
    }
    if name.strip_prefix("servertool.").is_some() || name.strip_prefix("servertool__").is_some() {
        return V3HubRelayToolKind::Servertool;
    }
    if name.strip_prefix("mcp.").is_some() || name.strip_prefix("mcp__").is_some() {
        return V3HubRelayToolKind::Mcp;
    }
    if name.strip_prefix("native.").is_some() || name.strip_prefix("native__").is_some() {
        return V3HubRelayToolKind::Native;
    }
    V3HubRelayToolKind::Function
}

fn project_v3_apply_patch_freeform_calls_at_resp03(
    mut input: V3HubRespInbound02Normalized,
) -> V3HubRespInbound02Normalized {
    let mut next = input.provider_payload().as_ref().clone();
    let mut changed = false;
    if let Some(output) = next
        .as_object_mut()
        .and_then(|object| object.get_mut("output"))
        .and_then(Value::as_array_mut)
    {
        for item in output {
            let Some(row) = item.as_object_mut() else {
                continue;
            };
            changed |= project_v3_apply_patch_freeform_output_item_at_resp03(row);
        }
    }
    if changed {
        *input.provider_payload_mut() = Arc::new(next);
    }
    input
}

fn project_v3_apply_patch_freeform_output_item_at_resp03(row: &mut Map<String, Value>) -> bool {
    let item_type = row
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    if !matches!(
        item_type.as_str(),
        "function_call" | "custom_tool_call" | "tool_call"
    ) {
        return false;
    }
    if read_v3_apply_patch_tool_name(row).as_deref() != Some("apply_patch") {
        return false;
    }
    if item_type == "custom_tool_call" {
        if let Some(Value::String(input)) = row.get_mut("input") {
            let normalized = normalize_v3_apply_patch_freeform_input_for_client(input);
            if normalized != *input {
                *input = normalized;
                return true;
            }
        }
        return false;
    }

    let input = row
        .get("arguments")
        .or_else(|| row.get("input"))
        .or_else(|| row.get("args"))
        .map(normalize_v3_apply_patch_freeform_value_for_client)
        .unwrap_or_default();
    if let Some(call_id) = row
        .get("call_id")
        .or_else(|| row.get("id"))
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
    {
        row.insert("call_id".to_string(), Value::String(call_id));
    }
    row.insert(
        "type".to_string(),
        Value::String("custom_tool_call".to_string()),
    );
    row.insert("name".to_string(), Value::String("apply_patch".to_string()));
    row.insert("input".to_string(), Value::String(input));
    row.remove("arguments");
    row.remove("args");
    row.remove("function");
    true
}

fn read_v3_apply_patch_tool_name(row: &Map<String, Value>) -> Option<String> {
    row.get("name")
        .and_then(Value::as_str)
        .or_else(|| {
            row.get("function")
                .and_then(Value::as_object)
                .and_then(|function| function.get("name"))
                .and_then(Value::as_str)
        })
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.to_ascii_lowercase())
}

fn normalize_v3_apply_patch_freeform_value_for_client(value: &Value) -> String {
    match value {
        Value::String(raw) => normalize_v3_apply_patch_freeform_input_for_client(raw),
        Value::Object(record) => record
            .get("patch")
            .or_else(|| record.get("input"))
            .and_then(Value::as_str)
            .map(ToString::to_string)
            .unwrap_or_else(|| value.to_string()),
        _ => value.to_string(),
    }
}

fn normalize_v3_apply_patch_freeform_input_for_client(arguments_text: &str) -> String {
    let parsed = arguments_text.parse::<Value>().ok();
    let Some(Value::Object(record)) = parsed else {
        return arguments_text.to_string();
    };
    record
        .get("patch")
        .or_else(|| record.get("input"))
        .and_then(Value::as_str)
        .map(ToString::to_string)
        .unwrap_or_else(|| arguments_text.to_string())
}

pub(crate) fn find_v3_hub_side_channel_key(value: &Value) -> Option<&'static str> {
    const FORBIDDEN: [&str; 6] = [
        "routecodex_internal",
        "metadata_center",
        "debug_snapshot",
        "provider_protocol",
        "resource_handle",
        "continuation_owner",
    ];
    match value {
        Value::Array(items) => items.iter().find_map(find_v3_hub_side_channel_key),
        Value::Object(object) => {
            for key in FORBIDDEN {
                if object.contains_key(key) {
                    return Some(key);
                }
            }
            object.values().find_map(find_v3_hub_side_channel_key)
        }
        _ => None,
    }
}

fn commit_v3_hub_relay_response(
    input: V3HubRespChatProcess03Governed,
) -> Result<V3HubRespContinuation04Committed, V3HubRelayResponseError> {
    let (action, canonical_context) = match input.terminality {
        V3HubResponseTerminality::Terminal => (V3HubContinuationCommit::None, None),
        V3HubResponseTerminality::NonTerminal => (
            V3HubContinuationCommit::LocalContext,
            Some(V3HubRelayCanonicalResponseContext {
                payload: Arc::clone(input.previous.provider_payload()),
                terminality: input.terminality,
                tool_calls: input.tool_calls.clone(),
                servertool_action: input.servertool_action,
            }),
        ),
    };
    Ok(V3HubRespContinuation04Committed {
        previous: input,
        action,
        canonical_context,
    })
}

pub(crate) fn merge_v3_relay_restored_local_context_at_req04(
    current: &mut Value,
    restored: &Value,
) -> Result<(), V3LocalContinuationError> {
    let restored_items = restored
        .get("output")
        .and_then(Value::as_array)
        .cloned()
        .ok_or_else(|| V3LocalContinuationError::Codec {
            message: "restored local continuation output must be an array".to_string(),
        })?;
    let current_items = current
        .get_mut("input")
        .and_then(Value::as_array_mut)
        .map(std::mem::take)
        .ok_or_else(|| V3LocalContinuationError::Codec {
            message: "Req04 provider semantic input must be an array".to_string(),
        })?;
    let mut merged = restored_items;
    let mut restored_keys = BTreeSet::new();
    for item in &merged {
        if let (Some(item_type), Some(call_id)) = (
            item.get("type").and_then(Value::as_str),
            item.get("call_id").and_then(Value::as_str),
        ) {
            restored_keys.insert((item_type.to_owned(), call_id.to_owned()));
        }
    }
    merged.extend(current_items.into_iter().filter(|item| {
        let current_call_id = item.get("call_id").and_then(Value::as_str);
        current_call_id.is_none_or(|call_id| {
            !restored_keys.iter().any(|(restored_type, restored_id)| {
                restored_id == call_id
                    && Some(restored_type.as_str()) == item.get("type").and_then(Value::as_str)
            })
        })
    }));
    current["input"] = Value::Array(merged);
    Ok(())
}

pub(crate) fn commit_or_release_v3_relay_local_continuation_at_resp04(
    store: &mut V3LocalContinuationStore,
    scope: V3LocalContinuationScopeKey,
    now_epoch_ms: u64,
    ttl_ms: u64,
    restored_context_ids: &[String],
    canonical_response: &Value,
    action: V3HubContinuationCommit,
) -> Result<(), V3LocalContinuationError> {
    for context_id in restored_context_ids {
        store.release(context_id);
    }
    if action != V3HubContinuationCommit::LocalContext {
        return Ok(());
    }
    let context_ids = canonical_response
        .get("output")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|item| {
            matches!(
                item.get("type").and_then(Value::as_str),
                Some("function_call" | "custom_tool_call" | "tool_call")
            )
        })
        .map(|item| {
            item.get("call_id")
                .or_else(|| item.get("id"))
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
                .map(str::to_owned)
                .ok_or_else(|| V3LocalContinuationError::Codec {
                    message: "Resp04 local context has a tool call without id".to_string(),
                })
        })
        .collect::<Result<Vec<_>, _>>()?;
    if context_ids.is_empty() {
        return Err(V3LocalContinuationError::Codec {
            message: "Resp04 local context has no tool call id".to_string(),
        });
    }
    if let Some(duplicate) = context_ids.iter().find(|id| store.contains(id)) {
        return Err(V3LocalContinuationError::AlreadyCommitted {
            context_id: duplicate.clone(),
        });
    }
    let expires_at_epoch_ms =
        now_epoch_ms
            .checked_add(ttl_ms)
            .ok_or_else(|| V3LocalContinuationError::Codec {
                message: "local continuation clock overflow".to_string(),
            })?;
    for context_id in context_ids {
        store.commit_at_resp04(V3LocalContinuationResp04SaveInput::new(
            context_id,
            scope.clone(),
            canonical_response.clone(),
            V3LocalContinuationTerminalOutcome::NonTerminal,
            now_epoch_ms,
            expires_at_epoch_ms,
        ))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn all_adjacent_builders_form_the_fixed_typed_topology() {
        let req01 = build_v3_hub_req_inbound_01_client_raw(
            json!({"input":"x"}),
            V3HubEntryProtocol::Responses,
            V3HubInvocationSource::Client,
            V3HubTransportIntent::Json,
        );
        let req02 = build_v3_hub_req_inbound_02_from_v3_hub_req_inbound_01(req01);
        let req03 = build_v3_hub_req_continuation_03_from_v3_hub_req_inbound_02(
            req02,
            V3HubContinuationOwnership::New,
        );
        let req04 = build_v3_hub_req_chat_process_04_from_v3_hub_req_continuation_03(req03);
        let req05 = build_v3_hub_req_execution_05_from_v3_hub_req_chat_process_04(
            req04,
            V3HubExecutionMode::Direct,
        );
        let req06 = build_v3_hub_req_target_06_from_v3_hub_req_execution_05(
            req05,
            V3HubTargetResolution::Routed,
            routecodex_v3_target::V3TargetCandidate {
                provider_id: "provider".into(),
                provider_type: "responses".into(),
                auth_alias: "primary".into(),
                model_id: "model".into(),
                wire_model: "wire-model".into(),
                base_url: "http://127.0.0.1:1/v1".into(),
                responses_transport: routecodex_v3_config::V3ResponsesTransportKind::Http,
                websocket_v2_url: None,
                env_name: Some("V3_TEST_KEY".into()),
                token_file: None,
                path: vec!["provider".into()],
            },
        );
        let req07 = build_v3_hub_req_outbound_07_from_v3_hub_req_target_06(
            req06,
            V3HubProviderWireProtocol::Responses,
        );
        let req_compat = build_provider_req_compat_06_from_v3_hub_req_outbound_07(req07);
        let req08 = build_v3_provider_req_outbound_08_from_provider_req_compat_06(req_compat);
        let _req09 = build_v3_provider_req_outbound_09_from_v3_provider_req_outbound_08(req08);

        let resp01 = build_v3_provider_resp_inbound_01_raw(
            json!({"output":"x"}),
            V3HubEntryProtocol::Responses,
            V3HubProviderWireProtocol::Responses,
            V3HubContinuationOwnership::New,
            V3HubExecutionMode::Direct,
            V3HubInvocationSource::Client,
            V3HubTransportIntent::Json,
        );
        let resp_compat = build_provider_resp_compat_02_from_v3_provider_resp_inbound_01(resp01);
        let resp02 = build_v3_hub_resp_inbound_02_from_provider_resp_compat_02(resp_compat);
        let resp03 = build_v3_hub_resp_chat_process_03_from_v3_hub_resp_inbound_02(resp02);
        let resp04 = build_v3_hub_resp_continuation_04_from_v3_hub_resp_chat_process_03(
            resp03,
            V3HubContinuationCommit::None,
        );
        let resp05 = build_v3_hub_resp_outbound_05_from_v3_hub_resp_continuation_04(resp04);
        let _resp06 = build_v3_server_resp_outbound_06_from_v3_hub_resp_outbound_05(resp05);
    }

    #[test]
    fn four_branch_axes_are_independent_values() {
        let facts = (
            V3HubEntryProtocol::Responses,
            V3HubContinuationOwnership::RouteCodexLocalOwned,
            V3HubExecutionMode::Relay,
            V3HubProviderWireProtocol::Gemini,
        );
        assert_eq!(facts.0, V3HubEntryProtocol::Responses);
        assert_eq!(facts.1, V3HubContinuationOwnership::RouteCodexLocalOwned);
        assert_eq!(facts.2, V3HubExecutionMode::Relay);
        assert_eq!(facts.3, V3HubProviderWireProtocol::Gemini);
    }
}
