#[derive(Debug, Clone)]
struct V3DirectThinkingItemPlan {
    item_id: String,
    output_index: usize,
    visible: String,
    reasoning: Vec<String>,
    pure_reasoning: bool,
}

pub(crate) use crate::shared_direct_thinking_compat::normalize_v3_direct_thinking_json;

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

    V3ProviderAttemptSseStream::new(Box::pin(stream::unfold(
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
    )))
}

fn rewrite_v3_direct_thinking_tag_sse_bytes(input: &[u8]) -> Result<Vec<u8>, String> {
    let mut decoder = SseIncrementalDecoder::new(SseTransportLimits::default());
    let mut frames = decoder
        .push(build_v3_sse_transport_in_01_raw_chunk(input))
        .map_err(|error| error.to_string())?;
    decoder.finish().map_err(|error| error.to_string())?;
    rewrite_v3_direct_thinking_tag_sse_frames(&frames)
}

pub(crate) fn rewrite_v3_direct_thinking_attempt(
    frames: &[Vec<u8>],
) -> Option<(Vec<Vec<u8>>, usize)> {
    let terminal_position = frames.iter().position(|frame| {
        direct_thinking_event_value(frame).is_some_and(|value| {
            matches!(
                value.get("type").and_then(Value::as_str),
                Some("response.completed" | "response.incomplete" | "response.failed")
            )
        })
    })?;
    let terminal = direct_thinking_event_value(&frames[terminal_position])?;
    let original_output = terminal
        .get("response")
        .and_then(|response| response.get("output"))
        .and_then(Value::as_array)?
        .clone();
    let plans = crate::shared_direct_thinking_compat::analyze_v3_direct_thinking_output(
        &original_output,
    );
    if plans.is_empty() {
        return None;
    }
    // Opaque carrier values have no defined association with synthesized
    // reasoning events. Preserve the complete attempt rather than lose them.
    if frames.iter().any(|frame| direct_thinking_event_value(frame).is_some_and(|event| {
        direct_thinking_plan_for_event(&plans, &event).is_some()
            && (!thinking_carrier_can_rewrite(&event)
                || std::str::from_utf8(frame).is_ok_and(|wire| wire.lines().any(|line| {
                    !line.is_empty() && !line.starts_with("data:") && !line.starts_with("event:")
                })))
    })) { return None; }
    let mut normalized_terminal = terminal.clone();
    if !crate::shared_direct_thinking_compat::normalize_v3_direct_thinking_json(
        &mut normalized_terminal,
    ) {
        return None;
    }
    let transformed_output = normalized_terminal
        .get("response")
        .and_then(|response| response.get("output"))
        .and_then(Value::as_array)?
        .clone();
    let response_id = terminal
        .get("response")
        .and_then(|response| response.get("id"))
        .and_then(Value::as_str)
        .map(ToOwned::to_owned);

    let mut rewritten = Vec::with_capacity(frames.len() + plans.len());
    let mut terminal_index = None;
    for (frame_index, frame) in frames.iter().enumerate() {
        if frame_index == terminal_position {
            for (index, item) in transformed_output.iter().enumerate().skip(original_output.len()) {
                let mut added = item.clone();
                added["summary"] = json!([]);
                rewritten.push(direct_thinking_event_frame("response.output_item.added", json!({
                    "type":"response.output_item.added", "output_index":index, "item":added
                })));
                if let Some(original_plan) = plans.iter().find(|plan| !plan.pure_reasoning && !plan.reasoning.is_empty()
                    && item["id"].as_str() == Some(format!("rs_compat_{}", plan.item_id.clone().unwrap_or_else(|| plan.output_index.to_string())).as_str())) {
                    let mut reasoning_plan = original_plan.clone();
                    reasoning_plan.output_index = index;
                    reasoning_plan.item_id = item["id"].as_str().map(str::to_owned);
                    rewritten.extend(direct_thinking_reasoning_summary_frames(&reasoning_plan, response_id.as_deref()));
                }
                rewritten.push(direct_thinking_event_frame("response.output_item.done", json!({
                    "type":"response.output_item.done", "output_index":index, "item":item
                })));
            }
            terminal_index = Some(rewritten.len());
            rewritten.push(replace_v3_direct_thinking_event_data(
                frame,
                &normalized_terminal,
            ));
            continue;
        }
        let Some(value) = direct_thinking_event_value(frame) else {
            rewritten.push(frame.clone());
            continue;
        };
        if matches!(value["type"].as_str(), Some("response.created" | "response.in_progress" | "response.queued"))
            && value["response"]["output"].is_array() {
            let mut snapshot = value.clone();
            let has_tools = original_output.iter().any(crate::shared_direct_thinking_compat::output_item_has_complete_tool);
            if crate::shared_direct_thinking_compat::normalize_thinking_json_with_tool_context(&mut snapshot, Some(has_tools)) {
                rewritten.push(replace_v3_direct_thinking_event_data(frame, &snapshot));
            } else { rewritten.push(frame.clone()); }
            continue;
        }
        let Some(plan) = direct_thinking_plan_for_event(&plans, &value) else {
            rewritten.push(frame.clone());
            continue;
        };
        let event_type = value.get("type").and_then(Value::as_str).unwrap_or_default();
        match event_type {
            "response.output_text.delta" => {}
            "response.content_part.added" if plan.pure_reasoning => {}
            "response.content_part.done" if plan.pure_reasoning => {}
            "response.output_item.added" if plan.pure_reasoning => {
                let item_id = plan
                    .item_id
                    .clone()
                    .unwrap_or_else(|| format!("msg_{}", plan.output_index));
                rewritten.push(direct_thinking_event_frame(
                    "response.output_item.added",
                    json!({
                        "type": "response.output_item.added",
                        "output_index": plan.output_index,
                        "item": {
                            "id": item_id,
                            "type": "reasoning",
                            "status": "in_progress",
                            "summary": []
                        }
                    }),
                ));
            }
            "response.output_text.done" if plan.pure_reasoning => {
                rewritten.extend(direct_thinking_reasoning_summary_frames(
                    &plan,
                    response_id.as_deref(),
                ));
            }
            "response.output_text.done" => {
                if !plan.visible.is_empty() {
                    rewritten.push(direct_thinking_output_text_delta_frame(
                        &value,
                        &plan,
                        response_id.as_deref(),
                    ));
                }
                let mut done = value;
                if let Some(object) = done.as_object_mut() {
                    object.insert("text".to_owned(), Value::String(plan.visible.clone()));
                }
                rewritten.push(replace_v3_direct_thinking_event_data(frame, &done));
            }
            "response.content_part.done" => {
                let mut done = value;
                if let Some(part) = done.get_mut("part").and_then(Value::as_object_mut) {
                    part.insert("text".to_owned(), Value::String(plan.visible.clone()));
                }
                rewritten.push(replace_v3_direct_thinking_event_data(frame, &done));
            }
            "response.output_item.done" => {
                let mut done = value;
                if let Some(item) = transformed_output.get(plan.output_index).cloned() {
                    if let Some(object) = done.as_object_mut() {
                        object.insert("item".to_owned(), item);
                    }
                }
                rewritten.push(replace_v3_direct_thinking_event_data(frame, &done));
            }
            _ => rewritten.push(frame.clone()),
        }
    }
    terminal_index.map(|terminal_index| (rewritten, terminal_index))
}

