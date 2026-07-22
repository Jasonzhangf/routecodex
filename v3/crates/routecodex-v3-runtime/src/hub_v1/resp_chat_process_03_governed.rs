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
    let input = project_v3_apply_patch_freeform_calls_at_resp03(stopless_outcome.input);
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
