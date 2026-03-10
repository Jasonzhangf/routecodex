use serde_json::{Map, Value};

use super::{read_trimmed_string, AdapterContext};

#[derive(Default)]
struct UsageSnapshot {
    prompt: Option<i64>,
    completion: Option<i64>,
    total: Option<i64>,
}

fn read_number(value: Option<&Value>) -> Option<f64> {
    match value {
        Some(Value::Number(number)) => number.as_f64(),
        Some(Value::String(raw)) => raw.trim().parse::<f64>().ok(),
        _ => None,
    }
}

fn normalize_token_count(value: Option<f64>) -> Option<i64> {
    value.and_then(|raw| {
        if !raw.is_finite() {
            return None;
        }
        let rounded = raw.round();
        let clamped = if rounded < 0.0 { 0.0 } else { rounded };
        Some(clamped as i64)
    })
}

fn normalize_usage_snapshot(raw: Option<&Value>) -> UsageSnapshot {
    let Some(row) = raw.and_then(|v| v.as_object()) else {
        return UsageSnapshot::default();
    };
    UsageSnapshot {
        prompt: normalize_token_count(
            read_number(row.get("prompt_tokens")).or_else(|| read_number(row.get("input_tokens"))),
        ),
        completion: normalize_token_count(
            read_number(row.get("completion_tokens"))
                .or_else(|| read_number(row.get("output_tokens"))),
        ),
        total: normalize_token_count(read_number(row.get("total_tokens"))),
    }
}

fn resolve_estimated_input_tokens(adapter_context: &AdapterContext) -> Option<i64> {
    normalize_token_count(adapter_context.estimated_input_tokens)
}

fn estimate_text_tokens(text: &str) -> i64 {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return 0;
    }
    // Keep a deterministic approximation in native path without introducing extra tokenizer deps.
    ((trimmed.chars().count() as f64) / 4.0).ceil().max(1.0) as i64
}

fn collect_message_text_candidates(message: &Map<String, Value>) -> Vec<String> {
    let mut candidates: Vec<String> = Vec::new();
    if let Some(raw) = message.get("content") {
        if let Some(text) = raw.as_str() {
            let trimmed = text.trim();
            if !trimmed.is_empty() {
                candidates.push(text.to_string());
            }
        } else if let Some(parts) = raw.as_array() {
            for part in parts {
                let Some(part_obj) = part.as_object() else {
                    continue;
                };
                let text = read_trimmed_string(part_obj.get("text"))
                    .or_else(|| read_trimmed_string(part_obj.get("content")));
                if let Some(value) = text {
                    candidates.push(value);
                }
            }
        }
    }

    if let Some(reasoning) = read_trimmed_string(message.get("reasoning"))
        .or_else(|| read_trimmed_string(message.get("reasoning_content")))
    {
        candidates.push(reasoning);
    }
    candidates
}

fn estimate_completion_tokens_from_choices(payload: &Value) -> i64 {
    let Some(choices) = payload
        .as_object()
        .and_then(|v| v.get("choices"))
        .and_then(|v| v.as_array())
    else {
        return 0;
    };

    let mut segments: Vec<String> = Vec::new();
    for choice in choices {
        let Some(message) = choice
            .as_object()
            .and_then(|v| v.get("message"))
            .and_then(|v| v.as_object())
        else {
            continue;
        };
        segments.extend(collect_message_text_candidates(message));
        if let Some(tool_calls) = message.get("tool_calls").and_then(|v| v.as_array()) {
            if !tool_calls.is_empty() {
                if let Ok(serialized) = serde_json::to_string(tool_calls) {
                    segments.push(serialized);
                }
            }
        }
    }

    if segments.is_empty() {
        return 0;
    }
    estimate_text_tokens(&segments.join("\n"))
}

pub(super) fn apply_usage_estimate(payload: &mut Value, adapter_context: &AdapterContext) {
    let current = normalize_usage_snapshot(payload.as_object().and_then(|root| root.get("usage")));
    let prompt = current
        .prompt
        .or_else(|| resolve_estimated_input_tokens(adapter_context));
    let completion = current
        .completion
        .or_else(|| Some(estimate_completion_tokens_from_choices(payload)));
    let total = current.total.or_else(|| match (prompt, completion) {
        (Some(p), Some(c)) => Some(p + c),
        _ => None,
    });

    if prompt.is_none() && completion.is_none() && total.is_none() {
        return;
    }

    let Some(root) = payload.as_object_mut() else {
        return;
    };

    let mut usage = root
        .get("usage")
        .and_then(|v| v.as_object())
        .cloned()
        .unwrap_or_default();
    if let Some(value) = prompt {
        usage.insert("prompt_tokens".to_string(), Value::Number(value.into()));
        usage.insert("input_tokens".to_string(), Value::Number(value.into()));
    }
    if let Some(value) = completion {
        usage.insert("completion_tokens".to_string(), Value::Number(value.into()));
        usage.insert("output_tokens".to_string(), Value::Number(value.into()));
    }
    if let Some(value) = total {
        usage.insert("total_tokens".to_string(), Value::Number(value.into()));
    }
    root.insert("usage".to_string(), Value::Object(usage));
}
