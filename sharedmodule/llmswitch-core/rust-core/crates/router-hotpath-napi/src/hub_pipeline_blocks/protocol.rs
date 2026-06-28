use serde_json::{Map, Value};

pub(crate) fn normalize_endpoint(endpoint: &str) -> String {
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

pub(crate) fn resolve_provider_protocol(value: &str) -> Result<String, String> {
    if value.trim().is_empty() {
        return Err("providerProtocol is required".to_string());
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

pub(crate) fn resolve_hub_client_protocol(entry_endpoint: &str) -> String {
    let lowered = entry_endpoint.to_ascii_lowercase();
    if lowered.contains("/v1/responses") {
        return "openai-responses".to_string();
    }
    if lowered.contains("/v1/messages") {
        return "anthropic-messages".to_string();
    }
    "openai-chat".to_string()
}

pub(crate) fn resolve_outbound_stream_intent(provider_preference: &Value) -> Option<bool> {
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

pub(crate) fn apply_outbound_stream_preference(
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

pub(crate) fn resolve_sse_protocol(_metadata: &Value, provider_protocol: &str) -> String {
    let fallback = provider_protocol.trim();
    if fallback.is_empty() {
        return "openai-chat".to_string();
    }
    fallback.to_string()
}

pub(crate) fn extract_model_hint_from_metadata(metadata: &Value) -> Option<String> {
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
