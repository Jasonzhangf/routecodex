use napi::bindgen_prelude::Result as NapiResult;
use napi_derive::napi;
use serde_json::{Map, Value};

fn as_object(value: &Value) -> Option<&Map<String, Value>> {
    value.as_object()
}

fn normalize_metadata(metadata: Value) -> Map<String, Value> {
    match metadata {
        Value::Object(row) => row,
        _ => Map::new(),
    }
}

fn read_summary_applied(summary: &Value) -> bool {
    summary
        .as_object()
        .and_then(|obj| obj.get("applied"))
        .and_then(|v| v.as_bool())
        .unwrap_or(false)
}

fn merge_governance_summary_into_metadata(metadata: Value, summary: Value) -> Value {
    if !read_summary_applied(&summary) {
        return Value::Object(normalize_metadata(metadata));
    }

    let mut metadata_obj = normalize_metadata(metadata);

    let existing_tool_governance = metadata_obj
        .get("toolGovernance")
        .cloned()
        .unwrap_or(Value::Object(Map::new()));
    let mut tool_governance_obj = match existing_tool_governance {
        Value::Object(row) => row,
        _ => Map::new(),
    };
    if as_object(&summary).is_some() {
        tool_governance_obj.insert("request".to_string(), summary);
    }

    metadata_obj.insert(
        "toolGovernance".to_string(),
        Value::Object(tool_governance_obj),
    );
    Value::Object(metadata_obj)
}

fn finalize_governed_request(request: Value, summary: Value) -> Value {
    let mut request_obj = request.as_object().cloned().unwrap_or_else(Map::new);

    if read_summary_applied(&summary) {
        let metadata = request_obj
            .get("metadata")
            .cloned()
            .unwrap_or(Value::Object(Map::new()));
        let merged = merge_governance_summary_into_metadata(metadata, summary);
        request_obj.insert("metadata".to_string(), merged);
    }

    Value::Object(request_obj)
}

#[napi]
pub fn merge_governance_summary_into_metadata_json(
    metadata_json: String,
    summary_json: String,
) -> NapiResult<String> {
    let metadata: Value = serde_json::from_str(&metadata_json)
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let summary: Value =
        serde_json::from_str(&summary_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let output = merge_governance_summary_into_metadata(metadata, summary);
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi]
pub fn finalize_governed_request_json(
    request_json: String,
    summary_json: String,
) -> NapiResult<String> {
    let request: Value =
        serde_json::from_str(&request_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let summary: Value =
        serde_json::from_str(&summary_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let output = finalize_governed_request(request, summary);
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}
