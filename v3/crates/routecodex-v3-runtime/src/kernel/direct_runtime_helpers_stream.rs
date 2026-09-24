use super::*;
use crate::hub_v1::{
    classify_v3_provider_sse_json_data, collect_v3_provider_sse_json_data,
    is_v3_provider_sse_transport_keepalive_data, is_v3_provider_sse_transport_keepalive_frame,
    V3ProviderResponsesJsonFrameOutcome,
};
use crate::kernel::direct_sse_consumers::{
    build_v3_sse_transport_error_source, V3DirectSseContentConsumer,
};
use crate::nodes::{V3SseAttemptFrame, V3SseAttemptStream, V3SseFrameDisposition};

fn wrap_direct_sse_provider_event_json_observation_stream(
    source: V3ProviderAttemptSseStream,
    stream_observation: V3RuntimeStreamObservation,
    runtime_timing: V3RuntimeTimingState,
    strip_client_response_id: bool,
    retain_response_cipher: bool,
    provider_protocol: crate::hub_v1::V3HubProviderWireProtocol,
) -> V3SseAttemptStream {
    wrap_direct_sse_provider_event_json_observation_stream_with_compat(
        source,
        stream_observation,
        runtime_timing,
        strip_client_response_id,
        retain_response_cipher,
        provider_protocol,
        false,
        false,
        V3DirectSseTypedHookCatalog::default(),
        false,
        false,
        None,
        None,
        None,
        false,
    )
}

pub(crate) fn wrap_direct_sse_provider_event_json_observation_stream_with_compat(
    source: V3ProviderAttemptSseStream,
    stream_observation: V3RuntimeStreamObservation,
    runtime_timing: V3RuntimeTimingState,
    strip_client_response_id: bool,
    retain_response_cipher: bool,
    provider_protocol: crate::hub_v1::V3HubProviderWireProtocol,
    deepseek_console_go: bool,
    thinking_tags: bool,
    typed_hooks: V3DirectSseTypedHookCatalog,
    tool_thinking_enabled: bool,
    toolreason_client_projection: bool,
    session_id: Option<String>,
    request_id: Option<String>,
    expected_model_id: Option<String>,
    client_responses_projection: bool,
) -> V3SseAttemptStream {
    struct StreamState {
        source: V3ProviderAttemptSseStream,
        decoder: SseIncrementalDecoder,
        stream_observation: V3RuntimeStreamObservation,
        runtime_timing: V3RuntimeTimingState,
        content_consumer: V3DirectSseContentConsumer,
        semantic_state: V3DirectSseSemanticState,
        done: bool,
    }

    let provider_wire_protocol = provider_protocol;
    let source = if thinking_tags {
        wrap_v3_direct_responses_thinking_tag_consumer_stream(source)
    } else {
        source
    };
    Box::pin(stream::unfold(
        StreamState {
            source,
            decoder: SseIncrementalDecoder::new(SseTransportLimits::default()),
            stream_observation: stream_observation.clone(),
            runtime_timing,
            content_consumer: V3DirectSseContentConsumer {
                provider_protocol: Some(provider_protocol),
                retain_response_cipher,
                strip_client_response_id,
                deepseek_console_go,
                session_id,
                request_id,
                expected_model_id,
                stream_observation: Some(stream_observation.clone()),
                ..Default::default()
            }
            .with_typed_hooks(typed_hooks)
            .with_tool_thinking(tool_thinking_enabled, toolreason_client_projection)
            .with_client_responses_projection(client_responses_projection),
            semantic_state: V3DirectSseSemanticState::new(),
            done: false,
        },
        move |mut state| async move {
            if let Some(closeout) = state.semantic_state.pending_closeout.take() {
                return Some((
                    Ok(V3SseAttemptFrame::new(
                        closeout,
                        V3SseFrameDisposition::LegalCloseout,
                    )),
                    state,
                ));
            }
            if state.done {
                return None;
            }
            loop {
                match state.source.next().await {
                    Some(Ok(chunk)) => {
                        let result = record_direct_sse_provider_event_json_chunk(
                            &chunk,
                            &mut state.decoder,
                            &state.stream_observation,
                            &mut state.content_consumer,
                            &mut state.semantic_state,
                        );
                        match result {
                            Ok(Some(frame)) => {
                                let terminal_observed = matches!(
                                    frame.disposition,
                                    V3SseFrameDisposition::SemanticTerminal
                                        | V3SseFrameDisposition::LegalCloseout
                                );
                                // The protocol terminal is complete once the
                                // closeout is consumed: either the collector
                                // returned a LegalCloseout frame, a chat-wire
                                // `[DONE]` was already captured in this same
                                // chunk (done_seen), or the provider protocol
                                // has no `[DONE]` closeout at all (Responses).
                                // Otherwise a chat `[DONE]` may still arrive in
                                // a LATER transport chunk (the provider
                                // transport frame-splits SSE events), so keep
                                // reading so that following LegalCloseout is
                                // collected and delivered to the client as the
                                // observable protocol terminal.  Only a
                                // LegalCloseout (or stream end) stops the
                                // collection loop.
                                let closeout_complete = terminal_observed
                                    && (matches!(
                                        frame.disposition,
                                        V3SseFrameDisposition::LegalCloseout
                                    ) || state.semantic_state.done_seen
                                        || provider_wire_protocol
                                            == crate::hub_v1::V3HubProviderWireProtocol::Responses);
                                if closeout_complete {
                                    state.done = true;
                                }
                                if terminal_observed
                                    && !state.runtime_timing.is_finished().unwrap_or(false)
                                {
                                    if let Err(error) =
                                        state.runtime_timing.finish_external_if_active()
                                    {
                                        return Some((
                                            Err(runtime_source("V3RuntimeTimingExternal", error)),
                                            state,
                                        ));
                                    }
                                    let timing = match state.runtime_timing.finish_runtime() {
                                        Ok(timing) => timing,
                                        Err(error) => {
                                            return Some((
                                                Err(runtime_source(
                                                    "V3RuntimeTimingTerminal",
                                                    error,
                                                )),
                                                state,
                                            ));
                                        }
                                    };
                                    if let Err(error) =
                                        state.stream_observation.record_timing(timing)
                                    {
                                        return Some((
                                            Err(runtime_source(
                                                "V3RuntimeTimingObservation",
                                                error,
                                            )),
                                            state,
                                        ));
                                    }
                                }
                                return Some((Ok(frame), state));
                            }
                            Ok(None) => continue,
                            Err(error) => {
                                state.done = true;
                                return Some((Err(error), state));
                            }
                        }
                    }
                    Some(Err(error)) => {
                        state.done = true;
                        return Some((Err(error), state));
                    }
                    None => {
                        state.done = true;
                        let decoder = std::mem::replace(
                            &mut state.decoder,
                            SseIncrementalDecoder::new(SseTransportLimits::default()),
                        );
                        let decoder_result = decoder
                            .finish()
                            .map_err(build_v3_sse_transport_error_source);
                        if let Err(error) = state.content_consumer.finalize_toolreason_observation()
                        {
                            return Some((
                                Err(runtime_source("V3RuntimeToolreasonObservation", error)),
                                state,
                            ));
                        }
                        match decoder_result {
                            Ok(()) if state.runtime_timing.is_finished().unwrap_or(false) => {
                                return None
                            }
                            Ok(()) => {
                                if let Err(error) = state.runtime_timing.finish_external_if_active()
                                {
                                    return Some((
                                        Err(runtime_source("V3RuntimeTimingExternal", error)),
                                        state,
                                    ));
                                }
                                let timing = match state.runtime_timing.finish_runtime() {
                                    Ok(timing) => timing,
                                    Err(error) => {
                                        return Some((
                                            Err(runtime_source("V3RuntimeTimingTerminal", error)),
                                            state,
                                        ));
                                    }
                                };
                                if let Err(error) = state.stream_observation.record_timing(timing) {
                                    return Some((
                                        Err(runtime_source("V3RuntimeTimingObservation", error)),
                                        state,
                                    ));
                                }
                                return None;
                            }
                            Err(error) => return Some((Err(error), state)),
                        }
                    }
                }
            }
        },
    ))
}

