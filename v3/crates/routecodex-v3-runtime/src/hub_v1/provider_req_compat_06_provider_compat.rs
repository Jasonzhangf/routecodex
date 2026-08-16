use super::request_outbound_format::{
    project_outbound_payload_for_target_protocol, V3OutboundTargetProtocol,
};
use super::{
    build_v3_anthropic_provider_request_source_from_chat_canonical,
    build_v3_openai_chat_standard_request_for_selected_web_search_mode,
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
        payload: V3HubOpaquePayload(std::sync::Arc::new(payload)),
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
    let reasoning_effort_explicit =
        provider_req_compat_reasoning_effort_explicit(input.provider_semantic_payload());
    let payload =
        build_v3_provider_standard_protocol_payload_from_req07(input).map_err(|reason| {
            V3ProviderCompatError {
                stage: "request_protocol",
                profile: profile.as_str().to_string(),
                reason,
            }
        })?;
    apply_v3_provider_req_compat_to_provider_payload(
        payload,
        input.selected_target(),
        input.provider_protocol,
        profile,
        reasoning_effort_explicit,
    )
}

pub(crate) fn apply_v3_provider_req_compat_to_provider_payload(
    mut payload: Value,
    selected: &routecodex_v3_target::V3TargetCandidate,
    provider_protocol: V3HubProviderWireProtocol,
    profile: &V3ProviderCompatProfileId,
    reasoning_effort_explicit: bool,
) -> Result<Value, V3ProviderCompatError> {
    project_reasoning_effort_for_selected_target(&mut payload, selected, provider_protocol)?;
    let provider_key = format!(
        "{}:{}:{}",
        selected.provider_id, selected.auth_alias, selected.model_id
    );
    let result = run_req_outbound_stage3_compat(ReqOutboundCompatInput {
        payload,
        adapter_context: AdapterContext {
            compatibility_profile: profile.as_optional_string(),
            provider_protocol: Some(provider_protocol_compat_id(provider_protocol)),
            reasoning_effort_explicit: Some(reasoning_effort_explicit),
            model_id: Some(selected.model_id.clone()),
            original_model_id: Some(selected.wire_model.clone()),
            provider_id: Some(selected.provider_id.clone()),
            provider_key: Some(provider_key.clone()),
            runtime_key: Some(provider_key),
            web_search_execution_mode: Some(
                selected.web_search_execution_mode.as_str().to_string(),
            ),
            ..Default::default()
        },
        explicit_profile: profile.as_optional_string(),
    })
    .map(|result| result.payload)
    .map_err(|reason| V3ProviderCompatError {
        stage: "request",
        profile: profile.as_str().to_string(),
        reason,
    })?;
    let mut result = result;
    project_reasoning_effort_for_selected_target(&mut result, selected, provider_protocol)?;
    normalize_deepseek_thinking_stopless_tool_choice(&mut result, selected, provider_protocol);
    Ok(result)
}

