use super::responses_relay_diagnostics::anthropic_cyber_refusal_error_from_payload;
use super::*;
use crate::hub_v1::anthropic_sse_tree::{V3AnthropicSseReducerState, V3AnthropicSseTreeError};
use crate::hub_v1::relay_sse_hooks::V3RelaySseHookCatalog;

pub(super) async fn build_v3_hub_resp_inbound_02_from_responses_provider_stream_events(
    mut provider: routecodex_v3_provider_responses::V3ProviderSseStream,
    observation: &V3RuntimeStreamObservation,
) -> Result<Value, V3ResponsesRelayRuntimeError> {
    use futures_util::StreamExt;

    let _owner = V3_RESPONSES_RELAY_PROVIDER_EVENT_CODEC_OWNER;
    let mut decoder = SseIncrementalDecoder::new(SseTransportLimits::default());
    let mut terminal_response: Option<Value> = None;
    let mut reducer = V3ResponsesSseReducerState::default();
    while let Some(chunk) = provider.next().await {
        let chunk = chunk?;
        if let Some(response) = observe_v3_runtime_responses_sse_transport_chunk_typed(
            &chunk,
            &mut decoder,
            observation,
            &mut reducer,
        )? {
            terminal_response = Some(response);
        }
    }
    finish_v3_responses_provider_sse_decoder_typed(decoder, observation, &mut reducer)?;
    terminal_response.ok_or_else(|| {
        V3ResponsesRelayRuntimeError::ProviderResponseEventCodec(
            V3_RESPONSES_RELAY_PROVIDER_EVENT_EOF_WITHOUT_TERMINAL_MESSAGE.to_string(),
        )
    })
}

fn finish_v3_responses_provider_sse_decoder_typed(
    decoder: SseIncrementalDecoder,
    observation: &V3RuntimeStreamObservation,
    reducer: &mut V3ResponsesSseReducerState,
) -> Result<(), V3ResponsesRelayRuntimeError> {
    let trailing = match decoder.finish_with_trailing_frame() {
        Ok(trailing) => trailing,
        Err(error) => {
            return Err(V3ResponsesRelayRuntimeError::ProviderSseTransport(
                error.to_string(),
            ))
        }
    };
    let Some(trailing) = trailing else {
        return Ok(());
    };
    if !trailing.frame().raw_utf8_valid() {
        return Err(V3ResponsesRelayRuntimeError::ProviderSseTransport(
            "SSE input is not valid UTF-8".to_string(),
        ));
    }
    let object = crate::sse_object_pipeline::SseObjectFrame::from_frame(&trailing);
    if !object.has_data() || object.is_done() {
        return Err(V3ResponsesRelayRuntimeError::ProviderSseTransport(
            "SSE stream ended before the final frame delimiter".to_string(),
        ));
    }
    if object.is_json_valid() {
        return Err(V3ResponsesRelayRuntimeError::ProviderSseTransport(
            "SSE stream ended before the final frame delimiter".to_string(),
        ));
    }
    observe_v3_runtime_responses_sse_semantic_frame_typed(&trailing, observation, reducer)
        .map(|_| ())
}

pub async fn materialize_v3_responses_provider_sse_as_canonical_response(
    provider: routecodex_v3_provider_responses::V3ProviderSseStream,
) -> Result<Value, V3ResponsesRelayRuntimeError> {
    materialize_v3_provider_sse_as_canonical_response(
        V3HubProviderWireProtocol::Responses,
        provider,
    )
    .await
}

pub async fn materialize_v3_provider_sse_as_canonical_response(
    provider_protocol: V3HubProviderWireProtocol,
    provider: routecodex_v3_provider_responses::V3ProviderSseStream,
) -> Result<Value, V3ResponsesRelayRuntimeError> {
    build_v3_hub_resp_inbound_02_from_provider_stream_events_for_protocol(
        provider_protocol,
        provider,
        &V3RuntimeStreamObservation::default(),
    )
    .await
}

