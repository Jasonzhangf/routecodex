use super::*;
use serde_json::{Value, json};
use std::collections::BTreeMap;

pub(crate) fn build_v3_responses_provider_response_from_openai_chat_payload(
    payload: &Value,
    provider_semantic_body: &Value,
) -> Result<Value, V3ResponsesRelayRuntimeError> {
    build_v3_responses_provider_response_from_openai_chat_payload_with_manifest(
        payload,
        provider_semantic_body,
        None,
        None,
    )
}

pub(crate) fn build_v3_responses_provider_response_from_openai_chat_payload_with_manifest(
    payload: &Value,
    provider_semantic_body: &Value,
    manifest: Option<&V3Config05ManifestPublished>,
    provider_id: Option<&str>,
) -> Result<Value, V3ResponsesRelayRuntimeError> {
    if let Some(message) =
        responses_relay_diagnostics::openai_chat_provider_diagnostic_message(payload)
    {
        return Err(V3ResponsesRelayRuntimeError::ProviderResponseEventCodec(
            message,
        ));
    }
    if let Some(message) =
        responses_relay_diagnostics::provider_response_semantic_error_message_from_manifest(
            manifest,
            provider_id,
            payload,
        )
    {
        return Err(V3ResponsesRelayRuntimeError::ProviderResponseEventCodec(
            message,
        ));
    }

    let choices = payload
        .get("choices")
        .and_then(Value::as_array)
        .ok_or_else(|| {
            V3ResponsesRelayRuntimeError::ProviderResponseEventCodec(
                "OpenAI Chat provider response must contain choices before Responses projection"
                    .to_string(),
            )
        })?;
    let anthropic_provider_extensions = payload
        .pointer(
            "/choices/0/message/routecodex_chat_extension/anthropic_provider_response_extensions",
        )
        .and_then(Value::as_object);
    let anthropic_stop_reason = anthropic_provider_extensions
        .and_then(|extensions| extensions.get("stop_reason"))
        .and_then(Value::as_str);
    let mut output = Vec::new();
    let mut output_text_parts = Vec::new();
    let mut finish_reason = None;
    let custom_tool_names = collect_v3_responses_custom_tool_names(provider_semantic_body);
    for choice in choices {
        if finish_reason.is_none() {
            finish_reason = choice
                .get("finish_reason")
                .and_then(Value::as_str)
                .map(str::to_string);
        }
        if let Some(message) = choice.get("message").and_then(Value::as_object) {
            let anthropic_extension = message
                .get("routecodex_chat_extension")
                .and_then(Value::as_object);
            consume_anthropic_reasoning_extensions_for_responses(anthropic_extension)?;
            if let Some(order) = anthropic_extension
                .and_then(|extension| extension.get("anthropic_content_order"))
                .and_then(Value::as_array)
            {
                let reasoning = anthropic_extension
                    .and_then(|extension| extension.get("anthropic_reasoning_blocks"))
                    .and_then(Value::as_array)
                    .map(Vec::as_slice)
                    .unwrap_or(&[]);
                let text_blocks = anthropic_extension
                    .and_then(|extension| extension.get("anthropic_text_blocks"))
                    .and_then(Value::as_array)
                    .map(Vec::as_slice)
                    .unwrap_or(&[]);
                let calls = message
                    .get("tool_calls")
                    .and_then(Value::as_array)
                    .map(Vec::as_slice)
                    .unwrap_or(&[]);
                for entry in order {
                    let Some(index) = entry
                        .get("index")
                        .and_then(Value::as_u64)
                        .map(|i| i as usize)
                    else {
                        return Err(V3ResponsesRelayRuntimeError::ProviderResponseEventCodec(
                            "Anthropic response content order has a malformed index".to_string(),
                        ));
                    };
                    match entry.get("kind").and_then(Value::as_str) {
                        Some("text") => {
                            let text = text_blocks.get(index).and_then(Value::as_str).ok_or_else(
                                || {
                                    V3ResponsesRelayRuntimeError::ProviderResponseEventCodec(
                                        "Anthropic response content order references missing text"
                                            .to_string(),
                                    )
                                },
                            )?;
                            if !text.trim().is_empty() {
                                output_text_parts.push(text.to_string());
                                output.push(json!({"type":"output_text","text":text}));
                            }
                        }
                        Some("reasoning") => {
                            let block = reasoning.get(index).ok_or_else(|| {
                                V3ResponsesRelayRuntimeError::ProviderResponseEventCodec(
                                    "Anthropic response content order references missing reasoning"
                                        .to_string(),
                                )
                            })?;
                            if let Some(item) =
                                build_v3_responses_reasoning_item_from_chat_extension(block)
                            {
                                output.push(item);
                            }
                        }
                        Some("tool_call") => {
                            let call = calls.get(index).ok_or_else(|| {
                                V3ResponsesRelayRuntimeError::ProviderResponseEventCodec(
                                    "Anthropic response content order references missing tool call"
                                        .to_string(),
                                )
                            })?;
                            output.push(
                                build_v3_responses_function_call_from_openai_chat_tool_call(
                                    call,
                                    &custom_tool_names,
                                )?,
                            );
                        }
                        _ => {
                            return Err(V3ResponsesRelayRuntimeError::ProviderResponseEventCodec(
                                "Anthropic response content order has an unknown block kind"
                                    .to_string(),
                            ));
                        }
                    }
                }
                continue;
            }
            if let Some(reasoning_blocks) = message
                .get("routecodex_chat_extension")
                .and_then(|extension| extension.get("anthropic_reasoning_blocks"))
                .and_then(Value::as_array)
            {
                for block in reasoning_blocks {
                    if let Some(reasoning) =
                        build_v3_responses_reasoning_item_from_chat_extension(block)
                    {
                        output.push(reasoning);
                    }
                }
            } else if let Some(reasoning) =
                build_v3_responses_reasoning_item_from_openai_chat_message(message)
            {
                output.push(reasoning);
            }
            if let Some(content) = message.get("content").and_then(Value::as_str) {
                if !content.trim().is_empty() {
                    output_text_parts.push(content.to_string());
                    output.push(json!({"type":"output_text","text":content}));
                }
            }
            if let Some(tool_calls) = message.get("tool_calls").and_then(Value::as_array) {
                for call in tool_calls {
                    output.push(build_v3_responses_function_call_from_openai_chat_tool_call(
                        call,
                        &custom_tool_names,
                    )?);
                }
            }
        }
    }
    let status = match anthropic_stop_reason {
        Some("tool_use") => "requires_action",
        Some("max_tokens" | "refusal" | "model_context_window_exceeded") => "incomplete",
        Some("pause_turn") => "in_progress",
        Some("end_turn" | "stop_sequence") => "completed",
        _ if output.iter().any(|item| {
            matches!(
                item.get("type").and_then(Value::as_str),
                Some("function_call" | "tool_call" | "custom_tool_call" | "tool_search_call")
            )
        }) || finish_reason.as_deref() == Some("tool_calls") =>
        {
            "requires_action"
        }
        _ => "completed",
    };
    let mut output_items = Vec::new();
    let mut message_item: Option<Map<String, Value>> = None;
    for item in output {
        if item.get("type").and_then(Value::as_str) == Some("output_text") {
            let message = message_item.get_or_insert_with(|| {
                let mut message = Map::new();
                message.insert("type".to_string(), Value::String("message".to_string()));
                message.insert("status".to_string(), Value::String("completed".to_string()));
                message.insert("role".to_string(), Value::String("assistant".to_string()));
                message.insert("content".to_string(), Value::Array(Vec::new()));
                message
            });
            let content = message
                .get_mut("content")
                .and_then(Value::as_array_mut)
                .ok_or_else(|| {
                    V3ResponsesRelayRuntimeError::ProviderResponseEventCodec(
                        "Responses message output content lost its array shape".to_string(),
                    )
                })?;
            content.push(item);
        } else {
            if let Some(message) = message_item.take() {
                output_items.push(Value::Object(message));
            }
            output_items.push(item);
        }
    }
    if let Some(message) = message_item {
        output_items.push(Value::Object(message));
    }
    let mut response = Map::new();
    response.insert(
        "id".to_string(),
        payload
            .get("id")
            .cloned()
            .unwrap_or_else(|| Value::String("resp_openai_chat_relay".to_string())),
    );
    response.insert("object".to_string(), Value::String("response".to_string()));
    if let Some(model) = payload.get("model") {
        response.insert("model".to_string(), model.clone());
    }
    if let Some(created_at) = payload.get("created_at").or_else(|| payload.get("created")) {
        response.insert("created_at".to_string(), created_at.clone());
    }
    response.insert("status".to_string(), Value::String(status.to_string()));
    response.insert("output".to_string(), Value::Array(output_items));
    if let Some(metadata) = provider_semantic_body
        .pointer("/routecodex_chat_extension/responses_request/metadata")
        .and_then(Value::as_object)
    {
        response.insert("metadata".to_string(), Value::Object(metadata.clone()));
    }
    if !output_text_parts.is_empty() {
        response.insert(
            "output_text".to_string(),
            Value::String(output_text_parts.join("")),
        );
    }
    if let Some(finish_reason) = finish_reason {
        response.insert("finish_reason".to_string(), Value::String(finish_reason));
    }
    if let Some(extensions) = anthropic_provider_extensions {
        if let Some(stop_reason) = extensions.get("stop_reason") {
            response.insert("finish_reason".to_string(), stop_reason.clone());
        }
        for field in ["stop_sequence", "stop_details"] {
            if let Some(value) = extensions.get(field) {
                response.insert(field.to_string(), value.clone());
            }
        }
        if anthropic_stop_reason == Some("max_tokens") {
            response.insert(
                "incomplete_details".to_string(),
                json!({"reason":"max_output_tokens"}),
            );
        } else if anthropic_stop_reason == Some("refusal") {
            response.insert(
                "incomplete_details".to_string(),
                json!({"reason":"content_filter"}),
            );
        }
    }
    if let Some(usage) = payload
        .get("usage")
        .and_then(normalize_v3_hub_responses_usage_from_openai_chat_usage)
    {
        response.insert("usage".to_string(), usage);
    }
    Ok(Value::Object(response))
}