fn project_reasoning_effort_for_selected_target(
    payload: &mut Value,
    selected: &routecodex_v3_target::V3TargetCandidate,
    provider_protocol: V3HubProviderWireProtocol,
) -> Result<(), V3ProviderCompatError> {
    let is_deepseek = matches!(
        selected.compatibility_profile.as_deref(),
        Some("chat:deepseek-max" | "responses:deepseek-console-go")
    );
    let is_minimax = selected.compatibility_profile.as_deref() == Some("chat:minimax");

    let effort_path = match provider_protocol {
        V3HubProviderWireProtocol::Responses => "/reasoning/effort",
        V3HubProviderWireProtocol::OpenAiChat => "/reasoning_effort",
        V3HubProviderWireProtocol::Anthropic => "/output_config/effort",
        V3HubProviderWireProtocol::Gemini => return Ok(()),
    };
    let Some(raw_effort) = payload.pointer(effort_path).cloned() else {
        return Ok(());
    };
    let effort = raw_effort
        .as_str()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| V3ProviderCompatError {
            stage: "request_reasoning_effort_projection",
            profile: selected
                .compatibility_profile
                .clone()
                .unwrap_or_else(|| "protocol-default".to_string()),
            reason: format!("non_empty_string_required path={effort_path}"),
        })?
        .to_ascii_lowercase();

    if is_minimax {
        match provider_protocol {
            V3HubProviderWireProtocol::Anthropic => {
                if let Some(root) = payload.as_object_mut() {
                    if let Some(output_config) =
                        root.get_mut("output_config").and_then(Value::as_object_mut)
                    {
                        output_config.remove("effort");
                        if output_config.is_empty() {
                            root.remove("output_config");
                        }
                    }
                    if effort != "none" {
                        root.insert(
                            "thinking".to_string(),
                            serde_json::json!({"type":"adaptive"}),
                        );
                    }
                }
            }
            V3HubProviderWireProtocol::OpenAiChat => {
                if let Some(root) = payload.as_object_mut() {
                    root.remove("reasoning_effort");
                }
            }
            _ => {}
        }
        return Ok(());
    }

    let projected = if is_deepseek {
        match effort.as_str() {
            "none" => "none",
            "xhigh" | "max" => "max",
            _ => "high",
        }
    } else {
        match provider_protocol {
            V3HubProviderWireProtocol::Responses | V3HubProviderWireProtocol::OpenAiChat => {
                match effort.as_str() {
                    "none" | "minimal" | "low" | "medium" | "high" | "xhigh" => effort.as_str(),
                    "max" => "xhigh",
                    _ => "medium",
                }
            }
            V3HubProviderWireProtocol::Anthropic => match effort.as_str() {
                "none" | "minimal" => "low",
                "low" | "medium" | "high" | "xhigh" | "max" => effort.as_str(),
                _ => "medium",
            },
            V3HubProviderWireProtocol::Gemini => unreachable!(),
        }
    };

    match provider_protocol {
        V3HubProviderWireProtocol::Responses => {
            if let Some(reasoning) = payload.get_mut("reasoning").and_then(Value::as_object_mut) {
                reasoning.insert("effort".to_string(), Value::String(projected.to_string()));
            }
        }
        V3HubProviderWireProtocol::OpenAiChat => {
            if let Some(root) = payload.as_object_mut() {
                root.insert(
                    "reasoning_effort".to_string(),
                    Value::String(projected.to_string()),
                );
            }
        }
        V3HubProviderWireProtocol::Anthropic => {
            if let Some(output_config) = payload
                .get_mut("output_config")
                .and_then(Value::as_object_mut)
            {
                output_config.insert("effort".to_string(), Value::String(projected.to_string()));
            }
        }
        V3HubProviderWireProtocol::Gemini => unreachable!(),
    }
    Ok(())
}

pub(crate) fn provider_req_compat_reasoning_effort_explicit(payload: &Value) -> bool {
    payload
        .get("reasoning_effort")
        .or_else(|| {
            payload
                .get("reasoning")
                .and_then(Value::as_object)
                .and_then(|reasoning| reasoning.get("effort"))
        })
        .is_some()
}

