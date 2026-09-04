use crate::*;
use axum::body::Body;
use axum::http::{HeaderMap, Response, StatusCode};
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

pub(crate) fn append_v3_openai_chat_relay_sse_done(bytes: &[u8]) -> Vec<u8> {
    let mut frame = Vec::with_capacity(bytes.len() + 24);
    frame.extend_from_slice(bytes);
    frame.extend_from_slice(b"\n\ndata: [DONE]\n\n");
    frame
}

pub(crate) fn build_v3_openai_chat_relay_json_sse_frame(
    value: &Value,
) -> Result<Vec<u8>, serde_json::Error> {
    let bytes = serde_json::to_vec(value)?;
    let mut frame = Vec::with_capacity(bytes.len() + 32);
    frame.extend_from_slice(b"data: ");
    frame.extend_from_slice(&bytes);
    frame.extend_from_slice(b"\n\n");
    Ok(append_v3_openai_chat_relay_sse_done(&frame))
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
    let projected_error_frame = if requested_stream && !successful_sse {
        match &output.client_body {
            V3ResponsesRelayClientBody::Json(client_response) => {
                let frame = V3Server16HttpFrame {
                    status: output.status,
                    content_type: "application/json".to_string(),
                    body: V3Server16Body::Json(client_response.clone()),
                    debug_node: "V3Debug01NodeEventRegistered",
                    error_node: "V3Error06ClientProjected",
                    error_chain: output.error_chain.clone().unwrap_or_default(),
                    error_body: None,
                    node_trace: output.node_trace.clone(),
                    observability: output.observability.clone(),
                    stream_observation: output.stream_observation.clone(),
                };
                Some(project_v3_responses_relay_stream_error_frame_if_requested(
                    frame, true,
                ))
            }
            V3ResponsesRelayClientBody::Sse(_) => None,
        }
    } else {
        None
    };
    let content_type = projected_error_frame
        .as_ref()
        .map(|frame| frame.content_type.as_str())
        .unwrap_or_else(|| match &output.client_body {
            V3ResponsesRelayClientBody::Json(_) => "application/json",
            V3ResponsesRelayClientBody::Sse(_) => "text/event-stream",
        });
    let builder = Response::builder()
        .status(StatusCode::from_u16(output.status).expect("typed V3 Responses Relay status"))
        .header("content-type", content_type);
    let body = match (output.client_body, projected_error_frame) {
        (V3ResponsesRelayClientBody::Sse(client_stream), _) => v3_client_sse_body(
            wrap_v3_responses_relay_sse_console_stream(client_stream, stream_console_finalizer),
            successful_sse.then_some(keepalive_interval).flatten(),
        ),
        (V3ResponsesRelayClientBody::Json(_), Some(frame)) => {
            match frame.body {
                V3Server16Body::CommittedSse(stream) => v3_client_sse_body(stream, None),
                V3Server16Body::Sse(stream) => v3_live_client_sse_body(stream, None),
                V3Server16Body::Json(value) => Body::from(
                    serde_json::to_vec(&value).expect("typed V3 Responses Relay error projection"),
                ),
                V3Server16Body::Bytes(bytes) => Body::from(bytes),
            }
        }
        (V3ResponsesRelayClientBody::Json(client_response), None) => Body::from(
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
    requested_stream: bool,
) -> Response<Body> {
    let status = output.status;
    let node_trace = output.node_trace.clone();
    let error_chain = output.error_chain.clone();
    let payload = output.into_v3_resp_15_client_payload();
    let frame = project_v3_protocol_stream_error_frame_if_requested(
        build_v3_server_16_http_frame_from_v3_resp_15(payload, node_trace, error_chain),
        requested_stream,
        V3SseClientProtocol::OpenAiChat,
    );
    let stream = frame.content_type == "text/event-stream";
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
        let request_execution_control = handoff.request_execution_control;
        let relay_result =
            execute_v3_openai_chat_relay_runtime_with_default_transport_provider_health_execution_mode_and_request_control(
                &state.manifest,
                V3OpenAiChatRelayRuntimeInput {
                    server_id: state.server.id.clone(),
                    failure_session_scope: provider_failure_session_scope,
                    request_id: request_id.clone(),
                    payload,
                },
                state.provider_health.runtime_health(),
                V3HubExecutionMode::Relay,
                request_execution_control,
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
            v3_entry_request_wants_sse(request_headers, &console_payload),
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
    let frame = project_v3_protocol_stream_error_frame_if_requested(
        frame,
        v3_entry_request_wants_sse(request_headers, &console_payload),
        V3SseClientProtocol::OpenAiChat,
    );
    responses_direct_output_response_with_console_for_protocol(
        frame,
        stream_console_finalizer,
        Some(Duration::from_millis(state.server.http_sse_keepalive_ms)),
        V3SseClientProtocol::OpenAiChat,
    )
}

pub(crate) fn gemini_relay_output_response(
    output: V3GeminiRelayRuntimeOutput,
    stream_console_finalizer: Option<V3SseConsoleFinalizer>,
    keepalive_interval: Duration,
    requested_stream: bool,
) -> Response<Body> {
    let status = output.status;
    let node_trace = output.node_trace.clone();
    let error_chain = output.error_chain.clone();
    let payload = output.into_v3_resp_15_client_payload();
    let frame = project_v3_protocol_stream_error_frame_if_requested(
        build_v3_server_16_http_frame_from_v3_resp_15(payload, node_trace, error_chain),
        requested_stream,
        V3SseClientProtocol::Gemini,
    );
    let stream = frame.content_type == "text/event-stream";
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
    requested_stream: bool,
) -> Response<Body> {
    let status = output.status;
    let node_trace = output.node_trace.clone();
    let error_chain = output.error_chain.clone();
    let payload = output.into_v3_resp_15_client_payload();
    let frame = project_v3_protocol_stream_error_frame_if_requested(
        build_v3_server_16_http_frame_from_v3_resp_15(payload, node_trace, error_chain),
        requested_stream,
        V3SseClientProtocol::Anthropic,
    );
    let stream = frame.content_type == "text/event-stream";
    let mut builder = Response::builder()
        .status(StatusCode::from_u16(status).expect("typed V3 Anthropic Relay status"))
        .header(
            "content-type",
            if stream {
                "text/event-stream"
            } else {
                "application/json"
            },
        );
    let body = match frame.body {
        V3Server16Body::Sse(client_stream) => v3_live_client_sse_body(client_stream, None),
        V3Server16Body::CommittedSse(client_stream) => v3_client_sse_body(client_stream, None),
        V3Server16Body::Json(client_response) => Body::from(
            serde_json::to_vec(&client_response).expect("typed V3 Anthropic Relay projection"),
        ),
        V3Server16Body::Bytes(bytes) => Body::from(bytes),
    };
    builder
        .body(body)
        .expect("typed V3 Anthropic Relay response")
}