struct V3DirectSseSemanticState {
    done_seen: bool,
    terminal_seen: bool,
    pending_closeout: Option<Vec<u8>>,
}

impl V3DirectSseSemanticState {
    fn new() -> Self {
        Self {
            done_seen: false,
            terminal_seen: false,
            pending_closeout: None,
        }
    }
}

pub(crate) async fn collect_direct_sse_attempt_after_terminal(
    stream: V3SseAttemptStream,
    provider_protocol: V3HubProviderWireProtocol,
    attempt_budget: crate::nodes::V3AttemptBudget,
) -> Result<crate::nodes::V3CommittedClientSseStream, V3Error01SourceRaised> {
    collect_direct_sse_attempt_after_terminal_with_memory(
        stream,
        provider_protocol,
        attempt_budget,
        None,
        None,
    )
    .await
}

pub(crate) async fn collect_direct_sse_attempt_after_terminal_with_memory(
    mut stream: V3SseAttemptStream,
    provider_protocol: V3HubProviderWireProtocol,
    attempt_budget: crate::nodes::V3AttemptBudget,
    manifest: Option<&V3Config05ManifestPublished>,
    request_id: Option<&str>,
) -> Result<crate::nodes::V3CommittedClientSseStream, V3Error01SourceRaised> {
    let mut committed = crate::nodes::V3CommittedClientSseBuilder::with_budget(attempt_budget)
        .map_err(|message| {
            build_v3_error_01_source_raised(
                V3ErrorSourceKind::RuntimeFailure,
                "V3ExecutionAttemptPayloadStore",
                "direct_sse_attempt_store_rejected",
                message.to_string(),
            )
        })?;
    let mut terminal_seen = false;
    while let Some(frame) = stream.next().await {
        // The attempt is complete at the protocol terminal.  A provider
        // transport error or an unterminated tail after the terminal is
        // post-terminal noise and must seal the already-validated attempt
        // rather than reopen it (parity with the relay path, which ignores
        // post-terminal read errors).
        let frame = match frame {
            Ok(frame) => frame,
            Err(_) if terminal_seen => break,
            Err(error) => return Err(error),
        };
        let disposition = frame.disposition;
        if terminal_seen && disposition == V3SseFrameDisposition::Continue {
            return Err(build_v3_error_01_source_raised(
                V3ErrorSourceKind::RuntimeFailure,
                "V3ExecutionAttemptPayloadStore",
                "direct_sse_frame_after_terminal",
                "Direct SSE projected a continuation frame after semantic terminal",
            ));
        }
        let frame = frame.bytes;
        committed.push(frame).map_err(|message| {
            build_v3_error_01_source_raised(
                V3ErrorSourceKind::RuntimeFailure,
                "V3ExecutionAttemptPayloadStore",
                "direct_sse_attempt_store_rejected",
                message.to_string(),
            )
        })?;
        if matches!(
            disposition,
            V3SseFrameDisposition::SemanticTerminal | V3SseFrameDisposition::LegalCloseout
        ) {
            if disposition == V3SseFrameDisposition::LegalCloseout && !terminal_seen {
                return Err(build_v3_error_01_source_raised(
                    V3ErrorSourceKind::ProviderFailure,
                    "V3ProviderResp14Raw",
                    "provider_response_sse_stream",
                    "Direct SSE emitted legal closeout before semantic terminal",
                ));
            }
            terminal_seen = true;
            committed.mark_last_frame_as_terminal().map_err(|message| {
                build_v3_error_01_source_raised(
                    V3ErrorSourceKind::RuntimeFailure,
                    "V3ExecutionAttemptPayloadStore",
                    "direct_sse_terminal_seal_rejected",
                    message.to_string(),
                )
            })?;
            if disposition == V3SseFrameDisposition::LegalCloseout {
                rewrite_direct_sse_memory(&mut committed, manifest, request_id).map_err(
                    |message| {
                        build_v3_error_01_source_raised(
                            V3ErrorSourceKind::RuntimeFailure,
                            "V3ExecutionAttemptPayloadStore",
                            "direct_sse_memory_strip_failed",
                            message.to_string(),
                        )
                    },
                )?;
                let sealed = committed.seal_after_validated_terminal();
                let sealed = sealed.map_err(|message| {
                    build_v3_error_01_source_raised(
                        V3ErrorSourceKind::RuntimeFailure,
                        "V3ExecutionAttemptPayloadStore",
                        "direct_sse_terminal_seal_rejected",
                        message.to_string(),
                    )
                });
                return sealed;
            }
        }
    }
    if terminal_seen {
        // OpenAI Chat's client protocol terminal is the `data: [DONE]`
        // sentinel. A chat-wire provider may close after the semantic
        // terminal without ever emitting it; synthesize the protocol closeout
        // so the committed client stream still ends with `[DONE]` (parity with
        // the chat relay path).  A provider-supplied `[DONE]` returns above via
        // the LegalCloseout branch and never reaches this point.
        if provider_protocol == V3HubProviderWireProtocol::OpenAiChat {
            committed
                .push(b"data: [DONE]\n\n".to_vec())
                .map_err(|message| {
                    build_v3_error_01_source_raised(
                        V3ErrorSourceKind::RuntimeFailure,
                        "V3ExecutionAttemptPayloadStore",
                        "direct_sse_attempt_store_rejected",
                        message.to_string(),
                    )
                })?;
        }
        rewrite_direct_sse_memory(&mut committed, manifest, request_id).map_err(|message| {
            build_v3_error_01_source_raised(
                V3ErrorSourceKind::RuntimeFailure,
                "V3ExecutionAttemptPayloadStore",
                "direct_sse_memory_strip_failed",
                message.to_string(),
            )
        })?;
        let sealed = committed.seal_after_validated_terminal();
        let sealed = sealed.map_err(|message| {
            build_v3_error_01_source_raised(
                V3ErrorSourceKind::RuntimeFailure,
                "V3ExecutionAttemptPayloadStore",
                "direct_sse_terminal_seal_rejected",
                message.to_string(),
            )
        });
        return sealed;
    }
    Err(build_v3_error_01_source_raised(
        V3ErrorSourceKind::ProviderFailure,
        "V3ProviderResp14Raw",
        "provider_response_sse_stream",
        "provider SSE ended without a protocol terminal",
    ))
}

