use crate::*;
use axum::body::Body;
use axum::extract::Request;
use axum::http::{HeaderMap, Response, StatusCode};
use futures_util::{FutureExt, StreamExt};
use routecodex_v3_runtime::V3OpenAiChatRelayRuntimeError;
use serde_json::{json, Value};
use std::panic::AssertUnwindSafe;
use std::sync::Arc;
use std::time::{Duration, Instant};

pub(crate) fn collect_anthropic_relay_client_headers(
    headers: &HeaderMap,
) -> Result<Vec<V3AnthropicRelayClientHeader>, String> {
    let mut provider_headers = Vec::new();
    for (name, value) in headers {
        let name = name.as_str();
        if !V3AnthropicRelayClientHeader::is_provider_protocol_header_name(name) {
            continue;
        }
        let value = value
            .to_str()
            .map(str::trim)
            .map_err(|error| format!("{name} is not UTF-8: {error}"))?;
        if value.is_empty() {
            continue;
        }
        if let Some(header) = V3AnthropicRelayClientHeader::provider_protocol(name, value) {
            provider_headers.push(header);
        }
    }
    Ok(provider_headers)
}

pub async fn execute_v3_anthropic_messages_request(
    manifest: &V3Config05ManifestPublished,
    input: V3AnthropicRelayRuntimeInput,
) -> Result<V3AnthropicRelayRuntimeOutput, routecodex_v3_runtime::V3AnthropicRelayRuntimeError> {
    execute_v3_anthropic_relay_runtime_with_default_transport(manifest, input).await
}

pub async fn execute_v3_anthropic_messages_request_with_client_headers(
    manifest: &V3Config05ManifestPublished,
    input: V3AnthropicRelayRuntimeInput,
    client_headers: Vec<V3AnthropicRelayClientHeader>,
) -> Result<V3AnthropicRelayRuntimeOutput, routecodex_v3_runtime::V3AnthropicRelayRuntimeError> {
    execute_v3_anthropic_relay_runtime_with_default_transport_and_client_headers(
        manifest,
        input,
        client_headers,
    )
    .await
}

pub async fn execute_v3_openai_chat_completions_request(
    manifest: &V3Config05ManifestPublished,
    input: V3OpenAiChatRelayRuntimeInput,
) -> Result<V3OpenAiChatRelayRuntimeOutput, routecodex_v3_runtime::V3OpenAiChatRelayRuntimeError> {
    execute_v3_openai_chat_relay_runtime_with_default_transport(manifest, input).await
}

pub async fn execute_v3_gemini_generate_content_request(
    manifest: &V3Config05ManifestPublished,
    input: V3GeminiRelayRuntimeInput,
) -> Result<V3GeminiRelayRuntimeOutput, routecodex_v3_runtime::V3GeminiRelayRuntimeError> {
    execute_v3_gemini_relay_runtime_with_default_transport(manifest, input).await
}

pub(crate) fn append_v3_openai_chat_relay_sse_done(bytes: &[u8]) -> Vec<u8> {
    let mut frame = Vec::with_capacity(bytes.len() + 24);
    frame.extend_from_slice(bytes);
    frame.extend_from_slice(b"\n\ndata: [DONE]\n\n");
    frame
}

pub async fn execute_v3_responses_relay_request(
    manifest: &V3Config05ManifestPublished,
    input: V3ResponsesRelayRuntimeInput,
) -> Result<V3ResponsesRelayRuntimeOutput, routecodex_v3_runtime::V3ResponsesRelayRuntimeError> {
    execute_v3_responses_relay_runtime_with_default_transport(manifest, input).await
}

