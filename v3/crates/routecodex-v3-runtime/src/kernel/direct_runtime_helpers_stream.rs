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
        None,
        None,
        V3DirectSseTypedHookCatalog::default(),
        false,
        false,
        None,
        None,
        None,
        false,
        std::collections::HashMap::new(),
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
    provider_response_compat_profile: Option<String>,
    custom_tool_function_binding: Option<provider_compat_core::CustomToolFunctionBinding>,
    typed_hooks: V3DirectSseTypedHookCatalog,
    tool_thinking_enabled: bool,
    toolreason_client_projection: bool,
    session_id: Option<String>,
    request_id: Option<String>,
    expected_model_id: Option<String>,
    client_responses_projection: bool,
    namespace_tool_identities: std::collections::HashMap<String, (String, String)>,
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
                provider_response_compat_profile,
                namespace_tool_identities,
                ..Default::default()
            }
            .with_typed_hooks(typed_hooks)
            .with_custom_tool_function_binding(custom_tool_function_binding)
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
                                // The protocol frame closes external time only.
                                // Collector admission, memory rewriting and sealing
                                // must succeed before the runtime timing owner finishes.
                                if terminal_observed {
                                    if let Err(error) =
                                        state.runtime_timing.finish_external_if_active()
                                    {
                                        return Some((
                                            Err(runtime_source("V3RuntimeTimingExternal", error)),
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
                            Ok(()) => {
                                if let Err(error) = state.runtime_timing.finish_external_if_active()
                                {
                                    return Some((
                                        Err(runtime_source("V3RuntimeTimingExternal", error)),
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
) -> crate::shared::V3DirectSourceResult<crate::nodes::V3CommittedClientSseStream> {
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
    stream: V3SseAttemptStream,
    provider_protocol: V3HubProviderWireProtocol,
    attempt_budget: crate::nodes::V3AttemptBudget,
    manifest: Option<&V3Config05ManifestPublished>,
    request_id: Option<&str>,
) -> crate::shared::V3DirectSourceResult<crate::nodes::V3CommittedClientSseStream> {
    collect_direct_sse_attempt_after_terminal_with_hooks(
        stream,
        provider_protocol,
        attempt_budget,
        manifest,
        request_id,
        None,
    )
    .await
}

pub(crate) async fn collect_direct_sse_attempt_after_terminal_with_hooks(
    mut stream: V3SseAttemptStream,
    provider_protocol: V3HubProviderWireProtocol,
    attempt_budget: crate::nodes::V3AttemptBudget,
    manifest: Option<&V3Config05ManifestPublished>,
    request_id: Option<&str>,
    response_hook: Option<(
        &crate::hooks::V3HookRegistry,
        &crate::direct_response_hooks::V3DirectDsmlContext,
    )>,
) -> crate::shared::V3DirectSourceResult<crate::nodes::V3CommittedClientSseStream> {
    let deadline = tokio::time::Instant::from_std(attempt_budget.residence_deadline());
    let mut committed = crate::nodes::V3CommittedClientSseBuilder::with_budget(attempt_budget)
        .map_err(|error| {
            crate::shared::direct_plain_error(
                V3ErrorSourceKind::RuntimeFailure,
                "V3ExecutionAttemptPayloadStore",
                "direct_sse_attempt_store_rejected",
                error.to_string(),
            )
        })?;
    let mut terminal_seen = false;
    let mut business_decoder = SseIncrementalDecoder::new(SseTransportLimits::default());
    let mut has_business_content = false;
    loop {
        let next = match tokio::time::timeout_at(deadline, stream.next()).await {
            Ok(next) => next,
            Err(_) if terminal_seen => break,
            Err(_) => {
                return Err(crate::shared::direct_plain_error(
                    V3ErrorSourceKind::ProviderFailure,
                    "V3ProviderResp14Raw",
                    "provider_response_residence_timeout",
                    "provider SSE attempt exceeded the request residence deadline before a semantic terminal",
                ))
            }
        };
        let Some(frame) = next else { break };
        // The attempt is complete at the protocol terminal.  A provider
        // transport error or an unterminated tail after the terminal is
        // post-terminal noise and must seal the already-validated attempt
        // rather than reopen it (parity with the relay path, which ignores
        // post-terminal read errors).
        let frame = match frame {
            Ok(frame) => frame,
            // A typed SDK fault is never post-terminal transport noise. It must
            // reach the caller intact instead of sealing an already-validated
            // business attempt as success.
            Err(Err(fault)) => return Err(Err(fault)),
            Err(Ok(_)) if terminal_seen => break,
            Err(Ok(source)) => return Err(Ok(source)),
        };
        let disposition = frame.disposition;
        if terminal_seen && disposition == V3SseFrameDisposition::Continue {
            return Err(crate::shared::direct_plain_error(
                V3ErrorSourceKind::RuntimeFailure,
                "V3ExecutionAttemptPayloadStore",
                "direct_sse_frame_after_terminal",
                "Direct SSE projected a continuation frame after semantic terminal",
            ));
        }
        let frame = frame.bytes;
        has_business_content |= direct_sse_chunk_has_business_content(
            provider_protocol,
            &frame,
            &mut business_decoder,
        )?;
        committed.push(frame).map_err(|error| {
            crate::shared::direct_plain_error(
                V3ErrorSourceKind::RuntimeFailure,
                "V3ExecutionAttemptPayloadStore",
                "direct_sse_attempt_store_rejected",
                error.to_string(),
            )
        })?;
        if matches!(
            disposition,
            V3SseFrameDisposition::SemanticTerminal | V3SseFrameDisposition::LegalCloseout
        ) {
            if disposition == V3SseFrameDisposition::LegalCloseout && !terminal_seen {
                return Err(crate::shared::direct_plain_error(
                    V3ErrorSourceKind::ProviderFailure,
                    "V3ProviderResp14Raw",
                    "provider_response_sse_stream",
                    "Direct SSE emitted legal closeout before semantic terminal",
                ));
            }
            terminal_seen = true;
            committed.mark_last_frame_as_terminal().map_err(|error| {
                crate::shared::direct_plain_error(
                    V3ErrorSourceKind::RuntimeFailure,
                    "V3ExecutionAttemptPayloadStore",
                    "direct_sse_terminal_seal_rejected",
                    error.to_string(),
                )
            })?;
            if disposition == V3SseFrameDisposition::LegalCloseout {
                let _ = rewrite_direct_sse_memory(&mut committed, manifest, request_id).map_err(
                    |error| {
                        direct_attempt_store_error_source(
                            error,
                            "V3ExecutionAttemptPayloadStore",
                            "direct_sse_memory_strip_failed",
                        )
                    },
                )?;
                apply_complete_response_hook(&mut committed, response_hook)?;
                has_business_content =
                    direct_sse_frames_have_business_content(provider_protocol, committed.frames());
                if !has_business_content {
                    return Err(direct_sse_empty_attempt_failure());
                }
                let sealed = committed.seal_after_validated_terminal();
                let sealed = sealed.map_err(|error| {
                    crate::shared::direct_plain_error(
                        V3ErrorSourceKind::RuntimeFailure,
                        "V3ExecutionAttemptPayloadStore",
                        "direct_sse_terminal_seal_rejected",
                        error.to_string(),
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
                .map_err(|error| {
                    crate::shared::direct_plain_error(
                        V3ErrorSourceKind::RuntimeFailure,
                        "V3ExecutionAttemptPayloadStore",
                        "direct_sse_attempt_store_rejected",
                        error.to_string(),
                    )
                })?;
        }
        let _ =
            rewrite_direct_sse_memory(&mut committed, manifest, request_id).map_err(|error| {
                direct_attempt_store_error_source(
                    error,
                    "V3ExecutionAttemptPayloadStore",
                    "direct_sse_memory_strip_failed",
                )
            })?;
        apply_complete_response_hook(&mut committed, response_hook)?;
        has_business_content =
            direct_sse_frames_have_business_content(provider_protocol, committed.frames());
        if !has_business_content {
            return Err(direct_sse_empty_attempt_failure());
        }
        let sealed = committed.seal_after_validated_terminal();
        let sealed = sealed.map_err(|error| {
            crate::shared::direct_plain_error(
                V3ErrorSourceKind::RuntimeFailure,
                "V3ExecutionAttemptPayloadStore",
                "direct_sse_terminal_seal_rejected",
                error.to_string(),
            )
        });
        return sealed;
    }
    Err(crate::shared::direct_plain_error(
        V3ErrorSourceKind::ProviderFailure,
        "V3ProviderResp14Raw",
        "provider_response_sse_stream",
        "provider SSE ended without a protocol terminal",
    ))
}

fn apply_complete_response_hook(
    committed: &mut crate::execution_control::V3CommittedClientSseBuilder,
    hook: Option<(
        &crate::hooks::V3HookRegistry,
        &crate::direct_response_hooks::V3DirectDsmlContext,
    )>,
) -> crate::shared::V3DirectSourceResult<()> {
    if let Some((registry, context)) = hook {
        registry
            .project_complete_direct_sse(committed, context)
            .map_err(|error| match error {
                crate::hooks::V3DirectCompleteResponseError::Normalization(failure) => {
                    crate::hooks::direct_complete_response_hook_failure_source(failure)
                }
                crate::hooks::V3DirectCompleteResponseError::Store(error) => {
                    direct_attempt_store_error_source(
                        error,
                        "V3DirectResp14ProviderProjectionPrepared",
                        "direct_response_hook_budget",
                    )
                }
            })?;
    }
    Ok(())
}

fn direct_sse_frames_have_business_content(
    provider_protocol: V3HubProviderWireProtocol,
    frames: &[Vec<u8>],
) -> bool {
    frames.iter().any(|frame| {
        parse_direct_sse_json_frames(frame).iter().any(|value| {
            crate::hub_v1::v3_provider_event_has_deliverable_business_content(
                provider_protocol,
                value,
            )
        })
    })
}

/// Typed provider-failure source for a complete Direct SSE attempt that carries
/// no deliverable business content. It enters the existing provider failure
/// policy (reselect/cooldown), never a client error or an empty completion.
pub(crate) fn direct_attempt_budget_error_source(
    error: crate::nodes::V3AttemptStoreError,
) -> crate::shared::V3DirectSourceError {
    direct_attempt_store_error_source(
        error,
        "V3ExecutionAttemptBudget",
        "direct_transport_attempt_rejected",
    )
}

pub(crate) fn direct_attempt_store_error_source(
    error: crate::nodes::V3AttemptStoreError,
    stage: &'static str,
    code: &'static str,
) -> crate::shared::V3DirectSourceError {
    match error {
        crate::nodes::V3AttemptStoreError::ResidenceDeadlineExceeded(message) => {
            crate::shared::direct_plain_error(
                V3ErrorSourceKind::TargetPoolExhausted,
                stage,
                "request_residence_deadline_exceeded",
                message,
            )
        }
        error => crate::shared::direct_plain_error(
            V3ErrorSourceKind::RuntimeFailure,
            stage,
            code,
            error.to_string(),
        ),
    }
}

fn direct_sse_empty_attempt_failure() -> crate::shared::V3DirectSourceError {
    crate::shared::direct_plain_error(
        V3ErrorSourceKind::ProviderFailure,
        "V3ProviderResp14Raw",
        "provider_response_empty",
        "provider returned a complete response with no deliverable business content",
    )
}

/// Read business facts from validated, projected frames without buffering a
/// second copy or running another response materializer. Decoder failures
/// remain errors and cannot make an empty attempt appear successful.
fn direct_sse_chunk_has_business_content(
    provider_protocol: V3HubProviderWireProtocol,
    chunk: &[u8],
    decoder: &mut SseIncrementalDecoder,
) -> crate::shared::V3DirectSourceResult<bool> {
    let mut has_output = false;
    let frames = decoder
        .push(build_v3_sse_transport_in_01_raw_chunk(chunk))
        .map_err(build_v3_sse_transport_error_source)?;
    for frame in frames {
        if is_v3_provider_sse_transport_keepalive_frame(frame.frame().fields()) {
            continue;
        }
        let data = crate::hub_v1::normalize_v3_provider_sse_json_data_for_event_name(
            provider_protocol,
            frame.frame().fields(),
        )
        .map_err(provider_sse_failure_source)?;
        if let Some(payload) = crate::hub_v1::parse_v3_provider_sse_json_data(&data)
            .map_err(provider_sse_failure_source)?
        {
            has_output |= crate::hub_v1::v3_provider_event_has_deliverable_business_content(
                provider_protocol,
                &payload,
            );
        }
    }
    Ok(has_output)
}

fn rewrite_direct_sse_memory(
    committed: &mut crate::execution_control::V3CommittedClientSseBuilder,
    manifest: Option<&V3Config05ManifestPublished>,
    request_id: Option<&str>,
) -> Result<Option<bool>, crate::execution_control::V3AttemptStoreError> {
    let Some(manifest) = manifest else {
        return Ok(None);
    };
    let Some(request_id) = request_id else {
        return Ok(None);
    };
    if !manifest.memory_raw_capture.enabled {
        return Ok(None);
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
        return Ok(None);
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
    let mut has_business_content = false;
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
                Some("response.output_item.added" | "response.output_item.done") => {
                    if let Some(item) = value.get_mut("item") {
                        routecodex_v3_agent_memory::strip_memory_envelope_from_responses_output_item(
                            item, &report,
                        );
                    }
                }
                Some("response.content_part.added" | "response.content_part.done") => {
                    if let Some(part) = value.get_mut("part") {
                        routecodex_v3_agent_memory::strip_memory_envelope_from_responses_output_part(
                            part, &report,
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
            // Reuse the complete-attempt predicate on the final projected
            // value. The removed memory text cannot count toward admission.
            has_business_content |=
                crate::hub_v1::v3_provider_event_has_deliverable_business_content(
                    V3HubProviderWireProtocol::Responses,
                    &value,
                );
            value
        })
    })?;
    Ok(Some(has_business_content))
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

pub(crate) fn parse_direct_sse_json_frames(frame: &[u8]) -> Vec<serde_json::Value> {
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
    let source: crate::nodes::V3ProviderAttemptSseInnerStream =
        Box::pin(source.map(|item| item.map_err(Ok)));
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
    dsml_context: &crate::direct_response_hooks::V3DirectDsmlContext,
    namespace_tool_identities: std::collections::HashMap<String, (String, String)>,
    hook_registry: &V3HookRegistry,
    failure_session_scope: &V3ProviderFailureSessionScope,
    attempt_budget: V3AttemptBudget,
) -> crate::shared::V3DirectSourceResult<crate::nodes::V3CommittedClientSseStream> {
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
        compat_plan
            .has_block(V3DirectResponseCompatBlock::ProviderResponseCompat)
            .then(|| compat_plan.provider_response_compat_profile())
            .flatten()
            .map(ToOwned::to_owned),
        compat_plan.custom_tool_function_binding.clone(),
        hook_registry.direct_sse_typed_hooks(),
        crate::hub_v1::v3_tool_thinking_enabled_for_server(manifest, server_id),
        crate::hub_v1::v3_toolreason_client_projection_enabled_for_server(manifest, server_id),
        Some(failure_session_scope.session_id().to_owned()),
        Some(request_id.to_owned()),
        Some(compat_plan.canonical_model_id.clone()),
        true,
        namespace_tool_identities,
    );
    collect_direct_sse_attempt_after_terminal_with_hooks(
        projected,
        compat_plan.provider_protocol,
        attempt_budget,
        Some(manifest),
        Some(request_id),
        Some((hook_registry, dsml_context)),
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
) -> crate::shared::V3DirectSourceResult<Option<V3SseAttemptFrame>> {
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
                return Err(crate::shared::direct_plain_error(
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
) -> crate::shared::V3DirectSourceResult<()> {
    let data = collect_v3_provider_sse_json_data(fields);
    if is_v3_provider_sse_keepalive_text(&data) {
        return Ok(());
    }
    record_v3_provider_sse_json_frame(fields, stream_observation)
        .map_err(provider_sse_failure_source)
}

fn provider_sse_failure_source(
    message: impl Into<String>,
) -> Result<V3Error01SourceRaised, crate::provider_failure_runtime_policy::V3RelayErrorOperatorFault>
{
    crate::shared::direct_source_error(
        V3ErrorSourceKind::ProviderFailure,
        "V3ProviderResp14Raw",
        "provider_response_sse_stream",
        message.into(),
        crate::operation_runner::V3Err01SourceInput::Plain,
    )
}

pub(crate) fn runtime_source(
    stage: &'static str,
    error: impl std::fmt::Display,
) -> Result<V3Error01SourceRaised, crate::provider_failure_runtime_policy::V3RelayErrorOperatorFault>
{
    crate::shared::raise_v3_runtime_failure_source(
        stage,
        "v3_route_target_runtime_failure",
        error.to_string(),
    )
}

/// Raw diagnostic leaf for an SDK02..06 operator fault. It records the SDK
/// failure itself and must never run Error01 again, because a second Err01
/// failure would erase the original operator fault.
pub(crate) fn sdk_fault_leaf_source(
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
) -> crate::shared::V3DirectSourceError {
    use crate::hub_v1::V3ProviderCompatErrorClassification;
    match error.classification() {
        V3ProviderCompatErrorClassification::PayloadBoundaryViolation => {
            crate::hub_v1::provider_compat_boundary_source(stage, error)
        }
        V3ProviderCompatErrorClassification::RequestPayloadInvalid => {
            crate::hub_v1::provider_request_payload_source(stage, error)
        }
        V3ProviderCompatErrorClassification::Other => {
            crate::shared::raise_v3_runtime_failure_source(
                stage,
                "v3_route_target_runtime_failure",
                error.to_string(),
            )
        }
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
        let source = compat_source("V3HubReqOutbound07ProviderSemantic", &error)
            .expect("compat source must execute Error01 successfully");
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
        let source = compat_source("V3ProviderRespInbound01Raw", &error)
            .expect("compat source must execute Error01 successfully");
        assert_eq!(source.source_kind, V3ErrorSourceKind::RuntimeFailure);
    }
}

pub(crate) fn source_failure_output(
    source: Result<
        V3Error01SourceRaised,
        crate::provider_failure_runtime_policy::V3RelayErrorOperatorFault,
    >,
    last_external_http: Option<V3ExternalHttpWitness>,
    node_trace: Vec<&'static str>,
    hook_registry: &V3HookRegistry,
) -> V3ResponsesDirectRuntimeOutput {
    source_failure_output_with_observability_and_snapshots(
        source,
        last_external_http,
        node_trace,
        hook_registry,
        None,
        None,
        None,
    )
}

pub(crate) fn source_failure_output_with_observability_and_snapshots(
    source: Result<
        V3Error01SourceRaised,
        crate::provider_failure_runtime_policy::V3RelayErrorOperatorFault,
    >,
    last_external_http: Option<V3ExternalHttpWitness>,
    node_trace: Vec<&'static str>,
    hook_registry: &V3HookRegistry,
    observability: Option<V3RuntimeObservability>,
    provider_request_snapshot: Option<serde_json::Value>,
    provider_response_snapshot: Option<serde_json::Value>,
) -> V3ResponsesDirectRuntimeOutput {
    match source {
        Ok(source) => error_output_with_observability_and_snapshots(
            source,
            node_trace,
            hook_registry,
            observability,
            provider_request_snapshot,
            provider_response_snapshot,
        ),
        Err(fault) => {
            let mut output = operator_fault_output_with_observability_and_snapshots(
                fault,
                node_trace,
                observability,
                provider_request_snapshot,
                provider_response_snapshot,
            );
            output.terminal_disposition = Some(match last_external_http {
                Some(witness) => V3ProviderTerminalDisposition::ExternalHttp(witness),
                None => V3ProviderTerminalDisposition::NoResponse,
            });
            output
        }
    }
}

pub(crate) fn error_output(
    source: V3Error01SourceRaised,
    node_trace: Vec<&'static str>,
    hook_registry: &V3HookRegistry,
) -> V3ResponsesDirectRuntimeOutput {
    error_output_with_observability(source, node_trace, hook_registry, None)
}

pub(crate) fn operator_fault_output(
    fault: crate::provider_failure_runtime_policy::V3RelayErrorOperatorFault,
    node_trace: Vec<&'static str>,
    hook_registry: &V3HookRegistry,
) -> V3ResponsesDirectRuntimeOutput {
    let _ = hook_registry;
    operator_fault_output_with_observability_and_snapshots(fault, node_trace, None, None, None)
}

pub(crate) fn operator_fault_output_with_observability(
    fault: crate::provider_failure_runtime_policy::V3RelayErrorOperatorFault,
    node_trace: Vec<&'static str>,
    hook_registry: &V3HookRegistry,
    observability: Option<V3RuntimeObservability>,
) -> V3ResponsesDirectRuntimeOutput {
    let _ = hook_registry;
    operator_fault_output_with_observability_and_snapshots(
        fault,
        node_trace,
        observability,
        None,
        None,
    )
}

pub(crate) fn operator_fault_output_with_observability_and_snapshots(
    fault: crate::provider_failure_runtime_policy::V3RelayErrorOperatorFault,
    node_trace: Vec<&'static str>,
    observability: Option<V3RuntimeObservability>,
    provider_request_snapshot: Option<serde_json::Value>,
    provider_response_snapshot: Option<serde_json::Value>,
) -> V3ResponsesDirectRuntimeOutput {
    V3ResponsesDirectRuntimeOutput {
        observability,
        terminal_disposition: Some(V3ProviderTerminalDisposition::NoResponse),
        diagnostic_source: Some(fault.policy_failure),
        diagnostic_cause: fault.original_source,
        stream_observation: None,
        provider_request_snapshot,
        provider_response_snapshot,
        client_payload: V3Resp15ClientPayload {
            status: 599,
            headers: BTreeMap::from([("content-type".to_string(), "application/json".to_string())]),
            body: V3ClientBody::Json(serde_json::Value::Null),
        },
        node_trace,
        error_chain: None,
        protocol_relay_handoff: None,
    }
}

pub(crate) fn error_output_with_observability(
    source: V3Error01SourceRaised,
    node_trace: Vec<&'static str>,
    hook_registry: &V3HookRegistry,
    observability: Option<V3RuntimeObservability>,
) -> V3ResponsesDirectRuntimeOutput {
    error_output_with_observability_and_snapshots(
        source,
        node_trace,
        hook_registry,
        observability,
        None,
        None,
    )
}

pub(crate) fn error_output_with_observability_and_snapshots(
    source: V3Error01SourceRaised,
    node_trace: Vec<&'static str>,
    hook_registry: &V3HookRegistry,
    observability: Option<V3RuntimeObservability>,
    provider_request_snapshot: Option<serde_json::Value>,
    provider_response_snapshot: Option<serde_json::Value>,
) -> V3ResponsesDirectRuntimeOutput {
    let target_exhausted = source.source_kind == V3ErrorSourceKind::TargetPoolExhausted;
    let original_source = source.clone();
    let (decision_projection, decision) =
        match hook_registry.run_error(source, V3ErrorActionScope::None, 0, false, false, None) {
            Ok(result) => result,
            Err(error) => {
                return sdk_runtime_fault_output_with_observability_and_snapshots(
                    original_source,
                    sdk_fault_leaf_source("V3Error05ExecutionDecision", error),
                    None,
                    node_trace,
                    observability,
                    provider_request_snapshot,
                    provider_response_snapshot,
                )
            }
        };
    let projected = match crate::operation_runner::run_v3_error_06_terminal_projection_operator(
        decision_projection,
        decision,
    ) {
        Ok(Some((_, projected))) => projected,
        Ok(None) => {
            return sdk_runtime_fault_output_with_observability_and_snapshots(
                original_source.clone(),
                sdk_fault_leaf_source(
                    "V3Error06ClientProjected",
                    "normal local terminal decision was not terminal",
                ),
                None,
                node_trace,
                observability,
                provider_request_snapshot,
                provider_response_snapshot,
            )
        }
        Err(error) => {
            return sdk_runtime_fault_output_with_observability_and_snapshots(
                original_source,
                sdk_fault_leaf_source("V3Error06ClientProjected", error),
                None,
                node_trace,
                observability,
                provider_request_snapshot,
                provider_response_snapshot,
            )
        }
    };
    let mut output = projected_error_output_with_observability_and_snapshots(
        projected,
        node_trace,
        observability,
        provider_request_snapshot,
        provider_response_snapshot,
    );
    if target_exhausted {
        output.terminal_disposition = Some(V3ProviderTerminalDisposition::NoResponse);
    }
    output
}

pub(crate) fn policy_failure_output_with_observability(
    failure: DirectPolicyFailure,
    last_external_http: Option<V3ExternalHttpWitness>,
    node_trace: Vec<&'static str>,
    observability: Option<V3RuntimeObservability>,
) -> V3ResponsesDirectRuntimeOutput {
    sdk_runtime_fault_output_with_observability_and_snapshots(
        failure.original_source,
        failure.policy_failure,
        last_external_http,
        node_trace,
        observability,
        None,
        None,
    )
}

pub(crate) fn target_exhausted_output_with_observability(
    source: crate::shared::V3DirectSourceError,
    witness: Option<V3ExternalHttpWitness>,
    node_trace: Vec<&'static str>,
    hook_registry: &V3HookRegistry,
    observability: Option<V3RuntimeObservability>,
) -> V3ResponsesDirectRuntimeOutput {
    let mut output = match source {
        Ok(source) => {
            assert_eq!(source.source_kind, V3ErrorSourceKind::TargetPoolExhausted);
            error_output_with_observability(source, node_trace, hook_registry, observability)
        }
        Err(fault) => operator_fault_output_with_observability_and_snapshots(
            fault,
            node_trace,
            observability,
            None,
            None,
        ),
    };
    output.terminal_disposition = Some(match witness {
        Some(response) => V3ProviderTerminalDisposition::ExternalHttp(response),
        None => V3ProviderTerminalDisposition::NoResponse,
    });
    output
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
    mut node_trace: Vec<&'static str>,
    observability: Option<V3RuntimeObservability>,
    provider_request_snapshot: Option<serde_json::Value>,
    provider_response_snapshot: Option<serde_json::Value>,
) -> V3ResponsesDirectRuntimeOutput {
    if projected.pool_exhausted {
        node_trace.push("V3Error04TargetPoolExhaustion");
    }
    V3ResponsesDirectRuntimeOutput {
        observability,
        terminal_disposition: None,
        diagnostic_source: Some(projected.diagnostic_source),
        diagnostic_cause: None,
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

pub(crate) fn provider_terminal_output(
    decision: V3Error05ExecutionDecision,
    witness: Option<V3ExternalHttpWitness>,
    node_trace: Vec<&'static str>,
    observability: Option<V3RuntimeObservability>,
    provider_request_snapshot: Option<serde_json::Value>,
    provider_response_snapshot: Option<serde_json::Value>,
) -> V3ResponsesDirectRuntimeOutput {
    let decision_projection = match serde_json::to_value(&decision) {
        Ok(projection) => projection,
        Err(error) => {
            return sdk_runtime_fault_output_with_observability_and_snapshots(
                decision.exhaustion.local_action.classified.source,
                sdk_fault_leaf_source("V3Error06ClientProjected", error),
                witness,
                node_trace,
                observability,
                provider_request_snapshot,
                provider_response_snapshot,
            )
        }
    };
    let disposition = match witness {
        Some(response) => V3ProviderTerminalDisposition::ExternalHttp(response),
        None => V3ProviderTerminalDisposition::NoResponse,
    };
    provider_terminal_output_with_decision_projection(
        decision,
        decision_projection,
        disposition,
        node_trace,
        observability,
        provider_request_snapshot,
        provider_response_snapshot,
    )
}

fn provider_terminal_output_with_decision_projection(
    decision: V3Error05ExecutionDecision,
    decision_projection: serde_json::Value,
    disposition: V3ProviderTerminalDisposition,
    node_trace: Vec<&'static str>,
    observability: Option<V3RuntimeObservability>,
    provider_request_snapshot: Option<serde_json::Value>,
    provider_response_snapshot: Option<serde_json::Value>,
) -> V3ResponsesDirectRuntimeOutput {
    let original_source = decision.exhaustion.local_action.classified.source.clone();
    match crate::operation_runner::run_v3_error_06_terminal_projection_operator(
        decision_projection,
        decision,
    ) {
        Ok(Some((_, projected))) => {
            let mut output = projected_error_output_with_observability_and_snapshots(
                projected,
                node_trace,
                observability,
                provider_request_snapshot,
                provider_response_snapshot,
            );
            output.terminal_disposition = Some(disposition);
            output
        }
        Ok(None) => sdk_runtime_fault_output_with_observability_and_snapshots(
            original_source.clone(),
            sdk_fault_leaf_source(
                "V3Error06ClientProjected",
                "provider terminal decision was not terminal",
            ),
            match disposition.clone() {
                V3ProviderTerminalDisposition::ExternalHttp(witness) => Some(witness),
                V3ProviderTerminalDisposition::NoResponse => None,
            },
            node_trace,
            observability,
            provider_request_snapshot,
            provider_response_snapshot,
        ),
        Err(error) => sdk_runtime_fault_output_with_observability_and_snapshots(
            original_source,
            sdk_fault_leaf_source("V3Error06ClientProjected", error),
            match disposition {
                V3ProviderTerminalDisposition::ExternalHttp(witness) => Some(witness),
                V3ProviderTerminalDisposition::NoResponse => None,
            },
            node_trace,
            observability,
            provider_request_snapshot,
            provider_response_snapshot,
        ),
    }
}

pub(crate) fn client_disconnect_terminal_output(
    decision: V3Error05ExecutionDecision,
    node_trace: Vec<&'static str>,
    observability: Option<V3RuntimeObservability>,
) -> V3ResponsesDirectRuntimeOutput {
    let decision_projection = match serde_json::to_value(&decision) {
        Ok(projection) => projection,
        Err(error) => {
            return sdk_runtime_fault_output_with_observability_and_snapshots(
                decision.exhaustion.local_action.classified.source,
                sdk_fault_leaf_source("V3Error06ClientProjected", error),
                None,
                node_trace,
                observability,
                None,
                None,
            )
        }
    };
    client_disconnect_terminal_output_with_decision_projection(
        decision,
        decision_projection,
        node_trace,
        observability,
        None,
        None,
    )
}

fn client_disconnect_terminal_output_with_decision_projection(
    decision: V3Error05ExecutionDecision,
    decision_projection: serde_json::Value,
    node_trace: Vec<&'static str>,
    observability: Option<V3RuntimeObservability>,
    provider_request_snapshot: Option<serde_json::Value>,
    provider_response_snapshot: Option<serde_json::Value>,
) -> V3ResponsesDirectRuntimeOutput {
    let original_source = decision.exhaustion.local_action.classified.source.clone();
    match crate::operation_runner::run_v3_error_06_terminal_projection_operator(
        decision_projection,
        decision,
    ) {
        Ok(Some((_, projected))) => projected_error_output_with_observability_and_snapshots(
            projected,
            node_trace,
            observability,
            provider_request_snapshot,
            provider_response_snapshot,
        ),
        Ok(None) => sdk_runtime_fault_output_with_observability_and_snapshots(
            original_source.clone(),
            crate::kernel::direct_runtime_helpers_stream::sdk_fault_leaf_source(
                "V3Error06ClientProjected",
                "client disconnect decision was not terminal",
            ),
            None,
            node_trace,
            observability,
            provider_request_snapshot,
            provider_response_snapshot,
        ),
        Err(error) => sdk_runtime_fault_output_with_observability_and_snapshots(
            original_source,
            crate::kernel::direct_runtime_helpers_stream::sdk_fault_leaf_source(
                "V3Error06ClientProjected",
                error,
            ),
            None,
            node_trace,
            observability,
            provider_request_snapshot,
            provider_response_snapshot,
        ),
    }
}

fn sdk_runtime_fault_output_with_observability_and_snapshots(
    original_source: V3Error01SourceRaised,
    sdk_fault: V3Error01SourceRaised,
    witness: Option<V3ExternalHttpWitness>,
    node_trace: Vec<&'static str>,
    observability: Option<V3RuntimeObservability>,
    provider_request_snapshot: Option<serde_json::Value>,
    provider_response_snapshot: Option<serde_json::Value>,
) -> V3ResponsesDirectRuntimeOutput {
    V3ResponsesDirectRuntimeOutput {
        observability,
        terminal_disposition: Some(match witness {
            Some(response) => V3ProviderTerminalDisposition::ExternalHttp(response),
            None => V3ProviderTerminalDisposition::NoResponse,
        }),
        diagnostic_source: Some(sdk_fault),
        diagnostic_cause: Some(original_source),
        stream_observation: None,
        provider_request_snapshot,
        provider_response_snapshot,
        client_payload: V3Resp15ClientPayload {
            status: 599,
            headers: BTreeMap::from([("content-type".to_string(), "application/json".to_string())]),
            body: V3ClientBody::Json(serde_json::Value::Null),
        },
        node_trace,
        error_chain: None,
        protocol_relay_handoff: None,
    }
}

#[cfg(test)]
mod target_exhaustion_disposition_tests {
    use super::*;

    #[test]
    fn seeded_direct_source_fault_retains_prior_http_witness_and_original_cause() {
        let original = build_v3_error_01_source_raised(
            V3ErrorSourceKind::RuntimeFailure,
            "V3Provider12ResponsesWirePayload",
            "request_projection_failed",
            "seeded Direct origin",
        );
        let policy_failure = build_v3_error_01_source_raised(
            V3ErrorSourceKind::RuntimeFailure,
            "V3Error01SourceRaised",
            "err01_source_operator_sdk_failure",
            "seeded SDK fault carrier, not a public rejection input",
        );
        let witness = V3ExternalHttpWitness::new(
            429,
            vec![("content-type".into(), b"application/json".to_vec())],
            br#"{"error":"prior attempt limited"}"#.to_vec(),
        );
        let output = source_failure_output(
            Err(
                crate::provider_failure_runtime_policy::V3RelayErrorOperatorFault {
                    policy_failure: policy_failure.clone(),
                    original_source: Some(original.clone()),
                },
            ),
            Some(witness.clone()),
            vec!["V3Provider12ResponsesWirePayload"],
            &crate::hooks::register_responses_direct_hooks(),
        );
        assert_eq!(output.diagnostic_source, Some(policy_failure));
        assert_eq!(output.diagnostic_cause, Some(original));
        assert_eq!(
            output.terminal_disposition,
            Some(V3ProviderTerminalDisposition::ExternalHttp(witness))
        );
        assert!(output.error_chain.is_none());
        assert!(matches!(
            output.client_payload.body,
            V3ClientBody::Json(serde_json::Value::Null)
        ));
    }

    #[test]
    fn direct_target_exhaustion_reaches_transport_disconnect_witness() {
        let source = routecodex_v3_error::build_v3_error_01_source_raised(
            routecodex_v3_error::V3ErrorSourceKind::TargetPoolExhausted,
            "V3Target10ConcreteProviderSelected",
            "selected_target_exhausted",
            "all route tiers unavailable",
        );
        let output = error_output(
            source,
            Vec::new(),
            &crate::hooks::register_responses_direct_hooks(),
        );
        assert!(output.node_trace.contains(&"V3Error04TargetPoolExhaustion"));
        assert_eq!(
            output.terminal_disposition,
            Some(V3ProviderTerminalDisposition::NoResponse)
        );
    }

    #[test]
    fn direct_target_exhaustion_keeps_prior_real_upstream_http_response() {
        let witness = V3ExternalHttpWitness::new(
            429,
            vec![("content-type".into(), b"application/json".to_vec())],
            br#"{"error":"limit"}"#.to_vec(),
        );
        let source = routecodex_v3_error::build_v3_error_01_source_raised(
            V3ErrorSourceKind::TargetPoolExhausted,
            "V3Target10ConcreteProviderSelected",
            "selected_target_exhausted",
            "all route tiers unavailable",
        );
        let output = target_exhausted_output_with_observability(
            Ok(source),
            Some(witness.clone()),
            Vec::new(),
            &crate::hooks::register_responses_direct_hooks(),
            None,
        );
        assert_eq!(
            output.terminal_disposition,
            Some(V3ProviderTerminalDisposition::ExternalHttp(witness))
        );
    }

    #[test]
    fn direct_target_exhaustion_sdk_fault_keeps_cause_and_witness() {
        let original = routecodex_v3_error::build_v3_error_01_source_raised(
            V3ErrorSourceKind::ProviderFailure,
            "V3ProviderRespInbound01Raw",
            "provider_unavailable",
            "provider unavailable",
        );
        let policy_failure = routecodex_v3_error::build_v3_error_01_source_raised(
            V3ErrorSourceKind::RuntimeFailure,
            "V3Error01SourceRaised",
            "err01_source_operator_sdk_failure",
            "Error01 operator failed",
        );
        let fault = crate::provider_failure_runtime_policy::V3RelayErrorOperatorFault {
            policy_failure: policy_failure.clone(),
            original_source: Some(original.clone()),
        };
        let witness = V3ExternalHttpWitness::new(
            429,
            vec![("content-type".into(), b"application/json".to_vec())],
            br#"{"error":"limit"}"#.to_vec(),
        );
        let output = target_exhausted_output_with_observability(
            Err(fault),
            Some(witness.clone()),
            vec!["V3Target10ConcreteProviderSelected"],
            &crate::hooks::register_responses_direct_hooks(),
            None,
        );

        assert_eq!(output.client_payload.status, 599);
        assert_eq!(output.diagnostic_source, Some(policy_failure));
        assert_eq!(output.diagnostic_cause, Some(original));
        assert_eq!(
            output.terminal_disposition,
            Some(V3ProviderTerminalDisposition::ExternalHttp(witness))
        );
    }

    #[test]
    fn direct_provider_terminal_uses_witness_or_no_response() {
        let decision = V3ErrorHandlingCenter::decide_provider(
            V3ErrorHandlingCenterInput {
                source: routecodex_v3_error::build_v3_error_01_source_raised(
                    V3ErrorSourceKind::ProviderFailure,
                    "V3Transport13ResponsesHttpRequest",
                    "provider_transport_error",
                    "provider connection failed",
                ),
                action_scope: V3ErrorActionScope::None,
                candidates_remaining: 0,
                source_status: None,
            },
            false,
            false,
            None,
        );
        assert_eq!(decision.action, V3Error05ExecutionAction::ProjectTerminal);
        let no_response =
            provider_terminal_output(decision.clone(), None, Vec::new(), None, None, None);
        assert_eq!(
            no_response.terminal_disposition,
            Some(V3ProviderTerminalDisposition::NoResponse)
        );
        let witness = V3ExternalHttpWitness::new(
            429,
            vec![("content-type".into(), b"application/json".to_vec())],
            br#"{"error":"limited"}"#.to_vec(),
        );
        let external = provider_terminal_output(
            decision,
            Some(witness.clone()),
            Vec::new(),
            None,
            None,
            None,
        );
        assert_eq!(
            external.terminal_disposition,
            Some(V3ProviderTerminalDisposition::ExternalHttp(witness))
        );
    }

    fn provider_terminal_decision() -> V3Error05ExecutionDecision {
        let source = routecodex_v3_error::build_v3_error_01_source_raised(
            V3ErrorSourceKind::ProviderFailure,
            "V3Transport13ResponsesHttpRequest",
            "provider_transport_error",
            "provider connection failed",
        );
        let classified = routecodex_v3_error::build_v3_error_02_classified_from_v3_error_01(source);
        let action = routecodex_v3_error::build_v3_error_03_target_local_action_from_v3_error_02(
            classified,
            V3ErrorActionScope::ProviderKeyModel {
                provider_id: "provider-a".to_string(),
                auth_alias: "key-a".to_string(),
                model_id: "model-a".to_string(),
            },
            0,
        );
        let exhaustion =
            routecodex_v3_error::build_v3_error_04_target_exhaustion_decision_with_provider_availability(
                action,
                0,
                false,
                false,
            );
        routecodex_v3_error::build_v3_error_05_execution_decision_from_v3_error_04(exhaustion, None)
    }

    #[test]
    fn provider_terminal_sdk_fault_retains_sources_witness_snapshots_and_observability() {
        let decision = provider_terminal_decision();
        let original_source = decision.exhaustion.local_action.classified.source.clone();
        let witness = V3ExternalHttpWitness::new(
            200,
            vec![("content-type".into(), b"application/json".to_vec())],
            br#"{"id":"provider-response"}"#.to_vec(),
        );
        let observability = V3RuntimeObservability {
            entry_protocol: "responses".to_string(),
            execution_mode: "direct".to_string(),
            transport: "sse".to_string(),
            provider_status: Some(200),
            ..Default::default()
        };
        let request_snapshot = json!({"model": "provider-wire-model"});
        let response_snapshot = json!({"status": 200, "body": {"id": "provider-response"}});

        let nonterminal_source = routecodex_v3_error::build_v3_error_01_source_raised(
            V3ErrorSourceKind::ProviderFailure,
            "V3Transport13ResponsesHttpRequest",
            "provider_transport_error",
            "provider connection failed",
        );
        let nonterminal_recovery = V3Error05RecoveryAdmissionWitness::new(
            V3ProviderFailureSessionScope::new("server-a", "group-a", "session-a")
                .expect("test session scope must be valid"),
            "provider-a:key-a:model-a",
            "provider_transport_error",
            1,
        )
        .expect("test recovery witness must be valid");
        let nonterminal_decision = V3ErrorHandlingCenter::decide_provider(
            V3ErrorHandlingCenterInput {
                source: nonterminal_source.clone(),
                action_scope: V3ErrorActionScope::ProviderKeyModel {
                    provider_id: "provider-a".to_string(),
                    auth_alias: "key-a".to_string(),
                    model_id: "model-a".to_string(),
                },
                candidates_remaining: 1,
                source_status: Some(200),
            },
            false,
            false,
            Some(nonterminal_recovery),
        );
        assert_eq!(
            nonterminal_decision.action,
            V3Error05ExecutionAction::WaitThenReselect {
                recovery: nonterminal_decision
                    .action
                    .recovery_witness()
                    .expect("nonterminal decision must retain recovery")
                    .clone(),
            }
        );
        let nonterminal = provider_terminal_output(
            nonterminal_decision,
            Some(witness.clone()),
            vec!["V3ProviderResp14Raw"],
            Some(observability.clone()),
            Some(request_snapshot.clone()),
            Some(response_snapshot.clone()),
        );
        let nonterminal_fault = nonterminal
            .diagnostic_source
            .as_ref()
            .expect("failed SDK06 must retain the generated RuntimeFailure");
        assert_eq!(
            nonterminal_fault.source_kind,
            V3ErrorSourceKind::RuntimeFailure
        );
        assert_eq!(nonterminal_fault.source_stage, "V3Error06ClientProjected");
        assert_eq!(nonterminal_fault.code, "v3_route_target_runtime_failure");
        assert_eq!(
            nonterminal.diagnostic_cause.as_ref(),
            Some(&nonterminal_source)
        );
        assert_eq!(
            nonterminal.terminal_disposition,
            Some(V3ProviderTerminalDisposition::ExternalHttp(witness.clone()))
        );
        assert_eq!(
            nonterminal.provider_request_snapshot.as_ref(),
            Some(&request_snapshot)
        );
        assert_eq!(
            nonterminal.provider_response_snapshot.as_ref(),
            Some(&response_snapshot)
        );
        assert_eq!(nonterminal.observability, Some(observability.clone()));
        assert_eq!(nonterminal.node_trace, vec!["V3ProviderResp14Raw"]);
        assert_eq!(nonterminal.error_chain, None);
        assert!(nonterminal.stream_observation.is_none());
        assert!(nonterminal.protocol_relay_handoff.is_none());
        assert_eq!(nonterminal.client_payload.status, 599);
        assert!(matches!(
            &nonterminal.client_payload.body,
            V3ClientBody::Json(value) if value.is_null()
        ));

        let output = provider_terminal_output_with_decision_projection(
            decision,
            serde_json::Value::Null,
            V3ProviderTerminalDisposition::ExternalHttp(witness.clone()),
            vec!["V3ProviderResp14Raw"],
            Some(observability.clone()),
            Some(request_snapshot.clone()),
            Some(response_snapshot.clone()),
        );

        let fault = output
            .diagnostic_source
            .as_ref()
            .expect("failed SDK06 must retain the generated RuntimeFailure");
        assert_eq!(fault.source_kind, V3ErrorSourceKind::RuntimeFailure);
        assert_eq!(fault.source_stage, "V3Error06ClientProjected");
        assert_eq!(fault.code, "v3_route_target_runtime_failure");
        assert_eq!(output.diagnostic_cause.as_ref(), Some(&original_source));
        assert_eq!(
            output.terminal_disposition,
            Some(V3ProviderTerminalDisposition::ExternalHttp(witness))
        );
        assert_eq!(
            output.provider_request_snapshot.as_ref(),
            Some(&request_snapshot)
        );
        assert_eq!(
            output.provider_response_snapshot.as_ref(),
            Some(&response_snapshot)
        );
        assert_eq!(output.observability, Some(observability));
        assert_eq!(output.node_trace, vec!["V3ProviderResp14Raw"]);
        assert_eq!(output.error_chain, None);
        assert!(output.stream_observation.is_none());
        assert!(output.protocol_relay_handoff.is_none());
        assert_eq!(output.client_payload.status, 599);
        assert!(matches!(
            &output.client_payload.body,
            V3ClientBody::Json(value) if value.is_null()
        ));

        let no_response_decision = provider_terminal_decision();
        let no_response_source = no_response_decision
            .exhaustion
            .local_action
            .classified
            .source
            .clone();
        let no_response_observability = V3RuntimeObservability {
            entry_protocol: "responses".to_string(),
            execution_mode: "direct".to_string(),
            transport: "json".to_string(),
            provider_status: None,
            ..Default::default()
        };
        let no_response = provider_terminal_output_with_decision_projection(
            no_response_decision,
            serde_json::Value::Null,
            V3ProviderTerminalDisposition::NoResponse,
            vec!["V3ProviderResp14Raw"],
            Some(no_response_observability.clone()),
            Some(request_snapshot.clone()),
            Some(response_snapshot.clone()),
        );
        let no_response_fault = no_response
            .diagnostic_source
            .as_ref()
            .expect("failed SDK06 must retain the generated RuntimeFailure");
        assert_eq!(
            no_response_fault.source_kind,
            V3ErrorSourceKind::RuntimeFailure
        );
        assert_eq!(no_response_fault.source_stage, "V3Error06ClientProjected");
        assert_eq!(
            no_response.diagnostic_cause.as_ref(),
            Some(&no_response_source)
        );
        assert_eq!(
            no_response.terminal_disposition,
            Some(V3ProviderTerminalDisposition::NoResponse)
        );
        assert_eq!(
            no_response.provider_request_snapshot,
            Some(request_snapshot)
        );
        assert_eq!(
            no_response.provider_response_snapshot,
            Some(response_snapshot)
        );
        assert_eq!(no_response.observability, Some(no_response_observability));
        assert_eq!(no_response.error_chain, None);
    }

    fn client_disconnect_decision() -> (V3Error01SourceRaised, V3Error05ExecutionDecision) {
        let source = build_v3_error_01_source_raised(
            V3ErrorSourceKind::ClientDisconnect,
            "V3Transport13ResponsesHttpRequest",
            "client_disconnect",
            "client disconnected",
        );
        let classified =
            routecodex_v3_error::build_v3_error_02_classified_from_v3_error_01(source.clone());
        let action = routecodex_v3_error::build_v3_error_03_target_local_action_from_v3_error_02(
            classified,
            V3ErrorActionScope::None,
            0,
        );
        let exhaustion =
            routecodex_v3_error::build_v3_error_04_target_exhaustion_decision_with_provider_availability(
                action,
                0,
                false,
                false,
            );
        let decision = routecodex_v3_error::build_v3_error_05_execution_decision_from_v3_error_04(
            exhaustion, None,
        );
        (source, decision)
    }

    #[test]
    fn disconnect_terminal_projection_keeps_existing_health_neutral_result() {
        let (source, decision) = client_disconnect_decision();
        let output = client_disconnect_terminal_output(
            decision,
            vec!["V3Transport13ResponsesHttpRequest"],
            None,
        );

        assert_eq!(output.diagnostic_source.as_ref(), Some(&source));
        assert_eq!(output.diagnostic_cause, None);
        assert_eq!(output.terminal_disposition, None);
        assert!(output.error_chain.is_some());
    }

    #[test]
    fn disconnect_sdk_fault_uses_no_response_and_preserves_existing_source() {
        let (source, decision) = client_disconnect_decision();
        let output = client_disconnect_terminal_output_with_decision_projection(
            decision,
            serde_json::Value::Null,
            vec!["V3Transport13ResponsesHttpRequest"],
            None,
            None,
            None,
        );

        let fault = output
            .diagnostic_source
            .as_ref()
            .expect("failed SDK06 must retain the generated RuntimeFailure");
        assert_eq!(fault.source_kind, V3ErrorSourceKind::RuntimeFailure);
        assert_eq!(fault.source_stage, "V3Error06ClientProjected");
        assert_eq!(output.diagnostic_cause.as_ref(), Some(&source));
        assert_eq!(
            output.terminal_disposition,
            Some(V3ProviderTerminalDisposition::NoResponse)
        );
        assert_eq!(output.error_chain, None);
    }
}

pub(crate) fn relay_handoff_output(
    target: routecodex_v3_target::V3Target10ConcreteProviderSelected,
    expanded: routecodex_v3_target::V3Target09CandidateSetExpanded,
    request_local_excluded_candidates: BTreeSet<String>,
    route_policy_pending: Option<crate::route_policy::V3RoutePolicyPendingGuard>,
    route_policy_scope: Option<crate::route_policy::V3RoutePolicyScope>,
    node_trace: Vec<&'static str>,
    provider_failure_events: Vec<V3RuntimeProviderFailureObservation>,
    observability_accumulator: V3RuntimeObservabilityAccumulator,
    request_execution_control: V3RequestExecutionControl,
) -> V3ResponsesDirectRuntimeOutput {
    V3ResponsesDirectRuntimeOutput {
        observability: None,
        terminal_disposition: None,
        diagnostic_source: None,
        diagnostic_cause: None,
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
            route_policy_pending,
            route_policy_scope,
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
    fn availability_for_interface(
        &self,
        provider_id: &str,
        interface_id: &str,
        auth_alias: Option<&str>,
        model_id: Option<&str>,
        now_ms: u64,
    ) -> V3ProviderAvailabilityProjection {
        let mut projection = self.base.availability_for_interface(
            provider_id,
            interface_id,
            auth_alias,
            model_id,
            now_ms,
        );
        let key = availability_key(provider_id, interface_id, auth_alias, model_id);
        if self.failed_candidates.contains(&key) {
            projection.available = false;
            projection
                .blocked_scopes
                .push(format!("request_failed:{key}"));
        }
        projection
    }

    fn availability(
        &self,
        provider_id: &str,
        auth_alias: Option<&str>,
        model_id: Option<&str>,
        now_ms: u64,
    ) -> V3ProviderAvailabilityProjection {
        self.availability_for_interface(provider_id, "default", auth_alias, model_id, now_ms)
    }
}

fn candidate_key(candidate: &V3TargetCandidate) -> String {
    availability_key(
        &candidate.provider_id,
        &candidate.interface_id,
        Some(&candidate.auth_alias),
        Some(&candidate.model_id),
    )
}

fn availability_key(
    provider_id: &str,
    interface_id: &str,
    auth_alias: Option<&str>,
    model_id: Option<&str>,
) -> String {
    format!(
        "{}:{}:{}:{}",
        provider_id,
        interface_id,
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
                .availability_for_interface(
                    &candidate.provider_id,
                    &candidate.interface_id,
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
                .availability_for_interface(
                    &candidate.provider_id,
                    &candidate.interface_id,
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