fn rewrite_direct_sse_memory(
    committed: &mut crate::execution_control::V3CommittedClientSseBuilder,
    manifest: Option<&V3Config05ManifestPublished>,
    request_id: Option<&str>,
) -> Result<(), crate::execution_control::V3AttemptStoreError> {
    let Some(manifest) = manifest else {
        return Ok(());
    };
    let Some(request_id) = request_id else {
        return Ok(());
    };
    if !manifest.memory_raw_capture.enabled {
        return Ok(());
    }
    let host_id = routecodex_v3_agent_memory::stable_host_id(&format!(
        "{}{}",
        manifest.memory_raw_capture.host_id_prefix, request_id
    ));
    let mut accumulator = routecodex_v3_agent_memory::ResponsesSseAccumulator::new();
    committed.rewrite_frames_non_increasing(|frame| {
        for value in parse_direct_sse_json_frames(&frame) {
            let _ = accumulator.feed_event(&value);
        }
        frame
    })?;
    let canonical_output_texts = accumulator.canonical_output_texts();
    let report = accumulator.finalize(&host_id, request_id);
    if !report.memory_unit_found {
        return Ok(());
    }
    for captured in &report.captured {
        if let Err(error) = routecodex_v3_agent_memory::publish_l3_entry(
            &manifest.memory_raw_capture.project_root,
            captured,
        ) {
            eprintln!("memory l3 publication diagnostic request_id={request_id}: {error}");
        }
    }
    let mut raw_delta_by_key = std::collections::BTreeMap::<(usize, usize), String>::new();
    let visible_text_by_key = canonical_output_texts
        .into_iter()
        .map(|(output_index, content_index, text)| {
            let visible =
                routecodex_v3_agent_memory::strip_memory_envelope_from_text(&text, &report);
            ((output_index, content_index), visible)
        })
        .collect::<std::collections::BTreeMap<_, _>>();
    let mut visible_chars_by_key = std::collections::BTreeMap::<(usize, usize), usize>::new();
    committed.rewrite_frames_non_increasing(|frame| {
        rewrite_direct_sse_frame(&frame, |mut value| {
            match value.get("type").and_then(serde_json::Value::as_str) {
                Some("response.output_text.delta") => {
                    let key = direct_sse_output_text_key(&value);
                    if let Some(delta) = value.get("delta").and_then(serde_json::Value::as_str) {
                        let raw = raw_delta_by_key.entry(key).or_default();
                        raw.push_str(delta);
                        let visible_text = visible_text_by_key
                            .get(&key)
                            .map(String::as_str)
                            .unwrap_or_default();
                        let previous_chars = visible_chars_by_key.entry(key).or_default();
                        let visible_limit = raw.chars().count().min(visible_text.chars().count());
                        let replacement = visible_text
                            .chars()
                            .skip(*previous_chars)
                            .take(visible_limit.saturating_sub(*previous_chars))
                            .collect::<String>();
                        *previous_chars = visible_limit;
                        if let Some(object) = value.as_object_mut() {
                            object
                                .insert("delta".to_owned(), serde_json::Value::String(replacement));
                        }
                    }
                }
                Some("response.output_text.done") => {
                    if let Some(serde_json::Value::String(text)) = value.get_mut("text") {
                        *text = routecodex_v3_agent_memory::strip_memory_envelope_from_text(
                            text, &report,
                        );
                    }
                }
                Some("response.completed" | "response.done") => {
                    if let Some(response) = value.get_mut("response") {
                        routecodex_v3_agent_memory::strip_memory_envelope_from_responses_payload(
                            response, &report,
                        );
                    } else {
                        routecodex_v3_agent_memory::strip_memory_envelope_from_responses_payload(
                            &mut value, &report,
                        );
                    }
                }
                _ => {}
            }
            value
        })
    })
}

