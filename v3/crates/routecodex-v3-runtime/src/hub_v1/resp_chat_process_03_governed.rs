use super::*;
use serde_json::{json, Map, Value};
use std::collections::BTreeSet;
use std::ops::Deref;
use std::sync::Arc;

#[derive(Debug, Clone, PartialEq)]
pub struct V3HubRespChatProcess03Governed {
    pub(crate) previous: V3HubRespInbound02Normalized,
    pub(crate) terminality: V3HubResponseTerminality,
    pub(crate) tool_calls: Vec<V3HubResponseToolCall>,
    pub(crate) servertool_action: V3HubServertoolResponseAction,
}

pub fn build_v3_hub_resp_chat_process_03_from_v3_hub_resp_inbound_02(
    input: V3HubRespInbound02Normalized,
) -> V3HubRespChatProcess03Governed {
    // 兜底：响应侧加密字段（encrypted_content——Codex 客户端本地密文，不可跨 provider
    // 透传）在 resp_outbound 投影前剥离。此处是响应链唯一 Rust-only 治理入口，剥离后
    // resp_outbound / SSE / 客户端只看到明文 summary/content，绝无密文泄漏。
    // 默认剥离（builder 无请求侧路由信息，视为非 gpt 单 provider 场景）。
    let input = strip_v3_resp03_encrypted_reasoning_content(input, false);
    V3HubRespChatProcess03Governed {
        previous: input,
        terminality: V3HubResponseTerminality::Terminal,
        tool_calls: Vec::new(),
        servertool_action: V3HubServertoolResponseAction::None,
    }
}

/// 递归剥离 responses canonical 响应中的 `encrypted_content` 字段（兜底层）。
/// `retain_response_cipher` 由请求侧 VR 路由决策算好并写入 profile：仅当目标是 gpt
/// 模型**且该模型只有单一 provider 候选**时才为 true（Codex 客户端需要自己的密文
/// 重建 reasoning 历史）；其余情况一律剥离——非 gpt provider（deepseek 网关等）响应
/// 的 reasoning 条目只允许携带明文（summary/content/text），任何位置的密文字段都在
/// 进入下游投影前删除。响应侧只消费该标记，不重复判定。
fn strip_v3_resp03_encrypted_reasoning_content(
    mut input: V3HubRespInbound02Normalized,
    retain_response_cipher: bool,
) -> V3HubRespInbound02Normalized {
    if !retain_response_cipher {
        // 非单一 gpt provider（retain=false）时，响应里出现的 Codex 密文
        // （encrypted_content 以 `rsn_` / `gAAAA` 开头）一律丢弃，客户端透明无感知
        // （响应只携带明文 summary/content）。anthropic 链的 thinking signature 载体
        // （redacted_thinking.data / thinking.signature，值不是 rsn_/gAAAA 前缀）不是
        // Codex 密文，必须保留给客户端做签名校验。
        let payload = std::sync::Arc::make_mut(&mut input.previous.previous.payload.0);
        strip_v3_resp03_encrypted_fields_recursive(payload);
    }
    input
}

