use serde_json::Value;
use std::sync::LazyLock;

use super::provider_sse_json_codec::has_non_empty_string;
use super::V3HubProviderWireProtocol;
use futures_util::StreamExt;

static VISIBLE_TEXT_PATTERN: LazyLock<regex::Regex> = LazyLock::new(|| {
    regex::Regex::new(r"[^\p{White_Space}\p{Cc}\p{Default_Ignorable_Code_Point}]")
        .expect("visible-text Unicode property expression must compile")
});

pub(super) fn observe_v3_provider_sse(
    stream: routecodex_v3_provider_responses::V3ProviderSseStream,
    observation: super::V3RuntimeStreamObservation,
    protocol: V3HubProviderWireProtocol,
    request_id: String,
    provider_id: String,
) -> routecodex_v3_provider_responses::V3ProviderSseStream {
    let mut decoder = routecodex_v3_sse::SseIncrementalDecoder::new(
        routecodex_v3_sse::SseTransportLimits::default(),
    );
    Box::pin(stream.map(move |item| {
        if let Ok(chunk) = &item {
            if let Err(error) = observation.record_provider_raw_sse_chunk(chunk) {
                if let Err(receipt_error) = observation.record_observation_error(&format!(
                    "provider_raw_sse_observation_failed: {error}"
                )) {
                    eprintln!("V3 runtime observation failure could not be recorded: {receipt_error}; original: {error}");
                }
            }
            let facts = (|| -> Result<(), String> {
                let frames = decoder.push(routecodex_v3_sse::build_v3_sse_transport_in_01_raw_chunk(chunk))
                    .map_err(|error| error.to_string())?;
                for frame in frames {
                    if super::is_v3_provider_sse_transport_keepalive_frame(frame.frame().fields()) {
                        continue;
                    }
                    let data = super::normalize_v3_provider_sse_json_data_for_event_name(protocol, frame.frame().fields())?;
                    if let Some(event) = super::parse_v3_provider_sse_json_data(&data)? {
                        observation.record_provider_business_content(
                            v3_provider_event_has_deliverable_business_content(protocol, &event),
                        )?;
                    }
                }
                Ok(())
            })();
            if let Err(reason) = facts {
                return Err(routecodex_v3_provider_responses::V3ProviderError::ResponseBody {
                    request_id: request_id.clone(), provider_id: provider_id.clone(),
                    reason,
                });
            }
        }
        item
    }))
}

/// Shared "complete provider attempt carries deliverable business content"
/// judgment for the Relay and Direct success-acceptance boundaries.
///
/// This is the single owner of the empty-attempt classification. It reads the
/// fully materialized canonical provider response (already accumulated for the
/// whole attempt) and returns `true` when the attempt carries text, a tool
/// call, refusal, reasoning, audio, a legal `content_filter` terminal, or
/// another representable business output. Envelope-only fields (`id`, `model`,
/// `role`, `status`, `usage`, empty containers, a plain `end_turn`) do not
/// count.
///
/// Each protocol supplies business facts. Missing output containers and
/// envelope-only objects do not establish a business result.
pub(crate) fn v3_provider_attempt_has_deliverable_business_content(
    protocol: V3HubProviderWireProtocol,
    response: &Value,
) -> bool {
    match protocol {
        // The Anthropic materializer already projects the complete message to a
        // canonical Responses response, so it shares the Responses adapter.
        V3HubProviderWireProtocol::Responses | V3HubProviderWireProtocol::Anthropic => {
            v3_responses_attempt_has_deliverable_business_content(response)
        }
        V3HubProviderWireProtocol::OpenAiChat => {
            v3_openai_chat_attempt_has_deliverable_business_content(response)
        }
        // Gemini is a real provider protocol on the Relay/Direct JSON and Direct
        // SSE boundaries, so it is judged from the Gemini codec facts rather than
        // a blanket "always deliverable".
        V3HubProviderWireProtocol::Gemini => {
            v3_gemini_attempt_has_deliverable_business_content(response)
        }
    }
}