pub(super) async fn build_v3_hub_resp_inbound_02_from_provider_stream_events_for_protocol(
    provider_protocol: V3HubProviderWireProtocol,
    provider: routecodex_v3_provider_responses::V3ProviderSseStream,
    observation: &V3RuntimeStreamObservation,
) -> Result<Value, V3ResponsesRelayRuntimeError> {
    build_v3_hub_resp_inbound_02_from_provider_stream_events_for_protocol_with_context(
        provider_protocol,
        provider,
        observation,
        &V3AnthropicResponsesProjectionContext::default(),
    )
    .await
}

pub(super) async fn build_v3_hub_resp_inbound_02_from_provider_stream_events_for_protocol_with_context(
    provider_protocol: V3HubProviderWireProtocol,
    mut provider: routecodex_v3_provider_responses::V3ProviderSseStream,
    observation: &V3RuntimeStreamObservation,
    anthropic_context: &V3AnthropicResponsesProjectionContext,
) -> Result<Value, V3ResponsesRelayRuntimeError> {
    // upstream 200 + body 0 字节（如 glmrelay_anthropic / glmrelay_openai 在
    // /v1/responses 上声明 text/event-stream 但不发帧）：先把 stream 的第一个
    // chunk 抽出判定；零 chunk 必须在 contract 边界区分成 ProviderResponseEmpty，
    // 而不是走 codec EOF-WITHOUT-TERMINAL，避免被误归类为协议缺陷，并允许
    // Error05 policy 把它当 provider_runtime_error 立即切 provider。
    let Some(first_chunk) = futures_util::StreamExt::next(&mut provider).await else {
        let provider_id = format!("{provider_protocol:?}");
        return Err(V3ResponsesRelayRuntimeError::ProviderResponseEmpty { provider_id });
    };
    let replayed = merge_first_chunk_back_into_provider_stream(first_chunk, provider);
    match provider_protocol {
        V3HubProviderWireProtocol::Responses => {
            build_v3_hub_resp_inbound_02_from_responses_provider_stream_events(
                replayed,
                observation,
            )
            .await
        }
        V3HubProviderWireProtocol::OpenAiChat => {
            build_v3_hub_resp_inbound_02_from_openai_chat_provider_stream_events(
                replayed,
                observation,
            )
            .await
        }
        V3HubProviderWireProtocol::Anthropic => {
            build_v3_hub_resp_inbound_02_from_anthropic_provider_stream_events_with_context(
                replayed,
                observation,
                anthropic_context,
            )
            .await
        }
        other => Err(V3ResponsesRelayRuntimeError::ProviderResponseEventCodec(
            format!("Responses relay cannot decode provider stream protocol {other:?}"),
        )),
    }
}

fn merge_first_chunk_back_into_provider_stream(
    first_chunk: Result<Vec<u8>, routecodex_v3_provider_responses::V3ProviderError>,
    tail: routecodex_v3_provider_responses::V3ProviderSseStream,
) -> routecodex_v3_provider_responses::V3ProviderSseStream {
    use futures_util::stream;
    let head = stream::once(async move { first_chunk });
    Box::pin(head.chain(tail))
}

