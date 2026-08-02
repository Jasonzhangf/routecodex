use serde_json::{json, Map, Value};

pub(super) fn anthropic_tool_as_responses_function_tool(tool: &Map<String, Value>) -> Value {
    let mut output = Map::new();
    output.insert("type".to_string(), Value::String("function".to_string()));
    output.insert(
        "name".to_string(),
        tool.get("name").cloned().unwrap_or(Value::Null),
    );
    if let Some(description) = tool.get("description") {
        output.insert("description".to_string(), description.clone());
    }
    output.insert(
        "parameters".to_string(),
        tool.get("input_schema")
            .cloned()
            .unwrap_or_else(|| json!({"type":"object"})),
    );
    Value::Object(output)
}

pub(super) fn anthropic_tool_choice_as_responses_tool_choice(value: &Value) -> Value {
    let Some(object) = value.as_object() else {
        return value.to_owned();
    };
    if object.get("type").and_then(Value::as_str) == Some("tool") {
        if let Some(name) = object.get("name").and_then(Value::as_str) {
            return json!({"type":"function","name":name});
        }
    }
    value.to_owned()
}
