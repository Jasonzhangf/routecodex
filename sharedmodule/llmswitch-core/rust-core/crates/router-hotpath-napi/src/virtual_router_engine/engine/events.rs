use chrono::{Datelike, Local, TimeZone};
use serde_json::Value;

use super::VirtualRouterEngineCore;
use crate::virtual_router_engine::time_utils::now_ms;

#[derive(Debug)]
struct SeriesCooldownDetail {
    provider_key: Option<String>,
    series: String,
    cooldown_ms: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ProviderErrorClassification {
    Unrecoverable,
    Recoverable,
    Special400,
}

impl VirtualRouterEngineCore {
    fn has_alternative_available_provider(&mut self, current_provider_key: &str) -> bool {
        let now = now_ms();
        self.provider_registry
            .list_keys()
            .into_iter()
            .filter(|candidate| candidate != current_provider_key)
            .filter(|candidate| {
                self.provider_registry
                    .get(candidate)
                    .map(|profile| profile.enabled)
                    .unwrap_or(false)
            })
            .any(|candidate| self.health_manager.is_available(&candidate, now))
    }

    fn event_has_route_alternative_provider(
        &mut self,
        event: &Value,
        current_provider_key: &str,
    ) -> bool {
        if let Some(route_pool_size) = extract_route_pool_size(event) {
            return route_pool_size > 1;
        }
        self.has_alternative_available_provider(current_provider_key)
    }

    pub(crate) fn handle_provider_success(&mut self, event: &Value) {
        self.refresh_provider_health_from_store(false);
        let provider_key = event
            .get("runtime")
            .and_then(|v| v.get("providerKey"))
            .and_then(|v| v.as_str())
            .unwrap_or("");
        if provider_key.is_empty() {
            return;
        }
        self.health_manager.record_success(provider_key);
        if let Some(runtime_key) = event
            .get("runtime")
            .and_then(|v| v.get("runtimeKey"))
            .and_then(|v| v.as_str())
            .filter(|value| !value.trim().is_empty() && *value != provider_key)
        {
            self.health_manager.record_success(runtime_key);
        }
        if let Some(alias_key) = provider_key.rsplit_once('.').map(|(base, _)| base) {
            if alias_key != provider_key {
                self.health_manager.record_success(alias_key);
            }
        }
        self.quota_manager.record_success(provider_key);
        self.persist_provider_health();
    }

    pub(crate) fn handle_provider_failure(&mut self, event: &Value) {
        self.refresh_provider_health_from_store(false);
        if !event_affects_health(event) {
            return;
        }
        let provider_key = resolve_provider_key(event).unwrap_or_default();
        if provider_key.is_empty() {
            return;
        }
        let reason = extract_error_reason(event);
        let now = now_ms();
        let status_code = extract_status_code(event);
        // Single policy gate:
        // - HTTP 503 triggers a persisted daily cooldown immediately (not the
        //   recoverable-failure ladder). This matches extract_recoverable_cooldown_ms.
        // - all other failures: consecutive threshold handling in health.rs
        if matches!(status_code, Some(503)) {
            let cooldown_ms = extract_cooldown_override_ms(event)
                .unwrap_or(compute_cooldown_until_next_local_midnight_ms(now));
            self.health_manager.trip_provider(
                &provider_key,
                Some("__http_503_daily_cooldown__".to_string()),
                Some(cooldown_ms),
                now,
            );
            self.persist_provider_health();
            return;
        }
        self.health_manager
            .record_failure(&provider_key, reason, now);
        self.persist_provider_health();
    }

    pub(crate) fn handle_provider_error(&mut self, event: &Value) {
        self.refresh_provider_health_from_store(false);
        if !event_affects_health(event) {
            return;
        }
        if self.apply_http_402_resetat_event(event) {
            self.persist_provider_health();
            return;
        }
        if self.apply_quota_depleted_event(event) {
            self.persist_provider_health();
            return;
        }
        if let Some(provider_key) = resolve_provider_key(event) {
            if should_record_quota_error_signal(event) {
                let event_now_ms = event
                    .get("timestamp")
                    .and_then(|v| v.as_i64().or_else(|| v.as_u64().map(|n| n as i64)))
                    .filter(|value| *value > 0)
                    .unwrap_or_else(now_ms);
                self.quota_manager
                    .record_error_signal(&provider_key, event_now_ms);
            }
        }
        let classification = extract_provider_error_classification(event);
        if matches!(
            classification,
            Some(ProviderErrorClassification::Special400)
        ) {
            return;
        }
        if let Some(classification) = classification {
            if self.apply_classified_provider_error(event, classification) {
                return;
            }
        }
        self.handle_provider_failure(event);
        self.apply_series_cooldown(event);
        self.persist_provider_health();
    }

    fn apply_auth_family_blacklist(&mut self, event: &Value) -> bool {
        let Some(provider_key) = resolve_provider_key(event) else {
            return false;
        };
        let auth_family = self
            .provider_registry
            .get(&provider_key)
            .and_then(|p| p.auth_family.clone());
        let Some(auth_family) = auth_family else {
            return false;
        };
        if !is_auth_invalid_event(event) {
            return false;
        }
        let cooldown_ms = compute_cooldown_until_next_local_midnight_ms(now_ms())
            .max(DEFAULT_UNRECOVERABLE_MIN_COOLDOWN_MS);
        let now = now_ms();
        for key in self.provider_registry.list_by_auth_family(&auth_family) {
            self.health_manager.trip_provider(
                &key,
                Some("auth".to_string()),
                Some(cooldown_ms),
                now,
            );
        }
        true
    }

