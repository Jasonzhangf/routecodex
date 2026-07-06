// feature_id: hub.response_responses_client_projection
// canonical_builders: project_responses_client_payload_for_client, project_responses_client_body_for_client, project_responses_sse_frame_for_client

use serde::Deserialize;
use serde_json::{Map, Value};
use std::collections::{HashMap, HashSet};

use crate::hub_resp_outbound_client_semantics_blocks::responses_reasoning::normalize_reasoning_summary_for_codex_display;
use crate::resp_process_stage1_tool_governance_blocks::display_sanitize::strip_tool_markup_for_display_text;
use crate::shared_tool_mapping::build_flattened_namespace_child_alias;

#[derive(Clone, Debug)]
pub(crate) struct ClientToolDefinition {
    pub(crate) declared_name: String,
    pub(crate) namespace: Option<String>,
    pub(crate) format: Option<String>,
    pub(crate) parameters: Option<Map<String, Value>>,
}

#[derive(Default)]
pub(crate) struct ClientToolIndex {
    pub(crate) by_name: HashMap<String, ClientToolDefinition>,
    pub(crate) by_namespace_name: HashMap<String, ClientToolDefinition>,
}

fn try_parse_json_string(value: &str) -> Option<Value> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return None;
    }
    if !(trimmed.starts_with('{') || trimmed.starts_with('[')) {
        return None;
    }
    serde_json::from_str::<Value>(trimmed).ok()
}

fn looks_like_apply_patch_text(value: &str) -> bool {
    let trimmed = value.trim();
    !trimmed.is_empty() && trimmed.contains("*** Begin Patch") && trimmed.contains("*** End Patch")
}

fn extract_json_schema_like(
    parameters: &Map<String, Value>,
) -> Option<(Vec<String>, Vec<String>, bool)> {
    let required = parameters
        .get("required")
        .and_then(|v| v.as_array())
        .map(|items| {
            items
                .iter()
                .filter_map(|value| value.as_str().map(|s| s.trim().to_string()))
                .filter(|value| !value.is_empty())
                .collect::<Vec<String>>()
        })
        .unwrap_or_default();
    let properties_map = parameters
        .get("properties")
        .and_then(|v| v.as_object())
        .cloned()
        .unwrap_or_default();
    let properties = properties_map.keys().cloned().collect::<Vec<String>>();
    if required.is_empty() && properties.is_empty() {
        return None;
    }
    let additional_properties = parameters
        .get("additionalProperties")
        .and_then(|v| v.as_bool())
        .unwrap_or(true);
    Some((required, properties, additional_properties))
}

fn repair_tool_args_by_schema_keys(
    tool_name: &str,
    record: &Map<String, Value>,
    required: &[String],
    properties: &[String],
    additional_properties: bool,
) -> Option<Map<String, Value>> {
    let wants = properties.iter().cloned().collect::<HashSet<String>>();
    let mut out = record.clone();

    if tool_name == "write_stdin" {
        if wants.contains("chars") && out.get("text").is_some() && out.get("chars").is_none() {
            if let Some(value) = out.get("text").cloned() {
                out.insert("chars".to_string(), value);
            }
        }
        if wants.contains("text") && out.get("chars").is_some() && out.get("text").is_none() {
            if let Some(value) = out.get("chars").cloned() {
                out.insert("text".to_string(), value);
            }
        }
    }
    if matches!(tool_name, "exec_command" | "shell_command") {
        let wants_cmd = wants.contains("cmd");
        let wants_command = wants.contains("command");
        if wants_cmd && !wants_command && out.get("cmd").is_none() {
            if let Some(value) = out
                .get("command")
                .or_else(|| out.get("command_line"))
                .or_else(|| out.get("proposed_command_line"))
                .cloned()
            {
                out.insert("cmd".to_string(), value);
            }
        }
        if wants_command && !wants_cmd && out.get("command").is_none() {
            if let Some(value) = out
                .get("cmd")
                .or_else(|| out.get("command_line"))
                .or_else(|| out.get("proposed_command_line"))
                .cloned()
            {
                out.insert("command".to_string(), value);
            }
        }
    }
    for key in required {
        if !out.contains_key(key.as_str()) {
            return None;
        }
    }

    if !additional_properties && !wants.is_empty() {
        let keys = out.keys().cloned().collect::<Vec<String>>();
        for key in keys {
            if !wants.contains(key.as_str()) {
                out.remove(key.as_str());
            }
        }
    }
    Some(out)
}

fn build_namespace_lookup_key(namespace: &str, name: &str) -> Option<String> {
    let namespace = namespace.trim();
    let name = name.trim();
    if namespace.is_empty() || name.is_empty() {
        return None;
    }
    Some(format!(
        "{}::{}",
        namespace.to_ascii_lowercase(),
        name.to_ascii_lowercase()
    ))
}

fn read_client_tool_definition(
    row: &Map<String, Value>,
    explicit_name: Option<String>,
    namespace: Option<String>,
) -> Option<ClientToolDefinition> {
    let fn_row = row.get("function").and_then(|v| v.as_object());
    let name = explicit_name
        .or_else(|| {
            fn_row
                .and_then(|fn_row| fn_row.get("name").and_then(|v| v.as_str()))
                .map(|v| v.trim().to_string())
        })
        .or_else(|| {
            row.get("name")
                .and_then(|v| v.as_str())
                .map(|v| v.trim().to_string())
        })
        .filter(|v| !v.is_empty())?;
    let format = row
        .get("format")
        .and_then(read_tool_format)
        .or_else(|| fn_row.and_then(|fn_row| fn_row.get("format").and_then(read_tool_format)));
    let parameters = fn_row
        .and_then(|fn_row| {
            fn_row
                .get("parameters")
                .and_then(|v| v.as_object())
                .cloned()
        })
        .or_else(|| row.get("parameters").and_then(|v| v.as_object()).cloned());

    Some(ClientToolDefinition {
        declared_name: name,
        namespace,
        format,
        parameters,
    })
}

fn read_tool_format(value: &Value) -> Option<String> {
    value
        .as_str()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
        .or_else(|| {
            value
                .as_object()
                .and_then(|row| row.get("type"))
                .and_then(|v| v.as_str())
                .map(|v| v.trim().to_string())
                .filter(|v| !v.is_empty())
        })
}

fn register_client_tool(
    index: &mut ClientToolIndex,
    key: String,
    definition: &ClientToolDefinition,
) {
    if key.trim().is_empty() {
        return;
    }
    index
        .by_name
        .entry(key)
        .or_insert_with(|| definition.clone());
}

pub(crate) fn build_client_tool_index(tools_raw: &Value) -> ClientToolIndex {
    let mut index = ClientToolIndex::default();
    let mut used_aliases = HashSet::<String>::new();
    let Some(items) = tools_raw.as_array() else {
        return index;
    };
    for tool in items {
        let Some(row) = tool.as_object() else {
            continue;
        };
        let tool_type = row
            .get("type")
            .and_then(|v| v.as_str())
            .map(|v| v.trim().to_ascii_lowercase())
            .unwrap_or_else(|| "function".to_string());

        if tool_type == "namespace" {
            let Some(namespace) = row
                .get("name")
                .and_then(|v| v.as_str())
                .map(|v| v.trim().to_string())
                .filter(|v| !v.is_empty())
            else {
                continue;
            };
            let Some(children) = row.get("tools").and_then(|v| v.as_array()) else {
                continue;
            };
            for child in children {
                let Some(child_row) = child.as_object() else {
                    continue;
                };
                let explicit_name = child_row
                    .get("name")
                    .and_then(|v| v.as_str())
                    .map(|v| v.trim().to_string())
                    .filter(|v| !v.is_empty());
                let Some(definition) =
                    read_client_tool_definition(child_row, explicit_name, Some(namespace.clone()))
                else {
                    continue;
                };
                if let Some(lookup_key) = build_namespace_lookup_key(
                    namespace.as_str(),
                    definition.declared_name.as_str(),
                ) {
                    index
                        .by_namespace_name
                        .entry(lookup_key)
                        .or_insert_with(|| definition.clone());
                }
                register_client_tool(&mut index, definition.declared_name.clone(), &definition);
                if let Some(flattened_alias) = build_flattened_namespace_child_alias(
                    namespace.as_str(),
                    definition.declared_name.as_str(),
                    "responses",
                    &used_aliases,
                ) {
                    used_aliases.insert(flattened_alias.clone());
                    register_client_tool(&mut index, flattened_alias, &definition);
                }
            }
            continue;
        }

        let Some(definition) = read_client_tool_definition(row, None, None) else {
            continue;
        };
        used_aliases.insert(definition.declared_name.clone());
        register_client_tool(&mut index, definition.declared_name.clone(), &definition);
    }
    index
}

