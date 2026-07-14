use napi::bindgen_prelude::Result as NapiResult;
use serde_json::{Map, Value};

const SHELL_COMMAND_DESCRIPTION: &str =
    "Shell command argv tokens. Use [\"bash\",\"-lc\",\"<cmd>\"] form.";

fn normalize_glm_tool_name(raw: &str) -> String {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    let mut out = String::with_capacity(trimmed.len());
    let mut prev_sep = false;
    for ch in trimmed.chars() {
        if ch.is_ascii_alphanumeric() || ch == '_' {
            out.push(ch);
            prev_sep = false;
            continue;
        }
        if !out.is_empty() && !prev_sep {
            out.push('_');
            prev_sep = true;
        }
    }
    out.trim_matches('_').to_string()
}

fn ensure_string_array(value: Option<&Value>) -> Vec<String> {
    let Some(Value::Array(items)) = value else {
        return Vec::new();
    };
    let mut out = Vec::with_capacity(items.len());
    for item in items {
        let Some(text) = item.as_str() else {
            return Vec::new();
        };
        out.push(text.to_string());
    }
    out
}

fn sanitize_shell_command_property(properties: &mut Map<String, Value>) {
    let mut command = properties
        .remove("command")
        .and_then(|value| match value {
            Value::Object(map) => Some(map),
            _ => None,
        })
        .unwrap_or_default();

    command.remove("oneOf");
    command.insert("type".to_string(), Value::String("array".to_string()));
    command.insert(
        "items".to_string(),
        Value::Object(Map::from_iter([(
            "type".to_string(),
            Value::String("string".to_string()),
        )])),
    );

    let has_description = command
        .get("description")
        .and_then(Value::as_str)
        .map(|text| !text.is_empty())
        .unwrap_or(false);
    if !has_description {
        command.insert(
            "description".to_string(),
            Value::String(SHELL_COMMAND_DESCRIPTION.to_string()),
        );
    }

    properties.insert("command".to_string(), Value::Object(command));
}

fn sanitize_shell_parameters(params: &mut Map<String, Value>) {
    let mut properties = params
        .remove("properties")
        .and_then(|value| match value {
            Value::Object(map) => Some(map),
            _ => None,
        })
        .unwrap_or_default();
    sanitize_shell_command_property(&mut properties);
    params.insert("properties".to_string(), Value::Object(properties));

    let mut required = ensure_string_array(params.get("required"));
    if !required.iter().any(|entry| entry == "command") {
        required.push("command".to_string());
    }
    params.insert(
        "required".to_string(),
        Value::Array(required.into_iter().map(Value::String).collect()),
    );

    let type_is_string = params.get("type").and_then(Value::as_str).is_some();
    if !type_is_string {
        params.insert("type".to_string(), Value::String("object".to_string()));
    }

    let has_bool_additional = params
        .get("additionalProperties")
        .and_then(Value::as_bool)
        .is_some();
    if !has_bool_additional {
        params.insert("additionalProperties".to_string(), Value::Bool(false));
    }
}

fn sanitize_tool_definition_owned(entry: Value) -> Value {
    let Value::Object(mut sanitized) = entry else {
        return entry;
    };
    let Some(function_value) = sanitized.remove("function") else {
        return Value::Object(sanitized);
    };
    let Value::Object(mut function) = function_value else {
        sanitized.insert("function".to_string(), function_value);
        return Value::Object(sanitized);
    };

    function.remove("strict");
    if let Some(name) = function.get("name").and_then(Value::as_str) {
        let normalized_name = normalize_glm_tool_name(name);
        if !normalized_name.is_empty() && normalized_name != name {
            function.insert("name".to_string(), Value::String(normalized_name));
        }
    }

    let is_shell = function
        .get("name")
        .and_then(Value::as_str)
        .map(|name| name == "shell")
        .unwrap_or(false);
    if is_shell {
        if let Some(params_value) = function.remove("parameters") {
            let Value::Object(mut params) = params_value else {
                function.insert("parameters".to_string(), params_value);
                sanitized.insert("function".to_string(), Value::Object(function));
                return Value::Object(sanitized);
            };
            sanitize_shell_parameters(&mut params);
            function.insert("parameters".to_string(), Value::Object(params));
        }
    }

    sanitized.insert("function".to_string(), Value::Object(function));
    Value::Object(sanitized)
}

