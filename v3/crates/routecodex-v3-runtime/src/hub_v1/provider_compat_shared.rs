use super::V3HubProviderWireProtocol;
use routecodex_v3_provider_responses::{
    build_v3_transport_13_responses_http_request_from_parts_with_timeout_and_concurrency,
    build_v3_transport_13_responses_request_from_wire_parts, V3Provider12ResponsesWirePayload,
    V3ProviderRequestHeader, V3ResponsesProviderTarget, V3ResponsesRequestEndpoint,
    V3ResponsesStreamIntent, V3Transport13ResponsesHttpRequest,
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
    build_v3_provider_transport_request_from_parts(
        V3HubProviderWireProtocol::Anthropic,
        V3ProviderWireTransportContext::from_wire(&wire),
        wire.body().clone(),
        provider_headers,
    )
}

pub(crate) fn build_v3_provider_transport_request_for_protocol(
    provider_protocol: V3HubProviderWireProtocol,
    wire: V3Provider12ResponsesWirePayload,
) -> Result<V3Transport13ResponsesHttpRequest, String> {
    build_v3_provider_transport_request_from_parts(
        provider_protocol,
        V3ProviderWireTransportContext::from_wire(&wire),
        wire.body().clone(),
        Vec::new(),
    )
}

#[derive(Clone)]
pub(crate) struct V3ProviderWireTransportContext {
    request_id: String,
    target: V3ResponsesProviderTarget,
    stream_intent: V3ResponsesStreamIntent,
    endpoint: V3ResponsesRequestEndpoint,
}

impl V3ProviderWireTransportContext {
    pub(crate) fn from_wire(wire: &V3Provider12ResponsesWirePayload) -> Self {
        Self {
            request_id: wire.request_id().to_string(),
            target: wire.target().clone(),
            stream_intent: wire.stream_intent(),
            endpoint: wire.endpoint(),
        }
    }
}

