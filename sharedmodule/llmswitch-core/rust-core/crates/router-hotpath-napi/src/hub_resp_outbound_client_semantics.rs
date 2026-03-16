use napi::bindgen_prelude::Result as NapiResult;
use napi_derive::napi;
use serde_json::{Map, Value};
use std::collections::{HashMap, HashSet};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::hub_reasoning_tool_normalizer::{
    build_message_reasoning_value, collect_reasoning_content_segments,
    collect_reasoning_summary_segments, normalize_message_reasoning_ssot,
};
use crate::shared_responses_tool_utils::strip_internal_tooling_metadata_impl;

fn normalize_alias_map(candidate: &Value) -> Option<Map<String, Value>> {
    let row = candidate.as_object()?;
    let mut out = Map::new();

    for (key, value) in row {
        let value_str = match value.as_str() {
            Some(v) => v.trim(),
            None => continue,
        };
        let key_str = key.trim();
        if key_str.is_empty() || value_str.is_empty() {
            continue;
        }
        out.insert(key_str.to_string(), Value::String(value_str.to_string()));
    }

    if out.is_empty() {
        return None;
    }
    Some(out)
}

fn resolve_client_tools_raw(candidate: &Value) -> Option<Vec<Value>> {
    let list = candidate.as_array()?;
    if list.is_empty() {
        return None;
    }

    let mut filtered: Vec<Value> = Vec::new();
    for entry in list {
        let row = match entry.as_object() {
            Some(v) => v,
            None => continue,
        };
        let raw_type = row.get("type").and_then(|v| v.as_str()).unwrap_or("");
        if raw_type.trim().is_empty() {
            continue;
        }
        filtered.push(Value::Object(row.clone()));
    }

    if filtered.is_empty() {
        return None;
    }
    Some(filtered)
}

fn normalize_anthropic_tool_name(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return None;
    }
    let lower = trimmed.to_ascii_lowercase();
    if lower.starts_with("mcp__") {
        return Some(lower);
    }
    Some(lower)
}

fn read_tool_name(entry: &Value) -> Option<String> {
    let obj = entry.as_object()?;
    let raw = obj.get("name")?.as_str()?.trim().to_string();
    if raw.is_empty() {
        return None;
    }
    Some(raw)
}

fn build_anthropic_tool_alias_map(raw_tools: &Value) -> Option<Map<String, Value>> {
    let rows = raw_tools.as_array()?;
    if rows.is_empty() {
        return None;
    }

    let mut alias_map: Map<String, Value> = Map::new();
    for entry in rows {
        let raw_name = match read_tool_name(entry) {
            Some(v) => v,
            None => continue,
        };
        let normalized =
            normalize_anthropic_tool_name(raw_name.as_str()).unwrap_or(raw_name.clone());
        let canonical_key = normalized.trim().to_string();
        if canonical_key.is_empty() {
            continue;
        }

        alias_map.insert(canonical_key.clone(), Value::String(raw_name.clone()));
        let lower_key = canonical_key.to_ascii_lowercase();
        if lower_key != canonical_key && !alias_map.contains_key(lower_key.as_str()) {
            alias_map.insert(lower_key, Value::String(raw_name));
        }
    }

    if alias_map.is_empty() {
        return None;
    }
    Some(alias_map)
}

fn read_tools_record_from_semantics(semantics: &Value) -> Option<Map<String, Value>> {
    let semantics_row = semantics.as_object()?;
    let tools_node = semantics_row.get("tools")?;
    let tools_row = tools_node.as_object()?;
    Some(tools_row.clone())
}

fn resolve_alias_map_from_resp_semantics(semantics: &Value) -> Option<Map<String, Value>> {
    let tools_record = read_tools_record_from_semantics(semantics)?;

    if let Some(tool_name_alias_map) = tools_record.get("toolNameAliasMap") {
        if let Some(from_candidate) = normalize_alias_map(tool_name_alias_map) {
            return Some(from_candidate);
        }
    }

    let raw_tools = tools_record.get("clientToolsRaw")?;
    let derived_alias = build_anthropic_tool_alias_map(raw_tools)?;
    normalize_alias_map(&Value::Object(derived_alias))
}

fn resolve_client_tools_raw_from_resp_semantics(semantics: &Value) -> Option<Vec<Value>> {
    let tools_record = read_tools_record_from_semantics(semantics)?;
    let raw_tools = tools_record.get("clientToolsRaw")?;
    resolve_client_tools_raw(raw_tools)
}

fn is_json_object(value: Option<&Value>) -> bool {
    matches!(value, Some(Value::Object(_)))
}

fn build_client_passthrough_patch(
    client_payload: &Value,
    source_payload: &Value,
) -> Map<String, Value> {
    let client_row = match client_payload.as_object() {
        Some(v) => v,
        None => return Map::new(),
    };
    let source_row = match source_payload.as_object() {
        Some(v) => v,
        None => return Map::new(),
    };

    let mut patch = Map::new();
    for key in [
        "metadata",
        "temperature",
        "top_p",
        "prompt_cache_key",
        "reasoning",
    ] {
        if client_row.contains_key(key) {
            continue;
        }
        if let Some(value) = source_row.get(key) {
            patch.insert(key.to_string(), value.clone());
        }
    }

    if is_json_object(source_row.get("error")) {
        if let Some(value) = source_row.get("error") {
            patch.insert("error".to_string(), value.clone());
        }
    }

    patch
}

fn apply_client_passthrough_patch(client_payload: &Value, source_payload: &Value) -> Value {
    let mut merged = match client_payload.as_object() {
        Some(row) => row.clone(),
        None => return client_payload.clone(),
    };
    let patch = build_client_passthrough_patch(client_payload, source_payload);
    for (key, value) in patch {
        merged.insert(key, value);
    }
    Value::Object(merged)
}

fn sanitize_chat_completion_like(candidate: &Value) -> Option<Value> {
    let mut row = candidate.as_object()?.clone();
    if row
        .get("choices")
        .map(|value| !matches!(value, Value::Array(_)))
        .unwrap_or(false)
    {
        row.remove("choices");
    }
    if row
        .get("usage")
        .map(|value| !matches!(value, Value::Object(_)))
        .unwrap_or(false)
    {
        row.remove("usage");
    }
    Some(Value::Object(row))
}

fn resolve_sse_stream_mode(wants_stream: bool, client_protocol: &str) -> bool {
    if !wants_stream {
        return false;
    }
    matches!(
        client_protocol.trim(),
        "openai-chat" | "openai-responses" | "anthropic-messages"
    )
}

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
        Some(Value::String(raw)) => Some(raw.to_string()),
        Some(other) => serde_json::to_string(other)
            .ok()
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

#[derive(Clone, Debug)]
struct ClientToolDefinition {
    format: Option<String>,
    parameters: Option<Map<String, Value>>,
}

fn try_parse_json_string(value: &str) -> Option<Value> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return None;
    }
    if !(trimmed.starts_with('{') || trimmed.starts_with('[')) {
        return None;
    }
    serde_json::from_str::<Value>(trimmed).ok()
}

fn looks_like_apply_patch_text(value: &str) -> bool {
    let trimmed = value.trim();
    !trimmed.is_empty() && trimmed.contains("*** Begin Patch") && trimmed.contains("*** End Patch")
}

fn extract_freeform_text_from_args(args_raw: &Value) -> Option<String> {
    if let Some(raw) = args_raw.as_str() {
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            return None;
        }
        if let Some(parsed) = try_parse_json_string(trimmed) {
            if let Some(parsed_row) = parsed.as_object() {
                for key in ["instructions", "patch", "input", "text"] {
                    if let Some(value) = parsed_row.get(key).and_then(|v| v.as_str()) {
                        let cleaned = value.trim();
                        if !cleaned.is_empty() {
                            return Some(cleaned.to_string());
                        }
                    }
                }
            }
        }
        if !trimmed.starts_with('{')
            && !trimmed.starts_with('[')
            && looks_like_apply_patch_text(trimmed)
        {
            return Some(trimmed.to_string());
        }
        return Some(trimmed.to_string());
    }
    if let Some(row) = args_raw.as_object() {
        for key in ["instructions", "patch", "input", "text"] {
            if let Some(value) = row.get(key).and_then(|v| v.as_str()) {
                let cleaned = value.trim();
                if !cleaned.is_empty() {
                    return Some(cleaned.to_string());
                }
            }
        }
    }
    None
}

