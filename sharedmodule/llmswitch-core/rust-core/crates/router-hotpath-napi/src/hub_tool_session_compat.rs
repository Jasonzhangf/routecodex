use napi::bindgen_prelude::Result as NapiResult;
use napi_derive::napi;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::{HashMap, HashSet};

const TOOL_UNKNOWN_PREFIX: &str = "[RouteCodex] Tool call result unknown";

#[derive(Debug, Clone)]
struct ToolOutputLookupEntry {
    content: Option<String>,
    name: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolSessionCompatInput {
    #[serde(default)]
    pub messages: Vec<Value>,
    #[serde(default)]
    pub tool_outputs: Option<Vec<Value>>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolSessionCompatOutput {
    pub messages: Vec<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_outputs: Option<Vec<Value>>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolHistoryMessageRecord {
    pub role: String,
    #[serde(alias = "tool_use")]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_use: Option<ToolHistoryToolUse>,
    #[serde(alias = "tool_result")]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_result: Option<ToolHistoryToolResult>,
    pub ts: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolHistoryToolUse {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolHistoryToolResult {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    pub status: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolSessionPendingUse {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    pub ts: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolSessionHistory {
    #[serde(default)]
    pub last_messages: Vec<ToolHistoryMessageRecord>,
    #[serde(default)]
    pub pending_tool_uses: HashMap<String, ToolSessionPendingUse>,
    pub updated_at: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolSessionHistoryUpdateInput {
    #[serde(default)]
    pub messages: Vec<Value>,
    #[serde(default)]
    pub existing_history: Option<ToolSessionHistory>,
    #[serde(default)]
    pub max_messages: Option<usize>,
    #[serde(default)]
    pub now_iso: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolSessionHistoryUpdateOutput {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub history: Option<ToolSessionHistory>,
    pub records_count: usize,
}

fn read_trimmed_string(value: Option<&Value>) -> Option<String> {
    let raw = value.and_then(|entry| entry.as_str())?;
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    Some(trimmed.to_string())
}

fn read_tool_call_id(call: &Map<String, Value>) -> Option<String> {
    read_trimmed_string(call.get("id"))
        .or_else(|| read_trimmed_string(call.get("tool_call_id")))
        .or_else(|| read_trimmed_string(call.get("call_id")))
}

fn read_tool_message_id(message: &Map<String, Value>) -> Option<String> {
    read_trimmed_string(message.get("tool_call_id"))
        .or_else(|| read_trimmed_string(message.get("call_id")))
        .or_else(|| read_trimmed_string(message.get("id")))
}

fn read_tool_output_id(message: &Map<String, Value>) -> Option<String> {
    read_trimmed_string(message.get("tool_call_id"))
        .or_else(|| read_trimmed_string(message.get("call_id")))
        .or_else(|| read_trimmed_string(message.get("id")))
}

fn read_tool_output_content(message: &Map<String, Value>) -> Option<String> {
    let raw = message.get("output").or_else(|| message.get("content"))?;
    match raw {
        Value::String(text) => Some(text.clone()),
        other => serde_json::to_string(other).ok(),
    }
}

fn build_tool_output_lookup(
    tool_outputs: Option<&Vec<Value>>,
) -> HashMap<String, ToolOutputLookupEntry> {
    let mut lookup: HashMap<String, ToolOutputLookupEntry> = HashMap::new();
    let Some(entries) = tool_outputs else {
        return lookup;
    };
    for entry in entries {
        let Some(row) = entry.as_object() else {
            continue;
        };
        let tool_call_id = read_trimmed_string(row.get("tool_call_id"));
        let call_id = read_trimmed_string(row.get("call_id"));
        let id = tool_call_id
            .clone()
            .or(call_id.clone())
            .or_else(|| read_trimmed_string(row.get("id")));
        let Some(normalized_id) = id else {
            continue;
        };
        let record = ToolOutputLookupEntry {
            content: read_tool_output_content(row),
            name: read_trimmed_string(row.get("name")),
        };
        lookup.insert(normalized_id.clone(), record.clone());
        if let Some(alias) = tool_call_id {
            lookup.insert(alias, record.clone());
        }
        if let Some(alias) = call_id {
            lookup.insert(alias, record);
        }
    }
    lookup
}

fn find_tool_message_index(messages: &[Value], start_index: usize, call_id: &str) -> Option<usize> {
    for idx in start_index..messages.len() {
        let Some(message_obj) = messages.get(idx).and_then(|entry| entry.as_object()) else {
            continue;
        };
        let role = message_obj
            .get("role")
            .and_then(|entry| entry.as_str())
            .unwrap_or("")
            .trim()
            .to_ascii_lowercase();
        if role != "tool" {
            continue;
        }
        if read_tool_message_id(message_obj).as_deref() == Some(call_id) {
            return Some(idx);
        }
    }
    None
}

fn create_unknown_tool_message(
    call_id: &str,
    call: &Map<String, Value>,
    tool_output_lookup: &HashMap<String, ToolOutputLookupEntry>,
) -> Value {
    let call_name = call
        .get("function")
        .and_then(|entry| entry.as_object())
        .and_then(|entry| read_trimmed_string(entry.get("name")));
    let lookup_entry = tool_output_lookup.get(call_id);
    let name = lookup_entry
        .and_then(|entry| entry.name.clone())
        .or(call_name);
    let content = lookup_entry
        .and_then(|entry| entry.content.clone())
        .unwrap_or_else(|| {
            let description = name
                .as_ref()
                .map(|value| format!("tool \"{}\"", value))
                .unwrap_or_else(|| "tool call".to_string());
            format!(
                "{}: {} ({}) did not produce a result in this session. Treat this tool as failed with unknown status.",
                TOOL_UNKNOWN_PREFIX, description, call_id
            )
        });
    let mut row = Map::new();
    row.insert("role".to_string(), Value::String("tool".to_string()));
    row.insert(
        "tool_call_id".to_string(),
        Value::String(call_id.to_string()),
    );
    row.insert("content".to_string(), Value::String(content));
    if let Some(name_value) = name {
        row.insert("name".to_string(), Value::String(name_value));
    }
    Value::Object(row)
}

fn enrich_existing_tool_message(
    message_obj: &mut Map<String, Value>,
    call_id: &str,
    call: &Map<String, Value>,
    tool_output_lookup: &HashMap<String, ToolOutputLookupEntry>,
) {
    let lookup_entry = tool_output_lookup.get(call_id);
    let call_name = call
        .get("function")
        .and_then(|entry| entry.as_object())
        .and_then(|entry| read_trimmed_string(entry.get("name")));
    let should_fill_name = read_trimmed_string(message_obj.get("name")).is_none();
    if should_fill_name {
        if let Some(name) = lookup_entry
            .and_then(|entry| entry.name.clone())
            .or(call_name)
        {
            message_obj.insert("name".to_string(), Value::String(name));
        }
    }

    let existing_content = read_trimmed_string(message_obj.get("content"));
    let is_unknown_placeholder = existing_content
        .as_ref()
        .map(|text| text.starts_with(TOOL_UNKNOWN_PREFIX))
        .unwrap_or(false);
    let should_fill_content = existing_content.is_none() || is_unknown_placeholder;
    if should_fill_content {
        if let Some(content) = lookup_entry.and_then(|entry| entry.content.clone()) {
            message_obj.insert("content".to_string(), Value::String(content));
        }
    }
}

fn normalize_tool_call_ordering(
    messages: &mut Vec<Value>,
    tool_output_lookup: &HashMap<String, ToolOutputLookupEntry>,
) {
    let mut index: usize = 0;
    while index < messages.len() {
        let tool_calls = {
            let Some(message_obj) = messages.get(index).and_then(|entry| entry.as_object()) else {
                index += 1;
                continue;
            };
            let role = message_obj
                .get("role")
                .and_then(|entry| entry.as_str())
                .unwrap_or("")
                .trim()
                .to_ascii_lowercase();
            if role != "assistant" {
                index += 1;
                continue;
            }
            let Some(calls) = message_obj
                .get("tool_calls")
                .and_then(|entry| entry.as_array())
            else {
                index += 1;
                continue;
            };
            if calls.is_empty() {
                index += 1;
                continue;
            }
            calls.clone()
        };

        let mut insertion_index = index + 1;
        for call in tool_calls {
            let Some(call_obj) = call.as_object() else {
                continue;
            };
            let Some(call_id) = read_tool_call_id(call_obj) else {
                continue;
            };
            if let Some(existing_index) =
                find_tool_message_index(messages, insertion_index, &call_id)
            {
                if existing_index == insertion_index {
                    if let Some(existing_obj) = messages
                        .get_mut(insertion_index)
                        .and_then(|entry| entry.as_object_mut())
                    {
                        enrich_existing_tool_message(
                            existing_obj,
                            &call_id,
                            call_obj,
                            tool_output_lookup,
                        );
                    }
                    insertion_index += 1;
                    continue;
                }
                let relocated = messages.remove(existing_index);
                messages.insert(insertion_index, relocated);
                if let Some(existing_obj) = messages
                    .get_mut(insertion_index)
                    .and_then(|entry| entry.as_object_mut())
                {
                    enrich_existing_tool_message(
                        existing_obj,
                        &call_id,
                        call_obj,
                        tool_output_lookup,
                    );
                }
                insertion_index += 1;
                continue;
            }
            let placeholder = create_unknown_tool_message(&call_id, call_obj, tool_output_lookup);
            messages.insert(insertion_index, placeholder);
            insertion_index += 1;
        }
        index = std::cmp::max(index + 1, insertion_index);
    }
}

fn collect_valid_call_ids(messages: &[Value]) -> HashSet<String> {
    let mut valid = HashSet::new();
    for message in messages {
        let Some(message_obj) = message.as_object() else {
            continue;
        };
        let role = message_obj
            .get("role")
            .and_then(|entry| entry.as_str())
            .unwrap_or("")
            .trim()
            .to_ascii_lowercase();
        if role != "assistant" {
            continue;
        }
        let Some(tool_calls) = message_obj
            .get("tool_calls")
            .and_then(|entry| entry.as_array())
        else {
            continue;
        };
        for call in tool_calls {
            if let Some(call_obj) = call.as_object() {
                if let Some(call_id) = read_tool_call_id(call_obj) {
                    valid.insert(call_id);
                }
            }
        }
    }
    valid
}

fn filter_tool_outputs(
    tool_outputs: Option<Vec<Value>>,
    valid_call_ids: &HashSet<String>,
) -> Option<Vec<Value>> {
    let Some(entries) = tool_outputs else {
        return None;
    };
    if entries.is_empty() {
        return None;
    }
    let mut filtered: Vec<Value> = Vec::new();
    for entry in entries {
        let Some(row) = entry.as_object() else {
            continue;
        };
        let Some(call_id) = read_tool_output_id(row) else {
            continue;
        };
        if !valid_call_ids.contains(call_id.as_str()) {
            continue;
        }
        filtered.push(Value::Object(row.clone()));
    }
    if filtered.is_empty() {
        None
    } else {
        Some(filtered)
    }
}

pub(crate) fn normalize_tool_session_payload(
    input: ToolSessionCompatInput,
) -> ToolSessionCompatOutput {
    let mut messages = input.messages;
    let tool_output_lookup = build_tool_output_lookup(input.tool_outputs.as_ref());
    normalize_tool_call_ordering(&mut messages, &tool_output_lookup);
    let valid_call_ids = collect_valid_call_ids(&messages);
    let tool_outputs = filter_tool_outputs(input.tool_outputs, &valid_call_ids);
    ToolSessionCompatOutput {
        messages,
        tool_outputs,
    }
}

fn read_tool_name_from_call(call: &Map<String, Value>) -> Option<String> {
    let function = call.get("function").and_then(|entry| entry.as_object())?;
    read_trimmed_string(function.get("name"))
}

fn read_tool_name_from_message(message: &Map<String, Value>) -> Option<String> {
    read_trimmed_string(message.get("name"))
}

fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339()
}

fn collect_tool_history_records(messages: &[Value], ts: &str) -> Vec<ToolHistoryMessageRecord> {
    let mut records: Vec<ToolHistoryMessageRecord> = Vec::new();
    for message in messages {
        let Some(message_obj) = message.as_object() else {
            continue;
        };
        let role = message_obj
            .get("role")
            .and_then(|entry| entry.as_str())
            .unwrap_or("")
            .trim()
            .to_ascii_lowercase();
        if role == "assistant" {
            let Some(tool_calls) = message_obj
                .get("tool_calls")
                .and_then(|entry| entry.as_array())
            else {
                continue;
            };
            for call in tool_calls {
                let Some(call_obj) = call.as_object() else {
                    continue;
                };
                let Some(call_id) = read_tool_call_id(call_obj) else {
                    continue;
                };
                let name = read_tool_name_from_call(call_obj);
                records.push(ToolHistoryMessageRecord {
                    role: "assistant".to_string(),
                    tool_use: Some(ToolHistoryToolUse { id: call_id, name }),
                    tool_result: None,
                    ts: ts.to_string(),
                });
            }
            continue;
        }
        if role == "tool" {
            let Some(call_id) = read_tool_message_id(message_obj) else {
                continue;
            };
            let name = read_tool_name_from_message(message_obj);
            let status = match message_obj.get("content").and_then(|entry| entry.as_str()) {
                Some(content) if content.starts_with(TOOL_UNKNOWN_PREFIX) => "unknown".to_string(),
                _ => "ok".to_string(),
            };
            records.push(ToolHistoryMessageRecord {
                role: "tool".to_string(),
                tool_use: None,
                tool_result: Some(ToolHistoryToolResult {
                    id: call_id,
                    name,
                    status,
                }),
                ts: ts.to_string(),
            });
        }
    }
    records
}

fn build_updated_tool_session_history(
    existing: Option<ToolSessionHistory>,
    delta: &[ToolHistoryMessageRecord],
    max_messages: usize,
    ts: &str,
) -> ToolSessionHistory {
    let previous = existing
        .as_ref()
        .map(|row| row.last_messages.clone())
        .unwrap_or_default();
    let mut combined = previous;
    for row in delta {
        combined.push(row.clone());
    }
    let limit = if max_messages == 0 { 10 } else { max_messages };
    let start = combined.len().saturating_sub(limit);
    let trimmed = combined[start..].to_vec();

    let mut pending_tool_uses: HashMap<String, ToolSessionPendingUse> = HashMap::new();
    for row in &trimmed {
        if let Some(tool_use) = &row.tool_use {
            pending_tool_uses.insert(
                tool_use.id.clone(),
                ToolSessionPendingUse {
                    name: tool_use.name.clone(),
                    ts: row.ts.clone(),
                },
            );
        }
        if let Some(tool_result) = &row.tool_result {
            pending_tool_uses.remove(&tool_result.id);
        }
    }

    ToolSessionHistory {
        last_messages: trimmed,
        pending_tool_uses,
        updated_at: ts.to_string(),
    }
}

fn update_tool_session_history_payload(
    input: ToolSessionHistoryUpdateInput,
) -> ToolSessionHistoryUpdateOutput {
    let ts = input
        .now_iso
        .as_ref()
        .map(|row| row.trim().to_string())
        .filter(|row| !row.is_empty())
        .unwrap_or_else(now_iso);
    let records = collect_tool_history_records(&input.messages, &ts);
    if records.is_empty() && input.existing_history.is_none() {
        return ToolSessionHistoryUpdateOutput {
            history: None,
            records_count: 0,
        };
    }
    let max_messages = input.max_messages.unwrap_or(10);
    let history =
        build_updated_tool_session_history(input.existing_history, &records, max_messages, &ts);
    ToolSessionHistoryUpdateOutput {
        history: Some(history),
        records_count: records.len(),
    }
}

#[napi]
pub fn normalize_tool_session_messages_json(input_json: String) -> NapiResult<String> {
    if input_json.trim().is_empty() {
        return Err(napi::Error::from_reason("Input JSON is empty"));
    }
    let input: ToolSessionCompatInput = serde_json::from_str(&input_json)
        .map_err(|e| napi::Error::from_reason(format!("Failed to parse input JSON: {}", e)))?;
    let output = normalize_tool_session_payload(input);
    serde_json::to_string(&output)
        .map_err(|e| napi::Error::from_reason(format!("Failed to serialize output: {}", e)))
}

#[napi]
pub fn update_tool_session_history_json(input_json: String) -> NapiResult<String> {
    if input_json.trim().is_empty() {
        return Err(napi::Error::from_reason("Input JSON is empty"));
    }
    let input: ToolSessionHistoryUpdateInput = serde_json::from_str(&input_json)
        .map_err(|e| napi::Error::from_reason(format!("Failed to parse input JSON: {}", e)))?;
    let output = update_tool_session_history_payload(input);
    serde_json::to_string(&output)
        .map_err(|e| napi::Error::from_reason(format!("Failed to serialize output: {}", e)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn normalizes_assistant_tool_message_order_and_inserts_unknown_placeholder() {
        let input = ToolSessionCompatInput {
            messages: vec![
                json!({
                  "role": "assistant",
                  "tool_calls": [
                    {"id": "call_a", "type": "function", "function": {"name": "toolA"}},
                    {"id": "call_b", "type": "function", "function": {"name": "toolB"}}
                  ]
                }),
                json!({
                  "role": "tool",
                  "tool_call_id": "call_b",
                  "name": "toolB",
                  "content": "ok"
                }),
            ],
            tool_outputs: None,
        };
        let output = normalize_tool_session_payload(input);
        assert_eq!(output.messages.len(), 3);
        let first_tool = output.messages[1].as_object().unwrap();
        assert_eq!(
            first_tool.get("tool_call_id").and_then(|v| v.as_str()),
            Some("call_a")
        );
        assert!(first_tool
            .get("content")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .starts_with(TOOL_UNKNOWN_PREFIX));
        let second_tool = output.messages[2].as_object().unwrap();
        assert_eq!(
            second_tool.get("tool_call_id").and_then(|v| v.as_str()),
            Some("call_b")
        );
    }

    #[test]
    fn filters_tool_outputs_to_known_assistant_tool_call_ids() {
        let input = ToolSessionCompatInput {
            messages: vec![json!({
              "role": "assistant",
              "tool_calls": [{"id": "call_keep", "type": "function", "function": {"name": "keep"}}]
            })],
            tool_outputs: Some(vec![
                json!({"tool_call_id": "call_keep", "content": "ok"}),
                json!({"tool_call_id": "call_drop", "content": "drop"}),
            ]),
        };
        let output = normalize_tool_session_payload(input);
        let outputs = output.tool_outputs.unwrap();
        assert_eq!(outputs.len(), 1);
        assert_eq!(
            outputs[0]
                .as_object()
                .and_then(|v| v.get("tool_call_id"))
                .and_then(|v| v.as_str()),
            Some("call_keep")
        );
    }

    #[test]
    fn fills_placeholder_content_from_tool_outputs_when_available() {
        let input = ToolSessionCompatInput {
            messages: vec![json!({
              "role": "assistant",
              "tool_calls": [{"id": "call_with_output", "type": "function", "function": {"name": "fetch"}}]
            })],
            tool_outputs: Some(vec![json!({
              "tool_call_id": "call_with_output",
              "name": "fetch",
              "output": {"ok": true}
            })]),
        };
        let output = normalize_tool_session_payload(input);
        assert_eq!(output.messages.len(), 2);
        let tool_message = output.messages[1].as_object().unwrap();
        assert_eq!(
            tool_message.get("tool_call_id").and_then(|v| v.as_str()),
            Some("call_with_output")
        );
        assert_eq!(
            tool_message.get("name").and_then(|v| v.as_str()),
            Some("fetch")
        );
        assert_eq!(
            tool_message.get("content").and_then(|v| v.as_str()),
            Some("{\"ok\":true}")
        );
    }

    #[test]
    fn replaces_unknown_placeholder_with_real_tool_output_on_rehydrate() {
        let input = ToolSessionCompatInput {
            messages: vec![
                json!({
                  "role": "assistant",
                  "tool_calls": [{"id": "call_rehydrate", "type": "function", "function": {"name": "rehydrate"}}]
                }),
                json!({
                  "role": "tool",
                  "tool_call_id": "call_rehydrate",
                  "content": "[RouteCodex] Tool call result unknown: tool \"rehydrate\" (call_rehydrate) did not produce a result in this session. Treat this tool as failed with unknown status."
                }),
            ],
            tool_outputs: Some(vec![json!({
              "tool_call_id": "call_rehydrate",
              "output": "done"
            })]),
        };
        let output = normalize_tool_session_payload(input);
        let tool_message = output.messages[1].as_object().unwrap();
        assert_eq!(
            tool_message.get("content").and_then(|v| v.as_str()),
            Some("done")
        );
    }

    #[test]
    fn updates_tool_session_history_with_pending_state() {
        let input = ToolSessionHistoryUpdateInput {
            messages: vec![json!({
              "role": "assistant",
              "tool_calls": [
                {"id": "call_a", "type": "function", "function": {"name": "toolA"}}
              ]
            })],
            existing_history: None,
            max_messages: Some(10),
            now_iso: Some("2026-02-26T00:00:00.000Z".to_string()),
        };
        let output = update_tool_session_history_payload(input);
        assert_eq!(output.records_count, 1);
        let history = output.history.expect("history should be present");
        assert_eq!(history.last_messages.len(), 1);
        assert_eq!(history.pending_tool_uses.len(), 1);
        let pending = history.pending_tool_uses.get("call_a").unwrap();
        assert_eq!(pending.name.as_deref(), Some("toolA"));
        assert_eq!(pending.ts, "2026-02-26T00:00:00.000Z");
    }

    #[test]
    fn clears_pending_when_tool_result_arrives() {
        let existing = ToolSessionHistory {
            last_messages: vec![ToolHistoryMessageRecord {
                role: "assistant".to_string(),
                tool_use: Some(ToolHistoryToolUse {
                    id: "call_a".to_string(),
                    name: Some("toolA".to_string()),
                }),
                tool_result: None,
                ts: "2026-02-26T00:00:00.000Z".to_string(),
            }],
            pending_tool_uses: HashMap::from([(
                "call_a".to_string(),
                ToolSessionPendingUse {
                    name: Some("toolA".to_string()),
                    ts: "2026-02-26T00:00:00.000Z".to_string(),
                },
            )]),
            updated_at: "2026-02-26T00:00:00.000Z".to_string(),
        };
        let input = ToolSessionHistoryUpdateInput {
            messages: vec![json!({
              "role": "tool",
              "tool_call_id": "call_a",
              "name": "toolA",
              "content": "done"
            })],
            existing_history: Some(existing),
            max_messages: Some(10),
            now_iso: Some("2026-02-26T00:00:01.000Z".to_string()),
        };
        let output = update_tool_session_history_payload(input);
        let history = output.history.expect("history should be present");
        assert_eq!(history.pending_tool_uses.len(), 0);
    }
}
