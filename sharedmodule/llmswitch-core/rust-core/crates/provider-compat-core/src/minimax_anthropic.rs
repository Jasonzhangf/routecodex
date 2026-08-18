use serde_json::{json, Value};

/// Native remote search tool mix（Mode A）：minimax 原生 hosted web_search
/// （web_search_20250305）。Anthropic wire 编码（hosted shape 直通 +
/// `server_tool_use`/`web_search_tool_result` → `web_search_call` +
/// `function_call_output` 配对投影）由 v3 anthropic_codec 完成；本层
/// 仅做 minimax provider sentinel text stripping（响应侧，与 web_search 无关）。
pub(crate) const MODE_A_NATIVE_REMOTE_SEARCH: &str = "native_remote_search_tool_mix";

pub(crate) fn apply_request_compat(payload: Value, _mode: Option<&str>) -> Result<Value, String> {
    Ok(payload)
}

pub(crate) fn apply_response_compat(payload: Value) -> Value {
    apply_minimax_thinking_tag_compat(strip_minimax_provider_sentinel_recursive(payload))
}

fn apply_minimax_thinking_tag_compat(mut payload: Value) -> Value {
    if let Some(output) = payload.get_mut("output").and_then(Value::as_array_mut) {
        let mut projected = Vec::with_capacity(output.len());
        for mut item in std::mem::take(output) {
            let reasoning = project_responses_message_thinking(&mut item);
            if let Some(reasoning) = reasoning {
                projected.push(json!({
                    "type": "reasoning",
                    "status": "completed",
                    "summary": [{"type": "summary_text", "text": reasoning}]
                }));
            }
            projected.push(item);
        }
        *output = projected;
    }

    if let Some(content) = payload.get_mut("content").and_then(Value::as_array_mut) {
        project_anthropic_content_thinking(content);
    }

    if let Some(choices) = payload.get_mut("choices").and_then(Value::as_array_mut) {
        for choice in choices {
            if let Some(message) = choice.get_mut("message") {
                project_openai_chat_message_thinking(message);
            }
        }
    }

    payload
}

fn project_responses_message_thinking(item: &mut Value) -> Option<String> {
    if item.get("type").and_then(Value::as_str) != Some("message") {
        return None;
    }
    let content = item.get_mut("content").and_then(Value::as_array_mut)?;
    let mut reasoning = Vec::new();
    for block in content {
        if block.get("type").and_then(Value::as_str) != Some("output_text") {
            continue;
        }
        if let Some(text) = block
            .get("text")
            .and_then(Value::as_str)
            .map(str::to_owned)
        {
            let (visible, hidden) = split_thinking_tags(&text);
            if !hidden.is_empty() {
                block["text"] = Value::String(visible);
                reasoning.push(hidden);
            }
        }
    }
    (!reasoning.is_empty()).then(|| reasoning.join("\n"))
}

fn project_anthropic_content_thinking(content: &mut Vec<Value>) {
    let mut projected = Vec::with_capacity(content.len());
    for mut block in std::mem::take(content) {
        if block.get("type").and_then(Value::as_str) == Some("text") {
            if let Some(text) = block.get("text").and_then(Value::as_str).map(str::to_owned) {
                let (visible, hidden) = split_thinking_tags(&text);
                if !hidden.is_empty() {
                    projected.push(json!({"type": "thinking", "thinking": hidden}));
                    block["text"] = Value::String(visible);
                }
            }
        }
        projected.push(block);
    }
    *content = projected;
}

fn project_openai_chat_message_thinking(message: &mut Value) {
    let Some(content) = message.get("content").and_then(Value::as_str).map(str::to_owned) else {
        return;
    };
    let (visible, hidden) = split_thinking_tags(&content);
    if hidden.is_empty() {
        return;
    }
    message["content"] = Value::String(visible);
    message["reasoning_content"] = Value::String(hidden);
}

