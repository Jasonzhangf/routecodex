//! Responses reasoning registry - Rust reimplementation of responses-reasoning-registry.ts
//! 
//! Thread-safe in-memory registry with TTL and LRU eviction.
//! Follows the same semantics as the TS version.

use napi::bindgen_prelude::Result as NapiResult;
use napi_derive::napi;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

const DEFAULT_TTL_MS: u64 = 10 * 60 * 1000; // 10 minutes
const DEFAULT_MAX_ENTRIES: usize = 2048;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ResponsesReasoningPayload {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub summary: Option<Vec<ReasoningSegment>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content: Option<Vec<ReasoningSegment>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub encrypted_content: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ReasoningSegment {
    #[serde(rename = "type")]
    pub seg_type: String,
    pub text: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ResponsesOutputTextMeta {
    #[serde(default)]
    pub has_field: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub value: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub raw: Option<String>,
}

#[derive(Clone, Debug)]
struct RegistryEntry {
    last_touched_at: Instant,
    reasoning: Option<ResponsesReasoningPayload>,
    output_text: Option<ResponsesOutputTextMeta>,
    payload_snapshot: Option<Value>,
    passthrough_payload: Option<Value>,
}

struct Registry {
    entries: HashMap<String, RegistryEntry>,
}

impl Registry {
    fn new() -> Self {
        Self {
            entries: HashMap::new(),
        }
    }

    fn ttl_ms(&self) -> u64 {
        // Allow env override via napi props in the future; hardcode defaults for now.
        DEFAULT_TTL_MS
    }

    fn max_entries(&self) -> usize {
        DEFAULT_MAX_ENTRIES
    }

    fn now_ms(&self) -> u64 {
        self.now().elapsed().as_millis() as u64
    }

    fn now(&self) -> Instant {
        Instant::now()
    }

    fn prune(&mut self, now: Instant) {
        let ttl = Duration::from_millis(self.ttl_ms());
        // Collect stale keys first to avoid borrow conflict
        let stale_keys: Vec<String> = self
            .entries
            .iter()
            .filter(|(_, entry)| now.duration_since(entry.last_touched_at) >= ttl)
            .map(|(k, _)| k.clone())
            .collect();
        for key in stale_keys {
            self.entries.remove(&key);
        }

        let max = self.max_entries();
        if self.entries.len() <= max {
            return;
        }

        // Collect keys to evict first, then remove (avoids borrow conflict)
        let mut sorted: Vec<_> = self.entries.iter().collect();
        sorted.sort_by_key(|(_, entry)| entry.last_touched_at);
        let excess = self.entries.len() - max;
        let keys_to_remove: Vec<String> = sorted
            .into_iter()
            .take(excess)
            .map(|(k, _)| k.clone())
            .collect();
        for key in keys_to_remove {
            self.entries.remove(&key);
        }
    }

    fn ensure_entry(&mut self, id: &str, now: Instant) -> &mut RegistryEntry {
        self.prune(now);
        if !self.entries.contains_key(id) {
            self.entries.insert(
                id.to_string(),
                RegistryEntry {
                    last_touched_at: now,
                    reasoning: None,
                    output_text: None,
                    payload_snapshot: None,
                    passthrough_payload: None,
                },
            );
        } else {
            self.entries.get_mut(id).unwrap().last_touched_at = now;
        }
        self.entries.get_mut(id).unwrap()
    }

    fn entry_mut(&mut self, id: &str) -> Option<&mut RegistryEntry> {
        self.entries.get_mut(id)
    }
}

static REGISTRY: OnceLock<Mutex<Registry>> = OnceLock::new();

fn registry() -> &'static Mutex<Registry> {
    REGISTRY.get_or_init(|| Mutex::new(Registry::new()))
}

fn normalize_aliases(ids: &[Value]) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    let mut result = Vec::new();
    for id in ids {
        if let Some(s) = id.as_str() {
            let trimmed = s.trim();
            if !trimmed.is_empty() && seen.insert(trimmed.to_string()) {
                result.push(trimmed.to_string());
            }
        }
    }
    result
}

