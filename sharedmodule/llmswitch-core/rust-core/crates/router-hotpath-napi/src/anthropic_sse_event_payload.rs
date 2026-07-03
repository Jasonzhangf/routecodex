use serde_json::{Map, Value};

fn read_input_object(input_json: String, label: &str) -> Result<Map<String, Value>, String> {
    let input: Value = serde_json::from_str(&input_json)
        .map_err(|error| format!("Failed to parse {} JSON: {}", label, error))?;
    input
        .as_object()
        .cloned()
        .ok_or_else(|| format!("{} expected object", label))
}

fn read_config_string<'a>(config: &'a Map<String, Value>, field: &str) -> Option<&'a str> {
    config
        .get(field)
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
}

fn read_reasoning_mode(config: &Map<String, Value>) -> &str {
    read_config_string(config, "reasoningMode").unwrap_or("channel")
}

fn build_anthropic_event(event_type: &str, data: Value) -> Value {
    serde_json::json!({
        "type": event_type,
        "event": event_type,
        "protocol": "anthropic-messages",
        "direction": "json_to_sse",
        "data": data
    })
}

fn chunk_text(input: &str, size: usize) -> Vec<String> {
    if input.is_empty() || size == 0 {
        return vec![input.to_string()];
    }
    input
        .chars()
        .collect::<Vec<_>>()
        .chunks(size)
        .map(|chunk| chunk.iter().collect::<String>())
        .collect()
}

fn format_reasoning_text(text: &str, config: &Map<String, Value>) -> String {
    let trimmed = text.trim();
    let Some(prefix) = read_config_string(config, "reasoningTextPrefix") else {
        return trimmed.to_string();
    };
    if prefix.ends_with(' ') || prefix.ends_with('\n') {
        format!("{}{}", prefix, trimmed)
    } else {
        format!("{} {}", prefix, trimmed)
    }
}

fn dispatch_reasoning(
    input: &str,
    config: &Map<String, Value>,
) -> (Option<String>, Option<String>) {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return (None, None);
    }
    let mode = read_reasoning_mode(config);
    match mode {
        "drop" => (None, None),
        "text" => (Some(format_reasoning_text(trimmed, config)), None),
        _ => (None, Some(trimmed.to_string())),
    }
}

fn normalize_tool_input(input: &Value) -> String {
    match input {
        Value::String(s) => s.clone(),
        _ => serde_json::to_string(input).unwrap_or_default(),
    }
}

