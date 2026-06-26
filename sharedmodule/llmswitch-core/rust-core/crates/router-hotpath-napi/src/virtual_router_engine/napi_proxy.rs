use napi::bindgen_prelude::Result as NapiResult;
use napi::{Env, JsObject, JsUnknown, ValueType};
use napi_derive::napi;
use serde_json::Value;
use std::sync::{Arc, RwLock};

use super::engine::VirtualRouterEngineCore;
use super::instructions::with_rcc_user_dir_override;
use super::routing_state_store::with_session_dir_override;

struct RuntimePathOverrides {
    rcc_user_dir: Option<String>,
    session_dir: Option<String>,
}

#[napi]
pub struct VirtualRouterEngineProxy {
    core: Arc<RwLock<VirtualRouterEngineCore>>,
}

#[napi]
impl VirtualRouterEngineProxy {
    #[napi(constructor)]
    pub fn new(env: Env, _engine: Option<JsObject>) -> Self {
        let _ = env;
        Self {
            core: Arc::new(RwLock::new(VirtualRouterEngineCore::new())),
        }
    }

    #[napi]
    pub fn initialize(&self, _env: Env, config_json: String) -> NapiResult<()> {
        let config_value: Value = serde_json::from_str(&config_json)
            .map_err(|e| napi::Error::from_reason(e.to_string()))?;
        let mut core = self.core.write().expect("core write lock");
        core.initialize(&config_value)
            .map_err(|e| napi::Error::from_reason(e))?;
        Ok(())
    }

    #[napi]
    pub fn update_deps(&self, env: Env, deps: JsUnknown) -> NapiResult<()> {
        if is_js_null_or_undefined(&deps) {
            return Ok(());
        }
        let _ = env;
        let _ = deps.coerce_to_object()?;
        Ok(())
    }

    #[napi]
    pub fn update_virtual_router_config(&self, _env: Env, config_json: String) -> NapiResult<()> {
        let config_value: Value = serde_json::from_str(&config_json)
            .map_err(|e| napi::Error::from_reason(e.to_string()))?;
        let mut core = self.core.write().expect("core write lock");
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
        let mut core = self.core.write().expect("core write lock");
        let result = with_rcc_user_dir_override(overrides.rcc_user_dir.as_deref(), || {
            with_session_dir_override(overrides.session_dir.as_deref(), || {
                core.route(env, &request_value, &metadata_value)
            })
        })
        .map_err(|e| napi::Error::from_reason(e))?;
        serde_json::to_string(&result).map_err(|e| napi::Error::from_reason(e.to_string()))
    }

    #[napi]
    pub fn get_stop_message_state(&self, _env: Env, metadata_json: String) -> NapiResult<String> {
        let metadata_value: Value = serde_json::from_str(&metadata_json)
            .map_err(|e| napi::Error::from_reason(e.to_string()))?;
        let overrides = resolve_runtime_path_overrides(&metadata_value);
        let mut core = self.core.write().expect("core write lock");
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
        let mut core = self.core.write().expect("core write lock");
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
        let overrides = resolve_runtime_path_overrides(&event_value);
        let mut core = self.core.write().expect("core write lock");
        with_rcc_user_dir_override(overrides.rcc_user_dir.as_deref(), || {
            with_session_dir_override(overrides.session_dir.as_deref(), || {
                core.handle_provider_failure(&event_value);
            })
        });
        Ok(())
    }

    #[napi]
    pub fn handle_provider_error(&self, _env: Env, event_json: String) -> NapiResult<()> {
        let event_value: Value = serde_json::from_str(&event_json)
            .map_err(|e| napi::Error::from_reason(e.to_string()))?;
        let overrides = resolve_runtime_path_overrides(&event_value);
        let mut core = self.core.write().expect("core write lock");
        with_rcc_user_dir_override(overrides.rcc_user_dir.as_deref(), || {
            with_session_dir_override(overrides.session_dir.as_deref(), || {
                core.handle_provider_error(&event_value);
            })
        });
        Ok(())
    }

    #[napi]
    pub fn handle_provider_success(&self, _env: Env, event_json: String) -> NapiResult<()> {
        let event_value: Value = serde_json::from_str(&event_json)
            .map_err(|e| napi::Error::from_reason(e.to_string()))?;
        let overrides = resolve_runtime_path_overrides(&event_value);
        let mut core = self.core.write().expect("core write lock");
        with_rcc_user_dir_override(overrides.rcc_user_dir.as_deref(), || {
            with_session_dir_override(overrides.session_dir.as_deref(), || {
                core.handle_provider_success(&event_value);
            })
        });
        Ok(())
    }

