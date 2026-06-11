// feature_id: hub.response_anthropic_client_projection

use serde_json::{Map, Value};

use crate::hub_reasoning_tool_normalizer::{
    build_message_reasoning_value, normalize_message_reasoning_ssot, project_message_reasoning_text,
};
use crate::hub_resp_outbound_client_semantics_blocks::provider_outcome::resolve_anthropic_chat_completion_outcome;
use crate::responses_reasoning_registry::{
    consume_responses_output_text_meta_json, consume_responses_passthrough_by_aliases_json,
    consume_responses_payload_snapshot_by_aliases_json, consume_responses_reasoning_json,
    register_responses_passthrough_json, register_responses_payload_snapshot_json,
};
use crate::shared_json_utils::read_trimmed_string;
use crate::shared_responses_response_utils::build_chat_response_from_responses_impl;

#[derive(serde::Deserialize)]
pub(crate) struct BuildOpenAiChatFromAnthropicMessageFullInput {
    pub(crate) payload: String,
}

#[derive(serde::Serialize)]
pub(crate) struct BuildOpenAiChatFromAnthropicMessageFullOutput {
    pub(crate) result: String,
    pub(crate) id: Option<String>,
}

fn read_nonempty_string(value: Option<&Value>) -> Option<String> {
    let raw = value.and_then(Value::as_str)?;
    if raw.is_empty() {
        None
    } else {
        Some(raw.to_string())
    }
}

fn flatten_text(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Array(items) => items
            .iter()
            .map(flatten_text)
            .filter(|entry| !entry.is_empty())
            .collect::<Vec<String>>()
            .join(""),
        Value::Object(row) => read_trimmed_string(row.get("text"))
            .or_else(|| read_trimmed_string(row.get("content")))
            .or_else(|| read_trimmed_string(row.get("thinking")))
            .or_else(|| read_trimmed_string(row.get("reasoning")))
            .unwrap_or_default(),
        _ => String::new(),
    }
}

fn text_needs_separator(left: &str, right: &str) -> bool {
    let Some(left_char) = left.chars().next_back() else {
        return false;
    };
    let Some(right_char) = right.chars().next() else {
        return false;
    };
    !left_char.is_whitespace()
        && !right_char.is_whitespace()
        && (left_char.is_alphanumeric() || left_char == '.')
        && (right_char.is_alphanumeric() || right_char == '`')
}

fn join_text_segments(parts: &[String]) -> String {
    let mut out = String::new();
    for part in parts {
        if part.is_empty() {
            continue;
        }
        if !out.is_empty() && text_needs_separator(&out, part) {
            out.push(' ');
        }
        out.push_str(part);
    }
    out
}

fn is_meaningful_reasoning_text(text: &str) -> bool {
    text.trim().chars().any(|ch| ch.is_alphanumeric())
}

fn read_reasoning_signature(block_row: &Map<String, Value>) -> Option<String> {
    read_trimmed_string(block_row.get("signature"))
        .or_else(|| read_trimmed_string(block_row.get("data")))
        .or_else(|| read_trimmed_string(block_row.get("encrypted_content")))
}

fn normalize_usage(raw: Option<&Value>) -> Option<Value> {
    let row = raw.and_then(Value::as_object)?;
    let prompt_tokens = row
        .get("prompt_tokens")
        .or_else(|| row.get("input_tokens"))
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let completion_tokens = row
        .get("completion_tokens")
        .or_else(|| row.get("output_tokens"))
        .and_then(Value::as_u64)
        .unwrap_or(0);
    Some(Value::Object(Map::from_iter([
        ("prompt_tokens".to_string(), Value::from(prompt_tokens)),
        (
            "completion_tokens".to_string(),
            Value::from(completion_tokens),
        ),
        (
            "total_tokens".to_string(),
            Value::from(prompt_tokens + completion_tokens),
        ),
    ])))
}

fn serialize_tool_input_arguments(input: &Value) -> String {
    if let Some(raw_arguments) = input.as_str() {
        return raw_arguments.to_string();
    }
    serde_json::to_string(input).unwrap_or_else(|_| "{}".to_string())
}

