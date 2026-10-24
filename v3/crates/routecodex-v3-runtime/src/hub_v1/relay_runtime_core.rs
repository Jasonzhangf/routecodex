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

use super::relay_runtime_shared::{
    handle_provider_failure_with_response_code, provider_response_governance_failure,
    relay_handoff_entry_state,
};
use super::*;
use crate::nodes::{V3AttemptStoreError, V3CommittedClientSseBuilder};
use crate::operation_runner::plan_execution::{
    run_v3_plan_execution_operator_with_probes, V3PlanExecutionModePolicy, V3PlanExecutionStop,
    V3PlanExecutionTargetSource,
};
use crate::provider_action_gate::{V3ProviderActionPermit, V3ProviderActionRecoveryTransition};
use crate::provider_failure_runtime_policy::v3_relay_provider_candidate_key;
use crate::provider_failure_runtime_policy::{
    admit_v3_selected_target_after_recovery, v3_relay_provider_policy_now_epoch_ms,
    v3_relay_provider_target_selection_sample, V3AdmitAfterRecovery,
    V3ProviderFailureRuntimeHealth, V3RelayProviderFailurePolicyContext,
    V3RelayProviderFailurePolicyState, V3RelayProviderFailureRetryPolicy,
    V3RuntimeProviderAdmission,
};
use futures_util::StreamExt;
use routecodex_v3_config::V3Config05ManifestPublished;
use routecodex_v3_error::V3ProviderFailureSessionScope;
use routecodex_v3_provider_responses::{
    ResponsesTransport, V3ProviderError, V3ProviderRequestHeader, V3ProviderResponseBody,
    V3ProviderSseStream, V3ResponsesProviderTarget, V3Transport13ResponsesHttpRequest,
};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};

enum V3RelayAttemptCollectFailure {
    ResponseGovernance(V3HubRelayResponseError),
    ProviderResponseBody(String),
    ProviderTransport(String),
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
    allow_responses_incomplete: bool,
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
                    if allow_responses_incomplete
                        && provider_protocol == V3HubProviderWireProtocol::Responses
                    {
                        let terminal = serde_json::from_str::<Value>(&data).ok();
                        if terminal
                            .as_ref()
                            .and_then(|event| event.get("type"))
                            .and_then(Value::as_str)
                            == Some("response.incomplete")
                            && matches!(
                                terminal.as_ref().and_then(|event| {
                                    event
                                        .pointer("/response/incomplete_details/reason")
                                        .or_else(|| event.pointer("/incomplete_details/reason"))
                                        .and_then(Value::as_str)
                                }),
                                Some("max_output_tokens" | "content_filter")
                            )
                        {
                            first_semantic_frame_seen = true;
                            break;
                        }
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
pub(crate) fn guard_v3_provider_sse_attempt_deadline(
    request_id: &str,
    provider_id: &str,
    stream: routecodex_v3_provider_responses::V3ProviderSseStream,
    deadline: std::time::Instant,
) -> routecodex_v3_provider_responses::V3ProviderSseStream {
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
                if std::time::Instant::now() >= deadline {
                    return Some((
                        Err(V3ProviderError::Transport {
                            request_id,
                            provider_id,
                            reason: "provider SSE attempt exceeded the request residence deadline before a semantic terminal".to_string(),
                        }),
                        (stream, true),
                    ));
                }
                match tokio::time::timeout_at(
                    tokio::time::Instant::from_std(deadline),
                    stream.next(),
                )
                .await
                {
                    Ok(Some(chunk)) => Some((chunk, (stream, false))),
                    Ok(None) => None,
                    Err(_) => Some((
                        Err(V3ProviderError::Transport {
                            request_id,
                            provider_id,
                            reason: "provider SSE attempt exceeded the request residence deadline before a semantic terminal".to_string(),
                        }),
                        (stream, true),
                    )),
                }
            }
        },
    ))
}

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

pub(crate) use super::relay_runtime_shared::{
    bind_v3_selected_business_auth_kind, v3_provider_sse_idle_timeout,
    v3_relay_transport_response_timeout, V3RelayCoreError,
};

/// 单次执行完成后，codec 从治理后响应里发布的 Chat Process 事实与治理后
/// canonical payload。它只服务共享续杯策略：`facts` 是策略的四项输入，
/// `finalized_response` 用于构造续请求历史与合并前几轮业务项。任何字段都不进入
/// 业务 metadata。
#[derive(Debug, Clone)]
pub(crate) struct V3RelayChatProcessRound {
    pub(crate) facts: super::resp_chat_process_03_governed::V3ChatProcessGovernedFacts,
    /// 本次执行是否到达 completed 终态。
    pub(crate) response_completed: bool,
    /// 本次执行治理后的 canonical payload（仅本次执行，未合并前几轮）。
    pub(crate) finalized_response: Value,
}

/// 单个客户端请求的续杯载体，由入口调用方创建一次并在该请求的每次执行间复用，
/// 因此连续续杯额度不会在轮间被重置。骨架只写 `round`，调用方只读它并决定是否
/// 发起下一次执行。
pub(crate) struct V3RelayRefillCarrier {
    pub(crate) request_execution_control: crate::nodes::V3RequestExecutionControl,
    /// 前几轮已完成的业务 output 项，按交付顺序存放。
    pub(crate) accumulated_items: Vec<Value>,
    /// 前几轮已完成执行的 usage 合计；`None` 表示还没有已合并的轮次。
    pub(crate) accumulated_usage: Option<V3RuntimeUsageSummary>,
    /// 骨架在成功的 JSON 出口发布；SSE 出口与失败出口不发布。
    pub(crate) round: Option<V3RelayChatProcessRound>,
}

