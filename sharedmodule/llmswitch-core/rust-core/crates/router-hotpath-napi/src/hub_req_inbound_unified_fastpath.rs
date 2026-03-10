use napi_derive::napi;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::time::Instant;

const MAX_PAYLOAD_SIZE_BYTES: usize = 50 * 1024 * 1024;

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UnifiedInboundInput {
    pub raw_request: Value,
    pub protocol: String,
    pub adapter_context: Value,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UnifiedInboundOutput {
    pub format_envelope: Value,
    pub standardized_request: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timing: Option<TimingInfo>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimingInfo {
    pub stage1_parse_ms: u64,
    pub stage2_semantic_map_ms: u64,
    pub stage2_to_standardized_ms: u64,
    pub total_ms: u64,
}

fn validate_payload_size_fast(raw_request: &Value) -> Result<(), String> {
    if let Some(obj) = raw_request.as_object() {
        let estimated_size = obj.len() * 100;
        if estimated_size > MAX_PAYLOAD_SIZE_BYTES {
            return Err(format!(
                "Payload size estimate {} exceeds maximum allowed {} bytes",
                estimated_size, MAX_PAYLOAD_SIZE_BYTES
            ));
        }
    }
    Ok(())
}

fn normalize_protocol_token_fast(raw_protocol: &str, payload: &Value) -> String {
    let normalized = raw_protocol.trim().to_ascii_lowercase();
    match normalized.as_str() {
        "openai-chat" | "chat" => "openai-chat".to_string(),
        "openai-responses" | "responses" => "openai-responses".to_string(),
        "anthropic-messages" | "anthropic" | "messages" => "anthropic-messages".to_string(),
        "gemini-chat" | "gemini" => "gemini-chat".to_string(),
        _ => {
            if payload.get("contents").is_some() {
                "gemini-chat".to_string()
            } else if payload.get("input").is_some() {
                "openai-responses".to_string()
            } else if payload.get("messages").is_some() {
                "openai-chat".to_string()
            } else {
                "openai-chat".to_string()
            }
        }
    }
}

fn normalize_reasoning_in_payload_fast(payload: &mut Value) {
    if let Some(obj) = payload.as_object_mut() {
        if let Some(messages) = obj.get_mut("messages").and_then(|m| m.as_array_mut()) {
            for msg in messages.iter_mut() {
                if let Some(msg_obj) = msg.as_object_mut() {
                    if let Some(content) = msg_obj.get("content") {
                        if content.is_string() || content.is_array() {
                            continue;
                        }
                    }
                }
            }
        }
    }
}

fn parse_format_envelope_fast(raw_request: Value, protocol: &str) -> Result<Value, String> {
    if !raw_request.is_object() {
        return Err("Request payload must be an object".to_string());
    }
    validate_payload_size_fast(&raw_request)?;
    
    let normalized_protocol = normalize_protocol_token_fast(protocol, &raw_request);
    
    let model = raw_request
        .get("model")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    
    let envelope = serde_json::json!({
        "format": normalized_protocol,
        "version": "v1",
        "payload": raw_request,
        "metadata": if model.is_empty() {
            Value::Null
        } else {
            serde_json::json!({
                "model": model,
                "extracted_at": "unified_fastpath"
            })
        }
    });
    
    Ok(envelope)
}

fn map_to_chat_envelope_fast(format_envelope: &Value) -> Result<Value, String> {
    let payload = format_envelope
        .get("payload")
        .ok_or("Missing payload in format envelope")?;
    
    let model = payload
        .get("model")
        .and_then(|v| v.as_str())
        .unwrap_or("unknown")
        .to_string();
    
    let messages = payload
        .get("messages")
        .cloned()
        .unwrap_or(serde_json::json!([]));
    
    let tools = payload.get("tools").cloned();
    let parameters = payload.get("parameters").cloned().unwrap_or(serde_json::json!({}));
    
    let chat_envelope = serde_json::json!({
        "model": model,
        "messages": messages,
        "tools": tools,
        "parameters": parameters,
        "metadata": format_envelope.get("metadata").cloned().unwrap_or(Value::Null),
        "semantics": Value::Null
    });
    
    Ok(chat_envelope)
}

fn chat_envelope_to_standardized_fast(chat_envelope: &Value, adapter_context: &Value) -> Result<Value, String> {
    let model = chat_envelope
        .get("model")
        .and_then(|v| v.as_str())
        .unwrap_or("unknown")
        .to_string();
    
    let messages = chat_envelope
        .get("messages")
        .cloned()
        .unwrap_or(serde_json::json!([]));
    
    let tools = chat_envelope.get("tools").cloned();
    let parameters = chat_envelope.get("parameters").cloned().unwrap_or(serde_json::json!({}));
    let metadata = chat_envelope.get("metadata").cloned();
    let semantics = chat_envelope.get("semantics").cloned();
    
    let request_id = adapter_context
        .get("requestId")
        .and_then(|v| v.as_str())
        .unwrap_or("unknown");
    
    let entry_endpoint = adapter_context
        .get("entryEndpoint")
        .and_then(|v| v.as_str())
        .unwrap_or("/v1/chat/completions");
    
    let standardized = serde_json::json!({
        "model": model,
        "messages": messages,
        "tools": tools,
        "parameters": parameters,
        "metadata": {
            "requestId": request_id,
            "entryEndpoint": entry_endpoint,
            "originalMetadata": metadata,
        },
        "semantics": semantics,
    });
    
    Ok(standardized)
}

pub fn process_unified_inbound_fast(input: UnifiedInboundInput) -> Result<UnifiedInboundOutput, String> {
    let total_start = Instant::now();
    
    let mut raw_request = input.raw_request;
    let protocol = input.protocol;
    let adapter_context = input.adapter_context;
    
    let stage1_start = Instant::now();
    normalize_reasoning_in_payload_fast(&mut raw_request);
    let format_envelope = parse_format_envelope_fast(raw_request, &protocol)?;
    let stage1_ms = stage1_start.elapsed().as_millis() as u64;
    
    let stage2_map_start = Instant::now();
    let chat_envelope = map_to_chat_envelope_fast(&format_envelope)?;
    let stage2_map_ms = stage2_map_start.elapsed().as_millis() as u64;
    
    let stage2_std_start = Instant::now();
    let standardized_request = chat_envelope_to_standardized_fast(&chat_envelope, &adapter_context)?;
    let stage2_std_ms = stage2_std_start.elapsed().as_millis() as u64;
    
    let total_ms = total_start.elapsed().as_millis() as u64;
    
    Ok(UnifiedInboundOutput {
        format_envelope,
        standardized_request,
        timing: Some(TimingInfo {
            stage1_parse_ms: stage1_ms,
            stage2_semantic_map_ms: stage2_map_ms,
            stage2_to_standardized_ms: stage2_std_ms,
            total_ms,
        }),
    })
}

#[napi]
pub fn process_unified_inbound_fast_json(input_json: String) -> napi::Result<String> {
    if input_json.trim().is_empty() {
        return Err(napi::Error::from_reason("Input JSON cannot be empty"));
    }

    let input: UnifiedInboundInput = serde_json::from_str(&input_json)
        .map_err(|e| napi::Error::from_reason(format!("Failed to parse input JSON: {}", e)))?;

    let output = process_unified_inbound_fast(input)
        .map_err(|e| napi::Error::from_reason(format!("Processing failed: {}", e)))?;

    serde_json::to_string(&output)
        .map_err(|e| napi::Error::from_reason(format!("Failed to serialize output: {}", e)))
}
