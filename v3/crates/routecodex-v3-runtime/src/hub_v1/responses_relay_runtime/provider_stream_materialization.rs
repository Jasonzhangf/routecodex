use super::*;
use super::responses_relay_diagnostics::anthropic_cyber_refusal_error_from_payload;

pub(super) async fn build_v3_hub_resp_inbound_02_from_responses_provider_stream_events(
    mut provider: routecodex_v3_provider_responses::V3ProviderSseStream,
    observation: &V3RuntimeStreamObservation,
) -> Result<Value, V3ResponsesRelayRuntimeError> {
    use futures_util::StreamExt;

    let _owner = V3_RESPONSES_RELAY_PROVIDER_EVENT_CODEC_OWNER;
    let mut decoder = SseIncrementalDecoder::new(SseTransportLimits::default());
    let mut terminal_response: Option<Value> = None;
    let mut response_scaffold: Option<Value> = None;
    let mut output_items: Vec<Value> = Vec::new();
    let mut output_text = String::new();
    while let Some(chunk) = provider.next().await {
        let chunk = chunk?;
        if let Some(response) = observe_v3_runtime_responses_sse_transport_chunk(
            &chunk,
            &mut decoder,
            observation,
            &mut response_scaffold,
            &mut output_items,
            &mut output_text,
        )? {
            terminal_response = Some(response);
        }
    }
    decoder
        .finish()
        .map_err(|error| V3ResponsesRelayRuntimeError::ProviderSseTransport(error.to_string()))?;
    terminal_response.ok_or_else(|| {
        V3ResponsesRelayRuntimeError::ProviderResponseEventCodec(
            V3_RESPONSES_RELAY_PROVIDER_EVENT_EOF_WITHOUT_TERMINAL_MESSAGE.to_string(),
        )
    })
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
    provider: routecodex_v3_provider_responses::V3ProviderSseStream,
    observation: &V3RuntimeStreamObservation,
    anthropic_context: &V3AnthropicResponsesProjectionContext,
) -> Result<Value, V3ResponsesRelayRuntimeError> {
    match provider_protocol {
        V3HubProviderWireProtocol::Responses => {
            build_v3_hub_resp_inbound_02_from_responses_provider_stream_events(
                provider,
                observation,
            )
            .await
        }
        V3HubProviderWireProtocol::OpenAiChat => {
            build_v3_hub_resp_inbound_02_from_openai_chat_provider_stream_events(
                provider,
                observation,
            )
            .await
        }
        V3HubProviderWireProtocol::Anthropic => {
            build_v3_hub_resp_inbound_02_from_anthropic_provider_stream_events_with_context(
                provider,
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

#[derive(Default)]
struct V3AnthropicProviderStreamBlock {
    kind: Option<String>,
    id: Option<String>,
    name: Option<String>,
    text: String,
    encrypted_content: Option<String>,
    input: Option<Value>,
    input_json_delta: String,
    stopped: bool,
}

#[derive(Default)]
pub(super) struct V3AnthropicProviderStreamState {
    message: Map<String, Value>,
    content_blocks: BTreeMap<usize, V3AnthropicProviderStreamBlock>,
    usage: Map<String, Value>,
    message_start_seen: bool,
    message_stop_seen: bool,
}

pub(crate) async fn build_v3_hub_resp_inbound_02_from_anthropic_provider_stream_events_with_context(
    mut provider: routecodex_v3_provider_responses::V3ProviderSseStream,
    observation: &V3RuntimeStreamObservation,
    anthropic_context: &V3AnthropicResponsesProjectionContext,
) -> Result<Value, V3ResponsesRelayRuntimeError> {
    use futures_util::StreamExt;

    let _owner = V3_RESPONSES_RELAY_PROVIDER_EVENT_CODEC_OWNER;
    let mut decoder = SseIncrementalDecoder::new(SseTransportLimits::default());
    let mut state = V3AnthropicProviderStreamState::default();
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
                if !state.message_stop_seen {
                    return Err(V3ResponsesRelayRuntimeError::ProviderResponseEventCodec(
                        "Anthropic provider event stream emitted [DONE] before message_stop"
                            .to_string(),
                    ));
                }
                done_seen = true;
                continue;
            }
            if done_seen || state.message_stop_seen {
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
            characterize_v3_anthropic_provider_raw_to_hub_response_semantic(
                event.clone(),
                V3HubProviderWireProtocol::Anthropic,
                V3HubTransportIntent::Sse,
            )
            .map_err(|error| {
                V3ResponsesRelayRuntimeError::ProviderResponseEventCodec(error.to_string())
            })?;
            collect_v3_anthropic_provider_stream_event(event, &mut state)?;
        }
    }
    decoder
        .finish()
        .map_err(|error| V3ResponsesRelayRuntimeError::ProviderSseTransport(error.to_string()))?;
    if !state.message_stop_seen {
        return Err(V3ResponsesRelayRuntimeError::ProviderResponseEventCodec(
            "Anthropic provider event stream ended without message_stop".to_string(),
        ));
    }
    let anthropic_message = build_v3_anthropic_message_from_provider_stream_state(state)?;
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

pub(super) fn collect_v3_anthropic_provider_stream_event(
    event: Value,
    state: &mut V3AnthropicProviderStreamState,
) -> Result<(), V3ResponsesRelayRuntimeError> {
    let event_object = event.as_object().ok_or_else(|| {
        V3ResponsesRelayRuntimeError::ProviderResponseEventCodec(
            "Anthropic provider event stream event must be an object".to_string(),
        )
    })?;
    let event_type = event_object
        .get("type")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            V3ResponsesRelayRuntimeError::ProviderResponseEventCodec(
                "Anthropic provider event stream event missing type".to_string(),
            )
        })?;
    match event_type {
        "message_start" => {
            let message = event_object
                .get("message")
                .and_then(Value::as_object)
                .ok_or_else(|| {
                    V3ResponsesRelayRuntimeError::ProviderResponseEventCodec(
                        "Anthropic provider event stream message_start missing message object"
                            .to_string(),
                    )
                })?;
            collect_v3_anthropic_provider_message_start(state, message)?;
            merge_v3_anthropic_provider_stream_usage(&mut state.usage, message.get("usage"))?;
        }
        "content_block_start" => {
            require_v3_anthropic_provider_message_start(state, event_type)?;
            let index = read_v3_anthropic_provider_stream_index(event_object, event_type)?;
            if state.content_blocks.contains_key(&index) {
                return Err(V3ResponsesRelayRuntimeError::ProviderResponseEventCodec(
                    format!(
                        "Anthropic provider event stream content_block_start duplicated index {index}"
                    ),
                ));
            }
            let content_block = event_object
                .get("content_block")
                .and_then(Value::as_object)
                .ok_or_else(|| {
                    V3ResponsesRelayRuntimeError::ProviderResponseEventCodec(
                        "Anthropic provider event stream content_block_start missing content_block object"
                            .to_string(),
                    )
                })?;
            let kind = read_v3_trimmed_string(content_block.get("type")).ok_or_else(|| {
                V3ResponsesRelayRuntimeError::ProviderResponseEventCodec(
                    "Anthropic provider event stream content_block_start missing content_block.type"
                        .to_string(),
                )
            })?;
            match kind.as_str() {
                "thinking" => validate_v3_anthropic_reasoning_object_keys(
                    content_block,
                    &["type", "thinking", "signature"],
                )?,
                "redacted_thinking" => {
                    validate_v3_anthropic_reasoning_object_keys(content_block, &["type", "data"])?
                }
                _ => {}
            }
            let mut block = V3AnthropicProviderStreamBlock {
                kind: Some(kind.clone()),
                id: read_v3_trimmed_string(content_block.get("id")),
                name: read_v3_trimmed_string(content_block.get("name")),
                input: content_block.get("input").cloned(),
                ..V3AnthropicProviderStreamBlock::default()
            };
            match kind.as_str() {
                "text" => {
                    if let Some(text) = content_block.get("text").and_then(Value::as_str) {
                        block.text.push_str(text);
                    }
                }
                "thinking" => {
                    if let Some(value) = content_block.get("thinking") {
                        let thinking = value.as_str().ok_or_else(|| {
                            V3ResponsesRelayRuntimeError::ProviderResponseEventCodec(
                                "Anthropic provider event stream thinking block has non-string thinking"
                                    .to_string(),
                            )
                        })?;
                        block.text.push_str(thinking);
                    }
                    if let Some(value) = content_block.get("signature") {
                        let signature = value.as_str().ok_or_else(|| {
                            V3ResponsesRelayRuntimeError::ProviderResponseEventCodec(
                                "Anthropic codec malformed reasoning content".to_string(),
                            )
                        })?;
                        if signature.trim().is_empty() {
                            return Err(V3ResponsesRelayRuntimeError::ProviderResponseEventCodec(
                                "Anthropic codec malformed reasoning content".to_string(),
                            ));
                        }
                        block.encrypted_content = Some(signature.to_string());
                    }
                }
                "redacted_thinking" => {
                    let data = content_block
                        .get("data")
                        .and_then(Value::as_str)
                        .ok_or_else(|| {
                            V3ResponsesRelayRuntimeError::ProviderResponseEventCodec(
                                "Anthropic codec malformed reasoning content".to_string(),
                            )
                        })?;
                    if data.trim().is_empty() {
                        return Err(V3ResponsesRelayRuntimeError::ProviderResponseEventCodec(
                            "Anthropic codec malformed reasoning content".to_string(),
                        ));
                    }
                    block.encrypted_content = Some(data.to_string());
                }
                "tool_use" => {}
                other => {
                    return Err(V3ResponsesRelayRuntimeError::ProviderResponseEventCodec(
                        format!(
                            "Anthropic provider event stream content block type {other} is unsupported"
                        ),
                    ));
                }
            }
            state.content_blocks.insert(index, block);
        }
        "content_block_delta" => {
            require_v3_anthropic_provider_message_start(state, event_type)?;
            let index = read_v3_anthropic_provider_stream_index(event_object, event_type)?;
            let block = state.content_blocks.get_mut(&index).ok_or_else(|| {
                V3ResponsesRelayRuntimeError::ProviderResponseEventCodec(format!(
                    "Anthropic provider event stream content_block_delta missing start for index {index}"
                ))
            })?;
            if block.stopped {
                return Err(V3ResponsesRelayRuntimeError::ProviderResponseEventCodec(
                    format!(
                        "Anthropic provider event stream content_block_delta followed stop for index {index}"
                    ),
                ));
            }
            let delta = event_object
                .get("delta")
                .and_then(Value::as_object)
                .ok_or_else(|| {
                    V3ResponsesRelayRuntimeError::ProviderResponseEventCodec(
                        "Anthropic provider event stream content_block_delta missing delta object"
                            .to_string(),
                    )
                })?;
            match delta.get("type").and_then(Value::as_str) {
                Some("text_delta") => {
                    if block.kind.as_deref() != Some("text") {
                        return Err(V3ResponsesRelayRuntimeError::ProviderResponseEventCodec(
                            format!(
                                "Anthropic provider event stream text_delta does not match block type {:?}",
                                block.kind
                            ),
                        ));
                    }
                    let text = delta.get("text").and_then(Value::as_str).ok_or_else(|| {
                        V3ResponsesRelayRuntimeError::ProviderResponseEventCodec(
                            "Anthropic provider event stream text_delta missing text".to_string(),
                        )
                    })?;
                    block.text.push_str(text);
                }
                Some("thinking_delta") => {
                    validate_v3_anthropic_reasoning_object_keys(delta, &["type", "thinking"])?;
                    if block.kind.as_deref() != Some("thinking") {
                        return Err(V3ResponsesRelayRuntimeError::ProviderResponseEventCodec(
                            format!(
                                "Anthropic provider event stream thinking_delta does not match block type {:?}",
                                block.kind
                            ),
                        ));
                    }
                    let thinking =
                        delta
                            .get("thinking")
                            .and_then(Value::as_str)
                            .ok_or_else(|| {
                                V3ResponsesRelayRuntimeError::ProviderResponseEventCodec(
                                "Anthropic provider event stream thinking_delta missing thinking"
                                    .to_string(),
                            )
                            })?;
                    block.text.push_str(thinking);
                }
                Some("input_json_delta") => {
                    if block.kind.as_deref() != Some("tool_use") {
                        return Err(V3ResponsesRelayRuntimeError::ProviderResponseEventCodec(
                            format!(
                                "Anthropic provider event stream input_json_delta does not match block type {:?}",
                                block.kind
                            ),
                        ));
                    }
                    let partial_json = delta
                        .get("partial_json")
                        .and_then(Value::as_str)
                        .ok_or_else(|| {
                            V3ResponsesRelayRuntimeError::ProviderResponseEventCodec(
                                "Anthropic provider event stream input_json_delta missing partial_json"
                                    .to_string(),
                            )
                        })?;
                    block.input_json_delta.push_str(partial_json);
                }
                Some("signature_delta") => {
                    validate_v3_anthropic_reasoning_object_keys(delta, &["type", "signature"])?;
                    if block.kind.as_deref() != Some("thinking") {
                        return Err(V3ResponsesRelayRuntimeError::ProviderResponseEventCodec(
                            format!(
                                "Anthropic provider event stream signature_delta does not match block type {:?}",
                                block.kind
                            ),
                        ));
                    }
                    let signature =
                        delta
                            .get("signature")
                            .and_then(Value::as_str)
                            .ok_or_else(|| {
                                V3ResponsesRelayRuntimeError::ProviderResponseEventCodec(
                                    "Anthropic codec malformed reasoning content".to_string(),
                                )
                            })?;
                    if signature.trim().is_empty() {
                        return Err(V3ResponsesRelayRuntimeError::ProviderResponseEventCodec(
                            "Anthropic codec malformed reasoning content".to_string(),
                        ));
                    }
                    let current = block.encrypted_content.get_or_insert_with(String::new);
                    current.push_str(signature);
                }
                Some("citations_delta") => {}
                Some(other) => {
                    return Err(V3ResponsesRelayRuntimeError::ProviderResponseEventCodec(
                        format!(
                            "Anthropic provider event stream delta type {other} is unsupported"
                        ),
                    ));
                }
                None => {
                    return Err(V3ResponsesRelayRuntimeError::ProviderResponseEventCodec(
                        "Anthropic provider event stream content_block_delta missing delta.type"
                            .to_string(),
                    ));
                }
            }
        }
        "content_block_stop" => {
            require_v3_anthropic_provider_message_start(state, event_type)?;
            let index = read_v3_anthropic_provider_stream_index(event_object, event_type)?;
            let block = state.content_blocks.get_mut(&index).ok_or_else(|| {
                V3ResponsesRelayRuntimeError::ProviderResponseEventCodec(format!(
                    "Anthropic provider event stream content_block_stop missing start for index {index}"
                ))
            })?;
            if block.stopped {
                return Err(V3ResponsesRelayRuntimeError::ProviderResponseEventCodec(
                    format!(
                        "Anthropic provider event stream duplicated content_block_stop for index {index}"
                    ),
                ));
            }
            block.stopped = true;
        }
        "message_delta" => {
            require_v3_anthropic_provider_message_start(state, event_type)?;
            if let Some(delta) = event_object.get("delta").and_then(Value::as_object) {
                for key in ["stop_reason", "stop_sequence"] {
                    if let Some(value) = delta.get(key) {
                        state.message.insert(key.to_string(), value.clone());
                    }
                }
            }
            merge_v3_anthropic_provider_stream_usage(&mut state.usage, event_object.get("usage"))?;
        }
        "message_stop" => {
            require_v3_anthropic_provider_message_start(state, event_type)?;
            close_v3_anthropic_provider_textual_stream_blocks_at_message_stop(state);
            state.message_stop_seen = true;
        }
        "ping" => {}
        "error" => {
            let message = event
                .pointer("/error/message")
                .and_then(Value::as_str)
                .filter(|message| !message.trim().is_empty())
                .unwrap_or("Anthropic provider event stream emitted an error event");
            return Err(V3ResponsesRelayRuntimeError::ProviderResponseEventCodec(
                message.to_string(),
            ));
        }
        other => {
            return Err(V3ResponsesRelayRuntimeError::ProviderResponseEventCodec(
                format!("Anthropic provider event stream event type {other} is unsupported"),
            ));
        }
    }
    Ok(())
}

fn validate_v3_anthropic_reasoning_object_keys(
    object: &Map<String, Value>,
    allowed: &[&str],
) -> Result<(), V3ResponsesRelayRuntimeError> {
    if object.keys().any(|key| !allowed.contains(&key.as_str())) {
        return Err(V3ResponsesRelayRuntimeError::ProviderResponseEventCodec(
            "Anthropic codec malformed reasoning content".to_string(),
        ));
    }
    Ok(())
}

fn close_v3_anthropic_provider_textual_stream_blocks_at_message_stop(
    state: &mut V3AnthropicProviderStreamState,
) {
    for block in state.content_blocks.values_mut() {
        if block.stopped {
            continue;
        }
        if matches!(
            block.kind.as_deref(),
            Some("text" | "thinking" | "redacted_thinking")
        ) {
            block.stopped = true;
        }
    }
}

fn collect_v3_anthropic_provider_message_start(
    state: &mut V3AnthropicProviderStreamState,
    message: &Map<String, Value>,
) -> Result<(), V3ResponsesRelayRuntimeError> {
    if state.message_start_seen {
        merge_v3_anthropic_provider_duplicate_message_start(state, message)?;
        return Ok(());
    }
    for key in [
        "id",
        "type",
        "role",
        "model",
        "stop_reason",
        "stop_sequence",
        "stop_details",
    ] {
        if let Some(value) = message.get(key) {
            state.message.insert(key.to_string(), value.clone());
        }
    }
    state.message_start_seen = true;
    Ok(())
}

fn merge_v3_anthropic_provider_duplicate_message_start(
    state: &mut V3AnthropicProviderStreamState,
    message: &Map<String, Value>,
) -> Result<(), V3ResponsesRelayRuntimeError> {
    if state.message_stop_seen {
        return Err(V3ResponsesRelayRuntimeError::ProviderResponseEventCodec(
            "Anthropic provider event stream emitted duplicate message_start after message_stop"
                .to_string(),
        ));
    }
    if !state.content_blocks.is_empty() {
        return Err(V3ResponsesRelayRuntimeError::ProviderResponseEventCodec(
            "Anthropic provider event stream emitted duplicate message_start after content_block_start"
                .to_string(),
        ));
    }
    ensure_v3_anthropic_duplicate_message_start_field_matches(state, message, "id")?;
    ensure_v3_anthropic_duplicate_message_start_field_matches(state, message, "type")?;
    ensure_v3_anthropic_duplicate_message_start_field_matches(state, message, "role")?;
    for key in [
        "id",
        "type",
        "role",
        "model",
        "stop_reason",
        "stop_sequence",
        "stop_details",
    ] {
        let Some(value) = message.get(key) else {
            continue;
        };
        if value.is_null() && state.message.contains_key(key) {
            continue;
        }
        state.message.insert(key.to_string(), value.clone());
    }
    Ok(())
}

fn ensure_v3_anthropic_duplicate_message_start_field_matches(
    state: &V3AnthropicProviderStreamState,
    message: &Map<String, Value>,
    key: &str,
) -> Result<(), V3ResponsesRelayRuntimeError> {
    let Some(existing) = state.message.get(key).filter(|value| !value.is_null()) else {
        return Ok(());
    };
    let Some(incoming) = message.get(key).filter(|value| !value.is_null()) else {
        return Ok(());
    };
    if existing == incoming {
        return Ok(());
    }
    Err(V3ResponsesRelayRuntimeError::ProviderResponseEventCodec(
        format!(
            "Anthropic provider event stream emitted duplicate message_start with different {key}"
        ),
    ))
}

fn require_v3_anthropic_provider_message_start(
    state: &V3AnthropicProviderStreamState,
    event_type: &str,
) -> Result<(), V3ResponsesRelayRuntimeError> {
    if state.message_start_seen {
        Ok(())
    } else {
        Err(V3ResponsesRelayRuntimeError::ProviderResponseEventCodec(
            format!("Anthropic provider event stream emitted {event_type} before message_start"),
        ))
    }
}

fn read_v3_anthropic_provider_stream_index(
    event: &Map<String, Value>,
    event_type: &str,
) -> Result<usize, V3ResponsesRelayRuntimeError> {
    event
        .get("index")
        .and_then(Value::as_u64)
        .map(|index| index as usize)
        .ok_or_else(|| {
            V3ResponsesRelayRuntimeError::ProviderResponseEventCodec(format!(
                "Anthropic provider event stream {event_type} missing index"
            ))
        })
}

fn merge_v3_anthropic_provider_stream_usage(
    target: &mut Map<String, Value>,
    usage: Option<&Value>,
) -> Result<(), V3ResponsesRelayRuntimeError> {
    let Some(usage) = usage else {
        return Ok(());
    };
    let usage = usage.as_object().ok_or_else(|| {
        V3ResponsesRelayRuntimeError::ProviderResponseEventCodec(
            "Anthropic provider event stream usage must be an object".to_string(),
        )
    })?;
    for (key, value) in usage {
        target.insert(key.clone(), value.clone());
    }
    Ok(())
}

fn build_v3_anthropic_message_from_provider_stream_state(
    mut state: V3AnthropicProviderStreamState,
) -> Result<Value, V3ResponsesRelayRuntimeError> {
    if !state.message_start_seen {
        return Err(V3ResponsesRelayRuntimeError::ProviderResponseEventCodec(
            "Anthropic provider event stream response missing message_start".to_string(),
        ));
    }
    let mut content = Vec::with_capacity(state.content_blocks.len());
    for (index, block) in state.content_blocks {
        if !block.stopped {
            return Err(V3ResponsesRelayRuntimeError::ProviderResponseEventCodec(
                format!(
                    "Anthropic provider event stream content block {index} ended without content_block_stop"
                ),
            ));
        }
        match block.kind.as_deref() {
            Some("text") => content.push(json!({
                "type":"text",
                "text":block.text
            })),
            Some("thinking") => {
                let mut item = json!({
                    "type":"thinking",
                    "thinking":block.text
                });
                if let Some(encrypted_content) = block.encrypted_content {
                    item["signature"] = Value::String(encrypted_content);
                }
                content.push(item);
            }
            Some("redacted_thinking") => {
                let encrypted_content = block.encrypted_content.ok_or_else(|| {
                    V3ResponsesRelayRuntimeError::ProviderResponseEventCodec(format!(
                        "Anthropic provider event stream redacted_thinking block {index} missing data"
                    ))
                })?;
                content.push(json!({
                    "type":"redacted_thinking",
                    "data":encrypted_content
                }));
            }
            Some("tool_use") => {
                let id = block.id.ok_or_else(|| {
                    V3ResponsesRelayRuntimeError::ProviderResponseEventCodec(format!(
                        "Anthropic provider event stream tool_use block {index} missing id"
                    ))
                })?;
                let name = block.name.ok_or_else(|| {
                    V3ResponsesRelayRuntimeError::ProviderResponseEventCodec(format!(
                        "Anthropic provider event stream tool_use block {index} missing name"
                    ))
                })?;
                let input = if block.input_json_delta.is_empty() {
                    block.input.unwrap_or_else(|| Value::Object(Map::new()))
                } else {
                    serde_json::from_str::<Value>(&block.input_json_delta).map_err(|error| {
                        V3ResponsesRelayRuntimeError::ProviderResponseEventCodec(format!(
                            "Anthropic provider event stream tool_use block {index} input_json_delta is malformed: {error}"
                        ))
                    })?
                };
                if !input.is_object() {
                    return Err(V3ResponsesRelayRuntimeError::ProviderResponseEventCodec(
                        format!(
                            "Anthropic provider event stream tool_use block {index} input must be an object"
                        ),
                    ));
                }
                content.push(json!({
                    "type":"tool_use",
                    "id":id,
                    "name":name,
                    "input":input
                }));
            }
            Some(other) => {
                return Err(V3ResponsesRelayRuntimeError::ProviderResponseEventCodec(
                    format!(
                        "Anthropic provider event stream content block type {other} is unsupported"
                    ),
                ));
            }
            None => {
                return Err(V3ResponsesRelayRuntimeError::ProviderResponseEventCodec(
                    format!("Anthropic provider event stream content block {index} missing type"),
                ));
            }
        }
    }
    state
        .message
        .entry("type".to_string())
        .or_insert_with(|| Value::String("message".to_string()));
    state
        .message
        .entry("role".to_string())
        .or_insert_with(|| Value::String("assistant".to_string()));
    state
        .message
        .insert("content".to_string(), Value::Array(content));
    if !state.usage.is_empty() {
        state
            .message
            .insert("usage".to_string(), Value::Object(state.usage));
    }
    Ok(Value::Object(state.message))
}

#[derive(Default)]
struct V3OpenAiChatStreamChoice {
    role: Option<String>,
    content: String,
    reasoning_content: String,
    finish_reason: Option<Value>,
    tool_calls: BTreeMap<usize, V3OpenAiChatStreamToolCall>,
}

#[derive(Default)]
struct V3OpenAiChatStreamToolCall {
    id: Option<String>,
    kind: Option<String>,
    function_name: Option<String>,
    function_arguments: String,
}

pub(super) async fn build_v3_hub_resp_inbound_02_from_openai_chat_provider_stream_events(
    mut provider: routecodex_v3_provider_responses::V3ProviderSseStream,
    observation: &V3RuntimeStreamObservation,
) -> Result<Value, V3ResponsesRelayRuntimeError> {
    use futures_util::StreamExt;

    let _owner = V3_RESPONSES_RELAY_PROVIDER_EVENT_CODEC_OWNER;
    let mut decoder = SseIncrementalDecoder::new(SseTransportLimits::default());
    let mut response_id: Option<String> = None;
    let mut model: Option<String> = None;
    let mut created: Option<Value> = None;
    let mut usage: Option<Value> = None;
    let mut choices = BTreeMap::<usize, V3OpenAiChatStreamChoice>::new();
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
            let Some(data) = parse_v3_runtime_sse_frame_fields(&frame)? else {
                continue;
            };
            if data == "[DONE]" {
                if !terminal_seen {
                    return Err(V3ResponsesRelayRuntimeError::ProviderResponseEventCodec(
                        "OpenAI Chat provider event stream emitted [DONE] before terminal finish_reason"
                            .to_string(),
                    ));
                }
                done_seen = true;
                continue;
            }
            if done_seen {
                if is_v3_openai_chat_ping_tail_frame(&data) {
                    // Some OpenAI-compatible gateways (e.g. Console Go) emit a
                    // non-semantic `{"type":"ping"}` cost/keep-alive frame after
                    // the terminal `[DONE]`. It carries no output/usage content,
                    // so it is a benign protocol tail frame, not stream corruption.
                    continue;
                }
                return Err(V3ResponsesRelayRuntimeError::ProviderResponseEventCodec(
                    "OpenAI Chat provider event stream emitted data after [DONE]".to_string(),
                ));
            }
            let event: Value = serde_json::from_str(&data).map_err(|error| {
                V3ResponsesRelayRuntimeError::ProviderResponseEventCodec(format!(
                    "OpenAI Chat provider event stream event is malformed: {error}"
                ))
            })?;
            if let Some(message) = extract_v3_provider_event_error_payload_message(&event) {
                return Err(V3ResponsesRelayRuntimeError::ProviderResponseEventCodec(
                    message,
                ));
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
            observation
                .record_provider_event_json(&event)
                .map_err(V3ResponsesRelayRuntimeError::ProviderResponseEventCodec)?;
            collect_openai_chat_stream_event(
                event,
                V3OpenAiChatStreamCollectionState {
                    response_id: &mut response_id,
                    model: &mut model,
                    created: &mut created,
                    usage: &mut usage,
                    choices: &mut choices,
                    terminal_seen: &mut terminal_seen,
                    observation,
                },
            )?;
        }
    }
    decoder
        .finish()
        .map_err(|error| V3ResponsesRelayRuntimeError::ProviderSseTransport(error.to_string()))?;
    if !terminal_seen {
        return Err(V3ResponsesRelayRuntimeError::ProviderResponseEventCodec(
            "OpenAI Chat provider event stream ended without terminal finish_reason".to_string(),
        ));
    }
    build_openai_chat_completion_from_stream_state(response_id, model, created, usage, choices)
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

struct V3OpenAiChatStreamCollectionState<'a> {
    response_id: &'a mut Option<String>,
    model: &'a mut Option<String>,
    created: &'a mut Option<Value>,
    usage: &'a mut Option<Value>,
    choices: &'a mut BTreeMap<usize, V3OpenAiChatStreamChoice>,
    terminal_seen: &'a mut bool,
    observation: &'a V3RuntimeStreamObservation,
}

