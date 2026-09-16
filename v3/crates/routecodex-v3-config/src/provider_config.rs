// provider config text codec for provider/<id>/config.v2.toml
use crate::{
    provider_directory::V3ProviderDirectorySource, validation, V3ConfigError,
    V3ProviderAuthAuthoringConfig, V3ProviderAuthEntryAuthoringConfig, V3ProviderAuthType,
    V3ProviderAuthoringConfig, V3ProviderConcurrencyAuthoringConfig,
    V3ProviderHealthAuthoringConfig, V3ProviderModelAuthoringConfig,
    V3ProviderRequestCleanupAuthoringConfig, V3ProviderResponsesAuthoringConfig,
    V3ProviderSemanticErrorPolicyAuthoringConfig, V3ResponsesTransportKind, V3StreamingPolicy,
    V3WebSearchExecutionMode,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::Path;
use std::sync::LazyLock;

/// provider per-request 总超时默认值（毫秒）：300s。
pub(crate) const DEFAULT_PROVIDER_REQUEST_TIMEOUT_MS: u64 = 300_000;

pub(crate) fn compile_provider_directory(
    config_dir: &Path,
    referenced_models: &BTreeMap<String, BTreeSet<String>>,
) -> Result<
    (
        BTreeMap<String, V3ProviderAuthoringConfig>,
        Vec<V3ProviderDirectorySource>,
    ),
    V3ConfigError,
> {
    let mut providers = BTreeMap::new();
    let mut provider_sources = Vec::new();
    for (provider_id, selected_models) in referenced_models {
        let path = config_dir
            .join("provider")
            .join(provider_id)
            .join("config.v2.toml");
        let raw = fs::read_to_string(&path).map_err(|error| {
            validation(format!(
                "v3 referenced provider config {} read failed: {error}",
                path.display()
            ))
        })?;
        let canonical_path = fs::canonicalize(&path)?;
        let source_hash = format!("{:x}", Sha256::digest(raw.as_bytes()));
        let parsed: V2ProviderConfigFile = toml::from_str(&raw)?;
        let provider = parsed.provider;
        let provider_id_from_file = parsed.provider_id.unwrap_or_else(|| provider.id.clone());
        if provider_id_from_file != *provider_id || provider.id != *provider_id {
            return Err(validation(format!(
                "v2 provider config {} identity mismatch for {provider_id}",
                path.display()
            )));
        }
        let auth = compile_v2_auth(config_dir, provider_id, source_hash, provider.auth)?;
        let provider_type = match provider.provider_type.as_str() {
            "openai" | "openai-standard" | "openai_chat" => "openai_chat",
            "responses" => "responses",
            "anthropic" => "anthropic",
            "gemini" => "gemini",
            value => {
                return Err(validation(format!(
                    "v2 provider {provider_id} declares unknown type {value}"
                )))
            }
        }
        .to_string();
        let v2_responses = provider.responses.as_ref();
        let compatibility_profile = provider
            .compatibility_profile
            .or_else(|| resolve_v2_provider_default_compatibility_profile(provider_id));
        let responses = if provider_type == "responses" {
            Some(V3ProviderResponsesAuthoringConfig {
                process: v2_responses
                    .map(|responses| responses.process.clone())
                    .unwrap_or_else(|| "chat".to_string()),
                streaming: v2_responses
                    .and_then(|responses| streaming_policy(responses.streaming.as_deref()))
                    .unwrap_or(V3StreamingPolicy::Always),
                transport: v2_responses
                    .and_then(|responses| responses.transport)
                    .unwrap_or(V3ResponsesTransportKind::Http),
                websocket_v2_url: v2_responses
                    .and_then(|responses| responses.websocket_v2_url.clone()),
            })
        } else {
            None
        };
        let v3 = provider.v3.unwrap_or_default();
        // An empty selection means the route uses the provider default model.
        // Keep the directory model table intact so validation can verify that
        // default_model is a canonical key before runtime target expansion.
        let models = compile_v2_provider_models(
            provider.models,
            (!selected_models.is_empty()).then_some(selected_models),
        );
        providers.insert(
            provider_id.clone(),
            V3ProviderAuthoringConfig {
                enabled: provider.enabled.unwrap_or(true),
                provider_type,
                base_url: provider.base_url,
                default_model: provider.default_model,
                auth,
                models,
                responses,
                concurrency: provider.concurrency.map(|concurrency| {
                    V3ProviderConcurrencyAuthoringConfig {
                        max_in_flight: concurrency.max_in_flight.unwrap_or(8),
                        acquire_timeout_ms: concurrency.acquire_timeout_ms.unwrap_or(60000),
                        stale_lease_ms: concurrency.stale_lease_ms.unwrap_or(300000),
                    }
                }),
                health: v3.health,
                semantic_error_policy: v3.semantic_error_policy,
                provider_request_cleanup: v3.provider_request_cleanup,
                compatibility_profile,
                features: v3.features,
                request_timeout_ms: provider
                    .timeout
                    .unwrap_or(DEFAULT_PROVIDER_REQUEST_TIMEOUT_MS),
                sse_first_frame_timeout_ms: provider.sse_first_frame_timeout_ms,
            },
        );
        provider_sources.push(V3ProviderDirectorySource {
            provider_id: provider_id.clone(),
            canonical_path,
            raw_toml: raw,
        });
    }
    Ok((providers, provider_sources))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct V2ProviderResolutionConfig {
    #[serde(default)]
    compatibility_profile_blocks: Vec<V2CompatibilityProfileBlock>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct V2CompatibilityProfileBlock {
    provider_id: String,
    compatibility_profile: String,
}

pub(crate) fn resolve_v2_provider_default_compatibility_profile(
    provider_id: &str,
) -> Option<String> {
    static PROVIDER_RESOLUTION_CONFIG: LazyLock<V2ProviderResolutionConfig> = LazyLock::new(|| {
        serde_json::from_str(include_str!("v2_provider_compatibility_defaults.json"))
            .expect("V3-local V2 provider compatibility defaults must parse")
    });

    PROVIDER_RESOLUTION_CONFIG
        .compatibility_profile_blocks
        .iter()
        .find(|block| block.provider_id.eq_ignore_ascii_case(provider_id.trim()))
        .map(|block| block.compatibility_profile.trim().to_string())
        .filter(|profile| !profile.is_empty())
}

fn compile_v2_auth(
    _config_dir: &Path,
    provider_id: &str,
    _source_hash: String,
    auth: V2ProviderAuthConfig,
) -> Result<V3ProviderAuthAuthoringConfig, V3ConfigError> {
    let V2ProviderAuthConfig {
        api_key,
        env,
        token_file,
        secret_file,
        entries,
        selection,
    } = auth;
    let inline_handle_count = usize::from(api_key.is_some())
        + usize::from(env.is_some())
        + usize::from(token_file.is_some());
    let entries = match (entries, secret_file) {
        (Some(_), Some(_)) => {
            return Err(validation(format!(
                "v2 provider {provider_id} auth cannot combine entries with secretFile auto discovery"
            )));
        }
        (Some(entries), None) => {
            if inline_handle_count != 0 {
                return Err(validation(format!(
                    "v2 provider {provider_id} auth cannot combine entries with apiKey, env, or tokenFile"
                )));
            }
            entries
        }
        (None, Some(secret_file)) => {
            if inline_handle_count != 0 {
                return Err(validation(format!(
                    "v2 provider {provider_id} auth secretFile cannot combine with apiKey, env, or tokenFile"
                )));
            }
            let secret_file = secret_file.trim();
            if secret_file.is_empty() {
                return Err(validation(format!(
                    "v2 provider {provider_id} auth secretFile is empty"
                )));
            }
            let content = fs::read_to_string(secret_file).map_err(|error| {
                validation(format!(
                    "v2 provider {provider_id} auth secretFile {secret_file} is unreadable: {error}"
                ))
            })?;
            crate::discover_v3_secret_file_auth_handles(&content, provider_id)
                .map_err(|error| {
                    validation(format!(
                        "v2 provider {provider_id} auth secretFile discovery failed: {error}"
                    ))
                })?
                .into_iter()
                .map(|(alias, secret_key)| V2ProviderAuthEntry {
                    alias: Some(alias),
                    api_key: None,
                    env: None,
                    token_file: None,
                    secret_file: Some(secret_file.to_string()),
                    secret_key: Some(secret_key),
                })
                .collect()
        }
        (None, None) => vec![V2ProviderAuthEntry {
            alias: Some("key1".to_string()),
            api_key,
            env,
            token_file,
            secret_file: None,
            secret_key: None,
        }],
    };
    let mut v3_entries = Vec::new();
    for entry in entries {
        let alias = entry.alias.unwrap_or_else(|| "key1".to_string());
        let handle_count = usize::from(entry.env.is_some())
            + usize::from(entry.token_file.is_some())
            + usize::from(entry.secret_file.is_some())
            + usize::from(entry.api_key.is_some());
        if handle_count != 1 {
            return Err(validation(format!(
                "v2 provider {provider_id} auth {alias} must declare exactly one of apiKey, env, tokenFile, or secretFile"
            )));
        }
        if entry.secret_file.is_some() != entry.secret_key.is_some() {
            return Err(validation(format!(
                "v2 provider {provider_id} auth {alias} secretFile and secretKey must be declared together"
            )));
        }
        if let Some(env) = entry.env {
            v3_entries.push(V3ProviderAuthEntryAuthoringConfig {
                alias,
                priority: None,
                weight: None,
                env: Some(env),
                token_file: None,
                api_key: None,
                secret_file: None,
                secret_key: None,
            });
            continue;
        }
        if let Some(secret_file) = entry.secret_file {
            let secret_key = entry.secret_key.ok_or_else(|| {
                validation(format!(
                    "v2 provider {provider_id} auth {alias} secretFile requires secretKey"
                ))
            })?;
            let secret_file = secret_file.trim();
            if secret_file.is_empty() {
                return Err(validation(format!(
                    "v2 provider {provider_id} auth {alias} secretFile is empty"
                )));
            }
            let secret_key = secret_key.trim();
            if secret_key.is_empty() {
                return Err(validation(format!(
                    "v2 provider {provider_id} auth {alias} secretKey is empty"
                )));
            }
            v3_entries.push(V3ProviderAuthEntryAuthoringConfig {
                alias,
                priority: None,
                weight: None,
                env: None,
                token_file: None,
                api_key: None,
                secret_file: Some(secret_file.to_string()),
                secret_key: Some(secret_key.to_string()),
            });
            continue;
        }
        if let Some(token_file) = entry.token_file {
            let token_file = token_file.trim();
            if token_file.is_empty() {
                return Err(validation(format!(
                    "v2 provider {provider_id} auth {alias} tokenFile is empty"
                )));
            }
            v3_entries.push(V3ProviderAuthEntryAuthoringConfig {
                alias,
                priority: None,
                weight: None,
                env: None,
                token_file: Some(token_file.to_string()),
                api_key: None,
                secret_file: None,
                secret_key: None,
            });
            continue;
        }
        let api_key = entry.api_key.ok_or_else(|| {
            validation(format!(
                "v2 provider {provider_id} auth {alias} missing apiKey, env, or tokenFile"
            ))
        })?;
        if api_key.trim().is_empty() {
            return Err(validation(format!(
                "v2 provider {provider_id} auth {alias} apiKey is empty"
            )));
        }
        v3_entries.push(V3ProviderAuthEntryAuthoringConfig {
            alias,
            priority: None,
            weight: None,
            env: None,
            token_file: None,
            api_key: Some(api_key),
            secret_file: None,
            secret_key: None,
        });
    }
    Ok(V3ProviderAuthAuthoringConfig {
        auth_type: V3ProviderAuthType::ApiKey,
        selection: selection.unwrap_or_default(),
        entries: v3_entries,
    })
}

fn compile_v2_provider_models(
    models: BTreeMap<String, V2ProviderModelConfig>,
    referenced_models: Option<&BTreeSet<String>>,
) -> BTreeMap<String, V3ProviderModelAuthoringConfig> {
    models
        .into_iter()
        .filter(|(id, _)| {
            referenced_models.is_none_or(|referenced_models| referenced_models.contains(id))
        })
        .map(|(id, model)| {
            let web_search_execution_mode = model.web_search_execution_mode();
            (
                id.clone(),
                V3ProviderModelAuthoringConfig {
                    wire_name: model.wire_name.or(Some(id)),
                    aliases: model.aliases,
                    capabilities: normalize_v2_capabilities(model.capabilities),
                    web_search_execution_mode,
                    web_search_backend: model.web_search_backend,
                    supports_streaming: model.supports_streaming.unwrap_or(false),
                    supports_thinking: model.supports_thinking.unwrap_or(false),
                    thinking: model.thinking,
                    max_tokens: model.max_tokens,
                    max_context_tokens: model
                        .max_context_tokens
                        .or(model.context_window)
                        .or(model.max_context),
                    context_token_estimate_scale_bps: model.context_token_estimate_scale_bps,
                    features: model.features,
                },
            )
        })
        .collect()
}

fn normalize_v2_capabilities(capabilities: Vec<String>) -> Vec<String> {
    let mut result = BTreeSet::new();
    for capability in capabilities {
        let mapped = match capability.as_str() {
            "thinking" => "reasoning",
            "web_search_direct" => "web_search",
            value => value,
        };
        result.insert(mapped.to_string());
    }
    result.into_iter().collect()
}

fn streaming_policy(value: Option<&str>) -> Option<V3StreamingPolicy> {
    match value {
        Some("always") => Some(V3StreamingPolicy::Always),
        Some("client") => Some(V3StreamingPolicy::Client),
        Some("never") => Some(V3StreamingPolicy::Never),
        _ => None,
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct V2ProviderConfigFile {
    #[serde(default)]
    pub version: Option<String>,
    pub provider_id: Option<String>,
    pub provider: V2ProviderConfig,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct V2ProviderConfig {
    pub id: String,
    pub enabled: Option<bool>,
    #[serde(rename = "type")]
    pub provider_type: String,
    #[serde(rename = "baseURL")]
    pub base_url: String,
    pub default_model: String,
    pub auth: V2ProviderAuthConfig,
    pub responses: Option<V2ProviderResponsesConfig>,
    pub concurrency: Option<V2ProviderConcurrencyConfig>,
    #[serde(default, alias = "compatibilityProfile")]
    pub compatibility_profile: Option<String>,
    #[serde(default)]
    pub models: BTreeMap<String, V2ProviderModelConfig>,
    #[serde(default)]
    pub v3: Option<V2ProviderV3Config>,
    /// per-request 总超时（毫秒）；默认 300_000（300s）。覆盖连接、响应头等待与 body 读取。
    #[serde(default)]
    pub timeout: Option<u64>,
    /// provider SSE 首帧/帧间隔超时（毫秒）；默认 30s。本地慢部署按 provider 放宽。
    #[serde(default, alias = "sse_first_frame_timeout_ms")]
    pub sse_first_frame_timeout_ms: Option<u64>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct V2ProviderV3Config {
    #[serde(default)]
    pub health: Option<V3ProviderHealthAuthoringConfig>,
    #[serde(default, alias = "semantic_error_policy")]
    pub semantic_error_policy: Vec<V3ProviderSemanticErrorPolicyAuthoringConfig>,
    #[serde(default, alias = "provider_request_cleanup")]
    pub provider_request_cleanup: V3ProviderRequestCleanupAuthoringConfig,
    #[serde(default)]
    pub features: BTreeMap<String, bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct V2ProviderAuthConfig {
    pub api_key: Option<String>,
    pub env: Option<String>,
    pub token_file: Option<String>,
    pub secret_file: Option<String>,
    pub entries: Option<Vec<V2ProviderAuthEntry>>,
    #[serde(default)]
    pub selection: Option<crate::types::V3SelectionPolicy>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct V2ProviderAuthEntry {
    pub alias: Option<String>,
    pub api_key: Option<String>,
    pub env: Option<String>,
    pub token_file: Option<String>,
    pub secret_file: Option<String>,
    pub secret_key: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct V2ProviderResponsesConfig {
    pub process: String,
    pub streaming: Option<String>,
    #[serde(default)]
    pub transport: Option<V3ResponsesTransportKind>,
    #[serde(default, alias = "websocket_v2_url", alias = "websocketV2URL")]
    pub websocket_v2_url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct V2ProviderConcurrencyConfig {
    pub max_in_flight: Option<u32>,
    pub acquire_timeout_ms: Option<u64>,
    pub stale_lease_ms: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct V2ProviderModelConfig {
    #[serde(default)]
    pub wire_name: Option<String>,
    #[serde(default)]
    pub aliases: Vec<String>,
    #[serde(default)]
    pub capabilities: Vec<String>,
    pub supports_streaming: Option<bool>,
    pub supports_thinking: Option<bool>,
    pub thinking: Option<String>,
    pub max_tokens: Option<u64>,
    pub max_context: Option<u64>,
    pub max_context_tokens: Option<u64>,
    pub context_window: Option<u64>,
    #[serde(default = "default_context_token_estimate_scale_bps")]
    pub context_token_estimate_scale_bps: u64,
    /// Mode B 显式声明（v2 配置可选；缺省时按 `web_search_direct`
    /// capability 兼容推断 Mode A）。生产 v2 配置通过此字段启用
    /// `metadata_center_local_search` 与编译期 backend binding。
    ///
    /// 兼容两种写法：`rename_all = "camelCase"` 的 `webSearchExecutionMode`
    /// 与生产 v2 配置实际使用的 `web_search_execution_mode`（snake_case）。
    #[serde(default, alias = "web_search_execution_mode")]
    pub web_search_execution_mode: Option<V3WebSearchExecutionMode>,
    #[serde(default, alias = "web_search_backend")]
    pub web_search_backend: Option<String>,
    #[serde(default)]
    pub features: BTreeMap<String, bool>,
}

fn default_context_token_estimate_scale_bps() -> u64 {
    10_000
}

impl V2ProviderModelConfig {
    fn web_search_execution_mode(&self) -> V3WebSearchExecutionMode {
        self.web_search_execution_mode.unwrap_or_else(|| {
            if self
                .capabilities
                .iter()
                .any(|capability| capability == "web_search_direct")
            {
                V3WebSearchExecutionMode::NativeRemoteSearchToolMix
            } else {
                V3WebSearchExecutionMode::None
            }
        })
    }
}

pub fn parse_v2_provider_config_file(raw: &str) -> Result<V2ProviderConfigFile, V3ConfigError> {
    toml::from_str(raw)
        .map_err(|error| validation(format!("provider config file parse failed: {error}")))
}

pub fn generate_v2_provider_config_file(
    config: &V2ProviderConfigFile,
) -> Result<String, V3ConfigError> {
    toml::to_string_pretty(config)
        .map_err(|error| validation(format!("provider config file serialize failed: {error}")))
}

#[cfg(test)]
#[path = "provider_config_tests.rs"]
mod tests;
