use napi::bindgen_prelude::Result as NapiResult;
use napi_derive::napi;
use serde_json::{Map, Value};
use std::collections::HashSet;

fn read_trimmed_string(value: Option<&Value>) -> Option<String> {
    let raw = value
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    if raw.is_empty() {
        return None;
    }
    Some(raw)
}

fn read_string_array_command(value: Option<&Value>) -> Option<String> {
    let parts = value.and_then(|v| v.as_array())?;
    let tokens: Vec<String> = parts
        .iter()
        .map(|item| match item {
            Value::String(v) => v.trim().to_string(),
            Value::Null => String::new(),
            other => other.to_string().trim().to_string(),
        })
        .filter(|token| !token.is_empty())
        .collect();
    if tokens.is_empty() {
        return None;
    }
    Some(tokens.join(" "))
}

fn read_command_text_value(value: Option<&Value>) -> Option<String> {
    read_trimmed_string(value).or_else(|| read_string_array_command(value))
}

fn read_nested_command_from_object(row: &Map<String, Value>) -> Option<String> {
    // Try direct fields first (most common case)
    let direct = read_command_text_value(row.get("cmd"))
        .or_else(|| read_command_text_value(row.get("command")))
        .or_else(|| read_command_text_value(row.get("script")))
        .or_else(|| read_command_text_value(row.get("toon")))
        .or_else(|| read_command_text_value(row.get("input")))
        .or_else(|| read_command_text_value(row.get("text")))
        .or_else(|| read_command_text_value(row.get("action")))
        .or_else(|| read_command_text_value(row.get("instruction")))
        .or_else(|| read_command_text_value(row.get("instructions")))
        .or_else(|| read_command_text_value(row.get("query")))
        .or_else(|| read_command_text_value(row.get("entry")));
    if direct.is_some() {
        return direct;
    }
    // Try nested objects (payload, data, args)
    row.get("payload")
        .and_then(Value::as_object)
        .and_then(read_nested_command_from_object)
        .or_else(|| row.get("data").and_then(Value::as_object).and_then(read_nested_command_from_object))
        .or_else(|| row.get("args").and_then(Value::as_object).and_then(read_nested_command_from_object))
}

fn parse_json_record(value: Option<&Value>) -> Option<Map<String, Value>> {
    match value {
        Some(Value::Object(row)) => Some(row.clone()),
        Some(Value::String(raw)) => {
            let trimmed = raw.trim();
            if trimmed.is_empty() {
                return Some(Map::new());
            }
            let parsed: Value = serde_json::from_str(trimmed).ok()?;
            parsed.as_object().cloned()
        }
        _ => None,
    }
}

fn read_command_from_args(args: &Map<String, Value>) -> Option<String> {
    let input = args.get("input");
    let direct = read_nested_command_from_object(args);
    if direct.is_some() {
        return direct;
    }
    input.and_then(Value::as_object)
        .and_then(read_nested_command_from_object)
        .or_else(|| {
            args.get("args")
                .and_then(Value::as_object)
                .and_then(read_nested_command_from_object)
        })
}

fn read_workdir_from_args(args: &Map<String, Value>) -> Option<String> {
    let input = args.get("input").and_then(|v| v.as_object());
    read_trimmed_string(args.get("workdir"))
        .or_else(|| read_trimmed_string(args.get("cwd")))
        .or_else(|| read_trimmed_string(args.get("workDir")))
        .or_else(|| input.and_then(|row| read_trimmed_string(row.get("workdir"))))
        .or_else(|| input.and_then(|row| read_trimmed_string(row.get("cwd"))))
}

fn is_invalid_shell_like_call(name: &str, arguments: Option<&Value>) -> bool {
    if !is_shell_like_tool_name(name) {
        return false;
    }
    let Some(args) = parse_json_record(arguments) else {
        return true;
    };
    read_command_from_args(&args).is_none()
}