fn consume_anthropic_reasoning_extensions_for_responses(
    extension: Option<&serde_json::Map<String, Value>>,
) -> Result<(), V3ResponsesRelayRuntimeError> {
    let Some(entries) = extension
        .and_then(|extension| extension.get("anthropic_provider_reasoning_extensions"))
        .and_then(Value::as_array)
    else {
        return Ok(());
    };
    // Provider-private fields on otherwise understood reasoning blocks have no
    // Responses wire equivalent; consume them explicitly at target projection.
    // Unknown block kinds retain a `type` tag and fail below instead of vanishing.
    if entries.iter().any(|entry| entry.get("type").is_some()) {
        return Err(V3ResponsesRelayRuntimeError::ProviderResponseEventCodec(
            "Anthropic provider content block is incompatible with Responses output".to_string(),
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn responses_projection_rejects_unmapped_anthropic_content_blocks() {
        let payload = json!({
            "choices":[{
                "finish_reason":"stop",
                "message":{
                    "role":"assistant",
                    "content":"visible",
                    "routecodex_chat_extension":{
                        "anthropic_provider_response_extensions":{"stop_reason":"end_turn"},
                        "anthropic_provider_reasoning_extensions":[{
                            "block_index":0,
                            "block":{"type":"server_tool_use","id":"st_1"},
                            "type":"server_tool_use"
                        }]
                    }
                }
            }]
        });
        let error =
            build_v3_responses_provider_response_from_openai_chat_payload(&payload, &json!({}))
                .expect_err("unmapped Anthropic block must not be silently dropped");
        assert!(
            error
                .to_string()
                .contains("incompatible with Responses output"),
            "unexpected projection error: {error}"
        );
    }
}

fn build_v3_responses_reasoning_item_from_chat_extension(block: &Value) -> Option<Value> {
    let block = block.as_object()?;
    let summary = block.get("summary").and_then(Value::as_array);
    let encrypted_content = block
        .get("encrypted_content")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty());
    if summary.is_none_or(Vec::is_empty) && encrypted_content.is_none() {
        return None;
    }
    let mut item = Map::new();
    item.insert("type".to_string(), Value::String("reasoning".to_string()));
    if let Some(summary) = summary {
        item.insert("summary".to_string(), Value::Array(summary.clone()));
    }
    if let Some(encrypted_content) = encrypted_content {
        item.insert(
            "encrypted_content".to_string(),
            Value::String(encrypted_content.to_string()),
        );
    }
    Some(Value::Object(item))
}

pub(crate) fn build_v3_responses_reasoning_item_from_openai_chat_message(
    message: &Map<String, Value>,
) -> Option<Value> {
    let mut summary = Vec::new();
    let mut encrypted_content = None;

    if let Some(reasoning) = message.get("reasoning") {
        if let Some(reasoning_row) = reasoning.as_object() {
            summary = collect_v3_reasoning_summary_entries(reasoning_row.get("summary"));
            if summary.is_empty() {
                summary = collect_v3_reasoning_content_entries(reasoning_row.get("content"))
                    .into_iter()
                    .map(v3_reasoning_summary_text_entry)
                    .collect();
            }
            encrypted_content = read_v3_trimmed_string(reasoning_row.get("encrypted_content"));
        } else if let Some(text) = flatten_v3_reasoning_text(reasoning)
            .map(|text| text.trim().to_string())
            .filter(|text| !text.is_empty())
        {
            summary.push(v3_reasoning_summary_text_entry(text));
        }
    }

    if summary.is_empty() {
        for key in ["reasoning_content", "reasoning_text"] {
            if let Some(text) = message
                .get(key)
                .and_then(flatten_v3_reasoning_text)
                .map(|text| text.trim().to_string())
                .filter(|text| !text.is_empty())
            {
                summary.push(v3_reasoning_summary_text_entry(text));
                break;
            }
        }
    }

    if summary.is_empty() && encrypted_content.is_none() {
        return None;
    }

    let mut item = Map::new();
    item.insert("type".to_string(), Value::String("reasoning".to_string()));
    if !summary.is_empty() {
        item.insert("summary".to_string(), Value::Array(summary));
        // 明文推理同时作为 content 供客户端回传：Codex 只把 content（完整推理）
        // 回传到下一轮；缺失 content 时客户端发保留标记（rsn_*），导致 wire
        // reasoning_content 字节与上一轮不匹配 -> ds4 续写缓存 miss -> provider
        // 失忆（"没有之前的上下文"）。content 与 summary 同源（当前 provider
        // 明文即完整推理，无摘要/完整之分）。
        let content: Vec<Value> = item
            .get("summary")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|entry| entry.get("text").cloned())
            .map(|text| json!({"type": "reasoning_text", "text": text}))
            .collect();
        if !content.is_empty() {
            item.insert("content".to_string(), Value::Array(content));
        }
    }
    if let Some(encrypted_content) = encrypted_content {
        item.insert(
            "encrypted_content".to_string(),
            Value::String(encrypted_content),
        );
    }
    Some(Value::Object(item))
}

pub(crate) fn collect_v3_reasoning_summary_entries(value: Option<&Value>) -> Vec<Value> {
    collect_v3_reasoning_text_entries(value, Some("summary_text"))
        .into_iter()
        .map(v3_reasoning_summary_text_entry)
        .collect()
}

pub(crate) fn collect_v3_reasoning_content_entries(value: Option<&Value>) -> Vec<String> {
    collect_v3_reasoning_text_entries(value, Some("reasoning_text"))
}

pub(crate) fn collect_v3_reasoning_text_entries(
    value: Option<&Value>,
    expected_type: Option<&str>,
) -> Vec<String> {
    let Some(value) = value else {
        return Vec::new();
    };
    match value {
        Value::String(text) => trimmed_v3_text(text).into_iter().collect(),
        Value::Array(entries) => entries
            .iter()
            .flat_map(|entry| collect_v3_reasoning_text_entries(Some(entry), expected_type))
            .collect(),
        Value::Object(row) => {
            if let Some(expected_type) = expected_type {
                let kind = row
                    .get("type")
                    .and_then(Value::as_str)
                    .unwrap_or(expected_type)
                    .trim()
                    .to_ascii_lowercase();
                if kind != expected_type && kind != "text" {
                    return Vec::new();
                }
            }
            row.get("text")
                .or_else(|| row.get("content"))
                .and_then(flatten_v3_reasoning_text)
                .map(|text| text.trim().to_string())
                .filter(|text| !text.is_empty())
                .into_iter()
                .collect()
        }
        _ => Vec::new(),
    }
}

pub(crate) fn flatten_v3_reasoning_text(value: &Value) -> Option<String> {
    match value {
        Value::String(text) => trimmed_v3_text(text),
        Value::Array(entries) => {
            let mut joined = String::new();
            for text in entries
                .iter()
                .filter_map(flatten_v3_reasoning_text)
                .filter(|text| !text.trim().is_empty())
            {
                if !joined.is_empty() {
                    joined.push('\n');
                }
                joined.push_str(text.trim());
            }
            trimmed_v3_text(joined.as_str())
        }
        Value::Object(row) => row
            .get("text")
            .or_else(|| row.get("content"))
            .and_then(flatten_v3_reasoning_text),
        _ => None,
    }
}

pub(crate) fn trimmed_v3_text(text: &str) -> Option<String> {
    let trimmed = text.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_string())
}

