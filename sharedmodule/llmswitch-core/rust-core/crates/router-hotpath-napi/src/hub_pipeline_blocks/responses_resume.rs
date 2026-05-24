use serde_json::{Map, Value};

use crate::shared_json_utils::read_trimmed_string;

pub(crate) fn read_responses_resume_from_metadata(metadata: &Value) -> Option<Value> {
    let metadata_obj = metadata.as_object()?;
    let resume = metadata_obj.get("responsesResume")?;
    if !resume.is_object() {
        return None;
    }
    Some(resume.clone())
}

pub(crate) fn read_responses_resume_from_request_semantics(request: &Value) -> Option<Value> {
    let request_obj = request.as_object()?;
    let semantics_obj = request_obj.get("semantics")?.as_object()?;
    let responses_obj = semantics_obj.get("responses")?.as_object()?;
    let resume = responses_obj.get("resume")?;
    if !resume.is_object() {
        return None;
    }
    Some(resume.clone())
}

pub(crate) fn read_continuation_from_semantics_node(semantics: Option<&Value>) -> Option<Value> {
    let semantics_obj = semantics?.as_object()?;
    let continuation = semantics_obj.get("continuation")?;
    if !continuation.is_object() {
        return None;
    }
    Some(continuation.clone())
}

pub(crate) fn read_responses_resume_from_semantics_node(
    semantics: Option<&Value>,
) -> Option<Value> {
    let semantics_obj = semantics?.as_object()?;
    let responses_obj = semantics_obj.get("responses")?.as_object()?;
    let resume = responses_obj.get("resume")?;
    if !resume.is_object() {
        return None;
    }
    Some(resume.clone())
}

pub(crate) fn synthesize_continuation_from_responses_resume(
    resume: Option<&Value>,
) -> Option<Value> {
    let resume_obj = resume?.as_object()?;
    let previous_request_id = read_trimmed_string(resume_obj.get("previousRequestId"));
    let restored_from_response_id = read_trimmed_string(resume_obj.get("restoredFromResponseId"));
    let route_hint = read_trimmed_string(resume_obj.get("routeHint"));

    let mut continuation = Map::<String, Value>::new();
    if let Some(chain_id) = previous_request_id
        .clone()
        .or_else(|| restored_from_response_id.clone())
    {
        continuation.insert("chainId".to_string(), Value::String(chain_id));
    }

    let mut resume_from = Map::<String, Value>::new();
    resume_from.insert(
        "protocol".to_string(),
        Value::String("openai-responses".to_string()),
    );
    if let Some(request_id) = previous_request_id {
        resume_from.insert("requestId".to_string(), Value::String(request_id));
    }
    if let Some(response_id) = restored_from_response_id {
        resume_from.insert("responseId".to_string(), Value::String(response_id));
    }
    if !resume_from.is_empty() {
        continuation.insert("resumeFrom".to_string(), Value::Object(resume_from));
    }
    if let Some(route_hint_value) = route_hint.clone() {
        continuation.insert("routeHint".to_string(), Value::String(route_hint_value));
    }

    let mapped_outputs = read_resume_tool_outputs_detailed(resume_obj);
    if !mapped_outputs.is_empty() {
        let mut tool_continuation = Map::<String, Value>::new();
        tool_continuation.insert(
            "mode".to_string(),
            Value::String("submit_tool_outputs".to_string()),
        );
        if !mapped_outputs.is_empty() {
            let submitted_ids = mapped_outputs
                .iter()
                .map(|entry| Value::String(entry.0.clone()))
                .collect::<Vec<_>>();
            tool_continuation.insert(
                "submittedToolCallIds".to_string(),
                Value::Array(submitted_ids),
            );
            let resume_outputs = mapped_outputs
                .iter()
                .map(|entry| Value::String(entry.1.clone()))
                .collect::<Vec<_>>();
            tool_continuation.insert("resumeOutputs".to_string(), Value::Array(resume_outputs));
        }
        continuation.insert(
            "toolContinuation".to_string(),
            Value::Object(tool_continuation),
        );
    }

    if continuation.is_empty() {
        return None;
    }

    continuation.insert(
        "stickyScope".to_string(),
        Value::String("request_chain".to_string()),
    );
    continuation.insert(
        "stateOrigin".to_string(),
        Value::String("openai-responses".to_string()),
    );
    continuation.insert("restored".to_string(), Value::Bool(true));
    Some(Value::Object(continuation))
}