    fn apply_classified_provider_error(
        &mut self,
        event: &Value,
        classification: ProviderErrorClassification,
    ) -> bool {
        let provider_key = resolve_provider_key(event);
        let Some(provider_key) = provider_key.as_deref() else {
            return false;
        };
        let reason = extract_error_reason(event);
        let now = now_ms();
        match classification {
            ProviderErrorClassification::Special400 => true,
            ProviderErrorClassification::Recoverable => {
                let status = extract_status_code(event);
                if status == Some(429) {
                    self.health_manager
                        .record_http_429_failure(provider_key, reason, now);
                    self.apply_series_cooldown(event);
                    self.persist_provider_health();
                    return true;
                }
                if status == Some(503) {
                    let cooldown_ms = extract_cooldown_override_ms(event)
                        .unwrap_or(compute_cooldown_until_next_local_midnight_ms(now));
                    self.health_manager.trip_provider(
                        provider_key,
                        Some("__http_503_daily_cooldown__".to_string()),
                        Some(cooldown_ms),
                        now,
                    );
                    self.persist_provider_health();
                    return true;
                }
                self.health_manager
                    .record_recoverable_failure(provider_key, reason, now);
                self.apply_series_cooldown(event);
                self.persist_provider_health();
                true
            }
            ProviderErrorClassification::Unrecoverable => {
                let default_unrecoverable_ttl = compute_cooldown_until_next_local_midnight_ms(now);
                let cooldown_ms =
                    extract_cooldown_override_ms(event).unwrap_or(default_unrecoverable_ttl);
                self.health_manager
                    .trip_provider(provider_key, reason, Some(cooldown_ms), now);
                let _ = self.apply_auth_family_blacklist(event);
                self.persist_provider_health();
                true
            }
        }
    }

    fn apply_series_cooldown(&mut self, event: &Value) {
        let Some(detail) = extract_series_cooldown_detail(event) else {
            return;
        };
        let mut candidates: Vec<String> = Vec::new();
        if let Some(key) = detail.provider_key.as_ref() {
            candidates.push(key.clone());
        }
        if let Some(runtime_key) = event
            .get("runtime")
            .and_then(|v| v.get("target"))
            .and_then(|v| v.get("providerKey"))
            .and_then(|v| v.as_str())
        {
            candidates.push(runtime_key.to_string());
        }
        if let Some(runtime_key) = event
            .get("runtime")
            .and_then(|v| v.get("providerKey"))
            .and_then(|v| v.as_str())
        {
            candidates.push(runtime_key.to_string());
        }
        let mut seen = std::collections::HashSet::new();
        for key in candidates {
            let key = key.trim().to_string();
            if key.is_empty() || !seen.insert(key.clone()) {
                continue;
            }
            let Some(profile) = self.provider_registry.get(&key) else {
                continue;
            };
            let series = profile.series.as_deref().unwrap_or("");
            if series != detail.series {
                continue;
            }
            self.health_manager.trip_provider(
                &key,
                Some("rate_limit".to_string()),
                Some(detail.cooldown_ms),
                now_ms(),
            );
        }
    }

    fn apply_http_402_resetat_event(&mut self, event: &Value) -> bool {
        let status = extract_status_code(event);
        let code = event
            .get("code")
            .and_then(|v| v.as_str())
            .map(|v| v.trim())
            .unwrap_or("");
        if status != Some(402) && code != "HTTP_402" {
            return false;
        }
        let Some(provider_key) = resolve_provider_key(event) else {
            return false;
        };
        let Some(cooldown_until) = extract_reset_at_ms(event) else {
            return false;
        };
        let now = now_ms();
        self.quota_manager.apply_http_402_resetat_cooldown(
            &provider_key,
            now,
            cooldown_until,
            if code.is_empty() { "HTTP_402" } else { code },
        );
        true
    }

