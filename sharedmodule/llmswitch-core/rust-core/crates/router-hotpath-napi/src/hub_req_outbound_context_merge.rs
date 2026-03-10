use napi::bindgen_prelude::Result as NapiResult;
use napi_derive::napi;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::HashSet;

#[derive(Debug, Clone, Serialize)]
struct MergedToolOutput {
    #[serde(rename = "tool_call_id")]
    tool_call_id: String,
    content: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    name: Option<String>,
}

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct ReqOutboundContextMergePlanInput {
    snapshot: Option<Value>,
    existing_tool_outputs: Option<Value>,
    #[serde(default)]
    has_existing_tools: bool,
}

#[derive(Debug, Serialize, Default)]
#[serde(rename_all = "camelCase")]
struct ReqOutboundContextMergePlanOutput {
    #[serde(skip_serializing_if = "Option::is_none")]
    merged_tool_outputs: Option<Vec<MergedToolOutput>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    normalized_tools: Option<Vec<Value>>,
}

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct ReqOutboundContextSnapshotApplyInput {
    chat_envelope: Option<Value>,
    snapshot: Option<Value>,
}

#[derive(Debug, Serialize, Default)]
#[serde(rename_all = "camelCase")]
struct ReqOutboundContextSnapshotApplyOutput {
    #[serde(skip_serializing_if = "Option::is_none")]
    tool_outputs: Option<Vec<MergedToolOutput>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tools: Option<Vec<Value>>,
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

fn normalize_tool_output(entry: &Value) -> Option<MergedToolOutput> {
    let row = entry.as_object()?;
    let tool_call_id = read_trimmed_string(row.get("tool_call_id"))
        .or_else(|| read_trimmed_string(row.get("call_id")))?;

    let raw_output = row.get("output").or_else(|| row.get("content"));
    let content = match raw_output {
        Some(Value::String(v)) => v.clone(),
        Some(other) => {
            serde_json::to_string(other).unwrap_or_else(|_| "[object Object]".to_string())
        }
        None => String::new(),
    };

    let name = read_trimmed_string(row.get("name"));

    Some(MergedToolOutput {
        tool_call_id,
        content,
        name,
    })
}

fn merge_context_tool_outputs(existing: &Value, snapshot: &Value) -> Option<Vec<MergedToolOutput>> {
    let outputs_raw = snapshot
        .as_object()
        .and_then(|obj| obj.get("tool_outputs"))
        .and_then(|v| v.as_array())?;
    if outputs_raw.is_empty() {
        return None;
    }

    let normalized: Vec<MergedToolOutput> = outputs_raw
        .iter()
        .filter_map(normalize_tool_output)
        .collect();
    if normalized.is_empty() {
        return None;
    }

    let mut merged: Vec<MergedToolOutput> = existing
        .as_array()
        .cloned()
        .unwrap_or_default()
        .iter()
        .filter_map(normalize_tool_output)
        .collect();

    let mut known: HashSet<String> = merged
        .iter()
        .map(|entry| entry.tool_call_id.clone())
        .collect();

    for entry in normalized {
        if known.contains(entry.tool_call_id.as_str()) {
            continue;
        }
        known.insert(entry.tool_call_id.clone());
        merged.push(entry);
    }

    if merged.is_empty() {
        return None;
    }
    Some(merged)
}

fn normalize_tool_definition(entry: &Value) -> Option<Value> {
    let row = entry.as_object()?;
    if row.get("type").and_then(|v| v.as_str()) != Some("function") {
        return None;
    }
    let fn_row = row.get("function")?.as_object()?;
    let name = read_trimmed_string(fn_row.get("name"))?;

    let description = read_trimmed_string(fn_row.get("description"));
    let parameters = fn_row.get("parameters").cloned().unwrap_or(Value::Object({
        let mut obj = Map::new();
        obj.insert("type".to_string(), Value::String("object".to_string()));
        obj.insert("properties".to_string(), Value::Object(Map::new()));
        obj
    }));
    let strict = fn_row.get("strict").and_then(|v| v.as_bool());

    let mut fn_out = Map::new();
    fn_out.insert("name".to_string(), Value::String(name));
    if let Some(desc) = description {
        fn_out.insert("description".to_string(), Value::String(desc));
    }
    fn_out.insert("parameters".to_string(), parameters);
    if let Some(strict_flag) = strict {
        fn_out.insert("strict".to_string(), Value::Bool(strict_flag));
    }

    let mut out = Map::new();
    out.insert("type".to_string(), Value::String("function".to_string()));
    out.insert("function".to_string(), Value::Object(fn_out));
    Some(Value::Object(out))
}

fn normalize_context_tools(snapshot: &Value) -> Option<Vec<Value>> {
    let row = snapshot.as_object()?;
    let source = row
        .get("toolsNormalized")
        .or_else(|| row.get("tools"))
        .and_then(|v| v.as_array())?;

    let tools: Vec<Value> = source
        .iter()
        .filter_map(normalize_tool_definition)
        .collect();
    if tools.is_empty() {
        return None;
    }
    Some(tools)
}

fn select_tool_call_id_style(
    adapter_context: &Value,
    snapshot: &Value,
    current: Option<String>,
) -> Option<String> {
    let adapter_style = adapter_context
        .as_object()
        .and_then(|obj| obj.get("toolCallIdStyle"))
        .and_then(|v| v.as_str())
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty());

