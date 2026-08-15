use crate::hub_v1::{
    classify_v3_provider_generic_sse_json_data, collect_v3_provider_sse_json_data,
    is_v3_provider_sse_keepalive_text, parse_v3_provider_sse_json_data,
    v3_feature_enabled_for_server,
    V3ProviderResponsesJsonFrameOutcome, V3RuntimeStreamObservation,
};
use crate::nodes::{V3ClientBody, V3ClientSseStream, V3Resp15ClientPayload};
use futures_util::{stream, StreamExt};
use routecodex_v3_error::{
    build_v3_error_01_source_raised, build_v3_error_01_source_raised_external,
    V3Error01SourceRaised, V3ErrorSourceKind, V3ExternalErrorKind, V3ExternalErrorLink,
};
use routecodex_v3_provider_responses::{
    V3ProviderError, V3ProviderResp14Raw, V3ProviderResponseBody, V3ProviderSseStream,
};
use routecodex_v3_sse::{
    build_v3_sse_transport_in_01_raw_chunk, SseField, SseIncrementalDecoder, SseTransportError,
    SseTransportLimits,
};
use routecodex_v3_virtual_router::V3VirtualRouterError;
use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};

/// Direct SSE 帧间超时：provider 返回 200 但首个或后续语义事件挂起时 fail-fast
/// （默认 60s，明显短于 provider 请求总超时，避免客户端无限等待/EOF 且无日志）。
/// 超时归一化为 transport Error01 进入错误链（reselect / Error06 终态投影），
/// 不在 server/SSE 层裸造错误帧。
const V3_DIRECT_SSE_FIRST_EVENT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(60);

pub(crate) fn v3_route_plan_error_source(
    stage: &'static str,
    code: &'static str,
    error: V3VirtualRouterError,
) -> V3Error01SourceRaised {
    match error {
        V3VirtualRouterError::DirectModelUnknown { provider, model } => {
            build_v3_error_01_source_raised(
                V3ErrorSourceKind::ModelNotFound,
                stage,
                "direct_model_not_found",
                format!("direct provider model {provider}.{model} is not configured"),
            )
        }
        other => build_v3_error_01_source_raised(
            V3ErrorSourceKind::RuntimeFailure,
            stage,
            code,
            other.to_string(),
        ),
    }
}

#[derive(Debug, Clone)]
pub enum V3RemoteContinuationObservation {
    Pending {
        response_id: String,
    },
    Terminal,
    Streaming {
        state: V3SseRemoteContinuationObservationState,
    },
}

#[derive(Debug, Clone, Default)]
pub struct V3SseRemoteContinuationObservationState {
    inner: Arc<Mutex<V3SseRemoteContinuationObservationInner>>,
}

#[derive(Debug, Default)]
struct V3SseRemoteContinuationObservationInner {
    pending_response_id: Option<String>,
}

impl V3SseRemoteContinuationObservationState {
    pub(crate) fn pending_response_id(&self) -> Result<Option<String>, String> {
        self.inner
            .lock()
            .map(|inner| inner.pending_response_id.clone())
            .map_err(|error| error.to_string())
    }

    pub(crate) fn record_pending_response_id(
        &self,
        response_id: &str,
    ) -> Result<(), V3Error01SourceRaised> {
        self.inner
            .lock()
            .map_err(|error| {
                build_v3_error_01_source_raised(
                    V3ErrorSourceKind::RuntimeFailure,
                    "V3ProviderResp14Raw",
                    "sse_remote_continuation_observer_poisoned",
                    error.to_string(),
                )
            })?
            .pending_response_id = Some(response_id.to_string());
        Ok(())
    }
}

#[derive(Debug)]
pub struct V3ProviderResponseProjection {
    pub client_payload: V3Resp15ClientPayload,
    pub remote_continuation: V3RemoteContinuationObservation,
    pub stream_observation: Option<V3RuntimeStreamObservation>,
}

/// 客户端响应 id 剥离开关：开启后把返回给客户端的 Responses body 中
/// `id` 替换为空串，客户端无法用 previous_response_id 做增量续接，
/// 强制下一次请求全量发送（配合本地 continuation 关闭，避免上游对
/// previous_response_id 兼容性差异导致的 400）。
pub(crate) fn v3_strip_client_response_id_enabled_for_server(
    manifest: &routecodex_v3_config::V3Config05ManifestPublished,
    server_id: &str,
) -> bool {
    v3_feature_enabled_for_server(manifest, server_id, "strip_client_response_id", false)
}

/// 本地 continuation 保存/恢复开关：开启后 Resp04 不再保存 continuation
/// locator，Req03 也不再按 previous_response_id 恢复（客户端拿不到 id，
/// 必然全量请求；即便收到 previous_response_id 也按未命中处理）。
pub(crate) fn v3_responses_continuation_disabled_for_server(
    manifest: &routecodex_v3_config::V3Config05ManifestPublished,
    server_id: &str,
) -> bool {
    v3_feature_enabled_for_server(
        manifest,
        server_id,
        "responses_continuation_disabled",
        false,
    )
}

/// 客户端响应 id 剥离唯一入口：把 Responses body 中顶层 `id`（或嵌套
/// `response.id`）替换为空串。JSON 路径与 SSE data 帧共用，返回是否改写。
pub(crate) fn strip_v3_response_id_from_json_body(body: &mut serde_json::Value) -> bool {
    let mut changed = false;
    if let Some(object) = body.as_object_mut() {
        if object
            .get("id")
            .is_some_and(|id| !id.as_str().unwrap_or("").is_empty())
        {
            object.insert("id".to_string(), serde_json::Value::String(String::new()));
            changed = true;
        }
        if let Some(response) = object
            .get_mut("response")
            .and_then(serde_json::Value::as_object_mut)
        {
            if response
                .get("id")
                .is_some_and(|id| !id.as_str().unwrap_or("").is_empty())
            {
                response.insert("id".to_string(), serde_json::Value::String(String::new()));
                changed = true;
            }
        }
    }
    changed
}

