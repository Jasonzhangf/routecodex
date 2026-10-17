use super::V3HubRespChatProcess03Governed;
use crate::operation_runner::{
    run_v3_single_node_operator, OperationRunnerError, V3OperationGraph,
};
use pipeline_runtime::{Operator, OperatorContext, ValueType};
use serde_json::Value;
use std::sync::Arc;

const OPERATOR_NAME: &str = "routecodex.v3.operation.inverse_project_client_response";
const OPERATOR_VERSION: &str = "1";
const INVERSE_PROJECT_CLIENT_RESPONSE_NODE_ID: &str = "inverse_project_client_response";

#[derive(Debug, Clone, PartialEq)]
pub struct V3HubRespOutbound05ClientSemantic {
    pub(crate) previous: V3HubRespChatProcess03Governed,
    pub(crate) client_payload: Arc<Value>,
}

struct InverseProjectClientResponseOperator<F> {
    projector: F,
}

impl<F> Operator for InverseProjectClientResponseOperator<F>
where
    F: Fn(Value) -> Result<Value, String> + Send + Sync,
{
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
        (self.projector)(payload)
    }
}

impl V3HubRespOutbound05ClientSemantic {
    /// 05 节点的 client semantic payload（按入口协议投影后的客户端语义）。
    pub(crate) fn client_payload(&self) -> &Value {
        self.client_payload.as_ref()
    }
}

/// 标准 05 构建器：client_payload 由 Resp03 governed 投影（对 Responses 协议为 identity）。
pub fn build_v3_hub_resp_outbound_05_from_v3_hub_resp_chat_process_03(
    input: V3HubRespChatProcess03Governed,
) -> V3HubRespOutbound05ClientSemantic {
    let client_payload = Arc::new(input.provider_payload().clone());
    V3HubRespOutbound05ClientSemantic {
        previous: input,
        client_payload,
    }
}

pub(crate) fn try_build_v3_hub_resp_outbound_05_from_v3_hub_resp_chat_process_03_with_projector<F>(
    input: V3HubRespChatProcess03Governed,
    projector: F,
) -> Result<V3HubRespOutbound05ClientSemantic, OperationRunnerError>
where
    F: Fn(Value) -> Result<Value, String> + Send + Sync + 'static,
{
    let client_payload = run_v3_single_node_operator(
        V3OperationGraph::Response,
        INVERSE_PROJECT_CLIENT_RESPONSE_NODE_ID,
        input.provider_payload().clone(),
        InverseProjectClientResponseOperator { projector },
    )?;
    Ok(V3HubRespOutbound05ClientSemantic {
        previous: input,
        client_payload: Arc::new(client_payload),
    })
}

/// 受控 client_payload 注入构建器（仅 crate 内、仅相邻 client projection 使用）。
///
/// 唯一合法输入：Resp03 governed 经相邻 05 入口协议投影（如 Anthropic message/events
/// 投影）后的结果；禁止从 provider raw 或未治理 payload 构造。调用方必须保证
/// `client_payload` 是由 `input.provider_payload()` 派生的相邻投影产物，
/// 不得绕过 03 治理。
pub(crate) fn build_v3_hub_resp_outbound_05_from_v3_hub_resp_chat_process_03_with_client_payload(
    input: V3HubRespChatProcess03Governed,
    client_payload: Value,
) -> V3HubRespOutbound05ClientSemantic {
    V3HubRespOutbound05ClientSemantic {
        previous: input,
        client_payload: Arc::new(client_payload),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hub_v1::{
        build_provider_resp_compat_02_from_v3_provider_resp_inbound_01,
        build_v3_hub_resp_chat_process_03_from_v3_hub_resp_inbound_02,
        build_v3_hub_resp_inbound_02_from_provider_resp_compat_02,
        build_v3_provider_resp_inbound_01_raw, gemini_responses_codec, V3HubEntryProtocol,
        V3HubExecutionMode, V3HubInvocationSource, V3HubProviderWireProtocol, V3HubTransportIntent,
    };
    use serde_json::json;

    fn governed_response(payload: Value) -> V3HubRespChatProcess03Governed {
        let raw = build_v3_provider_resp_inbound_01_raw(
            payload,
            V3HubEntryProtocol::Responses,
            V3HubProviderWireProtocol::Responses,
            V3HubExecutionMode::Direct,
            V3HubInvocationSource::Client,
            V3HubTransportIntent::Json,
        );
        let compat = build_provider_resp_compat_02_from_v3_provider_resp_inbound_01(raw)
            .expect("response compat must preserve the test payload");
        let normalized = build_v3_hub_resp_inbound_02_from_provider_resp_compat_02(compat)
            .expect("response normalization must preserve the test payload");
        build_v3_hub_resp_chat_process_03_from_v3_hub_resp_inbound_02(normalized)
    }

    #[test]
    fn projector_operator_runs_the_real_gemini_consumer_on_sdk_payload() {
        let input = governed_response(json!({
            "id": "resp_inverse",
            "status": "completed",
            "opaque_root": {"keep": [1, {"nested": null}]},
            "output": [
                {
                    "type": "message",
                    "content": [
                        {"type": "output_text", "text": "hello", "opaque_part": {"keep": true}}
                    ]
                },
                {
                    "type": "function_call",
                    "call_id": "call_inverse",
                    "namespace": "namespace_inverse",
                    "name": "tool",
                    "arguments": "broken json",
                    "opaque_tool": {"keep": true}
                }
            ]
        }));

        let output =
            try_build_v3_hub_resp_outbound_05_from_v3_hub_resp_chat_process_03_with_projector(
                input,
                |payload| {
                    gemini_responses_codec::project_responses_to_gemini_client(
                        &payload,
                        V3HubProviderWireProtocol::Responses,
                    )
                },
            )
            .expect("the real projector must produce the SDK client payload");

        assert_eq!(
            output.client_payload(),
            &json!({
                "opaque_root": {"keep": [1, {"nested": null}]},
                "responseId": "resp_inverse",
                "candidates": [{
                    "content": {
                        "role": "model",
                        "parts": [
                            {"text": "hello", "opaque_part": {"keep": true}},
                            {
                                "functionCall": {
                                    "id": "call_inverse",
                                    "namespace": "namespace_inverse",
                                    "name": "tool",
                                    "args": "broken json",
                                    "opaque_tool": {"keep": true}
                                }
                            }
                        ]
                    },
                    "finishReason": "STOP"
                }]
            })
        );
    }

    #[test]
    fn projector_error_remains_an_error() {
        let input = governed_response(json!({"status": "completed", "output": []}));
        let error =
            try_build_v3_hub_resp_outbound_05_from_v3_hub_resp_chat_process_03_with_projector(
                input,
                |_| Err("projector rejected payload".to_string()),
            )
            .unwrap_err();

        assert!(
            error.message.contains("projector rejected payload"),
            "{error}"
        );
    }
}
