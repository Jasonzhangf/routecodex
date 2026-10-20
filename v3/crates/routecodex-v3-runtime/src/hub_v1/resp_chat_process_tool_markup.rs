//! Relay payload adapter. Grammar remains in the shared pure parser.
use super::*;
use std::sync::atomic::{AtomicU64, Ordering};

fn fresh_id(prefix: &str, used: &mut HashSet<String>) -> String {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    loop {
        let id = format!(
            "{prefix}_rcc_markup_{}_{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        );
        if used.insert(id.clone()) {
            return id;
        }
    }
}

fn native(
    call: ParsedToolCall<'_>,
    context: &V3HubRelaySerializedToolContext,
    used: &mut HashSet<String>,
) -> Value {
    let identity = context
        .identity(call.wire_name)
        .expect("parser and identity share the same declaration view");
    let call_id = call
        .call_id
        .map(str::to_owned)
        .unwrap_or_else(|| fresh_id("call", used));
    let mut item = json!({"type":"function_call", "id":fresh_id("fc", used), "name":identity.leaf,
        "call_id":call_id,"arguments":call.arguments,"status":"completed"});
    if let Some(namespace) = &identity.namespace {
        item["namespace"] = namespace.clone().into();
    }
    item
}

fn known_part(part: &Value) -> bool {
    part.as_object().is_some_and(|part| {
        matches!(
            part.get("type").and_then(Value::as_str),
            Some("text" | "output_text")
        ) && part.get("text").is_some_and(Value::is_string)
            && part.iter().all(|(key, value)| match key.as_str() {
                "type" | "text" => true,
                "annotations" | "logprobs" => {
                    value.is_null() || value.as_array().is_some_and(Vec::is_empty)
                }
                _ => false,
            })
    })
}

fn scan<'a>(
    text: &'a str,
    context: &V3HubRelaySerializedToolContext,
) -> Result<crate::tool_markup_parser::ToolMarkupScan<'a>, V3HubRelayResponseError> {
    let result = scan_tool_markup(text, &context.declarations);
    if result.incomplete_tool_invocation {
        return Err(V3HubRelayResponseError::UnharvestableToolMarkup);
    }
    Ok(result)
}

fn flush_message(
    template: &Value,
    parts: &mut Vec<Value>,
    output: &mut Vec<Value>,
    used: &mut HashSet<String>,
    emitted: &mut bool,
) {
    if parts.is_empty() {
        return;
    }
    let mut message = template.clone();
    message["content"] = std::mem::take(parts).into();
    if *emitted && message.get("id").is_some() {
        message["id"] = fresh_id("msg", used).into();
    }
    *emitted = true;
    output.push(message);
}

fn message(
    item: &Value,
    context: &V3HubRelaySerializedToolContext,
    used: &mut HashSet<String>,
) -> Result<Vec<Value>, V3HubRelayResponseError> {
    let Some(parts) = item.get("content").and_then(Value::as_array) else {
        return Ok(vec![item.clone()]);
    };
    let representable = item.as_object().is_some_and(|row| {
        row.keys()
            .all(|key| matches!(key.as_str(), "id" | "type" | "role" | "status" | "content"))
    });
    let mut output = Vec::new();
    let mut pending = Vec::new();
    let mut emitted = false;
    for part in parts {
        if !matches!(
            part.get("type").and_then(Value::as_str),
            Some("text" | "output_text")
        ) {
            pending.push(part.clone());
            continue;
        }
        let Some(text) = part.get("text").and_then(Value::as_str) else {
            pending.push(part.clone());
            continue;
        };
        let result = scan(text, context)?;
        if !representable || !known_part(part) {
            pending.push(part.clone());
            continue;
        }
        for segment in result.segments {
            match segment {
                ToolMarkupSegment::Text(text) => {
                    let mut part = part.clone();
                    part["text"] = text.into();
                    pending.push(part);
                }
                ToolMarkupSegment::Calls(calls) => {
                    flush_message(item, &mut pending, &mut output, used, &mut emitted);
                    output.extend(calls.into_iter().map(|call| native(call, context, used)));
                }
            }
        }
    }
    flush_message(item, &mut pending, &mut output, used, &mut emitted);
    Ok(output)
}