fn collapse_reasoning_segments(segments: &[String]) -> Vec<String> {
    let mut merged = Vec::new();
    for entry in segments {
        let trimmed = entry.trim();
        if trimmed.is_empty() {
            continue;
        }
        if merged.is_empty() {
            merged.push(trimmed.to_string());
            continue;
        }
        let last = merged.last().unwrap();
        if trimmed == last {
            continue;
        }
        if trimmed.starts_with(last) {
            *merged.last_mut().unwrap() = trimmed.to_string();
            continue;
        }
        if last.starts_with(trimmed) {
            continue;
        }
        merged.push(trimmed.to_string());
    }
    merged
}

fn clone_value(v: &Value) -> Value {
    // Use serde_json to deep clone
    let s = serde_json::to_string(v).unwrap_or_default();
    serde_json::from_str(&s).unwrap_or_else(|_| v.clone())
}

// ============================================================
// NAPI exported functions
// ============================================================

#[napi]
pub fn register_responses_reasoning_json(
    id: String,
    reasoning_json: Option<String>,
) -> NapiResult<()> {
    let reasoning: Option<ResponsesReasoningPayload> = reasoning_json
        .as_ref()
        .and_then(|s| serde_json::from_str(s).ok());
    let mut reg = registry().lock().map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let now = Instant::now();
    let _entry = reg.ensure_entry(&id, now);
    if let Some(ref mut entry) = reg.entry_mut(&id) {
        if let Some(ref reasoning) = reasoning {
            let summary_raw: Vec<String> = reasoning
                .summary
                .as_ref()
                .map(|s| s.iter().map(|i| i.text.trim().to_string()).filter(|t| !t.is_empty()).collect())
                .unwrap_or_default();
            let summary_collapsed: Option<Vec<ReasoningSegment>> = if !summary_raw.is_empty() {
                Some(
                    collapse_reasoning_segments(&summary_raw)
                        .into_iter()
                        .map(|t| ReasoningSegment {
                            seg_type: "summary_text".to_string(),
                            text: t,
                        })
                        .collect(),
                )
            } else {
                None
            };

            let content_raw: Vec<String> = reasoning
                .content
                .as_ref()
                .map(|s| s.iter().map(|i| i.text.trim().to_string()).filter(|t| !t.is_empty()).collect())
                .unwrap_or_default();
            let content_collapsed: Option<Vec<ReasoningSegment>> = if !content_raw.is_empty() {
                Some(
                    collapse_reasoning_segments(&content_raw)
                        .into_iter()
                        .map(|t| ReasoningSegment {
                            seg_type: "reasoning_text".to_string(),
                            text: t,
                        })
                        .collect(),
                )
            } else {
                None
            };

            let has_summary = summary_collapsed.as_ref().map_or(false, |s| !s.is_empty());
            let has_content = content_collapsed.as_ref().map_or(false, |s| !s.is_empty());
            let has_encrypted = reasoning.encrypted_content.is_some();

            if has_summary || has_content || has_encrypted {
                entry.reasoning = Some(ResponsesReasoningPayload {
                    summary: summary_collapsed,
                    content: content_collapsed,
                    encrypted_content: reasoning.encrypted_content.clone(),
                });
            }
        }
    }
    Ok(())
}

#[napi]
pub fn consume_responses_reasoning_json(id: String) -> NapiResult<Option<String>> {
    let mut reg = registry().lock().map_err(|e| napi::Error::from_reason(e.to_string()))?;
    reg.prune(Instant::now());
    let entry = reg.entry_mut(&id);
    let reasoning = match entry {
        Some(e) if e.reasoning.is_some() => {
            let v = e.reasoning.clone();
            e.reasoning = None;
            v
        }
        _ => None,
    };

    // prune entry if empty
    if let Some(e) = reg.entry_mut(&id) {
        if e.reasoning.is_none()
            && e.output_text.is_none()
            && e.payload_snapshot.is_none()
            && e.passthrough_payload.is_none()
        {
            reg.entries.remove(&id);
        }
    }

    match reasoning {
        Some(r) => {
            let json = serde_json::to_string(&r).map_err(|e| napi::Error::from_reason(e.to_string()))?;
            Ok(Some(json))
        }
        None => Ok(None),
    }
}

