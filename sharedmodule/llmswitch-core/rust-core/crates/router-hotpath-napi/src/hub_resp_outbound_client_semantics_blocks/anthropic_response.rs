use serde_json::{Map, Value};
use std::collections::HashMap;
use std::time::{SystemTime, UNIX_EPOCH};

use crate::hub_reasoning_tool_normalizer::{
    collect_reasoning_content_segments, collect_reasoning_summary_segments,
    normalize_message_reasoning_ssot,
};
use crate::shared_tool_mapping::normalize_anthropic_tool_name;
use crate::shared_tool_result_text_normalizer::normalize_tool_result_text;

fn now_unix_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

fn flatten_anthropic_content(content: &Value) -> String {
    if let Some(raw) = content.as_str() {
        return raw.to_string();
    }
    if let Some(parts) = content.as_array() {
        let mut out = String::new();
        for part in parts {
            let text = flatten_anthropic_content(part);
            if !text.is_empty() {
                out.push_str(text.as_str());
            }
        }
        return out;
    }
    if let Some(row) = content.as_object() {
        if let Some(text) = row.get("text").and_then(|v| v.as_str()) {
            return text.to_string();
        }
        if let Some(text) = row.get("content").and_then(|v| v.as_str()) {
            return text.to_string();
        }
        if let Some(parts) = row.get("content").and_then(|v| v.as_array()) {
            let mut out = String::new();
            for part in parts {
                let text = flatten_anthropic_content(part);
                if !text.is_empty() {
                    out.push_str(text.as_str());
                }
            }
            return out;
        }
    }
    String::new()
}

fn sanitize_anthropic_tool_use_id(raw: Option<&Value>, index: usize) -> String {
    if let Some(raw) = raw.and_then(|v| v.as_str()) {
        let trimmed = raw.trim();
        if !trimmed.is_empty()
            && trimmed
                .chars()
                .all(|ch| ch.is_ascii_alphanumeric() || ch == '_' || ch == '-')
        {
            return trimmed.to_string();
        }
    }
    format!("call_{}_{}", now_unix_millis(), index)
}

fn coerce_non_negative_number(candidates: &[Option<&Value>]) -> Option<u64> {
    for candidate in candidates {
        let Some(value) = candidate else {
            continue;
        };
        if let Some(number) = value.as_f64() {
            if number.is_finite() && number >= 0.0 {
                return Some(number.floor() as u64);
            }
        }
        if let Some(raw) = value.as_str() {
            let trimmed = raw.trim();
            if trimmed.is_empty() {
                continue;
            }
            if let Ok(parsed) = trimmed.parse::<f64>() {
                if parsed.is_finite() && parsed >= 0.0 {
                    return Some(parsed.floor() as u64);
                }
            }
        }
    }
    None
}

