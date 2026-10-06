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
        // A Chat-wire provider terminal carries no reason RouteCodex may judge:
        // `content_filter` is the provider's own content filter having done its
        // job, and the client projection owns the Chat -> target mapping. A
        // provider/transport failure is classified by its own owner, not here.
        V3HubProviderWireProtocol::OpenAiChat => None,
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
    if event_type != Some("response.incomplete") && status != Some("incomplete") {
        return None;
    }
    let reason = payload
        .pointer("/response/incomplete_details/reason")
        .or_else(|| payload.pointer("/incomplete_details/reason"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|reason| !reason.is_empty())
        .unwrap_or("unknown");
    if responses_incomplete_reason_is_admitted_terminal(reason) {
        return None;
    }
    Some(reason)
}

/// A Responses-wire provider reports its own output cap with the standard
/// `response.incomplete` + `max_output_tokens` terminal. That is the same
/// output-cap semantic as the Chat aliases and the Anthropic `max_tokens` stop
/// reason, i.e. valid partial output, so it must not enter the provider
/// failure/cooldown path on any entry.
pub(crate) fn responses_incomplete_reason_is_output_cap(reason: &str) -> bool {
    reason.trim() == "max_output_tokens"
}

/// Reasons a provider may legitimately report on its own `response.incomplete`
/// terminal. They are business/terminal semantics, not provider failure:
/// `max_output_tokens` is the output cap (valid partial output), and
/// `content_filter` is the provider's own allow/deny content filter having done
/// its job. RouteCodex must not judge either reason as an unhealthy provider,
/// cool the provider, or switch away from it; the terminal is forwarded to the
/// client as-is. Unknown or missing reasons stay provider failures because the
/// client projection cannot represent them. The provider health probe reuses
/// this owner so a probe that lands on an admitted terminal still clears
/// cooldown.
pub(crate) fn responses_incomplete_reason_is_admitted_terminal(reason: &str) -> bool {
    let reason = reason.trim();
    responses_incomplete_reason_is_output_cap(reason) || reason == "content_filter"
}

/// Chat output-cap terminals, including gateway aliases such as `max_tokens`,
/// are valid partial output. They must not enter the provider failure/cooldown
/// path; the Responses client projection represents them as `incomplete`.
pub(crate) fn openai_chat_finish_reason_is_output_cap(reason: &str) -> bool {
    matches!(reason, "length" | "max_tokens" | "max_output_tokens")
}

