use crate::direct_response_hooks::{V3DirectResponseCompatBlock, V3DirectResponseCompatPlan};
use crate::hub_v1::{
    classify_v3_provider_sse_json_data, collect_v3_provider_sse_json_data,
    is_v3_provider_sse_keepalive_text, normalize_v3_provider_sse_json_data_for_event_name,
    parse_v3_provider_sse_json_data, v3_feature_enabled_for_server, V3HubProviderWireProtocol,
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

pub(crate) use crate::shared_direct_thinking_compat::project_v3_thinking_tag_text;

/// Direct SSE 帧间超时：provider 返回 200 但首个或后续语义事件挂起时 fail-fast
/// （默认 60s，明显短于 provider 请求总超时，避免客户端无限等待/EOF 且无日志）。
/// 超时归一化为 transport Error01 进入错误链（reselect / Error06 终态投影），
/// 不在 server/SSE 层裸造错误帧。
const V3_DIRECT_SSE_FIRST_EVENT_TIMEOUT: std::time::Duration =
    std::time::Duration::from_secs(60);

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
    pub compat_plan: V3DirectResponseCompatPlan,
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

pub(crate) async fn project_provider_raw_to_client_payload_with_plan(
    raw: V3ProviderResp14Raw,
    plan: &V3DirectResponseCompatPlan,
    tool_thinking_enabled: bool,
) -> Result<V3ProviderResponseProjection, V3Error01SourceRaised> {
    project_provider_raw_to_client_payload_with_plan_and_projection(
        raw,
        plan,
        tool_thinking_enabled,
        true,
    )
    .await
}

pub(crate) async fn project_provider_raw_to_client_payload_with_plan_and_projection(
    raw: V3ProviderResp14Raw,
    plan: &V3DirectResponseCompatPlan,
    tool_thinking_enabled: bool,
    toolreason_client_projection: bool,
) -> Result<V3ProviderResponseProjection, V3Error01SourceRaised> {
    project_provider_raw_to_client_payload_with_plan_and_projection_and_observation_context(
        raw,
        plan,
        tool_thinking_enabled,
        toolreason_client_projection,
        None,
    )
    .await
}

pub(crate) async fn project_provider_raw_to_client_payload_with_plan_and_projection_and_observation_context(
    raw: V3ProviderResp14Raw,
    plan: &V3DirectResponseCompatPlan,
    tool_thinking_enabled: bool,
    toolreason_client_projection: bool,
    observation_session_id: Option<&str>,
) -> Result<V3ProviderResponseProjection, V3Error01SourceRaised> {
    project_provider_raw_to_client_payload_inner(
        raw,
        plan,
        tool_thinking_enabled,
        toolreason_client_projection,
        observation_session_id,
    )
    .await
}

async fn project_provider_raw_to_client_payload_inner(
    raw: V3ProviderResp14Raw,
    compat_plan: &V3DirectResponseCompatPlan,
    tool_thinking_enabled: bool,
    toolreason_client_projection: bool,
    observation_session_id: Option<&str>,
) -> Result<V3ProviderResponseProjection, V3Error01SourceRaised> {
    let provider_id = raw.provider_id().to_string();
    let request_id = raw.request_id().to_string();
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
    let deepseek_console_go =
        compat_plan.has_block(V3DirectResponseCompatBlock::DeepseekConsoleGoResponseShape);
    // The thinking-tag wrapper is a Responses event rewriter and requires a
    // Responses terminal event. Chat and Anthropic streams have different
    // terminal contracts; applying the wrapper there aborts the stream before
    // the protocol-specific Resp03 toolreason hook can close out observation.
    let thinking_tags = compat_plan.has_block(V3DirectResponseCompatBlock::ThinkingTags)
        && compat_plan.provider_protocol == V3HubProviderWireProtocol::Responses;
    let sse_first_frame_timeout_ms = raw.sse_first_frame_timeout_ms();
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
            V3ProviderResponseBody::Sse(stream) => {
                process_direct_sse_stream(
                    &provider_id,
                    &request_id,
                    observation_session_id,
                    stream,
                    sse_first_frame_timeout_ms,
                    thinking_tags,
                    deepseek_console_go,
                    compat_plan.provider_protocol,
                    tool_thinking_enabled,
                    toolreason_client_projection,
                )
                .await?
            }
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
        if thinking_tags {
            parsed = provider_compat_core::apply_cc_sol_response_compat(parsed);
        }
        if deepseek_console_go {
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
        compat_plan: compat_plan.clone(),
    })
}

/// Sole direct-provider SSE entry. Every direct SSE response must pass through
/// this lifecycle: initial guard, client projection, frame observation,
/// provider-error classification, and compatibility mapping.
async fn process_direct_sse_stream(
    provider_id: &str,
    request_id: &str,
    session_id: Option<&str>,
    stream: V3ProviderSseStream,
    sse_first_frame_timeout_ms: Option<u64>,
    thinking_tags: bool,
    deepseek_console_go: bool,
    provider_protocol: crate::hub_v1::V3HubProviderWireProtocol,
    tool_thinking_enabled: bool,
    toolreason_client_projection: bool,
) -> Result<
    (
        V3ClientBody,
        V3RemoteContinuationObservation,
        Option<V3RuntimeStreamObservation>,
    ),
    V3Error01SourceRaised,
> {
    let compatibility_profile = thinking_tags
        .then_some("responses:thinking-tags")
        .or_else(|| deepseek_console_go.then_some("responses:deepseek-console-go"));
    let stream = guard_initial_direct_sse_provider_failure(
        provider_id,
        stream,
        sse_first_frame_timeout_ms,
        compatibility_profile,
        provider_protocol,
    )
    .await?;
    let observation_state = V3SseRemoteContinuationObservationState::default();
    let usage_observation = V3RuntimeStreamObservation::default();
    let client_stream = observed_sse_client_stream_with_timeout_and_projection_and_request_id(
        provider_id.to_string(),
        request_id.to_string(),
        session_id,
        stream,
        observation_state.clone(),
        usage_observation.clone(),
        V3_DIRECT_SSE_FIRST_EVENT_TIMEOUT,
        compatibility_profile,
        provider_protocol,
        // Resp03 toolreason parsing/projection has one owner: the registered
        // direct SSE typed hook applied by kernel/direct_sse_consumers.rs.
        // This shared stream wrapper only observes transport/usage state;
        // running the same hook here creates a second turn closeout and can
        // emit MISSING before the typed hook sees the complete tool args.
        false,
        false,
    );
    Ok((
        V3ClientBody::ProviderSse(client_stream),
        V3RemoteContinuationObservation::Streaming {
            state: observation_state,
        },
        Some(usage_observation),
    ))
}

