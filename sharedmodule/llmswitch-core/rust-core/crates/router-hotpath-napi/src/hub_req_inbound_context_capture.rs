// feature_id: hub.req_inbound_responses_context_capture
use crate::hub_bridge_actions::convert_bridge_input_to_chat_messages;
use crate::hub_bridge_actions::BridgeInputToChatInput;
use crate::hub_req_inbound_tool_call_normalization::normalize_apply_patch_output_text;
use crate::hub_req_inbound_tool_call_normalization::normalize_shell_like_tool_calls_before_governance;
use crate::hub_req_inbound_tool_output_snapshot::collect_tool_outputs;
use crate::hub_tool_session_compat::{
    filter_namespace_mcp_aggregator_tool_definitions, normalize_tool_session_messages,
};
use crate::shared_json_utils::read_trimmed_string;
use crate::shared_tool_mapping::enforce_builtin_tool_schema;
use crate::shared_tooling::{
    strip_provider_tool_sentinel_residue, unwrap_chunked_exec_transcript_shape,
};
use napi::bindgen_prelude::Result as NapiResult;
use napi_derive::napi;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResponsesContextCaptureInput {
    pub raw_request: Value,
    pub request_id: Option<String>,
    pub tool_call_id_style: Option<Value>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ResponsesHostPolicyInput {
    context: Option<Value>,
    target_protocol: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ResponsesHostPolicyOutput {
    should_strip_host_managed_fields: bool,
    target_protocol: String,
}

fn normalize_tool_call_id_style_candidate(value: &Value) -> Option<String> {
    let normalized = value.as_str().unwrap_or("").trim().to_ascii_lowercase();
    if normalized == "fc" {
        return Some("fc".to_string());
    }
    if normalized == "preserve" {
        return Some("preserve".to_string());
    }
    None
}

fn normalize_non_empty(value: Option<String>) -> Option<String> {
    let trimmed = value.unwrap_or_default().trim().to_string();
    if trimmed.is_empty() {
        return None;
    }
    Some(trimmed)
}

fn normalize_captured_responses_context(
    input: Vec<Value>,
    tools: Option<Vec<Value>>,
    allow_orphan_tool_result: bool,
) -> Result<(Vec<Value>, Option<Vec<Value>>), String> {
    let mut tools_value = tools.clone().map(Value::Array).unwrap_or(Value::Null);
    filter_namespace_mcp_aggregator_tool_definitions(&mut tools_value);
    let normalized_tools = tools_value.as_array().cloned();
    let converted = convert_bridge_input_to_chat_messages(BridgeInputToChatInput {
        input,
        tools: normalized_tools.clone(),
        tool_result_fallback_text: Some(String::new()),
        normalize_function_name: Some("responses".to_string()),
        allow_pending_terminal_tool_call: Some(true),
        allow_orphan_tool_result: Some(allow_orphan_tool_result),
    })?;
    let messages = normalize_tool_session_messages(converted.messages);
    Ok((messages, normalized_tools))
}

fn read_bool(value: Option<&Value>) -> Option<bool> {
    match value {
        Some(Value::Bool(v)) => Some(*v),
        _ => None,
    }
}

fn normalize_tool_parameters(name: &str, value: Option<&Value>) -> Option<Value> {
    let normalized = name.trim().to_ascii_lowercase();
    if normalized == "apply_patch" {
        return value.cloned();
    }
    enforce_builtin_tool_schema(name, value)
}

fn read_tool_schema_source<'a>(
    function_row: Option<&'a Map<String, Value>>,
    tool_row: &'a Map<String, Value>,
) -> Option<&'a Value> {
    function_row
        .and_then(|v| v.get("parameters"))
        .or_else(|| function_row.and_then(|v| v.get("input_schema")))
        .or_else(|| tool_row.get("parameters"))
        .or_else(|| tool_row.get("input_schema"))
}

fn responses_input_contains_tool_history(items: &[Value]) -> bool {
    for entry in items {
        let Some(row) = entry.as_object() else {
            continue;
        };
        let ty = read_trimmed_string(row.get("type"))
            .unwrap_or_default()
            .to_ascii_lowercase();
        if matches!(
            ty.as_str(),
            "function_call"
                | "custom_tool_call"
                | "tool_call"
                | "function_call_output"
                | "custom_tool_call_output"
                | "tool_result"
                | "tool_message"
        ) {
            return true;
        }
        if row
            .get("tool_calls")
            .and_then(Value::as_array)
            .map(|v| !v.is_empty())
            .unwrap_or(false)
        {
            return true;
        }
    }
    false
}

fn filter_orphan_responses_tool_outputs(items: Vec<Value>) -> Vec<Value> {
    let mut valid_call_ids = std::collections::HashSet::new();
    let mut saw_function_calls = false;
    for entry in &items {
        let Some(row) = entry.as_object() else {
            continue;
        };
        let ty = read_trimmed_string(row.get("type"))
            .unwrap_or_default()
            .to_ascii_lowercase();
        if ty != "function_call" && ty != "custom_tool_call" && ty != "tool_call" {
            continue;
        }
        saw_function_calls = true;
        for key in ["call_id", "tool_call_id", "id"] {
            if let Some(value) = read_trimmed_string(row.get(key)) {
                valid_call_ids.insert(value);
            }
        }
    }

    if !saw_function_calls {
        return items;
    }

    items
        .into_iter()
        .filter(|entry| {
            let Some(row) = entry.as_object() else {
                return true;
            };
            let ty = read_trimmed_string(row.get("type"))
                .unwrap_or_default()
                .to_ascii_lowercase();
            if !matches!(
                ty.as_str(),
                "function_call_output" | "custom_tool_call_output" | "tool_result" | "tool_message"
            ) {
                return true;
            }
            let call_id = read_trimmed_string(row.get("call_id"))
                .or_else(|| read_trimmed_string(row.get("tool_call_id")))
                .or_else(|| read_trimmed_string(row.get("tool_use_id")))
                .or_else(|| read_trimmed_string(row.get("id")));
            match call_id {
                Some(value) => valid_call_ids.contains(value.as_str()),
                None => false,
            }
        })
        .collect()
}

fn normalize_message_shape_responses_items(items: &[Value]) -> Vec<Value> {
    let mut normalized: Vec<Value> = Vec::new();
    for entry in items {
        let Some(row) = entry.as_object() else {
            normalized.push(entry.clone());
            continue;
        };
        let role = read_trimmed_string(row.get("role"))
            .unwrap_or_default()
            .to_ascii_lowercase();
        let item_type = read_trimmed_string(row.get("type"))
            .unwrap_or_default()
            .to_ascii_lowercase();

        if role == "assistant" {
            let tool_calls = row.get("tool_calls").and_then(Value::as_array);
            if let Some(tool_calls) = tool_calls.filter(|calls| !calls.is_empty()) {
                for call in tool_calls {
                    let Some(call_row) = call.as_object() else {
                        continue;
                    };
                    let function_row = call_row
                        .get("function")
                        .and_then(Value::as_object)
                        .cloned()
                        .unwrap_or_default();
                    let name = read_trimmed_string(function_row.get("name"))
                        .or_else(|| read_trimmed_string(call_row.get("name")));
                    let call_id = read_trimmed_string(call_row.get("call_id"))
                        .or_else(|| read_trimmed_string(call_row.get("tool_call_id")))
                        .or_else(|| read_trimmed_string(call_row.get("id")));
                    let Some(name) = name else {
                        continue;
                    };
                    let Some(call_id) = call_id else {
                        continue;
                    };
                    let arguments = function_row
                        .get("arguments")
                        .cloned()
                        .or_else(|| call_row.get("arguments").cloned())
                        .unwrap_or_else(|| Value::String("{}".to_string()));
                    normalized.push(serde_json::json!({
                        "type": "function_call",
                        "id": call_id,
                        "call_id": call_id,
                        "name": name,
                        "arguments": arguments
                    }));
                }
                continue;
            }
        }

        if role == "tool" {
            let call_id = read_trimmed_string(row.get("tool_call_id"))
                .or_else(|| read_trimmed_string(row.get("call_id")))
                .or_else(|| read_trimmed_string(row.get("id")));
            if let Some(call_id) = call_id {
                let output = row
                    .get("content")
                    .cloned()
                    .or_else(|| row.get("output").cloned())
                    .unwrap_or_else(|| Value::String(String::new()));
                normalized.push(serde_json::json!({
                    "type": "function_call_output",
                    "id": call_id,
                    "call_id": call_id,
                    "output": output
                }));
                continue;
            }
        }

        if item_type == "message" || role == "user" {
            normalized.push(entry.clone());
            continue;
        }

        normalized.push(entry.clone());
    }
    normalized
}

