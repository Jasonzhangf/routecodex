use super::*;
use crate::provider_action_gate::V3ProviderActionPermit;
use crate::provider_failure_runtime_policy::{
    v3_relay_provider_policy_now_epoch_ms, V3ProviderFailureRuntimeHealth,
    V3RelayProviderFailureRetryPolicy,
};
use routecodex_v3_config::{V3Config05ManifestPublished, V3WebSearchExecutionMode};
use routecodex_v3_error::{
    build_v3_error_01_source_raised, V3ErrorSourceKind, V3ProviderFailureSessionScope,
};
use routecodex_v3_provider_responses::{
    build_v3_provider_12_responses_wire_payload, ReqwestResponsesTransport, ResponsesTransport,
    V3ProviderError, V3ProviderSseStream, V3ProviderRequestHeader, V3ResponsesProviderTarget,
    V3Transport13ResponsesHttpRequest,
};
use serde_json::{json, Value};
use std::collections::VecDeque;
use std::pin::Pin;

pub type V3OpenAiChatClientStream =
    Pin<Box<dyn futures_util::Stream<Item = Result<Vec<u8>, String>> + Send>>;

pub enum V3OpenAiChatRelayClientBody {
    Json(Value),
    Sse(V3OpenAiChatClientStream),
}

impl V3OpenAiChatRelayClientBody {
    pub fn is_sse(&self) -> bool {
        matches!(self, Self::Sse(_))
    }
}

