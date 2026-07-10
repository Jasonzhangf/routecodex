use napi::bindgen_prelude::Result as NapiResult;
use napi_derive::napi;
use std::collections::HashMap;
use std::sync::Mutex;

use crate::hub_pipeline_lib::engine::HubPipelineEngine;
use crate::hub_pipeline_lib::types::HubPipelineConfig;
use serde_json::Value;

// feature_id: hub.runtime_ingress_bridge
static ENGINE_REGISTRY: std::sync::LazyLock<Mutex<HashMap<String, HubPipelineEngine>>> =
    std::sync::LazyLock::new(|| Mutex::new(HashMap::new()));

fn next_handle_id() -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(1);
    format!("hp_{}", COUNTER.fetch_add(1, Ordering::Relaxed))
}

pub(crate) fn dispatch_provider_error_to_registered_engines(event: &Value) {
    dispatch_provider_runtime_event_to_registered_engines(event, true);
}

pub(crate) fn dispatch_provider_success_to_registered_engines(event: &Value) {
    dispatch_provider_runtime_event_to_registered_engines(event, false);
}

fn dispatch_provider_runtime_event_to_registered_engines(event: &Value, is_error: bool) {
    let Some(provider_key) =
        crate::virtual_router_engine::provider_runtime_ingress::resolve_event_provider_key(event)
    else {
        return;
    };
    let routing_policy_group =
        crate::virtual_router_engine::provider_runtime_ingress::resolve_event_routing_policy_group(
            event,
        );
    let Ok(mut reg) = ENGINE_REGISTRY.lock() else {
        return;
    };
    for engine in reg.values_mut() {
        let owns_event = if let Some(group) = routing_policy_group.as_deref() {
            engine.owns_provider_runtime_event_for_group(&provider_key, group)
        } else {
            engine.owns_provider_runtime_event(&provider_key)
        };
        if !owns_event {
            continue;
        }
        if is_error {
            engine.handle_provider_runtime_error(event);
        } else {
            engine.handle_provider_runtime_success(event);
        }
    }
}

#[napi(js_name = "createHubPipelineEngineJson")]
pub fn create_hub_pipeline_engine_json(input_json: String) -> NapiResult<String> {
    let input: serde_json::Value = serde_json::from_str(&input_json)
        .map_err(|e| napi::Error::from_reason(format!("Invalid input: {}", e)))?;
    let config: HubPipelineConfig = serde_json::from_value(input)
        .map_err(|e| napi::Error::from_reason(format!("Invalid config: {}", e)))?;
    let engine = HubPipelineEngine::new(config).map_err(|e| {
        napi::Error::from_reason(format!("Engine init failed: {}: {}", e.code, e.message))
    })?;
    let handle = next_handle_id();
    let mut reg = ENGINE_REGISTRY
        .lock()
        .map_err(|e| napi::Error::from_reason(format!("Lock error: {}", e)))?;
    reg.insert(handle.clone(), engine);
    serde_json::to_string(&serde_json::json!({ "handle": handle }))
        .map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi(js_name = "hubPipelineExecuteJson")]