pub(crate) fn resolve_client_tool_name(
    tool_index: &ClientToolIndex,
    namespace: Option<&str>,
    raw_tool_name: &str,
) -> Option<ClientToolDefinition> {
    fn normalize_tool_name_for_match(value: &str) -> String {
        let trimmed = value.trim();
        if trimmed.is_empty() {
            return String::new();
        }

        let lowered = trimmed.to_ascii_lowercase();
        let canonical = if lowered.starts_with("functions.") {
            trimmed.get(10..).map(str::trim).unwrap_or(trimmed)
        } else {
            trimmed
        };

        let mut out = String::new();
        for ch in canonical.chars() {
            if ch.is_ascii_alphanumeric() {
                out.push(ch.to_ascii_lowercase());
            }
        }
        out
    }

    let trimmed = raw_tool_name.trim();
    if trimmed.is_empty() {
        return None;
    }
    if let Some(namespace_value) = namespace.and_then(|value| {
        let trimmed = value.trim();
        (!trimmed.is_empty()).then_some(trimmed)
    }) {
        if let Some(lookup_key) = build_namespace_lookup_key(namespace_value, trimmed) {
            if let Some(entry) = tool_index.by_namespace_name.get(lookup_key.as_str()) {
                return Some(entry.clone());
            }
        }
    }
    if let Some(entry) = tool_index.by_name.get(trimmed) {
        return Some(entry.clone());
    }
    let lower = trimmed.to_ascii_lowercase();
    for (key, value) in tool_index.by_name.iter() {
        if key.to_ascii_lowercase() == lower {
            return Some(value.clone());
        }
    }

    let maybe_prefixed = if lower.starts_with("functions.") {
        trimmed.get(10..).map(str::trim)
    } else {
        None
    };
    if let Some(suffix) = maybe_prefixed {
        if let Some(entry) = tool_index.by_name.get(suffix) {
            return Some(entry.clone());
        }
        let suffix_lower = suffix.to_ascii_lowercase();
        for (key, value) in tool_index.by_name.iter() {
            if key.to_ascii_lowercase() == suffix_lower {
                return Some(value.clone());
            }
        }
    }

    let normalized = normalize_tool_name_for_match(trimmed);
    if normalized.is_empty() {
        return None;
    }

    let canonical_for_family = trimmed
        .trim()
        .trim_start_matches("functions.")
        .chars()
        .map(|ch| {
            if ch == '_' || ch == '-' || ch == ' ' {
                '.'
            } else {
                ch.to_ascii_lowercase()
            }
        })
        .collect::<String>()
        .split('.')
        .filter(|part| !part.is_empty())
        .collect::<Vec<&str>>()
        .join(".");
    if matches!(
        canonical_for_family.replace('.', "_").as_str(),
        "bash"
            | "shell"
            | "cmd"
            | "cmd_exe"
            | "shell_cmd"
            | "bash_cmd"
            | "exec"
            | "run"
            | "command"
            | "system"
            | "run_command"
            | "execute"
            | "exec_command"
            | "bash_command"
            | "shell_command"
            | "run_shell"
            | "bash_shell"
            | "system_command"
            | "shell_exec"
            | "run_cmd"
            | "bash_exec"
            | "terminal"
    ) {
        let mut keys = tool_index.by_name.keys().cloned().collect::<Vec<String>>();
        keys.sort();
        for key in &keys {
            let key_canonical = key
                .trim()
                .trim_start_matches("functions.")
                .chars()
                .map(|ch| {
                    if ch == '_' || ch == '-' || ch == ' ' {
                        '.'
                    } else {
                        ch.to_ascii_lowercase()
                    }
                })
                .collect::<String>()
                .split('.')
                .filter(|part| !part.is_empty())
                .collect::<Vec<&str>>()
                .join(".");
            if matches!(
                key_canonical.replace('.', "_").as_str(),
                "bash"
                    | "shell"
                    | "cmd"
                    | "cmd_exe"
                    | "shell_cmd"
                    | "bash_cmd"
                    | "exec"
                    | "run"
                    | "command"
                    | "system"
                    | "run_command"
                    | "execute"
                    | "exec_command"
                    | "bash_command"
                    | "shell_command"
                    | "run_shell"
                    | "bash_shell"
                    | "system_command"
                    | "shell_exec"
                    | "run_cmd"
                    | "bash_exec"
                    | "terminal"
            ) {
                if let Some(value) = tool_index.by_name.get(key.as_str()) {
                    return Some(value.clone());
                }
            }
        }
    }

    let mut keys = tool_index.by_name.keys().cloned().collect::<Vec<String>>();
    keys.sort();
    for key in keys {
        if normalize_tool_name_for_match(key.as_str()) == normalized {
            if let Some(value) = tool_index.by_name.get(key.as_str()) {
                return Some(value.clone());
            }
        }
    }

    None
}

fn normalize_apply_patch_client_args_raw(args_raw: &Value) -> Option<Value> {
    normalize_apply_patch_client_args_for_spec(args_raw, None)
}

fn is_freeform_tool(spec: Option<&ClientToolDefinition>) -> bool {
    matches!(
        spec.and_then(|entry| entry.format.as_deref())
            .map(|value| value.to_ascii_lowercase()),
        Some(value) if matches!(value.as_str(), "grammar" | "text")
    )
}

fn normalize_apply_patch_client_args_for_spec(
    args_raw: &Value,
    spec: Option<&ClientToolDefinition>,
) -> Option<Value> {
    let normalized = crate::resp_process_stage1_tool_governance_blocks::apply_patch_schema_args::normalize_apply_patch_schema_args(
        Some(args_raw),
    );
    let parsed: Value = serde_json::from_str(&normalized.0).ok()?;
    let patch = parsed
        .as_object()
        .and_then(|row| row.get("patch"))
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or("");
    if patch.is_empty() || patch.contains("__APPLY_PATCH_ERROR__/") {
        return None;
    }
    if is_freeform_tool(spec) {
        return Some(Value::String(patch.to_string()));
    }
    Some(Value::String(normalized.0))
}

pub(crate) fn normalize_call_args(
    tool_name: &str,
    args_raw: &Value,
    spec: &ClientToolDefinition,
) -> Value {
    let Some(parameters) = spec.parameters.as_ref() else {
        return args_raw.clone();
    };
    let Some((required, properties, additional_properties)) = extract_json_schema_like(parameters)
    else {
        return args_raw.clone();
    };
    let parsed = if let Some(raw) = args_raw.as_str() {
        try_parse_json_string(raw)
    } else {
        Some(args_raw.clone())
    };
    let Some(parsed) = parsed else {
        return args_raw.clone();
    };
    let Some(record) = parsed.as_object() else {
        return args_raw.clone();
    };
    let Some(repaired) = repair_tool_args_by_schema_keys(
        tool_name,
        record,
        required.as_slice(),
        properties.as_slice(),
        additional_properties,
    ) else {
        return args_raw.clone();
    };
    Value::String(
        serde_json::to_string(&Value::Object(repaired)).unwrap_or_else(|_| "{}".to_string()),
    )
}

