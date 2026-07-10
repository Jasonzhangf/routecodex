// feature_id: conversion.responses.store
// canonical_builder: stage_a_conversion_responses_store_owner_boundary
use crate::chat_process_media_semantics::strip_responses_stored_context_input_media;
use crate::hub_bridge_actions::utils::normalize_function_call_output_id;
use crate::shared_json_utils::{
    read_optional_bool, read_string_array_command, read_trimmed_string, read_workdir_from_args,
};
use napi::bindgen_prelude::Result as NapiResult;
use serde_json::{Map, Value};
use std::collections::{HashMap, HashSet};
use std::env;
use std::fs;
use std::path::PathBuf;
use std::sync::{LazyLock, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

pub(crate) fn stage_a_conversion_responses_store_owner_boundary() {}

fn is_shell_like_function_name(name: &str) -> bool {
    matches!(
        name.trim().to_ascii_lowercase().as_str(),
        "exec_command" | "shell_command" | "shell" | "bash" | "terminal" | "run_command"
    )
}

fn parse_arguments_record(value: Option<&Value>) -> Option<Map<String, Value>> {
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

fn read_command_from_args_map(args: &Map<String, Value>) -> Option<String> {
    let read_value = |value: Option<&Value>| -> Option<String> {
        read_trimmed_string(value).or_else(|| read_string_array_command(value))
    };

    let direct = read_value(args.get("cmd"))
        .or_else(|| read_value(args.get("command")))
        .or_else(|| read_value(args.get("command_line")))
        .or_else(|| read_value(args.get("proposed_command_line")));
    if direct.is_some() {
        return direct;
    }

    args.get("input")
        .and_then(Value::as_object)
        .and_then(|row| read_value(row.get("cmd")).or_else(|| read_value(row.get("command"))))
        .or_else(|| {
            args.get("args").and_then(Value::as_object).and_then(|row| {
                read_value(row.get("cmd")).or_else(|| read_value(row.get("command")))
            })
        })
}

fn args_contain_direct_or_nested_key(args: &Map<String, Value>, key: &str) -> bool {
    if args.contains_key(key) {
        return true;
    }
    ["input", "args"].iter().any(|container_key| {
        args.get(*container_key)
            .and_then(Value::as_object)
            .map(|row| row.contains_key(key))
            .unwrap_or(false)
    })
}

fn build_shell_like_output_arguments(
    raw_name: Option<&str>,
    args: &Map<String, Value>,
) -> Option<String> {
    let cmd = read_command_from_args_map(args)?;
    let has_cmd = args_contain_direct_or_nested_key(args, "cmd");
    let has_command = args_contain_direct_or_nested_key(args, "command")
        || args_contain_direct_or_nested_key(args, "command_line")
        || args_contain_direct_or_nested_key(args, "proposed_command_line");
    let source_is_shell_alias = raw_name
        .map(|name| {
            let lowered = name.trim().to_ascii_lowercase();
            matches!(
                lowered.as_str(),
                "shell_command" | "shell" | "bash" | "terminal"
            )
        })
        .unwrap_or(false);

    let emit_cmd = has_cmd || (!has_command && !source_is_shell_alias);
    let emit_command = has_command || (source_is_shell_alias && !has_cmd);

    let mut normalized = Map::new();
    if emit_command {
        normalized.insert("command".to_string(), Value::String(cmd.clone()));
    }
    if emit_cmd {
        normalized.insert("cmd".to_string(), Value::String(cmd));
    }
    if let Some(workdir) = read_workdir_from_args(args) {
        normalized.insert("workdir".to_string(), Value::String(workdir));
    }
    serde_json::to_string(&Value::Object(normalized)).ok()
}

fn pick_responses_persisted_fields(payload: &Value) -> Value {
    let Some(row) = payload.as_object() else {
        return Value::Object(Map::new());
    };
    let fields = [
        "model",
        "instructions",
        "metadata",
        "include",
        "store",
        "tool_choice",
        "parallel_tool_calls",
        "response_format",
        "temperature",
        "top_p",
        "max_output_tokens",
        "max_tokens",
        "stop",
        "user",
        "modal",
        "truncation_strategy",
        "previous_response_id",
        "reasoning",
        "attachments",
        "input_audio",
        "output_audio",
    ];
    let mut next = Map::new();
    for key in fields {
        if let Some(value) = row.get(key) {
            next.insert(key.to_string(), value.clone());
        }
    }
    Value::Object(next)
}

fn clone_responses_context_body(payload: &Value) -> Map<String, Value> {
    let mut cloned = clone_object(Some(payload));
    cloned.remove("response_id");
    cloned.remove("tool_outputs");
    cloned
}

fn normalize_responses_tool_definition(tool: &Value) -> Option<Value> {
    let row = tool.as_object()?;
    let tool_type = row
        .get("type")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())?;
    if tool_type != "function" {
        return Some(Value::Object(row.clone()));
    }

    let function_node = row.get("function").and_then(Value::as_object);
    let name = read_trimmed_string(row.get("name"))
        .or_else(|| function_node.and_then(|node| read_trimmed_string(node.get("name"))))?;

    let mut normalized = Map::new();
    normalized.insert("type".to_string(), Value::String("function".to_string()));
    normalized.insert("name".to_string(), Value::String(name));

    let description = row
        .get("description")
        .cloned()
        .or_else(|| function_node.and_then(|node| node.get("description").cloned()));
    if let Some(description) = description {
        normalized.insert("description".to_string(), description);
    }

    let parameters = row
        .get("parameters")
        .cloned()
        .or_else(|| function_node.and_then(|node| node.get("parameters").cloned()));
    if let Some(parameters) = parameters {
        normalized.insert("parameters".to_string(), parameters);
    }

    Some(Value::Object(normalized))
}

fn normalize_responses_tool_definitions(value: Option<&Value>) -> Vec<Value> {
    value
        .and_then(Value::as_array)
        .map(|tools| {
            tools
                .iter()
                .filter_map(normalize_responses_tool_definition)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default()
}

fn read_entry_tools_value(entry_obj: &Map<String, Value>) -> Value {
    if let Some(tools) = entry_obj.get("tools") {
        return tools.clone();
    }
    entry_obj
        .get("basePayload")
        .and_then(Value::as_object)
        .and_then(|row| row.get("tools"))
        .cloned()
        .unwrap_or(Value::Null)
}

fn should_allow_responses_conversation_continuation(payload: &Value) -> bool {
    let Some(row) = payload.as_object() else {
        return false;
    };
    if row.get("store").and_then(Value::as_bool) == Some(false) {
        return false;
    }
    if row.get("store").and_then(Value::as_bool) == Some(true) {
        return true;
    }
    let previous_response_id = read_trimmed_string(row.get("previous_response_id"));
    let response_id = read_trimmed_string(row.get("response_id"));
    let tool_outputs_len = row
        .get("tool_outputs")
        .and_then(Value::as_array)
        .map(Vec::len)
        .unwrap_or(0);
    (previous_response_id.is_some() || response_id.is_some()) && tool_outputs_len > 0
}

fn read_responses_tool_call_id(item: &Map<String, Value>) -> Option<String> {
    read_trimmed_string(item.get("call_id"))
        .or_else(|| read_trimmed_string(item.get("tool_call_id")))
        .or_else(|| read_trimmed_string(item.get("id")))
}

fn collect_responses_pending_tool_call_ids(input: &Value) -> Vec<String> {
    let Some(items) = input.as_array() else {
        return Vec::new();
    };
    let mut pending: Vec<String> = Vec::new();
    for item in items {
        let Some(row) = item.as_object() else {
            continue;
        };
        let item_type = read_trimmed_string(row.get("type"))
            .unwrap_or_default()
            .to_ascii_lowercase();
        let Some(call_id) = read_responses_tool_call_id(row) else {
            continue;
        };
        if item_type == "function_call" {
            if !pending.iter().any(|existing| existing == &call_id) {
                pending.push(call_id);
            }
            continue;
        }
        if item_type == "function_call_output"
            || item_type == "tool_result"
            || item_type == "tool_message"
        {
            if let Some(index) = pending.iter().position(|existing| existing == &call_id) {
                pending.remove(index);
            }
        }
    }
    pending
}

fn plan_responses_conversation_retention(entry: &Value, options: &Value) -> Value {
    if !entry.is_object() {
        return serde_json::json!({
            "action": "noop",
            "reason": "missing_entry",
        });
    }
    let last_response_id = entry
        .as_object()
        .and_then(|row| read_trimmed_string(row.get("lastResponseId")));
    if last_response_id.is_none() {
        return serde_json::json!({
            "action": "clear",
            "reason": "missing_response",
        });
    }
    let keep_for_submit_tool_outputs = options
        .as_object()
        .and_then(|row| row.get("keepForSubmitToolOutputs"))
        .and_then(Value::as_bool)
        .unwrap_or(false);
    if keep_for_submit_tool_outputs {
        return serde_json::json!({
            "action": "release",
            "reason": "keep_for_submit",
            "lastResponseId": last_response_id,
        });
    }
    let scope_count = entry
        .as_object()
        .and_then(|row| row.get("scopeKeys"))
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| read_trimmed_string(Some(item)))
                .count()
        })
        .unwrap_or(0);
    if scope_count == 0 {
        return serde_json::json!({
            "action": "clear",
            "reason": "missing_scope",
            "lastResponseId": last_response_id,
        });
    }
    serde_json::json!({
        "action": "release",
        "reason": "release",
        "lastResponseId": last_response_id,
    })
}

fn plan_responses_conversation_persistence_eligibility(entry: &Value, options: &Value) -> Value {
    let mode = options
        .as_object()
        .and_then(|row| read_trimmed_string(row.get("mode")))
        .unwrap_or_else(|| "flush".to_string());
    let Some(entry_obj) = entry.as_object() else {
        return serde_json::json!({
            "action": "skip",
            "reason": "missing_entry",
        });
    };
    let Some(last_response_id) = read_trimmed_string(entry_obj.get("lastResponseId")) else {
        return serde_json::json!({
            "action": "skip",
            "reason": "missing_response",
        });
    };
    if responses_continuation_owner(entry_obj.get("continuationOwner")).as_deref() == Some("direct")
    {
        return serde_json::json!({
            "action": "skip",
            "reason": "direct_owner",
            "lastResponseId": last_response_id,
        });
    }
    if mode == "flush"
        && entry_obj
            .get("allowContinuation")
            .and_then(Value::as_bool)
            .unwrap_or(false)
            != true
    {
        return serde_json::json!({
            "action": "skip",
            "reason": "continuation_not_allowed",
            "lastResponseId": last_response_id,
        });
    }
    if mode == "load" {
        let now_ms = options
            .as_object()
            .and_then(|row| row.get("nowMs"))
            .and_then(Value::as_i64);
        let ttl_ms = options
            .as_object()
            .and_then(|row| row.get("ttlMs"))
            .and_then(Value::as_i64);
        let updated_at = entry_obj.get("updatedAt").and_then(Value::as_i64);
        if let (Some(now_ms), Some(ttl_ms), Some(updated_at)) = (now_ms, ttl_ms, updated_at) {
            if now_ms - updated_at > ttl_ms {
                return serde_json::json!({
                    "action": "skip",
                    "reason": "expired",
                    "lastResponseId": last_response_id,
                });
            }
        }
    }
    serde_json::json!({
        "action": "persist",
        "reason": "eligible",
        "lastResponseId": last_response_id,
    })
}

fn clone_record_array(value: Option<&Value>) -> Vec<Value> {
    value
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter(|item| item.as_object().is_some())
                .cloned()
                .collect::<Vec<_>>()
        })
        .unwrap_or_default()
}

fn finite_number(value: Option<&Value>) -> Option<Value> {
    let number = value?.as_f64()?;
    if number.is_finite() {
        value.cloned()
    } else {
        None
    }
}

fn normalize_entry_kind(value: Option<&Value>) -> String {
    match read_trimmed_string(value).as_deref() {
        Some("chat") => "chat".to_string(),
        Some("messages") => "messages".to_string(),
        _ => "responses".to_string(),
    }
}

fn sanitize_string_array(value: Option<&Value>) -> Vec<Value> {
    value
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| read_trimmed_string(Some(item)).map(Value::String))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default()
}

fn plan_responses_store_tokens(input: &Value) -> Value {
    let obj = input.as_object().cloned().unwrap_or_default();
    let provider_key = read_trimmed_string(obj.get("providerKey"))
        .or_else(|| read_trimmed_string(obj.get("fallbackProviderKey")));
    let session_id = read_trimmed_string(obj.get("sessionId"));
    let conversation_id = read_trimmed_string(obj.get("conversationId"));
    let entry_kind = normalize_entry_kind(obj.get("entryKind"));
    let continuation_owner = responses_continuation_owner(obj.get("continuationOwner"))
        .or_else(|| responses_continuation_owner(obj.get("fallbackContinuationOwner")));

    serde_json::json!({
        "providerKey": provider_key,
        "sessionId": session_id,
        "conversationId": conversation_id,
        "entryKind": entry_kind,
        "continuationOwner": continuation_owner,
    })
}

fn plan_responses_conversation_preflight(input: &Value) -> Value {
    let obj = input.as_object().cloned().unwrap_or_default();
    let mode = read_trimmed_string(obj.get("mode")).unwrap_or_default();
    match mode.as_str() {
        "capture_request" => {
            let request_id = read_trimmed_string(obj.get("requestId"));
            let payload_is_record = obj.get("payload").and_then(Value::as_object).is_some();
            if request_id.is_none() {
                return serde_json::json!({
                    "action": "skip",
                    "reason": "missing_request_id",
                });
            }
            if !payload_is_record {
                return serde_json::json!({
                    "action": "skip",
                    "reason": "missing_payload",
                    "requestId": request_id,
                });
            }
            serde_json::json!({
                "action": "continue",
                "reason": "valid",
                "requestId": request_id,
            })
        }
        "record_response" => {
            let request_id = read_trimmed_string(obj.get("requestId"));
            let response_id = obj
                .get("response")
                .and_then(Value::as_object)
                .and_then(|response| read_trimmed_string(response.get("id")));
            if request_id.is_none() {
                return serde_json::json!({
                    "action": "throw",
                    "reason": "missing_request_id",
                    "code": "MALFORMED_RESPONSE",
                    "responseId": response_id,
                });
            }
            if response_id.is_none() {
                return serde_json::json!({
                    "action": "throw",
                    "reason": "missing_response_id",
                    "code": "MALFORMED_RESPONSE",
                    "requestId": request_id,
                });
            }
            serde_json::json!({
                "action": "continue",
                "reason": "valid",
                "requestId": request_id,
                "responseId": response_id,
            })
        }
        "resume_conversation" => {
            let response_id = read_trimmed_string(obj.get("responseId"));
            let tool_output_count = obj
                .get("submitPayload")
                .and_then(Value::as_object)
                .and_then(|payload| payload.get("tool_outputs"))
                .and_then(Value::as_array)
                .map(Vec::len)
                .unwrap_or(0);
            if response_id.is_none() {
                return serde_json::json!({
                    "action": "throw",
                    "reason": "missing_or_empty_response_id",
                    "code": "MALFORMED_REQUEST",
                });
            }
            if tool_output_count == 0 {
                return serde_json::json!({
                    "action": "throw",
                    "reason": "missing_tool_outputs",
                    "code": "MALFORMED_REQUEST",
                    "responseId": response_id,
                });
            }
            serde_json::json!({
                "action": "continue",
                "reason": "valid",
                "responseId": response_id,
                "toolOutputCount": tool_output_count,
            })
        }
        _ => serde_json::json!({
            "action": "throw",
            "reason": "unsupported_mode",
            "code": "INTERNAL_ERROR",
        }),
    }
}

fn plan_responses_record_continuation_flag(input: &Value) -> Value {
    let obj = input.as_object().cloned().unwrap_or_default();
    let existing_allow = obj
        .get("allowContinuation")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let pending_tool_call_count = obj
        .get("pendingToolCallIds")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter(|item| read_trimmed_string(Some(item)).is_some())
                .count()
        })
        .unwrap_or(0);
    if pending_tool_call_count > 0 {
        return serde_json::json!({
            "allowContinuation": true,
            "reason": "pending_tool_calls",
            "pendingToolCallCount": pending_tool_call_count,
        });
    }
    if existing_allow {
        return serde_json::json!({
            "allowContinuation": true,
            "reason": "already_allowed",
            "pendingToolCallCount": 0,
        });
    }
    serde_json::json!({
        "allowContinuation": false,
        "reason": "no_pending_tool_calls",
        "pendingToolCallCount": 0,
    })
}

fn plan_responses_captured_entry(input: &Value) -> Value {
    let obj = input.as_object().cloned().unwrap_or_default();
    let request_id = read_trimmed_string(obj.get("requestId")).unwrap_or_default();
    let payload = obj.get("payload").cloned().unwrap_or(Value::Null);
    let context = obj.get("context").cloned().unwrap_or(Value::Null);
    let prepared = prepare_responses_conversation_entry(&payload, &context);
    let prepared_obj = prepared.as_object();
    let base_payload = prepared_obj
        .and_then(|row| row.get("basePayload"))
        .and_then(Value::as_object)
        .map(|row| Value::Object(row.clone()))
        .unwrap_or_else(|| pick_responses_persisted_fields(&payload));
    let input_items = prepared_obj
        .and_then(|row| row.get("input"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let tools = prepared_obj
        .and_then(|row| row.get("tools"))
        .and_then(Value::as_array)
        .cloned()
        .filter(|items| !items.is_empty());
    let scope_keys: Vec<Value> = obj
        .get("scopeKeys")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|item| read_trimmed_string(Some(&item)).map(Value::String))
        .collect();
    let port_scope_key = read_trimmed_string(obj.get("portScopeKey"));
    let entry_tokens = plan_responses_store_tokens(&serde_json::json!({
        "providerKey": obj.get("providerKey").cloned().unwrap_or(Value::Null),
        "fallbackProviderKey": payload
            .as_object()
            .and_then(|row| row.get("providerKey"))
            .cloned()
            .unwrap_or(Value::Null),
        "sessionId": obj.get("sessionId").cloned().unwrap_or(Value::Null),
        "conversationId": obj.get("conversationId").cloned().unwrap_or(Value::Null),
        "entryKind": obj.get("entryKind").cloned().unwrap_or(Value::Null),
    }));
    let tokens_obj = entry_tokens.as_object().cloned().unwrap_or_default();
    let now_ms = obj.get("nowMs").cloned().unwrap_or(Value::Null);

    let mut entry = Map::new();
    entry.insert("requestId".to_string(), Value::String(request_id));
    entry.insert("basePayload".to_string(), base_payload);
    entry.insert("input".to_string(), Value::Array(input_items));
    entry.insert(
        "allowContinuation".to_string(),
        Value::Bool(should_allow_responses_conversation_continuation(&payload)),
    );
    if let Some(tools) = tools {
        entry.insert("tools".to_string(), Value::Array(tools));
    }
    if let Some(provider_key) = tokens_obj.get("providerKey").cloned() {
        entry.insert("providerKey".to_string(), provider_key);
    }
    entry.insert(
        "entryKind".to_string(),
        tokens_obj
            .get("entryKind")
            .cloned()
            .unwrap_or_else(|| Value::String("responses".to_string())),
    );
    entry.insert("continuationOwner".to_string(), Value::Null);
    if let Some(session_id) = tokens_obj.get("sessionId").cloned() {
        entry.insert("sessionId".to_string(), session_id);
    }
    if let Some(conversation_id) = tokens_obj.get("conversationId").cloned() {
        entry.insert("conversationId".to_string(), conversation_id);
    }
    entry.insert("scopeKeys".to_string(), Value::Array(scope_keys));
    if let Some(port_scope_key) = port_scope_key {
        entry.insert("portScopeKey".to_string(), Value::String(port_scope_key));
    }
    entry.insert("createdAt".to_string(), now_ms.clone());
    entry.insert("updatedAt".to_string(), now_ms);
    serde_json::json!({
        "action": "entry",
        "reason": "captured",
        "entry": Value::Object(entry),
    })
}

fn plan_responses_persisted_entry(input: &Value) -> Value {
    let obj = input.as_object().cloned().unwrap_or_default();
    let mode = read_trimmed_string(obj.get("mode")).unwrap_or_else(|| "serialize".to_string());
    let now_ms = obj.get("nowMs").and_then(Value::as_i64);
    let entry = obj.get("entry").unwrap_or(&Value::Null);
    let Some(entry_obj) = entry.as_object() else {
        return serde_json::json!({
            "action": "skip",
            "reason": "missing_entry",
        });
    };

    let Some(request_id) = read_trimmed_string(entry_obj.get("requestId")) else {
        return serde_json::json!({
            "action": "skip",
            "reason": "missing_request_id",
        });
    };
    let Some(base_payload) = entry_obj
        .get("basePayload")
        .and_then(Value::as_object)
        .cloned()
    else {
        return serde_json::json!({
            "action": "skip",
            "reason": "missing_base_payload",
        });
    };
    let Some(last_response_id) = read_trimmed_string(entry_obj.get("lastResponseId")) else {
        return serde_json::json!({
            "action": "skip",
            "reason": "missing_last_response_id",
        });
    };

    let created_at = finite_number(entry_obj.get("createdAt"))
        .or_else(|| now_ms.map(|value| serde_json::json!(value)))
        .unwrap_or(Value::Null);
    let updated_at = finite_number(entry_obj.get("updatedAt"))
        .or_else(|| {
            if created_at.is_number() {
                Some(created_at.clone())
            } else {
                now_ms.map(|value| serde_json::json!(value))
            }
        })
        .unwrap_or(Value::Null);

    let mut output = Map::new();
    output.insert("requestId".to_string(), Value::String(request_id));
    output.insert("basePayload".to_string(), Value::Object(base_payload));
    output.insert(
        "input".to_string(),
        Value::Array(clone_record_array(entry_obj.get("input"))),
    );
    output.insert(
        "allowContinuation".to_string(),
        Value::Bool(entry_obj.get("allowContinuation").and_then(Value::as_bool) == Some(true)),
    );
    output.insert(
        "releasedInputPrefix".to_string(),
        Value::Array(clone_record_array(entry_obj.get("releasedInputPrefix"))),
    );
    let released_pending = sanitize_string_array(entry_obj.get("releasedPendingToolCallIds"));
    if !released_pending.is_empty() {
        output.insert(
            "releasedPendingToolCallIds".to_string(),
            Value::Array(released_pending),
        );
    }
    if let Some(value) = read_trimmed_string(entry_obj.get("inputPrefixDigest")) {
        output.insert("inputPrefixDigest".to_string(), Value::String(value));
    }
    if let Some(value) = finite_number(entry_obj.get("inputItemCount")) {
        output.insert("inputItemCount".to_string(), value);
    }
    output.insert(
        "tools".to_string(),
        Value::Array(clone_record_array(entry_obj.get("tools"))),
    );
    if let Some(value) = read_trimmed_string(entry_obj.get("providerKey")) {
        output.insert("providerKey".to_string(), Value::String(value));
    }
    output.insert(
        "entryKind".to_string(),
        Value::String(normalize_entry_kind(entry_obj.get("entryKind"))),
    );
    if let Some(value) = responses_continuation_owner(entry_obj.get("continuationOwner")) {
        output.insert("continuationOwner".to_string(), Value::String(value));
    }
    output.insert("createdAt".to_string(), created_at);
    output.insert("updatedAt".to_string(), updated_at);
    output.insert(
        "lastResponseId".to_string(),
        Value::String(last_response_id),
    );
    if let Some(value) = read_trimmed_string(entry_obj.get("sessionId")) {
        output.insert("sessionId".to_string(), Value::String(value));
    }
    if let Some(value) = read_trimmed_string(entry_obj.get("conversationId")) {
        output.insert("conversationId".to_string(), Value::String(value));
    }
    output.insert(
        "scopeKeys".to_string(),
        Value::Array(sanitize_string_array(entry_obj.get("scopeKeys"))),
    );
    if let Some(value) = read_trimmed_string(entry_obj.get("portScopeKey")) {
        output.insert("portScopeKey".to_string(), Value::String(value));
    }

    serde_json::json!({
        "action": "entry",
        "reason": mode,
        "entry": Value::Object(output),
    })
}

fn read_scope_keys(row: &Map<String, Value>) -> Vec<String> {
    row.get("scopeKeys")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| read_trimmed_string(Some(item)))
                .collect()
        })
        .unwrap_or_default()
}

fn plan_responses_capture_pending_cleanup(input: &Value) -> Value {
    let obj = input.as_object().cloned().unwrap_or_default();
    let Some(request_id) = read_trimmed_string(obj.get("requestId")) else {
        return serde_json::json!({
            "action": "noop",
            "reason": "missing_request_id",
            "detachRequestIds": [],
        });
    };
    let requested_scope_keys: HashSet<String> = obj
        .get("scopeKeys")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| read_trimmed_string(Some(item)))
                .collect()
        })
        .unwrap_or_default();
    if requested_scope_keys.is_empty() {
        return serde_json::json!({
            "action": "noop",
            "reason": "missing_scope",
            "detachRequestIds": [],
        });
    }
    let candidates = obj
        .get("candidates")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut detach_request_ids: Vec<String> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    for candidate in candidates {
        let Some(row) = candidate.as_object() else {
            continue;
        };
        let Some(candidate_request_id) = read_trimmed_string(row.get("requestId")) else {
            continue;
        };
        if candidate_request_id == request_id {
            continue;
        }
        if read_trimmed_string(row.get("lastResponseId")).is_some() {
            continue;
        }
        let has_scope_overlap = read_scope_keys(row)
            .iter()
            .any(|scope_key| requested_scope_keys.contains(scope_key));
        if !has_scope_overlap || !seen.insert(candidate_request_id.clone()) {
            continue;
        }
        detach_request_ids.push(candidate_request_id);
    }
    serde_json::json!({
        "action": if detach_request_ids.is_empty() { "noop" } else { "detach" },
        "reason": if detach_request_ids.is_empty() { "no_match" } else { "pending_scope_overlap" },
        "detachRequestIds": detach_request_ids,
    })
}

fn plan_responses_record_scope_cleanup(input: &Value) -> Value {
    let obj = input.as_object().cloned().unwrap_or_default();
    let Some(request_id) = read_trimmed_string(obj.get("requestId")) else {
        return serde_json::json!({
            "action": "noop",
            "reason": "missing_request_id",
            "detachRequestIds": [],
        });
    };
    let scope_keys: HashSet<String> = obj
        .get("scopeKeys")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| read_trimmed_string(Some(item)))
                .collect()
        })
        .unwrap_or_default();
    if scope_keys.is_empty() {
        return serde_json::json!({
            "action": "noop",
            "reason": "missing_scope",
            "detachRequestIds": [],
        });
    }
    let candidates = obj
        .get("candidates")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut detach_request_ids: Vec<String> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    for candidate in candidates {
        let Some(row) = candidate.as_object() else {
            continue;
        };
        let Some(candidate_request_id) = read_trimmed_string(row.get("requestId")) else {
            continue;
        };
        if candidate_request_id == request_id {
            continue;
        }
        if read_trimmed_string(row.get("lastResponseId")).is_none() {
            continue;
        }
        let has_scope_overlap = read_scope_keys(row)
            .iter()
            .any(|scope_key| scope_keys.contains(scope_key));
        if !has_scope_overlap || !seen.insert(candidate_request_id.clone()) {
            continue;
        }
        detach_request_ids.push(candidate_request_id);
    }
    serde_json::json!({
        "action": if detach_request_ids.is_empty() { "noop" } else { "detach" },
        "reason": if detach_request_ids.is_empty() { "no_match" } else { "completed_scope_overlap" },
        "detachRequestIds": detach_request_ids,
    })
}

fn plan_responses_record_scope_entry_match(input: &Value) -> Value {
    let obj = input.as_object().cloned().unwrap_or_default();
    let requested_scope_keys: Vec<String> = obj
        .get("scopeKeys")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| read_trimmed_string(Some(item)))
                .collect()
        })
        .unwrap_or_default();
    if requested_scope_keys.is_empty() {
        return serde_json::json!({
            "action": "none",
            "reason": "missing_scope",
        });
    }
    let candidates = obj
        .get("candidates")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut candidate_by_scope: HashMap<String, String> = HashMap::new();
    for candidate in candidates {
        let Some(row) = candidate.as_object() else {
            continue;
        };
        let Some(scope_key) = read_trimmed_string(row.get("scopeKey")) else {
            continue;
        };
        let Some(request_id) = read_trimmed_string(row.get("requestId")) else {
            continue;
        };
        candidate_by_scope.entry(scope_key).or_insert(request_id);
    }
    for scope_key in requested_scope_keys {
        if let Some(request_id) = candidate_by_scope.get(&scope_key) {
            return serde_json::json!({
                "action": "select",
                "reason": "scope_match",
                "scopeKey": scope_key,
                "requestId": request_id,
            });
        }
    }
    serde_json::json!({
        "action": "none",
        "reason": "no_scope_match",
    })
}

fn plan_responses_attach_entry_scopes(input: &Value) -> Value {
    let obj = input.as_object().cloned().unwrap_or_default();
    let Some(request_id) = read_trimmed_string(obj.get("requestId")) else {
        return serde_json::json!({
            "action": "noop",
            "reason": "missing_request_id",
            "scopeKeys": [],
            "detachRequestIds": [],
        });
    };
    let scope_keys: Vec<String> = obj
        .get("scopeKeys")
        .and_then(Value::as_array)
        .map(|items| {
            let mut seen: HashSet<String> = HashSet::new();
            items
                .iter()
                .filter_map(|item| read_trimmed_string(Some(item)))
                .filter(|scope_key| seen.insert(scope_key.clone()))
                .collect()
        })
        .unwrap_or_default();
    if scope_keys.is_empty() {
        return serde_json::json!({
            "action": "noop",
            "reason": "missing_scope",
            "scopeKeys": [],
            "detachRequestIds": [],
        });
    }
    let candidates = obj
        .get("candidates")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let requested_scopes: HashSet<String> = scope_keys.iter().cloned().collect();
    let mut detach_request_ids: Vec<String> = Vec::new();
    let mut seen_request_ids: HashSet<String> = HashSet::new();
    for candidate in candidates {
        let Some(row) = candidate.as_object() else {
            continue;
        };
        let Some(scope_key) = read_trimmed_string(row.get("scopeKey")) else {
            continue;
        };
        if !requested_scopes.contains(&scope_key) {
            continue;
        }
        let Some(candidate_request_id) = read_trimmed_string(row.get("requestId")) else {
            continue;
        };
        if candidate_request_id == request_id
            || !seen_request_ids.insert(candidate_request_id.clone())
        {
            continue;
        }
        detach_request_ids.push(candidate_request_id);
    }
    serde_json::json!({
        "action": if detach_request_ids.is_empty() { "attach" } else { "detach_and_attach" },
        "reason": if detach_request_ids.is_empty() { "no_conflict" } else { "scope_conflict" },
        "scopeKeys": scope_keys,
        "detachRequestIds": detach_request_ids,
    })
}

fn plan_responses_rebind_request_id(input: &Value) -> Value {
    let obj = input.as_object().cloned().unwrap_or_default();
    let Some(old_id) = read_trimmed_string(obj.get("oldId")) else {
        return serde_json::json!({
            "action": "noop",
            "reason": "missing_old_id",
        });
    };
    let Some(new_id) = read_trimmed_string(obj.get("newId")) else {
        return serde_json::json!({
            "action": "noop",
            "reason": "missing_new_id",
        });
    };
    if old_id == new_id {
        return serde_json::json!({
            "action": "noop",
            "reason": "same_id",
            "oldId": old_id,
            "newId": new_id,
        });
    }
    if obj
        .get("oldEntryExists")
        .and_then(Value::as_bool)
        .unwrap_or(false)
        != true
    {
        return serde_json::json!({
            "action": "noop",
            "reason": "missing_old_entry",
            "oldId": old_id,
            "newId": new_id,
        });
    }
    if obj
        .get("newEntryExists")
        .and_then(Value::as_bool)
        .unwrap_or(false)
        == true
    {
        return serde_json::json!({
            "action": "noop",
            "reason": "new_id_conflict",
            "oldId": old_id,
            "newId": new_id,
        });
    }
    serde_json::json!({
        "action": "rebind",
        "reason": "matched",
        "oldId": old_id,
        "newId": new_id,
    })
}

fn plan_responses_store_sweep(input: &Value) -> Value {
    let obj = input.as_object().cloned().unwrap_or_default();
    let mode = read_trimmed_string(obj.get("mode")).unwrap_or_default();
    if mode != "clear_unresolved" && mode != "prune_expired" {
        return serde_json::json!({
            "action": "noop",
            "reason": "invalid_mode",
            "detachRequestIds": [],
        });
    }
    let now_ms = obj.get("nowMs").and_then(Value::as_i64);
    let ttl_ms = obj.get("ttlMs").and_then(Value::as_i64);
    let candidates = obj
        .get("candidates")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut detach_request_ids: Vec<String> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    for candidate in candidates {
        let Some(row) = candidate.as_object() else {
            continue;
        };
        let Some(request_id) = read_trimmed_string(row.get("requestId")) else {
            continue;
        };
        if !seen.insert(request_id.clone()) {
            continue;
        }
        let should_detach = if mode == "clear_unresolved" {
            read_trimmed_string(row.get("lastResponseId")).is_none()
        } else {
            match (row.get("updatedAt").and_then(Value::as_i64), now_ms, ttl_ms) {
                (Some(updated_at), Some(now_ms), Some(ttl_ms)) if ttl_ms >= 0 => {
                    now_ms - updated_at > ttl_ms
                }
                _ => false,
            }
        };
        if should_detach {
            detach_request_ids.push(request_id);
        }
    }
    let reason = if mode == "clear_unresolved" {
        if detach_request_ids.is_empty() {
            "no_unresolved"
        } else {
            "unresolved"
        }
    } else if detach_request_ids.is_empty() {
        "no_expired"
    } else {
        "expired"
    };
    serde_json::json!({
        "action": if detach_request_ids.is_empty() { "noop" } else { "detach" },
        "reason": reason,
        "detachRequestIds": detach_request_ids,
    })
}

fn plan_responses_release_request_payload(entry: &Value) -> Value {
    let entry_obj = entry.as_object().cloned().unwrap_or_default();
    let released_input_prefix_raw = clone_array(entry_obj.get("input"));
    let stripped = strip_responses_stored_context_input_media(
        released_input_prefix_raw,
        "[Image omitted]".to_string(),
    );
    let released_input_prefix = stripped.messages;
    let mut base_payload = entry_obj
        .get("basePayload")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    if let Some(last_response_id) = read_trimmed_string(entry_obj.get("lastResponseId")) {
        base_payload.insert(
            "previous_response_id".to_string(),
            Value::String(last_response_id),
        );
    }
    let released_pending_tool_call_ids =
        collect_responses_pending_tool_call_ids(&Value::Array(released_input_prefix.clone()));
    serde_json::json!({
        "basePayload": Value::Object(base_payload),
        "releasedInputPrefix": released_input_prefix,
        "releasedPendingToolCallIds": released_pending_tool_call_ids,
        "input": [],
    })
}

fn plan_responses_scope_continuation_match(input: &Value) -> Value {
    let obj = input.as_object().cloned().unwrap_or_default();
    let mode = read_trimmed_string(obj.get("mode")).unwrap_or_default();
    if mode != "resume" && mode != "materialize" {
        return serde_json::json!({
            "action": "none",
            "reason": "invalid_mode",
        });
    }
    let requested_owner = obj
        .get("options")
        .and_then(Value::as_object)
        .and_then(|row| row.get("continuationOwner"))
        .and_then(|value| responses_continuation_owner(Some(value)));
    let candidates = obj
        .get("candidates")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut matched_owners: HashSet<String> = HashSet::new();
    let mut matches: HashMap<String, Value> = HashMap::new();

    for candidate in candidates {
        let Some(row) = candidate.as_object() else {
            continue;
        };
        let Some(scope_key) = read_trimmed_string(row.get("scopeKey")) else {
            continue;
        };
        let Some(request_id) = read_trimmed_string(row.get("requestId")) else {
            continue;
        };
        if row
            .get("allowContinuation")
            .and_then(Value::as_bool)
            .unwrap_or(false)
            != true
        {
            continue;
        }
        let owner = row
            .get("continuationOwner")
            .and_then(|value| responses_continuation_owner(Some(value)));
        if mode == "materialize" {
            let Some(owner_value) = owner.clone() else {
                continue;
            };
            matched_owners.insert(owner_value.clone());
            if owner_value == "direct" {
                continue;
            }
        } else if owner.as_deref() == Some("direct") {
            continue;
        }
        let last_response_id = read_trimmed_string(row.get("lastResponseId"));
        if mode == "resume" && last_response_id.is_none() {
            continue;
        }
        let dedupe_key = format!(
            "{}:{}",
            request_id,
            last_response_id.clone().unwrap_or_default()
        );
        matches.entry(dedupe_key.clone()).or_insert_with(|| {
            serde_json::json!({
                "scopeKey": scope_key,
                "dedupeKey": dedupe_key,
                "requestId": request_id,
                "lastResponseId": last_response_id,
            })
        });
    }

    if mode == "materialize"
        && requested_owner.is_none()
        && matched_owners.contains("direct")
        && matched_owners.contains("relay")
    {
        return serde_json::json!({
            "action": "none",
            "reason": "mixed_owner_ambiguous",
        });
    }
    if matches.len() != 1 {
        return serde_json::json!({
            "action": "none",
            "reason": if matches.is_empty() { "no_match" } else { "ambiguous" },
            "matchCount": matches.len(),
        });
    }
    let mut selected = matches.into_values().next().unwrap_or(Value::Null);
    if let Some(row) = selected.as_object_mut() {
        row.insert(
            "action".to_string(),
            Value::String(
                if mode == "resume" {
                    "restore"
                } else {
                    "materialize"
                }
                .to_string(),
            ),
        );
        row.insert("reason".to_string(), Value::String("matched".to_string()));
    }
    selected
}

