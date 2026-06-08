use serde_json::{Map, Value};
use std::collections::HashSet;

const CONTEXT_TOKEN_KEYS: &[&str] = &[
    "maxContext",
    "max_context",
    "contextWindow",
    "context_window",
    "maxContextTokens",
    "max_context_tokens",
    "contextTokens",
    "context_tokens",
];

pub(crate) fn build_runtime_key(provider_id: &str, key_alias: &str) -> String {
    format!("{}.{}", provider_id, key_alias)
}

pub(crate) fn normalize_capability_name(raw: &str) -> Option<String> {
    let normalized = raw.trim().to_lowercase();
    if normalized.is_empty() {
        return None;
    }
    Some(match normalized.as_str() {
        "websearch" | "web-search" => "web_search".to_string(),
        "websearch-direct" | "web_search_direct" | "web-search-direct" => {
            "web_search_direct".to_string()
        }
        _ => normalized,
    })
}

pub(crate) fn normalize_capability_list(value: &Value, allowed: Option<&[&str]>) -> Vec<String> {
    let Some(items) = value.as_array() else {
        return Vec::new();
    };
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for item in items {
        let Some(mapped) = item.as_str().and_then(normalize_capability_name) else {
            continue;
        };
        if allowed
            .map(|allowlist| allowlist.contains(&mapped.as_str()))
            .unwrap_or(true)
            && seen.insert(mapped.clone())
        {
            out.push(mapped);
        }
    }
    out
}

pub(crate) fn read_context_tokens(record: Option<&Map<String, Value>>) -> Option<i64> {
    let record = record?;
    let mut best: Option<i64> = None;
    for key in CONTEXT_TOKEN_KEYS {
        if let Some(value) = normalize_positive_integer(record.get(*key)) {
            best = Some(best.map_or(value, |current| current.max(value)));
        }
    }
    best
}

pub(crate) fn normalize_positive_integer(value: Option<&Value>) -> Option<i64> {
    match value {
        Some(Value::Number(number)) => number
            .as_i64()
            .or_else(|| number.as_f64().map(|v| v as i64)),
        Some(Value::String(raw)) => raw.trim().parse::<f64>().ok().map(|v| v as i64),
        _ => None,
    }
    .filter(|value| *value > 0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn context_tokens_use_largest_declared_window() {
        let input = json!({
            "maxContext": 262144,
            "maxContextTokens": 200000,
            "contextWindow": "131072"
        });
        assert_eq!(read_context_tokens(input.as_object()), Some(262144));
    }

    #[test]
    fn capability_aliases_are_canonicalized_once() {
        assert_eq!(
            normalize_capability_name("web-search"),
            Some("web_search".to_string())
        );
        assert_eq!(
            normalize_capability_name("websearch-direct"),
            Some("web_search_direct".to_string())
        );
        assert_eq!(normalize_capability_name("  "), None);
        assert_eq!(
            normalize_capability_list(&json!(["websearch", "web-search"]), None),
            vec!["web_search".to_string()]
        );
    }
}