fn direct_sse_output_text_key(event: &serde_json::Value) -> (usize, usize) {
    (
        event
            .get("output_index")
            .and_then(serde_json::Value::as_u64)
            .unwrap_or(0) as usize,
        event
            .get("content_index")
            .and_then(serde_json::Value::as_u64)
            .unwrap_or(0) as usize,
    )
}

fn parse_direct_sse_json_frames(frame: &[u8]) -> Vec<serde_json::Value> {
    let Ok(text) = std::str::from_utf8(frame) else {
        return Vec::new();
    };
    text.split_inclusive("\n\n")
        .filter_map(|segment| parse_direct_sse_json_segment(segment).map(|(value, _)| value))
        .collect()
}

fn rewrite_direct_sse_frame(
    frame: &[u8],
    mut rewrite: impl FnMut(serde_json::Value) -> serde_json::Value,
) -> Vec<u8> {
    let Ok(text) = std::str::from_utf8(frame) else {
        return frame.to_vec();
    };
    let mut output = String::with_capacity(text.len());
    for segment in text.split_inclusive("\n\n") {
        if let Some((value, prefix)) = parse_direct_sse_json_segment(segment) {
            output.push_str(&format!("{prefix}data: {}\n\n", rewrite(value)));
        } else {
            output.push_str(segment);
        }
    }
    output.into_bytes()
}

fn parse_direct_sse_json_segment(segment: &str) -> Option<(serde_json::Value, String)> {
    let data_start = segment.find("data:")?;
    let data_line_end = segment[data_start..]
        .find('\n')
        .map(|offset| data_start + offset)
        .unwrap_or(segment.len());
    let raw = segment[data_start + "data:".len()..data_line_end].trim();
    let value = serde_json::from_str(raw).ok()?;
    Some((value, segment[..data_start].to_owned()))
}

fn materialize_direct_responses_terminal_usage(frame: &[u8]) -> Vec<u8> {
    rewrite_direct_sse_frame(frame, |mut value| {
        if !matches!(
            value.get("type").and_then(serde_json::Value::as_str),
            Some("response.completed" | "response.done" | "response.incomplete")
        ) {
            return value;
        }
        let Some(response) = value.get_mut("response") else {
            return value;
        };
        let Some(response_object) = response.as_object_mut() else {
            return value;
        };
        let mut response_value = serde_json::Value::Object(std::mem::take(response_object));
        crate::hub_v1::materialize_v3_responses_terminal_usage(&mut response_value);
        *response = response_value;
        value
    })
}

#[cfg(test)]
fn test_direct_sse_attempt_stream(
    source: V3ClientSseStream,
    provider_protocol: crate::hub_v1::V3HubProviderWireProtocol,
) -> V3SseAttemptStream {
    wrap_direct_sse_provider_event_json_observation_stream(
        V3ProviderAttemptSseStream::new(source),
        V3RuntimeStreamObservation::default(),
        V3RuntimeTimingState::start(),
        false,
        false,
        provider_protocol,
    )
}

