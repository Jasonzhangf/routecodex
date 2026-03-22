use crate::hub_bridge_actions::utils::normalize_function_call_id;
use crate::hub_reasoning_tool_normalizer::{
    extract_tool_calls_from_reasoning_text_json, normalize_assistant_text_to_tool_calls_json,
};
use napi::bindgen_prelude::Result as NapiResult;
use regex::Regex;
use serde_json::{Map, Value};

fn read_trimmed_non_empty_string(value: Option<&Value>) -> Option<String> {
    let text = value.and_then(Value::as_str)?.trim();
    if text.is_empty() {
        return None;
    }
    Some(text.to_string())
}

fn extract_responses_message_text(item: &Map<String, Value>) -> String {
    let mut parts: Vec<String> = Vec::new();
    if let Some(Value::Array(content)) = item.get("content") {
        for part in content {
            let Some(part_obj) = part.as_object() else {
                continue;
            };
            let text = read_trimmed_non_empty_string(part_obj.get("text"))
                .or_else(|| read_trimmed_non_empty_string(part_obj.get("content")))
                .or_else(|| read_trimmed_non_empty_string(part_obj.get("value")));
            if let Some(text) = text {
                parts.push(text);
            }
        }
    }
    if let Some(text) = read_trimmed_non_empty_string(item.get("output_text")) {
        parts.push(text);
    }
    parts.join("\n").trim().to_string()
}

fn normalize_assistant_message(
    message: &Value,
    options_json: Option<&String>,
) -> Option<Value> {
    let message_json = serde_json::to_string(message).ok()?;
    let normalized_json =
        normalize_assistant_text_to_tool_calls_json(message_json, options_json.cloned()).ok()?;
    let mut normalized = serde_json::from_str::<Value>(&normalized_json).ok()?;
    consume_harvested_reasoning_text(&mut normalized, message);
    Some(normalized)
}

fn strip_reasoning_transport_noise(raw: &str) -> String {
    let line_re = Regex::new(r"(?im)^\[(?:Time/Date)\]:.*$").unwrap();
    let open_re = Regex::new(r"(?i)^\s*\[(?:思考|thinking)\]\s*").unwrap();
    let close_re = Regex::new(r"(?i)\s*\[/(?:思考|thinking)\]\s*$").unwrap();
    let multi_newline_re = Regex::new(r"\n{3,}").unwrap();

    let stripped = line_re.replace_all(raw, "").to_string();
    let stripped = open_re.replace(&stripped, "").to_string();
    let stripped = close_re.replace(&stripped, "").to_string();
    multi_newline_re
        .replace_all(&stripped, "\n\n")
        .trim()
        .to_string()
}

fn prepare_reasoning_text_for_harvest(raw: &str) -> String {
    let stripped = strip_reasoning_transport_noise(raw);
    if stripped.is_empty() {
        return String::new();
    }
    let lower = stripped.to_ascii_lowercase();
    let has_tool_call_open = lower.contains("<tool_call");
    let has_tool_call_close = lower.contains("</tool_call>");
    if !has_tool_call_open
        && has_tool_call_close
        && has_bare_tool_call_prefix(stripped.as_str())
    {
        return format!("<tool_call>{}", stripped);
    }
    stripped
}

fn has_bare_tool_call_prefix(raw: &str) -> bool {
    let trimmed = raw.trim_start();
    if trimmed.is_empty() {
        return false;
    }
    let mut end = 0usize;
    for (index, ch) in trimmed.char_indices() {
        if ch.is_ascii_alphanumeric() || ch == '_' || ch == '.' || ch == '-' {
            end = index + ch.len_utf8();
        } else {
            break;
        }
    }
    if end == 0 {
        return false;
    }
    let rest = trimmed[end..].trim_start();
    rest.starts_with("<arg_key>")
        || rest.starts_with("<arg_value>")
        || rest.starts_with("<argument")
        || rest.starts_with("<parameter")
}

