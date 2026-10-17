use super::{ProviderReqCompat06ProviderCompat, V3ProviderCompatProfileId};
use crate::operation_runner::{run_v3_single_node_operator, V3OperationGraph};
use pipeline_runtime::{Operator, OperatorContext, ValueType};
use provider_compat_core::{
    namespace_tools::NamespaceToolIdentityRegistry, CustomToolFunctionBinding,
};
use routecodex_v3_provider_responses::{
    V3Provider12ResponsesWirePayload, V3ProviderError, V3ResponsesProviderTarget,
    V3ResponsesStreamIntent,
};
use serde_json::Value;
use std::sync::{Arc, Mutex};

const OPERATOR_NAME: &str = "routecodex.v3.operation.encode_provider_wire";
const OPERATOR_VERSION: &str = "1";

#[derive(Debug, thiserror::Error)]
pub enum V3ProviderReqOutbound08Error {
    #[error("provider target mismatch: {0}")]
    TargetMismatch(String),
    #[error("encoded provider-wire SDK node failed: {0}")]
    Runner(String),
    #[error("provider wire side-output holder is poisoned")]
    SideOutputPoisoned,
    #[error("provider wire operator omitted typed side output")]
    MissingSideOutput,
    #[error(transparent)]
    Provider(#[from] V3ProviderError),
}

#[derive(Debug)]
struct EncodeProviderWireOperator {
    request_id: String,
    target: V3ResponsesProviderTarget,
    stream_intent: Option<V3ResponsesStreamIntent>,
    custom_tool_function_binding: Option<CustomToolFunctionBinding>,
    namespace_registry: NamespaceToolIdentityRegistry,
    wire_output: Arc<Mutex<Option<V3Provider12ResponsesWirePayload>>>,
    provider_error: Arc<Mutex<Option<V3ProviderError>>>,
}

impl Operator for EncodeProviderWireOperator {
    fn name(&self) -> &'static str {
        OPERATOR_NAME
    }

