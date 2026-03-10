use serde_json::{Map, Value};

use self::prompt::build_deepseek_prompt;
use super::{read_trimmed_string, AdapterContext};

const SEARCH_ROUTE_PREFIXES: [&str; 2] = ["web_search", "search"];

mod prompt;

fn read_optional_boolean(value: Option<&Value>) -> Option<bool> {
    match value {
        Some(Value::Bool(v)) => Some(*v),
        Some(Value::String(raw)) => {
            let normalized = raw.trim().to_ascii_lowercase();
            if ["true", "1", "yes", "on"].contains(&normalized.as_str()) {
                return Some(true);
            }
            if ["false", "0", "no", "off"].contains(&normalized.as_str()) {
                return Some(false);
            }
            None
        }
        _ => None,
    }
}

fn resolve_deepseek_options(adapter_context: &AdapterContext) -> (bool, bool) {
    let Some(deepseek) = adapter_context
        .deepseek
        .as_ref()
        .and_then(|v| v.as_object())
    else {
        return (true, true);
    };

    let strict_tool_required =
        read_optional_boolean(deepseek.get("strictToolRequired")).unwrap_or(true);
    let text_tool_fallback =
        read_optional_boolean(deepseek.get("textToolFallback")).unwrap_or(true);
    (strict_tool_required, text_tool_fallback)
}

fn resolve_model(root: &Map<String, Value>) -> String {
    read_trimmed_string(root.get("model")).unwrap_or_default()
}

fn resolve_thinking_search_flags(model_raw: &str) -> (bool, bool) {
    let model = model_raw.trim().to_ascii_lowercase();
    if model == "deepseek-v3" || model == "deepseek-chat" {
        return (false, false);
    }
    if model == "deepseek-r1" || model == "deepseek-reasoner" {
        return (true, false);
    }
    if model == "deepseek-v3-search" || model == "deepseek-chat-search" {
        return (false, true);
    }
    if model == "deepseek-r1-search" || model == "deepseek-reasoner-search" {
        return (true, true);
    }
    (false, false)
}

fn should_force_search(root: &Map<String, Value>, adapter_context: &AdapterContext) -> bool {
    let route_id = adapter_context
        .route_id
        .as_ref()
        .map(|v| v.trim().to_ascii_lowercase())
        .unwrap_or_default();
    if SEARCH_ROUTE_PREFIXES
        .iter()
        .any(|prefix| route_id.starts_with(prefix))
    {
        return true;
    }
    root.get("web_search").and_then(|v| v.as_object()).is_some()
}

pub(crate) fn apply_deepseek_web_request_compat(
    payload: Value,
    adapter_context: &AdapterContext,
) -> Value {
    let Some(root) = payload.as_object() else {
        return payload;
    };

    let model = resolve_model(root);
    let (thinking_enabled, search_by_model) = resolve_thinking_search_flags(&model);
    let search_enabled = if should_force_search(root, adapter_context) {
        true
    } else {
        search_by_model
    };
    let (strict_tool_required, text_tool_fallback) = resolve_deepseek_options(adapter_context);
    let prompt = build_deepseek_prompt(root);

    let mut next = Map::<String, Value>::new();
    if let Some(chat_session_id) = read_trimmed_string(root.get("chat_session_id")) {
        next.insert(
            "chat_session_id".to_string(),
            Value::String(chat_session_id),
        );
    }
    next.insert(
        "parent_message_id".to_string(),
        read_trimmed_string(root.get("parent_message_id"))
            .map(Value::String)
            .unwrap_or(Value::Null),
    );
    next.insert("prompt".to_string(), Value::String(prompt));
    next.insert(
        "ref_file_ids".to_string(),
        root.get("ref_file_ids")
            .and_then(|v| v.as_array())
            .map(|v| Value::Array(v.clone()))
            .unwrap_or_else(|| Value::Array(Vec::new())),
    );
    next.insert(
        "thinking_enabled".to_string(),
        Value::Bool(thinking_enabled),
    );
    next.insert("search_enabled".to_string(), Value::Bool(search_enabled));
    if root.get("stream") == Some(&Value::Bool(true)) {
        next.insert("stream".to_string(), Value::Bool(true));
    }

    let mut metadata = root
        .get("metadata")
        .and_then(|v| v.as_object())
        .cloned()
        .unwrap_or_default();
    let mut deepseek = metadata
        .get("deepseek")
        .and_then(|v| v.as_object())
        .cloned()
        .unwrap_or_default();
    deepseek.insert(
        "strictToolRequired".to_string(),
        Value::Bool(strict_tool_required),
    );
    deepseek.insert(
        "textToolFallback".to_string(),
        Value::Bool(text_tool_fallback),
    );
    metadata.insert("deepseek".to_string(), Value::Object(deepseek));
    next.insert("metadata".to_string(), Value::Object(metadata));

    Value::Object(next)
}
