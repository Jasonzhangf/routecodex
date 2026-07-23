use super::*;
use serde_json::{json, Map, Value};
use std::collections::BTreeSet;
use std::sync::Arc;

#[derive(Debug, Clone, PartialEq)]
pub struct V3HubRespChatProcess03Governed {
    pub(crate) previous: V3HubRespInbound02Normalized,
    pub(crate) terminality: V3HubResponseTerminality,
    pub(crate) tool_calls: Vec<V3HubResponseToolCall>,
    pub(crate) servertool_action: V3HubServertoolResponseAction,
    pub(crate) stopless_center_state: Option<V3StoplessCenterState>,
}

pub fn build_v3_hub_resp_chat_process_03_from_v3_hub_resp_inbound_02(
    input: V3HubRespInbound02Normalized,
) -> V3HubRespChatProcess03Governed {
    V3HubRespChatProcess03Governed {
        previous: input,
        terminality: V3HubResponseTerminality::Terminal,
        tool_calls: Vec::new(),
        servertool_action: V3HubServertoolResponseAction::None,
        stopless_center_state: None,
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

    pub fn stopless_center_state(&self) -> Option<&V3StoplessCenterState> {
        self.stopless_center_state.as_ref()
    }

    pub fn tool_call_kinds(&self) -> Vec<V3HubRelayToolKind> {
        self.tool_calls
            .iter()
            .map(|tool_call| tool_call.kind)
            .collect()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct V3HubRelayResponseHookProfile {
    servertool_names: BTreeSet<String>,
    stopless_reasoning_stop: bool,
    stopless_center_state: Option<V3StoplessCenterState>,
    stopless_transition_request_id: Option<String>,
    stopless_transition_updated_at: Option<u64>,
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
            stopless_center_state: None,
            stopless_transition_request_id: None,
            stopless_transition_updated_at: None,
        }
    }

    pub fn empty() -> Self {
        Self::new(std::iter::empty::<&'static str>())
    }

    pub fn with_stopless_reasoning_stop(mut self) -> Self {
        self.stopless_reasoning_stop = true;
        self
    }

    pub fn with_stopless_center_state(mut self, state: V3StoplessCenterState) -> Self {
        self.stopless_center_state = Some(state);
        self
    }

    pub fn with_stopless_transition_context(
        mut self,
        request_id: impl Into<String>,
        updated_at: u64,
    ) -> Self {
        self.stopless_transition_request_id = Some(request_id.into());
        self.stopless_transition_updated_at = Some(updated_at);
        self
    }

    pub fn stopless_reasoning_stop_enabled(&self) -> bool {
        self.stopless_reasoning_stop
    }

    pub fn stopless_center_state(&self) -> Option<&V3StoplessCenterState> {
        self.stopless_center_state.as_ref()
    }

    pub fn stopless_transition_request_id(&self) -> Option<&str> {
        self.stopless_transition_request_id.as_deref()
    }

    pub fn stopless_transition_updated_at(&self) -> Option<u64> {
        self.stopless_transition_updated_at
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
    #[error("{protocol} provider response is malformed at Resp03: {reason}")]
    ProviderProtocolResponseMalformed {
        protocol: &'static str,
        reason: &'static str,
    },
    #[error("provider response compat failed: {reason}")]
    ProviderCompatFailed { reason: String },
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
    let compat =
        build_provider_resp_compat_02_from_v3_provider_resp_inbound_01(input).map_err(|error| {
            V3HubRelayResponseError::ProviderCompatFailed {
                reason: error.to_string(),
            }
        })?;
    Ok(build_v3_hub_resp_inbound_02_from_provider_resp_compat_02(
        compat,
    ))
}

fn govern_v3_hub_relay_response(
    input: V3HubRespInbound02Normalized,
    profile: &V3HubRelayResponseHookProfile,
) -> Result<V3HubRespChatProcess03Governed, V3HubRelayResponseError> {
    let stopless_outcome = apply_v3_stopless_response_hook_at_resp03(input, profile)?;
    let stopless_center_state = stopless_outcome.center_state;
    let input = harvest_v3_think_blocks_at_resp03(stopless_outcome.input);
    let input = project_v3_apply_patch_freeform_calls_at_resp03(input);
    let governance = build_v3_resp03_protocol_governance(&input)?;
    let terminality = if governance.tool_calls.is_empty() {
        governance.status_terminality
    } else {
        V3HubResponseTerminality::NonTerminal
    };
    let servertool_action = if governance
        .tool_calls
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
        tool_calls: governance.tool_calls,
        servertool_action,
        stopless_center_state,
    })
}

struct V3Resp03ProtocolGovernance {
    status_terminality: V3HubResponseTerminality,
    tool_calls: Vec<V3HubResponseToolCall>,
}

fn build_v3_resp03_protocol_governance(
    input: &V3HubRespInbound02Normalized,
) -> Result<V3Resp03ProtocolGovernance, V3HubRelayResponseError> {
    match input.provider_raw().provider_protocol {
        V3HubProviderWireProtocol::Responses => {
            build_v3_responses_resp03_protocol_governance(input.provider_payload().as_ref())
        }
        V3HubProviderWireProtocol::OpenAiChat => {
            build_v3_openai_chat_resp03_protocol_governance(input.provider_payload().as_ref())
        }
        V3HubProviderWireProtocol::Gemini => build_v3_gemini_resp03_protocol_governance(
            input.provider_payload().as_ref(),
            input.provider_raw().transport_intent,
        ),
        V3HubProviderWireProtocol::Anthropic => {
            Err(V3HubRelayResponseError::ProviderProtocolResponseMalformed {
                protocol: "anthropic",
                reason: "Anthropic provider wire is not a Relay Chat Process response protocol",
            })
        }
    }
}

fn build_v3_responses_resp03_protocol_governance(
    payload: &Value,
) -> Result<V3Resp03ProtocolGovernance, V3HubRelayResponseError> {
    let object = payload
        .as_object()
        .ok_or(V3HubRelayResponseError::ProviderResponseNotObject)?;
    let output = match object.get("output") {
        Some(Value::Array(output)) => output.as_slice(),
        Some(_) => return Err(V3HubRelayResponseError::ProviderResponseOutputNotArray),
        None => &[],
    };
    let tool_calls = collect_v3_resp03_responses_tool_calls(output)?;
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
    Ok(V3Resp03ProtocolGovernance {
        status_terminality,
        tool_calls,
    })
}

fn collect_v3_resp03_responses_tool_calls(
    output: &[Value],
) -> Result<Vec<V3HubResponseToolCall>, V3HubRelayResponseError> {
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
    Ok(tool_calls)
}

fn build_v3_openai_chat_resp03_protocol_governance(
    payload: &Value,
) -> Result<V3Resp03ProtocolGovernance, V3HubRelayResponseError> {
    let choices = payload.get("choices").and_then(Value::as_array).ok_or(
        V3HubRelayResponseError::ProviderProtocolResponseMalformed {
            protocol: "openai_chat",
            reason: "choices must be an array",
        },
    )?;
    let mut output = Vec::new();
    for choice in choices {
        for call in choice
            .pointer("/message/tool_calls")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            output.push(json!({
                "type": "function_call",
                "call_id": call.get("id").cloned().unwrap_or(Value::Null),
                "name": call.pointer("/function/name").cloned().unwrap_or(Value::Null)
            }));
        }
    }
    Ok(V3Resp03ProtocolGovernance {
        status_terminality: V3HubResponseTerminality::Terminal,
        tool_calls: collect_v3_resp03_responses_tool_calls(&output)?,
    })
}