fn extract_json_schema_like(
    parameters: &Map<String, Value>,
) -> Option<(Vec<String>, Vec<String>, bool)> {
    let required = parameters
        .get("required")
        .and_then(|v| v.as_array())
        .map(|items| {
            items
                .iter()
                .filter_map(|value| value.as_str().map(|s| s.trim().to_string()))
                .filter(|value| !value.is_empty())
                .collect::<Vec<String>>()
        })
        .unwrap_or_default();
    let properties_map = parameters
        .get("properties")
        .and_then(|v| v.as_object())
        .cloned()
        .unwrap_or_default();
    let properties = properties_map.keys().cloned().collect::<Vec<String>>();
    if required.is_empty() && properties.is_empty() {
        return None;
    }
    let additional_properties = parameters
        .get("additionalProperties")
        .and_then(|v| v.as_bool())
        .unwrap_or(true);
    Some((required, properties, additional_properties))
}

fn repair_tool_args_by_schema_keys(
    tool_name: &str,
    record: &Map<String, Value>,
    required: &[String],
    properties: &[String],
    additional_properties: bool,
) -> Option<Map<String, Value>> {
    let wants = properties.iter().cloned().collect::<HashSet<String>>();
    let mut out = record.clone();

    if tool_name == "exec_command" {
        if wants.contains("cmd") && out.get("command").is_some() && out.get("cmd").is_none() {
            if let Some(value) = out.get("command").cloned() {
                out.insert("cmd".to_string(), value);
            }
        }
        if wants.contains("command") && out.get("cmd").is_some() && out.get("command").is_none() {
            if let Some(value) = out.get("cmd").cloned() {
                out.insert("command".to_string(), value);
            }
        }
    }
    if tool_name == "write_stdin" {
        if wants.contains("chars") && out.get("text").is_some() && out.get("chars").is_none() {
            if let Some(value) = out.get("text").cloned() {
                out.insert("chars".to_string(), value);
            }
        }
        if wants.contains("text") && out.get("chars").is_some() && out.get("text").is_none() {
            if let Some(value) = out.get("chars").cloned() {
                out.insert("text".to_string(), value);
            }
        }
    }
    if tool_name == "apply_patch" {
        if wants.contains("instructions") && out.get("instructions").is_none() {
            if let Some(patch) = out.get("patch").and_then(|v| v.as_str()) {
                if !patch.trim().is_empty() {
                    out.insert("instructions".to_string(), Value::String(patch.to_string()));
                }
            } else if let Some(input) = out.get("input").and_then(|v| v.as_str()) {
                if !input.trim().is_empty() {
                    out.insert("instructions".to_string(), Value::String(input.to_string()));
                }
            }
        }
        if wants.contains("patch") && out.get("patch").is_none() {
            if let Some(instructions) = out.get("instructions").and_then(|v| v.as_str()) {
                if !instructions.trim().is_empty() {
                    out.insert("patch".to_string(), Value::String(instructions.to_string()));
                }
            } else if let Some(input) = out.get("input").and_then(|v| v.as_str()) {
                if !input.trim().is_empty() {
                    out.insert("patch".to_string(), Value::String(input.to_string()));
                }
            }
        }
    }

    for key in required {
        if !out.contains_key(key.as_str()) {
            return None;
        }
    }

    if !additional_properties && !wants.is_empty() {
        let keys = out.keys().cloned().collect::<Vec<String>>();
        for key in keys {
            if !wants.contains(key.as_str()) {
                out.remove(key.as_str());
            }
        }
    }
    Some(out)
}

fn build_client_tool_index(tools_raw: &Value) -> HashMap<String, ClientToolDefinition> {
    let mut index = HashMap::<String, ClientToolDefinition>::new();
    let Some(items) = tools_raw.as_array() else {
        return index;
    };
    for tool in items {
        let Some(row) = tool.as_object() else {
            continue;
        };
        let fn_row = row.get("function").and_then(|v| v.as_object());
        let name = fn_row
            .and_then(|fn_row| fn_row.get("name").and_then(|v| v.as_str()))
            .or_else(|| row.get("name").and_then(|v| v.as_str()))
            .map(|v| v.trim().to_string())
            .unwrap_or_default();
        if name.is_empty() {
            continue;
        }
        let format = row
            .get("format")
            .and_then(|v| v.as_str())
            .or_else(|| fn_row.and_then(|fn_row| fn_row.get("format").and_then(|v| v.as_str())))
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty());
        let parameters = fn_row
            .and_then(|fn_row| {
                fn_row
                    .get("parameters")
                    .and_then(|v| v.as_object())
                    .cloned()
            })
            .or_else(|| row.get("parameters").and_then(|v| v.as_object()).cloned());

        index.insert(name, ClientToolDefinition { format, parameters });
    }
    index
}

fn resolve_client_tool_name(
    tool_index: &HashMap<String, ClientToolDefinition>,
    raw_tool_name: &str,
) -> Option<String> {
    let trimmed = raw_tool_name.trim();
    if trimmed.is_empty() {
        return None;
    }
    if tool_index.contains_key(trimmed) {
        return Some(trimmed.to_string());
    }
    let lower = trimmed.to_ascii_lowercase();
    for key in tool_index.keys() {
        if key.to_ascii_lowercase() == lower {
            return Some(key.to_string());
        }
    }
    None
}

fn normalize_call_args(tool_name: &str, args_raw: &Value, spec: &ClientToolDefinition) -> Value {
    if spec
        .format
        .as_deref()
        .map(|value| value.eq_ignore_ascii_case("freeform"))
        .unwrap_or(false)
    {
        if let Some(raw_text) = extract_freeform_text_from_args(args_raw) {
            if !raw_text.trim().is_empty() {
                return Value::String(raw_text);
            }
        }
        return args_raw.clone();
    }

    let Some(parameters) = spec.parameters.as_ref() else {
        return args_raw.clone();
    };
    let Some((required, properties, additional_properties)) = extract_json_schema_like(parameters)
    else {
        return args_raw.clone();
    };
    let parsed = if let Some(raw) = args_raw.as_str() {
        try_parse_json_string(raw)
    } else {
        Some(args_raw.clone())
    };
    let Some(parsed) = parsed else {
        return args_raw.clone();
    };
    let Some(record) = parsed.as_object() else {
        return args_raw.clone();
    };
    let Some(repaired) = repair_tool_args_by_schema_keys(
        tool_name,
        record,
        required.as_slice(),
        properties.as_slice(),
        additional_properties,
    ) else {
        return args_raw.clone();
    };
    Value::String(
        serde_json::to_string(&Value::Object(repaired)).unwrap_or_else(|_| "{}".to_string()),
    )
}

