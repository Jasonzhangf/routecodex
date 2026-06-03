use serde_json::Value;

use crate::hub_pipeline::{
    run_hub_pipeline, run_req_inbound_pipeline, run_req_process_pipeline,
    run_resp_outbound_pipeline, ChatEnvelope, HubPipelineInput, RoutingDecision,
};
use crate::hub_pipeline_blocks::adapter_context::{
    extract_adapter_context_metadata_fields, resolve_adapter_context_metadata_signals,
    resolve_adapter_context_object_carriers,
};
use crate::hub_pipeline_blocks::metadata::{
    build_hub_pipeline_result_metadata, resolve_router_metadata_runtime_flags,
    resolve_stop_message_router_metadata,
};
use crate::hub_pipeline_blocks::nodes::{
    build_captured_chat_request_snapshot, build_passthrough_governance_skipped_node,
    build_req_inbound_node_result, build_req_inbound_skipped_node, build_req_outbound_node_result,
    build_tool_governance_node_result,
};
use crate::hub_pipeline_blocks::passthrough::{
    annotate_passthrough_governance_skip, attach_passthrough_provider_input_audit,
    build_passthrough_audit,
};
use crate::hub_pipeline_blocks::policy::{
    resolve_hub_policy_override, resolve_hub_shadow_compare_config,
};
use crate::hub_pipeline_blocks::process_mode::{
    find_mappable_semantics_keys, resolve_active_process_mode,
    resolve_has_instruction_requested_passthrough,
};
use crate::hub_pipeline_blocks::protocol::{
    apply_outbound_stream_preference, extract_model_hint_from_metadata, normalize_endpoint,
    resolve_hub_client_protocol, resolve_outbound_stream_intent, resolve_provider_protocol,
    resolve_sse_protocol, resolve_sse_protocol_from_metadata,
};
use crate::hub_pipeline_blocks::responses_context::sync_responses_context_from_canonical_messages;
use crate::hub_pipeline_blocks::responses_resume::{
    lift_responses_resume_into_semantics, read_responses_resume_from_metadata,
    read_responses_resume_from_request_semantics,
};
use crate::hub_pipeline_blocks::router_metadata_input::build_router_metadata_input;
use crate::hub_pipeline_blocks::runtime_metadata::{
    apply_has_image_attachment_flag, prepare_runtime_metadata_for_servertools,
    sync_session_identifiers_to_metadata,
};
use crate::hub_pipeline_blocks::standardized_request::coerce_standardized_request_from_payload;
use crate::hub_pipeline_blocks::web_search::{
    apply_direct_builtin_web_search_tool, is_canonical_web_search_tool_definition,
    is_search_route_id,
};
use crate::hub_pipeline_contracts::{
    describe_hub_pipeline_contracts, describe_meta_carrier_contracts, describe_pipeline_contract,
    describe_virtual_router_contracts, validate_pipeline_node_contract_boundary,
};

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
pub fn describe_hub_pipeline_contracts_json() -> napi::Result<String> {
    serde_json::to_string(&describe_hub_pipeline_contracts()).map_err(|e| {
        napi::Error::from_reason(format!("Failed to serialize hub pipeline contracts: {}", e))
    })
}

#[napi_derive::napi]
pub fn describe_virtual_router_contracts_json() -> napi::Result<String> {
    serde_json::to_string(&describe_virtual_router_contracts()).map_err(|e| {
        napi::Error::from_reason(format!(
            "Failed to serialize virtual router contracts: {}",
            e
        ))
    })
}

#[napi_derive::napi]
pub fn describe_meta_carrier_contracts_json() -> napi::Result<String> {
    serde_json::to_string(&describe_meta_carrier_contracts()).map_err(|e| {
        napi::Error::from_reason(format!("Failed to serialize meta carrier contracts: {}", e))
    })
}

#[napi_derive::napi]
pub fn describe_pipeline_contract_json(node_id: String) -> napi::Result<String> {
    let output = describe_pipeline_contract(&node_id).ok_or_else(|| {
        napi::Error::from_reason(format!("unknown pipeline node contract: {node_id}"))
    })?;
    serde_json::to_string(&output).map_err(|e| {
        napi::Error::from_reason(format!("Failed to serialize pipeline contract: {}", e))
    })
}

#[napi_derive::napi]
pub fn validate_pipeline_node_contract_boundary_json(
    node_id: String,
    before_json: String,
    after_json: String,
) -> napi::Result<String> {
    let before: Value = serde_json::from_str(&before_json).map_err(|e| {
        napi::Error::from_reason(format!("Failed to parse boundary before JSON: {}", e))
    })?;
    let after: Value = serde_json::from_str(&after_json).map_err(|e| {
        napi::Error::from_reason(format!("Failed to parse boundary after JSON: {}", e))
    })?;
    let output = validate_pipeline_node_contract_boundary(&node_id, &before, &after)
        .map_err(napi::Error::from_reason)?;
    serde_json::to_string(&output).map_err(|e| {
        napi::Error::from_reason(format!("Failed to serialize boundary validation: {}", e))
    })
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
    let output = sync_responses_context_from_canonical_messages(&request)
        .map_err(napi::Error::from_reason)?;
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
