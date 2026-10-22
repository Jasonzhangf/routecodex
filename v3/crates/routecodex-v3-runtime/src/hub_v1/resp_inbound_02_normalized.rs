use super::{
    build_v3_provider_resp_inbound_01_raw_with_compat_profile,
    project_v3_anthropic_message_as_responses_response_with_context,
    ProviderRespCompat02ProviderCompat, V3AnthropicResponsesProjectionContext,
    V3HubProviderWireProtocol, V3HubResponseNormalizedKind, V3HubTransportIntent,
    V3ProviderCompatProfileId, V3ProviderRespInbound01Raw, V3ProviderRespInbound01RawContext,
};
use crate::operation_runner::{run_v3_single_node_operator, V3OperationGraph};
use pipeline_runtime::{Operator, OperatorContext, ValueType};
use serde_json::Value;
use std::sync::{Arc, Mutex};

const OPERATOR_NAME: &str = "routecodex.v3.operation.normalize_provider_response";
const OPERATOR_VERSION: &str = "1";

#[derive(Debug, Clone, PartialEq)]
pub struct V3HubRespInbound02Normalized {
    pub(crate) previous: ProviderRespCompat02ProviderCompat,
    pub(crate) normalized_kind: V3HubResponseNormalizedKind,
    pub(crate) semantic_protocol: V3HubProviderWireProtocol,
    pub(crate) source_terminal_reason: Option<String>,
    /// A genuine original Responses `status=completed` carries the source
    /// protocol's normal completion fact. It is typed provenance only, never
    /// written into client or provider payload. A canonical `completed`
    /// produced from a native Chat or Anthropic missing terminal does not set
    /// this witness.
    pub(crate) source_terminal_completed: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct NormalizeProviderResponseOutput {
    normalized_kind: V3HubResponseNormalizedKind,
    semantic_protocol: V3HubProviderWireProtocol,
}

struct NormalizeProviderResponseOperator {
    raw_context: V3ProviderRespInbound01RawContext,
    profile: V3ProviderCompatProfileId,
    projection_context: Option<V3AnthropicResponsesProjectionContext>,
    request_id: Option<String>,
    output: Arc<Mutex<Option<NormalizeProviderResponseOutput>>>,
}

impl Operator for NormalizeProviderResponseOperator {
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
        let raw = build_v3_provider_resp_inbound_01_raw_with_compat_profile(
            payload,
            self.raw_context.clone(),
        );
        let compat = ProviderRespCompat02ProviderCompat {
            previous: raw,
            profile: self.profile.clone(),
        };
        let mut normalized =
            normalize_provider_response_with_context(compat, self.projection_context.as_ref())?;
        if self.raw_context.provider_protocol == V3HubProviderWireProtocol::Gemini {
            if let Some(request_id) = self.request_id.as_deref() {
                normalized.normalize_gemini_business_response(request_id)?;
            }
        }
        let output = NormalizeProviderResponseOutput {
            normalized_kind: normalized.normalized_kind(),
            semantic_protocol: normalized.semantic_protocol(),
        };
        let payload = normalized.provider_payload().as_ref().clone();
        *self
            .output
            .lock()
            .map_err(|_| "response normalization output holder is poisoned".to_string())? =
            Some(output);
        Ok(payload)
    }
}

pub fn build_v3_hub_resp_inbound_02_from_provider_resp_compat_02(
    input: ProviderRespCompat02ProviderCompat,
) -> Result<V3HubRespInbound02Normalized, String> {
    // 禁止 expect panic 绕过错误链：malformed provider 响应必须经 caller
    // 显式传播（ErrorErr01 -> ... -> ErrorErr06），而不是 stack panic。
    build_v3_hub_resp_inbound_02_from_provider_resp_compat_02_with_chat_request(input, None)
}

pub fn build_v3_hub_resp_inbound_02_from_provider_resp_compat_02_with_chat_request(
    input: ProviderRespCompat02ProviderCompat,
    chat_request: Option<&Value>,
) -> Result<V3HubRespInbound02Normalized, String> {
    build_v3_hub_resp_inbound_02_from_provider_resp_compat_02_with_chat_request_and_request_id(
        input,
        chat_request,
        None,
    )
}

