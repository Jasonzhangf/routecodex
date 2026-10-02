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

/// 发现条目里 capabilities 的来源：`detected` = provider 明确声明过，`default` = provider 只给了 id。
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum V3DiscoveredModelSource {
    Detected,
    Default,
}

/// 上游发现返回的单个模型条目（`{name, capabilities, maxTokens?, maxContextTokens?, source}`）；
/// 能力与限额只在 provider 真的声明过时才有值，未声明时字段整体缺席。
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct V3DiscoveredModel {
    pub name: String,
    pub capabilities: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_tokens: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_context_tokens: Option<u64>,
    pub source: V3DiscoveredModelSource,
}

/// 解析模型发现响应体：只认 provider 声明的数组形状，去空白与重复，绝不猜测。
pub(crate) fn extract_discovered_models(
    provider_id: &str,
    provider_type: &str,
    url: &str,
    body: &serde_json::Value,
) -> Result<Vec<V3DiscoveredModel>, V3ProviderError> {
    let unrecognized = |detail: &str| V3ProviderError::ResponseBody {
        request_id: crate::transport::DISCOVERY_REQUEST_ID.to_string(),
        provider_id: provider_id.to_string(),
        reason: format!("model discovery GET {url} response shape is unrecognized: {detail}"),
    };
    let items = if provider_type == "gemini" {
        body.get("models")
            .and_then(serde_json::Value::as_array)
            .ok_or_else(|| unrecognized("missing `models` array"))?
    } else {
        body.get("data")
            .and_then(serde_json::Value::as_array)
            .ok_or_else(|| unrecognized("missing `data` array"))?
    };
    let mut models: Vec<V3DiscoveredModel> = Vec::new();
    for item in items {
        let raw_name = if provider_type == "gemini" {
            item.get("name")
                .and_then(serde_json::Value::as_str)
                .map(|name| name.trim_start_matches("models/"))
                .ok_or_else(|| unrecognized("`models[].name` is missing"))?
        } else {
            item.get("id")
                .and_then(serde_json::Value::as_str)
                .ok_or_else(|| unrecognized("`data[].id` is missing"))?
        };
        let name = raw_name.trim().to_string();
        if name.is_empty() || models.iter().any(|model| model.name == name) {
            continue;
        }
        models.push(discovered_model(provider_type, name, item));
    }
    Ok(models)
}

/// 把 provider 声明映射成 runtime 已理解的 capability 词汇。
///
/// `strict` 用于 `supported_parameters` / `architecture.input_modalities` 这类
/// 参数名与模态名：未知 token 直接忽略。provider 显式给出的 `capabilities`
/// 数组走非 strict，未知 token 原样保留——那是 provider 自己的声明，不是本模块的推断。
fn map_capability_token(token: &str, strict: bool) -> Vec<String> {
    let lowered = token.trim().to_ascii_lowercase();
    let mapped: Vec<&str> = match lowered.as_str() {
        "" => Vec::new(),
        "text" | "input_text" | "generatecontent" => vec!["text"],
        "tools" | "tool_choice" | "function_calling" | "function_call" => vec!["tools"],
        "reasoning" | "thinking" | "reasoning_effort" | "include_reasoning" => vec!["reasoning"],
        "vision" | "image" | "image_url" | "input_image" | "imageinput" => {
            vec!["multimodal", "vision"]
        }
        "multimodal" => vec!["multimodal"],
        "web_search" | "web_search_direct" => vec!["web_search"],
        "longcontext" => vec!["longcontext"],
        _other if strict => Vec::new(),
        other => vec![other],
    };
    mapped.into_iter().map(str::to_string).collect()
}

fn declared_capabilities(provider_type: &str, item: &serde_json::Value) -> Vec<String> {
    let mut capabilities: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
    let mut collect = |tokens: &serde_json::Value, strict: bool| {
        for token in tokens.as_array().into_iter().flatten() {
            if let Some(token) = token.as_str() {
                capabilities.extend(map_capability_token(token, strict));
            }
        }
    };
    if let Some(declared) = item.get("capabilities") {
        collect(declared, false);
    }
    if let Some(parameters) = item.get("supported_parameters") {
        collect(parameters, true);
    }
    if let Some(modalities) = item
        .get("architecture")
        .and_then(|architecture| architecture.get("input_modalities"))
    {
        collect(modalities, true);
    }
    if provider_type == "gemini" {
        if let Some(methods) = item.get("supportedGenerationMethods") {
            collect(methods, true);
        }
    }
    capabilities.into_iter().collect()
}

fn declared_limit(item: &serde_json::Value, keys: &[&str]) -> Option<u64> {
    keys.iter()
        .find_map(|key| item.get(*key).and_then(serde_json::Value::as_u64))
        .filter(|limit| *limit > 0)
}

fn discovered_model(
    provider_type: &str,
    name: String,
    item: &serde_json::Value,
) -> V3DiscoveredModel {
    let capabilities = declared_capabilities(provider_type, item);
    let max_context_tokens = declared_limit(
        item,
        &[
            "context_length",
            "max_context_tokens",
            "maxContextTokens",
            "max_context",
            "context_window",
            "inputTokenLimit",
        ],
    );
    let max_tokens = declared_limit(
        item,
        &[
            "max_tokens",
            "max_output_tokens",
            "maxOutputTokens",
            "max_completion_tokens",
            "outputTokenLimit",
        ],
    );
    let source = if capabilities.is_empty() && max_tokens.is_none() && max_context_tokens.is_none()
    {
        V3DiscoveredModelSource::Default
    } else {
        V3DiscoveredModelSource::Detected
    };
    V3DiscoveredModel {
        name,
        capabilities,
        max_tokens,
        max_context_tokens,
        source,
    }
}
