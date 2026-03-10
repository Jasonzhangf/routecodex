use napi::bindgen_prelude::Result as NapiResult;
use napi_derive::napi;
use serde_json::{Map, Value};

fn normalize_original_endpoint(original_endpoint: String) -> String {
    let trimmed = original_endpoint.trim().to_string();
    if trimmed.is_empty() {
        return "/v1/chat/completions".to_string();
    }
    trimmed
}

fn build_image_attachment_metadata(metadata: Value, original_endpoint: String) -> Value {
    let endpoint = normalize_original_endpoint(original_endpoint);
    let mut out = match metadata {
        Value::Object(obj) => obj,
        _ => {
            let mut obj = Map::new();
            obj.insert("originalEndpoint".to_string(), Value::String(endpoint));
            obj
        }
    };
    out.insert("hasImageAttachment".to_string(), Value::Bool(true));
    Value::Object(out)
}

#[napi]
pub fn build_image_attachment_metadata_json(
    metadata_json: String,
    original_endpoint: String,
) -> NapiResult<String> {
    let metadata: Value = serde_json::from_str(&metadata_json)
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let output = build_image_attachment_metadata(metadata, original_endpoint);
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}
