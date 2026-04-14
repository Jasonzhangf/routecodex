use serde_json::{json, Value};
use std::time::{SystemTime, UNIX_EPOCH};

use super::super::read_trimmed_string;

fn read_number(value: Option<&Value>) -> Option<f64> {
    match value {
        Some(Value::Number(number)) => number.as_f64(),
        Some(Value::String(raw)) => raw.trim().parse::<f64>().ok(),
        _ => None,
    }
}

fn read_i64(value: Option<&Value>) -> Option<i64> {
    match value {
        Some(Value::Number(number)) => number.as_i64(),
        Some(Value::String(raw)) => raw.trim().parse::<i64>().ok(),
        _ => None,
    }
}

fn current_unix_seconds() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs() as i64)
        .unwrap_or(0)
}

#[derive(Default)]
struct DeepSeekSseState {
    content: String,
    append_active: bool,
    finished: bool,
    accumulated_token_usage: Option<i64>,
    response_message_id: Option<String>,
    model: Option<String>,
}

fn extract_sse_raw_record<'a>(value: &'a Value) -> Option<(&'a serde_json::Map<String, Value>, &'a str)> {
    let root = value.as_object()?;

    let is_sse_record = |row: &'a serde_json::Map<String, Value>| {
        row.get("mode")
            .and_then(Value::as_str)
            .map(|mode| mode.trim().eq_ignore_ascii_case("sse"))
            .unwrap_or(false)
            && row.get("raw").and_then(Value::as_str).is_some()
    };

    if is_sse_record(root) {
        return Some((root, root.get("raw").and_then(Value::as_str).unwrap_or_default()));
    }

    let body = root.get("body")?.as_object()?;
    if is_sse_record(body) {
        return Some((body, body.get("raw").and_then(Value::as_str).unwrap_or_default()));
    }

    None
}

fn append_content(state: &mut DeepSeekSseState, text: &str) {
    if text.is_empty() {
        return;
    }
    state.content.push_str(text);
}

fn process_response_record(response: &serde_json::Map<String, Value>, state: &mut DeepSeekSseState) {
    if let Some(content) = response.get("content").and_then(Value::as_str) {
        append_content(state, content);
    }
    if let Some(status) = response.get("status").and_then(Value::as_str) {
        if status.trim().eq_ignore_ascii_case("FINISHED") {
            state.finished = true;
            state.append_active = false;
        }
    }
    if let Some(model) = read_trimmed_string(response.get("model")) {
        state.model = Some(model);
    }
    if let Some(tokens) = read_i64(response.get("accumulated_token_usage")) {
        state.accumulated_token_usage = Some(tokens);
    }
    if let Some(message_id) = response
        .get("message_id")
        .and_then(|value| match value {
            Value::String(raw) => Some(raw.trim().to_string()),
            Value::Number(number) => Some(number.to_string()),
            _ => None,
        })
        .filter(|value| !value.is_empty())
    {
        state.response_message_id = Some(message_id);
    }
}

fn process_patch_payload(payload: &serde_json::Map<String, Value>, state: &mut DeepSeekSseState) {
    let path = payload.get("p").and_then(Value::as_str).unwrap_or("").trim();
    let op = payload.get("o").and_then(Value::as_str).unwrap_or("").trim();
    let value = payload.get("v");

    if path == "response/content" && op.eq_ignore_ascii_case("APPEND") {
        if let Some(text) = value.and_then(Value::as_str) {
            state.append_active = true;
            append_content(state, text);
            return;
        }
    }

    if path.is_empty() && state.append_active {
        if let Some(text) = value.and_then(Value::as_str) {
            append_content(state, text);
            return;
        }
    }

    if path == "response/status" {
        if let Some(status) = value.and_then(Value::as_str) {
            if status.trim().eq_ignore_ascii_case("FINISHED") {
                state.finished = true;
                state.append_active = false;
                return;
            }
        }
    }

    if path == "response/accumulated_token_usage" {
        if let Some(tokens) = read_i64(value) {
            state.accumulated_token_usage = Some(tokens);
            return;
        }
    }

    if let Some(message_id) = payload
        .get("response_message_id")
        .and_then(|value| match value {
            Value::String(raw) => Some(raw.trim().to_string()),
            Value::Number(number) => Some(number.to_string()),
            _ => None,
        })
        .filter(|value| !value.is_empty())
    {
        state.response_message_id = Some(message_id);
    }

    if let Some(inner) = value.and_then(Value::as_object) {
        if let Some(response) = inner.get("response").and_then(Value::as_object) {
            process_response_record(response, state);
            return;
        }
    }

    if let Some(response) = payload.get("response").and_then(Value::as_object) {
        process_response_record(response, state);
    }
}

