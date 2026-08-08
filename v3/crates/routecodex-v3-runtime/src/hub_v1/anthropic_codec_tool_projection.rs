use super::anthropic_codec::{V3AnthropicCodecError, V3AnthropicResponsesProjectionContext};
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
    // anthropic tool_choice type -> hub -> responses type（查表；未命中保持原样）
    if object.get("type").and_then(Value::as_str) == Some("tool") {
        if let Some(name) = object.get("name").and_then(Value::as_str) {
            let responses_type = crate::protocol_tables::map_value(
                crate::protocol_tables::V3TableKind::ToolChoice,
                "responses",
                "tool",
                crate::protocol_tables::V3TableDirection::Outbound,
            )
            .ok()
            .flatten()
            .unwrap_or("function");
            return json!({"type": responses_type, "name": name});
        }
    }
    value.to_owned()
}

pub(super) fn anthropic_tool_use_as_responses_call(
    part: &Value,
    context: &V3AnthropicResponsesProjectionContext,
) -> Result<Value, V3AnthropicCodecError> {
    let call_id = part
        .get("id")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or(V3AnthropicCodecError::MalformedField {
            field: "tool_use.id",
        })?;
    let name = part
        .get("name")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or(V3AnthropicCodecError::MalformedField {
            field: "tool_use.name",
        })?;
    let input = part
        .get("input")
        .ok_or(V3AnthropicCodecError::MalformedField {
            field: "tool_use.input",
        })?;
    if context.is_governed_custom_tool(name) {
        let wrapper = input
            .as_object()
            .filter(|wrapper| wrapper.len() == 1)
            .ok_or(V3AnthropicCodecError::MalformedField {
                field: "custom tool_use.input wrapper",
            })?;
        let raw = wrapper.get("input").and_then(Value::as_str).ok_or(
            V3AnthropicCodecError::MalformedField {
                field: "custom tool_use.input.input",
            },
        )?;
        return Ok(json!({
            "type":"custom_tool_call",
            "call_id":call_id,
            "name":name,
            "input":raw
        }));
    }
    Ok(json!({
        "type":"function_call",
        "call_id":call_id,
        "name":name,
        "arguments":serde_json::to_string(input)
            .map_err(|_| V3AnthropicCodecError::MalformedField { field: "tool_use.input" })?
    }))
}
