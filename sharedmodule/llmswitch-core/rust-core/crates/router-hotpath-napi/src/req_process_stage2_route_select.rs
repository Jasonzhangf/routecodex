use napi_derive::napi;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RouteSelectionApplyInput {
    pub request: Value,
    pub normalized_metadata: Value,
    pub target: Value,
    #[serde(default)]
    pub route_name: Option<String>,
    #[serde(default)]
    pub original_model: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RouteSelectionApplyOutput {
    pub request: Value,
    pub normalized_metadata: Value,
}

fn read_trimmed_string(map: &Map<String, Value>, key: &str) -> Option<String> {
    map.get(key)
        .and_then(|v| v.as_str())
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
}

fn read_tool_call_id_style(target_map: &Map<String, Value>) -> Option<String> {
    target_map
        .get("responsesConfig")
        .and_then(|v| v.as_object())
        .and_then(|row| row.get("toolCallIdStyle"))
        .and_then(|v| v.as_str())
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
}

fn read_target_model(target_map: &Map<String, Value>) -> Option<String> {
    if let Some(model_id) = read_trimmed_string(target_map, "modelId") {
        return Some(model_id);
    }

    let provider_key = read_trimmed_string(target_map, "providerKey")?;

    if let Some(runtime_key) = read_trimmed_string(target_map, "runtimeKey") {
        let prefix = format!("{}.", runtime_key);
        if provider_key.starts_with(&prefix) {
            let candidate = provider_key[prefix.len()..].trim().to_string();
            if !candidate.is_empty() {
                return Some(candidate);
            }
        }
    }

    if let Some(dot_idx) = provider_key.find('.') {
        if dot_idx > 0 && dot_idx < provider_key.len() - 1 {
            let fallback = provider_key[dot_idx + 1..].trim().to_string();
            if !fallback.is_empty() {
                return Some(fallback);
            }
        }
    }

    None
}

fn ensure_runtime_metadata(meta: &mut Map<String, Value>) -> &mut Map<String, Value> {
    let need_reset = !meta.get("__rt").and_then(|v| v.as_object()).is_some();
    if need_reset {
        meta.insert("__rt".to_string(), Value::Object(Map::new()));
    }
    meta.get_mut("__rt")
        .and_then(|v| v.as_object_mut())
        .expect("runtime metadata object must exist")
}

fn write_if_missing_non_empty(meta: &mut Map<String, Value>, key: &str, value: Option<String>) {
    let normalized = value
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty());
    if normalized.is_none() {
        return;
    }
    let already_set = meta
        .get(key)
        .and_then(|v| v.as_str())
        .map(|v| !v.trim().is_empty())
        .unwrap_or(false);
    if !already_set {
        meta.insert(key.to_string(), Value::String(normalized.unwrap()));
    }
}

