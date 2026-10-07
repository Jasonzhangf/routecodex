use super::V3HubProviderWireProtocol;
use routecodex_v3_provider_responses::{
    build_v3_transport_13_responses_http_request_from_parts_with_timeout_and_concurrency,
    build_v3_transport_13_responses_http_request_from_v3_provider_12,
    V3Provider12ResponsesWirePayload, V3ProviderError, V3ProviderRequestHeader,
    V3ResponsesProviderTarget, V3Transport13ResponsesHttpRequest,
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
) -> Result<V3Transport13ResponsesHttpRequest, V3ProviderError> {
    build_v3_anthropic_messages_transport_request_from_v3_provider_08_with_provider_headers(
        wire,
        Vec::new(),
    )
}

pub(crate) fn build_v3_anthropic_messages_transport_request_from_v3_provider_08_with_provider_headers(
    wire: V3Provider12ResponsesWirePayload,
    provider_headers: Vec<V3ProviderRequestHeader>,
) -> Result<V3Transport13ResponsesHttpRequest, V3ProviderError> {
    let request_id = wire.request_id().to_string();
    let target = wire.target().clone();
    let sse_first_frame_timeout_ms = target.sse_first_frame_timeout_ms;
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
            sse_first_frame_timeout_ms,
        );
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
        sse_first_frame_timeout_ms,
    )
}

pub(crate) fn build_v3_provider_transport_request_for_protocol(
    provider_protocol: V3HubProviderWireProtocol,
    wire: V3Provider12ResponsesWirePayload,
) -> Result<V3Transport13ResponsesHttpRequest, V3ProviderError> {
    match provider_protocol {
        V3HubProviderWireProtocol::Responses => {
            build_v3_transport_13_responses_http_request_from_v3_provider_12(wire)
        }
        V3HubProviderWireProtocol::OpenAiChat => {
            build_v3_openai_chat_transport_request_from_v3_provider_08(wire)
        }
        V3HubProviderWireProtocol::Anthropic => {
            build_v3_anthropic_messages_transport_request_from_v3_provider_08(wire)
        }
        V3HubProviderWireProtocol::Gemini => {
            let transport_intent = match wire.stream_intent() {
                routecodex_v3_provider_responses::V3ResponsesStreamIntent::Sse => {
                    super::V3HubTransportIntent::Sse
                }
                routecodex_v3_provider_responses::V3ResponsesStreamIntent::Json => {
                    super::V3HubTransportIntent::Json
                }
            };
            super::build_v3_gemini_transport_09(
                wire.request_id(),
                wire.target().clone(),
                transport_intent,
                wire.body().clone(),
            )
        }
    }
}