pub(crate) async fn build_v3_hub_resp_inbound_02_from_anthropic_provider_stream_events_with_context(
    mut provider: routecodex_v3_provider_responses::V3ProviderSseStream,
    observation: &V3RuntimeStreamObservation,
    anthropic_context: &V3AnthropicResponsesProjectionContext,
) -> Result<Value, V3ResponsesRelayRuntimeError> {
    use futures_util::StreamExt;

    let _owner = V3_RESPONSES_RELAY_PROVIDER_EVENT_CODEC_OWNER;
    let mut decoder = SseIncrementalDecoder::new(SseTransportLimits::default());
    let mut typed_state = V3AnthropicSseReducerState::default();
    let mut done_seen = false;
    while let Some(chunk) = provider.next().await {
        let chunk = chunk?;
        let frames = decoder
            .push(build_v3_sse_transport_in_01_raw_chunk(&chunk))
            .map_err(|error| {
                V3ResponsesRelayRuntimeError::ProviderSseTransport(error.to_string())
            })?;
        for frame in frames {
            let Some(data) = parse_v3_runtime_sse_frame_fields(&frame)? else {
                continue;
            };
            if data == "[DONE]" {
                if !typed_state.message_stop_seen {
                    return Err(V3ResponsesRelayRuntimeError::ProviderResponseEventCodec(
                        "Anthropic provider event stream emitted [DONE] before message_stop"
                            .to_string(),
                    ));
                }
                done_seen = true;
                continue;
            }
            if done_seen || typed_state.message_stop_seen {
                return Err(V3ResponsesRelayRuntimeError::ProviderResponseEventCodec(
                    "Anthropic provider event stream emitted data after message_stop".to_string(),
                ));
            }
            let event: Value = serde_json::from_str(&data).map_err(|error| {
                V3ResponsesRelayRuntimeError::ProviderResponseEventCodec(format!(
                    "Anthropic provider event stream event is malformed: {error}"
                ))
            })?;
            if let Some(message) = extract_v3_provider_event_error_payload_message(&event) {
                return Err(V3ResponsesRelayRuntimeError::ProviderResponseEventCodec(
                    message,
                ));
            }
            if let Some(error) = anthropic_cyber_refusal_error_from_payload(&event) {
                return Err(
                    V3ResponsesRelayRuntimeError::ProviderResponseSemanticFailure {
                        status: 429,
                        code: error.code,
                        message: error.message,
                    },
                );
            }
            typed_state.apply_event(&event).map_err(|error| {
                let message = match error {
                    V3AnthropicSseTreeError::DuplicateMessageMismatch => {
                        "Anthropic provider event stream emitted duplicate message_start with different id"
                            .to_owned()
                    }
                    V3AnthropicSseTreeError::DuplicateMessageAfterBlock => {
                        "Anthropic provider event stream emitted duplicate message_start after content_block_start"
                            .to_owned()
                    }
                    V3AnthropicSseTreeError::ThinkingDeltaRequired => {
                        "Anthropic codec malformed reasoning content".to_owned()
                    }
                    V3AnthropicSseTreeError::MalformedReasoningContent => {
                        "Anthropic codec malformed reasoning content".to_owned()
                    }
                    V3AnthropicSseTreeError::MalformedToolInput => {
                        "Anthropic provider event stream input_json_delta is malformed".to_owned()
                    }
                    other => other.to_string(),
                };
                V3ResponsesRelayRuntimeError::ProviderResponseEventCodec(message)
            })?;
            let event_type = event
                .get("type")
                .and_then(Value::as_str)
                .unwrap_or_default();
            observation
                .record_typed_object_type("anthropic", event_type)
                .map_err(V3ResponsesRelayRuntimeError::ProviderResponseEventCodec)?;
            characterize_v3_anthropic_provider_raw_to_hub_response_semantic(
                event,
                V3HubProviderWireProtocol::Anthropic,
                V3HubTransportIntent::Sse,
            )
            .map_err(|error| {
                V3ResponsesRelayRuntimeError::ProviderResponseEventCodec(error.to_string())
            })?;
        }
    }
    decoder
        .finish()
        .map_err(|error| V3ResponsesRelayRuntimeError::ProviderSseTransport(error.to_string()))?;
    if !typed_state.message_stop_seen {
        return Err(V3ResponsesRelayRuntimeError::ProviderResponseEventCodec(
            "Anthropic provider event stream ended without message_stop".to_string(),
        ));
    }
    let anthropic_message = typed_state.to_message_value().map_err(|error| {
        let message = match error {
            V3AnthropicSseTreeError::MalformedToolInput => {
                "Anthropic provider event stream input_json_delta is malformed".to_owned()
            }
            other => other.to_string(),
        };
        V3ResponsesRelayRuntimeError::ProviderResponseEventCodec(message)
    })?;
    let response = project_v3_anthropic_message_as_responses_response_with_context(
        &anthropic_message,
        anthropic_context,
    )
    .map_err(|error| V3ResponsesRelayRuntimeError::ProviderResponseEventCodec(error.to_string()))?;
    observation
        .record_provider_event_json(&response)
        .map_err(V3ResponsesRelayRuntimeError::ProviderResponseEventCodec)?;
    Ok(response)
}

