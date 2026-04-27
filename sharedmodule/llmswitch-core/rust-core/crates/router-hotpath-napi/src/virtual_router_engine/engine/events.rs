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
    pub(crate) fn handle_provider_success(&mut self, event: &Value) {
        let provider_key = event
            .get("runtime")
            .and_then(|v| v.get("providerKey"))
            .and_then(|v| v.as_str())
            .unwrap_or("");
        if provider_key.is_empty() {
            return;
        }
        self.health_manager.record_success(provider_key);
        if let Some(pending) = &self.pending_alias {
            let request_id = event
                .get("runtime")
                .and_then(|v| v.get("requestId"))
                .and_then(|v| v.as_str())
                .unwrap_or("");
            if pending.provider_key == provider_key
                && (pending.request_id.is_empty() || pending.request_id == request_id)
            {
                self.antigravity_session_alias_store
                    .insert(pending.session_scope.clone(), pending.alias_key.clone());
                self.pending_alias = None;
            }
        }
    }

    pub(crate) fn handle_provider_failure(&mut self, event: &Value) {
        if !event_affects_health(event) {
            return;
        }
        let provider_key = resolve_provider_key(event).unwrap_or_default();
        if provider_key.is_empty() {
            return;
        }
        let reason = extract_error_reason(event);
        let now = now_ms();
        let fatal = event.get("fatal").and_then(|v| v.as_bool()).unwrap_or(false);
        let status_code = extract_status_code(event);
        let cooldown_override_ms = extract_cooldown_override_ms(event);
        let cooldown_ms = cooldown_override_ms.or_else(|| {
            if status_code == Some(429) && is_daily_limit_exceeded(event) {
                Some(compute_cooldown_until_next_local_midnight_ms(now))
            } else {
                None
            }
        });
        if fatal {
            self.health_manager
                .trip_provider(&provider_key, reason, cooldown_ms, now);
            return;
        }
        if matches!(status_code, Some(429)) {
            self.health_manager
                .cooldown_provider(&provider_key, reason, cooldown_ms, now);
            return;
        }
        if cooldown_override_ms.is_some() {
            self.health_manager
                .cooldown_provider(&provider_key, reason, cooldown_override_ms, now);
            return;
        }
        self.health_manager
            .record_failure(&provider_key, reason, now);
    }

    pub(crate) fn handle_provider_error(&mut self, event: &Value) {
        if self.quota_view.is_some() {
            return;
        }
        if !event_affects_health(event) {
            return;
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
        if self.apply_antigravity_auth_verify_blacklist(event) {
            return;
        }
        self.apply_series_cooldown(event);
    }

    fn apply_antigravity_auth_verify_blacklist(&mut self, event: &Value) -> bool {
        let Some(runtime_key) = resolve_antigravity_runtime_key(event) else {
            return false;
        };
        if !is_google_account_verification_required(event) {
            return false;
        }
        let prefix = format!("{}.", runtime_key);
        let provider_keys = self
            .provider_registry
            .list_provider_keys("antigravity")
            .into_iter()
            .filter(|key| key.starts_with(&prefix))
            .collect::<Vec<_>>();
        if provider_keys.is_empty() {
            return false;
        }
        let now = now_ms();
        for key in provider_keys {
            self.health_manager.trip_provider(
                &key,
                Some("auth_verify".to_string()),
                Some(ANTIGRAVITY_AUTH_VERIFY_BAN_MS),
                now,
            );
        }
        true
    }

    fn apply_qwen_auth_family_blacklist(&mut self, event: &Value) -> bool {
        let Some(provider_key) = resolve_provider_key(event) else {
            return false;
        };
        if !provider_key.starts_with("qwen.") {
            return false;
        }
        if !is_qwen_auth_invalid_event(event) {
            return false;
        }
        let cooldown_ms = compute_cooldown_until_next_local_midnight_ms(now_ms())
            .max(DEFAULT_UNRECOVERABLE_MIN_COOLDOWN_MS);
        let now = now_ms();
        for key in self.provider_registry.list_provider_keys("qwen") {
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
                let cooldown_ms = extract_recoverable_cooldown_ms(event)
                    .unwrap_or(DEFAULT_RECOVERABLE_COOLDOWN_MS);
                self.health_manager.cooldown_provider(
                    provider_key,
                    reason,
                    Some(cooldown_ms.max(DEFAULT_RECOVERABLE_COOLDOWN_MS)),
                    now,
                );
                self.apply_series_cooldown(event);
                true
            }
            ProviderErrorClassification::Unrecoverable => {
                let cooldown_ms = compute_cooldown_until_next_local_midnight_ms(now)
                    .max(DEFAULT_UNRECOVERABLE_MIN_COOLDOWN_MS);
                self.health_manager
                    .trip_provider(provider_key, reason, Some(cooldown_ms), now);
                let _ = self.apply_qwen_auth_family_blacklist(event);
                let _ = self.apply_antigravity_auth_verify_blacklist(event);
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
            let model_id = profile.model_id.as_deref().unwrap_or("");
            let series = resolve_model_series(model_id);
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
}

const DEFAULT_RECOVERABLE_COOLDOWN_MS: i64 = 30_000;
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

fn extract_provider_error_classification(event: &Value) -> Option<ProviderErrorClassification> {
    let value = event
        .get("details")
        .and_then(|v| v.get("errorClassification"))
        .and_then(|v| v.as_str())
        .map(|v| v.trim().to_lowercase())?;
    match value.as_str() {
        "unrecoverable" => Some(ProviderErrorClassification::Unrecoverable),
        "recoverable" => Some(ProviderErrorClassification::Recoverable),
        "special_400" => Some(ProviderErrorClassification::Special400),
        _ => None,
    }
}

fn extract_recoverable_cooldown_ms(event: &Value) -> Option<i64> {
    let status = event.get("status").and_then(|v| {
        v.as_i64()
            .or_else(|| v.as_u64().map(|value| value as i64))
            .or_else(|| v.as_f64().map(|value| value.round() as i64))
    });
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

fn is_qwen_auth_invalid_event(event: &Value) -> bool {
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

fn resolve_antigravity_runtime_key(event: &Value) -> Option<String> {
    let runtime = event.get("runtime").and_then(|v| v.as_object())?;
    if let Some(target_runtime_key) = runtime
        .get("target")
        .and_then(|v| v.as_object())
        .and_then(|target| target.get("runtimeKey"))
        .and_then(|v| v.as_str())
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
    {
        return Some(target_runtime_key);
    }
    let provider_key = runtime
        .get("providerKey")
        .and_then(|v| v.as_str())
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
        .or_else(|| {
            runtime
                .get("target")
                .and_then(|v| v.as_object())
                .and_then(|target| target.get("providerKey"))
                .and_then(|v| v.as_str())
                .map(|v| v.trim().to_string())
                .filter(|v| !v.is_empty())
        })?;
    let parts = provider_key
        .split('.')
        .map(str::trim)
        .filter(|segment| !segment.is_empty())
        .collect::<Vec<_>>();
    if parts.len() < 2 {
        return None;
    }
    Some(format!("{}.{}", parts[0], parts[1]))
}

fn extract_series_cooldown_detail(event: &Value) -> Option<SeriesCooldownDetail> {
    let details = event.get("details")?.as_object()?;
    let raw = details.get("virtualRouterSeriesCooldown")?.as_object()?;
    let series_raw = raw.get("series")?.as_str()?.trim().to_lowercase();
    let series = match series_raw.as_str() {
        "gemini-pro" | "gemini-flash" | "claude" => series_raw,
        _ => return None,
    };
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

fn resolve_model_series(model_id: &str) -> String {
    let lower = model_id.to_lowercase();
    if lower.contains("claude") || lower.contains("opus") {
        return "claude".to_string();
    }
    if lower.contains("flash") {
        return "gemini-flash".to_string();
    }
    if lower.contains("gemini") || lower.contains("pro") {
        return "gemini-pro".to_string();
    }
    "default".to_string()
}

const ANTIGRAVITY_AUTH_VERIFY_BAN_MS: i64 = 24 * 60 * 60_000;

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Map, Value};

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

    fn provider_state(
        core: &VirtualRouterEngineCore,
        provider_key: &str,
    ) -> crate::virtual_router_engine::health::ProviderHealthState {
        core.health_manager
            .snapshot()
            .into_iter()
            .find(|state| state.provider_key == provider_key)
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
    fn recoverable_error_enters_short_provider_cooldown() {
        let provider_key = "test.key1.model";
        let mut core = build_test_core(provider_key, "gpt-test");
        let started_at = now_ms();

        core.handle_provider_error(&build_error_event(provider_key, "recoverable"));

        let state = provider_state(&core, provider_key);
        assert_eq!(state.state, "tripped");
        assert_eq!(state.failure_count, 1);
        let expiry = state
            .cooldown_expires_at
            .expect("recoverable cooldown expiry");
        let ttl = expiry - started_at;
        assert!(ttl >= DEFAULT_RECOVERABLE_COOLDOWN_MS - 2_000, "ttl={ttl}");
        assert!(ttl <= DEFAULT_RECOVERABLE_COOLDOWN_MS + 5_000, "ttl={ttl}");
    }

    #[test]
    fn unrecoverable_error_trips_provider_until_local_midnight_window() {
        let provider_key = "test.key1.model";
        let mut core = build_test_core(provider_key, "gpt-test");
        let started_at = now_ms();

        core.handle_provider_error(&build_error_event(provider_key, "unrecoverable"));

        let state = provider_state(&core, provider_key);
        assert_eq!(state.state, "tripped");
        assert!(state.failure_count >= 3);
        let expiry = state
            .cooldown_expires_at
            .expect("unrecoverable cooldown expiry");
        let ttl = expiry - started_at;
        assert!(
            ttl >= DEFAULT_UNRECOVERABLE_MIN_COOLDOWN_MS - 2_000,
            "ttl={ttl}"
        );
        assert!(ttl <= 24 * 60 * 60_000 + 5_000, "ttl={ttl}");
    }

    #[test]
    fn qwen_invalid_auth_blacklists_qwen_family_until_midnight() {
        let mut core = build_test_core_with_providers(&[
            ("qwen.1.coder-model", "coder-model"),
            ("qwen.2.coder-model", "coder-model"),
            ("qwenchat.1.qwen3.6-plus", "qwen3.6-plus"),
        ]);
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
}
