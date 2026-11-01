use super::{
    build_v3_provider_transport_request_from_parts, V3ProviderReqOutbound08WirePayload,
    V3ProviderWireTransportContext,
};
use crate::operation_runner::{run_v3_single_node_operator, V3OperationGraph};
use pipeline_runtime::{Operator, OperatorContext, ValueType};
use routecodex_v3_provider_responses::{
    V3ProviderRequestHeader, V3Transport13ResponsesHttpRequest,
};
use serde_json::Value;
use std::sync::{Arc, Mutex};

const OPERATOR_NAME: &str = "routecodex.v3.operation.construct_transport_request";
const OPERATOR_VERSION: &str = "1";

struct ConstructTransportRequestOperator {
    protocol: super::V3HubProviderWireProtocol,
    context: V3ProviderWireTransportContext,
    provider_headers: Vec<V3ProviderRequestHeader>,
    transport_output: Arc<Mutex<Option<V3Transport13ResponsesHttpRequest>>>,
}

impl Operator for ConstructTransportRequestOperator {
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
        let request = build_v3_provider_transport_request_from_parts(
            self.protocol,
            self.context.clone(),
            body,
            self.provider_headers.clone(),
        )?;
        let output = request.provider_request_projection();
        *self
            .transport_output
            .lock()
            .map_err(|_| "provider transport side-output holder is poisoned".to_string())? =
            Some(request);
        Ok(output)
    }
}

#[derive(Debug)]
pub struct V3ProviderReqOutbound09TransportRequest {
    pub(crate) previous: V3ProviderReqOutbound08WirePayload,
    pub(crate) transport: Option<V3Transport13ResponsesHttpRequest>,
}

pub fn build_v3_provider_req_outbound_09_from_v3_provider_req_outbound_08(
    input: V3ProviderReqOutbound08WirePayload,
) -> V3ProviderReqOutbound09TransportRequest {
    V3ProviderReqOutbound09TransportRequest {
        previous: input,
        transport: None,
    }
}

impl V3ProviderReqOutbound09TransportRequest {
    pub(crate) fn into_provider_semantic_payload(self) -> Value {
        self.previous.previous.provider_semantic_payload().clone()
    }

    pub fn compat_profile_id(&self) -> &str {
        self.previous.compat_profile().as_str()
    }

    pub(crate) fn transport_request(&self) -> Option<&V3Transport13ResponsesHttpRequest> {
        self.transport.as_ref()
    }

    pub(crate) fn into_transport_request(self) -> Option<V3Transport13ResponsesHttpRequest> {
        self.transport
    }

    pub fn provider_request_projection(&self) -> Option<Value> {
        self.transport
            .as_ref()
            .map(V3Transport13ResponsesHttpRequest::provider_request_projection)
    }

    pub fn provider_request_body(&self) -> Option<&Value> {
        self.transport
            .as_ref()
            .map(V3Transport13ResponsesHttpRequest::body)
    }
}

