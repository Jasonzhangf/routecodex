use napi::bindgen_prelude::Result as NapiResult;
use napi_derive::napi;
use serde_json::Value;

fn strip_xssi_prefix(input: &str) -> &str {
    let mut normalized = input.trim_start();
    if let Some(stripped) = normalized.strip_prefix(")]}'") {
        normalized = stripped;
        if let Some(after_comma) = normalized.strip_prefix(',') {
            normalized = after_comma;
        }
        normalized = normalized.trim_start();
    }
    normalized
}

fn strip_data_prefix_case_insensitive(input: &str) -> &str {
    let trimmed = input.trim_start();
    if trimmed.len() < 5 {
        return trimmed;
    }

    let mut iter = trimmed.chars();
    let mut prefix = String::new();
    for _ in 0..5 {
        if let Some(ch) = iter.next() {
            prefix.push(ch);
        }
    }
    if !prefix.eq_ignore_ascii_case("data:") {
        return trimmed;
    }

    let rest = &trimmed[prefix.len()..];
    rest.trim_start()
}

fn normalize_json_probe_prefix(input: &str) -> &str {
    strip_data_prefix_case_insensitive(strip_xssi_prefix(input))
}

fn looks_like_json_prefix(first_chunk_text: &str) -> bool {
    let normalized = normalize_json_probe_prefix(first_chunk_text);
    normalized.starts_with('{') || normalized.starts_with('[')
}

fn parse_json_object_candidate(raw_text: &str, max_bytes: usize) -> Option<Value> {
    let normalized = normalize_json_probe_prefix(raw_text);
    if !(normalized.starts_with('{') || normalized.starts_with('[')) {
        return None;
    }
    if normalized.len() > max_bytes {
        return None;
    }

    let parsed: Value = serde_json::from_str(normalized).ok()?;
    match parsed {
        Value::Object(_) => Some(parsed),
        _ => None,
    }
}

#[napi]
pub fn looks_like_json_stream_prefix_json(first_chunk_text: String) -> NapiResult<String> {
    let output = looks_like_json_prefix(&first_chunk_text);
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi]
pub fn parse_json_object_candidate_json(raw_text: String, max_bytes: i64) -> NapiResult<String> {
    let cap = if max_bytes <= 0 {
        0usize
    } else {
        max_bytes as usize
    };
    let output = parse_json_object_candidate(&raw_text, cap);
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::parse_json_object_candidate;

    #[test]
    fn parse_candidate_accepts_xssi_prefix() {
        let parsed = parse_json_object_candidate(")]}',\n{\"ok\":true}", 1024);
        assert!(parsed.is_some());
    }

    #[test]
    fn parse_candidate_accepts_data_prefix() {
        let parsed = parse_json_object_candidate("data: {\"ok\":true}", 1024);
        assert!(parsed.is_some());
    }
}