pub(crate) fn normalize_responses_tool_call_arguments_for_client(
    responses_payload: &Value,
    tools_raw: &Value,
) -> Value {
    let Some(payload_row) = responses_payload.as_object() else {
        return responses_payload.clone();
    };
    let mut payload = payload_row.clone();

    let tool_index = build_client_tool_index(tools_raw);

    if let Some(output_items) = payload.get_mut("output").and_then(|v| v.as_array_mut()) {
        for item in output_items.iter_mut() {
            let Some(item_row) = item.as_object_mut() else {
                continue;
            };
            let item_type = item_row
                .get("type")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .trim()
                .to_ascii_lowercase();
            if item_type != "function_call" {
                continue;
            }
            let name = item_row
                .get("name")
                .and_then(|v| v.as_str())
                .map(|v| v.trim().to_string())
                .unwrap_or_default();
            if name.is_empty() {
                continue;
            }
            let namespace = item_row.get("namespace").and_then(|v| v.as_str());
            let spec = resolve_client_tool_name(&tool_index, namespace, name.as_str());
            if name == "apply_patch" {
                let args_raw = item_row
                    .get("arguments")
                    .cloned()
                    .unwrap_or_else(|| Value::Null);
                if let Some(normalized) =
                    normalize_apply_patch_client_args_for_spec(&args_raw, spec.as_ref())
                {
                    item_row.insert("arguments".to_string(), normalized);
                    continue;
                }
            }
            let Some(spec) = spec else {
                continue;
            };
            if spec.declared_name != name {
                item_row.insert(
                    "name".to_string(),
                    Value::String(spec.declared_name.clone()),
                );
            }
            match spec.namespace.as_ref() {
                Some(namespace_name) => {
                    item_row.insert(
                        "namespace".to_string(),
                        Value::String(namespace_name.clone()),
                    );
                }
                None => {
                    item_row.remove("namespace");
                }
            }
            let args_raw = item_row
                .get("arguments")
                .cloned()
                .unwrap_or_else(|| Value::Null);
            let normalized = if spec.declared_name == "apply_patch" {
                normalize_apply_patch_client_args_for_spec(&args_raw, Some(&spec)).unwrap_or_else(
                    || normalize_call_args(spec.declared_name.as_str(), &args_raw, &spec),
                )
            } else {
                normalize_call_args(spec.declared_name.as_str(), &args_raw, &spec)
            };
            item_row.insert("arguments".to_string(), normalized);
        }
    }

    let tool_calls_opt = payload
        .get_mut("required_action")
        .and_then(|v| v.as_object_mut())
        .and_then(|row| row.get_mut("submit_tool_outputs"))
        .and_then(|v| v.as_object_mut())
        .and_then(|row| row.get_mut("tool_calls"))
        .and_then(|v| v.as_array_mut());
    if let Some(calls) = tool_calls_opt {
        for call in calls.iter_mut() {
            let Some(call_row) = call.as_object_mut() else {
                continue;
            };
            let mut name = call_row
                .get("name")
                .and_then(|v| v.as_str())
                .map(|v| v.trim().to_string())
                .unwrap_or_default();
            if name.is_empty() {
                name = call_row
                    .get("function")
                    .and_then(|v| v.as_object())
                    .and_then(|v| v.get("name"))
                    .and_then(|v| v.as_str())
                    .map(|v| v.trim().to_string())
                    .unwrap_or_default();
            }
            if name.is_empty() {
                continue;
            }
            let namespace = call_row
                .get("namespace")
                .and_then(|v| v.as_str())
                .or_else(|| {
                    call_row
                        .get("function")
                        .and_then(|v| v.as_object())
                        .and_then(|v| v.get("namespace"))
                        .and_then(|v| v.as_str())
                });
            let fn_args = call_row
                .get("function")
                .and_then(|v| v.as_object())
                .and_then(|v| v.get("arguments"))
                .cloned();
            let call_args = call_row.get("arguments").cloned();
            let args_raw = fn_args.or(call_args).unwrap_or(Value::Null);
            let spec = resolve_client_tool_name(&tool_index, namespace, name.as_str());
            if name == "apply_patch" {
                if let Some(normalized) =
                    normalize_apply_patch_client_args_for_spec(&args_raw, spec.as_ref())
                {
                    call_row.insert("arguments".to_string(), normalized.clone());
                    if let Some(fn_row) =
                        call_row.get_mut("function").and_then(|v| v.as_object_mut())
                    {
                        fn_row.insert("name".to_string(), Value::String("apply_patch".to_string()));
                        fn_row.insert("arguments".to_string(), normalized);
                    }
                    continue;
                }
            }
            let Some(spec) = spec else {
                continue;
            };
            if let Some(name_value) = call_row.get("name") {
                if name_value.is_string() && spec.declared_name != name {
                    call_row.insert(
                        "name".to_string(),
                        Value::String(spec.declared_name.clone()),
                    );
                }
            }
            match spec.namespace.as_ref() {
                Some(namespace_name) => {
                    call_row.insert(
                        "namespace".to_string(),
                        Value::String(namespace_name.clone()),
                    );
                }
                None => {
                    call_row.remove("namespace");
                }
            }
            let normalized = if spec.declared_name == "apply_patch" {
                normalize_apply_patch_client_args_for_spec(&args_raw, Some(&spec)).unwrap_or_else(
                    || normalize_call_args(spec.declared_name.as_str(), &args_raw, &spec),
                )
            } else {
                normalize_call_args(spec.declared_name.as_str(), &args_raw, &spec)
            };
            call_row.insert("arguments".to_string(), normalized.clone());
            if let Some(fn_row) = call_row.get_mut("function").and_then(|v| v.as_object_mut()) {
                fn_row.insert(
                    "name".to_string(),
                    Value::String(spec.declared_name.clone()),
                );
                match spec.namespace.as_ref() {
                    Some(namespace_name) => {
                        fn_row.insert(
                            "namespace".to_string(),
                            Value::String(namespace_name.clone()),
                        );
                    }
                    None => {
                        fn_row.remove("namespace");
                    }
                }
                fn_row.insert("arguments".to_string(), normalized);
            }
        }
    }

    Value::Object(payload)
}

fn sanitize_responses_output_item_for_replay_safety(record: &mut Map<String, Value>) {
    let item_type = record
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    match item_type.as_str() {
        "reasoning" => {
            record.remove("content");
            record.remove("status");
        }
        "function_call" | "function_call_output" => {
            record.remove("status");
        }
        _ => {}
    }
}

fn is_client_visible_text_field(record: &Map<String, Value>, key: &str) -> bool {
    if key == "output_text" {
        return true;
    }
    let record_type = record
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    match key {
        "text" => matches!(record_type, "output_text" | "response.output_text.done"),
        "delta" => record_type == "response.output_text.delta",
        _ => false,
    }
}

fn sanitize_client_visible_text_field(
    record: &Map<String, Value>,
    key: &str,
    value: Value,
) -> Value {
    if !is_client_visible_text_field(record, key) {
        return value;
    }
    let Value::String(raw) = value else {
        return value;
    };
    let cleaned = strip_tool_markup_for_display_text(raw.as_str());
    if cleaned == raw {
        Value::String(raw)
    } else if !raw.trim().is_empty() && cleaned == raw.trim() {
        Value::String(raw)
    } else {
        Value::String(cleaned)
    }
}

fn sanitize_responses_client_payload_for_replay_safety_deep(value: &Value) -> Value {
    match value {
        Value::Array(items) => Value::Array(
            items
                .iter()
                .map(sanitize_responses_client_payload_for_replay_safety_deep)
                .collect(),
        ),
        Value::Object(record) => {
            let mut out = Map::new();
            for (key, child) in record {
                let sanitized_child =
                    sanitize_responses_client_payload_for_replay_safety_deep(child);
                if key == "metadata" {
                    continue;
                }
                out.insert(
                    key.clone(),
                    sanitize_client_visible_text_field(record, key, sanitized_child),
                );
            }
            sanitize_responses_output_item_for_replay_safety(&mut out);
            Value::Object(out)
        }
        _ => value.clone(),
    }
}

