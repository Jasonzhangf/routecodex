use super::{encode_v3_responses_semantic_as_anthropic_request, V3HubProviderWireProtocol};
use routecodex_v3_provider_responses::{
    build_v3_transport_13_responses_http_request_from_parts, V3Provider12ResponsesWirePayload,
    V3Transport13ResponsesHttpRequest,
};

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
        "openai_chat" | "openai-chat" | "openai_chat_completions" | "openai-chat-completions" => {
            Ok(V3HubProviderWireProtocol::OpenAiChat)
        }
        "gemini" | "gemini_chat" | "gemini-chat" => Ok(V3HubProviderWireProtocol::Gemini),
        other => Err(format!(
            "selected unsupported provider wire protocol: provider={provider_id} type={other}"
        )),
    }
}

pub(crate) fn anthropic_messages_url(base_url: &str) -> String {
    format!("{}/v1/messages", base_url.trim_end_matches('/'))
}

pub(crate) fn build_v3_anthropic_messages_transport_request_from_v3_provider_08(
    wire: V3Provider12ResponsesWirePayload,
) -> Result<V3Transport13ResponsesHttpRequest, String> {
    let request_id = wire.request_id().to_string();
    let target = wire.target().clone();
    let stream_intent = wire.stream_intent();
    let body = encode_v3_responses_semantic_as_anthropic_request(wire.body().clone())
        .map_err(|error| format!("anthropic messages request codec failed: {error}"))?;
    let url_text = anthropic_messages_url(&target.base_url);
    build_v3_transport_13_responses_http_request_from_parts(
        request_id,
        target.provider_id,
        url_text,
        target.auth,
        stream_intent,
        body,
    )
    .map_err(|error| error.to_string())
}
