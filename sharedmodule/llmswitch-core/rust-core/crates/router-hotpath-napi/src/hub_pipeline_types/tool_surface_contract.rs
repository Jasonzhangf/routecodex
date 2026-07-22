use serde_json::{Map, Value};

#[derive(Debug, Clone, Copy)]
pub(crate) enum ToolNamespacePolicy {
    AllowSemanticNamespace,
    ForbidProviderWireNamespace,
}

pub(crate) fn assert_tool_surface_contract(
    value: &Value,
    node_name: &str,
    policy: ToolNamespacePolicy,
) -> Result<(), String> {
    walk_value(value, node_name, policy, "$")
}

fn walk_value(
    value: &Value,
    node_name: &str,
    policy: ToolNamespacePolicy,
    path: &str,
) -> Result<(), String> {
    match value {
        Value::Object(object) => {
            validate_tool_like_object(object, node_name, policy, path)?;
            validate_tool_calls_array(object.get("tool_calls"), node_name, path)?;
            validate_tools_array(object.get("tools"), node_name, policy, path)?;
            validate_responses_function_call_item(object, node_name, path)?;
            validate_required_action_tool_calls(object, node_name, path)?;
            for (key, child) in object {
                let child_path = if path == "$" {
                    format!("$.{key}")
                } else {
                    format!("{path}.{key}")
                };
                walk_value(child, node_name, policy, child_path.as_str())?;
            }
        }
        Value::Array(items) => {
            for (index, child) in items.iter().enumerate() {
                walk_value(
                    child,
                    node_name,
                    policy,
                    format!("{path}[{index}]").as_str(),
                )?;
            }
        }
        _ => {}
    }
    Ok(())
}

fn validate_tools_array(
    tools: Option<&Value>,
    node_name: &str,
    policy: ToolNamespacePolicy,
    path: &str,
) -> Result<(), String> {
    let Some(tools) = tools else {
        return Ok(());
    };
    let Some(entries) = tools.as_array() else {
        return Err(format!(
            "{node_name} tools at {path}.tools must be an array"
        ));
    };
    for (index, entry) in entries.iter().enumerate() {
        let tool_path = format!("{path}.tools[{index}]");
        let Some(row) = entry.as_object() else {
            return Err(format!("{node_name} tool at {tool_path} must be an object"));
        };
        validate_tool_definition(row, node_name, policy, tool_path.as_str())?;
    }
    Ok(())
}

fn validate_tool_like_object(
    object: &Map<String, Value>,
    node_name: &str,
    policy: ToolNamespacePolicy,
    path: &str,
) -> Result<(), String> {
    let item_type = object
        .get("type")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or("");
    if item_type.eq_ignore_ascii_case("namespace") {
        validate_namespace_tool(object, node_name, policy, path)?;
    }
    Ok(())
}

fn validate_tool_definition(
    row: &Map<String, Value>,
    node_name: &str,
    policy: ToolNamespacePolicy,
    path: &str,
) -> Result<(), String> {
    let tool_type = row
        .get("type")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or("function");
    if tool_type.eq_ignore_ascii_case("namespace") {
        return validate_namespace_tool(row, node_name, policy, path);
    }
    if is_builtin_tool_type(tool_type) {
        return Ok(());
    }
    if tool_type.eq_ignore_ascii_case("custom") {
        let has_name = row
            .get("name")
            .and_then(Value::as_str)
            .map(|name| !name.trim().is_empty())
            .unwrap_or(false);
        if !has_name {
            return Err(format!(
                "{node_name} custom tool at {path}.name must be a string"
            ));
        }
        return Ok(());
    }
    if !tool_type.eq_ignore_ascii_case("function") {
        return Err(format!(
            "{node_name} tool at {path}.type must be function, namespace, or supported builtin"
        ));
    }
    let has_name = row
        .get("function")
        .and_then(Value::as_object)
        .and_then(|function| function.get("name"))
        .or_else(|| row.get("name"))
        .and_then(Value::as_str)
        .map(|name| !name.trim().is_empty())
        .unwrap_or(false);
    if !has_name {
        return Err(format!(
            "{node_name} function tool at {path} must have a name"
        ));
    }
    Ok(())
}

fn validate_namespace_tool(
    row: &Map<String, Value>,
    node_name: &str,
    policy: ToolNamespacePolicy,
    path: &str,
) -> Result<(), String> {
    if matches!(policy, ToolNamespacePolicy::ForbidProviderWireNamespace) {
        return Err(format!(
            "{node_name} must not carry namespace tool aggregate at {path}"
        ));
    }
    let has_name = row
        .get("name")
        .and_then(Value::as_str)
        .map(|name| !name.trim().is_empty())
        .unwrap_or(false);
    if !has_name {
        return Err(format!(
            "{node_name} namespace tool at {path}.name must be a string"
        ));
    }
    let Some(children) = row.get("tools").and_then(Value::as_array) else {
        return Err(format!(
            "{node_name} namespace tool at {path}.tools must be an array"
        ));
    };
    if children.is_empty() {
        return Err(format!(
            "{node_name} namespace tool at {path}.tools must not be empty"
        ));
    }
    for (index, child) in children.iter().enumerate() {
        let child_path = format!("{path}.tools[{index}]");
        let Some(child_row) = child.as_object() else {
            return Err(format!(
                "{node_name} namespace child at {child_path} must be an object"
            ));
        };
        let child_type = child_row
            .get("type")
            .and_then(Value::as_str)
            .map(str::trim)
            .unwrap_or("function");
        if !child_type.eq_ignore_ascii_case("function") {
            return Err(format!(
                "{node_name} namespace child at {child_path}.type must be function"
            ));
        }
        let has_child_name = child_row
            .get("function")
            .and_then(Value::as_object)
            .and_then(|function| function.get("name"))
            .or_else(|| child_row.get("name"))
            .and_then(Value::as_str)
            .map(|name| !name.trim().is_empty())
            .unwrap_or(false);
        if !has_child_name {
            return Err(format!(
                "{node_name} namespace child at {child_path} must have a name"
            ));
        }
    }
    Ok(())
}