pub(crate) fn v3_reasoning_summary_text_entry(text: String) -> Value {
    json!({"type":"summary_text","text":text})
}

pub(crate) fn normalize_v3_hub_responses_usage_from_openai_chat_usage(
    usage: &Value,
) -> Option<Value> {
    let source = usage.as_object()?;
    let mut response = Map::new();
    if let Some(value) = source
        .get("input_tokens")
        .or_else(|| source.get("prompt_tokens"))
        .cloned()
    {
        response.insert("input_tokens".to_string(), value);
    }
    if let Some(value) = source
        .get("output_tokens")
        .or_else(|| source.get("completion_tokens"))
        .cloned()
    {
        response.insert("output_tokens".to_string(), value);
    }
    if let Some(value) = source.get("total_tokens").cloned() {
        response.insert("total_tokens".to_string(), value);
    }
    if let Some(details) = source
        .get("input_tokens_details")
        .or_else(|| source.get("prompt_tokens_details"))
        .cloned()
    {
        response.insert("input_tokens_details".to_string(), details);
    }
    if let Some(details) = source
        .get("output_tokens_details")
        .or_else(|| source.get("completion_tokens_details"))
        .cloned()
    {
        response.insert("output_tokens_details".to_string(), details);
    }
    (!response.is_empty()).then_some(Value::Object(response))
}

