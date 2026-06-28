use regex::Regex;
use serde_json::{Map, Value};

// feature_id: responses.request_compat_normalization
// feature_id: responses.tool_parameters_normalization

pub(crate) fn normalize_responses_tool_parameters(raw: Option<&Value>) -> Value {
    let mut candidate = raw.cloned().unwrap_or(Value::Null);
    if let Value::String(text) = &candidate {
        candidate = serde_json::from_str::<Value>(text)
            .ok()
            .unwrap_or_else(|| Value::Object(Map::new()));
    }
    if let Value::Object(_) = candidate {
        return candidate;
    }
    let mut fallback = Map::new();
    fallback.insert("type".to_string(), Value::String("object".to_string()));
    fallback.insert("properties".to_string(), Value::Object(Map::new()));
    fallback.insert("additionalProperties".to_string(), Value::Bool(true));
    Value::Object(fallback)
}

// feature_id: responses.function_tool_normalization
pub(crate) fn normalize_responses_function_tools(root: &mut Map<String, Value>) {
    let Some(raw_tools) = root.get("tools").and_then(Value::as_array) else {
        return;
    };
    let mut normalized = Vec::new();
    for entry in raw_tools {
        let Some(tool_obj) = entry.as_object() else {
            normalized.push(entry.clone());
            continue;
        };
        let tool_type = tool_obj.get("type").and_then(Value::as_str).map(str::trim);
        if tool_type != Some("function") {
            normalized.push(entry.clone());
            continue;
        }
        let function_obj = tool_obj.get("function").and_then(Value::as_object);
        let name = tool_obj
            .get("name")
            .and_then(Value::as_str)
            .or_else(|| {
                function_obj
                    .and_then(|row| row.get("name"))
                    .and_then(Value::as_str)
            })
            .map(str::trim)
            .filter(|value| !value.is_empty());
        let Some(name) = name else {
            normalized.push(entry.clone());
            continue;
        };
        let mut normalized_tool = Map::new();
        normalized_tool.insert("type".to_string(), Value::String("function".to_string()));
        normalized_tool.insert("name".to_string(), Value::String(name.to_string()));
        if let Some(description) = tool_obj
            .get("description")
            .and_then(Value::as_str)
            .or_else(|| {
                function_obj
                    .and_then(|row| row.get("description"))
                    .and_then(Value::as_str)
            })
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            normalized_tool.insert(
                "description".to_string(),
                Value::String(description.to_string()),
            );
        }
        normalized_tool.insert(
            "parameters".to_string(),
            normalize_responses_tool_parameters(
                tool_obj
                    .get("parameters")
                    .or_else(|| function_obj.and_then(|row| row.get("parameters"))),
            ),
        );
        normalized.push(Value::Object(normalized_tool));
    }
    root.insert("tools".to_string(), Value::Array(normalized));
}

// feature_id: responses.request_compat_normalization
pub(crate) fn strip_responses_reasoning_content_for_provider_wire(root: &mut Map<String, Value>) {
    let Some(input) = root.get_mut("input").and_then(Value::as_array_mut) else {
        return;
    };
    for entry in input.iter_mut() {
        let Some(row) = entry.as_object_mut() else {
            continue;
        };
        if row.get("type").and_then(Value::as_str) != Some("reasoning") {
            continue;
        }
        row.remove("content");
    }
}

fn strip_html_tags(text: &str) -> String {
    match Regex::new(r"</?[^>]+(>|$)") {
        Ok(re) => re.replace_all(text, "").to_string(),
        Err(_) => text.to_string(),
    }
}

fn resolve_compat_instruction_max_len() -> Option<usize> {
    const CANDIDATES: [&str; 1] = ["ROUTECODEX_COMPAT_INSTRUCTIONS_MAX"];
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

// feature_id: responses.instructions_to_input_normalization
pub(crate) fn apply_responses_instructions_to_input(root: &mut Map<String, Value>) {
    let instructions = root
        .remove("instructions")
        .and_then(|value| value.as_str().map(|raw| raw.trim().to_string()))
        .filter(|trimmed| !trimmed.is_empty());
    let Some(raw_text) = instructions else {
        return;
    };

    let mut text = strip_html_tags(&raw_text);
    if let Some(max_len) = resolve_compat_instruction_max_len() {
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

// feature_id: responses.crs_request_compat
pub(crate) fn apply_responses_crs_request_compat(root: &mut Map<String, Value>) {
    normalize_responses_function_tools(root);
    root.remove("temperature");
}
