use napi::bindgen_prelude::Result as NapiResult;
use serde_json::{Map, Value};
use std::collections::HashSet;

fn is_valid_key(value: &str) -> bool {
    !value.trim().is_empty()
}

fn parse_allowed_keys(keys: &Value) -> HashSet<String> {
    keys.as_array()
        .map(|arr| {
            arr.iter()
                .filter_map(Value::as_str)
                .map(|raw| raw.trim().to_string())
                .filter(|key| is_valid_key(key))
                .collect::<HashSet<String>>()
        })
        .unwrap_or_default()
}

fn encode_metadata_passthrough(
    parameters: &Value,
    prefix: &str,
    keys: &Value,
) -> Option<Map<String, Value>> {
    let params = parameters.as_object()?;
    let allowed = parse_allowed_keys(keys);
    if allowed.is_empty() {
        return None;
    }
    let mut encoded = Map::new();
    for key in &allowed {
        if let Some(value) = params.get(key) {
            if let Ok(serialized) = serde_json::to_string(value) {
                encoded.insert(format!("{}{}", prefix, key), Value::String(serialized));
            }
        }
    }
    if encoded.is_empty() {
        None
    } else {
        Some(encoded)
    }
}

fn extract_metadata_passthrough(
    metadata_field: &Value,
    prefix: &str,
    keys: &Value,
) -> Map<String, Value> {
    let mut output = Map::new();
    let metadata_obj = match metadata_field.as_object() {
        Some(v) => v,
        None => return output,
    };

    let allowed = parse_allowed_keys(keys);
    let mut cloned = metadata_obj.clone();
    let mut passthrough = Map::new();
    let mut mutated = false;
    let candidate_keys = cloned.keys().cloned().collect::<Vec<String>>();
    for raw_key in candidate_keys {
        if !raw_key.starts_with(prefix) {
            continue;
        }
        let suffix = raw_key[prefix.len()..].to_string();
        if !allowed.contains(&suffix) {
            continue;
        }
        let raw_value = match cloned.get(&raw_key).and_then(Value::as_str) {
            Some(v) => v,
            None => continue,
        };
        let parsed = if raw_value.is_empty() {
            Value::Null
        } else {
            match serde_json::from_str::<Value>(raw_value) {
                Ok(v) => v,
                Err(_) => continue,
            }
        };
        passthrough.insert(suffix, parsed);
        cloned.remove(&raw_key);
        mutated = true;
    }

    if mutated {
        if !cloned.is_empty() {
            output.insert("metadata".to_string(), Value::Object(cloned));
        }
    } else {
        output.insert("metadata".to_string(), Value::Object(cloned));
    }
    if !passthrough.is_empty() {
        output.insert("passthrough".to_string(), Value::Object(passthrough));
    }
    output
}

fn ensure_protocol_state(metadata: &Value, protocol: &str) -> Map<String, Value> {
    let mut metadata_out = metadata.as_object().cloned().unwrap_or_else(Map::new);
    let node_clone = {
        let container = metadata_out
            .entry("protocolState".to_string())
            .or_insert_with(|| Value::Object(Map::new()));
        if !container.is_object() {
            *container = Value::Object(Map::new());
        }
        let node = container
            .as_object_mut()
            .unwrap()
            .entry(protocol.to_string())
            .or_insert_with(|| Value::Object(Map::new()));
        if !node.is_object() {
            *node = Value::Object(Map::new());
        }
        node.clone()
    };
    let mut output = Map::new();
    output.insert("metadata".to_string(), Value::Object(metadata_out));
    output.insert("node".to_string(), node_clone);
    output
}