pub(crate) fn build_v3_responses_function_call_from_openai_chat_tool_call(
    call: &Value,
    custom_tool_names: &BTreeMap<String, String>,
) -> Result<Value, V3ResponsesRelayRuntimeError> {
    let object = call.as_object().ok_or_else(|| {
        V3ResponsesRelayRuntimeError::ProviderResponseEventCodec(
            "OpenAI Chat tool_call must be an object before Responses projection".to_string(),
        )
    })?;
    let call_id = object
        .get("id")
        .or_else(|| object.get("call_id"))
        .or_else(|| object.get("tool_call_id"))
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| {
            V3ResponsesRelayRuntimeError::ProviderResponseEventCodec(
                "OpenAI Chat tool_call id is required before Responses projection".to_string(),
            )
        })?;
    if object.get("type").and_then(Value::as_str) == Some("custom") {
        let custom = object
            .get("custom")
            .and_then(Value::as_object)
            .ok_or_else(|| {
                V3ResponsesRelayRuntimeError::ProviderResponseEventCodec(
                    "OpenAI Chat custom tool_call.custom must be an object before Responses projection"
                        .to_string(),
                )
            })?;
        let name = custom
            .get("name")
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| {
                V3ResponsesRelayRuntimeError::ProviderResponseEventCodec(
                    "OpenAI Chat custom tool name is required before Responses projection"
                        .to_string(),
                )
            })?;
        let Some(client_name) = custom_tool_names.get(name) else {
            return Err(V3ResponsesRelayRuntimeError::ProviderResponseEventCodec(
                "OpenAI Chat custom tool response requires an active governed custom declaration"
                    .to_string(),
            ));
        };
        let input = custom.get("input").and_then(Value::as_str).ok_or_else(|| {
            V3ResponsesRelayRuntimeError::ProviderResponseEventCodec(
                "OpenAI Chat custom tool input must be a string before Responses projection"
                    .to_string(),
            )
        })?;
        return Ok(json!({
            "type":"custom_tool_call",
            "call_id":call_id,
            "name":client_name,
            "input":input
        }));
    }
    let function = object
        .get("function")
        .and_then(Value::as_object)
        .ok_or_else(|| {
            V3ResponsesRelayRuntimeError::ProviderResponseEventCodec(
                "OpenAI Chat tool_call.function must be an object before Responses projection"
                    .to_string(),
            )
        })?;
    let name = function
        .get("name")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| {
            V3ResponsesRelayRuntimeError::ProviderResponseEventCodec(
                "OpenAI Chat tool_call.function.name is required before Responses projection"
                    .to_string(),
            )
        })?;
    let arguments = function
        .get("arguments")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if name == "tool_search" {
        let arguments = parse_v3_openai_chat_tool_call_arguments_object(name, arguments)?;
        return Ok(json!({
            "type":"tool_search_call",
            "call_id":call_id,
            "execution":"client",
            "arguments":arguments
        }));
    }
    if let Some(client_name) = custom_tool_names.get(name) {
        // 请求侧 custom -> function 扁平化后，provider 返回 function tool_call；
        // 按客户端声明的 custom 名归类回 custom_tool_call，保持客户端契约。
        // provider function arguments 必须是我们发出的对象 schema；只把
        // schema 的 input 字段恢复成原始 free-form 字符串，三个治理字段
        // 只在 provider wire 存在，不能泄露到客户端 custom input。
        let input = parse_v3_openai_chat_custom_tool_input(name, arguments)?;
        return Ok(json!({
            "type":"custom_tool_call",
            "call_id":call_id,
            "name":client_name,
            "input":input
        }));
    }
    let mut item = Map::from_iter([
        (
            "type".to_string(),
            Value::String("function_call".to_string()),
        ),
        ("call_id".to_string(), Value::String(call_id.to_string())),
        ("name".to_string(), Value::String(name.to_string())),
        (
            "arguments".to_string(),
            Value::String(arguments.to_string()),
        ),
    ]);
    super::request_outbound_mcp_names::restore_responses_mcp_namespace(&mut item);
    Ok(Value::Object(item))
}