pub fn build_anthropic_sse_event_sequence_json(input_json: String) -> Result<String, String> {
    let input = read_input_object(input_json, "Anthropic SSE event sequence")?;
    let response = input
        .get("response")
        .and_then(Value::as_object)
        .ok_or_else(|| "Anthropic SSE event sequence missing response".to_string())?;
    let config = input
        .get("config")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let chunk_size = config
        .get("chunkSize")
        .and_then(|v| v.as_u64())
        .map(|v| v as usize)
        .unwrap_or(1024);

    let id = response
        .get("id")
        .and_then(Value::as_str)
        .filter(|v| !v.trim().is_empty())
        .ok_or_else(|| "Invalid Anthropic response: missing id".to_string())?;

    let role = response
        .get("role")
        .and_then(Value::as_str)
        .filter(|v| *v == "assistant" || *v == "user")
        .ok_or_else(|| "Invalid Anthropic response: missing role".to_string())?;

    let model = response
        .get("model")
        .and_then(Value::as_str)
        .filter(|v| !v.trim().is_empty())
        .ok_or_else(|| "Invalid Anthropic response: missing model".to_string())?;

    let mut events: Vec<Value> = Vec::new();

    events.push(build_anthropic_event(
        "message_start",
        serde_json::json!({
            "type": "message_start",
            "message": {
                "id": id,
                "type": "message",
                "role": role,
                "model": model
            }
        }),
    ));

    let content = response
        .get("content")
        .and_then(Value::as_array)
        .ok_or_else(|| "Invalid Anthropic response: missing content".to_string())?;

    let mut index = 0usize;
    for block in content {
        let block_obj = block
            .as_object()
            .ok_or_else(|| format!("Invalid Anthropic content block at index {}", index))?;
        let block_type = block_obj
            .get("type")
            .and_then(Value::as_str)
            .ok_or_else(|| {
                format!(
                    "Invalid Anthropic content block at index {}: missing type",
                    index
                )
            })?;

        match block_type {
            "text" => {
                let text = block_obj
                    .get("text")
                    .and_then(Value::as_str)
                    .ok_or_else(|| "Invalid Anthropic text block: missing text".to_string())?;
                if text.is_empty() {
                    return Err("Invalid Anthropic text block: missing text".to_string());
                }
                events.push(build_anthropic_event(
                    "content_block_start",
                    serde_json::json!({"type": "content_block_start", "index": index, "content_block": {"type": "text"}}),
                ));
                for chunk in chunk_text(text, chunk_size) {
                    events.push(build_anthropic_event(
                        "content_block_delta",
                        serde_json::json!({"type": "content_block_delta", "index": index, "delta": {"type": "text_delta", "text": chunk}}),
                    ));
                }
                events.push(build_anthropic_event(
                    "content_block_stop",
                    serde_json::json!({"type": "content_block_stop", "index": index}),
                ));
                index += 1;
            }
            "thinking" => {
                let thinking_text = block_obj
                    .get("text")
                    .and_then(Value::as_str)
                    .ok_or_else(|| "Invalid Anthropic thinking block: missing text".to_string())?;
                let (append_to_content, channel) = dispatch_reasoning(thinking_text, &config);
                if let Some(text) = append_to_content {
                    events.push(build_anthropic_event(
                        "content_block_start",
                        serde_json::json!({"type": "content_block_start", "index": index, "content_block": {"type": "text"}}),
                    ));
                    for chunk in chunk_text(&text, chunk_size) {
                        events.push(build_anthropic_event(
                            "content_block_delta",
                            serde_json::json!({"type": "content_block_delta", "index": index, "delta": {"type": "text_delta", "text": chunk}}),
                        ));
                    }
                    events.push(build_anthropic_event(
                        "content_block_stop",
                        serde_json::json!({"type": "content_block_stop", "index": index}),
                    ));
                    index += 1;
                }
                if let Some(chan) = channel {
                    events.push(build_anthropic_event(
                        "content_block_start",
                        serde_json::json!({
                            "type": "content_block_start",
                            "index": index,
                            "content_block": {"type": "thinking"}
                        }),
                    ));
                    for chunk in chunk_text(&chan, chunk_size) {
                        events.push(build_anthropic_event(
                            "content_block_delta",
                            serde_json::json!({"type": "content_block_delta", "index": index, "delta": {"type": "thinking_delta", "text": chunk}}),
                        ));
                    }
                    events.push(build_anthropic_event(
                        "content_block_stop",
                        serde_json::json!({"type": "content_block_stop", "index": index}),
                    ));
                    index += 1;
                }
            }
            "redacted_thinking" => {
                let data_val = block_obj
                    .get("data")
                    .and_then(Value::as_str)
                    .filter(|v| !v.trim().is_empty())
                    .ok_or_else(|| {
                        "Invalid Anthropic redacted_thinking block: missing data".to_string()
                    })?;
                events.push(build_anthropic_event(
                    "content_block_start",
                    serde_json::json!({"type": "content_block_start", "index": index, "content_block": {"type": "redacted_thinking", "data": data_val}}),
                ));
                events.push(build_anthropic_event(
                    "content_block_stop",
                    serde_json::json!({"type": "content_block_stop", "index": index}),
                ));
                index += 1;
            }
            "tool_use" => {
                let tool_id = block_obj
                    .get("id")
                    .and_then(Value::as_str)
                    .filter(|v| !v.trim().is_empty())
                    .ok_or_else(|| "Invalid Anthropic tool_use block: missing id".to_string())?;
                let tool_name = block_obj
                    .get("name")
                    .and_then(Value::as_str)
                    .filter(|v| !v.trim().is_empty());
                let tool_input = block_obj
                    .get("input")
                    .ok_or_else(|| "Invalid Anthropic tool_use block: missing input".to_string())?;
                let mut content_block = Map::new();
                content_block.insert("type".to_string(), Value::String("tool_use".to_string()));
                content_block.insert("id".to_string(), Value::String(tool_id.to_string()));
                if let Some(name) = tool_name {
                    content_block.insert("name".to_string(), Value::String(name.to_string()));
                }
                content_block.insert("input".to_string(), tool_input.clone());
                events.push(build_anthropic_event(
                    "content_block_start",
                    serde_json::json!({"type": "content_block_start", "index": index, "content_block": content_block}),
                ));
                let partial_json = normalize_tool_input(tool_input);
                if !partial_json.is_empty() {
                    events.push(build_anthropic_event(
                        "content_block_delta",
                        serde_json::json!({"type": "content_block_delta", "index": index, "delta": {"type": "input_json_delta", "partial_json": partial_json}}),
                    ));
                }
                events.push(build_anthropic_event(
                    "content_block_stop",
                    serde_json::json!({"type": "content_block_stop", "index": index}),
                ));
                index += 1;
            }
            "tool_result" => {
                let tool_use_id = block_obj
                    .get("tool_use_id")
                    .and_then(Value::as_str)
                    .filter(|v| !v.trim().is_empty())
                    .ok_or_else(|| {
                        "Invalid Anthropic tool_result block: missing tool_use_id".to_string()
                    })?;
                let mut content_block = Map::new();
                content_block.insert("type".to_string(), Value::String("tool_result".to_string()));
                content_block.insert(
                    "tool_use_id".to_string(),
                    Value::String(tool_use_id.to_string()),
                );
                if let Some(content) = block_obj.get("content") {
                    content_block.insert("content".to_string(), content.clone());
                }
                if let Some(is_error) = block_obj.get("is_error").and_then(Value::as_bool) {
                    content_block.insert("is_error".to_string(), Value::Bool(is_error));
                }
                events.push(build_anthropic_event(
                    "content_block_start",
                    serde_json::json!({"type": "content_block_start", "index": index, "content_block": content_block}),
                ));
                events.push(build_anthropic_event(
                    "content_block_stop",
                    serde_json::json!({"type": "content_block_stop", "index": index}),
                ));
                index += 1;
            }
            other => {
                return Err(format!(
                    "Unsupported Anthropic content block type: {}",
                    other
                ));
            }
        }
    }

    let stop_reason = response
        .get("stop_reason")
        .and_then(Value::as_str)
        .filter(|v| !v.trim().is_empty())
        .ok_or_else(|| "Invalid Anthropic response: missing stop_reason".to_string())?;
    let usage = response.get("usage");
    let mut delta = Map::new();
    delta.insert(
        "stop_reason".to_string(),
        Value::String(stop_reason.to_string()),
    );
    if let Some(usage_value) = usage {
        delta.insert("usage".to_string(), usage_value.clone());
    }

    events.push(build_anthropic_event(
        "message_delta",
        serde_json::json!({"type": "message_delta", "delta": delta}),
    ));
    events.push(build_anthropic_event(
        "message_stop",
        serde_json::json!({"type": "message_stop"}),
    ));

    serde_json::to_string(&events).map_err(|error| {
        format!(
            "Failed to serialize Anthropic SSE event sequence JSON: {}",
            error
        )
    })
}