pub(crate) fn sanitize_responses_client_payload_for_replay_safety(value: &Value) -> Value {
    sanitize_responses_client_payload_for_replay_safety_deep(value)
}

fn has_responses_freeform_apply_patch_tool(tools_raw: &Value) -> bool {
    let tool_index = build_client_tool_index(tools_raw);
    tool_index
        .by_name
        .get("apply_patch")
        .map(|entry| is_freeform_tool(Some(entry)))
        .unwrap_or(false)
}

fn normalize_apply_patch_freeform_input_for_client(arguments_text: &str) -> String {
    let parsed = serde_json::from_str::<Value>(arguments_text).ok();
    let Some(Value::Object(record)) = parsed else {
        return arguments_text.to_string();
    };
    record
        .get("patch")
        .or_else(|| record.get("input"))
        .and_then(Value::as_str)
        .map(ToString::to_string)
        .unwrap_or_else(|| arguments_text.to_string())
}

fn read_call_id(record: &Map<String, Value>) -> String {
    record
        .get("call_id")
        .or_else(|| record.get("id"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("call_apply_patch")
        .to_string()
}

fn convert_apply_patch_function_calls_to_custom_tool_calls(value: &Value) -> Value {
    match value {
        Value::Array(items) => Value::Array(
            items
                .iter()
                .map(convert_apply_patch_function_calls_to_custom_tool_calls)
                .collect(),
        ),
        Value::Object(record) => {
            if record.get("type").and_then(Value::as_str) == Some("function_call")
                && record.get("name").and_then(Value::as_str) == Some("apply_patch")
            {
                let input = record
                    .get("arguments")
                    .and_then(Value::as_str)
                    .map(normalize_apply_patch_freeform_input_for_client)
                    .unwrap_or_default();
                return serde_json::json!({
                    "type": "custom_tool_call",
                    "name": "apply_patch",
                    "call_id": read_call_id(record),
                    "input": input,
                });
            }
            let mut out = Map::new();
            for (key, child) in record {
                if record.get("type").and_then(Value::as_str) == Some("custom_tool_call")
                    && record.get("name").and_then(Value::as_str) == Some("apply_patch")
                    && key == "input"
                    && child.is_string()
                {
                    out.insert(
                        key.clone(),
                        Value::String(normalize_apply_patch_freeform_input_for_client(
                            child.as_str().unwrap_or_default(),
                        )),
                    );
                    continue;
                }
                out.insert(
                    key.clone(),
                    convert_apply_patch_function_calls_to_custom_tool_calls(child),
                );
            }
            Value::Object(out)
        }
        _ => value.clone(),
    }
}

fn read_trimmed_string(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
}

fn read_record(value: Option<&Value>) -> Option<&Map<String, Value>> {
    value.and_then(Value::as_object)
}

fn read_reasoning_effort_candidate(value: Option<&Value>) -> Option<String> {
    read_record(value).and_then(|record| read_trimmed_string(record.get("effort")))
}

fn resolve_client_visible_model_id(metadata: &Value) -> Option<String> {
    let record = metadata.as_object()?;
    read_trimmed_string(record.get("clientModelId"))
        .or_else(|| read_trimmed_string(record.get("originalModelId")))
        .or_else(|| {
            read_record(record.get("target"))
                .and_then(|target| read_trimmed_string(target.get("clientModelId")))
        })
        .or_else(|| {
            read_record(record.get("originalRequest"))
                .and_then(|original| read_trimmed_string(original.get("model")))
        })
        .or_else(|| {
            read_record(record.get("originalRequest"))
                .and_then(|original| read_trimmed_string(original.get("originalModelId")))
        })
}

fn resolve_client_visible_reasoning_effort(metadata: &Value) -> Option<String> {
    let record = metadata.as_object()?;
    read_reasoning_effort_candidate(record.get("reasoning"))
        .or_else(|| {
            read_record(record.get("target"))
                .and_then(|target| read_reasoning_effort_candidate(target.get("reasoning")))
        })
        .or_else(|| {
            read_record(record.get("originalRequest"))
                .and_then(|original| read_reasoning_effort_candidate(original.get("reasoning")))
        })
}

fn apply_client_visible_response_fields(
    response: &Map<String, Value>,
    model: Option<&str>,
    reasoning_effort: Option<&str>,
) -> Option<Map<String, Value>> {
    let mut next_response = response.clone();
    let mut changed = false;
    if let Some(model) = model {
        if next_response.get("model").and_then(Value::as_str) != Some(model) {
            next_response.insert("model".to_string(), Value::String(model.to_string()));
            changed = true;
        }
    }
    if let Some(reasoning_effort) = reasoning_effort {
        let mut reasoning = next_response
            .get("reasoning")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        if reasoning.get("effort").and_then(Value::as_str) != Some(reasoning_effort) {
            reasoning.insert(
                "effort".to_string(),
                Value::String(reasoning_effort.to_string()),
            );
            next_response.insert("reasoning".to_string(), Value::Object(reasoning));
            changed = true;
        }
    }
    changed.then_some(next_response)
}

fn restore_client_visible_response_payload(payload: &Value, metadata: &Value) -> Value {
    let model = resolve_client_visible_model_id(metadata);
    let reasoning_effort = resolve_client_visible_reasoning_effort(metadata);
    if model.is_none() && reasoning_effort.is_none() {
        return payload.clone();
    }

    let Some(record) = payload.as_object() else {
        return payload.clone();
    };

    if record.get("object").and_then(Value::as_str) == Some("response") {
        if let Some(next_response) = apply_client_visible_response_fields(
            record,
            model.as_deref(),
            reasoning_effort.as_deref(),
        ) {
            return Value::Object(next_response);
        }
        return payload.clone();
    }

    let Some(response) = record.get("response").and_then(Value::as_object) else {
        return payload.clone();
    };
    let Some(next_response) = apply_client_visible_response_fields(
        response,
        model.as_deref(),
        reasoning_effort.as_deref(),
    ) else {
        return payload.clone();
    };

    let mut out = record.clone();
    out.insert("response".to_string(), Value::Object(next_response));
    Value::Object(out)
}

pub(crate) fn project_responses_client_body_for_client_core(
    responses_payload: &Value,
    tools_raw: &Value,
) -> Value {
    let normalized =
        normalize_responses_tool_call_arguments_for_client(responses_payload, tools_raw);
    let sanitized = sanitize_responses_client_payload_for_replay_safety(&normalized);
    if has_responses_freeform_apply_patch_tool(tools_raw) {
        convert_apply_patch_function_calls_to_custom_tool_calls(&sanitized)
    } else {
        sanitized
    }
}

fn collect_client_visible_resolved_tool_ids(payload: &Map<String, Value>) -> HashSet<String> {
    let mut resolved = HashSet::<String>::new();
    if let Some(outputs) = payload.get("tool_outputs").and_then(Value::as_array) {
        for entry in outputs {
            let Some(row) = entry.as_object() else {
                continue;
            };
            for key in ["tool_call_id", "call_id", "id"] {
                if let Some(tool_id) = row.get(key).and_then(Value::as_str) {
                    let trimmed = tool_id.trim();
                    if !trimmed.is_empty() {
                        resolved.insert(trimmed.to_string());
                        if let Some(stripped) = trimmed.strip_prefix("fc_") {
                            if !stripped.is_empty() {
                                resolved.insert(stripped.to_string());
                            }
                        }
                        resolved.insert(format!("fc_{}", trimmed));
                    }
                }
            }
        }
    }
    if let Some(output) = payload.get("output").and_then(Value::as_array) {
        for entry in output {
            let Some(row) = entry.as_object() else {
                continue;
            };
            if row.get("type").and_then(Value::as_str) != Some("function_call_output") {
                continue;
            }
            for key in ["tool_call_id", "call_id", "id"] {
                if let Some(tool_id) = row.get(key).and_then(Value::as_str) {
                    let trimmed = tool_id.trim();
                    if !trimmed.is_empty() {
                        resolved.insert(trimmed.to_string());
                        if let Some(stripped) = trimmed.strip_prefix("fc_") {
                            if !stripped.is_empty() {
                                resolved.insert(stripped.to_string());
                            }
                        }
                        resolved.insert(format!("fc_{}", trimmed));
                    }
                }
            }
        }
    }
    resolved
}

fn synthesize_required_action_for_pending_tool_calls(payload: &Value) -> Value {
    let Some(record) = payload.as_object() else {
        return payload.clone();
    };
    let has_required_action = record
        .get("required_action")
        .and_then(Value::as_object)
        .and_then(|required_action| {
            required_action
                .get("submit_tool_outputs")
                .and_then(Value::as_object)
                .and_then(|submit| submit.get("tool_calls"))
                .and_then(Value::as_array)
        })
        .map(|calls| !calls.is_empty())
        .unwrap_or(false);
    if has_required_action {
        return payload.clone();
    }

    let resolved_tool_ids = collect_client_visible_resolved_tool_ids(record);
    let mut pending_calls = Vec::<Value>::new();
    let mut has_visible_message_output = false;
    if let Some(output) = record.get("output").and_then(Value::as_array) {
        for entry in output {
            let Some(row) = entry.as_object() else {
                continue;
            };
            if row.get("type").and_then(Value::as_str) == Some("message") {
                let message_has_visible_text = row
                    .get("content")
                    .and_then(Value::as_array)
                    .map(|items| {
                        items.iter().any(|item| {
                            item.as_object()
                                .and_then(|content| content.get("type"))
                                .and_then(Value::as_str)
                                == Some("output_text")
                                && item
                                    .as_object()
                                    .and_then(|content| content.get("text"))
                                    .and_then(Value::as_str)
                                    .map(str::trim)
                                    .map(|value| !value.is_empty())
                                    .unwrap_or(false)
                        })
                    })
                    .unwrap_or(false);
                if message_has_visible_text {
                    has_visible_message_output = true;
                }
            }
            if row.get("type").and_then(Value::as_str) != Some("function_call") {
                continue;
            }
            let call_id = row
                .get("call_id")
                .or_else(|| row.get("id"))
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty());
            let name = row
                .get("name")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty());
            let arguments = row
                .get("arguments")
                .and_then(Value::as_str)
                .map(ToString::to_string)
                .unwrap_or_else(|| "{}".to_string());
            let (Some(call_id), Some(name)) = (call_id, name) else {
                continue;
            };
            if resolved_tool_ids.contains(call_id)
                || resolved_tool_ids.contains(&format!("fc_{}", call_id))
            {
                continue;
            }
            pending_calls.push(serde_json::json!({
                "id": call_id,
                "type": "function",
                "name": name,
                "arguments": arguments,
                "function": {
                    "name": name,
                    "arguments": arguments,
                }
            }));
        }
    }

    if pending_calls.is_empty() {
        return payload.clone();
    }

    let mut out = record.clone();
    out.insert(
        "status".to_string(),
        Value::String("requires_action".to_string()),
    );
    out.insert(
        "required_action".to_string(),
        serde_json::json!({
            "type": "submit_tool_outputs",
            "submit_tool_outputs": {
                "tool_calls": pending_calls
            }
        }),
    );
    if has_visible_message_output {
        if let Some(output_items) = out.get_mut("output").and_then(Value::as_array_mut) {
            output_items.retain(|entry| {
                entry
                    .as_object()
                    .and_then(|row| row.get("type"))
                    .and_then(Value::as_str)
                    != Some("message")
            });
        }
        out.insert("output_text".to_string(), Value::Null);
    }
    Value::Object(out)
}