fn parse_v3_openai_chat_custom_tool_input(
    name: &str,
    arguments: &str,
) -> Result<String, V3ResponsesRelayRuntimeError> {
    let parsed = parse_v3_openai_chat_tool_call_arguments_object(name, arguments)?;
    parsed
        .get("input")
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| {
            V3ResponsesRelayRuntimeError::ProviderResponseEventCodec(format!(
                "OpenAI Chat custom tool {name} function arguments must contain string input"
            ))
        })
}

pub(crate) fn parse_v3_openai_chat_tool_call_arguments_object(
    name: &str,
    arguments: &str,
) -> Result<Value, V3ResponsesRelayRuntimeError> {
    let trimmed = arguments.trim();
    let parsed = if trimmed.is_empty() {
        Value::Object(Map::new())
    } else {
        serde_json::from_str::<Value>(trimmed).map_err(|error| {
            V3ResponsesRelayRuntimeError::ProviderResponseEventCodec(format!(
                "OpenAI Chat tool_call {name} arguments must be a JSON object before Responses projection: {error}"
            ))
        })?
    };
    if parsed.is_object() {
        return Ok(parsed);
    }
    Err(V3ResponsesRelayRuntimeError::ProviderResponseEventCodec(
        format!(
            "OpenAI Chat tool_call {name} arguments must be a JSON object before Responses projection"
        ),
    ))
}