pub(crate) async fn project_provider_raw_to_client_payload(
    raw: V3ProviderResp14Raw,
) -> Result<V3ProviderResponseProjection, V3Error01SourceRaised> {
    let provider_id = raw.provider_id().to_string();
    if raw.status() >= 400 {
        return Err(build_v3_error_01_source_raised_external(
            V3ErrorSourceKind::ProviderFailure,
            "V3ProviderResp14Raw",
            format!("provider_http_{}", raw.status()),
            format!("provider {} returned {}", raw.provider_id(), raw.status()),
            V3ExternalErrorLink {
                kind: V3ExternalErrorKind::Provider,
                status: Some(raw.status()),
                code: Some(format!("HTTP_{}", raw.status())),
                provider_id: Some(provider_id),
                upstream_request_id: None,
                message: Some(format!("provider returned HTTP {}", raw.status())),
            },
        ));
    }
    let status = raw.status();
    // 客户端↔proxy 响应状态由 proxy（routecodex）管理，与 provider 无关：
    // provider 的 201（OpenAI Responses API 创建成功）归一化为 200 成功，
    // 避免透传非标准状态码让客户端误判（如 Codex 收到 201 → 无可见答案 →
    // 无限重试）；>=400 已在上方进入错误链（切 provider）。
    let status = if status == 201 { 200 } else { status };
    // 响应侧能力回射按 target 声明并编译出的 compatibility profile 门控，
    // 不按 provider_id 部署身份分支（与请求侧 wire 层同一契约）。
    let compatibility_profile = raw.compatibility_profile().map(ToOwned::to_owned);
    let content_type = raw
        .header_text("content-type")
        .map_err(provider_body_source)?
        .map(ToOwned::to_owned)
        .ok_or_else(|| {
            build_v3_error_01_source_raised_external(
                V3ErrorSourceKind::ProviderFailure,
                "V3ProviderResp14Raw",
                "provider_content_type_missing",
                "provider response missing content-type",
                V3ExternalErrorLink {
                    kind: V3ExternalErrorKind::Provider,
                    status: Some(status),
                    code: Some("PROVIDER_CONTENT_TYPE_MISSING".to_string()),
                    provider_id: Some(provider_id.clone()),
                    upstream_request_id: None,
                    message: Some("provider response missing content-type".to_string()),
                },
            )
        })?;
    let provider_body = raw.into_body();
    let (body, remote_continuation, stream_observation) = if content_type
        .starts_with("text/event-stream")
    {
        match provider_body {
            V3ProviderResponseBody::Sse(stream) => project_sse_stream(&provider_id, stream).await?,
            V3ProviderResponseBody::Json(body_bytes) => {
                let observation = observe_sse_remote_continuation_bytes(&provider_id, &body_bytes)?;
                (V3ClientBody::Bytes(body_bytes), observation, None)
            }
        }
    } else if content_type.starts_with("application/json") {
        let V3ProviderResponseBody::Json(body_bytes) = provider_body else {
            return Err(build_v3_error_01_source_raised_external(
                V3ErrorSourceKind::ProviderFailure,
                "V3ProviderResp14Raw",
                "provider_response_body_kind_mismatch",
                "application/json provider response arrived as SSE stream body",
                V3ExternalErrorLink {
                    kind: V3ExternalErrorKind::Provider,
                    status: Some(status),
                    code: Some("PROVIDER_RESPONSE_BODY_KIND_MISMATCH".to_string()),
                    provider_id: Some(provider_id.clone()),
                    upstream_request_id: None,
                    message: Some(
                        "application/json provider response arrived as SSE stream body".to_string(),
                    ),
                },
            ));
        };
        let mut parsed: serde_json::Value =
            serde_json::from_slice(&body_bytes).map_err(|error| {
                build_v3_error_01_source_raised_external(
                    V3ErrorSourceKind::ProviderFailure,
                    "V3ProviderResp14Raw",
                    "provider_response_json_invalid",
                    format!("provider response JSON parse failed: {error}"),
                    V3ExternalErrorLink {
                        kind: V3ExternalErrorKind::Provider,
                        status: Some(status),
                        code: Some("PROVIDER_RESPONSE_JSON_INVALID".to_string()),
                        provider_id: Some(provider_id.clone()),
                        upstream_request_id: None,
                        message: Some(format!("provider response JSON parse failed: {error}")),
                    },
                )
            })?;
        // DeepSeek Console Go responses 网关响应侧回射：上游以 function_call 返回
        // 映射过的 function 工具（exec_command/web_search/reasoningStop 等），客户端
        // 声明的是 custom 工具形态——必须在进入客户端前回射为 custom_tool_call，
        // 否则客户端不执行调用、下一轮历史缺 output（孤儿 call）触发上游 400。
        // 请求侧对应映射见 responses:deepseek-console-go compat。
        if compatibility_profile.as_deref() == Some("responses:deepseek-console-go") {
            parsed = provider_compat_core::apply_deepseek_console_go_response_compat(parsed);
        }
        let observation = observe_json_remote_continuation(&provider_id, status, &parsed)?;
        (V3ClientBody::Json(parsed), observation, None)
    } else {
        return Err(build_v3_error_01_source_raised_external(
            V3ErrorSourceKind::ProviderFailure,
            "V3ProviderResp14Raw",
            "provider_content_type_unsupported",
            format!("unsupported provider response content-type {content_type}"),
            V3ExternalErrorLink {
                kind: V3ExternalErrorKind::Provider,
                status: Some(status),
                code: Some("PROVIDER_CONTENT_TYPE_UNSUPPORTED".to_string()),
                provider_id: Some(provider_id),
                upstream_request_id: None,
                message: Some(format!(
                    "unsupported provider response content-type {content_type}"
                )),
            },
        ));
    };
    Ok(V3ProviderResponseProjection {
        client_payload: V3Resp15ClientPayload {
            status,
            headers: BTreeMap::from([("content-type".to_string(), content_type)]),
            body,
        },
        remote_continuation,
        stream_observation,
    })
}

async fn project_sse_stream(
    provider_id: &str,
    stream: V3ProviderSseStream,
) -> Result<
    (
        V3ClientBody,
        V3RemoteContinuationObservation,
        Option<V3RuntimeStreamObservation>,
    ),
    V3Error01SourceRaised,
> {
    let stream = guard_initial_direct_sse_provider_failure(provider_id, stream).await?;
    let observation_state = V3SseRemoteContinuationObservationState::default();
    let usage_observation = V3RuntimeStreamObservation::default();
    let client_stream = observed_sse_client_stream(
        provider_id.to_string(),
        stream,
        observation_state.clone(),
        usage_observation.clone(),
    );
    Ok((
        V3ClientBody::Sse(client_stream),
        V3RemoteContinuationObservation::Streaming {
            state: observation_state,
        },
        Some(usage_observation),
    ))
}