fn validate_tool_calls_array(
    tool_calls: Option<&Value>,
    node_name: &str,
    path: &str,
) -> Result<(), String> {
    let Some(tool_calls) = tool_calls else {
        return Ok(());
    };
    let Some(entries) = tool_calls.as_array() else {
        return Err(format!(
            "{node_name} tool_calls at {path}.tool_calls must be an array"
        ));
    };
    for (index, entry) in entries.iter().enumerate() {
        let call_path = format!("{path}.tool_calls[{index}]");
        let Some(row) = entry.as_object() else {
            return Err(format!(
                "{node_name} tool_call at {call_path} must be an object"
            ));
        };
        let call_type = row
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or("function");
        if !call_type.eq_ignore_ascii_case("function") {
            return Err(format!(
                "{node_name} tool_call at {call_path}.type must be function"
            ));
        }
        let has_name = row
            .get("function")
            .and_then(Value::as_object)
            .and_then(|function| function.get("name"))
            .and_then(Value::as_str)
            .map(|name| !name.trim().is_empty())
            .unwrap_or(false);
        if !has_name {
            return Err(format!(
                "{node_name} tool_call at {call_path}.function.name must be a string"
            ));
        }
    }
    Ok(())
}

fn validate_responses_function_call_item(
    object: &Map<String, Value>,
    node_name: &str,
    path: &str,
) -> Result<(), String> {
    let item_type = object.get("type").and_then(Value::as_str).unwrap_or("");
    if item_type != "function_call" {
        return Ok(());
    }
    let has_name = object
        .get("name")
        .and_then(Value::as_str)
        .map(|name| !name.trim().is_empty())
        .unwrap_or(false);
    if !has_name {
        return Err(format!(
            "{node_name} function_call at {path}.name must be a string"
        ));
    }
    let has_call_id = object
        .get("call_id")
        .and_then(Value::as_str)
        .map(|call_id| !call_id.trim().is_empty())
        .unwrap_or(false);
    if !has_call_id {
        return Err(format!(
            "{node_name} function_call at {path}.call_id must be a string"
        ));
    }
    Ok(())
}

fn validate_required_action_tool_calls(
    object: &Map<String, Value>,
    node_name: &str,
    path: &str,
) -> Result<(), String> {
    let Some(required_action) = object.get("required_action").and_then(Value::as_object) else {
        return Ok(());
    };
    let Some(submit) = required_action
        .get("submit_tool_outputs")
        .and_then(Value::as_object)
    else {
        return Ok(());
    };
    let Some(calls) = submit.get("tool_calls") else {
        return Ok(());
    };
    validate_tool_calls_array(
        Some(calls),
        node_name,
        format!("{path}.required_action.submit_tool_outputs").as_str(),
    )
}

pub(crate) fn is_builtin_tool_type(tool_type: &str) -> bool {
    let tool_type = tool_type.trim().to_ascii_lowercase();
    matches!(
        tool_type.as_str(),
        "web_search"
            | "web_search_preview"
            | "code_interpreter"
            | "computer_use_preview"
            | "image_generation"
            | "tool_search"
    )
}

#[cfg(test)]
mod tests {
    use super::{assert_tool_surface_contract, ToolNamespacePolicy};
    use serde_json::json;

    #[test]
    fn accepts_responses_custom_tool_definition() {
        let payload = json!({
            "tools": [
                {
                    "type": "custom",
                    "name": "apply_patch",
                    "description": "Use apply_patch",
                    "format": {
                        "type": "grammar",
                        "syntax": "lark",
                        "definition": "start: begin_patch hunk+ end_patch\nbegin_patch: \"*** Begin Patch\" LF\nend_patch: \"*** End Patch\" LF?\nhunk: add_hunk | delete_hunk | update_hunk\nadd_hunk: \"*** Add File: \" filename LF add_line+\ndelete_hunk: \"*** Delete File: \" filename LF\nupdate_hunk: \"*** Update File: \" filename LF change_move? change?\nfilename: /(.+)/\nadd_line: \"+\" /(.*)/ LF\nchange_move: \"*** Move to: \" filename LF\nchange: (change_context | change_line)+ eof_line?\nchange_context: (\"@@\" | \"@@ \" /(.+)/) LF\nchange_line: (\"+\" | \"-\" | \" \") /(.*)/ LF\neof_line: \"*** End of File\" LF\n%import common.LF"
                    }
                }
            ]
        });

        let result = assert_tool_surface_contract(
            &payload,
            "HubReqInbound02Standardized",
            ToolNamespacePolicy::AllowSemanticNamespace,
        );
        assert!(result.is_ok(), "{result:?}");
    }

    #[test]
    fn accepts_responses_tool_search_builtin_definition() {
        let payload = json!({
            "tools": [
                {
                    "type": "tool_search",
                    "execution": "client",
                    "description": "Search deferred tools",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "query": { "type": "string" }
                        },
                        "required": ["query"],
                        "additionalProperties": false
                    }
                }
            ]
        });

        let result = assert_tool_surface_contract(
            &payload,
            "HubReqInbound02Standardized",
            ToolNamespacePolicy::AllowSemanticNamespace,
        );
        assert!(result.is_ok(), "{result:?}");
    }
}
