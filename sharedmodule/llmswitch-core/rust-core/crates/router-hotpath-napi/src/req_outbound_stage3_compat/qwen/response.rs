use regex::Regex;
use serde_json::{Map, Number, Value, json};

fn number_or_default(value: Option<&Value>, fallback: i64) -> Value {
    if let Some(raw) = value {
        if let Some(num) = raw.as_i64() {
            return Value::Number(Number::from(num));
        }
        if let Some(num) = raw.as_u64() {
            return Value::Number(Number::from(num));
        }
        if let Some(num) = raw.as_f64() {
            if let Some(number) = Number::from_f64(num) {
                return Value::Number(number);
            }
        }
    }
    Value::Number(Number::from(fallback))
}

fn transform_qwen_finish_reason(reason: Option<&str>) -> String {
    match reason.unwrap_or("stop") {
        "stop" => "stop".to_string(),
        "length" => "length".to_string(),
        "tool_calls" => "tool_calls".to_string(),
        "content_filter" => "content_filter".to_string(),
        other => other.to_string(),
    }
}

fn transform_qwen_tool_calls(tool_calls: Option<&Value>) -> Vec<Value> {
    let Some(entries) = tool_calls.and_then(|v| v.as_array()) else {
        return Vec::new();
    };
    let now_ms = chrono::Utc::now().timestamp_millis();
    entries
        .iter()
        .enumerate()
        .map(|(index, raw_call)| {
            let call_obj = raw_call.as_object().cloned().unwrap_or_default();
            let function_obj = call_obj
                .get("function")
                .and_then(|v| v.as_object())
                .cloned()
                .unwrap_or_default();
            let id = call_obj
                .get("id")
                .and_then(|v| v.as_str())
                .map(|v| v.to_string())
                .unwrap_or_else(|| format!("call_{}_{}", now_ms, index));
            let name = function_obj
                .get("name")
                .and_then(|v| v.as_str())
                .map(|v| v.to_string())
                .unwrap_or_else(String::new);
            let args = match function_obj.get("arguments") {
                Some(Value::String(text)) => text.clone(),
                Some(other) => serde_json::to_string(other).unwrap_or_else(|_| "{}".to_string()),
                None => "{}".to_string(),
            };
            let mut function = Map::new();
            function.insert("name".to_string(), Value::String(name));
            function.insert("arguments".to_string(), Value::String(args));

            let mut tool_call = Map::new();
            tool_call.insert("id".to_string(), Value::String(id));
            tool_call.insert("type".to_string(), Value::String("function".to_string()));
            tool_call.insert("function".to_string(), Value::Object(function));
            Value::Object(tool_call)
        })
        .collect::<Vec<Value>>()
}


fn read_text_from_content_part(part: &Value) -> Option<String> {
    match part {
        Value::String(raw) => {
            let trimmed = raw.trim();
            if trimmed.is_empty() { None } else { Some(trimmed.to_string()) }
        }
        Value::Object(obj) => {
            for key in ["thinking", "text", "content", "value"] {
                let Some(raw) = obj.get(key).and_then(Value::as_str) else { continue; };
                let trimmed = raw.trim();
                if !trimmed.is_empty() {
                    return Some(trimmed.to_string());
                }
            }
            None
        }
        _ => None,
    }
}

fn collect_message_text_segments(message_obj: &Map<String, Value>) -> Vec<String> {
    let mut segments: Vec<String> = Vec::new();
    if let Some(content) = message_obj.get("content") {
        match content {
            Value::String(raw) => {
                let trimmed = raw.trim();
                if !trimmed.is_empty() {
                    segments.push(trimmed.to_string());
                }
            }
            Value::Array(parts) => {
                for part in parts {
                    if let Some(text) = read_text_from_content_part(part) {
                        segments.push(text);
                    }
                }
            }
            _ => {}
        }
    }
    for key in ["reasoning_content", "reasoning"] {
        let Some(raw) = message_obj.get(key).and_then(Value::as_str) else { continue; };
        let trimmed = raw.trim();
        if !trimmed.is_empty() {
            segments.push(trimmed.to_string());
        }
    }
    if let Some(reasoning_obj) = message_obj.get("reasoning").and_then(Value::as_object) {
        if let Some(parts) = reasoning_obj.get("content").and_then(Value::as_array) {
            for part in parts {
                if let Some(text) = read_text_from_content_part(part) {
                    segments.push(text);
                }
            }
        }
    }
    segments
}

