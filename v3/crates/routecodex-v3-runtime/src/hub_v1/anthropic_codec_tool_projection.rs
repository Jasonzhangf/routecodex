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
    if let Some((original_kind, original_name, original_namespace)) =
        context.successful_attempt_tool_identity(name)
    {
        if original_kind == "tool_search" {
            return Ok(
                super::responses_relay_runtime::project_v3_responses_tool_search_call(
                    call_id,
                    input.clone(),
                ),
            );
        }
        if let Some(original_name) = original_name {
            match original_kind {
                "custom" => {
                    return custom_tool_call_from_input(
                        call_id,
                        original_name,
                        original_namespace,
                        input,
                    )
                }
                "function" => {
                    return function_call_from_input(
                        call_id,
                        original_name,
                        original_namespace,
                        input,
                    )
                }
                _ => {}
            }
        }
    }
    if let Some(client_name) = context.governed_custom_tool_client_name(name) {
        let (client_name, namespace) = context
            .namespaced_custom_tool_identity(name)
            .map(|(namespace, tool_name)| (tool_name, Some(Value::String(namespace.to_string()))))
            .unwrap_or((client_name, None));
        return custom_tool_call_from_input(call_id, client_name, namespace.as_ref(), input);
    }
    let mut output = function_call_from_input(call_id, name, None, input)?;
    if let Some(object) = output.as_object_mut() {
        super::request_outbound_mcp_names::restore_responses_mcp_namespace(
            object,
            context.mcp_tool_identities(),
        );
    }
    Ok(output)
}

fn custom_tool_call_from_input(
    call_id: &str,
    name: &str,
    namespace: Option<&Value>,
    input: &Value,
) -> Result<Value, V3AnthropicCodecError> {
    let (raw, extensions) = custom_tool_input(input)?;
    let mut output = Map::from_iter([
        (
            "type".to_string(),
            Value::String("custom_tool_call".to_string()),
        ),
        ("call_id".to_string(), Value::String(call_id.to_owned())),
        ("name".to_string(), Value::String(name.to_owned())),
    ]);
    if let Some(namespace) = namespace {
        output.insert("namespace".to_string(), namespace.clone());
    }
    for (key, value) in extensions {
        output.insert(key, value);
    }
    output.insert("input".to_string(), Value::String(raw));
    Ok(Value::Object(output))
}

fn function_call_from_input(
    call_id: &str,
    name: &str,
    namespace: Option<&Value>,
    input: &Value,
) -> Result<Value, V3AnthropicCodecError> {
    let mut output = Map::from_iter([
        (
            "type".to_string(),
            Value::String("function_call".to_string()),
        ),
        ("call_id".to_string(), Value::String(call_id.to_owned())),
        ("name".to_string(), Value::String(name.to_owned())),
        (
            "arguments".to_string(),
            Value::String(serde_json::to_string(input).map_err(|_| {
                V3AnthropicCodecError::MalformedField {
                    field: "tool_use.input",
                }
            })?),
        ),
    ]);
    if let Some(namespace) = namespace {
        output.insert("namespace".to_string(), namespace.clone());
    }
    Ok(Value::Object(output))
}

