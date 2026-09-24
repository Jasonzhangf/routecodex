use super::{
    has_non_empty_string, is_v3_provider_sse_transport_keepalive_event_type,
    response_message_part_has_client_output, response_output_item_has_client_output,
    response_terminal_has_client_output, V3ProviderResponsesJsonFrameOutcome,
};
use serde_json::Value;

pub(crate) fn classify_v3_provider_responses_json_event(
    event: &Value,
) -> Result<V3ProviderResponsesJsonFrameOutcome, String> {
    let event_type = event
        .get("type")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "provider Responses JSON event requires a non-empty type".to_string())?;

    // Provider keepalive frames are transport-only. They are consumed here
    // before the protocol event registry so an upstream `event: keepalive`
    // frame cannot be misclassified as an unknown business event.
    if is_v3_provider_sse_transport_keepalive_event_type(event_type) {
        return Ok(V3ProviderResponsesJsonFrameOutcome::ContinueBuffering);
    }

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

    if let Some(failure) = crate::hub_v1::classify_v3_provider_terminal_admission(
        crate::hub_v1::V3HubProviderWireProtocol::Responses,
        event,
    ) {
        return Ok(V3ProviderResponsesJsonFrameOutcome::Failure {
            code: failure.code,
            message: failure.message,
        });
    }

    if matches!(
        event_type,
        "response.failed" | "response.cancelled" | "response.canceled"
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
        return Ok(if response_terminal_has_client_output(event)? {
            V3ProviderResponsesJsonFrameOutcome::Terminal
        } else {
            V3ProviderResponsesJsonFrameOutcome::TerminalWithoutOutput
        });
    }
    if matches!(event_type, "response.created" | "response.in_progress") {
        return Ok(V3ProviderResponsesJsonFrameOutcome::ContinueBuffering);
    }
    if matches!(
        event_type,
        "response.output_item.added" | "response.output_item.done"
    ) {
        let item = event
            .get("item")
            .ok_or_else(|| format!("{event_type} requires an item object"))?;
        return Ok(if response_output_item_has_client_output(item)? {
            V3ProviderResponsesJsonFrameOutcome::StartClientStream
        } else {
            V3ProviderResponsesJsonFrameOutcome::ContinueBuffering
        });
    }
    if matches!(
        event_type,
        "response.content_part.added" | "response.content_part.done"
    ) {
        let part = event
            .get("part")
            .ok_or_else(|| format!("{event_type} requires a part object"))?;
        return Ok(if response_message_part_has_client_output(part)? {
            V3ProviderResponsesJsonFrameOutcome::StartClientStream
        } else {
            V3ProviderResponsesJsonFrameOutcome::ContinueBuffering
        });
    }
    if matches!(
        event_type,
        "response.output_text.delta"
            | "response.output_text.done"
            | "response.refusal.delta"
            | "response.refusal.done"
            | "response.reasoning_text.delta"
            | "response.reasoning_text.done"
            | "response.reasoning_summary_text.delta"
            | "response.reasoning_summary_text.done"
            | "response.function_call_arguments.delta"
            | "response.function_call_arguments.done"
            | "response.custom_tool_call_input.delta"
            | "response.custom_tool_call_input.done"
            | "response.mcp_call.arguments.delta"
            | "response.mcp_call.arguments.done"
            | "response.code_interpreter_call_code.delta"
            | "response.code_interpreter_call_code.done"
            | "response.audio.delta"
            | "response.audio_transcript.delta"
            | "response.audio_transcript.done"
    ) {
        let has_output = [
            "delta",
            "text",
            "refusal",
            "arguments",
            "input",
            "code",
            "transcript",
        ]
        .iter()
        .any(|field| has_non_empty_string(event.get(*field)));
        return Ok(if has_output {
            V3ProviderResponsesJsonFrameOutcome::StartClientStream
        } else {
            V3ProviderResponsesJsonFrameOutcome::ContinueBuffering
        });
    }
    if event_type == "response.requires_action" {
        if event.get("required_action").is_none()
            && event.pointer("/response/required_action").is_none()
        {
            return Err("response.requires_action requires required_action".to_string());
        }
        return Ok(V3ProviderResponsesJsonFrameOutcome::StartClientStream);
    }
    if matches!(
        event_type,
        "response.reasoning_signature.delta"
            | "response.reasoning_image.delta"
            | "response.reasoning_summary_part.added"
            | "response.reasoning_summary_part.done"
            | "response.output_text.annotation.added"
            | "response.web_search_call.in_progress"
            | "response.web_search_call.searching"
            | "response.web_search_call.completed"
            | "response.file_search_call.in_progress"
            | "response.file_search_call.searching"
            | "response.file_search_call.completed"
            | "response.mcp_call.in_progress"
            | "response.mcp_call.completed"
            | "response.computer_call.in_progress"
            | "response.computer_call_output.in_progress"
            | "response.computer_call_output.completed"
            | "response.code_interpreter_call.in_progress"
            | "response.code_interpreter_call.completed"
            | "response.image_generation_call.in_progress"
            | "response.image_generation_call.partial_image"
            | "response.image_generation_call.completed"
            | "response.audio.done"
            | "response.done"
    ) {
        return Ok(V3ProviderResponsesJsonFrameOutcome::ContinueBuffering);
    }
    // Provider-owned events are valid only when registered in the protocol
    // conversion tables. Keep the complete frame available for normalization
    // and observation, but do not abort before its registered terminal event.
    let registered_event = crate::protocol_tables::map_value(
        crate::protocol_tables::V3TableKind::ProviderResponseEvent,
        "responses",
        event_type,
        crate::protocol_tables::V3TableDirection::Inbound,
    )?;
    if registered_event.is_some() {
        return Ok(V3ProviderResponsesJsonFrameOutcome::ContinueBuffering);
    }
    Err(format!(
        "provider Responses SSE event type {event_type:?} is not registered"
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn transport_keepalive_is_not_rejected_as_unknown_event() {
        for event_type in ["ping", "pong", "keepalive", "keep-alive", "heartbeat"] {
            let outcome = classify_v3_provider_responses_json_event(
                &serde_json::json!({"type": event_type, "heartbeat": true}),
            )
            .expect("transport keepalive must be accepted");
            assert_eq!(
                outcome,
                V3ProviderResponsesJsonFrameOutcome::ContinueBuffering
            );
        }
    }
}