pub(crate) async fn project_and_collect_direct_sse_attempt(
    stream: V3ProviderAttemptSseStream,
    stream_observation: V3RuntimeStreamObservation,
    runtime_timing: V3RuntimeTimingState,
    manifest: &V3Config05ManifestPublished,
    server_id: &str,
    request_id: &str,
    retain_response_cipher: bool,
    compat_plan: &crate::direct_response_hooks::V3DirectResponseCompatPlan,
    hook_registry: &V3HookRegistry,
    failure_session_scope: &V3ProviderFailureSessionScope,
    attempt_budget: V3AttemptBudget,
) -> Result<crate::nodes::V3CommittedClientSseStream, V3Error01SourceRaised> {
    let projected = wrap_direct_sse_provider_event_json_observation_stream_with_compat(
        stream,
        stream_observation,
        runtime_timing,
        crate::shared::v3_strip_client_response_id_enabled_for_server(manifest, server_id),
        retain_response_cipher,
        compat_plan.provider_protocol,
        compat_plan.has_block(V3DirectResponseCompatBlock::DeepseekConsoleGoResponseShape),
        compat_plan.has_block(V3DirectResponseCompatBlock::ThinkingTags)
            && compat_plan.provider_protocol == V3HubProviderWireProtocol::Responses,
        hook_registry.direct_sse_typed_hooks(),
        crate::hub_v1::v3_tool_thinking_enabled_for_server(manifest, server_id),
        crate::hub_v1::v3_toolreason_client_projection_enabled_for_server(manifest, server_id),
        Some(failure_session_scope.session_id().to_owned()),
        Some(request_id.to_owned()),
        Some(compat_plan.canonical_model_id.clone()),
        true,
    );
    collect_direct_sse_attempt_after_terminal_with_memory(
        projected,
        compat_plan.provider_protocol,
        attempt_budget,
        Some(manifest),
        Some(request_id),
    )
    .await
}

#[cfg(test)]
#[path = "direct_runtime_helpers_stream_timing_tests.rs"]
mod direct_sse_timing_tests;

/// Usage-observation-only SSE wrap：只把 provider SSE 事件 JSON 写入
/// 观测；开启 strip_client_response_id 时，把事件 data 中嵌套
/// `response.id` 替换为空串后重编码返回（客户端拿不到 previous_response_id）。
fn record_direct_sse_provider_event_json_chunk(
    chunk: &[u8],
    decoder: &mut SseIncrementalDecoder,
    stream_observation: &V3RuntimeStreamObservation,
    content_consumer: &mut V3DirectSseContentConsumer,
    semantic_state: &mut V3DirectSseSemanticState,
) -> Result<Option<V3SseAttemptFrame>, V3Error01SourceRaised> {
    stream_observation
        .record_provider_raw_sse_chunk(chunk)
        .map_err(provider_sse_failure_source)?;
    let frames = decoder
        .push(build_v3_sse_transport_in_01_raw_chunk(chunk))
        .map_err(build_v3_sse_transport_error_source)?;
    if frames.is_empty() {
        return Ok(None);
    }
    let mut accepted = Vec::new();
    let mut disposition = V3SseFrameDisposition::Continue;
    for frame in frames {
        let provider_protocol = content_consumer
            .provider_protocol
            .ok_or_else(|| provider_sse_failure_source("provider protocol is missing"))?;
        let is_transport_keepalive =
            if provider_protocol == crate::hub_v1::V3HubProviderWireProtocol::Responses {
                is_v3_provider_sse_transport_keepalive_frame(frame.frame().fields())
            } else {
                let data = collect_v3_provider_sse_json_data(frame.frame().fields());
                is_v3_provider_sse_transport_keepalive_data(&data)
            };
        if is_transport_keepalive {
            continue;
        }
        let data = collect_v3_provider_sse_json_data(frame.frame().fields());
        if semantic_state.terminal_seen {
            if data.trim() == "[DONE]" && !semantic_state.done_seen {
                semantic_state.done_seen = true;
                let done_bytes = frame
                    .frame()
                    .raw_bytes()
                    .map(ToOwned::to_owned)
                    .unwrap_or_else(|| {
                        build_v3_sse_transport_out_04_from_v3_sse_transport_in_03(&frame)
                            .into_bytes()
                    });
                if accepted.is_empty() {
                    // The closeout arrived in its own transport chunk; emit it
                    // as the protocol terminal frame directly.
                    accepted.extend_from_slice(&done_bytes);
                    if disposition == V3SseFrameDisposition::Continue {
                        disposition = V3SseFrameDisposition::LegalCloseout;
                    }
                } else {
                    // The closeout shared a chunk with the semantic terminal.
                    // Defer it so the terminal frame keeps its SemanticTerminal
                    // disposition and the closeout is emitted as a distinct
                    // LegalCloseout frame next, never merged ambiguously.
                    semantic_state.pending_closeout = Some(done_bytes);
                }
            }
            // The terminal frame is the last semantic input owned by this
            // attempt.  Do not parse or retain any later provider tail.
            break;
        }
        if data.trim() == "[DONE]" {
            return Err(provider_sse_failure_source(
                "[DONE] before terminal finish_reason",
            ));
        }
        let outcome = classify_v3_provider_sse_json_data(provider_protocol, &data)
            .map_err(provider_sse_failure_source)?;
        let frame_disposition = match outcome {
            Some(V3ProviderResponsesJsonFrameOutcome::StartClientStream) => {
                V3SseFrameDisposition::Continue
            }
            Some(V3ProviderResponsesJsonFrameOutcome::Terminal) => {
                V3SseFrameDisposition::SemanticTerminal
            }
            Some(V3ProviderResponsesJsonFrameOutcome::TerminalWithoutOutput) => {
                V3SseFrameDisposition::SemanticTerminal
            }
            Some(V3ProviderResponsesJsonFrameOutcome::ContinueBuffering) | None => {
                V3SseFrameDisposition::Continue
            }
            Some(V3ProviderResponsesJsonFrameOutcome::Failure { code, message }) => {
                return Err(build_v3_error_01_source_raised(
                    V3ErrorSourceKind::ProviderFailure,
                    "V3ProviderResp14Raw",
                    code,
                    message,
                ));
            }
        };
        record_direct_sse_provider_event_json_frame(frame.frame().fields(), stream_observation)?;
        let original =
            build_v3_sse_transport_out_04_from_v3_sse_transport_in_03(&frame).into_bytes();
        let mut projected = process_sse_object_frame(&frame, content_consumer)
            .map_err(|error| provider_sse_failure_source(error.to_string()))?
            .into_bytes();
        if provider_protocol == crate::hub_v1::V3HubProviderWireProtocol::Responses
            && frame_disposition == V3SseFrameDisposition::SemanticTerminal
        {
            projected = materialize_direct_responses_terminal_usage(&projected);
        }
        let toolreason_reasoning_projection =
            content_consumer.take_toolreason_reasoning_projection();
        if let Some(prefix) = toolreason_reasoning_projection {
            accepted.extend_from_slice(&prefix);
        }
        if projected == original {
            accepted.extend_from_slice(
                frame
                    .frame()
                    .raw_bytes()
                    .map(ToOwned::to_owned)
                    .unwrap_or(original)
                    .as_slice(),
            );
        } else {
            accepted.extend_from_slice(&projected);
        }
        if frame_disposition == V3SseFrameDisposition::SemanticTerminal {
            semantic_state.terminal_seen = true;
            disposition = V3SseFrameDisposition::SemanticTerminal;
        }
    }
    if accepted.is_empty() {
        Ok(None)
    } else {
        Ok(Some(V3SseAttemptFrame::new(accepted, disposition)))
    }
}