fn parse_anthropic_sse_blocks(body_text: &str) -> Result<Vec<(String, Value)>, String> {
    let mut events = Vec::new();
    let normalized = body_text.replace("\r\n", "\n");
    for block in normalized.split("\n\n") {
        if block.trim().is_empty() {
            continue;
        }
        let mut event_name = String::new();
        let mut data_lines = Vec::new();
        for line in block.lines() {
            if let Some(rest) = line.strip_prefix("event:") {
                event_name = rest.trim().to_string();
            } else if let Some(rest) = line.strip_prefix("data:") {
                data_lines.push(rest.trim_start().to_string());
            }
        }
        if event_name.is_empty() {
            return Err("Anthropic SSE event missing event type".to_string());
        }
        if data_lines.is_empty() {
            return Err(format!("Anthropic SSE event missing data: {}", event_name));
        }
        let data_text = data_lines.join("\n");
        let value: Value = serde_json::from_str(&data_text)
            .map_err(|error| format!("Failed to parse Anthropic SSE event JSON: {}", error))?;
        events.push((event_name, value));
    }
    Ok(events)
}

#[derive(Default)]
struct AnthropicAccumulator {
    id: Option<String>,
    model: Option<String>,
    role: Option<String>,
    content: Vec<Value>,
    usage: Option<Value>,
    stop_reason: Option<String>,
    stop_sequence: Option<Value>,
    current_block: Option<CurrentBlock>,
    completed: bool,
}

