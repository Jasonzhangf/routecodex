use crate::nodes::{V3ClientBody, V3Resp15ClientPayload};
use futures_util::StreamExt;
use routecodex_v3_error::{
    build_v3_error_01_source_raised, V3Error01SourceRaised, V3ErrorSourceKind,
};
use routecodex_v3_provider_responses::{
    V3ProviderError, V3ProviderResp14Raw, V3ProviderResponseBody, V3ProviderSseStream,
};
use sse_transport_core::{
    build_sse_transport_in_01_raw_chunk, SseField, SseIncrementalDecoder, SseTransportError,
    SseTransportLimits,
};
use std::collections::BTreeMap;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum V3RemoteContinuationObservation {
    Pending { response_id: String },
    Terminal,
}

#[derive(Debug, Clone, PartialEq)]
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
    mut stream: V3ProviderSseStream,
) -> Result<(V3ClientBody, V3RemoteContinuationObservation), V3Error01SourceRaised> {
    let mut client_bytes = Vec::new();
    let mut pending_response_id = None;
    let mut decoder = SseIncrementalDecoder::new(SseTransportLimits::default());
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(provider_body_source)?;
        client_bytes.extend_from_slice(&chunk);
        let frames = decoder
            .push(build_sse_transport_in_01_raw_chunk(&chunk))
            .map_err(sse_transport_source)?;
        for frame in frames {
            observe_sse_frame_remote_continuation(
                frame.frame().fields(),
                &mut pending_response_id,
            )?;
        }
    }
    decoder.finish().map_err(sse_transport_source)?;
    Ok((
        V3ClientBody::Bytes(client_bytes),
        pending_response_id.map_or(V3RemoteContinuationObservation::Terminal, |response_id| {
            V3RemoteContinuationObservation::Pending { response_id }
        }),
    ))
}

fn observe_sse_remote_continuation_bytes(
    body: &[u8],
) -> Result<V3RemoteContinuationObservation, V3Error01SourceRaised> {
    let mut pending_response_id = None;
    let mut decoder = SseIncrementalDecoder::new(SseTransportLimits::default());
    let frames = decoder
        .push(build_sse_transport_in_01_raw_chunk(body))
        .map_err(sse_transport_source)?;
    for frame in frames {
        observe_sse_frame_remote_continuation(frame.frame().fields(), &mut pending_response_id)?;
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
    pending_response_id: &mut Option<String>,
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
    let data = data.trim();
    if data.is_empty() || data == "[DONE]" {
        return Ok(());
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
    if let V3RemoteContinuationObservation::Pending { response_id } =
        observe_json_remote_continuation(semantic)?
    {
        *pending_response_id = Some(response_id);
    }
    if matches!(
        event
            .pointer("/item/type")
            .and_then(serde_json::Value::as_str),
        Some("function_call" | "custom_tool_call")
    ) {
        *pending_response_id = event
            .get("response_id")
            .and_then(serde_json::Value::as_str)
            .map(ToOwned::to_owned)
            .or_else(|| pending_response_id.take());
    }
    Ok(())
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
}
