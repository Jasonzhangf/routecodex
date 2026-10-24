struct V3RelayToolreasonStreamState {
    tool_names: Vec<String>,
    pending_reasons: Vec<Option<String>>,
    argument_buffers: Vec<String>,
    reason_emitted: bool,
}

impl V3RelayToolreasonStreamState {
    fn new() -> Self {
        Self {
            tool_names: Vec::new(),
            pending_reasons: Vec::new(),
            argument_buffers: Vec::new(),
            reason_emitted: false,
        }
    }
}

fn project_sse_event_payload(
    request_id: &str,
    session_id: Option<&str>,
    payload: Value,
    compatibility_profile: Option<&str>,
    retain_response_cipher: bool,
    expected_model_id: &str,
    response_control: &V3RuntimeStreamObservation,
) -> Result<Value, V3OpenAiChatRelayRuntimeError> {
    let mut trace = Vec::new();
    let result = project_json_response(
        Some(request_id),
        session_id,
        payload,
        V3HubProviderWireProtocol::OpenAiChat,
        &Value::Null,
        V3HubTransportIntent::Sse,
        &mut trace,
        compatibility_profile,
        retain_response_cipher,
        false,
        expected_model_id,
        false,
        &super::resp_chat_process_03_governed::V3HubRelaySerializedToolContext::default(),
    );
    if let Err(V3OpenAiChatRelayRuntimeError::Response(error)) = &result {
        response_control
            .record_response_governance_failure(error.clone())
            .map_err(V3OpenAiChatRelayRuntimeError::Target)?;
    }
    result
}