fn response_entry_candidate_matches(
    row: &Map<String, Value>,
    response_id: &str,
    requested_port_scope_key: Option<&str>,
    options: Option<&Map<String, Value>>,
) -> bool {
    if read_trimmed_string(row.get("lastResponseId")).as_deref() != Some(response_id) {
        return false;
    }
    if let Some(requested_port_scope_key) = requested_port_scope_key {
        if read_trimmed_string(row.get("portScopeKey")).as_deref() != Some(requested_port_scope_key)
        {
            return false;
        }
    }
    if let Some(options) = options {
        if options.contains_key("entryKind") {
            let requested_entry_kind = responses_entry_kind(options.get("entryKind"));
            let actual_entry_kind = responses_entry_kind(row.get("entryKind"));
            if actual_entry_kind != requested_entry_kind {
                return false;
            }
        }
        if let Some(requested_owner) =
            responses_continuation_owner(options.get("continuationOwner"))
        {
            let actual_owner = responses_continuation_owner(row.get("continuationOwner"));
            if actual_owner.as_deref() != Some(requested_owner.as_str()) {
                return false;
            }
        }
    }
    true
}

fn selected_resume_entry_plan(row: &Map<String, Value>, source: &str) -> Value {
    if row
        .get("allowContinuation")
        .and_then(Value::as_bool)
        .unwrap_or(false)
        != true
    {
        return serde_json::json!({
            "action": "none",
            "reason": "expired_or_unknown_response_id",
        });
    }
    serde_json::json!({
        "action": "select",
        "reason": "matched",
        "source": source,
        "requestId": read_trimmed_string(row.get("requestId")),
        "lastResponseId": read_trimmed_string(row.get("lastResponseId")),
        "scopeKey": read_trimmed_string(row.get("scopeKey")),
    })
}

fn plan_responses_conversation_resume_entry_match(input: &Value) -> Value {
    let obj = input.as_object().cloned().unwrap_or_default();
    let Some(response_id) = read_trimmed_string(obj.get("responseId")) else {
        return serde_json::json!({
            "action": "none",
            "reason": "missing_or_empty_response_id",
        });
    };
    let requested_port_scope_key =
        read_trimmed_string(obj.get("requestedPortScopeKey")).filter(|value| !value.is_empty());
    let options = obj.get("options").and_then(Value::as_object);
    let candidates = obj
        .get("candidates")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut indexed_present = false;
    let mut request_matches: Vec<Map<String, Value>> = Vec::new();

    for candidate in &candidates {
        let Some(row) = candidate.as_object() else {
            continue;
        };
        let source = read_trimmed_string(row.get("source")).unwrap_or_default();
        if source == "response_index" {
            indexed_present = true;
            if response_entry_candidate_matches(
                row,
                &response_id,
                requested_port_scope_key.as_deref(),
                options,
            ) {
                return selected_resume_entry_plan(row, "response_index");
            }
        }
    }

    if !indexed_present {
        for candidate in &candidates {
            let Some(row) = candidate.as_object() else {
                continue;
            };
            let source = read_trimmed_string(row.get("source")).unwrap_or_default();
            if source != "request_map" {
                continue;
            }
            if response_entry_candidate_matches(
                row,
                &response_id,
                requested_port_scope_key.as_deref(),
                options,
            ) {
                request_matches.push(row.clone());
            }
        }
        if request_matches.len() > 1 {
            return serde_json::json!({
                "action": "ambiguous",
                "reason": "ambiguous_response_id_index",
                "responseId": response_id,
                "matchCount": request_matches.len(),
            });
        }
        if let Some(row) = request_matches.first() {
            return selected_resume_entry_plan(row, "request_map");
        }
    }

    for candidate in &candidates {
        let Some(row) = candidate.as_object() else {
            continue;
        };
        let source = read_trimmed_string(row.get("source")).unwrap_or_default();
        if source != "scope" {
            continue;
        }
        if response_entry_candidate_matches(
            row,
            &response_id,
            requested_port_scope_key.as_deref(),
            options,
        ) {
            return selected_resume_entry_plan(row, "scope");
        }
    }

    serde_json::json!({
        "action": "none",
        "reason": "expired_or_unknown_response_id",
    })
}

fn plan_responses_continuation_lookup_by_response_id(input: &Value) -> Value {
    let obj = input.as_object().cloned().unwrap_or_default();
    let Some(response_id) = read_trimmed_string(obj.get("responseId")) else {
        return serde_json::json!({
            "action": "none",
            "reason": "missing_or_empty_response_id",
        });
    };
    let Some(entry) = obj.get("entry").and_then(Value::as_object) else {
        return serde_json::json!({
            "action": "none",
            "reason": "missing_entry",
        });
    };
    let requested_port_scope_key =
        read_trimmed_string(obj.get("requestedPortScopeKey")).filter(|value| !value.is_empty());
    let options = obj.get("options").and_then(Value::as_object);
    if !response_entry_candidate_matches(
        entry,
        &response_id,
        requested_port_scope_key.as_deref(),
        options,
    ) {
        return serde_json::json!({
            "action": "none",
            "reason": "isolation_mismatch",
        });
    }
    serde_json::json!({
        "action": "select",
        "reason": "matched",
        "responseId": read_trimmed_string(entry.get("lastResponseId")),
        "providerKey": read_trimmed_string(entry.get("providerKey")),
        "continuationOwner": responses_continuation_owner(entry.get("continuationOwner")),
        "entryKind": responses_entry_kind(entry.get("entryKind")),
        "requestId": read_trimmed_string(entry.get("requestId")),
    })
}

fn plan_responses_continuation_meta(input: &Value) -> Value {
    let obj = input.as_object().cloned().unwrap_or_default();
    let meta = obj
        .get("meta")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let entry = obj.get("entry").and_then(Value::as_object);
    let mut output = meta;

    let meta_provider_key = read_trimmed_string(output.get("providerKey"));
    let entry_provider_key = entry.and_then(|row| read_trimmed_string(row.get("providerKey")));
    if meta_provider_key.is_none() {
        if let Some(provider_key) = entry_provider_key {
            output.insert("providerKey".to_string(), Value::String(provider_key));
        }
    }

    let meta_owner = responses_continuation_owner(output.get("continuationOwner"));
    let entry_owner =
        entry.and_then(|row| responses_continuation_owner(row.get("continuationOwner")));
    if meta_owner.is_none() {
        if let Some(owner) = entry_owner {
            output.insert("continuationOwner".to_string(), Value::String(owner));
        }
    }

    let meta_entry_kind = read_trimmed_string(output.get("entryKind"));
    let entry_kind = entry.map(|row| responses_entry_kind(row.get("entryKind")));
    if meta_entry_kind.is_none() {
        if let Some(kind) = entry_kind {
            output.insert("entryKind".to_string(), Value::String(kind));
        }
    }

    serde_json::json!({
        "action": "meta",
        "reason": "merged",
        "meta": Value::Object(output),
    })
}

fn normalize_responses_history_item(value: Value) -> Value {
    let Some(row) = value.as_object() else {
        return value;
    };
    let item_type = row
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();

    if item_type == "function_call" {
        let mut out = Map::new();
        out.insert(
            "type".to_string(),
            Value::String("function_call".to_string()),
        );
        if let Some(id) = read_trimmed_string(row.get("id")) {
            out.insert("id".to_string(), Value::String(id));
        }
        if let Some(call_id) = read_bridge_function_call_id(row) {
            out.insert("call_id".to_string(), Value::String(call_id));
        }
        if let Some(name) = read_trimmed_string(row.get("name")).or_else(|| {
            row.get("function")
                .and_then(Value::as_object)
                .and_then(|function| read_trimmed_string(function.get("name")))
        }) {
            out.insert("name".to_string(), Value::String(name));
        }
        if let Some(arguments) = row.get("arguments").cloned().or_else(|| {
            row.get("function")
                .and_then(Value::as_object)
                .and_then(|function| function.get("arguments").cloned())
        }) {
            out.insert("arguments".to_string(), arguments);
        }
        return Value::Object(out);
    }

    if item_type == "function_call_output" {
        let mut out = Map::new();
        out.insert(
            "type".to_string(),
            Value::String("function_call_output".to_string()),
        );
        if let Some(id) = read_trimmed_string(row.get("id")) {
            out.insert("id".to_string(), Value::String(id));
        }
        if let Some(call_id) = read_bridge_function_call_id(row) {
            out.insert("call_id".to_string(), Value::String(call_id));
        }
        if let Some(output) = row.get("output").cloned() {
            out.insert("output".to_string(), output);
        }
        return Value::Object(out);
    }

    value
}

fn normalize_responses_history_items(items: Vec<Value>) -> Vec<Value> {
    items
        .into_iter()
        .map(strip_meta_value)
        .map(normalize_responses_history_item)
        .collect::<Vec<_>>()
}

pub(crate) fn normalize_responses_request_input_for_chat_codec(items: Vec<Value>) -> Vec<Value> {
    collapse_auto_stop_hook_pairs_in_history(normalize_responses_history_items(items))
}

const STOP_HOOK_COMMAND_MARKERS: &[&str] = &[
    "routecodex hook run stop_message_auto",
    "routecodex servertool run stop_message_auto",
    "routecodex hook run reasoningStop",
    "routecodex servertool run reasoningStop",
];

fn build_responses_text_guidance_input_item(text: String) -> Value {
    serde_json::json!({
        "type": "message",
        "role": "user",
        "content": [{ "type": "input_text", "text": text }]
    })
}

fn is_shell_like_tool_name(raw_name: &str) -> bool {
    matches!(
        raw_name.trim().to_ascii_lowercase().as_str(),
        "exec_command"
            | "run_command"
            | "bash"
            | "sh"
            | "zsh"
            | "terminal"
            | "shell"
            | "write_stdin"
    )
}

fn read_exec_command_cmd(arguments: Option<&Value>) -> Option<String> {
    let raw = match arguments {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Object(obj)) => obj
            .get("cmd")
            .and_then(Value::as_str)
            .map(ToOwned::to_owned)
            .or_else(|| {
                obj.get("command")
                    .and_then(Value::as_str)
                    .map(ToOwned::to_owned)
            })?,
        _ => return None,
    };
    if let Ok(Value::Object(obj)) = serde_json::from_str::<Value>(&raw) {
        return obj
            .get("cmd")
            .and_then(Value::as_str)
            .map(ToOwned::to_owned)
            .or_else(|| {
                obj.get("command")
                    .and_then(Value::as_str)
                    .map(ToOwned::to_owned)
            });
    }
    Some(raw)
}

fn parse_stopless_tool_output_payload(value: &Value) -> Option<Map<String, Value>> {
    match value {
        Value::Object(row) => Some(row.clone()),
        Value::String(text) => serde_json::from_str::<Value>(text)
            .ok()
            .and_then(|parsed| parsed.as_object().cloned()),
        _ => None,
    }
}

fn is_normalized_stop_hook_name(raw_name: &str) -> bool {
    matches!(raw_name.trim(), "reasoningStop" | "stop_message_auto")
}

fn is_stopless_tool_output_record(row: &Map<String, Value>) -> bool {
    let tool_name = read_trimmed_string(row.get("toolName"))
        .or_else(|| read_trimmed_string(row.get("tool_name")))
        .or_else(|| read_trimmed_string(row.get("tool")))
        .or_else(|| read_trimmed_string(row.get("kind")));
    if tool_name.as_deref() == Some("stop_message_auto") {
        return true;
    }
    read_trimmed_string(row.get("flowId"))
        .or_else(|| read_trimmed_string(row.get("flow_id")))
        .is_some_and(|flow_id| flow_id == "stop_message_flow")
        && (row.contains_key("continuationPrompt")
            || row.contains_key("continuation_prompt")
            || row.contains_key("repeatCount")
            || row.contains_key("repeat_count")
            || row.contains_key("schemaFeedback")
            || row.contains_key("schema_feedback")
            || row.contains_key("schemaGuidance")
            || row.contains_key("schema_guidance"))
}

fn is_stop_hook_function_call(row: &Map<String, Value>) -> bool {
    let item_type = read_trimmed_string(row.get("type"))
        .unwrap_or_default()
        .to_ascii_lowercase();
    if item_type != "function_call" && item_type != "tool_call" {
        return false;
    }
    let name = read_trimmed_string(row.get("name")).unwrap_or_default();
    if is_normalized_stop_hook_name(name.as_str()) {
        return true;
    }
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

fn read_stopless_schema_feedback_text(
    row: &Map<String, Value>,
    _repeat_count: u32,
) -> Option<String> {
    let feedback = row
        .get("schemaFeedback")
        .or_else(|| row.get("schema_feedback"))?
        .as_object()?;
    let reason_code = read_trimmed_string(feedback.get("reasonCode"))
        .or_else(|| read_trimmed_string(feedback.get("reason_code")))?;
    let missing_fields = feedback
        .get("missingFields")
        .or_else(|| feedback.get("missing_fields"))
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| read_trimmed_string(Some(item)))
                .collect::<Vec<String>>()
        })
        .unwrap_or_default();
    if reason_code == "stop_schema_continue_next_step" {
        return None;
    }
    if missing_fields.is_empty() && reason_code != "stop_schema_continue_next_step" {
        return None;
    }
    let joined = missing_fields.join(", ");
    match reason_code.as_str() {
        "stop_schema_missing" => Some(if joined.is_empty() {
            "继续。".to_string()
        } else {
            format!("继续；按上一轮反馈补齐字段：{joined}。")
        }),
        "stop_schema_reason_missing" => Some("继续；按上一轮反馈补齐 reason。".to_string()),
        "stop_schema_continue_next_step" => None,
        "stop_schema_terminal_missing_fields" => {
            Some(format!("继续；按上一轮反馈补齐终态字段：{joined}。"))
        }
        "stop_schema_needs_user_input_missing_next_step" => {
            Some("你表示需要用户输入，但 next_step 里还没有写出要问用户的具体问题；把问题直接写进 next_step。".to_string())
        }
        "stop_schema_next_step_missing" => {
            Some(format!("继续；按上一轮反馈补齐 next_step：{joined}。"))
        }
        "stop_schema_current_goal_missing" => {
            Some("继续；按上一轮反馈补齐 current_goal。".to_string())
        }
        "stop_schema_continue_without_next_step" => {
            Some("继续；按上一轮反馈补齐 next_step。".to_string())
        }
        _ => Some(format!("先补齐这些字段：{joined}。")),
    }
}

