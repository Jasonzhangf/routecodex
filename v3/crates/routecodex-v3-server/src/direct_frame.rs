// V3 Responses Direct server-frame projection shell.
// This module only executes the configured Direct runtime and turns V3Resp15 client payloads
// into Server16 HTTP frames/transport bodies; it must not own provider wire, routing,
// retry/health, continuation, or protocol semantic governance.

use super::*;

pub(super) async fn execute_responses_direct_server_frame(
    state: &V3ListenerState,
    request_headers: &HeaderMap,
    method: String,
    path: String,
    request_id: String,
    execution_id: String,
    payload: serde_json::Value,
    responses_protocol_plan: Option<&V3ResponsesProtocolExecutionPlan>,
) -> V3Server16HttpFrame {
    let requested_stream = v3_responses_request_wants_sse(request_headers, &payload);
    let continuation_scope = match build_responses_direct_continuation_scope(
        request_headers,
        &request_id,
        &state.server,
        &path,
        &payload,
    ) {
        Ok(scope) => scope,
        Err(message) => {
            let frame = build_v3_server_16_http_frame_from_v3_error_06(project_http_input_error(
                V3HttpBoundaryErrorKind::MalformedJson,
                message,
            ));
            return project_v3_responses_direct_stream_error_frame_if_requested(
                frame,
                requested_stream,
            );
        }
    };
    let now_epoch_ms = match std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH) {
        Ok(duration) => duration.as_millis() as u64,
        Err(error) => {
            let frame =
                build_v3_server_16_http_frame_from_v3_foundation_output(project_v3_debug_failure(
                    "V3HubReqContinuation03Classified",
                    V3DebugError::MalformedFixture(format!(
                        "system time precedes Unix epoch: {error}"
                    )),
                ));
            return project_v3_responses_direct_stream_error_frame_if_requested(
                frame,
                requested_stream,
            );
        }
    };
    let raw = build_v3_server_03_http_request_raw(
        state.server.id.clone(),
        request_id.clone(),
        execution_id.clone(),
        method,
        path,
        payload,
    );
    let env = V3ResponsesDirectExecutionEnv::new(
        register_responses_direct_hooks(),
        state.responses_direct_transport.as_ref(),
    )
    .with_debug(&state.debug)
    .with_shared_state_continuation(
        V3ResponsesDirectRuntimeSharedState::new(
            &state.responses_direct_continuation,
            state.provider_health.store(),
        ),
        continuation_scope,
        now_epoch_ms,
    );
    let output = match responses_protocol_plan {
        Some(plan) => {
            execute_v3_responses_direct_runtime_kernel(
                &state.manifest,
                raw,
                env.with_initial_plan(plan),
            )
            .await
        }
        None => execute_v3_responses_direct_runtime_kernel(&state.manifest, raw, env).await,
    };
    let scope = match state
        .debug
        .start_trace(&state.server.id, &request_id, &execution_id)
    {
        Ok(scope) => scope,
        Err(error) => {
            let frame = build_v3_server_16_http_frame_from_v3_foundation_output(
                project_v3_debug_failure("V3Debug01TraceContextStarted", error),
            );
            return project_v3_responses_direct_stream_error_frame_if_requested(
                frame,
                requested_stream,
            );
        }
    };
    if let Err(error) = state.debug.record_node_event(
        &scope,
        "V3Server16HttpFrame",
        "projected",
        Some(json!({"status": output.client_payload.status})),
    ) {
        return build_v3_server_16_http_frame_from_v3_foundation_output(project_v3_debug_failure(
            "V3Server16HttpFrame",
            error,
        ));
    }
    let mut frame = build_v3_server_16_http_frame_from_v3_resp_15(
        output.client_payload,
        output.node_trace,
        output.error_chain,
    );
    frame.observability = output.observability;
    frame.stream_observation = output.stream_observation;
    project_v3_responses_direct_stream_error_frame_if_requested(frame, requested_stream)
}

struct V3DirectSseConsoleCloseoutStream {
    stream: V3ClientSseStream,
    closeout: Option<Box<dyn FnOnce(V3SseConsoleStreamTerminal) + Send>>,
}

