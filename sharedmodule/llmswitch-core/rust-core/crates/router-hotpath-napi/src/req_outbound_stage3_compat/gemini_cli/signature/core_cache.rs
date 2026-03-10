fn should_treat_as_missing_thought_signature(value: Option<&Value>) -> bool {
    let Some(raw) = value.and_then(|v| v.as_str()) else {
        return true;
    };
    let trimmed = raw.trim();
    trimmed.is_empty() || trimmed == DUMMY_THOUGHT_SIGNATURE_SENTINEL
}

fn normalize_alias_key(value: Option<&str>) -> String {
    let normalized = value
        .map(|v| v.trim().to_ascii_lowercase())
        .unwrap_or_default();
    if normalized.is_empty() || normalized == "antigravity" {
        return "antigravity.unknown".to_string();
    }
    normalized
}

fn normalize_session_id(value: &str) -> String {
    value.trim().to_string()
}

fn is_pinned_expired(_timestamp_ms: u64, _ts: u64) -> bool {
    false
}

fn build_signature_key(alias_key: &str, session_id: &str) -> String {
    let sid = session_id.trim();
    if sid.is_empty() {
        return String::new();
    }
    format!("{}|{}", normalize_alias_key(Some(alias_key)), sid)
}

fn should_allow_alias_latest_fallback(alias_key: &str) -> bool {
    normalize_alias_key(Some(alias_key)) != "antigravity.unknown"
}

fn trim_oldest_entries<T>(
    cache: &mut HashMap<String, T>,
    limit: usize,
    mut timestamp_of: impl FnMut(&T) -> u64,
) {
    if cache.len() <= limit {
        return;
    }
    while cache.len() > limit {
        let oldest_key = cache
            .iter()
            .min_by_key(|(_, entry)| timestamp_of(entry))
            .map(|(key, _)| key.clone());
        let Some(key) = oldest_key else {
            break;
        };
        cache.remove(&key);
    }
}

fn clear_antigravity_session_signature(alias_key: &str, session_id: &str) {
    let cache_key = build_signature_key(alias_key, session_id);
    if cache_key.is_empty() {
        return;
    }
    if let Ok(mut guard) = session_signature_cache().lock() {
        guard.remove(&cache_key);
    }
    let normalized_alias = normalize_alias_key(Some(alias_key));
    let normalized_sid = session_id.trim();
    if normalized_sid.is_empty() {
        return;
    }
    if let Ok(mut latest_guard) = latest_signature_cache().lock() {
        let should_clear = latest_guard
            .get(&normalized_alias)
            .map(|entry| entry.session_id.trim() == normalized_sid)
            .unwrap_or(false);
        if should_clear {
            latest_guard.remove(&normalized_alias);
        }
    }
    let _ = unpin_antigravity_session_alias_for_session_id(normalized_sid);
}

fn mark_antigravity_session_signature_rewind(
    alias_key: &str,
    session_id: &str,
    _message_count: i64,
) {
    let cache_key = build_signature_key(alias_key, session_id);
    if cache_key.is_empty() {
        return;
    }
    let ts = now_ms();
    let until_ms = ts.saturating_add(REWIND_BLOCK_MS);
    if let Ok(mut guard) = rewind_block_cache().lock() {
        guard.insert(
            cache_key,
            RewindBlockEntry {
                until_ms,
                timestamp_ms: ts,
            },
        );
        trim_oldest_entries(&mut guard, SESSION_CACHE_LIMIT, |entry| entry.timestamp_ms);
    }
}

fn is_rewind_blocked(alias_key: &str, session_id: &str) -> bool {
    let cache_key = build_signature_key(alias_key, session_id);
    if cache_key.is_empty() {
        return false;
    }
    let now = now_ms();
    if let Ok(mut guard) = rewind_block_cache().lock() {
        if let Some(entry) = guard.get(&cache_key) {
            if now < entry.until_ms {
                return true;
            }
        }
        guard.remove(&cache_key);
    }
    false
}

fn get_latest_signature_session_id_for_alias(alias_key: &str) -> Option<String> {
    let normalized_alias = normalize_alias_key(Some(alias_key));
    if !should_allow_alias_latest_fallback(&normalized_alias) {
        return None;
    }
    latest_signature_cache()
        .lock()
        .ok()
        .and_then(|guard| guard.get(&normalized_alias).cloned())
        .and_then(|entry| {
            let sid = entry.session_id.trim();
            if sid.is_empty() {
                None
            } else {
                Some(sid.to_string())
            }
        })
}

