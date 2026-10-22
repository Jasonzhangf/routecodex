use super::{
    classify_v3_provider_compat_error, provider_protocol_compat_id, ProviderReqCompat06Projected,
    V3HubOpaquePayload, V3HubProviderWireProtocol, V3HubReqOutbound07ProviderSemantic,
    V3ProviderCompatError, V3ProviderCompatProfileId,
};
use pipeline_runtime::{Operator, OperatorContext, ValueType};
use provider_compat_core::opencode_zen_tcm::{
    apply_opencode_zen_tcm_request, compile_opencode_zen_tcm_bridge, OpencodeZenTcmBridgeBinding,
    PROFILE as OPENCODE_ZEN_TCM_PROFILE,
};
use provider_compat_core::req_outbound_stage3_compat::{
    run_req_outbound_stage3_compat, AdapterContext, ReqOutboundCompatInput,
};
use provider_compat_core::{
    compile_custom_tool_function_binding, CustomToolFunctionBinding, CUSTOM_TOOL_FUNCTION_PROFILE,
};
use serde_json::Value;
use std::sync::{Arc, Mutex};

use crate::operation_runner::{run_v3_single_node_operator, V3OperationGraph};
use routecodex_v3_target::V3TargetCandidate;

const ADJUST_PROVIDER_PRIVATE_REQUEST_OPERATOR: &str =
    "routecodex.v3.operation.adjust_provider_private_request";
const ADJUST_PROVIDER_PRIVATE_REQUEST_NODE: &str = "adjust_provider_private_request";

#[derive(Debug)]
struct AdjustProviderPrivateRequestOutcome {
    opencode_zen_tcm_bridge: Option<OpencodeZenTcmBridgeBinding>,
    custom_tool_function_binding: Option<CustomToolFunctionBinding>,
}

#[derive(Debug)]
struct AdjustProviderPrivateRequestError {
    error: V3ProviderCompatError,
}

#[derive(Default)]
struct AdjustProviderPrivateRequestSideOutput {
    outcome: Mutex<
        Option<Result<AdjustProviderPrivateRequestOutcome, AdjustProviderPrivateRequestError>>,
    >,
}

struct AdjustProviderPrivateRequestOperator {
    selected_target: V3TargetCandidate,
    provider_protocol: V3HubProviderWireProtocol,
    profile: V3ProviderCompatProfileId,
    governed_source: Value,
    side_output: Arc<AdjustProviderPrivateRequestSideOutput>,
    execution_mode: super::V3HubExecutionMode,
    entry_protocol: super::V3HubEntryProtocol,
}

