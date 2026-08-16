#[derive(Debug, Clone)]
struct V3DirectThinkingItemPlan {
    item_id: String,
    output_index: usize,
    visible: String,
    reasoning: Vec<String>,
    pure_reasoning: bool,
}

fn wrap_v3_direct_sse_thinking_tag_compat_stream(source: V3ClientSseStream) -> V3ClientSseStream {
    struct State {
        source: V3ClientSseStream,
        detector: SseIncrementalDecoder,
        buffered: Vec<u8>,
        emitted: bool,
        done: bool,
    }

    Box::pin(stream::unfold(
        State {
            source,
            detector: SseIncrementalDecoder::new(SseTransportLimits::default()),
            buffered: Vec::new(),
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
                        state.buffered.extend_from_slice(&chunk);
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
                        let terminal = frames.iter().any(|frame| {
                            v3_direct_sse_frame_json(frame.frame())
                                .and_then(|value| {
                                    value
                                        .get("type")
                                        .and_then(Value::as_str)
                                        .map(str::to_string)
                                })
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
                            let buffered = std::mem::take(&mut state.buffered);
                            let result = rewrite_v3_direct_thinking_tag_sse_bytes(&buffered)
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
                        if state.buffered.is_empty() {
                            return None;
                        }
                        let result = rewrite_v3_direct_thinking_tag_sse_bytes(&state.buffered)
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

    let terminal = frames
        .iter()
        .filter_map(|frame| v3_direct_sse_frame_json(frame.frame()))
        .find(|value| {
            value
                .get("type")
                .and_then(Value::as_str)
                .is_some_and(|kind| {
                    matches!(
                        kind,
                        "response.completed" | "response.incomplete" | "response.failed"
                    )
                })
        })
        .ok_or_else(|| "thinking-tag compat requires a terminal Responses event".to_string())?;
    let original_output = terminal
        .pointer("/response/output")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let plans = v3_direct_thinking_item_plans(&original_output);
    if plans.is_empty() {
        return Ok(input.to_vec());
    }

    let mut terminal_compat = terminal.clone();
    crate::shared::apply_v3_direct_thinking_tag_json_compat(&mut terminal_compat);
    let transformed_output = terminal_compat
        .pointer("/response/output")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let appended_reasoning = transformed_output
        .iter()
        .skip(original_output.len())
        .cloned()
        .collect::<Vec<_>>();

    let mut output = Vec::new();
    let mut sequence = 0_u64;
    let mut appended_emitted = false;
    for frame in frames.drain(..) {
        let Some(mut event) = v3_direct_sse_frame_json(frame.frame()) else {
            output.extend_from_slice(
                build_v3_sse_transport_out_04_from_v3_sse_transport_in_03(&frame).as_bytes(),
            );
            continue;
        };
        let event_type = event
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        let plan = v3_direct_thinking_plan_for_event(&plans, &event);
        match event_type.as_str() {
            "response.output_item.added" if plan.is_some_and(|plan| plan.pure_reasoning) => {
                let plan = plan.unwrap();
                event["item"] = json!({
                    "id": plan.item_id,
                    "type": "reasoning",
                    "status": "in_progress",
                    "summary": []
                });
                push_v3_direct_compat_event(&mut output, &mut sequence, event)?;
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
                        let mut delta = event.clone();
                        delta["type"] = Value::String("response.output_text.delta".to_string());
                        delta["delta"] = Value::String(plan.visible.clone());
                        delta.as_object_mut().map(|row| row.remove("text"));
                        push_v3_direct_compat_event(&mut output, &mut sequence, delta)?;
                    }
                    event["text"] = Value::String(plan.visible.clone());
                    push_v3_direct_compat_event(&mut output, &mut sequence, event)?;
                }
            }
            "response.content_part.done" if plan.is_some() => {
                let plan = plan.unwrap();
                if let Some(part) = event.get_mut("part") {
                    part["text"] = Value::String(plan.visible.clone());
                }
                push_v3_direct_compat_event(&mut output, &mut sequence, event)?;
            }
            "response.output_item.done" if plan.is_some() => {
                let plan = plan.unwrap();
                if let Some(item) = transformed_output.get(plan.output_index) {
                    event["item"] = item.clone();
                }
                push_v3_direct_compat_event(&mut output, &mut sequence, event)?;
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
                event = terminal_compat.clone();
                push_v3_direct_compat_event(&mut output, &mut sequence, event)?;
            }
            _ => push_v3_direct_compat_event(&mut output, &mut sequence, event)?,
        }
    }
    Ok(output)
}

fn v3_direct_thinking_item_plans(output: &[Value]) -> Vec<V3DirectThinkingItemPlan> {
    output
        .iter()
        .enumerate()
        .filter_map(|(output_index, item)| {
            if item.get("type").and_then(Value::as_str) != Some("message") {
                return None;
            }
            let mut visible = String::new();
            let mut reasoning = Vec::new();
            let mut tag_observed = false;
            for part in item.get("content").and_then(Value::as_array)? {
                if part.get("type").and_then(Value::as_str) != Some("output_text") {
                    continue;
                }
                let projection = crate::shared::project_v3_thinking_tag_text(
                    part.get("text").and_then(Value::as_str).unwrap_or_default(),
                );
                visible.push_str(&projection.visible);
                reasoning.extend(projection.reasoning);
                tag_observed |= projection.tag_observed;
            }
            tag_observed.then(|| V3DirectThinkingItemPlan {
                item_id: item
                    .get("id")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
                output_index,
                pure_reasoning: !reasoning.is_empty() && visible.is_empty(),
                visible,
                reasoning,
            })
        })
        .collect()
}

fn v3_direct_thinking_plan_for_event<'a>(
    plans: &'a [V3DirectThinkingItemPlan],
    event: &Value,
) -> Option<&'a V3DirectThinkingItemPlan> {
    let item_id = event
        .get("item_id")
        .and_then(Value::as_str)
        .or_else(|| event.pointer("/item/id").and_then(Value::as_str));
    let output_index = event.get("output_index").and_then(Value::as_u64);
    plans.iter().find(|plan| {
        item_id.is_some_and(|value| value == plan.item_id)
            || output_index.is_some_and(|value| value as usize == plan.output_index)
    })
}

fn v3_direct_sse_frame_json(frame: &SseTransportIn02DecodedFrame) -> Option<Value> {
    frame.fields().iter().find_map(|field| match field {
        SseField::Named { name, value } if name == "data" && value != "[DONE]" => {
            serde_json::from_str(value).ok()
        }
        _ => None,
    })
}

fn push_v3_direct_compat_event(
    output: &mut Vec<u8>,
    sequence: &mut u64,
    mut event: Value,
) -> Result<(), String> {
    let event_name = event
        .get("type")
        .and_then(Value::as_str)
        .ok_or_else(|| "Responses compat event missing type".to_string())?
        .to_string();
    if let Some(row) = event.as_object_mut() {
        row.insert("sequence_number".to_string(), json!(*sequence));
    }
    *sequence += 1;
    output.extend_from_slice(b"event: ");
    output.extend_from_slice(event_name.as_bytes());
    output.extend_from_slice(b"\ndata: ");
    output.extend_from_slice(
        serde_json::to_string(&event)
            .map_err(|error| error.to_string())?
            .as_bytes(),
    );
    output.extend_from_slice(b"\n\n");
    Ok(())
}

fn push_v3_direct_reasoning_summary_events(
    output: &mut Vec<u8>,
    sequence: &mut u64,
    output_index: usize,
    item_id: &str,
    summaries: &[String],
) -> Result<(), String> {
    for (summary_index, text) in summaries.iter().enumerate() {
        push_v3_direct_compat_event(
            output,
            sequence,
            json!({
                "type":"response.reasoning_summary_part.added",
                "output_index":output_index,
                "item_id":item_id,
                "summary_index":summary_index,
                "part":{"type":"summary_text","text":""}
            }),
        )?;
        push_v3_direct_compat_event(
            output,
            sequence,
            json!({
                "type":"response.reasoning_summary_text.delta",
                "output_index":output_index,
                "item_id":item_id,
                "summary_index":summary_index,
                "delta":text
            }),
        )?;
        push_v3_direct_compat_event(
            output,
            sequence,
            json!({
                "type":"response.reasoning_summary_text.done",
                "output_index":output_index,
                "item_id":item_id,
                "summary_index":summary_index,
                "text":text
            }),
        )?;
        push_v3_direct_compat_event(
            output,
            sequence,
            json!({
                "type":"response.reasoning_summary_part.done",
                "output_index":output_index,
                "item_id":item_id,
                "summary_index":summary_index,
                "part":{"type":"summary_text","text":text}
            }),
        )?;
    }
    Ok(())
}

fn push_v3_direct_reasoning_item_events(
    output: &mut Vec<u8>,
    sequence: &mut u64,
    output_index: usize,
    item: &Value,
) -> Result<(), String> {
    let item_id = item.get("id").and_then(Value::as_str).unwrap_or_default();
    let summaries = item
        .get("summary")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|entry| {
            entry
                .get("text")
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .collect::<Vec<_>>();
    let mut added_item = item.clone();
    added_item["status"] = Value::String("in_progress".to_string());
    added_item["summary"] = json!([]);
    push_v3_direct_compat_event(
        output,
        sequence,
        json!({
            "type":"response.output_item.added",
            "output_index":output_index,
            "item":added_item
        }),
    )?;
    push_v3_direct_reasoning_summary_events(output, sequence, output_index, item_id, &summaries)?;
    push_v3_direct_compat_event(
        output,
        sequence,
        json!({
            "type":"response.output_item.done",
            "output_index":output_index,
            "item":item
        }),
    )
}

#[cfg(test)]
mod thinking_compat_tests {
    include!("direct_response_thinking_compat_tests.rs");
}
