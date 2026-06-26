#[cfg(test)]
use crate::hub_pipeline_blocks::adapter_context::resolve_adapter_context_client_connection_state;
use crate::hub_pipeline_blocks::metadata::resolve_stop_message_router_metadata;
use crate::hub_pipeline_blocks::process_mode::resolve_active_process_mode;
use crate::hub_pipeline_blocks::protocol::{normalize_endpoint, resolve_provider_protocol};
use crate::hub_req_inbound_tool_call_normalization::normalize_shell_like_tool_calls_before_governance;
use chrono;
use serde::{Deserialize, Serialize};
use serde_json::Value;

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
    pub metadata_center_snapshot: Value,
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

pub fn run_hub_pipeline(input: HubPipelineInput) -> Result<HubPipelineOutput, String> {
    let request_id = input.request_id.clone();
    let endpoint = normalize_endpoint(&input.endpoint);
    let entry_endpoint = normalize_endpoint(&input.entry_endpoint);
    if input.provider_protocol.trim().is_empty() {
        return Err("providerProtocol is required".to_string());
    }
    let provider_protocol = resolve_provider_protocol(&input.provider_protocol)
        .map_err(|e| format!("Protocol resolution failed: {}", e))?;
    if !input.payload.is_object() && !input.payload.is_array() {
        return Err("Payload must be a JSON object or array".to_string());
    }
    let mut payload = input.payload.clone();

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
    output_metadata.insert("direction".to_string(), Value::String(direction.clone()));

    let stage = if input.stage.eq_ignore_ascii_case("outbound") {
        "outbound".to_string()
    } else {
        "inbound".to_string()
    };
    output_metadata.insert("stage".to_string(), Value::String(stage));

    if direction == "request" {
        normalize_shell_like_tool_calls_before_governance(&mut payload)
            .map_err(|error| error.to_string())?;
    }

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

#[cfg(test)]
#[path = "hub_pipeline_tests.rs"]
mod hub_pipeline_tests;

#[cfg(test)]
use crate::hub_pipeline_blocks::napi_bindings::run_hub_pipeline_json;
