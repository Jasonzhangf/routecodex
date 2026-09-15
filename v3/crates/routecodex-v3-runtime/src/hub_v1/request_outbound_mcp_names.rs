use serde_json::{Map, Value};

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