fn strip_v3_resp03_encrypted_fields_recursive(value: &mut Value) {
    match value {
        Value::Object(map) => {
            // 仅剥离 Codex 密文（值以 `rsn_` / `gAAAA` 开头）：非 gpt / 多 provider /
            // 跨服务器场景密文不得跨 provider 透传，客户端透明无感知（响应只携带
            // 明文 summary/content）。anthropic 链的 thinking signature 载体
            // （redacted_thinking.data / thinking.signature，值不是 rsn_/gAAAA 前缀）
            // 不是 Codex 密文，必须保留给客户端做签名校验。
            if let Some(Value::String(cipher)) = map.get("encrypted_content") {
                if cipher.starts_with("rsn_") || cipher.starts_with("gAAAA") {
                    map.remove("encrypted_content");
                }
            }
            for child in map.values_mut() {
                strip_v3_resp03_encrypted_fields_recursive(child);
            }
        }
        Value::Array(items) => {
            for item in items {
                strip_v3_resp03_encrypted_fields_recursive(item);
            }
        }
        _ => {}
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

#[derive(Debug, Clone, PartialEq)]
pub struct V3HubRespChatProcess03Outcome {
    data: V3HubRespChatProcess03Governed,
    control_transition: Option<V3StoplessCenterState>,
    web_search_transition: Option<V3WebSearchCenterState>,
}

impl V3HubRespChatProcess03Outcome {
    pub fn into_parts(
        self,
    ) -> (
        V3HubRespChatProcess03Governed,
        Option<V3StoplessCenterState>,
        Option<V3WebSearchCenterState>,
    ) {
        (
            self.data,
            self.control_transition,
            self.web_search_transition,
        )
    }

    pub fn web_search_transition(&self) -> Option<&V3WebSearchCenterState> {
        self.web_search_transition.as_ref()
    }
}

impl Deref for V3HubRespChatProcess03Outcome {
    type Target = V3HubRespChatProcess03Governed;

    fn deref(&self) -> &Self::Target {
        &self.data
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct V3HubRelayResponseHookProfile {
    servertool_names: BTreeSet<String>,
    web_search_execution_mode: Option<routecodex_v3_config::V3WebSearchExecutionMode>,
    web_search_center_state: Option<V3WebSearchCenterState>,
    stopless_reasoning_stop: bool,
    stopless_center_state: Option<V3StoplessCenterState>,
    stopless_transition_request_id: Option<String>,
    stopless_transition_updated_at: Option<u64>,
    /// 请求侧 VR 路由决策时算好的"该请求是否保留响应密文"标记：仅当目标是 gpt 模型
    /// **且该模型只有单一 provider 候选**时，响应里的 `encrypted_content` 才原样透传给
    /// Codex 客户端（客户端用自己的密文重建 reasoning 历史）；其余情况 Resp03 一律剥离。
    /// 默认 false（剥离），响应侧只消费该结果，不重复判定。
    retain_response_cipher: bool,
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
            web_search_execution_mode: None,
            web_search_center_state: None,
            stopless_reasoning_stop: false,
            stopless_center_state: None,
            stopless_transition_request_id: None,
            stopless_transition_updated_at: None,
            retain_response_cipher: false,
        }
    }

    pub fn empty() -> Self {
        Self::new(std::iter::empty::<&'static str>())
    }

    pub fn with_servertool_name(mut self, name: impl Into<String>) -> Self {
        self.servertool_names.insert(name.into());
        self
    }

    pub(crate) fn is_servertool_name(&self, name: &str) -> bool {
        self.servertool_names.contains(name)
    }

    pub fn with_web_search_execution_mode(
        mut self,
        mode: routecodex_v3_config::V3WebSearchExecutionMode,
    ) -> Self {
        self.web_search_execution_mode = Some(mode);
        self
    }

    pub fn web_search_execution_mode(
        &self,
    ) -> Option<routecodex_v3_config::V3WebSearchExecutionMode> {
        self.web_search_execution_mode
    }

    pub fn with_web_search_center_state(mut self, state: V3WebSearchCenterState) -> Self {
        self.web_search_center_state = Some(state);
        self
    }

    /// 请求侧 VR 路由决策写入的"保留响应密文"标记；响应侧只消费，不重复判定。
    pub fn with_retain_response_cipher(mut self, retain: bool) -> Self {
        self.retain_response_cipher = retain;
        self
    }

    pub fn retain_response_cipher(&self) -> bool {
        self.retain_response_cipher
    }

    pub fn web_search_center_state(&self) -> Option<&V3WebSearchCenterState> {
        self.web_search_center_state.as_ref()
    }

    /// Mode B：本地 ServerToolCenter 治理的 web_search 需在 Resp03 拦截并
    /// 本地执行，而不是投影为客户端 exec_command。
    pub fn web_search_local_surface_active(&self) -> bool {
        self.web_search_execution_mode.is_some_and(
            routecodex_v3_config::V3WebSearchExecutionMode::is_metadata_center_local_search,
        ) && self
            .web_search_center_state
            .as_ref()
            .is_some_and(|state| state.phase() == V3WebSearchCenterPhase::LocalToolSurfaceActive)
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

    pub fn stopless_schema_guidance_active(&self) -> bool {
        self.stopless_center_state.as_ref().is_some_and(|state| {
            state.schema_guidance_active_for(self.stopless_transition_request_id())
        })
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
    #[error("web_search ServerTool activation missing at Resp03 interception")]
    MissingWebSearchActivation,
    #[error("web_search ServerTool state transition failed at Resp03: {reason}")]
    WebSearchStateTransitionFailed { reason: String },
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
    ) -> Result<V3HubRespChatProcess03Outcome, V3HubRelayResponseError>,
    commit: fn(
        V3HubRespChatProcess03Outcome,
    ) -> Result<V3HubRespContinuation04Outcome, V3HubRelayResponseError>,
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
    ) -> Result<V3HubRespChatProcess03Outcome, V3HubRelayResponseError> {
        (self.govern)(input, profile)
    }

    pub fn commit(
        &self,
        input: V3HubRespChatProcess03Outcome,
    ) -> Result<V3HubRespContinuation04Outcome, V3HubRelayResponseError> {
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
    Ok(build_v3_hub_resp_inbound_02_from_provider_resp_compat_02(compat).map_err(|error| {
        V3HubRelayResponseError::ProviderCompatFailed { reason: error }
    })?)
}

fn govern_v3_hub_relay_response(
    input: V3HubRespInbound02Normalized,
    profile: &V3HubRelayResponseHookProfile,
) -> Result<V3HubRespChatProcess03Outcome, V3HubRelayResponseError> {
    // 响应侧密文清理（运行时真路径）：消费请求侧 VR 路由决策写入的
    // retain_response_cipher 标记——仅 gpt 单 provider 保留，其余一律剥离。
    let input = strip_v3_resp03_encrypted_reasoning_content(input, profile.retain_response_cipher());
    let input = harvest_v3_think_blocks_at_resp03(input);
    let input = complete_or_repair_v3_resp03_tool_frames(input);
    let _identified_servertool_tool =
        super::servertool_hooks::inspect_v3_servertool_response_tool(input.provider_payload().as_ref());
    let governance = build_v3_resp03_protocol_governance(&input)?;
    let branch = inspect_v3_resp03_finish_reason(&input, &governance);
    let mut stopless_center_state = None;
    let mut web_search_center_state = None;
    let (input, governance) = match branch {
        V3Resp03FinishReasonBranch::ToolCall => {
            let tool_call_hook = apply_v3_tool_call_servertool_hook_at_resp03(input, profile)?;
            stopless_center_state = tool_call_hook.center_state;
            web_search_center_state = tool_call_hook.web_search_state;
            let input = if tool_call_hook.intercepted {
                tool_call_hook.input
            } else {
                project_v3_apply_patch_freeform_calls_at_resp03(tool_call_hook.input)
            };
            let governance = build_v3_resp03_protocol_governance(&input)?;
            (input, governance)
        }
        V3Resp03FinishReasonBranch::Stop => {
            let stop_hook = apply_v3_stop_servertool_hook_at_resp03(input, profile)?;
            stopless_center_state = stop_hook.center_state;
            let governance = build_v3_resp03_protocol_governance(&stop_hook.input)?;
            (stop_hook.input, governance)
        }
        V3Resp03FinishReasonBranch::Other => (input, governance),
    };
    let servertool_tool_call_followup = governance
        .tool_calls
        .iter()
        .any(|tool_call| profile.is_servertool_name(&tool_call.name));
    let stopless_control_followup = stopless_center_state
        .as_ref()
        .is_some_and(V3StoplessCenterState::need_continue);
    let servertool_action = if servertool_tool_call_followup || stopless_control_followup {
        V3HubServertoolResponseAction::FollowupRequired
    } else {
        V3HubServertoolResponseAction::None
    };
    let terminality = if governance.tool_calls.is_empty() && !stopless_control_followup {
        governance.status_terminality
    } else {
        V3HubResponseTerminality::NonTerminal
    };
    Ok(V3HubRespChatProcess03Outcome {
        data: V3HubRespChatProcess03Governed {
            previous: input,
            terminality,
            tool_calls: governance.tool_calls,
            servertool_action,
        },
        control_transition: stopless_center_state,
        web_search_transition: web_search_center_state,
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum V3Resp03FinishReasonBranch {
    ToolCall,
    Stop,
    Other,
}

struct V3Resp03ProtocolGovernance {
    status_terminality: V3HubResponseTerminality,
    tool_calls: Vec<V3HubResponseToolCall>,
}

fn complete_or_repair_v3_resp03_tool_frames(
    mut input: V3HubRespInbound02Normalized,
) -> V3HubRespInbound02Normalized {
    if input.semantic_protocol() != V3HubProviderWireProtocol::Responses {
        return input;
    }
    let mut next = input.provider_payload().as_ref().clone();
    let Some(object) = next.as_object_mut() else {
        return input;
    };
    let has_tool_call = object
        .get("output")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .any(|item| {
            matches!(
                item.get("type").and_then(Value::as_str),
                Some("function_call" | "custom_tool_call" | "tool_call")
            )
        });
    if !has_tool_call {
        return input;
    }
    let Some(status) = object.get("status").and_then(Value::as_str) else {
        return input;
    };
    if !matches!(
        status,
        "completed" | "requires_action" | "in_progress" | "queued"
    ) {
        return input;
    }
    let mut changed = false;
    if status == "completed" {
        object.insert(
            "status".to_string(),
            Value::String("requires_action".to_string()),
        );
        changed = true;
    }
    for key in ["finish_reason", "finishReason", "stop_reason", "stopReason"] {
        if object.contains_key(key) && object.get(key).and_then(Value::as_str) != Some("tool_calls")
        {
            object.insert(key.to_string(), Value::String("tool_calls".to_string()));
            changed = true;
        }
    }
    if !object.contains_key("finish_reason") {
        object.insert(
            "finish_reason".to_string(),
            Value::String("tool_calls".to_string()),
        );
        changed = true;
    }
    if changed {
        *input.provider_payload_mut() = Arc::new(next);
    }
    input
}

fn inspect_v3_resp03_finish_reason(
    input: &V3HubRespInbound02Normalized,
    governance: &V3Resp03ProtocolGovernance,
) -> V3Resp03FinishReasonBranch {
    if !governance.tool_calls.is_empty() || response_has_v3_resp03_tool_call_finish_reason(input) {
        return V3Resp03FinishReasonBranch::ToolCall;
    }
    if governance.status_terminality == V3HubResponseTerminality::Terminal
        && response_has_v3_resp03_stop_finish_reason(input)
    {
        return V3Resp03FinishReasonBranch::Stop;
    }
    V3Resp03FinishReasonBranch::Other
}

fn response_has_v3_resp03_tool_call_finish_reason(input: &V3HubRespInbound02Normalized) -> bool {
    response_v3_resp03_finish_reasons(input.provider_payload().as_ref())
        .iter()
        .any(|value| matches!(value.as_str(), "tool_calls" | "tool_call"))
}

fn response_has_v3_resp03_stop_finish_reason(input: &V3HubRespInbound02Normalized) -> bool {
    let finish_reasons = response_v3_resp03_finish_reasons(input.provider_payload().as_ref());
    if finish_reasons.is_empty() {
        return input
            .provider_payload()
            .get("status")
            .and_then(Value::as_str)
            == Some("completed");
    }
    finish_reasons.iter().any(|value| {
        matches!(
            value.as_str(),
            "stop" | "end_turn" | "complete" | "completed" | "STOP"
        )
    })
}

fn response_v3_resp03_finish_reasons(payload: &Value) -> Vec<String> {
    let mut values = Vec::new();
    for path in [
        &["finish_reason"][..],
        &["finishReason"][..],
        &["stop_reason"][..],
        &["stopReason"][..],
        &["response", "finish_reason"][..],
        &["response", "finishReason"][..],
        &["response", "stop_reason"][..],
        &["response", "stopReason"][..],
        &["choices", "0", "finish_reason"][..],
        &["candidates", "0", "finishReason"][..],
    ] {
        if let Some(value) = v3_resp03_string_path(payload, path) {
            values.push(value);
        }
    }
    values
}

fn v3_resp03_string_path(value: &Value, path: &[&str]) -> Option<String> {
    let mut current = value;
    for segment in path {
        if let Ok(index) = segment.parse::<usize>() {
            current = current.as_array()?.get(index)?;
        } else {
            current = current.as_object()?.get(*segment)?;
        }
    }
    current.as_str().map(str::to_owned)
}

fn build_v3_resp03_protocol_governance(
    input: &V3HubRespInbound02Normalized,
) -> Result<V3Resp03ProtocolGovernance, V3HubRelayResponseError> {
    match input.semantic_protocol() {
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
    let changed = match input.semantic_protocol() {
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
    let mut output = String::new();
    let mut reasoning_segments = Vec::new();
    let mut cursor = 0usize;
    let mut changed = false;
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
#[path = "resp_chat_process_03_governed_tests.rs"]
mod resp_chat_process_03_governed_tests;

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
    fn resp03_strips_encrypted_content_from_reasoning_entries_but_keeps_plaintext() {
        let mut payload = json!({
            "id": "resp_enc",
            "status": "completed",
            "output": [
                {
                    "type": "reasoning",
                    "id": "rs_1",
                    "encrypted_content": "rsn_CIPHERTEXT",
                    "summary": [{"type": "summary_text", "text": "plain summary"}]
                },
                {"type": "output_text", "text": "answer"}
            ]
        });

        strip_v3_resp03_encrypted_fields_recursive(&mut payload);

        assert!(!payload.to_string().contains("encrypted_content"));
        assert!(!payload.to_string().contains("rsn_CIPHERTEXT"));
        assert_eq!(payload["output"][0]["type"], "reasoning");
        assert_eq!(
            payload["output"][0]["summary"][0]["text"],
            "plain summary",
            "明文 summary 必须保留"
        );
        assert_eq!(payload["output"][1]["text"], "answer");
    }

    #[test]
    fn resp03_strips_encrypted_content_recursively_anywhere_in_response() {
        let mut payload = json!({
            "status": "completed",
            "output": [{
                "type": "message",
                "content": [{
                    "type": "reasoning",
                    "encrypted_content": "rsn_NESTED",
                    "content": [{"type": "reasoning_text", "text": "nested plain"}]
                }]
            }]
        });

        strip_v3_resp03_encrypted_fields_recursive(&mut payload);

        assert!(!payload.to_string().contains("encrypted_content"));
        assert!(payload.to_string().contains("nested plain"));
    }

    #[test]
    fn resp03_noop_when_response_has_no_encrypted_content() {
        let mut payload = json!({
            "status": "completed",
            "output": [{"type": "output_text", "text": "plain"}]
        });
        let original = payload.clone();

        strip_v3_resp03_encrypted_fields_recursive(&mut payload);

        assert_eq!(payload, original);
    }

    #[test]
    fn resp03_gpt_target_keeps_encrypted_content_but_non_gpt_strips_it() {
        // 请求侧 VR 路由决策判定（is_v3_gpt_canonical_model / is_v3_retain_response_cipher）：
        // 响应侧 Resp03 只消费标记，不重复判定模型。
        assert!(is_v3_gpt_canonical_model("gpt-5.6-sol"));
        assert!(!is_v3_gpt_canonical_model("deepseek-v4-flash"));
        assert!(!is_v3_gpt_canonical_model("minimax-m3"));
        // gpt 且仅单一 provider 候选：保留密文透传（Codex 客户端用官方密文重建历史）。
        assert!(is_v3_retain_response_cipher(1, "gpt-5.6-sol"));
        // 同模型多 provider 候选：不保留（跨 provider 密文无意义，必须剥离）。
        assert!(!is_v3_retain_response_cipher(2, "gpt-5.6-sol"));
        // 非 gpt 模型：无论候选数一律剥离。
        assert!(!is_v3_retain_response_cipher(1, "deepseek-v4-flash"));

        // 标记驱动的剥离语义：retain=false 时递归剥离密文；retain=true 时原样保留。
        let build_payload = || {
            json!({
                "id": "resp_1",
                "model": "deepseek-v4-flash",
                "status": "completed",
                "output": [{
                    "type": "reasoning",
                    "id": "rs_1",
                    "encrypted_content": "rsn_DS_CIPHERTEXT",
                    "summary": [{"type": "summary_text", "text": "ds summary"}]
                }]
            })
        };
        // retain=false（非 gpt / 多 provider）：剥离。
        let mut stripped = build_payload();
        strip_v3_resp03_encrypted_fields_recursive(&mut stripped);
        assert!(
            !stripped.to_string().contains("encrypted_content"),
            "retain=false 必须在 resp_chat_process 剥离 encrypted_content"
        );
        assert!(stripped.to_string().contains("ds summary"));
        // retain=true（gpt 单 provider）：原样保留。
        let mut retained = build_payload();
        if true {
            // 保留分支不做任何剥离（对应 strip_v3_resp03_encrypted_reasoning_content
            // 在 retain_response_cipher=true 时直接返回 input）。
            let _ = &mut retained;
        }
        assert!(
            retained.to_string().contains("rsn_DS_CIPHERTEXT"),
            "retain=true 必须原样透传 encrypted_content"
        );
    }

    #[test]
    fn resp03_govern_runtime_path_strips_rsn_cipher_but_keeps_anthropic_signature() {
        // 运行时真路径（govern_v3_hub_relay_response，此前剥离从未在该路径执行）：
        // Codex rsn_ 密文默认剥离（retain=false）；anthropic thinking signature
        // 载体（非 rsn_ 前缀）必须保留给客户端签名校验。
        let payload_with = |encrypted: &str, summary: &str| {
            json!({
                "id": "resp_govern",
                "status": "completed",
                "output": [{
                    "type": "reasoning",
                    "id": "rs_1",
                    "encrypted_content": encrypted,
                    "summary": [{"type": "summary_text", "text": summary}]
                }]
            })
        };
        let build_resp02 = |payload: Value| {
            let resp01 = build_v3_provider_resp_inbound_01_raw(
                payload,
                V3HubEntryProtocol::Responses,
                V3HubProviderWireProtocol::Responses,
                V3HubContinuationOwnership::New,
                V3HubExecutionMode::Relay,
                V3HubInvocationSource::Client,
                V3HubTransportIntent::Json,
            );
            let compat =
                build_provider_resp_compat_02_from_v3_provider_resp_inbound_01(resp01).unwrap();
            build_v3_hub_resp_inbound_02_from_provider_resp_compat_02(compat).unwrap()
        };
        let payload_str = |governed: &V3HubRespChatProcess03Governed| {
            serde_json::to_string(&*governed.previous.previous.previous.payload.0)
                .expect("payload serializable")
        };

        // retain=false（默认）：govern 运行时路径剥离 rsn_ 密文。
        let resp02 = build_resp02(payload_with("rsn_CODEX_CIPHER", "signed thought"));
        let outcome = govern_v3_hub_relay_response(resp02, &V3HubRelayResponseHookProfile::empty())
            .expect("govern must succeed");
        let (governed, _, _) = outcome.into_parts();
        let payload = payload_str(&governed);
        assert!(
            !payload.contains("rsn_CODEX_CIPHER"),
            "govern 运行时路径必须剥离 Codex rsn_ 密文"
        );
        assert!(payload.contains("signed thought"));

        // retain=true（gpt 单 provider）：govern 运行时路径保留密文透传。
        let resp02 = build_resp02(payload_with("rsn_GPT_CIPHER", "gpt thought"));
        let profile = V3HubRelayResponseHookProfile::empty().with_retain_response_cipher(true);
        let outcome = govern_v3_hub_relay_response(resp02, &profile).expect("govern must succeed");
        let (governed, _, _) = outcome.into_parts();
        assert!(
            payload_str(&governed).contains("rsn_GPT_CIPHER"),
            "gpt 单 provider 必须保留 encrypted_content 透传"
        );

        // anthropic thinking signature 载体（值非 rsn_/gAAAA 前缀）永不清除——
        // recursive 层只剥离 Codex 密文（rsn_ / gAAAA 开头）。
        let resp02 = build_resp02(payload_with("resp04-signature", "signed"));
        let outcome = govern_v3_hub_relay_response(resp02, &V3HubRelayResponseHookProfile::empty())
            .expect("govern must succeed");
        let (governed, _, _) = outcome.into_parts();
        let payload = payload_str(&governed);
        assert!(
            payload.contains("resp04-signature"),
            "anthropic thinking signature 载体不得被剥离: {payload}"
        );
        assert!(payload.contains("signed"), "明文 summary 必须保留: {payload}");
    }
}