fn collect_openai_chat_stream_event(
    event: Value,
    state: V3OpenAiChatStreamCollectionState<'_>,
) -> Result<(), V3ResponsesRelayRuntimeError> {
    let event_object = event.as_object().ok_or_else(|| {
        V3ResponsesRelayRuntimeError::ProviderResponseEventCodec(
            "OpenAI Chat provider event stream event must be an object".to_string(),
        )
    })?;
    if state.response_id.is_none() {
        *state.response_id = read_v3_trimmed_string(event_object.get("id"));
    }
    if state.model.is_none() {
        *state.model = read_v3_trimmed_string(event_object.get("model"));
    }
    if state.created.is_none() {
        *state.created = event_object.get("created").cloned();
    }
    if let Some(next_usage) = event_object.get("usage").filter(|value| !value.is_null()) {
        *state.usage = Some(next_usage.clone());
    }
    let Some(event_choices) = event_object.get("choices").and_then(Value::as_array) else {
        return Ok(());
    };
    for choice_value in event_choices {
        let choice_object = choice_value.as_object().ok_or_else(|| {
            V3ResponsesRelayRuntimeError::ProviderResponseEventCodec(
                "OpenAI Chat provider event stream choice must be an object".to_string(),
            )
        })?;
        let index = choice_object
            .get("index")
            .and_then(Value::as_u64)
            .unwrap_or(0) as usize;
        let choice = state.choices.entry(index).or_default();
        if let Some(finish_reason) = choice_object
            .get("finish_reason")
            .filter(|value| !value.is_null())
        {
            choice.finish_reason = Some(finish_reason.clone());
            *state.terminal_seen = true;
            if let Some(reason) = finish_reason.as_str() {
                state
                    .observation
                    .record_finish_reason(reason)
                    .map_err(V3ResponsesRelayRuntimeError::ProviderResponseEventCodec)?;
            }
        }
        let Some(delta) = choice_object.get("delta").and_then(Value::as_object) else {
            continue;
        };
        choice.role = read_v3_trimmed_string(delta.get("role")).or(choice.role.take());
        if let Some(content) = delta.get("content").and_then(Value::as_str) {
            choice.content.push_str(content);
        }
        if let Some(reasoning) = delta
            .get("reasoning_content")
            .or_else(|| delta.get("reasoning"))
            .and_then(Value::as_str)
        {
            choice.reasoning_content.push_str(reasoning);
        }
        if let Some(tool_call_deltas) = delta.get("tool_calls").and_then(Value::as_array) {
            collect_openai_chat_stream_tool_call_deltas(choice, tool_call_deltas)?;
        }
    }
    Ok(())
}