/// Anthropic wire SSE stream -> responses canonical -> OpenAI Chat SSE 事件流
/// （chat 入口 outbound 投影；SSE 仅负责 framing，语义转换走 canonical）。
fn project_anthropic_sse_as_openai_chat_stream(
    request_id: String,
    session_id: String,
    stream: routecodex_v3_provider_responses::V3ProviderSseStream,
    compatibility_profile: Option<String>,
    retain_response_cipher: bool,
    tool_thinking_enabled: bool,
    _stream_observation: V3RuntimeStreamObservation,
    provider_outcome: V3OpenAiChatSseProviderOutcome,
) -> V3RelayProjectedSseStream {
    use futures_util::StreamExt;
    let decoder = routecodex_v3_sse::SseIncrementalDecoder::new(
        routecodex_v3_sse::SseTransportLimits::default(),
    );
    let transducer = V3OpenAiChatAnthropicSseTransducer::new(false);
    let request_id = request_id;
    Box::pin(futures_util::stream::unfold(
        (
            stream,
            decoder,
            transducer,
            V3RelayToolreasonStreamState::new(),
            VecDeque::<(Vec<u8>, bool)>::new(),
            false,
            false,
            compatibility_profile,
            retain_response_cipher,
            provider_outcome,
        ),
        move |(
            mut provider,
            mut decoder,
            mut transducer,
            mut toolreason,
            mut pending,
            mut done_seen,
            mut finished,
            compatibility_profile,
            retain_response_cipher,
            mut provider_outcome,
        )| {
            let request_id = request_id.clone();
            let session_id = session_id.clone();
            async move {
                loop {
                    if let Some((frame, terminal)) = pending.pop_front() {
                        if terminal {
                            if let Err(error) = provider_outcome
                                .response_control
                                .record_semantic_terminal(V3RuntimeSemanticTerminal::Success)
                            {
                                return Some((
                                    Err(error),
                                    (
                                        provider,
                                        decoder,
                                        transducer,
                                        toolreason,
                                        pending,
                                        done_seen,
                                        finished,
                                        compatibility_profile,
                                        retain_response_cipher,
                                        provider_outcome,
                                    ),
                                ));
                            }
                        }
                        return Some((
                            Ok(frame),
                            (
                                provider,
                                decoder,
                                transducer,
                                toolreason,
                                pending,
                                done_seen,
                                finished,
                                compatibility_profile,
                                retain_response_cipher,
                                provider_outcome,
                            ),
                        ));
                    }
                    if finished {
                        return None;
                    }
                    let Some(chunk) = provider.next().await else {
                        finished = true;
                        let decoder_to_finish = std::mem::replace(
                            &mut decoder,
                            routecodex_v3_sse::SseIncrementalDecoder::new(
                                routecodex_v3_sse::SseTransportLimits::default(),
                            ),
                        );
                        let decoder_result = decoder_to_finish
                            .finish()
                            .map_err(|error| error.to_string());
                        let result = decoder_result.and_then(|_| transducer.finish());
                        if let Err(error) = result {
                            let recorded = provider_outcome.record_failure(&error).await;
                            return Some((
                                Err(recorded.map(|_| error).unwrap_or_else(|record| record)),
                                (
                                    provider,
                                    decoder,
                                    transducer,
                                    toolreason,
                                    pending,
                                    done_seen,
                                    finished,
                                    compatibility_profile,
                                    retain_response_cipher,
                                    provider_outcome,
                                ),
                            ));
                        }
                        // Anthropic Messages wire 无 [DONE] 定义（标准流以 message_stop
                        // 结束；transducer.finish() 成功即 message_stop + terminal
                        // finish_reason 已到达）。MEMORY 合同（08-08）："[DONE]" 由网关在
                        // 客户端侧补发 transport sentinel，不是 provider 必发——缺失不记
                        // provider-health 失败。
                        if !done_seen {
                            done_seen = true;
                            pending.push_back((b"data: [DONE]\n\n".to_vec(), false));
                        }
                        crate::hub_v1::finalize_v3_toolreason_observation_at_resp03_with_context(
                            &toolreason.tool_names,
                            &mut toolreason.pending_reasons,
                            &mut toolreason.reason_emitted,
                            crate::hub_v1::V3ToolreasonObservationContext {
                                session_id: Some(session_id.as_str()),
                                request_id: Some(request_id.as_str()),
                            },
                        );
                        return match pending.pop_front() {
                            Some((frame, _terminal)) => Some((
                                Ok(frame),
                                (
                                    provider,
                                    decoder,
                                    transducer,
                                    toolreason,
                                    pending,
                                    done_seen,
                                    finished,
                                    compatibility_profile,
                                    retain_response_cipher,
                                    provider_outcome,
                                ),
                            )),
                            None => None,
                        };
                    };
                    let result = match &chunk {
                    Err(error @ V3ProviderError::ClientDisconnect { .. }) => {
                        // client disconnect 是健康中性事件（客户端断开导致
                        // provider 流中止）：禁止写 provider 失败/冷却，与
                        // project_sse_stream / gemini / direct 路径一致。
                        if let Err(observation_error) =
                            provider_outcome.response_control.record_client_disconnect()
                        {
                            finished = true;
                            return Some((
                                Err(observation_error),
                                (
                                    provider,
                                    decoder,
                                    transducer,
                                    toolreason,
                                    pending,
                                    done_seen,
                                    finished,
                                    compatibility_profile,
                                    retain_response_cipher,
                                    provider_outcome,
                                ),
                            ));
                        }
                        finished = true;
                        return Some((
                            Err(error.to_string()),
                            (
                                provider,
                                decoder,
                                transducer,
                                toolreason,
                                pending,
                                done_seen,
                                finished,
                                compatibility_profile,
                                retain_response_cipher,
                                provider_outcome,
                            ),
                        ));
                    }
                    Err(error) => Err(error.to_string()),
                    Ok(chunk) => decoder
                        .push(routecodex_v3_sse::build_v3_sse_transport_in_01_raw_chunk(
                            chunk,
                        ))
                        .map_err(|error| error.to_string())
                        .and_then(|frames| {
                            for frame in frames {
                                let mut data = String::new();
                                for field in frame.frame().fields() {
                                    if let routecodex_v3_sse::SseField::Named { name, value } =
                                        field
                                    {
                                        if name == "data" {
                                            if !data.is_empty() {
                                                data.push('\n');
                                            }
                                            data.push_str(value);
                                        }
                                    }
                                }
                                let data = data.trim();
                                if data.is_empty() {
                                    continue;
                                }
                                if data == "[DONE]" {
                                    transducer.finish()?;
                                    done_seen = true;
                                    pending.push_back((b"data: [DONE]\n\n".to_vec(), false));
                                    continue;
                                }
                                if done_seen {
                                    return Err(
                                        "Anthropic SSE emitted data after [DONE]".to_string()
                                    );
                                }
                                let event: Value = serde_json::from_str(data)
                                    .map_err(|error| error.to_string())?;
                                let is_message_stop =
                                    event.get("type").and_then(Value::as_str) == Some("message_stop");
                                let mut mark_terminal = is_message_stop;
                                for mut payload in transducer.push_event(event)? {
                                    let governed = project_sse_event_payload(
                                        request_id.as_str(),
                                        Some(session_id.as_str()),
                                        payload,
                                        compatibility_profile.as_deref(),
                                        retain_response_cipher,
                                        provider_outcome.model_id.as_str(),
                                        &provider_outcome.response_control,
                                    )
                                    .map_err(|error| error.to_string())?;
                                    pending.push_back((
                                        format!("data: {governed}\n\n").into_bytes(),
                                        mark_terminal,
                                    ));
                                    mark_terminal = false;
                                }
                            }
                            Ok(())
                        }),
                };
                    match result {
                        Ok(()) if !pending.is_empty() => {
                            continue;
                        }
                        Ok(_) => continue,
                        Err(error) => {
                            finished = true;
                            let recorded = provider_outcome.record_failure(&error).await;
                            return Some((
                                Err(recorded.map(|_| error).unwrap_or_else(|record| record)),
                                (
                                    provider,
                                    decoder,
                                    transducer,
                                    toolreason,
                                    pending,
                                    done_seen,
                                    finished,
                                    compatibility_profile,
                                    retain_response_cipher,
                                    provider_outcome,
                                ),
                            ));
                        }
                    }
                }
            }
        },
    ))
}

