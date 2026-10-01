//! Provider credential resolution and upstream model-discovery parsing.
//!
//! Sibling of `transport.rs` for the WebUI onboarding model-discovery request.
//! `provider_auth.rs` keeps the secret-resolution policy (`resolve_secret`,
//! `${VAR}` / `${VAR:-default}` expansion) next to the discovery response parser,
//! while the `reqwest` GET stays in `transport.rs` — the transport surface the
//! boundary gate names as owning provider HTTP, and the module whose anchored
//! symbols (`is_v3_anthropic_provider_request_header_name`,
//! `V3Transport13ResponsesRequest`) the relay-parity closeout gate checks.
use crate::wire::{V3ProviderAuthHandle, V3ProviderAuthSecretHandle};
use crate::V3ProviderError;

pub(crate) async fn resolve_secret(
    request_id: &str,
    provider_id: &str,
    auth: &V3ProviderAuthHandle,
) -> Result<String, V3ProviderError> {
    let secret = match &auth.secret {
        V3ProviderAuthSecretHandle::Environment(name) => {
            std::env::var(name).map_err(|_| V3ProviderError::MissingAuthSecret {
                request_id: request_id.to_string(),
                provider_id: provider_id.to_string(),
                auth_alias: auth.alias.clone(),
            })?
        }
        V3ProviderAuthSecretHandle::TokenFile(path) => tokio::fs::read_to_string(path)
            .await
            .map_err(|error| V3ProviderError::AuthSecretRead {
                request_id: request_id.to_string(),
                provider_id: provider_id.to_string(),
                auth_alias: auth.alias.clone(),
                reason: error.to_string(),
            })?,
        V3ProviderAuthSecretHandle::SecretFile { path, key } => {
            let content = tokio::fs::read_to_string(path).await.map_err(|error| {
                V3ProviderError::AuthSecretRead {
                    request_id: request_id.to_string(),
                    provider_id: provider_id.to_string(),
                    auth_alias: auth.alias.clone(),
                    reason: error.to_string(),
                }
            })?;
            // 解析归 config 层（编译期已校验 key 存在），运行时只取值。
            routecodex_v3_config::resolve_v3_secret_file_key(&content, key).map_err(|reason| {
                V3ProviderError::AuthSecretRead {
                    request_id: request_id.to_string(),
                    provider_id: provider_id.to_string(),
                    auth_alias: auth.alias.clone(),
                    reason,
                }
            })?
        }
        V3ProviderAuthSecretHandle::ApiKey(value) => expand_env_vars(value),
    };
    let secret = secret.trim().to_string();
    if secret.is_empty() {
        return Err(V3ProviderError::MissingAuthSecret {
            request_id: request_id.to_string(),
            provider_id: provider_id.to_string(),
            auth_alias: auth.alias.clone(),
        });
    }
    Ok(secret)
}

fn expand_env_vars(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut result = String::with_capacity(input.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'$' && i + 1 < bytes.len() && bytes[i + 1] == b'{' {
            let mut j = i + 2;
            while j < bytes.len() && bytes[j] != b'}' {
                j += 1;
            }
            if j < bytes.len() {
                let inner = &input[i + 2..j];
                let (var_name, default_val) = if let Some(dash_pos) = inner.find(":-") {
                    (&inner[..dash_pos], Some(&inner[dash_pos + 2..]))
                } else {
                    (inner, None)
                };
                let env_val = std::env::var(var_name).ok().unwrap_or_default();
                let replacement = if env_val.is_empty() {
                    default_val.unwrap_or("")
                } else {
                    &env_val
                };
                result.push_str(replacement);
                i = j + 1;
                continue;
            }
        }
        result.push(bytes[i] as char);
        i += 1;
    }
    result
}

/// 按 provider 协议拼模型发现地址；空 base_url 与未知 provider 类型显式失败。
pub(crate) fn discovery_models_url(
    provider_id: &str,
    provider_type: &str,
    base_url: &str,
) -> Result<String, V3ProviderError> {
    let base = base_url.trim_end_matches('/');
    if base.is_empty() {
        return Err(V3ProviderError::InvalidBaseUrl {
            request_id: crate::transport::DISCOVERY_REQUEST_ID.to_string(),
            provider_id: provider_id.to_string(),
            reason: "base_url is empty; model discovery needs an absolute http(s) base URL"
                .to_string(),
        });
    }
    Ok(match provider_type {
        "openai_chat" | "responses" => format!("{base}/models"),
        "anthropic" => format!("{base}/v1/models"),
        "gemini" => format!("{base}/v1beta/models"),
        other => {
            return Err(V3ProviderError::InvalidBaseUrl {
                request_id: crate::transport::DISCOVERY_REQUEST_ID.to_string(),
                provider_id: provider_id.to_string(),
                reason: format!("model discovery is not defined for provider type {other}"),
            })
        }
    })
}

/// 解析模型发现响应体：只认 provider 声明的数组形状，去空白与重复，绝不猜测。
pub(crate) fn extract_discovered_models(
    provider_id: &str,
    provider_type: &str,
    url: &str,
    body: &serde_json::Value,
) -> Result<Vec<String>, V3ProviderError> {
    let unrecognized = |detail: &str| V3ProviderError::ResponseBody {
        request_id: crate::transport::DISCOVERY_REQUEST_ID.to_string(),
        provider_id: provider_id.to_string(),
        reason: format!("model discovery GET {url} response shape is unrecognized: {detail}"),
    };
    let items = if provider_type == "gemini" {
        body.get("models")
            .and_then(serde_json::Value::as_array)
            .ok_or_else(|| unrecognized("missing `models` array"))?
            .iter()
            .map(|item| {
                item.get("name")
                    .and_then(serde_json::Value::as_str)
                    .map(|name| name.trim_start_matches("models/").to_string())
                    .ok_or_else(|| unrecognized("`models[].name` is missing"))
            })
            .collect::<Result<Vec<_>, _>>()?
    } else {
        body.get("data")
            .and_then(serde_json::Value::as_array)
            .ok_or_else(|| unrecognized("missing `data` array"))?
            .iter()
            .map(|item| {
                item.get("id")
                    .and_then(serde_json::Value::as_str)
                    .map(str::to_string)
                    .ok_or_else(|| unrecognized("`data[].id` is missing"))
            })
            .collect::<Result<Vec<_>, _>>()?
    };
    let mut models = Vec::new();
    for item in items {
        let name = item.trim().to_string();
        if name.is_empty() || models.contains(&name) {
            continue;
        }
        models.push(name);
    }
    Ok(models)
}
