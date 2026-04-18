use crate::hub_bridge_actions::{build_bridge_history, BuildBridgeHistoryInput};
use crate::hub_standardized_bridge::normalize_chat_envelope_tool_calls;
use chrono;
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::Map;
use serde_json::Value;
use std::env;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HubPipelineInput {
    pub request_id: String,
    pub endpoint: String,
    pub entry_endpoint: String,
    pub provider_protocol: String,
    pub payload: Value,
    pub metadata: Value,
    #[serde(default)]
    pub stream: bool,
    #[serde(default)]
    pub process_mode: String,
    #[serde(default)]
    pub direction: String,
    #[serde(default)]
    pub stage: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HubPipelineOutput {
    pub request_id: String,
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub payload: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<HubPipelineError>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HubPipelineError {
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PipelineStageResult {
    pub stage_id: String,
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub payload: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FormatEnvelope {
    pub protocol: String,
    pub payload: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatEnvelope {
    pub messages: Vec<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub semantics: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoutingDecision {
    pub provider_key: String,
    pub target_endpoint: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessedRequest {
    pub request: Value,
    pub routing: RoutingDecision,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<Value>,
}

fn normalize_endpoint(endpoint: &str) -> String {
    let trimmed = endpoint.trim();
    if trimmed.is_empty() {
        return "/v1/chat/completions".to_string();
    }
    let normalized = if trimmed.starts_with('/') {
        trimmed.to_string()
    } else {
        format!("/{}", trimmed)
    };
    normalized.replace("//", "/")
}

fn resolve_provider_protocol(value: &str) -> Result<String, String> {
    if value.trim().is_empty() {
        return Ok("openai-chat".to_string());
    }
    let normalized = value.trim().to_lowercase();
    match normalized.as_str() {
        "openai-chat" | "openai" | "chat" => Ok("openai-chat".to_string()),
        "responses" | "openai-responses" => Ok("openai-responses".to_string()),
        "anthropic-messages" | "anthropic" | "messages" => Ok("anthropic-messages".to_string()),
        "gemini-chat" | "gemini" | "google-gemini" => Ok("gemini-chat".to_string()),
        _ => Err(format!("Unsupported providerProtocol: {}", value)),
    }
}

fn resolve_hub_client_protocol(entry_endpoint: &str) -> String {
    let lowered = entry_endpoint.to_ascii_lowercase();
    if lowered.contains("/v1/responses") {
        return "openai-responses".to_string();
    }
    if lowered.contains("/v1/messages") {
        return "anthropic-messages".to_string();
    }
    "openai-chat".to_string()
}

fn resolve_outbound_stream_intent(provider_preference: &Value) -> Option<bool> {
    let token = provider_preference
        .as_str()
        .map(|v| v.trim().to_ascii_lowercase())
        .unwrap_or_default();
    match token.as_str() {
        "always" => Some(true),
        "never" => Some(false),
        _ => None,
    }
}

fn apply_outbound_stream_preference(
    request: &Value,
    stream: Option<bool>,
    process_mode: Option<&str>,
) -> Value {
    let Some(request_obj) = request.as_object() else {
        return request.clone();
    };
    let mode = process_mode.unwrap_or("").trim().to_ascii_lowercase();
    if mode == "passthrough" && stream.is_none() {
        return Value::Object(request_obj.clone());
    }

    let mut out = request_obj.clone();
    match stream {
        Some(stream_value) => {
            if !out.get("parameters").and_then(|v| v.as_object()).is_some() {
                out.insert("parameters".to_string(), Value::Object(Map::new()));
            }
            if let Some(parameters) = out.get_mut("parameters").and_then(|v| v.as_object_mut()) {
                parameters.insert("stream".to_string(), Value::Bool(stream_value));
            }
            if !out.get("metadata").and_then(|v| v.as_object()).is_some() {
                out.insert("metadata".to_string(), Value::Object(Map::new()));
            }
            if let Some(metadata) = out.get_mut("metadata").and_then(|v| v.as_object_mut()) {
                metadata.insert("outboundStream".to_string(), Value::Bool(stream_value));
            }
        }
        None => {
            if let Some(parameters) = out.get_mut("parameters").and_then(|v| v.as_object_mut()) {
                parameters.remove("stream");
            }
            if let Some(metadata) = out.get_mut("metadata").and_then(|v| v.as_object_mut()) {
                metadata.remove("outboundStream");
            }
        }
    }

    Value::Object(out)
}

fn resolve_sse_protocol_from_metadata(metadata: &Value) -> Option<String> {
    let row = metadata.as_object()?;
    for key in ["sseProtocol", "clientSseProtocol", "routeSseProtocol"] {
        let raw = match row.get(key).and_then(|v| v.as_str()) {
            Some(v) => v.trim(),
            None => continue,
        };
        if raw.is_empty() {
            continue;
        }
        if let Ok(protocol) = resolve_provider_protocol(raw) {
            return Some(protocol);
        }
    }
    None
}

fn resolve_sse_protocol(metadata: &Value, provider_protocol: &str) -> String {
    if let Some(protocol) = resolve_sse_protocol_from_metadata(metadata) {
        return protocol;
    }
    let fallback = provider_protocol.trim();
    if fallback.is_empty() {
        return "openai-chat".to_string();
    }
    fallback.to_string()
}

fn extract_model_hint_from_metadata(metadata: &Value) -> Option<String> {
    let row = metadata.as_object()?;
    if let Some(model) = row.get("model").and_then(|v| v.as_str()) {
        let model = model.trim();
        if !model.is_empty() {
            return Some(model.to_string());
        }
    }
    let provider = row.get("provider").and_then(|v| v.as_object())?;
    for key in ["model", "modelId", "defaultModel"] {
        if let Some(candidate) = provider.get(key).and_then(|v| v.as_str()) {
            let candidate = candidate.trim();
            if !candidate.is_empty() {
                return Some(candidate.to_string());
            }
        }
    }
    None
}

fn read_trimmed_string_token(metadata: &Map<String, Value>, keys: &[&str]) -> Option<String> {
    for key in keys {
        let raw = match metadata.get(*key).and_then(|v| v.as_str()) {
            Some(v) => v.trim(),
            None => continue,
        };
        if !raw.is_empty() {
            return Some(raw.to_string());
        }
    }
    None
}

fn resolve_stop_message_router_metadata(metadata: &Value) -> Value {
    let mut out = Map::<String, Value>::new();
    let metadata_obj = match metadata.as_object() {
        Some(v) => v,
        None => return Value::Object(out),
    };

    if let Some(scope) =
        read_trimmed_string_token(metadata_obj, &["stopMessageClientInjectSessionScope"])
    {
        out.insert(
            "stopMessageClientInjectSessionScope".to_string(),
            Value::String(scope),
        );
    }
    if let Some(scope) = read_trimmed_string_token(metadata_obj, &["stopMessageClientInjectScope"])
    {
        out.insert(
            "stopMessageClientInjectScope".to_string(),
            Value::String(scope),
        );
    }

    let client_tmux = read_trimmed_string_token(
        metadata_obj,
        &["clientTmuxSessionId", "client_tmux_session_id"],
    );
    let tmux = read_trimmed_string_token(metadata_obj, &["tmuxSessionId", "tmux_session_id"]);
    let resolved_tmux = client_tmux.or(tmux);
    if let Some(tmux_id) = resolved_tmux {
        out.insert(
            "clientTmuxSessionId".to_string(),
            Value::String(tmux_id.clone()),
        );
        out.insert(
            "client_tmux_session_id".to_string(),
            Value::String(tmux_id.clone()),
        );
        out.insert("tmuxSessionId".to_string(), Value::String(tmux_id.clone()));
        out.insert("tmux_session_id".to_string(), Value::String(tmux_id));
    }

    Value::Object(out)
}

fn resolve_router_metadata_runtime_flags(metadata: &Value) -> Value {
    let mut out = Map::<String, Value>::new();
    let metadata_obj = match metadata.as_object() {
        Some(v) => v,
        None => return Value::Object(out),
    };

    let disable_sticky_routes = metadata_obj
        .get("__rt")
        .and_then(|v| v.as_object())
        .and_then(|row| row.get("disableStickyRoutes"))
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    if disable_sticky_routes {
        out.insert("disableStickyRoutes".to_string(), Value::Bool(true));
    }

    if let Some(raw_estimated_tokens) = metadata_obj
        .get("estimatedInputTokens")
        .and_then(|v| v.as_f64())
    {
        if raw_estimated_tokens.is_finite() {
            if let Some(number) = serde_json::Number::from_f64(raw_estimated_tokens) {
                out.insert("estimatedInputTokens".to_string(), Value::Number(number));
            }
        }
    }

    Value::Object(out)
}

fn build_router_metadata_input(input: &Value) -> Result<Value, String> {
    let row = input
        .as_object()
        .ok_or_else(|| "router metadata input must be object".to_string())?;
    let request_id = row
        .get("requestId")
        .and_then(|v| v.as_str())
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
        .ok_or_else(|| "requestId is required".to_string())?;
    let entry_endpoint = row
        .get("entryEndpoint")
        .and_then(|v| v.as_str())
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| "/v1/chat/completions".to_string());
    let process_mode = row
        .get("processMode")
        .and_then(|v| v.as_str())
        .map(|v| v.trim().to_ascii_lowercase())
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| "chat".to_string());
    let direction = row
        .get("direction")
        .and_then(|v| v.as_str())
        .map(|v| v.trim().to_ascii_lowercase())
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| "request".to_string());
    let provider_protocol = row
        .get("providerProtocol")
        .and_then(|v| v.as_str())
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| "openai-chat".to_string());
    let stream = row.get("stream").and_then(|v| v.as_bool()).unwrap_or(false);
    let metadata_node = row.get("metadata").unwrap_or(&Value::Null);
    let request_semantics = row.get("requestSemantics");
    let stop_message_metadata = resolve_stop_message_router_metadata(metadata_node);
    let runtime_flags = resolve_router_metadata_runtime_flags(metadata_node);
    let include_estimated_input_tokens = row
        .get("includeEstimatedInputTokens")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let responses_resume_from_semantics =
        read_responses_resume_from_semantics_node(request_semantics);
    let responses_resume_from_input = row.get("responsesResume").cloned().and_then(|value| {
        if value.is_null() {
            None
        } else {
            Some(value)
        }
    });
    let responses_resume_for_output = responses_resume_from_input
        .clone()
        .or_else(|| responses_resume_from_semantics.clone());
    let continuation = read_continuation_from_semantics_node(request_semantics).or_else(|| {
        synthesize_continuation_from_responses_resume(responses_resume_for_output.as_ref())
    });

    let mut out = Map::<String, Value>::new();
    out.insert("requestId".to_string(), Value::String(request_id));
    out.insert("entryEndpoint".to_string(), Value::String(entry_endpoint));
    out.insert("processMode".to_string(), Value::String(process_mode));
    out.insert("stream".to_string(), Value::Bool(stream));
    out.insert("direction".to_string(), Value::String(direction));
    out.insert(
        "providerProtocol".to_string(),
        Value::String(provider_protocol),
    );

    if let Some(route_hint) = row
        .get("routeHint")
        .and_then(|v| v.as_str())
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
    {
        out.insert("routeHint".to_string(), Value::String(route_hint));
    }
    if let Some(stage) = row
        .get("stage")
        .and_then(|v| v.as_str())
        .map(|v| v.trim().to_ascii_lowercase())
        .filter(|v| v == "inbound" || v == "outbound")
    {
        out.insert("stage".to_string(), Value::String(stage));
    }
    if let Some(session_id) = row
        .get("sessionId")
        .and_then(|v| v.as_str())
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
    {
        out.insert("sessionId".to_string(), Value::String(session_id));
    }
    if let Some(conversation_id) = row
        .get("conversationId")
        .and_then(|v| v.as_str())
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
    {
        out.insert("conversationId".to_string(), Value::String(conversation_id));
    }
    if row
        .get("serverToolRequired")
        .and_then(|v| v.as_bool())
        .unwrap_or(false)
    {
        out.insert("serverToolRequired".to_string(), Value::Bool(true));
    }
    if let Some(continuation) = continuation {
        out.insert("continuation".to_string(), continuation);
    }
    if let Some(responses_resume) = responses_resume_for_output {
        out.insert("responsesResume".to_string(), responses_resume);
    }

    if let Some(stop_obj) = stop_message_metadata.as_object() {
        for (key, value) in stop_obj {
            out.insert(key.clone(), value.clone());
        }
    }
    if let Some(runtime_flags_obj) = runtime_flags.as_object() {
        if runtime_flags_obj
            .get("disableStickyRoutes")
            .and_then(|v| v.as_bool())
            .unwrap_or(false)
        {
            out.insert("disableStickyRoutes".to_string(), Value::Bool(true));
        }
        if include_estimated_input_tokens {
            if let Some(value) = runtime_flags_obj.get("estimatedInputTokens") {
                out.insert("estimatedInputTokens".to_string(), value.clone());
            }
        }
    }

    if let Some(metadata_obj) = metadata_node.as_object() {
        if let Some(forced_provider_key) = metadata_obj
            .get("__shadowCompareForcedProviderKey")
            .and_then(|v| v.as_str())
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty())
        {
            out.insert(
                "__shadowCompareForcedProviderKey".to_string(),
                Value::String(forced_provider_key),
            );
        }

        if let Some(disabled_aliases) = metadata_obj
            .get("disabledProviderKeyAliases")
            .and_then(|v| v.as_array())
        {
            let normalized: Vec<Value> = disabled_aliases
                .iter()
                .filter_map(|entry| entry.as_str())
                .map(|entry| entry.trim().to_string())
                .filter(|entry| !entry.is_empty())
                .map(Value::String)
                .collect();
            if !normalized.is_empty() {
                out.insert(
                    "disabledProviderKeyAliases".to_string(),
                    Value::Array(normalized),
                );
            }
        }
    }

    Ok(Value::Object(out))
}

fn normalize_hub_policy_mode(raw: Option<&str>) -> String {
    let token = raw.unwrap_or("").trim().to_ascii_lowercase();
    match token.as_str() {
        "observe" | "enforce" => token,
        _ => "off".to_string(),
    }
}

fn build_hub_pipeline_result_metadata(input: &Value) -> Result<Value, String> {
    let row = input
        .as_object()
        .ok_or_else(|| "hub pipeline result metadata input must be object".to_string())?;
    let normalized = row
        .get("normalized")
        .and_then(|v| v.as_object())
        .ok_or_else(|| "normalized is required".to_string())?;
    let mut out = normalized
        .get("metadata")
        .and_then(|v| v.as_object())
        .cloned()
        .unwrap_or_default();

    let captured_chat_request = row
        .get("capturedChatRequest")
        .cloned()
        .unwrap_or_else(|| Value::Object(Map::new()));
    out.insert("capturedChatRequest".to_string(), captured_chat_request);

    let entry_endpoint = normalized
        .get("entryEndpoint")
        .and_then(|v| v.as_str())
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| "/v1/chat/completions".to_string());
    out.insert("entryEndpoint".to_string(), Value::String(entry_endpoint));

    let provider_protocol = row
        .get("outboundProtocol")
        .and_then(|v| v.as_str())
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| "openai-chat".to_string());
    out.insert(
        "providerProtocol".to_string(),
        Value::String(provider_protocol.clone()),
    );

    out.insert(
        "stream".to_string(),
        Value::Bool(
            normalized
                .get("stream")
                .and_then(|v| v.as_bool())
                .unwrap_or(false),
        ),
    );

    let process_mode = normalized
        .get("processMode")
        .and_then(|v| v.as_str())
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| "chat".to_string());
    out.insert("processMode".to_string(), Value::String(process_mode));

    if let Some(passthrough_audit) = row.get("passthroughAudit") {
        if passthrough_audit.is_object() {
            out.insert("passthroughAudit".to_string(), passthrough_audit.clone());
        }
    }

    if let Some(route_hint) = normalized
        .get("routeHint")
        .and_then(|v| v.as_str())
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
    {
        out.insert("routeHint".to_string(), Value::String(route_hint));
    }

    if let Some(target) = row.get("target") {
        if !target.is_null() {
            out.insert("target".to_string(), target.clone());
        }
    }

    if let Some(outbound_stream) = row.get("outboundStream").and_then(|v| v.as_bool()) {
        out.insert("providerStream".to_string(), Value::Bool(outbound_stream));
    }

    if let Some(shadow_baseline_payload) = row.get("shadowBaselineProviderPayload") {
        if shadow_baseline_payload.is_object() {
            let baseline_mode = normalize_hub_policy_mode(
                row.get("shadowCompareBaselineMode")
                    .and_then(|v| v.as_str()),
            );
            let candidate_mode = normalize_hub_policy_mode(
                row.get("effectivePolicy")
                    .and_then(|v| v.as_object())
                    .and_then(|policy| policy.get("mode"))
                    .and_then(|v| v.as_str()),
            );
            let mut shadow = Map::<String, Value>::new();
            shadow.insert("baselineMode".to_string(), Value::String(baseline_mode));
            shadow.insert("candidateMode".to_string(), Value::String(candidate_mode));
            shadow.insert(
                "providerProtocol".to_string(),
                Value::String(provider_protocol),
            );
            shadow.insert(
                "baselineProviderPayload".to_string(),
                shadow_baseline_payload.clone(),
            );
            out.insert("hubShadowCompare".to_string(), Value::Object(shadow));
        }
    }

    Ok(Value::Object(out))
}

fn read_i64_from_input(row: &Map<String, Value>, key: &str) -> Option<i64> {
    row.get(key).and_then(|value| match value {
        Value::Number(num) => {
            if let Some(v) = num.as_i64() {
                return Some(v);
            }
            num.as_f64().and_then(|raw| {
                if raw.is_finite() {
                    Some(raw.trunc() as i64)
                } else {
                    None
                }
            })
        }
        _ => None,
    })
}

fn build_req_outbound_node_result(input: &Value) -> Result<Value, String> {
    let row = input
        .as_object()
        .ok_or_else(|| "req outbound node result input must be object".to_string())?;

    let outbound_start = read_i64_from_input(row, "outboundStart")
        .ok_or_else(|| "outboundStart is required".to_string())?;
    let outbound_end = read_i64_from_input(row, "outboundEnd")
        .ok_or_else(|| "outboundEnd is required".to_string())?;
    let messages = read_i64_from_input(row, "messages").unwrap_or(0);
    let tools = read_i64_from_input(row, "tools").unwrap_or(0);

    let mut data_processed = Map::<String, Value>::new();
    data_processed.insert(
        "messages".to_string(),
        Value::Number(serde_json::Number::from(messages)),
    );
    data_processed.insert(
        "tools".to_string(),
        Value::Number(serde_json::Number::from(tools)),
    );

    let mut metadata = Map::<String, Value>::new();
    metadata.insert(
        "node".to_string(),
        Value::String("req_outbound".to_string()),
    );
    metadata.insert(
        "executionTime".to_string(),
        Value::Number(serde_json::Number::from(outbound_end - outbound_start)),
    );
    metadata.insert(
        "startTime".to_string(),
        Value::Number(serde_json::Number::from(outbound_start)),
    );
    metadata.insert(
        "endTime".to_string(),
        Value::Number(serde_json::Number::from(outbound_end)),
    );
    metadata.insert("dataProcessed".to_string(), Value::Object(data_processed));

    let mut out = Map::<String, Value>::new();
    out.insert("id".to_string(), Value::String("req_outbound".to_string()));
    out.insert("success".to_string(), Value::Bool(true));
    out.insert("metadata".to_string(), Value::Object(metadata));

    Ok(Value::Object(out))
}

fn build_req_inbound_node_result(input: &Value) -> Result<Value, String> {
    let row = input
        .as_object()
        .ok_or_else(|| "req inbound node result input must be object".to_string())?;

    let inbound_start = read_i64_from_input(row, "inboundStart")
        .ok_or_else(|| "inboundStart is required".to_string())?;
    let inbound_end = read_i64_from_input(row, "inboundEnd")
        .ok_or_else(|| "inboundEnd is required".to_string())?;
    let messages = read_i64_from_input(row, "messages").unwrap_or(0);
    let tools = read_i64_from_input(row, "tools").unwrap_or(0);

    let mut data_processed = Map::<String, Value>::new();
    data_processed.insert(
        "messages".to_string(),
        Value::Number(serde_json::Number::from(messages)),
    );
    data_processed.insert(
        "tools".to_string(),
        Value::Number(serde_json::Number::from(tools)),
    );

    let mut metadata = Map::<String, Value>::new();
    metadata.insert("node".to_string(), Value::String("req_inbound".to_string()));
    metadata.insert(
        "executionTime".to_string(),
        Value::Number(serde_json::Number::from(inbound_end - inbound_start)),
    );
    metadata.insert(
        "startTime".to_string(),
        Value::Number(serde_json::Number::from(inbound_start)),
    );
    metadata.insert(
        "endTime".to_string(),
        Value::Number(serde_json::Number::from(inbound_end)),
    );
    metadata.insert("dataProcessed".to_string(), Value::Object(data_processed));

    let mut out = Map::<String, Value>::new();
    out.insert("id".to_string(), Value::String("req_inbound".to_string()));
    out.insert("success".to_string(), Value::Bool(true));
    out.insert("metadata".to_string(), Value::Object(metadata));
    Ok(Value::Object(out))
}