pub(crate) fn responses_relay_output_response(
    output: V3ResponsesRelayRuntimeOutput,
    stream_console_finalizer: Option<V3SseConsoleFinalizer>,
    keepalive_interval: Option<Duration>,
    requested_stream: bool,
) -> Response<Body> {
    let successful_sse = output.error_chain.is_none() && output.status < 400;
    let content_type = match &output.client_body {
        V3ResponsesRelayClientBody::Json(_) => "application/json",
        V3ResponsesRelayClientBody::Sse(_) => "text/event-stream",
    };
    let content_type = if requested_stream && !successful_sse {
        "text/event-stream"
    } else {
        content_type
    };
    let mut builder = Response::builder()
        .status(StatusCode::from_u16(output.status).expect("typed V3 Responses Relay status"))
        .header("content-type", content_type);
    let body = match output.client_body {
        V3ResponsesRelayClientBody::Sse(client_stream) => v3_client_sse_body(
            wrap_v3_responses_relay_sse_console_stream(client_stream, stream_console_finalizer),
            successful_sse.then_some(keepalive_interval).flatten(),
        ),
        V3ResponsesRelayClientBody::Json(client_response)
            if requested_stream && !successful_sse =>
        {
            let frame = V3Server16HttpFrame {
                status: output.status,
                content_type: "application/json".to_string(),
                body: V3Server16Body::Json(client_response),
                debug_node: "V3Debug01NodeEventRegistered",
                error_node: "V3Error06ClientProjected",
                error_chain: output.error_chain.unwrap_or_default(),
                error_body: None,
                node_trace: output.node_trace,
                observability: output.observability,
                stream_observation: output.stream_observation,
            };
            let frame = project_v3_responses_direct_stream_error_frame_if_requested(frame, true);
            match frame.body {
                V3Server16Body::CommittedSse(stream) => v3_client_sse_body(stream, None),
                V3Server16Body::Sse(stream) => v3_live_client_sse_body(stream, None),
                V3Server16Body::Json(value) => Body::from(
                    serde_json::to_vec(&value).expect("typed V3 Responses Relay error projection"),
                ),
                V3Server16Body::Bytes(bytes) => Body::from(bytes),
            }
        }
        V3ResponsesRelayClientBody::Json(client_response) => Body::from(
            serde_json::to_vec(&client_response).expect("typed V3 Responses Relay projection"),
        ),
    };
    builder
        .body(body)
        .expect("typed V3 Responses Relay response")
}

pub(crate) fn wrap_v3_responses_relay_sse_console_stream(
    stream: V3ResponsesRelayClientStream,
    finalizer: Option<V3SseConsoleFinalizer>,
) -> V3ResponsesRelayClientStream {
    wrap_v3_committed_relay_sse_console_stream(stream, finalizer)
}

pub(crate) fn wrap_v3_committed_relay_sse_console_stream(
    stream: V3CommittedClientSseStream,
    finalizer: Option<V3SseConsoleFinalizer>,
) -> V3CommittedClientSseStream {
    match finalizer {
        Some(finalizer) => stream.observe(
            |_| {},
            move |terminal| match terminal {
                V3CommittedSseTerminal::Completed => finalizer.complete_relay_sse(),
                V3CommittedSseTerminal::Dropped => finalizer.client_disconnected(),
            },
        ),
        None => stream,
    }
}

pub(crate) fn openai_chat_relay_output_response(
    output: V3OpenAiChatRelayRuntimeOutput,
    stream_console_finalizer: Option<V3SseConsoleFinalizer>,
    keepalive_interval: Duration,
) -> Response<Body> {
    let stream = output.client_body.is_sse();
    let status = output.status;
    let node_trace = output.node_trace.clone();
    let error_chain = output.error_chain.clone();
    let payload = output.into_v3_resp_15_client_payload();
    let frame = build_v3_server_16_http_frame_from_v3_resp_15(payload, node_trace, error_chain);
    let mut builder = Response::builder()
        .status(StatusCode::from_u16(status).expect("typed V3 OpenAI Chat Relay status"))
        .header(
            "content-type",
            if stream {
                "text/event-stream"
            } else {
                "application/json"
            },
        );
    let body = match frame.body {
        V3Server16Body::Sse(client_stream) => v3_live_client_sse_body(
            client_stream,
            (frame.error_chain.is_empty() && status < 400).then_some(keepalive_interval),
        ),
        V3Server16Body::CommittedSse(client_stream) => v3_client_sse_body(
            wrap_v3_committed_relay_sse_console_stream(client_stream, stream_console_finalizer),
            (frame.error_chain.is_empty() && status < 400).then_some(keepalive_interval),
        ),
        V3Server16Body::Json(client_response) => Body::from(
            serde_json::to_vec(&client_response).expect("typed V3 OpenAI Chat Relay projection"),
        ),
        V3Server16Body::Bytes(bytes) => Body::from(bytes),
    };
    builder
        .body(body)
        .expect("typed V3 OpenAI Chat Relay response")
}