/// Gemini business content lives in `candidates[].content.parts[]`. This mirrors
/// the Gemini codec's own `has_output` facts (`text`, `functionCall`,
/// `inlineData`, `executableCode`, `codeExecutionResult`). Explicit provider
/// filtering is also a business result; usage alone is not.
pub(crate) fn v3_gemini_prompt_feedback_is_terminal(response: &Value) -> bool {
    super::gemini_terminal_semantics::prompt_block_reason(response).is_some()
}

/// The declared Gemini `finishReason` values that mean the provider filtered
/// the candidate. The terminal interpreter owns the filter-reason set, shared
/// by the business-content judgment and the response codec.
pub(crate) fn v3_gemini_candidate_finish_reason_is_filter(finish_reason: Option<&str>) -> bool {
    super::gemini_terminal_semantics::candidate_finish_reason_is_filter(finish_reason)
}

pub(crate) fn v3_gemini_attempt_has_deliverable_business_content(response: &Value) -> bool {
    if v3_gemini_prompt_feedback_is_terminal(response) {
        return true;
    }
    let Some(candidates) = response.get("candidates").and_then(Value::as_array) else {
        return false;
    };
    candidates.iter().any(|candidate| {
        super::gemini_terminal_semantics::candidate_finish_reason_has_business_outcome(
            candidate.get("finishReason").and_then(Value::as_str),
        ) || candidate
            .get("content")
            .and_then(|content| content.get("parts"))
            .and_then(Value::as_array)
            .is_some_and(|parts| parts.iter().any(v3_gemini_part_has_deliverable_content))
    })
}

fn v3_gemini_part_has_deliverable_content(part: &Value) -> bool {
    has_non_empty_string(part.get("text"))
        || part
            .get("functionCall")
            .and_then(Value::as_object)
            .is_some_and(|call| !call.is_empty())
        || part
            .get("inlineData")
            .and_then(Value::as_object)
            .is_some_and(|data| !data.is_empty())
        || part
            .get("executableCode")
            .and_then(Value::as_object)
            .is_some_and(|code| !code.is_empty())
        || part
            .get("codeExecutionResult")
            .and_then(Value::as_object)
            .is_some_and(|result| !result.is_empty())
        || part.as_object().is_some_and(|row| {
            row.iter().any(|(key, value)| {
                !matches!(
                    key.as_str(),
                    "text"
                        | "functionCall"
                        | "inlineData"
                        | "executableCode"
                        | "codeExecutionResult"
                        | "thought"
                ) && opaque_gemini_value_has_content(value)
            })
        })
}

fn opaque_gemini_value_has_content(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::String(text) => !text.is_empty(),
        Value::Array(values) => values.iter().any(opaque_gemini_value_has_content),
        Value::Object(row) => row.values().any(opaque_gemini_value_has_content),
        Value::Bool(_) | Value::Number(_) => true,
    }
}

/// Typed internal 502 for a complete provider attempt with no deliverable
/// business content. It is classified by the Error chain (Error01-06) and the
/// existing candidate policy; it is never projected to the model client.
pub(crate) fn empty_provider_attempt_failure(
    protocol: V3HubProviderWireProtocol,
) -> crate::hub_v1::V3ResponsesRelayRuntimeError {
    crate::hub_v1::V3ResponsesRelayRuntimeError::ProviderResponseSemanticFailure {
        status: 502,
        code: "provider_response_empty".to_string(),
        message: format!(
            "provider returned a complete {protocol:?} response with no deliverable business content"
        ),
    }
}

/// Complete-attempt judgment for a buffered provider JSON body on the Direct
/// path. Unlike the Relay materializer, Direct does not project the Anthropic
/// Messages object into the canonical Responses shape before admission, so the
/// raw Anthropic shape is accepted here as well. Responses and Chat share the
/// canonical adapters used by Relay.
pub(crate) fn v3_provider_json_attempt_has_deliverable_business_content(
    protocol: V3HubProviderWireProtocol,
    response: &Value,
) -> bool {
    if protocol == V3HubProviderWireProtocol::Anthropic
        && response.get("content").is_some()
        && response.get("output").is_none()
    {
        return v3_anthropic_message_has_deliverable_business_content(response);
    }
    v3_provider_attempt_has_deliverable_business_content(protocol, response)
}