fn normalize_responses_tool_call_arguments_for_client(
    responses_payload: &Value,
    tools_raw: &Value,
) -> Value {
    let Some(payload_row) = responses_payload.as_object() else {
        return responses_payload.clone();
    };
    let mut payload = payload_row.clone();

    let tool_index = build_client_tool_index(tools_raw);
    if tool_index.is_empty() {
        return Value::Object(payload);
    }

    if let Some(output_items) = payload.get_mut("output").and_then(|v| v.as_array_mut()) {
        for item in output_items.iter_mut() {
            let Some(item_row) = item.as_object_mut() else {
                continue;
            };
            let item_type = item_row
                .get("type")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .trim()
                .to_ascii_lowercase();
            if item_type != "function_call" {
                continue;
            }
            let name = item_row
                .get("name")
                .and_then(|v| v.as_str())
                .map(|v| v.trim().to_string())
                .unwrap_or_default();
            if name.is_empty() {
                continue;
            }
            let Some(target_name) = resolve_client_tool_name(&tool_index, name.as_str()) else {
                continue;
            };
            if target_name != name {
                item_row.insert("name".to_string(), Value::String(target_name.clone()));
            }
            if let Some(spec) = tool_index.get(target_name.as_str()) {
                let args_raw = item_row
                    .get("arguments")
                    .cloned()
                    .unwrap_or_else(|| Value::Null);
                let normalized = normalize_call_args(target_name.as_str(), &args_raw, spec);
                item_row.insert("arguments".to_string(), normalized);
            }
        }
    }

    let tool_calls_opt = payload
        .get_mut("required_action")
        .and_then(|v| v.as_object_mut())
        .and_then(|row| row.get_mut("submit_tool_outputs"))
        .and_then(|v| v.as_object_mut())
        .and_then(|row| row.get_mut("tool_calls"))
        .and_then(|v| v.as_array_mut());
    if let Some(calls) = tool_calls_opt {
        for call in calls.iter_mut() {
            let Some(call_row) = call.as_object_mut() else {
                continue;
            };
            let mut name = call_row
                .get("name")
                .and_then(|v| v.as_str())
                .map(|v| v.trim().to_string())
                .unwrap_or_default();
            if name.is_empty() {
                name = call_row
                    .get("function")
                    .and_then(|v| v.as_object())
                    .and_then(|v| v.get("name"))
                    .and_then(|v| v.as_str())
                    .map(|v| v.trim().to_string())
                    .unwrap_or_default();
            }
            if name.is_empty() {
                continue;
            }
            let Some(target_name) = resolve_client_tool_name(&tool_index, name.as_str()) else {
                continue;
            };
            if let Some(name_value) = call_row.get("name") {
                if name_value.is_string() && target_name != name {
                    call_row.insert("name".to_string(), Value::String(target_name.clone()));
                }
            }
            let fn_args = call_row
                .get("function")
                .and_then(|v| v.as_object())
                .and_then(|v| v.get("arguments"))
                .cloned();
            let call_args = call_row.get("arguments").cloned();
            let args_raw = fn_args.or(call_args).unwrap_or(Value::Null);

            if let Some(spec) = tool_index.get(target_name.as_str()) {
                let normalized = normalize_call_args(target_name.as_str(), &args_raw, spec);
                call_row.insert("arguments".to_string(), normalized.clone());
                if let Some(fn_row) = call_row.get_mut("function").and_then(|v| v.as_object_mut()) {
                    fn_row.insert("name".to_string(), Value::String(target_name.clone()));
                    fn_row.insert("arguments".to_string(), normalized);
                }
            }
        }
    }

    Value::Object(payload)
}

fn read_number_field(value: Option<&Value>) -> Option<f64> {
    let number = value.and_then(|v| v.as_f64())?;
    if number.is_finite() {
        Some(number)
    } else {
        None
    }
}

fn normalize_responses_usage(usage_raw: &Value) -> Value {
    let Some(usage_row) = usage_raw.as_object() else {
        return usage_raw.clone();
    };
    let mut usage = usage_row.clone();

    let input_tokens = read_number_field(usage.get("input_tokens"))
        .or_else(|| read_number_field(usage.get("prompt_tokens")));
    let output_tokens = read_number_field(usage.get("output_tokens"))
        .or_else(|| read_number_field(usage.get("completion_tokens")));
    let cache_read_tokens = read_number_field(usage.get("cache_read_input_tokens")).or_else(|| {
        usage
            .get("input_tokens_details")
            .and_then(|v| v.as_object())
            .and_then(|row| read_number_field(row.get("cached_tokens")))
    });

    let mut total_tokens = read_number_field(usage.get("total_tokens"));
    let prompt_tokens_raw = read_number_field(usage.get("prompt_tokens"));
    let prompt_tokens = match (prompt_tokens_raw, input_tokens, cache_read_tokens) {
        (Some(prompt), Some(input), Some(cache)) => {
            let with_cache = input + cache;
            if prompt >= with_cache {
                prompt
            } else {
                with_cache
            }
        }
        (Some(prompt), _, _) => prompt,
        (None, Some(input), Some(cache)) => input + cache,
        (None, Some(input), None) => input,
        (None, None, Some(cache)) => cache,
        _ => return Value::Object(usage),
    };
    if total_tokens.is_none() {
        if let (Some(prompt), Some(output)) = (Some(prompt_tokens), output_tokens) {
            let total = prompt + output;
            if total.is_finite() {
                total_tokens = Some(total);
            }
        }
    }

    if let Some(input_tokens) = input_tokens {
        usage.insert("input_tokens".to_string(), Value::from(input_tokens));
    }
    if let Some(output_tokens) = output_tokens {
        usage.insert("output_tokens".to_string(), Value::from(output_tokens));
    }
    if let Some(total_tokens) = total_tokens {
        usage.insert("total_tokens".to_string(), Value::from(total_tokens));
    }

    if !usage.contains_key("prompt_tokens") {
        usage.insert("prompt_tokens".to_string(), Value::from(prompt_tokens));
    } else if let Some(prompt_tokens_raw) = read_number_field(usage.get("prompt_tokens")) {
        if let (Some(input_tokens), Some(cache_read_tokens)) = (input_tokens, cache_read_tokens) {
            let with_cache = input_tokens + cache_read_tokens;
            if prompt_tokens_raw < with_cache {
                usage.insert("prompt_tokens".to_string(), Value::from(with_cache));
            }
        }
    }
    if !usage.contains_key("completion_tokens") {
        if let Some(output_tokens) = output_tokens {
            usage.insert("completion_tokens".to_string(), Value::from(output_tokens));
        }
    }

    if let Some(cache_read_tokens) = cache_read_tokens {
        let details = usage
            .entry("input_tokens_details".to_string())
            .or_insert_with(|| Value::Object(Map::new()));
        if let Value::Object(details_row) = details {
            details_row
                .entry("cached_tokens".to_string())
                .or_insert_with(|| Value::from(cache_read_tokens));
        }
    }

    Value::Object(usage)
}

fn now_unix_seconds() -> i64 {
    (now_unix_millis() / 1000) as i64
}

fn unwrap_responses_data_node(payload: &Value) -> Value {
    let mut current = payload.clone();
    let mut depth = 0usize;
    while depth < 8 {
        depth += 1;
        let Some(row) = current.as_object() else {
            break;
        };
        if row.contains_key("choices") || row.contains_key("message") {
            break;
        }
        let Some(next) = row.get("data").and_then(|v| v.as_object()) else {
            break;
        };
        current = Value::Object(next.clone());
    }
    current
}

fn read_object_string(row: &Map<String, Value>, key: &str) -> Option<String> {
    row.get(key)
        .and_then(|v| v.as_str())
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
}

fn read_request_id(response: &Map<String, Value>, request_id_hint: Option<&str>) -> Option<String> {
    read_object_string(response, "request_id")
        .or_else(|| {
            request_id_hint
                .map(|v| v.trim().to_string())
                .filter(|v| !v.is_empty())
        })
        .or_else(|| read_object_string(response, "id"))
}

fn read_created_at(response: &Map<String, Value>) -> Value {
    if let Some(created_at) = response.get("created_at") {
        return created_at.clone();
    }
    if let Some(created) = response.get("created") {
        return created.clone();
    }
    Value::from(now_unix_seconds())
}

