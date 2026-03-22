use napi::bindgen_prelude::Result as NapiResult;
use serde_json::{Map, Value};

const SHELL_COMMAND_DESCRIPTION: &str =
    "Shell command argv tokens. Use [\"bash\",\"-lc\",\"<cmd>\"] form.";

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

fn sanitize_glm_tools_schema(payload: &Value) -> Value {
    let Some(payload_obj) = payload.as_object() else {
        return payload.clone();
    };
    let Some(tools) = payload_obj.get("tools").and_then(Value::as_array) else {
        return payload.clone();
    };

    let mut out = payload_obj.clone();
    out.insert(
        "tools".to_string(),
        Value::Array(tools.iter().map(sanitize_tool_definition).collect()),
    );
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
        assert_eq!(function["parameters"]["properties"]["command"]["type"], "array");
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
}
