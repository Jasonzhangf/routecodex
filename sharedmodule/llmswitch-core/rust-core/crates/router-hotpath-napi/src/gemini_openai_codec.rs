use napi::bindgen_prelude::Result as NapiResult;
use napi_derive::napi;
use serde_json::{Map, Value};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::hub_reasoning_tool_normalizer::{
    build_message_reasoning_value, collect_reasoning_content_segments,
    collect_reasoning_summary_segments, normalize_message_reasoning_ssot,
    project_message_reasoning_text,
};
use crate::hub_req_inbound_context_capture::map_bridge_tools_to_chat;
use crate::shared_chat_output_normalizer::normalize_chat_message_content;

fn parse_value(raw: &str) -> NapiResult<Value> {
    serde_json::from_str(raw).map_err(|e| napi::Error::from_reason(e.to_string()))
}

fn stringify_value(value: &Value) -> NapiResult<String> {
    serde_json::to_string(value).map_err(|e| napi::Error::from_reason(e.to_string()))
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

fn is_object(value: &Value) -> bool {
    value.is_object()
}

fn safe_json_string(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        _ => serde_json::to_string(value).unwrap_or_else(|_| "{}".to_string()),
    }
}

fn flatten_gemini_text_from_parts(value: &Value) -> String {
    match value {
        Value::Array(items) => items
            .iter()
            .map(flatten_gemini_text_from_parts)
            .filter(|entry| !entry.is_empty())
            .collect::<Vec<String>>()
            .join(""),
        Value::Object(row) => {
            if let Some(text) = row.get("text").and_then(Value::as_str) {
                return text.to_string();
            }
            if let Some(parts) = row.get("parts") {
                return flatten_gemini_text_from_parts(parts);
            }
            String::new()
        }
        _ => String::new(),
    }
}

fn flatten_chat_content_text(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Array(items) => items
            .iter()
            .map(flatten_chat_content_text)
            .filter(|entry| !entry.is_empty())
            .collect::<Vec<String>>()
            .join(""),
        Value::Object(row) => {
            if let Some(text) = row.get("text").and_then(Value::as_str) {
                return text.to_string();
            }
            if let Some(text) = row.get("content").and_then(Value::as_str) {
                return text.to_string();
            }
            if let Some(content) = row.get("content") {
                return flatten_chat_content_text(content);
            }
            String::new()
        }
        _ => String::new(),
    }
}

fn stringify_tool_result_response(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Null => String::new(),
        _ => serde_json::to_string(value).unwrap_or_else(|_| value.to_string()),
    }
}

fn fallback_response_id(prefix: &str) -> String {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0);
    format!("{}_{}", prefix, millis)
}

fn parse_positive_i64(value: Option<&Value>) -> Option<i64> {
    let raw = value?;
    if let Some(num) = raw.as_i64() {
        return (num > 0).then_some(num);
    }
    if let Some(num) = raw.as_u64() {
        return i64::try_from(num).ok().filter(|value| *value > 0);
    }
    if let Some(text) = raw.as_str() {
        return text.trim().parse::<i64>().ok().filter(|value| *value > 0);
    }
    None
}

fn map_gemini_role_to_chat(role: Option<&Value>) -> String {
    let normalized = read_trimmed_string(role)
        .unwrap_or_else(|| "user".to_string())
        .to_ascii_lowercase();
    match normalized.as_str() {
        "model" | "assistant" => "assistant".to_string(),
        "system" => "system".to_string(),
        "tool" => "tool".to_string(),
        _ => "user".to_string(),
    }
}

fn map_chat_role_to_gemini(role: Option<&Value>) -> String {
    let normalized = read_trimmed_string(role)
        .unwrap_or_else(|| "user".to_string())
        .to_ascii_lowercase();
    match normalized.as_str() {
        "assistant" => "model".to_string(),
        "system" => "system".to_string(),
        "tool" => "tool".to_string(),
        _ => "user".to_string(),
    }
}

fn coerce_thought_signature(value: Option<&Value>) -> Option<String> {
    read_trimmed_string(value)
}

fn extract_thought_signature_from_tool_call(value: &Value) -> Option<String> {
    let row = value.as_object()?;
    if let Some(sig) = coerce_thought_signature(
        row.get("thought_signature")
            .or_else(|| row.get("thoughtSignature")),
    ) {
        return Some(sig);
    }
    let extra = row
        .get("extra_content")
        .or_else(|| row.get("extraContent"))
        .and_then(Value::as_object)?;
    let google = extra
        .get("google")
        .or_else(|| extra.get("Google"))
        .and_then(Value::as_object)?;
    coerce_thought_signature(
        google
            .get("thought_signature")
            .or_else(|| google.get("thoughtSignature")),
    )
}

