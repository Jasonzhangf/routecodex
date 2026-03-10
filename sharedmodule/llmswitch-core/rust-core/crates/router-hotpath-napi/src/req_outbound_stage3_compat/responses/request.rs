use regex::Regex;
use serde_json::{Map, Value};

fn strip_html_tags(text: &str) -> String {
    match Regex::new(r"</?[^>]+(>|$)") {
        Ok(re) => re.replace_all(text, "").to_string(),
        Err(_) => text.to_string(),
    }
}

fn resolve_c4m_instruction_max_len() -> Option<usize> {
    const CANDIDATES: [&str; 3] = [
        "ROUTECODEX_C4M_INSTRUCTIONS_MAX",
        "RCC_C4M_INSTRUCTIONS_MAX",
        "ROUTECODEX_COMPAT_INSTRUCTIONS_MAX",
    ];
    for env_name in CANDIDATES {
        let Ok(raw) = std::env::var(env_name) else {
            continue;
        };
        let Ok(parsed) = raw.trim().parse::<usize>() else {
            continue;
        };
        if parsed > 0 {
            return Some(parsed);
        }
    }
    None
}

fn truncate_by_chars(text: &str, max_len: usize) -> String {
    text.chars().take(max_len).collect::<String>()
}

pub(crate) fn apply_responses_c4m_request_compat(root: &mut Map<String, Value>) {
    root.remove("max_tokens");
    root.remove("maxTokens");
    root.remove("max_output_tokens");
    root.remove("maxOutputTokens");

    let instructions = root
        .remove("instructions")
        .and_then(|value| value.as_str().map(|raw| raw.trim().to_string()))
        .filter(|trimmed| !trimmed.is_empty());
    let Some(raw_text) = instructions else {
        return;
    };

    let mut text = strip_html_tags(&raw_text);
    if let Some(max_len) = resolve_c4m_instruction_max_len() {
        if text.chars().count() > max_len {
            text = truncate_by_chars(&text, max_len);
        }
    }
    if text.is_empty() {
        return;
    }

    if !root
        .get("input")
        .and_then(|value| value.as_array())
        .is_some()
    {
        root.insert("input".to_string(), Value::Array(Vec::new()));
    }
    let Some(input_array) = root.get_mut("input").and_then(|value| value.as_array_mut()) else {
        return;
    };

    let mut content = Map::new();
    content.insert("type".to_string(), Value::String("input_text".to_string()));
    content.insert("text".to_string(), Value::String(text));
    let mut message = Map::new();
    message.insert("type".to_string(), Value::String("message".to_string()));
    message.insert("role".to_string(), Value::String("system".to_string()));
    message.insert(
        "content".to_string(),
        Value::Array(vec![Value::Object(content)]),
    );
    input_array.insert(0, Value::Object(message));
}

pub(crate) fn apply_responses_crs_request_compat(root: &mut Map<String, Value>) {
    root.remove("temperature");
}
