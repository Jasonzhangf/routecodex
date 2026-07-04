use napi::bindgen_prelude::Result as NapiResult;
use napi_derive::napi;
use regex::Regex;
use serde::Deserialize;
use serde_json::{Map, Value};
use std::collections::{HashMap, HashSet};
#[cfg(test)]
use std::{fs, path::PathBuf};

use crate::hub_resp_outbound_client_semantics::normalize_responses_function_name;
use crate::shared_json_utils::read_trimmed_string;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ToolMappingOptions {
    sanitize_mode: Option<String>,
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

pub(crate) fn strip_function_namespace(value: &str) -> String {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    let lowered = trimmed.to_ascii_lowercase();
    if lowered.starts_with("functions.") {
        return trimmed["functions.".len()..].trim().to_string();
    }
    if lowered.starts_with("function.") {
        return trimmed["function.".len()..].trim().to_string();
    }
    trimmed.to_string()
}

pub(crate) fn to_canonical_tool_name(value: &str) -> String {
    let stripped = strip_function_namespace(value);
    let result: String = stripped
        .to_ascii_lowercase()
        .chars()
        .map(|ch| {
            if ch == ' ' || ch == '_' || ch == '-' {
                '.'
            } else {
                ch
            }
        })
        .collect();
    let mut collapsed = String::new();
    let mut prev_dot = false;
    for ch in result.chars() {
        if ch == '.' {
            if !prev_dot {
                collapsed.push('.');
                prev_dot = true;
            }
        } else {
            collapsed.push(ch);
            prev_dot = false;
        }
    }
    collapsed.trim_matches('.').to_string()
}

pub(crate) fn to_compact_tool_name(value: &str) -> String {
    to_canonical_tool_name(value).replace('.', "")
}

pub(crate) fn normalize_routecodex_tool_name(raw: Option<&str>) -> Option<String> {
    let trimmed = raw.unwrap_or("").trim();
    if trimmed.is_empty() {
        return None;
    }
    let stripped = strip_function_namespace(trimmed);
    let without_prefix = stripped.trim();
    if without_prefix.is_empty() {
        return None;
    }
    let normalized = normalize_responses_function_name(Some(without_prefix))
        .unwrap_or_else(|| without_prefix.to_string());
    let lowered = normalized.to_ascii_lowercase();
    if matches!(
        lowered.as_str(),
        "execute"
            | "execute_command"
            | "execute-command"
            | "shell-command"
            | "shell_command"
            | "shell"
            | "bash"
            | "terminal"
    ) {
        return Some("exec_command".to_string());
    }
    Some(normalized)
}

pub(crate) fn normalize_routecodex_tool_name_value(value: Option<&Value>) -> Option<String> {
    normalize_routecodex_tool_name(value.and_then(Value::as_str))
        .map(|text| text.to_ascii_lowercase())
}

pub(crate) fn resolve_routecodex_tool_identity(tool: &Value) -> Option<String> {
    let record = tool.as_object()?;
    let function_name = record
        .get("function")
        .and_then(Value::as_object)
        .and_then(|row| normalize_routecodex_tool_name_value(row.get("name")));
    if function_name.is_some() {
        return function_name;
    }
    let direct_name = normalize_routecodex_tool_name_value(record.get("name"));
    if direct_name.is_some() {
        return direct_name;
    }
    normalize_routecodex_tool_name_value(record.get("type"))
}

pub(crate) fn normalize_routecodex_tool_name_with_embedded_hint(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    let extracted_embedded =
        Regex::new(r#"(?i)(?:^|[\s(<])(?:tool:|function:)([A-Za-z_][A-Za-z0-9_.-]*)"#)
            .expect("valid embedded tool name pattern")
            .captures(trimmed)
            .and_then(|caps| caps.get(1))
            .map(|value| value.as_str().trim().to_string())
            .filter(|value| !value.is_empty());
    let normalized_input = extracted_embedded.unwrap_or_else(|| trimmed.to_string());
    normalize_routecodex_tool_name(Some(normalized_input.as_str()))
        .or_else(|| normalize_responses_function_name(Some(normalized_input.as_str())))
}

pub(crate) fn is_routecodex_explicit_tool_name_candidate(raw: &str) -> bool {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return false;
    }
    if is_routecodex_structured_tool_name(trimmed) {
        return true;
    }
    let lowered = trimmed.to_ascii_lowercase();
    if lowered.starts_with("functions.")
        || lowered.contains("tool:")
        || lowered.contains("function:")
        || lowered.contains("[tool_call")
        || lowered.contains("[function_call")
    {
        let normalized =
            normalize_routecodex_tool_name_with_embedded_hint(trimmed).unwrap_or_else(|| {
                normalize_responses_function_name(Some(trimmed))
                    .unwrap_or_else(|| trimmed.to_string())
            });
        return is_routecodex_structured_tool_name(normalized.as_str());
    }
    false
}

pub(crate) fn is_routecodex_structured_tool_name(raw: &str) -> bool {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return false;
    }
    if !trimmed
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || ch == '_' || ch == '.' || ch == '-')
    {
        return false;
    }
    trimmed
        .chars()
        .any(|ch| ch.is_ascii_alphanumeric() || ch == '_')
}

