fn cache_antigravity_request_session_meta(
    request_id: &str,
    alias_key: &str,
    session_id: &str,
    message_count: i64,
) {
    let rid = request_id.trim();
    let sid = session_id.trim();
    if rid.is_empty() || sid.is_empty() {
        return;
    }
    let alias = normalize_alias_key(Some(alias_key));
    let normalized_count = if message_count > 0 { message_count } else { 1 };
    let now = now_ms();
    if let Ok(mut guard) = request_session_meta_cache().lock() {
        guard.insert(
            rid.to_string(),
            RequestSessionMeta {
                alias_key: alias,
                session_id: sid.to_string(),
                message_count: normalized_count,
                timestamp_ms: now,
            },
        );
        trim_oldest_entries(&mut guard, SESSION_CACHE_LIMIT, |entry| entry.timestamp_ms);
    }
}

fn get_antigravity_request_session_meta(request_id: &str) -> Option<RequestSessionMeta> {
    let rid = request_id.trim();
    if rid.is_empty() {
        return None;
    }
    request_session_meta_cache()
        .lock()
        .ok()
        .and_then(|guard| guard.get(rid).cloned())
}

pub(crate) fn get_antigravity_request_session_meta_for_bridge(
    request_id: &str,
) -> Option<(String, String, i64)> {
    get_antigravity_request_session_meta(request_id).map(|entry| {
        (
            entry.alias_key,
            entry.session_id,
            if entry.message_count > 0 {
                entry.message_count
            } else {
                1
            },
        )
    })
}

fn cache_antigravity_session_signature(
    alias_key: &str,
    session_id: &str,
    signature: &str,
    message_count: i64,
) {
    let trimmed_signature = signature.trim();
    if trimmed_signature.len() < MIN_SIGNATURE_LENGTH
        || trimmed_signature == DUMMY_THOUGHT_SIGNATURE_SENTINEL
    {
        return;
    }
    let cache_key = build_signature_key(alias_key, session_id);
    if cache_key.is_empty() {
        return;
    }
    let normalized_alias = normalize_alias_key(Some(alias_key));
    let normalized_count = if message_count > 0 { message_count } else { 1 };
    let now = now_ms();
    if let Ok(mut guard) = session_signature_cache().lock() {
        let should_store = match guard.get(&cache_key) {
            Some(existing) => {
                normalized_count < existing.message_count
                    || normalized_count > existing.message_count
                    || (normalized_count == existing.message_count
                        && trimmed_signature.len() > existing.signature.len())
            }
            None => true,
        };
        if should_store {
            guard.insert(
                cache_key.clone(),
                SessionSignatureEntry {
                    signature: trimmed_signature.to_string(),
                    message_count: normalized_count,
                    timestamp_ms: now,
                },
            );
            trim_oldest_entries(&mut guard, SESSION_CACHE_LIMIT, |entry| entry.timestamp_ms);
            if let Ok(mut rewind_guard) = rewind_block_cache().lock() {
                rewind_guard.remove(&cache_key);
            }
            if let Ok(mut latest_guard) = latest_signature_cache().lock() {
                let should_replace = latest_guard
                    .get(&normalized_alias)
                    .map(|entry| now >= entry.timestamp_ms)
                    .unwrap_or(true);
                if should_replace {
                    latest_guard.insert(
                        normalized_alias.clone(),
                        LatestSignatureEntry {
                            session_id: session_id.trim().to_string(),
                            timestamp_ms: now,
                        },
                    );
                }
            }
            maybe_pin_antigravity_session_to_alias(&normalized_alias, session_id, now);
        }
    }
}

pub(crate) fn cache_antigravity_session_signature_for_bridge(
    alias_key: &str,
    session_id: &str,
    signature: &str,
    message_count: i64,
) {
    cache_antigravity_session_signature(alias_key, session_id, signature, message_count);
}

pub(crate) fn reset_antigravity_signature_caches_for_bridge() {
    if let Ok(mut guard) = request_session_meta_cache().lock() {
        guard.clear();
    }
    if let Ok(mut guard) = session_signature_cache().lock() {
        guard.clear();
    }
    if let Ok(mut guard) = latest_signature_cache().lock() {
        guard.clear();
    }
    if let Ok(mut guard) = rewind_block_cache().lock() {
        guard.clear();
    }
    if let Ok(mut guard) = pinned_alias_by_session_cache().lock() {
        guard.clear();
    }
    if let Ok(mut guard) = pinned_session_by_alias_cache().lock() {
        guard.clear();
    }
}

fn lookup_antigravity_session_signature(
    alias_key: &str,
    session_id: &str,
) -> Option<SessionSignatureEntry> {
    let normalized_alias = normalize_alias_key(Some(alias_key));
    let cache_key = build_signature_key(&normalized_alias, session_id);
    if cache_key.is_empty() {
        return None;
    }
    let found = session_signature_cache()
        .lock()
        .ok()
        .and_then(|guard| guard.get(&cache_key).cloned());
    if found.is_some() {
        return found;
    }
    if normalized_alias == "antigravity.unknown" {
        return None;
    }
    if is_rewind_blocked(&normalized_alias, session_id) {
        return None;
    }
    None
}

