use napi::bindgen_prelude::Result as NapiResult;
use napi_derive::napi;
use serde::Deserialize;
use serde_json::{Map, Value};

use crate::hub_resp_outbound_client_semantics::normalize_responses_function_name;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ToolMappingOptions {
    sanitize_mode: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ToolMappingSingleInput {
    tool: Value,
    options: Option<ToolMappingOptions>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ToolMappingListInput {
    tools: Value,
    options: Option<ToolMappingOptions>,
}

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

fn normalize_anthropic_tool_name(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return None;
    }
    let lower = trimmed.to_ascii_lowercase();
    if lower.starts_with("mcp__") {
        return Some(lower);
    }
    Some(lower)
}

fn denormalize_anthropic_tool_name(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return None;
    }
    let lower = trimmed.to_ascii_lowercase();
    if lower == "shell_command" {
        return Some("Bash".to_string());
    }
    if lower.starts_with("mcp__") {
        return Some(trimmed.to_string());
    }
    Some(trimmed.to_string())
}

fn normalize_tool_name(raw: Option<&str>, mode: &str) -> Option<String> {
    let trimmed = raw.unwrap_or("").trim();
    if trimmed.is_empty() {
        return None;
    }
    match mode {
        "anthropic" => normalize_anthropic_tool_name(trimmed),
        "anthropic_denormalize" => denormalize_anthropic_tool_name(trimmed),
        "responses" | "default" | "" => normalize_responses_function_name(Some(trimmed)),
        _ => normalize_responses_function_name(Some(trimmed)),
    }
}

fn ensure_apply_patch_schema(candidate: Option<&Value>) -> Value {
    let mut schema = match candidate {
        Some(Value::Object(map)) => map.clone(),
        _ => Map::new(),
    };

    if !schema.contains_key("type") {
        schema.insert("type".to_string(), Value::String("object".to_string()));
    }

    let mut properties = match schema.get("properties") {
        Some(Value::Object(map)) => map.clone(),
        _ => Map::new(),
    };

    let mut patch = Map::new();
    patch.insert("type".to_string(), Value::String("string".to_string()));
    patch.insert(
        "description".to_string(),
        Value::String(
            "Patch text (*** Begin Patch / *** End Patch or GNU unified diff).".to_string(),
        ),
    );
    properties.insert("patch".to_string(), Value::Object(patch));

    let mut input = Map::new();
    input.insert("type".to_string(), Value::String("string".to_string()));
    input.insert(
        "description".to_string(),
        Value::String("Alias of patch (patch text). Prefer patch.".to_string()),
    );
    properties.insert("input".to_string(), Value::Object(input));

    schema.insert("properties".to_string(), Value::Object(properties));

    let mut required: Vec<Value> = match schema.get("required") {
        Some(Value::Array(values)) => values
            .iter()
            .filter_map(|v| v.as_str().map(|s| Value::String(s.to_string())))
            .collect(),
        _ => Vec::new(),
    };
    let has_patch = required
        .iter()
        .any(|v| v.as_str().map(|s| s == "patch").unwrap_or(false));
    if !has_patch {
        required.push(Value::String("patch".to_string()));
    }
    schema.insert("required".to_string(), Value::Array(required));

    if !matches!(schema.get("additionalProperties"), Some(Value::Bool(_))) {
        schema.insert("additionalProperties".to_string(), Value::Bool(false));
    }

    Value::Object(schema)
}

fn ensure_web_search_schema(candidate: Option<&Value>) -> Value {
    let mut schema = match candidate {
        Some(Value::Object(map)) => map.clone(),
        _ => Map::new(),
    };
    if !schema.contains_key("type") {
        schema.insert("type".to_string(), Value::String("object".to_string()));
    }
    if !matches!(schema.get("properties"), Some(Value::Object(_))) {
        schema.insert("properties".to_string(), Value::Object(Map::new()));
    }
    Value::Object(schema)
}