/// Business facts from a single validated provider event. The attempt owner
/// accumulates these monotonically, without retaining a second payload copy.
pub(crate) fn v3_provider_event_has_deliverable_business_content(
    protocol: V3HubProviderWireProtocol,
    event: &Value,
) -> bool {
    match protocol {
        V3HubProviderWireProtocol::Responses => match event.get("type").and_then(Value::as_str) {
            Some(
                "response.output_text.delta"
                | "response.reasoning_text.delta"
                | "response.reasoning_summary_text.delta"
                | "response.refusal.delta",
            ) => has_non_empty_string(event.get("delta")),
            Some(
                "response.output_text.done"
                | "response.reasoning_text.done"
                | "response.reasoning_summary_text.done",
            ) => has_non_empty_string(event.get("text")),
            Some("response.output_item.added" | "response.output_item.done") => event
                .get("item")
                .is_some_and(v3_responses_output_item_has_deliverable_content),
            Some("response.content_part.added" | "response.content_part.done") => {
                event.get("part").is_some_and(business_part_has_content)
            }
            Some("response.completed" | "response.incomplete" | "response.done") => event
                .get("response")
                .is_some_and(v3_responses_attempt_has_deliverable_business_content),
            _ => false,
        },
        V3HubProviderWireProtocol::Anthropic => match event.get("type").and_then(Value::as_str) {
            Some("message_start") => event
                .get("message")
                .is_some_and(v3_anthropic_message_has_deliverable_business_content),
            Some("content_block_start") => event
                .get("content_block")
                .is_some_and(v3_anthropic_content_block_has_deliverable_content),
            Some("content_block_delta") => event.get("delta").is_some_and(|delta| {
                ["text", "thinking", "partial_json", "signature"]
                    .iter()
                    .any(|field| has_non_empty_string(delta.get(*field)))
                    || delta.get("citation").is_some()
            }),
            Some("message_delta") => event.get("delta").is_some_and(anthropic_refusal),
            _ => false,
        },
        V3HubProviderWireProtocol::OpenAiChat => event
            .get("choices")
            .and_then(Value::as_array)
            .is_some_and(|choices| {
                choices.iter().any(|choice| {
                    choice.get("finish_reason").and_then(Value::as_str) == Some("content_filter")
                        || choice
                            .get("delta")
                            .is_some_and(v3_openai_chat_message_has_deliverable_content)
                })
            }),
        V3HubProviderWireProtocol::Gemini => {
            v3_gemini_attempt_has_deliverable_business_content(event)
        }
    }
}

fn anthropic_refusal(message: &Value) -> bool {
    message.get("stop_reason").and_then(Value::as_str) == Some("refusal")
        || message
            .pointer("/stop_details/type")
            .and_then(Value::as_str)
            == Some("refusal")
}

fn v3_anthropic_message_has_deliverable_business_content(message: &Value) -> bool {
    if anthropic_refusal(message) {
        return true;
    }
    match message.get("content").and_then(Value::as_array) {
        Some(content) => content
            .iter()
            .any(v3_anthropic_content_block_has_deliverable_content),
        None => false,
    }
}

fn v3_anthropic_content_block_has_deliverable_content(block: &Value) -> bool {
    match block.get("type").and_then(Value::as_str) {
        Some("text") => block
            .get("text")
            .and_then(Value::as_str)
            .is_some_and(|text| !text.is_empty()),
        Some("tool_use") => true,
        Some("thinking") => {
            has_non_empty_string(block.get("thinking"))
                || has_non_empty_string(block.get("signature"))
        }
        Some("redacted_thinking") => true,
        // Image, document, server-tool, or an unmodeled block type is a
        // business payload; keep it deliverable rather than fabricate a 502.
        Some(_) => true,
        None => false,
    }
}

/// Complete-attempt facts. Reasoning is business content, but cannot mask an
/// explicit blank assistant final. These facts never rewrite provider payloads.
#[derive(Default)]
pub(crate) struct V3ProviderAttemptBusinessContent {
    business: bool,
    explicit_text: bool,
    visible_text: bool,
    independent_result: bool,
}

