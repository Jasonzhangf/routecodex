use napi::bindgen_prelude::Result as NapiResult;
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::{BTreeMap, BTreeSet, HashSet};
use std::env;
use std::fs;
use std::path::PathBuf;

use crate::virtual_router_engine::error::format_virtual_router_error;

const DEFAULT_PROVIDER_MAX_OUTPUT_TOKENS: i64 = 8192;
const DEFAULT_MODEL_CONTEXT_TOKENS: i64 = 200_000;
const QWEN_DEFAULT_USER_AGENT: &str = "QwenCode/0.14.3 (darwin; arm64)";
const CLAUDE_CODE_DEFAULT_USER_AGENT: &str = "claude-cli/2.0.76 (external, cli)";
const CLAUDE_CODE_DEFAULT_X_APP: &str = "claude-cli";
const CLAUDE_CODE_DEFAULT_ANTHROPIC_BETA: &str = "claude-code";
const MULTI_TOKEN_OAUTH_PROVIDERS: &[&str] = &["qwen", "gemini-cli", "antigravity"];

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProviderAuthConfigJson {
    #[serde(rename = "type")]
    auth_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    secret_ref: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    value: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    token_file: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    token_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    device_code_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    client_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    client_secret: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    scopes: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    authorization_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    user_info_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    refresh_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    oauth_provider_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    raw_type: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProviderRuntimeProfileJson {
    runtime_key: String,
    provider_id: String,
    key_alias: String,
    provider_type: String,
    endpoint: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    headers: Option<BTreeMap<String, String>>,
    auth: ProviderAuthConfigJson,
    #[serde(skip_serializing_if = "Option::is_none")]
    enabled: Option<bool>,
    outbound_profile: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    compatibility_profile: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    process_mode: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    responses_config: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    streaming: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    model_streaming: Option<BTreeMap<String, String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    model_output_tokens: Option<BTreeMap<String, i64>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    default_output_tokens: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    model_context_tokens: Option<BTreeMap<String, i64>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    default_context_tokens: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    model_anthropic_thinking_config: Option<BTreeMap<String, Value>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    default_anthropic_thinking_config: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    model_anthropic_thinking: Option<BTreeMap<String, String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    default_anthropic_thinking: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    model_anthropic_thinking_budgets: Option<BTreeMap<String, Value>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    default_anthropic_thinking_budgets: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    deepseek: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    server_tools_disabled: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    model_capabilities: Option<BTreeMap<String, Vec<String>>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    model_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    max_context_tokens: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    anthropic_thinking_config: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    anthropic_thinking: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    anthropic_thinking_budgets: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProviderProfileJson {
    provider_key: String,
    provider_type: String,
    endpoint: String,
    auth: ProviderAuthConfigJson,
    #[serde(skip_serializing_if = "Option::is_none")]
    enabled: Option<bool>,
    outbound_profile: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    compatibility_profile: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    runtime_key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    model_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    process_mode: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    responses_config: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    streaming: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    max_output_tokens: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    max_context_tokens: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    anthropic_thinking_config: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    anthropic_thinking: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    anthropic_thinking_budgets: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    deepseek: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    server_tools_disabled: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    model_capabilities: Option<BTreeMap<String, Vec<String>>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct ModelIndexEntry {
    #[serde(default)]
    declared: bool,
    #[serde(default)]
    models: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProvidersBootstrapOutput {
    runtime_entries: BTreeMap<String, ProviderRuntimeProfileJson>,
    alias_index: BTreeMap<String, Vec<String>>,
    model_index: BTreeMap<String, ModelIndexEntry>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProviderProfilesBootstrapOutput {
    profiles: BTreeMap<String, ProviderProfileJson>,
    target_runtime: BTreeMap<String, ProviderRuntimeProfileJson>,
}

#[derive(Debug, Clone)]
struct NormalizedProvider {
    provider_type: String,
    endpoint: String,
    headers: Option<BTreeMap<String, String>>,
    enabled: Option<bool>,
    outbound_profile: String,
    compatibility_profile: String,
    process_mode: String,
    responses_config: Option<Value>,
    streaming: Option<String>,
    model_streaming: Option<BTreeMap<String, String>>,
    model_output_tokens: Option<BTreeMap<String, i64>>,
    default_output_tokens: Option<i64>,
    model_context_tokens: Option<BTreeMap<String, i64>>,
    default_context_tokens: Option<i64>,
    model_anthropic_thinking_config: Option<BTreeMap<String, Value>>,
    default_anthropic_thinking_config: Option<Value>,
    model_anthropic_thinking: Option<BTreeMap<String, String>>,
    default_anthropic_thinking: Option<String>,
    model_anthropic_thinking_budgets: Option<BTreeMap<String, Value>>,
    default_anthropic_thinking_budgets: Option<Value>,
    deepseek: Option<Value>,
    server_tools_disabled: bool,
    model_capabilities: Option<BTreeMap<String, Vec<String>>>,
}

#[derive(Debug, Clone)]
struct ProviderAuthEntry {
    key_alias: String,
    auth: ProviderAuthConfigJson,
}

#[derive(Debug, Clone)]
struct AuthTypeInfo {
    auth_type: String,
    oauth_provider_id: Option<String>,
    raw: Option<String>,
}

#[derive(Debug, Clone, Default)]
struct AuthFieldDefaults {
    secret_ref: Option<String>,
    token_file: Option<String>,
    token_url: Option<String>,
    device_code_url: Option<String>,
    client_id: Option<String>,
    client_secret: Option<String>,
    authorization_url: Option<String>,
    user_info_url: Option<String>,
    refresh_url: Option<String>,
    scopes: Option<Vec<String>>,
}

#[derive(Debug, Clone, Default)]
struct AuthCandidate {
    type_hint: Option<String>,
    value: Option<String>,
    secret_ref: Option<String>,
    token_file: Option<String>,
    token_url: Option<String>,
    device_code_url: Option<String>,
    client_id: Option<String>,
    client_secret: Option<String>,
    authorization_url: Option<String>,
    user_info_url: Option<String>,
    refresh_url: Option<String>,
    scopes: Option<Vec<String>>,
    oauth_provider_id: Option<String>,
}

#[derive(Debug, Clone)]
struct OAuthTokenFileMatch {
    file_path: String,
    sequence: i64,
    alias: String,
}

#[derive(Debug, Clone)]
struct ParsedTargetKey {
    provider_id: String,
    key_alias: String,
    model_id: String,
}

pub(crate) fn bootstrap_virtual_router_providers_json(
    providers_json: String,
) -> NapiResult<String> {
    let providers: Map<String, Value> = serde_json::from_str(&providers_json)
        .map_err(|error| napi::Error::from_reason(error.to_string()))?;
    let (runtime_entries, alias_index, model_index) = build_provider_runtime_entries(&providers)
        .map_err(|error| {
            napi::Error::from_reason(format_virtual_router_error("CONFIG_ERROR", error))
        })?;
    let output = ProvidersBootstrapOutput {
        runtime_entries,
        alias_index,
        model_index,
    };
    serde_json::to_string(&output).map_err(|error| napi::Error::from_reason(error.to_string()))
}

pub(crate) fn bootstrap_virtual_router_provider_profiles_json(
    routed_target_keys_json: String,
    alias_index_json: String,
    model_index_json: String,
    runtime_entries_json: String,
) -> NapiResult<String> {
    let routed_target_keys: Vec<String> = serde_json::from_str(&routed_target_keys_json)
        .map_err(|error| napi::Error::from_reason(error.to_string()))?;
    let alias_index: BTreeMap<String, Vec<String>> = serde_json::from_str(&alias_index_json)
        .map_err(|error| napi::Error::from_reason(error.to_string()))?;
    let model_index: BTreeMap<String, ModelIndexEntry> = serde_json::from_str(&model_index_json)
        .map_err(|error| napi::Error::from_reason(error.to_string()))?;
    let runtime_entries: BTreeMap<String, ProviderRuntimeProfileJson> =
        serde_json::from_str(&runtime_entries_json)
            .map_err(|error| napi::Error::from_reason(error.to_string()))?;

    let expanded_target_keys = expand_target_keys(&routed_target_keys, &alias_index, &model_index);
    let (profiles, target_runtime) =
        build_provider_profiles(&expanded_target_keys, &runtime_entries).map_err(|error| {
            napi::Error::from_reason(format_virtual_router_error("CONFIG_ERROR", error))
        })?;
    let output = ProviderProfilesBootstrapOutput {
        profiles,
        target_runtime,
    };
    serde_json::to_string(&output).map_err(|error| napi::Error::from_reason(error.to_string()))
}

fn build_provider_runtime_entries(
    providers: &Map<String, Value>,
) -> Result<
    (
        BTreeMap<String, ProviderRuntimeProfileJson>,
        BTreeMap<String, Vec<String>>,
        BTreeMap<String, ModelIndexEntry>,
    ),
    String,
> {
    let mut runtime_entries = BTreeMap::new();
    let mut alias_index = BTreeMap::new();
    let mut model_index = BTreeMap::new();

    for (provider_id, provider_raw) in providers {
        let provider = provider_raw
            .as_object()
            .ok_or_else(|| format!("Provider {} must be an object", provider_id))?;
        let normalized_provider = normalize_provider(provider_id, provider)?;
        let collected_models = collect_provider_models(provider);
        let auth_entries = extract_provider_auth_entries(provider_id, provider)?;
        if auth_entries.is_empty() {
            return Err(format!(
                "Provider {} requires at least one auth entry",
                provider_id
            ));
        }
        alias_index.insert(
            provider_id.clone(),
            auth_entries
                .iter()
                .map(|entry| entry.key_alias.clone())
                .collect(),
        );
        model_index.insert(provider_id.clone(), collected_models);

        for entry in auth_entries {
            let runtime_key = build_runtime_key(provider_id, &entry.key_alias);
            let mut runtime_auth = entry.auth.clone();
            if runtime_auth.token_file.is_none()
                && (runtime_auth.auth_type == "oauth"
                    || runtime_auth
                        .raw_type
                        .as_deref()
                        .map(|value| value.to_lowercase().contains("oauth"))
                        .unwrap_or(false))
            {
                runtime_auth.token_file = Some(entry.key_alias.clone());
            }
            if runtime_auth.auth_type == "apiKey" && runtime_auth.secret_ref.is_none() {
                runtime_auth.secret_ref = Some(format!("{}.{}", provider_id, entry.key_alias));
            }
            runtime_entries.insert(
                runtime_key.clone(),
                ProviderRuntimeProfileJson {
                    runtime_key,
                    provider_id: provider_id.clone(),
                    key_alias: entry.key_alias,
                    provider_type: normalized_provider.provider_type.clone(),
                    endpoint: normalized_provider.endpoint.clone(),
                    headers: normalized_provider.headers.clone(),
                    auth: runtime_auth,
                    enabled: normalized_provider.enabled,
                    outbound_profile: normalized_provider.outbound_profile.clone(),
                    compatibility_profile: Some(normalized_provider.compatibility_profile.clone()),
                    process_mode: Some(normalized_provider.process_mode.clone()),
                    responses_config: normalized_provider.responses_config.clone(),
                    streaming: normalized_provider.streaming.clone(),
                    model_streaming: normalized_provider.model_streaming.clone(),
                    model_output_tokens: normalized_provider.model_output_tokens.clone(),
                    default_output_tokens: normalized_provider.default_output_tokens,
                    model_context_tokens: normalized_provider.model_context_tokens.clone(),
                    default_context_tokens: normalized_provider.default_context_tokens,
                    model_anthropic_thinking_config: normalized_provider
                        .model_anthropic_thinking_config
                        .clone(),
                    default_anthropic_thinking_config: normalized_provider
                        .default_anthropic_thinking_config
                        .clone(),
                    model_anthropic_thinking: normalized_provider.model_anthropic_thinking.clone(),
                    default_anthropic_thinking: normalized_provider
                        .default_anthropic_thinking
                        .clone(),
                    model_anthropic_thinking_budgets: normalized_provider
                        .model_anthropic_thinking_budgets
                        .clone(),
                    default_anthropic_thinking_budgets: normalized_provider
                        .default_anthropic_thinking_budgets
                        .clone(),
                    deepseek: normalized_provider.deepseek.clone(),
                    server_tools_disabled: if normalized_provider.server_tools_disabled {
                        Some(true)
                    } else {
                        None
                    },
                    model_capabilities: normalized_provider.model_capabilities.clone(),
                    model_id: None,
                    max_context_tokens: None,
                    anthropic_thinking_config: None,
                    anthropic_thinking: None,
                    anthropic_thinking_budgets: None,
                },
            );
        }
    }

    Ok((runtime_entries, alias_index, model_index))
}

fn build_provider_profiles(
    target_keys: &BTreeSet<String>,
    runtime_entries: &BTreeMap<String, ProviderRuntimeProfileJson>,
) -> Result<
    (
        BTreeMap<String, ProviderProfileJson>,
        BTreeMap<String, ProviderRuntimeProfileJson>,
    ),
    String,
> {
    let mut profiles = BTreeMap::new();
    let mut target_runtime = BTreeMap::new();

    for target_key in target_keys {
        let parsed = parse_target_key(target_key)
            .ok_or_else(|| format!("Invalid routing target key {}", target_key))?;
        let runtime_key = build_runtime_key(&parsed.provider_id, &parsed.key_alias);
        let runtime = runtime_entries.get(&runtime_key).ok_or_else(|| {
            format!(
                "Routing target {} references unknown runtime key {}",
                target_key, runtime_key
            )
        })?;

        let model_streaming_pref = runtime
            .model_streaming
            .as_ref()
            .and_then(|map| map.get(&parsed.model_id))
            .cloned();
        let streaming_pref = match runtime.streaming.as_deref() {
            Some("always") | Some("never") => runtime.streaming.clone(),
            _ => model_streaming_pref.or_else(|| runtime.streaming.clone()),
        };
        let context_tokens = resolve_context_tokens(runtime, &parsed.model_id);
        let output_tokens = resolve_output_tokens(runtime, &parsed.model_id);
        let anthropic_thinking_config =
            resolve_anthropic_thinking_config(runtime, &parsed.model_id).cloned();
        let anthropic_thinking = resolve_anthropic_thinking(runtime, &parsed.model_id);
        let anthropic_thinking_budgets =
            resolve_anthropic_thinking_budgets(runtime, &parsed.model_id).cloned();

        profiles.insert(
            target_key.clone(),
            ProviderProfileJson {
                provider_key: target_key.clone(),
                provider_type: runtime.provider_type.clone(),
                endpoint: runtime.endpoint.clone(),
                auth: runtime.auth.clone(),
                enabled: runtime.enabled,
                outbound_profile: runtime.outbound_profile.clone(),
                compatibility_profile: runtime.compatibility_profile.clone(),
                runtime_key: Some(runtime_key.clone()),
                model_id: Some(parsed.model_id.clone()),
                process_mode: runtime
                    .process_mode
                    .clone()
                    .or_else(|| Some("chat".to_string())),
                responses_config: runtime.responses_config.clone(),
                streaming: streaming_pref.clone(),
                max_output_tokens: output_tokens,
                max_context_tokens: Some(context_tokens),
                anthropic_thinking_config: anthropic_thinking_config.clone(),
                anthropic_thinking,
                anthropic_thinking_budgets: anthropic_thinking_budgets.clone(),
                deepseek: runtime.deepseek.clone(),
                server_tools_disabled: runtime.server_tools_disabled,
                model_capabilities: runtime.model_capabilities.clone(),
            },
        );

        let mut resolved_runtime = runtime.clone();
        resolved_runtime.model_id = Some(parsed.model_id.clone());
        resolved_runtime.streaming = streaming_pref;
        resolved_runtime.max_context_tokens = Some(context_tokens);
        resolved_runtime.anthropic_thinking_config = anthropic_thinking_config;
        resolved_runtime.anthropic_thinking = resolve_anthropic_thinking(runtime, &parsed.model_id);
        resolved_runtime.anthropic_thinking_budgets = anthropic_thinking_budgets;
        target_runtime.insert(target_key.clone(), resolved_runtime);
    }

    Ok((profiles, target_runtime))
}

fn expand_target_keys(
    routed_target_keys: &[String],
    alias_index: &BTreeMap<String, Vec<String>>,
    model_index: &BTreeMap<String, ModelIndexEntry>,
) -> BTreeSet<String> {
    let mut expanded = BTreeSet::new();
    for target_key in routed_target_keys {
        let trimmed = target_key.trim();
        if !trimmed.is_empty() {
            expanded.insert(trimmed.to_string());
        }
    }
    for (provider_id, aliases) in alias_index {
        let Some(models) = model_index.get(provider_id).map(|entry| &entry.models) else {
            continue;
        };
        if aliases.is_empty() || models.is_empty() {
            continue;
        }
        for alias in aliases {
            let runtime_key = build_runtime_key(provider_id, alias);
            for model_id in models {
                let trimmed = model_id.trim();
                if !trimmed.is_empty() {
                    expanded.insert(format!("{}.{}", runtime_key, trimmed));
                }
            }
        }
    }
    expanded
}

fn normalize_provider(
    provider_id: &str,
    provider: &Map<String, Value>,
) -> Result<NormalizedProvider, String> {
    let enabled = normalize_enabled(provider.get("enabled"));
    let provider_type = detect_provider_type(provider);
    let endpoint = read_optional_string(provider.get("endpoint"))
        .or_else(|| read_optional_string(provider.get("baseURL")))
        .or_else(|| read_optional_string(provider.get("baseUrl")))
        .unwrap_or_default();
    let compatibility_profile = resolve_compatibility_profile(provider_id, provider)?;
    let headers = maybe_inject_claude_code_headers(
        provider_id,
        &provider_type,
        &compatibility_profile,
        normalize_headers(provider.get("headers")),
    );
    let responses_node = as_object(provider.get("responses"));
    let responses_config = normalize_responses_config(
        provider_id,
        &provider_type,
        &compatibility_profile,
        provider,
        responses_node,
    );
    let process_mode = normalize_process_mode(provider.get("process"));
    let streaming = resolve_provider_streaming_preference(provider, responses_node);
    let model_streaming = normalize_model_streaming(provider);
    let (model_context_tokens, default_context_tokens) = normalize_model_context_tokens(provider);
    let (model_output_tokens, explicit_default_output_tokens) =
        normalize_model_output_tokens(provider);
    let (
        model_anthropic_thinking_config,
        default_anthropic_thinking_config,
        model_anthropic_thinking,
        default_anthropic_thinking,
        model_anthropic_thinking_budgets,
        default_anthropic_thinking_budgets,
    ) = normalize_anthropic_thinking(provider, &provider_type);
    let default_output_tokens = explicit_default_output_tokens.or_else(|| {
        if process_mode != "passthrough" {
            Some(DEFAULT_PROVIDER_MAX_OUTPUT_TOKENS)
        } else {
            None
        }
    });
    let deepseek = normalize_deepseek_options(provider);
    let server_tools_disabled = provider
        .get("serverToolsDisabled")
        .and_then(parse_bool_like)
        .unwrap_or(false)
        || as_object(provider.get("serverTools"))
            .and_then(|record| record.get("enabled"))
            .and_then(Value::as_bool)
            == Some(false);
    let model_capabilities = normalize_model_capabilities(provider);

    Ok(NormalizedProvider {
        provider_type: provider_type.clone(),
        endpoint,
        headers,
        enabled,
        outbound_profile: map_outbound_profile(&provider_type),
        compatibility_profile,
        process_mode,
        responses_config,
        streaming,
        model_streaming,
        model_output_tokens,
        default_output_tokens,
        model_context_tokens,
        default_context_tokens,
        model_anthropic_thinking_config,
        default_anthropic_thinking_config,
        model_anthropic_thinking,
        default_anthropic_thinking,
        model_anthropic_thinking_budgets,
        default_anthropic_thinking_budgets,
        deepseek,
        server_tools_disabled,
        model_capabilities,
    })
}

fn collect_provider_models(provider: &Map<String, Value>) -> ModelIndexEntry {
    let models_declared = provider.contains_key("models");
    let mut collected: Vec<String> = Vec::new();
    let mut seen = HashSet::new();

    if let Some(models_value) = provider.get("models") {
        match models_value {
            Value::Array(items) => {
                for item in items {
                    let Some(model_obj) = item.as_object() else {
                        continue;
                    };
                    if let Some(model_id) = read_optional_string(model_obj.get("id")) {
                        push_unique_string(&mut collected, &mut seen, model_id);
                    }
                    if let Some(aliases) = model_obj.get("aliases").and_then(Value::as_array) {
                        for alias in aliases {
                            if let Some(value) = alias.as_str() {
                                push_unique_string(
                                    &mut collected,
                                    &mut seen,
                                    value.trim().to_string(),
                                );
                            }
                        }
                    }
                }
            }
            Value::Object(models_map) => {
                for (model_name, model_raw) in models_map {
                    push_unique_string(&mut collected, &mut seen, model_name.trim().to_string());
                    if let Some(model_obj) = model_raw.as_object() {
                        if let Some(aliases) = model_obj.get("aliases").and_then(Value::as_array) {
                            for alias in aliases {
                                if let Some(value) = alias.as_str() {
                                    push_unique_string(
                                        &mut collected,
                                        &mut seen,
                                        value.trim().to_string(),
                                    );
                                }
                            }
                        }
                    }
                }
            }
            _ => {}
        }
    }

    ModelIndexEntry {
        declared: models_declared,
        models: collected,
    }
}

fn extract_provider_auth_entries(
    provider_id: &str,
    provider: &Map<String, Value>,
) -> Result<Vec<ProviderAuthEntry>, String> {
    let auth = as_object(provider.get("auth")).cloned().unwrap_or_default();
    let mut entries: Vec<ProviderAuthEntry> = Vec::new();
    let mut alias_set = HashSet::new();
    let base_type_source = read_optional_string(auth.get("type"));
    let base_type_info = interpret_auth_type(base_type_source.as_deref());
    let defaults = collect_auth_defaults(&auth);

    if let Some(auth_entries) = auth.get("entries").and_then(Value::as_array) {
        for entry in auth_entries {
            if let Some(record) = entry.as_object() {
                push_auth_entry_from_record(
                    provider_id,
                    Some(record),
                    None,
                    &base_type_source,
                    &base_type_info,
                    &defaults,
                    &mut entries,
                    &mut alias_set,
                )?;
            }
        }
    }

    if let Some(keys_array) = auth.get("keys").and_then(Value::as_array) {
        for entry in keys_array {
            if let Some(record) = entry.as_object() {
                push_auth_entry_from_record(
                    provider_id,
                    Some(record),
                    None,
                    &base_type_source,
                    &base_type_info,
                    &defaults,
                    &mut entries,
                    &mut alias_set,
                )?;
            }
        }
    } else if let Some(keys_object) = auth.get("keys").and_then(Value::as_object) {
        for (alias, entry) in keys_object {
            if let Some(record) = entry.as_object() {
                push_auth_entry_from_record(
                    provider_id,
                    Some(record),
                    Some(alias.to_string()),
                    &base_type_source,
                    &base_type_info,
                    &defaults,
                    &mut entries,
                    &mut alias_set,
                )?;
            } else if let Some(value) = entry.as_str() {
                let candidate = build_auth_candidate(
                    base_type_source.clone(),
                    &base_type_info,
                    AuthCandidate {
                        value: Some(value.trim().to_string()),
                        ..Default::default()
                    },
                );
                push_auth_entry(
                    provider_id,
                    Some(alias.to_string()),
                    candidate,
                    &base_type_info,
                    &defaults,
                    &mut entries,
                    &mut alias_set,
                )?;
            }
        }
    }

    let api_key_field = provider
        .get("apiKey")
        .or_else(|| provider.get("apiKeys"))
        .or_else(|| auth.get("apiKey"));
    match api_key_field {
        Some(Value::Array(items)) => {
            for item in items {
                match item {
                    Value::String(value) if !value.trim().is_empty() => {
                        let candidate = build_auth_candidate(
                            base_type_source.clone(),
                            &base_type_info,
                            AuthCandidate {
                                value: Some(value.trim().to_string()),
                                ..Default::default()
                            },
                        );
                        push_auth_entry(
                            provider_id,
                            None,
                            candidate,
                            &base_type_info,
                            &defaults,
                            &mut entries,
                            &mut alias_set,
                        )?;
                    }
                    Value::Object(record) => {
                        push_auth_entry_from_record(
                            provider_id,
                            Some(record),
                            None,
                            &base_type_source,
                            &base_type_info,
                            &defaults,
                            &mut entries,
                            &mut alias_set,
                        )?;
                    }
                    _ => {}
                }
            }
        }
        Some(Value::String(value)) if !value.trim().is_empty() => {
            let candidate = build_auth_candidate(
                base_type_source.clone(),
                &base_type_info,
                AuthCandidate {
                    value: Some(value.trim().to_string()),
                    ..Default::default()
                },
            );
            push_auth_entry(
                provider_id,
                None,
                candidate,
                &base_type_info,
                &defaults,
                &mut entries,
                &mut alias_set,
            )?;
        }
        _ => {}
    }

    let fallback_candidate = build_auth_candidate(
        base_type_source.clone(),
        &base_type_info,
        AuthCandidate {
            value: read_optional_string(auth.get("value")),
            secret_ref: read_optional_string(auth.get("secretRef")),
            token_file: read_optional_string(auth.get("tokenFile"))
                .or_else(|| read_optional_string(auth.get("file"))),
            token_url: read_optional_string(auth.get("tokenUrl"))
                .or_else(|| read_optional_string(auth.get("token_url"))),
            device_code_url: read_optional_string(auth.get("deviceCodeUrl"))
                .or_else(|| read_optional_string(auth.get("device_code_url"))),
            client_id: read_optional_string(auth.get("clientId"))
                .or_else(|| read_optional_string(auth.get("client_id"))),
            client_secret: read_optional_string(auth.get("clientSecret"))
                .or_else(|| read_optional_string(auth.get("client_secret"))),
            authorization_url: read_optional_string(auth.get("authorizationUrl"))
                .or_else(|| read_optional_string(auth.get("authorization_url")))
                .or_else(|| read_optional_string(auth.get("authUrl"))),
            user_info_url: read_optional_string(auth.get("userInfoUrl"))
                .or_else(|| read_optional_string(auth.get("user_info_url"))),
            refresh_url: read_optional_string(auth.get("refreshUrl"))
                .or_else(|| read_optional_string(auth.get("refresh_url"))),
            scopes: normalize_scope_list(auth.get("scopes").or_else(|| auth.get("scope"))),
            ..Default::default()
        },
    );
    let fallback_has_data = auth_candidate_has_material(&fallback_candidate);

    if entries.is_empty() && fallback_has_data {
        push_auth_entry(
            provider_id,
            None,
            fallback_candidate.clone(),
            &base_type_info,
            &defaults,
            &mut entries,
            &mut alias_set,
        )?;
    }

    let has_explicit_entries = !entries.is_empty();

    if base_type_info.auth_type == "oauth" && !has_explicit_entries {
        let mut scan_candidates = BTreeSet::new();
        if let Some(value) = auth.get("oauthProviderId").and_then(Value::as_str) {
            let trimmed = value.trim().to_lowercase();
            if !trimmed.is_empty() {
                scan_candidates.insert(trimmed);
            }
        }
        if let Some(value) = base_type_info.oauth_provider_id.as_ref() {
            let trimmed = value.trim().to_lowercase();
            if !trimmed.is_empty() {
                scan_candidates.insert(trimmed);
            }
        }
        let provider_candidate = provider_id.trim().to_lowercase();
        if !provider_candidate.is_empty() {
            scan_candidates.insert(provider_candidate);
        }

        for candidate in scan_candidates {
            if !MULTI_TOKEN_OAUTH_PROVIDERS.contains(&candidate.as_str()) {
                continue;
            }
            let token_files = scan_oauth_token_files(&candidate);
            if token_files.is_empty() {
                continue;
            }
            let base_type_alias = base_type_info
                .oauth_provider_id
                .as_ref()
                .map(|value| value.to_lowercase());
            for matched in token_files {
                let alias = if matched.alias != "default" {
                    format!("{}-{}", matched.sequence, matched.alias)
                } else {
                    matched.sequence.to_string()
                };
                let type_hint = if base_type_source.is_some()
                    && base_type_alias.as_deref() == Some(candidate.as_str())
                {
                    base_type_source.clone().unwrap()
                } else {
                    format!("{}-oauth", candidate)
                };
                let candidate_auth = build_auth_candidate(
                    Some(type_hint),
                    &base_type_info,
                    AuthCandidate {
                        token_file: Some(matched.file_path),
                        oauth_provider_id: Some(candidate.clone()),
                        ..Default::default()
                    },
                );
                push_auth_entry(
                    provider_id,
                    Some(alias),
                    candidate_auth,
                    &base_type_info,
                    &defaults,
                    &mut entries,
                    &mut alias_set,
                )?;
            }
        }
    }

    let base_raw_type = base_type_info
        .raw
        .as_deref()
        .unwrap_or_default()
        .trim()
        .to_lowercase();
    if base_type_info.auth_type == "apiKey"
        && base_raw_type == "deepseek-account"
        && !has_explicit_entries
    {
        for matched in scan_deepseek_account_token_files() {
            let candidate = build_auth_candidate(
                base_type_source
                    .clone()
                    .or_else(|| Some("deepseek-account".to_string())),
                &base_type_info,
                AuthCandidate {
                    token_file: Some(matched.file_path),
                    ..Default::default()
                },
            );
            push_auth_entry(
                provider_id,
                Some(matched.alias),
                candidate,
                &base_type_info,
                &defaults,
                &mut entries,
                &mut alias_set,
            )?;
        }
    }

    if entries.is_empty() && base_type_info.auth_type == "apiKey" {
        let auth_declared = provider.contains_key("auth")
            || provider.contains_key("apiKey")
            || provider.contains_key("apiKeys")
            || provider.contains_key("authType");
        if auth_declared {
            let candidate = build_auth_candidate(
                base_type_source.clone(),
                &base_type_info,
                AuthCandidate {
                    value: Some(String::new()),
                    ..Default::default()
                },
            );
            push_auth_entry(
                provider_id,
                None,
                candidate,
                &base_type_info,
                &defaults,
                &mut entries,
                &mut alias_set,
            )?;
        }
    }

    if entries.is_empty() {
        return Err(format!(
            "Provider {} is missing auth configuration",
            provider_id
        ));
    }

    Ok(entries)
}

fn auth_candidate_has_material(candidate: &AuthCandidate) -> bool {
    candidate.value.is_some()
        || candidate.secret_ref.is_some()
        || candidate.token_file.is_some()
        || candidate.token_url.is_some()
        || candidate.device_code_url.is_some()
        || candidate.client_id.is_some()
        || candidate.client_secret.is_some()
        || candidate.authorization_url.is_some()
        || candidate.user_info_url.is_some()
        || candidate.refresh_url.is_some()
        || candidate
            .scopes
            .as_ref()
            .map(|items| !items.is_empty())
            .unwrap_or(false)
}

fn push_auth_entry_from_record(
    provider_id: &str,
    record: Option<&Map<String, Value>>,
    alias_override: Option<String>,
    base_type_source: &Option<String>,
    base_type_info: &AuthTypeInfo,
    defaults: &AuthFieldDefaults,
    entries: &mut Vec<ProviderAuthEntry>,
    alias_set: &mut HashSet<String>,
) -> Result<(), String> {
    let Some(record) = record else {
        return Ok(());
    };
    let alias = alias_override.or_else(|| read_optional_string(record.get("alias")));
    let type_hint = read_optional_string(record.get("type"))
        .or_else(|| base_type_source.clone())
        .or_else(|| Some(base_type_info.auth_type.clone()));
    let candidate = build_auth_candidate(
        type_hint,
        base_type_info,
        AuthCandidate {
            value: read_optional_string(record.get("value"))
                .or_else(|| read_optional_string(record.get("apiKey"))),
            secret_ref: read_optional_string(record.get("secretRef")),
            token_file: read_optional_string(record.get("tokenFile")),
            token_url: read_optional_string(record.get("tokenUrl"))
                .or_else(|| read_optional_string(record.get("token_url"))),
            device_code_url: read_optional_string(record.get("deviceCodeUrl"))
                .or_else(|| read_optional_string(record.get("device_code_url"))),
            client_id: read_optional_string(record.get("clientId"))
                .or_else(|| read_optional_string(record.get("client_id"))),
            client_secret: read_optional_string(record.get("clientSecret"))
                .or_else(|| read_optional_string(record.get("client_secret"))),
            authorization_url: read_optional_string(record.get("authorizationUrl"))
                .or_else(|| read_optional_string(record.get("authorization_url")))
                .or_else(|| read_optional_string(record.get("authUrl"))),
            user_info_url: read_optional_string(record.get("userInfoUrl"))
                .or_else(|| read_optional_string(record.get("user_info_url"))),
            refresh_url: read_optional_string(record.get("refreshUrl"))
                .or_else(|| read_optional_string(record.get("refresh_url"))),
            scopes: normalize_scope_list(record.get("scopes").or_else(|| record.get("scope"))),
            ..Default::default()
        },
    );
    push_auth_entry(
        provider_id,
        alias,
        candidate,
        base_type_info,
        defaults,
        entries,
        alias_set,
    )
}

fn build_auth_candidate(
    type_hint: Option<String>,
    base_type_info: &AuthTypeInfo,
    mut extras: AuthCandidate,
) -> AuthCandidate {
    let source = type_hint
        .as_ref()
        .filter(|value| !value.trim().is_empty())
        .cloned()
        .or_else(|| base_type_info.raw.clone())
        .or_else(|| Some(base_type_info.auth_type.clone()));
    let type_info = interpret_auth_type(source.as_deref());
    extras.type_hint = type_info.raw.clone().or(source);
    if extras.oauth_provider_id.is_none() {
        extras.oauth_provider_id = type_info.oauth_provider_id.clone();
    }
    extras
}

fn push_auth_entry(
    provider_id: &str,
    candidate_alias: Option<String>,
    candidate: AuthCandidate,
    base_type_info: &AuthTypeInfo,
    defaults: &AuthFieldDefaults,
    entries: &mut Vec<ProviderAuthEntry>,
    alias_set: &mut HashSet<String>,
) -> Result<(), String> {
    let alias = normalize_alias(candidate_alias.as_deref(), alias_set);
    let type_source = candidate
        .type_hint
        .clone()
        .or_else(|| base_type_info.raw.clone())
        .unwrap_or_else(|| base_type_info.auth_type.clone());
    let type_info = interpret_auth_type(Some(type_source.as_str()));
    let entry_type = type_info.auth_type;
    let oauth_provider_id = candidate
        .oauth_provider_id
        .clone()
        .or_else(|| type_info.oauth_provider_id.clone())
        .or_else(|| base_type_info.oauth_provider_id.clone());

    if entry_type == "oauth" && oauth_provider_id.is_none() {
        return Err(format!(
            "Provider {} OAuth auth entries must declare provider-specific type (e.g. \"qwen-oauth\")",
            provider_id
        ));
    }

    let merged_scopes = merge_scopes(candidate.scopes.clone(), defaults.scopes.clone());
    let mut normalized = ProviderAuthConfigJson {
        auth_type: entry_type.clone(),
        raw_type: Some(type_source.clone()),
        oauth_provider_id,
        value: candidate.value.clone(),
        secret_ref: candidate
            .secret_ref
            .clone()
            .or_else(|| defaults.secret_ref.clone()),
        token_file: candidate
            .token_file
            .clone()
            .or_else(|| defaults.token_file.clone()),
        token_url: candidate
            .token_url
            .clone()
            .or_else(|| defaults.token_url.clone()),
        device_code_url: candidate
            .device_code_url
            .clone()
            .or_else(|| defaults.device_code_url.clone()),
        client_id: candidate
            .client_id
            .clone()
            .or_else(|| defaults.client_id.clone()),
        client_secret: candidate
            .client_secret
            .clone()
            .or_else(|| defaults.client_secret.clone()),
        scopes: merged_scopes,
        authorization_url: candidate
            .authorization_url
            .clone()
            .or_else(|| defaults.authorization_url.clone()),
        user_info_url: candidate
            .user_info_url
            .clone()
            .or_else(|| defaults.user_info_url.clone()),
        refresh_url: candidate
            .refresh_url
            .clone()
            .or_else(|| defaults.refresh_url.clone()),
    };

    if normalized.auth_type == "apiKey" && normalized.secret_ref.is_none() {
        normalized.secret_ref = Some(format!("{}.{}", provider_id, alias));
    }

    entries.push(ProviderAuthEntry {
        key_alias: alias.clone(),
        auth: normalized,
    });
    alias_set.insert(alias);
    Ok(())
}

fn collect_auth_defaults(auth: &Map<String, Value>) -> AuthFieldDefaults {
    AuthFieldDefaults {
        secret_ref: read_optional_string(auth.get("secretRef"))
            .or_else(|| read_optional_string(auth.get("file"))),
        token_file: read_optional_string(auth.get("tokenFile"))
            .or_else(|| read_optional_string(auth.get("file"))),
        token_url: read_optional_string(auth.get("tokenUrl"))
            .or_else(|| read_optional_string(auth.get("token_url"))),
        device_code_url: read_optional_string(auth.get("deviceCodeUrl"))
            .or_else(|| read_optional_string(auth.get("device_code_url"))),
        client_id: read_optional_string(auth.get("clientId"))
            .or_else(|| read_optional_string(auth.get("client_id"))),
        client_secret: read_optional_string(auth.get("clientSecret"))
            .or_else(|| read_optional_string(auth.get("client_secret"))),
        authorization_url: read_optional_string(auth.get("authorizationUrl"))
            .or_else(|| read_optional_string(auth.get("authorization_url")))
            .or_else(|| read_optional_string(auth.get("authUrl"))),
        user_info_url: read_optional_string(auth.get("userInfoUrl"))
            .or_else(|| read_optional_string(auth.get("user_info_url"))),
        refresh_url: read_optional_string(auth.get("refreshUrl"))
            .or_else(|| read_optional_string(auth.get("refresh_url"))),
        scopes: normalize_scope_list(auth.get("scopes").or_else(|| auth.get("scope"))),
    }
}

fn normalize_scope_list(value: Option<&Value>) -> Option<Vec<String>> {
    match value {
        Some(Value::Array(items)) => {
            let mut out = Vec::new();
            let mut seen = HashSet::new();
            for item in items {
                if let Some(raw) = item.as_str() {
                    let trimmed = raw.trim();
                    if !trimmed.is_empty() && seen.insert(trimmed.to_string()) {
                        out.push(trimmed.to_string());
                    }
                }
            }
            if out.is_empty() {
                None
            } else {
                Some(out)
            }
        }
        Some(Value::String(raw)) if !raw.trim().is_empty() => {
            let mut out = Vec::new();
            let mut seen = HashSet::new();
            for item in raw.split(|ch: char| ch == ',' || ch.is_whitespace()) {
                let trimmed = item.trim();
                if !trimmed.is_empty() && seen.insert(trimmed.to_string()) {
                    out.push(trimmed.to_string());
                }
            }
            if out.is_empty() {
                None
            } else {
                Some(out)
            }
        }
        _ => None,
    }
}

fn merge_scopes(
    primary: Option<Vec<String>>,
    fallback: Option<Vec<String>>,
) -> Option<Vec<String>> {
    if primary
        .as_ref()
        .map(|items| items.is_empty())
        .unwrap_or(true)
        && fallback
            .as_ref()
            .map(|items| items.is_empty())
            .unwrap_or(true)
    {
        return None;
    }
    let mut merged = Vec::new();
    let mut seen = HashSet::new();
    for scope in primary
        .into_iter()
        .flatten()
        .chain(fallback.into_iter().flatten())
    {
        let trimmed = scope.trim();
        if !trimmed.is_empty() && seen.insert(trimmed.to_string()) {
            merged.push(trimmed.to_string());
        }
    }
    if merged.is_empty() {
        None
    } else {
        Some(merged)
    }
}

fn interpret_auth_type(value: Option<&str>) -> AuthTypeInfo {
    let Some(raw) = value.map(str::trim).filter(|value| !value.is_empty()) else {
        return AuthTypeInfo {
            auth_type: "apiKey".to_string(),
            oauth_provider_id: None,
            raw: None,
        };
    };
    let lower = raw.to_lowercase();
    if lower == "apikey" || lower == "api-key" {
        return AuthTypeInfo {
            auth_type: "apiKey".to_string(),
            oauth_provider_id: None,
            raw: Some(raw.to_string()),
        };
    }
    if lower == "oauth" {
        return AuthTypeInfo {
            auth_type: "oauth".to_string(),
            oauth_provider_id: None,
            raw: Some(raw.to_string()),
        };
    }
    if let Some(captures) = Regex::new(r"^([a-z0-9._-]+)-oauth$")
        .ok()
        .and_then(|re| re.captures(&lower))
    {
        return AuthTypeInfo {
            auth_type: "oauth".to_string(),
            oauth_provider_id: captures.get(1).map(|m| m.as_str().to_string()),
            raw: Some(raw.to_string()),
        };
    }
    if lower.contains("oauth") {
        return AuthTypeInfo {
            auth_type: "oauth".to_string(),
            oauth_provider_id: None,
            raw: Some(raw.to_string()),
        };
    }
    AuthTypeInfo {
        auth_type: "apiKey".to_string(),
        oauth_provider_id: None,
        raw: Some(raw.to_string()),
    }
}

fn scan_oauth_token_files(oauth_provider_id: &str) -> Vec<OAuthTokenFileMatch> {
    let provider = oauth_provider_id.trim().to_lowercase();
    if provider.is_empty() {
        return Vec::new();
    }
    let base_dir = resolve_auth_dir();
    let pattern = Regex::new(r"(?i)^([a-z0-9_-]+)-oauth-(\d+)(?:-(.+))?\.json$").ok();
    let Some(pattern) = pattern else {
        return Vec::new();
    };
    let mut matches = Vec::new();
    let Ok(entries) = fs::read_dir(&base_dir) else {
        return Vec::new();
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Some(file_name) = path.file_name().and_then(|value| value.to_str()) else {
            continue;
        };
        let Some(captures) = pattern.captures(file_name) else {
            continue;
        };
        let provider_prefix = captures
            .get(1)
            .map(|m| m.as_str().to_lowercase())
            .unwrap_or_default();
        if provider_prefix != provider {
            continue;
        }
        let sequence = captures
            .get(2)
            .and_then(|m| m.as_str().parse::<i64>().ok())
            .filter(|value| *value > 0);
        let Some(sequence) = sequence else {
            continue;
        };
        let alias = captures
            .get(3)
            .map(|m| m.as_str().to_string())
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| "default".to_string());
        matches.push(OAuthTokenFileMatch {
            file_path: path.to_string_lossy().to_string(),
            sequence,
            alias,
        });
    }
    matches.sort_by(|left, right| left.sequence.cmp(&right.sequence));
    matches
}

fn scan_deepseek_account_token_files() -> Vec<OAuthTokenFileMatch> {
    let base_dir = resolve_auth_dir();
    let pattern = Regex::new(r"(?i)^deepseek-account-(.+)\.json$").ok();
    let Some(pattern) = pattern else {
        return Vec::new();
    };
    let mut matches: Vec<(String, String, Option<i64>)> = Vec::new();
    let Ok(entries) = fs::read_dir(&base_dir) else {
        return Vec::new();
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Some(file_name) = path.file_name().and_then(|value| value.to_str()) else {
            continue;
        };
        let Some(captures) = pattern.captures(file_name) else {
            continue;
        };
        let alias = captures
            .get(1)
            .map(|m| m.as_str().trim().to_string())
            .filter(|value| !value.is_empty());
        let Some(alias) = alias else {
            continue;
        };
        let numeric_prefix = Regex::new(r"^(\d+)(?:-|$)")
            .ok()
            .and_then(|re| re.captures(&alias))
            .and_then(|caps| caps.get(1))
            .and_then(|m| m.as_str().parse::<i64>().ok());
        matches.push((path.to_string_lossy().to_string(), alias, numeric_prefix));
    }
    matches.sort_by(|left, right| {
        let left_num = left.2.unwrap_or(i64::MAX);
        let right_num = right.2.unwrap_or(i64::MAX);
        left_num.cmp(&right_num).then(left.1.cmp(&right.1))
    });
    matches
        .into_iter()
        .enumerate()
        .map(|(index, (file_path, alias, _))| OAuthTokenFileMatch {
            file_path,
            sequence: (index + 1) as i64,
            alias,
        })
        .collect()
}

fn resolve_auth_dir() -> PathBuf {
    for key in ["ROUTECODEX_AUTH_DIR", "RCC_AUTH_DIR"] {
        let raw = env::var(key).unwrap_or_default();
        let trimmed = raw.trim();
        if !trimmed.is_empty() {
            return expand_home(trimmed);
        }
    }
    resolve_rcc_user_dir().join("auth")
}

fn resolve_rcc_user_dir() -> PathBuf {
    for key in ["RCC_HOME", "ROUTECODEX_USER_DIR", "ROUTECODEX_HOME"] {
        let raw = env::var(key).unwrap_or_default();
        let trimmed = raw.trim();
        if !trimmed.is_empty() {
            return expand_home(trimmed);
        }
    }
    let home = env::var("HOME").unwrap_or_default();
    if !home.trim().is_empty() {
        return PathBuf::from(home.trim()).join(".rcc");
    }
    PathBuf::from(".rcc")
}

fn expand_home(value: &str) -> PathBuf {
    if let Some(stripped) = value.strip_prefix("~/") {
        let home = env::var("HOME").unwrap_or_default();
        if !home.trim().is_empty() {
            return PathBuf::from(home.trim()).join(stripped);
        }
    }
    PathBuf::from(value)
}

fn maybe_inject_claude_code_headers(
    provider_id: &str,
    provider_type: &str,
    compatibility_profile: &str,
    headers: Option<BTreeMap<String, String>>,
) -> Option<BTreeMap<String, String>> {
    let qwen_headers =
        maybe_inject_qwen_headers(provider_id, compatibility_profile, headers.clone());
    if qwen_headers != headers {
        return qwen_headers;
    }
    let profile = compatibility_profile.trim().to_lowercase();
    if profile != "anthropic:claude-code" && profile != "chat:claude-code" {
        return headers;
    }
    if !provider_type.to_lowercase().contains("anthropic") {
        return headers;
    }
    let mut base = headers.unwrap_or_default();
    if !has_header(&base, "User-Agent") {
        base.insert(
            "User-Agent".to_string(),
            CLAUDE_CODE_DEFAULT_USER_AGENT.to_string(),
        );
    }
    if !has_header(&base, "X-App") {
        base.insert("X-App".to_string(), CLAUDE_CODE_DEFAULT_X_APP.to_string());
    }
    if !has_header(&base, "X-App-Version") {
        if let Some(version) = parse_claude_code_app_version_from_user_agent(
            base.get("User-Agent")
                .map(|value| value.as_str())
                .unwrap_or_default(),
        ) {
            base.insert("X-App-Version".to_string(), version);
        }
    }
    if !has_header(&base, "anthropic-beta") {
        base.insert(
            "anthropic-beta".to_string(),
            CLAUDE_CODE_DEFAULT_ANTHROPIC_BETA.to_string(),
        );
    }
    Some(base)
}

fn maybe_inject_qwen_headers(
    provider_id: &str,
    compatibility_profile: &str,
    headers: Option<BTreeMap<String, String>>,
) -> Option<BTreeMap<String, String>> {
    if compatibility_profile.trim().to_lowercase() != "chat:qwen" {
        return headers;
    }
    if provider_id.trim().to_lowercase() != "qwen" {
        return headers;
    }
    let mut base = headers.unwrap_or_default();
    if !has_header(&base, "X-DashScope-UserAgent") {
        base.insert(
            "X-DashScope-UserAgent".to_string(),
            QWEN_DEFAULT_USER_AGENT.to_string(),
        );
    }
    if !has_header(&base, "X-DashScope-CacheControl") {
        base.insert("X-DashScope-CacheControl".to_string(), "enable".to_string());
    }
    if !has_header(&base, "X-DashScope-AuthType") {
        base.insert("X-DashScope-AuthType".to_string(), "qwen-oauth".to_string());
    }
    if !has_header(&base, "User-Agent") {
        base.insert(
            "User-Agent".to_string(),
            QWEN_DEFAULT_USER_AGENT.to_string(),
        );
    }
    Some(base)
}

fn has_header(headers: &BTreeMap<String, String>, name: &str) -> bool {
    let lowered = name.trim().to_lowercase();
    if lowered.is_empty() {
        return false;
    }
    headers
        .iter()
        .any(|(key, value)| key.trim().to_lowercase() == lowered && !value.trim().is_empty())
}

fn parse_claude_code_app_version_from_user_agent(user_agent: &str) -> Option<String> {
    Regex::new(r"claude-cli/([\d.]+)")
        .ok()
        .and_then(|re| re.captures(user_agent.trim()))
        .and_then(|caps| caps.get(1))
        .map(|m| m.as_str().to_string())
}

fn normalize_deepseek_options(provider: &Map<String, Value>) -> Option<Value> {
    let direct = as_object(provider.get("deepseek"));
    let ext = as_object(as_object(provider.get("extensions")).and_then(|ext| ext.get("deepseek")));
    let source = if direct.map(|value| !value.is_empty()).unwrap_or(false) {
        direct
    } else {
        ext
    }?;
    if source.is_empty() {
        return None;
    }
    let strict_tool_required = source.get("strictToolRequired").and_then(parse_bool_like);
    let mut tool_protocol = source
        .get("toolProtocol")
        .and_then(Value::as_str)
        .map(|value| value.trim().to_lowercase())
        .filter(|value| value == "text" || value == "native");
    if tool_protocol.is_none() {
        let legacy_text_tool_fallback = source.get("textToolFallback").and_then(parse_bool_like);
        if let Some(enabled) = legacy_text_tool_fallback {
            tool_protocol = Some(if enabled {
                "text".to_string()
            } else {
                "native".to_string()
            });
        }
    }
    if strict_tool_required.is_none() && tool_protocol.is_none() {
        return None;
    }
    let mut out = Map::new();
    if let Some(value) = strict_tool_required {
        out.insert("strictToolRequired".to_string(), Value::Bool(value));
    }
    if let Some(value) = tool_protocol {
        out.insert("toolProtocol".to_string(), Value::String(value));
    }
    Some(Value::Object(out))
}

fn resolve_compatibility_profile(
    provider_id: &str,
    provider: &Map<String, Value>,
) -> Result<String, String> {
    if let Some(profile) = read_optional_string(provider.get("compatibilityProfile")) {
        return Ok(profile);
    }
    let mut legacy_fields = Vec::new();
    if read_optional_string(provider.get("compat")).is_some() {
        legacy_fields.push("compat");
    }
    if read_optional_string(provider.get("compatibility_profile")).is_some() {
        legacy_fields.push("compatibility_profile");
    }
    if !legacy_fields.is_empty() {
        return Err(format!(
            "Provider \"{}\" uses legacy compatibility field(s): {}. Rename to \"compatibilityProfile\".",
            provider_id,
            legacy_fields.join(", ")
        ));
    }
    let normalized_id = provider_id.trim().to_lowercase();
    let provider_type = format!(
        "{}",
        provider
            .get("providerType")
            .or_else(|| provider.get("type"))
            .or_else(|| provider.get("protocol"))
            .and_then(Value::as_str)
            .unwrap_or_default()
    )
    .to_lowercase();
    if normalized_id == "antigravity"
        || normalized_id == "gemini-cli"
        || provider_type.contains("antigravity")
        || provider_type.contains("gemini-cli")
    {
        return Ok("chat:gemini-cli".to_string());
    }
    Ok("compat:passthrough".to_string())
}

fn normalize_process_mode(value: Option<&Value>) -> String {
    let normalized = value
        .and_then(Value::as_str)
        .map(|value| value.trim().to_lowercase())
        .unwrap_or_else(|| "chat".to_string());
    if normalized == "passthrough" {
        "passthrough".to_string()
    } else {
        "chat".to_string()
    }
}

fn detect_provider_type(provider: &Map<String, Value>) -> String {
    let raw = provider
        .get("providerType")
        .or_else(|| provider.get("protocol"))
        .or_else(|| provider.get("type"))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_lowercase();
    let id = provider
        .get("providerId")
        .or_else(|| provider.get("id"))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_lowercase();
    let lexicon = format!("{}|{}", raw, id).trim().to_string();
    if lexicon.is_empty() {
        return "openai".to_string();
    }
    if lexicon.contains("anthropic") || lexicon.contains("claude") {
        return "anthropic".to_string();
    }
    if lexicon.contains("responses") {
        return "responses".to_string();
    }
    if lexicon.contains("gemini") {
        return "gemini".to_string();
    }
    if lexicon.contains("iflow") {
        return "iflow".to_string();
    }
    if lexicon.contains("qwen") {
        return "qwen".to_string();
    }
    if lexicon.contains("glm") {
        return "glm".to_string();
    }
    if lexicon.contains("lmstudio") {
        return "lmstudio".to_string();
    }
    if raw.is_empty() {
        "openai".to_string()
    } else {
        raw
    }
}

fn map_outbound_profile(provider_type: &str) -> String {
    match provider_type.to_lowercase().as_str() {
        "anthropic" => "anthropic-messages".to_string(),
        "responses" => "openai-responses".to_string(),
        "gemini" => "gemini-chat".to_string(),
        _ => "openai-chat".to_string(),
    }
}

fn normalize_headers(value: Option<&Value>) -> Option<BTreeMap<String, String>> {
    let Some(map) = value.and_then(Value::as_object) else {
        return None;
    };
    let mut out = BTreeMap::new();
    for (key, value) in map {
        if let Some(string) = value.as_str() {
            out.insert(key.clone(), string.to_string());
        }
    }
    if out.is_empty() {
        None
    } else {
        Some(out)
    }
}

fn normalize_responses_config(
    provider_id: &str,
    provider_type: &str,
    compatibility_profile: &str,
    provider: &Map<String, Value>,
    node: Option<&Map<String, Value>>,
) -> Option<Value> {
    let source = node.or_else(|| as_object(provider.get("responses")));
    if let Some(source_map) = source {
        if let Some(raw_style) = source_map
            .get("toolCallIdStyle")
            .and_then(Value::as_str)
            .map(|value| value.trim().to_lowercase())
        {
            if raw_style == "fc" || raw_style == "preserve" {
                let mut out = Map::new();
                out.insert("toolCallIdStyle".to_string(), Value::String(raw_style));
                return Some(Value::Object(out));
            }
        }
    }
    if !provider_type.trim().to_lowercase().contains("responses") {
        return None;
    }
    let is_lmstudio = provider_id.trim().to_lowercase() == "lmstudio"
        || compatibility_profile.trim().to_lowercase() == "chat:lmstudio";
    let mut out = Map::new();
    out.insert(
        "toolCallIdStyle".to_string(),
        Value::String(if is_lmstudio { "preserve" } else { "fc" }.to_string()),
    );
    Some(Value::Object(out))
}

fn resolve_provider_streaming_preference(
    provider: &Map<String, Value>,
    responses_node: Option<&Map<String, Value>>,
) -> Option<String> {
    let config_node = as_object(provider.get("config"));
    let config_responses = config_node.and_then(|value| as_object(value.get("responses")));
    coerce_streaming_preference(
        provider
            .get("streaming")
            .or_else(|| provider.get("stream"))
            .or_else(|| provider.get("streamingPreference")),
    )
    .or_else(|| coerce_streaming_capability(provider.get("supportsStreaming")))
    .or_else(|| {
        coerce_streaming_preference(
            responses_node.and_then(|node| node.get("streaming").or_else(|| node.get("stream"))),
        )
    })
    .or_else(|| {
        coerce_streaming_capability(responses_node.and_then(|node| node.get("supportsStreaming")))
    })
    .or_else(|| {
        coerce_streaming_preference(
            config_responses.and_then(|node| node.get("streaming").or_else(|| node.get("stream"))),
        )
    })
}

fn coerce_streaming_preference(value: Option<&Value>) -> Option<String> {
    match value {
        Some(Value::String(raw)) => {
            let normalized = raw.trim().to_lowercase();
            match normalized.as_str() {
                "always" | "auto" | "never" => Some(normalized),
                "true" => Some("always".to_string()),
                "false" => Some("never".to_string()),
                _ => None,
            }
        }
        Some(Value::Bool(enabled)) => Some(if *enabled {
            "always".to_string()
        } else {
            "never".to_string()
        }),
        Some(Value::Object(record)) => coerce_streaming_preference(
            record
                .get("mode")
                .or_else(|| record.get("value"))
                .or_else(|| record.get("enabled")),
        ),
        _ => None,
    }
}

fn coerce_streaming_capability(value: Option<&Value>) -> Option<String> {
    match value {
        Some(Value::Bool(enabled)) => Some(if *enabled {
            "auto".to_string()
        } else {
            "never".to_string()
        }),
        Some(Value::Object(record)) => coerce_streaming_capability(
            record
                .get("enabled")
                .or_else(|| record.get("value"))
                .or_else(|| record.get("mode")),
        ),
        _ => coerce_streaming_preference(value),
    }
}

fn normalize_model_streaming(provider: &Map<String, Value>) -> Option<BTreeMap<String, String>> {
    let mut normalized = BTreeMap::new();
    for_each_model(provider, |model_id, model| {
        if let Some(preference) =
            coerce_streaming_preference(model.get("streaming").or_else(|| model.get("stream")))
                .or_else(|| coerce_streaming_capability(model.get("supportsStreaming")))
        {
            normalized.insert(model_id, preference);
        }
    });
    if normalized.is_empty() {
        None
    } else {
        Some(normalized)
    }
}

fn normalize_model_context_tokens(
    provider: &Map<String, Value>,
) -> (Option<BTreeMap<String, i64>>, Option<i64>) {
    let mut normalized = BTreeMap::new();
    for_each_model(provider, |model_id, model| {
        if let Some(candidate) = read_context_tokens(Some(model)) {
            normalized.insert(model_id, candidate);
        }
    });
    let config_node = as_object(provider.get("config"));
    let defaults_node = config_node.and_then(|node| as_object(node.get("userConfigDefaults")));
    let default_candidate = read_context_tokens(Some(provider))
        .or_else(|| read_context_tokens(config_node))
        .or_else(|| read_context_tokens(defaults_node));
    (
        if normalized.is_empty() {
            None
        } else {
            Some(normalized)
        },
        default_candidate,
    )
}

fn normalize_model_output_tokens(
    provider: &Map<String, Value>,
) -> (Option<BTreeMap<String, i64>>, Option<i64>) {
    let mut normalized = BTreeMap::new();
    for_each_model(provider, |model_id, model| {
        if let Some(candidate) = read_output_tokens(Some(model)) {
            normalized.insert(model_id, candidate);
        }
    });
    let config_node = as_object(provider.get("config"));
    let defaults_node = config_node.and_then(|node| as_object(node.get("userConfigDefaults")));
    let default_candidate = read_output_tokens(Some(provider))
        .or_else(|| read_output_tokens(config_node))
        .or_else(|| read_output_tokens(defaults_node));
    (
        if normalized.is_empty() {
            None
        } else {
            Some(normalized)
        },
        default_candidate,
    )
}

fn read_context_tokens(record: Option<&Map<String, Value>>) -> Option<i64> {
    let Some(record) = record else {
        return None;
    };
    for key in [
        "maxContextTokens",
        "max_context_tokens",
        "maxContext",
        "max_context",
        "contextTokens",
        "context_tokens",
    ] {
        if let Some(value) = normalize_positive_integer(record.get(key)) {
            return Some(value);
        }
    }
    None
}

fn read_output_tokens(record: Option<&Map<String, Value>>) -> Option<i64> {
    let Some(record) = record else {
        return None;
    };
    for key in [
        "maxOutputTokens",
        "max_output_tokens",
        "maxTokens",
        "max_tokens",
        "outputTokens",
        "output_tokens",
    ] {
        if let Some(value) = normalize_positive_integer(record.get(key)) {
            return Some(value);
        }
    }
    None
}

fn normalize_positive_integer(value: Option<&Value>) -> Option<i64> {
    match value {
        Some(Value::Number(number)) => number
            .as_i64()
            .or_else(|| number.as_f64().map(|v| v as i64)),
        Some(Value::String(raw)) => raw.trim().parse::<f64>().ok().map(|v| v as i64),
        _ => None,
    }
    .filter(|value| *value > 0)
}

fn normalize_model_capabilities(
    provider: &Map<String, Value>,
) -> Option<BTreeMap<String, Vec<String>>> {
    let mut result = BTreeMap::new();
    for_each_model(provider, |model_id, model| {
        let Some(capabilities) = model.get("capabilities").and_then(Value::as_array) else {
            return;
        };
        let mut valid = Vec::new();
        let mut seen = HashSet::new();
        for cap in capabilities {
            let normalized = cap
                .as_str()
                .map(|value| value.trim().to_lowercase())
                .unwrap_or_default();
            let mapped = match normalized.as_str() {
                "multimodal" | "vision" => "multimodal".to_string(),
                "websearch" | "web-search" | "search" => "web_search".to_string(),
                _ => normalized,
            };
            if [
                "text",
                "reasoning",
                "multimodal",
                "video",
                "thinking",
                "web_search",
            ]
            .contains(&mapped.as_str())
                && seen.insert(mapped.clone())
            {
                valid.push(mapped);
            }
        }
        if !valid.is_empty() {
            result.insert(model_id, valid);
        }
    });
    if result.is_empty() {
        None
    } else {
        Some(result)
    }
}

fn normalize_anthropic_thinking(
    provider: &Map<String, Value>,
    provider_type: &str,
) -> (
    Option<BTreeMap<String, Value>>,
    Option<Value>,
    Option<BTreeMap<String, String>>,
    Option<String>,
    Option<BTreeMap<String, Value>>,
    Option<Value>,
) {
    if provider_type.trim().to_lowercase() != "anthropic" {
        return (None, None, None, None, None, None);
    }
    let config_node = as_object(provider.get("config"));
    let defaults_node = config_node.and_then(|node| as_object(node.get("userConfigDefaults")));

    let mut model_config = BTreeMap::new();
    let mut model_level = BTreeMap::new();
    let mut model_budgets = BTreeMap::new();

    for_each_model(provider, |model_id, model| {
        if let Some(config) = read_anthropic_thinking_config(Some(model)) {
            model_config.insert(model_id.clone(), config.clone());
            if let Some(level) = extract_anthropic_thinking_level_from_config(&config) {
                model_level.insert(model_id.clone(), level);
            }
        }
        if let Some(budgets) = read_anthropic_thinking_budgets(Some(model)) {
            model_budgets.insert(model_id, budgets);
        }
    });

    let default_config = read_anthropic_thinking_config(Some(provider))
        .or_else(|| read_anthropic_thinking_config(config_node))
        .or_else(|| read_anthropic_thinking_config(defaults_node));
    let default_level = default_config
        .as_ref()
        .and_then(extract_anthropic_thinking_level_from_config)
        .or_else(|| {
            read_anthropic_thinking_level(Some(provider))
                .or_else(|| read_anthropic_thinking_level(config_node))
                .or_else(|| read_anthropic_thinking_level(defaults_node))
        });
    let default_budgets = read_anthropic_thinking_budgets(Some(provider))
        .or_else(|| read_anthropic_thinking_budgets(config_node))
        .or_else(|| read_anthropic_thinking_budgets(defaults_node));

    (
        if model_config.is_empty() {
            None
        } else {
            Some(model_config)
        },
        default_config,
        if model_level.is_empty() {
            None
        } else {
            Some(model_level)
        },
        default_level,
        if model_budgets.is_empty() {
            None
        } else {
            Some(model_budgets)
        },
        default_budgets,
    )
}

fn normalize_anthropic_thinking_mode(value: &Value) -> Option<String> {
    match value {
        Value::Bool(enabled) => Some(if *enabled { "enabled" } else { "disabled" }.to_string()),
        Value::String(raw) => {
            let normalized = raw.trim().to_lowercase();
            if normalized.is_empty() {
                None
            } else if ["off", "none", "disabled", "false"].contains(&normalized.as_str()) {
                Some("disabled".to_string())
            } else if normalized == "enabled" || normalized == "adaptive" {
                Some(normalized)
            } else {
                None
            }
        }
        _ => None,
    }
}

fn normalize_anthropic_thinking_effort(value: &Value) -> Option<String> {
    match value {
        Value::Bool(enabled) => {
            if *enabled {
                Some("medium".to_string())
            } else {
                None
            }
        }
        Value::String(raw) => {
            let normalized = raw.trim().to_lowercase();
            if normalized == "minimal" {
                Some("low".to_string())
            } else if ["low", "medium", "high", "max"].contains(&normalized.as_str()) {
                Some(normalized)
            } else {
                None
            }
        }
        _ => None,
    }
}

fn normalize_anthropic_thinking_budget(value: &Value) -> Option<i64> {
    let budget = normalize_positive_integer(Some(value))?;
    Some(std::cmp::max(1024, budget))
}

fn normalize_anthropic_thinking_budget_map(value: &Value) -> Option<Value> {
    let Some(record) = value.as_object() else {
        return None;
    };
    let mut out = Map::new();
    for (key, raw) in record {
        let Some(effort) = normalize_anthropic_thinking_effort(&Value::String(key.clone())) else {
            continue;
        };
        if let Some(budget) = normalize_anthropic_thinking_budget(raw) {
            out.insert(effort, Value::Number(budget.into()));
        }
    }
    if out.is_empty() {
        None
    } else {
        Some(Value::Object(out))
    }
}

fn normalize_anthropic_thinking_config_value(value: &Value) -> Option<Value> {
    match value {
        Value::Bool(enabled) => {
            let mut out = Map::new();
            out.insert(
                "mode".to_string(),
                Value::String(if *enabled { "enabled" } else { "disabled" }.to_string()),
            );
            Some(Value::Object(out))
        }
        Value::String(_) => {
            let mode = normalize_anthropic_thinking_mode(value);
            let effort = normalize_anthropic_thinking_effort(value);
            if mode.is_none() && effort.is_none() {
                return None;
            }
            let mut out = Map::new();
            if let Some(mode) = mode {
                out.insert("mode".to_string(), Value::String(mode));
            }
            if let Some(effort) = effort {
                out.insert("effort".to_string(), Value::String(effort));
            }
            Some(Value::Object(out))
        }
        Value::Object(node) => {
            let mode = node
                .get("mode")
                .and_then(normalize_anthropic_thinking_mode)
                .or_else(|| node.get("type").and_then(normalize_anthropic_thinking_mode))
                .or_else(|| {
                    node.get("enabled")
                        .and_then(normalize_anthropic_thinking_mode)
                });
            let effort = node
                .get("effort")
                .and_then(normalize_anthropic_thinking_effort)
                .or_else(|| {
                    node.get("level")
                        .and_then(normalize_anthropic_thinking_effort)
                });
            let budget_tokens = node
                .get("budgetTokens")
                .and_then(normalize_anthropic_thinking_budget)
                .or_else(|| {
                    node.get("budget_tokens")
                        .and_then(normalize_anthropic_thinking_budget)
                })
                .or_else(|| {
                    node.get("budget")
                        .and_then(normalize_anthropic_thinking_budget)
                });
            if mode.is_none() && effort.is_none() && budget_tokens.is_none() {
                return None;
            }
            let mut out = Map::new();
            if let Some(mode) = mode {
                out.insert("mode".to_string(), Value::String(mode));
            }
            if let Some(effort) = effort {
                out.insert("effort".to_string(), Value::String(effort));
            }
            if let Some(budget_tokens) = budget_tokens {
                out.insert(
                    "budgetTokens".to_string(),
                    Value::Number(budget_tokens.into()),
                );
            }
            Some(Value::Object(out))
        }
        _ => None,
    }
}

fn read_anthropic_thinking_config(record: Option<&Map<String, Value>>) -> Option<Value> {
    let Some(record) = record else {
        return None;
    };
    for key in [
        "anthropicThinkingConfig",
        "anthropic_thinking_config",
        "anthropicThinking",
        "anthropic_thinking",
        "reasoning",
        "thinking",
    ] {
        if let Some(candidate) = record.get(key) {
            if let Some(normalized) = normalize_anthropic_thinking_config_value(candidate) {
                return Some(normalized);
            }
        }
    }
    let output_config =
        as_object(record.get("output_config")).or_else(|| as_object(record.get("outputConfig")));
    if let Some(output_config) = output_config {
        let mut synthetic = Map::new();
        if let Some(effort) = output_config.get("effort") {
            synthetic.insert("effort".to_string(), effort.clone());
        }
        if let Some(normalized) =
            normalize_anthropic_thinking_config_value(&Value::Object(synthetic))
        {
            return Some(normalized);
        }
    }
    None
}

fn read_anthropic_thinking_level(record: Option<&Map<String, Value>>) -> Option<String> {
    read_anthropic_thinking_config(record)
        .as_ref()
        .and_then(extract_anthropic_thinking_level_from_config)
}

fn read_anthropic_thinking_budgets(record: Option<&Map<String, Value>>) -> Option<Value> {
    let Some(record) = record else {
        return None;
    };
    for key in [
        "anthropicThinkingBudgets",
        "anthropic_thinking_budgets",
        "thinkingBudgets",
        "thinking_budgets",
        "reasoningBudgets",
    ] {
        if let Some(candidate) = record.get(key) {
            if let Some(normalized) = normalize_anthropic_thinking_budget_map(candidate) {
                return Some(normalized);
            }
        }
    }
    None
}

fn extract_anthropic_thinking_level_from_config(config: &Value) -> Option<String> {
    let Some(map) = config.as_object() else {
        return None;
    };
    map.get("effort")
        .and_then(Value::as_str)
        .map(|value| value.trim().to_lowercase())
        .filter(|value| !value.is_empty())
        .or_else(|| {
            map.get("mode")
                .and_then(Value::as_str)
                .map(|value| value.trim().to_lowercase())
                .filter(|value| !value.is_empty())
        })
}

fn resolve_context_tokens(runtime: &ProviderRuntimeProfileJson, model_id: &str) -> i64 {
    runtime
        .model_context_tokens
        .as_ref()
        .and_then(|map| map.get(model_id))
        .copied()
        .filter(|value| *value > 0)
        .or(runtime.default_context_tokens.filter(|value| *value > 0))
        .or(runtime.max_context_tokens.filter(|value| *value > 0))
        .unwrap_or(DEFAULT_MODEL_CONTEXT_TOKENS)
}

fn resolve_output_tokens(runtime: &ProviderRuntimeProfileJson, model_id: &str) -> Option<i64> {
    runtime
        .model_output_tokens
        .as_ref()
        .and_then(|map| map.get(model_id))
        .copied()
        .filter(|value| *value > 0)
        .or(runtime.default_output_tokens.filter(|value| *value > 0))
}

fn resolve_anthropic_thinking_config<'a>(
    runtime: &'a ProviderRuntimeProfileJson,
    model_id: &str,
) -> Option<&'a Value> {
    runtime
        .model_anthropic_thinking_config
        .as_ref()
        .and_then(|map| map.get(model_id))
        .or(runtime.anthropic_thinking_config.as_ref())
        .or(runtime.default_anthropic_thinking_config.as_ref())
}

fn resolve_anthropic_thinking(
    runtime: &ProviderRuntimeProfileJson,
    model_id: &str,
) -> Option<String> {
    if let Some(config) = resolve_anthropic_thinking_config(runtime, model_id) {
        if let Some(level) = extract_anthropic_thinking_level_from_config(config) {
            return Some(level);
        }
    }
    runtime
        .model_anthropic_thinking
        .as_ref()
        .and_then(|map| map.get(model_id).cloned())
        .or_else(|| runtime.default_anthropic_thinking.clone())
}

fn resolve_anthropic_thinking_budgets<'a>(
    runtime: &'a ProviderRuntimeProfileJson,
    model_id: &str,
) -> Option<&'a Value> {
    runtime
        .model_anthropic_thinking_budgets
        .as_ref()
        .and_then(|map| map.get(model_id))
        .or(runtime.anthropic_thinking_budgets.as_ref())
        .or(runtime.default_anthropic_thinking_budgets.as_ref())
}

