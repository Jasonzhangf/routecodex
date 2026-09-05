//! relay 统一主循环骨架（大骨架）。
//!
//! 设计契约（Jason 2026-08-08）：
//! - 所有 relay 协议（responses / anthropic / openai_chat / gemini）共享同一个主循环
//!   `execute_v3_relay_runtime_core<C, T>`，协议差异收敛到 [`V3RelayProtocolCodec`]；
//! - 生命周期（VR 重试 loop、错误策略循环、provider action recovery、SSE unfold）只存在于
//!   骨架；骨架上的逻辑（共享辅助、codec 方法）不自己管理生命周期；
//! - 禁止在骨架中出现协议字段名 / provider 特例；新增协议只需实现 codec。
//!
//! 里程碑 2：trait + 骨架。SSE 状态机（协议特定）经 [`V3RelayProtocolCodec::project_sse`]
//! 收敛；JSON 响应链（resp01->02->03->04->05->06）经 `project_json_response` 收敛。

use super::*;
use crate::nodes::{V3AttemptStoreError, V3CommittedClientSseBuilder, V3RequestExecutionControl};
use crate::provider_action_gate::{V3ProviderActionPermit, V3ProviderActionRecoveryTransition};
use crate::provider_failure_runtime_policy::{
    resolve_v3_relay_target_outcome, resolve_v3_relay_target_outcome_with_rescue,
    v3_relay_provider_policy_now_epoch_ms, v3_relay_provider_target_selection_sample,
    V3ProviderFailureRuntimeHealth, V3RelayProviderFailurePolicyContext,
    V3RelayProviderFailurePolicyState, V3RelayProviderFailureRetryPolicy,
    V3RelayProviderTargetResolution, V3RelayProviderTargetResolutionInput,
};
use crate::runtime_timing::V3RuntimeTimingState;
use futures_util::StreamExt;
use routecodex_v3_config::{V3Config05ManifestPublished, V3WebSearchExecutionMode};
use routecodex_v3_error::{V3ErrorSourceKind, V3ProviderFailureSessionScope};
use routecodex_v3_provider_responses::{
    ResponsesTransport, V3ProviderError, V3ProviderRequestHeader, V3ProviderResponseBody,
    V3ProviderSseStream, V3ResponsesProviderTarget, V3Transport13ResponsesHttpRequest,
};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};

enum V3RelayAttemptCollectFailure {
    Provider(String),
    LocalStore(V3AttemptStoreError),
    Observation(String),
}

/// Relay SSE 首帧守卫：provider 返回 SSE 后、投影前 await 首帧。首帧错误/空流/
/// 挂起超时 -> V3ProviderError，走 provider 失败策略(reselect 切 provider)。
/// 保证 provider SSE 错误在响应头前被捕获并切 provider，客户端无感、对话不断流。
async fn guard_relay_sse_first_frame(
    request_id: &str,
    provider_id: &str,
    provider_protocol: V3HubProviderWireProtocol,
    mut stream: routecodex_v3_provider_responses::V3ProviderSseStream,
    sse_first_frame_timeout_ms: Option<u64>,
) -> Result<routecodex_v3_provider_responses::V3ProviderSseStream, V3ProviderError> {
    use futures_util::StreamExt;
    let mut decoder = routecodex_v3_sse::SseIncrementalDecoder::new(
        routecodex_v3_sse::SseTransportLimits::default(),
    );
    let mut consumed = Vec::new();
    let mut first_semantic_frame_seen = false;
    let first_frame_timeout = sse_first_frame_timeout_ms
        .map(std::time::Duration::from_millis)
        .ok_or_else(|| V3ProviderError::Transport {
            request_id: request_id.to_string(),
            provider_id: provider_id.to_string(),
            reason: "published provider SSE first-frame timeout is missing".to_string(),
        })?;
    let first_frame_deadline = tokio::time::Instant::now() + first_frame_timeout;
    let first = tokio::time::timeout_at(first_frame_deadline, stream.next())
        .await
        .map_err(|_| V3ProviderError::Transport {
            request_id: request_id.to_string(),
            provider_id: provider_id.to_string(),
            reason: "provider SSE stream did not produce a first frame within timeout".to_string(),
        })?;
    match first {
        Some(Ok(chunk)) => {
            consumed.push(chunk);
            loop {
                let chunk = consumed.last().expect("first provider SSE chunk").clone();
                let raw = routecodex_v3_sse::build_v3_sse_transport_in_01_raw_chunk(&chunk);
                let frames = decoder
                    .push(raw)
                    .map_err(|error| V3ProviderError::MalformedSse {
                        request_id: request_id.to_string(),
                        provider_id: provider_id.to_string(),
                        reason: error.to_string(),
                    })?;
                for frame in frames {
                    let data = crate::hub_v1::normalize_v3_provider_sse_json_data_for_event_name(
                        provider_protocol,
                        frame.frame().fields(),
                    )
                    .map_err(|reason| V3ProviderError::MalformedSse {
                        request_id: request_id.to_string(),
                        provider_id: provider_id.to_string(),
                        reason,
                    })?;
                    if data.trim() == "[DONE]"
                        || crate::hub_v1::is_v3_provider_sse_transport_keepalive_data(&data)
                    {
                        continue;
                    }
                    let outcome =
                        crate::hub_v1::classify_v3_provider_sse_json_data(provider_protocol, &data)
                            .map_err(|error| V3ProviderError::MalformedSse {
                                request_id: request_id.to_string(),
                                provider_id: provider_id.to_string(),
                                reason: error,
                            })?;
                    match outcome {
                        Some(crate::hub_v1::V3ProviderResponsesJsonFrameOutcome::StartClientStream) => {
                            first_semantic_frame_seen = true;
                            break;
                        }
                        Some(
                            crate::hub_v1::V3ProviderResponsesJsonFrameOutcome::Terminal
                            | crate::hub_v1::V3ProviderResponsesJsonFrameOutcome::TerminalWithoutOutput,
                        ) => {
                            first_semantic_frame_seen = true;
                            break;
                        }
                        Some(crate::hub_v1::V3ProviderResponsesJsonFrameOutcome::Failure {
                            code,
                            message,
                        }) => {
                            return Err(V3ProviderError::MalformedSse {
                                request_id: request_id.to_string(),
                                provider_id: provider_id.to_string(),
                                reason: format!("provider emitted {code}: {message}"),
                            });
                        }
                        Some(
                            crate::hub_v1::V3ProviderResponsesJsonFrameOutcome::ContinueBuffering,
                        )
                        | None => {}
                    }
                }
                if first_semantic_frame_seen {
                    break;
                }
                let next = tokio::time::timeout_at(first_frame_deadline, stream.next())
                    .await
                    .map_err(|_| V3ProviderError::Transport {
                        request_id: request_id.to_string(),
                        provider_id: provider_id.to_string(),
                        reason: "provider SSE stream did not produce a semantic first frame within timeout".to_string(),
                    })?;
                match next {
                    Some(Ok(next_chunk)) => consumed.push(next_chunk),
                    Some(Err(error)) => return Err(error),
                    None => {
                        return Err(V3ProviderError::Transport {
                            request_id: request_id.to_string(),
                            provider_id: provider_id.to_string(),
                            reason: "provider SSE stream ended before semantic first frame"
                                .to_string(),
                        });
                    }
                }
            }
            // 预检期间消费的 chunks 原样重放；协议来源是已完成的 provider 路由决策。
            let replay = futures_util::stream::iter(consumed.into_iter().map(Ok)).chain(stream);
            Ok(Box::pin(replay))
        }
        Some(Err(error @ V3ProviderError::ClientDisconnect { .. })) => Err(error),
        Some(Err(error)) => Err(error),
        None => Err(V3ProviderError::Transport {
            request_id: request_id.to_string(),
            provider_id: provider_id.to_string(),
            reason: "provider SSE stream ended before first frame".to_string(),
        }),
    }
}