fn build_req_inbound_skipped_node(input: &Value) -> Result<Value, String> {
    let row = input
        .as_object()
        .ok_or_else(|| "req inbound skipped node input must be object".to_string())?;
    let reason = row
        .get("reason")
        .and_then(|v| v.as_str())
        .map(|v| v.trim())
        .filter(|v| !v.is_empty())
        .unwrap_or("stage=outbound")
        .to_string();

    let mut metadata = Map::<String, Value>::new();
    metadata.insert("node".to_string(), Value::String("req_inbound".to_string()));
    metadata.insert("skipped".to_string(), Value::Bool(true));
    metadata.insert("reason".to_string(), Value::String(reason));
    metadata.insert("dataProcessed".to_string(), Value::Object(Map::new()));

    let mut out = Map::<String, Value>::new();
    out.insert("id".to_string(), Value::String("req_inbound".to_string()));
    out.insert("success".to_string(), Value::Bool(true));
    out.insert("metadata".to_string(), Value::Object(metadata));
    Ok(Value::Object(out))
}

fn build_captured_chat_request_snapshot(input: &Value) -> Result<Value, String> {
    let row = input
        .as_object()
        .ok_or_else(|| "captured chat request snapshot input must be object".to_string())?;

    let mut out = Map::<String, Value>::new();
    out.insert(
        "model".to_string(),
        row.get("model").cloned().unwrap_or(Value::Null),
    );
    out.insert(
        "messages".to_string(),
        row.get("messages").cloned().unwrap_or(Value::Null),
    );
    if let Some(tools) = row.get("tools") {
        out.insert("tools".to_string(), tools.clone());
    } else {
        out.insert("tools".to_string(), Value::Null);
    }
    if let Some(parameters) = row.get("parameters") {
        out.insert("parameters".to_string(), parameters.clone());
    } else {
        out.insert("parameters".to_string(), Value::Null);
    }
    Ok(Value::Object(out))
}

fn coerce_standardized_request_from_payload(input: &Value) -> Result<Value, String> {
    let row = input
        .as_object()
        .ok_or_else(|| "coerce standardized request input must be object".to_string())?;
    let payload = row
        .get("payload")
        .cloned()
        .ok_or_else(|| "payload must be object".to_string())?;
    let payload = normalize_chat_envelope_tool_calls(&payload);
    let payload = payload
        .as_object()
        .ok_or_else(|| "payload must be object".to_string())?;
    let normalized = row
        .get("normalized")
        .and_then(|v| v.as_object())
        .ok_or_else(|| "normalized must be object".to_string())?;

    let model = payload
        .get("model")
        .and_then(|v| v.as_str())
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
        .ok_or_else(|| "[HubPipeline] outbound stage requires payload.model".to_string())?;
    let messages = payload
        .get("messages")
        .and_then(|v| v.as_array())
        .cloned()
        .ok_or_else(|| "[HubPipeline] outbound stage requires payload.messages[]".to_string())?;
    let tools = payload.get("tools").and_then(|v| v.as_array()).cloned();
    let parameters = payload
        .get("parameters")
        .and_then(|v| v.as_object())
        .cloned()
        .unwrap_or_default();
    let semantics_from_payload = payload
        .get("semantics")
        .and_then(|v| v.as_object())
        .cloned();
    let metadata_from_payload = payload.get("metadata").and_then(|v| v.as_object()).cloned();

    let mut metadata = Map::<String, Value>::new();
    metadata.insert(
        "originalEndpoint".to_string(),
        Value::String(
            normalized
                .get("entryEndpoint")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
        ),
    );
    if let Some(source_metadata) = metadata_from_payload {
        for (key, value) in source_metadata {
            metadata.insert(key, value);
        }
    }
    metadata.insert(
        "requestId".to_string(),
        Value::String(
            normalized
                .get("id")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
        ),
    );
    metadata.insert(
        "stream".to_string(),
        Value::Bool(
            normalized
                .get("stream")
                .and_then(|v| v.as_bool())
                .unwrap_or(false),
        ),
    );
    metadata.insert(
        "processMode".to_string(),
        Value::String(
            normalized
                .get("processMode")
                .and_then(|v| v.as_str())
                .unwrap_or("chat")
                .to_string(),
        ),
    );
    if let Some(route_hint) = normalized.get("routeHint").and_then(|v| v.as_str()) {
        if !route_hint.is_empty() {
            metadata.insert(
                "routeHint".to_string(),
                Value::String(route_hint.to_string()),
            );
        }
    }

    let mut semantics = semantics_from_payload.unwrap_or_default();
    let tools_node = semantics
        .entry("tools".to_string())
        .or_insert_with(|| Value::Object(Map::new()));
    if !tools_node.is_object() {
        *tools_node = Value::Object(Map::new());
    }
    if let Some(tools_array) = tools.as_ref() {
        if !tools_array.is_empty() {
            if let Some(tools_map) = tools_node.as_object_mut() {
                if !tools_map.contains_key("clientToolsRaw") {
                    tools_map.insert(
                        "clientToolsRaw".to_string(),
                        Value::Array(tools_array.clone()),
                    );
                }
            }
        }
    }

    let mut standardized_request = Map::<String, Value>::new();
    standardized_request.insert("model".to_string(), Value::String(model.clone()));
    standardized_request.insert("messages".to_string(), Value::Array(messages.clone()));
    if let Some(tools_array) = tools.as_ref() {
        standardized_request.insert("tools".to_string(), Value::Array(tools_array.clone()));
    }
    standardized_request.insert("parameters".to_string(), Value::Object(parameters.clone()));
    standardized_request.insert("metadata".to_string(), Value::Object(metadata));
    standardized_request.insert("semantics".to_string(), Value::Object(semantics));

    let mut raw_payload = Map::<String, Value>::new();
    raw_payload.insert("model".to_string(), Value::String(model));
    raw_payload.insert("messages".to_string(), Value::Array(messages));
    if let Some(tools_array) = tools {
        raw_payload.insert("tools".to_string(), Value::Array(tools_array));
    }
    if !parameters.is_empty() {
        raw_payload.insert("parameters".to_string(), Value::Object(parameters));
    }

    let mut output = Map::<String, Value>::new();
    output.insert(
        "standardizedRequest".to_string(),
        Value::Object(standardized_request),
    );
    output.insert("rawPayload".to_string(), Value::Object(raw_payload));
    Ok(Value::Object(output))
}

fn prepare_runtime_metadata_for_servertools(input: &Value) -> Result<Value, String> {
    let row = input
        .as_object()
        .ok_or_else(|| "servertools runtime metadata input must be object".to_string())?;
    let mut meta_base = value_as_object_or_empty(row.get("metadata").unwrap_or(&Value::Null));

    let rt_entry = meta_base
        .entry("__rt".to_string())
        .or_insert_with(|| Value::Object(Map::new()));
    if !rt_entry.is_object() {
        *rt_entry = Value::Object(Map::new());
    }
    let rt_base = rt_entry
        .as_object_mut()
        .expect("__rt should be object after normalization");

    let attach_if_object = |rt: &mut Map<String, Value>,
                            input_key: &str,
                            rt_key: &str,
                            input_row: &Map<String, Value>| {
        if let Some(raw) = input_row.get(input_key) {
            if raw.is_object() {
                rt.insert(rt_key.to_string(), raw.clone());
            }
        }
    };

    attach_if_object(rt_base, "webSearchConfig", "webSearch", row);
    attach_if_object(rt_base, "execCommandGuard", "execCommandGuard", row);
    attach_if_object(rt_base, "clockConfig", "clock", row);

    Ok(Value::Object(meta_base))
}

fn apply_has_image_attachment_flag(input: &Value) -> Result<Value, String> {
    let row = input
        .as_object()
        .ok_or_else(|| "has-image-attachment metadata input must be object".to_string())?;
    let mut metadata = value_as_object_or_empty(row.get("metadata").unwrap_or(&Value::Null));
    let has_image_attachment = row
        .get("hasImageAttachment")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

    if has_image_attachment {
        metadata.insert("hasImageAttachment".to_string(), Value::Bool(true));
    } else {
        metadata.remove("hasImageAttachment");
    }

    Ok(Value::Object(metadata))
}

fn sync_session_identifiers_to_metadata(input: &Value) -> Result<Value, String> {
    let row = input
        .as_object()
        .ok_or_else(|| "session identifier metadata input must be object".to_string())?;
    let mut metadata = value_as_object_or_empty(row.get("metadata").unwrap_or(&Value::Null));

    let normalize_id = |value: Option<&Value>| -> Option<String> {
        value
            .and_then(|v| v.as_str())
            .map(|raw| raw.trim())
            .filter(|raw| !raw.is_empty())
            .map(|raw| raw.to_string())
    };

    if let Some(session_id) = normalize_id(row.get("sessionId")) {
        metadata.insert("sessionId".to_string(), Value::String(session_id));
    }

    if let Some(conversation_id) = normalize_id(row.get("conversationId")) {
        metadata.insert("conversationId".to_string(), Value::String(conversation_id));
    }

    Ok(Value::Object(metadata))
}

fn merge_clock_reservation_into_metadata(input: &Value) -> Result<Value, String> {
    let row = input
        .as_object()
        .ok_or_else(|| "clock reservation metadata input must be object".to_string())?;
    let mut metadata = value_as_object_or_empty(row.get("metadata").unwrap_or(&Value::Null));
    let reservation = row
        .get("processedRequest")
        .and_then(|v| v.as_object())
        .and_then(|req| req.get("metadata"))
        .and_then(|v| v.as_object())
        .and_then(|meta| meta.get("__clockReservation"));
    if let Some(Value::Object(obj)) = reservation {
        metadata.insert("__clockReservation".to_string(), Value::Object(obj.clone()));
    }
    Ok(Value::Object(metadata))
}

fn build_tool_governance_node_result(input: &Value) -> Result<Value, String> {
    let row = input
        .as_object()
        .ok_or_else(|| "tool governance node result input must be object".to_string())?;

    let success = row
        .get("success")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let metadata = row
        .get("metadata")
        .and_then(|v| v.as_object())
        .cloned()
        .unwrap_or_default();

    let mut out = Map::<String, Value>::new();
    out.insert(
        "id".to_string(),
        Value::String("chat_process.req.stage4.tool_governance".to_string()),
    );
    out.insert("success".to_string(), Value::Bool(success));
    out.insert("metadata".to_string(), Value::Object(metadata));

    if let Some(error_obj) = row.get("error").and_then(|v| v.as_object()) {
        let mut normalized_error = Map::<String, Value>::new();
        let code = match error_obj.get("code") {
            Some(value) if !value.is_null() => value.clone(),
            _ => Value::String("hub_chat_process_error".to_string()),
        };
        normalized_error.insert("code".to_string(), code);

        if let Some(message) = error_obj.get("message") {
            normalized_error.insert("message".to_string(), message.clone());
        }
        if let Some(details) = error_obj.get("details") {
            normalized_error.insert("details".to_string(), details.clone());
        }

        out.insert("error".to_string(), Value::Object(normalized_error));
    }

    Ok(Value::Object(out))
}

fn build_passthrough_governance_skipped_node() -> Value {
    let mut metadata = Map::<String, Value>::new();
    metadata.insert(
        "node".to_string(),
        Value::String("chat_process.req.stage4.tool_governance".to_string()),
    );
    metadata.insert("skipped".to_string(), Value::Bool(true));
    metadata.insert(
        "reason".to_string(),
        Value::String("process_mode_passthrough_parse_record_only".to_string()),
    );

    let mut out = Map::<String, Value>::new();
    out.insert(
        "id".to_string(),
        Value::String("chat_process.req.stage4.tool_governance".to_string()),
    );
    out.insert("success".to_string(), Value::Bool(true));
    out.insert("metadata".to_string(), Value::Object(metadata));
    Value::Object(out)
}

fn extract_adapter_context_metadata_fields(metadata: &Value, keys: &Value) -> Value {
    let metadata_obj = match metadata.as_object() {
        Some(v) => v,
        None => return Value::Object(Map::new()),
    };
    let key_rows = match keys.as_array() {
        Some(v) => v,
        None => return Value::Object(Map::new()),
    };

    let mut out = Map::<String, Value>::new();
    for entry in key_rows {
        let key = match entry.as_str() {
            Some(v) => v.trim(),
            None => continue,
        };
        if key.is_empty() {
            continue;
        }
        let Some(raw) = metadata_obj.get(key) else {
            continue;
        };
        match raw {
            Value::Bool(v) => {
                out.insert(key.to_string(), Value::Bool(*v));
            }
            Value::String(v) => {
                let trimmed = v.trim();
                if !trimmed.is_empty() {
                    out.insert(key.to_string(), Value::String(trimmed.to_string()));
                }
            }
            _ => {}
        }
    }
    Value::Object(out)
}

fn resolve_adapter_context_client_connection_state(metadata: &Value) -> Value {
    let metadata_obj = match metadata.as_object() {
        Some(v) => v,
        None => return Value::Object(Map::new()),
    };

    let disconnected_from_state = metadata_obj
        .get("clientConnectionState")
        .and_then(|v| v.as_object())
        .and_then(|row| row.get("disconnected"))
        .and_then(|v| v.as_bool());

    let explicit_true = match metadata_obj.get("clientDisconnected") {
        Some(Value::Bool(true)) => true,
        Some(Value::String(raw)) if raw.trim().eq_ignore_ascii_case("true") => true,
        _ => false,
    };

    let resolved = if explicit_true {
        Some(true)
    } else {
        disconnected_from_state
    };

    let mut out = Map::<String, Value>::new();
    if let Some(disconnected) = resolved {
        out.insert("clientDisconnected".to_string(), Value::Bool(disconnected));
    }
    Value::Object(out)
}

fn resolve_adapter_context_metadata_signals(metadata: &Value) -> Value {
    let metadata_obj = match metadata.as_object() {
        Some(v) => v,
        None => return Value::Object(Map::new()),
    };

    let mut out = Map::<String, Value>::new();
    let maybe_assign_trimmed_non_empty =
        |source_key: &str, target_key: &str, bucket: &mut Map<String, Value>| {
            let Some(raw_value) = metadata_obj.get(source_key).and_then(|v| v.as_str()) else {
                return;
            };
            let trimmed = raw_value.trim();
            if trimmed.is_empty() {
                return;
            }
            bucket.insert(target_key.to_string(), Value::String(trimmed.to_string()));
        };

    maybe_assign_trimmed_non_empty("clientRequestId", "clientRequestId", &mut out);
    maybe_assign_trimmed_non_empty("groupRequestId", "groupRequestId", &mut out);
    maybe_assign_trimmed_non_empty("sessionId", "sessionId", &mut out);
    maybe_assign_trimmed_non_empty("conversationId", "conversationId", &mut out);

    if let Some(original_model_id) = metadata_obj.get("originalModelId").and_then(|v| v.as_str()) {
        out.insert(
            "originalModelId".to_string(),
            Value::String(original_model_id.to_string()),
        );
    }
    if let Some(client_model_id) = metadata_obj.get("clientModelId").and_then(|v| v.as_str()) {
        out.insert(
            "clientModelId".to_string(),
            Value::String(client_model_id.to_string()),
        );
    }
    if let Some(assigned_model_id) = metadata_obj.get("assignedModelId").and_then(|v| v.as_str()) {
        out.insert(
            "modelId".to_string(),
            Value::String(assigned_model_id.to_string()),
        );
    }

    let estimated_input_tokens_raw = metadata_obj
        .get("estimatedInputTokens")
        .filter(|v| !v.is_null())
        .or_else(|| {
            metadata_obj
                .get("estimated_tokens")
                .filter(|v| !v.is_null())
        })
        .or_else(|| metadata_obj.get("estimatedTokens").filter(|v| !v.is_null()));
    if let Some(raw_estimated_tokens) = parse_js_number_like(estimated_input_tokens_raw) {
        if raw_estimated_tokens.is_finite() && raw_estimated_tokens > 0.0 {
            if let Some(number) =
                serde_json::Number::from_f64(raw_estimated_tokens.round().max(1.0))
            {
                out.insert("estimatedInputTokens".to_string(), Value::Number(number));
            }
        }
    }

    Value::Object(out)
}

fn resolve_adapter_context_object_carriers(metadata: &Value) -> Value {
    let metadata_obj = match metadata.as_object() {
        Some(v) => v,
        None => return Value::Object(Map::new()),
    };

    let mut out = Map::<String, Value>::new();
    if let Some(runtime) = metadata_obj.get("runtime").and_then(|v| v.as_object()) {
        out.insert("runtime".to_string(), Value::Object(runtime.clone()));
    }
    if let Some(captured_chat_request) = metadata_obj
        .get("capturedChatRequest")
        .and_then(|v| v.as_object())
    {
        out.insert(
            "capturedChatRequest".to_string(),
            Value::Object(captured_chat_request.clone()),
        );
    }
    if let Some(client_connection_state) = metadata_obj
        .get("clientConnectionState")
        .and_then(|v| v.as_object())
    {
        out.insert(
            "clientConnectionState".to_string(),
            Value::Object(client_connection_state.clone()),
        );
    }
    if let Some(client_disconnected) = resolve_adapter_context_client_connection_state(metadata)
        .as_object()
        .and_then(|row| row.get("clientDisconnected"))
        .and_then(|v| v.as_bool())
    {
        out.insert(
            "clientDisconnected".to_string(),
            Value::Bool(client_disconnected),
        );
    }
    Value::Object(out)
}

fn normalize_policy_mode(raw: Option<&str>) -> Option<String> {
    let candidate = raw.unwrap_or("").trim().to_ascii_lowercase();
    match candidate.as_str() {
        "off" | "observe" | "enforce" => Some(candidate),
        _ => None,
    }
}

fn resolve_hub_policy_override(metadata: &Value) -> Option<Value> {
    let metadata_obj = metadata.as_object()?;
    let raw = metadata_obj.get("__hubPolicyOverride")?;
    let override_obj = raw.as_object()?;

    let mode = normalize_policy_mode(override_obj.get("mode").and_then(|v| v.as_str()))?;
    let mut out = Map::<String, Value>::new();
    out.insert("mode".to_string(), Value::String(mode));

    if let Some(sample_rate) = override_obj.get("sampleRate").and_then(|v| v.as_f64()) {
        if sample_rate.is_finite() {
            if let Some(number) = serde_json::Number::from_f64(sample_rate) {
                out.insert("sampleRate".to_string(), Value::Number(number));
            }
        }
    }

    Some(Value::Object(out))
}

fn resolve_hub_shadow_compare_config(metadata: &Value) -> Option<Value> {
    let metadata_obj = metadata.as_object()?;
    let raw = metadata_obj.get("__hubShadowCompare")?;
    let shadow_obj = raw.as_object()?;

    let baseline_mode = normalize_policy_mode(
        shadow_obj
            .get("baselineMode")
            .and_then(|v| v.as_str())
            .or_else(|| shadow_obj.get("mode").and_then(|v| v.as_str())),
    )?;

    let mut out = Map::<String, Value>::new();
    out.insert("baselineMode".to_string(), Value::String(baseline_mode));
    Some(Value::Object(out))
}

fn normalize_apply_patch_tool_mode_token(raw: Option<&str>) -> Option<String> {
    let token = raw.unwrap_or("").trim().to_ascii_lowercase();
    match token.as_str() {
        "freeform" => Some("freeform".to_string()),
        "schema" | "json_schema" => Some("schema".to_string()),
        _ => None,
    }
}

fn is_truthy_env_value(raw: &str) -> bool {
    matches!(
        raw.trim().to_ascii_lowercase().as_str(),
        "1" | "true" | "yes" | "on"
    )
}

fn resolve_apply_patch_tool_mode_from_env() -> Option<String> {
    let mode = env::var("RCC_APPLY_PATCH_TOOL_MODE")
        .ok()
        .or_else(|| env::var("ROUTECODEX_APPLY_PATCH_TOOL_MODE").ok())
        .and_then(|raw| normalize_apply_patch_tool_mode_token(Some(raw.as_str())));
    if mode.is_some() {
        return mode;
    }
    let freeform = env::var("RCC_APPLY_PATCH_FREEFORM")
        .ok()
        .or_else(|| env::var("ROUTECODEX_APPLY_PATCH_FREEFORM").ok())
        .unwrap_or_default();
    if is_truthy_env_value(freeform.as_str()) {
        return Some("freeform".to_string());
    }
    None
}

