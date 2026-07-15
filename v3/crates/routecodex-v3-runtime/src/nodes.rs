use futures_util::Stream;
use routecodex_v3_error::V3Error01SourceRaised;
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};
use std::fmt;
use std::pin::Pin;

#[derive(Debug, Clone, PartialEq)]
pub struct V3Server03HttpRequestRaw {
    pub server_id: String,
    pub request_id: String,
    pub execution_id: String,
    pub method: String,
    pub path: String,
    pub body: Value,
}

pub fn build_v3_server_03_http_request_raw(
    server_id: String,
    request_id: String,
    execution_id: String,
    method: String,
    path: String,
    body: Value,
) -> V3Server03HttpRequestRaw {
    V3Server03HttpRequestRaw {
        server_id,
        request_id,
        execution_id,
        method,
        path,
        body,
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct V3Req04StandardizedResponses {
    pub body: Value,
    pub protocol_context: V3ProtocolContext,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct V3ProtocolContext {
    pub server_id: String,
    pub request_id: String,
    pub execution_id: String,
    pub endpoint: String,
    pub method: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct V3ResponsesDirect11Policy {
    pub target: routecodex_v3_target::V3Target10ConcreteProviderSelected,
    pub request_id: String,
    pub request_body: Value,
}

pub type V3ClientSseStream =
    Pin<Box<dyn Stream<Item = Result<Vec<u8>, V3Error01SourceRaised>> + Send>>;

pub enum V3ClientBody {
    Json(Value),
    Bytes(Vec<u8>),
    Sse(V3ClientSseStream),
}

impl fmt::Debug for V3ClientBody {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Json(value) => formatter.debug_tuple("Json").field(value).finish(),
            Self::Bytes(bytes) => formatter
                .debug_struct("Bytes")
                .field("byte_len", &bytes.len())
                .finish(),
            Self::Sse(_) => formatter.write_str("Sse(<client-event-stream>)"),
        }
    }
}

#[derive(Debug)]
pub struct V3Resp15ClientPayload {
    pub status: u16,
    pub headers: BTreeMap<String, String>,
    pub body: V3ClientBody,
}

pub fn build_v3_req_04_standardized_responses_from_v3_server_03(
    raw: V3Server03HttpRequestRaw,
) -> V3Req04StandardizedResponses {
    V3Req04StandardizedResponses {
        protocol_context: V3ProtocolContext {
            server_id: raw.server_id,
            request_id: raw.request_id,
            execution_id: raw.execution_id,
            endpoint: raw.path,
            method: raw.method,
        },
        body: raw.body,
    }
}

pub fn build_v3_router_request_facts_from_v3_req_04(
    standardized: &V3Req04StandardizedResponses,
) -> routecodex_v3_virtual_router::V3RouterRequestFacts {
    build_v3_router_request_facts_for_entry(&standardized.body, "responses")
}

pub fn build_v3_router_request_facts_for_entry(
    body: &Value,
    entry_protocol: &str,
) -> routecodex_v3_virtual_router::V3RouterRequestFacts {
    let mut capabilities = BTreeSet::from(["text".to_string()]);
    if body
        .get("tools")
        .and_then(Value::as_array)
        .is_some_and(|tools| !tools.is_empty())
    {
        capabilities.insert("tools".to_string());
    }
    if body.get("reasoning").is_some() {
        capabilities.insert("reasoning".to_string());
    }
    if body
        .get("input")
        .and_then(Value::as_array)
        .is_some_and(|items| {
            items.iter().any(|item| {
                matches!(
                    item.get("type").and_then(Value::as_str),
                    Some("function_call_output" | "custom_tool_call_output")
                )
            })
        })
    {
        capabilities.insert("tool_outputs".to_string());
    }
    if body.get("stream").and_then(Value::as_bool) == Some(true) {
        capabilities.insert("streaming".to_string());
    }

    routecodex_v3_virtual_router::V3RouterRequestFacts {
        entry_protocol: entry_protocol.to_string(),
        client_model: body
            .get("model")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToOwned::to_owned),
        capabilities,
        input_tokens: estimate_v3_routing_input_tokens(body),
    }
}

fn estimate_v3_routing_input_tokens(body: &Value) -> u64 {
    let chars = ["input", "instructions", "tools"]
        .iter()
        .filter_map(|field| body.get(*field))
        .map(estimate_v3_structured_chars)
        .sum::<usize>();
    if chars == 0 {
        0
    } else {
        (chars as f64 / 3.2).ceil() as u64
    }
}

fn estimate_v3_structured_chars(value: &Value) -> usize {
    match value {
        Value::Null => 0,
        Value::Bool(value) => value.to_string().len(),
        Value::Number(value) => value.to_string().len(),
        Value::String(value) => estimate_v3_text_or_structured_chars(value),
        Value::Array(values) => values.iter().map(estimate_v3_structured_chars).sum(),
        Value::Object(values) => {
            if detect_v3_media_kind(values).is_some() {
                let type_len = values
                    .get("type")
                    .and_then(Value::as_str)
                    .map(str::len)
                    .unwrap_or(5);
                return type_len + "[omitted_media]".len();
            }
            values
                .iter()
                .filter(|(key, _)| !matches!(key.as_str(), "metadata" | "client_metadata"))
                .map(|(key, value)| key.len() + estimate_v3_structured_chars(value))
                .sum()
        }
    }
}

fn estimate_v3_text_or_structured_chars(raw: &str) -> usize {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return 0;
    }
    let likely_json = (trimmed.starts_with('{') && trimmed.ends_with('}'))
        || (trimmed.starts_with('[') && trimmed.ends_with(']'));
    if likely_json {
        if let Ok(parsed) = serde_json::from_str::<Value>(trimmed) {
            return estimate_v3_structured_chars(&parsed);
        }
    }
    raw.chars().count()
}