/// Relay SSE idle guard: a configured window applies between every two frames.
pub(crate) fn guard_v3_provider_sse_idle(
    request_id: &str,
    provider_id: &str,
    stream: routecodex_v3_provider_responses::V3ProviderSseStream,
    idle_timeout: std::time::Duration,
) -> routecodex_v3_provider_responses::V3ProviderSseStream {
    use futures_util::StreamExt;
    let request_id = request_id.to_string();
    let provider_id = provider_id.to_string();
    Box::pin(futures_util::stream::unfold(
        (stream, false),
        move |(mut stream, timed_out)| {
            let request_id = request_id.clone();
            let provider_id = provider_id.clone();
            async move {
                if timed_out {
                    return None;
                }
                match tokio::time::timeout(idle_timeout, stream.next()).await {
                    Ok(Some(Ok(chunk))) => Some((Ok(chunk), (stream, false))),
                    Ok(Some(Err(error))) => Some((Err(error), (stream, false))),
                    Ok(None) => None,
                    Err(_) => Some((
                        Err(V3ProviderError::Transport {
                            request_id: request_id.clone(),
                            provider_id: provider_id.clone(),
                            reason: format!(
                                "provider SSE stream idle timeout (no frame within {}ms)",
                                idle_timeout.as_millis()
                            ),
                        }),
                        (stream, true),
                    )),
                }
            }
        },
    ))
}

fn observe_v3_provider_sse(
    stream: routecodex_v3_provider_responses::V3ProviderSseStream,
    observation: V3RuntimeStreamObservation,
) -> routecodex_v3_provider_responses::V3ProviderSseStream {
    use futures_util::StreamExt;
    Box::pin(stream.map(move |item| {
        if let Ok(chunk) = &item {
            if let Err(error) = observation.record_provider_raw_sse_chunk(chunk) {
                // This is runtime observation state, not provider health. Keep
                // the failure on the typed side-channel while preserving the
                // provider/client bytes and their protocol semantics.
                if let Err(receipt_error) = observation.record_observation_error(&format!(
                    "provider_raw_sse_observation_failed: {error}"
                )) {
                    eprintln!(
                        "V3 runtime observation failure could not be recorded: {receipt_error}; original: {error}"
                    );
                }
            }
        }
        item
    }))
}

/// Relay transport 响应头等待窗口：从 provider manifest 的 `request_timeout_ms` 读取，
/// 未配置时 serde default 为 300_000ms（5 分钟）。深上下文 provider 可通过
/// `timeout = 900000` 覆盖为更长窗口。超时后归一化为 Transport 错误进入错误链。
pub(crate) fn v3_relay_transport_response_timeout_from_ms(
    request_timeout_ms: Option<u64>,
) -> std::time::Duration {
    std::time::Duration::from_millis(request_timeout_ms.filter(|&ms| ms > 0).unwrap_or(300_000))
}

pub(crate) fn v3_relay_transport_response_timeout(
    manifest: &V3Config05ManifestPublished,
    provider_id: &str,
) -> std::time::Duration {
    v3_relay_transport_response_timeout_from_ms(
        manifest
            .providers
            .get(provider_id)
            .map(|p| p.request_timeout_ms),
    )
}

#[cfg(test)]
mod response_header_timeout_contract_tests {
    use super::*;

    #[test]
    fn relay_transport_header_timeout_reads_provider_request_timeout() {
        assert_eq!(
            v3_relay_transport_response_timeout_from_ms(Some(900_000)),
            std::time::Duration::from_millis(900_000)
        );
    }

    #[test]
    fn relay_transport_header_timeout_defaults_and_zero_use_default_timeout() {
        assert_eq!(
            v3_relay_transport_response_timeout_from_ms(None),
            std::time::Duration::from_millis(300_000)
        );
        assert_eq!(
            v3_relay_transport_response_timeout_from_ms(Some(0)),
            std::time::Duration::from_millis(300_000)
        );
    }
}

/// The published provider SSE timeout intentionally covers both the first frame
/// and the maximum inter-frame idle interval for relay streams.
pub(crate) fn v3_provider_sse_idle_timeout(
    manifest: &V3Config05ManifestPublished,
    provider_id: &str,
) -> Result<std::time::Duration, String> {
    manifest.providers.get(provider_id).and_then(|provider| provider.sse_first_frame_timeout_ms)
        .filter(|timeout_ms| *timeout_ms > 0).map(std::time::Duration::from_millis)
        .ok_or_else(|| {
            format!(
                "published provider SSE first-frame/inter-frame timeout is missing for provider {provider_id}"
            )
        })
}
use std::fmt;

