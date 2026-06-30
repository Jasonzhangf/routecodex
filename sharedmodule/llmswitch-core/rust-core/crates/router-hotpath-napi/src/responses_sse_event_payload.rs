use serde_json::{Map, Value};

fn read_required_created_at(source: &Map<String, Value>) -> Result<Value, String> {
    let Some(created_at) = source.get("created_at") else {
        return Err("Invalid Responses response: missing created_at".to_string());
    };
    if created_at.as_i64().is_some_and(|value| value > 0)
        || created_at.as_u64().is_some_and(|value| value > 0)
    {
        return Ok(created_at.clone());
    }
    Err("Invalid Responses response: missing created_at".to_string())
}

fn read_required_usage_token(usage: &Map<String, Value>, field: &str) -> Result<i64, String> {
    let Some(value) = usage.get(field) else {
        return Err("Invalid Responses usage: missing token fields".to_string());
    };
    let parsed = match value {
        Value::Number(number) => number.as_f64(),
        Value::String(text) => text.trim().parse::<f64>().ok(),
        _ => None,
    };
    let Some(number) = parsed else {
        return Err(format!("Invalid Responses usage.{}", field));
    };
    if !number.is_finite() || number < 0.0 {
        return Err(format!("Invalid Responses usage.{}", field));
    }
    Ok(number.round() as i64)
}

fn normalize_strict_responses_usage(usage_raw: &Value) -> Result<Value, String> {
    let Some(usage) = usage_raw.as_object() else {
        return Err("Invalid Responses usage: expected object".to_string());
    };
    let input_tokens = read_required_usage_token(usage, "input_tokens")?;
    let output_tokens = read_required_usage_token(usage, "output_tokens")?;
    let total_tokens = read_required_usage_token(usage, "total_tokens")?;

    let mut out = Map::new();
    out.insert("input_tokens".to_string(), Value::from(input_tokens));
    out.insert("output_tokens".to_string(), Value::from(output_tokens));
    out.insert("total_tokens".to_string(), Value::from(total_tokens));

    if let Some(details_raw) = usage.get("input_tokens_details") {
        let Some(details) = details_raw.as_object() else {
            return Err("Invalid Responses usage cached_tokens".to_string());
        };
        if let Some(cached_raw) = details.get("cached_tokens") {
            let parsed = match cached_raw {
                Value::Number(number) => number.as_f64(),
                Value::String(text) => text.trim().parse::<f64>().ok(),
                _ => None,
            };
            let Some(cached) = parsed else {
                return Err("Invalid Responses usage cached_tokens".to_string());
            };
            if !cached.is_finite() || cached < 0.0 {
                return Err("Invalid Responses usage cached_tokens".to_string());
            }
            let mut details_out = Map::new();
            details_out.insert(
                "cached_tokens".to_string(),
                Value::from(cached.round() as i64),
            );
            out.insert(
                "input_tokens_details".to_string(),
                Value::Object(details_out),
            );
        }
    }

    Ok(Value::Object(out))
}

fn event_type(input: &Map<String, Value>) -> Result<&str, String> {
    input
        .get("type")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "Responses SSE event missing type".to_string())
}

fn read_sequence_number(input: &Map<String, Value>) -> Option<Value> {
    input.get("sequenceNumber").cloned()
}

fn data_object(input: &Map<String, Value>, event_type: &str) -> Result<Map<String, Value>, String> {
    match input.get("data") {
        Some(Value::Object(map)) => Ok(map.clone()),
        _ => Err(format!(
            "Responses event payload must be an object before serialization: {}",
            event_type
        )),
    }
}

pub fn canonicalize_responses_sse_event_payload(value: Value) -> Result<Value, String> {
    let mut event = match value {
        Value::Object(map) => map,
        _ => return Err("Responses SSE event must be an object".to_string()),
    };
    let event_type_owned = event_type(&event)?.to_string();
    let mut data = data_object(&event, &event_type_owned)?;
    if let Some(Value::String(payload_type)) = data.get("type") {
        if payload_type != &event_type_owned {
            return Err(format!(
                "Responses event payload type mismatch: event={} payload={}",
                event_type_owned, payload_type
            ));
        }
    } else if data.contains_key("type") {
        return Err(format!(
            "Responses event payload type must be a string: {}",
            event_type_owned
        ));
    }

    data.insert("type".to_string(), Value::String(event_type_owned));
    if !data.contains_key("sequence_number") {
        if let Some(sequence_number) = read_sequence_number(&event) {
            data.insert("sequence_number".to_string(), sequence_number);
        }
    }
    event.insert("data".to_string(), Value::Object(data));
    Ok(Value::Object(event))
}

pub fn canonicalize_responses_sse_event_payload_json(input_json: String) -> Result<String, String> {
    let input: Value = serde_json::from_str(&input_json)
        .map_err(|error| format!("Failed to parse Responses SSE event JSON: {}", error))?;
    let output = canonicalize_responses_sse_event_payload(input)?;
    serde_json::to_string(&output)
        .map_err(|error| format!("Failed to serialize Responses SSE event JSON: {}", error))
}

