use serde_json::{Number, Value};

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