enum CurrentBlock {
    Text {
        buffer: String,
        index: usize,
    },
    Thinking {
        buffer: String,
        signature: Option<String>,
        index: usize,
    },
    RedactedThinking {
        data: String,
        index: usize,
    },
    ToolUse {
        id: String,
        name: String,
        buffer: String,
        index: usize,
    },
    ToolResult {
        tool_use_id: String,
        content: Option<Value>,
        is_error: Option<bool>,
        index: usize,
    },
}

fn infer_stop_reason(state: &AnthropicAccumulator) -> String {
    if let Some(reason) = &state.stop_reason {
        return reason.clone();
    }
    if state
        .content
        .iter()
        .any(|b| b.get("type").and_then(|v| v.as_str()) == Some("tool_use"))
    {
        return "tool_use".to_string();
    }
    "end_turn".to_string()
}

pub fn build_anthropic_json_from_sse_json(input_json: String) -> Result<String, String> {
    let input = read_input_object(input_json, "Anthropic SSE decode")?;
    let body_text = input
        .get("body_text")
        .and_then(Value::as_str)
        .ok_or_else(|| "Anthropic SSE decode missing body_text".to_string())?;
    let config = input
        .get("config")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();

    let mut state = AnthropicAccumulator::default();

    for (event_name, event_value) in parse_anthropic_sse_blocks(body_text)? {
        let event_obj = event_value
            .as_object()
            .ok_or_else(|| "Anthropic SSE event payload expected object".to_string())?;

        let payload = event_obj
            .get("data")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_else(|| event_obj.clone());

        let event_type = payload
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or(event_name.as_str());

        if event_type == "error" {
            let message = payload
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("Anthropic SSE upstream returned an error event");
            return Err(format!("Anthropic SSE error event: {}", message));
        }

        match event_type {
            "message_start" => {
                let msg = payload
                    .get("message")
                    .and_then(Value::as_object)
                    .ok_or_else(|| {
                        "Invalid Anthropic message_start: missing message".to_string()
                    })?;
                state.id = msg
                    .get("id")
                    .and_then(Value::as_str)
                    .filter(|v| !v.trim().is_empty())
                    .map(String::from);
                state.model = msg
                    .get("model")
                    .and_then(Value::as_str)
                    .filter(|v| !v.trim().is_empty())
                    .map(String::from);
                state.role = msg
                    .get("role")
                    .and_then(Value::as_str)
                    .filter(|v| *v == "assistant" || *v == "user")
                    .map(String::from);
                if let Some(usage) = msg.get("usage") {
                    state.usage = Some(usage.clone());
                }
            }
            "content_block_start" => {
                let cb = payload
                    .get("content_block")
                    .and_then(Value::as_object)
                    .ok_or_else(|| {
                        "Invalid Anthropic content_block_start: missing content_block".to_string()
                    })?;
                let cb_type = cb.get("type").and_then(Value::as_str).ok_or_else(|| {
                    "Invalid Anthropic content_block_start: missing type".to_string()
                })?;
                let idx = payload.get("index").and_then(|v| v.as_u64()).unwrap_or(0) as usize;

                match cb_type {
                    "text" => {
                        state.current_block = Some(CurrentBlock::Text {
                            buffer: String::new(),
                            index: idx,
                        });
                    }
                    "thinking" => {
                        state.current_block = Some(CurrentBlock::Thinking {
                            buffer: String::new(),
                            signature: cb
                                .get("signature")
                                .and_then(Value::as_str)
                                .map(String::from),
                            index: idx,
                        });
                    }
                    "redacted_thinking" => {
                        state.current_block = Some(CurrentBlock::RedactedThinking {
                            data: cb
                                .get("data")
                                .and_then(Value::as_str)
                                .unwrap_or("")
                                .to_string(),
                            index: idx,
                        });
                    }
                    "tool_use" => {
                        let tool_id = cb
                            .get("id")
                            .and_then(Value::as_str)
                            .filter(|v| !v.trim().is_empty())
                            .ok_or_else(|| {
                                "Invalid Anthropic tool_use block: missing id".to_string()
                            })?;
                        let tool_name = cb
                            .get("name")
                            .and_then(Value::as_str)
                            .filter(|v| !v.trim().is_empty())
                            .ok_or_else(|| {
                                "Invalid Anthropic tool_use block: missing name".to_string()
                            })?;
                        state.current_block = Some(CurrentBlock::ToolUse {
                            id: tool_id.to_string(),
                            name: tool_name.to_string(),
                            buffer: String::new(),
                            index: idx,
                        });
                    }
                    "tool_result" => {
                        state.current_block = Some(CurrentBlock::ToolResult {
                            tool_use_id: cb
                                .get("tool_use_id")
                                .and_then(Value::as_str)
                                .unwrap_or("")
                                .to_string(),
                            content: cb.get("content").cloned(),
                            is_error: cb.get("is_error").and_then(Value::as_bool),
                            index: idx,
                        });
                    }
                    other => {
                        return Err(format!(
                            "Unsupported Anthropic content block type: {}",
                            other
                        ));
                    }
                }
            }
            "content_block_delta" => {
                let delta = payload
                    .get("delta")
                    .and_then(Value::as_object)
                    .ok_or_else(|| {
                        "Invalid Anthropic content_block_delta: missing delta".to_string()
                    })?;
                let delta_type = delta.get("type").and_then(Value::as_str).ok_or_else(|| {
                    "Invalid Anthropic content_block_delta: missing delta type".to_string()
                })?;

                if let Some(ref mut block) = state.current_block {
                    match (block, delta_type, delta) {
                        (CurrentBlock::Text { buffer, .. }, "text_delta", d) => {
                            if let Some(text) = d.get("text").and_then(Value::as_str) {
                                buffer.push_str(text);
                            }
                        }
                        (
                            CurrentBlock::Thinking {
                                buffer, signature, ..
                            },
                            "thinking_delta",
                            d,
                        ) => {
                            if let Some(text) = d.get("text").and_then(Value::as_str) {
                                buffer.push_str(text);
                            }
                            if let Some(sig) = d
                                .get("signature")
                                .and_then(Value::as_str)
                                .filter(|v| !v.trim().is_empty())
                            {
                                *signature = Some(String::from(sig));
                            }
                        }
                        (CurrentBlock::Thinking { buffer, .. }, "text_delta", d) => {
                            if let Some(text) = d.get("text").and_then(Value::as_str) {
                                buffer.push_str(text);
                            }
                        }
                        (CurrentBlock::ToolUse { buffer, .. }, "input_json_delta", d) => {
                            if let Some(pj) = d.get("partial_json").and_then(Value::as_str) {
                                buffer.push_str(pj);
                            }
                        }
                        _ => {}
                    }
                }
            }
            "content_block_stop" => {
                if let Some(block) = state.current_block.take() {
                    match block {
                        CurrentBlock::Text { buffer, .. } => {
                            if !buffer.is_empty() {
                                state
                                    .content
                                    .push(serde_json::json!({"type": "text", "text": buffer}));
                            }
                        }
                        CurrentBlock::Thinking {
                            buffer, signature, ..
                        } => {
                            let (append, chan) = dispatch_reasoning(&buffer, &config);
                            if let Some(text) = append {
                                state
                                    .content
                                    .push(serde_json::json!({"type": "text", "text": text}));
                            }
                            if let Some(channel_text) = chan {
                                let mut obj = serde_json::Map::new();
                                obj.insert("type".to_string(), serde_json::json!("thinking"));
                                obj.insert("text".to_string(), serde_json::json!(channel_text));
                                if let Some(sig) = signature.filter(|s| !s.trim().is_empty()) {
                                    obj.insert("signature".to_string(), serde_json::json!(sig));
                                }
                                state.content.push(serde_json::json!(obj));
                            } else if let Some(sig) = signature.filter(|s| !s.trim().is_empty()) {
                                state.content.push(
                                    serde_json::json!({"type": "redacted_thinking", "data": sig}),
                                );
                            }
                        }
                        CurrentBlock::RedactedThinking { data, .. } => {
                            if !data.trim().is_empty() {
                                state.content.push(serde_json::json!({"type": "redacted_thinking", "data": data.trim()}));
                            }
                        }
                        CurrentBlock::ToolUse {
                            id, name, buffer, ..
                        } => {
                            let input: Value = if buffer.is_empty() {
                                serde_json::Value::Object(serde_json::Map::new())
                            } else {
                                serde_json::from_str(&buffer)
                                    .unwrap_or(serde_json::Value::Object(serde_json::Map::new()))
                            };
                            let mut obj = serde_json::Map::new();
                            obj.insert("type".to_string(), serde_json::json!("tool_use"));
                            obj.insert("id".to_string(), serde_json::json!(id));
                            obj.insert("name".to_string(), serde_json::json!(name));
                            obj.insert("input".to_string(), input);
                            state.content.push(serde_json::json!(obj));
                        }
                        CurrentBlock::ToolResult {
                            tool_use_id,
                            content,
                            is_error,
                            ..
                        } => {
                            let mut obj = serde_json::Map::new();
                            obj.insert("type".to_string(), serde_json::json!("tool_result"));
                            obj.insert("tool_use_id".to_string(), serde_json::json!(tool_use_id));
                            if let Some(c) = content {
                                obj.insert("content".to_string(), c);
                            }
                            if let Some(ie) = is_error {
                                obj.insert("is_error".to_string(), serde_json::json!(ie));
                            }
                            state.content.push(serde_json::json!(obj));
                        }
                    }
                }
            }
            "message_delta" => {
                let delta = payload.get("delta").and_then(Value::as_object).cloned();
                if let Some(ref d) = delta {
                    if let Some(sr) = d
                        .get("stop_reason")
                        .and_then(Value::as_str)
                        .filter(|v| !v.trim().is_empty())
                    {
                        state.stop_reason = Some(String::from(sr));
                    }
                    if let Some(ss) = d.get("stop_sequence") {
                        state.stop_sequence = Some(ss.clone());
                    }
                    if let Some(usage) = d.get("usage") {
                        state.usage = Some(usage.clone());
                    }
                }
            }
            "message_stop" => {
                state.completed = true;
            }
            other => {
                return Err(format!("Unsupported Anthropic SSE event type: {}", other));
            }
        }
    }

    if !state.completed {
        return Err("Anthropic SSE stream incomplete before message_stop".to_string());
    }
    let id = state
        .id
        .clone()
        .ok_or_else(|| "Anthropic SSE stream missing message id".to_string())?;
    let role = state
        .role
        .clone()
        .ok_or_else(|| "Anthropic SSE stream missing message role".to_string())?;
    let model = state
        .model
        .clone()
        .ok_or_else(|| "Anthropic SSE stream missing message model".to_string())?;

    let mut response = serde_json::Map::new();
    response.insert("id".to_string(), serde_json::json!(id));
    response.insert("type".to_string(), serde_json::json!("message"));
    response.insert("role".to_string(), serde_json::json!(role));
    response.insert("model".to_string(), serde_json::json!(model));
    response.insert("content".to_string(), serde_json::json!(state.content));
    response.insert(
        "stop_reason".to_string(),
        serde_json::json!(infer_stop_reason(&state)),
    );
    if let Some(ss) = state.stop_sequence {
        response.insert("stop_sequence".to_string(), ss);
    }
    if let Some(usage) = state.usage {
        response.insert("usage".to_string(), usage);
    }

    serde_json::to_string(&serde_json::Value::Object(response))
        .map_err(|error| format!("Failed to serialize Anthropic SSE decode JSON: {}", error))
}


