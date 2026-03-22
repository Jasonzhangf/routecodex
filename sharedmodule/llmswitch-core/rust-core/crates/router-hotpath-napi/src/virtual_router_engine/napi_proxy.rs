use napi::bindgen_prelude::Result as NapiResult;
use napi::{Env, JsFunction, JsObject, JsUnknown, Ref, ValueType};
use napi_derive::napi;
use serde_json::Value;
use std::sync::{Arc, Mutex};

use super::engine::VirtualRouterEngineCore;
use super::instructions::with_rcc_user_dir_override;
use super::routing_state_store::with_session_dir_override;

struct RuntimePathOverrides {
    rcc_user_dir: Option<String>,
    session_dir: Option<String>,
}

#[napi]
pub struct VirtualRouterEngineProxy {
    core: Arc<Mutex<VirtualRouterEngineCore>>,
    session_alias_map_ref: Ref<()>,
}

#[napi]
impl VirtualRouterEngineProxy {
    #[napi(constructor)]
    pub fn new(env: Env, _engine: Option<JsObject>) -> Self {
        let global = env.get_global().expect("global");
        let map_ctor: JsFunction = global.get_named_property("Map").expect("Map ctor");
        let map_obj = map_ctor
            .new_instance::<JsUnknown>(&[])
            .expect("Map instance");
        let map_ref = env.create_reference(map_obj).expect("Map ref");
        Self {
            core: Arc::new(Mutex::new(VirtualRouterEngineCore::new())),
            session_alias_map_ref: map_ref,
        }
    }

    #[napi]
    pub fn initialize(&self, _env: Env, config_json: String) -> NapiResult<()> {
        let config_value: Value = serde_json::from_str(&config_json)
            .map_err(|e| napi::Error::from_reason(e.to_string()))?;
        let mut core = self.core.lock().expect("core lock");
        core.initialize(&config_value)
            .map_err(|e| napi::Error::from_reason(e))?;
        Ok(())
    }

    #[napi]
    pub fn update_deps(&self, env: Env, deps: JsUnknown) -> NapiResult<()> {
        if is_js_null_or_undefined(&deps) {
            let mut core = self.core.lock().expect("core lock");
            core.update_quota_view(None);
            return Ok(());
        }
        let obj = deps.coerce_to_object()?;
        let quota_view_value: JsUnknown = obj.get_named_property("quotaView")?;
        let mut core = self.core.lock().expect("core lock");
        if matches!(quota_view_value.get_type(), Ok(ValueType::Null)) {
            core.update_quota_view(None);
            return Ok(());
        }
        if matches!(quota_view_value.get_type(), Ok(ValueType::Undefined)) {
            return Ok(());
        }
        if matches!(quota_view_value.get_type(), Ok(ValueType::Function)) {
            let reference = env.create_reference(quota_view_value)?;
            core.update_quota_view(Some(reference));
        }
        Ok(())
    }

    #[napi]
    pub fn update_virtual_router_config(&self, _env: Env, config_json: String) -> NapiResult<()> {
        let config_value: Value = serde_json::from_str(&config_json)
            .map_err(|e| napi::Error::from_reason(e.to_string()))?;
        let mut core = self.core.lock().expect("core lock");
        core.initialize(&config_value)
            .map_err(|e| napi::Error::from_reason(e))?;
        Ok(())
    }

    #[napi]
    pub fn route(
        &self,
        env: Env,
        request_json: String,
        metadata_json: String,
    ) -> NapiResult<String> {
        let request_value: Value = serde_json::from_str(&request_json)
            .map_err(|e| napi::Error::from_reason(e.to_string()))?;
        let metadata_value: Value = serde_json::from_str(&metadata_json)
            .map_err(|e| napi::Error::from_reason(e.to_string()))?;
        let overrides = resolve_runtime_path_overrides(&metadata_value);
        let mut core = self.core.lock().expect("core lock");
        let result = with_rcc_user_dir_override(overrides.rcc_user_dir.as_deref(), || {
            with_session_dir_override(overrides.session_dir.as_deref(), || {
                core.route(env, &request_value, &metadata_value)
            })
        })
        .map_err(|e| napi::Error::from_reason(e))?;
        self.sync_antigravity_map(env, &core)?;
        serde_json::to_string(&result).map_err(|e| napi::Error::from_reason(e.to_string()))
    }

    #[napi]
    pub fn get_stop_message_state(&self, _env: Env, metadata_json: String) -> NapiResult<String> {
        let metadata_value: Value = serde_json::from_str(&metadata_json)
            .map_err(|e| napi::Error::from_reason(e.to_string()))?;
        let overrides = resolve_runtime_path_overrides(&metadata_value);
        let mut core = self.core.lock().expect("core lock");
        let result = with_rcc_user_dir_override(overrides.rcc_user_dir.as_deref(), || {
            with_session_dir_override(overrides.session_dir.as_deref(), || {
                core.get_stop_message_state(&metadata_value)
            })
        });
        serde_json::to_string(&result).map_err(|e| napi::Error::from_reason(e.to_string()))
    }

