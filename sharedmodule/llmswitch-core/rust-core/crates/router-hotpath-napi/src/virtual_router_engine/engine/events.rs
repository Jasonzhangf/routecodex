use serde_json::Value;

use super::VirtualRouterEngineCore;
use crate::virtual_router_engine::time_utils::now_ms;

#[derive(Debug)]
struct SeriesCooldownDetail {
    provider_key: Option<String>,
    series: String,
    cooldown_ms: i64,
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
        let provider_key = event
            .get("runtime")
            .and_then(|v| v.get("providerKey"))
            .and_then(|v| v.as_str())
            .unwrap_or("");
        if provider_key.is_empty() {
            return;
        }
        let reason = event
            .get("error")
            .and_then(|v| v.get("message"))
            .and_then(|v| v.as_str())
            .map(|v| v.to_string());
        self.health_manager
            .record_failure(provider_key, reason, now_ms());
    }

    pub(crate) fn handle_provider_error(&mut self, event: &Value) {
        if self.quota_view.is_some() {
            return;
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