    fn apply_quota_depleted_event(&mut self, event: &Value) -> bool {
        let code = event
            .get("code")
            .and_then(|v| v.as_str())
            .map(|v| v.trim())
            .unwrap_or("");
        if code != "QUOTA_DEPLETED" {
            return false;
        }
        let Some(provider_key) = resolve_provider_key(event) else {
            return false;
        };
        let now = now_ms();
        let reset_at = extract_reset_at_ms(event);
        let cooldown_until =
            reset_at.or_else(|| extract_cooldown_override_ms(event).map(|ttl| now + ttl.max(1)));
        self.quota_manager
            .freeze_quota_depleted(&provider_key, now, cooldown_until, reset_at);
        true
    }
}

const DEFAULT_UNRECOVERABLE_MIN_COOLDOWN_MS: i64 = 5 * 60_000;

fn event_affects_health(event: &Value) -> bool {
    !matches!(
        event.get("affectsHealth").and_then(|v| v.as_bool()),
        Some(false)
    )
}

fn resolve_provider_key(event: &Value) -> Option<String> {
    event
        .get("providerKey")
        .and_then(|v| v.as_str())
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
        .or_else(|| {
            event
                .get("target")
                .and_then(|v| v.get("providerKey"))
                .and_then(|v| v.as_str())
                .map(|v| v.trim().to_string())
                .filter(|v| !v.is_empty())
        })
        .or_else(|| {
            event
                .get("runtime")
                .and_then(|v| v.get("providerKey"))
                .and_then(|v| v.as_str())
                .map(|v| v.trim().to_string())
                .filter(|v| !v.is_empty())
        })
        .or_else(|| {
            event
                .get("runtime")
                .and_then(|v| v.get("target"))
                .and_then(|v| v.get("providerKey"))
                .and_then(|v| v.as_str())
                .map(|v| v.trim().to_string())
                .filter(|v| !v.is_empty())
        })
}

fn extract_route_pool_size(event: &Value) -> Option<i64> {
    event
        .get("details")
        .and_then(|v| v.get("routePoolSize"))
        .and_then(as_i64_like)
        .map(|value| value.max(0))
}

fn extract_status_code(event: &Value) -> Option<i64> {
    event
        .get("statusCode")
        .and_then(as_i64_like)
        .or_else(|| event.get("status").and_then(as_i64_like))
}

fn extract_cooldown_override_ms(event: &Value) -> Option<i64> {
    event
        .get("cooldownOverrideMs")
        .and_then(as_i64_like)
        .filter(|value| *value > 0)
        .or_else(|| {
            event
                .get("details")
                .and_then(|v| v.get("cooldownOverrideMs"))
                .and_then(as_i64_like)
                .filter(|value| *value > 0)
        })
}

fn extract_reset_at_ms(event: &Value) -> Option<i64> {
    event
        .get("resetAt")
        .and_then(as_timestamp_like)
        .or_else(|| {
            event
                .get("details")
                .and_then(|v| v.get("resetAt"))
                .and_then(as_timestamp_like)
        })
}

fn as_timestamp_like(value: &Value) -> Option<i64> {
    if let Some(num) = as_i64_like(value) {
        return Some(num);
    }
    let raw = value.as_str()?.trim();
    if raw.is_empty() {
        return None;
    }
    chrono::DateTime::parse_from_rfc3339(raw)
        .ok()
        .map(|dt| dt.timestamp_millis())
}

fn as_i64_like(value: &Value) -> Option<i64> {
    value
        .as_i64()
        .or_else(|| value.as_u64().map(|value| value as i64))
        .or_else(|| value.as_f64().map(|value| value.round() as i64))
}

fn extract_error_reason(event: &Value) -> Option<String> {
    event
        .get("message")
        .and_then(|v| v.as_str())
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
        .or_else(|| {
            event
                .get("error")
                .and_then(|v| v.get("message"))
                .and_then(|v| v.as_str())
                .map(|v| v.trim().to_string())
                .filter(|v| !v.is_empty())
        })
}

fn should_record_quota_error_signal(event: &Value) -> bool {
    if !event_affects_health(event) {
        return false;
    }
    let code = event
        .get("code")
        .and_then(|v| v.as_str())
        .map(|v| v.trim())
        .unwrap_or("");
    if code == "QUOTA_DEPLETED" {
        return false;
    }
    matches!(
        extract_provider_error_classification(event),
        Some(ProviderErrorClassification::Recoverable)
    )
}

fn extract_provider_error_classification(event: &Value) -> Option<ProviderErrorClassification> {
    let value = event
        .get("errorClassification")
        .and_then(|v| v.as_str())
        .map(|v| v.trim().to_lowercase())
        .or_else(|| {
            event
                .get("details")
                .and_then(|v| v.get("errorClassification"))
                .and_then(|v| v.as_str())
                .map(|v| v.trim().to_lowercase())
        })?;
    match value.as_str() {
        "unrecoverable" => Some(ProviderErrorClassification::Unrecoverable),
        "recoverable" => Some(ProviderErrorClassification::Recoverable),
        "special_400" => Some(ProviderErrorClassification::Special400),
        _ => None,
    }
}

fn extract_recoverable_cooldown_ms(event: &Value) -> Option<i64> {
    let status = extract_status_code(event);
    if matches!(status, Some(401 | 402 | 403 | 503)) {
        return Some(compute_cooldown_until_next_local_midnight_ms(now_ms()));
    }
    if status == Some(429) && is_daily_limit_exceeded(event) {
        return Some(compute_cooldown_until_next_local_midnight_ms(now_ms()));
    }
    if let Some(cooldown_ms) =
        extract_series_cooldown_detail(event).map(|detail| detail.cooldown_ms)
    {
        return Some(cooldown_ms);
    }
    None
}

fn is_daily_limit_exceeded(event: &Value) -> bool {
    let mut candidates: Vec<String> = Vec::new();
    collect_string_candidate(event.get("code"), &mut candidates);
    collect_string_candidate(
        event.get("error").and_then(|v| v.get("message")),
        &mut candidates,
    );
    if let Some(details) = event.get("details").and_then(|v| v.as_object()) {
        collect_string_candidate(details.get("reason"), &mut candidates);
        collect_string_candidate(details.get("message"), &mut candidates);
        collect_string_candidate(details.get("code"), &mut candidates);
        collect_string_candidate(details.get("upstreamCode"), &mut candidates);
        collect_string_candidate(details.get("upstreamMessage"), &mut candidates);
        if let Some(meta) = details.get("meta").and_then(|v| v.as_object()) {
            collect_string_candidate(meta.get("reason"), &mut candidates);
            collect_string_candidate(meta.get("message"), &mut candidates);
            collect_string_candidate(meta.get("code"), &mut candidates);
            collect_string_candidate(meta.get("upstreamCode"), &mut candidates);
            collect_string_candidate(meta.get("upstreamMessage"), &mut candidates);
        }
    }
    candidates.into_iter().any(|candidate| {
        let lowered = candidate.to_lowercase();
        lowered.contains("daily_limit_exceeded")
            || lowered.contains("daily usage limit exceeded")
            || lowered.contains("daily limit exceeded")
            || lowered.contains("daily usage quota exceeded")
    })
}

fn collect_string_candidate(value: Option<&Value>, output: &mut Vec<String>) {
    let Some(value) = value.and_then(|v| v.as_str()) else {
        return;
    };
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return;
    }
    output.push(trimmed.to_string());
}

