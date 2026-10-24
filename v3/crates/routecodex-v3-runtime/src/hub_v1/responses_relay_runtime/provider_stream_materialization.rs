use super::*;
use crate::hub_v1::anthropic_sse_tree::{V3AnthropicSseReducerState, V3AnthropicSseTreeError};
use crate::hub_v1::gemini_terminal_semantics::{
    candidate_finish_reason, interpret_gemini_terminal,
};
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
            break;
        }
    }
    if terminal_response.is_none() {
        finish_v3_responses_provider_sse_decoder_typed(decoder, observation, &mut reducer)?;
    }
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

pub(super) async fn build_v3_hub_resp_inbound_02_from_provider_stream_events_for_protocol_with_context_and_projection(
    provider_protocol: V3HubProviderWireProtocol,
    mut provider: routecodex_v3_provider_responses::V3ProviderSseStream,
    observation: &V3RuntimeStreamObservation,
    anthropic_context: &V3AnthropicResponsesProjectionContext,
    mut relay_client_projection: Option<&mut super::relay_client_frames::V3RelayChatClientStreamProjector>,
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
    let response = match provider_protocol {
        V3HubProviderWireProtocol::Responses => {
            build_v3_hub_resp_inbound_02_from_responses_provider_stream_events(
                replayed,
                observation,
            )
            .await?
        }
        V3HubProviderWireProtocol::OpenAiChat => {
            let mut hook = V3OpenAiChatMaterializationHook {
                observation,
                catalog: compile_v3_hub_relay_response_hooks().typed_sse_catalog(),
            };
            build_v3_hub_resp_inbound_02_from_openai_chat_provider_stream_events_with_hook_and_projection(
                replayed,
                observation,
                &mut hook,
                relay_client_projection.take(),
            )
            .await?
        }
        V3HubProviderWireProtocol::Anthropic => {
            build_v3_hub_resp_inbound_02_from_anthropic_provider_stream_events_with_context(
                replayed,
                observation,
                anthropic_context,
            )
            .await?
        }
        V3HubProviderWireProtocol::Gemini => {
            materialize_gemini_provider_events(replayed, observation).await?
        }
    };
    // Complete-attempt success acceptance: a fully materialized attempt that
    // carries no deliverable business content is an internal 502 for the Error
    // chain, never a normal empty completion. The judgment is shared across
    // protocols and reads the whole accumulated response, not the last frame.
    if !crate::hub_v1::v3_provider_attempt_has_deliverable_business_content(
        provider_protocol,
        &response,
    ) {
        return Err(crate::hub_v1::empty_provider_attempt_failure(
            provider_protocol,
        ));
    }
    Ok(response)
}