#[napi]
pub fn register_responses_output_text_meta_json(
    id: String,
    meta_json: String,
) -> NapiResult<()> {
    let meta: ResponsesOutputTextMeta =
        serde_json::from_str(&meta_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let mut reg = registry().lock().map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let now = Instant::now();
    let _entry = reg.ensure_entry(&id, now);
    if let Some(ref mut entry) = reg.entry_mut(&id) {
        entry.output_text = Some(meta);
    }
    Ok(())
}

#[napi]
pub fn consume_responses_output_text_meta_json(id: String) -> NapiResult<Option<String>> {
    let mut reg = registry().lock().map_err(|e| napi::Error::from_reason(e.to_string()))?;
    reg.prune(Instant::now());
    let value = match reg.entry_mut(&id) {
        Some(e) if e.output_text.is_some() => {
            let v = e.output_text.clone();
            e.output_text = None;
            v
        }
        _ => None,
    };
    if let Some(e) = reg.entry_mut(&id) {
        if e.reasoning.is_none()
            && e.output_text.is_none()
            && e.payload_snapshot.is_none()
            && e.passthrough_payload.is_none()
        {
            reg.entries.remove(&id);
        }
    }
    match value {
        Some(v) => {
            let json =
                serde_json::to_string(&v).map_err(|e| napi::Error::from_reason(e.to_string()))?;
            Ok(Some(json))
        }
        None => Ok(None),
    }
}

#[napi]
pub fn register_responses_payload_snapshot_json(
    id: String,
    snapshot_json: String,
    clone: Option<bool>,
) -> NapiResult<()> {
    let snapshot: Value =
        serde_json::from_str(&snapshot_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let mut reg = registry().lock().map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let now = Instant::now();
    let _entry = reg.ensure_entry(&id, now);
    if let Some(ref mut entry) = reg.entry_mut(&id) {
        entry.payload_snapshot = Some(if clone.unwrap_or(true) {
            clone_value(&snapshot)
        } else {
            snapshot
        });
    }
    Ok(())
}

#[napi]
pub fn consume_responses_payload_snapshot_json(id: String) -> NapiResult<Option<String>> {
    let mut reg = registry().lock().map_err(|e| napi::Error::from_reason(e.to_string()))?;
    reg.prune(Instant::now());
    let value = match reg.entry_mut(&id) {
        Some(e) if e.payload_snapshot.is_some() => {
            let v = e.payload_snapshot.clone();
            e.payload_snapshot = None;
            v
        }
        _ => None,
    };
    if let Some(e) = reg.entry_mut(&id) {
        if e.reasoning.is_none()
            && e.output_text.is_none()
            && e.payload_snapshot.is_none()
            && e.passthrough_payload.is_none()
        {
            reg.entries.remove(&id);
        }
    }
    match value {
        Some(v) => {
            let json =
                serde_json::to_string(&v).map_err(|e| napi::Error::from_reason(e.to_string()))?;
            Ok(Some(json))
        }
        None => Ok(None),
    }
}

#[napi]
pub fn consume_responses_payload_snapshot_by_aliases_json(
    ids_json: String,
) -> NapiResult<Option<String>> {
    let ids: Vec<Value> =
        serde_json::from_str(&ids_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let aliases = normalize_aliases(&ids);
    let mut reg = registry().lock().map_err(|e| napi::Error::from_reason(e.to_string()))?;
    reg.prune(Instant::now());

    let mut matched: Option<Value> = None;
    for alias in &aliases {
        if let Some(entry) = reg.entry_mut(alias) {
            if let Some(ref snap) = entry.payload_snapshot {
                if !snap.is_null() && !snap.as_object().is_none() {
                    matched = Some(clone_value(snap));
                    entry.payload_snapshot = None;
                    break;
                }
            }
        }
    }

    for alias in &aliases {
        if let Some(ref mut entry) = reg.entry_mut(alias) {
            entry.payload_snapshot = None;
        }
    }

    // Prune entries that are now empty
    let to_remove: Vec<String> = reg
        .entries
        .iter()
        .filter(|(_, e)| {
            e.reasoning.is_none()
                && e.output_text.is_none()
                && e.payload_snapshot.is_none()
                && e.passthrough_payload.is_none()
        })
        .map(|(k, _)| k.clone())
        .collect();
    for key in to_remove {
        reg.entries.remove(&key);
    }

    match matched {
        Some(v) => {
            let json =
                serde_json::to_string(&v).map_err(|e| napi::Error::from_reason(e.to_string()))?;
            Ok(Some(json))
        }
        None => Ok(None),
    }
}

#[napi]
pub fn register_responses_passthrough_json(
    id: String,
    payload_json: String,
    clone: Option<bool>,
) -> NapiResult<()> {
    let payload: Value =
        serde_json::from_str(&payload_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let mut reg = registry().lock().map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let now = Instant::now();
    let _entry = reg.ensure_entry(&id, now);
    if let Some(ref mut entry) = reg.entry_mut(&id) {
        entry.passthrough_payload = Some(if clone.unwrap_or(true) {
            clone_value(&payload)
        } else {
            payload
        });
    }
    Ok(())
}

#[napi]
pub fn consume_responses_passthrough_json(id: String) -> NapiResult<Option<String>> {
    let mut reg = registry().lock().map_err(|e| napi::Error::from_reason(e.to_string()))?;
    reg.prune(Instant::now());
    let value = match reg.entry_mut(&id) {
        Some(e) if e.passthrough_payload.is_some() => {
            let v = e.passthrough_payload.clone();
            e.passthrough_payload = None;
            v
        }
        _ => None,
    };
    if let Some(e) = reg.entry_mut(&id) {
        if e.reasoning.is_none()
            && e.output_text.is_none()
            && e.payload_snapshot.is_none()
            && e.passthrough_payload.is_none()
        {
            reg.entries.remove(&id);
        }
    }
    match value {
        Some(v) => {
            let json =
                serde_json::to_string(&v).map_err(|e| napi::Error::from_reason(e.to_string()))?;
            Ok(Some(json))
        }
        None => Ok(None),
    }
}

#[napi]
pub fn consume_responses_passthrough_by_aliases_json(
    ids_json: String,
) -> NapiResult<Option<String>> {
    let ids: Vec<Value> =
        serde_json::from_str(&ids_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let aliases = normalize_aliases(&ids);
    let mut reg = registry().lock().map_err(|e| napi::Error::from_reason(e.to_string()))?;
    reg.prune(Instant::now());

    let mut matched: Option<Value> = None;
    for alias in &aliases {
        if let Some(entry) = reg.entry_mut(alias) {
            if let Some(ref passthrough) = entry.passthrough_payload {
                if !passthrough.is_null() && !passthrough.as_object().is_none() {
                    matched = Some(clone_value(passthrough));
                    entry.passthrough_payload = None;
                    break;
                }
            }
        }
    }

    for alias in &aliases {
        if let Some(ref mut entry) = reg.entry_mut(alias) {
            entry.passthrough_payload = None;
        }
    }

    let to_remove: Vec<String> = reg
        .entries
        .iter()
        .filter(|(_, e)| {
            e.reasoning.is_none()
                && e.output_text.is_none()
                && e.payload_snapshot.is_none()
                && e.passthrough_payload.is_none()
        })
        .map(|(k, _)| k.clone())
        .collect();
    for key in to_remove {
        reg.entries.remove(&key);
    }

    match matched {
        Some(v) => {
            let json =
                serde_json::to_string(&v).map_err(|e| napi::Error::from_reason(e.to_string()))?;
            Ok(Some(json))
        }
        None => Ok(None),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_register_and_consume_reasoning() {
        let reasoning = ResponsesReasoningPayload {
            summary: Some(vec![ReasoningSegment {
                seg_type: "summary_text".to_string(),
                text: "test".to_string(),
            }]),
            content: Some(vec![ReasoningSegment {
                seg_type: "reasoning_text".to_string(),
                text: "test2".to_string(),
            }]),
            encrypted_content: Some("sig".to_string()),
        };
        let json = serde_json::to_string(&reasoning).unwrap();
        register_responses_reasoning_json("id1".to_string(), Some(json)).unwrap();
        let result = consume_responses_reasoning_json("id1".to_string()).unwrap();
        assert!(result.is_some());
    }

    #[test]
    fn test_register_and_consume_by_aliases() {
        let snapshot = serde_json::json!({"key": "value"});
        register_responses_payload_snapshot_json(
            "alias1".to_string(),
            serde_json::to_string(&snapshot).unwrap(),
            Some(false),
        )
        .unwrap();
        let ids = serde_json::to_string(&["alias1", "alias2"]).unwrap();
        let result = consume_responses_payload_snapshot_by_aliases_json(ids).unwrap();
        assert!(result.is_some());
    }
}
