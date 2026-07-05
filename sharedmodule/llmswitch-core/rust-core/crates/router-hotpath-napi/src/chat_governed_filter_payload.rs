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

fn read_string(value: Option<&Value>) -> String {
    value
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .unwrap_or("")
        .to_string()
}

fn should_disable_auto_tool_injection_for_no_tools(
    request_obj: Option<&Map<String, Value>>,
    context_obj: Option<&Map<String, Value>>,
) -> bool {
    let incoming_protocol = read_string(
        context_obj
            .and_then(|obj| obj.get("incomingProtocol"))
            .or_else(|| context_obj.and_then(|obj| obj.get("incoming_protocol"))),
    )
    .to_lowercase();
    let entry_endpoint = read_string(
        context_obj
            .and_then(|obj| obj.get("entryEndpoint"))
            .or_else(|| context_obj.and_then(|obj| obj.get("endpoint"))),
    )
    .to_lowercase();
    let original_tool_count = request_obj
        .and_then(|obj| obj.get("tools"))
        .and_then(Value::as_array)
        .map(Vec::len)
        .unwrap_or(0);

    original_tool_count == 0
        && (incoming_protocol == "anthropic-messages" || entry_endpoint.contains("/v1/messages"))
}

fn build_governed_filter_payload_with_context(request: Value, context: Option<Value>) -> Value {
    let request_obj = as_object(&request);
    let context_obj = context.as_ref().and_then(as_object);
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
    let tool_choice = request_obj
        .and_then(|obj| obj.get("tool_choice"))
        .or_else(|| parameter_obj.and_then(|obj| obj.get("tool_choice")))
        .filter(|value| !value.is_null())
        .cloned()
        .or_else(|| {
            tools
                .as_array()
                .filter(|items| !items.is_empty())
                .map(|_| Value::String("auto".to_string()))
        });
    let stream = request_obj
        .and_then(|obj| obj.get("stream"))
        .or_else(|| parameter_obj.and_then(|obj| obj.get("stream")))
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

    let mut out = Map::new();
    out.insert("model".to_string(), model);
    out.insert("messages".to_string(), messages);
    if !tools.is_null() {
        out.insert("tools".to_string(), tools);
    }
    if should_disable_auto_tool_injection_for_no_tools(request_obj, context_obj) {
        out.insert("tools".to_string(), Value::Array(Vec::new()));
        out.insert("__rcc_disable_mcp_tools".to_string(), Value::Bool(true));
    }
    if let Some(tool_choice) = tool_choice {
        out.insert("tool_choice".to_string(), tool_choice);
    }
    out.insert("stream".to_string(), Value::Bool(stream));
    out.insert("parameters".to_string(), parameters);
    Value::Object(out)
}

fn build_governed_filter_payload(request: Value) -> Value {
    build_governed_filter_payload_with_context(request, None)
}

#[napi]
pub fn build_governed_filter_payload_json(request_json: String) -> NapiResult<String> {
    let request: Value =
        serde_json::from_str(&request_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let output = build_governed_filter_payload(request);
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi]
pub fn build_governed_filter_payload_with_context_json(
    request_json: String,
    context_json: String,
) -> NapiResult<String> {
    let request: Value =
        serde_json::from_str(&request_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let context: Value =
        serde_json::from_str(&context_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let output = build_governed_filter_payload_with_context(request, Some(context));
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::build_governed_filter_payload_with_context;
    use serde_json::json;

    #[test]
    fn anthropic_messages_without_tools_disables_auto_tool_injection() {
        let output = build_governed_filter_payload_with_context(
            json!({
                "model": "claude",
                "messages": [],
                "parameters": {}
            }),
            Some(
                json!({ "incomingProtocol": "anthropic-messages", "entryEndpoint": "/v1/messages" }),
            ),
        );
        assert_eq!(output["tools"], json!([]));
        assert_eq!(output["__rcc_disable_mcp_tools"], json!(true));
    }

    #[test]
    fn anthropic_messages_with_tools_keeps_declared_tools() {
        let output = build_governed_filter_payload_with_context(
            json!({
                "model": "claude",
                "messages": [],
                "tools": [{ "name": "exec" }],
                "parameters": {}
            }),
            Some(
                json!({ "incomingProtocol": "anthropic-messages", "entryEndpoint": "/v1/messages" }),
            ),
        );
        assert_eq!(output["tools"], json!([{ "name": "exec" }]));
        assert_eq!(output.get("__rcc_disable_mcp_tools"), None);
    }
}
