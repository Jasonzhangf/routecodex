use crate::hub_req_inbound_tool_call_normalization::normalize_shell_like_tool_calls_before_governance;
use crate::hub_req_inbound_tool_output_diagnostics::inject_tool_parse_diagnostics;
use napi::bindgen_prelude::Result as NapiResult;
use napi_derive::napi;
use serde::Serialize;
use serde_json::{Map, Value};
use std::collections::HashSet;

#[derive(Debug, Clone, Serialize)]
pub(crate) struct ToolOutputItem {
    #[serde(rename = "tool_call_id")]
    tool_call_id: String,
    #[serde(rename = "call_id")]
    call_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    output: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    name: Option<String>,
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

fn normalize_tool_output_entry(entry: &Value) -> Option<ToolOutputItem> {
    let row = entry.as_object()?;
    let tool_call_id = read_trimmed_string(row.get("tool_call_id"));
    let call_id = read_trimmed_string(row.get("call_id"));
    let id = tool_call_id.clone().or(call_id.clone())?;

    let raw_output = row.get("output").or_else(|| row.get("content"));
    let output = match raw_output {
        Some(Value::String(v)) => Some(v.clone()),
        Some(other) => {
            Some(serde_json::to_string(other).unwrap_or_else(|_| "[object Object]".to_string()))
        }
        None => None,
    };

    let name = read_trimmed_string(row.get("name"));

    Some(ToolOutputItem {
        tool_call_id: tool_call_id.unwrap_or_else(|| id.clone()),
        call_id: call_id.unwrap_or(id),
        output,
        name,
    })
}

fn read_array(payload: &Value, field: &str) -> Vec<ToolOutputItem> {
    let rows = payload
        .as_object()
        .and_then(|obj| obj.get(field))
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();

    rows.iter()
        .filter_map(normalize_tool_output_entry)
        .collect::<Vec<ToolOutputItem>>()
}

fn read_required_action_outputs(payload: &Value) -> Vec<ToolOutputItem> {
    let submit = payload
        .as_object()
        .and_then(|obj| obj.get("required_action"))
        .and_then(|v| v.as_object())
        .and_then(|obj| obj.get("submit_tool_outputs"))
        .cloned()
        .unwrap_or(Value::Null);
    read_array(&submit, "tool_outputs")
}

fn read_message_tool_outputs(payload: &Value) -> Vec<ToolOutputItem> {
    let messages = payload
        .as_object()
        .and_then(|obj| obj.get("messages"))
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let mut out: Vec<ToolOutputItem> = Vec::new();

    for entry in messages {
        let row = match entry.as_object() {
            Some(v) => v,
            None => continue,
        };
        let role = read_trimmed_string(row.get("role"))
            .unwrap_or_default()
            .to_ascii_lowercase();
        if role != "tool" {
            continue;
        }
        let mut normalized_row = serde_json::Map::new();
        normalized_row.insert(
            "tool_call_id".to_string(),
            row.get("tool_call_id")
                .cloned()
                .or_else(|| row.get("call_id").cloned())
                .or_else(|| row.get("id").cloned())
                .unwrap_or(Value::Null),
        );
        normalized_row.insert(
            "call_id".to_string(),
            row.get("call_id")
                .cloned()
                .or_else(|| row.get("tool_call_id").cloned())
                .or_else(|| row.get("id").cloned())
                .unwrap_or(Value::Null),
        );
        if let Some(name) = row.get("name") {
            normalized_row.insert("name".to_string(), name.clone());
        }
        normalized_row.insert(
            "output".to_string(),
            row.get("content")
                .cloned()
                .or_else(|| row.get("output").cloned())
                .unwrap_or(Value::Null),
        );
        if let Some(normalized) = normalize_tool_output_entry(&Value::Object(normalized_row)) {
            out.push(normalized);
        }
    }

    out
}

fn read_message_content_tool_outputs(payload: &Value) -> Vec<ToolOutputItem> {
    let messages = payload
        .as_object()
        .and_then(|obj| obj.get("messages"))
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let mut out: Vec<ToolOutputItem> = Vec::new();

    for entry in messages {
        let row = match entry.as_object() {
            Some(v) => v,
            None => continue,
        };
        let content_list = match row.get("content").and_then(|v| v.as_array()) {
            Some(v) => v,
            None => continue,
        };
        for block in content_list {
            let block_row = match block.as_object() {
                Some(v) => v,
                None => continue,
            };
            let block_type = read_trimmed_string(block_row.get("type"))
                .unwrap_or_default()
                .to_ascii_lowercase();
            if block_type != "tool_result"
                && block_type != "function_call_output"
                && block_type != "tool_message"
            {
                continue;
            }
            let mut normalized_row = serde_json::Map::new();
            normalized_row.insert(
                "tool_call_id".to_string(),
                block_row
                    .get("tool_use_id")
                    .cloned()
                    .or_else(|| block_row.get("tool_call_id").cloned())
                    .or_else(|| block_row.get("call_id").cloned())
                    .or_else(|| block_row.get("id").cloned())
                    .unwrap_or(Value::Null),
            );
            normalized_row.insert(
                "call_id".to_string(),
                block_row
                    .get("tool_use_id")
                    .cloned()
                    .or_else(|| block_row.get("tool_call_id").cloned())
                    .or_else(|| block_row.get("call_id").cloned())
                    .or_else(|| block_row.get("id").cloned())
                    .unwrap_or(Value::Null),
            );
            if let Some(name) = block_row.get("name") {
                normalized_row.insert("name".to_string(), name.clone());
            }
            normalized_row.insert(
                "output".to_string(),
                block_row
                    .get("content")
                    .cloned()
                    .or_else(|| block_row.get("output").cloned())
                    .unwrap_or(Value::Null),
            );
            if let Some(normalized) = normalize_tool_output_entry(&Value::Object(normalized_row)) {
                out.push(normalized);
            }
        }
    }

    out
}

fn read_responses_input_tool_outputs(payload: &Value) -> Vec<ToolOutputItem> {
    let input = payload
        .as_object()
        .and_then(|obj| obj.get("input"))
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let mut out: Vec<ToolOutputItem> = Vec::new();

    for entry in input {
        let row = match entry.as_object() {
            Some(v) => v,
            None => continue,
        };
        let row_type = read_trimmed_string(row.get("type"))
            .unwrap_or_default()
            .to_ascii_lowercase();
        if row_type != "tool_result"
            && row_type != "tool_message"
            && row_type != "function_call_output"
        {
            continue;
        }
        let mut normalized_row = serde_json::Map::new();
        normalized_row.insert(
            "tool_call_id".to_string(),
            row.get("tool_call_id")
                .cloned()
                .or_else(|| row.get("call_id").cloned())
                .or_else(|| row.get("tool_use_id").cloned())
                .unwrap_or(Value::Null),
        );
        normalized_row.insert(
            "call_id".to_string(),
            row.get("call_id")
                .cloned()
                .or_else(|| row.get("tool_call_id").cloned())
                .or_else(|| row.get("tool_use_id").cloned())
                .unwrap_or(Value::Null),
        );
        if let Some(name) = row.get("name") {
            normalized_row.insert("name".to_string(), name.clone());
        }
        if let Some(output) = row.get("output") {
            normalized_row.insert("output".to_string(), output.clone());
        }

        if let Some(normalized) = normalize_tool_output_entry(&Value::Object(normalized_row)) {
            out.push(normalized);
        }
    }

    out
}

pub(crate) fn collect_tool_outputs(payload: &Value) -> Vec<ToolOutputItem> {
    let mut aggregated: Vec<ToolOutputItem> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();

    let mut append = |entry: ToolOutputItem| {
        let id = entry.tool_call_id.clone();
        if seen.contains(id.as_str()) {
            return;
        }
        seen.insert(id);
        aggregated.push(entry);
    };

    for entry in read_array(payload, "tool_outputs") {
        append(entry);
    }
    for entry in read_required_action_outputs(payload) {
        append(entry);
    }
    for entry in read_message_tool_outputs(payload) {
        append(entry);
    }
    for entry in read_message_content_tool_outputs(payload) {
        append(entry);
    }
    for entry in read_responses_input_tool_outputs(payload) {
        append(entry);
    }

    aggregated
}

fn read_provider_protocol(provider_protocol: &Value) -> String {
    let normalized = provider_protocol.as_str().unwrap_or("").trim().to_string();
    if normalized.is_empty() {
        return "unknown".to_string();
    }
    normalized
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ToolOutputSnapshotBuildResult {
    snapshot: Map<String, Value>,
    payload: Value,
}

fn build_req_inbound_tool_output_snapshot(
    payload: &mut Value,
    provider_protocol: &Value,
) -> ToolOutputSnapshotBuildResult {
    normalize_shell_like_tool_calls_before_governance(payload);
    inject_tool_parse_diagnostics(payload);

    let mut snapshot = Map::new();
    snapshot.insert(
        "providerProtocol".to_string(),
        Value::String(read_provider_protocol(provider_protocol)),
    );

    let tool_outputs = collect_tool_outputs(payload);
    if !tool_outputs.is_empty() {
        let serialized =
            serde_json::to_value(tool_outputs).unwrap_or_else(|_| Value::Array(Vec::new()));
        snapshot.insert("tool_outputs".to_string(), serialized);
    }

    ToolOutputSnapshotBuildResult {
        snapshot,
        payload: payload.clone(),
    }
}

#[napi]
pub fn collect_tool_outputs_json(payload_json: String) -> NapiResult<String> {
    let payload: Value =
        serde_json::from_str(&payload_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let output = collect_tool_outputs(&payload);
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi]
pub fn build_req_inbound_tool_output_snapshot_json(
    payload_json: String,
    provider_protocol_json: String,
) -> NapiResult<String> {
    let mut payload: Value =
        serde_json::from_str(&payload_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let provider_protocol: Value = serde_json::from_str(&provider_protocol_json)
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let output = build_req_inbound_tool_output_snapshot(&mut payload, &provider_protocol);
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}
