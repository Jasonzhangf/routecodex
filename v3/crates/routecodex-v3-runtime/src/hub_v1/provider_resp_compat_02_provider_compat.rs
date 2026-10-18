use super::{
    classify_v3_provider_compat_error, provider_protocol_compat_id, V3HubResponsePayload,
    V3ProviderCompatError, V3ProviderCompatProfileId, V3ProviderRespInbound01Raw,
};
use crate::operation_runner::{run_v3_single_node_operator, V3OperationGraph};
use pipeline_runtime::{Operator, OperatorContext, ValueType};
use provider_compat_core::opencode_zen_tcm::{
    apply_opencode_zen_tcm_response, PROFILE as OPENCODE_ZEN_TCM_PROFILE,
};
use provider_compat_core::req_outbound_stage3_compat::{
    run_resp_inbound_stage3_compat, AdapterContext, ReqOutboundCompatInput,
};
use serde_json::Value;
use std::sync::Arc;

const OPERATOR_NAME: &str = "routecodex.v3.operation.adjust_provider_private_response";
const OPERATOR_VERSION: &str = "1";

#[derive(Debug, Clone, PartialEq)]
pub struct ProviderRespCompat02ProviderCompat {
    pub(crate) previous: V3ProviderRespInbound01Raw,
    pub(crate) profile: V3ProviderCompatProfileId,
}

struct AdjustProviderPrivateResponseOperator {
    input: V3ProviderRespInbound01Raw,
    profile: V3ProviderCompatProfileId,
}

impl Operator for AdjustProviderPrivateResponseOperator {
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

    fn execute(&self, payload: Value, _: &OperatorContext) -> Result<Value, String> {
        let mut input = self.input.clone();
        input.payload = V3HubResponsePayload(Arc::new(payload));
        apply_v3_provider_resp_compat(&input, &self.profile).map_err(|error| error.reason)
    }
}

pub fn build_provider_resp_compat_02_from_v3_provider_resp_inbound_01(
    mut input: V3ProviderRespInbound01Raw,
) -> Result<ProviderRespCompat02ProviderCompat, V3ProviderCompatError> {
    let profile = input.compatibility_profile.clone();
    let payload = run_v3_single_node_operator(
        V3OperationGraph::Response,
        "adjust_provider_private_response",
        input.payload.0.as_ref().clone(),
        AdjustProviderPrivateResponseOperator {
            input: input.clone(),
            profile: profile.clone(),
        },
    )
    .map_err(|error| classify_v3_provider_compat_error("response", &profile, error.message))?;
    input.payload = V3HubResponsePayload(Arc::new(payload));
    Ok(ProviderRespCompat02ProviderCompat {
        previous: input,
        profile,
    })
}

pub async fn build_provider_resp_compat_02_from_v3_provider_resp_inbound_01_sse(
    mut input: V3ProviderRespInbound01Raw,
) -> Result<ProviderRespCompat02ProviderCompat, V3ProviderCompatError> {
    let provider_protocol = input.provider_protocol;
    let chunks = input.take_raw_sse_chunks().ok_or_else(|| {
        classify_v3_provider_compat_error(
            "response",
            &input.compatibility_profile,
            "ProviderRespInbound01Raw missing SSE chunks".to_string(),
        )
    })?;
    let provider = Box::pin(futures_util::stream::iter(chunks.into_iter().map(Ok)));
    let payload =
        super::responses_relay_runtime::materialize_v3_provider_sse_as_canonical_response(
            provider_protocol,
            provider,
        )
        .await
        .map_err(|error| {
            classify_v3_provider_compat_error(
                "response",
                &input.compatibility_profile,
                error.to_string(),
            )
        })?;
    input.payload = V3HubResponsePayload(Arc::new(payload));
    build_provider_resp_compat_02_from_v3_provider_resp_inbound_01(input)
}

impl ProviderRespCompat02ProviderCompat {
    pub fn profile(&self) -> &V3ProviderCompatProfileId {
        &self.profile
    }

    pub(crate) fn raw(&self) -> &V3ProviderRespInbound01Raw {
        &self.previous
    }

