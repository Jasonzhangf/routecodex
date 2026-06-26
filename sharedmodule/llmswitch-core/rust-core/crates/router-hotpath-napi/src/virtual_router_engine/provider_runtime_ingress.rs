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

    for core in cores {
        if let Ok(mut guard) = core.write() {
            match kind {
                RuntimeEventKind::Error => guard.handle_provider_error(event),
                RuntimeEventKind::Success => guard.handle_provider_success(event),
            }
        }
    }
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
        "cooldownOverrideMs",
        event.get("cooldownOverrideMs"),
    );
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

    #[test]
    fn normalizes_error_event_defaults() {
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
        reset_for_tests();
        let out = report_provider_success(&json!({ "metadata": { "source": "unit" } }));
        assert!(out["runtime"].as_object().unwrap().is_empty());
        assert_eq!(out["metadata"]["source"], "unit");
        assert!(out["timestamp"].as_i64().unwrap() > 0);
    }
}