    let snapshot_style = snapshot
        .as_object()
        .and_then(|obj| obj.get("toolCallIdStyle"))
        .and_then(|v| v.as_str())
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty());

    let resolved = adapter_style.or(snapshot_style)?;
    if current
        .as_ref()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
        == Some(resolved.clone())
    {
        return Some(resolved);
    }
    Some(resolved)
}

fn strip_private_fields_in_place(value: &mut Value) {
    match value {
        Value::Array(list) => {
            for entry in list.iter_mut() {
                strip_private_fields_in_place(entry);
            }
        }
        Value::Object(row) => {
            let keys: Vec<String> = row.keys().cloned().collect();
            for key in keys {
                if key.starts_with("__rcc_") {
                    row.remove(key.as_str());
                    continue;
                }
                if let Some(child) = row.get_mut(key.as_str()) {
                    strip_private_fields_in_place(child);
                }
            }
        }
        _ => {}
    }
}

fn strip_private_fields(value: &Value) -> Value {
    let mut next = value.clone();
    strip_private_fields_in_place(&mut next);
    next
}

fn resolve_compat_profile(
    adapter_context: &Value,
    explicit_profile: Option<String>,
) -> Option<String> {
    if let Some(explicit) = explicit_profile {
        let trimmed = explicit.trim().to_string();
        if !trimmed.is_empty() {
            return Some(trimmed);
        }
    }

    adapter_context
        .as_object()
        .and_then(|obj| obj.get("compatibilityProfile"))
        .and_then(|v| v.as_str())
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
}

fn should_attach_req_outbound_context_snapshot(
    has_snapshot: bool,
    context_metadata_key: Option<String>,
) -> bool {
    if !has_snapshot {
        return false;
    }
    let key = context_metadata_key.unwrap_or_default().trim().to_string();
    !key.is_empty()
}

fn resolve_req_outbound_context_merge_plan(
    input: &ReqOutboundContextMergePlanInput,
) -> ReqOutboundContextMergePlanOutput {
    let snapshot = input.snapshot.as_ref().unwrap_or(&Value::Null);
    let existing_tool_outputs = input.existing_tool_outputs.as_ref().unwrap_or(&Value::Null);

    let merged_tool_outputs = merge_context_tool_outputs(existing_tool_outputs, snapshot);
    let normalized_tools = if input.has_existing_tools {
        None
    } else {
        normalize_context_tools(snapshot)
    };

    ReqOutboundContextMergePlanOutput {
        merged_tool_outputs,
        normalized_tools,
    }
}

