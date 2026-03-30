use napi::bindgen_prelude::Result as NapiResult;
use napi_derive::napi;
use serde_json::{Map, Value};
use std::collections::{HashMap, HashSet};

const DEFAULT_SHELL_OUTPUT_MAX_CHARS: usize = 4000;
const SHELL_OUTPUT_TRUNCATION_SUFFIX: &str = "\n...[truncated]";
const DEFAULT_RESPONSES_TOOL_HISTORY_MAX_PAIRS: usize = 120;
const DEFAULT_RESPONSES_TOOL_HISTORY_MAX_CHARS: usize = 120_000;

#[derive(Clone, Copy)]
enum AnsiStripState {
    Normal,
    Esc,
    Csi,
}

fn resolve_shell_output_max_chars() -> usize {
    for key in [
        "RCC_SHELL_OUTPUT_MAX_CHARS",
        "ROUTECODEX_SHELL_OUTPUT_MAX_CHARS",
    ] {
        let Ok(raw) = std::env::var(key) else {
            continue;
        };
        let Ok(parsed) = raw.trim().parse::<usize>() else {
            continue;
        };
        if parsed > 0 {
            return parsed;
        }
    }
    DEFAULT_SHELL_OUTPUT_MAX_CHARS
}

fn resolve_responses_tool_history_max_pairs() -> usize {
    for key in [
        "RCC_RESPONSES_TOOL_HISTORY_MAX_PAIRS",
        "ROUTECODEX_RESPONSES_TOOL_HISTORY_MAX_PAIRS",
    ] {
        let Ok(raw) = std::env::var(key) else {
            continue;
        };
        let Ok(parsed) = raw.trim().parse::<usize>() else {
            continue;
        };
        if parsed > 0 {
            return parsed;
        }
    }
    DEFAULT_RESPONSES_TOOL_HISTORY_MAX_PAIRS
}

fn resolve_responses_tool_history_max_chars() -> usize {
    for key in [
        "RCC_RESPONSES_TOOL_HISTORY_MAX_CHARS",
        "ROUTECODEX_RESPONSES_TOOL_HISTORY_MAX_CHARS",
    ] {
        let Ok(raw) = std::env::var(key) else {
            continue;
        };
        let Ok(parsed) = raw.trim().parse::<usize>() else {
            continue;
        };
        if parsed > 0 {
            return parsed;
        }
    }
    DEFAULT_RESPONSES_TOOL_HISTORY_MAX_CHARS
}

fn strip_ansi_escape_sequences(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    let mut state = AnsiStripState::Normal;
    for ch in raw.chars() {
        state = match state {
            AnsiStripState::Normal => {
                if ch == '\u{1b}' {
                    AnsiStripState::Esc
                } else {
                    out.push(ch);
                    AnsiStripState::Normal
                }
            }
            AnsiStripState::Esc => {
                if ch == '[' {
                    AnsiStripState::Csi
                } else {
                    // Drop unknown ESC sequence byte and continue.
                    AnsiStripState::Normal
                }
            }
            AnsiStripState::Csi => {
                let code = ch as u32;
                if (0x40..=0x7E).contains(&code) {
                    AnsiStripState::Normal
                } else {
                    AnsiStripState::Csi
                }
            }
        };
    }
    out
}

fn truncate_chars(text: &str, max_chars: usize) -> String {
    if max_chars == 0 {
        return String::new();
    }
    let char_count = text.chars().count();
    if char_count <= max_chars {
        return text.to_string();
    }
    let clipped = text.chars().take(max_chars).collect::<String>();
    format!("{}{}", clipped, SHELL_OUTPUT_TRUNCATION_SUFFIX)
}

fn normalize_shell_like_output_text(raw: &str) -> String {
    let mut normalized = strip_ansi_escape_sequences(raw);
    if let Some(idx) = normalized.find("\nOutput:\n") {
        let prefix = &normalized[..idx];
        let has_shell_wrapper_prefix = normalized.starts_with("Command: ")
            || prefix.contains("Chunk ID:")
            || prefix.contains("Wall time:")
            || prefix.contains("Process exited with code")
            || prefix.contains("Original token count:");
        if has_shell_wrapper_prefix {
            normalized = normalized[idx + "\nOutput:\n".len()..].to_string();
        }
    }
    truncate_chars(normalized.as_str(), resolve_shell_output_max_chars())
}

fn is_responses_input_tool_item(item_type: &str) -> bool {
    matches!(item_type, "function_call" | "function_call_output")
}

fn read_responses_input_tool_call_id(item_row: &Map<String, Value>, item_type: &str) -> Option<String> {
    if item_type == "function_call_output" {
        read_trimmed_string(item_row.get("call_id"))
            .or_else(|| read_trimmed_string(item_row.get("tool_call_id")))
    } else {
        read_trimmed_string(item_row.get("call_id"))
            .or_else(|| read_trimmed_string(item_row.get("id")))
    }
}