/// 骨架内部错误（协议入口负责映射到自身错误类型）。
#[derive(Debug, Clone, PartialEq)]
pub enum V3RelayCoreError {
    StaticRegistry(String),
    EndpointPath(String),
    ModelNotFound(String),
    Target(String),
    ProviderPoolExhausted { attempted_candidates: Vec<String> },
    /// 治理层拦截但入口无投影路径（如 openai_chat 入口遇 Mode B web-search 剥离）：
    /// 非 provider 失败，禁止进入失败重试链，骨架 fail-fast 返回。
    WebSearchIntercepted(String),
}

impl fmt::Display for V3RelayCoreError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            V3RelayCoreError::StaticRegistry(message) => write!(f, "static registry: {message}"),
            V3RelayCoreError::EndpointPath(message) => write!(f, "endpoint path: {message}"),
            V3RelayCoreError::ModelNotFound(message) => write!(f, "model not found: {message}"),
            V3RelayCoreError::Target(message) => write!(f, "target: {message}"),
            V3RelayCoreError::ProviderPoolExhausted {
                attempted_candidates,
            } => write!(f, "provider pool exhausted after {attempted_candidates:?}"),
            V3RelayCoreError::WebSearchIntercepted(message) => {
                write!(f, "web search intercepted unprojected: {message}")
            }
        }
    }
}

/// relay 协议 codec：协议差异的唯一收敛面。
///
/// 实现方（每个协议一个 codec）只提供协议差异方法；生命周期与编排由骨架持有。
pub(crate) trait V3RelayProtocolCodec: Sized {
    /// 协议 runtime 输出类型（如 `V3GeminiRelayRuntimeOutput`）。
    type Output;
    /// SSE provider outcome（记录 success/failure）。
    type SseOutcome;

    const ENTRY_PROTOCOL: V3HubEntryProtocol;
    const ENTRY_KIND: &'static str;
    /// 选中候选的 wire protocol（gemini 固定 Gemini；openai_chat 动态——
    /// 取决于选中 provider 的协议）。
    fn wire_protocol(
        selected: &routecodex_v3_target::V3TargetCandidate,
    ) -> Result<V3HubProviderWireProtocol, V3RelayCoreError>;
    /// provider_target 的 provider_type 校验（gemini = Some("Gemini")，其余 None）。
    const EXPECTED_PROVIDER_TYPE: Option<&'static str>;

    /// 请求侧 hook profile（gemini 固定 disabled；openai_chat Mode B web-search
    /// 按请求 model 的编译期 mode 启用）。
    fn request_hook_profile(
        manifest: &V3Config05ManifestPublished,
        server_id: &str,
        payload: &Value,
    ) -> Result<V3HubServertoolRequestProfile, V3RelayCoreError>;

    /// ReqInbound02 归一化（anthropic 特化：responses 语义轴断言 + anthropic 请求
    /// 结构归一化；其余协议用默认共享 builder）。
    fn req_inbound_02(
        req01: V3HubReqInbound01ClientRaw,
    ) -> Result<V3HubReqInbound02Normalized, V3RelayCoreError> {
        Ok(build_v3_hub_req_inbound_02_from_v3_hub_req_inbound_01(
            req01,
        ))
    }

    /// HTTP status 失败构造（错误 body 形状是协议 wire 差异：gemini/openai 原样 +
    /// 各自提取 fn；anthropic 需先转换 responses 错误形状）。
    fn provider_http_failure(status: u16, body: &[u8], provider_id: &str)
        -> V3RelayProviderFailure;

    /// 从 endpoint path 提取 model。
    fn model_from_endpoint_path(endpoint_path: &str) -> Result<String, V3RelayCoreError>;
    /// 校验客户端输入 payload。
    fn validate_client_payload(payload: &Value) -> Result<(), V3RelayCoreError>;
    /// 构建 VR 路由 payload（注入 requested model；Arc 形态与 req05 payload 一致）。
    fn routing_payload(
        standardized: &std::sync::Arc<Value>,
        requested_model: &str,
    ) -> Result<std::sync::Arc<Value>, V3RelayCoreError>;
    /// 构建 provider transport request（协议 wire 差异；provider_header_overrides
    /// 为入口携带的 provider 请求头覆盖，anthropic 用，其余协议传空）。
    fn build_transport_request(
        request_id: &str,
        target: V3ResponsesProviderTarget,
        transport_intent: V3HubTransportIntent,
        body: Value,
        provider_header_overrides: Vec<V3ProviderRequestHeader>,
    ) -> Result<V3Transport13ResponsesHttpRequest, V3RelayCoreError>;
    /// JSON 响应投影（resp01 -> 02 -> 03 -> 04 -> 05 -> 06）。
    /// `retain_response_cipher`：请求侧 VR 路由决策算好的"保留响应密文"标记（仅 gpt
    /// 单 provider 候选时为 true），响应侧 Resp03 只消费该结果。
    fn project_json_response(
        request_id: &str,
        session_id: &str,
        provider_value: Value,
        provider_wire_protocol: V3HubProviderWireProtocol,
        chat_request: &Value,
        transport_intent: V3HubTransportIntent,
        trace: &mut Vec<&'static str>,
        compatibility_profile: Option<&str>,
        web_search_execution_mode: V3WebSearchExecutionMode,
        web_search_state: Option<&V3WebSearchCenterState>,
        retain_response_cipher: bool,
        tool_thinking_enabled: bool,
        expected_model_id: &str,
    ) -> Result<Value, V3RelayCoreError>;
    /// 构建 SSE provider outcome。
    fn build_sse_outcome(
        provider_health: &V3ProviderFailureRuntimeHealth,
        failure_session_scope: &V3ProviderFailureSessionScope,
        provider_id: String,
        auth_alias: String,
        model_id: String,
        recorded: bool,
        permit: Option<V3ProviderActionPermit>,
    ) -> Self::SseOutcome;
    /// SSE 流投影（协议特定 unfold 状态机；wire protocol 由骨架传入）。
    /// `Err(V3RelayCoreError::WebSearchIntercepted)` 表示治理层拦截（fail-fast，不进失败链）。
    /// `retain_response_cipher`：同上，请求侧路由决策产物，响应侧 Resp03 消费。
    fn project_sse(
        request_id: &str,
        provider: V3ProviderSseStream,
        provider_wire_protocol: V3HubProviderWireProtocol,
        compatibility_profile: Option<String>,
        web_search_execution_mode: V3WebSearchExecutionMode,
        web_search_state: Option<V3WebSearchCenterState>,
        retain_response_cipher: bool,
        tool_thinking_enabled: bool,
        stream_observation: V3RuntimeStreamObservation,
        outcome: Self::SseOutcome,
    ) -> Result<V3RelayProjectedSseStream, V3RelayCoreError>;
    /// 组装 JSON 成功输出（observability 由骨架统一构建，codec 只负责写入
    /// 自身 Output 结构；控制语义只走 typed observability，不进 payload）。
    fn assemble_json_output(
        client_response: Value,
        trace: Vec<&'static str>,
        observability: V3RuntimeObservability,
        provider_snapshots: V3RelayProviderSnapshots,
    ) -> Self::Output;
    /// 组装 SSE 成功输出（stream_observation 供 server 在流收口后打印
    /// usage/终态；观测只读，不改写业务字节）。
    fn assemble_sse_output(
        sse: V3RelayCommittedSseStream,
        trace: Vec<&'static str>,
        observability: V3RuntimeObservability,
        stream_observation: V3RuntimeStreamObservation,
        provider_snapshots: V3RelayProviderSnapshots,
    ) -> Self::Output;
    /// 组装 provider failure 输出（terminal Error06）。
    fn assemble_failure_output(
        failure: V3RelayProviderFailure,
        trace: Vec<&'static str>,
    ) -> Self::Output;