fn consume_harvested_reasoning_text(normalized: &mut Value, original: &Value) {
    const REASONING_KEYS: [&str; 3] = ["reasoning_content", "reasoning", "reasoningContent"];
    let Some(target) = normalized.as_object_mut() else {
        return;
    };
    let source_obj = original.as_object();

    for key in REASONING_KEYS {
        let source_text = read_trimmed_non_empty_string(target.get(key)).or_else(|| {
            source_obj
                .and_then(|obj| read_trimmed_non_empty_string(obj.get(key)))
        });
        let Some(source_text) = source_text else {
            continue;
        };

        let prepared = prepare_reasoning_text_for_harvest(source_text.as_str());
        if prepared.is_empty() {
            target.remove(key);
            continue;
        }

        let (cleaned_text, tool_calls) = harvest_reasoning_tool_calls(prepared.as_str());
        if tool_calls.is_empty() {
            continue;
        }
        if let Some(cleaned_text) = cleaned_text {
            target.insert(key.to_string(), Value::String(cleaned_text));
        } else {
            target.remove(key);
        }

        let has_tool_calls = target
            .get("tool_calls")
            .and_then(Value::as_array)
            .map(|arr| !arr.is_empty())
            .unwrap_or(false);
        if !has_tool_calls {
            target.insert("tool_calls".to_string(), Value::Array(tool_calls));
        }
    }
}

