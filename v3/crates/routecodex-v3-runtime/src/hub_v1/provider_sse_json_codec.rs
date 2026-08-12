use routecodex_v3_sse::SseField;
use serde_json::Value;

use super::V3RuntimeStreamObservation;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum V3ProviderResponsesJsonFrameOutcome {
    ContinueBuffering,
    StartClientStream,
    Terminal,
    Failure { code: String, message: String },
}

pub(crate) fn parse_v3_provider_sse_json_data(data: &str) -> Result<Option<Value>, String> {
    let data = data.trim();
    if data.is_empty() || data == "[DONE]" {
        return Ok(None);
    }
    serde_json::from_str(data)
        .map(Some)
        .map_err(|error| format!("provider SSE JSON payload is malformed: {error}"))
}

pub(crate) fn classify_v3_provider_responses_json_data(
    data: &str,
) -> Result<Option<V3ProviderResponsesJsonFrameOutcome>, String> {
    let Some(event) = parse_v3_provider_sse_json_data(data)? else {
        return Ok(None);
    };
    classify_v3_provider_responses_json_event(&event).map(Some)
}

pub(crate) fn classify_v3_provider_generic_sse_json_data(
    data: &str,
) -> Result<Option<V3ProviderResponsesJsonFrameOutcome>, String> {
    let Some(event) = parse_v3_provider_sse_json_data(data)? else {
        return Ok(None);
    };
    if event
        .get("type")
        .and_then(Value::as_str)
        .map(str::trim)
        .is_some_and(|value| !value.is_empty())
    {
        return classify_v3_provider_responses_json_event(&event).map(Some);
    }
    let is_openai_chat_chunk = event
        .get("choices")
        .and_then(Value::as_array)
        .is_some()
        && event
            .get("object")
            .and_then(Value::as_str)
            .is_some_and(|value| value == "chat.completion.chunk");
    if !is_openai_chat_chunk {
        return Err("provider generic SSE JSON event requires a recognized event shape".to_string());
    }
    Ok(Some(V3ProviderResponsesJsonFrameOutcome::StartClientStream))
}

pub(crate) fn classify_v3_provider_responses_json_event(
    event: &Value,
) -> Result<V3ProviderResponsesJsonFrameOutcome, String> {
    let event_type = event
        .get("type")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "provider Responses JSON event requires a non-empty type".to_string())?;

    if matches!(event_type, "error" | "response.error") {
        let error = event
            .get("error")
            .and_then(Value::as_object)
            .unwrap_or_else(|| event.as_object().expect("JSON event is an object"));
        let code = error
            .get("code")
            .or_else(|| error.get("type"))
            .and_then(Value::as_str)
            .unwrap_or(event_type);
        let message = error
            .get("message")
            .or_else(|| error.get("detail"))
            .and_then(Value::as_str)
            .unwrap_or("provider emitted a JSON error event");
        return Ok(V3ProviderResponsesJsonFrameOutcome::Failure {
            code: code.to_string(),
            message: message.to_string(),
        });
    }

    if event_type == "response.incomplete" {
        if let Some(reason) = event
            .pointer("/response/incomplete_details/reason")
            .or_else(|| event.pointer("/incomplete_details/reason"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            return Ok(V3ProviderResponsesJsonFrameOutcome::Failure {
                code: "response_incomplete".to_string(),
                message: reason.to_string(),
            });
        }
    }

    if matches!(
        event_type,
        "response.failed" | "response.incomplete" | "response.cancelled" | "response.canceled"
    ) {
        let error = event
            .pointer("/response/error")
            .or_else(|| event.get("error"))
            .and_then(Value::as_object)
            .ok_or_else(|| format!("{event_type} requires a response error object"))?;
        let code = error
            .get("code")
            .or_else(|| error.get("type"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| format!("{event_type} requires a non-empty error code"))?;
        let message = error
            .get("message")
            .or_else(|| error.get("detail"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| format!("{event_type} requires a non-empty error message"))?;
        return Ok(V3ProviderResponsesJsonFrameOutcome::Failure {
            code: code.to_string(),
            message: message.to_string(),
        });
    }

    if event_type == "response.completed" {
        return Ok(V3ProviderResponsesJsonFrameOutcome::Terminal);
    }
    if matches!(event_type, "response.created" | "response.in_progress") {
        return Ok(V3ProviderResponsesJsonFrameOutcome::ContinueBuffering);
    }
    Ok(V3ProviderResponsesJsonFrameOutcome::StartClientStream)
}

pub(crate) fn record_v3_provider_sse_json_frame(
    fields: &[SseField],
    stream_observation: &V3RuntimeStreamObservation,
) -> Result<(), String> {
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
    let Some(event) = parse_v3_provider_sse_json_data(&data)? else {
        return Ok(());
    };
    if let Some(field) =
        routecodex_v3_provider_responses::find_v3_routecodex_control_payload_key(&event)
    {
        return Err(format!(
            "provider SSE event carries RouteCodex control payload key {field:?}"
        ));
    }
    stream_observation.record_provider_event_json(&event)
}

#[cfg(test)]
mod provider_sse_json_codec_tests {
    use super::*;

    #[test]
    fn json_type_is_the_only_semantic_source() {
        let outcome = classify_v3_provider_responses_json_data(
            r#"{"type":"response.completed","response":{"id":"resp_1"}}"#,
        )
        .expect("JSON type must classify terminal data");
        assert_eq!(outcome, Some(V3ProviderResponsesJsonFrameOutcome::Terminal));
    }

    #[test]
    fn json_error_events_are_provider_failures_before_stream_commit() {
        for event_type in ["error", "response.error"] {
            let data = format!(
                r#"{{"type":"{event_type}","error":{{"code":"upstream_error","message":"bad upstream"}}}}"#
            );
            assert_eq!(
                classify_v3_provider_generic_sse_json_data(&data)
                    .expect("JSON error event must classify"),
                Some(V3ProviderResponsesJsonFrameOutcome::Failure {
                    code: "upstream_error".to_string(),
                    message: "bad upstream".to_string(),
                })
            );
        }
    }

    #[test]
    fn missing_type_without_frame_event_still_fails_fast() {
        let error = classify_v3_provider_responses_json_data(r#"{"id":"resp_1"}"#)
            .expect_err("data without type must fail fast");
        assert!(
            error.contains("requires a non-empty type"),
            "unexpected error: {error}"
        );
    }

    #[test]
    fn generic_classifier_accepts_openai_chat_chunk_without_type() {
        let outcome = classify_v3_provider_generic_sse_json_data(
            r#"{"id":"chatcmpl_1","object":"chat.completion.chunk","choices":[]}"#,
        )
        .expect("OpenAI Chat chunks do not require a Responses type");
        assert_eq!(
            outcome,
            Some(V3ProviderResponsesJsonFrameOutcome::StartClientStream)
        );
    }

    #[test]
    fn generic_classifier_rejects_unrecognized_json_without_type() {
        let error = classify_v3_provider_generic_sse_json_data(r#"{"id":"resp_1"}"#)
            .expect_err("generic provider JSON must have a recognized shape");
        assert!(error.contains("recognized event shape"));
    }

    #[test]
    fn generic_classifier_rejects_malformed_chat_choices_shape() {
        for payload in [
            r#"{"object":"chat.completion.chunk","choices":null}"#,
            r#"{"object":"chat.completion.chunk","choices":{}}"#,
        ] {
            let error = classify_v3_provider_generic_sse_json_data(payload)
                .expect_err("malformed Chat choices must fail before stream commit");
            assert!(error.contains("recognized event shape"));
        }
    }
}