    /// request 失败 body 形状（协议 wire 差异：gemini/responses 用 error.code，
    /// openai_chat 用 error.type，anthropic 用 {"type":"error",...}）。
    /// 默认共享 code 风格；协议 codec 按 wire 覆载。
    fn request_failure_builder(
        source_stage: &'static str,
        error_type: &'static str,
        error: impl std::fmt::Display,
    ) -> V3RelayProviderFailure {
        provider_request_failure(source_stage, error_type, error)
    }
}

/// relay 统一主循环骨架。
///
/// 生命周期（VR 重试 loop / provider action recovery / 错误策略循环）只在本函数；
/// 骨架上的逻辑（共享辅助、codec 方法）不持有生命周期。
pub async fn execute_v3_relay_runtime_core<'store, C, T>(
    manifest: &V3Config05ManifestPublished,
    server_id: &str,
    failure_session_scope: V3ProviderFailureSessionScope,
    request_id: &str,
    endpoint_path: &str,
    execution_mode: V3HubExecutionMode,
    payload: Value,
    transport: &T,
    provider_health: V3ProviderFailureRuntimeHealth,
    retry_policy: V3RelayProviderFailureRetryPolicy,
    continuation_lookup: V3HubContinuationLookup<'store>,
    provider_header_overrides: Vec<V3ProviderRequestHeader>,
    allow_exhaustion_rescue_probe: bool,
    initial_request_execution_control: Option<V3RequestExecutionControl>,
) -> Result<C::Output, V3RelayCoreError>
where
    C: V3RelayProtocolCodec,
    T: ResponsesTransport,
{
    compile_v3_hub_v1_static_registry()
        .map_err(|error| V3RelayCoreError::StaticRegistry(error.to_string()))?;
    let mut trace = Vec::with_capacity(17);
    // 统一 relay timing：internal = RouteCodex 处理，external = provider 等待；
    // 只写入 typed observability，不进入 payload。
    let runtime_timing = V3RuntimeTimingState::start();
    let transport_intent = if payload.get("stream").and_then(Value::as_bool) == Some(true) {
        V3HubTransportIntent::Sse
    } else {
        V3HubTransportIntent::Json
    };
    let requested_model = C::model_from_endpoint_path(endpoint_path)?;
    // 请求侧 hook profile（Mode B web-search 等）在 req01 之前计算，避免 payload move。
    let request_hook_profile = C::request_hook_profile(manifest, server_id, &payload)?;
    let req01 = build_v3_hub_req_inbound_01_client_raw(
        payload,
        C::ENTRY_PROTOCOL,
        V3HubInvocationSource::Client,
        transport_intent,
    );
    trace.push("V3HubReqInbound01ClientRaw");
    C::validate_client_payload(&req01.payload.0)?;
    let req02 = C::req_inbound_02(req01)?;
    trace.push("V3HubReqInbound02Normalized");
    // continuation lookup 由入口构建（协议差异：responses/anthropic 从 local store
    // 恢复上下文；openai/gemini 传无恢复的默认 lookup）。不可变区规则：
    // restore 只允许在 req_chatprocess 入口（req03 hooks 链）。
    let request_outcome = compile_v3_hub_relay_request_hooks()
        .run_from_normalized(req02, &continuation_lookup, &request_hook_profile)
        .map_err(|error| V3RelayCoreError::Target(error.to_string()))?;
    trace.push("V3HubReqContinuation03Classified");
    trace.push("V3HubReqChatProcess04Governed");
    let request_web_search_state = request_outcome.web_search_state().cloned();
    let request_tool_thinking_enabled = request_outcome.tool_thinking_enabled();
    let req04 = request_outcome.into_governed();
    if execution_mode != V3HubExecutionMode::Relay {
        return Err(V3RelayCoreError::Target(format!(
            "relay runtime received non-relay execution mode: {execution_mode:?}"
        )));
    }
    let req05 =
        build_v3_hub_req_execution_05_from_v3_hub_req_chat_process_04(req04, execution_mode);
    trace.push("V3HubReqExecution05Planned");
    let routing_payload = C::routing_payload(
        &req05.previous.previous.previous.previous.payload.0,
        &requested_model,
    )?;
    let routing_payload_ref: &Value = routing_payload.as_ref();
    let mut failed_candidates = BTreeSet::new();
    let mut retry_selected: Option<routecodex_v3_target::V3Target10ConcreteProviderSelected> = None;
    let mut pending_provider_action_recovery = None;
    let mut same_candidate_retries = BTreeMap::<String, usize>::new();
    let request_execution_control = match initial_request_execution_control {
        Some(control) => control,
        None => V3RequestExecutionControl::from_manifest(manifest, server_id).map_err(|error| {
            V3RelayCoreError::Target(format!(
                "V3ExecutionAttemptBudget rejected relay request: {error}"
            ))
        })?,
    };
    let attempt_budget = request_execution_control.attempt_budget();
    let deterministic_sample = v3_relay_provider_target_selection_sample(request_id);
    let failure_context = V3RelayProviderFailurePolicyContext {
        manifest,
        captured_target_09: None,
        failure_session_scope: failure_session_scope.clone(),
        provider_health: &provider_health,
        retry_policy,
        deterministic_sample,
    };
    loop {
        let selected = if let Some(selected) = retry_selected.take() {
            selected
        } else {
            let target_resolution_input = V3RelayProviderTargetResolutionInput {
                manifest,
                server_id,
                failure_session_scope: &failure_session_scope,
                entry_kind: C::ENTRY_KIND,
                endpoint_path,
                body: routing_payload_ref,
                request_local_excluded_candidates: &failed_candidates,
                provider_health: &provider_health,
                now_ms: v3_relay_provider_policy_now_epoch_ms()
                    .map_err(V3RelayCoreError::Target)?,
                deterministic_sample,
            };
            let target_resolution = if allow_exhaustion_rescue_probe {
                resolve_v3_relay_target_outcome_with_rescue(target_resolution_input).await
            } else {
                resolve_v3_relay_target_outcome(target_resolution_input)
            };
            match target_resolution {
                V3RelayProviderTargetResolution::Selected(selected) => selected,
                V3RelayProviderTargetResolution::Failed(source)
                    if source.source_kind == V3ErrorSourceKind::ModelNotFound =>
                {
                    return Err(V3RelayCoreError::ModelNotFound(source.message.clone()));
                }
                V3RelayProviderTargetResolution::Failed(source) => {
                    return Err(V3RelayCoreError::Target(format!(
                        "{}: {}",
                        source.code, source.message
                    )));
                }
                V3RelayProviderTargetResolution::Exhausted {
                    attempted_candidates,
                } => {
                    return Err(V3RelayCoreError::ProviderPoolExhausted {
                        attempted_candidates,
                    });
                }
            }
        };
        let selected_target_provider_id = selected.candidate.provider_id.clone();
        let selected_target_auth_alias = selected.candidate.auth_alias.clone();
        let selected_target_model_id = selected.candidate.model_id.clone();
        let selected_target_compatibility_profile =
            selected.candidate.compatibility_profile.clone();
        // VR 路由决策时一次性算出"是否保留响应密文"标记：仅 gpt 模型且目标计划只有
        // 单一 provider 候选时为 true（Codex 客户端需要 gpt 官方密文重建 reasoning
        // 历史；跨 provider 或非 gpt 场景一律不保留）。该标记经 codec 写入响应侧
        // Resp03 profile，响应侧只消费此结果，不重复判定。
        let retain_response_cipher = is_v3_retain_response_cipher(
            selected.route.target_plan.len(),
            &selected.candidate.model_id,
        );
        let provider_wire_protocol = C::wire_protocol(&selected.candidate)?;
        let req06 = build_v3_hub_req_target_06_from_v3_hub_req_execution_05(
            req05.clone(),
            V3HubTargetResolution::Routed,
            selected.candidate.clone(),
        );
        trace.push("V3HubReqTarget06Resolved");
        let req07 =
            build_v3_hub_req_outbound_07_from_v3_hub_req_target_06(req06, provider_wire_protocol);
        trace.push("V3HubReqOutbound07ProviderSemantic");
        let target = provider_target(manifest, req07.selected_target(), C::EXPECTED_PROVIDER_TYPE)
            .map_err(V3RelayCoreError::Target)?;
        macro_rules! handle_provider_request_failure {
            ($stage:expr, $kind:expr, $error:expr) => {{
                let terminal_failure = handle_provider_failure(
                    &failure_context,
                    selected,
                    C::request_failure_builder($stage, $kind, $error),
                    &mut V3RelayProviderFailurePolicyState {
                        failed_candidates: &mut failed_candidates,
                        same_candidate_retries: &mut same_candidate_retries,
                        trace: &mut trace,
                    },
                    &mut retry_selected,
                    &mut pending_provider_action_recovery,
                )
                .await
                .map_err(V3RelayCoreError::Target)?;
                if let Some(failure) = terminal_failure {
                    return Ok(C::assemble_failure_output(failure, trace));
                }
                continue;
            }};
        }
        let req_compat = match build_provider_req_compat_06_from_v3_hub_req_outbound_07(req07) {
            Ok(req_compat) => req_compat,
            Err(error) => handle_provider_request_failure!(
                "ProviderReqCompat06ProviderCompat",
                "provider_request_compat_error",
                error
            ),
        };
        trace.push("ProviderReqCompat06ProviderCompat");
        let req08 = build_v3_provider_req_outbound_08_from_provider_req_compat_06(req_compat);
        let req09 = build_v3_provider_req_outbound_09_from_v3_provider_req_outbound_08(req08);
        let provider_semantic = req09.into_provider_semantic_payload();
        trace.push("V3ProviderReqOutbound08WirePayload");
        let transport_request = match C::build_transport_request(
            request_id,
            target,
            transport_intent,
            provider_semantic,
            provider_header_overrides.clone(),
        ) {
            Ok(request) => request,
            Err(error) => handle_provider_request_failure!(
                "V3ProviderReqOutbound09TransportRequest",
                "provider_transport_request_error",
                error
            ),
        };
        let transport_request = if let Some((pipeline_id, port, runtime_generation)) =
            failure_session_scope.transport_handoff_scope()
        {
            let handoff_scope = routecodex_v3_provider_responses::V3ProviderTransportHandoffScope {
                pipeline_id: pipeline_id.to_string(),
                server_id: server_id.to_string(),
                port,
                session_scope: format!(
                    "{}:{}:{}",
                    failure_session_scope.server_id(),
                    failure_session_scope.routing_group(),
                    failure_session_scope.session_id()
                ),
                runtime_generation,
            };
            match transport_request.with_handoff_scope(handoff_scope) {
                Ok(request) => request,
                Err(error) => {
                    return Err(V3RelayCoreError::Target(format!(
                        "provider transport handoff scope: {error}"
                    )))
                }
            }
        } else {
            transport_request
        };
        trace.push("V3ProviderReqOutbound09TransportRequest");
        let provider_request_snapshot = transport_request.provider_request_projection();
        let mut provider_action_permit: Option<V3ProviderActionPermit> = None;
        if let Some(recovery) = pending_provider_action_recovery.take() {
            match provider_health
                .wait_for_error05_recovery(&recovery, &selected)
                .await
                .map_err(|error| V3RelayCoreError::Target(error.to_string()))?
            {
                V3ProviderActionRecoveryTransition::Admitted(mut admission) => {
                    provider_action_permit = admission.take_permit();
                    trace.push("V3ProviderActionGateAdmission");
                }
                V3ProviderActionRecoveryTransition::Superseded(ticket) => {
                    pending_provider_action_recovery = Some(
                        ticket
                            .recovery_witness()
                            .map_err(V3RelayCoreError::Target)?,
                    );
                    retry_selected = Some(selected);
                    trace.push("V3ProviderActionGateTerminalReevaluation");
                    continue;
                }
                V3ProviderActionRecoveryTransition::ReleasedBySuccess(ticket) => {
                    pending_provider_action_recovery = Some(
                        ticket
                            .recovery_witness()
                            .map_err(V3RelayCoreError::Target)?,
                    );
                    retry_selected = Some(selected);
                    trace.push("V3ProviderActionGateTerminalReevaluation");
                    continue;
                }
                V3ProviderActionRecoveryTransition::Consumed(_) => {
                    pending_provider_action_recovery = None;
                    retry_selected = Some(selected);
                    trace.push("V3ProviderActionGateConsumedReevaluation");
                    continue;
                }
            }
        }
        attempt_budget.admit_transport_attempt().map_err(|error| {
            V3RelayCoreError::Target(format!(
                "V3ExecutionAttemptBudget rejected provider transport attempt: {error}"
            ))
        })?;
        if let Err(timing_error) = runtime_timing.start_external() {
            return Err(V3RelayCoreError::Target(timing_error));
        }
        let provider_raw = match tokio::time::timeout(
            v3_relay_transport_response_timeout(manifest, &selected_target_provider_id),
            transport.send(transport_request),
        )
        .await
        .unwrap_or_else(|_elapsed| {
            // provider 挂起（响应头等待超时）：归一化为 Transport 错误进入错误链
            // （记录 provider failure + reselect 切 provider + 连续失败拉黑），
            // 避免客户端无限重试命中同一挂起 provider。
            Err(V3ProviderError::Transport {
                request_id: request_id.to_string(),
                provider_id: selected_target_provider_id.clone(),
                reason: "provider response header timed out (suspected hang)".to_string(),
            })
        }) {
            Ok(raw) => raw,
            Err(V3ProviderError::HttpStatus { response }) => {
                let failure = C::provider_http_failure(
                    response.status,
                    &response.body,
                    &selected_target_provider_id,
                );
                let _ = runtime_timing.finish_external();
                drop(provider_action_permit.take());
                if let Some(failure) = handle_provider_failure(
                    &failure_context,
                    selected,
                    failure,
                    &mut V3RelayProviderFailurePolicyState {
                        failed_candidates: &mut failed_candidates,
                        same_candidate_retries: &mut same_candidate_retries,
                        trace: &mut trace,
                    },
                    &mut retry_selected,
                    &mut pending_provider_action_recovery,
                )
                .await
                .map_err(V3RelayCoreError::Target)?
                {
                    return Ok(C::assemble_failure_output(failure, trace));
                }
                continue;
            }
            Err(error) => {
                let failure = provider_runtime_failure(error, &selected_target_provider_id);
                let _ = runtime_timing.finish_external();
                drop(provider_action_permit.take());
                if let Some(failure) = handle_provider_failure(
                    &failure_context,
                    selected,
                    failure,
                    &mut V3RelayProviderFailurePolicyState {
                        failed_candidates: &mut failed_candidates,
                        same_candidate_retries: &mut same_candidate_retries,
                        trace: &mut trace,
                    },
                    &mut retry_selected,
                    &mut pending_provider_action_recovery,
                )
                .await
                .map_err(V3RelayCoreError::Target)?
                {
                    return Ok(C::assemble_failure_output(failure, trace));
                }
                continue;
            }
        };
        if let Err(timing_error) = runtime_timing.finish_external() {
            return Err(V3RelayCoreError::Target(timing_error));
        }
        let provider_status = provider_raw.status();
        match provider_raw.into_body() {
            V3ProviderResponseBody::Json(bytes) => {
                let provider_value: Value = match serde_json::from_slice(&bytes) {
                    Ok(value) => value,
                    Err(error) => {
                        let failure = provider_runtime_failure(
                            V3ProviderError::ResponseBody {
                                request_id: request_id.to_string(),
                                provider_id: selected_target_provider_id.clone(),
                                reason: format!("provider JSON response decode failed: {error}"),
                            },
                            &selected_target_provider_id,
                        );
                        drop(provider_action_permit.take());
                        if let Some(failure) = handle_provider_failure(
                            &failure_context,
                            selected,
                            failure,
                            &mut V3RelayProviderFailurePolicyState {
                                failed_candidates: &mut failed_candidates,
                                same_candidate_retries: &mut same_candidate_retries,
                                trace: &mut trace,
                            },
                            &mut retry_selected,
                            &mut pending_provider_action_recovery,
                        )
                        .await
                        .map_err(V3RelayCoreError::Target)?
                        {
                            return Ok(C::assemble_failure_output(failure, trace));
                        }
                        continue;
                    }
                };
                let provider_response_snapshot = provider_value.clone();
                let client_response = match C::project_json_response(
                    &request_id,
                    failure_session_scope.session_id(),
                    provider_value,
                    provider_wire_protocol,
                    &req05.previous.previous.previous.previous.payload.0,
                    transport_intent,
                    &mut trace,
                    selected_target_compatibility_profile.as_deref(),
                    selected.candidate.web_search_execution_mode,
                    request_web_search_state.as_ref(),
                    retain_response_cipher,
                    request_tool_thinking_enabled,
                    &selected_target_model_id,
                ) {
                    Ok(client_response) => client_response,
                    // 治理层拦截但入口无投影路径：非 provider 失败，禁止进入失败
                    // 重试链，fail-fast 返回（openai_chat Mode B web-search 剥离）。
                    Err(V3RelayCoreError::WebSearchIntercepted(message)) => {
                        return Err(V3RelayCoreError::WebSearchIntercepted(message));
                    }
                    Err(error) => {
                        let failure = provider_runtime_failure(
                            V3ProviderError::ResponseBody {
                                request_id: request_id.to_string(),
                                provider_id: selected_target_provider_id.clone(),
                                reason: format!("provider response governance failed: {error}"),
                            },
                            &selected_target_provider_id,
                        );
                        drop(provider_action_permit.take());
                        if let Some(failure) = handle_provider_failure(
                            &failure_context,
                            selected,
                            failure,
                            &mut V3RelayProviderFailurePolicyState {
                                failed_candidates: &mut failed_candidates,
                                same_candidate_retries: &mut same_candidate_retries,
                                trace: &mut trace,
                            },
                            &mut retry_selected,
                            &mut pending_provider_action_recovery,
                        )
                        .await
                        .map_err(V3RelayCoreError::Target)?
                        {
                            return Ok(C::assemble_failure_output(failure, trace));
                        }
                        continue;
                    }
                };
                let attempt_success_receipt =
                    crate::nodes::V3AttemptSuccessReceipt::from_buffered_terminal_attempt();
                provider_health
                    .record_provider_success_in_failure_scope(
                        &attempt_success_receipt,
                        &failure_session_scope,
                        &selected_target_provider_id,
                        Some(&selected_target_auth_alias),
                        Some(&selected_target_model_id),
                        v3_relay_provider_policy_now_epoch_ms()
                            .map_err(V3RelayCoreError::Target)?,
                    )
                    .map_err(|error| V3RelayCoreError::Target(error.to_string()))?;
                let mut observability = build_v3_relay_observability(
                    C::ENTRY_KIND,
                    &selected,
                    if transport_intent == V3HubTransportIntent::Sse {
                        "sse"
                    } else {
                        "json"
                    },
                );
                observability.provider_status = Some(provider_status);
                observability.response_status = Some("completed".to_string());
                observability.finish_reason = read_v3_runtime_finish_reason(&client_response);
                observability.usage = extract_v3_runtime_usage_summary(&client_response);
                observability.timing = Some(
                    runtime_timing
                        .finish_runtime()
                        .map_err(|timing_error| V3RelayCoreError::Target(timing_error))?,
                );
                return Ok(C::assemble_json_output(
                    client_response,
                    trace,
                    observability,
                    V3RelayProviderSnapshots {
                        provider_request: Some(provider_request_snapshot),
                        provider_response: Some(provider_response_snapshot),
                    },
                ));
            }
            V3ProviderResponseBody::Sse(stream) => {
                push_sse_response_chain_trace(&mut trace);
                // 首帧守卫：provider SSE 首帧错误/空流/挂起在响应头前被捕获，
                // 走 provider 失败策略切 provider（客户端无感，对话不断流）。
                let sse_first_frame_timeout_ms = manifest
                    .providers
                    .get(&selected_target_provider_id)
                    .and_then(|provider| provider.sse_first_frame_timeout_ms);
                let guarded_stream = match guard_relay_sse_first_frame(
                    request_id,
                    &selected_target_provider_id,
                    provider_wire_protocol,
                    stream,
                    sse_first_frame_timeout_ms,
                )
                .await
                {
                    Ok(stream) => stream,
                    Err(error @ V3ProviderError::ClientDisconnect { .. }) => {
                        // The client owns this lifecycle termination. Do not feed it
                        // into provider Error01-05, health, retry, or reselect.
                        let failure = provider_runtime_failure(error, &selected_target_provider_id);
                        return Ok(C::assemble_failure_output(failure, trace));
                    }
                    Err(error) => {
                        let failure = provider_runtime_failure(error, &selected_target_provider_id);
                        drop(provider_action_permit.take());
                        if let Some(failure) = handle_provider_failure(
                            &failure_context,
                            selected,
                            failure,
                            &mut V3RelayProviderFailurePolicyState {
                                failed_candidates: &mut failed_candidates,
                                same_candidate_retries: &mut same_candidate_retries,
                                trace: &mut trace,
                            },
                            &mut retry_selected,
                            &mut pending_provider_action_recovery,
                        )
                        .await
                        .map_err(V3RelayCoreError::Target)?
                        {
                            return Ok(C::assemble_failure_output(failure, trace));
                        }
                        continue;
                    }
                };
                // 首帧已收：后续流仍受 idle guard 约束（provider 发一帧后挂起
                // provider 配置窗口 → 归一化为 Transport 错误进入错误链，客户端不无限等待）。
                let idle_guarded_stream = guard_v3_provider_sse_idle(
                    request_id,
                    &selected_target_provider_id,
                    guarded_stream,
                    v3_provider_sse_idle_timeout(manifest, &selected_target_provider_id)
                        .map_err(V3RelayCoreError::Target)?,
                );
                let stream_observation = V3RuntimeStreamObservation::default();
                let idle_guarded_stream =
                    observe_v3_provider_sse(idle_guarded_stream, stream_observation.clone());
                let projected_sse = match C::project_sse(
                    &request_id,
                    idle_guarded_stream,
                    provider_wire_protocol,
                    selected_target_compatibility_profile,
                    selected.candidate.web_search_execution_mode,
                    request_web_search_state.clone(),
                    retain_response_cipher,
                    request_tool_thinking_enabled,
                    stream_observation.clone(),
                    C::build_sse_outcome(
                        &provider_health,
                        &failure_session_scope,
                        selected_target_provider_id.clone(),
                        selected_target_auth_alias.clone(),
                        selected_target_model_id.clone(),
                        true,
                        None,
                    ),
                ) {
                    Ok(sse) => sse,
                    Err(error @ V3RelayCoreError::WebSearchIntercepted(_)) => {
                        drop(provider_action_permit.take());
                        return Err(error);
                    }
                    Err(error) => {
                        let failure = provider_runtime_failure(
                            V3ProviderError::ResponseBody {
                                request_id: request_id.to_string(),
                                provider_id: selected_target_provider_id.clone(),
                                reason: format!(
                                    "provider response event codec initialization failed: {error}"
                                ),
                            },
                            &selected_target_provider_id,
                        );
                        drop(provider_action_permit.take());
                        if let Some(failure) = handle_provider_failure(
                            &failure_context,
                            selected,
                            failure,
                            &mut V3RelayProviderFailurePolicyState {
                                failed_candidates: &mut failed_candidates,
                                same_candidate_retries: &mut same_candidate_retries,
                                trace: &mut trace,
                            },
                            &mut retry_selected,
                            &mut pending_provider_action_recovery,
                        )
                        .await
                        .map_err(V3RelayCoreError::Target)?
                        {
                            return Ok(C::assemble_failure_output(failure, trace));
                        }
                        continue;
                    }
                };
                let projected_sse = wrap_v3_relay_client_sse_usage_observation(
                    projected_sse,
                    C::ENTRY_PROTOCOL,
                    stream_observation.clone(),
                );

                // Broker arbitration owns the complete provider attempt.  No
                // projected byte crosses into the Front until the codec has
                // reached a successful terminal EOF.  A failure after any
                // number of frames discards the entire attempt and enters the
                // same Error01 -> Error05 policy path as pre-first-frame
                // transport failures.
                let mut committed_attempt = V3CommittedClientSseBuilder::with_budget(
                    attempt_budget.clone(),
                )
                .map_err(|error| {
                    V3RelayCoreError::Target(format!(
                        "V3ExecutionAttemptPayloadStore rejected relay attempt: {error}"
                    ))
                })?;
                let mut projected_sse = projected_sse;
                let stream_failure = loop {
                    match projected_sse.next().await {
                        Some(Ok(frame)) => {
                            if let Err(error) = committed_attempt.push(frame) {
                                break Some(V3RelayAttemptCollectFailure::LocalStore(error));
                            }
                            match stream_observation.has_semantic_terminal() {
                                Ok(true) => {
                                    if let Err(error) =
                                        committed_attempt.mark_last_frame_as_terminal()
                                    {
                                        break Some(V3RelayAttemptCollectFailure::LocalStore(
                                            error,
                                        ));
                                    }
                                }
                                Ok(false) => {}
                                Err(reason) => {
                                    break Some(V3RelayAttemptCollectFailure::Observation(reason))
                                }
                            }
                        }
                        Some(Err(reason)) => {
                            break Some(V3RelayAttemptCollectFailure::Provider(reason))
                        }
                        None => break None,
                    }
                };
                if let Some(failure) = stream_failure {
                    let reason = match failure {
                        V3RelayAttemptCollectFailure::LocalStore(error) => {
                            drop(provider_action_permit.take());
                            return Err(V3RelayCoreError::Target(format!(
                                "V3ExecutionAttemptPayloadStore relay local resource failure: {error}"
                            )));
                        }
                        V3RelayAttemptCollectFailure::Observation(error) => {
                            drop(provider_action_permit.take());
                            return Err(V3RelayCoreError::Target(format!(
                                "V3RuntimeStreamObservation relay control failure: {error}"
                            )));
                        }
                        V3RelayAttemptCollectFailure::Provider(reason) => reason,
                    };
                    drop(provider_action_permit.take());
                    if reason.starts_with("ROUTECODEX_GOVERNANCE_REJECTED") {
                        return Err(V3RelayCoreError::WebSearchIntercepted(reason));
                    }
                    let failure = provider_runtime_failure(
                        V3ProviderError::ResponseBody {
                            request_id: request_id.to_string(),
                            provider_id: selected_target_provider_id.clone(),
                            reason: format!("provider response event codec failed: {reason}"),
                        },
                        &selected_target_provider_id,
                    );
                    if let Some(failure) = handle_provider_failure(
                        &failure_context,
                        selected,
                        failure,
                        &mut V3RelayProviderFailurePolicyState {
                            failed_candidates: &mut failed_candidates,
                            same_candidate_retries: &mut same_candidate_retries,
                            trace: &mut trace,
                        },
                        &mut retry_selected,
                        &mut pending_provider_action_recovery,
                    )
                    .await
                    .map_err(V3RelayCoreError::Target)?
                    {
                        return Ok(C::assemble_failure_output(failure, trace));
                    }
                    continue;
                }
                let committed_sse = match committed_attempt.seal_after_validated_terminal() {
                    Ok(committed_sse) => committed_sse,
                    Err(error) => {
                        drop(provider_action_permit.take());
                        return Err(V3RelayCoreError::Target(format!(
                            "V3ExecutionAttemptPayloadStore could not seal relay attempt: {error}"
                        )));
                    }
                };
                drop(provider_action_permit.take());
                let attempt_success_receipt =
                    crate::nodes::V3AttemptSuccessReceipt::from_sealed_sse_attempt(&committed_sse);
                provider_health
                    .record_provider_success_in_failure_scope(
                        &attempt_success_receipt,
                        &failure_session_scope,
                        &selected_target_provider_id,
                        Some(&selected_target_auth_alias),
                        Some(&selected_target_model_id),
                        v3_relay_provider_policy_now_epoch_ms()
                            .map_err(V3RelayCoreError::Target)?,
                    )
                    .map_err(|error| V3RelayCoreError::Target(error.to_string()))?;
                let mut observability =
                    build_v3_relay_observability(C::ENTRY_KIND, &selected, "sse");
                observability.provider_status = Some(provider_status);
                observability.response_status = Some("completed".to_string());
                observability.usage = stream_observation
                    .snapshot()
                    .ok()
                    .and_then(|snapshot| snapshot.usage);
                observability.timing = Some(
                    runtime_timing
                        .finish_runtime()
                        .map_err(|timing_error| V3RelayCoreError::Target(timing_error))?,
                );
                return Ok(C::assemble_sse_output(
                    committed_sse,
                    trace,
                    observability,
                    stream_observation,
                    V3RelayProviderSnapshots {
                        provider_request: Some(provider_request_snapshot),
                        provider_response: None,
                    },
                ));
            }
        }
    }
}

#[cfg(test)]
#[path = "relay_runtime_core_tests.rs"]
mod tests;
