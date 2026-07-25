use crate::nodes::{V3ClientBody, V3ClientSseStream, V3Resp15ClientPayload};
use futures_util::{stream, StreamExt};
use routecodex_v3_error::{
    build_v3_error_01_source_raised, V3Error01SourceRaised, V3ErrorSourceKind,
};
use routecodex_v3_provider_responses::{
    V3ProviderError, V3ProviderResp14Raw, V3ProviderResponseBody, V3ProviderSseStream,
};
use routecodex_v3_sse::{
    build_v3_sse_transport_in_01_raw_chunk, SseField, SseIncrementalDecoder, SseTransportError,
    SseTransportLimits,
};
use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};

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

    fn record_pending_response_id(&self, response_id: &str) -> Result<(), V3Error01SourceRaised> {
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
}

pub(crate) async fn project_provider_raw_to_client_payload(
    raw: V3ProviderResp14Raw,
) -> Result<V3ProviderResponseProjection, V3Error01SourceRaised> {
    if raw.status() >= 400 {
        return Err(build_v3_error_01_source_raised(
            V3ErrorSourceKind::ProviderFailure,
            "V3ProviderResp14Raw",
            format!("provider_http_{}", raw.status()),
            format!("provider {} returned {}", raw.provider_id(), raw.status()),
        ));
    }
    let status = raw.status();
    let content_type = raw
        .header_text("content-type")
        .map_err(provider_body_source)?
        .map(ToOwned::to_owned)
        .ok_or_else(|| {
            build_v3_error_01_source_raised(
                V3ErrorSourceKind::ProviderFailure,
                "V3ProviderResp14Raw",
                "provider_content_type_missing",
                "provider response missing content-type",
            )
        })?;
    let provider_body = raw.into_body();
    let (body, remote_continuation) = if content_type.starts_with("text/event-stream") {
        match provider_body {
            V3ProviderResponseBody::Sse(stream) => project_sse_stream(stream).await?,
            V3ProviderResponseBody::Json(body_bytes) => {
                let observation = observe_sse_remote_continuation_bytes(&body_bytes)?;
                (V3ClientBody::Bytes(body_bytes), observation)
            }
        }
    } else if content_type.starts_with("application/json") {
        let V3ProviderResponseBody::Json(body_bytes) = provider_body else {
            return Err(build_v3_error_01_source_raised(
                V3ErrorSourceKind::ProviderFailure,
                "V3ProviderResp14Raw",
                "provider_response_body_kind_mismatch",
                "application/json provider response arrived as SSE stream body",
            ));
        };
        let parsed: serde_json::Value = serde_json::from_slice(&body_bytes).map_err(|error| {
            build_v3_error_01_source_raised(
                V3ErrorSourceKind::ProviderFailure,
                "V3ProviderResp14Raw",
                "provider_response_json_invalid",
                format!("provider response JSON parse failed: {error}"),
            )
        })?;
        let observation = observe_json_remote_continuation(&parsed)?;
        (V3ClientBody::Json(parsed), observation)
    } else {
        return Err(build_v3_error_01_source_raised(
            V3ErrorSourceKind::ProviderFailure,
            "V3ProviderResp14Raw",
            "provider_content_type_unsupported",
            format!("unsupported provider response content-type {content_type}"),
        ));
    };
    Ok(V3ProviderResponseProjection {
        client_payload: V3Resp15ClientPayload {
            status,
            headers: BTreeMap::from([("content-type".to_string(), content_type)]),
            body,
        },
        remote_continuation,
    })
}

async fn project_sse_stream(
    stream: V3ProviderSseStream,
) -> Result<(V3ClientBody, V3RemoteContinuationObservation), V3Error01SourceRaised> {
    let stream = guard_initial_direct_sse_provider_failure(stream).await?;
    let observation_state = V3SseRemoteContinuationObservationState::default();
    let client_stream = observed_sse_client_stream(stream, observation_state.clone());
    Ok((
        V3ClientBody::Sse(client_stream),
        V3RemoteContinuationObservation::Streaming {
            state: observation_state,
        },
    ))
}

