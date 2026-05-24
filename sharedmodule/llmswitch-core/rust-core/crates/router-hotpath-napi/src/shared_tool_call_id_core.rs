use sha2::{Digest, Sha256};
use uuid::Uuid;

const MAX_RESPONSES_ITEM_ID_LENGTH: usize = 64;

pub(crate) fn sanitize_id_core(value: &str) -> String {
    let mut out = String::new();
    let mut prev_underscore = false;
    for ch in value.chars() {
        let normalized = if ch.is_ascii_alphanumeric() || ch == '_' || ch == '-' {
            ch
        } else {
            '_'
        };
        if normalized == '_' {
            if !prev_underscore {
                out.push('_');
            }
            prev_underscore = true;
        } else {
            out.push(normalized);
            prev_underscore = false;
        }
    }
    out.trim_matches('_').to_string()
}

pub(crate) fn sanitize_id_core_basic(value: &str) -> String {
    value
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '_' || ch == '-' {
                ch
            } else {
                '_'
            }
        })
        .collect::<String>()
        .trim_matches('_')
        .to_string()
}

pub(crate) fn collapse_underscores(value: &str) -> String {
    let mut out = String::new();
    let mut prev_underscore = false;
    for ch in value.chars() {
        if ch == '_' {
            if prev_underscore {
                continue;
            }
            prev_underscore = true;
            out.push(ch);
        } else {
            prev_underscore = false;
            out.push(ch);
        }
    }
    out
}

pub(crate) fn short_id_hash(value: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(value.as_bytes());
    let digest = hasher.finalize();
    let mut out = String::new();
    for byte in digest.iter().take(5) {
        out.push_str(&format!("{:02x}", byte));
    }
    out
}

pub(crate) fn clamp_prefixed_tool_call_id(prefix: &str, core: &str, hash_source: &str) -> String {
    let sanitized = {
        let raw = sanitize_id_core(core);
        if raw.is_empty() {
            Uuid::new_v4().simple().to_string()[..8].to_string()
        } else {
            raw
        }
    };
    let direct = format!("{}{}", prefix, sanitized);
    if direct.len() <= MAX_RESPONSES_ITEM_ID_LENGTH {
        return direct;
    }
    let hash = short_id_hash(&format!("{}|{}|{}", prefix, hash_source, sanitized));
    let room = std::cmp::max(
        1,
        MAX_RESPONSES_ITEM_ID_LENGTH.saturating_sub(prefix.len() + 1 + hash.len()),
    );
    let head = {
        let raw = sanitize_id_core(&sanitized.chars().take(room).collect::<String>());
        if raw.is_empty() {
            "id".to_string()
        } else {
            raw
        }
    };
    format!("{}{}_{}", prefix, head, hash)
}

pub(crate) fn extract_tool_call_id_core(value: Option<&str>) -> Option<String> {
    let raw = value?;
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    let mut sanitized = sanitize_id_core(trimmed);
    if sanitized.is_empty() {
        return None;
    }
    let lower = sanitized.to_ascii_lowercase();
    if lower.starts_with("fc_") || lower.starts_with("fc-") {
        sanitized = sanitized[3..].to_string();
    } else if lower.starts_with("call_") || lower.starts_with("call-") {
        sanitized = sanitized[5..].to_string();
    }
    let normalized = sanitize_id_core(&sanitized);
    if normalized.is_empty() {
        return None;
    }
    Some(normalized)
}

pub(crate) fn extract_tool_call_id_core_collapsed(value: Option<&str>) -> Option<String> {
    let raw = value?.trim();
    if raw.is_empty() {
        return None;
    }
    let mut sanitized = sanitize_id_core_basic(raw);
    if sanitized.is_empty() {
        return None;
    }
    let lower = sanitized.to_ascii_lowercase();
    if lower.starts_with("fc_") || lower.starts_with("fc-") {
        sanitized = sanitized.chars().skip(3).collect::<String>();
    } else if lower.starts_with("call_") || lower.starts_with("call-") {
        sanitized = sanitized.chars().skip(5).collect::<String>();
    }
    let normalized = sanitize_id_core_basic(&sanitized);
    if normalized.is_empty() {
        None
    } else {
        Some(collapse_underscores(&normalized))
    }
}

