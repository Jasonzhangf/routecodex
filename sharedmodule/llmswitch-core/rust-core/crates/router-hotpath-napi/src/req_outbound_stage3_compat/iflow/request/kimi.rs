mod media;
mod reasoning;

use serde_json::{Map, Number, Value};

use media::apply_kimi_history_media_placeholder;
use reasoning::{fill_reasoning_content_for_tool_calls, normalize_thinking_for_kimi};

fn model_is_kimi_k25(model: Option<&Value>) -> bool {
    let Some(token) = model.and_then(|v| v.as_str()) else {
        return false;
    };
    let normalized = token.trim().to_ascii_lowercase();
    normalized == "kimi-k2.5" || normalized.starts_with("kimi-k2.5-")
}

fn mirror_max_tokens(root: &mut Map<String, Value>) {
    let Some(raw) = root.get("max_tokens").and_then(|v| v.as_f64()) else {
        return;
    };
    if !raw.is_finite() || raw <= 0.0 {
        return;
    }
    let normalized = raw.floor() as i64;
    if normalized > 0 {
        root.insert(
            "max_new_tokens".to_string(),
            Value::Number(Number::from(normalized)),
        );
    }
}

pub(super) fn apply_iflow_kimi_request_compat(root: &mut Map<String, Value>) -> bool {
    if !model_is_kimi_k25(root.get("model")) {
        return false;
    }

    apply_kimi_history_media_placeholder(root);

    let thinking_enabled = normalize_thinking_for_kimi(root);
    root.insert(
        "temperature".to_string(),
        Value::Number(Number::from_f64(if thinking_enabled { 1.0 } else { 0.6 }).unwrap()),
    );
    root.insert(
        "top_p".to_string(),
        Value::Number(Number::from_f64(0.95).unwrap()),
    );
    root.insert("n".to_string(), Value::Number(Number::from(1)));
    root.insert(
        "presence_penalty".to_string(),
        Value::Number(Number::from(0)),
    );
    root.insert(
        "frequency_penalty".to_string(),
        Value::Number(Number::from(0)),
    );
    mirror_max_tokens(root);

    if thinking_enabled {
        fill_reasoning_content_for_tool_calls(root);
    }
    true
}
