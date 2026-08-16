fn project_sse_event_payload(
    payload: Value,
    compatibility_profile: Option<&str>,
    web_search_execution_mode: routecodex_v3_config::V3WebSearchExecutionMode,
    web_search_center_state: Option<&V3WebSearchCenterState>,
    retain_response_cipher: bool,
) -> Result<Value, V3OpenAiChatRelayRuntimeError> {
    let mut trace = Vec::new();
    project_json_response(
        payload,
        V3HubProviderWireProtocol::OpenAiChat,
        &Value::Null,
        V3HubTransportIntent::Sse,
        &mut trace,
        compatibility_profile,
        web_search_execution_mode,
        web_search_center_state,
        retain_response_cipher,
    )
}

/// Anthropic wire SSE stream -> responses canonical -> OpenAI Chat SSE 事件流
/// （chat 入口 outbound 投影；SSE 仅负责 framing，语义转换走 canonical）。
fn project_anthropic_sse_as_openai_chat_stream(
    stream: routecodex_v3_provider_responses::V3ProviderSseStream,
    compatibility_profile: Option<String>,
    web_search_execution_mode: routecodex_v3_config::V3WebSearchExecutionMode,
    web_search_center_state: Option<V3WebSearchCenterState>,
    retain_response_cipher: bool,
    provider_outcome: V3OpenAiChatSseProviderOutcome,
) -> V3OpenAiChatClientStream {
    use futures_util::StreamExt;
    let decoder = routecodex_v3_sse::SseIncrementalDecoder::new(
        routecodex_v3_sse::SseTransportLimits::default(),
    );
    let transducer = V3OpenAiChatAnthropicSseTransducer::new(
        web_search_execution_mode.is_metadata_center_local_search(),
    );
    Box::pin(futures_util::stream::unfold(
        (
            stream,
            decoder,
            transducer,
            VecDeque::<Vec<u8>>::new(),
            false,
            false,
            compatibility_profile,
            web_search_execution_mode,
            web_search_center_state,
            retain_response_cipher,
            provider_outcome,
        ),
        |(
            mut provider,
            mut decoder,
            mut transducer,
            mut pending,
            mut done_seen,
            mut finished,
            compatibility_profile,
            web_search_execution_mode,
            web_search_center_state,
            retain_response_cipher,
            mut provider_outcome,
        )| async move {
            loop {
                if let Some(frame) = pending.pop_front() {
                    return Some((
                        Ok(frame),
                        (
                            provider,
                            decoder,
                            transducer,
                            pending,
                            done_seen,
                            finished,
                            compatibility_profile,
                            web_search_execution_mode,
                            web_search_center_state,
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
                                pending,
                                done_seen,
                                finished,
                                compatibility_profile,
                                web_search_execution_mode,
                                web_search_center_state,
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
                        pending.push_back(b"data: [DONE]\n\n".to_vec());
                    }
                    match provider_outcome.record_success() {
                        Ok(()) => {}
                        Err(error) => {
                            return Some((
                                Err(error),
                                (
                                    provider,
                                    decoder,
                                    transducer,
                                    pending,
                                    done_seen,
                                    finished,
                                    compatibility_profile,
                                    web_search_execution_mode,
                                    web_search_center_state,
                                    retain_response_cipher,
                                    provider_outcome,
                                ),
                            ));
                        }
                    }
                    return match pending.pop_front() {
                        Some(frame) => Some((
                            Ok(frame),
                            (
                                provider,
                                decoder,
                                transducer,
                                pending,
                                done_seen,
                                finished,
                                compatibility_profile,
                                web_search_execution_mode,
                                web_search_center_state,
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
                        finished = true;
                        return Some((
                            Err(error.to_string()),
                            (
                                provider,
                                decoder,
                                transducer,
                                pending,
                                done_seen,
                                finished,
                                compatibility_profile,
                                web_search_execution_mode,
                                web_search_center_state,
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
                                    pending.push_back(b"data: [DONE]\n\n".to_vec());
                                    continue;
                                }
                                if done_seen {
                                    return Err(
                                        "Anthropic SSE emitted data after [DONE]".to_string()
                                    );
                                }
                                let event: Value = serde_json::from_str(data)
                                    .map_err(|error| error.to_string())?;
                                for payload in transducer.push_event(event)? {
                                    let governed = project_sse_event_payload(
                                        payload,
                                        compatibility_profile.as_deref(),
                                        web_search_execution_mode,
                                        web_search_center_state.as_ref(),
                                        retain_response_cipher,
                                    )
                                    .map_err(|error| match error {
                                        V3OpenAiChatRelayRuntimeError::WebSearchInterceptedUnprojected => {
                                            "ROUTECODEX_GOVERNANCE_REJECTED".to_string()
                                        }
                                        other => other.to_string(),
                                    })?;
                                    pending.push_back(format!("data: {governed}\n\n").into_bytes());
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
                        if error.starts_with("ROUTECODEX_GOVERNANCE_REJECTED") {
                            return Some((
                                Err(error),
                                (
                                    provider,
                                    decoder,
                                    transducer,
                                    pending,
                                    done_seen,
                                    finished,
                                    compatibility_profile,
                                    web_search_execution_mode,
                                    web_search_center_state,
                                    retain_response_cipher,
                                    provider_outcome,
                                ),
                            ));
                        }
                        let recorded = provider_outcome.record_failure(&error).await;
                        return Some((
                            Err(recorded.map(|_| error).unwrap_or_else(|record| record)),
                            (
                                provider,
                                decoder,
                                transducer,
                                pending,
                                done_seen,
                                finished,
                                compatibility_profile,
                                web_search_execution_mode,
                                web_search_center_state,
                                retain_response_cipher,
                                provider_outcome,
                            ),
                        ));
                    }
                }
            }
        },
    ))
}
