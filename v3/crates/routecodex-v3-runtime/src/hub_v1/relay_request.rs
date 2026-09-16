use super::{
    apply_v3_web_search_request_hook_at_req04,
    build_v3_hub_req_chat_process_04_from_v3_hub_req_inbound_02,
    build_v3_hub_req_inbound_02_result_from_v3_hub_req_inbound_01, find_v3_hub_side_channel_key,
    govern_v3_servertool_request_at_req04, V3HubEntryProtocol, V3HubReqChatProcess04Governed,
    V3HubReqInbound01ClientRaw, V3HubReqInbound02Normalized, V3HubRequestSemanticProtocol,
    V3ToolThinkingTurnContext, V3WebSearchCenterState,
};
use serde_json::Value;
use std::{
    collections::{BTreeMap, BTreeSet},
    sync::Arc,
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum V3HubServertoolRequestProfile {
    Disabled,
    Enabled {
        hook_ids: Vec<&'static str>,
        web_search_execution_mode: Option<routecodex_v3_config::V3WebSearchExecutionMode>,
        tool_thinking: bool,
        memory_raw_capture: bool,
    },
    RequiredFailure(&'static str),
}
impl V3HubServertoolRequestProfile {
    pub fn disabled() -> Self {
        Self::Disabled
    }
    pub fn enabled<const N: usize>(hook_ids: [&'static str; N]) -> Self {
        Self::Enabled {
            hook_ids: hook_ids.into(),
            web_search_execution_mode: None,
            tool_thinking: false,
            memory_raw_capture: false,
        }
    }
    pub fn with_web_search_execution_mode(
        mut self,
        mode: routecodex_v3_config::V3WebSearchExecutionMode,
    ) -> Self {
        if let Self::Enabled {
            web_search_execution_mode,
            ..
        } = &mut self
        {
            *web_search_execution_mode = Some(mode);
        }
        self
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
    pub fn web_search_execution_mode(
        &self,
    ) -> Option<routecodex_v3_config::V3WebSearchExecutionMode> {
        match self {
            Self::Enabled {
                web_search_execution_mode,
                ..
            } => *web_search_execution_mode,
            Self::Disabled | Self::RequiredFailure(_) => None,
        }
    }
    pub fn required_failure(hook_id: &'static str) -> Self {
        Self::RequiredFailure(hook_id)
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
    Req04ServertoolGoverned,
    ServertoolOptionalNoop,
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
    #[error("side-channel field leaked into normal request payload: {key}")]
    SideChannelLeaked { key: &'static str },
    #[error("required request hook failed: {hook_id}")]
    RequiredHookFailed { hook_id: &'static str },
    #[error("unknown static servertool request hook: {hook_id}")]
    UnknownStaticHook { hook_id: &'static str },
    #[error("web_search ServerTool surface activation failed at Req04: {reason}")]
    WebSearchToolSurfaceActivationFailed { reason: String },
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
    web_search_state: Option<V3WebSearchCenterState>,
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
    pub fn web_search_state(&self) -> Option<&V3WebSearchCenterState> {
        self.web_search_state.as_ref()
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

impl V3HubRelayRequestHooks {
    pub fn run(
        &self,
        raw: V3HubReqInbound01ClientRaw,
        profile: &V3HubServertoolRequestProfile,
    ) -> Result<V3HubRelayRequestOutcome, V3HubRelayRequestError> {
        if let Some(key) = find_v3_hub_side_channel_key(&raw.payload.0) {
            return Err(V3HubRelayRequestError::SideChannelLeaked { key });
        }
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
        profile: &V3HubServertoolRequestProfile,
    ) -> Result<V3HubRelayRequestOutcome, V3HubRelayRequestError> {
        self.run_from_normalized_with_events(normalized, profile, Vec::new())
    }

    fn run_from_normalized_with_events(
        &self,
        normalized: V3HubReqInbound02Normalized,
        profile: &V3HubServertoolRequestProfile,
        mut events: Vec<V3HubRelayRequestHookEvent>,
    ) -> Result<V3HubRelayRequestOutcome, V3HubRelayRequestError> {
        let mut normalized = normalized;
        events.push(V3HubRelayRequestHookEvent::Req04Entry);
        let current_payload_start = 0usize;
        if let Some(key) = find_v3_hub_side_channel_key(normalized.payload()) {
            return Err(V3HubRelayRequestError::SideChannelLeaked { key });
        }
        let memory_raw_capture_guidance_injected = normalized.memory_raw_capture_guidance_injected;
        if normalized.entry_protocol() == V3HubEntryProtocol::Responses
            && profile.memory_raw_capture_enabled()
            && !memory_raw_capture_guidance_injected
        {
            routecodex_v3_agent_memory::inject_memory_raw_capture_guidance(Arc::make_mut(
                &mut normalized.previous.payload.0,
            ))
            .map_err(|reason| {
                V3HubRelayRequestError::MemoryRawCaptureGuidanceInjectionFailed { reason }
            })?;
            normalized.memory_raw_capture_guidance_injected = true;
        }
        let (web_search_state, tool_thinking_turn_context) = govern_v3_servertool_request_at_req04(
            Arc::make_mut(&mut normalized.previous.payload.0),
            current_payload_start,
            &mut events,
            profile.web_search_execution_mode().is_some_and(
                routecodex_v3_config::V3WebSearchExecutionMode::is_metadata_center_local_search,
            ),
            profile.tool_thinking_enabled(),
        )?;
        if govern_protocol_tool_identity_at_req04(
            normalized.entry_protocol(),
            normalized.payload(),
        )? {
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
        run_servertool_profile(profile, &mut events)?;
        let governed = build_v3_hub_req_chat_process_04_from_v3_hub_req_inbound_02(normalized);
        events.push(V3HubRelayRequestHookEvent::Req04Exit);
        Ok(V3HubRelayRequestOutcome {
            governed,
            tool_output_count,
            events,
            web_search_state,
            tool_thinking_enabled: profile.tool_thinking_enabled(),
            tool_thinking_turn_context,
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
        V3HubEntryProtocol::Gemini => {
            let Some(contents) = payload.get("contents").and_then(Value::as_array) else {
                return Ok(false);
            };
            govern_gemini_tool_identity_at_req04(contents)?;
            Ok(true)
        }
        V3HubEntryProtocol::Responses | V3HubEntryProtocol::Anthropic => Ok(false),
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
                if !declared.insert(id.to_owned()) {
                    return Err(V3HubRelayRequestError::ProtocolToolIdentityInvalid {
                        protocol: "openai_chat",
                        index,
                        reason: "duplicate tool_calls.id",
                    });
                }
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

fn govern_gemini_tool_identity_at_req04(contents: &[Value]) -> Result<(), V3HubRelayRequestError> {
    let mut declared = BTreeSet::new();
    for (index, content) in contents.iter().enumerate() {
        let Some(parts) = content.get("parts").and_then(Value::as_array) else {
            continue;
        };
        for part in parts {
            if let Some(function_call) = part.get("functionCall") {
                let name = function_call
                    .get("name")
                    .and_then(Value::as_str)
                    .filter(|name| !name.is_empty())
                    .ok_or(V3HubRelayRequestError::ProtocolToolIdentityInvalid {
                        protocol: "gemini",
                        index,
                        reason: "functionCall.name is required",
                    })?;
                declared.insert(name.to_owned());
            }
            if let Some(function_response) = part.get("functionResponse") {
                let name = function_response
                    .get("name")
                    .and_then(Value::as_str)
                    .filter(|name| !name.is_empty())
                    .ok_or(V3HubRelayRequestError::ProtocolToolIdentityInvalid {
                        protocol: "gemini",
                        index,
                        reason: "functionResponse.name is required",
                    })?;
                if !declared.contains(name) {
                    return Err(V3HubRelayRequestError::ProtocolToolIdentityInvalid {
                        protocol: "gemini",
                        index,
                        reason: "orphan functionResponse.name",
                    });
                }
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
    let mut expected_outputs = BTreeMap::new();
    if let Some(messages) = payload.get("messages").and_then(Value::as_array) {
        for message in messages.iter().skip(current_payload_start) {
            if let Some(calls) = message.get("tool_calls").and_then(Value::as_array) {
                for call in calls {
                    if let Some((call_id, expected_kind)) =
                        expected_tool_call_output_from_chat_call(call)
                    {
                        expected_outputs.insert(call_id, expected_kind);
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
            expected_outputs.insert(call_id, expected_kind);
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
        if let Some(expected_kind) = expected_outputs.get(call_id) {
            if !expected_kind.matches_actual(actual_kind) {
                return Err(V3HubRelayRequestError::ToolOutputKindMismatch {
                    index,
                    call_id: call_id.to_owned(),
                });
            }
            if *expected_kind == V3HubRelayExpectedToolOutputKind::ApplyPatch {
                normalize_apply_patch_tool_output_item_at_req04(item);
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
    let mut expected_outputs = BTreeMap::new();
    let Some(messages) = payload.get_mut("messages").and_then(Value::as_array_mut) else {
        return Ok(0);
    };
    for message in messages.iter().skip(current_payload_start) {
        if let Some(calls) = message.get("tool_calls").and_then(Value::as_array) {
            for call in calls {
                if let Some((call_id, expected_kind)) =
                    expected_tool_call_output_from_chat_call(call)
                {
                    expected_outputs.insert(call_id, expected_kind);
                }
            }
        }
    }
    let mut output_count = 0usize;
    for (index, message) in messages.iter_mut().enumerate().skip(current_payload_start) {
        if message.get("role").and_then(Value::as_str) != Some("tool") {
            continue;
        }
        output_count = output_count.saturating_add(1);
        let call_id = message
            .get("tool_call_id")
            .or_else(|| message.get("call_id"))
            .or_else(|| message.get("id"))
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .ok_or(V3HubRelayRequestError::MalformedToolOutput { index })?;
        let expected_kind = expected_outputs.get(call_id).copied().ok_or_else(|| {
            V3HubRelayRequestError::OrphanToolOutput {
                index,
                call_id: call_id.to_owned(),
            }
        })?;
        let actual_kind = actual_chat_tool_output_kind(message);
        if !expected_kind.matches_actual(actual_kind) {
            return Err(V3HubRelayRequestError::ToolOutputKindMismatch {
                index,
                call_id: call_id.to_owned(),
            });
        }
        if expected_kind == V3HubRelayExpectedToolOutputKind::ApplyPatch {
            normalize_apply_patch_tool_output_item_at_req04(message);
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

fn normalize_apply_patch_tool_output_item_at_req04(item: &mut Value) {
    let Some(row) = item.as_object_mut() else {
        return;
    };
    for key in ["output", "content"] {
        let Some(Value::String(raw)) = row.get_mut(key) else {
            continue;
        };
        let normalized = normalize_apply_patch_output_text_at_req04(raw);
        if normalized != *raw {
            *raw = normalized;
        }
    }
}

fn normalize_apply_patch_output_text_at_req04(raw: &str) -> String {
    const APPLY_PATCH_ERROR_TEXT: &str = "APPLY_PATCH_ERROR: apply_patch did not apply. Retry with apply_patch only. Send one raw patch string in canonical *** Begin Patch / *** End Patch grammar. Use workspace-relative paths inside patch headers (for example *** Update File: src/main.ts or *** Add File: tmp/example.txt). Do not use absolute paths. Do not switch to exec_command or shell writes.";
    const APPLY_PATCH_RESULT_TEXT: &str = "APPLY_PATCH_RESULT: apply_patch applied. Continue future apply_patch calls with one raw patch string and workspace-relative paths inside patch headers. Keep using apply_patch for line edits instead of switching tools.";

    let text = raw.replace("\r\n", "\n").replace('\r', "\n");
    let trimmed = text.trim();
    if trimmed.starts_with("APPLY_PATCH_ERROR:") {
        return APPLY_PATCH_ERROR_TEXT.to_string();
    }

    if let Ok(Value::Object(row)) = trimmed.parse::<Value>() {
        let status = row
            .get("status")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim()
            .to_ascii_uppercase();
        if row.get("ok").and_then(Value::as_bool) == Some(true)
            || status == "APPLY_PATCH_APPLIED"
            || status == "APPLY_PATCH_RESULT"
        {
            return APPLY_PATCH_RESULT_TEXT.to_string();
        }
        if row.get("ok").and_then(Value::as_bool) == Some(false)
            || status == "APPLY_PATCH_FAILED"
            || status == "APPLY_PATCH_ERROR"
        {
            return APPLY_PATCH_ERROR_TEXT.to_string();
        }
    }

    let lowered = text.to_ascii_lowercase();
    if lowered.trim() == "aborted" {
        return APPLY_PATCH_ERROR_TEXT.to_string();
    }
    if matches!(lowered.trim(), "done" | "done!") {
        return APPLY_PATCH_RESULT_TEXT.to_string();
    }
    if !(lowered.contains("apply_patch") || lowered.contains("patch")) {
        return raw.to_string();
    }
    if lowered.contains("verification failed")
        || lowered.contains("invalid patch")
        || lowered.contains("missing")
        || lowered.contains("failed")
        || lowered.contains("error")
    {
        return APPLY_PATCH_ERROR_TEXT.to_string();
    }
    raw.to_string()
}

fn run_servertool_profile(
    profile: &V3HubServertoolRequestProfile,
    events: &mut Vec<V3HubRelayRequestHookEvent>,
) -> Result<(), V3HubRelayRequestError> {
    match profile {
        V3HubServertoolRequestProfile::Disabled => {
            events.push(V3HubRelayRequestHookEvent::ServertoolOptionalNoop);
            Ok(())
        }
        V3HubServertoolRequestProfile::Enabled { hook_ids, .. } => {
            for hook_id in hook_ids {
                if *hook_id != "servertool.request" {
                    return Err(V3HubRelayRequestError::UnknownStaticHook { hook_id });
                }
                events.push(V3HubRelayRequestHookEvent::Req04ServertoolGoverned);
            }
            Ok(())
        }
        V3HubServertoolRequestProfile::RequiredFailure(hook_id) => {
            Err(V3HubRelayRequestError::RequiredHookFailed { hook_id })
        }
    }
}