fn collect_requested_tool_names(payload: &Value) -> HashSet<String> {
    let mut names = HashSet::new();
    let tools = payload
        .as_object()
        .and_then(|root| root.get("tools"))
        .and_then(|value| value.as_array())
        .cloned()
        .unwrap_or_default();

    for tool in tools {
        let row = match tool.as_object() {
            Some(v) => v,
            None => continue,
        };
        let fn_name = row
            .get("function")
            .and_then(|fn_node| fn_node.as_object())
            .and_then(|fn_row| read_trimmed_string(fn_row.get("name")));
        let name = fn_name.or_else(|| read_trimmed_string(row.get("name")));
        if let Some(normalized) = name {
            names.insert(normalized);
        }
    }

    names
}

fn resolve_shell_like_tool_name(raw_name: &str, requested_tool_names: &HashSet<String>) -> String {
    if requested_tool_names.is_empty() {
        return raw_name.to_string();
    }
    if requested_tool_names.contains(raw_name) {
        return raw_name.to_string();
    }
    raw_name.to_string()
}

fn is_shell_like_tool_name(raw_name: &str) -> bool {
    matches!(
        raw_name.to_ascii_lowercase().as_str(),
        "exec_command" | "shell_command" | "shell" | "bash" | "terminal"
    )
}

fn is_shell_like_tool_name_token(name: Option<String>) -> bool {
    let normalized = name.unwrap_or_default().trim().to_string();
    if normalized.is_empty() {
        return false;
    }
    is_shell_like_tool_name(normalized.as_str())
}

fn normalize_shell_like_function_call_arguments(
    raw_name: &str,
    raw_arguments: Option<&Value>,
    requested_tool_names: &HashSet<String>,
) -> Option<(String, String)> {
    if !is_shell_like_tool_name(raw_name) {
        return None;
    }

    let resolved_name = resolve_shell_like_tool_name(raw_name, requested_tool_names);
    let args = parse_json_record(raw_arguments)?;
    let cmd = read_command_from_args(&args)?;
    let mut next_args = args;
    next_args.insert("cmd".to_string(), Value::String(cmd.clone()));
    next_args.insert("command".to_string(), Value::String(cmd));
    if let Some(workdir) = read_workdir_from_args(&next_args) {
        next_args.insert("workdir".to_string(), Value::String(workdir));
    }
    next_args.remove("toon");

    let arguments = serde_json::to_string(&Value::Object(next_args))
        .unwrap_or_else(|_| "{\"cmd\":\"\",\"command\":\"\"}".to_string());
    Some((resolved_name, arguments))
}

fn normalize_message_tool_calls(
    payload: &mut Value,
    requested_tool_names: &HashSet<String>,
) {
    let Some(messages) = payload
        .as_object_mut()
        .and_then(|root| root.get_mut("messages"))
        .and_then(|node| node.as_array_mut())
    else {
        return;
    };

    for message in messages.iter_mut() {
        let Some(message_row) = message.as_object_mut() else {
            continue;
        };
        let role = read_trimmed_string(message_row.get("role"))
            .unwrap_or_default()
            .to_ascii_lowercase();
        if role != "assistant" {
            continue;
        }
        let Some(tool_calls) = message_row
            .get_mut("tool_calls")
            .and_then(|node| node.as_array_mut())
        else {
            continue;
        };

        for call in tool_calls.iter_mut() {
            let Some(call_row) = call.as_object_mut() else {
                continue;
            };
            let Some(fn_row) = call_row
                .get_mut("function")
                .and_then(|node| node.as_object_mut())
            else {
                continue;
            };
            let Some(raw_name) = read_trimmed_string(fn_row.get("name")) else {
                continue;
            };
            let Some((resolved_name, arguments)) = normalize_shell_like_function_call_arguments(
                raw_name.as_str(),
                fn_row.get("arguments"),
                requested_tool_names,
            ) else {
                continue;
            };
            if resolved_name != raw_name {
                fn_row.insert("name".to_string(), Value::String(resolved_name));
            }
            fn_row.insert("arguments".to_string(), Value::String(arguments));
        }
    }
}

