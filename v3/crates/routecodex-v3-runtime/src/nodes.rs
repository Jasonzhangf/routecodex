use serde_json::Value;
use std::collections::BTreeMap;

#[derive(Debug, Clone, PartialEq)]
pub struct V3Server03HttpRequestRaw {
    pub method: String,
    pub path: String,
    pub body: Value,
}

#[derive(Debug, Clone, PartialEq)]
pub struct V3Req04StandardizedResponses {
    pub body: Value,
    pub protocol_context: V3ProtocolContext,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct V3ProtocolContext {
    pub endpoint: String,
    pub method: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct V3Route05SelectedTarget {
    pub provider_id: String,
    pub model: String,
    pub base_url: String,
    pub auth_env: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct V3ResponsesDirect06Policy {
    pub target: V3Route05SelectedTarget,
    pub request_body: Value,
}

#[derive(Debug, Clone, PartialEq)]
pub enum V3ClientBody {
    Json(Value),
    Bytes(Vec<u8>),
}

#[derive(Debug, Clone, PartialEq)]
pub struct V3Resp10ClientPayload {
    pub status: u16,
    pub headers: BTreeMap<String, String>,
    pub body: V3ClientBody,
}

pub fn build_v3_req_04_standardized_responses_from_v3_server_03(
    raw: V3Server03HttpRequestRaw,
) -> V3Req04StandardizedResponses {
    V3Req04StandardizedResponses {
        protocol_context: V3ProtocolContext {
            endpoint: raw.path,
            method: raw.method,
        },
        body: raw.body,
    }
}

pub fn build_v3_responses_direct_06_policy_from_v3_route_05(
    selected: V3Route05SelectedTarget,
    standardized: &V3Req04StandardizedResponses,
) -> V3ResponsesDirect06Policy {
    V3ResponsesDirect06Policy {
        target: selected,
        request_body: standardized.body.clone(),
    }
}