struct V3OpenAiChatMaterializationHook<'a> {
    observation: &'a V3RuntimeStreamObservation,
    catalog: V3RelaySseHookCatalog,
}

impl V3OpenAiChatSseSemanticHook for V3OpenAiChatMaterializationHook<'_> {
    fn notify(&mut self, input: &V3OpenAiChatSseHookInput<'_>) {
        let _ = self
            .observation
            .record_typed_object_type("openai_chat", &input.protocol.object);
        self.catalog.notify_chat(input);
    }

    fn rewrite(
        &mut self,
        semantic: &mut V3OpenAiChatSseSemanticObject,
    ) -> Result<(), V3OpenAiChatSseTreeError> {
        self.catalog.rewrite_chat(semantic)
    }
}

pub(super) async fn build_v3_hub_resp_inbound_02_from_openai_chat_provider_stream_events(
    provider: routecodex_v3_provider_responses::V3ProviderSseStream,
    observation: &V3RuntimeStreamObservation,
) -> Result<Value, V3ResponsesRelayRuntimeError> {
    let mut hook = V3OpenAiChatMaterializationHook {
        observation,
        catalog: compile_v3_hub_relay_response_hooks().typed_sse_catalog(),
    };
    build_v3_hub_resp_inbound_02_from_openai_chat_provider_stream_events_with_hook(
        provider,
        observation,
        &mut hook,
    )
    .await
}

