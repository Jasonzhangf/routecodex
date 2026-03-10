use serde_json::{Map, Value};

fn responses_c4m_rate_limit_needle() -> &'static str {
    "The Codex-For.ME service is available, but you have reached the request limit"
}

fn value_contains_case_insensitive_needle(value: &Value, needle_lower: &str) -> bool {
    match value {
        Value::String(text) => text.to_ascii_lowercase().contains(needle_lower),
        Value::Array(entries) => entries
            .iter()
            .any(|entry| value_contains_case_insensitive_needle(entry, needle_lower)),
        Value::Object(row) => row
            .values()
            .any(|entry| value_contains_case_insensitive_needle(entry, needle_lower)),
        _ => false,
    }
}

pub(crate) fn detect_responses_c4m_rate_limit(payload: &Value) -> bool {
    let needle_lower = responses_c4m_rate_limit_needle().to_ascii_lowercase();
    value_contains_case_insensitive_needle(payload, &needle_lower)
}

fn read_non_empty_str(value: Option<&Value>) -> Option<String> {
    value
        .and_then(|v| v.as_str())
        .map(|raw| raw.trim())
        .filter(|trimmed| !trimmed.is_empty())
        .map(|trimmed| trimmed.to_string())
}

fn normalize_finish_reason(reason: &str) -> String {
    let normalized = reason.to_ascii_lowercase();
    if normalized.contains("tool") {
        return "tool_calls".to_string();
    }
    if normalized.contains("length")
        || normalized.contains("max_token")
        || normalized.contains("in_progress")
    {
        return "length".to_string();
    }
    if normalized.contains("filter") {
        return "content_filter".to_string();
    }
    "stop".to_string()
}

fn normalize_role(role: &str) -> String {
    let normalized = role.to_ascii_lowercase();
    match normalized.as_str() {
        "assistant" | "system" | "user" | "tool" => normalized,
        _ => "assistant".to_string(),
    }
}

fn coerce_text(value: &Value) -> String {
    match value {
        Value::String(v) => v.clone(),
        Value::Number(v) => v.to_string(),
        Value::Bool(v) => v.to_string(),
        Value::Array(entries) => entries.iter().map(coerce_text).collect::<Vec<_>>().join(""),
        Value::Object(_) => serde_json::to_string(value).unwrap_or_default(),
        _ => String::new(),
    }
}

fn normalize_tool_call(
    part: &Map<String, Value>,
    choice_index: usize,
    call_index: usize,
) -> Option<Value> {
    let payload = part
        .get("tool_call")
        .and_then(|v| v.as_object())
        .unwrap_or(part);
    let fn_payload = payload
        .get("function")
        .and_then(|v| v.as_object())
        .or_else(|| part.get("function").and_then(|v| v.as_object()));
    let name = fn_payload
        .and_then(|row| row.get("name"))
        .and_then(|v| v.as_str())
        .map(|raw| raw.trim())
        .filter(|trimmed| !trimmed.is_empty())?;

    let raw_args = fn_payload
        .and_then(|row| row.get("arguments"))
        .cloned()
        .unwrap_or_else(|| Value::Object(Map::new()));
    let arg_string = match raw_args {
        Value::String(text) => text,
        other => serde_json::to_string(&other).unwrap_or_else(|_| "{}".to_string()),
    };

    let id_candidate = read_non_empty_str(payload.get("id"))
        .or_else(|| read_non_empty_str(payload.get("tool_call_id")))
        .or_else(|| read_non_empty_str(payload.get("call_id")));
    let id = id_candidate.unwrap_or_else(|| format!("call_{}_{}", choice_index, call_index));

    let mut function_obj = Map::new();
    function_obj.insert("name".to_string(), Value::String(name.to_string()));
    function_obj.insert("arguments".to_string(), Value::String(arg_string));

    let mut tool_call = Map::new();
    tool_call.insert("id".to_string(), Value::String(id));
    tool_call.insert("type".to_string(), Value::String("function".to_string()));
    tool_call.insert("function".to_string(), Value::Object(function_obj));
    Some(Value::Object(tool_call))
}

