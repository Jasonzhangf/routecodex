use serde_json::Value;

use super::VirtualRouterEngineCore;
use crate::virtual_router_engine::time_utils::now_ms;

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
    }

    pub(crate) fn mirror_provider_success_in_memory(&mut self, event: &Value) {
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
        self.health_manager
            .record_failure(&provider_key, reason, now);
    }

    pub(crate) fn handle_provider_error(&mut self, event: &Value) {
        if !event_affects_health(event) {
            return;
        }
        self.handle_provider_failure(event);
    }

    pub(crate) fn mirror_provider_error_in_memory(&mut self, event: &Value) {
        if !event_affects_health(event) {
            return;
        }
        let provider_key = resolve_provider_key(event).unwrap_or_default();
        if provider_key.is_empty() {
            return;
        }
        let reason = extract_error_reason(event);
        let now = now_ms();
        self.health_manager
            .record_failure(&provider_key, reason, now);
    }

}

fn event_affects_health(event: &Value) -> bool {
    if matches!(
        event.get("affectsHealth").and_then(|v| v.as_bool()),
        Some(false)
    ) {
        return false;
    }
    true
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

#[cfg(test)]
mod tests {
    use super::*;
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

    fn build_error_event_with_session_dir(
        provider_key: &str,
        classification: &str,
        session_dir: &PathBuf,
    ) -> Value {
        let mut event = build_error_event(provider_key, classification);
        event["runtime"]["sessionDir"] = Value::String(session_dir.to_string_lossy().to_string());
        event
    }

    fn unique_temp() -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!("rcc-provider-event-scope-{unique}"))
    }

    fn build_top_level_error_event(provider_key: &str, classification: &str) -> Value {
        json!({
            "code": "HTTP_429",
            "message": "quota exhausted",
            "stage": "provider.send",
            "status": 429,
            "errorClassification": classification,
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
    fn unknown_http_400_records_single_strike_like_other_real_provider_errors() {
        let provider_key = "test.key1.model";
        let mut core = build_test_core(provider_key, "gpt-test");

        core.handle_provider_error(&build_error_event(provider_key, "recoverable"));

        let state = provider_state(&core, provider_key);
        assert_eq!(state.state, "healthy");
        assert_eq!(state.failure_count, 1);
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
    fn provider_error_with_runtime_session_dir_does_not_persist_health() {
        let provider_key = "test.key1.model";
        let root_dir = unique_temp();
        let scoped_dir = unique_temp();
        fs::create_dir_all(&root_dir).unwrap();
        fs::create_dir_all(&scoped_dir).unwrap();

        let mut core = build_test_core(provider_key, "gpt-test");
        let event =
            build_error_event_with_session_dir(provider_key, "unrecoverable", &scoped_dir);

        core.handle_provider_error(&event);

        let state = provider_state(&core, provider_key);
        assert_eq!(state.failure_count, 1);
        assert!(!scoped_dir.join("provider-health.json").exists());
        assert!(!root_dir.join("provider-health.json").exists());

        let _ = fs::remove_dir_all(root_dir);
        let _ = fs::remove_dir_all(scoped_dir);
    }

    #[test]
    fn provider_error_without_runtime_session_dir_does_not_persist_health() {
        let provider_key = "test.key1.model";
        let root_dir = unique_temp();
        fs::create_dir_all(&root_dir).unwrap();

        let mut core = build_test_core(provider_key, "gpt-test");
        let event = build_error_event(provider_key, "unrecoverable");

        core.handle_provider_error(&event);

        let state = provider_state(&core, provider_key);
        assert_eq!(state.failure_count, 1);
        assert!(
            !root_dir.join("provider-health.json").exists(),
            "provider cooldown must remain in memory only"
        );

        let _ = fs::remove_dir_all(root_dir);
    }

    #[test]
    fn any_real_provider_error_records_single_strike_before_threshold() {
        let provider_key = "test.key1.model";
        let mut core = build_test_core(provider_key, "gpt-test");

        core.handle_provider_error(&build_error_event(provider_key, "recoverable"));

        let state = provider_state(&core, provider_key);
        assert_eq!(state.state, "healthy");
        assert_eq!(state.failure_count, 1);
        assert_eq!(state.cooldown_expires_at, None);
    }

    #[test]
    fn top_level_error_classification_records_failure_without_details_fallback() {
        let provider_key = "test.key1.model";
        let mut core = build_test_core(provider_key, "gpt-test");

        core.handle_provider_error(&build_top_level_error_event(provider_key, "recoverable"));

        let state = provider_state(&core, provider_key);
        assert_eq!(state.state, "healthy");
        assert_eq!(state.failure_count, 1);
        assert_eq!(state.cooldown_expires_at, None);
    }

    #[test]
    fn three_failures_trigger_30m_cooldown_for_provider_error_entrypoint() {
        let provider_key = "test.key1.model-a";
        let mut core = build_test_core_with_providers(&[
            (provider_key, "gpt-test"),
            ("test.key1.model-b", "gpt-test"),
        ]);

        core.handle_provider_error(&build_error_event(provider_key, "recoverable"));
        core.handle_provider_error(&build_error_event(provider_key, "recoverable"));
        core.handle_provider_error(&build_error_event(provider_key, "recoverable"));

        let state = provider_state(&core, provider_key);
        assert_eq!(state.state, "tripped");
        assert_eq!(state.failure_count, 3);
        let ttl = state.cooldown_expires_at.expect("cooldown expiry") - now_ms();
        assert!(
            ttl > 29 * 60_000 && ttl <= 31 * 60_000,
            "expected ~30m ttl, got {ttl}"
        );
    }

    #[test]
    fn cooldown_expiry_restores_provider_and_same_three_failures_trip_again() {
        let provider_key = "test.key1.model-a";
        let mut core = build_test_core_with_providers(&[
            (provider_key, "gpt-test"),
            ("test.key1.model-b", "gpt-test"),
        ]);

        for _ in 0..3 {
            core.handle_provider_error(&build_error_event(provider_key, "recoverable"));
        }

        let first_cycle = provider_state(&core, provider_key);
        let first_expiry = first_cycle.cooldown_expires_at.expect("cooldown expiry");
        assert!(
            core.health_manager
                .is_available(provider_key, first_expiry + 1),
            "expiry should restore availability"
        );
        let restored = provider_state(&core, provider_key);
        assert_eq!(restored.state, "healthy");
        assert_eq!(restored.failure_count, 0);
        assert_eq!(restored.cooldown_expires_at, None);

        for _ in 0..3 {
            core.handle_provider_error(&build_error_event(provider_key, "recoverable"));
        }

        let second_cycle = provider_state(&core, provider_key);
        assert_eq!(second_cycle.state, "tripped");
        assert_eq!(second_cycle.failure_count, 3);
        let ttl = second_cycle
            .cooldown_expires_at
            .expect("second cooldown expiry")
            - now_ms();
        assert!(
            ttl > 29 * 60_000 && ttl <= 31 * 60_000,
            "second cycle should still use ~30m ttl, got {ttl}"
        );
    }

    #[test]
    fn provider_failure_entrypoint_uses_same_three_strike_contract() {
        let provider_key = "test.key1.model-a";
        let mut core = build_test_core_with_providers(&[
            (provider_key, "gpt-test"),
            ("test.key1.model-b", "gpt-test"),
        ]);

        core.handle_provider_failure(&build_error_event(provider_key, "recoverable"));
        core.handle_provider_failure(&build_error_event(provider_key, "recoverable"));
        core.handle_provider_failure(&build_error_event(provider_key, "recoverable"));

        let state = provider_state(&core, provider_key);
        assert_eq!(state.state, "tripped");
        assert_eq!(state.failure_count, 3);
        let ttl = state.cooldown_expires_at.expect("cooldown expiry") - now_ms();
        assert!(
            ttl > 29 * 60_000 && ttl <= 31 * 60_000,
            "provider failure entrypoint should use ~30m cooldown, ttl={ttl}"
        );
    }

    #[test]
    fn provider_error_cooldown_stays_memory_only() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let temp_dir = std::env::temp_dir().join(format!("rcc-provider-health-reprobe-{unique}"));
        fs::create_dir_all(&temp_dir).unwrap();

        let provider_key = "sdfv.key1.gpt-5.4";
        let backup_key = "mimo.key1.mimo-v2.5-pro";
        let mut core = build_test_core_with_providers(&[
            (provider_key, "gpt-5.4"),
            (backup_key, "mimo-v2.5-pro"),
        ]);

        let event = build_error_event_with_session_dir(provider_key, "recoverable", &temp_dir);
        core.handle_provider_error(&event);
        core.handle_provider_error(&event);
        core.handle_provider_error(&event);

        let tripped = provider_state(&core, provider_key);
        assert_eq!(tripped.state, "tripped");
        assert!(
            !temp_dir.join("provider-health.json").exists(),
            "tripped provider cooldown must not be persisted across restart"
        );

        let _ = fs::remove_dir_all(PathBuf::from(temp_dir));
    }

    #[test]
    fn provider_success_clears_runtime_failure_window() {
        let provider_key = "sdfv.key1.gpt-5.5";
        let mut core = build_test_core_with_providers(&[
            (provider_key, "gpt-5.5"),
            ("cc.key1.gpt-5.5", "gpt-5.5"),
        ]);

        core.handle_provider_error(&json!({
            "code": "HTTP_503",
            "message": "first failure",
            "stage": "provider.send",
            "status": 503,
            "errorClassification": "recoverable",
            "runtime": {
                "requestId": "first-failure",
                "providerKey": provider_key,
                "runtimeKey": provider_key
            },
            "timestamp": now_ms()
        }));
        core.handle_provider_error(&json!({
            "code": "HTTP_503",
            "message": "second failure",
            "stage": "provider.send",
            "status": 503,
            "errorClassification": "recoverable",
            "runtime": {
                "requestId": "second-failure",
                "providerKey": provider_key,
                "runtimeKey": provider_key
            },
            "timestamp": now_ms()
        }));
        core.handle_provider_error(&json!({
            "code": "HTTP_503",
            "message": "third failure",
            "stage": "provider.send",
            "status": 503,
            "errorClassification": "recoverable",
            "runtime": {
                "requestId": "third-failure",
                "providerKey": provider_key,
                "runtimeKey": provider_key
            },
            "timestamp": now_ms()
        }));
        let tripped = provider_state(&core, provider_key);
        assert_eq!(tripped.state, "tripped");

        core.handle_provider_success(&json!({
            "runtime": {
                "requestId": "first-live-request",
                "providerKey": provider_key,
                "runtimeKey": provider_key
            },
            "timestamp": now_ms()
        }));

        let healed = provider_state(&core, provider_key);
        assert_eq!(
            healed.state, "healthy",
            "first request success should clear cooldown"
        );
        assert_eq!(
            healed.cooldown_expires_at, None,
            "cooldown should be cleared"
        );
    }
}