fn map_shell_command_args_for_anthropic(raw: &Value) -> Value {
    let mut result = Map::new();
    let source = raw.as_object().cloned().unwrap_or_default();

    let coerce_command = |value: Option<&Value>| -> String {
        let Some(value) = value else {
            return String::new();
        };
        if let Some(raw) = value.as_str() {
            let trimmed = raw.trim();
            if !trimmed.is_empty() {
                return trimmed.to_string();
            }
        }
        if let Some(parts) = value.as_array() {
            let joined = parts
                .iter()
                .filter_map(|entry| entry.as_str().map(|v| v.trim().to_string()))
                .filter(|v| !v.is_empty())
                .collect::<Vec<String>>()
                .join(" ");
            if !joined.is_empty() {
                return joined;
            }
        }
        String::new()
    };

    let command_raw = {
        let from_command = coerce_command(source.get("command"));
        if !from_command.is_empty() {
            from_command
        } else {
            coerce_command(source.get("cmd"))
        }
    };
    let command = command_raw.trim().to_string();
    if !command.is_empty() {
        result.insert("command".to_string(), Value::String(command));
    }

    let timeout_raw = source.get("timeout_ms").or_else(|| source.get("timeout"));
    if let Some(timeout_raw) = timeout_raw {
        if let Some(number) = timeout_raw.as_f64() {
            if number.is_finite() {
                result.insert("timeout".to_string(), Value::from(number));
            }
        } else if let Some(raw) = timeout_raw.as_str() {
            let trimmed = raw.trim();
            if !trimmed.is_empty() {
                if let Ok(parsed) = trimmed.parse::<f64>() {
                    if parsed.is_finite() {
                        result.insert("timeout".to_string(), Value::from(parsed));
                    }
                }
            }
        }
    }

    if let Some(description) = source.get("description").and_then(|v| v.as_str()) {
        let trimmed = description.trim();
        if !trimmed.is_empty() {
            result.insert(
                "description".to_string(),
                Value::String(description.to_string()),
            );
        }
    }
    if let Some(flag) = source.get("run_in_background").and_then(|v| v.as_bool()) {
        result.insert("run_in_background".to_string(), Value::Bool(flag));
    }
    if let Some(flag) = source
        .get("dangerouslyDisableSandbox")
        .and_then(|v| v.as_bool())
    {
        result.insert("dangerouslyDisableSandbox".to_string(), Value::Bool(flag));
    }

    Value::Object(result)
}

fn create_tool_alias_serializer(alias_map: Option<&Value>) -> HashMap<String, String> {
    let Some(alias_map) = alias_map.and_then(|v| v.as_object()) else {
        return HashMap::new();
    };
    let mut out: HashMap<String, String> = HashMap::new();
    for (canonical, provider_name) in alias_map {
        let canonical_key = canonical.trim().to_ascii_lowercase();
        let Some(provider_name) = provider_name.as_str() else {
            continue;
        };
        if canonical_key.is_empty() {
            continue;
        }
        if !out.contains_key(canonical_key.as_str()) {
            out.insert(canonical_key, provider_name.to_string());
        }
    }
    out
}

fn serialize_tool_name(alias_lookup: &HashMap<String, String>, canonical_name: &str) -> String {
    let trimmed = canonical_name.trim();
    if trimmed.is_empty() {
        return canonical_name.to_string();
    }
    let key = trimmed.to_ascii_lowercase();
    alias_lookup
        .get(key.as_str())
        .cloned()
        .unwrap_or_else(|| canonical_name.to_string())
}

fn normalize_tool_result_entry(entry: &Value) -> Option<Map<String, Value>> {
    let row = entry.as_object()?;
    let raw_id = row
        .get("tool_call_id")
        .or_else(|| row.get("call_id"))
        .or_else(|| row.get("id"))?;
    let tool_use_id = raw_id.as_str()?.trim().to_string();
    if tool_use_id.is_empty() {
        return None;
    }
    let raw_content = if row.contains_key("content") {
        row.get("content")
    } else {
        row.get("output")
    };
    let content = match raw_content {
        None | Some(Value::Null) => None,
        Some(Value::String(raw)) => Some(normalize_tool_result_text(raw)),
        Some(other) => serde_json::to_string(other)
            .ok()
            .map(|text| normalize_tool_result_text(text.as_str()))
            .or_else(|| Some(other.to_string())),
    };
    let is_error = row.get("is_error").and_then(|v| v.as_bool());

    let mut out = Map::new();
    out.insert("tool_use_id".to_string(), Value::String(tool_use_id));
    if let Some(content) = content {
        out.insert("content".to_string(), Value::String(content));
    }
    if let Some(is_error) = is_error {
        out.insert("is_error".to_string(), Value::Bool(is_error));
    }
    Some(out)
}