fn normalize_generic_tool_schema(candidate: Option<&Value>) -> Option<Value> {
    let mut schema = match candidate {
        Some(Value::Object(map)) => map.clone(),
        _ => return None,
    };

    let type_is_object = schema
        .get("type")
        .and_then(Value::as_str)
        .map(|value| value.trim().eq_ignore_ascii_case("object"))
        .unwrap_or(false);
    let has_object_shape_keys = schema.contains_key("properties")
        || schema.contains_key("required")
        || schema.contains_key("additionalProperties");

    if !schema.contains_key("type") && has_object_shape_keys {
        schema.insert("type".to_string(), Value::String("object".to_string()));
    }

    let should_fill_properties = type_is_object
        || schema
            .get("type")
            .and_then(Value::as_str)
            .map(|value| value.trim().eq_ignore_ascii_case("object"))
            .unwrap_or(false);
    if should_fill_properties && !matches!(schema.get("properties"), Some(Value::Object(_))) {
        schema.insert("properties".to_string(), Value::Object(Map::new()));
    }

    if let Some(required) = schema.get("required") {
        match required {
            Value::Array(items) => {
                let normalized: Vec<Value> = items
                    .iter()
                    .filter_map(|entry| entry.as_str().map(|text| Value::String(text.to_string())))
                    .collect();
                schema.insert("required".to_string(), Value::Array(normalized));
            }
            _ => {
                schema.remove("required");
            }
        }
    }

    if let Some(additional) = schema.get("additionalProperties") {
        if !matches!(additional, Value::Bool(_) | Value::Object(_)) {
            schema.remove("additionalProperties");
        }
    }

    Some(Value::Object(schema))
}

fn enforce_builtin_tool_schema(name: &str, candidate: Option<&Value>) -> Option<Value> {
    let normalized = name.trim().to_ascii_lowercase();
    if normalized == "apply_patch" {
        return Some(ensure_apply_patch_schema(candidate));
    }
    if normalized == "web_search" {
        return Some(ensure_web_search_schema(candidate));
    }
    normalize_generic_tool_schema(candidate)
}

fn resolve_tool_name(candidates: &[Option<&Value>], sanitize_mode: &str) -> Option<String> {
    for candidate in candidates {
        let raw = candidate.and_then(|v| v.as_str());
        let normalized = normalize_tool_name(raw, sanitize_mode);
        if let Some(name) = normalized {
            if !name.trim().is_empty() {
                return Some(name.trim().to_string());
            }
        }
    }
    None
}

fn bridge_tool_to_chat_definition_impl(tool: &Value, sanitize_mode: &str) -> Option<Value> {
    let tool_row = tool.as_object()?;
    let fn_row = tool_row.get("function").and_then(|v| v.as_object());
    let raw_type =
        read_trimmed_string(tool_row.get("type")).unwrap_or_else(|| "function".to_string());

    let mut name = resolve_tool_name(
        &[fn_row.and_then(|row| row.get("name")), tool_row.get("name")],
        sanitize_mode,
    );
    if name.is_none() {
        let lowered = raw_type.trim().to_ascii_lowercase();
        if lowered == "web_search" || lowered.starts_with("web_search") {
            name = Some("web_search".to_string());
        }
    }
    let name = name?;

    let description = read_trimmed_string(
        fn_row
            .and_then(|row| row.get("description"))
            .or_else(|| tool_row.get("description")),
    );
    let parameters = enforce_builtin_tool_schema(
        name.as_str(),
        fn_row
            .and_then(|row| row.get("parameters"))
            .or_else(|| tool_row.get("parameters")),
    );
    let strict = fn_row
        .and_then(|row| row.get("strict"))
        .or_else(|| tool_row.get("strict"))
        .and_then(|v| v.as_bool());

    let normalized_type = if raw_type.trim().eq_ignore_ascii_case("custom") {
        "function".to_string()
    } else {
        raw_type.trim().to_string()
    };

    let mut fn_out = Map::new();
    fn_out.insert("name".to_string(), Value::String(name));
    if let Some(text) = description {
        fn_out.insert("description".to_string(), Value::String(text));
    }
    if let Some(params) = parameters {
        fn_out.insert("parameters".to_string(), params);
    }
    if let Some(flag) = strict {
        fn_out.insert("strict".to_string(), Value::Bool(flag));
    }

    let mut out = Map::new();
    out.insert("type".to_string(), Value::String(normalized_type));
    out.insert("function".to_string(), Value::Object(fn_out));
    Some(Value::Object(out))
}

