use serde_json::{Map, Value};
use std::collections::HashSet;
use std::time::{SystemTime, UNIX_EPOCH};

use crate::hub_reasoning_tool_normalizer::{
    build_message_reasoning_value, normalize_message_reasoning_ssot,
};
use crate::hub_resp_outbound_client_semantics_blocks::client_tool_args::{
    build_client_tool_index, normalize_call_args,
    normalize_responses_tool_call_arguments_for_client, resolve_client_tool_name,
};
use crate::hub_resp_outbound_client_semantics_blocks::responses_reasoning::{
    merge_responses_output_items, normalize_reasoning_summary_for_codex_display,
};
use crate::hub_resp_outbound_client_semantics_blocks::responses_usage::normalize_responses_usage;
use crate::shared_responses_tool_utils::strip_internal_tooling_metadata_impl;

fn now_unix_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

fn now_unix_seconds() -> i64 {
    (now_unix_millis() / 1000) as i64
}

fn is_chat_completion_id(value: &str) -> bool {
    value.trim().to_ascii_lowercase().starts_with("chatcmpl")
}

fn allocate_responses_id(response: &Map<String, Value>) -> String {
    if let Some(existing) = read_object_string(response, "id") {
        if !is_chat_completion_id(existing.as_str()) {
            return existing;
        }
    }
    format!("resp_{}", now_unix_millis())
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

fn require_explicit_tool_call_id(call_id: Option<String>, reason: &str) -> Result<String, String> {
    let resolved = call_id.ok_or_else(|| reason.to_string())?;
    let lowered = resolved.trim().to_ascii_lowercase();
    if lowered.starts_with("call_servertool_fallback_") {
        return Err(format!(
            "synthetic_tool_call_id: RouteCodex synthetic fallback tool_call id is forbidden: {}",
            resolved
        ));
    }
    Ok(resolved)
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

fn read_nonstandard_response_message(response: &Map<String, Value>) -> String {
    read_object_string(response, "msg")
        .or_else(|| read_object_string(response, "message"))
        .unwrap_or_else(|| {
            "Upstream returned non-standard Chat completion payload (missing choices).".to_string()
        })
}

fn nonstandard_response_error(response: &Map<String, Value>) -> String {
    let mut message = read_nonstandard_response_message(response);
    if let Some(code) = read_failed_status_code(response) {
        message = format!("{} (provider_status={})", message, code);
    }
    message
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
        if ch.is_ascii_alphanumeric() || ch == '_' || ch == '-' || ch == '.' {
            out.push(ch);
        } else if !ch.is_whitespace() {
            out.push('_');
        }
    }
    let trimmed = out
        .trim_matches(|ch: char| matches!(ch, '_' | '-' | '.'))
        .to_string();
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

fn read_raw_object_string(row: &Map<String, Value>, key: &str) -> Option<String> {
    row.get(key)
        .and_then(|v| v.as_str())
        .map(|v| v.to_string())
        .filter(|v| !v.is_empty())
}

fn normalize_output_text_content(content: &Value) -> Vec<Value> {
    let mut output: Vec<Value> = Vec::new();
    if let Some(raw) = content.as_str() {
        let text = raw.to_string();
        if !text.trim().is_empty() {
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
            let text = raw.to_string();
            if !text.trim().is_empty() {
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
            let text = read_raw_object_string(row, "text")
                .or_else(|| read_raw_object_string(row, "content"))
                .unwrap_or_default();
            if !text.trim().is_empty() {
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
    let mut saw_output_text = false;
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
        saw_output_text = true;
        texts.push(
            row.get("text")
                .and_then(|v| v.as_str())
                .map(|v| v.to_string())
                .unwrap_or_default(),
        );
    }
    if !saw_output_text {
        None
    } else {
        Some(texts.join(""))
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
            if let Some(stripped) = raw_id.strip_prefix("fc_") {
                if !stripped.is_empty() {
                    ids.insert(stripped.to_string());
                }
            }
        }
    }
    ids
}

type PendingToolCall = (usize, String, String, String);

fn read_context_object<'a>(context: &'a Value, key: &str) -> Option<&'a Map<String, Value>> {
    context.as_object()?.get(key)?.as_object()
}

fn read_nested_object<'a>(
    row: &'a Map<String, Value>,
    key: &str,
) -> Option<&'a Map<String, Value>> {
    row.get(key)?.as_object()
}