fn alias_gemini_tool_name(name: String) -> String {
    if name == "websearch" || name.starts_with("websearch_") {
        return "web_search".to_string();
    }
    name
}

fn parse_function_call_args(value: Option<&Value>) -> Value {
    match value {
        Some(Value::String(text)) => {
            let trimmed = text.trim();
            if trimmed.starts_with('{') {
                match serde_json::from_str::<Value>(text) {
                    Ok(Value::Object(map)) => Value::Object(map),
                    _ => serde_json::json!({ "_raw": text }),
                }
            } else {
                serde_json::json!({ "_raw": text })
            }
        }
        Some(Value::Object(map)) => Value::Object(map.clone()),
        Some(Value::Array(items)) => {
            serde_json::json!({ "_raw": serde_json::to_string(items).unwrap_or_else(|_| "[]".to_string()) })
        }
        Some(Value::Null) | None => Value::Object(Map::new()),
        Some(other) => serde_json::json!({ "_raw": other.to_string() }),
    }
}

fn merge_gemini_metadata(
    metadata: Option<&Value>,
    safety_settings: Option<&Value>,
) -> Option<Value> {
    if metadata.is_none() && safety_settings.is_none() {
        return None;
    }
    let mut root = match metadata {
        Some(Value::Object(map)) => map.clone(),
        _ => Map::new(),
    };

    let mut vendor = root
        .remove("vendor")
        .and_then(|value| value.as_object().cloned())
        .unwrap_or_default();
    let mut gemini = vendor
        .remove("gemini")
        .and_then(|value| value.as_object().cloned())
        .unwrap_or_default();
    if let Some(safety) = safety_settings {
        gemini.insert("safetySettings".to_string(), safety.clone());
    }
    vendor.insert("gemini".to_string(), Value::Object(gemini));
    root.insert("vendor".to_string(), Value::Object(vendor));
    Some(Value::Object(root))
}