fn build_v3_openai_chat_transport_request_from_v3_provider_08(
    wire: V3Provider12ResponsesWirePayload,
) -> Result<V3Transport13ResponsesHttpRequest, V3ProviderError> {
    let request_id = wire.request_id().to_string();
    let target = wire.target().clone();
    let sse_first_frame_timeout_ms = target.sse_first_frame_timeout_ms;
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
        sse_first_frame_timeout_ms,
    )
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
        V3ProviderAuthSecretHandle, V3ResponsesStreamIntent,
    };
    use serde_json::json;

    fn typed_transport_test_target(
        provider_id: &str,
        provider_type: &str,
        base_url: &str,
        canonical_model_id: &str,
    ) -> V3ResponsesProviderTarget {
        V3ResponsesProviderTarget {
            provider_id: provider_id.into(),
            provider_type: provider_type.into(),
            base_url: base_url.into(),
            canonical_model_id: canonical_model_id.into(),
            wire_model: canonical_model_id.into(),
            compatibility_profile: None,
            headers: Default::default(),
            auth: V3ProviderAuthHandle {
                alias: "primary".into(),
                secret: V3ProviderAuthSecretHandle::Environment("K1".into()),
            },
            responses_transport: V3ResponsesTransportKind::Http,
            websocket_v2_url: None,
            provider_request_cleanup: Default::default(),
            request_timeout_ms: 300_000,
            sse_first_frame_timeout_ms: None,
            initial_concurrency_budget: 8,
            concurrency_acquire_timeout_ms: 60_000,
        }
    }

    #[test]
    fn protocol_transport_invalid_url_preserves_typed_provider_error_for_all_protocols() {
        for protocol in [
            V3HubProviderWireProtocol::Responses,
            V3HubProviderWireProtocol::OpenAiChat,
            V3HubProviderWireProtocol::Anthropic,
            V3HubProviderWireProtocol::Gemini,
        ] {
            let target = typed_transport_test_target(
                "typed-invalid-url-provider",
                match protocol {
                    V3HubProviderWireProtocol::Responses => "responses",
                    V3HubProviderWireProtocol::OpenAiChat => "openai_chat",
                    V3HubProviderWireProtocol::Anthropic => "anthropic",
                    V3HubProviderWireProtocol::Gemini => "gemini",
                },
                "::not-a-url::",
                "typed-model",
            );
            let wire = build_v3_provider_12_responses_wire_payload(
                "req-typed-invalid-url",
                target,
                json!({"model": "typed-model", "input": "hello"}),
            )
            .unwrap();

            let error = build_v3_provider_transport_request_for_protocol(protocol, wire)
                .expect_err("invalid URL must fail transport construction");
            match error {
                V3ProviderError::InvalidBaseUrl {
                    request_id,
                    provider_id,
                    ..
                } => {
                    assert_eq!(request_id, "req-typed-invalid-url");
                    assert_eq!(provider_id, "typed-invalid-url-provider");
                }
                other => panic!("{protocol:?} lost typed InvalidBaseUrl: {other:?}"),
            }
        }
    }

    #[test]
    fn protocol_transport_valid_construction_keeps_url_auth_stream_and_body() {
        for protocol in [
            V3HubProviderWireProtocol::Responses,
            V3HubProviderWireProtocol::OpenAiChat,
            V3HubProviderWireProtocol::Anthropic,
            V3HubProviderWireProtocol::Gemini,
        ] {
            let base_url = match protocol {
                V3HubProviderWireProtocol::Responses => "https://responses.invalid/v1",
                V3HubProviderWireProtocol::OpenAiChat => "https://chat.invalid/v1",
                V3HubProviderWireProtocol::Anthropic => "https://anthropic.invalid",
                V3HubProviderWireProtocol::Gemini => "https://gemini.invalid",
            };
            let target = typed_transport_test_target(
                "typed-valid-provider",
                match protocol {
                    V3HubProviderWireProtocol::Responses => "responses",
                    V3HubProviderWireProtocol::OpenAiChat => "openai_chat",
                    V3HubProviderWireProtocol::Anthropic => "anthropic",
                    V3HubProviderWireProtocol::Gemini => "gemini",
                },
                base_url,
                "typed-model",
            );
            let wire = build_v3_provider_12_responses_wire_payload(
                "req-typed-valid",
                target,
                json!({
                    "model": "typed-model",
                    "input": "hello",
                    "stream": true,
                    "opaque_marker": {"keep": true}
                }),
            )
            .unwrap();

            let request = build_v3_provider_transport_request_for_protocol(protocol, wire)
                .expect("valid construction must succeed");
            assert_eq!(request.request_id(), "req-typed-valid");
            assert_eq!(request.provider_id(), "typed-valid-provider");
            assert_eq!(request.provider_key(), "typed-valid-provider:primary");
            match protocol {
                V3HubProviderWireProtocol::Responses => {
                    assert!(request.url().ends_with("/responses"));
                }
                V3HubProviderWireProtocol::OpenAiChat => {
                    assert!(request.url().ends_with("/chat/completions"));
                }
                V3HubProviderWireProtocol::Anthropic => {
                    assert!(request.url().ends_with("/v1/messages?beta=true"));
                }
                V3HubProviderWireProtocol::Gemini => {
                    assert!(request
                        .url()
                        .contains("/models/typed-model:streamGenerateContent"));
                    assert!(request.url().ends_with("?alt=sse"));
                }
            }
            assert_eq!(request.stream_intent(), V3ResponsesStreamIntent::Sse);
            assert_eq!(request.body()["opaque_marker"]["keep"], true);
        }
    }

    #[test]
    fn anthropic_transport_with_provider_headers_preserves_typed_invalid_url() {
        let wire = build_v3_provider_12_responses_wire_payload(
            "req-typed-anthropic-header-error",
            typed_transport_test_target(
                "typed-anthropic-provider",
                "anthropic",
                "::not-a-url::",
                "typed-model",
            ),
            json!({"model": "typed-model", "input": "hello"}),
        )
        .unwrap();

        let error = build_v3_anthropic_messages_transport_request_from_v3_provider_08_with_provider_headers(
            wire,
            vec![V3ProviderRequestHeader::new(
                "anthropic-beta",
                "test-header",
            )],
        )
        .expect_err("invalid URL must fail transport construction");
        assert!(matches!(
            error,
            V3ProviderError::InvalidBaseUrl {
                ref request_id,
                ref provider_id,
                ..
            } if request_id == "req-typed-anthropic-header-error"
                && provider_id == "typed-anthropic-provider"
        ));
    }

    #[test]
    fn typed_transport_preserves_missing_auth_handle_until_provider_send() {
        let mut target = typed_transport_test_target(
            "typed-missing-auth-provider",
            "openai_chat",
            "https://chat.invalid/v1",
            "typed-model",
        );
        target.auth = V3ProviderAuthHandle {
            alias: "missing-auth".into(),
            secret: V3ProviderAuthSecretHandle::Environment("REQ09_W_MISSING_AUTH_SECRET".into()),
        };
        let wire = build_v3_provider_12_responses_wire_payload(
            "req-typed-missing-auth",
            target,
            json!({"model": "typed-model", "input": "hello"}),
        )
        .unwrap();

        let request = build_v3_provider_transport_request_for_protocol(
            V3HubProviderWireProtocol::OpenAiChat,
            wire,
        )
        .expect("transport construction must not resolve provider auth");
        assert_eq!(
            request.provider_key(),
            "typed-missing-auth-provider:missing-auth"
        );
        assert_eq!(request.body()["input"], "hello");
    }

    #[test]
    fn unrelated_deepseek_model_keeps_malformed_arguments_at_openai_chat_transport() {
        let target = V3ResponsesProviderTarget {
            provider_id: "unrelated-deepseek".into(),
            provider_type: "openai_chat".into(),
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
        let request = build_v3_openai_chat_transport_request_from_v3_provider_08(wire).unwrap();
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
    fn anthropic_transport_request_keeps_provider_sse_first_frame_timeout() {
        let wire = build_v3_provider_12_responses_wire_payload(
            "req-sse-first-frame-timeout-anthropic",
            V3ResponsesProviderTarget {
                provider_id: "anthropic-test".into(),
                provider_type: "anthropic".into(),
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