fn record_direct_sse_provider_event_json_frame(
    fields: &[SseField],
    stream_observation: &V3RuntimeStreamObservation,
) -> Result<(), V3Error01SourceRaised> {
    let data = collect_v3_provider_sse_json_data(fields);
    if is_v3_provider_sse_keepalive_text(&data) {
        return Ok(());
    }
    record_v3_provider_sse_json_frame(fields, stream_observation)
        .map_err(provider_sse_failure_source)
}

fn provider_sse_failure_source(message: impl Into<String>) -> V3Error01SourceRaised {
    build_v3_error_01_source_raised(
        V3ErrorSourceKind::ProviderFailure,
        "V3ProviderResp14Raw",
        "provider_response_sse_stream",
        message.into(),
    )
}

pub(crate) fn runtime_source(
    stage: &'static str,
    error: impl std::fmt::Display,
) -> V3Error01SourceRaised {
    build_v3_error_01_source_raised(
        V3ErrorSourceKind::RuntimeFailure,
        stage,
        "v3_route_target_runtime_failure",
        error.to_string(),
    )
}

pub(crate) fn compat_source(
    stage: &'static str,
    error: &crate::hub_v1::V3ProviderCompatError,
) -> V3Error01SourceRaised {
    use crate::hub_v1::V3ProviderCompatErrorClassification;
    match error.classification() {
        V3ProviderCompatErrorClassification::PayloadBoundaryViolation => {
            let field = extract_v3_provider_compat_boundary_field(&error.reason)
                .unwrap_or("control_like_top_level_field");
            routecodex_v3_error::raise_v3_provider_compat_payload_boundary_violation(
                stage,
                field,
                error.reason.as_str(),
            )
        }
        V3ProviderCompatErrorClassification::RequestPayloadInvalid => {
            crate::hub_v1::provider_request_payload_source(stage, error)
        }
        V3ProviderCompatErrorClassification::Other => runtime_source(stage, error),
    }
}

fn extract_v3_provider_compat_boundary_field(reason: &str) -> Option<&'static str> {
    let marker = "ProviderCompatPayloadBoundaryViolation field=";
    let start = reason.find(marker)? + marker.len();
    let rest = &reason[start..];
    let end = rest
        .find(|c: char| c.is_whitespace() || c == '\0')
        .unwrap_or(rest.len());
    match &rest[..end] {
        "metadata" => Some("metadata"),
        "client_metadata" => Some("client_metadata"),
        "context" => Some("context"),
        "routing" => Some("routing"),
        "continuation" => Some("continuation"),
        "provider" => Some("provider"),
        _ => Some("control_like_top_level_field"),
    }
}

#[cfg(test)]
mod request_invalid_compat_tests {
    use super::*;

    #[test]
    fn direct_request_compat_invalid_enters_internal_request_error_chain() {
        let profile = crate::hub_v1::V3ProviderCompatProfileId::Passthrough;
        let error = crate::hub_v1::classify_v3_provider_compat_error(
            "request_protocol",
            &profile,
            "UnmappedOutboundFields target_protocol=anthropic paths=$.tools[0].parameters"
                .to_string(),
        );
        let source = compat_source("V3HubReqOutbound07ProviderSemantic", &error);
        assert_eq!(source.source_kind, V3ErrorSourceKind::RuntimeFailure);
        assert_eq!(source.code, "provider_request_payload_invalid");
    }

    #[test]
    fn direct_response_compat_failure_does_not_become_invalid_request() {
        let profile = crate::hub_v1::V3ProviderCompatProfileId::Passthrough;
        let error = crate::hub_v1::classify_v3_provider_compat_error(
            "response",
            &profile,
            "Anthropic codec malformed tools[].format".to_string(),
        );
        let source = compat_source("V3ProviderRespInbound01Raw", &error);
        assert_eq!(source.source_kind, V3ErrorSourceKind::RuntimeFailure);
    }
}

