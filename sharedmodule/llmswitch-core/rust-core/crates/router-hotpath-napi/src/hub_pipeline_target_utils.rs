use napi::bindgen_prelude::Result as NapiResult;
use napi_derive::napi;
use serde_json::{Map, Value};

fn read_trimmed_string(value: Option<&Value>) -> Option<String> {
    let raw = value?.as_str()?;
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    Some(trimmed.to_string())
}

fn extract_target_model_id(target: &Value) -> Option<String> {
    let target_obj = target.as_object()?;
    let provider_key = read_trimmed_string(target_obj.get("providerKey"))?;

    if let Some(model_id) = read_trimmed_string(target_obj.get("modelId")) {
        return Some(model_id);
    }

    if let Some(runtime_key) = read_trimmed_string(target_obj.get("runtimeKey")) {
        let prefix = format!("{}.", runtime_key);
        if provider_key.starts_with(&prefix) {
            let candidate = provider_key[prefix.len()..].trim();
            if !candidate.is_empty() {
                return Some(candidate.to_string());
            }
        }
    }

    let first_dot = provider_key.find('.')?;
    if first_dot == 0 || first_dot + 1 >= provider_key.len() {
        return None;
    }
    let fallback = provider_key[first_dot + 1..].trim();
    if fallback.is_empty() {
        return None;
    }
    Some(fallback.to_string())
}

fn is_truthy(value: Option<&Value>) -> bool {
    match value {
        Some(Value::Bool(v)) => *v,
        Some(Value::Number(v)) => v.as_f64().map(|n| n != 0.0).unwrap_or(false),
        Some(Value::String(v)) => !v.trim().is_empty(),
        Some(Value::Array(v)) => !v.is_empty(),
        Some(Value::Object(v)) => !v.is_empty(),
        _ => false,
    }
}

fn has_non_empty_string(map: &Map<String, Value>, key: &str) -> bool {
    map.get(key)
        .and_then(|v| v.as_str())
        .map(|v| !v.trim().is_empty())
        .unwrap_or(false)
}

fn ensure_runtime_metadata(
    metadata_obj: &mut Map<String, Value>,
) -> Option<&mut Map<String, Value>> {
    let missing = !matches!(metadata_obj.get("__rt"), Some(Value::Object(_)));
    if missing {
        metadata_obj.insert("__rt".to_string(), Value::Object(Map::new()));
    }
    metadata_obj.get_mut("__rt").and_then(|v| v.as_object_mut())
}

fn parse_optional_trimmed_string_json(raw_json: &str) -> Option<String> {
    let parsed: Value = serde_json::from_str(raw_json).ok()?;
    read_trimmed_string(Some(&parsed))
}

fn apply_target_metadata(
    metadata: &mut Value,
    target: &Value,
    route_name: Option<&str>,
    original_model: Option<&str>,
) {
    let Some(metadata_obj) = metadata.as_object_mut() else {
        return;
    };
    let Some(target_obj) = target.as_object() else {
        return;
    };

    if let Some(route_name_value) = route_name {
        metadata_obj.insert(
            "routeName".to_string(),
            Value::String(route_name_value.to_string()),
        );

        // Preserve original reasoning_effort before override (for response-side restoration)
        if let Some(existing_effort) = metadata_obj
            .get("reasoning_effort")
            .and_then(|v| v.as_str())
        {
            let trimmed = existing_effort.trim();
            if !trimmed.is_empty() {
                metadata_obj.insert(
                    "originalReasoningEffort".to_string(),
                    Value::String(trimmed.to_string()),
                );
            }
        }

        // Adjust reasoning effort based on route: coding/thinking -> high, others -> medium
        let reasoning_effort = match route_name_value.to_lowercase().as_str() {
            "coding" | "thinking" => "high",
            _ => "medium",
        };
        metadata_obj.insert(
            "reasoning_effort".to_string(),
            Value::String(reasoning_effort.to_string()),
        );
    }
    metadata_obj.insert("target".to_string(), target.clone());
    if let Some(provider_key) = target_obj.get("providerKey").cloned() {
        metadata_obj.insert("pipelineId".to_string(), provider_key.clone());
        metadata_obj.insert("providerKey".to_string(), provider_key);
    }
    if let Some(provider_type) = target_obj.get("providerType").cloned() {
        metadata_obj.insert("providerType".to_string(), provider_type);
    }
    if let Some(target_raw) = target_obj.get("modelId").cloned() {
        metadata_obj.insert("modelId".to_string(), target_raw);
    }
    metadata_obj.insert(
        "processMode".to_string(),
        Value::String(
            read_trimmed_string(target_obj.get("processMode"))
                .unwrap_or_else(|| "chat".to_string()),
        ),
    );

    let force_web_search = matches!(target_obj.get("forceWebSearch"), Some(Value::Bool(true)));
    let force_vision = matches!(target_obj.get("forceVision"), Some(Value::Bool(true)));
    if force_web_search || force_vision {
        if let Some(rt_obj) = ensure_runtime_metadata(metadata_obj) {
            if force_web_search {
                rt_obj.insert("forceWebSearch".to_string(), Value::Bool(true));
            }
            if force_vision {
                rt_obj.insert("forceVision".to_string(), Value::Bool(true));
            }
        }
    }

    if let Some(tool_call_id_style) = target_obj
        .get("responsesConfig")
        .and_then(|v| v.as_object())
        .and_then(|row| row.get("toolCallIdStyle"))
        .and_then(|v| v.as_str())
    {
        if !tool_call_id_style.is_empty() {
            metadata_obj.insert(
                "toolCallIdStyle".to_string(),
                Value::String(tool_call_id_style.to_string()),
            );
        }
    }

    if is_truthy(target_obj.get("streaming")) {
        if let Some(streaming) = target_obj.get("streaming").cloned() {
            metadata_obj.insert("targetStreaming".to_string(), streaming);
        }
    }

    if let Some(trimmed_original_model) = original_model {
        if !has_non_empty_string(metadata_obj, "originalModelId") {
            metadata_obj.insert(
                "originalModelId".to_string(),
                Value::String(trimmed_original_model.to_string()),
            );
        }
        if !has_non_empty_string(metadata_obj, "clientModelId") {
            metadata_obj.insert(
                "clientModelId".to_string(),
                Value::String(trimmed_original_model.to_string()),
            );
        }
    }

    if let Some(model_id) = target_obj.get("modelId").and_then(|v| v.as_str()) {
        let trimmed = model_id.trim();
        if !trimmed.is_empty() {
            metadata_obj.insert(
                "assignedModelId".to_string(),
                Value::String(trimmed.to_string()),
            );
        }
    }
}