fn prepare_gemini_tools(raw_tools: Option<&Value>) -> Vec<Value> {
    let Some(raw_tools_value) = raw_tools else {
        return Vec::new();
    };
    let prepared_raw = match crate::shared_gemini_tool_utils::prepare_gemini_tools_for_bridge_json(
        raw_tools_value.to_string(),
        "[]".to_string(),
    ) {
        Ok(raw) => raw,
        Err(_) => return Vec::new(),
    };
    let prepared = match serde_json::from_str::<Value>(&prepared_raw) {
        Ok(value) => value,
        Err(_) => return Vec::new(),
    };
    let defs = prepared
        .as_object()
        .and_then(|row| row.get("defs"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    map_bridge_tools_to_chat(defs.as_slice())
}

fn resolve_bridge_actions(protocol: &str, stage: &str) -> Option<Vec<Value>> {
    let policy_raw = crate::hub_bridge_policies::resolve_bridge_policy_json(
        serde_json::json!({ "protocol": protocol }).to_string(),
    )
    .ok()?;
    let policy: Value = serde_json::from_str(&policy_raw).ok()?;
    if policy.is_null() {
        return None;
    }
    let actions_raw = crate::hub_bridge_policies::resolve_bridge_policy_actions_json(
        policy.to_string(),
        stage.to_string(),
    )
    .ok()?;
    let actions: Value = serde_json::from_str(&actions_raw).ok()?;
    actions.as_array().cloned()
}

fn run_bridge_pipeline_message(
    stage: &str,
    protocol: &str,
    request_id: Option<String>,
    message: Value,
    raw_response: Option<Value>,
) -> Value {
    let Some(actions) = resolve_bridge_actions(protocol, stage) else {
        return message;
    };
    if actions.is_empty() {
        return message;
    }
    let input = serde_json::json!({
        "stage": stage,
        "actions": actions,
        "protocol": protocol,
        "moduleType": protocol,
        "requestId": request_id,
        "state": {
            "messages": [message.clone()],
            "rawResponse": raw_response
        }
    });
    let Ok(raw) = crate::hub_bridge_actions::run_bridge_action_pipeline_json(input.to_string())
    else {
        return message;
    };
    let Ok(parsed) = serde_json::from_str::<Value>(&raw) else {
        return message;
    };
    parsed
        .as_object()
        .and_then(|row| row.get("messages"))
        .and_then(Value::as_array)
        .and_then(|messages| messages.first())
        .cloned()
        .unwrap_or(message)
}

fn build_provider_protocol_error_value(message: &str, finish_reason: Option<&Value>) -> Value {
    let mut details = Map::new();
    if let Some(raw_finish_reason) = finish_reason {
        details.insert("finishReason".to_string(), raw_finish_reason.clone());
    }
    serde_json::json!({
        "message": message,
        "code": "TOOL_PROTOCOL_ERROR",
        "protocol": "gemini-chat",
        "providerType": "gemini",
        "category": "TOOL_ERROR",
        "details": Value::Object(details),
    })
}

fn build_openai_chat_from_gemini_request_value(payload: &Value) -> Value {
    let body = payload.as_object().cloned().unwrap_or_default();
    let mut messages: Vec<Value> = Vec::new();

    if let Some(system_instruction) = body.get("systemInstruction") {
        let system_text = flatten_gemini_text_from_parts(
            system_instruction
                .as_object()
                .and_then(|row| row.get("parts"))
                .unwrap_or(system_instruction),
        );
        let trimmed = system_text.trim();
        if !trimmed.is_empty() {
            messages.push(serde_json::json!({
                "role": "system",
                "content": trimmed,
            }));
        }
    }

    let contents = body
        .get("contents")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    for content in contents {
        let Some(content_row) = content.as_object() else {
            continue;
        };
        let role = map_gemini_role_to_chat(content_row.get("role"));
        let parts = content_row
            .get("parts")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();

        let mut text_parts: Vec<String> = Vec::new();
        let mut tool_calls: Vec<Value> = Vec::new();
        let mut tool_results: Vec<Value> = Vec::new();

        for part in parts {
            let Some(part_row) = part.as_object() else {
                continue;
            };
            if let Some(text) = part_row.get("text").and_then(Value::as_str) {
                if !text.trim().is_empty() {
                    text_parts.push(text.to_string());
                }
                continue;
            }
            if let Some(function_call) = part_row.get("functionCall").and_then(Value::as_object) {
                let Some(name) = read_trimmed_string(function_call.get("name")) else {
                    continue;
                };
                let id = read_trimmed_string(function_call.get("id"));
                let args = safe_json_string(
                    function_call
                        .get("args")
                        .or_else(|| function_call.get("arguments"))
                        .unwrap_or(&Value::Object(Map::new())),
                );
                tool_calls.push(serde_json::json!({
                    "id": id,
                    "type": "function",
                    "function": {
                        "name": name,
                        "arguments": args,
                    }
                }));
                continue;
            }
            if let Some(function_response) =
                part_row.get("functionResponse").and_then(Value::as_object)
            {
                let call_id = read_trimmed_string(function_response.get("id"));
                let content = stringify_tool_result_response(
                    function_response.get("response").unwrap_or(&Value::Null),
                );
                tool_results.push(serde_json::json!({
                    "role": "tool",
                    "tool_call_id": call_id,
                    "content": content,
                }));
            }
        }

        let combined_text = text_parts.join("\n");
        let normalized = if combined_text.is_empty() {
            crate::shared_chat_output_normalizer::NormalizeChatMessageContentOutput {
                content_text: None,
                reasoning_text: None,
            }
        } else {
            normalize_chat_message_content(&Value::String(combined_text.clone()))
        };
        let mut reasoning_chunks: Vec<String> = Vec::new();
        if let Some(reasoning) = normalized
            .reasoning_text
            .clone()
            .filter(|text| !text.trim().is_empty())
        {
            reasoning_chunks.push(reasoning);
        }
        let has_text = normalized
            .content_text
            .as_ref()
            .map(|text| !text.is_empty())
            .unwrap_or(false);
        if has_text || !tool_calls.is_empty() || !reasoning_chunks.is_empty() {
            let mut message = Map::new();
            message.insert("role".to_string(), Value::String(role));
            message.insert(
                "content".to_string(),
                Value::String(normalized.content_text.unwrap_or(combined_text)),
            );
            if !reasoning_chunks.is_empty() {
                message.insert(
                    "reasoning_content".to_string(),
                    Value::String(reasoning_chunks.join("\n")),
                );
            }
            if !tool_calls.is_empty() {
                message.insert("tool_calls".to_string(), Value::Array(tool_calls));
            }
            messages.push(Value::Object(message));
        }

        messages.extend(tool_results);
    }

    let mut request = Map::new();
    request.insert(
        "model".to_string(),
        body.get("model")
            .cloned()
            .unwrap_or_else(|| Value::String("unknown".to_string())),
    );
    request.insert("messages".to_string(), Value::Array(messages));

    let mapped_tools = prepare_gemini_tools(body.get("tools"));
    if !mapped_tools.is_empty() {
        request.insert("tools".to_string(), Value::Array(mapped_tools));
    }

    if let Some(generation_config) = body.get("generationConfig").and_then(Value::as_object) {
        if let Some(max_tokens) = generation_config
            .get("maxOutputTokens")
            .or_else(|| generation_config.get("max_output_tokens"))
        {
            if let Some(value) = parse_positive_i64(Some(max_tokens)) {
                request.insert(
                    "max_tokens".to_string(),
                    Value::Number(serde_json::Number::from(value)),
                );
            }
        }
        if let Some(temperature) = generation_config.get("temperature") {
            request.insert("temperature".to_string(), temperature.clone());
        }
        if let Some(top_p) = generation_config.get("topP") {
            request.insert("top_p".to_string(), top_p.clone());
        }
        if let Some(stop_sequences) = generation_config.get("stopSequences") {
            match stop_sequences {
                Value::String(text) if !text.trim().is_empty() => {
                    request.insert(
                        "stop".to_string(),
                        Value::Array(vec![Value::String(text.trim().to_string())]),
                    );
                }
                Value::Array(items) if !items.is_empty() => {
                    let stop = items
                        .iter()
                        .filter_map(|item| match item {
                            Value::String(text) if !text.trim().is_empty() => {
                                Some(Value::String(text.trim().to_string()))
                            }
                            _ => None,
                        })
                        .collect::<Vec<Value>>();
                    if !stop.is_empty() {
                        request.insert("stop".to_string(), Value::Array(stop));
                    }
                }
                _ => {}
            }
        }
    }

    if let Some(metadata) = merge_gemini_metadata(body.get("metadata"), body.get("safetySettings"))
    {
        request.insert("metadata".to_string(), metadata);
    }

    Value::Object(request)
}

fn build_openai_chat_from_gemini_response_value(payload: &Value) -> Value {
    let body = payload.as_object().cloned().unwrap_or_default();
    let candidates = body
        .get("candidates")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let primary = candidates
        .first()
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let content = primary
        .get("content")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let role = if candidates.is_empty() {
        "assistant".to_string()
    } else {
        map_gemini_role_to_chat(content.get("role"))
    };
    let raw_finish_reason = primary.get("finishReason").cloned();
    let finish_reason_upper = read_trimmed_string(primary.get("finishReason"))
        .unwrap_or_default()
        .to_ascii_uppercase();
    let parts = content
        .get("parts")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();

    let mut text_parts: Vec<String> = Vec::new();
    let mut reasoning_parts: Vec<String> = Vec::new();
    let mut tool_calls: Vec<Value> = Vec::new();
    let mut tool_result_texts: Vec<String> = Vec::new();
    let mut tool_outputs: Vec<Value> = Vec::new();
    let mut tool_call_counter = 0;

    for part in parts {
        let Some(part_row) = part.as_object() else {
            continue;
        };
        if let Some(text) = part_row.get("text").and_then(Value::as_str) {
            if !text.trim().is_empty() {
                text_parts.push(text.to_string());
            }
            continue;
        }
        if let Some(content_items) = part_row.get("content").and_then(Value::as_array) {
            for inner in content_items {
                match inner {
                    Value::String(text) => text_parts.push(text.to_string()),
                    Value::Object(row) => {
                        if let Some(text) = row.get("text").and_then(Value::as_str) {
                            text_parts.push(text.to_string());
                        }
                    }
                    _ => {}
                }
            }
            continue;
        }
        if let Some(reasoning) = part_row.get("reasoning").and_then(Value::as_str) {
            reasoning_parts.push(reasoning.to_string());
            continue;
        }
        if let Some(thought) = part_row.get("thought").and_then(Value::as_str) {
            let trimmed = thought.trim();
            if !trimmed.is_empty() {
                reasoning_parts.push(trimmed.to_string());
            }
            continue;
        }
        if let Some(function_call) = part_row.get("functionCall").and_then(Value::as_object) {
            let Some(raw_name) = read_trimmed_string(function_call.get("name")) else {
                continue;
            };
            let name = alias_gemini_tool_name(raw_name);
            let mut id = read_trimmed_string(function_call.get("id"));
            let args = safe_json_string(
                function_call
                    .get("args")
                    .or_else(|| function_call.get("arguments"))
                    .unwrap_or(&Value::Object(Map::new())),
            );
            let thought_signature = coerce_thought_signature(part_row.get("thoughtSignature"));
            if id.is_none() {
                id = Some(format!("gemini_tool_{}", tool_call_counter));
                tool_call_counter += 1;
            }
            let mut tool_call = Map::new();
            if let Some(id_value) = id {
                tool_call.insert("id".to_string(), Value::String(id_value));
            }
            tool_call.insert("type".to_string(), Value::String("function".to_string()));
            tool_call.insert(
                "function".to_string(),
                serde_json::json!({
                    "name": name,
                    "arguments": args,
                }),
            );
            if let Some(signature) = thought_signature {
                tool_call.insert(
                    "thought_signature".to_string(),
                    Value::String(signature.clone()),
                );
                tool_call.insert(
                    "extra_content".to_string(),
                    serde_json::json!({
                        "google": {
                            "thought_signature": signature,
                        }
                    }),
                );
            }
            tool_calls.push(Value::Object(tool_call));
            continue;
        }
        if let Some(function_response) = part_row.get("functionResponse").and_then(Value::as_object)
        {
            let call_id = read_trimmed_string(function_response.get("id"));
            let name =
                read_trimmed_string(function_response.get("name")).map(alias_gemini_tool_name);
            let content_str = stringify_tool_result_response(
                function_response.get("response").unwrap_or(&Value::Null),
            );
            if !content_str.trim().is_empty() {
                tool_result_texts.push(content_str.clone());
                if call_id.is_some() || name.is_some() {
                    let mut entry = Map::new();
                    if let Some(call_id_value) = call_id.clone() {
                        entry.insert(
                            "tool_call_id".to_string(),
                            Value::String(call_id_value.clone()),
                        );
                        entry.insert("id".to_string(), Value::String(call_id_value));
                    }
                    entry.insert("content".to_string(), Value::String(content_str));
                    if let Some(name_value) = name {
                        entry.insert("name".to_string(), Value::String(name_value));
                    }
                    tool_outputs.push(Value::Object(entry));
                }
            }
            continue;
        }
        if let Some(executable_code) = part_row.get("executableCode").and_then(Value::as_object) {
            let language = read_trimmed_string(executable_code.get("language"))
                .unwrap_or_else(|| "python".to_string());
            let code_text = read_trimmed_string(executable_code.get("code")).unwrap_or_default();
            if !code_text.is_empty() {
                text_parts.push(format!("```{}\n{}\n```", language, code_text));
            }
            continue;
        }
        if let Some(code_result) = part_row
            .get("codeExecutionResult")
            .and_then(Value::as_object)
        {
            let outcome = read_trimmed_string(code_result.get("outcome")).unwrap_or_default();
            let output = read_trimmed_string(code_result.get("output")).unwrap_or_default();
            if !output.is_empty() {
                let prefix = if outcome.is_empty() {
                    "[Code Output]:".to_string()
                } else {
                    format!("[Code Output ({})]:", outcome)
                };
                text_parts.push(format!("{}\n{}", prefix, output));
            }
        }
    }

    let has_tool_calls = !tool_calls.is_empty();
    if !has_tool_calls && finish_reason_upper == "UNEXPECTED_TOOL_CALL" {
        return serde_json::json!({
            "__providerProtocolError": build_provider_protocol_error_value(
                "Gemini returned finishReason=UNEXPECTED_TOOL_CALL; this usually indicates an incompatible or unexpected tool invocation.",
                raw_finish_reason.as_ref(),
            )
        });
    }

    let finish_reason = if has_tool_calls {
        "tool_calls".to_string()
    } else {
        match finish_reason_upper.as_str() {
            "MAX_TOKENS" => "length".to_string(),
            "SAFETY" => "content_filter".to_string(),
            _ => "stop".to_string(),
        }
    };

    let usage_meta = body
        .get("usageMetadata")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let mut usage = Map::new();
    if let Some(value) = usage_meta.get("promptTokenCount") {
        usage.insert("prompt_tokens".to_string(), value.clone());
    }
    if let Some(value) = usage_meta.get("candidatesTokenCount") {
        usage.insert("completion_tokens".to_string(), value.clone());
    }
    if let Some(value) = usage_meta.get("totalTokenCount") {
        usage.insert("total_tokens".to_string(), value.clone());
    }

    let combined_text = text_parts.join("\n");
    let normalized = if combined_text.is_empty() {
        crate::shared_chat_output_normalizer::NormalizeChatMessageContentOutput {
            content_text: None,
            reasoning_text: None,
        }
    } else {
        normalize_chat_message_content(&Value::String(combined_text.clone()))
    };
    if let Some(reasoning) = normalized
        .reasoning_text
        .clone()
        .filter(|text| !text.trim().is_empty())
    {
        reasoning_parts.push(reasoning);
    }
    let base_content = normalized.content_text.unwrap_or(combined_text);
    let tool_result_block = tool_result_texts.join("\n");
    let final_content = if !tool_result_block.is_empty() && !base_content.is_empty() {
        format!("{}\n{}", base_content, tool_result_block)
    } else if !base_content.is_empty() {
        base_content
    } else {
        tool_result_block
    };

    let mut chat_message = Map::new();
    chat_message.insert("role".to_string(), Value::String(role));
    chat_message.insert("content".to_string(), Value::String(final_content));
    if let Some(reasoning_payload) = build_message_reasoning_value(&[], &reasoning_parts, None) {
        if let Some(text) = project_message_reasoning_text(&reasoning_payload) {
            chat_message.insert("reasoning_content".to_string(), Value::String(text));
        }
        chat_message.insert("reasoning".to_string(), reasoning_payload);
    }
    if !tool_calls.is_empty() {
        chat_message.insert("tool_calls".to_string(), Value::Array(tool_calls));
    }
    normalize_message_reasoning_ssot(&mut chat_message);

    let response_id =
        read_trimmed_string(body.get("id")).unwrap_or_else(|| fallback_response_id("chatcmpl"));
    let piped_message = run_bridge_pipeline_message(
        "response_inbound",
        "gemini-chat",
        Some(response_id.clone()),
        Value::Object(chat_message),
        Some(payload.clone()),
    );

    let mut chat_response = Map::new();
    chat_response.insert("id".to_string(), Value::String(response_id));
    chat_response.insert(
        "object".to_string(),
        Value::String("chat.completion".to_string()),
    );
    chat_response.insert(
        "model".to_string(),
        body.get("model")
            .cloned()
            .unwrap_or_else(|| Value::String("unknown".to_string())),
    );
    chat_response.insert(
        "choices".to_string(),
        Value::Array(vec![serde_json::json!({
            "index": 0,
            "finish_reason": finish_reason,
            "message": piped_message,
        })]),
    );
    if let Some(error_node) = body.get("error").filter(|value| is_object(value)) {
        chat_response.insert("error".to_string(), error_node.clone());
    }
    if !usage.is_empty() {
        chat_response.insert("usage".to_string(), Value::Object(usage));
    }
    if !tool_outputs.is_empty() {
        chat_response.insert("tool_outputs".to_string(), Value::Array(tool_outputs));
    }
    Value::Object(chat_response)
}

fn build_gemini_from_openai_chat_value(chat_response: &Value) -> Value {
    let body = chat_response.as_object().cloned().unwrap_or_default();
    let choices = body
        .get("choices")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let primary = choices
        .first()
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let message = primary
        .get("message")
        .cloned()
        .unwrap_or_else(|| Value::Object(Map::new()));
    let usage = body
        .get("usage")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();

    let finish_reason = match read_trimmed_string(primary.get("finish_reason"))
        .unwrap_or_else(|| "stop".to_string())
        .to_ascii_lowercase()
        .as_str()
    {
        "length" => "MAX_TOKENS".to_string(),
        "content_filter" => "OTHER".to_string(),
        _ => "STOP".to_string(),
    };

    let response_id =
        read_trimmed_string(body.get("id")).unwrap_or_else(|| fallback_response_id("chatcmpl"));
    let normalized_message = run_bridge_pipeline_message(
        "response_outbound",
        "gemini-chat",
        Some(response_id.clone()),
        message.clone(),
        None,
    );
    let mut msg_row = normalized_message.as_object().cloned().unwrap_or_default();
    normalize_message_reasoning_ssot(&mut msg_row);
    let base_role = map_chat_role_to_gemini(msg_row.get("role"));

    let mut parts: Vec<Value> = Vec::new();
    let content_text = flatten_chat_content_text(msg_row.get("content").unwrap_or(&Value::Null));
    if !content_text.is_empty() {
        parts.push(serde_json::json!({ "text": content_text }));
    }

    let reasoning_content = collect_reasoning_content_segments(msg_row.get("reasoning"))
        .into_iter()
        .collect::<Vec<String>>();
    let reasoning_summary = collect_reasoning_summary_segments(msg_row.get("reasoning"))
        .into_iter()
        .collect::<Vec<String>>();
    let reasoning_parts = if !reasoning_content.is_empty() {
        reasoning_content
    } else if !reasoning_summary.is_empty() {
        reasoning_summary
    } else {
        read_trimmed_string(msg_row.get("reasoning_content"))
            .into_iter()
            .collect::<Vec<String>>()
    };
    for reasoning in reasoning_parts {
        parts.push(serde_json::json!({ "reasoning": reasoning }));
    }

    let tool_calls = msg_row
        .get("tool_calls")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    for tool_call in tool_calls {
        let Some(tool_call_row) = tool_call.as_object() else {
            continue;
        };
        let function_row = tool_call_row
            .get("function")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        let Some(name) = read_trimmed_string(function_row.get("name")) else {
            continue;
        };
        let args = parse_function_call_args(function_row.get("arguments"));
        let mut function_call = Map::new();
        function_call.insert("name".to_string(), Value::String(name));
        function_call.insert("args".to_string(), args);
        if let Some(id) = read_trimmed_string(tool_call_row.get("id")) {
            function_call.insert("id".to_string(), Value::String(id));
        }
        let mut part = Map::new();
        part.insert("functionCall".to_string(), Value::Object(function_call));
        if let Some(signature) = extract_thought_signature_from_tool_call(&tool_call) {
            part.insert("thoughtSignature".to_string(), Value::String(signature));
        }
        parts.push(Value::Object(part));
    }

    let candidate = serde_json::json!({
        "content": {
            "role": base_role,
            "parts": parts,
        },
        "finishReason": finish_reason,
    });

    let mut usage_metadata = Map::new();
    if let Some(prompt_tokens) = usage
        .get("prompt_tokens")
        .or_else(|| usage.get("input_tokens"))
    {
        usage_metadata.insert("promptTokenCount".to_string(), prompt_tokens.clone());
    }
    if let Some(completion_tokens) = usage
        .get("completion_tokens")
        .or_else(|| usage.get("output_tokens"))
    {
        usage_metadata.insert(
            "candidatesTokenCount".to_string(),
            completion_tokens.clone(),
        );
    }
    if let Some(total_tokens) = usage.get("total_tokens") {
        usage_metadata.insert("totalTokenCount".to_string(), total_tokens.clone());
    }

    let mut out = Map::new();
    out.insert("id".to_string(), Value::String(response_id));
    out.insert("candidates".to_string(), Value::Array(vec![candidate]));
    if let Some(model) = body.get("model") {
        out.insert("model".to_string(), model.clone());
    }
    if !usage_metadata.is_empty() {
        out.insert("usageMetadata".to_string(), Value::Object(usage_metadata));
    }
    Value::Object(out)
}

#[napi(js_name = "runGeminiOpenaiRequestCodecJson")]
pub fn run_gemini_openai_request_codec_json(
    payload_json: String,
    _options_json: Option<String>,
) -> NapiResult<String> {
    let payload = parse_value(&payload_json)?;
    stringify_value(&build_openai_chat_from_gemini_request_value(&payload))
}

#[napi(js_name = "runGeminiOpenaiResponseCodecJson")]
pub fn run_gemini_openai_response_codec_json(
    payload_json: String,
    _options_json: Option<String>,
) -> NapiResult<String> {
    let payload = parse_value(&payload_json)?;
    stringify_value(&build_openai_chat_from_gemini_response_value(&payload))
}

#[napi(js_name = "runGeminiFromOpenaiChatCodecJson")]
pub fn run_gemini_from_openai_chat_codec_json(
    payload_json: String,
    _options_json: Option<String>,
) -> NapiResult<String> {
    let payload = parse_value(&payload_json)?;
    stringify_value(&build_gemini_from_openai_chat_value(&payload))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn gemini_openai_codec_request_maps_messages_tools_and_generation_config() {
        let raw = run_gemini_openai_request_codec_json(
            json!({
                "model": "gemini-2.5-pro",
                "systemInstruction": { "parts": [{ "text": "System prompt" }] },
                "contents": [
                    {
                        "role": "user",
                        "parts": [
                            { "text": "run pwd" },
                            {
                                "functionCall": {
                                    "name": "exec_command",
                                    "id": "call_req",
                                    "args": { "cmd": "pwd" }
                                }
                            }
                        ]
                    },
                    {
                        "role": "tool",
                        "parts": [
                            {
                                "functionResponse": {
                                    "id": "call_req",
                                    "response": { "cwd": "/tmp" }
                                }
                            }
                        ]
                    }
                ],
                "tools": [
                    {
                        "functionDeclarations": [
                            {
                                "name": "exec_command",
                                "description": "Run shell command",
                                "parameters": {
                                    "type": "object",
                                    "properties": { "cmd": { "type": "string" } },
                                    "required": ["cmd"]
                                }
                            }
                        ]
                    }
                ],
                "generationConfig": {
                    "maxOutputTokens": 256,
                    "temperature": 0.2,
                    "topP": 0.8,
                    "stopSequences": ["DONE"]
                },
                "metadata": { "trace": "abc" },
                "safetySettings": [{ "category": "HARM_CATEGORY_HATE_SPEECH" }]
            })
            .to_string(),
            None,
        )
        .unwrap();

        let value: Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(value["model"], "gemini-2.5-pro");
        assert_eq!(
            value["messages"][0],
            json!({ "role": "system", "content": "System prompt" })
        );
        assert_eq!(value["messages"][1]["tool_calls"][0]["id"], "call_req");
        assert_eq!(value["messages"][2]["role"], "tool");
        assert_eq!(value["messages"][2]["content"], "{\"cwd\":\"/tmp\"}");
        assert_eq!(value["tools"][0]["function"]["name"], "exec_command");
        assert_eq!(value["max_tokens"], 256);
        assert_eq!(value["temperature"], json!(0.2));
        assert_eq!(value["top_p"], json!(0.8));
        assert_eq!(value["stop"], json!(["DONE"]));
        assert_eq!(value["metadata"]["trace"], "abc");
        assert_eq!(
            value["metadata"]["vendor"]["gemini"]["safetySettings"][0]["category"],
            "HARM_CATEGORY_HATE_SPEECH"
        );
    }

    #[test]
    fn gemini_openai_codec_response_maps_tool_calls_usage_and_reasoning() {
        let raw = run_gemini_openai_response_codec_json(
            json!({
                "id": "gem_resp_1",
                "model": "gemini-2.5-pro",
                "usageMetadata": {
                    "promptTokenCount": 10,
                    "candidatesTokenCount": 4,
                    "totalTokenCount": 14
                },
                "candidates": [
                    {
                        "finishReason": "STOP",
                        "content": {
                            "role": "model",
                            "parts": [
                                { "thought": "Need shell output" },
                                { "text": "Running command" },
                                {
                                    "functionCall": {
                                        "name": "websearch",
                                        "args": { "query": "pwd" }
                                    },
                                    "thoughtSignature": "sig_1"
                                },
                                {
                                    "functionResponse": {
                                        "id": "call_tool",
                                        "name": "websearch",
                                        "response": { "ok": true }
                                    }
                                }
                            ]
                        }
                    }
                ]
            })
            .to_string(),
            None,
        )
        .unwrap();

        let value: Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(value["id"], "gem_resp_1");
        assert_eq!(value["choices"][0]["finish_reason"], "tool_calls");
        assert_eq!(value["choices"][0]["message"]["role"], "assistant");
        assert_eq!(
            value["choices"][0]["message"]["tool_calls"][0]["function"]["name"],
            "web_search"
        );
        assert_eq!(
            value["choices"][0]["message"]["tool_calls"][0]["thought_signature"],
            "sig_1"
        );
        assert_eq!(value["tool_outputs"][0]["name"], "web_search");
        assert_eq!(value["usage"]["prompt_tokens"], 10);
        assert_eq!(
            value["choices"][0]["message"]["reasoning"]["content"][0]["text"],
            "Need shell output"
        );
    }

    #[test]
    fn gemini_openai_codec_outbound_maps_chat_response_back_to_gemini() {
        let raw = run_gemini_from_openai_chat_codec_json(
            json!({
                "id": "chatcmpl_1",
                "model": "gpt-4.1",
                "choices": [
                    {
                        "finish_reason": "tool_calls",
                        "message": {
                            "role": "assistant",
                            "content": "Run tool",
                            "reasoning": {
                                "summary": [{ "type": "summary_text", "text": "Need cwd summary" }],
                                "content": [{ "type": "reasoning_text", "text": "Need cwd" }]
                            },
                            "tool_calls": [
                                {
                                    "id": "call_out",
                                    "type": "function",
                                    "function": {
                                        "name": "exec_command",
                                        "arguments": "{\"cmd\":\"pwd\"}"
                                    },
                                    "extra_content": {
                                        "google": { "thought_signature": "sig_out" }
                                    }
                                }
                            ]
                        }
                    }
                ],
                "usage": {
                    "prompt_tokens": 12,
                    "completion_tokens": 7,
                    "total_tokens": 19
                }
            })
            .to_string(),
            None,
        )
        .unwrap();

        let value: Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(value["id"], "chatcmpl_1");
        assert_eq!(value["candidates"][0]["finishReason"], "STOP");
        assert_eq!(value["candidates"][0]["content"]["role"], "model");
        assert_eq!(
            value["candidates"][0]["content"]["parts"][0]["text"],
            "Run tool"
        );
        assert_eq!(
            value["candidates"][0]["content"]["parts"][1]["reasoning"],
            "Need cwd"
        );
        assert_eq!(
            value["candidates"][0]["content"]["parts"][2]["functionCall"]["name"],
            "exec_command"
        );
        assert_eq!(
            value["candidates"][0]["content"]["parts"][2]["functionCall"]["args"],
            json!({ "cmd": "pwd" })
        );
        assert_eq!(
            value["candidates"][0]["content"]["parts"][2]["thoughtSignature"],
            "sig_out"
        );
        assert_eq!(value["usageMetadata"]["promptTokenCount"], 12);
        assert_eq!(value["usageMetadata"]["candidatesTokenCount"], 7);
        assert_eq!(value["usageMetadata"]["totalTokenCount"], 19);
    }
}