fn restore_pending_tool_contract(payload: &Value) -> Value {
    let Some(record) = payload.as_object() else {
        return payload.clone();
    };
    if record.get("output").is_some() {
        return synthesize_required_action_for_pending_tool_calls(payload);
    }
    let Some(response) = record.get("response") else {
        return payload.clone();
    };
    let next_response = synthesize_required_action_for_pending_tool_calls(response);
    if next_response == *response {
        return payload.clone();
    }
    let mut out = record.clone();
    out.insert("response".to_string(), next_response);
    Value::Object(out)
}

pub(crate) fn project_responses_client_payload_for_client(
    responses_payload: &Value,
    tools_raw: &Value,
    metadata: &Value,
) -> Value {
    let projected = project_responses_client_body_for_client_core(responses_payload, tools_raw);
    let restored_tool_contract = restore_pending_tool_contract(&projected);
    restore_client_visible_response_payload(&restored_tool_contract, metadata)
}

pub(crate) fn plan_responses_json_client_dispatch(input: &Value) -> Value {
    let record = input.as_object();
    let entry_endpoint = record
        .and_then(|row| row.get("entryEndpoint"))
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or_default();
    let continuation_owner = record
        .and_then(|row| row.get("continuationOwner"))
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or_default();
    let has_request_context_tools_raw = record
        .and_then(|row| row.get("hasRequestContextToolsRaw"))
        .and_then(Value::as_bool)
        .unwrap_or(false);

    if entry_endpoint != "/v1/responses" && entry_endpoint != "/v1/responses.submit_tool_outputs" {
        return serde_json::json!({
            "action": "direct_passthrough",
            "reason": "non_responses_endpoint"
        });
    }

    if continuation_owner == "direct" && !has_request_context_tools_raw {
        return serde_json::json!({
            "action": "direct_passthrough",
            "reason": "direct_continuation_without_projection_context"
        });
    }

    serde_json::json!({
        "action": "project_client_payload",
        "reason": "responses_client_projection_required"
    })
}

pub(crate) fn project_responses_client_body_for_client(
    responses_payload: &Value,
    tools_raw: &Value,
) -> Value {
    project_responses_client_payload_for_client(responses_payload, tools_raw, &Value::Null)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProjectSseErrorEventPayloadInput {
    request_id: String,
    status: i64,
    message: String,
    code: String,
    #[serde(default)]
    error: Option<Map<String, Value>>,
}

fn trim_required_string(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

pub(crate) fn project_sse_error_event_payload(input: &ProjectSseErrorEventPayloadInput) -> Value {
    let request_id = match input
        .error
        .as_ref()
        .and_then(|error| error.get("request_id"))
        .and_then(Value::as_str)
        .and_then(trim_required_string)
    {
        Some(value) => value,
        None => input.request_id.trim().to_string(),
    };

    let mut error = input.error.clone().unwrap_or_default();
    error.insert(
        "message".to_string(),
        Value::String(input.message.trim().to_string()),
    );
    error.insert(
        "code".to_string(),
        Value::String(input.code.trim().to_string()),
    );
    error.insert("request_id".to_string(), Value::String(request_id));

    serde_json::json!({
        "type": "error",
        "status": input.status,
        "error": error,
    })
}

#[derive(Default)]
struct ResponsesClientSseProjectionState {
    pending_apply_patch_argument_deltas: HashMap<String, String>,
    apply_patch_call_ids: HashSet<String>,
    emitted_apply_patch_done_call_ids: HashSet<String>,
    suppressed_obfuscated_text_delta_keys: HashSet<String>,
}

fn read_string_array(value: Option<&Value>) -> HashSet<String> {
    value
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(ToString::to_string)
                .collect()
        })
        .unwrap_or_default()
}

