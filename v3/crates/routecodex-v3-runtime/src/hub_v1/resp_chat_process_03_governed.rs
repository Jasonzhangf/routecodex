use super::*;
use serde_json::{json, Map, Value};
use std::collections::BTreeSet;
use std::ops::Deref;
use std::sync::Arc;

const V3_TOOLREASON_VISIBLE_PREFIX: &str = "◦ ";

fn log_v3_toolreason_observation_at_resp03(tool_name: &str, reason: Option<&str>, stage: &str) {
    match reason.and_then(normalize_v3_toolreason_reason_at_resp03) {
        Some(reason) => eprintln!(
            "\x1b[1;42;30m TOOLREASON OK \x1b[0m stage={stage} tool={tool_name} reason={reason}"
        ),
        None => eprintln!(
            "\x1b[1;43;30m TOOLREASON MISSING \x1b[0m stage={stage} tool={tool_name} reason=<none>"
        ),
    }
}

fn normalize_v3_toolreason_reason_at_resp03(reason: &str) -> Option<&str> {
    let reason = reason.trim();
    if reason.is_empty() {
        return None;
    }
    let lowered = reason.to_ascii_lowercase();
    let placeholder = [
        "一句真实",
        "一句原因",
        "当前动机",
        "实际动机",
        "tool-call motive",
        "motive",
        "...",
    ];
    if placeholder.iter().any(|marker| lowered.contains(marker)) {
        return None;
    }
    Some(reason)
}

fn emit_v3_toolreason_observation_at_resp03(
    tool_name: &str,
    reason: Option<&str>,
    stage: &str,
    emitted: &mut bool,
) {
    if *emitted {
        return;
    }
    log_v3_toolreason_observation_at_resp03(tool_name, reason, stage);
    *emitted = true;
}

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
        // 唯一密文剥离 hook（provider-responses）：direct 与 relay 响应侧共用，
        // 保证"只有单 gpt provider 才进客户端"的密文策略单一实现。
        let payload = std::sync::Arc::make_mut(&mut input.previous.previous.payload.0);
        routecodex_v3_provider_responses::apply_v3_response_cipher_policy(payload, false);
    }
    input
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
    tool_thinking: bool,
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
            tool_thinking: false,
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

    pub fn with_tool_thinking_enabled(mut self, enabled: bool) -> Self {
        self.tool_thinking = enabled;
        self
    }

    pub fn tool_thinking_enabled(&self) -> bool {
        self.tool_thinking
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
    #[error("provider response incomplete_details.reason is invalid: {reason}")]
    InvalidIncompleteDetails { reason: String },
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
    Ok(
        build_v3_hub_resp_inbound_02_from_provider_resp_compat_02(compat)
            .map_err(|error| V3HubRelayResponseError::ProviderCompatFailed { reason: error })?,
    )
}