/// OpenAI Chat SSE 请求（Relay）：客户端 SSE 连接由 proxy（routecodex）独立管理，
/// 与 provider 完全解耦——不提前回任何状态码、不注入 keepalive/其他污染语义的帧，
/// 连接在完整链（VR 命中 → Relay → Provider 请求 → provider 响应完整入站 + resp
/// 转换）执行期间由 hyper 保持；provider 出错由内部 provider-failure 策略自动
/// 切换（reselect），切完继续等最终响应，客户端全程无感知；最终以 200 + 完整
/// SSE 响应体返回（Body::from 完整 bytes，规避 Body::from_stream 在 axum/hyper
/// 写回前的连接关闭竞态——h2_p6）。
pub(crate) async fn v3_openai_chat_relay_sse_accept_response(
    state: &Arc<V3ListenerState>,
    payload: Value,
    request_id: String,
    failure_session_scope: V3ProviderFailureSessionScope,
    execution_mode: V3HubExecutionMode,
    console_context: V3ConsoleEmissionContext,
    started_at: Instant,
    front_transport_owns_keepalive: bool,
) -> Response<Body> {
    use futures_util::StreamExt;
    let manifest = state.manifest.clone();
    let provider_health = state.provider_health.runtime_health();
    let input = V3OpenAiChatRelayRuntimeInput {
        server_id: state.server.id.clone(),
        failure_session_scope,
        request_id: request_id.clone(),
        payload,
    };
    let (tx, rx) = tokio::sync::mpsc::channel::<Vec<u8>>(32);
    let keepalive_ms = state.server.http_sse_keepalive_ms.max(1000);
    tokio::spawn(async move {
        let panic_tx = tx.clone();
        let worker = async move {
            // 标准 SSE 心跳帧（注释行，连接保持、不塞任何语义）；完整链执行期间定期
            // 发送，客户端不会因 provider 慢/挂起判定连接断。
            let heartbeat: Vec<u8> = b": keepalive\n\n".to_vec();
            let mut interval =
                tokio::time::interval(tokio::time::Duration::from_millis(keepalive_ms));
            interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            let run = async {
                execute_v3_openai_chat_relay_runtime_with_default_transport_provider_health_and_execution_mode(
                &manifest,
                input,
                provider_health,
                execution_mode,
            )
            .await
            };
            tokio::pin!(run);
            loop {
                tokio::select! {
                    biased;
                    result = &mut run => {
                        // 完整链（VR 命中 → Relay → Provider → resp 转换）完成；空响应
                        // 自动重试 3 次/错误链/reselect/502 投影已在 relay runtime 内完成
                        // （错误链：handle_provider_failure → 3 次拉黑 15 分钟 → 切 provider），
                        // server 只负责把转换结果喂给客户端（连接与心跳由 server 管理）。
                        match result {
                            Ok(output) => {
                                let observability = output.observability.clone();
                                let stream_observation = output.stream_observation.clone();
                                let output_status = output.status;
                                let node_trace = output.node_trace.clone();
                                match output.client_body {
                                V3OpenAiChatRelayClientBody::Sse(stream) => {
                                    // 与 endpoint_handlers relay 路径同一 closeout
                                    // 收口语义：流 Err → post-commit 502 provider SSE
                                    // 失败；干净 EOF → completed 打印；客户端断连 →
                                    // 499。禁止流失败后仍当成功收口（旧实现把 provider
                                    // 缺终帧误报成 500 runtime_observability_contract）。
                                    let stream_console_finalizer =
                                        match (stream_observation, observability) {
                                            (Some(stream_observation), Some(observability)) => {
                                                Some(V3SseConsoleFinalizer {
                                                    context: console_context.clone(),
                                                    status: output_status,
                                                    node_trace,
                                                    observability,
                                                    stream_observation,
                                                    started_at,
                                                })
                                            }
                                            _ => None,
                                        };
                                    drain_v3_openai_chat_relay_sse_stream_to_client(
                                        stream,
                                        &tx,
                                        stream_console_finalizer,
                                    )
                                    .await;
                                }
                                V3OpenAiChatRelayClientBody::Json(json) => {
                                    // provider 以 JSON 完成（非 SSE）：包装为 SSE data 帧。
                                    let bytes = match serde_json::to_vec(&json) {
                                        Ok(bytes) => bytes,
                                        Err(error) => {
                                            let _ = tx
                                                .send(v3_sse_error_event_chunk(
                                                    599,
                                                    "internal_response_projection_error",
                                                    &format!(
                                                        "internal response JSON projection failed: {error}"
                                                    ),
                                                ))
                                                .await;
                                            return;
                                        }
                                    };
                                    let mut frame = Vec::with_capacity(bytes.len() + 8);
                                    frame.extend_from_slice(b"data: ");
                                    frame.extend_from_slice(&bytes);
                                    frame.extend_from_slice(b"\n\n");
                                    let _ = tx.send(frame).await;
                                    emit_v3_relay_completed_console_after_stream(
                                        &console_context,
                                        output_status,
                                        &node_trace,
                                        observability,
                                        stream_observation,
                                        started_at,
                                    );
                                }
                                    }
                                }
                                Err(error) => {
                                    // 复用 runtime typed 投影（Error01-06 链），禁止
                                    // handler 手拼错误帧旁路错误链。
                                    let projected = project_v3_openai_chat_relay_runtime_failure(error);
                                    let V3OpenAiChatRelayClientBody::Json(body) = projected.client_body
                                    else {
                                        // Error06 is a terminal JSON projection for this endpoint.
                                        // Do not synthesize a second error payload here: that would
                                        // hide a contract violation and make the accepted SSE task
                                        // look successful to the client. The projector is the sole
                                        // owner of the error shape.
                                        panic!(
                                            "V3 OpenAI Chat relay Error06 projected a non-JSON client body"
                                        );
                                    };
                                    let bytes = serde_json::to_vec(&body)
                                        .expect("typed V3 OpenAI Chat relay Error06 projection");
                                    let mut data_frame = Vec::with_capacity(bytes.len() + 8);
                                    data_frame.extend_from_slice(b"data: ");
                                    data_frame.extend_from_slice(&bytes);
                                    // Error06 is terminal for the already accepted
                                    // client SSE connection.  Keep the provider error
                                    // in the internal error chain, but always terminate
                                    // the client stream explicitly.
                                    let frame = append_v3_openai_chat_relay_sse_done(&data_frame);
                                    let _ = tx.send(frame).await;
                                    if let Err(error) = record_v3_webui_projected_runtime_failure_for_context(
                                        &console_context,
                                        projected.error_class.expect(
                                            "terminal Error06 projection must carry Error02 class",
                                        ),
                                        Some(projected.error_detail.as_deref().expect(
                                            "terminal Error06 projection must carry source detail",
                                        )),
                                        projected.status,
                                        "sse",
                                    ) {
                                        emit_v3_webui_projection_failure(&console_context, &error);
                                    }
                                }
                            }
                        return;
                    }
                    _ = interval.tick(), if !front_transport_owns_keepalive => {
                        if tx.send(heartbeat.clone()).await.is_err() {
                            return;
                        }
                    }
                }
            }
        };
        if let Err(payload) = AssertUnwindSafe(worker).catch_unwind().await {
            let message = payload
                .downcast_ref::<&str>()
                .copied()
                .or_else(|| payload.downcast_ref::<String>().map(String::as_str))
                .unwrap_or("OpenAI Chat Relay SSE worker panicked");
            let _ = panic_tx
                .send(crate::endpoint_handlers::v3_front_sse_worker_panic_frame(
                    message,
                ))
                .await;
        }
    });
    // 客户端 SSE 连接由 proxy（routecodex）独立管理：立即回 200 + text/event-stream，
    // 后台任务注入标准 SSE 心跳（`: keepalive` 注释帧，连接保持、不塞语义）并喂入
    // 完整链转换结果——客户端不会因 provider 慢/错误判定连接断或收到半截响应
    // （错误走内部错误链 + 切 provider）。
    let client_stream: V3IoSseStream =
        Box::pin(futures_util::stream::unfold(rx, |mut rx| async move {
            rx.recv()
                .await
                .map(|item| (Ok::<Vec<u8>, std::io::Error>(item), rx))
        }));
    let client_stream = wrap_v3_sse_io_dump_stream(
        client_stream,
        state.sse_dump_enabled,
        state.server.port,
        "/v1/chat/completions",
        &request_id,
    );
    let body = v3_io_sse_body(
        client_stream,
        (!front_transport_owns_keepalive).then_some(Duration::from_millis(keepalive_ms)),
    );
    Response::builder()
        .status(StatusCode::OK)
        .header("content-type", "text/event-stream")
        .body(body)
        .expect("SSE accept response")
}

