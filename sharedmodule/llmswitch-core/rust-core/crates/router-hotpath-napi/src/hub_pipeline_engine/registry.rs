use napi::bindgen_prelude::Result as NapiResult;
use napi_derive::napi;
use std::collections::HashMap;
use std::sync::Mutex;

use crate::hub_pipeline_lib::engine::HubPipelineEngine;
use crate::hub_pipeline_lib::types::HubPipelineConfig;

static ENGINE_REGISTRY: std::sync::LazyLock<Mutex<HashMap<String, HubPipelineEngine>>> =
    std::sync::LazyLock::new(|| Mutex::new(HashMap::new()));

fn next_handle_id() -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(1);
    format!("hp_{}", COUNTER.fetch_add(1, Ordering::Relaxed))
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
    let response = serde_json::json!({
        "requestId": output.request_id,
        "success": output.success,
        "payload": result.get("payload"),
        "metadata": result.get("metadata"),
        "standardizedRequest": result.get("standardized_request"),
        "entryOriginRequest": result.get("entry_origin_request"),
        "effectPlan": result.get("effect_plan"),
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