pub fn normalize_responses_sse_response_payload(
    response: Value,
    status: Option<&str>,
) -> Result<Value, String> {
    let source = match response {
        Value::Object(map) => map,
        _ => return Err("Invalid Responses response payload: expected object".to_string()),
    };

    let mut payload_row = source.clone();

    if !payload_row.contains_key("object") || payload_row.get("object").is_none_or(Value::is_null) {
        payload_row.insert("object".to_string(), Value::String("response".to_string()));
    }
    payload_row.insert("created_at".to_string(), read_required_created_at(&source)?);
    payload_row.insert(
        "status".to_string(),
        Value::String(status.unwrap_or("in_progress").to_string()),
    );
    if !payload_row.contains_key("output") {
        payload_row.insert("output".to_string(), Value::Array(Vec::new()));
    }
    if !payload_row.contains_key("background") {
        payload_row.insert("background".to_string(), Value::Bool(false));
    }
    if !payload_row.contains_key("error") {
        payload_row.insert("error".to_string(), Value::Null);
    }
    if !payload_row.contains_key("incomplete_details") {
        payload_row.insert("incomplete_details".to_string(), Value::Null);
    }

    if let Some(usage_raw) = payload_row.get("usage").cloned() {
        payload_row.insert(
            "usage".to_string(),
            normalize_strict_responses_usage(&usage_raw)?,
        );
    }

    Ok(Value::Object(payload_row))
}

pub fn normalize_responses_sse_response_payload_json(
    response_json: String,
    status_json: Option<String>,
) -> Result<String, String> {
    let response: Value = serde_json::from_str(&response_json)
        .map_err(|error| format!("Failed to parse Responses response JSON: {}", error))?;
    let status = status_json
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let output = normalize_responses_sse_response_payload(response, status)?;
    serde_json::to_string(&output)
        .map_err(|error| format!("Failed to serialize Responses response JSON: {}", error))
}

pub fn build_responses_sse_error_payload(message: &str) -> Result<Value, String> {
    let trimmed = message.trim();
    if trimmed.is_empty() {
        return Err("Responses SSE error message is required".to_string());
    }
    Ok(serde_json::json!({
        "error": {
            "message": trimmed,
            "type": "internal_error",
            "code": "generation_error"
        }
    }))
}

pub fn build_responses_sse_error_payload_json(message_json: String) -> Result<String, String> {
    let message: Value = serde_json::from_str(&message_json)
        .map_err(|error| format!("Failed to parse Responses SSE error message JSON: {}", error))?;
    let Some(message_text) = message.as_str() else {
        return Err("Responses SSE error message must be a string".to_string());
    };
    let output = build_responses_sse_error_payload(message_text)?;
    serde_json::to_string(&output)
        .map_err(|error| format!("Failed to serialize Responses SSE error payload JSON: {}", error))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn canonicalizes_missing_payload_type_and_sequence_number() {
        let output = canonicalize_responses_sse_event_payload(json!({
            "type": "response.completed",
            "sequenceNumber": 7,
            "data": {
                "response": { "id": "resp_1" }
            }
        }))
        .unwrap();

        assert_eq!(output["data"]["type"], json!("response.completed"));
        assert_eq!(output["data"]["sequence_number"], json!(7));
        assert_eq!(output["data"]["response"]["id"], json!("resp_1"));
    }

    #[test]
    fn rejects_payload_type_mismatch() {
        let err = canonicalize_responses_sse_event_payload(json!({
            "type": "response.completed",
            "data": { "type": "response.error" }
        }))
        .unwrap_err();

        assert!(err.contains("Responses event payload type mismatch"));
    }

    #[test]
    fn rejects_scalar_payload() {
        let err = canonicalize_responses_sse_event_payload(json!({
            "type": "response.output_text.delta",
            "data": "hello"
        }))
        .unwrap_err();

        assert!(err.contains("Responses event payload must be an object"));
    }

    #[test]
    fn normalizes_responses_sse_response_payload_with_strict_usage() {
        let output = normalize_responses_sse_response_payload(
            json!({
                "id": "resp_sse_payload_1",
                "object": "response",
                "created_at": 1781149537,
                "status": "completed",
                "model": "gpt-test",
                "output": [],
                "usage": {
                    "input_tokens": "10",
                    "output_tokens": 5,
                    "total_tokens": 15,
                    "input_tokens_details": { "cached_tokens": "7" }
                }
            }),
            Some("completed"),
        )
        .unwrap();

        assert_eq!(output["status"], json!("completed"));
        assert_eq!(output["background"], json!(false));
        assert_eq!(output["error"], Value::Null);
        assert_eq!(output["usage"]["input_tokens"], json!(10));
        assert_eq!(
            output["usage"]["input_tokens_details"]["cached_tokens"],
            json!(7)
        );
    }

    #[test]
    fn rejects_responses_sse_response_payload_usage_aliases() {
        let err = normalize_responses_sse_response_payload(
            json!({
                "id": "resp_sse_payload_alias",
                "object": "response",
                "created_at": 1781149537,
                "status": "completed",
                "model": "gpt-test",
                "output": [],
                "usage": {
                    "prompt_tokens": 10,
                    "completion_tokens": 5,
                    "total_tokens": 15
                }
            }),
            Some("completed"),
        )
        .unwrap_err();

        assert!(err.contains("Invalid Responses usage: missing token fields"));
    }

    #[test]
    fn rejects_responses_sse_response_payload_missing_created_at() {
        let err = normalize_responses_sse_response_payload(
            json!({
                "id": "resp_sse_payload_missing_created",
                "object": "response",
                "status": "completed",
                "model": "gpt-test",
                "output": []
            }),
            Some("completed"),
        )
        .unwrap_err();

        assert!(err.contains("Invalid Responses response: missing created_at"));
    }

    #[test]
    fn builds_responses_sse_error_payload() {
        let output = build_responses_sse_error_payload("  upstream failed  ").unwrap();

        assert_eq!(output["error"]["message"], json!("upstream failed"));
        assert_eq!(output["error"]["type"], json!("internal_error"));
        assert_eq!(output["error"]["code"], json!("generation_error"));
    }

    #[test]
    fn rejects_empty_responses_sse_error_message() {
        let err = build_responses_sse_error_payload("   ").unwrap_err();

        assert!(err.contains("Responses SSE error message is required"));
    }
}
