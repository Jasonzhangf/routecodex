//! Hub submit tool outputs NAPI bridge.
//! Rust SSOT for building /v1/responses.submit_tool_outputs payloads.

use napi::bindgen_prelude::Result as NapiResult;
use napi_derive::napi;
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Input for building a submit_tool_outputs payload.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubmitToolOutputsInput {
    pub chat_envelope: Value,
    pub adapter_context: Value,
    pub responses_context: Value,
}

/// Output: the built submit_tool_outputs payload.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubmitToolOutputsOutput {
    pub response_id: String,
    pub tool_outputs: Vec<SubmitToolOutputEntry>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stream: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<Value>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubmitToolOutputEntry {
    pub tool_call_id: String,
    #[serde(rename = "id")]
    pub entry_id: String,
    pub output: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
}

fn read_trimmed_string(value: Option<&Value>) -> Option<String> {
    let raw = value.and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
    if raw.is_empty() { None } else { Some(raw) }
}

fn normalize_output_text(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Null) | None => String::new(),
        Some(other) => serde_json::to_string(other).unwrap_or_else(|_| String::from("[object Object]")),
    }
}

fn resolve_submit_response_id(responses_context: &Value) -> Option<String> {
    let ctx = responses_context.as_object()?;
    read_trimmed_string(ctx.get("previous_response_id"))
}

fn collect_tool_outputs(chat_envelope: &Value) -> Vec<(String, String, Option<String>)> {
    let mut results: Vec<(String, String, Option<String>)> = Vec::new();
    let mut seen = std::collections::HashSet::new();

    if let Some(outputs) = chat_envelope.get("toolOutputs").and_then(|v| v.as_array()) {
        for entry in outputs {
            let row = match entry.as_object() {
                Some(r) => r,
                None => continue,
            };
            let id = read_trimmed_string(row.get("tool_call_id"))
                .or_else(|| read_trimmed_string(row.get("call_id")))
                .or_else(|| read_trimmed_string(row.get("id")));
            let Some(id) = id else { continue; };
            if seen.contains(&id) { continue; }
            seen.insert(id.clone());
            let content = normalize_output_text(row.get("content"));
            let name = read_trimmed_string(row.get("name"));
            results.push((id, content, name));
        }
    }

    let internal_ctx = responses_context_internal(chat_envelope);
    if let Some(ctx) = internal_ctx.as_ref().and_then(|v| v.as_object()) {
        if let Some(captured) = ctx.get("__captured_tool_results").and_then(|v| v.as_array()) {
            for entry in captured {
                let row = match entry.as_object() {
                    Some(r) => r,
                    None => continue,
                };
                let id = match read_trimmed_string(row.get("tool_call_id")) {
                    Some(v) => Some(v),
                    None => read_trimmed_string(row.get("call_id")),
                };
                let Some(id) = id else { continue; };
                if seen.contains(&id) { continue; }
                seen.insert(id.clone());
                let content = normalize_output_text(row.get("output"));
                let name = read_trimmed_string(row.get("name"));
                results.push((id, content, name));
            }
        }
    }

    results
}

fn responses_context_internal(chat_envelope: &Value) -> Option<&Value> {
    chat_envelope
        .get("metadata")
        .and_then(|v| v.as_object())
        .and_then(|obj| obj.get("responsesContext"))
}

fn build_submit_tool_outputs_payload(input: SubmitToolOutputsInput) -> Result<SubmitToolOutputsOutput, String> {
    let response_id = resolve_submit_response_id(&input.responses_context)
        .ok_or_else(|| "Submit tool outputs requires response_id from Responses context".to_string())?;

    let outputs_raw = collect_tool_outputs(&input.chat_envelope);
    if outputs_raw.is_empty() {
        return Err("Submit tool outputs requires at least one tool output entry".to_string());
    }

    let tool_outputs: Vec<SubmitToolOutputEntry> = outputs_raw
        .into_iter()
        .map(|(id, content, name)| SubmitToolOutputEntry {
            tool_call_id: id.clone(),
            entry_id: id,
            output: content,
            name,
        })
        .collect();

    let model = input.chat_envelope
        .get("parameters")
        .and_then(|v| v.as_object())
        .and_then(|obj| read_trimmed_string(obj.get("model")));

    let stream = input.chat_envelope
        .get("parameters")
        .and_then(|v| v.as_object())
        .and_then(|obj| obj.get("stream").and_then(|v| v.as_bool()));

    Ok(SubmitToolOutputsOutput {
        response_id,
        tool_outputs,
        model,
        stream,
        metadata: None,
    })
}

#[napi]
pub fn build_submit_tool_outputs_payload_json(input_json: String) -> NapiResult<String> {
    let input: SubmitToolOutputsInput = serde_json::from_str(&input_json)
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let output = build_submit_tool_outputs_payload(input)
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}