async fn guard_initial_direct_sse_provider_failure(
    mut stream: V3ProviderSseStream,
) -> Result<V3ProviderSseStream, V3Error01SourceRaised> {
    let mut decoder = SseIncrementalDecoder::new(SseTransportLimits::default());
    let mut buffered = Vec::<Vec<u8>>::new();
    loop {
        let Some(next) = stream.next().await else {
            decoder.finish().map_err(sse_transport_source)?;
            return Err(build_v3_error_01_source_raised(
                V3ErrorSourceKind::ProviderFailure,
                "V3ProviderResp14Raw",
                "provider_response_sse_empty",
                "provider response SSE stream ended before first semantic event",
            ));
        };
        let chunk = next.map_err(provider_body_source)?;
        let frames = decoder
            .push(build_v3_sse_transport_in_01_raw_chunk(&chunk))
            .map_err(sse_transport_source)?;
        let mut should_start_client_stream = false;
        for frame in frames {
            if direct_sse_frame_provider_failure_source(frame.frame().fields())?
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
    fields: &[SseField],
) -> Result<DirectSseInitialFrameAction, V3Error01SourceRaised> {
    let mut event_type = None::<String>;
    let mut data = String::new();
    for field in fields {
        let SseField::Named { name, value } = field else {
            continue;
        };
        if name == "event" && event_type.is_none() {
            let trimmed = value.trim();
            if !trimmed.is_empty() {
                event_type = Some(trimmed.to_string());
            }
        } else if name == "data" {
            if !data.is_empty() {
                data.push('\n');
            }
            data.push_str(value);
        }
    }
    let data = data.trim();
    if data.is_empty() || data == "[DONE]" {
        return Ok(DirectSseInitialFrameAction::ContinueBuffering);
    }
    let event: serde_json::Value = serde_json::from_str(data).map_err(|error| {
        build_v3_error_01_source_raised(
            V3ErrorSourceKind::ProviderFailure,
            "V3ProviderResp14Raw",
            "provider_response_sse_event_invalid",
            error.to_string(),
        )
    })?;
    let semantic_event_type = event_type
        .as_deref()
        .or_else(|| event.get("type").and_then(serde_json::Value::as_str));
    if let Some(source) = direct_sse_event_provider_failure_source(semantic_event_type, &event) {
        return Err(source);
    }
    if matches!(
        semantic_event_type.map(str::trim),
        Some("response.created" | "response.in_progress")
    ) {
        Ok(DirectSseInitialFrameAction::ContinueBuffering)
    } else {
        Ok(DirectSseInitialFrameAction::StartClientStream)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DirectSseInitialFrameAction {
    ContinueBuffering,
    StartClientStream,
}

fn direct_sse_event_provider_failure_source(
    event_type: Option<&str>,
    event: &serde_json::Value,
) -> Option<V3Error01SourceRaised> {
    let event_type = event_type?.trim();
    let error_object = if event_type == "error" {
        event.get("error").unwrap_or(event)
    } else if matches!(
        event_type,
        "response.failed"
            | "response.incomplete"
            | "response.cancelled"
            | "response.canceled"
            | "response.error"
    ) {
        event
            .pointer("/response/error")
            .or_else(|| event.get("error"))
            .unwrap_or(event)
    } else {
        return None;
    };
    let code = error_object
        .get("code")
        .and_then(serde_json::Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .unwrap_or(event_type)
        .to_string();
    let message = error_object
        .get("message")
        .and_then(serde_json::Value::as_str)
        .or_else(|| {
            event
                .pointer("/response/incomplete_details/reason")
                .and_then(serde_json::Value::as_str)
        })
        .or_else(|| event.get("message").and_then(serde_json::Value::as_str))
        .filter(|value| !value.trim().is_empty())
        .unwrap_or("provider response SSE stream reported failure")
        .to_string();
    Some(build_v3_error_01_source_raised(
        V3ErrorSourceKind::ProviderFailure,
        "V3ProviderResp14Raw",
        code,
        message,
    ))
}

fn observed_sse_client_stream(
    stream: V3ProviderSseStream,
    observation_state: V3SseRemoteContinuationObservationState,
) -> V3ClientSseStream {
    struct ObservedState {
        stream: V3ProviderSseStream,
        decoder: SseIncrementalDecoder,
        response_id_candidate: Option<String>,
        observation_state: V3SseRemoteContinuationObservationState,
        done: bool,
    }

    Box::pin(stream::unfold(
        ObservedState {
            stream,
            decoder: SseIncrementalDecoder::new(SseTransportLimits::default()),
            response_id_candidate: None,
            observation_state,
            done: false,
        },
        |mut state| async move {
            if state.done {
                return None;
            }
            match state.stream.next().await {
                Some(Ok(chunk)) => {
                    let result = observe_sse_remote_continuation_chunk(
                        &chunk,
                        &mut state.decoder,
                        &mut state.response_id_candidate,
                        &state.observation_state,
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
                    match decoder.finish().map_err(sse_transport_source) {
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
    chunk: &[u8],
    decoder: &mut SseIncrementalDecoder,
    response_id_candidate: &mut Option<String>,
    observation_state: &V3SseRemoteContinuationObservationState,
) -> Result<(), V3Error01SourceRaised> {
    let frames = decoder
        .push(build_v3_sse_transport_in_01_raw_chunk(chunk))
        .map_err(sse_transport_source)?;
    for frame in frames {
        if let Some(response_id) =
            observe_sse_frame_remote_continuation(frame.frame().fields(), response_id_candidate)?
        {
            observation_state.record_pending_response_id(&response_id)?;
        }
    }
    Ok(())
}

fn observe_sse_remote_continuation_bytes(
    body: &[u8],
) -> Result<V3RemoteContinuationObservation, V3Error01SourceRaised> {
    let mut response_id_candidate = None;
    let mut pending_response_id = None;
    let mut decoder = SseIncrementalDecoder::new(SseTransportLimits::default());
    let frames = decoder
        .push(build_v3_sse_transport_in_01_raw_chunk(body))
        .map_err(sse_transport_source)?;
    for frame in frames {
        if let Some(response_id) = observe_sse_frame_remote_continuation(
            frame.frame().fields(),
            &mut response_id_candidate,
        )? {
            pending_response_id = Some(response_id);
        }
    }
    decoder.finish().map_err(sse_transport_source)?;
    Ok(
        pending_response_id.map_or(V3RemoteContinuationObservation::Terminal, |response_id| {
            V3RemoteContinuationObservation::Pending { response_id }
        }),
    )
}

fn observe_sse_frame_remote_continuation(
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
    let data = data.trim();
    if data.is_empty() || data == "[DONE]" {
        return Ok(None);
    }
    let event: serde_json::Value = serde_json::from_str(data).map_err(|error| {
        build_v3_error_01_source_raised(
            V3ErrorSourceKind::ProviderFailure,
            "V3ProviderResp14Raw",
            "provider_response_sse_event_invalid",
            error.to_string(),
        )
    })?;
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
                build_v3_error_01_source_raised(
                    V3ErrorSourceKind::ProviderFailure,
                    "V3ProviderResp14Raw",
                    "pending_remote_response_id_missing",
                    "pending SSE function call has no response id",
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
                build_v3_error_01_source_raised(
                    V3ErrorSourceKind::ProviderFailure,
                    "V3ProviderResp14Raw",
                    "pending_remote_response_id_missing",
                    "pending SSE continuation has no response id",
                )
            })?;
        return Ok(Some(response_id));
    }
    Ok(None)
}

fn observe_json_remote_continuation(
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
            build_v3_error_01_source_raised(
                V3ErrorSourceKind::ProviderFailure,
                "V3ProviderResp14Raw",
                "pending_remote_response_id_missing",
                "pending Responses continuation has no response id",
            )
        })?;
    Ok(V3RemoteContinuationObservation::Pending {
        response_id: response_id.to_string(),
    })
}

fn provider_body_source(error: V3ProviderError) -> V3Error01SourceRaised {
    build_v3_error_01_source_raised(
        V3ErrorSourceKind::ProviderFailure,
        "V3ProviderResp14Raw",
        "provider_response_body_error",
        error.to_string(),
    )
}

fn sse_transport_source(error: SseTransportError) -> V3Error01SourceRaised {
    build_v3_error_01_source_raised(
        V3ErrorSourceKind::ProviderFailure,
        "V3ProviderResp14Raw",
        "provider_response_sse_invalid",
        error.to_string(),
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
}
