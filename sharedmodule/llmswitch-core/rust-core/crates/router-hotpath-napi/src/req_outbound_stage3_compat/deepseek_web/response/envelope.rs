use serde_json::{json, Number, Value};
use std::time::{SystemTime, UNIX_EPOCH};

use super::super::{read_trimmed_string, AdapterContext};

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

#[derive(Clone, Copy, Default, PartialEq, Eq)]
enum DeepSeekAppendTarget {
    #[default]
    None,
    Content,
    Thinking,
}

#[derive(Default)]
struct DeepSeekSseState {
    content: String,
    thinking_content: String,
    append_target: DeepSeekAppendTarget,
    fragment_targets: Vec<DeepSeekAppendTarget>,
    finished: bool,
    accumulated_token_usage: Option<i64>,
    response_message_id: Option<String>,
    model: Option<String>,
}

fn extract_sse_raw_record<'a>(
    value: &'a Value,
) -> Option<(&'a serde_json::Map<String, Value>, &'a str)> {
    let root = value.as_object()?;

    let is_sse_record = |row: &'a serde_json::Map<String, Value>| {
        row.get("mode")
            .and_then(Value::as_str)
            .map(|mode| mode.trim().eq_ignore_ascii_case("sse"))
            .unwrap_or(false)
            && row.get("raw").and_then(Value::as_str).is_some()
    };

    if is_sse_record(root) {
        return Some((
            root,
            root.get("raw").and_then(Value::as_str).unwrap_or_default(),
        ));
    }

    let body = root.get("body")?.as_object()?;
    if is_sse_record(body) {
        return Some((
            body,
            body.get("raw").and_then(Value::as_str).unwrap_or_default(),
        ));
    }

    None
}

fn append_content(state: &mut DeepSeekSseState, text: &str) {
    if text.is_empty() {
        return;
    }
    state.content.push_str(text);
}

fn append_thinking_content(state: &mut DeepSeekSseState, text: &str) {
    if text.is_empty() {
        return;
    }
    state.thinking_content.push_str(text);
}

fn fragment_target_from_type(fragment_type: Option<&str>) -> DeepSeekAppendTarget {
    match fragment_type
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.to_ascii_uppercase())
        .as_deref()
    {
        Some("THINK") | Some("THINKING") | Some("REASONING") => DeepSeekAppendTarget::Thinking,
        Some("RESPONSE") | Some("TEXT") | Some("ANSWER") => DeepSeekAppendTarget::Content,
        _ => DeepSeekAppendTarget::Content,
    }
}

fn append_fragment_text(state: &mut DeepSeekSseState, target: DeepSeekAppendTarget, text: &str) {
    match target {
        DeepSeekAppendTarget::Thinking => append_thinking_content(state, text),
        DeepSeekAppendTarget::Content => append_content(state, text),
        DeepSeekAppendTarget::None => {}
    }
}

fn process_fragment_record(
    fragment: &serde_json::Map<String, Value>,
    state: &mut DeepSeekSseState,
) {
    let target = fragment_target_from_type(fragment.get("type").and_then(Value::as_str));
    state.fragment_targets.push(target);
    state.append_target = target;
    if let Some(content) = fragment.get("content").and_then(Value::as_str) {
        append_fragment_text(state, target, content);
    }
}

fn process_fragments_array(items: &[Value], state: &mut DeepSeekSseState) {
    for item in items {
        let Some(fragment) = item.as_object() else {
            continue;
        };
        process_fragment_record(fragment, state);
    }
}

fn resolve_fragment_target_from_path(
    path: &str,
    state: &DeepSeekSseState,
) -> Option<DeepSeekAppendTarget> {
    let prefix = "response/fragments/";
    if !path.starts_with(prefix) || !path.ends_with("/content") {
        return None;
    }
    let index_raw = path
        .strip_prefix(prefix)?
        .strip_suffix("/content")?
        .trim();
    if index_raw == "-1" {
        return state.fragment_targets.last().copied();
    }
    let index = index_raw.parse::<usize>().ok()?;
    state.fragment_targets.get(index).copied()
}

