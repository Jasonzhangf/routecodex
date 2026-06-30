use serde_json::{Map, Value};

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
}
