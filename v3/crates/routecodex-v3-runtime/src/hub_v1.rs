use serde_json::Value;
use std::{collections::BTreeSet, sync::Arc};

mod relay_request;
pub use relay_request::*;
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
}

#[derive(Debug, Clone, PartialEq)]
pub struct V3HubReqOutbound07ProviderSemantic {
    previous: V3HubReqTarget06Resolved,
    provider_protocol: V3HubProviderWireProtocol,
}

#[derive(Debug, Clone, PartialEq)]
pub struct V3ProviderReqOutbound08WirePayload {
    previous: V3HubReqOutbound07ProviderSemantic,
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
pub struct V3HubRespInbound02Normalized {
    previous: V3ProviderRespInbound01Raw,
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

#[derive(Debug, Clone, PartialEq, Eq)]
struct V3HubResponseToolCall {
    call_id: String,
    name: String,
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
) -> V3HubReqTarget06Resolved {
    V3HubReqTarget06Resolved {
        previous: input,
        target_resolution,
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

pub fn build_v3_provider_req_outbound_08_from_v3_hub_req_outbound_07(
    input: V3HubReqOutbound07ProviderSemantic,
) -> V3ProviderReqOutbound08WirePayload {
    V3ProviderReqOutbound08WirePayload { previous: input }
}

pub fn build_v3_provider_req_outbound_09_from_v3_provider_req_outbound_08(
    input: V3ProviderReqOutbound08WirePayload,
) -> V3ProviderReqOutbound09TransportRequest {
    V3ProviderReqOutbound09TransportRequest { previous: input }
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

pub fn build_v3_hub_resp_inbound_02_from_v3_provider_resp_inbound_01(
    input: V3ProviderRespInbound01Raw,
) -> V3HubRespInbound02Normalized {
    let normalized_kind = match input.transport_intent {
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
            Arc::ptr_eq(&context.payload, &self.previous.previous.previous.payload.0)
        })
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
            .previous
            .transport_intent
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct V3HubRelayResponseHookProfile {
    servertool_names: BTreeSet<String>,
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
        }
    }

    pub fn empty() -> Self {
        Self::new(std::iter::empty::<&'static str>())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum V3HubRelayResponseError {
    #[error("Relay response hook received a non-Relay response")]
    ExecutionModeNotRelay,
    #[error("provider response must be an object")]
    ProviderResponseNotObject,
    #[error("provider response output must be an array")]
    ProviderResponseOutputNotArray,
    #[error("malformed tool call at output index {index}: {reason}")]
    MalformedToolCall { index: usize, reason: &'static str },
    #[error("provider response status is required")]
    MissingStatus,
    #[error("unsupported provider response status: {status}")]
    UnsupportedStatus { status: String },
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
    Ok(build_v3_hub_resp_inbound_02_from_v3_provider_resp_inbound_01(input))
}

fn govern_v3_hub_relay_response(
    input: V3HubRespInbound02Normalized,
    profile: &V3HubRelayResponseHookProfile,
) -> Result<V3HubRespChatProcess03Governed, V3HubRelayResponseError> {
    let object = input
        .previous
        .payload
        .0
        .as_object()
        .ok_or(V3HubRelayResponseError::ProviderResponseNotObject)?;
    let output = match object.get("output") {
        Some(Value::Array(output)) => output.as_slice(),
        Some(_) => return Err(V3HubRelayResponseError::ProviderResponseOutputNotArray),
        None => &[],
    };
    let mut tool_calls = Vec::new();
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

fn commit_v3_hub_relay_response(
    input: V3HubRespChatProcess03Governed,
) -> Result<V3HubRespContinuation04Committed, V3HubRelayResponseError> {
    let (action, canonical_context) = match input.terminality {
        V3HubResponseTerminality::Terminal => (V3HubContinuationCommit::None, None),
        V3HubResponseTerminality::NonTerminal => (
            V3HubContinuationCommit::LocalContext,
            Some(V3HubRelayCanonicalResponseContext {
                payload: Arc::clone(&input.previous.previous.payload.0),
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
        );
        let req07 = build_v3_hub_req_outbound_07_from_v3_hub_req_target_06(
            req06,
            V3HubProviderWireProtocol::Responses,
        );
        let req08 = build_v3_provider_req_outbound_08_from_v3_hub_req_outbound_07(req07);
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
        let resp02 = build_v3_hub_resp_inbound_02_from_v3_provider_resp_inbound_01(resp01);
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