pub(crate) fn build_openai_chat_response_from_anthropic_message(
    payload: &Value,
    request_id: &str,
) -> Result<Value, String> {
    let materialized = materialize_anthropic_message_payload(payload)?;
    let row = materialized
        .as_object()
        .ok_or_else(|| "Anthropic response must be a JSON object".to_string())?;
    let content = row
        .get("content")
        .and_then(Value::as_array)
        .ok_or_else(|| "Anthropic response must contain content array".to_string())?;

    let mut text_parts: Vec<String> = Vec::new();
    let mut reasoning_parts: Vec<String> = Vec::new();
    let mut reasoning_signature: Option<String> = None;
    let mut redacted_reasoning: Option<String> = None;
    let mut tool_calls: Vec<Value> = Vec::new();

    for (index, block) in content.iter().enumerate() {
        let Some(block_row) = block.as_object() else {
            continue;
        };
        let kind = read_trimmed_string(block_row.get("type"))
            .unwrap_or_default()
            .to_ascii_lowercase();
        match kind.as_str() {
            "text" => {
                let text = flatten_text(block);
                if !text.trim().is_empty() {
                    text_parts.push(text);
                }
            }
            "thinking" | "reasoning" | "redacted_thinking" => {
                let text = flatten_text(block);
                if is_meaningful_reasoning_text(text.as_str()) {
                    reasoning_parts.push(text);
                }
                if kind == "redacted_thinking" {
                    redacted_reasoning = read_reasoning_signature(block_row).or(redacted_reasoning);
                } else {
                    reasoning_signature =
                        read_reasoning_signature(block_row).or(reasoning_signature);
                }
            }
            "tool_use" => {
                let Some(name) = read_trimmed_string(block_row.get("name")) else {
                    continue;
                };
                let id = read_trimmed_string(block_row.get("id"))
                    .unwrap_or_else(|| format!("call_{index}"));
                let input = block_row
                    .get("input")
                    .cloned()
                    .unwrap_or_else(|| Value::Object(Map::new()));
                tool_calls.push(Value::Object(Map::from_iter([
                    ("id".to_string(), Value::String(id)),
                    ("type".to_string(), Value::String("function".to_string())),
                    (
                        "function".to_string(),
                        Value::Object(Map::from_iter([
                            ("name".to_string(), Value::String(name)),
                            (
                                "arguments".to_string(),
                                Value::String(serialize_tool_input_arguments(&input)),
                            ),
                        ])),
                    ),
                ])));
            }
            _ => {}
        }
    }

    let visible_text = join_text_segments(&text_parts);
    let mut message = Map::new();
    message.insert("role".to_string(), Value::String("assistant".to_string()));
    message.insert("content".to_string(), Value::String(visible_text.clone()));
    if !tool_calls.is_empty() {
        message.insert("tool_calls".to_string(), Value::Array(tool_calls.clone()));
    }
    let encrypted_reasoning = redacted_reasoning.or(reasoning_signature);
    if let Some(reasoning) =
        build_message_reasoning_value(&[], &reasoning_parts, encrypted_reasoning.as_deref())
    {
        if let Some(reasoning_text) = project_message_reasoning_text(&reasoning) {
            message.insert(
                "reasoning_content".to_string(),
                Value::String(reasoning_text),
            );
        }
        message.insert("reasoning".to_string(), reasoning);
    }
    normalize_message_reasoning_ssot(&mut message);

    let outcome = resolve_anthropic_chat_completion_outcome(
        row.get("stop_reason").and_then(Value::as_str),
        tool_calls.len(),
        !visible_text.trim().is_empty() || !reasoning_parts.is_empty(),
    );
    if outcome
        .get("shouldFailEmptyOutput")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        let normalized = outcome
            .get("normalized")
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .unwrap_or("empty_output");
        return Err(format!(
            "Anthropic response ended with {normalized} and no assistant output"
        ));
    }
    let finish_reason = outcome
        .get("finishReason")
        .and_then(Value::as_str)
        .unwrap_or("stop")
        .to_string();

    let mut chat = Map::new();
    chat.insert(
        "id".to_string(),
        Value::String(read_trimmed_string(row.get("id")).unwrap_or_else(|| request_id.to_string())),
    );
    chat.insert(
        "object".to_string(),
        Value::String("chat.completion".to_string()),
    );
    chat.insert(
        "model".to_string(),
        Value::String(read_trimmed_string(row.get("model")).unwrap_or_default()),
    );
    chat.insert(
        "choices".to_string(),
        Value::Array(vec![Value::Object(Map::from_iter([
            ("index".to_string(), Value::from(0)),
            ("message".to_string(), Value::Object(message)),
            ("finish_reason".to_string(), Value::String(finish_reason)),
        ]))]),
    );
    if let Some(usage) = normalize_usage(row.get("usage")) {
        chat.insert("usage".to_string(), usage);
    }
    Ok(Value::Object(chat))
}

