use napi::bindgen_prelude::Result as NapiResult;
use napi_derive::napi;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};

use crate::chat_web_search_intent::analyze_chat_web_search_intent;
use crate::hub_bridge_actions::utils::{
    can_servertool_own_tool_call_id, is_synthetic_routecodex_control_text,
    is_synthetic_routecodex_tool_call_id,
};
use crate::shared_tool_mapping::normalize_routecodex_tool_name;
use crate::shared_json_utils::read_trimmed_string as read_optional_trimmed_string;
use crate::virtual_router_engine::routing::{
    resolve_routing_state_key, resolve_session_scope, resolve_stop_message_scope,
};
use crate::web_search_mode::{resolve_web_search_execution_mode, WebSearchExecutionMode};

/// Tool names treated as pure noop — acknowledged and auto-continued without handler execution.
/// Outcome is a standard delta: tool_outputs entry + clientInjectOnly followup.
const NOOP_SERVERTOOL_NAMES: [&str; 1] = ["continue_execution"];
const LEGACY_STOP_MESSAGE_FOLLOWUP_TEXT: &str = "继续执行";
const DEFAULT_STOP_MESSAGE_EXECUTION_PROMPT: &str = "继续完成当前用户目标。若仍需操作、检查或验证，必须调用可用工具继续执行；不要只总结、道歉、复述状态或输出计划。只有目标已经完成时，才输出最终简短结果。";

fn normalize_stop_message_followup_text(text: &str) -> String {
    if text.trim() == LEGACY_STOP_MESSAGE_FOLLOWUP_TEXT {
        DEFAULT_STOP_MESSAGE_EXECUTION_PROMPT.to_string()
    } else {
        text.to_string()
    }
}

fn is_visible_text_field(key: Option<&str>) -> bool {
    matches!(
        key,
        None | Some("content" | "text" | "input_text" | "output_text" | "output")
    )
}

fn contains_synthetic_routecodex_control_text_value(value: &Value, key: Option<&str>) -> bool {
    match value {
        Value::String(text) => {
            is_visible_text_field(key) && is_synthetic_routecodex_control_text(text)
        }
        Value::Array(items) => items
            .iter()
            .any(|item| contains_synthetic_routecodex_control_text_value(item, key)),
        Value::Object(row) => row.iter().any(|(child_key, child_value)| {
            contains_synthetic_routecodex_control_text_value(child_value, Some(child_key.as_str()))
        }),
        _ => false,
    }
}

#[napi]
pub fn contains_synthetic_routecodex_control_text_json(input_json: String) -> NapiResult<String> {
    let value: Value = serde_json::from_str(&input_json)
        .map_err(|error| napi::Error::from_reason(error.to_string()))?;
    serde_json::to_string(&contains_synthetic_routecodex_control_text_value(
        &value, None,
    ))
    .map_err(|error| napi::Error::from_reason(error.to_string()))
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ChatWebSearchPlanOutput {
    should_inject: bool,
    selected_engine_indexes: Vec<i64>,
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
    runtime_metadata: Option<Value>,
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
struct ServertoolDispatchNoopOutput {
    id: String,
    name: String,
    arguments: String,
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
    noop_tool_calls: Vec<ServertoolDispatchNoopOutput>,
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
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct StopMessagePersistedLookupPlannerInput {
    record: Value,
    runtime_metadata: Option<Value>,
    options: Option<StopMessagePersistedLookupPlannerOptions>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct StopMessagePersistedLookupPlannerOptions {
    include_snapshot_lookup: Option<bool>,
    include_tombstone_lookup: Option<bool>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct StopMessagePersistedLookupPlanOutput {
    strict_session_scope: Option<String>,
    sticky_key: Option<String>,
    candidate_keys: Vec<String>,
    lookup_policy: String,
    read_stop_message_snapshot: bool,
    read_stop_message_tombstone: bool,
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
                    Some(value) => serde_json::to_string(value).map_err(|error| {
                        format!("toolOutputs content serialization failed: {}", error)
                    })?,
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

fn read_servertool_adapter_tool_name(tool: &Value) -> String {
    let Some(row) = tool.as_object() else {
        return String::new();
    };
    let direct = read_optional_trimmed_string(row.get("name")).unwrap_or_default();
    if !direct.is_empty() {
        return direct.to_ascii_lowercase();
    }
    row.get("function")
        .and_then(Value::as_object)
        .map(|function| {
            read_optional_trimmed_string(function.get("name"))
                .unwrap_or_default()
                .to_ascii_lowercase()
        })
        .unwrap_or_default()
}

fn should_replace_servertool_adapter_captured_tools(
    base_context: &Map<String, Value>,
    existing_tools: Option<&Vec<Value>>,
    client_tools_raw: Option<&Vec<Value>>,
    force_replace: bool,
) -> bool {
    let Some(client_tools_raw) = client_tools_raw.filter(|tools| !tools.is_empty()) else {
        return false;
    };
    let Some(existing_tools) = existing_tools.filter(|tools| !tools.is_empty()) else {
        return true;
    };

    if force_replace {
        return true;
    }

    let rt = base_context.get("__rt").and_then(Value::as_object);
    let is_servertool_followup = rt
        .and_then(|row| row.get("serverToolFollowup"))
        .and_then(Value::as_bool)
        .unwrap_or(false)
        || base_context
            .get("serverToolFollowup")
            .and_then(Value::as_bool)
            .unwrap_or(false)
        || base_context
            .get("isServerToolFollowup")
            .and_then(Value::as_bool)
            .unwrap_or(false);
    if !is_servertool_followup {
        return false;
    }

    let existing_names: Vec<String> = existing_tools
        .iter()
        .map(read_servertool_adapter_tool_name)
        .filter(|name| !name.is_empty())
        .collect();
    let client_names: std::collections::HashSet<String> = client_tools_raw
        .iter()
        .map(read_servertool_adapter_tool_name)
        .filter(|name| !name.is_empty())
        .collect();
    if existing_names.is_empty() || client_names.is_empty() {
        return false;
    }
    existing_names.len() < client_names.len()
        && existing_names
            .iter()
            .all(|name| client_names.contains(name))
}

fn backfill_servertool_adapter_context_tools_value(
    base_context: Value,
    request_semantics: Value,
    force_replace: bool,
) -> Value {
    let mut base_context = match base_context {
        Value::Object(row) => row,
        other => return other,
    };
    let client_tools_raw = request_semantics
        .get("tools")
        .and_then(Value::as_object)
        .and_then(|tools| tools.get("clientToolsRaw"))
        .and_then(Value::as_array);
    if client_tools_raw.filter(|tools| !tools.is_empty()).is_none() {
        return serde_json::json!({ "changed": false, "context": Value::Object(base_context) });
    }

    let existing_tools = base_context
        .get("capturedChatRequest")
        .and_then(Value::as_object)
        .and_then(|captured| captured.get("tools"))
        .and_then(Value::as_array);
    if !should_replace_servertool_adapter_captured_tools(
        &base_context,
        existing_tools,
        client_tools_raw,
        force_replace,
    ) {
        return serde_json::json!({ "changed": false, "context": Value::Object(base_context) });
    }

    if let Some(captured) = base_context
        .get_mut("capturedChatRequest")
        .and_then(Value::as_object_mut)
    {
        captured.insert(
            "tools".to_string(),
            Value::Array(client_tools_raw.cloned().unwrap_or_default()),
        );
    }
    serde_json::json!({ "changed": true, "context": Value::Object(base_context) })
}

fn as_json_object(value: Option<&Value>) -> Option<&Map<String, Value>> {
    value.and_then(Value::as_object)
}

fn read_provider_response_metadata(value: Option<&Value>) -> Option<&Map<String, Value>> {
    as_json_object(value)
        .and_then(|row| row.get("metadata"))
        .and_then(Value::as_object)
}

fn read_provider_response_rt(metadata: Option<&Map<String, Value>>) -> Option<&Map<String, Value>> {
    metadata
        .and_then(|row| row.get("__rt"))
        .and_then(Value::as_object)
}

fn read_provider_response_root_tools(value: Option<&Value>) -> Option<Vec<Value>> {
    as_json_object(value)
        .and_then(|row| row.get("tools"))
        .and_then(Value::as_array)
        .cloned()
}

fn read_provider_response_request_semantics<'a>(
    processed_metadata: Option<&'a Map<String, Value>>,
    standardized_metadata: Option<&'a Map<String, Value>>,
    request_metadata: Option<&'a Map<String, Value>>,
) -> Option<&'a Value> {
    processed_metadata
        .and_then(|row| row.get("requestSemantics"))
        .filter(|value| value.is_object())
        .or_else(|| {
            standardized_metadata
                .and_then(|row| row.get("requestSemantics"))
                .filter(|value| value.is_object())
        })
        .or_else(|| {
            request_metadata
                .and_then(|row| row.get("requestSemantics"))
                .filter(|value| value.is_object())
        })
}

fn read_provider_response_base_semantics<'a>(
    processed: Option<&'a Value>,
    standardized: Option<&'a Value>,
    metadata_semantics: Option<&'a Value>,
) -> Option<&'a Value> {
    metadata_semantics
        .or_else(|| {
            as_json_object(processed)
                .and_then(|row| row.get("semantics"))
                .filter(|value| value.is_object())
        })
        .or_else(|| {
            as_json_object(standardized)
                .and_then(|row| row.get("semantics"))
                .filter(|value| value.is_object())
        })
}

fn read_provider_response_client_tools_raw(
    base: Option<&Map<String, Value>>,
) -> Option<Vec<Value>> {
    let tools = base.and_then(|row| row.get("tools"));
    tools
        .and_then(Value::as_object)
        .and_then(|row| row.get("clientToolsRaw"))
        .and_then(Value::as_array)
        .cloned()
        .or_else(|| tools.and_then(Value::as_array).cloned())
}

fn merge_provider_response_unique_tools(
    primary: Option<Vec<Value>>,
    secondary: Option<Vec<Value>>,
) -> Option<Vec<Value>> {
    let mut out: Vec<Value> = Vec::new();
    let mut seen = std::collections::HashSet::<String>::new();
    for tool in primary
        .into_iter()
        .flatten()
        .chain(secondary.into_iter().flatten())
    {
        if !tool.is_object() {
            continue;
        }
        let name = read_servertool_adapter_tool_name(&tool);
        if name.is_empty() || seen.contains(&name) {
            continue;
        }
        seen.insert(name);
        out.push(tool);
    }
    if out.is_empty() {
        None
    } else {
        Some(out)
    }
}

fn read_followup_raw<'a>(
    processed_rt: Option<&'a Map<String, Value>>,
    standardized_rt: Option<&'a Map<String, Value>>,
    request_metadata_rt: Option<&'a Map<String, Value>>,
    processed_metadata: Option<&'a Map<String, Value>>,
    standardized_metadata: Option<&'a Map<String, Value>>,
    request_metadata: Option<&'a Map<String, Value>>,
) -> Option<&'a Value> {
    processed_rt
        .and_then(|row| row.get("serverToolFollowup"))
        .or_else(|| standardized_rt.and_then(|row| row.get("serverToolFollowup")))
        .or_else(|| request_metadata_rt.and_then(|row| row.get("serverToolFollowup")))
        .or_else(|| processed_metadata.and_then(|row| row.get("serverToolFollowup")))
        .or_else(|| standardized_metadata.and_then(|row| row.get("serverToolFollowup")))
        .or_else(|| request_metadata.and_then(|row| row.get("serverToolFollowup")))
}