    #[napi]
    pub fn get_status(&self, _env: Env) -> NapiResult<String> {
        let core = self.core.read().expect("core read lock");
        serde_json::to_string(&core.get_status())
            .map_err(|e| napi::Error::from_reason(e.to_string()))
    }

    #[napi]
    pub fn mark_provider_cooldown(
        &self,
        provider_key: String,
        cooldown_ms: Option<i64>,
    ) -> NapiResult<()> {
        let mut core = self.core.write().expect("core write lock");
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
        let mut core = self.core.write().expect("core write lock");
        core.health_manager.record_success(&provider_key);
        Ok(())
    }

    #[napi]
    pub fn mark_concurrency_scope_busy(&self, scope_key: String) -> NapiResult<()> {
        let mut core = self.core.write().expect("core write lock");
        core.mark_concurrency_scope_busy(&scope_key);
        Ok(())
    }

    #[napi]
    pub fn mark_concurrency_scope_idle(&self, scope_key: String) -> NapiResult<()> {
        let mut core = self.core.write().expect("core write lock");
        core.mark_concurrency_scope_idle(&scope_key);
        Ok(())
    }

    #[napi]
    pub fn register_provider_runtime_ingress(&self) -> NapiResult<()> {
        super::provider_runtime_ingress::register_runtime(&self.core);
        Ok(())
    }

    #[napi]
    pub fn unregister_provider_runtime_ingress(&self) -> NapiResult<()> {
        super::provider_runtime_ingress::unregister_runtime(&self.core);
        Ok(())
    }
}

fn resolve_runtime_path_overrides(metadata: &Value) -> RuntimePathOverrides {
    let rt = metadata.get("__rt");
    let runtime_path_overrides_read_only_from_rt_namespace = rt.and_then(|value| value.as_object());
    let runtime_path_overrides_do_not_fallback_to_top_level_metadata =
        runtime_path_overrides_read_only_from_rt_namespace;
    RuntimePathOverrides {
        rcc_user_dir: runtime_path_overrides_do_not_fallback_to_top_level_metadata
            .and_then(|metadata| read_runtime_string(metadata, &["rccUserDir", "rcc_user_dir"])),
        session_dir: runtime_path_overrides_do_not_fallback_to_top_level_metadata
            .and_then(|metadata| read_runtime_string(metadata, &["sessionDir", "session_dir"])),
    }
}

fn read_runtime_string(
    metadata: &serde_json::Map<String, Value>,
    keys: &[&str],
) -> Option<String> {
    for key in keys {
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

impl VirtualRouterEngineProxy {}

#[cfg(test)]
mod tests {
    use super::resolve_runtime_path_overrides;
    use serde_json::json;

    #[test]
    fn runtime_path_overrides_read_only_from_metadata_center_snapshot_runtime_control() {
        let metadata = json!({
            "metadataCenterSnapshot": {
                "runtimeControl": {
                    "sessionDir": "/tmp/rt-session",
                    "rccUserDir": "/tmp/rt-rcc"
                }
            }
        });
        let overrides = resolve_runtime_path_overrides(&metadata);
        assert_eq!(overrides.session_dir.as_deref(), Some("/tmp/rt-session"));
        assert_eq!(overrides.rcc_user_dir.as_deref(), Some("/tmp/rt-rcc"));
    }

    #[test]
    fn runtime_path_overrides_do_not_fallback_to_top_level_metadata_or_rt_namespace() {
        let metadata = json!({
            "sessionDir": "/tmp/top-level-session",
            "rccUserDir": "/tmp/top-level-rcc",
            "__rt": {
                "sessionDir": "/tmp/rt-session",
                "rccUserDir": "/tmp/rt-rcc"
            }
        });
        let overrides = resolve_runtime_path_overrides(&metadata);
        assert_eq!(overrides.session_dir, None);
        assert_eq!(overrides.rcc_user_dir, None);
        let snapshot_runtime_control = metadata
            .get("metadataCenterSnapshot")
            .and_then(|snapshot| snapshot.as_object())
            .and_then(|snapshot| snapshot.get("runtimeControl"))
            .and_then(|runtime_control| runtime_control.as_object());
        assert!(snapshot_runtime_control.is_none());
    }
}