async fn materialize_gemini_provider_events(
    mut provider: routecodex_v3_provider_responses::V3ProviderSseStream,
    observation: &V3RuntimeStreamObservation,
) -> Result<Value, V3ResponsesRelayRuntimeError> {
    use futures_util::StreamExt;
    let mut decoder = SseIncrementalDecoder::new(SseTransportLimits::default());
    let mut response = Value::Object(serde_json::Map::new());
    // A Gemini attempt may stream several candidates. Each candidate index
    // keeps its own terminal, so a terminal for one candidate can never
    // truncate later candidate content, usage or an error frame.
    while let Some(chunk) = provider.next().await {
        let frames = decoder
            .push(build_v3_sse_transport_in_01_raw_chunk(&chunk?))
            .map_err(|error| {
                V3ResponsesRelayRuntimeError::ProviderSseTransport(error.to_string())
            })?;
        for frame in frames {
            let Some(data) = parse_v3_runtime_sse_frame_fields(&frame)? else {
                continue;
            };
            let event: Value = serde_json::from_str(&data).map_err(|error| {
                V3ResponsesRelayRuntimeError::ProviderResponseEventCodec(error.to_string())
            })?;
            if let Some(error) = extract_v3_provider_event_error(&event) {
                return Err(error);
            }
            observation
                .record_provider_event_json(&event)
                .map_err(V3ResponsesRelayRuntimeError::ProviderResponseEventCodec)?;
            let event_row = event.as_object().ok_or_else(|| {
                V3ResponsesRelayRuntimeError::ProviderResponseEventCodec(
                    "Gemini event must be an object".into(),
                )
            })?;
            for (key, value) in event_row {
                if key != "candidates" {
                    response[key] = value.clone();
                }
            }
            let Some(candidates) = event.get("candidates").and_then(Value::as_array) else {
                continue;
            };
            if response
                .get("candidates")
                .and_then(Value::as_array)
                .is_none()
            {
                response["candidates"] = Value::Array(Vec::new());
            }
            for (ordinal, candidate) in candidates.iter().enumerate() {
                let index = candidate
                    .get("index")
                    .and_then(Value::as_u64)
                    .unwrap_or(ordinal as u64);
                let accumulated = response["candidates"].as_array_mut().unwrap();
                let position = accumulated.iter().enumerate().find_map(|(ordinal, row)| {
                    (row.get("index")
                        .and_then(Value::as_u64)
                        .unwrap_or(ordinal as u64)
                        == index)
                        .then_some(ordinal)
                });
                if let Some(position) = position {
                    let current = &mut accumulated[position];
                    let has_parts = current.pointer("/content/parts").is_some()
                        || candidate.pointer("/content/parts").is_some();
                    let mut parts = current
                        .pointer("/content/parts")
                        .and_then(Value::as_array)
                        .cloned()
                        .unwrap_or_default();
                    parts.extend(
                        candidate
                            .pointer("/content/parts")
                            .and_then(Value::as_array)
                            .into_iter()
                            .flatten()
                            .cloned(),
                    );
                    for (key, value) in candidate.as_object().ok_or_else(|| {
                        V3ResponsesRelayRuntimeError::ProviderResponseEventCodec(
                            "Gemini candidate must be an object".into(),
                        )
                    })? {
                        // A later nonterminal tail field cannot erase this
                        // candidate's already observed genuine business reason.
                        if key == "finishReason"
                            && candidate_finish_reason(current).is_some()
                            && candidate_finish_reason(candidate).is_none()
                        {
                            continue;
                        }
                        if key == "content"
                            && current.get("content").is_some_and(Value::is_object)
                            && value.is_object()
                        {
                            for (field, value) in value.as_object().unwrap() {
                                if field != "parts" {
                                    current["content"][field] = value.clone();
                                }
                            }
                        } else {
                            current[key] = value.clone();
                        }
                    }
                    if has_parts {
                        current["content"]["parts"] = Value::Array(parts);
                    }
                } else {
                    accumulated.push(candidate.clone());
                }
            }
        }
    }
    decoder
        .finish()
        .map_err(|error| V3ResponsesRelayRuntimeError::ProviderSseTransport(error.to_string()))?;
    interpret_gemini_terminal(&response)
        .map_err(V3ResponsesRelayRuntimeError::ProviderResponseEventCodec)?;
    Ok(response)
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
    let mut terminal_seen = false;
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
            if let Some(error) = extract_v3_provider_event_error(&event) {
                return Err(error);
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
            if typed_state.message_stop_seen {
                terminal_seen = true;
                break;
            }
        }
        if terminal_seen {
            break;
        }
    }
    if !terminal_seen {
        decoder.finish().map_err(|error| {
            V3ResponsesRelayRuntimeError::ProviderSseTransport(error.to_string())
        })?;
    }
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
    observation
        .record_provider_event_json(&anthropic_message)
        .map_err(V3ResponsesRelayRuntimeError::ProviderResponseEventCodec)?;
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
    fn notify(&mut self, input: &V3OpenAiChatSseHookInput<'_>) -> Result<(), String> {
        self.observation
            .record_typed_object_type("openai_chat", &input.protocol.object)?;
        self.catalog.notify_chat(input);
        Ok(())
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

/// Four-argument shim: the protocol dispatcher owns the projection handle.
pub(super) async fn build_v3_hub_resp_inbound_02_from_provider_stream_events_for_protocol_with_context(
    provider_protocol: V3HubProviderWireProtocol,
    provider: routecodex_v3_provider_responses::V3ProviderSseStream,
    observation: &V3RuntimeStreamObservation,
    anthropic_context: &V3AnthropicResponsesProjectionContext,
) -> Result<Value, V3ResponsesRelayRuntimeError> {
    build_v3_hub_resp_inbound_02_from_provider_stream_events_for_protocol_with_context_and_projection(
        provider_protocol,
        provider,
        observation,
        anthropic_context,
        None,
    )
    .await
}

/// Three-argument shim for callers that do not project client frames.
pub(super) async fn build_v3_hub_resp_inbound_02_from_openai_chat_provider_stream_events_with_hook(
    provider: routecodex_v3_provider_responses::V3ProviderSseStream,
    observation: &V3RuntimeStreamObservation,
    hook: &mut impl V3OpenAiChatSseSemanticHook,
) -> Result<Value, V3ResponsesRelayRuntimeError> {
    build_v3_hub_resp_inbound_02_from_openai_chat_provider_stream_events_with_hook_and_projection(
        provider,
        observation,
        hook,
        None,
    )
    .await
}

pub(super) async fn build_v3_hub_resp_inbound_02_from_openai_chat_provider_stream_events_with_hook_and_projection(
    mut provider: routecodex_v3_provider_responses::V3ProviderSseStream,
    observation: &V3RuntimeStreamObservation,
    hook: &mut impl V3OpenAiChatSseSemanticHook,
    mut relay_client_projection: Option<&mut super::relay_client_frames::V3RelayChatClientStreamProjector>,
) -> Result<Value, V3ResponsesRelayRuntimeError> {
    use futures_util::StreamExt;

    let _owner = V3_RESPONSES_RELAY_PROVIDER_EVENT_CODEC_OWNER;
    let mut decoder = SseIncrementalDecoder::new(SseTransportLimits::default());
    let mut reducer = V3OpenAiChatSseReducerState::default();
    let mut terminal_seen = false;
    let mut terminal_usage_closeout_seen = false;
    let mut done_seen = false;
    let mut stop_after_terminal = false;

    while let Some(chunk) = provider.next().await {
        let chunk = match chunk {
            Ok(chunk) => chunk,
            Err(_) if terminal_seen => break,
            Err(error) => return Err(error.into()),
        };
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
                // `[DONE]` is transport closeout, not semantic terminality. If
                // the gateway omitted finish_reason, the existing clean-EOF
                // materialization below decides whether the accumulated output
                // is a valid completion or must fail closed.
                done_seen = true;
                continue;
            }
            if !object.is_json_valid() {
                if terminal_seen {
                    stop_after_terminal = true;
                    break;
                }
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
                if terminal_seen {
                    stop_after_terminal = true;
                    break;
                }
                continue;
            }
            if done_seen {
                if is_v3_openai_chat_ping_tail_frame(
                    &serde_json::to_string(&event).unwrap_or_default(),
                ) {
                    continue;
                }
                if terminal_seen {
                    stop_after_terminal = true;
                    break;
                }
                return Err(V3ResponsesRelayRuntimeError::ProviderResponseEventCodec(
                    "OpenAI Chat provider event stream emitted data after [DONE]".to_string(),
                ));
            }
            if terminal_seen
                && !is_v3_openai_chat_empty_sse_tail_sentinel(&event)
                && !is_v3_openai_chat_usage_closeout_frame(&event)
            {
                stop_after_terminal = true;
                break;
            }
            if let Some(error) = extract_v3_provider_event_error(&event) {
                return Err(error);
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
            apply_v3_openai_chat_sse_semantic_hook_with_observation(
                &mut semantic,
                &transport,
                &protocol,
                hook,
                Some(observation),
            )
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
            if let Some(projection) = relay_client_projection.as_mut() {
                projection.on_chat_chunk(&projected).map_err(|error| {
                    V3ResponsesRelayRuntimeError::ExecutionControlResponse(error)
                })?;
            }
            if terminal_seen && is_v3_openai_chat_usage_closeout_frame(&projected) {
                terminal_usage_closeout_seen = true;
            }
            terminal_seen = reducer.terminal.is_some();
        }
        if (terminal_seen && (terminal_usage_closeout_seen || done_seen)) || stop_after_terminal {
            break;
        }
    }
    if !terminal_seen && !stop_after_terminal {
        decoder.finish().map_err(|error| {
            V3ResponsesRelayRuntimeError::ProviderSseTransport(error.to_string())
        })?;
    }
    if !terminal_seen {
        return Err(V3ResponsesRelayRuntimeError::ProviderResponseEventCodec(
            "OpenAI Chat provider stream reached EOF without a semantic terminal".to_string(),
        ));
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

fn is_v3_openai_chat_usage_closeout_frame(event: &Value) -> bool {
    event
        .get("choices")
        .and_then(Value::as_array)
        .is_some_and(|choices| choices.is_empty())
        && event.get("usage").is_some_and(|usage| !usage.is_null())
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
    use serde_json::json;

    #[tokio::test]
    async fn gemini_terminal_buffered_and_json_outcomes_match_despite_nonterminal_tail() {
        use crate::hub_v1::gemini_responses_codec::project_gemini_response;
        for (reason, incomplete) in [
            ("SAFETY", Some("content_filter")),
            ("MAX_TOKENS", Some("max_output_tokens")),
            ("FUTURE_TERMINAL", None),
        ] {
            for reverse in [false, true] {
                let original = json!({"index":7,"finishReason":reason,"finishMessage":"original terminal","opaque":{"nested":[true,17]},"content":{"role":"model","opaque_content":{"original":true},"parts":[{"text":"seven"}]}});
                let stop =
                    json!({"index":3,"finishReason":"STOP","content":{"parts":[{"text":"three"}]}});
                let candidates = if reverse {
                    vec![stop, original.clone()]
                } else {
                    vec![original.clone(), stop]
                };
                let expected =
                    project_gemini_response(&json!({"candidates":candidates}), "parity").unwrap();
                for tail in ["", "FINISH_REASON_UNSPECIFIED"] {
                    let frames = candidates
                        .iter()
                        .map(
                            |c| Ok(format!("data: {}\n\n", json!({"candidates":[c]})).into_bytes()),
                        )
                        .chain([Ok(format!(
                            "data: {}\n\n",
                            json!({"candidates":[{"index":7,"finishReason":tail,"content":{"parts":[]}}]})
                        )
                        .into_bytes())])
                        .collect::<Vec<_>>();
                    let buffered = materialize_gemini_provider_events(
                        Box::pin(stream::iter(frames)),
                        &V3RuntimeStreamObservation::default(),
                    )
                    .await
                    .unwrap();
                    let response = project_gemini_response(&buffered, "parity").unwrap();
                    assert_eq!(response, expected);
                    assert_eq!(
                        response["status"],
                        if incomplete.is_some() {
                            "incomplete"
                        } else {
                            "completed"
                        }
                    );
                    if let Some(incomplete) = incomplete {
                        assert_eq!(response["incomplete_details"]["reason"], incomplete);
                    }
                    let row = response["gemini_candidate_outcomes"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .find(|r| r["candidate_index"] == 7)
                        .unwrap();
                    assert_eq!(row["finishReason"], original["finishReason"]);
                    assert_eq!(row["finishMessage"], original["finishMessage"]);
                    assert_eq!(row["opaque"], original["opaque"]);
                    assert_eq!(row["content"]["role"], "model");
                    assert_eq!(
                        row["content"]["opaque_content"],
                        original["content"]["opaque_content"]
                    );
                }
            }
        }
    }

    #[tokio::test]
    async fn gemini_terminal_unfinished_candidate_cannot_be_completed_by_defaults_or_feedback() {
        for reason in [None, Some(""), Some("FINISH_REASON_UNSPECIFIED")] {
            for feedback in ["", "BLOCK_REASON_UNSPECIFIED", "SAFETY"] {
                let mut candidate = json!({"index":0,"content":{"parts":[{"text":"unfinished"}]}});
                if let Some(reason) = reason {
                    candidate["finishReason"] = json!(reason);
                }
                let provider = Box::pin(stream::iter(vec![
                    Ok(format!("data: {}\n\n", json!({"candidates":[candidate]})).into_bytes()),
                    Ok(format!(
                        "data: {}\n\n",
                        json!({"promptFeedback":{"blockReason":feedback}})
                    )
                    .into_bytes()),
                ]));
                let result = materialize_gemini_provider_events(
                    provider,
                    &V3RuntimeStreamObservation::default(),
                )
                .await;
                assert!(
                    matches!(
                        result,
                        Err(V3ResponsesRelayRuntimeError::ProviderResponseEventCodec(_))
                    ),
                    "reason={reason:?} feedback={feedback}: {result:?}"
                );
            }
        }
    }

    #[tokio::test]
    async fn gemini_materialization_buffers_complete_attempt_and_requires_terminal() {
        let first = serde_json::json!({"candidates":[{"index":0,"content":{"parts":[{"text":"before tool"}]}}]});
        let final_frame = serde_json::json!({"candidates":[{"index":0,"content":{"parts":[{"functionCall":{"name":"declared_name","args":{"input":"complete input","extra":[1,2,3]}}}]},"finishReason":"STOP"}],"usageMetadata":{"totalTokenCount":5}});
        let provider = Box::pin(stream::iter(vec![
            Ok(format!("data: {first}\n\n").into_bytes()),
            Ok(format!("data: {final_frame}\n\n").into_bytes()),
        ]));
        let response = materialize_v3_provider_sse_as_canonical_response(
            V3HubProviderWireProtocol::Gemini,
            provider,
        )
        .await
        .unwrap();
        assert_eq!(
            response["candidates"][0]["content"]["parts"][0]["text"],
            "before tool"
        );
        assert_eq!(
            response["candidates"][0]["content"]["parts"][1]["functionCall"]["args"]["extra"],
            serde_json::json!([1, 2, 3])
        );
        assert_eq!(response["usageMetadata"]["totalTokenCount"], 5);
        let provider = Box::pin(stream::iter(vec![Ok(
            format!("data: {first}\n\n").into_bytes()
        )]));
        assert!(
            matches!(materialize_v3_provider_sse_as_canonical_response(V3HubProviderWireProtocol::Gemini, provider).await,
            Err(V3ResponsesRelayRuntimeError::ProviderResponseEventCodec(message)) if message.contains("without terminal"))
        );
    }

    #[tokio::test]
    async fn gemini_materialization_preserves_later_candidate_after_first_terminal() {
        let first = serde_json::json!({"candidates":[{"index":0,"content":{"role":"model","parts":[{"text":"candidate zero"}]},"finishReason":"STOP"}]});
        let second = serde_json::json!({"candidates":[{"index":1,"content":{"role":"model","parts":[{"functionCall":{"name":"declared_name","args":{"left":17,"right":25}}}]}}]});
        let third = serde_json::json!({"candidates":[{"index":1,"finishReason":"STOP"}],"usageMetadata":{"totalTokenCount":5}});
        let provider = Box::pin(stream::iter(vec![
            Ok(format!("data: {first}\n\n").into_bytes()),
            Ok(format!("data: {second}\n\n").into_bytes()),
            Ok(format!("data: {third}\n\n").into_bytes()),
        ]));
        let response = materialize_v3_provider_sse_as_canonical_response(
            V3HubProviderWireProtocol::Gemini,
            provider,
        )
        .await
        .expect("complete buffering must keep reading after the first candidate terminal");
        assert_eq!(
            response["candidates"][0]["content"]["parts"][0]["text"],
            "candidate zero"
        );
        assert_eq!(
            response["candidates"][1]["content"]["parts"][0]["functionCall"]["name"],
            "declared_name"
        );
        assert_eq!(response["usageMetadata"]["totalTokenCount"], 5);
    }

    #[tokio::test]
    async fn gemini_materialization_propagates_late_error_after_first_terminal() {
        let first = serde_json::json!({"candidates":[{"index":0,"content":{"role":"model","parts":[{"text":"committed candidate zero"}]},"finishReason":"STOP"}]});
        let late = serde_json::json!({"error":{"code":"late_provider_error","message":"typed late provider error"}});
        let provider = Box::pin(stream::iter(vec![
            Ok(format!("data: {first}\n\n").into_bytes()),
            Ok(format!("data: {late}\n\n").into_bytes()),
        ]));
        let error = materialize_v3_provider_sse_as_canonical_response(
            V3HubProviderWireProtocol::Gemini,
            provider,
        )
        .await
        .expect_err("a typed late provider error must not become a committed success");
        assert!(matches!(
            error,
            V3ResponsesRelayRuntimeError::ProviderResponseSemanticFailure { ref code, .. }
                if code == "late_provider_error"
        ));
    }

    #[tokio::test]
    async fn gemini_materialization_propagates_late_transport_error_after_first_terminal() {
        let first = serde_json::json!({"candidates":[{"index":0,"content":{"role":"model","parts":[{"text":"committed candidate zero"}]},"finishReason":"STOP"}]});
        let provider = Box::pin(stream::iter(vec![
            Ok(format!("data: {first}\n\n").into_bytes()),
            Err(
                routecodex_v3_provider_responses::V3ProviderError::ResponseBody {
                    request_id: "req-gemini-late-transport".to_owned(),
                    provider_id: "provider-gemini-late-transport".to_owned(),
                    reason: "provider read failed after terminal".to_owned(),
                },
            ),
        ]));
        let error = materialize_v3_provider_sse_as_canonical_response(
            V3HubProviderWireProtocol::Gemini,
            provider,
        )
        .await
        .expect_err("a late provider transport error must not become a committed success");
        assert!(matches!(error, V3ResponsesRelayRuntimeError::Provider(_)));
    }

    #[tokio::test]
    async fn gemini_materialization_accepts_prompt_block_without_candidates() {
        let blocked = serde_json::json!({"promptFeedback":{"blockReason":"SAFETY"}});
        let provider = Box::pin(stream::iter(vec![Ok(
            format!("data: {blocked}\n\n").into_bytes()
        )]));
        let response = materialize_v3_provider_sse_as_canonical_response(
            V3HubProviderWireProtocol::Gemini,
            provider,
        )
        .await
        .expect("a documented prompt-block terminal is a legal business response");
        assert_eq!(response["promptFeedback"]["blockReason"], "SAFETY");
        assert!(
            response.get("candidates").is_none()
                || response["candidates"]
                    .as_array()
                    .is_some_and(|candidates| candidates.is_empty())
        );
    }

    #[tokio::test]
    async fn gemini_materialization_retains_single_candidate_filter_terminal() {
        let filtered = serde_json::json!({"candidates":[{"index":0,"finishReason":"SAFETY"}],"usageMetadata":{"totalTokenCount":5}});
        let provider = Box::pin(stream::iter(vec![Ok(
            format!("data: {filtered}\n\n").into_bytes()
        )]));
        let response = materialize_v3_provider_sse_as_canonical_response(
            V3HubProviderWireProtocol::Gemini,
            provider,
        )
        .await
        .expect("a provider content-filter terminal is a legal business response");
        assert_eq!(response["candidates"][0]["finishReason"], "SAFETY");
        assert_eq!(response["usageMetadata"]["totalTokenCount"], 5);
    }

    struct RewriteChatMaterializationHook {
        notifications: usize,
    }

    impl V3OpenAiChatSseSemanticHook for RewriteChatMaterializationHook {
        fn notify(&mut self, _input: &V3OpenAiChatSseHookInput<'_>) -> Result<(), String> {
            self.notifications += 1;
            Ok(())
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
    async fn chat_materialization_stops_at_non_usage_frame_after_terminal() {
        let observation = V3RuntimeStreamObservation::default();
        let provider = Box::pin(stream::iter(vec![Ok(
            concat!(
                "data: {\"id\":\"chatcmpl_stop\",\"object\":\"chat.completion.chunk\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"ok\"},\"finish_reason\":null}]}\n\n",
                "data: {\"id\":\"chatcmpl_stop\",\"object\":\"chat.completion.chunk\",\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n",
                "data: {\"id\":\"chatcmpl_stop\",\"object\":\"chat.completion.chunk\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"late\"},\"finish_reason\":null}]}\n\n",
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
            .expect("terminal frame must close the materialized response");

        assert_eq!(
            output["choices"][0]["message"]["content"],
            "rewritten by relay hook"
        );
        assert_eq!(hook.notifications, 2);
    }

    #[tokio::test]
    async fn clean_eof_without_finish_reason_is_stop_without_tool_call() {
        let observation = V3RuntimeStreamObservation::default();
        let provider = Box::pin(stream::iter(vec![Ok(
            b"data: {\"id\":\"chatcmpl_eof\",\"object\":\"chat.completion.chunk\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"ok\"},\"finish_reason\":null}]}\n\n".to_vec(),
        )]));

        let error = build_v3_hub_resp_inbound_02_from_openai_chat_provider_stream_events(
            provider,
            &observation,
        )
        .await
        .expect_err("clean EOF without a semantic terminal must fail");

        assert!(matches!(
            error,
            V3ResponsesRelayRuntimeError::ProviderResponseEventCodec(message)
                if message.contains("EOF") || message.contains("terminal")
        ));
    }

    #[tokio::test]
    async fn done_without_finish_reason_is_not_a_semantic_terminal() {
        let observation = V3RuntimeStreamObservation::default();
        let provider = Box::pin(stream::iter(vec![Ok(
            b"data: {\"id\":\"chatcmpl_done\",\"object\":\"chat.completion.chunk\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"ok\"},\"finish_reason\":null}]}\n\ndata: [DONE]\n\n".to_vec(),
        )]));

        let error = build_v3_hub_resp_inbound_02_from_openai_chat_provider_stream_events(
            provider,
            &observation,
        )
        .await
        .expect_err("[DONE] without a semantic terminal must fail");

        assert!(matches!(
            error,
            V3ResponsesRelayRuntimeError::ProviderResponseEventCodec(message)
                if message.contains("EOF") && message.contains("terminal")
        ));
    }

    #[tokio::test]
    async fn empty_chat_sse_reason_waits_for_real_terminal() {
        let observation = V3RuntimeStreamObservation::default();
        let provider = Box::pin(stream::iter(vec![Ok(concat!(
            "data: {\"id\":\"chatcmpl_empty\",\"object\":\"chat.completion.chunk\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"ok\"},\"finish_reason\":\"\"}]}\n\n",
            "data: {\"id\":\"chatcmpl_empty\",\"object\":\"chat.completion.chunk\",\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n",
            "data: [DONE]\n\n",
        ).as_bytes().to_vec())]));
        let response = build_v3_hub_resp_inbound_02_from_openai_chat_provider_stream_events(
            provider,
            &observation,
        )
        .await
        .expect("empty intermediate reason must not reject the complete SSE stream");
        assert_eq!(response["choices"][0]["message"]["content"], "ok");
        assert_eq!(response["choices"][0]["finish_reason"], "stop");
    }

    #[tokio::test]
    async fn blank_chat_sse_reason_waits_for_real_terminal() {
        let observation = V3RuntimeStreamObservation::default();
        let provider = Box::pin(stream::iter(vec![Ok(concat!(
            "data: {\"id\":\"chatcmpl_blank\",\"object\":\"chat.completion.chunk\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"ok\"},\"finish_reason\":\"  \"}]}\n\n",
            "data: {\"id\":\"chatcmpl_blank\",\"object\":\"chat.completion.chunk\",\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n",
            "data: [DONE]\n\n",
        ).as_bytes().to_vec())]));
        let response = build_v3_hub_resp_inbound_02_from_openai_chat_provider_stream_events(
            provider,
            &observation,
        )
        .await
        .expect("blank intermediate reason must not reject the complete SSE stream");
        assert_eq!(response["choices"][0]["message"]["content"], "ok");
        assert_eq!(response["choices"][0]["finish_reason"], "stop");
    }

    #[tokio::test]
    async fn blank_chat_sse_reason_without_terminal_fails_as_incomplete_stream() {
        let observation = V3RuntimeStreamObservation::default();
        let provider = Box::pin(stream::iter(vec![Ok(b"data: {\"id\":\"chatcmpl_blank\",\"object\":\"chat.completion.chunk\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"ok\"},\"finish_reason\":\"  \"}]}\n\ndata: [DONE]\n\n".to_vec())]));
        let error = build_v3_hub_resp_inbound_02_from_openai_chat_provider_stream_events(
            provider,
            &observation,
        )
        .await
        .expect_err("blank reason and transport closeout cannot authorize success");
        assert!(
            matches!(error, V3ResponsesRelayRuntimeError::ProviderResponseEventCodec(message)
            if message.contains("EOF") && message.contains("terminal"))
        );
    }

    #[tokio::test]
    async fn empty_chat_sse_reason_without_terminal_fails_as_incomplete_stream() {
        let observation = V3RuntimeStreamObservation::default();
        let provider = Box::pin(stream::iter(vec![Ok(b"data: {\"id\":\"chatcmpl_empty\",\"object\":\"chat.completion.chunk\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"ok\"},\"finish_reason\":\"\"}]}\n\ndata: [DONE]\n\n".to_vec())]));
        let error = build_v3_hub_resp_inbound_02_from_openai_chat_provider_stream_events(
            provider,
            &observation,
        )
        .await
        .expect_err("empty reason and transport closeout cannot authorize success");
        assert!(
            matches!(error, V3ResponsesRelayRuntimeError::ProviderResponseEventCodec(message)
            if message.contains("EOF") && message.contains("terminal"))
        );
    }

    #[tokio::test]
    async fn nonstring_chat_sse_reason_fails_before_later_terminal() {
        let observation = V3RuntimeStreamObservation::default();
        let provider = Box::pin(stream::iter(vec![Ok(concat!(
            "data: {\"id\":\"chatcmpl_invalid\",\"object\":\"chat.completion.chunk\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"ok\"},\"finish_reason\":7}]}\n\n",
            "data: {\"id\":\"chatcmpl_invalid\",\"object\":\"chat.completion.chunk\",\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n",
        ).as_bytes().to_vec())]));
        let error = build_v3_hub_resp_inbound_02_from_openai_chat_provider_stream_events(
            provider,
            &observation,
        )
        .await
        .expect_err("malformed reason cannot be repaired by a later terminal");
        assert!(
            matches!(error, V3ResponsesRelayRuntimeError::ProviderResponseEventCodec(message)
            if message.contains("finish reason") && message.contains("string"))
        );
    }

    #[tokio::test]
    async fn done_without_content_still_fails_closed() {
        let observation = V3RuntimeStreamObservation::default();
        let provider = Box::pin(stream::iter(vec![Ok(b"data: [DONE]\n\n".to_vec())]));

        let error = build_v3_hub_resp_inbound_02_from_openai_chat_provider_stream_events(
            provider,
            &observation,
        )
        .await
        .expect_err("[DONE] without a semantic response must not become success");

        assert!(matches!(
            error,
            V3ResponsesRelayRuntimeError::ProviderResponseEventCodec(message)
                if message.contains("EOF") && message.contains("terminal")
        ));
    }

    #[tokio::test]
    async fn clean_eof_with_complete_tool_call_is_not_a_semantic_terminal() {
        let observation = V3RuntimeStreamObservation::default();
        let provider = Box::pin(stream::iter(vec![Ok(
            b"data: {\"id\":\"chatcmpl_tool_eof\",\"object\":\"chat.completion.chunk\",\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_1\",\"type\":\"function\",\"function\":{\"name\":\"lookup\",\"arguments\":\"{}\"}}]},\"finish_reason\":null}]}\n\n".to_vec(),
        )]));

        let error = build_v3_hub_resp_inbound_02_from_openai_chat_provider_stream_events(
            provider,
            &observation,
        )
        .await
        .expect_err("tool call without a semantic terminal must fail");

        assert!(matches!(
            error,
            V3ResponsesRelayRuntimeError::ProviderResponseEventCodec(message)
                if message.contains("EOF") && message.contains("terminal")
        ));
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

    #[tokio::test]
    async fn provider_length_finish_reason_materializes_partial_success() {
        let observation = V3RuntimeStreamObservation::default();
        let provider = Box::pin(stream::iter(vec![Ok(
            b"data: {\"id\":\"chatcmpl_length\",\"object\":\"chat.completion.chunk\",\"created\":7,\"model\":\"chat-model\",\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"content\":\"partial\"},\"finish_reason\":null}]}\n\ndata: {\"id\":\"chatcmpl_length\",\"object\":\"chat.completion.chunk\",\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"length\"}]}\n\n".to_vec(),
        )]));

        let response = build_v3_hub_resp_inbound_02_from_openai_chat_provider_stream_events(
            provider,
            &observation,
        )
        .await
        .expect("a provider length terminal is a valid partial completion");

        assert_eq!(response["choices"][0]["message"]["content"], "partial");
        assert_eq!(response["choices"][0]["finish_reason"], "length");
    }

    #[tokio::test]
    async fn provider_max_token_aliases_materialize_partial_success() {
        let observation = V3RuntimeStreamObservation::default();
        for finish_reason in ["max_tokens", "max_output_tokens"] {
            let provider = Box::pin(stream::iter(vec![Ok(
                format!(
                    "data: {{\"id\":\"chatcmpl_max_tokens\",\"object\":\"chat.completion.chunk\",\"created\":7,\"model\":\"chat-model\",\"choices\":[{{\"index\":0,\"delta\":{{\"role\":\"assistant\",\"content\":\"partial\"}},\"finish_reason\":\"{finish_reason}\"}}]}}\n\n"
                )
                .into_bytes(),
            )]));

            let response = build_v3_hub_resp_inbound_02_from_openai_chat_provider_stream_events(
                provider,
                &observation,
            )
            .await
            .expect("a provider max token alias terminal is a valid partial completion");

            assert_eq!(response["choices"][0]["message"]["content"], "partial");
            assert_eq!(response["choices"][0]["finish_reason"], "length");
        }
    }

    #[tokio::test]
    async fn provider_content_filter_finish_reason_survives_materialization() {
        let observation = V3RuntimeStreamObservation::default();
        let provider = Box::pin(stream::iter(vec![Ok(
            b"data: {\"id\":\"chatcmpl_filter\",\"object\":\"chat.completion.chunk\",\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"content_filter\"}]}\n\n".to_vec(),
        )]));

        let response = build_v3_hub_resp_inbound_02_from_openai_chat_provider_stream_events(
            provider,
            &observation,
        )
        .await
        .expect("content_filter is a representable provider terminal");
        assert_eq!(response["choices"][0]["finish_reason"], "content_filter");
        assert_eq!(response["choices"][0]["message"]["content"], "");
    }

    #[tokio::test]
    async fn responses_terminal_is_not_reopened_by_late_provider_read_error() {
        let observation = V3RuntimeStreamObservation::default();
        let provider = Box::pin(stream::iter(vec![
            Ok(b"data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_late_error\",\"status\":\"completed\",\"output\":[{\"type\":\"message\",\"content\":[{\"type\":\"output_text\",\"text\":\"done\"}]}]}}\n\n".to_vec()),
            Err(routecodex_v3_provider_responses::V3ProviderError::ResponseBody {
                request_id: "req-late-error".to_owned(),
                provider_id: "provider-late-error".to_owned(),
                reason: "provider read failed after terminal".to_owned(),
            }),
        ]));

        let response = build_v3_hub_resp_inbound_02_from_responses_provider_stream_events(
            provider,
            &observation,
        )
        .await
        .expect("a late provider read error cannot reopen a confirmed Responses terminal");

        assert_eq!(response["status"], "completed");
        assert_eq!(response["output"][0]["content"][0]["text"], "done");
    }

    #[tokio::test]
    async fn anthropic_terminal_is_not_reopened_by_late_provider_read_error() {
        let observation = V3RuntimeStreamObservation::default();
        let provider = Box::pin(stream::iter(vec![
            Ok(b"event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"id\":\"msg_late_error\",\"type\":\"message\",\"role\":\"assistant\",\"model\":\"claude\",\"content\":[]}}\n\nevent: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}\n\nevent: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"done\"}}\n\nevent: message_delta\ndata: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"}}\n\nevent: message_stop\ndata: {\"type\":\"message_stop\"}\n\n".to_vec()),
            Err(routecodex_v3_provider_responses::V3ProviderError::ResponseBody {
                request_id: "req-anthropic-late-error".to_owned(),
                provider_id: "provider-anthropic-late-error".to_owned(),
                reason: "provider read failed after message_stop".to_owned(),
            }),
        ]));

        // Non-empty content must still pass the complete-attempt acceptance
        // judgment, and a late read error must not reopen the terminal.
        let response =
            build_v3_hub_resp_inbound_02_from_provider_stream_events_for_protocol_with_context(
                V3HubProviderWireProtocol::Anthropic,
                provider,
                &observation,
                &V3AnthropicResponsesProjectionContext::default(),
            )
            .await
            .expect("a late provider read error cannot reopen a confirmed Anthropic terminal");

        assert_eq!(response["status"], "completed");
        assert_eq!(response["output"][0]["content"][0]["text"], "done");
    }

    #[tokio::test]
    async fn anthropic_empty_complete_terminal_is_internal_502() {
        let observation = V3RuntimeStreamObservation::default();
        let provider = Box::pin(stream::iter(vec![Ok(
            b"event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"id\":\"msg_empty_terminal\",\"type\":\"message\",\"role\":\"assistant\",\"model\":\"claude\",\"content\":[]}}\n\nevent: message_delta\ndata: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"}}\n\nevent: message_stop\ndata: {\"type\":\"message_stop\"}\n\n".to_vec(),
        )]));

        // The empty-attempt judgment is owned by the complete-attempt success
        // acceptance dispatcher, so drive it through that entry point.
        let error =
            build_v3_hub_resp_inbound_02_from_provider_stream_events_for_protocol_with_context(
                V3HubProviderWireProtocol::Anthropic,
                provider,
                &observation,
                &V3AnthropicResponsesProjectionContext::default(),
            )
            .await
            .expect_err("an empty complete Anthropic attempt must become an internal 502");

        assert!(matches!(
            error,
            V3ResponsesRelayRuntimeError::ProviderResponseSemanticFailure {
                status: 502,
                ref code,
                ..
            } if code == "provider_response_empty"
        ));
    }

    #[tokio::test]
    async fn chat_terminal_is_not_reopened_by_late_provider_read_error() {
        let observation = V3RuntimeStreamObservation::default();
        let provider = Box::pin(stream::iter(vec![
            Ok(b"data: {\"id\":\"chatcmpl_late_error\",\"object\":\"chat.completion.chunk\",\"created\":7,\"model\":\"chat-model\",\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"content\":\"done\"},\"finish_reason\":null}]}\n\ndata: {\"id\":\"chatcmpl_late_error\",\"object\":\"chat.completion.chunk\",\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n".to_vec()),
            Err(routecodex_v3_provider_responses::V3ProviderError::ResponseBody {
                request_id: "req-chat-late-error".to_owned(),
                provider_id: "provider-chat-late-error".to_owned(),
                reason: "provider read failed after finish_reason".to_owned(),
            }),
        ]));

        let response = build_v3_hub_resp_inbound_02_from_openai_chat_provider_stream_events(
            provider,
            &observation,
        )
        .await
        .expect("a late provider read error cannot reopen a confirmed Chat terminal");

        assert_eq!(response["choices"][0]["finish_reason"], "stop");
    }
}