fn chat_tool_to_bridge_definition_impl(tool: &Value, sanitize_mode: &str) -> Option<Value> {
    let tool_row = tool.as_object()?;
    let fn_row = tool_row.get("function").and_then(|v| v.as_object());
    let name = resolve_tool_name(
        &[fn_row.and_then(|row| row.get("name")), tool_row.get("name")],
        sanitize_mode,
    )?;

    let description = read_trimmed_string(fn_row.and_then(|row| row.get("description")));
    let parameters =
        enforce_builtin_tool_schema(name.as_str(), fn_row.and_then(|row| row.get("parameters")));
    let strict = fn_row
        .and_then(|row| row.get("strict"))
        .or_else(|| tool_row.get("strict"))
        .and_then(|v| v.as_bool());

    let normalized_type =
        read_trimmed_string(tool_row.get("type")).unwrap_or_else(|| "function".to_string());

    let mut out = Map::new();
    out.insert("type".to_string(), Value::String(normalized_type));
    out.insert("name".to_string(), Value::String(name.clone()));
    if let Some(text) = description.clone() {
        out.insert("description".to_string(), Value::String(text));
    }
    if let Some(params) = parameters.clone() {
        out.insert("parameters".to_string(), params);
    }
    if let Some(flag) = strict {
        out.insert("strict".to_string(), Value::Bool(flag));
    }

    let mut fn_out = Map::new();
    fn_out.insert("name".to_string(), Value::String(name));
    if let Some(text) = description {
        fn_out.insert("description".to_string(), Value::String(text));
    }
    if let Some(params) = parameters {
        fn_out.insert("parameters".to_string(), params);
    }
    if let Some(flag) = strict {
        fn_out.insert("strict".to_string(), Value::Bool(flag));
    }
    out.insert("function".to_string(), Value::Object(fn_out));

    Some(Value::Object(out))
}

fn resolve_sanitize_mode(options: Option<&ToolMappingOptions>) -> String {
    options
        .and_then(|o| o.sanitize_mode.clone())
        .unwrap_or_else(|| "responses".to_string())
}