    fn version(&self) -> &'static str {
        OPERATOR_VERSION
    }

    fn input_type(&self) -> ValueType {
        ValueType::Object
    }

    fn output_type(&self) -> ValueType {
        ValueType::Object
    }

    fn execute(&self, body: Value, _context: &OperatorContext) -> Result<Value, String> {
        let wire = match build_provider_wire_payload(
            self.request_id.clone(),
            self.target.clone(),
            self.stream_intent,
            body,
            self.custom_tool_function_binding.clone(),
            self.namespace_registry.clone(),
        ) {
            Ok(wire) => wire,
            Err(error) => {
                let message = error.to_string();
                let mut holder = self
                    .provider_error
                    .lock()
                    .map_err(|_| "provider wire error holder is poisoned".to_string())?;
                *holder = Some(error);
                return Err(message);
            }
        };
        let output = wire.body().clone();
        let mut holder = self
            .wire_output
            .lock()
            .map_err(|_| "provider wire side-output holder is poisoned".to_string())?;
        *holder = Some(wire);
        Ok(output)
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct V3ProviderReqOutbound08WirePayload {
    pub(crate) previous: ProviderReqCompat06ProviderCompat,
    pub(crate) wire: Option<V3Provider12ResponsesWirePayload>,
}

/// Temporary compile bridge. Root replaces this call with
/// `build_v3_provider_req_outbound_08_wire_from_compat_06`.
pub fn build_v3_provider_req_outbound_08_from_provider_req_compat_06(
    input: ProviderReqCompat06ProviderCompat,
) -> V3ProviderReqOutbound08WirePayload {
    V3ProviderReqOutbound08WirePayload {
        previous: input,
        wire: None,
    }
}

pub fn build_v3_provider_req_outbound_08_wire_from_compat_06(
    input: ProviderReqCompat06ProviderCompat,
    request_id: impl Into<String>,
    target: V3ResponsesProviderTarget,
    stream_intent: Option<V3ResponsesStreamIntent>,
) -> Result<
    (
        V3ProviderReqOutbound08WirePayload,
        V3Provider12ResponsesWirePayload,
    ),
    V3ProviderReqOutbound08Error,
> {
    verify_target_matches_selection(&input, &target)?;
    let wire_output = Arc::new(Mutex::new(None));
    let provider_error = Arc::new(Mutex::new(None));
    match run_v3_single_node_operator(
        V3OperationGraph::Request,
        "encode_provider_wire",
        input.provider_semantic_payload().clone(),
        EncodeProviderWireOperator {
            request_id: request_id.into(),
            target: target.clone(),
            stream_intent,
            custom_tool_function_binding: input.custom_tool_function_binding().cloned(),
            namespace_registry: input.namespace_registry.clone(),
            wire_output: wire_output.clone(),
            provider_error: provider_error.clone(),
        },
    ) {
        Ok(_) => (),
        Err(error) => {
            let provider_error = provider_error
                .lock()
                .map_err(|_| V3ProviderReqOutbound08Error::SideOutputPoisoned)?
                .take();
            return Err(match provider_error {
                Some(error) => V3ProviderReqOutbound08Error::Provider(error),
                None => V3ProviderReqOutbound08Error::Runner(error.to_string()),
            });
        }
    };
    let wire = wire_output
        .lock()
        .map_err(|_| V3ProviderReqOutbound08Error::SideOutputPoisoned)?
        .take()
        .ok_or(V3ProviderReqOutbound08Error::MissingSideOutput)?;
    Ok((
        V3ProviderReqOutbound08WirePayload {
            previous: input,
            wire: Some(wire.clone()),
        },
        wire,
    ))
}

fn verify_target_matches_selection(
    input: &ProviderReqCompat06ProviderCompat,
    target: &V3ResponsesProviderTarget,
) -> Result<(), V3ProviderReqOutbound08Error> {
    let selected = input.previous.selected_target();
    if target.provider_id != selected.provider_id {
        return Err(V3ProviderReqOutbound08Error::TargetMismatch(format!(
            "target provider {:?}, selected provider {:?}",
            target.provider_id, selected.provider_id
        )));
    }
    if target.interface_id != selected.interface_id {
        return Err(V3ProviderReqOutbound08Error::TargetMismatch(format!(
            "target interface {:?}, selected interface {:?}",
            target.interface_id, selected.interface_id
        )));
    }
    if target.canonical_model_id != selected.model_id {
        return Err(V3ProviderReqOutbound08Error::TargetMismatch(format!(
            "target canonical model {:?}, selected model {:?}",
            target.canonical_model_id, selected.model_id
        )));
    }
    if target.wire_model != selected.wire_model {
        return Err(V3ProviderReqOutbound08Error::TargetMismatch(format!(
            "target wire model {:?}, selected wire model {:?}",
            target.wire_model, selected.wire_model
        )));
    }
    Ok(())
}

fn build_provider_wire_payload(
    request_id: String,
    target: V3ResponsesProviderTarget,
    stream_intent: Option<V3ResponsesStreamIntent>,
    body: Value,
    custom_tool_function_binding: Option<CustomToolFunctionBinding>,
    namespace_registry: NamespaceToolIdentityRegistry,
) -> Result<V3Provider12ResponsesWirePayload, V3ProviderError> {
    let wire = routecodex_v3_provider_responses::wire::build_v3_provider_12_responses_wire_payload_with_registry(
        request_id,
        target,
        body,
        namespace_registry,
    )?;
    let wire = match stream_intent {
        Some(intent) => wire.with_stream_intent(intent),
        None => wire,
    };
    Ok(wire.with_custom_tool_function_binding(custom_tool_function_binding))
}

impl V3ProviderReqOutbound08WirePayload {
    pub(crate) fn compat_profile(&self) -> &V3ProviderCompatProfileId {
        self.previous.profile()
    }

    pub(crate) fn provider_wire(&self) -> Option<&V3Provider12ResponsesWirePayload> {
        self.wire.as_ref()
    }

    pub(crate) fn provider_protocol(&self) -> super::V3HubProviderWireProtocol {
        self.previous.previous.provider_protocol
    }

    pub(crate) fn into_provider_wire(self) -> Option<V3Provider12ResponsesWirePayload> {
        self.wire
    }

    #[cfg(test)]
    pub(super) fn from_test_parts(
        previous: ProviderReqCompat06ProviderCompat,
        wire: V3Provider12ResponsesWirePayload,
    ) -> Self {
        Self {
            previous,
            wire: Some(wire),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hub_v1::{
        build_provider_req_compat_06_from_v3_hub_req_outbound_07,
        build_v3_hub_req_chat_process_04_from_v3_hub_req_inbound_02,
        build_v3_hub_req_execution_05_from_v3_hub_req_chat_process_04,
        build_v3_hub_req_inbound_01_client_raw,
        build_v3_hub_req_inbound_02_from_v3_hub_req_inbound_01,
        build_v3_hub_req_outbound_07_from_v3_hub_req_target_06,
        build_v3_hub_req_target_06_from_v3_hub_req_execution_05, V3HubEntryProtocol,
        V3HubExecutionMode, V3HubInvocationSource, V3HubProviderWireProtocol,
        V3HubTargetResolution, V3HubTransportIntent,
    };
    use provider_compat_core::compile_custom_tool_function_binding;
    use routecodex_v3_config::{
        V3ProviderRequestCleanupAuthoringConfig, V3ResponsesTransportKind, V3WebSearchExecutionMode,
    };
    use routecodex_v3_target::V3TargetCandidate;
    use serde_json::json;

    fn selected_candidate() -> V3TargetCandidate {
        V3TargetCandidate {
            provider_id: "selected-responses".to_string(),
            provider_type: "responses".to_string(),
            interface_id: "default".to_string(),
            auth_alias: "primary".to_string(),
            model_id: "canonical-model".to_string(),
            wire_model: "wire-model".to_string(),
            visible_model_ids: vec!["client-model".to_string()],
            model_capabilities: vec!["text".to_string(), "tools".to_string()],
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
            path: vec!["responses".to_string()],
        }
    }

    fn provider_target() -> V3ResponsesProviderTarget {
        let selected = selected_candidate();
        V3ResponsesProviderTarget {
            provider_id: selected.provider_id,
            interface_id: selected.interface_id,
            provider_type: selected.provider_type,
            base_url: selected.base_url,
            canonical_model_id: selected.model_id,
            wire_model: selected.wire_model,
            compatibility_profile: selected.compatibility_profile,
            headers: selected.headers,
            auth: routecodex_v3_provider_responses::V3ProviderAuthHandle {
                alias: "primary".to_string(),
                secret: routecodex_v3_provider_responses::V3ProviderAuthSecretHandle::ApiKey(
                    "test-secret".to_string(),
                ),
            },
            responses_transport: selected.responses_transport,
            websocket_v2_url: selected.websocket_v2_url,
            provider_request_cleanup: selected.provider_request_cleanup,
            request_timeout_ms: selected.request_timeout_ms,
            sse_first_frame_timeout_ms: selected.sse_first_frame_timeout_ms,
            initial_concurrency_budget: selected.initial_concurrency_budget,
            concurrency_acquire_timeout_ms: selected.concurrency_acquire_timeout_ms,
        }
    }

    fn compat(payload: Value) -> ProviderReqCompat06ProviderCompat {
        let req01 = build_v3_hub_req_inbound_01_client_raw(
            payload,
            V3HubEntryProtocol::OpenAiChat,
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
            selected_candidate(),
        );
        let req07 = build_v3_hub_req_outbound_07_from_v3_hub_req_target_06(
            req06,
            V3HubProviderWireProtocol::Responses,
        )
        .expect("standard provider request");
        build_provider_req_compat_06_from_v3_hub_req_outbound_07(req07)
            .expect("provider request compat")
            .node
    }

    #[test]
    fn sdk_wire_preserves_body_model_namespace_custom_binding_and_stream() {
        let input = compat(json!({
            "model": "client-model",
            "messages": [{"role": "user", "content": "hello"}],
            "tools": [{
                "type": "namespace",
                "name": "mcp__test",
                "tools": [{"type": "function", "name": "lookup", "parameters": {"type": "object"}}]
            }]
        }));
        let custom = compile_custom_tool_function_binding(&json!({
            "tools": [{"type": "custom", "name": "apply_patch"}]
        }));
        let wire_output = Arc::new(Mutex::new(None));
        let provider_error = Arc::new(Mutex::new(None));
        let input_body = input.provider_semantic_payload().clone();
        let output = run_v3_single_node_operator(
            V3OperationGraph::Request,
            "encode_provider_wire",
            input_body,
            EncodeProviderWireOperator {
                request_id: "r08-sdk".to_string(),
                target: provider_target(),
                stream_intent: Some(V3ResponsesStreamIntent::Sse),
                custom_tool_function_binding: Some(custom.clone()),
                namespace_registry: input.namespace_registry.clone(),
                wire_output: wire_output.clone(),
                provider_error: provider_error.clone(),
            },
        )
        .expect("canonical SDK node execution");
        let wire = wire_output.lock().unwrap().take().unwrap();
        assert_eq!(output, *wire.body());
        assert_eq!(wire.request_id(), "r08-sdk");
        assert_eq!(wire.stream_intent(), V3ResponsesStreamIntent::Sse);
        assert_eq!(wire.target().wire_model, "wire-model");
        assert_eq!(wire.body()["model"], "wire-model");
        assert_eq!(wire.body()["input"][0]["content"][0]["text"], "hello");
        assert_eq!(wire.body()["tools"][0]["name"], "mcp__test__lookup");
        assert_eq!(
            wire.namespace_identities().get("mcp__test__lookup"),
            Some(&("mcp__test".to_string(), "lookup".to_string()))
        );
        assert_eq!(wire.custom_tool_function_binding(), Some(&custom));
        assert!(wire.body().get("authorization").is_none());
        assert!(provider_error.lock().unwrap().is_none());
    }

    #[test]
    fn r08_fallible_builder_consumes_sdk_body_and_rejects_target_drift() {
        let input = compat(json!({
            "model": "client-model",
            "messages": [{"role": "user", "content": "hello"}],
            "temperature": 0.25
        }));
        let (node, wire) = build_v3_provider_req_outbound_08_wire_from_compat_06(
            input,
            "r08-public",
            provider_target(),
            Some(V3ResponsesStreamIntent::Json),
        )
        .expect("typed fallible builder");
        assert_eq!(node.provider_wire(), Some(&wire));
        assert_eq!(wire.request_id(), "r08-public");
        assert_eq!(wire.body()["temperature"], 0.25);

        let input = compat(json!({
            "model": "client-model",
            "messages": [{"role": "user", "content": "hello"}]
        }));
        let mut drifted = provider_target();
        drifted.wire_model = "drifted-model".to_string();
        let error = build_v3_provider_req_outbound_08_wire_from_compat_06(
            input,
            "r08-drift",
            drifted,
            None,
        )
        .expect_err("selected target drift must fail");
        assert!(error.to_string().contains("wire model"), "{error}");
    }

    #[test]
    fn r08_invalid_stream_flag_is_typed_failure_without_wire_side_output() {
        let input = compat(json!({
            "model": "client-model",
            "messages": [{"role": "user", "content": "hello"}]
        }));
        let mut body = input.provider_semantic_payload().clone();
        body["stream"] = json!("yes");
        let wire_output = Arc::new(Mutex::new(None));
        let provider_error = Arc::new(Mutex::new(None));
        let error = run_v3_single_node_operator(
            V3OperationGraph::Request,
            "encode_provider_wire",
            body,
            EncodeProviderWireOperator {
                request_id: "r08-invalid".to_string(),
                target: provider_target(),
                stream_intent: None,
                custom_tool_function_binding: None,
                namespace_registry: input.namespace_registry.clone(),
                wire_output: wire_output.clone(),
                provider_error: provider_error.clone(),
            },
        )
        .expect_err("non-boolean stream must fail in Provider12");
        assert!(error.message.contains("must be boolean"), "{error}");
        assert!(wire_output.lock().unwrap().is_none());
        assert!(matches!(
            provider_error.lock().unwrap().take(),
            Some(V3ProviderError::InvalidStreamIntent { request_id })
                if request_id == "r08-invalid"
        ));
    }

    #[test]
    fn r08_public_builder_propagates_typed_sdk_wire_failure() {
        let input = compat(json!({
            "model": "client-model",
            "messages": [{"role": "user", "content": "hello"}],
            "stream": "yes"
        }));
        let error = build_v3_provider_req_outbound_08_wire_from_compat_06(
            input,
            "r08-public-invalid",
            provider_target(),
            None,
        )
        .expect_err("public builder must preserve the typed Provider12 failure");
        assert!(matches!(
            error,
            V3ProviderReqOutbound08Error::Provider(V3ProviderError::InvalidStreamIntent {
                request_id
            }) if request_id == "r08-public-invalid"
        ));
    }
}
