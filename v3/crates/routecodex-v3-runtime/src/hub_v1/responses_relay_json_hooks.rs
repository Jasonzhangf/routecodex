use super::*;
use serde_json::Value;

pub(crate) struct V3ResponsesRelayJsonResponseHookInput<'a> {
    pub(crate) session_id: &'a str,
    pub(crate) request_id: &'a str,
    pub(crate) provider_value: &'a Value,
    pub(crate) provider_semantic_body: &'a Value,
    pub(crate) manifest: &'a V3Config05ManifestPublished,
    pub(crate) server_id: &'a str,
    pub(crate) provider_id: Option<&'a str>,
    pub(crate) interface_id: Option<&'a str>,
    pub(crate) expected_model_id: &'a str,
    pub(crate) provider_protocol: V3HubProviderWireProtocol,
    pub(crate) source_provider_protocol: V3HubProviderWireProtocol,
    pub(crate) namespace_registry:
        &'a provider_compat_core::namespace_tools::NamespaceToolIdentityRegistry,
    pub(crate) provider_response_transport_intent: V3HubTransportIntent,
    pub(crate) compatibility_profile: Option<&'a str>,
    pub(crate) opencode_zen_tcm_bridge:
        Option<&'a provider_compat_core::opencode_zen_tcm::OpencodeZenTcmBridgeBinding>,
    pub(crate) custom_tool_function_binding:
        Option<&'a provider_compat_core::CustomToolFunctionBinding>,
    /// 请求侧 VR 路由决策算好的"保留响应密文"标记（仅 gpt 模型 + 单一 provider
    /// 候选时为 true），响应侧 Resp03 只消费此结果，不重复判定。
    pub(crate) retain_response_cipher: bool,
    pub(crate) tool_thinking_enabled: bool,
    pub(crate) tool_thinking_turn_context: &'a V3ToolThinkingTurnContext,
}

/// Compatibility entry for callers that do not need refill facts. The typed
/// invocation source stays `Client`; Runtime-launched refills call the
/// `_with_invocation_source` owner directly.
pub(crate) fn run_json_response_hooks(
    input: V3ResponsesRelayJsonResponseHookInput<'_>,
    trace: &mut Vec<&'static str>,
) -> Result<
    (
        Value,
        super::resp_chat_process_03_governed::V3ChatProcessGovernedFacts,
    ),
    V3ResponsesRelayRuntimeError,
> {
    run_json_response_hooks_with_invocation_source(input, V3HubInvocationSource::Client, trace)
}

pub(crate) fn run_json_response_hooks_with_invocation_source(
    input: V3ResponsesRelayJsonResponseHookInput<'_>,
    invocation_source: V3HubInvocationSource,
    trace: &mut Vec<&'static str>,
) -> Result<
    (
        Value,
        super::resp_chat_process_03_governed::V3ChatProcessGovernedFacts,
    ),
    V3ResponsesRelayRuntimeError,
