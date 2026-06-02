use serde_json::Value;

use crate::hub_pipeline_lib::errors::{HubPipelineError, HubPipelineResult};
use crate::hub_resp_outbound_client_semantics::{
    apply_client_passthrough_patch, build_anthropic_response_from_chat_value,
    build_responses_payload_from_chat_core, normalize_openai_chat_reasoning_outbound,
};

pub(crate) fn build_hub_resp_outbound_04_client_payload_for_protocol(
    finalized_payload: Value,
    metadata: &Value,
    request_id: &str,
) -> HubPipelineResult<Value> {
    let client_protocol = metadata
        .get("clientProtocol")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            HubPipelineError::new(
                "hub_pipeline_missing_client_protocol",
                "Rust HubPipeline resp client remap requires metadata.clientProtocol",
            )
        })?;
    let client_payload = match client_protocol {
        "openai-chat" => {
            normalize_openai_chat_reasoning_outbound(&finalized_payload).ok_or_else(|| {
                HubPipelineError::new(
                    "hub_pipeline_resp_client_remap_failed",
                    "Rust HubPipeline openai-chat client remap returned no payload",
                )
            })?
        }
        "anthropic-messages" => {
            let alias_map = metadata
                .get("requestSemantics")
                .and_then(|semantics| semantics.get("aliasMap"));
            build_anthropic_response_from_chat_value(&finalized_payload, alias_map)
        }
        "openai-responses" => {
            let context = serde_json::json!({
                "requestId": request_id,
                "metadata": metadata,
                "model": metadata
                    .get("displayModel")
                    .or_else(|| metadata.get("clientModelId"))
                    .or_else(|| metadata.get("originalModelId")),
            });
            build_responses_payload_from_chat_core(&finalized_payload, Some(request_id), &context)
                .map_err(|message| {
                    HubPipelineError::new("hub_pipeline_resp_client_remap_failed", message)
                })?
        }
        _ => {
            return Err(HubPipelineError::new(
                "hub_pipeline_unsupported_client_protocol",
                format!(
                    "Rust HubPipeline resp client remap unsupported client protocol: {}",
                    client_protocol
                ),
            ));
        }
    };
    Ok(apply_client_passthrough_patch(
        &client_payload,
        &finalized_payload,
    ))
}