fn estimate_responses_input_tool_item_chars(item_row: &Map<String, Value>, item_type: &str) -> usize {
    if item_type == "function_call_output" {
        return item_row
            .get("output")
            .and_then(|v| match v {
                Value::String(s) => Some(s.len()),
                Value::Null => Some(0),
                other => serde_json::to_string(other).ok().map(|s| s.len()),
            })
            .unwrap_or(0);
    }
    let mut total = 0usize;
    if let Some(name_len) = item_row.get("name").and_then(Value::as_str).map(|s| s.len()) {
        total += name_len;
    }
    if let Some(args_len) = item_row
        .get("arguments")
        .and_then(|v| match v {
            Value::String(s) => Some(s.len()),
            Value::Null => Some(0),
            other => serde_json::to_string(other).ok().map(|s| s.len()),
        })
    {
        total += args_len;
    }
    total
}

fn prune_responses_input_tool_history(items: &mut Vec<Value>) {
    let max_pairs = resolve_responses_tool_history_max_pairs();
    let max_chars = resolve_responses_tool_history_max_chars();
    if max_pairs == 0 || max_chars == 0 {
        return;
    }

    let mut call_order: Vec<String> = Vec::new();
    let mut seen_call_ids: HashSet<String> = HashSet::new();
    let mut call_chars: HashMap<String, usize> = HashMap::new();

    for item in items.iter() {
        let Some(item_row) = item.as_object() else {
            continue;
        };
        let item_type = read_trimmed_string(item_row.get("type"))
            .unwrap_or_default()
            .to_ascii_lowercase();
        if !is_responses_input_tool_item(item_type.as_str()) {
            continue;
        }
        let Some(call_id) = read_responses_input_tool_call_id(item_row, item_type.as_str()) else {
            continue;
        };
        if seen_call_ids.insert(call_id.clone()) {
            call_order.push(call_id.clone());
        }
        let item_chars = estimate_responses_input_tool_item_chars(item_row, item_type.as_str());
        *call_chars.entry(call_id).or_insert(0) += item_chars;
    }

    if call_order.len() <= max_pairs {
        let total_chars: usize = call_order
            .iter()
            .map(|id| call_chars.get(id).copied().unwrap_or(0))
            .sum();
        if total_chars <= max_chars {
            return;
        }
    }

    let mut keep_ids: HashSet<String> = HashSet::new();
    let mut kept_pairs = 0usize;
    let mut kept_chars = 0usize;
    for call_id in call_order.iter().rev() {
        let call_size = call_chars.get(call_id).copied().unwrap_or(0);
        let within_pair_budget = kept_pairs < max_pairs;
        let within_char_budget = kept_chars + call_size <= max_chars;
        if within_pair_budget && (within_char_budget || kept_pairs == 0) {
            keep_ids.insert(call_id.clone());
            kept_pairs += 1;
            kept_chars += call_size;
        }
    }

    if keep_ids.len() == call_order.len() {
        return;
    }

    items.retain(|item| {
        let Some(item_row) = item.as_object() else {
            return true;
        };
        let item_type = read_trimmed_string(item_row.get("type"))
            .unwrap_or_default()
            .to_ascii_lowercase();
        if !is_responses_input_tool_item(item_type.as_str()) {
            return true;
        }
        let Some(call_id) = read_responses_input_tool_call_id(item_row, item_type.as_str()) else {
            return true;
        };
        keep_ids.contains(call_id.as_str())
    });
}

fn estimate_message_tool_call_chars(call_row: &Map<String, Value>) -> usize {
    let mut total = 0usize;
    if let Some(fn_row) = call_row.get("function").and_then(Value::as_object) {
        if let Some(name_len) = fn_row.get("name").and_then(Value::as_str).map(|s| s.len()) {
            total += name_len;
        }
        if let Some(args_len) = fn_row
            .get("arguments")
            .and_then(|v| match v {
                Value::String(s) => Some(s.len()),
                Value::Null => Some(0),
                other => serde_json::to_string(other).ok().map(|s| s.len()),
            })
        {
            total += args_len;
        }
    }
    total
}

fn estimate_message_tool_content_chars(message_row: &Map<String, Value>) -> usize {
    message_row
        .get("content")
        .and_then(|v| match v {
            Value::String(s) => Some(s.len()),
            Value::Null => Some(0),
            other => serde_json::to_string(other).ok().map(|s| s.len()),
        })
        .unwrap_or(0)
}

fn assistant_message_content_is_empty(message_row: &Map<String, Value>) -> bool {
    match message_row.get("content") {
        None | Some(Value::Null) => true,
        Some(Value::String(s)) => s.trim().is_empty(),
        Some(Value::Array(arr)) => arr.is_empty(),
        _ => false,
    }
}