/// Forward the infallible stream committed by the Relay Broker. Provider
/// attempts and provider failures cannot reach this Front function.
pub(crate) async fn drain_v3_openai_chat_relay_sse_stream_to_client(
    mut stream: V3OpenAiChatCommittedStream,
    tx: &tokio::sync::mpsc::Sender<Vec<u8>>,
    stream_console_finalizer: Option<V3SseConsoleFinalizer>,
) {
    while let Some(bytes) = stream.next().await {
        if tx.send(bytes).await.is_err() {
            if let Some(finalizer) = stream_console_finalizer {
                finalizer.client_disconnected();
            }
            return;
        }
    }
    if let Some(finalizer) = stream_console_finalizer {
        finalizer.complete_relay_sse();
    }
}

/// Relay 完整流收口后的 usage 控制台打印：把 stream_observation（逐帧解码
/// 客户端 wire 得到）合并进 observability 再打印 completed 行。观测只读，
/// 不改写业务字节；缺少 observability 时静默跳过（错误链已有独立投影）。
pub(crate) fn emit_v3_relay_completed_console_after_stream(
    context: &V3ConsoleEmissionContext,
    status: u16,
    node_trace: &[&'static str],
    observability: Option<V3RuntimeObservability>,
    stream_observation: Option<V3RuntimeStreamObservation>,
    started_at: Instant,
) {
    let Some(mut observability) = observability else {
        return;
    };
    if let Some(observation) = stream_observation {
        if let Err(error) =
            merge_v3_runtime_stream_observation(&mut observability, Some(&observation))
        {
            emit_v3_runtime_observability_contract_failure(context, &observability, error);
            return;
        }
    }
    emit_v3_observability_console_lines(
        context,
        status,
        node_trace,
        &observability,
        started_at,
        true,
    );
}

/// OpenAI Chat 入口动态绑定：入口协议与出口 provider 同协议（chat wire）
/// 走统一 direct 骨架（`execute_v3_direct_runtime_kernel_core` + ChatCodec）；
/// 异协议由骨架返回 RelayHandoff，转 chat relay runtime（入口已归一化到 chat）。
pub(crate) async fn execute_v3_openai_chat_direct_server_outcome(
    state: &Arc<V3ListenerState>,
    method: String,
    path: String,
    request_id: String,
    execution_id: String,
    payload: Value,
    provider_failure_session_scope: V3ProviderFailureSessionScope,
    request_headers: &HeaderMap,
    request_identity: &V3AllocatedRequestIdentity,
    started_at: Instant,
    _project_path: Option<&str>,
    request_purpose: V3RequestPurpose,
) -> Response<Body> {
    let console_payload = payload.clone();
    let console_context = build_v3_console_emission_context(
        state,
        "openai_chat",
        &path,
        request_identity,
        request_headers,
        &console_payload,
    );
    let provider_failure_event_sink = build_v3_provider_failure_event_sink(&console_context);
    let route_selection_event_sink = build_v3_route_selection_event_sink(&console_context);
    let raw = build_v3_server_03_http_request_raw_with_purpose_and_port(
        state.server.id.clone(),
        provider_failure_session_scope.clone(),
        request_id.clone(),
        execution_id,
        method,
        path.clone(),
        request_purpose,
        Some(state.server.port),
        payload.clone(),
    );
    let now_epoch_ms = match std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH) {
        Ok(duration) => duration.as_millis() as u64,
        Err(_) => 0,
    };
    let output =
        routecodex_v3_runtime::execute_v3_direct_runtime_kernel_core::<V3ChatDirectCodec, _>(
            (),
            &state.manifest,
            raw,
            routecodex_v3_runtime::default_responses_transport(),
            state.provider_health.runtime_health(),
            now_epoch_ms,
            true,
            Some(&provider_failure_event_sink),
            Some(&route_selection_event_sink),
        )
        .await;
    if let Some(handoff) = output.protocol_relay_handoff {
        if request_purpose.is_compaction() {
            return error_output_response_for_server(
                &state.server,
                &path,
                &request_id,
                project_http_input_error(
                    V3HttpBoundaryErrorKind::EndpointNotEnabled,
                    "compaction request cannot cross into Hub Relay",
                ),
            );
        }
        let relay_trace = handoff.node_trace;
        // SSE 请求：立即 201 + keepalive 维持连接，后台执行完整 relay 链
        // （客户端连接与 provider 解耦，provider 挂起/慢不影响 client 连接）。
        if payload.get("stream").and_then(Value::as_bool) == Some(true) {
            return v3_openai_chat_relay_sse_accept_response(
                state,
                payload.clone(),
                request_id.clone(),
                provider_failure_session_scope.clone(),
                V3HubExecutionMode::Relay,
                console_context,
                started_at,
                true,
            )
            .await;
        }
        let relay_result =
            execute_v3_openai_chat_relay_runtime_with_default_transport_provider_health(
                &state.manifest,
                V3OpenAiChatRelayRuntimeInput {
                    server_id: state.server.id.clone(),
                    failure_session_scope: provider_failure_session_scope,
                    request_id: request_id.clone(),
                    payload,
                },
                state.provider_health.runtime_health(),
            )
            .await;
        let mut relay_output = match relay_result {
            Ok(output) => output,
            Err(error) => project_v3_openai_chat_relay_runtime_failure(error),
        };
        let mut trace = relay_trace;
        trace.extend(relay_output.node_trace);
        relay_output.node_trace = trace;
        if let Some(response) = capture_v3_openai_chat_relay_response(
            state,
            &V3DebugTraceScope {
                server_id: state.server.id.clone(),
                request_id: request_id.clone(),
                execution_id: String::new(),
            },
            "openai_chat",
            &path,
            &request_id,
            &console_payload,
            &mut relay_output,
        ) {
            return response;
        }
        let stream_console_finalizer = match (
            relay_output.stream_observation.clone(),
            relay_output.observability.clone(),
        ) {
            (Some(stream_observation), Some(observability)) => Some(V3SseConsoleFinalizer {
                context: console_context.clone(),
                status: relay_output.status,
                node_trace: relay_output.node_trace.clone(),
                observability,
                stream_observation,
                started_at,
            }),
            _ => None,
        };
        if let Some(observability) = relay_output.observability.as_ref() {
            emit_v3_observability_console_lines(
                &console_context,
                relay_output.status,
                &relay_output.node_trace,
                observability,
                started_at,
                relay_output.stream_observation.is_none(),
            );
        }
        return openai_chat_relay_output_response(
            relay_output,
            stream_console_finalizer,
            Duration::from_millis(state.server.http_sse_keepalive_ms),
        );
    }
    let mut frame = build_v3_server_16_http_frame_from_v3_resp_15(
        output.client_payload,
        output.node_trace,
        output.error_chain,
    );
    frame.observability = output.observability;
    frame.stream_observation = output.stream_observation;
    // A provider switch can be recorded in observability while the final
    // response succeeds. It must not create a client-facing error artifact.
    if frame.status >= 400 || !frame.error_chain.is_empty() {
        let error_status = (frame.status >= 400).then_some(frame.status);
        let _ = persist_v3_error_evidence_payload(
            state,
            "openai_chat",
            &path,
            &request_id,
            "request.json",
            &state
                .debug
                .project_payload_verbatim(console_payload.clone()),
            error_status,
        );
        let _ = persist_v3_error_evidence_payload(
            state,
            "openai_chat",
            &path,
            &request_id,
            "error.json",
            &state
                .debug
                .project_payload_verbatim(json!({
                    "object": "routecodex.v3.error_evidence",
                    "stage": "error",
                    "status": frame.status,
                    "request_id": request_id,
                    "endpoint": path,
                    "node_trace": frame.node_trace.clone(),
                    "error_chain": frame.error_chain.clone(),
                    "observability": frame.observability.as_ref().map(project_v3_runtime_observability_debug),
                })),
            error_status,
        );
    }
    if let Some(response) =
        capture_v3_responses_direct_response(state, "openai_chat", &path, &request_id, &mut frame)
    {
        return response;
    }
    let stream_console_finalizer =
        emit_v3_direct_frame_console_lines(&console_context, &frame, started_at);
    if matches!(&frame.body, V3Server16Body::Sse(_)) {
        let body = std::mem::replace(&mut frame.body, V3Server16Body::Bytes(Vec::new()));
        let V3Server16Body::Sse(stream) = body else {
            unreachable!("matched live OpenAI Chat SSE body")
        };
        frame.body = V3Server16Body::Sse(wrap_v3_live_sse_dump_stream(
            stream,
            state.sse_dump_enabled,
            state.server.port,
            &path,
            &request_id,
        ));
    } else if matches!(&frame.body, V3Server16Body::CommittedSse(_)) {
        let body = std::mem::replace(&mut frame.body, V3Server16Body::Bytes(Vec::new()));
        let V3Server16Body::CommittedSse(stream) = body else {
            unreachable!("matched committed OpenAI Chat SSE body")
        };
        frame.body = V3Server16Body::CommittedSse(wrap_v3_committed_sse_dump_stream(
            stream,
            state.sse_dump_enabled,
            state.server.port,
            &path,
            &request_id,
        ));
    }
    responses_direct_output_response_with_console(
        frame,
        stream_console_finalizer,
        Some(Duration::from_millis(state.server.http_sse_keepalive_ms)),
    )
}