fn detect_v3_media_kind(values: &serde_json::Map<String, Value>) -> Option<&'static str> {
    let type_value = values
        .get("type")
        .and_then(Value::as_str)
        .map(|value| value.trim().to_ascii_lowercase())
        .unwrap_or_default();
    if type_value.contains("video") {
        return Some("video");
    }
    if type_value.contains("image") {
        return Some("image");
    }
    if values.contains_key("video_url") {
        return Some("video");
    }
    if values.contains_key("image_url") {
        return Some("image");
    }
    let data = values
        .get("data")
        .and_then(Value::as_str)
        .map(|value| value.trim().to_ascii_lowercase())
        .unwrap_or_default();
    if data.starts_with("data:video/") {
        return Some("video");
    }
    if data.starts_with("data:image/") {
        return Some("image");
    }
    None
}

pub fn build_v3_responses_direct_11_policy_from_v3_target_10(
    selected: routecodex_v3_target::V3Target10ConcreteProviderSelected,
    standardized: &V3Req04StandardizedResponses,
) -> V3ResponsesDirect11Policy {
    V3ResponsesDirect11Policy {
        target: selected,
        request_id: standardized.protocol_context.request_id.clone(),
        request_body: standardized.body.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::build_v3_router_request_facts_for_entry;
    use serde_json::json;

    #[test]
    fn v3_routing_token_estimate_omits_image_payload_bytes() {
        let base = json!({
            "model": "gpt-5.6-sol",
            "input": [
                {
                    "role": "user",
                    "content": [
                        { "type": "input_text", "text": "Describe this image." }
                    ]
                }
            ],
            "tools": []
        });
        let with_image = json!({
            "model": "gpt-5.6-sol",
            "input": [
                {
                    "role": "user",
                    "content": [
                        { "type": "input_text", "text": "Describe this image." },
                        {
                            "type": "input_image",
                            "image_url": {
                                "url": format!("data:image/png;base64,{}", "A".repeat(1_200_000))
                            }
                        }
                    ]
                }
            ],
            "tools": []
        });

        let base_tokens = build_v3_router_request_facts_for_entry(&base, "responses").input_tokens;
        let image_tokens =
            build_v3_router_request_facts_for_entry(&with_image, "responses").input_tokens;

        assert!(
            image_tokens <= base_tokens + 8,
            "V3 routing token estimate must omit image/base64 bytes like the V2 Rust estimator; base={base_tokens}, image={image_tokens}"
        );
    }

    #[test]
    fn v3_routing_token_estimate_omits_stringified_media_payloads() {
        let base_input = serde_json::to_string(&json!([
            { "type": "input_text", "text": "Summarize this clip." }
        ]))
        .unwrap();
        let base = json!({
            "model": "gpt-5.6-sol",
            "input": base_input,
            "tools": []
        });
        let stringified = serde_json::to_string(&json!([
            { "type": "input_text", "text": "Summarize this clip." },
            {
                "type": "input_video",
                "video_url": format!("data:video/mp4;base64,{}", "B".repeat(1_200_000))
            }
        ]))
        .unwrap();
        let with_video = json!({
            "model": "gpt-5.6-sol",
            "input": stringified,
            "tools": []
        });

        let base_tokens = build_v3_router_request_facts_for_entry(&base, "responses").input_tokens;
        let video_tokens =
            build_v3_router_request_facts_for_entry(&with_video, "responses").input_tokens;

        assert!(
            video_tokens <= base_tokens + 12,
            "V3 routing token estimate must omit stringified media/base64 bytes like the V2 Rust estimator; base={base_tokens}, video={video_tokens}"
        );
    }
}