pub(crate) fn build_openai_chat_from_anthropic_message_full(
    input: BuildOpenAiChatFromAnthropicMessageFullInput,
) -> Result<BuildOpenAiChatFromAnthropicMessageFullOutput, String> {
    let payload: Value = serde_json::from_str(&input.payload).map_err(|e| e.to_string())?;
    let message_payload = unwrap_anthropic_message_payload(&payload);
    let request_id =
        read_trimmed_string(message_payload.get("id")).unwrap_or_else(|| "unknown".to_string());
    let mut chat_response =
        build_openai_chat_response_from_anthropic_message(message_payload, request_id.as_str())?;

    let response_id = read_trimmed_string(chat_response.get("id"))
        .or_else(|| read_trimmed_string(message_payload.get("id")));

    if let Some(id) = response_id.as_deref() {
        if let Some(reasoning_json) =
            consume_responses_reasoning_json(id.to_string()).map_err(|e| e.to_string())?
        {
            let reasoning: Value =
                serde_json::from_str(&reasoning_json).map_err(|e| e.to_string())?;
            attach_reasoning_payload(&mut chat_response, reasoning);
        } else {
            attach_message_reasoning_as_responses_payload(&mut chat_response);
        }

        if let Some(meta_json) =
            consume_responses_output_text_meta_json(id.to_string()).map_err(|e| e.to_string())?
        {
            let output_meta: Value = serde_json::from_str(&meta_json).map_err(|e| e.to_string())?;
            if let Some(chat_obj) = chat_response.as_object_mut() {
                chat_obj.insert("__responses_output_text_meta".to_string(), output_meta);
            }
        }
    } else {
        attach_message_reasoning_as_responses_payload(&mut chat_response);
    }

    let retention_aliases =
        build_retention_aliases(response_id.as_deref(), message_payload, &payload);
    let aliases_json = serde_json::to_string(&retention_aliases).map_err(|e| e.to_string())?;
    if let Some(payload_snapshot_json) =
        consume_responses_payload_snapshot_by_aliases_json(aliases_json.clone())
            .map_err(|e| e.to_string())?
    {
        if let Some(id) = response_id.as_deref() {
            register_responses_payload_snapshot_json(
                id.to_string(),
                payload_snapshot_json.clone(),
                Some(false),
            )
            .map_err(|e| e.to_string())?;
            let payload_snapshot: Value =
                serde_json::from_str(&payload_snapshot_json).map_err(|e| e.to_string())?;
            if let Some(chat_obj) = chat_response.as_object_mut() {
                chat_obj.insert(
                    "__responses_payload_snapshot".to_string(),
                    payload_snapshot.clone(),
                );
                if chat_obj
                    .get("request_id")
                    .and_then(Value::as_str)
                    .filter(|value| !value.trim().is_empty())
                    .is_none()
                {
                    chat_obj.insert("request_id".to_string(), Value::String(id.to_string()));
                }
            }
            restore_responses_semantics_from_snapshot(&mut chat_response, &payload_snapshot);
        }
    }

    if let Some(passthrough_json) =
        consume_responses_passthrough_by_aliases_json(aliases_json).map_err(|e| e.to_string())?
    {
        if let Some(id) = response_id.as_deref() {
            register_responses_passthrough_json(
                id.to_string(),
                passthrough_json.clone(),
                Some(false),
            )
            .map_err(|e| e.to_string())?;
            let passthrough: Value =
                serde_json::from_str(&passthrough_json).map_err(|e| e.to_string())?;
            if let Some(chat_obj) = chat_response.as_object_mut() {
                chat_obj.insert("__responses_passthrough".to_string(), passthrough);
                if chat_obj
                    .get("request_id")
                    .and_then(Value::as_str)
                    .filter(|value| !value.trim().is_empty())
                    .is_none()
                {
                    chat_obj.insert("request_id".to_string(), Value::String(id.to_string()));
                }
            }
        }
    }

    let result = serde_json::to_string(&chat_response).map_err(|e| e.to_string())?;
    Ok(BuildOpenAiChatFromAnthropicMessageFullOutput {
        result,
        id: response_id,
    })
}

