use super::V3HubProviderWireProtocol;
use routecodex_v3_provider_responses::{
    build_v3_transport_13_responses_http_request_from_parts_with_timeout,
    build_v3_transport_13_responses_http_request_from_v3_provider_12,
    V3Provider12ResponsesWirePayload, V3ProviderRequestHeader, V3Transport13ResponsesHttpRequest,
};
use serde_json::Value;
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
    let mut body = wire.body().clone();
    if is_v3_deepseek_reasoning_target(&target.canonical_model_id) {
        apply_v3_opencode_deepseek_reasoning_passthrough(&mut body);
    }
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

/// opencode 对 DeepSeek 系模型的标准 reasoning 回传处理（transform.ts interleaved）：
/// DeepSeek 上游要求**每条 assistant 消息都必须携带 `reasoning_content`**——即使本轮没有
/// 明文 reasoning 也要回传空字符串（"DeepSeek may return empty reasoning_content which
/// still needs to be sent back"）。缺失该字段会触发上游 400：
/// `The reasoning_content in the thinking mode must be passed back to the API`。
/// 只补缺失字段：已有 reasoning_content（明文或空占位）的消息保持不变。
fn apply_v3_opencode_deepseek_reasoning_passthrough(body: &mut Value) {
    let Some(messages) = body.get_mut("messages").and_then(Value::as_array_mut) else {
        return;
    };
    for message in messages {
        let Some(message_object) = message.as_object_mut() else {
            continue;
        };
        if message_object
            .get("role")
            .and_then(Value::as_str)
            .map(str::trim)
            .map(str::to_ascii_lowercase)
            .as_deref()
            != Some("assistant")
        {
            continue;
        }
        if !message_object.contains_key("reasoning_content") {
            message_object.insert(
                "reasoning_content".to_string(),
                Value::String(String::new()),
            );
        }
    }
}

fn is_v3_deepseek_reasoning_target(canonical_model_id: &str) -> bool {
    canonical_model_id
        .to_ascii_lowercase()
        .contains("deepseek")
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
    use serde_json::json;

    #[test]
    fn opencode_deepseek_reasoning_passthrough_backfills_empty_assistant_reasoning_content() {
        let mut body = json!({
            "model": "deepseek-v4-flash",
            "messages": [
                {"role": "user", "content": "hi"},
                {"role": "assistant", "content": "first answer"},
                {"role": "assistant", "content": "second answer", "reasoning_content": "kept"}
            ]
        });
        assert!(is_v3_deepseek_reasoning_target("deepseek-v4-flash"));
        assert!(!is_v3_deepseek_reasoning_target("gpt-5.6-sol"));

        apply_v3_opencode_deepseek_reasoning_passthrough(&mut body);

        let messages = body["messages"].as_array().unwrap();
        // 非 assistant 消息不补
        assert_eq!(messages[0]["reasoning_content"], Value::Null);
        // 无 reasoning_content 的 assistant 消息补空占位（opencode 标准：空也回传）
        assert_eq!(messages[1]["reasoning_content"], Value::String(String::new()));
        // 已有明文 reasoning_content 保持不变
        assert_eq!(messages[2]["reasoning_content"], "kept");
    }
}
