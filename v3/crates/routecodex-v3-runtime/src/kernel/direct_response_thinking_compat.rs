
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
    let frames = decoder
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
    let mut wire_items = BTreeMap::<usize, Option<String>>::new();
    for event in frames.iter().filter_map(|frame| direct_thinking_event_value(frame)) {
        let Some(index) = event.get("output_index").and_then(Value::as_u64)
            .and_then(|index| usize::try_from(index).ok()) else { continue };
        let Some(id) = direct_thinking_event_item_id(&event) else { continue };
        wire_items.entry(index).and_modify(|bound| {
            if bound.as_deref() != Some(id) { *bound = None; }
        }).or_insert_with(|| Some(id.to_owned()));
    }
    // Opaque carrier values have no defined association with synthesized
    // reasoning events. Preserve the complete attempt rather than lose them.
    if frames.iter().any(|frame| direct_thinking_event_value(frame).is_some_and(|event| {
        direct_thinking_plan_for_event(&plans, &event, &wire_items).is_some()
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
    let mut emitted_pure_reasoning = BTreeSet::new();
    let first_appended_wire_index = match wire_items.keys().next_back() {
        Some(index) => index.checked_add(1)?,
        None => original_output.len(),
    };
    for (frame_index, frame) in frames.iter().enumerate() {
        if frame_index == terminal_position {
            for (index, item) in transformed_output.iter().enumerate().skip(original_output.len()) {
                let wire_index = first_appended_wire_index.checked_add(index - original_output.len())?;
                let mut added = item.clone();
                added["summary"] = json!([]);
                rewritten.push(direct_thinking_event_frame("response.output_item.added", json!({
                    "type":"response.output_item.added", "output_index":wire_index, "item":added
                })));
                if let Some(original_plan) = plans.iter().find(|plan| !plan.pure_reasoning && !plan.reasoning.is_empty()
                    && item["id"].as_str() == Some(format!("rs_compat_{}", plan.item_id.clone().unwrap_or_else(|| plan.output_index.to_string())).as_str())) {
                    let mut reasoning_plan = original_plan.clone();
                    reasoning_plan.output_index = wire_index;
                    reasoning_plan.item_id = item["id"].as_str().map(str::to_owned);
                    rewritten.extend(direct_thinking_reasoning_summary_frames(&reasoning_plan, response_id.as_deref()));
                }
                rewritten.push(direct_thinking_event_frame("response.output_item.done", json!({
                    "type":"response.output_item.done", "output_index":wire_index, "item":item
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
        let Some(plan) = direct_thinking_plan_for_event(&plans, &value, &wire_items) else {
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
                        "output_index": value.get("output_index").cloned().unwrap_or_else(|| plan.output_index.into()),
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
                if emitted_pure_reasoning.insert(plan.output_index) {
                    let mut wire_plan = plan.clone();
                    wire_plan.output_index = value.get("output_index").and_then(Value::as_u64)
                        .and_then(|index| usize::try_from(index).ok()).unwrap_or(plan.output_index);
                    rewritten.extend(direct_thinking_reasoning_summary_frames(
                        &wire_plan,
                        response_id.as_deref(),
                    ));
                }
            }
            "response.output_text.done" => {
                let visible = direct_thinking_visible_part(plan, &value)?;
                if !visible.is_empty() {
                    rewritten.push(direct_thinking_output_text_delta_frame(
                        &value,
                        &plan,
                        visible,
                        response_id.as_deref(),
                    ));
                }
                let mut done = value;
                if let Some(object) = done.as_object_mut() {
                    object.insert("text".to_owned(), Value::String(visible.to_owned()));
                }
                rewritten.push(replace_v3_direct_thinking_event_data(frame, &done));
            }
            "response.content_part.done" => {
                let visible = direct_thinking_visible_part(plan, &value)?;
                let mut done = value;
                if let Some(part) = done.get_mut("part").and_then(Value::as_object_mut) {
                    part.insert("text".to_owned(), Value::String(visible.to_owned()));
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
    wire_items: &BTreeMap<usize, Option<String>>,
) -> Option<&'a crate::shared_direct_thinking_compat::V3DirectThinkingOutputItemPlan> {
    if let Some(item_id) = direct_thinking_event_item_id(event) {
        return plans.iter().find(|plan| plan.item_id.as_deref() == Some(item_id));
    }
    let output_index = event
        .get("output_index")
        .and_then(Value::as_u64)
        .and_then(|index| usize::try_from(index).ok());
    let item_id = wire_items.get(&output_index?)?.as_deref()?;
    plans.iter().find(|plan| plan.item_id.as_deref() == Some(item_id))
}

fn direct_thinking_event_item_id(event: &Value) -> Option<&str> {
    event.get("item_id").and_then(Value::as_str).or_else(|| {
        event.get("item").and_then(|item| item.get("id")).and_then(Value::as_str)
    })
}

fn direct_thinking_visible_part<'a>(
    plan: &'a crate::shared_direct_thinking_compat::V3DirectThinkingOutputItemPlan,
    event: &Value,
) -> Option<&'a str> {
    let content_index = event.get("content_index").and_then(Value::as_u64)
        .and_then(|index| usize::try_from(index).ok())
        .or_else(|| (plan.visible_parts.len() == 1).then_some(0))?;
    plan.visible_parts.get(content_index).map(String::as_str)
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
    visible: &str,
    response_id: Option<&str>,
) -> Vec<u8> {
    let mut value = json!({
        "type": "response.output_text.delta",
        "output_index": original.get("output_index").cloned().unwrap_or_else(|| plan.output_index.into()),
        "item_id": plan.item_id.clone().unwrap_or_else(|| format!("msg_{}", plan.output_index)),
        "content_index": original.get("content_index").cloned().unwrap_or_else(|| Value::from(0)),
        "delta": visible
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
    if !frames
        .iter()
        .filter_map(v3_direct_sse_frame_semantic)
        .any(|semantic| {
            matches!(
                semantic.protocol.event_type.as_str(),
                "response.completed" | "response.incomplete" | "response.failed"
            )
        }) {
        return Err("thinking-tag compat requires a terminal Responses event".to_string());
    }
    let wire = frames.iter().map(|frame| {
        build_v3_sse_transport_out_04_from_v3_sse_transport_in_03(frame).as_bytes().to_vec()
    }).collect::<Vec<_>>();
    Ok(rewrite_v3_direct_thinking_attempt(&wire)
        .map_or_else(|| wire.concat(), |(rewritten, _)| rewritten.concat()))
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

#[cfg(test)]
mod thinking_compat_tests {
    include!("direct_response_thinking_compat_tests.rs");
}
