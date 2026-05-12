/// Extract the provider id (first dot-separated segment) from a provider key.
/// e.g. "deepseek-web.3.deepseek-r1-search" -> Some("deepseek-web")
pub(crate) fn extract_provider_id(provider_key: &str) -> Option<String> {
    let value = provider_key.trim();
    let first_dot = value.find('.')?;
    if first_dot == 0 {
        return None;
    }
    Some(value[..first_dot].to_string())
}

/// Extract the key alias (second dot-separated segment) from a provider key.
/// e.g. "deepseek-web.3.deepseek-r1-search" -> Some("3")
pub(crate) fn extract_key_alias(provider_key: &str) -> Option<String> {
    let value = provider_key.trim();
    let first_dot = value.find('.')?;
    let remainder = &value[first_dot + 1..];
    let second_dot = remainder.find('.')?;
    if second_dot == 0 {
        return None;
    }
    Some(remainder[..second_dot].to_string())
}

/// Extract the key index (numeric key alias) from a provider key.
pub(crate) fn extract_key_index(provider_key: &str) -> Option<i64> {
    let alias = extract_key_alias(provider_key)?;
    alias.parse::<i64>().ok()
}
