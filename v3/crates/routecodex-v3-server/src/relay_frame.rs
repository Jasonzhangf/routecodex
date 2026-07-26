// V3 relay/client HTTP frame projection shell.
// Projects runtime client payloads to HTTP/SSE bodies and transport closeout only.

use super::*;

pub(super) fn responses_relay_output_response(
    output: V3ResponsesRelayRuntimeOutput,
    stream_console_finalizer: Option<V3SseConsoleFinalizer>,
) -> Response<Body> {
    let content_type = match &output.client_body {
        V3ResponsesRelayClientBody::Json(_) => "application/json",
        V3ResponsesRelayClientBody::Sse(_) => "text/event-stream",
    };
    let mut builder = Response::builder()
        .status(StatusCode::from_u16(output.status).expect("typed V3 Responses Relay status"))
        .header("content-type", content_type)
        .header("x-routecodex-v3-node-trace", output.node_trace.join(","));
    if let Some(error_chain) = output.error_chain {
        builder = builder.header("x-routecodex-v3-error-chain", error_chain.join(","));
    }
    let body = match output.client_body {
        V3ResponsesRelayClientBody::Sse(client_stream) => v3_relay_client_sse_body(
            wrap_v3_relay_sse_console_stream(client_stream, stream_console_finalizer),
        ),
        V3ResponsesRelayClientBody::Json(client_response) => Body::from(
            serde_json::to_vec(&client_response).expect("typed V3 Responses Relay projection"),
        ),
    };
    builder
        .body(body)
        .expect("typed V3 Responses Relay response")
}

pub(super) fn wrap_v3_relay_sse_console_stream(
    stream: V3ResponsesRelayClientStream,
    finalizer: Option<V3SseConsoleFinalizer>,
) -> V3ResponsesRelayClientStream {
    match finalizer {
        Some(finalizer) => {
            wrap_v3_relay_sse_closeout_stream(stream, move |terminal| match terminal {
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

pub(super) struct V3SseConsoleCloseoutStream {
    stream: V3ResponsesRelayClientStream,
    closeout: Option<Box<dyn FnOnce(V3SseConsoleStreamTerminal) + Send>>,
}

impl V3SseConsoleCloseoutStream {
    fn emit_terminal(&mut self, terminal: V3SseConsoleStreamTerminal) {
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
                this.emit_terminal(V3SseConsoleStreamTerminal::Failed(error.clone()));
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

pub(super) fn wrap_v3_relay_sse_closeout_stream(
    stream: V3ResponsesRelayClientStream,
    closeout: impl FnOnce(V3SseConsoleStreamTerminal) + Send + 'static,
) -> V3ResponsesRelayClientStream {
    Box::pin(V3SseConsoleCloseoutStream {
        stream,
        closeout: Some(Box::new(closeout)),
    })
}

pub(super) fn openai_chat_relay_output_response(
    output: V3OpenAiChatRelayRuntimeOutput,
) -> Response<Body> {
    let content_type = match &output.client_body {
        V3OpenAiChatRelayClientBody::Json(_) => "application/json",
        V3OpenAiChatRelayClientBody::Sse(_) => "text/event-stream",
    };
    let mut builder = Response::builder()
        .status(StatusCode::from_u16(output.status).expect("typed V3 OpenAI Chat Relay status"))
        .header("content-type", content_type)
        .header("x-routecodex-v3-node-trace", output.node_trace.join(","));
    if let Some(error_chain) = output.error_chain {
        builder = builder.header("x-routecodex-v3-error-chain", error_chain.join(","));
    }
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

pub(super) fn gemini_relay_output_response(output: V3GeminiRelayRuntimeOutput) -> Response<Body> {
    let content_type = match &output.client_body {
        V3GeminiRelayClientBody::Json(_) => "application/json",
        V3GeminiRelayClientBody::Sse(_) => "text/event-stream",
    };
    let mut builder = Response::builder()
        .status(StatusCode::from_u16(output.status).expect("typed V3 Gemini Relay status"))
        .header("content-type", content_type)
        .header("x-routecodex-v3-node-trace", output.node_trace.join(","));
    if let Some(error_chain) = output.error_chain {
        builder = builder.header("x-routecodex-v3-error-chain", error_chain.join(","));
    }
    let body = match output.client_body {
        V3GeminiRelayClientBody::Sse(client_stream) => Body::from_stream(client_stream),
        V3GeminiRelayClientBody::Json(client_response) => Body::from(
            serde_json::to_vec(&client_response).expect("typed V3 Gemini Relay projection"),
        ),
    };
    builder.body(body).expect("typed V3 Gemini Relay response")
}

pub(super) fn anthropic_relay_output_response(
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
        )
        .header("x-routecodex-v3-node-trace", output.node_trace.join(","));
    if let Some(error_chain) = output.error_chain {
        builder = builder.header("x-routecodex-v3-error-chain", error_chain.join(","));
    }
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

pub(super) fn anthropic_relay_sse_body(client_response: serde_json::Value) -> Body {
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

pub(super) fn anthropic_relay_sse_event_chunk(
    event: &serde_json::Value,
) -> Result<Vec<u8>, io::Error> {
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

pub(super) fn foundation_output_response(output: V3FoundationRuntimeOutput) -> Response<Body> {
    let frame = build_v3_server_16_http_frame_from_v3_foundation_output(output);
    let mut builder = Response::builder()
        .status(StatusCode::from_u16(frame.status).expect("typed V3 status"))
        .header("content-type", &frame.content_type)
        .header("x-routecodex-v3-debug-node", frame.debug_node);
    if frame.error_chain.is_empty() {
        builder = builder.header("x-routecodex-v3-no-network-send", "true");
    } else {
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
            return builder
                .body(v3_client_sse_body(stream))
                .expect("typed response");
        }
    };
    builder.body(Body::from(body)).expect("typed response")
}

pub(super) fn v3_sse_error_event_chunk(status: u16, code: &str, message: &str) -> Vec<u8> {
    let event = json!({
        "type": "error",
        "status": status,
        "error": {
            "code": code,
            "message": message
        }
    });
    format!("event: error\ndata: {event}\n\n").into_bytes()
}

pub(super) fn v3_client_sse_body(stream: V3ClientSseStream) -> Body {
    Body::from_stream(stream::unfold(
        (stream, false),
        |(mut stream, done)| async move {
            if done {
                return None;
            }
            match stream.next().await {
                Some(Ok(chunk)) => Some((Ok::<Vec<u8>, io::Error>(chunk), (stream, false))),
                Some(Err(error)) => Some((
                    Ok(v3_sse_error_event_chunk(502, &error.code, &error.message)),
                    (stream, true),
                )),
                None => None,
            }
        },
    ))
}

pub(super) fn v3_relay_client_sse_body(stream: V3ResponsesRelayClientStream) -> Body {
    Body::from_stream(stream::unfold(
        (stream, false),
        |(mut stream, done)| async move {
            if done {
                return None;
            }
            match stream.next().await {
                Some(Ok(chunk)) => Some((Ok::<Vec<u8>, io::Error>(chunk), (stream, false))),
                Some(Err(error)) => Some((
                    Ok(v3_sse_error_event_chunk(
                        502,
                        "provider_response_sse_stream",
                        &error,
                    )),
                    (stream, true),
                )),
                None => None,
            }
        },
    ))
}

// feature_id: v3.models_capability_catalog