impl V3ProviderAttemptBusinessContent {
    fn text(&mut self, value: Option<&Value>) {
        if let Some(text) = value.and_then(Value::as_str) {
            // An empty carrier may be a reasoning-only or stripped-memory
            // placeholder. Actual whitespace characters establish a blank final.
            self.explicit_text |= !text.is_empty();
            self.visible_text |= VISIBLE_TEXT_PATTERN.is_match(text);
        } else if value.is_some_and(|value| !value.is_null()) {
            // Representable structured model content stays opaque business.
            self.independent_result = true;
        }
    }

    fn part(&mut self, part: &Value) {
        match part.get("type").and_then(Value::as_str) {
            Some("text" | "output_text") => self.text(part.get("text")),
            Some("reasoning_text" | "summary_text") => {}
            _ if part.is_string() => self.text(Some(part)),
            _ => self.independent_result |= business_part_has_content(part),
        }
    }

    fn item(&mut self, item: &Value) {
        let business = v3_responses_output_item_has_deliverable_content(item);
        self.business |= business;
        match item.get("type").and_then(Value::as_str) {
            Some("reasoning") => {}
            Some("message") => {
                self.text(item.get("text"));
                if let Some(parts) = item.get("content").and_then(Value::as_array) {
                    for part in parts {
                        self.part(part);
                    }
                }
            }
            Some("output_text") => self.part(item),
            _ => self.independent_result |= business,
        }
    }

    fn response(&mut self, response: &Value) {
        self.independent_result |= v3_responses_incomplete_reason(response)
            == Some("content_filter")
            || response.get("stop_reason").and_then(Value::as_str) == Some("refusal")
            || response
                .pointer("/stop_details/type")
                .and_then(Value::as_str)
                == Some("refusal");
        self.business |= has_non_empty_string(response.get("output_text"));
        self.text(response.get("output_text"));
        if let Some(output) = response.get("output").and_then(Value::as_array) {
            for item in output {
                self.item(item);
            }
        }
    }

    pub(crate) fn observe_event(&mut self, protocol: V3HubProviderWireProtocol, event: &Value) {
        self.business |= v3_provider_event_has_deliverable_business_content(protocol, event);
        if protocol != V3HubProviderWireProtocol::Responses {
            return;
        }
        match event.get("type").and_then(Value::as_str) {
            Some("response.completed" | "response.incomplete" | "response.done") => {
                if let Some(response) = event.get("response") {
                    self.response(response);
                }
            }
            Some("response.output_item.added" | "response.output_item.done") => {
                if let Some(item) = event.get("item") {
                    self.item(item);
                }
            }
            Some("response.output_text.delta") => self.text(event.get("delta")),
            Some("response.output_text.done") => self.text(event.get("text")),
            Some("response.content_part.added" | "response.content_part.done") => {
                if let Some(part) = event.get("part") {
                    self.part(part);
                }
            }
            Some("response.refusal.delta" | "response.refusal.done") => {
                self.independent_result |= has_non_empty_string(event.get("delta"))
                    || has_non_empty_string(event.get("refusal"));
            }
            _ => {}
        }
    }

    pub(crate) fn has_deliverable_business_content(&self) -> bool {
        self.independent_result
            || ((self.business || self.visible_text) && (!self.explicit_text || self.visible_text))
    }
}

fn v3_responses_attempt_has_deliverable_business_content(response: &Value) -> bool {
    let mut facts = V3ProviderAttemptBusinessContent::default();
    facts.response(response);
    facts.has_deliverable_business_content()
}

