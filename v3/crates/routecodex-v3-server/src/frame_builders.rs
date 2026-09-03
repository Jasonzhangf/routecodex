use crate::*;
use axum::body::Body;
use axum::extract::{Request, State};
use axum::http::{HeaderMap, Response, StatusCode};
use futures_util::{FutureExt, StreamExt};
use serde_json::{json, Value};
use std::io::Write;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

pub(crate) async fn debug_status(State(state): State<Arc<V3ListenerState>>) -> Response<Body> {
    match state.debug.status() {
        Ok(status) => {
            let mut status = serde_json::to_value(status)
                .expect("V3DebugStatusProjection must remain serializable");
            if let Some(object) = status.as_object_mut() {
                object.insert(
                    "codex_samples_enabled".to_string(),
                    Value::Bool(state.codex_sample_store.is_enabled()),
                );
                object.insert(
                    "direct_snapshots_enabled".to_string(),
                    Value::Bool(
                        state.codex_sample_store.is_enabled()
                            && state.manifest.debug.snapshot_direct,
                    ),
                );
            }
            json_response(200, json!({ "debug": status }))
        }
        Err(error) => {
            foundation_output_response(project_v3_debug_failure("V3DebugStatusProjected", error))
        }
    }
}

pub(crate) async fn debug_logs(State(state): State<Arc<V3ListenerState>>) -> Response<Body> {
    match state.debug.logs() {
        Ok(logs) => json_response(200, json!({ "logs": logs })),
        Err(error) => {
            foundation_output_response(project_v3_debug_failure("V3DebugLogsProjected", error))
        }
    }
}

pub(crate) async fn debug_snapshots(State(state): State<Arc<V3ListenerState>>) -> Response<Body> {
    match state.debug.snapshots() {
        Ok(snapshots) => json_response(200, json!({ "snapshots": snapshots })),
        Err(error) => {
            foundation_output_response(project_v3_debug_failure("V3DebugSnapshotsProjected", error))
        }
    }
}

pub(crate) async fn debug_dry_run(
    State(state): State<Arc<V3ListenerState>>,
    request: Request,
) -> Response<Body> {
    let payload = match read_json_payload(request).await {
        Ok(payload) => payload,
        Err(projected) => {
            return error_output_response_for_server(
                &state.server,
                "/_routecodex/debug/dry-run",
                "pre-request",
                projected,
            );
        }
    };
    let fixture_id = match required_dry_run_string(&payload, "fixture_id") {
        Ok(value) => value,
        Err(error) => {
            return foundation_output_response(project_v3_debug_failure(
                "V3DryRunFixtureRegistered",
                error,
            ));
        }
    };
    let method = match required_dry_run_string(&payload, "method") {
        Ok(value) => value,
        Err(error) => {
            return foundation_output_response(project_v3_debug_failure(
                "V3DryRunFixtureRegistered",
                error,
            ));
        }
    };
    let path = match required_dry_run_string(&payload, "path") {
        Ok(value) => value,
        Err(error) => {
            return foundation_output_response(project_v3_debug_failure(
                "V3DryRunFixtureRegistered",
                error,
            ));
        }
    };
    let Some(request_payload) = payload.get("request_payload").cloned() else {
        return foundation_output_response(project_v3_debug_failure(
            "V3DryRunFixtureRegistered",
            V3DebugError::MalformedFixture("request_payload is required".to_string()),
        ));
    };
    let Some(response_payload) = payload.get("response_payload").cloned() else {
        return foundation_output_response(project_v3_debug_failure(
            "V3DryRunFixtureRegistered",
            V3DebugError::MalformedFixture("response_payload is required".to_string()),
        ));
    };
    let output = if path == "/v1/messages" {
        let dry_run_request_id = format!("dry-run-{fixture_id}");
        let failure_session_scope = match V3ProviderFailureSessionScope::new(
            &state.server.id,
            &state.server.routing_group,
            &dry_run_request_id,
        ) {
            Ok(scope) => scope,
            Err(error) => {
                return foundation_output_response(project_v3_debug_failure(
                    "V3DryRunFixtureRegistered",
                    V3DebugError::MalformedFixture(error.to_string()),
                ));
            }
        };
        execute_v3_anthropic_relay_response_dry_run_runtime(
            &state.manifest,
            fixture_id,
            V3AnthropicRelayRuntimeInput {
                server_id: state.server.id.clone(),
                failure_session_scope,
                request_id: dry_run_request_id,
                toolreason_observation_session_id: Some("dry-run".to_string()),
                payload: request_payload,
            },
            response_payload,
        )
        .await
    } else {
        execute_v3_responses_direct_dry_run_runtime(
            V3DryRunFixture {
                fixture_id,
                server_id: state.server.id.clone(),
                method,
                path,
                request_payload,
                response_payload,
            },
            &state.manifest,
            &state.debug,
        )
        .await
    };
    foundation_output_response(output)
}

