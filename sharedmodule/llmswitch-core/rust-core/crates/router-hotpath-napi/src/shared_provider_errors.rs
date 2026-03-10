use napi::bindgen_prelude::Result as NapiResult;
use napi_derive::napi;
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProviderProtocolErrorInput {
    message: String,
    code: String,
    protocol: Option<String>,
    provider_type: Option<String>,
    category: Option<String>,
    details: Option<Value>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProviderProtocolErrorOutput {
    message: String,
    code: String,
    protocol: Option<String>,
    provider_type: Option<String>,
    category: String,
    details: Option<Value>,
}

fn infer_category(code: &str) -> String {
    match code {
        "TOOL_PROTOCOL_ERROR" => "TOOL_ERROR".to_string(),
        "SERVERTOOL_TIMEOUT" | "SERVERTOOL_HANDLER_FAILED" => "INTERNAL_ERROR".to_string(),
        "SSE_DECODE_ERROR"
        | "MALFORMED_RESPONSE"
        | "MALFORMED_REQUEST"
        | "SERVERTOOL_FOLLOWUP_FAILED"
        | "SERVERTOOL_EMPTY_FOLLOWUP" => "EXTERNAL_ERROR".to_string(),
        _ => "EXTERNAL_ERROR".to_string(),
    }
}

#[napi]
pub fn build_provider_protocol_error_json(input_json: String) -> NapiResult<String> {
    let input: ProviderProtocolErrorInput = serde_json::from_str(&input_json).map_err(|e| {
        napi::Error::from_reason(format!("Failed to parse provider error input: {}", e))
    })?;
    let category = input
        .category
        .clone()
        .filter(|v| !v.trim().is_empty())
        .unwrap_or_else(|| infer_category(input.code.as_str()));
    let output = ProviderProtocolErrorOutput {
        message: input.message,
        code: input.code,
        protocol: input.protocol,
        provider_type: input.provider_type,
        category,
        details: input.details,
    };
    serde_json::to_string(&output).map_err(|e| {
        napi::Error::from_reason(format!("Failed to serialize provider error output: {}", e))
    })
}