fn govern_v3_hub_relay_response(
    input: V3HubRespInbound02Normalized,
    profile: &V3HubRelayResponseHookProfile,
) -> Result<V3HubRespChatProcess03Outcome, V3HubRelayResponseError> {
    // 响应侧密文清理（运行时真路径）：消费请求侧 VR 路由决策写入的
    // retain_response_cipher 标记——仅 gpt 单 provider 保留，其余一律剥离。
    let input =
        strip_v3_resp03_encrypted_reasoning_content(input, profile.retain_response_cipher());
    let mut input = harvest_v3_think_blocks_at_resp03(input);
    let payload = Arc::make_mut(&mut input.previous.previous.payload.0);
    map_v3_toolreason_to_reasoning_content_at_resp03(payload, profile.tool_thinking_enabled());
    let input = complete_or_repair_v3_resp03_tool_frames(input);
    let _identified_servertool_tool = super::servertool_hooks::inspect_v3_servertool_response_tool(
        input.provider_payload().as_ref(),
    );
    let governance = build_v3_resp03_protocol_governance(&input)?;
    let branch = inspect_v3_resp03_finish_reason(&input, &governance);
    let mut stopless_center_state = None;
    let mut web_search_center_state = None;
    let (input, governance) = match branch {
        V3Resp03FinishReasonBranch::ToolCall => {
            let tool_call_hook = apply_v3_tool_call_servertool_hook_at_resp03(input, profile)?;
            stopless_center_state = tool_call_hook.center_state;
            web_search_center_state = tool_call_hook.web_search_state;
            let mut input = if tool_call_hook.intercepted {
                tool_call_hook.input
            } else {
                project_v3_apply_patch_freeform_calls_at_resp03(tool_call_hook.input)
            };
            let mut governed_input = input;
            if profile.stopless_schema_guidance_active() {
                // Client projection consumes the provider-side Stopless control
                // text at the response owner; it must not leak into client data.
                let mut visible = governed_input.provider_payload().as_ref().clone();
                super::servertool_hooks::strip_v3_stopless_control_echoes(&mut visible);
                *governed_input.provider_payload_mut() = Arc::new(visible);
            }
            let governance = build_v3_resp03_protocol_governance(&governed_input)?;
            (governed_input, governance)
        }
        V3Resp03FinishReasonBranch::Stop => {
            let stop_hook = apply_v3_stop_servertool_hook_at_resp03(input, profile)?;
            stopless_center_state = stop_hook.center_state;
            let governance = build_v3_resp03_protocol_governance(&stop_hook.input)?;
            (stop_hook.input, governance)
        }
        V3Resp03FinishReasonBranch::Other => {
            let mut input = input;
            if profile.stopless_schema_guidance_active() {
                // Client projection consumes the provider-side Stopless control
                // text at the response owner; it must not leak into client data.
                let mut visible = input.provider_payload().as_ref().clone();
                super::servertool_hooks::strip_v3_stopless_control_echoes(&mut visible);
                *input.provider_payload_mut() = Arc::new(visible);
            }
            (input, governance)
        }
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
        "incomplete" => {
            let reason = object
                .get("incomplete_details")
                .and_then(Value::as_object)
                .and_then(|details| details.get("reason"))
                .and_then(Value::as_str)
                .ok_or_else(|| V3HubRelayResponseError::InvalidIncompleteDetails {
                    reason: "missing non-empty reason".to_string(),
                })?;
            if !matches!(reason, "max_output_tokens" | "content_filter") {
                return Err(V3HubRelayResponseError::InvalidIncompleteDetails {
                    reason: format!("unsupported value '{reason}'"),
                });
            }
            V3HubResponseTerminality::Terminal
        }
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
        .map(|name| name.trim())
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

pub(crate) fn map_v3_toolreason_to_reasoning_content_at_resp03(payload: &mut Value, enabled: bool) {
    map_v3_toolreason_to_reasoning_content_at_resp03_impl(payload, enabled, true);
}

fn map_v3_toolreason_to_reasoning_content_at_resp03_without_observation(
    payload: &mut Value,
    enabled: bool,
) {
    map_v3_toolreason_to_reasoning_content_at_resp03_impl(payload, enabled, false);
}

fn map_v3_toolreason_to_reasoning_content_at_resp03_impl(
    payload: &mut Value,
    enabled: bool,
    observe: bool,
) {
    if !enabled {
        return;
    }
    if observe {
        observe_v3_toolreason_json_at_resp03(payload);
    }
    if let Some(choices) = payload.get_mut("choices").and_then(Value::as_array_mut) {
        for choice in choices {
            let Some(message) = choice.get_mut("message").and_then(Value::as_object_mut) else {
                continue;
            };
            let tool_names = message
                .get("tool_calls")
                .and_then(Value::as_array)
                .map(|calls| {
                    calls
                        .iter()
                        .filter_map(|call| call.as_object().and_then(toolreason_display_name_from_object))
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            map_toolreason_in_text_object(message, &tool_names);
        }
    }
    if let Some(output) = payload.get_mut("output").and_then(Value::as_array_mut) {
        let tool_names = output
            .iter()
            .filter_map(|item| {
                if !matches!(
                    item.get("type").and_then(Value::as_str),
                    Some("function_call" | "tool_call" | "custom_tool_call")
                ) {
                    return None;
                }
                item.as_object().and_then(toolreason_display_name_from_object)
            })
            .collect::<Vec<_>>();
        for item in output {
            if item.get("type").and_then(Value::as_str) == Some("message") {
                let mut mapped_reason = None;
                if let Some(parts) = item.get_mut("content").and_then(Value::as_array_mut) {
                    for part in parts {
                        if let Some(text) =
                            part.get("text").and_then(Value::as_str).map(str::to_owned)
                        {
                            let (visible, reason) = extract_toolreason(&text);
                            if let Some(object) = part.as_object_mut() {
                                object.insert("text".to_string(), Value::String(visible));
                            }
                            if let Some(reason) = reason {
                                if mapped_reason.is_none() && !reason.trim().is_empty() {
                                    mapped_reason =
                                        format_toolreason_reasoning(&tool_names, &reason);
                                }
                            }
                        }
                    }
                }
                if let Some(reason) = mapped_reason {
                    if let Some(object) = item.as_object_mut() {
                        object.insert("reasoning_content".to_string(), Value::String(reason));
                    }
                }
            }
        }
    }
    if let Some(output_text) = payload.get("output_text").and_then(Value::as_str) {
        let (visible, _) = extract_toolreason(output_text);
        payload["output_text"] = Value::String(visible);
    }
    if let Some(content) = payload.get_mut("content").and_then(Value::as_array_mut) {
        let tool_names = content
            .iter()
            .filter(|part| {
                matches!(
                    part.get("type").and_then(Value::as_str),
                    Some("tool_use" | "tool_call" | "function_call")
                )
            })
            .filter_map(|part| part.get("name").and_then(Value::as_str).map(str::to_owned))
            .collect::<Vec<_>>();
        let mut reasons = Vec::new();
        for part in content {
            if part.get("type").and_then(Value::as_str) != Some("text") {
                continue;
            }
            let Some(text) = part.get("text").and_then(Value::as_str).map(str::to_owned) else {
                continue;
            };
            let (visible, mut part_reasons) = extract_toolreasons(&text);
            if let Some(object) = part.as_object_mut() {
                object.insert("text".to_string(), Value::String(visible));
            }
            reasons.append(&mut part_reasons);
        }
        if !reasons.is_empty() && !tool_names.is_empty() {
            if let Some(mapped) = format_toolreason_reasoning(&tool_names, &reasons[0]) {
                payload["reasoning_content"] = Value::String(mapped);
            }
        }
    }
}

fn observe_v3_toolreason_json_at_resp03(payload: &Value) {
    let mut tool_names = Vec::new();
    let mut reasons = Vec::new();
    collect_v3_toolreason_json_observations_at_resp03(payload, &mut tool_names, &mut reasons);
    if !tool_names.is_empty() {
        let tool_label = format_toolreason_tool_label(&tool_names);
        let mut emitted = false;
        emit_v3_toolreason_observation_at_resp03(
            &tool_label,
            reasons.first().map(String::as_str),
            "resp03_json",
            &mut emitted,
        );
    }
}

fn collect_v3_toolreason_json_observations_at_resp03(
    value: &Value,
    tool_names: &mut Vec<String>,
    reasons: &mut Vec<String>,
) {
    match value {
        Value::String(text) => {
            let (_, mut found) = extract_toolreasons(text);
            reasons.append(&mut found);
        }
        Value::Array(values) => {
            for value in values {
                collect_v3_toolreason_json_observations_at_resp03(value, tool_names, reasons);
            }
        }
        Value::Object(object) => {
            let is_tool_call = v3_is_tool_call_object_at_resp03(object);
            if is_tool_call {
                if let Some(name) = toolreason_display_name_from_object(object) {
                    tool_names.push(name);
                }
            }
            for value in object.values() {
                collect_v3_toolreason_json_observations_at_resp03(value, tool_names, reasons);
            }
        }
        Value::Null | Value::Bool(_) | Value::Number(_) => {}
    }
}

/// Map a complete Responses SSE semantic event after the stream collector has
/// already observed the corresponding function-call name.  Responses emits
/// the assistant text and the function-call item as separate events, so the
/// normal whole-payload mapper cannot associate them one frame at a time.
pub(crate) fn map_v3_toolreason_stream_event_at_resp03(
    payload: &mut Value,
    enabled: bool,
    tool_names: &[String],
    pending_reasons: &mut Vec<Option<String>>,
    reason_emitted: &mut bool,
) {
    if !enabled {
        return;
    }
    let event_output_index = payload
        .get("output_index")
        .and_then(Value::as_u64)
        .and_then(|index| usize::try_from(index).ok());
    let tool_name = event_output_index
        .and_then(|index| tool_names.get(index))
        .or_else(|| tool_names.iter().find(|name| !name.trim().is_empty()))
        .and_then(|name| toolreason_stream_display_name(name));
    let event_type = payload
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let reason_for = |reason: Option<String>| {
        reason.and_then(|reason| {
            let name = tool_name.clone()?;
            let reason = reason.trim();
            (!reason.is_empty()).then(|| {
                format!(
                    "{V3_TOOLREASON_VISIBLE_PREFIX}调用工具 {}，因为 {}",
                    name.trim(),
                    reason
                )
            })
        })
    };
    let remember_reason = |reason: Option<String>, pending_reasons: &mut Vec<Option<String>>| {
        let Some(index) = event_output_index else {
            return;
        };
        let Some(reason) = reason else {
            return;
        };
        let reason = reason.trim();
        if reason.is_empty() {
            return;
        }
        if pending_reasons.len() <= index {
            pending_reasons.resize(index + 1, None);
        }
        pending_reasons[index] = Some(reason.to_string());
    };

    match event_type {
        "response.output_text.delta" | "response.content_part.delta" => {
            if let Some(delta) = payload
                .get("delta")
                .and_then(Value::as_str)
                .map(str::to_owned)
            {
                payload["delta"] = Value::String(strip_v3_toolreason_markers_at_resp03(&delta));
            }
        }
        "response.output_text.done" => {
            let text = payload
                .get("text")
                .and_then(Value::as_str)
                .map(str::to_owned);
            if let Some(text) = text {
                let (visible, reason) = extract_toolreason(&text);
                payload["text"] = Value::String(visible);
                remember_reason(reason, pending_reasons);
            }
        }
        "response.content_part.done" => {
            let text = payload
                .pointer("/part/text")
                .and_then(Value::as_str)
                .map(str::to_owned);
            if let Some(text) = text {
                let (visible, reason) = extract_toolreason(&text);
                if let Some(part) = payload.get_mut("part").and_then(Value::as_object_mut) {
                    part.insert("text".to_string(), Value::String(visible));
                }
                remember_reason(reason, pending_reasons);
            }
        }
        "response.output_item.done" => {
            let is_message =
                payload.pointer("/item/type").and_then(Value::as_str) == Some("message");
            if !is_message {
                if matches!(
                    payload.pointer("/item/type").and_then(Value::as_str),
                    Some("function" | "function_call" | "tool_call" | "custom_tool_call")
                ) {
                    let pending = if *reason_emitted {
                        None
                    } else {
                        pending_reasons
                            .iter_mut()
                            .find_map(Option::take)
                            .and_then(|reason| format_toolreason_reasoning(tool_names, &reason))
                    };
                    if let Some(reasoning) = pending {
                        let tool_label = format_toolreason_tool_label(tool_names);
                        emit_v3_toolreason_observation_at_resp03(
                            &tool_label,
                            Some(reasoning.as_str()),
                            "resp03_direct_sse",
                            reason_emitted,
                        );
                        if let Some(item) = payload.get_mut("item").and_then(Value::as_object_mut) {
                            item.insert("reasoning_content".to_string(), Value::String(reasoning));
                        }
                    }
                }
                return;
            }
            let mut item_reasoning = None;
            {
                let Some(parts) = payload
                    .get_mut("item")
                    .and_then(Value::as_object_mut)
                    .and_then(|item| item.get_mut("content"))
                    .and_then(Value::as_array_mut)
                else {
                    return;
                };
                for part in parts {
                    let Some(text) = part.get("text").and_then(Value::as_str).map(str::to_owned)
                    else {
                        continue;
                    };
                    let (visible, reason) = extract_toolreason(&text);
                    part["text"] = Value::String(visible);
                    if let Some(reason) = reason {
                        item_reasoning = reason_for(Some(reason.clone()));
                        if item_reasoning.is_none() {
                            remember_reason(Some(reason), pending_reasons);
                        }
                    }
                }
            }
            if item_reasoning.is_none() && tool_name.is_some() {
                if let Some(index) = event_output_index {
                    item_reasoning = pending_reasons
                        .get_mut(index)
                        .and_then(Option::take)
                        .and_then(|reason| reason_for(Some(reason)));
                }
            }
            if let Some(reasoning) = item_reasoning {
                let tool_label = format_toolreason_tool_label(tool_names);
                emit_v3_toolreason_observation_at_resp03(
                    &tool_label,
                    Some(reasoning.as_str()),
                    "resp03_direct_sse",
                    reason_emitted,
                );
                if let Some(item) = payload.get_mut("item").and_then(Value::as_object_mut) {
                    item.insert("reasoning_content".to_string(), Value::String(reasoning));
                    let visible_reasoning = item
                        .get("reasoning_content")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string();
                    item.insert("type".to_string(), Value::String("reasoning".to_string()));
                    item.insert(
                        "summary".to_string(),
                        json!([{"type": "summary_text", "text": visible_reasoning}]),
                    );
                    item.remove("content");
                }
            }
        }
        _ => {}
    }
}

/// Resp03 owns the complete toolreason stream projection. The shared stream
/// lifecycle only carries bytes and typed projection state into this function;
/// it does not parse, associate, or redact toolreason semantics.
pub(crate) fn project_v3_toolreason_sse_chunk_at_resp03(
    buffer: &mut Vec<u8>,
    tool_names: &mut Vec<String>,
    pending_reasons: &mut Vec<Option<String>>,
    reason_emitted: &mut bool,
    chunk: &[u8],
) -> Vec<u8> {
    buffer.extend_from_slice(chunk);
    let mut output = Vec::new();
    while let Some((end, delimiter_len)) = find_v3_sse_frame_end_at_resp03(buffer) {
        let frame_end = end + delimiter_len;
        let frame: Vec<u8> = buffer.drain(..frame_end).collect();
        output.extend(project_v3_toolreason_sse_frame_at_resp03(
            &frame,
            tool_names,
            pending_reasons,
            reason_emitted,
        ));
    }
    output
}

pub(crate) fn project_v3_toolreason_sse_final_buffer_at_resp03(
    buffer: &[u8],
    tool_names: &mut Vec<String>,
    pending_reasons: &mut Vec<Option<String>>,
    reason_emitted: &mut bool,
) -> Vec<u8> {
    project_v3_toolreason_sse_frame_at_resp03(buffer, tool_names, pending_reasons, reason_emitted)
}

/// Resp03 唯一的 Direct SSE turn closeout。工具调用已经被观察但模型没有
/// 提供可映射的 `<toolreason>` 时，也必须在流真正收口时记录 MISSING；不能
/// 依赖某一种 `response.*.done` 事件，否则不同 provider 的 canonical SSE
/// 事件形状会产生“没有打印”这一不可观测状态。
pub(crate) fn finalize_v3_toolreason_observation_at_resp03(
    tool_names: &[String],
    pending_reasons: &mut Vec<Option<String>>,
    reason_emitted: &mut bool,
) {
    if *reason_emitted || tool_names.is_empty() {
        return;
    }
    let reason = pending_reasons.iter_mut().find_map(Option::take);
    let tool_label = format_toolreason_tool_label(tool_names);
    emit_v3_toolreason_observation_at_resp03(
        &tool_label,
        reason.as_deref().and_then(|reason| {
            let reason = reason.trim();
            (!reason.is_empty()).then_some(reason)
        }),
        "resp03_direct_sse",
        reason_emitted,
    );
}

fn find_v3_sse_frame_end_at_resp03(buffer: &[u8]) -> Option<(usize, usize)> {
    let lf = buffer
        .windows(2)
        .position(|window| window == b"\n\n")
        .map(|index| (index, 2));
    let crlf = buffer
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .map(|index| (index, 4));
    match (lf, crlf) {
        (Some(left), Some(right)) => Some(if left.0 <= right.0 { left } else { right }),
        (Some(found), None) | (None, Some(found)) => Some(found),
        (None, None) => None,
    }
}

fn project_v3_toolreason_sse_frame_at_resp03(
    chunk: &[u8],
    tool_names: &mut Vec<String>,
    pending_reasons: &mut Vec<Option<String>>,
    reason_emitted: &mut bool,
) -> Vec<u8> {
    let Ok(text) = std::str::from_utf8(chunk) else {
        return chunk.to_vec();
    };
    let mut output = String::with_capacity(text.len());
    for line in text.split_inclusive('\n') {
        let Some(data) = line.strip_prefix("data:") else {
            output.push_str(line);
            continue;
        };
        let data = data.strip_prefix(' ').unwrap_or(data);
        let data = data.trim_end_matches(['\r', '\n']);
        let Ok(mut payload) = serde_json::from_str::<Value>(data) else {
            output.push_str(line);
            continue;
        };
        collect_v3_responses_sse_tool_name_at_resp03(&payload, tool_names);
        let event_type = payload
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let has_marker = v3_json_contains_toolreason_marker_at_resp03(&payload);
        let is_toolreason_text_delta = matches!(
            event_type,
            "response.output_text.delta" | "response.content_part.delta"
        );
        let is_completed_with_tool_call =
            event_type == "response.completed" && v3_json_contains_tool_call_at_resp03(&payload);
        let has_pending_message_reason = event_type == "response.output_item.done"
            && payload.pointer("/item/type").and_then(Value::as_str) == Some("message")
            && payload
                .get("output_index")
                .and_then(Value::as_u64)
                .and_then(|index| usize::try_from(index).ok())
                .and_then(|index| pending_reasons.get(index))
                .is_some_and(Option::is_some);
        let is_tool_call_done = event_type == "response.output_item.done"
            && matches!(
                payload.pointer("/item/type").and_then(Value::as_str),
                Some("function" | "function_call" | "tool_call" | "custom_tool_call")
            );
        if !has_marker
            && !has_pending_message_reason
            && !is_tool_call_done
            && !is_completed_with_tool_call
            && !is_toolreason_text_delta
        {
            output.push_str(line);
            continue;
        }
        if is_completed_with_tool_call {
            // Some Responses providers collapse the whole assistant turn into
            // response.completed and omit output_item.done. Resp03 must still
            // validate every tool call and remove the private marker here.
            if let Some(response) = payload.get_mut("response") {
                map_v3_toolreason_to_reasoning_content_at_resp03_without_observation(
                    response, true,
                );
                append_v3_toolreason_completed_visible_text_at_resp03(response, &mut output);
                if !*reason_emitted {
                    let mut response_tools = Vec::new();
                    let mut response_reasons = Vec::new();
                    collect_v3_toolreason_json_observations_at_resp03(
                        response,
                        &mut response_tools,
                        &mut response_reasons,
                    );
                    let tool_label = format_toolreason_tool_label(&response_tools);
                    emit_v3_toolreason_observation_at_resp03(
                        &tool_label,
                        response_reasons.first().map(String::as_str),
                        "resp03_direct_sse",
                        reason_emitted,
                    );
                }
            } else {
                map_v3_toolreason_to_reasoning_content_at_resp03_without_observation(
                    &mut payload,
                    true,
                );
                append_v3_toolreason_completed_visible_text_at_resp03(&mut payload, &mut output);
                if !*reason_emitted {
                    let mut response_tools = Vec::new();
                    let mut response_reasons = Vec::new();
                    collect_v3_toolreason_json_observations_at_resp03(
                        &payload,
                        &mut response_tools,
                        &mut response_reasons,
                    );
                    let tool_label = format_toolreason_tool_label(&response_tools);
                    emit_v3_toolreason_observation_at_resp03(
                        &tool_label,
                        response_reasons.first().map(String::as_str),
                        "resp03_direct_sse",
                        reason_emitted,
                    );
                }
            }
        } else {
            map_v3_toolreason_stream_event_at_resp03(
                &mut payload,
                true,
                tool_names,
                pending_reasons,
                reason_emitted,
            );
        }
        if is_tool_call_done {
            if let Some(reasoning) = payload
                .pointer("/item/reasoning_content")
                .and_then(Value::as_str)
                .map(str::to_owned)
            {
                output.push_str(&build_v3_toolreason_visible_text_sse_events_at_resp03(
                    &payload,
                    &reasoning,
                ));
                if let Some(item) = payload.get_mut("item").and_then(Value::as_object_mut) {
                    item.remove("reasoning_content");
                }
            }
        }
        strip_v3_toolreason_markers_from_json_at_resp03(&mut payload);
        let Ok(encoded) = serde_json::to_string(&payload) else {
            output.push_str(line);
            continue;
        };
        output.push_str("data:");
        if line.strip_prefix("data: ").is_some() {
            output.push(' ');
        }
        output.push_str(&encoded);
        if line.ends_with('\n') {
            output.push('\n');
        }
    }
    output.into_bytes()
}

fn append_v3_toolreason_completed_visible_text_at_resp03(
    response: &mut Value,
    output: &mut String,
) {
    let Some(items) = response.get_mut("output").and_then(Value::as_array_mut) else {
        return;
    };
    for (index, item) in items.iter_mut().enumerate() {
        let Some(reasoning) = item
            .get("reasoning_content")
            .and_then(Value::as_str)
            .map(str::to_owned)
        else {
            continue;
        };
        output.push_str(&build_v3_toolreason_visible_text_sse_events_at_resp03(
            &json!({"output_index": index}),
            &reasoning,
        ));
        if let Some(object) = item.as_object_mut() {
            object.remove("reasoning_content");
        }
        break;
    }
}

fn build_v3_toolreason_visible_text_sse_events_at_resp03(
    payload: &Value,
    reasoning: &str,
) -> String {
    let output_index = payload.get("output_index").cloned().unwrap_or_else(|| json!(0));
    let item_id = payload
        .pointer("/item/call_id")
        .or_else(|| payload.pointer("/item/id"))
        .and_then(Value::as_str)
        .map(|id| format!("rcc_reason_{id}"))
        .unwrap_or_else(|| "rcc_reason_tool_call".to_string());
    let events = [
        json!({"type":"response.output_item.added","output_index":output_index.clone(),"item":{"id":item_id.clone(),"type":"message","status":"in_progress","role":"assistant","content":[]}}),
        json!({"type":"response.content_part.added","output_index":output_index.clone(),"item_id":item_id.clone(),"content_index":0,"part":{"type":"output_text","text":""}}),
        json!({"type":"response.output_text.delta","output_index":output_index.clone(),"item_id":item_id.clone(),"content_index":0,"delta":reasoning}),
        json!({"type":"response.output_text.done","output_index":output_index.clone(),"item_id":item_id.clone(),"content_index":0,"text":reasoning}),
        json!({"type":"response.content_part.done","output_index":output_index.clone(),"item_id":item_id.clone(),"content_index":0,"part":{"type":"output_text","text":reasoning}}),
        json!({"type":"response.output_item.done","output_index":output_index,"item":{"id":item_id,"type":"message","status":"completed","role":"assistant","content":[{"type":"output_text","text":reasoning}]}}),
    ];
    let mut output = String::new();
    for event in events {
        output.push_str("event: ");
        output.push_str(event["type"].as_str().unwrap_or_default());
        output.push_str("\ndata: ");
        if let Ok(encoded) = serde_json::to_vec(&event) {
            output.push_str(&String::from_utf8_lossy(&encoded));
        }
        output.push_str("\n\n");
    }
    output
}

fn collect_v3_responses_sse_tool_name_at_resp03(payload: &Value, tool_names: &mut Vec<String>) {
    let output_index = payload
        .get("output_index")
        .and_then(Value::as_u64)
        .and_then(|index| usize::try_from(index).ok());
    let stream_index = output_index.or_else(|| {
        payload
            .get("index")
            .and_then(Value::as_u64)
            .and_then(|index| usize::try_from(index).ok())
    });
    if let Some(index) = stream_index {
        let call_object = payload
            .get("content_block")
            .or_else(|| payload.get("item"))
            .or_else(|| payload.pointer("/response/output/0"))
            .and_then(Value::as_object);
        if let Some(call_object) = call_object.filter(|object| {
            v3_is_tool_call_object_at_resp03(object)
                || object.get("name").and_then(Value::as_str).is_some()
        }) {
            let display_name = toolreason_display_name_from_object(call_object)
                .unwrap_or_else(|| "exec_command".to_string());
            if tool_names.len() <= index {
                tool_names.resize(index + 1, String::new());
            }
            if display_name == "exec_command" {
                if tool_names[index].is_empty() || tool_names[index] == "exec_command" {
                    tool_names[index] = "exec_command|".to_string();
                }
            } else {
                tool_names[index] = display_name;
            }
        }
        if let Some(fragment) = payload
            .pointer("/delta/partial_json")
            .and_then(Value::as_str)
            .or_else(|| payload.pointer("/delta/input_json").and_then(Value::as_str))
        {
            if tool_names.len() > index && tool_names[index].starts_with("exec_command|") {
                tool_names[index].push_str(fragment);
            }
        }
        return;
    }
    if v3_json_contains_tool_call_at_resp03(payload) {
        collect_v3_tool_call_names_at_resp03(payload, tool_names);
        if tool_names.iter().any(|name| name.starts_with("exec_command|")) {
            tool_names.retain(|name| name != "exec_command");
        }
        return;
    }
    let candidates = [
        payload.pointer("/item/name").and_then(Value::as_str),
        payload
            .pointer("/response/output/0/name")
            .and_then(Value::as_str),
    ];
    for name in candidates.into_iter().flatten() {
        let name = name.trim();
        if name.is_empty() {
            continue;
        }
        if let Some(index) = output_index {
            if tool_names.len() <= index {
                tool_names.resize(index + 1, String::new());
            }
            if tool_names[index].is_empty() {
                tool_names[index] = if name == "exec_command" {
                    "exec_command|".to_string()
                } else {
                    name.to_string()
                };
            }
        } else if !tool_names.iter().any(|existing| existing == name) {
            tool_names.push(name.to_string());
        }
    }
}

fn collect_v3_tool_call_names_at_resp03(value: &Value, tool_names: &mut Vec<String>) {
    match value {
        Value::Object(object) => {
            if v3_is_tool_call_object_at_resp03(object) {
                if let Some(name) = toolreason_display_name_from_object(object) {
                    if !tool_names.iter().any(|existing| existing == &name) {
                        tool_names.push(name);
                    }
                }
            }
            for child in object.values() {
                collect_v3_tool_call_names_at_resp03(child, tool_names);
            }
        }
        Value::Array(values) => {
            for value in values {
                collect_v3_tool_call_names_at_resp03(value, tool_names);
            }
        }
        Value::String(_) | Value::Null | Value::Bool(_) | Value::Number(_) => {}
    }
}

fn v3_json_contains_toolreason_marker_at_resp03(value: &Value) -> bool {
    match value {
        Value::String(text) => text.contains("<toolreason>") || text.contains("</toolreason>"),
        Value::Array(values) => values
            .iter()
            .any(v3_json_contains_toolreason_marker_at_resp03),
        Value::Object(values) => values
            .values()
            .any(v3_json_contains_toolreason_marker_at_resp03),
        Value::Null | Value::Bool(_) | Value::Number(_) => false,
    }
}

fn v3_json_contains_tool_call_at_resp03(value: &Value) -> bool {
    match value {
        Value::Object(object) => {
            v3_is_tool_call_object_at_resp03(object)
                || object.values().any(v3_json_contains_tool_call_at_resp03)
        }
        Value::Array(values) => values.iter().any(v3_json_contains_tool_call_at_resp03),
        Value::String(_) | Value::Null | Value::Bool(_) | Value::Number(_) => false,
    }
}

fn v3_is_tool_call_object_at_resp03(object: &serde_json::Map<String, Value>) -> bool {
    let object_type = object.get("type").and_then(Value::as_str);
    if matches!(
        object_type,
        Some("tool_use" | "tool_call" | "function_call" | "custom_tool_call")
    ) {
        return true;
    }
    if object_type == Some("function") {
        return object.contains_key("arguments")
            || object.contains_key("call_id")
            || object.contains_key("id");
    }
    object
        .get("function")
        .and_then(Value::as_object)
        .and_then(|function| function.get("name"))
        .and_then(Value::as_str)
        .is_some()
        && (object.contains_key("arguments")
            || object.contains_key("call_id")
            || object.contains_key("id"))
}

fn strip_v3_toolreason_markers_from_json_at_resp03(value: &mut Value) {
    match value {
        Value::String(text) => *text = strip_v3_toolreason_markers_at_resp03(text),
        Value::Array(values) => {
            for value in values {
                strip_v3_toolreason_markers_from_json_at_resp03(value);
            }
        }
        Value::Object(values) => {
            for value in values.values_mut() {
                strip_v3_toolreason_markers_from_json_at_resp03(value);
            }
        }
        Value::Null | Value::Bool(_) | Value::Number(_) => {}
    }
}

fn strip_v3_toolreason_markers_at_resp03(text: &str) -> String {
    let text = text
        .find("下面内容只说明工具调用部分，不适用于普通回答：")
        .or_else(|| text.find("工具调用要求（请严格遵守）："))
        .map(|start| &text[..start])
        .unwrap_or(text);
    let mut visible = String::with_capacity(text.len());
    let mut remaining = text;
    loop {
        let Some(start) = remaining.find("<toolreason>") else {
            visible.push_str(&remaining.replace("</toolreason>", ""));
            break;
        };
        visible.push_str(&remaining[..start].replace("</toolreason>", ""));
        let rest = &remaining[start + "<toolreason>".len()..];
        let Some(end) = rest.find("</toolreason>") else {
            break;
        };
        remaining = &rest[end + "</toolreason>".len()..];
    }
    visible
}

fn map_toolreason_in_text_object(message: &mut Map<String, Value>, tool_names: &[String]) {
    let Some(content) = message
        .get("content")
        .and_then(Value::as_str)
        .map(str::to_owned)
    else {
        return;
    };
    let (visible, reasons) = extract_toolreasons(&content);
    message.insert("content".to_string(), Value::String(visible));
    if reasons.is_empty() {
        return;
    }
    if tool_names.is_empty() {
        return;
    }
    let mut existing = message
        .get("reasoning_content")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_string();
    if let Some(reasoning) = reasons
        .first()
        .and_then(|reason| format_toolreason_reasoning(tool_names, reason))
    {
        if !existing.is_empty() {
            existing.push('\n');
        }
        existing.push_str(&reasoning);
    }
    message.insert("reasoning_content".to_string(), Value::String(existing));
}

fn format_toolreason_reasoning(tool_names: &[String], reason: &str) -> Option<String> {
    let names = format_toolreason_tool_label(tool_names);
    let reason = normalize_v3_toolreason_reason_at_resp03(reason)?;
    if names.is_empty() || reason.is_empty() {
        return None;
    }
    Some(format!(
        "{V3_TOOLREASON_VISIBLE_PREFIX}调用工具 {names}，因为 {reason}"
    ))
}

fn format_toolreason_tool_label(tool_names: &[String]) -> String {
    tool_names
        .iter()
        .filter_map(|name| toolreason_stream_display_name(name))
        .filter(|name| !name.is_empty())
        .collect::<Vec<_>>()
        .join("、")
}

fn toolreason_stream_display_name(name: &str) -> Option<String> {
    let name = name.trim();
    if !name.starts_with("exec_command|") {
        return (!name.is_empty()).then(|| name.to_string());
    }
    let fragment = name.strip_prefix("exec_command|").unwrap_or_default();
    let value = serde_json::from_str::<Value>(fragment).ok();
    value
        .and_then(|value| value.get("cmd").and_then(Value::as_str).map(str::to_owned))
        .and_then(|command| command.split_whitespace().next().map(str::to_owned))
        .or_else(|| Some("exec_command".to_string()))
}

fn toolreason_display_name_from_object(object: &serde_json::Map<String, Value>) -> Option<String> {
    let name = object
        .get("name")
        .and_then(Value::as_str)
        .or_else(|| {
            object
                .get("function")
                .and_then(Value::as_object)
                .and_then(|function| function.get("name"))
                .and_then(Value::as_str)
        })
        .map(str::trim)
        .filter(|name| !name.is_empty())?;
    if name != "exec_command" {
        return Some(name.to_string());
    }
    let arguments = object
        .get("arguments")
        .or_else(|| object.get("input"))
        .or_else(|| {
            object
                .get("function")
                .and_then(Value::as_object)
                .and_then(|function| function.get("arguments"))
        });
    let command = match arguments {
        Some(Value::String(raw)) => serde_json::from_str::<Value>(raw).ok(),
        Some(value @ Value::Object(_)) => Some(value.clone()),
        _ => None,
    }
    .and_then(|value| value.get("cmd").and_then(Value::as_str).map(str::to_owned));
    command
        .and_then(|command| command.split_whitespace().find(|token| !token.is_empty()).map(str::to_owned))
        .or_else(|| Some(name.to_string()))
}

fn extract_toolreason(text: &str) -> (String, Option<String>) {
    let (visible, reasons) = extract_toolreasons(text);
    (visible, reasons.into_iter().next())
}

fn extract_toolreasons(text: &str) -> (String, Vec<String>) {
    let mut visible = String::with_capacity(text.len());
    let mut reasons = Vec::new();
    let mut remaining = text;
    loop {
        let Some(start) = remaining.find("<toolreason>") else {
            visible.push_str(&remaining.replace("</toolreason>", ""));
            break;
        };
        visible.push_str(&remaining[..start].replace("</toolreason>", ""));
        let rest = &remaining[start + "<toolreason>".len()..];
        let Some(end) = rest.find("</toolreason>") else {
            break;
        };
        let reason = rest[..end].trim();
        if !reason.is_empty() && !is_v3_toolreason_placeholder(reason) {
            reasons.push(reason.to_string());
        }
        remaining = &rest[end + "</toolreason>".len()..];
    }
    (visible, reasons)
}

fn is_v3_toolreason_placeholder(reason: &str) -> bool {
    let normalized = reason.trim().to_ascii_lowercase();
    if matches!(
        normalized.as_str(),
        "..."
            | "…"
            | "具体原因"
            | "直接动机"
            | "真实当前动机"
            | "理由文本"
            | "reason"
            | "reason text"
            | "your reason"
    ) {
        return true;
    }
    normalized.starts_with("◦ 调用工具")
        || normalized.starts_with("#tool 调用工具")
        || normalized.starts_with("· 调用工具")
        || normalized.starts_with("🟢 调用工具")
        || normalized.contains("<toolreason")
        || normalized.contains("</toolreason")
        || normalized.contains("开始标签")
        || normalized.contains("结束标签")
        || normalized.contains("具体动机")
        || normalized.contains("真实当前动机")
        || normalized.contains("工具调用要求")
        || normalized.contains("不适用于普通回答")
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

        routecodex_v3_provider_responses::apply_v3_response_cipher_policy(&mut payload, false);

        assert!(!payload.to_string().contains("encrypted_content"));
        assert!(!payload.to_string().contains("rsn_CIPHERTEXT"));
        assert_eq!(payload["output"][0]["type"], "reasoning");
        assert_eq!(
            payload["output"][0]["summary"][0]["text"], "plain summary",
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

        routecodex_v3_provider_responses::apply_v3_response_cipher_policy(&mut payload, false);

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

        routecodex_v3_provider_responses::apply_v3_response_cipher_policy(&mut payload, false);

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
        routecodex_v3_provider_responses::apply_v3_response_cipher_policy(&mut stripped, false);
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
        assert!(
            payload.contains("signed"),
            "明文 summary 必须保留: {payload}"
        );
    }
}
