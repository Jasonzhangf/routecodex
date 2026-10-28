use super::{
    build_v3_hub_req_chat_process_04_from_v3_hub_req_inbound_02,
    build_v3_hub_req_inbound_01_client_raw,
    build_v3_hub_req_inbound_02_result_from_v3_hub_req_inbound_01,
    compile_v3_tool_thinking_turn_context_at_req04, V3HubEntryProtocol, V3HubInvocationSource,
    V3HubReqChatProcess04Governed, V3HubReqInbound01ClientRaw, V3HubReqInbound02Normalized,
    V3HubRequestSemanticProtocol, V3HubTransportIntent, V3ToolThinkingTurnContext,
};
use crate::operation_runner::{run_v3_single_node_operator, V3OperationGraph};
use pipeline_runtime::{Operator, OperatorContext, ValueType};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, BTreeSet},
    sync::{Arc, Mutex},
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum V3HubRequestHookProfile {
    Disabled,
    Enabled {
        tool_thinking: bool,
        memory_raw_capture: bool,
    },
}
impl V3HubRequestHookProfile {
    pub fn disabled() -> Self {
        Self::Disabled
    }
    pub fn enabled() -> Self {
        Self::Enabled {
            tool_thinking: false,
            memory_raw_capture: false,
        }
    }
    pub fn with_tool_thinking_enabled(mut self, enabled: bool) -> Self {
        if let Self::Enabled { tool_thinking, .. } = &mut self {
            *tool_thinking = enabled;
        }
        self
    }
    pub fn with_memory_raw_capture_enabled(mut self, enabled: bool) -> Self {
        if let Self::Enabled {
            memory_raw_capture, ..
        } = &mut self
        {
            *memory_raw_capture = enabled;
        }
        self
    }
    pub fn tool_thinking_enabled(&self) -> bool {
        matches!(
            self,
            Self::Enabled {
                tool_thinking: true,
                ..
            }
        )
    }
    pub fn memory_raw_capture_enabled(&self) -> bool {
        matches!(
            self,
            Self::Enabled {
                memory_raw_capture: true,
                ..
            }
        )
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum V3HubRelayRequestHookEvent {
    Req01Entry,
    Req01Exit,
    Req02Entry,
    Req02Exit,
    Req04Entry,
    Req04ToolGoverned,
    Req04ProtocolToolIdentityGoverned,
    Req04Exit,
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum V3HubRelayRequestError {
    #[error("ReqInbound02 normalization failed: {reason}")]
    ReqInboundInvalid { reason: String },
    #[error("malformed tool output at input index {index}: call_id is required")]
    MalformedToolOutput { index: usize },
    #[error("orphan tool output at input index {index}: call_id {call_id}")]
    OrphanToolOutput { index: usize, call_id: String },
    #[error("tool output kind mismatch at input index {index}: call_id {call_id}")]
    ToolOutputKindMismatch { index: usize, call_id: String },
    #[error("current-turn payload boundary is invalid: start {start}, len {len}")]
    CurrentPayloadBoundaryInvalid { start: usize, len: usize },
    #[error("tool-thinking schema is invalid: {reason}")]
    ToolThinkingSchemaInvalid { reason: String },
    #[error("memory raw capture guidance injection failed at Req04: {reason}")]
    MemoryRawCaptureGuidanceInjectionFailed { reason: String },
    #[error("{protocol} tool identity is invalid at item {index}: {reason}")]
    ProtocolToolIdentityInvalid {
        protocol: &'static str,
        index: usize,
        reason: &'static str,
    },
}

#[derive(Debug)]
pub struct V3HubRelayRequestOutcome {
    governed: V3HubReqChatProcess04Governed,
    tool_output_count: usize,
    events: Vec<V3HubRelayRequestHookEvent>,
    tool_thinking_enabled: bool,
    tool_thinking_turn_context: V3ToolThinkingTurnContext,
}
impl V3HubRelayRequestOutcome {
    pub fn payload(&self) -> &Value {
        self.payload_arc().as_ref()
    }

    pub fn payload_arc(&self) -> &std::sync::Arc<Value> {
        &self.governed.previous.previous.payload.0
    }
    pub fn semantic_protocol(&self) -> V3HubRequestSemanticProtocol {
        self.governed.previous.semantic_protocol
    }
    pub fn hook_events(&self) -> &[V3HubRelayRequestHookEvent] {
        &self.events
    }
    pub fn tool_output_count(&self) -> usize {
        self.tool_output_count
    }
    pub fn tool_thinking_enabled(&self) -> bool {
        self.tool_thinking_enabled
    }
    pub(crate) fn tool_thinking_turn_context(&self) -> &V3ToolThinkingTurnContext {
        &self.tool_thinking_turn_context
    }
    pub fn into_governed(self) -> V3HubReqChatProcess04Governed {
        self.governed
    }
}

#[derive(Debug, Clone, Copy)]
pub struct V3HubRelayRequestHooks {
    _sealed: (),
}
pub fn compile_v3_hub_relay_request_hooks() -> V3HubRelayRequestHooks {
    V3HubRelayRequestHooks { _sealed: () }
}

const GOVERN_CHAT_REQUEST_OPERATOR: &str = "routecodex.v3.operation.govern_chat_request";
const GOVERN_CHAT_REQUEST_OPERATOR_VERSION: &str = "1";

#[derive(Debug)]
struct GovernChatRequestSideOutput {
    context: GovernChatRequestContext,
    events: Vec<V3HubRelayRequestHookEvent>,
    tool_output_count: usize,
    tool_thinking_enabled: bool,
    tool_thinking_turn_context: V3ToolThinkingTurnContext,
}

#[derive(Debug, Clone, Copy)]
struct GovernChatRequestContext {
    entry_protocol: V3HubEntryProtocol,
    invocation_source: V3HubInvocationSource,
    transport_intent: V3HubTransportIntent,
    semantic_protocol: V3HubRequestSemanticProtocol,
    canonicalized_from_responses: bool,
    memory_raw_capture_guidance_injected: bool,
}

impl GovernChatRequestContext {
    fn from_normalized(normalized: &V3HubReqInbound02Normalized) -> Self {
        Self {
            entry_protocol: normalized.entry_protocol(),
            invocation_source: normalized.previous.invocation_source,
            transport_intent: normalized.transport_intent(),
            semantic_protocol: normalized.semantic_protocol,
            canonicalized_from_responses: normalized.canonicalized_from_responses,
            memory_raw_capture_guidance_injected: normalized.memory_raw_capture_guidance_injected,
        }
    }

    fn into_normalized(self, payload: Value) -> V3HubReqInbound02Normalized {
        V3HubReqInbound02Normalized {
            previous: build_v3_hub_req_inbound_01_client_raw(
                payload,
                self.entry_protocol,
                self.invocation_source,
                self.transport_intent,
            ),
            semantic_protocol: self.semantic_protocol,
            canonicalized_from_responses: self.canonicalized_from_responses,
            memory_raw_capture_guidance_injected: self.memory_raw_capture_guidance_injected,
        }
    }
}

#[derive(Debug)]
struct GovernChatRequestFailureSideOutput {
    error: V3HubRelayRequestError,
    events: Vec<V3HubRelayRequestHookEvent>,
}

enum GovernChatRequestOperatorSideOutput {
    Success(Box<GovernChatRequestSideOutput>),
    Failure(Box<GovernChatRequestFailureSideOutput>),
}

struct GovernChatRequestOperator {
    normalized: V3HubReqInbound02Normalized,
    profile: V3HubRequestHookProfile,
    events: Vec<V3HubRelayRequestHookEvent>,
    side_output: Arc<Mutex<Option<GovernChatRequestOperatorSideOutput>>>,
}

impl Operator for GovernChatRequestOperator {
    fn name(&self) -> &'static str {
        GOVERN_CHAT_REQUEST_OPERATOR
    }

    fn version(&self) -> &'static str {
        GOVERN_CHAT_REQUEST_OPERATOR_VERSION
    }

    fn input_type(&self) -> ValueType {
        ValueType::Object
    }

    fn output_type(&self) -> ValueType {
        ValueType::Object
    }

    fn execute(&self, payload: Value, _: &OperatorContext) -> Result<Value, String> {
        let mut normalized = self.normalized.clone();
        normalized.previous.payload.0 = Arc::new(payload);
        let mut events = self.events.clone();
        match govern_chat_request_at_req04(&mut normalized, &self.profile, &mut events) {
            Ok(mut side_output) => {
                side_output.events = events;
                let payload = normalized.payload().clone();
                *self.side_output.lock().map_err(|_| {
                    "govern_chat_request side-output holder is poisoned".to_string()
                })? = Some(GovernChatRequestOperatorSideOutput::Success(side_output));
                Ok(payload)
            }
            Err(error) => {
                if let Ok(mut slot) = self.side_output.lock() {
                    *slot = Some(GovernChatRequestOperatorSideOutput::Failure(Box::new(
                        GovernChatRequestFailureSideOutput {
                            error: error.clone(),
                            events,
                        },
                    )));
                }
                Err(error.to_string())
            }
        }
    }
}

fn govern_chat_request_at_req04(
    normalized: &mut V3HubReqInbound02Normalized,
    profile: &V3HubRequestHookProfile,
    events: &mut Vec<V3HubRelayRequestHookEvent>,
) -> Result<Box<GovernChatRequestSideOutput>, V3HubRelayRequestError> {
    events.push(V3HubRelayRequestHookEvent::Req04Entry);
    let current_payload_start = 0usize;
    if normalized.entry_protocol() == V3HubEntryProtocol::Responses
        && profile.memory_raw_capture_enabled()
        && !normalized.memory_raw_capture_guidance_injected
    {
        routecodex_v3_agent_memory::inject_memory_raw_capture_guidance(Arc::make_mut(
            &mut normalized.previous.payload.0,
        ))
        .map_err(|reason| {
            V3HubRelayRequestError::MemoryRawCaptureGuidanceInjectionFailed { reason }
        })?;
        normalized.memory_raw_capture_guidance_injected = true;
    }
    let tool_thinking_turn_context = compile_v3_tool_thinking_turn_context_at_req04(
        Arc::make_mut(&mut normalized.previous.payload.0),
        current_payload_start,
        profile.tool_thinking_enabled(),
    )?;
    if govern_protocol_tool_identity_at_req04(normalized.entry_protocol(), normalized.payload())? {
        events.push(V3HubRelayRequestHookEvent::Req04ProtocolToolIdentityGoverned);
    }
    let govern_chat_messages_tool_outputs = normalized.canonicalized_from_responses
        || matches!(
            normalized.entry_protocol(),
            V3HubEntryProtocol::OpenAiChat | V3HubEntryProtocol::Gemini
        );
    let tool_output_count = govern_tool_outputs_at_req04(
        Arc::make_mut(&mut normalized.previous.payload.0),
        govern_chat_messages_tool_outputs,
        current_payload_start,
    )?;
    events.push(V3HubRelayRequestHookEvent::Req04ToolGoverned);
    events.push(V3HubRelayRequestHookEvent::Req04Exit);
    Ok(Box::new(GovernChatRequestSideOutput {
        context: GovernChatRequestContext::from_normalized(normalized),
        events: Vec::new(),
        tool_output_count,
        tool_thinking_enabled: profile.tool_thinking_enabled(),
        tool_thinking_turn_context,
    }))
}

fn run_govern_chat_request_through_sdk(
    normalized: V3HubReqInbound02Normalized,
    profile: &V3HubRequestHookProfile,
    events: Vec<V3HubRelayRequestHookEvent>,
) -> Result<
    (
        V3HubReqInbound02Normalized,
        Box<GovernChatRequestSideOutput>,
    ),
    V3HubRelayRequestError,
> {
    let payload = normalized.payload().clone();
    let side_output = Arc::new(Mutex::new(None));
    let result = run_v3_single_node_operator(
        V3OperationGraph::Request,
        "govern_chat_request",
        payload,
        GovernChatRequestOperator {
            normalized,
            profile: profile.clone(),
            events,
            side_output: side_output.clone(),
        },
    );
    let side_output = side_output
        .lock()
        .map_err(|_| V3HubRelayRequestError::ReqInboundInvalid {
            reason: "govern_chat_request side-output holder is poisoned".to_string(),
        })?
        .take();
    match result {
        Ok(payload) => match side_output {
            Some(GovernChatRequestOperatorSideOutput::Success(side_output)) => {
                let normalized = side_output.context.into_normalized(payload);
                Ok((normalized, side_output))
            }
            Some(GovernChatRequestOperatorSideOutput::Failure(side_output)) => {
                Err(side_output.error)
            }
            None => Err(V3HubRelayRequestError::ReqInboundInvalid {
                reason: "govern_chat_request operator succeeded without typed side output"
                    .to_string(),
            }),
        },
        Err(error) => match side_output {
            Some(GovernChatRequestOperatorSideOutput::Failure(side_output)) => {
                Err(side_output.error)
            }
            Some(GovernChatRequestOperatorSideOutput::Success(_)) | None => {
                Err(V3HubRelayRequestError::ReqInboundInvalid {
                    reason: format!("govern_chat_request SDK execution failed: {error}"),
                })
            }
        },
    }
}

impl V3HubRelayRequestHooks {
    pub fn run(
        &self,
        raw: V3HubReqInbound01ClientRaw,
        profile: &V3HubRequestHookProfile,
    ) -> Result<V3HubRelayRequestOutcome, V3HubRelayRequestError> {
        let mut events = vec![
            V3HubRelayRequestHookEvent::Req01Entry,
            V3HubRelayRequestHookEvent::Req01Exit,
            V3HubRelayRequestHookEvent::Req02Entry,
        ];
        let normalized = build_v3_hub_req_inbound_02_result_from_v3_hub_req_inbound_01(raw)
            .map_err(|reason| V3HubRelayRequestError::ReqInboundInvalid { reason })?;
        events.push(V3HubRelayRequestHookEvent::Req02Exit);
        self.run_from_normalized_with_events(normalized, profile, events)
    }