fn canonicalize_tool_arguments_value(value: Option<&Value>) -> String {
    let Some(raw) = value else {
        return String::new();
    };
    match raw {
        Value::String(text) => {
            let stripped = strip_provider_tool_sentinel_residue(text.as_str());
            if let Ok(parsed) = serde_json::from_str::<Value>(stripped.as_str()) {
                return serde_json::to_string(&parsed).unwrap_or(stripped);
            }
            stripped.trim().to_string()
        }
        other => serde_json::to_string(other).unwrap_or_default(),
    }
}

fn build_function_call_semantic_signature(row: &Map<String, Value>) -> Option<String> {
    let name = read_trimmed_string(row.get("name"))
        .map(|value| value.trim().to_ascii_lowercase())
        .filter(|value| !value.is_empty())?;
    let arguments = canonicalize_tool_arguments_value(
        row.get("arguments")
            .or_else(|| row.get("input"))
            .or_else(|| row.get("args"))
            .or_else(|| row.get("payload")),
    );
    Some(format!("{name}\n{arguments}"))
}

fn normalize_tool_output_text_for_storage(tool_name: Option<&str>, raw: &str) -> String {
    let stripped = strip_provider_tool_sentinel_residue(raw);
    let normalized =
        if let Some(unwrapped) = unwrap_chunked_exec_transcript_shape(stripped.as_str()) {
            unwrapped
        } else {
            stripped.trim().to_string()
        };
    if tool_name
        .map(|value| value.trim().eq_ignore_ascii_case("apply_patch"))
        .unwrap_or(false)
    {
        return normalize_apply_patch_output_text(normalized.as_str());
    }
    normalized
}

fn canonicalize_tool_output_text_for_compare(tool_name: Option<&str>, raw: &str) -> String {
    normalize_tool_output_text_for_storage(tool_name, raw)
}

fn build_duplicate_responses_call_id_rewrites(
    items: &[Value],
    allowed_tool_names: &std::collections::HashSet<String>,
) -> std::collections::HashMap<usize, String> {
    #[derive(Default)]
    struct CallIdOccurrences {
        call_indexes: Vec<usize>,
        output_indexes: Vec<usize>,
        call_signatures: Vec<Option<String>>,
    }

    let mut occurrences = std::collections::HashMap::<String, CallIdOccurrences>::new();

    for (index, entry) in items.iter().enumerate() {
        let Some(row) = entry.as_object() else {
            continue;
        };
        let ty = read_trimmed_string(row.get("type"))
            .unwrap_or_default()
            .to_ascii_lowercase();

        if matches!(
            ty.as_str(),
            "function_call" | "custom_tool_call" | "tool_call"
        ) {
            let name = read_trimmed_string(row.get("name"))
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty());
            let Some(name) = name else {
                continue;
            };
            let lowered_name = name.to_ascii_lowercase();
            let name_allowed =
                allowed_tool_names.is_empty() || allowed_tool_names.contains(lowered_name.as_str());
            if name.len() > 128 || !name_allowed {
                continue;
            }
            let call_id = read_trimmed_string(row.get("call_id"))
                .or_else(|| read_trimmed_string(row.get("tool_call_id")))
                .or_else(|| read_trimmed_string(row.get("id")));
            let Some(call_id) = call_id else {
                continue;
            };
            occurrences.entry(call_id.clone()).or_default();
            let occurrence = occurrences.get_mut(&call_id).expect("occurrence inserted");
            occurrence.call_indexes.push(index);
            occurrence
                .call_signatures
                .push(build_function_call_semantic_signature(row));
            continue;
        }

        if matches!(
            ty.as_str(),
            "function_call_output" | "custom_tool_call_output" | "tool_result" | "tool_message"
        ) {
            let call_id = read_trimmed_string(row.get("call_id"))
                .or_else(|| read_trimmed_string(row.get("tool_call_id")))
                .or_else(|| read_trimmed_string(row.get("tool_use_id")))
                .or_else(|| read_trimmed_string(row.get("id")));
            let Some(call_id) = call_id else {
                continue;
            };
            occurrences
                .entry(call_id)
                .or_default()
                .output_indexes
                .push(index);
        }
    }

    let mut rewrites = std::collections::HashMap::<usize, String>::new();

    for (raw_call_id, occurrence) in occurrences {
        if occurrence.call_indexes.len() <= 1 {
            continue;
        }

        let mut rewritten_ids = Vec::with_capacity(occurrence.call_indexes.len());
        let mut signature_to_group = std::collections::HashMap::<String, usize>::new();
        let mut next_group_ordinal = 0usize;
        for (ordinal, call_index) in occurrence.call_indexes.iter().enumerate() {
            let group_ordinal = occurrence
                .call_signatures
                .get(ordinal)
                .and_then(|signature| signature.as_ref())
                .map(|signature| {
                    if let Some(existing) = signature_to_group.get(signature.as_str()) {
                        *existing
                    } else {
                        let assigned = next_group_ordinal;
                        signature_to_group.insert(signature.clone(), assigned);
                        next_group_ordinal += 1;
                        assigned
                    }
                })
                .unwrap_or_else(|| {
                    let assigned = next_group_ordinal;
                    next_group_ordinal += 1;
                    assigned
                });
            let rewritten = if group_ordinal == 0 {
                raw_call_id.clone()
            } else {
                format!("{raw_call_id}__rcc_occurrence_{}", group_ordinal + 1)
            };
            rewritten_ids.push(rewritten.clone());
            rewrites.insert(*call_index, rewritten);
        }

        for (ordinal, output_index) in occurrence.output_indexes.iter().enumerate() {
            if let Some(rewritten) = rewritten_ids.get(ordinal) {
                rewrites.insert(*output_index, rewritten.clone());
            }
        }
    }

    rewrites
}

fn rewrite_responses_tool_history_entry_call_id(
    index: usize,
    row: &Map<String, Value>,
    rewrites: &std::collections::HashMap<usize, String>,
) -> Map<String, Value> {
    let Some(rewritten_call_id) = rewrites.get(&index) else {
        return row.clone();
    };
    let mut next = row.clone();
    let ty = read_trimmed_string(row.get("type"))
        .unwrap_or_default()
        .to_ascii_lowercase();

    if matches!(
        ty.as_str(),
        "function_call" | "custom_tool_call" | "tool_call"
    ) {
        next.insert(
            "call_id".to_string(),
            Value::String(rewritten_call_id.clone()),
        );
        next.insert("id".to_string(), Value::String(rewritten_call_id.clone()));
        if row.contains_key("tool_call_id") {
            next.insert(
                "tool_call_id".to_string(),
                Value::String(rewritten_call_id.clone()),
            );
        }
        return next;
    }

    if matches!(
        ty.as_str(),
        "function_call_output" | "custom_tool_call_output" | "tool_result" | "tool_message"
    ) {
        next.insert(
            "call_id".to_string(),
            Value::String(rewritten_call_id.clone()),
        );
        next.insert(
            "tool_call_id".to_string(),
            Value::String(rewritten_call_id.clone()),
        );
    }

    next
}

fn strip_provider_tool_sentinel_residue_from_value(value: Value) -> Value {
    match value {
        Value::String(text) => Value::String(strip_provider_tool_sentinel_residue(text.as_str())),
        Value::Array(items) => Value::Array(
            items
                .into_iter()
                .map(strip_provider_tool_sentinel_residue_from_value)
                .collect(),
        ),
        Value::Object(row) => Value::Object(
            row.into_iter()
                .map(|(key, value)| (key, strip_provider_tool_sentinel_residue_from_value(value)))
                .collect(),
        ),
        other => other,
    }
}

fn strip_provider_tool_sentinel_residue_from_row(row: Map<String, Value>) -> Map<String, Value> {
    match strip_provider_tool_sentinel_residue_from_value(Value::Object(row)) {
        Value::Object(cleaned) => cleaned,
        _ => Map::new(),
    }
}

