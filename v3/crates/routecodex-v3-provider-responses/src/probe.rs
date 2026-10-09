use crate::transport::{
    build_v3_anthropic_provider_request_header,
    build_v3_transport_13_responses_http_request_from_parts_with_timeout_and_concurrency,
    build_v3_transport_13_responses_http_request_from_v3_provider_12, V3ProviderRequestHeader,
    V3Transport13ResponsesRequest,
};
use crate::wire::{
    build_v3_provider_12_responses_wire_payload, V3ResponsesProviderTarget, V3ResponsesStreamIntent,
};

pub fn build_v3_provider_global_probe_request(
    target: V3ResponsesProviderTarget,
    request_id: String,
) -> Result<V3Transport13ResponsesRequest, String> {
    let mut body = probe_request_body(&target)?;
    if target.provider_type == "openai_chat"
        && target
            .compatibility_profile
            .as_deref()
            .is_some_and(|profile| {
                profile.eq_ignore_ascii_case(provider_compat_core::opencode_zen_tcm::PROFILE)
            })
    {
        provider_compat_core::opencode_zen_tcm::apply_opencode_zen_probe_request(&mut body);
    }
    build_v3_provider_global_request(target, request_id, body)
}

/// probe 请求体：每个 provider 协议一条最小真实请求。
fn probe_request_body(target: &V3ResponsesProviderTarget) -> Result<serde_json::Value, String> {
    Ok(match target.provider_type.as_str() {
        "responses" => serde_json::json!({
            "model": target.wire_model,
            "input": [{"role":"user","content":[{"type":"input_text","text":"routecodex health probe"}]}],
            "max_output_tokens": 1,
            "stream": false,
        }),
        "openai_chat" => serde_json::json!({
            "model": target.wire_model,
            "messages": [{"role":"user","content":"routecodex health probe"}],
            "max_tokens": 1,
            "stream": false,
        }),
        "anthropic" => serde_json::json!({
            "model": target.wire_model,
            "max_tokens": 1,
            "messages": [{"role":"user","content":"routecodex health probe"}],
        }),
        "gemini" => serde_json::json!({
            "contents": [{"role":"user","parts":[{"text":"routecodex health probe"}]}],
            "generationConfig": {"maxOutputTokens": 1},
        }),
        other => return Err(format!("unsupported provider probe protocol {other}")),
    })
}

/// 用调用方提供的请求体构造一次真实 provider 请求（诊断用途）。
///
/// 与 probe 请求共用同一条 URL / 协议 header / 超时 / 并发准入路径：真实 provider 请求
/// 的构造只在这里实现一次，调用方只提供协议请求体。
pub fn build_v3_provider_global_request(
    target: V3ResponsesProviderTarget,
    request_id: String,
    body: serde_json::Value,
) -> Result<V3Transport13ResponsesRequest, String> {
    let provider_type = target.provider_type.clone();
    let provider_headers: Vec<V3ProviderRequestHeader> = target
        .headers
        .iter()
        .map(|(name, value)| V3ProviderRequestHeader::new(name, value))
        .collect();
    if provider_type == "responses" {
        let wire = build_v3_provider_12_responses_wire_payload(request_id, target, body)
            .map_err(|error| error.to_string())?;
        return build_v3_transport_13_responses_http_request_from_v3_provider_12(wire)
            .map_err(|error| error.to_string());
    }
    let (url, headers) = match provider_type.as_str() {
        "openai_chat" => (
            format!("{}/chat/completions", target.base_url.trim_end_matches('/')),
            Vec::new(),
        ),
        "anthropic" => (
            format!(
                "{}/v1/messages?beta=true",
                target.base_url.trim_end_matches('/')
            ),
            [build_v3_anthropic_provider_request_header(
                "anthropic-version",
                "2023-06-01",
            )]
            .into_iter()
            .flatten()
            .collect(),
        ),
        "gemini" => (
            format!(
                "{}/models/{}:generateContent",
                target.base_url.trim_end_matches('/'),
                target.wire_model
            ),
            Vec::new(),
        ),
        other => return Err(format!("unsupported provider request protocol {other}")),
    };
    let stream_intent = if body.get("stream").and_then(serde_json::Value::as_bool) == Some(true) {
        V3ResponsesStreamIntent::Sse
    } else {
        V3ResponsesStreamIntent::Json
    };
    build_v3_transport_13_responses_http_request_from_parts_with_timeout_and_concurrency(
        request_id,
        target.provider_id,
        url,
        target.auth,
        stream_intent,
        body,
        headers.into_iter().chain(provider_headers).collect(),
        Some(std::time::Duration::from_millis(target.request_timeout_ms)),
        target.concurrency_acquire_timeout_ms,
        None,
    )
    .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{V3ProviderAuthHandle, V3ProviderAuthSecretHandle};
    use routecodex_v3_config::V3ResponsesTransportKind;
    use std::collections::BTreeMap;

    #[test]
    fn non_responses_probe_request_carries_provider_headers() {
        let target = V3ResponsesProviderTarget {
            provider_id: "inferai".into(),
            provider_type: "openai_chat".into(),
            base_url: "https://inferaiapi.com/v1".into(),
            canonical_model_id: "deepseek-v4.1-flash".into(),
            wire_model: "deepseek-v4.1-flash".into(),
            compatibility_profile: None,
            headers: BTreeMap::from([(
                "x-openai-actor-authorization".to_string(),
                "local-image-extension".to_string(),
            )]),
            auth: V3ProviderAuthHandle {
                alias: "key1".into(),
                secret: V3ProviderAuthSecretHandle::ApiKey("sk-test".into()),
            },
            responses_transport: V3ResponsesTransportKind::Http,
            websocket_v2_url: None,
            provider_request_cleanup: Default::default(),
            request_timeout_ms: 120_000,
            sse_first_frame_timeout_ms: None,
            initial_concurrency_budget: 8,
            concurrency_acquire_timeout_ms: 60_000,
        };
        let request =
            build_v3_provider_global_probe_request(target.clone(), "probe-provider-header".into())
                .expect("probe request builds");
        assert!(
            request
                .provider_headers()
                .iter()
                .any(|header| header.name() == "x-openai-actor-authorization"
                    && header.value() == "local-image-extension"),
            "provider authoring headers must reach non-responses cooldown probe requests"
        );
        assert_eq!(request.stream_intent(), V3ResponsesStreamIntent::Json);
        assert_eq!(request.body()["max_tokens"], 1);
        let mut zen = target;
        zen.compatibility_profile = Some(provider_compat_core::opencode_zen_tcm::PROFILE.into());
        let request = build_v3_provider_global_probe_request(zen, "probe-zen".into()).unwrap();
        assert_eq!(request.stream_intent(), V3ResponsesStreamIntent::Sse);
        assert_eq!(request.body()["stream"], true);
        assert!(request.body().get("max_tokens").is_none());
        assert_eq!(request.body()["tools"][0]["function"]["name"], "bash");
        assert_eq!(request.body()["tools"][1]["function"]["name"], "read");
    }
}