fn anthropic_incomplete_reason(payload: &Value) -> Option<&str> {
    let stop_reason = payload
        .get("stop_reason")
        .or_else(|| payload.pointer("/delta/stop_reason"))
        .and_then(Value::as_str);
    match stop_reason {
        // Anthropic `max_tokens` is the output-cap terminal, i.e. the same
        // valid partial output as the Chat aliases handled above. Rejecting it
        // here would send a representable truncation into the provider
        // failure/cooldown/switch path and surface a transport error to a
        // client that should have received `incomplete`.
        Some("max_tokens") => return None,
        // `refusal` is the model declining to answer, i.e. a terminal response
        // semantic, not a provider failure. The client projection renders it as
        // `incomplete` + `incomplete_details.reason=content_filter`.
        Some("refusal") => return None,
        _ => {}
    }
    if payload.get("status").and_then(Value::as_str) != Some("incomplete") {
        return None;
    }
    let reason = payload
        .pointer("/incomplete_details/reason")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|reason| !reason.is_empty())
        .unwrap_or("unknown");
    if responses_incomplete_reason_is_admitted_terminal(reason) {
        return None;
    }
    Some(reason)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn rejects_unrepresentable_incomplete_terminal_shapes() {
        for (protocol, payload, reason) in [
            (
                V3HubProviderWireProtocol::Responses,
                json!({
                    "type": "response.incomplete",
                    "response": {
                        "status": "incomplete",
                        "incomplete_details": {"reason": "mystery"}
                    }
                }),
                "mystery",
            ),
            (
                V3HubProviderWireProtocol::Responses,
                json!({"type": "response.incomplete", "response": {"status": "incomplete"}}),
                "unknown",
            ),
            (
                V3HubProviderWireProtocol::Anthropic,
                json!({"type": "message", "status": "incomplete"}),
                "unknown",
            ),
        ] {
            let failure = classify_v3_provider_terminal_admission(protocol, &payload)
                .expect("an unrepresentable incomplete terminal is a provider failure");
            assert_eq!(
                failure.message,
                format!("provider response ended before completion: {reason}")
            );
        }
    }

    #[test]
    fn admits_content_filter_terminal_as_provider_business_terminal() {
        // `content_filter` is the provider's own allow/deny content filter having
        // done its job. It is terminal response semantics, not a provider
        // failure: cooling the provider or switching away would drop a
        // representable terminal that the client projection already renders.
        for (protocol, payload) in [
            (
                V3HubProviderWireProtocol::Responses,
                json!({
                    "type": "response.incomplete",
                    "response": {
                        "status": "incomplete",
                        "incomplete_details": {"reason": "content_filter"}
                    }
                }),
            ),
            (
                V3HubProviderWireProtocol::Responses,
                json!({
                    "status": "incomplete",
                    "incomplete_details": {"reason": " content_filter "}
                }),
            ),
            (
                V3HubProviderWireProtocol::OpenAiChat,
                json!({"choices": [{"finish_reason": "content_filter"}]}),
            ),
            (
                V3HubProviderWireProtocol::Anthropic,
                json!({"type": "message", "stop_reason": "refusal"}),
            ),
            (
                V3HubProviderWireProtocol::Anthropic,
                json!({"type": "message_delta", "delta": {"stop_reason": "refusal"}}),
            ),
            (
                V3HubProviderWireProtocol::Anthropic,
                json!({
                    "type": "message",
                    "status": "incomplete",
                    "incomplete_details": {"reason": "content_filter"}
                }),
            ),
        ] {
            assert_eq!(
                classify_v3_provider_terminal_admission(protocol, &payload),
                None,
                "content_filter terminal must be admitted for {protocol:?}"
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
                V3HubProviderWireProtocol::OpenAiChat,
                json!({"choices": [{"finish_reason": "max_tokens"}]}),
            ),
            (
                V3HubProviderWireProtocol::Anthropic,
                json!({"type": "message", "stop_reason": "end_turn"}),
            ),
            (
                V3HubProviderWireProtocol::Anthropic,
                json!({"type": "message", "stop_reason": "tool_use"}),
            ),
            // Anthropic `max_tokens` is the output-cap terminal. It is valid
            // partial output, exactly like the Chat aliases above, and the
            // Responses projection already renders it as `incomplete` +
            // `incomplete_details.reason=max_output_tokens`.
            (
                V3HubProviderWireProtocol::Anthropic,
                json!({"type": "message", "stop_reason": "max_tokens"}),
            ),
            (
                V3HubProviderWireProtocol::Anthropic,
                json!({"type": "message_delta", "delta": {"stop_reason": "max_tokens"}}),
            ),
            // A Responses-wire provider reports its own output cap with the
            // standard `response.incomplete` + `max_output_tokens` terminal.
            // That is the same output-cap semantic as the Chat aliases and the
            // Anthropic `max_tokens` stop reason above, so it is valid partial
            // output and must be admitted on every entry.
            (
                V3HubProviderWireProtocol::Responses,
                json!({
                    "status": "incomplete",
                    "incomplete_details": {"reason": "max_output_tokens"},
                    "usage": {"input_tokens": 12, "output_tokens": 2, "total_tokens": 14}
                }),
            ),
            (
                V3HubProviderWireProtocol::Responses,
                json!({
                    "type": "response.incomplete",
                    "response": {
                        "status": "incomplete",
                        "incomplete_details": {"reason": "max_output_tokens"}
                    }
                }),
            ),
        ] {
            assert_eq!(
                classify_v3_provider_terminal_admission(protocol, &payload),
                None
            );
        }
    }
}