pub fn build_anthropic_sse_stream_json(input_json: String) -> Result<String, String> {
    let events_json = build_anthropic_sse_event_sequence_json(input_json.clone())?;
    let events: Vec<Value> = serde_json::from_str(&events_json)
        .map_err(|error| format!("Failed to deserialize anthropic SSE events: {}", error))?;
    let input = read_input_object(input_json, "anthropic SSE stream")?;
    let response = input
        .get("response")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let mut event_types: std::collections::BTreeMap<String, i64> = std::collections::BTreeMap::new();
    let mut error_count: i64 = 0;
    let error_names = ["error"];
    for event in &events {
        let event_type = event
            .get("event")
            .or_else(|| event.get("type"))
            .and_then(Value::as_str)
            .map(str::to_string);
        if let Some(et) = event_type {
            if error_names.iter().any(|n| *n == et.as_str()) {
                error_count += 1;
            }
            *event_types.entry(et).or_insert(0) += 1;
        }
    }
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    let stats = serde_json::json!({
        "totalEvents": events.len() as i64,
        "eventTypes": event_types,
        "errorCount": error_count,
        "model": response.get("model").and_then(Value::as_str).unwrap_or(""),
        "startTime": now,
        "endTime": now,
        "lastEventTime": now,
    });
    let output = serde_json::json!({
        "events": events,
        "stats": stats,
    });
    serde_json::to_string(&output).map_err(|error| format!("Failed to serialize anthropic SSE stream JSON: {}", error))
}