pub(super) fn v3_responses_output_item_has_deliverable_content(item: &Value) -> bool {
    if let Some(text) = item.as_str() {
        return !text.is_empty();
    }
    match item.get("type").and_then(Value::as_str) {
        Some("message") => {
            has_non_empty_string(item.get("text"))
                || item
                    .get("content")
                    .and_then(Value::as_array)
                    .is_some_and(|parts| parts.iter().any(business_part_has_content))
                || item.as_object().is_some_and(|object| {
                    super::responses_relay_runtime::build_v3_responses_reasoning_item_from_openai_chat_message(
                        object,
                    )
                    .is_some()
                })
        }
        Some("reasoning") => {
            has_non_empty_string(item.get("encrypted_content"))
                || ["content", "summary"].iter().any(|field| {
                    item.get(*field)
                        .and_then(Value::as_array)
                        .is_some_and(|parts| parts.iter().any(business_part_has_content))
                })
        }
        Some("output_text" | "refusal") => business_part_has_content(item),
        // Tool results and other typed output items are business objects. Their
        // argument validity belongs to the model/client correction flow.
        Some(_) => true,
        None => item.as_object().is_some_and(|object| {
            object.iter().any(|(field, value)| {
                ![
                    "id",
                    "model",
                    "object",
                    "role",
                    "status",
                    "output_index",
                    "metadata",
                    "usage",
                ]
                .contains(&field.as_str())
                    && match value {
                        Value::Null => false,
                        Value::String(text) => !text.is_empty(),
                        Value::Array(items) => !items.is_empty(),
                        Value::Object(fields) => !fields.is_empty(),
                        _ => true,
                    }
            })
        }),
    }
}

fn business_part_has_content(part: &Value) -> bool {
    if let Some(text) = part.as_str() {
        return !text.is_empty();
    }
    match part.get("type").and_then(Value::as_str) {
        Some("text" | "output_text" | "reasoning_text" | "summary_text") => part
            .get("text")
            .is_some_and(|value| !value.is_null() && value != ""),
        Some("refusal") => part
            .get("refusal")
            .is_some_and(|value| !value.is_null() && value != ""),
        Some(_) => true,
        None => false,
    }
}

fn v3_responses_incomplete_reason(response: &Value) -> Option<&str> {
    response
        .pointer("/incomplete_details/reason")
        .and_then(Value::as_str)
}

fn v3_openai_chat_attempt_has_deliverable_business_content(response: &Value) -> bool {
    let Some(choices) = response.get("choices").and_then(Value::as_array) else {
        return false;
    };
    choices.iter().any(|choice| {
        choice.get("finish_reason").and_then(Value::as_str) == Some("content_filter")
            || v3_openai_chat_choice_has_deliverable_content(choice)
    })
}

fn v3_openai_chat_choice_has_deliverable_content(choice: &Value) -> bool {
    let Some(message) = choice.get("message") else {
        return false;
    };
    v3_openai_chat_message_has_deliverable_content(message)
}

fn v3_openai_chat_message_has_deliverable_content(message: &Value) -> bool {
    if has_non_empty_string(message.get("content"))
        || has_non_empty_string(message.get("refusal"))
        || has_non_empty_string(message.get("reasoning_content"))
        || has_non_empty_string(message.get("reasoning_text"))
        || has_non_empty_string(message.get("reasoning"))
        || message.as_object().is_some_and(|message| {
            super::responses_relay_runtime::build_v3_responses_reasoning_item_from_openai_chat_message(message).is_some()
        })
    {
        return true;
    }
    if message.get("audio").is_some_and(|audio| !audio.is_null()) {
        return true;
    }
    if message
        .get("tool_calls")
        .and_then(Value::as_array)
        .is_some_and(|tool_calls| !tool_calls.is_empty())
    {
        return true;
    }
    if message
        .get("function_call")
        .is_some_and(|call| !call.is_null())
    {
        return true;
    }
    // Multimodal content parts carry business content beyond plain text.
    if let Some(parts) = message.get("content").and_then(Value::as_array) {
        return parts.iter().any(business_part_has_content);
    }
    false
}

#[cfg(test)]
mod provider_attempt_business_content_tests {
    use super::*;

    fn deliverable(protocol: V3HubProviderWireProtocol, data: &str) -> bool {
        let value: Value = serde_json::from_str(data).expect("fixture must be JSON");
        v3_provider_attempt_has_deliverable_business_content(protocol, &value)
    }

