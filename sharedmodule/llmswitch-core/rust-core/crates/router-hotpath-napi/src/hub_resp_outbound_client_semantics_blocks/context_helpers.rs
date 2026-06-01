use serde_json::Value;

pub(crate) fn resolve_truthy_flag(raw: &Value) -> bool {
    if raw.as_bool().unwrap_or(false) {
        return true;
    }
    let value = raw
        .as_str()
        .map(|v| v.trim().to_ascii_lowercase())
        .unwrap_or_default();
    matches!(value.as_str(), "1" | "true")
}

fn resolve_non_empty_string(raw: Option<&Value>) -> Option<String> {
    raw.and_then(|value| {
        value
            .as_str()
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty())
    })
}

pub(crate) fn resolve_display_model_from_context(context: &Value) -> Option<String> {
    let row = context.as_object()?;
    for key in ["originalModelId", "clientModelId", "modelId"] {
        if let Some(value) = resolve_non_empty_string(row.get(key)) {
            return Some(value);
        }
    }
    None
}

pub(crate) fn resolve_client_facing_request_id_from_context(context: &Value) -> Option<String> {
    let row = context.as_object()?;
    for key in ["clientRequestId", "groupRequestId", "requestId"] {
        if let Some(value) = resolve_non_empty_string(row.get(key)) {
            return Some(value);
        }
    }
    None
}

pub(crate) fn resolve_tool_surface_shadow_enabled(raw_mode: &Value) -> bool {
    let value = raw_mode
        .as_str()
        .map(|v| v.trim().to_ascii_lowercase())
        .unwrap_or_default();
    if value.is_empty() {
        return false;
    }
    if matches!(value.as_str(), "off" | "0" | "false") {
        return false;
    }
    matches!(value.as_str(), "observe" | "shadow" | "enforce")
}

pub(crate) fn resolve_client_protocol_for_response_entry(
    entry_endpoint: Option<&str>,
    is_followup: bool,
) -> String {
    let lowered = entry_endpoint.unwrap_or("").trim().to_ascii_lowercase();
    if lowered.contains("/v1/responses") {
        return "openai-responses".to_string();
    }
    if lowered.contains("/v1/messages") {
        return "anthropic-messages".to_string();
    }
    if is_followup {
        return "openai-chat".to_string();
    }
    "openai-chat".to_string()
}