pub(crate) fn gemini_relay_output_response(
    output: V3GeminiRelayRuntimeOutput,
    stream_console_finalizer: Option<V3SseConsoleFinalizer>,
    keepalive_interval: Duration,
) -> Response<Body> {
    let stream = output.client_body.is_sse();
    let status = output.status;
    let node_trace = output.node_trace.clone();
    let error_chain = output.error_chain.clone();
    let payload = output.into_v3_resp_15_client_payload();
    let frame = build_v3_server_16_http_frame_from_v3_resp_15(payload, node_trace, error_chain);
    let mut builder = Response::builder()
        .status(StatusCode::from_u16(status).expect("typed V3 Gemini Relay status"))
        .header(
            "content-type",
            if stream {
                "text/event-stream"
            } else {
                "application/json"
            },
        );
    let body = match frame.body {
        V3Server16Body::Sse(client_stream) => v3_live_client_sse_body(
            client_stream,
            (frame.error_chain.is_empty() && status < 400).then_some(keepalive_interval),
        ),
        V3Server16Body::CommittedSse(client_stream) => v3_client_sse_body(
            wrap_v3_committed_relay_sse_console_stream(client_stream, stream_console_finalizer),
            (frame.error_chain.is_empty() && status < 400).then_some(keepalive_interval),
        ),
        V3Server16Body::Json(client_response) => Body::from(
            serde_json::to_vec(&client_response).expect("typed V3 Gemini Relay projection"),
        ),
        V3Server16Body::Bytes(bytes) => Body::from(bytes),
    };
    builder.body(body).expect("typed V3 Gemini Relay response")
}

pub(crate) fn anthropic_relay_output_response(
    output: V3AnthropicRelayRuntimeOutput,
    stream: bool,
) -> Response<Body> {
    let stream = stream && output.error_chain.is_none();
    let mut builder = Response::builder()
        .status(StatusCode::from_u16(output.status).expect("typed V3 Relay status"))
        .header(
            "content-type",
            if stream {
                "text/event-stream"
            } else {
                "application/json"
            },
        );
    let body = if stream {
        match routecodex_v3_runtime::hub_v1::project_v3_anthropic_client_sse_stream(
            output.client_response,
        ) {
            Ok(stream) => v3_client_sse_body(stream, None),
            Err(error) => {
                let projected = project_v3_anthropic_relay_runtime_failure(
                    routecodex_v3_runtime::V3AnthropicRelayRuntimeError::StructuredSse(error),
                );
                return anthropic_relay_output_response(projected, false);
            }
        }
    } else {
        Body::from(
            serde_json::to_vec(&output.client_response)
                .expect("typed V3 Anthropic Relay projection"),
        )
    };
    builder
        .body(body)
        .expect("typed V3 Anthropic Relay response")
}
