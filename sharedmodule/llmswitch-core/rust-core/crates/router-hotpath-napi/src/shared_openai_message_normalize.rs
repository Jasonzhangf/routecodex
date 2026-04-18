use napi::bindgen_prelude::Result as NapiResult;
use serde_json::{Map, Value};
use std::collections::HashSet;

fn split_command_string(input: &str) -> Vec<String> {
    let s = input.trim();
    if s.is_empty() {
        return Vec::new();
    }
    let mut out: Vec<String> = Vec::new();
    let mut cur = String::new();
    let mut in_single = false;
    let mut in_double = false;
    let chars: Vec<char> = s.chars().collect();
    let mut i = 0usize;
    while i < chars.len() {
        let ch = chars[i];
        if in_single {
            if ch == '\'' {
                in_single = false;
            } else {
                cur.push(ch);
            }
            i += 1;
            continue;
        }
        if in_double {
            if ch == '"' {
                in_double = false;
                i += 1;
                continue;
            }
            if ch == '\\' && i + 1 < chars.len() {
                i += 1;
                cur.push(chars[i]);
                i += 1;
                continue;
            }
            cur.push(ch);
            i += 1;
            continue;
        }
        if ch == '\'' {
            in_single = true;
            i += 1;
            continue;
        }
        if ch == '"' {
            in_double = true;
            i += 1;
            continue;
        }
        if ch.is_ascii_whitespace() {
            if !cur.is_empty() {
                out.push(cur.clone());
                cur.clear();
            }
            i += 1;
            continue;
        }
        cur.push(ch);
        i += 1;
    }
    if !cur.is_empty() {
        out.push(cur);
    }
    out
}

fn value_to_non_empty_text(value: Option<&Value>) -> Option<String> {
    match value {
        Some(Value::String(text)) => {
            let trimmed = text.trim();
            if trimmed.is_empty() {
                None
            } else {
                Some(trimmed.to_string())
            }
        }
        Some(Value::Number(num)) => Some(num.to_string()),
        Some(Value::Bool(flag)) => Some(flag.to_string()),
        Some(Value::Array(items)) => {
            let parts = items
                .iter()
                .filter_map(|item| match item {
                    Value::String(text) => {
                        let trimmed = text.trim();
                        if trimmed.is_empty() {
                            None
                        } else {
                            Some(trimmed.to_string())
                        }
                    }
                    Value::Number(num) => Some(num.to_string()),
                    Value::Bool(flag) => Some(flag.to_string()),
                    _ => None,
                })
                .collect::<Vec<String>>();
            if parts.is_empty() {
                None
            } else {
                Some(parts.join(" "))
            }
        }
        _ => None,
    }
}

fn read_exec_command_candidate(args_obj: &Map<String, Value>) -> Option<String> {
    let direct = value_to_non_empty_text(args_obj.get("cmd"))
        .or_else(|| value_to_non_empty_text(args_obj.get("command")))
        .or_else(|| value_to_non_empty_text(args_obj.get("toon")))
        .or_else(|| value_to_non_empty_text(args_obj.get("script")))
        .or_else(|| value_to_non_empty_text(args_obj.get("input")))
        .or_else(|| value_to_non_empty_text(args_obj.get("text")));
    if direct.is_some() {
        return direct;
    }

    let nested = args_obj.get("input").and_then(Value::as_object);
    nested
        .and_then(|row| {
            value_to_non_empty_text(row.get("cmd"))
                .or_else(|| value_to_non_empty_text(row.get("command")))
                .or_else(|| value_to_non_empty_text(row.get("script")))
                .or_else(|| value_to_non_empty_text(row.get("toon")))
        })
        .or_else(|| {
            args_obj
                .get("args")
                .and_then(Value::as_object)
                .and_then(|row| {
                    value_to_non_empty_text(row.get("cmd"))
                        .or_else(|| value_to_non_empty_text(row.get("command")))
                        .or_else(|| value_to_non_empty_text(row.get("script")))
                        .or_else(|| value_to_non_empty_text(row.get("toon")))
                })
        })
}

