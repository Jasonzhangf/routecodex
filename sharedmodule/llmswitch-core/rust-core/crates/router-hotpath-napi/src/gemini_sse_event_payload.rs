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

fn parse_gemini_sse_blocks(body_text: &str) -> Result<Vec<(String, Value)>, String> {
    let mut events = Vec::new();
    let normalized = body_text.replace("\r\n", "\n");
    for block in normalized.split("\n\n") {
        if block.trim().is_empty() {
            continue;
        }
        let mut event_name = String::new();
        let mut data_lines = Vec::new();
        for line in block.lines() {
            if let Some(rest) = line.strip_prefix("event:") {
                event_name = rest.trim().to_string();
            } else if let Some(rest) = line.strip_prefix("data:") {
                data_lines.push(rest.trim_start().to_string());
            }
        }
        if event_name.is_empty() {
            return Err("Gemini SSE event missing event type".to_string());
        }
        if data_lines.is_empty() {
            return Err(format!("Gemini SSE event missing data: {}", event_name));
        }
        let data_text = data_lines.join("\n");
        let value: Value = serde_json::from_str(&data_text)
            .map_err(|error| format!("Failed to parse Gemini SSE event JSON: {}", error))?;
        events.push((event_name, value));
    }
    Ok(events)
}

fn read_event_protocol(event_obj: &Map<String, Value>) -> Result<(), String> {
    if let Some(protocol) = event_obj.get("protocol").and_then(Value::as_str) {
        if protocol != "gemini-chat" {
            return Err(format!("Unexpected Gemini SSE protocol: {}", protocol));
        }
    }
    Ok(())
}

fn event_payload<'a>(event_obj: &'a Map<String, Value>) -> &'a Map<String, Value> {
    event_obj
        .get("data")
        .and_then(Value::as_object)
        .unwrap_or(event_obj)
}

fn read_required_i64(
    source: &Map<String, Value>,
    field: &str,
    message: &str,
) -> Result<i64, String> {
    source
        .get(field)
        .and_then(Value::as_i64)
        .ok_or_else(|| message.to_string())
}

fn read_required_payload_part<'a>(payload: &'a Map<String, Value>) -> Result<&'a Value, String> {
    payload
        .get("part")
        .ok_or_else(|| "Invalid Gemini data event: missing part".to_string())
}

fn read_decode_part_index(payload: &Map<String, Value>, candidate_index: i64) -> usize {
    payload
        .get("partIndex")
        .and_then(Value::as_i64)
        .and_then(|value| usize::try_from(value).ok())
        .unwrap_or_else(|| usize::try_from(candidate_index).unwrap_or(0))
}

fn merge_gemini_part(parts: &mut Vec<Value>, part: Value) {
    if let Some(text) = part.get("text").and_then(Value::as_str) {
        if let Some(last) = parts.last_mut().and_then(Value::as_object_mut) {
            if let Some(last_text) = last.get_mut("text").and_then(|value| value.as_str()) {
                let merged = format!("{}{}", last_text, text);
                last.insert("text".to_string(), Value::String(merged));
                return;
            }
        }
    }
    if let Some(reasoning) = part.get("reasoning").and_then(Value::as_str) {
        if let Some(last) = parts.last_mut().and_then(Value::as_object_mut) {
            if let Some(last_reasoning) = last.get_mut("reasoning").and_then(|value| value.as_str())
            {
                let merged = format!("{}{}", last_reasoning, reasoning);
                last.insert("reasoning".to_string(), Value::String(merged));
                return;
            }
        }
    }
    parts.push(part);
}

#[derive(Default)]
struct GeminiCandidateAccumulator {
    role: String,
    parts: Vec<Value>,
}

