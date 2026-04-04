use napi::bindgen_prelude::Result as NapiResult;
use napi_derive::napi;
use serde::Deserialize;
use serde::Serialize;
use serde_json::Value;

fn strip_xssi_prefix(input: &str) -> &str {
    let mut normalized = input.trim_start();
    if let Some(stripped) = normalized.strip_prefix(")]}'") {
        normalized = stripped;
        if let Some(after_comma) = normalized.strip_prefix(',') {
            normalized = after_comma;
        }
        normalized = normalized.trim_start();
    }
    normalized
}

fn strip_data_prefix_case_insensitive(input: &str) -> &str {
    let trimmed = input.trim_start();
    if trimmed.len() < 5 {
        return trimmed;
    }

    let mut iter = trimmed.chars();
    let mut prefix = String::new();
    for _ in 0..5 {
        if let Some(ch) = iter.next() {
            prefix.push(ch);
        }
    }
    if !prefix.eq_ignore_ascii_case("data:") {
        return trimmed;
    }

    let rest = &trimmed[prefix.len()..];
    rest.trim_start()
}

fn normalize_json_probe_prefix(input: &str) -> &str {
    strip_data_prefix_case_insensitive(strip_xssi_prefix(input))
}

fn looks_like_json_prefix(first_chunk_text: &str) -> bool {
    let normalized = normalize_json_probe_prefix(first_chunk_text);
    normalized.starts_with('{') || normalized.starts_with('[')
}

