fn provider_protocol_matches(protocol: Option<&String>, expected: &str) -> bool {
    if let Some(protocol) = protocol {
        return protocol.trim().eq_ignore_ascii_case(expected);
    }
    false
}

fn read_rt_bool(adapter_context: &AdapterContext, key: &str) -> Option<bool> {
    adapter_context
        .rt
        .as_ref()
        .and_then(|value| value.as_object())
        .and_then(|row| row.get(key))
        .and_then(|value| value.as_bool())
}

fn lmstudio_stringify_input_enabled(adapter_context: &AdapterContext) -> bool {
    if let Some(override_value) = read_rt_bool(adapter_context, "lmstudioStringifyInputEnabled")
    {
        return override_value;
    }
    matches!(
        std::env::var("LLMSWITCH_LMSTUDIO_STRINGIFY_INPUT").ok().as_deref(),
        Some("1")
    ) || matches!(
        std::env::var("ROUTECODEX_LMSTUDIO_STRINGIFY_INPUT").ok().as_deref(),
        Some("1")
    )
}

fn sanitize_id_core(value: &str) -> String {
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

fn collapse_underscores(value: &str) -> String {
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

fn short_hash(value: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(value.as_bytes());
    format!("{:x}", hasher.finalize())
        .chars()
        .take(10)
        .collect::<String>()
}

fn clamp_prefixed_id(prefix: &str, core: &str, hash_source: &str) -> String {
    const MAX_RESPONSES_ITEM_ID_LENGTH: usize = 64;
    let sanitized = {
        let base = collapse_underscores(&sanitize_id_core(core));
        if base.is_empty() {
            Uuid::new_v4()
                .to_string()
                .replace('-', "")
                .chars()
                .take(8)
                .collect::<String>()
        } else {
            base
        }
    };
    let direct = format!("{}{}", prefix, sanitized);
    if direct.len() <= MAX_RESPONSES_ITEM_ID_LENGTH {
        return direct;
    }
    let hash = short_hash(&format!("{}|{}|{}", prefix, hash_source, sanitized));
    let room = MAX_RESPONSES_ITEM_ID_LENGTH
        .saturating_sub(prefix.len())
        .saturating_sub(1)
        .saturating_sub(hash.len())
        .max(1);
    let head = sanitize_id_core(&sanitized.chars().take(room).collect::<String>());
    format!(
        "{}{}_{}",
        prefix,
        if head.is_empty() { "id" } else { head.as_str() },
        hash
    )
}

fn extract_id_core(value: Option<&str>) -> Option<String> {
    let raw = value?.trim();
    if raw.is_empty() {
        return None;
    }
    let mut sanitized = sanitize_id_core(raw);
    if sanitized.is_empty() {
        return None;
    }
    let lower = sanitized.to_ascii_lowercase();
    if lower.starts_with("fc_") || lower.starts_with("fc-") {
        sanitized = sanitized.chars().skip(3).collect::<String>();
    } else if lower.starts_with("call_") || lower.starts_with("call-") {
        sanitized = sanitized.chars().skip(5).collect::<String>();
    }
    let normalized = sanitize_id_core(&sanitized);
    if normalized.is_empty() {
        None
    } else {
        Some(collapse_underscores(&normalized))
    }
}

fn normalize_with_fallback(call_id: Option<&str>, fallback: Option<&str>, prefix: &str) -> String {
    if let Some(core) = extract_id_core(call_id) {
        return clamp_prefixed_id(prefix, &core, call_id.unwrap_or_default());
    }
    if let Some(core) = extract_id_core(fallback) {
        return clamp_prefixed_id(prefix, &core, fallback.unwrap_or_default());
    }
    let random_core = Uuid::new_v4()
        .to_string()
        .replace('-', "")
        .chars()
        .take(8)
        .collect::<String>();
    clamp_prefixed_id(prefix, &random_core, &random_core)
}

fn normalize_responses_call_id(call_id: Option<&str>, fallback: Option<&str>) -> String {
    normalize_with_fallback(call_id, fallback, "call_")
}

fn normalize_function_call_id(call_id: Option<&str>, fallback: Option<&str>) -> String {
    normalize_with_fallback(call_id, fallback, "fc_")
}

fn pick_trimmed_string_values(values: &[Option<&Value>]) -> Option<String> {
    for value in values {
        let Some(raw) = value.and_then(|v| v.as_str()) else {
            continue;
        };
        let trimmed = raw.trim();
        if !trimmed.is_empty() {
            return Some(trimmed.to_string());
        }
    }
    None
}
