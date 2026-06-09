// feature_id: hub.response_responses_client_projection
// canonical_builders: project_responses_client_body_for_client, project_responses_sse_frame_for_client

use serde_json::{Map, Value};
use std::collections::{HashMap, HashSet};

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

pub(crate) fn project_responses_client_body_for_client(
    responses_payload: &Value,
    tools_raw: &Value,
) -> Value {
    let normalized = normalize_responses_tool_call_arguments_for_client(responses_payload, tools_raw);
    if has_responses_freeform_apply_patch_tool(tools_raw) {
        convert_apply_patch_function_calls_to_custom_tool_calls(&normalized)
    } else {
        normalized
    }
}

#[derive(Default)]
struct ResponsesClientSseProjectionState {
    pending_apply_patch_argument_deltas: HashMap<String, String>,
    apply_patch_call_ids: HashSet<String>,
    emitted_apply_patch_done_call_ids: HashSet<String>,
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
        serde_json::json!({
            "pendingApplyPatchArgumentDeltas": pending,
            "applyPatchCallIds": call_ids,
            "emittedApplyPatchDoneCallIds": emitted,
        })
    }
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

fn project_apply_patch_done_frame(data: &Map<String, Value>, normalized_arguments: String) -> String {
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
            project_responses_client_body_for_client(&Value::Object(out), tools_raw)
        }
        _ => value.clone(),
    }
}

pub(crate) fn project_responses_sse_frame_for_client(
    frame: &str,
    event_name: Option<&str>,
    data: &Value,
    tools_raw: &Value,
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

    let data_record = data.as_object();
    if event_name == "response.function_call_arguments.delta" {
        if let Some(record) = data_record {
            let call_name = record.get("name").and_then(Value::as_str);
            let call_id = read_data_call_id(record);
            let delta = record.get("delta").and_then(Value::as_str);
            if let Some(delta) = delta {
                if call_name == Some("apply_patch") || state.apply_patch_call_ids.contains(&call_id) {
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
        let call_arguments = read_data_call_arguments(record);
        if call_name.as_deref() == Some("apply_patch") {
            if let Some(call_arguments) = call_arguments {
                if call_arguments.is_empty() {
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
                    convert_apply_patch_function_calls_to_custom_tool_calls(&next_data)
                } else {
                    next_data
                };
                output_frame = replace_frame_data(frame, &client_data);

                if event_name == "response.function_call_arguments.done" {
                    let call_id = read_data_call_id(record);
                    state
                        .pending_apply_patch_argument_deltas
                        .remove(call_id.as_str());
                    state.apply_patch_call_ids.remove(call_id.as_str());
                    if state.emitted_apply_patch_done_call_ids.contains(call_id.as_str()) {
                        emit = false;
                    } else {
                        state
                            .emitted_apply_patch_done_call_ids
                            .insert(call_id.clone());
                        output_frame = project_apply_patch_done_frame(record, normalized_arguments);
                    }
                } else if event_name == "response.output_item.done" {
                    let call_id = read_data_call_id(record);
                    if state.emitted_apply_patch_done_call_ids.contains(call_id.as_str()) {
                        emit = false;
                    } else {
                        state.emitted_apply_patch_done_call_ids.insert(call_id);
                    }
                }
            }
        } else {
            let normalized = project_responses_sse_client_payload_deep(data, tools_raw);
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
