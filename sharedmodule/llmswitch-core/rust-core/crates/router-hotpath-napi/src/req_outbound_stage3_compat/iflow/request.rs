mod kimi;
mod search;
mod tool_text_fallback;

use serde_json::Value;

use super::super::AdapterContext;
use kimi::apply_iflow_kimi_request_compat;
use search::apply_iflow_web_search_request_transform;
use tool_text_fallback::apply_iflow_tool_text_fallback;
pub(crate) use tool_text_fallback::apply_iflow_tool_text_fallback_json;

pub(crate) fn apply_iflow_request_compat(
    payload: Value,
    adapter_context: &AdapterContext,
) -> Value {
    let mut payload = payload;
    let Some(root) = payload.as_object_mut() else {
        return payload;
    };

    apply_iflow_web_search_request_transform(root, adapter_context);
    apply_iflow_minimax_chat_setting_compat(root);
    apply_iflow_tool_text_fallback(root, adapter_context, &["minimax-m2.5".to_string()]);
    if !apply_iflow_kimi_request_compat(root) {
        return payload;
    }
    payload
}

fn normalize_model(value: Option<&Value>) -> String {
    value
        .and_then(|v| v.as_str())
        .map(|v| v.trim().to_ascii_lowercase())
        .unwrap_or_default()
}

fn is_iflow_minimax_model(model: &str) -> bool {
    if model.is_empty() {
        return false;
    }
    model.starts_with("minimax-") || model.contains(".minimax-")
}

fn apply_iflow_minimax_chat_setting_compat(root: &mut serde_json::Map<String, Value>) {
    let model = normalize_model(root.get("model"));
    if !is_iflow_minimax_model(model.as_str()) {
        return;
    }

    // MiniMax OpenAI-chat endpoint rejects max_tokens in this gateway path.
    // Keep max_output_tokens as the single outbound budget key.
    if root.get("max_output_tokens").is_none() {
        if let Some(max_tokens) = root.get("max_tokens").cloned() {
            root.insert("max_output_tokens".to_string(), max_tokens);
        }
    }
    root.remove("max_tokens");

    // MiniMax returns `invalid chat setting` when this field exists in OpenAI-chat payloads.
    root.remove("semantics");
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn minimax_chat_setting_compat_removes_max_tokens_and_semantics() {
        let mut payload = json!({
            "model": "MiniMax-M2.7",
            "messages": [{ "role": "user", "content": "hi" }],
            "max_tokens": 1024,
            "semantics": "default",
            "tool_choice": "auto"
        });
        let root = payload.as_object_mut().expect("object");
        apply_iflow_minimax_chat_setting_compat(root);

        assert!(root.get("max_tokens").is_none());
        assert_eq!(root.get("max_output_tokens"), Some(&json!(1024)));
        assert!(root.get("semantics").is_none());
        assert_eq!(root.get("tool_choice"), Some(&json!("auto")));
    }

    #[test]
    fn minimax_chat_setting_compat_keeps_non_minimax_payload_unchanged() {
        let mut payload = json!({
            "model": "gpt-5.3-codex",
            "messages": [{ "role": "user", "content": "hi" }],
            "max_tokens": 512,
            "semantics": "default"
        });
        let root = payload.as_object_mut().expect("object");
        apply_iflow_minimax_chat_setting_compat(root);

        assert_eq!(root.get("max_tokens"), Some(&json!(512)));
        assert_eq!(root.get("semantics"), Some(&json!("default")));
        assert!(root.get("max_output_tokens").is_none());
    }
}