fn normalize_qwen_marker_tokens(raw: &str) -> String {
    let mut text = raw.replace("<|\n", "<|");
    text = text.replace("<|\r\n", "<|");
    text = text.replace("\n|>", "|>");
    text = text.replace("\r\n|>", "|>");
    if let Ok(re) = Regex::new(r"<\|\s+") {
        text = re.replace_all(&text, "<|").to_string();
    }
    if let Ok(re) = Regex::new(r"\s+\|>") {
        text = re.replace_all(&text, "|>").to_string();
    }
    if let Ok(re) = Regex::new(r"(?i)tool_call_begin\s*\|>") {
        text = re.replace_all(&text, "tool_call_begin|>").to_string();
    }
    if let Ok(re) = Regex::new(r"(?i)tool_call_end\s*\|>") {
        text = re.replace_all(&text, "tool_call_end|>").to_string();
    }
    if let Ok(re) = Regex::new(r"(?i)tool_calls_section_begin\s*\|>") {
        text = re.replace_all(&text, "tool_calls_section_begin|>").to_string();
    }
    if let Ok(re) = Regex::new(r"(?i)tool_calls_section_end\s*\|>") {
        text = re.replace_all(&text, "tool_calls_section_end|>").to_string();
    }
    if let Ok(re) = Regex::new(r"(?i)tool_call_argument_begin\s*\|>") {
        text = re.replace_all(&text, "tool_call_argument_begin|>").to_string();
    }
    text
}

fn strip_qwen_markers_from_text(raw: &str) -> String {
    let normalized = normalize_qwen_marker_tokens(raw);
    let mut text = normalized;
    let patterns = [
        r"(?is)<\|tool_calls_section_begin\|>[\s\S]*?<\|tool_calls_section_end\|>",
        r"(?is)<\|tool_call_begin\|>[\s\S]*?<\|tool_call_end\|>",
    ];
    for pattern in patterns {
        if let Ok(re) = Regex::new(pattern) {
            text = re.replace_all(&text, "").to_string();
        }
    }
    text.trim().to_string()
}

fn repair_json_newlines_inside_strings(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    let mut in_string = false;
    let mut escape = false;
    for ch in raw.chars() {
        if in_string {
            if escape {
                out.push(ch);
                escape = false;
                continue;
            }
            match ch {
                '\\' => {
                    out.push(ch);
                    escape = true;
                }
                '"' => {
                    out.push(ch);
                    in_string = false;
                }
                '\n' => out.push_str("\\n"),
                '\r' => {}
                _ => out.push(ch),
            }
        } else {
            if ch == '"' {
                in_string = true;
            }
            out.push(ch);
        }
    }
    out
}