fn apply_target_metadata(
    normalized_metadata: &mut Map<String, Value>,
    target_map: &Map<String, Value>,
    route_name: Option<String>,
    original_model: Option<String>,
) {
    if let Some(route) = route_name.filter(|v| !v.trim().is_empty()) {
        let route_trimmed = route.trim().to_string();
        normalized_metadata.insert(
            "routeName".to_string(),
            Value::String(route_trimmed.clone()),
        );

        if let Some(existing_effort) = normalized_metadata
            .get("reasoning_effort")
            .and_then(|v| v.as_str())
        {
            let trimmed = existing_effort.trim();
            if !trimmed.is_empty() {
                normalized_metadata.insert(
                    "originalReasoningEffort".to_string(),
                    Value::String(trimmed.to_string()),
                );
            }
        }

        let reasoning_effort = match route_trimmed.to_lowercase().as_str() {
            "coding" | "thinking" => "high",
            _ => "medium",
        };
        normalized_metadata.insert(
            "reasoning_effort".to_string(),
            Value::String(reasoning_effort.to_string()),
        );
    }

    if let Some(provider_key) = read_trimmed_string(target_map, "providerKey") {
        normalized_metadata.insert(
            "pipelineId".to_string(),
            Value::String(provider_key.clone()),
        );
        normalized_metadata.insert("providerKey".to_string(), Value::String(provider_key));
    }

    if let Some(provider_type) = read_trimmed_string(target_map, "providerType") {
        normalized_metadata.insert("providerType".to_string(), Value::String(provider_type));
    }

    normalized_metadata.insert(
        "processMode".to_string(),
        Value::String(
            read_trimmed_string(target_map, "processMode").unwrap_or_else(|| "chat".to_string()),
        ),
    );

    if let Some(model_id) = read_trimmed_string(target_map, "modelId") {
        normalized_metadata.insert("modelId".to_string(), Value::String(model_id.clone()));
        normalized_metadata.insert("assignedModelId".to_string(), Value::String(model_id));
    }

    normalized_metadata.insert("target".to_string(), Value::Object(target_map.clone()));

    if let Some(style) = read_tool_call_id_style(target_map) {
        normalized_metadata.insert("toolCallIdStyle".to_string(), Value::String(style));
    }

    if let Some(streaming) = read_trimmed_string(target_map, "streaming") {
        normalized_metadata.insert("targetStreaming".to_string(), Value::String(streaming));
    }

    let force_web_search = target_map
        .get("forceWebSearch")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let force_vision = target_map
        .get("forceVision")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

    if force_web_search || force_vision {
        let rt = ensure_runtime_metadata(normalized_metadata);
        if force_web_search {
            rt.insert("forceWebSearch".to_string(), Value::Bool(true));
        }
        if force_vision {
            rt.insert("forceVision".to_string(), Value::Bool(true));
        }
    }

    let original_model_trimmed = original_model
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty());
    write_if_missing_non_empty(
        normalized_metadata,
        "originalModelId",
        original_model_trimmed.clone(),
    );
    write_if_missing_non_empty(normalized_metadata, "clientModelId", original_model_trimmed);
}

fn apply_target_to_subject(
    request: &mut Map<String, Value>,
    target_map: &Map<String, Value>,
    original_model: Option<String>,
) {
    let assigned_model = match read_target_model(target_map) {
        Some(v) => v,
        None => return,
    };

    request.insert("model".to_string(), Value::String(assigned_model.clone()));

    let parameters = request
        .entry("parameters".to_string())
        .or_insert_with(|| Value::Object(Map::new()));
    if !parameters.is_object() {
        *parameters = Value::Object(Map::new());
    }
    if let Some(params_map) = parameters.as_object_mut() {
        params_map.insert("model".to_string(), Value::String(assigned_model.clone()));
    }

    let metadata_was_object = request
        .get("metadata")
        .and_then(|v| v.as_object())
        .is_some();
    let metadata = request
        .entry("metadata".to_string())
        .or_insert_with(|| Value::Object(Map::new()));
    if !metadata.is_object() {
        *metadata = Value::Object(Map::new());
    }
    let metadata_map = metadata
        .as_object_mut()
        .expect("request metadata must be object");

    if !metadata_was_object {
        metadata_map.insert(
            "originalEndpoint".to_string(),
            Value::String("/v1/chat/completions".to_string()),
        );
    }

    if let Some(provider_key) = read_trimmed_string(target_map, "providerKey") {
        metadata_map.insert("providerKey".to_string(), Value::String(provider_key));
    }
    if let Some(provider_type) = read_trimmed_string(target_map, "providerType") {
        metadata_map.insert("providerType".to_string(), Value::String(provider_type));
    }

    metadata_map.insert(
        "processMode".to_string(),
        Value::String(
            read_trimmed_string(target_map, "processMode").unwrap_or_else(|| "chat".to_string()),
        ),
    );

    if let Some(style) = read_tool_call_id_style(target_map) {
        metadata_map.insert("toolCallIdStyle".to_string(), Value::String(style));
    }

    let original_model_trimmed = original_model
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty());
    write_if_missing_non_empty(
        metadata_map,
        "originalModelId",
        original_model_trimmed.clone(),
    );
    write_if_missing_non_empty(metadata_map, "clientModelId", original_model_trimmed);

    metadata_map.insert("assignedModelId".to_string(), Value::String(assigned_model));
}

