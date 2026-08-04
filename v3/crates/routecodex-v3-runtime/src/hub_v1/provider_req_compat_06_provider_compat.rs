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
    let reasoning_effort_explicit = input
        .provider_semantic_payload()
        .get("reasoning_effort")
        .or_else(|| {
            input
                .provider_semantic_payload()
                .get("reasoning")
                .and_then(Value::as_object)
                .and_then(|reasoning| reasoning.get("effort"))
        })
        .is_some();
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
            reasoning_effort_explicit: Some(reasoning_effort_explicit),
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
    fn responses_prompt_cache_key_is_registered_local_cache_hint_for_anthropic() {
        let req07 = relay_req07_for_entry(
            V3HubEntryProtocol::Responses,
            json!({
                "model": "client-route-alias",
                "input": "hello",
                "prompt_cache_key": "session-1",
                "stream": false
            }),
            V3HubProviderWireProtocol::Anthropic,
        );

        let req_compat = build_provider_req_compat_06_from_v3_hub_req_outbound_07(req07)
            .expect("valid prompt_cache_key is a registered local cache hint");
        assert!(
            req_compat
                .provider_semantic_payload()
                .get("prompt_cache_key")
                .is_none(),
            "Anthropic wire must not invent a prompt_cache_key field"
        );
    }

    #[test]
    fn responses_registered_client_metadata_is_local_context_at_anthropic_target_codec() {
        let req07 = relay_req07_for_entry(
            V3HubEntryProtocol::Responses,
            json!({
                "model": "client-route-alias",
                "input": "hello",
                "client_metadata": {"session_id": "session-1"},
                "stream": false
            }),
            V3HubProviderWireProtocol::Anthropic,
        );

        let req_compat = build_provider_req_compat_06_from_v3_hub_req_outbound_07(req07)
            .expect("registered Codex client metadata is local request context");
        assert!(
            req_compat
                .provider_semantic_payload()
                .get("client_metadata")
                .is_none(),
            "Anthropic wire must not forward client_metadata"
        );
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
    fn responses_store_false_is_consumed_when_anthropic_also_does_not_store() {
        let req07 = relay_req07_for_entry(
            V3HubEntryProtocol::Responses,
            json!({
                "model": "client-route-alias",
                "input": "hello",
                "store": false
            }),
            V3HubProviderWireProtocol::Anthropic,
        );

        let req_compat = build_provider_req_compat_06_from_v3_hub_req_outbound_07(req07)
            .expect("store=false is semantically equivalent to Anthropic non-storage");
        assert!(
            req_compat
                .provider_semantic_payload()
                .get("store")
                .is_none(),
            "Anthropic wire must not invent a store field"
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
    fn responses_unsupported_verbosity_fails_at_anthropic_adjacent_codec() {
        let req07 = relay_req07_for_entry(
            V3HubEntryProtocol::Responses,
            json!({
                "model": "client-route-alias",
                "input": "hello",
                "text": {"verbosity": "extreme"}
            }),
            V3HubProviderWireProtocol::Anthropic,
        );

        let error = build_provider_req_compat_06_from_v3_hub_req_outbound_07(req07)
            .expect_err("unsupported Responses verbosity must fail before Anthropic wire");
        assert!(error.reason.contains("verbosity"), "{error:?}");
    }

    #[test]
    fn responses_supported_verbosity_is_registered_local_style_hint_for_anthropic() {
        let req07 = relay_req07_for_entry(
            V3HubEntryProtocol::Responses,
            json!({
                "model": "client-route-alias",
                "input": "hello",
                "text": {"verbosity": "high"}
            }),
            V3HubProviderWireProtocol::Anthropic,
        );

        let req_compat = build_provider_req_compat_06_from_v3_hub_req_outbound_07(req07)
            .expect("supported Responses verbosity is a registered local style hint");
        assert!(
            req_compat
                .provider_semantic_payload()
                .get("verbosity")
                .is_none(),
            "Anthropic wire must not relabel text.verbosity as output_config.effort"
        );
    }

    #[test]
    fn deepseek_max_profile_uses_max_when_only_summary_projects_an_effort() {
        let mut req07 = relay_req07_for_entry(
            V3HubEntryProtocol::Responses,
            json!({
                "model": "client-route-alias",
                "input": "hello",
                "reasoning": {"summary": "auto"}
            }),
            V3HubProviderWireProtocol::OpenAiChat,
        );
        req07.previous.selected_target.compatibility_profile =
            Some("chat:deepseek-max".to_string());

        let req_compat = build_provider_req_compat_06_from_v3_hub_req_outbound_07(req07)
            .expect("summary-derived effort must preserve the DeepSeek default max");

        assert_eq!(req_compat.provider_semantic_payload()["reasoning_effort"], "max");
    }

    #[test]
    fn deepseek_max_profile_maps_explicit_xhigh_to_max() {
        let mut req07 = relay_req07_for_entry(
            V3HubEntryProtocol::Responses,
            json!({
                "model": "client-route-alias",
                "input": "hello",
                "reasoning": {"effort": "xhigh", "summary": "detailed"}
            }),
            V3HubProviderWireProtocol::OpenAiChat,
        );
        req07.previous.selected_target.compatibility_profile =
            Some("chat:deepseek-max".to_string());

        let req_compat = build_provider_req_compat_06_from_v3_hub_req_outbound_07(req07)
            .expect("explicit xhigh must use the registered DeepSeek max projection");

        assert_eq!(req_compat.provider_semantic_payload()["reasoning_effort"], "max");
    }

    #[test]
    fn deepseek_max_profile_merges_explicit_medium_with_detailed_summary() {
        let mut req07 = relay_req07_for_entry(
            V3HubEntryProtocol::Responses,
            json!({
                "model": "client-route-alias",
                "input": "hello",
                "reasoning": {"effort": "medium", "summary": "detailed"}
            }),
            V3HubProviderWireProtocol::OpenAiChat,
        );
        req07.previous.selected_target.compatibility_profile =
            Some("chat:deepseek-max".to_string());

        let req_compat = build_provider_req_compat_06_from_v3_hub_req_outbound_07(req07)
            .expect("explicit effort and summary must use the registered higher-level merge");

        assert_eq!(req_compat.provider_semantic_payload()["reasoning_effort"], "high");
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
