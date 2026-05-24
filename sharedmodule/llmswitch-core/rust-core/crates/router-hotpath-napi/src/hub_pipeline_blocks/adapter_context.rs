use serde_json::{Map, Value};

use crate::shared_json_utils::parse_js_number_like;

pub(crate) fn extract_adapter_context_metadata_fields(metadata: &Value, keys: &Value) -> Value {
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

pub(crate) fn resolve_adapter_context_client_connection_state(metadata: &Value) -> Value {
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

pub(crate) fn resolve_adapter_context_metadata_signals(metadata: &Value) -> Value {
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

pub(crate) fn resolve_adapter_context_object_carriers(metadata: &Value) -> Value {
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