fn prune_message_tool_history(messages: &mut Vec<Value>) {
    let max_pairs = resolve_responses_tool_history_max_pairs();
    let max_chars = resolve_responses_tool_history_max_chars();
    if max_pairs == 0 || max_chars == 0 {
        return;
    }

    let mut call_order: Vec<String> = Vec::new();
    let mut seen_call_ids: HashSet<String> = HashSet::new();
    let mut call_chars: HashMap<String, usize> = HashMap::new();

    for message in messages.iter() {
        let Some(message_row) = message.as_object() else {
            continue;
        };
        let role = read_trimmed_string(message_row.get("role"))
            .unwrap_or_default()
            .to_ascii_lowercase();

        if role == "assistant" {
            let Some(tool_calls) = message_row.get("tool_calls").and_then(Value::as_array) else {
                continue;
            };
            for call in tool_calls {
                let Some(call_row) = call.as_object() else {
                    continue;
                };
                let Some(call_id) = read_trimmed_string(call_row.get("id"))
                    .or_else(|| read_trimmed_string(call_row.get("call_id")))
                else {
                    continue;
                };
                if seen_call_ids.insert(call_id.clone()) {
                    call_order.push(call_id.clone());
                }
                *call_chars.entry(call_id).or_insert(0) += estimate_message_tool_call_chars(call_row);
            }
            continue;
        }

        if role == "tool" {
            let Some(call_id) = read_trimmed_string(message_row.get("tool_call_id"))
                .or_else(|| read_trimmed_string(message_row.get("id")))
            else {
                continue;
            };
            if seen_call_ids.insert(call_id.clone()) {
                call_order.push(call_id.clone());
            }
            *call_chars.entry(call_id).or_insert(0) += estimate_message_tool_content_chars(message_row);
        }
    }

    if call_order.len() <= max_pairs {
        let total_chars: usize = call_order
            .iter()
            .map(|id| call_chars.get(id).copied().unwrap_or(0))
            .sum();
        if total_chars <= max_chars {
            return;
        }
    }

    let mut keep_ids: HashSet<String> = HashSet::new();
    let mut kept_pairs = 0usize;
    let mut kept_chars = 0usize;
    for call_id in call_order.iter().rev() {
        let call_size = call_chars.get(call_id).copied().unwrap_or(0);
        let within_pair_budget = kept_pairs < max_pairs;
        let within_char_budget = kept_chars + call_size <= max_chars;
        if within_pair_budget && (within_char_budget || kept_pairs == 0) {
            keep_ids.insert(call_id.clone());
            kept_pairs += 1;
            kept_chars += call_size;
        }
    }

    if keep_ids.len() == call_order.len() {
        return;
    }

    messages.retain_mut(|message| {
        let Some(message_row) = message.as_object_mut() else {
            return true;
        };
        let role = read_trimmed_string(message_row.get("role"))
            .unwrap_or_default()
            .to_ascii_lowercase();

        if role == "tool" {
            let call_id = read_trimmed_string(message_row.get("tool_call_id"))
                .or_else(|| read_trimmed_string(message_row.get("id")));
            return call_id
                .as_ref()
                .map(|id| keep_ids.contains(id.as_str()))
                .unwrap_or(true);
        }

        if role == "assistant" {
            let Some(tool_calls) = message_row
                .get_mut("tool_calls")
                .and_then(Value::as_array_mut)
            else {
                return true;
            };

            tool_calls.retain(|call| {
                let Some(call_row) = call.as_object() else {
                    return true;
                };
                let call_id = read_trimmed_string(call_row.get("id"))
                    .or_else(|| read_trimmed_string(call_row.get("call_id")));
                call_id
                    .as_ref()
                    .map(|id| keep_ids.contains(id.as_str()))
                    .unwrap_or(true)
            });

            if tool_calls.is_empty() && assistant_message_content_is_empty(message_row) {
                return false;
            }
        }

        true
    });
}

fn read_trimmed_string(value: Option<&Value>) -> Option<String> {
    let raw = value
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    if raw.is_empty() {
        return None;
    }
    Some(raw)
}

fn read_string_array_command(value: Option<&Value>) -> Option<String> {
    let parts = value.and_then(|v| v.as_array())?;
    let tokens: Vec<String> = parts
        .iter()
        .map(|item| match item {
            Value::String(v) => v.trim().to_string(),
            Value::Null => String::new(),
            other => other.to_string().trim().to_string(),
        })
        .filter(|token| !token.is_empty())
        .collect();
    if tokens.is_empty() {
        return None;
    }
    Some(tokens.join(" "))
}

fn read_command_text_value(value: Option<&Value>) -> Option<String> {
    read_trimmed_string(value).or_else(|| read_string_array_command(value))
}

fn read_nested_command_from_object(row: &Map<String, Value>) -> Option<String> {
    // Try direct fields first (most common case)
    let direct = read_command_text_value(row.get("cmd"))
        .or_else(|| read_command_text_value(row.get("command")))
        .or_else(|| read_command_text_value(row.get("script")))
        .or_else(|| read_command_text_value(row.get("toon")))
        .or_else(|| read_command_text_value(row.get("input")))
        .or_else(|| read_command_text_value(row.get("text")))
        .or_else(|| read_command_text_value(row.get("action")))
        .or_else(|| read_command_text_value(row.get("instruction")))
        .or_else(|| read_command_text_value(row.get("instructions")))
        .or_else(|| read_command_text_value(row.get("query")))
        .or_else(|| read_command_text_value(row.get("entry")));
    if direct.is_some() {
        return direct;
    }
    // Try nested objects (payload, data, args)
    row.get("payload")
        .and_then(Value::as_object)
        .and_then(read_nested_command_from_object)
        .or_else(|| row.get("data").and_then(Value::as_object).and_then(read_nested_command_from_object))
        .or_else(|| row.get("args").and_then(Value::as_object).and_then(read_nested_command_from_object))
}

