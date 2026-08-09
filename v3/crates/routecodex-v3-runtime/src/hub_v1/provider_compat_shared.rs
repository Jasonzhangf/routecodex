use super::V3HubProviderWireProtocol;
use routecodex_v3_provider_responses::{
    build_v3_transport_13_responses_http_request_from_parts,
    build_v3_transport_13_responses_http_request_from_parts_with_timeout,
    build_v3_transport_13_responses_http_request_from_v3_provider_12,
    V3Provider12ResponsesWirePayload, V3ProviderRequestHeader, V3Transport13ResponsesHttpRequest,
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
        return build_v3_transport_13_responses_http_request_from_parts_with_timeout(
            request_id,
            target.provider_id,
            url_text,
            target.auth,
            stream_intent,
            body,
            Vec::new(),
            timeout,
        )
        .map_err(|error| error.to_string());
    }
    build_v3_transport_13_responses_http_request_from_parts_with_timeout(
        request_id,
        target.provider_id,
        url_text,
        target.auth,
        stream_intent,
        body,
        provider_headers,
        timeout,
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
    let body = wire.body().clone();
    let url_text = format!("{}/chat/completions", target.base_url.trim_end_matches('/'));
    build_v3_transport_13_responses_http_request_from_parts_with_timeout(
        request_id,
        target.provider_id,
        url_text,
        target.auth,
        stream_intent,
        body,
        Vec::new(),
        Some(Duration::from_millis(target.request_timeout_ms)),
    )
    .map_err(|error| error.to_string())
}
