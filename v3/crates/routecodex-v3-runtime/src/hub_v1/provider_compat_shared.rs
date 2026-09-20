use super::V3HubProviderWireProtocol;
use routecodex_v3_provider_responses::{
    build_v3_transport_13_responses_http_request_from_parts_with_timeout_and_concurrency,
    build_v3_transport_13_responses_http_request_from_v3_provider_12,
    V3Provider12ResponsesWirePayload, V3ProviderRequestHeader, V3ResponsesProviderTarget,
    V3Transport13ResponsesHttpRequest,
};
use std::time::Duration;

pub(crate) fn provider_protocol_compat_id(protocol: V3HubProviderWireProtocol) -> String {
    match protocol {
        V3HubProviderWireProtocol::Responses => "openai-responses",
        V3HubProviderWireProtocol::Anthropic => "anthropic-messages",
        V3HubProviderWireProtocol::Gemini => "gemini-chat",
        V3HubProviderWireProtocol::OpenAiChat => "openai-chat",
    }
    .to_string()
}

pub(crate) fn provider_wire_protocol_for_provider_type(
    provider_id: &str,
    provider_type: &str,
) -> Result<V3HubProviderWireProtocol, String> {
    match provider_type.trim() {
        "responses" | "openai_responses" | "openai-responses" => {
            Ok(V3HubProviderWireProtocol::Responses)
        }
        "anthropic" | "anthropic_messages" | "anthropic-messages" => {
            Ok(V3HubProviderWireProtocol::Anthropic)
        }
        "openai_chat"
        | "openai-chat"
        | "openai_chat_completions"
        | "openai-chat-completions"
        | "chat_completions"
        | "chat-completions" => Ok(V3HubProviderWireProtocol::OpenAiChat),
        "gemini" | "gemini_chat" | "gemini-chat" => Ok(V3HubProviderWireProtocol::Gemini),
        other => Err(format!(
            "selected unsupported provider wire protocol: provider={provider_id} type={other}"
        )),
    }
}

pub(crate) fn provider_wire_protocol_for_selected_candidate(
    selected: &routecodex_v3_target::V3TargetCandidate,
) -> Result<V3HubProviderWireProtocol, String> {
    provider_wire_protocol_for_provider_type(&selected.provider_id, &selected.provider_type)
}

pub(crate) fn anthropic_messages_url(base_url: &str) -> String {
    format!("{}/v1/messages?beta=true", base_url.trim_end_matches('/'))
}

pub(crate) fn build_v3_anthropic_messages_transport_request_from_v3_provider_08(
    wire: V3Provider12ResponsesWirePayload,
) -> Result<V3Transport13ResponsesHttpRequest, String> {
    build_v3_anthropic_messages_transport_request_from_v3_provider_08_with_provider_headers(
        wire,
        Vec::new(),
    )
}

pub(crate) fn build_v3_anthropic_messages_transport_request_from_v3_provider_08_with_provider_headers(
    wire: V3Provider12ResponsesWirePayload,
    provider_headers: Vec<V3ProviderRequestHeader>,
) -> Result<V3Transport13ResponsesHttpRequest, String> {
    let request_id = wire.request_id().to_string();
    let target = wire.target().clone();
    let stream_intent = wire.stream_intent();
    let body = wire.body().clone();
    let timeout = Some(Duration::from_millis(target.request_timeout_ms));
    let url_text = anthropic_messages_url(&target.base_url);
    if provider_headers.is_empty() {
        return build_v3_transport_13_responses_http_request_from_parts_with_timeout_and_concurrency(
            request_id,
            target.provider_id,
            url_text,
            target.auth,
            stream_intent,
            body,
            Vec::new(),
            timeout,
            target.concurrency_acquire_timeout_ms,
        )
        .map_err(|error| error.to_string());
    }
    build_v3_transport_13_responses_http_request_from_parts_with_timeout_and_concurrency(
        request_id,
        target.provider_id,
        url_text,
        target.auth,
        stream_intent,
        body,
        provider_headers,
        timeout,
        target.concurrency_acquire_timeout_ms,
    )
    .map_err(|error| error.to_string())
}

pub(crate) fn build_v3_provider_transport_request_for_protocol(
    provider_protocol: V3HubProviderWireProtocol,
    wire: V3Provider12ResponsesWirePayload,
) -> Result<V3Transport13ResponsesHttpRequest, String> {
    match provider_protocol {
        V3HubProviderWireProtocol::Responses => {
            build_v3_transport_13_responses_http_request_from_v3_provider_12(wire)
                .map_err(|error| error.to_string())
        }
        V3HubProviderWireProtocol::OpenAiChat => {
            build_v3_openai_chat_transport_request_from_v3_provider_08(wire)
        }
        V3HubProviderWireProtocol::Anthropic => {
            build_v3_anthropic_messages_transport_request_from_v3_provider_08(wire)
                .map_err(|error| error.to_string())
        }
        V3HubProviderWireProtocol::Gemini => Err(
            "selected provider wire protocol gemini has no registered HTTP transport builder"
                .to_string(),
        ),
    }
}