fn resolve_apply_patch_tool_mode_from_tools(tools_raw: &Value) -> Option<String> {
    let tools = tools_raw.as_array()?;
    if tools.is_empty() {
        return None;
    }
    for entry in tools {
        let record = match entry.as_object() {
            Some(v) => v,
            None => continue,
        };
        let tool_type = record
            .get("type")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim()
            .to_ascii_lowercase();
        if !tool_type.is_empty() && tool_type != "function" {
            continue;
        }
        let fn_obj = record.get("function").and_then(|v| v.as_object());
        let name = fn_obj
            .and_then(|obj| obj.get("name"))
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim()
            .to_ascii_lowercase();
        if name != "apply_patch" {
            continue;
        }
        let format = normalize_apply_patch_tool_mode_token(
            record.get("format").and_then(|v| v.as_str()).or_else(|| {
                fn_obj
                    .and_then(|obj| obj.get("format"))
                    .and_then(|v| v.as_str())
            }),
        );
        // If apply_patch exists without explicit freeform marker, default to schema mode.
        return Some(format.unwrap_or_else(|| "schema".to_string()));
    }
    None
}

fn read_responses_resume_from_metadata(metadata: &Value) -> Option<Value> {
    let metadata_obj = metadata.as_object()?;
    let resume = metadata_obj.get("responsesResume")?;
    if !resume.is_object() {
        return None;
    }
    Some(resume.clone())
}

fn read_responses_resume_from_request_semantics(request: &Value) -> Option<Value> {
    let request_obj = request.as_object()?;
    let semantics_obj = request_obj.get("semantics")?.as_object()?;
    let responses_obj = semantics_obj.get("responses")?.as_object()?;
    let resume = responses_obj.get("resume")?;
    if !resume.is_object() {
        return None;
    }
    Some(resume.clone())
}

fn read_trimmed_optional_string(value: Option<&Value>) -> Option<String> {
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

fn read_continuation_from_semantics_node(semantics: Option<&Value>) -> Option<Value> {
    let semantics_obj = semantics?.as_object()?;
    let continuation = semantics_obj.get("continuation")?;
    if !continuation.is_object() {
        return None;
    }
    Some(continuation.clone())
}

fn read_responses_resume_from_semantics_node(semantics: Option<&Value>) -> Option<Value> {
    let semantics_obj = semantics?.as_object()?;
    let responses_obj = semantics_obj.get("responses")?.as_object()?;
    let resume = responses_obj.get("resume")?;
    if !resume.is_object() {
        return None;
    }
    Some(resume.clone())
}

fn synthesize_continuation_from_responses_resume(resume: Option<&Value>) -> Option<Value> {
    let resume_obj = resume?.as_object()?;
    let previous_request_id = read_trimmed_optional_string(resume_obj.get("previousRequestId"));
    let restored_from_response_id =
        read_trimmed_optional_string(resume_obj.get("restoredFromResponseId"));

    let mut continuation = Map::<String, Value>::new();
    if let Some(chain_id) = previous_request_id
        .clone()
        .or_else(|| restored_from_response_id.clone())
    {
        continuation.insert("chainId".to_string(), Value::String(chain_id));
    }

    let mut resume_from = Map::<String, Value>::new();
    resume_from.insert(
        "protocol".to_string(),
        Value::String("openai-responses".to_string()),
    );
    if let Some(request_id) = previous_request_id {
        resume_from.insert("requestId".to_string(), Value::String(request_id));
    }
    if let Some(response_id) = restored_from_response_id {
        resume_from.insert("responseId".to_string(), Value::String(response_id));
    }
    if !resume_from.is_empty() {
        continuation.insert("resumeFrom".to_string(), Value::Object(resume_from));
    }

    if continuation.is_empty() {
        return None;
    }

    continuation.insert(
        "stickyScope".to_string(),
        Value::String("request_chain".to_string()),
    );
    continuation.insert(
        "stateOrigin".to_string(),
        Value::String("openai-responses".to_string()),
    );
    continuation.insert("restored".to_string(), Value::Bool(true));
    Some(Value::Object(continuation))
}

fn is_search_route_id(route_id: &Value) -> bool {
    let normalized = route_id.as_str().unwrap_or("").trim().to_ascii_lowercase();
    normalized.starts_with("web_search") || normalized.starts_with("search")
}

fn is_canonical_web_search_tool_definition(tool: &Value) -> bool {
    let Some(row) = tool.as_object() else {
        return false;
    };
    let raw_type = row
        .get("type")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    if raw_type == "web_search_20250305" || raw_type == "web_search" {
        return true;
    }
    let function_name = row
        .get("function")
        .and_then(|v| v.as_object())
        .and_then(|fn_node| fn_node.get("name"))
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let fallback_name = row.get("name").and_then(|v| v.as_str()).unwrap_or("");
    let normalized = if function_name.trim().is_empty() {
        fallback_name.trim().to_ascii_lowercase()
    } else {
        function_name.trim().to_ascii_lowercase()
    };
    matches!(
        normalized.as_str(),
        "web_search" | "websearch" | "web-search"
    )
}

fn parse_js_number_like(value: Option<&Value>) -> Option<f64> {
    match value {
        Some(Value::Number(num)) => num.as_f64(),
        Some(Value::String(raw)) => raw.trim().parse::<f64>().ok(),
        Some(Value::Bool(flag)) => Some(if *flag { 1.0 } else { 0.0 }),
        Some(Value::Null) => Some(0.0),
        _ => None,
    }
}

fn find_direct_builtin_web_search_engine<'a>(
    runtime_metadata: &'a Map<String, Value>,
    model_id: &str,
) -> Option<&'a Map<String, Value>> {
    let web_search = runtime_metadata.get("webSearch")?.as_object()?;
    let engines = web_search.get("engines")?.as_array()?;
    let suffix = format!(".{}", model_id);
    for entry in engines {
        let row = match entry.as_object() {
            Some(v) => v,
            None => continue,
        };
        let execution_mode = row
            .get("executionMode")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim()
            .to_ascii_lowercase();
        if execution_mode != "direct" {
            continue;
        }
        let direct_activation = row
            .get("directActivation")
            .and_then(|v| v.as_str())
            .unwrap_or("route")
            .trim()
            .to_ascii_lowercase();
        if direct_activation != "builtin" {
            continue;
        }
        let configured_model_id = row
            .get("modelId")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim();
        if !configured_model_id.is_empty() {
            if configured_model_id == model_id {
                return Some(row);
            }
            continue;
        }
        let provider_key = row
            .get("providerKey")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim();
        if provider_key.ends_with(suffix.as_str()) {
            return Some(row);
        }
    }
    None
}

fn build_builtin_web_search_tool(max_uses: i64) -> Value {
    let mut builtin_tool = Map::<String, Value>::new();
    builtin_tool.insert(
        "type".to_string(),
        Value::String("web_search_20250305".to_string()),
    );
    builtin_tool.insert("name".to_string(), Value::String("web_search".to_string()));
    builtin_tool.insert(
        "max_uses".to_string(),
        Value::Number(serde_json::Number::from(max_uses)),
    );
    Value::Object(builtin_tool)
}

fn apply_direct_builtin_web_search_tool(
    provider_payload: &Value,
    provider_protocol: &str,
    route_id: &Value,
    runtime_metadata: &Value,
) -> Value {
    let mut payload = value_as_object_or_empty(provider_payload);
    if provider_protocol.trim() != "anthropic-messages" {
        return Value::Object(payload);
    }
    if !is_search_route_id(route_id) {
        return Value::Object(payload);
    }
    let model_id = payload
        .get("model")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim();
    if model_id.is_empty() {
        return Value::Object(payload);
    }
    let runtime_metadata_obj = match runtime_metadata.as_object() {
        Some(v) => v,
        None => return Value::Object(payload),
    };
    let matched_engine = match find_direct_builtin_web_search_engine(runtime_metadata_obj, model_id)
    {
        Some(v) => v,
        None => return Value::Object(payload),
    };

    let raw_max_uses = parse_js_number_like(matched_engine.get("maxUses"));
    let max_uses = match raw_max_uses {
        Some(value) if value.is_finite() && value > 0.0 => value.floor() as i64,
        _ => 2,
    };
    let builtin_tool = build_builtin_web_search_tool(max_uses);

    let tools = payload
        .get("tools")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let mut replaced = false;
    let mut next_tools = Vec::<Value>::new();
    for tool in tools {
        if !replaced && is_canonical_web_search_tool_definition(&tool) {
            next_tools.push(builtin_tool.clone());
            replaced = true;
            continue;
        }
        if is_canonical_web_search_tool_definition(&tool) {
            continue;
        }
        next_tools.push(tool);
    }
    if !replaced {
        next_tools.insert(0, builtin_tool);
    }
    payload.insert("tools".to_string(), Value::Array(next_tools));
    Value::Object(payload)
}

fn lift_responses_resume_into_semantics(request: &Value, metadata: &Value) -> Value {
    let mut output = Map::<String, Value>::new();
    let mut next_metadata = value_as_object_or_empty(metadata);
    let resume = read_responses_resume_from_metadata(metadata);
    let continuation = synthesize_continuation_from_responses_resume(resume.as_ref());

    if resume.is_none() && continuation.is_none() {
        output.insert("request".to_string(), request.clone());
        output.insert("metadata".to_string(), Value::Object(next_metadata));
        return Value::Object(output);
    }

    let mut next_request = value_as_object_or_empty(request);
    let semantics = next_request
        .entry("semantics".to_string())
        .or_insert_with(|| Value::Object(Map::new()));
    if !semantics.is_object() {
        *semantics = Value::Object(Map::new());
    }
    let semantics_obj = semantics
        .as_object_mut()
        .expect("semantics should be object after normalization");
    if !semantics_obj.contains_key("continuation") {
        if let Some(continuation_value) = continuation {
            semantics_obj.insert("continuation".to_string(), continuation_value);
        }
    }
    let responses = semantics_obj
        .entry("responses".to_string())
        .or_insert_with(|| Value::Object(Map::new()));
    if !responses.is_object() {
        *responses = Value::Object(Map::new());
    }
    let responses_obj = responses
        .as_object_mut()
        .expect("responses should be object after normalization");
    if !responses_obj.contains_key("resume") {
        if let Some(resume_value) = resume {
            responses_obj.insert("resume".to_string(), resume_value);
        }
    }

    next_metadata.remove("responsesResume");
    output.insert("request".to_string(), Value::Object(next_request));
    output.insert("metadata".to_string(), Value::Object(next_metadata));
    Value::Object(output)
}

fn sync_responses_context_from_canonical_messages(request: &Value) -> Value {
    let mut next_request = value_as_object_or_empty(request);
    let messages = next_request
        .get("messages")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let tools = next_request
        .get("tools")
        .and_then(|v| v.as_array())
        .cloned();
    let semantics = match next_request.get_mut("semantics") {
        Some(v) if v.is_object() => v,
        _ => return Value::Object(next_request),
    };
    let semantics_obj = match semantics.as_object_mut() {
        Some(v) => v,
        None => return Value::Object(next_request),
    };
    let responses = match semantics_obj.get_mut("responses") {
        Some(v) if v.is_object() => v,
        _ => return Value::Object(next_request),
    };
    let responses_obj = match responses.as_object_mut() {
        Some(v) => v,
        None => return Value::Object(next_request),
    };
    let context = match responses_obj.get_mut("context") {
        Some(v) if v.is_object() => v,
        _ => return Value::Object(next_request),
    };
    let context_obj = match context.as_object_mut() {
        Some(v) => v,
        None => return Value::Object(next_request),
    };

    let bridge = build_bridge_history(BuildBridgeHistoryInput { messages, tools });
    let bridge_input = serde_json::to_value(bridge.input).unwrap_or_else(|_| Value::Array(vec![]));
    let original_system_messages = serde_json::to_value(bridge.original_system_messages)
        .unwrap_or_else(|_| Value::Array(vec![]));

    context_obj.insert("input".to_string(), bridge_input);
    context_obj.insert(
        "originalSystemMessages".to_string(),
        original_system_messages,
    );
    Value::Object(next_request)
}

fn is_passthrough_canonical_chat_key(key: &str) -> bool {
    matches!(
        key,
        "model" | "messages" | "tools" | "parameters" | "metadata" | "semantics" | "stream"
    )
}

fn value_as_object_or_empty(value: &Value) -> Map<String, Value> {
    value.as_object().cloned().unwrap_or_default()
}

fn collect_passthrough_todo_top_level_keys(payload: &Map<String, Value>) -> Vec<Value> {
    let mut keys = payload
        .keys()
        .filter(|key| !is_passthrough_canonical_chat_key(key.as_str()))
        .cloned()
        .collect::<Vec<String>>();
    keys.sort();
    keys.into_iter().map(Value::String).collect::<Vec<Value>>()
}

fn build_passthrough_audit(raw_inbound: &Value, provider_protocol: &str) -> Value {
    let inbound_record = value_as_object_or_empty(raw_inbound);
    let mut raw = Map::<String, Value>::new();
    raw.insert("inbound".to_string(), Value::Object(inbound_record.clone()));

    let mut inbound_todo = Map::<String, Value>::new();
    inbound_todo.insert(
        "unmappedTopLevelKeys".to_string(),
        Value::Array(collect_passthrough_todo_top_level_keys(&inbound_record)),
    );
    inbound_todo.insert(
        "providerProtocol".to_string(),
        Value::String(provider_protocol.to_string()),
    );
    inbound_todo.insert(
        "note".to_string(),
        Value::String("passthrough_mode_parse_record_only".to_string()),
    );

    let mut todo = Map::<String, Value>::new();
    todo.insert("inbound".to_string(), Value::Object(inbound_todo));

    let mut out = Map::<String, Value>::new();
    out.insert("raw".to_string(), Value::Object(raw));
    out.insert("todo".to_string(), Value::Object(todo));
    Value::Object(out)
}

fn ensure_object_field_mut<'a>(
    root: &'a mut Map<String, Value>,
    key: &str,
) -> &'a mut Map<String, Value> {
    if !root.get(key).and_then(|v| v.as_object()).is_some() {
        root.insert(key.to_string(), Value::Object(Map::new()));
    }
    root.get_mut(key)
        .and_then(|v| v.as_object_mut())
        .expect("object field")
}

fn annotate_passthrough_governance_skip(audit: &Value) -> Value {
    let mut out = value_as_object_or_empty(audit);
    let todo = ensure_object_field_mut(&mut out, "todo");
    let mut governance = Map::<String, Value>::new();
    governance.insert("skipped".to_string(), Value::Bool(true));
    governance.insert(
        "reason".to_string(),
        Value::String("process_mode_passthrough".to_string()),
    );
    todo.insert("governance".to_string(), Value::Object(governance));
    Value::Object(out)
}

fn attach_passthrough_provider_input_audit(
    audit: &Value,
    provider_payload: &Value,
    provider_protocol: &str,
) -> Value {
    let mut out = value_as_object_or_empty(audit);
    let provider_record = value_as_object_or_empty(provider_payload);
    {
        let raw = ensure_object_field_mut(&mut out, "raw");
        raw.insert(
            "providerInput".to_string(),
            Value::Object(provider_record.clone()),
        );
    }
    {
        let todo = ensure_object_field_mut(&mut out, "todo");
        let mut outbound = Map::<String, Value>::new();
        outbound.insert(
            "unmappedTopLevelKeys".to_string(),
            Value::Array(collect_passthrough_todo_top_level_keys(&provider_record)),
        );
        outbound.insert(
            "providerProtocol".to_string(),
            Value::String(provider_protocol.to_string()),
        );
        outbound.insert(
            "note".to_string(),
            Value::String("provider_payload_not_mapped_back_to_chat_semantics".to_string()),
        );
        todo.insert("outbound".to_string(), Value::Object(outbound));
    }
    Value::Object(out)
}

fn extract_message_text_from_value(message: &Value) -> String {
    let Some(record) = message.as_object() else {
        return String::new();
    };
    if let Some(content) = record.get("content").and_then(|v| v.as_str()) {
        if !content.trim().is_empty() {
            return content.to_string();
        }
    }
    let Some(content_parts) = record.get("content").and_then(|v| v.as_array()) else {
        return String::new();
    };
    let mut parts: Vec<String> = Vec::new();
    for entry in content_parts {
        if let Some(text) = entry.as_str() {
            if !text.trim().is_empty() {
                parts.push(text.to_string());
            }
            continue;
        }
        let Some(part_obj) = entry.as_object() else {
            continue;
        };
        if let Some(text) = part_obj.get("text").and_then(|v| v.as_str()) {
            if !text.trim().is_empty() {
                parts.push(text.to_string());
                continue;
            }
        }
        if let Some(text) = part_obj.get("content").and_then(|v| v.as_str()) {
            if !text.trim().is_empty() {
                parts.push(text.to_string());
            }
        }
    }
    let joined = parts.join("\n");
    let trimmed = joined.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    trimmed.to_string()
}

fn strip_code_segments(text: &str) -> String {
    if text.is_empty() {
        return String::new();
    }
    let fenced_backticks = Regex::new(r"(?s)```.*?```").unwrap();
    let fenced_tildes = Regex::new(r"(?s)~~~.*?~~~").unwrap();
    let inline_code = Regex::new(r"`[^`]*`").unwrap();
    let sanitized = fenced_backticks.replace_all(text, " ");
    let sanitized = fenced_tildes.replace_all(&sanitized, " ");
    inline_code.replace_all(&sanitized, " ").into_owned()
}

fn normalize_instruction_leading(content: &str) -> String {
    let mut char_indices = content.char_indices();
    let mut start = 0usize;
    while let Some((idx, ch)) = char_indices.next() {
        let is_zero_width = ch == '\u{200B}'
            || ch == '\u{200C}'
            || ch == '\u{200D}'
            || ch == '\u{2060}'
            || ch == '\u{FEFF}';
        if is_zero_width {
            start = idx + ch.len_utf8();
            continue;
        }
        break;
    }
    content[start..].trim_start().to_string()
}

fn split_instruction_targets(content: &str) -> Vec<String> {
    content
        .split(',')
        .map(|segment| segment.trim().to_string())
        .filter(|segment| !segment.is_empty())
        .collect()
}

fn normalize_split_stop_message_head_token(token: &str) -> String {
    let normalized = normalize_instruction_leading(token);
    normalized
        .trim_matches(|ch| ch == '"' || ch == '\'')
        .trim()
        .to_string()
}

fn recover_split_stop_message_instruction(tokens: &[String]) -> Option<String> {
    if tokens.len() < 2 {
        return None;
    }
    let head = normalize_split_stop_message_head_token(tokens[0].as_str());
    if !head.eq_ignore_ascii_case("stopmessage") {
        return None;
    }
    let tail = tokens[1..].join(",").trim().to_string();
    if tail.is_empty() {
        return None;
    }
    Some(format!("stopMessage:{}", tail))
}