pub(super) async fn build_v3_hub_resp_inbound_02_from_openai_chat_provider_stream_events_with_hook(
    mut provider: routecodex_v3_provider_responses::V3ProviderSseStream,
    observation: &V3RuntimeStreamObservation,
    hook: &mut impl V3OpenAiChatSseSemanticHook,
) -> Result<Value, V3ResponsesRelayRuntimeError> {
    use futures_util::StreamExt;

    let _owner = V3_RESPONSES_RELAY_PROVIDER_EVENT_CODEC_OWNER;
    let mut decoder = SseIncrementalDecoder::new(SseTransportLimits::default());
    let mut reducer = V3OpenAiChatSseReducerState::default();
    let mut terminal_seen = false;
    let mut done_seen = false;

    while let Some(chunk) = provider.next().await {
        let chunk = chunk?;
        let frames = decoder
            .push(build_v3_sse_transport_in_01_raw_chunk(&chunk))
            .map_err(|error| {
                V3ResponsesRelayRuntimeError::ProviderSseTransport(error.to_string())
            })?;
        for frame in frames {
            let object = crate::sse_object_pipeline::SseObjectFrame::from_frame(&frame);
            if !object.has_data() {
                continue;
            }
            if object.is_done() {
                if !terminal_seen {
                    return Err(V3ResponsesRelayRuntimeError::ProviderResponseEventCodec(
                        "OpenAI Chat provider event stream emitted [DONE] before terminal finish_reason"
                            .to_string(),
                    ));
                }
                done_seen = true;
                continue;
            }
            if !object.is_json_valid() {
                return Err(V3ResponsesRelayRuntimeError::ProviderResponseEventCodec(
                    "OpenAI Chat provider event stream event is malformed".to_string(),
                ));
            }
            let event = object.data_value().cloned().ok_or_else(|| {
                V3ResponsesRelayRuntimeError::ProviderResponseEventCodec(
                    "OpenAI Chat provider event stream event is missing".to_string(),
                )
            })?;
            if !event.is_object() {
                continue;
            }
            if done_seen {
                if is_v3_openai_chat_ping_tail_frame(
                    &serde_json::to_string(&event).unwrap_or_default(),
                ) {
                    continue;
                }
                return Err(V3ResponsesRelayRuntimeError::ProviderResponseEventCodec(
                    "OpenAI Chat provider event stream emitted data after [DONE]".to_string(),
                ));
            }
            if let Some(message) = extract_v3_provider_event_error_payload_message(&event) {
                return Err(V3ResponsesRelayRuntimeError::ProviderResponseEventCodec(
                    message,
                ));
            }
            if let Some(message) = openai_chat_provider_network_error_message(&event) {
                return Err(
                    V3ResponsesRelayRuntimeError::ProviderResponseSemanticFailure {
                        status: 502,
                        code: "network_error".to_owned(),
                        message,
                    },
                );
            }
            if terminal_seen && is_v3_openai_chat_empty_sse_tail_sentinel(&event) {
                continue;
            }
            validate_v3_openai_chat_provider_response_payload(
                &event,
                V3HubProviderWireProtocol::OpenAiChat,
                V3HubTransportIntent::Sse,
            )
            .map_err(|error| {
                V3ResponsesRelayRuntimeError::ProviderResponseEventCodec(error.to_string())
            })?;
            let transport = V3OpenAiChatSseTransportObject::new(
                object.event_name().map(ToOwned::to_owned),
                event.clone(),
            );
            let protocol =
                V3OpenAiChatSseProtocolMetadata::from_chunk(&event).map_err(|error| {
                    V3ResponsesRelayRuntimeError::ProviderResponseEventCodec(error.to_string())
                })?;
            let mut semantic = classify_v3_openai_chat_sse_chunk(&event).map_err(|error| {
                V3ResponsesRelayRuntimeError::ProviderResponseEventCodec(error.to_string())
            })?;
            apply_v3_openai_chat_sse_semantic_hook(&mut semantic, &transport, &protocol, hook)
                .map_err(|error| {
                    V3ResponsesRelayRuntimeError::ProviderResponseEventCodec(error.to_string())
                })?;
            let projected = project_v3_openai_chat_sse_chunk_json(&semantic);
            observation
                .record_provider_event_json(&projected)
                .map_err(V3ResponsesRelayRuntimeError::ProviderResponseEventCodec)?;
            reducer.apply_chunk(&projected).map_err(|error| {
                V3ResponsesRelayRuntimeError::ProviderResponseEventCodec(error.to_string())
            })?;
            terminal_seen = reducer.terminal.is_some();
        }
    }
    decoder
        .finish()
        .map_err(|error| V3ResponsesRelayRuntimeError::ProviderSseTransport(error.to_string()))?;
    if !terminal_seen {
        // Clean EOF without a tool call is the compatibility terminal boundary.
        // A complete tool call remains semantic output even when this Chat
        // gateway omits finish_reason; do not fabricate stop for that case.
        // Incomplete tool-call data still fails in materialize_completion and is
        // retried as an explicit codec/projection error.
        let mut response = reducer.materialize_completion().map_err(|error| {
            V3ResponsesRelayRuntimeError::ProviderResponseEventCodec(error.to_string())
        })?;
        if !reducer.has_tool_calls() {
            if let Some(choices) = response.get_mut("choices").and_then(Value::as_array_mut) {
                for choice in choices {
                    if choice.get("finish_reason").is_none_or(Value::is_null) {
                        choice["finish_reason"] = Value::String("stop".to_string());
                    }
                }
            }
        }
        observation
            .record_provider_event_json(&response)
            .map_err(V3ResponsesRelayRuntimeError::ProviderResponseEventCodec)?;
        return Ok(response);
    }
    reducer.materialize_completion().map_err(|error| {
        V3ResponsesRelayRuntimeError::ProviderResponseEventCodec(error.to_string())
    })
}