fn normalize_exec_like_args(fn_name: &str, args_obj: &mut Map<String, Value>) {
    let lowered = fn_name.to_ascii_lowercase();
    if lowered != "exec_command" && lowered != "shell_command" {
        return;
    }

    if lowered == "exec_command" {
        return;
    }

    let normalized_cmd = read_exec_command_candidate(args_obj);

    if lowered == "shell_command" && !args_obj.contains_key("command") && normalized_cmd.is_some() {
        args_obj.insert(
            "command".to_string(),
            Value::String(normalized_cmd.unwrap_or_default()),
        );
    }
}

fn normalize_openai_tool_call(tool_call: &Value, disable_shell_coerce: bool) -> Value {
    let Some(tool_call_obj) = tool_call.as_object() else {
        return tool_call.clone();
    };
    let mut out = tool_call_obj.clone();
    let Some(function_obj) = out.get("function").and_then(Value::as_object) else {
        return Value::Object(out);
    };
    let mut function = function_obj.clone();
    let arg_str_in = match function.get("arguments") {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Null) => "{}".to_string(),
        Some(other) => serde_json::to_string(other).unwrap_or_else(|_| "{}".to_string()),
        None => "{}".to_string(),
    };
    let mut args_obj = serde_json::from_str::<Value>(arg_str_in.as_str())
        .ok()
        .and_then(|v| v.as_object().cloned())
        .unwrap_or_else(Map::new);

    if let Some(name) = function
        .get("name")
        .and_then(Value::as_str)
        .map(|v| v.to_string())
    {
        if let Some(dot) = name.find('.') {
            let next = name[dot + 1..].trim().to_string();
            function.insert("name".to_string(), Value::String(next));
        }
    }

    let fn_name = function
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_ascii_lowercase();
    if !disable_shell_coerce && fn_name == "shell" {
        if let Some(cmd_value) = args_obj.get("command") {
            if let Some(cmd_text) = cmd_value.as_str().map(|v| v.trim().to_string()) {
                if !cmd_text.is_empty() {
                    let has_meta = cmd_text.contains("&&")
                        || cmd_text.contains("||")
                        || cmd_text.contains("<<")
                        || cmd_text
                            .chars()
                            .any(|ch| ['<', '>', '|', ';', '&'].contains(&ch));
                    if has_meta {
                        args_obj.insert(
                            "command".to_string(),
                            Value::Array(vec![
                                Value::String("bash".to_string()),
                                Value::String("-lc".to_string()),
                                Value::String(cmd_text),
                            ]),
                        );
                    } else {
                        let tokens = split_command_string(cmd_text.as_str())
                            .into_iter()
                            .map(Value::String)
                            .collect::<Vec<Value>>();
                        args_obj.insert("command".to_string(), Value::Array(tokens));
                    }
                }
            } else if let Some(cmd_arr) = cmd_value.as_array() {
                let tokens: Vec<String> = cmd_arr
                    .iter()
                    .map(|v| {
                        v.as_str()
                            .map(|s| s.to_string())
                            .unwrap_or_else(|| v.to_string())
                    })
                    .collect();
                if tokens.len() > 3 && tokens[0] == "bash" && tokens[1] == "-lc" {
                    args_obj.insert(
                        "command".to_string(),
                        Value::Array(vec![
                            Value::String("bash".to_string()),
                            Value::String("-lc".to_string()),
                            Value::String(tokens[2..].join(" ")),
                        ]),
                    );
                }
            }
        }
    }

    normalize_exec_like_args(fn_name.as_str(), &mut args_obj);

    let next_args = serde_json::to_string(&Value::Object(args_obj)).unwrap_or(arg_str_in);
    function.insert("arguments".to_string(), Value::String(next_args));
    out.insert("function".to_string(), Value::Object(function));
    Value::Object(out)
}

