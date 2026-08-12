use crate::*;
use axum::body::Body;
use axum::extract::Request;
use axum::http::{HeaderMap, Response, StatusCode};
use futures_util::StreamExt;
use serde_json::{json, Value};
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

pub async fn execute_v3_responses_relay_request(
    manifest: &V3Config05ManifestPublished,
    input: V3ResponsesRelayRuntimeInput,
) -> Result<V3ResponsesRelayRuntimeOutput, routecodex_v3_runtime::V3ResponsesRelayRuntimeError> {
    execute_v3_responses_relay_runtime_with_default_transport(manifest, input).await
}

pub(crate) fn responses_relay_output_response(
    output: V3ResponsesRelayRuntimeOutput,
    stream_console_finalizer: Option<V3SseConsoleFinalizer>,
    keepalive_interval: Duration,
) -> Response<Body> {
    let successful_sse = output.error_chain.is_none() && output.status < 400;
    let content_type = match &output.client_body {
        V3ResponsesRelayClientBody::Json(_) => "application/json",
        V3ResponsesRelayClientBody::Sse(_) => "text/event-stream",
    };
    let mut builder = Response::builder()
        .status(StatusCode::from_u16(output.status).expect("typed V3 Responses Relay status"))
        .header("content-type", content_type);
    let body = match output.client_body {
        V3ResponsesRelayClientBody::Sse(client_stream) => v3_relay_client_sse_body(
            wrap_v3_relay_sse_console_stream(client_stream, stream_console_finalizer),
            successful_sse.then_some(keepalive_interval),
        ),
        V3ResponsesRelayClientBody::Json(client_response) => Body::from(
            serde_json::to_vec(&client_response).expect("typed V3 Responses Relay projection"),
        ),
    };
    builder
        .body(body)
        .expect("typed V3 Responses Relay response")
}

pub(crate) fn wrap_v3_relay_sse_console_stream(
    stream: V3ResponsesRelayClientStream,
    finalizer: Option<V3SseConsoleFinalizer>,
) -> V3ResponsesRelayClientStream {
    match finalizer {
        Some(finalizer) => {
            wrap_v3_relay_sse_closeout_stream(stream, move |terminal| match terminal {
                V3SseConsoleStreamTerminal::Completed => finalizer.complete_relay_sse(),
                V3SseConsoleStreamTerminal::Dropped => finalizer.client_disconnected(),
            })
        }
        None => stream,
    }
}

pub(crate) struct V3SseConsoleCloseoutStream {
    stream: V3ResponsesRelayClientStream,
    closeout: Option<Box<dyn FnOnce(V3SseConsoleStreamTerminal) + Send>>,
}

impl V3SseConsoleCloseoutStream {
    pub(crate) fn emit_terminal(&mut self, terminal: V3SseConsoleStreamTerminal) {
        if let Some(closeout) = self.closeout.take() {
            closeout(terminal);
        }
    }
}

impl Unpin for V3SseConsoleCloseoutStream {}

impl futures_util::Stream for V3SseConsoleCloseoutStream {
    type Item = Result<Vec<u8>, String>;

    fn poll_next(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<Option<Self::Item>> {
        let this = self.as_mut().get_mut();
        match this.stream.as_mut().poll_next(cx) {
            Poll::Ready(Some(Ok(chunk))) => Poll::Ready(Some(Ok(chunk))),
            Poll::Ready(Some(Err(error))) => {
                this.closeout.take();
                Poll::Ready(Some(Err(error)))
            }
            Poll::Ready(None) => {
                this.emit_terminal(V3SseConsoleStreamTerminal::Completed);
                Poll::Ready(None)
            }
            Poll::Pending => Poll::Pending,
        }
    }
}

impl Drop for V3SseConsoleCloseoutStream {
    fn drop(&mut self) {
        self.emit_terminal(V3SseConsoleStreamTerminal::Dropped);
    }
}

pub(crate) fn wrap_v3_relay_sse_closeout_stream(
    stream: V3ResponsesRelayClientStream,
    closeout: impl FnOnce(V3SseConsoleStreamTerminal) + Send + 'static,
) -> V3ResponsesRelayClientStream {
    Box::pin(V3SseConsoleCloseoutStream {
        stream,
        closeout: Some(Box::new(closeout)),
    })
}

pub(crate) struct V3DirectSseConsoleCloseoutStream {
    stream: V3ClientSseStream,
    closeout: Option<Box<dyn FnOnce(V3SseConsoleStreamTerminal) + Send>>,
}

impl V3DirectSseConsoleCloseoutStream {
    pub(crate) fn emit_terminal(&mut self, terminal: V3SseConsoleStreamTerminal) {
        if let Some(closeout) = self.closeout.take() {
            closeout(terminal);
        }
    }
}

impl Unpin for V3DirectSseConsoleCloseoutStream {}

impl futures_util::Stream for V3DirectSseConsoleCloseoutStream {
    type Item = Result<Vec<u8>, routecodex_v3_error::V3Error01SourceRaised>;