fn unwrap_anthropic_message_payload(payload: &Value) -> &Value {
    if let Some(record) = payload.get("data").and_then(Value::as_object) {
        if record.get("content").and_then(Value::as_array).is_some()
            || record.get("stop_reason").and_then(Value::as_str).is_some()
            || record.get("role").and_then(Value::as_str).is_some()
            || record.get("model").and_then(Value::as_str).is_some()
            || record.get("id").and_then(Value::as_str).is_some()
        {
            return payload.get("data").unwrap_or(payload);
        }
    }
    payload
}

fn build_retention_aliases(
    response_id: Option<&str>,
    message_payload: &Value,
    original_payload: &Value,
) -> Vec<Value> {
    [
        response_id.map(|value| Value::String(value.to_string())),
        read_trimmed_string(message_payload.get("request_id")).map(Value::String),
        read_trimmed_string(message_payload.get("id")).map(Value::String),
        read_trimmed_string(original_payload.get("request_id")).map(Value::String),
        read_trimmed_string(original_payload.get("id")).map(Value::String),
    ]
    .into_iter()
    .flatten()
    .collect()
}

fn attach_message_reasoning_as_responses_payload(chat_response: &mut Value) {
    let Some(reasoning) = chat_response
        .pointer("/choices/0/message/reasoning")
        .filter(|value| value.is_object())
        .cloned()
    else {
        return;
    };
    attach_reasoning_payload(chat_response, reasoning);
}

fn attach_reasoning_payload(chat_response: &mut Value, reasoning: Value) {
    if let Some(chat_obj) = chat_response.as_object_mut() {
        chat_obj.insert("__responses_reasoning".to_string(), reasoning.clone());
    }
    let Some(message_obj) = chat_response
        .pointer_mut("/choices/0/message")
        .and_then(Value::as_object_mut)
    else {
        return;
    };
    message_obj.insert("reasoning".to_string(), reasoning);
    normalize_message_reasoning_ssot(message_obj);
}

fn restore_responses_semantics_from_snapshot(chat_response: &mut Value, payload_snapshot: &Value) {
    if !payload_snapshot.is_object() {
        return;
    }
    let mut restored = build_chat_response_from_responses_impl(payload_snapshot);
    strip_internal_continuation_request_id(&mut restored);
    let Some(semantics) = restored
        .get("semantics")
        .filter(|value| value.is_object())
        .cloned()
    else {
        return;
    };
    if let Some(chat_obj) = chat_response.as_object_mut() {
        chat_obj.insert("semantics".to_string(), semantics);
    }
}

fn strip_internal_continuation_request_id(chat: &mut Value) {
    let Some(resume_from) = chat
        .pointer_mut("/semantics/continuation/resumeFrom")
        .and_then(Value::as_object_mut)
    else {
        return;
    };
    if resume_from
        .get("requestId")
        .and_then(Value::as_str)
        .is_some()
    {
        resume_from.remove("requestId");
    }
}

fn materialize_anthropic_message_payload(payload: &Value) -> Result<Value, String> {
    if payload.get("content").and_then(Value::as_array).is_some() {
        return Ok(payload.clone());
    }
    if let Some(body_text) = payload
        .get("bodyText")
        .and_then(Value::as_str)
        .filter(|text| !text.trim().is_empty())
    {
        return materialize_anthropic_sse_body_text(body_text);
    }
    if let Some(body) = payload.get("body") {
        if body.get("content").and_then(Value::as_array).is_some() {
            return Ok(body.clone());
        }
        if let Some(data) = body.get("data") {
            if data.get("content").and_then(Value::as_array).is_some() {
                return Ok(data.clone());
            }
        }
        if let Some(body_text) = body
            .get("bodyText")
            .and_then(Value::as_str)
            .filter(|text| !text.trim().is_empty())
        {
            return materialize_anthropic_sse_body_text(body_text);
        }
    }
    Ok(payload.clone())
}

#[derive(Default)]
struct AnthropicSseBlock {
    kind: String,
    id: Option<String>,
    name: Option<String>,
    input: Option<Value>,
    text: String,
    json_delta: String,
}

