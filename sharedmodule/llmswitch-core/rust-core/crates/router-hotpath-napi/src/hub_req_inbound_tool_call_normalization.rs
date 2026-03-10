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
    let input = args.get("input").and_then(|v| v.as_object());
    let direct = read_trimmed_string(args.get("cmd"))
        .or_else(|| read_trimmed_string(args.get("command")))
        .or_else(|| read_trimmed_string(args.get("script")))
        .or_else(|| read_trimmed_string(args.get("toon")))
        .or_else(|| read_string_array_command(args.get("cmd")))
        .or_else(|| read_string_array_command(args.get("command")));
    if direct.is_some() {
        return direct;
    }
    let input_row = input?;
    read_trimmed_string(input_row.get("cmd"))
        .or_else(|| read_trimmed_string(input_row.get("command")))
        .or_else(|| read_trimmed_string(input_row.get("script")))
        .or_else(|| read_string_array_command(input_row.get("cmd")))
        .or_else(|| read_string_array_command(input_row.get("command")))
}

fn read_workdir_from_args(args: &Map<String, Value>) -> Option<String> {
    let input = args.get("input").and_then(|v| v.as_object());
    read_trimmed_string(args.get("workdir"))
        .or_else(|| read_trimmed_string(args.get("cwd")))
        .or_else(|| read_trimmed_string(args.get("workDir")))
        .or_else(|| input.and_then(|row| read_trimmed_string(row.get("workdir"))))
        .or_else(|| input.and_then(|row| read_trimmed_string(row.get("cwd"))))
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

pub(crate) fn normalize_shell_like_tool_calls_before_governance(payload: &mut Value) {
    let requested_tool_names = collect_requested_tool_names(payload);
    let messages = match payload
        .as_object_mut()
        .and_then(|root| root.get_mut("messages"))
        .and_then(|node| node.as_array_mut())
    {
        Some(v) => v,
        None => return,
    };

    for message in messages.iter_mut() {
        let message_row = match message.as_object_mut() {
            Some(v) => v,
            None => continue,
        };
        let role = read_trimmed_string(message_row.get("role"))
            .unwrap_or_default()
            .to_ascii_lowercase();
        if role != "assistant" {
            continue;
        }
        let tool_calls = match message_row
            .get_mut("tool_calls")
            .and_then(|node| node.as_array_mut())
        {
            Some(v) => v,
            None => continue,
        };

        for call in tool_calls.iter_mut() {
            let call_row = match call.as_object_mut() {
                Some(v) => v,
                None => continue,
            };
            let fn_row = match call_row
                .get_mut("function")
                .and_then(|node| node.as_object_mut())
            {
                Some(v) => v,
                None => continue,
            };
            let raw_name = match read_trimmed_string(fn_row.get("name")) {
                Some(v) => v,
                None => continue,
            };
            if !is_shell_like_tool_name(raw_name.as_str()) {
                continue;
            }

            let resolved_name =
                resolve_shell_like_tool_name(raw_name.as_str(), &requested_tool_names);
            if resolved_name != raw_name {
                fn_row.insert("name".to_string(), Value::String(resolved_name));
            }

            let args = match parse_json_record(fn_row.get("arguments")) {
                Some(v) => v,
                None => continue,
            };
            let cmd = match read_command_from_args(&args) {
                Some(v) => v,
                None => continue,
            };
            let mut next_args = args;
            next_args.insert("cmd".to_string(), Value::String(cmd.clone()));
            next_args.insert("command".to_string(), Value::String(cmd));
            if let Some(workdir) = read_workdir_from_args(&next_args) {
                next_args.insert("workdir".to_string(), Value::String(workdir));
            }
            next_args.remove("toon");

            let arguments = serde_json::to_string(&Value::Object(next_args))
                .unwrap_or_else(|_| "{\"cmd\":\"\",\"command\":\"\"}".to_string());
            fn_row.insert("arguments".to_string(), Value::String(arguments));
        }
    }
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
