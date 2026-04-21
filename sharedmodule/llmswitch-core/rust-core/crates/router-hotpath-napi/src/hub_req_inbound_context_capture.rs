use crate::hub_req_inbound_tool_output_snapshot::collect_tool_outputs;
use napi::bindgen_prelude::Result as NapiResult;
use napi_derive::napi;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct FollowupSnapshotOutput {
    provider_protocol: String,
    #[serde(rename = "tool_outputs")]
    tool_outputs: Vec<Value>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ResponsesContextCaptureInput {
    raw_request: Value,
    request_id: Option<String>,
    tool_call_id_style: Option<Value>,
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

fn is_servertool_followup(adapter_context: &Value) -> bool {
    let rt = adapter_context
        .as_object()
        .and_then(|obj| obj.get("__rt"))
        .and_then(|v| v.as_object());
    let flag = rt.and_then(|row| row.get("serverToolFollowup"));
    match flag {
        Some(Value::Bool(true)) => true,
        Some(Value::String(v)) if v.trim().eq_ignore_ascii_case("true") => true,
        _ => false,
    }
}

fn resolve_server_tool_followup_snapshot(
    adapter_context: &Value,
) -> Option<FollowupSnapshotOutput> {
    if !is_servertool_followup(adapter_context) {
        return None;
    }
    let provider_protocol = adapter_context
        .as_object()
        .and_then(|obj| obj.get("providerProtocol"))
        .and_then(|v| v.as_str())
        .unwrap_or("unknown")
        .to_string();
    Some(FollowupSnapshotOutput {
        provider_protocol,
        tool_outputs: Vec::new(),
    })
}

fn augment_context_snapshot(context: &Value, fallback: &Value) -> Value {
    let mut context_obj: Map<String, Value> = context.as_object().cloned().unwrap_or_default();

    let fallback_outputs = fallback
        .as_object()
        .and_then(|obj| obj.get("tool_outputs"))
        .and_then(|v| v.as_array())
        .cloned();

    if fallback_outputs.is_none() {
        return Value::Object(context_obj);
    }

    let context_has_array = context_obj
        .get("tool_outputs")
        .and_then(|v| v.as_array())
        .is_some();
    if context_has_array {
        return Value::Object(context_obj);
    }

    context_obj.insert(
        "tool_outputs".to_string(),
        Value::Array(fallback_outputs.unwrap_or_default()),
    );
    Value::Object(context_obj)
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

fn read_bool(value: Option<&Value>) -> Option<bool> {
    match value {
        Some(Value::Bool(v)) => Some(*v),
        _ => None,
    }
}

fn normalize_tool_parameters(value: Option<&Value>) -> Option<Value> {
    match value {
        Some(Value::Object(v)) => Some(Value::Object(v.clone())),
        _ => None,
    }
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
            "function_call" | "tool_call" | "function_call_output" | "tool_result" | "tool_message"
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
        if ty != "function_call" && ty != "tool_call" {
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
                "function_call_output" | "tool_result" | "tool_message"
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

pub(crate) fn map_bridge_tools_to_chat(raw_tools: &[Value]) -> Vec<Value> {
    let mut mapped: Vec<Value> = Vec::new();

    for entry in raw_tools {
        let Some(tool_row) = entry.as_object() else {
            continue;
        };
        let function_row = tool_row.get("function").and_then(|v| v.as_object());
        let raw_type =
            read_trimmed_string(tool_row.get("type")).unwrap_or_else(|| "function".to_string());
        let mut name = read_trimmed_string(function_row.and_then(|v| v.get("name")))
            .or_else(|| read_trimmed_string(tool_row.get("name")));
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
        function_out.insert("name".to_string(), Value::String(name_value));
        if let Some(description) = read_trimmed_string(
            function_row
                .and_then(|v| v.get("description"))
                .or_else(|| tool_row.get("description")),
        ) {
            function_out.insert("description".to_string(), Value::String(description));
        }
        if let Some(parameters) = normalize_tool_parameters(
            function_row
                .and_then(|v| v.get("parameters"))
                .or_else(|| tool_row.get("parameters")),
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

fn normalize_responses_input_items(raw_request: &Map<String, Value>) -> Option<Vec<Value>> {
    let input = raw_request.get("input")?;
    match input {
        Value::Array(items) => {
            if items.is_empty() {
                return None;
            }
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

            let mut normalized: Vec<Value> = Vec::with_capacity(items.len());
            let mut valid_call_ids = std::collections::HashSet::new();
            let mut saw_function_calls = false;

            for entry in items {
                let Some(row) = entry.as_object() else {
                    continue;
                };
                let ty = read_trimmed_string(row.get("type"))
                    .unwrap_or_default()
                    .to_ascii_lowercase();

                if !matches!(ty.as_str(), "function_call" | "tool_call") {
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
                let name_allowed = allowed_tool_names.is_empty()
                    || allowed_tool_names.contains(lowered_name.as_str());
                if name.len() > 128 || !name_allowed {
                    continue;
                }

                let call_id = read_trimmed_string(row.get("call_id"))
                    .or_else(|| read_trimmed_string(row.get("tool_call_id")))
                    .or_else(|| read_trimmed_string(row.get("id")));
                if let Some(value) = call_id {
                    valid_call_ids.insert(value);
                }
            }

            for entry in items {
                let Some(row) = entry.as_object() else {
                    normalized.push(entry.clone());
                    continue;
                };
                let ty = read_trimmed_string(row.get("type"))
                    .unwrap_or_default()
                    .to_ascii_lowercase();

                if matches!(ty.as_str(), "function_call" | "tool_call") {
                    let name = read_trimmed_string(row.get("name"))
                        .map(|value| value.trim().to_string())
                        .filter(|value| !value.is_empty());
                    let Some(name) = name else {
                        continue;
                    };
                    let lowered_name = name.to_ascii_lowercase();
                    let name_allowed = allowed_tool_names.is_empty()
                        || allowed_tool_names.contains(lowered_name.as_str());
                    if name.len() > 128 || !name_allowed {
                        continue;
                    }

                    let call_id = read_trimmed_string(row.get("call_id"))
                        .or_else(|| read_trimmed_string(row.get("tool_call_id")))
                        .or_else(|| read_trimmed_string(row.get("id")));
                    if let Some(value) = call_id {
                        valid_call_ids.insert(value);
                    }
                    normalized.push(entry.clone());
                    continue;
                }

                if matches!(
                    ty.as_str(),
                    "function_call_output" | "tool_result" | "tool_message"
                ) {
                    let call_id = read_trimmed_string(row.get("call_id"))
                        .or_else(|| read_trimmed_string(row.get("tool_call_id")))
                        .or_else(|| read_trimmed_string(row.get("tool_use_id")))
                        .or_else(|| read_trimmed_string(row.get("id")));
                    let Some(call_id) = call_id else {
                        continue;
                    };
                    if saw_function_calls && !valid_call_ids.contains(call_id.as_str()) {
                        continue;
                    }
                    normalized.push(entry.clone());
                    continue;
                }

                normalized.push(entry.clone());
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

fn capture_req_inbound_responses_context_snapshot(
    input: ResponsesContextCaptureInput,
) -> Result<Value, String> {
    let raw_request_row = input
        .raw_request
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
    if !has_messages && !has_input_chat_messages {
        return Err("Responses payload produced no chat messages".to_string());
    }

    let mut context = Map::new();
    if let Some(request_id) = normalize_non_empty(input.request_id) {
        context.insert("requestId".to_string(), Value::String(request_id));
    }

    if let Some(input_array) = normalized_input {
        context.insert("input".to_string(), Value::Array(input_array));
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

    if let Some(tools_raw) = raw_request_row.get("tools").and_then(|v| v.as_array()) {
        context.insert("toolsRaw".to_string(), Value::Array(tools_raw.clone()));
        let normalized = map_bridge_tools_to_chat(tools_raw.as_slice());
        if !normalized.is_empty() {
            context.insert("toolsNormalized".to_string(), Value::Array(normalized));
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

fn resolve_client_inject_ready(metadata: &Value) -> bool {
    let row = match metadata.as_object() {
        Some(v) => v,
        None => return true,
    };
    pick_boolean(row.get("clientInjectReady"))
        .or_else(|| pick_boolean(row.get("client_inject_ready")))
        .unwrap_or(true)
}

fn normalize_context_capture_label(label: Option<String>) -> String {
    let normalized = label.unwrap_or_default().trim().to_string();
    if normalized.is_empty() {
        return "context_capture".to_string();
    }
    normalized
}

fn should_run_hub_chat_process(request_id: String, entry_endpoint: String) -> bool {
    let req = request_id.trim();
    let endpoint = entry_endpoint.trim();
    !req.is_empty() || !endpoint.is_empty()
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
pub fn resolve_server_tool_followup_snapshot_json(
    adapter_context_json: String,
) -> NapiResult<String> {
    let adapter_context: Value = serde_json::from_str(&adapter_context_json)
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let output = resolve_server_tool_followup_snapshot(&adapter_context);
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi]
pub fn augment_context_snapshot_json(
    context_json: String,
    fallback_json: String,
) -> NapiResult<String> {
    let context: Value =
        serde_json::from_str(&context_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let fallback: Value = serde_json::from_str(&fallback_json)
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let output = augment_context_snapshot(&context, &fallback);
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi]
pub fn normalize_tool_call_id_style_candidate_json(value_json: String) -> NapiResult<String> {
    let value: Value =
        serde_json::from_str(&value_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let output = normalize_tool_call_id_style_candidate(&value);
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi]
pub fn sanitize_format_envelope_json(candidate_json: String) -> NapiResult<String> {
    let candidate: Value = serde_json::from_str(&candidate_json)
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let output = sanitize_format_envelope(&candidate);
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi]
pub fn resolve_client_inject_ready_json(metadata_json: String) -> NapiResult<String> {
    let metadata: Value = serde_json::from_str(&metadata_json)
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let output = resolve_client_inject_ready(&metadata);
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi]
pub fn normalize_context_capture_label_json(label_json: String) -> NapiResult<String> {
    let label: Option<String> =
        serde_json::from_str(&label_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let output = normalize_context_capture_label(label);
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi]
pub fn should_run_hub_chat_process_json(
    request_id: String,
    entry_endpoint: String,
) -> NapiResult<String> {
    let output = should_run_hub_chat_process(request_id, entry_endpoint);
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
}