fn parse_json_object_candidate(raw_text: &str, max_bytes: usize) -> Option<Value> {
    let normalized = normalize_json_probe_prefix(raw_text);
    if !(normalized.starts_with('{') || normalized.starts_with('[')) {
        return None;
    }
    if normalized.len() > max_bytes {
        return None;
    }

    let parsed: Value = serde_json::from_str(normalized).ok()?;
    match parsed {
        Value::Object(_) => Some(parsed),
        _ => None,
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RawSseEvent {
    id: Option<String>,
    event: String,
    data: String,
    retry: Option<String>,
    timestamp: Option<i64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SseParserConfigInput {
    #[serde(default = "default_true")]
    enable_strict_validation: bool,
    #[serde(default = "default_true")]
    enable_event_recovery: bool,
    #[serde(default = "default_max_event_size")]
    max_event_size: usize,
    #[serde(default)]
    allowed_event_types: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SseParseResultOutput {
    success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    event: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
    raw_data: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SseStreamChunkParseOutput {
    events: Vec<SseParseResultOutput>,
    remaining_buffer: String,
}

fn default_true() -> bool {
    true
}

fn default_max_event_size() -> usize {
    1024 * 1024
}

fn parse_sse_line(line: &str) -> Option<(String, String)> {
    if line.trim().is_empty() {
        return None;
    }
    let colon_index = line.find(':');
    match colon_index {
        Some(index) => {
            let field = line[..index].trim().to_string();
            if field.is_empty() {
                return None;
            }
            let value = if line.len() > index + 1 && line.as_bytes()[index + 1] == b' ' {
                line[index + 2..].to_string()
            } else {
                line[index + 1..].trim().to_string()
            };
            Some((field, value))
        }
        None => Some((line.to_string(), String::new())),
    }
}

fn assemble_sse_event(lines: &[String]) -> Option<RawSseEvent> {
    if lines.is_empty() {
        return None;
    }

    let mut event = RawSseEvent {
        id: None,
        event: "message".to_string(),
        data: String::new(),
        retry: None,
        timestamp: None,
    };

    for line in lines {
        let parsed = parse_sse_line(line);
        if parsed.is_none() {
            continue;
        }
        let (field, value) = parsed.unwrap();
        match field.as_str() {
            "id" => event.id = Some(value),
            "event" => event.event = value,
            "data" => {
                if event.data.is_empty() {
                    event.data = value;
                } else {
                    event.data.push('\n');
                    event.data.push_str(&value);
                }
            }
            "retry" => event.retry = Some(value),
            "timestamp" => event.timestamp = value.parse::<i64>().ok(),
            _ => {}
        }
    }

    Some(event)
}

fn detect_sse_protocol_kind(event_type: &str) -> String {
    let token = event_type.trim();
    match token {
        "chunk" | "done" | "error" | "heartbeat" => "chat".to_string(),
        "message_start"
        | "content_block_start"
        | "content_block_delta"
        | "content_block_stop"
        | "message_delta"
        | "message_stop" => "anthropic".to_string(),
        "gemini.data" | "gemini.done" => "gemini".to_string(),
        _ => {
            if token.contains('.')
                || token.starts_with("response")
                || token.starts_with("output")
                || token.starts_with("content")
                || token.starts_with("function")
                || token.starts_with("reasoning")
            {
                "responses".to_string()
            } else {
                "responses".to_string()
            }
        }
    }
}

fn validate_sse_event_type(
    event_type: &str,
    enable_strict_validation: bool,
    allowed_event_types: &[String],
) -> bool {
    if !enable_strict_validation {
        return true;
    }
    allowed_event_types.iter().any(|item| item == event_type)
}

fn infer_sse_event_type_from_data(
    raw_event: &Value,
    enable_strict_validation: bool,
    allowed_event_types: &[String],
) -> Option<String> {
    let event = raw_event
        .get("event")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    if !event.is_empty() && event != "message" {
        return None;
    }

    let data = raw_event
        .get("data")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    if data.is_empty() {
        return None;
    }

    let parsed: Value = serde_json::from_str(data).ok()?;
    let candidate = parsed
        .get("type")
        .and_then(Value::as_str)
        .map(|value| value.trim())
        .unwrap_or("");
    if candidate.is_empty() {
        return None;
    }

    if !enable_strict_validation || allowed_event_types.iter().any(|item| item == candidate) {
        return Some(candidate.to_string());
    }

    None
}

fn parse_sse_data_json(raw_data: &str) -> Result<Value, String> {
    if raw_data == "[DONE]" {
        return Ok(Value::String("[DONE]".to_string()));
    }
    serde_json::from_str(raw_data).map_err(|e| format!("Invalid JSON data: {}", e))
}

fn parse_sse_event_with_config(
    sse_text: &str,
    config: &SseParserConfigInput,
) -> SseParseResultOutput {
    let mut result = SseParseResultOutput {
        success: false,
        event: None,
        error: None,
        raw_data: sse_text.to_string(),
    };

    let parse_result: Result<Value, String> = (|| {
        let lines: Vec<String> = sse_text
            .split('\n')
            .map(|line| line.trim_end_matches('\r').to_string())
            .collect();

        let mut raw_event = match assemble_sse_event(&lines) {
            Some(value) => value,
            None => {
                return Err("Invalid SSE event format".to_string());
            }
        };

        if let Ok(raw_event_value) = serde_json::to_value(&raw_event) {
            if let Some(inferred) = infer_sse_event_type_from_data(
                &raw_event_value,
                config.enable_strict_validation,
                &config.allowed_event_types,
            ) {
                raw_event.event = inferred;
            }
        }

        if config.enable_strict_validation && sse_text.len() > config.max_event_size {
            return Err(format!(
                "Event size {} exceeds maximum {}",
                sse_text.len(),
                config.max_event_size
            ));
        }

        if !validate_sse_event_type(
            &raw_event.event,
            config.enable_strict_validation,
            &config.allowed_event_types,
        ) {
            return Err(format!("Invalid event type: {}", raw_event.event));
        }

        let mut event_type = raw_event.event.clone();
        let timestamp = raw_event
            .timestamp
            .unwrap_or_else(|| chrono::Utc::now().timestamp_millis());
        let mut data = Value::Null;
        let mut sequence_number = raw_event
            .id
            .as_ref()
            .and_then(|id| id.parse::<i64>().ok())
            .unwrap_or(0);

        if !raw_event.data.is_empty() {
            match parse_sse_data_json(&raw_event.data) {
                Ok(parsed_data) => {
                    if let Some(sequence) = parsed_data
                        .as_object()
                        .and_then(|obj| obj.get("sequence_number"))
                        .and_then(Value::as_i64)
                    {
                        sequence_number = sequence;
                    }
                    data = parsed_data;
                }
                Err(message) => {
                    if config.enable_event_recovery {
                        event_type = "error".to_string();
                        data = serde_json::json!({
                            "error": "Invalid JSON",
                            "raw": raw_event.data
                        });
                    } else {
                        return Err(message);
                    }
                }
            }
        }

        let protocol = detect_sse_protocol_kind(&event_type);
        let event = match protocol.as_str() {
            "chat" => serde_json::json!({
                "type": event_type,
                "event": event_type,
                "timestamp": timestamp,
                "data": data,
                "sequenceNumber": sequence_number,
                "protocol": "chat",
                "direction": "sse_to_json"
            }),
            "anthropic" => serde_json::json!({
                "type": event_type,
                "timestamp": timestamp,
                "data": data,
                "sequenceNumber": sequence_number,
                "protocol": "anthropic-messages",
                "direction": "sse_to_json"
            }),
            "gemini" => serde_json::json!({
                "type": event_type,
                "event": event_type,
                "timestamp": timestamp,
                "data": data,
                "sequenceNumber": sequence_number,
                "protocol": "gemini-chat",
                "direction": "sse_to_json"
            }),
            _ => serde_json::json!({
                "type": event_type,
                "timestamp": timestamp,
                "data": data,
                "sequenceNumber": sequence_number,
                "protocol": "responses",
                "direction": "sse_to_json"
            }),
        };
        Ok(event)
    })();

    match parse_result {
        Ok(event) => {
            result.success = true;
            result.event = Some(event);
        }
        Err(message) => {
            result.error = Some(message);
        }
    }

    result
}

fn normalize_sse_newlines(input: &str) -> String {
    input.replace("\r\n", "\n").replace('\r', "\n")
}

fn parse_sse_stream_chunk_with_config(
    sse_buffer: &str,
    config: &SseParserConfigInput,
    flush_tail: bool,
) -> SseStreamChunkParseOutput {
    let normalized = normalize_sse_newlines(sse_buffer);
    let mut segments: Vec<&str> = normalized.split("\n\n").collect();
    let remaining_buffer = if flush_tail {
        String::new()
    } else {
        segments.pop().unwrap_or("").to_string()
    };

    let events: Vec<SseParseResultOutput> = segments
        .into_iter()
        .filter(|chunk| !chunk.trim().is_empty())
        .map(|event_data| parse_sse_event_with_config(event_data, config))
        .filter(|entry| entry.success || config.enable_event_recovery)
        .collect();

    SseStreamChunkParseOutput {
        events,
        remaining_buffer,
    }
}

fn parse_sse_stream_with_config(
    sse_data: &str,
    config: &SseParserConfigInput,
) -> Vec<SseParseResultOutput> {
    parse_sse_stream_chunk_with_config(sse_data, config, true).events
}

#[napi]
pub fn looks_like_json_stream_prefix_json(first_chunk_text: String) -> NapiResult<String> {
    let output = looks_like_json_prefix(&first_chunk_text);
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi]
pub fn parse_json_object_candidate_json(raw_text: String, max_bytes: i64) -> NapiResult<String> {
    let cap = if max_bytes <= 0 {
        0usize
    } else {
        max_bytes as usize
    };
    let output = parse_json_object_candidate(&raw_text, cap);
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi]
pub fn assemble_sse_event_from_lines_json(lines_json: String) -> NapiResult<String> {
    let lines: Vec<String> =
        serde_json::from_str(&lines_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let output = assemble_sse_event(&lines);
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi]
pub fn infer_sse_event_type_from_data_json(
    raw_event_json: String,
    enable_strict_validation: bool,
    allowed_event_types_json: String,
) -> NapiResult<String> {
    let raw_event: Value = serde_json::from_str(&raw_event_json)
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let allowed_event_types: Vec<String> = serde_json::from_str(&allowed_event_types_json)
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let output =
        infer_sse_event_type_from_data(&raw_event, enable_strict_validation, &allowed_event_types);
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi]
pub fn detect_sse_protocol_kind_json(event_type: String) -> NapiResult<String> {
    let output = detect_sse_protocol_kind(&event_type);
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi]
pub fn validate_sse_event_type_json(
    event_type: String,
    enable_strict_validation: bool,
    allowed_event_types_json: String,
) -> NapiResult<String> {
    let allowed_event_types: Vec<String> = serde_json::from_str(&allowed_event_types_json)
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let output =
        validate_sse_event_type(&event_type, enable_strict_validation, &allowed_event_types);
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi]
pub fn parse_sse_event_with_config_json(
    sse_text: String,
    config_json: String,
) -> NapiResult<String> {
    let config: SseParserConfigInput =
        serde_json::from_str(&config_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let output = parse_sse_event_with_config(&sse_text, &config);
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi]
pub fn parse_sse_stream_with_config_json(
    sse_data: String,
    config_json: String,
) -> NapiResult<String> {
    let config: SseParserConfigInput =
        serde_json::from_str(&config_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let output = parse_sse_stream_with_config(&sse_data, &config);
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi]
pub fn parse_sse_stream_chunk_with_config_json(
    sse_buffer: String,
    config_json: String,
    flush_tail: bool,
) -> NapiResult<String> {
    let config: SseParserConfigInput =
        serde_json::from_str(&config_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let output = parse_sse_stream_chunk_with_config(&sse_buffer, &config, flush_tail);
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::{
        assemble_sse_event, infer_sse_event_type_from_data, parse_json_object_candidate,
        parse_sse_event_with_config, parse_sse_stream_chunk_with_config,
        parse_sse_stream_with_config, SseParserConfigInput,
    };
    use serde_json::{json, Value};

    #[test]
    fn parse_candidate_accepts_xssi_prefix() {
        let parsed = parse_json_object_candidate(")]}',\n{\"ok\":true}", 1024);
        assert!(parsed.is_some());
    }

    #[test]
    fn parse_candidate_accepts_data_prefix() {
        let parsed = parse_json_object_candidate("data: {\"ok\":true}", 1024);
        assert!(parsed.is_some());
    }

    #[test]
    fn assemble_sse_event_joins_multi_data_lines() {
        let lines = vec![
            "event: response.output_text.delta".to_string(),
            "id: 9".to_string(),
            "data: {\"delta\":\"hello\"}".to_string(),
            "data: {\"delta\":\" world\"}".to_string(),
            "retry: 1000".to_string(),
            "timestamp: 1730000000".to_string(),
        ];
        let parsed = assemble_sse_event(&lines).expect("event");
        assert_eq!(parsed.event, "response.output_text.delta");
        assert_eq!(parsed.id.as_deref(), Some("9"));
        assert_eq!(parsed.data, "{\"delta\":\"hello\"}\n{\"delta\":\" world\"}");
        assert_eq!(parsed.retry.as_deref(), Some("1000"));
        assert_eq!(parsed.timestamp, Some(1730000000));
    }

    #[test]
    fn assemble_sse_event_defaults_to_message() {
        let lines = vec!["data: {\"ok\":true}".to_string()];
        let parsed = assemble_sse_event(&lines).expect("event");
        assert_eq!(parsed.event, "message");
        assert_eq!(parsed.data, "{\"ok\":true}");
    }

    #[test]
    fn infer_sse_event_type_accepts_message_event_with_allowed_type() {
        let raw_event = json!({
            "event": "message",
            "data": "{\"type\":\"response.output_text.delta\"}"
        });
        let allowed = vec![
            "response.output_text.delta".to_string(),
            "response.completed".to_string(),
        ];
        let inferred = infer_sse_event_type_from_data(&raw_event, true, &allowed);
        assert_eq!(inferred.as_deref(), Some("response.output_text.delta"));
    }

    #[test]
    fn infer_sse_event_type_rejects_disallowed_type() {
        let raw_event = json!({
            "event": "message",
            "data": "{\"type\":\"unknown.type\"}"
        });
        let allowed = vec!["response.output_text.delta".to_string()];
        let inferred = infer_sse_event_type_from_data(&raw_event, true, &allowed);
        assert!(inferred.is_none());
    }

    #[test]
    fn infer_sse_event_type_rejects_non_message_event() {
        let raw_event = json!({
            "event": "response.completed",
            "data": "{\"type\":\"response.output_text.delta\"}"
        });
        let allowed = vec!["response.output_text.delta".to_string()];
        let inferred = infer_sse_event_type_from_data(&raw_event, true, &allowed);
        assert!(inferred.is_none());
    }

    #[test]
    fn infer_sse_event_type_accepts_disallowed_type_when_non_strict() {
        let raw_event = json!({
            "event": "message",
            "data": "{\"type\":\"custom.type\"}"
        });
        let allowed = vec!["response.output_text.delta".to_string()];
        let inferred = infer_sse_event_type_from_data(&raw_event, false, &allowed);
        assert_eq!(inferred.as_deref(), Some("custom.type"));
    }

    #[test]
    fn detect_sse_protocol_kind_chat() {
        assert_eq!(super::detect_sse_protocol_kind("chunk"), "chat");
    }

    #[test]
    fn detect_sse_protocol_kind_anthropic() {
        assert_eq!(super::detect_sse_protocol_kind("message_stop"), "anthropic");
    }

    #[test]
    fn detect_sse_protocol_kind_gemini() {
        assert_eq!(super::detect_sse_protocol_kind("gemini.done"), "gemini");
    }

    #[test]
    fn detect_sse_protocol_kind_defaults_to_responses() {
        assert_eq!(super::detect_sse_protocol_kind("custom"), "responses");
    }

    #[test]
    fn validate_sse_event_type_strict() {
        let allowed = vec!["response.completed".to_string()];
        assert!(super::validate_sse_event_type(
            "response.completed",
            true,
            &allowed
        ));
        assert!(!super::validate_sse_event_type("message", true, &allowed));
    }

    #[test]
    fn validate_sse_event_type_non_strict() {
        let allowed = vec!["response.completed".to_string()];
        assert!(super::validate_sse_event_type(
            "custom.type",
            false,
            &allowed
        ));
    }

    #[test]
    fn parse_sse_event_with_config_maps_anthropic_protocol() {
        let config = SseParserConfigInput {
            enable_strict_validation: true,
            enable_event_recovery: true,
            max_event_size: 1024 * 1024,
            allowed_event_types: vec!["message_stop".to_string()],
        };
        let result = parse_sse_event_with_config(
            "event: message_stop\ndata: {\"type\":\"message_stop\"}",
            &config,
        );
        assert!(result.success);
        let event = result.event.expect("event");
        assert_eq!(
            event.get("protocol").and_then(Value::as_str),
            Some("anthropic-messages")
        );
        assert_eq!(
            event.get("type").and_then(Value::as_str),
            Some("message_stop")
        );
    }

    #[test]
    fn parse_sse_event_with_config_recovers_invalid_json_when_enabled() {
        let config = SseParserConfigInput {
            enable_strict_validation: true,
            enable_event_recovery: true,
            max_event_size: 1024 * 1024,
            allowed_event_types: vec!["response.output_text.delta".to_string()],
        };
        let result = parse_sse_event_with_config(
            "event: response.output_text.delta\ndata: {invalid-json}",
            &config,
        );
        assert!(result.success);
        let event = result.event.expect("event");
        assert_eq!(event.get("type").and_then(Value::as_str), Some("error"));
        assert_eq!(
            event
                .get("data")
                .and_then(Value::as_object)
                .and_then(|row| row.get("error"))
                .and_then(Value::as_str),
            Some("Invalid JSON")
        );
    }

    #[test]
    fn parse_sse_stream_with_config_filters_invalid_when_recovery_disabled() {
        let config = SseParserConfigInput {
            enable_strict_validation: true,
            enable_event_recovery: false,
            max_event_size: 1024 * 1024,
            allowed_event_types: vec!["response.completed".to_string()],
        };
        let stream = "event: response.completed\ndata: {\"type\":\"response.completed\"}\n\n\
event: custom.type\ndata: {\"ok\":true}\n\n";
        let result = parse_sse_stream_with_config(stream, &config);
        assert_eq!(result.len(), 1);
        assert!(result[0].success);
        let event = result[0].event.as_ref().expect("event");
        assert_eq!(
            event.get("type").and_then(Value::as_str),
            Some("response.completed")
        );
    }

    #[test]
    fn parse_sse_stream_chunk_with_config_keeps_partial_tail() {
        let config = SseParserConfigInput {
            enable_strict_validation: true,
            enable_event_recovery: false,
            max_event_size: 1024 * 1024,
            allowed_event_types: vec!["response.completed".to_string()],
        };
        let chunk = "event: response.completed\ndata: {\"type\":\"response.completed\"}\n\n\
event: response.completed\ndata: {\"type\":\"response.completed\"";
        let output = parse_sse_stream_chunk_with_config(chunk, &config, false);
        assert_eq!(output.events.len(), 1);
        assert!(output.events[0].success);
        assert!(!output.remaining_buffer.is_empty());
        assert!(output
            .remaining_buffer
            .contains("event: response.completed"));
    }

    #[test]
    fn parse_sse_stream_chunk_with_config_flushes_tail() {
        let config = SseParserConfigInput {
            enable_strict_validation: true,
            enable_event_recovery: false,
            max_event_size: 1024 * 1024,
            allowed_event_types: vec!["response.completed".to_string()],
        };
        let chunk = "event: response.completed\ndata: {\"type\":\"response.completed\"}";
        let output = parse_sse_stream_chunk_with_config(chunk, &config, true);
        assert_eq!(output.events.len(), 1);
        assert!(output.events[0].success);
        assert_eq!(output.remaining_buffer, "");
    }

    #[test]
    fn parse_sse_stream_with_config_supports_crlf_boundaries() {
        let config = SseParserConfigInput {
            enable_strict_validation: true,
            enable_event_recovery: false,
            max_event_size: 1024 * 1024,
            allowed_event_types: vec!["response.completed".to_string()],
        };
        let stream = "event: response.completed\r\ndata: {\"type\":\"response.completed\"}\r\n\r\n\
event: response.completed\r\ndata: {\"type\":\"response.completed\"}\r\n\r\n";
        let result = parse_sse_stream_with_config(stream, &config);
        assert_eq!(result.len(), 2);
        assert!(result[0].success);
        assert!(result[1].success);
    }
}