fn read_failed_status_code(response: &Map<String, Value>) -> Option<String> {
    if let Some(raw) = response.get("status") {
        if let Some(status) = raw.as_str() {
            let trimmed = status.trim();
            if !trimmed.is_empty() {
                return Some(trimmed.to_string());
            }
        } else if let Some(status) = raw.as_i64() {
            return Some(status.to_string());
        } else if let Some(status) = raw.as_u64() {
            return Some(status.to_string());
        } else if let Some(status) = raw.as_f64() {
            if status.is_finite() {
                return Some(status.to_string());
            }
        }
    }
    None
}

fn read_failed_message(response: &Map<String, Value>) -> String {
    read_object_string(response, "msg")
        .or_else(|| read_object_string(response, "message"))
        .unwrap_or_else(|| {
            "Upstream returned non-standard Chat completion payload (missing choices).".to_string()
        })
}

fn build_failed_responses_payload(
    response: &Map<String, Value>,
    request_id_hint: Option<&str>,
) -> Value {
    let id =
        read_object_string(response, "id").unwrap_or_else(|| format!("resp-{}", now_unix_millis()));
    let message = read_failed_message(response);
    let mut out = Map::new();
    out.insert("id".to_string(), Value::String(id));
    out.insert("object".to_string(), Value::String("response".to_string()));
    out.insert("created_at".to_string(), read_created_at(response));
    if let Some(model) = response.get("model") {
        out.insert("model".to_string(), model.clone());
    }
    out.insert("status".to_string(), Value::String("failed".to_string()));
    out.insert("output".to_string(), Value::Array(Vec::new()));
    out.insert("output_text".to_string(), Value::String(message.clone()));

    let mut error = Map::new();
    error.insert(
        "type".to_string(),
        Value::String("provider_error".to_string()),
    );
    if let Some(code) = read_failed_status_code(response) {
        error.insert("code".to_string(), Value::String(code));
    } else {
        error.insert("code".to_string(), Value::Null);
    }
    error.insert("message".to_string(), Value::String(message));
    out.insert("error".to_string(), Value::Object(error));

    if let Some(request_id) = read_request_id(response, request_id_hint) {
        out.insert("request_id".to_string(), Value::String(request_id));
    }
    Value::Object(out)
}

pub(crate) fn normalize_responses_function_name(raw: Option<&str>) -> Option<String> {
    let raw = raw.unwrap_or("").trim();
    if raw.is_empty() {
        return None;
    }
    if raw.eq_ignore_ascii_case("tool") {
        return None;
    }
    let mut out = String::new();
    for ch in raw.chars() {
        if ch.is_ascii_alphanumeric() || ch == '_' || ch == '-' {
            out.push(ch);
        } else if !ch.is_whitespace() {
            out.push('_');
        }
    }
    let trimmed = out.trim_matches('_').to_string();
    if trimmed.is_empty() {
        return None;
    }
    if trimmed.chars().count() > 128 {
        return None;
    }
    let lower = trimmed.to_ascii_lowercase();
    if lower == "websearch" || lower == "web-search" {
        return Some("web_search".to_string());
    }
    Some(trimmed)
}

fn normalize_output_text_content(content: &Value) -> Vec<Value> {
    let mut output: Vec<Value> = Vec::new();
    if let Some(raw) = content.as_str() {
        let text = raw.trim().to_string();
        if !text.is_empty() {
            output.push(Value::Object(Map::from_iter([
                ("type".to_string(), Value::String("output_text".to_string())),
                ("text".to_string(), Value::String(text)),
            ])));
        }
        return output;
    }

    let Some(parts) = content.as_array() else {
        return output;
    };
    for part in parts {
        if let Some(raw) = part.as_str() {
            let text = raw.trim().to_string();
            if !text.is_empty() {
                output.push(Value::Object(Map::from_iter([
                    ("type".to_string(), Value::String("output_text".to_string())),
                    ("text".to_string(), Value::String(text)),
                ])));
            }
            continue;
        }
        let Some(row) = part.as_object() else {
            continue;
        };
        let raw_type = read_object_string(row, "type").unwrap_or_default();
        if raw_type.eq_ignore_ascii_case("text")
            || raw_type.eq_ignore_ascii_case("input_text")
            || raw_type.eq_ignore_ascii_case("output_text")
            || raw_type.eq_ignore_ascii_case("refusal")
        {
            let text = read_object_string(row, "text")
                .or_else(|| read_object_string(row, "content"))
                .unwrap_or_default();
            if !text.is_empty() {
                output.push(Value::Object(Map::from_iter([
                    ("type".to_string(), Value::String("output_text".to_string())),
                    ("text".to_string(), Value::String(text)),
                ])));
            }
            continue;
        }
        output.push(Value::Object(row.clone()));
    }

    output
}

fn collect_responses_output_text(parts: &[Value], meta: Option<&Value>) -> Option<String> {
    if let Some(meta_row) = meta.and_then(|v| v.as_object()) {
        let has_field = meta_row
            .get("hasField")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        if has_field {
            return Some(
                meta_row
                    .get("value")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string(),
            );
        }
        return None;
    }

    let mut texts: Vec<String> = Vec::new();
    for part in parts {
        let Some(row) = part.as_object() else {
            continue;
        };
        let kind = row
            .get("type")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim()
            .to_ascii_lowercase();
        if kind != "output_text" {
            continue;
        }
        let text = row
            .get("text")
            .and_then(|v| v.as_str())
            .map(|v| v.trim().to_string())
            .unwrap_or_default();
        if !text.is_empty() {
            texts.push(text);
        }
    }
    if texts.is_empty() {
        None
    } else {
        Some(texts.join("\n"))
    }
}

fn collect_executed_tool_call_ids(response: &Map<String, Value>) -> HashSet<String> {
    let mut ids = HashSet::<String>::new();
    let Some(outputs) = response.get("tool_outputs").and_then(|v| v.as_array()) else {
        return ids;
    };
    for entry in outputs {
        let Some(row) = entry.as_object() else {
            continue;
        };
        let raw_id = read_object_string(row, "tool_call_id")
            .or_else(|| read_object_string(row, "call_id"))
            .or_else(|| read_object_string(row, "id"));
        if let Some(raw_id) = raw_id {
            ids.insert(raw_id.clone());
            ids.insert(format!("fc_{}", raw_id));
        }
    }
    ids
}

type PendingToolCall = (usize, String, String, String);

fn is_missing_field(value: Option<&Value>) -> bool {
    match value {
        None => true,
        Some(Value::Null) => true,
        Some(Value::Array(arr)) => arr.is_empty(),
        _ => false,
    }
}

fn is_summary_text_array(value: &Value) -> bool {
    let Some(arr) = value.as_array() else {
        return false;
    };
    if arr.is_empty() {
        return false;
    }
    for entry in arr {
        let Some(row) = entry.as_object() else {
            return false;
        };
        let kind = row
            .get("type")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim()
            .to_ascii_lowercase();
        let has_text = row
            .get("text")
            .and_then(|v| v.as_str())
            .map(|v| !v.trim().is_empty())
            .unwrap_or(false);
        if kind != "summary_text" || !has_text {
            return false;
        }
    }
    true
}

fn is_codex_reasoning_summary_display_compatible(text: &str) -> bool {
    let trimmed = text.trim_start();
    if !trimmed.starts_with("**") {
        return false;
    }
    let after_open = &trimmed[2..];
    let Some(close) = after_open.find("**") else {
        return false;
    };
    if close == 0 {
        return false;
    }
    after_open[(close + 2)..]
        .chars()
        .any(|ch| !ch.is_whitespace())
}