fn parse_json_record(value: Option<&Value>) -> Option<Map<String, Value>> {
    match value {
        Some(Value::Object(row)) => Some(row.clone()),
        Some(Value::String(raw)) => {
            let trimmed = raw.trim();
            if trimmed.is_empty() {
                return Some(Map::new());
            }
            let parsed: Value = serde_json::from_str(trimmed).ok()?;
            parsed.as_object().cloned()
        }
        _ => None,
    }
}

fn read_command_from_args(args: &Map<String, Value>) -> Option<String> {
    let input = args.get("input");
    let direct = read_nested_command_from_object(args);
    if direct.is_some() {
        return direct;
    }
    input.and_then(Value::as_object)
        .and_then(read_nested_command_from_object)
        .or_else(|| {
            args.get("args")
                .and_then(Value::as_object)
                .and_then(read_nested_command_from_object)
        })
}

fn read_workdir_from_args(args: &Map<String, Value>) -> Option<String> {
    let input = args.get("input").and_then(|v| v.as_object());
    read_trimmed_string(args.get("workdir"))
        .or_else(|| read_trimmed_string(args.get("cwd")))
        .or_else(|| read_trimmed_string(args.get("workDir")))
        .or_else(|| input.and_then(|row| read_trimmed_string(row.get("workdir"))))
        .or_else(|| input.and_then(|row| read_trimmed_string(row.get("cwd"))))
}

fn is_invalid_shell_like_call(name: &str, arguments: Option<&Value>) -> bool {
    if !is_shell_like_tool_name(name) {
        return false;
    }
    let Some(args) = parse_json_record(arguments) else {
        return true;
    };
    read_command_from_args(&args).is_none()
}

fn collect_requested_tool_names(payload: &Value) -> HashSet<String> {
    let mut names = HashSet::new();
    let tools = payload
        .as_object()
        .and_then(|root| root.get("tools"))
        .and_then(|value| value.as_array())
        .cloned()
        .unwrap_or_default();

    for tool in tools {
        let row = match tool.as_object() {
            Some(v) => v,
            None => continue,
        };
        let fn_name = row
            .get("function")
            .and_then(|fn_node| fn_node.as_object())
            .and_then(|fn_row| read_trimmed_string(fn_row.get("name")));
        let name = fn_name.or_else(|| read_trimmed_string(row.get("name")));
        if let Some(normalized) = name {
            names.insert(normalized);
        }
    }

    names
}

fn resolve_shell_like_tool_name(raw_name: &str, requested_tool_names: &HashSet<String>) -> String {
    if requested_tool_names.is_empty() {
        return raw_name.to_string();
    }
    if requested_tool_names.contains(raw_name) {
        return raw_name.to_string();
    }
    raw_name.to_string()
}

fn is_shell_like_tool_name(raw_name: &str) -> bool {
    matches!(
        raw_name.to_ascii_lowercase().as_str(),
        "exec_command" | "shell_command" | "shell" | "bash" | "terminal"
    )
}

fn is_shell_like_tool_name_token(name: Option<String>) -> bool {
    let normalized = name.unwrap_or_default().trim().to_string();
    if normalized.is_empty() {
        return false;
    }
    is_shell_like_tool_name(normalized.as_str())
}

fn normalize_shell_like_function_call_arguments(
    raw_name: &str,
    raw_arguments: Option<&Value>,
    requested_tool_names: &HashSet<String>,
) -> Option<(String, String)> {
    if !is_shell_like_tool_name(raw_name) {
        return None;
    }

    let resolved_name = resolve_shell_like_tool_name(raw_name, requested_tool_names);
    let args = parse_json_record(raw_arguments)?;
    let cmd = read_command_from_args(&args)?;
    let mut next_args = args;
    next_args.insert("cmd".to_string(), Value::String(cmd.clone()));
    next_args.insert("command".to_string(), Value::String(cmd));
    if let Some(workdir) = read_workdir_from_args(&next_args) {
        next_args.insert("workdir".to_string(), Value::String(workdir));
    }
    next_args.remove("toon");

    let arguments = serde_json::to_string(&Value::Object(next_args))
        .unwrap_or_else(|_| "{\"cmd\":\"\",\"command\":\"\"}".to_string());
    Some((resolved_name, arguments))
}