fn context_value<'a>(context: &'a Value, key: &str) -> Option<&'a Value> {
    context.as_object()?.get(key)
}

fn context_bool(context: &Value, key: &str) -> bool {
    context_value(context, key)
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

fn read_response_continuation(context: &Value) -> Option<Map<String, Value>> {
    let semantics = read_context_object(context, "responseSemantics")?;
    let continuation = read_nested_object(semantics, "continuation")?;
    Some(continuation.clone())
}

fn read_response_semantics_pointer_field(context: &Value, key: &str) -> Option<String> {
    let continuation = read_response_continuation(context)?;
    let resume_from = read_nested_object(&continuation, "resumeFrom");
    read_object_string(&continuation, key)
        .or_else(|| resume_from.and_then(|row| read_object_string(row, key)))
}

fn read_context_client_model(context: &Value) -> Option<String> {
    let row = context.as_object()?;
    for key in ["displayModel", "clientModelId", "originalModelId", "model"] {
        if let Some(value) = row
            .get(key)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            return Some(value.to_string());
        }
    }
    row.get("metadata")
        .and_then(Value::as_object)
        .and_then(|metadata| {
            for key in ["displayModel", "clientModelId", "originalModelId", "model"] {
                if let Some(value) = metadata
                    .get(key)
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                {
                    return Some(value.to_string());
                }
            }
            None
        })
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

    if !out.contains_key("metadata") {
        if let Some(value) = context_value(context, "metadata") {
            if let Some(metadata) = sanitize_client_visible_metadata(value) {
                out.insert("metadata".to_string(), metadata);
            }
        }
    }

    for (context_key, output_key) in [
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

fn sanitize_client_visible_metadata(value: &Value) -> Option<Value> {
    let row = value.as_object()?;
    let mut out = Map::new();
    for (key, item) in row {
        if key.starts_with("__")
            || matches!(
                key.as_str(),
                "target"
                    | "route"
                    | "routing"
                    | "requestContext"
                    | "responsesRequestContext"
                    | "clientHeaders"
                    | "originalRequest"
            )
        {
            continue;
        }
        out.insert(key.clone(), item.clone());
    }
    Some(Value::Object(out))
}

fn merge_source_retention(out: &mut Map<String, Value>, source_row: &Map<String, Value>) {
    if let Some(source_output) = source_row.get("output").and_then(|v| v.as_array()) {
        if let Some(base_output) = out.get("output").and_then(|v| v.as_array()) {
            let merged_output = merge_responses_output_items(base_output, source_output);
            out.insert("output".to_string(), Value::Array(merged_output));
        }
    }

    if let Some(source_metadata) = source_row.get("metadata").and_then(|v| v.as_object()) {
        let existing_metadata = out
            .entry("metadata".to_string())
            .or_insert_with(|| Value::Object(Map::new()))
            .as_object_mut()
            .unwrap();
        for (key, value) in source_metadata {
            existing_metadata.insert(key.clone(), value.clone());
        }
    }

    for key in ["temperature", "top_p", "prompt_cache_key", "reasoning"] {
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

pub(crate) fn build_responses_payload_from_chat_core(
    payload: &Value,
    request_id_hint: Option<&str>,
    context: &Value,
) -> Result<Value, String> {
    let response = unwrap_responses_data_node(payload);
    let Some(response_row) = response.as_object() else {
        return Err("Upstream returned non-object response payload".to_string());
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
        return Err(nonstandard_response_error(response_row));
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
    let should_emit_message = !content_parts.is_empty();

    let response_id = allocate_responses_id(response_row);
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
        let _has_explicit_summary = reasoning_payload
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
                                (
                                    "type".to_string(),
                                    Value::String("summary_text".to_string()),
                                ),
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
        if let Some(content) = reasoning_payload.get("content") {
            reasoning_item.insert("content".to_string(), content.clone());
        }
        reasoning_item.insert(
            "encrypted_content".to_string(),
            reasoning_payload
                .get("encrypted_content")
                .cloned()
                .unwrap_or(Value::Null),
        );
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

    // P0: dedup — if reasoning text matches message text, remove reasoning item
    // Runs AFTER message push so len >= 2 and reasoning_idx = len-2 correctly points to reasoning
    if output_items.len() >= 2 {
        let reasoning_idx = output_items.len() - 2;
        if let (Some(reasoning_row), Some(message_row)) = (
            output_items.get(reasoning_idx).and_then(|v| v.as_object()),
            output_items.last().and_then(|v| v.as_object()),
        ) {
            if reasoning_row.get("type").and_then(|v| v.as_str()) == Some("reasoning")
                && message_row.get("type").and_then(|v| v.as_str()) == Some("message")
            {
                let reasoning_text = reasoning_row
                    .get("content")
                    .and_then(|v| v.as_array())
                    .map(|arr| {
                        arr.iter()
                            .filter_map(|e| e.get("text").and_then(|t| t.as_str()))
                            .collect::<Vec<_>>()
                    })
                    .filter(|t| !t.is_empty())
                    .map(|t| t.join(""))
                    .map(|t| {
                        t.trim()
                            .trim_start_matches("**Thinking**")
                            .trim()
                            .to_string()
                    })
                    .unwrap_or_default();
                let message_text = message_row
                    .get("content")
                    .and_then(|v| v.as_array())
                    .map(|arr| {
                        arr.iter()
                            .filter_map(|e| e.get("text").and_then(|t| t.as_str()))
                            .collect::<Vec<_>>()
                    })
                    .filter(|t| !t.is_empty())
                    .map(|t| t.join(""))
                    .unwrap_or_default();
                if !reasoning_text.is_empty() && reasoning_text == message_text {
                    output_items.remove(reasoning_idx);
                }
            }
        }
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
        let Some(mut name) = normalize_responses_function_name(raw_name) else {
            continue;
        };

        let client_tools_raw = context
            .as_object()
            .and_then(|v| v.get("toolsRaw"))
            .cloned()
            .unwrap_or_else(|| Value::Array(Vec::new()));
        let tool_index = build_client_tool_index(&client_tools_raw);
        let client_spec =
            if tool_index.by_name.is_empty() && tool_index.by_namespace_name.is_empty() {
                None
            } else {
                resolve_client_tool_name(&tool_index, None, name.as_str())
            };
        let client_declared_name = client_spec.as_ref().map(|spec| spec.declared_name.clone());

        let call_id = require_explicit_tool_call_id(
            read_object_string(call_row, "id").or_else(|| read_object_string(call_row, "call_id")),
            format!(
                "missing_tool_call_id: assistant tool_call is missing id/call_id at index {}",
                index
            )
            .as_str(),
        )?;
        let args_raw = fn_row
            .and_then(|v| v.get("arguments"))
            .or_else(|| call_row.get("arguments"))
            .cloned()
            .unwrap_or(Value::Object(Map::new()));
        let arguments = if let Some(spec) = client_spec.as_ref() {
            let normalized = normalize_call_args(spec.declared_name.as_str(), &args_raw, spec);
            if let Some(raw) = normalized.as_str() {
                raw.to_string()
            } else {
                serde_json::to_string(&normalized).unwrap_or_else(|_| "{}".to_string())
            }
        } else if let Some(raw) = args_raw.as_str() {
            raw.to_string()
        } else {
            serde_json::to_string(&args_raw).unwrap_or_else(|_| "{}".to_string())
        };
        if let Some(declared_name) = client_declared_name {
            name = declared_name;
        }

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
    if let Some(model) = response_row
        .get("model")
        .cloned()
        .map(|upstream_model| {
            read_context_client_model(context)
                .map(Value::String)
                .unwrap_or(upstream_model)
        })
        .or_else(|| read_context_client_model(context).map(Value::String))
    {
        out.insert("model".to_string(), model);
    }
    out.insert(
        "status".to_string(),
        Value::String(if pending_calls.is_empty() {
            "completed".to_string()
        } else {
            "requires_action".to_string()
        }),
    );
    if let Some(previous_response_id) =
        read_response_semantics_pointer_field(context, "previousResponseId")
    {
        out.insert(
            "previous_response_id".to_string(),
            Value::String(previous_response_id),
        );
    }
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
