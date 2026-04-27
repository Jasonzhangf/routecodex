use napi::bindgen_prelude::Result as NapiResult;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

fn enforce_chat_budget(chat: &Value, allowed: usize, sys_limit: usize) -> Value {
    let _ = allowed;
    let _ = sys_limit;
    chat.clone()
}

#[napi_derive::napi]
pub fn enforce_chat_budget_json(
    chat_json: String,
    allowed_bytes: f64,
    system_text_limit: f64,
) -> NapiResult<String> {
    let chat: Value =
        serde_json::from_str(&chat_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let allowed = if allowed_bytes.is_finite() && allowed_bytes > 0.0 {
        allowed_bytes.floor() as usize
    } else {
        200_000usize
    };
    let sys_limit = if system_text_limit.is_finite() && system_text_limit >= 0.0 {
        system_text_limit.floor() as usize
    } else {
        8_192usize
    };
    let output = enforce_chat_budget(&chat, allowed.max(1024usize), sys_limit);
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct BudgetResolution {
    max_bytes: f64,
    safety_ratio: f64,
    allowed_bytes: f64,
    source: String,
}

fn read_env_number(key: &str) -> Option<f64> {
    std::env::var(key)
        .ok()
        .and_then(|value| value.parse::<f64>().ok())
}

fn read_json_file(path: &Path) -> Option<Value> {
    let data = fs::read_to_string(path).ok()?;
    serde_json::from_str::<Value>(&data).ok()
}

fn find_max_context_in_config(cfg: &Value, model_id: &str) -> Option<f64> {
    let vr = cfg.get("virtualrouter")?.as_object()?;
    let providers = vr.get("providers")?.as_object()?;
    for (_key, prov) in providers.iter() {
        let prov_obj = prov.as_object()?;
        let models = prov_obj.get("models")?.as_object()?;
        if let Some(item) = models.get(model_id).and_then(Value::as_object) {
            if let Some(raw) = item.get("maxContext") {
                if let Some(n) = raw.as_f64() {
                    if n.is_finite() && n > 0.0 {
                        return Some(n);
                    }
                } else if let Some(n) = raw.as_i64() {
                    if n > 0 {
                        return Some(n as f64);
                    }
                }
            }
        }
    }
    None
}

fn list_merged_configs(config_dir: &Path) -> Vec<PathBuf> {
    let mut files: Vec<PathBuf> = Vec::new();
    let Ok(entries) = fs::read_dir(config_dir) else {
        return files;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let name = path
            .file_name()
            .and_then(|v| v.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        if name.starts_with("merged-config") && name.ends_with(".json") {
            files.push(path);
        }
    }
    files.sort_by(|a, b| {
        let a_meta = fs::metadata(a).ok();
        let b_meta = fs::metadata(b).ok();
        let a_time = a_meta
            .and_then(|m| m.modified().ok())
            .unwrap_or(SystemTime::UNIX_EPOCH);
        let b_time = b_meta
            .and_then(|m| m.modified().ok())
            .unwrap_or(SystemTime::UNIX_EPOCH);
        b_time.cmp(&a_time)
    });
    files
}

fn read_modules_context_budget(config_dir: &Path) -> (Option<f64>, Option<f64>) {
    let file = config_dir.join("modules.json");
    let Some(cfg) = read_json_file(file.as_path()) else {
        return (None, None);
    };
    let modules = match cfg.get("modules").and_then(Value::as_object) {
        Some(value) => value,
        None => return (None, None),
    };
    let vr = match modules.get("virtualrouter").and_then(Value::as_object) {
        Some(value) => value,
        None => return (None, None),
    };
    let config = match vr.get("config").and_then(Value::as_object) {
        Some(value) => value,
        None => return (None, None),
    };
    let budget = match config.get("contextBudget").and_then(Value::as_object) {
        Some(value) => value,
        None => return (None, None),
    };
    let mut default_max: Option<f64> = None;
    let mut safety: Option<f64> = None;
    if let Some(raw) = budget.get("defaultMaxContextBytes") {
        if let Some(n) = raw.as_f64() {
            if n.is_finite() && n > 0.0 {
                default_max = Some(n);
            }
        } else if let Some(n) = raw.as_i64() {
            if n > 0 {
                default_max = Some(n as f64);
            }
        }
    }
    if let Some(raw) = budget.get("safetyRatio") {
        if let Some(n) = raw.as_f64() {
            if n.is_finite() && n >= 0.0 && n < 1.0 {
                safety = Some(n);
            }
        }
    }
    (default_max, safety)
}

fn parse_fallback_budget(value: &Value) -> Option<BudgetResolution> {
    let obj = value.as_object()?;
    let allowed = obj.get("allowedBytes")?.as_f64()?;
    if !allowed.is_finite() || allowed <= 0.0 {
        return None;
    }
    let max_bytes = obj
        .get("maxBytes")
        .and_then(Value::as_f64)
        .unwrap_or(allowed);
    let safety_ratio = obj
        .get("safetyRatio")
        .and_then(Value::as_f64)
        .unwrap_or(0.1);
    let source = obj
        .get("source")
        .and_then(Value::as_str)
        .unwrap_or("fallback")
        .to_string();
    Some(BudgetResolution {
        max_bytes,
        safety_ratio,
        allowed_bytes: allowed,
        source,
    })
}

fn resolve_budget_for_model(
    model_id: &str,
    fallback: Option<BudgetResolution>,
) -> BudgetResolution {
    if let Some(fallback) = fallback {
        return fallback;
    }

    let env_direct = read_env_number("ROUTECODEX_CONTEXT_BUDGET_BYTES")
        .or_else(|| read_env_number("RCC_CONTEXT_BUDGET_BYTES"));
    let env_safety = read_env_number("RCC_CONTEXT_BUDGET_SAFETY")
        .filter(|v| v.is_finite() && *v >= 0.0 && *v < 1.0);

    if let Some(max_bytes) = env_direct.filter(|v| v.is_finite() && *v > 0.0) {
        let safety = env_safety.unwrap_or(0.1);
        let allowed = (max_bytes * (1.0 - safety)).floor();
        return BudgetResolution {
            max_bytes,
            safety_ratio: safety,
            allowed_bytes: allowed,
            source: "env".to_string(),
        };
    }

    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    let config_dir = cwd.join("config");
    let (modules_default, modules_safety) = read_modules_context_budget(config_dir.as_path());

    for file in list_merged_configs(config_dir.as_path()) {
        if let Some(cfg) = read_json_file(file.as_path()) {
            if let Some(max_context) = find_max_context_in_config(&cfg, model_id) {
                let safety = env_safety.unwrap_or(modules_safety.unwrap_or(0.1));
                let allowed = (max_context * (1.0 - safety)).floor();
                let source = file
                    .file_name()
                    .and_then(|v| v.to_str())
                    .map(|v| format!("merged:{}", v))
                    .unwrap_or_else(|| "merged".to_string());
                return BudgetResolution {
                    max_bytes: max_context,
                    safety_ratio: safety,
                    allowed_bytes: allowed,
                    source,
                };
            }
        }
    }

    let config_file = config_dir.join("config.json");
    if let Some(cfg) = read_json_file(config_file.as_path()) {
        if let Some(max_context) = find_max_context_in_config(&cfg, model_id) {
            let safety = env_safety.unwrap_or(modules_safety.unwrap_or(0.1));
            let allowed = (max_context * (1.0 - safety)).floor();
            return BudgetResolution {
                max_bytes: max_context,
                safety_ratio: safety,
                allowed_bytes: allowed,
                source: "config.json".to_string(),
            };
        }
    }

    let default_max = modules_default.unwrap_or(200_000.0);
    let safety = env_safety.unwrap_or(modules_safety.unwrap_or(0.1));
    BudgetResolution {
        max_bytes: default_max,
        safety_ratio: safety,
        allowed_bytes: (default_max * (1.0 - safety)).floor(),
        source: if modules_default.is_some() {
            "modules.json".to_string()
        } else {
            "default".to_string()
        },
    }
}

#[napi_derive::napi]
pub fn resolve_budget_for_model_json(
    model_id: String,
    fallback_json: String,
) -> NapiResult<String> {
    let fallback_value: Value = serde_json::from_str(&fallback_json).unwrap_or(Value::Null);
    let fallback = parse_fallback_budget(&fallback_value);
    let output = resolve_budget_for_model(model_id.as_str(), fallback);
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}