/// Gemini wire SSE -> native JSON -> governed OpenAI Chat JSON -> Chat SSE.
///
/// The full attempt stays buffered until materialization and projection finish.
/// The codec reports protocol facts only; Runtime commits provider success after
/// complete governance and sealing.
fn project_gemini_sse_as_openai_chat_stream(
    request_id: String,
    session_id: String,
    stream: routecodex_v3_provider_responses::V3ProviderSseStream,
    compatibility_profile: Option<String>,
    retain_response_cipher: bool,
    tool_thinking_enabled: bool,
    _stream_observation: V3RuntimeStreamObservation,
    _client_include_usage: bool,
    mut provider_outcome: V3OpenAiChatSseProviderOutcome,
) -> V3RelayProjectedSseStream {
    use futures_util::StreamExt;

    Box::pin(
        futures_util::stream::once(async move {
            let native = match crate::hub_v1::responses_relay_runtime::materialize_v3_provider_sse_as_canonical_response(
                V3HubProviderWireProtocol::Gemini,
                stream,
            )
            .await
            {
                Ok(native) => native,
                Err(error) => {
                    let reason = error.to_string();
                    let recorded = provider_outcome.record_failure(&reason).await;
                    return Err(recorded.map(|_| reason).unwrap_or_else(|record| record));
                }
            };

            let projected = match project_json_response(
                Some(&request_id),
                Some(&session_id),
                native,
                V3HubProviderWireProtocol::Gemini,
                &Value::Null,
                V3HubTransportIntent::Sse,
                &mut Vec::new(),
                compatibility_profile.as_deref(),
                retain_response_cipher,
                tool_thinking_enabled,
                &provider_outcome.model_id,
                true,
                &super::resp_chat_process_03_governed::V3HubRelaySerializedToolContext::default(),
            ) {
                Ok(projected) => projected,
                Err(error) => {
                    if let V3OpenAiChatRelayRuntimeError::Response(error) = &error {
                        provider_outcome.response_control.record_response_governance_failure(error.clone())?;
                    }
                    let reason = error.to_string();
                    let recorded = provider_outcome.record_failure(&reason).await;
                    return Err(recorded.map(|_| reason).unwrap_or_else(|record| record));
                }
            };

            let Value::Object(mut chat) = projected else {
                let reason = "projected OpenAI Chat response is not a JSON object".to_string();
                let recorded = provider_outcome.record_failure(&reason).await;
                return Err(recorded.map(|_| reason).unwrap_or_else(|record| record));
            };

            let choices = chat
                .get("choices")
                .and_then(Value::as_array)
                .cloned()
                .ok_or_else(|| "governed Chat response is missing choices".to_string())?;
            let usage = chat.remove("usage");
            chat.remove("choices");
            chat.insert(
                "object".to_string(),
                Value::String("chat.completion.chunk".to_string()),
            );

            let mut frames = Vec::<Vec<u8>>::new();
            let mut append_chunk = |chunk: &Value| -> Result<(), String> {
                let encoded = serde_json::to_string(chunk).map_err(|error| error.to_string())?;
                frames.push(format!("data: {encoded}\n\n").into_bytes());
                Ok(())
            };

            for choice in choices.iter() {
                let choice_object = choice.as_object()
                    .ok_or_else(|| "governed Chat choice is not an object".to_string())?;

                if let Some(message) = choice_object.get("message").cloned() {
                    let mut delta = message;
                    if let Some(delta_object) = delta.as_object_mut() {
                        if let Some(tool_calls) = delta_object
                            .get_mut("tool_calls")
                            .and_then(Value::as_array_mut)
                        {
                            for (index, tool_call) in tool_calls.iter_mut().enumerate() {
                                if let Some(tool_call_object) = tool_call.as_object_mut() {
                                    tool_call_object.insert(
                                        "index".to_string(),
                                        Value::Number(index.into()),
                                    );
                                }
                            }
                        }
                    }

                    let mut chunk_choice = choice_object.clone();
                    chunk_choice.remove("message");
                    chunk_choice.remove("finish_reason");
                    chunk_choice.insert("delta".to_string(), delta);

                    let mut chunk = chat.clone();
                    chunk.insert(
                        "choices".to_string(),
                        Value::Array(vec![Value::Object(chunk_choice)]),
                    );
                    if let Err(reason) = append_chunk(&Value::Object(chunk)) {
                        let recorded = provider_outcome.record_failure(&reason).await;
                        return Err(recorded.map(|_| reason).unwrap_or_else(|record| record));
                    }
                }

                if let Some(finish_reason) = choice_object.get("finish_reason").cloned() {
                    let mut terminal_choice = choice_object.clone();
                    terminal_choice.remove("message");
                    terminal_choice.insert("delta".to_string(), Value::Object(Default::default()));
                    terminal_choice.insert("finish_reason".to_string(), finish_reason);

                    let mut chunk = chat.clone();
                    chunk.insert(
                        "choices".to_string(),
                        Value::Array(vec![Value::Object(terminal_choice)]),
                    );
                    if let Err(reason) = append_chunk(&Value::Object(chunk)) {
                        let recorded = provider_outcome.record_failure(&reason).await;
                        return Err(recorded.map(|_| reason).unwrap_or_else(|record| record));
                    }
                }
            }

            if let Some(usage) = usage {
                    let mut chunk = chat.clone();
                    chunk.insert("choices".to_string(), Value::Array(Vec::new()));
                    chunk.insert("usage".to_string(), usage);
                    if let Err(reason) = append_chunk(&Value::Object(chunk)) {
                        let recorded = provider_outcome.record_failure(&reason).await;
                        return Err(recorded.map(|_| reason).unwrap_or_else(|record| record));
                    }
            }

            frames.push(b"data: [DONE]\n\n".to_vec());
            Ok(frames)
        })
        .flat_map(|result: Result<Vec<Vec<u8>>, String>| {
            let frames: Vec<Result<Vec<u8>, String>> = match result {
                Ok(frames) => frames.into_iter().map(Ok).collect(),
                Err(error) => vec![Err(error)],
            };
            futures_util::stream::iter(frames)
        }),
    )
}
