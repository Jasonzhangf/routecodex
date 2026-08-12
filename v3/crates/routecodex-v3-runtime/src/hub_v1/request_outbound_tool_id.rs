/// 规范化 tool call id 为 responses function_call item id：
/// - 前缀归一（functions./call_/fc_ -> fc_）与合法字符过滤保持原语义；
/// - 保留 hash 后缀用于字符过滤/前缀变换后的防碰撞（同一轮多个 tool call 不得碰撞）；
/// - 不按长度截断：超长 id 原样保留（长度截断逻辑已移除）。
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
    if safe_full.is_empty() {
        format!("{prefix}{hash}")
    } else {
        format!("{prefix}{safe_full}_{hash}")
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
