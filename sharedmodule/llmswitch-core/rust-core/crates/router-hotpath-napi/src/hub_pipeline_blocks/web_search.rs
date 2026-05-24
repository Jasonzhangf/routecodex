use serde_json::{Map, Value};

use crate::shared_json_utils::{parse_js_number_like, value_as_object_or_empty};
use crate::web_search_mode::{resolve_web_search_execution_mode, WebSearchExecutionMode};

pub(crate) fn is_search_route_id(route_id: &Value) -> bool {
    let normalized = route_id.as_str().unwrap_or("").trim().to_ascii_lowercase();
    normalized.starts_with("web_search") || normalized.starts_with("search")
}

pub(crate) fn is_canonical_web_search_tool_definition(tool: &Value) -> bool {
    let Some(row) = tool.as_object() else {
        return false;
    };
    let raw_type = row
        .get("type")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    if raw_type == "web_search_20250305" || raw_type == "web_search" {
        return true;
    }
    let function_name = row
        .get("function")
        .and_then(|v| v.as_object())
        .and_then(|fn_node| fn_node.get("name"))
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let fallback_name = row.get("name").and_then(|v| v.as_str()).unwrap_or("");
    let normalized = if function_name.trim().is_empty() {
        fallback_name.trim().to_ascii_lowercase()
    } else {
        function_name.trim().to_ascii_lowercase()
    };
    matches!(
        normalized.as_str(),
        "web_search" | "websearch" | "web-search"
    )
}

pub(crate) fn apply_direct_builtin_web_search_tool(
    provider_payload: &Value,
    provider_protocol: &str,
    route_id: &Value,
    runtime_metadata: &Value,
) -> Value {
    let mut payload = value_as_object_or_empty(provider_payload);
    if !is_search_route_id(route_id) {
        return Value::Object(payload);
    }
    let model_id = payload
        .get("model")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim();
    if model_id.is_empty() {
        return Value::Object(payload);
    }
    let runtime_metadata_obj = match runtime_metadata.as_object() {
        Some(v) => v,
        None => {
            return Value::Object(payload);
        }
    };
    let matched_engine = match find_direct_builtin_web_search_engine(runtime_metadata_obj, model_id)
    {
        Some(v) => v,
        None => {
            return Value::Object(payload);
        }
    };
    if provider_protocol.trim() != "anthropic-messages" {
        return Value::Object(payload);
    }

    let raw_max_uses = parse_js_number_like(matched_engine.get("maxUses"));
    let max_uses = match raw_max_uses {
        Some(value) if value.is_finite() && value > 0.0 => value.floor() as i64,
        _ => 2,
    };
    let builtin_tool = build_builtin_web_search_tool(max_uses);

    let tools = payload
        .get("tools")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let mut replaced = false;
    let mut next_tools = Vec::<Value>::new();
    for tool in tools {
        if !replaced && is_canonical_web_search_tool_definition(&tool) {
            next_tools.push(builtin_tool.clone());
            replaced = true;
            continue;
        }
        if is_canonical_web_search_tool_definition(&tool) {
            continue;
        }
        next_tools.push(tool);
    }
    if !replaced {
        next_tools.insert(0, builtin_tool);
    }
    payload.insert("tools".to_string(), Value::Array(next_tools));
    Value::Object(payload)
}

fn is_builtin_web_search_tool_definition(tool: &Value) -> bool {
    let Some(row) = tool.as_object() else {
        return false;
    };
    let raw_type = row
        .get("type")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    matches!(raw_type.as_str(), "web_search" | "web_search_20250305")
}

fn strip_builtin_web_search_tools(payload: &mut Map<String, Value>) {
    let tools = payload
        .get("tools")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    if tools.is_empty() {
        return;
    }
    let next_tools: Vec<Value> = tools
        .into_iter()
        .filter(|tool| !is_builtin_web_search_tool_definition(tool))
        .collect();
    payload.insert("tools".to_string(), Value::Array(next_tools));
}

fn find_direct_builtin_web_search_engine<'a>(
    runtime_metadata: &'a Map<String, Value>,
    model_id: &str,
) -> Option<&'a Map<String, Value>> {
    let web_search = runtime_metadata.get("webSearch")?.as_object()?;
    let engines = web_search.get("engines")?.as_array()?;
    let suffix = format!(".{}", model_id);
    for entry in engines {
        let row = match entry.as_object() {
            Some(v) => v,
            None => continue,
        };
        if resolve_web_search_execution_mode(row) != WebSearchExecutionMode::DirectBuiltin {
            continue;
        }
        let configured_model_id = row
            .get("modelId")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim();
        if !configured_model_id.is_empty() {
            if configured_model_id == model_id {
                return Some(row);
            }
            continue;
        }
        let provider_key = row
            .get("providerKey")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim();
        if provider_key.ends_with(suffix.as_str()) {
            return Some(row);
        }
    }
    None
}

fn build_builtin_web_search_tool(max_uses: i64) -> Value {
    let mut builtin_tool = Map::<String, Value>::new();
    builtin_tool.insert(
        "type".to_string(),
        Value::String("web_search_20250305".to_string()),
    );
    builtin_tool.insert("name".to_string(), Value::String("web_search".to_string()));
    builtin_tool.insert(
        "max_uses".to_string(),
        Value::Number(serde_json::Number::from(max_uses)),
    );
    Value::Object(builtin_tool)
}