> {
    let normalized_provider_value = match input.provider_protocol {
        V3HubProviderWireProtocol::Responses => {
            normalize_v3_responses_json_document(input.provider_value, "Responses")?
        }
        V3HubProviderWireProtocol::OpenAiChat => {
            normalize_v3_openai_chat_json_document(input.provider_value)?
        }
        _ => input.provider_value.clone(),
    };
    // `provider_protocol` stays the canonical semantic protocol so ProviderRespCompat02
    // and normalization keep their existing meaning. The raw wire protocol is carried
    // separately as a typed witness that only the Resp03 source-provenance gate reads.
    let resp01 = build_v3_provider_resp_inbound_01_raw_with_compat_profile(
        normalized_provider_value,
        V3ProviderRespInbound01RawContext::new(
            V3HubEntryProtocol::Responses,
            input.provider_protocol,
            V3HubExecutionMode::Relay,
            invocation_source,
            input.provider_response_transport_intent,
        )
        .with_source_provider_protocol(input.source_provider_protocol)
        .with_compatibility_profile(input.compatibility_profile)
        .with_opencode_zen_tcm_bridge(input.opencode_zen_tcm_bridge.cloned())
        .with_custom_tool_function_binding(input.custom_tool_function_binding.cloned()),
    );
    trace.push("V3ProviderRespInbound01Raw");
    let hooks = compile_v3_hub_relay_response_hooks();
    let mut resp02 = hooks.normalize_with_context(resp01, None, Some(input.request_id))?;
    trace.push("ProviderRespCompat02ProviderCompat");
    // Capture the provider's own explicit-summary fact from the *native*
    // payload first. Two later stages can synthesize Responses-shaped
    // `output[].reasoning.summary[].text` that the provider never sent: the
    // Chat -> Responses conversion below maps `reasoning_content` into summary
    // text, and `govern` can synthesize RCC reasoning/toolreason summary
    // content. Neither may suppress the bounded refill decision.
    let has_source_summary =
        super::resp_chat_process_03_governed::has_v3_source_explicit_nonempty_summary(
            resp02.provider_payload(),
        );
    if input.provider_protocol == V3HubProviderWireProtocol::OpenAiChat {
        let converted = build_v3_responses_provider_response_from_openai_chat_payload(
            resp02.provider_payload(),
            input.provider_semantic_body,
        )?;
        resp02.set_responses_semantic_payload(normalize_v3_responses_json_document(
            &converted,
            "OpenAI Chat",
        )?);
    }
    trace.push("V3HubRespInbound02Normalized");
    let response_hook_profile = responses_relay_response_hook_profile(
        input.manifest,
        input.server_id,
        input.session_id,
        input.request_id,
        input.retain_response_cipher,
        input.tool_thinking_enabled,
        input.expected_model_id,
        input.tool_thinking_turn_context,
    );
    let response_hook_profile = response_hook_profile
        .with_complete_provider_attempt(true)
        .with_serialized_tool_context(
            super::resp_chat_process_03_governed::V3HubRelaySerializedToolContext::from_registry(
                input.namespace_registry,
            ),
        );
    let resp03 = match hooks.govern(resp02, &response_hook_profile) {
        Ok(resp03) => resp03,
        Err(V3HubRelayResponseError::GovernedAttemptEmpty) => {
            return Err(super::empty_provider_attempt_failure(
                input.provider_protocol,
            ));
        }
        Err(error) => return Err(error.into()),
    };
    trace.push("V3HubRespChatProcess03Governed");
    let mut resp03 = resp03.into_governed();
    let tool_calls = resp03.tool_calls.clone();
    if input.source_provider_protocol == V3HubProviderWireProtocol::Gemini {
        super::gemini_responses_codec::restore_gemini_tool_kinds(
            std::sync::Arc::make_mut(resp03.previous.provider_payload_mut()),
            input.namespace_registry,
        );
    }
    super::request_outbound_mcp_names::restore_responses_mcp_tool_identities(
        std::sync::Arc::make_mut(resp03.previous.provider_payload_mut()),
        &input.namespace_registry.restore_identities(),
    );
    super::resp_chat_process_codex_integer_values::normalize_v3_codex_integer_tool_values_at_resp03(
        input.provider_semantic_body,
        std::sync::Arc::make_mut(resp03.previous.provider_payload_mut()),
    );
    let resp05 = try_build_v3_hub_resp_outbound_05_from_v3_hub_resp_chat_process_03_with_projector(
        resp03,
        |payload| Ok(project_v3_responses_client_completed_response(&payload)),
    )
    .map_err(|error| V3ResponsesRelayRuntimeError::Target(error.to_string()))?;
    trace.push("V3HubRespOutbound05ClientSemantic");
    let resp06 = super::server_resp_outbound_06_client_frame::
        try_build_v3_server_resp_outbound_06_with_framer_and_memory_raw_capture(
        resp05,
        &input.manifest.memory_raw_capture,
        input.request_id,
    )
    .map_err(V3ResponsesRelayRuntimeError::ExecutionControlResponse)?;
    trace.push("V3ServerRespOutbound06ClientFrame");
    Ok((
        resp06.into_client_payload(),
        super::resp_chat_process_03_governed::V3ChatProcessGovernedFacts {
            tool_calls,
            has_source_summary,
        },
    ))
}

fn normalize_v3_responses_json_document(
    value: &Value,
    protocol: &'static str,
) -> Result<Value, V3ResponsesRelayRuntimeError> {
    V3ResponsesJsonDocument::from_json(value)
        .map_err(|_| {
            V3ResponsesRelayRuntimeError::Response(
                V3HubRelayResponseError::ProviderProtocolResponseMalformed {
                    protocol,
                    reason: "typed JSON document is malformed",
                },
            )
        })
        .map(|document| document.to_normalized_value())
}

fn normalize_v3_openai_chat_json_document(
    value: &Value,
) -> Result<Value, V3ResponsesRelayRuntimeError> {
    V3OpenAiChatJsonDocument::from_json(value)
        .map_err(|_| {
            V3ResponsesRelayRuntimeError::Response(
                V3HubRelayResponseError::ProviderProtocolResponseMalformed {
                    protocol: "OpenAI Chat",
                    reason: "typed JSON document is malformed",
                },
            )
        })
        .map(|document| document.to_normalized_value())
}

pub(crate) fn responses_relay_request_hook_profile(
    manifest: &V3Config05ManifestPublished,
    server_id: &str,
) -> V3HubRequestHookProfile {
    let tool_thinking_enabled = v3_tool_thinking_enabled_for_server(manifest, server_id);
    let base = if tool_thinking_enabled || manifest.memory_raw_capture.enabled {
        V3HubRequestHookProfile::enabled().with_tool_thinking_enabled(tool_thinking_enabled)
    } else {
        V3HubRequestHookProfile::disabled()
    };
    base.with_memory_raw_capture_enabled(manifest.memory_raw_capture.enabled)
}

pub(crate) fn responses_relay_response_hook_profile(
    manifest: &V3Config05ManifestPublished,
    server_id: &str,
    session_id: &str,
    request_id: &str,
    retain_response_cipher: bool,
    tool_thinking_enabled: bool,
    expected_model_id: &str,
    tool_thinking_turn_context: &V3ToolThinkingTurnContext,
) -> V3HubRelayResponseHookProfile {
    let toolreason_client_projection =
        v3_toolreason_client_projection_enabled_for_server(manifest, server_id);
    let profile = V3HubRelayResponseHookProfile::empty()
        .with_retain_response_cipher(retain_response_cipher)
        .with_tool_thinking_enabled(tool_thinking_enabled)
        .with_tool_thinking_turn_context(tool_thinking_turn_context)
        .with_toolreason_expected_model_id(expected_model_id)
        .with_toolreason_client_projection(toolreason_client_projection);
    let profile = profile.with_toolreason_observation_request_id(request_id);
    let profile = profile.with_toolreason_observation_session_id(session_id);
    profile
}
