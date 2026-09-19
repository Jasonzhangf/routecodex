use super::V3HubProviderWireProtocol;
use serde_json::Value;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct V3ProviderTerminalAdmissionFailure {
    pub(crate) code: String,
    pub(crate) message: String,
}

pub(crate) fn classify_v3_provider_terminal_admission(
    provider_protocol: V3HubProviderWireProtocol,
    payload: &Value,
) -> Option<V3ProviderTerminalAdmissionFailure> {
    let reason = match provider_protocol {
        V3HubProviderWireProtocol::Responses => responses_incomplete_reason(payload),
        V3HubProviderWireProtocol::OpenAiChat => openai_chat_incomplete_reason(payload),
        V3HubProviderWireProtocol::Anthropic => anthropic_incomplete_reason(payload),
        V3HubProviderWireProtocol::Gemini => None,
    }?;
    Some(V3ProviderTerminalAdmissionFailure {
        code: format!("provider_response_incomplete_{reason}"),
        message: format!("provider response ended before completion: {reason}"),
    })
}

fn responses_incomplete_reason(payload: &Value) -> Option<&str> {
    let event_type = payload.get("type").and_then(Value::as_str);
    let status = payload
        .pointer("/response/status")
        .or_else(|| payload.get("status"))
        .and_then(Value::as_str);
    (event_type == Some("response.incomplete") || status == Some("incomplete")).then(|| {
        payload
            .pointer("/response/incomplete_details/reason")
            .or_else(|| payload.pointer("/incomplete_details/reason"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|reason| !reason.is_empty())
            .unwrap_or("unknown")
    })
}

fn openai_chat_incomplete_reason(payload: &Value) -> Option<&str> {
    payload
        .get("choices")
        .and_then(Value::as_array)?
        .iter()
        .find_map(
            |choice| match choice.get("finish_reason").and_then(Value::as_str) {
                Some("length") => Some("length"),
                Some("content_filter") => Some("content_filter"),
                _ => None,
            },
        )
}

fn anthropic_incomplete_reason(payload: &Value) -> Option<&str> {
    let stop_reason = payload
        .get("stop_reason")
        .or_else(|| payload.pointer("/delta/stop_reason"))
        .and_then(Value::as_str);
    if stop_reason == Some("max_tokens") {
        return Some("max_tokens");
    }
    let status = payload.get("status").and_then(Value::as_str);
    (status == Some("incomplete")).then(|| {
        payload
            .pointer("/incomplete_details/reason")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|reason| !reason.is_empty())
            .unwrap_or("unknown")
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn rejects_registered_incomplete_terminal_shapes() {
        for (protocol, payload, reason) in [
            (
                V3HubProviderWireProtocol::Responses,
                json!({
                    "status": "incomplete",
                    "incomplete_details": {"reason": "max_output_tokens"},
                    "usage": {"input_tokens": 12, "output_tokens": 2, "total_tokens": 14}
                }),
                "max_output_tokens",
            ),
            (
                V3HubProviderWireProtocol::Responses,
                json!({
                    "type": "response.incomplete",
                    "response": {
                        "status": "incomplete",
                        "incomplete_details": {"reason": "content_filter"}
                    }
                }),
                "content_filter",
            ),
            (
                V3HubProviderWireProtocol::OpenAiChat,
                json!({"choices": [{"finish_reason": "length"}]}),
                "length",
            ),
            (
                V3HubProviderWireProtocol::OpenAiChat,
                json!({"choices": [{"finish_reason": "content_filter"}]}),
                "content_filter",
            ),
            (
                V3HubProviderWireProtocol::Anthropic,
                json!({"type": "message", "stop_reason": "max_tokens"}),
                "max_tokens",
            ),
            (
                V3HubProviderWireProtocol::Anthropic,
                json!({"type": "message_delta", "delta": {"stop_reason": "max_tokens"}}),
                "max_tokens",
            ),
        ] {
            let failure = classify_v3_provider_terminal_admission(protocol, &payload)
                .expect("incomplete terminal must not be admitted as provider success");
            assert_eq!(
                failure.message,
                format!("provider response ended before completion: {reason}")
            );
        }
    }

    #[test]
    fn admits_completed_and_tool_terminal_shapes() {
        for (protocol, payload) in [
            (
                V3HubProviderWireProtocol::Responses,
                json!({"status": "completed", "output": []}),
            ),
            (
                V3HubProviderWireProtocol::OpenAiChat,
                json!({"choices": [{"finish_reason": "stop"}]}),
            ),
            (
                V3HubProviderWireProtocol::OpenAiChat,
                json!({"choices": [{"finish_reason": "tool_calls"}]}),
            ),
            (
                V3HubProviderWireProtocol::Anthropic,
                json!({"type": "message", "stop_reason": "end_turn"}),
            ),
            (
                V3HubProviderWireProtocol::Anthropic,
                json!({"type": "message", "stop_reason": "tool_use"}),
            ),
        ] {
            assert_eq!(
                classify_v3_provider_terminal_admission(protocol, &payload),
                None
            );
        }
    }
}