fn normalize_openai_message(message: &Value, disable_shell_coerce: bool) -> Value {
    let Some(message_obj) = message.as_object() else {
        return message.clone();
    };
    let mut out = message_obj.clone();
    if out.get("role").and_then(Value::as_str) == Some("developer") {
        out.insert("role".to_string(), Value::String("system".to_string()));
    }

    if let Some(content) = out.get("content").cloned() {
        if !content.is_null() && !content.is_string() && !content.is_array() && !content.is_object()
        {
            out.insert("content".to_string(), Value::String(content.to_string()));
        }
    }

    if out.get("role").and_then(Value::as_str) == Some("assistant") {
        if let Some(tool_calls) = out.get("tool_calls").and_then(Value::as_array).cloned() {
            let normalized = tool_calls
                .iter()
                .map(|entry| normalize_openai_tool_call(entry, disable_shell_coerce))
                .collect::<Vec<Value>>();
            out.insert("tool_calls".to_string(), Value::Array(normalized));
        }
    }
    Value::Object(out)
}

fn normalize_openai_tool(tool: &Value) -> Value {
    let Some(tool_obj) = tool.as_object() else {
        return tool.clone();
    };
    let mut out = tool_obj.clone();
    if out.get("type").and_then(Value::as_str) == Some("function") {
        if let Some(function_obj) = out.get("function").and_then(Value::as_object) {
            let mut function = function_obj.clone();
            if let Some(parameters) = function.get("parameters") {
                if !parameters.is_object() {
                    let raw = match parameters {
                        Value::String(text) => text.clone(),
                        other => other.to_string(),
                    };
                    let parsed = serde_json::from_str::<Value>(raw.as_str())
                        .ok()
                        .filter(Value::is_object)
                        .unwrap_or_else(|| Value::Object(Map::new()));
                    function.insert("parameters".to_string(), parsed);
                }
            }
            out.insert("function".to_string(), Value::Object(function));
        }
    }
    Value::Object(out)
}

fn sanitize_tool_content_value(content: &Value) -> Value {
    const EMPTY_TOOL_FALLBACK: &str =
        "[RouteCodex] Tool output was empty; execution status unknown.";
    if content.is_null() {
        return Value::String(EMPTY_TOOL_FALLBACK.to_string());
    }
    if let Some(text) = content.as_str() {
        if text.trim().is_empty() {
            return Value::String(EMPTY_TOOL_FALLBACK.to_string());
        }
        return Value::String(text.to_string());
    }
    if content.is_object() || content.is_array() {
        let serialized = serde_json::to_string(content).unwrap_or_else(|_| content.to_string());
        return Value::String(serialized);
    }
    Value::String(content.to_string())
}

fn is_empty_assistant_content(content: Option<&Value>) -> bool {
    let Some(content) = content else {
        return true;
    };
    if content.is_null() {
        return true;
    }
    if let Some(text) = content.as_str() {
        return text.trim().is_empty();
    }
    if let Some(parts) = content.as_array() {
        let joined = parts
            .iter()
            .filter_map(|entry| entry.as_object())
            .filter_map(|row| row.get("text").and_then(Value::as_str))
            .filter(|text| !text.is_empty())
            .collect::<Vec<&str>>()
            .join("");
        return joined.trim().is_empty();
    }
    false
}