pub(crate) fn collect_v3_responses_custom_tool_names(payload: &Value) -> BTreeMap<String, String> {
    let mut names = BTreeMap::new();
    collect_v3_responses_custom_tool_names_from_tools(payload.get("tools"), None, &mut names);
    for item in payload
        .get("input")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        if item.get("type").and_then(Value::as_str) == Some("additional_tools") {
            collect_v3_responses_custom_tool_names_from_tools(item.get("tools"), None, &mut names);
        }
    }
    names
}

pub(crate) fn collect_v3_responses_custom_tool_names_from_tools(
    tools: Option<&Value>,
    qualified_namespace: Option<&str>,
    names: &mut BTreeMap<String, String>,
) {
    for tool in tools.and_then(Value::as_array).into_iter().flatten() {
        match tool.get("type").and_then(Value::as_str) {
            Some("custom") => {
                if let Some(name) = tool
                    .get("name")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                {
                    let provider_name = qualified_namespace
                        .map(|namespace| provider_name_for_namespace_child(namespace, name))
                        .unwrap_or_else(|| name.to_string());
                    names.insert(provider_name, name.to_string());
                }
            }
            Some("namespace") => {
                let Some(namespace) = tool
                    .get("name")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                else {
                    continue;
                };
                let provider_namespace = qualified_namespace
                    .map(|parent| provider_name_for_namespace_child(parent, namespace))
                    .unwrap_or_else(|| namespace.to_string());
                collect_v3_responses_custom_tool_names_from_tools(
                    tool.get("tools"),
                    Some(&provider_namespace),
                    names,
                );
            }
            _ => {}
        }
    }
}

fn provider_name_for_namespace_child(namespace: &str, child: &str) -> String {
    if child == namespace || child.starts_with(&format!("{namespace}__")) {
        child.to_string()
    } else {
        format!("{namespace}__{child}")
    }
}