fn compute_cooldown_until_next_local_midnight_ms(now_ms: i64) -> i64 {
    if now_ms <= 0 {
        return 24 * 60 * 60_000;
    }
    let Some(current) = Local.timestamp_millis_opt(now_ms).single() else {
        return 24 * 60 * 60_000;
    };
    let Some(next_midnight) = Local
        .with_ymd_and_hms(current.year(), current.month(), current.day(), 0, 0, 0)
        .single()
        .and_then(|dt| dt.checked_add_days(chrono::Days::new(1)))
    else {
        return 24 * 60 * 60_000;
    };
    let ttl = next_midnight.timestamp_millis() - now_ms;
    if ttl > 0 {
        ttl
    } else {
        24 * 60 * 60_000
    }
}

fn is_google_account_verification_required(event: &Value) -> bool {
    let mut sources: Vec<String> = Vec::new();
    if let Some(message) = event.get("message").and_then(|v| v.as_str()) {
        if !message.trim().is_empty() {
            sources.push(message.to_string());
        }
    }
    if let Some(details) = event.get("details").and_then(|v| v.as_object()) {
        if let Some(upstream) = details.get("upstreamMessage").and_then(|v| v.as_str()) {
            if !upstream.trim().is_empty() {
                sources.push(upstream.to_string());
            }
        }
        if let Some(meta) = details.get("meta").and_then(|v| v.as_object()) {
            if let Some(meta_upstream) = meta.get("upstreamMessage").and_then(|v| v.as_str()) {
                if !meta_upstream.trim().is_empty() {
                    sources.push(meta_upstream.to_string());
                }
            }
            if let Some(meta_message) = meta.get("message").and_then(|v| v.as_str()) {
                if !meta_message.trim().is_empty() {
                    sources.push(meta_message.to_string());
                }
            }
        }
    }
    if sources.is_empty() {
        return false;
    }
    let lowered = sources.join(" | ").to_lowercase();
    lowered.contains("verify your account")
        || lowered.contains("validation_required")
        || lowered.contains("validation required")
        || lowered.contains("validation_url")
        || lowered.contains("validation url")
        || lowered.contains("accounts.google.com/signin/continue")
        || lowered.contains("support.google.com/accounts?p=al_alert")
}

fn is_auth_invalid_event(event: &Value) -> bool {
    let mut sources: Vec<String> = Vec::new();
    collect_string_candidate(event.get("code"), &mut sources);
    collect_string_candidate(event.get("error").and_then(|v| v.get("code")), &mut sources);
    collect_string_candidate(
        event.get("error").and_then(|v| v.get("message")),
        &mut sources,
    );
    if let Some(details) = event.get("details").and_then(|v| v.as_object()) {
        collect_string_candidate(details.get("code"), &mut sources);
        collect_string_candidate(details.get("upstreamCode"), &mut sources);
        collect_string_candidate(details.get("reason"), &mut sources);
        collect_string_candidate(details.get("message"), &mut sources);
        collect_string_candidate(details.get("upstreamMessage"), &mut sources);
        if let Some(meta) = details.get("meta").and_then(|v| v.as_object()) {
            collect_string_candidate(meta.get("code"), &mut sources);
            collect_string_candidate(meta.get("upstreamCode"), &mut sources);
            collect_string_candidate(meta.get("reason"), &mut sources);
            collect_string_candidate(meta.get("message"), &mut sources);
            collect_string_candidate(meta.get("upstreamMessage"), &mut sources);
        }
    }
    let status = event.get("status").and_then(|v| {
        v.as_i64()
            .or_else(|| v.as_u64().map(|value| value as i64))
            .or_else(|| v.as_f64().map(|value| value.round() as i64))
    });
    if matches!(status, Some(401 | 402 | 403)) {
        return true;
    }
    sources.into_iter().any(|source| {
        let lowered = source.to_lowercase();
        lowered.contains("invalid_api_key")
            || lowered.contains("invalid api key")
            || lowered.contains("invalid access token")
            || lowered.contains("token expired")
            || lowered.contains("http_401")
            || lowered.contains("http_403")
    })
}

fn extract_series_cooldown_detail(event: &Value) -> Option<SeriesCooldownDetail> {
    let details = event.get("details")?.as_object()?;
    let raw = details.get("virtualRouterSeriesCooldown")?.as_object()?;
    let series = raw.get("series")?.as_str()?.trim().to_lowercase();
    let cooldown_ms = match raw.get("cooldownMs") {
        Some(v) if v.is_i64() => v.as_i64().unwrap_or(0),
        Some(v) if v.is_u64() => v.as_u64().unwrap_or(0) as i64,
        Some(v) if v.is_f64() => v.as_f64().unwrap_or(0.0).round() as i64,
        Some(v) if v.is_string() => v
            .as_str()
            .and_then(|s| s.parse::<f64>().ok())
            .unwrap_or(0.0)
            .round() as i64,
        _ => 0,
    };
    if cooldown_ms <= 0 {
        return None;
    }
    let provider_key = raw
        .get("providerKey")
        .and_then(|v| v.as_str())
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty());
    Some(SeriesCooldownDetail {
        provider_key,
        series,
        cooldown_ms,
    })
}