    #[napi]
    pub fn get_pre_command_state(&self, _env: Env, metadata_json: String) -> NapiResult<String> {
        let metadata_value: Value = serde_json::from_str(&metadata_json)
            .map_err(|e| napi::Error::from_reason(e.to_string()))?;
        let overrides = resolve_runtime_path_overrides(&metadata_value);
        let mut core = self.core.lock().expect("core lock");
        let result = with_rcc_user_dir_override(overrides.rcc_user_dir.as_deref(), || {
            with_session_dir_override(overrides.session_dir.as_deref(), || {
                core.get_pre_command_state(&metadata_value)
            })
        });
        serde_json::to_string(&result).map_err(|e| napi::Error::from_reason(e.to_string()))
    }

    #[napi]
    pub fn handle_provider_failure(&self, _env: Env, event_json: String) -> NapiResult<()> {
        let event_value: Value = serde_json::from_str(&event_json)
            .map_err(|e| napi::Error::from_reason(e.to_string()))?;
        let mut core = self.core.lock().expect("core lock");
        core.handle_provider_failure(&event_value);
        Ok(())
    }

    #[napi]
    pub fn handle_provider_error(&self, _env: Env, event_json: String) -> NapiResult<()> {
        let event_value: Value = serde_json::from_str(&event_json)
            .map_err(|e| napi::Error::from_reason(e.to_string()))?;
        let mut core = self.core.lock().expect("core lock");
        core.handle_provider_error(&event_value);
        Ok(())
    }

    #[napi]
    pub fn handle_provider_success(&self, env: Env, event_json: String) -> NapiResult<()> {
        let event_value: Value = serde_json::from_str(&event_json)
            .map_err(|e| napi::Error::from_reason(e.to_string()))?;
        let mut core = self.core.lock().expect("core lock");
        core.handle_provider_success(&event_value);
        self.sync_antigravity_map(env, &core)?;
        Ok(())
    }

    #[napi]
    pub fn get_status(&self, _env: Env) -> NapiResult<String> {
        let core = self.core.lock().expect("core lock");
        serde_json::to_string(&core.get_status())
            .map_err(|e| napi::Error::from_reason(e.to_string()))
    }

    #[napi(getter)]
    pub fn antigravity_session_alias_store(&self, env: Env) -> NapiResult<JsObject> {
        let core = self.core.lock().expect("core lock");
        self.sync_antigravity_map(env, &core)?;
        env.get_reference_value(&self.session_alias_map_ref)
    }

    #[napi]
    pub fn mark_provider_cooldown(
        &self,
        provider_key: String,
        cooldown_ms: Option<i64>,
    ) -> NapiResult<()> {
        let mut core = self.core.lock().expect("core lock");
        core.health_manager.cooldown_provider(
            &provider_key,
            None,
            cooldown_ms,
            super::time_utils::now_ms(),
        );
        Ok(())
    }

    #[napi]
    pub fn clear_provider_cooldown(&self, provider_key: String) -> NapiResult<()> {
        let mut core = self.core.lock().expect("core lock");
        core.health_manager.record_success(&provider_key);
        Ok(())
    }
}

fn resolve_runtime_path_overrides(metadata: &Value) -> RuntimePathOverrides {
    RuntimePathOverrides {
        rcc_user_dir: read_runtime_string(metadata, &["rccUserDir", "rcc_user_dir"]),
        session_dir: read_runtime_string(metadata, &["sessionDir", "session_dir"]),
    }
}

fn read_runtime_string(metadata: &Value, keys: &[&str]) -> Option<String> {
    let rt = metadata.get("__rt");
    for key in keys {
        if let Some(value) = rt
            .and_then(|entry| entry.get(*key))
            .and_then(|entry| entry.as_str())
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            return Some(value.to_string());
        }
        if let Some(value) = metadata
            .get(*key)
            .and_then(|entry| entry.as_str())
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            return Some(value.to_string());
        }
    }
    None
}

fn is_js_null_or_undefined(value: &JsUnknown) -> bool {
    match value.get_type() {
        Ok(ValueType::Null) | Ok(ValueType::Undefined) => true,
        _ => false,
    }
}

impl VirtualRouterEngineProxy {
    fn sync_antigravity_map(&self, env: Env, core: &VirtualRouterEngineCore) -> NapiResult<()> {
        let map_obj: JsObject = env.get_reference_value(&self.session_alias_map_ref)?;
        let clear_fn: JsFunction = map_obj.get_named_property("clear")?;
        let _ = clear_fn.call::<JsUnknown>(Some(&map_obj), &[])?;
        let set_fn: JsFunction = map_obj.get_named_property("set")?;
        for (key, value) in core.antigravity_session_alias_store.iter() {
            let k = env.create_string(key)?;
            let v = env.create_string(value)?;
            let _ = set_fn.call(Some(&map_obj), &[k.into_unknown(), v.into_unknown()])?;
        }
        Ok(())
    }
}
