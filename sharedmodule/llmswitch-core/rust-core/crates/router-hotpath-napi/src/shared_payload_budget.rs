use napi::bindgen_prelude::Result as NapiResult;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

fn size_bytes(value: &Value) -> usize {
    serde_json::to_string(value)
        .map(|s| s.as_bytes().len())
        .unwrap_or(0)
}

fn clamp_text(value: &str, limit: usize) -> String {
    if limit == 0 {
        return String::new();
    }
    let chars: Vec<char> = value.chars().collect();
    if chars.len() <= limit {
        return value.to_string();
    }
    let clipped: String = chars.into_iter().take(limit).collect();
    format!("{}...(truncated)", clipped)
}

fn role_of(message: &Map<String, Value>) -> String {
    message
        .get("role")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_ascii_lowercase()
}

fn enforce_chat_budget(chat: &Value, allowed: usize, sys_limit: usize) -> Value {
    let Some(chat_obj) = chat.as_object() else {
        return chat.clone();
    };
    let Some(messages) = chat_obj.get("messages").and_then(Value::as_array) else {
        return chat.clone();
    };
    if messages.is_empty() {
        return chat.clone();
    }

    let mut next_chat = chat_obj.clone();
    let mut next_messages: Vec<Value> = messages.clone();

    if let Some(first) = next_messages.get_mut(0).and_then(Value::as_object_mut) {
        if role_of(first) == "system" {
            if let Some(content) = first
                .get("content")
                .and_then(Value::as_str)
                .map(|v| v.to_string())
            {
                first.insert(
                    "content".to_string(),
                    Value::String(clamp_text(content.as_str(), sys_limit)),
                );
            }
        }
    }

    let mut kept: Vec<Value> = Vec::with_capacity(next_messages.len());
    for message in next_messages {
        let Some(message_obj) = message.as_object() else {
            kept.push(message);
            continue;
        };
        if role_of(message_obj) == "assistant" {
            let has_tool_calls = message_obj
                .get("tool_calls")
                .and_then(Value::as_array)
                .map(|arr| !arr.is_empty())
                .unwrap_or(false);
            if !has_tool_calls {
                let text = message_obj
                    .get("content")
                    .and_then(Value::as_str)
                    .map(|v| v.trim().to_string())
                    .unwrap_or_default();
                if text.is_empty() {
                    continue;
                }
            }
        }
        kept.push(message);
    }
    next_chat.insert("messages".to_string(), Value::Array(kept));

    if size_bytes(&Value::Object(next_chat.clone())) <= allowed {
        return Value::Object(next_chat);
    }

    let tool_passes = [4000usize, 1500usize, 400usize, 100usize];
    for limit in tool_passes {
        if let Some(messages) = next_chat.get_mut("messages").and_then(Value::as_array_mut) {
            for message in messages {
                let Some(message_obj) = message.as_object_mut() else {
                    continue;
                };
                if role_of(message_obj) != "tool" {
                    continue;
                }
                if let Some(content) = message_obj
                    .get("content")
                    .and_then(Value::as_str)
                    .map(|v| v.to_string())
                {
                    message_obj.insert(
                        "content".to_string(),
                        Value::String(clamp_text(content.as_str(), limit)),
                    );
                }
            }
        }
        if size_bytes(&Value::Object(next_chat.clone())) <= allowed {
            return Value::Object(next_chat);
        }
    }

    let assistant_passes = [8000usize, 4000usize, 1500usize];
    for limit in assistant_passes {
        if let Some(messages) = next_chat.get_mut("messages").and_then(Value::as_array_mut) {
            for message in messages {
                let Some(message_obj) = message.as_object_mut() else {
                    continue;
                };
                if role_of(message_obj) != "assistant" {
                    continue;
                }
                let has_tool_calls = message_obj
                    .get("tool_calls")
                    .and_then(Value::as_array)
                    .map(|arr| !arr.is_empty())
                    .unwrap_or(false);
                if has_tool_calls {
                    continue;
                }
                if let Some(content) = message_obj
                    .get("content")
                    .and_then(Value::as_str)
                    .map(|v| v.to_string())
                {
                    message_obj.insert(
                        "content".to_string(),
                        Value::String(clamp_text(content.as_str(), limit)),
                    );
                    continue;
                }
                if let Some(parts) = message_obj.get_mut("content").and_then(Value::as_array_mut) {
                    let mut next_parts: Vec<Value> = Vec::with_capacity(parts.len());
                    for part in parts.iter() {
                        let Some(part_obj) = part.as_object() else {
                            next_parts.push(part.clone());
                            continue;
                        };
                        if let Some(text) = part_obj
                            .get("text")
                            .and_then(Value::as_str)
                            .map(|v| v.to_string())
                        {
                            let mut next_part = part_obj.clone();
                            next_part.insert(
                                "text".to_string(),
                                Value::String(clamp_text(text.as_str(), limit)),
                            );
                            next_parts.push(Value::Object(next_part));
                        } else {
                            next_parts.push(part.clone());
                        }
                    }
                    *parts = next_parts;
                }
            }
        }
        if size_bytes(&Value::Object(next_chat.clone())) <= allowed {
            break;
        }
    }

    Value::Object(next_chat)
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