fn for_each_model<F>(provider: &Map<String, Value>, mut cb: F)
where
    F: FnMut(String, &Map<String, Value>),
{
    let Some(models_value) = provider.get("models") else {
        return;
    };
    match models_value {
        Value::Array(items) => {
            for (index, item) in items.iter().enumerate() {
                let Some(model) = item.as_object() else {
                    continue;
                };
                let model_id =
                    read_optional_string(model.get("id")).unwrap_or_else(|| index.to_string());
                if !model_id.trim().is_empty() {
                    cb(model_id, model);
                }
            }
        }
        Value::Object(models_map) => {
            for (model_name, model_raw) in models_map {
                let Some(model) = model_raw.as_object() else {
                    continue;
                };
                let model_id = model_name.trim().to_string();
                if !model_id.is_empty() {
                    cb(model_id, model);
                }
            }
        }
        _ => {}
    }
}

fn parse_target_key(target_key: &str) -> Option<ParsedTargetKey> {
    let value = target_key.trim();
    if value.is_empty() {
        return None;
    }
    let first_dot = value.find('.')?;
    if first_dot == 0 || first_dot == value.len() - 1 {
        return None;
    }
    let provider_id = value[..first_dot].to_string();
    let remainder = &value[first_dot + 1..];
    let second_dot = remainder.find('.')?;
    if second_dot == 0 || second_dot == remainder.len() - 1 {
        return None;
    }
    Some(ParsedTargetKey {
        provider_id,
        key_alias: remainder[..second_dot].to_string(),
        model_id: remainder[second_dot + 1..].to_string(),
    })
}