pub fn build_gemini_json_from_sse_json(input_json: String) -> Result<String, String> {
    let input = read_input_object(input_json, "Gemini SSE decode")?;
    let body_text = input
        .get("body_text")
        .and_then(Value::as_str)
        .ok_or_else(|| "Gemini SSE decode missing body_text".to_string())?;
    let config = input
        .get("config")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();

    let mut accumulators: std::collections::BTreeMap<i64, GeminiCandidateAccumulator> =
        std::collections::BTreeMap::new();
    let mut done_payload: Option<Map<String, Value>> = None;

    for (event_name, event_value) in parse_gemini_sse_blocks(body_text)? {
        let event_obj = event_value
            .as_object()
            .ok_or_else(|| "Gemini SSE event payload expected object".to_string())?;
        read_event_protocol(event_obj)?;
        let event_type = event_obj
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or(event_name.as_str());
        if event_name != event_type && !event_type.trim().is_empty() {
            return Err(format!(
                "Gemini SSE event type mismatch: event={} payload={}",
                event_name, event_type
            ));
        }
        let payload = event_payload(event_obj);
        match event_name.as_str() {
            "gemini.data" => {
                let candidate_index = read_required_i64(
                    payload,
                    "candidateIndex",
                    "Invalid Gemini data event: missing candidateIndex",
                )?;
                let part = read_required_payload_part(payload)?;
                let part_index = read_decode_part_index(payload, candidate_index);
                if !part.is_object() {
                    return Err(format!(
                        "Invalid Gemini data event: invalid part at index {}",
                        part_index
                    ));
                }
                let role = payload
                    .get("role")
                    .and_then(Value::as_str)
                    .filter(|value| !value.trim().is_empty())
                    .ok_or_else(|| "Invalid Gemini data event: missing role".to_string())?;
                let entry = accumulators.entry(candidate_index).or_insert_with(|| {
                    GeminiCandidateAccumulator {
                        role: role.to_string(),
                        parts: Vec::new(),
                    }
                });
                let normalized_parts = normalize_reasoning_part(part, part_index, &config)?;
                for normalized_part in normalized_parts {
                    merge_gemini_part(&mut entry.parts, normalized_part);
                }
            }
            "gemini.done" => {
                done_payload = Some(payload.clone());
            }
            other => {
                return Err(format!("Unsupported Gemini SSE event type: {}", other));
            }
        }
    }

    let done_payload =
        done_payload.ok_or_else(|| "Gemini SSE stream missing done event".to_string())?;
    let done_candidates = done_payload
        .get("candidates")
        .and_then(Value::as_array)
        .ok_or_else(|| "Invalid Gemini done event: missing candidates".to_string())?;
    let mut candidate_meta: std::collections::BTreeMap<i64, Map<String, Value>> =
        std::collections::BTreeMap::new();
    for (done_index, entry) in done_candidates.iter().enumerate() {
        let entry_obj = entry.as_object().ok_or_else(|| {
            format!(
                "Invalid Gemini done event: invalid candidate at index {}",
                done_index
            )
        })?;
        let index = entry_obj
            .get("index")
            .and_then(Value::as_i64)
            .ok_or_else(|| {
                format!(
                    "Invalid Gemini done event: invalid candidate at index {}",
                    done_index
                )
            })?;
        candidate_meta.insert(index, entry_obj.clone());
    }

    let mut candidates = Vec::new();
    for (index, acc) in accumulators {
        let mut candidate = Map::new();
        candidate.insert(
            "content".to_string(),
            serde_json::json!({
                "role": acc.role,
                "parts": acc.parts
            }),
        );
        if let Some(meta) = candidate_meta.get(&index) {
            if let Some(finish_reason) = meta.get("finishReason") {
                candidate.insert("finishReason".to_string(), finish_reason.clone());
            }
            if let Some(safety_ratings) = meta.get("safetyRatings") {
                candidate.insert("safetyRatings".to_string(), safety_ratings.clone());
            }
        }
        candidates.push(Value::Object(candidate));
    }

    let mut response = Map::new();
    response.insert("candidates".to_string(), Value::Array(candidates));
    if let Some(prompt_feedback) = done_payload.get("promptFeedback") {
        response.insert("promptFeedback".to_string(), prompt_feedback.clone());
    }
    if let Some(usage_metadata) = done_payload.get("usageMetadata") {
        response.insert("usageMetadata".to_string(), usage_metadata.clone());
    }
    if let Some(model_version) = done_payload.get("modelVersion") {
        response.insert("modelVersion".to_string(), model_version.clone());
    }
    serde_json::to_string(&Value::Object(response))
        .map_err(|error| format!("Failed to serialize Gemini SSE decode JSON: {}", error))
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

    serde_json::to_string(&events).map_err(|error| {
        format!(
            "Failed to serialize Gemini SSE event sequence JSON: {}",
            error
        )
    })
}

