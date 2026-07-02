use serde_json::{Map, Value};

fn read_input_object(input_json: String, label: &str) -> Result<Map<String, Value>, String> {
    let input: Value = serde_json::from_str(&input_json)
        .map_err(|error| format!("Failed to parse {} JSON: {}", label, error))?;
    input
        .as_object()
        .cloned()
        .ok_or_else(|| format!("{} expected object", label))
}

fn read_config_string<'a>(config: &'a Map<String, Value>, field: &str) -> Option<&'a str> {
    config
        .get(field)
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
}

fn read_reasoning_mode(config: &Map<String, Value>) -> &str {
    read_config_string(config, "reasoningMode").unwrap_or("channel")
}

fn format_reasoning_text(text: &str, config: &Map<String, Value>) -> String {
    let trimmed = text.trim();
    let Some(prefix) = read_config_string(config, "reasoningTextPrefix") else {
        return trimmed.to_string();
    };
    if prefix.ends_with(' ') || prefix.ends_with('\n') {
        format!("{}{}", prefix, trimmed)
    } else {
        format!("{} {}", prefix, trimmed)
    }
}

fn normalize_reasoning_part(
    part: &Value,
    part_index: usize,
    config: &Map<String, Value>,
) -> Result<Vec<Value>, String> {
    let Some(part_obj) = part.as_object() else {
        return Err(format!(
            "Invalid Gemini candidate part at index {}",
            part_index
        ));
    };
    let Some(reasoning) = part_obj.get("reasoning").and_then(Value::as_str) else {
        return Ok(vec![part.clone()]);
    };
    let trimmed = reasoning.trim();
    if trimmed.is_empty() {
        return Ok(vec![part.clone()]);
    }
    match read_reasoning_mode(config) {
        "drop" => Ok(Vec::new()),
        "text" => Ok(vec![serde_json::json!({
            "text": format_reasoning_text(trimmed, config)
        })]),
        _ => Ok(vec![serde_json::json!({
            "reasoning": trimmed
        })]),
    }
}

fn build_gemini_event(event_type: &str, data: Value) -> Value {
    serde_json::json!({
        "type": event_type,
        "event": event_type,
        "protocol": "gemini-chat",
        "direction": "json_to_sse",
        "data": data
    })
}

pub fn build_gemini_sse_event_sequence_json(input_json: String) -> Result<String, String> {
    let input = read_input_object(input_json, "Gemini SSE event sequence")?;
    let response = input
        .get("response")
        .and_then(Value::as_object)
        .ok_or_else(|| "Gemini SSE event sequence missing response".to_string())?;
    let config = input
        .get("config")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let candidates = response
        .get("candidates")
        .and_then(Value::as_array)
        .ok_or_else(|| "Invalid Gemini response: missing candidates".to_string())?;

    let mut events: Vec<Value> = Vec::new();
    for (candidate_index, candidate) in candidates.iter().enumerate() {
        let candidate = candidate
            .as_object()
            .ok_or_else(|| format!("Invalid Gemini candidate at index {}", candidate_index))?;
        let content = candidate
            .get("content")
            .and_then(Value::as_object)
            .ok_or_else(|| "Invalid Gemini candidate: missing content".to_string())?;
        let role = content
            .get("role")
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| "Invalid Gemini candidate: missing role".to_string())?;
        let parts = content
            .get("parts")
            .and_then(Value::as_array)
            .ok_or_else(|| "Invalid Gemini candidate: missing parts".to_string())?;

        for (part_index, part) in parts.iter().enumerate() {
            let normalized_parts = normalize_reasoning_part(part, part_index, &config)?;
            for normalized_part in normalized_parts {
                events.push(build_gemini_event(
                    "gemini.data",
                    serde_json::json!({
                        "kind": "part",
                        "candidateIndex": candidate_index,
                        "partIndex": part_index,
                        "role": role,
                        "part": normalized_part
                    }),
                ));
            }
        }
    }

    let mut done_candidates: Vec<Value> = Vec::new();
    for (index, candidate) in candidates.iter().enumerate() {
        let candidate = candidate
            .as_object()
            .ok_or_else(|| format!("Invalid Gemini candidate at index {}", index))?;
        let mut row = Map::new();
        row.insert("index".to_string(), Value::from(index as i64));
        if let Some(finish_reason) = candidate.get("finishReason") {
            row.insert("finishReason".to_string(), finish_reason.clone());
        }
        if let Some(safety_ratings) = candidate.get("safetyRatings") {
            row.insert("safetyRatings".to_string(), safety_ratings.clone());
        }
        done_candidates.push(Value::Object(row));
    }

    let mut done_data = Map::new();
    done_data.insert("kind".to_string(), Value::String("done".to_string()));
    if let Some(usage_metadata) = response.get("usageMetadata") {
        done_data.insert("usageMetadata".to_string(), usage_metadata.clone());
    }
    if let Some(prompt_feedback) = response.get("promptFeedback") {
        done_data.insert("promptFeedback".to_string(), prompt_feedback.clone());
    }
    if let Some(model_version) = response.get("modelVersion") {
        done_data.insert("modelVersion".to_string(), model_version.clone());
    }
    done_data.insert("candidates".to_string(), Value::Array(done_candidates));
    events.push(build_gemini_event("gemini.done", Value::Object(done_data)));

    serde_json::to_string(&events)
        .map_err(|error| format!("Failed to serialize Gemini SSE event sequence JSON: {}", error))
}

#[cfg(test)]
mod tests {
    use super::build_gemini_sse_event_sequence_json;
    use serde_json::json;

    #[test]
    fn builds_gemini_sse_event_sequence_for_text() {
        let output = build_gemini_sse_event_sequence_json(
            json!({
                "response": {
                    "candidates": [{
                        "content": {
                            "role": "model",
                            "parts": [{ "text": "hello" }]
                        },
                        "finishReason": "STOP"
                    }]
                }
            })
            .to_string(),
        )
        .unwrap();
        let events: serde_json::Value = serde_json::from_str(&output).unwrap();
        assert_eq!(events[0]["type"], "gemini.data");
        assert_eq!(events[0]["data"]["part"]["text"], "hello");
        assert_eq!(events[1]["type"], "gemini.done");
    }

    #[test]
    fn builds_gemini_sse_event_sequence_projects_reasoning_to_text() {
        let output = build_gemini_sse_event_sequence_json(
            json!({
                "response": {
                    "candidates": [{
                        "content": {
                            "role": "model",
                            "parts": [{ "reasoning": "hidden" }]
                        }
                    }]
                },
                "config": {
                    "reasoningMode": "text",
                    "reasoningTextPrefix": "[thought]"
                }
            })
            .to_string(),
        )
        .unwrap();
        let events: serde_json::Value = serde_json::from_str(&output).unwrap();
        assert_eq!(events[0]["data"]["part"]["text"], "[thought] hidden");
    }

    #[test]
    fn build_gemini_sse_event_sequence_rejects_missing_role() {
        let err = build_gemini_sse_event_sequence_json(
            json!({
                "response": {
                    "candidates": [{
                        "content": {
                            "parts": [{ "text": "hello" }]
                        }
                    }]
                }
            })
            .to_string(),
        )
        .unwrap_err();
        assert!(err.contains("Invalid Gemini candidate: missing role"));
    }
}
