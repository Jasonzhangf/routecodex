use crate::compat_fix_apply_patch::fix_apply_patch_tool_calls_json;
use crate::hub_req_inbound_tool_call_normalization::normalize_shell_like_tool_calls_before_governance;
use napi::bindgen_prelude::Result as NapiResult;
use napi_derive::napi;
use serde_json::{Map, Value};

const HUB_CAPTURE_KEY: &str = "__hub_capture";

fn as_object<'a>(value: &'a Value) -> Option<&'a Map<String, Value>> {
    value.as_object()
}

fn safe_stringify(value: &Value) -> String {
    if let Some(raw) = value.as_str() {
        return raw.to_string();
    }
    serde_json::to_string(value).unwrap_or_else(|_| String::from(""))
}

fn js_like_string(value: &Value) -> String {
    match value {
        Value::String(v) => v.clone(),
        Value::Bool(v) => {
            if *v {
                "true".to_string()
            } else {
                "false".to_string()
            }
        }
        Value::Number(v) => v.to_string(),
        Value::Null => String::new(),
        Value::Array(_) | Value::Object(_) => "[object Object]".to_string(),
    }
}

fn clone_content_array(parts: &[Value]) -> Vec<Value> {
    let mut output: Vec<Value> = Vec::with_capacity(parts.len());
    for part in parts {
        if part.is_object() {
            output.push(part.clone());
            continue;
        }
        if part.is_array() {
            output.push(part.clone());
            continue;
        }
        let text = if let Some(raw) = part.as_str() {
            raw.to_string()
        } else if part.is_null() {
            String::new()
        } else {
            js_like_string(part)
        };
        let mut fallback = Map::new();
        fallback.insert("type".to_string(), Value::String("text".to_string()));
        fallback.insert("text".to_string(), Value::String(text));
        output.push(Value::Object(fallback));
    }
    output
}

fn clone_message_content(content: Option<&Value>) -> Value {
    let Some(content) = content else {
        return Value::Null;
    };
    if content.is_null() {
        return Value::Null;
    }
    if let Some(raw) = content.as_str() {
        return Value::String(raw.to_string());
    }
    if let Some(parts) = content.as_array() {
        return Value::Array(clone_content_array(parts.as_slice()));
    }
    Value::String(js_like_string(content))
}

fn normalize_tool_call(tool_call: &Value) -> Option<Value> {
    let row = as_object(tool_call)?;
    let id = row.get("id")?.as_str()?.trim().to_string();
    if id.is_empty() {
        return None;
    }
    if row.get("type").and_then(|v| v.as_str()) != Some("function") {
        return None;
    }
    let fn_row = row.get("function").and_then(as_object)?;
    let raw_name = fn_row
        .get("name")
        .and_then(|v| v.as_str())
        .map(|v| v.to_string())
        .unwrap_or_default();
    let normalized_name = raw_name.trim().to_string();
    let args = fn_row
        .get("arguments")
        .cloned()
        .unwrap_or_else(|| Value::Object(Map::new()));
    let serialized_args = if let Some(raw) = args.as_str() {
        raw.to_string()
    } else {
        safe_stringify(&args)
    };

    let mut function = Map::new();
    function.insert(
        "name".to_string(),
        Value::String(if !normalized_name.is_empty() {
            normalized_name
        } else {
            raw_name
        }),
    );
    function.insert("arguments".to_string(), Value::String(serialized_args));

    let mut out = Map::new();
    out.insert("id".to_string(), Value::String(id));
    out.insert("type".to_string(), Value::String("function".to_string()));
    out.insert("function".to_string(), Value::Object(function));
    Some(Value::Object(out))
}