pub fn build_gemini_sse_stream_json(input_json: String) -> Result<String, String> {
    let events_json = build_gemini_sse_event_sequence_json(input_json.clone())?;
    let events: Vec<Value> = serde_json::from_str(&events_json)
        .map_err(|error| format!("Failed to deserialize gemini SSE events: {}", error))?;
    let input = read_input_object(input_json, "gemini SSE stream")?;
    let response = input
        .get("response")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let mut event_types: std::collections::BTreeMap<String, i64> =
        std::collections::BTreeMap::new();
    let mut error_count: i64 = 0;
    let error_names = ["gemini.error"];
    for event in &events {
        let event_type = event
            .get("event")
            .or_else(|| event.get("type"))
            .and_then(Value::as_str)
            .map(str::to_string);
        if let Some(et) = event_type {
            if error_names.iter().any(|n| *n == et.as_str()) {
                error_count += 1;
            }
            *event_types.entry(et).or_insert(0) += 1;
        }
    }
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    let stats = serde_json::json!({
        "totalEvents": events.len() as i64,
        "eventTypes": event_types,
        "errorCount": error_count,
        "model": response.get("model").and_then(Value::as_str).unwrap_or(""),
        "startTime": now,
        "endTime": now,
        "lastEventTime": now,
    });
    let output = serde_json::json!({
        "events": events,
        "stats": stats,
    });
    serde_json::to_string(&output)
        .map_err(|error| format!("Failed to serialize gemini SSE stream JSON: {}", error))
}

/// Build wire-level SSE frames for the Gemini SSE stream.
pub fn build_gemini_sse_stream_frames_json(input_json: String) -> Result<String, String> {
    let stream = build_gemini_sse_stream_json(input_json)?;
    let parsed: Value = serde_json::from_str(&stream)
        .map_err(|error| format!("Failed to parse gemini SSE stream output: {}", error))?;
    let events = parsed
        .get("events")
        .and_then(Value::as_array)
        .ok_or_else(|| "gemini SSE stream missing events array".to_string())?;
    let stats = parsed
        .get("stats")
        .cloned()
        .unwrap_or_else(|| serde_json::json!({}));
    let mut frames: Vec<String> = Vec::with_capacity(events.len());
    for event in events {
        let frame = serialize_gemini_event_to_wire(event)?;
        frames.push(frame);
    }
    let output = serde_json::json!({
        "frames": frames,
        "stats": stats,
    });
    serde_json::to_string(&output)
        .map_err(|error| format!("Failed to serialize gemini SSE frames JSON: {}", error))
}

/// Serialize a canonical GeminiSseEvent to SSE wire format.
fn serialize_gemini_event_to_wire(event: &Value) -> Result<String, String> {
    let event_type = event
        .get("event")
        .or_else(|| event.get("type"))
        .and_then(Value::as_str)
        .ok_or_else(|| "Gemini SSE event missing event/type field".to_string())?;
    if event_type.trim().is_empty() {
        return Err("Gemini SSE event type must be non-empty".to_string());
    }
    let payload = match event.get("data") {
        Some(Value::String(s)) => s.clone(),
        Some(other) => serde_json::to_string(other)
            .map_err(|error| format!("Failed to serialize gemini SSE data: {}", error))?,
        None => "{}".to_string(),
    };
    Ok(format!("event: {}\ndata: {}\n\n", event_type, payload))
}

#[cfg(test)]
mod tests {
    use super::{build_gemini_json_from_sse_json, build_gemini_sse_event_sequence_json};
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

    #[test]
    fn build_gemini_json_from_sse_aggregates_text() {
        let body_text = concat!(
            "event: gemini.data\n",
            "data: {\"type\":\"gemini.data\",\"protocol\":\"gemini-chat\",\"data\":{\"candidateIndex\":0,\"role\":\"model\",\"part\":{\"text\":\"hello\"}}}\n\n",
            "event: gemini.data\n",
            "data: {\"type\":\"gemini.data\",\"protocol\":\"gemini-chat\",\"data\":{\"candidateIndex\":0,\"role\":\"model\",\"part\":{\"text\":\" world\"}}}\n\n",
            "event: gemini.done\n",
            "data: {\"type\":\"gemini.done\",\"protocol\":\"gemini-chat\",\"data\":{\"kind\":\"done\",\"candidates\":[{\"index\":0,\"finishReason\":\"STOP\"}]}}\n\n"
        );
        let output = build_gemini_json_from_sse_json(
            json!({
                "body_text": body_text
            })
            .to_string(),
        )
        .unwrap();
        let response: serde_json::Value = serde_json::from_str(&output).unwrap();
        assert_eq!(
            response["candidates"][0]["content"]["parts"][0]["text"],
            "hello world"
        );
        assert_eq!(response["candidates"][0]["finishReason"], "STOP");
    }

    #[test]
    fn build_gemini_json_from_sse_requires_done() {
        let err = build_gemini_json_from_sse_json(
            json!({
                "body_text": "event: gemini.data\ndata: {\"type\":\"gemini.data\",\"protocol\":\"gemini-chat\",\"data\":{\"candidateIndex\":0,\"role\":\"model\",\"part\":{\"text\":\"hello\"}}}\n\n"
            })
            .to_string(),
        )
        .unwrap_err();
        assert!(err.contains("Gemini SSE stream missing done event"));
    }
}