fn build_v3_openai_chat_transport_request_from_v3_provider_08(
    wire: V3Provider12ResponsesWirePayload,
) -> Result<V3Transport13ResponsesHttpRequest, String> {
    let request_id = wire.request_id().to_string();
    let target = wire.target().clone();
    let stream_intent = wire.stream_intent();
    let mut body = wire.body().clone();
    if is_v3_deepseek_reasoning_target(&target.canonical_model_id) {
        provider_compat_core::apply_deepseek_v4_thinking_chat_compat(&mut body);
    }
    if is_v3_deepseek_v4_compat_target(&target) {
        provider_compat_core::apply_deepseek_function_call_arguments_compat(&mut body);
    }
    let url_text = format!("{}/chat/completions", target.base_url.trim_end_matches('/'));
    build_v3_transport_13_responses_http_request_from_parts_with_timeout_and_concurrency(
        request_id,
        target.provider_id,
        url_text,
        target.auth,
        stream_intent,
        body,
        Vec::new(),
        Some(Duration::from_millis(target.request_timeout_ms)),
        target.concurrency_acquire_timeout_ms,
    )
    .map_err(|error| error.to_string())
}

/// opencode 对 DeepSeek 系模型的标准 reasoning 回传处理（transform.ts interleaved）：
/// DeepSeek 上游要求**每条 assistant 消息都必须携带 `reasoning_content`**——即使本轮没有
/// 明文 reasoning 也要回传空字符串（"DeepSeek may return empty reasoning_content which
/// still needs to be sent back"）。缺失该字段会触发上游 400：
/// `The reasoning_content in the thinking mode must be passed back to the API`。
/// 只补缺失字段：已有 reasoning_content（明文或空占位）的消息保持不变。
fn is_v3_deepseek_reasoning_target(canonical_model_id: &str) -> bool {
    canonical_model_id.to_ascii_lowercase().contains("deepseek")
}

fn is_v3_deepseek_v4_compat_target(target: &V3ResponsesProviderTarget) -> bool {
    matches!(
        target.compatibility_profile.as_deref(),
        Some("chat:deepseek-max" | "responses:deepseek-console-go")
    ) || target.canonical_model_id == "deepseek-v4-flash"
        || target.wire_model == "deepseek-v4-flash"
}

/// gpt 目标判定（请求侧路由决策）：canonical model id 以 `gpt-` 开头（OpenAI 官方
/// gpt-5.x，Codex 客户端用自己的密文重建 reasoning 历史）。判定真源委托
/// config 内部配置层模型家族判定，compat 只保留语义包装不重复实现。
pub(crate) fn is_v3_gpt_canonical_model(model_id: &str) -> bool {
    routecodex_v3_config::internal::is_v3_gpt_family_model(model_id)
}

/// 请求侧 VR 路由决策统一判定"是否保留响应密文"：仅当目标是 gpt 模型**且**该模型
/// 只有单一 provider 候选时保留（Codex 客户端需要官方密文重建 reasoning 历史；
/// 跨 provider 或非 gpt 场景一律 Resp03 剥离）。该标记在 VR 初始化时算一次，
/// 写入响应侧 profile，响应侧只消费此结果，不重复判定。
pub(crate) fn is_v3_retain_response_cipher(target_plan_len: usize, model_id: &str) -> bool {
    target_plan_len == 1 && is_v3_gpt_canonical_model(model_id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use routecodex_v3_config::V3ResponsesTransportKind;
    use routecodex_v3_provider_responses::{
        build_v3_provider_12_responses_wire_payload, V3ProviderAuthHandle,
        V3ProviderAuthSecretHandle,
    };
    use serde_json::json;

    #[test]
    fn unrelated_deepseek_model_keeps_malformed_arguments_at_openai_chat_transport() {
        let target = V3ResponsesProviderTarget {
            provider_id: "unrelated-deepseek".into(),
            provider_type: "openai_chat".into(),
            base_url: "http://upstream.invalid/v1".into(),
            canonical_model_id: "deepseek-v5-preview".into(),
            wire_model: "deepseek-v5-preview".into(),
            compatibility_profile: None,
            auth: V3ProviderAuthHandle {
                alias: "primary".into(),
                secret: V3ProviderAuthSecretHandle::Environment("DEEPSEEK_KEY".into()),
            },
            responses_transport: V3ResponsesTransportKind::Http,
            websocket_v2_url: None,
            provider_request_cleanup: Default::default(),
            request_timeout_ms: 300_000,
            sse_first_frame_timeout_ms: None,
            initial_concurrency_budget: 8,
        };
        let wire = build_v3_provider_12_responses_wire_payload(
            "req-unrelated-deepseek-arguments",
            target,
            json!({
                "model": "deepseek-v5-preview",
                "messages": [{
                    "role": "assistant",
                    "tool_calls": [{
                        "id": "call_1",
                        "type": "function",
                        "function": {"name": "exec_command", "arguments": "{\"cmd\":\"pwd\""}
                    }]
                }]
            }),
        )
        .unwrap();
        let request = build_v3_openai_chat_transport_request_from_v3_provider_08(wire).unwrap();
        assert_eq!(
            request.body()["messages"][0]["tool_calls"][0]["function"]["arguments"],
            "{\"cmd\":\"pwd\""
        );
    }
}