pub fn apply_route_selection(
    input: RouteSelectionApplyInput,
) -> Result<RouteSelectionApplyOutput, String> {
    let mut request = input.request;
    let mut normalized_metadata = input.normalized_metadata;

    let request_map = request
        .as_object_mut()
        .ok_or("request must be a JSON object")?;
    let metadata_map = normalized_metadata
        .as_object_mut()
        .ok_or("normalizedMetadata must be a JSON object")?;
    let target_map = input
        .target
        .as_object()
        .ok_or("target must be a JSON object")?;

    apply_target_metadata(
        metadata_map,
        target_map,
        input.route_name,
        input.original_model.clone(),
    );
    apply_target_to_subject(request_map, target_map, input.original_model);
    crate::virtual_router_engine::instructions::clean_routing_instruction_markers(&mut request);

    Ok(RouteSelectionApplyOutput {
        request,
        normalized_metadata,
    })
}

#[napi]
pub fn apply_req_process_route_selection_json(input_json: String) -> napi::Result<String> {
    if input_json.trim().is_empty() {
        return Err(napi::Error::from_reason("Input JSON is empty"));
    }

    let input: RouteSelectionApplyInput = serde_json::from_str(&input_json)
        .map_err(|e| napi::Error::from_reason(format!("Failed to parse input JSON: {}", e)))?;

    let output = apply_route_selection(input).map_err(|e| napi::Error::from_reason(e))?;

    serde_json::to_string(&output)
        .map_err(|e| napi::Error::from_reason(format!("Failed to serialize output: {}", e)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_apply_route_selection_updates_request_and_metadata() {
        let input = RouteSelectionApplyInput {
            request: serde_json::json!({
              "model": "gpt-4.1",
              "messages": [],
              "parameters": {},
              "metadata": {
                "originalEndpoint": "/v1/responses"
              }
            }),
            normalized_metadata: serde_json::json!({}),
            target: serde_json::json!({
              "providerKey": "tab.key1.gpt-5.2",
              "providerType": "tab",
              "modelId": "gpt-5.2",
              "processMode": "chat",
              "responsesConfig": {
                "toolCallIdStyle": "fc"
              }
            }),
            route_name: Some("thinking".to_string()),
            original_model: Some("gpt-4.1".to_string()),
        };

        let result = apply_route_selection(input).unwrap();
        assert_eq!(result.request["model"], "gpt-5.2");
        assert_eq!(result.request["parameters"]["model"], "gpt-5.2");
        assert_eq!(
            result.request["metadata"]["providerKey"],
            "tab.key1.gpt-5.2"
        );
        assert_eq!(result.request["metadata"]["assignedModelId"], "gpt-5.2");

        assert_eq!(result.normalized_metadata["routeName"], "thinking");
        assert_eq!(
            result.normalized_metadata["providerKey"],
            "tab.key1.gpt-5.2"
        );
        assert_eq!(result.normalized_metadata["assignedModelId"], "gpt-5.2");
        assert_eq!(result.normalized_metadata["toolCallIdStyle"], "fc");
        assert_eq!(result.normalized_metadata["reasoning_effort"], "high");
    }

    #[test]
    fn test_apply_route_selection_fallback_model_from_provider_key() {
        let input = RouteSelectionApplyInput {
            request: serde_json::json!({
              "model": "unknown",
              "messages": [],
              "parameters": {},
              "metadata": {}
            }),
            normalized_metadata: serde_json::json!({}),
            target: serde_json::json!({
              "providerKey": "iflow.kimi-k2.5",
              "providerType": "iflow"
            }),
            route_name: None,
            original_model: None,
        };

        let result = apply_route_selection(input).unwrap();
        assert_eq!(result.request["model"], "kimi-k2.5");
        assert_eq!(result.request["metadata"]["assignedModelId"], "kimi-k2.5");
    }

    #[test]
    fn test_error_empty_json_input() {
        let result = apply_req_process_route_selection_json("".to_string());
        assert!(result.is_err());
        assert!(result
            .unwrap_err()
            .to_string()
            .contains("Input JSON is empty"));
    }
}