fn normalize_message_tool_calls(
    payload: &mut Value,
    requested_tool_names: &HashSet<String>,
) {
    let Some(messages) = payload
        .as_object_mut()
        .and_then(|root| root.get_mut("messages"))
        .and_then(|node| node.as_array_mut())
    else {
        return;
    };

    let mut shell_tool_call_ids = HashSet::<String>::new();

    for message in messages.iter_mut() {
        let Some(message_row) = message.as_object_mut() else {
            continue;
        };
        let role = read_trimmed_string(message_row.get("role"))
            .unwrap_or_default()
            .to_ascii_lowercase();
        if role == "tool" {
            let tool_call_id = read_trimmed_string(message_row.get("tool_call_id"));
            let tool_name = read_trimmed_string(message_row.get("name"));
            let should_normalize = tool_call_id
                .as_ref()
                .map(|id| shell_tool_call_ids.contains(id))
                .unwrap_or(false)
                || tool_name
                    .as_ref()
                    .map(|name| is_shell_like_tool_name(name))
                    .unwrap_or(false);
            if should_normalize {
                if let Some(content) = message_row.get("content").and_then(Value::as_str) {
                    let normalized = normalize_shell_like_output_text(content);
                    if normalized != content {
                        message_row.insert("content".to_string(), Value::String(normalized));
                    }
                }
            }
            continue;
        }
        if role != "assistant" {
            continue;
        }
        let Some(tool_calls) = message_row
            .get_mut("tool_calls")
            .and_then(|node| node.as_array_mut())
        else {
            continue;
        };

        for call in tool_calls.iter_mut() {
            let Some(call_row) = call.as_object_mut() else {
                continue;
            };
            let Some(fn_row) = call_row
                .get_mut("function")
                .and_then(|node| node.as_object_mut())
            else {
                continue;
            };
            let Some(raw_name) = read_trimmed_string(fn_row.get("name")) else {
                continue;
            };
            let Some((resolved_name, arguments)) = normalize_shell_like_function_call_arguments(
                raw_name.as_str(),
                fn_row.get("arguments"),
                requested_tool_names,
            ) else {
                continue;
            };
            if resolved_name != raw_name {
                fn_row.insert("name".to_string(), Value::String(resolved_name));
            }
            fn_row.insert("arguments".to_string(), Value::String(arguments));
            if let Some(call_id) = read_trimmed_string(call_row.get("id"))
                .or_else(|| read_trimmed_string(call_row.get("call_id")))
            {
                shell_tool_call_ids.insert(call_id);
            }
        }
    }

    prune_message_tool_history(messages);
}

fn normalize_responses_input_function_calls(
    payload: &mut Value,
    requested_tool_names: &HashSet<String>,
) {
    let Some(input_items) = payload
        .as_object_mut()
        .and_then(|root| root.get_mut("input"))
        .and_then(|node| node.as_array_mut())
    else {
        return;
    };

    let mut dropped_call_ids: HashSet<String> = HashSet::new();
    let mut shell_like_call_ids: HashSet<String> = HashSet::new();
    let mut normalized_items = Vec::<Value>::with_capacity(input_items.len());

    for mut item in std::mem::take(input_items) {
        if let Some(item_row) = item.as_object_mut() {
            let item_type = read_trimmed_string(item_row.get("type"))
                .unwrap_or_default()
                .to_ascii_lowercase();
            if item_type == "function_call" {
                if let Some(raw_name) = read_trimmed_string(item_row.get("name")) {
                    if let Some((resolved_name, arguments)) =
                        normalize_shell_like_function_call_arguments(
                            raw_name.as_str(),
                            item_row.get("arguments"),
                            requested_tool_names,
                        )
                    {
                        if resolved_name != raw_name {
                            item_row.insert("name".to_string(), Value::String(resolved_name));
                        }
                        item_row.insert("arguments".to_string(), Value::String(arguments));
                        let call_id = read_trimmed_string(item_row.get("call_id"))
                            .or_else(|| read_trimmed_string(item_row.get("id")));
                        if let Some(call_id) = call_id {
                            shell_like_call_ids.insert(call_id);
                        }
                    } else if is_invalid_shell_like_call(raw_name.as_str(), item_row.get("arguments")) {
                        if let Some(call_id) = read_trimmed_string(item_row.get("call_id"))
                            .or_else(|| read_trimmed_string(item_row.get("id")))
                        {
                            dropped_call_ids.insert(call_id);
                        }
                        // Drop malformed shell-like function_call item. Keep shape-only policy:
                        // no synthetic command inference, no semantic rewrite.
                        continue;
                    }
                }
            } else if item_type == "function_call_output" {
                let call_id = read_trimmed_string(item_row.get("call_id"))
                    .or_else(|| read_trimmed_string(item_row.get("tool_call_id")));
                if let Some(call_id) = call_id {
                    if dropped_call_ids.contains(call_id.as_str()) {
                        // Keep request chain coherent: remove orphan output for a dropped malformed call.
                        continue;
                    }
                    if shell_like_call_ids.contains(call_id.as_str()) {
                        if let Some(raw_output) = item_row.get("output").and_then(Value::as_str) {
                            let normalized = normalize_shell_like_output_text(raw_output);
                            if normalized != raw_output {
                                item_row.insert("output".to_string(), Value::String(normalized));
                            }
                        }
                    }
                }
            }
        }
        normalized_items.push(item);
    }

    prune_responses_input_tool_history(&mut normalized_items);
    *input_items = normalized_items;
}

pub(crate) fn normalize_shell_like_tool_calls_before_governance(payload: &mut Value) {
    let requested_tool_names = collect_requested_tool_names(payload);
    normalize_message_tool_calls(payload, &requested_tool_names);
    normalize_responses_input_function_calls(payload, &requested_tool_names);
}