fn extract_tool_result_blocks(chat_response: &Value) -> Vec<Map<String, Value>> {
    let mut results: Vec<Map<String, Value>> = Vec::new();
    let mut seen = std::collections::HashSet::<String>::new();
    let mut append_entry = |entry: &Value| {
        if let Some(candidate) = normalize_tool_result_entry(entry) {
            if let Some(tool_use_id) = candidate.get("tool_use_id").and_then(|v| v.as_str()) {
                if seen.contains(tool_use_id) {
                    return;
                }
                seen.insert(tool_use_id.to_string());
            }
            results.push(candidate);
        }
    };

    let chat_row = match chat_response.as_object() {
        Some(v) => v,
        None => return results,
    };
    if let Some(primary) = chat_row.get("tool_outputs").and_then(|v| v.as_array()) {
        for entry in primary {
            append_entry(entry);
        }
    }

    if let Some(meta_captured) = chat_row
        .get("metadata")
        .and_then(|v| v.as_object())
        .and_then(|v| v.get("capturedToolResults"))
        .and_then(|v| v.as_array())
    {
        for entry in meta_captured {
            append_entry(entry);
        }
    }

    let choice_captured = chat_row
        .get("choices")
        .and_then(|v| v.as_array())
        .and_then(|choices| choices.first())
        .and_then(|choice| choice.as_object())
        .and_then(|choice| choice.get("message"))
        .and_then(|message| message.as_object())
        .and_then(|message| message.get("capturedToolResults"))
        .and_then(|v| v.as_array());
    if let Some(choice_captured) = choice_captured {
        for entry in choice_captured {
            append_entry(entry);
        }
    }

    results
}

fn sanitize_content_block(block: &Value, index: usize) -> Option<Value> {
    let row = block.as_object()?;
    let block_type = row
        .get("type")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    if block_type == "text" {
        let text = row.get("text")?.as_str()?.to_string();
        return Some(Value::Object(Map::from_iter([
            ("type".to_string(), Value::String("text".to_string())),
            ("text".to_string(), Value::String(text)),
        ])));
    }
    if block_type == "thinking" || block_type == "reasoning" {
        let text = row
            .get("text")
            .and_then(|v| v.as_str().map(|s| s.to_string()))
            .unwrap_or_else(|| {
                row.get("content")
                    .map(flatten_anthropic_content)
                    .unwrap_or_default()
            });
        if text.trim().is_empty() {
            return None;
        }
        return Some(Value::Object(Map::from_iter([
            (
                "type".to_string(),
                Value::String(if block_type == "reasoning" {
                    "reasoning".to_string()
                } else {
                    "thinking".to_string()
                }),
            ),
            ("text".to_string(), Value::String(text)),
        ])));
    }
    if block_type == "tool_use" {
        let name = row
            .get("name")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        if name.is_empty() {
            return None;
        }
        let id = sanitize_anthropic_tool_use_id(row.get("id"), index);
        let input = row
            .get("input")
            .cloned()
            .unwrap_or_else(|| Value::Object(Map::new()));
        return Some(Value::Object(Map::from_iter([
            ("type".to_string(), Value::String("tool_use".to_string())),
            ("id".to_string(), Value::String(id)),
            ("name".to_string(), Value::String(name)),
            ("input".to_string(), input),
        ])));
    }
    if block_type == "tool_result" {
        let tool_use_id = row
            .get("tool_use_id")
            .and_then(|v| v.as_str())
            .map(|v| v.trim().to_string())
            .unwrap_or_default();
        if tool_use_id.is_empty() {
            return None;
        }
        let mut out = Map::new();
        out.insert("type".to_string(), Value::String("tool_result".to_string()));
        out.insert("tool_use_id".to_string(), Value::String(tool_use_id));
        out.insert(
            "content".to_string(),
            row.get("content")
                .cloned()
                .unwrap_or_else(|| Value::String(String::new())),
        );
        if let Some(is_error) = row.get("is_error").and_then(|v| v.as_bool()) {
            out.insert("is_error".to_string(), Value::Bool(is_error));
        }
        return Some(Value::Object(out));
    }
    None
}

