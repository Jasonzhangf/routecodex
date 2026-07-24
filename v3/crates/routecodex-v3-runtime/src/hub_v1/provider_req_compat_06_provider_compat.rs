use super::{
    build_v3_openai_chat_standard_request_from_chat_canonical,
    build_v3_openai_responses_standard_request_from_chat_canonical,
    build_v3_responses_original_input_surface_from_chat_canonical, provider_protocol_compat_id,
    V3HubExecutionMode, V3HubOpaquePayload, V3HubProviderWireProtocol,
    V3HubReqOutbound07ProviderSemantic, V3ProviderCompatError, V3ProviderCompatProfileId,
};
use provider_compat_core::req_outbound_stage3_compat::{
    run_req_outbound_stage3_compat, AdapterContext, ReqOutboundCompatInput,
};
use serde_json::Value;

#[derive(Debug, Clone, PartialEq)]
pub struct ProviderReqCompat06ProviderCompat {
    pub(crate) previous: V3HubReqOutbound07ProviderSemantic,
    pub(crate) profile: V3ProviderCompatProfileId,
    pub(crate) payload: V3HubOpaquePayload,
}

pub fn build_provider_req_compat_06_from_v3_hub_req_outbound_07(
    input: V3HubReqOutbound07ProviderSemantic,
) -> Result<ProviderReqCompat06ProviderCompat, V3ProviderCompatError> {
    let profile = match input.selected_target().compatibility_profile.as_deref() {
        Some(profile) => V3ProviderCompatProfileId::from_config(Some(profile)),
        None => V3ProviderCompatProfileId::Passthrough,
    };
    let payload = apply_v3_provider_req_compat(&input, &profile)?;
    Ok(ProviderReqCompat06ProviderCompat {
        previous: input,
        profile,
        payload: V3HubOpaquePayload(payload),
    })
}

impl ProviderReqCompat06ProviderCompat {
    pub fn profile(&self) -> &V3ProviderCompatProfileId {
        &self.profile
    }

    pub(crate) fn provider_semantic_payload(&self) -> &Value {
        &self.payload.0
    }
}

fn apply_v3_provider_req_compat(
    input: &V3HubReqOutbound07ProviderSemantic,
    profile: &V3ProviderCompatProfileId,
) -> Result<Value, V3ProviderCompatError> {
    let selected = input.selected_target();
    let provider_key = format!(
        "{}:{}:{}",
        selected.provider_id, selected.auth_alias, selected.model_id
    );
    run_req_outbound_stage3_compat(ReqOutboundCompatInput {
        payload: build_v3_provider_standard_protocol_payload_from_req07(input).map_err(
            |reason| V3ProviderCompatError {
                stage: "request_protocol",
                profile: profile.as_str().to_string(),
                reason,
            },
        )?,
        adapter_context: AdapterContext {
            compatibility_profile: profile.as_optional_string(),
            provider_protocol: Some(provider_protocol_compat_id(input.provider_protocol)),
            model_id: Some(selected.model_id.clone()),
            original_model_id: Some(selected.wire_model.clone()),
            provider_id: Some(selected.provider_id.clone()),
            provider_key: Some(provider_key.clone()),
            runtime_key: Some(provider_key),
            ..Default::default()
        },
        explicit_profile: profile.as_optional_string(),
    })
    .map(|result| result.payload)
    .map_err(|reason| V3ProviderCompatError {
        stage: "request",
        profile: profile.as_str().to_string(),
        reason,
    })
}

fn build_v3_provider_standard_protocol_payload_from_req07(
    input: &V3HubReqOutbound07ProviderSemantic,
) -> Result<Value, String> {
    if input.execution_mode() == V3HubExecutionMode::Direct {
        return Ok(input.provider_semantic_payload().clone());
    }
    match input.provider_protocol {
        V3HubProviderWireProtocol::OpenAiChat => {
            build_v3_openai_chat_standard_request_from_chat_canonical(
                input.provider_semantic_payload(),
            )
        }
        V3HubProviderWireProtocol::Responses => {
            if let Some(original_surface) =
                build_v3_responses_original_input_surface_from_chat_canonical(
                    input.provider_semantic_payload(),
                    input.original_responses_payload(),
                )
            {
                return Ok(original_surface);
            }
            build_v3_openai_responses_standard_request_from_chat_canonical(
                input.provider_semantic_payload(),
            )
        }
        V3HubProviderWireProtocol::Anthropic => {
            if let Some(original_surface) =
                build_v3_responses_original_input_surface_from_chat_canonical(
                    input.provider_semantic_payload(),
                    input.original_responses_payload(),
                )
            {
                return Ok(original_surface);
            }
            Ok(input.provider_semantic_payload().clone())
        }
        V3HubProviderWireProtocol::Gemini => Ok(input.provider_semantic_payload().clone()),
    }
}