fn collect_openai_chat_stream_tool_call_deltas(
    choice: &mut V3OpenAiChatStreamChoice,
    tool_call_deltas: &[Value],
) -> Result<(), V3ResponsesRelayRuntimeError> {
    for tool_call_value in tool_call_deltas {
        let tool_call_object = tool_call_value.as_object().ok_or_else(|| {
            V3ResponsesRelayRuntimeError::ProviderResponseEventCodec(
                "OpenAI Chat provider event stream tool_call delta must be an object".to_string(),
            )
        })?;
        let index = tool_call_object
            .get("index")
            .and_then(Value::as_u64)
            .unwrap_or(0) as usize;
        let tool_call = choice.tool_calls.entry(index).or_default();
        tool_call.id = read_v3_trimmed_string(tool_call_object.get("id")).or(tool_call.id.take());
        tool_call.kind =
            read_v3_trimmed_string(tool_call_object.get("type")).or(tool_call.kind.take());
        if let Some(function) = tool_call_object.get("function").and_then(Value::as_object) {
            tool_call.function_name =
                read_v3_trimmed_string(function.get("name")).or(tool_call.function_name.take());
            if let Some(arguments) = function.get("arguments").and_then(Value::as_str) {
                tool_call.function_arguments.push_str(arguments);
            }
        }
    }
    Ok(())
}