fn normalize_reasoning_summary_for_codex_display(summary_value: &mut Value) {
    let Some(summary_items) = summary_value.as_array_mut() else {
        return;
    };
    if summary_items.is_empty() {
        return;
    }

    let mut has_display_compatible_summary = false;
    for entry in summary_items.iter() {
        let Some(row) = entry.as_object() else {
            continue;
        };
        let kind = row
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim()
            .to_ascii_lowercase();
        if kind != "summary_text" {
            continue;
        }
        let Some(text) = row.get("text").and_then(Value::as_str) else {
            continue;
        };
        if is_codex_reasoning_summary_display_compatible(text) {
            has_display_compatible_summary = true;
            break;
        }
    }
    if has_display_compatible_summary {
        return;
    }

    for entry in summary_items.iter_mut() {
        let Some(row) = entry.as_object_mut() else {
            continue;
        };
        let kind = row
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim()
            .to_ascii_lowercase();
        if kind != "summary_text" {
            continue;
        }
        let Some(text) = row.get("text").and_then(Value::as_str) else {
            continue;
        };
        let trimmed = text.trim();
        if trimmed.is_empty() {
            continue;
        }
        row.insert(
            "text".to_string(),
            Value::String(format!("**Thinking** {}", trimmed)),
        );
        break;
    }
}

fn merge_responses_output_items(base: &[Value], source: &[Value]) -> Vec<Value> {
    let mut source_by_id: HashMap<String, Value> = HashMap::new();
    for entry in source {
        let Some(row) = entry.as_object() else {
            continue;
        };
        let Some(id) = row.get("id").and_then(|v| v.as_str()) else {
            continue;
        };
        if !id.trim().is_empty() {
            source_by_id.insert(id.trim().to_string(), entry.clone());
        }
    }

    let mut merged: Vec<Value> = Vec::with_capacity(base.len());
    for (index, entry) in base.iter().enumerate() {
        let Some(base_row) = entry.as_object() else {
            merged.push(entry.clone());
            continue;
        };
        let mut next = base_row.clone();
        let source_item = next
            .get("id")
            .and_then(|v| v.as_str())
            .and_then(|id| source_by_id.get(id))
            .cloned()
            .or_else(|| source.get(index).cloned());
        let Some(source_item) = source_item else {
            merged.push(Value::Object(next));
            continue;
        };
        let Some(source_row) = source_item.as_object() else {
            merged.push(Value::Object(next));
            continue;
        };

        if is_missing_field(next.get("content")) {
            if let Some(content) = source_row.get("content") {
                next.insert("content".to_string(), content.clone());
            }
        }

        if let Some(summary) = source_row.get("summary") {
            let base_summary = next.get("summary");
            let should_override = is_missing_field(base_summary)
                || base_summary.map(is_summary_text_array).unwrap_or(false);
            if should_override {
                next.insert("summary".to_string(), summary.clone());
            }
        }

        if is_missing_field(next.get("encrypted_content")) {
            if let Some(encrypted) = source_row.get("encrypted_content") {
                next.insert("encrypted_content".to_string(), encrypted.clone());
            }
        }

        merged.push(Value::Object(next));
    }
    merged
}

fn read_context_object<'a>(context: &'a Value, key: &str) -> Option<&'a Map<String, Value>> {
    context.as_object()?.get(key)?.as_object()
}

fn context_value<'a>(context: &'a Value, key: &str) -> Option<&'a Value> {
    context.as_object()?.get(key)
}