pub fn hub_pipeline_execute_json(handle: String, request_json: String) -> NapiResult<String> {
    let mut reg = ENGINE_REGISTRY
        .lock()
        .map_err(|e| napi::Error::from_reason(format!("Lock error: {}", e)))?;
    let engine = reg.get_mut(&handle).ok_or_else(|| {
        napi::Error::from_reason(format!("HubPipeline handle not found: {}", handle))
    })?;
    let request: crate::hub_pipeline_lib::types::HubPipelineRequest =
        serde_json::from_str(&request_json)
            .map_err(|e| napi::Error::from_reason(format!("Invalid request: {}", e)))?;
    let output = engine
        .execute(request)
        .map_err(|e| napi::Error::from_reason(format!("{}: {}", e.code, e.message)))?;
    let result =
        serde_json::to_value(&output).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let payload = result
        .get("payload")
        .cloned()
        .unwrap_or(serde_json::Value::Null);
    let metadata = result
        .get("metadata")
        .cloned()
        .unwrap_or(serde_json::Value::Null);
    let target = metadata
        .get("target")
        .cloned()
        .unwrap_or(serde_json::Value::Null);
    let routing_decision = metadata
        .get("routingDecision")
        .cloned()
        .unwrap_or(serde_json::Value::Null);
    let routing_diagnostics = metadata
        .get("routingDiagnostics")
        .cloned()
        .unwrap_or(serde_json::Value::Null);
    let response = serde_json::json!({
        "requestId": output.request_id,
        "success": output.success,
        "payload": payload,
        "providerPayload": payload,
        "metadata": metadata,
        "target": target,
        "routingDecision": routing_decision,
        "routingDiagnostics": routing_diagnostics,
        "standardizedRequest": result.get("standardizedRequest"),
        "entryOriginRequest": result.get("entryOriginRequest"),
        "effectPlan": result.get("effectPlan"),
        "diagnostics": result.get("diagnostics"),
        "error": result.get("error"),
    });
    serde_json::to_string(&response).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi(js_name = "disposeHubPipelineEngineJson")]
pub fn dispose_hub_pipeline_engine_json(handle: String) -> NapiResult<()> {
    let mut reg = ENGINE_REGISTRY
        .lock()
        .map_err(|e| napi::Error::from_reason(format!("Lock error: {}", e)))?;
    reg.remove(&handle);
    Ok(())
}

#[napi(js_name = "updateHubPipelineVirtualRouterConfigJson")]
pub fn update_hub_pipeline_virtual_router_config_json(
    handle: String,
    config_json: String,
) -> NapiResult<()> {
    let mut reg = ENGINE_REGISTRY
        .lock()
        .map_err(|e| napi::Error::from_reason(format!("Lock error: {}", e)))?;
    let engine = reg.get_mut(&handle).ok_or_else(|| {
        napi::Error::from_reason(format!("HubPipeline handle not found: {}", handle))
    })?;
    let config_value: serde_json::Value = serde_json::from_str(&config_json)
        .map_err(|e| napi::Error::from_reason(format!("Invalid config: {}", e)))?;
    engine
        .update_virtual_router_config(config_value)
        .map_err(|e| napi::Error::from_reason(format!("{}: {}", e.code, e.message)))
}

#[napi(js_name = "updateHubPipelineEngineDepsJson")]
pub fn update_hub_pipeline_engine_deps_json(handle: String, deps_json: String) -> NapiResult<()> {
    let mut reg = ENGINE_REGISTRY
        .lock()
        .map_err(|e| napi::Error::from_reason(format!("Lock error: {}", e)))?;
    let engine = reg.get_mut(&handle).ok_or_else(|| {
        napi::Error::from_reason(format!("HubPipeline handle not found: {}", handle))
    })?;
    let deps_value: serde_json::Value = serde_json::from_str(&deps_json)
        .map_err(|e| napi::Error::from_reason(format!("Invalid deps: {}", e)))?;
    engine
        .update_runtime_deps(deps_value)
        .map_err(|e| napi::Error::from_reason(format!("{}: {}", e.code, e.message)))
}

#[napi(js_name = "hubPipelineVirtualRouterRouteJson")]
pub fn hub_pipeline_virtual_router_route_json(
    handle: String,
    request_json: String,
    metadata_json: String,
) -> NapiResult<String> {
    let mut reg = ENGINE_REGISTRY
        .lock()
        .map_err(|e| napi::Error::from_reason(format!("Lock error: {}", e)))?;
    let engine = reg.get_mut(&handle).ok_or_else(|| {
        napi::Error::from_reason(format!("HubPipeline handle not found: {}", handle))
    })?;
    let request_value: serde_json::Value = serde_json::from_str(&request_json)
        .map_err(|e| napi::Error::from_reason(format!("Invalid request: {}", e)))?;
    let metadata_value: serde_json::Value = serde_json::from_str(&metadata_json)
        .map_err(|e| napi::Error::from_reason(format!("Invalid metadata: {}", e)))?;
    let result = engine
        .route_virtual_router(request_value, metadata_value)
        .map_err(|e| napi::Error::from_reason(format!("{}: {}", e.code, e.message)))?;
    serde_json::to_string(&result).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi(js_name = "hubPipelineVirtualRouterDiagnoseRouteJson")]