pub(crate) fn required_dry_run_string(
    payload: &serde_json::Value,
    field: &'static str,
) -> Result<String, V3DebugError> {
    payload
        .get(field)
        .and_then(|value| value.as_str())
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
        .ok_or_else(|| V3DebugError::MalformedFixture(format!("{field} is required")))
}

pub(crate) fn foundation_output_response(output: V3FoundationRuntimeOutput) -> Response<Body> {
    let frame = build_v3_server_16_http_frame_from_v3_foundation_output(output);
    let mut builder = Response::builder()
        .status(StatusCode::from_u16(frame.status).expect("typed V3 status"))
        .header("content-type", &frame.content_type);
    let body = match frame.body {
        V3Server16Body::Json(value) => {
            serde_json::to_vec(&value).expect("V3Server16 JSON projection")
        }
        V3Server16Body::Bytes(bytes) => bytes,
        V3Server16Body::Sse(stream) => {
            return builder
                .body(v3_live_client_sse_body(stream, None))
                .expect("typed response");
        }
        V3Server16Body::CommittedSse(stream) => {
            return builder
                .body(v3_client_sse_body(stream, None))
                .expect("typed response");
        }
    };
    builder.body(Body::from(body)).expect("typed response")
}

pub(crate) fn responses_direct_output_response(
    frame: V3Server16HttpFrame,
    keepalive_interval: Option<Duration>,
) -> Response<Body> {
    responses_direct_output_response_with_console(frame, None, keepalive_interval)
}

pub(crate) fn project_v3_responses_direct_stream_error_frame_if_requested(
    frame: V3Server16HttpFrame,
    requested_stream: bool,
) -> V3Server16HttpFrame {
    project_v3_protocol_stream_error_frame_if_requested(
        frame,
        requested_stream,
        V3SseClientProtocol::Responses,
    )
}

pub(crate) fn project_v3_responses_relay_stream_error_frame_if_requested(
    frame: V3Server16HttpFrame,
    requested_stream: bool,
) -> V3Server16HttpFrame {
    project_v3_protocol_stream_error_frame_if_requested(
        frame,
        requested_stream,
        V3SseClientProtocol::Responses,
    )
}

pub(crate) fn project_v3_protocol_stream_error_frame_if_requested(
    mut frame: V3Server16HttpFrame,
    requested_stream: bool,
    protocol: V3SseClientProtocol,
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
    let (code, message) = if code.starts_with("provider_response_") {
        (
            "response_stream_terminated".to_string(),
            "response stream terminated before completion".to_string(),
        )
    } else {
        (code, message)
    };
    if frame.error_body.is_none() {
        frame.error_body = Some(body);
    }
    frame.content_type = "text/event-stream".to_string();
    frame.body = V3Server16Body::Bytes(match protocol {
        V3SseClientProtocol::Responses => {
            v3_responses_sse_error_event_chunk(frame.status, &code, &message)
        }
        V3SseClientProtocol::OpenAiChat
        | V3SseClientProtocol::Anthropic
        | V3SseClientProtocol::Gemini => v3_sse_error_event_chunk(frame.status, &code, &message),
    });
    frame
}

