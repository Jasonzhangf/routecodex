use napi::bindgen_prelude::Result as NapiResult;
use napi_derive::napi;
use serde_json::{Map, Value};

fn as_object(value: &Value) -> Option<&Map<String, Value>> {
    value.as_object()
}

fn read_messages(request_obj: Option<&Map<String, Value>>) -> Value {
    request_obj
        .and_then(|obj| obj.get("messages"))
        .filter(|v| v.is_array())
        .cloned()
        .unwrap_or(Value::Array(Vec::new()))
}

fn read_parameters(request_obj: Option<&Map<String, Value>>) -> Value {
    request_obj
        .and_then(|obj| obj.get("parameters"))
        .and_then(|v| v.as_object())
        .map(|row| Value::Object(row.clone()))
        .unwrap_or(Value::Object(Map::new()))
}

fn build_governed_filter_payload(request: Value) -> Value {
    let request_obj = as_object(&request);
    let model = request_obj
        .and_then(|obj| obj.get("model"))
        .cloned()
        .unwrap_or(Value::Null);
    let messages = read_messages(request_obj);
    let tools = request_obj
        .and_then(|obj| obj.get("tools"))
        .cloned()
        .unwrap_or(Value::Null);
    let parameters = read_parameters(request_obj);
    let parameter_obj = parameters.as_object();
    let tool_choice = parameter_obj
        .and_then(|obj| obj.get("tool_choice"))
        .cloned()
        .unwrap_or(Value::Null);
    let stream = parameter_obj
        .and_then(|obj| obj.get("stream"))
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

    let mut out = Map::new();
    out.insert("model".to_string(), model);
    out.insert("messages".to_string(), messages);
    if !tools.is_null() {
        out.insert("tools".to_string(), tools);
    }
    out.insert("tool_choice".to_string(), tool_choice);
    out.insert("stream".to_string(), Value::Bool(stream));
    out.insert("parameters".to_string(), parameters);
    Value::Object(out)
}

#[napi]
pub fn build_governed_filter_payload_json(request_json: String) -> NapiResult<String> {
    let request: Value =
        serde_json::from_str(&request_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let output = build_governed_filter_payload(request);
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}
