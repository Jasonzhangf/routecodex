use crate::hub_standardized_bridge::normalize_chat_envelope_tool_calls;
use napi_derive::napi;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::time::Instant;

const MAX_PAYLOAD_SIZE_BYTES: usize = 50 * 1024 * 1024;

const DEFAULT_HEAVY_INPUT_TOKEN_THRESHOLD: i64 = 120_000;

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

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HeavyInputFastpathDecisionInput {
    pub request: Value,
    #[serde(default)]
    pub metadata: Value,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HeavyInputFastpathDecisionOutput {
    pub estimated_tokens: i64,
    pub should_mark: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

fn parse_bool_env(name: &str) -> Option<bool> {
    match std::env::var(name) {
        Ok(raw) => {
            let normalized = raw.trim().to_ascii_lowercase();
            if matches!(normalized.as_str(), "1" | "true" | "yes" | "on") {
                Some(true)
            } else if matches!(normalized.as_str(), "0" | "false" | "no" | "off") {
                Some(false)
            } else {
                None
            }
        }
        Err(_) => None,
    }
}

fn parse_positive_i64_env(name: &str) -> Option<i64> {
    std::env::var(name)
        .ok()
        .and_then(|raw| raw.trim().parse::<i64>().ok())
        .filter(|v| *v > 0)
}

fn is_heavy_input_fastpath_enabled() -> bool {
    parse_bool_env("ROUTECODEX_HUB_FASTPATH_HEAVY_INPUT")
        .or_else(|| parse_bool_env("RCC_HUB_FASTPATH_HEAVY_INPUT"))
        .unwrap_or(true)
}

fn resolve_heavy_input_threshold() -> i64 {
    parse_positive_i64_env("ROUTECODEX_HUB_FASTPATH_INPUT_TOKEN_THRESHOLD")
        .or_else(|| parse_positive_i64_env("RCC_HUB_FASTPATH_INPUT_TOKEN_THRESHOLD"))
        .unwrap_or(DEFAULT_HEAVY_INPUT_TOKEN_THRESHOLD)
}

fn estimate_text_tokens(value: &Value) -> i64 {
    match value {
        Value::String(s) => ((s.len() as f64) / 4.0).ceil() as i64,
        Value::Array(arr) => arr.iter().map(estimate_text_tokens).sum(),
        Value::Object(obj) => {
            if let Some(Value::String(text)) = obj.get("text") {
                return ((text.len() as f64) / 4.0).ceil() as i64;
            }
            if let Some(Value::String(content)) = obj.get("content") {
                return ((content.len() as f64) / 4.0).ceil() as i64;
            }
            obj.values().map(estimate_text_tokens).sum()
        }
        _ => 0,
    }
}

fn rough_estimate_input_tokens_from_request(request: &Value) -> i64 {
    let Some(obj) = request.as_object() else {
        return 0;
    };
    let mut total = 0;
    if let Some(messages) = obj.get("messages") {
        total += estimate_text_tokens(messages);
    }
    if let Some(input) = obj.get("input") {
        total += estimate_text_tokens(input);
    }
    if let Some(instructions) = obj.get("instructions") {
        total += estimate_text_tokens(instructions);
    }
    if total <= 0 {
        total += estimate_text_tokens(request);
    }
    total.max(0)
}

fn read_estimated_tokens_from_metadata(metadata: &Value) -> Option<i64> {
    let obj = metadata.as_object()?;
    for key in ["estimatedInputTokens", "estimatedTokens", "estimated_tokens"] {
        if let Some(v) = obj.get(key).and_then(|x| x.as_f64()) {
            if v.is_finite() && v > 0.0 {
                return Some(v.floor() as i64);
            }
        }
    }
    None
}

pub fn decide_heavy_input_fastpath(
    input: HeavyInputFastpathDecisionInput,
) -> HeavyInputFastpathDecisionOutput {
    let estimated_tokens = rough_estimate_input_tokens_from_request(&input.request).max(0);
    let threshold = resolve_heavy_input_threshold();
    let enabled = is_heavy_input_fastpath_enabled() && threshold > 0;
    let should_mark = enabled && estimated_tokens >= threshold;

    if should_mark {
        return HeavyInputFastpathDecisionOutput {
            estimated_tokens,
            should_mark: true,
            reason: Some("rough_estimate".to_string()),
        };
    }

    HeavyInputFastpathDecisionOutput {
        estimated_tokens: read_estimated_tokens_from_metadata(&input.metadata)
            .unwrap_or(estimated_tokens),
        should_mark: false,
        reason: None,
    }
}

#[napi]
pub fn decide_heavy_input_fastpath_json(input_json: String) -> napi::Result<String> {
    if input_json.trim().is_empty() {
        return Err(napi::Error::from_reason("Input JSON cannot be empty"));
    }

    let input: HeavyInputFastpathDecisionInput = serde_json::from_str(&input_json)
        .map_err(|e| napi::Error::from_reason(format!("Failed to parse input JSON: {}", e)))?;

    let output = decide_heavy_input_fastpath(input);

    serde_json::to_string(&output)
        .map_err(|e| napi::Error::from_reason(format!("Failed to serialize output: {}", e)))
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
    let parameters = payload
        .get("parameters")
        .cloned()
        .unwrap_or(serde_json::json!({}));

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

fn chat_envelope_to_standardized_fast(
    chat_envelope: &Value,
    adapter_context: &Value,
) -> Result<Value, String> {
    let chat_envelope = normalize_chat_envelope_tool_calls(chat_envelope)
        .map_err(|err| err.to_string())?;

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
    let parameters = chat_envelope
        .get("parameters")
        .cloned()
        .unwrap_or(serde_json::json!({}));
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

pub fn process_unified_inbound_fast(
    input: UnifiedInboundInput,
) -> Result<UnifiedInboundOutput, String> {
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
    let standardized_request =
        chat_envelope_to_standardized_fast(&chat_envelope, &adapter_context)?;
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

#[cfg(test)]
mod tests {
    use super::{
        chat_envelope_to_standardized_fast, decide_heavy_input_fastpath,
        HeavyInputFastpathDecisionInput,
    };
    use serde_json::{json, Value};
    use std::sync::{Mutex, OnceLock};

    fn env_lock() -> &'static Mutex<()> {
        static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        LOCK.get_or_init(|| Mutex::new(()))
    }

    #[test]
    fn chat_envelope_to_standardized_fast_normalizes_exec_and_apply_patch_shapes() {
        let chat_envelope = json!({
            "model": "glm-5",
            "messages": [
                {
                    "role": "assistant",
                    "tool_calls": [
                        {
                            "id": "call_exec",
                            "type": "function",
                            "function": {
                                "name": "exec_command",
                                "arguments": "{\"input\":\"pwd\"}"
                            }
                        },
                        {
                            "id": "call_patch",
                            "type": "function",
                            "function": {
                                "name": "apply_patch",
                                "arguments": "{\"input\":\"*** Begin Patch\\n*** Add File: note.txt\\n+hello\\n*** End Patch\\n\"}"
                            }
                        }
                    ]
                }
            ],
            "tools": [
                { "type": "function", "function": { "name": "exec_command" } },
                { "type": "function", "function": { "name": "apply_patch" } }
            ],
            "parameters": {}
        });
        let adapter_context = json!({
            "requestId": "req-fast",
            "entryEndpoint": "/v1/chat/completions"
        });

        let standardized = chat_envelope_to_standardized_fast(&chat_envelope, &adapter_context)
            .expect("standardized");
        let messages = standardized["messages"].as_array().expect("messages");
        let tool_calls = messages[0]["tool_calls"].as_array().expect("tool_calls");

        let exec_args_text = tool_calls[0]["function"]["arguments"]
            .as_str()
            .expect("exec args");
        let exec_args: Value = serde_json::from_str(exec_args_text).expect("exec args json");
        assert_eq!(exec_args["cmd"], "pwd");
        assert!(exec_args.get("command").is_none());

        let patch_args_text = tool_calls[1]["function"]["arguments"]
            .as_str()
            .expect("patch args");
        let patch_args: Value = serde_json::from_str(patch_args_text).expect("patch args json");
        assert!(patch_args.get("patch").is_none());
        let patch_input = patch_args["input"].as_str().expect("patch input");
        assert!(patch_input.starts_with("*** Begin Patch"));
        assert!(patch_input.contains("*** Add File: note.txt"));
    }

    #[test]
    fn decide_heavy_input_fastpath_marks_when_request_estimate_crosses_threshold() {
        let _guard = env_lock().lock().expect("env lock");
        std::env::set_var("ROUTECODEX_HUB_FASTPATH_HEAVY_INPUT", "1");
        std::env::set_var("ROUTECODEX_HUB_FASTPATH_INPUT_TOKEN_THRESHOLD", "100");

        let output = decide_heavy_input_fastpath(HeavyInputFastpathDecisionInput {
            request: json!({
                "messages": [{ "role": "user", "content": "x".repeat(2400) }]
            }),
            metadata: json!({}),
        });

        assert!(output.estimated_tokens >= 100);
        assert!(output.should_mark);
        assert_eq!(output.reason.as_deref(), Some("rough_estimate"));

        std::env::remove_var("ROUTECODEX_HUB_FASTPATH_HEAVY_INPUT");
        std::env::remove_var("ROUTECODEX_HUB_FASTPATH_INPUT_TOKEN_THRESHOLD");
    }

    #[test]
    fn decide_heavy_input_fastpath_preserves_metadata_estimate_without_mark_below_threshold() {
        let _guard = env_lock().lock().expect("env lock");
        std::env::set_var("ROUTECODEX_HUB_FASTPATH_HEAVY_INPUT", "1");
        std::env::set_var("ROUTECODEX_HUB_FASTPATH_INPUT_TOKEN_THRESHOLD", "1000");

        let output = decide_heavy_input_fastpath(HeavyInputFastpathDecisionInput {
            request: json!({
                "messages": [{ "role": "user", "content": "short" }]
            }),
            metadata: json!({
                "estimatedInputTokens": 777
            }),
        });

        assert_eq!(output.estimated_tokens, 777);
        assert!(!output.should_mark);
        assert!(output.reason.is_none());

        std::env::remove_var("ROUTECODEX_HUB_FASTPATH_HEAVY_INPUT");
        std::env::remove_var("ROUTECODEX_HUB_FASTPATH_INPUT_TOKEN_THRESHOLD");
    }

    #[test]
    fn decide_heavy_input_fastpath_respects_explicit_disable_without_secondary_override() {
        let _guard = env_lock().lock().expect("env lock");
        std::env::set_var("ROUTECODEX_HUB_FASTPATH_HEAVY_INPUT", "0");
        std::env::remove_var("RCC_HUB_FASTPATH_HEAVY_INPUT");
        std::env::set_var("ROUTECODEX_HUB_FASTPATH_INPUT_TOKEN_THRESHOLD", "10");

        let output = decide_heavy_input_fastpath(HeavyInputFastpathDecisionInput {
            request: json!({
                "messages": [{ "role": "user", "content": "x".repeat(400) }]
            }),
            metadata: json!({}),
        });

        assert!(!output.should_mark);
        assert!(output.estimated_tokens >= 10);

        std::env::remove_var("ROUTECODEX_HUB_FASTPATH_HEAVY_INPUT");
        std::env::remove_var("ROUTECODEX_HUB_FASTPATH_INPUT_TOKEN_THRESHOLD");
    }
}