#[cfg(test)]
mod tests {
    use super::{build_anthropic_json_from_sse_json, build_anthropic_sse_event_sequence_json};
    use serde_json::json;

    #[test]
    fn builds_anthropic_sse_event_sequence_for_text() {
        let output = build_anthropic_sse_event_sequence_json(
            json!({
                "response": {
                    "id": "msg_123",
                    "type": "message",
                    "role": "assistant",
                    "model": "claude-test",
                    "content": [{"type": "text", "text": "hello"}],
                    "stop_reason": "end_turn"
                }
            })
            .to_string(),
        )
        .unwrap();
        let events: serde_json::Value = serde_json::from_str(&output).unwrap();
        assert_eq!(events[0]["type"], "message_start");
        assert_eq!(events[0]["data"]["message"]["id"], "msg_123");
        assert_eq!(events[1]["type"], "content_block_start");
        assert_eq!(events[2]["type"], "content_block_delta");
        assert_eq!(events[2]["data"]["delta"]["text"], "hello");
        assert_eq!(events[3]["type"], "content_block_stop");
        assert_eq!(events[4]["type"], "message_delta");
        assert_eq!(events[4]["data"]["delta"]["stop_reason"], "end_turn");
        assert_eq!(events[5]["type"], "message_stop");
    }