    pub fn run_from_normalized(
        &self,
        normalized: V3HubReqInbound02Normalized,
        profile: &V3HubRequestHookProfile,
    ) -> Result<V3HubRelayRequestOutcome, V3HubRelayRequestError> {
        self.run_from_normalized_with_events(normalized, profile, Vec::new())
    }

    fn run_from_normalized_with_events(
        &self,
        normalized: V3HubReqInbound02Normalized,
        profile: &V3HubRequestHookProfile,
        events: Vec<V3HubRelayRequestHookEvent>,
    ) -> Result<V3HubRelayRequestOutcome, V3HubRelayRequestError> {
        let (normalized, side_output) =
            run_govern_chat_request_through_sdk(normalized, profile, events)?;
        let governed = build_v3_hub_req_chat_process_04_from_v3_hub_req_inbound_02(normalized);
        Ok(V3HubRelayRequestOutcome {
            governed,
            tool_output_count: side_output.tool_output_count,
            events: side_output.events,
            tool_thinking_enabled: side_output.tool_thinking_enabled,
            tool_thinking_turn_context: side_output.tool_thinking_turn_context,
        })
    }
}

fn govern_protocol_tool_identity_at_req04(
    entry_protocol: V3HubEntryProtocol,
    payload: &Value,
) -> Result<bool, V3HubRelayRequestError> {
    match entry_protocol {
        V3HubEntryProtocol::OpenAiChat => {
            let Some(messages) = payload.get("messages").and_then(Value::as_array) else {
                return Ok(false);
            };
            govern_openai_chat_tool_identity_at_req04(messages)?;
            Ok(true)
        }
        // Gemini 请求在 ReqInbound02 已归一化为 canonical Chat `messages`；其工具历史
        // 由下方 canonical Chat 治理统一处理，不再对原始 `contents` 二次治理。
        V3HubEntryProtocol::Gemini
        | V3HubEntryProtocol::Responses
        | V3HubEntryProtocol::Anthropic => Ok(false),
    }
}

fn govern_openai_chat_tool_identity_at_req04(
    messages: &[Value],
) -> Result<(), V3HubRelayRequestError> {
    let mut declared = BTreeSet::new();
    for (index, message) in messages.iter().enumerate() {
        if let Some(calls) = message.get("tool_calls") {
            let calls =
                calls
                    .as_array()
                    .ok_or(V3HubRelayRequestError::ProtocolToolIdentityInvalid {
                        protocol: "openai_chat",
                        index,
                        reason: "tool_calls must be an array",
                    })?;
            for call in calls {
                let id = call
                    .get("id")
                    .and_then(Value::as_str)
                    .filter(|id| !id.is_empty())
                    .ok_or(V3HubRelayRequestError::ProtocolToolIdentityInvalid {
                        protocol: "openai_chat",
                        index,
                        reason: "tool_calls.id is required",
                    })?;
                declared.insert(id.to_owned());
            }
        }
        if message.get("role").and_then(Value::as_str) == Some("tool") {
            let id = message
                .get("tool_call_id")
                .and_then(Value::as_str)
                .filter(|id| !id.is_empty())
                .ok_or(V3HubRelayRequestError::ProtocolToolIdentityInvalid {
                    protocol: "openai_chat",
                    index,
                    reason: "tool_call_id is required",
                })?;
            if !declared.contains(id) {
                return Err(V3HubRelayRequestError::ProtocolToolIdentityInvalid {
                    protocol: "openai_chat",
                    index,
                    reason: "orphan tool_call_id",
                });
            }
        }
    }
    Ok(())
}

fn govern_tool_outputs_at_req04(
    payload: &mut Value,
    govern_chat_messages: bool,
    current_payload_start: usize,
) -> Result<usize, V3HubRelayRequestError> {
    if payload.get("input").and_then(Value::as_array).is_none()
        && payload.get("messages").and_then(Value::as_array).is_some()
        && govern_chat_messages
    {
        return govern_chat_tool_outputs_at_req04(payload, current_payload_start);
    }
    let mut expected_outputs: BTreeMap<String, Vec<V3HubRelayExpectedToolOutputKind>> =
        BTreeMap::new();
    if let Some(messages) = payload.get("messages").and_then(Value::as_array) {
        for message in messages.iter().skip(current_payload_start) {
            if let Some(calls) = message.get("tool_calls").and_then(Value::as_array) {
                for call in calls {
                    if let Some((call_id, expected_kind)) =
                        expected_tool_call_output_from_chat_call(call)
                    {
                        expected_outputs
                            .entry(call_id)
                            .or_default()
                            .push(expected_kind);
                    }
                }
            }
        }
    }
    let Some(input) = payload.get_mut("input").and_then(Value::as_array_mut) else {
        return Ok(0);
    };
    let mut output_count = 0;
    for (index, item) in input.iter_mut().enumerate().skip(current_payload_start) {
        if let Some((call_id, expected_kind)) = expected_tool_call_output_from_item(item) {
            expected_outputs
                .entry(call_id)
                .or_default()
                .push(expected_kind);
            continue;
        }
        let actual_kind = match item.get("type").and_then(Value::as_str) {
            Some("function_call_output") => V3HubRelayActualToolOutputKind::Function,
            Some("custom_tool_call_output") => V3HubRelayActualToolOutputKind::Custom,
            _ => continue,
        };
        output_count += 1;
        let call_id = item
            .get("call_id")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .ok_or(V3HubRelayRequestError::MalformedToolOutput { index })?;
        if let Some(expected_kinds) = expected_outputs.get(call_id) {
            if !expected_kinds
                .iter()
                .any(|expected_kind| expected_kind.matches_actual(actual_kind))
            {
                return Err(V3HubRelayRequestError::ToolOutputKindMismatch {
                    index,
                    call_id: call_id.to_owned(),
                });
            }
        } else {
            return Err(V3HubRelayRequestError::OrphanToolOutput {
                index,
                call_id: call_id.to_owned(),
            });
        }
    }
    Ok(output_count)
}

fn govern_chat_tool_outputs_at_req04(
    payload: &mut Value,
    current_payload_start: usize,
) -> Result<usize, V3HubRelayRequestError> {
    let Some(messages) = payload.get_mut("messages").and_then(Value::as_array_mut) else {
        return Ok(0);
    };
    let mut expected_outputs: BTreeMap<String, Vec<V3HubRelayExpectedToolOutputKind>> =
        BTreeMap::new();
    let mut output_count = 0usize;
    for (index, message) in messages.iter_mut().enumerate().skip(current_payload_start) {
        match message.get("role").and_then(Value::as_str) {
            Some("assistant") => {
                expected_outputs.clear();
                if let Some(calls) = message.get("tool_calls").and_then(Value::as_array) {
                    for call in calls {
                        if let Some((call_id, expected_kind)) =
                            expected_tool_call_output_from_chat_call(call)
                        {
                            expected_outputs
                                .entry(call_id)
                                .or_default()
                                .push(expected_kind);
                        }
                    }
                }
                continue;
            }
            Some("tool") => {}
            _ => continue,
        }
        output_count = output_count.saturating_add(1);
        let Some(call_id) = message
            .get("tool_call_id")
            .or_else(|| message.get("call_id"))
            .or_else(|| message.get("id"))
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .map(str::to_owned)
        else {
            // 原生（Gemini）no-id tool receipt 没有可配对的 id，也不生成 id；它以
            // `routecodex_chat_extension.gemini_native_fields` 的显式 source 关联
            // 保留在 canonical 历史里。这里只计数，不按 canonical id 规则判 malformed。
            if message
                .pointer("/routecodex_chat_extension/gemini_native_fields")
                .is_some()
            {
                continue;
            }
            return Err(V3HubRelayRequestError::MalformedToolOutput { index });
        };
        let expected_kinds = expected_outputs.get(&call_id).ok_or_else(|| {
            V3HubRelayRequestError::OrphanToolOutput {
                index,
                call_id: call_id.to_owned(),
            }
        })?;
        if message
            .pointer("/routecodex_chat_extension/responses_tool_output_type")
            .is_none()
            && expected_kinds
                .iter()
                .all(|kind| *kind == V3HubRelayExpectedToolOutputKind::Custom)
        {
            if let Some(row) = message.as_object_mut() {
                if let Some(extension) = row
                    .entry("routecodex_chat_extension")
                    .or_insert_with(|| json!({}))
                    .as_object_mut()
                {
                    extension.insert(
                        "responses_tool_output_type".to_string(),
                        json!("custom_tool_call_output"),
                    );
                }
            }
        }
        let actual_kind = actual_chat_tool_output_kind(message);
        if !expected_kinds
            .iter()
            .any(|expected_kind| expected_kind.matches_actual(actual_kind))
        {
            return Err(V3HubRelayRequestError::ToolOutputKindMismatch {
                index,
                call_id: call_id.to_owned(),
            });
        }
    }
    Ok(output_count)
}

fn actual_chat_tool_output_kind(message: &Value) -> V3HubRelayActualToolOutputKind {
    match message
        .pointer("/routecodex_chat_extension/responses_tool_output_type")
        .and_then(Value::as_str)
    {
        Some("custom_tool_call_output") => V3HubRelayActualToolOutputKind::Custom,
        _ => V3HubRelayActualToolOutputKind::Function,
    }
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum V3HubRelayExpectedToolOutputKind {
    Function,
    Custom,
    ApplyPatch,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum V3HubRelayActualToolOutputKind {
    Function,
    Custom,
}

impl V3HubRelayExpectedToolOutputKind {
    fn matches_actual(self, actual: V3HubRelayActualToolOutputKind) -> bool {
        matches!(
            (self, actual),
            (
                V3HubRelayExpectedToolOutputKind::Function,
                V3HubRelayActualToolOutputKind::Function
            ) | (
                V3HubRelayExpectedToolOutputKind::Custom,
                V3HubRelayActualToolOutputKind::Custom
            ) | (V3HubRelayExpectedToolOutputKind::ApplyPatch, _)
        )
    }
}

fn expected_tool_call_output_from_chat_call(
    call: &Value,
) -> Option<(String, V3HubRelayExpectedToolOutputKind)> {
    let call_id = call
        .get("id")
        .or_else(|| call.get("call_id"))
        .or_else(|| call.get("tool_call_id"))
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())?;
    let name = call
        .get("name")
        .or_else(|| call.pointer("/function/name"))
        .and_then(Value::as_str)
        .unwrap_or_default();
    let expected_kind = if name.eq_ignore_ascii_case("apply_patch") {
        V3HubRelayExpectedToolOutputKind::ApplyPatch
    } else if call
        .pointer("/routecodex_chat_extension/responses_tool_call_type")
        .and_then(Value::as_str)
        == Some("custom_tool_call")
    {
        V3HubRelayExpectedToolOutputKind::Custom
    } else {
        V3HubRelayExpectedToolOutputKind::Function
    };
    Some((call_id.to_owned(), expected_kind))
}

fn expected_tool_call_output_from_item(
    item: &Value,
) -> Option<(String, V3HubRelayExpectedToolOutputKind)> {
    let expected_kind = match item.get("type").and_then(Value::as_str) {
        Some("custom_tool_call") => V3HubRelayExpectedToolOutputKind::Custom,
        Some("function_call" | "tool_call") => V3HubRelayExpectedToolOutputKind::Function,
        _ => return None,
    };
    let call_id = item
        .get("call_id")
        .or_else(|| item.get("id"))
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())?;
    let expected_kind = if read_tool_call_name_at_req04(item)
        .as_deref()
        .is_some_and(|name| name.eq_ignore_ascii_case("apply_patch"))
    {
        V3HubRelayExpectedToolOutputKind::ApplyPatch
    } else {
        expected_kind
    };
    Some((call_id.to_owned(), expected_kind))
}

fn read_tool_call_name_at_req04(item: &Value) -> Option<String> {
    item.get("name")
        .and_then(Value::as_str)
        .or_else(|| {
            item.get("function")
                .and_then(Value::as_object)
                .and_then(|function| function.get("name"))
                .and_then(Value::as_str)
        })
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn normalized_chat(payload: Value) -> V3HubReqInbound02Normalized {
        build_v3_hub_req_inbound_02_result_from_v3_hub_req_inbound_01(
            build_v3_hub_req_inbound_01_client_raw(
                payload,
                V3HubEntryProtocol::OpenAiChat,
                V3HubInvocationSource::Client,
                V3HubTransportIntent::Json,
            ),
        )
        .expect("test request must normalize")
    }

    fn tool_exchange_payload(marker: &str) -> Value {
        json!({
            "model": "gpt-5.5",
            "messages": [
                {"role": "user", "content": marker},
                {
                    "role": "assistant",
                    "content": null,
                    "tool_calls": [{
                        "id": "call_bad",
                        "type": "function",
                        "function": {
                            "name": "exec_command",
                            "arguments": r#"{"cmd":"cat missing"}{"cmd":"pwd"}"#
                        }
                    }]
                },
                {
                    "role": "tool",
                    "tool_call_id": "call_bad",
                    "content": "failed to parse function arguments: trailing characters"
                }
            ],
            "tools": [{
                "type": "function",
                "function": {
                    "name": "exec_command",
                    "parameters": {
                        "type": "object",
                        "properties": {"cmd": {"type": "string"}}
                    }
                }
            }]
        })
    }

    #[test]
    fn govern_chat_request_operator_consumes_sdk_input_not_captured_business_payload() {
        let captured = normalized_chat(tool_exchange_payload("captured payload"));
        let sdk_input = tool_exchange_payload("sdk input payload");
        let profile = V3HubRequestHookProfile::enabled().with_tool_thinking_enabled(true);
        let side_output = Arc::new(Mutex::new(None));

        let output = run_v3_single_node_operator(
            V3OperationGraph::Request,
            "govern_chat_request",
            sdk_input,
            GovernChatRequestOperator {
                normalized: captured,
                profile,
                events: Vec::new(),
                side_output: side_output.clone(),
            },
        )
        .expect("govern_chat_request SDK must accept the caller's Value");

        assert_eq!(output["messages"][0]["content"], "sdk input payload");
        assert_ne!(output["messages"][0]["content"], "captured payload");
        assert_eq!(output["messages"][1]["tool_calls"][0]["id"], "call_bad");
        assert_eq!(
            output["messages"][1]["tool_calls"][0]["function"]["arguments"],
            r#"{"cmd":"cat missing"}{"cmd":"pwd"}"#
        );
        assert_eq!(output["messages"][2]["role"], "tool");
        assert_eq!(output["messages"][2]["tool_call_id"], "call_bad");
        assert_eq!(
            output["messages"][2]["content"],
            "failed to parse function arguments: trailing characters"
        );
        assert_eq!(
            output["tools"][0]["function"]["parameters"]["required"],
            json!(["reason", "goal_alignment_confidence"])
        );
        let side_output = side_output
            .lock()
            .expect("side-output lock")
            .take()
            .expect("typed side output");
        let GovernChatRequestOperatorSideOutput::Success(side_output) = side_output else {
            panic!("successful SDK execution must expose a success side output");
        };
        assert_eq!(side_output.tool_output_count, 1);
        assert!(side_output.tool_thinking_enabled);
        assert!(side_output.tool_thinking_turn_context.enabled_flag());
        assert_eq!(
            side_output.events,
            vec![
                V3HubRelayRequestHookEvent::Req04Entry,
                V3HubRelayRequestHookEvent::Req04ProtocolToolIdentityGoverned,
                V3HubRelayRequestHookEvent::Req04ToolGoverned,
                V3HubRelayRequestHookEvent::Req04Exit,
            ]
        );
    }

    #[test]
    fn govern_chat_request_req04_preserves_history_image_bytes_and_tool_pairing() {
        let payload = json!({
            "model": "gpt-5.5",
            "messages": [
                {"role": "user", "content": [
                    {"type": "text", "text": "look"},
                    {"type": "image_url", "image_url": {"url": "data:image/png;base64,HISTORY_USER"}}
                ]},
                {"role": "assistant", "content": null, "tool_calls": [{
                    "id": "call_read",
                    "type": "function",
                    "function": {"name": "read_image", "arguments": "{}"}
                }]},
                {"role": "tool", "tool_call_id": "call_read", "content": [
                    {"type": "image_url", "image_url": {"url": "data:image/png;base64,HISTORY_TOOL"}}
                ]},
                {"role": "assistant", "content": "done"},
                {"role": "user", "content": "now explain it"}
            ],
            "tools": [{
                "type": "function",
                "function": {"name": "read_image", "parameters": {"type": "object", "properties": {}}}
            }]
        });
        let captured = normalized_chat(payload.clone());
        let side_output = Arc::new(Mutex::new(None));

        let output = run_v3_single_node_operator(
            V3OperationGraph::Request,
            "govern_chat_request",
            payload,
            GovernChatRequestOperator {
                normalized: captured,
                profile: V3HubRequestHookProfile::enabled(),
                events: Vec::new(),
                side_output: side_output.clone(),
            },
        )
        .expect("govern_chat_request must accept the caller's Value");

        assert_eq!(
            output["messages"][0]["content"][1]["image_url"]["url"],
            "data:image/png;base64,HISTORY_USER",
            "Relay Req04 must not replace history-turn user image bytes"
        );
        assert_eq!(
            output["messages"][2]["tool_call_id"], "call_read",
            "history tool pairing must survive Relay Req04"
        );
        assert_eq!(
            output["messages"][2]["content"][0]["image_url"]["url"],
            "data:image/png;base64,HISTORY_TOOL",
            "history tool image bytes must survive Relay Req04"
        );
        assert_eq!(output["messages"][4]["content"], "now explain it");
    }
}
