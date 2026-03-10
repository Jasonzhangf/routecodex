use napi::bindgen_prelude::Result as NapiResult;
use napi_derive::napi;
use serde_json::{Map, Value};

fn build_clock_tool_append_operations(has_session_id: bool, clock_tool: Value) -> Value {
    let mut fields = Map::new();
    fields.insert("clockEnabled".to_string(), Value::Bool(true));
    if has_session_id {
        fields.insert("serverToolRequired".to_string(), Value::Bool(true));
    }

    let mut set_metadata_op = Map::new();
    set_metadata_op.insert(
        "op".to_string(),
        Value::String("set_request_metadata_fields".to_string()),
    );
    set_metadata_op.insert("fields".to_string(), Value::Object(fields));

    let mut append_tool_op = Map::new();
    append_tool_op.insert(
        "op".to_string(),
        Value::String("append_tool_if_missing".to_string()),
    );
    append_tool_op.insert("toolName".to_string(), Value::String("clock".to_string()));
    append_tool_op.insert("tool".to_string(), clock_tool);

    Value::Array(vec![
        Value::Object(set_metadata_op),
        Value::Object(append_tool_op),
    ])
}

fn build_clock_standard_tool_append_operations(standard_tools: Value) -> Value {
    let tools = standard_tools.as_array().cloned().unwrap_or_default();
    let mut ops: Vec<Value> = Vec::new();
    for tool in tools {
        let tool_name = tool
            .as_object()
            .and_then(|obj| obj.get("function"))
            .and_then(|v| v.as_object())
            .and_then(|fn_obj| fn_obj.get("name"))
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim()
            .to_string();
        if tool_name.is_empty() {
            continue;
        }
        let mut op = Map::new();
        op.insert(
            "op".to_string(),
            Value::String("append_tool_if_missing".to_string()),
        );
        op.insert("toolName".to_string(), Value::String(tool_name));
        op.insert("tool".to_string(), tool);
        ops.push(Value::Object(op));
    }
    Value::Array(ops)
}

#[napi]
pub fn build_clock_tool_append_operations_json(
    has_session_id: bool,
    clock_tool_json: String,
) -> NapiResult<String> {
    let clock_tool: Value = serde_json::from_str(&clock_tool_json)
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let output = build_clock_tool_append_operations(has_session_id, clock_tool);
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi]
pub fn build_clock_standard_tool_append_operations_json(
    standard_tools_json: String,
) -> NapiResult<String> {
    let standard_tools: Value = serde_json::from_str(&standard_tools_json)
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let output = build_clock_standard_tool_append_operations(standard_tools);
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}