fn normalize_anthropic_usage_object(usage: &Map<String, Value>) -> Value {
    let mut normalized = usage.clone();
    let input_tokens =
        coerce_non_negative_number(&[usage.get("input_tokens"), usage.get("prompt_tokens")]);
    let output_tokens =
        coerce_non_negative_number(&[usage.get("output_tokens"), usage.get("completion_tokens")]);
    if let Some(input_tokens) = input_tokens {
        normalized.insert("input_tokens".to_string(), Value::from(input_tokens));
    }
    if let Some(output_tokens) = output_tokens {
        normalized.insert("output_tokens".to_string(), Value::from(output_tokens));
    }
    Value::Object(normalized)
}

fn sanitize_anthropic_message(message: &Value) -> Value {
    let row = match message.as_object() {
        Some(v) => v,
        None => return Value::Object(Map::new()),
    };
    let mut sanitized = Map::new();
    for key in [
        "id",
        "type",
        "role",
        "content",
        "model",
        "stop_reason",
        "stop_sequence",
        "usage",
    ] {
        if let Some(value) = row.get(key) {
            sanitized.insert(key.to_string(), value.clone());
        }
    }
    let content = row
        .get("content")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let sanitized_content = content
        .iter()
        .enumerate()
        .filter_map(|(index, block)| sanitize_content_block(block, index))
        .collect::<Vec<Value>>();
    sanitized.insert("content".to_string(), Value::Array(sanitized_content));

    if let Some(usage) = row.get("usage").and_then(|v| v.as_object()) {
        sanitized.insert("usage".to_string(), normalize_anthropic_usage_object(usage));
    }
    Value::Object(sanitized)
}