pub fn build_v3_hub_resp_inbound_02_from_provider_resp_compat_02_with_chat_request_and_request_id(
    mut input: ProviderRespCompat02ProviderCompat,
    chat_request: Option<&Value>,
    request_id: Option<&str>,
) -> Result<V3HubRespInbound02Normalized, String> {
    let projection_context = if input.raw().provider_protocol
        == V3HubProviderWireProtocol::Anthropic
        && input.raw().transport_intent == V3HubTransportIntent::Json
    {
        chat_request
            .map(V3AnthropicResponsesProjectionContext::from_chat_canonical_request)
            .transpose()
            .map_err(|error| error.to_string())?
    } else {
        None
    };
    let output = Arc::new(Mutex::new(None));
    let raw_context = V3ProviderRespInbound01RawContext {
        entry_protocol: input.raw().entry_protocol,
        provider_protocol: input.raw().provider_protocol,
        source_provider_protocol: input.raw().source_provider_protocol,
        execution: input.raw().execution,
        invocation_source: input.raw().invocation_source,
        transport_intent: input.raw().transport_intent,
        compatibility_profile: input.raw().compatibility_profile.clone(),
        opencode_zen_tcm_bridge: input.raw().opencode_zen_tcm_bridge.clone(),
        custom_tool_function_binding: input.raw().custom_tool_function_binding.clone(),
    };
    let profile = input.profile.clone();
    let source_terminal_reason = input
        .raw()
        .payload
        .0
        .get("stop_reason")
        .and_then(Value::as_str)
        .map(str::to_owned);
    let payload = run_v3_single_node_operator(
        V3OperationGraph::Response,
        "normalize_provider_response",
        input.raw().payload.0.as_ref().clone(),
        NormalizeProviderResponseOperator {
            raw_context,
            profile,
            projection_context,
            request_id: request_id.map(str::to_string),
            output: Arc::clone(&output),
        },
    )
    .map_err(|error| error.message)?;
    let output = output
        .lock()
        .map_err(|_| "response normalization output holder is poisoned".to_string())?
        .take()
        .ok_or_else(|| "response normalization operator produced no typed output".to_string())?;
    input.raw_mut().payload.0 = Arc::new(payload);
    let source_terminal_reason = source_terminal_reason.or_else(|| {
        (input.raw().provider_protocol == V3HubProviderWireProtocol::Gemini)
            .then(|| {
                input
                    .raw()
                    .payload
                    .0
                    .get("finishReason")
                    .and_then(Value::as_str)
                    .map(str::to_owned)
            })
            .flatten()
    });
    let source_terminal_completed = input.raw().provider_protocol
        == V3HubProviderWireProtocol::Responses
        && input.raw().payload.0.get("status").and_then(Value::as_str) == Some("completed");
    Ok(V3HubRespInbound02Normalized {
        source_terminal_reason,
        source_terminal_completed,
        previous: input,
        normalized_kind: output.normalized_kind,
        semantic_protocol: output.semantic_protocol,
    })
}

fn normalize_provider_response_with_context(
    mut input: ProviderRespCompat02ProviderCompat,
    projection_context: Option<&V3AnthropicResponsesProjectionContext>,
) -> Result<V3HubRespInbound02Normalized, String> {
    let source_terminal_reason = input
        .raw()
        .payload
        .0
        .get("stop_reason")
        .and_then(Value::as_str)
        .map(str::to_owned);
    let source_terminal_completed = input.raw().provider_protocol
        == V3HubProviderWireProtocol::Responses
        && input.raw().payload.0.get("status").and_then(Value::as_str) == Some("completed");
    let mut semantic_protocol = input.raw().provider_protocol;
    if input.raw().provider_protocol == V3HubProviderWireProtocol::Anthropic {
        match input.raw().transport_intent {
            // JSON：anthropic 响应在 Resp02 内投影为 responses canonical。
            V3HubTransportIntent::Json => {
                let default_context;
                let context = match projection_context {
                    Some(context) => context,
                    None => {
                        default_context = V3AnthropicResponsesProjectionContext::default();
                        &default_context
                    }
                };
                let canonical = project_v3_anthropic_message_as_responses_response_with_context(
                    input.raw().payload.0.as_ref(),
                    context,
                )
                .map_err(|error| error.to_string())?;
                input.raw_mut().payload.0 = Arc::new(canonical);
                semantic_protocol = V3HubProviderWireProtocol::Responses;
            }
            // SSE：ProviderRespCompat02 物化阶段已投影为 responses canonical，
            // semantic_protocol 必须随之标记，raw 保留 anthropic wire 事实。
            V3HubTransportIntent::Sse => {
                semantic_protocol = V3HubProviderWireProtocol::Responses;
            }
        }
    }
    let normalized_kind = match input.raw().transport_intent {
        V3HubTransportIntent::Json => V3HubResponseNormalizedKind::Json,
        V3HubTransportIntent::Sse => V3HubResponseNormalizedKind::Sse,
    };
    Ok(V3HubRespInbound02Normalized {
        source_terminal_reason,
        source_terminal_completed,
        previous: input,
        normalized_kind,
        semantic_protocol,
    })
}

impl V3HubRespInbound02Normalized {
    pub(crate) fn normalize_gemini_business_response(
        &mut self,
        request_id: &str,
    ) -> Result<(), String> {
        let canonical = super::gemini_responses_codec::project_gemini_response(
            self.provider_payload(),
            request_id,
        )?;
        self.set_responses_semantic_payload(canonical);
        Ok(())
    }
    pub fn provider_raw(&self) -> &V3ProviderRespInbound01Raw {
        self.previous.raw()
    }

    pub(crate) fn provider_raw_mut(&mut self) -> &mut V3ProviderRespInbound01Raw {
        self.previous.raw_mut()
    }

    pub(crate) fn provider_payload(&self) -> &Arc<Value> {
        &self.provider_raw().payload.0
    }

    pub(crate) fn provider_payload_mut(&mut self) -> &mut Arc<Value> {
        &mut self.provider_raw_mut().payload.0
    }