    #[test]
    fn builds_anthropic_sse_event_sequence_for_thinking() {
        let output = build_anthropic_sse_event_sequence_json(
            json!({
                "response": {
                    "id": "msg_456",
                    "type": "message",
                    "role": "assistant",
                    "model": "claude-test",
                    "content": [{"type": "thinking", "text": "hidden plan", "signature": "sig123"}],
                    "stop_reason": "end_turn"
                }
            })
            .to_string(),
        )
        .unwrap();
        let events: serde_json::Value = serde_json::from_str(&output).unwrap();
        let events = events.as_array().unwrap();
        let thinking_block = events
            .iter()
            .find(|e| e["data"]["content_block"]["type"] == "thinking")
            .unwrap();
        assert!(thinking_block["data"]["content_block"]
            .get("signature")
            .is_none());
    }

    #[test]
    fn builds_anthropic_sse_event_sequence_projects_reasoning_to_text() {
        let output = build_anthropic_sse_event_sequence_json(
            json!({
                "response": {
                    "id": "msg_789",
                    "type": "message",
                    "role": "assistant",
                    "model": "claude-test",
                    "content": [{"type": "thinking", "text": "hidden plan"}],
                    "stop_reason": "end_turn"
                },
                "config": {"reasoningMode": "text", "reasoningTextPrefix": "[thought] "}
            })
            .to_string(),
        )
        .unwrap();
        let events: serde_json::Value = serde_json::from_str(&output).unwrap();
        let events = events.as_array().unwrap();
        let text_delta = events
            .iter()
            .find(|e| e["data"]["delta"]["type"] == "text_delta")
            .unwrap();
        assert_eq!(text_delta["data"]["delta"]["text"], "[thought] hidden plan");
    }