fn build_anthropic_response_from_chat_core(
    chat_response: &Value,
    alias_map: Option<&Value>,
) -> Value {
    let chat_row = match chat_response.as_object() {
        Some(v) => v,
        None => return Value::Object(Map::new()),
    };

    let choice = chat_row
        .get("choices")
        .and_then(|v| v.as_array())
        .and_then(|choices| choices.first())
        .and_then(|choice| choice.as_object());
    let mut message = choice
        .and_then(|choice| choice.get("message"))
        .and_then(|v| v.as_object());
    let mut normalized_message = message.cloned().unwrap_or_default();
    normalize_message_reasoning_ssot(&mut normalized_message);
    message = Some(&normalized_message);

    let text = message
        .and_then(|message| message.get("content"))
        .map(flatten_anthropic_content)
        .unwrap_or_default();
    let tool_calls = message
        .and_then(|message| message.get("tool_calls"))
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let mut content_blocks: Vec<Value> = Vec::new();

    let reasoning_blocks =
        collect_reasoning_content_segments(message.and_then(|message| message.get("reasoning")));
    let fallback_reasoning_blocks = if reasoning_blocks.is_empty() {
        collect_reasoning_summary_segments(message.and_then(|message| message.get("reasoning")))
    } else {
        Vec::new()
    };
    let reasoning_texts = if !reasoning_blocks.is_empty() {
        reasoning_blocks
    } else {
        fallback_reasoning_blocks
    };
    for reasoning_text in reasoning_texts {
        content_blocks.push(Value::Object(Map::from_iter([
            ("type".to_string(), Value::String("thinking".to_string())),
            ("text".to_string(), Value::String(reasoning_text)),
        ])));
    }
    if !text.trim().is_empty() {
        content_blocks.push(Value::Object(Map::from_iter([
            ("type".to_string(), Value::String("text".to_string())),
            ("text".to_string(), Value::String(text)),
        ])));
    }

    let alias_lookup = create_tool_alias_serializer(alias_map);
    for (index, call) in tool_calls.iter().enumerate() {
        let Some(call_row) = call.as_object() else {
            continue;
        };
        let Some(fn_row) = call_row.get("function").and_then(|v| v.as_object()) else {
            continue;
        };
        let Some(fn_name) = fn_row.get("name").and_then(|v| v.as_str()) else {
            continue;
        };
        let canonical_name =
            normalize_anthropic_tool_name(fn_name).unwrap_or_else(|| fn_name.to_string());
        let serialized_name = serialize_tool_name(&alias_lookup, canonical_name.as_str());

        let args = fn_row
            .get("arguments")
            .cloned()
            .unwrap_or_else(|| Value::Object(Map::new()));
        let mut parsed_args = if let Some(raw) = args.as_str() {
            serde_json::from_str::<Value>(raw).unwrap_or_else(|_| {
                Value::Object(Map::from_iter([(
                    "_raw".to_string(),
                    Value::String(raw.to_string()),
                )]))
            })
        } else {
            args
        };
        if canonical_name.trim() == "shell_command" {
            parsed_args = map_shell_command_args_for_anthropic(&parsed_args);
        }

        content_blocks.push(Value::Object(Map::from_iter([
            ("type".to_string(), Value::String("tool_use".to_string())),
            (
                "id".to_string(),
                Value::String(sanitize_anthropic_tool_use_id(call_row.get("id"), index)),
            ),
            ("name".to_string(), Value::String(serialized_name)),
            ("input".to_string(), parsed_args),
        ])));
    }

    for tool_result in extract_tool_result_blocks(chat_response) {
        let mut sanitized = Map::new();
        sanitized.insert("type".to_string(), Value::String("tool_result".to_string()));
        sanitized.insert(
            "tool_use_id".to_string(),
            tool_result
                .get("tool_use_id")
                .cloned()
                .unwrap_or_else(|| Value::String(String::new())),
        );
        sanitized.insert(
            "content".to_string(),
            tool_result
                .get("content")
                .cloned()
                .unwrap_or_else(|| Value::String(String::new())),
        );
        if let Some(is_error) = tool_result.get("is_error").and_then(|v| v.as_bool()) {
            sanitized.insert("is_error".to_string(), Value::Bool(is_error));
        }
        content_blocks.push(Value::Object(sanitized));
    }

    let usage = chat_row.get("usage").and_then(|v| v.as_object());
    let stop_reason = choice
        .and_then(|choice| choice.get("finish_reason"))
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let stop_reason_mapped = match stop_reason {
        "tool_calls" => "tool_use",
        "length" => "max_tokens",
        "content_filter" => "stop_sequence",
        _ => "end_turn",
    };

    let canonical_id = chat_row
        .get("request_id")
        .and_then(|v| v.as_str())
        .map(|v| v.to_string())
        .or_else(|| {
            chat_row
                .get("id")
                .and_then(|v| v.as_str())
                .map(|v| v.to_string())
        })
        .unwrap_or_else(|| format!("resp_{}", now_unix_millis()));

    let mut raw = Map::new();
    raw.insert("id".to_string(), Value::String(canonical_id));
    raw.insert("type".to_string(), Value::String("message".to_string()));
    raw.insert("role".to_string(), Value::String("assistant".to_string()));
    raw.insert("content".to_string(), Value::Array(content_blocks));
    raw.insert(
        "model".to_string(),
        Value::String(
            chat_row
                .get("model")
                .and_then(|v| v.as_str())
                .unwrap_or("unknown")
                .to_string(),
        ),
    );
    raw.insert(
        "stop_reason".to_string(),
        Value::String(stop_reason_mapped.to_string()),
    );
    if let Some(usage) = usage {
        raw.insert("usage".to_string(), normalize_anthropic_usage_object(usage));
    }
    sanitize_anthropic_message(&Value::Object(raw))
}

pub(crate) fn build_anthropic_response_from_chat_value(
    chat_response: &Value,
    alias_map: Option<&Value>,
) -> Value {
    build_anthropic_response_from_chat_core(chat_response, alias_map)
}