fn custom_tool_input(
    input: &Value,
) -> Result<(String, Vec<(String, Value)>), V3AnthropicCodecError> {
    if let Some(text) = input.as_str() {
        return Ok((text.to_string(), Vec::new()));
    }
    let Some(wrapper) = input
        .as_object()
        .filter(|value| value.contains_key("input"))
    else {
        return serde_json::to_string(input)
            .map(|raw| (raw, Vec::new()))
            .map_err(|_| V3AnthropicCodecError::MalformedField {
                field: "custom tool_use.input",
            });
    };
    if !wrapper.keys().all(|key| {
        matches!(
            key.as_str(),
            "input" | "reason" | "goal_alignment_confidence" | "model_id"
        )
    }) || wrapper.get("input").and_then(Value::as_str).is_none()
    {
        return Err(V3AnthropicCodecError::MalformedField {
            field: "custom tool_use.input",
        });
    }
    let raw = wrapper
        .get("input")
        .and_then(Value::as_str)
        .expect("validated custom wrapper input")
        .to_owned();
    let extensions = ["reason", "goal_alignment_confidence", "model_id"]
        .into_iter()
        .filter_map(|key| {
            wrapper
                .get(key)
                .map(|value| (key.to_string(), value.clone()))
        })
        .collect();
    Ok((raw, extensions))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn flattened_mcp_tool_use_restores_namespace_for_responses_client() {
        let context = V3AnthropicResponsesProjectionContext::from_chat_canonical_request(&json!({
            "tools": [{"type": "function", "name": "mcp__mcpx__workspace"}]
        }))
        .expect("projection context");
        let call = anthropic_tool_use_as_responses_call(
            &json!({
                "type": "tool_use",
                "id": "call_mcpx_workspace",
                "name": "mcp__mcpx__workspace",
                "input": {}
            }),
            &context,
        )
        .expect("flattened MCP tool_use must restore namespace");

        assert_eq!(call["type"], "function_call");
        assert_eq!(call["namespace"], "mcp__mcpx");
        assert_eq!(call["name"], "workspace");
        assert_eq!(call["call_id"], "call_mcpx_workspace");
    }

    #[test]
    fn namespace_custom_tool_use_restores_declared_client_identity_and_raw_input() {
        let context = V3AnthropicResponsesProjectionContext::from_chat_canonical_request(&json!({
            "tools": [{"type": "namespace", "name": "functions", "tools": [
                {"type": "custom", "name": "exec", "format": {"type": "text"}}
            ]}]
        }))
        .expect("projection context");
        let call = anthropic_tool_use_as_responses_call(
            &json!({"type": "tool_use", "id": "call_exec", "name": "functions__exec", "input": {"input": "pwd"}}),
            &context,
        )
        .expect("namespace custom tool_use must restore the client declaration");
        assert_eq!(call["type"], "custom_tool_call");
        assert_eq!(call["namespace"], "functions");
        assert_eq!(call["name"], "exec");
        assert_eq!(call["input"], "pwd");
        assert_eq!(call["call_id"], "call_exec");
    }

    #[test]
    fn nested_namespace_custom_tool_use_restores_the_declared_client_identity() {
        let context = V3AnthropicResponsesProjectionContext::from_chat_canonical_request(&json!({
            "tools": [{"type":"namespace","name":"functions","tools":[
                {"type":"namespace","name":"mcp__mcpx","tools":[
                    {"type":"custom","name":"exec","format":{"type":"text"}}
                ]}
            ]}]
        }))
        .expect("projection context");
        let call = anthropic_tool_use_as_responses_call(
            &json!({"type":"tool_use","id":"call_nested","name":"mcp__mcpx__exec","input":{"input":"pwd"}}),
            &context,
        ).expect("nested custom tool must restore client name");
        assert_eq!(call["type"], "custom_tool_call");
        assert_eq!(call["namespace"], "functions.mcp__mcpx");
        assert_eq!(call["name"], "exec");
        assert_eq!(call["input"], "pwd");
    }

    #[test]
    fn top_level_custom_tool_with_dotted_name_stays_top_level() {
        let context = V3AnthropicResponsesProjectionContext::from_chat_canonical_request(&json!({
            "tools": [{"type": "custom", "name": "functions.exec"}]
        }))
        .expect("projection context");
        let call = anthropic_tool_use_as_responses_call(
            &json!({"type": "tool_use", "id": "call_dotted", "name": "functions.exec", "input": {"input": "pwd"}}),
            &context,
        )
        .expect("top-level custom tool name must be preserved");
        assert_eq!(call["name"], "functions.exec");
        assert!(call.get("namespace").is_none());
        assert_eq!(call["call_id"], "call_dotted");
        assert_eq!(call["input"], "pwd");
    }

    #[test]
    fn governed_custom_tool_accepts_unwrapped_native_input_after_guidance_removal() {
        let context = V3AnthropicResponsesProjectionContext::from_chat_canonical_request(&json!({
            "tools": [{"type": "custom", "name": "apply_patch"}]
        }))
        .expect("projection context");
        let call = anthropic_tool_use_as_responses_call(
            &json!({
                "type": "tool_use",
                "id": "call_native_input",
                "name": "apply_patch",
                "input": {"patch": "*** Begin Patch\n*** End Patch"}
            }),
            &context,
        )
        .expect("unwrapped custom input must remain projectable");

        assert_eq!(call["type"], "custom_tool_call");
        assert_eq!(
            call["input"],
            "{\"patch\":\"*** Begin Patch\\n*** End Patch\"}"
        );
        assert!(call.get("model_id").is_none());
    }

    #[test]
    fn governed_custom_tool_accepts_empty_native_input_after_guidance_removal() {
        let context = V3AnthropicResponsesProjectionContext::from_chat_canonical_request(&json!({
            "tools": [{"type": "custom", "name": "apply_patch"}]
        }))
        .expect("projection context");
        let call = anthropic_tool_use_as_responses_call(
            &json!({
                "type": "tool_use",
                "id": "call_empty_input",
                "name": "apply_patch",
                "input": {}
            }),
            &context,
        )
        .expect("empty native input must remain projectable");

        assert_eq!(call["type"], "custom_tool_call");
        assert_eq!(call["input"], "{}");
        assert!(call.get("model_id").is_none());
    }
}