fn sanitize_tool_choice_owned(out: &mut Map<String, Value>) {
    let Some(tool_choice_value) = out.remove("tool_choice") else {
        return;
    };
    let Value::Object(mut tool_choice_obj) = tool_choice_value else {
        out.insert("tool_choice".to_string(), tool_choice_value);
        return;
    };
    let Some(function_value) = tool_choice_obj.remove("function") else {
        out.insert("tool_choice".to_string(), Value::Object(tool_choice_obj));
        return;
    };
    let Value::Object(mut function_obj) = function_value else {
        tool_choice_obj.insert("function".to_string(), function_value);
        out.insert("tool_choice".to_string(), Value::Object(tool_choice_obj));
        return;
    };
    let normalized_name = function_obj
        .get("name")
        .and_then(Value::as_str)
        .map(normalize_glm_tool_name)
        .filter(|normalized| !normalized.is_empty());
    if let Some(normalized_name) = normalized_name {
        let should_update = function_obj
            .get("name")
            .and_then(Value::as_str)
            .map(|name| normalized_name != name)
            .unwrap_or(false);
        if should_update {
            function_obj.insert("name".to_string(), Value::String(normalized_name));
        }
    }
    tool_choice_obj.insert("function".to_string(), Value::Object(function_obj));
    out.insert("tool_choice".to_string(), Value::Object(tool_choice_obj));
}

fn sanitize_message_tool_names_owned(out: &mut Map<String, Value>) {
    let Some(messages_value) = out.remove("messages") else {
        return;
    };
    let Value::Array(messages) = messages_value else {
        out.insert("messages".to_string(), messages_value);
        return;
    };
    let mut next_messages = Vec::with_capacity(messages.len());
    for message in messages {
        let Value::Object(mut next_message) = message else {
            next_messages.push(message);
            continue;
        };
        if let Some(tool_calls_value) = next_message.remove("tool_calls") {
            match tool_calls_value {
                Value::Array(tool_calls) => {
                    let mut next_tool_calls = Vec::with_capacity(tool_calls.len());
                    for tool_call in tool_calls {
                        let Value::Object(mut tool_call_obj) = tool_call else {
                            next_tool_calls.push(tool_call);
                            continue;
                        };
                        let Some(function_value) = tool_call_obj.remove("function") else {
                            next_tool_calls.push(Value::Object(tool_call_obj));
                            continue;
                        };
                        let Value::Object(mut function_obj) = function_value else {
                            tool_call_obj.insert("function".to_string(), function_value);
                            next_tool_calls.push(Value::Object(tool_call_obj));
                            continue;
                        };
                        let Some(name) = function_obj.get("name").and_then(Value::as_str) else {
                            tool_call_obj
                                .insert("function".to_string(), Value::Object(function_obj));
                            next_tool_calls.push(Value::Object(tool_call_obj));
                            continue;
                        };
                        let normalized_name = normalize_glm_tool_name(name);
                        if normalized_name.is_empty() || normalized_name == name {
                            tool_call_obj
                                .insert("function".to_string(), Value::Object(function_obj));
                            next_tool_calls.push(Value::Object(tool_call_obj));
                            continue;
                        }
                        function_obj.insert("name".to_string(), Value::String(normalized_name));
                        tool_call_obj.insert("function".to_string(), Value::Object(function_obj));
                        next_tool_calls.push(Value::Object(tool_call_obj));
                    }
                    next_message.insert("tool_calls".to_string(), Value::Array(next_tool_calls));
                }
                other => {
                    next_message.insert("tool_calls".to_string(), other);
                }
            }
        }
        if let Some(name) = next_message.get("name").and_then(Value::as_str) {
            let normalized_name = normalize_glm_tool_name(name);
            if !normalized_name.is_empty() && normalized_name != name {
                next_message.insert("name".to_string(), Value::String(normalized_name));
            }
        }
        next_messages.push(Value::Object(next_message));
    }
    out.insert("messages".to_string(), Value::Array(next_messages));
}

fn sanitize_glm_tools_schema_owned(payload: Value) -> Value {
    let Value::Object(mut out) = payload else {
        return payload;
    };
    if let Some(tools_value) = out.remove("tools") {
        let Value::Array(tools) = tools_value else {
            out.insert("tools".to_string(), tools_value);
            sanitize_tool_choice_owned(&mut out);
            sanitize_message_tool_names_owned(&mut out);
            return Value::Object(out);
        };
        out.insert(
            "tools".to_string(),
            Value::Array(
                tools
                    .into_iter()
                    .map(sanitize_tool_definition_owned)
                    .collect(),
            ),
        );
    }
    sanitize_tool_choice_owned(&mut out);
    sanitize_message_tool_names_owned(&mut out);
    Value::Object(out)
}