fn parse_qwen_marker_tool_calls_from_text(raw: &str) -> Vec<Value> {
    let normalized = normalize_qwen_marker_tokens(raw);
    let Ok(call_re) = Regex::new(
        r"(?is)<\|tool_call_begin\|>\s*(?:functions\.)?([A-Za-z0-9_.-]+)(?::([0-9A-Za-z_-]+))?\s*<\|tool_call_argument_begin\|>\s*([\s\S]*?)\s*<\|tool_call_end\|>",
    ) else {
        return Vec::new();
    };
    let mut out: Vec<Value> = Vec::new();
    let now_ms = chrono::Utc::now().timestamp_millis();
    for (index, caps) in call_re.captures_iter(&normalized).enumerate() {
        let Some(name) = caps.get(1).map(|m| m.as_str().trim()).filter(|v| !v.is_empty()) else {
            continue;
        };
        let args_raw = caps.get(3).map(|m| m.as_str().trim()).unwrap_or("{}");
        let repaired = repair_json_newlines_inside_strings(args_raw);
        let arguments = match serde_json::from_str::<Value>(&repaired) {
            Ok(Value::Object(_)) | Ok(Value::Array(_)) => repaired,
            Ok(other) => serde_json::to_string(&other).unwrap_or_else(|_| "{}".to_string()),
            Err(_) => continue,
        };
        let call_id = caps
            .get(2)
            .map(|m| m.as_str().trim())
            .filter(|v| !v.is_empty())
            .map(|v| format!("call_{}", v))
            .unwrap_or_else(|| format!("call_{}_{}", now_ms, index));
        out.push(json!({
            "id": call_id,
            "type": "function",
            "function": {
                "name": name,
                "arguments": arguments
            }
        }));
    }
    out
}

fn harvest_qwen_marker_tool_calls(message_obj: &Map<String, Value>) -> Vec<Value> {
    let mut out: Vec<Value> = Vec::new();
    for segment in collect_message_text_segments(message_obj) {
        for call in parse_qwen_marker_tool_calls_from_text(&segment) {
            out.push(call);
        }
    }
    out
}

fn pick_qwen_message_content(message_obj: &Map<String, Value>, harvested_tool_calls: &[Value]) -> String {
    let Some(content) = message_obj.get("content") else {
        return String::new();
    };
    match content {
        Value::String(raw) => {
            if harvested_tool_calls.is_empty() {
                raw.to_string()
            } else {
                strip_qwen_markers_from_text(raw)
            }
        }
        Value::Array(parts) => {
            let mut texts: Vec<String> = Vec::new();
            for part in parts {
                if let Some(text) = read_text_from_content_part(part) {
                    let next = if harvested_tool_calls.is_empty() { text } else { strip_qwen_markers_from_text(&text) };
                    if !next.trim().is_empty() {
                        texts.push(next.trim().to_string());
                    }
                }
            }
            texts.join("\n")
        }
        _ => String::new(),
    }
}

fn pick_qwen_reasoning_content(message_obj: &Map<String, Value>, harvested_tool_calls: &[Value]) -> Option<String> {
    let direct = message_obj
        .get("reasoning_content")
        .and_then(Value::as_str)
        .or_else(|| message_obj.get("reasoning").and_then(Value::as_str))
        .map(|v| v.to_string());
    let from_reasoning_content = if let Some(raw) = direct {
        let next = if harvested_tool_calls.is_empty() { raw } else { strip_qwen_markers_from_text(&raw) };
        let trimmed = next.trim();
        if trimmed.is_empty() { None } else { Some(trimmed.to_string()) }
    } else {
        None
    };
    if from_reasoning_content.is_some() {
        return from_reasoning_content;
    }
    let Some(reasoning_obj) = message_obj.get("reasoning").and_then(Value::as_object) else {
        return None;
    };
    let Some(parts) = reasoning_obj.get("content").and_then(Value::as_array) else {
        return None;
    };
    let mut texts: Vec<String> = Vec::new();
    for part in parts {
        if let Some(text) = read_text_from_content_part(part) {
            let next = if harvested_tool_calls.is_empty() { text } else { strip_qwen_markers_from_text(&text) };
            let trimmed = next.trim();
            if !trimmed.is_empty() {
                texts.push(trimmed.to_string());
            }
        }
    }
    if texts.is_empty() { None } else { Some(texts.join("\n")) }
}