fn process_response_record(
    response: &serde_json::Map<String, Value>,
    state: &mut DeepSeekSseState,
) {
    if let Some(content) = response.get("content").and_then(Value::as_str) {
        append_content(state, content);
    }
    if let Some(thinking_content) = response.get("thinking_content").and_then(Value::as_str) {
        append_thinking_content(state, thinking_content);
    }
    if let Some(status) = response.get("status").and_then(Value::as_str) {
        if status.trim().eq_ignore_ascii_case("FINISHED") {
            state.finished = true;
            state.append_target = DeepSeekAppendTarget::None;
        }
    }
    if let Some(model) = read_trimmed_string(response.get("model")) {
        state.model = Some(model);
    }
    if let Some(tokens) = read_i64(response.get("accumulated_token_usage")) {
        state.accumulated_token_usage = Some(tokens);
    }
    if let Some(fragments) = response.get("fragments").and_then(Value::as_array) {
        process_fragments_array(fragments, state);
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
    let path = payload
        .get("p")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    let op = payload
        .get("o")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    let value = payload.get("v");
    let is_textual_patch_op =
        op.is_empty() || op.eq_ignore_ascii_case("APPEND") || op.eq_ignore_ascii_case("SET");

    if path == "response/content" && is_textual_patch_op {
        if let Some(text) = value.and_then(Value::as_str) {
            state.append_target = DeepSeekAppendTarget::Content;
            append_content(state, text);
            return;
        }
    }

    if path == "response/thinking_content" && is_textual_patch_op {
        if let Some(text) = value.and_then(Value::as_str) {
            state.append_target = DeepSeekAppendTarget::Thinking;
            append_thinking_content(state, text);
            return;
        }
    }

    if path == "response/fragments" && is_textual_patch_op {
        if let Some(items) = value.and_then(Value::as_array) {
            process_fragments_array(items, state);
            return;
        }
    }

    if let Some(target) = resolve_fragment_target_from_path(path, state) {
        if let Some(text) = value.and_then(Value::as_str) {
            state.append_target = target;
            append_fragment_text(state, target, text);
            return;
        }
    }

    if path.is_empty() {
        if let Some(text) = value.and_then(Value::as_str) {
            match state.append_target {
                DeepSeekAppendTarget::Content => {
                    append_content(state, text);
                    return;
                }
                DeepSeekAppendTarget::Thinking => {
                    append_thinking_content(state, text);
                    return;
                }
                DeepSeekAppendTarget::None => {}
            }
        }
    }

    if path == "response/status" {
        if let Some(status) = value.and_then(Value::as_str) {
            if status.trim().eq_ignore_ascii_case("FINISHED") {
                state.finished = true;
                state.append_target = DeepSeekAppendTarget::None;
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

fn is_terminal_sse_event(event: &str) -> bool {
    matches!(
        event.trim().to_ascii_lowercase().as_str(),
        "close" | "finish" | "finished" | "done" | "completed" | "end"
    )
}

fn flush_sse_block(block: &str, state: &mut DeepSeekSseState) {
    let mut event_name: Option<String> = None;
    let data = block
        .lines()
        .filter_map(|line| {
            if let Some(raw) = line.strip_prefix("event:") {
                event_name = Some(raw.trim().to_string());
                return None;
            }
            line.strip_prefix("data:")
        })
        .map(str::trim_start)
        .collect::<Vec<&str>>()
        .join("\n");
    let trimmed = data.trim();
    if event_name
        .as_deref()
        .map(is_terminal_sse_event)
        .unwrap_or(false)
    {
        state.finished = true;
    }
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

    if state.content.is_empty()
        && state.thinking_content.is_empty()
        && state.response_message_id.is_none()
        && !state.finished
    {
        return None;
    }
    Some(state)
}

fn normalize_estimated_input_tokens(adapter_context: &AdapterContext) -> Option<i64> {
    let raw = adapter_context.estimated_input_tokens?;
    if !raw.is_finite() {
        return None;
    }
    let rounded = raw.round();
    let clamped = if rounded < 0.0 { 0.0 } else { rounded };
    Some(clamped as i64)
}

fn build_deepseek_sse_chat_completion(
    value: &Value,
    adapter_context: Option<&AdapterContext>,
) -> Option<Value> {
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
                "reasoning_content": state.thinking_content,
            },
            "finish_reason": if state.finished { "stop" } else { "stop" }
        }]
    });

    if let Some(total_tokens) = state.accumulated_token_usage {
        let estimated_prompt = adapter_context.and_then(normalize_estimated_input_tokens);
        let prompt_tokens = estimated_prompt.unwrap_or(0).min(total_tokens);
        let completion_tokens = total_tokens.saturating_sub(prompt_tokens);
        let mut usage = serde_json::Map::new();
        usage.insert(
            "prompt_tokens".to_string(),
            Value::Number(Number::from(prompt_tokens)),
        );
        usage.insert(
            "completion_tokens".to_string(),
            Value::Number(Number::from(completion_tokens)),
        );
        usage.insert(
            "total_tokens".to_string(),
            Value::Number(Number::from(total_tokens)),
        );
        if estimated_prompt.is_some() {
            usage.insert(
                "input_tokens".to_string(),
                Value::Number(Number::from(prompt_tokens)),
            );
            usage.insert(
                "output_tokens".to_string(),
                Value::Number(Number::from(completion_tokens)),
            );
        }
        output["usage"] = Value::Object(usage);
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

fn try_unwrap_known_shape(
    value: &Value,
    depth: i32,
    adapter_context: Option<&AdapterContext>,
) -> Option<Value> {
    if depth < 0 {
        return None;
    }
    if let Some(converted) = build_deepseek_sse_chat_completion(value, adapter_context) {
        return Some(converted);
    }
    if looks_like_known_provider_response_shape(value) {
        return Some(value.clone());
    }
    let row = value.as_object()?;
    for key in ["data", "body", "response", "payload", "result", "biz_data"] {
        if let Some(next) = row.get(key) {
            if let Some(unwrapped) = try_unwrap_known_shape(next, depth - 1, adapter_context) {
                return Some(unwrapped);
            }
        }
    }
    None
}

pub(super) fn normalize_deepseek_business_envelope(
    payload: Value,
    adapter_context: Option<&AdapterContext>,
) -> Result<Value, String> {
    if let Some(converted) = build_deepseek_sse_chat_completion(&payload, adapter_context) {
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
        if let Some(unwrapped) = try_unwrap_known_shape(data, 6, adapter_context) {
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
    use crate::req_outbound_stage3_compat::AdapterContext;
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

        let normalized = normalize_deepseek_business_envelope(payload, None).unwrap();
        assert_eq!(normalized["object"], "chat.completion");
        assert_eq!(normalized["choices"][0]["message"]["role"], "assistant");
        assert_eq!(
            normalized["choices"][0]["message"]["content"],
            "<<RCC_TOOL_CALLS_JSON"
        );
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

        let normalized = normalize_deepseek_business_envelope(payload, None).unwrap();
        assert_eq!(normalized["choices"][0]["message"]["content"], "hi");
        assert_eq!(normalized["choices"][0]["finish_reason"], "stop");
    }

    #[test]
    fn test_normalize_deepseek_business_envelope_maps_thinking_content_to_reasoning_content() {
        let payload = json!({
            "body": {
                "mode": "sse",
                "raw": concat!(
                    "event: ready\n",
                    "data: {\"request_message_id\":1,\"response_message_id\":2}\n\n",
                    "data: {\"p\":\"response/thinking_content\",\"o\":\"APPEND\",\"v\":\"先检查\"}\n\n",
                    "data: {\"v\":\"工具返回\"}\n\n",
                    "data: {\"p\":\"response/status\",\"v\":\"FINISHED\"}\n\n"
                )
            }
        });

        let normalized = normalize_deepseek_business_envelope(payload, None).unwrap();
        assert_eq!(normalized["choices"][0]["message"]["content"], "");
        assert_eq!(
            normalized["choices"][0]["message"]["reasoning_content"],
            "先检查工具返回"
        );
        assert_eq!(normalized["choices"][0]["finish_reason"], "stop");
    }

    #[test]
    fn test_normalize_deepseek_business_envelope_maps_nested_response_thinking_content() {
        let payload = json!({
            "body": {
                "mode": "sse",
                "raw": concat!(
                    "data: {\"v\":{\"response\":{\"message_id\":2,\"status\":\"WIP\",\"thinking_content\":\"先看日志\"}}}\n\n",
                    "data: {\"p\":\"response/status\",\"v\":\"FINISHED\"}\n\n"
                )
            }
        });

        let normalized = normalize_deepseek_business_envelope(payload, None).unwrap();
        assert_eq!(normalized["choices"][0]["message"]["content"], "");
        assert_eq!(
            normalized["choices"][0]["message"]["reasoning_content"],
            "先看日志"
        );
        assert_eq!(normalized["choices"][0]["finish_reason"], "stop");
    }

    #[test]
    fn test_normalize_deepseek_business_envelope_splits_accumulated_usage_with_estimated_prompt() {
        let payload = json!({
            "body": {
                "mode": "sse",
                "raw": concat!(
                    "data: {\"p\":\"response/content\",\"o\":\"APPEND\",\"v\":\"hello\"}\n\n",
                    "data: {\"p\":\"response/accumulated_token_usage\",\"o\":\"SET\",\"v\":123}\n\n",
                    "data: {\"p\":\"response/status\",\"v\":\"FINISHED\"}\n\n"
                )
            }
        });
        let adapter_context = AdapterContext {
            compatibility_profile: Some("chat:deepseek-web".to_string()),
            provider_protocol: Some("openai-chat".to_string()),
            request_id: Some("req_deepseek_envelope_usage_split".to_string()),
            entry_endpoint: Some("/v1/chat/completions".to_string()),
            route_id: None,
            rt: None,
            captured_chat_request: None,
            deepseek: None,
            claude_code: None,
            anthropic_thinking: None,
            estimated_input_tokens: Some(23.0),
            model_id: None,
            client_model_id: None,
            original_model_id: None,
            provider_id: None,
            provider_key: None,
            runtime_key: None,
            client_request_id: None,
            group_request_id: None,
            session_id: None,
            conversation_id: None,
        };

        let normalized =
            normalize_deepseek_business_envelope(payload, Some(&adapter_context)).unwrap();
        assert_eq!(normalized["usage"]["prompt_tokens"], 23);
        assert_eq!(normalized["usage"]["completion_tokens"], 100);
        assert_eq!(normalized["usage"]["total_tokens"], 123);
        assert_eq!(normalized["usage"]["input_tokens"], 23);
        assert_eq!(normalized["usage"]["output_tokens"], 100);
    }

    #[test]
    fn test_normalize_deepseek_business_envelope_treats_terminal_close_event_as_completion() {
        let payload = json!({
            "body": {
                "mode": "sse",
                "raw": concat!(
                    "event: ready\n",
                    "data: {\"request_message_id\":1,\"response_message_id\":2,\"model_type\":\"default\"}\n\n",
                    "event: close\n",
                    "data: {\"click_behavior\":\"none\",\"auto_resume\":false}\n\n"
                )
            }
        });

        let normalized = normalize_deepseek_business_envelope(payload, None).unwrap();
        assert_eq!(normalized["object"], "chat.completion");
        assert_eq!(normalized["choices"][0]["message"]["role"], "assistant");
        assert_eq!(normalized["choices"][0]["message"]["content"], "");
        assert_eq!(normalized["choices"][0]["finish_reason"], "stop");
    }

    #[test]
    fn test_normalize_deepseek_business_envelope_collects_fragment_based_thinking_and_response() {
        let payload = json!({
            "body": {
                "mode": "sse",
                "raw": concat!(
                    "event: ready\n",
                    "data: {\"request_message_id\":1,\"response_message_id\":2,\"model_type\":\"expert\"}\n\n",
                    "data: {\"v\":{\"response\":{\"message_id\":2,\"status\":\"WIP\",\"content\":\"\",\"fragments\":[{\"id\":2,\"type\":\"THINK\",\"content\":\"We\",\"elapsed_secs\":null,\"references\":[],\"stage_id\":1}]}}}\n\n",
                    "data: {\"p\":\"response/fragments/-1/content\",\"o\":\"APPEND\",\"v\":\" need\"}\n\n",
                    "data: {\"v\":\" to continue\"}\n\n",
                    "data: {\"p\":\"response/fragments\",\"o\":\"APPEND\",\"v\":[{\"id\":3,\"type\":\"RESPONSE\",\"content\":\"Jason\",\"references\":[],\"stage_id\":1}]}\n\n",
                    "data: {\"p\":\"response/status\",\"o\":\"SET\",\"v\":\"FINISHED\"}\n\n"
                )
            }
        });

        let normalized = normalize_deepseek_business_envelope(payload, None).unwrap();
        assert_eq!(normalized["choices"][0]["message"]["content"], "Jason");
        assert_eq!(
            normalized["choices"][0]["message"]["reasoning_content"],
            "We need to continue"
        );
        assert_eq!(normalized["choices"][0]["finish_reason"], "stop");
    }
}
