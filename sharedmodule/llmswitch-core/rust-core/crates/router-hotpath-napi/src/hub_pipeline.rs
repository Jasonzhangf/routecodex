#[cfg(test)]
use crate::hub_pipeline_blocks::adapter_context::resolve_adapter_context_client_connection_state;
use crate::hub_pipeline_blocks::metadata::resolve_stop_message_router_metadata;
use crate::hub_pipeline_blocks::process_mode::resolve_active_process_mode;
use crate::hub_pipeline_blocks::protocol::{normalize_endpoint, resolve_provider_protocol};
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

pub use crate::hub_pipeline_blocks::napi_bindings::{
    annotate_passthrough_governance_skip_json, apply_direct_builtin_web_search_tool_json,
    apply_has_image_attachment_flag_json, apply_outbound_stream_preference_json,
    attach_passthrough_provider_input_audit_json, build_captured_chat_request_snapshot_json,
    build_hub_pipeline_result_metadata_json, build_passthrough_audit_json,
    build_passthrough_governance_skipped_node_json, build_req_inbound_node_result_json,
    build_req_inbound_skipped_node_json, build_req_outbound_node_result_json,
    build_router_metadata_input_json, build_tool_governance_node_result_json,
    coerce_standardized_request_from_payload_json, extract_adapter_context_metadata_fields_json,
    extract_model_hint_from_metadata_json, find_mappable_semantics_keys_json,
    is_canonical_web_search_tool_definition_json, is_search_route_id_json,
    lift_responses_resume_into_semantics_json, merge_clock_reservation_into_metadata_json,
    normalize_hub_endpoint_json, prepare_runtime_metadata_for_servertools_json,
    read_responses_resume_from_metadata_json, read_responses_resume_from_request_semantics_json,
    resolve_active_process_mode_json, resolve_adapter_context_metadata_signals_json,
    resolve_adapter_context_object_carriers_json,
    resolve_has_instruction_requested_passthrough_json, resolve_hub_client_protocol_json,
    resolve_hub_policy_override_json, resolve_hub_shadow_compare_config_json,
    resolve_outbound_stream_intent_json, resolve_provider_protocol_json,
    resolve_router_metadata_runtime_flags_json, resolve_sse_protocol_from_metadata_json,
    resolve_sse_protocol_json, resolve_stop_message_router_metadata_json, run_hub_pipeline_json,
    run_req_inbound_pipeline_json, run_req_process_pipeline_json, run_resp_outbound_pipeline_json,
    sync_responses_context_from_canonical_messages_json, sync_session_identifiers_to_metadata_json,
};

#[cfg(test)]
#[path = "hub_pipeline_tests.rs"]
mod hub_pipeline_tests;