fn transform_qwen_choices(raw_choices: Option<&Value>) -> Vec<Value> {
    let Some(choices) = raw_choices.and_then(|v| v.as_array()) else {
        return Vec::new();
    };
    choices
        .iter()
        .enumerate()
        .map(|(index, raw_choice)| {
            let choice_obj = raw_choice.as_object().cloned().unwrap_or_default();
            let message_obj = choice_obj
                .get("message")
                .and_then(|v| v.as_object())
                .cloned()
                .unwrap_or_default();
            let index_value = number_or_default(choice_obj.get("index"), index as i64);
            let role = message_obj
                .get("role")
                .and_then(|v| v.as_str())
                .unwrap_or("assistant")
                .to_string();
            let mut tool_calls = transform_qwen_tool_calls(message_obj.get("tool_calls"));
            if tool_calls.is_empty() {
                tool_calls = harvest_qwen_marker_tool_calls(&message_obj);
            }
            let content = pick_qwen_message_content(&message_obj, &tool_calls);
            let reasoning = pick_qwen_reasoning_content(&message_obj, &tool_calls);
            let finish_reason = if !tool_calls.is_empty() {
                "tool_calls".to_string()
            } else {
                transform_qwen_finish_reason(
                    choice_obj.get("finish_reason").and_then(|v| v.as_str()),
                )
            };

            let mut message = Map::new();
            message.insert("role".to_string(), Value::String(role));
            message.insert("content".to_string(), Value::String(content));
            message.insert("tool_calls".to_string(), Value::Array(tool_calls));
            if let Some(reasoning) = reasoning {
                message.insert("reasoning_content".to_string(), Value::String(reasoning));
            }

            let mut out = Map::new();
            out.insert("index".to_string(), index_value);
            out.insert("message".to_string(), Value::Object(message));
            out.insert("finish_reason".to_string(), Value::String(finish_reason));
            Value::Object(out)
        })
        .collect::<Vec<Value>>()
}

pub(crate) fn apply_qwen_response_compat(payload: Value) -> Value {
    let response_obj = payload.as_object().cloned().unwrap_or_default();
    let data_obj = response_obj
        .get("data")
        .and_then(|v| v.as_object())
        .cloned()
        .unwrap_or(response_obj);
    let usage = data_obj
        .get("usage")
        .and_then(|v| v.as_object())
        .cloned()
        .map(Value::Object)
        .unwrap_or_else(|| {
            let mut usage_obj = Map::new();
            usage_obj.insert("prompt_tokens".to_string(), Value::Number(Number::from(0)));
            usage_obj.insert(
                "completion_tokens".to_string(),
                Value::Number(Number::from(0)),
            );
            usage_obj.insert("total_tokens".to_string(), Value::Number(Number::from(0)));
            Value::Object(usage_obj)
        });
    let now_ms = chrono::Utc::now().timestamp_millis();
    let now_s = chrono::Utc::now().timestamp();
    let id = data_obj
        .get("id")
        .and_then(|v| v.as_str())
        .map(|v| v.to_string())
        .unwrap_or_else(|| format!("chatcmpl-{}", now_ms));
    let model = data_obj
        .get("model")
        .and_then(|v| v.as_str())
        .map(|v| v.to_string())
        .unwrap_or_else(|| "qwen-turbo".to_string());
    let created = number_or_default(data_obj.get("created"), now_s);
    let choices = transform_qwen_choices(data_obj.get("choices"));

    let mut transformed = Map::new();
    transformed.insert("id".to_string(), Value::String(id));
    transformed.insert(
        "object".to_string(),
        Value::String("chat.completion".to_string()),
    );
    transformed.insert("created".to_string(), created);
    transformed.insert("model".to_string(), Value::String(model));
    transformed.insert("choices".to_string(), Value::Array(choices));
    transformed.insert("usage".to_string(), usage);
    transformed.insert("_transformed".to_string(), Value::Bool(true));
    transformed.insert(
        "_originalFormat".to_string(),
        Value::String("qwen".to_string()),
    );
    transformed.insert(
        "_targetFormat".to_string(),
        Value::String("openai".to_string()),
    );
    Value::Object(transformed)
}
