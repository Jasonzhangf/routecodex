#[derive(Debug, Clone)]
struct V3DirectThinkingItemPlan {
    item_id: String,
    output_index: usize,
    visible: String,
    reasoning: Vec<String>,
    pure_reasoning: bool,
}

pub(crate) fn wrap_v3_direct_responses_thinking_tag_consumer_stream(
    source: V3ProviderAttemptSseStream,
) -> V3ProviderAttemptSseStream {
    struct V3DirectResponsesThinkingTagConsumerState {
        source: V3ProviderAttemptSseStream,
        detector: SseIncrementalDecoder,
        buffered_frames: Vec<SseTransportIn03ValidatedFrameStream>,
        emitted: bool,
        done: bool,
    }

    Box::pin(stream::unfold(
        V3DirectResponsesThinkingTagConsumerState {
            source,
            detector: SseIncrementalDecoder::new(SseTransportLimits::default()),
            buffered_frames: Vec::new(),
            emitted: false,
            done: false,
        },
        |mut state| async move {
            loop {
                if state.done {
                    return None;
                }
                match state.source.next().await {
                    Some(Ok(chunk)) if state.emitted => return Some((Ok(chunk), state)),
                    Some(Ok(chunk)) => {
                        let frames = match state
                            .detector
                            .push(build_v3_sse_transport_in_01_raw_chunk(&chunk))
                        {
                            Ok(frames) => frames,
                            Err(error) => {
                                state.done = true;
                                return Some((
                                    Err(runtime_source(
                                        "V3DirectResp14ProviderProjectionPrepared",
                                        error,
                                    )),
                                    state,
                                ));
                            }
                        };
                        state.buffered_frames.extend(frames.iter().cloned());
                        let terminal = frames.iter().any(|frame| {
                            v3_direct_sse_frame_semantic(frame)
                                .map(|semantic| semantic.protocol.event_type)
                                .is_some_and(|kind| {
                                    matches!(
                                        kind.as_str(),
                                        "response.completed"
                                            | "response.incomplete"
                                            | "response.failed"
                                    )
                                })
                        });
                        if terminal {
                            state.emitted = true;
                            let buffered_frames = std::mem::take(&mut state.buffered_frames);
                            let result = rewrite_v3_direct_thinking_tag_sse_frames(&buffered_frames)
                                .map_err(|error| {
                                    runtime_source(
                                        "V3DirectResp14ProviderProjectionPrepared",
                                        error,
                                    )
                                });
                            return Some((result, state));
                        }
                    }
                    Some(Err(error)) => {
                        state.done = true;
                        return Some((Err(error), state));
                    }
                    None => {
                        state.done = true;
                        let decoder = std::mem::replace(
                            &mut state.detector,
                            SseIncrementalDecoder::new(SseTransportLimits::default()),
                        );
                        if let Err(error) = decoder.finish() {
                            return Some((
                                Err(runtime_source(
                                    "V3DirectResp14ProviderProjectionPrepared",
                                    error.to_string(),
                                )),
                                state,
                            ));
                        }
                        if state.buffered_frames.is_empty() {
                            return None;
                        }
                        let buffered_frames = std::mem::take(&mut state.buffered_frames);
                        let result = rewrite_v3_direct_thinking_tag_sse_frames(&buffered_frames)
                            .map_err(|error| {
                                runtime_source("V3DirectResp14ProviderProjectionPrepared", error)
                            });
                        return Some((result, state));
                    }
                }
            }
        },
    ))
}

fn rewrite_v3_direct_thinking_tag_sse_bytes(input: &[u8]) -> Result<Vec<u8>, String> {
    let mut decoder = SseIncrementalDecoder::new(SseTransportLimits::default());
    let mut frames = decoder
        .push(build_v3_sse_transport_in_01_raw_chunk(input))
        .map_err(|error| error.to_string())?;
    decoder.finish().map_err(|error| error.to_string())?;
    rewrite_v3_direct_thinking_tag_sse_frames(&frames)
}