#[napi_derive::napi]
pub fn sanitize_tool_schema_glm_shell_json(payload_json: String) -> NapiResult<String> {
    let payload: Value =
        serde_json::from_str(&payload_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let normalized = sanitize_glm_tools_schema_owned(payload);
    serde_json::to_string(&normalized).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::sanitize_glm_tools_schema_owned;
    use serde_json::json;
    use std::fs;
    use std::path::PathBuf;

    #[test]
    fn glm_tool_schema_sanitizer_does_not_clone_complete_payload_branches() {
        let mut source = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        source.push("src/compat_tool_schema.rs");
        let source = fs::read_to_string(source).expect("compat_tool_schema.rs source");
        for (subject, suffix) in [
            ("payload_obj", ".clone()"),
            ("tool_obj", ".clone()"),
            ("function_obj", ".clone()"),
            ("message_obj", ".clone()"),
            ("tool_call_obj", ".clone()"),
            ("tool_choice_obj", ".clone()"),
            ("payload", ".clone()"),
            ("message", ".clone()"),
            ("tool_call", ".clone()"),
        ] {
            let forbidden = format!("{subject}{suffix}");
            assert!(
                !source.contains(&forbidden),
                "GLM tool schema sanitizer must move owned payload branches instead of cloning {forbidden}"
            );
        }
    }

    #[test]
    fn sanitizes_shell_command_schema_and_removes_strict() {
        let payload = json!({
          "tools": [
            {
              "type": "function",
              "function": {
                "name": "shell",
                "strict": true,
                "parameters": {
                  "properties": {
                    "command": {
                      "oneOf": [
                        { "type": "string" },
                        { "type": "array" }
                      ],
                      "description": ""
                    }
                  },
                  "required": ["workdir", "command"],
                  "additionalProperties": null
                }
              }
            }
          ]
        });

        let output = sanitize_glm_tools_schema_owned(payload);
        let function = output["tools"][0]["function"].as_object().unwrap();
        assert!(function.get("strict").is_none());
        assert_eq!(
            function["parameters"]["properties"]["command"]["type"],
            "array"
        );
        assert_eq!(
            function["parameters"]["properties"]["command"]["items"]["type"],
            "string"
        );
        assert_eq!(
            function["parameters"]["properties"]["command"]["description"],
            "Shell command argv tokens. Use [\"bash\",\"-lc\",\"<cmd>\"] form."
        );
        assert_eq!(
            function["parameters"]["required"],
            json!(["workdir", "command"])
        );
        assert_eq!(function["parameters"]["type"], "object");
        assert_eq!(function["parameters"]["additionalProperties"], false);
    }

    #[test]
    fn keeps_non_shell_parameters_shape_except_strict() {
        let payload = json!({
          "tools": [
            {
              "function": {
                "name": "read_file",
                "strict": false,
                "parameters": {
                  "type": "object",
                  "required": ["path", 1]
                }
              }
            }
          ]
        });
        let output = sanitize_glm_tools_schema_owned(payload);
        let function = output["tools"][0]["function"].as_object().unwrap();
        assert!(function.get("strict").is_none());
        assert_eq!(function["parameters"]["required"], json!(["path", 1]));
    }

    #[test]
    fn rewrites_dotted_tool_names_for_glm_payloads() {
        let payload = json!({
          "messages": [
            {
              "role": "assistant",
              "tool_calls": [
                {
                  "type": "function",
                  "function": {
                    "name": "continue_execution",
                    "arguments": "{}"
                  }
                }
              ]
            },
            {
              "role": "tool",
              "name": "continue_execution",
              "content": "{}"
            }
          ],
          "tools": [
            {
              "type": "function",
              "function": {
                "name": "continue_execution",
                "parameters": {
                  "type": "object"
                }
              }
            }
          ],
          "tool_choice": {
            "type": "function",
            "function": {
              "name": "continue_execution"
            }
          }
        });

        let output = sanitize_glm_tools_schema_owned(payload);
        assert_eq!(
            output["tools"][0]["function"]["name"],
            json!("continue_execution")
        );
        assert_eq!(
            output["tool_choice"]["function"]["name"],
            json!("continue_execution")
        );
        assert_eq!(
            output["messages"][0]["tool_calls"][0]["function"]["name"],
            json!("continue_execution")
        );
        assert_eq!(output["messages"][1]["name"], json!("continue_execution"));
    }

    #[test]
    fn preserves_non_array_tool_calls_without_skipping_message_name_normalization() {
        let payload = json!({
          "messages": [{
            "role": "tool",
            "name": "namespace.read_file",
            "tool_calls": {"unexpected": true},
            "content": "{}"
          }]
        });

        let output = sanitize_glm_tools_schema_owned(payload);
        assert_eq!(
            output["messages"][0]["tool_calls"],
            json!({"unexpected": true})
        );
        assert_eq!(output["messages"][0]["name"], json!("namespace_read_file"));
    }
}
