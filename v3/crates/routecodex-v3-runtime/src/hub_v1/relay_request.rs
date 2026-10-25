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
    collections::BTreeMap,
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
    Req04Exit,
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum V3HubRelayRequestError {
    #[error("ReqInbound02 normalization failed: {reason}")]
    ReqInboundInvalid { reason: String },
    #[error("current-turn payload boundary is invalid: start {start}, len {len}")]
    CurrentPayloadBoundaryInvalid { start: usize, len: usize },
    #[error("tool-thinking schema is invalid: {reason}")]
    ToolThinkingSchemaInvalid { reason: String },
    #[error("memory raw capture guidance injection failed at Req04: {reason}")]
    MemoryRawCaptureGuidanceInjectionFailed { reason: String },
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
    super::normalize_v3_history_image_placeholders(Arc::make_mut(
        &mut normalized.previous.payload.0,
    ));
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
    let govern_chat_messages_tool_outputs = normalized.canonicalized_from_responses
        || matches!(
            normalized.entry_protocol(),
            V3HubEntryProtocol::OpenAiChat | V3HubEntryProtocol::Gemini
        );
    let tool_output_count = govern_tool_outputs_at_req04(
        Arc::make_mut(&mut normalized.previous.payload.0),
        govern_chat_messages_tool_outputs,
        current_payload_start,
    );
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

fn govern_tool_outputs_at_req04(
    payload: &mut Value,
    govern_chat_messages: bool,
    current_payload_start: usize,
) -> usize {
    if payload.get("input").and_then(Value::as_array).is_none()
        && payload.get("messages").and_then(Value::as_array).is_some()
        && govern_chat_messages
    {
        return govern_chat_tool_outputs_at_req04(payload, current_payload_start);
    }
    let Some(input) = payload.get("input").and_then(Value::as_array) else {
        return 0;
    };
    input
        .iter()
        .skip(current_payload_start)
        .filter(|item| {
            matches!(
                item.get("type").and_then(Value::as_str),
                Some("function_call_output" | "custom_tool_call_output")
            )
        })
        .count()
}

fn govern_chat_tool_outputs_at_req04(payload: &mut Value, current_payload_start: usize) -> usize {
    let Some(messages) = payload.get_mut("messages").and_then(Value::as_array_mut) else {
        return 0;
    };
    let mut expected_outputs: BTreeMap<String, Vec<V3HubRelayExpectedToolOutputKind>> =
        BTreeMap::new();
    // Retain prior calls only to associate custom output types. Missing or
    // unmatched identities remain business data, including across assistant turns.
    let mut output_count = 0usize;
    for message in messages.iter_mut().skip(current_payload_start) {
        match message.get("role").and_then(Value::as_str) {
            Some("assistant") => {
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
            continue;
        };
        let Some(expected_kinds) = expected_outputs.get(&call_id) else {
            continue;
        };
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
    }
    output_count
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum V3HubRelayExpectedToolOutputKind {
    Function,
    Custom,
    ApplyPatch,
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
                V3HubRelayRequestHookEvent::Req04ToolGoverned,
                V3HubRelayRequestHookEvent::Req04Exit,
            ]
        );
    }
}
