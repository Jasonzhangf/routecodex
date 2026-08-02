pub(super) fn compact_tool_id(prefix: &str, raw: &str) -> String {
    const MAX_ID_LEN: usize = 64;
    let trimmed = raw.trim();
    let (stripped, stripped_source_prefix) = if let Some(value) = trimmed.strip_prefix("functions.")
    {
        (value, true)
    } else if let Some(value) = trimmed.strip_prefix("call_") {
        (value, true)
    } else if let Some(value) = trimmed.strip_prefix("fc_") {
        (value, true)
    } else {
        (trimmed, false)
    };
    let safe_full: String = stripped
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric() || *ch == '_' || *ch == '-')
        .collect();
    let lossless = !stripped_source_prefix
        && !safe_full.is_empty()
        && safe_full == stripped
        && prefix.len() + safe_full.len() <= MAX_ID_LEN;
    if lossless {
        return format!("{prefix}{safe_full}");
    }

    let hash = compact_tool_id_hash(raw);
    let keep = MAX_ID_LEN.saturating_sub(prefix.len() + 1 + hash.len());
    let body: String = safe_full.chars().take(keep).collect();
    if body.is_empty() {
        format!("{prefix}{hash}")
    } else {
        format!("{prefix}{body}_{hash}")
    }
}

fn compact_tool_id_hash(raw: &str) -> String {
    let mut hash: u64 = 0xcbf29ce484222325;
    for byte in raw.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("{hash:016x}")
}