pub(crate) fn map_bridge_tools_to_chat(raw_tools: &[Value]) -> Vec<Value> {
    let mut mapped: Vec<Value> = Vec::new();

    for entry in raw_tools {
        let Some(tool_row) = entry.as_object() else {
            continue;
        };
        let function_row = tool_row.get("function").and_then(|v| v.as_object());
        let raw_type =
            read_trimmed_string(tool_row.get("type")).unwrap_or_else(|| "function".to_string());
        if raw_type.trim().eq_ignore_ascii_case("namespace") {
            let namespace_name = read_trimmed_string(tool_row.get("name"));
            let child_tools = tool_row
                .get("tools")
                .and_then(Value::as_array)
                .map(|rows| {
                    rows.iter()
                        .filter_map(|child| {
                            let child_row = child.as_object()?;
                            let child_function =
                                child_row.get("function").and_then(|v| v.as_object());
                            let child_name = read_trimmed_string(
                                child_function
                                    .and_then(|v| v.get("name"))
                                    .or_else(|| child_row.get("name")),
                            )?;
                            let mut child_out = Map::new();
                            child_out
                                .insert("type".to_string(), Value::String("function".to_string()));
                            child_out.insert("name".to_string(), Value::String(child_name.clone()));
                            if let Some(description) = read_trimmed_string(
                                child_function
                                    .and_then(|v| v.get("description"))
                                    .or_else(|| child_row.get("description")),
                            ) {
                                child_out
                                    .insert("description".to_string(), Value::String(description));
                            }
                            if let Some(parameters) = normalize_tool_parameters(
                                child_name.as_str(),
                                read_tool_schema_source(child_function, child_row),
                            ) {
                                child_out.insert("parameters".to_string(), parameters);
                            }
                            if let Some(strict) = read_bool(
                                child_function
                                    .and_then(|v| v.get("strict"))
                                    .or_else(|| child_row.get("strict")),
                            ) {
                                child_out.insert("strict".to_string(), Value::Bool(strict));
                            }
                            if read_bool(
                                child_function
                                    .and_then(|v| v.get("defer_loading"))
                                    .or_else(|| child_function.and_then(|v| v.get("deferLoading")))
                                    .or_else(|| child_row.get("defer_loading"))
                                    .or_else(|| child_row.get("deferLoading")),
                            )
                            .unwrap_or(false)
                            {
                                child_out.insert("defer_loading".to_string(), Value::Bool(true));
                            }
                            Some(Value::Object(child_out))
                        })
                        .collect::<Vec<Value>>()
                })
                .unwrap_or_default();
            if let Some(namespace_name) = namespace_name {
                if !child_tools.is_empty() {
                    let mut namespace_out = Map::new();
                    namespace_out
                        .insert("type".to_string(), Value::String("namespace".to_string()));
                    namespace_out.insert("name".to_string(), Value::String(namespace_name));
                    if let Some(description) = read_trimmed_string(tool_row.get("description")) {
                        namespace_out.insert("description".to_string(), Value::String(description));
                    }
                    namespace_out.insert("tools".to_string(), Value::Array(child_tools));
                    mapped.push(Value::Object(namespace_out));
                }
            }
            continue;
        }
        let mut name = read_trimmed_string(function_row.and_then(|v| v.get("name")))
            .or_else(|| read_trimmed_string(tool_row.get("name")));
        if is_bare_client_mcp_bridge_tool(tool_row, name.as_deref()) {
            continue;
        }
        if name.is_none() {
            let lowered_type = raw_type.trim().to_ascii_lowercase();
            if lowered_type == "web_search" || lowered_type.starts_with("web_search") {
                name = Some("web_search".to_string());
            }
        }
        let Some(name_value) = name else {
            continue;
        };

        let normalized_type = if raw_type.trim().eq_ignore_ascii_case("custom") {
            "function".to_string()
        } else {
            raw_type.trim().to_string()
        };

        let mut function_out = Map::new();
        function_out.insert("name".to_string(), Value::String(name_value.clone()));
        if let Some(description) = read_trimmed_string(
            function_row
                .and_then(|v| v.get("description"))
                .or_else(|| tool_row.get("description")),
        ) {
            function_out.insert("description".to_string(), Value::String(description));
        }
        if let Some(parameters) = normalize_tool_parameters(
            name_value.as_str(),
            read_tool_schema_source(function_row, tool_row),
        ) {
            function_out.insert("parameters".to_string(), parameters);
        }
        if let Some(strict) = read_bool(
            function_row
                .and_then(|v| v.get("strict"))
                .or_else(|| tool_row.get("strict")),
        ) {
            function_out.insert("strict".to_string(), Value::Bool(strict));
        }

        let mut mapped_row = Map::new();
        mapped_row.insert("type".to_string(), Value::String(normalized_type));
        mapped_row.insert("function".to_string(), Value::Object(function_out));
        mapped.push(Value::Object(mapped_row));
    }

    mapped
}

fn is_bare_client_mcp_bridge_tool(tool_row: &Map<String, Value>, name: Option<&str>) -> bool {
    let normalized = name.unwrap_or("").trim().to_ascii_lowercase();
    if !normalized.starts_with("mcp__") {
        return false;
    }
    if normalized.matches("__").count() >= 2 {
        return false;
    }
    tool_row
        .get("tools")
        .and_then(Value::as_array)
        .map(|tools| !tools.is_empty())
        .unwrap_or(false)
}

fn is_allowed_responses_history_tool_name(
    lowered_name: &str,
    allowed_tool_names: &std::collections::HashSet<String>,
) -> bool {
    if allowed_tool_names.is_empty() {
        return true;
    }
    if allowed_tool_names.contains(lowered_name) {
        return true;
    }
    matches!(lowered_name, "reasoningstop")
}

