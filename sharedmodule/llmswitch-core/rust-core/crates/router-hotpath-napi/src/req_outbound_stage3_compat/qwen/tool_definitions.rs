use serde_json::{Map, Value};

fn read_trimmed_string(value: Option<&Value>) -> Option<String> {
    let raw = value.and_then(|v| v.as_str())?;
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    Some(trimmed.to_string())
}

fn has_exec_command_tool(tools: Option<&Value>) -> bool {
    tools
        .and_then(|v| v.as_array())
        .map(|rows| {
            rows.iter().any(|item| {
                item.as_object()
                    .and_then(|obj| {
                        obj.get("function")
                            .and_then(|v| v.as_object())
                            .or(Some(obj))
                    })
                    .and_then(|obj| read_trimmed_string(obj.get("name")))
                    .map(|name| name.eq_ignore_ascii_case("exec_command"))
                    .unwrap_or(false)
            })
        })
        .unwrap_or(false)
}

fn append_description(existing: Option<&Value>, extra: &str) -> Value {
    let base = read_trimmed_string(existing).unwrap_or_default();
    if base.contains(extra) {
        return Value::String(base);
    }
    if base.is_empty() {
        Value::String(extra.to_string())
    } else {
        Value::String(format!("{} {}", base, extra))
    }
}

fn append_property_description(prop: &mut Map<String, Value>, extra: &str) {
    let merged = append_description(prop.get("description"), extra);
    prop.insert("description".to_string(), merged);
}

pub(crate) fn normalize_qwen_family_tool_definitions(root: &Map<String, Value>) -> Option<Value> {
    let tools = root.get("tools")?.as_array()?;
    let mut changed = false;
    let has_exec_command = has_exec_command_tool(root.get("tools"));
    let mut next_tools = Vec::with_capacity(tools.len());

    for item in tools {
        let Some(item_obj) = item.as_object() else {
            next_tools.push(item.clone());
            continue;
        };
        let mut next_item = item_obj.clone();
        let Some(function_obj) = item_obj
            .get("function")
            .and_then(|v| v.as_object())
            .cloned()
        else {
            next_tools.push(Value::Object(next_item));
            continue;
        };

        let mut next_function = function_obj.clone();
        let name = read_trimmed_string(next_function.get("name")).unwrap_or_default();
        let desc_extra = if name.eq_ignore_ascii_case("exec_command") {
            Some(
                "Use only `cmd` as one shell-command string. Preferred shape: `bash -lc '...'`. Call the tool directly instead of narrating a plan.",
            )
        } else if name.eq_ignore_ascii_case("apply_patch") {
            Some(
                "Use only `patch`, as one string containing the complete `*** Begin Patch` ... `*** End Patch` envelope. Call the tool directly. For new files, use `*** Add File:` with added lines only.",
            )
        } else if name.eq_ignore_ascii_case("update_plan") {
            Some(
                "Use `plan` plus optional `explanation`. Do not use `steps`. Each plan item must contain `step` and `status`.",
            )
        } else if name.eq_ignore_ascii_case("write_stdin") {
            Some(
                "Use `session_id` as a number and optional `chars` as a string. Keep the field names exact.",
            )
        } else if !name.is_empty() {
            Some(
                "Use the exact tool name and provide a flat `input` object that matches this schema. Call the tool directly when needed.",
            )
        } else {
            None
        };
        if let Some(extra) = desc_extra {
            let merged = append_description(next_function.get("description"), extra);
            if merged
                != next_function
                    .get("description")
                    .cloned()
                    .unwrap_or(Value::Null)
            {
                next_function.insert("description".to_string(), merged);
                changed = true;
            }
        }

        if let Some(params) = next_function
            .get_mut("parameters")
            .and_then(|v| v.as_object_mut())
        {
            if let Some(properties) = params.get_mut("properties").and_then(|v| v.as_object_mut()) {
                if let Some(cmd_prop) = properties.get_mut("cmd").and_then(|v| v.as_object_mut()) {
                    let before = cmd_prop.get("description").cloned().unwrap_or(Value::Null);
                    append_property_description(cmd_prop, "Single command string only.");
                    if cmd_prop.get("description").cloned().unwrap_or(Value::Null) != before {
                        changed = true;
                    }
                }
                if let Some(patch_prop) =
                    properties.get_mut("patch").and_then(|v| v.as_object_mut())
                {
                    let before = patch_prop
                        .get("description")
                        .cloned()
                        .unwrap_or(Value::Null);
                    append_property_description(
                        patch_prop,
                        "Single patch string only, including the full `*** Begin Patch` ... `*** End Patch` envelope.",
                    );
                    if patch_prop
                        .get("description")
                        .cloned()
                        .unwrap_or(Value::Null)
                        != before
                    {
                        changed = true;
                    }
                }
                if let Some(plan_prop) = properties.get_mut("plan").and_then(|v| v.as_object_mut())
                {
                    let before = plan_prop.get("description").cloned().unwrap_or(Value::Null);
                    append_property_description(
                        plan_prop,
                        "Required array. Do not rename this field to `steps`.",
                    );
                    if plan_prop.get("description").cloned().unwrap_or(Value::Null) != before {
                        changed = true;
                    }
                }
                if let Some(session_prop) = properties
                    .get_mut("session_id")
                    .and_then(|v| v.as_object_mut())
                {
                    let before = session_prop
                        .get("description")
                        .cloned()
                        .unwrap_or(Value::Null);
                    append_property_description(session_prop, "Numeric exec session id only.");
                    if session_prop
                        .get("description")
                        .cloned()
                        .unwrap_or(Value::Null)
                        != before
                    {
                        changed = true;
                    }
                }
                if let Some(chars_prop) =
                    properties.get_mut("chars").and_then(|v| v.as_object_mut())
                {
                    let before = chars_prop
                        .get("description")
                        .cloned()
                        .unwrap_or(Value::Null);
                    append_property_description(chars_prop, "Optional stdin text string only.");
                    if chars_prop
                        .get("description")
                        .cloned()
                        .unwrap_or(Value::Null)
                        != before
                    {
                        changed = true;
                    }
                }
            }
            if has_exec_command && !params.contains_key("x-routecodex-text-tool-hint") {
                params.insert(
                    "x-routecodex-text-tool-hint".to_string(),
                    Value::String(
                        "Text-tool provider: keep tool names exact; call tools directly; for exec_command use only input.cmd."
                            .to_string(),
                    ),
                );
                changed = true;
            }
        }

        next_item.insert("function".to_string(), Value::Object(next_function));
        next_tools.push(Value::Object(next_item));
    }

    if changed {
        Some(Value::Array(next_tools))
    } else {
        None
    }
}
