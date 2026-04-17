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
        .get("command")
        .and_then(Value::as_object)
        .cloned()
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
        .get("properties")
        .and_then(Value::as_object)
        .cloned()
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

fn sanitize_tool_definition(entry: &Value) -> Value {
    let Some(tool_obj) = entry.as_object() else {
        return entry.clone();
    };
    let mut sanitized = tool_obj.clone();
    let Some(function_obj) = sanitized.get("function").and_then(Value::as_object) else {
        return Value::Object(sanitized);
    };

    let mut function = function_obj.clone();
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
        if let Some(params_obj) = function.get("parameters").and_then(Value::as_object) {
            let mut params = params_obj.clone();
            sanitize_shell_parameters(&mut params);
            function.insert("parameters".to_string(), Value::Object(params));
        }
    }

    sanitized.insert("function".to_string(), Value::Object(function));
    Value::Object(sanitized)
}

fn sanitize_tool_choice(payload_obj: &Map<String, Value>, out: &mut Map<String, Value>) {
    let Some(tool_choice_obj) = payload_obj.get("tool_choice").and_then(Value::as_object) else {
        return;
    };
    let Some(function_obj) = tool_choice_obj.get("function").and_then(Value::as_object) else {
        return;
    };
    let Some(name) = function_obj.get("name").and_then(Value::as_str) else {
        return;
    };
    let normalized_name = normalize_glm_tool_name(name);
    if normalized_name.is_empty() || normalized_name == name {
        return;
    }
    let mut next_function = function_obj.clone();
    next_function.insert("name".to_string(), Value::String(normalized_name));
    let mut next_tool_choice = tool_choice_obj.clone();
    next_tool_choice.insert("function".to_string(), Value::Object(next_function));
    out.insert("tool_choice".to_string(), Value::Object(next_tool_choice));
}

fn sanitize_message_tool_names(payload_obj: &Map<String, Value>, out: &mut Map<String, Value>) {
    let Some(messages) = payload_obj.get("messages").and_then(Value::as_array) else {
        return;
    };
    let mut changed = false;
    let mut next_messages = Vec::with_capacity(messages.len());
    for message in messages {
        let Some(message_obj) = message.as_object() else {
            next_messages.push(message.clone());
            continue;
        };
        let mut next_message = message_obj.clone();
        if let Some(tool_calls) = message_obj.get("tool_calls").and_then(Value::as_array) {
            let mut tool_calls_changed = false;
            let mut next_tool_calls = Vec::with_capacity(tool_calls.len());
            for tool_call in tool_calls {
                let Some(tool_call_obj) = tool_call.as_object() else {
                    next_tool_calls.push(tool_call.clone());
                    continue;
                };
                let Some(function_obj) = tool_call_obj.get("function").and_then(Value::as_object) else {
                    next_tool_calls.push(tool_call.clone());
                    continue;
                };
                let Some(name) = function_obj.get("name").and_then(Value::as_str) else {
                    next_tool_calls.push(tool_call.clone());
                    continue;
                };
                let normalized_name = normalize_glm_tool_name(name);
                if normalized_name.is_empty() || normalized_name == name {
                    next_tool_calls.push(tool_call.clone());
                    continue;
                }
                let mut next_function = function_obj.clone();
                next_function.insert("name".to_string(), Value::String(normalized_name));
                let mut next_tool_call = tool_call_obj.clone();
                next_tool_call.insert("function".to_string(), Value::Object(next_function));
                next_tool_calls.push(Value::Object(next_tool_call));
                tool_calls_changed = true;
            }
            if tool_calls_changed {
                next_message.insert("tool_calls".to_string(), Value::Array(next_tool_calls));
                changed = true;
            }
        }
        if let Some(name) = message_obj.get("name").and_then(Value::as_str) {
            let normalized_name = normalize_glm_tool_name(name);
            if !normalized_name.is_empty() && normalized_name != name {
                next_message.insert("name".to_string(), Value::String(normalized_name));
                changed = true;
            }
        }
        next_messages.push(Value::Object(next_message));
    }
    if changed {
        out.insert("messages".to_string(), Value::Array(next_messages));
    }
}

fn sanitize_glm_tools_schema(payload: &Value) -> Value {
    let Some(payload_obj) = payload.as_object() else {
        return payload.clone();
    };
    let mut out = payload_obj.clone();
    if let Some(tools) = payload_obj.get("tools").and_then(Value::as_array) {
        out.insert(
            "tools".to_string(),
            Value::Array(tools.iter().map(sanitize_tool_definition).collect()),
        );
    }
    sanitize_tool_choice(payload_obj, &mut out);
    sanitize_message_tool_names(payload_obj, &mut out);
    Value::Object(out)
}

#[napi_derive::napi]
pub fn sanitize_tool_schema_glm_shell_json(payload_json: String) -> NapiResult<String> {
    let payload: Value =
        serde_json::from_str(&payload_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let normalized = sanitize_glm_tools_schema(&payload);
    serde_json::to_string(&normalized).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::sanitize_glm_tools_schema;
    use serde_json::json;

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

        let output = sanitize_glm_tools_schema(&payload);
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
        let output = sanitize_glm_tools_schema(&payload);
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
                    "name": "reasoning.stop",
                    "arguments": "{}"
                  }
                }
              ]
            },
            {
              "role": "tool",
              "name": "reasoning.stop",
              "content": "{}"
            }
          ],
          "tools": [
            {
              "type": "function",
              "function": {
                "name": "reasoning.stop",
                "parameters": {
                  "type": "object"
                }
              }
            }
          ],
          "tool_choice": {
            "type": "function",
            "function": {
              "name": "reasoning.stop"
            }
          }
        });

        let output = sanitize_glm_tools_schema(&payload);
        assert_eq!(output["tools"][0]["function"]["name"], json!("reasoning_stop"));
        assert_eq!(output["tool_choice"]["function"]["name"], json!("reasoning_stop"));
        assert_eq!(
            output["messages"][0]["tool_calls"][0]["function"]["name"],
            json!("reasoning_stop")
        );
        assert_eq!(output["messages"][1]["name"], json!("reasoning_stop"));
    }
}