pub(crate) fn normalize_responses_input_items(
    raw_request: &Map<String, Value>,
) -> Option<Vec<Value>> {
    let input = raw_request.get("input")?;
    match input {
        Value::Array(items) => {
            if items.is_empty() {
                return None;
            }
            let mut pre_normalized_payload = Value::Object(Map::new());
            if let Some(payload_obj) = pre_normalized_payload.as_object_mut() {
                payload_obj.insert(
                    "input".to_string(),
                    Value::Array(normalize_message_shape_responses_items(items)),
                );
                if let Some(tools) = raw_request.get("tools").cloned() {
                    payload_obj.insert("tools".to_string(), tools);
                }
            }
            if normalize_shell_like_tool_calls_before_governance(&mut pre_normalized_payload)
                .is_err()
            {
                return None;
            }
            let normalized_items = pre_normalized_payload
                .get("input")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            if normalized_items.is_empty() {
                return None;
            }
            let has_previous_response_id =
                read_trimmed_string(raw_request.get("previous_response_id")).is_some();
            let allow_output_only_resume = has_previous_response_id
                && normalized_items.iter().all(|entry| {
                    let Some(row) = entry.as_object() else {
                        return true;
                    };
                    let ty = read_trimmed_string(row.get("type"))
                        .unwrap_or_default()
                        .to_ascii_lowercase();
                    matches!(
                        ty.as_str(),
                        "function_call_output"
                            | "custom_tool_call_output"
                            | "tool_result"
                            | "tool_message"
                    )
                });
            let allowed_tool_names = raw_request
                .get("tools")
                .and_then(Value::as_array)
                .map(|tools| {
                    tools
                        .iter()
                        .filter_map(|tool| {
                            let row = tool.as_object()?;
                            read_trimmed_string(
                                row.get("function")
                                    .and_then(Value::as_object)
                                    .and_then(|function| function.get("name"))
                                    .or_else(|| row.get("name")),
                            )
                            .map(|value| value.to_ascii_lowercase())
                        })
                        .collect::<std::collections::HashSet<String>>()
                })
                .unwrap_or_default();
            let call_id_rewrites = build_duplicate_responses_call_id_rewrites(
                normalized_items.as_slice(),
                &allowed_tool_names,
            );

            let mut normalized: Vec<Value> = Vec::with_capacity(items.len());
            let mut valid_call_ids = std::collections::HashSet::new();
            let mut tool_name_by_call_id = std::collections::HashMap::<String, String>::new();
            let mut saw_function_calls = false;
            let mut seen_function_call_signatures = std::collections::HashSet::<String>::new();
            let mut deduped_identical_function_call_ids =
                std::collections::HashSet::<String>::new();
            let mut completed_tool_output_signatures =
                std::collections::HashMap::<String, std::collections::HashSet<String>>::new();
            let mut latest_tool_output_index_by_call_id =
                std::collections::HashMap::<String, usize>::new();

            for (index, entry) in normalized_items.iter().enumerate() {
                let Some(row) = entry.as_object() else {
                    continue;
                };
                let ty = read_trimmed_string(row.get("type"))
                    .unwrap_or_default()
                    .to_ascii_lowercase();

                if !matches!(
                    ty.as_str(),
                    "function_call" | "custom_tool_call" | "tool_call"
                ) {
                    continue;
                }

                saw_function_calls = true;
                let name = read_trimmed_string(row.get("name"))
                    .map(|value| value.trim().to_string())
                    .filter(|value| !value.is_empty());
                let Some(name) = name else {
                    continue;
                };
                let lowered_name = name.to_ascii_lowercase();
                let name_allowed = is_allowed_responses_history_tool_name(
                    lowered_name.as_str(),
                    &allowed_tool_names,
                );
                if name.len() > 128 || !name_allowed {
                    continue;
                }

                let call_id = read_trimmed_string(row.get("call_id"))
                    .or_else(|| read_trimmed_string(row.get("tool_call_id")))
                    .or_else(|| read_trimmed_string(row.get("id")));
                let effective_call_id = call_id_rewrites.get(&index).cloned().or(call_id);
                if let Some(value) = effective_call_id {
                    tool_name_by_call_id.insert(value.clone(), lowered_name);
                    valid_call_ids.insert(value);
                }
            }

            for (index, entry) in normalized_items.iter().enumerate() {
                let Some(row) = entry.as_object() else {
                    normalized.push(entry.clone());
                    continue;
                };
                let ty = read_trimmed_string(row.get("type"))
                    .unwrap_or_default()
                    .to_ascii_lowercase();

                if matches!(
                    ty.as_str(),
                    "function_call" | "custom_tool_call" | "tool_call"
                ) {
                    let name = read_trimmed_string(row.get("name"))
                        .map(|value| value.trim().to_string())
                        .filter(|value| !value.is_empty());
                    let Some(name) = name else {
                        continue;
                    };
                    let lowered_name = name.to_ascii_lowercase();
                    let name_allowed = is_allowed_responses_history_tool_name(
                        lowered_name.as_str(),
                        &allowed_tool_names,
                    );
                    if name.len() > 128 || !name_allowed {
                        continue;
                    }

                    let call_id = read_trimmed_string(row.get("call_id"))
                        .or_else(|| read_trimmed_string(row.get("tool_call_id")))
                        .or_else(|| read_trimmed_string(row.get("id")));
                    let effective_call_id = call_id_rewrites.get(&index).cloned().or(call_id);
                    if let Some(value) = effective_call_id {
                        let semantic_signature = build_function_call_semantic_signature(row)
                            .map(|signature| format!("{value}\n{signature}"))
                            .unwrap_or_else(|| value.clone());
                        if seen_function_call_signatures.contains(semantic_signature.as_str()) {
                            deduped_identical_function_call_ids.insert(value);
                            continue;
                        }
                        seen_function_call_signatures.insert(semantic_signature);
                        valid_call_ids.insert(value);
                    }
                    normalized.push(Value::Object(
                        strip_provider_tool_sentinel_residue_from_row(
                            rewrite_responses_tool_history_entry_call_id(
                                index,
                                row,
                                &call_id_rewrites,
                            ),
                        ),
                    ));
                    continue;
                }

                if matches!(
                    ty.as_str(),
                    "function_call_output"
                        | "custom_tool_call_output"
                        | "tool_result"
                        | "tool_message"
                ) {
                    let call_id = read_trimmed_string(row.get("call_id"))
                        .or_else(|| read_trimmed_string(row.get("tool_call_id")))
                        .or_else(|| read_trimmed_string(row.get("tool_use_id")))
                        .or_else(|| read_trimmed_string(row.get("id")));
                    let effective_call_id = call_id_rewrites.get(&index).cloned().or(call_id);
                    let Some(call_id) = effective_call_id else {
                        continue;
                    };
                    if saw_function_calls && !valid_call_ids.contains(call_id.as_str()) {
                        continue;
                    }
                    let mut rewritten_row =
                        rewrite_responses_tool_history_entry_call_id(index, row, &call_id_rewrites);
                    let compare_tool_name = tool_name_by_call_id
                        .get(call_id.as_str())
                        .map(String::as_str);
                    if let Some(output_value) = rewritten_row.get("output").and_then(Value::as_str)
                    {
                        rewritten_row.insert(
                            "output".to_string(),
                            Value::String(normalize_tool_output_text_for_storage(
                                compare_tool_name,
                                output_value,
                            )),
                        );
                    }
                    let compare_output = rewritten_row
                        .get("output")
                        .and_then(Value::as_str)
                        .map(|text| {
                            canonicalize_tool_output_text_for_compare(compare_tool_name, text)
                        })
                        .unwrap_or_default();
                    let payload_signature = format!("{call_id}\n{compare_output}");
                    let seen_signatures = completed_tool_output_signatures
                        .entry(call_id.clone())
                        .or_default();
                    if seen_signatures.contains(payload_signature.as_str()) {
                        continue;
                    }
                    seen_signatures.insert(payload_signature);
                    let normalized_output =
                        Value::Object(strip_provider_tool_sentinel_residue_from_row(rewritten_row));
                    if deduped_identical_function_call_ids.contains(call_id.as_str()) {
                        if let Some(existing_index) = latest_tool_output_index_by_call_id
                            .get(call_id.as_str())
                            .copied()
                        {
                            normalized[existing_index] = normalized_output;
                        } else {
                            latest_tool_output_index_by_call_id
                                .insert(call_id.clone(), normalized.len());
                            normalized.push(normalized_output);
                        }
                        continue;
                    }
                    latest_tool_output_index_by_call_id
                        .entry(call_id)
                        .or_insert(normalized.len());
                    normalized.push(normalized_output);
                    continue;
                }

                normalized.push(strip_provider_tool_sentinel_residue_from_value(
                    entry.clone(),
                ));
            }

            if !saw_function_calls && !allow_output_only_resume {
                normalized.retain(|entry| {
                    let Some(row) = entry.as_object() else {
                        return true;
                    };
                    let ty = read_trimmed_string(row.get("type"))
                        .unwrap_or_default()
                        .to_ascii_lowercase();
                    !matches!(
                        ty.as_str(),
                        "function_call_output"
                            | "custom_tool_call_output"
                            | "tool_result"
                            | "tool_message"
                    )
                });
            }

            Some(filter_orphan_responses_tool_outputs(normalized))
        }
        Value::String(text) => {
            if text.trim().is_empty() {
                return None;
            }
            let mut text_part = Map::new();
            text_part.insert("type".to_string(), Value::String("input_text".to_string()));
            text_part.insert("text".to_string(), Value::String(text.clone()));

            let mut message = Map::new();
            message.insert("type".to_string(), Value::String("message".to_string()));
            message.insert("role".to_string(), Value::String("user".to_string()));
            message.insert(
                "content".to_string(),
                Value::Array(vec![Value::Object(text_part)]),
            );
            Some(vec![Value::Object(message)])
        }
        Value::Object(item) => Some(vec![Value::Object(item.clone())]),
        _ => None,
    }
}

fn has_responses_input_chat_messages(input: &[Value]) -> bool {
    for entry in input {
        let Some(row) = entry.as_object() else {
            continue;
        };
        let ty = read_trimmed_string(row.get("type"))
            .unwrap_or_default()
            .to_ascii_lowercase();
        if ty.is_empty() {
            if row.contains_key("role") || row.contains_key("content") {
                return true;
            }
            continue;
        }
        if matches!(
            ty.as_str(),
            "message"
                | "input_text"
                | "input_image"
                | "function_call_output"
                | "custom_tool_call_output"
                | "tool_result"
                | "tool_message"
                | "output_text"
                | "text"
        ) {
            return true;
        }
    }

    false
}

fn has_responses_submit_tool_outputs(raw_request_row: &Map<String, Value>) -> bool {
    let has_previous_response_id =
        read_trimmed_string(raw_request_row.get("previous_response_id")).is_some();
    let has_tool_outputs = raw_request_row
        .get("tool_outputs")
        .and_then(Value::as_array)
        .map(|items| !items.is_empty())
        .unwrap_or(false);
    has_previous_response_id && has_tool_outputs
}

