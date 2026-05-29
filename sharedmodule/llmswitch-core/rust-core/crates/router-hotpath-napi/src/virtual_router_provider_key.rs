use napi::bindgen_prelude::Result as NapiResult;
use napi_derive::napi;
use serde::Serialize;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProviderKeyParseOutput {
    provider_id: Option<String>,
    alias: Option<String>,
    key_index: Option<i64>,
}

fn normalize_alias_descriptor(alias: &str) -> String {
    alias.to_string()
}

fn extract_provider_id(provider_key: &str) -> Option<String> {
    let first_dot = provider_key.find('.')?;
    if first_dot == 0 {
        return None;
    }
    Some(provider_key[..first_dot].to_string())
}

fn extract_key_alias(provider_key: &str) -> Option<String> {
    let first_dot = provider_key.find('.')?;
    if first_dot == 0 {
        return None;
    }
    let tail = &provider_key[(first_dot + 1)..];
    let second_dot_in_tail = tail.find('.')?;
    if second_dot_in_tail == 0 {
        return None;
    }
    let alias = &tail[..second_dot_in_tail];
    if alias.is_empty() {
        return None;
    }
    Some(normalize_alias_descriptor(alias))
}

fn extract_key_index(provider_key: &str) -> Option<i64> {
    let parts: Vec<&str> = provider_key.split('.').collect();
    if parts.len() != 2 {
        return None;
    }
    let parsed = parts[1].parse::<i64>().ok()?;
    if parsed > 0 {
        return Some(parsed);
    }
    None
}

fn parse_provider_key(provider_key: String) -> ProviderKeyParseOutput {
    ProviderKeyParseOutput {
        provider_id: extract_provider_id(&provider_key),
        alias: extract_key_alias(&provider_key),
        key_index: extract_key_index(&provider_key),
    }
}

#[napi]
pub fn parse_provider_key_json(provider_key: String) -> NapiResult<String> {
    let output = parse_provider_key(provider_key);
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}
