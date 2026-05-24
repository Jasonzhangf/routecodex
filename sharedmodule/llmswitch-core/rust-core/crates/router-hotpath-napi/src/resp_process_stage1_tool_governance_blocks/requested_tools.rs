use crate::resp_process_stage1_tool_governance_blocks::tool_names::normalize_tool_name;
use crate::shared_json_utils::read_trimmed_string;
use serde_json::{Map, Value};
use std::collections::HashSet;

pub(crate) fn strip_internal_tool_governance_state(payload: &mut Value) {
    let Some(root) = payload.as_object_mut() else {
        return;
    };
    root.remove("__rcc_tool_governance");
}

pub(crate) fn copy_internal_tool_governance_state(source: &Value, target: &mut Value) {
    let source_state = source
        .as_object()
        .and_then(|root| root.get("__rcc_tool_governance"))
        .cloned();
    let Some(source_state) = source_state else {
        return;
    };
    let Some(target_root) = target.as_object_mut() else {
        return;
    };
    if !target_root.contains_key("__rcc_tool_governance") {
        target_root.insert("__rcc_tool_governance".to_string(), source_state);
    }
}

pub(crate) fn inject_requested_tool_names_into_internal_governance(
    payload: &mut Value,
    requested_tool_names: &[String],
) {
    if requested_tool_names.is_empty() {
        return;
    }
    let Some(root) = payload.as_object_mut() else {
        return;
    };
    let governance_entry = root
        .entry("__rcc_tool_governance".to_string())
        .or_insert_with(|| Value::Object(Map::new()));
    if !governance_entry.is_object() {
        *governance_entry = Value::Object(Map::new());
    }
    let Some(governance) = governance_entry.as_object_mut() else {
        return;
    };

    let mut merged: Vec<String> = governance
        .get("requestedToolNames")
        .and_then(Value::as_array)
        .into_iter()
        .flat_map(|rows| rows.iter())
        .filter_map(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.to_string())
        .collect();

    for raw_name in requested_tool_names {
        let normalized = raw_name.trim();
        if normalized.is_empty() {
            continue;
        }
        if !merged.iter().any(|existing| existing == normalized) {
            merged.push(normalized.to_string());
        }
    }

    if merged.is_empty() {
        return;
    }

    governance.insert(
        "requestedToolNames".to_string(),
        Value::Array(merged.into_iter().map(Value::String).collect()),
    );
}

fn normalize_requested_tool_name_key(raw_name: &str) -> Option<String> {
    let normalized = normalize_tool_name(raw_name)?;
    let key = normalized.trim().to_ascii_lowercase();
    if key.is_empty() {
        return None;
    }
    Some(key)
}

fn collect_requested_tool_name_keys_from_candidate(
    candidate: Option<&Value>,
    out: &mut HashSet<String>,
) {
    let Some(value) = candidate else {
        return;
    };
    let Some(rows) = value.as_array() else {
        return;
    };

    for row in rows {
        if let Some(raw_name) = row.as_str() {
            if let Some(key) = normalize_requested_tool_name_key(raw_name) {
                out.insert(key);
            }
            continue;
        }
        let Some(obj) = row.as_object() else {
            continue;
        };
        let raw_name = obj
            .get("function")
            .and_then(Value::as_object)
            .and_then(|function| read_trimmed_string(function.get("name")))
            .or_else(|| read_trimmed_string(obj.get("name")));
        if let Some(raw_name) = raw_name {
            if let Some(key) = normalize_requested_tool_name_key(raw_name.as_str()) {
                out.insert(key);
            }
        }
    }
}

pub(crate) fn collect_requested_tool_name_keys(payload: &Value) -> HashSet<String> {
    let mut out = HashSet::new();
    let root = match payload.as_object() {
        Some(root) => root,
        None => return out,
    };

    let governance = root.get("__rcc_tool_governance").and_then(Value::as_object);
    collect_requested_tool_name_keys_from_candidate(root.get("tools"), &mut out);
    collect_requested_tool_name_keys_from_candidate(
        governance.and_then(|row| row.get("requestedToolNames")),
        &mut out,
    );
    collect_requested_tool_name_keys_from_candidate(
        governance.and_then(|row| row.get("allowedToolNames")),
        &mut out,
    );
    out
}

pub(crate) fn read_tool_call_name_key(tool_call: &Value) -> Option<String> {
    let raw_name = tool_call
        .as_object()
        .and_then(|row| row.get("function"))
        .and_then(Value::as_object)
        .and_then(|function| read_trimmed_string(function.get("name")))?;
    normalize_requested_tool_name_key(raw_name.as_str())
}

pub(crate) fn retain_allowed_tool_calls(
    tool_calls: &mut Vec<Value>,
    requested_tool_name_keys: &HashSet<String>,
) -> i64 {
    if requested_tool_name_keys.is_empty() {
        return 0;
    }
    let before = tool_calls.len();
    tool_calls.retain(|entry| {
        read_tool_call_name_key(entry)
            .map(|key| requested_tool_name_keys.contains(key.as_str()))
            .unwrap_or(false)
    });
    (before.saturating_sub(tool_calls.len())) as i64
}