fn parse_sse_events(body_text: &str) -> Vec<(String, Value)> {
    let mut events: Vec<(String, Value)> = Vec::new();
    let mut event_name = "message".to_string();
    let mut data_lines: Vec<String> = Vec::new();
    let flush = |events: &mut Vec<(String, Value)>,
                 event_name: &mut String,
                 data_lines: &mut Vec<String>| {
        if data_lines.is_empty() {
            *event_name = "message".to_string();
            return;
        }
        let data = data_lines.join("\n");
        if let Ok(value) = serde_json::from_str::<Value>(&data) {
            events.push((event_name.clone(), value));
        }
        data_lines.clear();
        *event_name = "message".to_string();
    };

    for line in body_text.lines() {
        let trimmed_end = line.trim_end_matches('\r');
        if trimmed_end.is_empty() {
            flush(&mut events, &mut event_name, &mut data_lines);
            continue;
        }
        if let Some(raw) = trimmed_end.strip_prefix("event:") {
            event_name = raw.trim().to_string();
            continue;
        }
        if let Some(raw) = trimmed_end.strip_prefix("data:") {
            data_lines.push(raw.trim_start().to_string());
        }
    }
    flush(&mut events, &mut event_name, &mut data_lines);
    events
}

fn materialize_anthropic_sse_body_text(body_text: &str) -> Result<Value, String> {
    let events = parse_sse_events(body_text);
    let mut message = Map::new();
    let mut blocks = std::collections::BTreeMap::<usize, AnthropicSseBlock>::new();
    let mut stop_reason: Option<String> = None;
    let mut usage: Option<Value> = None;

    for (_event_name, event_payload) in events {
        let Some(event_row) = event_payload.as_object() else {
            continue;
        };
        let kind = read_trimmed_string(event_row.get("type")).unwrap_or_default();
        match kind.as_str() {
            "message_start" => {
                if let Some(start_message) = event_row.get("message").and_then(Value::as_object) {
                    for key in ["id", "type", "role", "model", "usage"] {
                        if let Some(value) = start_message.get(key) {
                            message.insert(key.to_string(), value.clone());
                        }
                    }
                }
            }
            "content_block_start" => {
                let index = event_row.get("index").and_then(Value::as_u64).unwrap_or(0) as usize;
                let mut block = AnthropicSseBlock::default();
                if let Some(content_block) =
                    event_row.get("content_block").and_then(Value::as_object)
                {
                    block.kind = read_trimmed_string(content_block.get("type")).unwrap_or_default();
                    block.id = read_trimmed_string(content_block.get("id"));
                    block.name = read_trimmed_string(content_block.get("name"));
                    block.input = content_block.get("input").cloned();
                    if let Some(text) = read_nonempty_string(content_block.get("text"))
                        .or_else(|| read_nonempty_string(content_block.get("thinking")))
                    {
                        block.text.push_str(text.as_str());
                    }
                }
                blocks.insert(index, block);
            }
            "content_block_delta" => {
                let index = event_row.get("index").and_then(Value::as_u64).unwrap_or(0) as usize;
                let block = blocks.entry(index).or_default();
                let Some(delta) = event_row.get("delta").and_then(Value::as_object) else {
                    continue;
                };
                let delta_type = read_trimmed_string(delta.get("type")).unwrap_or_default();
                match delta_type.as_str() {
                    "text_delta" => {
                        if let Some(text) = read_nonempty_string(delta.get("text")) {
                            block.text.push_str(text.as_str());
                        }
                    }
                    "thinking_delta" => {
                        if block.kind.is_empty() {
                            block.kind = "thinking".to_string();
                        }
                        if let Some(thinking) = read_nonempty_string(delta.get("thinking")) {
                            block.text.push_str(thinking.as_str());
                        }
                    }
                    "input_json_delta" => {
                        if block.kind.is_empty() {
                            block.kind = "tool_use".to_string();
                        }
                        if let Some(partial) = read_nonempty_string(delta.get("partial_json")) {
                            block.json_delta.push_str(partial.as_str());
                        }
                    }
                    _ => {}
                }
            }
            "message_delta" => {
                if let Some(delta) = event_row.get("delta").and_then(Value::as_object) {
                    stop_reason = read_trimmed_string(delta.get("stop_reason")).or(stop_reason);
                }
                if event_row.get("usage").is_some() {
                    usage = event_row.get("usage").cloned();
                }
            }
            _ => {}
        }
    }

    let mut content: Vec<Value> = Vec::new();
    for (_index, block) in blocks {
        match block.kind.as_str() {
            "text" => {
                content.push(Value::Object(Map::from_iter([
                    ("type".to_string(), Value::String("text".to_string())),
                    ("text".to_string(), Value::String(block.text)),
                ])));
            }
            "thinking" | "reasoning" | "redacted_thinking" => {
                content.push(Value::Object(Map::from_iter([
                    ("type".to_string(), Value::String("thinking".to_string())),
                    ("text".to_string(), Value::String(block.text)),
                ])));
            }
            "tool_use" => {
                let input = if block.json_delta.is_empty() {
                    block.input.unwrap_or_else(|| Value::Object(Map::new()))
                } else {
                    serde_json::from_str::<Value>(block.json_delta.as_str())
                        .unwrap_or_else(|_| Value::String(block.json_delta.clone()))
                };
                content.push(Value::Object(Map::from_iter([
                    ("type".to_string(), Value::String("tool_use".to_string())),
                    (
                        "id".to_string(),
                        Value::String(block.id.unwrap_or_else(|| "call_0".to_string())),
                    ),
                    (
                        "name".to_string(),
                        Value::String(block.name.unwrap_or_else(|| "tool".to_string())),
                    ),
                    ("input".to_string(), input),
                ])));
            }
            _ => {}
        }
    }

    if content.is_empty() {
        return Err(
            "Anthropic SSE response did not contain materializable content blocks".to_string(),
        );
    }
    message.insert("content".to_string(), Value::Array(content));
    if let Some(stop_reason) = stop_reason {
        message.insert("stop_reason".to_string(), Value::String(stop_reason));
    }
    if let Some(usage) = usage {
        message.insert("usage".to_string(), usage);
    }
    Ok(Value::Object(message))
}