fn build_message_from_output_entry(entry: &Map<String, Value>, choice_index: usize) -> Value {
    let role = normalize_role(
        entry
            .get("role")
            .and_then(|v| v.as_str())
            .unwrap_or("assistant"),
    );
    let mut text_segments: Vec<String> = Vec::new();
    let mut tool_calls: Vec<Value> = Vec::new();
    if let Some(content_array) = entry.get("content").and_then(|v| v.as_array()) {
        for part in content_array {
            let Some(part_obj) = part.as_object() else {
                let fallback = coerce_text(part);
                if !fallback.is_empty() {
                    text_segments.push(fallback);
                }
                continue;
            };
            let kind = part_obj
                .get("type")
                .and_then(|v| v.as_str())
                .or_else(|| part_obj.get("content_type").and_then(|v| v.as_str()))
                .unwrap_or("");
            match kind {
                "output_text" | "input_text" | "reasoning_content" => {
                    let txt = part_obj
                        .get("text")
                        .and_then(|v| v.as_str().map(|s| s.to_string()))
                        .unwrap_or_else(|| {
                            part_obj
                                .get("text")
                                .map(coerce_text)
                                .unwrap_or_else(String::new)
                        });
                    if !txt.is_empty() {
                        text_segments.push(txt);
                    }
                }
                "tool_call" => {
                    if let Some(tool_call) =
                        normalize_tool_call(part_obj, choice_index, tool_calls.len())
                    {
                        tool_calls.push(tool_call);
                    }
                }
                _ => {
                    let fallback = coerce_text(part);
                    if !fallback.is_empty() {
                        text_segments.push(fallback);
                    }
                }
            }
        }
    }

    let mut message = Map::new();
    message.insert("role".to_string(), Value::String(role));
    message.insert("content".to_string(), Value::String(text_segments.join("")));
    if !tool_calls.is_empty() {
        message.insert("tool_calls".to_string(), Value::Array(tool_calls));
    }
    Value::Object(message)
}

fn convert_output_entry_to_choice(
    entry: &Map<String, Value>,
    index: usize,
    root: &Map<String, Value>,
) -> Value {
    let message = build_message_from_output_entry(entry, index);
    let finish_reason_candidate = read_non_empty_str(entry.get("stop_reason"))
        .or_else(|| read_non_empty_str(entry.get("finish_reason")))
        .or_else(|| read_non_empty_str(entry.get("status")))
        .or_else(|| read_non_empty_str(root.get("status")))
        .unwrap_or_else(|| "stop".to_string());

    let has_tool_calls = message
        .as_object()
        .and_then(|obj| obj.get("tool_calls"))
        .and_then(|v| v.as_array())
        .map(|rows| !rows.is_empty())
        .unwrap_or(false);
    let finish_reason = if has_tool_calls {
        "tool_calls".to_string()
    } else {
        normalize_finish_reason(&finish_reason_candidate)
    };

    let mut choice = Map::new();
    choice.insert("index".to_string(), Value::from(index as i64));
    choice.insert("finish_reason".to_string(), Value::String(finish_reason));
    choice.insert("message".to_string(), message);
    Value::Object(choice)
}

fn build_choices_from_responses_output(root: &Map<String, Value>) -> Vec<Value> {
    let mut choices: Vec<Value> = Vec::new();
    let Some(output_entries) = root.get("output").and_then(|v| v.as_array()) else {
        return choices;
    };
    for entry in output_entries {
        let Some(entry_obj) = entry.as_object() else {
            continue;
        };
        if let Some(entry_type) = entry_obj.get("type").and_then(|v| v.as_str()) {
            if entry_type != "message" {
                continue;
            }
        }
        let choice = convert_output_entry_to_choice(entry_obj, choices.len(), root);
        choices.push(choice);
    }
    choices
}

pub(crate) fn convert_responses_output_to_choices(root: &mut Map<String, Value>) {
    if root
        .get("choices")
        .and_then(|v| v.as_array())
        .map(|rows| !rows.is_empty())
        .unwrap_or(false)
    {
        return;
    }

    let choices = build_choices_from_responses_output(root);
    if !choices.is_empty() {
        root.insert("choices".to_string(), Value::Array(choices));
        return;
    }

    let fallback_text = root
        .get("output_text")
        .and_then(|v| v.as_str())
        .map(|text| text.to_string())
        .filter(|text| !text.is_empty());
    if let Some(text) = fallback_text {
        let finish_reason = normalize_finish_reason(
            root.get("status")
                .and_then(|v| v.as_str())
                .unwrap_or("stop"),
        );
        let mut message = Map::new();
        message.insert("role".to_string(), Value::String("assistant".to_string()));
        message.insert("content".to_string(), Value::String(text));
        let mut choice = Map::new();
        choice.insert("index".to_string(), Value::from(0));
        choice.insert("finish_reason".to_string(), Value::String(finish_reason));
        choice.insert("message".to_string(), Value::Object(message));
        root.insert(
            "choices".to_string(),
            Value::Array(vec![Value::Object(choice)]),
        );
    }
}

pub(crate) fn ensure_response_request_id_fallback(
    root: &mut Map<String, Value>,
    request_id: Option<&String>,
) {
    if root
        .get("request_id")
        .and_then(|v| v.as_str())
        .map(|value| !value.trim().is_empty())
        .unwrap_or(false)
    {
        return;
    }
    let Some(request_id_value) = request_id else {
        return;
    };
    let trimmed = request_id_value.trim();
    if trimmed.is_empty() {
        return;
    }
    root.insert("request_id".to_string(), Value::String(trimmed.to_string()));
}