pub(crate) fn ensure_protocol_state_mut<'a>(
    metadata: &'a mut Map<String, Value>,
    protocol: &str,
) -> &'a mut Map<String, Value> {
    let container = metadata
        .entry("protocolState".to_string())
        .or_insert_with(|| Value::Object(Map::new()));
    if !container.is_object() {
        *container = Value::Object(Map::new());
    }
    let container_obj = container.as_object_mut().unwrap();
    let node = container_obj
        .entry(protocol.to_string())
        .or_insert_with(|| Value::Object(Map::new()));
    if !node.is_object() {
        *node = Value::Object(Map::new());
    }
    node.as_object_mut().unwrap()
}

fn get_protocol_state(metadata: &Value, protocol: &str) -> Value {
    metadata
        .as_object()
        .and_then(|row| row.get("protocolState"))
        .and_then(Value::as_object)
        .and_then(|row| row.get(protocol))
        .and_then(Value::as_object)
        .map(|row| Value::Object(row.clone()))
        .unwrap_or(Value::Null)
}

fn read_runtime_metadata(carrier: &Value) -> Value {
    carrier
        .as_object()
        .and_then(|row| row.get("__rt"))
        .and_then(Value::as_object)
        .map(|row| Value::Object(row.clone()))
        .unwrap_or(Value::Null)
}

fn ensure_runtime_metadata(carrier: &Value) -> Result<Value, String> {
    let mut carrier_obj = carrier
        .as_object()
        .cloned()
        .ok_or_else(|| "ensureRuntimeMetadata requires object carrier".to_string())?;
    let ensure = carrier_obj
        .entry("__rt".to_string())
        .or_insert_with(|| Value::Object(Map::new()));
    if !ensure.is_object() {
        *ensure = Value::Object(Map::new());
    }
    Ok(Value::Object(carrier_obj))
}

fn clone_runtime_metadata(carrier: &Value) -> Value {
    read_runtime_metadata(carrier)
}

#[napi_derive::napi]
pub fn encode_metadata_passthrough_json(
    parameters_json: String,
    prefix: String,
    keys_json: String,
) -> NapiResult<String> {
    let parameters: Value = serde_json::from_str(&parameters_json)
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let keys: Value =
        serde_json::from_str(&keys_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let output = encode_metadata_passthrough(&parameters, prefix.as_str(), &keys)
        .map(Value::Object)
        .unwrap_or(Value::Null);
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi_derive::napi]
pub fn extract_metadata_passthrough_json(
    metadata_field_json: String,
    prefix: String,
    keys_json: String,
) -> NapiResult<String> {
    let metadata_field: Value = serde_json::from_str(&metadata_field_json)
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let keys: Value =
        serde_json::from_str(&keys_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let output = extract_metadata_passthrough(&metadata_field, prefix.as_str(), &keys);
    serde_json::to_string(&Value::Object(output))
        .map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi_derive::napi]
pub fn ensure_protocol_state_json(metadata_json: String, protocol: String) -> NapiResult<String> {
    let metadata: Value = serde_json::from_str(&metadata_json)
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let output = ensure_protocol_state(&metadata, protocol.as_str());
    serde_json::to_string(&Value::Object(output))
        .map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi_derive::napi]
pub fn get_protocol_state_json(metadata_json: String, protocol: String) -> NapiResult<String> {
    let metadata: Value = serde_json::from_str(&metadata_json)
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let output = get_protocol_state(&metadata, protocol.as_str());
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi_derive::napi]
pub fn read_runtime_metadata_json(carrier_json: String) -> NapiResult<String> {
    let carrier: Value =
        serde_json::from_str(&carrier_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let output = read_runtime_metadata(&carrier);
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi_derive::napi]
pub fn ensure_runtime_metadata_json(carrier_json: String) -> NapiResult<String> {
    let carrier: Value =
        serde_json::from_str(&carrier_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let output = ensure_runtime_metadata(&carrier).map_err(napi::Error::from_reason)?;
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi_derive::napi]
pub fn clone_runtime_metadata_json(carrier_json: String) -> NapiResult<String> {
    let carrier: Value =
        serde_json::from_str(&carrier_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let output = clone_runtime_metadata(&carrier);
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}