pub(crate) fn normalize_json_tool_name_with_aliases(
    raw: &str,
    alias_map: Option<&HashMap<String, String>>,
) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    if let Some(normalized) = normalize_routecodex_tool_name(Some(trimmed)) {
        return Some(normalized);
    }
    let canonical = to_canonical_tool_name(trimmed);
    let mapped = alias_map
        .and_then(|aliases| aliases.get(canonical.as_str()).cloned())
        .unwrap_or(canonical);
    if let Some(normalized) = normalize_routecodex_tool_name(Some(mapped.as_str())) {
        return Some(normalized);
    }
    if is_routecodex_structured_tool_name(mapped.as_str()) {
        return Some(mapped);
    }
    None
}

pub(crate) fn resolve_routecodex_json_tool_name_aliases(
    overrides: Option<&HashMap<String, String>>,
) -> HashMap<String, String> {
    let mut merged: HashMap<String, String> = HashMap::new();
    for (src, dst) in [
        ("shell_command".to_string(), "exec_command".to_string()),
        ("execute".to_string(), "exec_command".to_string()),
        ("execute_command".to_string(), "exec_command".to_string()),
        ("execute-command".to_string(), "exec_command".to_string()),
        ("shell".to_string(), "exec_command".to_string()),
        ("bash".to_string(), "exec_command".to_string()),
        ("terminal".to_string(), "exec_command".to_string()),
    ] {
        let canonical_src = to_canonical_tool_name(src.as_str());
        let normalized_dst =
            normalize_routecodex_tool_name(Some(dst.as_str())).unwrap_or_else(|| dst.clone());
        merged.insert(canonical_src.clone(), normalized_dst.clone());
        let lowered_src = src.trim().to_ascii_lowercase();
        if lowered_src != canonical_src {
            merged.insert(lowered_src, normalized_dst);
        }
    }
    if let Some(alias_map) = overrides {
        for (k, v) in alias_map.iter() {
            let src = to_canonical_tool_name(k.as_str());
            let dst = normalize_routecodex_tool_name(Some(v.as_str()))
                .unwrap_or_else(|| v.trim().to_ascii_lowercase());
            if !src.is_empty() && !dst.is_empty() {
                merged.insert(src, dst);
            }
        }
    }
    merged
}