fn normalize_responses_input_function_calls(
    payload: &mut Value,
    requested_tool_names: &HashSet<String>,
) {
    let Some(input_items) = payload
        .as_object_mut()
        .and_then(|root| root.get_mut("input"))
        .and_then(|node| node.as_array_mut())
    else {
        return;
    };

    let mut normalized_items = Vec::<Value>::with_capacity(input_items.len());

    for mut item in std::mem::take(input_items) {
        if let Some(item_row) = item.as_object_mut() {
            let item_type = read_trimmed_string(item_row.get("type"))
                .unwrap_or_default()
                .to_ascii_lowercase();
            if item_type == "function_call" {
                if let Some(raw_name) = read_trimmed_string(item_row.get("name")) {
                    if let Some((resolved_name, arguments)) =
                        normalize_shell_like_function_call_arguments(
                            raw_name.as_str(),
                            item_row.get("arguments"),
                            requested_tool_names,
                        )
                    {
                        if resolved_name != raw_name {
                            item_row.insert("name".to_string(), Value::String(resolved_name));
                        }
                        item_row.insert("arguments".to_string(), Value::String(arguments));
                    } else if is_invalid_shell_like_call(raw_name.as_str(), item_row.get("arguments")) {
                        // Keep malformed item unchanged; later request-shape filters can drop it
                        // without inventing a synthetic command.
                    }
                }
            }
        }
        normalized_items.push(item);
    }

    *input_items = normalized_items;
}

pub(crate) fn normalize_shell_like_tool_calls_before_governance(payload: &mut Value) {
    let requested_tool_names = collect_requested_tool_names(payload);
    normalize_message_tool_calls(payload, &requested_tool_names);
    normalize_responses_input_function_calls(payload, &requested_tool_names);
}

