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
        self.apply_series_cooldown(event);
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