pub(crate) fn read_routecodex_json_tool_name_hint_from_args(
    raw_args: Option<&Value>,
    alias_map: Option<&HashMap<String, String>>,
) -> Option<String> {
    fn scan(
        value: &Value,
        depth: usize,
        alias_map: Option<&HashMap<String, String>>,
    ) -> Option<String> {
        if depth == 0 {
            return None;
        }
        let obj = value.as_object()?;
        if let Some(raw_name) = obj
            .get("name")
            .and_then(Value::as_str)
            .map(|v| v.trim())
            .filter(|v| !v.is_empty())
        {
            return normalize_json_tool_name_with_aliases(raw_name, alias_map);
        }
        for key in [
            "function",
            "input",
            "args",
            "payload",
            "parameters",
            "params",
        ] {
            if let Some(child) = obj.get(key) {
                if let Some(found) = scan(child, depth - 1, alias_map) {
                    return Some(found);
                }
            }
        }
        None
    }

    match raw_args {
        Some(Value::Object(_)) => scan(raw_args?, 4, alias_map),
        Some(Value::Array(items)) => items.iter().find_map(|item| scan(item, 3, alias_map)),
        _ => None,
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

fn resolve_tool_name(candidates: &[Option<&Value>], sanitize_mode: &str) -> Option<String> {
    for candidate in candidates {
        let raw = candidate.and_then(|v| v.as_str());
        let normalized = match sanitize_mode {
            "anthropic" => normalize_anthropic_tool_name(raw.unwrap_or("").trim()),
            "anthropic_denormalize" => denormalize_anthropic_tool_name(raw.unwrap_or("").trim()),
            "responses" | "default" | "" => {
                normalize_routecodex_tool_name(Some(raw.unwrap_or("").trim()))
            }
            _ => normalize_routecodex_tool_name(Some(raw.unwrap_or("").trim())),
        };
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
    let normalize_for_mode = |raw: &str| match sanitize_mode {
        "anthropic" => normalize_anthropic_tool_name(raw.trim()),
        "anthropic_denormalize" => denormalize_anthropic_tool_name(raw.trim()),
        "responses" | "default" | "" => normalize_routecodex_tool_name(Some(raw.trim())),
        _ => normalize_routecodex_tool_name(Some(raw.trim())),
    };
    let base_alias =
        normalize_for_mode(base_raw.as_str()).or_else(|| normalize_for_mode(child_name))?;
    if !used_aliases.contains(base_alias.as_str()) {
        return Some(base_alias);
    }

    for suffix in 2..=999 {
        let candidate_raw = format!("{base_raw}__{suffix}");
        if let Some(candidate) = normalize_for_mode(candidate_raw.as_str()) {
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

pub(crate) fn read_routecodex_tool_name_hint_from_args(raw_args: Option<&Value>) -> Option<String> {
    let default_aliases = resolve_routecodex_json_tool_name_aliases(None);
    read_routecodex_json_tool_name_hint_from_args(raw_args, Some(&default_aliases))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn crate_src_path(relative: &str) -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("src")
            .join(relative)
    }

    #[test]
    fn requested_tools_deletion_gate_removed_local_requested_tool_name_key_wrapper() {
        let path = crate_src_path("resp_process_stage1_tool_governance_blocks/requested_tools.rs");
        let source = fs::read_to_string(&path)
            .unwrap_or_else(|error| panic!("failed to read {}: {}", path.display(), error));
        assert!(
            !source.contains(
                "fn normalize_requested_tool_name_key(raw_name: &str) -> Option<String> {"
            ),
            "requested_tools.rs still owns local normalize_requested_tool_name_key wrapper"
        );
        assert!(
            source.contains("normalize_routecodex_tool_name(Some(raw_name)).map(|key| key.to_ascii_lowercase())")
                || source.contains("normalize_routecodex_tool_name(Some(raw_name.as_str())).map(|key| key.to_ascii_lowercase())"),
            "requested_tools.rs must route requested tool key canonicalization through shared normalize_routecodex_tool_name truth"
        );
    }

    #[test]
    fn normalize_tool_name_responses_mode_canonicalizes_routecodex_tool_aliases() {
        assert_eq!(
            normalize_routecodex_tool_name(Some("websearch")),
            Some("web_search".to_string())
        );
        assert_eq!(
            normalize_routecodex_tool_name(Some("web-search")),
            Some("web_search".to_string())
        );
        assert_eq!(
            normalize_routecodex_tool_name(Some("bash")),
            Some("exec_command".to_string())
        );
        assert_eq!(
            normalize_routecodex_tool_name(Some("shell_command")),
            Some("exec_command".to_string())
        );
        assert_eq!(
            normalize_routecodex_tool_name(Some("functions.execute_command")),
            Some("exec_command".to_string())
        );
    }

    #[test]
    fn explicit_tool_name_candidate_uses_embedded_hint_truth() {
        assert!(is_routecodex_explicit_tool_name_candidate("exec_command"));
        assert!(is_routecodex_explicit_tool_name_candidate(
            "function:websearch"
        ));
        assert!(is_routecodex_explicit_tool_name_candidate(
            "tool:exec_command"
        ));
        assert!(!is_routecodex_explicit_tool_name_candidate(
            "not a tool call"
        ));
    }

    #[test]
    fn resolve_routecodex_json_tool_name_aliases_merges_overrides() {
        let overrides = HashMap::from([("websearch".to_string(), "web_search".to_string())]);
        let aliases = resolve_routecodex_json_tool_name_aliases(Some(&overrides));
        assert_eq!(aliases.get("bash"), Some(&"exec_command".to_string()));
        assert_eq!(aliases.get("websearch"), Some(&"web_search".to_string()));
    }

    #[test]
    fn read_routecodex_json_tool_name_hint_from_args_uses_alias_map() {
        let args = serde_json::json!({
            "payload": {
                "name": "bash"
            }
        });
        let alias_map = resolve_routecodex_json_tool_name_aliases(None);
        assert_eq!(
            read_routecodex_json_tool_name_hint_from_args(Some(&args), Some(&alias_map)),
            Some("exec_command".to_string())
        );
    }

    #[test]
    fn normalize_json_tool_name_with_aliases_preserves_exact_exec_command_shape() {
        let alias_map = resolve_routecodex_json_tool_name_aliases(None);
        assert_eq!(
            normalize_json_tool_name_with_aliases("exec_command", Some(&alias_map)),
            Some("exec_command".to_string())
        );
    }

    #[test]
    fn read_routecodex_tool_name_hint_from_args_preserves_nested_exec_command_shape() {
        let args = serde_json::json!({
            "input": {
                "cmd": "pwd",
                "name": "exec_command"
            }
        });
        assert_eq!(
            read_routecodex_tool_name_hint_from_args(Some(&args)),
            Some("exec_command".to_string())
        );
    }

    #[test]
    fn shared_tool_mapping_deletion_gate_removed_history_local_tool_identity_clones() {
        let path = crate_src_path("hub_bridge_actions/history.rs");
        let source = fs::read_to_string(&path)
            .unwrap_or_else(|error| panic!("failed to read {}: {}", path.display(), error));
        assert!(
            !source.contains("fn normalize_tool_key(value: Option<&Value>) -> Option<String>"),
            "local normalize_tool_key clone still present in {}",
            path.display()
        );
        assert!(
            !source.contains("fn resolve_tool_identity(tool: &Value) -> Option<String>"),
            "local resolve_tool_identity clone still present in {}",
            path.display()
        );
        assert!(
            source.contains("normalize_routecodex_tool_name_value(")
                && source.contains("resolve_routecodex_tool_identity("),
            "hub_bridge_actions/history.rs must use shared tool identity truth"
        );
    }

    #[test]
    fn bridge_tool_to_chat_definition_web_search() {
        let input = serde_json::json!({
          "tools": [{ "type": "web_search" }],
          "options": { "sanitizeMode": "responses" }
        });
        let raw = map_bridge_tools_to_chat_with_options_json(input.to_string()).unwrap();
        let parsed: Value = serde_json::from_str(&raw).unwrap();
        let parsed = &parsed.as_array().unwrap()[0];
        assert_eq!(parsed["type"], "web_search");
        assert_eq!(parsed["function"]["name"], "web_search");
    }

    #[test]
    fn chat_tool_to_bridge_definition_anthropic_denormalize() {
        let input = serde_json::json!({
          "tools": [{ "type": "function", "function": { "name": "shell_command", "parameters": {} } }],
          "options": { "sanitizeMode": "anthropic_denormalize" }
        });
        let raw = map_chat_tools_to_bridge_with_options_json(input.to_string()).unwrap();
        let parsed: Value = serde_json::from_str(&raw).unwrap();
        let parsed = &parsed.as_array().unwrap()[0];
        assert_eq!(parsed["name"], "Bash");
        assert_eq!(parsed["function"]["name"], "Bash");
    }

    #[test]
    fn chat_tool_to_bridge_definition_fills_missing_object_properties() {
        let input = serde_json::json!({
          "tools": [{
            "type": "function",
            "function": {
              "name": "user_ask",
              "parameters": {
                "type": "object",
                "additionalProperties": true
              }
            }
          }],
          "options": { "sanitizeMode": "responses" }
        });
        let raw = map_chat_tools_to_bridge_with_options_json(input.to_string()).unwrap();
        let parsed: Value = serde_json::from_str(&raw).unwrap();
        let parsed = &parsed.as_array().unwrap()[0];
        assert_eq!(parsed["name"], "user_ask");
        assert_eq!(parsed["parameters"]["type"], "object");
        assert_eq!(parsed["parameters"]["additionalProperties"], true);
        assert!(parsed["parameters"]["properties"].is_object());
    }

    #[test]
    fn chat_tool_to_bridge_definition_sanitizes_required_shape() {
        let input = serde_json::json!({
          "tools": [{
            "type": "function",
            "function": {
              "name": "user_ask",
              "parameters": {
                "type": "object",
                "properties": {},
                "required": ["ok", 1, null]
              }
            }
          }],
          "options": { "sanitizeMode": "responses" }
        });
        let raw = map_chat_tools_to_bridge_with_options_json(input.to_string()).unwrap();
        let parsed: Value = serde_json::from_str(&raw).unwrap();
        let parsed = &parsed.as_array().unwrap()[0];
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
          "tools": [{
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
          }],
          "options": { "sanitizeMode": "responses" }
        });
        let raw = map_bridge_tools_to_chat_with_options_json(input.to_string()).unwrap();
        let parsed: Value = serde_json::from_str(&raw).unwrap();
        let parsed = &parsed.as_array().unwrap()[0];
        assert_eq!(parsed["type"], "namespace");
        assert_eq!(parsed["name"], "mcp__computer_use");
        assert_eq!(parsed["tools"][0]["name"], "get_app_state");
        assert_eq!(parsed["tools"][0]["defer_loading"], Value::Bool(true));
    }

    #[test]
    fn chat_tool_to_bridge_definition_preserves_namespace_child_tools() {
        let input = serde_json::json!({
          "tools": [{
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
          }],
          "options": { "sanitizeMode": "responses" }
        });
        let raw = map_chat_tools_to_bridge_with_options_json(input.to_string()).unwrap();
        let parsed: Value = serde_json::from_str(&raw).unwrap();
        let parsed = &parsed.as_array().unwrap()[0];
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

    #[test]
    fn strip_function_namespace_removes_known_prefixes() {
        assert_eq!(
            strip_function_namespace("functions.exec_command"),
            "exec_command"
        );
        assert_eq!(
            strip_function_namespace("function.web-search"),
            "web-search"
        );
        assert_eq!(strip_function_namespace("exec_command"), "exec_command");
    }

    #[test]
    fn canonical_and_compact_tool_names_use_shared_mapping_rules() {
        assert_eq!(
            to_canonical_tool_name("functions.exec_command"),
            "exec.command"
        );
        assert_eq!(to_canonical_tool_name("web-search"), "web.search");
        assert_eq!(
            to_compact_tool_name("functions.exec_command"),
            "execcommand"
        );
    }

    #[test]
    fn normalize_routecodex_tool_name_normalizes_legacy_web_search_and_exec_aliases() {
        assert_eq!(
            normalize_routecodex_tool_name(Some("functions.websearch")),
            Some("web_search".to_string())
        );
        assert_eq!(
            normalize_routecodex_tool_name(Some("shell-command")),
            Some("exec_command".to_string())
        );
    }

    #[test]
    fn shared_tool_mapping_deletion_gate_removed_chat_servertool_orchestration_local_websearch_wrapper(
    ) {
        let path = crate_src_path("chat_servertool_orchestration.rs");
        let source = fs::read_to_string(&path)
            .unwrap_or_else(|error| panic!("failed to read {}: {}", path.display(), error));
        assert!(
            !source.contains("fn normalize_servertool_call_name(name: &str) -> String {"),
            "chat_servertool_orchestration.rs still owns local normalize_servertool_call_name wrapper"
        );
        assert!(
            source.contains("normalize_routecodex_tool_name(Some(name))")
                || source.contains("normalize_routecodex_tool_name(Some(entry.name.as_str()))")
                || source.contains("normalize_routecodex_tool_name(Some(raw_name.as_str()))"),
            "chat_servertool_orchestration.rs must use shared tool canonicalization truth directly"
        );
    }

    #[test]
    fn normalize_routecodex_tool_name_with_embedded_hint_extracts_tool_and_function_prefixes() {
        assert_eq!(
            normalize_routecodex_tool_name_with_embedded_hint(
                "need retry tool:functions.shell-command now"
            ),
            Some("exec_command".to_string())
        );
        assert_eq!(
            normalize_routecodex_tool_name_with_embedded_hint("(function:websearch)"),
            Some("web_search".to_string())
        );
    }

    #[test]
    fn is_routecodex_structured_tool_name_accepts_shape_only_tool_identifiers() {
        assert!(is_routecodex_structured_tool_name("exec_command"));
        assert!(is_routecodex_structured_tool_name(
            "mcp__computer_use.press_key"
        ));
        assert!(!is_routecodex_structured_tool_name("---"));
        assert!(!is_routecodex_structured_tool_name("tool: exec_command"));
        assert!(!is_routecodex_structured_tool_name("exec command"));
    }

    #[test]
    fn read_routecodex_tool_name_hint_from_args_uses_shared_canonicalization() {
        let args = serde_json::json!({
            "input": {
                "payload": {
                    "name": "functions.shell-command"
                }
            }
        });
        assert_eq!(
            read_routecodex_tool_name_hint_from_args(Some(&args)),
            Some("exec_command".to_string())
        );
    }

    #[test]
    fn shared_tool_mapping_deletion_gate_removed_tool_harvester_local_canonical_clone() {
        let path = crate_src_path("tool_harvester.rs");
        let source = fs::read_to_string(&path)
            .unwrap_or_else(|error| panic!("failed to read {}: {}", path.display(), error));
        assert!(
            !source.contains("fn normalize_tool_name(name: &str) -> String"),
            "local normalize_tool_name clone still present in {}",
            path.display()
        );
        assert!(
            source.contains("normalize_routecodex_tool_name("),
            "tool_harvester.rs must use shared tool canonicalization truth"
        );
    }

    #[test]
    fn shared_tool_mapping_deletion_gate_removed_duplicate_tool_name_hint_scanners() {
        for relative in [
            "tool_harvester.rs",
            "resp_process_stage1_tool_governance_blocks/tool_call_entry.rs",
        ] {
            let path = crate_src_path(relative);
            let source = fs::read_to_string(&path)
                .unwrap_or_else(|error| panic!("failed to read {}: {}", path.display(), error));
            assert!(
                !source.contains("fn read_tool_name_hint_from_args(")
                    && !source.contains("pub(crate) fn read_tool_name_hint_from_args("),
                "local read_tool_name_hint_from_args clone still present in {}",
                path.display()
            );
            assert!(
                source.contains("read_routecodex_tool_name_hint_from_args("),
                "{} must use shared tool-name hint scanner truth",
                path.display()
            );
        }
    }

    #[test]
    fn shared_tool_mapping_deletion_gate_removed_reasoning_local_tool_name_clone() {
        let path = crate_src_path("hub_reasoning_tool_normalizer.rs");
        let source = fs::read_to_string(&path)
            .unwrap_or_else(|error| panic!("failed to read {}: {}", path.display(), error));
        assert!(
            !source.contains("fn normalize_tool_name(raw: &str) -> String"),
            "local normalize_tool_name clone still present in {}",
            path.display()
        );
        assert!(
            !source.contains(
                "fn read_tool_name_hint_from_args(raw_args: Option<&Value>) -> Option<String>"
            ),
            "local read_tool_name_hint_from_args clone still present in {}",
            path.display()
        );
        assert!(
            source.contains("normalize_routecodex_tool_name_with_embedded_hint("),
            "hub_reasoning_tool_normalizer.rs must use shared embedded tool-name normalization truth"
        );
        assert!(
            source.contains("read_routecodex_tool_name_hint_from_args("),
            "hub_reasoning_tool_normalizer.rs must use shared tool-name hint scanner truth"
        );
        assert!(
            !source.contains("fn is_explicit_tool_name_candidate("),
            "local is_explicit_tool_name_candidate clone still present in {}",
            path.display()
        );
        assert!(
            source.contains("is_routecodex_explicit_tool_name_candidate("),
            "hub_reasoning_tool_normalizer.rs must use shared explicit tool-name candidate truth"
        );
    }

    #[test]
    fn shared_tool_mapping_deletion_gate_removed_internal_normalize_tool_name_wrapper() {
        let path = crate_src_path("shared_tool_mapping.rs");
        let source = fs::read_to_string(&path)
            .unwrap_or_else(|error| panic!("failed to read {}: {}", path.display(), error));
        let pre_tests_source = source
            .split("#[cfg(test)]")
            .next()
            .unwrap_or(source.as_str());
        assert!(
            !pre_tests_source.contains(
                "fn normalize_tool_name(raw: Option<&str>, mode: &str) -> Option<String> {"
            ),
            "internal normalize_tool_name wrapper still present in {}",
            path.display()
        );
        assert!(
            source.contains("normalize_routecodex_tool_name(Some(\"websearch\"))")
                || source.contains("normalize_routecodex_tool_name(Some(raw.unwrap_or(\"\").trim()))"),
            "shared_tool_mapping.rs must route canonicalization directly through normalize_routecodex_tool_name truth"
        );
    }

    #[test]
    fn shared_tool_mapping_deletion_gate_removed_text_markup_local_tool_name_clone() {
        let path = crate_src_path("hub_text_markup_normalizer.rs");
        let source = fs::read_to_string(&path)
            .unwrap_or_else(|error| panic!("failed to read {}: {}", path.display(), error));
        assert!(
            !source.contains("fn canonicalize_json_tool_name("),
            "local canonicalize_json_tool_name clone still present in {}",
            path.display()
        );
        assert!(
            !source.contains("fn known_tools()"),
            "local known_tools clone still present in {}",
            path.display()
        );
        assert!(
            !source.contains("fn is_structured_tool_name("),
            "local is_structured_tool_name clone still present in {}",
            path.display()
        );
        assert!(
            !source.contains("fn resolve_json_tool_name_aliases("),
            "local resolve_json_tool_name_aliases clone still present in {}",
            path.display()
        );
        assert!(
            !source.contains("fn read_tool_name_hint_from_args("),
            "local read_tool_name_hint_from_args clone still present in {}",
            path.display()
        );
        assert!(
            source.contains("normalize_json_tool_name_with_aliases("),
            "hub_text_markup_normalizer.rs must use shared json tool-name canonicalization truth"
        );
        assert!(
            source.contains("resolve_routecodex_json_tool_name_aliases("),
            "hub_text_markup_normalizer.rs must use shared alias-map truth"
        );
        assert!(
            source.contains("read_routecodex_json_tool_name_hint_from_args("),
            "hub_text_markup_normalizer.rs must use shared alias-aware hint scanner truth"
        );
    }

    #[test]
    fn flattened_tool_mapping_trims_description_via_shared_helper() {
        let input = serde_json::json!({
            "tools": [{
                "type": "function",
                "function": {
                    "name": "demo_tool",
                    "description": "  demo desc  "
                }
            }],
            "options": {
                "sanitizeMode": "responses"
            }
        });
        let raw =
            map_bridge_tools_to_chat_with_options_json(input.to_string()).expect("mapped tool");
        let parsed: Value = serde_json::from_str(&raw).expect("json");
        let parsed = &parsed.as_array().expect("mapped array")[0];
        assert_eq!(parsed["function"]["description"], "demo desc");
    }

    #[test]
    fn shared_tool_mapping_deletion_gate_removed_deepseek_response_local_exec_family() {
        let path = crate_src_path("req_outbound_stage3_compat/deepseek_web/response.rs");
        let Ok(source) = fs::read_to_string(&path) else {
            return;
        };
        assert!(
            !source.contains("fn is_exec_command_family(name: &str) -> bool {"),
            "local exec_command family helper still present in {}",
            path.display()
        );
        assert!(
            source.contains("normalize_routecodex_tool_name(Some(raw_name))")
                || source.contains("normalize_routecodex_tool_name(function.get(\"name\").and_then(Value::as_str))"),
            "deepseek_web/response.rs must use shared tool mapping truth directly"
        );
    }

    #[test]
    fn shared_tool_mapping_deletion_gate_removed_resp_process_tool_names_wrapper() {
        let path = crate_src_path("resp_process_stage1_tool_governance_blocks/tool_names.rs");
        assert!(
            !path.exists(),
            "resp_process_stage1_tool_governance_blocks/tool_names.rs should be physically removed after routing callers to shared_tool_mapping.rs"
        );
        for relative in [
            "resp_process_stage1_tool_governance_blocks/requested_tools.rs",
            "resp_process_stage1_tool_governance_blocks/tool_args.rs",
            "resp_process_stage1_tool_governance_blocks/tool_call_entry.rs",
            "resp_process_stage1_tool_governance_blocks/xml_text_utils.rs",
        ] {
            let path = crate_src_path(relative);
            let source = fs::read_to_string(&path)
                .unwrap_or_else(|error| panic!("failed to read {}: {}", path.display(), error));
            assert!(
                source.contains("normalize_routecodex_tool_name("),
                "{} must use shared tool canonicalization truth directly",
                path.display()
            );
            assert!(
                !source.contains("tool_names::normalize_tool_name"),
                "local resp_process tool_names wrapper reference still present in {}",
                path.display()
            );
        }
    }
}