fn apply_target_to_subject(subject: &mut Value, target: &Value, original_model: Option<&str>) {
    let Some(subject_obj) = subject.as_object_mut() else {
        return;
    };
    let new_model = match extract_target_model_id(target) {
        Some(v) => v,
        None => return,
    };
    let Some(target_obj) = target.as_object() else {
        return;
    };

    subject_obj.insert("model".to_string(), Value::String(new_model.clone()));

    let mut parameters_obj = subject_obj
        .get("parameters")
        .and_then(|v| v.as_object())
        .cloned()
        .unwrap_or_else(Map::new);
    parameters_obj.insert("model".to_string(), Value::String(new_model.clone()));
    subject_obj.insert("parameters".to_string(), Value::Object(parameters_obj));

    let mut metadata_obj = subject_obj
        .get("metadata")
        .and_then(|v| v.as_object())
        .cloned()
        .unwrap_or_else(|| {
            let mut map = Map::new();
            map.insert(
                "originalEndpoint".to_string(),
                Value::String("/v1/chat/completions".to_string()),
            );
            map
        });

    if let Some(provider_key) = target_obj.get("providerKey").cloned() {
        metadata_obj.insert("providerKey".to_string(), provider_key);
    }
    if let Some(provider_type) = target_obj.get("providerType").cloned() {
        metadata_obj.insert("providerType".to_string(), provider_type);
    }
    metadata_obj.insert(
        "processMode".to_string(),
        Value::String(
            read_trimmed_string(target_obj.get("processMode"))
                .unwrap_or_else(|| "chat".to_string()),
        ),
    );

    if let Some(tool_call_id_style) = target_obj
        .get("responsesConfig")
        .and_then(|v| v.as_object())
        .and_then(|row| row.get("toolCallIdStyle"))
        .and_then(|v| v.as_str())
    {
        if !tool_call_id_style.is_empty() {
            metadata_obj.insert(
                "toolCallIdStyle".to_string(),
                Value::String(tool_call_id_style.to_string()),
            );
        }
    }

    if let Some(trimmed_original_model) = original_model {
        if !has_non_empty_string(&metadata_obj, "originalModelId") {
            metadata_obj.insert(
                "originalModelId".to_string(),
                Value::String(trimmed_original_model.to_string()),
            );
        }
        if !has_non_empty_string(&metadata_obj, "clientModelId") {
            metadata_obj.insert(
                "clientModelId".to_string(),
                Value::String(trimmed_original_model.to_string()),
            );
        }
    }

    metadata_obj.insert("assignedModelId".to_string(), Value::String(new_model));
    subject_obj.insert("metadata".to_string(), Value::Object(metadata_obj));
}

#[napi]
pub fn extract_target_model_id_json(target_json: String) -> NapiResult<String> {
    let target: Value = serde_json::from_str(&target_json)
        .map_err(|e| napi::Error::from_reason(format!("Failed to parse target JSON: {}", e)))?;
    let output = extract_target_model_id(&target);
    serde_json::to_string(&output)
        .map_err(|e| napi::Error::from_reason(format!("Failed to serialize output JSON: {}", e)))
}