fn is_v3_openai_chat_ping_tail_frame(data: &str) -> bool {
    let Ok(value) = serde_json::from_str::<Value>(data) else {
        return false;
    };
    if value.get("type").and_then(Value::as_str) == Some("ping") {
        return true;
    }
    // Chat-style gateways emit a non-semantic settlement frame after [DONE]
    // (e.g. `{"choices":[],"cost":"0"}`): empty choices carry no content or
    // tool-call delta, so it is a benign protocol tail frame, not corruption.
    matches!(
        value.get("choices").and_then(Value::as_array),
        Some(choices) if choices.is_empty()
    )
}

fn is_v3_openai_chat_empty_sse_tail_sentinel(event: &Value) -> bool {
    let Some(object) = event.as_object() else {
        return false;
    };
    object
        .get("id")
        .and_then(Value::as_str)
        .is_some_and(str::is_empty)
        && object
            .get("object")
            .and_then(Value::as_str)
            .is_some_and(str::is_empty)
        && object
            .get("choices")
            .and_then(Value::as_array)
            .is_some_and(|choices| choices.is_empty())
}

fn openai_chat_provider_network_error_message(event: &Value) -> Option<String> {
    let choices = event.get("choices").and_then(Value::as_array)?;
    choices.iter().find_map(|choice| {
        (choice.get("finish_reason").and_then(Value::as_str) == Some("network_error"))
            .then(|| "OpenAI Chat provider emitted finish_reason=network_error".to_owned())
    })
}

