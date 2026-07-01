use serde_json::Value;
use std::sync::{Arc, OnceLock, RwLock, Weak};

use super::engine::VirtualRouterEngineCore;

static RUNTIME_REGISTRY: OnceLock<RwLock<Vec<Weak<RwLock<VirtualRouterEngineCore>>>>> =
    OnceLock::new();

fn registry() -> &'static RwLock<Vec<Weak<RwLock<VirtualRouterEngineCore>>>> {
    RUNTIME_REGISTRY.get_or_init(|| RwLock::new(Vec::new()))
}

pub(crate) fn register_runtime(core: &Arc<RwLock<VirtualRouterEngineCore>>) {
    let mut entries = registry().write().expect("runtime registry write lock");
    entries.retain(|entry| entry.upgrade().is_some());
    if entries.iter().any(|entry| {
        entry
            .upgrade()
            .map(|existing| Arc::ptr_eq(&existing, core))
            .unwrap_or(false)
    }) {
        return;
    }
    entries.push(Arc::downgrade(core));
}

pub(crate) fn unregister_runtime(core: &Arc<RwLock<VirtualRouterEngineCore>>) {
    let mut entries = registry().write().expect("runtime registry write lock");
    entries.retain(|entry| {
        entry
            .upgrade()
            .map(|existing| !Arc::ptr_eq(&existing, core))
            .unwrap_or(false)
    });
}

pub(crate) fn reset_for_tests() {
    registry()
        .write()
        .expect("runtime registry write lock")
        .clear();
}

pub(crate) fn report_provider_error(event: &Value) -> Value {
    let normalized = normalize_provider_error_event(event);
    dispatch_to_registered_runtimes(&normalized, RuntimeEventKind::Error);
    normalized
}

pub(crate) fn report_provider_success(event: &Value) -> Value {
    let normalized = normalize_provider_success_event(event);
    dispatch_to_registered_runtimes(&normalized, RuntimeEventKind::Success);
    normalized
}

#[derive(Clone, Copy)]
enum RuntimeEventKind {
    Error,
    Success,
}

fn dispatch_to_registered_runtimes(event: &Value, kind: RuntimeEventKind) {
    let cores = {
        let mut entries = registry().write().expect("runtime registry write lock");
        let mut cores = Vec::new();
        entries.retain(|entry| {
            if let Some(core) = entry.upgrade() {
                cores.push(core);
                true
            } else {
                false
            }
        });
        cores
    };

    let routing_policy_group = resolve_event_routing_policy_group(event);
    if let Some(provider_key) = resolve_event_provider_key(event) {
        if let Some(group) = routing_policy_group.as_deref() {
            let mut dispatched = false;
            for core in &cores {
                if let Ok(mut guard) = core.write() {
                    if runtime_owns_provider_event_for_group(&guard, &provider_key, group) {
                        if dispatched {
                            mirror_runtime_event(&mut guard, event, kind);
                        } else {
                            dispatch_runtime_event(&mut guard, event, kind);
                            dispatched = true;
                        }
                    }
                }
            }
            return;
        }
        let mut dispatched = false;
        for core in &cores {
            if let Ok(mut guard) = core.write() {
                if runtime_owns_provider_event(&guard, &provider_key) {
                    if dispatched {
                        mirror_runtime_event(&mut guard, event, kind);
                    } else {
                        dispatch_runtime_event(&mut guard, event, kind);
                        dispatched = true;
                    }
                }
            }
        }
        if dispatched {
            return;
        }
    }

    for core in cores {
        if let Ok(mut guard) = core.write() {
            dispatch_runtime_event(&mut guard, event, kind);
        }
    }
}

fn dispatch_runtime_event(
    core: &mut VirtualRouterEngineCore,
    event: &Value,
    kind: RuntimeEventKind,
) {
    match kind {
        RuntimeEventKind::Error => core.handle_provider_error(event),
        RuntimeEventKind::Success => core.handle_provider_success(event),
    }
}

fn mirror_runtime_event(
    core: &mut VirtualRouterEngineCore,
    event: &Value,
    kind: RuntimeEventKind,
) {
    match kind {
        RuntimeEventKind::Error => core.mirror_provider_error_in_memory(event),
        RuntimeEventKind::Success => core.mirror_provider_success_in_memory(event),
    }
}

fn runtime_owns_provider_event(core: &VirtualRouterEngineCore, provider_key: &str) -> bool {
    core.provider_registry.get(provider_key).is_some()
        || resolve_runtime_key_from_provider_event(provider_key)
            .as_deref()
            .and_then(|runtime_key| core.provider_registry.get(runtime_key))
            .is_some()
}