#[napi]
pub fn normalize_shell_like_tool_calls_before_governance_json(
    payload_json: String,
) -> NapiResult<String> {
    let mut payload: Value =
        serde_json::from_str(&payload_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    normalize_shell_like_tool_calls_before_governance(&mut payload);
    serde_json::to_string(&payload).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi]
pub fn is_shell_like_tool_name_token_json(name_json: String) -> NapiResult<String> {
    let name: Option<String> =
        serde_json::from_str(&name_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let output = is_shell_like_tool_name_token(name);
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::normalize_shell_like_tool_calls_before_governance;
    use serde_json::{json, Value};

    #[test]
    fn normalizes_exec_command_from_input_string_shape() {
        let mut payload = json!({
          "tools": [{ "type": "function", "function": { "name": "exec_command" } }],
          "messages": [
            {
              "role": "assistant",
              "tool_calls": [
                {
                  "id": "call_1",
                  "type": "function",
                  "function": {
                    "name": "exec_command",
                    "arguments": "{\"input\":\"pwd\"}"
                  }
                }
              ]
            }
          ]
        });

        normalize_shell_like_tool_calls_before_governance(&mut payload);
        let args_text = payload["messages"][0]["tool_calls"][0]["function"]["arguments"]
            .as_str()
            .expect("arguments text");
        let args: Value = serde_json::from_str(args_text).expect("args object");
        assert_eq!(args["cmd"], "pwd");
        assert_eq!(args["command"], "pwd");
    }

    #[test]
    fn normalizes_exec_command_from_nested_args_object_shape() {
        let mut payload = json!({
          "tools": [{ "type": "function", "function": { "name": "exec_command" } }],
          "messages": [
            {
              "role": "assistant",
              "tool_calls": [
                {
                  "id": "call_2",
                  "type": "function",
                  "function": {
                    "name": "exec_command",
                    "arguments": "{\"args\":{\"command\":\"git status\"},\"cwd\":\"/repo\"}"
                  }
                }
              ]
            }
          ]
        });

        normalize_shell_like_tool_calls_before_governance(&mut payload);
        let args_text = payload["messages"][0]["tool_calls"][0]["function"]["arguments"]
            .as_str()
            .expect("arguments text");
        let args: Value = serde_json::from_str(args_text).expect("args object");
        assert_eq!(args["cmd"], "git status");
        assert_eq!(args["command"], "git status");
        assert_eq!(args["workdir"], "/repo");
    }

    #[test]
    fn normalizes_exec_command_inside_responses_input_function_call_items() {
        let mut payload = json!({
          "tools": [{ "type": "function", "function": { "name": "exec_command" } }],
          "input": [
            {
              "type": "function_call",
              "call_id": "fc_1",
              "name": "exec_command",
              "arguments": "{\"args\":{\"command\":\"npm test\"},\"cwd\":\"/workspace\"}"
            }
          ]
        });

        normalize_shell_like_tool_calls_before_governance(&mut payload);
        let args_text = payload["input"][0]["arguments"]
            .as_str()
            .expect("arguments text");
        let args: Value = serde_json::from_str(args_text).expect("args object");
        assert_eq!(args["cmd"], "npm test");
        assert_eq!(args["command"], "npm test");
        assert_eq!(args["workdir"], "/workspace");
    }

    #[test]
    fn normalizes_exec_command_from_action_field_shape() {
        let mut payload = json!({
          "tools": [{ "type": "function", "function": { "name": "exec_command" } }],
          "messages": [
            {
              "role": "assistant",
              "tool_calls": [
                {
                  "id": "call_action",
                  "type": "function",
                  "function": {
                    "name": "exec_command",
                    "arguments": "{\"action\":\"ls -la\"}"
                  }
                }
              ]
            }
          ]
        });

        normalize_shell_like_tool_calls_before_governance(&mut payload);
        let args_text = payload["messages"][0]["tool_calls"][0]["function"]["arguments"]
            .as_str()
            .expect("arguments text");
        let args: Value = serde_json::from_str(args_text).expect("args object");
        assert_eq!(args["cmd"], "ls -la");
        assert_eq!(args["command"], "ls -la");
    }

    #[test]
    fn leaves_exec_command_unchanged_when_cmd_missing() {
        let mut payload = json!({
          "tools": [{ "type": "function", "function": { "name": "exec_command" } }],
          "messages": [
            {
              "role": "assistant",
              "tool_calls": [
                {
                  "id": "call_missing",
                  "type": "function",
                  "function": {
                    "name": "exec_command",
                    "arguments": "{}"
                  }
                }
              ]
            }
          ]
        });

        normalize_shell_like_tool_calls_before_governance(&mut payload);
        let args_text = payload["messages"][0]["tool_calls"][0]["function"]["arguments"]
            .as_str()
            .expect("arguments text");
        assert_eq!(args_text, "{}");
    }

    #[test]
    fn keeps_invalid_exec_command_items_unchanged_for_later_drop() {
        let mut payload = json!({
          "tools": [{ "type": "function", "function": { "name": "exec_command" } }],
          "input": [
            {
              "type": "function_call",
              "call_id": "fc_reasoning_choice_1_1",
              "name": "exec_command",
              "arguments": "{}"
            },
            {
              "type": "function_call_output",
              "call_id": "fc_reasoning_choice_1_1",
              "output": "failed to parse function arguments: missing field `cmd` at line 1 column 2"
            },
            {
              "type": "function_call",
              "call_id": "call_keep",
              "name": "exec_command",
              "arguments": "{\"cmd\":\"pwd\"}"
            },
            {
              "type": "function_call_output",
              "call_id": "call_keep",
              "output": "pwd"
            }
          ]
        });

        normalize_shell_like_tool_calls_before_governance(&mut payload);
        let items = payload["input"].as_array().expect("input items");
        assert_eq!(items.len(), 4);
        let args_text = items[0]["arguments"].as_str().expect("normalized args");
        assert_eq!(args_text, "{}");
    }
}