fn context_bool(context: &Value, key: &str) -> bool {
    context_value(context, key)
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

fn apply_context_passthrough(out: &mut Map<String, Value>, context: &Value) {
    // Restore original reasoning_effort from metadata if it was overridden during routing
    if let Some(metadata_obj) = context_value(context, "metadata").and_then(|v| v.as_object()) {
        if let Some(original_effort) = metadata_obj
            .get("originalReasoningEffort")
            .and_then(|v| v.as_str())
        {
            let trimmed = original_effort.trim();
            if !trimmed.is_empty() {
                out.insert(
                    "reasoning_effort".to_string(),
                    Value::String(trimmed.to_string()),
                );
            }
        }
    }

    for (context_key, output_key) in [
        ("metadata", "metadata"),
        ("parallelToolCalls", "parallel_tool_calls"),
        ("toolChoice", "tool_choice"),
        ("include", "include"),
    ] {
        if out.contains_key(output_key) {
            continue;
        }
        if let Some(value) = context_value(context, context_key) {
            out.insert(output_key.to_string(), value.clone());
        }
    }
    if !context_bool(context, "stripHostManagedFields") && !out.contains_key("store") {
        if let Some(value) = context_value(context, "store") {
            out.insert("store".to_string(), value.clone());
        }
    }
}

fn merge_source_retention(out: &mut Map<String, Value>, source_row: &Map<String, Value>) {
    if let Some(source_output) = source_row.get("output").and_then(|v| v.as_array()) {
        if let Some(base_output) = out.get("output").and_then(|v| v.as_array()) {
            let merged_output = merge_responses_output_items(base_output, source_output);
            out.insert("output".to_string(), Value::Array(merged_output));
        }
    }

    for key in [
        "metadata",
        "temperature",
        "top_p",
        "prompt_cache_key",
        "reasoning",
    ] {
        if out.contains_key(key) {
            continue;
        }
        if let Some(value) = source_row.get(key) {
            out.insert(key.to_string(), value.clone());
        }
    }

    if !out.contains_key("error") {
        if let Some(error) = source_row.get("error") {
            if error.is_object() {
                out.insert("error".to_string(), error.clone());
            }
        }
    }
}

fn finalize_client_responses_payload(
    payload: Value,
    response_row: &Map<String, Value>,
    context: &Value,
) -> Value {
    let mut out = payload.as_object().cloned().unwrap_or_default();

    if let Some(request_id) = read_request_id(
        response_row,
        context_value(context, "requestId").and_then(Value::as_str),
    ) {
        out.insert("request_id".to_string(), Value::String(request_id));
    }

    apply_context_passthrough(&mut out, context);

    if let Some(source_row) = read_context_object(context, "sourceForRetention") {
        merge_source_retention(&mut out, source_row);
    }

    let tools_raw = context
        .as_object()
        .and_then(|v| v.get("toolsRaw"))
        .cloned()
        .unwrap_or_else(|| Value::Array(Vec::new()));
    let mut normalized =
        normalize_responses_tool_call_arguments_for_client(&Value::Object(out), &tools_raw);
    if let Some(metadata) = normalized
        .as_object_mut()
        .and_then(|record| record.get_mut("metadata"))
    {
        strip_internal_tooling_metadata_impl(metadata);
    }
    normalized
}

fn build_responses_payload_from_chat_core(
    payload: &Value,
    request_id_hint: Option<&str>,
    context: &Value,
) -> Result<Value, String> {
    let response = unwrap_responses_data_node(payload);
    let Some(response_row) = response.as_object() else {
        return Ok(finalize_client_responses_payload(
            build_failed_responses_payload(&Map::new(), request_id_hint),
            &Map::new(),
            context,
        ));
    };

    if response_row
        .get("object")
        .and_then(|v| v.as_str())
        .map(|v| v == "response")
        .unwrap_or(false)
        && response_row
            .get("output")
            .and_then(|v| v.as_array())
            .is_some()
    {
        return Ok(Value::Object(response_row.clone()));
    }

    let choices = response_row
        .get("choices")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    if choices.is_empty() {
        return Ok(finalize_client_responses_payload(
            build_failed_responses_payload(response_row, request_id_hint),
            response_row,
            context,
        ));
    }

    let choice = choices
        .first()
        .and_then(|v| v.as_object())
        .ok_or_else(|| "responses outbound remap missing primary choice".to_string())?;
    let message = choice
        .get("message")
        .and_then(|v| v.as_object())
        .ok_or_else(|| "responses outbound remap missing assistant message".to_string())?;
    let mut normalized_message = message.clone();
    normalize_message_reasoning_ssot(&mut normalized_message);
    let message = &normalized_message;

    let role = read_object_string(message, "role").unwrap_or_else(|| "assistant".to_string());
    let content_parts =
        normalize_output_text_content(message.get("content").unwrap_or(&Value::Null));
    let reasoning_payload = message.get("reasoning").cloned().or_else(|| {
        read_object_string(message, "reasoning_content")
            .and_then(|text| build_message_reasoning_value(&[], &[text], None))
    });

    let tool_calls = message
        .get("tool_calls")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let has_tool_calls = !tool_calls.is_empty();
    let should_emit_message =
        !content_parts.is_empty() || reasoning_payload.is_some() || !has_tool_calls;

    let response_id = read_object_string(response_row, "id")
        .unwrap_or_else(|| format!("resp-{}", now_unix_millis()));
    let request_id_value = read_request_id(response_row, request_id_hint);
    let request_seed = request_id_value
        .clone()
        .unwrap_or_else(|| request_id_hint.unwrap_or("responses_outbound").to_string());

    let mut output_items: Vec<Value> = Vec::new();
    if let Some(reasoning_payload) = reasoning_payload.as_ref().and_then(Value::as_object) {
        let mut reasoning_item = Map::new();
        reasoning_item.insert(
            "id".to_string(),
            Value::String(format!(
                "reasoning_{}_{}",
                request_seed,
                output_items.len() + 1
            )),
        );
        reasoning_item.insert("type".to_string(), Value::String("reasoning".to_string()));
        reasoning_item.insert("status".to_string(), Value::String("completed".to_string()));
        let has_explicit_summary = reasoning_payload
            .get("summary")
            .and_then(Value::as_array)
            .map(|items| !items.is_empty())
            .unwrap_or(false);
        let summary_value = reasoning_payload.get("summary").cloned().or_else(|| {
            reasoning_payload
                .get("content")
                .and_then(Value::as_array)
                .map(|content_items| {
                    content_items
                        .iter()
                        .filter_map(|entry| {
                            let row = entry.as_object()?;
                            let kind = row
                                .get("type")
                                .and_then(Value::as_str)
                                .unwrap_or("")
                                .trim()
                                .to_ascii_lowercase();
                            if kind != "reasoning_text" && kind != "text" {
                                return None;
                            }
                            let text = row
                                .get("text")
                                .and_then(Value::as_str)
                                .map(|value| value.trim().to_string())
                                .filter(|value| !value.is_empty())?;
                            Some(Value::Object(Map::from_iter([
                                ("type".to_string(), Value::String("summary_text".to_string())),
                                ("text".to_string(), Value::String(text)),
                            ])))
                        })
                        .collect::<Vec<Value>>()
                })
                .filter(|summary_entries| !summary_entries.is_empty())
                .map(Value::Array)
        });
        if let Some(mut summary) = summary_value {
            normalize_reasoning_summary_for_codex_display(&mut summary);
            reasoning_item.insert("summary".to_string(), summary);
        }
        let summary_was_backfilled = !has_explicit_summary && reasoning_item.contains_key("summary");
        if has_explicit_summary || !summary_was_backfilled {
            if let Some(content) = reasoning_payload.get("content") {
                reasoning_item.insert("content".to_string(), content.clone());
            }
        }
        if let Some(encrypted_content) = reasoning_payload.get("encrypted_content") {
            reasoning_item.insert("encrypted_content".to_string(), encrypted_content.clone());
        }
        output_items.push(Value::Object(reasoning_item));
    }

    let mut message_output_index: Option<usize> = None;
    if should_emit_message {
        message_output_index = Some(output_items.len());
        output_items.push(Value::Object(Map::from_iter([
            (
                "id".to_string(),
                Value::String(format!(
                    "message_{}_{}",
                    request_seed,
                    output_items.len() + 1
                )),
            ),
            ("type".to_string(), Value::String("message".to_string())),
            ("status".to_string(), Value::String("completed".to_string())),
            ("role".to_string(), Value::String(role)),
            ("content".to_string(), Value::Array(content_parts.clone())),
        ])));
    }

    let mut pending_calls: Vec<PendingToolCall> = Vec::new();
    for (index, call) in tool_calls.iter().enumerate() {
        let Some(call_row) = call.as_object() else {
            continue;
        };
        let fn_row = call_row.get("function").and_then(|v| v.as_object());
        let raw_name = fn_row
            .and_then(|v| v.get("name").and_then(|vv| vv.as_str()))
            .or_else(|| call_row.get("name").and_then(|vv| vv.as_str()));
        let Some(name) = normalize_responses_function_name(raw_name) else {
            continue;
        };
        let call_id = read_object_string(call_row, "id")
            .or_else(|| read_object_string(call_row, "call_id"))
            .unwrap_or_else(|| format!("fc_call_{}", index + 1));
        let args_raw = fn_row
            .and_then(|v| v.get("arguments"))
            .or_else(|| call_row.get("arguments"))
            .cloned()
            .unwrap_or(Value::Object(Map::new()));
        let arguments = if let Some(raw) = args_raw.as_str() {
            raw.to_string()
        } else {
            serde_json::to_string(&args_raw).unwrap_or_else(|_| "{}".to_string())
        };

        let item_index = output_items.len();
        output_items.push(Value::Object(Map::from_iter([
            ("id".to_string(), Value::String(format!("fc_{}", call_id))),
            (
                "type".to_string(),
                Value::String("function_call".to_string()),
            ),
            ("status".to_string(), Value::String("completed".to_string())),
            ("name".to_string(), Value::String(name.clone())),
            ("call_id".to_string(), Value::String(call_id.clone())),
            ("arguments".to_string(), Value::String(arguments.clone())),
        ])));
        pending_calls.push((item_index, call_id, name, arguments));
    }

    let executed_ids = collect_executed_tool_call_ids(response_row);
    let pending_calls = pending_calls
        .into_iter()
        .filter(|(_, call_id, _, _)| !executed_ids.contains(call_id))
        .collect::<Vec<PendingToolCall>>();

    if !pending_calls.is_empty() {
        if let Some(index) = message_output_index {
            if let Some(message_row) = output_items.get_mut(index).and_then(|v| v.as_object_mut()) {
                message_row.insert(
                    "status".to_string(),
                    Value::String("in_progress".to_string()),
                );
            }
        }
        for (item_index, _, _, _) in &pending_calls {
            if let Some(item_row) = output_items
                .get_mut(*item_index)
                .and_then(|v| v.as_object_mut())
            {
                item_row.insert(
                    "status".to_string(),
                    Value::String("in_progress".to_string()),
                );
            }
        }
    }

    let mut out = Map::new();
    out.insert("id".to_string(), Value::String(response_id));
    out.insert("object".to_string(), Value::String("response".to_string()));
    out.insert("created_at".to_string(), read_created_at(response_row));
    if let Some(model) = response_row.get("model") {
        out.insert("model".to_string(), model.clone());
    }
    out.insert(
        "status".to_string(),
        Value::String(if pending_calls.is_empty() {
            "completed".to_string()
        } else {
            "requires_action".to_string()
        }),
    );
    out.insert("output".to_string(), Value::Array(output_items.clone()));

    if let Some(output_text) = collect_responses_output_text(
        content_parts.as_slice(),
        response_row.get("__responses_output_text_meta"),
    ) {
        out.insert("output_text".to_string(), Value::String(output_text));
    }

    if let Some(usage_raw) = response_row.get("usage") {
        out.insert("usage".to_string(), normalize_responses_usage(usage_raw));
    }

    if !pending_calls.is_empty() {
        let mut tool_calls = Vec::<Value>::new();
        for (_, call_id, name, args) in &pending_calls {
            tool_calls.push(Value::Object(Map::from_iter([
                ("id".to_string(), Value::String(call_id.clone())),
                ("tool_call_id".to_string(), Value::String(call_id.clone())),
                ("type".to_string(), Value::String("function".to_string())),
                ("name".to_string(), Value::String(name.clone())),
                ("arguments".to_string(), Value::String(args.clone())),
                (
                    "function".to_string(),
                    Value::Object(Map::from_iter([
                        ("name".to_string(), Value::String(name.clone())),
                        ("arguments".to_string(), Value::String(args.clone())),
                    ])),
                ),
            ])));
        }
        out.insert(
            "required_action".to_string(),
            Value::Object(Map::from_iter([
                (
                    "type".to_string(),
                    Value::String("submit_tool_outputs".to_string()),
                ),
                (
                    "submit_tool_outputs".to_string(),
                    Value::Object(Map::from_iter([(
                        "tool_calls".to_string(),
                        Value::Array(tool_calls),
                    )])),
                ),
            ])),
        );
    }

    Ok(finalize_client_responses_payload(
        Value::Object(out),
        response_row,
        context,
    ))
}

#[napi]
pub fn normalize_alias_map_json(candidate_json: String) -> NapiResult<String> {
    let candidate: Value = serde_json::from_str(&candidate_json)
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let output = normalize_alias_map(&candidate);
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi]
pub fn resolve_client_tools_raw_json(candidate_json: String) -> NapiResult<String> {
    let candidate: Value = serde_json::from_str(&candidate_json)
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let output = resolve_client_tools_raw(&candidate);
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi]
pub fn resolve_alias_map_from_resp_semantics_json(semantics_json: String) -> NapiResult<String> {
    let semantics: Value = serde_json::from_str(&semantics_json)
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let output = resolve_alias_map_from_resp_semantics(&semantics);
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi]
pub fn resolve_client_tools_raw_from_resp_semantics_json(
    semantics_json: String,
) -> NapiResult<String> {
    let semantics: Value = serde_json::from_str(&semantics_json)
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let output = resolve_client_tools_raw_from_resp_semantics(&semantics);
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi]
pub fn sanitize_responses_function_name_json(raw_name_json: String) -> NapiResult<String> {
    let raw_name: Value = serde_json::from_str(&raw_name_json)
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let output = normalize_responses_function_name(raw_name.as_str());
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi]
pub fn apply_client_passthrough_patch_json(
    client_payload_json: String,
    source_payload_json: String,
) -> NapiResult<String> {
    let client_payload: Value = serde_json::from_str(&client_payload_json)
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let source_payload: Value = serde_json::from_str(&source_payload_json)
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;

    let output = apply_client_passthrough_patch(&client_payload, &source_payload);
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi]
pub fn sanitize_chat_completion_like_json(candidate_json: String) -> NapiResult<String> {
    let candidate: Value = serde_json::from_str(&candidate_json)
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let output = sanitize_chat_completion_like(&candidate);
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi]
pub fn build_anthropic_response_from_chat_json(
    chat_response_json: String,
    alias_map_json: String,
) -> NapiResult<String> {
    let chat_response: Value = serde_json::from_str(&chat_response_json)
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let alias_map: Value = serde_json::from_str(&alias_map_json)
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let output = build_anthropic_response_from_chat_core(&chat_response, Some(&alias_map));
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi(js_name = "buildOpenaiChatFromAnthropicJson")]
pub fn build_openai_chat_from_anthropic_json_bridge(
    payload_json: String,
    options_json: Option<String>,
) -> NapiResult<String> {
    crate::anthropic_openai_codec::build_openai_chat_from_anthropic_json(payload_json, options_json)
}

#[napi(js_name = "buildAnthropicFromOpenaiChatJson")]
pub fn build_anthropic_from_openai_chat_json_bridge(
    chat_response_json: String,
    options_json: Option<String>,
) -> NapiResult<String> {
    crate::anthropic_openai_codec::build_anthropic_from_openai_chat_json(
        chat_response_json,
        options_json,
    )
}

#[napi]
pub fn normalize_responses_tool_call_arguments_for_client_json(
    responses_payload_json: String,
    tools_raw_json: String,
) -> NapiResult<String> {
    let responses_payload: Value = serde_json::from_str(&responses_payload_json)
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let tools_raw: Value = serde_json::from_str(&tools_raw_json)
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let output = normalize_responses_tool_call_arguments_for_client(&responses_payload, &tools_raw);
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi]
pub fn normalize_responses_usage_json(usage_json: String) -> NapiResult<String> {
    let usage: Value =
        serde_json::from_str(&usage_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let output = normalize_responses_usage(&usage);
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi]
pub fn build_responses_payload_from_chat_json(
    payload_json: String,
    context_json: String,
) -> NapiResult<String> {
    let payload: Value =
        serde_json::from_str(&payload_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let context: Value =
        serde_json::from_str(&context_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let request_id_hint = context
        .as_object()
        .and_then(|v| v.get("requestId"))
        .and_then(|v| v.as_str())
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty());
    let output =
        build_responses_payload_from_chat_core(&payload, request_id_hint.as_deref(), &context)
            .map_err(napi::Error::from_reason)?;
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn build_responses_payload_from_chat_filters_executed_tool_outputs_from_required_action() {
        let payload = serde_json::json!({
            "id": "resp_partial",
            "model": "glm-4.7",
            "tool_outputs": [
                { "tool_call_id": "fc_call_1", "output": "done" }
            ],
            "choices": [
                {
                    "message": {
                        "role": "assistant",
                        "content": "done",
                        "tool_calls": [
                            {
                                "id": "fc_call_1",
                                "type": "function",
                                "function": { "name": "exec_command", "arguments": "{\"cmd\":\"pwd\"}" }
                            },
                            {
                                "id": "fc_call_2",
                                "type": "function",
                                "function": { "name": "exec_command", "arguments": "{\"cmd\":\"ls\"}" }
                            }
                        ]
                    }
                }
            ]
        });

        let output = build_responses_payload_from_chat_core(
            &payload,
            Some("req_partial"),
            &serde_json::json!({ "toolsRaw": [] }),
        )
        .expect("build responses payload");
        assert_eq!(
            output["status"],
            Value::String("requires_action".to_string())
        );
        let required_calls = output["required_action"]["submit_tool_outputs"]["tool_calls"]
            .as_array()
            .cloned()
            .expect("tool calls array");
        assert_eq!(required_calls.len(), 1);
        assert_eq!(
            required_calls[0]["id"],
            Value::String("fc_call_2".to_string())
        );

        let output_items = output["output"].as_array().cloned().expect("output array");
        let function_items: Vec<&Value> = output_items
            .iter()
            .filter(|item| item["type"] == Value::String("function_call".to_string()))
            .collect();
        assert_eq!(function_items.len(), 2);
        assert_eq!(
            function_items[0]["status"],
            Value::String("completed".to_string())
        );
        assert_eq!(
            function_items[1]["status"],
            Value::String("in_progress".to_string())
        );
    }

    #[test]
    fn build_responses_payload_from_chat_keeps_completed_when_no_pending_tool_calls_remain() {
        let payload = serde_json::json!({
            "id": "resp_completed",
            "model": "glm-4.7",
            "tool_outputs": [
                { "tool_call_id": "fc_call_1", "output": "done-1" },
                { "tool_call_id": "fc_call_2", "output": "done-2" }
            ],
            "choices": [
                {
                    "message": {
                        "role": "assistant",
                        "content": "all done",
                        "tool_calls": [
                            {
                                "id": "fc_call_1",
                                "type": "function",
                                "function": { "name": "exec_command", "arguments": "{\"cmd\":\"pwd\"}" }
                            },
                            {
                                "id": "fc_call_2",
                                "type": "function",
                                "function": { "name": "exec_command", "arguments": "{\"cmd\":\"ls\"}" }
                            }
                        ]
                    }
                }
            ]
        });

        let output = build_responses_payload_from_chat_core(
            &payload,
            Some("req_completed"),
            &serde_json::json!({ "toolsRaw": [] }),
        )
        .expect("build responses payload");
        assert_eq!(output["status"], Value::String("completed".to_string()));
        assert!(output.get("required_action").is_none());
        let output_items = output["output"].as_array().cloned().expect("output array");
        for item in output_items
            .iter()
            .filter(|item| item["type"] == Value::String("function_call".to_string()))
        {
            assert_eq!(item["status"], Value::String("completed".to_string()));
        }
    }

    #[test]
    fn build_responses_payload_from_chat_merges_source_retention_and_context_fields() {
        let payload = serde_json::json!({
            "id": "resp_merge",
            "model": "glm-4.7",
            "choices": [
                {
                    "message": {
                        "role": "assistant",
                        "content": [
                            { "type": "text", "text": "hello" }
                        ]
                    }
                }
            ]
        });

        let context = serde_json::json!({
            "requestId": "req_merge",
            "toolsRaw": [],
            "metadata": {
                "toolCallIdStyle": "fc",
                "keep": true,
                "extraFields": { "__rcc_debug": "drop" }
            },
            "parallelToolCalls": true,
            "toolChoice": "required",
            "include": ["reasoning.encrypted_content"],
            "store": true,
            "stripHostManagedFields": false,
            "sourceForRetention": {
                "metadata": { "source": true },
                "temperature": 0.4,
                "top_p": 0.8,
                "prompt_cache_key": "cache-key",
                "reasoning": { "effort": "high" },
                "output": [
                    {
                        "id": "message_req_merge_1",
                        "type": "message",
                        "role": "assistant",
                        "content": [],
                        "summary": [{ "type": "summary_text", "text": "filled summary" }],
                        "encrypted_content": "encrypted"
                    }
                ]
            }
        });

        let output = build_responses_payload_from_chat_core(&payload, Some("req_merge"), &context)
            .expect("build responses payload");

        assert_eq!(output["request_id"], Value::String("req_merge".to_string()));
        assert_eq!(output["metadata"]["keep"], Value::Bool(true));
        assert!(output["metadata"].get("toolCallIdStyle").is_none());
        assert_eq!(output["temperature"], Value::from(0.4));
        assert_eq!(output["top_p"], Value::from(0.8));
        assert_eq!(
            output["prompt_cache_key"],
            Value::String("cache-key".to_string())
        );
        assert_eq!(
            output["reasoning"]["effort"],
            Value::String("high".to_string())
        );
        assert_eq!(output["parallel_tool_calls"], Value::Bool(true));
        assert_eq!(output["tool_choice"], Value::String("required".to_string()));
        assert_eq!(
            output["include"][0],
            Value::String("reasoning.encrypted_content".to_string())
        );
        assert_eq!(output["store"], Value::Bool(true));
        assert_eq!(
            output["output"][0]["summary"][0]["text"],
            Value::String("filled summary".to_string())
        );
        assert_eq!(
            output["output"][0]["encrypted_content"],
            Value::String("encrypted".to_string())
        );
    }

    #[test]
    fn build_responses_payload_from_chat_preserves_structured_message_reasoning() {
        let payload = serde_json::json!({
            "id": "resp_reasoning",
            "model": "gpt-5.2",
            "choices": [
                {
                    "message": {
                        "role": "assistant",
                        "content": "done",
                        "reasoning": {
                            "summary": [{ "type": "summary_text", "text": "summary-1" }],
                            "content": [
                                { "type": "reasoning_text", "text": "raw-1" },
                                { "type": "reasoning_text", "text": "raw-2" }
                            ],
                            "encrypted_content": "enc-1"
                        }
                    }
                }
            ]
        });

        let output = build_responses_payload_from_chat_core(
            &payload,
            Some("req_reasoning"),
            &serde_json::json!({ "toolsRaw": [] }),
        )
        .expect("build responses payload");

        let reasoning_item = output["output"]
            .as_array()
            .and_then(|items| {
                items
                    .iter()
                    .find(|item| item["type"] == Value::String("reasoning".to_string()))
            })
            .cloned()
            .expect("reasoning output item");
        assert_eq!(
            reasoning_item["summary"][0]["text"],
            Value::String("**Thinking** summary-1".to_string())
        );
        assert_eq!(
            reasoning_item["content"][0]["text"],
            Value::String("raw-1".to_string())
        );
        assert_eq!(
            reasoning_item["content"][1]["text"],
            Value::String("raw-2".to_string())
        );
        assert_eq!(
            reasoning_item["encrypted_content"],
            Value::String("enc-1".to_string())
        );
    }

    #[test]
    fn build_responses_payload_from_chat_backfills_reasoning_summary_from_content() {
        let payload = serde_json::json!({
            "id": "resp_reasoning_backfill",
            "model": "gpt-5.2",
            "choices": [
                {
                    "message": {
                        "role": "assistant",
                        "content": "done",
                        "reasoning": {
                            "content": [
                                { "type": "reasoning_text", "text": "raw-only-1" },
                                { "type": "reasoning_text", "text": "raw-only-2" }
                            ]
                        }
                    }
                }
            ]
        });

        let output = build_responses_payload_from_chat_core(
            &payload,
            Some("req_reasoning_backfill"),
            &serde_json::json!({ "toolsRaw": [] }),
        )
        .expect("build responses payload");

        let reasoning_item = output["output"]
            .as_array()
            .and_then(|items| {
                items
                    .iter()
                    .find(|item| item["type"] == Value::String("reasoning".to_string()))
            })
            .cloned()
            .expect("reasoning output item");
        assert_eq!(
            reasoning_item["summary"][0]["text"],
            Value::String("**Thinking** raw-only-1".to_string())
        );
        assert_eq!(
            reasoning_item["summary"][1]["text"],
            Value::String("raw-only-2".to_string())
        );
        assert!(reasoning_item.get("content").is_none());
    }

    #[test]
    fn build_responses_payload_from_chat_keeps_display_compatible_reasoning_summary() {
        let payload = serde_json::json!({
            "id": "resp_reasoning_header",
            "model": "gpt-5.2",
            "choices": [
                {
                    "message": {
                        "role": "assistant",
                        "content": "done",
                        "reasoning": {
                            "summary": [{ "type": "summary_text", "text": "**Plan**\n\ncheck files" }]
                        }
                    }
                }
            ]
        });

        let output = build_responses_payload_from_chat_core(
            &payload,
            Some("req_reasoning_header"),
            &serde_json::json!({ "toolsRaw": [] }),
        )
        .expect("build responses payload");

        let reasoning_item = output["output"]
            .as_array()
            .and_then(|items| {
                items
                    .iter()
                    .find(|item| item["type"] == Value::String("reasoning".to_string()))
            })
            .cloned()
            .expect("reasoning output item");
        assert_eq!(
            reasoning_item["summary"][0]["text"],
            Value::String("**Plan**\n\ncheck files".to_string())
        );
    }

    #[test]
    fn build_responses_payload_from_chat_normalizes_mid_body_bold_reasoning_summary() {
        let payload = serde_json::json!({
            "id": "resp_reasoning_mid_bold",
            "model": "gpt-5.2",
            "choices": [
                {
                    "message": {
                        "role": "assistant",
                        "content": "done",
                        "reasoning": {
                            "summary": [
                                {
                                    "type": "summary_text",
                                    "text": "先看现状。\\n\\n1. **重点** 先修复"
                                }
                            ]
                        }
                    }
                }
            ]
        });

        let output = build_responses_payload_from_chat_core(
            &payload,
            Some("req_reasoning_mid_bold"),
            &serde_json::json!({ "toolsRaw": [] }),
        )
        .expect("build responses payload");

        let reasoning_item = output["output"]
            .as_array()
            .and_then(|items| {
                items
                    .iter()
                    .find(|item| item["type"] == Value::String("reasoning".to_string()))
            })
            .cloned()
            .expect("reasoning output item");
        assert_eq!(
            reasoning_item["summary"][0]["text"],
            Value::String("**Thinking** 先看现状。\n\n1. **重点** 先修复".to_string())
        );
    }
}

#[napi]
pub fn resolve_sse_stream_mode_json(
    wants_stream: bool,
    client_protocol: String,
) -> NapiResult<String> {
    let output = resolve_sse_stream_mode(wants_stream, client_protocol.as_str());
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}