fn rewrite_v3_direct_thinking_tag_sse_frames(
    frames: &[SseTransportIn03ValidatedFrameStream],
) -> Result<Vec<u8>, String> {
    let terminal = frames
        .iter()
        .filter_map(v3_direct_sse_frame_semantic)
        .find(|semantic| {
            matches!(
                semantic.protocol.event_type.as_str(),
                "response.completed" | "response.incomplete" | "response.failed"
            )
        })
        .ok_or_else(|| "thinking-tag compat requires a terminal Responses event".to_string())?;
    let original_output = terminal
        .response
        .as_ref()
        .and_then(|response| response.output.clone())
        .unwrap_or_default();
    let (plans, transformed_output) = v3_direct_thinking_typed_output(&original_output)?;
    if plans.is_empty() {
        let mut passthrough = Vec::new();
        for frame in frames {
            passthrough.extend_from_slice(
                build_v3_sse_transport_out_04_from_v3_sse_transport_in_03(frame).as_bytes(),
            );
        }
        return Ok(passthrough);
    }

    let mut terminal_compat = terminal.clone();
    terminal_compat
        .replace_response_output(transformed_output.clone())
        .map_err(|error| error.to_string())?;
    let appended_reasoning = transformed_output
        .iter()
        .skip(original_output.len())
        .cloned()
        .collect::<Vec<_>>();

    let mut output = Vec::new();
    let mut sequence = 0_u64;
    let mut appended_emitted = false;
    for frame in frames {
        let Some(mut semantic) = v3_direct_sse_frame_semantic(frame) else {
            output.extend_from_slice(
                build_v3_sse_transport_out_04_from_v3_sse_transport_in_03(frame).as_bytes(),
            );
            continue;
        };
        let event_type = semantic.protocol.event_type.clone();
        let plan = v3_direct_thinking_plan_for_event(&plans, &semantic);
        match event_type.as_str() {
            "response.output_item.added" if plan.is_some_and(|plan| plan.pure_reasoning) => {
                let plan = plan.unwrap();
                let item = crate::hub_v1::V3ResponsesSseOutputItem::new_reasoning_compat_item(
                    Some(plan.item_id.clone()),
                    Some(plan.output_index),
                    Some("in_progress".to_owned()),
                    Vec::new(),
                );
                push_v3_direct_typed_compat_event(
                    &mut output,
                    &mut sequence,
                    crate::hub_v1::V3ResponsesSseSemanticObject::new_compat_output_item_event(
                        "response.output_item.added",
                        plan.output_index,
                        item,
                    ),
                )?;
            }
            "response.content_part.added" | "response.content_part.done"
                if plan.is_some_and(|plan| plan.pure_reasoning) => {}
            "response.output_text.delta" if plan.is_some() => {}
            "response.output_text.done" if plan.is_some() => {
                let plan = plan.unwrap();
                if plan.pure_reasoning {
                    push_v3_direct_reasoning_summary_events(
                        &mut output,
                        &mut sequence,
                        plan.output_index,
                        &plan.item_id,
                        &plan.reasoning,
                    )?;
                } else {
                    if !plan.visible.is_empty() {
                        semantic.set_event_type("response.output_text.delta");
                        semantic.set_content_value("delta", plan.visible.clone());
                        push_v3_direct_compat_event(&mut output, &mut sequence, semantic.clone())?;
                    }
                    semantic.set_event_type("response.output_text.done");
                    semantic.set_content_value("text", plan.visible.clone());
                    push_v3_direct_compat_event(&mut output, &mut sequence, semantic)?;
                }
            }
            "response.content_part.done" if plan.is_some() => {
                let plan = plan.unwrap();
                semantic
                    .set_extension_object_text("part", "text", plan.visible.clone())
                    .map_err(|error| error.to_string())?;
                push_v3_direct_compat_event(&mut output, &mut sequence, semantic)?;
            }
            "response.output_item.done" if plan.is_some() => {
                let plan = plan.unwrap();
                let item = transformed_output
                    .get(plan.output_index)
                    .cloned()
                    .ok_or_else(|| "thinking-tag output item projection missing".to_owned())?;
                push_v3_direct_typed_compat_event(
                    &mut output,
                    &mut sequence,
                    crate::hub_v1::V3ResponsesSseSemanticObject::new_compat_output_item_event(
                        "response.output_item.done",
                        plan.output_index,
                        item,
                    ),
                )?;
            }
            "response.completed" | "response.incomplete" | "response.failed" => {
                if !appended_emitted {
                    for (offset, item) in appended_reasoning.iter().enumerate() {
                        push_v3_direct_reasoning_item_events(
                            &mut output,
                            &mut sequence,
                            original_output.len() + offset,
                            item,
                        )?;
                    }
                    appended_emitted = true;
                }
                push_v3_direct_compat_event(&mut output, &mut sequence, terminal_compat.clone())?;
            }
            _ => push_v3_direct_compat_event(&mut output, &mut sequence, semantic)?,
        }
    }
    Ok(output)
}