pub(crate) fn normalize_openai_chat_messages(messages: &Value) -> Value {
    let Some(raw_messages) = messages.as_array() else {
        return messages.clone();
    };
    let mut next_messages = raw_messages.clone();

    for message in next_messages.iter_mut() {
        let Some(message_obj) = message.as_object_mut() else {
            continue;
        };
        let mut role = message_obj
            .get("role")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_ascii_lowercase();
        if role == "developer" {
            message_obj.insert("role".to_string(), Value::String("system".to_string()));
            role = "system".to_string();
        }
        if role != "tool" {
            continue;
        }
        let content = message_obj.get("content").cloned().unwrap_or(Value::Null);
        message_obj.insert("content".to_string(), sanitize_tool_content_value(&content));
    }

    let mut last_assistant_idx: Option<usize> = None;
    for idx in (0..next_messages.len()).rev() {
        let Some(message_obj) = next_messages[idx].as_object() else {
            continue;
        };
        let is_assistant = message_obj.get("role").and_then(Value::as_str) == Some("assistant");
        let has_tool_calls = message_obj
            .get("tool_calls")
            .and_then(Value::as_array)
            .map(|arr| !arr.is_empty())
            .unwrap_or(false);
        if is_assistant && has_tool_calls {
            last_assistant_idx = Some(idx);
            break;
        }
    }

    if let Some(last_idx) = last_assistant_idx {
        let mut call_ids = HashSet::<String>::new();
        if let Some(last_obj) = next_messages[last_idx].as_object() {
            if let Some(tool_calls) = last_obj.get("tool_calls").and_then(Value::as_array) {
                for tool_call in tool_calls {
                    if let Some(id) = tool_call
                        .as_object()
                        .and_then(|row| row.get("id"))
                        .and_then(Value::as_str)
                    {
                        call_ids.insert(id.to_string());
                    }
                }
            }
        }
        for idx in (last_idx + 1)..next_messages.len() {
            let Some(message_obj) = next_messages[idx].as_object_mut() else {
                continue;
            };
            if message_obj.get("role").and_then(Value::as_str) != Some("tool") {
                continue;
            }
            let Some(tool_call_id) = message_obj.get("tool_call_id").and_then(Value::as_str) else {
                continue;
            };
            if !call_ids.contains(tool_call_id) {
                continue;
            }
            let content = message_obj.get("content").cloned().unwrap_or(Value::Null);
            message_obj.insert("content".to_string(), sanitize_tool_content_value(&content));
        }
    }

    let mut filtered: Vec<Value> = Vec::with_capacity(next_messages.len());
    for message in next_messages {
        let Some(message_obj) = message.as_object() else {
            filtered.push(message);
            continue;
        };
        if message_obj.get("role").and_then(Value::as_str) != Some("assistant") {
            filtered.push(Value::Object(message_obj.clone()));
            continue;
        }
        let has_tools = message_obj
            .get("tool_calls")
            .and_then(Value::as_array)
            .map(|arr| !arr.is_empty())
            .unwrap_or(false);
        if has_tools || !is_empty_assistant_content(message_obj.get("content")) {
            filtered.push(Value::Object(message_obj.clone()));
        }
    }
    Value::Array(filtered)
}