fn build_v3_provider_standard_protocol_payload_from_req07(
    input: &V3HubReqOutbound07ProviderSemantic,
) -> Result<Value, String> {
    let selected = input.selected_target();
    let provider_protocol_payload = match input.provider_protocol {
        V3HubProviderWireProtocol::OpenAiChat => {
            build_v3_openai_chat_standard_request_for_selected_web_search_mode(
                input.provider_semantic_payload(),
                selected.web_search_execution_mode,
                selected
                    .model_capabilities
                    .iter()
                    .any(|capability| capability == "web_search"),
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

fn normalize_deepseek_thinking_stopless_tool_choice(
    payload: &mut Value,
    selected: &routecodex_v3_target::V3TargetCandidate,
    provider_protocol: V3HubProviderWireProtocol,
) {
    if !matches!(
        provider_protocol,
        V3HubProviderWireProtocol::OpenAiChat | V3HubProviderWireProtocol::Responses
    ) || (selected.model_id != "deepseek-v4-flash" && selected.wire_model != "deepseek-v4-flash")
        || !payload_is_thinking_mode(payload)
    {
        return;
    }
    let has_reasoning_stop = payload
        .get("tools")
        .and_then(Value::as_array)
        .is_some_and(|tools| {
            tools.iter().any(|tool| {
                tool.get("name").and_then(Value::as_str) == Some("reasoningStop")
                    || tool.pointer("/function/name").and_then(Value::as_str)
                        == Some("reasoningStop")
            })
        });
    if has_reasoning_stop {
        if let Some(object) = payload.as_object_mut() {
            object.remove("tool_choice");
        }
    }
}

fn payload_is_thinking_mode(payload: &Value) -> bool {
    let effort = payload
        .get("reasoning_effort")
        .and_then(Value::as_str)
        .or_else(|| payload.pointer("/reasoning/effort").and_then(Value::as_str))
        .map(str::trim)
        .unwrap_or_default();
    !effort.is_empty() && !effort.eq_ignore_ascii_case("none")
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
    use routecodex_v3_config::{
        V3ProviderRequestCleanupAuthoringConfig, V3ResponsesTransportKind, V3WebSearchExecutionMode,
    };
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
            web_search_execution_mode: V3WebSearchExecutionMode::None,
            max_context_tokens: None,
            base_url: "https://provider.invalid/v1".to_string(),
            responses_process: None,
            responses_transport: V3ResponsesTransportKind::Http,
            websocket_v2_url: None,
            provider_request_cleanup: V3ProviderRequestCleanupAuthoringConfig::default(),
            request_timeout_ms: 300_000,
            initial_concurrency_budget: 8,
            compatibility_profile: None,
            env_name: Some("TEST_KEY".to_string()),
            token_file: None,
            secret_file: None,
            secret_key: None,
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
    fn deepseek_openai_chat_stopless_tool_choice_is_omitted_on_provider_wire() {
        let mut req07 = relay_req07_for_entry(
            V3HubEntryProtocol::OpenAiChat,
            json!({
                "model": "client-route-alias",
                "messages": [{"role":"user","content":"continue"}],
                "reasoning_effort": "high",
                "tools": [{"type":"function","name":"reasoningStop"}],
                "tool_choice": "required"
            }),
            V3HubProviderWireProtocol::OpenAiChat,
        );
        req07.previous.selected_target.provider_type = "openai_chat".to_string();
        req07.previous.selected_target.model_id = "deepseek-v4-flash".to_string();
        req07.previous.selected_target.wire_model = "deepseek-v4-flash".to_string();

        let req_compat = build_provider_req_compat_06_from_v3_hub_req_outbound_07(req07)
            .expect("DeepSeek thinking tool choice must remain provider-valid");
        assert!(req_compat
            .provider_semantic_payload()
            .get("tool_choice")
            .is_none());
    }

    #[test]
    fn deepseek_responses_maps_unknown_effort_to_official_high_domain() {
        let selected = V3TargetCandidate {
            provider_id: "opencode-go".to_string(),
            provider_type: "responses".to_string(),
            model_id: "deepseek-v4-flash".to_string(),
            wire_model: "deepseek-v4-flash".to_string(),
            compatibility_profile: Some("responses:deepseek-console-go".to_string()),
            ..selected_candidate(V3HubProviderWireProtocol::Responses)
        };
        let payload = json!({
            "model": "deepseek-v4-flash",
            "input": "hello",
            "reasoning": {"effort": "definitely_invalid"}
        });

        let projected = apply_v3_provider_req_compat_to_provider_payload(
            payload,
            &selected,
            V3HubProviderWireProtocol::Responses,
            &V3ProviderCompatProfileId::from_config(selected.compatibility_profile.as_deref()),
            true,
        )
        .expect("DeepSeek effort must map into its official compatibility domain");

        assert_eq!(projected["reasoning"]["effort"], "high", "{projected}");
    }

    #[test]
    fn minimax_anthropic_maps_effort_to_adaptive_thinking_without_unsupported_output_effort() {
        let selected = V3TargetCandidate {
            provider_id: "minimax".to_string(),
            provider_type: "anthropic".to_string(),
            model_id: "MiniMax-M3".to_string(),
            wire_model: "MiniMax-M3".to_string(),
            compatibility_profile: Some("chat:minimax".to_string()),
            ..selected_candidate(V3HubProviderWireProtocol::Anthropic)
        };
        let payload = json!({
            "model": "MiniMax-M3",
            "messages": [{"role": "user", "content": "hello"}],
            "output_config": {"effort": "definitely_invalid"}
        });

        let projected = apply_v3_provider_req_compat_to_provider_payload(
            payload,
            &selected,
            V3HubProviderWireProtocol::Anthropic,
            &V3ProviderCompatProfileId::from_config(selected.compatibility_profile.as_deref()),
            true,
        )
        .expect("MiniMax effort must map to its official adaptive thinking control");

        assert_eq!(projected["thinking"]["type"], "adaptive", "{projected}");
        assert!(
            projected.pointer("/output_config/effort").is_none(),
            "{projected}"
        );
    }

    #[test]
    fn deepseek_openai_chat_stopless_tool_choice_object_is_omitted_on_provider_wire() {
        let mut req07 = relay_req07_for_entry(
            V3HubEntryProtocol::OpenAiChat,
            json!({
                "model": "client-route-alias",
                "messages": [{"role":"user","content":"continue"}],
                "reasoning_effort": "high",
                "tools": [{"type":"function","name":"reasoningStop"}],
                "tool_choice": {"type":"required"}
            }),
            V3HubProviderWireProtocol::OpenAiChat,
        );
        req07.previous.selected_target.provider_type = "openai_chat".to_string();
        req07.previous.selected_target.model_id = "deepseek-v4-flash".to_string();
        req07.previous.selected_target.wire_model = "deepseek-v4-flash".to_string();

        let req_compat = build_provider_req_compat_06_from_v3_hub_req_outbound_07(req07)
            .expect("DeepSeek thinking object tool choice must remain provider-valid");
        assert!(req_compat
            .provider_semantic_payload()
            .get("tool_choice")
            .is_none());
    }

    #[test]
    fn deepseek_openai_chat_type_alias_omits_stopless_tool_choice_provider_field() {
        let mut req07 = relay_req07_for_entry(
            V3HubEntryProtocol::OpenAiChat,
            json!({
                "model": "client-route-alias",
                "messages": [{"role":"user","content":"continue"}],
                "reasoning_effort": "high",
                "tools": [{"type":"function","name":"reasoningStop"}],
                "tool_choice": "required"
            }),
            V3HubProviderWireProtocol::OpenAiChat,
        );
        req07.previous.selected_target.provider_type = "openai-chat-completions".to_string();
        req07.previous.selected_target.model_id = "deepseek-v4-flash".to_string();
        req07.previous.selected_target.wire_model = "deepseek-v4-flash".to_string();

        let req_compat = build_provider_req_compat_06_from_v3_hub_req_outbound_07(req07)
            .expect("DeepSeek provider type alias must use provider-valid tool choice");
        assert!(req_compat
            .provider_semantic_payload()
            .get("tool_choice")
            .is_none());
    }

    #[test]
    fn deepseek_openai_chat_non_thinking_stopless_keeps_required_tool_choice() {
        let mut req07 = relay_req07_for_entry(
            V3HubEntryProtocol::OpenAiChat,
            json!({
                "model": "client-route-alias",
                "messages": [{"role":"user","content":"continue"}],
                "reasoning_effort": "none",
                "tools": [{"type":"function","name":"reasoningStop"}],
                "tool_choice": "required"
            }),
            V3HubProviderWireProtocol::OpenAiChat,
        );
        req07.previous.selected_target.provider_type = "openai_chat".to_string();
        req07.previous.selected_target.model_id = "deepseek-v4-flash".to_string();
        req07.previous.selected_target.wire_model = "deepseek-v4-flash".to_string();

        let req_compat = build_provider_req_compat_06_from_v3_hub_req_outbound_07(req07)
            .expect("non-thinking DeepSeek stopless request must preserve required choice");
        assert_eq!(
            req_compat.provider_semantic_payload()["tool_choice"],
            "required"
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

        assert_eq!(
            req_compat.provider_semantic_payload()["reasoning_effort"],
            "max"
        );
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

        assert_eq!(
            req_compat.provider_semantic_payload()["reasoning_effort"],
            "max"
        );
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

        assert_eq!(
            req_compat.provider_semantic_payload()["reasoning_effort"],
            "high"
        );
    }

    #[test]
    fn openai_chat_relay_projects_responses_web_search_with_image_to_local_servertool_function() {
        let mut req07 = relay_req07_for_entry(
            V3HubEntryProtocol::Responses,
            json!({
                "model": "client-route-alias",
                "input": "search images",
                "tools": [{
                    "type": "web_search",
                    "external_web_access": true,
                    "search_content_types": ["text", "image"],
                    "search_context_size": "medium"
                }]
            }),
            V3HubProviderWireProtocol::OpenAiChat,
        );
        req07.previous.selected_target.web_search_execution_mode =
            V3WebSearchExecutionMode::MetadataCenterLocalSearch;

        let req_compat = build_provider_req_compat_06_from_v3_hub_req_outbound_07(req07).expect(
            "Mode B OpenAI Chat relay must project built-in web search to local websearch function",
        );
        let payload = req_compat.provider_semantic_payload();
        assert!(payload.get("web_search_options").is_none(), "{payload}");
        let web_search = payload["tools"]
            .as_array()
            .and_then(|tools| {
                tools.iter().find(|tool| {
                    tool.pointer("/function/name").and_then(Value::as_str) == Some("websearch")
                })
            })
            .expect("Mode B canonical local websearch function");
        assert_eq!(
            web_search["function"]["parameters"]["properties"]["search_content_types"]["items"]
                ["enum"],
            json!(["text", "image"])
        );
        assert_eq!(
            web_search["function"]["parameters"]["properties"]["search_content_types"]["default"],
            json!(["text", "image"])
        );
    }

    #[test]
    fn minimax_openai_chat_profile_accepts_local_websearch_function_projection() {
        let mut req07 = relay_req07_for_entry(
            V3HubEntryProtocol::Responses,
            json!({
                "model": "client-route-alias",
                "input": "search images",
                "tools": [{
                    "type": "web_search",
                    "external_web_access": true,
                    "search_content_types": ["text", "image"]
                }]
            }),
            V3HubProviderWireProtocol::OpenAiChat,
        );
        req07.previous.selected_target.web_search_execution_mode =
            V3WebSearchExecutionMode::ServertoolSearchBackend;
        req07.previous.selected_target.compatibility_profile = Some("chat:minimax".to_string());

        let req_compat = build_provider_req_compat_06_from_v3_hub_req_outbound_07(req07)
            .expect("MiniMax Chat compat must accept Mode B local websearch function");
        assert!(req_compat.provider_semantic_payload()["tools"]
            .as_array()
            .is_some_and(|tools| tools.iter().any(|tool| {
                tool.pointer("/function/name").and_then(Value::as_str) == Some("websearch")
            })));
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