pub(super) fn read_v3_trimmed_string(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures_util::stream;

    struct RewriteChatMaterializationHook {
        notifications: usize,
    }

    impl V3OpenAiChatSseSemanticHook for RewriteChatMaterializationHook {
        fn notify(&mut self, _input: &V3OpenAiChatSseHookInput<'_>) {
            self.notifications += 1;
        }

        fn rewrite(
            &mut self,
            semantic: &mut V3OpenAiChatSseSemanticObject,
        ) -> Result<(), V3OpenAiChatSseTreeError> {
            for choice in &mut semantic.choices {
                if let V3OpenAiChatSseDelta::Text(text) = &mut choice.delta {
                    *text = "rewritten by relay hook".to_owned();
                }
            }
            Ok(())
        }
    }

    #[test]
    fn ping_tail_frame_after_done_is_recognized() {
        assert!(is_v3_openai_chat_ping_tail_frame(
            r#"{"type":"ping","cost":"0"}"#
        ));
        assert!(is_v3_openai_chat_ping_tail_frame(r#"{"type":"ping"}"#));
        // Chat-style gateways settle cost with an empty-choices frame after [DONE].
        assert!(is_v3_openai_chat_ping_tail_frame(
            r#"{"choices":[],"cost":"0"}"#
        ));
        assert!(is_v3_openai_chat_ping_tail_frame(r#"{"choices":[]}"#));
    }

    #[test]
    fn semantic_frames_after_done_are_not_ping() {
        assert!(!is_v3_openai_chat_ping_tail_frame(
            r#"{"type":"response.completed","response":{"status":"completed"}}"#
        ));
        assert!(!is_v3_openai_chat_ping_tail_frame(
            r#"{"id":"x","choices":[{}]}"#
        ));
        assert!(!is_v3_openai_chat_ping_tail_frame(
            r#"{"choices":[{"index":0,"delta":{"content":"hi"}}]}"#
        ));
        assert!(!is_v3_openai_chat_ping_tail_frame("not json"));
        assert!(!is_v3_openai_chat_ping_tail_frame("[1,2,3]"));
    }

    #[tokio::test]
    async fn chat_materialization_applies_injected_typed_hook_before_reducer() {
        let observation = V3RuntimeStreamObservation::default();
        let provider = Box::pin(stream::iter(vec![Ok(
            concat!(
                "data: {\"id\":\"chatcmpl_hook\",\"object\":\"chat.completion.chunk\",\"created\":7,\"model\":\"chat-model\",\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"content\":\"original\"},\"finish_reason\":null}]}\n\n",
                "data: {\"id\":\"chatcmpl_hook\",\"object\":\"chat.completion.chunk\",\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n",
                "data: {\"id\":\"chatcmpl_hook\",\"object\":\"chat.completion.chunk\",\"choices\":[],\"usage\":{\"prompt_tokens\":1,\"completion_tokens\":1,\"total_tokens\":2}}\n\n",
                "data: [DONE]\n\n",
            )
            .as_bytes()
            .to_vec(),
        )]));
        let mut hook = RewriteChatMaterializationHook { notifications: 0 };

        let output =
            build_v3_hub_resp_inbound_02_from_openai_chat_provider_stream_events_with_hook(
                provider,
                &observation,
                &mut hook,
            )
            .await
            .expect("typed Chat hook should materialize successfully");

        assert_eq!(hook.notifications, 3);
        assert_eq!(
            output["choices"][0]["message"]["content"],
            "rewritten by relay hook"
        );
        assert_eq!(output["choices"][0]["finish_reason"], "stop");
    }

    #[tokio::test]
    async fn clean_eof_without_finish_reason_is_stop_without_tool_call() {
        let observation = V3RuntimeStreamObservation::default();
        let provider = Box::pin(stream::iter(vec![Ok(
            b"data: {\"id\":\"chatcmpl_eof\",\"object\":\"chat.completion.chunk\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"ok\"},\"finish_reason\":null}]}\n\n".to_vec(),
        )]));

        let output = build_v3_hub_resp_inbound_02_from_openai_chat_provider_stream_events(
            provider,
            &observation,
        )
        .await
        .expect("clean EOF without a tool call is a stop completion");

        assert_eq!(output["choices"][0]["finish_reason"], "stop");
    }

    #[tokio::test]
    async fn clean_eof_with_complete_tool_call_preserves_tool_call_without_reason() {
        let observation = V3RuntimeStreamObservation::default();
        let provider = Box::pin(stream::iter(vec![Ok(
            b"data: {\"id\":\"chatcmpl_tool_eof\",\"object\":\"chat.completion.chunk\",\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_1\",\"type\":\"function\",\"function\":{\"name\":\"lookup\",\"arguments\":\"{}\"}}]},\"finish_reason\":null}]}\n\n".to_vec(),
        )]));

        let output = build_v3_hub_resp_inbound_02_from_openai_chat_provider_stream_events(
            provider,
            &observation,
        )
        .await
        .expect("complete tool call must survive missing finish_reason");

        assert_eq!(output["choices"][0]["finish_reason"], Value::Null);
        assert_eq!(
            output["choices"][0]["message"]["tool_calls"][0]["id"],
            "call_1"
        );
    }

    #[tokio::test]
    async fn provider_network_error_is_reported_as_provider_network_error() {
        let observation = V3RuntimeStreamObservation::default();
        let provider = Box::pin(stream::iter(vec![Ok(
            b"data: {\"id\":\"chatcmpl_network_error\",\"created\":7,\"model\":\"chat-model\",\"choices\":[{\"index\":0,\"finish_reason\":\"network_error\",\"delta\":{\"role\":\"assistant\",\"content\":\"\"}}]}\n\n".to_vec(),
        )]));

        let error = build_v3_hub_resp_inbound_02_from_openai_chat_provider_stream_events(
            provider,
            &observation,
        )
        .await
        .expect_err("provider network_error must not become a successful completion");

        assert!(matches!(
            error,
            V3ResponsesRelayRuntimeError::ProviderResponseSemanticFailure {
                status: 502,
                ref code,
                ref message,
            } if code == "network_error"
                && message.contains("finish_reason=network_error")
        ));
    }
}
