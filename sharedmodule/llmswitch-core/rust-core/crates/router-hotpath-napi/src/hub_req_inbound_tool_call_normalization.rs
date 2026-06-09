use napi::bindgen_prelude::Result as NapiResult;
use napi_derive::napi;
use regex::Regex;
use serde_json::{Map, Value};
use std::collections::HashSet;

use crate::shared_json_utils::read_trimmed_string;
use crate::shared_tooling::{strip_provider_tool_sentinel_residue, value_to_string};

fn normalize_shell_like_output_text(raw: &str) -> String {
    raw.to_string()
}

fn normalize_apply_patch_output_text(raw: &str) -> String {
    const APPLY_PATCH_ERROR_TEXT: &str = "APPLY_PATCH_ERROR: apply_patch did not apply. Retry with apply_patch only. Send one raw patch string in canonical *** Begin Patch / *** End Patch grammar. Use workspace-relative paths inside patch headers (for example *** Update File: src/main.ts or *** Add File: tmp/example.txt). Do not use absolute paths. Do not switch to exec_command or shell writes.";
    const APPLY_PATCH_RESULT_TEXT: &str = "APPLY_PATCH_RESULT: apply_patch applied. Continue future apply_patch calls with one raw patch string and workspace-relative paths inside patch headers. Keep using apply_patch for line edits instead of switching tools.";

    let text = raw.replace("\r\n", "\n").replace('\r', "\n");
    let trimmed = text.trim();
    if trimmed.starts_with("APPLY_PATCH_ERROR:") {
        return APPLY_PATCH_ERROR_TEXT.to_string();
    }

    if let Ok(Value::Object(row)) = serde_json::from_str::<Value>(trimmed) {
        let status = row
            .get("status")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim()
            .to_ascii_uppercase();
        if row.get("ok").and_then(Value::as_bool) == Some(true)
            || status == "APPLY_PATCH_APPLIED"
            || status == "APPLY_PATCH_RESULT"
        {
            return APPLY_PATCH_RESULT_TEXT.to_string();
        }
        if row.get("ok").and_then(Value::as_bool) == Some(false)
            || status == "APPLY_PATCH_FAILED"
            || status == "APPLY_PATCH_ERROR"
        {
            return APPLY_PATCH_ERROR_TEXT.to_string();
        }
    }

    let lowered = text.to_ascii_lowercase();
    if lowered.trim() == "aborted" {
        return APPLY_PATCH_ERROR_TEXT.to_string();
    }
    if matches!(lowered.trim(), "done" | "done!") {
        return APPLY_PATCH_RESULT_TEXT.to_string();
    }
    if !(lowered.contains("apply_patch") || lowered.contains("patch")) {
        return raw.to_string();
    }
    if lowered.contains("verification failed")
        || lowered.contains("invalid patch")
        || lowered.contains("missing")
        || lowered.contains("failed")
        || lowered.contains("error")
    {
        return APPLY_PATCH_ERROR_TEXT.to_string();
    }
    raw.to_string()
}

fn is_apply_patch_tool_name(raw_name: &str) -> bool {
    raw_name.trim().eq_ignore_ascii_case("apply_patch")
}

fn is_synthetic_apply_patch_guard_call(arguments: Option<&Value>) -> bool {
    let Some(args) = parse_json_record(arguments) else {
        return false;
    };
    args.get("patch")
        .or_else(|| args.get("input"))
        .and_then(Value::as_str)
        .map(|raw| raw.contains("__APPLY_PATCH_ERROR__/") || raw.contains("APPLY_PATCH_ERROR:"))
        .unwrap_or(false)
}

fn read_function_call_name(item_row: &Map<String, Value>) -> Option<String> {
    read_trimmed_string(item_row.get("name")).or_else(|| {
        item_row
            .get("function")
            .and_then(Value::as_object)
            .and_then(|function| read_trimmed_string(function.get("name")))
    })
}

fn is_namespace_mcp_aggregator_call_name(name: &str) -> bool {
    let normalized = name.trim();
    normalized.starts_with("mcp__") && !normalized[5..].contains("__")
}

fn prune_responses_input_tool_history(items: &mut Vec<Value>) {
    let mut dropped_call_ids = HashSet::<String>::new();
    let mut normalized_items = Vec::<Value>::with_capacity(items.len());

    for item in std::mem::take(items) {
        let item_obj = item.as_object();
        let item_type = item_obj
            .and_then(|row| read_trimmed_string(row.get("type")))
            .unwrap_or_default()
            .to_ascii_lowercase();

        if item_type == "function_call" || item_type == "tool_call" {
            if let Some(row) = item_obj {
                if read_function_call_name(row)
                    .as_deref()
                    .map(is_namespace_mcp_aggregator_call_name)
                    .unwrap_or(false)
                {
                    if let Some(call_id) = read_trimmed_string(row.get("call_id"))
                        .or_else(|| read_trimmed_string(row.get("tool_call_id")))
                        .or_else(|| read_trimmed_string(row.get("id")))
                    {
                        dropped_call_ids.insert(call_id);
                    }
                    continue;
                }
            }
        }

        if item_type == "function_call_output"
            || item_type == "tool_result"
            || item_type == "tool_message"
        {
            if let Some(row) = item_obj {
                if read_trimmed_string(row.get("call_id"))
                    .or_else(|| read_trimmed_string(row.get("tool_call_id")))
                    .or_else(|| read_trimmed_string(row.get("tool_use_id")))
                    .or_else(|| read_trimmed_string(row.get("id")))
                    .map(|call_id| dropped_call_ids.contains(call_id.as_str()))
                    .unwrap_or(false)
                {
                    continue;
                }
            }
        }

        normalized_items.push(item);
    }

    *items = normalized_items;
}