fn responses(
    payload: &mut Value,
    context: &V3HubRelaySerializedToolContext,
) -> Result<(), V3HubRelayResponseError> {
    let Some(previous) = payload.get("output").and_then(Value::as_array).cloned() else {
        return Ok(());
    };
    let mut old_text = String::new();
    for item in &previous {
        append_v3_resp03_output_text_segments(&mut old_text, item);
    }
    let aggregate = payload.get("output_text").and_then(Value::as_str) == Some(old_text.as_str());
    let mut used: HashSet<String> = previous
        .iter()
        .flat_map(|item| [item.get("id"), item.get("call_id")])
        .flatten()
        .filter_map(Value::as_str)
        .map(str::to_owned)
        .collect();
    let mut output = Vec::new();
    let mut sources = Vec::new();
    for (index, item) in previous.iter().enumerate() {
        let replacements = if item["type"] == "message"
            && item
                .get("role")
                .and_then(Value::as_str)
                .is_none_or(|role| role == "assistant")
        {
            message(item, context, &mut used)?
        } else if item["type"] == "output_text" {
            if let Some(text) = item.get("text").and_then(Value::as_str) {
                let result = scan(text, context)?;
                if item.as_object().is_some_and(|row| {
                    row.keys()
                        .all(|key| matches!(key.as_str(), "id" | "type" | "text"))
                }) {
                    let mut replacements = Vec::new();
                    let mut first = true;
                    for segment in result.segments {
                        match segment {
                            ToolMarkupSegment::Text(text) => {
                                let mut next = item.clone();
                                next["text"] = text.into();
                                if !first && next.get("id").is_some() {
                                    next["id"] = fresh_id("msg", &mut used).into();
                                }
                                first = false;
                                replacements.push(next);
                            }
                            ToolMarkupSegment::Calls(calls) => replacements.extend(
                                calls
                                    .into_iter()
                                    .map(|call| native(call, context, &mut used)),
                            ),
                        }
                    }
                    replacements
                } else {
                    vec![item.clone()]
                }
            } else {
                vec![item.clone()]
            }
        } else {
            vec![item.clone()]
        };
        sources.extend(std::iter::repeat_n(vec![index], replacements.len()));
        output.extend(replacements);
    }
    if aggregate {
        let mut text = String::new();
        for item in &output {
            append_v3_resp03_output_text_segments(&mut text, item);
        }
        payload["output_text"] = text.into();
    }
    payload["output"] = output.into();
    remap_v3_response_candidate_output_indices(payload, &sources);
    Ok(())
}

fn chat(
    payload: &mut Value,
    context: &V3HubRelaySerializedToolContext,
) -> Result<(), V3HubRelayResponseError> {
    let Some(choices) = payload.get_mut("choices").and_then(Value::as_array_mut) else {
        return Ok(());
    };
    for choice in choices {
        let Some(message) = choice.get_mut("message") else {
            continue;
        };
        if message
            .get("role")
            .and_then(Value::as_str)
            .is_some_and(|role| role != "assistant")
        {
            continue;
        }
        let Some(text) = message.get("content").and_then(Value::as_str) else {
            continue;
        };
        let result = scan(text, context)?;
        let mut visible = String::new();
        let mut calls = Vec::new();
        let mut used: HashSet<String> = message
            .get("tool_calls")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|call| call.get("id").and_then(Value::as_str))
            .map(str::to_owned)
            .collect();
        for segment in result.segments {
            match segment {
                ToolMarkupSegment::Text(text) => visible.push_str(text),
                ToolMarkupSegment::Calls(parsed) => {
                    for call in parsed {
                        let native = native(call, context, &mut used);
                        let mut function =
                            json!({"name":native["name"],"arguments":native["arguments"]});
                        if let Some(namespace) = native.get("namespace") {
                            function["namespace"] = namespace.clone();
                        }
                        calls.push(
                            json!({"id":native["call_id"],"type":"function","function":function}),
                        );
                    }
                }
            }
        }
        message["content"] = visible.into();
        if !calls.is_empty() {
            if let Some(existing) = message.get_mut("tool_calls").and_then(Value::as_array_mut) {
                existing.extend(calls);
            } else {
                message["tool_calls"] = calls.into();
            }
            if choice["finish_reason"] != "content_filter" {
                choice["finish_reason"] = "tool_calls".into();
            }
        }
    }
    Ok(())
}

pub(super) fn govern(
    input: &mut V3HubRespInbound02Normalized,
    context: &V3HubRelaySerializedToolContext,
) -> Result<(), V3HubRelayResponseError> {
    let mut next = input.provider_payload().as_ref().clone();
    match input.semantic_protocol() {
        V3HubProviderWireProtocol::Responses => responses(&mut next, context)?,
        V3HubProviderWireProtocol::OpenAiChat => chat(&mut next, context)?,
        V3HubProviderWireProtocol::Gemini | V3HubProviderWireProtocol::Anthropic => return Ok(()),
    }
    *input.provider_payload_mut() = Arc::new(next);
    Ok(())
}