fn maybe_pin_antigravity_session_to_alias(alias_key_input: &str, session_id_input: &str, ts: u64) {
    let alias_key = normalize_alias_key(Some(alias_key_input));
    let session_id = normalize_session_id(session_id_input);
    if session_id.is_empty()
        || alias_key == "antigravity.unknown"
        || alias_key == ANTIGRAVITY_GLOBAL_ALIAS_KEY
    {
        return;
    }

    let Ok(mut by_session) = pinned_alias_by_session_cache().lock() else {
        return;
    };
    let Ok(mut by_alias) = pinned_session_by_alias_cache().lock() else {
        return;
    };

    if let Some(existing) = by_session.get(&session_id).cloned() {
        if !is_pinned_expired(existing.timestamp_ms, ts) {
            if existing.alias_key == alias_key
                && ts.saturating_sub(existing.timestamp_ms) >= SIGNATURE_TOUCH_INTERVAL_MS
            {
                by_session.insert(
                    session_id.clone(),
                    PinnedAliasEntry {
                        alias_key: alias_key.clone(),
                        timestamp_ms: ts,
                    },
                );
                by_alias.insert(
                    alias_key,
                    PinnedSessionEntry {
                        session_id,
                        timestamp_ms: ts,
                    },
                );
            }
            return;
        }
    }

    if let Some(existing) = by_alias.get(&alias_key).cloned() {
        if !is_pinned_expired(existing.timestamp_ms, ts) && existing.session_id != session_id {
            return;
        }
    }

    by_session.insert(
        session_id.clone(),
        PinnedAliasEntry {
            alias_key: alias_key.clone(),
            timestamp_ms: ts,
        },
    );
    by_alias.insert(
        alias_key,
        PinnedSessionEntry {
            session_id,
            timestamp_ms: ts,
        },
    );
    trim_oldest_entries(&mut by_session, SESSION_CACHE_LIMIT, |entry| entry.timestamp_ms);
    trim_oldest_entries(&mut by_alias, SESSION_CACHE_LIMIT, |entry| entry.timestamp_ms);
}

pub(crate) fn lookup_antigravity_pinned_alias_for_session_id(
    session_id_input: &str,
    hydrate: bool,
) -> Option<String> {
    let session_id = normalize_session_id(session_id_input);
    if session_id.is_empty() {
        return None;
    }
    let ts = now_ms();

    let mut resolved: Option<PinnedAliasEntry> = None;
    if let Ok(guard) = pinned_alias_by_session_cache().lock() {
        resolved = guard.get(&session_id).cloned();
    }
    if resolved.is_none() && hydrate {
        if let Some(alias_key) = hydrate_pinned_alias_from_disk(&session_id) {
            return Some(alias_key);
        }
    }
    let entry = resolved?;

    if is_pinned_expired(entry.timestamp_ms, ts) {
        let _ = unpin_antigravity_session_alias_for_session_id(&session_id);
        return None;
    }

    let alias_key = entry.alias_key.trim().to_string();
    if alias_key.is_empty() {
        return None;
    }

    if ts.saturating_sub(entry.timestamp_ms) >= SIGNATURE_TOUCH_INTERVAL_MS {
        if let Ok(mut by_session) = pinned_alias_by_session_cache().lock() {
            by_session.insert(
                session_id.clone(),
                PinnedAliasEntry {
                    alias_key: alias_key.clone(),
                    timestamp_ms: ts,
                },
            );
        }
        if let Ok(mut by_alias) = pinned_session_by_alias_cache().lock() {
            by_alias.insert(
                alias_key.clone(),
                PinnedSessionEntry {
                    session_id,
                    timestamp_ms: ts,
                },
            );
        }
    }

    Some(alias_key)
}

fn hydrate_pinned_alias_from_disk(session_id: &str) -> Option<String> {
    let path = resolve_persistence_path()?;
    let payload = fs::read_to_string(path).ok()?;
    let parsed: Value = serde_json::from_str(&payload).ok()?;
    let pinned_by_session = parsed.get("pinnedBySession")?.as_object()?;
    let entry = pinned_by_session.get(session_id)?.as_object()?;
    let alias_key = entry.get("aliasKey")?.as_str()?.trim();
    if alias_key.is_empty() {
        return None;
    }
    let ts = now_ms();
    maybe_pin_antigravity_session_to_alias(alias_key, session_id, ts);
    Some(alias_key.to_string())
}

fn resolve_persistence_path() -> Option<PathBuf> {
    let dir = env::var("ROUTECODEX_ANTIGRAVITY_SIGNATURE_STATE_DIR").ok()?;
    let dir_trimmed = dir.trim();
    if dir_trimmed.is_empty() {
        return None;
    }
    let file = env::var("ROUTECODEX_ANTIGRAVITY_SIGNATURE_FILE")
        .ok()
        .filter(|v| !v.trim().is_empty())
        .unwrap_or_else(|| "antigravity-session-signatures.json".to_string());
    Some(PathBuf::from(dir_trimmed).join(file.trim()))
}

pub(crate) fn unpin_antigravity_session_alias_for_session_id(session_id_input: &str) -> bool {
    let session_id = normalize_session_id(session_id_input);
    if session_id.is_empty() {
        return false;
    }

    let Ok(mut by_session) = pinned_alias_by_session_cache().lock() else {
        return false;
    };
    let Ok(mut by_alias) = pinned_session_by_alias_cache().lock() else {
        return false;
    };

    let mut changed = false;
    if let Some(existing) = by_session.remove(&session_id) {
        changed = true;
        let alias_key = existing.alias_key.trim().to_string();
        if !alias_key.is_empty() {
            let should_remove = by_alias
                .get(&alias_key)
                .map(|backref| backref.session_id.trim() == session_id)
                .unwrap_or(false);
            if should_remove {
                by_alias.remove(&alias_key);
            }
        }
    }

    let alias_keys: Vec<String> = by_alias
        .iter()
        .filter(|(_, entry)| entry.session_id.trim() == session_id)
        .map(|(key, _)| key.clone())
        .collect();
    if !alias_keys.is_empty() {
        changed = true;
    }
    for alias_key in alias_keys {
        by_alias.remove(&alias_key);
    }

    changed
}