impl From<String> for V3OpenAiChatRelayRuntimeError {
    fn from(value: String) -> Self {
        Self::Target(value)
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct V3OpenAiChatRelayRuntimeInput {
    pub server_id: String,
    pub failure_session_scope: V3ProviderFailureSessionScope,
    pub request_id: String,
    pub payload: Value,
}

pub struct V3OpenAiChatRelayRuntimeOutput {
    pub status: u16,
    pub client_body: V3OpenAiChatRelayClientBody,
    pub node_trace: Vec<&'static str>,
    pub error_chain: Option<Vec<&'static str>>,
}

impl std::fmt::Debug for V3OpenAiChatRelayRuntimeOutput {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("V3OpenAiChatRelayRuntimeOutput")
            .field("status", &self.status)
            .field(
                "client_body",
                &match self.client_body {
                    V3OpenAiChatRelayClientBody::Json(_) => "json",
                    V3OpenAiChatRelayClientBody::Sse(_) => "sse",
                },
            )
            .field("node_trace", &self.node_trace)
            .field("error_chain", &self.error_chain)
            .finish()
    }
}

#[derive(Debug, thiserror::Error)]
pub enum V3OpenAiChatRelayRuntimeError {
    #[error(transparent)]
    Request(#[from] V3HubRelayRequestError),
    #[error(transparent)]
    Response(#[from] V3HubRelayResponseError),
    #[error(transparent)]
    Codec(#[from] V3OpenAiChatCodecError),
    #[error("V3 Hub static hook registry failed: {0}")]
    StaticRegistry(String),
    #[error("V3 OpenAI Chat target resolution failed: {0}")]
    Target(String),
    #[error("V3 OpenAI Chat requested direct provider model not found: {0}")]
    ModelNotFound(String),
    #[error("V3 OpenAI Chat provider contract failed: {0}")]
    Provider(#[from] V3ProviderError),
    #[error("V3 OpenAI Chat provider compat failed: {0}")]
    ProviderCompat(#[from] V3ProviderCompatError),
    #[error("V3 OpenAI Chat JSON provider body is malformed: {0}")]
    ProviderJson(#[from] serde_json::Error),
    #[error("V3 OpenAI Chat structured SSE projection failed: {0}")]
    StructuredSse(String),
    #[error(
        "V3 OpenAI Chat web_search Mode B intercepted a websearch call but the chat-entry response \
         has no result projection path yet; refusing silent strip"
    )]
    WebSearchInterceptedUnprojected,
}

pub async fn execute_v3_openai_chat_relay_runtime_with_default_transport(
    manifest: &V3Config05ManifestPublished,
    input: V3OpenAiChatRelayRuntimeInput,
) -> Result<V3OpenAiChatRelayRuntimeOutput, V3OpenAiChatRelayRuntimeError> {
    execute_v3_openai_chat_relay_runtime(manifest, input, &ReqwestResponsesTransport::default())
        .await
}

pub async fn execute_v3_openai_chat_relay_runtime_with_default_transport_provider_health(
    manifest: &V3Config05ManifestPublished,
    input: V3OpenAiChatRelayRuntimeInput,
    provider_health: V3ProviderFailureRuntimeHealth,
) -> Result<V3OpenAiChatRelayRuntimeOutput, V3OpenAiChatRelayRuntimeError> {
    execute_v3_openai_chat_relay_runtime_with_provider_health(
        manifest,
        input,
        &ReqwestResponsesTransport::default(),
        provider_health,
    )
    .await
}

pub async fn execute_v3_openai_chat_relay_runtime<T: ResponsesTransport>(
    manifest: &V3Config05ManifestPublished,
    input: V3OpenAiChatRelayRuntimeInput,
    transport: &T,
) -> Result<V3OpenAiChatRelayRuntimeOutput, V3OpenAiChatRelayRuntimeError> {
    execute_v3_openai_chat_relay_runtime_with_provider_health(
        manifest,
        input,
        transport,
        V3ProviderFailureRuntimeHealth::from_manifest(manifest),
    )
    .await
}

pub async fn execute_v3_openai_chat_relay_runtime_with_provider_health<T: ResponsesTransport>(
    manifest: &V3Config05ManifestPublished,
    input: V3OpenAiChatRelayRuntimeInput,
    transport: &T,
    provider_health: V3ProviderFailureRuntimeHealth,
) -> Result<V3OpenAiChatRelayRuntimeOutput, V3OpenAiChatRelayRuntimeError> {
    execute_v3_openai_chat_relay_runtime_inner(
        manifest,
        input,
        transport,
        provider_health,
        V3RelayProviderFailureRetryPolicy::from_manifest(manifest),
    )
    .await
}

async fn execute_v3_openai_chat_relay_runtime_inner<T: ResponsesTransport>(
    manifest: &V3Config05ManifestPublished,
    input: V3OpenAiChatRelayRuntimeInput,
    transport: &T,
    provider_health: V3ProviderFailureRuntimeHealth,
    retry_policy: V3RelayProviderFailureRetryPolicy,
) -> Result<V3OpenAiChatRelayRuntimeOutput, V3OpenAiChatRelayRuntimeError> {
    // 统一 relay 主循环骨架（大骨架）：生命周期与编排在 execute_v3_relay_runtime_core，
    // 协议差异收敛在 V3OpenAiChatRelayCodec。
    let routing_group = server_routing_group(manifest, &input.server_id)
        .map_err(|error| V3OpenAiChatRelayRuntimeError::Target(error.to_string()))?
        .to_string();
    let continuation_lookup = V3HubContinuationLookup::new(
        None,
        V3HubContinuationScope::new(
            V3HubEntryProtocol::OpenAiChat,
            &input.server_id,
            routing_group,
            &input.request_id,
        ),
    );
    execute_v3_relay_runtime_core::<V3OpenAiChatRelayCodec, T>(
        manifest,
        &input.server_id,
        input.failure_session_scope.clone(),
        &input.request_id,
        "/v1/chat/completions",
        input.payload,
        transport,
        provider_health,
        retry_policy,
        continuation_lookup,
        Vec::new(),
    )
    .await
    .map_err(|error| match error {
        V3RelayCoreError::ModelNotFound(message) => {
            V3OpenAiChatRelayRuntimeError::ModelNotFound(message)
        }
        // 治理层拦截（Mode B web-search）必须保留原变体：fail-fast 投影语义
        // 由 server 端 `project_v3_openai_chat_relay_runtime_failure` 区分。
        V3RelayCoreError::WebSearchIntercepted(_) => {
            V3OpenAiChatRelayRuntimeError::WebSearchInterceptedUnprojected
        }
        // 直接取内部消息，不叠加 V3RelayCoreError 的 Display 前缀（与原实现消息一致）。
        V3RelayCoreError::Target(message)
        | V3RelayCoreError::StaticRegistry(message)
        | V3RelayCoreError::EndpointPath(message) => {
            V3OpenAiChatRelayRuntimeError::Target(message)
        }
    })
}

pub fn project_v3_openai_chat_relay_runtime_failure(
    error: V3OpenAiChatRelayRuntimeError,
) -> V3OpenAiChatRelayRuntimeOutput {
    let display = error.to_string();
    let source = match error {
        V3OpenAiChatRelayRuntimeError::ModelNotFound(message) => build_v3_error_01_source_raised(
            V3ErrorSourceKind::ModelNotFound,
            "V3Target10ConcreteProviderSelected",
            "direct_model_not_found",
            message,
        ),
        error => build_v3_error_01_source_raised(
            V3ErrorSourceKind::RuntimeFailure,
            "V3HubRuntime",
            "openai_chat_relay_runtime_error",
            error.to_string(),
        ),
    };
    error_output(source, 500, "none", Vec::new())
}

fn project_json_response(
    provider_value: Value,
    provider_protocol: V3HubProviderWireProtocol,
    chat_request: &Value,
    transport_intent: V3HubTransportIntent,
    trace: &mut Vec<&'static str>,
    compatibility_profile: Option<&str>,
    web_search_execution_mode: routecodex_v3_config::V3WebSearchExecutionMode,
    web_search_center_state: Option<&V3WebSearchCenterState>,
    retain_response_cipher: bool,
) -> Result<Value, V3OpenAiChatRelayRuntimeError> {
    // SSE 流式帧 / JSON 兜底：候选 Mode B 时，payload 内出现**本地** websearch
    // function tool call 必须 fail-fast（禁止静默透传——内部工具无客户端投影）。
    // hosted `web_search`（anthropic wire server tool，本入口出站已投影为
    // web_search_20250305）不拦截：透传为 chat tool_calls 由客户端（opencode/
    // reasonix）执行搜索并回传结果（标准 OpenAI 工具调用协议）。
    if web_search_execution_mode.is_metadata_center_local_search() {
        if let Some(call) = first_local_websearch_tool_call(&provider_value)? {
            if call.name.eq_ignore_ascii_case("websearch") {
                return Err(V3OpenAiChatRelayRuntimeError::WebSearchInterceptedUnprojected);
            }
        }
    }
    match provider_protocol {
        V3HubProviderWireProtocol::OpenAiChat => {
            validate_v3_openai_chat_provider_response_payload(
                &provider_value,
                provider_protocol,
                transport_intent,
            )?;
        }
        V3HubProviderWireProtocol::Anthropic => {
            validate_v3_anthropic_provider_response_payload(
                &provider_value,
                provider_protocol,
                transport_intent,
            )
            .map_err(|error| V3OpenAiChatRelayRuntimeError::Target(error.to_string()))?;
        }
        V3HubProviderWireProtocol::Responses => {
            // Responses JSON 是 Hub canonical 形状：后续走 resp02 canonical
            // 与 project_v3_openai_chat_client_response_from_canonical 投影；
            // 这里只做对象形状校验（fail-fast，不静默跳过）。
            if provider_value.as_object().is_none()
                || (provider_value.get("output").is_none()
                    && provider_value.get("status").is_none()
                    && provider_value.get("error").is_none())
            {
                return Err(V3OpenAiChatRelayRuntimeError::Target(format!(
                    "OpenAI Chat relay Responses provider JSON must be an object with output/status/error: {}",
                    serde_json::to_string(&provider_value).unwrap_or_default()
                )));
            }
        }
        unsupported => {
            return Err(V3OpenAiChatRelayRuntimeError::Target(format!(
                "OpenAI Chat relay response codec has no registered provider protocol: {unsupported:?}"
            )));
        }
    }
    let resp01 = build_v3_provider_resp_inbound_01_raw_with_compat_profile(
        provider_value,
        V3ProviderRespInbound01RawContext::new(
            V3HubEntryProtocol::OpenAiChat,
            provider_protocol,
            V3HubContinuationOwnership::New,
            V3HubExecutionMode::Relay,
            V3HubInvocationSource::Client,
            transport_intent,
        )
        .with_compatibility_profile(compatibility_profile),
    );
    trace.push("V3ProviderRespInbound01Raw");
    let compat = build_provider_resp_compat_02_from_v3_provider_resp_inbound_01(resp01)?;
    trace.push("ProviderRespCompat02ProviderCompat");
    let resp02 = build_v3_hub_resp_inbound_02_from_provider_resp_compat_02_with_chat_request(
        compat,
        Some(chat_request),
    )
    .map_err(V3OpenAiChatRelayRuntimeError::Target)?;
    trace.push("V3HubRespInbound02Normalized");
    let hooks = compile_v3_hub_relay_response_hooks();
    let mut response_profile = V3HubRelayResponseHookProfile::empty()
        .with_web_search_execution_mode(web_search_execution_mode)
        .with_retain_response_cipher(retain_response_cipher);
    if let Some(state) = web_search_center_state {
        response_profile = response_profile.with_web_search_center_state(state.clone());
    }
    let resp03 = hooks.govern(resp02, &response_profile)?;
    trace.push("V3HubRespChatProcess03Governed");
    let resp04 = hooks.commit(resp03)?;
    trace.push("V3HubRespContinuation04Committed");
    // Mode B 拦截后必须同轮投影：websearch call 已剥离，若 transition 存在
    // 说明 Resp03 拦截了搜索调用但当前 Chat 入口尚无结果投影路径——禁止
    // 静默剥离（fail-fast），由后续响应侧 hop/投影工程补全。
    if resp04.web_search_transition().is_some() {
        return Err(V3OpenAiChatRelayRuntimeError::WebSearchInterceptedUnprojected);
    }
    let resp04 = resp04.into_data();
    let client_payload = if resp04
        .finalized_payload()
        .get("output")
        .and_then(Value::as_array)
        .is_some()
    {
        project_v3_openai_chat_client_response_from_canonical(resp04.finalized_payload())
            .map_err(V3OpenAiChatRelayRuntimeError::Target)?
    } else {
        resp04.finalized_payload().clone()
    };
    let resp05 = build_v3_hub_resp_outbound_05_from_v3_hub_resp_continuation_04_with_client_payload(
        resp04,
        client_payload,
    );
    trace.push("V3HubRespOutbound05ClientSemantic");
    let client = resp05.client_payload().clone();
    let _resp06 = build_v3_server_resp_outbound_06_from_v3_hub_resp_outbound_05(resp05);
    trace.push("V3ServerRespOutbound06ClientFrame");
    Ok(client)
}

struct V3OpenAiChatSseState {
    provider: routecodex_v3_provider_responses::V3ProviderSseStream,
    decoder: routecodex_v3_sse::SseIncrementalDecoder,
    pending: VecDeque<Result<Vec<u8>, String>>,
    terminal: bool,
    seen_done: bool,
    done: bool,
    compatibility_profile: Option<String>,
    web_search_execution_mode: routecodex_v3_config::V3WebSearchExecutionMode,
    web_search_center_state: Option<V3WebSearchCenterState>,
    /// 请求侧 VR 路由决策算好的"保留响应密文"标记，SSE 帧级 Resp03 消费。
    retain_response_cipher: bool,
    provider_outcome: V3OpenAiChatSseProviderOutcome,
}

pub(crate) struct V3OpenAiChatSseProviderOutcome {
    provider_health: V3ProviderFailureRuntimeHealth,
    failure_session_scope: V3ProviderFailureSessionScope,
    provider_id: String,
    auth_alias: String,
    model_id: String,
    recorded: bool,
    _provider_action_permit: Option<V3ProviderActionPermit>,
}

impl V3OpenAiChatSseProviderOutcome {
    async fn record_failure(&mut self, reason: &str) -> Result<(), String> {
        if self.recorded {
            return Ok(());
        }
        drop(self._provider_action_permit.take());
        self.provider_health
            .record_post_commit_provider_stream_failure(
                &self.failure_session_scope,
                &self.provider_id,
                Some(&self.auth_alias),
                Some(&self.model_id),
                "provider_response_protocol",
                reason,
            )?;
        self.recorded = true;
        Ok(())
    }

    fn record_success(&mut self) -> Result<(), String> {
        if self.recorded {
            return Ok(());
        }
        self.provider_health
            .record_provider_success_in_failure_scope(
                &self.failure_session_scope,
                &self.provider_id,
                Some(&self.auth_alias),
                Some(&self.model_id),
                v3_relay_provider_policy_now_epoch_ms()?,
            )?;
        self.recorded = true;
        Ok(())
    }
}

fn project_sse_stream(
    provider: routecodex_v3_provider_responses::V3ProviderSseStream,
    compatibility_profile: Option<String>,
    web_search_execution_mode: routecodex_v3_config::V3WebSearchExecutionMode,
    web_search_center_state: Option<V3WebSearchCenterState>,
    retain_response_cipher: bool,
    provider_outcome: V3OpenAiChatSseProviderOutcome,
) -> V3OpenAiChatClientStream {
    use futures_util::StreamExt;
    let state = V3OpenAiChatSseState {
        provider,
        decoder: routecodex_v3_sse::SseIncrementalDecoder::new(
            routecodex_v3_sse::SseTransportLimits::default(),
        ),
        pending: VecDeque::new(),
        terminal: false,
        seen_done: false,
        done: false,
        compatibility_profile,
        web_search_execution_mode,
        web_search_center_state,
        retain_response_cipher,
        provider_outcome,
    };
    Box::pin(futures_util::stream::unfold(
        state,
        |mut state| async move {
            loop {
                if let Some(item) = state.pending.pop_front() {
                    return Some((item, state));
                }
                if state.done {
                    return None;
                }
                let Some(chunk) = state.provider.next().await else {
                    state.done = true;
                    let decoder = std::mem::replace(
                        &mut state.decoder,
                        routecodex_v3_sse::SseIncrementalDecoder::new(
                            routecodex_v3_sse::SseTransportLimits::default(),
                        ),
                    );
                    if let Err(error) = decoder.finish() {
                        let error = error.to_string();
                        let result = state
                            .provider_outcome
                            .record_failure(&error)
                            .await
                            .map(|()| error)
                            .and_then(Err);
                        return Some((result, state));
                    }
                    if !state.terminal {
                        let error =
                            "OpenAI Chat SSE ended without terminal finish_reason".to_string();
                        let result = state
                            .provider_outcome
                            .record_failure(&error)
                            .await
                            .map(|()| error)
                            .and_then(Err);
                        return Some((result, state));
                    }
                    // provider 可在 [DONE] 前关闭流；客户端协议仍必须收到终止帧。
                    if !state.seen_done {
                        state.seen_done = true;
                        state.pending.push_back(Ok(b"data: [DONE]\n\n".to_vec()));
                    }
                    return match state.provider_outcome.record_success() {
                        Ok(()) => state.pending.pop_front().map(|item| (item, state)),
                        Err(error) => Some((Err(error), state)),
                    };
                };
                let result = match chunk {
                    Err(error @ V3ProviderError::ClientDisconnect { .. }) => {
                        state.done = true;
                        return Some((Err(error.to_string()), state));
                    }
                    Err(error) => Err(error.to_string()),
                    Ok(chunk) => {
                        let raw = routecodex_v3_sse::build_v3_sse_transport_in_01_raw_chunk(&chunk);
                        state.decoder.push(raw).map_err(|error| error.to_string())
                    }
                }
                .and_then(|frames| enqueue_sse_client_chunks(&mut state, frames));
                if let Err(error) = result {
                    state.done = true;
                    if error.contains("ROUTECODEX_GOVERNANCE_REJECTED") {
                        // 治理层拒绝：不记录 provider-health 失败（控制面信号
                        // 只应反映 provider 行为，不反映 RouteCodex 治理决策）。
                        return Some((Err(error), state));
                    }
                    let result = state
                        .provider_outcome
                        .record_failure(&error)
                        .await
                        .map(|()| error)
                        .and_then(Err);
                    return Some((result, state));
                }
            }
        },
    ))
}

fn is_v3_openai_chat_settlement_tail_frame(data: &str) -> bool {
    if data == "[DONE]" {
        return false;
    }
    let Ok(value) = serde_json::from_str::<serde_json::Value>(data) else {
        return false;
    };
    if value.get("type").and_then(serde_json::Value::as_str) == Some("ping") {
        return true;
    }
    matches!(
        value.get("choices").and_then(serde_json::Value::as_array),
        Some(choices) if choices.is_empty()
    )
}

fn enqueue_sse_client_chunks(
    state: &mut V3OpenAiChatSseState,
    frames: Vec<routecodex_v3_sse::SseTransportIn03ValidatedFrameStream>,
) -> Result<(), String> {
    for frame in frames {
        if state.seen_done {
            let fields = frame.frame().fields();
            let is_tail = fields.iter().any(|field| {
                matches!(
                    field,
                    routecodex_v3_sse::SseField::Named { name, value }
                        if name == "data" && is_v3_openai_chat_settlement_tail_frame(value)
                )
            });
            if fields.is_empty() || is_tail {
                // Comment-only keep-alive frames and non-semantic settlement
                // frames (e.g. `{"choices":[],"cost":"0"}`) after [DONE] are
                // benign protocol tails, not stream corruption.
                continue;
            }
            return Err("OpenAI Chat SSE emitted a frame after [DONE]".into());
        }
        let mut data = None;
        for field in frame.frame().fields() {
            if let routecodex_v3_sse::SseField::Named { name, value } = field {
                if name == "data" {
                    data = Some(value.clone());
                }
            }
        }
        let Some(data) = data else { continue };
        if data == "[DONE]" {
            if !state.terminal {
                return Err("OpenAI Chat SSE emitted [DONE] before terminal finish_reason".into());
            }
            state.seen_done = true;
            state.pending.push_back(Ok(b"data: [DONE]\n\n".to_vec()));
            continue;
        }
        let payload: Value = serde_json::from_str(&data).map_err(|error| error.to_string())?;
        let client_payload = project_sse_event_payload(
            payload,
            state.compatibility_profile.as_deref(),
            state.web_search_execution_mode,
            state.web_search_center_state.as_ref(),
            state.retain_response_cipher,
        )
        .map_err(|error| match error {
            // 治理层拒绝（web_search Mode B 无投影路径）：不是 provider 流
            // 错误，禁止记录 provider-health 失败（会污染后续路由）。
            V3OpenAiChatRelayRuntimeError::WebSearchInterceptedUnprojected => {
                "ROUTECODEX_GOVERNANCE_REJECTED".to_string()
            }
            other => other.to_string(),
        })?;
        let choices = client_payload
            .get("choices")
            .and_then(Value::as_array)
            .ok_or_else(|| "OpenAI Chat SSE choices are missing".to_string())?;
        if state.terminal && !choices.is_empty() {
            return Err(
                "OpenAI Chat SSE emitted a non-usage frame after terminal finish_reason".into(),
            );
        }
        state.terminal =
            state.terminal || openai_chat_sse_payload_has_terminal_finish_reason(&client_payload)?;
        state
            .pending
            .push_back(Ok(format!("data: {client_payload}\n\n").into_bytes()));
    }
    Ok(())
}

fn project_responses_sse_as_openai_chat_stream(
    stream: routecodex_v3_provider_responses::V3ProviderSseStream,
    provider_outcome: V3OpenAiChatSseProviderOutcome,
) -> V3OpenAiChatClientStream {
    use futures_util::StreamExt;
    let decoder = routecodex_v3_sse::SseIncrementalDecoder::new(
        routecodex_v3_sse::SseTransportLimits::default(),
    );
    let transducer = V3OpenAiChatResponsesSseTransducer::new();
    Box::pin(futures_util::stream::unfold(
        (
            stream,
            decoder,
            transducer,
            VecDeque::<Vec<u8>>::new(),
            false,
            false,
            provider_outcome,
        ),
        |(
            mut provider,
            mut decoder,
            mut transducer,
            mut pending,
            mut done_seen,
            mut finished,
            mut provider_outcome,
        )| async move {
            loop {
                if let Some(frame) = pending.pop_front() {
                    return Some((
                        Ok(frame),
                        (
                            provider,
                            decoder,
                            transducer,
                            pending,
                            done_seen,
                            finished,
                            provider_outcome,
                        ),
                    ));
                }
                if finished {
                    return None;
                }
                let Some(chunk) = provider.next().await else {
                    finished = true;
                    let decoder_to_finish = std::mem::replace(
                        &mut decoder,
                        routecodex_v3_sse::SseIncrementalDecoder::new(
                            routecodex_v3_sse::SseTransportLimits::default(),
                        ),
                    );
                    let decoder_result = decoder_to_finish
                        .finish()
                        .map_err(|error| error.to_string());
                    let result = decoder_result.and_then(|_| transducer.finish());
                    if let Err(error) = result {
                        let recorded = provider_outcome.record_failure(&error).await;
                        return Some((
                            Err(recorded.map(|_| error).unwrap_or_else(|record| record)),
                            (
                                provider,
                                decoder,
                                transducer,
                                pending,
                                done_seen,
                                finished,
                                provider_outcome,
                            ),
                        ));
                    }
                    let success = provider_outcome.record_success();
                    return match success {
                        Ok(()) => None,
                        Err(error) => Some((
                            Err(error),
                            (
                                provider,
                                decoder,
                                transducer,
                                pending,
                                done_seen,
                                finished,
                                provider_outcome,
                            ),
                        )),
                    };
                };
                let result = (|| -> Result<(), String> {
                    let raw = match &chunk {
                        Err(error @ V3ProviderError::ClientDisconnect { .. }) => {
                            finished = true;
                            return Err(error.to_string());
                        }
                        Err(error) => return Err(error.to_string()),
                        Ok(chunk) => {
                            routecodex_v3_sse::build_v3_sse_transport_in_01_raw_chunk(chunk)
                        }
                    };
                    for frame in decoder
                        .push(raw)
                        .map_err(|error| error.to_string())?
                    {
                        let mut data = None;
                        for field in frame.frame().fields() {
                            if let routecodex_v3_sse::SseField::Named { name, value } = field {
                                if name == "data" {
                                    data = Some(value.clone());
                                }
                            }
                        }
                        let Some(data) = data else {
                            continue;
                        };
                        if data == "[DONE]" {
                            continue;
                        }
                        if done_seen {
                            return Err("Responses SSE emitted data after response.completed".to_string());
                        }
                        let event: Value = serde_json::from_str(&data)
                            .map_err(|error| error.to_string())?;
                        let event_type = event
                            .get("type")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_string();
                        for payload in transducer.push_event(event)? {
                            pending.push_back(format!("data: {payload}\n\n").into_bytes());
                        }
                        if event_type == "response.completed" {
                            pending.push_back(b"data: [DONE]\n\n".to_vec());
                            done_seen = true;
                        }
                    }
                    Ok(())
                })();
                match result {
                    Ok(()) if !pending.is_empty() => {
                        continue;
                    }
                    Ok(_) => continue,
                    Err(error) => {
                        finished = true;
                        if error.starts_with("ROUTECODEX_GOVERNANCE_REJECTED") {
                            return Some((
                                Err(error),
                                (
                                    provider,
                                    decoder,
                                    transducer,
                                    pending,
                                    done_seen,
                                    finished,
                                    provider_outcome,
                                ),
                            ));
                        }
                        let recorded = provider_outcome.record_failure(&error).await;
                        return Some((
                            Err(recorded.map(|_| error).unwrap_or_else(|record| record)),
                            (
                                provider,
                                decoder,
                                transducer,
                                pending,
                                done_seen,
                                finished,
                                provider_outcome,
                            ),
                        ));
                    }
                }
            }
        },
    ))
}

fn project_sse_event_payload(
    payload: Value,
    compatibility_profile: Option<&str>,
    web_search_execution_mode: routecodex_v3_config::V3WebSearchExecutionMode,
    web_search_center_state: Option<&V3WebSearchCenterState>,
    retain_response_cipher: bool,
) -> Result<Value, V3OpenAiChatRelayRuntimeError> {
    let mut trace = Vec::new();
    project_json_response(
        payload,
        V3HubProviderWireProtocol::OpenAiChat,
        &Value::Null,
        V3HubTransportIntent::Sse,
        &mut trace,
        compatibility_profile,
        web_search_execution_mode,
        web_search_center_state,
        retain_response_cipher,
    )
}

/// Anthropic wire SSE stream -> responses canonical -> OpenAI Chat SSE 事件流
/// （chat 入口 outbound 投影；SSE 仅负责 framing，语义转换走 canonical）。
fn project_anthropic_sse_as_openai_chat_stream(
    stream: routecodex_v3_provider_responses::V3ProviderSseStream,
    web_search_execution_mode: routecodex_v3_config::V3WebSearchExecutionMode,
    provider_outcome: V3OpenAiChatSseProviderOutcome,
) -> V3OpenAiChatClientStream {
    use futures_util::StreamExt;
    let decoder = routecodex_v3_sse::SseIncrementalDecoder::new(
        routecodex_v3_sse::SseTransportLimits::default(),
    );
    let transducer = V3OpenAiChatAnthropicSseTransducer::new(
        web_search_execution_mode.is_metadata_center_local_search(),
    );
    Box::pin(futures_util::stream::unfold(
        (
            stream,
            decoder,
            transducer,
            VecDeque::<Vec<u8>>::new(),
            false,
            false,
            provider_outcome,
        ),
        |(
            mut provider,
            mut decoder,
            mut transducer,
            mut pending,
            mut done_seen,
            mut finished,
            mut provider_outcome,
        )| async move {
            loop {
                if let Some(frame) = pending.pop_front() {
                    return Some((
                        Ok(frame),
                        (
                            provider,
                            decoder,
                            transducer,
                            pending,
                            done_seen,
                            finished,
                            provider_outcome,
                        ),
                    ));
                }
                if finished {
                    return None;
                }
                let Some(chunk) = provider.next().await else {
                    finished = true;
                    let decoder_to_finish = std::mem::replace(
                        &mut decoder,
                        routecodex_v3_sse::SseIncrementalDecoder::new(
                            routecodex_v3_sse::SseTransportLimits::default(),
                        ),
                    );
                    let decoder_result = decoder_to_finish
                        .finish()
                        .map_err(|error| error.to_string());
                    let result = decoder_result.and_then(|_| transducer.finish());
                    if let Err(error) = result {
                        let recorded = provider_outcome.record_failure(&error).await;
                        return Some((
                            Err(recorded.map(|_| error).unwrap_or_else(|record| record)),
                            (
                                provider,
                                decoder,
                                transducer,
                                pending,
                                done_seen,
                                finished,
                                provider_outcome,
                            ),
                        ));
                    }
                    // Anthropic Messages wire 无 [DONE] 定义（标准流以 message_stop
                    // 结束；transducer.finish() 成功即 message_stop + terminal
                    // finish_reason 已到达）。MEMORY 合同（08-08）："[DONE]" 由网关在
                    // 客户端侧补发 transport sentinel，不是 provider 必发——缺失不记
                    // provider-health 失败。
                    if !done_seen {
                        done_seen = true;
                        pending.push_back(b"data: [DONE]\n\n".to_vec());
                    }
                    match provider_outcome.record_success() {
                        Ok(()) => {}
                        Err(error) => {
                            return Some((
                                Err(error),
                                (
                                    provider,
                                    decoder,
                                    transducer,
                                    pending,
                                    done_seen,
                                    finished,
                                    provider_outcome,
                                ),
                            ));
                        }
                    }
                    return match pending.pop_front() {
                        Some(frame) => Some((
                            Ok(frame),
                            (
                                provider,
                                decoder,
                                transducer,
                                pending,
                                done_seen,
                                finished,
                                provider_outcome,
                            ),
                        )),
                        None => None,
                    };
                };
                let result = match chunk {
                    Err(error) => Err(error.to_string()),
                    Ok(chunk) => decoder
                        .push(routecodex_v3_sse::build_v3_sse_transport_in_01_raw_chunk(
                            &chunk,
                        ))
                        .map_err(|error| error.to_string())
                        .and_then(|frames| {
                            for frame in frames {
                                let mut data = String::new();
                                for field in frame.frame().fields() {
                                    if let routecodex_v3_sse::SseField::Named { name, value } =
                                        field
                                    {
                                        if name == "data" {
                                            if !data.is_empty() {
                                                data.push('\n');
                                            }
                                            data.push_str(value);
                                        }
                                    }
                                }
                                let data = data.trim();
                                if data.is_empty() {
                                    continue;
                                }
                                if data == "[DONE]" {
                                    transducer.finish()?;
                                    done_seen = true;
                                    pending.push_back(b"data: [DONE]\n\n".to_vec());
                                    continue;
                                }
                                if done_seen {
                                    return Err(
                                        "Anthropic SSE emitted data after [DONE]".to_string()
                                    );
                                }
                                let event: Value = serde_json::from_str(data)
                                    .map_err(|error| error.to_string())?;
                                for payload in transducer.push_event(event)? {
                                    pending.push_back(format!("data: {payload}\n\n").into_bytes());
                                }
                            }
                            Ok(())
                        }),
                };
                match result {
                    Ok(()) if !pending.is_empty() => {
                        continue;
                    }
                    Ok(_) => continue,
                    Err(error) => {
                        finished = true;
                        if error.starts_with("ROUTECODEX_GOVERNANCE_REJECTED") {
                            return Some((
                                Err(error),
                                (
                                    provider,
                                    decoder,
                                    transducer,
                                    pending,
                                    done_seen,
                                    finished,
                                    provider_outcome,
                                ),
                            ));
                        }
                        let recorded = provider_outcome.record_failure(&error).await;
                        return Some((
                            Err(recorded.map(|_| error).unwrap_or_else(|record| record)),
                            (
                                provider,
                                decoder,
                                transducer,
                                pending,
                                done_seen,
                                finished,
                                provider_outcome,
                            ),
                        ));
                    }
                }
            }
        },
    ))
}

fn openai_chat_sse_payload_has_terminal_finish_reason(payload: &Value) -> Result<bool, String> {
    let choices = payload
        .get("choices")
        .and_then(Value::as_array)
        .ok_or_else(|| "OpenAI Chat SSE choices are missing".to_string())?;
    let mut terminal = false;
    for choice in choices {
        if choice
            .get("finish_reason")
            .is_some_and(|value| !value.is_null())
        {
            terminal = true;
        }
    }
    Ok(terminal)
}

fn openai_chat_provider_http_failure(
    status: u16,
    body: &[u8],
    _provider_id: &str,
) -> V3RelayProviderFailure {
    let body = match serde_json::from_slice::<Value>(body) {
        Ok(value) => value,
        Err(error) => json!({
            "error": {
                "type": "provider_error",
                "message": format!("provider returned HTTP {status} with malformed JSON error body: {error}")
            }
        }),
    };
    V3RelayProviderFailure {
        status,
        client_response: body,
        source_stage: "V3ProviderReqOutbound09TransportRequest",
        terminal_projection: None,
        error_type_fn: extract_error_type_style,
        error_message_fn: extract_message_type_style,
    }
}

fn provider_failure_output(
    failure: V3RelayProviderFailure,
    mut trace: Vec<&'static str>,
) -> V3OpenAiChatRelayRuntimeOutput {
    let projected = failure
        .terminal_projection
        .expect("terminal OpenAI Chat provider failure must carry typed Error06 projection");
    trace.push("V3Error06ClientProjected");
    V3OpenAiChatRelayRuntimeOutput {
        status: projected.status,
        client_body: V3OpenAiChatRelayClientBody::Json(projected.body),
        node_trace: trace,
        error_chain: Some(projected.chain.to_vec()),
    }
}

fn error_output(
    source: routecodex_v3_error::V3Error01SourceRaised,
    status: u16,
    provider_id: &str,
    mut trace: Vec<&'static str>,
) -> V3OpenAiChatRelayRuntimeOutput {
    let (projected, trace) = crate::hub_v1::error_output(source, status, provider_id, trace);
    V3OpenAiChatRelayRuntimeOutput {
        status: projected.status,
        client_body: V3OpenAiChatRelayClientBody::Json(projected.body),
        node_trace: trace,
        error_chain: Some(projected.chain.to_vec()),
    }
}

/// OpenAI Chat relay 协议 codec：协议差异的唯一收敛面（骨架驱动）。
pub struct V3OpenAiChatRelayCodec;

impl V3RelayProtocolCodec for V3OpenAiChatRelayCodec {
    type Output = V3OpenAiChatRelayRuntimeOutput;
    type SseStream = V3OpenAiChatClientStream;
    type SseOutcome = V3OpenAiChatSseProviderOutcome;

    const ENTRY_PROTOCOL: V3HubEntryProtocol = V3HubEntryProtocol::OpenAiChat;
    const ENTRY_KIND: &'static str = "openai_chat";
    const EXPECTED_PROVIDER_TYPE: Option<&'static str> = None;

    fn wire_protocol(
        selected: &routecodex_v3_target::V3TargetCandidate,
    ) -> Result<V3HubProviderWireProtocol, V3RelayCoreError> {
        provider_wire_protocol_for_selected_candidate(selected)
            .map_err(|error| V3RelayCoreError::Target(error.to_string()))
    }

    fn request_hook_profile(
        manifest: &V3Config05ManifestPublished,
        payload: &Value,
    ) -> Result<V3HubServertoolRequestProfile, V3RelayCoreError> {
        // Mode B 判定用请求声明的 model 的编译期 mode（Req04 在 route 之前）。
        let model = payload
            .get("model")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty());
        let request_web_search_execution_mode = match model {
            Some(model) => resolve_web_search_mode_and_backend(manifest, model).0,
            None => routecodex_v3_config::V3WebSearchExecutionMode::None,
        };
        if request_web_search_execution_mode.is_metadata_center_local_search() {
            Ok(V3HubServertoolRequestProfile::enabled(["servertool.request"])
                .with_web_search_execution_mode(request_web_search_execution_mode))
        } else {
            Ok(V3HubServertoolRequestProfile::disabled())
        }
    }

    fn provider_http_failure(
        status: u16,
        body: &[u8],
        provider_id: &str,
    ) -> V3RelayProviderFailure {
        // openai_chat 本地构造：body 原样 + type-style 提取（provider 错误 body
        // 为 `{"error":{"type":...,"message":...}}` 形状）。
        openai_chat_provider_http_failure(status, body, provider_id)
    }

    fn request_failure_builder(
        source_stage: &'static str,
        error_type: &'static str,
        error: impl std::fmt::Display,
    ) -> V3RelayProviderFailure {
        // openai_chat wire 用 error.type（与 provider_http_failure 的 type-style 一致；
        // 默认共享版是 gemini/responses 的 error.code 风格）。
        V3RelayProviderFailure {
            status: 502,
            client_response: json!({"error":{"type":error_type,"message":error.to_string()}}),
            source_stage,
            terminal_projection: None,
            error_type_fn: extract_error_type_style,
            error_message_fn: extract_message_type_style,
        }
    }

    fn model_from_endpoint_path(_endpoint_path: &str) -> Result<String, V3RelayCoreError> {
        // openai_chat 不从 endpoint 提取 model（固定 /v1/chat/completions；model 在 payload）。
        Ok(String::new())
    }

    fn validate_client_payload(payload: &Value) -> Result<(), V3RelayCoreError> {
        validate_v3_openai_chat_client_input_payload(payload, V3HubEntryProtocol::OpenAiChat)
            .map_err(|error| V3RelayCoreError::Target(error.to_string()))
    }

    fn routing_payload(
        standardized: &std::sync::Arc<Value>,
        _requested_model: &str,
    ) -> Result<std::sync::Arc<Value>, V3RelayCoreError> {
        // openai_chat 的 VR body 就是 canonical payload 本身（无 model 注入）。
        Ok(std::sync::Arc::clone(standardized))
    }

    fn build_transport_request(
        request_id: &str,
        target: V3ResponsesProviderTarget,
        _transport_intent: V3HubTransportIntent,
        body: Value,
        _provider_header_overrides: Vec<V3ProviderRequestHeader>,
    ) -> Result<V3Transport13ResponsesHttpRequest, V3RelayCoreError> {
        // wire protocol 从 target.provider_type 推断（与 selected candidate 推断一致）。
        let wire_protocol = provider_wire_protocol_for_provider_type(
            &target.provider_id,
            &target.provider_type,
        )
        .map_err(|error| V3RelayCoreError::Target(error.to_string()))?;
        let wire = build_v3_provider_12_responses_wire_payload(request_id, target, body)
            .map_err(|error| V3RelayCoreError::Target(error.to_string()))?;
        build_v3_provider_transport_request_for_protocol(wire_protocol, wire)
            .map_err(|error| V3RelayCoreError::Target(error.to_string()))
    }

    fn project_json_response(
        provider_value: Value,
        provider_wire_protocol: V3HubProviderWireProtocol,
        chat_request: &Value,
        transport_intent: V3HubTransportIntent,
        trace: &mut Vec<&'static str>,
        compatibility_profile: Option<&str>,
        web_search_execution_mode: V3WebSearchExecutionMode,
        web_search_state: Option<&V3WebSearchCenterState>,
        retain_response_cipher: bool,
    ) -> Result<Value, V3RelayCoreError> {
        project_json_response(
            provider_value,
            provider_wire_protocol,
            chat_request,
            transport_intent,
            trace,
            compatibility_profile,
            web_search_execution_mode,
            web_search_state,
            retain_response_cipher,
        )
        .map_err(|error| match error {
            V3OpenAiChatRelayRuntimeError::WebSearchInterceptedUnprojected => {
                V3RelayCoreError::WebSearchIntercepted(
                    "openai_chat web-search intercepted but no projection path".to_string(),
                )
            }
            other => V3RelayCoreError::Target(other.to_string()),
        })
    }

    fn build_sse_outcome(
        provider_health: &V3ProviderFailureRuntimeHealth,
        failure_session_scope: &V3ProviderFailureSessionScope,
        provider_id: String,
        auth_alias: String,
        model_id: String,
        recorded: bool,
        permit: Option<V3ProviderActionPermit>,
    ) -> V3OpenAiChatSseProviderOutcome {
        V3OpenAiChatSseProviderOutcome {
            provider_health: provider_health.clone(),
            failure_session_scope: failure_session_scope.clone(),
            provider_id,
            auth_alias,
            model_id,
            recorded,
            _provider_action_permit: permit,
        }
    }

    fn project_sse(
        provider: V3ProviderSseStream,
        provider_wire_protocol: V3HubProviderWireProtocol,
        compatibility_profile: Option<String>,
        web_search_execution_mode: V3WebSearchExecutionMode,
        web_search_state: Option<V3WebSearchCenterState>,
        _retain_response_cipher: bool,
        outcome: V3OpenAiChatSseProviderOutcome,
    ) -> Result<V3OpenAiChatClientStream, V3RelayCoreError> {
        if provider_wire_protocol == V3HubProviderWireProtocol::Anthropic {
            return Ok(project_anthropic_sse_as_openai_chat_stream(
                provider,
                web_search_execution_mode,
                outcome,
            ));
        }
        if provider_wire_protocol == V3HubProviderWireProtocol::Responses {
            // provider 以 Responses 协议 SSE 返回（如 cc-sol）：经 transducer
            // 流式转换为 Chat SSE（response.created/output_text.delta/... ->
            // chat.completion.chunk + [DONE]），不允许把 responses SSE 直接
            // 当 chat SSE 透传（缺 choices 会让 chat 状态机 fail-fast）。
            return Ok(project_responses_sse_as_openai_chat_stream(
                provider,
                outcome,
            ));
        }
        // OpenAiChat wire SSE：流式帧逐帧走 project_sse_event_payload 拦截
        // （first_local_websearch_tool_call 检测本地 websearch function tool call，
        // 命中才 fail-fast 转 ROUTECODEX_GOVERNANCE_REJECTED，不记 provider 失败；
        // 非 websearch 帧正常透传——Mode B 模型的纯文本流不被误伤）。
        Ok(project_sse_stream(
            provider,
            compatibility_profile,
            web_search_execution_mode,
            web_search_state,
            _retain_response_cipher,
            outcome,
        ))
    }

    fn assemble_json_output(
        client_response: Value,
        trace: Vec<&'static str>,
    ) -> V3OpenAiChatRelayRuntimeOutput {
        V3OpenAiChatRelayRuntimeOutput {
            status: 200,
            client_body: V3OpenAiChatRelayClientBody::Json(client_response),
            node_trace: trace,
            error_chain: None,
        }
    }

    fn assemble_sse_output(
        sse: V3OpenAiChatClientStream,
        trace: Vec<&'static str>,
    ) -> V3OpenAiChatRelayRuntimeOutput {
        V3OpenAiChatRelayRuntimeOutput {
            status: 200,
            client_body: V3OpenAiChatRelayClientBody::Sse(sse),
            node_trace: trace,
            error_chain: None,
        }
    }

    fn sse_from_collected(collected: Vec<Vec<u8>>) -> Self::SseStream {
        let stream: V3OpenAiChatClientStream =
            Box::pin(futures_util::stream::iter(collected.into_iter().map(Ok)));
        stream
    }

    fn assemble_failure_output(
        failure: V3RelayProviderFailure,
        trace: Vec<&'static str>,
    ) -> V3OpenAiChatRelayRuntimeOutput {
        provider_failure_output(failure, trace)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn settlement_tail_frame_after_done_is_ignored() {
        assert!(is_v3_openai_chat_settlement_tail_frame(r#"{"choices":[],"cost":"0"}"#));
        assert!(is_v3_openai_chat_settlement_tail_frame(r#"{"choices":[]}"#));
        assert!(is_v3_openai_chat_settlement_tail_frame(r#"{"type":"ping","cost":"0"}"#));
    }

    #[test]
    fn semantic_frames_after_done_still_fail() {
        assert!(!is_v3_openai_chat_settlement_tail_frame("[DONE]"));
        assert!(!is_v3_openai_chat_settlement_tail_frame(
            r#"{"choices":[{"index":0,"delta":{"content":"hi"}}]}"#
        ));
        assert!(!is_v3_openai_chat_settlement_tail_frame("not json"));
    }
}
