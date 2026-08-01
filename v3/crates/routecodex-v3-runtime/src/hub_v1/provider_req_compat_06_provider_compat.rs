use super::request_outbound_format::{
    project_outbound_payload_for_target_protocol, V3OutboundTargetProtocol,
};
use super::{
    build_v3_anthropic_provider_request_source_from_chat_canonical,
    build_v3_openai_chat_standard_request_from_chat_canonical,
    build_v3_openai_responses_standard_request_from_chat_canonical,
    encode_v3_responses_semantic_as_anthropic_request, provider_protocol_compat_id,
    V3HubOpaquePayload, V3HubProviderWireProtocol, V3HubReqOutbound07ProviderSemantic,
    V3ProviderCompatError, V3ProviderCompatProfileId,
};
use provider_compat_core::req_outbound_stage3_compat::{
    run_req_outbound_stage3_compat, AdapterContext, ReqOutboundCompatInput,
};
use serde_json::Value;

use crate::selected_provider_model_binding::{
    bind_v3_selected_provider_model, V3SelectedProviderModelBinding,
};

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
    let selected = input.selected_target();
    let provider_protocol_payload = match input.provider_protocol {
        V3HubProviderWireProtocol::OpenAiChat => {
            build_v3_openai_chat_standard_request_from_chat_canonical(
                input.provider_semantic_payload(),
            )?
        }
        V3HubProviderWireProtocol::Responses => {
            build_v3_openai_responses_standard_request_from_chat_canonical(
                input.provider_semantic_payload(),
            )?
        }
        V3HubProviderWireProtocol::Anthropic => {
            let source = build_v3_anthropic_provider_request_source_from_chat_canonical(
                input.provider_semantic_payload(),
                input.entry_protocol(),
            )?;
            encode_v3_responses_semantic_as_anthropic_request(source)
                .map_err(|error| error.to_string())?
        }
        V3HubProviderWireProtocol::Gemini => project_outbound_payload_for_target_protocol(
            input.provider_semantic_payload(),
            V3OutboundTargetProtocol::Gemini,
        )?,
    };
    bind_v3_selected_provider_model(provider_protocol_payload, selected)
        .map(V3SelectedProviderModelBinding::into_payload)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hub_v1::{
        build_v3_hub_req_chat_process_04_from_v3_hub_req_continuation_03,
        build_v3_hub_req_continuation_03_from_v3_hub_req_inbound_02,
        build_v3_hub_req_execution_05_from_v3_hub_req_chat_process_04,
        build_v3_hub_req_inbound_01_client_raw,
        build_v3_hub_req_inbound_02_from_v3_hub_req_inbound_01,
        build_v3_hub_req_outbound_07_from_v3_hub_req_target_06,
        build_v3_hub_req_target_06_from_v3_hub_req_execution_05, V3HubContinuationOwnership,
        V3HubEntryProtocol, V3HubExecutionMode, V3HubInvocationSource, V3HubTargetResolution,
        V3HubTransportIntent,
    };
    use routecodex_v3_config::{V3ProviderRequestCleanupAuthoringConfig, V3ResponsesTransportKind};
    use routecodex_v3_target::V3TargetCandidate;
    use serde_json::json;

    fn selected_candidate(provider_protocol: V3HubProviderWireProtocol) -> V3TargetCandidate {
        let provider_type = match provider_protocol {
            V3HubProviderWireProtocol::OpenAiChat => "openai_chat",
            V3HubProviderWireProtocol::Responses => "responses",
            V3HubProviderWireProtocol::Anthropic => "anthropic",
            V3HubProviderWireProtocol::Gemini => "gemini",
        };
        V3TargetCandidate {
            provider_id: format!("selected-{provider_type}"),
            provider_type: provider_type.to_string(),
            auth_alias: "primary".to_string(),
            model_id: "canonical-provider-model".to_string(),
            wire_model: "provider-wire-model".to_string(),
            visible_model_ids: vec!["client-route-alias".to_string()],
            model_capabilities: vec!["text".to_string()],
            max_context_tokens: None,
            base_url: "https://provider.invalid/v1".to_string(),
            responses_process: None,
            responses_transport: V3ResponsesTransportKind::Http,
            websocket_v2_url: None,
            provider_request_cleanup: V3ProviderRequestCleanupAuthoringConfig::default(),
            compatibility_profile: None,
            env_name: Some("TEST_KEY".to_string()),
            token_file: None,
            api_key: None,
            required_capabilities: Vec::new(),
            pool_ids: vec!["default".to_string()],
            default_pool_member: true,
            path: vec![provider_type.to_string()],
        }
    }

    fn relay_req07(
        provider_protocol: V3HubProviderWireProtocol,
    ) -> V3HubReqOutbound07ProviderSemantic {
        let req01 = build_v3_hub_req_inbound_01_client_raw(
            json!({
                "model": "client-route-alias",
                "input": [{
                    "type": "message",
                    "role": "user",
                    "content": [{"type": "input_text", "text": "hello"}]
                }]
            }),
            V3HubEntryProtocol::Responses,
            V3HubInvocationSource::Client,
            V3HubTransportIntent::Json,
        );
        let req02 = build_v3_hub_req_inbound_02_from_v3_hub_req_inbound_01(req01);
        let req03 = build_v3_hub_req_continuation_03_from_v3_hub_req_inbound_02(
            req02,
            V3HubContinuationOwnership::New,
        );
        let req04 = build_v3_hub_req_chat_process_04_from_v3_hub_req_continuation_03(req03);
        let req05 = build_v3_hub_req_execution_05_from_v3_hub_req_chat_process_04(
            req04,
            V3HubExecutionMode::Relay,
        );
        let req06 = build_v3_hub_req_target_06_from_v3_hub_req_execution_05(
            req05,
            V3HubTargetResolution::Routed,
            selected_candidate(provider_protocol),
        );
        build_v3_hub_req_outbound_07_from_v3_hub_req_target_06(req06, provider_protocol)
    }

    fn relay_req07_for_entry(
        entry_protocol: V3HubEntryProtocol,
        payload: serde_json::Value,
        provider_protocol: V3HubProviderWireProtocol,
    ) -> V3HubReqOutbound07ProviderSemantic {
        let req01 = build_v3_hub_req_inbound_01_client_raw(
            payload,
            entry_protocol,
            V3HubInvocationSource::Client,
            V3HubTransportIntent::Json,
        );
        let req02 = build_v3_hub_req_inbound_02_from_v3_hub_req_inbound_01(req01);
        let req03 = build_v3_hub_req_continuation_03_from_v3_hub_req_inbound_02(
            req02,
            V3HubContinuationOwnership::New,
        );
        let req04 = build_v3_hub_req_chat_process_04_from_v3_hub_req_continuation_03(req03);
        let req05 = build_v3_hub_req_execution_05_from_v3_hub_req_chat_process_04(
            req04,
            V3HubExecutionMode::Relay,
        );
        let req06 = build_v3_hub_req_target_06_from_v3_hub_req_execution_05(
            req05,
            V3HubTargetResolution::Routed,
            selected_candidate(provider_protocol),
        );
        build_v3_hub_req_outbound_07_from_v3_hub_req_target_06(req06, provider_protocol)
    }

    #[test]
    fn anthropic_entry_to_anthropic_provider_uses_governed_messages_without_responses_snapshot() {
        let req07 = relay_req07_for_entry(
            V3HubEntryProtocol::Anthropic,
            json!({
                "model": "client-route-alias",
                "messages": [{"role":"user","content":"hello"}],
                "stream": false
            }),
            V3HubProviderWireProtocol::Anthropic,
        );
        let req_compat = build_provider_req_compat_06_from_v3_hub_req_outbound_07(req07).unwrap();
        assert_eq!(
            req_compat.provider_semantic_payload()["model"],
            "provider-wire-model"
        );
        assert_eq!(
            req_compat.provider_semantic_payload()["messages"][0]["role"],
            "user"
        );
    }

    #[test]
    fn anthropic_entry_current_responses_semantic_input_encodes_to_anthropic_provider_wire() {
        let req07 = relay_req07_for_entry(
            V3HubEntryProtocol::Anthropic,
            json!({
                "model": "client-route-alias",
                "input": [{
                    "type":"message",
                    "role":"user",
                    "content":[{"type":"input_text","text":"hello"}]
                }],
                "stream": false
            }),
            V3HubProviderWireProtocol::Anthropic,
        );
        let req_compat = build_provider_req_compat_06_from_v3_hub_req_outbound_07(req07).unwrap();
        assert_eq!(
            req_compat.provider_semantic_payload()["model"],
            "provider-wire-model"
        );
        assert_eq!(
            req_compat.provider_semantic_payload()["messages"][0]["content"][0]["text"],
            "hello"
        );
        assert!(req_compat
            .provider_semantic_payload()
            .get("input")
            .is_none());
    }

    #[test]
    fn responses_entry_tool_history_chat_extension_encodes_anthropic_without_raw_payload_snapshot()
    {
        let req07 = relay_req07_for_entry(
            V3HubEntryProtocol::Responses,
            json!({
                "model": "client-route-alias",
                "input": [
                    {
                        "type":"message",
                        "role":"user",
                        "content":[{"type":"input_text","text":"use tool"}]
                    },
                    {
                        "type":"function_call",
                        "id":"call_lookup",
                        "call_id":"call_lookup",
                        "name":"lookup",
                        "arguments":"{\"query\":\"routecodex\"}"
                    },
                    {
                        "type":"function_call_output",
                        "call_id":"call_lookup",
                        "output":"tool result"
                    },
                    {
                        "type":"message",
                        "role":"user",
                        "content":[{"type":"input_text","text":"continue"}]
                    }
                ],
                "tools": [{
                    "type":"function",
                    "name":"lookup",
                    "description":"lookup",
                    "parameters":{"type":"object","properties":{"query":{"type":"string"}},"required":["query"]}
                }],
                "stream": false
            }),
            V3HubProviderWireProtocol::Anthropic,
        );
        let req_compat = build_provider_req_compat_06_from_v3_hub_req_outbound_07(req07).unwrap();
        let payload = req_compat.provider_semantic_payload();
        assert_eq!(payload["model"], "provider-wire-model");
        assert!(payload.get("input").is_none());
        assert_eq!(payload["messages"][0]["role"], "user");
        assert_eq!(payload["messages"][1]["role"], "assistant");
        assert_eq!(payload["messages"][1]["content"][0]["type"], "text");
        assert_eq!(payload["messages"][1]["content"][1]["type"], "tool_use");
        assert_eq!(payload["messages"][2]["role"], "user");
        assert_eq!(payload["messages"][2]["content"][0]["type"], "tool_result");
    }

    #[test]
    fn responses_request_chat_extension_projects_to_anthropic_wire_at_adjacent_codec() {
        let req07 = relay_req07_for_entry(
            V3HubEntryProtocol::Responses,
            json!({
                "model": "client-route-alias",
                "input": "hello",
                "client_metadata": {
                    "session_id": "session-1",
                    "thread_id": "thread-1",
                    "turn_id": "turn-1"
                },
                "prompt_cache_key": "session-1",
                "store": false,
                "text": {"verbosity": "high"},
                "stream": false
            }),
            V3HubProviderWireProtocol::Anthropic,
        );

        let req_compat = build_provider_req_compat_06_from_v3_hub_req_outbound_07(req07)
            .expect("Responses Chat extension fields must project into Anthropic wire");
        let payload = req_compat.provider_semantic_payload();

        assert_eq!(payload["metadata"]["user_id"], "session-1");
        assert_eq!(
            payload["cache_control"],
            serde_json::json!({"type":"ephemeral"})
        );
        assert_eq!(payload["output_config"]["effort"], "high");
        for source_field in [
            "routecodex_chat_extension",
            "client_metadata",
            "prompt_cache_key",
            "store",
            "text",
        ] {
            assert!(
                payload.get(source_field).is_none(),
                "source Chat/Responses field {source_field} leaked into Anthropic wire: {payload}"
            );
        }
    }

    #[test]
    fn responses_exact_client_user_id_and_json_schema_project_to_anthropic_wire() {
        let req07 = relay_req07_for_entry(
            V3HubEntryProtocol::Responses,
            json!({
                "model": "client-route-alias",
                "input": "hello",
                "client_metadata": {"user_id": "opaque-user-1"},
                "text": {
                    "format": {
                        "type": "json_schema",
                        "name": "answer",
                        "strict": true,
                        "schema": {
                            "type": "object",
                            "properties": {"answer": {"type": "string"}},
                            "required": ["answer"],
                            "additionalProperties": false
                        }
                    }
                }
            }),
            V3HubProviderWireProtocol::Anthropic,
        );

        let req_compat = build_provider_req_compat_06_from_v3_hub_req_outbound_07(req07)
            .expect("exact Responses fields must project into Anthropic wire");
        let payload = req_compat.provider_semantic_payload();

        assert_eq!(payload["metadata"]["user_id"], "opaque-user-1");
        assert_eq!(payload["output_config"]["format"]["type"], "json_schema");
        assert_eq!(
            payload["output_config"]["format"]["schema"]["required"],
            serde_json::json!(["answer"])
        );
    }

    #[test]
    fn responses_store_true_fails_when_anthropic_cannot_preserve_remote_storage_semantics() {
        let req07 = relay_req07_for_entry(
            V3HubEntryProtocol::Responses,
            json!({
                "model": "client-route-alias",
                "input": "hello",
                "store": true
            }),
            V3HubProviderWireProtocol::Anthropic,
        );

        let error = build_provider_req_compat_06_from_v3_hub_req_outbound_07(req07)
            .expect_err("Anthropic wire must not silently strip store=true");
        assert!(error.reason.contains("store"), "{error:?}");
    }

    #[test]
    fn relay_protocols_bind_selected_wire_model_before_provider_compat() {
        for protocol in [
            V3HubProviderWireProtocol::Responses,
            V3HubProviderWireProtocol::OpenAiChat,
            V3HubProviderWireProtocol::Anthropic,
            V3HubProviderWireProtocol::Gemini,
        ] {
            let req07 = relay_req07(protocol);
            assert_eq!(
                req07.provider_semantic_payload()["model"],
                "client-route-alias",
                "client route model remains routing input before the shared binding block"
            );

            let req_compat =
                build_provider_req_compat_06_from_v3_hub_req_outbound_07(req07).unwrap();
            assert_eq!(
                req_compat.provider_semantic_payload()["model"],
                "provider-wire-model",
                "{protocol:?} compat must consume route-selected provider model truth"
            );
            assert_ne!(
                req_compat.provider_semantic_payload()["model"],
                "client-route-alias",
                "{protocol:?} must not leak the client route alias into provider compat"
            );
        }
    }
}