impl ResponsesClientSseProjectionState {
    fn from_value(value: &Value) -> Self {
        let Some(record) = value.as_object() else {
            return Self::default();
        };
        let mut pending_apply_patch_argument_deltas = HashMap::new();
        if let Some(pending) = record
            .get("pendingApplyPatchArgumentDeltas")
            .and_then(Value::as_object)
        {
            for (key, value) in pending {
                if let Some(text) = value.as_str() {
                    pending_apply_patch_argument_deltas.insert(key.clone(), text.to_string());
                }
            }
        }
        Self {
            pending_apply_patch_argument_deltas,
            apply_patch_call_ids: read_string_array(record.get("applyPatchCallIds")),
            emitted_apply_patch_done_call_ids: read_string_array(
                record.get("emittedApplyPatchDoneCallIds"),
            ),
            suppressed_obfuscated_text_delta_keys: read_string_array(
                record.get("suppressedObfuscatedTextDeltaKeys"),
            ),
        }
    }

    fn to_value(&self) -> Value {
        let mut pending = Map::new();
        let mut pending_keys = self
            .pending_apply_patch_argument_deltas
            .keys()
            .cloned()
            .collect::<Vec<String>>();
        pending_keys.sort();
        for key in pending_keys {
            if let Some(value) = self.pending_apply_patch_argument_deltas.get(key.as_str()) {
                pending.insert(key, Value::String(value.clone()));
            }
        }
        let mut call_ids = self
            .apply_patch_call_ids
            .iter()
            .cloned()
            .collect::<Vec<String>>();
        call_ids.sort();
        let mut emitted = self
            .emitted_apply_patch_done_call_ids
            .iter()
            .cloned()
            .collect::<Vec<String>>();
        emitted.sort();
        let mut suppressed = self
            .suppressed_obfuscated_text_delta_keys
            .iter()
            .cloned()
            .collect::<Vec<String>>();
        suppressed.sort();
        serde_json::json!({
            "pendingApplyPatchArgumentDeltas": pending,
            "applyPatchCallIds": call_ids,
            "emittedApplyPatchDoneCallIds": emitted,
            "suppressedObfuscatedTextDeltaKeys": suppressed,
        })
    }
}

fn read_i64ish_string(value: Option<&Value>) -> String {
    match value {
        Some(Value::Number(num)) => num.to_string(),
        Some(Value::String(text)) => text.trim().to_string(),
        _ => String::new(),
    }
}

fn build_obfuscated_text_delta_key(event_name: &str, data: &Map<String, Value>) -> Option<String> {
    let kind = match event_name {
        "response.output_text.delta" | "response.output_text.done" => "output_text",
        "response.reasoning_summary_text.delta" | "response.reasoning_summary_text.done" => {
            "reasoning_summary_text"
        }
        _ => return None,
    };
    let item_id = data
        .get("item_id")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())?;
    let output_index = read_i64ish_string(data.get("output_index"));
    let content_index = read_i64ish_string(data.get("content_index"));
    let summary_index = read_i64ish_string(data.get("summary_index"));
    Some(format!(
        "{}|{}|{}|{}|{}",
        kind, item_id, output_index, content_index, summary_index
    ))
}

fn build_synthetic_text_delta_frame(
    delta_event_name: &str,
    done_data: &Map<String, Value>,
    text: &str,
) -> Option<String> {
    if text.is_empty() {
        return None;
    }
    let mut payload = Map::new();
    payload.insert(
        "type".to_string(),
        Value::String(delta_event_name.to_string()),
    );
    for key in [
        "output_index",
        "item_id",
        "content_index",
        "summary_index",
        "logprobs",
        "sequence_number",
    ] {
        if let Some(value) = done_data.get(key).cloned() {
            payload.insert(key.to_string(), value);
        }
    }
    payload.insert("delta".to_string(), Value::String(text.to_string()));
    Some(format!(
        "event: {}\ndata: {}\n\n",
        delta_event_name,
        serde_json::to_string(&Value::Object(payload)).unwrap_or_else(|_| "{}".to_string())
    ))
}

fn replace_frame_data(frame: &str, data: &Value) -> String {
    let data_json = serde_json::to_string(data).unwrap_or_else(|_| "null".to_string());
    let lines = frame.split('\n').collect::<Vec<&str>>();
    let data_index = lines.iter().position(|line| line.starts_with("data:"));
    let Some(data_index) = data_index else {
        return frame.to_string();
    };
    let mut out = Vec::<String>::new();
    for (index, line) in lines.iter().enumerate() {
        if index == data_index {
            out.push(format!("data: {}", data_json));
            continue;
        }
        if index > data_index && line.starts_with("data:") {
            continue;
        }
        if !line.is_empty() {
            out.push((*line).to_string());
        }
    }
    format!("{}\n\n", out.join("\n"))
}

fn stringify_sse_tool_call_argument_value(value: &Value) -> String {
    value
        .as_str()
        .map(ToString::to_string)
        .unwrap_or_else(|| serde_json::to_string(value).unwrap_or_default())
}

fn read_data_call_name(data: &Map<String, Value>) -> Option<String> {
    data.get("name")
        .and_then(Value::as_str)
        .map(ToString::to_string)
        .or_else(|| {
            data.get("item")
                .and_then(Value::as_object)
                .and_then(|item| item.get("name"))
                .and_then(Value::as_str)
                .map(ToString::to_string)
        })
}

fn read_data_call_arguments(data: &Map<String, Value>) -> Option<String> {
    data.get("arguments")
        .and_then(Value::as_str)
        .map(ToString::to_string)
        .or_else(|| {
            data.get("item")
                .and_then(Value::as_object)
                .and_then(|item| item.get("arguments"))
                .and_then(Value::as_str)
                .map(ToString::to_string)
        })
}

fn read_data_call_id(data: &Map<String, Value>) -> String {
    data.get("call_id")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
        .or_else(|| {
            data.get("item")
                .and_then(Value::as_object)
                .and_then(|item| item.get("call_id"))
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(ToString::to_string)
        })
        .unwrap_or_else(|| "call_apply_patch".to_string())
}

fn project_apply_patch_done_frame(
    data: &Map<String, Value>,
    normalized_arguments: String,
) -> String {
    let call_id = read_data_call_id(data);
    let custom_tool_done_data = serde_json::json!({
        "type": "response.output_item.done",
        "item": {
            "type": "custom_tool_call",
            "name": "apply_patch",
            "call_id": call_id,
            "input": normalized_arguments,
        }
    });
    format!(
        "event: response.output_item.done\ndata: {}\n\n",
        serde_json::to_string(&custom_tool_done_data).unwrap_or_else(|_| "{}".to_string())
    )
}

fn project_responses_sse_client_payload_deep(value: &Value, tools_raw: &Value) -> Value {
    match value {
        Value::Array(items) => Value::Array(
            items
                .iter()
                .map(|item| project_responses_sse_client_payload_deep(item, tools_raw))
                .collect(),
        ),
        Value::Object(record) => {
            let mut out = Map::new();
            for (key, child) in record {
                out.insert(
                    key.clone(),
                    project_responses_sse_client_payload_deep(child, tools_raw),
                );
            }
            project_responses_client_body_for_client_core(&Value::Object(out), tools_raw)
        }
        _ => value.clone(),
    }
}

fn project_responses_sse_client_event_payload(
    data: &Value,
    tools_raw: &Value,
    metadata: &Value,
) -> Value {
    let projected = project_responses_sse_client_payload_deep(data, tools_raw);
    let restored = restore_client_visible_response_payload(&projected, metadata);
    sanitize_reasoning_sse_payload(&restored)
}

fn sanitize_reasoning_sse_payload(value: &Value) -> Value {
    match value {
        Value::Array(items) => {
            Value::Array(items.iter().map(sanitize_reasoning_sse_payload).collect())
        }
        Value::Object(record) => {
            let mut out = Map::new();
            for (key, child) in record {
                out.insert(key.clone(), sanitize_reasoning_sse_payload(child));
            }
            if out.get("type").and_then(Value::as_str) == Some("reasoning") {
                out.remove("status");
                if let Some(summary) = out.get_mut("summary") {
                    normalize_reasoning_summary_for_codex_display(summary);
                }
            }
            Value::Object(out)
        }
        _ => value.clone(),
    }
}