fn harvest_reasoning_tool_calls(prepared: &str) -> (Option<String>, Vec<Value>) {
    if let Ok(extracted_json) =
        extract_tool_calls_from_reasoning_text_json(prepared.to_string(), Some("reasoning".to_string()))
    {
        if let Ok(extracted) = serde_json::from_str::<Value>(&extracted_json) {
            let tool_calls = extracted
                .as_object()
                .and_then(|obj| obj.get("tool_calls"))
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            if !tool_calls.is_empty() {
                let cleaned_text = extracted
                    .as_object()
                    .and_then(|obj| obj.get("cleaned_text"))
                    .and_then(Value::as_str)
                    .map(|raw| raw.trim().to_string())
                    .filter(|raw| !raw.is_empty());
                return (cleaned_text, tool_calls);
            }
        }
    }

    let probe_message = serde_json::json!({
        "role": "assistant",
        "content": prepared
    });
    let probe_json = match serde_json::to_string(&probe_message) {
        Ok(raw) => raw,
        Err(_) => return (None, Vec::new()),
    };
    let normalized_probe_json = match normalize_assistant_text_to_tool_calls_json(probe_json, None) {
        Ok(raw) => raw,
        Err(_) => return (None, Vec::new()),
    };
    let normalized_probe: Value = match serde_json::from_str(&normalized_probe_json) {
        Ok(value) => value,
        Err(_) => return (None, Vec::new()),
    };
    let tool_calls = normalized_probe
        .as_object()
        .and_then(|obj| obj.get("tool_calls"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if tool_calls.is_empty() {
        return (None, Vec::new());
    }
    let cleaned_text = normalized_probe
        .as_object()
        .and_then(|obj| obj.get("content"))
        .and_then(Value::as_str)
        .map(|raw| raw.trim().to_string())
        .filter(|raw| !raw.is_empty());
    (cleaned_text, tool_calls)
}

fn has_tool_calls(message: &Value) -> bool {
    message
        .as_object()
        .and_then(|obj| obj.get("tool_calls"))
        .and_then(Value::as_array)
        .map(|arr| !arr.is_empty())
        .unwrap_or(false)
}

fn should_force_tool_calls_finish_reason(choice_obj: &Map<String, Value>) -> bool {
    let finish = choice_obj
        .get("finish_reason")
        .and_then(Value::as_str)
        .map(|raw| raw.trim().to_ascii_lowercase())
        .unwrap_or_default();
    finish.is_empty() || finish == "stop" || finish == "length"
}

fn harvest_chat_choices_in_place(root: &mut Map<String, Value>, options_json: Option<&String>) {
    let Some(Value::Array(choices)) = root.get_mut("choices") else {
        return;
    };
    for choice in choices.iter_mut() {
        let Some(choice_obj) = choice.as_object_mut() else {
            continue;
        };
        let message_original = choice_obj.get("message").cloned();
        let Some(message) = message_original else {
            continue;
        };
        if !message.is_object() {
            continue;
        }
        let Some(normalized) = normalize_assistant_message(&message, options_json) else {
            continue;
        };
        if normalized != message {
            choice_obj.insert("message".to_string(), normalized.clone());
        }
        if has_tool_calls(&normalized) && should_force_tool_calls_finish_reason(choice_obj) {
            choice_obj.insert(
                "finish_reason".to_string(),
                Value::String("tool_calls".to_string()),
            );
        }
    }
}

fn build_responses_function_calls_from_text(
    text: &str,
    options_json: Option<&String>,
    fallback_counter: &mut usize,
) -> Vec<Value> {
    let message = serde_json::json!({
        "role": "assistant",
        "content": text
    });
    let Some(normalized) = normalize_assistant_message(&message, options_json) else {
        return Vec::new();
    };
    let tool_calls = normalized
        .as_object()
        .and_then(|obj| obj.get("tool_calls"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if tool_calls.is_empty() {
        return Vec::new();
    }

    let mut out: Vec<Value> = Vec::new();
    for call in tool_calls {
        let Some(call_obj) = call.as_object() else {
            continue;
        };
        let fn_obj = call_obj.get("function").and_then(Value::as_object);
        let name = fn_obj
            .and_then(|row| read_trimmed_non_empty_string(row.get("name")))
            .unwrap_or_default();
        if name.is_empty() {
            continue;
        }
        let arguments = fn_obj
            .and_then(|row| row.get("arguments"))
            .and_then(Value::as_str)
            .unwrap_or("{}")
            .to_string();

        let call_id = read_trimmed_non_empty_string(call_obj.get("call_id"))
            .or_else(|| read_trimmed_non_empty_string(call_obj.get("id")))
            .unwrap_or_else(|| {
                *fallback_counter += 1;
                format!("call_auto_{}", fallback_counter)
            });
        let fallback_item_id = format!("fc_{}", call_id);
        let item_id = normalize_function_call_id(Some(call_id.as_str()), fallback_item_id.as_str());
        out.push(serde_json::json!({
            "type": "function_call",
            "id": item_id,
            "call_id": call_id,
            "name": name,
            "arguments": arguments
        }));
    }
    out
}

fn harvest_responses_output_in_place(root: &mut Map<String, Value>, options_json: Option<&String>) {
    let Some(Value::Array(output)) = root.get("output") else {
        return;
    };
    let mut next_output: Vec<Value> = Vec::new();
    let mut changed = false;
    let mut fallback_counter: usize = 0;

    for item in output {
        let Some(item_obj) = item.as_object() else {
            next_output.push(item.clone());
            continue;
        };
        let item_type = item_obj
            .get("type")
            .and_then(Value::as_str)
            .map(|raw| raw.trim().to_ascii_lowercase())
            .unwrap_or_default();
        let role = item_obj
            .get("role")
            .and_then(Value::as_str)
            .map(|raw| raw.trim().to_ascii_lowercase())
            .unwrap_or_default();
        if item_type != "message" || role != "assistant" {
            next_output.push(item.clone());
            continue;
        }

        let text = extract_responses_message_text(item_obj);
        if text.is_empty() {
            next_output.push(item.clone());
            continue;
        }

        let harvested =
            build_responses_function_calls_from_text(text.as_str(), options_json, &mut fallback_counter);
        if harvested.is_empty() {
            next_output.push(item.clone());
            continue;
        }
        changed = true;
        next_output.extend(harvested);
    }

    if changed {
        root.insert("output".to_string(), Value::Array(next_output));
    }
}

pub fn harvest_tool_calls_from_text_json(
    payload_json: String,
    options_json: Option<String>,
) -> NapiResult<String> {
    let mut payload: Value =
        serde_json::from_str(&payload_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    if !payload.is_object() {
        return serde_json::to_string(&payload)
            .map_err(|e| napi::Error::from_reason(e.to_string()));
    }
    let root = payload.as_object_mut().expect("object checked");

    let choices_len = root
        .get("choices")
        .and_then(Value::as_array)
        .map(|arr| arr.len())
        .unwrap_or(0);
    if choices_len > 0 {
        harvest_chat_choices_in_place(root, options_json.as_ref());
    } else {
        harvest_responses_output_in_place(root, options_json.as_ref());
    }

    serde_json::to_string(&payload).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_assistant_message_harvests_reasoning_prefix_payload() {
        let raw_reasoning = "[Time/Date]: utc=`2026-03-10T12:18:35.686Z`\nexec_command<arg_key>cmd</arg_key><arg_value>pwd</arg_value></tool_call>";
        let prepared = prepare_reasoning_text_for_harvest(raw_reasoning);
        assert!(prepared.starts_with("<tool_call>exec_command"));
        let (_, harvested) = harvest_reasoning_tool_calls(prepared.as_str());
        assert_eq!(harvested.len(), 1);

        let message = serde_json::json!({
            "role": "assistant",
            "reasoning_content": raw_reasoning
        });
        let normalized = normalize_assistant_message(&message, None).expect("normalized");
        let tool_calls = normalized
            .as_object()
            .and_then(|obj| obj.get("tool_calls"))
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        assert_eq!(tool_calls.len(), 1);
        assert_eq!(
            tool_calls[0]
                .as_object()
                .and_then(|obj| obj.get("function"))
                .and_then(Value::as_object)
                .and_then(|obj| obj.get("name"))
                .and_then(Value::as_str)
                .unwrap_or(""),
            "exec_command"
        );
    }
}