async fn guard_initial_direct_sse_provider_failure(
    provider_id: &str,
    stream: V3ProviderSseStream,
) -> Result<V3ProviderSseStream, V3Error01SourceRaised> {
    guard_initial_direct_sse_provider_failure_with_timeout(
        provider_id,
        stream,
        V3_DIRECT_SSE_FIRST_EVENT_TIMEOUT,
    )
    .await
}

async fn guard_initial_direct_sse_provider_failure_with_timeout(
    provider_id: &str,
    mut stream: V3ProviderSseStream,
    first_event_timeout: std::time::Duration,
) -> Result<V3ProviderSseStream, V3Error01SourceRaised> {
    let mut decoder = SseIncrementalDecoder::new(SseTransportLimits::default());
    let mut buffered = Vec::<Vec<u8>>::new();
    loop {
        // 首帧超时守卫：provider 返回 200 但 SSE 首帧挂起（连接保持、无数据）时，
        // 必须 fail-fast 产生显式 provider 错误（而不是无限等待 -> 客户端超时/EOF
        // 且无 console 打印）。超时错误进入 provider 失败链，可触发 reselect 与
        // console 错误投影；客户端连接由 server 侧 keepalive 保持存活，与 provider
        // 状态解耦。
        let next = tokio::time::timeout(first_event_timeout, stream.next())
            .await
            .map_err(|_| {
                build_v3_error_01_source_raised_external(
                    V3ErrorSourceKind::ProviderFailure,
                    "V3ProviderResp14Raw",
                    "provider_response_sse_first_event_timeout",
                    "provider response SSE stream did not produce a first semantic event within timeout",
                    V3ExternalErrorLink {
                        kind: V3ExternalErrorKind::Provider,
                        status: None,
                        code: Some("PROVIDER_RESPONSE_SSE_FIRST_EVENT_TIMEOUT".to_string()),
                        provider_id: Some(provider_id.to_string()),
                        upstream_request_id: None,
                        message: Some(
                            "provider response SSE stream did not produce a first semantic event within timeout"
                                .to_string(),
                        ),
                    },
                )
            })?;
        let Some(next) = next else {
            decoder
                .finish()
                .map_err(|error| sse_transport_source(provider_id, error))?;
            return Err(build_v3_error_01_source_raised_external(
                V3ErrorSourceKind::ProviderFailure,
                "V3ProviderResp14Raw",
                "provider_response_sse_empty",
                "provider response SSE stream ended before first semantic event",
                V3ExternalErrorLink {
                    kind: V3ExternalErrorKind::Provider,
                    status: None,
                    code: Some("PROVIDER_RESPONSE_SSE_EMPTY".to_string()),
                    provider_id: Some(provider_id.to_string()),
                    upstream_request_id: None,
                    message: Some(
                        "provider response SSE stream ended before first semantic event"
                            .to_string(),
                    ),
                },
            ));
        };
        let chunk = next.map_err(provider_body_source)?;
        let frames = decoder
            .push(build_v3_sse_transport_in_01_raw_chunk(&chunk))
            .map_err(|error| sse_transport_source(provider_id, error))?;
        let mut should_start_client_stream = false;
        for frame in frames {
            if direct_sse_frame_provider_failure_source(provider_id, frame.frame().fields())?
                == DirectSseInitialFrameAction::StartClientStream
            {
                should_start_client_stream = true;
            }
        }
        buffered.push(chunk);
        if should_start_client_stream {
            let replay = stream::iter(buffered.into_iter().map(Ok)).chain(stream);
            return Ok(Box::pin(replay));
        }
    }
}