/// 发布本次执行完成后可供共享续杯策略使用的事实与治理后 canonical payload。
///
/// codec 在治理完成后、投影到客户端协议之前调用；这是骨架与入口读取 round 的
/// 唯一来源，失败出口与 SSE 出口不调用它。
///
/// `source_terminal_completed`：源终态标记。JSON 出口的源终态只是传输层标记，
/// 并不等价于业务完成，因此完成判定优先读治理后 canonical 的 `status`；该标记只
/// 作为补充信号，保证 SSE 物化路径同样能给出 completed 事实。
pub(crate) fn publish_v3_relay_chat_process_round(
    governed: &super::resp_chat_process_03_governed::V3HubRespChatProcess03Governed,
    has_source_summary: bool,
    source_terminal_completed: bool,
    refill: &mut V3RelayRefillCarrier,
) {
    let finalized_response = governed.finalized_payload().clone();
    let governed_completed = finalized_response
        .get("status")
        .and_then(Value::as_str)
        .map(str::trim)
        == Some("completed");
    refill.round = Some(V3RelayChatProcessRound {
        facts: super::resp_chat_process_03_governed::V3ChatProcessGovernedFacts {
            tool_calls:
                super::resp_chat_process_03_governed::collect_v3_governed_response_tool_calls(
                    &finalized_response,
                ),
            has_source_summary,
        },
        response_completed: governed_completed || source_terminal_completed,
        finalized_response,
    });
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

    /// 请求侧 hook profile.
    fn request_hook_profile(
        manifest: &V3Config05ManifestPublished,
        server_id: &str,
        payload: &Value,
    ) -> Result<V3HubRequestHookProfile, V3RelayCoreError>;

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
    /// JSON 响应投影（resp01 -> 02 -> 03 -> 04 -> 05 -> 06）。
    /// `retain_response_cipher`：请求侧 VR 路由决策算好的"保留响应密文"标记（仅 gpt
    /// 单 provider 候选时为 true），响应侧 Resp03 只消费该结果。
    ///
    /// `refill`：codec 读取其中前几轮业务项与 usage，在治理后、投影前合并进本次
    /// 响应；并把本次执行的 Chat Process 事实与治理后 canonical payload 写入
    /// `refill.round`，供共享续杯策略使用。
    fn project_json_response(
        request_id: &str,
        session_id: &str,
        provider_value: Value,
        provider_wire_protocol: V3HubProviderWireProtocol,
        chat_request: &Value,
        transport_intent: V3HubTransportIntent,
        trace: &mut Vec<&'static str>,
        compatibility_profile: Option<&str>,
        retain_response_cipher: bool,
        tool_thinking_enabled: bool,
        expected_model_id: &str,
        namespace_registry: &provider_compat_core::namespace_tools::NamespaceToolIdentityRegistry,
        refill: &mut V3RelayRefillCarrier,
    ) -> Result<Value, V3RelayCoreError>;
    /// 构建 SSE provider outcome。
    fn build_sse_outcome(
        provider_health: &V3ProviderFailureRuntimeHealth,
        failure_session_scope: &V3ProviderFailureSessionScope,
        provider_id: String,
        interface_id: String,
        auth_alias: String,
        model_id: String,
        recorded: bool,
        permit: Option<V3ProviderActionPermit>,
    ) -> Self::SseOutcome;
    /// SSE 流投影（协议特定 unfold 状态机；wire protocol 由骨架传入）。
    /// `retain_response_cipher`：同上，请求侧路由决策产物，响应侧 Resp03 消费。
    fn project_sse(
        request_id: &str,
        provider: V3ProviderSseStream,
        provider_wire_protocol: V3HubProviderWireProtocol,
        compatibility_profile: Option<String>,
        retain_response_cipher: bool,
        tool_thinking_enabled: bool,
        stream_observation: V3RuntimeStreamObservation,
        client_include_usage: bool,
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
        provider_failure_events: Vec<V3RuntimeProviderFailureObservation>,
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
pub async fn execute_v3_relay_runtime_core<C, T>(
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
    provider_header_overrides: Vec<V3ProviderRequestHeader>,
    allow_exhaustion_rescue_probe: bool,
    initial_handoff: Option<crate::V3ResponsesProtocolRelayHandoff>,
    failure_events: &mut Vec<V3RuntimeProviderFailureObservation>,
    // 请求作用域的续杯载体：控制由入口创建并在本请求的每次执行间复用，骨架只写
    // `round`。这样连续续杯额度不按执行重置，也不跨请求共享。
    refill: &mut V3RelayRefillCarrier,
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
    let (
        runtime_timing,
        mut failed_candidates,
        mut request_local_busy_candidates,
        mut retry_selected,
    ) = relay_handoff_entry_state(initial_handoff.as_ref());
    let transport_intent = if payload.get("stream").and_then(Value::as_bool) == Some(true)
        || (C::ENTRY_PROTOCOL == V3HubEntryProtocol::Gemini
            && endpoint_path.ends_with(":streamGenerateContent"))
    {
        V3HubTransportIntent::Sse
    } else {
        V3HubTransportIntent::Json
    };
    let requested_model = C::model_from_endpoint_path(endpoint_path)?;
    // 请求侧 hook profile（Mode B web-search 等）在 req01 之前计算，避免 payload move。
    let request_hook_profile = C::request_hook_profile(manifest, server_id, &payload)?;
    let client_include_usage = payload
        .pointer("/stream_options/include_usage")
        .and_then(Value::as_bool)
        == Some(true);
    let req01 = build_v3_hub_req_inbound_01_client_raw(
        payload,
        C::ENTRY_PROTOCOL,
        V3HubInvocationSource::Client,
        transport_intent,
    );
    trace.push("V3HubReqInbound01ClientRaw");
    // stage-3 丢弃上下文：ReqInbound02 会用 canonical 覆盖 `payload`，此处先保留
    // 客户端原始 payload 的 Arc 句柄。
    let raw = std::sync::Arc::clone(&req01.payload.0);
    let drop_ctx = crate::projection_drop_log::V3ProjectionDropContext::from_manifest(
        manifest, server_id, request_id, raw,
    );
    C::validate_client_payload(&req01.payload.0)?;
    let mut req02 = C::req_inbound_02(req01)?;
    trace.push("V3HubReqInbound02Normalized");
    let deterministic_sample = v3_relay_provider_target_selection_sample(request_id);
    let resolve_mode = match initial_handoff.as_ref() {
        Some(handoff) => crate::operation_runner::V3ResolveTargetExecutionMode::CapturedHandoff {
            opaque_hit: handoff.expanded.route.clone(),
            route_policy_pending: handoff.route_policy_pending.clone(),
            route_policy_scope: handoff.route_policy_scope.clone(),
        },
        None => crate::operation_runner::V3ResolveTargetExecutionMode::RelayFresh {
            manifest: std::sync::Arc::new(manifest.clone()),
            server_id: server_id.to_string(),
            entry_kind: C::ENTRY_KIND.to_string(),
            endpoint_path: endpoint_path.to_string(),
            requested_model: (C::ENTRY_PROTOCOL == V3HubEntryProtocol::Gemini)
                .then_some(requested_model),
            deterministic_sample,
        },
    };
    let (target_resolved_request, resolved_target) =
        match crate::operation_runner::run_v3_resolve_target_operator(
            (*req02.previous.payload.0).clone(),
            resolve_mode,
        ) {
            Ok(resolved) => resolved,
            Err(crate::operation_runner::V3ResolveTargetOperatorError::Typed(source)) => {
                return Err(V3RelayCoreError::Target(format!(
                    "{}: {}",
                    source.code, source.message
                )));
            }
            Err(crate::operation_runner::V3ResolveTargetOperatorError::OperatorFault(fault)) => {
                return Ok(C::assemble_failure_output(
                    super::relay_runtime_shared::provider_operator_fault_failure(fault),
                    trace,
                    std::mem::take(failure_events),
                ));
            }
            Err(crate::operation_runner::V3ResolveTargetOperatorError::Runner(error)) => {
                return Err(V3RelayCoreError::Target(error.to_string()));
            }
        };
    let route_policy_pending = resolved_target.route_policy_pending;
    if execution_mode != V3HubExecutionMode::Relay {
        return Err(V3RelayCoreError::Target(format!(
            "relay runtime received non-relay execution mode: {execution_mode:?}"
        )));
    }
    let target_source = match initial_handoff.as_ref() {
        Some(handoff) => V3PlanExecutionTargetSource::Expanded(handoff.expanded.clone()),
        None => V3PlanExecutionTargetSource::OpaqueHit(resolved_target.opaque_hit),
    };
    let (execution_planned_request, initial_plan) =
        match run_v3_plan_execution_operator_with_probes(
            target_resolved_request,
            manifest,
            target_source,
            &failure_session_scope,
            &provider_health,
            &failed_candidates,
            &request_local_busy_candidates,
            v3_relay_provider_policy_now_epoch_ms().map_err(V3RelayCoreError::Target)?,
            deterministic_sample,
            allow_exhaustion_rescue_probe,
            retry_selected.take(),
            V3PlanExecutionModePolicy::RelayOnly {
                entry_protocol: C::ENTRY_PROTOCOL,
            },
        )
        .await
        {
            Ok(plan) => plan,
            Err(V3PlanExecutionStop::Failed(source)) => {
                return Err(V3RelayCoreError::Target(format!(
                    "{}: {}",
                    source.code, source.message
                )));
            }
            Err(V3PlanExecutionStop::OperatorFault(fault)) => {
                return Ok(C::assemble_failure_output(
                    super::relay_runtime_shared::provider_operator_fault_failure(fault),
                    trace,
                    std::mem::take(failure_events),
                ));
            }
            Err(V3PlanExecutionStop::Exhausted {
                expanded: exhausted_expanded,
                exhaustion,
                source,
                ..
            }) => {
                let source = match source {
                    Some(source) => Some(source),
                    None => match crate::provider_failure_runtime_policy::v3_pure_all_busy_exhaustion_source(
                        &exhausted_expanded,
                        &failed_candidates,
                        &request_local_busy_candidates,
                    ) {
                        Ok(source) => source,
                        Err(fault) => {
                            return Ok(C::assemble_failure_output(
                                super::relay_runtime_shared::provider_operator_fault_failure(fault),
                                trace,
                                std::mem::take(failure_events),
                            ))
                        }
                    },
                };
                let failure = C::request_failure_builder(
                    "V3Target10ConcreteProviderSelected",
                    "selected_target_exhausted",
                    format!(
                        "selected target exhausted after {:?}",
                        exhaustion.attempted_candidates
                    ),
                );
                return Ok(C::assemble_failure_output(
                    super::relay_runtime_shared::terminalize_provider_failure_with_source(
                        failure, source, None,
                    ),
                    trace,
                    std::mem::take(failure_events),
                ));
            }
        };
    req02.previous.payload.0 = std::sync::Arc::new(execution_planned_request);
    let retained_expanded = initial_plan.expanded;
    failed_candidates.extend(initial_plan.request_local_excluded_candidates);
    request_local_busy_candidates.extend(initial_plan.request_local_busy_candidates);
    let planned_execution_mode = initial_plan.execution_mode;
    let mut initial_admitted = Some((initial_plan.selected, initial_plan.admission));
    let request_outcome = compile_v3_hub_relay_request_hooks()
        .run_from_normalized(req02, &request_hook_profile)
        .map_err(|error| V3RelayCoreError::Target(error.to_string()))?;
    trace.push("V3HubReqChatProcess04Governed");
    let request_tool_thinking_enabled = request_outcome.tool_thinking_enabled();
    let req04 = request_outcome.into_governed();
    let mut req05 = build_v3_hub_req_execution_05_from_v3_hub_req_chat_process_04(
        req04,
        planned_execution_mode,
    );
    trace.push("V3HubReqExecution05Planned");
    let mut pending_provider_action_recovery = None;
    let mut provider_action_permit: Option<V3ProviderActionPermit> = None;
    let mut provider_action_permit_target: Option<routecodex_v3_target::V3TargetCandidate> = None;
    let mut same_candidate_retries = BTreeMap::<String, usize>::new();
    let mut last_external_http = None;
    // 入口已按 handoff 建好请求作用域控制；骨架只消费它，确保同一请求的多次
    // 执行共享同一份续杯额度与驻留截止时间。
    let request_execution_control = refill.request_execution_control.clone();
    let attempt_budget = request_execution_control.attempt_budget();
    let failure_context = V3RelayProviderFailurePolicyContext {
        manifest,
        captured_target_09: Some(&retained_expanded),
        failure_session_scope: failure_session_scope.clone(),
        provider_health: &provider_health,
        retry_policy,
        deterministic_sample,
    };
    loop {
        let preferred_selected = retry_selected.take();
        let (selected, mut selected_admission): (
            routecodex_v3_target::V3Target10ConcreteProviderSelected,
            Option<V3RuntimeProviderAdmission>,
        ) = if let Some((selected, admission)) = initial_admitted.take() {
            (selected, Some(admission))
        } else {
            let target_resolution = run_v3_plan_execution_operator_with_probes(
                (*req05.previous.previous.previous.payload.0).clone(),
                manifest,
                V3PlanExecutionTargetSource::Expanded(retained_expanded.clone()),
                &failure_session_scope,
                &provider_health,
                &failed_candidates,
                &request_local_busy_candidates,
                v3_relay_provider_policy_now_epoch_ms().map_err(V3RelayCoreError::Target)?,
                deterministic_sample,
                allow_exhaustion_rescue_probe,
                preferred_selected,
                V3PlanExecutionModePolicy::RelayOnly {
                    entry_protocol: C::ENTRY_PROTOCOL,
                },
            )
            .await;
            match target_resolution {
                Ok((execution_planned_request, plan)) => {
                    req05.previous.previous.previous.payload.0 =
                        std::sync::Arc::new(execution_planned_request);
                    failed_candidates.extend(plan.request_local_excluded_candidates);
                    request_local_busy_candidates.extend(plan.request_local_busy_candidates);
                    (plan.selected, Some(plan.admission))
                }
                Err(V3PlanExecutionStop::Failed(source)) => {
                    return Err(V3RelayCoreError::Target(format!(
                        "{}: {}",
                        source.code, source.message
                    )));
                }
                Err(V3PlanExecutionStop::OperatorFault(fault)) => {
                    return Ok(C::assemble_failure_output(
                        terminalize_provider_failure(
                            super::relay_runtime_shared::provider_operator_fault_failure(fault),
                            last_external_http.clone(),
                        ),
                        trace,
                        std::mem::take(failure_events),
                    ));
                }
                Err(V3PlanExecutionStop::Exhausted {
                    expanded: exhausted_expanded,
                    exhaustion,
                    source,
                    ..
                }) => {
                    let source = match source {
                        Some(source) => Some(source),
                        None => match crate::provider_failure_runtime_policy::v3_pure_all_busy_exhaustion_source(
                            &exhausted_expanded,
                            &failed_candidates,
                            &request_local_busy_candidates,
                        ) {
                            Ok(source) => source,
                            Err(fault) => {
                                return Ok(C::assemble_failure_output(
                                    terminalize_provider_failure(
                                        super::relay_runtime_shared::provider_operator_fault_failure(fault),
                                        last_external_http.clone(),
                                    ),
                                    trace,
                                    std::mem::take(failure_events),
                                ))
                            }
                        },
                    };
                    let attempted_candidates = exhaustion.attempted_candidates;
                    let failure = C::request_failure_builder(
                        "V3Target10ConcreteProviderSelected",
                        "selected_target_exhausted",
                        format!("selected target exhausted after {attempted_candidates:?}"),
                    );
                    return Ok(C::assemble_failure_output(
                        super::relay_runtime_shared::terminalize_provider_failure_with_source(
                            failure,
                            source,
                            last_external_http.clone(),
                        ),
                        trace,
                        std::mem::take(failure_events),
                    ));
                }
            }
        };
        if provider_action_permit_target
            .as_ref()
            .is_some_and(|target| {
                target.provider_id != selected.candidate.provider_id
                    || target.interface_id != selected.candidate.interface_id
                    || target.auth_alias != selected.candidate.auth_alias
                    || target.model_id != selected.candidate.model_id
            })
        {
            drop(provider_action_permit.take());
            provider_action_permit_target = None;
        }
        attempt_budget.set_transport_attempt_limit(selected.candidate_count);
        let selected_target_provider_id = selected.candidate.provider_id.clone();
        let selected_target_interface_id = selected.candidate.interface_id.clone();
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
        let provider_wire_protocol = match C::wire_protocol(&selected.candidate) {
            Ok(protocol) => protocol,
            Err(error) => {
                let terminal_failure = handle_provider_failure(
                    &failure_context,
                    selected,
                    C::request_failure_builder(
                        "V3ProviderTarget06WireProtocol",
                        "provider_wire_protocol_unsupported",
                        error,
                    ),
                    &mut V3RelayProviderFailurePolicyState {
                        failed_candidates: &mut failed_candidates,
                        same_candidate_retries: &mut same_candidate_retries,
                        trace: &mut trace,
                        last_external_http: &mut last_external_http,
                    },
                    &mut retry_selected,
                    &mut pending_provider_action_recovery,
                    failure_events,
                )
                .await
                .map_err(V3RelayCoreError::Target)?;
                if let Some(failure) = terminal_failure {
                    return Ok(C::assemble_failure_output(
                        failure,
                        trace,
                        std::mem::take(failure_events),
                    ));
                }
                continue;
            }
        };
        let req06 = build_v3_hub_req_target_06_from_v3_hub_req_execution_05(
            req05.clone(),
            V3HubTargetResolution::Routed,
            selected.candidate.clone(),
        );
        trace.push("V3HubReqTarget06Resolved");
        let req07 =
            build_v3_hub_req_outbound_07_from_v3_hub_req_target_06(req06, provider_wire_protocol);
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
                        last_external_http: &mut last_external_http,
                    },
                    &mut retry_selected,
                    &mut pending_provider_action_recovery,
                    failure_events,
                )
                .await
                .map_err(V3RelayCoreError::Target)?;
                if let Some(failure) = terminal_failure {
                    return Ok(C::assemble_failure_output(
                        failure,
                        trace,
                        std::mem::take(failure_events),
                    ));
                }
                continue;
            }};
        }
        let req07 = match req07 {
            Ok(req07) => req07,
            Err(error) => handle_provider_request_failure!(
                "V3HubReqOutbound07ProviderSemantic",
                "provider_request_projection_error",
                error
            ),
        };
        trace.push("V3HubReqOutbound07ProviderSemantic");
        let target = provider_target(manifest, req07.selected_target(), C::EXPECTED_PROVIDER_TYPE)
            .map_err(V3RelayCoreError::Target)?;
        let req_compat = match build_provider_req_compat_06_from_v3_hub_req_outbound_07(req07) {
            Ok(projected) => record_projected_drops(&drop_ctx, projected),
            Err(error) => handle_provider_request_failure!(
                "ProviderReqCompat06ProviderCompat",
                "provider_request_compat_error",
                error
            ),
        };
        trace.push("ProviderReqCompat06ProviderCompat");
        let stream_intent = (provider_wire_protocol == V3HubProviderWireProtocol::Gemini)
            .then_some(match transport_intent {
                V3HubTransportIntent::Json => {
                    routecodex_v3_provider_responses::V3ResponsesStreamIntent::Json
                }
                V3HubTransportIntent::Sse => {
                    routecodex_v3_provider_responses::V3ResponsesStreamIntent::Sse
                }
            });
        let namespace_registry = req_compat.namespace_registry.clone();
        let (req08, _) = match build_v3_provider_req_outbound_08_wire_from_compat_06(
            req_compat,
            request_id,
            target,
            stream_intent,
        ) {
            Ok(encoded) => encoded,
            Err(error) => handle_provider_request_failure!(
                "V3ProviderReqOutbound08WirePayload",
                "provider_request_wire_error",
                error
            ),
        };
        trace.push("V3ProviderReqOutbound08WirePayload");
        let transport_request = match build_v3_provider_req_outbound_09_transport_from_wire(
            req08,
            provider_header_overrides.clone(),
        ) {
            Ok(request) => request,
            Err(error) => handle_provider_request_failure!(
                "V3ProviderReqOutbound09TransportRequest",
                "provider_transport_request_error",
                error
            ),
        };
        let transport_request = match bind_v3_selected_business_auth_kind(
            manifest,
            &selected.candidate,
            provider_wire_protocol,
            transport_request,
        ) {
            Ok(request) => request,
            Err(error) => handle_provider_request_failure!(
                "V3ProviderReqOutbound09TransportRequest",
                "provider_transport_auth_kind_error",
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
        if pending_provider_action_recovery.is_some() {
            drop(selected_admission.take());
        }
        if let Some(recovery) = pending_provider_action_recovery.take() {
            match provider_health
                .wait_for_error05_recovery(&recovery, &selected)
                .await
                .map_err(|error| V3RelayCoreError::Target(error.to_string()))?
            {
                V3ProviderActionRecoveryTransition::Admitted(mut admission) => {
                    provider_action_permit = admission.take_permit();
                    provider_action_permit_target = Some(selected.candidate.clone());
                    match admit_v3_selected_target_after_recovery(&selected) {
                        V3AdmitAfterRecovery::Admitted(admission) => {
                            selected_admission = Some(admission)
                        }
                        V3AdmitAfterRecovery::Busy => {
                            let busy_key = v3_relay_provider_candidate_key(&selected.candidate);
                            failed_candidates.insert(busy_key.clone());
                            request_local_busy_candidates.insert(busy_key);
                            drop(provider_action_permit.take());
                            provider_action_permit_target = None;
                            continue;
                        }
                        V3AdmitAfterRecovery::Failed(reason) => {
                            return Err(V3RelayCoreError::Target(reason))
                        }
                    }
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
        let transport_attempt = attempt_budget.admit_transport_attempt().map_err(|error| {
            V3RelayCoreError::Target(format!(
                "V3ExecutionAttemptBudget rejected provider transport attempt: {error}"
            ))
        })?;
        if let Err(timing_error) = runtime_timing.start_external() {
            return Err(V3RelayCoreError::Target(timing_error));
        }
        let transport_request = match selected_admission.take() {
            Some(admission) => {
                transport_request.with_pre_acquired_admission(admission.into_lease())
            }
            None => transport_request,
        };
        let attempt_timeout =
            v3_relay_transport_response_timeout(manifest, &selected_target_provider_id);
        let attempt_deadline = tokio::time::Instant::now() + attempt_timeout;
        let provider_raw =
            match tokio::time::timeout_at(attempt_deadline, transport.send(transport_request))
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
                Err(V3ProviderError::ConcurrencyBusy { .. }) => {
                    runtime_timing
                        .finish_external()
                        .map_err(V3RelayCoreError::Target)?;
                    let busy_key = v3_relay_provider_candidate_key(&selected.candidate);
                    failed_candidates.insert(busy_key.clone());
                    request_local_busy_candidates.insert(busy_key);
                    drop(provider_action_permit.take());
                    provider_action_permit_target = None;
                    continue;
                }
                Err(V3ProviderError::HttpStatus { response }) => {
                    last_external_http = Some(
                        crate::hub_v1::relay_runtime_shared::external_http_witness(&response),
                    );
                    let mut failure = if response.body_read_failure.is_some() {
                        crate::hub_v1::relay_runtime_shared::provider_http_body_read_failure(
                            &response,
                            &selected_target_provider_id,
                        )
                    } else {
                        C::provider_http_failure(
                            response.status,
                            &response.body,
                            &selected_target_provider_id,
                        )
                    };
                    failure.failed_attempt_evidence = Some(
                        build_v3_runtime_provider_failed_attempt_evidence_from_response(
                            transport_attempt,
                            Some(provider_request_snapshot.clone()),
                            response.status,
                            &response.headers,
                            &response.body,
                            response.body_read_failure.as_deref(),
                        ),
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
                            last_external_http: &mut last_external_http,
                        },
                        &mut retry_selected,
                        &mut pending_provider_action_recovery,
                        failure_events,
                    )
                    .await
                    .map_err(V3RelayCoreError::Target)?
                    {
                        return Ok(C::assemble_failure_output(
                            failure,
                            trace,
                            std::mem::take(failure_events),
                        ));
                    }
                    continue;
                }
                Err(error) => {
                    if let Some(witness) =
                        crate::hub_v1::external_http_witness_from_provider_error(&error)
                    {
                        last_external_http = Some(witness);
                    }
                    let failed_attempt_evidence =
                        build_v3_runtime_provider_failed_attempt_evidence_from_error(
                            transport_attempt,
                            Some(provider_request_snapshot.clone()),
                            &error,
                        );
                    let mut failure = provider_runtime_failure(error, &selected_target_provider_id);
                    failure.failed_attempt_evidence = failed_attempt_evidence;
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
                            last_external_http: &mut last_external_http,
                        },
                        &mut retry_selected,
                        &mut pending_provider_action_recovery,
                        failure_events,
                    )
                    .await
                    .map_err(V3RelayCoreError::Target)?
                    {
                        return Ok(C::assemble_failure_output(
                            failure,
                            trace,
                            std::mem::take(failure_events),
                        ));
                    }
                    continue;
                }
            };
        // The upstream answered: from this instant its head is real evidence,
        // whatever the body turns out to be. Recorded before the body is
        // interpreted so a stream whose payload never decodes is never reported
        // as if no response had arrived. A branch that can read a body replaces
        // this with the fuller witness.
        last_external_http = Some(crate::hub_v1::external_http_witness_head(&provider_raw));
        if let Err(timing_error) = runtime_timing.finish_external() {
            return Err(V3RelayCoreError::Target(timing_error));
        }
        let provider_status = provider_raw.status();
        match provider_raw.into_body() {
            V3ProviderResponseBody::Json(bytes) => {
                let provider_value: Value = match serde_json::from_slice(&bytes) {
                    Ok(value) => value,
                    Err(error) => {
                        let mut failure = provider_runtime_failure(
                            V3ProviderError::ResponseBody {
                                request_id: request_id.to_string(),
                                provider_id: selected_target_provider_id.clone(),
                                reason: format!("provider JSON response decode failed: {error}"),
                            },
                            &selected_target_provider_id,
                        );
                        failure.provider_status = Some(provider_status);
                        drop(provider_action_permit.take());
                        let terminal_failure = handle_provider_failure(
                            &failure_context,
                            selected,
                            failure.clone(),
                            &mut V3RelayProviderFailurePolicyState {
                                failed_candidates: &mut failed_candidates,
                                same_candidate_retries: &mut same_candidate_retries,
                                trace: &mut trace,
                                last_external_http: &mut last_external_http,
                            },
                            &mut retry_selected,
                            &mut pending_provider_action_recovery,
                            failure_events,
                        )
                        .await
                        .map_err(V3RelayCoreError::Target)?;
                        if let Some(failure) = terminal_failure {
                            return Ok(C::assemble_failure_output(
                                failure,
                                trace,
                                std::mem::take(failure_events),
                            ));
                        }
                        if attempt_budget.residence_deadline() <= std::time::Instant::now() {
                            return Ok(C::assemble_failure_output(
                                terminalize_provider_failure(failure, last_external_http.clone()),
                                trace,
                                std::mem::take(failure_events),
                            ));
                        }
                        continue;
                    }
                };
                let provider_response_snapshot = provider_value.clone();
                let has_business_content =
                    v3_provider_json_attempt_has_deliverable_business_content(
                        provider_wire_protocol,
                        &provider_value,
                    );
                let projection = if has_business_content {
                    refill.round = None;
                    C::project_json_response(
                        &request_id,
                        failure_session_scope.session_id(),
                        provider_value,
                        provider_wire_protocol,
                        &req05.previous.previous.previous.payload.0,
                        V3HubTransportIntent::Json,
                        &mut trace,
                        selected_target_compatibility_profile.as_deref(),
                        retain_response_cipher,
                        request_tool_thinking_enabled,
                        &selected_target_model_id,
                        &namespace_registry,
                        refill,
                    )
                } else {
                    Err(V3RelayCoreError::Target(
                        "provider_response_empty".to_string(),
                    ))
                };
                let client_response = match projection {
                    Ok(client_response) => client_response,
                    Err(error) => {
                        let (mut failure, response_processing_code) = if !has_business_content {
                            (
                                provider_request_failure(
                                    "V3ProviderRespInbound01Raw",
                                    "provider_response_empty",
                                    "provider returned no deliverable business content",
                                ),
                                None,
                            )
                        } else {
                            provider_response_governance_failure(
                                error,
                                request_id,
                                &selected_target_provider_id,
                            )
                        };
                        failure.provider_status = Some(provider_status);
                        drop(provider_action_permit.take());
                        if let Some(failure) = handle_provider_failure_with_response_code(
                            &failure_context,
                            selected,
                            failure,
                            &mut V3RelayProviderFailurePolicyState {
                                failed_candidates: &mut failed_candidates,
                                same_candidate_retries: &mut same_candidate_retries,
                                trace: &mut trace,
                                last_external_http: &mut last_external_http,
                            },
                            &mut retry_selected,
                            &mut pending_provider_action_recovery,
                            failure_events,
                            response_processing_code,
                        )
                        .await
                        .map_err(V3RelayCoreError::Target)?
                        {
                            return Ok(C::assemble_failure_output(
                                failure,
                                trace,
                                std::mem::take(failure_events),
                            ));
                        }
                        continue;
                    }
                };
                let attempt_success_receipt =
                    crate::nodes::V3AttemptSuccessReceipt::from_buffered_terminal_attempt();
                provider_health
                    .record_provider_success_in_failure_scope_for_interface(
                        &attempt_success_receipt,
                        &failure_session_scope,
                        &selected_target_provider_id,
                        &selected_target_interface_id,
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
                if let Some(pending) = route_policy_pending.as_ref() {
                    pending
                        .commit_manifest_now(manifest)
                        .map_err(V3RelayCoreError::Target)?;
                }
                observability.provider_failure_events = std::mem::take(failure_events);
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
                // 首帧守卫：provider SSE 首帧错误/空流/挂起在响应头前被捕获，
                // 走 provider 失败策略切 provider（客户端无感，对话不断流）。
                let sse_first_frame_timeout_ms = manifest
                    .providers
                    .get(&selected_target_provider_id)
                    .and_then(|provider| provider.sse_first_frame_timeout_ms);
                let stream = guard_v3_provider_sse_attempt_deadline(
                    request_id,
                    &selected_target_provider_id,
                    stream,
                    attempt_budget.residence_deadline(),
                );
                let first_frame_result = match tokio::time::timeout_at(
                    attempt_deadline,
                    guard_relay_sse_first_frame(
                        request_id,
                        &selected_target_provider_id,
                        provider_wire_protocol,
                        stream,
                        sse_first_frame_timeout_ms,
                        C::ENTRY_PROTOCOL == V3HubEntryProtocol::OpenAiChat,
                    ),
                )
                .await
                {
                    Err(_) => Err(V3ProviderError::Transport {
                        request_id: request_id.to_string(),
                        provider_id: selected_target_provider_id.clone(),
                        reason: format!(
                            "provider SSE stream exceeded the configured request timeout ({}ms) before first frame",
                            attempt_timeout.as_millis()
                        ),
                    }),
                    Ok(stream) => stream,
                };
                let guarded_stream = match first_frame_result {
                    Ok(stream) => stream,
                    Err(error @ V3ProviderError::ClientDisconnect { .. }) => {
                        // The client owns this lifecycle termination. Do not feed it
                        // into provider Error01-05, health, retry, or reselect.
                        let failure = provider_runtime_failure(error, &selected_target_provider_id);
                        return Ok(C::assemble_failure_output(
                            failure,
                            trace,
                            std::mem::take(failure_events),
                        ));
                    }
                    Err(error) => {
                        let residence_deadline_error = matches!(
                            &error,
                            V3ProviderError::Transport { reason, .. }
                                if reason.contains("provider SSE attempt exceeded the request residence deadline")
                        );
                        let mut failure =
                            provider_runtime_failure(error, &selected_target_provider_id);
                        failure.provider_status = Some(provider_status);
                        drop(provider_action_permit.take());
                        let terminal_failure = handle_provider_failure(
                            &failure_context,
                            selected,
                            failure.clone(),
                            &mut V3RelayProviderFailurePolicyState {
                                failed_candidates: &mut failed_candidates,
                                same_candidate_retries: &mut same_candidate_retries,
                                trace: &mut trace,
                                last_external_http: &mut last_external_http,
                            },
                            &mut retry_selected,
                            &mut pending_provider_action_recovery,
                            failure_events,
                        )
                        .await
                        .map_err(V3RelayCoreError::Target)?;
                        if let Some(failure) = terminal_failure {
                            return Ok(C::assemble_failure_output(
                                failure,
                                trace,
                                std::mem::take(failure_events),
                            ));
                        }
                        if residence_deadline_error
                            || attempt_budget.residence_deadline() <= std::time::Instant::now()
                        {
                            return Ok(C::assemble_failure_output(
                                terminalize_provider_failure(failure, last_external_http.clone()),
                                trace,
                                std::mem::take(failure_events),
                            ));
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
                let idle_guarded_stream = observe_v3_provider_sse(
                    idle_guarded_stream,
                    stream_observation.clone(),
                    provider_wire_protocol,
                    request_id.to_string(),
                    selected_target_provider_id.clone(),
                );
                if transport_intent == V3HubTransportIntent::Json {
                    let local_failure = std::sync::Arc::new(tokio::sync::Mutex::new(None));
                    let collector =
                        V3CommittedClientSseBuilder::with_budget(attempt_budget.clone()).map_err(
                            |error| {
                                V3RelayCoreError::Target(format!(
                            "V3ExecutionAttemptPayloadStore rejected relay attempt: {error}"))
                            },
                        )?;
                    let stream: V3ProviderSseStream = Box::pin(futures_util::stream::unfold(
                        (
                            idle_guarded_stream,
                            collector,
                            local_failure.clone(),
                            request_id.to_string(),
                            selected_target_provider_id.clone(),
                            false,
                        ),
                        |(mut stream, mut collector, failure, request_id, provider_id, stopped)| async move {
                            if stopped {
                                return None;
                            }
                            let next = stream.next().await?;
                            let mut stopped = false;
                            let next = match next {
                                Ok(chunk) if !chunk.is_empty() => {
                                    match collector.push(chunk.clone()) {
                                        Ok(()) => Ok(chunk),
                                        Err(error) => {
                                            *failure.lock().await = Some(error);
                                            stopped = true;
                                            Err(V3ProviderError::ResponseBody {
                                            request_id: request_id.clone(), provider_id: provider_id.clone(),
                                            reason: "provider collection stopped by the local attempt store".to_string(),
                                        })
                                        }
                                    }
                                }
                                other => other,
                            };
                            Some((
                                next,
                                (stream, collector, failure, request_id, provider_id, stopped),
                            ))
                        },
                    ));
                    let materialized = tokio::time::timeout_at(attempt_deadline,
                        super::responses_relay_runtime::materialize_v3_provider_sse_as_canonical_response(
                            provider_wire_protocol, stream)).await;
                    if let Some(error) = local_failure.lock().await.take() {
                        drop(provider_action_permit.take());
                        return Err(V3RelayCoreError::Target(format!(
                            "V3ExecutionAttemptPayloadStore relay local resource failure: {error}"
                        )));
                    }
                    let provider_value = match materialized {
                        Ok(Ok(value)) => Ok(value),
                        Ok(Err(error)) => Err(match error {
                            super::responses_relay_runtime::V3ResponsesRelayRuntimeError::ProviderResponseEmpty { .. } =>
                                provider_request_failure("V3ProviderRespInbound01Raw", "provider_response_empty",
                                    "provider returned no deliverable business content"),
                            other => provider_runtime_failure(V3ProviderError::ResponseBody {
                                request_id: request_id.to_string(), provider_id: selected_target_provider_id.clone(),
                                reason: other.to_string(),
                            }, &selected_target_provider_id),
                        }),
                        Err(_) => Err(provider_runtime_failure(V3ProviderError::Transport {
                            request_id: request_id.to_string(), provider_id: selected_target_provider_id.clone(),
                            reason: format!("provider SSE stream exceeded the configured request timeout ({}ms) before terminal EOF", attempt_timeout.as_millis()),
                        }, &selected_target_provider_id)),
                    };
                    let projection = match provider_value {
                        Ok(value) => {
                            let snapshot = value.clone();
                            refill.round = None;
                            match C::project_json_response(
                                request_id,
                                failure_session_scope.session_id(),
                                value,
                                provider_wire_protocol,
                                &req05.previous.previous.previous.payload.0,
                                V3HubTransportIntent::Sse,
                                &mut trace,
                                selected_target_compatibility_profile.as_deref(),
                                retain_response_cipher,
                                request_tool_thinking_enabled,
                                &selected_target_model_id,
                                &namespace_registry,
                                refill,
                            ) {
                                Ok(client) => Ok((client, snapshot)),
                                Err(error) => Err(provider_response_governance_failure(
                                    error,
                                    request_id,
                                    &selected_target_provider_id,
                                )),
                            }
                        }
                        Err(failure) => Err((failure, None)),
                    };
                    let (client_response, provider_response_snapshot) = match projection {
                        Ok(projected) => projected,
                        Err((mut failure, response_processing_code)) => {
                            failure.provider_status = Some(provider_status);
                            drop(provider_action_permit.take());
                            if let Some(failure) = handle_provider_failure_with_response_code(
                                &failure_context,
                                selected,
                                failure,
                                &mut V3RelayProviderFailurePolicyState {
                                    failed_candidates: &mut failed_candidates,
                                    same_candidate_retries: &mut same_candidate_retries,
                                    trace: &mut trace,
                                    last_external_http: &mut last_external_http,
                                },
                                &mut retry_selected,
                                &mut pending_provider_action_recovery,
                                failure_events,
                                response_processing_code,
                            )
                            .await
                            .map_err(V3RelayCoreError::Target)?
                            {
                                return Ok(C::assemble_failure_output(
                                    failure,
                                    trace,
                                    std::mem::take(failure_events),
                                ));
                            }
                            continue;
                        }
                    };
                    let receipt =
                        crate::nodes::V3AttemptSuccessReceipt::from_buffered_terminal_attempt();
                    provider_health
                        .record_provider_success_in_failure_scope_for_interface(
                            &receipt,
                            &failure_session_scope,
                            &selected_target_provider_id,
                            &selected_target_interface_id,
                            Some(&selected_target_auth_alias),
                            Some(&selected_target_model_id),
                            v3_relay_provider_policy_now_epoch_ms()
                                .map_err(V3RelayCoreError::Target)?,
                        )
                        .map_err(|error| V3RelayCoreError::Target(error.to_string()))?;
                    let mut observability =
                        build_v3_relay_observability(C::ENTRY_KIND, &selected, "json");
                    observability.provider_status = Some(provider_status);
                    observability.response_status = Some("completed".to_string());
                    observability.finish_reason = read_v3_runtime_finish_reason(&client_response);
                    observability.usage = extract_v3_runtime_usage_summary(&client_response);
                    observability.timing = Some(
                        runtime_timing
                            .finish_runtime()
                            .map_err(V3RelayCoreError::Target)?,
                    );
                    if let Some(pending) = route_policy_pending.as_ref() {
                        pending
                            .commit_manifest_now(manifest)
                            .map_err(V3RelayCoreError::Target)?;
                    }
                    observability.provider_failure_events = std::mem::take(failure_events);
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
                let projected_sse = match C::project_sse(
                    &request_id,
                    idle_guarded_stream,
                    provider_wire_protocol,
                    selected_target_compatibility_profile,
                    retain_response_cipher,
                    request_tool_thinking_enabled,
                    stream_observation.clone(),
                    client_include_usage,
                    C::build_sse_outcome(
                        &provider_health,
                        &failure_session_scope,
                        selected_target_provider_id.clone(),
                        selected_target_interface_id.clone(),
                        selected_target_auth_alias.clone(),
                        selected_target_model_id.clone(),
                        true,
                        None,
                    ),
                ) {
                    Ok(sse) => sse,
                    Err(error) => {
                        let mut failure = provider_runtime_failure(
                            V3ProviderError::ResponseBody {
                                request_id: request_id.to_string(),
                                provider_id: selected_target_provider_id.clone(),
                                reason: format!(
                                    "provider response event codec initialization failed: {error}"
                                ),
                            },
                            &selected_target_provider_id,
                        );
                        failure.provider_status = Some(provider_status);
                        drop(provider_action_permit.take());
                        if let Some(failure) = handle_provider_failure(
                            &failure_context,
                            selected,
                            failure,
                            &mut V3RelayProviderFailurePolicyState {
                                failed_candidates: &mut failed_candidates,
                                same_candidate_retries: &mut same_candidate_retries,
                                trace: &mut trace,
                                last_external_http: &mut last_external_http,
                            },
                            &mut retry_selected,
                            &mut pending_provider_action_recovery,
                            failure_events,
                        )
                        .await
                        .map_err(V3RelayCoreError::Target)?
                        {
                            return Ok(C::assemble_failure_output(
                                failure,
                                trace,
                                std::mem::take(failure_events),
                            ));
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
                let mut stream_failure = loop {
                    let next = match tokio::time::timeout_at(attempt_deadline, projected_sse.next())
                        .await
                    {
                        Ok(next) => next,
                        Err(_) => {
                            break Some(V3RelayAttemptCollectFailure::ProviderTransport(format!(
                                "provider SSE stream exceeded the configured request timeout ({}ms) before terminal EOF",
                                attempt_timeout.as_millis()
                            )));
                        }
                    };
                    match next {
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
                            break Some(
                                match stream_observation
                                    .take_response_governance_failure()
                                    .map_err(V3RelayCoreError::Target)?
                                {
                                    Some(error) => {
                                        V3RelayAttemptCollectFailure::ResponseGovernance(error)
                                    }
                                    None => {
                                        V3RelayAttemptCollectFailure::ProviderResponseBody(reason)
                                    }
                                },
                            )
                        }
                        None => {
                            break None;
                        }
                    }
                };
                if stream_failure.is_none() && C::ENTRY_PROTOCOL == V3HubEntryProtocol::OpenAiChat {
                    if let Err(error) = compile_v3_hub_relay_response_hooks()
                        .govern_complete_chat_sse(&mut committed_attempt, &namespace_registry)
                    {
                        stream_failure = Some(match error {
                            V3RelayCompleteResponseError::Governance(error) => {
                                V3RelayAttemptCollectFailure::ResponseGovernance(error)
                            }
                            V3RelayCompleteResponseError::Processing(reason) => {
                                V3RelayAttemptCollectFailure::ResponseGovernance(
                                    V3HubRelayResponseError::ProviderCompatFailed { reason },
                                )
                            }
                            V3RelayCompleteResponseError::Store(error) => {
                                V3RelayAttemptCollectFailure::LocalStore(error)
                            }
                        });
                    }
                }
                if stream_failure.is_none() {
                    let protocol = match C::ENTRY_PROTOCOL {
                        V3HubEntryProtocol::OpenAiChat => V3HubProviderWireProtocol::OpenAiChat,
                        V3HubEntryProtocol::Responses => V3HubProviderWireProtocol::Responses,
                        V3HubEntryProtocol::Anthropic => V3HubProviderWireProtocol::Anthropic,
                        V3HubEntryProtocol::Gemini => V3HubProviderWireProtocol::Gemini,
                    };
                    stream_failure = match projected_sse_has_business_content(
                        protocol,
                        committed_attempt.frames(),
                    ) {
                        Ok(true) => None,
                        Ok(false) => Some(V3RelayAttemptCollectFailure::ResponseGovernance(
                            V3HubRelayResponseError::GovernedAttemptEmpty,
                        )),
                        Err(reason) => Some(V3RelayAttemptCollectFailure::ResponseGovernance(
                            V3HubRelayResponseError::ProviderCompatFailed { reason },
                        )),
                    };
                }
                if let Some(failure) = stream_failure {
                    let (mut failure, response_processing_code) = match failure {
                        V3RelayAttemptCollectFailure::ResponseGovernance(error) => {
                            provider_response_governance_failure(
                                V3RelayCoreError::ResponseGovernance(error),
                                request_id,
                                &selected_target_provider_id,
                            )
                        }
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
                        V3RelayAttemptCollectFailure::ProviderResponseBody(reason) => (
                            provider_runtime_failure(
                                V3ProviderError::ResponseBody {
                                    request_id: request_id.to_string(),
                                    provider_id: selected_target_provider_id.clone(),
                                    reason: format!(
                                        "provider response event codec failed: {reason}"
                                    ),
                                },
                                &selected_target_provider_id,
                            ),
                            None,
                        ),
                        V3RelayAttemptCollectFailure::ProviderTransport(reason) => (
                            provider_runtime_failure(
                                V3ProviderError::Transport {
                                    request_id: request_id.to_string(),
                                    provider_id: selected_target_provider_id.clone(),
                                    reason,
                                },
                                &selected_target_provider_id,
                            ),
                            None,
                        ),
                    };
                    failure.provider_status = Some(provider_status);
                    drop(provider_action_permit.take());
                    let terminal_failure = handle_provider_failure_with_response_code(
                        &failure_context,
                        selected,
                        failure.clone(),
                        &mut V3RelayProviderFailurePolicyState {
                            failed_candidates: &mut failed_candidates,
                            same_candidate_retries: &mut same_candidate_retries,
                            trace: &mut trace,
                            last_external_http: &mut last_external_http,
                        },
                        &mut retry_selected,
                        &mut pending_provider_action_recovery,
                        failure_events,
                        response_processing_code,
                    )
                    .await
                    .map_err(V3RelayCoreError::Target)?;
                    if let Some(failure) = terminal_failure {
                        return Ok(C::assemble_failure_output(
                            failure,
                            trace,
                            std::mem::take(failure_events),
                        ));
                    }
                    let deadline_expired =
                        attempt_budget.residence_deadline() <= std::time::Instant::now();
                    if deadline_expired {
                        return Ok(C::assemble_failure_output(
                            terminalize_provider_failure(failure, last_external_http.clone()),
                            trace,
                            std::mem::take(failure_events),
                        ));
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
                    .record_provider_success_in_failure_scope_for_interface(
                        &attempt_success_receipt,
                        &failure_session_scope,
                        &selected_target_provider_id,
                        &selected_target_interface_id,
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
                if let Some(pending) = route_policy_pending.as_ref() {
                    pending
                        .commit_manifest_now(manifest)
                        .map_err(V3RelayCoreError::Target)?;
                }
                observability.provider_failure_events = std::mem::take(failure_events);
                // The response chain is recorded only once this attempt is
                // validated and committed. A discarded attempt must not claim
                // the client frame before the reselection trace.
                push_sse_response_chain_trace(&mut trace);
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

/// 带 Chat Process 有界续杯的 relay 执行入口（骨架之上的唯一循环）。
///
/// 续杯策略仍只有一处实现（`decide_v3_chat_process_refill`）。本函数只负责：
/// - 为一个客户端请求创建并复用同一份执行控制，连续续杯额度不按执行重置、
///   也不跨请求共享；
/// - 每次执行后读取骨架发布的 round，并据共享策略决定是否再执行一次；
/// - 把前几轮业务项与 usage 累积到载体，供 codec 在投影前合并；
/// - 失败事件跨轮累积，中间轮不产生任何客户端交付。
#[allow(clippy::too_many_arguments)]
pub(crate) async fn execute_v3_relay_runtime_with_chat_process_refill<C, T>(
    manifest: &V3Config05ManifestPublished,
    server_id: &str,
    failure_session_scope: V3ProviderFailureSessionScope,
    request_id: &str,
    endpoint_path: &str,
    execution_mode: V3HubExecutionMode,
    initial_payload: Value,
    transport: &T,
    provider_health: V3ProviderFailureRuntimeHealth,
    retry_policy: V3RelayProviderFailureRetryPolicy,
    initial_handoff: Option<crate::V3ResponsesProtocolRelayHandoff>,
) -> Result<
    (C::Output, Vec<V3RuntimeProviderFailureObservation>),
    (V3RelayCoreError, Vec<V3RuntimeProviderFailureObservation>),
>
where
    C: V3RelayProtocolCodec,
    T: ResponsesTransport,
{
    let request_execution_control = super::relay_runtime_shared::relay_request_execution_control(
        manifest,
        server_id,
        initial_handoff.as_ref(),
    )
    .map_err(|error| (error, Vec::new()))?;
    let max_refills =
        super::resp_chat_process_03_governed::v3_chat_process_refill_max_consecutive();
    let mut payload = initial_payload;
    let mut initial_handoff = initial_handoff;
    // Direct 阶段交给 Relay 的 handoff 已经记录了同一次请求的前序失败尝试证据。
    // 它必须作为 Relay 首次执行的起点，否则客户端失败证据只保留 Relay 阶段，
    // 丢掉同协议 Direct 的真实失败。
    let mut failure_events: Vec<V3RuntimeProviderFailureObservation> = initial_handoff
        .as_mut()
        .map(|handoff| std::mem::take(&mut handoff.provider_failure_events))
        .unwrap_or_default();
    let mut carrier = V3RelayRefillCarrier {
        request_execution_control,
        accumulated_items: Vec::new(),
        accumulated_usage: None,
        round: None,
    };
    loop {
        carrier.round = None;
        let output = execute_v3_relay_runtime_core::<C, T>(
            manifest,
            server_id,
            failure_session_scope.clone(),
            request_id,
            endpoint_path,
            execution_mode,
            payload.clone(),
            transport,
            provider_health.clone(),
            retry_policy.clone(),
            Vec::new(),
            true,
            initial_handoff.take(),
            &mut failure_events,
            &mut carrier,
        )
        .await
        .map_err(|error| (error, failure_events.clone()))?;
        let Some(round) = carrier.round.take() else {
            // 没有发布 round：SSE 交付或失败出口。当前结果就是最终结果。
            return Ok((output, failure_events));
        };
        let disposition = super::resp_chat_process_03_governed::decide_v3_chat_process_refill(
            &round.facts.tool_calls,
            round.facts.has_source_summary,
            round.response_completed,
            carrier.request_execution_control.refill_used(),
            max_refills,
        );
        let mut continued = false;
        if disposition == super::common::V3ChatProcessRefillDisposition::RequestRefill {
            if let Ok(next_payload) =
                super::resp_chat_process_03_governed::build_v3_chat_process_refill_continuation_request(
                    &payload,
                    &round.finalized_response,
                )
            {
                // 请求作用域的取消见证只有驻留截止时间；已过期就交付当前真实结果，
                // 不再发起新执行。
                if carrier.request_execution_control.deadline_unix_ms().is_ok()
                    && carrier
                        .request_execution_control
                        .try_admit_refill(max_refills)
                {
                    carrier.request_execution_control.begin_refill_execution();
                    carrier.accumulated_items.extend(
                        super::resp_chat_process_03_governed::
                            collect_v3_chat_process_business_output_items(
                                &round.finalized_response,
                            ),
                    );
                    super::resp_chat_process_03_governed::
                        accumulate_v3_chat_process_refill_usage(
                            &mut carrier.accumulated_usage,
                            super::responses_relay_runtime::extract_v3_runtime_usage_summary(
                                &round.finalized_response,
                            ),
                        );
                    payload = next_payload;
                    continued = true;
                }
            }
        }
        if !continued {
            return Ok((output, failure_events));
        }
    }
}

#[cfg(test)]
#[path = "relay_runtime_core_tests.rs"]
mod tests;
