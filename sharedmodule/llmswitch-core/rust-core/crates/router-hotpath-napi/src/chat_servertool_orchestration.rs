use napi::bindgen_prelude::Result as NapiResult;
use napi_derive::napi;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};

use crate::chat_process_media_semantics::strip_chat_process_historical_images;
use crate::chat_web_search_intent::analyze_chat_web_search_intent;
use crate::hub_bridge_actions::utils::{
    can_servertool_own_tool_call_id, is_synthetic_routecodex_tool_call_id,
};
use crate::web_search_mode::{resolve_web_search_execution_mode, WebSearchExecutionMode};
use crate::virtual_router_engine::routing::{
    resolve_session_scope, resolve_sticky_key, resolve_stop_message_scope,
};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ChatWebSearchPlanOutput {
    should_inject: bool,
    selected_engine_indexes: Vec<i64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ChatClockPlanOutput {
    should_inject: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ChatContinueExecutionPlanOutput {
    should_inject: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ChatServerToolBundlePlanOutput {
    web_search: ChatWebSearchPlanOutput,
    clock: ChatClockPlanOutput,
    continue_execution: ChatContinueExecutionPlanOutput,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PayloadContractSignalOutput {
    reason: String,
    marker: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ServertoolExtractedToolCallOutput {
    id: String,
    name: String,
    arguments: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ServertoolResponseStageOutput {
    provider_response_shape: String,
    is_canonical_chat_completion_payload: bool,
    payload_contract_signal: Option<PayloadContractSignalOutput>,
    normalized_payload: Value,
    tool_calls: Vec<ServertoolExtractedToolCallOutput>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ServertoolDispatchPlannerInput {
    tool_calls: Vec<ServertoolExtractedToolCallOutput>,
    disable_tool_call_handlers: bool,
    include_tool_call_handler_names: Option<Vec<String>>,
    exclude_tool_call_handler_names: Option<Vec<String>>,
    registered_tool_call_handlers: Vec<ServertoolRegisteredToolCallHandlerInput>,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ServertoolRegisteredToolCallHandlerInput {
    name: String,
    trigger: String,
    execution_mode: String,
    strip_after_execute: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ServertoolDispatchCandidateOutput {
    id: String,
    name: String,
    arguments: String,
    execution_mode: String,
    strip_after_execute: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ServertoolDispatchSkippedOutput {
    id: String,
    name: String,
    reason: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ServertoolDispatchPlanOutput {
    executable_tool_calls: Vec<ServertoolDispatchCandidateOutput>,
    skipped_tool_calls: Vec<ServertoolDispatchSkippedOutput>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ServertoolOutcomePlannerInput {
    tool_calls: Vec<ServertoolExtractedToolCallOutput>,
    executed_tool_calls: Vec<ServertoolOutcomeExecutedToolCallInput>,
    executed_flow_ids: Vec<String>,
    last_execution_flow_id: Option<String>,
    has_last_execution_followup: bool,
    session_id: Option<String>,
    conversation_id: Option<String>,
    tool_outputs: Option<Vec<Value>>,
    pending_injection_message_kinds: Option<Vec<String>>,
    followup_injection_ops: Option<Vec<String>>,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ServertoolOutcomeExecutedToolCallInput {
    id: String,
    name: String,
    arguments: String,
    execution_mode: String,
    strip_after_execute: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ServertoolOutcomePlanOutput {
    outcome_mode: String,
    remaining_tool_call_ids: Vec<String>,
    pending_session_id: Option<String>,
    alias_session_ids: Vec<String>,
    pending_injection_message_kinds: Vec<String>,
    pending_injection_messages_resolved: Vec<Value>,
    flow_id: Option<String>,
    use_last_execution_followup: bool,
    use_generic_followup: bool,
    followup_strategy: String,
    requires_pending_injection: bool,
    primary_execution_mode: Option<String>,
    followup_injection_ops: Vec<String>,
    followup_injection_ops_resolved: Vec<Value>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ServertoolGenericFollowupPayloadInput {
    model: Option<String>,
    messages: Vec<Value>,
    tools: Option<Vec<Value>>,
    parameters: Option<Map<String, Value>>,
    assistant_message: Option<Value>,
    tool_outputs: Option<Vec<Value>>,
    followup_injection_ops: Vec<Value>,
}

fn build_pending_injection_messages_resolved(
    message_kinds: &[String],
    executed_tool_calls: &[ServertoolOutcomeExecutedToolCallInput],
    tool_outputs: &[Value],
) -> Result<Vec<Value>, String> {
    let mut out = Vec::new();
    let allow_ids: std::collections::HashSet<&str> = executed_tool_calls
        .iter()
        .map(|entry| entry.id.trim())
        .filter(|value| !value.is_empty())
        .collect();

    for raw in message_kinds {
        let kind = raw.trim();
        if kind.is_empty() {
            continue;
        }
        if kind == "assistant_tool_calls" {
            let tool_calls = executed_tool_calls
                .iter()
                .map(|entry| {
                    serde_json::json!({
                        "id": entry.id,
                        "type": "function",
                        "function": {
                            "name": entry.name,
                            "arguments": entry.arguments
                        }
                    })
                })
                .collect::<Vec<_>>();
            out.push(serde_json::json!({
                "role": "assistant",
                "content": Value::Null,
                "tool_calls": tool_calls
            }));
            continue;
        }
        if kind == "tool_outputs" {
            for entry in tool_outputs {
                let Some(record) = entry.as_object() else {
                    return Err("toolOutputs entry must be an object".to_string());
                };
                let Some(tool_call_id) = record
                    .get("tool_call_id")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                else {
                    return Err("toolOutputs entry missing non-empty tool_call_id".to_string());
                };
                if !allow_ids.contains(tool_call_id) {
                    continue;
                }
                let name = record
                    .get("name")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .unwrap_or("tool");
                let content = match record.get("content") {
                    Some(Value::String(value)) => value.clone(),
                    Some(value) => serde_json::to_string(value)
                        .map_err(|error| format!("toolOutputs content serialization failed: {}", error))?,
                    None => "null".to_string(),
                };
                out.push(serde_json::json!({
                    "role": "tool",
                    "tool_call_id": tool_call_id,
                    "name": name,
                    "content": content
                }));
            }
            continue;
        }
        return Err(format!(
            "unsupported pending injection message kind: {}",
            kind
        ));
    }
    Ok(out)
}

fn normalize_nonempty_string_vec(values: Option<&Vec<String>>) -> Vec<String> {
    let mut out = Vec::new();
    let source = match values {
        Some(entries) => entries.as_slice(),
        None => &[],
    };
    for raw in source {
        let value = raw.trim();
        if !value.is_empty() {
            out.push(value.to_string());
        }
    }
    out
}

fn build_required_followup_injection_ops(values: &[String]) -> Result<Vec<Value>, String> {
    let mut out = Vec::new();
    for raw in values {
        let op = raw.trim();
        if op.is_empty() {
            continue;
        }
        if op == "append_assistant_message" {
            out.push(serde_json::json!({
                "op": "append_assistant_message",
                "required": true
            }));
            continue;
        }
        if op == "append_tool_messages_from_tool_outputs" {
            out.push(serde_json::json!({
                "op": "append_tool_messages_from_tool_outputs",
                "required": true
            }));
            continue;
        }
        return Err(format!("unsupported generic followup op: {}", op));
    }
    Ok(out)
}

fn build_servertool_generic_followup_payload(
    input: ServertoolGenericFollowupPayloadInput,
) -> Result<Value, String> {
    let model = input
        .model
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "generic followup payload requires non-empty model".to_string())?;
    let mut messages = strip_chat_process_historical_images(
        input.messages,
        "[Image omitted]".to_string(),
    )
    .messages;
    let mut tools = input.tools.unwrap_or_default();
    let mut parameters = input.parameters.unwrap_or_default();
    for raw in input.followup_injection_ops {
        let Some(record) = raw.as_object() else {
            return Err("followupInjectionOps entry must be an object".to_string());
        };
        let op = record
            .get("op")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| "followupInjectionOps entry missing non-empty op".to_string())?;
        let required = record
            .get("required")
            .and_then(Value::as_bool)
            .unwrap_or(true);
        if op == "append_assistant_message" {
            let Some(assistant) = input.assistant_message.clone() else {
                if required {
                    return Err("append_assistant_message requires assistantMessage".to_string());
                }
                continue;
            };
            messages.push(assistant);
            continue;
        }
        if op == "append_tool_messages_from_tool_outputs" {
            let Some(tool_outputs) = input.tool_outputs.clone() else {
                if required {
                    return Err("append_tool_messages_from_tool_outputs requires toolOutputs".to_string());
                }
                continue;
            };
            if tool_outputs.is_empty() {
                if required {
                    return Err("append_tool_messages_from_tool_outputs requires non-empty toolOutputs".to_string());
                }
                continue;
            }
            for entry in tool_outputs {
                let Some(record) = entry.as_object() else {
                    return Err("toolOutputs entry must be an object".to_string());
                };
                let Some(tool_call_id) = record
                    .get("tool_call_id")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                else {
                    return Err("toolOutputs entry missing non-empty tool_call_id".to_string());
                };
                let name = record
                    .get("name")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .unwrap_or("tool");
                let content = match record.get("content") {
                    Some(Value::String(value)) => value.clone(),
                    Some(value) => serde_json::to_string(value)
                        .map_err(|error| format!("toolOutputs content serialization failed: {}", error))?,
                    None => "null".to_string(),
                };
                messages.push(serde_json::json!({
                    "role": "tool",
                    "tool_call_id": tool_call_id,
                    "name": name,
                    "content": content
                }));
            }
            continue;
        }
        if op == "replace_tools" {
            let next_tools = record
                .get("tools")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            tools = next_tools;
            continue;
        }
        if op == "preserve_tools" {
            continue;
        }
        if op == "ensure_standard_tools" {
            if tools.is_empty() {
                continue;
            }
            let include_reasoning_stop = record
                .get("includeReasoningStopTool")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            if !include_reasoning_stop {
                continue;
            }
            let already_has_reasoning_stop = tools.iter().any(|tool| {
                tool.as_object()
                    .and_then(|tool_record| tool_record.get("function"))
                    .and_then(Value::as_object)
                    .and_then(|function| function.get("name"))
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .map(str::to_ascii_lowercase)
                    == Some("reasoning.stop".to_string())
            });
            if already_has_reasoning_stop {
                continue;
            }
            let Some(tool_definition) = record.get("reasoningStopToolDefinition") else {
                continue;
            };
            if !tool_definition.is_object() {
                continue;
            }
            tools.push(tool_definition.clone());
            continue;
        }
        if op == "force_tool_choice" {
            match record.get("value") {
                Some(Value::Null) | None => {
                    parameters.remove("tool_choice");
                }
                Some(value) => {
                    parameters.insert("tool_choice".to_string(), value.clone());
                    let is_function_choice = value
                        .as_object()
                        .and_then(|entry| entry.get("type"))
                        .and_then(Value::as_str)
                        .map(str::trim)
                        .map(str::to_ascii_lowercase)
                        == Some("function".to_string());
                    if is_function_choice {
                        parameters.insert(
                            "parallel_tool_calls".to_string(),
                            Value::Bool(false),
                        );
                    }
                }
            }
            continue;
        }
        if op == "append_user_text" {
            let text = record
                .get("text")
                .and_then(Value::as_str)
                .map(str::trim)
                .unwrap_or("");
            if !text.is_empty() {
                messages.push(serde_json::json!({
                    "role": "user",
                    "content": text
                }));
            }
            continue;
        }
        if op == "append_tool_if_missing" {
            let tool_name = record
                .get("toolName")
                .and_then(Value::as_str)
                .map(str::trim)
                .unwrap_or("");
            let Some(tool_definition) = record.get("toolDefinition") else {
                continue;
            };
            if tool_name.is_empty() || !tool_definition.is_object() {
                continue;
            }
            let exists = tools.iter().any(|tool| {
                tool.as_object()
                    .and_then(|tool_record| tool_record.get("function"))
                    .and_then(Value::as_object)
                    .and_then(|function| function.get("name"))
                    .and_then(Value::as_str)
                    .map(str::trim)
                    == Some(tool_name)
            });
            if !exists {
                tools.push(tool_definition.clone());
            }
            continue;
        }
        if op == "inject_vision_summary" {
            let summary = record
                .get("summary")
                .and_then(Value::as_str)
                .map(str::trim)
                .unwrap_or("");
            if summary.is_empty() {
                continue;
            }
            let summary_text = format!("[Vision] {}", summary);
            let mut injected = false;
            for message in messages.iter_mut() {
                let Some(message_record) = message.as_object_mut() else {
                    continue;
                };
                let Some(content_parts) = message_record
                    .get_mut("content")
                    .and_then(Value::as_array_mut)
                else {
                    continue;
                };
                let had_placeholder = content_parts.iter().any(|part| {
                    part.as_object()
                        .and_then(|entry| entry.get("text"))
                        .and_then(Value::as_str)
                        .map(str::trim)
                        == Some("[Image omitted]")
                });
                if !had_placeholder {
                    continue;
                }
                content_parts.push(serde_json::json!({
                    "type": "text",
                    "text": summary_text
                }));
                injected = true;
            }
            if !injected {
                for idx in (0..messages.len()).rev() {
                    let Some(message_record) = messages[idx].as_object_mut() else {
                        continue;
                    };
                    let role = message_record
                        .get("role")
                        .and_then(Value::as_str)
                        .map(str::trim)
                        .map(str::to_ascii_lowercase)
                        .unwrap_or_default();
                    if role != "user" {
                        continue;
                    }
                    if let Some(content_parts) = message_record
                        .get_mut("content")
                        .and_then(Value::as_array_mut)
                    {
                        content_parts.push(serde_json::json!({
                            "type": "text",
                            "text": summary_text
                        }));
                    } else {
                        let existing = message_record
                            .get("content")
                            .and_then(Value::as_str)
                            .map(str::trim)
                            .unwrap_or("");
                        let next = if existing.is_empty() {
                            summary_text.clone()
                        } else {
                            format!("{}\n{}", existing, summary_text)
                        };
                        message_record.insert("content".to_string(), Value::String(next));
                    }
                    injected = true;
                    break;
                }
            }
            if !injected {
                messages.push(serde_json::json!({
                    "role": "user",
                    "content": summary_text
                }));
            }
            continue;
        }
        if op == "trim_openai_messages" {
            let max_non_system_messages = record
                .get("maxNonSystemMessages")
                .and_then(Value::as_i64)
                .unwrap_or(16);
            let max_non_system_messages = std::cmp::max(1_i64, max_non_system_messages) as usize;
            let mut non_system_indices = Vec::new();
            for (idx, entry) in messages.iter().enumerate() {
                let role = entry
                    .as_object()
                    .and_then(|entry| entry.get("role"))
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .map(str::to_ascii_lowercase)
                    .unwrap_or_default();
                if role.is_empty() || role == "system" || role == "developer" {
                    continue;
                }
                non_system_indices.push(idx);
            }
            if non_system_indices.len() > max_non_system_messages {
                let keep_tail = non_system_indices[non_system_indices.len() - max_non_system_messages..]
                    .iter()
                    .copied()
                    .collect::<std::collections::HashSet<_>>();
                let mut next_messages = Vec::with_capacity(messages.len());
                for (idx, entry) in messages.into_iter().enumerate() {
                    let role = entry
                        .as_object()
                        .and_then(|record| record.get("role"))
                        .and_then(Value::as_str)
                        .map(str::trim)
                        .map(str::to_ascii_lowercase)
                        .unwrap_or_default();
                    if role == "system" || role == "developer" || keep_tail.contains(&idx) {
                        next_messages.push(entry);
                    }
                }
                messages = next_messages;
            }
            continue;
        }
        if op == "compact_tool_content" {
            let max_chars = record
                .get("maxChars")
                .and_then(Value::as_i64)
                .map(|value| std::cmp::max(64_i64, value) as usize)
                .unwrap_or(1200);
            for message in messages.iter_mut() {
                let Some(message_record) = message.as_object_mut() else {
                    continue;
                };
                let role = message_record
                    .get("role")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .map(str::to_ascii_lowercase)
                    .unwrap_or_default();
                if role != "tool" {
                    continue;
                }
                let current = message_record.get("content").cloned().unwrap_or(Value::Null);
                let text = match current {
                    Value::String(value) => value,
                    value => serde_json::to_string(&value).unwrap_or_else(|_| "null".to_string()),
                };
                if text.len() <= max_chars {
                    continue;
                }
                let keep_head = std::cmp::max(24_usize, ((max_chars as f64) * 0.45).floor() as usize);
                let keep_tail = std::cmp::max(24_usize, ((max_chars as f64) * 0.35).floor() as usize);
                let omitted = text
                    .len()
                    .saturating_sub(keep_head)
                    .saturating_sub(keep_tail);
                let head = &text[..std::cmp::min(keep_head, text.len())];
                let tail_start = text.len().saturating_sub(keep_tail);
                let tail = &text[tail_start..];
                message_record.insert(
                    "content".to_string(),
                    Value::String(format!(
                        "{}\n...[tool_output_compacted omitted={}]...\n{}",
                        head, omitted, tail
                    )),
                );
            }
            continue;
        }
        if op == "inject_system_text" {
            let text = record
                .get("text")
                .and_then(Value::as_str)
                .map(str::trim)
                .unwrap_or("");
            if text.is_empty() {
                continue;
            }
            let mut insert_at = 0usize;
            while insert_at < messages.len() {
                let role = messages[insert_at]
                    .as_object()
                    .and_then(|entry| entry.get("role"))
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .map(str::to_lowercase)
                    .unwrap_or_default();
                if role == "system" {
                    insert_at += 1;
                    continue;
                }
                break;
            }
            messages.insert(
                insert_at,
                serde_json::json!({
                    "role": "system",
                    "content": text
                }),
            );
            continue;
        }
        if op == "drop_tool_by_name" {
            let drop_name = record
                .get("name")
                .and_then(Value::as_str)
                .map(str::trim)
                .unwrap_or("");
            if drop_name.is_empty() {
                continue;
            }
            tools.retain(|tool| {
                let Some(tool_record) = tool.as_object() else {
                    return false;
                };
                let tool_name = tool_record
                    .get("function")
                    .and_then(Value::as_object)
                    .and_then(|function| function.get("name"))
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .unwrap_or("");
                if tool_name.is_empty() {
                    return true;
                }
                tool_name != drop_name
            });
            continue;
        }
        return Err(format!("unsupported generic followup op: {}", op));
    }
    let mut out = Map::new();
    out.insert("model".to_string(), Value::String(model));
    out.insert("messages".to_string(), Value::Array(messages));
    out.insert("tools".to_string(), Value::Array(tools));
    if !parameters.is_empty() {
        out.insert("parameters".to_string(), Value::Object(parameters));
    }
    Ok(Value::Object(out))
}

#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ServertoolAutoHookSpecInput {
    id: String,
    phase: String,
    priority: i64,
    order: i64,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ServertoolAutoHookPlannerInput {
    hooks: Vec<ServertoolAutoHookSpecInput>,
    include_auto_hook_ids: Option<Vec<String>>,
    exclude_auto_hook_ids: Option<Vec<String>>,
    optional_primary_hook_order: Vec<String>,
    mandatory_hook_order: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ServertoolAutoHookPlanEntry {
    id: String,
    phase: String,
    priority: i64,
    order: i64,
    queue: String,
    queue_index: i64,
    queue_total: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ServertoolAutoHookPlannerOutput {
    optional_queue: Vec<ServertoolAutoHookPlanEntry>,
    mandatory_queue: Vec<ServertoolAutoHookPlanEntry>,
}

fn detect_provider_response_shape(payload: &Value) -> &'static str {
    let row = match payload.as_object() {
        Some(v) => v,
        None => return "unknown",
    };
    if row.get("choices").map(|v| v.is_array()).unwrap_or(false) {
        return "openai-chat";
    }
    let object_is_response = row
        .get("object")
        .and_then(|v| v.as_str())
        .map(|v| v == "response")
        .unwrap_or(false);
    if object_is_response || row.get("output").map(|v| v.is_array()).unwrap_or(false) {
        return "openai-responses";
    }
    if row.get("content").map(|v| v.is_array()).unwrap_or(false)
        || row.get("stop_reason").and_then(|v| v.as_str()).is_some()
    {
        return "anthropic-messages";
    }
    if row.get("candidates").map(|v| v.is_array()).unwrap_or(false) {
        return "gemini-chat";
    }
    "unknown"
}

fn read_trimmed_string(value: Option<&Value>) -> String {
    value
        .and_then(|v| v.as_str())
        .map(|v| v.trim().to_string())
        .unwrap_or_default()
}

fn normalize_filter_token_set(values: Option<&Vec<String>>) -> Option<Vec<String>> {
    let mut out = Vec::new();
    let source = match values {
        Some(entries) => entries.as_slice(),
        None => &[],
    };
    for raw in source {
        let value = raw.trim().to_ascii_lowercase();
        if !value.is_empty() {
            out.push(value);
        }
    }
    if out.is_empty() {
        None
    } else {
        out.sort();
        out.dedup();
        Some(out)
    }
}

fn is_name_included(name: &str, include: Option<&Vec<String>>, exclude: Option<&Vec<String>>) -> bool {
    let normalized = normalize_servertool_call_name(name);
    if let Some(allow) = include {
        if !allow.iter().any(|entry| entry == &normalized) {
            return false;
        }
    }
    if let Some(deny) = exclude {
        if deny.iter().any(|entry| entry == &normalized) {
            return false;
        }
    }
    true
}

fn normalize_servertool_call_name(name: &str) -> String {
    let normalized = name.trim().to_ascii_lowercase();
    match normalized.as_str() {
        "websearch" | "web-search" => "web_search".to_string(),
        "reasoning_stop" | "reasoning-stop" => "reasoning.stop".to_string(),
        _ => normalized,
    }
}

fn normalize_auto_hook_phase(value: &str) -> String {
    let normalized = value.trim().to_ascii_lowercase();
    match normalized.as_str() {
        "before" => "pre".to_string(),
        "after" => "post".to_string(),
        "pre" | "post" | "default" => normalized,
        _ => "default".to_string(),
    }
}

fn resolve_auto_hook_phase_rank(phase: &str) -> i64 {
    match normalize_auto_hook_phase(phase).as_str() {
        "pre" => 0,
        "post" => 2,
        _ => 1,
    }
}

fn create_servertool_extraction_id(tool_name: &str, request_id: &str, sequence: usize) -> String {
    let mut hasher = Sha256::new();
    hasher.update(request_id.as_bytes());
    hasher.update(b":");
    hasher.update(tool_name.as_bytes());
    hasher.update(b":");
    hasher.update(sequence.to_string().as_bytes());
    let digest = format!("{:x}", hasher.finalize());
    format!("call_{}", &digest[..24])
}

fn looks_like_tool_execution_transcript(raw: &str) -> bool {
    let text = raw.trim().to_ascii_lowercase();
    if text.is_empty() {
        return false;
    }
    text.starts_with("chunk id:")
        || (text.contains("wall time:") && text.contains("process exited with code"))
        || (text.contains("original token count:") && text.contains("process exited with code"))
}

fn should_skip_malformed_historical_tool_call(name: &str, args: &str) -> bool {
    matches!(name, "exec_command" | "apply_patch" | "shell_command")
        && looks_like_tool_execution_transcript(args)
}

fn stringify_tool_args(raw_args: Option<&Value>) -> String {
    match raw_args {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Null) | None => String::new(),
        Some(other) => serde_json::to_string(other).unwrap_or_default(),
    }
}

fn resolve_tool_call_id(
    tool_call_obj: &mut Map<String, Value>,
    tool_name: Option<&str>,
    request_id: &str,
    sequence: &mut usize,
) -> Result<String, String> {
    let existing = read_trimmed_string(tool_call_obj.get("id"));
    if !existing.is_empty() {
        if is_synthetic_routecodex_tool_call_id(existing.as_str()) {
            return Err(format!(
                "synthetic_tool_call_id: RouteCodex synthetic fallback tool_call id is forbidden: {}",
                existing
            ));
        }
        return Ok(existing);
    }
    let normalized_name = tool_name.unwrap_or_default().trim();
    if can_servertool_own_tool_call_id(normalized_name) {
        *sequence += 1;
        let generated = create_servertool_extraction_id(normalized_name, request_id, *sequence);
        tool_call_obj.insert("id".to_string(), Value::String(generated.clone()));
        return Ok(generated);
    }
    Err("tool_call missing required id".to_string())
}

fn extract_tool_calls_from_message_mut(
    message: &mut Map<String, Value>,
    request_id: &str,
    sequence: &mut usize,
) -> Result<Vec<ServertoolExtractedToolCallOutput>, String> {
    let tool_calls = match message.get_mut("tool_calls").and_then(|v| v.as_array_mut()) {
        Some(v) if !v.is_empty() => v,
        _ => return Ok(Vec::new()),
    };
    let mut out = Vec::new();
    for entry in tool_calls.iter_mut() {
        let tool_call_obj = match entry.as_object_mut() {
            Some(v) => v,
            None => continue,
        };
        let function_obj = tool_call_obj
            .get("function")
            .and_then(|v| v.as_object())
            .or_else(|| tool_call_obj.get("functionCall").and_then(|v| v.as_object()))
            .or_else(|| tool_call_obj.get("function_call").and_then(|v| v.as_object()));
        let raw_name = function_obj
            .map(|row| read_trimmed_string(row.get("name")))
            .unwrap_or_default();
        if raw_name.is_empty() {
            continue;
        }
        let name = normalize_servertool_call_name(raw_name.as_str());
        let args = stringify_tool_args(
            function_obj
                .and_then(|row| row.get("arguments").or_else(|| row.get("args")).or_else(|| row.get("input")))
                .or_else(|| tool_call_obj.get("arguments"))
                .or_else(|| tool_call_obj.get("args"))
                .or_else(|| tool_call_obj.get("input")),
        );
        if should_skip_malformed_historical_tool_call(name.as_str(), args.as_str()) {
            continue;
        }
        let id = resolve_tool_call_id(tool_call_obj, Some(name.as_str()), request_id, sequence)?;
        out.push(ServertoolExtractedToolCallOutput {
            id,
            name,
            arguments: args,
        });
    }
    Ok(out)
}

fn extract_tool_calls_from_chat_payload_mut(
    payload: &mut Value,
    request_id: &str,
) -> Result<Vec<ServertoolExtractedToolCallOutput>, String> {
    let row = match payload.as_object_mut() {
        Some(v) => v,
        None => return Ok(Vec::new()),
    };
    let choices = match row.get_mut("choices").and_then(|v| v.as_array_mut()) {
        Some(v) => v,
        None => return Ok(Vec::new()),
    };
    let mut sequence = 0usize;
    let mut out = Vec::new();
    for choice in choices.iter_mut() {
        let choice_obj = match choice.as_object_mut() {
            Some(v) => v,
            None => continue,
        };
        let message = match choice_obj.get_mut("message").and_then(|v| v.as_object_mut()) {
            Some(v) => v,
            None => continue,
        };
        out.extend(extract_tool_calls_from_message_mut(
            message,
            request_id,
            &mut sequence,
        )?);
    }
    Ok(out)
}

fn value_has_visible_assistant_text(value: &Value) -> bool {
    match value {
        Value::String(text) => !text.trim().is_empty(),
        Value::Array(items) => items.iter().any(value_has_visible_assistant_text),
        Value::Object(row) => {
            let entry_type = read_trimmed_string(row.get("type")).to_ascii_lowercase();
            if entry_type == "thinking" || entry_type == "reasoning" {
                return false;
            }
            value_has_visible_assistant_text(row.get("text").unwrap_or(&Value::Null))
                || value_has_visible_assistant_text(row.get("output_text").unwrap_or(&Value::Null))
                || value_has_visible_assistant_text(row.get("content").unwrap_or(&Value::Null))
        }
        _ => false,
    }
}

fn has_non_empty_tool_calls(value: Option<&Value>) -> bool {
    value
        .and_then(|v| v.as_array())
        .map(|items| items.iter().any(|item| item.is_object()))
        .unwrap_or(false)
}

fn has_output_function_calls(value: Option<&Value>) -> bool {
    let items = match value.and_then(|v| v.as_array()) {
        Some(v) if !v.is_empty() => v,
        _ => return false,
    };
    items.iter().any(|item| {
        let row = match item.as_object() {
            Some(v) => v,
            None => return false,
        };
        let item_type = read_trimmed_string(row.get("type")).to_ascii_lowercase();
        item_type == "function_call"
            || item_type == "function"
            || has_non_empty_tool_calls(row.get("tool_calls"))
    })
}

fn detect_empty_assistant_payload_contract_signal(
    payload: &Value,
) -> Option<PayloadContractSignalOutput> {
    let row = payload.as_object()?;
    if row.contains_key("__sse_responses") {
        return None;
    }

    if let Some(choices) = row.get("choices").and_then(|v| v.as_array()) {
        if let Some(first_choice) = choices.first().and_then(|v| v.as_object()) {
            let finish_reason =
                read_trimmed_string(first_choice.get("finish_reason")).to_ascii_lowercase();
            let message = first_choice.get("message").and_then(|v| v.as_object());
            let has_tool_calls =
                has_non_empty_tool_calls(message.and_then(|msg| msg.get("tool_calls")));
            let has_text = message
                .and_then(|msg| msg.get("content"))
                .map(value_has_visible_assistant_text)
                .unwrap_or(false)
                || first_choice
                    .get("content")
                    .map(value_has_visible_assistant_text)
                    .unwrap_or(false);
            // 空响应属于请求/协议形状问题，不能用 finish_reason 掩盖。
            // 只要 assistant 侧既无可见文本也无 tool_calls，就视为 payload contract 失败。
            if !has_tool_calls && !has_text {
                return Some(PayloadContractSignalOutput {
                    reason: format!(
                        "finish_reason={} but assistant text/tool_calls are empty",
                        if finish_reason.is_empty() {
                            "unknown"
                        } else {
                            finish_reason.as_str()
                        }
                    ),
                    marker: "chat_empty_assistant".to_string(),
                });
            }
        }
    }

    let status = read_trimmed_string(row.get("status")).to_ascii_lowercase();
    if status == "completed" || status == "stop" {
        let required_action = row.get("required_action").and_then(|v| v.as_object());
        let submit_tool_outputs = required_action
            .and_then(|ra| ra.get("submit_tool_outputs"))
            .and_then(|v| v.as_object());
        let has_required_action_tool_calls =
            has_non_empty_tool_calls(submit_tool_outputs.and_then(|sto| sto.get("tool_calls")));
        let has_function_calls = has_output_function_calls(row.get("output"));
        let has_text = row
            .get("output_text")
            .map(value_has_visible_assistant_text)
            .unwrap_or(false)
            || row
                .get("output")
                .map(value_has_visible_assistant_text)
                .unwrap_or(false);
        if !has_required_action_tool_calls && !has_function_calls && !has_text {
            return Some(PayloadContractSignalOutput {
                reason: format!(
                    "responses status={} but output text/tool_calls are empty",
                    status
                ),
                marker: "responses_empty_output".to_string(),
            });
        }
    }

    None
}

fn is_canonical_chat_completion_payload(payload: &Value) -> bool {
    let row = match payload.as_object() {
        Some(v) => v,
        None => return false,
    };
    let choices = match row.get("choices").and_then(|v| v.as_array()) {
        Some(v) if !v.is_empty() => v,
        _ => return false,
    };
    let first = match choices.first().and_then(|v| v.as_object()) {
        Some(v) => v,
        None => return false,
    };
    first.get("message").and_then(|v| v.as_object()).is_some()
}

fn build_review_operations(_metadata: &Value) -> Value {
    Value::Array(Vec::new())
}

fn build_continue_execution_operations(should_inject: bool) -> Value {
    let _ = should_inject;
    // continue_execution remains a server-side compatibility handler for historical/upstream tool calls,
    // but it must no longer be injected into the model-visible request tool surface.
    Value::Array(Vec::new())
}

fn is_stop_message_state_active(raw: &Value) -> bool {
    let record = match raw.as_object() {
        Some(v) => v,
        None => return false,
    };
    let text = record
        .get("stopMessageText")
        .and_then(|v| v.as_str())
        .map(|v| v.trim().to_string())
        .unwrap_or_default();
    let max_repeats = record
        .get("stopMessageMaxRepeats")
        .and_then(|v| v.as_f64())
        .and_then(|v| {
            if v.is_finite() {
                Some(v.floor() as i64)
            } else {
                None
            }
        })
        .map(|v| if v < 1 { 1 } else { v })
        .unwrap_or(0);
    let stage_mode = record
        .get("stopMessageStageMode")
        .and_then(|v| v.as_str())
        .map(|v| v.trim().to_ascii_lowercase())
        .unwrap_or_default();
    if stage_mode == "off" {
        return false;
    }
    max_repeats > 0 && (!text.is_empty() || stage_mode == "on")
}

fn resolve_has_active_stop_message_for_continue_execution(
    runtime_state: &Value,
    persisted_state: &Value,
) -> bool {
    is_stop_message_state_active(runtime_state) || is_stop_message_state_active(persisted_state)
}

fn resolve_stop_message_session_scope(metadata: &Value) -> Option<String> {
    let row = metadata.as_object()?;
    if let Some(tmux_session_id) = row.get("clientTmuxSessionId").and_then(|v| v.as_str()) {
        if !tmux_session_id.is_empty() {
            return Some(format!("tmux:{tmux_session_id}"));
        }
    }
    if let Some(tmux_session_id) = row.get("client_tmux_session_id").and_then(|v| v.as_str()) {
        if !tmux_session_id.is_empty() {
            return Some(format!("tmux:{tmux_session_id}"));
        }
    }
    if let Some(tmux_session_id) = row.get("tmuxSessionId").and_then(|v| v.as_str()) {
        if !tmux_session_id.is_empty() {
            return Some(format!("tmux:{tmux_session_id}"));
        }
    }
    if let Some(tmux_session_id) = row.get("tmux_session_id").and_then(|v| v.as_str()) {
        if !tmux_session_id.is_empty() {
            return Some(format!("tmux:{tmux_session_id}"));
        }
    }
    if let Some(session_id) = row.get("sessionId").and_then(|v| v.as_str()) {
        if !session_id.is_empty() {
            return Some(format!("session:{session_id}"));
        }
    }
    if let Some(conversation_id) = row.get("conversationId").and_then(|v| v.as_str()) {
        if !conversation_id.is_empty() {
            return Some(format!("conversation:{conversation_id}"));
        }
    }
    None
}

fn resolve_servertool_sticky_key(metadata: &Value) -> String {
    if let Some(scope) = resolve_stop_message_scope(metadata) {
        return scope;
    }
    let generic = resolve_sticky_key(metadata);
    if let Some(session_scope) = resolve_session_scope(metadata) {
        let request_id = metadata
            .get("requestId")
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|v| !v.is_empty());
        if request_id.is_some() && generic == request_id.unwrap() {
            return session_scope;
        }
    }
    generic
}

fn read_runtime_metadata_bool(runtime_metadata: &Value, key: &str) -> bool {
    runtime_metadata
        .as_object()
        .and_then(|obj| obj.get(key))
        .and_then(|v| v.as_bool())
        .unwrap_or(false)
}

fn read_runtime_metadata_object<'a>(
    runtime_metadata: &'a Value,
    key: &str,
) -> Option<&'a Map<String, Value>> {
    runtime_metadata
        .as_object()
        .and_then(|obj| obj.get(key))
        .and_then(|v| v.as_object())
}

fn read_web_search_semantics(request: &Value) -> (bool, bool) {
    let hint = request
        .as_object()
        .and_then(|obj| obj.get("semantics"))
        .and_then(|semantics| semantics.as_object())
        .and_then(|semantics| semantics.get("providerExtras"))
        .and_then(|extras| extras.as_object())
        .and_then(|extras| extras.get("webSearch"));

    match hint {
        Some(Value::Bool(enabled)) => {
            if *enabled {
                (true, false)
            } else {
                (false, true)
            }
        }
        Some(Value::Object(row)) => {
            let force = row.get("force").and_then(|v| v.as_bool()).unwrap_or(false);
            let disable = row
                .get("disable")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            (force, disable)
        }
        _ => (false, false),
    }
}

fn is_servertool_web_search_engine(engine: &Map<String, Value>) -> bool {
    resolve_web_search_execution_mode(engine) == WebSearchExecutionMode::Servertool
}

fn is_direct_route_web_search_engine(engine: &Map<String, Value>) -> bool {
    resolve_web_search_execution_mode(engine) == WebSearchExecutionMode::DirectRoute
}

fn should_bypass_servertool_web_search(
    intent_has: bool,
    intent_google_preferred: bool,
    semantics_force: bool,
    engines: &[(i64, Map<String, Value>)],
    runnable_engine_indexes: &[i64],
    direct_route_engine_indexes: &[i64],
) -> bool {
    if !intent_has || intent_google_preferred {
        return false;
    }
    if semantics_force {
        return false;
    }

    let first_direct_index = match direct_route_engine_indexes.first() {
        Some(v) => *v,
        None => return false,
    };
    let direct_engine = match engines
        .iter()
        .find(|(origin_index, _)| *origin_index == first_direct_index)
    {
        Some((_, v)) => v,
        None => return false,
    };
    let is_default = direct_engine
        .get("default")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    if is_default {
        return true;
    }

    let selected_position = match runnable_engine_indexes
        .iter()
        .position(|idx| *idx == first_direct_index)
    {
        Some(v) => v,
        None => return false,
    };
    selected_position == 0
}

fn resolve_chat_web_search_plan(
    request: &Value,
    runtime_metadata: &Value,
) -> ChatWebSearchPlanOutput {
    if read_runtime_metadata_bool(runtime_metadata, "serverToolFollowup") {
        return ChatWebSearchPlanOutput {
            should_inject: false,
            selected_engine_indexes: Vec::new(),
        };
    }

    let raw_web_search = match read_runtime_metadata_object(runtime_metadata, "webSearch") {
        Some(v) => v,
        None => {
            return ChatWebSearchPlanOutput {
                should_inject: false,
                selected_engine_indexes: Vec::new(),
            }
        }
    };
    let engines = match raw_web_search.get("engines").and_then(|v| v.as_array()) {
        Some(v) if !v.is_empty() => v,
        _ => {
            return ChatWebSearchPlanOutput {
                should_inject: false,
                selected_engine_indexes: Vec::new(),
            }
        }
    };

    let (semantics_force, semantics_disable) = read_web_search_semantics(request);
    if semantics_disable {
        return ChatWebSearchPlanOutput {
            should_inject: false,
            selected_engine_indexes: Vec::new(),
        };
    }

    let inject_policy = if semantics_force {
        "always".to_string()
    } else {
        let candidate = raw_web_search
            .get("injectPolicy")
            .and_then(|v| v.as_str())
            .map(|v| v.trim().to_ascii_lowercase())
            .unwrap_or_else(|| "selective".to_string());
        if candidate == "always" || candidate == "selective" {
            candidate
        } else {
            "selective".to_string()
        }
    };

    let messages = request
        .as_object()
        .and_then(|obj| obj.get("messages"))
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let intent = analyze_chat_web_search_intent(messages);
    if inject_policy == "selective" && !intent.has_intent {
        return ChatWebSearchPlanOutput {
            should_inject: false,
            selected_engine_indexes: Vec::new(),
        };
    }

    let mut indexed_engines: Vec<(i64, Map<String, Value>)> = Vec::new();
    for (idx, entry) in engines.iter().enumerate() {
        let row = match entry.as_object() {
            Some(v) => v.clone(),
            None => continue,
        };
        indexed_engines.push((idx as i64, row));
    }

    let runnable_engine_indexes: Vec<i64> = indexed_engines
        .iter()
        .filter_map(|(origin_index, engine)| {
            let id = read_trimmed_string(engine.get("id"));
            if id.is_empty() {
                return None;
            }
            let server_tools_disabled = engine
                .get("serverToolsDisabled")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            if server_tools_disabled {
                return None;
            }
            Some(*origin_index)
        })
        .collect();

    let direct_route_engine_indexes: Vec<i64> = runnable_engine_indexes
        .iter()
        .filter_map(|idx| {
            let (_, engine) = indexed_engines
                .iter()
                .find(|(origin_index, _)| *origin_index == *idx)?;
            if is_direct_route_web_search_engine(engine) {
                return Some(*idx);
            }
            None
        })
        .collect();

    let mut selected_engine_indexes: Vec<i64> = runnable_engine_indexes
        .iter()
        .filter_map(|idx| {
            let (_, engine) = indexed_engines
                .iter()
                .find(|(origin_index, _)| *origin_index == *idx)?;
            if is_servertool_web_search_engine(engine) {
                return Some(*idx);
            }
            None
        })
        .collect();

    if intent.google_preferred {
        let preferred: Vec<i64> = selected_engine_indexes
            .iter()
            .filter_map(|idx| {
                if *idx < 0 {
                    return None;
                }
                let (_, engine) = indexed_engines
                    .iter()
                    .find(|(origin_index, _)| *origin_index == *idx)?;
                let id = read_trimmed_string(engine.get("id")).to_ascii_lowercase();
                let provider_key =
                    read_trimmed_string(engine.get("providerKey")).to_ascii_lowercase();
                if id.contains("google")
                {
                    return Some(*idx);
                }
                None
            })
            .collect();
        if !preferred.is_empty() {
            selected_engine_indexes = preferred;
        }
    }

    if should_bypass_servertool_web_search(
        intent.has_intent,
        intent.google_preferred,
        semantics_force,
        indexed_engines.as_slice(),
        runnable_engine_indexes.as_slice(),
        direct_route_engine_indexes.as_slice(),
    ) {
        return ChatWebSearchPlanOutput {
            should_inject: false,
            selected_engine_indexes: Vec::new(),
        };
    }

    if selected_engine_indexes.is_empty() {
        return ChatWebSearchPlanOutput {
            should_inject: false,
            selected_engine_indexes: Vec::new(),
        };
    }

    ChatWebSearchPlanOutput {
        should_inject: true,
        selected_engine_indexes,
    }
}

fn read_clock_enabled(raw_clock: Option<&Value>) -> bool {
    match raw_clock {
        None => false,
        Some(Value::Object(row)) => {
            let enabled = row.get("enabled");
            if enabled == Some(&Value::Bool(true)) {
                return true;
            }
            if let Some(text) = enabled.and_then(|v| v.as_str()) {
                return text.trim().eq_ignore_ascii_case("true");
            }
            if let Some(number) = enabled.and_then(|v| v.as_i64()) {
                return number == 1;
            }
            false
        }
        _ => false,
    }
}

fn resolve_chat_clock_plan(runtime_metadata: &Value) -> ChatClockPlanOutput {
    let server_tool_followup = read_runtime_metadata_bool(runtime_metadata, "serverToolFollowup");
    let clock_followup_inject_tool =
        read_runtime_metadata_bool(runtime_metadata, "clockFollowupInjectTool");
    if server_tool_followup && !clock_followup_inject_tool {
        return ChatClockPlanOutput {
            should_inject: false,
        };
    }

    let should_inject = read_clock_enabled(
        runtime_metadata
            .as_object()
            .and_then(|obj| obj.get("clock")),
    );
    ChatClockPlanOutput { should_inject }
}

fn resolve_continue_execution_plan(
    runtime_metadata: &Value,
    has_active_stop_message: bool,
) -> ChatContinueExecutionPlanOutput {
    if read_runtime_metadata_bool(runtime_metadata, "serverToolFollowup") || has_active_stop_message
    {
        return ChatContinueExecutionPlanOutput {
            should_inject: false,
        };
    }
    ChatContinueExecutionPlanOutput {
        should_inject: true,
    }
}

#[napi]
pub fn plan_chat_web_search_operations_json(
    request_json: String,
    runtime_metadata_json: String,
) -> NapiResult<String> {
    let request: Value =
        serde_json::from_str(&request_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let runtime_metadata: Value = serde_json::from_str(&runtime_metadata_json)
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let output = resolve_chat_web_search_plan(&request, &runtime_metadata);
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi]
pub fn plan_chat_clock_operations_json(runtime_metadata_json: String) -> NapiResult<String> {
    let runtime_metadata: Value = serde_json::from_str(&runtime_metadata_json)
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let output = resolve_chat_clock_plan(&runtime_metadata);
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi]
pub fn plan_continue_execution_operations_json(
    runtime_metadata_json: String,
    has_active_stop_message: bool,
) -> NapiResult<String> {
    let runtime_metadata: Value = serde_json::from_str(&runtime_metadata_json)
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let output = resolve_continue_execution_plan(&runtime_metadata, has_active_stop_message);
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi]
pub fn plan_chat_servertool_orchestration_bundle_json(
    request_json: String,
    runtime_metadata_json: String,
    has_active_stop_message: bool,
) -> NapiResult<String> {
    let request: Value =
        serde_json::from_str(&request_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let runtime_metadata: Value = serde_json::from_str(&runtime_metadata_json)
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;

    let output = ChatServerToolBundlePlanOutput {
        web_search: resolve_chat_web_search_plan(&request, &runtime_metadata),
        clock: resolve_chat_clock_plan(&runtime_metadata),
        continue_execution: resolve_continue_execution_plan(
            &runtime_metadata,
            has_active_stop_message,
        ),
    };

    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi]
pub fn detect_empty_assistant_payload_contract_signal_json(
    payload_json: String,
) -> NapiResult<String> {
    let payload: Value =
        serde_json::from_str(&payload_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let output = detect_empty_assistant_payload_contract_signal(&payload);
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi]
pub fn detect_provider_response_shape_json(payload_json: String) -> NapiResult<String> {
    let payload: Value =
        serde_json::from_str(&payload_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let output = detect_provider_response_shape(&payload);
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi]
pub fn is_canonical_chat_completion_payload_json(payload_json: String) -> NapiResult<String> {
    let payload: Value =
        serde_json::from_str(&payload_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let output = is_canonical_chat_completion_payload(&payload);
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi]
pub fn build_review_operations_json(metadata_json: String) -> NapiResult<String> {
    let metadata: Value = serde_json::from_str(&metadata_json)
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let output = build_review_operations(&metadata);
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi]
pub fn build_continue_execution_operations_json(should_inject: bool) -> NapiResult<String> {
    let output = build_continue_execution_operations(should_inject);
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi]
pub fn is_stop_message_state_active_json(raw_json: String) -> NapiResult<String> {
    let raw: Value =
        serde_json::from_str(&raw_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let output = is_stop_message_state_active(&raw);
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi]
pub fn resolve_has_active_stop_message_for_continue_execution_json(
    runtime_state_json: String,
    persisted_state_json: String,
) -> NapiResult<String> {
    let runtime_state: Value = serde_json::from_str(&runtime_state_json)
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let persisted_state: Value = serde_json::from_str(&persisted_state_json)
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let output =
        resolve_has_active_stop_message_for_continue_execution(&runtime_state, &persisted_state);
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi]
pub fn resolve_stop_message_session_scope_json(metadata_json: String) -> NapiResult<String> {
    let metadata: Value = serde_json::from_str(&metadata_json)
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let output = resolve_stop_message_session_scope(&metadata);
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi]
pub fn resolve_servertool_sticky_key_json(metadata_json: String) -> NapiResult<String> {
    let metadata: Value = serde_json::from_str(&metadata_json)
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let output = resolve_servertool_sticky_key(&metadata);
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi]
pub fn run_servertool_response_stage_json(
    payload_json: String,
    request_id: String,
) -> NapiResult<String> {
    let mut payload: Value =
        serde_json::from_str(&payload_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let tool_calls = extract_tool_calls_from_chat_payload_mut(&mut payload, request_id.as_str())
        .map_err(napi::Error::from_reason)?;
    let output = ServertoolResponseStageOutput {
        provider_response_shape: detect_provider_response_shape(&payload).to_string(),
        is_canonical_chat_completion_payload: is_canonical_chat_completion_payload(&payload),
        payload_contract_signal: detect_empty_assistant_payload_contract_signal(&payload),
        normalized_payload: payload,
        tool_calls,
    };
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi]
pub fn plan_servertool_tool_call_dispatch_json(input_json: String) -> NapiResult<String> {
    let input: ServertoolDispatchPlannerInput = serde_json::from_str(&input_json)
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let include = normalize_filter_token_set(input.include_tool_call_handler_names.as_ref());
    let exclude = normalize_filter_token_set(input.exclude_tool_call_handler_names.as_ref());
    let mut registered = input
        .registered_tool_call_handlers
        .into_iter()
        .filter_map(|entry| {
            let name = normalize_servertool_call_name(entry.name.as_str());
            if name.is_empty() {
                return None;
            }
            let trigger = entry.trigger.trim().to_lowercase();
            if trigger != "tool_call" {
                return None;
            }
            Some((name, entry))
        })
        .collect::<std::collections::HashMap<_, _>>();

    let mut executable_tool_calls = Vec::new();
    let mut skipped_tool_calls = Vec::new();

    for tool_call in input.tool_calls {
        let normalized_name = normalize_servertool_call_name(tool_call.name.as_str());
        if input.disable_tool_call_handlers {
            skipped_tool_calls.push(ServertoolDispatchSkippedOutput {
                id: tool_call.id,
                name: normalized_name,
                reason: "tool_call_handlers_disabled".to_string(),
            });
            continue;
        }
        if !is_name_included(normalized_name.as_str(), include.as_ref(), exclude.as_ref()) {
            skipped_tool_calls.push(ServertoolDispatchSkippedOutput {
                id: tool_call.id,
                name: normalized_name,
                reason: "filtered_out".to_string(),
            });
            continue;
        }
        let Some(registered_entry) = registered.get(normalized_name.as_str()) else {
            skipped_tool_calls.push(ServertoolDispatchSkippedOutput {
                id: tool_call.id,
                name: normalized_name,
                reason: "no_registered_tool_call_handler".to_string(),
            });
            continue;
        };
        executable_tool_calls.push(ServertoolDispatchCandidateOutput {
            id: tool_call.id,
            name: normalized_name,
            arguments: tool_call.arguments,
            execution_mode: registered_entry.execution_mode.trim().to_string(),
            strip_after_execute: registered_entry.strip_after_execute,
        });
    }

    let output = ServertoolDispatchPlanOutput {
        executable_tool_calls,
        skipped_tool_calls,
    };
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi]
pub fn plan_servertool_outcome_json(input_json: String) -> NapiResult<String> {
    let input: ServertoolOutcomePlannerInput = serde_json::from_str(&input_json)
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let configured_pending_injection_message_kinds =
        normalize_nonempty_string_vec(input.pending_injection_message_kinds.as_ref());
    let configured_followup_injection_ops =
        normalize_nonempty_string_vec(input.followup_injection_ops.as_ref());
    let executed_ids: Vec<String> = input
        .executed_tool_calls
        .iter()
        .map(|entry| entry.id.trim().to_string())
        .filter(|entry| !entry.is_empty())
        .collect();
    if executed_ids.is_empty() {
        let output = ServertoolOutcomePlanOutput {
            outcome_mode: "none".to_string(),
            remaining_tool_call_ids: Vec::new(),
            pending_session_id: None,
            alias_session_ids: Vec::new(),
            pending_injection_message_kinds: Vec::new(),
            pending_injection_messages_resolved: Vec::new(),
            flow_id: None,
            use_last_execution_followup: false,
            use_generic_followup: false,
            followup_strategy: "none".to_string(),
            requires_pending_injection: false,
            primary_execution_mode: None,
            followup_injection_ops: Vec::new(),
            followup_injection_ops_resolved: Vec::new(),
        };
        return serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()));
    }

    let remaining_tool_call_ids: Vec<String> = input
        .tool_calls
        .iter()
        .filter_map(|entry| {
            let id = entry.id.trim();
            if id.is_empty() || executed_ids.iter().any(|executed| executed == id) {
                None
            } else {
                Some(id.to_string())
            }
        })
        .collect();

    if !remaining_tool_call_ids.is_empty() {
        let primary_execution_mode = if input.executed_tool_calls.len() == 1 {
            input.executed_tool_calls.first().and_then(|entry| {
                let mode = entry.execution_mode.trim();
                if mode.is_empty() {
                    None
                } else {
                    Some(mode.to_string())
                }
            })
        } else {
            None
        };
        let session_id = input.session_id.map(|value| value.trim().to_string()).filter(|value| !value.is_empty());
        let conversation_id = input
            .conversation_id
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty());
        let pending_session_id = session_id.clone().or_else(|| conversation_id.clone());
        let alias_session_ids = match (&session_id, &conversation_id) {
            (Some(session), Some(conversation)) if session != conversation => vec![conversation.clone()],
            _ => Vec::new(),
        };
        let pending_injection_message_kinds =
            if configured_pending_injection_message_kinds.is_empty() {
                vec![
                    "assistant_tool_calls".to_string(),
                    "tool_outputs".to_string(),
                ]
            } else {
                configured_pending_injection_message_kinds
            };
        let pending_injection_messages_resolved = build_pending_injection_messages_resolved(
            pending_injection_message_kinds.as_slice(),
            input.executed_tool_calls.as_slice(),
            input.tool_outputs.as_deref().unwrap_or(&[]),
        )
        .map_err(napi::Error::from_reason)?;
        let output = ServertoolOutcomePlanOutput {
            outcome_mode: "mixed_client_tools".to_string(),
            remaining_tool_call_ids,
            pending_session_id,
            alias_session_ids,
            pending_injection_message_kinds,
            pending_injection_messages_resolved,
            flow_id: Some("servertool_mixed".to_string()),
            use_last_execution_followup: false,
            use_generic_followup: false,
            followup_strategy: "pending_injection".to_string(),
            requires_pending_injection: true,
            primary_execution_mode,
            followup_injection_ops: Vec::new(),
            followup_injection_ops_resolved: Vec::new(),
        };
        return serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()));
    }

    let flow_id = if input.executed_tool_calls.len() == 1 {
        input
            .last_execution_flow_id
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
            .or_else(|| {
                input
                    .executed_flow_ids
                    .iter()
                    .find(|value| !value.trim().is_empty())
                    .map(|value| value.trim().to_string())
            })
            .or_else(|| {
                input
                    .executed_tool_calls
                    .first()
                    .map(|entry| normalize_servertool_call_name(entry.name.as_str()))
            })
    } else {
        Some("servertool_multi".to_string())
    };
    let use_last_execution_followup = input.executed_tool_calls.len() == 1 && input.has_last_execution_followup;
    let primary_execution_mode = if input.executed_tool_calls.len() == 1 {
        input.executed_tool_calls.first().and_then(|entry| {
            let mode = entry.execution_mode.trim();
            if mode.is_empty() {
                None
            } else {
                Some(mode.to_string())
            }
        })
    } else {
        None
    };
    let followup_injection_ops = if use_last_execution_followup {
        Vec::new()
    } else if configured_followup_injection_ops.is_empty() {
        vec![
            "append_assistant_message".to_string(),
            "append_tool_messages_from_tool_outputs".to_string(),
        ]
    } else {
        configured_followup_injection_ops
    };
    let followup_injection_ops_resolved =
        build_required_followup_injection_ops(followup_injection_ops.as_slice())
            .map_err(napi::Error::from_reason)?;
    let output = ServertoolOutcomePlanOutput {
        outcome_mode: "servertool_only".to_string(),
        remaining_tool_call_ids,
        pending_session_id: None,
        alias_session_ids: Vec::new(),
        pending_injection_message_kinds: Vec::new(),
        pending_injection_messages_resolved: Vec::new(),
        flow_id,
        use_last_execution_followup,
        use_generic_followup: !use_last_execution_followup,
        followup_strategy: if use_last_execution_followup {
            "reuse_last_execution".to_string()
        } else {
            "generic_tool_outputs".to_string()
        },
        requires_pending_injection: false,
        primary_execution_mode,
        followup_injection_ops,
        followup_injection_ops_resolved,
    };
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi]
pub fn build_servertool_generic_followup_payload_json(input_json: String) -> NapiResult<String> {
    let input: ServertoolGenericFollowupPayloadInput = serde_json::from_str(&input_json)
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let output = build_servertool_generic_followup_payload(input).map_err(napi::Error::from_reason)?;
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi]
pub fn plan_servertool_auto_hook_queues_json(input_json: String) -> NapiResult<String> {
    let input: ServertoolAutoHookPlannerInput = serde_json::from_str(&input_json)
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let include = normalize_filter_token_set(input.include_auto_hook_ids.as_ref());
    let exclude = normalize_filter_token_set(input.exclude_auto_hook_ids.as_ref());

    let mut hooks: Vec<ServertoolAutoHookSpecInput> = input
        .hooks
        .into_iter()
        .filter_map(|hook| {
            let id = normalize_servertool_call_name(hook.id.as_str());
            if id.is_empty() || !is_name_included(id.as_str(), include.as_ref(), exclude.as_ref()) {
                return None;
            }
            Some(ServertoolAutoHookSpecInput {
                id,
                phase: normalize_auto_hook_phase(hook.phase.as_str()),
                priority: hook.priority,
                order: hook.order,
            })
        })
        .collect();

    hooks.sort_by(|left, right| {
        resolve_auto_hook_phase_rank(left.phase.as_str())
            .cmp(&resolve_auto_hook_phase_rank(right.phase.as_str()))
            .then(left.priority.cmp(&right.priority))
            .then(left.order.cmp(&right.order))
            .then(left.id.cmp(&right.id))
    });

    let hook_by_id: std::collections::HashMap<String, ServertoolAutoHookSpecInput> = hooks
        .iter()
        .cloned()
        .map(|hook| (hook.id.clone(), hook))
        .collect();

    let mut consumed = std::collections::HashSet::new();
    let mut optional_specs: Vec<ServertoolAutoHookSpecInput> = Vec::new();
    for hook in hooks.iter() {
        if hook.phase != "pre" || consumed.contains(hook.id.as_str()) {
            continue;
        }
        optional_specs.push(hook.clone());
        consumed.insert(hook.id.clone());
    }
    for raw_id in input.optional_primary_hook_order.iter() {
        let id = normalize_servertool_call_name(raw_id.as_str());
        if id.is_empty() || consumed.contains(id.as_str()) {
            continue;
        }
        if let Some(hook) = hook_by_id.get(id.as_str()) {
            optional_specs.push(hook.clone());
            consumed.insert(id);
        }
    }
    for hook in hooks.iter() {
        if consumed.contains(hook.id.as_str()) {
            continue;
        }
        optional_specs.push(hook.clone());
        consumed.insert(hook.id.clone());
    }

    let mut mandatory_seen = std::collections::HashSet::new();
    let mut mandatory_specs: Vec<ServertoolAutoHookSpecInput> = Vec::new();
    for raw_id in input.mandatory_hook_order.iter() {
        let id = normalize_servertool_call_name(raw_id.as_str());
        if id.is_empty() || mandatory_seen.contains(id.as_str()) {
            continue;
        }
        if let Some(hook) = hook_by_id.get(id.as_str()) {
            mandatory_specs.push(hook.clone());
            mandatory_seen.insert(id);
        }
    }

    let optional_total = optional_specs.len() as i64;
    let mandatory_total = mandatory_specs.len() as i64;
    let optional_queue = optional_specs
        .into_iter()
        .enumerate()
        .map(|(index, hook)| ServertoolAutoHookPlanEntry {
            id: hook.id,
            phase: hook.phase,
            priority: hook.priority,
            order: hook.order,
            queue: "A_optional".to_string(),
            queue_index: index as i64 + 1,
            queue_total: optional_total,
        })
        .collect();
    let mandatory_queue = mandatory_specs
        .into_iter()
        .enumerate()
        .map(|(index, hook)| ServertoolAutoHookPlanEntry {
            id: hook.id,
            phase: hook.phase,
            priority: hook.priority,
            order: hook.order,
            queue: "B_mandatory".to_string(),
            queue_index: index as i64 + 1,
            queue_total: mandatory_total,
        })
        .collect();

    let output = ServertoolAutoHookPlannerOutput {
        optional_queue,
        mandatory_queue,
    };
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn test_is_canonical_chat_completion_payload_true_when_first_choice_has_message_object() {
        let payload = json!({
            "id": "chatcmpl-1",
            "choices": [
                {
                    "index": 0,
                    "message": {
                        "role": "assistant",
                        "content": "hello"
                    }
                }
            ]
        });
        assert!(is_canonical_chat_completion_payload(&payload));
    }

    #[test]
    fn test_is_canonical_chat_completion_payload_false_for_non_canonical_shapes() {
        let no_choices = json!({ "output": [] });
        let empty_choices = json!({ "choices": [] });
        let no_message = json!({
            "choices": [
                {
                    "index": 0
                }
            ]
        });
        assert!(!is_canonical_chat_completion_payload(&no_choices));
        assert!(!is_canonical_chat_completion_payload(&empty_choices));
        assert!(!is_canonical_chat_completion_payload(&no_message));
    }

    #[test]
    fn test_run_servertool_response_stage_extracts_internal_tool_and_assigns_id() {
        let mut payload = json!({
            "choices": [
                {
                    "message": {
                        "role": "assistant",
                        "tool_calls": [
                            {
                                "type": "function",
                                "function": {
                                    "name": "clock",
                                    "arguments": "{\"action\":\"list\"}"
                                }
                            }
                        ]
                    }
                }
            ]
        });
        let tool_calls =
            extract_tool_calls_from_chat_payload_mut(&mut payload, "req_clock_source_id").unwrap();
        assert_eq!(tool_calls.len(), 1);
        assert_eq!(tool_calls[0].name, "clock");
        assert!(tool_calls[0].id.starts_with("call_"));
        assert_eq!(tool_calls[0].id.len(), 29);
    }

    #[test]
    fn test_run_servertool_response_stage_skips_transcript_like_exec_command() {
        let mut payload = json!({
            "choices": [
                {
                    "message": {
                        "role": "assistant",
                        "tool_calls": [
                            {
                                "id": "bad_exec_call",
                                "type": "function",
                                "function": {
                                    "name": "exec_command",
                                    "arguments": "Chunk ID: f9ed9c\nWall time: 0.0000 seconds\nProcess exited with code 0\nOriginal token count: 1080"
                                }
                            },
                            {
                                "id": "good_exec_call",
                                "type": "function",
                                "function": {
                                    "name": "exec_command",
                                    "arguments": "{\"cmd\":\"echo ok\"}"
                                }
                            }
                        ]
                    }
                }
            ]
        });
        let tool_calls = extract_tool_calls_from_chat_payload_mut(&mut payload, "req_exec").unwrap();
        assert_eq!(tool_calls.len(), 1);
        assert_eq!(tool_calls[0].id, "good_exec_call");
    }

    #[test]
    fn test_plan_servertool_tool_call_dispatch_filters_and_selects_registered_handlers() {
        let raw = serde_json::json!({
            "toolCalls": [
                { "id": "call_1", "name": "clock", "arguments": "{}" },
                { "id": "call_2", "name": "exec_command", "arguments": "{\"cmd\":\"pwd\"}" },
                { "id": "call_3", "name": "unknown_tool", "arguments": "{}" }
            ],
            "disableToolCallHandlers": false,
            "includeToolCallHandlerNames": ["clock", "exec_command", "unknown_tool"],
            "excludeToolCallHandlerNames": ["exec_command"],
            "registeredToolCallHandlers": [
                {
                    "name": "clock",
                    "trigger": "tool_call",
                    "executionMode": "client_inject_only",
                    "stripAfterExecute": true
                },
                {
                    "name": "reasoning.stop",
                    "trigger": "tool_call",
                    "executionMode": "guarded",
                    "stripAfterExecute": true
                }
            ]
        });
        let output = plan_servertool_tool_call_dispatch_json(raw.to_string()).unwrap();
        let parsed: serde_json::Value = serde_json::from_str(output.as_str()).unwrap();
        let executable = parsed
            .get("executableToolCalls")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();
        let skipped = parsed
            .get("skippedToolCalls")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();
        assert_eq!(executable.len(), 1);
        assert_eq!(executable[0].get("name").and_then(|v| v.as_str()), Some("clock"));
        assert_eq!(
            executable[0].get("executionMode").and_then(|v| v.as_str()),
            Some("client_inject_only")
        );
        assert_eq!(
            executable[0].get("stripAfterExecute").and_then(|v| v.as_bool()),
            Some(true)
        );
        assert_eq!(skipped.len(), 2);
        assert_eq!(
            skipped[0].get("reason").and_then(|v| v.as_str()),
            Some("filtered_out")
        );
        assert_eq!(
            skipped[1].get("reason").and_then(|v| v.as_str()),
            Some("no_registered_tool_call_handler")
        );
    }

    #[test]
    fn test_plan_servertool_outcome_prefers_mixed_branch_with_pending_session_target() {
        let raw = serde_json::json!({
            "toolCalls": [
                { "id": "call_1", "name": "clock", "arguments": "{}" },
                { "id": "call_2", "name": "exec_command", "arguments": "{\"cmd\":\"pwd\"}" }
            ],
            "executedToolCalls": [
                {
                    "id": "call_1",
                    "name": "clock",
                    "arguments": "{}",
                    "executionMode": "client_inject_only",
                    "stripAfterExecute": true
                }
            ],
            "executedFlowIds": ["clock_done"],
            "lastExecutionFlowId": "clock_done",
            "hasLastExecutionFollowup": true,
            "sessionId": "sess_1",
            "conversationId": "conv_1"
        });
        let output = plan_servertool_outcome_json(raw.to_string()).unwrap();
        let parsed: serde_json::Value = serde_json::from_str(output.as_str()).unwrap();
        assert_eq!(
            parsed.get("outcomeMode").and_then(|v| v.as_str()),
            Some("mixed_client_tools")
        );
        assert_eq!(
            parsed.get("pendingSessionId").and_then(|v| v.as_str()),
            Some("sess_1")
        );
        assert_eq!(
            parsed.get("followupStrategy").and_then(|v| v.as_str()),
            Some("pending_injection")
        );
        assert_eq!(
            parsed.get("requiresPendingInjection").and_then(|v| v.as_bool()),
            Some(true)
        );
        assert_eq!(
            parsed.get("primaryExecutionMode").and_then(|v| v.as_str()),
            Some("client_inject_only")
        );
        assert_eq!(
            parsed
                .get("pendingInjectionMessageKinds")
                .and_then(|v| v.as_array())
                .map(|entries| entries.iter().filter_map(|entry| entry.as_str()).collect::<Vec<_>>()),
            Some(vec!["assistant_tool_calls", "tool_outputs"])
        );
        assert_eq!(
            parsed
                .get("followupInjectionOps")
                .and_then(|v| v.as_array())
                .map(|entries| entries.len()),
            Some(0)
        );
        assert_eq!(
            parsed
                .get("remainingToolCallIds")
                .and_then(|v| v.as_array())
                .map(|entries| entries.len()),
            Some(1)
        );
    }

    #[test]
    fn test_plan_servertool_outcome_resolves_single_followup_path() {
        let raw = serde_json::json!({
            "toolCalls": [
                { "id": "call_1", "name": "clock", "arguments": "{}" }
            ],
            "executedToolCalls": [
                {
                    "id": "call_1",
                    "name": "clock",
                    "arguments": "{}",
                    "executionMode": "client_inject_only",
                    "stripAfterExecute": true
                }
            ],
            "executedFlowIds": ["clock_done"],
            "lastExecutionFlowId": "clock_done",
            "hasLastExecutionFollowup": true
        });
        let output = plan_servertool_outcome_json(raw.to_string()).unwrap();
        let parsed: serde_json::Value = serde_json::from_str(output.as_str()).unwrap();
        assert_eq!(
            parsed.get("outcomeMode").and_then(|v| v.as_str()),
            Some("servertool_only")
        );
        assert_eq!(parsed.get("flowId").and_then(|v| v.as_str()), Some("clock_done"));
        assert_eq!(
            parsed.get("useLastExecutionFollowup").and_then(|v| v.as_bool()),
            Some(true)
        );
        assert_eq!(
            parsed.get("useGenericFollowup").and_then(|v| v.as_bool()),
            Some(false)
        );
        assert_eq!(
            parsed.get("followupStrategy").and_then(|v| v.as_str()),
            Some("reuse_last_execution")
        );
        assert_eq!(
            parsed.get("requiresPendingInjection").and_then(|v| v.as_bool()),
            Some(false)
        );
        assert_eq!(
            parsed.get("primaryExecutionMode").and_then(|v| v.as_str()),
            Some("client_inject_only")
        );
        assert_eq!(
            parsed
                .get("pendingInjectionMessageKinds")
                .and_then(|v| v.as_array())
                .map(|entries| entries.len()),
            Some(0)
        );
        assert_eq!(
            parsed
                .get("followupInjectionOps")
                .and_then(|v| v.as_array())
                .map(|entries| entries.len()),
            Some(0)
        );
    }

    #[test]
    fn test_plan_servertool_outcome_resolves_generic_followup_ops_when_last_followup_missing() {
        let raw = serde_json::json!({
            "toolCalls": [
                { "id": "call_1", "name": "clock", "arguments": "{}" }
            ],
            "executedToolCalls": [
                {
                    "id": "call_1",
                    "name": "clock",
                    "arguments": "{}",
                    "executionMode": "client_inject_only",
                    "stripAfterExecute": true
                }
            ],
            "executedFlowIds": ["clock_done"],
            "lastExecutionFlowId": "clock_done",
            "hasLastExecutionFollowup": false
        });
        let output = plan_servertool_outcome_json(raw.to_string()).unwrap();
        let parsed: serde_json::Value = serde_json::from_str(output.as_str()).unwrap();
        assert_eq!(
            parsed.get("outcomeMode").and_then(|v| v.as_str()),
            Some("servertool_only")
        );
        assert_eq!(
            parsed.get("followupStrategy").and_then(|v| v.as_str()),
            Some("generic_tool_outputs")
        );
        assert_eq!(
            parsed
                .get("followupInjectionOps")
                .and_then(|v| v.as_array())
                .map(|entries| entries.iter().filter_map(|entry| entry.as_str()).collect::<Vec<_>>()),
            Some(vec![
                "append_assistant_message",
                "append_tool_messages_from_tool_outputs"
            ])
        );
    }

    #[test]
    fn test_build_servertool_generic_followup_payload_appends_assistant_and_tool_outputs() {
        let raw = serde_json::json!({
            "model": "gpt-test",
            "messages": [
                { "role": "user", "content": "hi" }
            ],
            "tools": [
                {
                    "type": "function",
                    "function": { "name": "exec_command", "parameters": { "type": "object" } }
                }
            ],
            "parameters": {
                "temperature": 0.7,
                "parallel_tool_calls": true
            },
            "assistantMessage": {
                "role": "assistant",
                "content": null,
                "tool_calls": [
                    {
                        "id": "call_1",
                        "type": "function",
                        "function": {
                            "name": "clock",
                            "arguments": "{}"
                        }
                    }
                ]
            },
            "toolOutputs": [
                {
                    "tool_call_id": "call_1",
                    "name": "clock",
                    "content": "{\"ok\":true}"
                }
            ],
            "followupInjectionOps": [
                { "op": "append_assistant_message", "required": true },
                { "op": "append_tool_messages_from_tool_outputs", "required": true }
            ]
        });
        let output = build_servertool_generic_followup_payload_json(raw.to_string()).unwrap();
        let parsed: serde_json::Value = serde_json::from_str(output.as_str()).unwrap();
        assert_eq!(parsed.get("model").and_then(|v| v.as_str()), Some("gpt-test"));
        assert_eq!(
            parsed
                .get("messages")
                .and_then(|v| v.as_array())
                .map(|entries| entries.len()),
            Some(3)
        );
        assert_eq!(
            parsed
                .get("messages")
                .and_then(|v| v.as_array())
                .and_then(|entries| entries.get(1))
                .and_then(|entry| entry.get("role"))
                .and_then(|v| v.as_str()),
            Some("assistant")
        );
        assert_eq!(
            parsed
                .get("messages")
                .and_then(|v| v.as_array())
                .and_then(|entries| entries.get(2))
                .and_then(|entry| entry.get("role"))
                .and_then(|v| v.as_str()),
            Some("tool")
        );
    }

    #[test]
    fn test_build_servertool_generic_followup_payload_supports_user_system_and_drop_tool_ops() {
        let raw = serde_json::json!({
            "model": "gpt-test",
            "messages": [
                { "role": "system", "content": "base system" },
                { "role": "user", "content": "hi" }
            ],
            "tools": [
                {
                    "type": "function",
                    "function": { "name": "exec_command", "parameters": { "type": "object" } }
                },
                {
                    "type": "function",
                    "function": { "name": "web_search", "parameters": { "type": "object" } }
                }
            ],
            "followupInjectionOps": [
                { "op": "inject_system_text", "text": "extra system" },
                { "op": "append_user_text", "text": "继续执行" },
                { "op": "drop_tool_by_name", "name": "web_search" }
            ]
        });
        let output = build_servertool_generic_followup_payload_json(raw.to_string()).unwrap();
        let parsed: serde_json::Value = serde_json::from_str(output.as_str()).unwrap();
        assert_eq!(
            parsed
                .get("messages")
                .and_then(|v| v.as_array())
                .and_then(|entries| entries.first())
                .and_then(|entry| entry.get("role"))
                .and_then(|v| v.as_str()),
            Some("system")
        );
        assert_eq!(
            parsed
                .get("messages")
                .and_then(|v| v.as_array())
                .and_then(|entries| entries.get(1))
                .and_then(|entry| entry.get("role"))
                .and_then(|v| v.as_str()),
            Some("system")
        );
        assert_eq!(
            parsed
                .get("messages")
                .and_then(|v| v.as_array())
                .and_then(|entries| entries.last())
                .and_then(|entry| entry.get("content"))
                .and_then(|v| v.as_str()),
            Some("继续执行")
        );
        assert_eq!(
            parsed
                .get("tools")
                .and_then(|v| v.as_array())
                .map(|entries| entries.len()),
            Some(1)
        );
        assert_eq!(
            parsed
                .get("tools")
                .and_then(|v| v.as_array())
                .and_then(|entries| entries.first())
                .and_then(|entry| entry.get("function"))
                .and_then(|v| v.get("name"))
                .and_then(|v| v.as_str()),
            Some("exec_command")
        );
    }

    #[test]
    fn test_build_servertool_generic_followup_payload_supports_vision_and_compact_ops() {
        let raw = serde_json::json!({
            "model": "gpt-test",
            "messages": [
                {
                    "role": "user",
                    "content": [
                        { "type": "input_text", "text": "look" },
                        { "type": "input_image", "image_url": "data:image/png;base64,AAA" }
                    ]
                },
                { "role": "assistant", "content": "ok" },
                {
                    "role": "tool",
                    "content": "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
                }
            ],
            "followupInjectionOps": [
                { "op": "compact_tool_content", "maxChars": 80 },
                { "op": "inject_vision_summary", "summary": "a cat" }
            ]
        });
        let output = build_servertool_generic_followup_payload_json(raw.to_string()).unwrap();
        let parsed: serde_json::Value = serde_json::from_str(output.as_str()).unwrap();
        let messages = parsed
            .get("messages")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();
        assert_eq!(messages.len(), 3);
        let first_parts = messages[0]
            .get("content")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();
        let text_parts = first_parts
            .iter()
            .filter_map(|part| part.get("text").and_then(|v| v.as_str()))
            .collect::<Vec<_>>();
        assert!(text_parts.iter().any(|entry| *entry == "[Image omitted]"));
        assert!(text_parts.iter().any(|entry| *entry == "[Vision] a cat"));
        let tool_content = messages
            .iter()
            .find(|entry| entry.get("role").and_then(|v| v.as_str()) == Some("tool"))
            .and_then(|entry| entry.get("content"))
            .and_then(|v| v.as_str())
            .unwrap_or("");
        assert!(tool_content.contains("[tool_output_compacted omitted="));
    }

    #[test]
    fn test_build_servertool_generic_followup_payload_supports_trim_openai_messages_op() {
        let raw = serde_json::json!({
            "model": "gpt-test",
            "messages": [
                { "role": "system", "content": "policy" },
                { "role": "user", "content": "turn-1" },
                { "role": "assistant", "content": "turn-2" },
                { "role": "user", "content": "turn-3" },
                { "role": "assistant", "content": "turn-4" }
            ],
            "followupInjectionOps": [
                { "op": "trim_openai_messages", "maxNonSystemMessages": 2 }
            ]
        });
        let output = build_servertool_generic_followup_payload_json(raw.to_string()).unwrap();
        let parsed: serde_json::Value = serde_json::from_str(output.as_str()).unwrap();
        let messages = parsed
            .get("messages")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();
        assert_eq!(messages.len(), 3);
        assert_eq!(messages[0].get("role").and_then(|v| v.as_str()), Some("system"));
        assert_eq!(messages[1].get("content").and_then(|v| v.as_str()), Some("turn-3"));
        assert_eq!(messages[2].get("content").and_then(|v| v.as_str()), Some("turn-4"));
    }

    #[test]
    fn test_build_servertool_generic_followup_payload_supports_tool_schema_and_tool_choice_ops() {
        let raw = serde_json::json!({
            "model": "gpt-test",
            "messages": [
                { "role": "user", "content": "continue" }
            ],
            "tools": [
                {
                    "type": "function",
                    "function": { "name": "exec_command", "parameters": { "type": "object" } }
                }
            ],
            "parameters": {
                "parallel_tool_calls": true
            },
            "followupInjectionOps": [
                {
                    "op": "ensure_standard_tools",
                    "includeReasoningStopTool": true,
                    "reasoningStopToolDefinition": {
                        "type": "function",
                        "function": { "name": "reasoning.stop", "parameters": { "type": "object" } }
                    }
                },
                {
                    "op": "append_tool_if_missing",
                    "toolName": "web_search",
                    "toolDefinition": {
                        "type": "function",
                        "function": { "name": "web_search", "parameters": { "type": "object" } }
                    }
                },
                {
                    "op": "force_tool_choice",
                    "value": {
                        "type": "function",
                        "function": { "name": "reasoning.stop" }
                    }
                }
            ]
        });
        let output = build_servertool_generic_followup_payload_json(raw.to_string()).unwrap();
        let parsed: serde_json::Value = serde_json::from_str(output.as_str()).unwrap();
        let tool_names = parsed
            .get("tools")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default()
            .iter()
            .filter_map(|entry| {
                entry
                    .get("function")
                    .and_then(|v| v.get("name"))
                    .and_then(|v| v.as_str())
                    .map(|value| value.to_string())
            })
            .collect::<Vec<_>>();
        assert_eq!(
            tool_names,
            vec![
                "exec_command".to_string(),
                "reasoning.stop".to_string(),
                "web_search".to_string()
            ]
        );
        assert_eq!(
            parsed
                .get("parameters")
                .and_then(|v| v.get("tool_choice"))
                .and_then(|v| v.get("function"))
                .and_then(|v| v.get("name"))
                .and_then(|v| v.as_str()),
            Some("reasoning.stop")
        );
        assert_eq!(
            parsed
                .get("parameters")
                .and_then(|v| v.get("parallel_tool_calls"))
                .and_then(|v| v.as_bool()),
            Some(false)
        );
    }

    #[test]
    fn test_build_servertool_generic_followup_payload_supports_replace_tools_op() {
        let raw = serde_json::json!({
            "model": "gpt-test",
            "messages": [
                { "role": "user", "content": "continue" }
            ],
            "tools": [
                {
                    "type": "function",
                    "function": { "name": "exec_command", "parameters": { "type": "object" } }
                }
            ],
            "followupInjectionOps": [
                {
                    "op": "replace_tools",
                    "tools": [
                        {
                            "type": "function",
                            "function": { "name": "web_search", "parameters": { "type": "object" } }
                        }
                    ]
                }
            ]
        });
        let output = build_servertool_generic_followup_payload_json(raw.to_string()).unwrap();
        let parsed: serde_json::Value = serde_json::from_str(output.as_str()).unwrap();
        assert_eq!(
            parsed
                .get("tools")
                .and_then(|v| v.as_array())
                .map(|entries| entries.len()),
            Some(1)
        );
        assert_eq!(
            parsed
                .get("tools")
                .and_then(|v| v.as_array())
                .and_then(|entries| entries.first())
                .and_then(|entry| entry.get("function"))
                .and_then(|v| v.get("name"))
                .and_then(|v| v.as_str()),
            Some("web_search")
        );
    }

    #[test]
    fn test_plan_servertool_auto_hook_queues_prioritizes_pre_then_primary_then_remaining() {
        let raw = serde_json::json!({
            "hooks": [
                { "id": "stop_message_auto", "phase": "default", "priority": 40, "order": 3 },
                { "id": "clock_auto", "phase": "post", "priority": 50, "order": 4 },
                { "id": "recursive_detection_guard", "phase": "pre", "priority": 5, "order": 0 },
                { "id": "reasoning_only_continue", "phase": "post", "priority": 200, "order": 5 }
            ],
            "optionalPrimaryHookOrder": ["clock_auto", "stop_message_auto"],
            "mandatoryHookOrder": []
        });
        let output = plan_servertool_auto_hook_queues_json(raw.to_string()).unwrap();
        let parsed: serde_json::Value = serde_json::from_str(output.as_str()).unwrap();
        let optional = parsed.get("optionalQueue").and_then(|v| v.as_array()).cloned().unwrap_or_default();
        let ids: Vec<String> = optional
            .iter()
            .filter_map(|entry| entry.get("id").and_then(|v| v.as_str()).map(|v| v.to_string()))
            .collect();
        assert_eq!(
            ids,
            vec![
                "recursive_detection_guard",
                "clock_auto",
                "stop_message_auto",
                "reasoning_only_continue"
            ]
        );
    }

    #[test]
    fn test_plan_servertool_auto_hook_queues_applies_include_exclude_filters() {
        let raw = serde_json::json!({
            "hooks": [
                { "id": "stop_message_auto", "phase": "default", "priority": 40, "order": 3 },
                { "id": "clock_auto", "phase": "post", "priority": 50, "order": 4 },
                { "id": "recursive_detection_guard", "phase": "pre", "priority": 5, "order": 0 }
            ],
            "includeAutoHookIds": ["clock_auto", "stop_message_auto"],
            "excludeAutoHookIds": ["stop_message_auto"],
            "optionalPrimaryHookOrder": ["clock_auto", "stop_message_auto"],
            "mandatoryHookOrder": []
        });
        let output = plan_servertool_auto_hook_queues_json(raw.to_string()).unwrap();
        let parsed: serde_json::Value = serde_json::from_str(output.as_str()).unwrap();
        let optional = parsed.get("optionalQueue").and_then(|v| v.as_array()).cloned().unwrap_or_default();
        assert_eq!(optional.len(), 1);
        assert_eq!(optional[0].get("id").and_then(|v| v.as_str()), Some("clock_auto"));
        assert_eq!(optional[0].get("queueIndex").and_then(|v| v.as_i64()), Some(1));
        assert_eq!(optional[0].get("queueTotal").and_then(|v| v.as_i64()), Some(1));
    }

    #[test]
    fn test_plan_chat_web_search_operations_user_intent_prefers_direct_route_and_skips_servertool() {
        let request = serde_json::json!({
            "messages": [
                { "role": "user", "content": "please web search latest routecodex updates" }
            ]
        });
        let runtime_metadata = serde_json::json!({
            "webSearch": {
                "engines": [
                    {
                        "id": "native-search",
                        "providerKey": "demo.key1.model",
                        "executionMode": "direct",
                        "directActivation": "route",
                        "default": true
                    },
                    {
                        "id": "servertool-search",
                        "providerKey": "demo.key1.model",
                        "executionMode": "servertool"
                    }
                ]
            }
        });
        let output = plan_chat_web_search_operations_json(
            request.to_string(),
            runtime_metadata.to_string(),
        )
        .unwrap();
        let parsed: serde_json::Value = serde_json::from_str(output.as_str()).unwrap();
        assert_eq!(
            parsed.get("shouldInject").and_then(|v| v.as_bool()),
            Some(false)
        );
        assert_eq!(
            parsed
                .get("selectedEngineIndexes")
                .and_then(|v| v.as_array())
                .map(|v| v.len()),
            Some(0)
        );
    }

    #[test]
    fn test_plan_chat_web_search_operations_user_intent_servertool_mode_injects() {
        let request = serde_json::json!({
            "messages": [
                { "role": "user", "content": "please web search latest routecodex updates" }
            ]
        });
        let runtime_metadata = serde_json::json!({
            "webSearch": {
                "engines": [
                    {
                        "id": "servertool-search",
                        "providerKey": "demo.key1.model",
                        "executionMode": "servertool"
                    }
                ]
            }
        });
        let output = plan_chat_web_search_operations_json(
            request.to_string(),
            runtime_metadata.to_string(),
        )
        .unwrap();
        let parsed: serde_json::Value = serde_json::from_str(output.as_str()).unwrap();
        assert_eq!(
            parsed.get("shouldInject").and_then(|v| v.as_bool()),
            Some(true)
        );
        assert_eq!(
            parsed
                .get("selectedEngineIndexes")
                .and_then(|v| v.as_array())
                .map(|v| v.len()),
            Some(1)
        );
    }

    #[test]
    fn test_plan_chat_web_search_operations_tool_intent_servertool_mode_injects_via_semantics_force() {
        let request = serde_json::json!({
            "semantics": {
                "providerExtras": {
                    "webSearch": {
                        "force": true
                    }
                }
            },
            "messages": [
                { "role": "assistant", "content": "calling websearch tool now" }
            ]
        });
        let runtime_metadata = serde_json::json!({
            "webSearch": {
                "engines": [
                    {
                        "id": "servertool-search",
                        "providerKey": "demo.key1.model",
                        "executionMode": "servertool"
                    }
                ]
            }
        });
        let output = plan_chat_web_search_operations_json(
            request.to_string(),
            runtime_metadata.to_string(),
        )
        .unwrap();
        let parsed: serde_json::Value = serde_json::from_str(output.as_str()).unwrap();
        assert_eq!(
            parsed.get("shouldInject").and_then(|v| v.as_bool()),
            Some(true)
        );
        assert_eq!(
            parsed
                .get("selectedEngineIndexes")
                .and_then(|v| v.as_array())
                .map(|v| v.len()),
            Some(1)
        );
    }
}