fn read_followup_source<'a>(
    processed_rt: Option<&'a Map<String, Value>>,
    standardized_rt: Option<&'a Map<String, Value>>,
    request_metadata_rt: Option<&'a Map<String, Value>>,
    processed_metadata: Option<&'a Map<String, Value>>,
    standardized_metadata: Option<&'a Map<String, Value>>,
    request_metadata: Option<&'a Map<String, Value>>,
) -> Option<String> {
    processed_rt
        .and_then(|row| row.get("clientInjectSource"))
        .or_else(|| standardized_rt.and_then(|row| row.get("clientInjectSource")))
        .or_else(|| request_metadata_rt.and_then(|row| row.get("clientInjectSource")))
        .or_else(|| processed_metadata.and_then(|row| row.get("clientInjectSource")))
        .or_else(|| standardized_metadata.and_then(|row| row.get("clientInjectSource")))
        .or_else(|| request_metadata.and_then(|row| row.get("clientInjectSource")))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn boolish_true(value: Option<&Value>) -> bool {
    match value {
        Some(Value::Bool(true)) => true,
        Some(Value::String(text)) => text.trim().eq_ignore_ascii_case("true"),
        _ => false,
    }
}

fn resolve_provider_response_request_semantics_value(
    processed: Value,
    standardized: Value,
    request_metadata: Value,
) -> Value {
    let processed_ref = if processed.is_null() {
        None
    } else {
        Some(&processed)
    };
    let standardized_ref = if standardized.is_null() {
        None
    } else {
        Some(&standardized)
    };
    let request_metadata_ref = if request_metadata.is_null() {
        None
    } else {
        Some(&request_metadata)
    };
    let processed_metadata = read_provider_response_metadata(processed_ref);
    let standardized_metadata = read_provider_response_metadata(standardized_ref);
    let request_metadata_record = request_metadata_ref.and_then(Value::as_object);
    let metadata_semantics = read_provider_response_request_semantics(
        processed_metadata,
        standardized_metadata,
        request_metadata_record,
    );
    let fallback_tools = read_provider_response_root_tools(processed_ref)
        .or_else(|| read_provider_response_root_tools(standardized_ref));
    let base_value =
        read_provider_response_base_semantics(processed_ref, standardized_ref, metadata_semantics);
    if base_value.is_none() && fallback_tools.as_ref().is_none_or(Vec::is_empty) {
        return Value::Null;
    }

    let base_object = base_value.and_then(Value::as_object);
    let existing_client_tools_raw = read_provider_response_client_tools_raw(base_object);
    let mut normalized_base = match base_value.cloned() {
        Some(Value::Object(row)) => row,
        _ => Map::new(),
    };
    if base_value.is_none() {
        normalized_base.insert(
            "tools".to_string(),
            serde_json::json!({ "clientToolsRaw": fallback_tools.clone().unwrap_or_default() }),
        );
    } else if existing_client_tools_raw.as_ref().is_none_or(Vec::is_empty)
        && fallback_tools
            .as_ref()
            .is_some_and(|tools| !tools.is_empty())
    {
        let mut tools = normalized_base
            .get("tools")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        tools.insert(
            "clientToolsRaw".to_string(),
            Value::Array(fallback_tools.clone().unwrap_or_default()),
        );
        normalized_base.insert("tools".to_string(), Value::Object(tools));
    }

    let processed_rt = read_provider_response_rt(processed_metadata);
    let standardized_rt = read_provider_response_rt(standardized_metadata);
    let request_metadata_rt = read_provider_response_rt(request_metadata_record);
    let servertool_followup = boolish_true(read_followup_raw(
        processed_rt,
        standardized_rt,
        request_metadata_rt,
        processed_metadata,
        standardized_metadata,
        request_metadata_record,
    ));
    let followup_source = read_followup_source(
        processed_rt,
        standardized_rt,
        request_metadata_rt,
        processed_metadata,
        standardized_metadata,
        request_metadata_record,
    );
    if !servertool_followup && followup_source.is_none() {
        return Value::Object(normalized_base);
    }

    let normalized_client_tools = normalized_base
        .get("tools")
        .and_then(Value::as_object)
        .and_then(|tools| tools.get("clientToolsRaw"))
        .and_then(Value::as_array)
        .cloned();
    let merged = merge_provider_response_unique_tools(normalized_client_tools, fallback_tools);
    if let Some(merged) = merged {
        let mut tools = normalized_base
            .get("tools")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        tools.insert("clientToolsRaw".to_string(), Value::Array(merged));
        normalized_base.insert("tools".to_string(), Value::Object(tools));
    }
    Value::Object(normalized_base)
}

#[napi(js_name = "resolveProviderResponseRequestSemanticsJson")]
pub fn resolve_provider_response_request_semantics_json(
    processed_json: String,
    standardized_json: String,
    request_metadata_json: String,
) -> NapiResult<String> {
    let processed: Value = serde_json::from_str(&processed_json)
        .map_err(|error| napi::Error::from_reason(error.to_string()))?;
    let standardized: Value = serde_json::from_str(&standardized_json)
        .map_err(|error| napi::Error::from_reason(error.to_string()))?;
    let request_metadata: Value = serde_json::from_str(&request_metadata_json)
        .map_err(|error| napi::Error::from_reason(error.to_string()))?;
    let output = resolve_provider_response_request_semantics_value(
        processed,
        standardized,
        request_metadata,
    );
    serde_json::to_string(&output).map_err(|error| napi::Error::from_reason(error.to_string()))
}

#[napi(js_name = "backfillServertoolAdapterContextToolsJson")]
pub fn backfill_servertool_adapter_context_tools_json(
    base_context_json: String,
    request_semantics_json: String,
    force_replace: bool,
) -> NapiResult<String> {
    let base_context: Value = serde_json::from_str(&base_context_json)
        .map_err(|error| napi::Error::from_reason(error.to_string()))?;
    let request_semantics: Value = serde_json::from_str(&request_semantics_json)
        .map_err(|error| napi::Error::from_reason(error.to_string()))?;
    let output = backfill_servertool_adapter_context_tools_value(
        base_context,
        request_semantics,
        force_replace,
    );
    serde_json::to_string(&output).map_err(|error| napi::Error::from_reason(error.to_string()))
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

fn is_name_included(
    name: &str,
    include: Option<&Vec<String>>,
    exclude: Option<&Vec<String>>,
) -> bool {
    let normalized = normalize_routecodex_tool_name(Some(name))
        .unwrap_or_else(|| name.trim().to_ascii_lowercase());
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
    let existing = read_optional_trimmed_string(tool_call_obj.get("id")).unwrap_or_default();
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
            .or_else(|| {
                tool_call_obj
                    .get("functionCall")
                    .and_then(|v| v.as_object())
            })
            .or_else(|| {
                tool_call_obj
                    .get("function_call")
                    .and_then(|v| v.as_object())
            });
        let raw_name = function_obj
            .map(|row| read_optional_trimmed_string(row.get("name")))
            .unwrap_or_default();
        let raw_name = raw_name.unwrap_or_default();
        if raw_name.is_empty() {
            continue;
        }
        let name = normalize_routecodex_tool_name(Some(raw_name.as_str()))
            .unwrap_or_else(|| raw_name.to_ascii_lowercase());
        let args = stringify_tool_args(
            function_obj
                .and_then(|row| {
                    row.get("arguments")
                        .or_else(|| row.get("args"))
                        .or_else(|| row.get("input"))
                })
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
        let message = match choice_obj
            .get_mut("message")
            .and_then(|v| v.as_object_mut())
        {
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
            let entry_type = read_optional_trimmed_string(row.get("type")).unwrap_or_default().to_ascii_lowercase();
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
        let item_type = read_optional_trimmed_string(row.get("type")).unwrap_or_default().to_ascii_lowercase();
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
                read_optional_trimmed_string(first_choice.get("finish_reason")).unwrap_or_default().to_ascii_lowercase();
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

    let status = read_optional_trimmed_string(row.get("status")).unwrap_or_default().to_ascii_lowercase();
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

fn push_unique_scope_key(out: &mut Vec<String>, value: Option<String>) {
    let Some(raw) = value else {
        return;
    };
    let normalized = raw.trim();
    if normalized.is_empty() {
        return;
    }
    if !out.iter().any(|entry| entry == normalized) {
        out.push(normalized.to_string());
    }
}

fn collect_stop_message_persisted_candidate_keys(
    direct_record: &Value,
    resolver_metadata: &Value,
) -> (Option<String>, Option<String>, Vec<String>) {
    let strict_session_scope = resolve_stop_message_session_scope(resolver_metadata);
    let sticky_key =
        Some(resolve_servertool_sticky_key(resolver_metadata)).filter(|v| !v.trim().is_empty());
    let row = direct_record.as_object();
    let mut candidate_keys: Vec<String> = Vec::new();

    let direct_tmux_keys = [
        row.and_then(|obj| obj.get("tmuxSessionId"))
            .and_then(|v| v.as_str()),
        row.and_then(|obj| obj.get("clientTmuxSessionId"))
            .and_then(|v| v.as_str()),
        row.and_then(|obj| obj.get("tmux_session_id"))
            .and_then(|v| v.as_str()),
        row.and_then(|obj| obj.get("client_tmux_session_id"))
            .and_then(|v| v.as_str()),
    ];
    for value in direct_tmux_keys.into_iter().flatten() {
        let trimmed = value.trim();
        if !trimmed.is_empty() {
            push_unique_scope_key(&mut candidate_keys, Some(format!("tmux:{}", trimmed)));
        }
    }

    if let Some(session_id) = row
        .and_then(|obj| obj.get("sessionId"))
        .and_then(|v| v.as_str())
    {
        let trimmed = session_id.trim();
        if !trimmed.is_empty() {
            push_unique_scope_key(&mut candidate_keys, Some(format!("tmux:{}", trimmed)));
            push_unique_scope_key(&mut candidate_keys, Some(format!("session:{}", trimmed)));
        }
    }

    if let Some(conversation_id) = row
        .and_then(|obj| obj.get("conversationId"))
        .and_then(|v| v.as_str())
    {
        let trimmed = conversation_id.trim();
        if !trimmed.is_empty() {
            push_unique_scope_key(
                &mut candidate_keys,
                Some(format!("conversation:{}", trimmed)),
            );
        }
    }

    if !candidate_keys.is_empty() {
        push_unique_scope_key(&mut candidate_keys, strict_session_scope.clone());
        push_unique_scope_key(&mut candidate_keys, sticky_key.clone());
    }

    (strict_session_scope, sticky_key, candidate_keys)
}

fn plan_stop_message_persisted_lookup(
    input: &StopMessagePersistedLookupPlannerInput,
) -> StopMessagePersistedLookupPlanOutput {
    let merged_metadata = match (&input.record, &input.runtime_metadata) {
        (Value::Object(record), Some(Value::Object(runtime))) => {
            let mut out = runtime.clone();
            for (k, v) in record {
                out.insert(k.clone(), v.clone());
            }
            Value::Object(out)
        }
        (record, _) => record.clone(),
    };

    let (strict_session_scope, sticky_key, candidate_keys) =
        collect_stop_message_persisted_candidate_keys(&input.record, &merged_metadata);
    let options = input.options.as_ref();
    StopMessagePersistedLookupPlanOutput {
        strict_session_scope,
        sticky_key,
        candidate_keys,
        lookup_policy: "strict_then_sticky_then_session_family".to_string(),
        read_stop_message_snapshot: options
            .and_then(|o| o.include_snapshot_lookup)
            .unwrap_or(true),
        read_stop_message_tombstone: options
            .and_then(|o| o.include_tombstone_lookup)
            .unwrap_or(true),
    }
}

fn resolve_servertool_sticky_key(metadata: &Value) -> String {
    if let Some(scope) = resolve_stop_message_scope(metadata) {
        return scope;
    }
    if let Some(session_scope) = resolve_session_scope(metadata) {
        return session_scope;
    }
    resolve_routing_state_key(metadata)
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
            let id = read_optional_trimmed_string(engine.get("id")).unwrap_or_default();
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
                let id = read_optional_trimmed_string(engine.get("id"))
                    .unwrap_or_default()
                    .to_ascii_lowercase();
                let provider_key =
                    read_optional_trimmed_string(engine.get("providerKey")).unwrap_or_default().to_ascii_lowercase();
                if id.contains("google") {
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
pub fn plan_stop_message_persisted_lookup_json(input_json: String) -> NapiResult<String> {
    let input: StopMessagePersistedLookupPlannerInput =
        serde_json::from_str(&input_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let output = plan_stop_message_persisted_lookup(&input);
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

fn resolve_apply_patch_dispatch_mode(runtime_metadata: Option<&Value>) -> String {
    let mode = runtime_metadata
        .and_then(|v| v.as_object())
        .and_then(|row| row.get("__rt").or(runtime_metadata))
        .and_then(|v| v.as_object())
        .and_then(|rt| rt.get("applyPatch"))
        .and_then(|v| v.as_object())
        .and_then(|ap| ap.get("mode"))
        .and_then(|v| v.as_str())
        .map(|v| v.trim().to_ascii_lowercase())
        .unwrap_or_else(|| "client".to_string());
    if mode == "servertool" {
        "servertool".to_string()
    } else {
        "client".to_string()
    }
}

fn can_dispatch_apply_patch_servertool(
    normalized_name: &str,
    runtime_metadata: Option<&Value>,
) -> bool {
    normalized_name != "apply_patch"
        || resolve_apply_patch_dispatch_mode(runtime_metadata) == "servertool"
}

#[napi]
pub fn plan_servertool_tool_call_dispatch_json(input_json: String) -> NapiResult<String> {
    let input: ServertoolDispatchPlannerInput =
        serde_json::from_str(&input_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let include = normalize_filter_token_set(input.include_tool_call_handler_names.as_ref());
    let exclude = normalize_filter_token_set(input.exclude_tool_call_handler_names.as_ref());
    let mut registered = input
        .registered_tool_call_handlers
        .into_iter()
        .filter_map(|entry| {
            let name = normalize_routecodex_tool_name(Some(entry.name.as_str()))
                .unwrap_or_else(|| entry.name.trim().to_ascii_lowercase());
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
    let mut noop_tool_calls = Vec::new();
    let mut skipped_tool_calls = Vec::new();

    for tool_call in input.tool_calls {
        let normalized_name = normalize_routecodex_tool_name(Some(tool_call.name.as_str()))
            .unwrap_or_else(|| tool_call.name.trim().to_ascii_lowercase());
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
        if !can_dispatch_apply_patch_servertool(
            normalized_name.as_str(),
            input.runtime_metadata.as_ref(),
        ) {
            skipped_tool_calls.push(ServertoolDispatchSkippedOutput {
                id: tool_call.id,
                name: normalized_name,
                reason: "apply_patch_client_mode".to_string(),
            });
            continue;
        }
        if NOOP_SERVERTOOL_NAMES.contains(&normalized_name.as_str()) {
            noop_tool_calls.push(ServertoolDispatchNoopOutput {
                id: tool_call.id,
                name: normalized_name,
                arguments: tool_call.arguments,
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
        noop_tool_calls,
        skipped_tool_calls,
    };
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi]
pub fn plan_servertool_noop_outcome_json(input_json: String) -> NapiResult<String> {
    #[derive(Debug, Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct NoopInput {
        tool_call_id: String,
        tool_name: String,
        /// The base chat response payload to inject the tool_output into.
        base: Value,
    }

    #[derive(Debug, Serialize)]
    #[serde(rename_all = "camelCase")]
    struct NoopOutput {
        /// Updated chat response with tool_outputs appended.
        chat_response: Value,
        flow_id: String,
        /// The injected tool output content.
        tool_content: Value,
        followup: Value,
    }

    let input: NoopInput =
        serde_json::from_str(&input_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;

    // Build the standard noop tool output content
    let tool_content = serde_json::json!({
        "ok": true,
        "executed": true,
        "noop": true,
        "action": "continue_execution"
    });

    // Append tool_outputs entry
    let mut chat_response = input.base;
    let existing_outputs = chat_response
        .get("tool_outputs")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let mut new_outputs = existing_outputs.clone();
    new_outputs.push(serde_json::json!({
        "tool_call_id": input.tool_call_id,
        "name": input.tool_name,
        "content": tool_content.to_string()
    }));
    if let Some(obj) = chat_response.as_object_mut() {
        obj.insert("tool_outputs".to_string(), Value::Array(new_outputs));
    }

    let followup = serde_json::json!({
        "requestIdSuffix": ":continue_execution_followup",
        "injection": {
            "ops": [
                {"op": "preserve_tools"},
                {"op": "ensure_standard_tools"},
                {"op": "append_assistant_message", "required": true},
                {"op": "append_tool_messages_from_tool_outputs", "required": true}
            ]
        },
        "metadata": {
            "clientInjectOnly": true,
            "clientInjectText": "继续执行",
            "clientInjectSource": "servertool.continue_execution"
        }
    });

    let output = NoopOutput {
        chat_response,
        flow_id: "continue_execution_flow".to_string(),
        tool_content,
        followup,
    };
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}

fn build_assistant_tool_call_message_value(tool_calls: &[Value]) -> Value {
    let calls = tool_calls
        .iter()
        .filter_map(|tool_call| {
            let row = tool_call.as_object()?;
            let id = row.get("id").and_then(Value::as_str)?.to_string();
            let name = row.get("name").and_then(Value::as_str)?.to_string();
            let arguments = row
                .get("arguments")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            Some(serde_json::json!({
                "id": id,
                "type": "function",
                "function": { "name": name, "arguments": arguments }
            }))
        })
        .collect::<Vec<_>>();
    serde_json::json!({ "role": "assistant", "content": Value::Null, "tool_calls": calls })
}

fn append_tool_output_value(
    mut base: Value,
    tool_call_id: &str,
    name: &str,
    content: &str,
) -> Value {
    let mut outputs = base
        .get("tool_outputs")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    outputs.push(serde_json::json!({
        "tool_call_id": tool_call_id,
        "name": name,
        "content": content,
    }));
    if let Some(row) = base.as_object_mut() {
        row.insert("tool_outputs".to_string(), Value::Array(outputs));
    }
    base
}

fn build_tool_messages_from_outputs_value(base: &Value, allow_ids: &[String]) -> Value {
    let allow = allow_ids
        .iter()
        .map(|entry| entry.trim().to_string())
        .filter(|entry| !entry.is_empty())
        .collect::<std::collections::HashSet<_>>();
    let outputs = base
        .get("tool_outputs")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut out = Vec::new();
    for entry in outputs {
        let Some(row) = entry.as_object() else {
            continue;
        };
        let Some(tool_call_id) = row
            .get("tool_call_id")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
        else {
            continue;
        };
        if !allow.contains(tool_call_id) {
            continue;
        }
        let name = row
            .get("name")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or("tool");
        let content = match row.get("content") {
            Some(Value::String(value)) => value.clone(),
            Some(value) => serde_json::to_string(value).unwrap_or_else(|_| "{}".to_string()),
            None => "{}".to_string(),
        };
        out.push(serde_json::json!({
            "role": "tool",
            "tool_call_id": tool_call_id,
            "name": name,
            "content": content,
        }));
    }
    Value::Array(out)
}

fn strip_tool_outputs_value(mut base: Value) -> Value {
    if let Some(row) = base.as_object_mut() {
        row.remove("tool_outputs");
    }
    base
}

fn patch_tool_call_arguments_by_id_value(
    mut chat_response: Value,
    tool_call_id: &str,
    arguments_text: &str,
) -> Value {
    if tool_call_id.trim().is_empty() {
        return chat_response;
    }
    let Some(choices) = chat_response
        .get_mut("choices")
        .and_then(Value::as_array_mut)
    else {
        return chat_response;
    };
    for choice in choices {
        let Some(message) = choice
            .as_object_mut()
            .and_then(|choice_row| choice_row.get_mut("message"))
            .and_then(Value::as_object_mut)
        else {
            continue;
        };
        let Some(tool_calls) = message.get_mut("tool_calls").and_then(Value::as_array_mut) else {
            continue;
        };
        for tool_call in tool_calls {
            let Some(record) = tool_call.as_object_mut() else {
                continue;
            };
            let id = record
                .get("id")
                .and_then(Value::as_str)
                .map(str::trim)
                .unwrap_or("");
            if id != tool_call_id {
                continue;
            }
            for key in ["function", "functionCall", "function_call"] {
                if let Some(fn_row) = record.get_mut(key).and_then(Value::as_object_mut) {
                    fn_row.insert(
                        "arguments".to_string(),
                        Value::String(arguments_text.to_string()),
                    );
                }
            }
            if record.contains_key("arguments") {
                record.insert(
                    "arguments".to_string(),
                    Value::String(arguments_text.to_string()),
                );
            }
        }
    }
    chat_response
}

fn filter_out_executed_tool_calls_value(
    mut chat_response: Value,
    executed_ids: &[String],
) -> Value {
    let executed = executed_ids
        .iter()
        .map(|entry| entry.trim().to_string())
        .filter(|entry| !entry.is_empty())
        .collect::<std::collections::HashSet<_>>();
    if executed.is_empty() {
        return chat_response;
    }
    let Some(choices) = chat_response
        .get_mut("choices")
        .and_then(Value::as_array_mut)
    else {
        return chat_response;
    };
    for choice in choices {
        let Some(message) = choice
            .as_object_mut()
            .and_then(|choice_row| choice_row.get_mut("message"))
            .and_then(Value::as_object_mut)
        else {
            continue;
        };
        let Some(tool_calls) = message.get_mut("tool_calls").and_then(Value::as_array_mut) else {
            continue;
        };
        tool_calls.retain(|tool_call| {
            let id = tool_call
                .as_object()
                .and_then(|row| row.get("id"))
                .and_then(Value::as_str)
                .map(str::trim)
                .unwrap_or("");
            id.is_empty() || !executed.contains(id)
        });
    }
    chat_response
}

#[napi]
pub fn run_servertool_orchestration_mutation_json(input_json: String) -> NapiResult<String> {
    #[derive(Debug, Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct MutationInput {
        op: String,
        #[serde(default)]
        base: Value,
        #[serde(default)]
        tool_calls: Vec<Value>,
        #[serde(default)]
        allow_ids: Vec<String>,
        #[serde(default)]
        executed_ids: Vec<String>,
        #[serde(default)]
        tool_call_id: String,
        #[serde(default)]
        name: String,
        #[serde(default)]
        content: String,
        #[serde(default)]
        arguments_text: String,
    }

    let input: MutationInput =
        serde_json::from_str(&input_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let output = match input.op.as_str() {
        "build_assistant_tool_call_message" => {
            build_assistant_tool_call_message_value(&input.tool_calls)
        }
        "append_tool_output" => {
            append_tool_output_value(input.base, &input.tool_call_id, &input.name, &input.content)
        }
        "build_tool_messages_from_outputs" => {
            build_tool_messages_from_outputs_value(&input.base, &input.allow_ids)
        }
        "strip_tool_outputs" => strip_tool_outputs_value(input.base),
        "patch_tool_call_arguments_by_id" => patch_tool_call_arguments_by_id_value(
            input.base,
            &input.tool_call_id,
            &input.arguments_text,
        ),
        "filter_out_executed_tool_calls" => {
            filter_out_executed_tool_calls_value(input.base, &input.executed_ids)
        }
        other => {
            return Err(napi::Error::from_reason(format!(
                "unknown servertool orchestration mutation op: {other}"
            )))
        }
    };
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}

/// Extract a string field from multiple candidate sources in priority order.
/// Each source is checked in the order given — first non-empty wins.
fn extract_priority_string(
    adapter: &Value,
    runtime: &Value,
    metadata: &Value,
    fields: &[&str],
) -> Option<String> {
    for source in &[adapter, runtime, metadata] {
        if !source.is_object() {
            continue;
        }
        let obj = source.as_object().unwrap();
        for field in fields {
            if let Some(v) = obj.get(*field) {
                if let Some(s) = v.as_str() {
                    let trimmed = s.trim();
                    if !trimmed.is_empty() {
                        return Some(trimmed.to_string());
                    }
                }
            }
        }
    }
    None
}

/// Extract a nested target object's field from multiple sources.
fn extract_target_field(
    adapter: &Value,
    runtime: &Value,
    metadata: &Value,
    field: &str,
) -> Option<String> {
    let candidates = [
        adapter.get("target").and_then(|t| t.get(field)),
        metadata.get("target").and_then(|t| t.get(field)),
        runtime.get("target").and_then(|t| t.get(field)),
    ];
    for v in candidates.into_iter().flatten() {
        if let Some(s) = v.as_str() {
            let trimmed = s.trim();
            if !trimmed.is_empty() {
                return Some(trimmed.to_string());
            }
        }
    }
    None
}

/// Extract runtime metadata from adapter context.
fn extract_runtime(adapter_context: &Value) -> Value {
    if let Some(r) = adapter_context.get("__rt") {
        if r.is_object() {
            return r.clone();
        }
    }
    if let Some(r) = adapter_context.get("runtime") {
        if r.is_object() {
            return r.clone();
        }
    }
    if let Some(m) = adapter_context.get("metadata") {
        if let Some(r) = m.get("__rt") {
            if r.is_object() {
                return r.clone();
            }
        }
        if let Some(r) = m.get("runtime") {
            if r.is_object() {
                return r.clone();
            }
        }
    }
    Value::Null
}

/// Extract metadata object from adapter context.
fn extract_metadata(adapter_context: &Value) -> Value {
    adapter_context
        .get("metadata")
        .filter(|m| m.is_object())
        .cloned()
        .unwrap_or(Value::Null)
}

/// Check if a key matches persistent sticky key pattern.
fn is_persistent_sticky_key(key: &str) -> bool {
    key.starts_with("tmux:") || key.starts_with("session:") || key.starts_with("conversation:")
}

/// Build the handler result for stop_message_auto.
///
/// Rust produces the complete followup plan + persistence metadata.
/// TS keeps I/O (loading/saving routing state files).
#[napi]
pub fn run_stop_message_auto_handler_json(input_json: String) -> NapiResult<String> {
    #[derive(Debug, Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct StopMessageHandlerInput {
        /// The decision from decideStopMessageAction.
        decision: Value,
        /// Adapter context for extracting pinnedTarget, connectionState, runtime metadata.
        adapter_context: Value,
        /// Base chat response (passthrough).
        base: Value,
        /// Candidate keys for persistence scope lookup.
        candidate_keys: Vec<String>,
        /// Optional sticky key from persisted lookup.
        sticky_key: Option<String>,
        /// Optional strict session scope from persisted lookup.
        strict_session_scope: Option<String>,
        /// Followup flow id (e.g. "stop_message_flow").
        followup_flow_id: Option<String>,
    }

    #[derive(Debug, Serialize)]
    #[serde(rename_all = "camelCase")]
    struct StopMessageHandlerOutput {
        chat_response: Value,
        flow_id: String,
        followup: Value,
        persist_keys: Vec<String>,
        state_update: Value,
    }

    let input: StopMessageHandlerInput = serde_json::from_str(&input_json).map_err(|e| {
        napi::Error::from_reason(format!("deserialize StopMessageHandlerInput: {e}"))
    })?;

    // 1. Check decision action
    let action = input
        .decision
        .get("action")
        .and_then(|a| a.as_str())
        .unwrap_or("skip")
        .trim()
        .to_ascii_lowercase();

    if action != "trigger" {
        // Not triggering — return empty result
        let output = StopMessageHandlerOutput {
            chat_response: input.base,
            flow_id: String::new(),
            followup: Value::Null,
            persist_keys: Vec::new(),
            state_update: Value::Null,
        };
        return serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()));
    }

    // 2. Extract values from decision
    let used = input
        .decision
        .get("used")
        .and_then(|v| v.as_u64())
        .unwrap_or(0) as u32;
    let max_repeats = input
        .decision
        .get("maxRepeats")
        .and_then(|v| v.as_u64())
        .or_else(|| input.decision.get("max_repeats").and_then(|v| v.as_u64()))
        .unwrap_or(0) as u32;
    let followup_text = input
        .decision
        .get("followupText")
        .and_then(|v| v.as_str())
        .or_else(|| input.decision.get("followup_text").and_then(|v| v.as_str()))
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .unwrap_or(DEFAULT_STOP_MESSAGE_EXECUTION_PROMPT)
        .to_string();
    let followup_text = normalize_stop_message_followup_text(&followup_text);
    // 3. Extract runtime metadata and metadata for field lookups
    let runtime = extract_runtime(&input.adapter_context);
    let metadata = extract_metadata(&input.adapter_context);

    let model_id = extract_target_field(&input.adapter_context, &runtime, &metadata, "modelId")
        .or_else(|| {
            extract_priority_string(
                &input.adapter_context,
                &runtime,
                &metadata,
                &["assignedModelId", "modelId", "originalModelId"],
            )
        })
        .or_else(|| {
            input
                .decision
                .get("provider_pin")
                .and_then(|p| p.get("model_id"))
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
        });

    let routecodex_port_mode = input
        .adapter_context
        .get("routecodexPortMode")
        .and_then(|v| v.as_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    let route_hint = extract_priority_string(
        &input.adapter_context,
        &runtime,
        &metadata,
        &["routeHint", "routeName", "routeId"],
    );

    // 5. Extract connection state
    let connection_state = (|| -> Option<Value> {
        let cs = input.adapter_context.get("clientConnectionState")?;
        if cs.is_object() {
            Some(cs.clone())
        } else {
            None
        }
    })();

    // 6. Build metadata object for followup
    let mut metadata_obj = Map::new();
    if let Some(cs) = connection_state {
        metadata_obj.insert("clientConnectionState".to_string(), cs);
    }
    if let Some(ref mid) = model_id {
        metadata_obj.insert("assignedModelId".to_string(), Value::String(mid.clone()));
        metadata_obj.insert("modelId".to_string(), Value::String(mid.clone()));
        let mut target_obj = Map::new();
        target_obj.insert("modelId".to_string(), Value::String(mid.clone()));
        metadata_obj.insert("target".to_string(), Value::Object(target_obj));
    }
    if let Some(ref rpm) = routecodex_port_mode {
        metadata_obj.insert("routecodexPortMode".to_string(), Value::String(rpm.clone()));
    }
    if routecodex_port_mode.as_deref() == Some("router") {
        if let Some(ref hint) = route_hint {
            metadata_obj.insert("routeHint".to_string(), Value::String(hint.clone()));
        }
    }
    metadata_obj.insert("serverToolFollowup".to_string(), Value::Bool(true));
    metadata_obj.insert(
        "serverToolFollowupSource".to_string(),
        Value::String("servertool.stop_message".to_string()),
    );
    metadata_obj.insert(
        "clientInjectSource".to_string(),
        Value::String("servertool.stop_message".to_string()),
    );
    metadata_obj.insert(
        "serverToolLoopState".to_string(),
        serde_json::json!({
            "flowId": "stop_message_flow",
            "repeatCount": used + 1,
            "maxRepeats": max_repeats
        }),
    );
    // 7. Build followup plan
    let followup = serde_json::json!({
        "requestIdSuffix": ":stop_followup",
        "injection": {
            "ops": [
                { "op": "append_assistant_message", "required": false },
                { "op": "append_user_text", "text": followup_text }
            ]
        },
        "metadata": Value::Object(metadata_obj)
    });

    // 8. Compute persist keys (deduplicated union)
    let mut persist_keys_set: Vec<String> = Vec::new();
    let raw_keys: Vec<&str> = [
        input.sticky_key.as_deref(),
        input.strict_session_scope.as_deref(),
    ]
    .into_iter()
    .flatten()
    .chain(input.candidate_keys.iter().map(|s| s.as_str()))
    .collect();

    for key in raw_keys {
        if is_persistent_sticky_key(key) && !persist_keys_set.contains(&key.to_string()) {
            persist_keys_set.push(key.to_string());
        }
    }

    // 9. Build state update
    let state_update = serde_json::json!({
        "text": followup_text,
        "maxRepeats": max_repeats,
        "used": used + 1,
        "source": "default",
        "stageMode": "on"
    });

    let output = StopMessageHandlerOutput {
        chat_response: input.base,
        flow_id: "stop_message_flow".to_string(),
        followup,
        persist_keys: persist_keys_set,
        state_update,
    };

    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi]
pub fn plan_servertool_outcome_json(input_json: String) -> NapiResult<String> {
    let input: ServertoolOutcomePlannerInput =
        serde_json::from_str(&input_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let configured_pending_injection_message_kinds =
        normalize_nonempty_string_vec(input.pending_injection_message_kinds.as_ref());
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
        let session_id = input
            .session_id
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty());
        let conversation_id = input
            .conversation_id
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty());
        let pending_session_id = session_id.clone().or_else(|| conversation_id.clone());
        let alias_session_ids = match (&session_id, &conversation_id) {
            (Some(session), Some(conversation)) if session != conversation => {
                vec![conversation.clone()]
            }
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
                input.executed_tool_calls.first().map(|entry| {
                    normalize_routecodex_tool_name(Some(entry.name.as_str()))
                        .unwrap_or_else(|| entry.name.trim().to_ascii_lowercase())
                })
            })
    } else {
        Some("servertool_multi".to_string())
    };
    let use_last_execution_followup =
        input.executed_tool_calls.len() == 1 && input.has_last_execution_followup;
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
    };
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi]
pub fn plan_servertool_auto_hook_queues_json(input_json: String) -> NapiResult<String> {
    let input: ServertoolAutoHookPlannerInput =
        serde_json::from_str(&input_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let include = normalize_filter_token_set(input.include_auto_hook_ids.as_ref());
    let exclude = normalize_filter_token_set(input.exclude_auto_hook_ids.as_ref());

    let mut hooks: Vec<ServertoolAutoHookSpecInput> = input
        .hooks
        .into_iter()
        .filter_map(|hook| {
            let id = normalize_routecodex_tool_name(Some(hook.id.as_str()))
                .unwrap_or_else(|| hook.id.trim().to_ascii_lowercase());
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
        let id = normalize_routecodex_tool_name(Some(raw_id.as_str()))
            .unwrap_or_else(|| raw_id.trim().to_ascii_lowercase());
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
        let id = normalize_routecodex_tool_name(Some(raw_id.as_str()))
            .unwrap_or_else(|| raw_id.trim().to_ascii_lowercase());
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
    fn test_synthetic_routecodex_control_text_scans_visible_content_only() {
        let payload = json!({
            "id": "chatcmpl-stop-client-inject-fail",
            "metadata": {
                "debug": "[RouteCodex] assistant response became empty after response sanitization."
            },
            "choices": [{
                "message": {
                    "role": "assistant",
                    "content": "ok"
                }
            }]
        });
        assert!(!contains_synthetic_routecodex_control_text_value(
            &payload, None
        ));
    }

    #[test]
    fn test_synthetic_routecodex_control_text_detects_visible_message_content() {
        let payload = json!({
            "choices": [{
                "message": {
                    "role": "assistant",
                    "content": "[RouteCodex] assistant response became empty after response sanitization."
                }
            }]
        });
        assert!(contains_synthetic_routecodex_control_text_value(
            &payload, None
        ));
    }

    #[test]
    fn test_backfill_servertool_adapter_context_tools_force_replace() {
        let context = json!({
            "capturedChatRequest": {
                "tools": [{ "type": "function", "function": { "name": "reasoning.stop" } }]
            },
            "__rt": { "serverToolFollowup": true }
        });
        let semantics = json!({
            "tools": {
                "clientToolsRaw": [
                    { "type": "function", "function": { "name": "exec_command" } },
                    { "type": "function", "function": { "name": "apply_patch" } }
                ]
            }
        });

        let output = backfill_servertool_adapter_context_tools_value(context, semantics, true);
        assert_eq!(output["changed"], true);
        let tools = output["context"]["capturedChatRequest"]["tools"]
            .as_array()
            .unwrap();
        assert_eq!(tools[0]["function"]["name"], "exec_command");
        assert_eq!(tools[1]["function"]["name"], "apply_patch");
    }

    #[test]
    fn test_extract_runtime_reads_runtime_carrier() {
        let context = json!({
            "__rt": {
                "serverToolFollowup": true,
                "stopMessageFollowupPolicy": "preserve_eligibility",
                "serverToolLoopState": {
                    "flowId": "stop_message_flow",
                    "repeatCount": 1,
                    "maxRepeats": 3
                }
            },
            "runtime": {
                "serverToolLoopState": {
                    "maxRepeats": 1
                }
            }
        });

        let runtime = extract_runtime(&context);
        assert_eq!(
            runtime["serverToolLoopState"]["flowId"].as_str(),
            Some("stop_message_flow")
        );
        assert_eq!(
            runtime["serverToolLoopState"]["repeatCount"].as_u64(),
            Some(1)
        );
        assert_eq!(
            runtime["serverToolLoopState"]["maxRepeats"].as_u64(),
            Some(3)
        );
    }

    #[test]
    fn test_backfill_servertool_adapter_context_tools_no_client_tools_is_noop() {
        let context = json!({
            "capturedChatRequest": { "messages": [] }
        });
        let output = backfill_servertool_adapter_context_tools_value(context, json!({}), false);
        assert_eq!(output["changed"], false);
    }

    #[test]
    fn test_resolve_provider_response_request_semantics_merges_followup_tools() {
        let processed = json!({
            "tools": [
                { "type": "function", "function": { "name": "reasoning.stop" } }
            ]
        });
        let request_metadata = json!({
            "requestSemantics": {
                "tools": {
                    "clientToolsRaw": [
                        { "type": "function", "function": { "name": "exec_command" } },
                        { "type": "function", "function": { "name": "apply_patch" } }
                    ]
                }
            },
            "__rt": {
                "serverToolFollowup": true,
                "clientInjectSource": "servertool.reasoning_stop_guard"
            }
        });

        let output = resolve_provider_response_request_semantics_value(
            processed,
            Value::Null,
            request_metadata,
        );
        let tools = output["tools"]["clientToolsRaw"].as_array().unwrap();
        assert_eq!(tools.len(), 3);
        assert_eq!(tools[0]["function"]["name"], "exec_command");
        assert_eq!(tools[1]["function"]["name"], "apply_patch");
        assert_eq!(tools[2]["function"]["name"], "reasoning.stop");
    }

    #[test]
    fn test_resolve_provider_response_request_semantics_falls_back_to_root_tools() {
        let processed = json!({
            "tools": [
                { "type": "function", "function": { "name": "exec_command" } }
            ]
        });
        let output =
            resolve_provider_response_request_semantics_value(processed, Value::Null, Value::Null);
        let tools = output["tools"]["clientToolsRaw"].as_array().unwrap();
        assert_eq!(tools.len(), 1);
        assert_eq!(tools[0]["function"]["name"], "exec_command");
    }

    #[test]
    fn test_stop_message_auto_followup_does_not_pin_provider() {
        let input = json!({
            "base": {
                "choices": [{"message": {"role": "assistant", "content": "阶段完成"}, "finish_reason": "stop"}]
            },
            "decision": {
                "action": "trigger",
                "used": 0,
                "maxRepeats": 3,
                "followupText": "继续执行",
                "provider_pin": {
                    "provider_key": "minimax.key1.MiniMax-M3",
                    "model_id": "MiniMax-M3"
                }
            },
            "adapterContext": {
                "target": {
                    "providerKey": "minimax.key1.MiniMax-M3",
                    "modelId": "MiniMax-M3"
                },
                "targetProviderKey": "minimax.key1.MiniMax-M3",
                "providerKey": "minimax.key1.MiniMax-M3",
                "routeId": "search",
                "__rt": {
                    "targetProviderKey": "minimax.key1.MiniMax-M3",
                    "providerKey": "minimax.key1.MiniMax-M3"
                },
                "routecodexPortMode": "router"
            },
            "candidateKeys": [],
            "stickyKey": null,
            "strictSessionScope": null
        });

        let output: Value = serde_json::from_str(
            &run_stop_message_auto_handler_json(input.to_string()).expect("handler output"),
        )
        .expect("json output");
        let metadata = &output["followup"]["metadata"];
        assert_eq!(metadata["modelId"].as_str(), Some("MiniMax-M3"));
        assert_eq!(metadata["routeHint"].as_str(), Some("search"));
        assert_eq!(metadata["serverToolFollowup"].as_bool(), Some(true));
        assert_eq!(
            metadata["serverToolFollowupSource"].as_str(),
            Some("servertool.stop_message")
        );
        assert_eq!(
            metadata["clientInjectSource"].as_str(),
            Some("servertool.stop_message")
        );
        assert_eq!(
            metadata["serverToolLoopState"]["flowId"].as_str(),
            Some("stop_message_flow")
        );
        assert_eq!(
            metadata["serverToolLoopState"]["repeatCount"].as_u64(),
            Some(1)
        );
        assert_eq!(
            metadata["serverToolLoopState"]["maxRepeats"].as_u64(),
            Some(3)
        );
        assert!(metadata.get("providerKey").is_none());
        assert!(metadata.get("targetProviderKey").is_none());
        assert!(metadata.get("__shadowCompareForcedProviderKey").is_none());
        assert!(metadata["target"].get("providerKey").is_none());
    }

    #[test]
    fn test_stop_message_auto_default_followup_prompt_requires_goal_execution() {
        let input = json!({
            "base": {
                "choices": [{"message": {"role": "assistant", "content": "阶段完成"}, "finish_reason": "stop"}]
            },
            "decision": {
                "action": "trigger",
                "used": 0,
                "maxRepeats": 3
            },
            "adapterContext": {
                "routeId": "tools",
                "routecodexPortMode": "router"
            },
            "candidateKeys": [],
            "stickyKey": null,
            "strictSessionScope": null
        });

        let output: Value = serde_json::from_str(
            &run_stop_message_auto_handler_json(input.to_string()).expect("handler output"),
        )
        .expect("json output");
        let text = output["followup"]["injection"]["ops"][1]["text"]
            .as_str()
            .expect("followup text");
        assert!(text.contains("当前用户目标"));
        assert!(text.contains("必须调用可用工具"));
        assert!(text.contains("不要只总结"));
        assert_ne!(text, "继续执行");
    }

    #[test]
    fn test_stop_message_auto_upgrades_legacy_followup_text() {
        let input = json!({
            "base": {
                "choices": [{"message": {"role": "assistant", "content": "阶段完成"}, "finish_reason": "stop"}]
            },
            "decision": {
                "action": "trigger",
                "used": 0,
                "maxRepeats": 3,
                "followupText": "继续执行"
            },
            "adapterContext": {
                "routeId": "tools",
                "routecodexPortMode": "router"
            },
            "candidateKeys": [],
            "stickyKey": null,
            "strictSessionScope": null
        });

        let output: Value = serde_json::from_str(
            &run_stop_message_auto_handler_json(input.to_string()).expect("handler output"),
        )
        .expect("json output");
        let text = output["followup"]["injection"]["ops"][1]["text"]
            .as_str()
            .expect("followup text");
        assert!(text.contains("当前用户目标"));
        assert!(text.contains("必须调用可用工具"));
        assert_ne!(text, "继续执行");
    }

    #[test]
    fn test_stop_message_auto_preserves_custom_followup_text() {
        let input = json!({
            "base": {
                "choices": [{"message": {"role": "assistant", "content": "阶段完成"}, "finish_reason": "stop"}]
            },
            "decision": {
                "action": "trigger",
                "used": 0,
                "maxRepeats": 3,
                "followupText": "继续执行并补齐验证证据"
            },
            "adapterContext": {
                "routeId": "tools",
                "routecodexPortMode": "router"
            },
            "candidateKeys": [],
            "stickyKey": null,
            "strictSessionScope": null
        });

        let output: Value = serde_json::from_str(
            &run_stop_message_auto_handler_json(input.to_string()).expect("handler output"),
        )
        .expect("json output");
        let text = output["followup"]["injection"]["ops"][1]["text"]
            .as_str()
            .expect("followup text");
        assert_eq!(text, "继续执行并补齐验证证据");
    }

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
                                    "name": "continue_execution",
                                    "arguments": "{\"action\":\"list\"}"
                                }
                            }
                        ]
                    }
                }
            ]
        });
        let tool_calls =
            extract_tool_calls_from_chat_payload_mut(&mut payload, "req_sample_source_id").unwrap();
        assert_eq!(tool_calls.len(), 1);
        assert_eq!(tool_calls[0].name, "continue_execution");
        assert!(tool_calls[0].id.starts_with("call_"));
        assert_eq!(tool_calls[0].id.len(), 29);
    }

    #[test]
    fn test_servertool_orchestration_mutation_ops_run_in_rust() {
        let base = json!({
            "choices": [{"message": {"role": "assistant", "tool_calls": [
                {"id":"call_keep", "type":"function", "function":{"name":"client", "arguments":"{}"}},
                {"id":"call_done", "type":"function", "function":{"name":"apply_patch", "arguments":"old"}}
            ]}}],
            "tool_outputs": [{"tool_call_id":"call_done", "name":"apply_patch", "content":{"ok":true}}]
        });

        let patched = run_servertool_orchestration_mutation_json(
            json!({
                "op":"patch_tool_call_arguments_by_id",
                "base": base,
                "toolCallId":"call_done",
                "argumentsText":"new"
            })
            .to_string(),
        )
        .expect("patched");
        let patched_value: Value = serde_json::from_str(&patched).unwrap();
        assert_eq!(
            patched_value["choices"][0]["message"]["tool_calls"][1]["function"]["arguments"],
            "new"
        );

        let filtered = run_servertool_orchestration_mutation_json(
            json!({
                "op":"filter_out_executed_tool_calls",
                "base": patched_value,
                "executedIds":["call_done"]
            })
            .to_string(),
        )
        .expect("filtered");
        let filtered_value: Value = serde_json::from_str(&filtered).unwrap();
        assert_eq!(
            filtered_value["choices"][0]["message"]["tool_calls"]
                .as_array()
                .unwrap()
                .len(),
            1
        );

        let messages = run_servertool_orchestration_mutation_json(
            json!({
                "op":"build_tool_messages_from_outputs",
                "base": filtered_value,
                "allowIds":["call_done"]
            })
            .to_string(),
        )
        .expect("messages");
        let messages_value: Value = serde_json::from_str(&messages).unwrap();
        assert_eq!(messages_value[0]["role"], "tool");
        assert_eq!(messages_value[0]["tool_call_id"], "call_done");
    }

    #[test]
    fn build_servertool_tool_output_payload_appends_output_and_strips_consumed_call() {
        let raw = build_servertool_tool_output_payload_json(
            json!({
                "base": {
                    "choices": [{"message": {"role": "assistant", "tool_calls": [
                        {"id":"keep_1", "type":"function", "function":{"name":"client_tool", "arguments":"{}"}},
                        {"id":"ap_1", "type":"function", "function":{"name":"apply_patch", "arguments":"old"}}
                    ]}}]
                },
                "toolCallId": "ap_1",
                "toolName": "apply_patch",
                "arguments": "{}",
                "content": {"ok": true},
                "stripToolCallName": "apply_patch"
            })
            .to_string(),
        )
        .expect("payload");
        let value: Value = serde_json::from_str(&raw).unwrap();
        let output = &value["tool_outputs"][0];
        assert_eq!(output["tool_call_id"], "ap_1");
        assert_eq!(output["name"], "apply_patch");
        assert_eq!(output["arguments"], "{}");
        assert_eq!(output["content"], r#"{"ok":true}"#);

        let calls = value["choices"][0]["message"]["tool_calls"]
            .as_array()
            .unwrap();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0]["id"], "keep_1");
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
        let tool_calls =
            extract_tool_calls_from_chat_payload_mut(&mut payload, "req_exec").unwrap();
        assert_eq!(tool_calls.len(), 1);
        assert_eq!(tool_calls[0].id, "good_exec_call");
    }

    #[test]
    fn test_plan_servertool_tool_call_dispatch_filters_and_selects_registered_handlers() {
        let raw = serde_json::json!({
            "toolCalls": [
                { "id": "call_1", "name": "sample_client_tool", "arguments": "{}" },
                { "id": "call_2", "name": "exec_command", "arguments": "{\"cmd\":\"pwd\"}" },
                { "id": "call_3", "name": "unknown_tool", "arguments": "{}" }
            ],
            "disableToolCallHandlers": false,
            "includeToolCallHandlerNames": ["sample_client_tool", "exec_command", "unknown_tool"],
            "excludeToolCallHandlerNames": ["exec_command"],
            "registeredToolCallHandlers": [
                {
                    "name": "sample_client_tool",
                    "trigger": "tool_call",
                    "executionMode": "client_inject_only",
                    "stripAfterExecute": true
                },
                {
                    "name": "continue_execution",
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
        assert_eq!(
            executable[0].get("name").and_then(|v| v.as_str()),
            Some("sample_client_tool")
        );
        assert_eq!(
            executable[0].get("executionMode").and_then(|v| v.as_str()),
            Some("client_inject_only")
        );
        assert_eq!(
            executable[0]
                .get("stripAfterExecute")
                .and_then(|v| v.as_bool()),
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
    fn test_plan_servertool_dispatch_apply_patch_gated_by_runtime_mode() {
        let base = serde_json::json!({
            "toolCalls": [
                { "id": "call_patch", "name": "apply_patch", "arguments": "{}" }
            ],
            "disableToolCallHandlers": false,
            "registeredToolCallHandlers": [
                {
                    "name": "apply_patch",
                    "trigger": "tool_call",
                    "executionMode": "reenter",
                    "stripAfterExecute": true
                }
            ]
        });

        let client_output = plan_servertool_tool_call_dispatch_json(base.to_string()).unwrap();
        let client_parsed: serde_json::Value =
            serde_json::from_str(client_output.as_str()).unwrap();
        assert_eq!(
            client_parsed
                .get("executableToolCalls")
                .and_then(|v| v.as_array())
                .map(|v| v.len()),
            Some(0)
        );
        assert_eq!(
            client_parsed
                .get("skippedToolCalls")
                .and_then(|v| v.as_array())
                .and_then(|rows| rows.first())
                .and_then(|row| row.get("reason"))
                .and_then(|v| v.as_str()),
            Some("apply_patch_client_mode")
        );

        let mut servertool = base;
        servertool["runtimeMetadata"] = serde_json::json!({
            "__rt": { "applyPatch": { "mode": "servertool" } }
        });
        let servertool_output =
            plan_servertool_tool_call_dispatch_json(servertool.to_string()).unwrap();
        let servertool_parsed: serde_json::Value =
            serde_json::from_str(servertool_output.as_str()).unwrap();
        assert_eq!(
            servertool_parsed
                .get("executableToolCalls")
                .and_then(|v| v.as_array())
                .and_then(|rows| rows.first())
                .and_then(|row| row.get("name"))
                .and_then(|v| v.as_str()),
            Some("apply_patch")
        );
    }

    #[test]
    fn test_plan_servertool_outcome_prefers_mixed_branch_with_pending_session_target() {
        let raw = serde_json::json!({
            "toolCalls": [
                { "id": "call_1", "name": "sample_client_tool", "arguments": "{}" },
                { "id": "call_2", "name": "exec_command", "arguments": "{\"cmd\":\"pwd\"}" }
            ],
            "executedToolCalls": [
                {
                    "id": "call_1",
                    "name": "sample_client_tool",
                    "arguments": "{}",
                    "executionMode": "client_inject_only",
                    "stripAfterExecute": true
                }
            ],
            "executedFlowIds": ["sample_done"],
            "lastExecutionFlowId": "sample_done",
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
            parsed
                .get("requiresPendingInjection")
                .and_then(|v| v.as_bool()),
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
                .map(|entries| entries
                    .iter()
                    .filter_map(|entry| entry.as_str())
                    .collect::<Vec<_>>()),
            Some(vec!["assistant_tool_calls", "tool_outputs"])
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
                { "id": "call_1", "name": "sample_client_tool", "arguments": "{}" }
            ],
            "executedToolCalls": [
                {
                    "id": "call_1",
                    "name": "sample_client_tool",
                    "arguments": "{}",
                    "executionMode": "client_inject_only",
                    "stripAfterExecute": true
                }
            ],
            "executedFlowIds": ["sample_done"],
            "lastExecutionFlowId": "sample_done",
            "hasLastExecutionFollowup": true
        });
        let output = plan_servertool_outcome_json(raw.to_string()).unwrap();
        let parsed: serde_json::Value = serde_json::from_str(output.as_str()).unwrap();
        assert_eq!(
            parsed.get("outcomeMode").and_then(|v| v.as_str()),
            Some("servertool_only")
        );
        assert_eq!(
            parsed.get("flowId").and_then(|v| v.as_str()),
            Some("sample_done")
        );
        assert_eq!(
            parsed
                .get("useLastExecutionFollowup")
                .and_then(|v| v.as_bool()),
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
            parsed
                .get("requiresPendingInjection")
                .and_then(|v| v.as_bool()),
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
    }

    #[test]
    fn test_plan_servertool_outcome_resolves_generic_followup_ops_when_last_followup_missing() {
        let raw = serde_json::json!({
            "toolCalls": [
                { "id": "call_1", "name": "sample_client_tool", "arguments": "{}" }
            ],
            "executedToolCalls": [
                {
                    "id": "call_1",
                    "name": "sample_client_tool",
                    "arguments": "{}",
                    "executionMode": "client_inject_only",
                    "stripAfterExecute": true
                }
            ],
            "executedFlowIds": ["sample_done"],
            "lastExecutionFlowId": "sample_done",
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
    }

    #[test]
    fn test_plan_servertool_auto_hook_queues_prioritizes_pre_then_primary_then_remaining() {
        let raw = serde_json::json!({
            "hooks": [
                { "id": "stop_message_auto", "phase": "default", "priority": 40, "order": 3 },
                { "id": "sample_auto", "phase": "post", "priority": 50, "order": 4 },
                { "id": "recursive_detection_guard", "phase": "pre", "priority": 5, "order": 0 },
                { "id": "reasoning_only_continue", "phase": "post", "priority": 200, "order": 5 }
            ],
            "optionalPrimaryHookOrder": ["sample_auto", "stop_message_auto"],
            "mandatoryHookOrder": []
        });
        let output = plan_servertool_auto_hook_queues_json(raw.to_string()).unwrap();
        let parsed: serde_json::Value = serde_json::from_str(output.as_str()).unwrap();
        let optional = parsed
            .get("optionalQueue")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();
        let ids: Vec<String> = optional
            .iter()
            .filter_map(|entry| {
                entry
                    .get("id")
                    .and_then(|v| v.as_str())
                    .map(|v| v.to_string())
            })
            .collect();
        assert_eq!(
            ids,
            vec![
                "recursive_detection_guard",
                "sample_auto",
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
                { "id": "sample_auto", "phase": "post", "priority": 50, "order": 4 },
                { "id": "recursive_detection_guard", "phase": "pre", "priority": 5, "order": 0 }
            ],
            "includeAutoHookIds": ["sample_auto", "stop_message_auto"],
            "excludeAutoHookIds": ["stop_message_auto"],
            "optionalPrimaryHookOrder": ["sample_auto", "stop_message_auto"],
            "mandatoryHookOrder": []
        });
        let output = plan_servertool_auto_hook_queues_json(raw.to_string()).unwrap();
        let parsed: serde_json::Value = serde_json::from_str(output.as_str()).unwrap();
        let optional = parsed
            .get("optionalQueue")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();
        assert_eq!(optional.len(), 1);
        assert_eq!(
            optional[0].get("id").and_then(|v| v.as_str()),
            Some("sample_auto")
        );
        assert_eq!(
            optional[0].get("queueIndex").and_then(|v| v.as_i64()),
            Some(1)
        );
        assert_eq!(
            optional[0].get("queueTotal").and_then(|v| v.as_i64()),
            Some(1)
        );
    }

    #[test]
    fn test_plan_chat_web_search_operations_user_intent_prefers_direct_route_and_skips_servertool()
    {
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
        let output =
            plan_chat_web_search_operations_json(request.to_string(), runtime_metadata.to_string())
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
        let output =
            plan_chat_web_search_operations_json(request.to_string(), runtime_metadata.to_string())
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
    fn test_plan_servertool_dispatch_and_outcome_for_apply_patch_servertool_mode() {
        // Red test: verify servertool apply_patch dispatch + outcome + followup
        // Part 1: dispatch - apply_patch should be executable
        let dispatch_input = serde_json::json!({
            "toolCalls": [
                { "id": "ap_1", "name": "apply_patch", "arguments": "{\"filePath\":\"src/main.ts\",\"patch\":\"+new line\"}" }
            ],
            "disableToolCallHandlers": false,
            "registeredToolCallHandlers": [
                {
                    "name": "apply_patch",
                    "trigger": "tool_call",
                    "executionMode": "reenter",
                    "stripAfterExecute": true
                }
            ],
            "runtimeMetadata": {
                "__rt": { "applyPatch": { "mode": "servertool" } }
            }
        });
        let dispatch_out =
            plan_servertool_tool_call_dispatch_json(dispatch_input.to_string()).unwrap();
        let dispatch_parsed: serde_json::Value =
            serde_json::from_str(dispatch_out.as_str()).unwrap();
        assert_eq!(
            dispatch_parsed["executableToolCalls"][0]["name"], "apply_patch",
            "apply_patch should be executable when mode=servertool"
        );
        assert_eq!(
            dispatch_parsed["executableToolCalls"][0]["executionMode"], "reenter",
            "apply_patch should use reenter execution mode"
        );
        assert_eq!(
            dispatch_parsed["executableToolCalls"][0]["stripAfterExecute"], true,
            "apply_patch should be stripped after execute"
        );

        // Part 2: outcome - after execution, outcomeMode should be servertool_only
        let outcome_input = serde_json::json!({
            "toolCalls": [
                { "id": "ap_1", "name": "apply_patch", "arguments": "{}" }
            ],
            "executedToolCalls": [
                {
                    "id": "ap_1",
                    "name": "apply_patch",
                    "arguments": "{\"filePath\":\"src/main.ts\",\"patch\":\"+new line\"}",
                    "executionMode": "reenter",
                    "stripAfterExecute": true
                }
            ],
            "executedFlowIds": [],
            "lastExecutionFlowId": "",
            "hasLastExecutionFollowup": false,
            "toolOutputs": [{
                "tool_call_id": "ap_1",
                "name": "apply_patch",
                "content": "{\"ok\":true,\"summary\":\"Applied patch\"}"
            }],
            "sessionId": "sess_1",
            "conversationId": "conv_1"
        });
        let outcome_out = plan_servertool_outcome_json(outcome_input.to_string()).unwrap();
        let outcome_parsed: serde_json::Value = serde_json::from_str(outcome_out.as_str()).unwrap();

        // All tool_calls were consumed → servertool_only
        assert_eq!(
            outcome_parsed["outcomeMode"], "servertool_only",
            "single servertool-only call should produce servertool_only outcome"
        );
        // remining_tool_call_ids should be empty
        assert!(
            outcome_parsed["remainingToolCallIds"]
                .as_array()
                .map(|a| a.is_empty())
                .unwrap_or(false),
            "all tool calls were executed → no remaining"
        );
        // followup should be via generic_tool_outputs (no last execution followup)
        assert_eq!(
            outcome_parsed["followupStrategy"], "generic_tool_outputs",
            "no last followup → generic_tool_outputs strategy"
        );
        // pending_injection should NOT be needed for servertool_only mode
        assert_eq!(
            outcome_parsed["requiresPendingInjection"], false,
            "servertool_only mode should not require pending injection"
        );
    }

    #[test]
    fn test_plan_chat_web_search_operations_tool_intent_servertool_mode_injects_via_semantics_force(
    ) {
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
        let output =
            plan_chat_web_search_operations_json(request.to_string(), runtime_metadata.to_string())
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

/// Read followup client inject source from adapter context.
#[napi]
pub fn read_followup_client_inject_source_json(
    adapter_context_json: String,
) -> napi::Result<String> {
    let ctx: serde_json::Value = serde_json::from_str(&adapter_context_json)
        .map_err(|e| napi::Error::new(napi::Status::InvalidArg, e.to_string()))?;

    let obj = match &ctx {
        serde_json::Value::Object(m) => m,
        _ => return Ok(String::new()),
    };

    // Direct clientInjectSource
    if let Some(serde_json::Value::String(s)) = obj.get("clientInjectSource") {
        let trimmed = s.trim();
        if !trimmed.is_empty() {
            return Ok(trimmed.to_string());
        }
    }

    // From __rt
    if let Some(serde_json::Value::Object(rt)) = obj.get("__rt") {
        if let Some(serde_json::Value::String(s)) = rt.get("clientInjectSource") {
            let trimmed = s.trim();
            if !trimmed.is_empty() {
                return Ok(trimmed.to_string());
            }
        }
    }

    Ok(String::new())
}

// ── Apply Patch ────────────────────────────────────────────────────────────

/// Parse tool call arguments from raw JSON string with recovery for malformed input.
fn parse_apply_patch_arguments(raw: &str) -> serde_json::Value {
    if raw.trim().is_empty() {
        return serde_json::json!({});
    }
    // Try standard JSON parse first
    match serde_json::from_str::<serde_json::Value>(raw) {
        Ok(v) if v.is_object() => v,
        _ => {
            // Recovery: regex-based field extraction for malformed JSON
            let mut map = serde_json::Map::new();

            let file_path = raw
                .split('"')
                .collect::<Vec<_>>()
                .windows(3)
                .find(|w| {
                    let key = w[0].trim();
                    let val = w[1].trim();
                    (key == "filePath" || key == "file_path" || key == "path") && !val.is_empty()
                })
                .and_then(|w| {
                    let v = w[1].to_string();
                    if !v.is_empty() {
                        Some(v)
                    } else {
                        None
                    }
                });
            if let Some(fp) = file_path {
                map.insert("filePath".to_string(), serde_json::Value::String(fp));
            }

            let patch = raw
                .split('"')
                .collect::<Vec<_>>()
                .windows(3)
                .find(|w| {
                    let key = w[0].trim();
                    let val = w[1].trim();
                    (key == "patch" || key == "input" || key == "diff" || key == "changes")
                        && !val.is_empty()
                })
                .and_then(|w| {
                    let v = w[1].to_string();
                    if !v.is_empty() {
                        Some(v)
                    } else {
                        None
                    }
                });
            if let Some(p) = patch {
                map.insert("patch".to_string(), serde_json::Value::String(p));
            }

            serde_json::Value::Object(map)
        }
    }
}

fn stringify_servertool_output_content(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Null => "null".to_string(),
        other => serde_json::to_string(other).unwrap_or_else(|_| other.to_string()),
    }
}

fn strip_servertool_call(base: &mut Value, tool_call_id: &str, tool_name: &str) {
    let Some(choices) = base.get_mut("choices").and_then(Value::as_array_mut) else {
        return;
    };
    for choice in choices {
        let Some(message) = choice.get_mut("message") else {
            continue;
        };
        let Some(message_obj) = message.as_object_mut() else {
            continue;
        };
        let Some(calls) = message_obj
            .get("tool_calls")
            .and_then(Value::as_array)
            .cloned()
        else {
            continue;
        };
        let kept: Vec<Value> = calls
            .into_iter()
            .filter(|call| {
                let Some(row) = call.as_object() else {
                    return true;
                };
                let id = row
                    .get("id")
                    .or_else(|| row.get("call_id"))
                    .and_then(Value::as_str)
                    .unwrap_or("");
                if id != tool_call_id {
                    return true;
                }
                let name = row
                    .get("function")
                    .and_then(Value::as_object)
                    .and_then(|function| function.get("name"))
                    .or_else(|| row.get("name"))
                    .and_then(Value::as_str)
                    .unwrap_or("");
                name != tool_name
            })
            .collect();
        if kept.is_empty() {
            message_obj.remove("tool_calls");
        } else {
            message_obj.insert("tool_calls".to_string(), Value::Array(kept));
        }
    }
}

#[napi]
pub fn build_servertool_tool_output_payload_json(input_json: String) -> NapiResult<String> {
    #[derive(Debug, Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Input {
        base: Value,
        tool_call_id: String,
        tool_name: String,
        #[serde(default)]
        arguments: Option<String>,
        content: Value,
        #[serde(default)]
        strip_tool_call_name: Option<String>,
    }

    let input: Input = serde_json::from_str(&input_json)
        .map_err(|e| napi::Error::from_reason(format!("deserialize: {e}")))?;
    let mut base = input.base;
    let base_obj = base
        .as_object_mut()
        .ok_or_else(|| napi::Error::from_reason("base must be an object".to_string()))?;
    let existing_outputs = base_obj
        .get("tool_outputs")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut outputs = existing_outputs;
    let mut output = Map::new();
    output.insert(
        "tool_call_id".to_string(),
        Value::String(input.tool_call_id.clone()),
    );
    output.insert("name".to_string(), Value::String(input.tool_name.clone()));
    if let Some(arguments) = input.arguments {
        output.insert("arguments".to_string(), Value::String(arguments));
    }
    output.insert(
        "content".to_string(),
        Value::String(stringify_servertool_output_content(&input.content)),
    );
    outputs.push(Value::Object(output));
    base_obj.insert("tool_outputs".to_string(), Value::Array(outputs));

    if let Some(strip_name) = input.strip_tool_call_name.as_deref() {
        strip_servertool_call(&mut base, &input.tool_call_id, strip_name);
    }

    serde_json::to_string(&base).map_err(|e| napi::Error::from_reason(e.to_string()))
}

/// Read patch text from parsed args — try `patch`, `input`, `diff`, `changes` fields.
fn read_patch_text_from_args(args: &serde_json::Value) -> String {
    for key in &["patch", "input", "diff", "changes"] {
        if let Some(v) = args.get(*key) {
            if let Some(s) = v.as_str() {
                let trimmed = s.trim();
                if !trimmed.is_empty() {
                    return trimmed.to_string();
                }
            }
        }
    }
    String::new()
}

/// Strip outer quotes from a string.
fn strip_outer_quotes(s: &str) -> String {
    let trimmed = s.trim();
    let chars: &[_] = &['"', '\'', '`'];
    if trimmed.starts_with(chars) && trimmed.ends_with(chars) && trimmed.len() >= 2 {
        trimmed[1..trimmed.len() - 1].trim().to_string()
    } else {
        trimmed.to_string()
    }
}

/// Normalize a patch line: ensure `+` or `-` prefix is followed by space.
fn normalize_patch_line(line: &str) -> String {
    let trimmed = line.trim_end();
    if trimmed.starts_with('+') && !trimmed.starts_with("+++") {
        if trimmed.len() == 1 || !trimmed[1..].starts_with(' ') {
            return format!("+ {}", &trimmed[1..]);
        }
    }
    if trimmed.starts_with('-') && !trimmed.starts_with("---") {
        if trimmed.len() == 1 || !trimmed[1..].starts_with(' ') {
            return format!("- {}", &trimmed[1..]);
        }
    }
    trimmed.to_string()
}

/// Check if text is a valid line-edit block (all lines start with `+ ` or `- `).
fn is_line_edit_block(text: &str) -> bool {
    let rows: Vec<&str> = text
        .split('\n')
        .map(|l| l.trim())
        .filter(|l| !l.is_empty())
        .collect();
    if rows.is_empty() {
        return false;
    }
    rows.iter()
        .all(|l| l.starts_with("+ ") || l.starts_with("- ") || *l == "+" || *l == "-")
}

/// Extract fenced patch text from markdown ``` blocks.
fn extract_fenced_patch_text(text: &str) -> Option<String> {
    let re = regex::Regex::new(r"```(?:diff|patch|text)?\s*\n([\s\S]*?)\n```").ok()?;
    let caps = re.captures(text)?;
    let content = caps.get(1)?.as_str().to_string();
    if content.trim().is_empty() {
        None
    } else {
        Some(content)
    }
}

/// Normalize a line-edit block, returning the normalized patch.
fn normalize_line_edit_block(text: &str) -> Option<String> {
    let normalized: Vec<String> = text
        .replace("\r\n", "\n")
        .replace('\r', "\n")
        .split('\n')
        .filter(|l| !l.trim().is_empty())
        .map(normalize_patch_line)
        .collect();
    if normalized.is_empty() {
        return None;
    }
    let all_line_edit = normalized
        .iter()
        .all(|l| l == "+" || l == "-" || l.starts_with("+ ") || l.starts_with("- "));
    if all_line_edit {
        Some(normalized.join("\n"))
    } else {
        None
    }
}

/// Convert a native patch (from model) to line-edit format.
fn convert_native_patch_to_line_edit(raw_patch: &str, target_path: &str) -> String {
    let text = raw_patch.replace("\r\n", "\n").replace('\r', "\n");

    // Try direct line-edit block
    if let Some(normalized) = normalize_line_edit_block(&text) {
        return normalized;
    }

    // Try fenced block
    if let Some(fenced) = extract_fenced_patch_text(&text) {
        if let Some(normalized) = normalize_line_edit_block(&fenced) {
            return normalized;
        }
    }

    // Try /** Begin Patch ... End Patch **/ format
    if text.contains("*** Begin Patch") {
        let mut out = Vec::new();
        let mut active = false;
        let mut selected = target_path.trim().is_empty();
        for line in text.lines() {
            let trimmed = line.trim();
            if trimmed.starts_with("*** ") && trimmed.contains("File:") {
                active = true;
                let header_path = trimmed
                    .split("File:")
                    .nth(1)
                    .map(|s| s.trim().trim_matches('"').trim_matches('\''))
                    .unwrap_or("");
                selected = target_path.trim().is_empty()
                    || header_path == target_path
                    || header_path.ends_with(&format!("/{}", target_path));
                continue;
            }
            if trimmed.starts_with("*** End Patch") {
                break;
            }
            if trimmed.starts_with("*** ") {
                active = false;
                selected = false;
                continue;
            }
            if !active || !selected {
                continue;
            }
            if trimmed.starts_with("@@") || trimmed.starts_with(' ') {
                continue;
            }
            if (trimmed.starts_with('+') && !trimmed.starts_with("+++"))
                || (trimmed.starts_with('-') && !trimmed.starts_with("---"))
            {
                out.push(normalize_patch_line(trimmed));
            }
        }
        return out.join("\n");
    }

    // Fallback: normalize all lines
    text.lines()
        .map(normalize_patch_line)
        .collect::<Vec<_>>()
        .join("\n")
}

/// Parse a line-edit patch into hunks (remove/add pairs).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct LineEditHunk {
    remove: Vec<String>,
    add: Vec<String>,
}

fn parse_line_edit_patch(patch: &str) -> Result<ParsedPatch, String> {
    let text = patch.replace("\r\n", "\n").replace('\r', "\n");
    let rows: Vec<&str> = text
        .split('\n')
        .filter(|line| {
            !(line.is_empty()
                && text.ends_with('\n')
                && rows_count(&text) == rows_count_before_split(&text, line))
        })
        .collect();

    // Actually, simpler: filter trailing empty
    let rows: Vec<&str> = text.split('\n').collect();
    let rows: Vec<&str> = if rows.last().map(|s| s.is_empty()).unwrap_or(false) {
        rows[..rows.len() - 1].to_vec()
    } else {
        rows
    }
    .into_iter()
    .filter(|l| !(l.is_empty()))
    .collect();

    if rows.is_empty() {
        return Err("PATCH_EMPTY".to_string());
    }

    let mut hunks: Vec<LineEditHunk> = Vec::new();
    let mut current = LineEditHunk {
        remove: Vec::new(),
        add: Vec::new(),
    };

    let mut removed = 0u32;
    let mut added = 0u32;

    for line in &rows {
        let trimmed = line.trim_end();
        if trimmed.starts_with("- ") || trimmed == "-" {
            if !current.add.is_empty() {
                hunks.push(current);
                current = LineEditHunk {
                    remove: Vec::new(),
                    add: Vec::new(),
                };
            }
            current.remove.push(if trimmed == "-" {
                String::new()
            } else {
                trimmed[2..].to_string()
            });
            removed += 1;
        } else if trimmed.starts_with("+ ") || trimmed == "+" {
            current.add.push(if trimmed == "+" {
                String::new()
            } else {
                trimmed[2..].to_string()
            });
            added += 1;
        } else {
            return Err(format!(
                "PATCH_INVALID: patch line must begin with '- ' or '+ '"
            ));
        }
    }
    if !current.remove.is_empty() || !current.add.is_empty() {
        hunks.push(current);
    }

    if removed == 0 && added == 0 {
        return Err("PATCH_EMPTY".to_string());
    }

    Ok(ParsedPatch {
        hunks,
        removed,
        added,
    })
}

fn rows_count(s: &str) -> usize {
    s.split('\n').count()
}

fn rows_count_before_split(s: &str, line: &str) -> usize {
    // Not used, workaround for borrow checker
    0
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ParsedPatch {
    hunks: Vec<LineEditHunk>,
    removed: u32,
    added: u32,
}

/// Find a subsequence in a source vector.
fn find_subsequence(source: &[String], needle: &[String]) -> Option<usize> {
    if needle.is_empty() {
        return Some(source.len());
    }
    if needle.len() > source.len() {
        return None;
    }
    let end = source.len() - needle.len();
    for start in 0..=end {
        if source[start..start + needle.len()] == *needle {
            return Some(start);
        }
    }
    None
}

/// Apply line-edit hunks to target content.
fn apply_line_edit_patch(target_content: &str, hunks: &[LineEditHunk]) -> Result<String, String> {
    let lines: Vec<String> = target_content
        .replace("\r\n", "\n")
        .replace('\r', "\n")
        .split('\n')
        .map(|s| s.to_string())
        .collect();

    let mut result = lines;

    for hunk in hunks {
        if hunk.remove.is_empty() {
            // Append-only hunk
            result.extend(hunk.add.iter().cloned());
            continue;
        }
        let idx = find_subsequence(&result, &hunk.remove);
        match idx {
            Some(pos) => {
                result.splice(pos..pos + hunk.remove.len(), hunk.add.iter().cloned());
            }
            None => {
                return Err("PATCH_CONTEXT_NOT_FOUND".to_string());
            }
        }
    }

    let body = result.join("\n");
    let final_content = if target_content.is_empty() || target_content.ends_with('\n') {
        format!("{}\n", body)
    } else {
        body
    };

    Ok(final_content)
}

/// Apply patch main NAPI function.
/// Input: { toolCall: {id, name, arguments}, workspace, fileContent? }
/// Output: { ok, payload, patchedContent?, canonicalArgs }
#[napi]
pub fn run_apply_patch_json(input_json: String) -> NapiResult<String> {
    #[derive(Debug, Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct ApplyPatchInput {
        tool_call_id: String,
        tool_call_arguments: String,
        workspace: String,
        /// Optional file content — if absent, only parse/normalize is performed
        file_content: Option<String>,
    }

    #[derive(Debug, Serialize)]
    #[serde(rename_all = "camelCase")]
    struct ApplyPatchOutput {
        ok: bool,
        payload: serde_json::Value,
        /// Patched content (only set when fileContent was provided and patch applied)
        patched_content: Option<String>,
        canonical_args: serde_json::Value,
    }

    let input: ApplyPatchInput = serde_json::from_str(&input_json)
        .map_err(|e| napi::Error::from_reason(format!("deserialize: {e}")))?;

    // 1. Parse arguments (with recovery for malformed JSON)
    let args = parse_apply_patch_arguments(&input.tool_call_arguments);

    // 2. Read patch text
    let raw_patch = read_patch_text_from_args(&args);

    let mut canonical_args = serde_json::json!({
        "filePath": "",
        "patch": raw_patch
    });

    // 3. Resolve file path
    let file_path = args
        .get("filePath")
        .and_then(|v| v.as_str())
        .map(|s| strip_outer_quotes(s))
        .filter(|s| !s.is_empty())
        .unwrap_or_default();

    let normalized_path = if file_path.starts_with('/') || file_path.starts_with("\\\\") {
        // Absolute path — normalize to relative if inside workspace
        let workspace = input.workspace.replace('\\', "/");
        let ws_trimmed = workspace.trim_end_matches('/');
        if let Some(rel) = file_path.strip_prefix(ws_trimmed) {
            rel.trim_start_matches('/').to_string()
        } else {
            file_path.clone()
        }
    } else {
        file_path.clone()
    };

    canonical_args["filePath"] = serde_json::json!(normalized_path);

    // 4. Convert native patch to line-edit format
    let line_edit_patch = convert_native_patch_to_line_edit(&raw_patch, &normalized_path);
    canonical_args["patch"] = serde_json::json!(line_edit_patch);

    // 5. If no patch text — return error
    if line_edit_patch.trim().is_empty() {
        let payload = serde_json::json!({
            "status": "APPLY_PATCH_FAILED",
            "ok": false,
            "filePath": normalized_path,
            "reason": "PATCH_EMPTY",
            "message": if normalized_path.is_empty() {
                "filePath and patch are required."
            } else {
                "patch is empty."
            },
            "nextAction": "Retry with valid patch entries."
        });
        let output = ApplyPatchOutput {
            ok: false,
            payload,
            patched_content: None,
            canonical_args,
        };
        return serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()));
    }

    // 6. If file content is provided, parse and apply patch
    if let Some(content) = &input.file_content {
        let parsed = match parse_line_edit_patch(&line_edit_patch) {
            Ok(p) => p,
            Err(reason) => {
                let (reason_code, message) = if reason.starts_with("PATCH_INVALID") {
                    ("PATCH_INVALID", reason)
                } else {
                    ("PATCH_EMPTY", "patch has no edit entries.".to_string())
                };
                let payload = serde_json::json!({
                    "status": "APPLY_PATCH_FAILED",
                    "ok": false,
                    "filePath": normalized_path,
                    "reason": reason_code,
                    "message": message,
                    "nextAction": "Retry with only line-edit entries."
                });
                let output = ApplyPatchOutput {
                    ok: false,
                    payload,
                    patched_content: None,
                    canonical_args,
                };
                return serde_json::to_string(&output)
                    .map_err(|e| napi::Error::from_reason(e.to_string()));
            }
        };

        // Check for remove hunk against non-existent file
        let has_remove = parsed.hunks.iter().any(|h| !h.remove.is_empty());
        if has_remove && content.is_empty() {
            let payload = serde_json::json!({
                "status": "APPLY_PATCH_FAILED",
                "ok": false,
                "filePath": normalized_path,
                "reason": "FILE_NOT_FOUND",
                "message": "Target file does not exist for a removal/update patch.",
                "nextAction": "Retry with a create-only patch."
            });
            let output = ApplyPatchOutput {
                ok: false,
                payload,
                patched_content: None,
                canonical_args,
            };
            return serde_json::to_string(&output)
                .map_err(|e| napi::Error::from_reason(e.to_string()));
        }

        match apply_line_edit_patch(content, &parsed.hunks) {
            Ok(patched) => {
                let summary = format!(
                    "Replaced {} removed line(s) with {} added line(s).",
                    parsed.removed, parsed.added
                );
                let payload = serde_json::json!({
                    "status": "APPLY_PATCH_APPLIED",
                    "ok": true,
                    "filePath": normalized_path,
                    "summary": summary
                });
                let output = ApplyPatchOutput {
                    ok: true,
                    payload,
                    patched_content: Some(patched),
                    canonical_args,
                };
                serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
            }
            Err(reason) => {
                let message = match reason.as_str() {
                    "PATCH_CONTEXT_NOT_FOUND" => {
                        "Removed line sequence was not found in target file.".to_string()
                    }
                    _ => reason.clone(),
                };
                let payload = serde_json::json!({
                    "status": "APPLY_PATCH_FAILED",
                    "ok": false,
                    "filePath": normalized_path,
                    "reason": reason,
                    "message": message,
                    "nextAction": "Retry with patch entries that match the current target file."
                });
                let output = ApplyPatchOutput {
                    ok: false,
                    payload,
                    patched_content: None,
                    canonical_args,
                };
                serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
            }
        }
    } else {
        // No file content — just return normalized result (parse phase only)
        let payload = serde_json::json!({
            "status": "APPLY_PATCH_PLANNED",
            "ok": true,
            "filePath": normalized_path
        });
        let output = ApplyPatchOutput {
            ok: true,
            payload,
            patched_content: None,
            canonical_args,
        };
        serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
    }
}

// ── Followup Sanitize ───────────────────────────────────────────────────

#[napi]
pub fn sanitize_followup_text(raw: Option<String>) -> String {
    let text = match raw {
        Some(s) => s,
        None => return String::new(),
    };
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return String::new();
    }

    // Remove stopmessage markers <** ... **>
    let re_stop = regex::Regex::new(r"<\*\*[\s\S]*?\*\*>").unwrap();
    let cleaned = re_stop.replace_all(trimmed, " ");

    // Remove [Time/Date]: markers
    let re_time = regex::Regex::new(r"\[Time/Date\]:.*?(?=(?:\\n|\n|$))").unwrap();
    let cleaned = re_time.replace_all(&cleaned, " ");

    // Remove [Image omitted]
    let cleaned = cleaned.replace("[Image omitted]", " ");

    // Clean trailing whitespace before newlines
    let re_trail = regex::Regex::new(r"[ \t]+\n").unwrap();
    let cleaned = re_trail.replace_all(&cleaned, "\n");

    // Clean leading whitespace after newlines
    let re_lead = regex::Regex::new(r"\n[ \t]+").unwrap();
    let cleaned = re_lead.replace_all(&cleaned, "\n");

    // Collapse 3+ newlines into 2
    let re_blanks = regex::Regex::new(r"\n{3,}").unwrap();
    let result = re_blanks.replace_all(&cleaned, "\n\n");

    result.trim().to_string()
}

// ── Vision Pure Blocks ──────────────────────────────────────────────────

/// Build the complete vision analysis payload from a captured request.
/// Returns null if no images found.
#[napi]
pub fn vision_build_analysis_payload_json(source_json: String) -> String {
    use serde_json::Value;

    let source: Value = match serde_json::from_str(&source_json) {
        Ok(v) => v,
        Err(_) => return "null".to_string(),
    };

    let messages = source
        .get("messages")
        .and_then(|v| v.as_array())
        .map(|v| v.clone())
        .unwrap_or_default();

    if messages.is_empty() {
        return "null".to_string();
    }

    // Find latest user message with images
    let mut vision_messages: Vec<Value> = Vec::new();

    // System message
    let system_prompt = "你现在的任务只是描述图片内容，不要回答用户问题，不要提供建议，不要推理求解，不要做工具规划。用户提示词只用于帮助你理解关注重点；你只能描述图片中可见的信息。若有文字、数字、时间、版本号、路径、报错、界面结构，请尽量详细描述。看不清的内容明确说明无法辨认。若有多张图片，请按输入顺序分别输出，格式使用 [Image 1]、[Image 2]。";
    vision_messages.push(serde_json::json!({
        "role": "system",
        "content": system_prompt
    }));

    // Latest user message with images
    let mut found = false;
    for msg in messages.iter().rev() {
        let role = msg.get("role").and_then(|v| v.as_str()).unwrap_or("");
        if role.to_lowercase() != "user" {
            continue;
        }
        let content = msg.get("content");
        let image_parts = match content {
            Some(Value::Array(arr)) => {
                let parts: Vec<&Value> = arr
                    .iter()
                    .filter(|p| {
                        p.get("type")
                            .and_then(|t| t.as_str())
                            .map(|t| t.to_lowercase().contains("image"))
                            .unwrap_or(false)
                    })
                    .collect();
                if parts.is_empty() {
                    continue;
                }
                // Extract user text prompt
                let user_text: String = arr
                    .iter()
                    .filter_map(|p| {
                        if p.get("type")
                            .and_then(|t| t.as_str())
                            .map(|t| t.to_lowercase().contains("image"))
                            .unwrap_or(false)
                        {
                            return None;
                        }
                        p.get("text")
                            .or_else(|| p.get("input_text"))
                            .or_else(|| p.get("output_text"))
                            .or_else(|| p.get("content"))
                            .and_then(|v| v.as_str())
                            .map(|s| s.trim().to_string())
                            .filter(|s| !s.is_empty())
                    })
                    .collect::<Vec<_>>()
                    .join(" ");

                let prompt_hint = format!(
                    "用户原始提示词如下，它只用于帮助你理解关注重点：\n{}\n\n请根据这个提示词理解用户想关注什么，但不要回答该问题，不要做任何处理，只描述图片中可见内容。\n若有多张图片，请按顺序分别输出，格式为 [Image 1]、[Image 2]。",
                    if user_text.is_empty() { "（无文本提示词）" } else { &user_text }
                );

                let mut all_parts: Vec<Value> = Vec::new();
                all_parts.push(serde_json::json!({
                    "type": "input_text",
                    "text": prompt_hint
                }));
                for part in parts {
                    all_parts.push(part.clone());
                }
                all_parts
            }
            _ => continue,
        };

        vision_messages.push(serde_json::json!({
            "role": "user",
            "content": image_parts
        }));
        found = true;
        break;
    }

    if !found {
        return "null".to_string();
    }

    let mut payload = serde_json::json!({
        "messages": vision_messages
    });

    if let Some(model) = source.get("model").and_then(|v| v.as_str()) {
        payload["model"] = serde_json::json!(model);
    }

    // Merge parameters
    if let Some(params) = source.get("parameters").and_then(|v| v.as_object()) {
        if let Some(obj) = payload.as_object_mut() {
            for (k, v) in params {
                if k != "messages" && k != "model" {
                    obj.insert(k.clone(), v.clone());
                }
            }
        }
    }

    serde_json::to_string(&payload).unwrap_or_else(|_| "null".to_string())
}

/// Build pinned vision backend metadata from adapter context and payload.
#[napi]
pub fn vision_build_pinned_metadata_json(
    adapter_context_json: String,
    payload_json: String,
) -> String {
    let ctx: serde_json::Value = match serde_json::from_str(&adapter_context_json) {
        Ok(v) => v,
        Err(_) => return "null".to_string(),
    };
    let payload: serde_json::Value = match serde_json::from_str(&payload_json) {
        Ok(v) => v,
        Err(_) => return "null".to_string(),
    };

    let target = ctx.get("target").and_then(|v| v.as_object());

    let provider_key = target
        .and_then(|t| t.get("providerKey").and_then(|v| v.as_str()))
        .or_else(|| ctx.get("targetProviderKey").and_then(|v| v.as_str()))
        .or_else(|| ctx.get("providerKey").and_then(|v| v.as_str()))
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());

    let model_id = target
        .and_then(|t| t.get("modelId").and_then(|v| v.as_str()))
        .or_else(|| ctx.get("assignedModelId").and_then(|v| v.as_str()))
        .or_else(|| ctx.get("modelId").and_then(|v| v.as_str()))
        .or_else(|| ctx.get("originalModelId").and_then(|v| v.as_str()))
        .or_else(|| payload.get("model").and_then(|v| v.as_str()))
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());

    let routecodex_port_mode = ctx
        .get("routecodexPortMode")
        .and_then(|v| v.as_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());

    if provider_key.is_none() && model_id.is_none() && routecodex_port_mode.is_none() {
        return "null".to_string();
    }

    let mut metadata = serde_json::Map::new();
    if let Some(ref pk) = provider_key {
        metadata.insert(
            "__shadowCompareForcedProviderKey".to_string(),
            Value::String(pk.clone()),
        );
        metadata.insert("providerKey".to_string(), Value::String(pk.clone()));
        metadata.insert("targetProviderKey".to_string(), Value::String(pk.clone()));
    }
    if let Some(ref mid) = model_id {
        metadata.insert("assignedModelId".to_string(), Value::String(mid.clone()));
        metadata.insert("modelId".to_string(), Value::String(mid.clone()));
        let mut target_obj = serde_json::Map::new();
        if let Some(ref pk) = provider_key {
            target_obj.insert("providerKey".to_string(), Value::String(pk.clone()));
        }
        target_obj.insert("modelId".to_string(), Value::String(mid.clone()));
        metadata.insert("target".to_string(), Value::Object(target_obj));
    }
    if let Some(ref rpm) = routecodex_port_mode {
        metadata.insert("routecodexPortMode".to_string(), Value::String(rpm.clone()));
    }

    serde_json::to_string(&Value::Object(metadata)).unwrap_or_else(|_| "null".to_string())
}

/// Extract original user prompt from messages array.
#[napi]
pub fn vision_extract_original_user_prompt_json(messages_json: String) -> String {
    let messages: Vec<serde_json::Value> = match serde_json::from_str(&messages_json) {
        Ok(v) => v,
        Err(_) => return String::new(),
    };

    for msg in messages.iter().rev() {
        let role = msg.get("role").and_then(|v| v.as_str()).unwrap_or("");
        if role.to_lowercase() != "user" {
            continue;
        }
        let content = msg.get("content");
        let text = extract_user_prompt(content);
        if !text.is_empty() {
            return text;
        }
    }
    String::new()
}

fn extract_user_prompt(content: Option<&Value>) -> String {
    match content {
        Some(Value::String(s)) => s.trim().to_string(),
        Some(Value::Array(arr)) => {
            let mut parts: Vec<String> = Vec::new();
            for part in arr {
                if part
                    .get("type")
                    .and_then(|t| t.as_str())
                    .map(|t| t.to_lowercase().contains("image"))
                    .unwrap_or(false)
                {
                    continue;
                }
                for key in &["text", "input_text", "output_text", "content"] {
                    if let Some(v) = part.get(*key).and_then(|v| v.as_str()) {
                        let trimmed = v.trim();
                        if !trimmed.is_empty() {
                            parts.push(trimmed.to_string());
                            break;
                        }
                    }
                }
            }
            parts.join("\n")
        }
        _ => String::new(),
    }
}