fn flush_sse_block(block: &str, state: &mut DeepSeekSseState) {
    let data = block
        .lines()
        .filter_map(|line| line.strip_prefix("data:"))
        .map(str::trim_start)
        .collect::<Vec<&str>>()
        .join("\n");
    let trimmed = data.trim();
    if trimmed.is_empty() || trimmed == "[DONE]" {
        return;
    }
    let Ok(parsed) = serde_json::from_str::<Value>(trimmed) else {
        return;
    };
    let Some(payload) = parsed.as_object() else {
        return;
    };
    process_patch_payload(payload, state);
}

fn parse_deepseek_sse_raw(raw: &str) -> Option<DeepSeekSseState> {
    let normalized = raw.replace("\r\n", "\n");
    let mut state = DeepSeekSseState::default();
    let mut current = String::new();

    for line in normalized.lines() {
        if line.trim().is_empty() {
            if !current.trim().is_empty() {
                flush_sse_block(current.as_str(), &mut state);
                current.clear();
            }
            continue;
        }
        current.push_str(line);
        current.push('\n');
    }
    if !current.trim().is_empty() {
        flush_sse_block(current.as_str(), &mut state);
    }

    if state.content.is_empty() && state.response_message_id.is_none() && !state.finished {
        return None;
    }
    Some(state)
}

fn build_deepseek_sse_chat_completion(value: &Value) -> Option<Value> {
    let (_, raw) = extract_sse_raw_record(value)?;
    let state = parse_deepseek_sse_raw(raw)?;
    let response_id = state
        .response_message_id
        .as_deref()
        .map(|id| format!("chatcmpl-deepseek-{}", id))
        .unwrap_or_else(|| "chatcmpl-deepseek-sse".to_string());

    let mut output = json!({
        "id": response_id,
        "object": "chat.completion",
        "created": current_unix_seconds(),
        "model": state.model.unwrap_or_default(),
        "choices": [{
            "index": 0,
            "message": {
                "role": "assistant",
                "content": state.content,
            },
            "finish_reason": if state.finished { "stop" } else { "stop" }
        }]
    });

    if let Some(tokens) = state.accumulated_token_usage {
        output["usage"] = json!({
            "prompt_tokens": 0,
            "completion_tokens": tokens,
            "total_tokens": tokens,
        });
    }

    Some(output)
}

fn looks_like_known_provider_response_shape(value: &Value) -> bool {
    let Some(row) = value.as_object() else {
        return false;
    };
    if row.get("choices").and_then(|v| v.as_array()).is_some() {
        return true;
    }
    if row.get("output").and_then(|v| v.as_array()).is_some() {
        return true;
    }
    if row
        .get("object")
        .and_then(|v| v.as_str())
        .map(|v| v.eq_ignore_ascii_case("response"))
        .unwrap_or(false)
    {
        return true;
    }
    if row
        .get("type")
        .and_then(|v| v.as_str())
        .map(|v| v.eq_ignore_ascii_case("message"))
        .unwrap_or(false)
        && row.get("content").and_then(|v| v.as_array()).is_some()
    {
        return true;
    }
    if row.get("candidates").and_then(|v| v.as_array()).is_some() {
        return true;
    }
    false
}