fn render_stopless_schema_guidance_text(schema_guidance: &Value) -> Option<String> {
    let guidance = schema_guidance.as_object()?;
    let required_fields = guidance
        .get("requiredFields")
        .or_else(|| guidance.get("required_fields"))
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| read_trimmed_string(Some(item)))
                .collect::<Vec<String>>()
        })
        .unwrap_or_default();
    let stopreason_values = guidance
        .get("stopreasonValues")
        .or_else(|| guidance.get("stopreason_values"))
        .and_then(Value::as_object);
    let sample = guidance
        .get("sample")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| format!("最小可复制样本：{value}"));
    let mut lines = Vec::<String>::new();
    if !required_fields.is_empty() {
        lines.push(format!(
            "按上一轮反馈补齐这些字段：{}",
            required_fields.join(", ")
        ));
    }
    lines.push(
        "必填关系：stopreason 必须是数字 0/1/2；stopreason=0 需要 has_evidence=1 且 evidence 非空；stopreason=1 需要 reason 非空；stopreason=2 必须写 next_step，下一轮只执行 next_step；needs_user_input=true 时 next_step 必须直接写要问用户的问题。".to_string(),
    );
    if let Some(values) = stopreason_values {
        let finished = values.get("finished").and_then(Value::as_i64).unwrap_or(0);
        let blocked = values.get("blocked").and_then(Value::as_i64).unwrap_or(1);
        let continue_needed = values
            .get("continueNeeded")
            .or_else(|| values.get("continue_needed"))
            .and_then(Value::as_i64)
            .unwrap_or(2);
        lines.push(format!(
            "stopreason 取值：{finished}=finished，{blocked}=blocked，{continue_needed}=continue_needed。"
        ));
    }
    if let Some(sample) = sample {
        lines.push(sample);
    }
    if lines.is_empty() {
        None
    } else {
        Some(lines.join("\n"))
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
                .filter_map(|item| read_trimmed_string(Some(item)))
                .collect::<Vec<String>>()
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

fn build_stop_hook_guidance_text_from_output(raw: &str) -> String {
    let trimmed = raw.trim();
    if let Some(row) = parse_stopless_tool_output_payload(&Value::String(trimmed.to_string())) {
        if is_stopless_tool_output_record(&row) {
            if let Some(prompt) = read_continue_next_step_prompt(&row) {
                return prompt;
            }
            let mut parts = Vec::<String>::new();
            let repeat_count = row
                .get("repeatCount")
                .and_then(Value::as_u64)
                .map(|value| value as u32)
                .unwrap_or(1);
            if let Some(snapshot) = read_stopless_tool_result_snapshot_text(&row) {
                parts.push(snapshot);
            }
            if let Some(schema_feedback) = read_stopless_schema_feedback_text(&row, repeat_count) {
                parts.push(schema_feedback);
            }
            if let Some(prompt) = read_trimmed_string(row.get("continuationPrompt"))
                .or_else(|| read_trimmed_string(row.get("continuation_prompt")))
            {
                parts.push(prompt);
            }
            if let Some(schema_guidance) = row
                .get("schemaGuidance")
                .or_else(|| row.get("schema_guidance"))
                .and_then(render_stopless_schema_guidance_text)
            {
                parts.push(schema_guidance);
            } else if let Some((reason_code, missing_fields)) =
                read_stopless_schema_feedback_context(&row)
            {
                let Some(trigger_hint) = derive_stopless_trigger_hint_from_reason(&reason_code)
                else {
                    parts.push(format!(
                        "STOPLESS_CLI_RESULT_MALFORMED: schemaFeedback.reasonCode={reason_code} 没有注册的修复引导；不能伪造默认 schema guidance。请重新运行 reasoningStop 生成合法 CLI 输出。"
                    ));
                    return parts.join("\n");
                };
                let guidance = serde_json::json!({
                    "triggerHint": trigger_hint,
                    "requiredFields": missing_fields,
                    "sample": "{\"stopreason\":2,\"reason\":\"当前状态\",\"current_goal\":\"当前目标\",\"has_evidence\":0,\"evidence\":\"\",\"next_step\":\"下一步动作\",\"needs_user_input\":false}",
                    "stopreasonValues": {
                        "finished": 0,
                        "blocked": 1,
                        "continueNeeded": 2
                    }
                });
                if let Some(schema_guidance) = render_stopless_schema_guidance_text(&guidance) {
                    parts.push(schema_guidance);
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
    let reason_code = read_trimmed_string(
        feedback
            .get("reasonCode")
            .or_else(|| feedback.get("reason_code")),
    )?;
    let missing_fields = feedback
        .get("missingFields")
        .or_else(|| feedback.get("missing_fields"))
        .and_then(Value::as_array)?
        .iter()
        .filter_map(|item| read_trimmed_string(Some(item)))
        .collect::<Vec<String>>();
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

fn is_stopless_guidance_message(entry: &Value) -> bool {
    let Some(row) = entry.as_object() else {
        return false;
    };
    if let Some(item_type) = row.get("type").and_then(Value::as_str) {
        if item_type != "message" {
            return false;
        }
    }
    if row.get("type").is_none() && !row.contains_key("content") {
        return false;
    }
    if row.get("role").and_then(Value::as_str) != Some("user") {
        return false;
    }
    let Some(text) = row.get("content").and_then(|content| {
        content.as_str().or_else(|| {
            let parts = content.as_array()?;
            if parts.len() != 1 {
                return None;
            }
            parts[0].get("text").and_then(Value::as_str)
        })
    }) else {
        return false;
    };
    text.contains("上一轮执行结果：repeatCount=")
        || text.contains("按下面 schema 补齐缺失字段")
        || text.contains("收尾时至少带上这些字段")
        || text.contains("stopreason")
            && (text.contains("finished")
                || text.contains("blocked")
                || text.contains("continue_needed")
                || text.contains("收尾时至少带上这些字段"))
}

fn collapse_auto_stop_hook_pairs_in_history(items: Vec<Value>) -> Vec<Value> {
    let stop_hook_call_ids: HashSet<String> = items
        .iter()
        .filter_map(Value::as_object)
        .filter(|row| is_stop_hook_function_call(row))
        .filter_map(read_bridge_function_call_id)
        .collect();
    let is_stop_hook_output_call = |row: &Map<String, Value>| -> Option<String> {
        let item_type = read_trimmed_string(row.get("type"))
            .unwrap_or_default()
            .to_ascii_lowercase();
        if !is_bridge_tool_output_item_type(item_type.as_str()) {
            return None;
        }
        let call_id = read_bridge_function_call_id(row)?;
        if !stop_hook_call_ids.contains(call_id.as_str()) {
            return None;
        }
        Some(call_id)
    };
    let completed_stopless_call_ids: HashSet<String> = items
        .iter()
        .filter_map(Value::as_object)
        .filter_map(is_stop_hook_output_call)
        .collect();
    let latest_stopless_call_id = items
        .iter()
        .rev()
        .filter_map(Value::as_object)
        .find_map(is_stop_hook_output_call);
    let latest_stopless_guidance = latest_stopless_call_id.as_ref().and_then(|latest_call_id| {
        items
            .iter()
            .rev()
            .filter_map(Value::as_object)
            .find_map(|row| {
                let item_type = read_trimmed_string(row.get("type"))
                    .unwrap_or_default()
                    .to_ascii_lowercase();
                if !is_bridge_tool_output_item_type(item_type.as_str()) {
                    return None;
                }
                let call_id = read_bridge_function_call_id(row)?;
                if call_id != *latest_call_id {
                    return None;
                }
                if !stop_hook_call_ids.contains(call_id.as_str()) {
                    return None;
                }
                let output = row.get("output")?;
                let output_text = match output {
                    Value::String(text) => text.clone(),
                    other => serde_json::to_string(other).ok()?,
                };
                Some(build_responses_text_guidance_input_item(
                    build_stop_hook_guidance_text_from_output(&output_text),
                ))
            })
    });
    let mut normalized = Vec::<Value>::with_capacity(items.len());
    let mut guidance_injected = false;
    let mut pending_stop_hook_call_id: Option<String> = None;
    for item in items {
        let Some(row) = item.as_object() else {
            normalized.push(item);
            continue;
        };
        if is_stopless_guidance_message(&item) {
            if latest_stopless_guidance.is_none() {
                normalized.push(item);
            }
            continue;
        }
        let item_type = read_trimmed_string(row.get("type"))
            .unwrap_or_default()
            .to_ascii_lowercase();
        if item_type == "function_call" || item_type == "tool_call" {
            let Some(call_id) = read_bridge_function_call_id(row) else {
                normalized.push(item);
                continue;
            };
            if completed_stopless_call_ids.contains(call_id.as_str()) {
                pending_stop_hook_call_id = Some(call_id);
                continue;
            }
            pending_stop_hook_call_id = if is_stop_hook_function_call(row) {
                Some(call_id.clone())
            } else {
                None
            };
            normalized.push(item);
            continue;
        }
        if item_type == "message"
            && row.get("role").and_then(Value::as_str) == Some("assistant")
            && pending_stop_hook_call_id.is_some()
        {
            continue;
        }
        if is_bridge_tool_output_item_type(item_type.as_str()) {
            let call_id = read_bridge_function_call_id(row).unwrap_or_default();
            let is_stop_hook_output = stop_hook_call_ids.contains(call_id.as_str());
            if is_stop_hook_output && completed_stopless_call_ids.contains(call_id.as_str()) {
                if !guidance_injected
                    && latest_stopless_call_id.as_deref() == Some(call_id.as_str())
                {
                    if let Some(guidance) = latest_stopless_guidance.clone() {
                        normalized.push(guidance);
                    }
                    guidance_injected = true;
                }
                if pending_stop_hook_call_id.as_deref() == Some(call_id.as_str()) {
                    pending_stop_hook_call_id = None;
                }
                continue;
            }
            if is_stop_hook_output
                && latest_stopless_call_id.as_deref() == Some(call_id.as_str())
                && !guidance_injected
            {
                if let Some(guidance) = latest_stopless_guidance.clone() {
                    normalized.push(guidance);
                }
                guidance_injected = true;
                if pending_stop_hook_call_id.as_deref() == Some(call_id.as_str()) {
                    pending_stop_hook_call_id = None;
                }
                continue;
            }
            if pending_stop_hook_call_id.as_deref() == Some(call_id.as_str()) {
                pending_stop_hook_call_id = None;
            }
        }
        normalized.push(item);
    }
    normalized
}

fn remove_auto_stop_hook_assistant_echoes_in_history(items: Vec<Value>) -> Vec<Value> {
    let mut normalized = Vec::<Value>::with_capacity(items.len());
    let mut pending_stop_hook_call_id: Option<String> = None;
    for item in items {
        let Some(row) = item.as_object() else {
            normalized.push(item);
            continue;
        };
        let item_type = read_trimmed_string(row.get("type"))
            .unwrap_or_default()
            .to_ascii_lowercase();
        if item_type == "function_call" || item_type == "tool_call" {
            pending_stop_hook_call_id = if is_stop_hook_function_call(row) {
                read_bridge_function_call_id(row)
            } else {
                None
            };
            normalized.push(item);
            continue;
        }
        if item_type == "message"
            && row.get("role").and_then(Value::as_str) == Some("assistant")
            && pending_stop_hook_call_id.is_some()
        {
            continue;
        }
        if is_bridge_tool_output_item_type(item_type.as_str()) {
            if let Some(call_id) = read_bridge_function_call_id(row) {
                if pending_stop_hook_call_id.as_deref() == Some(call_id.as_str()) {
                    pending_stop_hook_call_id = None;
                }
            }
        }
        normalized.push(item);
    }
    normalized
}

fn normalize_message_content_part_for_request_history(part: &Value) -> Option<Value> {
    let row = part.as_object()?;
    let part_type = row
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    match part_type.as_str() {
        "input_text" => Some(part.clone()),
        "output_text" | "text" | "commentary" => {
            let text = row
                .get("text")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())?;
            Some(serde_json::json!({
                "type": "input_text",
                "text": text,
            }))
        }
        "image_url" | "input_image" | "video_url" | "input_audio" | "file" => Some(part.clone()),
        _ => None,
    }
}

fn normalize_message_content_for_request_history(value: Option<&Value>) -> Vec<Value> {
    value
        .and_then(Value::as_array)
        .map(|parts| {
            parts
                .iter()
                .filter_map(normalize_message_content_part_for_request_history)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default()
}

fn normalize_output_item_to_input(item: &Value) -> Option<Value> {
    let row = item.as_object()?;
    let item_type = row
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();

    if item_type == "message" {
        let role = row
            .get("role")
            .and_then(Value::as_str)
            .unwrap_or("assistant")
            .to_string();
        let content = if row.get("content").is_some() {
            Value::Array(normalize_message_content_for_request_history(
                row.get("content"),
            ))
        } else {
            row.get("text")
                .and_then(Value::as_str)
                .map(|text| {
                    Value::Array(vec![
                        serde_json::json!({ "type": "input_text", "text": text }),
                    ])
                })
                .unwrap_or_else(|| Value::Array(Vec::new()))
        };
        return Some(serde_json::json!({
          "type": "message",
          "role": role,
          "content": content,
        }));
    }

    if item_type == "reasoning" {
        let mut out = Map::new();
        out.insert("type".to_string(), Value::String("reasoning".to_string()));
        if let Some(id) = read_trimmed_string(row.get("id")) {
            out.insert("id".to_string(), Value::String(id));
        }
        if let Some(summary) = row.get("summary").cloned() {
            out.insert("summary".to_string(), summary);
        }
        if let Some(encrypted_content) = row.get("encrypted_content").cloned() {
            out.insert("encrypted_content".to_string(), encrypted_content);
        }
        return Some(Value::Object(out));
    }

    if item_type == "function_call" {
        let raw_name = row
            .get("name")
            .and_then(Value::as_str)
            .or_else(|| {
                row.get("function")
                    .and_then(Value::as_object)
                    .and_then(|f| f.get("name"))
                    .and_then(Value::as_str)
            })
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty());
        let is_shell_like = raw_name
            .as_deref()
            .map(is_shell_like_function_name)
            .unwrap_or(false);
        let raw_arguments = row.get("arguments").or_else(|| {
            row.get("function")
                .and_then(Value::as_object)
                .and_then(|f| f.get("arguments"))
        });

        let mut normalized_shell_args: Option<Value> = None;
        if is_shell_like {
            let args = parse_arguments_record(raw_arguments)?;
            let serialized = build_shell_like_output_arguments(raw_name.as_deref(), &args)?;
            normalized_shell_args = Some(Value::String(serialized));
        }

        let call_id = row
            .get("call_id")
            .and_then(Value::as_str)
            .or_else(|| row.get("id").and_then(Value::as_str));
        let function_node = row
            .get("function")
            .and_then(Value::as_object)
            .cloned()
            .or_else(|| {
                row.get("name").and_then(Value::as_str).map(|name| {
                    let mut fn_node = Map::new();
                    fn_node.insert("name".to_string(), Value::String(name.to_string()));
                    if let Some(args) = normalized_shell_args
                        .as_ref()
                        .or_else(|| row.get("arguments"))
                    {
                        fn_node.insert("arguments".to_string(), args.clone());
                    }
                    fn_node
                })
            });
        let mut out = Map::new();
        out.insert(
            "type".to_string(),
            Value::String("function_call".to_string()),
        );
        if let Some(id) = row.get("id").and_then(Value::as_str) {
            out.insert("id".to_string(), Value::String(id.to_string()));
        }
        if let Some(call_id) = call_id {
            out.insert("call_id".to_string(), Value::String(call_id.to_string()));
        }
        if let Some(name) = row.get("name").and_then(Value::as_str) {
            out.insert("name".to_string(), Value::String(name.to_string()));
        }
        if let Some(arguments) = normalized_shell_args
            .as_ref()
            .or_else(|| row.get("arguments"))
        {
            out.insert("arguments".to_string(), arguments.clone());
        }
        return Some(Value::Object(out));
    }

    None
}

fn normalize_required_action_tool_call_to_input(call: &Value) -> Option<Value> {
    let row = call.as_object()?;
    let call_id = read_bridge_function_call_id(row)?;
    let function = row.get("function").and_then(Value::as_object);
    let name = read_trimmed_string(row.get("name"))
        .or_else(|| function.and_then(|node| read_trimmed_string(node.get("name"))))?;
    let arguments = row
        .get("arguments")
        .cloned()
        .or_else(|| function.and_then(|node| node.get("arguments").cloned()))
        .unwrap_or_else(|| Value::String("{}".to_string()));

    let mut out = Map::new();
    out.insert(
        "type".to_string(),
        Value::String("function_call".to_string()),
    );
    if let Some(id) = read_trimmed_string(row.get("id")) {
        out.insert("id".to_string(), Value::String(id));
    } else {
        out.insert("id".to_string(), Value::String(format!("fc_{}", call_id)));
    }
    out.insert("call_id".to_string(), Value::String(call_id));
    out.insert("name".to_string(), Value::String(name));
    out.insert("arguments".to_string(), arguments);
    Some(Value::Object(out))
}

fn convert_responses_output_to_input_items(response: &Value) -> Value {
    let output = response
        .as_object()
        .and_then(|row| row.get("output"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut items: Vec<Value> = Vec::new();
    for entry in output {
        if let Some(mapped) = normalize_output_item_to_input(&entry) {
            let item_type = mapped
                .as_object()
                .and_then(|row| row.get("type"))
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim()
                .to_ascii_lowercase();
            if item_type == "function_call" {
                items.push(mapped);
                continue;
            }
            items.push(mapped);
        }
    }
    if items.iter().all(|item| {
        item.as_object()
            .and_then(|row| row.get("type"))
            .and_then(Value::as_str)
            != Some("function_call")
    }) {
        if let Some(required_action) = response
            .as_object()
            .and_then(|row| row.get("required_action"))
            .and_then(Value::as_object)
        {
            if let Some(tool_calls) = required_action
                .get("submit_tool_outputs")
                .and_then(Value::as_object)
                .and_then(|submit| submit.get("tool_calls"))
                .and_then(Value::as_array)
            {
                for call in tool_calls {
                    if let Some(mapped) = normalize_required_action_tool_call_to_input(call) {
                        items.push(mapped);
                    }
                }
            }
        }
    }
    Value::Array(items)
}

fn clone_object(value: Option<&Value>) -> Map<String, Value> {
    value
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default()
}

fn clone_array(value: Option<&Value>) -> Vec<Value> {
    value.and_then(Value::as_array).cloned().unwrap_or_default()
}

fn clone_optional_array(value: Option<&Value>) -> Option<Vec<Value>> {
    value.and_then(Value::as_array).cloned()
}

fn stringify_responses_tool_output(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Null) | None => String::new(),
        Some(other) => {
            serde_json::to_string(other).unwrap_or_else(|_| "[object Object]".to_string())
        }
    }
}

fn responses_input_starts_with_tool_output(payload_obj: &Map<String, Value>) -> bool {
    let Some(input) = payload_obj.get("input").and_then(Value::as_array) else {
        return false;
    };
    let Some(first) = input.first().and_then(Value::as_object) else {
        return false;
    };
    first.get("type").and_then(Value::as_str) == Some("function_call_output")
}

fn normalize_responses_handler_submit_payload(
    payload_obj: &Map<String, Value>,
    response_id_from_path: Option<&str>,
) -> Result<(Option<String>, Value), String> {
    let response_id = read_trimmed_string(payload_obj.get("response_id"))
        .or_else(|| read_trimmed_string(payload_obj.get("previous_response_id")))
        .or_else(|| response_id_from_path.map(str::to_string));

    if response_id.is_some()
        && payload_obj
            .get("tool_outputs")
            .and_then(Value::as_array)
            .is_some()
    {
        let mut normalized = payload_obj.clone();
        if !normalized.contains_key("response_id") {
            if let Some(response_id) = response_id.as_ref() {
                normalized.insert(
                    "response_id".to_string(),
                    Value::String(response_id.clone()),
                );
            }
        }
        return Ok((response_id, Value::Object(normalized)));
    }

    let input = payload_obj
        .get("input")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut saw_function_call_output = false;
    let mut tool_outputs: Vec<Value> = Vec::new();

    for (index, item) in input.iter().enumerate() {
        let Some(row) = item.as_object() else {
            continue;
        };
        if row.get("type").and_then(Value::as_str) != Some("function_call_output") {
            continue;
        }
        saw_function_call_output = true;
        let Some(call_id) = read_trimmed_string(row.get("call_id"))
            .or_else(|| read_trimmed_string(row.get("tool_call_id")))
            .or_else(|| read_trimmed_string(row.get("id")))
        else {
            return Err(format!(
                "Responses function_call_output at input index {} is missing call_id/tool_call_id",
                index
            ));
        };
        tool_outputs.push(serde_json::json!({
            "tool_call_id": call_id,
            "output": stringify_responses_tool_output(row.get("output")),
        }));
    }

    if !saw_function_call_output {
        let mut normalized = payload_obj.clone();
        if !normalized.contains_key("response_id") {
            if let Some(response_id) = response_id.as_ref() {
                normalized.insert(
                    "response_id".to_string(),
                    Value::String(response_id.clone()),
                );
            }
        }
        return Ok((response_id, Value::Object(normalized)));
    }
    if tool_outputs.is_empty() {
        return Err(
            "Responses function_call_output resume payload produced no tool outputs".to_string(),
        );
    }
    let Some(response_id) = response_id else {
        return Err("Responses function_call_output resume payload requires response_id or previous_response_id".to_string());
    };

    let mut normalized = payload_obj.clone();
    normalized.insert(
        "response_id".to_string(),
        Value::String(response_id.clone()),
    );
    normalized.insert("tool_outputs".to_string(), Value::Array(tool_outputs));

    Ok((Some(response_id), Value::Object(normalized)))
}

fn materialize_provider_owned_submit_context(payload: &Value) -> Value {
    let Some(payload_obj) = payload.as_object() else {
        return Value::Null;
    };
    let Some(response_id) = read_trimmed_string(payload_obj.get("response_id")) else {
        return Value::Null;
    };
    let Some(tool_outputs) = payload_obj.get("tool_outputs").and_then(Value::as_array) else {
        return Value::Null;
    };

    let input = if payload_obj
        .get("input")
        .and_then(Value::as_array)
        .is_some_and(|items| !items.is_empty())
    {
        normalize_responses_history_items(clone_array(payload_obj.get("input")))
    } else {
        tool_outputs
            .iter()
            .filter_map(|item| {
                let row = item.as_object()?;
                let call_id = read_trimmed_string(row.get("call_id"))
                    .or_else(|| read_trimmed_string(row.get("tool_call_id")))
                    .or_else(|| read_trimmed_string(row.get("id")))?;
                Some(serde_json::json!({
                    "type": "function_call_output",
                    "call_id": call_id,
                    "output": stringify_responses_tool_output(row.get("output")),
                }))
            })
            .collect::<Vec<Value>>()
    };

    let mut normalized_payload = payload_obj.clone();
    normalized_payload.insert(
        "previous_response_id".to_string(),
        Value::String(response_id),
    );
    normalized_payload.insert("input".to_string(), Value::Array(input.clone()));

    serde_json::json!({
        "payload": Value::Object(normalized_payload),
        "context": {
            "input": input,
        }
    })
}

fn plan_responses_request_context(input: &Value) -> Value {
    let Some(input_obj) = input.as_object() else {
        return serde_json::json!({
            "kind": "error",
            "message": "Responses request context planner missing input"
        });
    };
    let payload = input_obj.get("payload").cloned().unwrap_or(Value::Null);
    let payload_for_persistence = strip_request_metadata_from_payload(&payload);
    let payload_obj = payload_for_persistence
        .as_object()
        .cloned()
        .unwrap_or_default();
    let resume_meta = input_obj.get("resumeMeta").and_then(Value::as_object);
    let continuation_owner =
        resume_meta.and_then(|meta| read_trimmed_string(meta.get("continuationOwner")));
    let relay_full_input = resume_meta
        .and_then(|meta| meta.get("fullInput"))
        .and_then(Value::as_array)
        .cloned();
    let relay_tools = resume_meta
        .and_then(|meta| meta.get("restoredTools"))
        .and_then(Value::as_array)
        .cloned();
    let is_relay = continuation_owner.as_deref() == Some("relay");
    let has_provider_owned_submit = read_trimmed_string(payload_obj.get("response_id")).is_some()
        && payload_obj
            .get("tool_outputs")
            .and_then(Value::as_array)
            .is_some_and(|items| !items.is_empty());
    let has_materialized_relay_submit =
        read_trimmed_string(payload_obj.get("previous_response_id")).is_some()
            && payload_obj
                .get("input")
                .and_then(Value::as_array)
                .is_some_and(|items| !items.is_empty())
            && relay_full_input
                .as_ref()
                .is_some_and(|items| !items.is_empty());

    if is_relay
        && has_provider_owned_submit
        && relay_full_input
            .as_ref()
            .is_some_and(|items| !items.is_empty())
    {
        let mut relay_payload = payload_obj;
        if let Some(response_id) =
            resume_meta.and_then(|meta| read_trimmed_string(meta.get("responseId")))
        {
            relay_payload.insert(
                "previous_response_id".to_string(),
                Value::String(response_id),
            );
        }
        relay_payload.insert(
            "input".to_string(),
            Value::Array(relay_full_input.unwrap_or_default()),
        );
        if let Some(tools) = relay_tools.filter(|items| !items.is_empty()) {
            relay_payload.insert("tools".to_string(), Value::Array(tools));
        }
        relay_payload.remove("response_id");
        relay_payload.remove("tool_outputs");
        return serde_json::json!({
            "kind": "capture_request",
            "payload": Value::Object(relay_payload),
        });
    }

    if is_relay && has_materialized_relay_submit {
        let mut relay_payload = payload_obj;
        relay_payload.insert(
            "input".to_string(),
            Value::Array(relay_full_input.unwrap_or_default()),
        );
        if let Some(tools) = relay_tools.filter(|items| !items.is_empty()) {
            relay_payload.insert("tools".to_string(), Value::Array(tools));
        }
        return serde_json::json!({
            "kind": "capture_request",
            "payload": Value::Object(relay_payload),
        });
    }

    if has_provider_owned_submit {
        let materialized = materialize_provider_owned_submit_context(&payload_for_persistence);
        if materialized.is_null() {
            return serde_json::json!({
                "kind": "error",
                "message": "Responses provider-owned submit_tool_outputs context materialization failed"
            });
        }
        return serde_json::json!({
            "kind": "context",
            "payload": materialized.get("payload").cloned().unwrap_or(Value::Null),
            "context": materialized.get("context").cloned().unwrap_or(Value::Null),
        });
    }

    serde_json::json!({
        "kind": "capture_request",
        "payload": payload_for_persistence,
    })
}

fn strip_request_metadata_from_payload(payload: &Value) -> Value {
    let Some(record) = payload.as_object() else {
        return payload.clone();
    };
    let mut out = record.clone();
    out.remove("metadata");
    Value::Object(out)
}

fn plan_responses_continuation_request_action(input: &Value) -> Value {
    let input_obj = input.as_object().cloned().unwrap_or_default();
    let planned_entry_mode = read_trimmed_string(input_obj.get("plannedEntryMode"))
        .unwrap_or_else(|| "none".to_string());
    let entry_endpoint = read_trimmed_string(input_obj.get("entryEndpoint"))
        .unwrap_or_else(|| "/v1/responses".to_string());
    let response_id = read_trimmed_string(input_obj.get("responseId"));
    let previous_response_id = read_trimmed_string(input_obj.get("previousResponseId"));
    let continuation = input_obj.get("continuation").and_then(Value::as_object);
    let continuation_owner = continuation
        .and_then(|row| read_trimmed_string(row.get("continuationOwner")))
        .filter(|owner| owner == "direct" || owner == "relay");
    let provider_key = continuation.and_then(|row| read_trimmed_string(row.get("providerKey")));
    let previous_request_id =
        continuation.and_then(|row| read_trimmed_string(row.get("requestId")));

    let build_resume_meta = |id: &str, owner: &str, restored: bool| {
        let mut meta = Map::new();
        meta.insert("responseId".to_string(), Value::String(id.to_string()));
        meta.insert("restored".to_string(), Value::Bool(restored));
        meta.insert(
            "continuationOwner".to_string(),
            Value::String(owner.to_string()),
        );
        if let Some(provider_key) = provider_key.clone() {
            meta.insert("providerKey".to_string(), Value::String(provider_key));
        }
        if let Some(previous_request_id) = previous_request_id.clone() {
            meta.insert(
                "previousRequestId".to_string(),
                Value::String(previous_request_id),
            );
        }
        Value::Object(meta)
    };

    if planned_entry_mode == "submit_tool_outputs" {
        let Some(response_id) = response_id else {
            return serde_json::json!({
                "action": "client_error",
                "status": 400,
                "code": "bad_request",
                "origin": "client",
                "message": "response_id is required for submit_tool_outputs"
            });
        };
        if continuation_owner.as_deref() == Some("direct") {
            return serde_json::json!({
                "action": "direct_submit",
                "responseId": response_id,
                "pipelineEntryEndpoint": entry_endpoint,
                "resumeMeta": build_resume_meta(&response_id, "direct", false),
                "materializeProviderOwnedSubmitContext": true
            });
        }
        return serde_json::json!({
            "action": "relay_submit",
            "responseId": response_id,
            "pipelineEntryEndpoint": "/v1/responses"
        });
    }

    if entry_endpoint == "/v1/responses" {
        if let Some(previous_response_id) = previous_response_id.as_deref() {
            if continuation_owner.as_deref() == Some("relay")
                && planned_entry_mode == "scope_materialize"
            {
                return serde_json::json!({
                    "action": "relay_scope_materialize",
                    "responseId": previous_response_id,
                    "pipelineEntryEndpoint": entry_endpoint,
                    "continuationOwner": "relay"
                });
            }
            if let Some(owner) = continuation_owner.as_deref() {
                return serde_json::json!({
                    "action": "attach_resume_meta",
                    "responseId": previous_response_id,
                    "pipelineEntryEndpoint": entry_endpoint,
                    "resumeMeta": build_resume_meta(previous_response_id, owner, false)
                });
            }
        }
    }

    if planned_entry_mode == "scope_materialize" {
        return serde_json::json!({
            "action": "scope_materialize",
            "pipelineEntryEndpoint": entry_endpoint
        });
    }

    serde_json::json!({
        "action": "none",
        "pipelineEntryEndpoint": entry_endpoint
    })
}

fn plan_responses_handler_entry(
    payload: &Value,
    entry_endpoint: Option<&str>,
    response_id_from_path: Option<&str>,
) -> Result<Value, String> {
    let Some(payload_obj) = payload.as_object() else {
        return Ok(serde_json::json!({ "mode": "none", "payload": {} }));
    };
    let endpoint = entry_endpoint.unwrap_or("/v1/responses");
    let is_submit_endpoint = endpoint == "/v1/responses.submit_tool_outputs";
    let is_submit_payload = endpoint == "/v1/responses"
        && read_trimmed_string(payload_obj.get("response_id")).is_some()
        && payload_obj
            .get("tool_outputs")
            .and_then(Value::as_array)
            .is_some();
    let is_previous_response_tool_output = endpoint == "/v1/responses"
        && read_trimmed_string(payload_obj.get("previous_response_id")).is_some()
        && payload_obj
            .get("input")
            .and_then(Value::as_array)
            .is_some_and(|input| {
                input.iter().any(|item| {
                    item.as_object()
                        .and_then(|row| row.get("type"))
                        .and_then(Value::as_str)
                        == Some("function_call_output")
                })
            });

    if is_submit_endpoint || is_submit_payload || is_previous_response_tool_output {
        let (response_id, normalized_payload) =
            normalize_responses_handler_submit_payload(payload_obj, response_id_from_path)?;
        return Ok(serde_json::json!({
            "mode": "submit_tool_outputs",
            "responseId": response_id.map(Value::String).unwrap_or(Value::Null),
            "payload": normalized_payload,
        }));
    }

    if endpoint == "/v1/responses" && responses_input_starts_with_tool_output(payload_obj) {
        return Ok(serde_json::json!({
            "mode": "scope_materialize",
            "payload": payload,
        }));
    }

    Ok(serde_json::json!({ "mode": "none", "payload": payload }))
}

fn normalize_submitted_tool_outputs(
    tool_outputs: &[Value],
    merged_input: &[Value],
) -> Result<(Vec<Value>, Vec<Value>), String> {
    let mut call_id_to_function_item_id: Map<String, Value> = Map::new();
    for item in merged_input {
        let Some(row) = item.as_object() else {
            continue;
        };
        let item_type = row.get("type").and_then(Value::as_str).unwrap_or("");
        if item_type != "function_call" {
            continue;
        }
        let id = read_trimmed_string(row.get("id"));
        let call_id = read_trimmed_string(row.get("call_id"));
        if let Some(id_value) = id.clone() {
            call_id_to_function_item_id.insert(id_value.clone(), Value::String(id_value));
        }
        if let Some(call_id_value) = call_id {
            let mapped = id.clone().unwrap_or_else(|| call_id_value.clone());
            call_id_to_function_item_id.insert(call_id_value, Value::String(mapped));
        }
    }

    let mut items: Vec<Value> = Vec::new();
    let mut submitted: Vec<Value> = Vec::new();

    for (index, entry) in tool_outputs.iter().enumerate() {
        let Some(row) = entry.as_object() else {
            continue;
        };

        let raw_id = read_trimmed_string(row.get("tool_call_id"))
            .or_else(|| read_trimmed_string(row.get("call_id")))
            .or_else(|| read_trimmed_string(row.get("id")));
        let call_id = raw_id.clone();

        let mapped_item_id = call_id
            .as_ref()
            .and_then(|resolved_call_id| call_id_to_function_item_id.get(resolved_call_id))
            .and_then(Value::as_str)
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty());

        let output_id = if let Some(mapped) = mapped_item_id {
            normalize_function_call_output_id(Some(mapped.as_str()), mapped.as_str())
        } else if let Some(resolved_call_id) = call_id.as_ref() {
            return Err(format!(
                "Responses tool output id '{}' does not match any pending function_call in previous_response_id context",
                resolved_call_id
            ));
        } else {
            return Err(format!(
                "Responses tool output at index {} is missing tool_call_id/call_id",
                index
            ));
        };

        let output_text = stringify_responses_tool_output(row.get("output"));

        let mut item = Map::new();
        item.insert(
            "type".to_string(),
            Value::String("function_call_output".to_string()),
        );
        item.insert("id".to_string(), Value::String(output_id));
        if let Some(resolved_call_id) = call_id.clone() {
            item.insert("call_id".to_string(), Value::String(resolved_call_id));
        }
        item.insert("output".to_string(), Value::String(output_text.clone()));
        items.push(Value::Object(item));

        submitted.push(serde_json::json!({
            "callId": call_id.clone(),
            "originalId": raw_id.clone(),
            "outputText": output_text,
        }));
    }

    Ok((items, submitted))
}

fn prepare_responses_conversation_entry(payload: &Value, context: &Value) -> Value {
    let mut base_payload = clone_responses_context_body(payload);

    if let Some(model) = read_trimmed_string(payload.as_object().and_then(|row| row.get("model"))) {
        base_payload.insert("model".to_string(), Value::String(model));
    }
    if let Some(stream) = payload
        .as_object()
        .and_then(|row| row.get("stream"))
        .and_then(Value::as_bool)
    {
        base_payload.insert("stream".to_string(), Value::Bool(stream));
    }

    let input = collapse_auto_stop_hook_pairs_in_history(normalize_responses_history_items(
        clone_array(context.as_object().and_then(|row| row.get("input"))),
    ));
    let tools = normalize_responses_tool_definitions(
        payload
            .as_object()
            .and_then(|row| row.get("tools"))
            .or_else(|| context.as_object().and_then(|row| row.get("toolsRaw"))),
    );

    let provider_key_value = read_trimmed_string(
        context
            .as_object()
            .and_then(|row| row.get("providerKey"))
            .or_else(|| payload.as_object().and_then(|row| row.get("providerKey"))),
    )
    .map(Value::String)
    .unwrap_or(Value::Null);

    let mut entry = Map::new();
    entry.insert("basePayload".to_string(), Value::Object(base_payload));
    entry.insert("input".to_string(), Value::Array(input));
    entry.insert("providerKey".to_string(), provider_key_value);
    if !tools.is_empty()
        && !entry
            .get("basePayload")
            .and_then(Value::as_object)
            .is_some_and(|row| row.contains_key("tools"))
    {
        entry.insert("tools".to_string(), Value::Array(tools));
    }

    Value::Object(entry)
}

fn responses_scope_token(value: Option<&Value>) -> Option<String> {
    read_trimmed_string(value)
}

fn responses_entry_kind(value: Option<&Value>) -> String {
    match responses_scope_token(value).as_deref() {
        Some("chat") => "chat".to_string(),
        Some("messages") => "messages".to_string(),
        _ => "responses".to_string(),
    }
}

fn responses_continuation_owner(value: Option<&Value>) -> Option<String> {
    match responses_scope_token(value).as_deref() {
        Some("direct") => Some("direct".to_string()),
        Some("relay") => Some("relay".to_string()),
        _ => None,
    }
}

fn responses_port_scope_key(scope: &Map<String, Value>) -> Option<String> {
    if let Some(port_scope_key) = responses_scope_token(scope.get("portScopeKey")) {
        return Some(port_scope_key);
    }
    if let Some(port) = scope.get("matchedPort").and_then(Value::as_i64) {
        if port > 0 {
            return Some(format!("port:{}", port));
        }
    }
    responses_scope_token(scope.get("routingPolicyGroup")).map(|group| format!("group:{}", group))
}

fn responses_qualify_scope_key(port_scope_key: Option<&str>, key: String) -> String {
    match port_scope_key {
        Some(port_scope_key) if !port_scope_key.trim().is_empty() => {
            format!("{}|{}", port_scope_key.trim(), key)
        }
        _ => key,
    }
}

fn responses_build_stored_scope_keys_from_resolved(
    session_id: Option<String>,
    conversation_id: Option<String>,
    entry_kind: &str,
    continuation_owner: &str,
    port_scope_key: Option<&str>,
) -> Vec<String> {
    let mut keys: Vec<String> = Vec::new();
    if let Some(session_id) = session_id {
        keys.push(responses_qualify_scope_key(
            port_scope_key,
            format!(
                "entry:{}|owner:{}|session:{}",
                entry_kind, continuation_owner, session_id
            ),
        ));
    }
    if let Some(conversation_id) = conversation_id {
        keys.push(responses_qualify_scope_key(
            port_scope_key,
            format!(
                "entry:{}|owner:{}|conversation:{}",
                entry_kind, continuation_owner, conversation_id
            ),
        ));
    }
    keys.sort();
    keys.dedup();
    keys
}

fn responses_build_requested_scope_keys(scope: &Map<String, Value>) -> Vec<String> {
    let entry_kind = responses_entry_kind(scope.get("entryKind"));
    let owners: Vec<String> = match responses_continuation_owner(scope.get("continuationOwner")) {
        Some(owner) => vec![owner],
        None => vec!["direct".to_string(), "relay".to_string()],
    };
    let session_id = responses_scope_token(scope.get("sessionId"));
    let conversation_id = responses_scope_token(scope.get("conversationId"));
    let port_scope_key = responses_port_scope_key(scope);
    let mut keys = Vec::new();
    for owner in owners {
        keys.extend(responses_build_stored_scope_keys_from_resolved(
            session_id.clone(),
            conversation_id.clone(),
            &entry_kind,
            &owner,
            port_scope_key.as_deref(),
        ));
    }
    keys.sort();
    keys.dedup();
    keys
}

fn responses_read_submit_payload_scope_value<'a>(
    payload: &'a Map<String, Value>,
    metadata: Option<&'a Map<String, Value>>,
    direct_keys: &[&str],
    metadata_keys: &[&str],
) -> Option<String> {
    for key in direct_keys {
        if let Some(value) = responses_scope_token(payload.get(*key)) {
            return Some(value);
        }
    }
    if let Some(metadata) = metadata {
        for key in metadata_keys {
            if let Some(value) = responses_scope_token(metadata.get(*key)) {
                return Some(value);
            }
        }
    }
    None
}

fn responses_read_resume_scope_keys_from_submit_payload(payload: &Value) -> Vec<String> {
    let Some(payload_obj) = payload.as_object() else {
        return Vec::new();
    };
    let metadata = payload_obj.get("metadata").and_then(Value::as_object);
    let port_context = metadata
        .and_then(|row| row.get("portContext"))
        .and_then(Value::as_object);
    let session_id = responses_read_submit_payload_scope_value(
        payload_obj,
        metadata,
        &["session_id", "sessionId"],
        &["session_id", "sessionId"],
    );
    let conversation_id = responses_read_submit_payload_scope_value(
        payload_obj,
        metadata,
        &["conversation_id", "conversationId"],
        &["conversation_id", "conversationId"],
    );
    let continuation_owner = responses_read_submit_payload_scope_value(
        payload_obj,
        metadata,
        &["continuationOwner"],
        &["continuationOwner"],
    )
    .or_else(|| {
        metadata
            .and_then(|row| row.get("responsesResume"))
            .and_then(Value::as_object)
            .and_then(|row| responses_scope_token(row.get("continuationOwner")))
    });

    let mut scope = Map::new();
    if let Some(session_id) = session_id {
        scope.insert("sessionId".to_string(), Value::String(session_id));
    }
    if let Some(conversation_id) = conversation_id {
        scope.insert("conversationId".to_string(), Value::String(conversation_id));
    }
    if let Some(continuation_owner) = continuation_owner {
        scope.insert(
            "continuationOwner".to_string(),
            Value::String(continuation_owner),
        );
    }
    if let Some(value) = metadata
        .and_then(|row| row.get("matchedPort"))
        .or_else(|| port_context.and_then(|row| row.get("matchedPort")))
    {
        scope.insert("matchedPort".to_string(), value.clone());
    }
    if let Some(value) = metadata
        .and_then(|row| row.get("routingPolicyGroup"))
        .or_else(|| port_context.and_then(|row| row.get("routingPolicyGroup")))
    {
        scope.insert("routingPolicyGroup".to_string(), value.clone());
    }
    scope.insert(
        "entryKind".to_string(),
        Value::String("responses".to_string()),
    );
    responses_build_requested_scope_keys(&scope)
}

fn build_responses_conversation_scope_plan(input: &Value) -> Value {
    let obj = input.as_object().cloned().unwrap_or_default();
    let mode = responses_scope_token(obj.get("mode")).unwrap_or_default();
    let scope_obj = obj
        .get("scope")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let port_scope_key = responses_port_scope_key(&scope_obj);
    let keys = match mode.as_str() {
        "stored" => {
            let entry_kind = responses_entry_kind(scope_obj.get("entryKind"));
            let continuation_owner =
                responses_continuation_owner(scope_obj.get("continuationOwner"))
                    .unwrap_or_else(|| "relay".to_string());
            responses_build_stored_scope_keys_from_resolved(
                responses_scope_token(scope_obj.get("sessionId")),
                responses_scope_token(scope_obj.get("conversationId")),
                &entry_kind,
                &continuation_owner,
                port_scope_key.as_deref(),
            )
        }
        "requested" => responses_build_requested_scope_keys(&scope_obj),
        "submit_payload" => responses_read_resume_scope_keys_from_submit_payload(
            obj.get("payload").unwrap_or(&Value::Null),
        ),
        _ => Vec::new(),
    };
    serde_json::json!({
        "keys": keys,
        "portScopeKey": port_scope_key,
    })
}

const RESPONSES_STORE_TTL_MS: i64 = 1000 * 60 * 30;
const RESPONSES_STORE_PERSIST_SCHEMA_VERSION: i64 = 1;

#[derive(Default)]
struct ResponsesConversationStoreState {
    request_map: HashMap<String, Value>,
    response_index: HashMap<String, String>,
    scope_index: HashMap<String, String>,
    last_prune_at: i64,
    persistence_loaded: bool,
    persistence_file_path: Option<PathBuf>,
}

static RESPONSES_CONVERSATION_STORE: LazyLock<Mutex<ResponsesConversationStoreState>> =
    LazyLock::new(|| Mutex::new(ResponsesConversationStoreState::default()));

fn responses_store_now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

fn responses_store_persist_file_path() -> PathBuf {
    if let Ok(explicit) = env::var("ROUTECODEX_RESPONSES_CONVERSATION_STORE") {
        let trimmed = explicit.trim();
        if !trimmed.is_empty() {
            return PathBuf::from(trimmed);
        }
    }
    let home = env::var("ROUTECODEX_HOME")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .or_else(dirs::home_dir)
        .unwrap_or_else(|| PathBuf::from(".rcc"));
    let root = if env::var("ROUTECODEX_HOME")
        .ok()
        .map(|value| !value.trim().is_empty())
        .unwrap_or(false)
    {
        home
    } else {
        home.join(".rcc")
    };
    root.join("state").join("responses-conversation-store.json")
}

fn responses_store_ok(result: Value) -> Value {
    serde_json::json!({
        "ok": true,
        "result": result,
    })
}

fn responses_store_error(code: &str, message: &str, category: &str, details: Value) -> Value {
    serde_json::json!({
        "ok": false,
        "error": {
            "code": code,
            "message": message,
            "protocol": "openai-responses",
            "providerType": "responses",
            "category": category,
            "details": details,
        }
    })
}

fn responses_store_malformed_request(message: &str, reason: &str, details: Value) -> Value {
    let mut detail_obj = details.as_object().cloned().unwrap_or_default();
    detail_obj.insert("reason".to_string(), Value::String(reason.to_string()));
    responses_store_error(
        "MALFORMED_REQUEST",
        message,
        "EXTERNAL_ERROR",
        Value::Object(detail_obj),
    )
}

fn responses_store_malformed_response(message: &str, reason: &str, details: Value) -> Value {
    let mut detail_obj = details.as_object().cloned().unwrap_or_default();
    detail_obj.insert("reason".to_string(), Value::String(reason.to_string()));
    responses_store_error(
        "MALFORMED_RESPONSE",
        message,
        "EXTERNAL_ERROR",
        Value::Object(detail_obj),
    )
}

fn responses_store_read_entry_request_id(entry: &Value) -> Option<String> {
    entry
        .as_object()
        .and_then(|row| read_trimmed_string(row.get("requestId")))
}

fn responses_store_read_entry_last_response_id(entry: &Value) -> Option<String> {
    entry
        .as_object()
        .and_then(|row| read_trimmed_string(row.get("lastResponseId")))
}

fn responses_store_read_entry_scope_keys(entry: &Value) -> Vec<String> {
    entry.as_object().map(read_scope_keys).unwrap_or_default()
}

fn responses_store_set_value(entry: &mut Value, key: &str, value: Value) {
    if let Some(row) = entry.as_object_mut() {
        row.insert(key.to_string(), value);
    }
}

fn responses_store_set_string(entry: &mut Value, key: &str, value: Option<String>) {
    if let Some(value) = value {
        responses_store_set_value(entry, key, Value::String(value));
    }
}

fn responses_store_tokens(input: Value) -> Map<String, Value> {
    plan_responses_store_tokens(&input)
        .as_object()
        .cloned()
        .unwrap_or_default()
}

fn responses_store_build_scope_keys(scope: Value, mode: &str) -> (Vec<String>, Option<String>) {
    let plan = build_responses_conversation_scope_plan(&serde_json::json!({
        "mode": mode,
        "scope": scope,
    }));
    let keys = plan
        .as_object()
        .and_then(|row| row.get("keys"))
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| read_trimmed_string(Some(item)))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let port_scope_key = plan
        .as_object()
        .and_then(|row| read_trimmed_string(row.get("portScopeKey")));
    (keys, port_scope_key)
}

fn responses_store_read_port_scope_key(scope: &Value) -> Option<String> {
    responses_store_build_scope_keys(scope.clone(), "stored").1
}

fn responses_store_build_stored_scope_keys_from_resolved(
    session_id: Option<String>,
    conversation_id: Option<String>,
    entry_kind: String,
    continuation_owner: String,
    port_scope_key: Option<String>,
) -> Vec<String> {
    let mut scope = Map::new();
    if let Some(session_id) = session_id {
        scope.insert("sessionId".to_string(), Value::String(session_id));
    }
    if let Some(conversation_id) = conversation_id {
        scope.insert("conversationId".to_string(), Value::String(conversation_id));
    }
    scope.insert("entryKind".to_string(), Value::String(entry_kind));
    scope.insert(
        "continuationOwner".to_string(),
        Value::String(continuation_owner),
    );
    if let Some(port_scope_key) = port_scope_key {
        scope.insert("portScopeKey".to_string(), Value::String(port_scope_key));
    }
    responses_store_build_scope_keys(Value::Object(scope), "stored").0
}

fn responses_store_resume_scope_keys_from_submit_payload(payload: &Value) -> Vec<String> {
    build_responses_conversation_scope_plan(&serde_json::json!({
        "mode": "submit_payload",
        "payload": payload,
    }))
    .as_object()
    .and_then(|row| row.get("keys"))
    .and_then(Value::as_array)
    .map(|items| {
        items
            .iter()
            .filter_map(|item| read_trimmed_string(Some(item)))
            .collect::<Vec<_>>()
    })
    .unwrap_or_default()
}

fn responses_store_project_resume_candidate(
    entry: &Value,
    source: &str,
    scope_key: Option<&str>,
) -> Value {
    let entry_obj = entry.as_object().cloned().unwrap_or_default();
    let tokens = responses_store_tokens(serde_json::json!({
        "entryKind": entry_obj.get("entryKind").cloned().unwrap_or(Value::Null),
        "continuationOwner": entry_obj.get("continuationOwner").cloned().unwrap_or(Value::Null),
    }));
    serde_json::json!({
        "source": source,
        "scopeKey": scope_key.unwrap_or(""),
        "requestId": read_trimmed_string(entry_obj.get("requestId")),
        "lastResponseId": read_trimmed_string(entry_obj.get("lastResponseId")),
        "allowContinuation": entry_obj.get("allowContinuation").and_then(Value::as_bool).unwrap_or(false),
        "continuationOwner": tokens.get("continuationOwner").cloned().unwrap_or(Value::Null),
        "portScopeKey": entry_obj.get("portScopeKey").cloned().unwrap_or(Value::Null),
        "entryKind": tokens.get("entryKind").cloned().unwrap_or(Value::String("responses".to_string())),
    })
}

fn responses_store_merge_meta(meta: Value, entry: &Value) -> Value {
    plan_responses_continuation_meta(&serde_json::json!({
        "meta": meta,
        "entry": entry,
    }))
    .as_object()
    .and_then(|row| row.get("meta"))
    .cloned()
    .unwrap_or_else(|| Value::Object(Map::new()))
}

impl ResponsesConversationStoreState {
    fn ensure_persistence_loaded(&mut self) {
        if self.persistence_loaded {
            return;
        }
        self.persistence_loaded = true;
        let persist_file_path = self.persist_file_path();
        let Ok(raw) = fs::read_to_string(&persist_file_path) else {
            return;
        };
        let Ok(parsed) = serde_json::from_str::<Value>(&raw) else {
            return;
        };
        let Some(root) = parsed.as_object() else {
            return;
        };
        if root.get("version").and_then(Value::as_i64)
            != Some(RESPONSES_STORE_PERSIST_SCHEMA_VERSION)
        {
            return;
        }
        let Some(entries) = root.get("entries").and_then(Value::as_array) else {
            return;
        };
        let now_ms = responses_store_now_ms();
        for row in entries {
            let plan = plan_responses_persisted_entry(&serde_json::json!({
                "mode": "deserialize",
                "entry": row,
                "nowMs": now_ms,
            }));
            let Some(entry) = plan.as_object().and_then(|plan| plan.get("entry")).cloned() else {
                continue;
            };
            let eligibility = plan_responses_conversation_persistence_eligibility(
                &entry,
                &serde_json::json!({
                    "mode": "load",
                    "nowMs": now_ms,
                    "ttlMs": RESPONSES_STORE_TTL_MS,
                }),
            );
            let Some(last_response_id) = eligibility
                .as_object()
                .and_then(|row| read_trimmed_string(row.get("lastResponseId")))
            else {
                continue;
            };
            if eligibility
                .as_object()
                .and_then(|row| read_trimmed_string(row.get("action")))
                .as_deref()
                != Some("persist")
            {
                continue;
            }
            let Some(request_id) = responses_store_read_entry_request_id(&entry) else {
                continue;
            };
            self.request_map.insert(request_id.clone(), entry);
            self.response_index
                .insert(last_response_id, request_id.clone());
            self.attach_entry_scopes_by_request_id(&request_id);
        }
    }

    fn flush_persistence(&self) {
        if !self.persistence_loaded {
            return;
        }
        let mut entries = Vec::new();
        let mut seen = HashSet::new();
        for request_id in self.response_index.values() {
            if !seen.insert(request_id.clone()) {
                continue;
            }
            let Some(entry) = self.request_map.get(request_id) else {
                continue;
            };
            let eligibility = plan_responses_conversation_persistence_eligibility(
                entry,
                &serde_json::json!({
                    "mode": "flush",
                }),
            );
            if eligibility
                .as_object()
                .and_then(|row| read_trimmed_string(row.get("action")))
                .as_deref()
                != Some("persist")
            {
                continue;
            }
            let serialized = plan_responses_persisted_entry(&serde_json::json!({
                "mode": "serialize",
                "entry": entry,
            }));
            if let Some(entry) = serialized
                .as_object()
                .and_then(|row| row.get("entry"))
                .cloned()
            {
                entries.push(entry);
            }
        }
        let persist_file_path = self.persist_file_path();
        if let Some(parent) = persist_file_path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        let tmp_file = persist_file_path.with_extension(format!("{}.tmp", std::process::id()));
        let payload = serde_json::json!({
            "version": RESPONSES_STORE_PERSIST_SCHEMA_VERSION,
            "entries": entries,
        });
        if let Ok(raw) = serde_json::to_string_pretty(&payload) {
            if fs::write(&tmp_file, raw).is_ok() {
                let _ = fs::rename(&tmp_file, &persist_file_path);
            }
        }
    }

    fn debug_stats(&self) -> Value {
        let mut request_entries_without_last_response_id = 0usize;
        let mut retained_input_items = 0usize;
        for entry in self.request_map.values() {
            if responses_store_read_entry_last_response_id(entry).is_none() {
                request_entries_without_last_response_id += 1;
            }
            retained_input_items += entry
                .as_object()
                .and_then(|row| row.get("input"))
                .and_then(Value::as_array)
                .map(Vec::len)
                .unwrap_or(0);
        }
        serde_json::json!({
            "requestMapSize": self.request_map.len(),
            "responseIndexSize": self.response_index.len(),
            "scopeIndexSize": self.scope_index.len(),
            "requestEntriesWithoutLastResponseId": request_entries_without_last_response_id,
            "retainedInputItems": retained_input_items,
        })
    }

    fn persist_file_path(&self) -> PathBuf {
        self.persistence_file_path
            .clone()
            .unwrap_or_else(responses_store_persist_file_path)
    }

    fn apply_operation_context(&mut self, input: &Value) {
        let next_path = input
            .as_object()
            .and_then(|row| read_trimmed_string(row.get("persistenceFilePath")))
            .map(PathBuf::from);
        if next_path == self.persistence_file_path {
            return;
        }
        self.request_map.clear();
        self.response_index.clear();
        self.scope_index.clear();
        self.persistence_loaded = false;
        self.persistence_file_path = next_path;
    }

    fn detach_request_id(&mut self, request_id: &str) {
        self.request_map.remove(request_id);
        self.response_index
            .retain(|_, candidate_request_id| candidate_request_id != request_id);
        self.scope_index
            .retain(|_, candidate_request_id| candidate_request_id != request_id);
    }

    fn prune_indexes(&mut self) {
        self.response_index
            .retain(|_, request_id| self.request_map.contains_key(request_id));
        self.scope_index
            .retain(|_, request_id| self.request_map.contains_key(request_id));
    }

    fn attach_entry_scopes_by_request_id(&mut self, request_id: &str) {
        let Some(entry) = self.request_map.get(request_id).cloned() else {
            return;
        };
        let scope_keys = responses_store_read_entry_scope_keys(&entry);
        let candidates = scope_keys
            .iter()
            .map(|scope_key| {
                serde_json::json!({
                    "scopeKey": scope_key,
                    "requestId": self.scope_index.get(scope_key).cloned().unwrap_or_default(),
                })
            })
            .collect::<Vec<_>>();
        let plan = plan_responses_attach_entry_scopes(&serde_json::json!({
            "requestId": request_id,
            "scopeKeys": scope_keys,
            "candidates": candidates,
        }));
        let detach_request_ids = plan
            .as_object()
            .and_then(|row| row.get("detachRequestIds"))
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter_map(|item| read_trimmed_string(Some(item)))
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        for detach_request_id in detach_request_ids {
            self.detach_request_id(&detach_request_id);
        }
        let attach_scope_keys = plan
            .as_object()
            .and_then(|row| row.get("scopeKeys"))
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter_map(|item| read_trimmed_string(Some(item)))
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        for scope_key in attach_scope_keys {
            self.scope_index.insert(scope_key, request_id.to_string());
        }
    }

    fn prune_expired(&mut self) -> usize {
        self.ensure_persistence_loaded();
        self.last_prune_at = responses_store_now_ms();
        let candidates = self
            .request_map
            .values()
            .map(|entry| {
                let row = entry.as_object().cloned().unwrap_or_default();
                serde_json::json!({
                    "requestId": read_trimmed_string(row.get("requestId")),
                    "lastResponseId": read_trimmed_string(row.get("lastResponseId")),
                    "updatedAt": row.get("updatedAt").cloned().unwrap_or(Value::Null),
                })
            })
            .collect::<Vec<_>>();
        let plan = plan_responses_store_sweep(&serde_json::json!({
            "mode": "prune_expired",
            "nowMs": self.last_prune_at,
            "ttlMs": RESPONSES_STORE_TTL_MS,
            "candidates": candidates,
        }));
        let detach_request_ids = plan
            .as_object()
            .and_then(|row| row.get("detachRequestIds"))
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter_map(|item| read_trimmed_string(Some(item)))
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        let cleared = detach_request_ids.len();
        for request_id in detach_request_ids {
            self.detach_request_id(&request_id);
        }
        self.prune_indexes();
        self.flush_persistence();
        cleared
    }

    fn capture_request_context(&mut self, args: &Value) -> Value {
        self.ensure_persistence_loaded();
        let args_obj = args.as_object().cloned().unwrap_or_default();
        let payload = args_obj.get("payload").cloned().unwrap_or(Value::Null);
        let context = args_obj.get("context").cloned().unwrap_or(Value::Null);
        let preflight = plan_responses_conversation_preflight(&serde_json::json!({
            "mode": "capture_request",
            "requestId": args_obj.get("requestId").cloned().unwrap_or(Value::Null),
            "payload": payload,
        }));
        if preflight
            .as_object()
            .and_then(|row| read_trimmed_string(row.get("action")))
            .as_deref()
            != Some("continue")
        {
            return responses_store_ok(serde_json::json!({
                "action": "skip",
                "reason": preflight.as_object().and_then(|row| read_trimmed_string(row.get("reason"))).unwrap_or_else(|| "preflight_skip".to_string()),
            }));
        }
        let Some(request_id) = preflight
            .as_object()
            .and_then(|row| read_trimmed_string(row.get("requestId")))
        else {
            return responses_store_malformed_request(
                "Responses conversation request capture requires request id",
                "missing_request_id",
                serde_json::json!({
                    "context": "responses-conversation-store.captureRequestContext",
                }),
            );
        };
        self.prune_expired();
        if self.request_map.contains_key(&request_id) {
            self.detach_request_id(&request_id);
        }
        let entry_kind = responses_store_tokens(serde_json::json!({
            "entryKind": args_obj.get("entryKind").cloned().unwrap_or(Value::Null),
        }))
        .get("entryKind")
        .and_then(Value::as_str)
        .unwrap_or("responses")
        .to_string();
        let mut scope = Map::new();
        for key in [
            "sessionId",
            "conversationId",
            "matchedPort",
            "routingPolicyGroup",
        ] {
            if let Some(value) = args_obj.get(key).cloned() {
                scope.insert(key.to_string(), value);
            }
        }
        scope.insert("entryKind".to_string(), Value::String(entry_kind));
        scope.insert(
            "continuationOwner".to_string(),
            Value::String("relay".to_string()),
        );
        let (scope_keys, port_scope_key) =
            responses_store_build_scope_keys(Value::Object(scope), "stored");
        let cleanup_candidates = self
            .request_map
            .values()
            .map(|entry| {
                let row = entry.as_object().cloned().unwrap_or_default();
                serde_json::json!({
                    "requestId": read_trimmed_string(row.get("requestId")),
                    "lastResponseId": read_trimmed_string(row.get("lastResponseId")),
                    "scopeKeys": row.get("scopeKeys").cloned().unwrap_or(Value::Array(Vec::new())),
                })
            })
            .collect::<Vec<_>>();
        let cleanup_plan = plan_responses_capture_pending_cleanup(&serde_json::json!({
            "requestId": request_id,
            "scopeKeys": scope_keys,
            "candidates": cleanup_candidates,
        }));
        if let Some(items) = cleanup_plan
            .as_object()
            .and_then(|row| row.get("detachRequestIds"))
            .and_then(Value::as_array)
        {
            for item in items {
                if let Some(detach_request_id) = read_trimmed_string(Some(item)) {
                    self.detach_request_id(&detach_request_id);
                }
            }
        }
        let entry_tokens = responses_store_tokens(serde_json::json!({
            "providerKey": args_obj.get("providerKey").cloned().unwrap_or(Value::Null),
            "fallbackProviderKey": payload.as_object().and_then(|row| row.get("providerKey")).cloned().unwrap_or(Value::Null),
            "sessionId": args_obj.get("sessionId").cloned().unwrap_or(Value::Null),
            "conversationId": args_obj.get("conversationId").cloned().unwrap_or(Value::Null),
            "entryKind": args_obj.get("entryKind").cloned().unwrap_or(Value::Null),
        }));
        let entry_plan = plan_responses_captured_entry(&serde_json::json!({
            "requestId": request_id,
            "providerKey": entry_tokens.get("providerKey").cloned().unwrap_or(Value::Null),
            "sessionId": entry_tokens.get("sessionId").cloned().unwrap_or(Value::Null),
            "conversationId": entry_tokens.get("conversationId").cloned().unwrap_or(Value::Null),
            "entryKind": entry_tokens.get("entryKind").cloned().unwrap_or(Value::Null),
            "payload": payload,
            "context": context,
            "scopeKeys": scope_keys,
            "portScopeKey": port_scope_key,
            "nowMs": responses_store_now_ms(),
        }));
        let Some(entry) = entry_plan
            .as_object()
            .and_then(|row| row.get("entry"))
            .cloned()
        else {
            return responses_store_ok(serde_json::json!({
                "action": "skip",
                "reason": "entry_plan_skip",
            }));
        };
        self.request_map.insert(request_id, entry);
        self.flush_persistence();
        responses_store_ok(serde_json::json!({
            "action": "captured",
        }))
    }

    fn record_response(&mut self, args: &Value) -> Value {
        self.ensure_persistence_loaded();
        let args_obj = args.as_object().cloned().unwrap_or_default();
        let response = args_obj.get("response").cloned().unwrap_or(Value::Null);
        let preflight = plan_responses_conversation_preflight(&serde_json::json!({
            "mode": "record_response",
            "requestId": args_obj.get("requestId").cloned().unwrap_or(Value::Null),
            "response": response,
        }));
        let request_id = preflight
            .as_object()
            .and_then(|row| read_trimmed_string(row.get("requestId")))
            .unwrap_or_default();
        let response_id = preflight
            .as_object()
            .and_then(|row| read_trimmed_string(row.get("responseId")));
        let preflight_action = preflight
            .as_object()
            .and_then(|row| read_trimmed_string(row.get("action")));
        let preflight_reason = preflight
            .as_object()
            .and_then(|row| read_trimmed_string(row.get("reason")))
            .unwrap_or_else(|| "unknown".to_string());
        if preflight_action.as_deref() == Some("throw") && preflight_reason == "missing_request_id"
        {
            return responses_store_malformed_response(
                "Responses conversation response capture requires request context",
                "missing_request_id",
                serde_json::json!({
                    "context": "responses-conversation-store.recordResponse",
                    "responseId": response_id,
                }),
            );
        }
        let entry_request_id = if self.request_map.contains_key(&request_id) {
            Some(request_id.clone())
        } else {
            response_id
                .as_ref()
                .filter(|value| self.request_map.contains_key(*value))
                .cloned()
        };
        let Some(entry_request_id) = entry_request_id else {
            return responses_store_error(
                "RESPONSES_STORE_MISSING_REQUEST_CONTEXT",
                "Responses conversation request context missing for response capture",
                "INTERNAL_ERROR",
                serde_json::json!({
                    "context": "responses-conversation-store.recordResponse",
                    "reason": "missing_request_context",
                    "requestId": request_id,
                    "responseId": response_id,
                    "providerKey": args_obj.get("providerKey").cloned().unwrap_or(Value::Null),
                    "sessionId": args_obj.get("sessionId").cloned().unwrap_or(Value::Null),
                    "conversationId": args_obj.get("conversationId").cloned().unwrap_or(Value::Null),
                    "matchedPort": args_obj.get("matchedPort").cloned().unwrap_or(Value::Null),
                    "routingPolicyGroup": args_obj.get("routingPolicyGroup").cloned().unwrap_or(Value::Null),
                }),
            );
        };
        if preflight_action.as_deref() == Some("throw") && preflight_reason == "missing_response_id"
        {
            return responses_store_malformed_response(
                "Responses conversation response capture requires response id",
                "missing_response_id",
                serde_json::json!({
                    "context": "responses-conversation-store.recordResponse",
                    "requestId": request_id,
                }),
            );
        }
        if preflight_action.as_deref() != Some("continue") {
            return responses_store_malformed_response(
                "Responses conversation response capture preflight failed",
                &preflight_reason,
                serde_json::json!({
                    "context": "responses-conversation-store.recordResponse",
                    "requestId": request_id,
                    "responseId": response_id,
                }),
            );
        }
        let Some(response_id) = response_id else {
            return responses_store_malformed_response(
                "Responses conversation response capture requires response id",
                "missing_response_id",
                serde_json::json!({
                    "context": "responses-conversation-store.recordResponse",
                    "requestId": request_id,
                }),
            );
        };
        let Some(mut entry) = self.request_map.get(&entry_request_id).cloned() else {
            return responses_store_error(
                "RESPONSES_STORE_MISSING_REQUEST_CONTEXT",
                "Responses conversation request context missing for response capture",
                "INTERNAL_ERROR",
                serde_json::json!({
                    "context": "responses-conversation-store.recordResponse",
                    "reason": "missing_request_context",
                    "requestId": request_id,
                    "responseId": response_id,
                }),
            );
        };
        let response_port_scope_key = responses_store_read_port_scope_key(args);
        if response_port_scope_key.is_some()
            && entry
                .as_object()
                .and_then(|row| read_trimmed_string(row.get("portScopeKey")))
                .is_none()
        {
            responses_store_set_string(&mut entry, "portScopeKey", response_port_scope_key.clone());
        }
        let entry_obj = entry.as_object().cloned().unwrap_or_default();
        let response_tokens = responses_store_tokens(serde_json::json!({
            "providerKey": args_obj.get("providerKey").cloned().unwrap_or(Value::Null),
            "sessionId": args_obj.get("sessionId").cloned().unwrap_or(Value::Null),
            "conversationId": args_obj.get("conversationId").cloned().unwrap_or(Value::Null),
            "entryKind": args_obj.get("entryKind").cloned().unwrap_or_else(|| entry_obj.get("entryKind").cloned().unwrap_or(Value::Null)),
            "continuationOwner": args_obj.get("continuationOwner").cloned().unwrap_or(Value::Null),
            "fallbackContinuationOwner": entry_obj.get("continuationOwner").cloned().unwrap_or(Value::String("relay".to_string())),
        }));
        responses_store_set_string(
            &mut entry,
            "providerKey",
            response_tokens
                .get("providerKey")
                .and_then(Value::as_str)
                .map(str::to_string),
        );
        responses_store_set_string(
            &mut entry,
            "sessionId",
            response_tokens
                .get("sessionId")
                .and_then(Value::as_str)
                .map(str::to_string)
                .or_else(|| {
                    entry_obj
                        .get("sessionId")
                        .and_then(Value::as_str)
                        .map(str::to_string)
                }),
        );
        responses_store_set_string(
            &mut entry,
            "conversationId",
            response_tokens
                .get("conversationId")
                .and_then(Value::as_str)
                .map(str::to_string)
                .or_else(|| {
                    entry_obj
                        .get("conversationId")
                        .and_then(Value::as_str)
                        .map(str::to_string)
                }),
        );
        let entry_kind = response_tokens
            .get("entryKind")
            .and_then(Value::as_str)
            .unwrap_or("responses")
            .to_string();
        let continuation_owner = response_tokens
            .get("continuationOwner")
            .and_then(Value::as_str)
            .unwrap_or("relay")
            .to_string();
        responses_store_set_value(&mut entry, "entryKind", Value::String(entry_kind.clone()));
        responses_store_set_value(
            &mut entry,
            "continuationOwner",
            Value::String(continuation_owner.clone()),
        );
        let updated_entry_obj = entry.as_object().cloned().unwrap_or_default();
        let next_scope_keys = responses_store_build_stored_scope_keys_from_resolved(
            read_trimmed_string(updated_entry_obj.get("sessionId")),
            read_trimmed_string(updated_entry_obj.get("conversationId")),
            entry_kind,
            continuation_owner,
            response_port_scope_key
                .or_else(|| read_trimmed_string(updated_entry_obj.get("portScopeKey"))),
        );
        responses_store_set_value(
            &mut entry,
            "scopeKeys",
            Value::Array(next_scope_keys.iter().cloned().map(Value::String).collect()),
        );
        if let Some(old_last_response_id) = responses_store_read_entry_last_response_id(&entry) {
            self.response_index.remove(&old_last_response_id);
        }
        let assistant_blocks = convert_responses_output_to_input_items(&response)
            .as_array()
            .cloned()
            .unwrap_or_default();
        if let Some(row) = entry.as_object_mut() {
            let input = row
                .entry("input".to_string())
                .or_insert_with(|| Value::Array(Vec::new()));
            if let Some(items) = input.as_array_mut() {
                items.extend(assistant_blocks);
                let pending_ids =
                    collect_responses_pending_tool_call_ids(&Value::Array(items.clone()));
                let continuation_plan = plan_responses_record_continuation_flag(
                    &serde_json::json!({
                        "allowContinuation": row.get("allowContinuation").and_then(Value::as_bool).unwrap_or(false),
                        "pendingToolCallIds": pending_ids,
                    }),
                );
                row.insert(
                    "allowContinuation".to_string(),
                    continuation_plan
                        .as_object()
                        .and_then(|plan| plan.get("allowContinuation"))
                        .cloned()
                        .unwrap_or(Value::Bool(false)),
                );
            }
            row.insert(
                "lastResponseId".to_string(),
                Value::String(response_id.clone()),
            );
            row.insert(
                "updatedAt".to_string(),
                serde_json::json!(responses_store_now_ms()),
            );
        }
        let actual_request_id = responses_store_read_entry_request_id(&entry)
            .unwrap_or_else(|| entry_request_id.clone());
        self.request_map
            .insert(actual_request_id.clone(), entry.clone());
        self.response_index
            .insert(response_id.clone(), actual_request_id.clone());
        let mut record_cleanup_candidates: HashMap<String, Value> = HashMap::new();
        for scope_key in responses_store_read_entry_scope_keys(&entry) {
            if let Some(previous_request_id) = self.scope_index.get(&scope_key) {
                if let Some(previous) = self.request_map.get(previous_request_id) {
                    record_cleanup_candidates.insert(
                        previous_request_id.clone(),
                        serde_json::json!({
                            "requestId": previous_request_id,
                            "lastResponseId": responses_store_read_entry_last_response_id(previous),
                            "scopeKeys": responses_store_read_entry_scope_keys(previous),
                        }),
                    );
                }
            }
        }
        for (candidate_request_id, candidate) in &self.request_map {
            record_cleanup_candidates.insert(
                candidate_request_id.clone(),
                serde_json::json!({
                    "requestId": candidate_request_id,
                    "lastResponseId": responses_store_read_entry_last_response_id(candidate),
                    "scopeKeys": responses_store_read_entry_scope_keys(candidate),
                }),
            );
        }
        let record_cleanup_plan = plan_responses_record_scope_cleanup(&serde_json::json!({
            "requestId": actual_request_id,
            "scopeKeys": responses_store_read_entry_scope_keys(&entry),
            "candidates": record_cleanup_candidates.into_values().collect::<Vec<_>>(),
        }));
        if let Some(items) = record_cleanup_plan
            .as_object()
            .and_then(|row| row.get("detachRequestIds"))
            .and_then(Value::as_array)
        {
            for item in items {
                if let Some(detach_request_id) = read_trimmed_string(Some(item)) {
                    self.detach_request_id(&detach_request_id);
                }
            }
        }
        self.attach_entry_scopes_by_request_id(&actual_request_id);
        self.flush_persistence();
        responses_store_ok(serde_json::json!({
            "action": "recorded",
            "responseId": response_id,
        }))
    }

    fn resume_conversation(&mut self, payload: &Value) -> Value {
        self.ensure_persistence_loaded();
        let obj = payload.as_object().cloned().unwrap_or_default();
        let response_id_input = obj.get("responseId").cloned().unwrap_or(Value::Null);
        let submit_payload = obj.get("submitPayload").cloned().unwrap_or(Value::Null);
        let options = obj.get("options").cloned().unwrap_or(Value::Null);
        let preflight = plan_responses_conversation_preflight(&serde_json::json!({
            "mode": "resume_conversation",
            "responseId": response_id_input,
            "submitPayload": submit_payload,
        }));
        let response_id = preflight
            .as_object()
            .and_then(|row| read_trimmed_string(row.get("responseId")));
        let action = preflight
            .as_object()
            .and_then(|row| read_trimmed_string(row.get("action")));
        let reason = preflight
            .as_object()
            .and_then(|row| read_trimmed_string(row.get("reason")))
            .unwrap_or_else(|| "unknown".to_string());
        if action.as_deref() == Some("throw") && reason == "missing_or_empty_response_id" {
            return responses_store_malformed_request(
                "Responses conversation requires valid response_id",
                "missing_or_empty_response_id",
                serde_json::json!({
                    "context": "responses-conversation-store.resumeConversation",
                }),
            );
        }
        let Some(response_id) = response_id else {
            return responses_store_malformed_request(
                "Responses conversation resume preflight failed",
                &reason,
                serde_json::json!({
                    "context": "responses-conversation-store.resumeConversation",
                }),
            );
        };
        self.prune_expired();
        let requested_port_scope_key = responses_store_read_port_scope_key(&options);
        let mut entries_by_request_id: HashMap<String, Value> = HashMap::new();
        let mut candidates = Vec::new();
        if let Some(indexed_request_id) = self.response_index.get(&response_id) {
            if let Some(indexed_entry) = self.request_map.get(indexed_request_id) {
                entries_by_request_id.insert(indexed_request_id.clone(), indexed_entry.clone());
                candidates.push(responses_store_project_resume_candidate(
                    indexed_entry,
                    "response_index",
                    None,
                ));
            }
        } else {
            for (request_id, candidate) in &self.request_map {
                entries_by_request_id.insert(request_id.clone(), candidate.clone());
                candidates.push(responses_store_project_resume_candidate(
                    candidate,
                    "request_map",
                    None,
                ));
            }
        }
        for scope_key in responses_store_resume_scope_keys_from_submit_payload(&submit_payload) {
            if let Some(request_id) = self.scope_index.get(&scope_key) {
                if let Some(candidate) = self.request_map.get(request_id) {
                    entries_by_request_id.insert(request_id.clone(), candidate.clone());
                    candidates.push(responses_store_project_resume_candidate(
                        candidate,
                        "scope",
                        Some(&scope_key),
                    ));
                }
            }
        }
        let plan = plan_responses_conversation_resume_entry_match(&serde_json::json!({
            "responseId": response_id,
            "requestedPortScopeKey": requested_port_scope_key,
            "options": options,
            "candidates": candidates,
        }));
        let plan_action = plan
            .as_object()
            .and_then(|row| read_trimmed_string(row.get("action")));
        if plan_action.as_deref() == Some("ambiguous") {
            return responses_store_malformed_request(
                "Responses conversation response_id index is ambiguous",
                "ambiguous_response_id_index",
                serde_json::json!({
                    "context": "responses-conversation-store.resumeConversation",
                    "responseId": response_id,
                }),
            );
        }
        let entry = plan
            .as_object()
            .and_then(|row| read_trimmed_string(row.get("requestId")))
            .and_then(|request_id| entries_by_request_id.get(&request_id).cloned());
        let Some(entry) = entry else {
            return responses_store_malformed_request(
                "Responses conversation expired or not found",
                "expired_or_unknown_response_id",
                serde_json::json!({
                    "context": "responses-conversation-store.resumeConversation",
                    "responseId": response_id,
                }),
            );
        };
        if plan
            .as_object()
            .and_then(|row| read_trimmed_string(row.get("source")))
            .as_deref()
            == Some("request_map")
        {
            if let Some(request_id) = responses_store_read_entry_request_id(&entry) {
                self.response_index.insert(response_id.clone(), request_id);
            }
        }
        if action.as_deref() == Some("throw") && reason == "missing_tool_outputs" {
            return responses_store_malformed_request(
                "tool_outputs array is required when submitting Responses tool results",
                "missing_tool_outputs",
                serde_json::json!({
                    "context": "responses-conversation-store.resumeConversation",
                    "responseId": response_id,
                }),
            );
        }
        if action.as_deref() != Some("continue") {
            return responses_store_malformed_request(
                "Responses conversation resume preflight failed",
                &reason,
                serde_json::json!({
                    "context": "responses-conversation-store.resumeConversation",
                    "responseId": response_id,
                }),
            );
        }
        let request_id = options
            .as_object()
            .and_then(|row| read_trimmed_string(row.get("requestId")));
        let resumed = resume_responses_conversation_payload(
            &entry,
            &response_id,
            &submit_payload,
            request_id.as_deref(),
        )
        .unwrap_or_else(|reason| {
            serde_json::json!({
                "error": {
                    "type": "orphan_tool_result",
                    "message": reason,
                    "status": 400,
                    "code": "hub_pipeline_context_capture_failed",
                    "origin": "client"
                }
            })
        });
        if let Some(entry_request_id) = responses_store_read_entry_request_id(&entry) {
            self.detach_request_id(&entry_request_id);
        }
        self.response_index.remove(&response_id);
        self.flush_persistence();
        let meta = responses_store_merge_meta(
            resumed
                .as_object()
                .and_then(|row| row.get("meta"))
                .cloned()
                .unwrap_or(Value::Null),
            &entry,
        );
        responses_store_ok(serde_json::json!({
            "payload": resumed.as_object().and_then(|row| row.get("payload")).cloned().unwrap_or(Value::Null),
            "meta": meta,
        }))
    }

    fn lookup_by_response_id(&mut self, payload: &Value) -> Value {
        self.ensure_persistence_loaded();
        let obj = payload.as_object().cloned().unwrap_or_default();
        let Some(response_id) = read_trimmed_string(obj.get("responseId")) else {
            return responses_store_ok(Value::Null);
        };
        self.prune_expired();
        let options = obj.get("options").cloned().unwrap_or(Value::Null);
        let requested_port_scope_key = responses_store_read_port_scope_key(&options);
        let entry = self
            .response_index
            .get(&response_id)
            .and_then(|request_id| self.request_map.get(request_id))
            .cloned()
            .unwrap_or(Value::Null);
        let plan = plan_responses_continuation_lookup_by_response_id(&serde_json::json!({
            "responseId": response_id,
            "requestedPortScopeKey": requested_port_scope_key,
            "options": options,
            "entry": entry,
        }));
        if plan
            .as_object()
            .and_then(|row| read_trimmed_string(row.get("action")))
            .as_deref()
            != Some("select")
        {
            return responses_store_ok(Value::Null);
        }
        responses_store_ok(serde_json::json!({
            "responseId": plan.as_object().and_then(|row| read_trimmed_string(row.get("responseId"))),
            "providerKey": plan.as_object().and_then(|row| read_trimmed_string(row.get("providerKey"))),
            "continuationOwner": plan.as_object().and_then(|row| read_trimmed_string(row.get("continuationOwner"))),
            "entryKind": plan.as_object().and_then(|row| read_trimmed_string(row.get("entryKind"))),
            "requestId": plan.as_object().and_then(|row| read_trimmed_string(row.get("requestId"))),
        }))
    }

    fn clear_request(&mut self, payload: &Value) -> Value {
        self.ensure_persistence_loaded();
        if let Some(request_id) = payload
            .as_object()
            .and_then(|row| read_trimmed_string(row.get("requestId")))
        {
            self.detach_request_id(&request_id);
            self.flush_persistence();
        }
        responses_store_ok(Value::Null)
    }

    fn clear_unresolved(&mut self) -> Value {
        self.ensure_persistence_loaded();
        let candidates = self
            .request_map
            .values()
            .map(|entry| {
                serde_json::json!({
                    "requestId": responses_store_read_entry_request_id(entry),
                    "lastResponseId": responses_store_read_entry_last_response_id(entry),
                    "updatedAt": entry.as_object().and_then(|row| row.get("updatedAt")).cloned().unwrap_or(Value::Null),
                })
            })
            .collect::<Vec<_>>();
        let plan = plan_responses_store_sweep(&serde_json::json!({
            "mode": "clear_unresolved",
            "candidates": candidates,
        }));
        let detach_request_ids = plan
            .as_object()
            .and_then(|row| row.get("detachRequestIds"))
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter_map(|item| read_trimmed_string(Some(item)))
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        let cleared = detach_request_ids.len();
        for request_id in detach_request_ids {
            self.detach_request_id(&request_id);
        }
        self.prune_indexes();
        if cleared > 0 {
            self.flush_persistence();
        }
        responses_store_ok(serde_json::json!({ "cleared": cleared }))
    }

    fn release_request_payload(&mut self, payload: &Value) -> Value {
        self.ensure_persistence_loaded();
        let Some(request_id) = payload
            .as_object()
            .and_then(|row| read_trimmed_string(row.get("requestId")))
        else {
            return responses_store_ok(Value::Null);
        };
        let Some(mut entry) = self.request_map.get(&request_id).cloned() else {
            return responses_store_ok(Value::Null);
        };
        let plan = plan_responses_release_request_payload(&entry);
        if let Some(row) = entry.as_object_mut() {
            if let Some(plan_obj) = plan.as_object() {
                for key in [
                    "releasedInputPrefix",
                    "basePayload",
                    "releasedPendingToolCallIds",
                    "input",
                ] {
                    if let Some(value) = plan_obj.get(key).cloned() {
                        row.insert(key.to_string(), value);
                    }
                }
            }
            row.insert(
                "updatedAt".to_string(),
                serde_json::json!(responses_store_now_ms()),
            );
        }
        self.request_map.insert(request_id.clone(), entry);
        self.attach_entry_scopes_by_request_id(&request_id);
        self.flush_persistence();
        responses_store_ok(Value::Null)
    }

    fn finalize_retention(&mut self, payload: &Value) -> Value {
        let Some(request_id) = payload
            .as_object()
            .and_then(|row| read_trimmed_string(row.get("requestId")))
        else {
            return responses_store_ok(Value::Null);
        };
        let options = payload
            .as_object()
            .and_then(|row| row.get("options"))
            .cloned()
            .unwrap_or(Value::Null);
        let Some(entry) = self.request_map.get(&request_id).cloned() else {
            return responses_store_ok(Value::Null);
        };
        let plan = plan_responses_conversation_retention(&entry, &options);
        match plan
            .as_object()
            .and_then(|row| read_trimmed_string(row.get("action")))
            .as_deref()
        {
            Some("clear") => {
                self.detach_request_id(&request_id);
                self.flush_persistence();
            }
            Some("release") => {
                let _ =
                    self.release_request_payload(&serde_json::json!({ "requestId": request_id }));
            }
            _ => {}
        }
        responses_store_ok(Value::Null)
    }

    fn rebind_request_id(&mut self, payload: &Value) -> Value {
        let obj = payload.as_object().cloned().unwrap_or_default();
        let old_id = read_trimmed_string(obj.get("oldId"));
        let new_id = read_trimmed_string(obj.get("newId"));
        let plan = plan_responses_rebind_request_id(&serde_json::json!({
            "oldId": old_id,
            "newId": new_id,
            "oldEntryExists": old_id.as_ref().map(|id| self.request_map.contains_key(id)).unwrap_or(false),
            "newEntryExists": new_id.as_ref().map(|id| self.request_map.contains_key(id)).unwrap_or(false),
        }));
        if plan
            .as_object()
            .and_then(|row| read_trimmed_string(row.get("action")))
            .as_deref()
            != Some("rebind")
        {
            return responses_store_ok(Value::Null);
        }
        let Some(old_id) = plan
            .as_object()
            .and_then(|row| read_trimmed_string(row.get("oldId")))
        else {
            return responses_store_ok(Value::Null);
        };
        let Some(new_id) = plan
            .as_object()
            .and_then(|row| read_trimmed_string(row.get("newId")))
        else {
            return responses_store_ok(Value::Null);
        };
        if let Some(mut entry) = self.request_map.remove(&old_id) {
            responses_store_set_value(&mut entry, "requestId", Value::String(new_id.clone()));
            self.request_map.insert(new_id.clone(), entry);
            for request_id in self.response_index.values_mut() {
                if request_id == &old_id {
                    *request_id = new_id.clone();
                }
            }
            for request_id in self.scope_index.values_mut() {
                if request_id == &old_id {
                    *request_id = new_id.clone();
                }
            }
        }
        responses_store_ok(Value::Null)
    }

    fn scope_restore(&mut self, payload: &Value, mode: &str) -> Value {
        self.ensure_persistence_loaded();
        self.prune_expired();
        let obj = payload.as_object().cloned().unwrap_or_default();
        let args_payload = obj.get("payload").cloned().unwrap_or(Value::Null);
        let request_tokens = responses_store_tokens(serde_json::json!({
            "entryKind": obj.get("entryKind").cloned().unwrap_or(Value::Null),
            "continuationOwner": obj.get("continuationOwner").cloned().unwrap_or(Value::Null),
        }));
        let mut scope = Map::new();
        for key in [
            "sessionId",
            "conversationId",
            "matchedPort",
            "routingPolicyGroup",
        ] {
            if let Some(value) = obj.get(key).cloned() {
                scope.insert(key.to_string(), value);
            }
        }
        scope.insert(
            "entryKind".to_string(),
            request_tokens
                .get("entryKind")
                .cloned()
                .unwrap_or(Value::String("responses".to_string())),
        );
        if let Some(owner) = request_tokens.get("continuationOwner").cloned() {
            scope.insert("continuationOwner".to_string(), owner);
        }
        let scope_keys = responses_store_build_scope_keys(Value::Object(scope), "requested").0;
        let mut entries_by_scope_key: HashMap<String, Value> = HashMap::new();
        let mut candidates = Vec::new();
        for scope_key in scope_keys {
            let Some(request_id) = self.scope_index.get(&scope_key) else {
                continue;
            };
            let Some(entry) = self.request_map.get(request_id) else {
                continue;
            };
            entries_by_scope_key.insert(scope_key.clone(), entry.clone());
            let entry_obj = entry.as_object().cloned().unwrap_or_default();
            let tokens = responses_store_tokens(serde_json::json!({
                "continuationOwner": entry_obj.get("continuationOwner").cloned().unwrap_or(Value::Null),
            }));
            candidates.push(serde_json::json!({
                "scopeKey": scope_key,
                "requestId": read_trimmed_string(entry_obj.get("requestId")),
                "lastResponseId": read_trimmed_string(entry_obj.get("lastResponseId")),
                "allowContinuation": entry_obj.get("allowContinuation").and_then(Value::as_bool).unwrap_or(false),
                "continuationOwner": tokens.get("continuationOwner").cloned().unwrap_or(Value::Null),
            }));
        }
        let plan = plan_responses_scope_continuation_match(&serde_json::json!({
            "mode": mode,
            "candidates": candidates,
            "options": {
                "continuationOwner": request_tokens.get("continuationOwner").cloned().unwrap_or(Value::Null),
            },
        }));
        let expected_action = if mode == "resume" {
            "restore"
        } else {
            "materialize"
        };
        if plan
            .as_object()
            .and_then(|row| read_trimmed_string(row.get("action")))
            .as_deref()
            != Some(expected_action)
        {
            return responses_store_ok(Value::Null);
        }
        let Some(scope_key) = plan
            .as_object()
            .and_then(|row| read_trimmed_string(row.get("scopeKey")))
        else {
            return responses_store_ok(Value::Null);
        };
        let Some(entry) = entries_by_scope_key.get(&scope_key).cloned() else {
            return responses_store_ok(Value::Null);
        };
        let request_id = obj
            .get("requestId")
            .and_then(|_| read_trimmed_string(obj.get("requestId")));
        let restored = if mode == "resume" {
            restore_responses_continuation_payload(
                &entry,
                &args_payload,
                request_id.as_deref(),
                Some(&scope_key),
            )
        } else {
            materialize_responses_continuation_payload(
                &entry,
                &args_payload,
                request_id.as_deref(),
                Some(&scope_key),
            )
        };
        if restored.is_null() {
            return responses_store_ok(Value::Null);
        }
        let meta = responses_store_merge_meta(
            restored
                .as_object()
                .and_then(|row| row.get("meta"))
                .cloned()
                .unwrap_or(Value::Null),
            &entry,
        );
        responses_store_ok(serde_json::json!({
            "payload": restored.as_object().and_then(|row| row.get("payload")).cloned().unwrap_or(Value::Null),
            "meta": meta,
        }))
    }
}

fn execute_responses_conversation_store_operation(input: &Value) -> Value {
    let obj = input.as_object().cloned().unwrap_or_default();
    let operation = read_trimmed_string(obj.get("operation")).unwrap_or_default();
    let payload = obj.get("payload").cloned().unwrap_or(Value::Null);
    let mut store = match RESPONSES_CONVERSATION_STORE.lock() {
        Ok(store) => store,
        Err(_) => {
            return responses_store_error(
                "RESPONSES_STORE_LOCK_POISONED",
                "Responses conversation store lock is poisoned",
                "INTERNAL_ERROR",
                serde_json::json!({
                    "context": "responses-conversation-store.native",
                    "reason": "lock_poisoned",
                }),
            )
        }
    };
    store.apply_operation_context(input);
    match operation.as_str() {
        "capture_request_context" => store.capture_request_context(&payload),
        "record_response" => store.record_response(&payload),
        "resume_conversation" => store.resume_conversation(&payload),
        "lookup_by_response_id" => store.lookup_by_response_id(&payload),
        "clear_request" => store.clear_request(&payload),
        "clear_unresolved" => store.clear_unresolved(),
        "release_request_payload" => store.release_request_payload(&payload),
        "finalize_retention" => store.finalize_retention(&payload),
        "rebind_request_id" => store.rebind_request_id(&payload),
        "resume_latest_by_scope" => store.scope_restore(&payload, "resume"),
        "materialize_latest_by_scope" => store.scope_restore(&payload, "materialize"),
        "prune_expired" => {
            let cleared = store.prune_expired();
            responses_store_ok(serde_json::json!({ "cleared": cleared }))
        }
        "clear_all" => {
            store.request_map.clear();
            store.response_index.clear();
            store.scope_index.clear();
            store.persistence_loaded = false;
            responses_store_ok(Value::Null)
        }
        "clear_all_and_persist" => {
            store.ensure_persistence_loaded();
            store.request_map.clear();
            store.response_index.clear();
            store.scope_index.clear();
            store.flush_persistence();
            store.persistence_loaded = false;
            responses_store_ok(Value::Null)
        }
        "get_last_prune_at" => responses_store_ok(serde_json::json!(store.last_prune_at)),
        "debug_stats" => responses_store_ok(store.debug_stats()),
        "debug_delete_response_index" => {
            if let Some(response_id) = payload
                .as_object()
                .and_then(|row| read_trimmed_string(row.get("responseId")))
            {
                store.response_index.remove(&response_id);
            }
            responses_store_ok(Value::Null)
        }
        "debug_has_request" => {
            let exists = payload
                .as_object()
                .and_then(|row| read_trimmed_string(row.get("requestId")))
                .map(|request_id| store.request_map.contains_key(&request_id))
                .unwrap_or(false);
            responses_store_ok(Value::Bool(exists))
        }
        "debug_has_response" => {
            let exists = payload
                .as_object()
                .and_then(|row| read_trimmed_string(row.get("responseId")))
                .map(|response_id| store.response_index.contains_key(&response_id))
                .unwrap_or(false);
            responses_store_ok(Value::Bool(exists))
        }
        "debug_has_scope" => {
            let exists = payload
                .as_object()
                .and_then(|row| read_trimmed_string(row.get("scopeKey")))
                .map(|scope_key| store.scope_index.contains_key(&scope_key))
                .unwrap_or(false);
            responses_store_ok(Value::Bool(exists))
        }
        _ => responses_store_error(
            "RESPONSES_STORE_UNSUPPORTED_OPERATION",
            "Unsupported responses conversation store operation",
            "INTERNAL_ERROR",
            serde_json::json!({
                "context": "responses-conversation-store.native",
                "reason": "unsupported_operation",
                "operation": operation,
            }),
        ),
    }
}

fn strip_meta_value(value: Value) -> Value {
    match value {
        Value::Array(arr) => Value::Array(arr.into_iter().map(strip_meta_value).collect()),
        Value::Object(mut map) => {
            map.remove("metadata");
            map.remove("meta");
            map.remove("__meta");
            map.remove("_meta");
            let keys: Vec<String> = map.keys().cloned().collect();
            for key in keys {
                if let Some(v) = map.remove(&key) {
                    map.insert(key, strip_meta_value(v));
                }
            }
            Value::Object(map)
        }
        other => other,
    }
}

fn resume_responses_conversation_payload(
    entry: &Value,
    response_id: &str,
    submit_payload: &Value,
    request_id: Option<&str>,
) -> Result<Value, String> {
    let entry_obj = entry.as_object().cloned().unwrap_or_default();
    let base_payload = clone_object(entry_obj.get("basePayload"));
    let mut payload = base_payload.clone();
    let direct_input = normalize_responses_history_items(clone_array(entry_obj.get("input")));
    let released_input_prefix =
        normalize_responses_history_items(clone_array(entry_obj.get("releasedInputPrefix")));
    let mut merged_input = if direct_input.is_empty() && !released_input_prefix.is_empty() {
        released_input_prefix
    } else {
        direct_input
    };
    merged_input =
        collapse_auto_stop_hook_pairs_in_history(normalize_responses_history_items(merged_input));
    let tool_outputs = clone_array(
        submit_payload
            .as_object()
            .and_then(|row| row.get("tool_outputs")),
    );

    let (normalized_items, submitted_details) =
        normalize_submitted_tool_outputs(&tool_outputs, &merged_input)?;
    merged_input.extend(normalized_items);
    let full_input = remove_auto_stop_hook_assistant_echoes_in_history(
        collapse_auto_stop_hook_pairs_in_history(normalize_responses_history_items(merged_input)),
    );
    payload.insert("input".to_string(), Value::Array(full_input.clone()));

    let stream = submit_payload
        .as_object()
        .and_then(|row| row.get("stream"))
        .and_then(Value::as_bool)
        .or_else(|| base_payload.get("stream").and_then(Value::as_bool))
        .unwrap_or(false);
    payload.insert("stream".to_string(), Value::Bool(stream));
    payload.insert(
        "previous_response_id".to_string(),
        Value::String(response_id.to_string()),
    );

    let provider_key = read_trimmed_string(entry_obj.get("providerKey"));

    if let Some(model) =
        read_trimmed_string(submit_payload.as_object().and_then(|row| row.get("model")))
    {
        payload.insert("model".to_string(), Value::String(model));
    }

    if let Some(submit_meta) = submit_payload
        .as_object()
        .and_then(|row| row.get("metadata"))
        .and_then(Value::as_object)
    {
        let mut merged_meta = payload
            .get("metadata")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        for (key, value) in submit_meta {
            merged_meta.insert(key.clone(), value.clone());
        }
        payload.insert("metadata".to_string(), Value::Object(merged_meta));
    }

    payload.remove("tool_outputs");
    payload.remove("response_id");

    Ok(serde_json::json!({
        "payload": Value::Object(payload),
        "meta": {
            "restoredFromResponseId": response_id,
            "previousRequestId": entry_obj.get("requestId").cloned().unwrap_or(Value::Null),
            "providerKey": provider_key.map(Value::String).unwrap_or(Value::Null),
            "toolOutputs": tool_outputs.len(),
            "toolOutputsDetailed": submitted_details,
            "fullInputItems": full_input.len(),
            "fullInput": full_input,
            "restoredTools": read_entry_tools_value(&entry_obj),
            "requestId": request_id.map(|value| Value::String(value.to_string())).unwrap_or(Value::Null),
            "restored": true,
        }
    }))
}

fn canonicalize_continuation_item(value: &Value) -> Value {
    let Some(row) = value.as_object() else {
        return value.clone();
    };
    let item_type = read_trimmed_string(row.get("type"));
    let role = read_trimmed_string(row.get("role"));
    let content = if row.get("content").is_some() {
        Some(Value::Array(normalize_message_content_for_request_history(
            row.get("content"),
        )))
    } else {
        None
    };

    if role.is_some() && content.is_some() && item_type.as_deref() == Some("message") {
        return serde_json::json!({
            "role": role,
            "content": content
        });
    }

    if role.is_some() && content.is_some() && !row.contains_key("type") {
        return serde_json::json!({
            "role": role,
            "content": content
        });
    }

    let mut normalized = row.clone();
    normalized.remove("message");
    Value::Object(normalized)
}

fn values_equal(left: &Value, right: &Value) -> bool {
    canonicalize_continuation_item(left) == canonicalize_continuation_item(right)
}

fn find_exact_prefix_delta(prefix: &[Value], incoming: &[Value]) -> Option<Vec<Value>> {
    if prefix.is_empty() || incoming.len() <= prefix.len() {
        return None;
    }
    for (index, expected) in prefix.iter().enumerate() {
        let candidate = incoming.get(index)?;
        if !values_equal(expected, candidate) {
            return None;
        }
    }
    Some(incoming[prefix.len()..].to_vec())
}

fn find_prefix_delta_allowing_pending_tool_call_replay(
    prefix: &[Value],
    incoming: &[Value],
) -> Option<Vec<Value>> {
    if prefix.is_empty() || incoming.is_empty() {
        return None;
    }
    let mut incoming_index = 0usize;
    for (prefix_index, expected) in prefix.iter().enumerate() {
        let candidate = incoming.get(incoming_index)?;
        if !values_equal(expected, candidate) {
            let expected_row = expected.as_object()?;
            let expected_type = expected_row
                .get("type")
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim()
                .to_ascii_lowercase();
            if expected_type != "function_call" || prefix_index + 1 != prefix.len() {
                return None;
            }
            let pending_call_id = read_bridge_function_call_id(expected_row)?;
            let candidate_row = candidate.as_object()?;
            let candidate_type = candidate_row
                .get("type")
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim()
                .to_ascii_lowercase();
            if !is_bridge_tool_output_item_type(candidate_type.as_str()) {
                return None;
            }
            let candidate_call_id = read_bridge_function_call_id(candidate_row)?;
            if candidate_call_id != pending_call_id {
                return None;
            }
            return Some(incoming[incoming_index..].to_vec());
        }
        incoming_index += 1;
    }
    if incoming.len() <= incoming_index {
        return None;
    }
    Some(incoming[incoming_index..].to_vec())
}

fn overlap_slice_contains_bridge_tool_history(items: &[Value]) -> bool {
    items.iter().any(|entry| {
        let Some(row) = entry.as_object() else {
            return false;
        };
        let item_type = row
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim()
            .to_ascii_lowercase();
        item_type == "function_call" || is_bridge_tool_output_item_type(item_type.as_str())
    })
}

fn find_suffix_overlap_delta_with_bridge_tool_history(
    prefix: &[Value],
    incoming: &[Value],
) -> Option<Vec<Value>> {
    if prefix.is_empty() || incoming.is_empty() {
        return None;
    }
    let max_overlap = prefix.len().min(incoming.len());
    for overlap_len in (1..=max_overlap).rev() {
        let prefix_slice = &prefix[prefix.len() - overlap_len..];
        if !overlap_slice_contains_bridge_tool_history(prefix_slice) {
            continue;
        }
        if prefix_slice
            .iter()
            .zip(incoming.iter().take(overlap_len))
            .all(|(left, right)| values_equal(left, right))
        {
            return Some(incoming[overlap_len..].to_vec());
        }
    }
    None
}

fn count_common_leading_items(left: &[Value], right: &[Value]) -> usize {
    let mut count = 0usize;
    let max = left.len().min(right.len());
    while count < max {
        if !values_equal(&left[count], &right[count]) {
            break;
        }
        count += 1;
    }
    count
}

fn collect_submitted_tool_output_details(input_items: &[Value]) -> Vec<Value> {
    let mut submitted: Vec<Value> = Vec::new();
    for (index, entry) in input_items.iter().enumerate() {
        let Some(row) = entry.as_object() else {
            continue;
        };
        let item_type = row.get("type").and_then(Value::as_str).unwrap_or("");
        if item_type != "function_call_output" {
            continue;
        }
        let call_id = read_trimmed_string(row.get("call_id"))
            .or_else(|| read_trimmed_string(row.get("id")))
            .unwrap_or_else(|| format!("resume_tool_{}", index + 1));
        let output_text = stringify_responses_tool_output(row.get("output"));
        submitted.push(serde_json::json!({
            "callId": call_id.clone(),
            "originalId": call_id,
            "outputText": output_text,
        }));
    }
    submitted
}

fn read_bridge_function_call_id(row: &Map<String, Value>) -> Option<String> {
    read_trimmed_string(row.get("call_id"))
        .or_else(|| read_trimmed_string(row.get("tool_call_id")))
        .or_else(|| read_trimmed_string(row.get("id")))
}

fn is_bridge_tool_output_item_type(item_type: &str) -> bool {
    matches!(
        item_type,
        "function_call_output" | "tool_result" | "tool_message"
    )
}

fn collect_pending_bridge_function_call_ids(input_items: &[Value]) -> Vec<String> {
    let mut pending: Vec<String> = Vec::new();
    for entry in input_items {
        let Some(row) = entry.as_object() else {
            continue;
        };
        let item_type = row
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim()
            .to_ascii_lowercase();
        if item_type == "function_call" {
            if let Some(call_id) = read_bridge_function_call_id(row) {
                if !pending.iter().any(|existing| existing == &call_id) {
                    pending.push(call_id);
                }
            }
            continue;
        }
        if !is_bridge_tool_output_item_type(item_type.as_str()) {
            continue;
        }
        let Some(call_id) = read_bridge_function_call_id(row) else {
            continue;
        };
        if let Some(position) = pending.iter().position(|existing| existing == &call_id) {
            pending.remove(position);
        }
    }
    pending
}

fn collect_completed_bridge_function_call_ids(input_items: &[Value]) -> Vec<String> {
    let mut pending: Vec<String> = Vec::new();
    let mut completed: Vec<String> = Vec::new();
    for item in input_items {
        let Some(row) = item.as_object() else {
            continue;
        };
        let item_type = read_trimmed_string(row.get("type"))
            .unwrap_or_default()
            .to_ascii_lowercase();
        let Some(call_id) = read_bridge_function_call_id(row) else {
            continue;
        };
        if item_type == "function_call" {
            pending.push(call_id);
            continue;
        }
        if is_bridge_tool_output_item_type(item_type.as_str()) {
            if let Some(position) = pending.iter().position(|existing| existing == &call_id) {
                pending.remove(position);
                if !completed.iter().any(|existing| existing == &call_id) {
                    completed.push(call_id);
                }
            }
        }
    }
    completed
}

fn input_replays_completed_bridge_call(
    input_items: &[Value],
    completed_call_ids: &[String],
) -> bool {
    if completed_call_ids.is_empty() {
        return false;
    }
    input_items.iter().any(|item| {
        let Some(row) = item.as_object() else {
            return false;
        };
        let item_type = read_trimmed_string(row.get("type"))
            .unwrap_or_default()
            .to_ascii_lowercase();
        if item_type != "function_call" && !is_bridge_tool_output_item_type(item_type.as_str()) {
            return false;
        }
        let Some(call_id) = read_bridge_function_call_id(row) else {
            return false;
        };
        completed_call_ids
            .iter()
            .any(|existing| existing == &call_id)
    })
}

fn read_released_pending_tool_call_ids(entry_obj: &Map<String, Value>) -> Vec<String> {
    entry_obj
        .get("releasedPendingToolCallIds")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| read_trimmed_string(Some(item)))
                .collect::<Vec<String>>()
        })
        .unwrap_or_default()
}