    pub(crate) fn raw_mut(&mut self) -> &mut V3ProviderRespInbound01Raw {
        &mut self.previous
    }
}

fn apply_v3_provider_resp_compat(
    input: &V3ProviderRespInbound01Raw,
    profile: &V3ProviderCompatProfileId,
) -> Result<Value, V3ProviderCompatError> {
    let mut payload = run_resp_inbound_stage3_compat(ReqOutboundCompatInput {
        payload: input.payload.0.as_ref().clone(),
        adapter_context: AdapterContext {
            compatibility_profile: profile.as_optional_string(),
            provider_protocol: Some(provider_protocol_compat_id(input.provider_protocol)),
            custom_tool_function_binding: input.custom_tool_function_binding.clone(),
            ..Default::default()
        },
        explicit_profile: profile.as_optional_string(),
    })
    .map(|result| result.payload)
    .map_err(|reason| classify_v3_provider_compat_error("response", profile, reason))?;
    if profile
        .as_str()
        .eq_ignore_ascii_case(OPENCODE_ZEN_TCM_PROFILE)
        && input.entry_protocol == super::V3HubEntryProtocol::Responses
        && input.provider_protocol == super::V3HubProviderWireProtocol::OpenAiChat
        && input.execution == super::V3HubExecutionMode::Relay
    {
        if let Some(binding) = &input.opencode_zen_tcm_bridge {
            apply_opencode_zen_tcm_response(&mut payload, binding);
        }
    }
    Ok(payload)
}

#[cfg(test)]
mod tests {
    use super::*;
    use provider_compat_core::{
        compile_custom_tool_function_binding, CUSTOM_TOOL_FUNCTION_PROFILE,
    };
    use serde_json::json;

    #[test]
    fn canonical_adjust_node_executes_the_real_custom_tool_response_compat() {
        let binding = compile_custom_tool_function_binding(&json!({
            "tools": [{"type": "custom", "name": "apply_patch"}]
        }));
        let wire_name = binding
            .wire_name_for("apply_patch")
            .expect("custom tool binding must expose its provider wire name");
        let input = super::super::build_v3_provider_resp_inbound_01_raw_with_compat_profile(
            json!({
                "output": [{
                    "type": "function_call",
                    "call_id": "call_sdk",
                    "name": wire_name,
                    "arguments": "{\"input\":\"patch\"}"
                }]
            }),
            super::super::V3ProviderRespInbound01RawContext::new(
                super::super::V3HubEntryProtocol::Responses,
                super::super::V3HubProviderWireProtocol::Responses,
                super::super::V3HubExecutionMode::Relay,
                super::super::V3HubInvocationSource::Client,
                super::super::V3HubTransportIntent::Json,
            )
            .with_compatibility_profile(Some(CUSTOM_TOOL_FUNCTION_PROFILE))
            .with_custom_tool_function_binding(Some(binding)),
        );

        let output = build_provider_resp_compat_02_from_v3_provider_resp_inbound_01(input).unwrap();
        let payload = output.raw().payload.0.as_ref();

        assert_eq!(output.profile().as_str(), CUSTOM_TOOL_FUNCTION_PROFILE);
        assert_eq!(payload["output"][0]["type"], "custom_tool_call");
        assert_eq!(payload["output"][0]["name"], "apply_patch");
        assert_eq!(payload["output"][0]["input"], "patch");
    }

    #[test]
    fn canonical_adjust_node_preserves_typed_compat_failure_classification() {
        let input = super::super::build_v3_provider_resp_inbound_01_raw(
            json!({
                "object": "response",
                "output": [],
                "semantics": {"control": true}
            }),
            super::super::V3HubEntryProtocol::Responses,
            super::super::V3HubProviderWireProtocol::Responses,
            super::super::V3HubExecutionMode::Relay,
            super::super::V3HubInvocationSource::Client,
            super::super::V3HubTransportIntent::Json,
        );

        let error =
            build_provider_resp_compat_02_from_v3_provider_resp_inbound_01(input).unwrap_err();

        assert_eq!(
            error.classification(),
            super::super::V3ProviderCompatErrorClassification::PayloadBoundaryViolation
        );
        assert!(error.reason.contains("field=semantics"));
    }
}