/// Reuse the existing pure, literal-aware thinking grammar. Only this Relay
/// adapter writes the semantic payload; no Direct payload hook is invoked.
pub(super) fn govern_thinking(input: &mut V3HubRespInbound02Normalized) {
    use crate::shared_direct_thinking_compat::project_v3_thinking_tag_text_with_tools;
    let mut next = input.provider_payload().as_ref().clone();
    match input.semantic_protocol() {
        V3HubProviderWireProtocol::Responses => {
            let Some(previous) = next.get("output").and_then(Value::as_array).cloned() else {
                return;
            };
            let tools = previous.iter().any(|item| {
                matches!(
                    item["type"].as_str(),
                    Some("function_call" | "custom_tool_call")
                )
            });
            let mut original_text = String::new();
            for item in &previous {
                append_v3_resp03_output_text_segments(&mut original_text, item);
            }
            let aggregate =
                next.get("output_text").and_then(Value::as_str) == Some(original_text.as_str());
            let mut output = Vec::new();
            let mut sources = Vec::new();
            for (index, mut item) in previous.into_iter().enumerate() {
                let mut reasoning = Vec::new();
                if item["type"] == "output_text"
                    && item.as_object().is_some_and(|row| {
                        row.keys()
                            .all(|key| matches!(key.as_str(), "id" | "type" | "text"))
                    })
                {
                    if let Some(text) = item.get("text").and_then(Value::as_str) {
                        if !scan_tool_markup(text, &ToolMarkupDeclarations::default())
                            .opaque_invocation
                        {
                            let projection = project_v3_thinking_tag_text_with_tools(text, tools);
                            if projection.tag_observed {
                                item["text"] = projection.visible.into();
                                reasoning.extend(projection.reasoning);
                            }
                        }
                    }
                }
                if item["type"] == "message"
                    && item
                        .get("role")
                        .and_then(Value::as_str)
                        .is_none_or(|role| role == "assistant")
                    && item.as_object().is_some_and(|row| {
                        row.keys().all(|key| {
                            matches!(key.as_str(), "id" | "type" | "role" | "status" | "content")
                        })
                    })
                {
                    if let Some(parts) = item.get_mut("content").and_then(Value::as_array_mut) {
                        for part in parts {
                            if !known_part(part) {
                                continue;
                            }
                            if scan_tool_markup(
                                part["text"].as_str().unwrap(),
                                &ToolMarkupDeclarations::default(),
                            )
                            .opaque_invocation
                            {
                                continue;
                            }
                            let projection = project_v3_thinking_tag_text_with_tools(
                                part["text"].as_str().unwrap(),
                                tools,
                            );
                            if projection.tag_observed {
                                part["text"] = projection.visible.into();
                                reasoning.extend(projection.reasoning);
                            }
                        }
                    }
                }
                if !reasoning.is_empty() {
                    output.push(v3_resp03_reasoning_item(reasoning));
                    sources.push(vec![index]);
                    if is_v3_resp03_empty_visible_text_item(&item) {
                        continue;
                    }
                }
                output.push(item);
                sources.push(vec![index]);
            }
            if aggregate {
                let mut text = String::new();
                for item in &output {
                    append_v3_resp03_output_text_segments(&mut text, item);
                }
                next["output_text"] = text.into();
            }
            next["output"] = output.into();
            remap_v3_response_candidate_output_indices(&mut next, &sources);
        }
        V3HubProviderWireProtocol::OpenAiChat => {
            if let Some(choices) = next.get_mut("choices").and_then(Value::as_array_mut) {
                for choice in choices {
                    let Some(message) = choice.get_mut("message") else {
                        continue;
                    };
                    if message
                        .get("role")
                        .and_then(Value::as_str)
                        .is_some_and(|role| role != "assistant")
                    {
                        continue;
                    }
                    let tools = message
                        .get("tool_calls")
                        .and_then(Value::as_array)
                        .is_some_and(|calls| !calls.is_empty());
                    let Some(text) = message.get("content").and_then(Value::as_str) else {
                        continue;
                    };
                    if scan_tool_markup(text, &ToolMarkupDeclarations::default()).opaque_invocation
                    {
                        continue;
                    }
                    let projection = project_v3_thinking_tag_text_with_tools(text, tools);
                    if !projection.tag_observed {
                        continue;
                    }
                    if !projection.reasoning.is_empty()
                        && message
                            .get("reasoning_content")
                            .is_some_and(|value| !value.is_string() && !value.is_null())
                    {
                        continue;
                    }
                    message["content"] = projection.visible.into();
                    if !projection.reasoning.is_empty() {
                        let mut reasoning = message
                            .get("reasoning_content")
                            .and_then(Value::as_str)
                            .unwrap_or("")
                            .to_owned();
                        reasoning.extend(projection.reasoning);
                        message["reasoning_content"] = reasoning.into();
                    }
                }
            }
        }
        V3HubProviderWireProtocol::Gemini | V3HubProviderWireProtocol::Anthropic => return,
    }
    *input.provider_payload_mut() = Arc::new(next);
}