fn read_continuation_owner(entry_obj: &Map<String, Value>) -> Option<&str> {
    match entry_obj.get("continuationOwner").and_then(Value::as_str) {
        Some("direct") => Some("direct"),
        Some("relay") => Some("relay"),
        _ => None,
    }
}

fn leading_input_consumes_pending_tool_calls(
    incoming_items: &[Value],
    pending_call_ids: &[String],
) -> bool {
    if pending_call_ids.is_empty() {
        return true;
    }
    let mut remaining = pending_call_ids.to_vec();
    for entry in incoming_items {
        let Some(row) = entry.as_object() else {
            return false;
        };
        let item_type = row
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim()
            .to_ascii_lowercase();
        if item_type == "function_call" {
            let Some(call_id) = read_bridge_function_call_id(row) else {
                return false;
            };
            if !remaining.iter().any(|existing| existing == &call_id) {
                return false;
            }
            continue;
        }
        if !is_bridge_tool_output_item_type(item_type.as_str()) {
            break;
        }
        let Some(call_id) = read_bridge_function_call_id(row) else {
            return false;
        };
        let Some(position) = remaining.iter().position(|existing| existing == &call_id) else {
            return false;
        };
        remaining.remove(position);
        if remaining.is_empty() {
            return true;
        }
    }
    remaining.is_empty()
}