fn normalize_stop_message_command_prefix(content: &str) -> String {
    let normalized = normalize_instruction_leading(content);
    let re = Regex::new(r#"^(?:"|')?stopMessage(?:"|')?\s*([:,])"#).unwrap();
    re.replace(&normalized, "stopMessage$1").to_string()
}

fn expand_instruction_segments(instruction: &str) -> Vec<String> {
    let trimmed = instruction.trim();
    if trimmed.is_empty() {
        return Vec::new();
    }
    let normalized_leading = normalize_instruction_leading(trimmed);
    let stop_message_re = Regex::new(r#"^(?:"|')?stopMessage(?:"|')?\s*[:,]"#).unwrap();
    if stop_message_re.is_match(&normalized_leading) {
        return vec![normalize_stop_message_command_prefix(&normalized_leading)];
    }
    let pre_command_re = Regex::new(r"(?i)^precommand(?:\s*:|$)").unwrap();
    if pre_command_re.is_match(&normalized_leading) {
        return vec![normalized_leading];
    }

    let mut chars = trimmed.chars();
    let prefix = chars.next().unwrap_or_default();
    if prefix == '!' || prefix == '#' || prefix == '@' {
        let targets = split_instruction_targets(chars.as_str());
        return targets
            .iter()
            .map(|token| {
                token
                    .trim_start_matches(|ch| ch == '!' || ch == '#' || ch == '@')
                    .trim()
                    .to_string()
            })
            .filter(|token| !token.is_empty())
            .map(|token| format!("{}{}", prefix, token))
            .collect();
    }

    let split_tokens = split_instruction_targets(trimmed);
    if let Some(recovered) = recover_split_stop_message_instruction(split_tokens.as_slice()) {
        return vec![recovered];
    }
    split_tokens
}

fn is_valid_identifier(id: &str) -> bool {
    Regex::new(r"^[a-zA-Z0-9_-]+$").unwrap().is_match(id)
}

fn is_valid_model_token(token: &str) -> bool {
    Regex::new(r"^[a-zA-Z0-9_.-]+$").unwrap().is_match(token)
}

fn parse_target_is_valid(target: &str) -> bool {
    if target.is_empty() {
        return false;
    }
    let bracket_re = Regex::new(r"^([a-zA-Z0-9_-]+)\[([a-zA-Z0-9_-]*)\](?:\.(.+))?$").unwrap();
    if let Some(captures) = bracket_re.captures(target) {
        let provider = captures.get(1).map(|m| m.as_str()).unwrap_or("").trim();
        let key_alias = captures.get(2).map(|m| m.as_str()).unwrap_or("").trim();
        let model = captures.get(3).map(|m| m.as_str()).unwrap_or("").trim();
        if provider.is_empty() || !is_valid_identifier(provider) {
            return false;
        }
        if key_alias.is_empty() {
            return model.is_empty() || is_valid_model_token(model);
        }
        if !is_valid_identifier(key_alias) {
            return false;
        }
        return model.is_empty() || is_valid_model_token(model);
    }

    let Some(first_dot) = target.find('.') else {
        let provider = target.trim();
        return !provider.is_empty() && is_valid_identifier(provider);
    };
    let provider = target[..first_dot].trim();
    let remainder = target[first_dot + 1..].trim();
    if provider.is_empty() || remainder.is_empty() || !is_valid_identifier(provider) {
        return false;
    }
    if remainder.chars().all(|ch| ch.is_ascii_digit()) {
        return remainder.parse::<u32>().map(|v| v > 0).unwrap_or(false);
    }
    is_valid_model_token(remainder)
}

fn split_target_and_process_mode(raw_target: &str) -> (String, Option<String>) {
    let trimmed = raw_target.trim();
    if trimmed.is_empty() {
        return (String::new(), None);
    }
    let Some(separator_index) = trimmed.rfind(':') else {
        return (trimmed.to_string(), None);
    };
    if separator_index == 0 || separator_index + 1 >= trimmed.len() {
        return (trimmed.to_string(), None);
    }
    let target = trimmed[..separator_index].trim();
    let mode_token = trimmed[separator_index + 1..].trim().to_ascii_lowercase();
    if target.is_empty() {
        return (trimmed.to_string(), None);
    }
    match mode_token.as_str() {
        "passthrough" => (target.to_string(), Some("passthrough".to_string())),
        "chat" => (target.to_string(), Some("chat".to_string())),
        _ => (target.to_string(), None),
    }
}

fn parse_named_target_instruction_requests_passthrough(instruction: &str, prefix: &str) -> bool {
    let re = Regex::new(format!(r"(?i)^{}\s*:", regex::escape(prefix)).as_str()).unwrap();
    if !re.is_match(instruction) {
        return false;
    }
    let body_start = instruction.find(':').unwrap_or(0);
    let body = instruction[body_start + 1..].trim();
    if body.is_empty() {
        return false;
    }
    let (target, process_mode) = split_target_and_process_mode(body);
    if !parse_target_is_valid(target.as_str()) {
        return false;
    }
    matches!(process_mode.as_deref(), Some("passthrough"))
}

fn parse_single_instruction_requests_passthrough(instruction: &str) -> bool {
    if parse_named_target_instruction_requests_passthrough(instruction, "sticky")
        || parse_named_target_instruction_requests_passthrough(instruction, "force")
        || parse_named_target_instruction_requests_passthrough(instruction, "prefer")
    {
        return true;
    }
    if instruction.starts_with('!') {
        let raw_target = instruction[1..].trim();
        let (target, process_mode) = split_target_and_process_mode(raw_target);
        if target.is_empty() || !parse_target_is_valid(target.as_str()) {
            return false;
        }
        if !target.contains('.') {
            return false;
        }
        return matches!(process_mode.as_deref(), Some("passthrough"));
    }
    false
}

fn resolve_has_instruction_requested_passthrough(messages: &Value) -> bool {
    let Some(rows) = messages.as_array() else {
        return false;
    };
    if rows.is_empty() {
        return false;
    }
    let latest = match rows.last().and_then(|v| v.as_object()) {
        Some(v) => v,
        None => return false,
    };
    if latest
        .get("role")
        .and_then(|v| v.as_str())
        .map(|v| v == "user")
        != Some(true)
    {
        return false;
    }
    let content = extract_message_text_from_value(&Value::Object(latest.clone()));
    if content.is_empty() {
        return false;
    }
    let sanitized = strip_code_segments(content.as_str());
    if sanitized.is_empty() {
        return false;
    }
    let marker_re = Regex::new(r"(?s)<\*\*(.*?)\*\*>").unwrap();
    if !marker_re.is_match(&sanitized) {
        return false;
    }
    for captures in marker_re.captures_iter(&sanitized) {
        let instruction = captures
            .get(1)
            .map(|m| m.as_str().trim().to_string())
            .unwrap_or_default();
        if instruction.is_empty() {
            continue;
        }
        for segment in expand_instruction_segments(instruction.as_str()) {
            if parse_single_instruction_requests_passthrough(segment.as_str()) {
                return true;
            }
        }
    }
    false
}

fn resolve_active_process_mode(base_mode: &str, messages: &Value) -> String {
    if base_mode.eq_ignore_ascii_case("passthrough") {
        return "passthrough".to_string();
    }
    if resolve_has_instruction_requested_passthrough(messages) {
        return "passthrough".to_string();
    }
    "chat".to_string()
}

fn find_mappable_semantics_keys(metadata: &Value) -> Vec<String> {
    let Some(row) = metadata.as_object() else {
        return Vec::new();
    };
    let banned = [
        "responsesResume",
        "responses_resume",
        "clientToolsRaw",
        "client_tools_raw",
        "anthropicToolNameMap",
        "anthropic_tool_name_map",
        "responsesContext",
        "responses_context",
        "responseFormat",
        "response_format",
        "systemInstructions",
        "system_instructions",
        "toolsFieldPresent",
        "tools_field_present",
        "extraFields",
        "extra_fields",
    ];
    banned
        .iter()
        .filter(|key| row.contains_key(**key))
        .map(|key| key.to_string())
        .collect()
}

pub fn run_hub_pipeline(input: HubPipelineInput) -> Result<HubPipelineOutput, String> {
    let request_id = input.request_id.clone();
    let endpoint = normalize_endpoint(&input.endpoint);
    let entry_endpoint = normalize_endpoint(&input.entry_endpoint);
    let provider_protocol = resolve_provider_protocol(&input.provider_protocol)
        .map_err(|e| format!("Protocol resolution failed: {}", e))?;
    if !input.payload.is_object() && !input.payload.is_array() {
        return Err("Payload must be a JSON object or array".to_string());
    }
    let payload = input.payload.clone();

    let mut output_metadata = input.metadata.as_object().cloned().unwrap_or_default();
    output_metadata.insert("endpoint".to_string(), Value::String(endpoint));
    output_metadata.insert(
        "entryEndpoint".to_string(),
        Value::String(entry_endpoint.clone()),
    );
    output_metadata.insert(
        "providerProtocol".to_string(),
        Value::String(provider_protocol.clone()),
    );

    let mut stream = input.stream;
    if !stream {
        stream = output_metadata
            .get("stream")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
    }
    if !stream {
        stream = payload
            .as_object()
            .and_then(|row| row.get("stream"))
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
    }
    output_metadata.insert("stream".to_string(), Value::Bool(stream));

    let base_process_mode = if input.process_mode.eq_ignore_ascii_case("passthrough") {
        "passthrough".to_string()
    } else {
        "chat".to_string()
    };
    let active_process_mode = payload
        .as_object()
        .and_then(|row| row.get("messages"))
        .map(|messages| resolve_active_process_mode(base_process_mode.as_str(), messages))
        .unwrap_or(base_process_mode);
    output_metadata.insert(
        "processMode".to_string(),
        Value::String(active_process_mode),
    );

    let direction = if input.direction.eq_ignore_ascii_case("response") {
        "response".to_string()
    } else {
        "request".to_string()
    };
    output_metadata.insert("direction".to_string(), Value::String(direction));

    let stage = if input.stage.eq_ignore_ascii_case("outbound") {
        "outbound".to_string()
    } else {
        "inbound".to_string()
    };
    output_metadata.insert("stage".to_string(), Value::String(stage));

    let route_hint = output_metadata
        .get("routeHint")
        .and_then(|v| v.as_str())
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty());
    if let Some(hint) = route_hint {
        output_metadata.insert("routeHint".to_string(), Value::String(hint));
    } else {
        output_metadata.remove("routeHint");
    }

    let stop_message_router_metadata =
        resolve_stop_message_router_metadata(&Value::Object(output_metadata.clone()));
    if let Some(row) = stop_message_router_metadata.as_object() {
        for (key, value) in row {
            output_metadata.insert(key.clone(), value.clone());
        }
    }

    let apply_patch_tool_mode = resolve_apply_patch_tool_mode_from_env().or_else(|| {
        payload
            .as_object()
            .and_then(|row| row.get("tools"))
            .and_then(resolve_apply_patch_tool_mode_from_tools)
    });
    if let Some(mode) = apply_patch_tool_mode {
        if !output_metadata
            .get("runtime")
            .and_then(|v| v.as_object())
            .is_some()
        {
            output_metadata.insert("runtime".to_string(), Value::Object(Map::new()));
        }
        if let Some(runtime) = output_metadata
            .get_mut("runtime")
            .and_then(|v| v.as_object_mut())
        {
            runtime.insert("applyPatchToolMode".to_string(), Value::String(mode));
        }
    }

    output_metadata.insert(
        "processedAt".to_string(),
        Value::String(chrono::Utc::now().to_rfc3339()),
    );

    Ok(HubPipelineOutput {
        request_id,
        success: true,
        payload: Some(payload),
        metadata: Some(Value::Object(output_metadata)),
        error: None,
    })
}

pub fn run_req_inbound_pipeline(
    payload: Value,
    protocol: &str,
    endpoint: &str,
) -> Result<FormatEnvelope, String> {
    if payload.is_null() {
        return Err("Request payload cannot be null".to_string());
    }

    let normalized_protocol = resolve_provider_protocol(protocol)?;

    Ok(FormatEnvelope {
        protocol: normalized_protocol,
        payload,
        metadata: Some(serde_json::json!({
            "endpoint": endpoint,
            "processed": true
        })),
    })
}

pub fn run_req_process_pipeline(
    envelope: ChatEnvelope,
    routing: RoutingDecision,
) -> Result<ProcessedRequest, String> {
    if envelope.messages.is_empty() {
        return Err("Chat envelope must contain at least one message".to_string());
    }

    let request = serde_json::json!({
        "messages": envelope.messages,
        "semantics": envelope.semantics,
    });

    Ok(ProcessedRequest {
        request,
        routing,
        metadata: envelope.metadata,
    })
}

pub fn run_resp_outbound_pipeline(
    payload: Value,
    protocol: &str,
) -> Result<FormatEnvelope, String> {
    let normalized_protocol = resolve_provider_protocol(protocol)?;

    Ok(FormatEnvelope {
        protocol: normalized_protocol,
        payload,
        metadata: None,
    })
}

#[napi_derive::napi]
pub fn normalize_hub_endpoint_json(endpoint: String) -> napi::Result<String> {
    let output = normalize_endpoint(&endpoint);
    serde_json::to_string(&output)
        .map_err(|e| napi::Error::from_reason(format!("Failed to serialize endpoint: {}", e)))
}

#[napi_derive::napi]
pub fn resolve_provider_protocol_json(value: String) -> napi::Result<String> {
    let output = resolve_provider_protocol(&value).map_err(|e| napi::Error::from_reason(e))?;
    serde_json::to_string(&output).map_err(|e| {
        napi::Error::from_reason(format!("Failed to serialize provider protocol: {}", e))
    })
}

#[napi_derive::napi]
pub fn resolve_hub_client_protocol_json(entry_endpoint: String) -> napi::Result<String> {
    let output = resolve_hub_client_protocol(&entry_endpoint);
    serde_json::to_string(&output).map_err(|e| {
        napi::Error::from_reason(format!("Failed to serialize hub client protocol: {}", e))
    })
}

#[napi_derive::napi]
pub fn resolve_outbound_stream_intent_json(
    provider_preference_json: String,
) -> napi::Result<String> {
    let provider_preference: Value =
        serde_json::from_str(&provider_preference_json).map_err(|e| {
            napi::Error::from_reason(format!("Failed to parse provider preference JSON: {}", e))
        })?;
    let output = resolve_outbound_stream_intent(&provider_preference);
    serde_json::to_string(&output).map_err(|e| {
        napi::Error::from_reason(format!("Failed to serialize outbound stream intent: {}", e))
    })
}

#[napi_derive::napi]
pub fn apply_outbound_stream_preference_json(
    request_json: String,
    stream_json: String,
    process_mode_json: String,
) -> napi::Result<String> {
    let request: Value = serde_json::from_str(&request_json)
        .map_err(|e| napi::Error::from_reason(format!("Failed to parse request JSON: {}", e)))?;
    let stream_value: Value = serde_json::from_str(&stream_json)
        .map_err(|e| napi::Error::from_reason(format!("Failed to parse stream JSON: {}", e)))?;
    let process_mode_value: Value = serde_json::from_str(&process_mode_json).map_err(|e| {
        napi::Error::from_reason(format!("Failed to parse process mode JSON: {}", e))
    })?;
    let stream = stream_value.as_bool();
    let process_mode = process_mode_value.as_str();
    let output = apply_outbound_stream_preference(&request, stream, process_mode);
    serde_json::to_string(&output).map_err(|e| {
        napi::Error::from_reason(format!(
            "Failed to serialize stream preference output: {}",
            e
        ))
    })
}

#[napi_derive::napi]
pub fn resolve_sse_protocol_from_metadata_json(metadata_json: String) -> napi::Result<String> {
    let metadata: Value = serde_json::from_str(&metadata_json)
        .map_err(|e| napi::Error::from_reason(format!("Failed to parse metadata JSON: {}", e)))?;
    let output = resolve_sse_protocol_from_metadata(&metadata);
    serde_json::to_string(&output)
        .map_err(|e| napi::Error::from_reason(format!("Failed to serialize sse protocol: {}", e)))
}

#[napi_derive::napi]
pub fn resolve_sse_protocol_json(
    metadata_json: String,
    provider_protocol: String,
) -> napi::Result<String> {
    let metadata: Value = serde_json::from_str(&metadata_json)
        .map_err(|e| napi::Error::from_reason(format!("Failed to parse metadata JSON: {}", e)))?;
    let output = resolve_sse_protocol(&metadata, provider_protocol.as_str());
    serde_json::to_string(&output)
        .map_err(|e| napi::Error::from_reason(format!("Failed to serialize sse protocol: {}", e)))
}

#[napi_derive::napi]
pub fn extract_model_hint_from_metadata_json(metadata_json: String) -> napi::Result<String> {
    let metadata: Value = serde_json::from_str(&metadata_json)
        .map_err(|e| napi::Error::from_reason(format!("Failed to parse metadata JSON: {}", e)))?;
    let output = extract_model_hint_from_metadata(&metadata);
    serde_json::to_string(&output)
        .map_err(|e| napi::Error::from_reason(format!("Failed to serialize model hint: {}", e)))
}

#[napi_derive::napi]
pub fn resolve_stop_message_router_metadata_json(metadata_json: String) -> napi::Result<String> {
    let metadata: Value = serde_json::from_str(&metadata_json)
        .map_err(|e| napi::Error::from_reason(format!("Failed to parse metadata JSON: {}", e)))?;
    let output = resolve_stop_message_router_metadata(&metadata);
    serde_json::to_string(&output).map_err(|e| {
        napi::Error::from_reason(format!(
            "Failed to serialize stop-message router metadata: {}",
            e
        ))
    })
}

#[napi_derive::napi]
pub fn resolve_router_metadata_runtime_flags_json(metadata_json: String) -> napi::Result<String> {
    let metadata: Value = serde_json::from_str(&metadata_json)
        .map_err(|e| napi::Error::from_reason(format!("Failed to parse metadata JSON: {}", e)))?;
    let output = resolve_router_metadata_runtime_flags(&metadata);
    serde_json::to_string(&output).map_err(|e| {
        napi::Error::from_reason(format!(
            "Failed to serialize router metadata runtime flags: {}",
            e
        ))
    })
}

#[napi_derive::napi]
pub fn build_router_metadata_input_json(input_json: String) -> napi::Result<String> {
    let input: Value = serde_json::from_str(&input_json)
        .map_err(|e| napi::Error::from_reason(format!("Failed to parse input JSON: {}", e)))?;
    let output = build_router_metadata_input(&input).map_err(|e| {
        napi::Error::from_reason(format!("Failed to build router metadata input: {}", e))
    })?;
    serde_json::to_string(&output).map_err(|e| {
        napi::Error::from_reason(format!("Failed to serialize router metadata input: {}", e))
    })
}

#[napi_derive::napi]
pub fn build_hub_pipeline_result_metadata_json(input_json: String) -> napi::Result<String> {
    let input: Value = serde_json::from_str(&input_json)
        .map_err(|e| napi::Error::from_reason(format!("Failed to parse input JSON: {}", e)))?;
    let output = build_hub_pipeline_result_metadata(&input).map_err(|e| {
        napi::Error::from_reason(format!(
            "Failed to build hub pipeline result metadata: {}",
            e
        ))
    })?;
    serde_json::to_string(&output).map_err(|e| {
        napi::Error::from_reason(format!(
            "Failed to serialize hub pipeline result metadata: {}",
            e
        ))
    })
}

#[napi_derive::napi]
pub fn build_req_outbound_node_result_json(input_json: String) -> napi::Result<String> {
    let input: Value = serde_json::from_str(&input_json)
        .map_err(|e| napi::Error::from_reason(format!("Failed to parse input JSON: {}", e)))?;
    let output = build_req_outbound_node_result(&input).map_err(|e| {
        napi::Error::from_reason(format!("Failed to build req outbound node result: {}", e))
    })?;
    serde_json::to_string(&output).map_err(|e| {
        napi::Error::from_reason(format!(
            "Failed to serialize req outbound node result: {}",
            e
        ))
    })
}

#[napi_derive::napi]
pub fn build_req_inbound_node_result_json(input_json: String) -> napi::Result<String> {
    let input: Value = serde_json::from_str(&input_json)
        .map_err(|e| napi::Error::from_reason(format!("Failed to parse input JSON: {}", e)))?;
    let output = build_req_inbound_node_result(&input).map_err(|e| {
        napi::Error::from_reason(format!("Failed to build req inbound node result: {}", e))
    })?;
    serde_json::to_string(&output).map_err(|e| {
        napi::Error::from_reason(format!(
            "Failed to serialize req inbound node result: {}",
            e
        ))
    })
}

#[napi_derive::napi]
pub fn build_req_inbound_skipped_node_json(input_json: String) -> napi::Result<String> {
    let input: Value = serde_json::from_str(&input_json)
        .map_err(|e| napi::Error::from_reason(format!("Failed to parse input JSON: {}", e)))?;
    let output = build_req_inbound_skipped_node(&input).map_err(|e| {
        napi::Error::from_reason(format!("Failed to build req inbound skipped node: {}", e))
    })?;
    serde_json::to_string(&output).map_err(|e| {
        napi::Error::from_reason(format!(
            "Failed to serialize req inbound skipped node: {}",
            e
        ))
    })
}

#[napi_derive::napi]
pub fn build_captured_chat_request_snapshot_json(input_json: String) -> napi::Result<String> {
    let input: Value = serde_json::from_str(&input_json)
        .map_err(|e| napi::Error::from_reason(format!("Failed to parse input JSON: {}", e)))?;
    let output = build_captured_chat_request_snapshot(&input).map_err(|e| {
        napi::Error::from_reason(format!(
            "Failed to build captured chat request snapshot: {}",
            e
        ))
    })?;
    serde_json::to_string(&output).map_err(|e| {
        napi::Error::from_reason(format!(
            "Failed to serialize captured chat request snapshot: {}",
            e
        ))
    })
}

#[napi_derive::napi]
pub fn coerce_standardized_request_from_payload_json(input_json: String) -> napi::Result<String> {
    let input: Value = serde_json::from_str(&input_json)
        .map_err(|e| napi::Error::from_reason(format!("Failed to parse input JSON: {}", e)))?;
    let output = coerce_standardized_request_from_payload(&input).map_err(|e| {
        napi::Error::from_reason(format!(
            "Failed to coerce standardized request from payload: {}",
            e
        ))
    })?;
    serde_json::to_string(&output).map_err(|e| {
        napi::Error::from_reason(format!(
            "Failed to serialize standardized request coercion output: {}",
            e
        ))
    })
}

#[napi_derive::napi]
pub fn prepare_runtime_metadata_for_servertools_json(input_json: String) -> napi::Result<String> {
    let input: Value = serde_json::from_str(&input_json)
        .map_err(|e| napi::Error::from_reason(format!("Failed to parse input JSON: {}", e)))?;
    let output = prepare_runtime_metadata_for_servertools(&input).map_err(|e| {
        napi::Error::from_reason(format!(
            "Failed to prepare runtime metadata for servertools: {}",
            e
        ))
    })?;
    serde_json::to_string(&output).map_err(|e| {
        napi::Error::from_reason(format!(
            "Failed to serialize runtime metadata for servertools: {}",
            e
        ))
    })
}

#[napi_derive::napi]
pub fn apply_has_image_attachment_flag_json(input_json: String) -> napi::Result<String> {
    let input: Value = serde_json::from_str(&input_json)
        .map_err(|e| napi::Error::from_reason(format!("Failed to parse input JSON: {}", e)))?;
    let output = apply_has_image_attachment_flag(&input).map_err(|e| {
        napi::Error::from_reason(format!(
            "Failed to apply has-image-attachment metadata flag: {}",
            e
        ))
    })?;
    serde_json::to_string(&output).map_err(|e| {
        napi::Error::from_reason(format!(
            "Failed to serialize has-image-attachment metadata result: {}",
            e
        ))
    })
}

#[napi_derive::napi]
pub fn sync_session_identifiers_to_metadata_json(input_json: String) -> napi::Result<String> {
    let input: Value = serde_json::from_str(&input_json)
        .map_err(|e| napi::Error::from_reason(format!("Failed to parse input JSON: {}", e)))?;
    let output = sync_session_identifiers_to_metadata(&input).map_err(|e| {
        napi::Error::from_reason(format!(
            "Failed to sync session identifiers to metadata: {}",
            e
        ))
    })?;
    serde_json::to_string(&output).map_err(|e| {
        napi::Error::from_reason(format!(
            "Failed to serialize synced session identifier metadata: {}",
            e
        ))
    })
}

#[napi_derive::napi]
pub fn merge_clock_reservation_into_metadata_json(input_json: String) -> napi::Result<String> {
    let input: Value = serde_json::from_str(&input_json)
        .map_err(|e| napi::Error::from_reason(format!("Failed to parse input JSON: {}", e)))?;
    let output = merge_clock_reservation_into_metadata(&input).map_err(|e| {
        napi::Error::from_reason(format!(
            "Failed to merge clock reservation into metadata: {}",
            e
        ))
    })?;
    serde_json::to_string(&output).map_err(|e| {
        napi::Error::from_reason(format!(
            "Failed to serialize merged clock reservation metadata: {}",
            e
        ))
    })
}

#[napi_derive::napi]
pub fn build_tool_governance_node_result_json(input_json: String) -> napi::Result<String> {
    let input: Value = serde_json::from_str(&input_json)
        .map_err(|e| napi::Error::from_reason(format!("Failed to parse input JSON: {}", e)))?;
    let output = build_tool_governance_node_result(&input).map_err(|e| {
        napi::Error::from_reason(format!(
            "Failed to build tool governance node result: {}",
            e
        ))
    })?;
    serde_json::to_string(&output).map_err(|e| {
        napi::Error::from_reason(format!(
            "Failed to serialize tool governance node result: {}",
            e
        ))
    })
}

#[napi_derive::napi]
pub fn build_passthrough_governance_skipped_node_json() -> napi::Result<String> {
    let output = build_passthrough_governance_skipped_node();
    serde_json::to_string(&output).map_err(|e| {
        napi::Error::from_reason(format!(
            "Failed to serialize passthrough governance skipped node: {}",
            e
        ))
    })
}

#[napi_derive::napi]
pub fn extract_adapter_context_metadata_fields_json(
    metadata_json: String,
    keys_json: String,
) -> napi::Result<String> {
    let metadata: Value = serde_json::from_str(&metadata_json)
        .map_err(|e| napi::Error::from_reason(format!("Failed to parse metadata JSON: {}", e)))?;
    let keys: Value = serde_json::from_str(&keys_json)
        .map_err(|e| napi::Error::from_reason(format!("Failed to parse keys JSON: {}", e)))?;
    let output = extract_adapter_context_metadata_fields(&metadata, &keys);
    serde_json::to_string(&output).map_err(|e| {
        napi::Error::from_reason(format!(
            "Failed to serialize adapter context metadata fields: {}",
            e
        ))
    })
}

#[napi_derive::napi]
pub fn resolve_adapter_context_metadata_signals_json(
    metadata_json: String,
) -> napi::Result<String> {
    let metadata: Value = serde_json::from_str(&metadata_json)
        .map_err(|e| napi::Error::from_reason(format!("Failed to parse metadata JSON: {}", e)))?;
    let output = resolve_adapter_context_metadata_signals(&metadata);
    serde_json::to_string(&output).map_err(|e| {
        napi::Error::from_reason(format!(
            "Failed to serialize adapter context metadata signals: {}",
            e
        ))
    })
}

#[napi_derive::napi]
pub fn resolve_adapter_context_object_carriers_json(metadata_json: String) -> napi::Result<String> {
    let metadata: Value = serde_json::from_str(&metadata_json)
        .map_err(|e| napi::Error::from_reason(format!("Failed to parse metadata JSON: {}", e)))?;
    let output = resolve_adapter_context_object_carriers(&metadata);
    serde_json::to_string(&output).map_err(|e| {
        napi::Error::from_reason(format!(
            "Failed to serialize adapter context object carriers: {}",
            e
        ))
    })
}

#[napi_derive::napi]
pub fn resolve_hub_policy_override_json(metadata_json: String) -> napi::Result<String> {
    let metadata: Value = serde_json::from_str(&metadata_json)
        .map_err(|e| napi::Error::from_reason(format!("Failed to parse metadata JSON: {}", e)))?;
    let output = resolve_hub_policy_override(&metadata).unwrap_or(Value::Null);
    serde_json::to_string(&output).map_err(|e| {
        napi::Error::from_reason(format!("Failed to serialize hub policy override: {}", e))
    })
}

#[napi_derive::napi]
pub fn resolve_hub_shadow_compare_config_json(metadata_json: String) -> napi::Result<String> {
    let metadata: Value = serde_json::from_str(&metadata_json)
        .map_err(|e| napi::Error::from_reason(format!("Failed to parse metadata JSON: {}", e)))?;
    let output = resolve_hub_shadow_compare_config(&metadata).unwrap_or(Value::Null);
    serde_json::to_string(&output).map_err(|e| {
        napi::Error::from_reason(format!(
            "Failed to serialize hub shadow compare config: {}",
            e
        ))
    })
}

#[napi_derive::napi]
pub fn resolve_apply_patch_tool_mode_from_env_json() -> napi::Result<String> {
    let output = resolve_apply_patch_tool_mode_from_env();
    serde_json::to_string(&output).map_err(|e| {
        napi::Error::from_reason(format!(
            "Failed to serialize apply patch tool mode from env: {}",
            e
        ))
    })
}

#[napi_derive::napi]
pub fn resolve_apply_patch_tool_mode_from_tools_json(tools_json: String) -> napi::Result<String> {
    let tools_raw: Value = serde_json::from_str(&tools_json)
        .map_err(|e| napi::Error::from_reason(format!("Failed to parse tools JSON: {}", e)))?;
    let output = resolve_apply_patch_tool_mode_from_tools(&tools_raw);
    serde_json::to_string(&output).map_err(|e| {
        napi::Error::from_reason(format!(
            "Failed to serialize apply patch tool mode from tools: {}",
            e
        ))
    })
}

#[napi_derive::napi]
pub fn is_search_route_id_json(route_id_json: String) -> napi::Result<String> {
    let route_id: Value = serde_json::from_str(&route_id_json)
        .map_err(|e| napi::Error::from_reason(format!("Failed to parse routeId JSON: {}", e)))?;
    let output = is_search_route_id(&route_id);
    serde_json::to_string(&output).map_err(|e| {
        napi::Error::from_reason(format!("Failed to serialize search route id: {}", e))
    })
}

#[napi_derive::napi]
pub fn is_canonical_web_search_tool_definition_json(tool_json: String) -> napi::Result<String> {
    let tool: Value = serde_json::from_str(&tool_json)
        .map_err(|e| napi::Error::from_reason(format!("Failed to parse tool JSON: {}", e)))?;
    let output = is_canonical_web_search_tool_definition(&tool);
    serde_json::to_string(&output).map_err(|e| {
        napi::Error::from_reason(format!(
            "Failed to serialize canonical web search tool definition: {}",
            e
        ))
    })
}

#[napi_derive::napi]
pub fn apply_direct_builtin_web_search_tool_json(
    provider_payload_json: String,
    provider_protocol: String,
    route_id_json: String,
    runtime_metadata_json: String,
) -> napi::Result<String> {
    let provider_payload: Value = serde_json::from_str(&provider_payload_json).map_err(|e| {
        napi::Error::from_reason(format!("Failed to parse provider payload JSON: {}", e))
    })?;
    let route_id: Value = serde_json::from_str(&route_id_json)
        .map_err(|e| napi::Error::from_reason(format!("Failed to parse route id JSON: {}", e)))?;
    let runtime_metadata: Value = serde_json::from_str(&runtime_metadata_json).map_err(|e| {
        napi::Error::from_reason(format!("Failed to parse runtime metadata JSON: {}", e))
    })?;
    let output = apply_direct_builtin_web_search_tool(
        &provider_payload,
        provider_protocol.trim(),
        &route_id,
        &runtime_metadata,
    );
    serde_json::to_string(&output).map_err(|e| {
        napi::Error::from_reason(format!(
            "Failed to serialize direct builtin web search tool payload: {}",
            e
        ))
    })
}

#[napi_derive::napi]
pub fn lift_responses_resume_into_semantics_json(
    request_json: String,
    metadata_json: String,
) -> napi::Result<String> {
    let request: Value = serde_json::from_str(&request_json)
        .map_err(|e| napi::Error::from_reason(format!("Failed to parse request JSON: {}", e)))?;
    let metadata: Value = serde_json::from_str(&metadata_json)
        .map_err(|e| napi::Error::from_reason(format!("Failed to parse metadata JSON: {}", e)))?;
    let output = lift_responses_resume_into_semantics(&request, &metadata);
    serde_json::to_string(&output).map_err(|e| {
        napi::Error::from_reason(format!(
            "Failed to serialize lifted responses resume semantics: {}",
            e
        ))
    })
}

#[napi_derive::napi]
pub fn sync_responses_context_from_canonical_messages_json(
    request_json: String,
) -> napi::Result<String> {
    let request: Value = serde_json::from_str(&request_json)
        .map_err(|e| napi::Error::from_reason(format!("Failed to parse request JSON: {}", e)))?;
    let output = sync_responses_context_from_canonical_messages(&request);
    serde_json::to_string(&output).map_err(|e| {
        napi::Error::from_reason(format!(
            "Failed to serialize synced responses context request: {}",
            e
        ))
    })
}

#[napi_derive::napi]
pub fn read_responses_resume_from_metadata_json(metadata_json: String) -> napi::Result<String> {
    let metadata: Value = serde_json::from_str(&metadata_json)
        .map_err(|e| napi::Error::from_reason(format!("Failed to parse metadata JSON: {}", e)))?;
    let output = read_responses_resume_from_metadata(&metadata).unwrap_or(Value::Null);
    serde_json::to_string(&output).map_err(|e| {
        napi::Error::from_reason(format!(
            "Failed to serialize responses resume from metadata: {}",
            e
        ))
    })
}

#[napi_derive::napi]
pub fn read_responses_resume_from_request_semantics_json(
    request_json: String,
) -> napi::Result<String> {
    let request: Value = serde_json::from_str(&request_json)
        .map_err(|e| napi::Error::from_reason(format!("Failed to parse request JSON: {}", e)))?;
    let output = read_responses_resume_from_request_semantics(&request).unwrap_or(Value::Null);
    serde_json::to_string(&output).map_err(|e| {
        napi::Error::from_reason(format!(
            "Failed to serialize responses resume from request semantics: {}",
            e
        ))
    })
}

#[napi_derive::napi]
pub fn resolve_has_instruction_requested_passthrough_json(
    messages_json: String,
) -> napi::Result<String> {
    let messages: Value = serde_json::from_str(&messages_json)
        .map_err(|e| napi::Error::from_reason(format!("Failed to parse messages JSON: {}", e)))?;
    let output = resolve_has_instruction_requested_passthrough(&messages);
    serde_json::to_string(&output).map_err(|e| {
        napi::Error::from_reason(format!("Failed to serialize passthrough detection: {}", e))
    })
}

#[napi_derive::napi]
pub fn resolve_active_process_mode_json(
    base_mode_json: String,
    messages_json: String,
) -> napi::Result<String> {
    let base_mode_value: Value = serde_json::from_str(&base_mode_json)
        .map_err(|e| napi::Error::from_reason(format!("Failed to parse base mode JSON: {}", e)))?;
    let messages: Value = serde_json::from_str(&messages_json)
        .map_err(|e| napi::Error::from_reason(format!("Failed to parse messages JSON: {}", e)))?;
    let base_mode = base_mode_value.as_str().unwrap_or("chat");
    let output = resolve_active_process_mode(base_mode, &messages);
    serde_json::to_string(&output).map_err(|e| {
        napi::Error::from_reason(format!("Failed to serialize active process mode: {}", e))
    })
}

#[napi_derive::napi]
pub fn find_mappable_semantics_keys_json(metadata_json: String) -> napi::Result<String> {
    let metadata: Value = serde_json::from_str(&metadata_json)
        .map_err(|e| napi::Error::from_reason(format!("Failed to parse metadata JSON: {}", e)))?;
    let output = find_mappable_semantics_keys(&metadata);
    serde_json::to_string(&output).map_err(|e| {
        napi::Error::from_reason(format!(
            "Failed to serialize mappable semantics keys: {}",
            e
        ))
    })
}

#[napi_derive::napi]
pub fn build_passthrough_audit_json(
    raw_inbound_json: String,
    provider_protocol: String,
) -> napi::Result<String> {
    let raw_inbound: Value = serde_json::from_str(&raw_inbound_json).map_err(|e| {
        napi::Error::from_reason(format!("Failed to parse raw inbound JSON: {}", e))
    })?;
    let output = build_passthrough_audit(&raw_inbound, provider_protocol.trim());
    serde_json::to_string(&output).map_err(|e| {
        napi::Error::from_reason(format!("Failed to serialize passthrough audit: {}", e))
    })
}

#[napi_derive::napi]
pub fn annotate_passthrough_governance_skip_json(audit_json: String) -> napi::Result<String> {
    let audit: Value = serde_json::from_str(&audit_json)
        .map_err(|e| napi::Error::from_reason(format!("Failed to parse audit JSON: {}", e)))?;
    let output = annotate_passthrough_governance_skip(&audit);
    serde_json::to_string(&output).map_err(|e| {
        napi::Error::from_reason(format!(
            "Failed to serialize passthrough governance skip annotation: {}",
            e
        ))
    })
}

#[napi_derive::napi]
pub fn attach_passthrough_provider_input_audit_json(
    audit_json: String,
    provider_payload_json: String,
    provider_protocol: String,
) -> napi::Result<String> {
    let audit: Value = serde_json::from_str(&audit_json)
        .map_err(|e| napi::Error::from_reason(format!("Failed to parse audit JSON: {}", e)))?;
    let provider_payload: Value = serde_json::from_str(&provider_payload_json).map_err(|e| {
        napi::Error::from_reason(format!("Failed to parse provider payload JSON: {}", e))
    })?;
    let output = attach_passthrough_provider_input_audit(
        &audit,
        &provider_payload,
        provider_protocol.trim(),
    );
    serde_json::to_string(&output).map_err(|e| {
        napi::Error::from_reason(format!(
            "Failed to serialize passthrough provider input audit: {}",
            e
        ))
    })
}

// NAPI bindings
#[napi_derive::napi]
pub fn run_hub_pipeline_json(input_json: String) -> napi::Result<String> {
    if input_json.trim().is_empty() {
        return Err(napi::Error::from_reason("Input JSON is empty"));
    }

    let input: HubPipelineInput = serde_json::from_str(&input_json)
        .map_err(|e| napi::Error::from_reason(format!("Failed to parse input JSON: {}", e)))?;

    let output = run_hub_pipeline(input).map_err(|e| napi::Error::from_reason(e))?;

    serde_json::to_string(&output)
        .map_err(|e| napi::Error::from_reason(format!("Failed to serialize output: {}", e)))
}

#[napi_derive::napi]
pub fn run_req_inbound_pipeline_json(
    payload_json: String,
    protocol: String,
    endpoint: String,
) -> napi::Result<String> {
    if payload_json.trim().is_empty() {
        return Err(napi::Error::from_reason("Payload JSON is empty"));
    }

    let payload: Value = serde_json::from_str(&payload_json)
        .map_err(|e| napi::Error::from_reason(format!("Failed to parse payload: {}", e)))?;

    let envelope = run_req_inbound_pipeline(payload, &protocol, &endpoint)
        .map_err(|e| napi::Error::from_reason(e))?;

    serde_json::to_string(&envelope)
        .map_err(|e| napi::Error::from_reason(format!("Failed to serialize envelope: {}", e)))
}

#[napi_derive::napi]
pub fn run_req_process_pipeline_json(
    envelope_json: String,
    routing_json: String,
) -> napi::Result<String> {
    let envelope: ChatEnvelope = serde_json::from_str(&envelope_json)
        .map_err(|e| napi::Error::from_reason(format!("Failed to parse envelope: {}", e)))?;

    let routing: RoutingDecision = serde_json::from_str(&routing_json)
        .map_err(|e| napi::Error::from_reason(format!("Failed to parse routing: {}", e)))?;

    let processed =
        run_req_process_pipeline(envelope, routing).map_err(|e| napi::Error::from_reason(e))?;

    serde_json::to_string(&processed)
        .map_err(|e| napi::Error::from_reason(format!("Failed to serialize processed: {}", e)))
}

#[napi_derive::napi]
pub fn run_resp_outbound_pipeline_json(
    payload_json: String,
    protocol: String,
) -> napi::Result<String> {
    let payload: Value = serde_json::from_str(&payload_json)
        .map_err(|e| napi::Error::from_reason(format!("Failed to parse payload: {}", e)))?;

    let envelope =
        run_resp_outbound_pipeline(payload, &protocol).map_err(|e| napi::Error::from_reason(e))?;

    serde_json::to_string(&envelope)
        .map_err(|e| napi::Error::from_reason(format!("Failed to serialize envelope: {}", e)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn test_empty_input_error() {
        let result = run_hub_pipeline_json("".to_string());
        assert!(result.is_err());
        let err = result.unwrap_err().to_string();
        assert!(err.contains("Input JSON is empty"));
    }

    #[test]
    fn test_invalid_json_error() {
        let result = run_hub_pipeline_json("not valid json".to_string());
        assert!(result.is_err());
        let err = result.unwrap_err().to_string();
        assert!(err.contains("Failed to parse input JSON"));
    }

    #[test]
    fn test_basic_pipeline_success() {
        let input = HubPipelineInput {
            request_id: "req_123".to_string(),
            endpoint: "/v1/chat".to_string(),
            entry_endpoint: "/v1/chat".to_string(),
            provider_protocol: "openai-chat".to_string(),
            payload: json!({"model": "gpt-4", "messages": [{"role": "user", "content": "hi"}]}),
            metadata: json!({"source": "test"}),
            stream: false,
            process_mode: "chat".to_string(),
            direction: "request".to_string(),
            stage: "inbound".to_string(),
        };

        let result = run_hub_pipeline(input).unwrap();
        assert!(result.success);
        assert_eq!(result.request_id, "req_123");
        assert!(result.payload.is_some());
        assert!(result.metadata.is_some());
    }

    #[test]
    fn test_run_hub_pipeline_sets_orchestration_metadata_fields() {
        let input = HubPipelineInput {
            request_id: "req_orchestration".to_string(),
            endpoint: "v1/chat/completions".to_string(),
            entry_endpoint: "/v1/chat/completions".to_string(),
            provider_protocol: "chat".to_string(),
            payload: json!({
                "model": "gpt-4",
                "messages": [{
                    "role": "user",
                    "content": "<**sticky:tabglm.key1.glm-5:passthrough**>"
                }],
                "stream": true
            }),
            metadata: json!({
                "routeHint": "  tools  "
            }),
            stream: false,
            process_mode: "chat".to_string(),
            direction: "request".to_string(),
            stage: "inbound".to_string(),
        };

        let result = run_hub_pipeline(input).expect("hub pipeline");
        let metadata = result
            .metadata
            .and_then(|v| v.as_object().cloned())
            .expect("metadata object");

        assert_eq!(
            metadata.get("entryEndpoint").and_then(|v| v.as_str()),
            Some("/v1/chat/completions")
        );
        assert_eq!(
            metadata.get("providerProtocol").and_then(|v| v.as_str()),
            Some("openai-chat")
        );
        assert_eq!(
            metadata.get("processMode").and_then(|v| v.as_str()),
            Some("passthrough")
        );
        assert_eq!(
            metadata.get("direction").and_then(|v| v.as_str()),
            Some("request")
        );
        assert_eq!(
            metadata.get("stage").and_then(|v| v.as_str()),
            Some("inbound")
        );
        assert_eq!(metadata.get("stream").and_then(|v| v.as_bool()), Some(true));
        assert_eq!(
            metadata.get("routeHint").and_then(|v| v.as_str()),
            Some("tools")
        );
    }

    #[test]
    fn test_run_hub_pipeline_extracts_apply_patch_mode_from_tools() {
        let input = HubPipelineInput {
            request_id: "req_apply_patch".to_string(),
            endpoint: "/v1/chat/completions".to_string(),
            entry_endpoint: "/v1/chat/completions".to_string(),
            provider_protocol: "openai-chat".to_string(),
            payload: json!({
                "model": "gpt-4",
                "messages": [{"role": "user", "content": "hi"}],
                "tools": [{
                    "type": "function",
                    "function": {
                        "name": "apply_patch",
                        "format": "freeform"
                    }
                }]
            }),
            metadata: json!({}),
            stream: false,
            process_mode: "chat".to_string(),
            direction: "request".to_string(),
            stage: "inbound".to_string(),
        };
        let result = run_hub_pipeline(input).expect("hub pipeline");
        let metadata = result.metadata.expect("metadata value");
        assert_eq!(
            metadata
                .get("runtime")
                .and_then(|v| v.get("applyPatchToolMode"))
                .and_then(|v| v.as_str()),
            Some("freeform")
        );
    }

    #[test]
    fn test_run_hub_pipeline_merges_stop_message_tmux_aliases() {
        let input = HubPipelineInput {
            request_id: "req_stop_msg".to_string(),
            endpoint: "/v1/chat/completions".to_string(),
            entry_endpoint: "/v1/chat/completions".to_string(),
            provider_protocol: "openai-chat".to_string(),
            payload: json!({
                "model": "gpt-4",
                "messages": [{"role": "user", "content": "hello"}]
            }),
            metadata: json!({
                "client_tmux_session_id": "tmux-session-123"
            }),
            stream: false,
            process_mode: "chat".to_string(),
            direction: "request".to_string(),
            stage: "inbound".to_string(),
        };
        let result = run_hub_pipeline(input).expect("hub pipeline");
        let metadata = result.metadata.expect("metadata value");
        assert_eq!(
            metadata.get("clientTmuxSessionId").and_then(|v| v.as_str()),
            Some("tmux-session-123")
        );
        assert_eq!(
            metadata.get("tmuxSessionId").and_then(|v| v.as_str()),
            Some("tmux-session-123")
        );
    }

    #[test]
    fn test_protocol_resolution_aliases() {
        let test_cases = vec![
            ("openai", "openai-chat"),
            ("chat", "openai-chat"),
            ("responses", "openai-responses"),
            ("anthropic", "anthropic-messages"),
            ("gemini", "gemini-chat"),
        ];

        for (input, expected) in test_cases {
            let result = resolve_provider_protocol(input).unwrap();
            assert_eq!(
                result, expected,
                "Protocol alias {} should resolve to {}",
                input, expected
            );
        }
    }

    #[test]
    fn test_invalid_protocol_error() {
        let result = resolve_provider_protocol("invalid-protocol");
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("Unsupported"));
    }

    #[test]
    fn test_resolve_hub_client_protocol() {
        assert_eq!(
            resolve_hub_client_protocol("/v1/responses"),
            "openai-responses"
        );
        assert_eq!(
            resolve_hub_client_protocol("/v1/messages"),
            "anthropic-messages"
        );
        assert_eq!(
            resolve_hub_client_protocol("/v1/chat/completions"),
            "openai-chat"
        );
    }

    #[test]
    fn test_extract_model_hint_from_metadata_prefers_top_level_model() {
        let metadata = json!({
            "model": "  gpt-4.1  ",
            "provider": {
                "model": "provider-model"
            }
        });
        let output = extract_model_hint_from_metadata(&metadata);
        assert_eq!(output.as_deref(), Some("gpt-4.1"));
    }

    #[test]
    fn test_extract_model_hint_from_metadata_falls_back_to_provider_keys() {
        let metadata = json!({
            "provider": {
                "modelId": "  claude-3-7-sonnet  "
            }
        });
        let output = extract_model_hint_from_metadata(&metadata);
        assert_eq!(output.as_deref(), Some("claude-3-7-sonnet"));
    }

    #[test]
    fn test_extract_model_hint_from_metadata_ignores_blank_values() {
        let metadata = json!({
            "model": "   ",
            "provider": {
                "defaultModel": "   "
            }
        });
        let output = extract_model_hint_from_metadata(&metadata);
        assert!(output.is_none());
    }

    #[test]
    fn test_resolve_sse_protocol_prefers_explicit_metadata() {
        let metadata = json!({
            "sseProtocol": "anthropic"
        });
        let output = resolve_sse_protocol(&metadata, "openai-responses");
        assert_eq!(output, "anthropic-messages");
    }

    #[test]
    fn test_resolve_sse_protocol_uses_provider_protocol() {
        let metadata = json!({});
        let output = resolve_sse_protocol(&metadata, "openai-responses");
        assert_eq!(output, "openai-responses");
    }

    #[test]
    fn test_resolve_outbound_stream_intent() {
        assert_eq!(resolve_outbound_stream_intent(&json!("always")), Some(true));
        assert_eq!(resolve_outbound_stream_intent(&json!("never")), Some(false));
        assert_eq!(resolve_outbound_stream_intent(&json!("auto")), None);
    }

    #[test]
    fn test_apply_outbound_stream_preference_sets_and_unsets_stream_fields() {
        let request = json!({
            "parameters": { "temperature": 0.2 },
            "metadata": { "x": 1 }
        });
        let with_stream = apply_outbound_stream_preference(&request, Some(true), Some("chat"));
        assert_eq!(
            with_stream
                .get("parameters")
                .and_then(|v| v.get("stream"))
                .and_then(|v| v.as_bool()),
            Some(true)
        );
        assert_eq!(
            with_stream
                .get("metadata")
                .and_then(|v| v.get("outboundStream"))
                .and_then(|v| v.as_bool()),
            Some(true)
        );

        let unset_stream = apply_outbound_stream_preference(&with_stream, None, Some("chat"));
        assert!(unset_stream
            .get("parameters")
            .and_then(|v| v.get("stream"))
            .is_none());
        assert!(unset_stream
            .get("metadata")
            .and_then(|v| v.get("outboundStream"))
            .is_none());
    }

    #[test]
    fn test_apply_outbound_stream_preference_passthrough_keeps_request_when_stream_undefined() {
        let request = json!({
            "parameters": { "temperature": 0.2 },
            "metadata": { "x": 1 }
        });
        let output = apply_outbound_stream_preference(&request, None, Some("passthrough"));
        assert_eq!(output, request);
    }

    #[test]
    fn test_null_payload_error() {
        let result = run_req_inbound_pipeline(Value::Null, "openai-chat", "/v1/chat");
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("cannot be null"));
    }

    #[test]
    fn test_empty_messages_error() {
        let envelope = ChatEnvelope {
            messages: vec![],
            semantics: None,
            metadata: None,
        };
        let routing = RoutingDecision {
            provider_key: "openai.default".to_string(),
            target_endpoint: "/v1/chat".to_string(),
            metadata: None,
        };

        let result = run_req_process_pipeline(envelope, routing);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("at least one message"));
    }

    #[test]
    fn test_req_inbound_pipeline_success() {
        let payload = json!({"model": "gpt-4"});
        let result = run_req_inbound_pipeline(payload, "openai-chat", "/v1/chat").unwrap();
        assert_eq!(result.protocol, "openai-chat");
        assert!(result.metadata.is_some());
    }

    #[test]
    fn test_req_process_pipeline_success() {
        let envelope = ChatEnvelope {
            messages: vec![json!({"role": "user", "content": "hello"})],
            semantics: Some(json!({})),
            metadata: Some(json!({"test": true})),
        };
        let routing = RoutingDecision {
            provider_key: "openai.default".to_string(),
            target_endpoint: "/v1/chat".to_string(),
            metadata: Some(json!({"region": "us"})),
        };

        let result = run_req_process_pipeline(envelope, routing).unwrap();
        assert!(result.request.get("messages").is_some());
        assert_eq!(result.routing.provider_key, "openai.default");
    }

    #[test]
    fn test_resp_outbound_pipeline_success() {
        let payload = json!({"choices": [{"message": {"role": "assistant", "content": "Hello"}}]});
        let result = run_resp_outbound_pipeline(payload, "openai-chat").unwrap();
        assert_eq!(result.protocol, "openai-chat");
        assert!(result.payload.get("choices").is_some());
    }

    #[test]
    fn test_normalize_endpoint() {
        assert_eq!(normalize_endpoint(""), "/v1/chat/completions");
        assert_eq!(normalize_endpoint("/v1/chat"), "/v1/chat");
        assert_eq!(normalize_endpoint("v1/chat"), "/v1/chat");
    }

    #[test]
    fn test_json_roundtrip() {
        let input_json = json!({
            "requestId": "req_456",
            "endpoint": "/v1/chat",
            "entryEndpoint": "/v1/chat",
            "providerProtocol": "anthropic-messages",
            "payload": {"model": "claude-3", "messages": []},
            "metadata": {"test": true},
            "stream": true,
            "processMode": "chat",
            "direction": "request",
            "stage": "inbound"
        })
        .to_string();

        let result = run_hub_pipeline_json(input_json).unwrap();
        let output: HubPipelineOutput = serde_json::from_str(&result).unwrap();
        assert!(output.success);
        assert_eq!(output.request_id, "req_456");
    }

    #[test]
    fn test_resolve_stop_message_router_metadata_prefers_client_tmux_and_sets_aliases() {
        let metadata = json!({
            "stopMessageClientInjectSessionScope": "  scope-123  ",
            "stopMessageClientInjectScope": " tmux:abc ",
            "clientTmuxSessionId": " client-tmux-1 ",
            "tmuxSessionId": "fallback-tmux"
        });
        let output = resolve_stop_message_router_metadata(&metadata);
        let row = output.as_object().expect("object output");
        assert_eq!(
            row.get("stopMessageClientInjectSessionScope")
                .and_then(|v| v.as_str()),
            Some("scope-123")
        );
        assert_eq!(
            row.get("stopMessageClientInjectScope")
                .and_then(|v| v.as_str()),
            Some("tmux:abc")
        );
        assert_eq!(
            row.get("clientTmuxSessionId").and_then(|v| v.as_str()),
            Some("client-tmux-1")
        );
        assert_eq!(
            row.get("client_tmux_session_id").and_then(|v| v.as_str()),
            Some("client-tmux-1")
        );
        assert_eq!(
            row.get("tmuxSessionId").and_then(|v| v.as_str()),
            Some("client-tmux-1")
        );
        assert_eq!(
            row.get("tmux_session_id").and_then(|v| v.as_str()),
            Some("client-tmux-1")
        );
    }

    #[test]
    fn test_resolve_stop_message_router_metadata_empty_input_returns_empty_object() {
        let output = resolve_stop_message_router_metadata(&json!(null));
        let row = output.as_object().expect("object output");
        assert!(row.is_empty());
    }

    #[test]
    fn test_resolve_router_metadata_runtime_flags_extracts_values() {
        let metadata = json!({
            "__rt": {
                "disableStickyRoutes": true
            },
            "estimatedInputTokens": 1234
        });
        let output = resolve_router_metadata_runtime_flags(&metadata);
        let row = output.as_object().expect("object output");
        assert_eq!(
            row.get("disableStickyRoutes").and_then(|v| v.as_bool()),
            Some(true)
        );
        assert_eq!(
            row.get("estimatedInputTokens").and_then(|v| v.as_f64()),
            Some(1234.0)
        );
    }

    #[test]
    fn test_resolve_router_metadata_runtime_flags_ignores_false_or_non_numeric() {
        let metadata = json!({
            "__rt": {
                "disableStickyRoutes": false
            },
            "estimatedInputTokens": "1234"
        });
        let output = resolve_router_metadata_runtime_flags(&metadata);
        let row = output.as_object().expect("object output");
        assert!(!row.contains_key("disableStickyRoutes"));
        assert!(!row.contains_key("estimatedInputTokens"));
    }

    #[test]
    fn test_build_router_metadata_input_extracts_runtime_flags_and_stop_message_fields() {
        let input = json!({
            "requestId": "req-1",
            "entryEndpoint": "/v1/responses",
            "processMode": "passthrough",
            "stream": true,
            "direction": "request",
            "providerProtocol": "openai-responses",
            "routeHint": "tools",
            "stage": "inbound",
            "responsesResume": { "response_id": "resp_123" },
            "serverToolRequired": true,
            "sessionId": "sess-1",
            "conversationId": "conv-1",
            "includeEstimatedInputTokens": true,
            "metadata": {
                "__rt": { "disableStickyRoutes": true },
                "estimatedInputTokens": 88,
                "stopMessageClientInjectScope": " tmux:abc "
            }
        });
        let output = build_router_metadata_input(&input).expect("router metadata input");
        let row = output.as_object().expect("output object");
        assert_eq!(row.get("requestId").and_then(|v| v.as_str()), Some("req-1"));
        assert_eq!(
            row.get("providerProtocol").and_then(|v| v.as_str()),
            Some("openai-responses")
        );
        assert_eq!(
            row.get("responsesResume")
                .and_then(|v| v.as_object())
                .and_then(|obj| obj.get("response_id"))
                .and_then(|v| v.as_str()),
            Some("resp_123")
        );
        assert_eq!(
            row.get("stopMessageClientInjectScope")
                .and_then(|v| v.as_str()),
            Some("tmux:abc")
        );
        assert_eq!(
            row.get("disableStickyRoutes").and_then(|v| v.as_bool()),
            Some(true)
        );
        assert_eq!(
            row.get("estimatedInputTokens").and_then(|v| v.as_f64()),
            Some(88.0)
        );
    }

    #[test]
    fn test_build_router_metadata_input_hides_estimated_tokens_when_not_requested() {
        let input = json!({
            "requestId": "req-2",
            "metadata": {
                "__rt": { "disableStickyRoutes": true },
                "estimatedInputTokens": 123
            }
        });
        let output = build_router_metadata_input(&input).expect("router metadata input");
        let row = output.as_object().expect("output object");
        assert_eq!(
            row.get("disableStickyRoutes").and_then(|v| v.as_bool()),
            Some(true)
        );
        assert!(!row.contains_key("estimatedInputTokens"));
    }

    #[test]
    fn test_build_router_metadata_input_preserves_forced_provider_and_disabled_aliases() {
        let input = json!({
            "requestId": "req-3",
            "metadata": {
                "__shadowCompareForcedProviderKey": " ali-coding-plan.key1.kimi-k2.5 ",
                "disabledProviderKeyAliases": [
                    " qwen.1 ",
                    "",
                    null,
                    "qwen.2"
                ]
            }
        });
        let output = build_router_metadata_input(&input).expect("router metadata input");
        let row = output.as_object().expect("output object");
        assert_eq!(
            row.get("__shadowCompareForcedProviderKey")
                .and_then(|v| v.as_str()),
            Some("ali-coding-plan.key1.kimi-k2.5")
        );
        assert_eq!(
            row.get("disabledProviderKeyAliases")
                .and_then(|v| v.as_array())
                .map(|items| items
                    .iter()
                    .filter_map(|entry| entry.as_str())
                    .collect::<Vec<_>>()),
            Some(vec!["qwen.1", "qwen.2"])
        );
    }

    #[test]
    fn test_build_hub_pipeline_result_metadata_applies_shadow_compare() {
        let input = json!({
            "normalized": {
                "metadata": { "existing": true },
                "entryEndpoint": "/v1/responses",
                "stream": true,
                "processMode": "passthrough",
                "routeHint": "tools"
            },
            "outboundProtocol": "anthropic-messages",
            "target": { "providerKey": "tab.key1.glm-5" },
            "outboundStream": false,
            "capturedChatRequest": { "model": "glm-5" },
            "passthroughAudit": { "mode": "passthrough" },
            "shadowCompareBaselineMode": "observe",
            "effectivePolicy": { "mode": "enforce" },
            "shadowBaselineProviderPayload": { "messages": [] }
        });
        let output =
            build_hub_pipeline_result_metadata(&input).expect("hub pipeline result metadata");
        let row = output.as_object().expect("output object");
        assert_eq!(row.get("existing").and_then(|v| v.as_bool()), Some(true));
        assert_eq!(
            row.get("providerProtocol").and_then(|v| v.as_str()),
            Some("anthropic-messages")
        );
        assert_eq!(
            row.get("providerStream").and_then(|v| v.as_bool()),
            Some(false)
        );
        assert_eq!(
            row.get("passthroughAudit")
                .and_then(|v| v.as_object())
                .and_then(|obj| obj.get("mode"))
                .and_then(|v| v.as_str()),
            Some("passthrough")
        );
        assert_eq!(
            row.get("hubShadowCompare")
                .and_then(|v| v.as_object())
                .and_then(|obj| obj.get("baselineMode"))
                .and_then(|v| v.as_str()),
            Some("observe")
        );
        assert_eq!(
            row.get("hubShadowCompare")
                .and_then(|v| v.as_object())
                .and_then(|obj| obj.get("candidateMode"))
                .and_then(|v| v.as_str()),
            Some("enforce")
        );
    }

    #[test]
    fn test_build_hub_pipeline_result_metadata_defaults_candidate_mode_off() {
        let input = json!({
            "normalized": {
                "metadata": {},
                "entryEndpoint": "/v1/chat/completions",
                "stream": false,
                "processMode": "chat"
            },
            "outboundProtocol": "openai-chat",
            "capturedChatRequest": { "messages": [] },
            "shadowCompareBaselineMode": "bad-mode",
            "effectivePolicy": { "mode": "bad-mode" },
            "shadowBaselineProviderPayload": { "x": 1 }
        });
        let output =
            build_hub_pipeline_result_metadata(&input).expect("hub pipeline result metadata");
        let row = output.as_object().expect("output object");
        assert_eq!(
            row.get("hubShadowCompare")
                .and_then(|v| v.as_object())
                .and_then(|obj| obj.get("baselineMode"))
                .and_then(|v| v.as_str()),
            Some("off")
        );
        assert_eq!(
            row.get("hubShadowCompare")
                .and_then(|v| v.as_object())
                .and_then(|obj| obj.get("candidateMode"))
                .and_then(|v| v.as_str()),
            Some("off")
        );
    }

    #[test]
    fn test_build_req_outbound_node_result_builds_expected_shape() {
        let input = json!({
            "outboundStart": 1000,
            "outboundEnd": 1255,
            "messages": 7,
            "tools": 2
        });
        let output = build_req_outbound_node_result(&input).expect("req outbound node result");
        let row = output.as_object().expect("output object");
        assert_eq!(row.get("id").and_then(|v| v.as_str()), Some("req_outbound"));
        assert_eq!(row.get("success").and_then(|v| v.as_bool()), Some(true));
        let metadata = row
            .get("metadata")
            .and_then(|v| v.as_object())
            .expect("metadata object");
        assert_eq!(
            metadata.get("node").and_then(|v| v.as_str()),
            Some("req_outbound")
        );
        assert_eq!(
            metadata.get("executionTime").and_then(|v| v.as_i64()),
            Some(255)
        );
        assert_eq!(
            metadata.get("startTime").and_then(|v| v.as_i64()),
            Some(1000)
        );
        assert_eq!(metadata.get("endTime").and_then(|v| v.as_i64()), Some(1255));
        assert_eq!(
            metadata
                .get("dataProcessed")
                .and_then(|v| v.as_object())
                .and_then(|obj| obj.get("messages"))
                .and_then(|v| v.as_i64()),
            Some(7)
        );
        assert_eq!(
            metadata
                .get("dataProcessed")
                .and_then(|v| v.as_object())
                .and_then(|obj| obj.get("tools"))
                .and_then(|v| v.as_i64()),
            Some(2)
        );
    }

    #[test]
    fn test_build_req_outbound_node_result_defaults_counts_to_zero() {
        let input = json!({
            "outboundStart": 10,
            "outboundEnd": 12
        });
        let output = build_req_outbound_node_result(&input).expect("req outbound node result");
        let metadata = output
            .as_object()
            .and_then(|v| v.get("metadata"))
            .and_then(|v| v.as_object())
            .expect("metadata object");
        assert_eq!(
            metadata
                .get("dataProcessed")
                .and_then(|v| v.as_object())
                .and_then(|obj| obj.get("messages"))
                .and_then(|v| v.as_i64()),
            Some(0)
        );
        assert_eq!(
            metadata
                .get("dataProcessed")
                .and_then(|v| v.as_object())
                .and_then(|obj| obj.get("tools"))
                .and_then(|v| v.as_i64()),
            Some(0)
        );
    }

    #[test]
    fn test_build_req_inbound_node_result_builds_expected_shape() {
        let input = json!({
            "inboundStart": 100,
            "inboundEnd": 180,
            "messages": 3,
            "tools": 1
        });
        let output = build_req_inbound_node_result(&input).expect("req inbound node result");
        let row = output.as_object().expect("output object");
        assert_eq!(row.get("id").and_then(|v| v.as_str()), Some("req_inbound"));
        assert_eq!(row.get("success").and_then(|v| v.as_bool()), Some(true));
        assert_eq!(
            row.get("metadata")
                .and_then(|v| v.as_object())
                .and_then(|v| v.get("executionTime"))
                .and_then(|v| v.as_i64()),
            Some(80)
        );
        assert_eq!(
            row.get("metadata")
                .and_then(|v| v.as_object())
                .and_then(|v| v.get("dataProcessed"))
                .and_then(|v| v.as_object())
                .and_then(|v| v.get("messages"))
                .and_then(|v| v.as_i64()),
            Some(3)
        );
        assert_eq!(
            row.get("metadata")
                .and_then(|v| v.as_object())
                .and_then(|v| v.get("dataProcessed"))
                .and_then(|v| v.as_object())
                .and_then(|v| v.get("tools"))
                .and_then(|v| v.as_i64()),
            Some(1)
        );
    }

    #[test]
    fn test_build_req_inbound_skipped_node_defaults_reason() {
        let input = json!({});
        let output = build_req_inbound_skipped_node(&input).expect("req inbound skipped node");
        let row = output.as_object().expect("output object");
        assert_eq!(row.get("id").and_then(|v| v.as_str()), Some("req_inbound"));
        assert_eq!(row.get("success").and_then(|v| v.as_bool()), Some(true));
        assert_eq!(
            row.get("metadata")
                .and_then(|v| v.as_object())
                .and_then(|v| v.get("skipped"))
                .and_then(|v| v.as_bool()),
            Some(true)
        );
        assert_eq!(
            row.get("metadata")
                .and_then(|v| v.as_object())
                .and_then(|v| v.get("reason"))
                .and_then(|v| v.as_str()),
            Some("stage=outbound")
        );
        assert_eq!(
            row.get("metadata")
                .and_then(|v| v.as_object())
                .and_then(|v| v.get("dataProcessed"))
                .and_then(|v| v.as_object())
                .map(|v| v.len()),
            Some(0)
        );
    }

    #[test]
    fn test_build_captured_chat_request_snapshot_preserves_shape() {
        let input = json!({
            "model": "glm-5",
            "messages": [{ "role": "user", "content": "hi" }],
            "tools": [{ "type": "function", "function": { "name": "x" } }],
            "parameters": { "temperature": 0.2 }
        });
        let output =
            build_captured_chat_request_snapshot(&input).expect("captured chat request snapshot");
        let row = output.as_object().expect("output object");
        assert_eq!(row.get("model").and_then(|v| v.as_str()), Some("glm-5"));
        assert_eq!(
            row.get("messages")
                .and_then(|v| v.as_array())
                .map(|v| v.len()),
            Some(1)
        );
        assert_eq!(
            row.get("tools").and_then(|v| v.as_array()).map(|v| v.len()),
            Some(1)
        );
        assert_eq!(
            row.get("parameters")
                .and_then(|v| v.as_object())
                .and_then(|v| v.get("temperature"))
                .and_then(|v| v.as_f64()),
            Some(0.2)
        );
    }

    #[test]
    fn test_build_captured_chat_request_snapshot_fills_nulls_for_missing_optional_fields() {
        let input = json!({
            "model": "glm-5",
            "messages": []
        });
        let output =
            build_captured_chat_request_snapshot(&input).expect("captured chat request snapshot");
        let row = output.as_object().expect("output object");
        assert!(row.get("tools").is_some_and(Value::is_null));
        assert!(row.get("parameters").is_some_and(Value::is_null));
    }

    #[test]
    fn test_coerce_standardized_request_from_payload_builds_expected_shape() {
        let input = json!({
            "payload": {
                "model": "  glm-5  ",
                "messages": [{ "role": "user", "content": "hi" }],
                "tools": [{ "type": "function", "function": { "name": "apply_patch" } }],
                "parameters": { "temperature": 0.2 },
                "metadata": { "requestId": "stale-id", "x": 1 },
                "semantics": { "tools": { "existing": true } }
            },
            "normalized": {
                "id": "req-123",
                "entryEndpoint": "/v1/responses",
                "stream": true,
                "processMode": "passthrough",
                "routeHint": "tools"
            }
        });
        let output = coerce_standardized_request_from_payload(&input)
            .expect("coerce standardized request output");
        let row = output.as_object().expect("output object");
        let standardized = row
            .get("standardizedRequest")
            .and_then(|v| v.as_object())
            .expect("standardizedRequest object");
        let raw_payload = row
            .get("rawPayload")
            .and_then(|v| v.as_object())
            .expect("rawPayload object");

        assert_eq!(
            standardized.get("model").and_then(|v| v.as_str()),
            Some("glm-5")
        );
        assert_eq!(
            standardized
                .get("metadata")
                .and_then(|v| v.as_object())
                .and_then(|v| v.get("requestId"))
                .and_then(|v| v.as_str()),
            Some("req-123")
        );
        assert_eq!(
            standardized
                .get("metadata")
                .and_then(|v| v.as_object())
                .and_then(|v| v.get("originalEndpoint"))
                .and_then(|v| v.as_str()),
            Some("/v1/responses")
        );
        assert_eq!(
            standardized
                .get("metadata")
                .and_then(|v| v.as_object())
                .and_then(|v| v.get("routeHint"))
                .and_then(|v| v.as_str()),
            Some("tools")
        );
        assert_eq!(
            standardized
                .get("semantics")
                .and_then(|v| v.as_object())
                .and_then(|v| v.get("tools"))
                .and_then(|v| v.as_object())
                .and_then(|v| v.get("existing"))
                .and_then(|v| v.as_bool()),
            Some(true)
        );
        assert_eq!(
            standardized
                .get("semantics")
                .and_then(|v| v.as_object())
                .and_then(|v| v.get("tools"))
                .and_then(|v| v.as_object())
                .and_then(|v| v.get("clientToolsRaw"))
                .and_then(|v| v.as_array())
                .map(|v| v.len()),
            Some(1)
        );
        assert_eq!(
            raw_payload
                .get("parameters")
                .and_then(|v| v.as_object())
                .and_then(|v| v.get("temperature"))
                .and_then(|v| v.as_f64()),
            Some(0.2)
        );
    }

    #[test]
    fn test_coerce_standardized_request_from_payload_defaults_semantics_tools_and_raw_parameters() {
        let input = json!({
            "payload": {
                "model": "glm-5",
                "messages": [],
                "parameters": [],
                "semantics": { "tools": "invalid" }
            },
            "normalized": {
                "id": "req-2",
                "entryEndpoint": "/v1/chat/completions",
                "stream": false,
                "processMode": "chat"
            }
        });
        let output = coerce_standardized_request_from_payload(&input)
            .expect("coerce standardized request output");
        let row = output.as_object().expect("output object");
        let standardized = row
            .get("standardizedRequest")
            .and_then(|v| v.as_object())
            .expect("standardizedRequest object");
        let raw_payload = row
            .get("rawPayload")
            .and_then(|v| v.as_object())
            .expect("rawPayload object");

        assert_eq!(
            standardized
                .get("parameters")
                .and_then(|v| v.as_object())
                .map(|v| v.len()),
            Some(0)
        );
        assert_eq!(
            standardized
                .get("semantics")
                .and_then(|v| v.as_object())
                .and_then(|v| v.get("tools"))
                .and_then(|v| v.as_object())
                .map(|v| v.len()),
            Some(0)
        );
        assert!(!raw_payload.contains_key("parameters"));
    }

    #[test]
    fn test_coerce_standardized_request_from_payload_normalizes_exec_command_and_apply_patch_shapes(
    ) {
        let input = json!({
            "payload": {
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
                                    "arguments": "{\"args\":{\"command\":\"pwd\"},\"cwd\":\"/repo\"}"
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
            },
            "normalized": {
                "id": "req-shape",
                "entryEndpoint": "/v1/chat/completions",
                "stream": false,
                "processMode": "chat"
            }
        });

        let output = coerce_standardized_request_from_payload(&input)
            .expect("coerce standardized request output");
        let row = output.as_object().expect("output object");
        let standardized = row
            .get("standardizedRequest")
            .and_then(|v| v.as_object())
            .expect("standardizedRequest object");
        let messages = standardized
            .get("messages")
            .and_then(|v| v.as_array())
            .expect("messages");
        let tool_calls = messages[0]
            .get("tool_calls")
            .and_then(|v| v.as_array())
            .expect("tool calls");

        let exec_args_text = tool_calls[0]["function"]["arguments"]
            .as_str()
            .expect("exec args");
        let exec_args: Value = serde_json::from_str(exec_args_text).expect("exec args json");
        assert_eq!(exec_args["cmd"], "pwd");
        assert_eq!(exec_args["command"], "pwd");
        assert_eq!(exec_args["workdir"], "/repo");

        let patch_args_text = tool_calls[1]["function"]["arguments"]
            .as_str()
            .expect("patch args");
        let patch_args: Value = serde_json::from_str(patch_args_text).expect("patch args json");
        let patch_input = patch_args["input"].as_str().expect("patch input");
        assert!(patch_input.starts_with("*** Begin Patch"));
        assert!(patch_input.contains("*** Add File: note.txt"));
    }

    #[test]
    fn test_prepare_runtime_metadata_for_servertools_injects_runtime_configs() {
        let input = json!({
            "metadata": {
                "requestId": "req-1",
                "__rt": { "existing": true }
            },
            "webSearchConfig": { "enabled": true },
            "execCommandGuard": { "mode": "strict" },
            "clockConfig": { "tickMs": 60000 }
        });
        let output = prepare_runtime_metadata_for_servertools(&input)
            .expect("prepare runtime metadata for servertools");
        let row = output.as_object().expect("output object");
        assert_eq!(row.get("requestId").and_then(|v| v.as_str()), Some("req-1"));
        let rt = row
            .get("__rt")
            .and_then(|v| v.as_object())
            .expect("__rt object");
        assert_eq!(rt.get("existing").and_then(|v| v.as_bool()), Some(true));
        assert_eq!(
            rt.get("webSearch")
                .and_then(|v| v.as_object())
                .and_then(|v| v.get("enabled"))
                .and_then(|v| v.as_bool()),
            Some(true)
        );
        assert_eq!(
            rt.get("execCommandGuard")
                .and_then(|v| v.as_object())
                .and_then(|v| v.get("mode"))
                .and_then(|v| v.as_str()),
            Some("strict")
        );
        assert_eq!(
            rt.get("clock")
                .and_then(|v| v.as_object())
                .and_then(|v| v.get("tickMs"))
                .and_then(|v| v.as_i64()),
            Some(60000)
        );
    }

    #[test]
    fn test_prepare_runtime_metadata_for_servertools_normalizes_missing_or_invalid_rt() {
        let input = json!({
            "metadata": {
                "foo": "bar",
                "__rt": "invalid"
            },
            "webSearchConfig": null,
            "clockConfig": 1
        });
        let output = prepare_runtime_metadata_for_servertools(&input)
            .expect("prepare runtime metadata for servertools");
        let row = output.as_object().expect("output object");
        assert_eq!(row.get("foo").and_then(|v| v.as_str()), Some("bar"));
        let rt = row
            .get("__rt")
            .and_then(|v| v.as_object())
            .expect("__rt object");
        assert!(!rt.contains_key("webSearch"));
        assert!(!rt.contains_key("clock"));
    }

    #[test]
    fn test_apply_has_image_attachment_flag_adds_and_removes_flag() {
        let add_input = json!({
            "metadata": { "requestId": "req-1" },
            "hasImageAttachment": true
        });
        let add_output =
            apply_has_image_attachment_flag(&add_input).expect("apply has-image-attachment flag");
        let add_row = add_output.as_object().expect("object output");
        assert_eq!(
            add_row.get("hasImageAttachment").and_then(|v| v.as_bool()),
            Some(true)
        );

        let remove_input = json!({
            "metadata": {
                "requestId": "req-1",
                "hasImageAttachment": true
            },
            "hasImageAttachment": false
        });
        let remove_output = apply_has_image_attachment_flag(&remove_input)
            .expect("apply has-image-attachment flag");
        let remove_row = remove_output.as_object().expect("object output");
        assert!(!remove_row.contains_key("hasImageAttachment"));
        assert_eq!(
            remove_row.get("requestId").and_then(|v| v.as_str()),
            Some("req-1")
        );
    }

    #[test]
    fn test_apply_has_image_attachment_flag_normalizes_invalid_metadata() {
        let input = json!({
            "metadata": "invalid",
            "hasImageAttachment": true
        });
        let output =
            apply_has_image_attachment_flag(&input).expect("apply has-image-attachment flag");
        let row = output.as_object().expect("object output");
        assert_eq!(
            row.get("hasImageAttachment").and_then(|v| v.as_bool()),
            Some(true)
        );
    }

    #[test]
    fn test_sync_session_identifiers_to_metadata_injects_trimmed_values() {
        let input = json!({
            "metadata": { "existing": true },
            "sessionId": "  session-1  ",
            "conversationId": " conv-1 "
        });
        let output = sync_session_identifiers_to_metadata(&input)
            .expect("sync session identifiers to metadata");
        let row = output.as_object().expect("object output");
        assert_eq!(row.get("existing").and_then(|v| v.as_bool()), Some(true));
        assert_eq!(
            row.get("sessionId").and_then(|v| v.as_str()),
            Some("session-1")
        );
        assert_eq!(
            row.get("conversationId").and_then(|v| v.as_str()),
            Some("conv-1")
        );
    }

    #[test]
    fn test_sync_session_identifiers_to_metadata_ignores_blank_or_missing_values() {
        let input = json!({
            "metadata": {
                "sessionId": "existing-session",
                "conversationId": "existing-conv"
            },
            "sessionId": "   ",
            "conversationId": null
        });
        let output = sync_session_identifiers_to_metadata(&input)
            .expect("sync session identifiers to metadata");
        let row = output.as_object().expect("object output");
        assert_eq!(
            row.get("sessionId").and_then(|v| v.as_str()),
            Some("existing-session")
        );
        assert_eq!(
            row.get("conversationId").and_then(|v| v.as_str()),
            Some("existing-conv")
        );
    }

    #[test]
    fn test_merge_clock_reservation_into_metadata_merges_object_reservation() {
        let input = json!({
            "metadata": { "existing": true },
            "processedRequest": {
                "metadata": {
                    "__clockReservation": {
                        "reservationId": "r1",
                        "taskIds": ["a", "b"]
                    }
                }
            }
        });
        let output = merge_clock_reservation_into_metadata(&input)
            .expect("merge clock reservation into metadata");
        let row = output.as_object().expect("output object");
        assert_eq!(row.get("existing").and_then(|v| v.as_bool()), Some(true));
        assert_eq!(
            row.get("__clockReservation")
                .and_then(|v| v.as_object())
                .and_then(|v| v.get("reservationId"))
                .and_then(|v| v.as_str()),
            Some("r1")
        );
    }

    #[test]
    fn test_merge_clock_reservation_into_metadata_ignores_non_object_reservation() {
        let input = json!({
            "metadata": { "existing": true },
            "processedRequest": {
                "metadata": {
                    "__clockReservation": "invalid"
                }
            }
        });
        let output = merge_clock_reservation_into_metadata(&input)
            .expect("merge clock reservation into metadata");
        let row = output.as_object().expect("output object");
        assert_eq!(row.get("existing").and_then(|v| v.as_bool()), Some(true));
        assert!(!row.contains_key("__clockReservation"));
    }

    #[test]
    fn test_build_tool_governance_node_result_builds_expected_shape() {
        let input = json!({
            "success": true,
            "metadata": {
                "node": "chat_process.req.stage4.tool_governance",
                "foo": "bar"
            },
            "error": {
                "message": "bad request",
                "details": { "x": 1 }
            }
        });
        let output =
            build_tool_governance_node_result(&input).expect("build tool governance node result");
        let row = output.as_object().expect("output object");
        assert_eq!(
            row.get("id").and_then(|v| v.as_str()),
            Some("chat_process.req.stage4.tool_governance")
        );
        assert_eq!(row.get("success").and_then(|v| v.as_bool()), Some(true));
        assert_eq!(
            row.get("metadata")
                .and_then(|v| v.as_object())
                .and_then(|v| v.get("foo"))
                .and_then(|v| v.as_str()),
            Some("bar")
        );
        assert_eq!(
            row.get("error")
                .and_then(|v| v.as_object())
                .and_then(|v| v.get("code"))
                .and_then(|v| v.as_str()),
            Some("hub_chat_process_error")
        );
        assert_eq!(
            row.get("error")
                .and_then(|v| v.as_object())
                .and_then(|v| v.get("message"))
                .and_then(|v| v.as_str()),
            Some("bad request")
        );
        assert_eq!(
            row.get("error")
                .and_then(|v| v.as_object())
                .and_then(|v| v.get("details"))
                .and_then(|v| v.as_object())
                .and_then(|v| v.get("x"))
                .and_then(|v| v.as_i64()),
            Some(1)
        );
    }

    #[test]
    fn test_build_tool_governance_node_result_coerces_invalid_metadata_to_object() {
        let input = json!({
            "success": false,
            "metadata": "invalid"
        });
        let output =
            build_tool_governance_node_result(&input).expect("build tool governance node result");
        let row = output.as_object().expect("output object");
        assert_eq!(row.get("success").and_then(|v| v.as_bool()), Some(false));
        assert_eq!(
            row.get("metadata")
                .and_then(|v| v.as_object())
                .map(|v| v.len()),
            Some(0)
        );
        assert!(!row.contains_key("error"));
    }

    #[test]
    fn test_build_passthrough_governance_skipped_node_shape() {
        let output = build_passthrough_governance_skipped_node();
        let row = output.as_object().expect("output object");
        assert_eq!(
            row.get("id").and_then(|v| v.as_str()),
            Some("chat_process.req.stage4.tool_governance")
        );
        assert_eq!(row.get("success").and_then(|v| v.as_bool()), Some(true));
        assert_eq!(
            row.get("metadata")
                .and_then(|v| v.as_object())
                .and_then(|v| v.get("skipped"))
                .and_then(|v| v.as_bool()),
            Some(true)
        );
        assert_eq!(
            row.get("metadata")
                .and_then(|v| v.as_object())
                .and_then(|v| v.get("reason"))
                .and_then(|v| v.as_str()),
            Some("process_mode_passthrough_parse_record_only")
        );
    }

    #[test]
    fn test_extract_adapter_context_metadata_fields_trims_strings_and_keeps_booleans() {
        let metadata = json!({
            "clockDaemonId": "  daemon-1 ",
            "clientInjectReady": true,
            "workdir": "   ",
            "ignored": 123
        });
        let keys = json!([
            "clockDaemonId",
            "clientInjectReady",
            "workdir",
            "missing",
            1
        ]);
        let output = extract_adapter_context_metadata_fields(&metadata, &keys);
        let row = output.as_object().expect("object output");
        assert_eq!(
            row.get("clockDaemonId").and_then(|v| v.as_str()),
            Some("daemon-1")
        );
        assert_eq!(
            row.get("clientInjectReady").and_then(|v| v.as_bool()),
            Some(true)
        );
        assert!(!row.contains_key("workdir"));
        assert!(!row.contains_key("missing"));
    }

    #[test]
    fn test_resolve_adapter_context_metadata_signals_extracts_expected_fields() {
        let metadata = json!({
            "clientRequestId": " req-1 ",
            "groupRequestId": " group-1 ",
            "originalModelId": "",
            "clientModelId": "client-model",
            "assignedModelId": "assigned-model",
            "estimated_tokens": " 12.6 ",
            "sessionId": " sid-1 ",
            "conversationId": " cid-1 ",
            "ignored": true
        });
        let output = resolve_adapter_context_metadata_signals(&metadata);
        let row = output.as_object().expect("object output");
        assert_eq!(
            row.get("clientRequestId").and_then(|v| v.as_str()),
            Some("req-1")
        );
        assert_eq!(
            row.get("groupRequestId").and_then(|v| v.as_str()),
            Some("group-1")
        );
        assert_eq!(
            row.get("originalModelId").and_then(|v| v.as_str()),
            Some("")
        );
        assert_eq!(
            row.get("clientModelId").and_then(|v| v.as_str()),
            Some("client-model")
        );
        assert_eq!(
            row.get("modelId").and_then(|v| v.as_str()),
            Some("assigned-model")
        );
        assert_eq!(
            row.get("estimatedInputTokens").and_then(|v| v.as_f64()),
            Some(13.0)
        );
        assert_eq!(row.get("sessionId").and_then(|v| v.as_str()), Some("sid-1"));
        assert_eq!(
            row.get("conversationId").and_then(|v| v.as_str()),
            Some("cid-1")
        );
        assert!(!row.contains_key("ignored"));
    }

    #[test]
    fn test_resolve_adapter_context_metadata_signals_omits_invalid_entries() {
        let metadata = json!({
            "clientRequestId": "   ",
            "groupRequestId": 123,
            "estimatedInputTokens": 0,
            "sessionId": "\t",
            "conversationId": null,
            "assignedModelId": ["bad"]
        });
        let output = resolve_adapter_context_metadata_signals(&metadata);
        let row = output.as_object().expect("object output");
        assert!(!row.contains_key("clientRequestId"));
        assert!(!row.contains_key("groupRequestId"));
        assert!(!row.contains_key("estimatedInputTokens"));
        assert!(!row.contains_key("sessionId"));
        assert!(!row.contains_key("conversationId"));
        assert!(!row.contains_key("modelId"));
    }

    #[test]
    fn test_resolve_adapter_context_object_carriers_keeps_object_values() {
        let metadata = json!({
            "runtime": {
                "clock": { "enabled": true }
            },
            "capturedChatRequest": {
                "model": "gpt-5",
                "messages": []
            },
            "clientConnectionState": {
                "disconnected": false
            }
        });
        let output = resolve_adapter_context_object_carriers(&metadata);
        let row = output.as_object().expect("object output");
        assert!(row.get("runtime").and_then(|v| v.as_object()).is_some());
        assert!(row
            .get("capturedChatRequest")
            .and_then(|v| v.as_object())
            .is_some());
        assert!(row
            .get("clientConnectionState")
            .and_then(|v| v.as_object())
            .is_some());
        assert_eq!(
            row.get("clientDisconnected").and_then(|v| v.as_bool()),
            Some(false)
        );
    }

    #[test]
    fn test_resolve_adapter_context_object_carriers_omits_non_objects() {
        let metadata = json!({
            "runtime": [],
            "capturedChatRequest": "bad",
            "clientConnectionState": true
        });
        let output = resolve_adapter_context_object_carriers(&metadata);
        let row = output.as_object().expect("object output");
        assert!(!row.contains_key("runtime"));
        assert!(!row.contains_key("capturedChatRequest"));
        assert!(!row.contains_key("clientConnectionState"));
    }

    #[test]
    fn test_resolve_adapter_context_object_carriers_merges_client_disconnected_signal() {
        let metadata = json!({
            "clientConnectionState": {
                "disconnected": false
            },
            "clientDisconnected": " true "
        });
        let output = resolve_adapter_context_object_carriers(&metadata);
        let row = output.as_object().expect("object output");
        assert_eq!(
            row.get("clientDisconnected").and_then(|v| v.as_bool()),
            Some(true)
        );
    }

    #[test]
    fn test_resolve_adapter_context_client_connection_state_prefers_explicit_true() {
        let metadata = json!({
            "clientConnectionState": {
                "disconnected": false
            },
            "clientDisconnected": " true "
        });
        let output = resolve_adapter_context_client_connection_state(&metadata);
        let row = output.as_object().expect("object output");
        assert_eq!(
            row.get("clientDisconnected").and_then(|v| v.as_bool()),
            Some(true)
        );
    }

    #[test]
    fn test_resolve_adapter_context_client_connection_state_reads_state_flag() {
        let metadata = json!({
            "clientConnectionState": {
                "disconnected": false
            }
        });
        let output = resolve_adapter_context_client_connection_state(&metadata);
        let row = output.as_object().expect("object output");
        assert_eq!(
            row.get("clientDisconnected").and_then(|v| v.as_bool()),
            Some(false)
        );
    }

    #[test]
    fn test_resolve_adapter_context_client_connection_state_omits_when_unavailable() {
        let metadata = json!({
            "clientConnectionState": {
                "disconnected": "unknown"
            },
            "clientDisconnected": false
        });
        let output = resolve_adapter_context_client_connection_state(&metadata);
        let row = output.as_object().expect("object output");
        assert!(!row.contains_key("clientDisconnected"));
    }

    #[test]
    fn test_resolve_hub_policy_override_valid() {
        let metadata = json!({
            "__hubPolicyOverride": {
                "mode": " Observe ",
                "sampleRate": 0.5
            }
        });
        let output = resolve_hub_policy_override(&metadata).expect("policy override");
        let row = output.as_object().expect("object output");
        assert_eq!(row.get("mode").and_then(|v| v.as_str()), Some("observe"));
        assert_eq!(row.get("sampleRate").and_then(|v| v.as_f64()), Some(0.5));
    }

    #[test]
    fn test_resolve_hub_policy_override_invalid_mode_returns_none() {
        let metadata = json!({
            "__hubPolicyOverride": {
                "mode": "invalid"
            }
        });
        let output = resolve_hub_policy_override(&metadata);
        assert!(output.is_none());
    }

    #[test]
    fn test_resolve_hub_shadow_compare_mode_fallback() {
        let metadata = json!({
            "__hubShadowCompare": {
                "mode": " enforce "
            }
        });
        let output = resolve_hub_shadow_compare_config(&metadata).expect("shadow compare");
        let row = output.as_object().expect("object output");
        assert_eq!(
            row.get("baselineMode").and_then(|v| v.as_str()),
            Some("enforce")
        );
    }

    #[test]
    fn test_resolve_hub_shadow_compare_invalid_returns_none() {
        let metadata = json!({
            "__hubShadowCompare": {
                "baselineMode": "x"
            }
        });
        let output = resolve_hub_shadow_compare_config(&metadata);
        assert!(output.is_none());
    }

    #[test]
    fn test_resolve_apply_patch_tool_mode_from_tools_freeform() {
        let tools = json!([
            {
                "type": "function",
                "function": { "name": "apply_patch", "format": "freeform" }
            }
        ]);
        let mode = resolve_apply_patch_tool_mode_from_tools(&tools);
        assert_eq!(mode.as_deref(), Some("freeform"));
    }

    #[test]
    fn test_resolve_apply_patch_tool_mode_from_tools_defaults_to_schema() {
        let tools = json!([
            {
                "type": "function",
                "function": { "name": "apply_patch" }
            }
        ]);
        let mode = resolve_apply_patch_tool_mode_from_tools(&tools);
        assert_eq!(mode.as_deref(), Some("schema"));
    }

    #[test]
    fn test_resolve_apply_patch_tool_mode_from_tools_non_matching_returns_none() {
        let tools = json!([
            {
                "type": "function",
                "function": { "name": "exec_command" }
            }
        ]);
        let mode = resolve_apply_patch_tool_mode_from_tools(&tools);
        assert!(mode.is_none());
    }

    #[test]
    fn test_is_search_route_id_true_for_web_search_prefix() {
        let route_id = json!(" web_search_tools ");
        assert!(is_search_route_id(&route_id));
    }

    #[test]
    fn test_is_search_route_id_false_for_non_search_route() {
        let route_id = json!("default");
        assert!(!is_search_route_id(&route_id));
    }

    #[test]
    fn test_is_canonical_web_search_tool_definition_true_for_builtin_type() {
        let tool = json!({
            "type": "web_search_20250305",
            "name": "web_search"
        });
        assert!(is_canonical_web_search_tool_definition(&tool));
    }

    #[test]
    fn test_is_canonical_web_search_tool_definition_true_for_function_alias() {
        let tool = json!({
            "type": "function",
            "function": { "name": "web-search" }
        });
        assert!(is_canonical_web_search_tool_definition(&tool));
    }

    #[test]
    fn test_is_canonical_web_search_tool_definition_false_for_non_search_tool() {
        let tool = json!({
            "type": "function",
            "function": { "name": "exec_command" }
        });
        assert!(!is_canonical_web_search_tool_definition(&tool));
    }

    #[test]
    fn test_apply_direct_builtin_web_search_tool_replaces_canonical_entry() {
        let provider_payload = json!({
            "model": "claude-3-7-sonnet",
            "tools": [
                {
                    "type": "function",
                    "function": { "name": "web_search" }
                },
                {
                    "type": "function",
                    "function": { "name": "exec_command" }
                }
            ]
        });
        let runtime_metadata = json!({
            "webSearch": {
                "engines": [
                    {
                        "executionMode": "direct",
                        "directActivation": "builtin",
                        "modelId": "claude-3-7-sonnet",
                        "maxUses": "3"
                    }
                ]
            }
        });
        let output = apply_direct_builtin_web_search_tool(
            &provider_payload,
            "anthropic-messages",
            &json!("web_search.default"),
            &runtime_metadata,
        );
        let tools = output
            .get("tools")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();
        assert_eq!(tools.len(), 2);
        assert_eq!(
            tools
                .first()
                .and_then(|v| v.get("type"))
                .and_then(|v| v.as_str()),
            Some("web_search_20250305")
        );
        assert_eq!(
            tools
                .first()
                .and_then(|v| v.get("max_uses"))
                .and_then(|v| v.as_i64()),
            Some(3)
        );
        assert_eq!(
            tools
                .get(1)
                .and_then(|v| v.get("function"))
                .and_then(|v| v.get("name"))
                .and_then(|v| v.as_str()),
            Some("exec_command")
        );
    }

    #[test]
    fn test_apply_direct_builtin_web_search_tool_inserts_when_missing() {
        let provider_payload = json!({
            "model": "claude-3-7-sonnet",
            "tools": [
                {
                    "type": "function",
                    "function": { "name": "exec_command" }
                }
            ]
        });
        let runtime_metadata = json!({
            "webSearch": {
                "engines": [
                    {
                        "executionMode": "direct",
                        "directActivation": "builtin",
                        "providerKey": "tabglm.key1.claude-3-7-sonnet"
                    }
                ]
            }
        });
        let output = apply_direct_builtin_web_search_tool(
            &provider_payload,
            "anthropic-messages",
            &json!("search.route"),
            &runtime_metadata,
        );
        let tools = output
            .get("tools")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();
        assert_eq!(tools.len(), 2);
        assert_eq!(
            tools
                .first()
                .and_then(|v| v.get("type"))
                .and_then(|v| v.as_str()),
            Some("web_search_20250305")
        );
        assert_eq!(
            tools
                .first()
                .and_then(|v| v.get("max_uses"))
                .and_then(|v| v.as_i64()),
            Some(2)
        );
    }

    #[test]
    fn test_apply_direct_builtin_web_search_tool_noop_for_non_matching_engine() {
        let provider_payload = json!({
            "model": "claude-3-7-sonnet",
            "tools": [
                {
                    "type": "function",
                    "function": { "name": "exec_command" }
                }
            ]
        });
        let runtime_metadata = json!({
            "webSearch": {
                "engines": [
                    {
                        "executionMode": "proxy",
                        "directActivation": "builtin",
                        "modelId": "claude-3-7-sonnet"
                    }
                ]
            }
        });
        let output = apply_direct_builtin_web_search_tool(
            &provider_payload,
            "anthropic-messages",
            &json!("web_search.default"),
            &runtime_metadata,
        );
        assert_eq!(output, provider_payload);
    }

    #[test]
    fn test_lift_responses_resume_into_semantics_injects_when_missing_and_clears_metadata() {
        let request = json!({
            "messages": [],
            "semantics": {}
        });
        let metadata = json!({
            "responsesResume": {
                "response_id": "resp_1"
            },
            "other": true
        });
        let output = lift_responses_resume_into_semantics(&request, &metadata);
        assert_eq!(
            output
                .get("request")
                .and_then(|v| v.get("semantics"))
                .and_then(|v| v.get("responses"))
                .and_then(|v| v.get("resume"))
                .and_then(|v| v.get("response_id"))
                .and_then(|v| v.as_str()),
            Some("resp_1")
        );
        assert_eq!(
            output
                .get("metadata")
                .and_then(|v| v.get("responsesResume"))
                .is_some(),
            false
        );
        assert_eq!(
            output
                .get("metadata")
                .and_then(|v| v.get("other"))
                .and_then(|v| v.as_bool()),
            Some(true)
        );
    }

    #[test]
    fn test_lift_responses_resume_into_semantics_preserves_existing_resume() {
        let request = json!({
            "messages": [],
            "semantics": {
                "responses": {
                    "resume": {
                        "response_id": "existing"
                    }
                }
            }
        });
        let metadata = json!({
            "responsesResume": {
                "response_id": "new"
            }
        });
        let output = lift_responses_resume_into_semantics(&request, &metadata);
        assert_eq!(
            output
                .get("request")
                .and_then(|v| v.get("semantics"))
                .and_then(|v| v.get("responses"))
                .and_then(|v| v.get("resume"))
                .and_then(|v| v.get("response_id"))
                .and_then(|v| v.as_str()),
            Some("existing")
        );
        assert_eq!(
            output
                .get("metadata")
                .and_then(|v| v.get("responsesResume"))
                .is_some(),
            false
        );
    }

    #[test]
    fn test_sync_responses_context_from_canonical_messages_updates_context_fields() {
        let request = json!({
            "messages": [
                { "role": "system", "content": "system keep" },
                { "role": "user", "content": "hello" }
            ],
            "tools": [
                {
                    "type": "function",
                    "function": { "name": "exec_command", "parameters": { "type": "object" } }
                }
            ],
            "semantics": {
                "responses": {
                    "context": {
                        "existing": true
                    }
                }
            }
        });
        let output = sync_responses_context_from_canonical_messages(&request);
        assert_eq!(
            output
                .get("semantics")
                .and_then(|v| v.get("responses"))
                .and_then(|v| v.get("context"))
                .and_then(|v| v.get("existing"))
                .and_then(|v| v.as_bool()),
            Some(true)
        );
        assert_eq!(
            output
                .get("semantics")
                .and_then(|v| v.get("responses"))
                .and_then(|v| v.get("context"))
                .and_then(|v| v.get("input"))
                .and_then(|v| v.as_array())
                .is_some(),
            true
        );
        assert_eq!(
            output
                .get("semantics")
                .and_then(|v| v.get("responses"))
                .and_then(|v| v.get("context"))
                .and_then(|v| v.get("originalSystemMessages"))
                .and_then(|v| v.as_array())
                .is_some(),
            true
        );
    }

    #[test]
    fn test_sync_responses_context_from_canonical_messages_no_context_noop() {
        let request = json!({
            "messages": [{ "role": "user", "content": "hello" }],
            "semantics": {
                "responses": {}
            }
        });
        let output = sync_responses_context_from_canonical_messages(&request);
        assert_eq!(output, request);
    }

    #[test]
    fn test_read_responses_resume_from_metadata_returns_object() {
        let metadata = json!({
            "responsesResume": {
                "response_id": "resp_123",
                "tool_outputs": [{"tool_call_id": "call_1", "output": "ok"}]
            }
        });
        let output = read_responses_resume_from_metadata(&metadata).expect("resume object");
        assert_eq!(
            output.get("response_id").and_then(|v| v.as_str()),
            Some("resp_123")
        );
    }

    #[test]
    fn test_read_responses_resume_from_metadata_ignores_non_object() {
        let metadata = json!({
            "responsesResume": "resp_123"
        });
        let output = read_responses_resume_from_metadata(&metadata);
        assert!(output.is_none());
    }

    #[test]
    fn test_read_responses_resume_from_request_semantics_returns_object() {
        let request = json!({
            "messages": [],
            "semantics": {
                "responses": {
                    "resume": {
                        "response_id": "resp_456"
                    }
                }
            }
        });
        let output = read_responses_resume_from_request_semantics(&request).expect("resume object");
        assert_eq!(
            output.get("response_id").and_then(|v| v.as_str()),
            Some("resp_456")
        );
    }

    #[test]
    fn test_read_responses_resume_from_request_semantics_missing_returns_none() {
        let request = json!({
            "messages": [],
            "semantics": {
                "responses": {
                    "resume": null
                }
            }
        });
        let output = read_responses_resume_from_request_semantics(&request);
        assert!(output.is_none());
    }

    #[test]
    fn test_resolve_has_instruction_requested_passthrough_true_for_named_target() {
        let messages = json!([
            {
                "role": "user",
                "content": "<**sticky:tabglm.key1.glm-5:passthrough**>"
            }
        ]);
        assert!(resolve_has_instruction_requested_passthrough(&messages));
    }

    #[test]
    fn test_resolve_has_instruction_requested_passthrough_ignores_historical_user_message() {
        let messages = json!([
            {
                "role": "user",
                "content": "<**sticky:tabglm.key1.glm-5:passthrough**>"
            },
            {
                "role": "assistant",
                "content": "ack"
            }
        ]);
        assert!(!resolve_has_instruction_requested_passthrough(&messages));
    }

    #[test]
    fn test_resolve_has_instruction_requested_passthrough_ignores_code_block_marker() {
        let messages = json!([
            {
                "role": "user",
                "content": "```txt\n<**sticky:tabglm.key1.glm-5:passthrough**>\n```"
            }
        ]);
        assert!(!resolve_has_instruction_requested_passthrough(&messages));
    }

    #[test]
    fn test_resolve_active_process_mode_prefers_passthrough_base_mode() {
        let messages = json!([
            {
                "role": "user",
                "content": "normal text"
            }
        ]);
        assert_eq!(
            resolve_active_process_mode("passthrough", &messages),
            "passthrough"
        );
    }

    #[test]
    fn test_resolve_active_process_mode_activates_passthrough_from_instruction() {
        let messages = json!([
            {
                "role": "user",
                "content": "<**sticky:tabglm.key1.glm-5:passthrough**>"
            }
        ]);
        assert_eq!(
            resolve_active_process_mode("chat", &messages),
            "passthrough"
        );
    }

    #[test]
    fn test_find_mappable_semantics_keys_collects_only_present_keys() {
        let metadata = json!({
            "responses_resume": [],
            "extraFields": {"x": 1},
            "safe": true
        });
        let keys = find_mappable_semantics_keys(&metadata);
        assert_eq!(
            keys,
            vec!["responses_resume".to_string(), "extraFields".to_string()]
        );
    }

    #[test]
    fn test_build_passthrough_audit_collects_non_canonical_keys_sorted() {
        let raw = json!({
            "messages": [],
            "model": "m",
            "zeta": true,
            "alpha": 1
        });
        let output = build_passthrough_audit(&raw, "openai-chat");
        let keys = output
            .get("todo")
            .and_then(|v| v.get("inbound"))
            .and_then(|v| v.get("unmappedTopLevelKeys"))
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();
        assert_eq!(keys, vec![json!("alpha"), json!("zeta")]);
    }

    #[test]
    fn test_annotate_passthrough_governance_skip_sets_governance_marker() {
        let audit = json!({ "raw": { "inbound": {} } });
        let output = annotate_passthrough_governance_skip(&audit);
        assert_eq!(
            output
                .get("todo")
                .and_then(|v| v.get("governance"))
                .and_then(|v| v.get("skipped"))
                .and_then(|v| v.as_bool()),
            Some(true)
        );
        assert_eq!(
            output
                .get("todo")
                .and_then(|v| v.get("governance"))
                .and_then(|v| v.get("reason"))
                .and_then(|v| v.as_str()),
            Some("process_mode_passthrough")
        );
    }

    #[test]
    fn test_attach_passthrough_provider_input_audit_sets_provider_input_and_outbound_todo() {
        let audit = json!({
            "raw": { "inbound": { "messages": [] } },
            "todo": { "inbound": { "unmappedTopLevelKeys": [] } }
        });
        let provider_payload = json!({
            "messages": [],
            "custom_field": "x"
        });
        let output = attach_passthrough_provider_input_audit(
            &audit,
            &provider_payload,
            "anthropic-messages",
        );
        assert_eq!(
            output
                .get("raw")
                .and_then(|v| v.get("providerInput"))
                .and_then(|v| v.get("custom_field"))
                .and_then(|v| v.as_str()),
            Some("x")
        );
        let outbound_keys = output
            .get("todo")
            .and_then(|v| v.get("outbound"))
            .and_then(|v| v.get("unmappedTopLevelKeys"))
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();
        assert_eq!(outbound_keys, vec![json!("custom_field")]);
        assert_eq!(
            output
                .get("todo")
                .and_then(|v| v.get("outbound"))
                .and_then(|v| v.get("providerProtocol"))
                .and_then(|v| v.as_str()),
            Some("anthropic-messages")
        );
    }

    #[test]
    fn test_error_output_structure() {
        let result = run_hub_pipeline_json("not json".to_string());
        assert!(result.is_err());
    }
}
