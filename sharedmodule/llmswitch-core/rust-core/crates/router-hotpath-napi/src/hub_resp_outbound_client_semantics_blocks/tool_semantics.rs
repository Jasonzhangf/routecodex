use serde_json::{Map, Value};

use crate::shared_tool_mapping::build_anthropic_tool_alias_map;

pub(crate) fn normalize_alias_map(candidate: &Value) -> Option<Map<String, Value>> {
    let row = candidate.as_object()?;
    let mut out = Map::new();

    for (key, value) in row {
        let value_str = match value.as_str() {
            Some(v) => v.trim(),
            None => continue,
        };
        let key_str = key.trim();
        if key_str.is_empty() || value_str.is_empty() {
            continue;
        }
        out.insert(key_str.to_string(), Value::String(value_str.to_string()));
    }

    if out.is_empty() {
        return None;
    }
    Some(out)
}

pub(crate) fn resolve_client_tools_raw(candidate: &Value) -> Option<Vec<Value>> {
    let list = candidate.as_array()?;
    if list.is_empty() {
        return None;
    }

    let mut filtered: Vec<Value> = Vec::new();
    for entry in list {
        let row = match entry.as_object() {
            Some(v) => v,
            None => continue,
        };
        let raw_type = row.get("type").and_then(|v| v.as_str()).unwrap_or("");
        if raw_type.trim().is_empty() {
            continue;
        }
        filtered.push(Value::Object(row.clone()));
    }

    if filtered.is_empty() {
        return None;
    }
    Some(filtered)
}

fn read_tools_record_from_semantics(semantics: &Value) -> Option<Map<String, Value>> {
    let semantics_row = semantics.as_object()?;
    let tools_node = semantics_row.get("tools")?;
    let tools_row = tools_node.as_object()?;
    Some(tools_row.clone())
}

fn read_anthropic_record_from_semantics(semantics: &Value) -> Option<Map<String, Value>> {
    let semantics_row = semantics.as_object()?;
    let anthropic_node = semantics_row.get("anthropic")?;
    let anthropic_row = anthropic_node.as_object()?;
    Some(anthropic_row.clone())
}

fn resolve_semantics_tool_name_alias_map_candidate(semantics: &Value) -> Option<Value> {
    if let Some(tools_record) = read_tools_record_from_semantics(semantics) {
        if let Some(candidate) = tools_record.get("toolNameAliasMap") {
            return Some(candidate.clone());
        }
    }
    let anthropic_record = read_anthropic_record_from_semantics(semantics)?;
    anthropic_record.get("toolNameAliasMap").cloned()
}

fn resolve_semantics_client_tools_raw_candidate(semantics: &Value) -> Option<Value> {
    if let Some(tools_record) = read_tools_record_from_semantics(semantics) {
        if let Some(candidate) = tools_record.get("clientToolsRaw") {
            return Some(candidate.clone());
        }
    }
    let anthropic_record = read_anthropic_record_from_semantics(semantics)?;
    anthropic_record.get("clientToolsRaw").cloned()
}

pub(crate) fn resolve_alias_map_from_resp_semantics(semantics: &Value) -> Option<Map<String, Value>> {
    if let Some(tool_name_alias_map) = resolve_semantics_tool_name_alias_map_candidate(semantics) {
        if let Some(from_candidate) = normalize_alias_map(&tool_name_alias_map) {
            return Some(from_candidate);
        }
    }

    let raw_tools = resolve_semantics_client_tools_raw_candidate(semantics)?;
    let derived_alias = build_anthropic_tool_alias_map(&raw_tools)?;
    normalize_alias_map(&Value::Object(derived_alias))
}

pub(crate) fn resolve_alias_map_from_sources(
    adapter_context: &Value,
    chat_envelope: &Value,
) -> Option<Map<String, Value>> {
    let adapter_row = adapter_context.as_object();
    if let Some(from_context) = adapter_row
        .and_then(|row| row.get("anthropicToolNameMap"))
        .and_then(normalize_alias_map)
    {
        return Some(from_context);
    }

    let chat_row = chat_envelope.as_object();
    let metadata = chat_row
        .and_then(|row| row.get("metadata"))
        .and_then(|node| node.as_object());
    if let Some(direct) = metadata
        .and_then(|row| row.get("anthropicToolNameMap"))
        .and_then(normalize_alias_map)
    {
        return Some(direct);
    }
    if let Some(from_context_node) = metadata
        .and_then(|row| row.get("context"))
        .and_then(|node| node.as_object())
        .and_then(|row| row.get("anthropicToolNameMap"))
        .and_then(normalize_alias_map)
    {
        return Some(from_context_node);
    }

    let semantics = chat_row
        .and_then(|row| row.get("semantics"))
        .cloned()
        .unwrap_or(Value::Null);
    resolve_alias_map_from_resp_semantics(&semantics)
}

pub(crate) fn resolve_client_tools_raw_from_resp_semantics(semantics: &Value) -> Option<Vec<Value>> {
    let raw_tools = resolve_semantics_client_tools_raw_candidate(semantics)?;
    resolve_client_tools_raw(&raw_tools)
}