fn find_delta_from_released_pending_tool_outputs(
    incoming_items: &[Value],
    pending_call_ids: &[String],
) -> Option<Vec<Value>> {
    if pending_call_ids.is_empty() {
        return Some(incoming_items.to_vec());
    }
    for start_index in 0..incoming_items.len() {
        if leading_input_consumes_pending_tool_calls(
            &incoming_items[start_index..],
            pending_call_ids,
        ) {
            return Some(incoming_items[start_index..].to_vec());
        }
    }
    None
}

fn collapse_replayed_pending_tool_batches(
    delta_items: Vec<Value>,
    pending_call_ids: &[String],
) -> Vec<Value> {
    if pending_call_ids.is_empty() || delta_items.is_empty() {
        return delta_items;
    }

    let mut index = 0usize;
    while index + pending_call_ids.len() <= delta_items.len() {
        let candidate = &delta_items[index..index + pending_call_ids.len()];
        let is_replayed_call_batch =
            candidate
                .iter()
                .zip(pending_call_ids.iter())
                .all(|(item, expected_call_id)| {
                    let Some(row) = item.as_object() else {
                        return false;
                    };
                    let item_type = read_trimmed_string(row.get("type"))
                        .unwrap_or_default()
                        .to_ascii_lowercase();
                    item_type == "function_call"
                        && read_bridge_function_call_id(row).as_deref() == Some(expected_call_id)
                });
        if !is_replayed_call_batch {
            break;
        }
        index += pending_call_ids.len();
    }

    let pending: HashSet<&str> = pending_call_ids.iter().map(String::as_str).collect();
    let mut seen_outputs = HashSet::<String>::new();
    let mut collapsed = Vec::<Value>::with_capacity(delta_items.len().saturating_sub(index));
    for item in delta_items.into_iter().skip(index) {
        let Some(row) = item.as_object() else {
            collapsed.push(item);
            continue;
        };
        let item_type = read_trimmed_string(row.get("type"))
            .unwrap_or_default()
            .to_ascii_lowercase();
        if is_bridge_tool_output_item_type(item_type.as_str()) {
            if let Some(call_id) = read_bridge_function_call_id(row) {
                if pending.contains(call_id.as_str()) {
                    if seen_outputs.contains(call_id.as_str()) {
                        continue;
                    }
                    seen_outputs.insert(call_id);
                }
            }
        }
        collapsed.push(item);
    }
    collapsed
}

fn raw_suffix_for_normalized_delta(
    raw_items: &[Value],
    normalized_items: &[Value],
    normalized_delta: &[Value],
) -> Vec<Value> {
    let start = normalized_items
        .len()
        .saturating_sub(normalized_delta.len());
    raw_items.get(start..).unwrap_or(&[]).to_vec()
}

fn restore_responses_continuation_payload(
    entry: &Value,
    incoming_payload: &Value,
    request_id: Option<&str>,
    scope_key: Option<&str>,
) -> Value {
    let entry_obj = entry.as_object().cloned().unwrap_or_default();
    let incoming_obj = incoming_payload.as_object().cloned().unwrap_or_default();
    let last_response_id = read_trimmed_string(entry_obj.get("lastResponseId"));
    let incoming_input = clone_optional_array(incoming_obj.get("input"));
    let continuation_owner = read_continuation_owner(&entry_obj);
    let released_prefix_raw = clone_array(entry_obj.get("releasedInputPrefix"));
    let released_prefix = normalize_responses_history_items(released_prefix_raw.clone());

    let Some(response_id) = last_response_id else {
        return Value::Null;
    };
    let Some(input_items_raw) = incoming_input else {
        return Value::Null;
    };
    let input_items = normalize_responses_history_items(input_items_raw.clone());
    let submitted_details = collect_submitted_tool_output_details(&input_items_raw);
    let prefix_raw = clone_array(entry_obj.get("input"));
    let prefix = normalize_responses_history_items(prefix_raw.clone());
    let incoming_previous_response_id =
        read_trimmed_string(incoming_obj.get("previous_response_id"));
    let delta_input = if prefix.is_empty() {
        let released_pending_call_ids = read_released_pending_tool_call_ids(&entry_obj);
        if !released_pending_call_ids.is_empty() {
            let Some(delta_input) = find_delta_from_released_pending_tool_outputs(
                &input_items,
                &released_pending_call_ids,
            ) else {
                return Value::Null;
            };
            raw_suffix_for_normalized_delta(&input_items_raw, &input_items, &delta_input)
        } else {
            input_items_raw.clone()
        }
    } else if continuation_owner == Some("direct") && !released_prefix.is_empty() {
        input_items_raw.clone()
    } else {
        let Some(delta_input) = find_exact_prefix_delta(&prefix, &input_items)
            .or_else(|| find_prefix_delta_allowing_pending_tool_call_replay(&prefix, &input_items))
            .or_else(|| {
                if continuation_owner != Some("direct")
                    && incoming_previous_response_id.as_deref() == Some(response_id.as_str())
                {
                    Some(input_items.clone())
                } else {
                    None
                }
            })
        else {
            return Value::Null;
        };
        raw_suffix_for_normalized_delta(&input_items_raw, &input_items, &delta_input)
    };

    let mut payload = pick_responses_persisted_fields(&Value::Object(incoming_obj.clone()))
        .as_object()
        .cloned()
        .unwrap_or_default();

    for (key, value) in incoming_obj {
        if key == "input"
            || key == "previous_response_id"
            || key == "response_id"
            || key == "tool_outputs"
        {
            continue;
        }
        payload.insert(key, value);
    }

    let provider_key = read_trimmed_string(entry_obj.get("providerKey"));
    if continuation_owner != Some("direct") && !payload.contains_key("tools") {
        let tools = normalize_responses_tool_definitions(entry_obj.get("tools"));
        if !tools.is_empty() {
            payload.insert("tools".to_string(), Value::Array(tools));
        }
    }

    payload.insert("input".to_string(), Value::Array(delta_input.clone()));
    payload.insert(
        "previous_response_id".to_string(),
        Value::String(response_id.clone()),
    );

    serde_json::json!({
        "payload": Value::Object(payload),
        "meta": {
            "restoredFromResponseId": response_id,
            "previousRequestId": entry_obj.get("requestId").cloned().unwrap_or(Value::Null),
            "providerKey": provider_key.map(Value::String).unwrap_or(Value::Null),
            "requestId": request_id.map(|value| Value::String(value.to_string())).unwrap_or(Value::Null),
            "scopeKey": scope_key.map(|value| Value::String(value.to_string())).unwrap_or(Value::Null),
            "deltaInputItems": delta_input.len(),
            "fullInput": input_items_raw.clone(),
            "restoredTools": read_entry_tools_value(&entry_obj),
            "toolOutputsDetailed": submitted_details,
            "restored": true,
        }
    })
}

fn materialize_responses_continuation_payload(
    entry: &Value,
    incoming_payload: &Value,
    request_id: Option<&str>,
    scope_key: Option<&str>,
) -> Value {
    let entry_obj = entry.as_object().cloned().unwrap_or_default();
    let incoming_obj = incoming_payload.as_object().cloned().unwrap_or_default();
    let incoming_input = clone_optional_array(incoming_obj.get("input"));
    let Some(input_items_raw) = incoming_input else {
        return Value::Null;
    };
    let input_items = normalize_responses_history_items(input_items_raw.clone());
    if input_items_raw.is_empty() {
        return Value::Null;
    }

    let prefix_source = if clone_array(entry_obj.get("input")).is_empty() {
        clone_array(entry_obj.get("releasedInputPrefix"))
    } else {
        clone_array(entry_obj.get("input"))
    };
    let prefix_raw = prefix_source;
    let prefix = normalize_responses_history_items(prefix_raw.clone());
    if prefix.is_empty() {
        return Value::Null;
    }
    let pending_call_ids = collect_pending_bridge_function_call_ids(&prefix);

    if input_items == prefix {
        return Value::Null;
    }

    if let Some(prefix_delta) = find_exact_prefix_delta(&prefix, &input_items) {
        let prefix_delta =
            raw_suffix_for_normalized_delta(&input_items_raw, &input_items, &prefix_delta);
        if prefix_delta.is_empty() {
            return Value::Null;
        }

        let last_response_id = read_trimmed_string(entry_obj.get("lastResponseId"));
        let submitted_details = collect_submitted_tool_output_details(&prefix_delta);
        let mut full_input = prefix_raw.clone();
        full_input.extend(prefix_delta.clone());

        let mut payload = pick_responses_persisted_fields(&Value::Object(incoming_obj.clone()))
            .as_object()
            .cloned()
            .unwrap_or_default();

        for (key, value) in incoming_obj {
            if key == "input" || key == "response_id" || key == "tool_outputs" {
                continue;
            }
            if key == "previous_response_id" {
                continue;
            }
            payload.insert(key, value);
        }

        let provider_key = read_trimmed_string(entry_obj.get("providerKey"));

        payload.insert("input".to_string(), Value::Array(full_input.clone()));
        payload.remove("previous_response_id");

        return serde_json::json!({
            "payload": Value::Object(payload),
            "meta": {
                "restoredFromResponseId": last_response_id.map(Value::String).unwrap_or(Value::Null),
                "previousRequestId": entry_obj.get("requestId").cloned().unwrap_or(Value::Null),
                "providerKey": provider_key.map(Value::String).unwrap_or(Value::Null),
                "requestId": request_id.map(|value| Value::String(value.to_string())).unwrap_or(Value::Null),
                "scopeKey": scope_key.map(|value| Value::String(value.to_string())).unwrap_or(Value::Null),
                "materialized": true,
                "materializedMode": "local_full_input",
                "incomingInputItems": input_items.len(),
                "continuationDeltaItems": prefix_delta.len(),
                "fullInputItems": full_input.len(),
                "fullInput": full_input,
                "restoredTools": read_entry_tools_value(&entry_obj),
                "toolOutputsDetailed": submitted_details,
            }
        });
    }

    if let Some(suffix_delta) =
        find_suffix_overlap_delta_with_bridge_tool_history(&prefix, &input_items)
    {
        if suffix_delta.is_empty() {
            return Value::Null;
        }

        let suffix_delta =
            raw_suffix_for_normalized_delta(&input_items_raw, &input_items, &suffix_delta);
        let suffix_delta = collapse_replayed_pending_tool_batches(suffix_delta, &pending_call_ids);
        if suffix_delta.is_empty() {
            return Value::Null;
        }

        let last_response_id = read_trimmed_string(entry_obj.get("lastResponseId"));
        let submitted_details = collect_submitted_tool_output_details(&suffix_delta);
        let mut full_input = prefix_raw.clone();
        full_input.extend(suffix_delta.clone());

        let mut payload = pick_responses_persisted_fields(&Value::Object(incoming_obj.clone()))
            .as_object()
            .cloned()
            .unwrap_or_default();

        for (key, value) in incoming_obj {
            if key == "input" || key == "response_id" || key == "tool_outputs" {
                continue;
            }
            if key == "previous_response_id" {
                continue;
            }
            payload.insert(key, value);
        }

        let provider_key = read_trimmed_string(entry_obj.get("providerKey"));

        payload.insert("input".to_string(), Value::Array(full_input.clone()));
        payload.remove("previous_response_id");

        return serde_json::json!({
            "payload": Value::Object(payload),
            "meta": {
                "restoredFromResponseId": last_response_id.map(Value::String).unwrap_or(Value::Null),
                "previousRequestId": entry_obj.get("requestId").cloned().unwrap_or(Value::Null),
                "providerKey": provider_key.map(Value::String).unwrap_or(Value::Null),
                "requestId": request_id.map(|value| Value::String(value.to_string())).unwrap_or(Value::Null),
                "scopeKey": scope_key.map(|value| Value::String(value.to_string())).unwrap_or(Value::Null),
                "materialized": true,
                "materializedMode": "local_full_input",
                "incomingInputItems": input_items.len(),
                "continuationDeltaItems": suffix_delta.len(),
                "fullInputItems": full_input.len(),
                "fullInput": full_input,
                "restoredTools": read_entry_tools_value(&entry_obj),
                "toolOutputsDetailed": submitted_details,
            }
        });
    }

    let common_prefix_len = count_common_leading_items(&prefix, &input_items);
    if common_prefix_len > 0 {
        return Value::Null;
    }
    let completed_call_ids = collect_completed_bridge_function_call_ids(&prefix);
    if input_replays_completed_bridge_call(&input_items, &completed_call_ids) {
        return Value::Null;
    }
    if !pending_call_ids.is_empty()
        && !leading_input_consumes_pending_tool_calls(&input_items, &pending_call_ids)
    {
        return Value::Null;
    }

    let continuation_delta = if !pending_call_ids.is_empty() {
        find_prefix_delta_allowing_pending_tool_call_replay(&prefix, &input_items)
            .unwrap_or_else(|| input_items.clone())
    } else {
        input_items.clone()
    };
    let continuation_delta =
        raw_suffix_for_normalized_delta(&input_items_raw, &input_items, &continuation_delta);
    let continuation_delta =
        collapse_replayed_pending_tool_batches(continuation_delta, &pending_call_ids);
    if continuation_delta.is_empty() {
        return Value::Null;
    }

    let last_response_id = read_trimmed_string(entry_obj.get("lastResponseId"));
    let submitted_details = collect_submitted_tool_output_details(&continuation_delta);
    let mut full_input = prefix_raw.clone();
    full_input.extend(continuation_delta.clone());

    let mut payload = pick_responses_persisted_fields(&Value::Object(incoming_obj.clone()))
        .as_object()
        .cloned()
        .unwrap_or_default();

    for (key, value) in incoming_obj {
        if key == "input" || key == "response_id" || key == "tool_outputs" {
            continue;
        }
        if key == "previous_response_id" {
            continue;
        }
        payload.insert(key, value);
    }

    let provider_key = read_trimmed_string(entry_obj.get("providerKey"));

    payload.insert("input".to_string(), Value::Array(full_input.clone()));
    payload.remove("previous_response_id");

    serde_json::json!({
        "payload": Value::Object(payload),
        "meta": {
            "restoredFromResponseId": last_response_id.map(Value::String).unwrap_or(Value::Null),
            "previousRequestId": entry_obj.get("requestId").cloned().unwrap_or(Value::Null),
            "providerKey": provider_key.map(Value::String).unwrap_or(Value::Null),
            "requestId": request_id.map(|value| Value::String(value.to_string())).unwrap_or(Value::Null),
            "scopeKey": scope_key.map(|value| Value::String(value.to_string())).unwrap_or(Value::Null),
            "materialized": true,
            "materializedMode": "local_full_input",
            "incomingInputItems": input_items.len(),
            "continuationDeltaItems": continuation_delta.len(),
            "fullInputItems": full_input.len(),
            "fullInput": full_input,
            "restoredTools": read_entry_tools_value(&entry_obj),
            "toolOutputsDetailed": submitted_details,
        }
    })
}

