use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};

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

#[derive(Debug, Clone, PartialEq)]
pub enum V3ClientBody {
    Json(Value),
    Bytes(Vec<u8>),
}

#[derive(Debug, Clone, PartialEq)]
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
    let body = &standardized.body;
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
        entry_protocol: "responses".to_string(),
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
        Value::Bool(value) => usize::from(*value) + 4,
        Value::Number(value) => value.to_string().len(),
        Value::String(value) => value.chars().count(),
        Value::Array(values) => values.iter().map(estimate_v3_structured_chars).sum(),
        Value::Object(values) => values
            .iter()
            .filter(|(key, _)| !matches!(key.as_str(), "metadata" | "client_metadata"))
            .map(|(key, value)| key.len() + estimate_v3_structured_chars(value))
            .sum(),
    }
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
