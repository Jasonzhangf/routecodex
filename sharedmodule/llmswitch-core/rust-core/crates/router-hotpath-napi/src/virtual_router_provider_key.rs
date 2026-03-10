use napi::bindgen_prelude::Result as NapiResult;
use napi_derive::napi;
use serde::Deserialize;
use serde::Serialize;
use std::collections::{BTreeMap, BTreeSet, HashSet};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProviderKeyParseOutput {
    provider_id: Option<String>,
    alias: Option<String>,
    key_index: Option<i64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AliasSelectionConfigInput {
    enabled: Option<bool>,
    default_strategy: Option<String>,
    providers: Option<BTreeMap<String, String>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AliasQueuePinInput {
    queue: Vec<String>,
    desired_order: Vec<String>,
    excluded_aliases: Vec<String>,
    alias_buckets: BTreeMap<String, Vec<String>>,
    candidate_order: Vec<String>,
    availability_by_alias: BTreeMap<String, bool>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AliasQueuePinOutput {
    queue: Vec<String>,
    selected_candidates: Vec<String>,
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

fn normalize_alias_strategy(value: Option<&str>) -> Option<String> {
    let raw = value.unwrap_or("").trim().to_ascii_lowercase();
    if raw == "none" || raw == "sticky-queue" {
        return Some(raw);
    }
    None
}

fn resolve_alias_selection_strategy(
    provider_id: String,
    cfg: Option<AliasSelectionConfigInput>,
) -> String {
    let normalized_provider_id = provider_id.trim().to_ascii_lowercase();
    if normalized_provider_id.is_empty() {
        return "none".to_string();
    }
    let Some(config) = cfg else {
        return if normalized_provider_id == "antigravity" {
            "sticky-queue".to_string()
        } else {
            "none".to_string()
        };
    };
    if config.enabled == Some(false) {
        return "none".to_string();
    }
    if let Some(overrides) = config.providers.as_ref() {
        let override_value = overrides
            .get(&normalized_provider_id)
            .and_then(|v| normalize_alias_strategy(Some(v.as_str())));
        if let Some(v) = override_value {
            return v;
        }
    }
    if let Some(v) = normalize_alias_strategy(config.default_strategy.as_deref()) {
        return v;
    }
    if normalized_provider_id == "antigravity" {
        return "sticky-queue".to_string();
    }
    "none".to_string()
}

fn merge_alias_queue(existing: Vec<String>, desired: Vec<String>) -> Vec<String> {
    if existing.is_empty() {
        return desired;
    }
    let desired_set: HashSet<String> = desired.iter().cloned().collect();
    let mut merged: Vec<String> = existing
        .iter()
        .filter(|value| desired_set.contains(*value))
        .cloned()
        .collect();
    let mut seen: HashSet<String> = merged.iter().cloned().collect();
    for alias in desired {
        if !seen.contains(&alias) {
            seen.insert(alias.clone());
            merged.push(alias);
        }
    }
    merged
}

fn rotate_queue_to_tail(queue: Vec<String>, aliases: &[String]) -> Vec<String> {
    if queue.len() < 2 || aliases.is_empty() {
        return queue;
    }
    let move_set: BTreeSet<String> = aliases.iter().cloned().collect();
    let mut kept: Vec<String> = Vec::new();
    let mut moved: Vec<String> = Vec::new();
    for alias in queue {
        if move_set.contains(&alias) {
            if !moved.contains(&alias) {
                moved.push(alias);
            }
        } else {
            kept.push(alias);
        }
    }
    kept.extend(moved);
    kept
}

fn pin_alias_queue(payload: AliasQueuePinInput) -> AliasQueuePinOutput {
    let mut queue = merge_alias_queue(payload.queue, payload.desired_order);
    if !payload.excluded_aliases.is_empty() {
        queue = rotate_queue_to_tail(queue, &payload.excluded_aliases);
    }

    if !queue.is_empty() {
        let limit = queue.len();
        for _ in 0..limit {
            let Some(head) = queue.first().cloned() else {
                break;
            };
            let has_available = payload
                .availability_by_alias
                .get(&head)
                .copied()
                .unwrap_or(false);
            if has_available {
                break;
            }
            queue = rotate_queue_to_tail(queue, &[head]);
        }
    }

    let selected_alias = queue.first().cloned();
    let selected_keys = selected_alias
        .as_ref()
        .and_then(|alias| payload.alias_buckets.get(alias))
        .cloned()
        .unwrap_or_default();
    let selected_set: HashSet<String> = selected_keys.into_iter().collect();
    let selected_candidates: Vec<String> = payload
        .candidate_order
        .iter()
        .filter(|key| selected_set.contains(*key))
        .cloned()
        .collect();

    AliasQueuePinOutput {
        queue,
        selected_candidates,
    }
}

#[napi]
pub fn parse_provider_key_json(provider_key: String) -> NapiResult<String> {
    let output = parse_provider_key(provider_key);
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi]
pub fn resolve_alias_selection_strategy_json(
    provider_id: String,
    cfg_json: String,
) -> NapiResult<String> {
    let cfg = serde_json::from_str::<Option<AliasSelectionConfigInput>>(&cfg_json)
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let output = resolve_alias_selection_strategy(provider_id, cfg);
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi]
pub fn pin_alias_queue_json(payload_json: String) -> NapiResult<String> {
    let payload = serde_json::from_str::<AliasQueuePinInput>(&payload_json)
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let output = pin_alias_queue(payload);
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}