fn try_unwrap_known_shape(value: &Value, depth: i32) -> Option<Value> {
    if depth < 0 {
        return None;
    }
    if let Some(converted) = build_deepseek_sse_chat_completion(value) {
        return Some(converted);
    }
    if looks_like_known_provider_response_shape(value) {
        return Some(value.clone());
    }
    let row = value.as_object()?;
    for key in ["data", "body", "response", "payload", "result", "biz_data"] {
        if let Some(next) = row.get(key) {
            if let Some(unwrapped) = try_unwrap_known_shape(next, depth - 1) {
                return Some(unwrapped);
            }
        }
    }
    None
}

pub(super) fn normalize_deepseek_business_envelope(payload: Value) -> Result<Value, String> {
    if let Some(converted) = build_deepseek_sse_chat_completion(&payload) {
        return Ok(converted);
    }
    if looks_like_known_provider_response_shape(&payload) {
        return Ok(payload);
    }
    let Some(root) = payload.as_object() else {
        return Ok(payload);
    };
    if !(root.contains_key("code") && root.contains_key("data")) {
        return Ok(payload);
    }

    if let Some(data) = root.get("data") {
        if let Some(unwrapped) = try_unwrap_known_shape(data, 6) {
            return Ok(unwrapped);
        }
    }

    let data_node = root.get("data").and_then(|v| v.as_object());
    let upstream_code = read_number(root.get("code"));
    let biz_code = read_number(data_node.and_then(|v| v.get("biz_code")));
    let biz_msg = read_trimmed_string(data_node.and_then(|v| v.get("biz_msg")));
    let top_msg = read_trimmed_string(root.get("msg"));
    let has_error = upstream_code.map(|v| v != 0.0).unwrap_or(false)
        || biz_code.map(|v| v != 0.0).unwrap_or(false)
        || biz_msg.is_some()
        || top_msg.is_some();
    if has_error {
        let message = biz_msg
            .or(top_msg)
            .unwrap_or_else(|| "DeepSeek returned a non-chat business envelope".to_string());
        return Err(format!(
            "[deepseek-web] upstream business error: {}",
            message
        ));
    }

    Ok(payload)
}

#[cfg(test)]
mod tests {
    use super::normalize_deepseek_business_envelope;
    use serde_json::json;

    #[test]
    fn test_normalize_deepseek_business_envelope_unwraps_sse_raw_body() {
        let payload = json!({
            "body": {
                "mode": "sse",
                "raw": concat!(
                    "event: ready\n",
                    "data: {\"request_message_id\":1,\"response_message_id\":2}\n\n",
                    "data: {\"v\":{\"response\":{\"message_id\":2,\"status\":\"WIP\",\"content\":\"\"}}}\n\n",
                    "data: {\"p\":\"response/content\",\"o\":\"APPEND\",\"v\":\"<<\"}\n\n",
                    "data: {\"v\":\"RCC\"}\n\n",
                    "data: {\"v\":\"_TOOL_CALLS_JSON\"}\n\n",
                    "data: {\"p\":\"response/status\",\"v\":\"FINISHED\"}\n\n"
                )
            }
        });

        let normalized = normalize_deepseek_business_envelope(payload).unwrap();
        assert_eq!(normalized["object"], "chat.completion");
        assert_eq!(normalized["choices"][0]["message"]["role"], "assistant");
        assert_eq!(normalized["choices"][0]["message"]["content"], "<<RCC_TOOL_CALLS_JSON");
        assert_eq!(normalized["choices"][0]["finish_reason"], "stop");
    }

    #[test]
    fn test_normalize_deepseek_business_envelope_unwraps_business_data_with_sse_body() {
        let payload = json!({
            "code": 0,
            "data": {
                "body": {
                    "mode": "sse",
                    "raw": concat!(
                        "data: {\"p\":\"response/content\",\"o\":\"APPEND\",\"v\":\"hi\"}\n\n",
                        "data: {\"p\":\"response/status\",\"v\":\"FINISHED\"}\n\n"
                    )
                }
            }
        });

        let normalized = normalize_deepseek_business_envelope(payload).unwrap();
        assert_eq!(normalized["choices"][0]["message"]["content"], "hi");
        assert_eq!(normalized["choices"][0]["finish_reason"], "stop");
    }
}