fn build_openai_chat_completion_from_stream_state(
    response_id: Option<String>,
    model: Option<String>,
    created: Option<Value>,
    usage: Option<Value>,
    choices: BTreeMap<usize, V3OpenAiChatStreamChoice>,
) -> Result<Value, V3ResponsesRelayRuntimeError> {
    if choices.is_empty() {
        return Err(V3ResponsesRelayRuntimeError::ProviderResponseEventCodec(
            "OpenAI Chat provider event stream response did not contain choices".to_string(),
        ));
    }
    let mut materialized_choices = Vec::new();
    for (index, choice) in choices {
        let mut message = Map::new();
        message.insert(
            "role".to_string(),
            Value::String(choice.role.unwrap_or_else(|| "assistant".to_string())),
        );
        message.insert("content".to_string(), Value::String(choice.content));
        if !choice.reasoning_content.is_empty() {
            message.insert(
                "reasoning_content".to_string(),
                Value::String(choice.reasoning_content),
            );
        }
        if !choice.tool_calls.is_empty() {
            let mut tool_calls = Vec::new();
            for (tool_index, tool_call) in choice.tool_calls {
                let id = tool_call.id.ok_or_else(|| {
                    V3ResponsesRelayRuntimeError::ProviderResponseEventCodec(format!(
                        "OpenAI Chat provider event stream tool_call[{tool_index}] missing id"
                    ))
                })?;
                let function_name = tool_call.function_name.ok_or_else(|| {
                    V3ResponsesRelayRuntimeError::ProviderResponseEventCodec(format!(
                        "OpenAI Chat provider event stream tool_call[{tool_index}] missing function.name"
                    ))
                })?;
                tool_calls.push(json!({
                    "id": id,
                    "type": tool_call.kind.unwrap_or_else(|| "function".to_string()),
                    "function": {
                        "name": function_name,
                        "arguments": tool_call.function_arguments,
                    }
                }));
            }
            message.insert("tool_calls".to_string(), Value::Array(tool_calls));
        }
        materialized_choices.push(json!({
            "index": index,
            "message": Value::Object(message),
            "finish_reason": choice.finish_reason.unwrap_or(Value::Null),
        }));
    }
    let mut response = Map::new();
    response.insert(
        "id".to_string(),
        Value::String(response_id.unwrap_or_else(|| "chatcmpl_openai_chat_stream".to_string())),
    );
    response.insert(
        "object".to_string(),
        Value::String("chat.completion".to_string()),
    );
    response.insert("choices".to_string(), Value::Array(materialized_choices));
    if let Some(model) = model {
        response.insert("model".to_string(), Value::String(model));
    }
    if let Some(created) = created {
        response.insert("created".to_string(), created);
    }
    if let Some(usage) = usage {
        response.insert("usage".to_string(), usage);
    }
    Ok(Value::Object(response))
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

    #[test]
    fn ping_tail_frame_after_done_is_recognized() {
        assert!(is_v3_openai_chat_ping_tail_frame(r#"{"type":"ping","cost":"0"}"#));
        assert!(is_v3_openai_chat_ping_tail_frame(r#"{"type":"ping"}"#));
        // Chat-style gateways settle cost with an empty-choices frame after [DONE].
        assert!(is_v3_openai_chat_ping_tail_frame(r#"{"choices":[],"cost":"0"}"#));
        assert!(is_v3_openai_chat_ping_tail_frame(r#"{"choices":[]}"#));
    }

    #[test]
    fn semantic_frames_after_done_are_not_ping() {
        assert!(!is_v3_openai_chat_ping_tail_frame(
            r#"{"type":"response.completed","response":{"status":"completed"}}"#
        ));
        assert!(!is_v3_openai_chat_ping_tail_frame(r#"{"id":"x","choices":[{}]}"#));
        assert!(!is_v3_openai_chat_ping_tail_frame(
            r#"{"choices":[{"index":0,"delta":{"content":"hi"}}]}"#
        ));
        assert!(!is_v3_openai_chat_ping_tail_frame("not json"));
        assert!(!is_v3_openai_chat_ping_tail_frame("[1,2,3]"));
    }
}