pub(crate) fn build_v3_provider_transport_request_from_parts(
    provider_protocol: V3HubProviderWireProtocol,
    context: V3ProviderWireTransportContext,
    body: serde_json::Value,
    provider_headers: Vec<V3ProviderRequestHeader>,
) -> Result<V3Transport13ResponsesHttpRequest, String> {
    let V3ProviderWireTransportContext {
        request_id,
        target,
        stream_intent,
        endpoint,
    } = context;
    match provider_protocol {
        V3HubProviderWireProtocol::Responses => {
            build_v3_transport_13_responses_request_from_wire_parts(
                request_id,
                target,
                stream_intent,
                endpoint,
                body,
            )
            .map_err(|error| error.to_string())
        }
        V3HubProviderWireProtocol::OpenAiChat => {
            let mut body = body;
            if is_v3_deepseek_reasoning_target(&target.canonical_model_id) {
                provider_compat_core::apply_deepseek_v4_thinking_chat_compat(&mut body);
            }
            if is_v3_deepseek_v4_compat_target(&target) {
                provider_compat_core::apply_deepseek_function_call_arguments_compat(&mut body);
            }
            let url = format!("{}/chat/completions", target.base_url.trim_end_matches('/'));
            let headers = target
                .headers
                .iter()
                .map(|(name, value)| V3ProviderRequestHeader::new(name, value))
                .collect();
            build_v3_transport_13_responses_http_request_from_parts_with_timeout_and_concurrency(
                request_id,
                target.provider_id,
                url,
                target.auth,
                stream_intent,
                body,
                headers,
                Some(Duration::from_millis(target.request_timeout_ms)),
                target.concurrency_acquire_timeout_ms,
                target.sse_first_frame_timeout_ms,
            )
            .map_err(|error| error.to_string())
        }
        V3HubProviderWireProtocol::Anthropic => {
            let url = anthropic_messages_url(&target.base_url);
            build_v3_transport_13_responses_http_request_from_parts_with_timeout_and_concurrency(
                request_id,
                target.provider_id,
                url,
                target.auth,
                stream_intent,
                body,
                provider_headers,
                Some(Duration::from_millis(target.request_timeout_ms)),
                target.concurrency_acquire_timeout_ms,
                target.sse_first_frame_timeout_ms,
            )
            .map_err(|error| error.to_string())
        }
        V3HubProviderWireProtocol::Gemini => {
            let transport_intent = match stream_intent {
                routecodex_v3_provider_responses::V3ResponsesStreamIntent::Sse => {
                    super::V3HubTransportIntent::Sse
                }
                routecodex_v3_provider_responses::V3ResponsesStreamIntent::Json => {
                    super::V3HubTransportIntent::Json
                }
            };
            super::build_v3_gemini_transport_09(&request_id, target, transport_intent, body)
                .map_err(|error| error.to_string())
        }
    }
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
            interface_id: "default".into(),
            base_url: "http://upstream.invalid/v1".into(),
            canonical_model_id: "deepseek-v5-preview".into(),
            wire_model: "deepseek-v5-preview".into(),
            compatibility_profile: None,
            headers: Default::default(),
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
            concurrency_acquire_timeout_ms: 60_000,
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
        let request = build_v3_provider_transport_request_for_protocol(
            V3HubProviderWireProtocol::OpenAiChat,
            wire,
        )
        .unwrap();
        assert_eq!(
            request.body()["messages"][0]["tool_calls"][0]["function"]["arguments"],
            "{\"cmd\":\"pwd\""
        );
    }

    #[test]
    fn protocol_transport_request_keeps_provider_sse_first_frame_timeout() {
        let wire = build_v3_provider_12_responses_wire_payload(
            "req-sse-first-frame-timeout",
            V3ResponsesProviderTarget {
                provider_id: "kdns-test".into(),
                provider_type: "openai_chat".into(),
                interface_id: "default".into(),
                base_url: "http://upstream.invalid/v1".into(),
                canonical_model_id: "deepseek-v4.1-flash".into(),
                wire_model: "deepseek-v4.1-flash".into(),
                compatibility_profile: None,
                headers: Default::default(),
                auth: V3ProviderAuthHandle {
                    alias: "key1".into(),
                    secret: V3ProviderAuthSecretHandle::Environment("K1".into()),
                },
                responses_transport: V3ResponsesTransportKind::Http,
                websocket_v2_url: None,
                provider_request_cleanup: Default::default(),
                request_timeout_ms: 300_000,
                sse_first_frame_timeout_ms: Some(123_000),
                initial_concurrency_budget: 8,
                concurrency_acquire_timeout_ms: 60_000,
            },
            json!({"model": "deepseek-v4.1-flash"}),
        )
        .unwrap();
        let request = build_v3_provider_transport_request_for_protocol(
            V3HubProviderWireProtocol::OpenAiChat,
            wire,
        )
        .unwrap();
        assert_eq!(
            request.sse_first_frame_timeout_ms(),
            Some(123_000),
            "the configured SSE first-frame timeout must reach the HTTP transport request"
        );
    }

    #[test]
    fn provider_headers_config_emits_actor_authorization_header() {
        let wire = build_v3_provider_12_responses_wire_payload(
            "req-inferai-direct-compat-header",
            V3ResponsesProviderTarget {
                provider_id: "inferai-openai".into(),
                provider_type: "responses".into(),
                interface_id: "default".into(),
                base_url: "https://inferaiapi.com/v1".into(),
                canonical_model_id: "deepseek-v4.1-flash".into(),
                wire_model: "deepseek-v4.1-flash".into(),
                compatibility_profile: None,
                headers: [(
                    "x-openai-actor-authorization".to_string(),
                    "local-image-extension".to_string(),
                )]
                .into_iter()
                .collect(),
                auth: V3ProviderAuthHandle {
                    alias: "key1".into(),
                    secret: V3ProviderAuthSecretHandle::ApiKey("secret-value".into()),
                },
                responses_transport: V3ResponsesTransportKind::Http,
                websocket_v2_url: None,
                provider_request_cleanup: Default::default(),
                request_timeout_ms: 300_000,
                sse_first_frame_timeout_ms: None,
                initial_concurrency_budget: 8,
                concurrency_acquire_timeout_ms: 60_000,
            },
            json!({"model": "deepseek-v4.1-flash", "input": "hello"}),
        )
        .unwrap();
        let request = build_v3_provider_transport_request_for_protocol(
            V3HubProviderWireProtocol::Responses,
            wire,
        )
        .unwrap();
        let headers = request
            .provider_headers()
            .iter()
            .map(|header| (header.name().to_string(), header.value().to_string()))
            .collect::<Vec<_>>();
        assert_eq!(
            headers,
            vec![(
                "x-openai-actor-authorization".to_string(),
                "local-image-extension".to_string()
            )]
        );
    }

    #[test]
    fn openai_chat_transport_carries_provider_headers_from_selected_target() {
        let wire = build_v3_provider_12_responses_wire_payload(
            "req-openai-chat-provider-headers",
            V3ResponsesProviderTarget {
                provider_id: "opencode-zen-free".into(),
                interface_id: "default".into(),
                provider_type: "openai_chat".into(),
                base_url: "https://opencode.ai/zen/v1".into(),
                canonical_model_id: "step-5-preview-free".into(),
                wire_model: "step-5-preview-free".into(),
                compatibility_profile: None,
                headers: [
                    ("x-opencode-client".to_string(), "cli".to_string()),
                    ("x-opencode-session".to_string(), "ses_test".to_string()),
                ]
                .into_iter()
                .collect(),
                auth: V3ProviderAuthHandle {
                    alias: "key3".into(),
                    secret: V3ProviderAuthSecretHandle::ApiKey("secret-value".into()),
                },
                responses_transport: V3ResponsesTransportKind::Http,
                websocket_v2_url: None,
                provider_request_cleanup: Default::default(),
                request_timeout_ms: 300_000,
                sse_first_frame_timeout_ms: None,
                initial_concurrency_budget: 8,
                concurrency_acquire_timeout_ms: 60_000,
            },
            json!({"model":"step-5-preview-free","stream":true,"tools":[{"type":"function","function":{"name":"bash"}}]}),
        )
        .unwrap();
        let request = build_v3_provider_transport_request_for_protocol(
            V3HubProviderWireProtocol::OpenAiChat,
            wire,
        )
        .unwrap();
        let headers = request
            .provider_headers()
            .iter()
            .map(|header| (header.name().to_string(), header.value().to_string()))
            .collect::<Vec<_>>();
        assert_eq!(
            headers,
            vec![
                ("x-opencode-client".to_string(), "cli".to_string()),
                ("x-opencode-session".to_string(), "ses_test".to_string()),
            ]
        );
    }

    #[test]
    fn anthropic_transport_request_keeps_provider_sse_first_frame_timeout() {
        let wire = build_v3_provider_12_responses_wire_payload(
            "req-sse-first-frame-timeout-anthropic",
            V3ResponsesProviderTarget {
                provider_id: "anthropic-test".into(),
                provider_type: "anthropic".into(),
                interface_id: "default".into(),
                base_url: "http://upstream.invalid".into(),
                canonical_model_id: "claude-sonnet-5".into(),
                wire_model: "claude-sonnet-5".into(),
                compatibility_profile: None,
                headers: Default::default(),
                auth: V3ProviderAuthHandle {
                    alias: "key1".into(),
                    secret: V3ProviderAuthSecretHandle::Environment("A1".into()),
                },
                responses_transport: V3ResponsesTransportKind::Http,
                websocket_v2_url: None,
                provider_request_cleanup: Default::default(),
                request_timeout_ms: 300_000,
                sse_first_frame_timeout_ms: Some(456_000),
                initial_concurrency_budget: 8,
                concurrency_acquire_timeout_ms: 60_000,
            },
            json!({"model": "claude-sonnet-5", "max_tokens": 100}),
        )
        .unwrap();
        let request = build_v3_provider_transport_request_for_protocol(
            V3HubProviderWireProtocol::Anthropic,
            wire,
        )
        .unwrap();
        assert_eq!(
            request.sse_first_frame_timeout_ms(),
            Some(456_000),
            "the configured SSE first-frame timeout must reach the Anthropic HTTP transport request"
        );
    }

    #[test]
    fn gemini_transport_request_keeps_provider_sse_first_frame_timeout() {
        let wire = build_v3_provider_12_responses_wire_payload(
            "req-sse-first-frame-timeout-gemini",
            V3ResponsesProviderTarget {
                provider_id: "gemini-test".into(),
                provider_type: "gemini".into(),
                interface_id: "default".into(),
                base_url: "http://upstream.invalid".into(),
                canonical_model_id: "gemini-2.5-flash".into(),
                wire_model: "gemini-2.5-flash".into(),
                compatibility_profile: None,
                headers: Default::default(),
                auth: V3ProviderAuthHandle {
                    alias: "key1".into(),
                    secret: V3ProviderAuthSecretHandle::Environment("G1".into()),
                },
                responses_transport: V3ResponsesTransportKind::Http,
                websocket_v2_url: None,
                provider_request_cleanup: Default::default(),
                request_timeout_ms: 300_000,
                sse_first_frame_timeout_ms: Some(789_000),
                initial_concurrency_budget: 8,
                concurrency_acquire_timeout_ms: 60_000,
            },
            json!({"model": "gemini-2.5-flash", "contents": []}),
        )
        .unwrap();
        let request = build_v3_provider_transport_request_for_protocol(
            V3HubProviderWireProtocol::Gemini,
            wire,
        )
        .unwrap();
        assert_eq!(
            request.sse_first_frame_timeout_ms(),
            Some(789_000),
            "the configured SSE first-frame timeout must reach the Gemini HTTP transport request"
        );
    }
}
