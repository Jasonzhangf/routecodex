use napi::bindgen_prelude::Result as NapiResult;
use serde::Deserialize;
use serde_json::{Map, Number, Value};
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FieldMapping {
    source_path: String,
    target_path: String,
    #[serde(rename = "type")]
    mapping_type: String,
    #[serde(default)]
    transform: Option<String>,
}

const MODEL_PREFIX: &str = "gpt-";
const MODEL_PREFIX_REPLACEMENT: &str = "glm-";

fn normalize_finish_reason(value: &str) -> String {
    match value {
        "tool_calls" => "tool_calls".to_string(),
        "stop" => "stop".to_string(),
        "length" => "length".to_string(),
        "sensitive" => "content_filter".to_string(),
        "network_error" => "error".to_string(),
        _ => value.to_string(),
    }
}

fn js_now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

fn value_to_js_string(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Null => "null".to_string(),
        Value::Bool(flag) => {
            if *flag {
                "true".to_string()
            } else {
                "false".to_string()
            }
        }
        Value::Number(number) => number.to_string(),
        Value::Array(items) => items
            .iter()
            .map(value_to_js_string)
            .collect::<Vec<String>>()
            .join(","),
        Value::Object(_) => "[object Object]".to_string(),
    }
}

fn value_to_js_number(value: &Value) -> Option<f64> {
    match value {
        Value::Number(number) => number.as_f64(),
        Value::String(text) => text.parse::<f64>().ok(),
        Value::Bool(flag) => Some(if *flag { 1.0 } else { 0.0 }),
        Value::Null => Some(0.0),
        _ => None,
    }
}

fn value_to_js_boolean(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(flag) => *flag,
        Value::Number(number) => number.as_f64().map(|n| n != 0.0 && !n.is_nan()).unwrap_or(false),
        Value::String(text) => !text.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

fn convert_type(value: Value, mapping_type: &str) -> Value {
    if value.is_null() {
        return value;
    }
    match mapping_type {
        "string" => Value::String(value_to_js_string(&value)),
        "number" => match value_to_js_number(&value) {
            Some(parsed) if parsed.is_finite() => Number::from_f64(parsed)
                .map(Value::Number)
                .unwrap_or_else(|| Value::Number(Number::from(0))),
            _ => Value::Number(Number::from(0)),
        },
        "boolean" => Value::Bool(value_to_js_boolean(&value)),
        "object" => {
            if value.is_object() {
                value
            } else {
                Value::Object(Map::new())
            }
        }
        "array" => {
            if value.is_array() {
                value
            } else {
                Value::Array(vec![value])
            }
        }
        _ => value,
    }
}

fn apply_transform(value: Value, transform: Option<&str>) -> Value {
    let Some(transform_name) = transform.map(|name| name.trim()).filter(|name| !name.is_empty()) else {
        return value;
    };
    match transform_name {
        "timestamp" => {
            if value.is_number() {
                value
            } else {
                Value::Number(Number::from(js_now_millis()))
            }
        }
        "lowercase" => match value {
            Value::String(text) => Value::String(text.to_ascii_lowercase()),
            other => other,
        },
        "uppercase" => match value {
            Value::String(text) => Value::String(text.to_ascii_uppercase()),
            other => other,
        },
        "normalizeModelName" => match value {
            Value::String(text) => {
                if text.starts_with(MODEL_PREFIX) {
                    Value::String(text.replacen(MODEL_PREFIX, MODEL_PREFIX_REPLACEMENT, 1))
                } else {
                    Value::String(text)
                }
            }
            other => other,
        },
        "normalizeFinishReason" => match value {
            Value::String(text) => Value::String(normalize_finish_reason(&text)),
            other => other,
        },
        _ => value,
    }
}

fn get_nested_property(root: &Value, path_expression: &str) -> Option<Value> {
    let keys: Vec<&str> = path_expression.split('.').collect();
    if path_expression.contains("[*]") {
        let mut results: Vec<Value> = Vec::new();
        collect_wildcard_values(root, &keys, 0, &mut results);
        return Some(Value::Array(results));
    }

    let mut current = root;
    for key in keys {
        let next = current.as_object().and_then(|row| row.get(key))?;
        current = next;
    }
    Some(current.clone())
}

fn collect_wildcard_values(
    current: &Value,
    keys: &[&str],
    key_index: usize,
    results: &mut Vec<Value>,
) {
    if key_index >= keys.len() {
        results.push(current.clone());
        return;
    }
    let key = keys[key_index];
    if key == "[*]" {
        if let Some(items) = current.as_array() {
            for item in items {
                collect_wildcard_values(item, keys, key_index + 1, results);
            }
        }
        return;
    }
    if let Some(next) = current.as_object().and_then(|row| row.get(key)) {
        collect_wildcard_values(next, keys, key_index + 1, results);
    }
}

fn set_nested_property(root: &mut Value, path_expression: &str, value: Value) {
    let keys: Vec<&str> = path_expression.split('.').collect();
    if path_expression.contains("[*]") {
        set_wildcard_property(root, &keys, 0, &value);
        return;
    }
    set_nested_property_plain(root, &keys, value);
}

fn set_nested_property_plain(root: &mut Value, keys: &[&str], value: Value) {
    if keys.is_empty() {
        return;
    }
    if !root.is_object() {
        *root = Value::Object(Map::new());
    }
    let mut cursor = root;
    for key in &keys[..keys.len() - 1] {
        let next = cursor
            .as_object_mut()
            .expect("cursor object")
            .entry((*key).to_string())
            .or_insert_with(|| Value::Object(Map::new()));
        if !next.is_object() {
            *next = Value::Object(Map::new());
        }
        cursor = next;
    }
    if let Some(last_key) = keys.last() {
        cursor
            .as_object_mut()
            .expect("cursor object")
            .insert((*last_key).to_string(), value);
    }
}

fn set_wildcard_property(current: &mut Value, keys: &[&str], key_index: usize, value: &Value) {
    if key_index >= keys.len() {
        return;
    }
    if key_index == keys.len() - 1 {
        let last_key = keys[key_index].replace("[*]", "");
        if let Some(items) = current.as_array_mut() {
            for item in items {
                if let Some(row) = item.as_object_mut() {
                    row.insert(last_key.clone(), value.clone());
                }
            }
        }
        return;
    }
    let key = keys[key_index];
    if key == "[*]" {
        if let Some(items) = current.as_array_mut() {
            for item in items {
                set_wildcard_property(item, keys, key_index + 1, value);
            }
        }
        return;
    }
    if let Some(next) = current.as_object_mut().and_then(|row| row.get_mut(key)) {
        set_wildcard_property(next, keys, key_index + 1, value);
    }
}

fn apply_single_mapping(root: &mut Value, mapping: &FieldMapping) {
    let Some(source_value) = get_nested_property(root, mapping.source_path.as_str()) else {
        return;
    };
    let transformed = apply_transform(source_value, mapping.transform.as_deref());
    let converted = convert_type(transformed, mapping.mapping_type.as_str());
    set_nested_property(root, mapping.target_path.as_str(), converted);
}

#[napi_derive::napi]
pub fn apply_field_mappings_json(payload_json: String, mappings_json: String) -> NapiResult<String> {
    let payload: Value =
        serde_json::from_str(&payload_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let mappings: Vec<FieldMapping> = serde_json::from_str(&mappings_json)
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;

    let mut result = payload;
    for mapping in &mappings {
        apply_single_mapping(&mut result, mapping);
    }

    serde_json::to_string(&result).map_err(|e| napi::Error::from_reason(e.to_string()))
}