    #[test]
    fn builds_anthropic_sse_event_sequence_for_tool_use() {
        let output = build_anthropic_sse_event_sequence_json(
            json!({
                "response": {
                    "id": "msg_tool",
                    "type": "message",
                    "role": "assistant",
                    "model": "claude-test",
                    "content": [{"type": "tool_use", "id": "tool_1", "name": "get_weather", "input": {"city": "SF"}}],
                    "stop_reason": "tool_use"
                }
            }).to_string(),
        ).unwrap();
        let events: serde_json::Value = serde_json::from_str(&output).unwrap();
        let events = events.as_array().unwrap();
        let tool_start = events
            .iter()
            .find(|e| e["data"]["content_block"]["type"] == "tool_use")
            .unwrap();
        assert_eq!(tool_start["data"]["content_block"]["id"], "tool_1");
        assert_eq!(tool_start["data"]["content_block"]["name"], "get_weather");
        let tool_delta = events
            .iter()
            .find(|e| e["data"]["delta"]["type"] == "input_json_delta")
            .unwrap();
        assert!(tool_delta["data"]["delta"]["partial_json"]
            .as_str()
            .unwrap()
            .contains("SF"));
    }

    #[test]
    fn build_anthropic_sse_event_sequence_rejects_missing_id() {
        let err = build_anthropic_sse_event_sequence_json(
            json!({
                "response": {
                    "type": "message",
                    "role": "assistant",
                    "model": "claude-test",
                    "content": [{"type": "text", "text": "hello"}]
                }
            })
            .to_string(),
        )
        .unwrap_err();
        assert!(err.contains("missing id"));
    }

    #[test]
    fn build_anthropic_sse_event_sequence_rejects_missing_stop_reason() {
        let err = build_anthropic_sse_event_sequence_json(
            json!({
                "response": {
                    "id": "msg_123",
                    "type": "message",
                    "role": "assistant",
                    "model": "claude-test",
                    "content": [{"type": "text", "text": "hello"}]
                }
            })
            .to_string(),
        )
        .unwrap_err();
        assert!(err.contains("missing stop_reason"));
    }

    #[test]
    fn build_anthropic_json_from_sse_aggregates_text() {
        let body_text = [
            "event: message_start\ndata: {\"type\":\"message_start\",\"data\":{\"type\":\"message_start\",\"message\":{\"id\":\"msg_1\",\"type\":\"message\",\"role\":\"assistant\",\"model\":\"claude-test\"}}}",
            "event: content_block_start\ndata: {\"type\":\"content_block_start\",\"data\":{\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\"}}}",
            "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"data\":{\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"hello\"}}}",
            "event: content_block_stop\ndata: {\"type\":\"content_block_stop\",\"data\":{\"type\":\"content_block_stop\",\"index\":0}}",
            "event: message_delta\ndata: {\"type\":\"message_delta\",\"data\":{\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"}}}",
            "event: message_stop\ndata: {\"type\":\"message_stop\",\"data\":{\"type\":\"message_stop\"}}",
        ].join("\n\n");
        let output =
            build_anthropic_json_from_sse_json(json!({"body_text": body_text}).to_string())
                .unwrap();
        let response: serde_json::Value = serde_json::from_str(&output).unwrap();
        assert_eq!(response["id"], "msg_1");
        assert_eq!(response["content"][0]["text"], "hello");
        assert_eq!(response["stop_reason"], "end_turn");
    }

    #[test]
    fn build_anthropic_json_from_sse_requires_message_stop() {
        let body_text = [
            "event: message_start\ndata: {\"type\":\"message_start\",\"data\":{\"type\":\"message_start\",\"message\":{\"id\":\"msg_nostop\",\"type\":\"message\",\"role\":\"assistant\",\"model\":\"claude-test\"}}}",
            "event: content_block_start\ndata: {\"type\":\"content_block_start\",\"data\":{\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\"}}}",
            "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"data\":{\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"hello\"}}}",
        ].join("\n\n");
        let err = build_anthropic_json_from_sse_json(json!({"body_text": body_text}).to_string())
            .unwrap_err();
        assert!(err.contains("incomplete before message_stop"));
    }

    #[test]
    fn build_anthropic_json_from_sse_errors_on_upstream_error_event() {
        let body_text = [
            "event: error\ndata: {\"type\":\"error\",\"data\":{\"type\":\"error\",\"message\":\"overloaded\"}}",
        ].join("\n\n");
        let err = build_anthropic_json_from_sse_json(json!({"body_text": body_text}).to_string())
            .unwrap_err();
        assert!(err.contains("Anthropic SSE error event"));
    }
}