fn direct_thinking_event_value(frame: &[u8]) -> Option<Value> {
    let data = direct_thinking_event_data(frame)?;
    serde_json::from_str(&data).ok()
}

fn direct_thinking_event_data(frame: &[u8]) -> Option<String> {
    let text = std::str::from_utf8(frame).ok()?;
    Some(text.lines().filter_map(|line| line.strip_prefix("data:")
        .map(|data| data.strip_prefix(' ').unwrap_or(data))).collect::<Vec<_>>().join("\n"))
}

fn thinking_carrier_can_rewrite(event: &Value) -> bool {
    let plain_part = |part: &Value| part.as_object().is_some_and(|fields| fields.keys().all(|key| matches!(key.as_str(), "type" | "text" | "annotations" | "logprobs")))
        && ["annotations", "logprobs"].iter().all(|key| part.get(*key).is_none_or(|value| value.as_array().is_some_and(Vec::is_empty)));
    let known = matches!(event["type"].as_str(), Some("response.output_item.added" | "response.output_item.done"
        | "response.content_part.added" | "response.content_part.done" | "response.output_text.delta" | "response.output_text.done"));
    known && event.as_object().is_some_and(|fields| fields.keys().all(|key| matches!(key.as_str(),
        "type" | "sequence_number" | "response_id" | "output_index" | "item_id" | "content_index" | "item" | "part" | "delta" | "text" | "logprobs")))
        && event.get("logprobs").is_none_or(|value| value.as_array().is_some_and(Vec::is_empty))
        && event.get("item").is_none_or(|item| item.as_object().is_some_and(|fields| fields.keys().all(|key| matches!(key.as_str(), "id" | "type" | "role" | "status" | "content")))
            && item.get("content").is_none_or(|content| content.as_array().is_some_and(|parts| parts.iter().all(plain_part))))
        && event.get("part").is_none_or(plain_part)
}

