use crate::hub_v1::{
    classify_v3_provider_generic_sse_json_data, parse_v3_provider_sse_json_data,
    V3ProviderResponsesJsonFrameOutcome,
    V3RuntimeStreamObservation,
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

/// Direct SSE 首帧超时：provider 返回 200 但首个语义事件挂起时 fail-fast
/// （默认 30s，明显短于 provider 请求总超时，避免客户端无限等待/EOF 且无日志）。
/// 超时归一化为 transport Error01 进入错误链（reselect / Error06 终态投影），
/// 不在 server/SSE 层裸造错误帧。
const V3_DIRECT_SSE_FIRST_EVENT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);

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
    let (body, remote_continuation, stream_observation) = if content_type.starts_with("text/event-stream") {
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
        let parsed: serde_json::Value = serde_json::from_slice(&body_bytes).map_err(|error| {
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
            return Err(
                build_v3_error_01_source_raised_external(
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
                )
            );
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
    let mut data = String::new();
    for field in fields {
        let SseField::Named { name, value } = field else {
            continue;
        };
        if name == "data" {
            if !data.is_empty() {
                data.push('\n');
            }
            data.push_str(value);
        }
    }
    let parsed = classify_v3_provider_generic_sse_json_data(&data).map_err(|message| {
        build_v3_provider_sse_json_error(provider_id, "provider_response_sse_event_invalid", message)
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
        V3ProviderResponsesJsonFrameOutcome::Failure { code, message } => {
            Err(build_v3_provider_sse_json_error(provider_id, &code, message))
        }
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
    struct ObservedState {
        stream: V3ProviderSseStream,
        decoder: SseIncrementalDecoder,
        response_id_candidate: Option<String>,
        observation_state: V3SseRemoteContinuationObservationState,
        usage_observation: V3RuntimeStreamObservation,
        provider_id: String,
        done: bool,
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
        },
        |mut state| async move {
            if state.done {
                return None;
            }
            match state.stream.next().await {
                Some(Ok(chunk)) => {
                    let result = observe_sse_remote_continuation_chunk(
                        &state.provider_id,
                        &chunk,
                        &mut state.decoder,
                        &mut state.response_id_candidate,
                        &state.observation_state,
                        &state.usage_observation,
                    )
                    .map(|()| chunk);
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
) -> Result<(), V3Error01SourceRaised> {
    let frames = decoder
        .push(build_v3_sse_transport_in_01_raw_chunk(chunk))
        .map_err(|error| sse_transport_source(provider_id, error))?;
    for frame in frames {
        let fields = frame.frame().fields();
        if let Some(response_id) =
            observe_sse_frame_remote_continuation(provider_id, fields, response_id_candidate)?
        {
            observation_state.record_pending_response_id(&response_id)?;
        }
        observe_sse_usage_frame(provider_id, fields, usage_observation)?;
    }
    Ok(())
}

/// 从 provider SSE 事件帧提取归一化后的 usage（input/output/cache tokens），
/// 写入流观测器供 server 端 console 打印。SSE 在此处逐帧解码为 JSON
/// （inbound 归一化边界），提取只消费解码后的 JSON 事件，不触碰传输层语义。
fn observe_sse_usage_frame(
    provider_id: &str,
    fields: &[SseField],
    usage_observation: &V3RuntimeStreamObservation,
) -> Result<(), V3Error01SourceRaised> {
    let mut data = String::new();
    for field in fields {
        let SseField::Named { name, value } = field else {
            continue;
        };
        if name != "data" {
            continue;
        }
        if !data.is_empty() {
            data.push('\n');
        }
        data.push_str(value);
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
    })? else {
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
    let mut data = String::new();
    for field in fields {
        let SseField::Named { name, value } = field else {
            continue;
        };
        if name != "data" {
            continue;
        }
        if !data.is_empty() {
            data.push('\n');
        }
        data.push_str(value);
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
    })? else {
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
                b"event: response.output_text.delta\ndata: {\"type\":\"response.output_text.delta\",\"delta\":\"ok\"}\n\n".to_vec(),
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
        let usage = snapshot.usage.expect("chat usage must be extracted at inbound");
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
}