#[napi_derive::napi]
pub fn pick_responses_persisted_fields_json(payload_json: String) -> NapiResult<String> {
    let payload: Value =
        serde_json::from_str(&payload_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let output = pick_responses_persisted_fields(&payload);
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi_derive::napi]
pub fn convert_responses_output_to_input_items_json(response_json: String) -> NapiResult<String> {
    let response: Value = serde_json::from_str(&response_json)
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let output = convert_responses_output_to_input_items(&response);
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi_derive::napi]
pub fn prepare_responses_conversation_entry_json(
    payload_json: String,
    context_json: String,
) -> NapiResult<String> {
    let payload: Value =
        serde_json::from_str(&payload_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let context: Value =
        serde_json::from_str(&context_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let output = prepare_responses_conversation_entry(&payload, &context);
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi_derive::napi]
pub fn build_responses_conversation_scope_plan_json(input_json: String) -> NapiResult<String> {
    let input: Value =
        serde_json::from_str(&input_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let output = build_responses_conversation_scope_plan(&input);
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi_derive::napi(js_name = "shouldAllowResponsesConversationContinuationJson")]
pub fn should_allow_responses_conversation_continuation_json(
    payload_json: String,
) -> NapiResult<bool> {
    let payload: Value =
        serde_json::from_str(&payload_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    Ok(should_allow_responses_conversation_continuation(&payload))
}

#[napi_derive::napi(js_name = "collectResponsesPendingToolCallIdsJson")]
pub fn collect_responses_pending_tool_call_ids_json(input_json: String) -> NapiResult<String> {
    let input: Value =
        serde_json::from_str(&input_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let output = collect_responses_pending_tool_call_ids(&input);
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi_derive::napi(js_name = "planResponsesConversationRetentionJson")]
pub fn plan_responses_conversation_retention_json(
    entry_json: String,
    options_json: String,
) -> NapiResult<String> {
    let entry: Value =
        serde_json::from_str(&entry_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let options: Value =
        serde_json::from_str(&options_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let output = plan_responses_conversation_retention(&entry, &options);
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi_derive::napi(js_name = "planResponsesConversationPersistenceEligibilityJson")]
pub fn plan_responses_conversation_persistence_eligibility_json(
    entry_json: String,
    options_json: String,
) -> NapiResult<String> {
    let entry: Value =
        serde_json::from_str(&entry_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let options: Value =
        serde_json::from_str(&options_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let output = plan_responses_conversation_persistence_eligibility(&entry, &options);
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi_derive::napi(js_name = "planResponsesPersistedEntryJson")]
pub fn plan_responses_persisted_entry_json(input_json: String) -> NapiResult<String> {
    let input: Value =
        serde_json::from_str(&input_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let output = plan_responses_persisted_entry(&input);
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi_derive::napi(js_name = "planResponsesStoreTokensJson")]
pub fn plan_responses_store_tokens_json(input_json: String) -> NapiResult<String> {
    let input: Value =
        serde_json::from_str(&input_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let output = plan_responses_store_tokens(&input);
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi_derive::napi(js_name = "planResponsesConversationPreflightJson")]
pub fn plan_responses_conversation_preflight_json(input_json: String) -> NapiResult<String> {
    let input: Value =
        serde_json::from_str(&input_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let output = plan_responses_conversation_preflight(&input);
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi_derive::napi(js_name = "planResponsesRecordContinuationFlagJson")]
pub fn plan_responses_record_continuation_flag_json(input_json: String) -> NapiResult<String> {
    let input: Value =
        serde_json::from_str(&input_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let output = plan_responses_record_continuation_flag(&input);
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi_derive::napi(js_name = "planResponsesCapturedEntryJson")]
pub fn plan_responses_captured_entry_json(input_json: String) -> NapiResult<String> {
    let input: Value =
        serde_json::from_str(&input_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let output = plan_responses_captured_entry(&input);
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi_derive::napi(js_name = "planResponsesCapturePendingCleanupJson")]
pub fn plan_responses_capture_pending_cleanup_json(input_json: String) -> NapiResult<String> {
    let input: Value =
        serde_json::from_str(&input_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let output = plan_responses_capture_pending_cleanup(&input);
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi_derive::napi(js_name = "planResponsesRecordScopeCleanupJson")]
pub fn plan_responses_record_scope_cleanup_json(input_json: String) -> NapiResult<String> {
    let input: Value =
        serde_json::from_str(&input_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let output = plan_responses_record_scope_cleanup(&input);
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi_derive::napi(js_name = "planResponsesRecordScopeEntryMatchJson")]
pub fn plan_responses_record_scope_entry_match_json(input_json: String) -> NapiResult<String> {
    let input: Value =
        serde_json::from_str(&input_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let output = plan_responses_record_scope_entry_match(&input);
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi_derive::napi(js_name = "planResponsesStoreSweepJson")]
pub fn plan_responses_store_sweep_json(input_json: String) -> NapiResult<String> {
    let input: Value =
        serde_json::from_str(&input_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let output = plan_responses_store_sweep(&input);
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi_derive::napi(js_name = "planResponsesAttachEntryScopesJson")]
pub fn plan_responses_attach_entry_scopes_json(input_json: String) -> NapiResult<String> {
    let input: Value =
        serde_json::from_str(&input_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let output = plan_responses_attach_entry_scopes(&input);
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi_derive::napi(js_name = "planResponsesRebindRequestIdJson")]
pub fn plan_responses_rebind_request_id_json(input_json: String) -> NapiResult<String> {
    let input: Value =
        serde_json::from_str(&input_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let output = plan_responses_rebind_request_id(&input);
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi_derive::napi(js_name = "planResponsesReleaseRequestPayloadJson")]
pub fn plan_responses_release_request_payload_json(entry_json: String) -> NapiResult<String> {
    let entry: Value =
        serde_json::from_str(&entry_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let output = plan_responses_release_request_payload(&entry);
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi_derive::napi(js_name = "planResponsesScopeContinuationMatchJson")]
pub fn plan_responses_scope_continuation_match_json(input_json: String) -> NapiResult<String> {
    let input: Value =
        serde_json::from_str(&input_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let output = plan_responses_scope_continuation_match(&input);
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi_derive::napi(js_name = "planResponsesConversationResumeEntryMatchJson")]
pub fn plan_responses_conversation_resume_entry_match_json(
    input_json: String,
) -> NapiResult<String> {
    let input: Value =
        serde_json::from_str(&input_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let output = plan_responses_conversation_resume_entry_match(&input);
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi_derive::napi(js_name = "planResponsesContinuationLookupByResponseIdJson")]
pub fn plan_responses_continuation_lookup_by_response_id_json(
    input_json: String,
) -> NapiResult<String> {
    let input: Value =
        serde_json::from_str(&input_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let output = plan_responses_continuation_lookup_by_response_id(&input);
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi_derive::napi(js_name = "planResponsesContinuationMetaJson")]
pub fn plan_responses_continuation_meta_json(input_json: String) -> NapiResult<String> {
    let input: Value =
        serde_json::from_str(&input_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let output = plan_responses_continuation_meta(&input);
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi_derive::napi(js_name = "executeResponsesConversationStoreOperationJson")]
pub fn execute_responses_conversation_store_operation_json(
    input_json: String,
) -> NapiResult<String> {
    let input: Value =
        serde_json::from_str(&input_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let output = execute_responses_conversation_store_operation(&input);
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi_derive::napi]
pub fn resume_responses_conversation_payload_json(
    entry_json: String,
    response_id: String,
    submit_payload_json: String,
    request_id: Option<String>,
) -> NapiResult<String> {
    let entry: Value =
        serde_json::from_str(&entry_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let submit_payload: Value = serde_json::from_str(&submit_payload_json)
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let output = resume_responses_conversation_payload(
        &entry,
        &response_id,
        &submit_payload,
        request_id.as_deref(),
    )
    .unwrap_or_else(|reason| {
        serde_json::json!({
            "error": {
                "type": "orphan_tool_result",
                "message": reason,
                "status": 400,
                "code": "hub_pipeline_context_capture_failed",
                "origin": "client"
            }
        })
    });
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi_derive::napi]
pub fn restore_responses_continuation_payload_json(
    entry_json: String,
    incoming_payload_json: String,
    request_id: Option<String>,
    scope_key: Option<String>,
) -> NapiResult<String> {
    let entry: Value =
        serde_json::from_str(&entry_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let incoming_payload: Value = serde_json::from_str(&incoming_payload_json)
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let output = restore_responses_continuation_payload(
        &entry,
        &incoming_payload,
        request_id.as_deref(),
        scope_key.as_deref(),
    );
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi_derive::napi]
pub fn materialize_responses_continuation_payload_json(
    entry_json: String,
    incoming_payload_json: String,
    request_id: Option<String>,
    scope_key: Option<String>,
) -> NapiResult<String> {
    let entry: Value =
        serde_json::from_str(&entry_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let incoming_payload: Value = serde_json::from_str(&incoming_payload_json)
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let output = materialize_responses_continuation_payload(
        &entry,
        &incoming_payload,
        request_id.as_deref(),
        scope_key.as_deref(),
    );
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi_derive::napi]
pub fn plan_responses_handler_entry_json(
    payload_json: String,
    entry_endpoint: Option<String>,
    response_id_from_path: Option<String>,
) -> NapiResult<String> {
    let payload: Value =
        serde_json::from_str(&payload_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let output = plan_responses_handler_entry(
        &payload,
        entry_endpoint.as_deref(),
        response_id_from_path.as_deref(),
    )
    .map_err(napi::Error::from_reason)?;
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi_derive::napi]
pub fn materialize_provider_owned_submit_context_json(payload_json: String) -> NapiResult<String> {
    let payload: Value =
        serde_json::from_str(&payload_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let output = materialize_provider_owned_submit_context(&payload);
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi_derive::napi]
pub fn plan_responses_request_context_json(input_json: String) -> NapiResult<String> {
    let input: Value =
        serde_json::from_str(&input_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let output = plan_responses_request_context(&input);
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi_derive::napi]
pub fn plan_responses_continuation_request_action_json(input_json: String) -> NapiResult<String> {
    let input: Value =
        serde_json::from_str(&input_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let output = plan_responses_continuation_request_action(&input);
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}

fn read_metadata_center_section<'a>(context: &'a Value, key: &str) -> Option<&'a Value> {
    if let Some(center) = context
        .as_object()
        .and_then(|row| row.get("__metadataCenter"))
    {
        if let Some(section) = center.as_object().and_then(|row| row.get(key)) {
            return Some(section);
        }
    }
    if let Some(section) = context.as_object().and_then(|row| row.get(key)) {
        if section.is_object() {
            return Some(section);
        }
    }
    let metadata = context.as_object().and_then(|row| row.get("metadata"))?;
    if let Some(center) = metadata
        .as_object()
        .and_then(|row| row.get("__metadataCenter"))
    {
        if let Some(section) = center.as_object().and_then(|row| row.get(key)) {
            return Some(section);
        }
    }
    metadata.as_object().and_then(|row| row.get(key))
}

fn read_request_truth_field<'a>(context: &'a Value, key: &str) -> Option<&'a Value> {
    read_metadata_center_section(context, "requestTruth").and_then(|row| row.get(key))
}

fn read_runtime_control_field<'a>(context: &'a Value, key: &str) -> Option<&'a Value> {
    read_metadata_center_section(context, "runtimeControl").and_then(|row| row.get(key))
}

fn read_optional_object<'a>(value: &'a Value, key: &str) -> Option<&'a Value> {
    value.as_object().and_then(|row| row.get(key))
}

fn read_optional_u32(value: &Value, key: &str) -> Option<u32> {
    value
        .as_object()
        .and_then(|row| row.get(key))
        .and_then(Value::as_f64)
        .and_then(|n| {
            if n.is_finite() && n >= 0.0 {
                Some(n as u32)
            } else {
                None
            }
        })
}

#[napi_derive::napi]
pub fn publish_responses_record_plan_json(
    request_id: String,
    response_json: String,
    context_json: String,
    runtime_state_write_json: String,
    entry_endpoint: String,
) -> NapiResult<String> {
    let response: Value = serde_json::from_str(&response_json)
        .map_err(|e| napi::Error::from_reason(format!("invalid response JSON: {e}")))?;
    let context: Value = serde_json::from_str(&context_json)
        .map_err(|e| napi::Error::from_reason(format!("invalid context JSON: {e}")))?;
    let runtime_state_write: Value =
        serde_json::from_str(&runtime_state_write_json).unwrap_or(Value::Null);

    let session_id =
        read_request_truth_field(&context, "sessionId").and_then(|v| read_trimmed_string(Some(v)));
    let conversation_id = read_request_truth_field(&context, "conversationId")
        .and_then(|v| read_trimmed_string(Some(v)));
    let matched_port = read_request_truth_field(&context, "matchedPort")
        .and_then(|v| v.as_f64())
        .and_then(|n| {
            if n.is_finite() && n >= 0.0 {
                Some(n as u32)
            } else {
                None
            }
        });
    let routing_policy_group = read_request_truth_field(&context, "routingPolicyGroup")
        .and_then(|v| read_trimmed_string(Some(v)));
    let route_hint = read_runtime_control_field(&context, "routeHint")
        .and_then(|v| read_trimmed_string(Some(v)));
    let current_request_id = request_id.trim();
    let entry_request_id = if !current_request_id.is_empty() {
        current_request_id.to_string()
    } else {
        read_request_truth_field(&context, "requestId")
            .and_then(|v| read_trimmed_string(Some(v)))
            .filter(|value| !value.trim().is_empty())
            .or_else(|| {
                read_request_truth_field(&context, "entryRequestId")
                    .and_then(|v| read_trimmed_string(Some(v)))
            })
            .or_else(|| {
                read_request_truth_field(&context, "originalRequestId")
                    .and_then(|v| read_trimmed_string(Some(v)))
            })
            .unwrap_or_default()
    };

    let usage = read_optional_object(&runtime_state_write, "usage");
    let provider_key = usage
        .and_then(|row| row.get("providerKey"))
        .and_then(|v| read_trimmed_string(Some(v)));
    let keep_for_submit_tool_outputs = read_optional_bool(read_optional_object(
        &runtime_state_write,
        "keepForSubmitToolOutputs",
    ));

    let should_record =
        entry_endpoint == "/v1/responses" || entry_endpoint == "/v1/responses.submit_tool_outputs";
    let has_scope = session_id.is_some() || conversation_id.is_some();

    let record_args = if should_record && has_scope {
        serde_json::json!({
            "requestId": entry_request_id,
            "response": response,
            "sessionId": session_id.clone().unwrap_or_default(),
            "conversationId": conversation_id.clone().unwrap_or_default(),
            "providerKey": provider_key.clone().unwrap_or_default(),
            "entryKind": "responses",
            "continuationOwner": "relay",
            "matchedPort": matched_port,
            "routingPolicyGroup": routing_policy_group.clone().unwrap_or_default(),
            "allowScopeContinuation": true,
            "routeHint": route_hint.clone().unwrap_or_default(),
        })
    } else {
        Value::Null
    };

    let finalize_args = if should_record && has_scope {
        serde_json::json!({
            "requestId": entry_request_id,
            "keepForSubmitToolOutputs": keep_for_submit_tool_outputs.unwrap_or(false),
        })
    } else {
        Value::Null
    };

    let usage_args = if usage.is_some() {
        serde_json::json!({
            "capturedChatRequest": context.get("capturedChatRequest").cloned().unwrap_or(Value::Null),
            "usage": usage.cloned().unwrap_or(Value::Null),
        })
    } else {
        Value::Null
    };

    let output = serde_json::json!({
        "shouldRecord": should_record,
        "hasScope": has_scope,
        "recordArgs": record_args,
        "finalizeArgs": finalize_args,
        "usageArgs": usage_args,
    });
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::{
        build_responses_conversation_scope_plan, build_stop_hook_guidance_text_from_output,
        convert_responses_output_to_input_items, execute_responses_conversation_store_operation,
        materialize_provider_owned_submit_context, materialize_responses_continuation_payload,
        plan_responses_attach_entry_scopes, plan_responses_capture_pending_cleanup,
        plan_responses_captured_entry, plan_responses_continuation_lookup_by_response_id,
        plan_responses_continuation_meta, plan_responses_continuation_request_action,
        plan_responses_conversation_persistence_eligibility, plan_responses_conversation_preflight,
        plan_responses_conversation_resume_entry_match, plan_responses_conversation_retention,
        plan_responses_handler_entry, plan_responses_persisted_entry,
        plan_responses_rebind_request_id, plan_responses_record_continuation_flag,
        plan_responses_record_scope_cleanup, plan_responses_record_scope_entry_match,
        plan_responses_release_request_payload, plan_responses_request_context,
        plan_responses_scope_continuation_match, plan_responses_store_sweep,
        plan_responses_store_tokens, prepare_responses_conversation_entry,
        publish_responses_record_plan_json, restore_responses_continuation_payload,
        resume_responses_conversation_payload,
    };
    use serde_json::{json, Value};
    use std::sync::{LazyLock, Mutex};

    static RESPONSES_STORE_TEST_LOCK: LazyLock<Mutex<()>> = LazyLock::new(|| Mutex::new(()));

    fn responses_store_operation_for_test(
        persistence_file_path: &str,
        operation: &str,
        payload: Value,
    ) -> Value {
        execute_responses_conversation_store_operation(&json!({
            "operation": operation,
            "payload": payload,
            "persistenceFilePath": persistence_file_path,
        }))
    }

    fn responses_store_test_persistence_file(label: &str) -> String {
        let mut path = std::env::temp_dir();
        path.push(format!(
            "routecodex-responses-store-{}-{}-{}.json",
            label,
            std::process::id(),
            super::responses_store_now_ms()
        ));
        path.to_string_lossy().to_string()
    }

    #[test]
    fn handler_entry_plan_materializes_leading_tool_output_without_ts_tool_scan() {
        let planned = plan_responses_handler_entry(
            &json!({
                "model": "gpt-5.5",
                "input": [
                    { "type": "function_call_output", "call_id": "call_1", "output": "/tmp" },
                    { "role": "user", "content": [{ "type": "input_text", "text": "继续" }] }
                ]
            }),
            Some("/v1/responses"),
            None,
        )
        .unwrap();

        assert_eq!(planned["mode"], json!("scope_materialize"));
        assert_eq!(planned["payload"]["input"][0]["call_id"], json!("call_1"));
    }

    #[test]
    fn publish_responses_record_plan_uses_current_request_id_before_stale_request_truth() {
        let planned: Value = serde_json::from_str(
            &publish_responses_record_plan_json(
                "openai-responses-orangeai.key1-glm-5.2-20260703T120957051-453706-103"
                    .to_string(),
                serde_json::to_string(&json!({
                    "id": "resp_record_truth_1",
                    "object": "response",
                    "status": "completed",
                    "output": []
                }))
                .unwrap(),
                serde_json::to_string(&json!({
                    "requestTruth": {
                        "requestId": "openai-responses-router-gpt-5.5-20260703T120957051-453706-103",
                        "sessionId": "sess_record_truth",
                        "conversationId": "conv_record_truth",
                        "matchedPort": 5555,
                        "routingPolicyGroup": "gateway-priority-5555"
                    },
                    "runtimeControl": {
                        "routeHint": "thinking"
                    }
                }))
                .unwrap(),
                serde_json::to_string(&json!({
                    "usage": {
                        "providerKey": "orangeai.key1.glm-5.2"
                    },
                    "keepForSubmitToolOutputs": true
                }))
                .unwrap(),
                "/v1/responses".to_string(),
            )
            .unwrap(),
        )
        .unwrap();

        assert_eq!(
            planned["recordArgs"]["requestId"],
            json!("openai-responses-orangeai.key1-glm-5.2-20260703T120957051-453706-103")
        );
        assert_eq!(
            planned["finalizeArgs"]["requestId"],
            json!("openai-responses-orangeai.key1-glm-5.2-20260703T120957051-453706-103")
        );
        assert_eq!(planned["recordArgs"]["matchedPort"], json!(5555));
        assert_eq!(
            planned["recordArgs"]["routingPolicyGroup"],
            json!("gateway-priority-5555")
        );
    }

    #[test]
    fn retention_plan_clears_without_response_and_releases_keep_or_scoped_entries() {
        assert_eq!(
            plan_responses_conversation_retention(
                &json!({
                    "requestId": "req_missing_response",
                    "scopeKeys": ["entry:responses|owner:relay|session:s"]
                }),
                &json!({})
            ),
            json!({
                "action": "clear",
                "reason": "missing_response"
            })
        );

        assert_eq!(
            plan_responses_conversation_retention(
                &json!({
                    "requestId": "req_missing_scope",
                    "lastResponseId": "resp_missing_scope",
                    "scopeKeys": []
                }),
                &json!({})
            ),
            json!({
                "action": "clear",
                "reason": "missing_scope",
                "lastResponseId": "resp_missing_scope"
            })
        );

        assert_eq!(
            plan_responses_conversation_retention(
                &json!({
                    "requestId": "req_keep",
                    "lastResponseId": "resp_keep",
                    "scopeKeys": []
                }),
                &json!({ "keepForSubmitToolOutputs": true })
            ),
            json!({
                "action": "release",
                "reason": "keep_for_submit",
                "lastResponseId": "resp_keep"
            })
        );

        assert_eq!(
            plan_responses_conversation_retention(
                &json!({
                    "requestId": "req_release",
                    "lastResponseId": "resp_release",
                    "scopeKeys": ["entry:responses|owner:relay|session:s"]
                }),
                &json!({})
            ),
            json!({
                "action": "release",
                "reason": "release",
                "lastResponseId": "resp_release"
            })
        );
    }

    #[test]
    fn persistence_eligibility_plan_skips_direct_expired_missing_and_unallowed_entries() {
        assert_eq!(
            plan_responses_conversation_persistence_eligibility(
                &json!({
                    "requestId": "req_flush",
                    "lastResponseId": "resp_flush",
                    "allowContinuation": true,
                    "continuationOwner": "relay"
                }),
                &json!({ "mode": "flush" })
            ),
            json!({
                "action": "persist",
                "reason": "eligible",
                "lastResponseId": "resp_flush"
            })
        );

        assert_eq!(
            plan_responses_conversation_persistence_eligibility(
                &json!({
                    "requestId": "req_direct",
                    "lastResponseId": "resp_direct",
                    "allowContinuation": true,
                    "continuationOwner": "direct"
                }),
                &json!({ "mode": "flush" })
            ),
            json!({
                "action": "skip",
                "reason": "direct_owner",
                "lastResponseId": "resp_direct"
            })
        );

        assert_eq!(
            plan_responses_conversation_persistence_eligibility(
                &json!({
                    "requestId": "req_not_allowed",
                    "lastResponseId": "resp_not_allowed",
                    "allowContinuation": false,
                    "continuationOwner": "relay"
                }),
                &json!({ "mode": "flush" })
            ),
            json!({
                "action": "skip",
                "reason": "continuation_not_allowed",
                "lastResponseId": "resp_not_allowed"
            })
        );

        assert_eq!(
            plan_responses_conversation_persistence_eligibility(
                &json!({
                    "requestId": "req_expired",
                    "lastResponseId": "resp_expired",
                    "updatedAt": 100
                }),
                &json!({ "mode": "load", "nowMs": 1200, "ttlMs": 1000 })
            ),
            json!({
                "action": "skip",
                "reason": "expired",
                "lastResponseId": "resp_expired"
            })
        );

        assert_eq!(
            plan_responses_conversation_persistence_eligibility(
                &json!({ "requestId": "req_missing" }),
                &json!({ "mode": "load", "nowMs": 1200, "ttlMs": 1000 })
            ),
            json!({
                "action": "skip",
                "reason": "missing_response"
            })
        );
    }

    #[test]
    fn persisted_entry_plan_serializes_and_deserializes_canonical_fields() {
        let serialized = plan_responses_persisted_entry(&json!({
            "mode": "serialize",
            "entry": {
                "requestId": " req_persist ",
                "basePayload": {
                    "model": "gpt-5.5",
                    "metadata": { "client": true }
                },
                "input": [
                    { "type": "message", "role": "user" },
                    "drop"
                ],
                "allowContinuation": true,
                "releasedInputPrefix": [
                    { "type": "function_call", "call_id": "call_1" },
                    1
                ],
                "releasedPendingToolCallIds": [" call_1 ", "", 2],
                "inputPrefixDigest": " digest_1 ",
                "inputItemCount": 2,
                "tools": [
                    { "type": "function", "name": "exec_command" },
                    false
                ],
                "providerKey": " provider.a ",
                "entryKind": "chat",
                "continuationOwner": "relay",
                "createdAt": 10,
                "updatedAt": 20,
                "lastResponseId": " resp_persist ",
                "sessionId": " sess_persist ",
                "conversationId": " conv_persist ",
                "scopeKeys": [" scope-a ", "", 4],
                "portScopeKey": " port:5555 ",
                "ignored": "drop"
            }
        }));

        assert_eq!(serialized["action"], "entry");
        assert_eq!(serialized["entry"]["requestId"], json!("req_persist"));
        assert_eq!(
            serialized["entry"]["input"],
            json!([{ "type": "message", "role": "user" }])
        );
        assert_eq!(
            serialized["entry"]["releasedInputPrefix"],
            json!([{ "type": "function_call", "call_id": "call_1" }])
        );
        assert_eq!(
            serialized["entry"]["releasedPendingToolCallIds"],
            json!(["call_1"])
        );
        assert_eq!(
            serialized["entry"]["tools"],
            json!([{ "type": "function", "name": "exec_command" }])
        );
        assert_eq!(serialized["entry"]["scopeKeys"], json!(["scope-a"]));
        assert!(serialized["entry"].get("ignored").is_none());

        let deserialized = plan_responses_persisted_entry(&json!({
            "mode": "deserialize",
            "nowMs": 99,
            "entry": {
                "requestId": "req_loaded",
                "basePayload": { "model": "gpt-5.5" },
                "lastResponseId": "resp_loaded",
                "entryKind": "unknown",
                "continuationOwner": "invalid",
                "createdAt": "bad",
                "updatedAt": "bad"
            }
        }));
        assert_eq!(deserialized["action"], "entry");
        assert_eq!(deserialized["entry"]["entryKind"], json!("responses"));
        assert!(deserialized["entry"].get("continuationOwner").is_none());
        assert_eq!(deserialized["entry"]["createdAt"], json!(99));
        assert_eq!(deserialized["entry"]["updatedAt"], json!(99));
    }

    #[test]
    fn persisted_entry_plan_rejects_entries_missing_required_store_truth() {
        assert_eq!(
            plan_responses_persisted_entry(&json!({ "mode": "serialize", "entry": null }))
                ["reason"],
            "missing_entry"
        );
        assert_eq!(
            plan_responses_persisted_entry(&json!({
                "mode": "serialize",
                "entry": {
                    "basePayload": {},
                    "lastResponseId": "resp"
                }
            }))["reason"],
            "missing_request_id"
        );
        assert_eq!(
            plan_responses_persisted_entry(&json!({
                "mode": "serialize",
                "entry": {
                    "requestId": "req",
                    "lastResponseId": "resp"
                }
            }))["reason"],
            "missing_base_payload"
        );
        assert_eq!(
            plan_responses_persisted_entry(&json!({
                "mode": "serialize",
                "entry": {
                    "requestId": "req",
                    "basePayload": {}
                }
            }))["reason"],
            "missing_last_response_id"
        );
    }

    #[test]
    fn continuation_meta_plan_fills_missing_store_projection_fields_only() {
        let merged = plan_responses_continuation_meta(&json!({
            "meta": {
                "requestId": "req-current",
                "providerKey": "meta.provider",
                "entryKind": "chat"
            },
            "entry": {
                "providerKey": "entry.provider",
                "continuationOwner": "relay",
                "entryKind": "responses"
            }
        }));
        assert_eq!(merged["action"], "meta");
        assert_eq!(merged["meta"]["providerKey"], json!("meta.provider"));
        assert_eq!(merged["meta"]["entryKind"], json!("chat"));
        assert_eq!(merged["meta"]["continuationOwner"], json!("relay"));
        assert_eq!(merged["meta"]["requestId"], json!("req-current"));

        let filled = plan_responses_continuation_meta(&json!({
            "meta": {},
            "entry": {
                "providerKey": " entry.provider ",
                "continuationOwner": "direct",
                "entryKind": "messages"
            }
        }));
        assert_eq!(filled["meta"]["providerKey"], json!("entry.provider"));
        assert_eq!(filled["meta"]["continuationOwner"], json!("direct"));
        assert_eq!(filled["meta"]["entryKind"], json!("messages"));
    }

    #[test]
    fn store_tokens_plan_normalizes_trimmed_tokens_kind_and_owner() {
        assert_eq!(
            plan_responses_store_tokens(&json!({
                "providerKey": " provider.primary ",
                "fallbackProviderKey": " provider.fallback ",
                "sessionId": " sess_1 ",
                "conversationId": " conv_1 ",
                "entryKind": "messages",
                "continuationOwner": "invalid",
                "fallbackContinuationOwner": "relay"
            })),
            json!({
                "providerKey": "provider.primary",
                "sessionId": "sess_1",
                "conversationId": "conv_1",
                "entryKind": "messages",
                "continuationOwner": "relay"
            })
        );

        assert_eq!(
            plan_responses_store_tokens(&json!({
                "providerKey": " ",
                "fallbackProviderKey": " provider.fallback ",
                "entryKind": "unknown",
                "continuationOwner": "direct"
            })),
            json!({
                "providerKey": "provider.fallback",
                "sessionId": null,
                "conversationId": null,
                "entryKind": "responses",
                "continuationOwner": "direct"
            })
        );
    }

    #[test]
    fn capture_pending_cleanup_plan_detaches_only_unresolved_same_scope_entries() {
        assert_eq!(
            plan_responses_capture_pending_cleanup(&json!({
                "requestId": "req_new",
                "scopeKeys": ["entry:responses|owner:relay|session:s"],
                "candidates": [
                    {
                        "requestId": "req_old_pending",
                        "scopeKeys": ["entry:responses|owner:relay|session:s"]
                    },
                    {
                        "requestId": "req_old_done",
                        "lastResponseId": "resp_done",
                        "scopeKeys": ["entry:responses|owner:relay|session:s"]
                    },
                    {
                        "requestId": "req_other_scope",
                        "scopeKeys": ["entry:responses|owner:relay|session:other"]
                    },
                    {
                        "requestId": "req_new",
                        "scopeKeys": ["entry:responses|owner:relay|session:s"]
                    },
                    {
                        "requestId": "req_old_pending",
                        "scopeKeys": ["entry:responses|owner:relay|session:s"]
                    }
                ]
            })),
            json!({
                "action": "detach",
                "reason": "pending_scope_overlap",
                "detachRequestIds": ["req_old_pending"]
            })
        );

        assert_eq!(
            plan_responses_capture_pending_cleanup(&json!({
                "requestId": "req_new",
                "scopeKeys": [],
                "candidates": [{
                    "requestId": "req_old_pending",
                    "scopeKeys": ["entry:responses|owner:relay|session:s"]
                }]
            })),
            json!({
                "action": "noop",
                "reason": "missing_scope",
                "detachRequestIds": []
            })
        );
    }

    #[test]
    fn record_scope_cleanup_plan_detaches_only_completed_same_scope_entries() {
        assert_eq!(
            plan_responses_record_scope_cleanup(&json!({
                "requestId": "req_current",
                "scopeKeys": ["entry:responses|owner:relay|session:s"],
                "candidates": [
                    {
                        "requestId": "req_completed",
                        "lastResponseId": "resp_completed",
                        "scopeKeys": ["entry:responses|owner:relay|session:s"]
                    },
                    {
                        "requestId": "req_pending",
                        "scopeKeys": ["entry:responses|owner:relay|session:s"]
                    },
                    {
                        "requestId": "req_other_scope",
                        "lastResponseId": "resp_other",
                        "scopeKeys": ["entry:responses|owner:relay|session:other"]
                    },
                    {
                        "requestId": "req_current",
                        "lastResponseId": "resp_current",
                        "scopeKeys": ["entry:responses|owner:relay|session:s"]
                    },
                    {
                        "requestId": "req_completed",
                        "lastResponseId": "resp_completed",
                        "scopeKeys": ["entry:responses|owner:relay|session:s"]
                    }
                ]
            })),
            json!({
                "action": "detach",
                "reason": "completed_scope_overlap",
                "detachRequestIds": ["req_completed"]
            })
        );

        assert_eq!(
            plan_responses_record_scope_cleanup(&json!({
                "requestId": "req_current",
                "scopeKeys": [],
                "candidates": [{
                    "requestId": "req_completed",
                    "lastResponseId": "resp_completed",
                    "scopeKeys": ["entry:responses|owner:relay|session:s"]
                }]
            })),
            json!({
                "action": "noop",
                "reason": "missing_scope",
                "detachRequestIds": []
            })
        );
    }

    #[test]
    fn record_scope_entry_match_plan_selects_first_requested_scope_entry() {
        assert_eq!(
            plan_responses_record_scope_entry_match(&json!({
                "scopeKeys": [
                    "entry:responses|owner:relay|session:missing",
                    "entry:responses|owner:relay|session:s"
                ],
                "candidates": [
                    {
                        "scopeKey": "entry:responses|owner:relay|session:s",
                        "requestId": "req_scope"
                    },
                    {
                        "scopeKey": "entry:responses|owner:relay|session:other",
                        "requestId": "req_other"
                    }
                ]
            })),
            json!({
                "action": "select",
                "reason": "scope_match",
                "scopeKey": "entry:responses|owner:relay|session:s",
                "requestId": "req_scope"
            })
        );

        assert_eq!(
            plan_responses_record_scope_entry_match(&json!({
                "scopeKeys": ["entry:responses|owner:relay|session:s"],
                "candidates": [{
                    "scopeKey": "entry:responses|owner:relay|session:other",
                    "requestId": "req_other"
                }]
            })),
            json!({
                "action": "none",
                "reason": "no_scope_match"
            })
        );
    }

    #[test]
    fn store_sweep_plan_detaches_unresolved_and_expired_entries_by_mode() {
        assert_eq!(
            plan_responses_store_sweep(&json!({
                "mode": "clear_unresolved",
                "candidates": [
                    { "requestId": "req_pending", "updatedAt": 100 },
                    { "requestId": "req_done", "lastResponseId": "resp_done", "updatedAt": 100 },
                    { "requestId": "req_pending", "updatedAt": 200 }
                ]
            })),
            json!({
                "action": "detach",
                "reason": "unresolved",
                "detachRequestIds": ["req_pending"]
            })
        );

        assert_eq!(
            plan_responses_store_sweep(&json!({
                "mode": "prune_expired",
                "nowMs": 10_000,
                "ttlMs": 500,
                "candidates": [
                    { "requestId": "req_expired", "lastResponseId": "resp_expired", "updatedAt": 1_000 },
                    { "requestId": "req_live", "updatedAt": 9_900 }
                ]
            })),
            json!({
                "action": "detach",
                "reason": "expired",
                "detachRequestIds": ["req_expired"]
            })
        );

        assert_eq!(
            plan_responses_store_sweep(&json!({
                "mode": "prune_expired",
                "candidates": [{ "requestId": "req_live", "updatedAt": 9_900 }]
            })),
            json!({
                "action": "noop",
                "reason": "no_expired",
                "detachRequestIds": []
            })
        );
    }

    #[test]
    fn attach_entry_scopes_plan_detaches_conflicting_scope_entries() {
        let plan = plan_responses_attach_entry_scopes(&json!({
            "requestId": "req-new",
            "scopeKeys": ["scope-a", "scope-a", "scope-b", ""],
            "candidates": [
                { "scopeKey": "scope-a", "requestId": "req-old-a" },
                { "scopeKey": "scope-a", "requestId": "req-old-a" },
                { "scopeKey": "scope-b", "requestId": "req-new" },
                { "scopeKey": "scope-c", "requestId": "req-old-c" }
            ]
        }));
        assert_eq!(plan["action"], "detach_and_attach");
        assert_eq!(plan["reason"], "scope_conflict");
        assert_eq!(plan["scopeKeys"], json!(["scope-a", "scope-b"]));
        assert_eq!(plan["detachRequestIds"], json!(["req-old-a"]));

        let missing_scope = plan_responses_attach_entry_scopes(&json!({
            "requestId": "req-new",
            "scopeKeys": [],
            "candidates": []
        }));
        assert_eq!(missing_scope["action"], "noop");
        assert_eq!(missing_scope["reason"], "missing_scope");
    }

    #[test]
    fn rebind_request_id_plan_rebinds_only_unambiguous_existing_entries() {
        assert_eq!(
            plan_responses_rebind_request_id(&json!({
                "oldId": "req-old",
                "newId": "req-new",
                "oldEntryExists": true,
                "newEntryExists": false
            })),
            json!({
                "action": "rebind",
                "reason": "matched",
                "oldId": "req-old",
                "newId": "req-new"
            })
        );

        assert_eq!(
            plan_responses_rebind_request_id(&json!({
                "oldId": "req-old",
                "newId": "req-new",
                "oldEntryExists": true,
                "newEntryExists": true
            }))["reason"],
            "new_id_conflict"
        );

        assert_eq!(
            plan_responses_rebind_request_id(&json!({
                "oldId": "req-old",
                "newId": "req-old",
                "oldEntryExists": true
            }))["reason"],
            "same_id"
        );

        assert_eq!(
            plan_responses_rebind_request_id(&json!({
                "oldId": "req-old",
                "newId": "req-new",
                "oldEntryExists": false
            }))["reason"],
            "missing_old_entry"
        );
    }

    #[test]
    fn release_request_payload_plan_sets_previous_response_and_pending_ids() {
        assert_eq!(
            plan_responses_release_request_payload(&json!({
                "lastResponseId": "resp_release",
                "basePayload": {
                    "model": "gpt-5.4",
                    "previous_response_id": "old_resp"
                },
                "input": [
                    {
                        "type": "message",
                        "role": "user",
                        "content": [
                            { "type": "input_text", "text": "look" },
                            { "type": "input_image", "image_url": "data:image/png;base64,abc" }
                        ]
                    },
                    {
                        "type": "function_call",
                        "call_id": "call_release",
                        "name": "exec_command",
                        "arguments": "{\"cmd\":\"pwd\"}"
                    }
                ]
            })),
            json!({
                "basePayload": {
                    "model": "gpt-5.4",
                    "previous_response_id": "resp_release"
                },
                "releasedInputPrefix": [
                    {
                        "type": "message",
                        "role": "user",
                        "content": [
                            { "type": "input_text", "text": "look" },
                            { "type": "input_text", "text": "[Image omitted]" }
                        ]
                    },
                    {
                        "type": "function_call",
                        "call_id": "call_release",
                        "name": "exec_command",
                        "arguments": "{\"cmd\":\"pwd\"}"
                    }
                ],
                "releasedPendingToolCallIds": ["call_release"],
                "input": []
            })
        );
    }

    #[test]
    fn publish_responses_record_plan_uses_current_request_id_over_client_response_request_id() {
        let planned: Value = serde_json::from_str(
            &publish_responses_record_plan_json(
                "openai-responses-orangeai.key1-glm-5.2-20260703T120957051-453706-103"
                    .to_string(),
                serde_json::to_string(&json!({
                    "id": "resp_record_truth_2",
                    "object": "response",
                    "request_id": "openai-responses-router-gpt-5.5-20260703T120957051-453706-103",
                    "status": "completed",
                    "output": []
                }))
                .unwrap(),
                serde_json::to_string(&json!({
                    "requestTruth": {
                        "requestId": "openai-responses-orangeai.key1-glm-5.2-20260703T120957051-453706-103",
                        "sessionId": "sess_record_truth",
                        "conversationId": "conv_record_truth"
                    },
                    "runtimeControl": {}
                }))
                .unwrap(),
                serde_json::to_string(&json!({}))
                    .unwrap(),
                "/v1/responses".to_string(),
            )
            .unwrap(),
        )
        .unwrap();

        assert_eq!(
            planned["recordArgs"]["requestId"],
            json!("openai-responses-orangeai.key1-glm-5.2-20260703T120957051-453706-103")
        );
        assert_eq!(
            planned["finalizeArgs"]["requestId"],
            json!("openai-responses-orangeai.key1-glm-5.2-20260703T120957051-453706-103")
        );
    }

    #[test]
    fn handler_entry_plan_normalizes_previous_response_function_call_output_submit() {
        let planned = plan_responses_handler_entry(
            &json!({
                "model": "gpt-5.5",
                "previous_response_id": "resp_prev_1",
                "input": [
                    { "type": "message", "role": "user", "content": "ignored" },
                    { "type": "function_call_output", "call_id": "call_1", "output": { "ok": true } }
                ]
            }),
            Some("/v1/responses"),
            None,
        )
        .unwrap();

        assert_eq!(planned["mode"], json!("submit_tool_outputs"));
        assert_eq!(planned["responseId"], json!("resp_prev_1"));
        assert_eq!(planned["payload"]["response_id"], json!("resp_prev_1"));
        assert_eq!(
            planned["payload"]["tool_outputs"][0]["tool_call_id"],
            json!("call_1")
        );
    }

    #[test]
    fn handler_entry_plan_routes_submit_tool_outputs_to_native_submit_shape() {
        let planned = plan_responses_handler_entry(
            &json!({
                "model": "gpt-5.5",
                "response_id": "resp_submit_1",
                "tool_outputs": [
                    { "call_id": "call_submit_1", "output": "ok" }
                ]
            }),
            Some("/v1/responses"),
            None,
        )
        .unwrap();

        assert_eq!(planned["mode"], json!("submit_tool_outputs"));
        assert_eq!(planned["responseId"], json!("resp_submit_1"));
        assert_eq!(planned["payload"]["response_id"], json!("resp_submit_1"));
        assert_eq!(
            planned["payload"]["tool_outputs"][0]["call_id"],
            json!("call_submit_1")
        );
        assert!(planned["payload"].get("input").is_none());
    }

    #[test]
    fn provider_owned_submit_context_materializes_tool_outputs_in_rust() {
        let planned = materialize_provider_owned_submit_context(&json!({
            "response_id": "resp_submit_direct_1",
            "tool_outputs": [
                { "call_id": "call_submit_direct_1", "output": { "ok": true } },
                { "tool_call_id": "call_submit_direct_2", "output": "done" }
            ]
        }));

        assert_eq!(
            planned["payload"]["previous_response_id"],
            json!("resp_submit_direct_1")
        );
        assert_eq!(
            planned["payload"]["input"],
            json!([
                {
                    "type": "function_call_output",
                    "call_id": "call_submit_direct_1",
                    "output": "{\"ok\":true}"
                },
                {
                    "type": "function_call_output",
                    "call_id": "call_submit_direct_2",
                    "output": "done"
                }
            ])
        );
        assert_eq!(planned["context"]["input"], planned["payload"]["input"]);
    }

    #[test]
    fn provider_owned_submit_context_preserves_existing_input() {
        let planned = materialize_provider_owned_submit_context(&json!({
            "response_id": "resp_submit_direct_2",
            "tool_outputs": [
                { "call_id": "call_ignored", "output": "ignored" }
            ],
            "input": [
                { "type": "function_call_output", "call_id": "call_existing", "output": "kept" }
            ]
        }));

        assert_eq!(
            planned["payload"]["input"],
            json!([
                { "type": "function_call_output", "call_id": "call_existing", "output": "kept" }
            ])
        );
    }

    #[test]
    fn request_context_plan_materializes_provider_owned_submit_in_rust() {
        let planned = plan_responses_request_context(&json!({
            "payload": {
                "model": "gpt-5.5",
                "metadata": { "client": "data-plane" },
                "response_id": "resp_provider_submit_plan",
                "tool_outputs": [
                    { "tool_call_id": "call_provider_plan_1", "output": { "ok": true } }
                ]
            }
        }));

        assert_eq!(planned["kind"], json!("context"));
        assert_eq!(
            planned["payload"]["previous_response_id"],
            json!("resp_provider_submit_plan")
        );
        assert_eq!(
            planned["context"]["input"][0]["type"],
            json!("function_call_output")
        );
        assert_eq!(
            planned["context"]["input"][0]["call_id"],
            json!("call_provider_plan_1")
        );
        assert!(planned["payload"].get("metadata").is_none());
    }

    #[test]
    fn request_context_plan_routes_relay_submit_to_capture_payload_in_rust() {
        let planned = plan_responses_request_context(&json!({
            "payload": {
                "model": "gpt-5.5",
                "metadata": { "client": "data-plane" },
                "response_id": "resp_relay_submit_plan",
                "tool_outputs": [
                    { "tool_call_id": "call_relay_plan_1", "output": "ok" }
                ]
            },
            "resumeMeta": {
                "continuationOwner": "relay",
                "responseId": "resp_relay_submit_plan",
                "fullInput": [
                    { "type": "message", "role": "user", "content": "run pwd" },
                    { "type": "function_call", "call_id": "call_relay_plan_1", "name": "exec_command", "arguments": "{}" },
                    { "type": "function_call_output", "call_id": "call_relay_plan_1", "output": "ok" }
                ],
                "restoredTools": [
                    { "type": "function", "name": "exec_command" }
                ]
            }
        }));

        assert_eq!(planned["kind"], json!("capture_request"));
        assert_eq!(
            planned["payload"]["previous_response_id"],
            json!("resp_relay_submit_plan")
        );
        assert!(planned["payload"].get("response_id").is_none());
        assert!(planned["payload"].get("tool_outputs").is_none());
        assert!(planned["payload"].get("metadata").is_none());
        assert_eq!(planned["payload"]["input"].as_array().unwrap().len(), 3);
        assert_eq!(
            planned["payload"]["tools"][0]["name"],
            json!("exec_command")
        );
    }

    #[test]
    fn request_context_plan_routes_relay_materialized_submit_to_capture_payload_in_rust() {
        let planned = plan_responses_request_context(&json!({
            "payload": {
                "model": "gpt-5.5",
                "previous_response_id": "resp_relay_materialized_plan",
                "input": [
                    { "type": "function_call_output", "call_id": "call_relay_materialized_1", "output": "ok" }
                ]
            },
            "resumeMeta": {
                "continuationOwner": "relay",
                "fullInput": [
                    { "type": "message", "role": "user", "content": "run pwd" },
                    { "type": "function_call_output", "call_id": "call_relay_materialized_1", "output": "ok" }
                ],
                "restoredTools": [
                    { "type": "function", "name": "exec_command" }
                ]
            }
        }));

        assert_eq!(planned["kind"], json!("capture_request"));
        assert_eq!(planned["payload"]["input"].as_array().unwrap().len(), 2);
        assert_eq!(
            planned["payload"]["tools"][0]["name"],
            json!("exec_command")
        );
    }

    #[test]
    fn continuation_request_action_routes_direct_submit_in_rust() {
        let planned = plan_responses_continuation_request_action(&json!({
            "plannedEntryMode": "submit_tool_outputs",
            "entryEndpoint": "/v1/responses.submit_tool_outputs",
            "responseId": "resp_direct_1",
            "continuation": {
                "continuationOwner": "direct",
                "providerKey": "provider.key1",
                "requestId": "req_prev_1"
            }
        }));

        assert_eq!(planned["action"], json!("direct_submit"));
        assert_eq!(planned["responseId"], json!("resp_direct_1"));
        assert_eq!(
            planned["pipelineEntryEndpoint"],
            json!("/v1/responses.submit_tool_outputs")
        );
        assert_eq!(planned["resumeMeta"]["continuationOwner"], json!("direct"));
        assert_eq!(planned["resumeMeta"]["providerKey"], json!("provider.key1"));
        assert_eq!(
            planned["materializeProviderOwnedSubmitContext"],
            json!(true)
        );
    }

    #[test]
    fn continuation_request_action_routes_relay_submit_in_rust() {
        let planned = plan_responses_continuation_request_action(&json!({
            "plannedEntryMode": "submit_tool_outputs",
            "entryEndpoint": "/v1/responses.submit_tool_outputs",
            "responseId": "resp_relay_1",
            "continuation": {
                "continuationOwner": "relay",
                "requestId": "req_prev_2"
            }
        }));

        assert_eq!(planned["action"], json!("relay_submit"));
        assert_eq!(planned["responseId"], json!("resp_relay_1"));
        assert_eq!(planned["pipelineEntryEndpoint"], json!("/v1/responses"));
    }

    #[test]
    fn continuation_request_action_routes_scope_materialize_in_rust() {
        let planned = plan_responses_continuation_request_action(&json!({
            "plannedEntryMode": "scope_materialize",
            "entryEndpoint": "/v1/responses",
            "previousResponseId": "resp_scope_1",
            "continuation": {
                "continuationOwner": "relay"
            }
        }));

        assert_eq!(planned["action"], json!("relay_scope_materialize"));
        assert_eq!(planned["responseId"], json!("resp_scope_1"));
        assert_eq!(planned["continuationOwner"], json!("relay"));
    }

    #[test]
    fn continuation_request_action_rejects_submit_without_response_id() {
        let planned = plan_responses_continuation_request_action(&json!({
            "plannedEntryMode": "submit_tool_outputs",
            "entryEndpoint": "/v1/responses.submit_tool_outputs"
        }));

        assert_eq!(planned["action"], json!("client_error"));
        assert_eq!(planned["status"], json!(400));
        assert_eq!(planned["code"], json!("bad_request"));
    }

    #[test]
    fn shared_responses_conversation_prepare_and_resume_json() {
        let payload = json!({
            "model": "gpt-base",
            "stream": true,
            "metadata": { "origin": "base" },
            "tools": [{ "type": "function", "function": { "name": "exec_command" } }],
            "top_p": 0.5
        });
        let context = json!({
            "input": [
                { "type": "message", "role": "user", "content": [{ "type": "text", "text": "hi" }] },
                { "type": "function_call", "id": "fc_item_1", "call_id": "call_1", "name": "exec_command", "arguments": "{\"cmd\":\"pwd\"}" }
            ]
        });
        let entry = prepare_responses_conversation_entry(&payload, &context);
        let resumed = resume_responses_conversation_payload(
            &json!({
                "requestId": "req_1",
                "basePayload": entry.get("basePayload").cloned().unwrap_or(Value::Null),
                "input": entry.get("input").cloned().unwrap_or(Value::Null),
                "tools": Value::Null
            }),
            "resp_1",
            &json!({
                "tool_outputs": [{ "call_id": "call_1", "output": { "cmd": "pwd" } }],
                "metadata": { "resume": true },
                "stream": false
            }),
            Some("req_2"),
        )
        .unwrap();

        let payload = resumed.get("payload").and_then(Value::as_object).unwrap();
        assert_eq!(
            payload.get("model").and_then(Value::as_str),
            Some("gpt-base")
        );
        assert_eq!(payload.get("stream").and_then(Value::as_bool), Some(false));
        assert_eq!(
            payload.get("previous_response_id").and_then(Value::as_str),
            Some("resp_1")
        );
        let input = payload.get("input").and_then(Value::as_array).unwrap();
        let output_item = input.last().and_then(Value::as_object).unwrap();
        assert_eq!(
            output_item.get("id").and_then(Value::as_str),
            Some("fc_item_1")
        );
        assert_eq!(
            output_item.get("output").and_then(Value::as_str),
            Some("{\"cmd\":\"pwd\"}")
        );
        let meta = resumed.get("meta").and_then(Value::as_object).unwrap();
        assert_eq!(meta.get("toolOutputs").and_then(Value::as_u64), Some(1));
        assert_eq!(meta.get("fullInputItems").and_then(Value::as_u64), Some(3));
        let full_input = meta.get("fullInput").and_then(Value::as_array).unwrap();
        assert_eq!(full_input.len(), 3);
        assert_eq!(full_input[1]["type"], json!("function_call"));
        assert_eq!(full_input[2]["type"], json!("function_call_output"));
    }

    #[test]
    fn resume_uses_released_input_prefix_when_live_entry_input_is_already_released() {
        let resumed = resume_responses_conversation_payload(
            &json!({
                "requestId": "req_resume_released_1",
                "basePayload": {
                    "model": "gpt-5.5",
                    "store": true
                },
                "input": [],
                "releasedInputPrefix": [
                    {
                        "type": "message",
                        "role": "user",
                        "content": [{ "type": "input_text", "text": "continue working" }]
                    },
                    {
                        "type": "function_call",
                        "id": "fc_resume_released_1",
                        "call_id": "call_resume_released_1",
                        "name": "exec_command",
                        "arguments": "{\"cmd\":\"pwd\"}"
                    }
                ],
                "tools": Value::Null
            }),
            "resp_resume_released_1",
            &json!({
                "tool_outputs": [{
                    "call_id": "call_resume_released_1",
                    "output": "{\"ok\":true,\"kind\":\"stop_message_auto\"}"
                }],
                "stream": true
            }),
            Some("req_resume_released_2"),
        )
        .unwrap();

        let payload = resumed.get("payload").and_then(Value::as_object).unwrap();
        let input = payload.get("input").and_then(Value::as_array).unwrap();
        assert_eq!(input.len(), 3);
        assert_eq!(input[0]["type"], json!("message"));
        assert_eq!(input[1]["type"], json!("function_call"));
        assert_eq!(input[2]["type"], json!("function_call_output"));

        let meta = resumed.get("meta").and_then(Value::as_object).unwrap();
        assert_eq!(meta.get("fullInputItems").and_then(Value::as_u64), Some(3));
        let full_input = meta.get("fullInput").and_then(Value::as_array).unwrap();
        assert_eq!(full_input.len(), 3);
        assert_eq!(full_input[1]["call_id"], json!("call_resume_released_1"));
        assert_eq!(full_input[2]["call_id"], json!("call_resume_released_1"));
    }

    #[test]
    fn materialize_does_not_duplicate_released_prefix_when_incoming_contains_full_history() {
        let prefix = json!([
            {
                "type": "message",
                "role": "user",
                "content": [{ "type": "input_text", "text": "start" }]
            },
            {
                "type": "function_call",
                "id": "fc_1",
                "call_id": "call_1",
                "name": "exec_command",
                "arguments": "{\"cmd\":\"pwd\"}"
            },
            {
                "type": "function_call_output",
                "id": "fc_1",
                "call_id": "call_1",
                "output": "ok"
            }
        ]);
        let incoming = json!([
            {
                "type": "message",
                "role": "user",
                "content": [{ "type": "input_text", "text": "start" }]
            },
            {
                "type": "function_call",
                "id": "fc_1",
                "call_id": "call_1",
                "name": "exec_command",
                "arguments": "{\"cmd\":\"pwd\"}"
            },
            {
                "type": "function_call_output",
                "id": "fc_1",
                "call_id": "call_1",
                "output": "ok"
            },
            {
                "type": "message",
                "role": "user",
                "content": [{ "type": "input_text", "text": "continue" }]
            }
        ]);

        let materialized = materialize_responses_continuation_payload(
            &json!({
                "requestId": "req_materialize_released_1",
                "basePayload": {
                    "model": "gpt-5.5",
                    "store": true
                },
                "input": [],
                "releasedInputPrefix": prefix,
                "lastResponseId": "resp_materialize_released_1",
                "tools": Value::Null
            }),
            &json!({
                "model": "gpt-5.5",
                "input": incoming,
                "stream": true
            }),
            Some("req_materialize_released_2"),
            Some("port:4444|entry:responses|owner:relay|session:s1"),
        );

        let payload = materialized
            .get("payload")
            .and_then(Value::as_object)
            .unwrap();
        let input = payload.get("input").and_then(Value::as_array).unwrap();
        assert_eq!(input.len(), 4);
        assert_eq!(input[0]["content"][0]["text"], json!("start"));
        assert_eq!(input[3]["content"][0]["text"], json!("continue"));

        let meta = materialized.get("meta").and_then(Value::as_object).unwrap();
        assert_eq!(
            meta.get("incomingInputItems").and_then(Value::as_u64),
            Some(4)
        );
        assert_eq!(
            meta.get("continuationDeltaItems").and_then(Value::as_u64),
            Some(1)
        );
        assert_eq!(meta.get("fullInputItems").and_then(Value::as_u64), Some(4));
    }

    #[test]
    fn materialize_collapses_replayed_pending_tool_call_batches() {
        let prefix = json!([
            {
                "type": "message",
                "role": "user",
                "content": [{ "type": "input_text", "text": "start" }]
            },
            {
                "type": "reasoning",
                "id": "rs_dup_1",
                "summary": [{ "type": "summary_text", "text": "plan tools" }]
            },
            {
                "type": "message",
                "role": "assistant",
                "content": [{ "type": "output_text", "text": "I will inspect the relevant files." }]
            },
            {
                "type": "function_call",
                "id": "fc_dup_1",
                "call_id": "call_dup_1",
                "name": "exec_command",
                "arguments": "{\"cmd\":\"sed -n 1,10p note.md\"}"
            },
            {
                "type": "function_call",
                "id": "fc_dup_2",
                "call_id": "call_dup_2",
                "name": "exec_command",
                "arguments": "{\"cmd\":\"sed -n 1,10p CACHE.md\"}"
            }
        ]);
        let incoming = json!([
            {
                "type": "function_call",
                "id": "fc_dup_1",
                "call_id": "call_dup_1",
                "name": "exec_command",
                "arguments": "{\"cmd\":\"sed -n 1,10p note.md\"}"
            },
            {
                "type": "function_call",
                "id": "fc_dup_2",
                "call_id": "call_dup_2",
                "name": "exec_command",
                "arguments": "{\"cmd\":\"sed -n 1,10p CACHE.md\"}"
            },
            {
                "type": "function_call",
                "id": "fc_dup_1",
                "call_id": "call_dup_1",
                "name": "exec_command",
                "arguments": "{\"cmd\":\"sed -n 1,10p note.md\"}"
            },
            {
                "type": "function_call",
                "id": "fc_dup_2",
                "call_id": "call_dup_2",
                "name": "exec_command",
                "arguments": "{\"cmd\":\"sed -n 1,10p CACHE.md\"}"
            },
            { "type": "function_call_output", "call_id": "call_dup_1", "output": "note:first" },
            { "type": "function_call_output", "call_id": "call_dup_2", "output": "cache:first" },
            { "type": "function_call_output", "call_id": "call_dup_1", "output": "note:second" },
            { "type": "function_call_output", "call_id": "call_dup_2", "output": "cache:second" },
            {
                "type": "message",
                "role": "user",
                "content": [{ "type": "input_text", "text": "continue" }]
            }
        ]);

        let materialized = materialize_responses_continuation_payload(
            &json!({
                "requestId": "req_materialize_dup_1",
                "basePayload": {
                    "model": "gpt-5.5",
                    "store": true
                },
                "input": [],
                "releasedInputPrefix": prefix,
                "lastResponseId": "resp_materialize_dup_1",
                "releasedPendingToolCallIds": ["call_dup_1", "call_dup_2"],
                "tools": Value::Null
            }),
            &json!({
                "model": "gpt-5.5",
                "input": incoming
            }),
            Some("req_materialize_dup_2"),
            Some("port:5555|entry:responses|owner:relay|session:s_dup"),
        );

        let payload = materialized
            .get("payload")
            .and_then(Value::as_object)
            .unwrap();
        let input = payload.get("input").and_then(Value::as_array).unwrap();
        let serialized = serde_json::to_string(input).unwrap();
        assert_eq!(input.len(), 8);
        assert_eq!(input[5]["output"], json!("note:first"));
        assert_eq!(input[6]["output"], json!("cache:first"));
        assert_eq!(input[7]["content"][0]["text"], json!("continue"));
        assert!(!serialized.contains("note:second"));
        assert!(!serialized.contains("cache:second"));

        let meta = materialized.get("meta").and_then(Value::as_object).unwrap();
        assert_eq!(
            meta.get("continuationDeltaItems").and_then(Value::as_u64),
            Some(3)
        );
        assert_eq!(meta.get("fullInputItems").and_then(Value::as_u64), Some(8));
    }

    #[test]
    fn prepare_collapses_auto_projected_stopless_pairs_into_guidance_only() {
        let entry = prepare_responses_conversation_entry(
            &json!({
                "model": "gpt-5.5",
                "store": true
            }),
            &json!({
                "input": [
                    {
                        "type": "message",
                        "role": "user",
                        "content": [{ "type": "input_text", "text": "这是第三轮 stopless 恢复测试" }]
                    },
                    {
                        "type": "function_call",
                        "id": "fc_third_round_1",
                        "call_id": "call_third_round_1",
                        "name": "exec_command",
                        "arguments": "{\"cmd\":\"routecodex hook run reasoningStop --input-json \\\"{\\\\\\\"flowId\\\\\\\":\\\\\\\"stop_message_flow\\\\\\\",\\\\\\\"repeatCount\\\\\\\":1,\\\\\\\"maxRepeats\\\\\\\":3}\\\"\"}"
                    },
                    {
                        "type": "function_call_output",
                        "id": "fc_third_round_1",
                        "call_id": "call_third_round_1",
                        "output": "{\"ok\":true,\"toolName\":\"stop_message_auto\",\"flowId\":\"stop_message_flow\",\"continuationPrompt\":\"继续。\",\"repeatCount\":2,\"maxRepeats\":3,\"schemaGuidance\":{\"requiredFields\":[\"stopreason\",\"reason\",\"next_step\"],\"stopreasonValues\":{\"finished\":0,\"blocked\":1,\"continueNeeded\":2}}}"
                    },
                    {
                        "type": "function_call",
                        "id": "fc_third_round_2",
                        "call_id": "call_third_round_2",
                        "name": "exec_command",
                        "arguments": "{\"cmd\":\"routecodex hook run reasoningStop --input-json \\\"{\\\\\\\"flowId\\\\\\\":\\\\\\\"stop_message_flow\\\\\\\",\\\\\\\"repeatCount\\\\\\\":2,\\\\\\\"maxRepeats\\\\\\\":3}\\\"\"}"
                    },
                    {
                        "type": "function_call_output",
                        "id": "fc_third_round_2",
                        "call_id": "call_third_round_2",
                        "output": "{\"ok\":true,\"toolName\":\"stop_message_auto\",\"flowId\":\"stop_message_flow\",\"continuationPrompt\":\"继续。\",\"repeatCount\":3,\"maxRepeats\":3,\"schemaGuidance\":{\"requiredFields\":[\"stopreason\",\"reason\",\"next_step\"],\"stopreasonValues\":{\"finished\":0,\"blocked\":1,\"continueNeeded\":2}}}"
                    }
                ]
            }),
        );

        let input = entry.get("input").and_then(Value::as_array).unwrap();
        assert_eq!(input.len(), 2);
        assert_eq!(input[0]["type"], json!("message"));
        assert_eq!(input[1]["type"], json!("message"));
        let serialized = serde_json::to_string(input).unwrap();
        assert!(!serialized.contains("reasoningStop"));
        assert!(!serialized.contains("stop_message_auto"));
        let guidance = input[1]["content"][0]["text"].as_str().expect("guidance");
        assert!(guidance.contains("上一轮执行结果：repeatCount=3/3。"));
        assert!(guidance.contains("继续。"));
        assert!(guidance.contains("stopreason"));
    }

    #[test]
    fn resume_does_not_replay_auto_projected_stopless_pairs_from_canonical_history() {
        let entry = prepare_responses_conversation_entry(
            &json!({
                "model": "gpt-5.5",
                "store": true
            }),
            &json!({
                "input": [
                    {
                        "type": "message",
                        "role": "user",
                        "content": [{ "type": "input_text", "text": "这是第三轮 stopless 恢复测试" }]
                    },
                    {
                        "type": "function_call",
                        "id": "fc_third_round_1",
                        "call_id": "call_third_round_1",
                        "name": "exec_command",
                        "arguments": "{\"cmd\":\"routecodex hook run reasoningStop --input-json \\\"{\\\\\\\"flowId\\\\\\\":\\\\\\\"stop_message_flow\\\\\\\",\\\\\\\"repeatCount\\\\\\\":1,\\\\\\\"maxRepeats\\\\\\\":3}\\\"\"}"
                    },
                    {
                        "type": "function_call_output",
                        "id": "fc_third_round_1",
                        "call_id": "call_third_round_1",
                        "output": "{\"ok\":true,\"toolName\":\"stop_message_auto\",\"flowId\":\"stop_message_flow\",\"continuationPrompt\":\"继续。\",\"repeatCount\":2,\"maxRepeats\":3,\"schemaGuidance\":{\"requiredFields\":[\"stopreason\",\"reason\",\"next_step\"],\"stopreasonValues\":{\"finished\":0,\"blocked\":1,\"continueNeeded\":2}}}"
                    },
                    {
                        "type": "function_call",
                        "id": "fc_third_round_2",
                        "call_id": "call_third_round_2",
                        "name": "exec_command",
                        "arguments": "{\"cmd\":\"routecodex hook run reasoningStop --input-json \\\"{\\\\\\\"flowId\\\\\\\":\\\\\\\"stop_message_flow\\\\\\\",\\\\\\\"repeatCount\\\\\\\":2,\\\\\\\"maxRepeats\\\\\\\":3}\\\"\"}"
                    },
                    {
                        "type": "message",
                        "role": "assistant",
                        "content": [{ "type": "output_text", "text": "继续执行中" }]
                    }
                ]
            }),
        );

        let resumed = resume_responses_conversation_payload(
            &json!({
                "requestId": "req-stopless-1",
                "basePayload": entry.get("basePayload").cloned().unwrap_or(Value::Null),
                "input": entry.get("input").cloned().unwrap_or(Value::Null),
                "tools": Value::Null
            }),
            "resp-third-round-2",
            &json!({
                "tool_outputs": [{
                    "tool_call_id": "call_third_round_2",
                    "output": "{\"ok\":true,\"toolName\":\"stop_message_auto\",\"flowId\":\"stop_message_flow\",\"continuationPrompt\":\"继续。\",\"repeatCount\":3,\"maxRepeats\":3,\"schemaGuidance\":{\"requiredFields\":[\"stopreason\",\"reason\",\"next_step\"],\"stopreasonValues\":{\"finished\":0,\"blocked\":1,\"continueNeeded\":2}}}"
                }],
                "stream": false
            }),
            Some("req-stopless-2"),
        )
        .unwrap();

        let payload = resumed.get("payload").and_then(Value::as_object).unwrap();
        let input = payload.get("input").and_then(Value::as_array).unwrap();
        assert_eq!(input.len(), 2);
        assert_eq!(input[0]["type"], json!("message"));
        assert_eq!(input[1]["type"], json!("message"));
        let serialized = serde_json::to_string(input).unwrap();
        assert!(!serialized.contains("call_third_round_1"));
        assert!(!serialized.contains("call_third_round_2"));
        assert!(!serialized.contains("继续执行中"));
        assert!(!serialized.contains("\"type\":\"function_call_output\""));
        let guidance = input[1]["content"][0]["text"].as_str().expect("guidance");
        assert!(guidance.contains("上一轮执行结果：repeatCount=3/3。"));
        assert!(guidance.contains("继续。"));
        assert!(guidance.contains("stopreason"));

        let meta = resumed.get("meta").and_then(Value::as_object).unwrap();
        let full_input = meta.get("fullInput").and_then(Value::as_array).unwrap();
        assert_eq!(full_input.len(), 2);
        assert_eq!(full_input[0]["type"], json!("message"));
        assert_eq!(full_input[1]["type"], json!("message"));
        let full_input_serialized = serde_json::to_string(full_input).unwrap();
        assert!(!full_input_serialized.contains("call_third_round_1"));
        assert!(!full_input_serialized.contains("call_third_round_2"));
        assert!(!full_input_serialized.contains("继续执行中"));
    }

    #[test]
    fn stopless_resume_guidance_for_first_missing_schema_round_stays_short() {
        let text = build_stop_hook_guidance_text_from_output(
            "{\"ok\":true,\"toolName\":\"stop_message_auto\",\"flowId\":\"stop_message_flow\",\"repeatCount\":1,\"continuationPrompt\":\"继续。\",\"schemaFeedback\":{\"reasonCode\":\"stop_schema_missing\",\"missingFields\":[\"stopreason\"]},\"schemaGuidance\":{\"requiredFields\":[\"stopreason\"],\"stopreasonValues\":{\"finished\":0,\"blocked\":1,\"continueNeeded\":2}}}"
        );
        assert!(text.contains(
            "上一轮执行结果：repeatCount=1；reasonCode=stop_schema_missing；missingFields=stopreason。"
        ));
        assert!(text.contains("继续。"));
        assert!(text.contains("继续；按上一轮反馈补齐字段：stopreason。"));
        assert!(text.contains("按上一轮反馈补齐这些字段：stopreason"));
        assert!(!text.contains("每个字段都要写具体内容"));
    }

    #[test]
    fn stopless_resume_guidance_for_first_invalid_schema_round_renders_feedback() {
        let text = build_stop_hook_guidance_text_from_output(
            "{\"ok\":true,\"toolName\":\"stop_message_auto\",\"flowId\":\"stop_message_flow\",\"repeatCount\":1,\"continuationPrompt\":\"继续。\",\"schemaFeedback\":{\"reasonCode\":\"stop_schema_next_step_missing\",\"missingFields\":[\"next_step\"]}}"
        );
        assert!(text.contains("上一轮执行结果：repeatCount=1；reasonCode=stop_schema_next_step_missing；missingFields=next_step。"));
        assert!(text.contains("继续；按上一轮反馈补齐 next_step"));
        assert!(text.contains("按上一轮反馈补齐这些字段：next_step"));
    }

    #[test]
    fn stopless_resume_guidance_accepts_continue_next_step_with_empty_missing_fields() {
        let text = build_stop_hook_guidance_text_from_output(
            "{\"ok\":true,\"toolName\":\"stop_message_auto\",\"flowId\":\"stop_message_flow\",\"repeatCount\":1,\"maxRepeats\":3,\"continuationPrompt\":\"继续。\",\"schemaFeedback\":{\"reasonCode\":\"stop_schema_continue_next_step\",\"missingFields\":[]},\"input\":{\"flowId\":\"stop_message_flow\",\"repeatCount\":1,\"maxRepeats\":3,\"triggerHint\":\"non_terminal_schema\"}}"
        );
        assert_eq!(text, "继续。");
        assert!(!text.contains("任务还没收尾，继续执行你给出的 next_step"));
        assert!(
            !text.contains("STOPLESS_CLI_RESULT_MALFORMED"),
            "continue_next_step with empty missing fields is legal: {text}"
        );
    }

    #[test]
    fn stopless_resume_guidance_accepts_minimal_no_schema_cli_output_without_malformed_warning() {
        let text = build_stop_hook_guidance_text_from_output(
            "{\"ok\":true,\"toolName\":\"stop_message_auto\",\"flowId\":\"stop_message_flow\",\"repeatCount\":1,\"maxRepeats\":3,\"continuationPrompt\":\"继续。\",\"input\":{\"flowId\":\"stop_message_flow\",\"repeatCount\":1,\"maxRepeats\":3,\"triggerHint\":\"no_schema\"}}"
        );
        assert!(text.contains("上一轮执行结果：repeatCount=1/3。"));
        assert!(text.contains("继续。"));
        assert!(
            !text.contains("STOPLESS_CLI_RESULT_MALFORMED"),
            "minimal no_schema CLI output is legal and must not be treated as malformed: {text}"
        );
    }

    #[test]
    fn stopless_resume_guidance_accepts_minimal_non_terminal_schema_cli_output() {
        let text = build_stop_hook_guidance_text_from_output(
            "{\"ok\":true,\"kind\":\"stop_message_auto\",\"tool\":\"stop_message_auto\",\"summary\":\"继续\",\"toolName\":\"stop_message_auto\",\"flowId\":\"stop_message_flow\",\"routeHint\":\"thinking\",\"continuationPrompt\":\"继续。\",\"repeatCount\":1,\"maxRepeats\":3,\"sessionId\":\"stopless-live-1782780421308\",\"requestId\":\"openai-responses-XLC.key1-glm-5.2-20260630T084701341-424854-5137\",\"input\":{\"flowId\":\"stop_message_flow\",\"maxRepeats\":3,\"repeatCount\":1,\"triggerHint\":\"non_terminal_schema\"}}"
        );
        assert!(text.contains("上一轮执行结果：repeatCount=1/3。"));
        assert!(text.contains("继续。"));
        assert!(
            !text.contains("STOPLESS_CLI_RESULT_MALFORMED"),
            "minimal non_terminal_schema CLI output is legal and must not be treated as malformed: {text}"
        );
    }

    #[test]
    fn stopless_resume_guidance_for_second_missing_schema_round_must_expand_branching() {
        let text = build_stop_hook_guidance_text_from_output(
            "{\"ok\":true,\"toolName\":\"stop_message_auto\",\"flowId\":\"stop_message_flow\",\"repeatCount\":2,\"continuationPrompt\":\"继续。\",\"schemaFeedback\":{\"reasonCode\":\"stop_schema_missing\",\"missingFields\":[\"stopreason\"]},\"schemaGuidance\":{\"requiredFields\":[\"stopreason\"],\"sample\":\"{\\\"stopreason\\\":2,\\\"reason\\\":\\\"当前状态\\\",\\\"current_goal\\\":\\\"当前目标\\\",\\\"has_evidence\\\":0,\\\"evidence\\\":\\\"\\\",\\\"next_step\\\":\\\"下一步动作\\\",\\\"needs_user_input\\\":false}\",\"stopreasonValues\":{\"finished\":0,\"blocked\":1,\"continueNeeded\":2}}}"
        );
        assert!(text.contains("上一轮执行结果：repeatCount=2；reasonCode=stop_schema_missing；missingFields=stopreason。"));
        assert!(text.contains("继续；按上一轮反馈补齐字段：stopreason。"));
        assert!(text.contains("按上一轮反馈补齐这些字段：stopreason"));
        assert!(text.contains("stopreason=0 需要 has_evidence=1 且 evidence 非空"));
        assert!(text.contains("stopreason=1 需要 reason 非空"));
        assert!(text.contains("stopreason=2 必须写 next_step"));
        assert!(text.contains("needs_user_input=true 时 next_step 必须直接写要问用户的问题"));
        assert!(text.contains("最小可复制样本："));
        assert!(!text.contains("每个字段都要写具体内容"));
    }

    #[test]
    fn stopless_resume_guidance_rejects_unknown_feedback_without_default_guidance() {
        let text = build_stop_hook_guidance_text_from_output(
            "{\"ok\":true,\"toolName\":\"stop_message_auto\",\"flowId\":\"stop_message_flow\",\"repeatCount\":2,\"schemaFeedback\":{\"reasonCode\":\"stop_schema_unknown_future_reason\",\"missingFields\":[\"next_step\"]}}"
        );
        assert!(text.contains("STOPLESS_CLI_RESULT_MALFORMED"));
        assert!(text.contains("没有注册的修复引导"));
        assert!(!text.contains("triggerHint"));
        assert!(!text.contains("no_schema"));
        assert!(!text.contains("本轮缺失字段：stopreason, reason, has_evidence"));
    }

    #[test]
    fn stopless_resume_guidance_rejects_incomplete_feedback_without_default_guidance() {
        let text = build_stop_hook_guidance_text_from_output(
            "{\"ok\":true,\"toolName\":\"stop_message_auto\",\"flowId\":\"stop_message_flow\",\"repeatCount\":2,\"schemaFeedback\":{\"reasonCode\":\"stop_schema_next_step_missing\",\"missingFields\":[]}}"
        );
        assert!(text.contains("STOPLESS_CLI_RESULT_MALFORMED"));
        assert!(text.contains("schemaFeedback.reasonCode/missingFields 不完整"));
        assert!(!text.contains("no_schema"));
        assert!(!text.contains("本轮缺失字段：stopreason, reason, has_evidence"));
    }

    #[test]
    fn prepare_persists_responses_legal_tools_and_history_items() {
        let entry = prepare_responses_conversation_entry(
            &json!({
                "model": "gpt-base",
                "tools": [{
                    "type": "function",
                    "function": {
                        "name": "exec_command",
                        "description": "run command",
                        "parameters": { "type": "object", "properties": {} }
                    }
                }]
            }),
            &json!({
                "input": [
                    {
                        "type": "function_call",
                        "id": "fc_1",
                        "call_id": "call_1",
                        "status": "in_progress",
                        "function": { "name": "exec_command", "arguments": "{\"cmd\":\"pwd\"}" },
                        "content": [{ "type": "output_text", "text": "illegal" }],
                        "role": "assistant"
                    },
                    {
                        "type": "function_call_output",
                        "id": "fc_1",
                        "call_id": "call_1",
                        "status": "completed",
                        "output": "ok",
                        "content": [{ "type": "output_text", "text": "illegal" }]
                    }
                ]
            }),
        );

        assert_eq!(entry["basePayload"]["tools"][0]["type"], json!("function"));
        assert_eq!(
            entry["basePayload"]["tools"][0]["function"]["name"],
            json!("exec_command")
        );
        assert!(entry.get("tools").is_none());
        assert_eq!(entry["input"][0]["type"], json!("function_call"));
        assert_eq!(entry["input"][0]["name"], json!("exec_command"));
        assert!(entry["input"][0].get("function").is_none());
        assert!(entry["input"][0].get("content").is_none());
        assert!(entry["input"][0].get("role").is_none());
        assert!(entry["input"][0].get("status").is_none());
        assert_eq!(entry["input"][1]["type"], json!("function_call_output"));
        assert_eq!(entry["input"][1]["output"], json!("ok"));
        assert!(entry["input"][1].get("content").is_none());
        assert!(entry["input"][1].get("status").is_none());
    }

    #[test]
    fn converts_required_action_tool_calls_to_pending_function_call_items() {
        let response = json!({
            "id": "resp_required_action_1",
            "object": "response",
            "status": "requires_action",
            "required_action": {
                "type": "submit_tool_outputs",
                "submit_tool_outputs": {
                    "tool_calls": [{
                        "id": "call_required_action_1",
                        "type": "function",
                        "function": {
                            "name": "exec_command",
                            "arguments": "{\"cmd\":\"pwd\"}"
                        }
                    }]
                }
            }
        });
        let items = convert_responses_output_to_input_items(&response)
            .as_array()
            .cloned()
            .unwrap_or_default();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0]["type"], json!("function_call"));
        assert_eq!(items[0]["call_id"], json!("call_required_action_1"));
        assert_eq!(items[0]["name"], json!("exec_command"));
        assert_eq!(items[0]["arguments"], json!("{\"cmd\":\"pwd\"}"));
    }

    #[test]
    fn does_not_create_pending_function_call_when_required_action_has_no_tool_calls() {
        let response = json!({
            "id": "resp_empty_required_action_1",
            "object": "response",
            "status": "requires_action",
            "required_action": {
                "type": "submit_tool_outputs",
                "submit_tool_outputs": { "tool_calls": [] }
            }
        });
        let items = convert_responses_output_to_input_items(&response)
            .as_array()
            .cloned()
            .unwrap_or_default();
        assert!(items.is_empty());
    }

    #[test]
    fn restore_never_emits_function_call_output_content_from_persisted_history() {
        let restored = restore_responses_continuation_payload(
            &json!({
                "requestId": "req_prev",
                "lastResponseId": "resp_prev",
                "input": [
                    { "type": "function_call", "id": "fc_1", "call_id": "call_1", "name": "exec_command", "arguments": "{\"cmd\":\"pwd\"}" },
                    {
                        "type": "function_call_output",
                        "id": "fc_1",
                        "call_id": "call_1",
                        "output": "ok",
                        "content": [{ "type": "output_text", "text": "historical leak" }]
                    }
                ]
            }),
            &json!({
                "model": "gpt-5.5",
                "stream": true,
                "input": [
                    { "type": "function_call", "id": "fc_1", "call_id": "call_1", "name": "exec_command", "arguments": "{\"cmd\":\"pwd\"}" },
                    {
                        "type": "function_call_output",
                        "id": "fc_1",
                        "call_id": "call_1",
                        "output": "ok",
                        "content": [{ "type": "output_text", "text": "historical leak" }]
                    },
                    { "type": "message", "role": "user", "content": [{ "type": "input_text", "text": "next" }] }
                ]
            }),
            Some("req_now"),
            Some("session:sess-1"),
        );

        let payload = restored.get("payload").and_then(Value::as_object).unwrap();
        let input = payload.get("input").and_then(Value::as_array).unwrap();
        assert_eq!(input.len(), 1);
        assert_eq!(input[0]["type"], json!("message"));
        let serialized = serde_json::to_string(payload).unwrap();
        assert!(!serialized.contains("historical leak"));
    }

    #[test]
    fn convert_responses_output_to_input_items_rewrites_output_text_message_content_to_input_text()
    {
        let response = json!({
            "output": [
                {
                    "type": "message",
                    "role": "assistant",
                    "content": [
                        { "type": "output_text", "text": "world" },
                        { "type": "commentary", "text": "progress" }
                    ]
                }
            ]
        });

        let items = convert_responses_output_to_input_items(&response)
            .as_array()
            .cloned()
            .unwrap_or_default();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0]["type"], json!("message"));
        assert_eq!(items[0]["role"], json!("assistant"));
        assert_eq!(items[0]["content"][0]["type"], json!("input_text"));
        assert_eq!(items[0]["content"][0]["text"], json!("world"));
        assert_eq!(items[0]["content"][1]["type"], json!("input_text"));
        assert_eq!(items[0]["content"][1]["text"], json!("progress"));
        let serialized = serde_json::to_string(&items).unwrap();
        assert!(!serialized.contains("\"output_text\""));
        assert!(!serialized.contains("\"commentary\""));
    }

    #[test]
    fn restore_matches_prefix_when_stored_input_text_and_incoming_replays_output_text() {
        let restored = restore_responses_continuation_payload(
            &json!({
                "requestId": "req_prev",
                "lastResponseId": "resp_prev",
                "input": [
                    { "type": "message", "role": "user", "content": [{ "type": "input_text", "text": "hello" }] },
                    { "type": "message", "role": "assistant", "content": [{ "type": "input_text", "text": "world" }] }
                ]
            }),
            &json!({
                "model": "gpt-5.4",
                "stream": true,
                "input": [
                    { "type": "message", "role": "user", "content": [{ "type": "input_text", "text": "hello" }] },
                    { "type": "message", "role": "assistant", "content": [{ "type": "output_text", "text": "world" }] },
                    { "type": "message", "role": "user", "content": [{ "type": "input_text", "text": "next" }] }
                ]
            }),
            Some("req_now"),
            Some("session:sess-1"),
        );

        let payload = restored.get("payload").and_then(Value::as_object).unwrap();
        assert_eq!(
            payload.get("previous_response_id").and_then(Value::as_str),
            Some("resp_prev")
        );
        let input = payload.get("input").and_then(Value::as_array).unwrap();
        assert_eq!(input.len(), 1);
        assert_eq!(input[0]["content"][0]["text"].as_str(), Some("next"));
    }

    #[test]
    fn resume_preserves_historical_attachments_until_provider_send_completes() {
        let payload = json!({
            "model": "gpt-base",
            "stream": true,
            "tools": [{ "type": "function", "function": { "name": "view_image" } }]
        });
        let context = json!({
            "input": [
                {
                    "type": "message",
                    "role": "user",
                    "content": [
                        { "type": "input_image", "image_url": "data:image/png;base64,HISTORY" },
                        { "type": "input_text", "text": "look" }
                    ]
                },
                { "type": "function_call", "id": "fc_view_1", "call_id": "call_view_1", "name": "view_image", "arguments": "{\"path\":\"/tmp/current.png\"}" }
            ]
        });
        let entry = prepare_responses_conversation_entry(&payload, &context);

        let resumed = resume_responses_conversation_payload(
            &json!({
                "requestId": "req_1",
                "basePayload": entry.get("basePayload").cloned().unwrap_or(Value::Null),
                "input": entry.get("input").cloned().unwrap_or(Value::Null),
                "tools": Value::Null
            }),
            "resp_1",
            &json!({
                "tool_outputs": [{
                    "call_id": "call_view_1",
                    "output": "[{\"type\":\"input_image\",\"image_url\":\"data:image/png;base64,CURRENT\"}]"
                }],
                "stream": true
            }),
            Some("req_2"),
        )
        .unwrap();

        let serialized = serde_json::to_string(resumed.get("payload").unwrap()).unwrap();
        assert!(serialized.contains("data:image/png;base64,HISTORY"));
        assert!(!serialized.contains("[Image omitted]"));
        assert!(serialized.contains("data:image/png;base64,CURRENT"));
    }

    #[test]
    fn resume_reads_restored_tools_from_full_base_payload_when_entry_tools_are_absent() {
        let entry = prepare_responses_conversation_entry(
            &json!({
                "model": "gpt-5.4",
                "store": false,
                "tools": [{
                    "type": "function",
                    "function": {
                        "name": "exec_command",
                        "parameters": { "type": "object", "properties": {} }
                    }
                }]
            }),
            &json!({
                "input": [
                    {
                        "type": "message",
                        "role": "user",
                        "content": [{ "type": "input_text", "text": "继续执行" }]
                    },
                    {
                        "type": "function_call",
                        "id": "fc_restore_tools_1",
                        "call_id": "call_restore_tools_1",
                        "name": "exec_command",
                        "arguments": "{\"cmd\":\"pwd\"}"
                    }
                ]
            }),
        );

        assert!(entry.get("tools").is_none());
        assert_eq!(
            entry["basePayload"]["tools"][0]["function"]["name"],
            json!("exec_command")
        );

        let resumed = resume_responses_conversation_payload(
            &json!({
                "requestId": "req_restore_tools_1",
                "basePayload": entry.get("basePayload").cloned().unwrap_or(Value::Null),
                "input": entry.get("input").cloned().unwrap_or(Value::Null)
            }),
            "resp_restore_tools_1",
            &json!({
                "tool_outputs": [{
                    "call_id": "call_restore_tools_1",
                    "output": "{\"ok\":true}"
                }]
            }),
            Some("req_restore_tools_2"),
        )
        .unwrap();

        let meta = resumed.get("meta").and_then(Value::as_object).unwrap();
        assert_eq!(meta["restoredTools"][0]["type"], json!("function"));
        assert_eq!(
            meta["restoredTools"][0]["function"]["name"],
            json!("exec_command")
        );
    }

    #[test]
    fn resume_rejects_unknown_tool_output_id_before_provider_send() {
        let payload = json!({
            "model": "gpt-base",
            "tools": [{ "type": "function", "function": { "name": "exec_command" } }]
        });
        let context = json!({
            "input": [
                { "type": "message", "role": "user", "content": [{ "type": "input_text", "text": "hi" }] },
                { "type": "function_call", "id": "fc_expected", "call_id": "call_expected", "name": "exec_command", "arguments": "{\"cmd\":\"pwd\"}" }
            ]
        });
        let entry = prepare_responses_conversation_entry(&payload, &context);

        let error = resume_responses_conversation_payload(
            &json!({
                "requestId": "req_1",
                "basePayload": entry.get("basePayload").cloned().unwrap_or(Value::Null),
                "input": entry.get("input").cloned().unwrap_or(Value::Null),
                "tools": Value::Null
            }),
            "resp_1",
            &json!({
                "tool_outputs": [{
                    "call_id": "call_function_snr978zyv21w_1",
                    "output": "/Users/fanzhang/Documents/github/routecodex"
                }]
            }),
            Some("req_2"),
        )
        .expect_err("unknown tool output id must fail fast");

        assert!(error.contains("call_function_snr978zyv21w_1"));
        assert!(error.contains("does not match any pending function_call"));
    }

    #[test]
    fn restores_plain_responses_continuation_when_incoming_input_replays_exact_prefix() {
        let restored = restore_responses_continuation_payload(
            &json!({
                "requestId": "req_prev",
                "lastResponseId": "resp_prev",
                "tools": [{ "type": "function", "function": { "name": "exec_command" } }],
                "input": [
                    { "type": "message", "role": "user", "content": [{ "type": "input_text", "text": "hi" }] },
                    { "type": "message", "role": "assistant", "content": [{ "type": "output_text", "text": "hello" }] }
                ]
            }),
            &json!({
                "model": "gpt-5.3-codex",
                "stream": true,
                "metadata": { "session_id": "sess-1" },
                "input": [
                    { "type": "message", "role": "user", "content": [{ "type": "input_text", "text": "hi" }] },
                    { "type": "message", "role": "assistant", "content": [{ "type": "output_text", "text": "hello" }] },
                    { "type": "message", "role": "user", "content": [{ "type": "input_text", "text": "next" }] }
                ]
            }),
            Some("req_now"),
            Some("session:sess-1"),
        );

        let payload = restored.get("payload").and_then(Value::as_object).unwrap();
        assert_eq!(
            payload.get("previous_response_id").and_then(Value::as_str),
            Some("resp_prev")
        );
        let input = payload.get("input").and_then(Value::as_array).unwrap();
        assert_eq!(input.len(), 1);
        assert_eq!(input[0]["content"][0]["text"].as_str(), Some("next"));
        let meta = restored.get("meta").and_then(Value::as_object).unwrap();
        assert_eq!(
            meta.get("scopeKey").and_then(Value::as_str),
            Some("session:sess-1")
        );
    }

    #[test]
    fn restore_preserves_current_delta_without_history_normalization() {
        let current_delta = json!({
            "type": "function_call",
            "id": "fc_current",
            "call_id": "call_current",
            "name": "exec_command",
            "arguments": "{\"cmd\":\"date\"}",
            "x_current_request_truth": "must-stay"
        });
        let restored = restore_responses_continuation_payload(
            &json!({
                "requestId": "req_prev",
                "lastResponseId": "resp_prev",
                "input": [
                    { "type": "message", "role": "user", "content": [{ "type": "input_text", "text": "hi" }] },
                    { "type": "message", "role": "assistant", "content": [{ "type": "input_text", "text": "hello" }] }
                ]
            }),
            &json!({
                "model": "gpt-5.3-codex",
                "input": [
                    { "type": "message", "role": "user", "content": [{ "type": "input_text", "text": "hi" }] },
                    { "type": "message", "role": "assistant", "content": [{ "type": "output_text", "text": "hello" }] },
                    current_delta.clone()
                ]
            }),
            Some("req_now"),
            Some("session:sess-1"),
        );

        let payload = restored.get("payload").and_then(Value::as_object).unwrap();
        let input = payload.get("input").and_then(Value::as_array).unwrap();
        assert_eq!(input, &vec![current_delta.clone()]);

        let meta = restored.get("meta").and_then(Value::as_object).unwrap();
        let full_input = meta.get("fullInput").and_then(Value::as_array).unwrap();
        assert_eq!(full_input[2], current_delta);
    }

    #[test]
    fn direct_owned_scope_restore_does_not_reinject_tools() {
        let restored = restore_responses_continuation_payload(
            &json!({
                "requestId": "req_prev_direct",
                "lastResponseId": "resp_prev_direct",
                "continuationOwner": "direct",
                "providerKey": "asxs.crsa.gpt-5.4",
                "tools": [{
                    "type": "function",
                    "function": {
                        "name": "apply_patch",
                        "parameters": { "type": "object" }
                    }
                }],
                "input": [
                    { "type": "message", "role": "user", "content": [{ "type": "input_text", "text": "first turn" }] },
                    { "type": "message", "role": "assistant", "content": [{ "type": "output_text", "text": "done" }] }
                ]
            }),
            &json!({
                "model": "gpt-5.4",
                "input": [
                    { "type": "message", "role": "user", "content": [{ "type": "input_text", "text": "first turn" }] },
                    { "type": "message", "role": "assistant", "content": [{ "type": "output_text", "text": "done" }] },
                    { "type": "message", "role": "user", "content": [{ "type": "input_text", "text": "second turn" }] }
                ]
            }),
            Some("req_now_direct"),
            Some("session:sess-direct"),
        );

        let payload = restored.get("payload").and_then(Value::as_object).unwrap();
        assert_eq!(
            payload.get("previous_response_id").and_then(Value::as_str),
            Some("resp_prev_direct")
        );
        assert!(payload.get("tools").is_none());
        let input = payload.get("input").and_then(Value::as_array).unwrap();
        assert_eq!(input.len(), 1);
        assert_eq!(input[0]["content"][0]["text"].as_str(), Some("second turn"));
    }

    #[test]
    fn does_not_restore_plain_continuation_when_prefix_does_not_match() {
        let restored = restore_responses_continuation_payload(
            &json!({
                "requestId": "req_prev",
                "lastResponseId": "resp_prev",
                "input": [
                    { "type": "message", "role": "user", "content": [{ "type": "input_text", "text": "hi" }] }
                ]
            }),
            &json!({
                "input": [
                    { "type": "message", "role": "user", "content": [{ "type": "input_text", "text": "different" }] },
                    { "type": "message", "role": "user", "content": [{ "type": "input_text", "text": "next" }] }
                ]
            }),
            Some("req_now"),
            Some("session:sess-1"),
        );

        assert!(restored.is_null());
    }

    #[test]
    fn materialize_plain_continuation_only_when_incoming_is_pure_delta() {
        let materialized = materialize_responses_continuation_payload(
            &json!({
                "requestId": "req_prev",
                "lastResponseId": "resp_prev",
                "input": [
                    { "type": "message", "role": "user", "content": [{ "type": "input_text", "text": "hi" }] },
                    { "type": "message", "role": "assistant", "content": [{ "type": "output_text", "text": "hello" }] }
                ]
            }),
            &json!({
                "model": "gpt-5.3-codex",
                "stream": true,
                "input": [
                    { "type": "message", "role": "user", "content": [{ "type": "input_text", "text": "next" }] }
                ]
            }),
            Some("req_now"),
            Some("session:sess-1"),
        );

        let payload = materialized
            .get("payload")
            .and_then(Value::as_object)
            .unwrap();
        let input = payload.get("input").and_then(Value::as_array).unwrap();
        assert_eq!(input.len(), 3);
        assert_eq!(input[2]["content"][0]["text"].as_str(), Some("next"));
    }

    #[test]
    fn materialize_plain_continuation_keeps_persisted_prefix_semantics_and_applies_current_delta_fields_only(
    ) {
        let entry = json!({
            "requestId": "req_prev",
            "lastResponseId": "resp_prev",
            "input": [
                { "type": "message", "role": "user", "content": [{ "type": "input_text", "text": "hi" }] },
                { "type": "message", "role": "assistant", "content": [{ "type": "output_text", "text": "hello" }] }
            ],
            "basePayload": { "model": "cached-model" }
        });
        let first_prefix_before = entry["input"][0].clone();
        let materialized = materialize_responses_continuation_payload(
            &entry,
            &json!({
                "model": "current-route-model",
                "stream": true,
                "input": [
                    { "type": "message", "role": "user", "content": [{ "type": "input_text", "text": "next" }] }
                ]
            }),
            Some("req_now"),
            Some("session:sess-1"),
        );

        let payload = materialized
            .get("payload")
            .and_then(Value::as_object)
            .unwrap();
        assert_eq!(
            payload.get("model").and_then(Value::as_str),
            Some("current-route-model")
        );
        let input = payload.get("input").and_then(Value::as_array).unwrap();
        assert_eq!(input.len(), 3);
        assert_eq!(input[0], first_prefix_before);
        assert_eq!(input[2]["content"][0]["text"].as_str(), Some("next"));
        assert_eq!(entry["basePayload"]["model"].as_str(), Some("cached-model"));
        assert_eq!(entry["input"][0], first_prefix_before);
    }

    #[test]
    fn materialize_preserves_saved_prefix_and_current_delta_without_history_normalization() {
        let saved_prefix = json!({
            "type": "function_call_output",
            "id": "fc_done",
            "call_id": "call_done",
            "output": "/tmp",
            "x_saved_store_truth": "must-stay"
        });
        let current_delta = json!({
            "type": "function_call",
            "id": "fc_current",
            "call_id": "call_current",
            "name": "exec_command",
            "arguments": "{\"cmd\":\"date\"}",
            "x_current_request_truth": "must-stay"
        });
        let materialized = materialize_responses_continuation_payload(
            &json!({
                "requestId": "req_prev",
                "lastResponseId": "resp_prev",
                "input": [
                    { "type": "function_call", "id": "fc_done", "call_id": "call_done", "name": "exec_command", "arguments": "{\"cmd\":\"pwd\"}" },
                    saved_prefix.clone()
                ]
            }),
            &json!({
                "model": "current-route-model",
                "stream": true,
                "input": [current_delta.clone()]
            }),
            Some("req_now"),
            Some("session:sess-1"),
        );

        let payload = materialized
            .get("payload")
            .and_then(Value::as_object)
            .unwrap();
        let input = payload.get("input").and_then(Value::as_array).unwrap();
        assert_eq!(input[1], saved_prefix);
        assert_eq!(input[2], current_delta);

        let meta = materialized.get("meta").and_then(Value::as_object).unwrap();
        let full_input = meta.get("fullInput").and_then(Value::as_array).unwrap();
        assert_eq!(full_input[1], saved_prefix);
        assert_eq!(full_input[2], current_delta);
    }

    #[test]
    fn does_not_materialize_plain_continuation_when_prefix_has_pending_tool_call_without_leading_output(
    ) {
        let materialized = materialize_responses_continuation_payload(
            &json!({
                "requestId": "req_prev",
                "lastResponseId": "resp_prev",
                "input": [
                    { "type": "message", "role": "user", "content": [{ "type": "input_text", "text": "run pwd" }] },
                    { "type": "function_call", "id": "fc_call_1", "call_id": "call_1", "name": "exec_command", "arguments": "{\"cmd\":\"pwd\"}" }
                ]
            }),
            &json!({
                "model": "gpt-5.3-codex",
                "stream": true,
                "input": [
                    { "type": "message", "role": "user", "content": [{ "type": "input_text", "text": "继续" }] }
                ]
            }),
            Some("req_now"),
            Some("session:sess-1"),
        );

        assert!(materialized.is_null());
    }

    #[test]
    fn materializes_plain_continuation_when_leading_tool_output_consumes_pending_tool_call() {
        let materialized = materialize_responses_continuation_payload(
            &json!({
                "requestId": "req_prev",
                "lastResponseId": "resp_prev",
                "input": [
                    { "type": "message", "role": "user", "content": [{ "type": "input_text", "text": "run pwd" }] },
                    { "type": "function_call", "id": "fc_call_1", "call_id": "call_1", "name": "exec_command", "arguments": "{\"cmd\":\"pwd\"}" }
                ]
            }),
            &json!({
                "model": "gpt-5.3-codex",
                "stream": true,
                "input": [
                    { "type": "function_call_output", "call_id": "call_1", "output": "/tmp" },
                    { "type": "message", "role": "user", "content": [{ "type": "input_text", "text": "继续" }] }
                ]
            }),
            Some("req_now"),
            Some("session:sess-1"),
        );

        let payload = materialized
            .get("payload")
            .and_then(Value::as_object)
            .unwrap();
        let input = payload.get("input").and_then(Value::as_array).unwrap();
        assert_eq!(input.len(), 4);
        assert_eq!(input[1]["type"].as_str(), Some("function_call"));
        assert_eq!(input[2]["type"].as_str(), Some("function_call_output"));
        assert_eq!(input[3]["content"][0]["text"].as_str(), Some("继续"));
    }

    #[test]
    fn does_not_materialize_plain_continuation_when_incoming_partially_replays_prefix() {
        let materialized = materialize_responses_continuation_payload(
            &json!({
                "requestId": "req_prev",
                "lastResponseId": "resp_prev",
                "input": [
                    { "type": "message", "role": "user", "content": [{ "type": "input_text", "text": "hi" }] },
                    { "type": "message", "role": "assistant", "content": [{ "type": "output_text", "text": "hello" }] },
                    { "type": "message", "role": "assistant", "content": [{ "type": "output_text", "text": "tool result summary" }] }
                ]
            }),
            &json!({
                "model": "gpt-5.3-codex",
                "stream": true,
                "input": [
                    { "type": "message", "role": "user", "content": [{ "type": "input_text", "text": "hi" }] },
                    { "type": "message", "role": "assistant", "content": [{ "type": "output_text", "text": "hello" }] },
                    { "type": "message", "role": "user", "content": [{ "type": "input_text", "text": "next" }] }
                ]
            }),
            Some("req_now"),
            Some("session:sess-1"),
        );

        assert!(materialized.is_null());
    }

    #[test]
    fn does_not_materialize_plain_continuation_when_incoming_replays_completed_call_after_offset() {
        let materialized = materialize_responses_continuation_payload(
            &json!({
                "requestId": "req_prev",
                "lastResponseId": "resp_prev",
                "input": [
                    { "type": "function_call", "id": "fc_call_1", "call_id": "call_1", "name": "exec_command", "arguments": "{\"cmd\":\"pwd\"}" },
                    { "type": "function_call_output", "call_id": "call_1", "output": "/tmp" }
                ],
                "basePayload": { "model": "gpt-test" }
            }),
            &json!({
                "model": "gpt-test",
                "input": [
                    { "type": "message", "role": "user", "content": [{ "type": "input_text", "text": "old prompt" }] },
                    { "type": "function_call", "id": "fc_call_1", "call_id": "call_1", "name": "exec_command", "arguments": "{\"cmd\":\"pwd\"}" },
                    { "type": "function_call_output", "call_id": "call_1", "output": "/tmp" },
                    { "type": "message", "role": "user", "content": [{ "type": "input_text", "text": "next prompt" }] }
                ]
            }),
            Some("req_next"),
            Some("session:s1"),
        );

        assert!(materialized.is_null());
    }

    #[test]
    fn drops_invalid_shell_like_function_calls_when_converting_output_items() {
        let response = json!({
            "output": [
                {
                    "type": "function_call",
                    "id": "fc_bad",
                    "call_id": "call_bad",
                    "name": "exec_command",
                    "arguments": "{\"cmd<arg_value>cd /repo && git status</arg_value><arg_key>command\":\"cd /repo && git status\"}"
                },
                {
                    "type": "function_call",
                    "id": "fc_good",
                    "call_id": "call_good",
                    "name": "exec_command",
                    "arguments": "{\"cmd\":\"pwd\",\"cwd\":\"/tmp\"}"
                }
            ]
        });

        let items = convert_responses_output_to_input_items(&response)
            .as_array()
            .cloned()
            .unwrap_or_default();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0]["call_id"], "call_good");
        let args_text = items[0]["arguments"].as_str().unwrap_or("{}");
        let args: Value = serde_json::from_str(args_text).expect("args object");
        assert_eq!(args["cmd"], "pwd");
        assert_eq!(args["workdir"], "/tmp");
    }

    #[test]
    fn preserves_command_only_exec_command_when_converting_output_items() {
        let response = json!({
            "output": [
                {
                    "type": "function_call",
                    "id": "fc_bad",
                    "call_id": "call_bad",
                    "name": "exec_command",
                    "arguments": "{\"command\":\"pwd\",\"cwd\":\"/tmp\"}"
                }
            ]
        });

        let items = convert_responses_output_to_input_items(&response)
            .as_array()
            .cloned()
            .unwrap_or_default();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0]["call_id"], "call_bad");
        let args_text = items[0]["arguments"].as_str().unwrap_or("{}");
        let args: Value = serde_json::from_str(args_text).expect("args object");
        assert_eq!(args["command"], "pwd");
        assert!(args.get("cmd").is_none());
        assert_eq!(args["workdir"], "/tmp");
    }

    #[test]
    fn preserves_reasoning_output_item_in_persisted_history() {
        let response = serde_json::json!({
            "output": [{
                "type": "reasoning",
                "id": "reasoning-1",
                "status": "completed",
                "summary": [{"type": "summary_text", "text": "thinking step 1"}],
                "content": [{"type": "reasoning_text", "text": "detailed reasoning here"}],
                "encrypted_content": "opaque-sig-abc"
            }]
        });
        let items = convert_responses_output_to_input_items(&response)
            .as_array()
            .cloned()
            .unwrap_or_default();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0]["type"], "reasoning");
        assert_eq!(items[0]["id"], "reasoning-1");
        assert!(items[0].get("status").is_none());
        assert_eq!(items[0]["summary"][0]["type"], "summary_text");
        assert_eq!(items[0]["summary"][0]["text"], "thinking step 1");
        assert!(items[0].get("content").is_none());
        assert_eq!(items[0]["encrypted_content"], "opaque-sig-abc");
    }

    #[test]
    fn preserves_reasoning_output_item_before_function_call_when_persisting_history() {
        let response = serde_json::json!({
            "output": [
                {
                    "type": "reasoning",
                    "id": "reasoning-1",
                    "status": "completed",
                    "content": [{"type": "reasoning_text", "text": "Need to inspect cwd before editing."}]
                },
                {
                    "type": "function_call",
                    "id": "fc_call_1",
                    "call_id": "call_1",
                    "name": "exec_command",
                    "arguments": "{\"cmd\":\"pwd\"}"
                }
            ]
        });
        let items = convert_responses_output_to_input_items(&response)
            .as_array()
            .cloned()
            .unwrap_or_default();
        assert_eq!(items.len(), 2);
        assert_eq!(items[0]["type"], "reasoning");
        assert_eq!(items[0]["id"], "reasoning-1");
        assert!(items[0].get("status").is_none());
        assert!(items[0].get("content").is_none());
        assert_eq!(items[1]["type"], "function_call");
    }

    #[test]
    fn restore_never_replays_reasoning_content_from_persisted_history() {
        let restored = restore_responses_continuation_payload(
            &serde_json::json!({
                "requestId": "req_prev",
                "lastResponseId": "resp_prev",
                "input": [
                    {
                        "type": "reasoning",
                        "id": "reasoning-1",
                        "summary": [{ "type": "summary_text", "text": "thinking step 1" }],
                        "content": [{ "type": "reasoning_text", "text": "historical reasoning leak" }],
                        "encrypted_content": "opaque-sig-abc"
                    }
                ]
            }),
            &serde_json::json!({
                "model": "gpt-5.4",
                "stream": true,
                "input": [
                    {
                        "type": "reasoning",
                        "id": "reasoning-1",
                        "summary": [{ "type": "summary_text", "text": "thinking step 1" }],
                        "content": [{ "type": "reasoning_text", "text": "historical reasoning leak" }],
                        "encrypted_content": "opaque-sig-abc"
                    },
                    { "type": "message", "role": "user", "content": [{ "type": "input_text", "text": "next turn" }] }
                ]
            }),
            Some("req_now"),
            Some("session:sess-1"),
        );

        let payload = restored.get("payload").and_then(Value::as_object).unwrap();
        let input = payload.get("input").and_then(Value::as_array).unwrap();
        let serialized = serde_json::to_string(payload).unwrap();
        assert_eq!(input.len(), 1);
        assert_eq!(input[0]["type"], serde_json::json!("message"));
        assert!(!serialized.contains("historical reasoning leak"));
        assert!(!serialized.contains("\"reasoning_text\""));
    }

    #[test]
    fn convert_responses_output_to_input_items_strips_response_only_status_fields() {
        let response = serde_json::json!({
            "id": "resp_status_strip_1",
            "status": "requires_action",
            "output": [{
                "type": "function_call",
                "id": "fc_status_1",
                "call_id": "call_status_1",
                "name": "exec_command",
                "status": "in_progress",
                "arguments": "{\"cmd\":\"pwd\"}"
            }]
        });
        let items = convert_responses_output_to_input_items(&response)
            .as_array()
            .cloned()
            .unwrap_or_default();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0]["type"], "function_call");
        assert_eq!(items[0]["call_id"], "call_status_1");
        assert!(items[0].get("status").is_none());
    }

    #[test]
    fn responses_conversation_scope_plan_is_rust_owned() {
        let stored = build_responses_conversation_scope_plan(&serde_json::json!({
            "mode": "stored",
            "scope": {
                "sessionId": " sess-1 ",
                "conversationId": "conv-1",
                "entryKind": "responses",
                "continuationOwner": "relay",
                "matchedPort": 5555
            }
        }));
        assert_eq!(stored["portScopeKey"], "port:5555");
        assert_eq!(
            stored["keys"],
            serde_json::json!([
                "port:5555|entry:responses|owner:relay|conversation:conv-1",
                "port:5555|entry:responses|owner:relay|session:sess-1"
            ])
        );

        let requested = build_responses_conversation_scope_plan(&serde_json::json!({
            "mode": "requested",
            "scope": {
                "sessionId": "sess-1",
                "entryKind": "responses",
                "routingPolicyGroup": "gateway"
            }
        }));
        assert_eq!(
            requested["keys"],
            serde_json::json!([
                "group:gateway|entry:responses|owner:direct|session:sess-1",
                "group:gateway|entry:responses|owner:relay|session:sess-1"
            ])
        );

        let submit = build_responses_conversation_scope_plan(&serde_json::json!({
            "mode": "submit_payload",
            "payload": {
                "metadata": {
                    "session_id": "sess-submit",
                    "responsesResume": { "continuationOwner": "direct" },
                    "portContext": { "matchedPort": 5520 }
                }
            }
        }));
        assert_eq!(
            submit["keys"],
            serde_json::json!(["port:5520|entry:responses|owner:direct|session:sess-submit"])
        );
    }

    #[test]
    fn preserves_encrypted_only_reasoning_output_item_in_persisted_history() {
        let response = serde_json::json!({
            "output": [{
                "type": "reasoning",
                "id": "reasoning-enc-1",
                "status": "completed",
                "encrypted_content": "encrypted-opaque-value"
            }]
        });
        let items = convert_responses_output_to_input_items(&response)
            .as_array()
            .cloned()
            .unwrap_or_default();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0]["type"], "reasoning");
        assert_eq!(items[0]["id"], "reasoning-enc-1");
        assert!(items[0].get("status").is_none());
        assert_eq!(items[0]["encrypted_content"], "encrypted-opaque-value");
    }

    #[test]
    fn scope_match_plan_selects_single_relay_and_rejects_ambiguous_or_direct_candidates() {
        let relay_resume = plan_responses_scope_continuation_match(&json!({
            "mode": "resume",
            "candidates": [
                {
                    "scopeKey": "entry:responses|owner:relay|session:s",
                    "requestId": "req_relay",
                    "lastResponseId": "resp_relay",
                    "allowContinuation": true,
                    "continuationOwner": "relay"
                }
            ]
        }));
        assert_eq!(relay_resume["action"], json!("restore"));
        assert_eq!(
            relay_resume["scopeKey"],
            json!("entry:responses|owner:relay|session:s")
        );
        assert_eq!(relay_resume["dedupeKey"], json!("req_relay:resp_relay"));

        let direct_resume = plan_responses_scope_continuation_match(&json!({
            "mode": "resume",
            "candidates": [
                {
                    "scopeKey": "entry:responses|owner:direct|session:s",
                    "requestId": "req_direct",
                    "lastResponseId": "resp_direct",
                    "allowContinuation": true,
                    "continuationOwner": "direct"
                }
            ]
        }));
        assert_eq!(
            direct_resume,
            json!({
                "action": "none",
                "reason": "no_match",
                "matchCount": 0
            })
        );

        let mixed_materialize = plan_responses_scope_continuation_match(&json!({
            "mode": "materialize",
            "candidates": [
                {
                    "scopeKey": "entry:responses|owner:relay|session:s",
                    "requestId": "req_relay",
                    "lastResponseId": "resp_relay",
                    "allowContinuation": true,
                    "continuationOwner": "relay"
                },
                {
                    "scopeKey": "entry:responses|owner:direct|session:s",
                    "requestId": "req_direct",
                    "lastResponseId": "resp_direct",
                    "allowContinuation": true,
                    "continuationOwner": "direct"
                }
            ]
        }));
        assert_eq!(
            mixed_materialize,
            json!({
                "action": "none",
                "reason": "mixed_owner_ambiguous"
            })
        );

        let ambiguous_resume = plan_responses_scope_continuation_match(&json!({
            "mode": "resume",
            "candidates": [
                {
                    "scopeKey": "entry:responses|owner:relay|session:s1",
                    "requestId": "req_one",
                    "lastResponseId": "resp_one",
                    "allowContinuation": true,
                    "continuationOwner": "relay"
                },
                {
                    "scopeKey": "entry:responses|owner:relay|session:s2",
                    "requestId": "req_two",
                    "lastResponseId": "resp_two",
                    "allowContinuation": true,
                    "continuationOwner": "relay"
                }
            ]
        }));
        assert_eq!(
            ambiguous_resume,
            json!({
                "action": "none",
                "reason": "ambiguous",
                "matchCount": 2
            })
        );
    }

    #[test]
    fn resume_entry_match_plan_preserves_index_recover_scope_and_expired_semantics() {
        let indexed = plan_responses_conversation_resume_entry_match(&json!({
            "responseId": "resp_1",
            "options": { "entryKind": "responses", "continuationOwner": "relay" },
            "candidates": [
                {
                    "source": "response_index",
                    "requestId": "req_index",
                    "lastResponseId": "resp_1",
                    "allowContinuation": true,
                    "continuationOwner": "relay",
                    "entryKind": "responses"
                },
                {
                    "source": "scope",
                    "scopeKey": "entry:responses|owner:relay|session:s",
                    "requestId": "req_scope",
                    "lastResponseId": "resp_1",
                    "allowContinuation": true,
                    "continuationOwner": "relay",
                    "entryKind": "responses"
                }
            ]
        }));
        assert_eq!(indexed["action"], json!("select"));
        assert_eq!(indexed["source"], json!("response_index"));
        assert_eq!(indexed["requestId"], json!("req_index"));

        let recovered = plan_responses_conversation_resume_entry_match(&json!({
            "responseId": "resp_2",
            "candidates": [
                {
                    "source": "request_map",
                    "requestId": "req_recovered",
                    "lastResponseId": "resp_2",
                    "allowContinuation": true,
                    "continuationOwner": "relay",
                    "entryKind": "responses"
                }
            ]
        }));
        assert_eq!(recovered["action"], json!("select"));
        assert_eq!(recovered["source"], json!("request_map"));
        assert_eq!(recovered["requestId"], json!("req_recovered"));

        let ambiguous = plan_responses_conversation_resume_entry_match(&json!({
            "responseId": "resp_3",
            "candidates": [
                {
                    "source": "request_map",
                    "requestId": "req_a",
                    "lastResponseId": "resp_3",
                    "allowContinuation": true,
                    "continuationOwner": "relay",
                    "entryKind": "responses"
                },
                {
                    "source": "request_map",
                    "requestId": "req_b",
                    "lastResponseId": "resp_3",
                    "allowContinuation": true,
                    "continuationOwner": "relay",
                    "entryKind": "responses"
                }
            ]
        }));
        assert_eq!(
            ambiguous,
            json!({
                "action": "ambiguous",
                "reason": "ambiguous_response_id_index",
                "responseId": "resp_3",
                "matchCount": 2
            })
        );

        let scope_fallback = plan_responses_conversation_resume_entry_match(&json!({
            "responseId": "resp_4",
            "requestedPortScopeKey": "port:5555",
            "candidates": [
                {
                    "source": "scope",
                    "scopeKey": "port:5555|entry:responses|owner:relay|session:s",
                    "requestId": "req_scope",
                    "lastResponseId": "resp_4",
                    "allowContinuation": true,
                    "continuationOwner": "relay",
                    "entryKind": "responses",
                    "portScopeKey": "port:5555"
                }
            ]
        }));
        assert_eq!(scope_fallback["action"], json!("select"));
        assert_eq!(scope_fallback["source"], json!("scope"));
        assert_eq!(scope_fallback["requestId"], json!("req_scope"));

        let expired = plan_responses_conversation_resume_entry_match(&json!({
            "responseId": "resp_5",
            "candidates": [
                {
                    "source": "response_index",
                    "requestId": "req_expired",
                    "lastResponseId": "resp_5",
                    "allowContinuation": false,
                    "continuationOwner": "relay",
                    "entryKind": "responses"
                }
            ]
        }));
        assert_eq!(
            expired,
            json!({
                "action": "none",
                "reason": "expired_or_unknown_response_id"
            })
        );
    }

    #[test]
    fn conversation_preflight_plan_owns_store_entry_guards() {
        assert_eq!(
            plan_responses_conversation_preflight(&json!({
                "mode": "capture_request",
                "requestId": " req_capture ",
                "payload": { "model": "gpt" }
            })),
            json!({
                "action": "continue",
                "reason": "valid",
                "requestId": "req_capture"
            })
        );
        assert_eq!(
            plan_responses_conversation_preflight(&json!({
                "mode": "capture_request",
                "requestId": "req_capture",
                "payload": null
            })),
            json!({
                "action": "skip",
                "reason": "missing_payload",
                "requestId": "req_capture"
            })
        );

        assert_eq!(
            plan_responses_conversation_preflight(&json!({
                "mode": "record_response",
                "requestId": " req_record ",
                "response": { "id": " resp_record " }
            })),
            json!({
                "action": "continue",
                "reason": "valid",
                "requestId": "req_record",
                "responseId": "resp_record"
            })
        );
        assert_eq!(
            plan_responses_conversation_preflight(&json!({
                "mode": "record_response",
                "requestId": "",
                "response": { "id": "resp_missing_request" }
            })),
            json!({
                "action": "throw",
                "reason": "missing_request_id",
                "code": "MALFORMED_RESPONSE",
                "responseId": "resp_missing_request"
            })
        );
        assert_eq!(
            plan_responses_conversation_preflight(&json!({
                "mode": "record_response",
                "requestId": "req_missing_response",
                "response": {}
            })),
            json!({
                "action": "throw",
                "reason": "missing_response_id",
                "code": "MALFORMED_RESPONSE",
                "requestId": "req_missing_response"
            })
        );

        assert_eq!(
            plan_responses_conversation_preflight(&json!({
                "mode": "resume_conversation",
                "responseId": " resp_resume ",
                "submitPayload": {
                    "tool_outputs": [{ "call_id": "call_1", "output": "ok" }]
                }
            })),
            json!({
                "action": "continue",
                "reason": "valid",
                "responseId": "resp_resume",
                "toolOutputCount": 1
            })
        );
        assert_eq!(
            plan_responses_conversation_preflight(&json!({
                "mode": "resume_conversation",
                "responseId": "",
                "submitPayload": { "tool_outputs": [] }
            })),
            json!({
                "action": "throw",
                "reason": "missing_or_empty_response_id",
                "code": "MALFORMED_REQUEST"
            })
        );
        assert_eq!(
            plan_responses_conversation_preflight(&json!({
                "mode": "resume_conversation",
                "responseId": "resp_no_tools",
                "submitPayload": { "tool_outputs": [] }
            })),
            json!({
                "action": "throw",
                "reason": "missing_tool_outputs",
                "code": "MALFORMED_REQUEST",
                "responseId": "resp_no_tools"
            })
        );
    }

    #[test]
    fn record_continuation_flag_plan_owns_pending_tool_decision() {
        assert_eq!(
            plan_responses_record_continuation_flag(&json!({
                "allowContinuation": false,
                "pendingToolCallIds": [" call_1 ", "", "call_2"]
            })),
            json!({
                "allowContinuation": true,
                "reason": "pending_tool_calls",
                "pendingToolCallCount": 2
            })
        );

        assert_eq!(
            plan_responses_record_continuation_flag(&json!({
                "allowContinuation": true,
                "pendingToolCallIds": []
            })),
            json!({
                "allowContinuation": true,
                "reason": "already_allowed",
                "pendingToolCallCount": 0
            })
        );

        assert_eq!(
            plan_responses_record_continuation_flag(&json!({
                "allowContinuation": false,
                "pendingToolCallIds": []
            })),
            json!({
                "allowContinuation": false,
                "reason": "no_pending_tool_calls",
                "pendingToolCallCount": 0
            })
        );
    }

    #[test]
    fn captured_entry_plan_owns_capture_entry_construction() {
        let plan = plan_responses_captured_entry(&json!({
            "requestId": "req_capture",
            "payload": {
                "model": " gpt-5 ",
                "stream": true,
                "providerKey": " payload-provider ",
                "store": true,
                "tools": [{ "type": "function", "name": "run" }]
            },
            "context": {
                "input": [{ "type": "message", "role": "user", "content": "hi" }],
                "providerKey": " context-provider "
            },
            "providerKey": " args-provider ",
            "sessionId": " session-1 ",
            "conversationId": " conv-1 ",
            "entryKind": "responses",
            "scopeKeys": ["scope:a", " scope:b "],
            "portScopeKey": "port:5520",
            "nowMs": 1234
        }));
        let entry = plan
            .get("entry")
            .and_then(Value::as_object)
            .expect("captured entry");
        assert_eq!(plan.get("action"), Some(&json!("entry")));
        assert_eq!(entry.get("requestId"), Some(&json!("req_capture")));
        assert_eq!(entry.get("allowContinuation"), Some(&json!(true)));
        assert_eq!(entry.get("providerKey"), Some(&json!("args-provider")));
        assert_eq!(entry.get("sessionId"), Some(&json!("session-1")));
        assert_eq!(entry.get("conversationId"), Some(&json!("conv-1")));
        assert_eq!(entry.get("entryKind"), Some(&json!("responses")));
        assert_eq!(entry.get("continuationOwner"), Some(&Value::Null));
        assert_eq!(entry.get("scopeKeys"), Some(&json!(["scope:a", "scope:b"])));
        assert_eq!(entry.get("portScopeKey"), Some(&json!("port:5520")));
        assert_eq!(entry.get("createdAt"), Some(&json!(1234)));
        assert_eq!(entry.get("updatedAt"), Some(&json!(1234)));
        assert_eq!(
            entry
                .get("basePayload")
                .and_then(Value::as_object)
                .and_then(|row| row.get("model")),
            Some(&json!("gpt-5"))
        );
        assert!(entry
            .get("input")
            .and_then(Value::as_array)
            .is_some_and(|items| items.len() == 1));
        assert_eq!(
            entry.get("tools").and_then(Value::as_array).map(Vec::len),
            None
        );
        assert!(entry
            .get("basePayload")
            .and_then(Value::as_object)
            .and_then(|row| row.get("tools"))
            .and_then(Value::as_array)
            .is_some_and(|items| items.len() == 1));

        let fallback = plan_responses_captured_entry(&json!({
            "requestId": "req_minimal",
            "payload": { "model": "gpt-5" },
            "context": null,
            "scopeKeys": [],
            "nowMs": 5
        }));
        let fallback_entry = fallback
            .get("entry")
            .and_then(Value::as_object)
            .expect("fallback entry");
        assert_eq!(fallback_entry.get("allowContinuation"), Some(&json!(false)));
        assert_eq!(
            fallback_entry
                .get("tools")
                .and_then(Value::as_array)
                .map(Vec::len),
            None
        );
    }

    #[test]
    fn continuation_lookup_plan_selects_only_matching_entry_scope_and_owner() {
        let selected = plan_responses_continuation_lookup_by_response_id(&json!({
            "responseId": "resp_lookup",
            "requestedPortScopeKey": "port:5555",
            "options": { "entryKind": "responses", "continuationOwner": "relay" },
            "entry": {
                "requestId": "req_lookup",
                "lastResponseId": "resp_lookup",
                "providerKey": "provider.key.model",
                "continuationOwner": "relay",
                "entryKind": "responses",
                "portScopeKey": "port:5555"
            }
        }));
        assert_eq!(
            selected,
            json!({
                "action": "select",
                "reason": "matched",
                "responseId": "resp_lookup",
                "providerKey": "provider.key.model",
                "continuationOwner": "relay",
                "entryKind": "responses",
                "requestId": "req_lookup"
            })
        );

        for input in [
            json!({
                "responseId": "resp_lookup",
                "requestedPortScopeKey": "port:5555",
                "entry": {
                    "requestId": "req_wrong_port",
                    "lastResponseId": "resp_lookup",
                    "continuationOwner": "relay",
                    "entryKind": "responses",
                    "portScopeKey": "port:5520"
                }
            }),
            json!({
                "responseId": "resp_lookup",
                "options": { "continuationOwner": "direct" },
                "entry": {
                    "requestId": "req_wrong_owner",
                    "lastResponseId": "resp_lookup",
                    "continuationOwner": "relay",
                    "entryKind": "responses"
                }
            }),
            json!({
                "responseId": "resp_lookup",
                "options": { "entryKind": "chat" },
                "entry": {
                    "requestId": "req_wrong_kind",
                    "lastResponseId": "resp_lookup",
                    "continuationOwner": "relay",
                    "entryKind": "responses"
                }
            }),
            json!({
                "responseId": "resp_lookup"
            }),
        ] {
            assert_eq!(
                plan_responses_continuation_lookup_by_response_id(&input)["action"],
                json!("none")
            );
        }
    }

    #[test]
    fn responses_store_operation_executes_capture_record_scope_resume_in_rust_state() {
        let _guard = RESPONSES_STORE_TEST_LOCK
            .lock()
            .expect("responses store test lock");
        let persistence_file_path =
            responses_store_test_persistence_file("capture-record-scope-resume");
        let _ = responses_store_operation_for_test(&persistence_file_path, "clear_all", json!({}));

        let captured = responses_store_operation_for_test(
            &persistence_file_path,
            "capture_request_context",
            json!({
                "requestId": "req_native_store_1",
                "sessionId": "sess_native_store",
                "conversationId": "conv_native_store",
                "providerKey": "provider.key.gpt",
                "payload": {
                    "model": "gpt-5.5",
                    "store": true,
                    "stream": true
                },
                "context": {
                    "input": [
                        {
                            "type": "message",
                            "role": "user",
                            "content": [{ "type": "input_text", "text": "hello" }]
                        }
                    ]
                }
            }),
        );
        assert_eq!(captured["ok"], json!(true));

        let recorded = responses_store_operation_for_test(
            &persistence_file_path,
            "record_response",
            json!({
                "requestId": "req_native_store_1",
                "sessionId": "sess_native_store",
                "conversationId": "conv_native_store",
                "providerKey": "provider.key.gpt",
                "response": {
                    "id": "resp_native_store_1",
                    "output": [
                        {
                            "type": "message",
                            "role": "assistant",
                            "content": [{ "type": "output_text", "text": "world" }]
                        }
                    ]
                }
            }),
        );
        assert_eq!(recorded["ok"], json!(true));

        let stats =
            responses_store_operation_for_test(&persistence_file_path, "debug_stats", json!({}));
        assert_eq!(stats["result"]["requestMapSize"], json!(1));
        assert_eq!(stats["result"]["responseIndexSize"], json!(1));
        assert_eq!(stats["result"]["scopeIndexSize"], json!(2));

        let restored = responses_store_operation_for_test(
            &persistence_file_path,
            "resume_latest_by_scope",
            json!({
                "requestId": "req_native_store_2",
                "sessionId": "sess_native_store",
                "conversationId": "conv_native_store",
                "payload": {
                    "model": "gpt-5.5",
                    "stream": true,
                    "input": [
                        {
                            "type": "message",
                            "role": "user",
                            "content": [{ "type": "input_text", "text": "hello" }]
                        },
                        {
                            "type": "message",
                            "role": "assistant",
                            "content": [{ "type": "output_text", "text": "world" }]
                        },
                        {
                            "type": "message",
                            "role": "user",
                            "content": [{ "type": "input_text", "text": "next" }]
                        }
                    ]
                }
            }),
        );
        assert_eq!(restored["ok"], json!(true));
        assert_eq!(
            restored["result"]["payload"]["previous_response_id"],
            json!("resp_native_store_1")
        );
        assert_eq!(
            restored["result"]["payload"]["input"][0]["role"],
            json!("user")
        );
        assert_eq!(
            restored["result"]["meta"]["scopeKey"],
            json!("entry:responses|owner:relay|conversation:conv_native_store")
        );

        let _ = responses_store_operation_for_test(&persistence_file_path, "clear_all", json!({}));
        let _ = std::fs::remove_file(persistence_file_path);
    }

    #[test]
    fn responses_store_operation_missing_record_context_returns_immediate_store_error() {
        let _guard = RESPONSES_STORE_TEST_LOCK
            .lock()
            .expect("responses store test lock");
        let persistence_file_path = responses_store_test_persistence_file("missing-record-context");
        let _ = responses_store_operation_for_test(&persistence_file_path, "clear_all", json!({}));
        let result = responses_store_operation_for_test(
            &persistence_file_path,
            "record_response",
            json!({
                "requestId": "req_native_missing_context",
                "response": {
                    "id": "resp_native_missing_context",
                    "output": []
                }
            }),
        );
        assert_eq!(result["ok"], json!(false));
        assert_eq!(
            result["error"]["code"],
            json!("RESPONSES_STORE_MISSING_REQUEST_CONTEXT")
        );
        assert_eq!(
            result["error"]["details"]["reason"],
            json!("missing_request_context")
        );
        let _ = responses_store_operation_for_test(&persistence_file_path, "clear_all", json!({}));
        let _ = std::fs::remove_file(persistence_file_path);
    }
}