fn mark_response_function_call_outputs_completed(response: &mut Map<String, Value>) {
    let Some(output) = response.get_mut("output").and_then(Value::as_array_mut) else {
        return;
    };
    for item in output {
        let Some(item_obj) = item.as_object_mut() else {
            continue;
        };
        if item_obj.get("type").and_then(Value::as_str) == Some("function_call") {
            item_obj.insert("status".to_string(), Value::String("completed".to_string()));
        }
    }
}

fn project_responses_terminal_event_payload_for_client(data: &Value) -> Value {
    let Some(record) = data.as_object() else {
        return sanitize_responses_client_payload_for_replay_safety(data);
    };
    let Some(response) = record.get("response").and_then(Value::as_object) else {
        return sanitize_responses_client_payload_for_replay_safety(data);
    };
    let response_has_required_action = response.get("required_action").is_some();
    let top_level_has_required_action = record.get("required_action").is_some();
    let response_requires_action = response
        .get("status")
        .and_then(Value::as_str)
        .map(|value| value.eq_ignore_ascii_case("requires_action"))
        .unwrap_or(false);
    if !response_has_required_action && !top_level_has_required_action && !response_requires_action
    {
        return sanitize_responses_client_payload_for_replay_safety(data);
    }

    let mut next = data.clone();
    if let Some(next_record) = next.as_object_mut() {
        next_record.remove("required_action");
        if let Some(next_response) = next_record
            .get_mut("response")
            .and_then(Value::as_object_mut)
        {
            next_response.remove("required_action");
            if next_response
                .get("status")
                .and_then(Value::as_str)
                .map(|value| value.eq_ignore_ascii_case("requires_action"))
                .unwrap_or(false)
            {
                next_response.insert("status".to_string(), Value::String("completed".to_string()));
            }
            mark_response_function_call_outputs_completed(next_response);
        }
    }
    sanitize_responses_client_payload_for_replay_safety(&next)
}

