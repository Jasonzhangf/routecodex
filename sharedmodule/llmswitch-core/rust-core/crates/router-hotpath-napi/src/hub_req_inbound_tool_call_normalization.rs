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

const STOP_HOOK_COMMAND_MARKERS: &[&str] = &[
    "routecodex hook run stop_message_auto",
    "routecodex servertool run stop_message_auto",
    "routecodex hook run reasoningStop",
    "routecodex servertool run reasoningStop",
    "routecodex hook run reasoning_stop",
    "routecodex servertool run reasoning_stop",
];

pub(crate) fn normalize_apply_patch_output_text(raw: &str) -> String {
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

fn read_function_call_id(row: &Map<String, Value>) -> Option<String> {
    read_trimmed_string(row.get("call_id"))
        .or_else(|| read_trimmed_string(row.get("tool_call_id")))
        .or_else(|| read_trimmed_string(row.get("id")))
}

fn read_exec_command_cmd(arguments: Option<&Value>) -> Option<String> {
    let args = parse_json_record(arguments)?;
    read_command_from_args(&args)
}

fn extract_embedded_apply_patch_from_shell_command(cmd: &str) -> Option<String> {
    let normalized = strip_provider_tool_sentinel_residue(cmd)
        .replace("\r\n", "\n")
        .replace('\r', "\n");
    let start = normalized.find("*** Begin Patch")?;
    let tail = &normalized[start..];
    let end_relative = tail.find("*** End Patch")?;
    let end = start + end_relative + "*** End Patch".len();
    let patch = normalized[start..end].trim().to_string();
    if patch.starts_with("*** Begin Patch") && patch.ends_with("*** End Patch") {
        return Some(patch);
    }
    None
}

fn is_auto_injected_stop_hook_function_call(row: &Map<String, Value>) -> bool {
    let item_type = read_trimmed_string(row.get("type"))
        .unwrap_or_default()
        .to_ascii_lowercase();
    if item_type != "function_call" && item_type != "tool_call" {
        return false;
    }
    let name = read_trimmed_string(row.get("name")).unwrap_or_default();
    if !is_shell_like_tool_name(name.as_str()) {
        return false;
    }
    let Some(cmd) = read_exec_command_cmd(row.get("arguments")) else {
        return false;
    };
    STOP_HOOK_COMMAND_MARKERS
        .iter()
        .any(|marker| cmd.contains(marker))
}

fn build_stop_hook_reasoning_stop_arguments_from_output(raw: &str) -> String {
    let trimmed = raw.trim();
    let Ok(Value::Object(row)) = serde_json::from_str::<Value>(trimmed) else {
        return "{\"stopreason\":2,\"reason\":\"continue_needed\"}".to_string();
    };
    let summary =
        read_trimmed_string(row.get("summary")).unwrap_or_else(|| "continue_needed".to_string());
    let reason_code = row
        .get("schemaFeedback")
        .or_else(|| row.get("schema_feedback"))
        .and_then(Value::as_object)
        .and_then(|feedback| {
            feedback
                .get("reasonCode")
                .or_else(|| feedback.get("reason_code"))
        })
        .and_then(Value::as_str)
        .unwrap_or("stop_schema_missing");
    serde_json::json!({
        "stopreason": 2,
        "reason": summary,
        "next_step": reason_code
    })
    .to_string()
}

pub(crate) fn build_stop_hook_reasoning_stop_output_text(raw: &str) -> String {
    let trimmed = raw.trim();
    let Ok(Value::Object(mut row)) = serde_json::from_str::<Value>(trimmed) else {
        return trimmed.to_string();
    };
    row.remove("ok");
    row.remove("kind");
    row.remove("tool");
    row.remove("toolName");
    row.remove("tool_name");
    Value::Object(row).to_string()
}

pub(crate) fn build_responses_reasoning_stop_function_call_item(
    call_id: &str,
    raw_output: &str,
) -> Value {
    serde_json::json!({
        "type": "function_call",
        "id": call_id,
        "call_id": call_id,
        "name": "reasoningStop",
        "arguments": build_stop_hook_reasoning_stop_arguments_from_output(raw_output)
    })
}

pub(crate) fn build_stop_hook_guidance_text_from_output(raw: &str) -> String {
    let trimmed = raw.trim();
    if let Ok(Value::Object(row)) = serde_json::from_str::<Value>(trimmed) {
        let tool_name = read_trimmed_string(row.get("toolName"))
            .or_else(|| read_trimmed_string(row.get("tool_name")))
            .unwrap_or_default();
        if tool_name == "stop_message_auto" {
            if let Some(prompt) = read_continue_next_step_prompt(&row) {
                return prompt;
            }
            let mut parts = Vec::<String>::new();
            let repeat_count = row
                .get("repeatCount")
                .and_then(serde_json::Value::as_u64)
                .map(|n| n as u32);
            if let Some(snapshot) = read_stopless_tool_result_snapshot_text(&row) {
                parts.push(snapshot);
            }
            if let Some(schema_feedback) =
                read_stopless_schema_feedback_text(&row, repeat_count.unwrap_or(1))
            {
                parts.push(schema_feedback);
            }
            if let Some(prompt) = read_trimmed_string(row.get("continuationPrompt"))
                .or_else(|| read_trimmed_string(row.get("continuation_prompt")))
            {
                parts.push(prompt);
            }
            let feedback_context = read_stopless_schema_feedback_context(&row);
            if let Some(schema_guidance) = row
                .get("schemaGuidance")
                .or_else(|| row.get("schema_guidance"))
                .cloned()
                .and_then(|value| serde_json::from_value::<serde_json::Value>(value).ok())
                .and_then(|v| Some(v.clone()))
            {
                if let Some(trigger_hint) = schema_guidance
                    .get("triggerHint")
                    .or_else(|| schema_guidance.get("trigger_hint"))
                    .and_then(serde_json::Value::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                {
                    let max_repeats = row
                        .get("maxRepeats")
                        .or_else(|| row.get("max_repeats"))
                        .and_then(serde_json::Value::as_u64)
                        .map(|n| n as u32)
                        .unwrap_or(3);
                    let used = repeat_count.map(|n| n.saturating_sub(1)).unwrap_or(0);
                    parts.push(render_stopless_schema_guidance_text(
                        &schema_guidance,
                        trigger_hint,
                        used,
                        max_repeats,
                    ));
                } else {
                    parts.push(
                        "STOPLESS_CLI_RESULT_MALFORMED: schemaGuidance 缺少 triggerHint；不能把它当作有效 schema guidance。请按 schemaFeedback 的缺失字段修复，或重新运行 reasoningStop 生成合法 CLI 输出。"
                            .to_string(),
                    );
                }
            } else if let Some((reason_code, missing_fields)) = feedback_context {
                if let Some(trigger_hint) = derive_stopless_trigger_hint_from_reason(&reason_code) {
                    let max_repeats = row
                        .get("maxRepeats")
                        .or_else(|| row.get("max_repeats"))
                        .and_then(serde_json::Value::as_u64)
                        .map(|n| n as u32)
                        .unwrap_or(3);
                    let used = repeat_count.map(|n| n.saturating_sub(1)).unwrap_or(0);
                    let guidance = serde_json::json!({
                        "triggerHint": trigger_hint,
                        "requiredFields": missing_fields,
                    });
                    parts.push(render_stopless_schema_guidance_text(
                        &guidance,
                        trigger_hint,
                        used,
                        max_repeats,
                    ));
                } else {
                    parts.push(format!(
                        "STOPLESS_CLI_RESULT_MALFORMED: schemaFeedback.reasonCode={reason_code} 没有注册的修复引导；不能伪造默认 schema guidance。请重新运行 reasoningStop 生成合法 CLI 输出。"
                    ));
                }
            } else if !is_legal_minimal_stopless_output(&row) {
                parts.push(
                    "STOPLESS_CLI_RESULT_MALFORMED: 缺少 schemaGuidance，且 schemaFeedback.reasonCode/missingFields 不完整；不能伪造默认 schema guidance。请重新运行 reasoningStop 生成合法 CLI 输出。"
                        .to_string(),
                );
            }
            if !parts.is_empty() {
                return parts.join("\n");
            }
        }
    }
    trimmed.to_string()
}

fn read_continue_next_step_prompt(row: &Map<String, Value>) -> Option<String> {
    let feedback = row
        .get("schemaFeedback")
        .or_else(|| row.get("schema_feedback"))?
        .as_object()?;
    let reason_code = read_trimmed_string(feedback.get("reasonCode"))
        .or_else(|| read_trimmed_string(feedback.get("reason_code")))?;
    if reason_code != "stop_schema_continue_next_step" {
        return None;
    }
    read_trimmed_string(row.get("continuationPrompt"))
        .or_else(|| read_trimmed_string(row.get("continuation_prompt")))
}

fn is_legal_minimal_stopless_output(row: &Map<String, Value>) -> bool {
    let trigger_hint = row
        .get("input")
        .or_else(|| row.get("input_json"))
        .and_then(Value::as_object)
        .and_then(|input| {
            read_trimmed_string(input.get("triggerHint"))
                .or_else(|| read_trimmed_string(input.get("trigger_hint")))
        })
        .or_else(|| read_trimmed_string(row.get("triggerHint")))
        .or_else(|| read_trimmed_string(row.get("trigger_hint")));
    matches!(
        trigger_hint.as_deref(),
        Some("no_schema" | "non_terminal_schema")
    )
}

fn read_stopless_schema_feedback_context(
    row: &Map<String, Value>,
) -> Option<(String, Vec<String>)> {
    let feedback = row
        .get("schemaFeedback")
        .or_else(|| row.get("schema_feedback"))?
        .as_object()?;
    let reason_code = feedback
        .get("reasonCode")
        .or_else(|| feedback.get("reason_code"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())?
        .to_string();
    let missing_fields = feedback
        .get("missingFields")
        .or_else(|| feedback.get("missing_fields"))
        .and_then(Value::as_array)?
        .iter()
        .filter_map(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(String::from)
        .collect::<Vec<_>>();
    if missing_fields.is_empty() && reason_code != "stop_schema_continue_next_step" {
        return None;
    }
    Some((reason_code, missing_fields))
}

fn derive_stopless_trigger_hint_from_reason(reason_code: &str) -> Option<&'static str> {
    match reason_code {
        "stop_schema_missing" => Some("no_schema"),
        "stop_schema_continue_next_step" => Some("non_terminal_schema"),
        "stop_schema_stopreason_missing_or_non_numeric"
        | "stop_schema_reason_missing"
        | "stop_schema_forcestop_reason_missing"
        | "stop_schema_terminal_missing_fields"
        | "stop_schema_needs_user_input_missing_next_step"
        | "stop_schema_current_goal_missing"
        | "stop_schema_next_step_missing"
        | "stop_schema_continue_without_next_step" => Some("invalid_schema"),
        _ => None,
    }
}

fn read_stopless_tool_result_snapshot_text(row: &Map<String, Value>) -> Option<String> {
    let repeat_count = row
        .get("repeatCount")
        .or_else(|| row.get("repeat_count"))
        .and_then(Value::as_u64)
        .map(|value| value as u32);
    let max_repeats = row
        .get("maxRepeats")
        .or_else(|| row.get("max_repeats"))
        .and_then(Value::as_u64)
        .map(|value| value as u32);
    let schema_feedback = row
        .get("schemaFeedback")
        .or_else(|| row.get("schema_feedback"))
        .and_then(Value::as_object);
    let reason_code = schema_feedback
        .and_then(|feedback| {
            feedback
                .get("reasonCode")
                .or_else(|| feedback.get("reason_code"))
        })
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let missing_fields = schema_feedback
        .and_then(|feedback| {
            feedback
                .get("missingFields")
                .or_else(|| feedback.get("missing_fields"))
        })
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    if repeat_count.is_none() && reason_code.is_none() && missing_fields.is_empty() {
        return None;
    }
    let mut segments = Vec::<String>::new();
    if let Some(repeat) = repeat_count {
        if let Some(max) = max_repeats {
            segments.push(format!("repeatCount={repeat}/{max}"));
        } else {
            segments.push(format!("repeatCount={repeat}"));
        }
    }
    if let Some(reason) = reason_code {
        segments.push(format!("reasonCode={reason}"));
    }
    if !missing_fields.is_empty() {
        segments.push(format!("missingFields={}", missing_fields.join(", ")));
    }
    Some(format!("上一轮执行结果：{}。", segments.join("；")))
}

fn is_terminal_budget_exhausted_stop_hook_output(raw: &str) -> bool {
    let trimmed = raw.trim();
    let Ok(Value::Object(row)) = serde_json::from_str::<Value>(trimmed) else {
        return false;
    };
    let tool_name = read_trimmed_string(row.get("toolName"))
        .or_else(|| read_trimmed_string(row.get("tool_name")))
        .unwrap_or_default();
    if tool_name != "stop_message_auto" {
        return false;
    }
    row.get("schemaGuidance")
        .or_else(|| row.get("schema_guidance"))
        .and_then(Value::as_object)
        .and_then(|guidance| {
            guidance
                .get("triggerHint")
                .or_else(|| guidance.get("trigger_hint"))
        })
        .and_then(Value::as_str)
        .map(str::trim)
        == Some("budget_exhausted")
}

fn render_stopless_schema_guidance_text(
    guidance: &serde_json::Value,
    trigger_hint: &str,
    used: u32,
    max_repeats: u32,
) -> String {
    let required_fields = guidance
        .get("requiredFields")
        .or_else(|| guidance.get("required_fields"))
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(String::from))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let fields = required_fields.join(", ");
    let base = if fields.is_empty() {
        "如果这一轮准备收尾，按条件填写 stop schema；本轮 CLI 输出没有提供缺失字段列表，不能假造字段全集。\nstopreason 取值：0=finished，1=blocked，2=continue_needed。\n".to_string()
    } else {
        format!(
            "如果这一轮准备收尾，结尾按条件补齐这些字段：{fields}\nstopreason 取值：0=finished，1=blocked，2=continue_needed。\n"
        )
    };
    let conditional_rules =
        "必填关系：stopreason 必须是数字 0/1/2；stopreason=0 表示完成，必须 has_evidence=1 且 evidence 非空；stopreason=1 表示阻塞，必须 reason 非空，提供 reason 即可停止；stopreason=2 必须写 next_step，下一轮只执行 next_step；needs_user_input=true 时 next_step 必须直接写要问用户的问题并停止等待。"
            .to_string();
    let hint = match trigger_hint {
        "no_schema" => {
            if used == 0 {
                "继续执行；如果任务已经完成，就按下面 schema 补齐收尾字段。".to_string()
            } else {
                "如果当前任务已经完成，就按下面 schema 补齐收尾字段；如果还没完成，不要收尾，继续执行当前任务。".to_string()
            }
        }
        "invalid_schema" => {
            "把这轮的结论重新整理成下面格式：stopreason 只能是 0/1/2；能收尾就写 reason，不能收尾就写 next_step；缺的字段直接补齐，不要留空。".to_string()
        }
        "non_terminal_schema" => {
            "继续往下做；如果现在已经能收尾，就把 stopreason 改成 0 或 1；如果还没收尾，就保持 stopreason=2 并把 next_step 写具体。".to_string()
        }
        "budget_exhausted" => format!(
            "这次直接收尾。优先给出最终结论；如果确实卡住，就把卡点、原因和已完成动作写清楚。stopreason 用 0 表示完成，用 1 表示阻塞。"
        ),
        "stop" => {
            "如果这轮要停，末尾按下面格式补完整；如果还没停稳，就继续推进并把 next_step 写具体。".to_string()
        }
        _ => String::new(),
    };
    let sample = if trigger_hint == "budget_exhausted" {
        "最小可复制样本：{\"stopreason\":1,\"reason\":\"需要用户确认上线策略\",\"has_evidence\":1,\"evidence\":\"缺少发布授权\",\"next_step\":\"请确认是否上线\",\"needs_user_input\":true}".to_string()
    } else {
        "最小可复制样本：{\"stopreason\":2,\"reason\":\"当前还在推进\",\"has_evidence\":0,\"evidence\":\"\",\"next_step\":\"运行下一条验证命令\",\"needs_user_input\":false}".to_string()
    };
    let decision_rules = guidance
        .get("decisionRules")
        .or_else(|| guidance.get("decision_rules"))
        .and_then(|value| value.as_array())
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.as_str())
                .map(render_stopless_decision_rule_text)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let invalid_examples = guidance
        .get("invalidExamples")
        .or_else(|| guidance.get("invalid_examples"))
        .and_then(|value| value.as_array())
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.as_str())
                .map(render_stopless_invalid_example_text)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let mut sections = vec![base, hint, conditional_rules, sample];
    if !decision_rules.is_empty() {
        sections.push(format!("判定规则：\n- {}", decision_rules.join("\n- ")));
    }
    if !invalid_examples.is_empty() {
        sections.push(format!("错误示例：\n- {}", invalid_examples.join("\n- ")));
    }
    sections.join("\n")
}