fn replace_v3_direct_thinking_event_data(frame: &[u8], value: &Value) -> Vec<u8> {
    let Ok(text) = std::str::from_utf8(frame) else {
        return frame.to_vec();
    };
    let Some(encoded) = direct_thinking_preserved_event_json(frame, value) else {
        return frame.to_vec();
    };
    let mut output = String::with_capacity(text.len());
    let mut replaced = false;
    for line in text.split_inclusive('\n') {
        let line_without_ending = line.trim_end_matches(['\r', '\n']);
        let ending = &line[line_without_ending.len()..];
        if let Some(data) = line_without_ending.strip_prefix("data:") {
            if !replaced {
                let spacing = if data.starts_with(' ') { " " } else { "" };
                output.push_str("data:");
                output.push_str(spacing);
                output.push_str(&encoded);
                output.push_str(ending);
                replaced = true;
            }
            continue;
        }
        output.push_str(line);
    }
    output.into_bytes()
}

fn direct_thinking_preserved_event_json(frame: &[u8], value: &Value) -> Option<String> {
    use crate::direct_response_hooks::V3DirectRawObject;
    let data = direct_thinking_event_data(frame)?;
    let original: Value = serde_json::from_str(&data).ok()?;
    let mut raw: V3DirectRawObject = serde_json::from_str(&data).ok()?;
    for key in ["text", "item", "part"] {
        if value.get(key) != original.get(key) { raw.set(key, value.get(key)?.to_string())?; }
    }
    if value.get("response") != original.get("response") {
        let mut response: V3DirectRawObject = serde_json::from_str(raw.get("response")?.get()).ok()?;
        let old_items: Vec<Box<serde_json::value::RawValue>> = serde_json::from_str(response.get("output")?.get()).ok()?;
        let items = value["response"]["output"].as_array()?.iter().enumerate().map(|(index, item)| {
            old_items.get(index).filter(|_| original["response"]["output"].get(index) == Some(item))
                .map(|item| item.get().to_owned()).unwrap_or_else(|| item.to_string())
        }).collect::<Vec<_>>();
        response.set("output", format!("[{}]", items.join(",")))?;
        if value["response"].get("output_text") != original["response"].get("output_text") {
            response.set("output_text", value["response"].get("output_text")?.to_string())?;
        }
        raw.set("response", response.render())?;
    }
    Some(raw.render())
}