impl V3DirectSseConsoleCloseoutStream {
    fn emit_terminal(&mut self, terminal: V3SseConsoleStreamTerminal) {
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
                this.emit_terminal(V3SseConsoleStreamTerminal::Failed(format!(
                    "{}: {}",
                    error.code, error.message
                )));
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

fn wrap_v3_direct_sse_closeout_stream(
    stream: V3ClientSseStream,
    closeout: impl FnOnce(V3SseConsoleStreamTerminal) + Send + 'static,
) -> V3ClientSseStream {
    Box::pin(V3DirectSseConsoleCloseoutStream {
        stream,
        closeout: Some(Box::new(closeout)),
    })
}

pub(super) fn responses_direct_output_response(frame: V3Server16HttpFrame) -> Response<Body> {
    responses_direct_output_response_with_console(frame, None)
}

pub(super) fn project_v3_responses_direct_stream_error_frame_if_requested(
    mut frame: V3Server16HttpFrame,
    requested_stream: bool,
) -> V3Server16HttpFrame {
    if !requested_stream || frame.error_chain.is_empty() || frame.content_type != "application/json"
    {
        return frame;
    }
    let body = match frame.body {
        V3Server16Body::Json(value) => value,
        other => {
            frame.body = other;
            return frame;
        }
    };
    let (code, message) = v3_error_body_code_message(&body);
    if frame.error_body.is_none() {
        frame.error_body = Some(body);
    }
    frame.content_type = "text/event-stream".to_string();
    frame.body = V3Server16Body::Sse(Box::pin(stream::iter(vec![Ok::<
        Vec<u8>,
        routecodex_v3_error::V3Error01SourceRaised,
    >(
        v3_sse_error_event_chunk(frame.status, &code, &message),
    )])));
    frame
}

fn v3_error_body_code_message(body: &Value) -> (String, String) {
    let error = body.get("error").unwrap_or(body);
    let code = error
        .get("code")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .unwrap_or("runtime_error")
        .to_string();
    let message = error
        .get("message")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .unwrap_or("V3 Responses runtime error")
        .to_string();
    (code, message)
}

pub(super) fn responses_direct_output_response_with_console(
    frame: V3Server16HttpFrame,
    stream_console_finalizer: Option<V3DirectSseConsoleFinalizer>,
) -> Response<Body> {
    let mut builder = Response::builder()
        .status(StatusCode::from_u16(frame.status).expect("typed V3 status"))
        .header("content-type", &frame.content_type)
        .header("x-routecodex-v3-debug-node", frame.debug_node)
        .header("x-routecodex-v3-node-trace", frame.node_trace.join(","));
    if !frame.error_chain.is_empty() {
        builder = builder
            .header("x-routecodex-v3-error-node", frame.error_node)
            .header("x-routecodex-v3-error-chain", frame.error_chain.join(","));
    }
    let body = match frame.body {
        V3Server16Body::Json(value) => {
            serde_json::to_vec(&value).expect("V3Server16 JSON projection")
        }
        V3Server16Body::Bytes(bytes) => bytes,
        V3Server16Body::Sse(stream) => {
            let stream = wrap_v3_direct_sse_console_stream(stream, stream_console_finalizer);
            return builder
                .body(v3_client_sse_body(stream))
                .expect("typed response");
        }
    };
    builder.body(Body::from(body)).expect("typed response")
}

pub(super) fn wrap_v3_direct_sse_console_stream(
    stream: V3ClientSseStream,
    finalizer: Option<V3DirectSseConsoleFinalizer>,
) -> V3ClientSseStream {
    match finalizer {
        Some(finalizer) => {
            wrap_v3_direct_sse_closeout_stream(stream, move |terminal| match terminal {
                V3SseConsoleStreamTerminal::Completed => finalizer.complete(),
                V3SseConsoleStreamTerminal::Failed(error) => {
                    finalizer.provider_stream_failed(&error)
                }
                V3SseConsoleStreamTerminal::Dropped => finalizer.client_disconnected(),
            })
        }
        None => stream,
    }
}

pub fn build_v3_server_16_http_frame_from_v3_resp_15(
    payload: V3Resp15ClientPayload,
    mut node_trace: Vec<&'static str>,
    error_chain: Option<Vec<&'static str>>,
) -> V3Server16HttpFrame {
    node_trace.push("V3Server16HttpFrame");
    let content_type = payload
        .headers
        .get("content-type")
        .expect("V3Resp15ClientPayload owns a validated content-type")
        .clone();
    let error_chain = error_chain.unwrap_or_default();
    let error_body = match &payload.body {
        V3ClientBody::Json(value) if !error_chain.is_empty() => Some(value.clone()),
        V3ClientBody::Json(_) | V3ClientBody::Bytes(_) | V3ClientBody::Sse(_) => None,
    };
    V3Server16HttpFrame {
        status: payload.status,
        content_type,
        body: match payload.body {
            V3ClientBody::Json(value) => V3Server16Body::Json(value),
            V3ClientBody::Bytes(bytes) => V3Server16Body::Bytes(bytes),
            V3ClientBody::Sse(stream) => V3Server16Body::Sse(stream),
        },
        debug_node: "V3Debug01NodeEventRegistered",
        error_node: if error_chain.is_empty() {
            "none"
        } else {
            "V3Error06ClientProjected"
        },
        error_chain,
        error_body,
        node_trace,
        observability: None,
        stream_observation: None,
    }
}