    pub fn normalized_kind(&self) -> V3HubResponseNormalizedKind {
        self.normalized_kind
    }

    /// RespInbound02 retains the selected provider protocol on `provider_raw`
    /// while exposing the protocol of its canonical response semantic payload.
    pub(crate) fn semantic_protocol(&self) -> V3HubProviderWireProtocol {
        self.semantic_protocol
    }

    /// 跨协议 canonical 转换（openai_chat -> responses）必须原子替换 payload 与
    /// `semantic_protocol`，保证 Resp03 分派键与 payload 形状永不失配。
    pub(crate) fn set_responses_semantic_payload(&mut self, payload: Value) {
        *self.provider_payload_mut() = Arc::new(payload);
        self.semantic_protocol = V3HubProviderWireProtocol::Responses;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn compat(
        payload: Value,
        provider_protocol: V3HubProviderWireProtocol,
    ) -> ProviderRespCompat02ProviderCompat {
        let input = super::super::build_v3_provider_resp_inbound_01_raw(
            payload,
            super::super::V3HubEntryProtocol::Responses,
            provider_protocol,
            super::super::V3HubExecutionMode::Relay,
            super::super::V3HubInvocationSource::Client,
            V3HubTransportIntent::Json,
        );
        super::super::build_provider_resp_compat_02_from_v3_provider_resp_inbound_01(input).unwrap()
    }

    #[test]
    fn canonical_normalize_node_projects_anthropic_json_with_the_request_context() {
        let normalized =
            build_v3_hub_resp_inbound_02_from_provider_resp_compat_02_with_chat_request_and_request_id(
                compat(
                    json!({
                        "id": "msg_sdk",
                        "type": "message",
                        "role": "assistant",
                        "content": [{"type": "text", "text": "anthropic sdk"}],
                        "stop_reason": "end_turn",
                        "usage": {"input_tokens": 3, "output_tokens": 2}
                    }),
                    V3HubProviderWireProtocol::Anthropic,
                ),
                Some(&json!({
                    "model": "gpt-5",
                    "messages": [],
                    "routecodex_chat_extension": {
                        "responses_request": {
                            "metadata": {"trace_id": "sdk-context"}
                        }
                    }
                })),
                None,
            )
            .unwrap();

        assert_eq!(
            normalized.semantic_protocol(),
            V3HubProviderWireProtocol::Responses
        );
        assert_eq!(
            normalized.provider_raw().provider_protocol,
            V3HubProviderWireProtocol::Anthropic
        );
        assert_eq!(
            normalized.normalized_kind(),
            V3HubResponseNormalizedKind::Json
        );
        assert_eq!(
            normalized.provider_payload()["metadata"]["trace_id"],
            "sdk-context"
        );
        assert_eq!(
            normalized.provider_payload()["output"][0]["content"][0]["text"],
            "anthropic sdk"
        );
    }

    #[test]
    fn non_anthropic_normalization_does_not_parse_anthropic_projection_context() {
        let payload =
            json!({"id":"chat-sdk","choices":[{"message":{"role":"assistant","content":"ok"}}]});
        let request = json!({"routecodex_chat_extension":{"responses_request":{"metadata":"opaque-to-chat"}}});
        let normalized =
            build_v3_hub_resp_inbound_02_from_provider_resp_compat_02_with_chat_request(
                compat(payload.clone(), V3HubProviderWireProtocol::OpenAiChat),
                Some(&request),
            )
            .expect(
                "Chat normalization must not admit through an unrelated Anthropic context parser",
            );
        assert_eq!(normalized.provider_payload().as_ref(), &payload);
        assert_eq!(
            normalized.semantic_protocol(),
            V3HubProviderWireProtocol::OpenAiChat
        );
    }

    #[test]
    fn canonical_normalize_node_executes_gemini_business_normalization_once() {
        let normalized =
            build_v3_hub_resp_inbound_02_from_provider_resp_compat_02_with_chat_request_and_request_id(
                compat(
                    json!({
                        "responseId": "gemini_sdk",
                        "candidates": [{
                            "index": 0,
                            "content": {
                                "role": "model",
                                "parts": [{"text": "gemini sdk"}]
                            },
                            "finishReason": "STOP"
                        }],
                        "usageMetadata": {
                            "promptTokenCount": 4,
                            "candidatesTokenCount": 2,
                            "totalTokenCount": 6
                        }
                    }),
                    V3HubProviderWireProtocol::Gemini,
                ),
                None,
                Some("req_gemini_sdk"),
            )
            .unwrap();

        assert_eq!(
            normalized.semantic_protocol(),
            V3HubProviderWireProtocol::Responses
        );
        assert_eq!(
            normalized.provider_raw().provider_protocol,
            V3HubProviderWireProtocol::Gemini
        );
        assert_eq!(
            normalized.provider_raw().transport_intent,
            V3HubTransportIntent::Json
        );
        assert_eq!(normalized.provider_payload()["object"], "response");
        assert_eq!(normalized.source_terminal_reason.as_deref(), Some("STOP"));
        assert_eq!(
            normalized.provider_payload()["output"][0]["content"][0]["text"],
            "gemini sdk"
        );
    }
}