    #[test]
    fn shared_predicate_reads_complete_attempt_business_content() {
        // Responses: an accumulated text carrier or output item is deliverable,
        // a legal content_filter terminal is deliverable, and an empty output is
        // empty. A shape without the canonical output array is not the empty
        // shape and is left deliverable.
        assert!(!deliverable(
            V3HubProviderWireProtocol::Responses,
            r#"{"id":"resp_empty","status":"completed","output":[]}"#
        ));
        assert!(deliverable(
            V3HubProviderWireProtocol::Responses,
            r#"{"id":"resp_text","status":"completed","output_text":"hi"}"#
        ));
        assert!(deliverable(
            V3HubProviderWireProtocol::Responses,
            r#"{"id":"resp_call","status":"completed","output":[{"type":"function_call","call_id":"c1","name":"lookup","arguments":"{}"}]}"#
        ));
        assert!(deliverable(
            V3HubProviderWireProtocol::Responses,
            r#"{"id":"resp_filter","status":"incomplete","incomplete_details":{"reason":"content_filter"},"output":[]}"#
        ));
        assert!(!deliverable(
            V3HubProviderWireProtocol::Responses,
            r#"{"id":"resp_shell","status":"completed"}"#
        ));

        // OpenAI Chat: content_filter and tool_calls are deliverable; an empty
        // stop choice is empty.
        assert!(!deliverable(
            V3HubProviderWireProtocol::OpenAiChat,
            r#"{"choices":[{"message":{"role":"assistant","content":""},"finish_reason":"stop"}]}"#
        ));
        assert!(deliverable(
            V3HubProviderWireProtocol::OpenAiChat,
            r#"{"choices":[{"message":{"role":"assistant","content":""},"finish_reason":"content_filter"}]}"#
        ));
        assert!(deliverable(
            V3HubProviderWireProtocol::OpenAiChat,
            r#"{"choices":[{"message":{"role":"assistant","content":null,"tool_calls":[{"id":"c1","type":"function","function":{"name":"lookup","arguments":"{}"}}]},"finish_reason":"tool_calls"}]}"#
        ));

        // Anthropic shares the Responses adapter because the relay materializer
        // already projects the complete message to the canonical Responses shape.
        assert!(!deliverable(
            V3HubProviderWireProtocol::Anthropic,
            r#"{"id":"msg_empty","status":"completed","output":[]}"#
        ));
        assert!(deliverable(
            V3HubProviderWireProtocol::Anthropic,
            r#"{"id":"msg_text","status":"completed","output":[{"type":"message","content":[{"type":"output_text","text":"done"}]}]}"#
        ));

        // Gemini: a business part is deliverable; empty parts are empty; a
        // non-canonical shape is left deliverable.
        assert!(!deliverable(
            V3HubProviderWireProtocol::Gemini,
            r#"{"candidates":[{"content":{"role":"model","parts":[]},"finishReason":"STOP"}]}"#
        ));
        assert!(!deliverable(
            V3HubProviderWireProtocol::Gemini,
            r#"{"candidates":[]}"#
        ));
        assert!(deliverable(
            V3HubProviderWireProtocol::Gemini,
            r#"{"candidates":[{"content":{"role":"model","parts":[{"text":"hi"}]},"finishReason":"STOP"}]}"#
        ));
        assert!(deliverable(
            V3HubProviderWireProtocol::Gemini,
            r#"{"candidates":[{"content":{"role":"model","parts":[{"functionCall":{"name":"lookup","args":{}}}]},"finishReason":"STOP"}]}"#
        ));
        assert!(!deliverable(
            V3HubProviderWireProtocol::Gemini,
            r#"{"usageMetadata":{"totalTokenCount":0}}"#
        ));
    }

    #[test]
    fn anthropic_raw_json_boundary_distinguishes_empty_from_business() {
        // The Direct JSON boundary accepts the raw Anthropic Messages shape
        // before canonicalization, so it must apply the same empty judgment.
        let empty: Value = serde_json::from_str(
            r#"{"id":"m","type":"message","content":[],"stop_reason":"end_turn"}"#,
        )
        .unwrap();
        assert!(!v3_provider_json_attempt_has_deliverable_business_content(
            V3HubProviderWireProtocol::Anthropic,
            &empty
        ));
        let text: Value = serde_json::from_str(
            r#"{"id":"m","type":"message","content":[{"type":"text","text":"done"}],"stop_reason":"end_turn"}"#,
        )
        .unwrap();
        assert!(v3_provider_json_attempt_has_deliverable_business_content(
            V3HubProviderWireProtocol::Anthropic,
            &text
        ));
    }
}
