// feature_id: vr.shared_function_library_helpers
use serde_json::{Number, Value};
use std::collections::HashSet;

/// Extract a trimmed string from a JSON value (string or number).
pub(crate) fn scalar_to_trimmed_string(value: &Value) -> Option<String> {
    match value {
        Value::String(raw) => {
            let trimmed = raw.trim();
            if trimmed.is_empty() {
                None
            } else {
                Some(trimmed.to_string())
            }
        }
        Value::Number(raw) => {
            let trimmed = raw.to_string();
            if trimmed.is_empty() {
                None
            } else {
                Some(trimmed)
            }
        }
        _ => None,
    }
}

pub(crate) fn trim_nonempty_str(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

pub(crate) fn push_unique_trimmed(out: &mut Vec<String>, seen: &mut HashSet<String>, value: &str) {
    let Some(normalized) = trim_nonempty_str(value) else {
        return;
    };
    if seen.insert(normalized.clone()) {
        out.push(normalized);
    }
}

pub(crate) fn normalize_unique_trimmed_strings<'a, I>(values: I) -> Vec<String>
where
    I: IntoIterator<Item = &'a str>,
{
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    for value in values {
        push_unique_trimmed(&mut out, &mut seen, value);
    }
    out
}

pub(crate) fn normalize_trimmed_string_values<'a, I>(values: I) -> Vec<String>
where
    I: IntoIterator<Item = &'a Value>,
{
    values
        .into_iter()
        .filter_map(|value| value.as_str().and_then(trim_nonempty_str))
        .collect()
}

/// Parse a JSON value as a boolean, treating string "true"/"false" as boolean.
pub(crate) fn parse_bool_like(value: &Value) -> Option<bool> {
    if let Some(boolean) = value.as_bool() {
        return Some(boolean);
    }
    value
        .as_str()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.eq_ignore_ascii_case("true"))
}

/// Parse a JSON value as a positive i64.
pub(crate) fn normalize_positive_i64(value: &Value) -> Option<i64> {
    let parsed = match value {
        Value::Number(number) => normalize_json_number(number),
        Value::String(raw) => raw.trim().parse::<f64>().ok().map(|parsed| parsed as i64),
        _ => None,
    }?;
    if parsed > 0 {
        Some(parsed)
    } else {
        None
    }
}

/// Convert a JSON Number to i64, truncating floats.
pub(crate) fn normalize_json_number(number: &Number) -> Option<i64> {
    if let Some(value) = number.as_i64() {
        return Some(value);
    }
    number.as_f64().and_then(|value| {
        if value.is_finite() {
            Some(value as i64)
        } else {
            None
        }
    })
}

/// Parse a priority value from JSON, falling back to a default.
pub(crate) fn normalize_priority_value(value: Option<&Value>, fallback: i64) -> i64 {
    match value {
        Some(Value::Number(number)) => normalize_json_number(number).unwrap_or(fallback),
        Some(Value::String(raw)) => raw
            .trim()
            .parse::<f64>()
            .ok()
            .map(|parsed| parsed as i64)
            .unwrap_or(fallback),
        _ => fallback,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn scalar_to_trimmed_string_accepts_strings_and_numbers_only() {
        assert_eq!(
            scalar_to_trimmed_string(&json!("  provider.model  ")),
            Some("provider.model".to_string())
        );
        assert_eq!(scalar_to_trimmed_string(&json!(12)), Some("12".to_string()));
        assert_eq!(scalar_to_trimmed_string(&json!("   ")), None);
        assert_eq!(scalar_to_trimmed_string(&json!(true)), None);
    }

    #[test]
    fn vr_shared_function_library_helpers_normalize_string_lists() {
        assert_eq!(trim_nonempty_str("  key1  "), Some("key1".to_string()));
        assert_eq!(trim_nonempty_str("   "), None);

        let mut out = Vec::new();
        let mut seen = HashSet::new();
        push_unique_trimmed(&mut out, &mut seen, " key1 ");
        push_unique_trimmed(&mut out, &mut seen, "key1");
        push_unique_trimmed(&mut out, &mut seen, " key2 ");
        assert_eq!(out, vec!["key1".to_string(), "key2".to_string()]);

        let values = [" a ", "", "a", " b "];
        assert_eq!(
            normalize_unique_trimmed_strings(values),
            vec!["a".to_string(), "b".to_string()]
        );
        let json_values = [json!(" a "), json!(1), json!(""), json!(" a ")];
        assert_eq!(
            normalize_trimmed_string_values(json_values.iter()),
            vec!["a".to_string(), "a".to_string()]
        );
    }

    #[test]
    fn bool_and_number_normalizers_preserve_bootstrap_config_semantics() {
        assert_eq!(parse_bool_like(&json!(true)), Some(true));
        assert_eq!(parse_bool_like(&json!("false")), Some(false));
        assert_eq!(normalize_positive_i64(&json!(3.9)), Some(3));
        assert_eq!(normalize_positive_i64(&json!("4.2")), Some(4));
        assert_eq!(normalize_positive_i64(&json!(0)), None);
        assert_eq!(normalize_priority_value(Some(&json!("7.8")), 100), 7);
        assert_eq!(normalize_priority_value(Some(&json!({})), 100), 100);
    }
}