fn normalize_chat_message(message: &Value) -> Value {
    let message_row = message.as_object().cloned().unwrap_or_default();
    let role = message_row
        .get("role")
        .and_then(|v| v.as_str())
        .unwrap_or("user")
        .to_string();
    let content = clone_message_content(message_row.get("content"));

    let mut out = Map::new();
    out.insert("role".to_string(), Value::String(role));
    out.insert("content".to_string(), content);

    if let Some(tool_calls) = message_row.get("tool_calls").and_then(|v| v.as_array()) {
        let normalized_tool_calls: Vec<Value> =
            tool_calls.iter().filter_map(normalize_tool_call).collect();
        if !normalized_tool_calls.is_empty() {
            out.insert(
                "tool_calls".to_string(),
                Value::Array(normalized_tool_calls),
            );
        }
    }

    if let Some(tool_call_id) = message_row.get("tool_call_id").and_then(|v| v.as_str()) {
        out.insert(
            "tool_call_id".to_string(),
            Value::String(tool_call_id.trim().to_string()),
        );
    }

    if let Some(name) = message_row.get("name").and_then(|v| v.as_str()) {
        let trimmed = name.trim();
        if !trimmed.is_empty() {
            out.insert("name".to_string(), Value::String(trimmed.to_string()));
        }
    }

    Value::Object(out)
}

fn normalize_tools(tools: Option<&Value>) -> Vec<Value> {
    let Some(tools) = tools else {
        return Vec::new();
    };
    let Some(rows) = tools.as_array() else {
        return Vec::new();
    };
    let mut normalized: Vec<Value> = Vec::new();
    for tool in rows {
        let Some(tool_row) = tool.as_object() else {
            continue;
        };
        if tool_row.get("type").and_then(|v| v.as_str()) != Some("function") {
            continue;
        }
        let Some(fn_row) = tool_row.get("function").and_then(as_object) else {
            continue;
        };
        let Some(name) = fn_row.get("name").and_then(|v| v.as_str()) else {
            continue;
        };
        let trimmed_name = name.trim();
        if trimmed_name.is_empty() {
            continue;
        }

        let mut function = Map::new();
        function.insert("name".to_string(), Value::String(trimmed_name.to_string()));
        if let Some(description) = fn_row.get("description").and_then(|v| v.as_str()) {
            function.insert(
                "description".to_string(),
                Value::String(description.to_string()),
            );
        }
        function.insert(
            "parameters".to_string(),
            fn_row.get("parameters").cloned().unwrap_or_else(|| {
                let mut fallback = Map::new();
                fallback.insert("type".to_string(), Value::String("object".to_string()));
                fallback.insert("properties".to_string(), Value::Object(Map::new()));
                Value::Object(fallback)
            }),
        );
        if let Some(strict) = fn_row.get("strict").and_then(|v| v.as_bool()) {
            function.insert("strict".to_string(), Value::Bool(strict));
        }

        let mut out_tool = Map::new();
        out_tool.insert("type".to_string(), Value::String("function".to_string()));
        out_tool.insert("function".to_string(), Value::Object(function));
        normalized.push(Value::Object(out_tool));
    }
    normalized
}

fn map_chat_tools_to_bridge(tools: &Value) -> Value {
    let normalized = normalize_tools(Some(tools));
    Value::Array(normalized)
}

