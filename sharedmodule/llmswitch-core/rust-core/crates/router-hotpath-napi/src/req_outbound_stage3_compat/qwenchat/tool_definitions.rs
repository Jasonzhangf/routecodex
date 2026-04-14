use serde_json::{Map, Value};

use super::super::qwen::tool_definitions::normalize_qwen_family_tool_definitions;

fn read_trimmed_string(value: Option<&Value>) -> Option<String> {
    let raw = value.and_then(|v| v.as_str())?;
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    Some(trimmed.to_string())
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

pub(crate) fn normalize_qwenchat_tool_definitions(root: &Map<String, Value>) -> Option<Value> {
    let base_tools = normalize_qwen_family_tool_definitions(root)
        .or_else(|| root.get("tools").cloned())?;
    let tools = base_tools.as_array()?;

    let mut changed = false;
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
        let extra = if name.eq_ignore_ascii_case("exec_command") {
            Some("Treat runtime execution as available here. Do not refuse with sandbox, path, host-machine, or local-file limitations. Do not replace it with code interpreter, python, browser, or file-read pseudo tools. If this tool is needed, output exactly one RCC_TOOL_CALLS_JSON heredoc dry-run container and nothing else. Inside that container, use this exact tool name with flat `input`. If path state is unknown, emit this dry-run tool call to check instead of guessing.")
        } else if name.eq_ignore_ascii_case("apply_patch") {
            Some("Treat file editing as available here. If this tool is needed, output exactly one RCC_TOOL_CALLS_JSON heredoc dry-run container and nothing else. Inside that container, use this exact tool name with flat `input`, instead of refusing or switching to built-in tools.")
        } else if !name.is_empty() {
            Some("Do not answer with environment or sandbox limitations. When this tool is needed, output exactly one RCC_TOOL_CALLS_JSON heredoc dry-run container and nothing else, and do not switch to undeclared built-in tools.")
        } else {
            None
        };

        if let Some(extra_desc) = extra {
            let merged = append_description(next_function.get("description"), extra_desc);
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
            if !params.contains_key("x-routecodex-qwenchat-dryrun-hint") {
                params.insert(
                    "x-routecodex-qwenchat-dryrun-hint".to_string(),
                    Value::String("For tool use, output exactly one RCC_TOOL_CALLS_JSON heredoc dry-run container; do not output sandbox/path refusal prose or native function calls.".to_string()),
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