#[napi_derive::napi]
pub fn normalize_openai_message_json(
    message_json: String,
    disable_shell_coerce: bool,
) -> NapiResult<String> {
    let message: Value =
        serde_json::from_str(&message_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let output = normalize_openai_message(&message, disable_shell_coerce);
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi_derive::napi]
pub fn normalize_openai_tool_json(tool_json: String) -> NapiResult<String> {
    let tool: Value =
        serde_json::from_str(&tool_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let output = normalize_openai_tool(&tool);
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi_derive::napi]
pub fn normalize_openai_tool_call_json(
    tool_call_json: String,
    disable_shell_coerce: bool,
) -> NapiResult<String> {
    let tool_call: Value = serde_json::from_str(&tool_call_json)
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let output = normalize_openai_tool_call(&tool_call, disable_shell_coerce);
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi_derive::napi]
pub fn normalize_openai_chat_messages_json(messages_json: String) -> NapiResult<String> {
    let messages: Value = serde_json::from_str(&messages_json)
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let output = normalize_openai_chat_messages(&messages);
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::{
        normalize_openai_chat_messages, normalize_openai_message, normalize_openai_tool_call,
    };
    use serde_json::json;

    #[test]
    fn normalize_exec_command_preserves_command_only_shape() {
        let tool_call = json!({
          "id": "call_1",
          "type": "function",
          "function": {
            "name": "exec_command",
            "arguments": "{\"command\":\"ls -la\"}"
          }
        });

        let out = normalize_openai_tool_call(&tool_call, false);
        let args_text = out
            .get("function")
            .and_then(|v| v.get("arguments"))
            .and_then(|v| v.as_str())
            .expect("normalized arguments");
        let args: serde_json::Value = serde_json::from_str(args_text).expect("parse args");
        assert_eq!(args.get("cmd").and_then(|v| v.as_str()), None);
        assert_eq!(args.get("command").and_then(|v| v.as_str()), Some("ls -la"));
    }

    #[test]
    fn normalize_exec_command_preserves_cmd_only_shape() {
        let tool_call = json!({
          "id": "call_2",
          "type": "function",
          "function": {
            "name": "exec_command",
            "arguments": "{\"cmd\":\"pwd\"}"
          }
        });

        let out = normalize_openai_tool_call(&tool_call, false);
        let args_text = out
            .get("function")
            .and_then(|v| v.get("arguments"))
            .and_then(|v| v.as_str())
            .expect("normalized arguments");
        let args: serde_json::Value = serde_json::from_str(args_text).expect("parse args");
        assert_eq!(args.get("cmd").and_then(|v| v.as_str()), Some("pwd"));
        assert_eq!(args.get("command").and_then(|v| v.as_str()), None);
    }

    #[test]
    fn normalize_shell_command_fills_command_from_cmd() {
        let tool_call = json!({
          "id": "call_3",
          "type": "function",
          "function": {
            "name": "shell_command",
            "arguments": "{\"cmd\":\"echo hello\"}"
          }
        });

        let out = normalize_openai_tool_call(&tool_call, false);
        let args_text = out
            .get("function")
            .and_then(|v| v.get("arguments"))
            .and_then(|v| v.as_str())
            .expect("normalized arguments");
        let args: serde_json::Value = serde_json::from_str(args_text).expect("parse args");
        assert_eq!(
            args.get("command").and_then(|v| v.as_str()),
            Some("echo hello")
        );
    }

    #[test]
    fn normalize_exec_command_preserves_input_string_shape() {
        let tool_call = json!({
          "id": "call_4",
          "type": "function",
          "function": {
            "name": "exec_command",
            "arguments": "{\"input\":\"git status\"}"
          }
        });

        let out = normalize_openai_tool_call(&tool_call, false);
        let args_text = out
            .get("function")
            .and_then(|v| v.get("arguments"))
            .and_then(|v| v.as_str())
            .expect("normalized arguments");
        let args: serde_json::Value = serde_json::from_str(args_text).expect("parse args");
        assert_eq!(args.get("cmd").and_then(|v| v.as_str()), None);
        assert_eq!(
            args.get("input").and_then(|v| v.as_str()),
            Some("git status")
        );
    }

    #[test]
    fn normalize_tool_message_empty_content_marks_unknown_status() {
        let messages = json!([
          { "role": "assistant", "tool_calls": [{ "id": "call_1", "type": "function", "function": { "name": "exec_command", "arguments": "{\"cmd\":\"pwd\"}" } }]},
          { "role": "tool", "tool_call_id": "call_1", "content": "" }
        ]);

        let out = normalize_openai_chat_messages(&messages);
        assert_eq!(
            out[1]["content"],
            "[RouteCodex] Tool output was empty; execution status unknown."
        );
    }

    #[test]
    fn normalize_openai_message_coerces_developer_to_system() {
        let message = json!({ "role": "developer", "content": "policy" });
        let out = normalize_openai_message(&message, false);
        assert_eq!(out["role"], "system");
        assert_eq!(out["content"], "policy");
    }

    #[test]
    fn normalize_openai_chat_messages_coerces_developer_to_system() {
        let messages = json!([
          { "role": "developer", "content": "policy" },
          { "role": "user", "content": "hello" }
        ]);
        let out = normalize_openai_chat_messages(&messages);
        assert_eq!(out[0]["role"], "system");
        assert_eq!(out[1]["role"], "user");
    }
}
