use serde_json::{Map, Value};

pub(crate) fn as_object(value: &Value) -> Option<&Map<String, Value>> {
    value.as_object()
}

pub(crate) fn normalize_record(value: Value) -> Map<String, Value> {
    match value {
        Value::Object(row) => row,
        _ => Map::new(),
    }
}

pub(crate) fn normalize_record_ref(value: &Value) -> Map<String, Value> {
    match value {
        Value::Object(row) => row.clone(),
        _ => Map::new(),
    }
}

pub(crate) fn value_as_object_or_empty(value: &Value) -> Map<String, Value> {
    value.as_object().cloned().unwrap_or_default()
}

pub(crate) fn parse_json_bool(raw: &str) -> Option<bool> {
    match serde_json::from_str::<Value>(raw) {
        Ok(Value::Bool(v)) => Some(v),
        _ => None,
    }
}

pub(crate) fn parse_js_number_like(value: Option<&Value>) -> Option<f64> {
    match value {
        Some(Value::Number(num)) => num.as_f64(),
        Some(Value::String(raw)) => raw.trim().parse::<f64>().ok(),
        _ => None,
    }
}

pub(crate) fn read_trimmed_string(value: Option<&Value>) -> Option<String> {
    let raw = value
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    if raw.is_empty() {
        return None;
    }
    Some(raw)
}

#[cfg(test)]
mod tests {
    use super::{
        as_object, normalize_record, normalize_record_ref, parse_js_number_like, parse_json_bool,
        read_trimmed_string, value_as_object_or_empty,
    };
    use serde_json::json;

    #[test]
    fn read_trimmed_string_returns_trimmed_non_empty_string() {
        let value = json!("  hello  ");
        assert_eq!(read_trimmed_string(Some(&value)), Some("hello".to_string()));
    }

    #[test]
    fn read_trimmed_string_rejects_empty_or_non_string_values() {
        let empty = json!("   ");
        let number = json!(123);
        assert_eq!(read_trimmed_string(Some(&empty)), None);
        assert_eq!(read_trimmed_string(Some(&number)), None);
        assert_eq!(read_trimmed_string(None), None);
    }

    #[test]
    fn object_helpers_keep_only_json_objects() {
        let object = json!({"a": 1});
        let array = json!([1]);
        assert!(as_object(&object).is_some());
        assert!(as_object(&array).is_none());
        assert_eq!(normalize_record(object.clone()).get("a"), Some(&json!(1)));
        assert_eq!(normalize_record(array.clone()).len(), 0);
        assert_eq!(normalize_record_ref(&object).get("a"), Some(&json!(1)));
        assert_eq!(normalize_record_ref(&array).len(), 0);
        assert_eq!(value_as_object_or_empty(&object).get("a"), Some(&json!(1)));
        assert_eq!(value_as_object_or_empty(&array).len(), 0);
    }

    #[test]
    fn parse_json_bool_accepts_only_json_boolean_literals() {
        assert_eq!(parse_json_bool("true"), Some(true));
        assert_eq!(parse_json_bool("false"), Some(false));
        assert_eq!(parse_json_bool("\"true\""), None);
        assert_eq!(parse_json_bool("not-json"), None);
    }

    #[test]
    fn parse_js_number_like_accepts_numbers_and_numeric_strings() {
        let number = json!(12.5);
        let string = json!(" 7 ");
        let invalid = json!("x");
        assert_eq!(parse_js_number_like(Some(&number)), Some(12.5));
        assert_eq!(parse_js_number_like(Some(&string)), Some(7.0));
        assert_eq!(parse_js_number_like(Some(&invalid)), None);
        assert_eq!(parse_js_number_like(None), None);
    }
}
