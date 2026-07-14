use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::HashSet;

use crate::shared_json_utils::read_trimmed_string;

#[derive(Debug, Clone, Serialize)]
pub struct MergedToolOutput {
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
pub struct ReqOutboundContextSnapshotApplyInput {
    pub chat_envelope: Option<Value>,
    pub snapshot: Option<Value>,
}

#[derive(Debug, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ReqOutboundContextSnapshotApplyOutput {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_outputs: Option<Vec<MergedToolOutput>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tools: Option<Vec<Value>>,
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

#[cfg(test)]
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

pub fn apply_req_outbound_context_snapshot(
    input: &ReqOutboundContextSnapshotApplyInput,
) -> ReqOutboundContextSnapshotApplyOutput {
    let chat_envelope = input.chat_envelope.as_ref().unwrap_or(&Value::Null);
    let snapshot = input.snapshot.as_ref().unwrap_or(&Value::Null);
    apply_req_outbound_context_snapshot_from_refs(chat_envelope, snapshot)
}

pub fn apply_req_outbound_context_snapshot_from_refs(
    chat_envelope: &Value,
    snapshot: &Value,
) -> ReqOutboundContextSnapshotApplyOutput {
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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn borrowed_context_snapshot_apply_matches_owned_wrapper() {
        let chat_envelope = json!({
            "toolOutputs": [{"tool_call_id": "call_existing", "content": "old"}],
            "tools": []
        });
        let snapshot = json!({
            "tool_outputs": [
                {"tool_call_id": "call_existing", "output": "duplicate"},
                {"tool_call_id": "call_new", "output": {"ok": true}}
            ],
            "toolsNormalized": [{
                "type": "function",
                "function": {
                    "name": "lookup",
                    "parameters": {"type": "object", "properties": {}}
                }
            }]
        });
        let owned = apply_req_outbound_context_snapshot(&ReqOutboundContextSnapshotApplyInput {
            chat_envelope: Some(chat_envelope.clone()),
            snapshot: Some(snapshot.clone()),
        });
        let borrowed = apply_req_outbound_context_snapshot_from_refs(&chat_envelope, &snapshot);

        assert_eq!(
            serde_json::to_value(borrowed).unwrap(),
            serde_json::to_value(owned).unwrap()
        );
    }
}
