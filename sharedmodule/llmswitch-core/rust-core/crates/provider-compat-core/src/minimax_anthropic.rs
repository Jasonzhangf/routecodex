use serde_json::Value;

/// Native remote search tool mix（Mode A）：minimax 原生 hosted web_search
/// （web_search_20250305）。Anthropic wire 编码（hosted shape 直通 +
/// `server_tool_use`/`web_search_tool_result` → `web_search_call` +
/// `function_call_output` 配对投影）由 v3 anthropic_codec 完成；本层
/// 仅做 minimax provider sentinel text stripping（响应侧，与 web_search 无关）。
pub(crate) const MODE_A_NATIVE_REMOTE_SEARCH: &str = "native_remote_search_tool_mix";

pub(crate) fn apply_request_compat(
    payload: Value,
    _mode: Option<&str>,
) -> Result<Value, String> {
    Ok(payload)
}

pub(crate) fn apply_response_compat(payload: Value) -> Value {
    strip_minimax_provider_sentinel_recursive(payload)
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
}