pub fn build_v3_provider_req_outbound_09_transport_from_wire(
    input: V3ProviderReqOutbound08WirePayload,
    provider_headers: Vec<V3ProviderRequestHeader>,
) -> Result<V3Transport13ResponsesHttpRequest, String> {
    let protocol = input.provider_protocol();
    let wire = input
        .provider_wire()
        .ok_or_else(|| "provider transport requires typed Provider12 wire output".to_string())?;
    let context = V3ProviderWireTransportContext::from_wire(wire);
    let input_body = wire.body().clone();
    let transport_output = Arc::new(Mutex::new(None));
    run_v3_single_node_operator(
        V3OperationGraph::Request,
        "construct_transport_request",
        input_body,
        ConstructTransportRequestOperator {
            protocol,
            context,
            provider_headers,
            transport_output: transport_output.clone(),
        },
    )
    .map_err(|error| error.to_string())?;
    let transport = transport_output
        .lock()
        .map_err(|_| "provider transport side-output holder is poisoned".to_string())?
        .take()
        .ok_or_else(|| "provider transport operator omitted typed side output".to_string())?;
    Ok(transport)
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
        build_v3_hub_req_target_06_from_v3_hub_req_execution_05,
        build_v3_provider_req_outbound_08_wire_from_compat_06, V3HubEntryProtocol,
        V3HubExecutionMode, V3HubInvocationSource, V3HubProviderWireProtocol,
        V3HubTargetResolution, V3HubTransportIntent,
    };
    use routecodex_v3_config::{
        V3ProviderRequestCleanupAuthoringConfig, V3ResponsesTransportKind, V3WebSearchExecutionMode,
    };
    use routecodex_v3_provider_responses::{
        V3ProviderAuthHandle, V3ProviderAuthSecretHandle, V3ResponsesProviderTarget,
        V3ResponsesStreamIntent,
    };
    use routecodex_v3_target::V3TargetCandidate;
    use serde_json::{json, Value};

    fn selected_candidate(provider_type: &str) -> V3TargetCandidate {
        V3TargetCandidate {
            provider_id: "selected-provider".to_string(),
            provider_type: provider_type.to_string(),
            interface_id: "default".to_string(),
            auth_alias: "primary".to_string(),
            model_id: "canonical-model".to_string(),
            wire_model: "wire-model".to_string(),
            visible_model_ids: vec!["client-model".to_string()],
            model_capabilities: vec!["text".to_string(), "tools".to_string()],
            web_search_execution_mode: V3WebSearchExecutionMode::None,
            model_availability: None,
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

    fn provider_target(selected: &V3TargetCandidate) -> V3ResponsesProviderTarget {
        V3ResponsesProviderTarget {
            provider_id: selected.provider_id.clone(),
            interface_id: selected.interface_id.clone(),
            provider_type: selected.provider_type.clone(),
            base_url: selected.base_url.clone(),
            canonical_model_id: selected.model_id.clone(),
            wire_model: selected.wire_model.clone(),
            compatibility_profile: selected.compatibility_profile.clone(),
            headers: selected.headers.clone(),
            auth: V3ProviderAuthHandle {
                alias: selected.auth_alias.clone(),
                secret: V3ProviderAuthSecretHandle::ApiKey("test-secret".to_string()),
            },
            responses_transport: selected.responses_transport,
            websocket_v2_url: selected.websocket_v2_url.clone(),
            provider_request_cleanup: selected.provider_request_cleanup.clone(),
            request_timeout_ms: selected.request_timeout_ms,
            sse_first_frame_timeout_ms: selected.sse_first_frame_timeout_ms,
            initial_concurrency_budget: selected.initial_concurrency_budget,
            concurrency_acquire_timeout_ms: selected.concurrency_acquire_timeout_ms,
        }
    }

    fn r08(
        payload: Value,
        selected: V3TargetCandidate,
        protocol: V3HubProviderWireProtocol,
    ) -> V3ProviderReqOutbound08WirePayload {
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
            selected.clone(),
        );
        let req07 = build_v3_hub_req_outbound_07_from_v3_hub_req_target_06(req06, protocol)
            .expect("standard provider request");
        let req_compat = build_provider_req_compat_06_from_v3_hub_req_outbound_07(req07)
            .expect("provider request compat")
            .node;
        build_v3_provider_req_outbound_08_wire_from_compat_06(
            req_compat,
            "r09-test",
            provider_target(&selected),
            Some(V3ResponsesStreamIntent::Json),
        )
        .expect("R08 wire")
        .0
    }

    #[test]
    fn construct_transport_request_consumes_sdk_body_for_responses() {
        let selected = selected_candidate("responses");
        let req08 = r08(
            json!({
                "model": "client-model",
                "messages": [{"role": "user", "content": "transport-body"}]
            }),
            selected,
            V3HubProviderWireProtocol::Responses,
        );
        let transport =
            build_v3_provider_req_outbound_09_transport_from_wire(req08, Vec::new()).unwrap();
        assert_eq!(transport.url(), "https://provider.invalid/v1/responses");
        assert_eq!(
            transport.body()["input"][0]["content"][0]["text"],
            "transport-body"
        );
        assert_eq!(transport.stream_intent(), V3ResponsesStreamIntent::Json);
        assert_eq!(
            transport.provider_request_projection()["body"],
            transport.body().clone()
        );
    }

    #[test]
    fn construct_transport_request_keeps_chat_url_and_provider_headers_typed() {
        let mut selected = selected_candidate("openai_chat");
        selected
            .headers
            .insert("x-provider-route".to_string(), "typed-header".to_string());
        let req08 = r08(
            json!({
                "model": "client-model",
                "messages": [{"role": "user", "content": "chat-body"}]
            }),
            selected,
            V3HubProviderWireProtocol::OpenAiChat,
        );
        let transport =
            build_v3_provider_req_outbound_09_transport_from_wire(req08, Vec::new()).unwrap();
        assert_eq!(
            transport.url(),
            "https://provider.invalid/v1/chat/completions"
        );
        assert_eq!(transport.body()["messages"][0]["content"], "chat-body");
        assert!(transport
            .provider_headers()
            .iter()
            .any(|header| header.name() == "x-provider-route" && header.value() == "typed-header"));
    }

    #[test]
    fn construct_transport_request_keeps_anthropic_headers_and_auth_typed() {
        let selected = selected_candidate("anthropic");
        let req08 = r08(
            json!({
                "model": "client-model",
                "messages": [{"role": "user", "content": "anthropic-body"}]
            }),
            selected,
            V3HubProviderWireProtocol::Anthropic,
        );
        let transport = build_v3_provider_req_outbound_09_transport_from_wire(
            req08,
            vec![V3ProviderRequestHeader::new(
                "anthropic-version",
                "2023-06-01",
            )],
        )
        .unwrap();
        assert_eq!(
            transport.url(),
            "https://provider.invalid/v1/v1/messages?beta=true"
        );
        assert_eq!(transport.provider_key(), "selected-provider:primary");
        assert!(transport
            .provider_headers()
            .iter()
            .any(|header| header.name() == "anthropic-version"));
        assert_eq!(
            transport.body()["messages"][0]["content"][0]["text"],
            "anthropic-body"
        );
    }

    #[test]
    fn construct_transport_request_preserves_stream_and_projection() {
        let selected = selected_candidate("responses");
        let req08 = r08(
            json!({
                "model": "client-model",
                "messages": [{"role": "user", "content": "stream-body"}],
                "stream": true
            }),
            selected,
            V3HubProviderWireProtocol::Responses,
        );
        let transport =
            build_v3_provider_req_outbound_09_transport_from_wire(req08, Vec::new()).unwrap();
        assert_eq!(transport.stream_intent(), V3ResponsesStreamIntent::Json);
        let projection = transport.provider_request_projection();
        assert_eq!(projection["method"], "POST");
        assert_eq!(projection["providerId"], "selected-provider");
        assert_eq!(projection["body"], transport.body().clone());
        assert_eq!(projection["streamIntent"], "json");
        assert!(!projection.to_string().contains("test-secret"));
    }

    #[test]
    fn construct_transport_request_consumes_sdk_input_not_captured_wire_body() {
        let selected = selected_candidate("responses");
        let req08 = r08(
            json!({
                "model": "client-model",
                "messages": [{"role": "user", "content": "failure-body"}]
            }),
            selected,
            V3HubProviderWireProtocol::Responses,
        );
        let wire = req08.provider_wire().unwrap();
        let context = V3ProviderWireTransportContext::from_wire(wire);
        let transport_output = Arc::new(Mutex::new(None));
        let output = run_v3_single_node_operator(
            V3OperationGraph::Request,
            "construct_transport_request",
            json!({"not": "the captured wire body"}),
            ConstructTransportRequestOperator {
                protocol: req08.provider_protocol(),
                context,
                provider_headers: Vec::new(),
                transport_output: transport_output.clone(),
            },
        )
        .expect("the SDK input, not a hidden wire body, is transport truth");
        let transport = transport_output.lock().unwrap().take().unwrap();
        assert_eq!(transport.body(), &json!({"not": "the captured wire body"}));
        assert_eq!(output["body"], *transport.body());
        assert!(req08.provider_wire().is_some());
    }

    #[test]
    fn construct_transport_request_requires_typed_wire_side_output() {
        let selected = selected_candidate("responses");
        let req08 = r08(
            json!({
                "model": "client-model",
                "messages": [{"role": "user", "content": "missing-wire"}]
            }),
            selected,
            V3HubProviderWireProtocol::Responses,
        );
        let legacy = super::super::build_v3_provider_req_outbound_08_from_provider_req_compat_06(
            req08.previous,
        );
        let error = build_v3_provider_req_outbound_09_transport_from_wire(legacy, Vec::new())
            .expect_err("transport creation must not invent a wire body");
        assert!(error.contains("typed Provider12 wire output"), "{error}");
    }

    #[test]
    fn construct_transport_request_keeps_gemini_framing_and_omits_body_model() {
        let selected = selected_candidate("gemini");
        let req08 = r08(
            json!({
                "model": "client-model",
                "messages": [{"role": "user", "content": "gemini-body"}]
            }),
            selected,
            V3HubProviderWireProtocol::Gemini,
        );
        let transport =
            build_v3_provider_req_outbound_09_transport_from_wire(req08, Vec::new()).unwrap();
        assert_eq!(
            transport.url(),
            "https://provider.invalid/v1/models/wire-model:generateContent"
        );
        assert!(transport.body().get("model").is_none());
    }

    #[test]
    fn construct_transport_request_preserves_compact_endpoint_from_wire() {
        let selected = selected_candidate("responses");
        let wire = routecodex_v3_provider_responses::wire::build_v3_provider_12_responses_compact_wire_payload(
            "r09-compact",
            provider_target(&selected),
            json!({
                "model": "wire-model",
                "input": [{"role": "user", "content": "compact-body"}]
            }),
        )
        .unwrap()
        .with_stream_intent(V3ResponsesStreamIntent::Json);
        let req08 = r08(
            json!({
                "model": "client-model",
                "messages": [{"role": "user", "content": "compact-body"}]
            }),
            selected,
            V3HubProviderWireProtocol::Responses,
        );
        let req08 = V3ProviderReqOutbound08WirePayload::from_test_parts(req08.previous, wire);
        let transport =
            build_v3_provider_req_outbound_09_transport_from_wire(req08, Vec::new()).unwrap();
        assert_eq!(
            transport.url(),
            "https://provider.invalid/v1/responses/compact"
        );
    }
}