#[cfg(test)]
mod tests {
    use super::{
        build_openai_chat_from_anthropic_message_full,
        build_openai_chat_response_from_anthropic_message,
        BuildOpenAiChatFromAnthropicMessageFullInput,
    };
    use serde_json::json;

    #[test]
    fn builds_chat_response_from_anthropic_sse_body_text() {
        let body_text = concat!(
            "event: message_start\n",
            "data: {\"type\":\"message_start\",\"message\":{\"id\":\"msg_sse\",\"type\":\"message\",\"role\":\"assistant\",\"model\":\"mimo-v2.5\",\"content\":[],\"stop_reason\":null,\"usage\":{\"input_tokens\":1,\"output_tokens\":0}}}\n\n",
            "event: content_block_start\n",
            "data: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}\n\n",
            "event: content_block_delta\n",
            "data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"anthropic inbound ok\"}}\n\n",
            "event: content_block_stop\n",
            "data: {\"type\":\"content_block_stop\",\"index\":0}\n\n",
            "event: message_delta\n",
            "data: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\",\"stop_sequence\":null},\"usage\":{\"output_tokens\":3}}\n\n",
            "event: message_stop\n",
            "data: {\"type\":\"message_stop\"}\n\n"
        );
        let output = build_openai_chat_response_from_anthropic_message(
            &json!({ "mode": "sse", "bodyText": body_text }),
            "req_sse",
        )
        .expect("chat response from anthropic sse");
        assert_eq!(
            output["choices"][0]["message"]["content"],
            "anthropic inbound ok"
        );
    }

    #[test]
    fn builds_chat_response_from_anthropic_sse_preserves_delta_spaces() {
        let body_text = concat!(
            "event: message_start\n",
            "data: {\"type\":\"message_start\",\"message\":{\"id\":\"msg_sse\",\"type\":\"message\",\"role\":\"assistant\",\"model\":\"mimo-v2.5\",\"content\":[]}}\n\n",
            "event: content_block_start\n",
            "data: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"Let me\"}}\n\n",
            "event: content_block_delta\n",
            "data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\" understand\"}}\n\n",
            "event: message_delta\n",
            "data: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\",\"stop_sequence\":null}}\n\n",
            "event: message_stop\n",
            "data: {\"type\":\"message_stop\"}\n\n"
        );
        let output = build_openai_chat_response_from_anthropic_message(
            &json!({ "mode": "sse", "bodyText": body_text }),
            "req_sse",
        )
        .expect("chat response from anthropic sse");
        assert_eq!(
            output["choices"][0]["message"]["content"],
            "Let me understand"
        );
    }