pub(crate) fn error_output(
    source: V3Error01SourceRaised,
    node_trace: Vec<&'static str>,
    hook_registry: &V3HookRegistry,
) -> V3ResponsesDirectRuntimeOutput {
    let decision = hook_registry.run_error(source, V3ErrorActionScope::None, 0, false, false, None);
    let projected = V3ErrorHandlingCenter::project_terminal(decision);
    projected_error_output(projected, node_trace)
}

/// SSE 传输错误在重试穷尽后的终端输出。与 `error_output` 的差异：调用方已
/// 持有策略层的穷尽证明（terminal policy decision 已产生），因此允许
/// ProviderFailure 来源直接投影；投影保留 SSE 传输错误原语义并附带可观测
/// 性与快照。调用方必须传 0 候选剩余/无默认池的穷尽姿态。
pub(crate) fn exhausted_sse_transport_error_output(
    source: V3Error01SourceRaised,
    node_trace: Vec<&'static str>,
    hook_registry: &V3HookRegistry,
    observability: Option<V3RuntimeObservability>,
    provider_request_snapshot: Option<serde_json::Value>,
    provider_response_snapshot: Option<serde_json::Value>,
) -> V3ResponsesDirectRuntimeOutput {
    let decision = hook_registry.run_error(source, V3ErrorActionScope::None, 0, false, false, None);
    let projected = V3ErrorHandlingCenter::project_terminal(decision);
    projected_error_output_with_observability_and_snapshots(
        projected,
        node_trace,
        observability,
        provider_request_snapshot,
        provider_response_snapshot,
    )
}

pub(crate) fn error_output_with_observability(
    source: V3Error01SourceRaised,
    node_trace: Vec<&'static str>,
    hook_registry: &V3HookRegistry,
    observability: Option<V3RuntimeObservability>,
) -> V3ResponsesDirectRuntimeOutput {
    let decision = hook_registry.run_error(source, V3ErrorActionScope::None, 0, false, false, None);
    let projected = V3ErrorHandlingCenter::project_terminal(decision);
    projected_error_output_with_observability(projected, node_trace, observability)
}

fn projected_error_output(
    projected: routecodex_v3_error::V3Error06ClientProjected,
    node_trace: Vec<&'static str>,
) -> V3ResponsesDirectRuntimeOutput {
    projected_error_output_with_observability(projected, node_trace, None)
}

pub(crate) fn projected_error_output_with_observability(
    projected: routecodex_v3_error::V3Error06ClientProjected,
    node_trace: Vec<&'static str>,
    observability: Option<V3RuntimeObservability>,
) -> V3ResponsesDirectRuntimeOutput {
    projected_error_output_with_observability_and_snapshots(
        projected,
        node_trace,
        observability,
        None,
        None,
    )
}

pub(crate) fn projected_error_output_with_observability_and_snapshots(
    projected: routecodex_v3_error::V3Error06ClientProjected,
    node_trace: Vec<&'static str>,
    observability: Option<V3RuntimeObservability>,
    provider_request_snapshot: Option<serde_json::Value>,
    provider_response_snapshot: Option<serde_json::Value>,
) -> V3ResponsesDirectRuntimeOutput {
    V3ResponsesDirectRuntimeOutput {
        observability,
        stream_observation: None,
        provider_request_snapshot,
        provider_response_snapshot,
        client_payload: V3Resp15ClientPayload {
            status: projected.status,
            headers: BTreeMap::from([("content-type".to_string(), "application/json".to_string())]),
            body: V3ClientBody::Json(projected.body),
        },
        node_trace,
        error_chain: Some(projected.chain.to_vec()),
        protocol_relay_handoff: None,
    }
}

pub(crate) fn committed_sse_provider_failure_output(
    source: V3Error01SourceRaised,
    provider_id: Option<String>,
    node_trace: Vec<&'static str>,
    hook_registry: &V3HookRegistry,
    observability: Option<V3RuntimeObservability>,
) -> V3ResponsesDirectRuntimeOutput {
    let scope = provider_id.map(|provider_id| V3ErrorActionScope::ProviderInstance { provider_id });
    let decision = hook_registry.run_error(
        source,
        scope.unwrap_or(V3ErrorActionScope::None),
        0,
        false,
        false,
        None,
    );
    assert!(
        matches!(decision.action, V3Error05ExecutionAction::ProjectTerminal),
        "committed SSE provider failures must terminate without retry or reselection"
    );
    projected_error_output_with_observability(
        V3ErrorHandlingCenter::project_terminal(decision),
        node_trace,
        observability,
    )
}

pub(crate) fn relay_handoff_output(
    target: routecodex_v3_target::V3Target10ConcreteProviderSelected,
    expanded: routecodex_v3_target::V3Target09CandidateSetExpanded,
    request_local_excluded_candidates: BTreeSet<String>,
    node_trace: Vec<&'static str>,
    provider_failure_events: Vec<V3RuntimeProviderFailureObservation>,
    observability_accumulator: V3RuntimeObservabilityAccumulator,
    request_execution_control: V3RequestExecutionControl,
) -> V3ResponsesDirectRuntimeOutput {
    V3ResponsesDirectRuntimeOutput {
        observability: None,
        stream_observation: None,
        provider_request_snapshot: None,
        provider_response_snapshot: None,
        client_payload: V3Resp15ClientPayload {
            status: 500,
            headers: BTreeMap::from([("content-type".to_string(), "application/json".to_string())]),
            body: V3ClientBody::Json(json!({
                "error": {
                    "code": "protocol_relay_handoff_unconsumed",
                    "message": "V3 Responses Direct selected a Relay target; server must consume the typed handoff side-channel"
                }
            })),
        },
        node_trace: node_trace.clone(),
        error_chain: None,
        protocol_relay_handoff: Some(V3ResponsesProtocolRelayHandoff {
            target,
            expanded,
            request_local_excluded_candidates,
            node_trace,
            provider_failure_events,
            observability_accumulator,
            request_execution_control,
        }),
    }
}

