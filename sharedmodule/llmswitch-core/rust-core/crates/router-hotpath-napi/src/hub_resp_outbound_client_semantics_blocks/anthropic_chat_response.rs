use serde_json::{Map, Value};

use crate::hub_reasoning_tool_normalizer::{
    build_message_reasoning_value, normalize_message_reasoning_ssot, project_message_reasoning_text,
};
use crate::hub_resp_outbound_client_semantics_blocks::provider_outcome::resolve_anthropic_chat_completion_outcome;
use crate::shared_json_utils::read_trimmed_string;

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
                if !text.trim().is_empty() {
                    reasoning_parts.push(text);
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
                                Value::String(
                                    serde_json::to_string(&input)
                                        .unwrap_or_else(|_| "{}".to_string()),
                                ),
                            ),
                        ])),
                    ),
                ])));
            }
            _ => {}
        }
    }

    let visible_text = text_parts.join("");
    let mut message = Map::new();
    message.insert("role".to_string(), Value::String("assistant".to_string()));
    message.insert("content".to_string(), Value::String(visible_text.clone()));
    if !tool_calls.is_empty() {
        message.insert("tool_calls".to_string(), Value::Array(tool_calls.clone()));
    }
    if let Some(reasoning) = build_message_reasoning_value(&[], &reasoning_parts, None) {
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
        .get("shouldFailEmptyContextOverflow")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        return Err(
            "Anthropic response ended with context overflow and no assistant output".to_string(),
        );
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
                    if let Some(text) = read_trimmed_string(content_block.get("text"))
                        .or_else(|| read_trimmed_string(content_block.get("thinking")))
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
                        if let Some(text) = read_trimmed_string(delta.get("text")) {
                            block.text.push_str(text.as_str());
                        }
                    }
                    "thinking_delta" => {
                        if block.kind.is_empty() {
                            block.kind = "thinking".to_string();
                        }
                        if let Some(thinking) = read_trimmed_string(delta.get("thinking")) {
                            block.text.push_str(thinking.as_str());
                        }
                    }
                    "input_json_delta" => {
                        if block.kind.is_empty() {
                            block.kind = "tool_use".to_string();
                        }
                        if let Some(partial) = read_trimmed_string(delta.get("partial_json")) {
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
                let input = block
                    .input
                    .or_else(|| serde_json::from_str::<Value>(block.json_delta.as_str()).ok())
                    .unwrap_or_else(|| Value::Object(Map::new()));
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
    use super::build_openai_chat_response_from_anthropic_message;
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
        assert_eq!(output["choices"][0]["message"]["content"], "anthropic inbound ok");
    }
}