    #[test]
    fn builds_chat_response_from_anthropic_sse_tool_use() {
        let body_text = concat!(
            "event: message_start\n",
            "data: {\"type\":\"message_start\",\"message\":{\"id\":\"msg_sse\",\"type\":\"message\",\"role\":\"assistant\",\"model\":\"mimo-v2.5\",\"content\":[]}}\n\n",
            "event: content_block_start\n",
            "data: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"tool_use\",\"id\":\"call_1\",\"name\":\"exec_command\",\"input\":{}}}\n\n",
            "event: content_block_delta\n",
            "data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"input_json_delta\",\"partial_json\":\"{\\\"cmd\\\":\"}}\n\n",
            "event: content_block_delta\n",
            "data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"input_json_delta\",\"partial_json\":\"\\\"pwd\\\"}\"}}\n\n",
            "event: message_delta\n",
            "data: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"tool_use\",\"stop_sequence\":null}}\n\n",
            "event: message_stop\n",
            "data: {\"type\":\"message_stop\"}\n\n"
        );
        let output = build_openai_chat_response_from_anthropic_message(
            &json!({ "mode": "sse", "bodyText": body_text }),
            "req_sse",
        )
        .expect("chat response from anthropic sse");
        assert_eq!(output["choices"][0]["finish_reason"], "tool_calls");
        let tool_call = &output["choices"][0]["message"]["tool_calls"][0];
        assert_eq!(tool_call["id"], "call_1");
        assert_eq!(tool_call["function"]["name"], "exec_command");
        assert_eq!(tool_call["function"]["arguments"], "{\"cmd\":\"pwd\"}");
    }

    #[test]
    fn builds_chat_response_from_anthropic_sse_incomplete_tool_json_as_raw_arguments() {
        let body_text = concat!(
            "event: message_start\n",
            "data: {\"type\":\"message_start\",\"message\":{\"id\":\"msg_sse\",\"type\":\"message\",\"role\":\"assistant\",\"model\":\"MiniMax-M3\",\"content\":[]}}\n\n",
            "event: content_block_start\n",
            "data: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"tool_use\",\"id\":\"call_1\",\"name\":\"exec_command\",\"input\":{}}}\n\n",
            "event: content_block_delta\n",
            "data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"input_json_delta\",\"partial_json\":\"{\\\"cmd\\\":\\\"unzip -l /tmp/app.apk\"}}\n\n",
            "event: message_delta\n",
            "data: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"tool_use\",\"stop_sequence\":null}}\n\n",
            "event: message_stop\n",
            "data: {\"type\":\"message_stop\"}\n\n"
        );
        let output = build_openai_chat_response_from_anthropic_message(
            &json!({ "mode": "sse", "bodyText": body_text }),
            "req_sse",
        )
        .expect("chat response from incomplete anthropic sse tool args");
        assert_eq!(output["choices"][0]["finish_reason"], "tool_calls");
        let tool_call = &output["choices"][0]["message"]["tool_calls"][0];
        assert_eq!(tool_call["id"], "call_1");
        assert_eq!(tool_call["function"]["name"], "exec_command");
        assert_eq!(
            tool_call["function"]["arguments"],
            "{\"cmd\":\"unzip -l /tmp/app.apk"
        );
    }

    #[test]
    fn builds_full_chat_response_from_wrapped_anthropic_message() {
        let output = build_openai_chat_from_anthropic_message_full(
            BuildOpenAiChatFromAnthropicMessageFullInput {
                payload: json!({
                    "request_id": "req_outer",
                    "data": {
                        "id": "msg_full",
                        "role": "assistant",
                        "model": "claude-test",
                        "content": [
                            { "type": "text", "text": "full native ok" }
                        ],
                        "stop_reason": "end_turn"
                    }
                })
                .to_string(),
            },
        )
        .expect("full anthropic message conversion");
        let chat: serde_json::Value = serde_json::from_str(&output.result).expect("chat json");
        assert_eq!(output.id.as_deref(), Some("msg_full"));
        assert_eq!(chat["id"], "msg_full");
        assert_eq!(chat["choices"][0]["message"]["content"], "full native ok");
        assert_eq!(chat["choices"][0]["finish_reason"], "stop");
    }
}