fn direct_thinking_plan_for_event<'a>(
    plans: &'a [crate::shared_direct_thinking_compat::V3DirectThinkingOutputItemPlan],
    event: &Value,
) -> Option<&'a crate::shared_direct_thinking_compat::V3DirectThinkingOutputItemPlan> {
    let item_id = event
        .get("item_id")
        .and_then(Value::as_str)
        .or_else(|| event.get("item").and_then(|item| item.get("id")).and_then(Value::as_str));
    let output_index = event
        .get("output_index")
        .and_then(Value::as_u64)
        .and_then(|index| usize::try_from(index).ok());
    plans.iter().find(|plan| {
        item_id.is_some_and(|value| plan.item_id.as_deref() == Some(value))
            || output_index.is_some_and(|value| value == plan.output_index)
    })
}

fn direct_thinking_event_frame(event_type: &str, value: Value) -> Vec<u8> {
    format!(
        "event: {event_type}\ndata: {}\n\n",
        serde_json::to_string(&value).unwrap_or_else(|_| "{}".to_owned())
    )
    .into_bytes()
}

fn direct_thinking_output_text_delta_frame(
    original: &Value,
    plan: &crate::shared_direct_thinking_compat::V3DirectThinkingOutputItemPlan,
    response_id: Option<&str>,
) -> Vec<u8> {
    let mut value = json!({
        "type": "response.output_text.delta",
        "output_index": plan.output_index,
        "item_id": plan.item_id.clone().unwrap_or_else(|| format!("msg_{}", plan.output_index)),
        "content_index": original.get("content_index").cloned().unwrap_or_else(|| Value::from(0)),
        "delta": plan.visible
    });
    if let (Some(response_id), Some(object)) = (response_id, value.as_object_mut()) {
        object.insert("response_id".to_owned(), Value::String(response_id.to_owned()));
    }
    direct_thinking_event_frame("response.output_text.delta", value)
}

fn direct_thinking_reasoning_summary_frames(
    plan: &crate::shared_direct_thinking_compat::V3DirectThinkingOutputItemPlan,
    response_id: Option<&str>,
) -> Vec<Vec<u8>> {
    let item_id = plan
        .item_id
        .clone()
        .unwrap_or_else(|| format!("msg_{}", plan.output_index));
    let mut frames = Vec::new();
    for (summary_index, text) in plan.reasoning.iter().enumerate() {
        for (event_type, value) in [
            (
                "response.reasoning_summary_part.added",
                json!({
                    "type": "response.reasoning_summary_part.added",
                    "output_index": plan.output_index,
                    "item_id": item_id,
                    "summary_index": summary_index,
                    "part": {"type":"summary_text","text":""}
                }),
            ),
            (
                "response.reasoning_summary_text.delta",
                json!({
                    "type": "response.reasoning_summary_text.delta",
                    "output_index": plan.output_index,
                    "item_id": item_id,
                    "summary_index": summary_index,
                    "delta": text
                }),
            ),
            (
                "response.reasoning_summary_text.done",
                json!({
                    "type": "response.reasoning_summary_text.done",
                    "output_index": plan.output_index,
                    "item_id": item_id,
                    "summary_index": summary_index,
                    "text": text
                }),
            ),
            (
                "response.reasoning_summary_part.done",
                json!({
                    "type": "response.reasoning_summary_part.done",
                    "output_index": plan.output_index,
                    "item_id": item_id,
                    "summary_index": summary_index,
                    "part": {"type":"summary_text","text":text}
                }),
            ),
        ] {
            let mut value = value;
            if let (Some(response_id), Some(object)) = (response_id, value.as_object_mut()) {
                object.insert("response_id".to_owned(), Value::String(response_id.to_owned()));
            }
            frames.push(direct_thinking_event_frame(event_type, value));
        }
    }
    frames
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
    let has_complete_tools = output.iter().any(|item| {
        !matches!(
            item.kind(),
            crate::hub_v1::V3ResponsesSseOutputItemKind::Message
                | crate::hub_v1::V3ResponsesSseOutputItemKind::OutputText
                | crate::hub_v1::V3ResponsesSseOutputItemKind::Reasoning
        )
    });
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
            let projection =
                crate::shared_direct_thinking_compat::project_v3_thinking_tag_text_with_tools(
                    &text,
                    has_complete_tools,
                );
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
