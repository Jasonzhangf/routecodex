use super::request_outbound_format::{
    project_outbound_payload_for_selected_target_protocol_with_drops,
    project_standard_request_transport_intent, V3OutboundTargetProtocol,
};
use super::{
    build_v3_anthropic_provider_request_source_from_chat_canonical_with_drops,
    build_v3_openai_chat_standard_request_for_selected_web_search_mode_recording,
    build_v3_openai_responses_standard_request_for_selected_target_with_drops_and_options,
    classify_v3_provider_compat_error, encode_v3_responses_semantic_as_anthropic_request,
    provider_protocol_compat_id, V3HubEntryProtocol, V3HubProviderWireProtocol,
    V3HubReqTarget06Resolved, V3HubTransportIntent, V3ProviderCompatError,
    V3ProviderCompatProfileId,
};
use crate::projection_drop_log::{V3ProjectionDropContext, V3ProjectionDropRecord};
use crate::selected_provider_model_binding::{
    bind_v3_selected_provider_model, V3SelectedProviderModelBinding,
};
use provider_compat_core::namespace_tools::NamespaceToolIdentityRegistry;
use provider_compat_core::CUSTOM_TOOL_FUNCTION_PROFILE;
use serde_json::Value;
use std::sync::Arc;

#[derive(Debug, Clone, PartialEq)]
pub struct V3HubReqOutbound07ProviderSemantic {
    pub(crate) previous: V3HubReqTarget06Resolved,
    pub(crate) provider_protocol: V3HubProviderWireProtocol,
    pub(crate) standard_provider_payload: super::V3HubOpaquePayload,
    pub(crate) drops: Vec<V3ProjectionDropRecord>,
    pub(crate) namespace_registry: NamespaceToolIdentityRegistry,
}

pub fn build_v3_hub_req_outbound_07_from_v3_hub_req_target_06(
    input: V3HubReqTarget06Resolved,
    provider_protocol: V3HubProviderWireProtocol,
) -> Result<V3HubReqOutbound07ProviderSemantic, V3ProviderCompatError> {
    let profile = V3ProviderCompatProfileId::from_config(
        input.selected_target.compatibility_profile.as_deref(),
    );
    let projected =
        crate::operation_runner::execute_v3_operation_runner_request_project_standard_provider_request(
            input.previous.governed_payload().clone(),
            input
                .previous
                .previous
                .previous
                .previous
                .entry_protocol,
            input
                .previous
                .previous
                .previous
                .previous
                .transport_intent,
            provider_protocol,
            input.selected_target.clone(),
        )
        .map_err(|error| {
            classify_v3_provider_compat_error("request_protocol", &profile, error.message)
        })?;
    Ok(V3HubReqOutbound07ProviderSemantic {
        previous: input,
        provider_protocol,
        standard_provider_payload: super::V3HubOpaquePayload(Arc::new(projected.payload)),
        drops: projected.drops,
        namespace_registry: projected.namespace_registry,
    })
}

impl V3HubReqOutbound07ProviderSemantic {
    pub(crate) fn selected_target(&self) -> &routecodex_v3_target::V3TargetCandidate {
        &self.previous.selected_target
    }

    pub(crate) fn entry_protocol(&self) -> V3HubEntryProtocol {
        self.previous
            .previous
            .previous
            .previous
            .previous
            .entry_protocol
    }

    pub(crate) fn provider_semantic_payload(&self) -> &Value {
        &self.standard_provider_payload.0
    }

    pub(crate) fn governed_payload(&self) -> &Value {
        self.previous.previous.governed_payload()
    }

    pub(crate) fn transport_intent(&self) -> V3HubTransportIntent {
        self.previous
            .previous
            .previous
            .previous
            .previous
            .transport_intent
    }
}

pub(crate) struct V3HubReqOutbound07StandardProjection {
    pub(crate) payload: Value,
    pub(crate) drops: Vec<V3ProjectionDropRecord>,
    pub(crate) namespace_registry: NamespaceToolIdentityRegistry,
}

pub(crate) fn project_v3_operation_runner_standard_provider_request(
    governed_payload: &Value,
    entry_protocol: V3HubEntryProtocol,
    transport_intent: V3HubTransportIntent,
    provider_protocol: V3HubProviderWireProtocol,
    selected: &routecodex_v3_target::V3TargetCandidate,
) -> Result<V3HubReqOutbound07StandardProjection, String> {
    let mut drops = Vec::new();
    let namespace_registry = NamespaceToolIdentityRegistry::from_request(
        governed_payload,
        &provider_protocol_compat_id(provider_protocol),
    )?;
    let mut provider_protocol_payload = match provider_protocol {
        V3HubProviderWireProtocol::OpenAiChat => {
            let (payload, openai_chat_drops) =
                build_v3_openai_chat_standard_request_for_selected_web_search_mode_recording(
                    governed_payload,
                    selected.web_search_execution_mode,
                    selected
                        .model_capabilities
                        .iter()
                        .any(|capability| capability == "web_search"),
                    &V3ProjectionDropContext::disabled(),
                )?;
            drops.extend(openai_chat_drops);
            payload
        }
        V3HubProviderWireProtocol::Responses => {
            // The custom-tool-function compat profile owns the custom→function
            // adjustment, so the standard Responses projection keeps client
            // custom declarations on the wire for that later node.
            let preserve_responses_custom_tools = selected
                .compatibility_profile
                .as_deref()
                .is_some_and(|profile| profile.eq_ignore_ascii_case(CUSTOM_TOOL_FUNCTION_PROFILE));
            let (payload, responses_drops) =
                build_v3_openai_responses_standard_request_for_selected_target_with_drops_and_options(
                    governed_payload,
                    selected
                        .model_capabilities
                        .iter()
                        .any(|capability| capability == "web_search"),
                    preserve_responses_custom_tools,
                )?;
            drops.extend(responses_drops);
            payload
        }
        V3HubProviderWireProtocol::Anthropic => {
            let (source, anthropic_drops) =
                build_v3_anthropic_provider_request_source_from_chat_canonical_with_drops(
                    governed_payload,
                    entry_protocol,
                )?;
            drops.extend(anthropic_drops);
            encode_v3_responses_semantic_as_anthropic_request(source)
                .map_err(|error| error.to_string())?
        }
        V3HubProviderWireProtocol::Gemini => {
            let (payload, gemini_drops) =
                project_outbound_payload_for_selected_target_protocol_with_drops(
                    governed_payload,
                    V3OutboundTargetProtocol::Gemini,
                    &selected.model_capabilities,
                )?;
            drops.extend(gemini_drops);
            payload
        }
    };
    project_standard_request_transport_intent(
        &mut provider_protocol_payload,
        entry_protocol,
        provider_protocol,
        transport_intent,
    );
    if provider_protocol == V3HubProviderWireProtocol::Responses {
        namespace_registry.project_request(&mut provider_protocol_payload, "openai-responses")?;
    }
    if entry_protocol == V3HubEntryProtocol::Responses {
        namespace_registry.project_responses_history_references(&mut provider_protocol_payload);
    }
    let payload = bind_v3_selected_provider_model(provider_protocol_payload, selected)
        .map(V3SelectedProviderModelBinding::into_payload)?;
    Ok(V3HubReqOutbound07StandardProjection {
        payload,
        drops,
        namespace_registry,
    })
}