fn debug_error_output(
    stage: &'static str,
    error: V3DebugError,
    hook_registry: &V3HookRegistry,
) -> V3ResponsesDirectRuntimeOutput {
    error_output(
        build_v3_error_01_source_raised(
            V3ErrorSourceKind::RuntimeFailure,
            stage,
            "v3_debug_failure",
            error.to_string(),
        ),
        vec![stage],
        hook_registry,
    )
}

fn client_payload_debug_value(payload: &V3Resp15ClientPayload) -> Value {
    match &payload.body {
        V3ClientBody::Json(value) => value.clone(),
        V3ClientBody::Bytes(bytes) => json!({
            "body_kind": "bytes",
            "byte_len": bytes.len()
        }),
        V3ClientBody::Sse(_) => json!({
            "body_kind": "sse_stream"
        }),
        V3ClientBody::CommittedSse(_) => json!({
            "body_kind": "sse_stream"
        }),
    }
}

struct V3RuntimeAttemptAvailability<'a, R> {
    base: &'a R,
    failed_candidates: &'a BTreeSet<String>,
}

impl<R: V3ProviderAvailabilityReader> V3ProviderAvailabilityReader
    for V3RuntimeAttemptAvailability<'_, R>
{
    fn availability(
        &self,
        provider_id: &str,
        auth_alias: Option<&str>,
        model_id: Option<&str>,
        now_ms: u64,
    ) -> V3ProviderAvailabilityProjection {
        let mut projection = self
            .base
            .availability(provider_id, auth_alias, model_id, now_ms);
        let key = availability_key(provider_id, auth_alias, model_id);
        if self.failed_candidates.contains(&key) {
            projection.available = false;
            projection
                .blocked_scopes
                .push(format!("request_failed:{key}"));
        }
        projection
    }
}

fn candidate_key(candidate: &V3TargetCandidate) -> String {
    availability_key(
        &candidate.provider_id,
        Some(&candidate.auth_alias),
        Some(&candidate.model_id),
    )
}

fn availability_key(provider_id: &str, auth_alias: Option<&str>, model_id: Option<&str>) -> String {
    format!(
        "{}:{}:{}",
        provider_id,
        auth_alias.unwrap_or(""),
        model_id.unwrap_or("")
    )
}

fn remaining_available_candidates<R: V3ProviderAvailabilityReader>(
    candidates: &[V3TargetCandidate],
    availability: &R,
    failed_candidates: &BTreeSet<String>,
) -> usize {
    let attempt_availability = V3RuntimeAttemptAvailability {
        base: availability,
        failed_candidates,
    };
    candidates
        .iter()
        .filter(|candidate| {
            attempt_availability
                .availability(
                    &candidate.provider_id,
                    Some(&candidate.auth_alias),
                    Some(&candidate.model_id),
                    0,
                )
                .available
        })
        .count()
}

fn first_remaining_available_candidate_key<R: V3ProviderAvailabilityReader>(
    candidates: &[V3TargetCandidate],
    availability: &R,
    failed_candidates: &BTreeSet<String>,
) -> Option<String> {
    let attempt_availability = V3RuntimeAttemptAvailability {
        base: availability,
        failed_candidates,
    };
    candidates
        .iter()
        .find(|candidate| {
            attempt_availability
                .availability(
                    &candidate.provider_id,
                    Some(&candidate.auth_alias),
                    Some(&candidate.model_id),
                    0,
                )
                .available
        })
        .map(candidate_key)
}

fn require_static_hooks(hook_registry: &V3HookRegistry) {
    for hook in [
        "ResponsesDirectRouteHook",
        "ResponsesDirectRequestProjectionHook",
        "ResponsesDirectSystemPromptKeyHook",
        "ResponsesDirectDeveloperPromptKeyHook",
        "ResponsesDirectToolsKeyHook",
        "ResponsesDirectProviderTransportHook",
        "ResponsesDirectResponseProjectionHook",
        "ResponsesDirectErrorHook",
    ] {
        assert!(
            hook_registry.require_hook(hook),
            "missing static hook {hook}"
        );
    }
}

pub(crate) fn direct_runtime_allowed_execution_modes(
    manifest: &V3Config05ManifestPublished,
    server_id: &str,
) -> Vec<String> {
    manifest
        .servers
        .get(server_id)
        .and_then(|server| server.execution.as_ref())
        .map(|execution| execution.allowed_modes.clone())
        .filter(|modes| !modes.is_empty())
        .unwrap_or_else(|| vec!["direct".to_string()])
}

fn total_attempts(
    accumulator: &V3RuntimeObservabilityAccumulator,
    current_leg_attempts: usize,
) -> usize {
    accumulator.attempts().saturating_add(current_leg_attempts)
}

fn validate_initial_direct_plan(
    has_initial_target: bool,
    has_initial_protocol_decision: bool,
) -> Result<(), &'static str> {
    if has_initial_target && !has_initial_protocol_decision {
        return Err("preselected direct target requires an initial protocol execution decision");
    }
    Ok(())
}