fn build_v3_gemini_resp03_protocol_governance(
    payload: &Value,
    transport_intent: V3HubTransportIntent,
) -> Result<V3Resp03ProtocolGovernance, V3HubRelayResponseError> {
    let candidates = payload.get("candidates").and_then(Value::as_array).ok_or(
        V3HubRelayResponseError::ProviderProtocolResponseMalformed {
            protocol: "gemini",
            reason: "candidates must be an array",
        },
    )?;
    let mut output = Vec::new();
    for candidate in candidates {
        for part in candidate
            .get("content")
            .and_then(|content| content.get("parts"))
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let Some(function_call) = part.get("functionCall") else {
                continue;
            };
            let name = function_call
                .get("name")
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
                .ok_or(V3HubRelayResponseError::ProviderProtocolResponseMalformed {
                    protocol: "gemini",
                    reason: "functionCall.name is required",
                })?;
            output.push(json!({"type":"function_call","call_id":name,"name":name}));
        }
    }
    let terminal = candidates.iter().any(|candidate| {
        candidate
            .get("finishReason")
            .is_some_and(|value| !value.is_null())
    });
    let status_terminality = if transport_intent == V3HubTransportIntent::Sse && !terminal {
        V3HubResponseTerminality::NonTerminal
    } else {
        V3HubResponseTerminality::Terminal
    };
    Ok(V3Resp03ProtocolGovernance {
        status_terminality,
        tool_calls: collect_v3_resp03_responses_tool_calls(&output)?,
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

fn harvest_v3_think_blocks_at_resp03(
    mut input: V3HubRespInbound02Normalized,
) -> V3HubRespInbound02Normalized {
    let mut next = input.provider_payload().as_ref().clone();
    let changed = match input.provider_raw().provider_protocol {
        V3HubProviderWireProtocol::Responses => harvest_v3_responses_think_blocks(&mut next),
        V3HubProviderWireProtocol::OpenAiChat => harvest_v3_openai_chat_think_blocks(&mut next),
        V3HubProviderWireProtocol::Gemini => harvest_v3_gemini_think_blocks(&mut next),
        V3HubProviderWireProtocol::Anthropic => false,
    };
    if changed {
        *input.provider_payload_mut() = Arc::new(next);
    }
    input
}

#[derive(Default)]
struct V3ThinkHarvest {
    visible_text: String,
    reasoning_segments: Vec<String>,
    changed: bool,
}

fn harvest_v3_think_text(text: &str) -> V3ThinkHarvest {
    let (text, provider_sentinel_changed) = strip_v3_resp03_minimax_provider_sentinel_text(text);
    let mut output = String::new();
    let mut reasoning_segments = Vec::new();
    let mut cursor = 0usize;
    let mut changed = provider_sentinel_changed;
    while let Some(relative_start) = text[cursor..].find("<think>") {
        let start = cursor + relative_start;
        output.push_str(&text[cursor..start]);
        let content_start = start + "<think>".len();
        let Some(relative_end) = text[content_start..].find("</think>") else {
            output.push_str(&text[start..]);
            return V3ThinkHarvest {
                visible_text: output,
                reasoning_segments,
                changed,
            };
        };
        let end = content_start + relative_end;
        if let Some(reasoning) = read_v3_resp03_trimmed_owned(&text[content_start..end]) {
            reasoning_segments.push(reasoning);
        }
        cursor = end + "</think>".len();
        changed = true;
    }
    output.push_str(&text[cursor..]);
    V3ThinkHarvest {
        visible_text: output,
        reasoning_segments,
        changed,
    }
}

fn strip_v3_resp03_minimax_provider_sentinel_text(text: &str) -> (String, bool) {
    if !text.contains("]<]minimax[>[") {
        return (text.to_string(), false);
    }
    let mut next = text.replace("]<]minimax[>[", "");
    let mut changed = true;
    for marker in ["<think\n", "<think\r\n", "<think"] {
        if next.starts_with(marker) {
            next = next[marker.len()..].to_string();
            break;
        }
    }
    let trimmed_start = next.trim_start_matches(['\r', '\n', ' ', '\t']);
    if let Some(rest) = trimmed_start.strip_prefix("<continue") {
        next = rest.to_string();
        changed = true;
    }
    (next, changed)
}

fn read_v3_resp03_trimmed_owned(text: &str) -> Option<String> {
    let trimmed = text.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_string())
}

fn v3_resp03_reasoning_item(reasoning_segments: Vec<String>) -> Value {
    let mut summary = Vec::new();
    for text in reasoning_segments {
        let Some(text) = read_v3_resp03_trimmed_owned(&text) else {
            continue;
        };
        summary.push(json!({"type":"summary_text","text":text}));
    }
    json!({
        "type": "reasoning",
        "summary": summary
    })
}

fn harvest_v3_responses_think_blocks(payload: &mut Value) -> bool {
    let Some(object) = payload.as_object_mut() else {
        return false;
    };
    let Some(output) = object.get_mut("output").and_then(Value::as_array_mut) else {
        return false;
    };
    let mut changed = false;
    let mut next_output = Vec::with_capacity(output.len());
    let mut aggregate_output_text = String::new();
    for mut item in std::mem::take(output) {
        let mut reasoning_segments = Vec::new();
        if harvest_v3_responses_output_item_think_blocks(&mut item, &mut reasoning_segments) {
            changed = true;
            if !reasoning_segments.is_empty() {
                next_output.push(v3_resp03_reasoning_item(reasoning_segments));
            }
        }
        if !is_v3_resp03_empty_visible_text_item(&item) {
            append_v3_resp03_output_text_segments(&mut aggregate_output_text, &item);
            next_output.push(item);
        } else {
            changed = true;
        }
    }
    *output = next_output;
    if changed {
        if aggregate_output_text.trim().is_empty() {
            object.remove("output_text");
        } else {
            object.insert(
                "output_text".to_string(),
                Value::String(aggregate_output_text),
            );
        }
    }
    changed
}

fn harvest_v3_responses_output_item_think_blocks(
    item: &mut Value,
    reasoning_segments: &mut Vec<String>,
) -> bool {
    let Some(row) = item.as_object_mut() else {
        return false;
    };
    let item_type = row.get("type").and_then(Value::as_str).unwrap_or_default();
    let mut changed = false;
    match item_type {
        "output_text" => {
            if let Some(text) = row.get("text").and_then(Value::as_str) {
                let harvest = harvest_v3_think_text(text);
                if harvest.changed {
                    changed = true;
                    reasoning_segments.extend(harvest.reasoning_segments);
                    row.insert("text".to_string(), Value::String(harvest.visible_text));
                }
            }
        }
        "message" => {
            if let Some(content) = row.get_mut("content").and_then(Value::as_array_mut) {
                for part in content {
                    let Some(part_row) = part.as_object_mut() else {
                        continue;
                    };
                    if !matches!(
                        part_row.get("type").and_then(Value::as_str),
                        Some("output_text" | "text")
                    ) {
                        continue;
                    }
                    let Some(text) = part_row.get("text").and_then(Value::as_str) else {
                        continue;
                    };
                    let harvest = harvest_v3_think_text(text);
                    if harvest.changed {
                        changed = true;
                        reasoning_segments.extend(harvest.reasoning_segments);
                        part_row.insert("text".to_string(), Value::String(harvest.visible_text));
                    }
                }
            }
        }
        _ => {}
    }
    changed
}

fn is_v3_resp03_empty_visible_text_item(item: &Value) -> bool {
    let Some(row) = item.as_object() else {
        return false;
    };
    match row.get("type").and_then(Value::as_str) {
        Some("output_text") => row
            .get("text")
            .and_then(Value::as_str)
            .is_some_and(|text| text.trim().is_empty()),
        Some("message") => row
            .get("content")
            .and_then(Value::as_array)
            .is_some_and(|parts| {
                parts.iter().all(|part| {
                    let Some(part_row) = part.as_object() else {
                        return false;
                    };
                    if !matches!(
                        part_row.get("type").and_then(Value::as_str),
                        Some("output_text" | "text")
                    ) {
                        return false;
                    }
                    part_row
                        .get("text")
                        .and_then(Value::as_str)
                        .is_some_and(|text| text.trim().is_empty())
                })
            }),
        _ => false,
    }
}

fn append_v3_resp03_output_text_segments(output_text: &mut String, item: &Value) {
    let Some(row) = item.as_object() else {
        return;
    };
    match row.get("type").and_then(Value::as_str) {
        Some("output_text") => {
            if let Some(text) = row.get("text").and_then(Value::as_str) {
                output_text.push_str(text);
            }
        }
        Some("message") => {
            if let Some(parts) = row.get("content").and_then(Value::as_array) {
                for part in parts {
                    if let Some(text) = part
                        .as_object()
                        .filter(|part_row| {
                            matches!(
                                part_row.get("type").and_then(Value::as_str),
                                Some("output_text" | "text")
                            )
                        })
                        .and_then(|part_row| part_row.get("text"))
                        .and_then(Value::as_str)
                    {
                        output_text.push_str(text);
                    }
                }
            }
        }
        _ => {}
    }
}

fn harvest_v3_openai_chat_think_blocks(payload: &mut Value) -> bool {
    let Some(choices) = payload.get_mut("choices").and_then(Value::as_array_mut) else {
        return false;
    };
    let mut changed = false;
    for choice in choices {
        let Some(message) = choice.get_mut("message").and_then(Value::as_object_mut) else {
            continue;
        };
        let Some(content) = message.get("content").and_then(Value::as_str) else {
            continue;
        };
        let harvest = harvest_v3_think_text(content);
        if !harvest.changed {
            continue;
        }
        changed = true;
        message.insert("content".to_string(), Value::String(harvest.visible_text));
        append_v3_resp03_openai_chat_reasoning_content(message, harvest.reasoning_segments);
    }
    changed
}

fn append_v3_resp03_openai_chat_reasoning_content(
    message: &mut Map<String, Value>,
    reasoning_segments: Vec<String>,
) {
    let mut joined = message
        .get("reasoning_content")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(str::to_string)
        .unwrap_or_default();
    for segment in reasoning_segments {
        let Some(segment) = read_v3_resp03_trimmed_owned(&segment) else {
            continue;
        };
        if !joined.is_empty() {
            joined.push('\n');
        }
        joined.push_str(&segment);
    }
    if !joined.is_empty() {
        message.insert("reasoning_content".to_string(), Value::String(joined));
    }
}

fn harvest_v3_gemini_think_blocks(payload: &mut Value) -> bool {
    let Some(candidates) = payload.get_mut("candidates").and_then(Value::as_array_mut) else {
        return false;
    };
    let mut changed = false;
    for candidate in candidates {
        let Some(parts) = candidate
            .get_mut("content")
            .and_then(|content| content.get_mut("parts"))
            .and_then(Value::as_array_mut)
        else {
            continue;
        };
        for part in parts {
            let Some(row) = part.as_object_mut() else {
                continue;
            };
            let Some(text) = row.get("text").and_then(Value::as_str) else {
                continue;
            };
            let harvest = harvest_v3_think_text(text);
            if !harvest.changed {
                continue;
            }
            changed = true;
            row.insert("text".to_string(), Value::String(harvest.visible_text));
            let mut thought = String::new();
            for segment in harvest.reasoning_segments {
                let Some(segment) = read_v3_resp03_trimmed_owned(&segment) else {
                    continue;
                };
                if !thought.is_empty() {
                    thought.push('\n');
                }
                thought.push_str(&segment);
            }
            if !thought.is_empty() {
                row.insert("thought".to_string(), Value::String(thought));
            }
        }
    }
    changed
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resp03_harvests_responses_think_block_into_reasoning_summary() {
        let mut payload = json!({
            "id": "resp_think_visible",
            "status": "completed",
            "output": [{"type":"output_text","text":"<think>Need inspect state.</think>Visible answer"}],
            "output_text": "<think>Need inspect state.</think>Visible answer"
        });

        assert!(harvest_v3_responses_think_blocks(&mut payload));
        assert_eq!(payload["output"][0]["type"], "reasoning");
        assert_eq!(
            payload["output"][0]["summary"][0]["text"],
            "Need inspect state."
        );
        assert_eq!(payload["output"][1]["type"], "output_text");
        assert_eq!(payload["output"][1]["text"], "Visible answer");
        assert_eq!(payload["output_text"], "Visible answer");
        assert!(!payload.to_string().contains("<think>"));
        assert!(!payload.to_string().contains("</think>"));
    }

    #[test]
    fn resp03_drops_think_only_visible_text_after_reasoning_mapping() {
        let mut payload = json!({
            "id": "resp_think_only",
            "status": "completed",
            "output": [{"type":"output_text","text":"<think>private plan</think>"}],
            "output_text": "<think>private plan</think>"
        });

        assert!(harvest_v3_responses_think_blocks(&mut payload));
        assert_eq!(payload["output"].as_array().expect("output").len(), 1);
        assert_eq!(payload["output"][0]["type"], "reasoning");
        assert_eq!(payload["output"][0]["summary"][0]["text"], "private plan");
        assert!(payload.get("output_text").is_none());
    }

    #[test]
    fn resp03_openai_chat_think_block_becomes_reasoning_content() {
        let mut payload = json!({
            "choices": [{
                "message": {
                    "role": "assistant",
                    "content": "A<think>hidden chain</think>B"
                },
                "finish_reason": "stop"
            }]
        });

        assert!(harvest_v3_openai_chat_think_blocks(&mut payload));
        let message = &payload["choices"][0]["message"];
        assert_eq!(message["content"], "AB");
        assert_eq!(message["reasoning_content"], "hidden chain");
        assert!(!payload.to_string().contains("<think>"));
    }

    #[test]
    fn resp03_think_harvest_preserves_visible_text_bytes_outside_tags() {
        let harvest = harvest_v3_think_text("  before\n<think>private</think> after  ");

        assert!(harvest.changed);
        assert_eq!(harvest.visible_text, "  before\n after  ");
        assert_eq!(harvest.reasoning_segments, vec!["private".to_string()]);
    }

    #[test]
    fn resp03_strips_minimax_provider_sentinel_prefix_without_dropping_visible_text() {
        let harvest = harvest_v3_think_text(
            "<think]<]minimax[>[\n<continue继续。检查所有 tshirt-heavy / polo-classic 依赖",
        );

        assert!(harvest.changed);
        assert_eq!(
            harvest.visible_text,
            "继续。检查所有 tshirt-heavy / polo-classic 依赖"
        );
        assert!(harvest.reasoning_segments.is_empty());
    }
}