fn build_standard_tool_call_sse_frames_from_required_action_payload(
    data: &Value,
) -> Option<String> {
    let record = data.as_object()?;
    let required_action = record.get("required_action").and_then(Value::as_object)?;
    let calls = required_action
        .get("submit_tool_outputs")
        .and_then(Value::as_object)
        .and_then(|submit| submit.get("tool_calls"))
        .and_then(Value::as_array)?;
    if calls.is_empty() {
        return None;
    }
    let response = record
        .get("response")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let output = response.get("output").and_then(Value::as_array);
    let mut frames = Vec::<String>::new();
    for (index, call) in calls.iter().enumerate() {
        let Some(call_obj) = call.as_object() else {
            continue;
        };
        let function = call_obj.get("function").and_then(Value::as_object);
        let call_id = call_obj
            .get("id")
            .or_else(|| call_obj.get("call_id"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| "call_1");
        let name = function
            .and_then(|row| row.get("name"))
            .or_else(|| call_obj.get("name"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or("function");
        let arguments = function
            .and_then(|row| row.get("arguments"))
            .or_else(|| call_obj.get("arguments"))
            .map(stringify_sse_tool_call_argument_value)
            .unwrap_or_default();
        let output_item = output.and_then(|items| {
            items.iter().find_map(|item| {
                let row = item.as_object()?;
                if row.get("type").and_then(Value::as_str) != Some("function_call") {
                    return None;
                }
                let item_call_id = row
                    .get("call_id")
                    .or_else(|| row.get("id"))
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())?;
                if item_call_id == call_id {
                    Some(item.clone())
                } else {
                    None
                }
            })
        });
        let item_id = output_item
            .as_ref()
            .and_then(|item| item.get("id"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToString::to_string)
            .unwrap_or_else(|| format!("fc_{}", call_id));
        let item_call_id = output_item
            .as_ref()
            .and_then(|item| item.get("call_id"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToString::to_string)
            .unwrap_or_else(|| call_id.to_string());
        let item_name = output_item
            .as_ref()
            .and_then(|item| item.get("name"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToString::to_string)
            .unwrap_or_else(|| name.to_string());
        let item_arguments = output_item
            .as_ref()
            .and_then(|item| item.get("arguments"))
            .map(stringify_sse_tool_call_argument_value)
            .unwrap_or(arguments);
        frames.push(format!(
            "event: response.output_item.added\ndata: {}\n\n",
            serde_json::json!({
                "type": "response.output_item.added",
                "output_index": index,
                "item": {
                    "id": item_id,
                    "type": "function_call",
                    "call_id": item_call_id,
                    "name": item_name,
                    "arguments": "",
                    "status": "in_progress"
                }
            })
        ));
        frames.push(format!(
            "event: response.function_call_arguments.delta\ndata: {}\n\n",
            serde_json::json!({
                "type": "response.function_call_arguments.delta",
                "output_index": index,
                "item_id": item_id,
                "call_id": item_call_id,
                "delta": item_arguments
            })
        ));
        frames.push(format!(
            "event: response.function_call_arguments.done\ndata: {}\n\n",
            serde_json::json!({
                "type": "response.function_call_arguments.done",
                "output_index": index,
                "item_id": item_id,
                "call_id": item_call_id,
                "name": item_name,
                "arguments": item_arguments
            })
        ));
        let mut done_item = output_item.unwrap_or_else(|| {
            serde_json::json!({
                "id": item_id,
                "type": "function_call",
                "call_id": item_call_id,
                "name": item_name,
                "arguments": item_arguments
            })
        });
        if let Some(done_obj) = done_item.as_object_mut() {
            done_obj.insert("status".to_string(), Value::String("completed".to_string()));
            done_obj
                .entry("arguments".to_string())
                .or_insert_with(|| Value::String(item_arguments));
        }
        frames.push(format!(
            "event: response.output_item.done\ndata: {}\n\n",
            serde_json::json!({
                "type": "response.output_item.done",
                "output_index": index,
                "item": done_item
            })
        ));
    }
    if frames.is_empty() {
        None
    } else {
        Some(frames.join(""))
    }
}

pub(crate) fn project_responses_sse_frame_for_client(
    frame: &str,
    event_name: Option<&str>,
    data: &Value,
    tools_raw: &Value,
    metadata: &Value,
    state_value: &Value,
) -> Value {
    let mut state = ResponsesClientSseProjectionState::from_value(state_value);
    let mut output_frame = frame.to_string();
    let mut emit = true;

    let event_name = event_name.unwrap_or("").trim();
    if let Some(item) = data.get("item").and_then(Value::as_object) {
        if item.get("type").and_then(Value::as_str) == Some("function_call")
            && item.get("name").and_then(Value::as_str) == Some("apply_patch")
        {
            if let Some(call_id) = item
                .get("call_id")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
            {
                state.apply_patch_call_ids.insert(call_id.to_string());
            }
        }
    }

    if event_name == "response.output_item.added"
        && has_responses_freeform_apply_patch_tool(tools_raw)
    {
        if let Some(item) = data.get("item").and_then(Value::as_object) {
            if item.get("type").and_then(Value::as_str) == Some("function_call")
                && item.get("name").and_then(Value::as_str) == Some("apply_patch")
            {
                emit = false;
                output_frame.clear();
            }
        }
    }

    let data_record = data.as_object();
    if event_name == "response.required_action" {
        if let Some(projected_frame) =
            build_standard_tool_call_sse_frames_from_required_action_payload(data)
        {
            output_frame = projected_frame;
        }
    } else if matches!(
        event_name,
        "response.output_text.delta" | "response.reasoning_summary_text.delta"
    ) {
        if let Some(record) = data_record {
            let has_obfuscation = record
                .get("obfuscation")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .is_some();
            if has_obfuscation {
                if let Some(key) = build_obfuscated_text_delta_key(event_name, record) {
                    state.suppressed_obfuscated_text_delta_keys.insert(key);
                    emit = false;
                    output_frame.clear();
                }
            } else {
                let normalized =
                    project_responses_sse_client_event_payload(data, tools_raw, metadata);
                if normalized != *data {
                    output_frame = replace_frame_data(frame, &normalized);
                }
            }
        }
    } else if matches!(
        event_name,
        "response.output_text.done" | "response.reasoning_summary_text.done"
    ) {
        if let Some(record) = data_record {
            let normalized = project_responses_sse_client_event_payload(data, tools_raw, metadata);
            let normalized_record = normalized.as_object().unwrap_or(record);
            let key = build_obfuscated_text_delta_key(event_name, normalized_record)
                .or_else(|| build_obfuscated_text_delta_key(event_name, record));
            let maybe_text = normalized_record
                .get("text")
                .and_then(Value::as_str)
                .or_else(|| record.get("text").and_then(Value::as_str))
                .unwrap_or("");
            if let Some(key) = key {
                if state
                    .suppressed_obfuscated_text_delta_keys
                    .remove(key.as_str())
                {
                    let delta_event_name = if event_name == "response.output_text.done" {
                        "response.output_text.delta"
                    } else {
                        "response.reasoning_summary_text.delta"
                    };
                    if let Some(delta_frame) = build_synthetic_text_delta_frame(
                        delta_event_name,
                        normalized_record,
                        maybe_text,
                    ) {
                        let done_frame = if normalized != *data {
                            replace_frame_data(frame, &normalized)
                        } else {
                            frame.to_string()
                        };
                        output_frame = format!("{}{}", delta_frame, done_frame);
                    } else if normalized != *data {
                        output_frame = replace_frame_data(frame, &normalized);
                    }
                } else if normalized != *data {
                    output_frame = replace_frame_data(frame, &normalized);
                }
            } else if normalized != *data {
                output_frame = replace_frame_data(frame, &normalized);
            }
        }
    } else if event_name == "response.completed" || event_name == "response.done" {
        let normalized = project_responses_terminal_event_payload_for_client(data);
        if normalized != *data {
            output_frame = replace_frame_data(frame, &normalized);
        }
    } else if event_name == "response.function_call_arguments.delta" {
        if let Some(record) = data_record {
            let call_name = record.get("name").and_then(Value::as_str);
            let call_id = read_data_call_id(record);
            let delta = record.get("delta").and_then(Value::as_str);
            if let Some(delta) = delta {
                if call_name == Some("apply_patch") || state.apply_patch_call_ids.contains(&call_id)
                {
                    let entry = state
                        .pending_apply_patch_argument_deltas
                        .entry(call_id)
                        .or_default();
                    entry.push_str(delta);
                    emit = false;
                }
            }
        }
    } else if let Some(record) = data_record {
        let call_name = read_data_call_name(record);
        let call_id = read_data_call_id(record);
        let is_apply_patch_call = call_name.as_deref() == Some("apply_patch")
            || state.apply_patch_call_ids.contains(call_id.as_str());
        let call_arguments = read_data_call_arguments(record)
            .and_then(|value| {
                if value.trim().is_empty() {
                    None
                } else {
                    Some(value)
                }
            })
            .or_else(|| {
                state
                    .pending_apply_patch_argument_deltas
                    .get(call_id.as_str())
                    .cloned()
            });
        if is_apply_patch_call {
            if let Some(call_arguments) = call_arguments {
                if call_arguments.is_empty() {
                    if event_name == "response.function_call_arguments.done"
                        || event_name == "response.output_item.done"
                    {
                        emit = false;
                        output_frame.clear();
                    }
                    return serde_json::json!({
                        "emit": emit,
                        "frame": output_frame,
                        "state": state.to_value(),
                    });
                }
                let mut next_data = data.clone();
                let normalized_arguments =
                    normalize_apply_patch_freeform_input_for_client(call_arguments.as_str());
                if let Some(next_record) = next_data.as_object_mut() {
                    if next_record.get("arguments").is_some() {
                        next_record.insert(
                            "arguments".to_string(),
                            Value::String(normalized_arguments.clone()),
                        );
                    }
                    if let Some(item) = next_record.get_mut("item").and_then(Value::as_object_mut) {
                        if item.get("arguments").is_some() {
                            item.insert(
                                "arguments".to_string(),
                                Value::String(normalized_arguments.clone()),
                            );
                        }
                    }
                }
                let client_data = if has_responses_freeform_apply_patch_tool(tools_raw) {
                    project_responses_client_payload_for_client(&next_data, tools_raw, metadata)
                } else {
                    restore_client_visible_response_payload(&next_data, metadata)
                };
                output_frame = replace_frame_data(frame, &client_data);

                if event_name == "response.function_call_arguments.done" {
                    state
                        .pending_apply_patch_argument_deltas
                        .remove(call_id.as_str());
                    state.apply_patch_call_ids.remove(call_id.as_str());
                    if state
                        .emitted_apply_patch_done_call_ids
                        .contains(call_id.as_str())
                    {
                        emit = false;
                    } else {
                        state
                            .emitted_apply_patch_done_call_ids
                            .insert(call_id.clone());
                        output_frame = project_apply_patch_done_frame(record, normalized_arguments);
                    }
                } else if event_name == "response.output_item.done" {
                    state
                        .pending_apply_patch_argument_deltas
                        .remove(call_id.as_str());
                    state.apply_patch_call_ids.remove(call_id.as_str());
                    if state
                        .emitted_apply_patch_done_call_ids
                        .contains(call_id.as_str())
                    {
                        emit = false;
                    } else {
                        state
                            .emitted_apply_patch_done_call_ids
                            .insert(call_id.clone());
                        output_frame = project_apply_patch_done_frame(record, normalized_arguments);
                    }
                }
            }
        } else {
            let normalized = project_responses_sse_client_event_payload(data, tools_raw, metadata);
            if normalized != *data {
                output_frame = replace_frame_data(frame, &normalized);
            }
        }
    }

    serde_json::json!({
        "emit": emit,
        "frame": if emit { output_frame } else { String::new() },
        "state": state.to_value(),
    })
}

#[cfg(test)]
mod tests {
    use super::{project_sse_error_event_payload, ProjectSseErrorEventPayloadInput};
    use serde_json::{json, Map, Value};

    #[test]
    fn project_sse_error_event_payload_uses_request_id_when_nested_request_id_is_missing() {
        let input = ProjectSseErrorEventPayloadInput {
            request_id: " req_local ".to_string(),
            status: 504,
            message: " timeout ".to_string(),
            code: " HTTP_SSE_TIMEOUT ".to_string(),
            error: None,
        };

        let output = project_sse_error_event_payload(&input);

        assert_eq!(
            output,
            json!({
                "type": "error",
                "status": 504,
                "error": {
                    "message": "timeout",
                    "code": "HTTP_SSE_TIMEOUT",
                    "request_id": "req_local",
                }
            })
        );
    }

    #[test]
    fn project_sse_error_event_payload_preserves_explicit_nested_request_id() {
        let mut error = Map::new();
        error.insert(
            "request_id".to_string(),
            Value::String(" req_upstream ".to_string()),
        );
        error.insert(
            "provider_key".to_string(),
            Value::String("tab.default.gpt-5.1".to_string()),
        );
        let input = ProjectSseErrorEventPayloadInput {
            request_id: "req_local".to_string(),
            status: 500,
            message: "stream failed".to_string(),
            code: "sse_stream_error".to_string(),
            error: Some(error),
        };

        let output = project_sse_error_event_payload(&input);
        let error = output
            .as_object()
            .and_then(|row| row.get("error"))
            .and_then(Value::as_object)
            .expect("error object");

        assert_eq!(
            error.get("request_id"),
            Some(&Value::String("req_upstream".to_string()))
        );
        assert_eq!(
            error.get("provider_key"),
            Some(&Value::String("tab.default.gpt-5.1".to_string()))
        );
        assert_eq!(
            error.get("message"),
            Some(&Value::String("stream failed".to_string()))
        );
        assert_eq!(
            error.get("code"),
            Some(&Value::String("sse_stream_error".to_string()))
        );
    }
}