fn v3_direct_thinking_typed_output(
    output: &[crate::hub_v1::V3ResponsesSseOutputItem],
) -> Result<(
    Vec<V3DirectThinkingItemPlan>,
    Vec<crate::hub_v1::V3ResponsesSseOutputItem>,
), String> {
    let mut plans = Vec::new();
    let mut transformed = Vec::new();
    let mut appended_reasoning = Vec::new();
    for (output_index, original_item) in output.iter().enumerate() {
        let mut typed = original_item.clone();
        let Some(texts) = typed.message_output_texts() else {
            transformed.push(typed);
            continue;
        };
        let mut visible_parts = Vec::new();
        let mut reasoning = Vec::new();
        let mut tag_observed = false;
        for text in texts {
            let projection = crate::shared::project_v3_thinking_tag_text(&text);
            visible_parts.push(projection.visible);
            reasoning.extend(projection.reasoning);
            tag_observed |= projection.tag_observed;
        }
        if !tag_observed {
            transformed.push(typed);
            continue;
        }
        let visible = visible_parts.concat();
        let item_id = typed
            .identity()
            .item_id
            .clone()
            .unwrap_or_else(|| "message".to_owned());
        let plan = V3DirectThinkingItemPlan {
            item_id: item_id.clone(),
            output_index,
            pure_reasoning: !reasoning.is_empty() && visible.is_empty(),
            visible,
            reasoning: reasoning.clone(),
        };
        if plan.pure_reasoning {
            typed = typed.into_reasoning_compat_item(reasoning.clone());
        } else {
            typed
                .replace_message_output_texts(&visible_parts)
                .map_err(|error| error.to_string())?;
        }
        transformed.push(typed);
        plans.push(plan);
        if !plans.last().is_some_and(|plan| plan.pure_reasoning) && !reasoning.is_empty() {
            appended_reasoning.push(
                crate::hub_v1::V3ResponsesSseOutputItem::new_reasoning_compat_item(
                    Some(format!("rs_compat_{item_id}")),
                    Some(output.len() + appended_reasoning.len()),
                    Some("completed".to_owned()),
                    reasoning,
                ),
            );
        }
    }
    transformed.extend(appended_reasoning);
    Ok((plans, transformed))
}

fn v3_direct_thinking_plan_for_event<'a>(
    plans: &'a [V3DirectThinkingItemPlan],
    event: &crate::hub_v1::V3ResponsesSseSemanticObject,
) -> Option<&'a V3DirectThinkingItemPlan> {
    let item_id = event.protocol.item_id.as_deref().or_else(|| {
        event
            .item()
            .and_then(|item| item.identity().item_id.as_deref())
    });
    let output_index = event.protocol.output_index;
    plans.iter().find(|plan| {
        item_id.is_some_and(|value| value == plan.item_id)
            || output_index.is_some_and(|value| value == plan.output_index)
    })
}

fn v3_direct_sse_frame_semantic(
    frame: &SseTransportIn03ValidatedFrameStream,
) -> Option<crate::hub_v1::V3ResponsesSseSemanticObject> {
    let data = frame.frame().fields().iter().find_map(|field| match field {
        SseField::Named { name, value } if name == "data" && value != "[DONE]" => Some(value),
        _ => None,
    })?;
    let mut value: Value = serde_json::from_str(data).ok()?;
    crate::hub_v1::normalize_v3_responses_function_call_arguments(&mut value).ok()?;
    crate::hub_v1::classify_v3_responses_sse_event(&value).ok()
}

