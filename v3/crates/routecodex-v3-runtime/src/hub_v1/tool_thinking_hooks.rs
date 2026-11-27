use super::V3HubRelayRequestError;
use serde_json::{json, Value};
use std::collections::BTreeSet;

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct V3ToolThinkingTurnContext {
    enabled: bool,
    original_custom_tool_names: BTreeSet<String>,
}

impl V3ToolThinkingTurnContext {
    pub(crate) fn disabled() -> Self {
        Self::default()
    }

    pub(crate) fn enabled(original_custom_tool_names: BTreeSet<String>) -> Self {
        Self {
            enabled: true,
            original_custom_tool_names,
        }
    }

    pub(crate) fn enabled_flag(&self) -> bool {
        self.enabled
    }

    pub(crate) fn is_original_custom_tool(&self, name: &str) -> bool {
        self.original_custom_tool_names.contains(name)
    }

    pub(crate) fn original_custom_tool_names(&self) -> Option<&BTreeSet<String>> {
        self.enabled.then_some(&self.original_custom_tool_names)
    }
}

pub(crate) fn inject_v3_tool_thinking_guidance_at_req04(
    payload: &mut Value,
    current_payload_start: usize,
    enabled: bool,
) -> Result<(), V3HubRelayRequestError> {
    let _ =
        compile_v3_tool_thinking_turn_context_at_req04(payload, current_payload_start, enabled)?;
    Ok(())
}

pub(crate) fn compile_v3_tool_thinking_turn_context_at_req04(
    payload: &mut Value,
    current_payload_start: usize,
    enabled: bool,
) -> Result<V3ToolThinkingTurnContext, V3HubRelayRequestError> {
    if !enabled || payload.get("contents").is_some() || payload.get("system_instruction").is_some()
    {
        return Ok(V3ToolThinkingTurnContext::disabled());
    }
    inject_v3_tool_thinking_fields_into_tool_schemas(payload)
        .map_err(|reason| V3HubRelayRequestError::ToolThinkingSchemaInvalid { reason })?;
    let original_custom_tool_names = wrap_v3_custom_tools_at_req04(payload)?;
    if let Some(messages) = payload.get("messages").and_then(Value::as_array) {
        if current_payload_start > messages.len() {
            return Err(V3HubRelayRequestError::CurrentPayloadBoundaryInvalid {
                start: current_payload_start,
                len: messages.len(),
            });
        }
    }
    Ok(V3ToolThinkingTurnContext::enabled(
        original_custom_tool_names,
    ))
}

fn wrap_v3_custom_tools_at_req04(
    payload: &mut Value,
) -> Result<BTreeSet<String>, V3HubRelayRequestError> {
    let Some(tools) = payload.get_mut("tools").and_then(Value::as_array_mut) else {
        return Ok(BTreeSet::new());
    };
    let mut names = BTreeSet::new();
    for (index, tool) in tools.iter_mut().enumerate() {
        let Some(row) = tool.as_object() else {
            continue;
        };
        if row.get("type").and_then(Value::as_str) != Some("custom") {
            continue;
        }
        let name = row
            .get("name")
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| V3HubRelayRequestError::ToolThinkingSchemaInvalid {
                reason: format!("custom tool at $.tools[{index}] has no non-empty name"),
            })?
            .to_string();
        if name.eq_ignore_ascii_case("apply_patch") {
            continue;
        }
        let mut function = serde_json::Map::new();
        function.insert("name".to_string(), Value::String(name.clone()));
        if let Some(description) = row.get("description") {
            function.insert("description".to_string(), description.clone());
        }
        function.insert(
            "parameters".to_string(),
            json!({
                "type":"object",
                "properties":{
                    "input":{"type":"string"},
                    "reason":{"type":"string","minLength":1,"maxLength":50},
                    "goal_alignment_confidence":{"type":"integer","minimum":0,"maximum":100}
                },
                "required":["input","reason","goal_alignment_confidence"],
                "additionalProperties":false
            }),
        );
        *tool = json!({"type":"function","function":function});
        names.insert(name);
    }
    Ok(names)
}

pub(crate) fn current_v3_tool_thinking_payload_start(payload: &Value) -> Result<usize, String> {
    for field in ["messages", "input"] {
        let Some(items) = payload.get(field).and_then(Value::as_array) else {
            continue;
        };
        return items
            .iter()
            .rposition(|item| item.get("role").and_then(Value::as_str) == Some("user"))
            .ok_or_else(|| format!("Responses {field} array has no current user message"));
    }
    Ok(0)
}

pub(crate) fn is_v3_tool_thinking_output_continuation(payload: &Value) -> bool {
    payload
        .get("input")
        .and_then(Value::as_array)
        .is_some_and(|items| {
            !items.is_empty()
                && items.iter().all(|item| {
                    matches!(
                        item.get("type").and_then(Value::as_str),
                        Some(
                            "function_call_output" | "custom_tool_call_output" | "tool_call_output"
                        )
                    )
                })
        })
}

fn inject_v3_tool_thinking_fields_into_tool_schemas(payload: &mut Value) -> Result<(), String> {
    let Some(tools) = payload.get_mut("tools").and_then(Value::as_array_mut) else {
        return Ok(());
    };
    for tool in tools {
        inject_v3_tool_thinking_fields_into_tool(tool)?;
    }
    Ok(())
}

fn inject_v3_tool_thinking_fields_into_tool(tool: &mut Value) -> Result<(), String> {
    for field in ["input_schema", "parameters"] {
        if let Some(schema) = tool.get_mut(field) {
            inject_v3_tool_thinking_fields_into_schema(schema)?;
        }
    }
    if let Some(schema) = tool
        .get_mut("function")
        .and_then(Value::as_object_mut)
        .and_then(|function| function.get_mut("parameters"))
    {
        inject_v3_tool_thinking_fields_into_schema(schema)?;
    }
    Ok(())
}

pub(super) fn inject_v3_tool_thinking_fields_into_schema(schema: &mut Value) -> Result<(), String> {
    let Some(schema) = schema.as_object_mut() else {
        return Err("tool-thinking schema must be an object".to_string());
    };
    if let Some(properties) = schema.get("properties") {
        let properties = properties
            .as_object()
            .ok_or_else(|| "tool-thinking schema properties must be an object".to_string())?;
        if properties.contains_key("reason") || properties.contains_key("goal_alignment_confidence")
        {
            return Ok(());
        }
    }
    if let Some(required) = schema.get("required") {
        if !required.is_array() {
            return Err("tool-thinking schema required must be an array".to_string());
        }
    }
    if !schema.contains_key("properties") {
        schema.insert("properties".to_string(), json!({}));
    }
    if !schema.contains_key("required") {
        schema.insert("required".to_string(), json!([]));
    }
    let properties = schema
        .get_mut("properties")
        .and_then(Value::as_object_mut)
        .expect("validated properties");
    properties.insert(
        "reason".to_string(),
        json!({"type":"string","minLength":1,"maxLength":50}),
    );
    properties.insert(
        "goal_alignment_confidence".to_string(),
        json!({"type":"integer","minimum":0,"maximum":100}),
    );
    let required = schema
        .get_mut("required")
        .and_then(Value::as_array_mut)
        .expect("validated required");
    for field in ["reason", "goal_alignment_confidence"] {
        if !required.iter().any(|value| value.as_str() == Some(field)) {
            required.push(Value::String(field.to_string()));
        }
    }
    Ok(())
}
