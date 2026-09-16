use provider_compat_core::namespace_tools::flatten_namespace_tool_for_provider;
use serde_json::{Map, Value};
use std::collections::HashMap;

fn provider_function_name(name: &str) -> String {
    if let Some(dot) = name.strip_prefix("mcp__").and_then(|value| value.find('.')) {
        let dot = dot + "mcp__".len();
        let mut normalized = name.to_owned();
        normalized.replace_range(dot..=dot, "__");
        normalized
    } else {
        name.to_owned()
    }
}

pub(super) fn normalize_openai_chat_message_tool_call_names(message: &mut Map<String, Value>) {
    let responses_extension = message
        .get("routecodex_chat_extension")
        .and_then(Value::as_object);
    if responses_extension.is_some_and(|extension| {
        extension
            .get("responses_tool_call_type")
            .and_then(Value::as_str)
            .is_some_and(|kind| matches!(kind, "tool_search_call" | "tool_search_output"))
            || extension
                .get("responses_tool_output_type")
                .and_then(Value::as_str)
                .is_some_and(|kind| kind == "tool_search_output")
    }) {
        return;
    }
    if let Some(tool_calls) = message.get_mut("tool_calls").and_then(Value::as_array_mut) {
        for call in tool_calls {
            let Some(call) = call.as_object_mut() else {
                continue;
            };
            if let Some(name) = call.get("name").and_then(Value::as_str) {
                call.insert(
                    "name".to_string(),
                    Value::String(provider_function_name(name)),
                );
            }
            if let Some(function) = call.get_mut("function").and_then(Value::as_object_mut) {
                if let Some(name) = function.get("name").and_then(Value::as_str) {
                    function.insert(
                        "name".to_string(),
                        Value::String(provider_function_name(name)),
                    );
                }
            }
        }
    }
    if let Some(parts) = message.get_mut("content").and_then(Value::as_array_mut) {
        for part in parts {
            let Some(part_object) = part.as_object_mut() else {
                continue;
            };
            if let Some(name) = part_object.get("name").and_then(Value::as_str) {
                part_object.insert(
                    "name".to_string(),
                    Value::String(provider_function_name(name)),
                );
            }
        }
    }
}

pub(super) fn qualify_openai_chat_missing_mcp_tool_call_names(payload: &mut Value) {
    let Some(root) = payload.as_object_mut() else {
        return;
    };
    let Some(tools) = root.get("tools").and_then(Value::as_array).cloned() else {
        return;
    };
    let Some(messages) = root.get_mut("messages").and_then(Value::as_array_mut) else {
        return;
    };
    let mut qualified_by_leaf = HashMap::<String, Option<String>>::new();
    for tool in &tools {
        if let Ok(Some(children)) = flatten_namespace_tool_for_provider("openai-chat", tool) {
            for child in children {
                if let Some(name) = provider_function_tool_name(&child) {
                    insert_provider_mcp_name(&mut qualified_by_leaf, name);
                }
            }
            continue;
        }
        if let Some(name) = provider_function_tool_name(tool) {
            insert_provider_mcp_name(&mut qualified_by_leaf, name);
        }
    }
    if qualified_by_leaf.is_empty() {
        return;
    }
    for message in messages {
        let Some(message_row) = message.as_object_mut() else {
            continue;
        };
        let Some(tool_calls) = message_row
            .get_mut("tool_calls")
            .and_then(Value::as_array_mut)
        else {
            continue;
        };
        for tool_call in tool_calls {
            let Some(tool_call_row) = tool_call.as_object_mut() else {
                continue;
            };
            if is_custom_tool_call(tool_call_row) {
                continue;
            }
            if !has_responses_item_id(tool_call_row) {
                continue;
            }
            let Some(name) = tool_call_row
                .get("function")
                .and_then(Value::as_object)
                .and_then(|function| function.get("name"))
                .and_then(Value::as_str)
                .map(str::to_owned)
            else {
                continue;
            };
            if name.starts_with("mcp__") {
                continue;
            }
            let Some(qualified) = qualified_by_leaf.get(&name).and_then(Option::as_ref) else {
                continue;
            };
            if let Some(function) = tool_call_row
                .get_mut("function")
                .and_then(Value::as_object_mut)
            {
                function.insert("name".to_string(), Value::String(qualified.clone()));
            }
        }
    }
}

fn is_custom_tool_call(tool_call: &Map<String, Value>) -> bool {
    tool_call
        .get("routecodex_chat_extension")
        .and_then(Value::as_object)
        .and_then(|extension| extension.get("responses_tool_call_type"))
        .and_then(Value::as_str)
        == Some("custom_tool_call")
}

fn has_responses_item_id(tool_call: &Map<String, Value>) -> bool {
    tool_call
        .get("routecodex_chat_extension")
        .and_then(Value::as_object)
        .and_then(|extension| extension.get("responses_item_id"))
        .and_then(Value::as_str)
        .is_some_and(|value| !value.trim().is_empty())
}

fn provider_function_tool_name(tool: &Value) -> Option<&str> {
    tool.get("function")
        .and_then(Value::as_object)
        .and_then(|function| function.get("name"))
        .and_then(Value::as_str)
        .or_else(|| tool.get("name").and_then(Value::as_str))
}

fn insert_provider_mcp_name(map: &mut HashMap<String, Option<String>>, name: &str) {
    let Some(leaf) = mcp_tool_leaf_name(name) else {
        return;
    };
    match map.get(leaf) {
        Some(Some(existing)) if existing != name => {
            map.insert(leaf.to_string(), None);
        }
        None => {
            map.insert(leaf.to_string(), Some(name.to_string()));
        }
        _ => {}
    }
}

fn mcp_tool_leaf_name(name: &str) -> Option<&str> {
    let rest = name.strip_prefix("mcp__")?;
    let (_, tool) = rest.rsplit_once("__")?;
    (!tool.is_empty()).then_some(tool)
}

pub(super) fn restore_responses_mcp_namespace(object: &mut Map<String, Value>) -> bool {
    if object.get("namespace").is_some() {
        return false;
    }
    let Some(name) = object
        .get("name")
        .and_then(Value::as_str)
        .map(str::to_owned)
    else {
        return false;
    };
    let Some(rest) = name.strip_prefix("mcp__") else {
        return false;
    };
    // Provider wire flattens a client namespace path into
    // `mcp__<server>[__<nested>...]__<tool>`: the tool is the last segment and
    // every earlier segment is namespace path. Using the last separator keeps
    // nested declarations (mcp__mcpx__workspace__read) reversible to
    // namespace `mcp__mcpx__workspace` + name `read` instead of gluing the
    // remaining path onto the tool name.
    let Some((namespace, tool)) = rest.rsplit_once("__") else {
        return false;
    };
    if namespace.is_empty() || tool.is_empty() {
        return false;
    }
    object.insert(
        "namespace".to_owned(),
        Value::String(format!("mcp__{namespace}")),
    );
    object.insert("name".to_owned(), Value::String(tool.to_owned()));
    true
}