const ANTIGRAVITY_AUTH_VERIFY_BAN_MS: i64 = 24 * 60 * 60_000;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::virtual_router_engine::health;
    use crate::virtual_router_engine::routing_state_store::{
        load_provider_health_state, with_session_dir_override,
    };
    use serde_json::{json, Map, Value};
    use std::fs;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn build_test_core(provider_key: &str, model_id: &str) -> VirtualRouterEngineCore {
        let mut core = VirtualRouterEngineCore::new();
        let mut providers = Map::new();
        providers.insert(
            provider_key.to_string(),
            json!({
                "providerKey": provider_key,
                "providerType": "openai",
                "modelId": model_id,
                "enabled": true
            }),
        );
        core.provider_registry.load(&providers);
        let provider_keys = core.provider_registry.list_keys();
        core.health_manager.register_providers(&provider_keys);
        core
    }

    fn build_test_core_with_providers(entries: &[(&str, &str)]) -> VirtualRouterEngineCore {
        let mut core = VirtualRouterEngineCore::new();
        let mut providers = Map::new();
        for (provider_key, model_id) in entries {
            providers.insert(
                (*provider_key).to_string(),
                json!({
                    "providerKey": provider_key,
                    "providerType": "openai",
                    "modelId": model_id,
                    "enabled": true
                }),
            );
        }
        core.provider_registry.load(&providers);
        let provider_keys = core.provider_registry.list_keys();
        core.health_manager.register_providers(&provider_keys);
        core
    }

    fn build_error_event(provider_key: &str, classification: &str) -> Value {
        json!({
            "code": "HTTP_502",
            "message": "upstream failed",
            "stage": "provider.send",
            "status": 502,
            "runtime": {
                "requestId": "req-1",
                "providerKey": provider_key
            },
            "details": {
                "errorClassification": classification
            }
        })
    }

    fn build_top_level_error_event(provider_key: &str, classification: &str) -> Value {
        json!({
            "code": "HTTP_429",
            "message": "quota exhausted",
            "stage": "provider.send",
            "status": 429,
            "errorClassification": classification,
            "cooldownOverrideMs": 4321,
            "runtime": {
                "requestId": "req-top-level",
                "providerKey": provider_key
            }
        })
    }

    fn provider_state(
        core: &VirtualRouterEngineCore,
        provider_key: &str,
    ) -> crate::virtual_router_engine::health::ProviderHealthState {
        fn canonicalize_provider_key_for_lookup(provider_key: &str) -> String {
            let lower = provider_key.trim().to_ascii_lowercase();
            let mut out = String::with_capacity(lower.len());
            let bytes = lower.as_bytes();
            let mut i = 0usize;
            while i < bytes.len() {
                if bytes[i] == b'.' && i + 4 < bytes.len() && &bytes[i + 1..i + 4] == b"key" {
                    let mut j = i + 4;
                    while j < bytes.len() && bytes[j].is_ascii_digit() {
                        j += 1;
                    }
                    if j > i + 4 {
                        out.push('.');
                        out.push_str(&lower[i + 4..j]);
                        i = j;
                        continue;
                    }
                }
                out.push(bytes[i] as char);
                i += 1;
            }
            out
        }
        let canonical = canonicalize_provider_key_for_lookup(provider_key);
        core.health_manager
            .snapshot()
            .into_iter()
            .find(|state| state.provider_key == canonical)
            .expect("provider state")
    }

    #[test]
    fn special_400_does_not_mutate_provider_health() {
        let provider_key = "test.key1.model";
        let mut core = build_test_core(provider_key, "gpt-test");

        core.handle_provider_error(&build_error_event(provider_key, "special_400"));

        let state = provider_state(&core, provider_key);
        assert_eq!(state.state, "healthy");
        assert_eq!(state.failure_count, 0);
        assert_eq!(state.cooldown_expires_at, None);
    }

    #[test]
    fn affects_health_false_skips_health_mutation_even_with_classification() {
        let provider_key = "test.key1.model";
        let mut core = build_test_core(provider_key, "gpt-test");
        let mut event = build_error_event(provider_key, "recoverable");
        event["affectsHealth"] = Value::Bool(false);

        core.handle_provider_error(&event);

        let state = provider_state(&core, provider_key);
        assert_eq!(state.state, "healthy");
        assert_eq!(state.failure_count, 0);
        assert_eq!(state.cooldown_expires_at, None);
    }

    #[test]
    fn recoverable_error_records_single_provider_strike_before_threshold() {
        let provider_key = "test.key1.model";
        let mut core = build_test_core(provider_key, "gpt-test");

        core.handle_provider_error(&build_error_event(provider_key, "recoverable"));

        let state = provider_state(&core, provider_key);
        assert_eq!(state.state, "healthy");
        assert_eq!(state.failure_count, 1);
        assert_eq!(state.cooldown_expires_at, None);
    }

    #[test]
    fn unrecoverable_error_trips_single_provider_immediately() {
        let provider_key = "test.key1.model";
        let mut core = build_test_core(provider_key, "gpt-test");

        core.handle_provider_error(&build_error_event(provider_key, "unrecoverable"));

        let state = provider_state(&core, provider_key);
        assert_eq!(state.state, "tripped");
        assert!(state.failure_count >= 3);
        assert!(state.cooldown_expires_at.is_some());
    }

    #[test]
    fn route_pool_size_one_keeps_provider_available_even_if_registry_has_other_candidates() {
        let mut core = build_test_core_with_providers(&[
            ("test.key1.model-a", "gpt-test"),
            ("test.key1.model-b", "gpt-test"),
        ]);
        let event = json!({
            "code": "HTTP_429_2056",
            "message": "usage limit exceeded",
            "stage": "provider.send",
            "status": 429,
            "runtime": {
                "requestId": "req-single-route-pool",
                "providerKey": "test.key1.model-a"
            },
            "details": {
                "errorClassification": "recoverable",
                "upstreamCode": "provider_status_2056",
                "routePoolSize": 1
            }
        });

        core.handle_provider_error(&event);

        let state = provider_state(&core, "test.key1.model-a");
        assert_eq!(state.state, "healthy");
        assert_eq!(state.failure_count, 1);
        assert_eq!(state.cooldown_expires_at, None);
    }

    #[test]
    fn route_pool_size_one_still_enters_cooldown_after_three_502_for_priority_failover() {
        let mut core = build_test_core_with_providers(&[
            ("test.key1.model-a", "gpt-test"),
            ("test.key1.model-b", "gpt-test"),
        ]);
        let mk = |request_id: &str| {
            json!({
                "code": "HTTP_502",
                "message": "upstream failed",
                "stage": "provider.send",
                "status": 502,
                "runtime": {
                    "requestId": request_id,
                    "providerKey": "test.key1.model-a"
                },
                "details": {
                    "errorClassification": "recoverable",
                    "routePoolSize": 1
                }
            })
        };

        core.handle_provider_error(&mk("req-a1"));
        core.handle_provider_error(&mk("req-a2"));
        core.handle_provider_error(&mk("req-a3"));

        let state = provider_state(&core, "test.key1.model-a");
        assert_eq!(state.state, "tripped");
        let ttl = state.cooldown_expires_at.expect("cooldown expiry") - now_ms();
        assert!(
            ttl > 9 * 60_000 && ttl <= 11 * 60_000,
            "expected ~10m ttl, got {ttl}"
        );
    }

    #[test]
    fn route_pool_size_two_allows_health_mutation_without_current_availability_probe() {
        let mut core = build_test_core_with_providers(&[
            ("test.key1.model-a", "gpt-test"),
            ("test.key1.model-b", "gpt-test"),
        ]);
        let event = json!({
            "code": "HTTP_429_2056",
            "message": "usage limit exceeded",
            "stage": "provider.send",
            "status": 429,
            "runtime": {
                "requestId": "req-multi-route-pool",
                "providerKey": "test.key1.model-a"
            },
            "details": {
                "errorClassification": "recoverable",
                "upstreamCode": "provider_status_2056",
                "routePoolSize": 2
            }
        });

        core.handle_provider_error(&event);

        let state = provider_state(&core, "test.key1.model-a");
        assert_eq!(state.failure_count, 1);
    }

    #[test]
    fn top_level_error_classification_is_consumed_without_details_fallback() {
        let mut core = build_test_core_with_providers(&[
            ("test.key1.model-a", "gpt-test"),
            ("test.key1.model-b", "gpt-test"),
        ]);

        core.handle_provider_error(&build_top_level_error_event(
            "test.key1.model-a",
            "recoverable",
        ));

        let state = provider_state(&core, "test.key1.model-a");
        assert_eq!(state.failure_count, 1);
    }

    #[test]
    fn top_level_cooldown_override_ms_is_consumed_on_unrecoverable_error() {
        let mut core = build_test_core_with_providers(&[
            ("test.key1.model-a", "gpt-test"),
            ("test.key1.model-b", "gpt-test"),
        ]);

        core.handle_provider_error(&build_top_level_error_event(
            "test.key1.model-a",
            "unrecoverable",
        ));

        let state = provider_state(&core, "test.key1.model-a");
        assert_eq!(state.state, "tripped");
        assert_eq!(state.failure_count, 3);
        let now = now_ms();
        let expiry = state.cooldown_expires_at.expect("cooldown expiry");
        let ttl = expiry - now;
        assert!(ttl > 0 && ttl <= 10_000, "unexpected ttl={ttl}");
    }

    #[test]
    fn single_provider_429_blackout_surfaces_unavailable_reason_details() {
        let provider_key = "test.key1.model-a";
        let mut core = build_test_core(provider_key, "gpt-test");
        let started_at = now_ms();

        assert_eq!(
            core.health_manager.record_http_429_failure(
                provider_key,
                Some("HTTP_429".to_string()),
                started_at
            ),
            health::Http429ControlOutcome::None
        );
        assert_eq!(
            core.health_manager.record_http_429_failure(
                provider_key,
                Some("HTTP_429".to_string()),
                started_at + 1
            ),
            health::Http429ControlOutcome::None
        );
        assert_eq!(
            core.health_manager.record_http_429_failure(
                provider_key,
                Some("HTTP_429".to_string()),
                started_at + 2
            ),
            health::Http429ControlOutcome::CooldownApplied
        );

        let err =
            crate::virtual_router_engine::engine::selection::build_provider_not_available_error(
                &core,
                unsafe { napi::Env::from_raw(std::ptr::null_mut()) },
                &vec![provider_key.to_string()],
                "No available providers after applying routing instructions",
            );

        assert!(err.contains("PROVIDER_NOT_AVAILABLE"));
        assert!(err.contains("unavailableProviders"));
        assert!(err.contains("health_cooldown"));
        assert!(err.contains(provider_key));
    }

    #[test]
    fn recoverable_error_trips_when_alternative_provider_exists() {
        let mut core = build_test_core_with_providers(&[
            ("test.key1.model-a", "gpt-test"),
            ("test.key1.model-b", "gpt-test"),
        ]);
        let started_at = now_ms();
        core.handle_provider_error(&build_error_event("test.key1.model-a", "recoverable"));

        let state = provider_state(&core, "test.key1.model-a");
        assert_eq!(state.state, "healthy");
        assert_eq!(state.failure_count, 1);
        assert!(
            state.cooldown_expires_at.is_none(),
            "unexpected cooldown on first recoverable error"
        );
    }

    #[test]
    fn unrecoverable_error_trips_when_alternative_provider_exists() {
        let mut core = build_test_core_with_providers(&[
            ("test.key1.model-a", "gpt-test"),
            ("test.key1.model-b", "gpt-test"),
        ]);
        core.handle_provider_error(&build_error_event("test.key1.model-a", "unrecoverable"));

        let state = provider_state(&core, "test.key1.model-a");
        assert_eq!(state.state, "tripped");
        assert_eq!(state.failure_count, 3);
        let expires = state
            .cooldown_expires_at
            .expect("expected unrecoverable error to enter cooldown");
        assert!(expires > now_ms());
    }

    #[test]
    fn qwen_invalid_auth_blacklists_qwen_family_until_midnight() {
        let mut core = VirtualRouterEngineCore::new();
        let mut providers = Map::new();
        for (key, model_id, auth_family) in &[
            ("qwen.1.coder-model", "coder-model", Some("qwen")),
            ("qwen.2.coder-model", "coder-model", Some("qwen")),
            ("qwenchat.1.qwen3.6-plus", "qwen3.6-plus", None),
        ] {
            let mut entry = json!({
                "providerKey": key,
                "providerType": "openai",
                "modelId": model_id,
                "enabled": true
            });
            if let Some(family) = auth_family {
                entry["authFamily"] = json!(family);
            }
            providers.insert(key.to_string(), entry);
        }
        core.provider_registry.load(&providers);
        let provider_keys = core.provider_registry.list_keys();
        core.health_manager.register_providers(&provider_keys);

        let event = json!({
            "code": "HTTP_401",
            "message": "invalid access token or token expired",
            "stage": "provider.send",
            "status": 401,
            "runtime": {
                "requestId": "req-qwen-auth",
                "providerKey": "qwen.1.coder-model"
            },
            "details": {
                "errorClassification": "unrecoverable",
                "upstreamCode": "invalid_api_key"
            }
        });

        core.handle_provider_error(&event);

        let qwen1 = provider_state(&core, "qwen.1.coder-model");
        let qwen2 = provider_state(&core, "qwen.2.coder-model");
        let qwenchat = provider_state(&core, "qwenchat.1.qwen3.6-plus");
        assert_eq!(qwen1.state, "tripped");
        assert_eq!(qwen2.state, "tripped");
        assert!(qwen1.cooldown_expires_at.is_some());
        assert!(qwen2.cooldown_expires_at.is_some());
        assert_eq!(qwenchat.state, "healthy");
        assert_eq!(qwenchat.cooldown_expires_at, None);
    }

    #[test]
    fn recoverable_non_429_three_strikes_cooldown_ladder_10m_30m_5h() {
        let provider_key = "test.key1.model-a";
        let mut core = build_test_core_with_providers(&[
            (provider_key, "gpt-test"),
            ("test.key1.model-b", "gpt-test"),
        ]);

        let mk = |request_id: &str| {
            json!({
                "code": "HTTP_500",
                "message": "upstream internal error",
                "stage": "provider.send",
                "status": 500,
                "runtime": { "requestId": request_id, "providerKey": provider_key },
                "details": { "errorClassification": "recoverable", "routePoolSize": 2 }
            })
        };

        core.handle_provider_error(&mk("req-1"));
        core.handle_provider_error(&mk("req-2"));
        core.handle_provider_error(&mk("req-3"));
        let first_cycle = provider_state(&core, provider_key);
        assert_eq!(first_cycle.state, "tripped");
        let first_expiry = first_cycle.cooldown_expires_at.expect("cooldown expiry");
        let first_ttl = first_expiry - now_ms();
        assert!(
            first_ttl > 9 * 60_000 && first_ttl <= 11 * 60_000,
            "first cooldown should be ~10m, ttl={first_ttl}"
        );
        assert!(core
            .health_manager
            .is_available(provider_key, first_expiry + 1));

        core.handle_provider_error(&mk("req-4"));
        core.handle_provider_error(&mk("req-5"));
        core.handle_provider_error(&mk("req-6"));
        let second_cycle = provider_state(&core, provider_key);
        assert_eq!(second_cycle.state, "tripped");
        let second_expiry = second_cycle
            .cooldown_expires_at
            .expect("second cooldown expiry");
        let second_ttl = second_expiry - now_ms();
        assert!(
            second_ttl > 29 * 60_000 && second_ttl <= 31 * 60_000,
            "second cooldown should be ~30m, ttl={second_ttl}"
        );

        assert!(core
            .health_manager
            .is_available(provider_key, second_expiry + 1));
        core.handle_provider_error(&mk("req-7"));
        core.handle_provider_error(&mk("req-8"));
        core.handle_provider_error(&mk("req-9"));
        let third_cycle = provider_state(&core, provider_key);
        assert_eq!(third_cycle.state, "tripped");
        let third_expiry = third_cycle
            .cooldown_expires_at
            .expect("third cooldown expiry");
        let third_ttl = third_expiry - now_ms();
        assert!(
            third_ttl > (5 * 60 * 60_000 - 60_000) && third_ttl <= (5 * 60 * 60_000 + 60_000),
            "third cooldown should be ~5h, ttl={third_ttl}"
        );
    }

    #[test]
    fn unrecoverable_single_strike_enters_until_midnight_blacklist() {
        let provider_key = "test.key1.model-a";
        let mut core = build_test_core_with_providers(&[
            (provider_key, "gpt-test"),
            ("test.key1.model-b", "gpt-test"),
        ]);

        core.handle_provider_error(&json!({
            "code": "HTTP_500",
            "message": "fatal upstream failure",
            "stage": "provider.send",
            "status": 500,
            "runtime": { "requestId": "req-fatal", "providerKey": provider_key },
            "details": { "errorClassification": "unrecoverable", "routePoolSize": 2 }
        }));

        let state = provider_state(&core, provider_key);
        assert_eq!(state.state, "tripped");
        let expiry = state.cooldown_expires_at.expect("expiry");
        let now = now_ms();
        // Should be long cooldown (towards local midnight), not a short 30min retry window.
        assert!(expiry - now > 30 * 60_000);
    }

    #[test]
    fn persisted_503_daily_cooldown_is_cleared_by_provider_success_and_not_reimported() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let temp_dir = std::env::temp_dir().join(format!("rcc-provider-health-reprobe-{unique}"));
        fs::create_dir_all(&temp_dir).unwrap();

        with_session_dir_override(temp_dir.to_str(), || {
            let provider_key = "sdfv.key1.gpt-5.4";
            let backup_key = "mimo.key1.mimo-v2.5-pro";
            let mut core = build_test_core_with_providers(&[
                (provider_key, "gpt-5.4"),
                (backup_key, "mimo-v2.5-pro"),
            ]);

            // Step-1: simulate three consecutive HTTP 503 failures on primary -> persisted cooldown.
            for idx in 0..3 {
                core.handle_provider_failure(&json!({
                    "code": "HTTP_503",
                    "message": "upstream unavailable",
                    "stage": "provider.send",
                    "status": 503,
                    "runtime": {
                        "requestId": format!("req-503-{idx}"),
                        "providerKey": provider_key
                    },
                    "details": {
                        "routePoolSize": 2
                    }
                }));
            }

            let tripped = provider_state(&core, provider_key);
            assert_eq!(tripped.state, "tripped");
            assert!(tripped.cooldown_expires_at.is_some());

            let persisted = load_provider_health_state().expect("provider-health persisted");
            let persisted_entries = persisted
                .get("providerCooldowns")
                .and_then(|v| v.as_array())
                .expect("providerCooldowns array");
            assert!(
                persisted_entries.iter().any(|entry| {
                    entry.get("providerKey").and_then(|v| v.as_str()) == Some("sdfv.1.gpt-5.4")
                        && entry.get("reason").and_then(|v| v.as_str())
                            == Some("__http_503_daily_cooldown__")
                }),
                "persisted cooldown for canonical primary key not found"
            );

            // Step-2: simulate startup reprobe success -> should clear persisted cooldown.
            core.handle_provider_success(&json!({
                "runtime": {
                    "requestId": "startup_reprobe",
                    "providerKey": provider_key,
                    "runtimeKey": provider_key
                },
                "timestamp": now_ms()
            }));

            let healed = provider_state(&core, provider_key);
            assert_eq!(healed.state, "healthy");
            assert_eq!(healed.cooldown_expires_at, None);

            let persisted_after_success =
                load_provider_health_state().expect("provider-health persisted after success");
            let entries_after_success = persisted_after_success
                .get("providerCooldowns")
                .and_then(|v| v.as_array())
                .expect("providerCooldowns array after success");
            assert!(
                entries_after_success.is_empty(),
                "persisted cooldown should be cleared after provider success"
            );

            // Step-3: simulate a new engine restart/import cycle: no persisted cooldown should come back.
            let mut restarted = build_test_core_with_providers(&[
                (provider_key, "gpt-5.4"),
                (backup_key, "mimo-v2.5-pro"),
            ]);
            restarted.refresh_provider_health_from_store(true);
            let restarted_state = provider_state(&restarted, provider_key);
            assert_eq!(restarted_state.state, "healthy");
            assert_eq!(restarted_state.cooldown_expires_at, None);

            // Step-4: if first live request after restart still hits 503, it starts a fresh
            // recoverable series; without persisted reprobe state it does not instantly trip.
            restarted.handle_provider_failure(&json!({
                "code": "HTTP_503",
                "message": "upstream unavailable again",
                "stage": "provider.send",
                "status": 503,
                "runtime": {
                    "requestId": "req-503-again",
                    "providerKey": provider_key
                },
                "details": {
                    "routePoolSize": 2
                }
            }));
            let retripped = provider_state(&restarted, provider_key);
            assert_eq!(retripped.state, "healthy");
            assert_eq!(retripped.failure_count, 1);
            assert_eq!(retripped.cooldown_expires_at, None);
        });

        let _ = fs::remove_dir_all(PathBuf::from(temp_dir));
    }

    #[test]
    fn windsurf_managed_health_success_clears_sibling_model_persisted_503_cooldown() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let temp_dir =
            std::env::temp_dir().join(format!("rcc-windsurf-managed-health-aggregation-{unique}"));
        fs::create_dir_all(&temp_dir).unwrap();

        with_session_dir_override(temp_dir.to_str(), || {
            let low_key = "windsurf.managed.gpt-5.5-low";
            let medium_key = "windsurf.managed.gpt-5.5-medium";
            let mut core = build_test_core_with_providers(&[
                (low_key, "gpt-5.5-low"),
                (medium_key, "gpt-5.5-medium"),
            ]);

            for idx in 0..3 {
                core.handle_provider_failure(&json!({
                    "code": "WINDSURF_SERVICE_UNREACHABLE",
                    "message": "windsurf upstream returned transient 503",
                    "stage": "provider.send",
                    "status": 503,
                    "runtime": {
                        "requestId": format!("low-live-request-{idx}"),
                        "providerKey": low_key
                    },
                    "details": {
                        "routePoolSize": 1,
                        "errorClassification": "recoverable"
                    }
                }));
            }

            let cooled_low = provider_state(&core, low_key);
            assert_eq!(cooled_low.state, "tripped");
            assert!(cooled_low.cooldown_expires_at.is_some());

            core.handle_provider_success(&json!({
                "runtime": {
                    "requestId": "startup-health-probe",
                    "providerKey": medium_key,
                    "runtimeKey": medium_key
                },
                "timestamp": now_ms()
            }));

            let low_after_probe = provider_state(&core, low_key);
            assert_eq!(low_after_probe.state, "healthy");
            assert_eq!(low_after_probe.cooldown_expires_at, None);

            let persisted_after_probe = load_provider_health_state()
                .expect("provider-health persisted after windsurf managed probe");
            let entries_after_probe = persisted_after_probe
                .get("providerCooldowns")
                .and_then(|v| v.as_array())
                .expect("providerCooldowns array after windsurf managed probe");
            assert!(
                entries_after_probe.is_empty(),
                "managed Windsurf health success must clear sibling model persisted cooldowns"
            );
        });

        let _ = fs::remove_dir_all(PathBuf::from(temp_dir));
    }
}
