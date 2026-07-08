use serde_json::{Map, Value};

use crate::chat_servertool_orchestration::plan_chat_servertool_orchestration_bundle;
use crate::chat_web_search_tool_schema::build_web_search_tool_append_operations;
use crate::hub_req_inbound_context_capture::resolve_client_inject_ready as resolve_client_inject_ready_from_metadata;
use crate::web_search_mode::{
    resolve_web_search_execution_mode_from_value, WebSearchExecutionMode,
};

pub(crate) fn read_runtime_metadata(metadata: &Map<String, Value>) -> Map<String, Value> {
    metadata
        .get("__rt")
        .and_then(|v| v.as_object())
        .cloned()
        .unwrap_or_default()
}

pub(crate) fn resolve_client_inject_ready(metadata: &Map<String, Value>) -> bool {
    resolve_client_inject_ready_from_metadata(&Value::Object(metadata.clone()))
}

fn read_selected_web_search_engines(
    runtime_metadata: &Map<String, Value>,
    indexes: &[i64],
) -> Value {
    let engines = runtime_metadata
        .get("webSearch")
        .and_then(|v| v.as_object())
        .and_then(|row| row.get("engines"))
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let mut selected: Vec<Value> = Vec::new();
    for index in indexes {
        if *index < 0 {
            continue;
        }
        let idx = *index as usize;
        if idx >= engines.len() {
            continue;
        }
        if resolve_web_search_execution_mode_from_value(&engines[idx])
            != WebSearchExecutionMode::Servertool
        {
            continue;
        }
        selected.push(engines[idx].clone());
    }
    Value::Array(selected)
}

pub(crate) fn resolve_tool_name(tool: &Value) -> Option<String> {
    let obj = tool.as_object()?;
    let direct = obj
        .get("name")
        .and_then(|v| v.as_str())
        .map(|v| v.trim().to_string());
    if let Some(name) = direct {
        if !name.is_empty() {
            return Some(name);
        }
    }
    obj.get("function")
        .and_then(|v| v.as_object())
        .and_then(|row| row.get("name"))
        .and_then(|v| v.as_str())
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
}

fn request_has_tool(request: &Map<String, Value>, tool_name: &str) -> bool {
    let normalized = tool_name.trim();
    if normalized.is_empty() {
        return false;
    }
    request
        .get("tools")
        .and_then(|v| v.as_array())
        .map(|tools| {
            tools.iter().any(|tool| {
                resolve_tool_name(tool)
                    .map(|name| name == normalized)
                    .unwrap_or(false)
            })
        })
        .unwrap_or(false)
}

pub(crate) fn apply_hub_operations(request: &mut Map<String, Value>, operations: &[Value]) {
    for op in operations {
        let row = match op.as_object() {
            Some(v) => v,
            None => continue,
        };
        let kind = row.get("op").and_then(|v| v.as_str()).unwrap_or("").trim();
        if kind == "set_request_metadata_fields" {
            let patch = match row.get("fields").and_then(|v| v.as_object()) {
                Some(v) => v,
                None => continue,
            };
            let metadata = request
                .entry("metadata".to_string())
                .or_insert_with(|| Value::Object(Map::new()));
            if !metadata.is_object() {
                *metadata = Value::Object(Map::new());
            }
            if let Some(metadata_row) = metadata.as_object_mut() {
                for (key, value) in patch {
                    metadata_row.insert(key.clone(), value.clone());
                }
            }
            continue;
        }
        if kind == "set_request_parameter_fields" {
            let patch = match row.get("fields").and_then(|v| v.as_object()) {
                Some(v) => v,
                None => continue,
            };
            let parameters = request
                .entry("parameters".to_string())
                .or_insert_with(|| Value::Object(Map::new()));
            if !parameters.is_object() {
                *parameters = Value::Object(Map::new());
            }
            if let Some(parameters_row) = parameters.as_object_mut() {
                for (key, value) in patch {
                    parameters_row.insert(key.clone(), value.clone());
                }
            }
            continue;
        }
        if kind == "unset_request_metadata_keys" || kind == "unset_request_parameter_keys" {
            let keys = row
                .get("keys")
                .and_then(|v| v.as_array())
                .map(|arr| {
                    arr.iter()
                        .filter_map(|entry| entry.as_str())
                        .map(|raw| raw.trim().to_string())
                        .filter(|key| !key.is_empty())
                        .collect::<Vec<String>>()
                })
                .unwrap_or_default();
            if keys.is_empty() {
                continue;
            }
            let target_key = if kind == "unset_request_metadata_keys" {
                "metadata"
            } else {
                "parameters"
            };
            let target = request
                .entry(target_key.to_string())
                .or_insert_with(|| Value::Object(Map::new()));
            if !target.is_object() {
                *target = Value::Object(Map::new());
            }
            if let Some(target_obj) = target.as_object_mut() {
                for key in keys {
                    target_obj.remove(&key);
                }
            }
            continue;
        }
        if kind == "append_tool_if_missing" {
            let tool_name = row
                .get("toolName")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .trim()
                .to_string();
            if tool_name.is_empty() {
                continue;
            }
            if request_has_tool(request, &tool_name) {
                continue;
            }
            let tool_value = match row.get("tool") {
                Some(v) => v.clone(),
                None => continue,
            };
            let tools = request
                .entry("tools".to_string())
                .or_insert_with(|| Value::Array(Vec::new()));
            if !tools.is_array() {
                *tools = Value::Array(Vec::new());
            }
            if let Some(tool_array) = tools.as_array_mut() {
                tool_array.push(tool_value);
            }
        }
    }
}

pub(crate) fn maybe_apply_servertool_orchestration(
    request: &mut Map<String, Value>,
    metadata: &Map<String, Value>,
    _has_active_stop_message_for_continue_execution: bool,
) {
    let client_inject_ready = resolve_client_inject_ready(metadata);
    if !client_inject_ready {
        return;
    }

    let runtime_metadata = read_runtime_metadata(metadata);
    let bundle_plan = plan_chat_servertool_orchestration_bundle(
        &Value::Object(request.clone()),
        &Value::Object(runtime_metadata.clone()),
        false,
    );

    let mut operations: Vec<Value> = Vec::new();

    if bundle_plan.web_search.should_inject
        && !bundle_plan.web_search.selected_engine_indexes.is_empty()
    {
        let engines = read_selected_web_search_engines(
            &runtime_metadata,
            &bundle_plan.web_search.selected_engine_indexes,
        );
        if let Some(Value::Array(ops)) = build_web_search_tool_append_operations(&engines) {
            operations.extend(ops);
        }
    }

    if operations.is_empty() {
        return;
    }
    apply_hub_operations(request, &operations);
}