#[napi]
pub fn apply_target_metadata_json(
    metadata_json: String,
    target_json: String,
    route_name_json: String,
    original_model_json: String,
) -> NapiResult<String> {
    let mut metadata: Value = serde_json::from_str(&metadata_json)
        .map_err(|e| napi::Error::from_reason(format!("Failed to parse metadata JSON: {}", e)))?;
    let target: Value = serde_json::from_str(&target_json)
        .map_err(|e| napi::Error::from_reason(format!("Failed to parse target JSON: {}", e)))?;
    let route_name = parse_optional_trimmed_string_json(route_name_json.as_str());
    let original_model = parse_optional_trimmed_string_json(original_model_json.as_str());

    apply_target_metadata(
        &mut metadata,
        &target,
        route_name.as_deref(),
        original_model.as_deref(),
    );
    serde_json::to_string(&metadata)
        .map_err(|e| napi::Error::from_reason(format!("Failed to serialize output JSON: {}", e)))
}

#[napi]
pub fn apply_target_to_subject_json(
    subject_json: String,
    target_json: String,
    original_model_json: String,
) -> NapiResult<String> {
    let mut subject: Value = serde_json::from_str(&subject_json)
        .map_err(|e| napi::Error::from_reason(format!("Failed to parse subject JSON: {}", e)))?;
    let target: Value = serde_json::from_str(&target_json)
        .map_err(|e| napi::Error::from_reason(format!("Failed to parse target JSON: {}", e)))?;
    let original_model = parse_optional_trimmed_string_json(original_model_json.as_str());

    apply_target_to_subject(&mut subject, &target, original_model.as_deref());
    serde_json::to_string(&subject)
        .map_err(|e| napi::Error::from_reason(format!("Failed to serialize output JSON: {}", e)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn prefer_model_id_when_present() {
        let input = json!({
          "providerKey": "iflow.2-173.kimi-k2.5",
          "modelId": "kimi-k2.5"
        });
        assert_eq!(
            extract_target_model_id(&input).as_deref(),
            Some("kimi-k2.5")
        );
    }

    #[test]
    fn derive_from_runtime_key_prefix() {
        let input = json!({
          "providerKey": "iflow.2-173.kimi-k2.5",
          "runtimeKey": "iflow"
        });
        assert_eq!(
            extract_target_model_id(&input).as_deref(),
            Some("2-173.kimi-k2.5")
        );
    }

    #[test]
    fn derive_from_provider_key_fallback() {
        let input = json!({
          "providerKey": "tabglm.key1.glm-5"
        });
        assert_eq!(
            extract_target_model_id(&input).as_deref(),
            Some("key1.glm-5")
        );
    }

    #[test]
    fn apply_target_metadata_sets_force_flags_and_assigned_model() {
        let mut metadata = json!({});
        let target = json!({
          "providerKey": "iflow.2-173.kimi-k2.5",
          "providerType": "iflow",
          "modelId": "kimi-k2.5",
          "processMode": "chat",
          "forceWebSearch": true
        });
        apply_target_metadata(&mut metadata, &target, Some("thinking"), Some("gpt-5"));
        let obj = metadata.as_object().expect("metadata object");
        assert_eq!(
            obj.get("routeName").and_then(|v| v.as_str()),
            Some("thinking")
        );
        assert_eq!(
            obj.get("assignedModelId").and_then(|v| v.as_str()),
            Some("kimi-k2.5")
        );
        let rt = obj
            .get("__rt")
            .and_then(|v| v.as_object())
            .expect("runtime metadata");
        assert_eq!(
            rt.get("forceWebSearch").and_then(|v| v.as_bool()),
            Some(true)
        );
    }

    #[test]
    fn apply_target_to_subject_updates_model_and_metadata() {
        let mut subject = json!({
          "model": "old-model",
          "parameters": {},
          "metadata": {}
        });
        let target = json!({
          "providerKey": "tabglm.key1.glm-5",
          "providerType": "tabglm",
          "processMode": "passthrough"
        });
        apply_target_to_subject(&mut subject, &target, Some("old-model"));
        let obj = subject.as_object().expect("subject object");
        assert_eq!(
            obj.get("model").and_then(|v| v.as_str()),
            Some("key1.glm-5")
        );
        let metadata = obj
            .get("metadata")
            .and_then(|v| v.as_object())
            .expect("metadata");
        assert_eq!(
            metadata.get("providerType").and_then(|v| v.as_str()),
            Some("tabglm")
        );
        assert_eq!(
            metadata.get("assignedModelId").and_then(|v| v.as_str()),
            Some("key1.glm-5")
        );
    }
}