fn resolve_existing_tool_outputs_from_chat_envelope(chat_envelope: &Value) -> Value {
    let row = match chat_envelope.as_object() {
        Some(v) => v,
        None => return Value::Array(Vec::new()),
    };
    let existing = row
        .get("toolOutputs")
        .or_else(|| row.get("tool_outputs"))
        .cloned()
        .unwrap_or(Value::Array(Vec::new()));
    if existing.is_array() {
        return existing;
    }
    Value::Array(Vec::new())
}

fn resolve_has_existing_tools_from_chat_envelope(chat_envelope: &Value) -> bool {
    chat_envelope
        .as_object()
        .and_then(|row| row.get("tools"))
        .and_then(|v| v.as_array())
        .map(|tools| !tools.is_empty())
        .unwrap_or(false)
}

fn apply_req_outbound_context_snapshot(
    input: &ReqOutboundContextSnapshotApplyInput,
) -> ReqOutboundContextSnapshotApplyOutput {
    let chat_envelope = input.chat_envelope.as_ref().unwrap_or(&Value::Null);
    let snapshot = input.snapshot.as_ref().unwrap_or(&Value::Null);
    let existing_tool_outputs = resolve_existing_tool_outputs_from_chat_envelope(chat_envelope);
    let has_existing_tools = resolve_has_existing_tools_from_chat_envelope(chat_envelope);

    let tool_outputs = merge_context_tool_outputs(&existing_tool_outputs, snapshot);
    let tools = if has_existing_tools {
        None
    } else {
        normalize_context_tools(snapshot)
    };

    ReqOutboundContextSnapshotApplyOutput {
        tool_outputs,
        tools,
    }
}

#[napi]
pub fn merge_context_tool_outputs_json(
    existing_json: String,
    snapshot_json: String,
) -> NapiResult<String> {
    let existing: Value = serde_json::from_str(&existing_json)
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let snapshot: Value = serde_json::from_str(&snapshot_json)
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let output = merge_context_tool_outputs(&existing, &snapshot);
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi]
pub fn normalize_context_tools_json(snapshot_json: String) -> NapiResult<String> {
    let snapshot: Value = serde_json::from_str(&snapshot_json)
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let output = normalize_context_tools(&snapshot);
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi]
pub fn select_tool_call_id_style_json(
    adapter_context_json: String,
    snapshot_json: String,
    current_style_json: String,
) -> NapiResult<String> {
    let adapter_context: Value = serde_json::from_str(&adapter_context_json)
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let snapshot: Value = serde_json::from_str(&snapshot_json)
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let current_style: Option<String> = serde_json::from_str(&current_style_json)
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;

    let output = select_tool_call_id_style(&adapter_context, &snapshot, current_style);
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi]
pub fn strip_private_fields_json(payload_json: String) -> NapiResult<String> {
    let payload: Value =
        serde_json::from_str(&payload_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let output = strip_private_fields(&payload);
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi]
pub fn resolve_compat_profile_json(
    adapter_context_json: String,
    explicit_profile_json: String,
) -> NapiResult<String> {
    let adapter_context: Value = serde_json::from_str(&adapter_context_json)
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let explicit_profile: Option<String> = serde_json::from_str(&explicit_profile_json)
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;

    let output = resolve_compat_profile(&adapter_context, explicit_profile);
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi]
pub fn resolve_req_outbound_context_merge_plan_json(input_json: String) -> NapiResult<String> {
    let input: ReqOutboundContextMergePlanInput =
        serde_json::from_str(&input_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let output = resolve_req_outbound_context_merge_plan(&input);
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi]
pub fn apply_req_outbound_context_snapshot_json(input_json: String) -> NapiResult<String> {
    let input: ReqOutboundContextSnapshotApplyInput =
        serde_json::from_str(&input_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let output = apply_req_outbound_context_snapshot(&input);
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi]
pub fn should_attach_req_outbound_context_snapshot_json(
    has_snapshot: bool,
    context_metadata_key_json: String,
) -> NapiResult<String> {
    let context_metadata_key: Option<String> = serde_json::from_str(&context_metadata_key_json)
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let output = should_attach_req_outbound_context_snapshot(has_snapshot, context_metadata_key);
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}