#[napi]
pub fn normalize_shell_like_tool_calls_before_governance_json(
    payload_json: String,
) -> NapiResult<String> {
    let mut payload: Value =
        serde_json::from_str(&payload_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    normalize_shell_like_tool_calls_before_governance(&mut payload);
    serde_json::to_string(&payload).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi]
pub fn is_shell_like_tool_name_token_json(name_json: String) -> NapiResult<String> {
    let name: Option<String> =
        serde_json::from_str(&name_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let output = is_shell_like_tool_name_token(name);
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::normalize_shell_like_tool_calls_before_governance;
    use serde_json::{json, Value};

    #[test]
    fn normalizes_exec_command_from_input_string_shape() {
        let mut payload = json!({
          "tools": [{ "type": "function", "function": { "name": "exec_command" } }],
          "messages": [
            {
              "role": "assistant",
              "tool_calls": [
                {
                  "id": "call_1",
                  "type": "function",
                  "function": {
                    "name": "exec_command",
                    "arguments": "{\"input\":\"pwd\"}"
                  }
                }
              ]
            }
          ]
        });

        normalize_shell_like_tool_calls_before_governance(&mut payload);
        let args_text = payload["messages"][0]["tool_calls"][0]["function"]["arguments"]
            .as_str()
            .expect("arguments text");
        let args: Value = serde_json::from_str(args_text).expect("args object");
        assert_eq!(args["cmd"], "pwd");
        assert_eq!(args["command"], "pwd");
    }

    #[test]
    fn normalizes_exec_command_from_nested_args_object_shape() {
        let mut payload = json!({
          "tools": [{ "type": "function", "function": { "name": "exec_command" } }],
          "messages": [
            {
              "role": "assistant",
              "tool_calls": [
                {
                  "id": "call_2",
                  "type": "function",
                  "function": {
                    "name": "exec_command",
                    "arguments": "{\"args\":{\"command\":\"git status\"},\"cwd\":\"/repo\"}"
                  }
                }
              ]
            }
          ]
        });

        normalize_shell_like_tool_calls_before_governance(&mut payload);
        let args_text = payload["messages"][0]["tool_calls"][0]["function"]["arguments"]
            .as_str()
            .expect("arguments text");
        let args: Value = serde_json::from_str(args_text).expect("args object");
        assert_eq!(args["cmd"], "git status");
        assert_eq!(args["command"], "git status");
        assert_eq!(args["workdir"], "/repo");
    }

    #[test]
    fn normalizes_exec_command_inside_responses_input_function_call_items() {
        let mut payload = json!({
          "tools": [{ "type": "function", "function": { "name": "exec_command" } }],
          "input": [
            {
              "type": "function_call",
              "call_id": "fc_1",
              "name": "exec_command",
              "arguments": "{\"args\":{\"command\":\"npm test\"},\"cwd\":\"/workspace\"}"
            }
          ]
        });

        normalize_shell_like_tool_calls_before_governance(&mut payload);
        let args_text = payload["input"][0]["arguments"]
            .as_str()
            .expect("arguments text");
        let args: Value = serde_json::from_str(args_text).expect("args object");
        assert_eq!(args["cmd"], "npm test");
        assert_eq!(args["command"], "npm test");
        assert_eq!(args["workdir"], "/workspace");
    }

    #[test]
    fn normalizes_exec_command_from_action_field_shape() {
        let mut payload = json!({
          "tools": [{ "type": "function", "function": { "name": "exec_command" } }],
          "messages": [
            {
              "role": "assistant",
              "tool_calls": [
                {
                  "id": "call_action",
                  "type": "function",
                  "function": {
                    "name": "exec_command",
                    "arguments": "{\"action\":\"ls -la\"}"
                  }
                }
              ]
            }
          ]
        });

        normalize_shell_like_tool_calls_before_governance(&mut payload);
        let args_text = payload["messages"][0]["tool_calls"][0]["function"]["arguments"]
            .as_str()
            .expect("arguments text");
        let args: Value = serde_json::from_str(args_text).expect("args object");
        assert_eq!(args["cmd"], "ls -la");
        assert_eq!(args["command"], "ls -la");
    }

    #[test]
    fn leaves_exec_command_unchanged_when_cmd_missing() {
        let mut payload = json!({
          "tools": [{ "type": "function", "function": { "name": "exec_command" } }],
          "messages": [
            {
              "role": "assistant",
              "tool_calls": [
                {
                  "id": "call_missing",
                  "type": "function",
                  "function": {
                    "name": "exec_command",
                    "arguments": "{}"
                  }
                }
              ]
            }
          ]
        });

        normalize_shell_like_tool_calls_before_governance(&mut payload);
        let args_text = payload["messages"][0]["tool_calls"][0]["function"]["arguments"]
            .as_str()
            .expect("arguments text");
        assert_eq!(args_text, "{}");
    }

    #[test]
    fn drops_invalid_exec_command_items_and_orphan_outputs() {
        let mut payload = json!({
          "tools": [{ "type": "function", "function": { "name": "exec_command" } }],
          "input": [
            {
              "type": "function_call",
              "call_id": "fc_reasoning_choice_1_1",
              "name": "exec_command",
              "arguments": "{}"
            },
            {
              "type": "function_call_output",
              "call_id": "fc_reasoning_choice_1_1",
              "output": "failed to parse function arguments: missing field `cmd` at line 1 column 2"
            },
            {
              "type": "function_call",
              "call_id": "call_keep",
              "name": "exec_command",
              "arguments": "{\"cmd\":\"pwd\"}"
            },
            {
              "type": "function_call_output",
              "call_id": "call_keep",
              "output": "pwd"
            }
          ]
        });

        normalize_shell_like_tool_calls_before_governance(&mut payload);
        let items = payload["input"].as_array().expect("input items");
        assert_eq!(items.len(), 2);
        assert_eq!(items[0]["call_id"], "call_keep");
        assert_eq!(items[1]["call_id"], "call_keep");
        let args_text = items[0]["arguments"].as_str().expect("normalized args");
        assert!(args_text.contains("\"cmd\":\"pwd\""));
    }

    #[test]
    fn drops_exec_command_items_with_parameter_tag_pollution_shape() {
        let mut payload = json!({
          "tools": [{ "type": "function", "function": { "name": "exec_command" } }],
          "input": [
            {
              "type": "function_call",
              "call_id": "call_bad",
              "name": "exec_command",
              "arguments": "{\"cmd<arg_value>cd /repo && git status</arg_value><arg_key>command\":\"cd /repo && git status\"}"
            },
            {
              "type": "function_call_output",
              "call_id": "call_bad",
              "output": "failed to parse function arguments: missing field `cmd` at line 1 column 1117"
            },
            {
              "type": "function_call",
              "call_id": "call_good",
              "name": "exec_command",
              "arguments": "{\"command\":\"pwd\"}"
            },
            {
              "type": "function_call_output",
              "call_id": "call_good",
              "output": "pwd"
            }
          ]
        });

        normalize_shell_like_tool_calls_before_governance(&mut payload);
        let items = payload["input"].as_array().expect("input items");
        assert_eq!(items.len(), 2);
        assert_eq!(items[0]["call_id"], "call_good");
        let args_text = items[0]["arguments"].as_str().expect("normalized args");
        let args: Value = serde_json::from_str(args_text).expect("args object");
        assert_eq!(args["cmd"], "pwd");
        assert_eq!(args["command"], "pwd");
    }

    #[test]
    fn normalizes_shell_like_function_call_output_shape() {
        let mut payload = json!({
          "tools": [{ "type": "function", "function": { "name": "exec_command" } }],
          "input": [
            {
              "type": "function_call",
              "call_id": "call_exec_1",
              "name": "exec_command",
              "arguments": "{\"cmd\":\"echo ok\"}"
            },
            {
              "type": "function_call_output",
              "call_id": "call_exec_1",
              "output": "Command: /bin/bash -lc 'echo ok'\nChunk ID: test\nWall time: 0.1s\nProcess exited with code 0\nOriginal token count: 12\nOutput:\n\u{001b}[32mok\u{001b}[0m\n"
            }
          ]
        });

        normalize_shell_like_tool_calls_before_governance(&mut payload);
        let out = payload["input"][1]["output"].as_str().expect("output text");
        assert_eq!(out, "ok\n");
    }

    #[test]
    fn normalizes_shell_like_output_with_plain_bash_prefix() {
        let mut payload = json!({
          "tools": [{ "type": "function", "function": { "name": "exec_command" } }],
          "input": [
            {
              "type": "function_call",
              "call_id": "call_exec_bash_plain",
              "name": "exec_command",
              "arguments": "{\"cmd\":\"echo done\"}"
            },
            {
              "type": "function_call_output",
              "call_id": "call_exec_bash_plain",
              "output": "Command: bash -lc 'echo done'\nOutput:\ndone\n"
            }
          ]
        });

        normalize_shell_like_tool_calls_before_governance(&mut payload);
        let out = payload["input"][1]["output"].as_str().expect("output text");
        assert_eq!(out, "done\n");
    }

    #[test]
    fn truncates_shell_like_function_call_output_to_budget() {
        let very_long = "0123456789".repeat(420);
        let mut payload = json!({
          "tools": [{ "type": "function", "function": { "name": "exec_command" } }],
          "input": [
            {
              "type": "function_call",
              "call_id": "call_exec_2",
              "name": "exec_command",
              "arguments": "{\"cmd\":\"cat long.txt\"}"
            },
            {
              "type": "function_call_output",
              "call_id": "call_exec_2",
              "output": format!("Command: /bin/zsh -lc 'cat long.txt'\nOutput:\n{}", very_long)
            }
          ]
        });

        normalize_shell_like_tool_calls_before_governance(&mut payload);
        let out = payload["input"][1]["output"].as_str().expect("output text");
        assert!(out.starts_with("0123456789"));
        assert!(out.ends_with("\n...[truncated]"));
        assert!(out.len() < very_long.len());
    }

    #[test]
    fn normalizes_tool_role_message_content_for_shell_call() {
        let mut payload = json!({
          "tools": [{ "type": "function", "function": { "name": "exec_command" } }],
          "messages": [
            {
              "role": "assistant",
              "tool_calls": [
                {
                  "id": "call_tool_msg_1",
                  "type": "function",
                  "function": {
                    "name": "exec_command",
                    "arguments": "{\"cmd\":\"echo ok\"}"
                  }
                }
              ]
            },
            {
              "role": "tool",
              "name": "exec_command",
              "tool_call_id": "call_tool_msg_1",
              "content": "Command: /bin/bash -lc 'echo ok'\nChunk ID: x\nOutput:\n\u{001b}[32mok\u{001b}[0m\n"
            }
          ]
        });

        normalize_shell_like_tool_calls_before_governance(&mut payload);
        let out = payload["messages"][1]["content"]
            .as_str()
            .expect("tool content");
        assert_eq!(out, "ok\n");
    }

    #[test]
    fn normalizes_shell_like_output_with_chunk_prefix_shape() {
        let mut payload = json!({
          "tools": [{ "type": "function", "function": { "name": "exec_command" } }],
          "input": [
            {
              "type": "function_call",
              "call_id": "call_exec_chunk_prefix",
              "name": "exec_command",
              "arguments": "{\"cmd\":\"echo ok\"}"
            },
            {
              "type": "function_call_output",
              "call_id": "call_exec_chunk_prefix",
              "output": "Chunk ID: abc\nWall time: 0.1s\nProcess exited with code 0\nOutput:\n\u{001b}[32mok\u{001b}[0m\n"
            }
          ]
        });

        normalize_shell_like_tool_calls_before_governance(&mut payload);
        let out = payload["input"][1]["output"].as_str().expect("output text");
        assert_eq!(out, "ok\n");
    }

    #[test]
    fn prunes_old_responses_tool_history_pairs() {
        let mut input = Vec::<Value>::new();
        for idx in 0..130 {
            let call_id = format!("call_{}", idx);
            input.push(json!({
              "type": "function_call",
              "call_id": call_id,
              "name": "exec_command",
              "arguments": format!("{{\"cmd\":\"echo {}\"}}", idx)
            }));
            input.push(json!({
              "type": "function_call_output",
              "call_id": format!("call_{}", idx),
              "output": format!("Output: {}", idx)
            }));
        }
        let mut payload = json!({
          "tools": [{ "type": "function", "function": { "name": "exec_command" } }],
          "input": input
        });

        normalize_shell_like_tool_calls_before_governance(&mut payload);
        let items = payload["input"].as_array().expect("input array");
        let function_calls = items
            .iter()
            .filter(|entry| entry.get("type").and_then(Value::as_str) == Some("function_call"))
            .count();
        let function_outputs = items
            .iter()
            .filter(|entry| entry.get("type").and_then(Value::as_str) == Some("function_call_output"))
            .count();

        assert_eq!(function_calls, 120);
        assert_eq!(function_outputs, 120);
        assert_eq!(
            items
                .iter()
                .find(|entry| entry.get("call_id").and_then(Value::as_str) == Some("call_0")),
            None
        );
        assert!(
            items
                .iter()
                .any(|entry| entry.get("call_id").and_then(Value::as_str) == Some("call_129"))
        );
    }

    #[test]
    fn prunes_old_message_tool_history_pairs() {
        let mut messages = Vec::<Value>::new();
        for idx in 0..130 {
            let call_id = format!("call_msg_{}", idx);
            messages.push(json!({
              "role": "assistant",
              "content": "",
              "tool_calls": [{
                "id": call_id,
                "type": "function",
                "function": {
                  "name": "exec_command",
                  "arguments": format!("{{\"cmd\":\"echo {}\"}}", idx)
                }
              }]
            }));
            messages.push(json!({
              "role": "tool",
              "name": "exec_command",
              "tool_call_id": format!("call_msg_{}", idx),
              "content": format!("Output: {}", idx)
            }));
        }

        let mut payload = json!({
          "tools": [{ "type": "function", "function": { "name": "exec_command" } }],
          "messages": messages
        });

        normalize_shell_like_tool_calls_before_governance(&mut payload);
        let entries = payload["messages"].as_array().expect("messages array");
        let assistant_with_tool_calls = entries
            .iter()
            .filter(|entry| {
                entry.get("role").and_then(Value::as_str) == Some("assistant")
                    && entry
                        .get("tool_calls")
                        .and_then(Value::as_array)
                        .map(|calls| !calls.is_empty())
                        .unwrap_or(false)
            })
            .count();
        let tool_messages = entries
            .iter()
            .filter(|entry| entry.get("role").and_then(Value::as_str) == Some("tool"))
            .count();

        assert_eq!(assistant_with_tool_calls, 120);
        assert_eq!(tool_messages, 120);
        assert!(
            entries
                .iter()
                .any(|entry| entry.get("tool_call_id").and_then(Value::as_str) == Some("call_msg_129"))
        );
        assert!(
            !entries
                .iter()
                .any(|entry| entry.get("tool_call_id").and_then(Value::as_str) == Some("call_msg_0"))
        );
    }
}