fn read_stopless_schema_feedback_text(
    row: &Map<String, Value>,
    repeat_count: u32,
) -> Option<String> {
    let feedback = row
        .get("schemaFeedback")
        .or_else(|| row.get("schema_feedback"))?
        .as_object()?;
    let reason_code = feedback
        .get("reasonCode")
        .or_else(|| feedback.get("reason_code"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())?;
    let missing_fields = feedback
        .get("missingFields")
        .or_else(|| feedback.get("missing_fields"))
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    if reason_code == "stop_schema_continue_next_step" {
        return None;
    }
    Some(render_stopless_schema_feedback_text(
        reason_code,
        &missing_fields,
        repeat_count,
    ))
}

fn render_stopless_schema_feedback_text(
    reason_code: &str,
    missing_fields: &[&str],
    repeat_count: u32,
) -> String {
    let missing = if missing_fields.is_empty() {
        String::new()
    } else {
        format!("缺少这些字段：{}。", missing_fields.join(", "))
    };
    match reason_code {
        "stop_schema_missing" => {
            if repeat_count <= 1 {
                if missing.is_empty() {
                    "继续执行；如果任务已经完成，就按下面 schema 补齐收尾字段。".to_string()
                } else {
                    format!(
                        "继续执行；如果任务已经完成，就按下面 schema 补齐缺失字段：{}。",
                        missing_fields.join(", ")
                    )
                }
            } else {
                format!(
                    "你上一轮缺少收尾 schema；如果任务已经完成，就按下面 schema 补齐缺失字段：{}；如果任务还没完成，不要停，继续执行当前任务。",
                    missing_fields.join(", ")
                )
            }
        }
        "stop_schema_stopreason_missing_or_non_numeric" => {
            "你上一轮的 stopreason 缺失或格式不对；改成数字 0/1/2，再继续。".to_string()
        }
        "stop_schema_reason_missing" | "stop_schema_forcestop_reason_missing" => {
            "你已经表达要 finished/blocked，但还没有写清 reason；这轮只补 reason。".to_string()
        }
        "stop_schema_terminal_missing_fields" => {
            format!("你已经表达 finished/blocked，但还没收齐收尾信息；{}只补缺失字段，不要重写已正确部分。", missing)
        }
        "stop_schema_needs_user_input_missing_next_step" => {
            "你表示需要用户输入，但 next_step 里还没有写出要问用户的具体问题；把问题直接写进 next_step。".to_string()
        }
        "stop_schema_next_step_missing" => {
            format!("任务还没完成，但当前没有明确 next_step；{}把下一步写成这轮立刻执行的最小动作。", missing)
        }
        "stop_schema_current_goal_missing" => {
            "任务还没完成，但当前没有明确 current_goal；先写清你现在的任务目标是什么，再基于这个目标判断下一步并继续执行。".to_string()
        }
        "stop_schema_continue_without_next_step" => {
            "任务还没完成，但你没有给出明确 next_step；这轮必须补出最小下一步，或者直接给出最终收尾。".to_string()
        }
        "stop_schema_continue_next_step" => String::new(),
        _ => {
            if missing.is_empty() {
                format!("上一轮收尾结果有问题（{}）；这轮按要求修正。", reason_code)
            } else {
                format!("上一轮收尾结果有问题（{}）；{}按要求修正。", reason_code, missing)
            }
        }
    }
}

fn render_stopless_decision_rule_text(rule: &str) -> String {
    if rule.contains("Only use stopreason=0") {
        return "只有任务确实已经完成，而且没有剩余 next_step 时，才能写 stopreason=0。"
            .to_string();
    }
    if rule.contains("use stopreason=2 instead of 0") {
        return "只要还有明确 next_step、未完成 gate、待验证项或剩余实现工作，就不能写 0，必须写 stopreason=2。"
            .to_string();
    }
    if rule.contains("Use stopreason=1 only when") {
        return "只有当前轮真的被阻塞，而且本轮无法自行消除时，才能写 stopreason=1。".to_string();
    }
    if rule.contains("reason must describe the real current state") {
        return "reason 和 next_step 必须与 stopreason 保持一致，不能互相矛盾。".to_string();
    }
    rule.to_string()
}

fn render_stopless_invalid_example_text(example: &str) -> String {
    if example.contains("stopreason=0 with next_step") {
        return "错误：还写着 next_step 要继续做事时，不能把 stopreason 写成 0。".to_string();
    }
    if example.contains("unfinished work or missing verification") {
        return "错误：如果 issue_cause 里仍然表示有未完成工作或缺少验证，就不能把 stopreason 写成 0。".to_string();
    }
    if example.contains("Valid unfinished pattern") {
        return "正确未完成写法：用 stopreason=2，并给出具体 next_step。".to_string();
    }
    example.to_string()
}

fn build_responses_text_guidance_input_item(text: String) -> Value {
    serde_json::json!({
        "role": "user",
        "content": [
            {
                "type": "input_text",
                "text": text
            }
        ]
    })
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
    if requested_tool_names.contains("apply_patch") {
        if let Some(patch) = extract_embedded_apply_patch_from_shell_command(cmd.as_str()) {
            return Some(("apply_patch".to_string(), patch));
        }
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
    let mut auto_stop_hook_call_ids = HashSet::<String>::new();
    let mut guidance_insertions = Vec::<(usize, Value)>::new();

    for message in messages.iter_mut() {
        let Some(message_row) = message.as_object_mut() else {
            continue;
        };
        let role = read_trimmed_string(message_row.get("role"))
            .unwrap_or_default()
            .to_ascii_lowercase();
        if role == "tool" {
            let tool_call_id = read_trimmed_string(message_row.get("tool_call_id"))
                .or_else(|| read_trimmed_string(message_row.get("call_id")));
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
            let auto_stop_candidate = serde_json::json!({
                "type": "function_call",
                "name": raw_name,
                "arguments": fn_row.get("arguments").cloned().unwrap_or(Value::Null),
            });
            if auto_stop_candidate
                .as_object()
                .is_some_and(is_auto_injected_stop_hook_function_call)
            {
                if let Some(call_id) = call_id_hint.as_ref() {
                    auto_stop_hook_call_ids.insert(call_id.clone());
                }
                fn_row.insert(
                    "name".to_string(),
                    Value::String("reasoningStop".to_string()),
                );
            }
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
                let normalized_to_apply_patch = resolved_name == "apply_patch";
                if resolved_name != raw_name {
                    fn_row.insert("name".to_string(), Value::String(resolved_name));
                }
                fn_row.insert("arguments".to_string(), Value::String(arguments));
                if let Some(call_id) = call_id_hint.as_ref() {
                    if normalized_to_apply_patch {
                        apply_patch_tool_call_ids.insert(call_id.clone());
                    } else {
                        shell_tool_call_ids.insert(call_id.clone());
                    }
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

    for (message_index, message) in messages.iter_mut().enumerate() {
        let Some(message_row) = message.as_object_mut() else {
            continue;
        };
        let role = read_trimmed_string(message_row.get("role"))
            .unwrap_or_default()
            .to_ascii_lowercase();
        if role != "tool" {
            continue;
        }
        let call_id = read_trimmed_string(message_row.get("tool_call_id"))
            .or_else(|| read_trimmed_string(message_row.get("call_id")));
        let Some(call_id) = call_id else {
            continue;
        };
        if !auto_stop_hook_call_ids.contains(call_id.as_str()) {
            continue;
        }
        let Some(content) = message_row
            .get("content")
            .and_then(Value::as_str)
            .map(str::to_string)
        else {
            continue;
        };
        let normalized_output = build_stop_hook_reasoning_stop_output_text(content.as_str());
        let guidance = build_stop_hook_guidance_text_from_output(content.as_str())
            .trim()
            .to_string();
        message_row.insert(
            "name".to_string(),
            Value::String("reasoningStop".to_string()),
        );
        message_row.insert("content".to_string(), Value::String(normalized_output));
        if !guidance.is_empty() && !is_terminal_budget_exhausted_stop_hook_output(content.as_str())
        {
            guidance_insertions.push((
                message_index,
                build_responses_text_guidance_input_item(guidance),
            ));
        }
    }

    if !guidance_insertions.is_empty() {
        let mut insertions_by_index = std::collections::HashMap::<usize, Vec<Value>>::new();
        for (index, guidance) in guidance_insertions {
            insertions_by_index.entry(index).or_default().push(guidance);
        }
        let mut expanded_messages = Vec::<Value>::with_capacity(messages.len() * 2);
        for (index, message) in std::mem::take(messages).into_iter().enumerate() {
            expanded_messages.push(message);
            if let Some(extra) = insertions_by_index.remove(&index) {
                expanded_messages.extend(extra);
            }
        }
        *messages = expanded_messages;
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
    let mut auto_stop_hook_call_ids: HashSet<String> = HashSet::new();
    let mut normalized_items = Vec::<Value>::with_capacity(input_items.len());

    for mut item in std::mem::take(input_items) {
        if let Some(item_row) = item.as_object_mut() {
            let item_type = read_trimmed_string(item_row.get("type"))
                .unwrap_or_default()
                .to_ascii_lowercase();
            if item_type == "function_call" {
                if is_auto_injected_stop_hook_function_call(item_row) {
                    if let Some(call_id) = read_function_call_id(item_row) {
                        auto_stop_hook_call_ids.insert(call_id);
                    }
                    continue;
                }
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
                        let normalized_to_apply_patch = resolved_name == "apply_patch";
                        if resolved_name != raw_name {
                            item_row.insert("name".to_string(), Value::String(resolved_name));
                        }
                        item_row.insert("arguments".to_string(), Value::String(arguments));
                        let call_id = read_trimmed_string(item_row.get("call_id"))
                            .or_else(|| read_trimmed_string(item_row.get("id")));
                        if let Some(call_id) = call_id {
                            if normalized_to_apply_patch {
                                apply_patch_call_ids.insert(call_id);
                            } else {
                                shell_like_call_ids.insert(call_id);
                            }
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
                    if auto_stop_hook_call_ids.contains(call_id.as_str()) {
                        if let Some(raw_output) = item_row.get("output").and_then(Value::as_str) {
                            let raw_output_owned = raw_output.to_string();
                            normalized_items.push(
                                build_responses_reasoning_stop_function_call_item(
                                    call_id.as_str(),
                                    raw_output_owned.as_str(),
                                ),
                            );
                            normalized_items.push(serde_json::json!({
                                "type": "function_call_output",
                                "call_id": call_id,
                                "output": build_stop_hook_reasoning_stop_output_text(raw_output_owned.as_str())
                            }));
                            if !is_terminal_budget_exhausted_stop_hook_output(
                                raw_output_owned.as_str(),
                            ) {
                                normalized_items.push(build_responses_text_guidance_input_item(
                                    build_stop_hook_guidance_text_from_output(
                                        raw_output_owned.as_str(),
                                    ),
                                ));
                            }
                        }
                        continue;
                    }
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
    use super::normalize_responses_input_function_calls;
    use super::{
        build_stop_hook_guidance_text_from_output, normalize_apply_patch_output_text,
        normalize_shell_like_tool_calls_before_governance,
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
    fn preserves_public_function_call_output_before_stopless_cli_pair() {
        let mut payload = json!({
          "tools": [{ "type": "function", "function": { "name": "exec_command" } }],
          "input": [
            {
              "type": "function_call",
              "call_id": "call_public",
              "name": "exec_command",
              "arguments": "{\"cmd\":\"curl /api/catalog\"}"
            },
            {
              "type": "function_call_output",
              "call_id": "call_public",
              "output": "{\"owner\":\"backend\"}"
            },
            {
              "type": "function_call",
              "call_id": "call_servertool_cli",
              "name": "exec_command",
              "arguments": "{\"cmd\":\"routecodex hook run reasoningStop --input-json '{\\\"flowId\\\":\\\"stop_message_flow\\\",\\\"repeatCount\\\":1,\\\"maxRepeats\\\":3}'\"}"
            },
            {
              "type": "function_call_output",
              "call_id": "call_servertool_cli",
              "output": "{\"ok\":true,\"kind\":\"stop_message_auto\",\"tool\":\"stop_message_auto\",\"summary\":\"stopless continuation ready\"}"
            }
          ]
        });

        normalize_shell_like_tool_calls_before_governance(&mut payload).expect("normalize ok");
        let items = payload["input"].as_array().expect("input items");
        let public_output = items
            .iter()
            .find(|item| item["call_id"] == "call_public" && item["type"] == "function_call_output")
            .expect("public output");
        assert_eq!(public_output["type"], "function_call_output");
        assert_eq!(public_output["output"], "{\"owner\":\"backend\"}");
    }

    #[test]
    fn upgrades_shell_wrapped_canonical_patch_to_apply_patch_call() {
        let mut payload = json!({
          "tools": [
            { "type": "function", "function": { "name": "exec_command" } },
            { "type": "function", "function": { "name": "apply_patch" } }
          ],
          "input": [
            {
              "type": "function_call",
              "call_id": "fc_patch_shell",
              "name": "exec_command",
              "arguments": "{\"cmd\":\"cat > /tmp/patch-terminal-page.txt << 'PATCH_EOF'\\n*** Begin Patch\\n*** Add File: tmp/patch-from-shell.txt\\n+hello from patch\\n*** End Patch\\nPATCH_EOF\"}"
            },
            {
              "type": "function_call_output",
              "call_id": "fc_patch_shell",
              "output": "Invalid patch: The first line of the patch must be '*** Begin Patch'"
            }
          ]
        });

        normalize_shell_like_tool_calls_before_governance(&mut payload).expect("normalize ok");
        assert_eq!(payload["input"][0]["name"], "apply_patch");
        assert_eq!(
            payload["input"][0]["arguments"],
            "*** Begin Patch\n*** Add File: tmp/patch-from-shell.txt\n+hello from patch\n*** End Patch"
        );
        let output = payload["input"][1]["output"].as_str().expect("tool output");
        assert!(output.starts_with("APPLY_PATCH_ERROR:"));
        assert!(output.contains("Retry with apply_patch only"));
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
    fn rewrites_stop_hook_pair_into_reasoning_stop_pair_and_guidance_for_next_turn() {
        let mut payload = json!({
          "tools": [{ "type": "function", "function": { "name": "exec_command" } }],
          "input": [
            {
              "type": "function_call",
              "call_id": "call_stop_cli_stop_1",
              "name": "exec_command",
              "arguments": "{\"cmd\":\"routecodex hook run reasoningStop --input-json '{\\\"flowId\\\":\\\"stop_message_flow\\\",\\\"repeatCount\\\":1,\\\"maxRepeats\\\":3}'\"}"
            },
            {
              "type": "function_call_output",
              "call_id": "call_stop_cli_stop_1",
              "output": "{\"ok\":true,\"toolName\":\"stop_message_auto\",\"flowId\":\"stop_message_flow\",\"continuationPrompt\":\"继续做下一步；拿不到证据就再试一次；想停的时候直接告诉我一句'做完了'或'卡住了，需要你拍板'。\",\"schemaFeedback\":{\"reasonCode\":\"stop_schema_terminal_missing_fields\",\"missingFields\":[\"evidence\",\"next_step\"]},\"schemaGuidance\":{\"triggerHint\":\"invalid_schema\",\"requiredFields\":[\"stopreason\",\"reason\",\"next_step\"],\"stopreasonValues\":{\"finished\":0,\"blocked\":1,\"continueNeeded\":2},\"decisionRules\":[\"Only use stopreason=0 when the task is actually finished and there is no remaining next_step to execute.\",\"If there is still a concrete next_step, unfinished gate, pending verification, or more implementation work, use stopreason=2 instead of 0.\"],\"invalidExamples\":[\"Invalid: stopreason=0 with next_step saying continue writing remaining gates/manifests/package wiring.\"]}}"
            }
          ]
        });

        normalize_shell_like_tool_calls_before_governance(&mut payload).expect("normalize ok");
        let input = payload["input"].as_array().expect("input");
        assert_eq!(input.len(), 3);
        assert_eq!(input[0]["type"], "function_call");
        assert_eq!(input[0]["name"], "reasoningStop");
        assert_eq!(input[0]["call_id"], "call_stop_cli_stop_1");
        assert_eq!(input[1]["type"], "function_call_output");
        assert_eq!(input[1]["call_id"], "call_stop_cli_stop_1");
        let restored_output = input[1]["output"].as_str().expect("restored output");
        assert!(!restored_output.contains("stop_message_auto"));
        assert!(restored_output.contains("stop_schema_terminal_missing_fields"));
        assert_eq!(input[2]["role"], "user");
        let text = input[2]["content"][0]["text"].as_str().expect("text");
        assert!(text.contains("继续做下一步"));
        assert!(text.contains("按条件补齐这些字段"));
        assert!(text.contains("你已经表达 finished/blocked，但还没收齐收尾信息"));
        assert!(text.contains("stopreason"));
        assert!(text.contains("0=finished"));
        assert!(text.contains("必须写 stopreason=2"));
        assert!(text.contains("不能把 stopreason 写成 0"));
        assert!(text.contains("schema"));
        assert!(!text.contains("hook"));
        assert!(!text.contains("第一轮"));
        assert!(!text.contains("上一轮你直接停了"));
        assert!(!text.contains("停止 JSON"));
        assert!(!text.contains("格式不对"));
        assert!(!text.contains("重试机会"));
    }

    #[test]
    fn rewrites_stop_hook_pair_for_responses_previous_response_resume_into_reasoning_stop_pair() {
        let mut payload = json!({
          "previous_response_id": "resp_prev_stopless_live",
          "tools": [{ "type": "function", "function": { "name": "exec_command" } }],
          "input": [
            {
              "type": "message",
              "role": "user",
              "content": [{ "type": "input_text", "text": "第一轮 stopless 指令" }]
            },
            {
              "type": "reasoning",
              "id": "reasoning_prev_1",
              "summary": [{ "type": "summary_text", "text": "**Thinking** 第一轮推理" }]
            },
            {
              "type": "function_call",
              "call_id": "call_stop_cli_stop_resume_1",
              "name": "exec_command",
              "arguments": "{\"cmd\":\"routecodex hook run reasoningStop --input-json '{\\\"flowId\\\":\\\"stop_message_flow\\\",\\\"repeatCount\\\":1,\\\"maxRepeats\\\":3}'\"}"
            },
            {
              "type": "function_call_output",
              "call_id": "call_stop_cli_stop_resume_1",
              "output": "{\"ok\":true,\"toolName\":\"stop_message_auto\",\"flowId\":\"stop_message_flow\",\"continuationPrompt\":\"继续往下做；要是能收尾就直接告诉我做完了，不然就继续推进。\",\"repeatCount\":2,\"maxRepeats\":3}"
            }
          ]
        });

        normalize_shell_like_tool_calls_before_governance(&mut payload).expect("normalize ok");
        let input = payload["input"].as_array().expect("input");
        assert_eq!(input.len(), 5);
        assert_eq!(input[0]["role"], "user");
        assert_eq!(input[1]["type"], "reasoning");
        assert_eq!(input[2]["type"], "function_call");
        assert_eq!(input[2]["name"], "reasoningStop");
        assert_eq!(input[2]["call_id"], "call_stop_cli_stop_resume_1");
        assert_eq!(input[3]["type"], "function_call_output");
        assert_eq!(input[3]["call_id"], "call_stop_cli_stop_resume_1");
        assert!(!input[3]["output"]
            .as_str()
            .expect("output")
            .contains("stop_message_auto"));
        assert_eq!(input[4]["role"], "user");
        let text = input[4]["content"][0]["text"].as_str().expect("text");
        assert!(text.contains("继续往下做"));
    }

    #[test]
    fn rewrites_stop_hook_tool_message_shape_into_reasoning_stop_pair_and_guidance() {
        let mut payload = json!({
          "messages": [
            {
              "role": "assistant",
              "tool_calls": [
                {
                  "id": "call_servertool_cli_live_1",
                  "type": "function",
                  "function": {
                    "name": "exec_command",
                    "arguments": "{\"cmd\":\"routecodex hook run reasoningStop --input-json '{\\\"flowId\\\":\\\"stop_message_flow\\\",\\\"repeatCount\\\":1,\\\"maxRepeats\\\":3,\\\"triggerHint\\\":\\\"invalid_schema\\\"}'\"}"
                  }
                }
              ]
            },
            {
              "role": "tool",
              "tool_call_id": "call_servertool_cli_live_1",
              "name": "reasoningStop",
              "content": "{\"ok\":true,\"kind\":\"stop_message_auto\",\"tool\":\"stop_message_auto\",\"summary\":\"stopless continuation ready\",\"toolName\":\"stop_message_auto\",\"flowId\":\"stop_message_flow\",\"routeHint\":\"thinking\",\"continuationPrompt\":\"刚才那段我没看明白；按你现在看到的真实情况重说一遍，直接说结果和下一步。\",\"repeatCount\":1,\"maxRepeats\":3,\"schemaFeedback\":{\"reasonCode\":\"invalid_schema\",\"missingFields\":[\"stopreason\",\"reason\",\"next_step\"]},\"input\":{\"flowId\":\"stop_message_flow\",\"maxRepeats\":3,\"repeatCount\":1,\"triggerHint\":\"invalid_schema\"}}"
            }
          ]
        });

        normalize_shell_like_tool_calls_before_governance(&mut payload).expect("normalize ok");
        let messages = payload["messages"].as_array().expect("messages");
        assert_eq!(messages.len(), 3);
        assert_eq!(messages[0]["role"], "assistant");
        assert_eq!(
            messages[0]["tool_calls"][0]["function"]["name"],
            "reasoningStop"
        );
        assert_eq!(messages[1]["role"], "tool");
        assert_eq!(messages[1]["name"], "reasoningStop");
        let restored_output = messages[1]["content"].as_str().expect("tool output");
        assert!(!restored_output.contains("stop_message_auto"));
        assert!(restored_output.contains("invalid_schema"));
        assert_eq!(messages[2]["role"], "user");
        let guidance = messages[2]["content"][0]["text"]
            .as_str()
            .expect("guidance");
        assert!(guidance.contains("上一轮执行结果：repeatCount=1/3"));
        assert!(guidance.contains("刚才那段我没看明白"));
        assert!(guidance.contains("stopreason"));
        assert!(!guidance.contains("stop_message_auto"));
    }

    #[test]
    fn rewrites_stop_hook_pair_with_session_dir_env_prefix_into_reasoning_stop_pair() {
        let mut payload = json!({
          "tools": [{ "type": "function", "function": { "name": "exec_command" } }],
          "input": [
            {
              "type": "function_call",
              "call_id": "call_stop_cli_stop_env_1",
              "name": "exec_command",
              "arguments": "{\"cmd\":\"ROUTECODEX_SESSION_DIR='/Users/fanzhang/.rcc/sessions/127.0.0.1:5555/ports/gateway_priority_5555' routecodex hook run reasoningStop --input-json '{\\\"flowId\\\":\\\"stop_message_flow\\\",\\\"repeatCount\\\":1,\\\"maxRepeats\\\":3}' --session-id 'session-a' --request-id 'req-a'\"}"
            },
            {
              "type": "function_call_output",
              "call_id": "call_stop_cli_stop_env_1",
              "output": "{\"ok\":true,\"toolName\":\"stop_message_auto\",\"flowId\":\"stop_message_flow\",\"continuationPrompt\":\"继续做下一步；拿不到证据就继续推进。\",\"schemaGuidance\":{\"requiredFields\":[\"stopreason\",\"reason\",\"next_step\"],\"triggerHint\":\"no_schema\",\"stopreasonValues\":{\"finished\":0,\"blocked\":1,\"continueNeeded\":2}}}"
            }
          ]
        });

        normalize_shell_like_tool_calls_before_governance(&mut payload).expect("normalize ok");
        let input = payload["input"].as_array().expect("input");
        assert_eq!(input.len(), 3);
        assert_eq!(input[0]["type"], "function_call");
        assert_eq!(input[0]["name"], "reasoningStop");
        assert_eq!(input[1]["type"], "function_call_output");
        assert!(!input[1]["output"]
            .as_str()
            .expect("output")
            .contains("stop_message_auto"));
        assert_eq!(input[2]["role"], "user");
        let text = input[2]["content"][0]["text"].as_str().expect("text");
        assert!(text.contains("继续做下一步"));
        assert!(text.contains("stopreason"));
    }

    #[test]
    fn rewrites_stop_hook_history_even_when_call_id_is_not_auto_injected() {
        let mut payload = json!({
          "tools": [{ "type": "function", "function": { "name": "exec_command" } }],
          "input": [
            {
              "type": "function_call",
              "call_id": "call_model_stop_1",
              "name": "exec_command",
              "arguments": "{\"cmd\":\"routecodex hook run stop_message_auto --input-json '{\\\"flowId\\\":\\\"stop_message_flow\\\",\\\"repeatCount\\\":1,\\\"maxRepeats\\\":3}'\"}"
            },
            {
              "type": "function_call_output",
              "call_id": "call_model_stop_1",
              "output": "{\"ok\":true,\"toolName\":\"stop_message_auto\",\"flowId\":\"stop_message_flow\",\"continuationPrompt\":\"继续。\"}"
            }
          ]
        });

        normalize_shell_like_tool_calls_before_governance(&mut payload).expect("normalize ok");
        let input = payload["input"].as_array().expect("input");
        assert_eq!(input.len(), 3);
        assert_eq!(input[0]["type"], "function_call");
        assert_eq!(input[0]["name"], "reasoningStop");
        assert_eq!(input[1]["type"], "function_call_output");
        let output = input[1]["output"].as_str().expect("output");
        assert!(!output.contains("stop_message_auto"));
        assert_eq!(input[2]["role"], "user");
        let text = input[2]["content"][0]["text"].as_str().expect("text");
        assert!(text.contains("继续。"));
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

    #[test]
    fn stop_hook_guidance_text_appends_schema_guidance_from_cli_output() {
        let text = build_stop_hook_guidance_text_from_output(
            &json!({
                "toolName": "stop_message_auto",
                "continuationPrompt": "继续做下一步；先把手头能确认的结果拿回来。",
                "schemaFeedback": {
                    "reasonCode": "stop_schema_reason_missing",
                    "missingFields": ["reason"]
                },
                "schemaGuidance": {
                    "triggerHint": "invalid_schema",
                    "requiredFields": ["reason"],
                    "stopreasonValues": {
                        "finished": 0,
                        "blocked": 1,
                        "continueNeeded": 2
                    },
                    "decisionRules": [
                        "Only use stopreason=0 when the task is actually finished and there is no remaining next_step to execute."
                    ]
                }
            })
            .to_string(),
        );
        assert!(text.contains("继续做下一步"));
        assert!(text.contains("reason"));
        assert!(text.contains("只补 reason"));
        assert!(text.contains("stopreason"));
        assert!(text.contains("next_step"));
        assert!(text.contains("0=finished"));
        assert!(text.contains("按条件补齐这些字段"));
        assert!(text.contains("stopreason=0 表示完成，必须 has_evidence=1 且 evidence 非空"));
        assert!(text.contains("stopreason=1 表示阻塞，必须 reason 非空，提供 reason 即可停止"));
        assert!(text.contains("stopreason=2 必须写 next_step"));
        assert!(text.contains("needs_user_input=true 时 next_step 必须直接写要问用户的问题"));
        assert!(text.contains("最小可复制样本："));
        assert!(text.contains("\"next_step\""));
        assert!(text.contains("只有任务确实已经完成"));
        assert!(!text.contains("servertool"));
        assert!(!text.contains("停止 JSON"));
        assert!(!text.contains("格式不对"));
        assert!(!text.contains("重试机会"));
        assert!(!text.contains("样例："));
    }

    #[test]
    fn stop_hook_guidance_text_for_first_missing_schema_round_stays_short() {
        let text = build_stop_hook_guidance_text_from_output(
            &json!({
                "toolName": "stop_message_auto",
                "continuationPrompt": "继续推进当前任务。",
                "repeatCount": 1,
                "schemaFeedback": {
                    "reasonCode": "stop_schema_missing",
                    "missingFields": ["stopreason"]
                },
                "schemaGuidance": {
                    "requiredFields": ["stopreason"],
                    "stopreasonValues": {
                        "finished": 0,
                        "blocked": 1,
                        "continueNeeded": 2
                    },
                    "triggerHint": "no_schema"
                }
            })
            .to_string(),
        );
        assert!(text.contains("继续执行；如果任务已经完成，就按下面 schema 补齐收尾字段"));
        assert!(
            text.contains("继续执行；如果任务已经完成，就按下面 schema 补齐缺失字段：stopreason")
        );
        assert!(!text.contains("如果任务还没完成，不要停，继续执行当前任务"));
        assert!(text.contains("stopreason 取值：0=finished，1=blocked，2=continue_needed"));
        assert!(text.contains("按条件补齐这些字段"));
        assert!(text.contains("stopreason=0 表示完成，必须 has_evidence=1 且 evidence 非空"));
        assert!(text.contains("stopreason=1 表示阻塞，必须 reason 非空，提供 reason 即可停止"));
        assert!(text.contains("stopreason=2 必须写 next_step"));
        assert!(text.contains("最小可复制样本："));
        assert!(text.contains("\"needs_user_input\":false"));
        assert!(!text.contains("样例："));
    }

    #[test]
    fn stop_hook_guidance_text_for_second_missing_schema_round_must_expand_branching() {
        let text = build_stop_hook_guidance_text_from_output(
            &json!({
                "toolName": "stop_message_auto",
                "continuationPrompt": "继续推进当前任务。",
                "repeatCount": 2,
                "schemaFeedback": {
                    "reasonCode": "stop_schema_missing",
                    "missingFields": ["stopreason"]
                },
                "schemaGuidance": {
                    "requiredFields": ["stopreason"],
                    "stopreasonValues": {
                        "finished": 0,
                        "blocked": 1,
                        "continueNeeded": 2
                    },
                    "triggerHint": "no_schema"
                }
            })
            .to_string(),
        );
        assert!(text.contains("如果当前任务已经完成，就按下面 schema 补齐收尾字段"));
        assert!(text.contains("如果任务已经完成，就按下面 schema 补齐缺失字段：stopreason"));
        assert!(text.contains("如果任务还没完成，不要停，继续执行当前任务"));
        assert!(text.contains("stopreason=0 表示完成，必须 has_evidence=1 且 evidence 非空"));
        assert!(text.contains("stopreason=1 表示阻塞，必须 reason 非空，提供 reason 即可停止"));
        assert!(text.contains("stopreason=2 必须写 next_step"));
        assert!(text.contains("needs_user_input=true 时 next_step 必须直接写要问用户的问题"));
        assert!(text.contains("最小可复制样本："));
        assert!(text.contains("\"next_step\":\"运行下一条验证命令\""));
        assert!(!text.contains("样例："));
    }

    #[test]
    fn stop_hook_guidance_text_rejects_unregistered_feedback_without_default_guidance() {
        let text = build_stop_hook_guidance_text_from_output(
            &json!({
                "toolName": "stop_message_auto",
                "repeatCount": 2,
                "schemaFeedback": {
                    "reasonCode": "stop_schema_unknown_future_reason",
                    "missingFields": ["next_step"]
                }
            })
            .to_string(),
        );
        assert!(text.contains("STOPLESS_CLI_RESULT_MALFORMED"));
        assert!(text.contains("没有注册的修复引导"));
        assert!(!text.contains("triggerHint"));
        assert!(!text.contains("no_schema"));
        assert!(!text.contains("结尾按条件补齐这些字段：stopreason, reason, has_evidence"));
    }

    #[test]
    fn stop_hook_guidance_text_rejects_incomplete_feedback_without_default_guidance() {
        let text = build_stop_hook_guidance_text_from_output(
            &json!({
                "toolName": "stop_message_auto",
                "repeatCount": 2,
                "schemaFeedback": {
                    "reasonCode": "stop_schema_next_step_missing",
                    "missingFields": []
                }
            })
            .to_string(),
        );
        assert!(text.contains("STOPLESS_CLI_RESULT_MALFORMED"));
        assert!(text.contains("schemaFeedback.reasonCode/missingFields 不完整"));
        assert!(!text.contains("no_schema"));
        assert!(!text.contains("结尾按条件补齐这些字段：stopreason, reason, has_evidence"));
    }

    #[test]
    fn stop_hook_guidance_text_accepts_minimal_no_schema_cli_output_without_malformed_warning() {
        let text = build_stop_hook_guidance_text_from_output(
            &json!({
                "toolName": "stop_message_auto",
                "flowId": "stop_message_flow",
                "repeatCount": 1,
                "maxRepeats": 3,
                "continuationPrompt": "继续做下一步；先把手头能确认的结果拿回来。",
                "input": {
                    "flowId": "stop_message_flow",
                    "repeatCount": 1,
                    "maxRepeats": 3,
                    "triggerHint": "no_schema"
                }
            })
            .to_string(),
        );
        assert!(text.contains("上一轮执行结果：repeatCount=1/3。"));
        assert!(text.contains("继续做下一步；先把手头能确认的结果拿回来。"));
        assert!(
            !text.contains("STOPLESS_CLI_RESULT_MALFORMED"),
            "minimal no_schema CLI output is legal and must not be treated as malformed: {text}"
        );
    }

    #[test]
    fn stop_hook_guidance_text_accepts_minimal_non_terminal_schema_cli_output() {
        let text = build_stop_hook_guidance_text_from_output(
            &json!({
                "ok": true,
                "kind": "stop_message_auto",
                "tool": "stop_message_auto",
                "summary": "停止检查需要继续",
                "toolName": "stop_message_auto",
                "flowId": "stop_message_flow",
                "routeHint": "thinking",
                "continuationPrompt": "继续往下做；要是能收尾就直接告诉我做完了，不然就继续推进。",
                "repeatCount": 1,
                "maxRepeats": 3,
                "sessionId": "stopless-live-1782780421308",
                "requestId": "openai-responses-XLC.key1-glm-5.2-20260630T084701341-424854-5137",
                "input": {
                    "flowId": "stop_message_flow",
                    "maxRepeats": 3,
                    "repeatCount": 1,
                    "triggerHint": "non_terminal_schema"
                }
            })
            .to_string(),
        );
        assert!(text.contains("上一轮执行结果：repeatCount=1/3。"));
        assert!(text.contains("继续往下做；要是能收尾就直接告诉我做完了，不然就继续推进。"));
        assert!(
            !text.contains("STOPLESS_CLI_RESULT_MALFORMED"),
            "minimal non_terminal_schema CLI output is legal and must not be treated as malformed: {text}"
        );
    }

    #[test]
    fn stop_hook_guidance_text_accepts_continue_next_step_with_empty_missing_fields() {
        let text = build_stop_hook_guidance_text_from_output(
            &json!({
                "toolName": "stop_message_auto",
                "flowId": "stop_message_flow",
                "repeatCount": 1,
                "maxRepeats": 3,
                "continuationPrompt": "继续往下做。",
                "schemaFeedback": {
                    "reasonCode": "stop_schema_continue_next_step",
                    "missingFields": []
                },
                "input": {
                    "flowId": "stop_message_flow",
                    "repeatCount": 1,
                    "maxRepeats": 3,
                    "triggerHint": "non_terminal_schema"
                }
            })
            .to_string(),
        );
        assert_eq!(text, "继续往下做。");
        assert!(!text.contains("任务还没收尾，继续执行你给出的 next_step"));
        assert!(
            !text.contains("STOPLESS_CLI_RESULT_MALFORMED"),
            "continue_next_step with empty missing fields is legal: {text}"
        );
    }

    #[test]
    fn stop_hook_budget_exhausted_output_must_not_become_new_user_guidance_turn() {
        let mut payload = json!({
          "input": [
            {
              "type": "function_call",
              "call_id": "call_stop_budget_exhausted",
              "name": "exec_command",
              "arguments": "{\"cmd\":\"routecodex hook run reasoning_stop --input-json '{\\\"flowId\\\":\\\"stop_message_flow\\\",\\\"repeatCount\\\":1,\\\"maxRepeats\\\":3,\\\"triggerHint\\\":\\\"budget_exhausted\\\"}'\"}"
            },
            {
              "type": "function_call_output",
              "call_id": "call_stop_budget_exhausted",
              "output": json!({
                "toolName": "stop_message_auto",
                "summary": "stopless budget exhausted",
                "repeatCount": 3,
                "maxRepeats": 3,
                "continuationPrompt": "不要再继续执行了。现在直接收尾并给出最终结论；如果正常收尾已经做不到，就明确说明为什么必须停，并把最后卡点交代清楚。",
                "schemaGuidance": {
                  "requiredFields": ["stopreason", "reason"],
                  "stopreasonValues": { "finished": 0, "blocked": 1, "continueNeeded": 2 },
                  "triggerHint": "budget_exhausted"
                },
                "input": {
                  "flowId": "stop_message_flow",
                  "repeatCount": 3,
                  "maxRepeats": 3,
                  "triggerHint": "budget_exhausted"
                }
              }).to_string()
            }
          ]
        });

        normalize_responses_input_function_calls(&mut payload, &std::collections::HashSet::new())
            .expect("normalize");

        let normalized_items = payload["input"].as_array().expect("input array");
        assert!(
            !normalized_items.iter().any(|item| {
                item.get("type").and_then(Value::as_str) == Some("message")
                    || item
                        .get("role")
                        .and_then(Value::as_str)
                        .map(|role| role.eq_ignore_ascii_case("user"))
                        .unwrap_or(false)
            }),
            "budget_exhausted stop hook output must not inject a fresh user guidance turn: {}",
            payload
        );
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
