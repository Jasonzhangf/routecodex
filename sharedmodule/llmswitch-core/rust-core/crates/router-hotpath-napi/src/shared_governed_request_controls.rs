use serde_json::{Map, Value};

pub(crate) struct GovernedRequestControls {
    pub parameters: Value,
    pub tool_choice: Option<Value>,
    pub parallel_tool_calls: Option<Value>,
    pub stream: bool,
}

fn read_parameters(request_obj: Option<&Map<String, Value>>) -> Value {
    request_obj
        .and_then(|obj| obj.get("parameters"))
        .and_then(|v| v.as_object())
        .map(|row| Value::Object(row.clone()))
        .unwrap_or(Value::Object(Map::new()))
}

fn read_non_null_value(value: Option<&Value>) -> Option<Value> {
    value.filter(|candidate| !candidate.is_null()).cloned()
}

pub(crate) fn extract_governed_request_controls(
    request_obj: Option<&Map<String, Value>>,
) -> GovernedRequestControls {
    let parameters = read_parameters(request_obj);
    let parameter_obj = parameters.as_object();

    let tool_choice = read_non_null_value(parameter_obj.and_then(|obj| obj.get("tool_choice")))
        .or_else(|| read_non_null_value(request_obj.and_then(|obj| obj.get("tool_choice"))));
    let parallel_tool_calls =
        read_non_null_value(parameter_obj.and_then(|obj| obj.get("parallel_tool_calls")))
            .or_else(|| {
                read_non_null_value(request_obj.and_then(|obj| obj.get("parallel_tool_calls")))
            });
    let stream = parameter_obj
        .and_then(|obj| obj.get("stream"))
        .and_then(|v| v.as_bool())
        .or_else(|| {
            request_obj
                .and_then(|obj| obj.get("stream"))
                .and_then(|v| v.as_bool())
        })
        .unwrap_or(false);

    GovernedRequestControls {
        parameters,
        tool_choice,
        parallel_tool_calls,
        stream,
    }
}
