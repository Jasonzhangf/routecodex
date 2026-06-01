use napi::bindgen_prelude::Result as NapiResult;
use serde::Deserialize;
use serde_json::{json, Map, Value};

use crate::chat_servertool_orchestration::{
    build_continue_execution_operations_json, plan_chat_servertool_orchestration_bundle_json,
};
use crate::chat_web_search_tool_schema::build_web_search_tool_append_operations_json;
use crate::hub_req_inbound_context_capture::resolve_client_inject_ready_json;
use crate::shared_json_utils::parse_json_bool;
use crate::web_search_mode::{
    resolve_web_search_execution_mode_from_value, WebSearchExecutionMode,
};

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WebSearchPlan {
    should_inject: bool,
    #[serde(default)]
    selected_engine_indexes: Vec<i64>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SimpleInjectPlan {
    should_inject: bool,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ServerToolBundlePlan {
    #[serde(default)]
    web_search: WebSearchPlan,
    #[serde(default)]
    continue_execution: SimpleInjectPlan,
}

fn parse_json_array(raw: &str) -> Vec<Value> {
    match serde_json::from_str::<Value>(raw) {
        Ok(Value::Array(rows)) => rows,
        _ => Vec::new(),
    }
}

fn parse_bundle_plan(raw: &str) -> Option<ServerToolBundlePlan> {
    serde_json::from_str::<ServerToolBundlePlan>(raw).ok()
}

fn pick_bool(value: Option<&Value>) -> Option<bool> {
    match value {
        Some(Value::Bool(v)) => Some(*v),
        Some(Value::String(raw)) => {
            let lowered = raw.trim().to_ascii_lowercase();
            if lowered == "true" {
                return Some(true);
            }
            if lowered == "false" {
                return Some(false);
            }
            None
        }
        Some(Value::Number(raw)) => {
            if raw.as_i64() == Some(1) {
                return Some(true);
            }
            if raw.as_i64() == Some(0) {
                return Some(false);
            }
            None
        }
        _ => None,
    }
}

pub(crate) fn read_runtime_metadata(metadata: &Map<String, Value>) -> Map<String, Value> {
    metadata
        .get("__rt")
        .and_then(|v| v.as_object())
        .cloned()
        .unwrap_or_default()
}

pub(crate) fn resolve_client_inject_ready(metadata: &Map<String, Value>) -> bool {
    let metadata_json = serde_json::to_string(&Value::Object(metadata.clone()))
        .unwrap_or_else(|_| "{}".to_string());
    parse_bool_or_default(resolve_client_inject_ready_json(metadata_json), true)
}

fn resolve_default_bundle_plan(
    runtime_metadata: &Map<String, Value>,
    has_active_stop_message: bool,
) -> ServerToolBundlePlan {
    let server_tool_followup =
        pick_bool(runtime_metadata.get("serverToolFollowup")).unwrap_or(false);
    let (web_search_indexes, has_direct_web_search_engine) = runtime_metadata
        .get("webSearch")
        .and_then(|v| v.as_object())
        .and_then(|row| row.get("engines"))
        .and_then(|v| v.as_array())
        .map(|engines| {
            let mut servertool_indexes: Vec<i64> = Vec::new();
            let mut has_direct = false;
            for (idx, engine) in engines.iter().enumerate() {
                match resolve_web_search_execution_mode_from_value(engine) {
                    WebSearchExecutionMode::Servertool => servertool_indexes.push(idx as i64),
                    WebSearchExecutionMode::DirectRoute | WebSearchExecutionMode::DirectBuiltin => {
                        has_direct = true
                    }
                }
            }
            (servertool_indexes, has_direct)
        })
        .unwrap_or_else(|| (Vec::new(), false));

    // Single gate: direct-capable webSearch and servertool webSearch are mutually exclusive
    // within the same request. Once direct mode is present, do not inject servertool websearch.
    let web_search_should =
        !has_direct_web_search_engine && !web_search_indexes.is_empty() && !server_tool_followup;
    let continue_should = !(server_tool_followup || has_active_stop_message);

    ServerToolBundlePlan {
        web_search: WebSearchPlan {
            should_inject: web_search_should,
            selected_engine_indexes: web_search_indexes,
        },
        continue_execution: SimpleInjectPlan {
            should_inject: continue_should,
        },
    }
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

fn parse_bool_or_default(raw: NapiResult<String>, default: bool) -> bool {
    match raw {
        Ok(payload) => parse_json_bool(&payload).unwrap_or(default),
        Err(_) => default,
    }
}

fn parse_ops_or_empty(raw: NapiResult<String>) -> Vec<Value> {
    match raw {
        Ok(payload) => parse_json_array(&payload),
        Err(_) => Vec::new(),
    }
}

fn parse_bundle_or_default(
    raw: NapiResult<String>,
    runtime_metadata: &Map<String, Value>,
    has_active_stop_message: bool,
) -> ServerToolBundlePlan {
    match raw {
        Ok(payload) => parse_bundle_plan(&payload).unwrap_or_else(|| {
            resolve_default_bundle_plan(runtime_metadata, has_active_stop_message)
        }),
        Err(_) => resolve_default_bundle_plan(runtime_metadata, has_active_stop_message),
    }
}

pub(crate) fn maybe_apply_servertool_orchestration(
    request: &mut Map<String, Value>,
    metadata: &Map<String, Value>,
    has_active_stop_message_for_continue_execution: bool,
) {
    let metadata_json = match serde_json::to_string(&Value::Object(metadata.clone())) {
        Ok(v) => v,
        Err(_) => return,
    };
    let client_inject_ready = parse_bool_or_default(
        resolve_client_inject_ready_json(metadata_json.clone()),
        true,
    );
    if !client_inject_ready {
        return;
    }

    let runtime_metadata = read_runtime_metadata(metadata);
    let has_active_stop_message = has_active_stop_message_for_continue_execution;

    let request_value = Value::Object(request.clone());
    let request_json = match serde_json::to_string(&request_value) {
        Ok(v) => v,
        Err(_) => return,
    };
    let runtime_metadata_json =
        match serde_json::to_string(&Value::Object(runtime_metadata.clone())) {
            Ok(v) => v,
            Err(_) => "{}".to_string(),
        };
    let bundle_plan = parse_bundle_or_default(
        plan_chat_servertool_orchestration_bundle_json(
            request_json,
            runtime_metadata_json,
            has_active_stop_message,
        ),
        &runtime_metadata,
        has_active_stop_message,
    );

    let mut operations: Vec<Value> = Vec::new();

    if bundle_plan.web_search.should_inject
        && !bundle_plan.web_search.selected_engine_indexes.is_empty()
    {
        let engines = read_selected_web_search_engines(
            &runtime_metadata,
            &bundle_plan.web_search.selected_engine_indexes,
        );
        if let Ok(engines_json) = serde_json::to_string(&engines) {
            operations.extend(parse_ops_or_empty(
                build_web_search_tool_append_operations_json(engines_json),
            ));
        }
    }

    operations.extend(parse_ops_or_empty(
        build_continue_execution_operations_json(bundle_plan.continue_execution.should_inject),
    ));
    if operations.is_empty() {
        return;
    }
    apply_hub_operations(request, &operations);
}