impl Operator for AdjustProviderPrivateRequestOperator {
    fn name(&self) -> &'static str {
        ADJUST_PROVIDER_PRIVATE_REQUEST_OPERATOR
    }

    fn version(&self) -> &'static str {
        "1"
    }

    fn input_type(&self) -> ValueType {
        ValueType::Object
    }

    fn output_type(&self) -> ValueType {
        ValueType::Object
    }

    fn execute(&self, input: Value, _: &OperatorContext) -> Result<Value, String> {
        let result = apply_v3_provider_req_compat_to_provider_payload(
            input,
            &self.selected_target,
            self.provider_protocol,
            &self.profile,
        )
        .map(|(mut payload, custom_tool_function_binding)| {
            let opencode_zen_tcm_bridge = if self
                .profile
                .as_str()
                .eq_ignore_ascii_case(OPENCODE_ZEN_TCM_PROFILE)
                && self.entry_protocol == super::V3HubEntryProtocol::Responses
                && self.provider_protocol == V3HubProviderWireProtocol::OpenAiChat
                && self.execution_mode == super::V3HubExecutionMode::Relay
            {
                compile_opencode_zen_tcm_bridge(&self.governed_source, &payload)
            } else {
                None
            };
            if let Some(binding) = &opencode_zen_tcm_bridge {
                apply_opencode_zen_tcm_request(&mut payload, binding);
            }
            let outcome = AdjustProviderPrivateRequestOutcome {
                opencode_zen_tcm_bridge,
                custom_tool_function_binding,
            };
            (payload, outcome)
        })
        .map_err(|error| AdjustProviderPrivateRequestError { error });
        let mut side_output =
            self.side_output.outcome.lock().map_err(|_| {
                "adjust_provider_private_request side output lock poisoned".to_string()
            })?;
        match result {
            Ok((payload, outcome)) => {
                *side_output = Some(Ok(outcome));
                Ok(payload)
            }
            Err(error) => {
                let message = error.error.to_string();
                *side_output = Some(Err(error));
                Err(message)
            }
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct ProviderReqCompat06ProviderCompat {
    pub(crate) previous: V3HubReqOutbound07ProviderSemantic,
    pub(crate) profile: V3ProviderCompatProfileId,
    pub(crate) payload: V3HubOpaquePayload,
    pub(crate) opencode_zen_tcm_bridge: Option<OpencodeZenTcmBridgeBinding>,
    pub(crate) custom_tool_function_binding: Option<CustomToolFunctionBinding>,
    pub(crate) namespace_registry:
        provider_compat_core::namespace_tools::NamespaceToolIdentityRegistry,
}

pub fn build_provider_req_compat_06_from_v3_hub_req_outbound_07(
    input: V3HubReqOutbound07ProviderSemantic,
) -> Result<ProviderReqCompat06Projected, V3ProviderCompatError> {
    let profile = match input.selected_target().compatibility_profile.as_deref() {
        Some(profile) => V3ProviderCompatProfileId::from_config(Some(profile)),
        None => V3ProviderCompatProfileId::Passthrough,
    };
    let side_output = Arc::new(AdjustProviderPrivateRequestSideOutput::default());
    let output = run_v3_single_node_operator(
        V3OperationGraph::Request,
        ADJUST_PROVIDER_PRIVATE_REQUEST_NODE,
        input.provider_semantic_payload().clone(),
        AdjustProviderPrivateRequestOperator {
            selected_target: input.selected_target().clone(),
            provider_protocol: input.provider_protocol,
            profile: profile.clone(),
            governed_source: input.governed_payload().clone(),
            side_output: Arc::clone(&side_output),
            execution_mode: input.previous.previous.execution,
            entry_protocol: input.entry_protocol(),
        },
    );
    let typed_outcome = side_output
        .outcome
        .lock()
        .map_err(|_| {
            classify_v3_provider_compat_error(
                "request",
                &profile,
                "adjust_provider_private_request side output lock poisoned".to_string(),
            )
        })?
        .take();
    let outcome = match typed_outcome {
        Some(Ok(outcome)) => outcome,
        Some(Err(error)) => return Err(error.error),
        None => {
            return match output {
                Err(error) => Err(classify_v3_provider_compat_error(
                    "request",
                    &profile,
                    error.message,
                )),
                Ok(_) => Err(classify_v3_provider_compat_error(
                    "request",
                    &profile,
                    "adjust_provider_private_request produced no typed outcome".to_string(),
                )),
            };
        }
    };
    let output = output
        .map_err(|error| classify_v3_provider_compat_error("request", &profile, error.message))?;
    let namespace_registry = input.namespace_registry.clone();
    let drops = input.drops.clone();
    Ok(ProviderReqCompat06Projected {
        node: ProviderReqCompat06ProviderCompat {
            previous: input,
            profile,
            payload: V3HubOpaquePayload(Arc::new(output)),
            opencode_zen_tcm_bridge: outcome.opencode_zen_tcm_bridge,
            custom_tool_function_binding: outcome.custom_tool_function_binding,
            namespace_registry,
        },
        drops,
    })
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

pub(crate) fn apply_v3_provider_req_compat_to_provider_payload(
    mut payload: Value,
    selected: &routecodex_v3_target::V3TargetCandidate,
    provider_protocol: V3HubProviderWireProtocol,
    profile: &V3ProviderCompatProfileId,
) -> Result<(Value, Option<CustomToolFunctionBinding>), V3ProviderCompatError> {
    project_reasoning_effort_for_selected_target(&mut payload, selected, provider_protocol)?;
    let custom_tool_function_binding = (profile
        .as_str()
        .eq_ignore_ascii_case(CUSTOM_TOOL_FUNCTION_PROFILE)
        && provider_protocol == V3HubProviderWireProtocol::Responses)
        .then(|| compile_custom_tool_function_binding(&payload));
    let provider_key = format!(
        "{}:{}:{}:{}",
        selected.provider_id, selected.interface_id, selected.auth_alias, selected.model_id
    );
    let result = run_req_outbound_stage3_compat(ReqOutboundCompatInput {
        payload,
        adapter_context: AdapterContext {
            compatibility_profile: profile.as_optional_string(),
            provider_protocol: Some(provider_protocol_compat_id(provider_protocol)),
            model_id: Some(selected.model_id.clone()),
            original_model_id: Some(selected.wire_model.clone()),
            provider_id: Some(selected.provider_id.clone()),
            provider_key: Some(provider_key.clone()),
            runtime_key: Some(provider_key),
            web_search_execution_mode: Some(
                selected.web_search_execution_mode.as_str().to_string(),
            ),
            custom_tool_function_binding: custom_tool_function_binding.clone(),
            ..Default::default()
        },
        explicit_profile: profile.as_optional_string(),
    })
    .map(|result| result.payload)
    .map_err(|reason| classify_v3_provider_compat_error("request", profile, reason))?;
    let mut result = result;
    project_reasoning_effort_for_selected_target(&mut result, selected, provider_protocol)?;
    normalize_deepseek_tool_choice(&mut result, selected, provider_protocol);
    drop_glm_unsupported_chat_fields(&mut result, selected, provider_protocol);
    project_provider_declared_output_cap(&mut result, selected, provider_protocol);
    if let Some(effort) = selected.reasoning_effort {
        match provider_protocol {
            V3HubProviderWireProtocol::OpenAiChat => {
                result["reasoning_effort"] = serde_json::json!(effort);
            }
            V3HubProviderWireProtocol::Responses => {
                let reasoning = &mut result["reasoning"];
                if reasoning.is_null() {
                    *reasoning = serde_json::json!({});
                }
                let reasoning = reasoning.as_object_mut().ok_or_else(|| V3ProviderCompatError {
                    stage: "request_reasoning_effort_policy",
                    profile: profile.as_str().to_string(),
                    reason: "cannot represent configured reasoning.effort in non-object reasoning without replacing opaque business data".to_string(),
                    classification: super::provider_compat_error::V3ProviderCompatErrorClassification::RequestPayloadInvalid,
                })?;
                reasoning.insert("effort".to_string(), serde_json::json!(effort));
            }
            // Config compile excludes effort policies on these protocols.
            V3HubProviderWireProtocol::Anthropic | V3HubProviderWireProtocol::Gemini => {}
        }
    }
    Ok((result, custom_tool_function_binding))
}

#[path = "provider_req_compat_06_output_cap.rs"]
mod provider_req_compat_06_output_cap;
use provider_req_compat_06_output_cap::project_provider_declared_output_cap;

#[path = "provider_req_compat_06_reasoning_effort.rs"]
mod provider_req_compat_06_reasoning_effort;
use provider_req_compat_06_reasoning_effort::project_reasoning_effort_for_selected_target;

#[path = "provider_req_compat_06_deepseek.rs"]
mod provider_req_compat_06_deepseek;
use provider_req_compat_06_deepseek::{
    is_v3_deepseek_v4_compat_model, normalize_deepseek_tool_choice,
};

#[path = "provider_req_compat_06_glm.rs"]
mod provider_req_compat_06_glm;
use provider_req_compat_06_glm::drop_glm_unsupported_chat_fields;

#[cfg(test)]
mod tests {
    use super::*;

    const VALID_1X1_PNG_DATA_URL: &str =
        "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
    use crate::hub_v1::{
        build_v3_hub_req_chat_process_04_from_v3_hub_req_inbound_02,
        build_v3_hub_req_execution_05_from_v3_hub_req_chat_process_04,
        build_v3_hub_req_inbound_01_client_raw,
        build_v3_hub_req_inbound_02_from_v3_hub_req_inbound_01,
        build_v3_hub_req_outbound_07_from_v3_hub_req_target_06,
        build_v3_hub_req_target_06_from_v3_hub_req_execution_05, V3HubEntryProtocol,
        V3HubExecutionMode, V3HubInvocationSource, V3HubTargetResolution, V3HubTransportIntent,
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
            interface_id: "default".to_string(),
            auth_alias: "primary".to_string(),
            model_id: "canonical-provider-model".to_string(),
            wire_model: "provider-wire-model".to_string(),
            visible_model_ids: vec!["client-route-alias".to_string()],
            model_capabilities: vec!["text".to_string()],
            web_search_execution_mode: V3WebSearchExecutionMode::None,
            max_context_tokens: None,
            max_tokens: None,
            context_token_estimate_scale_bps: 10_000,
            base_url: "https://provider.invalid/v1".to_string(),
            responses_process: None,
            responses_transport: V3ResponsesTransportKind::Http,
            websocket_v2_url: None,
            provider_request_cleanup: V3ProviderRequestCleanupAuthoringConfig::default(),
            reasoning_effort: None,
            request_timeout_ms: 300_000,
            priority: 0,
            weight: 1,
            sse_first_frame_timeout_ms: None,
            initial_concurrency_budget: 8,
            concurrency_acquire_timeout_ms: 60_000,
            compatibility_profile: None,
            headers: Default::default(),
            env_name: Some("TEST_KEY".to_string()),
            token_file: None,
            secret_file: None,
            secret_key: None,
            api_key: None,
            oauth_declaration: None,
            required_capabilities: Vec::new(),
            pool_ids: vec!["default".to_string()],
            default_pool_member: true,
            path: vec![provider_type.to_string()],
        }
    }

    fn relay_req07_with_candidate(
        provider_protocol: V3HubProviderWireProtocol,
        selected_target: V3TargetCandidate,
    ) -> Result<V3HubReqOutbound07ProviderSemantic, V3ProviderCompatError> {
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
        let req04 = build_v3_hub_req_chat_process_04_from_v3_hub_req_inbound_02(req02);
        let req05 = build_v3_hub_req_execution_05_from_v3_hub_req_chat_process_04(
            req04,
            V3HubExecutionMode::Relay,
        );
        let req06 = build_v3_hub_req_target_06_from_v3_hub_req_execution_05(
            req05,
            V3HubTargetResolution::Routed,
            selected_target,
        );
        build_v3_hub_req_outbound_07_from_v3_hub_req_target_06(req06, provider_protocol)
    }

    fn relay_req07(
        provider_protocol: V3HubProviderWireProtocol,
    ) -> V3HubReqOutbound07ProviderSemantic {
        relay_req07_with_candidate(provider_protocol, selected_candidate(provider_protocol))
            .expect("test fixture Node06 standard projection must succeed")
    }

    fn relay_req07_for_entry_with_candidate(
        entry_protocol: V3HubEntryProtocol,
        payload: serde_json::Value,
        provider_protocol: V3HubProviderWireProtocol,
        selected_target: V3TargetCandidate,
    ) -> Result<V3HubReqOutbound07ProviderSemantic, V3ProviderCompatError> {
        let req01 = build_v3_hub_req_inbound_01_client_raw(
            payload,
            entry_protocol,
            V3HubInvocationSource::Client,
            V3HubTransportIntent::Json,
        );
        let req02 = build_v3_hub_req_inbound_02_from_v3_hub_req_inbound_01(req01);
        let req04 = build_v3_hub_req_chat_process_04_from_v3_hub_req_inbound_02(req02);
        let req05 = build_v3_hub_req_execution_05_from_v3_hub_req_chat_process_04(
            req04,
            V3HubExecutionMode::Relay,
        );
        let req06 = build_v3_hub_req_target_06_from_v3_hub_req_execution_05(
            req05,
            V3HubTargetResolution::Routed,
            selected_target,
        );
        build_v3_hub_req_outbound_07_from_v3_hub_req_target_06(req06, provider_protocol)
    }

    fn relay_req07_for_entry(
        entry_protocol: V3HubEntryProtocol,
        payload: serde_json::Value,
        provider_protocol: V3HubProviderWireProtocol,
    ) -> V3HubReqOutbound07ProviderSemantic {
        relay_req07_for_entry_with_candidate(
            entry_protocol,
            payload,
            provider_protocol,
            selected_candidate(provider_protocol),
        )
        .expect("test fixture Node06 standard projection must succeed")
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
    fn anthropic_standard_effort_is_not_rewritten_by_provider_compat() {
        let req07 = relay_req07_for_entry(
            V3HubEntryProtocol::Responses,
            json!({
                "model": "client-route-alias",
                "input": "hello",
                "reasoning": {"effort": "max"}
            }),
            V3HubProviderWireProtocol::Anthropic,
        );

        let req_compat = build_provider_req_compat_06_from_v3_hub_req_outbound_07(req07)
            .expect("standard Anthropic effort must remain provider-valid");
        assert_eq!(
            req_compat.provider_semantic_payload()["output_config"]["effort"],
            "max"
        );
        assert!(req_compat
            .provider_semantic_payload()
            .get("thinking")
            .is_none());
    }

    #[test]
    fn minimax_anthropic_effort_uses_registered_provider_compat() {
        let mut req07 = relay_req07_for_entry(
            V3HubEntryProtocol::Responses,
            json!({
                "model": "client-route-alias",
                "input": "hello",
                "reasoning": {"effort": "medium"}
            }),
            V3HubProviderWireProtocol::Anthropic,
        );
        req07.previous.selected_target.provider_id = "minimax_anthropic".to_string();
        req07.previous.selected_target.compatibility_profile = Some("chat:minimax".to_string());

        let req_compat = build_provider_req_compat_06_from_v3_hub_req_outbound_07(req07)
            .expect("MiniMax Anthropic compat must produce adaptive thinking");
        assert!(req_compat
            .provider_semantic_payload()
            .get("output_config")
            .is_none());
        assert_eq!(
            req_compat.provider_semantic_payload()["thinking"]["type"],
            "adaptive"
        );
    }

    #[test]
    fn gemini_provider_req_rejects_reasoning_effort_without_selected_reasoning_capability() {
        let error = relay_req07_for_entry_with_candidate(
            V3HubEntryProtocol::OpenAiChat,
            json!({
                "model": "client-route-alias",
                "messages": [{"role":"user","content":"think"}],
                "reasoning_effort": "high"
            }),
            V3HubProviderWireProtocol::Gemini,
            selected_candidate(V3HubProviderWireProtocol::Gemini),
        )
        .expect_err("Gemini Node06 must validate selected target capabilities");
        assert_eq!(error.stage, "request_protocol");
        assert_eq!(
            error.classification(),
            crate::hub_v1::V3ProviderCompatErrorClassification::RequestPayloadInvalid
        );
        assert_eq!(
            error.reason,
            "UnmappedOutboundFields target_protocol=gemini paths=$.reasoning_effort missing_capability=reasoning"
        );
    }

    #[test]
    fn gemini_provider_req_projects_reasoning_effort_with_selected_reasoning_capability() {
        let mut selected_target = selected_candidate(V3HubProviderWireProtocol::Gemini);
        selected_target
            .model_capabilities
            .push("reasoning".to_string());
        let req07 = relay_req07_for_entry_with_candidate(
            V3HubEntryProtocol::OpenAiChat,
            json!({
                "model": "client-route-alias",
                "messages": [{"role":"user","content":"think"}],
                "reasoning_effort": "high"
            }),
            V3HubProviderWireProtocol::Gemini,
            selected_target,
        )
        .expect("selected Gemini target with reasoning capability must pass Node06");

        let req_compat = build_provider_req_compat_06_from_v3_hub_req_outbound_07(req07)
            .expect("selected Gemini target with reasoning capability must accept effort");
        assert_eq!(
            req_compat
                .provider_semantic_payload()
                .pointer("/generationConfig/thinkingConfig/thinkingLevel"),
            Some(&json!("HIGH"))
        );
    }

    #[test]
    fn deepseek_openai_chat_thinking_tool_choice_is_omitted_on_provider_wire() {
        let mut req07 = relay_req07_for_entry(
            V3HubEntryProtocol::OpenAiChat,
            json!({
                "model": "client-route-alias",
                "messages": [{"role":"user","content":"continue"}],
                "reasoning_effort": "high",
                "tools": [{"type":"function","name":"exec_command"}],
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
    fn deepseek_generic_compat_loads_without_provider_profile() {
        let mut req07 = relay_req07_for_entry(
            V3HubEntryProtocol::OpenAiChat,
            json!({
                "model": "client-route-alias",
                "reasoning_effort": "high",
                "messages": [{"role":"assistant", "content": null, "tool_calls": [{"id":"call_1"}]}],
                "tool_choice": "auto"
            }),
            V3HubProviderWireProtocol::OpenAiChat,
        );
        req07.previous.selected_target.provider_type = "openai_chat".to_string();
        req07.previous.selected_target.model_id = "deepseek-v4-flash".to_string();
        req07.previous.selected_target.wire_model = "deepseek-v4-flash".to_string();
        req07.previous.selected_target.compatibility_profile = None;

        let req_compat = build_provider_req_compat_06_from_v3_hub_req_outbound_07(req07)
            .expect("model-family DeepSeek compat must not depend on provider profile");
        let payload = req_compat.provider_semantic_payload();
        assert!(payload.get("tool_choice").is_none());
        assert_eq!(payload["messages"][0]["content"], "");
        assert_eq!(payload["messages"][0]["reasoning_content"], "");
    }

    #[test]
    fn deepseek_v41_openai_chat_wraps_malformed_history_arguments() {
        let mut req07 = relay_req07_for_entry(
            V3HubEntryProtocol::OpenAiChat,
            json!({
                "model": "client-route-alias",
                "messages": [{
                    "role":"assistant",
                    "content":"",
                    "tool_calls":[{
                        "id":"call_bad",
                        "type":"function",
                        "function":{
                            "name":"exec_command",
                            "arguments":"{\"cmd\":\"one\"}{\"cmd\":\"two\"}"
                        }
                    }]
                }, {
                    "role":"tool",
                    "tool_call_id":"call_bad",
                    "content":"failed to parse function arguments"
                }]
            }),
            V3HubProviderWireProtocol::OpenAiChat,
        );
        req07.previous.selected_target.provider_type = "openai_chat".to_string();
        req07.previous.selected_target.model_id = "deepseek-v4.1-flash".to_string();
        req07.previous.selected_target.wire_model = "deepseek-v4.1-flash".to_string();
        req07.previous.selected_target.compatibility_profile =
            Some("chat:deepseek-max".to_string());

        let req_compat = build_provider_req_compat_06_from_v3_hub_req_outbound_07(req07)
            .expect("DeepSeek v4.1 must receive provider-local argument compatibility");
        let payload = req_compat.provider_semantic_payload();
        let wire_arguments = payload["messages"][0]["tool_calls"][0]["function"]["arguments"]
            .as_str()
            .expect("DeepSeek function arguments must remain a string");
        let parsed: serde_json::Value = serde_json::from_str(wire_arguments)
            .expect("DeepSeek function arguments must be valid JSON");
        assert_eq!(parsed["input"], "{\"cmd\":\"one\"}{\"cmd\":\"two\"}");
        assert_eq!(payload["messages"][1]["tool_call_id"], "call_bad");
    }

    #[test]
    fn openai_chat_profile_with_deepseek_v41_wraps_malformed_history_arguments() {
        let mut req07 = relay_req07_for_entry(
            V3HubEntryProtocol::OpenAiChat,
            json!({
                "model": "client-route-alias",
                "messages": [{
                    "role":"assistant",
                    "content":"",
                    "tool_calls":[{
                        "id":"call_bad",
                        "type":"function",
                        "function":{
                            "name":"exec_command",
                            "arguments":"{\"cmd\":\"one\"}{\"cmd\":\"two\"}"
                        }
                    }]
                }, {
                    "role":"tool",
                    "tool_call_id":"call_bad",
                    "content":"failed to parse function arguments"
                }]
            }),
            V3HubProviderWireProtocol::OpenAiChat,
        );
        req07.previous.selected_target.provider_type = "openai_chat".to_string();
        req07.previous.selected_target.model_id = "deepseek-v4.1-flash".to_string();
        req07.previous.selected_target.wire_model = "deepseek-v4.1-flash".to_string();
        req07.previous.selected_target.compatibility_profile = Some("chat:openai".to_string());

        let req_compat = build_provider_req_compat_06_from_v3_hub_req_outbound_07(req07)
            .expect("chat:openai DeepSeek v4.1 must receive provider-local argument compatibility");
        let payload = req_compat.provider_semantic_payload();
        let wire_arguments = payload["messages"][0]["tool_calls"][0]["function"]["arguments"]
            .as_str()
            .expect("DeepSeek function arguments must remain a string");
        let parsed: serde_json::Value = serde_json::from_str(wire_arguments)
            .expect("DeepSeek function arguments must be valid JSON");
        assert_eq!(parsed["input"], "{\"cmd\":\"one\"}{\"cmd\":\"two\"}");
        assert_eq!(payload["messages"][1]["tool_call_id"], "call_bad");
    }

    #[test]
    fn deepseek_openai_chat_thinking_tool_choice_object_is_omitted_on_provider_wire() {
        let mut req07 = relay_req07_for_entry(
            V3HubEntryProtocol::OpenAiChat,
            json!({
                "model": "client-route-alias",
                "messages": [{"role":"user","content":"continue"}],
                "reasoning_effort": "high",
                "tools": [{"type":"function","name":"exec_command"}],
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
    fn deepseek_openai_chat_type_alias_omits_thinking_tool_choice_provider_field() {
        let mut req07 = relay_req07_for_entry(
            V3HubEntryProtocol::OpenAiChat,
            json!({
                "model": "client-route-alias",
                "messages": [{"role":"user","content":"continue"}],
                "reasoning_effort": "high",
                "tools": [{"type":"function","name":"exec_command"}],
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
    fn deepseek_openai_chat_non_thinking_projects_required_tool_choice() {
        let mut req07 = relay_req07_for_entry(
            V3HubEntryProtocol::OpenAiChat,
            json!({
                "model": "client-route-alias",
                "messages": [{"role":"user","content":"continue"}],
                "reasoning_effort": "none",
                "tools": [{"type":"function","name":"exec_command"}],
                "tool_choice": "required"
            }),
            V3HubProviderWireProtocol::OpenAiChat,
        );
        req07.previous.selected_target.provider_type = "openai_chat".to_string();
        req07.previous.selected_target.model_id = "deepseek-v4-flash".to_string();
        req07.previous.selected_target.wire_model = "deepseek-v4-flash".to_string();

        let req_compat = build_provider_req_compat_06_from_v3_hub_req_outbound_07(req07)
            .expect("non-thinking DeepSeek request must use provider-valid tool choice");
        assert_eq!(
            req_compat.provider_semantic_payload()["tool_choice"],
            "auto"
        );
    }

    #[test]
    fn deepseek_openai_chat_without_reasoning_projects_required_tool_choice() {
        let mut req07 = relay_req07_for_entry(
            V3HubEntryProtocol::OpenAiChat,
            json!({
                "model": "client-route-alias",
                "messages": [{"role":"user","content":"continue"}],
                "tools": [{"type":"function","name":"exec_command"}],
                "tool_choice": "required"
            }),
            V3HubProviderWireProtocol::OpenAiChat,
        );
        req07.previous.selected_target.provider_type = "openai_chat".to_string();
        req07.previous.selected_target.compatibility_profile = Some("chat:openai".to_string());
        req07.previous.selected_target.model_id = "deepseek-v4.1-flash".to_string();
        req07.previous.selected_target.wire_model = "DeepSeek-V4.1-Flash".to_string();

        let req_compat = build_provider_req_compat_06_from_v3_hub_req_outbound_07(req07)
            .expect("OpenAI Chat DeepSeek V4.1 request must use provider-valid tool choice");
        assert_eq!(
            req_compat.provider_semantic_payload()["tool_choice"],
            "auto"
        );
        assert!(req_compat
            .provider_semantic_payload()
            .get("reasoning_effort")
            .is_none());
    }

    #[test]
    fn nvidia_glm_openai_chat_drops_unsupported_fields() {
        let mut req07 = relay_req07_for_entry(
            V3HubEntryProtocol::Responses,
            json!({
                "model": "client-route-alias",
                "input": "hello",
                "prompt_cache_key": "session-1",
                "text": {"verbosity": "high"},
                "stream": false
            }),
            V3HubProviderWireProtocol::OpenAiChat,
        );
        req07.previous.selected_target.provider_id = "nvidia".to_string();
        req07.previous.selected_target.model_id = "z-ai/glm-5.3-flash".to_string();
        req07.previous.selected_target.wire_model = "z-ai/glm-5.3-flash".to_string();
        req07.previous.selected_target.compatibility_profile = None;

        let req_compat = build_provider_req_compat_06_from_v3_hub_req_outbound_07(req07)
            .expect("nvidia GLM OpenAI Chat compat must remain valid");
        let payload = req_compat.provider_semantic_payload();
        assert!(
            payload.get("prompt_cache_key").is_none(),
            "GLM targets reject prompt_cache_key on OpenAI Chat: {payload}"
        );
        assert!(
            payload.get("verbosity").is_none(),
            "GLM targets reject verbosity on OpenAI Chat: {payload}"
        );
        assert_eq!(payload["model"], "provider-wire-model");
        assert!(payload.get("messages").is_some());
    }

    #[test]
    fn glm_model_scope_checks_model_id_or_wire_model_basename_case_insensitively() {
        for (model_id, wire_model) in [
            ("nvidia-glm-route-alias", "Z-AI/GLM-5.3-Flash"),
            ("Z-AI/GLM-5.3-Flash", "provider-wire-alias"),
        ] {
            let mut req07 = relay_req07_for_entry(
                V3HubEntryProtocol::Responses,
                json!({
                    "model": "client-route-alias",
                    "input": "hello",
                    "prompt_cache_key": "session-1",
                    "text": {"verbosity": "high"},
                    "stream": false
                }),
                V3HubProviderWireProtocol::OpenAiChat,
            );
            req07.previous.selected_target.provider_id = "future-glm-host".to_string();
            req07.previous.selected_target.model_id = model_id.to_string();
            req07.previous.selected_target.wire_model = wire_model.to_string();
            req07.previous.selected_target.compatibility_profile = None;

            let req_compat = build_provider_req_compat_06_from_v3_hub_req_outbound_07(req07)
                .expect("GLM model-scope compat must remain valid");
            let payload = req_compat.provider_semantic_payload();
            assert!(
                payload.get("prompt_cache_key").is_none(),
                "model_id={model_id} wire_model={wire_model}: {payload}"
            );
            assert!(
                payload.get("verbosity").is_none(),
                "model_id={model_id} wire_model={wire_model}: {payload}"
            );
        }
    }

    #[test]
    fn glm_openai_chat_drops_unsupported_fields_for_xcreate_free() {
        let mut req07 = relay_req07_for_entry(
            V3HubEntryProtocol::Responses,
            json!({
                "model": "client-route-alias",
                "input": "hello",
                "prompt_cache_key": "session-1",
                "text": {"verbosity": "high"},
                "stream": false
            }),
            V3HubProviderWireProtocol::OpenAiChat,
        );
        req07.previous.selected_target.provider_id = "xcreate-free".to_string();
        req07.previous.selected_target.model_id = "z-ai/glm-5.3-flash".to_string();
        req07.previous.selected_target.wire_model = "z-ai/glm-5.3-flash".to_string();
        req07.previous.selected_target.compatibility_profile = None;

        let req_compat = build_provider_req_compat_06_from_v3_hub_req_outbound_07(req07)
            .expect("GLM OpenAI Chat compat must remain valid");
        let payload = req_compat.provider_semantic_payload();
        assert!(payload.get("prompt_cache_key").is_none(), "{payload}");
        assert!(payload.get("verbosity").is_none(), "{payload}");
        assert_eq!(payload["model"], "provider-wire-model");
        assert!(payload.get("messages").is_some());
    }

    #[test]
    fn glm_openai_chat_drops_unsupported_fields_for_xcreate_openai_free() {
        let mut req07 = relay_req07_for_entry(
            V3HubEntryProtocol::Responses,
            json!({
                "model": "client-route-alias",
                "input": "hello",
                "prompt_cache_key": "session-1",
                "text": {"verbosity": "high"},
                "stream": false
            }),
            V3HubProviderWireProtocol::OpenAiChat,
        );
        req07.previous.selected_target.provider_id = "xcreate".to_string();
        req07.previous.selected_target.interface_id = "openai_free".to_string();
        req07.previous.selected_target.model_id = "z-ai/glm-5.3-flash".to_string();
        req07.previous.selected_target.wire_model = "z-ai/glm-5.3-flash".to_string();
        req07.previous.selected_target.compatibility_profile = None;

        let req_compat = build_provider_req_compat_06_from_v3_hub_req_outbound_07(req07)
            .expect("xcreate OpenAI free compat must remain valid");
        let payload = req_compat.provider_semantic_payload();
        assert!(payload.get("prompt_cache_key").is_none(), "{payload}");
        assert!(payload.get("verbosity").is_none(), "{payload}");
    }

    #[test]
    fn glm_openai_chat_drops_unsupported_fields_for_xcreate_openai_paid() {
        let mut req07 = relay_req07_for_entry(
            V3HubEntryProtocol::Responses,
            json!({
                "model": "client-route-alias",
                "input": "hello",
                "prompt_cache_key": "session-1",
                "text": {"verbosity": "high"},
                "stream": false
            }),
            V3HubProviderWireProtocol::OpenAiChat,
        );
        req07.previous.selected_target.provider_id = "xcreate".to_string();
        req07.previous.selected_target.interface_id = "openai_paid".to_string();
        req07.previous.selected_target.model_id = "z-ai/glm-5.3-flash".to_string();
        req07.previous.selected_target.wire_model = "z-ai/glm-5.3-flash".to_string();
        req07.previous.selected_target.compatibility_profile = None;

        let req_compat = build_provider_req_compat_06_from_v3_hub_req_outbound_07(req07)
            .expect("xcreate OpenAI paid compatibility must remain valid");
        let payload = req_compat.provider_semantic_payload();
        assert!(payload.get("prompt_cache_key").is_none(), "{payload}");
        assert!(payload.get("verbosity").is_none(), "{payload}");
    }

    #[test]
    fn nvidia_non_glm_openai_chat_keeps_prompt_cache_key_and_verbosity() {
        let mut req07 = relay_req07_for_entry(
            V3HubEntryProtocol::Responses,
            json!({
                "model": "client-route-alias",
                "input": "hello",
                "prompt_cache_key": "session-1",
                "text": {"verbosity": "high"},
                "stream": false
            }),
            V3HubProviderWireProtocol::OpenAiChat,
        );
        req07.previous.selected_target.provider_id = "nvidia".to_string();
        req07.previous.selected_target.model_id = "deepseek-ai/deepseek-v4.1-flash".to_string();
        req07.previous.selected_target.wire_model = "deepseek-ai/deepseek-v4.1-flash".to_string();
        req07.previous.selected_target.compatibility_profile = None;

        let req_compat = build_provider_req_compat_06_from_v3_hub_req_outbound_07(req07)
            .expect("non-GLM nvidia Chat compatibility must remain valid");
        let payload = req_compat.provider_semantic_payload();
        assert_eq!(payload["prompt_cache_key"], "session-1", "{payload}");
        assert_eq!(payload["verbosity"], "high", "{payload}");
    }

    #[test]
    fn explicit_glm_profile_keeps_declared_semantics() {
        let mut req07 = relay_req07_for_entry(
            V3HubEntryProtocol::Responses,
            json!({
                "model": "client-route-alias",
                "input": "hello",
                "prompt_cache_key": "session-1",
                "text": {"verbosity": "high"},
                "stream": false
            }),
            V3HubProviderWireProtocol::OpenAiChat,
        );
        req07.previous.selected_target.provider_id = "kdns".to_string();
        req07.previous.selected_target.model_id = "z-ai/glm-5.3-flash".to_string();
        req07.previous.selected_target.wire_model = "z-ai/glm-5.3-flash".to_string();
        req07.previous.selected_target.compatibility_profile =
            Some("chat:glm-unsupported-prompt-cache-key-verbosity".to_string());

        let req_compat = build_provider_req_compat_06_from_v3_hub_req_outbound_07(req07)
            .expect("explicit GLM compatibility must remain valid");
        let payload = req_compat.provider_semantic_payload();
        assert!(payload.get("prompt_cache_key").is_none(), "{payload}");
        assert!(payload.get("verbosity").is_none(), "{payload}");
    }

    #[test]
    fn non_glm_openai_chat_keeps_prompt_cache_key_and_verbosity() {
        let mut req07 = relay_req07_for_entry(
            V3HubEntryProtocol::Responses,
            json!({
                "model": "client-route-alias",
                "input": "hello",
                "prompt_cache_key": "session-1",
                "text": {"verbosity": "high"},
                "stream": false
            }),
            V3HubProviderWireProtocol::OpenAiChat,
        );
        req07.previous.selected_target.provider_id = "kdns".to_string();
        req07.previous.selected_target.model_id = "qwen3.8-max".to_string();
        req07.previous.selected_target.wire_model = "qwen3.8-max".to_string();
        req07.previous.selected_target.compatibility_profile = None;

        let req_compat = build_provider_req_compat_06_from_v3_hub_req_outbound_07(req07)
            .expect("non-GLM OpenAI Chat target must preserve the registered fields");
        let payload = req_compat.provider_semantic_payload();
        assert_eq!(payload["prompt_cache_key"], "session-1", "{payload}");
        assert_eq!(payload["verbosity"], "high", "{payload}");
    }

    #[test]
    fn glm_responses_wire_keeps_prompt_cache_key() {
        let mut req07 = relay_req07_for_entry(
            V3HubEntryProtocol::Responses,
            json!({
                "model": "client-route-alias",
                "input": "hello",
                "prompt_cache_key": "session-1",
                "stream": false
            }),
            V3HubProviderWireProtocol::Responses,
        );
        req07.previous.selected_target.provider_id = "xcreate-free".to_string();
        req07.previous.selected_target.model_id = "z-ai/glm-5.3-flash".to_string();
        req07.previous.selected_target.wire_model = "z-ai/glm-5.3-flash".to_string();
        req07.previous.selected_target.compatibility_profile = None;

        let req_compat = build_provider_req_compat_06_from_v3_hub_req_outbound_07(req07)
            .expect("GLM Responses compat must preserve the Responses field");
        assert_eq!(
            req_compat.provider_semantic_payload()["prompt_cache_key"],
            "session-1"
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
        assert_eq!(
            payload["messages"][1]["content"].as_array().unwrap().len(),
            1
        );
        assert_eq!(payload["messages"][1]["content"][0]["type"], "tool_use");
        assert_eq!(payload["messages"][1]["content"][0]["id"], "call_lookup");
        assert_eq!(payload["messages"][1]["content"][0]["name"], "lookup");
        assert_eq!(
            payload["messages"][1]["content"][0]["input"]["query"],
            "routecodex"
        );
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
        let error = relay_req07_for_entry_with_candidate(
            V3HubEntryProtocol::Responses,
            json!({
                "model": "client-route-alias",
                "input": "hello",
                "store": true
            }),
            V3HubProviderWireProtocol::Anthropic,
            selected_candidate(V3HubProviderWireProtocol::Anthropic),
        )
        .expect_err("Anthropic Node06 must not silently strip store=true");
        assert_eq!(error.stage, "request_protocol");
        assert_eq!(
            error.classification(),
            crate::hub_v1::V3ProviderCompatErrorClassification::RequestPayloadInvalid
        );
        assert_eq!(
            error.reason,
            "UnmappedOutboundFields target_protocol=anthropic paths=$.request.store"
        );
    }

    #[test]
    fn responses_unsupported_verbosity_fails_at_anthropic_adjacent_codec() {
        let error = relay_req07_for_entry_with_candidate(
            V3HubEntryProtocol::Responses,
            json!({
                "model": "client-route-alias",
                "input": "hello",
                "text": {"verbosity": "extreme"}
            }),
            V3HubProviderWireProtocol::Anthropic,
            selected_candidate(V3HubProviderWireProtocol::Anthropic),
        )
        .expect_err("unsupported Responses verbosity must fail at Anthropic Node06");
        assert_eq!(error.stage, "request_protocol");
        assert_eq!(
            error.classification(),
            crate::hub_v1::V3ProviderCompatErrorClassification::RequestPayloadInvalid
        );
        assert_eq!(
            error.reason,
            "Anthropic codec malformed routecodex_chat_extension.responses_request.text.verbosity"
        );
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
    fn deepseek_profile_maps_summary_derived_medium_to_official_high_domain() {
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
            .expect("summary-derived medium must use the DeepSeek high projection");

        assert_eq!(
            req_compat.provider_semantic_payload()["reasoning_effort"],
            "high"
        );
    }

    #[test]
    fn deepseek_max_profile_maps_explicit_xhigh_to_official_max_domain() {
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
            .expect("explicit xhigh must use the official DeepSeek max projection");

        assert_eq!(
            req_compat.provider_semantic_payload()["reasoning_effort"],
            "max"
        );
    }

    #[test]
    fn deepseek_max_profile_maps_explicit_ultra_to_max() {
        let mut req07 = relay_req07_for_entry(
            V3HubEntryProtocol::Responses,
            json!({
                "model": "client-route-alias",
                "input": "hello",
                "reasoning": {"effort": "ultra", "summary": "detailed"}
            }),
            V3HubProviderWireProtocol::OpenAiChat,
        );
        req07.previous.selected_target.compatibility_profile =
            Some("chat:deepseek-max".to_string());

        let req_compat = build_provider_req_compat_06_from_v3_hub_req_outbound_07(req07)
            .expect("explicit ultra must use the official DeepSeek max projection");

        assert_eq!(
            req_compat.provider_semantic_payload()["reasoning_effort"],
            "max"
        );
    }

    #[test]
    fn openai_chat_deepseek_v4_model_maps_official_effort_domain() {
        let mut req07 = relay_req07_for_entry(
            V3HubEntryProtocol::Responses,
            json!({
                "model": "client-route-alias",
                "input": "hello",
                "reasoning": {"effort": "medium"}
            }),
            V3HubProviderWireProtocol::OpenAiChat,
        );
        req07.previous.selected_target.compatibility_profile = Some("chat:openai".to_string());
        req07.previous.selected_target.model_id = "deepseek-v4.1-flash".to_string();
        req07.previous.selected_target.wire_model = "DeepSeek-V4.1-Flash".to_string();

        let req_compat = build_provider_req_compat_06_from_v3_hub_req_outbound_07(req07)
            .expect("OpenAI Chat DeepSeek model must use the official DeepSeek high projection");

        assert_eq!(
            req_compat.provider_semantic_payload()["reasoning_effort"],
            "high"
        );
    }

    #[test]
    fn deepseek_max_profile_maps_lower_effort_values_to_high() {
        for effort in ["minimal", "low", "medium", "unknown"] {
            let mut req07 = relay_req07_for_entry(
                V3HubEntryProtocol::Responses,
                json!({
                    "model": "client-route-alias",
                    "input": "hello",
                    "reasoning": {"effort": effort, "summary": "detailed"}
                }),
                V3HubProviderWireProtocol::OpenAiChat,
            );
            req07.previous.selected_target.compatibility_profile =
                Some("chat:deepseek-max".to_string());

            let req_compat = build_provider_req_compat_06_from_v3_hub_req_outbound_07(req07)
                .expect("DeepSeek lower/unknown effort must project to the registered high value");

            assert_eq!(
                req_compat.provider_semantic_payload()["reasoning_effort"],
                "high"
            );
        }
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
    fn opencode_go_zen_provider_compat_projects_medium_to_supported_low_effort() {
        let mut req07 = relay_req07_for_entry(
            V3HubEntryProtocol::Responses,
            json!({
                "model": "client-route-alias",
                "input": "hello",
                "reasoning": {"effort": "medium"}
            }),
            V3HubProviderWireProtocol::OpenAiChat,
        );
        req07.previous.selected_target.provider_id = "opencode-go-zen".to_string();
        req07.previous.selected_target.model_id = "x-preview-f-free".to_string();
        req07.previous.selected_target.wire_model = "x-preview-f-free".to_string();
        req07.previous.selected_target.compatibility_profile =
            Some("compat:passthrough".to_string());

        let req_compat = build_provider_req_compat_06_from_v3_hub_req_outbound_07(req07)
            .expect("OpenCode Zen provider compat must emit a supported effort value");

        assert_eq!(
            req_compat.provider_semantic_payload()["reasoning_effort"],
            "low"
        );

        let mut responses_req07 = relay_req07_for_entry(
            V3HubEntryProtocol::Responses,
            json!({
                "model": "client-route-alias",
                "input": "hello",
                "reasoning": {"effort": "max"}
            }),
            V3HubProviderWireProtocol::Responses,
        );
        responses_req07.previous.selected_target.provider_id = "opencode-go-zen".to_string();
        responses_req07.previous.selected_target.model_id = "x-preview-f-free".to_string();
        responses_req07.previous.selected_target.wire_model = "x-preview-f-free".to_string();
        responses_req07
            .previous
            .selected_target
            .compatibility_profile = Some("compat:passthrough".to_string());

        let responses_compat =
            build_provider_req_compat_06_from_v3_hub_req_outbound_07(responses_req07)
                .expect("OpenCode Zen Responses compat must preserve supported max effort");
        assert_eq!(
            responses_compat.provider_semantic_payload()["reasoning"]["effort"],
            "max"
        );
    }

    #[test]
    fn opencode_go_zen_provider_compat_projects_none_to_supported_low_effort() {
        let mut req07 = relay_req07_for_entry(
            V3HubEntryProtocol::Responses,
            json!({
                "model": "client-route-alias",
                "input": "hello",
                "reasoning": {"effort": "none"}
            }),
            V3HubProviderWireProtocol::Responses,
        );
        req07.previous.selected_target.provider_id = "opencode-go-zen".to_string();
        req07.previous.selected_target.model_id = "x-preview-f-free".to_string();
        req07.previous.selected_target.wire_model = "x-preview-f-free".to_string();
        req07.previous.selected_target.compatibility_profile =
            Some("compat:passthrough".to_string());

        let req_compat = build_provider_req_compat_06_from_v3_hub_req_outbound_07(req07)
            .expect("OpenCode Zen must receive a provider-supported effort value");

        assert_eq!(
            req_compat.provider_semantic_payload()["reasoning"]["effort"],
            "low"
        );
    }

    #[test]
    fn opencode_zen_tcm_bridge_request_rewrite_executes_inside_private_request_operator() {
        let client = json!({
            "model": "client-route-alias",
            "input": "hello",
            "tools": [{
                "type": "namespace",
                "name": "functions",
                "tools": [{
                    "type": "custom",
                    "name": "exec",
                    "description": "Evaluates JavaScript in a fresh V8 isolate as an async module. tools.exec_command. Runs raw JavaScript. text(value)",
                    "format": {
                        "type": "grammar",
                        "syntax": "lark",
                        "definition": provider_compat_core::opencode_zen_tcm::TCM_GRAMMAR
                    }
                }]
            }]
        });
        let mut selected = selected_candidate(V3HubProviderWireProtocol::OpenAiChat);
        selected.compatibility_profile = Some(OPENCODE_ZEN_TCM_PROFILE.to_string());
        let req07 = relay_req07_for_entry_with_candidate(
            V3HubEntryProtocol::Responses,
            client,
            V3HubProviderWireProtocol::OpenAiChat,
            selected,
        )
        .expect("OpenCode TCM fixture must pass standard provider projection");
        let governed_source = req07.governed_payload().clone();
        let provider_semantic_payload = req07.provider_semantic_payload().clone();
        let side_output = Arc::new(AdjustProviderPrivateRequestSideOutput::default());
        let output = run_v3_single_node_operator(
            V3OperationGraph::Request,
            ADJUST_PROVIDER_PRIVATE_REQUEST_NODE,
            provider_semantic_payload,
            AdjustProviderPrivateRequestOperator {
                selected_target: req07.selected_target().clone(),
                provider_protocol: req07.provider_protocol,
                profile: V3ProviderCompatProfileId::from_config(
                    req07.selected_target().compatibility_profile.as_deref(),
                ),
                governed_source,
                side_output: Arc::clone(&side_output),
                execution_mode: req07.previous.previous.execution,
                entry_protocol: req07.entry_protocol(),
            },
        )
        .expect("canonical private request node must execute");
        let outcome = side_output
            .outcome
            .lock()
            .unwrap()
            .take()
            .expect("operator must retain typed side output")
            .expect("operator must succeed");
        let bridge = outcome
            .opencode_zen_tcm_bridge
            .expect("actual TCM declaration and provider projection must bind");
        assert_eq!(bridge.executor_wire_name, "functions__exec");
        assert!(output["tools"]
            .as_array()
            .is_some_and(|tools| { tools.iter().any(|tool| tool["function"]["name"] == "bash") }));
    }

    #[test]
    fn custom_tool_function_binding_is_retained_from_private_request_operator() {
        let mut selected = selected_candidate(V3HubProviderWireProtocol::Responses);
        selected.compatibility_profile = Some(CUSTOM_TOOL_FUNCTION_PROFILE.to_string());
        let req07 = relay_req07_for_entry_with_candidate(
            V3HubEntryProtocol::Responses,
            json!({
                "model": "client-route-alias",
                "input": "hello",
                "tools": [{"type": "custom", "name": "apply_patch"}]
            }),
            V3HubProviderWireProtocol::Responses,
            selected,
        )
        .expect("custom tool fixture must pass standard provider projection");

        let req_compat = build_provider_req_compat_06_from_v3_hub_req_outbound_07(req07)
            .expect("private request operator must retain the custom tool binding");
        let binding = req_compat
            .custom_tool_function_binding
            .as_ref()
            .expect("actual custom tool declaration must produce a typed binding");
        assert_eq!(
            binding.wire_name_for("apply_patch"),
            Some("routecodex_custom__6170706c795f7061746368")
        );
    }

    #[test]
    fn private_request_operator_preserves_original_typed_error() {
        let mut selected = selected_candidate(V3HubProviderWireProtocol::Responses);
        selected.reasoning_effort = Some(routecodex_v3_config::V3ReasoningEffort::High);
        let mut req07 = relay_req07_for_entry_with_candidate(
            V3HubEntryProtocol::Responses,
            json!({
                "model": "client-route-alias",
                "input": "hello"
            }),
            V3HubProviderWireProtocol::Responses,
            selected,
        )
        .expect("fixture must reach private provider compat");
        req07.standard_provider_payload =
            V3HubOpaquePayload(Arc::new(json!({"reasoning": "opaque-non-object"})));

        let error = build_provider_req_compat_06_from_v3_hub_req_outbound_07(req07)
            .expect_err("opaque reasoning data must not be replaced by configured effort");
        assert_eq!(error.stage, "request_reasoning_effort_policy");
        assert_eq!(error.profile, "compat:passthrough");
        assert_eq!(
            error.classification(),
            crate::hub_v1::V3ProviderCompatErrorClassification::RequestPayloadInvalid
        );
        assert_eq!(
            error.reason,
            "cannot represent configured reasoning.effort in non-object reasoning without replacing opaque business data"
        );
    }

    #[test]
    fn openai_chat_relay_projects_responses_web_search_with_image_to_local_servertool_function() {
        let mut selected_target = selected_candidate(V3HubProviderWireProtocol::OpenAiChat);
        selected_target.web_search_execution_mode =
            V3WebSearchExecutionMode::MetadataCenterLocalSearch;
        selected_target
            .model_capabilities
            .push("web_search".to_string());
        let req07 = relay_req07_for_entry_with_candidate(
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
            selected_target,
        )
        .expect("Mode B candidate must pass OpenAI Chat Node06");

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
        let mut selected_target = selected_candidate(V3HubProviderWireProtocol::OpenAiChat);
        selected_target.web_search_execution_mode =
            V3WebSearchExecutionMode::ServertoolSearchBackend;
        selected_target
            .model_capabilities
            .push("web_search".to_string());
        selected_target.compatibility_profile = Some("chat:minimax".to_string());
        let req07 = relay_req07_for_entry_with_candidate(
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
            selected_target,
        )
        .expect("MiniMax candidate must pass OpenAI Chat Node06");

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
                req07.previous.previous.governed_payload()["model"],
                "client-route-alias",
                "{protocol:?} governed source must retain the client route alias"
            );
            assert_eq!(
                req07.provider_semantic_payload()["model"],
                "provider-wire-model",
                "{protocol:?} Node06 output must use the selected wire model"
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

    #[test]
    fn provider_compat_preserves_absence_of_model_identity_guidance() {
        let mut payload = json!({
            "model": "client-route-alias",
            "request_id": "request-identity-must-not-be-model-id",
            "input": [{
                "type": "message",
                "role": "user",
                "content": [{"type": "input_text", "text": "call pwd"}]
            }],
            "tools": [{
                "type": "function",
                "name": "pwd",
                "parameters": {"type":"object","properties":{}}
            }]
        });
        super::super::servertool_hooks::inject_v3_tool_thinking_guidance_at_req04(
            &mut payload,
            0,
            true,
        )
        .expect("Req04 Tool-Thinking guidance");
        assert!(!payload["tools"][0]["parameters"]["properties"]
            .as_object()
            .unwrap()
            .contains_key("model_id"));
        let req07 = relay_req07_for_entry(
            V3HubEntryProtocol::Responses,
            payload,
            V3HubProviderWireProtocol::Responses,
        );

        let req_compat = build_provider_req_compat_06_from_v3_hub_req_outbound_07(req07)
            .expect("provider compat");
        assert!(
            !req_compat.provider_semantic_payload()["tools"][0]["parameters"]["properties"]
                .as_object()
                .unwrap()
                .contains_key("model_id")
        );
    }

    #[test]
    fn multimodal_target_preserves_image_bytes_for_session_semantics() {
        let payload = json!({
            "messages": [{"role": "user", "content": [{
                "type": "image_url",
                "image_url": {"url": VALID_1X1_PNG_DATA_URL}
            }]}]
        });
        let mut selected = selected_candidate(V3HubProviderWireProtocol::OpenAiChat);
        selected.model_capabilities = vec!["text".into(), "multimodal".into(), "vision".into()];
        let (payload, _) = apply_v3_provider_req_compat_to_provider_payload(
            payload,
            &selected,
            V3HubProviderWireProtocol::OpenAiChat,
            &V3ProviderCompatProfileId::Passthrough,
        )
        .unwrap();
        assert_eq!(
            payload["messages"][0]["content"][0]["image_url"]["url"],
            VALID_1X1_PNG_DATA_URL
        );
    }

    #[test]
    fn non_multimodal_target_preserves_representable_latest_image() {
        let payload = json!({
            "messages": [{"role": "user", "content": [{
                "type": "image_url",
                "image_url": {"url": VALID_1X1_PNG_DATA_URL}
            }]}]
        });
        let mut selected = selected_candidate(V3HubProviderWireProtocol::OpenAiChat);
        selected.model_capabilities = vec!["text".into(), "tools".into()];
        let (payload, _) = apply_v3_provider_req_compat_to_provider_payload(
            payload,
            &selected,
            V3HubProviderWireProtocol::OpenAiChat,
            &V3ProviderCompatProfileId::Passthrough,
        )
        .unwrap();
        assert_eq!(
            payload["messages"][0]["content"][0]["image_url"]["url"],
            VALID_1X1_PNG_DATA_URL
        );
    }

    #[path = "provider_req_compat_06_extra_tests.rs"]
    mod provider_req_compat_06_extra_tests;
}