pub fn capture_req_inbound_responses_context_snapshot(
    input: ResponsesContextCaptureInput,
) -> Result<Value, String> {
    let mut normalized_request = input.raw_request.clone();
    normalize_shell_like_tool_calls_before_governance(&mut normalized_request)
        .map_err(|error| error.to_string())?;
    let raw_request_row = normalized_request
        .as_object()
        .cloned()
        .ok_or_else(|| "Responses payload must be an object".to_string())?;
    let has_messages = raw_request_row
        .get("messages")
        .and_then(|v| v.as_array())
        .map(|v| !v.is_empty())
        .unwrap_or(false);
    let normalized_input = normalize_responses_input_items(&raw_request_row);
    let has_input_chat_messages = normalized_input
        .as_deref()
        .map(has_responses_input_chat_messages)
        .unwrap_or(false);
    let is_submit_tool_outputs_resume = has_responses_submit_tool_outputs(&raw_request_row);
    if !has_messages && !has_input_chat_messages && !is_submit_tool_outputs_resume {
        return Err("Responses payload produced no chat messages".to_string());
    }

    let mut context = Map::new();
    if let Some(request_id) = normalize_non_empty(input.request_id) {
        context.insert("requestId".to_string(), Value::String(request_id));
    }

    let raw_tools = raw_request_row
        .get("tools")
        .and_then(|v| v.as_array())
        .cloned();
    if let Some(input_array) = normalized_input {
        let (normalized_messages, normalized_tools) = normalize_captured_responses_context(
            input_array.clone(),
            raw_tools.clone(),
            is_submit_tool_outputs_resume,
        )?;
        context.insert("input".to_string(), Value::Array(input_array));
        context.insert(
            "chatMessages".to_string(),
            Value::Array(normalized_messages),
        );
        if let Some(tools) = normalized_tools.filter(|tools| !tools.is_empty()) {
            context.insert("toolsNormalized".to_string(), Value::Array(tools));
        }
    }
    if let Some(metadata) = raw_request_row.get("metadata").and_then(|v| v.as_object()) {
        context.insert("metadata".to_string(), Value::Object(metadata.clone()));
    }
    let is_chat_payload = raw_request_row
        .get("messages")
        .and_then(|v| v.as_array())
        .is_some();
    context.insert("isChatPayload".to_string(), Value::Bool(is_chat_payload));

    let has_input = raw_request_row
        .get("input")
        .and_then(|v| v.as_array())
        .is_some();
    context.insert(
        "isResponsesPayload".to_string(),
        Value::Bool(!is_chat_payload && has_input),
    );

    let mut parameters = raw_request_row
        .get("parameters")
        .and_then(|v| v.as_object())
        .cloned()
        .unwrap_or_default();
    let top_level_parameter_keys = [
        "temperature",
        "top_p",
        "max_tokens",
        "max_output_tokens",
        "seed",
        "logit_bias",
        "user",
        "parallel_tool_calls",
        "tool_choice",
        "response_format",
        "service_tier",
        "truncation",
        "include",
        "store",
        "prompt_cache_key",
        "reasoning",
    ];
    for key in top_level_parameter_keys {
        if parameters.contains_key(key) {
            continue;
        }
        if let Some(value) = raw_request_row.get(key) {
            parameters.insert(key.to_string(), value.clone());
        }
    }
    if !parameters.is_empty() {
        context.insert("parameters".to_string(), Value::Object(parameters));
    }

    if let Some(instructions) = read_trimmed_string(raw_request_row.get("instructions")) {
        context.insert("systemInstruction".to_string(), Value::String(instructions));
    }

    if let Some(tools_raw) = raw_tools.as_ref() {
        let mut tools_raw_value = Value::Array(tools_raw.clone());
        filter_namespace_mcp_aggregator_tool_definitions(&mut tools_raw_value);
        let filtered_tools_raw = tools_raw_value.as_array().cloned().unwrap_or_default();
        context.insert(
            "toolsRaw".to_string(),
            Value::Array(filtered_tools_raw.clone()),
        );
        if !context.contains_key("toolsNormalized") {
            let normalized = map_bridge_tools_to_chat(filtered_tools_raw.as_slice());
            if !normalized.is_empty() {
                context.insert("toolsNormalized".to_string(), Value::Array(normalized));
            }
        }
    }

    let style_value = input.tool_call_id_style.as_ref().unwrap_or(&Value::Null);
    if let Some(style) = normalize_tool_call_id_style_candidate(style_value) {
        context.insert("toolCallIdStyle".to_string(), Value::String(style.clone()));
        let metadata_value = context
            .entry("metadata".to_string())
            .or_insert_with(|| Value::Object(Map::new()));
        if !metadata_value.is_object() {
            *metadata_value = Value::Object(Map::new());
        }
        if let Some(metadata_row) = metadata_value.as_object_mut() {
            metadata_row.insert("toolCallIdStyle".to_string(), Value::String(style));
        }
    }

    let captured = collect_tool_outputs(&input.raw_request);
    if !captured.is_empty() {
        let serialized =
            serde_json::to_value(captured).unwrap_or_else(|_| Value::Array(Vec::new()));
        context.insert("__captured_tool_results".to_string(), serialized);
    }

    Ok(Value::Object(context))
}

fn sanitize_format_envelope(candidate: &Value) -> Option<Value> {
    let mut row = candidate.as_object()?.clone();

    if row
        .get("metadata")
        .map(|value| !matches!(value, Value::Object(_)))
        .unwrap_or(false)
    {
        row.remove("metadata");
    }
    if row
        .get("messages")
        .map(|value| !matches!(value, Value::Array(_)))
        .unwrap_or(false)
    {
        row.remove("messages");
    }
    if row
        .get("tool_outputs")
        .map(|value| !matches!(value, Value::Array(_)))
        .unwrap_or(false)
    {
        row.remove("tool_outputs");
    }

    Some(Value::Object(row))
}

fn pick_boolean(value: Option<&Value>) -> Option<bool> {
    match value {
        Some(Value::Bool(v)) => Some(*v),
        Some(Value::String(raw)) => {
            let normalized = raw.trim().to_ascii_lowercase();
            if normalized == "true" {
                return Some(true);
            }
            if normalized == "false" {
                return Some(false);
            }
            None
        }
        _ => None,
    }
}

pub(crate) fn resolve_client_inject_ready(metadata: &Value) -> bool {
    let row = match metadata.as_object() {
        Some(v) => v,
        None => return true,
    };
    pick_boolean(row.get("clientInjectReady"))
        .or_else(|| pick_boolean(row.get("client_inject_ready")))
        .unwrap_or(true)
}

fn normalize_provider_protocol_token(value: Option<String>) -> Option<String> {
    let normalized = value.unwrap_or_default().trim().to_ascii_lowercase();
    if normalized.is_empty() {
        return None;
    }
    Some(normalized)
}

