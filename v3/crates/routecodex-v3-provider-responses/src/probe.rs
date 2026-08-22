use crate::transport::{
    build_v3_anthropic_provider_request_header,
    build_v3_transport_13_responses_http_request_from_parts_with_timeout,
    build_v3_transport_13_responses_http_request_from_v3_provider_12,
    V3Transport13ResponsesRequest,
};
use crate::wire::{
    build_v3_provider_12_responses_wire_payload, V3ResponsesProviderTarget, V3ResponsesStreamIntent,
};

pub fn build_v3_provider_global_probe_request(
    target: V3ResponsesProviderTarget,
    request_id: String,
) -> Result<V3Transport13ResponsesRequest, String> {
    let provider_type = target.provider_type.clone();
    let body = match provider_type.as_str() {
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
    };
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
        _ => unreachable!(),
    };
    build_v3_transport_13_responses_http_request_from_parts_with_timeout(
        request_id,
        target.provider_id,
        url,
        target.auth,
        V3ResponsesStreamIntent::Json,
        body,
        headers,
        Some(std::time::Duration::from_millis(target.request_timeout_ms)),
    )
    .map_err(|error| error.to_string())
}