pub(crate) fn v3_error_body_code_message(body: &Value) -> (String, String) {
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

pub(crate) fn v3_sse_error_event_chunk(status: u16, code: &str, message: &str) -> Vec<u8> {
    let event = json!({
        "type": "error",
        "status": status,
        "error": {
            "code": code,
            "message": message
        }
    });
    format!("event: error\ndata: {event}\n\ndata: [DONE]\n\n").into_bytes()
}

pub(crate) fn v3_responses_sse_error_event_chunk(
    _status: u16,
    code: &str,
    message: &str,
) -> Vec<u8> {
    let event = json!({
        "type": "response.failed",
        "response": {
            "status": "failed",
            "error": {
                "code": code,
                "message": message
            }
        }
    });
    format!("event: response.failed\ndata: {event}\n\ndata: [DONE]\n\n").into_bytes()
}

fn v3_sse_runtime_error_source_chunk_for_protocol(
    source_stage: &'static str,
    code: &'static str,
    message: impl Into<String>,
    status: u16,
    protocol: V3SseClientProtocol,
) -> Vec<u8> {
    let projected = project_v3_post_commit_sse_source(
        raise_v3_sse_runtime_failure(source_stage, code, message),
        status,
    );
    let (code, message) = v3_error_body_code_message(&projected.body);
    match protocol {
        V3SseClientProtocol::Responses => {
            v3_responses_sse_error_event_chunk(projected.status, &code, &message)
        }
        V3SseClientProtocol::OpenAiChat => {
            v3_sse_error_event_chunk(projected.status, &code, &message)
        }
        V3SseClientProtocol::Anthropic | V3SseClientProtocol::Gemini => {
            v3_sse_error_event_chunk(projected.status, &code, &message)
        }
    }
}

pub(crate) fn responses_direct_output_response_with_console(
    frame: V3Server16HttpFrame,
    stream_console_finalizer: Option<V3DirectSseConsoleFinalizer>,
    keepalive_interval: Option<Duration>,
) -> Response<Body> {
    responses_direct_output_response_with_console_for_protocol(
        frame,
        stream_console_finalizer,
        keepalive_interval,
        V3SseClientProtocol::Responses,
    )
}

pub(crate) fn responses_direct_output_response_with_console_for_protocol(
    frame: V3Server16HttpFrame,
    stream_console_finalizer: Option<V3DirectSseConsoleFinalizer>,
    keepalive_interval: Option<Duration>,
    protocol: V3SseClientProtocol,
) -> Response<Body> {
    let mut builder = Response::builder()
        .status(StatusCode::from_u16(frame.status).expect("typed V3 status"))
        .header("content-type", &frame.content_type);
    let body = match frame.body {
        V3Server16Body::Json(value) => {
            serde_json::to_vec(&value).expect("V3Server16 JSON projection")
        }
        V3Server16Body::Bytes(bytes) => bytes,
        V3Server16Body::Sse(stream) => {
            let stream = wrap_v3_direct_live_sse_console_stream(stream, stream_console_finalizer);
            let keepalive = frame
                .error_chain
                .is_empty()
                .then_some(keepalive_interval)
                .flatten();
            return builder
                .body(v3_live_client_sse_body_for_protocol(
                    stream, keepalive, protocol,
                ))
                .expect("typed response");
        }
        V3Server16Body::CommittedSse(stream) => {
            let stream =
                wrap_v3_direct_committed_sse_console_stream(stream, stream_console_finalizer);
            let keepalive = frame
                .error_chain
                .is_empty()
                .then_some(keepalive_interval)
                .flatten();
            return builder
                .body(v3_client_sse_body(stream, keepalive))
                .expect("typed response");
        }
    };
    builder.body(Body::from(body)).expect("typed response")
}

pub(crate) fn wrap_v3_direct_committed_sse_console_stream(
    stream: V3CommittedClientSseStream,
    finalizer: Option<V3DirectSseConsoleFinalizer>,
) -> V3CommittedClientSseStream {
    match finalizer {
        Some(finalizer) => stream.observe(
            |_| {},
            move |terminal| match terminal {
                V3CommittedSseTerminal::Completed => finalizer.complete(),
                V3CommittedSseTerminal::Dropped => finalizer.client_disconnected(),
            },
        ),
        None => stream,
    }
}

pub(crate) fn wrap_v3_direct_live_sse_console_stream(
    stream: V3ClientSseStream,
    finalizer: Option<V3DirectSseConsoleFinalizer>,
) -> V3ClientSseStream {
    let Some(finalizer) = finalizer else {
        return stream;
    };
    Box::pin(V3DirectLiveSseConsoleStream {
        stream,
        finalizer: Some(finalizer),
    })
}

struct V3DirectLiveSseConsoleStream {
    stream: V3ClientSseStream,
    finalizer: Option<V3DirectSseConsoleFinalizer>,
}

impl futures_util::Stream for V3DirectLiveSseConsoleStream {
    type Item = Result<Vec<u8>, routecodex_v3_error::V3Error01SourceRaised>;

    fn poll_next(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<Option<Self::Item>> {
        match self.stream.as_mut().poll_next(cx) {
            std::task::Poll::Ready(Some(Ok(chunk))) => std::task::Poll::Ready(Some(Ok(chunk))),
            std::task::Poll::Ready(Some(Err(error))) => {
                if let Some(finalizer) = self.finalizer.take() {
                    finalizer.emit_direct_sse_failure_console_line(599, error.clone());
                }
                std::task::Poll::Ready(Some(Err(error)))
            }
            std::task::Poll::Ready(None) => {
                if let Some(finalizer) = self.finalizer.take() {
                    finalizer.complete();
                }
                std::task::Poll::Ready(None)
            }
            std::task::Poll::Pending => std::task::Poll::Pending,
        }
    }
}

impl Drop for V3DirectLiveSseConsoleStream {
    fn drop(&mut self) {
        if let Some(finalizer) = self.finalizer.take() {
            finalizer.client_disconnected();
        }
    }
}

pub(crate) type V3IoSseStream =
    std::pin::Pin<Box<dyn futures_util::Stream<Item = Result<Vec<u8>, io::Error>> + Send>>;

#[derive(Clone, Copy)]
pub(crate) enum V3SseClientProtocol {
    Responses,
    OpenAiChat,
    Anthropic,
    Gemini,
}

pub(crate) fn v3_client_sse_body(
    stream: V3CommittedClientSseStream,
    keepalive_interval: Option<Duration>,
) -> Body {
    let stream: V3IoSseStream = Box::pin(stream::unfold(
        (stream, false),
        |(mut stream, done)| async move {
            if done {
                return None;
            }
            match stream.next().await {
                Some(chunk) => Some((Ok::<Vec<u8>, io::Error>(chunk), (stream, false))),
                None => None,
            }
        },
    ));
    v3_io_sse_body(Box::pin(stream), keepalive_interval)
}

pub(crate) fn v3_live_client_sse_body(
    stream: V3ClientSseStream,
    keepalive_interval: Option<Duration>,
) -> Body {
    v3_live_client_sse_body_for_protocol(
        stream,
        keepalive_interval,
        V3SseClientProtocol::OpenAiChat,
    )
}

pub(crate) fn v3_live_client_sse_body_for_protocol(
    stream: V3ClientSseStream,
    keepalive_interval: Option<Duration>,
    protocol: V3SseClientProtocol,
) -> Body {
    // The typed stream error has already gone to the runtime Error chain and
    // console owner. Keep provider/internal diagnostics off the client frame;
    // the protocol-specific client terminal is emitted at this boundary.
    let stream: V3IoSseStream = Box::pin(stream.map(|item| {
        item.map_err(|_| io::Error::other("response stream terminated before completion"))
    }));
    v3_io_sse_body_for_protocol(Box::pin(stream), keepalive_interval, protocol)
}

pub(crate) fn wrap_v3_committed_sse_dump_stream(
    stream: V3CommittedClientSseStream,
    sse_dump_enabled: bool,
    port: u16,
    endpoint: &str,
    request_id: &str,
) -> V3CommittedClientSseStream {
    if !sse_dump_enabled {
        return stream;
    }
    let Some(home) = std::env::var_os("HOME") else {
        return stream;
    };
    let dump_dir = PathBuf::from(home.as_os_str())
        .join(".rcc")
        .join("sse-dumps")
        .join(endpoint.trim_start_matches('/'))
        .join("ports")
        .join(port.to_string())
        .join(request_id);
    if let Err(error) = std::fs::create_dir_all(&dump_dir) {
        eprintln!("[v3-sse-dump] create_dir_all failed: {error}");
        return stream;
    }
    let mut file = match std::fs::File::create(dump_dir.join("sse-client.bin")) {
        Ok(file) => file,
        Err(error) => {
            eprintln!("[v3-sse-dump] create failed: {error}");
            return stream;
        }
    };
    if let Err(error) = file.write_all(
        format!("# sse dump start endpoint={endpoint} port={port} request_id={request_id}\n")
            .as_bytes(),
    ) {
        eprintln!("[v3-sse-dump] header write failed: {error}");
        return stream;
    }
    let file = Arc::new(std::sync::Mutex::new(file));
    let frame_file = Arc::clone(&file);
    stream.observe(
        move |chunk| {
            if let Ok(mut file) = frame_file.lock() {
                let _ = file.write_all(chunk);
            }
        },
        move |terminal| {
            if let Ok(mut file) = file.lock() {
                let marker = match terminal {
                    V3CommittedSseTerminal::Completed => b"\n# sse stream eof\n".as_slice(),
                    V3CommittedSseTerminal::Dropped => {
                        b"\n# sse stream dropped by client\n".as_slice()
                    }
                };
                let _ = file.write_all(marker);
            }
        },
    )
}

pub(crate) fn wrap_v3_live_sse_dump_stream(
    stream: V3ClientSseStream,
    sse_dump_enabled: bool,
    port: u16,
    endpoint: &str,
    request_id: &str,
) -> V3ClientSseStream {
    if !sse_dump_enabled {
        return stream;
    }
    let Some(home) = std::env::var_os("HOME") else {
        return stream;
    };
    let dump_dir = PathBuf::from(home.as_os_str())
        .join(".rcc")
        .join("sse-dumps")
        .join(endpoint.trim_start_matches('/'))
        .join("ports")
        .join(port.to_string())
        .join(request_id);
    if let Err(error) = std::fs::create_dir_all(&dump_dir) {
        eprintln!("[v3-sse-dump] create_dir_all failed: {error}");
        return stream;
    }
    let mut file = match std::fs::File::create(dump_dir.join("sse-client-live.bin")) {
        Ok(file) => file,
        Err(error) => {
            eprintln!("[v3-sse-dump] create failed: {error}");
            return stream;
        }
    };
    if let Err(error) = file.write_all(
        format!("# live sse dump start endpoint={endpoint} port={port} request_id={request_id}\n")
            .as_bytes(),
    ) {
        eprintln!("[v3-sse-dump] header write failed: {error}");
        return stream;
    }
    let file = Arc::new(std::sync::Mutex::new(file));
    Box::pin(stream::unfold(
        (stream, file),
        |(mut stream, file)| async move {
            match stream.next().await {
                Some(Ok(chunk)) => {
                    if let Ok(mut file) = file.lock() {
                        let _ = file.write_all(&chunk);
                    }
                    Some((Ok(chunk), (stream, file)))
                }
                Some(Err(error)) => {
                    if let Ok(mut file) = file.lock() {
                        let _ = file.write_all(
                            format!("\n# live sse stream error: {error:?}\n").as_bytes(),
                        );
                    }
                    Some((Err(error), (stream, file)))
                }
                None => {
                    if let Ok(mut file) = file.lock() {
                        let _ = file.write_all(b"\n# live sse stream eof\n");
                    }
                    None
                }
            }
        },
    ))
}

pub(crate) fn v3_io_sse_body(stream: V3IoSseStream, keepalive_interval: Option<Duration>) -> Body {
    v3_io_sse_body_for_protocol(stream, keepalive_interval, V3SseClientProtocol::OpenAiChat)
}

fn v3_io_sse_body_for_protocol(
    stream: V3IoSseStream,
    keepalive_interval: Option<Duration>,
    protocol: V3SseClientProtocol,
) -> Body {
    // A body-stream error must never become a bare EOF. Runtime/provider
    // failures are already handled before client commit; anything that still
    // reaches this transport owner is an internal response-stage failure and
    // is made explicit as 599 before the SSE body closes.
    let stream: V3IoSseStream = Box::pin(stream::unfold(
        (stream, false),
        move |(mut stream, done)| async move {
            if done {
                return None;
            }
            match stream.next().await {
                Some(Ok(chunk)) => Some((Ok::<Vec<u8>, io::Error>(chunk), (stream, false))),
                Some(Err(error)) => Some((
                    Ok(v3_sse_runtime_error_source_chunk_for_protocol(
                        "V3ServerRespOutbound05ClientFrame",
                        "internal_response_stream_error",
                        format!("internal response stream failed: {error}"),
                        599,
                        protocol,
                    )),
                    (stream, true),
                )),
                None => None,
            }
        },
    ));
    let Some(keepalive_interval) = keepalive_interval else {
        return Body::from_stream(stream::unfold(
            (stream, false),
            move |(mut stream, done)| async move {
                if done {
                    return None;
                }
                match std::panic::AssertUnwindSafe(stream.next())
                    .catch_unwind()
                    .await
                {
                    Ok(Some(Ok(bytes))) => Some((Ok::<Vec<u8>, io::Error>(bytes), (stream, false))),
                    Ok(Some(Err(error))) => {
                        let frame = v3_sse_runtime_error_source_chunk_for_protocol(
                            "V3ServerRespOutbound05ClientFrame",
                            "front_sse_io_stream_failed",
                            error.to_string(),
                            599,
                            protocol,
                        );
                        Some((Ok(frame), (Box::pin(stream::empty()), true)))
                    }
                    Ok(None) => None,
                    Err(payload) => {
                        let message = payload
                            .downcast_ref::<&str>()
                            .copied()
                            .or_else(|| payload.downcast_ref::<String>().map(String::as_str))
                            .unwrap_or("Front SSE IO stream panicked");
                        let frame = v3_sse_runtime_error_source_chunk_for_protocol(
                            "V3ServerRespOutbound05ClientFrame",
                            "front_sse_io_stream_panicked",
                            message,
                            599,
                            protocol,
                        );
                        Some((Ok(frame), (Box::pin(stream::empty()), true)))
                    }
                }
            },
        ));
    };
    let keepalive_chunk =
        build_v3_sse_transport_out_04_keepalive_comment(" keepalive").into_bytes();
    let mut interval = tokio::time::interval_at(
        tokio::time::Instant::now() + keepalive_interval,
        keepalive_interval,
    );
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    Body::from_stream(stream::unfold(
        (stream, interval, true, keepalive_chunk),
        move |(mut stream, mut interval, initial, keepalive_chunk)| async move {
            if initial {
                return Some((
                    Ok::<Vec<u8>, io::Error>(keepalive_chunk.clone()),
                    (stream, interval, false, keepalive_chunk),
                ));
            }
            let next = tokio::select! {
                biased;
                item = stream.next() => item.map(|item| {
                    (item, (stream, interval, false, keepalive_chunk.clone()))
                }),
                _ = interval.tick() => Some((
                    Ok::<Vec<u8>, io::Error>(keepalive_chunk.clone()),
                    (stream, interval, false, keepalive_chunk.clone()),
                )),
            };
            match next {
                Some((Ok(bytes), state)) => Some((Ok(bytes), state)),
                Some((Err(error), (stream, interval, _, keepalive_chunk))) => {
                    let frame = v3_sse_runtime_error_source_chunk_for_protocol(
                        "V3ServerRespOutbound05ClientFrame",
                        "front_sse_io_stream_failed",
                        error.to_string(),
                        599,
                        protocol,
                    );
                    Some((
                        Ok(frame),
                        (Box::pin(stream::empty()), interval, false, keepalive_chunk),
                    ))
                }
                None => None,
            }
        },
    ))
}

pub(crate) fn build_v3_server_16_http_frame_from_v3_resp_15(
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
        V3ClientBody::Json(_)
        | V3ClientBody::Bytes(_)
        | V3ClientBody::Sse(_)
        | V3ClientBody::CommittedSse(_) => None,
    };
    V3Server16HttpFrame {
        status: payload.status,
        content_type,
        body: match payload.body {
            V3ClientBody::Json(value) => V3Server16Body::Json(value),
            V3ClientBody::Bytes(bytes) => V3Server16Body::Bytes(bytes),
            V3ClientBody::Sse(stream) => V3Server16Body::Sse(stream),
            V3ClientBody::CommittedSse(stream) => V3Server16Body::CommittedSse(stream),
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

pub(crate) fn build_v3_server_16_http_frame_from_v3_error_06(
    projected: routecodex_v3_error::V3Error06ClientProjected,
) -> V3Server16HttpFrame {
    let body = projected.body;
    V3Server16HttpFrame {
        status: projected.status,
        content_type: "application/json".to_string(),
        body: V3Server16Body::Json(body.clone()),
        debug_node: "V3Debug01NodeEventRegistered",
        error_node: projected.chain[5],
        error_chain: projected.chain.to_vec(),
        error_body: Some(body),
        node_trace: vec!["V3Error06ClientProjected", "V3Server16HttpFrame"],
        observability: None,
        stream_observation: None,
    }
}

pub(crate) fn build_v3_server_16_http_frame_from_v3_foundation_output(
    output: V3FoundationRuntimeOutput,
) -> V3Server16HttpFrame {
    let error_body = if output.error_chain.is_empty() {
        None
    } else {
        Some(output.body.clone())
    };
    V3Server16HttpFrame {
        status: output.status,
        content_type: "application/json".to_string(),
        body: V3Server16Body::Json(output.body),
        debug_node: output.debug_node,
        error_node: output.error_node,
        error_chain: output.error_chain,
        error_body,
        node_trace: output.node_trace,
        observability: None,
        stream_observation: None,
    }
}

pub(crate) fn build_v3_debug_runtime_from_manifest(
    manifest: &V3DebugManifest,
) -> Result<V3DebugRuntime, routecodex_v3_debug::V3DebugError> {
    V3DebugRuntime::new(V3DebugRuntimeConfig {
        log_console: manifest.log_console,
        log_file: manifest.log_file.clone(),
        snapshots_enabled: manifest.snapshots,
        snapshot_stages: manifest.snapshot_stages.clone(),
        dry_run_enabled: manifest.dry_run,
        raw_request_retention: manifest
            .retention
            .get("raw_requests")
            .copied()
            .unwrap_or(200) as usize,
        raw_response_retention: manifest
            .retention
            .get("raw_responses")
            .copied()
            .unwrap_or(200) as usize,
        event_retention: manifest.retention.get("events").copied().unwrap_or(512) as usize,
        redaction: V3RedactionPolicy::default(),
    })
}

// Preserve the V2 HTTP contract: image-bearing Responses requests may contain
// large data URLs, while the boundary still needs a finite allocation cap.
// 256MB: Codex/OneStop 黑盒客户端会把全部历史图片 base64 随请求发送（累积可超
// 64MB）；routecodex 必须接收后经 req04 历史轮图片清洗（→[Image] 占位）再进 wire，
// 而不是在读取阶段 413（客户端黑盒无法修改，只能适配）。读取后 req04 立即剥离历史
// 图片，wire 侧体积回到正常量级，内存峰值仅存在于读取-清洗窗口。
pub(crate) const V3_MAX_REQUEST_BODY_BYTES: usize = 256 * 1024 * 1024;

pub(crate) async fn read_json_payload(
    request: Request,
) -> Result<serde_json::Value, routecodex_v3_error::V3Error06ClientProjected> {
    let content_length = request
        .headers()
        .get(CONTENT_LENGTH)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.trim().parse::<u64>().ok());
    let content_type = request
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok());
    let Some(content_type) = content_type else {
        return Err(project_http_input_error(
            V3HttpBoundaryErrorKind::ContentTypeRequired,
            "content-type application/json is required",
        ));
    };
    if !content_type
        .split(';')
        .next()
        .is_some_and(|value| value.trim().eq_ignore_ascii_case("application/json"))
    {
        return Err(project_http_input_error(
            V3HttpBoundaryErrorKind::ContentTypeUnsupported,
            format!("unsupported content-type {content_type}"),
        ));
    }
    let bytes = to_bytes(request.into_body(), V3_MAX_REQUEST_BODY_BYTES)
        .await
        .map_err(|error| {
            project_http_input_error(
                V3HttpBoundaryErrorKind::BodyTooLarge,
                format!("request body exceeds {V3_MAX_REQUEST_BODY_BYTES} bytes: {error}"),
            )
        })?;
    serde_json::from_slice(&bytes).map_err(|error| {
        let content_length = content_length
            .map(|value| value.to_string())
            .unwrap_or_else(|| "unknown".to_string());
        project_http_input_error(
            V3HttpBoundaryErrorKind::MalformedJson,
            format!(
                "malformed JSON request body: {error}; body_bytes={} content_length={content_length}",
                bytes.len()
            ),
        )
    })
}

pub(crate) async fn method_not_allowed(
    State(state): State<Arc<V3ListenerState>>,
    request: Request,
) -> Response<Body> {
    let path = request.uri().path().to_string();
    let request_id = match allocate_v3_console_request_id(&state, &path, None) {
        Ok(request_id) => request_id,
        Err(response) => return *response,
    };
    error_output_response_for_server(
        &state.server,
        &path,
        &request_id,
        project_http_input_error(
            V3HttpBoundaryErrorKind::MethodNotAllowed,
            "HTTP method is not allowed for this endpoint",
        ),
    )
}

pub(crate) async fn path_not_found(
    State(state): State<Arc<V3ListenerState>>,
    request: Request,
) -> Response<Body> {
    let path = request.uri().path().to_string();
    let request_id = match allocate_v3_console_request_id(&state, &path, None) {
        Ok(request_id) => request_id,
        Err(response) => return *response,
    };
    error_output_response_for_server(
        &state.server,
        &path,
        &request_id,
        project_http_input_error(
            V3HttpBoundaryErrorKind::PathNotFound,
            "HTTP path is not registered",
        ),
    )
}

pub(crate) fn project_http_input_error(
    kind: V3HttpBoundaryErrorKind,
    message: impl Into<String>,
) -> routecodex_v3_error::V3Error06ClientProjected {
    project_v3_http_boundary_error(kind, message)
}

pub(crate) fn error_output_response_for_server(
    server: &V3ServerManifest,
    endpoint: &str,
    request_id: &str,
    projected: routecodex_v3_error::V3Error06ClientProjected,
) -> Response<Body> {
    error_output_response_for_server_with_project_path(
        server, endpoint, request_id, projected, None,
    )
}

pub(crate) fn error_output_response_for_server_with_project_path(
    server: &V3ServerManifest,
    endpoint: &str,
    request_id: &str,
    projected: routecodex_v3_error::V3Error06ClientProjected,
    project_path: Option<&str>,
) -> Response<Body> {
    let frame = build_v3_server_16_http_frame_from_v3_error_06(projected);
    emit_v3_frame_error_console_line(server, endpoint, request_id, &frame, project_path);
    responses_direct_output_response(
        frame,
        Some(Duration::from_millis(server.http_sse_keepalive_ms)),
    )
}

pub(crate) fn error_output_response_for_responses_request_with_project_path(
    server: &V3ServerManifest,
    endpoint: &str,
    request_id: &str,
    projected: routecodex_v3_error::V3Error06ClientProjected,
    request_headers: &HeaderMap,
    payload: Option<&Value>,
    project_path: Option<&str>,
) -> Response<Body> {
    let frame = build_v3_server_16_http_frame_from_v3_error_06(projected);
    emit_v3_frame_error_console_line(server, endpoint, request_id, &frame, project_path);
    responses_direct_output_response(
        project_v3_responses_error_frame_for_request_if_sse(frame, request_headers, payload),
        Some(Duration::from_millis(server.http_sse_keepalive_ms)),
    )
}

pub(crate) fn project_v3_responses_error_frame_for_request_if_sse(
    frame: V3Server16HttpFrame,
    request_headers: &HeaderMap,
    payload: Option<&Value>,
) -> V3Server16HttpFrame {
    let requested_stream = payload
        .and_then(|payload| payload.get("stream"))
        .and_then(Value::as_bool)
        == Some(true)
        || request_accepts_sse(request_headers);
    project_v3_responses_direct_stream_error_frame_if_requested(frame, requested_stream)
}

pub(crate) fn json_response(status: u16, body: serde_json::Value) -> Response<Body> {
    Response::builder()
        .status(StatusCode::from_u16(status).expect("fixed status"))
        .header("content-type", "application/json")
        .body(Body::from(
            serde_json::to_vec(&body).expect("JSON projection"),
        ))
        .expect("fixed response")
}