pub fn hub_pipeline_virtual_router_diagnose_route_json(
    handle: String,
    request_json: String,
    metadata_json: String,
) -> NapiResult<String> {
    let mut reg = ENGINE_REGISTRY
        .lock()
        .map_err(|e| napi::Error::from_reason(format!("Lock error: {}", e)))?;
    let engine = reg.get_mut(&handle).ok_or_else(|| {
        napi::Error::from_reason(format!("HubPipeline handle not found: {}", handle))
    })?;
    let request_value: serde_json::Value = serde_json::from_str(&request_json)
        .map_err(|e| napi::Error::from_reason(format!("Invalid request: {}", e)))?;
    let metadata_value: serde_json::Value = serde_json::from_str(&metadata_json)
        .map_err(|e| napi::Error::from_reason(format!("Invalid metadata: {}", e)))?;
    let result = engine
        .diagnose_virtual_router(request_value, metadata_value)
        .map_err(|e| napi::Error::from_reason(format!("{}: {}", e.code, e.message)))?;
    serde_json::to_string(&result).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi(js_name = "hubPipelineVirtualRouterStatusJson")]
pub fn hub_pipeline_virtual_router_status_json(handle: String) -> NapiResult<String> {
    let mut reg = ENGINE_REGISTRY
        .lock()
        .map_err(|e| napi::Error::from_reason(format!("Lock error: {}", e)))?;
    let engine = reg.get_mut(&handle).ok_or_else(|| {
        napi::Error::from_reason(format!("HubPipeline handle not found: {}", handle))
    })?;
    let result = engine
        .virtual_router_status()
        .map_err(|e| napi::Error::from_reason(format!("{}: {}", e.code, e.message)))?;
    serde_json::to_string(&result).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi(js_name = "hubPipelineVirtualRouterMarkConcurrencyScopeBusyJson")]
pub fn hub_pipeline_virtual_router_mark_concurrency_scope_busy_json(
    handle: String,
    scope_key: String,
) -> NapiResult<()> {
    let mut reg = ENGINE_REGISTRY
        .lock()
        .map_err(|e| napi::Error::from_reason(format!("Lock error: {}", e)))?;
    let engine = reg.get_mut(&handle).ok_or_else(|| {
        napi::Error::from_reason(format!("HubPipeline handle not found: {}", handle))
    })?;
    engine
        .mark_virtual_router_concurrency_scope_busy(&scope_key)
        .map_err(|e| napi::Error::from_reason(format!("{}: {}", e.code, e.message)))
}

