use napi::bindgen_prelude::Result as NapiResult;
use napi_derive::napi;
use serde::Serialize;
use serde_json::Value;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct GovernanceContextOutput {
    entry_endpoint: String,
    metadata: Value,
    provider_protocol: String,
    metadata_tool_hints: Value,
    inbound_stream_intent: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    raw_request_body: Option<Value>,
}

fn read_trimmed_string(value: Option<&Value>) -> Option<String> {
    let raw = value
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    if raw.is_empty() {
        return None;
    }
    Some(raw)
}

fn normalize_record(value: Option<&Value>) -> Value {
    match value {
        Some(Value::Object(_)) => value
            .cloned()
            .unwrap_or(Value::Object(serde_json::Map::new())),
        _ => Value::Object(serde_json::Map::new()),
    }
}

fn resolve_governance_context(request: Value, context: Value) -> GovernanceContextOutput {
    let request_obj = request.as_object();
    let context_obj = context.as_object();

    let entry_endpoint_raw = context_obj
        .and_then(|obj| obj.get("entryEndpoint"))
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let entry_endpoint = if !entry_endpoint_raw.trim().is_empty() {
        entry_endpoint_raw.to_string()
    } else {
        "/v1/chat/completions".to_string()
    };

    let context_metadata = context_obj.and_then(|obj| obj.get("metadata"));
    let metadata = normalize_record(context_metadata);

    let metadata_obj = metadata.as_object();
    let provider_protocol =
        read_trimmed_string(metadata_obj.and_then(|obj| obj.get("providerProtocol")))
            .or_else(|| read_trimmed_string(metadata_obj.and_then(|obj| obj.get("provider"))))
            .unwrap_or("openai-chat".to_string());

    let metadata_tool_hints = metadata_obj
        .and_then(|obj| obj.get("toolFilterHints"))
        .cloned()
        .unwrap_or(Value::Null);

    let metadata_stream_flag = metadata_obj
        .and_then(|obj| obj.get("stream"))
        .and_then(|v| v.as_bool());
    let request_stream = request_obj
        .and_then(|obj| obj.get("parameters"))
        .and_then(|v| v.as_object())
        .and_then(|params| params.get("stream"))
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let inbound_stream_intent = metadata_stream_flag.unwrap_or(request_stream);

    let raw_request_body = context_obj
        .and_then(|obj| obj.get("metadata"))
        .and_then(|v| v.as_object())
        .and_then(|metadata| metadata.get("__raw_request_body"))
        .and_then(|v| if v.is_object() { Some(v.clone()) } else { None });

    GovernanceContextOutput {
        entry_endpoint,
        metadata,
        provider_protocol,
        metadata_tool_hints,
        inbound_stream_intent,
        raw_request_body,
    }
}

#[napi]
pub fn resolve_governance_context_json(
    request_json: String,
    context_json: String,
) -> NapiResult<String> {
    let request: Value =
        serde_json::from_str(&request_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let context: Value =
        serde_json::from_str(&context_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let output = resolve_governance_context(request, context);
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}