fn split_thinking_tags(text: &str) -> (String, String) {
    let mut visible = String::with_capacity(text.len());
    let mut reasoning = String::new();
    let mut cursor = 0;
    while cursor < text.len() {
        let Some(open_rel) = text[cursor..].find("<thinking>") else {
            visible.push_str(&text[cursor..].replace("</thinking>", ""));
            break;
        };
        let open = cursor + open_rel;
        visible.push_str(&text[cursor..open]);
        let body_start = open + "<thinking>".len();
        if let Some(close_rel) = text[body_start..].find("</thinking>") {
            let close = body_start + close_rel;
            reasoning.push_str(text[body_start..close].trim());
            cursor = close + "</thinking>".len();
        } else {
            reasoning.push_str(text[body_start..].trim());
            break;
        }
        if cursor < text.len() && !reasoning.ends_with('\n') {
            reasoning.push('\n');
        }
    }
    (visible, reasoning.trim().to_string())
}

fn strip_minimax_provider_sentinel_recursive(value: Value) -> Value {
    match value {
        Value::String(text) => match strip_minimax_provider_sentinel_text(&text) {
            Some(stripped) => Value::String(stripped),
            None => Value::String(text),
        },
        Value::Array(items) => Value::Array(
            items
                .into_iter()
                .map(strip_minimax_provider_sentinel_recursive)
                .collect(),
        ),
        Value::Object(map) => Value::Object(
            map.into_iter()
                .map(|(key, value)| (key, strip_minimax_provider_sentinel_recursive(value)))
                .collect(),
        ),
        other => other,
    }
}

fn strip_minimax_provider_sentinel_text(text: &str) -> Option<String> {
    if !text.contains("]<]minimax[>[") {
        return None;
    }
    let mut next = text.replace("]<]minimax[>[", "");
    for marker in ["<think\n", "<think\r\n", "<think"] {
        if next.starts_with(marker) {
            next = next[marker.len()..].to_string();
            break;
        }
    }
    let trimmed_start = next.trim_start_matches(['\r', '\n', ' ', '\t']);
    if let Some(rest) = trimmed_start.strip_prefix("<continue") {
        next = rest.to_string();
    }
    Some(next)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn strips_minimax_sentinel_text() {
        let input = json!("]<]minimax[>[<think\nworld");
        let output = apply_response_compat(input);
        assert_eq!(output, json!("world"));
    }

    #[test]
    fn leaves_clean_text_alone() {
        let input = json!("plain text without sentinel");
        let output = apply_response_compat(input);
        assert_eq!(output, json!("plain text without sentinel"));
    }

    #[test]
    fn strips_sentinel_in_nested_object() {
        let input = json!({
            "choices": [{
                "message": {"content": "]<]minimax[>[answerbody"}
            }]
        });
        let output = apply_response_compat(input);
        assert_eq!(
            output["choices"][0]["message"]["content"],
            json!("answerbody")
        );
    }

    #[test]
    fn apply_request_compat_passes_through() {
        // Mode A 直通：wire 编码在 v3 anthropic_codec 完成，本层不做投影。
        let payload = json!({
            "model": "MiniMax-M3",
            "tools": [{"type": "web_search_20250305", "name": "web_search"}],
            "messages": [{"role": "user", "content": "query"}]
        });
        let output = apply_request_compat(payload.clone(), Some(MODE_A_NATIVE_REMOTE_SEARCH))
            .expect("Mode A passthrough must succeed");
        assert_eq!(output, payload);
    }

    #[test]
    fn projects_responses_thinking_tags_to_reasoning_and_keeps_visible_text() {
        let output = apply_response_compat(json!({
            "object": "response",
            "output": [{
                "type": "message",
                "role": "assistant",
                "content": [{
                    "type": "output_text",
                    "text": "before <thinking>private plan</thinking>after"
                }]
            }]
        }));
        assert_eq!(output["output"][0]["type"], "reasoning");
        assert_eq!(output["output"][0]["summary"][0]["text"], "private plan");
        assert_eq!(output["output"][1]["content"][0]["text"], "before after");
        let encoded = serde_json::to_string(&output).unwrap();
        assert!(!encoded.contains("<thinking>"));
        assert!(!encoded.contains("</thinking>"));
    }

    #[test]
    fn projects_unmatched_thinking_tags_without_leaking_delimiters() {
        let output = apply_response_compat(json!({
            "content": [{
                "type": "text",
                "text": "visible <thinking>unfinished plan"
            }]
        }));
        assert_eq!(output["content"][0]["type"], "thinking");
        assert_eq!(output["content"][0]["thinking"], "unfinished plan");
        assert_eq!(output["content"][1]["text"], "visible ");
    }
}
