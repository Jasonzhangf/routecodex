use super::{
    project_v3_anthropic_message_as_responses_response_with_context,
    ProviderRespCompat02ProviderCompat, V3AnthropicResponsesProjectionContext,
    V3HubProviderWireProtocol, V3HubResponseNormalizedKind, V3HubTransportIntent,
    V3ProviderRespInbound01Raw,
};
use serde_json::Value;
use std::sync::Arc;

#[derive(Debug, Clone, PartialEq)]
pub struct V3HubRespInbound02Normalized {
    pub(crate) previous: ProviderRespCompat02ProviderCompat,
    pub(crate) normalized_kind: V3HubResponseNormalizedKind,
    pub(crate) semantic_protocol: V3HubProviderWireProtocol,
}

pub fn build_v3_hub_resp_inbound_02_from_provider_resp_compat_02(
    input: ProviderRespCompat02ProviderCompat,
) -> Result<V3HubRespInbound02Normalized, String> {
    // 禁止 expect panic 绕过错误链：malformed provider 响应必须经 caller
    // 显式传播（ErrorErr01 -> ... -> ErrorErr06），而不是 stack panic。
    build_v3_hub_resp_inbound_02_from_provider_resp_compat_02_with_chat_request(input, None)
}

pub fn build_v3_hub_resp_inbound_02_from_provider_resp_compat_02_with_chat_request(
    mut input: ProviderRespCompat02ProviderCompat,
    chat_request: Option<&Value>,
) -> Result<V3HubRespInbound02Normalized, String> {
    let mut semantic_protocol = input.raw().provider_protocol;
    if input.raw().provider_protocol == V3HubProviderWireProtocol::Anthropic {
        match input.raw().transport_intent {
            // JSON：anthropic 响应在 Resp02 内投影为 responses canonical。
            V3HubTransportIntent::Json => {
                let context = match chat_request {
                    Some(request) => {
                        V3AnthropicResponsesProjectionContext::from_chat_canonical_request(request)
                            .map_err(|error| error.to_string())?
                    }
                    None => V3AnthropicResponsesProjectionContext::default(),
                };
                let canonical = project_v3_anthropic_message_as_responses_response_with_context(
                    input.raw().payload.0.as_ref(),
                    &context,
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
        previous: input,
        normalized_kind,
        semantic_protocol,
    })
}

impl V3HubRespInbound02Normalized {
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