fn evaluate_responses_host_policy(input: ResponsesHostPolicyInput) -> ResponsesHostPolicyOutput {
    let direct = input.target_protocol.unwrap_or_default().trim().to_string();
    let from_context = input
        .context
        .as_ref()
        .and_then(Value::as_object)
        .and_then(|row| row.get("targetProtocol"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string();
    let protocol = if !direct.is_empty() {
        direct
    } else if !from_context.is_empty() {
        from_context
    } else {
        "responses".to_string()
    };
    let normalized = protocol.to_ascii_lowercase();
    let should_strip = normalized != "openai-responses" && normalized != "responses";
    ResponsesHostPolicyOutput {
        should_strip_host_managed_fields: should_strip,
        target_protocol: normalized,
    }
}

#[napi]
pub fn sanitize_format_envelope_json(candidate_json: String) -> NapiResult<String> {
    let candidate: Value = serde_json::from_str(&candidate_json)
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let output = sanitize_format_envelope(&candidate);
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi]
pub fn normalize_provider_protocol_token_json(value_json: String) -> NapiResult<String> {
    let value: Option<String> =
        serde_json::from_str(&value_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let output = normalize_provider_protocol_token(value);
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi]
pub fn evaluate_responses_host_policy_json(input_json: String) -> NapiResult<String> {
    let input: ResponsesHostPolicyInput =
        serde_json::from_str(&input_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let output = evaluate_responses_host_policy(input);
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi]
pub fn capture_req_inbound_responses_context_snapshot_json(
    input_json: String,
) -> NapiResult<String> {
    let input: ResponsesContextCaptureInput =
        serde_json::from_str(&input_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let output = capture_req_inbound_responses_context_snapshot(input)
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi]
pub fn map_bridge_tools_to_chat_json(raw_tools_json: String) -> NapiResult<String> {
    let raw_tools: Value = serde_json::from_str(&raw_tools_json)
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let tools = raw_tools.as_array().cloned().unwrap_or_default();
    let output = map_bridge_tools_to_chat(tools.as_slice());
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn normalize_responses_input_items_canonicalizes_overlong_function_calls() {
        let overlong = "clock___action___schedule___items_____dueat___2026-03-06t14_52_18_000z___task___verifyservicestarted___tool___exec_command___arguments___________thecommandencountereda_processrunningwithsessionid_message_indicatingitisstillrunning_letmewaitandcheckagain___tool_calls_section_begin____tool_call_begin__functions_clock";
        let raw_request = json!({
          "tools": [
            {
              "type": "function",
              "function": {
                "name": "exec_command",
                "parameters": { "type": "object", "properties": {} }
              }
            }
          ],
          "input": [
            {
              "type": "message",
              "role": "user",
              "content": [{ "type": "input_text", "text": "continue" }]
            },
            {
              "type": "function_call",
              "id": "fc_ok",
              "call_id": "fc_ok",
              "name": "exec_command",
              "arguments": "{\"cmd\":\"pwd\"}"
            },
            {
              "type": "function_call_output",
              "id": "out_ok",
              "call_id": "fc_ok",
              "output": "ok"
            },
            {
              "type": "function_call",
              "id": "fc_bad",
              "call_id": "fc_bad",
              "name": overlong,
              "arguments": "{\"action\":\"schedule\"}"
            },
            {
              "type": "function_call_output",
              "id": "out_bad",
              "call_id": "fc_bad",
              "output": format!("unsupported call: {}", overlong)
            }
          ]
        });

        let normalized = normalize_responses_input_items(raw_request.as_object().unwrap()).unwrap();
        let mut names: Vec<String> = Vec::new();
        for entry in &normalized {
            if let Some(row) = entry.as_object() {
                if let Some(name) = row.get("name").and_then(Value::as_str) {
                    names.push(name.to_string());
                }
            }
        }

        assert!(names.iter().all(|name| name.len() <= 128));
        assert!(names.iter().any(|name| name == "exec_command"));
        assert!(!names.iter().any(|name| name == overlong));
        assert!(!normalized.iter().any(|entry| {
            let Some(row) = entry.as_object() else {
                return false;
            };
            let ty = row.get("type").and_then(Value::as_str).unwrap_or("");
            let call_id = row.get("call_id").and_then(Value::as_str).unwrap_or("");
            ty == "function_call_output" && call_id == "fc_bad"
        }));
    }

    #[test]
    fn normalize_responses_input_items_preserves_output_only_resume_batches() {
        let raw_request = json!({
          "previous_response_id": "resp_prev",
          "input": [
            {
              "type": "function_call_output",
              "id": "out_resume",
              "call_id": "call_resume",
              "output": "command failed: exit 2"
            }
          ]
        });

        let normalized = normalize_responses_input_items(raw_request.as_object().unwrap())
            .expect("normalized input");
        assert_eq!(normalized.len(), 1);
        assert_eq!(normalized[0]["type"], "function_call_output");
        assert_eq!(normalized[0]["call_id"], "call_resume");
    }

    #[test]
    fn normalize_responses_input_items_drops_orphan_output_only_history() {
        let raw_request = json!({
          "input": [
            { "type": "message", "role": "user", "content": [{ "type": "input_text", "text": "next" }] },
            {
              "type": "function_call_output",
              "id": "out_orphan",
              "call_id": "call_1",
              "output": "stale output from prior polluted context"
            }
          ]
        });

        let normalized = normalize_responses_input_items(raw_request.as_object().unwrap())
            .expect("normalized input");
        assert_eq!(normalized.len(), 1);
        assert_eq!(normalized[0]["type"], "message");
    }

    #[test]
    fn normalize_responses_input_items_drops_orphan_output_mixed_with_resume_history() {
        let raw_request = json!({
          "previous_response_id": "resp_prev",
          "input": [
            { "type": "message", "role": "user", "content": [{ "type": "input_text", "text": "continue" }] },
            {
              "type": "function_call_output",
              "id": "out_stale",
              "call_id": "call_1",
              "output": "stale output from prior polluted context"
            }
          ]
        });

        let normalized = normalize_responses_input_items(raw_request.as_object().unwrap())
            .expect("normalized input");
        assert_eq!(normalized.len(), 1);
        assert_eq!(normalized[0]["type"], "message");
    }

    #[test]
    fn context_capture_normalizes_tool_history_and_namespace_mcp_tools() {
        let raw_request = serde_json::json!({
            "model": "gpt-5.5",
            "input": [
                {"type":"message","role":"user","content":[{"type":"input_text","text":"start"}]},
                {"type":"function_call","call_id":"call_a","name":"exec_command","arguments":"{\"cmd\":\"pwd\"}"},
                {"type":"function_call","call_id":"call_b","name":"exec_command","arguments":"{\"cmd\":\"ls\"}"},
                {"type":"function_call_output","call_id":"call_a","output":"cwd"},
                {"type":"function_call_output","call_id":"call_b","output":"files"}
            ],
            "tools": [
                {"name":"exec_command","description":"Runs command","input_schema":{"type":"object"}},
                {"name":"mcp__node_repl","description":"namespace aggregator","input_schema":{}}
            ]
        });
        let captured =
            capture_req_inbound_responses_context_snapshot(ResponsesContextCaptureInput {
                raw_request,
                request_id: Some("req_context_tool_history".to_string()),
                tool_call_id_style: None,
            })
            .unwrap();
        let input = captured["input"].as_array().unwrap();
        assert_eq!(input[1]["type"].as_str(), Some("function_call"));
        let chat_messages = captured["chatMessages"].as_array().unwrap();
        assert_eq!(chat_messages[0]["role"].as_str(), Some("user"));
        assert_eq!(chat_messages[1]["role"].as_str(), Some("assistant"));
        assert_eq!(chat_messages[1]["tool_calls"].as_array().unwrap().len(), 2);
        assert_eq!(chat_messages[2]["role"].as_str(), Some("tool"));
        assert_eq!(chat_messages[3]["role"].as_str(), Some("tool"));
        assert_eq!(captured["toolsRaw"].as_array().unwrap().len(), 1);
        assert_eq!(
            captured["toolsRaw"][0]["name"].as_str(),
            Some("exec_command")
        );
    }

    #[test]
    fn normalize_responses_input_items_keeps_outputs_when_call_appears_later_in_batch() {
        let raw_request = json!({
          "tools": [
            {
              "type": "function",
              "function": {
                "name": "exec_command",
                "parameters": { "type": "object", "properties": {} }
              }
            }
          ],
          "input": [
            {
              "type": "function_call_output",
              "id": "out_1",
              "call_id": "fc_late",
              "output": "stderr: permission denied"
            },
            {
              "type": "function_call",
              "id": "fc_late",
              "call_id": "fc_late",
              "name": "exec_command",
              "arguments": "{\"cmd\":\"pwd\"}"
            }
          ]
        });

        let normalized = normalize_responses_input_items(raw_request.as_object().unwrap())
            .expect("normalized input");
        assert_eq!(normalized.len(), 2);
        assert_eq!(normalized[0]["type"], "function_call_output");
        assert_eq!(normalized[0]["call_id"], "fc_late");
        assert_eq!(normalized[1]["type"], "function_call");
    }

    #[test]
    fn normalize_responses_input_items_dedupes_identical_duplicate_function_call_outputs() {
        let raw_request = json!({
          "tools": [
            {
              "type": "function",
              "function": {
                "name": "exec_command",
                "parameters": { "type": "object", "properties": {} }
              }
            }
          ],
          "input": [
            {
              "type": "function_call",
              "id": "fc_dup",
              "call_id": "fc_dup",
              "name": "exec_command",
              "arguments": "{\"cmd\":\"pwd\"}"
            },
            {
              "type": "function_call_output",
              "id": "out_dup_1",
              "call_id": "fc_dup",
              "output": "{\"stdout\":\"/tmp\"}"
            },
            {
              "type": "function_call_output",
              "id": "out_dup_1",
              "call_id": "fc_dup",
              "output": "{\"stdout\":\"/tmp\"}"
            }
          ]
        });

        let normalized = normalize_responses_input_items(raw_request.as_object().unwrap())
            .expect("normalized input");
        assert_eq!(normalized.len(), 2);
        assert_eq!(normalized[0]["type"], "function_call");
        assert_eq!(normalized[1]["type"], "function_call_output");
        assert_eq!(normalized[1]["call_id"], "fc_dup");
    }

    #[test]
    fn normalize_responses_input_items_dedupes_wrapper_only_duplicate_function_call_outputs() {
        let raw_request = json!({
          "tools": [
            {
              "type": "function",
              "function": {
                "name": "exec_command",
                "parameters": { "type": "object", "properties": {} }
              }
            }
          ],
          "input": [
            {
              "type": "function_call",
              "id": "fc_dup",
              "call_id": "fc_dup",
              "name": "exec_command",
              "arguments": "{\"cmd\":\"pwd\"}"
            },
            {
              "type": "function_call_output",
              "id": "out_dup_1",
              "call_id": "fc_dup",
              "output": "Chunk ID: abc\nWall time: 0.1s\nProcess exited with code 0\nOriginal token count: 10\nOutput:\n/tmp"
            },
            {
              "type": "function_call_output",
              "id": "out_dup_2",
              "call_id": "fc_dup",
              "output": "/tmp"
            }
          ]
        });

        let normalized = normalize_responses_input_items(raw_request.as_object().unwrap())
            .expect("normalized input");
        assert_eq!(normalized.len(), 2);
        assert_eq!(normalized[1]["type"], "function_call_output");
        assert_eq!(normalized[1]["output"], "/tmp");
    }

    #[test]
    fn normalize_responses_input_items_keeps_distinct_duplicate_function_call_outputs() {
        let raw_request = json!({
          "tools": [
            {
              "type": "function",
              "function": {
                "name": "exec_command",
                "parameters": { "type": "object", "properties": {} }
              }
            }
          ],
          "input": [
            {
              "type": "function_call",
              "id": "fc_dup",
              "call_id": "fc_dup",
              "name": "exec_command",
              "arguments": "{\"cmd\":\"pwd\"}"
            },
            {
              "type": "function_call_output",
              "id": "out_dup_1",
              "call_id": "fc_dup",
              "output": "{\"stdout\":\"/tmp\"}"
            },
            {
              "type": "function_call_output",
              "id": "out_dup_2",
              "call_id": "fc_dup",
              "output": "{\"stdout\":\"/var\"}"
            }
          ]
        });

        let normalized = normalize_responses_input_items(raw_request.as_object().unwrap())
            .expect("normalized input");
        assert_eq!(normalized.len(), 3);
        assert_eq!(normalized[1]["type"], "function_call_output");
        assert_eq!(normalized[2]["type"], "function_call_output");
        assert_eq!(normalized[2]["output"], "{\"stdout\":\"/var\"}");
    }

    #[test]
    fn normalize_responses_input_items_dedupes_identical_duplicate_function_calls() {
        let raw_request = json!({
          "tools": [
            {
              "type": "function",
              "function": {
                "name": "exec_command",
                "parameters": { "type": "object", "properties": {} }
              }
            }
          ],
          "input": [
            {
              "type": "function_call",
              "name": "exec_command",
              "arguments": "{\"cmd\":\"echo first\"}",
              "call_id": "call_dup"
            },
            {
              "type": "function_call",
              "name": "exec_command",
              "arguments": "{\"cmd\":\"echo first\"}",
              "call_id": "call_dup"
            },
            {
              "type": "function_call_output",
              "call_id": "call_dup",
              "output": "same"
            },
            {
              "type": "function_call_output",
              "call_id": "call_dup",
              "output": "same"
            }
          ]
        });

        let normalized = normalize_responses_input_items(raw_request.as_object().unwrap())
            .expect("normalized input");
        assert_eq!(normalized.len(), 2);
        assert_eq!(normalized[0]["call_id"], "call_dup");
        assert_eq!(normalized[1]["call_id"], "call_dup");
    }

    #[test]
    fn normalize_responses_input_items_collapses_distinct_outputs_when_identical_call_batch_repeats(
    ) {
        let raw_request = json!({
          "tools": [
            {
              "type": "function",
              "function": {
                "name": "write_stdin",
                "parameters": { "type": "object", "properties": {} }
              }
            }
          ],
          "input": [
            {
              "type": "function_call",
              "id": "call_dup",
              "call_id": "call_dup",
              "name": "write_stdin",
              "arguments": "{\"session_id\":1,\"chars\":\"\"}"
            },
            {
              "type": "function_call",
              "id": "call_dup",
              "call_id": "call_dup",
              "name": "write_stdin",
              "arguments": "{\"session_id\":1,\"chars\":\"\"}"
            },
            {
              "type": "function_call_output",
              "call_id": "call_dup",
              "output": "Chunk ID: abc\\nOutput:\\nfirst"
            },
            {
              "type": "function_call_output",
              "call_id": "call_dup",
              "output": "write_stdin failed: Unknown process id 1"
            }
          ]
        });

        let normalized = normalize_responses_input_items(raw_request.as_object().unwrap())
            .expect("normalized input");
        assert_eq!(normalized.len(), 2);
        assert_eq!(normalized[0]["type"], "function_call");
        assert_eq!(normalized[0]["call_id"], "call_dup");
        assert_eq!(normalized[1]["type"], "function_call_output");
        assert_eq!(normalized[1]["call_id"], "call_dup");
        assert_eq!(
            normalized[1]["output"],
            "write_stdin failed: Unknown process id 1"
        );
    }

    #[test]
    fn normalize_responses_input_items_rewrites_reused_call_ids_by_occurrence_order() {
        let raw_request = json!({
          "tools": [
            {
              "type": "function",
              "function": {
                "name": "exec_command",
                "parameters": { "type": "object", "properties": {} }
              }
            }
          ],
          "input": [
            {
              "type": "function_call",
              "name": "exec_command",
              "arguments": "{\"cmd\":\"echo first\"}",
              "call_id": "call_1"
            },
            {
              "type": "function_call",
              "name": "exec_command",
              "arguments": "{\"cmd\":\"echo second\"}",
              "call_id": "call_1"
            },
            {
              "type": "function_call_output",
              "call_id": "call_1",
              "output": "first output"
            },
            {
              "type": "function_call_output",
              "call_id": "call_1",
              "output": "second output"
            }
          ]
        });

        let normalized = normalize_responses_input_items(raw_request.as_object().unwrap())
            .expect("normalized input");
        assert_eq!(normalized.len(), 4);
        assert_eq!(normalized[0]["call_id"], "call_1");
        assert_eq!(normalized[0]["id"], "call_1");
        assert_eq!(normalized[1]["call_id"], "call_1__rcc_occurrence_2");
        assert_eq!(normalized[1]["id"], "call_1__rcc_occurrence_2");
        assert_eq!(normalized[2]["call_id"], "call_1");
        assert_eq!(normalized[2]["tool_call_id"], "call_1");
        assert_eq!(normalized[3]["call_id"], "call_1__rcc_occurrence_2");
        assert_eq!(normalized[3]["tool_call_id"], "call_1__rcc_occurrence_2");
    }

    #[test]
    fn normalize_responses_input_items_dedupes_repeated_apply_patch_error_statuses() {
        let raw_request = json!({
          "tools": [
            {
              "type": "function",
              "function": {
                "name": "apply_patch",
                "parameters": { "type": "object", "properties": {} }
              }
            }
          ],
          "input": [
            {
              "type": "function_call",
              "id": "call_patch_1",
              "call_id": "call_patch_1",
              "name": "apply_patch",
              "arguments": "*** Begin Patch\n*** Update File: src/main.ts\n@@\n-old\n+new\n*** End Patch"
            },
            {
              "type": "function_call_output",
              "call_id": "call_patch_1",
              "output": "apply_patch verification failed: invalid patch: The last line of the patch must be '*** End Patch'"
            },
            {
              "type": "function_call_output",
              "call_id": "call_patch_1",
              "output": "APPLY_PATCH_ERROR: apply_patch did not apply. Retry with apply_patch only. Send one raw patch string in canonical *** Begin Patch / *** End Patch grammar. Use workspace-relative paths inside patch headers."
            }
          ]
        });

        let normalized = normalize_responses_input_items(raw_request.as_object().unwrap())
            .expect("normalized input");
        assert_eq!(normalized.len(), 2);
        assert_eq!(normalized[1]["type"], "function_call_output");
        let output = normalized[1]["output"].as_str().expect("normalized output");
        assert!(output.starts_with("APPLY_PATCH_ERROR:"));
        assert!(output.contains("Retry with apply_patch only"));
        assert!(output.contains("workspace-relative"));
        assert!(output.contains("Do not switch to exec_command"));
        assert!(!output.contains("Failed to find expected lines"));
        assert!(!output.contains("verification failed"));
    }

    #[test]
    fn normalize_responses_input_items_preserves_non_tool_history_input_order() {
        let raw_request = json!({
          "input": [
            {
              "type": "message",
              "role": "user",
              "content": [
                { "type": "input_image", "image_url": "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB" },
                { "type": "input_text", "text": "读取 README.md 内容" }
              ]
            }
          ]
        });

        let normalized = normalize_responses_input_items(raw_request.as_object().unwrap()).unwrap();
        assert_eq!(
            normalized,
            raw_request
                .get("input")
                .and_then(Value::as_array)
                .cloned()
                .unwrap()
        );
    }

    #[test]
    fn normalize_responses_input_items_strips_provider_tool_sentinel_residue_from_history() {
        let raw_request = json!({
          "input": [
            {
              "type": "message",
              "role": "assistant",
              "content": [
                {"type": "output_text", "text": "ready]<]minimax[>[\n\n• minimax:tool_call (minimax:tool_call)\n\n</minimax:tool_call>"}
              ]
            },
            {
              "type": "function_call",
              "call_id": "call_1",
              "name": "exec_command",
              "arguments": "{\"cmd\":\"pwd]<]minimax[>[\"}"
            },
            {
              "type": "function_call_output",
              "call_id": "call_1",
              "output": "ok]<]minimax[>["
            }
          ]
        });

        let normalized = normalize_responses_input_items(raw_request.as_object().unwrap()).unwrap();
        let serialized = serde_json::to_string(&normalized).unwrap();
        assert!(!serialized.contains("]<]minimax[>["));
        assert!(!serialized.contains("minimax:tool_call"));
        assert!(!serialized.contains("</minimax:tool_call>"));
        assert_eq!(normalized[0]["content"][0]["text"], "ready");
        assert_eq!(normalized[1]["arguments"], "{\"cmd\":\"pwd\"}");
        assert_eq!(normalized[2]["output"], "ok");
    }

    #[test]
    fn map_bridge_tools_to_chat_preserves_namespace_tools() {
        let raw_tools = vec![json!({
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
        })];

        let mapped = map_bridge_tools_to_chat(raw_tools.as_slice());
        assert_eq!(mapped.len(), 1);
        assert_eq!(mapped[0]["type"], "namespace");
        assert_eq!(mapped[0]["name"], "mcp__computer_use");
        assert_eq!(mapped[0]["tools"][0]["name"], "get_app_state");
        assert_eq!(mapped[0]["tools"][0]["defer_loading"], Value::Bool(true));
    }

    #[test]
    fn map_bridge_tools_to_chat_drops_bare_client_mcp_bridge_tools() {
        let raw_tools = vec![json!({
          "type": "function",
          "name": "mcp__node_repl",
          "description": "client MCP tool",
          "tools": [{ "name": "js" }]
        })];

        let mapped = map_bridge_tools_to_chat(raw_tools.as_slice());
        assert!(mapped.is_empty());
    }

    #[test]
    fn map_bridge_tools_to_chat_preserves_concrete_mcp_function_tools() {
        let raw_tools = vec![json!({
          "type": "function",
          "name": "mcp__computer_use__get_app_state",
          "description": "Inspect app state",
          "parameters": { "type": "object", "properties": {} }
        })];

        let mapped = map_bridge_tools_to_chat(raw_tools.as_slice());
        assert_eq!(mapped.len(), 1);
        assert_eq!(
            mapped[0]["function"]["name"],
            "mcp__computer_use__get_app_state"
        );
    }

    #[test]
    fn map_bridge_tools_to_chat_preserves_top_level_input_schema_as_parameters() {
        let raw_tools = vec![json!({
          "type": "function",
          "name": "read_file",
          "description": "Read file",
          "input_schema": {
            "type": "object",
            "properties": {
              "path": { "type": "string" }
            },
            "required": ["path"]
          }
        })];

        let mapped = map_bridge_tools_to_chat(raw_tools.as_slice());
        assert_eq!(mapped.len(), 1);
        let parameters = &mapped[0]["function"]["parameters"];
        assert_eq!(parameters["properties"]["path"]["type"], "string");
        assert_eq!(parameters["required"], json!(["path"]));
    }

    #[test]
    fn map_bridge_tools_to_chat_does_not_own_apply_patch_schema_contract() {
        let raw_tools = vec![json!({
          "description": "Use the `apply_patch` tool to edit files.",
          "name": "apply_patch",
          "parameters": { "type": "object", "properties": {} }
        })];

        let mapped = map_bridge_tools_to_chat(raw_tools.as_slice());
        assert_eq!(mapped.len(), 1);
        let function = mapped[0]["function"].as_object().unwrap();
        let description = function
            .get("description")
            .and_then(Value::as_str)
            .unwrap_or("");
        assert_eq!(description, "Use the `apply_patch` tool to edit files.");
        let parameters = function
            .get("parameters")
            .and_then(Value::as_object)
            .unwrap();
        let properties = parameters
            .get("properties")
            .and_then(Value::as_object)
            .unwrap();
        assert!(!properties.contains_key("patch"));
        assert!(!properties.contains_key("input"));
        assert!(!properties.contains_key("filePath"));
        assert!(!properties.contains_key("file_path"));
    }

    #[test]
    fn capture_responses_context_allows_submit_tool_outputs_without_chat_messages() {
        let input = ResponsesContextCaptureInput {
            raw_request: json!({
                "model": "gpt-5.4",
                "previous_response_id": "resp_prev_1",
                "tool_outputs": [
                    {
                        "tool_call_id": "call_apply_patch_1",
                        "output": "Patch applied successfully"
                    }
                ],
                "stream": false
            }),
            request_id: Some("req_submit_outputs_1".to_string()),
            tool_call_id_style: None,
        };

        let captured = capture_req_inbound_responses_context_snapshot(input)
            .expect("submit tool outputs capture");
        let row = captured.as_object().expect("captured object");

        assert_eq!(
            row.get("requestId"),
            Some(&Value::String("req_submit_outputs_1".to_string()))
        );
        assert_eq!(
            row.get("__captured_tool_results")
                .and_then(Value::as_array)
                .map(|items| items.len()),
            Some(1)
        );
        assert_eq!(row.get("isResponsesPayload"), Some(&Value::Bool(false)));
        assert_eq!(row.get("isChatPayload"), Some(&Value::Bool(false)));
    }

    #[test]
    fn capture_responses_context_restores_stopless_cli_pair_into_reasoning_stop_and_guidance() {
        let input = ResponsesContextCaptureInput {
            raw_request: json!({
                "model": "gpt-5.5",
                "previous_response_id": "resp_prev_stopless_1",
                "input": [
                    {
                        "type": "message",
                        "role": "user",
                        "content": [
                            { "type": "input_text", "text": "继续执行 stopless 在线验证" }
                        ]
                    },
                    {
                        "type": "function_call",
                        "call_id": "call_stopless_cli_1",
                        "name": "exec_command",
                        "arguments": "{\"cmd\":\"routecodex hook run reasoningStop --input-json '{}'\"}"
                    },
                    {
                        "type": "function_call_output",
                        "call_id": "call_stopless_cli_1",
                        "output": "{\"ok\":true,\"toolName\":\"stop_message_auto\",\"flowId\":\"stop_message_flow\",\"summary\":\"stopless continuation ready\",\"repeatCount\":2,\"maxRepeats\":3,\"continuationPrompt\":\"继续往下做；如果能收尾就直接说做完。\",\"schemaFeedback\":{\"reasonCode\":\"stop_schema_missing\",\"missingFields\":[\"stopreason\",\"reason\",\"next_step\"]},\"schemaGuidance\":{\"requiredFields\":[\"stopreason\",\"reason\",\"next_step\"],\"stopreasonValues\":{\"finished\":0,\"blocked\":1,\"continueNeeded\":2},\"triggerHint\":\"no_schema\"},\"input\":{\"flowId\":\"stop_message_flow\",\"repeatCount\":2,\"maxRepeats\":3,\"triggerHint\":\"no_schema\"}}"
                    }
                ],
                "tools": [
                    {
                        "type": "function",
                        "name": "exec_command",
                        "parameters": { "type": "object", "properties": {} }
                    }
                ]
            }),
            request_id: Some("req_stopless_context_restore".to_string()),
            tool_call_id_style: None,
        };

        let captured = capture_req_inbound_responses_context_snapshot(input)
            .expect("stopless context capture");
        let input_items = captured["input"].as_array().expect("captured input");
        assert_eq!(input_items.len(), 4);
        assert_eq!(input_items[1]["type"], json!("function_call"));
        assert_eq!(input_items[1]["name"], json!("reasoningStop"));
        assert_eq!(input_items[2]["type"], json!("function_call_output"));
        assert!(!input_items[2]["output"]
            .as_str()
            .unwrap_or_default()
            .contains("stop_message_auto"));
        assert_eq!(input_items[3]["role"], json!("user"));
        let guidance = input_items[3]["content"][0]["text"]
            .as_str()
            .expect("guidance text");
        assert!(guidance.contains("上一轮执行结果：repeatCount=2/3"));
        assert!(guidance.contains("stopreason 取值：0=finished，1=blocked，2=continue_needed"));
        assert!(guidance.contains("继续往下做；如果能收尾就直接说做完。"));
    }
}