#[napi]
pub fn bridge_tool_to_chat_definition_json(input_json: String) -> NapiResult<String> {
    let input: ToolMappingSingleInput =
        serde_json::from_str(&input_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let sanitize_mode = resolve_sanitize_mode(input.options.as_ref());
    let output = bridge_tool_to_chat_definition_impl(&input.tool, sanitize_mode.as_str());
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi]
pub fn chat_tool_to_bridge_definition_json(input_json: String) -> NapiResult<String> {
    let input: ToolMappingSingleInput =
        serde_json::from_str(&input_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let sanitize_mode = resolve_sanitize_mode(input.options.as_ref());
    let output = chat_tool_to_bridge_definition_impl(&input.tool, sanitize_mode.as_str());
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi]
pub fn map_bridge_tools_to_chat_with_options_json(input_json: String) -> NapiResult<String> {
    let input: ToolMappingListInput =
        serde_json::from_str(&input_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let sanitize_mode = resolve_sanitize_mode(input.options.as_ref());
    let rows = input.tools.as_array().cloned().unwrap_or_default();
    let mut mapped: Vec<Value> = Vec::new();
    for tool in rows {
        if let Some(converted) = bridge_tool_to_chat_definition_impl(&tool, sanitize_mode.as_str())
        {
            mapped.push(converted);
        }
    }
    serde_json::to_string(&Value::Array(mapped))
        .map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi]
pub fn map_chat_tools_to_bridge_with_options_json(input_json: String) -> NapiResult<String> {
    let input: ToolMappingListInput =
        serde_json::from_str(&input_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let sanitize_mode = resolve_sanitize_mode(input.options.as_ref());
    let rows = input.tools.as_array().cloned().unwrap_or_default();
    let mut mapped: Vec<Value> = Vec::new();
    for tool in rows {
        if let Some(converted) = chat_tool_to_bridge_definition_impl(&tool, sanitize_mode.as_str())
        {
            mapped.push(converted);
        }
    }
    serde_json::to_string(&Value::Array(mapped))
        .map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bridge_tool_to_chat_definition_web_search() {
        let input = serde_json::json!({
          "tool": { "type": "web_search" },
          "options": { "sanitizeMode": "responses" }
        });
        let raw = bridge_tool_to_chat_definition_json(input.to_string()).unwrap();
        let parsed: Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(parsed["type"], "web_search");
        assert_eq!(parsed["function"]["name"], "web_search");
    }

    #[test]
    fn chat_tool_to_bridge_definition_anthropic_denormalize() {
        let input = serde_json::json!({
          "tool": { "type": "function", "function": { "name": "shell_command", "parameters": {} } },
          "options": { "sanitizeMode": "anthropic_denormalize" }
        });
        let raw = chat_tool_to_bridge_definition_json(input.to_string()).unwrap();
        let parsed: Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(parsed["name"], "Bash");
        assert_eq!(parsed["function"]["name"], "Bash");
    }

    #[test]
    fn chat_tool_to_bridge_definition_fills_missing_object_properties() {
        let input = serde_json::json!({
          "tool": {
            "type": "function",
            "function": {
              "name": "user_ask",
              "parameters": {
                "type": "object",
                "additionalProperties": true
              }
            }
          },
          "options": { "sanitizeMode": "responses" }
        });
        let raw = chat_tool_to_bridge_definition_json(input.to_string()).unwrap();
        let parsed: Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(parsed["name"], "user_ask");
        assert_eq!(parsed["parameters"]["type"], "object");
        assert_eq!(parsed["parameters"]["additionalProperties"], true);
        assert!(parsed["parameters"]["properties"].is_object());
    }

    #[test]
    fn chat_tool_to_bridge_definition_sanitizes_required_shape() {
        let input = serde_json::json!({
          "tool": {
            "type": "function",
            "function": {
              "name": "user_ask",
              "parameters": {
                "type": "object",
                "properties": {},
                "required": ["ok", 1, null]
              }
            }
          },
          "options": { "sanitizeMode": "responses" }
        });
        let raw = chat_tool_to_bridge_definition_json(input.to_string()).unwrap();
        let parsed: Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(parsed["parameters"]["required"], serde_json::json!(["ok"]));
    }

    #[test]
    fn map_chat_tools_to_bridge_normalizes_user_ask_with_web_search_present() {
        let input = serde_json::json!({
          "tools": [
            {
              "type": "function",
              "function": {
                "name": "web_search",
                "parameters": {
                  "type": "object",
                  "properties": {
                    "query": { "type": "string" }
                  },
                  "additionalProperties": false
                }
              }
            },
            {
              "type": "function",
              "function": {
                "name": "user_ask",
                "parameters": {
                  "type": "object",
                  "additionalProperties": true
                }
              }
            }
          ],
          "options": { "sanitizeMode": "responses" }
        });
        let raw = map_chat_tools_to_bridge_with_options_json(input.to_string()).unwrap();
        let parsed: Value = serde_json::from_str(&raw).unwrap();
        let rows = parsed.as_array().unwrap();
        let user = rows
            .iter()
            .find(|entry| entry["name"] == "user_ask")
            .expect("user_ask tool should exist");
        assert_eq!(user["parameters"]["type"], "object");
        assert!(user["parameters"]["properties"].is_object());
        assert_eq!(user["parameters"]["additionalProperties"], true);
    }
}