    fn poll_next(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<Option<Self::Item>> {
        let this = self.as_mut().get_mut();
        match this.stream.as_mut().poll_next(cx) {
            Poll::Ready(Some(Ok(chunk))) => Poll::Ready(Some(Ok(chunk))),
            Poll::Ready(Some(Err(error))) => {
                this.closeout.take();
                Poll::Ready(Some(Err(error)))
            }
            Poll::Ready(None) => {
                this.emit_terminal(V3SseConsoleStreamTerminal::Completed);
                Poll::Ready(None)
            }
            Poll::Pending => Poll::Pending,
        }
    }
}

impl Drop for V3DirectSseConsoleCloseoutStream {
    fn drop(&mut self) {
        self.emit_terminal(V3SseConsoleStreamTerminal::Dropped);
    }
}

pub(crate) fn wrap_v3_direct_sse_closeout_stream(
    stream: V3ClientSseStream,
    closeout: impl FnOnce(V3SseConsoleStreamTerminal) + Send + 'static,
) -> V3ClientSseStream {
    Box::pin(V3DirectSseConsoleCloseoutStream {
        stream,
        closeout: Some(Box::new(closeout)),
    })
}

pub(crate) fn openai_chat_relay_output_response(output: V3OpenAiChatRelayRuntimeOutput) -> Response<Body> {
    let content_type = match &output.client_body {
        V3OpenAiChatRelayClientBody::Json(_) => "application/json",
        V3OpenAiChatRelayClientBody::Sse(_) => "text/event-stream",
    };
    let mut builder = Response::builder()
        .status(StatusCode::from_u16(output.status).expect("typed V3 OpenAI Chat Relay status"))
        .header("content-type", content_type);
    let body = match output.client_body {
        V3OpenAiChatRelayClientBody::Sse(client_stream) => Body::from_stream(client_stream),
        V3OpenAiChatRelayClientBody::Json(client_response) => Body::from(
            serde_json::to_vec(&client_response).expect("typed V3 OpenAI Chat Relay projection"),
        ),
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
    let (tx, rx) = tokio::sync::mpsc::channel::<Result<Vec<u8>, std::io::Error>>(32);
    let keepalive_ms = state.server.http_sse_keepalive_ms.max(1000);
    tokio::spawn(async move {
        // 标准 SSE 心跳帧（注释行，连接保持、不塞任何语义）；完整链执行期间定期
        // 发送，客户端不会因 provider 慢/挂起判定连接断。
        let heartbeat: Vec<u8> = b": keepalive\n\n".to_vec();
        let mut interval = tokio::time::interval(tokio::time::Duration::from_millis(keepalive_ms));
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        let run = async {
            execute_v3_openai_chat_relay_runtime_with_default_transport_provider_health(
                &manifest,
                input,
                provider_health,
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
                        Ok(output) => match output.client_body {
                            V3OpenAiChatRelayClientBody::Sse(stream) => {
                                // runtime 已收集完整流（iter），直接透传数据帧。
                                let mut stream = stream;
                                while let Some(chunk) = stream.next().await {
                                    let chunk = chunk.map_err(std::io::Error::other);
                                    if tx.send(chunk).await.is_err() {
                                        return;
                                    }
                                }
                            }
                            V3OpenAiChatRelayClientBody::Json(json) => {
                                // provider 以 JSON 完成（非 SSE）：包装为 SSE data 帧。
                                let bytes = serde_json::to_vec(&json).unwrap_or_default();
                                let mut frame = Vec::with_capacity(bytes.len() + 8);
                                frame.extend_from_slice(b"data: ");
                                frame.extend_from_slice(&bytes);
                                frame.extend_from_slice(b"\n\n");
                                let _ = tx.send(Ok(frame)).await;
                            }
                        },
                        Err(error) => {
                            // 复用 runtime typed 投影（Error01-06 链），禁止
                            // handler 手拼错误帧旁路错误链。
                            let projected = project_v3_openai_chat_relay_runtime_failure(error);
                            let V3OpenAiChatRelayClientBody::Json(body) = projected.client_body
                            else {
                                return;
                            };
                            let bytes = serde_json::to_vec(&body).unwrap_or_default();
                            let mut frame = Vec::with_capacity(bytes.len() + 8);
                            frame.extend_from_slice(b"data: ");
                            frame.extend_from_slice(&bytes);
                            frame.extend_from_slice(b"\n\n");
                            let _ = tx.send(Ok(frame)).await;
                        }
                    }
                    return;
                }
                _ = interval.tick() => {
                    if tx.send(Ok(heartbeat.clone())).await.is_err() {
                        return;
                    }
                }
            }
        }
    });
    // 客户端 SSE 连接由 proxy（routecodex）独立管理：立即回 200 + text/event-stream，
    // 后台任务注入标准 SSE 心跳（`: keepalive` 注释帧，连接保持、不塞语义）并喂入
    // 完整链转换结果——客户端不会因 provider 慢/错误判定连接断或收到半截响应
    // （错误走内部错误链 + 切 provider）。
    let client_stream: V3IoSseStream = Box::pin(futures_util::stream::unfold(
        rx,
        |mut rx| async move { rx.recv().await.map(|item| (item, rx)) },
    ));
    let body = v3_io_sse_body(client_stream, None);
    Response::builder()
        .status(StatusCode::OK)
        .header("content-type", "text/event-stream")
        .body(body)
        .expect("SSE accept response")
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
    let raw = build_v3_server_03_http_request_raw(
        state.server.id.clone(),
        provider_failure_session_scope.clone(),
        request_id.clone(),
        execution_id,
        method,
        path.clone(),
        payload.clone(),
    );
    let now_epoch_ms = match std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH) {
        Ok(duration) => duration.as_millis() as u64,
        Err(_) => 0,
    };
    let output = routecodex_v3_runtime::execute_v3_direct_runtime_kernel_core::<
        V3ChatDirectCodec,
        _,
    >(
        (),
        &state.manifest,
        raw,
        routecodex_v3_runtime::default_responses_transport(),
        state.provider_health.runtime_health(),
        now_epoch_ms,
        Some(&provider_failure_event_sink),
        Some(&route_selection_event_sink),
    )
    .await;
    if let Some(handoff) = output.protocol_relay_handoff {
        let relay_trace = handoff.node_trace;
        // SSE 请求：立即 201 + keepalive 维持连接，后台执行完整 relay 链
        // （客户端连接与 provider 解耦，provider 挂起/慢不影响 client 连接）。
        if payload.get("stream").and_then(Value::as_bool) == Some(true) {
            return v3_openai_chat_relay_sse_accept_response(
                state,
                payload.clone(),
                request_id.clone(),
                provider_failure_session_scope.clone(),
            )
            .await;
        }
        let relay_result = execute_v3_openai_chat_relay_runtime_with_default_transport_provider_health(
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
        return openai_chat_relay_output_response(relay_output);
    }
    let mut frame = build_v3_server_16_http_frame_from_v3_resp_15(
        output.client_payload,
        output.node_trace,
        output.error_chain,
    );
    frame.observability = output.observability;
    frame.stream_observation = output.stream_observation;
    let has_provider_failure = frame.observability.as_ref().is_some_and(|observability| {
        !observability.provider_failure_events.is_empty()
    });
    if frame.status >= 400 || has_provider_failure {
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
    if let Some(response) = capture_v3_responses_direct_response(
        state,
        "openai_chat",
        &path,
        &request_id,
        &mut frame,
    ) {
        return response;
    }
    let stream_console_finalizer =
        emit_v3_direct_frame_console_lines(&console_context, &frame, started_at);
    responses_direct_output_response_with_console(
        frame,
        stream_console_finalizer,
        Duration::from_millis(state.server.http_sse_keepalive_ms),
    )
}

pub(crate) fn gemini_relay_output_response(output: V3GeminiRelayRuntimeOutput) -> Response<Body> {
    let content_type = match &output.client_body {
        V3GeminiRelayClientBody::Json(_) => "application/json",
        V3GeminiRelayClientBody::Sse(_) => "text/event-stream",
    };
    let mut builder = Response::builder()
        .status(StatusCode::from_u16(output.status).expect("typed V3 Gemini Relay status"))
        .header("content-type", content_type);
    let body = match output.client_body {
        V3GeminiRelayClientBody::Sse(client_stream) => Body::from_stream(client_stream),
        V3GeminiRelayClientBody::Json(client_response) => Body::from(
            serde_json::to_vec(&client_response).expect("typed V3 Gemini Relay projection"),
        ),
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
        anthropic_relay_sse_body(output.client_response)
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

pub(crate) fn anthropic_relay_sse_body(client_response: serde_json::Value) -> Body {
    let Some(events) = client_response
        .get("events")
        .and_then(serde_json::Value::as_array)
        .cloned()
    else {
        return Body::from_stream(stream::once(async {
            Err::<Vec<u8>, io::Error>(io::Error::other(
                "typed V3 Anthropic Relay SSE projection is missing events",
            ))
        }));
    };
    Body::from_stream(stream::iter(
        events
            .into_iter()
            .map(|event| anthropic_relay_sse_event_chunk(&event)),
    ))
}

pub(crate) fn anthropic_relay_sse_event_chunk(event: &serde_json::Value) -> Result<Vec<u8>, io::Error> {
    let (Some(name), Some(data)) = (
        event.get("event").and_then(serde_json::Value::as_str),
        event.get("data"),
    ) else {
        return Err(io::Error::other(
            "typed V3 Anthropic Relay SSE event is missing event or data",
        ));
    };
    let decoded = build_v3_sse_transport_in_02_from_fields(vec![
        SseField::Named {
            name: "event".to_string(),
            value: name.to_string(),
        },
        SseField::Named {
            name: "data".to_string(),
            value: data.to_string(),
        },
    ])
    .map_err(|error| io::Error::other(error.to_string()))?;
    let validated = build_v3_sse_transport_in_03_from_v3_sse_transport_in_02(decoded)
        .map_err(|error| io::Error::other(error.to_string()))?;
    Ok(build_v3_sse_transport_out_04_from_v3_sse_transport_in_03(&validated).into_bytes())
}