fn direct_sse_frame_provider_failure_source(
    provider_id: &str,
    fields: &[SseField],
) -> Result<DirectSseInitialFrameAction, V3Error01SourceRaised> {
    let data = collect_v3_provider_sse_json_data(fields);
    let parsed = classify_v3_provider_generic_sse_json_data(&data).map_err(|message| {
        build_v3_provider_sse_json_error(
            provider_id,
            "provider_response_sse_event_invalid",
            message,
        )
    })?;
    let Some(outcome) = parsed else {
        return Ok(DirectSseInitialFrameAction::ContinueBuffering);
    };
    match outcome {
        V3ProviderResponsesJsonFrameOutcome::ContinueBuffering => {
            Ok(DirectSseInitialFrameAction::ContinueBuffering)
        }
        V3ProviderResponsesJsonFrameOutcome::StartClientStream
        | V3ProviderResponsesJsonFrameOutcome::Terminal => {
            Ok(DirectSseInitialFrameAction::StartClientStream)
        }
        V3ProviderResponsesJsonFrameOutcome::Failure { code, message } => Err(
            build_v3_provider_sse_json_error(provider_id, &code, message),
        ),
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DirectSseInitialFrameAction {
    ContinueBuffering,
    StartClientStream,
}

fn build_v3_provider_sse_json_error(
    provider_id: &str,
    code: &str,
    message: String,
) -> V3Error01SourceRaised {
    build_v3_error_01_source_raised_external(
        V3ErrorSourceKind::ProviderFailure,
        "V3ProviderResp14Raw",
        code,
        message.clone(),
        V3ExternalErrorLink {
            kind: V3ExternalErrorKind::Provider,
            status: None,
            code: Some(code.to_string()),
            provider_id: Some(provider_id.to_string()),
            upstream_request_id: None,
            message: Some(message),
        },
    )
}

fn observed_sse_client_stream(
    provider_id: String,
    stream: V3ProviderSseStream,
    observation_state: V3SseRemoteContinuationObservationState,
    usage_observation: V3RuntimeStreamObservation,
) -> V3ClientSseStream {
    observed_sse_client_stream_with_timeout(
        provider_id,
        stream,
        observation_state,
        usage_observation,
        V3_DIRECT_SSE_FIRST_EVENT_TIMEOUT,
    )
}

fn observed_sse_client_stream_with_timeout(
    provider_id: String,
    stream: V3ProviderSseStream,
    observation_state: V3SseRemoteContinuationObservationState,
    usage_observation: V3RuntimeStreamObservation,
    frame_interval_timeout: std::time::Duration,
) -> V3ClientSseStream {
    struct ObservedState {
        stream: V3ProviderSseStream,
        decoder: SseIncrementalDecoder,
        response_id_candidate: Option<String>,
        observation_state: V3SseRemoteContinuationObservationState,
        usage_observation: V3RuntimeStreamObservation,
        provider_id: String,
        done: bool,
        terminal_observed: bool,
        semantic_deadline: tokio::time::Instant,
    }

    Box::pin(stream::unfold(
        ObservedState {
            stream,
            decoder: SseIncrementalDecoder::new(SseTransportLimits::default()),
            response_id_candidate: None,
            observation_state,
            usage_observation,
            provider_id,
            done: false,
            terminal_observed: false,
            semantic_deadline: tokio::time::Instant::now() + frame_interval_timeout,
        },
        move |mut state| async move {
            if state.done {
                return None;
            }
            let next = match tokio::time::timeout_at(state.semantic_deadline, state.stream.next()).await {
                Ok(next) => next,
                Err(_) if state.terminal_observed => {
                    return None;
                }
                Err(_) => {
                    state.done = true;
                    let error = build_v3_error_01_source_raised_external(
                        V3ErrorSourceKind::ProviderFailure,
                        "V3ProviderResp14Raw",
                        "provider_response_sse_inter_event_timeout",
                        "provider response SSE stream did not produce the next frame within timeout",
                        V3ExternalErrorLink {
                            kind: V3ExternalErrorKind::Provider,
                            status: None,
                            code: Some("PROVIDER_RESPONSE_SSE_INTER_EVENT_TIMEOUT".to_string()),
                            provider_id: Some(state.provider_id.clone()),
                            upstream_request_id: None,
                            message: Some(
                                "provider response SSE stream did not produce the next frame within timeout"
                                    .to_string(),
                            ),
                        },
                    );
                    return Some((Err(error), state));
                }
            };
            match next {
                Some(Ok(chunk)) => {
                    // transport 帧活跃即保活：任何 provider 字节（含 keepalive/
                    // 非语义帧）都刷新帧间隔 deadline，避免"活着但语义安静"
                    // 的流被误杀；只有完全无字节的挂起流才超时。
                    state.semantic_deadline =
                        tokio::time::Instant::now() + frame_interval_timeout;
                    let result = observe_sse_remote_continuation_chunk(
                        &state.provider_id,
                        &chunk,
                        &mut state.decoder,
                        &mut state.response_id_candidate,
                        &state.observation_state,
                        &state.usage_observation,
                    );
                    let result = match result {
                        Ok((terminal, semantic)) => {
                            state.terminal_observed |= terminal;
                            if terminal {
                                state.semantic_deadline =
                                    tokio::time::Instant::now() + frame_interval_timeout;
                            }
                            if semantic && !terminal {
                                state.semantic_deadline =
                                    tokio::time::Instant::now() + frame_interval_timeout;
                            }
                            Ok(chunk)
                        }
                        Err(error) => Err(error),
                    };
                    if result.is_err() {
                        state.done = true;
                    }
                    Some((result, state))
                }
                Some(Err(error)) => {
                    state.done = true;
                    Some((Err(provider_body_source(error)), state))
                }
                None => {
                    let decoder = std::mem::replace(
                        &mut state.decoder,
                        SseIncrementalDecoder::new(SseTransportLimits::default()),
                    );
                    match decoder
                        .finish()
                        .map_err(|error| sse_transport_source(&state.provider_id, error))
                    {
                        Ok(()) => None,
                        Err(error) => {
                            state.done = true;
                            Some((Err(error), state))
                        }
                    }
                }
            }
        },
    ))
}

fn observe_sse_remote_continuation_chunk(
    provider_id: &str,
    chunk: &[u8],
    decoder: &mut SseIncrementalDecoder,
    response_id_candidate: &mut Option<String>,
    observation_state: &V3SseRemoteContinuationObservationState,
    usage_observation: &V3RuntimeStreamObservation,
) -> Result<(bool, bool), V3Error01SourceRaised> {
    let frames = decoder
        .push(build_v3_sse_transport_in_01_raw_chunk(chunk))
        .map_err(|error| sse_transport_source(provider_id, error))?;
    let mut terminal_observed = false;
    let mut semantic_observed = false;
    for frame in frames {
        let fields = frame.frame().fields();
        if let Some(response_id) =
            observe_sse_frame_remote_continuation(provider_id, fields, response_id_candidate)?
        {
            observation_state.record_pending_response_id(&response_id)?;
        }
        observe_sse_usage_frame(provider_id, fields, usage_observation)?;
        let data = collect_v3_provider_sse_json_data(fields);
        let classification = match classify_v3_provider_generic_sse_json_data(&data) {
            Ok(classification) => classification,
            Err(message) => {
                return Err(build_v3_error_01_source_raised(
                    V3ErrorSourceKind::ProviderFailure,
                    "V3ProviderResp14Raw",
                    "provider_response_sse_event_invalid",
                    message,
                ));
            }
        };
        semantic_observed |= classification.is_some();
        terminal_observed |= matches!(
            classification,
            Some(V3ProviderResponsesJsonFrameOutcome::Terminal)
        );
    }
    Ok((terminal_observed, semantic_observed))
}

/// 从 provider SSE 事件帧提取归一化后的 usage（input/output/cache tokens），
/// 写入流观测器供 server 端 console 打印。SSE 在此处逐帧解码为 JSON
/// （inbound 归一化边界），提取只消费解码后的 JSON 事件，不触碰传输层语义。
fn observe_sse_usage_frame(
    provider_id: &str,
    fields: &[SseField],
    usage_observation: &V3RuntimeStreamObservation,
) -> Result<(), V3Error01SourceRaised> {
    let data = collect_v3_provider_sse_json_data(fields);
    // keepalive 文本帧不是 JSON 载荷：usage 观测直接放行，不把它打成
    // provider SSE event invalid（分类边界已在 classify 内统一忽略）。
    if is_v3_provider_sse_keepalive_text(&data) {
        return Ok(());
    }
    let Some(event) = parse_v3_provider_sse_json_data(&data).map_err(|error| {
        build_v3_error_01_source_raised_external(
            V3ErrorSourceKind::ProviderFailure,
            "V3ProviderResp14Raw",
            "provider_response_sse_event_invalid",
            error.clone(),
            V3ExternalErrorLink {
                kind: V3ExternalErrorKind::Provider,
                status: None,
                code: Some("PROVIDER_RESPONSE_SSE_EVENT_INVALID".to_string()),
                provider_id: Some(provider_id.to_string()),
                upstream_request_id: None,
                message: Some(error),
            },
        )
    })?
    else {
        return Ok(());
    };
    usage_observation
        .record_provider_event_json(&event)
        .map_err(|error| {
            build_v3_error_01_source_raised(
                V3ErrorSourceKind::RuntimeFailure,
                "V3ProviderResp14Raw",
                "provider_response_sse_usage_observation_failed",
                error,
            )
        })
}

fn observe_sse_remote_continuation_bytes(
    provider_id: &str,
    body: &[u8],
) -> Result<V3RemoteContinuationObservation, V3Error01SourceRaised> {
    let mut response_id_candidate = None;
    let mut pending_response_id = None;
    let mut decoder = SseIncrementalDecoder::new(SseTransportLimits::default());
    let frames = decoder
        .push(build_v3_sse_transport_in_01_raw_chunk(body))
        .map_err(|error| sse_transport_source(provider_id, error))?;
    for frame in frames {
        if let Some(response_id) = observe_sse_frame_remote_continuation(
            provider_id,
            frame.frame().fields(),
            &mut response_id_candidate,
        )? {
            pending_response_id = Some(response_id);
        }
    }
    decoder
        .finish()
        .map_err(|error| sse_transport_source(provider_id, error))?;
    Ok(
        pending_response_id.map_or(V3RemoteContinuationObservation::Terminal, |response_id| {
            V3RemoteContinuationObservation::Pending { response_id }
        }),
    )
}

fn observe_sse_frame_remote_continuation(
    provider_id: &str,
    fields: &[SseField],
    response_id_candidate: &mut Option<String>,
) -> Result<Option<String>, V3Error01SourceRaised> {
    let data = collect_v3_provider_sse_json_data(fields);
    let Some(event) = parse_v3_provider_sse_json_data(&data).map_err(|error| {
        build_v3_error_01_source_raised_external(
            V3ErrorSourceKind::ProviderFailure,
            "V3ProviderResp14Raw",
            "provider_response_sse_event_invalid",
            error.clone(),
            V3ExternalErrorLink {
                kind: V3ExternalErrorKind::Provider,
                status: None,
                code: Some("PROVIDER_RESPONSE_SSE_EVENT_INVALID".to_string()),
                provider_id: Some(provider_id.to_string()),
                upstream_request_id: None,
                message: Some(error),
            },
        )
    })?
    else {
        return Ok(None);
    };
    let semantic = event.get("response").unwrap_or(&event);
    let semantic_response_id = semantic
        .get("id")
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .map(ToOwned::to_owned);
    if let Some(response_id) = semantic_response_id.as_ref() {
        *response_id_candidate = Some(response_id.clone());
    }
    if matches!(
        event
            .pointer("/item/type")
            .and_then(serde_json::Value::as_str),
        Some("function_call" | "custom_tool_call")
    ) {
        let response_id = event
            .get("response_id")
            .and_then(serde_json::Value::as_str)
            .map(str::trim)
            .filter(|id| !id.is_empty())
            .map(ToOwned::to_owned)
            .or_else(|| semantic_response_id.clone())
            .or_else(|| response_id_candidate.clone())
            .ok_or_else(|| {
                build_v3_error_01_source_raised_external(
                    V3ErrorSourceKind::ProviderFailure,
                    "V3ProviderResp14Raw",
                    "pending_remote_response_id_missing",
                    "pending SSE function call has no response id",
                    V3ExternalErrorLink {
                        kind: V3ExternalErrorKind::Provider,
                        status: None,
                        code: Some("PENDING_REMOTE_RESPONSE_ID_MISSING".to_string()),
                        provider_id: Some(provider_id.to_string()),
                        upstream_request_id: None,
                        message: Some("pending SSE function call has no response id".to_string()),
                    },
                )
            })?;
        return Ok(Some(response_id));
    }
    let has_pending_tool_output = semantic
        .get("output")
        .and_then(serde_json::Value::as_array)
        .is_some_and(|items| {
            items.iter().any(|item| {
                matches!(
                    item.get("type").and_then(serde_json::Value::as_str),
                    Some("function_call" | "custom_tool_call")
                )
            })
        });
    let requires_action = matches!(
        semantic.get("status").and_then(serde_json::Value::as_str),
        Some("requires_action")
    );
    if has_pending_tool_output || requires_action {
        let response_id = semantic_response_id
            .or_else(|| response_id_candidate.clone())
            .ok_or_else(|| {
                build_v3_error_01_source_raised_external(
                    V3ErrorSourceKind::ProviderFailure,
                    "V3ProviderResp14Raw",
                    "pending_remote_response_id_missing",
                    "pending SSE continuation has no response id",
                    V3ExternalErrorLink {
                        kind: V3ExternalErrorKind::Provider,
                        status: None,
                        code: Some("PENDING_REMOTE_RESPONSE_ID_MISSING".to_string()),
                        provider_id: Some(provider_id.to_string()),
                        upstream_request_id: None,
                        message: Some("pending SSE continuation has no response id".to_string()),
                    },
                )
            })?;
        return Ok(Some(response_id));
    }
    Ok(None)
}

fn observe_json_remote_continuation(
    provider_id: &str,
    status: u16,
    body: &serde_json::Value,
) -> Result<V3RemoteContinuationObservation, V3Error01SourceRaised> {
    let pending = matches!(
        body.get("status").and_then(serde_json::Value::as_str),
        Some("requires_action" | "in_progress")
    ) || body
        .get("output")
        .and_then(serde_json::Value::as_array)
        .is_some_and(|items| {
            items.iter().any(|item| {
                matches!(
                    item.get("type").and_then(serde_json::Value::as_str),
                    Some("function_call" | "custom_tool_call")
                )
            })
        });
    if !pending {
        return Ok(V3RemoteContinuationObservation::Terminal);
    }
    let response_id = body
        .get("id")
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .ok_or_else(|| {
            build_v3_error_01_source_raised_external(
                V3ErrorSourceKind::ProviderFailure,
                "V3ProviderResp14Raw",
                "pending_remote_response_id_missing",
                "pending Responses continuation has no response id",
                V3ExternalErrorLink {
                    kind: V3ExternalErrorKind::Provider,
                    status: Some(status),
                    code: Some("PENDING_REMOTE_RESPONSE_ID_MISSING".to_string()),
                    provider_id: Some(provider_id.to_string()),
                    upstream_request_id: None,
                    message: Some("pending Responses continuation has no response id".to_string()),
                },
            )
        })?;
    Ok(V3RemoteContinuationObservation::Pending {
        response_id: response_id.to_string(),
    })
}

fn provider_body_source(error: V3ProviderError) -> V3Error01SourceRaised {
    match &error {
        V3ProviderError::ResponseBody {
            provider_id,
            reason,
            ..
        } => build_v3_error_01_source_raised_external(
            V3ErrorSourceKind::ProviderFailure,
            "V3ProviderResp14Raw",
            "provider_response_body_error",
            error.to_string(),
            V3ExternalErrorLink {
                kind: V3ExternalErrorKind::Provider,
                status: None,
                code: Some("PROVIDER_RESPONSE_BODY".to_string()),
                provider_id: Some(provider_id.clone()),
                upstream_request_id: None,
                message: Some(reason.clone()),
            },
        ),
        V3ProviderError::MalformedSse {
            provider_id,
            reason,
            ..
        } => build_v3_error_01_source_raised_external(
            V3ErrorSourceKind::ProviderFailure,
            "V3ProviderResp14Raw",
            "provider_malformed_sse",
            error.to_string(),
            V3ExternalErrorLink {
                kind: V3ExternalErrorKind::Provider,
                status: None,
                code: Some("PROVIDER_MALFORMED_SSE".to_string()),
                provider_id: Some(provider_id.clone()),
                upstream_request_id: None,
                message: Some(reason.clone()),
            },
        ),
        _ => build_v3_error_01_source_raised(
            V3ErrorSourceKind::ProviderFailure,
            "V3ProviderResp14Raw",
            "provider_response_body_error",
            error.to_string(),
        ),
    }
}

fn sse_transport_source(provider_id: &str, error: SseTransportError) -> V3Error01SourceRaised {
    build_v3_error_01_source_raised_external(
        V3ErrorSourceKind::ProviderFailure,
        "V3ProviderResp14Raw",
        "provider_response_sse_invalid",
        error.to_string(),
        V3ExternalErrorLink {
            kind: V3ExternalErrorKind::Provider,
            status: None,
            code: Some("PROVIDER_RESPONSE_SSE_INVALID".to_string()),
            provider_id: Some(provider_id.to_string()),
            upstream_request_id: None,
            message: Some(error.to_string()),
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use routecodex_v3_provider_responses::V3ProviderResponseHeader;

    #[tokio::test]
    async fn missing_content_type_is_explicit_error() {
        let result = project_provider_raw_to_client_payload(V3ProviderResp14Raw::from_json(
            "req",
            "test",
            200,
            Vec::new(),
            br#"{"id":"resp"}"#.to_vec(),
        ))
        .await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn direct_sse_response_failed_projects_provider_error_before_client_stream() {
        let raw = V3ProviderResp14Raw::from_sse(
            "req".to_string(),
            "provider".to_string(),
            200,
            vec![V3ProviderResponseHeader {
                name: "content-type".to_string(),
                value: b"text/event-stream".to_vec(),
            }],
            Box::pin(stream::iter(vec![Ok::<Vec<u8>, V3ProviderError>(
                b"event: response.failed\ndata: {\"type\":\"response.failed\",\"response\":{\"status\":\"failed\",\"error\":{\"code\":\"HTTP_429\",\"message\":\"provider quota exceeded\"}}}\n\n".to_vec(),
            )])),
        );

        let error = project_provider_raw_to_client_payload(raw)
            .await
            .unwrap_err();
        assert_eq!(error.source_kind, V3ErrorSourceKind::ProviderFailure);
        assert_eq!(error.source_stage, "V3ProviderResp14Raw");
        assert_eq!(error.code, "HTTP_429");
        assert!(error.message.contains("provider quota exceeded"));
    }

    #[tokio::test]
    async fn direct_sse_response_cancelled_projects_provider_error_before_client_stream() {
        let raw = V3ProviderResp14Raw::from_sse(
            "req".to_string(),
            "provider".to_string(),
            200,
            vec![V3ProviderResponseHeader {
                name: "content-type".to_string(),
                value: b"text/event-stream".to_vec(),
            }],
            Box::pin(stream::iter(vec![Ok::<Vec<u8>, V3ProviderError>(
                b"event: response.cancelled\ndata: {\"type\":\"response.cancelled\",\"response\":{\"status\":\"cancelled\",\"error\":{\"code\":\"provider_cancelled\",\"message\":\"provider cancelled before commit\"}}}\n\n".to_vec(),
            )])),
        );

        let error = project_provider_raw_to_client_payload(raw)
            .await
            .unwrap_err();
        assert_eq!(error.source_kind, V3ErrorSourceKind::ProviderFailure);
        assert_eq!(error.source_stage, "V3ProviderResp14Raw");
        assert_eq!(error.code, "provider_cancelled");
        assert!(error.message.contains("provider cancelled before commit"));
    }

    #[tokio::test]
    async fn direct_sse_created_then_failed_still_projects_provider_error_before_client_stream() {
        let raw = V3ProviderResp14Raw::from_sse(
            "req".to_string(),
            "provider".to_string(),
            200,
            vec![V3ProviderResponseHeader {
                name: "content-type".to_string(),
                value: b"text/event-stream".to_vec(),
            }],
            Box::pin(stream::iter(vec![Ok::<Vec<u8>, V3ProviderError>(
                b"event: response.created\ndata: {\"type\":\"response.created\",\"response\":{\"id\":\"resp_1\",\"status\":\"in_progress\"}}\n\nevent: response.failed\ndata: {\"type\":\"response.failed\",\"response\":{\"status\":\"failed\",\"error\":{\"code\":\"insufficient_quota\",\"message\":\"quota stopped after created\"}}}\n\n".to_vec(),
            )])),
        );

        let error = project_provider_raw_to_client_payload(raw)
            .await
            .unwrap_err();
        assert_eq!(error.source_kind, V3ErrorSourceKind::ProviderFailure);
        assert_eq!(error.code, "insufficient_quota");
        assert!(error.message.contains("quota stopped after created"));
    }

    #[tokio::test]
    async fn direct_sse_first_non_failure_frame_replays_buffered_chunk() {
        let raw = V3ProviderResp14Raw::from_sse(
            "req".to_string(),
            "provider".to_string(),
            200,
            vec![V3ProviderResponseHeader {
                name: "content-type".to_string(),
                value: b"text/event-stream".to_vec(),
            }],
            Box::pin(stream::iter(vec![Ok::<Vec<u8>, V3ProviderError>(
                b"event: response.output_text.delta\ndata: {\"type\":\"response.output_text.delta\",\"delta\":\"ok\"}\n\nevent: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"status\":\"completed\"}}\n\n".to_vec(),
            )])),
        );

        let projection = project_provider_raw_to_client_payload(raw).await.unwrap();
        match projection.client_payload.body {
            V3ClientBody::Sse(mut stream) => {
                let chunk = stream.next().await.unwrap().unwrap();
                let text = std::str::from_utf8(&chunk).unwrap();
                assert!(text.contains("response.output_text.delta"), "{text}");
                assert!(text.contains("ok"), "{text}");
                assert!(stream.next().await.is_none());
            }
            other => panic!("expected direct SSE body, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn direct_sse_projection_starts_client_stream_before_provider_eof() {
        let raw = V3ProviderResp14Raw::from_sse(
            "req".to_string(),
            "provider".to_string(),
            200,
            vec![V3ProviderResponseHeader {
                name: "content-type".to_string(),
                value: b"text/event-stream".to_vec(),
            }],
            Box::pin(
                stream::iter(vec![Ok::<Vec<u8>, V3ProviderError>(
                    b"event: response.output_text.delta\ndata: {\"type\":\"response.output_text.delta\",\"delta\":\"early\"}\n\n".to_vec(),
                )])
                .chain(futures_util::stream::pending()),
            ),
        );

        let projection = project_provider_raw_to_client_payload(raw).await.unwrap();
        let V3ClientBody::Sse(mut stream) = projection.client_payload.body else {
            panic!("expected direct SSE body");
        };
        let chunk = tokio::time::timeout(std::time::Duration::from_millis(100), stream.next())
            .await
            .expect("client stream must start before provider EOF")
            .expect("provider first chunk must be forwarded")
            .expect("provider first chunk must be valid");
        assert!(std::str::from_utf8(&chunk).unwrap().contains("early"));
    }

    #[tokio::test]
    async fn direct_sse_projection_times_out_after_provider_stalls_between_frames() {
        let first =
            b"data: {\"type\":\"response.output_text.delta\",\"delta\":\"early\"}\n\n"
                .to_vec();
        let mut stream = observed_sse_client_stream_with_timeout(
            "provider".to_string(),
            Box::pin(
                stream::iter(vec![Ok::<Vec<u8>, V3ProviderError>(first)])
                    .chain(futures_util::stream::pending()),
            ),
            V3SseRemoteContinuationObservationState::default(),
            V3RuntimeStreamObservation::default(),
            std::time::Duration::from_millis(20),
        );
        let first = stream.next().await.expect("first frame").expect("valid first frame");
        assert!(std::str::from_utf8(&first).unwrap().contains("early"));
        let error = stream
            .next()
            .await
            .expect("mid-stream stall must become an explicit error")
            .expect_err("mid-stream stall must not become silent EOF");
        assert_eq!(error.code, "provider_response_sse_inter_event_timeout");
    }

    #[tokio::test]
    async fn provider_http_429_keeps_external_identity_and_status() {
        let result = project_provider_raw_to_client_payload(V3ProviderResp14Raw::from_json(
            "req",
            "test-provider",
            429,
            vec![V3ProviderResponseHeader {
                name: "content-type".to_string(),
                value: b"application/json".to_vec(),
            }],
            br#"{"error":{"code":"rate_limit"}}"#.to_vec(),
        ))
        .await
        .unwrap_err();
        assert_eq!(result.source_kind, V3ErrorSourceKind::ProviderFailure);
        assert!(result.internal_error.is_none());
        let external = result.external_error.expect("external provider error");
        assert_eq!(external.status, Some(429));
        assert_eq!(external.provider_id.as_deref(), Some("test-provider"));
        assert_eq!(external.code.as_deref(), Some("HTTP_429"));
    }

    #[tokio::test]
    async fn malformed_provider_json_keeps_external_identity() {
        let result = project_provider_raw_to_client_payload(V3ProviderResp14Raw::from_json(
            "req",
            "test-provider",
            200,
            vec![V3ProviderResponseHeader {
                name: "content-type".to_string(),
                value: b"application/json".to_vec(),
            }],
            b"not-json".to_vec(),
        ))
        .await
        .unwrap_err();
        assert_eq!(result.source_kind, V3ErrorSourceKind::ProviderFailure);
        assert!(result.internal_error.is_none());
        let external = result.external_error.expect("external provider error");
        assert_eq!(external.provider_id.as_deref(), Some("test-provider"));
        assert_eq!(
            external.code.as_deref(),
            Some("PROVIDER_RESPONSE_JSON_INVALID")
        );
    }

    #[tokio::test]
    async fn inbound_sse_usage_extraction_records_chat_usage_into_stream_observation() {
        // SSE 在 inbound 层逐帧解码为 JSON，usage（含 cache）在同一处提取，
        // 写入流观测器；SSE 传输层本身不做任何语义观测。
        use futures_util::StreamExt;

        let provider_id = "test-provider".to_string();
        let stream = futures_util::stream::iter(vec![Ok::<_, routecodex_v3_provider_responses::V3ProviderError>(
            b"data: {\"id\":\"req-1\",\"object\":\"chat.completion.chunk\",\"model\":\"m\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"hi\"}}]}\n\ndata: {\"id\":\"req-1\",\"object\":\"chat.completion.chunk\",\"model\":\"m\",\"choices\":[],\"usage\":{\"prompt_tokens\":371,\"completion_tokens\":29,\"total_tokens\":400,\"prompt_tokens_details\":{\"cached_tokens\":256}}}\n\ndata: [DONE]\n\n"
                .to_vec(),
        )]);

        let observation_state = V3SseRemoteContinuationObservationState::default();
        let usage_observation = V3RuntimeStreamObservation::default();
        let mut client_stream = observed_sse_client_stream(
            provider_id.clone(),
            Box::pin(stream),
            observation_state,
            usage_observation.clone(),
        );
        while client_stream.next().await.is_some() {}

        let snapshot = usage_observation.snapshot().expect("usage observation");
        let usage = snapshot
            .usage
            .expect("chat usage must be extracted at inbound");
        assert_eq!(usage.input_tokens, Some(371));
        assert_eq!(usage.output_tokens, Some(29));
        assert_eq!(usage.cached_tokens, Some(256));
        assert_eq!(usage.total_tokens, Some(400));
        // SSE 传输层不产生 timing 语义（timing 由调用方收口）。
        assert!(snapshot.timing.is_none());
    }

    #[tokio::test]
    async fn guard_initial_direct_sse_provider_failure_times_out_on_hung_provider() {
        // 正向：provider 返回 200 但 SSE 首帧挂起（连接保持、无数据）时必须
        // fail-fast 归一化为 transport Error01（provider_response_sse_first_event_timeout），
        // 进入错误链触发 reselect/Error06，而不是无限等待 -> 客户端超时/EOF。
        let hung: V3ProviderSseStream = Box::pin(futures_util::stream::pending::<
            Result<Vec<u8>, V3ProviderError>,
        >());
        let result = guard_initial_direct_sse_provider_failure_with_timeout(
            "hung-provider",
            hung,
            std::time::Duration::from_millis(50),
        )
        .await;
        let Err(error) = result else {
            panic!("hung provider SSE first frame must time out");
        };
        assert_eq!(error.source_kind, V3ErrorSourceKind::ProviderFailure);
        assert_eq!(
            error.code, "provider_response_sse_first_event_timeout",
            "expected first-event timeout error: {error:?}"
        );
        let external = error.external_error.expect("external provider link");
        assert_eq!(
            external.code.as_deref(),
            Some("PROVIDER_RESPONSE_SSE_FIRST_EVENT_TIMEOUT")
        );
        assert_eq!(external.provider_id.as_deref(), Some("hung-provider"));
    }

    #[tokio::test]
    async fn guard_initial_direct_sse_provider_failure_accepts_prompt_first_frame() {
        // 反向：正常 provider 在超时内给出首个语义事件（首个非前导事件 ->
        // StartClientStream）则放行并 replay 缓冲字节，不误杀健康 provider。
        use serde_json::json;
        let delta = json!({
            "type": "response.output_text.delta",
            "delta": "hi"
        });
        let wire = format!("data: {}\n\n", delta).into_bytes();
        let stream: V3ProviderSseStream =
            Box::pin(futures_util::stream::once(async move { Ok(wire) }));
        let mut guarded = guard_initial_direct_sse_provider_failure_with_timeout(
            "prompt-provider",
            stream,
            std::time::Duration::from_secs(5),
        )
        .await
        .expect("prompt provider must not time out");
        let first = guarded.next().await.expect("replayed first chunk");
        assert!(first.is_ok());
        assert!(guarded.next().await.is_none());
    }

    #[tokio::test]
    async fn direct_sse_projection_exposes_post_first_frame_provider_error_after_commit() {
        let first =
            b"data: {\"type\":\"response.output_text.delta\",\"delta\":\"partial\"}\n\n".to_vec();
        let source: V3ProviderSseStream = Box::pin(futures_util::stream::iter(vec![
            Ok(first),
            Err(V3ProviderError::ResponseBody {
                request_id: "req".to_string(),
                provider_id: "provider".to_string(),
                reason: "upstream closed stream".to_string(),
            }),
        ]));
        let raw = V3ProviderResp14Raw::from_sse(
            "req".to_string(),
            "provider".to_string(),
            200,
            vec![V3ProviderResponseHeader {
                name: "content-type".to_string(),
                value: b"text/event-stream".to_vec(),
            }],
            source,
        );
        let projection = project_provider_raw_to_client_payload(raw)
            .await
            .expect("post-first-frame failure belongs to the committed client stream");
        let V3ClientBody::Sse(mut stream) = projection.client_payload.body else {
            panic!("expected direct SSE body");
        };
        let first = stream
            .next()
            .await
            .expect("first provider frame must reach the client")
            .expect("first provider frame must be valid");
        assert!(std::str::from_utf8(&first).unwrap().contains("partial"));
        let error = stream
            .next()
            .await
            .expect("post-commit provider error must not become silent EOF")
            .expect_err("post-commit provider error must remain explicit");
        assert_eq!(error.source_kind, V3ErrorSourceKind::ProviderFailure);
        assert_eq!(error.code, "provider_response_body_error");
    }

    #[tokio::test]
    async fn direct_json_deepseek_console_go_compat_requires_profile_not_provider_id() {
        // 反向：provider_id 是 opencode-go 但 raw 未携带
        // responses:deepseek-console-go profile 时不得做响应回射——
        // 能力按配置声明的 compatibility profile 门控，不按部署身份分支。
        let raw = V3ProviderResp14Raw::from_json(
            "req",
            "opencode-go",
            200,
            vec![V3ProviderResponseHeader {
                name: "content-type".to_string(),
                value: b"application/json".to_vec(),
            }],
            br#"{"id":"resp_1","output":[{"type":"function_call","call_id":"call_1","name":"exec_command","arguments":"{\"input\":\"ls -la\"}"}]}"#
                .to_vec(),
        );
        let projection = project_provider_raw_to_client_payload(raw).await.unwrap();
        let V3ClientBody::Json(body) = &projection.client_payload.body else {
            panic!("expected JSON client body");
        };
        assert_eq!(
            body["output"][0]["type"], "function_call",
            "no profile must keep function_call untouched: {body}"
        );
    }

    #[tokio::test]
    async fn direct_json_deepseek_console_go_compat_follows_compatibility_profile() {
        // 正向：provider_id 不是 opencode-go，但声明了
        // responses:deepseek-console-go profile，function_call 必须回射为
        // custom_tool_call（客户端声明的 custom 工具形态）。
        let raw = V3ProviderResp14Raw::from_json(
            "req",
            "ds-provider",
            200,
            vec![V3ProviderResponseHeader {
                name: "content-type".to_string(),
                value: b"application/json".to_vec(),
            }],
            br#"{"id":"resp_1","output":[{"type":"function_call","call_id":"call_1","name":"exec_command","arguments":"{\"input\":\"ls -la\"}"}]}"#
                .to_vec(),
        )
        .with_compatibility_profile(Some("responses:deepseek-console-go".to_string()));
        let projection = project_provider_raw_to_client_payload(raw).await.unwrap();
        let V3ClientBody::Json(body) = &projection.client_payload.body else {
            panic!("expected JSON client body");
        };
        assert_eq!(
            body["output"][0]["type"], "custom_tool_call",
            "profile compat must rewrite function_call: {body}"
        );
        assert_eq!(body["output"][0]["input"], "ls -la");
        assert!(body["output"][0].get("arguments").is_none());
    }
}