fn runtime_owns_provider_event_for_group(
    core: &VirtualRouterEngineCore,
    provider_key: &str,
    routing_policy_group: &str,
) -> bool {
    let Some(group) = normalize_nonempty_string(Some(routing_policy_group)) else {
        return false;
    };
    let Some(runtime_group) = core
        .routing_policy_group
        .as_deref()
        .and_then(|value| normalize_nonempty_string(Some(value)))
    else {
        return false;
    };
    runtime_group == group && runtime_owns_provider_event(core, provider_key)
}

fn resolve_event_provider_key(event: &Value) -> Option<String> {
    event
        .get("providerKey")
        .and_then(|value| value.as_str())
        .or_else(|| {
            event
                .get("target")
                .and_then(|target| target.get("providerKey"))
                .and_then(|value| value.as_str())
        })
        .or_else(|| {
            event
                .get("runtime")
                .and_then(|runtime| runtime.get("providerKey"))
                .and_then(|value| value.as_str())
        })
        .or_else(|| {
            event
                .get("runtime")
                .and_then(|runtime| runtime.get("target"))
                .and_then(|target| target.get("providerKey"))
                .and_then(|value| value.as_str())
        })
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
}

fn resolve_event_routing_policy_group(event: &Value) -> Option<String> {
    event
        .get("routecodexRoutingPolicyGroup")
        .and_then(|value| value.as_str())
        .or_else(|| {
            event
                .get("runtime")
                .and_then(|runtime| runtime.get("routecodexRoutingPolicyGroup"))
                .and_then(|value| value.as_str())
        })
        .or_else(|| {
            event
                .get("runtime")
                .and_then(|runtime| runtime.get("routingPolicyGroup"))
                .and_then(|value| value.as_str())
        })
        .and_then(|value| normalize_nonempty_string(Some(value)))
}

fn normalize_nonempty_string(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
}

fn resolve_runtime_key_from_provider_event(provider_key: &str) -> Option<String> {
    let mut parts = provider_key.split('.').collect::<Vec<&str>>();
    if parts.len() >= 3 && parts[1].starts_with("key") && parts[1].len() > 3 {
        parts[1] = &parts[1][3..];
        let runtime_key = parts.join(".");
        if !runtime_key.trim().is_empty() && runtime_key != provider_key {
            return Some(runtime_key);
        }
    }
    None
}

fn normalize_provider_error_event(event: &Value) -> Value {
    let code = read_string(event.get("code")).unwrap_or_else(|| "ERR_UNKNOWN".to_string());
    let message = read_string(event.get("message")).unwrap_or_else(|| code.clone());
    let stage = read_string(event.get("stage")).unwrap_or_else(|| "unknown".to_string());
    let timestamp = read_i64(event.get("timestamp")).unwrap_or_else(super::time_utils::now_ms);
    let runtime = normalize_object(event.get("runtime"));

    let mut out = serde_json::Map::new();
    out.insert("code".to_string(), Value::String(code));
    out.insert("message".to_string(), Value::String(message));
    out.insert("stage".to_string(), Value::String(stage));
    insert_if_present(&mut out, "status", event.get("status"));
    insert_if_present(&mut out, "recoverable", event.get("recoverable"));
    insert_if_present(&mut out, "affectsHealth", event.get("affectsHealth"));
    insert_if_present(&mut out, "fatal", event.get("fatal"));
    insert_if_present(
        &mut out,
        "errorClassification",
        event.get("errorClassification"),
    );
    insert_if_present(&mut out, "routePool", event.get("routePool"));
    insert_if_present(
        &mut out,
        "excludedProviderKeys",
        event.get("excludedProviderKeys"),
    );
    out.insert("runtime".to_string(), runtime);
    out.insert(
        "timestamp".to_string(),
        Value::Number(serde_json::Number::from(timestamp)),
    );
    insert_if_present(&mut out, "details", event.get("details"));
    Value::Object(out)
}

fn normalize_provider_success_event(event: &Value) -> Value {
    let timestamp = read_i64(event.get("timestamp")).unwrap_or_else(super::time_utils::now_ms);
    let mut out = serde_json::Map::new();
    out.insert(
        "runtime".to_string(),
        normalize_object(event.get("runtime")),
    );
    out.insert(
        "timestamp".to_string(),
        Value::Number(serde_json::Number::from(timestamp)),
    );
    insert_if_present(&mut out, "metadata", event.get("metadata"));
    insert_if_present(&mut out, "details", event.get("details"));
    Value::Object(out)
}