#[napi]
pub fn map_chat_tools_to_bridge_json(tools_json: String) -> NapiResult<String> {
    let tools: Value =
        serde_json::from_str(&tools_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let output = map_chat_tools_to_bridge(&tools);
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}

fn extract_model(parameters: &Map<String, Value>) -> Result<String, napi::Error> {
    let candidate = parameters
        .get("model")
        .and_then(|v| v.as_str())
        .map(|v| v.trim().to_string())
        .unwrap_or_default();
    if candidate.is_empty() {
        return Err(napi::Error::from_reason(
            "ChatEnvelope parameters must include model string".to_string(),
        ));
    }
    Ok(candidate)
}

fn hub_state_context_populated(state: &Map<String, Value>) -> bool {
    if state.get("context").is_some() {
        return true;
    }
    if let Some(missing_fields) = state.get("missingFields").and_then(|v| v.as_array()) {
        if !missing_fields.is_empty() {
            return true;
        }
    }
    if state.get("providerMetadata").is_some() {
        return true;
    }
    if let Some(protocol_state) = state.get("protocolState").and_then(|v| v.as_object()) {
        if !protocol_state.is_empty() {
            return true;
        }
    }
    false
}

pub(crate) fn normalize_chat_envelope_tool_calls(chat: &Value) -> Value {
    let mut chat_normalized = chat.clone();
    normalize_shell_like_tool_calls_before_governance(&mut chat_normalized);
    let Ok(raw_json) = serde_json::to_string(&chat_normalized) else {
        return chat_normalized;
    };
    let Ok(fixed_json) = fix_apply_patch_tool_calls_json(raw_json) else {
        return chat_normalized;
    };
    serde_json::from_str::<Value>(&fixed_json).unwrap_or(chat_normalized)
}

fn chat_envelope_to_standardized_impl(
    chat: &Value,
    adapter_context: &Value,
    endpoint: &str,
    request_id: Option<&str>,
) -> Result<Value, napi::Error> {
    let chat_row = chat
        .as_object()
        .ok_or_else(|| napi::Error::from_reason("chat envelope must be an object".to_string()))?;

    let parameters = chat_row
        .get("parameters")
        .and_then(|v| v.as_object())
        .cloned()
        .unwrap_or_default();
    let model = extract_model(&parameters)?;

    let chat_normalized = normalize_chat_envelope_tool_calls(chat);
    let chat_row = chat_normalized.as_object().cloned().unwrap_or_else(|| chat_row.clone());

    let messages = chat_row
        .get("messages")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default()
        .iter()
        .map(normalize_chat_message)
        .collect::<Vec<Value>>();

    let tools = normalize_tools(chat_row.get("tools"));
    let semantics = chat_row.get("semantics").cloned().unwrap_or(Value::Null);

    let metadata = chat_row
        .get("metadata")
        .and_then(|v| v.as_object())
        .cloned()
        .unwrap_or_default();
    let mut hub_state = Map::new();
    if let Some(missing_fields) = metadata.get("missingFields").and_then(|v| v.as_array()) {
        if !missing_fields.is_empty() {
            hub_state.insert(
                "missingFields".to_string(),
                Value::Array(missing_fields.clone()),
            );
        }
    }
    if let Some(provider_metadata) = metadata.get("providerMetadata").and_then(|v| v.as_object()) {
        hub_state.insert(
            "providerMetadata".to_string(),
            Value::Object(provider_metadata.clone()),
        );
    }
    if let Some(protocol_state) = metadata.get("protocolState").and_then(|v| v.as_object()) {
        hub_state.insert(
            "protocolState".to_string(),
            Value::Object(protocol_state.clone()),
        );
    }
    if let Some(reasoning_segments) = metadata.get("__rcc_reasoning_instructions_segments") {
        hub_state.insert(
            "__rcc_reasoning_instructions_segments".to_string(),
            reasoning_segments.clone(),
        );
    }
    hub_state.insert("context".to_string(), adapter_context.clone());

    let mut metadata_captured = Map::new();
    if hub_state_context_populated(&hub_state) {
        metadata_captured.insert(HUB_CAPTURE_KEY.to_string(), Value::Object(hub_state));
    }

    let stream = parameters
        .get("stream")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

    let mut standard_metadata = Map::new();
    standard_metadata.insert(
        "originalEndpoint".to_string(),
        Value::String(endpoint.to_string()),
    );
    standard_metadata.insert(
        "capturedContext".to_string(),
        Value::Object(metadata_captured),
    );
    if let Some(request_id) = request_id {
        standard_metadata.insert(
            "requestId".to_string(),
            Value::String(request_id.to_string()),
        );
    }
    standard_metadata.insert("stream".to_string(), Value::Bool(stream));

    let mut standardized = Map::new();
    standardized.insert("model".to_string(), Value::String(model));
    standardized.insert("messages".to_string(), Value::Array(messages));
    standardized.insert("tools".to_string(), Value::Array(tools));
    standardized.insert("parameters".to_string(), Value::Object(parameters));
    standardized.insert("metadata".to_string(), Value::Object(standard_metadata));
    if !semantics.is_null() {
        standardized.insert("semantics".to_string(), semantics);
    }

    Ok(Value::Object(standardized))
}

#[napi]
pub fn chat_envelope_to_standardized_json(
    chat_json: String,
    adapter_context_json: String,
    endpoint: String,
    request_id: Option<String>,
) -> NapiResult<String> {
    let chat: Value = serde_json::from_str(chat_json.as_str())
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let adapter_context: Value = serde_json::from_str(adapter_context_json.as_str())
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let standardized = chat_envelope_to_standardized_impl(
        &chat,
        &adapter_context,
        endpoint.as_str(),
        request_id.as_deref(),
    )?;
    serde_json::to_string(&standardized).map_err(|e| napi::Error::from_reason(e.to_string()))
}

fn clone_runtime_metadata(carrier: Option<&Value>) -> Option<Map<String, Value>> {
    let carrier_row = carrier.and_then(|v| v.as_object())?;
    let rt = carrier_row.get("__rt")?.as_object()?;
    Some(rt.clone())
}

fn restore_message_content(content: Option<&Value>) -> Option<Value> {
    let Some(content) = content else {
        return None;
    };
    if content.is_null() {
        return Some(Value::Null);
    }
    if let Some(raw) = content.as_str() {
        return Some(Value::String(raw.to_string()));
    }
    if let Some(parts) = content.as_array() {
        return Some(Value::Array(clone_content_array(parts.as_slice())));
    }
    Some(clone_message_content(Some(content)))
}

fn map_tool_calls(tool_calls: Option<&Value>) -> Option<Value> {
    let rows = tool_calls.and_then(|v| v.as_array())?;
    if rows.is_empty() {
        return None;
    }
    let mapped = rows
        .iter()
        .filter_map(|tool| {
            let tool_row = tool.as_object()?;
            let id = tool_row.get("id")?.as_str()?.to_string();
            let fn_row = tool_row.get("function").and_then(|v| v.as_object())?;
            let name = fn_row.get("name")?.as_str()?.to_string();
            let arguments = fn_row.get("arguments")?.as_str()?.to_string();
            let mut out_fn = Map::new();
            out_fn.insert("name".to_string(), Value::String(name));
            out_fn.insert("arguments".to_string(), Value::String(arguments));
            let mut out_tool = Map::new();
            out_tool.insert("id".to_string(), Value::String(id));
            out_tool.insert("type".to_string(), Value::String("function".to_string()));
            out_tool.insert("function".to_string(), Value::Object(out_fn));
            Some(Value::Object(out_tool))
        })
        .collect::<Vec<Value>>();
    if mapped.is_empty() {
        return None;
    }
    Some(Value::Array(mapped))
}

fn map_standardized_tools(tools: Option<&Value>) -> Option<Value> {
    let rows = tools.and_then(|v| v.as_array())?;
    if rows.is_empty() {
        return None;
    }
    let mapped = rows
        .iter()
        .filter_map(|tool| {
            let tool_row = tool.as_object()?;
            let tool_type = tool_row.get("type")?.as_str()?.to_string();
            let fn_row = tool_row.get("function").and_then(|v| v.as_object())?;
            let name = fn_row.get("name")?.as_str()?.to_string();
            let description = fn_row
                .get("description")
                .and_then(|v| v.as_str())
                .map(|v| v.to_string());
            let parameters = fn_row
                .get("parameters")
                .cloned()
                .unwrap_or_else(|| Value::Object(Map::new()));
            let strict = fn_row.get("strict").and_then(|v| v.as_bool());

            let mut out_fn = Map::new();
            out_fn.insert("name".to_string(), Value::String(name));
            if let Some(description) = description {
                out_fn.insert("description".to_string(), Value::String(description));
            }
            out_fn.insert("parameters".to_string(), parameters);
            if let Some(strict) = strict {
                out_fn.insert("strict".to_string(), Value::Bool(strict));
            }

            let mut out_tool = Map::new();
            out_tool.insert("type".to_string(), Value::String(tool_type));
            out_tool.insert("function".to_string(), Value::Object(out_fn));
            Some(Value::Object(out_tool))
        })
        .collect::<Vec<Value>>();
    if mapped.is_empty() {
        return None;
    }
    Some(Value::Array(mapped))
}

fn extract_hub_capture(request: &Map<String, Value>) -> Option<Map<String, Value>> {
    let metadata = request.get("metadata").and_then(|v| v.as_object())?;
    let captured = metadata
        .get("capturedContext")
        .and_then(|v| v.as_object())?;
    let state = captured.get(HUB_CAPTURE_KEY).and_then(|v| v.as_object())?;
    Some(state.clone())
}

fn standardized_to_chat_envelope_impl(
    request: &Value,
    adapter_context: &Value,
) -> Result<Value, napi::Error> {
    let request_row = request.as_object().ok_or_else(|| {
        napi::Error::from_reason("standardized request must be an object".to_string())
    })?;
    let adapter_context_row = adapter_context
        .as_object()
        .ok_or_else(|| napi::Error::from_reason("adapter context must be an object".to_string()))?;
    let hub_state = extract_hub_capture(request_row);

    let messages = request_row
        .get("messages")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default()
        .iter()
        .map(|message| {
            let message_row = message.as_object().cloned().unwrap_or_default();
            let role = message_row
                .get("role")
                .and_then(|v| v.as_str())
                .unwrap_or("user")
                .to_string();
            let mut out = Map::new();
            out.insert("role".to_string(), Value::String(role));
            if let Some(content) = restore_message_content(message_row.get("content")) {
                out.insert("content".to_string(), content);
            }
            if let Some(tool_calls) = map_tool_calls(message_row.get("tool_calls")) {
                out.insert("tool_calls".to_string(), tool_calls);
            }
            if let Some(tool_call_id) = message_row.get("tool_call_id").and_then(|v| v.as_str()) {
                out.insert(
                    "tool_call_id".to_string(),
                    Value::String(tool_call_id.to_string()),
                );
            }
            if let Some(name) = message_row.get("name").and_then(|v| v.as_str()) {
                out.insert("name".to_string(), Value::String(name.to_string()));
            }
            Value::Object(out)
        })
        .collect::<Vec<Value>>();

    let tools = map_standardized_tools(request_row.get("tools"));
    let mut parameters = request_row
        .get("parameters")
        .and_then(|v| v.as_object())
        .cloned()
        .unwrap_or_default();
    let model = request_row
        .get("model")
        .and_then(|v| v.as_str())
        .map(|v| v.to_string())
        .unwrap_or_default();
    parameters.insert("model".to_string(), Value::String(model));

    let mut metadata = Map::new();
    metadata.insert(
        "context".to_string(),
        Value::Object(adapter_context_row.clone()),
    );

    let source_meta = request_row.get("metadata").and_then(|v| v.as_object());
    let mut merged_runtime = clone_runtime_metadata(Some(adapter_context)).unwrap_or_default();
    if let Some(source_meta_value) = source_meta {
        if let Some(from_source) =
            clone_runtime_metadata(Some(&Value::Object(source_meta_value.clone())))
        {
            for (key, value) in from_source {
                merged_runtime.insert(key, value);
            }
        }
        if source_meta_value
            .get("webSearch")
            .and_then(|v| v.as_object())
            .is_some()
            && !merged_runtime.contains_key("webSearch")
        {
            if let Some(web_search) = source_meta_value.get("webSearch") {
                merged_runtime.insert("webSearch".to_string(), web_search.clone());
            }
        }
        if source_meta_value
            .get("forceWebSearch")
            .and_then(|v| v.as_bool())
            .unwrap_or(false)
            && !merged_runtime.contains_key("forceWebSearch")
        {
            merged_runtime.insert("forceWebSearch".to_string(), Value::Bool(true));
        }
        if source_meta_value
            .get("forceVision")
            .and_then(|v| v.as_bool())
            .unwrap_or(false)
            && !merged_runtime.contains_key("forceVision")
        {
            merged_runtime.insert("forceVision".to_string(), Value::Bool(true));
        }
    }
    if !merged_runtime.is_empty() {
        metadata.insert("__rt".to_string(), Value::Object(merged_runtime));
    }

    if let Some(tool_call_id_style) = adapter_context_row
        .get("toolCallIdStyle")
        .and_then(|v| v.as_str())
    {
        if !tool_call_id_style.is_empty() {
            metadata.insert(
                "toolCallIdStyle".to_string(),
                Value::String(tool_call_id_style.to_string()),
            );
        }
    }

    if let Some(hub_state) = hub_state {
        if let Some(missing_fields) = hub_state.get("missingFields") {
            metadata.insert("missingFields".to_string(), missing_fields.clone());
        }
        if let Some(provider_metadata) = hub_state.get("providerMetadata") {
            metadata.insert("providerMetadata".to_string(), provider_metadata.clone());
        }
        if let Some(protocol_state) = hub_state.get("protocolState") {
            metadata.insert("protocolState".to_string(), protocol_state.clone());
        }
        if let Some(reasoning_segments) = hub_state.get("__rcc_reasoning_instructions_segments") {
            metadata.insert(
                "__rcc_reasoning_instructions_segments".to_string(),
                reasoning_segments.clone(),
            );
        }
    }

    let semantics = request_row.get("semantics").cloned();
    let mut output = Map::new();
    output.insert("messages".to_string(), Value::Array(messages));
    if let Some(tools) = tools {
        output.insert("tools".to_string(), tools);
    }
    output.insert("parameters".to_string(), Value::Object(parameters));
    output.insert("metadata".to_string(), Value::Object(metadata));
    if let Some(semantics) = semantics {
        output.insert("semantics".to_string(), semantics);
    }

    Ok(Value::Object(output))
}

#[napi]
pub fn standardized_to_chat_envelope_json(
    request_json: String,
    adapter_context_json: String,
) -> NapiResult<String> {
    let request: Value = serde_json::from_str(request_json.as_str())
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let adapter_context: Value = serde_json::from_str(adapter_context_json.as_str())
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let envelope = standardized_to_chat_envelope_impl(&request, &adapter_context)?;
    serde_json::to_string(&envelope).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::chat_envelope_to_standardized_impl;
    use serde_json::{json, Value};

    #[test]
    fn standardization_normalizes_exec_command_tool_call_shape() {
        let chat = json!({
            "messages": [
                {
                    "role": "assistant",
                    "tool_calls": [
                        {
                            "id": "call_1",
                            "type": "function",
                            "function": {
                                "name": "exec_command",
                                "arguments": "{\"args\":{\"command\":\"pnpm test\"},\"cwd\":\"/repo\"}"
                            }
                        }
                    ]
                }
            ],
            "tools": [{ "type": "function", "function": { "name": "exec_command" } }],
            "parameters": { "model": "gpt-5.4" },
            "metadata": {}
        });

        let standardized = chat_envelope_to_standardized_impl(
            &chat,
            &json!({}),
            "/v1/chat/completions",
            Some("req_exec"),
        )
        .expect("standardized");

        let args_text = standardized["messages"][0]["tool_calls"][0]["function"]["arguments"]
            .as_str()
            .expect("arguments text");
        let args: Value = serde_json::from_str(args_text).expect("arguments json");
        assert_eq!(args["cmd"], "pnpm test");
        assert_eq!(args["command"], "pnpm test");
        assert_eq!(args["workdir"], "/repo");
    }

    #[test]
    fn standardization_normalizes_apply_patch_tool_call_shape() {
        let chat = json!({
            "messages": [
                {
                    "role": "assistant",
                    "tool_calls": [
                        {
                            "id": "call_patch_1",
                            "type": "function",
                            "function": {
                                "name": "apply_patch",
                                "arguments": "apply_patch *** Begin Patch\n*** Add File: src/demo.ts\n+console.log('ok');\n*** End Patch"
                            }
                        }
                    ]
                }
            ],
            "tools": [{ "type": "function", "function": { "name": "apply_patch" } }],
            "parameters": { "model": "gpt-5.4" },
            "metadata": {}
        });

        let standardized = chat_envelope_to_standardized_impl(
            &chat,
            &json!({}),
            "/v1/chat/completions",
            Some("req_patch"),
        )
        .expect("standardized");

        let args_text = standardized["messages"][0]["tool_calls"][0]["function"]["arguments"]
            .as_str()
            .expect("arguments text");
        let args: Value = serde_json::from_str(args_text).expect("arguments json");
        let patch = args["input"].as_str().expect("normalized patch input");
        assert!(patch.starts_with("*** Begin Patch"));
        assert!(patch.contains("*** Add File: src/demo.ts"));
        assert!(!patch.starts_with("apply_patch "));
    }
}