pub(crate) fn lift_responses_resume_into_semantics(request: &Value, metadata: &Value) -> Value {
    let mut output = Map::<String, Value>::new();
    let mut next_metadata = value_as_object_or_empty(metadata);
    let resume = read_responses_resume_from_metadata(metadata);
    let continuation = synthesize_continuation_from_responses_resume(resume.as_ref());

    if resume.is_none() && continuation.is_none() {
        output.insert("request".to_string(), request.clone());
        output.insert("metadata".to_string(), Value::Object(next_metadata));
        return Value::Object(output);
    }

    let mut next_request = value_as_object_or_empty(request);
    let semantics = next_request
        .entry("semantics".to_string())
        .or_insert_with(|| Value::Object(Map::new()));
    if !semantics.is_object() {
        *semantics = Value::Object(Map::new());
    }
    let semantics_obj = semantics
        .as_object_mut()
        .expect("semantics should be object after normalization");
    if !semantics_obj.contains_key("continuation") {
        if let Some(continuation_value) = continuation {
            semantics_obj.insert("continuation".to_string(), continuation_value);
        }
    }
    let responses = semantics_obj
        .entry("responses".to_string())
        .or_insert_with(|| Value::Object(Map::new()));
    if !responses.is_object() {
        *responses = Value::Object(Map::new());
    }
    let responses_obj = responses
        .as_object_mut()
        .expect("responses should be object after normalization");
    if !responses_obj.contains_key("resume") {
        if let Some(mut resume_value) = resume {
            if let Some(resume_obj) = resume_value.as_object_mut() {
                if !resume_obj.contains_key("routeHint") {
                    if let Some(route_hint) =
                        read_trimmed_string(next_metadata.get("routeHint"))
                    {
                        resume_obj.insert("routeHint".to_string(), Value::String(route_hint));
                    }
                }
            }
            responses_obj.insert("resume".to_string(), resume_value);
        }
    }

    if next_metadata.contains_key("responsesResume") {
        next_metadata.insert("responsesResume".to_string(), Value::Null);
    }
    output.insert("request".to_string(), Value::Object(next_request));
    output.insert("metadata".to_string(), Value::Object(next_metadata));
    Value::Object(output)
}

fn normalize_resume_output_text(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Null) | None => "\"\"".to_string(),
        Some(other) => {
            serde_json::to_string(other).unwrap_or_else(|_| "[object Object]".to_string())
        }
    }
}

fn read_resume_tool_outputs_detailed(resume_obj: &Map<String, Value>) -> Vec<(String, String)> {
    let detailed = resume_obj
        .get("toolOutputsDetailed")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    if detailed.is_empty() {
        return Vec::new();
    }

    let mut mapped: Vec<(String, String)> = Vec::new();
    for (index, entry) in detailed.iter().enumerate() {
        let Some(row) = entry.as_object() else {
            continue;
        };
        let call_id = read_trimmed_string(row.get("callId"))
            .or_else(|| read_trimmed_string(row.get("originalId")))
            .unwrap_or_else(|| format!("resume_tool_{}", index + 1));
        let output_text = normalize_resume_output_text(row.get("outputText"));
        mapped.push((call_id, output_text));
    }

    mapped
}

fn value_as_object_or_empty(value: &Value) -> Map<String, Value> {
    value.as_object().cloned().unwrap_or_default()
}