pub(crate) fn normalize_prefixed_tool_call_id(
    call_id: Option<&str>,
    fallback: Option<&str>,
    prefix: &str,
) -> String {
    if let Some(call_core) = extract_tool_call_id_core(call_id) {
        return clamp_prefixed_tool_call_id(prefix, &call_core, call_id.unwrap_or_default());
    }
    if let Some(fallback_core) = extract_tool_call_id_core(fallback) {
        return clamp_prefixed_tool_call_id(
            prefix,
            &fallback_core,
            fallback.unwrap_or_default(),
        );
    }
    let random_core = Uuid::new_v4().simple().to_string()[..8].to_string();
    clamp_prefixed_tool_call_id(prefix, &random_core, &random_core)
}

pub(crate) fn clamp_responses_input_item_id(raw: Option<&str>) -> Option<String> {
    let trimmed = raw.unwrap_or("").trim();
    if trimmed.is_empty() {
        return None;
    }
    if trimmed.len() <= MAX_RESPONSES_ITEM_ID_LENGTH {
        return Some(trimmed.to_string());
    }
    let hash = short_id_hash(trimmed);
    let room = MAX_RESPONSES_ITEM_ID_LENGTH
        .saturating_sub(1)
        .saturating_sub(hash.len())
        .max(1);
    let head = trimmed.chars().take(room).collect::<String>();
    Some(format!("{}_{}", head, hash))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitize_id_core_replaces_non_word_and_collapses_underscore() {
        assert_eq!(sanitize_id_core("  a..b///c  "), "a_b_c");
        assert_eq!(sanitize_id_core("___a____b___"), "a_b");
    }

    #[test]
    fn short_id_hash_is_stable_ten_hex_chars() {
        let first = short_id_hash("routecodex");
        let second = short_id_hash("routecodex");
        assert_eq!(first, second);
        assert_eq!(first.len(), 10);
        assert!(first.chars().all(|ch| ch.is_ascii_hexdigit()));
    }

    #[test]
    fn sanitize_id_core_basic_keeps_repeated_underscores_until_explicit_collapse() {
        assert_eq!(sanitize_id_core_basic("a..b///c"), "a__b___c");
        assert_eq!(collapse_underscores("a__b___c"), "a_b_c");
    }

    #[test]
    fn extract_tool_call_id_core_strips_fc_and_call_prefixes() {
        assert_eq!(
            extract_tool_call_id_core(Some(" fc_tool.alpha ")).as_deref(),
            Some("tool_alpha")
        );
        assert_eq!(
            extract_tool_call_id_core(Some("call-tool.beta")).as_deref(),
            Some("tool_beta")
        );
        assert_eq!(extract_tool_call_id_core(Some("___")), None);
    }

    #[test]
    fn extract_tool_call_id_core_collapsed_matches_lmstudio_and_response_compat_shape() {
        assert_eq!(
            extract_tool_call_id_core_collapsed(Some(" fc__tool..alpha ")).as_deref(),
            Some("tool_alpha")
        );
        assert_eq!(
            extract_tool_call_id_core_collapsed(Some("call-tool///beta")).as_deref(),
            Some("tool_beta")
        );
        assert_eq!(extract_tool_call_id_core_collapsed(Some("___")), None);
    }

    #[test]
    fn clamp_prefixed_tool_call_id_caps_length_and_preserves_prefix() {
        let value = clamp_prefixed_tool_call_id(
            "call_",
            "abcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyz",
            "hash-source",
        );
        assert!(value.starts_with("call_"));
        assert!(value.len() <= MAX_RESPONSES_ITEM_ID_LENGTH);
    }

    #[test]
    fn normalize_prefixed_tool_call_id_prefers_call_id_then_fallback() {
        assert_eq!(
            normalize_prefixed_tool_call_id(Some("fc_abc"), Some("fallback"), "fc_"),
            "fc_abc"
        );
        assert_eq!(
            normalize_prefixed_tool_call_id(None, Some("fallback-value"), "call_"),
            "call_fallback-value"
        );
    }

    #[test]
    fn clamp_responses_input_item_id_preserves_short_and_trims_empty() {
        assert_eq!(clamp_responses_input_item_id(None), None);
        assert_eq!(clamp_responses_input_item_id(Some("   ")), None);
        assert_eq!(
            clamp_responses_input_item_id(Some(" short-id ")).as_deref(),
            Some("short-id")
        );
    }

    #[test]
    fn clamp_responses_input_item_id_hashes_long_values_under_limit() {
        let raw = "x".repeat(120);
        let output = clamp_responses_input_item_id(Some(raw.as_str())).unwrap();
        assert!(output.len() <= 64);
        assert!(output.contains('_'));
        assert_ne!(output, raw);
    }
}