#[napi(js_name = "hubPipelineVirtualRouterMarkConcurrencyScopeIdleJson")]
pub fn hub_pipeline_virtual_router_mark_concurrency_scope_idle_json(
    handle: String,
    scope_key: String,
) -> NapiResult<()> {
    let mut reg = ENGINE_REGISTRY
        .lock()
        .map_err(|e| napi::Error::from_reason(format!("Lock error: {}", e)))?;
    let engine = reg.get_mut(&handle).ok_or_else(|| {
        napi::Error::from_reason(format!("HubPipeline handle not found: {}", handle))
    })?;
    engine
        .mark_virtual_router_concurrency_scope_idle(&scope_key)
        .map_err(|e| napi::Error::from_reason(format!("{}: {}", e.code, e.message)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn create_test_engine_handle(routing_policy_group: &str) -> String {
        let created: Value = serde_json::from_str(
            &create_hub_pipeline_engine_json(
                json!({
                    "virtualRouter": {
                        "routingPolicyGroup": routing_policy_group,
                        "providers": {
                            "primary.key1.gpt-5.5": {
                                "providerKey": "primary.key1.gpt-5.5",
                                "providerType": "responses",
                                "providerProtocol": "openai-responses",
                                "runtimeKey": "primary.key1",
                                "modelId": "gpt-5.5",
                                "enabled": true,
                                "outboundProfile": "openai-responses",
                                "endpoint": "mock://primary",
                                "auth": { "type": "apikey", "apiKey": "primary-key" }
                            },
                            "backup.key1.gpt-5.5": {
                                "providerKey": "backup.key1.gpt-5.5",
                                "providerType": "responses",
                                "providerProtocol": "openai-responses",
                                "runtimeKey": "backup.key1",
                                "modelId": "gpt-5.5",
                                "enabled": true,
                                "outboundProfile": "openai-responses",
                                "endpoint": "mock://backup",
                                "auth": { "type": "apikey", "apiKey": "backup-key" }
                            }
                        },
                        "routing": {
                            "thinking": [{
                                "id": "thinking-priority",
                                "priority": 100,
                                "mode": "priority",
                                "targets": ["primary.key1.gpt-5.5", "backup.key1.gpt-5.5"]
                            }],
                            "default": [{
                                "id": "default-priority",
                                "priority": 100,
                                "mode": "priority",
                                "targets": ["primary.key1.gpt-5.5", "backup.key1.gpt-5.5"]
                            }]
                        },
                        "health": {
                            "failureThreshold": 3,
                            "cooldownMs": 30000
                        }
                    }
                })
                .to_string(),
            )
            .expect("create hub pipeline engine"),
        )
        .expect("create output json");
        created
            .get("handle")
            .and_then(Value::as_str)
            .expect("handle")
            .to_string()
    }

    fn read_primary_health_state(handle: &str) -> Value {
        let status: Value = serde_json::from_str(
            &hub_pipeline_virtual_router_status_json(handle.to_string()).unwrap(),
        )
        .expect("status json");
        status
            .get("health")
            .and_then(Value::as_array)
            .and_then(|entries| {
                entries.iter().find(|entry| {
                    entry
                        .get("providerKey")
                        .or_else(|| entry.get("provider_key"))
                        .and_then(Value::as_str)
                        .is_some_and(|key| key == "primary.1.gpt-5.5")
                })
            })
            .cloned()
            .expect("primary health state")
    }

    #[test]
    fn provider_runtime_ingress_mutates_hub_pipeline_handle_virtual_router_health() {
        let routing_policy_group = "gateway_priority_handle_test";
        let handle = create_test_engine_handle(routing_policy_group);
        for index in 1..=3 {
            crate::virtual_router_engine::provider_runtime_ingress::report_provider_error(&json!({
                "code": "HTTP_502",
                "message": format!("primary unavailable #{index}"),
                "stage": "provider.send",
                "status": 502,
                "affectsHealth": true,
                "runtime": {
                    "requestId": format!("req-handle-runtime-health-{index}"),
                    "providerKey": "primary.key1.gpt-5.5",
                    "routecodexRoutingPolicyGroup": routing_policy_group
                }
            }));
            crate::virtual_router_engine::provider_runtime_ingress::report_provider_success(
                &json!({
                    "runtime": {
                        "requestId": format!("req-handle-backup-success-{index}"),
                        "providerKey": "backup.key1.gpt-5.5",
                        "runtimeKey": "primary.key1",
                        "routecodexRoutingPolicyGroup": routing_policy_group
                    }
                }),
            );
        }

        let state = read_primary_health_state(&handle);
        assert_eq!(state.get("state").and_then(Value::as_str), Some("tripped"));
        assert_eq!(state.get("failureCount").and_then(Value::as_i64), Some(3));

        dispose_hub_pipeline_engine_json(handle).expect("dispose handle");
    }
}