fn prune_message_tool_history(messages: &mut Vec<Value>) {
    let mut dropped_call_ids = HashSet::<String>::new();
    let mut normalized_messages = Vec::<Value>::with_capacity(messages.len());

    for mut message in std::mem::take(messages) {
        let mut drop_message = false;
        if let Some(message_row) = message.as_object_mut() {
            let role = read_trimmed_string(message_row.get("role"))
                .unwrap_or_default()
                .to_ascii_lowercase();

            if role == "assistant" {
                let content_empty = read_trimmed_string(message_row.get("content")).is_none();
                if let Some(tool_calls) = message_row
                    .get_mut("tool_calls")
                    .and_then(|node| node.as_array_mut())
                {
                    let mut kept_tool_calls = Vec::<Value>::with_capacity(tool_calls.len());
                    for call in std::mem::take(tool_calls) {
                        let drop_call = call
                            .as_object()
                            .and_then(|call_row| {
                                let function_row =
                                    call_row.get("function").and_then(Value::as_object)?;
                                let raw_name = read_trimmed_string(function_row.get("name"))?;
                                if !is_invalid_shell_like_call(
                                    raw_name.as_str(),
                                    function_row.get("arguments"),
                                ) && !is_invalid_write_stdin_call(
                                    raw_name.as_str(),
                                    function_row.get("arguments"),
                                ) && !(is_apply_patch_tool_name(raw_name.as_str())
                                    && is_synthetic_apply_patch_guard_call(
                                        function_row.get("arguments"),
                                    ))
                                    && !is_namespace_mcp_aggregator_call_name(raw_name.as_str())
                                {
                                    return Some(false);
                                }
                                let call_id = read_trimmed_string(call_row.get("id"))
                                    .or_else(|| read_trimmed_string(call_row.get("call_id")));
                                if let Some(call_id) = call_id {
                                    dropped_call_ids.insert(call_id);
                                }
                                Some(true)
                            })
                            .unwrap_or(false);
                        if !drop_call {
                            kept_tool_calls.push(call);
                        }
                    }
                    *tool_calls = kept_tool_calls;
                    if tool_calls.is_empty() {
                        message_row.remove("tool_calls");
                        if content_empty {
                            drop_message = true;
                        }
                    }
                }
            } else if role == "tool" {
                let call_id = read_trimmed_string(message_row.get("tool_call_id"))
                    .or_else(|| read_trimmed_string(message_row.get("call_id")));
                if let Some(call_id) = call_id {
                    if dropped_call_ids.contains(call_id.as_str()) {
                        drop_message = true;
                    }
                }
            }
        }

        if !drop_message {
            normalized_messages.push(message);
        }
    }

    *messages = normalized_messages;
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
        .or_else(|| {
            row.get("data")
                .and_then(Value::as_object)
                .and_then(read_nested_command_from_object)
        })
        .or_else(|| {
            row.get("args")
                .and_then(Value::as_object)
                .and_then(read_nested_command_from_object)
        })
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
    input
        .and_then(Value::as_object)
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

fn strip_provider_tool_sentinel_from_value(value: &mut Value) {
    match value {
        Value::String(text) => {
            let cleaned = strip_provider_tool_sentinel_residue(text.as_str());
            if cleaned != *text {
                *text = cleaned;
            }
        }
        Value::Array(items) => {
            for item in items {
                strip_provider_tool_sentinel_from_value(item);
            }
        }
        Value::Object(row) => {
            for item in row.values_mut() {
                strip_provider_tool_sentinel_from_value(item);
            }
        }
        _ => {}
    }
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

fn is_write_stdin_tool_name(raw_name: &str) -> bool {
    matches!(
        raw_name.trim().to_ascii_lowercase().as_str(),
        "write_stdin" | "write.stdin"
    )
}

fn is_shell_like_tool_name_token(name: Option<String>) -> bool {
    let normalized = name.unwrap_or_default().trim().to_string();
    if normalized.is_empty() {
        return false;
    }
    is_shell_like_tool_name(normalized.as_str())
}

fn read_write_stdin_session_id(args: &Map<String, Value>) -> Option<i64> {
    args.get("session_id")
        .or_else(|| args.get("sessionId"))
        .and_then(|entry| match entry {
            Value::Number(number) => number.as_i64(),
            Value::String(text) => text.trim().parse::<i64>().ok(),
            _ => None,
        })
}

fn read_write_stdin_chars(args: &Map<String, Value>) -> Option<String> {
    args.get("chars")
        .or_else(|| args.get("text"))
        .or_else(|| args.get("input"))
        .or_else(|| args.get("data"))
        .map(value_to_string)
}

fn try_extract_write_stdin_session_id_from_raw(raw: &str) -> Option<i64> {
    Regex::new(r#""(?:session_id|sessionId)"\s*:\s*"?(-?\d+)"?"#)
        .ok()?
        .captures(raw)
        .and_then(|caps| caps.get(1).map(|m| m.as_str().trim().to_string()))
        .and_then(|text| text.parse::<i64>().ok())
}

fn normalize_write_stdin_function_call_arguments(
    raw_name: &str,
    raw_arguments: Option<&Value>,
) -> Option<(String, String)> {
    if !is_write_stdin_tool_name(raw_name) {
        return None;
    }

    let strict_args = parse_json_record(raw_arguments);
    let session_id = strict_args
        .as_ref()
        .and_then(read_write_stdin_session_id)
        .or_else(|| match raw_arguments {
            Some(Value::String(raw)) => try_extract_write_stdin_session_id_from_raw(raw),
            _ => None,
        })?;

    let chars = strict_args
        .as_ref()
        .and_then(read_write_stdin_chars)
        .unwrap_or_default();

    let mut next_args = Map::new();
    next_args.insert("session_id".to_string(), Value::Number(session_id.into()));
    next_args.insert("chars".to_string(), Value::String(chars));

    let arguments = serde_json::to_string(&Value::Object(next_args)).ok()?;
    Some(("write_stdin".to_string(), arguments))
}

fn is_invalid_write_stdin_call(name: &str, arguments: Option<&Value>) -> bool {
    if !is_write_stdin_tool_name(name) {
        return false;
    }
    match parse_json_record(arguments) {
        Some(args) => read_write_stdin_session_id(&args).is_none(),
        None => true,
    }
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
    let cmd = strip_provider_tool_sentinel_residue(read_command_from_args(&args)?.as_str())
        .trim()
        .to_string();
    if cmd.is_empty() {
        return None;
    }
    let mut next_args = args;
    for item in next_args.values_mut() {
        strip_provider_tool_sentinel_from_value(item);
    }
    let source_is_shell_alias = matches!(
        resolved_name.trim().to_ascii_lowercase().as_str(),
        "shell_command" | "shell" | "bash" | "terminal"
    );
    let emit_cmd = !source_is_shell_alias;
    if emit_cmd {
        next_args.insert("cmd".to_string(), Value::String(cmd.clone()));
    } else {
        next_args.remove("cmd");
    }
    if source_is_shell_alias {
        next_args.insert("command".to_string(), Value::String(cmd));
    } else {
        next_args.remove("command");
    }
    if let Some(workdir) = read_workdir_from_args(&next_args) {
        next_args.insert("workdir".to_string(), Value::String(workdir));
    }
    next_args.remove("toon");

    let arguments = serde_json::to_string(&Value::Object(next_args))
        .unwrap_or_else(|_| "{\"cmd\":\"\"}".to_string());
    Some((resolved_name, arguments))
}

fn normalize_message_tool_calls(
    payload: &mut Value,
    requested_tool_names: &HashSet<String>,
) -> Result<(), napi::Error> {
    let Some(messages) = payload
        .as_object_mut()
        .and_then(|root| root.get_mut("messages"))
        .and_then(|node| node.as_array_mut())
    else {
        return Ok(());
    };

    let mut shell_tool_call_ids = HashSet::<String>::new();
    let mut apply_patch_tool_call_ids = HashSet::<String>::new();

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
            let should_normalize_shell = tool_call_id
                .as_ref()
                .map(|id| shell_tool_call_ids.contains(id))
                .unwrap_or(false)
                || tool_name
                    .as_ref()
                    .map(|name| is_shell_like_tool_name(name))
                    .unwrap_or(false);
            let should_normalize_apply_patch = tool_call_id
                .as_ref()
                .map(|id| apply_patch_tool_call_ids.contains(id))
                .unwrap_or(false)
                || tool_name
                    .as_ref()
                    .map(|name| is_apply_patch_tool_name(name))
                    .unwrap_or(false);
            if should_normalize_shell || should_normalize_apply_patch {
                if let Some(content) = message_row.get("content").and_then(Value::as_str) {
                    let normalized = if should_normalize_apply_patch {
                        normalize_apply_patch_output_text(content)
                    } else {
                        normalize_shell_like_output_text(content)
                    };
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
            let call_id_hint = read_trimmed_string(call_row.get("id"))
                .or_else(|| read_trimmed_string(call_row.get("call_id")));
            let Some(fn_row) = call_row
                .get_mut("function")
                .and_then(|node| node.as_object_mut())
            else {
                continue;
            };
            let Some(raw_name) = read_trimmed_string(fn_row.get("name")) else {
                continue;
            };
            if is_apply_patch_tool_name(raw_name.as_str()) {
                if let Some(call_id) = call_id_hint.as_ref() {
                    apply_patch_tool_call_ids.insert(call_id.clone());
                }
            }
            if let Some((resolved_name, arguments)) = normalize_shell_like_function_call_arguments(
                raw_name.as_str(),
                fn_row.get("arguments"),
                requested_tool_names,
            ) {
                if resolved_name != raw_name {
                    fn_row.insert("name".to_string(), Value::String(resolved_name));
                }
                fn_row.insert("arguments".to_string(), Value::String(arguments));
                if let Some(call_id) = call_id_hint.as_ref() {
                    shell_tool_call_ids.insert(call_id.clone());
                }
                continue;
            }
            if let Some((resolved_name, arguments)) = normalize_write_stdin_function_call_arguments(
                raw_name.as_str(),
                fn_row.get("arguments"),
            ) {
                if resolved_name != raw_name {
                    fn_row.insert("name".to_string(), Value::String(resolved_name));
                }
                fn_row.insert("arguments".to_string(), Value::String(arguments));
            }
        }
    }

    prune_message_tool_history(messages);
    Ok(())
}

fn normalize_responses_input_function_calls(
    payload: &mut Value,
    requested_tool_names: &HashSet<String>,
) -> Result<(), napi::Error> {
    let Some(input_items) = payload
        .as_object_mut()
        .and_then(|root| root.get_mut("input"))
        .and_then(|node| node.as_array_mut())
    else {
        return Ok(());
    };

    let mut dropped_call_ids: HashSet<String> = HashSet::new();
    let mut shell_like_call_ids: HashSet<String> = HashSet::new();
    let mut apply_patch_call_ids: HashSet<String> = HashSet::new();
    let mut normalized_items = Vec::<Value>::with_capacity(input_items.len());

    for mut item in std::mem::take(input_items) {
        if let Some(item_row) = item.as_object_mut() {
            let item_type = read_trimmed_string(item_row.get("type"))
                .unwrap_or_default()
                .to_ascii_lowercase();
            if item_type == "function_call" {
                if let Some(raw_name) = read_trimmed_string(item_row.get("name")) {
                    if is_apply_patch_tool_name(raw_name.as_str()) {
                        let call_id = read_trimmed_string(item_row.get("call_id"))
                            .or_else(|| read_trimmed_string(item_row.get("id")));
                        if let Some(call_id) = call_id {
                            apply_patch_call_ids.insert(call_id);
                        }
                    }
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
                    } else if let Some((resolved_name, arguments)) =
                        normalize_write_stdin_function_call_arguments(
                            raw_name.as_str(),
                            item_row.get("arguments"),
                        )
                    {
                        if resolved_name != raw_name {
                            item_row.insert("name".to_string(), Value::String(resolved_name));
                        }
                        item_row.insert("arguments".to_string(), Value::String(arguments));
                    } else if is_invalid_shell_like_call(
                        raw_name.as_str(),
                        item_row.get("arguments"),
                    ) || is_invalid_write_stdin_call(
                        raw_name.as_str(),
                        item_row.get("arguments"),
                    ) {
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
                    if shell_like_call_ids.contains(call_id.as_str())
                        || apply_patch_call_ids.contains(call_id.as_str())
                    {
                        if let Some(raw_output) = item_row.get("output").and_then(Value::as_str) {
                            let normalized = if apply_patch_call_ids.contains(call_id.as_str()) {
                                normalize_apply_patch_output_text(raw_output)
                            } else {
                                normalize_shell_like_output_text(raw_output)
                            };
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
    Ok(())
}

pub(crate) fn normalize_shell_like_tool_calls_before_governance(
    payload: &mut Value,
) -> Result<(), napi::Error> {
    let requested_tool_names = collect_requested_tool_names(payload);
    normalize_message_tool_calls(payload, &requested_tool_names)?;
    normalize_responses_input_function_calls(payload, &requested_tool_names)?;
    Ok(())
}

#[napi]
pub fn normalize_shell_like_tool_calls_before_governance_json(
    payload_json: String,
) -> NapiResult<String> {
    let mut payload: Value =
        serde_json::from_str(&payload_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    normalize_shell_like_tool_calls_before_governance(&mut payload)?;
    serde_json::to_string(&payload).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::{
        normalize_apply_patch_output_text, normalize_shell_like_tool_calls_before_governance,
    };
    use crate::hashline::compute_line_hash;
    use serde_json::{json, Value};
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

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

        normalize_shell_like_tool_calls_before_governance(&mut payload).expect("normalize ok");
        let args_text = payload["messages"][0]["tool_calls"][0]["function"]["arguments"]
            .as_str()
            .expect("arguments text");
        let args: Value = serde_json::from_str(args_text).expect("args object");
        assert_eq!(args["cmd"], "pwd");
        assert!(args.get("command").is_none());
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

        normalize_shell_like_tool_calls_before_governance(&mut payload).expect("normalize ok");
        let args_text = payload["messages"][0]["tool_calls"][0]["function"]["arguments"]
            .as_str()
            .expect("arguments text");
        let args: Value = serde_json::from_str(args_text).expect("args object");
        assert_eq!(args["cmd"], "git status");
        assert!(args.get("command").is_none());
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

        normalize_shell_like_tool_calls_before_governance(&mut payload).expect("normalize ok");
        let args_text = payload["input"][0]["arguments"]
            .as_str()
            .expect("arguments text");
        let args: Value = serde_json::from_str(args_text).expect("args object");
        assert_eq!(args["cmd"], "npm test");
        assert!(args.get("command").is_none());
        assert_eq!(args["workdir"], "/workspace");
    }

    #[test]
    fn strips_provider_tool_sentinel_from_shell_tool_arguments() {
        let mut payload = json!({
          "tools": [{ "type": "function", "function": { "name": "exec_command" } }],
          "messages": [
            {
              "role": "assistant",
              "tool_calls": [
                {
                  "id": "call_marker_msg",
                  "type": "function",
                  "function": {
                    "name": "exec_command",
                    "arguments": "{\"cmd\":\"git status --short && echo ok]<]minimax[>[\"}"
                  }
                }
              ]
            }
          ],
          "input": [
            {
              "type": "function_call",
              "call_id": "call_marker_input",
              "name": "exec_command",
              "arguments": "{\"args\":{\"command\":\"git log --oneline -5]<]minimax[>[\"}}"
            }
          ]
        });

        normalize_shell_like_tool_calls_before_governance(&mut payload).expect("normalize ok");
        let message_args_text = payload["messages"][0]["tool_calls"][0]["function"]["arguments"]
            .as_str()
            .expect("message arguments");
        let input_args_text = payload["input"][0]["arguments"]
            .as_str()
            .expect("input arguments");
        let message_args: Value = serde_json::from_str(message_args_text).expect("message args");
        let input_args: Value = serde_json::from_str(input_args_text).expect("input args");
        assert_eq!(message_args["cmd"], "git status --short && echo ok");
        assert_eq!(input_args["cmd"], "git log --oneline -5");
        let serialized = serde_json::to_string(&payload).expect("payload json");
        assert!(!serialized.contains("]<]minimax[>["));
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

        normalize_shell_like_tool_calls_before_governance(&mut payload).expect("normalize ok");
        let args_text = payload["messages"][0]["tool_calls"][0]["function"]["arguments"]
            .as_str()
            .expect("arguments text");
        let args: Value = serde_json::from_str(args_text).expect("args object");
        assert_eq!(args["cmd"], "ls -la");
        assert!(args.get("command").is_none());
    }

    #[test]
    fn drops_exec_command_message_when_cmd_missing() {
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

        normalize_shell_like_tool_calls_before_governance(&mut payload).expect("normalize ok");
        let messages = payload["messages"].as_array().expect("messages array");
        assert!(messages.is_empty());
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

        normalize_shell_like_tool_calls_before_governance(&mut payload).expect("normalize ok");
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

        normalize_shell_like_tool_calls_before_governance(&mut payload).expect("normalize ok");
        let items = payload["input"].as_array().expect("input items");
        assert_eq!(items.len(), 2);
        assert_eq!(items[0]["call_id"], "call_good");
        let args_text = items[0]["arguments"].as_str().expect("normalized args");
        let args: Value = serde_json::from_str(args_text).expect("args object");
        assert_eq!(args["cmd"], "pwd");
        assert!(args.get("command").is_none());
    }

    #[test]
    fn drops_namespace_mcp_aggregator_input_call_and_matching_output() {
        let mut payload = json!({
          "tools": [
            {"name":"exec_command","description":"Runs command","input_schema":{"type":"object"}},
            {"name":"mcp__node_repl","description":"namespace aggregator","input_schema":{}},
            {"name":"mcp__node_repl__js","description":"child tool","input_schema":{"type":"object"}}
          ],
          "input": [
            {"type":"message","role":"assistant","content":[{"type":"output_text","text":"about to patch"}]},
            {
              "type":"function_call",
              "call_id":"call_function_snr978zyv21w_1",
              "name":"mcp__node_repl",
              "arguments":"{\"js\":\"import fs from 'node:fs'\"}"
            },
            {
              "type":"function_call_output",
              "call_id":"call_function_snr978zyv21w_1",
              "output":"unsupported call: mcp__node_repl"
            },
            {
              "type":"function_call",
              "call_id":"call_keep",
              "name":"mcp__node_repl__js",
              "arguments":"{\"code\":\"1+1\"}"
            },
            {
              "type":"function_call_output",
              "call_id":"call_keep",
              "output":"2"
            }
          ]
        });

        normalize_shell_like_tool_calls_before_governance(&mut payload).expect("normalize ok");
        let items = payload["input"].as_array().expect("input items");
        let serialized = serde_json::to_string(items).expect("serialize items");
        assert!(!serialized.contains("call_function_snr978zyv21w_1"));
        assert!(!serialized.contains("unsupported call: mcp__node_repl"));
        assert!(serialized.contains("call_keep"));
    }

    #[test]
    fn drops_namespace_mcp_aggregator_message_call_and_matching_tool_message() {
        let mut payload = json!({
          "messages": [
            {
              "role":"assistant",
              "content":"",
              "tool_calls":[
                {"id":"call_drop","type":"function","function":{"name":"mcp__node_repl","arguments":"{}"}},
                {"id":"call_keep","type":"function","function":{"name":"mcp__node_repl__js","arguments":"{}"}}
              ]
            },
            {"role":"tool","tool_call_id":"call_drop","content":"unsupported call: mcp__node_repl"},
            {"role":"tool","tool_call_id":"call_keep","content":"ok"}
          ]
        });

        normalize_shell_like_tool_calls_before_governance(&mut payload).expect("normalize ok");
        let messages = payload["messages"].as_array().expect("messages");
        let serialized = serde_json::to_string(messages).expect("serialize messages");
        assert!(!serialized.contains("call_drop"));
        assert!(!serialized.contains("unsupported call: mcp__node_repl"));
        assert!(serialized.contains("call_keep"));
    }

    #[test]
    fn does_not_normalize_apply_patch_inside_message_tool_calls_anymore() {
        let mut payload = json!({
          "tools": [{ "type": "function", "function": { "name": "apply_patch" } }],
          "messages": [
            {
              "role": "assistant",
              "tool_calls": [
                {
                  "id": "call_patch_1",
                  "type": "function",
                  "function": {
                    "name": "apply_patch",
                    "arguments": "{\"input\":\"*** note.txt\\n--- note.txt\\n@@ -0,0 +1 @@\\n+hello\"}"
                  }
                }
              ]
            }
          ]
        });

        normalize_shell_like_tool_calls_before_governance(&mut payload).expect("normalize ok");
        let args_text = payload["messages"][0]["tool_calls"][0]["function"]["arguments"]
            .as_str()
            .expect("arguments text");
        assert_eq!(
            args_text,
            "{\"input\":\"*** note.txt\\n--- note.txt\\n@@ -0,0 +1 @@\\n+hello\"}"
        );
    }

    #[test]
    fn does_not_normalize_shell_wrapped_apply_patch_anymore() {
        let mut payload = json!({
          "tools": [{ "type": "function", "function": { "name": "apply_patch" } }],
          "messages": [
            {
              "role": "assistant",
              "tool_calls": [
                {
                  "id": "call_patch_bad_shell",
                  "type": "function",
                  "function": {
                    "name": "apply_patch",
                    "arguments": "bash -lc \"echo hi && apply_patch <<'PATCH'\n*** Begin Patch\n*** Add File: src/nope.ts\n+console.log('nope');\n*** End Patch\nPATCH\""
                  }
                }
              ]
            }
          ]
        });

        normalize_shell_like_tool_calls_before_governance(&mut payload).expect("normalize ok");
        let args_text = payload["messages"][0]["tool_calls"][0]["function"]["arguments"]
            .as_str()
            .expect("arguments text");
        assert_eq!(
            args_text,
            "bash -lc \"echo hi && apply_patch <<'PATCH'\n*** Begin Patch\n*** Add File: src/nope.ts\n+console.log('nope');\n*** End Patch\nPATCH\""
        );
    }

    #[test]
    fn prunes_synthetic_apply_patch_guard_history_pair() {
        let mut payload = json!({
          "tools": [{ "type": "function", "function": { "name": "apply_patch" } }],
          "messages": [
            { "role": "user", "content": "test apply_patch" },
            {
              "role": "assistant",
              "content": "",
              "tool_calls": [{
                "id": "call_bad_patch_guard",
                "type": "function",
                "function": {
                  "name": "apply_patch",
                  "arguments": serde_json::to_string(&json!({
                    "input": "*** Begin Patch\n*** Update File: __APPLY_PATCH_ERROR__/missing_patch.txt\n@@\n-guard\n+APPLY_PATCH_ERROR: apply_patch requires schema arguments with patch as a string.\n*** End Patch",
                    "patch": "*** Begin Patch\n*** Update File: __APPLY_PATCH_ERROR__/missing_patch.txt\n@@\n-guard\n+APPLY_PATCH_ERROR: apply_patch requires schema arguments with patch as a string.\n*** End Patch"
                  })).unwrap()
                }
              }]
            },
            {
              "role": "tool",
              "name": "apply_patch",
              "tool_call_id": "call_bad_patch_guard",
              "content": "APPLY_PATCH_ERROR: patch was rejected by Codex apply_patch executor. Retry with filePath and minimal `- old` / `+ new` patch lines."
            },
            { "role": "user", "content": "try again" }
          ]
        });

        normalize_shell_like_tool_calls_before_governance(&mut payload).expect("normalize ok");
        let messages = payload["messages"].as_array().expect("messages array");
        assert_eq!(messages.len(), 2);
        assert_eq!(messages[0]["role"], "user");
        assert_eq!(messages[1]["content"], "try again");
        assert!(!payload.to_string().contains("__APPLY_PATCH_ERROR__/"));
    }

    #[test]
    fn preserves_shell_like_function_call_output_shape() {
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

        normalize_shell_like_tool_calls_before_governance(&mut payload).expect("normalize ok");
        let out = payload["input"][1]["output"].as_str().expect("output text");
        assert_eq!(
            out,
            "Command: /bin/bash -lc 'echo ok'\nChunk ID: test\nWall time: 0.1s\nProcess exited with code 0\nOriginal token count: 12\nOutput:\n\u{001b}[32mok\u{001b}[0m\n"
        );
    }

    #[test]
    fn preserves_shell_like_output_with_plain_bash_prefix() {
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

        normalize_shell_like_tool_calls_before_governance(&mut payload).expect("normalize ok");
        let out = payload["input"][1]["output"].as_str().expect("output text");
        assert_eq!(out, "Command: bash -lc 'echo done'\nOutput:\ndone\n");
    }

    #[test]
    fn preserves_long_shell_like_function_call_output_without_truncation() {
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

        normalize_shell_like_tool_calls_before_governance(&mut payload).expect("normalize ok");
        let out = payload["input"][1]["output"].as_str().expect("output text");
        assert_eq!(
            out,
            format!(
                "Command: /bin/zsh -lc 'cat long.txt'\nOutput:\n{}",
                very_long
            )
        );
    }

    #[test]
    fn preserves_tool_role_message_content_for_shell_call() {
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

        normalize_shell_like_tool_calls_before_governance(&mut payload).expect("normalize ok");
        let out = payload["messages"][1]["content"]
            .as_str()
            .expect("tool content");
        assert_eq!(
            out,
            "Command: /bin/bash -lc 'echo ok'\nChunk ID: x\nOutput:\n\u{001b}[32mok\u{001b}[0m\n"
        );
    }

    #[test]
    fn preserves_shell_like_output_with_chunk_prefix_shape() {
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
        assert_eq!(
            out,
            "Chunk ID: abc\nWall time: 0.1s\nProcess exited with code 0\nOutput:\n\u{001b}[32mok\u{001b}[0m\n"
        );
    }

    #[test]
    fn preserves_old_responses_tool_history_pairs() {
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
            .filter(|entry| {
                entry.get("type").and_then(Value::as_str) == Some("function_call_output")
            })
            .count();

        assert_eq!(function_calls, 130);
        assert_eq!(function_outputs, 130);
        assert!(items
            .iter()
            .any(|entry| entry.get("call_id").and_then(Value::as_str) == Some("call_0")));
        assert!(items
            .iter()
            .any(|entry| entry.get("call_id").and_then(Value::as_str) == Some("call_129")));
    }

    #[test]
    fn preserves_old_message_tool_history_pairs() {
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

        assert_eq!(assistant_with_tool_calls, 130);
        assert_eq!(tool_messages, 130);
        assert!(
            entries
                .iter()
                .any(|entry| entry.get("tool_call_id").and_then(Value::as_str)
                    == Some("call_msg_129"))
        );
        assert!(entries
            .iter()
            .any(|entry| entry.get("tool_call_id").and_then(Value::as_str) == Some("call_msg_0")));
    }

    #[test]
    fn drops_malformed_exec_command_message_history_and_orphan_tool_message() {
        let mut payload = json!({
          "tools": [{ "type": "function", "function": { "name": "exec_command" } }],
          "messages": [
            {
              "role": "assistant",
              "content": "",
              "tool_calls": [
                {
                  "id": "call_bad",
                  "type": "function",
                  "function": {
                    "name": "exec_command",
                    "arguments": "{\"cmd\": \"cat > demo.tsx << 'EOF'\nconst x = `${broken}`\nEOF"
                  }
                }
              ]
            },
            {
              "role": "tool",
              "name": "exec_command",
              "tool_call_id": "call_bad",
              "content": "failed to parse function arguments: EOF while parsing a string at line 1 column 73"
            },
            {
              "role": "assistant",
              "content": "",
              "tool_calls": [
                {
                  "id": "call_good",
                  "type": "function",
                  "function": {
                    "name": "exec_command",
                    "arguments": "{\"cmd\":\"pwd\"}"
                  }
                }
              ]
            },
            {
              "role": "tool",
              "name": "exec_command",
              "tool_call_id": "call_good",
              "content": "/repo"
            }
          ]
        });

        normalize_shell_like_tool_calls_before_governance(&mut payload);
        let entries = payload["messages"].as_array().expect("messages array");
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0]["tool_calls"][0]["id"], "call_good");
        assert_eq!(entries[1]["tool_call_id"], "call_good");
    }

    #[test]
    fn drops_malformed_write_stdin_message_history_and_orphan_tool_message() {
        let mut payload = json!({
          "tools": [{ "type": "function", "function": { "name": "write_stdin" } }],
          "messages": [
            {
              "role": "assistant",
              "content": "",
              "tool_calls": [
                {
                  "id": "call_bad_write",
                  "type": "function",
                  "function": {
                    "name": "write_stdin",
                    "arguments": "{\"chars\": \"import { broken } from './demo';\\nexport const x = \\\"oops"
                  }
                }
              ]
            },
            {
              "role": "tool",
              "name": "write_stdin",
              "tool_call_id": "call_bad_write",
              "content": "failed to parse function arguments: EOF while parsing a string at line 1 column 87"
            },
            {
              "role": "assistant",
              "content": "",
              "tool_calls": [
                {
                  "id": "call_good_write",
                  "type": "function",
                  "function": {
                    "name": "write_stdin",
                    "arguments": "{\"session_id\": 7, \"chars\": \"pwd\\n\"}"
                  }
                }
              ]
            },
            {
              "role": "tool",
              "name": "write_stdin",
              "tool_call_id": "call_good_write",
              "content": "ok"
            }
          ]
        });

        normalize_shell_like_tool_calls_before_governance(&mut payload);
        let entries = payload["messages"].as_array().expect("messages array");
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0]["tool_calls"][0]["id"], "call_good_write");
        assert_eq!(entries[1]["tool_call_id"], "call_good_write");
    }

    #[test]
    fn normalizes_write_stdin_inside_responses_input_function_call_items() {
        let mut payload = json!({
          "tools": [{ "type": "function", "function": { "name": "write_stdin" } }],
          "input": [
            {
              "type": "function_call",
              "call_id": "fc_write_1",
              "name": "write_stdin",
              "arguments": "{\"sessionId\":\"42\",\"chars\":\"echo ok\\n\"}"
            }
          ]
        });

        normalize_shell_like_tool_calls_before_governance(&mut payload);
        let args_text = payload["input"][0]["arguments"]
            .as_str()
            .expect("arguments text");
        let args: Value = serde_json::from_str(args_text).expect("args object");
        assert_eq!(args["session_id"], 42);
        assert_eq!(args["chars"], "echo ok\n");
    }

    #[test]
    fn does_not_validate_hashline_apply_patch_requires_explicit_filepath_anymore() {
        let mut payload = json!({
          "tools": [{ "type": "function", "function": { "name": "apply_patch" } }],
          "messages": [
            {
              "role": "assistant",
              "tool_calls": [
                {
                  "id": "call_hashline_missing_path",
                  "type": "function",
                  "function": {
                    "name": "apply_patch",
                    "arguments": "{\"patch\":\"= 1 123\\nreplaced\"}"
                  }
                }
              ]
            }
          ]
        });

        normalize_shell_like_tool_calls_before_governance(&mut payload).expect("normalize ok");
    }

    #[test]
    fn does_not_validate_hashline_target_context_anymore() {
        let mut payload = json!({
          "tools": [{ "type": "function", "function": { "name": "apply_patch" } }],
          "messages": [
            {
              "role": "assistant",
              "tool_calls": [
                {
                  "id": "call_hashline_missing_target_context",
                  "type": "function",
                  "function": {
                    "name": "apply_patch",
                    "arguments": {
                      "patch": "+ 2 deadbeef\nhello",
                      "filePath": "note.txt"
                    }
                  }
                }
              ]
            }
          ]
        });

        normalize_shell_like_tool_calls_before_governance(&mut payload).expect("normalize ok");
    }

    #[test]
    fn does_not_normalize_hashline_apply_patch_with_filepath_and_cwd_anymore() {
        let mut payload = json!({
          "tools": [{ "type": "function", "function": { "name": "apply_patch" } }],
          "messages": [
            {
              "role": "assistant",
              "tool_calls": [
                {
                  "id": "call_hashline_ok",
                  "type": "function",
                  "function": {
                    "name": "apply_patch",
                    "arguments": {
                      "patch": "= 1 123\nworld",
                      "filePath": "note.txt",
                      "cwd": "/tmp/hashline-owner-should-not-run"
                    }
                  }
                }
              ]
            }
          ]
        });

        normalize_shell_like_tool_calls_before_governance(&mut payload).expect("normalize ok");
        let args_value = &payload["messages"][0]["tool_calls"][0]["function"]["arguments"];
        let args: Value = match args_value.as_str() {
            Some(args_text) => serde_json::from_str(args_text).expect("args object"),
            None => args_value.clone(),
        };
        assert_eq!(args["patch"], "= 1 123\nworld");
        assert_eq!(args["filePath"], "note.txt");
    }

    #[test]
    fn normalizes_apply_patch_tool_error_message_for_chat_history() {
        let mut payload = json!({
          "tools": [{ "type": "function", "function": { "name": "apply_patch" } }],
          "messages": [
            {
              "role": "assistant",
              "tool_calls": [{
                "id": "call_patch_error",
                "type": "function",
                "function": {
                  "name": "apply_patch",
                  "arguments": "{\"patch\":\"*** Begin Patch\\n*** Add File: demo.txt\\n+hi\\n*** End Patch\"}"
                }
              }]
            },
            {
              "role": "tool",
              "name": "apply_patch",
              "tool_call_id": "call_patch_error",
              "content": "aborted"
            }
          ]
        });

        normalize_shell_like_tool_calls_before_governance(&mut payload).expect("normalize ok");
        let content = payload["messages"][1]["content"]
            .as_str()
            .expect("tool output");
        assert!(content.contains("APPLY_PATCH_ERROR"));
        assert!(content.contains("workspace-relative"));
        assert!(content.contains("Do not use absolute paths"));
        assert!(content.contains("Do not switch to exec_command"));
        assert!(!content.to_ascii_lowercase().contains("verify"));
        assert!(!content.to_ascii_lowercase().contains("rediscover"));
        assert!(!content.to_ascii_lowercase().contains("read"));
        assert!(!content.contains("Codex apply_patch executor"));
        assert!(!content.contains("fileContent"));
        assert!(!content.contains("*** Begin Patch\n"));
    }

    #[test]
    fn normalizes_apply_patch_function_call_output_error_for_responses_history() {
        let mut payload = json!({
          "tools": [{ "type": "function", "name": "apply_patch" }],
          "input": [
            {
              "type": "function_call",
              "call_id": "fc_patch_error",
              "name": "apply_patch",
              "arguments": "{\"patch\":\"*** Begin Patch\\n*** Add File: demo.txt\\n+hi\\n*** End Patch\"}"
            },
            {
              "type": "function_call_output",
              "call_id": "fc_patch_error",
              "output": "apply_patch verification failed: invalid patch"
            }
          ]
        });

        normalize_shell_like_tool_calls_before_governance(&mut payload).expect("normalize ok");
        let output = payload["input"][1]["output"].as_str().expect("tool output");
        assert!(output.contains("APPLY_PATCH_ERROR"));
        assert!(output.contains("workspace-relative"));
        assert!(output.contains("Do not use absolute paths"));
        assert!(output.contains("Do not switch to exec_command"));
        assert!(!output.to_ascii_lowercase().contains("verify"));
        assert!(!output.to_ascii_lowercase().contains("rediscover"));
        assert!(!output.to_ascii_lowercase().contains("read"));
        assert!(!output.contains("Original executor output"));
        assert!(!output.contains("Codex apply_patch executor"));
        assert!(!output.contains("fileContent"));
    }

    #[test]
    fn normalizes_apply_patch_success_output_for_responses_history() {
        let mut payload = json!({
          "tools": [{ "type": "function", "name": "apply_patch" }],
          "input": [
            {
              "type": "function_call",
              "call_id": "fc_patch_success",
              "name": "apply_patch",
              "arguments": "{\"patch\":\"*** Begin Patch\\n*** Add File: demo.txt\\n+hi\\n*** End Patch\"}"
            },
            {
              "type": "function_call_output",
              "call_id": "fc_patch_success",
              "output": "Done!"
            }
          ]
        });

        normalize_shell_like_tool_calls_before_governance(&mut payload).expect("normalize ok");
        let output = payload["input"][1]["output"].as_str().expect("tool output");
        assert!(output.starts_with("APPLY_PATCH_RESULT:"));
        assert!(output.contains("workspace-relative"));
        assert!(output.contains("Keep using apply_patch"));
        assert!(!output.contains("Codex apply_patch executor"));
        assert!(!output.contains("fileContent"));
    }

    #[test]
    fn preserves_apply_patch_success_json_even_with_diagnostic_words() {
        let mut payload = json!({
          "tools": [{ "type": "function", "name": "apply_patch" }],
          "input": [
            {
              "type": "function_call",
              "call_id": "fc_patch_success_json",
              "name": "apply_patch",
              "arguments": "{\"filePath\":\"tmp/apply_patch_test.txt\",\"patch\":\"+ first line\\n+ second line\"}"
            },
            {
              "type": "function_call_output",
              "call_id": "fc_patch_success_json",
              "output": "{\"status\":\"APPLY_PATCH_APPLIED\",\"ok\":true,\"filePath\":\"tmp/apply_patch_test.txt\",\"message\":\"created; no missing lines or errors\"}"
            }
          ]
        });

        normalize_shell_like_tool_calls_before_governance(&mut payload).expect("normalize ok");
        let output = payload["input"][1]["output"].as_str().expect("tool output");
        assert!(output.starts_with("APPLY_PATCH_RESULT:"));
        assert!(!output.contains("APPLY_PATCH_ERROR"));
        assert!(!output.contains("fileContent"));
    }

    #[test]
    fn does_not_double_wrap_apply_patch_error_for_responses_history() {
        let mut payload = json!({
          "tools": [{ "type": "function", "name": "apply_patch" }],
          "input": [
            {
              "type": "function_call",
              "call_id": "fc_patch_error_once",
              "name": "apply_patch",
              "arguments": "{\"patch\":\"*** Begin Patch\\n*** Add File: demo.txt\\n+hi\\n*** End Patch\"}"
            },
            {
              "type": "function_call_output",
              "call_id": "fc_patch_error_once",
              "output": "APPLY_PATCH_ERROR: patch was rejected by Codex apply_patch executor. Retry with filePath and minimal `- old` / `+ new` patch lines."
            }
          ]
        });

        normalize_shell_like_tool_calls_before_governance(&mut payload).expect("normalize ok");
        let output = payload["input"][1]["output"].as_str().expect("tool output");
        assert!(output.starts_with("APPLY_PATCH_ERROR:"));
        assert_eq!(output.matches("APPLY_PATCH_ERROR:").count(), 1);
        assert!(!output.contains("Original executor output"));
        assert!(!output.contains("Codex apply_patch executor"));
        assert!(!output.contains("fileContent"));
    }

    #[test]
    fn masks_legacy_apply_patch_error_tool_message_from_chat_history() {
        let mut payload = json!({
          "tools": [{ "type": "function", "function": { "name": "apply_patch" } }],
          "messages": [
            {
              "role": "assistant",
              "tool_calls": [{
                "id": "call_legacy_patch_error",
                "type": "function",
                "function": {
                  "name": "apply_patch",
                  "arguments": "{\"filePath\":\"demo.txt\",\"patch\":\"+ hi\"}"
                }
              }]
            },
            {
              "role": "tool",
              "name": "apply_patch",
              "tool_call_id": "call_legacy_patch_error",
              "content": "APPLY_PATCH_ERROR: patch was rejected by Codex apply_patch executor. Retry with filePath and minimal `- old` / `+ new` patch lines."
            }
          ]
        });

        normalize_shell_like_tool_calls_before_governance(&mut payload).expect("normalize ok");
        let content = payload["messages"][1]["content"]
            .as_str()
            .expect("tool output");
        assert!(content.contains("APPLY_PATCH_ERROR"));
        assert!(content.contains("workspace-relative"));
        assert!(content.contains("Do not use absolute paths"));
        assert!(!content.contains("Codex apply_patch executor"));
        assert!(!content.contains("fileContent"));
    }

    #[test]
    fn apply_patch_error_guidance_locks_relative_path_and_no_shell_retry_contract() {
        let normalized = normalize_apply_patch_output_text(
            "apply_patch verification failed: invalid patch for /tmp/codex-patch-test/new.txt",
        );
        assert!(normalized.contains("Retry with apply_patch only"));
        assert!(normalized.contains("workspace-relative"));
        assert!(normalized.contains("Do not use absolute paths"));
        assert!(normalized.contains("Do not switch to exec_command"));
        assert!(!normalized.to_ascii_lowercase().contains("verify"));
        assert!(!normalized.to_ascii_lowercase().contains("rediscover"));
        assert!(!normalized.to_ascii_lowercase().contains("read"));
        assert!(!normalized.contains("/tmp/codex-patch-test/new.txt"));
    }

    #[test]
    fn apply_patch_success_guidance_locks_relative_path_contract() {
        let normalized = normalize_apply_patch_output_text("Done!");
        assert!(normalized.starts_with("APPLY_PATCH_RESULT:"));
        assert!(normalized.contains("workspace-relative"));
        assert!(normalized.contains("Keep using apply_patch"));
        assert!(!normalized.contains("absolute paths"));
    }

    fn does_not_normalize_nested_hashline_apply_patch_anymore() {
        let mut payload = json!({
          "tools": [{ "type": "function", "function": { "name": "apply_patch" } }],
          "messages": [
            {
              "role": "assistant",
              "tool_calls": [
                {
                  "id": "call_hashline_nested",
                  "type": "function",
                  "function": {
                    "name": "apply_patch",
                    "arguments": {
                      "input": {
                        "patch": "+ 2 deadbeef\nhello",
                        "filePath": "note.txt"
                      },
                      "cwd": "/tmp/hashline-owner-should-not-run"
                    }
                  }
                }
              ]
            }
          ]
        });

        normalize_shell_like_tool_calls_before_governance(&mut payload).expect("normalize ok");
        let args_value = &payload["messages"][0]["tool_calls"][0]["function"]["arguments"];
        let args: Value = match args_value.as_str() {
            Some(args_text) => serde_json::from_str(args_text).expect("args object"),
            None => args_value.clone(),
        };
        assert_eq!(args["input"]["patch"], "+ 2 deadbeef\nhello");
        assert_eq!(args["input"]["filePath"], "note.txt");
    }
}
