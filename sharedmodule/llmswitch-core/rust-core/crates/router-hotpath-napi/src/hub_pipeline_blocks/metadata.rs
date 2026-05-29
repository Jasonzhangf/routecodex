use serde_json::{Map, Value};

use crate::shared_json_utils::read_first_object_trimmed_string;

pub(crate) fn resolve_stop_message_router_metadata(metadata: &Value) -> Value {
    let mut out = Map::<String, Value>::new();
    let metadata_obj = match metadata.as_object() {
        Some(v) => v,
        None => return Value::Object(out),
    };

    if let Some(scope) =
        read_first_object_trimmed_string(metadata_obj, &["stopMessageClientInjectSessionScope"])
    {
        out.insert(
            "stopMessageClientInjectSessionScope".to_string(),
            Value::String(scope),
        );
    }
    if let Some(scope) =
        read_first_object_trimmed_string(metadata_obj, &["stopMessageClientInjectScope"])
    {
        out.insert(
            "stopMessageClientInjectScope".to_string(),
            Value::String(scope),
        );
    }

    let client_tmux = read_first_object_trimmed_string(
        metadata_obj,
        &["clientTmuxSessionId", "client_tmux_session_id"],
    );
    let tmux =
        read_first_object_trimmed_string(metadata_obj, &["tmuxSessionId", "tmux_session_id"]);
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

pub(crate) fn resolve_router_metadata_runtime_flags(metadata: &Value) -> Value {
    let mut out = Map::<String, Value>::new();
    let metadata_obj = match metadata.as_object() {
        Some(v) => v,
        None => return Value::Object(out),
    };

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

pub(crate) fn build_hub_pipeline_result_metadata(input: &Value) -> Result<Value, String> {
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

fn normalize_hub_policy_mode(raw: Option<&str>) -> String {
    let token = raw.unwrap_or("").trim().to_ascii_lowercase();
    match token.as_str() {
        "observe" | "enforce" => token,
        _ => "off".to_string(),
    }
}