fn normalize_object(value: Option<&Value>) -> Value {
    match value {
        Some(Value::Object(map)) => Value::Object(map.clone()),
        _ => Value::Object(serde_json::Map::new()),
    }
}

fn insert_if_present(out: &mut serde_json::Map<String, Value>, key: &str, value: Option<&Value>) {
    if let Some(value) = value {
        if !value.is_null() {
            out.insert(key.to_string(), value.clone());
        }
    }
}

fn read_string(value: Option<&Value>) -> Option<String> {
    value
        .and_then(|entry| entry.as_str())
        .map(str::trim)
        .filter(|entry| !entry.is_empty())
        .map(ToString::to_string)
}

fn read_i64(value: Option<&Value>) -> Option<i64> {
    match value {
        Some(Value::Number(number)) => number
            .as_i64()
            .or_else(|| number.as_u64().map(|n| n as i64)),
        _ => None,
    }
    .filter(|value| *value > 0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::fs;
    use std::path::PathBuf;
    use std::sync::{Arc, Mutex, OnceLock, RwLock};
    use std::time::{SystemTime, UNIX_EPOCH};

    use crate::virtual_router_engine::routing::parse_routing;
    use crate::virtual_router_engine::routing_state_store::{
        load_provider_health_state, with_session_dir_override,
    };

    static TEST_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

    fn test_guard() -> std::sync::MutexGuard<'static, ()> {
        TEST_LOCK
            .get_or_init(|| Mutex::new(()))
            .lock()
            .expect("provider runtime ingress test lock")
    }

    fn unique_temp() -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!("rcc-provider-runtime-ingress-{unique}"))
    }

    fn build_registered_core(provider_key: &str) -> Arc<RwLock<VirtualRouterEngineCore>> {
        let mut core = VirtualRouterEngineCore::new();
        let providers = json!({
            provider_key: {
                "providerKey": provider_key,
                "providerType": "responses",
                "providerProtocol": "openai-responses",
                "modelId": "gpt-test",
                "enabled": true
            }
        });
        core.provider_registry.load(providers.as_object().unwrap());
        core.health_manager
            .register_providers(&core.provider_registry.list_keys());
        let core = Arc::new(RwLock::new(core));
        register_runtime(&core);
        core
    }

    fn build_registered_core_for_group(
        provider_key: &str,
        routing_policy_group: &str,
    ) -> Arc<RwLock<VirtualRouterEngineCore>> {
        let core = build_registered_core(provider_key);
        {
            let mut guard = core.write().expect("core write lock");
            let routing = json!({
                "thinking": [{
                    "id": "test-thinking",
                    "priority": 100,
                    "targets": [provider_key],
                    "routeParams": {
                        "routePolicyGroup": routing_policy_group
                    }
                }]
            });
            guard.routing = parse_routing(routing.as_object().unwrap());
        }
        core
    }

    fn build_registered_identity_core_for_group(
        provider_key: &str,
        routing_policy_group: &str,
    ) -> Arc<RwLock<VirtualRouterEngineCore>> {
        let core = build_registered_core_for_group(provider_key, routing_policy_group);
        {
            let mut guard = core.write().expect("core write lock");
            guard.routing_policy_group = Some(routing_policy_group.to_string());
        }
        core
    }

    fn build_registered_core_with_untagged_route(
        provider_key: &str,
    ) -> Arc<RwLock<VirtualRouterEngineCore>> {
        let core = build_registered_core(provider_key);
        {
            let mut guard = core.write().expect("core write lock");
            let routing = json!({
                "thinking": [{
                    "id": "test-thinking",
                    "priority": 100,
                    "targets": [provider_key]
                }]
            });
            guard.routing = parse_routing(routing.as_object().unwrap());
        }
        core
    }

    #[test]
    fn normalizes_error_event_defaults() {
        let _guard = test_guard();
        reset_for_tests();
        let out = report_provider_error(&json!({ "code": "HTTP_429", "runtime": null }));
        assert_eq!(out["code"], "HTTP_429");
        assert_eq!(out["message"], "HTTP_429");
        assert_eq!(out["stage"], "unknown");
        assert!(out["runtime"].as_object().unwrap().is_empty());
        assert!(out["timestamp"].as_i64().unwrap() > 0);
    }

    #[test]
    fn normalizes_success_event_defaults() {
        let _guard = test_guard();
        reset_for_tests();
        let out = report_provider_success(&json!({ "metadata": { "source": "unit" } }));
        assert!(out["runtime"].as_object().unwrap().is_empty());
        assert_eq!(out["metadata"]["source"], "unit");
        assert!(out["timestamp"].as_i64().unwrap() > 0);
    }

    #[test]
    fn provider_error_records_once_when_multiple_runtimes_are_registered() {
        let _guard = test_guard();
        reset_for_tests();
        let session_dir = unique_temp();
        fs::create_dir_all(&session_dir).unwrap();
        let provider_key = "primary.key1.gpt-test";
        let _first = build_registered_core(provider_key);
        let _second = build_registered_core(provider_key);

        with_session_dir_override(session_dir.to_str(), || {
            report_provider_error(&json!({
                "code": "HTTP_503",
                "message": "upstream unavailable",
                "stage": "provider.send",
                "status": 503,
                "affectsHealth": true,
                "runtime": {
                    "requestId": "req-one",
                    "providerKey": provider_key,
                    "sessionDir": session_dir
                }
            }));
            let persisted = load_provider_health_state().expect("provider-health persisted");
            let entries = persisted
                .get("providerCooldowns")
                .and_then(|value| value.as_array())
                .expect("providerCooldowns array");
            assert_eq!(entries.len(), 1);
            assert_eq!(
                entries[0]
                    .get("failureCount")
                    .and_then(|value| value.as_i64()),
                Some(1),
                "one logical provider error must record exactly one strike"
            );
        });

        reset_for_tests();
        let _ = fs::remove_dir_all(session_dir);
    }

    #[test]
    fn provider_error_dispatches_to_matching_routing_policy_group_runtime() {
        let _guard = test_guard();
        reset_for_tests();
        let session_dir = unique_temp();
        fs::create_dir_all(&session_dir).unwrap();
        let provider_key = "primary.key1.gpt-test";
        let global = build_registered_core_with_untagged_route(provider_key);
        let group = build_registered_identity_core_for_group(provider_key, "gateway_priority_5555");

        with_session_dir_override(session_dir.to_str(), || {
            report_provider_error(&json!({
                "code": "HTTP_503",
                "message": "upstream unavailable",
                "stage": "provider.send",
                "status": 503,
                "affectsHealth": true,
                "runtime": {
                    "requestId": "req-group",
                    "providerKey": provider_key,
                    "routecodexRoutingPolicyGroup": "gateway_priority_5555",
                    "sessionDir": session_dir
                }
            }));
        });

        let global_state = global
            .read()
            .expect("global read lock")
            .health_manager
            .snapshot()
            .into_iter()
            .find(|entry| entry.provider_key == "primary.1.gpt-test")
            .expect("global health state");
        let group_state = group
            .read()
            .expect("group read lock")
            .health_manager
            .snapshot()
            .into_iter()
            .find(|entry| entry.provider_key == "primary.1.gpt-test")
            .expect("group health state");
        assert_eq!(global_state.failure_count, 0);
        assert_eq!(group_state.failure_count, 1);

        reset_for_tests();
        let _ = fs::remove_dir_all(session_dir);
    }

    #[test]
    fn group_scoped_provider_error_records_once_when_duplicate_group_runtimes_are_registered() {
        let _guard = test_guard();
        reset_for_tests();
        let session_dir = unique_temp();
        fs::create_dir_all(&session_dir).unwrap();
        let provider_key = "primary.key1.gpt-test";
        let first = build_registered_identity_core_for_group(provider_key, "gateway_priority_5555");
        let second = build_registered_identity_core_for_group(provider_key, "gateway_priority_5555");

        with_session_dir_override(session_dir.to_str(), || {
            report_provider_error(&json!({
                "code": "HTTP_503",
                "message": "upstream unavailable",
                "stage": "provider.send",
                "status": 503,
                "affectsHealth": true,
                "runtime": {
                    "requestId": "req-duplicate-group",
                    "providerKey": provider_key,
                    "routecodexRoutingPolicyGroup": "gateway_priority_5555",
                    "sessionDir": session_dir
                }
            }));
            let persisted = load_provider_health_state().expect("provider-health persisted");
            let entries = persisted
                .get("providerCooldowns")
                .and_then(|value| value.as_array())
                .expect("providerCooldowns array");
            assert_eq!(entries.len(), 1);
            assert_eq!(
                entries[0]
                    .get("failureCount")
                    .and_then(|value| value.as_i64()),
                Some(1),
                "one group-scoped provider error must record exactly one strike"
            );
        });

        for core in [first, second] {
            let state = core
                .read()
                .expect("runtime read lock")
                .health_manager
                .snapshot()
                .into_iter()
                .find(|entry| entry.provider_key == "primary.1.gpt-test")
                .expect("runtime health state");
            assert_eq!(
                state.failure_count, 1,
                "each duplicate runtime must mirror the single strike in memory"
            );
        }

        reset_for_tests();
        let _ = fs::remove_dir_all(session_dir);
    }

    #[test]
    fn group_scoped_provider_error_does_not_stop_at_global_runtime() {
        let _guard = test_guard();
        reset_for_tests();
        let session_dir = unique_temp();
        fs::create_dir_all(&session_dir).unwrap();
        let provider_key = "primary.key1.gpt-test";
        let global = build_registered_core_with_untagged_route(provider_key);
        let group = build_registered_identity_core_for_group(provider_key, "gateway_priority_5555");

        with_session_dir_override(session_dir.to_str(), || {
            for index in 1..=3 {
                report_provider_error(&json!({
                    "code": "HTTP_503",
                    "message": format!("upstream unavailable #{index}"),
                    "stage": "provider.send",
                    "status": 503,
                    "affectsHealth": true,
                    "runtime": {
                        "requestId": format!("req-group-{index}"),
                        "providerKey": provider_key,
                        "routecodexRoutingPolicyGroup": "gateway_priority_5555",
                        "sessionDir": session_dir
                    }
                }));
            }
        });

        let global_state = global
            .read()
            .expect("global read lock")
            .health_manager
            .snapshot()
            .into_iter()
            .find(|entry| entry.provider_key == "primary.1.gpt-test")
            .expect("global state");
        let group_state = group
            .read()
            .expect("group read lock")
            .health_manager
            .snapshot()
            .into_iter()
            .find(|entry| entry.provider_key == "primary.1.gpt-test")
            .expect("group state");
        assert_eq!(global_state.state, "healthy");
        assert_eq!(group_state.state, "tripped");

        reset_for_tests();
        let _ = fs::remove_dir_all(session_dir);
    }

    #[test]
    fn runtime_identity_prevents_group_event_from_hitting_merged_runtime() {
        let _guard = test_guard();
        reset_for_tests();
        let session_dir = unique_temp();
        fs::create_dir_all(&session_dir).unwrap();
        let provider_key = "primary.key1.gpt-test";
        let merged_global = build_registered_identity_core_for_group(provider_key, "gateway_other");
        let group = build_registered_identity_core_for_group(provider_key, "gateway_priority_5555");

        with_session_dir_override(session_dir.to_str(), || {
            report_provider_error(&json!({
                "code": "HTTP_503",
                "message": "upstream unavailable",
                "stage": "provider.send",
                "status": 503,
                "affectsHealth": true,
                "runtime": {
                    "requestId": "req-group-identity",
                    "providerKey": provider_key,
                    "routecodexRoutingPolicyGroup": "gateway_priority_5555",
                    "sessionDir": session_dir
                }
            }));
        });

        let global_state = merged_global
            .read()
            .expect("global read lock")
            .health_manager
            .snapshot()
            .into_iter()
            .find(|entry| entry.provider_key == "primary.1.gpt-test")
            .expect("global state");
        let group_state = group
            .read()
            .expect("group read lock")
            .health_manager
            .snapshot()
            .into_iter()
            .find(|entry| entry.provider_key == "primary.1.gpt-test")
            .expect("group state");
        assert_eq!(global_state.failure_count, 0);
        assert_eq!(group_state.failure_count, 1);

        reset_for_tests();
        let _ = fs::remove_dir_all(session_dir);
    }

    #[test]
    fn route_params_do_not_replace_runtime_identity_for_group_events() {
        let _guard = test_guard();
        reset_for_tests();
        let session_dir = unique_temp();
        fs::create_dir_all(&session_dir).unwrap();
        let provider_key = "primary.key1.gpt-test";
        let route_tagged = build_registered_core_for_group(provider_key, "gateway_priority_5555");

        with_session_dir_override(session_dir.to_str(), || {
            report_provider_error(&json!({
                "code": "HTTP_503",
                "message": "upstream unavailable",
                "stage": "provider.send",
                "status": 503,
                "affectsHealth": true,
                "runtime": {
                    "requestId": "req-group-route-params-only",
                    "providerKey": provider_key,
                    "routecodexRoutingPolicyGroup": "gateway_priority_5555",
                    "sessionDir": session_dir
                }
            }));
        });

        let route_tagged_state = route_tagged
            .read()
            .expect("route tagged read lock")
            .health_manager
            .snapshot()
            .into_iter()
            .find(|entry| entry.provider_key == "primary.1.gpt-test")
            .expect("route tagged state");
        assert_eq!(route_tagged_state.failure_count, 0);

        reset_for_tests();
        let _ = fs::remove_dir_all(session_dir);
    }
}