fn build_runtime_key(provider_id: &str, key_alias: &str) -> String {
    format!("{}.{}", provider_id, key_alias)
}

fn normalize_enabled(value: Option<&Value>) -> Option<bool> {
    match value {
        Some(Value::Bool(enabled)) => Some(*enabled),
        Some(Value::String(raw)) => Some(raw.trim().to_lowercase() != "false"),
        _ => None,
    }
}

fn normalize_alias(candidate: Option<&str>, existing: &HashSet<String>) -> String {
    let base = candidate
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.to_string())
        .unwrap_or_else(|| format!("key{}", existing.len() + 1));
    let mut alias = base.clone();
    let mut index = 1;
    while existing.contains(&alias) {
        alias = format!("{}_{}", base, index);
        index += 1;
    }
    alias
}

fn read_optional_string(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.to_string())
}

fn as_object(value: Option<&Value>) -> Option<&Map<String, Value>> {
    value.and_then(Value::as_object)
}

fn parse_bool_like(value: &Value) -> Option<bool> {
    match value {
        Value::Bool(boolean) => Some(*boolean),
        Value::String(raw) => {
            let trimmed = raw.trim();
            if trimmed.is_empty() {
                None
            } else {
                Some(trimmed.eq_ignore_ascii_case("true"))
            }
        }
        _ => None,
    }
}

fn push_unique_string(list: &mut Vec<String>, seen: &mut HashSet<String>, value: String) {
    let trimmed = value.trim();
    if !trimmed.is_empty() && seen.insert(trimmed.to_string()) {
        list.push(trimmed.to_string());
    }
}