async fn guard_initial_direct_sse_provider_failure(
    provider_id: &str,
    stream: V3ProviderSseStream,
    sse_first_frame_timeout_ms: Option<u64>,
    compatibility_profile: Option<&str>,
    provider_protocol: crate::hub_v1::V3HubProviderWireProtocol,
) -> Result<V3ProviderSseStream, V3Error01SourceRaised> {
    let first_event_timeout = sse_first_frame_timeout_ms
        .map(std::time::Duration::from_millis)
        .unwrap_or(V3_DIRECT_SSE_FIRST_EVENT_TIMEOUT);
    guard_initial_direct_sse_provider_failure_with_timeout(
        provider_id,
        stream,
        first_event_timeout,
        compatibility_profile,
        provider_protocol,
    )
    .await
}

async fn guard_initial_direct_sse_provider_failure_with_timeout(
    provider_id: &str,
    mut stream: V3ProviderSseStream,
    first_event_timeout: std::time::Duration,
    compatibility_profile: Option<&str>,
    provider_protocol: crate::hub_v1::V3HubProviderWireProtocol,
) -> Result<V3ProviderSseStream, V3Error01SourceRaised> {
    let mut decoder = SseIncrementalDecoder::new(SseTransportLimits::default());
    let mut buffered = Vec::<Vec<u8>>::new();
    // This is a deadline for the first semantic event, not a per-chunk idle
    // timer. Transport keepalives must preserve the client connection, but
    // must not extend a provider stream that never produces a semantic frame.
    let first_event_deadline = tokio::time::Instant::now() + first_event_timeout;
    loop {
        // 首帧超时守卫：provider 返回 200 但 SSE 首帧挂起（连接保持、无数据）时，
        // 必须 fail-fast 产生显式 provider 错误（而不是无限等待 -> 客户端超时/EOF
        // 且无 console 打印）。超时错误进入 provider 失败链，可触发 reselect 与
        // console 错误投影；客户端连接由 server 侧 keepalive 保持存活，与 provider
        // 状态解耦。
        let next = tokio::time::timeout_at(first_event_deadline, stream.next())
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
            if direct_sse_frame_provider_failure_source(
                provider_id,
                frame.frame().fields(),
                compatibility_profile,
                should_start_client_stream,
                provider_protocol,
            )? == DirectSseInitialFrameAction::StartClientStream
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
    _compatibility_profile: Option<&str>,
    business_output_seen: bool,
    provider_protocol: crate::hub_v1::V3HubProviderWireProtocol,
) -> Result<DirectSseInitialFrameAction, V3Error01SourceRaised> {
    let data = normalize_v3_provider_sse_json_data_for_event_name(provider_protocol, fields)
        .map_err(|message| {
            build_v3_provider_sse_json_error(
                provider_id,
                "provider_response_sse_event_invalid",
                message,
            )
        })?;
    let parsed = match classify_v3_provider_sse_json_data(provider_protocol, &data) {
        Ok(parsed) => parsed,
        Err(message) => {
            return Err(build_v3_provider_sse_json_error(
                provider_id,
                "provider_response_sse_event_invalid",
                message,
            ));
        }
    };
    let Some(outcome) = parsed else {
        return Ok(DirectSseInitialFrameAction::ContinueBuffering);
    };
    if matches!(
        provider_protocol,
        crate::hub_v1::V3HubProviderWireProtocol::Responses
    ) {
        let event = parse_v3_provider_sse_json_data(&data)
            .map_err(|message| {
                build_v3_provider_sse_json_error(
                    provider_id,
                    "provider_response_sse_event_invalid",
                    message,
                )
            })?
            .ok_or_else(|| {
                build_v3_provider_sse_json_error(
                    provider_id,
                    "provider_response_sse_event_invalid",
                    "provider Responses SSE semantic event is empty".to_owned(),
                )
            })?;
        if event
            .get("type")
            .and_then(serde_json::Value::as_str)
            .is_some_and(|event_type| event_type.starts_with("response."))
        {
            crate::hub_v1::classify_v3_responses_sse_event(&event).map_err(|error| {
                build_v3_provider_sse_json_error(
                    provider_id,
                    "provider_response_sse_event_invalid",
                    error.to_string(),
                )
            })?;
        }
    }
    match outcome {
        V3ProviderResponsesJsonFrameOutcome::ContinueBuffering => {
            Ok(DirectSseInitialFrameAction::ContinueBuffering)
        }
        V3ProviderResponsesJsonFrameOutcome::StartClientStream
        | V3ProviderResponsesJsonFrameOutcome::Terminal => {
            Ok(DirectSseInitialFrameAction::StartClientStream)
        }
        V3ProviderResponsesJsonFrameOutcome::TerminalWithoutOutput if business_output_seen => {
            Ok(DirectSseInitialFrameAction::StartClientStream)
        }
        V3ProviderResponsesJsonFrameOutcome::TerminalWithoutOutput => {
            Err(build_v3_provider_sse_json_error(
                provider_id,
                "provider_response_sse_empty",
                "provider SSE completed before content or tool output".to_string(),
            ))
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
    compatibility_profile: Option<&str>,
    provider_protocol: crate::hub_v1::V3HubProviderWireProtocol,
) -> V3ClientSseStream {
    observed_sse_client_stream_with_protocol(
        provider_id,
        stream,
        observation_state,
        usage_observation,
        V3_DIRECT_SSE_FIRST_EVENT_TIMEOUT,
        compatibility_profile,
        provider_protocol,
        false,
        false,
        None,
        None,
    )
}

fn observed_sse_client_stream_with_timeout(
    provider_id: String,
    stream: V3ProviderSseStream,
    observation_state: V3SseRemoteContinuationObservationState,
    usage_observation: V3RuntimeStreamObservation,
    frame_interval_timeout: std::time::Duration,
    compatibility_profile: Option<&str>,
    tool_thinking_enabled: bool,
) -> V3ClientSseStream {
    observed_sse_client_stream_with_timeout_and_projection(
        provider_id,
        stream,
        observation_state,
        usage_observation,
        frame_interval_timeout,
        compatibility_profile,
        crate::hub_v1::V3HubProviderWireProtocol::Responses,
        tool_thinking_enabled,
        true,
    )
}

fn observed_sse_client_stream_with_timeout_and_projection(
    provider_id: String,
    stream: V3ProviderSseStream,
    observation_state: V3SseRemoteContinuationObservationState,
    usage_observation: V3RuntimeStreamObservation,
    frame_interval_timeout: std::time::Duration,
    compatibility_profile: Option<&str>,
    provider_protocol: crate::hub_v1::V3HubProviderWireProtocol,
    tool_thinking_enabled: bool,
    toolreason_client_projection: bool,
) -> V3ClientSseStream {
    observed_sse_client_stream_with_timeout_and_projection_and_request_id(
        provider_id,
        String::new(),
        None,
        stream,
        observation_state,
        usage_observation,
        frame_interval_timeout,
        compatibility_profile,
        provider_protocol,
        tool_thinking_enabled,
        toolreason_client_projection,
    )
}

fn observed_sse_client_stream_with_timeout_and_projection_and_request_id(
    provider_id: String,
    request_id: String,
    session_id: Option<&str>,
    stream: V3ProviderSseStream,
    observation_state: V3SseRemoteContinuationObservationState,
    usage_observation: V3RuntimeStreamObservation,
    frame_interval_timeout: std::time::Duration,
    compatibility_profile: Option<&str>,
    provider_protocol: crate::hub_v1::V3HubProviderWireProtocol,
    tool_thinking_enabled: bool,
    toolreason_client_projection: bool,
) -> V3ClientSseStream {
    observed_sse_client_stream_with_protocol(
        provider_id,
        stream,
        observation_state,
        usage_observation,
        frame_interval_timeout,
        compatibility_profile,
        provider_protocol,
        tool_thinking_enabled,
        toolreason_client_projection,
        Some(request_id),
        session_id.map(ToOwned::to_owned),
    )
}

fn observed_sse_client_stream_with_protocol(
    provider_id: String,
    stream: V3ProviderSseStream,
    observation_state: V3SseRemoteContinuationObservationState,
    usage_observation: V3RuntimeStreamObservation,
    frame_interval_timeout: std::time::Duration,
    compatibility_profile: Option<&str>,
    provider_protocol: crate::hub_v1::V3HubProviderWireProtocol,
    tool_thinking_enabled: bool,
    toolreason_client_projection: bool,
    request_id: Option<String>,
    session_id: Option<String>,
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
        compatibility_profile: Option<String>,
        tool_thinking_enabled: bool,
        toolreason_client_projection: bool,
        compatibility_buffer: Vec<u8>,
        tool_thinking_buffer: Vec<u8>,
        tool_thinking_tool_names: Vec<String>,
        tool_thinking_pending_reasons: Vec<Option<String>>,
        tool_thinking_reason_emitted: bool,
        request_id: Option<String>,
        session_id: Option<String>,
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
            compatibility_profile: compatibility_profile.map(ToOwned::to_owned),
            tool_thinking_enabled,
            toolreason_client_projection,
            compatibility_buffer: Vec::new(),
            tool_thinking_buffer: Vec::new(),
            tool_thinking_tool_names: Vec::new(),
            tool_thinking_pending_reasons: Vec::new(),
            tool_thinking_reason_emitted: false,
            request_id,
            session_id,
        },
        move |mut state| async move {
            if state.done {
                return None;
            }
            let next = match tokio::time::timeout_at(state.semantic_deadline, state.stream.next())
                .await
            {
                Ok(next) => next,
                Err(_) if state.terminal_observed => {
                    if state.tool_thinking_enabled {
                        crate::hub_v1::finalize_v3_toolreason_observation_at_resp03_with_context(
                            &state.tool_thinking_tool_names,
                            &mut state.tool_thinking_pending_reasons,
                            &mut state.tool_thinking_reason_emitted,
                            crate::hub_v1::V3ToolreasonObservationContext {
                                session_id: state.session_id.as_deref(),
                                request_id: state.request_id.as_deref(),
                            },
                        );
                    }
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
                    let client_chunk = if state.tool_thinking_enabled {
                        apply_toolreason_to_sse_chunk_buffered_with_state_and_request_id(
                            &mut state.tool_thinking_buffer,
                            &mut state.tool_thinking_tool_names,
                            &mut state.tool_thinking_pending_reasons,
                            &mut state.tool_thinking_reason_emitted,
                            state.toolreason_client_projection,
                            &chunk,
                            state.session_id.as_deref(),
                            state.request_id.as_deref(),
                        )
                    } else if state.compatibility_profile.as_deref()
                        == Some("responses:deepseek-console-go")
                    {
                        apply_deepseek_console_go_sse_chunk_buffered(
                            &mut state.compatibility_buffer,
                            &chunk,
                        )
                    } else if state
                        .compatibility_profile
                        .as_deref()
                        .is_some_and(is_cc_sol_thinking_tags_profile)
                    {
                        apply_cc_sol_thinking_tags_to_sse_chunk_buffered(
                            &mut state.compatibility_buffer,
                            &chunk,
                        )
                    } else {
                        chunk.clone()
                    };
                    let result = observe_sse_remote_continuation_chunk(
                        &state.provider_id,
                        &chunk,
                        &mut state.decoder,
                        &mut state.response_id_candidate,
                        &state.observation_state,
                        &state.usage_observation,
                        provider_protocol,
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
                    Some((result.map(|_| client_chunk), state))
                }
                Some(Err(error)) => {
                    state.done = true;
                    Some((Err(provider_body_source(error)), state))
                }
                None => {
                    let buffered_client_chunk = if state.tool_thinking_enabled {
                        let buffered = std::mem::take(&mut state.tool_thinking_buffer);
                        if buffered.is_empty() {
                            None
                        } else {
                            Some(
                                crate::hub_v1::project_v3_toolreason_sse_final_buffer_at_resp03_with_projection_and_context(
                                    &buffered,
                                    &mut state.tool_thinking_tool_names,
                                    &mut state.tool_thinking_pending_reasons,
                                    &mut state.tool_thinking_reason_emitted,
                                    state.toolreason_client_projection,
                                    state.session_id.as_deref(),
                                    state.request_id.as_deref(),
                                ),
                            )
                        }
                    } else if state
                        .compatibility_profile
                        .as_deref()
                        .is_some_and(is_cc_sol_thinking_tags_profile)
                    {
                        let buffered = std::mem::take(&mut state.compatibility_buffer);
                        if buffered.is_empty() {
                            None
                        } else {
                            Some(apply_cc_sol_thinking_tags_to_sse_chunk(&buffered))
                        }
                    } else {
                        None
                    };
                    if let Some(client_chunk) = buffered_client_chunk {
                        if state.tool_thinking_enabled {
                            crate::hub_v1::finalize_v3_toolreason_observation_at_resp03_with_context(
                                &state.tool_thinking_tool_names,
                                &mut state.tool_thinking_pending_reasons,
                                &mut state.tool_thinking_reason_emitted,
                                crate::hub_v1::V3ToolreasonObservationContext {
                                    session_id: state.session_id.as_deref(),
                                    request_id: state.request_id.as_deref(),
                                },
                            );
                        }
                        state.done = true;
                        return Some((Ok(client_chunk), state));
                    }
                    if state.tool_thinking_enabled {
                        crate::hub_v1::finalize_v3_toolreason_observation_at_resp03_with_context(
                            &state.tool_thinking_tool_names,
                            &mut state.tool_thinking_pending_reasons,
                            &mut state.tool_thinking_reason_emitted,
                            crate::hub_v1::V3ToolreasonObservationContext {
                                session_id: state.session_id.as_deref(),
                                request_id: state.request_id.as_deref(),
                            },
                        );
                    }
                    let decoder = std::mem::replace(
                        &mut state.decoder,
                        SseIncrementalDecoder::new(SseTransportLimits::default()),
                    );
                    match decoder
                        .finish()
                        .map_err(|error| sse_transport_source(&state.provider_id, error))
                    {
                        Ok(()) if state.terminal_observed => None,
                        Ok(()) => {
                            state.done = true;
                            Some((
                                Err(build_v3_error_01_source_raised_external(
                                    V3ErrorSourceKind::ProviderFailure,
                                    "V3ProviderResp14Raw",
                                    "provider_response_sse_stream",
                                    "provider response SSE stream ended without a terminal semantic event",
                                    V3ExternalErrorLink {
                                        kind: V3ExternalErrorKind::Provider,
                                        status: None,
                                        code: Some(
                                            "PROVIDER_RESPONSE_SSE_MISSING_TERMINAL".to_string(),
                                        ),
                                        provider_id: Some(state.provider_id.clone()),
                                        upstream_request_id: None,
                                        message: Some(
                                            "provider response SSE stream ended without a terminal semantic event"
                                                .to_string(),
                                        ),
                                    },
                                )),
                                state,
                            ))
                        }
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

fn apply_cc_sol_thinking_tags_to_sse_chunk(chunk: &[u8]) -> Vec<u8> {
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
        let Ok(payload) = serde_json::from_str::<serde_json::Value>(data) else {
            output.push_str(line);
            continue;
        };
        let payload = provider_compat_core::apply_cc_sol_response_compat(payload);
        let encoded = match serde_json::to_string(&payload) {
            Ok(encoded) => encoded,
            Err(_) => {
                output.push_str(line);
                continue;
            }
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

fn apply_toolreason_to_sse_chunk_buffered(
    buffer: &mut Vec<u8>,
    tool_names: &mut Vec<String>,
    pending_reasons: &mut Vec<Option<String>>,
    chunk: &[u8],
) -> Vec<u8> {
    let mut reason_emitted = false;
    apply_toolreason_to_sse_chunk_buffered_with_state(
        buffer,
        tool_names,
        pending_reasons,
        &mut reason_emitted,
        true,
        chunk,
    )
}

fn apply_toolreason_to_sse_chunk_buffered_with_state(
    buffer: &mut Vec<u8>,
    tool_names: &mut Vec<String>,
    pending_reasons: &mut Vec<Option<String>>,
    reason_emitted: &mut bool,
    project_to_client: bool,
    chunk: &[u8],
) -> Vec<u8> {
    apply_toolreason_to_sse_chunk_buffered_with_state_and_request_id(
        buffer,
        tool_names,
        pending_reasons,
        reason_emitted,
        project_to_client,
        chunk,
        None,
        None,
    )
}

fn apply_toolreason_to_sse_chunk_buffered_with_state_and_request_id(
    buffer: &mut Vec<u8>,
    tool_names: &mut Vec<String>,
    pending_reasons: &mut Vec<Option<String>>,
    reason_emitted: &mut bool,
    project_to_client: bool,
    chunk: &[u8],
    session_id: Option<&str>,
    request_id: Option<&str>,
) -> Vec<u8> {
    crate::hub_v1::project_v3_toolreason_sse_chunk_at_resp03_with_projection_and_context(
        buffer,
        tool_names,
        pending_reasons,
        reason_emitted,
        project_to_client,
        chunk,
        session_id,
        request_id,
    )
}

fn apply_cc_sol_thinking_tags_to_sse_chunk_buffered(buffer: &mut Vec<u8>, chunk: &[u8]) -> Vec<u8> {
    buffer.extend_from_slice(chunk);
    let mut output = Vec::new();
    while let Some(end) = buffer.windows(2).position(|window| window == b"\n\n") {
        let frame_end = end + 2;
        let frame: Vec<u8> = buffer.drain(..frame_end).collect();
        output.extend(apply_cc_sol_thinking_tags_to_sse_chunk(&frame));
    }
    output
}

fn is_cc_sol_thinking_tags_profile(profile: &str) -> bool {
    matches!(profile.trim(), "responses:thinking-tags" | "responses:cc")
}

fn apply_deepseek_console_go_sse_chunk_buffered(buffer: &mut Vec<u8>, chunk: &[u8]) -> Vec<u8> {
    buffer.extend_from_slice(chunk);
    let mut output = Vec::new();
    while let Some(end) = buffer.windows(2).position(|window| window == b"\n\n") {
        let frame_end = end + 2;
        let frame: Vec<u8> = buffer.drain(..frame_end).collect();
        output.extend(apply_deepseek_console_go_sse_chunk(&frame));
    }
    output
}

fn apply_deepseek_console_go_sse_chunk(frame: &[u8]) -> Vec<u8> {
    let text = String::from_utf8_lossy(frame);
    let mut output = String::new();
    for line in text.split_inclusive('\n') {
        let Some(data) = line.strip_prefix("data:") else {
            output.push_str(line);
            continue;
        };
        let newline = data.ends_with('\n');
        let value = data.trim().trim_end_matches('\n');
        let Ok(mut payload) = serde_json::from_str::<serde_json::Value>(value) else {
            output.push_str(line);
            continue;
        };
        let Some(item) = payload.get("item").cloned() else {
            output.push_str(line);
            continue;
        };
        let compatible = provider_compat_core::apply_deepseek_console_go_response_compat(
            serde_json::json!({"output": [item]}),
        );
        let Some(item) = compatible.get("output").and_then(|items| items.get(0)) else {
            output.push_str(line);
            continue;
        };
        if let Some(object) = payload.as_object_mut() {
            object.insert("item".to_string(), item.clone());
        }
        output.push_str("data:");
        output.push_str(&serde_json::to_string(&payload).unwrap_or_else(|_| value.to_string()));
        if newline {
            output.push('\n');
        }
    }
    output.into_bytes()
}

fn observe_sse_remote_continuation_chunk(
    provider_id: &str,
    chunk: &[u8],
    decoder: &mut SseIncrementalDecoder,
    response_id_candidate: &mut Option<String>,
    observation_state: &V3SseRemoteContinuationObservationState,
    usage_observation: &V3RuntimeStreamObservation,
    provider_protocol: crate::hub_v1::V3HubProviderWireProtocol,
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
        let data = normalize_v3_provider_sse_json_data_for_event_name(provider_protocol, fields)
            .map_err(|message| {
                build_v3_error_01_source_raised(
                    V3ErrorSourceKind::ProviderFailure,
                    "V3ProviderResp14Raw",
                    "provider_response_sse_event_invalid",
                    message,
                )
            })?;
        let classification =
            classify_v3_provider_sse_json_data(provider_protocol, &data).map_err(|message| {
                build_v3_error_01_source_raised(
                    V3ErrorSourceKind::ProviderFailure,
                    "V3ProviderResp14Raw",
                    "provider_response_sse_event_invalid",
                    message,
                )
            })?;
        semantic_observed |= classification.is_some();
        terminal_observed |= matches!(
            classification,
            Some(
                V3ProviderResponsesJsonFrameOutcome::Terminal
                    | V3ProviderResponsesJsonFrameOutcome::TerminalWithoutOutput,
            )
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

pub(crate) async fn project_provider_raw_to_client_payload(
    raw: V3ProviderResp14Raw,
) -> Result<V3ProviderResponseProjection, V3Error01SourceRaised> {
    let profile = raw.compatibility_profile();
    let capabilities = if profile.is_some_and(|value| {
        is_cc_sol_thinking_tags_profile(value) || value == "responses:deepseek-console-go"
    }) {
        ["reasoning"].as_slice()
    } else {
        ["text"].as_slice()
    };
    let plan = crate::direct_response_hooks::compile_direct_response_compat_plan(
        crate::direct_response_hooks::V3DirectResponseCompatFacts {
            provider_protocol: crate::hub_v1::V3HubProviderWireProtocol::Responses,
            canonical_model_id: "test-model",
            model_capabilities: capabilities,
            compatibility_profile: profile,
        },
    )
    .expect("test raw compatibility profile must compile");
    project_provider_raw_to_client_payload_with_plan(raw, &plan, false).await
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
    async fn direct_sse_empty_output_item_then_failed_projects_error_before_client_commit() {
        let raw = V3ProviderResp14Raw::from_sse(
            "req".to_string(),
            "provider".to_string(),
            201,
            vec![V3ProviderResponseHeader {
                name: "content-type".to_string(),
                value: b"text/event-stream".to_vec(),
            }],
            Box::pin(stream::iter(vec![
                Ok::<Vec<u8>, V3ProviderError>(
                    b"event: response.output_item.added\ndata: {\"type\":\"response.output_item.added\",\"output_index\":0,\"item\":{\"type\":\"message\",\"status\":\"in_progress\",\"content\":[]}}\n\n".to_vec(),
                ),
                Ok::<Vec<u8>, V3ProviderError>(
                    b"event: response.failed\ndata: {\"type\":\"response.failed\",\"response\":{\"status\":\"failed\",\"error\":{\"code\":\"provider_failed\",\"message\":\"provider failed after empty lifecycle frame\"}}}\n\n".to_vec(),
                ),
            ])),
        );

        let error = project_provider_raw_to_client_payload(raw)
            .await
            .expect_err("empty lifecycle frames must not commit Resp15 before provider failure");
        assert_eq!(error.source_kind, V3ErrorSourceKind::ProviderFailure);
        assert_eq!(error.code, "provider_failed");
    }

    #[tokio::test]
    async fn direct_sse_empty_output_item_then_eof_projects_error_before_client_commit() {
        let raw = V3ProviderResp14Raw::from_sse(
            "req".to_string(),
            "provider".to_string(),
            201,
            vec![V3ProviderResponseHeader {
                name: "content-type".to_string(),
                value: b"text/event-stream".to_vec(),
            }],
            Box::pin(stream::iter(vec![Ok::<Vec<u8>, V3ProviderError>(
                b"event: response.output_item.added\ndata: {\"type\":\"response.output_item.added\",\"output_index\":0,\"item\":{\"type\":\"message\",\"status\":\"in_progress\",\"content\":[]}}\n\n".to_vec(),
            )])),
        );

        let error = project_provider_raw_to_client_payload(raw)
            .await
            .expect_err("empty lifecycle frames followed by EOF must fail before Resp15 commit");
        assert_eq!(error.source_kind, V3ErrorSourceKind::ProviderFailure);
        assert_eq!(error.code, "provider_response_sse_empty");
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
            V3ClientBody::ProviderSse(mut stream) => {
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
        let V3ClientBody::ProviderSse(mut stream) = projection.client_payload.body else {
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
    async fn direct_sse_projection_does_not_turn_missing_terminal_into_silent_eof() {
        let first =
            b"data: {\"type\":\"response.output_text.delta\",\"delta\":\"partial\"}\n\n".to_vec();
        let mut stream = observed_sse_client_stream_with_timeout(
            "provider".to_string(),
            Box::pin(stream::iter(vec![Ok::<Vec<u8>, V3ProviderError>(first)])),
            V3SseRemoteContinuationObservationState::default(),
            V3RuntimeStreamObservation::default(),
            std::time::Duration::from_millis(100),
            None,
            false,
        );

        assert!(stream.next().await.expect("first frame").is_ok());
        let error = stream
            .next()
            .await
            .expect("missing terminal must emit an explicit error")
            .expect_err("missing terminal must not become silent EOF");
        assert_eq!(error.source_kind, V3ErrorSourceKind::ProviderFailure);
        assert_eq!(error.code, "provider_response_sse_stream");
        assert!(error.message.contains("without a terminal semantic event"));
    }

    #[tokio::test]
    async fn direct_sse_projection_times_out_after_provider_stalls_between_frames() {
        let first =
            b"data: {\"type\":\"response.output_text.delta\",\"delta\":\"early\"}\n\n".to_vec();
        let mut stream = observed_sse_client_stream_with_timeout(
            "provider".to_string(),
            Box::pin(
                stream::iter(vec![Ok::<Vec<u8>, V3ProviderError>(first)])
                    .chain(futures_util::stream::pending()),
            ),
            V3SseRemoteContinuationObservationState::default(),
            V3RuntimeStreamObservation::default(),
            std::time::Duration::from_millis(20),
            None,
            false,
        );
        let first = stream
            .next()
            .await
            .expect("first frame")
            .expect("valid first frame");
        assert!(std::str::from_utf8(&first).unwrap().contains("early"));
        let error = stream
            .next()
            .await
            .expect("mid-stream stall must become an explicit error")
            .expect_err("mid-stream stall must not become silent EOF");
        assert_eq!(error.code, "provider_response_sse_inter_event_timeout");
    }

    #[tokio::test]
    async fn direct_sse_projection_times_out_when_provider_only_sends_keepalives() {
        let first =
            b"data: {\"type\":\"response.output_text.delta\",\"delta\":\"early\"}\n\n"
                .to_vec();
        let keepalives = futures_util::stream::unfold((), |_| async {
            tokio::time::sleep(std::time::Duration::from_millis(2)).await;
            Some((
                Ok::<Vec<u8>, V3ProviderError>(b": keepalive\n\n".to_vec()),
                (),
            ))
        });
        let mut stream = observed_sse_client_stream_with_timeout(
            "provider".to_string(),
            Box::pin(stream::iter(vec![Ok::<Vec<u8>, V3ProviderError>(first)]).chain(keepalives)),
            V3SseRemoteContinuationObservationState::default(),
            V3RuntimeStreamObservation::default(),
            std::time::Duration::from_millis(20),
            None,
            false,
        );
        assert!(stream.next().await.expect("first frame").is_ok());
        let result = tokio::time::timeout(std::time::Duration::from_millis(100), async {
            loop {
                match stream.next().await {
                    Some(Ok(_)) => continue,
                    Some(Err(error)) => break error,
                    None => panic!("keepalive-only provider stream ended silently"),
                }
            }
        })
        .await
        .expect("keepalives must not suppress semantic timeout");
        assert_eq!(result.code, "provider_response_sse_inter_event_timeout");
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
            None,
            crate::hub_v1::V3HubProviderWireProtocol::OpenAiChat,
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
            None,
            crate::hub_v1::V3HubProviderWireProtocol::Responses,
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
    async fn guard_initial_direct_sse_provider_failure_does_not_extend_deadline_for_keepalives() {
        // 反向：transport keepalive 不能把“没有首个语义事件”的 provider
        // 变成无限等待；每个 keepalive 都会刷新 stream.next()，但不应刷新
        // 整段首语义事件 deadline。
        let keepalives = futures_util::stream::unfold((), |_| async {
            tokio::time::sleep(std::time::Duration::from_millis(2)).await;
            Some((Ok::<Vec<u8>, V3ProviderError>(b": keepalive\n\n".to_vec()), ()))
        });
        let stream: V3ProviderSseStream = Box::pin(keepalives);
        let result = guard_initial_direct_sse_provider_failure_with_timeout(
            "keepalive-only-provider",
            stream,
            std::time::Duration::from_millis(30),
            None,
            crate::hub_v1::V3HubProviderWireProtocol::Responses,
        )
        .await;
        let Err(error) = result else {
            panic!("keepalive-only provider must hit the semantic first-event deadline");
        };
        assert_eq!(error.code, "provider_response_sse_first_event_timeout");
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
            None,
            crate::hub_v1::V3HubProviderWireProtocol::Responses,
        )
        .await
        .expect("prompt provider must not time out");
        let first = guarded.next().await.expect("replayed first chunk");
        assert!(first.is_ok());
        assert!(guarded.next().await.is_none());
    }

    #[tokio::test]
    async fn direct_sse_guard_rejects_typed_responses_shape_before_client_commit() {
        let malformed =
            b"data: {\"type\":\"response.output_item.done\",\"item\":\"not-an-object\"}\n\n"
                .to_vec();
        let stream: V3ProviderSseStream =
            Box::pin(futures_util::stream::once(async move { Ok(malformed) }));
        let result = guard_initial_direct_sse_provider_failure_with_timeout(
            "malformed-provider",
            stream,
            std::time::Duration::from_secs(5),
            None,
            crate::hub_v1::V3HubProviderWireProtocol::Responses,
        )
        .await;
        let Err(error) = result else {
            panic!("malformed Responses event must fail before client commit");
        };
        assert_eq!(error.source_kind, V3ErrorSourceKind::ProviderFailure);
        assert_eq!(error.code, "provider_response_sse_event_invalid");
        assert!(!error.message.is_empty());
    }

    #[tokio::test]
    async fn direct_sse_guard_accepts_structured_function_call_arguments_before_client_commit() {
        let compatible = b"data: {\"type\":\"response.output_item.done\",\"item\":{\"type\":\"function_call\",\"call_id\":\"call_1\",\"name\":\"apply_patch\",\"arguments\":{\"patch\":\"*** Begin Patch\"}}}\n\ndata: {\"type\":\"response.completed\",\"response\":{\"status\":\"completed\",\"output\":[{\"type\":\"function_call\",\"call_id\":\"call_1\",\"name\":\"apply_patch\",\"arguments\":{\"patch\":\"*** Begin Patch\"}}]}}\n\n".to_vec();
        let stream: V3ProviderSseStream =
            Box::pin(futures_util::stream::once(async move { Ok(compatible) }));
        let mut guarded = guard_initial_direct_sse_provider_failure_with_timeout(
            "structured-arguments-provider",
            stream,
            std::time::Duration::from_secs(5),
            None,
            crate::hub_v1::V3HubProviderWireProtocol::Responses,
        )
        .await
        .expect("structured function_call arguments are syntax-compatible");
        assert!(guarded.next().await.is_some());
    }

    #[tokio::test]
    async fn direct_sse_guard_rejects_untyped_cc_sol_frame_before_client_commit() {
        let malformed = b"data: {\"unexpected\":\"cc-sol-envelope\"}

"
        .to_vec();
        let stream: V3ProviderSseStream =
            Box::pin(futures_util::stream::once(async move { Ok(malformed) }));
        let result = guard_initial_direct_sse_provider_failure_with_timeout(
            "cc-sol",
            stream,
            std::time::Duration::from_secs(5),
            Some("responses:thinking-tags"),
            crate::hub_v1::V3HubProviderWireProtocol::Responses,
        )
        .await;
        let Err(error) = result else {
            panic!("untyped cc-sol Responses frame must fail before client commit");
        };
        assert_eq!(error.source_kind, V3ErrorSourceKind::ProviderFailure);
        assert_eq!(error.code, "provider_response_sse_event_invalid");
    }

    #[tokio::test]
    async fn direct_sse_guard_uses_provider_protocol_for_openai_chat_first_frame() {
        let chat_chunk = b"data: {\"id\":\"chatcmpl_protocol\",\"object\":\"chat.completion.chunk\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"ok\"},\"finish_reason\":null}]}\n\n".to_vec();
        let stream: V3ProviderSseStream =
            Box::pin(futures_util::stream::once(async move { Ok(chat_chunk) }));
        let mut guarded = guard_initial_direct_sse_provider_failure_with_timeout(
            "chat-provider",
            stream,
            std::time::Duration::from_secs(5),
            None,
            crate::hub_v1::V3HubProviderWireProtocol::OpenAiChat,
        )
        .await
        .expect("OpenAI Chat first frame must use the Chat codec");
        assert!(guarded.next().await.is_some());
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
        let projection = project_provider_raw_to_client_payload(raw).await.expect(
            "projection returns a typed stream; runtime owns pre-commit attempt collection",
        );
        let V3ClientBody::ProviderSse(mut stream) = projection.client_payload.body else {
            panic!("expected direct SSE body");
        };
        let first = stream
            .next()
            .await
            .expect("first provider frame must reach the runtime")
            .expect("first provider frame must be valid");
        assert!(std::str::from_utf8(&first).unwrap().contains("partial"));
        let error = stream
            .next()
            .await
            .expect("post-commit provider error must remain explicit")
            .expect_err("post-commit provider error must remain typed for runtime handoff");
        assert_eq!(error.source_kind, V3ErrorSourceKind::ProviderFailure);
        assert_eq!(error.code, "provider_response_body_error");
    }

    #[tokio::test]
    async fn direct_json_cc_sol_thinking_tags_follow_compatibility_profile() {
        let raw = V3ProviderResp14Raw::from_json(
            "req",
            "cc-sol",
            200,
            vec![V3ProviderResponseHeader {
                name: "content-type".to_string(),
                value: b"application/json".to_vec(),
            }],
            br#"{"id":"resp_1","output":[{"type":"message","text":"<thinking>plan</thinking>answer"}],"tail":"<thinking>open"}"#.to_vec(),
        )
        .with_compatibility_profile(Some("responses:thinking-tags".to_string()));
        let projection = project_provider_raw_to_client_payload(raw).await.unwrap();
        let V3ClientBody::Json(body) = projection.client_payload.body else {
            panic!("expected JSON client body");
        };
        assert_eq!(body["output"][0]["text"], "answer");
        assert_eq!(body["output"][0]["reasoning_content"], "plan");
        assert_eq!(body["tail"], "open");
        assert!(!body.to_string().contains("<thinking>"));
    }

    #[test]
    fn direct_sse_cc_sol_compat_accepts_compact_data_prefix() {
        let chunk = b"data:{\"text\":\"<thinking>plan</thinking>answer\"}\n\n";
        let projected = apply_cc_sol_thinking_tags_to_sse_chunk(chunk);
        let text = String::from_utf8(projected).expect("utf8 SSE chunk");
        assert!(text.starts_with("data:{"));
        assert!(text.contains("\"text\":\"answer\""));
        assert!(text.contains("\"reasoning_content\":\"plan\""));
        assert!(!text.contains("<thinking>"));
    }

    #[test]
    fn direct_sse_cc_sol_compat_buffers_split_event() {
        let mut buffer = Vec::new();
        assert!(apply_cc_sol_thinking_tags_to_sse_chunk_buffered(
            &mut buffer,
            b"data:{\"text\":\"<thinking>plan"
        )
        .is_empty());
        let projected = apply_cc_sol_thinking_tags_to_sse_chunk_buffered(
            &mut buffer,
            b"</thinking>answer\"}\n\n",
        );
        let text = String::from_utf8(projected).expect("utf8 SSE chunk");
        assert!(!text.contains("<thinking>"));
        assert!(text.contains("\"reasoning_content\":\"plan\""));
    }

    /* Legacy fence/text assertions removed; only native tool-argument JSON is authoritative.
    #[test]
    fn direct_sse_toolreason_associates_split_responses_events_and_redacts_marker() {
        let mut buffer = Vec::new();
        let mut tool_names = Vec::new();
        let mut pending_reasons = Vec::new();
        let first = b"event: response.output_item.added\ndata: {\"output_index\":2,\"type\":\"response.output_item.added\",\"item\":{\"name\":\"write_stdin\",\"type\":\"function_call\"}}\n";
        assert!(apply_toolreason_to_sse_chunk_buffered(
            &mut buffer,
            &mut tool_names,
            &mut pending_reasons,
            first,
        )
        .is_empty());
        let message = format!(
            "\nevent: response.output_item.done\ndata: {{\"output_index\":2,\"type\":\"response.output_item.done\",\"item\":{{\"content\":[{{\"text\":\"<toolreason>关闭隔离进程</toolreason>\",\"type\":\"output_text\"}}],\"type\":\"message\"}}}}\n\n"
        );
        let projected = apply_toolreason_to_sse_chunk_buffered(
            &mut buffer,
            &mut tool_names,
            &mut pending_reasons,
            message.as_bytes(),
        );
        let text = String::from_utf8(projected).expect("projected SSE must be UTF-8");
        assert!(!text.contains("<toolreason>"));
        assert!(text.contains("调用工具 write_stdin：关闭隔离进程"));
        assert!(text.contains("response.reasoning_summary_text.delta"));
        assert!(text.contains("\"type\":\"reasoning\""));
        assert!(!text.contains("reasoning_content"));
    }

    #[test]
    fn direct_sse_native_reasoning_delta_is_not_associated_with_later_tool_call() {
        let mut buffer = Vec::new();
        let mut tool_names = Vec::new();
        let mut pending_reasons = Vec::new();
        let tool_added = b"data: {\"output_index\":0,\"type\":\"response.output_item.added\",\"item\":{\"name\":\"cat\",\"type\":\"function_call\"}}\n\n";
        apply_toolreason_to_sse_chunk_buffered(
            &mut buffer,
            &mut tool_names,
            &mut pending_reasons,
            tool_added,
        );
        let native_reasoning = b"data: {\"output_index\":0,\"type\":\"response.output_text.delta\",\"delta\":\"normal model reasoning\"}\n\n";
        let reasoning_output = apply_toolreason_to_sse_chunk_buffered(
            &mut buffer,
            &mut tool_names,
            &mut pending_reasons,
            native_reasoning,
        );
        assert!(String::from_utf8(reasoning_output)
            .expect("native reasoning output")
            .contains("normal model reasoning"));
        assert!(pending_reasons.iter().all(Option::is_none));
        let tool_done = b"data: {\"output_index\":0,\"type\":\"response.output_item.done\",\"item\":{\"type\":\"function_call\",\"name\":\"cat\",\"arguments\":\"{\\\"cmd\\\":\\\"cat README.md\\\"}\"}}\n\n";
        let tool_output = apply_toolreason_to_sse_chunk_buffered(
            &mut buffer,
            &mut tool_names,
            &mut pending_reasons,
            tool_done,
        );
        assert!(!String::from_utf8(tool_output)
            .expect("tool output")
            .contains("normal model reasoning"));
    }

    #[test]
    fn direct_sse_toolreason_accepts_crlf_and_associates_content_part_reason() {
        let mut buffer = Vec::new();
        let mut tool_names = vec!["read_file".to_string()];
        let mut pending_reasons = Vec::new();
        let chunk = b"data: {\"output_index\":0,\"type\":\"response.content_part.done\",\"part\":{\"text\":\"<toolreason>need context</toolreason>\",\"type\":\"output_text\"}}\r\n\r\n";
        assert!(!apply_toolreason_to_sse_chunk_buffered(
            &mut buffer,
            &mut tool_names,
            &mut pending_reasons,
            chunk,
        )
        .is_empty());
        let final_chunk = b"data: {\"output_index\":0,\"type\":\"response.output_item.done\",\"item\":{\"content\":[{\"text\":\"answer\",\"type\":\"output_text\"}],\"type\":\"message\"}}\r\n\r\n";
        let projected = apply_toolreason_to_sse_chunk_buffered(
            &mut buffer,
            &mut tool_names,
            &mut pending_reasons,
            final_chunk,
        );
        let text = String::from_utf8(projected).expect("projected SSE must be UTF-8");
        assert!(!text.contains("<toolreason>"));
        assert!(text.contains("调用工具 read_file：need context"));
    }

    #[test]
    fn direct_sse_toolreason_handles_reason_before_later_tool_name_and_json_escapes() {
        let mut buffer = Vec::new();
        let mut tool_names = Vec::new();
        let mut pending_reasons = Vec::new();
        let message = b"data: {\"output_index\":1,\"type\":\"response.output_item.done\",\"item\":{\"content\":[{\"text\":\"\\u003ctoolreason\\u003eInspect file.\\u003c/toolreason\\u003e\",\"type\":\"output_text\"}],\"type\":\"message\"}}\n\n";
        let projected_message = apply_toolreason_to_sse_chunk_buffered(
            &mut buffer,
            &mut tool_names,
            &mut pending_reasons,
            message,
        );
        let message_text = String::from_utf8(projected_message).expect("projected message");
        assert!(!message_text.contains("toolreason"));
        assert!(!message_text.contains("reasoning_content"));
        let function_call = b"data: {\"output_index\":2,\"type\":\"response.output_item.done\",\"item\":{\"type\":\"function_call\",\"name\":\"read_file\"}}\n\n";
        let projected_function_call = apply_toolreason_to_sse_chunk_buffered(
            &mut buffer,
            &mut tool_names,
            &mut pending_reasons,
            function_call,
        );
        let function_text = String::from_utf8(projected_function_call).expect("projected call");
        assert!(function_text.contains("调用工具 read_file：Inspect file."));
        assert!(function_text.contains("response.reasoning_summary_text.delta"));
        assert!(!function_text.contains("toolreason"));
    }

    #[test]
    fn direct_sse_toolreason_validates_completed_frame_with_tool_call() {
        let mut buffer = Vec::new();
        let mut tool_names = Vec::new();
        let mut pending_reasons = Vec::new();
        let completed = format!(
            "data: {}\n\n",
            serde_json::json!({
                "type": "response.completed",
                "response": {
                    "output": [
                        {
                            "type": "message",
                            "content": [{
                                "type": "output_text",
                                "text": "<toolreason>locate workspace</toolreason>"
                            }]
                        },
                        {
                            "type": "function_call",
                            "name": "exec_command",
                            "arguments": "{\\\"cmd\\\":\\\"pwd\\\"}"
                        }
                    ]
                }
            })
        )
        .into_bytes();
        let projected = apply_toolreason_to_sse_chunk_buffered(
            &mut buffer,
            &mut tool_names,
            &mut pending_reasons,
            &completed,
        );
        let text = String::from_utf8(projected).expect("projected completed frame");
        assert!(!text.contains("<toolreason>"));
        assert!(!text.contains("</toolreason>"));
        assert!(text.contains("response.reasoning_summary_text.delta"));
        assert!(text.contains("locate workspace"));
    }

    */
    #[test]
    fn direct_sse_json_toolreason_strips_only_auxiliary_fields_and_projects_reasoning() {
        let mut buffer = Vec::new();
        let mut tool_names = Vec::new();
        let mut pending_reasons = Vec::new();
        let frame = format!(
            "data: {}\n\n",
            serde_json::json!({
                "type": "response.output_item.done",
                "output_index": 0,
                "item": {
                    "type": "function_call",
                    "name": "exec_command",
                    "arguments": "{\"cmd\":\"pwd\",\"reason\":\"确认当前工作目录\",\"goal_alignment_confidence\":100,\"model_id\":\"x-preview-f-free\"}"
                }
            })
        );
        let projected = apply_toolreason_to_sse_chunk_buffered(
            &mut buffer,
            &mut tool_names,
            &mut pending_reasons,
            frame.as_bytes(),
        );
        let text = String::from_utf8(projected).expect("projected JSON tool call");
        assert!(text.contains("调用工具 pwd：确认当前工作目录"));
        assert!(text.contains("response.reasoning_summary_text.delta"));
        assert!(!text.contains("goal_alignment_confidence"));
        assert!(!text.contains("model_id"));
        assert!(text.contains("\\\"cmd\\\":\\\"pwd\\\""));
    }
}
