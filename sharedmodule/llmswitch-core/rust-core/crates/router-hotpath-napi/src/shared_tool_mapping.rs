use napi::bindgen_prelude::Result as NapiResult;
use napi_derive::napi;
use serde::Deserialize;
use serde_json::{Map, Value};
use std::collections::HashSet;

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

fn namespace_match_joiner(namespace: &str) -> &'static str {
    let trimmed = namespace.trim();
    if trimmed.ends_with("__")
        || trimmed.ends_with('_')
        || trimmed.ends_with('.')
        || trimmed.ends_with('/')
        || trimmed.ends_with('-')
    {
        ""
    } else {
        "__"
    }
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

pub(crate) fn enforce_builtin_tool_schema(name: &str, candidate: Option<&Value>) -> Option<Value> {
    let normalized = name.trim().to_ascii_lowercase();
    if normalized == "web_search" || normalized.starts_with("web_search") {
        return Some(ensure_web_search_schema(candidate));
    }
    normalize_generic_tool_schema(candidate)
}

pub(crate) fn rewrite_builtin_tool_description(
    name: &str,
    existing: Option<&Value>,
) -> Option<String> {
    let _ = name;
    read_trimmed_string(existing)
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

fn read_defer_loading(value: Option<&Value>) -> Option<bool> {
    value.and_then(|v| v.as_bool()).filter(|flag| *flag)
}

fn normalize_namespace_name(value: Option<&Value>) -> Option<String> {
    read_trimmed_string(value)
}

pub(crate) fn build_flattened_namespace_child_alias(
    namespace: &str,
    child_name: &str,
    sanitize_mode: &str,
    used_aliases: &HashSet<String>,
) -> Option<String> {
    let namespace = namespace.trim();
    let child_name = child_name.trim();
    if namespace.is_empty() || child_name.is_empty() {
        return None;
    }

    let base_raw = format!(
        "{}{}{}",
        namespace,
        namespace_match_joiner(namespace),
        child_name
    );
    let base_alias = normalize_tool_name(Some(base_raw.as_str()), sanitize_mode)
        .or_else(|| normalize_tool_name(Some(child_name), sanitize_mode))?;
    if !used_aliases.contains(base_alias.as_str()) {
        return Some(base_alias);
    }

    for suffix in 2..=999 {
        let candidate_raw = format!("{base_raw}__{suffix}");
        if let Some(candidate) = normalize_tool_name(Some(candidate_raw.as_str()), sanitize_mode) {
            if !used_aliases.contains(candidate.as_str()) {
                return Some(candidate);
            }
        }
    }

    None
}

fn build_namespace_child_function(
    tool_row: &Map<String, Value>,
    sanitize_mode: &str,
) -> Option<Value> {
    let fn_row = tool_row.get("function").and_then(|v| v.as_object());
    let name = resolve_tool_name(
        &[fn_row.and_then(|row| row.get("name")), tool_row.get("name")],
        sanitize_mode,
    )?;
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
    let defer_loading = read_defer_loading(
        fn_row
            .and_then(|row| row.get("defer_loading"))
            .or_else(|| fn_row.and_then(|row| row.get("deferLoading")))
            .or_else(|| tool_row.get("defer_loading"))
            .or_else(|| tool_row.get("deferLoading")),
    );

    let mut out = Map::new();
    out.insert("type".to_string(), Value::String("function".to_string()));
    out.insert("name".to_string(), Value::String(name.clone()));
    if let Some(text) = description {
        out.insert("description".to_string(), Value::String(text));
    }
    if let Some(params) = parameters {
        out.insert("parameters".to_string(), params);
    }
    if let Some(flag) = strict {
        out.insert("strict".to_string(), Value::Bool(flag));
    }
    if let Some(flag) = defer_loading {
        out.insert("defer_loading".to_string(), Value::Bool(flag));
    }
    Some(Value::Object(out))
}

fn bridge_namespace_to_chat_definition(
    tool_row: &Map<String, Value>,
    sanitize_mode: &str,
) -> Option<Value> {
    let namespace_name = normalize_namespace_name(tool_row.get("name"))?;
    let description = read_trimmed_string(tool_row.get("description"));
    let child_tools = tool_row
        .get("tools")
        .and_then(Value::as_array)
        .map(|rows| {
            rows.iter()
                .filter_map(|entry| {
                    let child_row = entry.as_object()?;
                    build_namespace_child_function(child_row, sanitize_mode)
                })
                .collect::<Vec<Value>>()
        })
        .unwrap_or_default();
    if child_tools.is_empty() {
        return None;
    }

    let mut out = Map::new();
    out.insert("type".to_string(), Value::String("namespace".to_string()));
    out.insert("name".to_string(), Value::String(namespace_name));
    if let Some(text) = description {
        out.insert("description".to_string(), Value::String(text));
    }
    out.insert("tools".to_string(), Value::Array(child_tools));
    Some(Value::Object(out))
}

fn chat_namespace_to_bridge_definition(
    tool_row: &Map<String, Value>,
    sanitize_mode: &str,
) -> Option<Value> {
    let namespace_name = normalize_namespace_name(tool_row.get("name"))?;
    let description = read_trimmed_string(tool_row.get("description"));
    let child_tools = tool_row
        .get("tools")
        .and_then(Value::as_array)
        .map(|rows| {
            rows.iter()
                .filter_map(|entry| {
                    let child_row = entry.as_object()?;
                    build_namespace_child_function(child_row, sanitize_mode)
                })
                .collect::<Vec<Value>>()
        })
        .unwrap_or_default();
    if child_tools.is_empty() {
        return None;
    }

    let mut out = Map::new();
    out.insert("type".to_string(), Value::String("namespace".to_string()));
    out.insert("name".to_string(), Value::String(namespace_name));
    if let Some(text) = description {
        out.insert("description".to_string(), Value::String(text));
    }
    out.insert("tools".to_string(), Value::Array(child_tools));
    Some(Value::Object(out))
}

fn bridge_tool_to_chat_definition_impl(tool: &Value, sanitize_mode: &str) -> Option<Value> {
    let tool_row = tool.as_object()?;
    let fn_row = tool_row.get("function").and_then(|v| v.as_object());
    let raw_type =
        read_trimmed_string(tool_row.get("type")).unwrap_or_else(|| "function".to_string());
    if raw_type.trim().eq_ignore_ascii_case("namespace") {
        return bridge_namespace_to_chat_definition(tool_row, sanitize_mode);
    }

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
    fn_out.insert("name".to_string(), Value::String(name.clone()));
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
    let raw_type =
        read_trimmed_string(tool_row.get("type")).unwrap_or_else(|| "function".to_string());
    if raw_type.trim().eq_ignore_ascii_case("namespace") {
        return chat_namespace_to_bridge_definition(tool_row, sanitize_mode);
    }
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

    let normalized_type = raw_type;

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
    fn_out.insert("name".to_string(), Value::String(name.clone()));
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

fn flatten_namespace_chat_tool(
    tool_row: &Map<String, Value>,
    sanitize_mode: &str,
    used_aliases: &mut HashSet<String>,
) -> Vec<Value> {
    let Some(namespace_name) = normalize_namespace_name(tool_row.get("name")) else {
        return Vec::new();
    };
    let Some(child_rows) = tool_row.get("tools").and_then(Value::as_array) else {
        return Vec::new();
    };

    let mut flattened = Vec::new();
    for child in child_rows {
        let Some(child_row) = child.as_object() else {
            continue;
        };
        let Some(child_def) = build_namespace_child_function(child_row, sanitize_mode) else {
            continue;
        };
        let Some(child_def_row) = child_def.as_object() else {
            continue;
        };
        let Some(child_name) = child_def_row.get("name").and_then(Value::as_str) else {
            continue;
        };
        let Some(flattened_name) = build_flattened_namespace_child_alias(
            namespace_name.as_str(),
            child_name,
            sanitize_mode,
            used_aliases,
        ) else {
            continue;
        };
        used_aliases.insert(flattened_name.clone());

        let mut fn_row = Map::new();
        fn_row.insert("name".to_string(), Value::String(flattened_name.clone()));
        if let Some(description) = child_def_row.get("description").cloned() {
            fn_row.insert("description".to_string(), description);
        }
        if let Some(parameters) = child_def_row.get("parameters").cloned() {
            fn_row.insert("parameters".to_string(), parameters);
        }
        if let Some(strict) = child_def_row.get("strict").cloned() {
            fn_row.insert("strict".to_string(), strict);
        }

        let mut out = Map::new();
        out.insert("type".to_string(), Value::String("function".to_string()));
        out.insert("function".to_string(), Value::Object(fn_row));
        if let Some(defer_loading) = child_def_row.get("defer_loading").cloned() {
            out.insert("defer_loading".to_string(), defer_loading);
        }
        flattened.push(Value::Object(out));
    }

    flattened
}

pub(crate) fn flatten_chat_tools_for_function_calling(
    tools: &[Value],
    sanitize_mode: &str,
) -> Vec<Value> {
    let mut flattened = Vec::new();
    let mut used_aliases = HashSet::<String>::new();

    for tool in tools {
        let Some(tool_row) = tool.as_object() else {
            continue;
        };
        let raw_type =
            read_trimmed_string(tool_row.get("type")).unwrap_or_else(|| "function".to_string());
        if raw_type.trim().eq_ignore_ascii_case("namespace") {
            flattened.extend(flatten_namespace_chat_tool(
                tool_row,
                sanitize_mode,
                &mut used_aliases,
            ));
            continue;
        }

        if let Some(name) = tool_row
            .get("function")
            .and_then(Value::as_object)
            .and_then(|row| row.get("name"))
            .and_then(Value::as_str)
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
            .or_else(|| {
                tool_row
                    .get("name")
                    .and_then(Value::as_str)
                    .map(|value| value.trim().to_string())
                    .filter(|value| !value.is_empty())
            })
        {
            used_aliases.insert(name);
        }
        flattened.push(Value::Object(tool_row.clone()));
    }

    flattened
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

#[napi]
pub fn flatten_chat_tools_for_function_calling_with_options_json(
    input_json: String,
) -> NapiResult<String> {
    let input: ToolMappingListInput =
        serde_json::from_str(&input_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let sanitize_mode = resolve_sanitize_mode(input.options.as_ref());
    let rows = input.tools.as_array().cloned().unwrap_or_default();
    let flattened =
        flatten_chat_tools_for_function_calling(rows.as_slice(), sanitize_mode.as_str());
    serde_json::to_string(&Value::Array(flattened))
        .map_err(|e| napi::Error::from_reason(e.to_string()))
}

/// Canonicalize an Anthropic tool name to its normalized lowercase form.
///
/// Applies these rules:
/// - Empty/whitespace-only names → `None`
/// - `bash` / `shell` / `terminal` → `shell_command`
/// - `mcp__*` → lowercase passthrough
/// - Everything else → lowercase
pub(crate) fn normalize_anthropic_tool_name(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return None;
    }
    let lower = trimmed.to_ascii_lowercase();
    match lower.as_str() {
        "bash" | "shell" | "terminal" => return Some("shell_command".to_string()),
        _ => {}
    }
    if lower.starts_with("mcp__") {
        return Some(lower);
    }
    Some(lower)
}

/// Build a bidirectional alias map from a slice of raw tool definitions.
///
/// For each tool with a non-empty `name` field:
/// 1. Canonicalize the name via `normalize_anthropic_tool_name`
/// 2. Map `canonical → original_name`
/// 3. Also map `canonical_lowercase → original_name` when different
///
/// Returns `None` when the input is empty or no valid entries were found.
pub(crate) fn build_anthropic_tool_alias_map_from_slice(
    raw_tools: &[Value],
) -> Option<Map<String, Value>> {
    if raw_tools.is_empty() {
        return None;
    }

    let mut alias_map: Map<String, Value> = Map::new();
    for entry in raw_tools {
        let raw_name = match read_tool_name(entry) {
            Some(v) => v,
            None => continue,
        };
        let normalized =
            normalize_anthropic_tool_name(raw_name.as_str()).unwrap_or(raw_name.clone());
        let canonical_key = normalized.trim().to_string();
        if canonical_key.is_empty() {
            continue;
        }

        alias_map.insert(canonical_key.clone(), Value::String(raw_name.clone()));
        let lower_key = canonical_key.to_ascii_lowercase();
        if lower_key != canonical_key && !alias_map.contains_key(lower_key.as_str()) {
            alias_map.insert(lower_key, Value::String(raw_name));
        }
    }

    if alias_map.is_empty() {
        return None;
    }
    Some(alias_map)
}

/// Build a bidirectional alias map from a JSON array value of raw tool definitions.
///
/// Convenience wrapper around [`build_anthropic_tool_alias_map_from_slice`].
pub(crate) fn build_anthropic_tool_alias_map(raw_tools: &Value) -> Option<Map<String, Value>> {
    let rows = raw_tools.as_array()?;
    build_anthropic_tool_alias_map_from_slice(rows)
}

fn read_tool_name(entry: &Value) -> Option<String> {
    let obj = entry.as_object()?;
    let raw = obj.get("name")?.as_str()?.trim().to_string();
    if raw.is_empty() {
        return None;
    }
    Some(raw)
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

    #[test]
    fn bridge_tool_to_chat_definition_preserves_namespace_child_tools() {
        let input = serde_json::json!({
          "tool": {
            "type": "namespace",
            "name": "mcp__computer_use",
            "description": "Computer Use",
            "tools": [
              {
                "type": "function",
                "name": "get_app_state",
                "description": "Inspect app state",
                "parameters": { "type": "object", "properties": {} },
                "defer_loading": true
              }
            ]
          },
          "options": { "sanitizeMode": "responses" }
        });
        let raw = bridge_tool_to_chat_definition_json(input.to_string()).unwrap();
        let parsed: Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(parsed["type"], "namespace");
        assert_eq!(parsed["name"], "mcp__computer_use");
        assert_eq!(parsed["tools"][0]["name"], "get_app_state");
        assert_eq!(parsed["tools"][0]["defer_loading"], Value::Bool(true));
    }

    #[test]
    fn chat_tool_to_bridge_definition_preserves_namespace_child_tools() {
        let input = serde_json::json!({
          "tool": {
            "type": "namespace",
            "name": "mcp__computer_use",
            "description": "Computer Use",
            "tools": [
              {
                "type": "function",
                "name": "press_key",
                "description": "Press a key",
                "parameters": { "type": "object", "properties": {} },
                "defer_loading": true
              }
            ]
          },
          "options": { "sanitizeMode": "responses" }
        });
        let raw = chat_tool_to_bridge_definition_json(input.to_string()).unwrap();
        let parsed: Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(parsed["type"], "namespace");
        assert_eq!(parsed["name"], "mcp__computer_use");
        assert_eq!(parsed["tools"][0]["name"], "press_key");
        assert_eq!(parsed["tools"][0]["defer_loading"], Value::Bool(true));
    }

    #[test]
    fn flatten_chat_tools_for_function_calling_flattens_namespace_children() {
        let input = serde_json::json!({
            "tools": [
                {
                    "type": "namespace",
                    "name": "mcp__computer_use__",
                    "description": "Computer Use tools",
                    "tools": [
                        {
                            "type": "function",
                            "name": "get_app_state",
                            "description": "Read app state",
                            "defer_loading": true,
                            "parameters": {
                                "type": "object",
                                "properties": {
                                    "app": { "type": "string" }
                                }
                            }
                        },
                        {
                            "type": "function",
                            "name": "click",
                            "parameters": {
                                "type": "object",
                                "properties": {
                                    "x": { "type": "number" }
                                }
                            }
                        }
                    ]
                }
            ],
            "options": {
                "sanitizeMode": "responses"
            }
        });

        let raw =
            flatten_chat_tools_for_function_calling_with_options_json(input.to_string()).unwrap();
        let parsed: Value = serde_json::from_str(&raw).unwrap();
        let arr = parsed.as_array().unwrap();
        assert_eq!(arr.len(), 2);
        assert_eq!(
            arr[0]["function"]["name"],
            Value::String("mcp__computer_use__get_app_state".to_string())
        );
        assert_eq!(arr[0]["defer_loading"], Value::Bool(true));
        assert_eq!(
            arr[1]["function"]["name"],
            Value::String("mcp__computer_use__click".to_string())
        );
    }
}