fn push_v3_direct_compat_event(
    output: &mut Vec<u8>,
    sequence: &mut u64,
    mut semantic: crate::hub_v1::V3ResponsesSseSemanticObject,
) -> Result<(), String> {
    semantic.protocol.sequence_number = Some(*sequence);
    *sequence += 1;
    crate::hub_v1::project_v3_responses_sse_event_sse(
        Some(semantic.protocol.event_type.clone()),
        &semantic,
    )
    .map(|bytes| output.extend_from_slice(&bytes))
    .map_err(|error| error.to_string())
}

fn push_v3_direct_typed_compat_event(
    output: &mut Vec<u8>,
    sequence: &mut u64,
    semantic: crate::hub_v1::V3ResponsesSseSemanticObject,
) -> Result<(), String> {
    push_v3_direct_compat_event(output, sequence, semantic)
}

fn push_v3_direct_reasoning_summary_events(
    output: &mut Vec<u8>,
    sequence: &mut u64,
    output_index: usize,
    item_id: &str,
    summaries: &[String],
) -> Result<(), String> {
    for (summary_index, text) in summaries.iter().enumerate() {
        push_v3_direct_typed_compat_event(
            output,
            sequence,
            crate::hub_v1::V3ResponsesSseSemanticObject::new_compat_reasoning_summary_part_event(
                "response.reasoning_summary_part.added",
                output_index,
                item_id,
                summary_index,
                "",
            ),
        )?;
        push_v3_direct_typed_compat_event(
            output,
            sequence,
            crate::hub_v1::V3ResponsesSseSemanticObject::new_compat_reasoning_summary_text_event(
                "response.reasoning_summary_text.delta",
                output_index,
                item_id,
                summary_index,
                "delta",
                text,
            ),
        )?;
        push_v3_direct_typed_compat_event(
            output,
            sequence,
            crate::hub_v1::V3ResponsesSseSemanticObject::new_compat_reasoning_summary_text_event(
                "response.reasoning_summary_text.done",
                output_index,
                item_id,
                summary_index,
                "text",
                text,
            ),
        )?;
        push_v3_direct_typed_compat_event(
            output,
            sequence,
            crate::hub_v1::V3ResponsesSseSemanticObject::new_compat_reasoning_summary_part_event(
                "response.reasoning_summary_part.done",
                output_index,
                item_id,
                summary_index,
                text,
            ),
        )?;
    }
    Ok(())
}

fn push_v3_direct_reasoning_item_events(
    output: &mut Vec<u8>,
    sequence: &mut u64,
    output_index: usize,
    item: &crate::hub_v1::V3ResponsesSseOutputItem,
) -> Result<(), String> {
    let item_id = item.identity().item_id.as_deref().unwrap_or_default();
    let summaries = item.reasoning_summary_texts().unwrap_or_default();
    let added_item = crate::hub_v1::V3ResponsesSseOutputItem::new_reasoning_compat_item(
        Some(item_id.to_owned()),
        Some(output_index),
        Some("in_progress".to_owned()),
        Vec::new(),
    );
    push_v3_direct_typed_compat_event(
        output,
        sequence,
        crate::hub_v1::V3ResponsesSseSemanticObject::new_compat_output_item_event(
            "response.output_item.added",
            output_index,
            added_item,
        ),
    )?;
    push_v3_direct_reasoning_summary_events(output, sequence, output_index, item_id, &summaries)?;
    push_v3_direct_typed_compat_event(
        output,
        sequence,
        crate::hub_v1::V3ResponsesSseSemanticObject::new_compat_output_item_event(
            "response.output_item.done",
            output_index,
            item.clone(),
        ),
    )
}

#[cfg(test)]
mod thinking_compat_tests {
    include!("direct_response_thinking_compat_tests.rs");
}
