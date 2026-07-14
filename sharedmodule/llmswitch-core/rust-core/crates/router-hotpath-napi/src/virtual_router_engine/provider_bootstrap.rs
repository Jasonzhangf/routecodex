use napi::bindgen_prelude::Result as NapiResult;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::{BTreeMap, BTreeSet, HashSet};

use crate::direct_semantic_classification::{validate_config_direct_02, DirectSemanticClass};
use crate::shared_json_utils::read_trimmed_string as read_optional_string;
use crate::virtual_router_engine::error::format_virtual_router_error;
use crate::virtual_router_engine::profile_utils::{
    build_runtime_key, normalize_capability_list, normalize_positive_integer, read_context_tokens,
};
use crate::virtual_router_engine::routing::push_unique_trimmed;

const DEFAULT_PROVIDER_MAX_OUTPUT_TOKENS: i64 = 8192;
const DEFAULT_MODEL_CONTEXT_TOKENS: i64 = 200_000;
const MODEL_CAPABILITY_ALLOWLIST: &[&str] = &[
    "text",
    "reasoning",
    "tools",
    "no_reasoning_summary",
    "multimodal",
    "vision",
    "video",
    "thinking",
    "web_search",
    "web_search_direct",
    "custom_tool",
];
const VISUAL_CAPABILITIES: &[&str] = &["multimodal", "vision", "video"];
const VISUAL_CAPABILITY_UNSUPPORTED_MODELS: &[&str] = &["gpt-5.3-codex-spark"];
const CUSTOM_TOOL_CAPABILITY_UNSUPPORTED_MODELS: &[&str] = &["gpt-5.3-codex-spark"];

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
    raw_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    token_file: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    entries: Option<Vec<Value>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProviderRuntimeProfileJson {
    runtime_key: String,
    provider_id: String,
    key_alias: String,
    provider_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    provider_module: Option<String>,
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
    extensions: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    server_tools_disabled: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    model_capabilities: Option<BTreeMap<String, Vec<String>>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    model_compatibility_profiles: Option<BTreeMap<String, String>>,
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
    #[serde(skip_serializing_if = "Option::is_none")]
    direct_semantic: Option<String>,
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
    extensions: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    server_tools_disabled: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    model_capabilities: Option<BTreeMap<String, Vec<String>>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    alias_to_model: Option<BTreeMap<String, String>>,
    direct_semantic: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct ModelIndexEntry {
    #[serde(default)]
    declared: bool,
    #[serde(default)]
    models: Vec<String>,
    #[serde(default)]
    alias_to_model: BTreeMap<String, String>,
    #[serde(default)]
    compatibility_profiles: BTreeMap<String, String>,
    #[serde(default)]
    direct_semantics: BTreeMap<String, String>,
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
    provider_module: Option<String>,
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
    extensions: Option<Value>,
    server_tools_disabled: bool,
    model_capabilities: Option<BTreeMap<String, Vec<String>>>,
    model_compatibility_profiles: Option<BTreeMap<String, String>>,
}

#[derive(Debug, Clone)]
struct ProviderAuthEntry {
    key_alias: String,
    auth: ProviderAuthConfigJson,
}

#[derive(Debug, Clone)]
struct AuthTypeInfo {
    auth_type: String,
    raw: Option<String>,
}

#[derive(Debug, Clone, Default)]
struct AuthFieldDefaults {
    secret_ref: Option<String>,
    token_file: Option<String>,
}

#[derive(Debug, Clone, Default)]
struct AuthCandidate {
    type_hint: Option<String>,
    raw_type: Option<String>,
    value: Option<String>,
    secret_ref: Option<String>,
    token_file: Option<String>,
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
        build_provider_profiles(&expanded_target_keys, &model_index, &runtime_entries).map_err(
            |error| napi::Error::from_reason(format_virtual_router_error("CONFIG_ERROR", error)),
        )?;
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
        let collected_models = collect_provider_models(provider)?;
        let auth_entries = extract_provider_auth_entries(provider_id, provider)?;
        if auth_entries.is_empty() {
            return Err(format!(
                "Provider {} requires at least one auth entry",
                provider_id
            ));
        }
        let mut aliases: Vec<String> = auth_entries
            .iter()
            .map(|entry| entry.key_alias.clone())
            .collect();
        alias_index.insert(provider_id.clone(), aliases);
        model_index.insert(provider_id.clone(), collected_models);

        for entry in auth_entries {
            let runtime_key = build_runtime_key(provider_id, &entry.key_alias);
            let mut runtime_auth = entry.auth.clone();
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
                    provider_module: normalized_provider.provider_module.clone(),
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
                    extensions: normalized_provider.extensions.clone(),
                    server_tools_disabled: if normalized_provider.server_tools_disabled {
                        Some(true)
                    } else {
                        None
                    },
                    model_capabilities: normalized_provider.model_capabilities.clone(),
                    model_compatibility_profiles: normalized_provider
                        .model_compatibility_profiles
                        .clone(),
                    model_id: None,
                    max_context_tokens: None,
                    anthropic_thinking_config: None,
                    anthropic_thinking: None,
                    anthropic_thinking_budgets: None,
                    direct_semantic: None,
                },
            );
        }
    }

    Ok((runtime_entries, alias_index, model_index))
}

fn build_provider_profiles(
    target_keys: &BTreeSet<String>,
    model_index: &BTreeMap<String, ModelIndexEntry>,
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
        let model_info = model_index.get(&parsed.provider_id).ok_or_else(|| {
            format!(
                "Routing target {} references unknown model index for provider {}",
                target_key, parsed.provider_id
            )
        })?;
        let canonical_model_id = if model_info.declared {
            resolve_canonical_model_id(&parsed.model_id, model_info).ok_or_else(|| {
                format!(
                    "Routing target {} references unknown model {} for provider {}",
                    target_key, parsed.model_id, parsed.provider_id
                )
            })?
        } else {
            parsed.model_id.clone()
        };

        let model_streaming_pref = runtime
            .model_streaming
            .as_ref()
            .and_then(|map| map.get(&canonical_model_id))
            .cloned();
        let streaming_pref = match runtime.streaming.as_deref() {
            Some("always") | Some("never") => runtime.streaming.clone(),
            _ => model_streaming_pref.or_else(|| runtime.streaming.clone()),
        };
        let context_tokens = resolve_context_tokens(runtime, &canonical_model_id);
        let output_tokens = resolve_output_tokens(runtime, &canonical_model_id);
        let anthropic_thinking_config =
            resolve_anthropic_thinking_config(runtime, &canonical_model_id).cloned();
        let anthropic_thinking = resolve_anthropic_thinking(runtime, &canonical_model_id);
        let anthropic_thinking_budgets =
            resolve_anthropic_thinking_budgets(runtime, &canonical_model_id).cloned();
        let compatibility_profile =
            resolve_model_compatibility_profile(runtime, model_info, &canonical_model_id);
        let direct_semantic = model_info
            .direct_semantics
            .get(&canonical_model_id)
            .cloned()
            .unwrap_or_else(|| "routing".to_string());

        profiles.insert(
            target_key.clone(),
            ProviderProfileJson {
                provider_key: target_key.clone(),
                provider_type: runtime.provider_type.clone(),
                endpoint: runtime.endpoint.clone(),
                auth: runtime.auth.clone(),
                enabled: runtime.enabled,
                outbound_profile: runtime.outbound_profile.clone(),
                compatibility_profile: compatibility_profile.clone(),
                runtime_key: Some(runtime_key.clone()),
                model_id: Some(canonical_model_id.clone()),
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
                extensions: runtime.extensions.clone(),
                server_tools_disabled: runtime.server_tools_disabled,
                model_capabilities: runtime.model_capabilities.clone(),
                alias_to_model: if model_info.alias_to_model.is_empty() {
                    None
                } else {
                    Some(model_info.alias_to_model.clone())
                },
                direct_semantic: direct_semantic.clone(),
            },
        );

        let mut resolved_runtime = runtime.clone();
        resolved_runtime.model_id = Some(canonical_model_id.clone());
        resolved_runtime.compatibility_profile = compatibility_profile;
        resolved_runtime.streaming = streaming_pref;
        resolved_runtime.max_context_tokens = Some(context_tokens);
        resolved_runtime.anthropic_thinking_config = anthropic_thinking_config;
        resolved_runtime.anthropic_thinking =
            resolve_anthropic_thinking(runtime, &canonical_model_id);
        resolved_runtime.anthropic_thinking_budgets = anthropic_thinking_budgets;
        resolved_runtime.direct_semantic = Some(direct_semantic);
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

fn resolve_canonical_model_id(model_id: &str, model_index: &ModelIndexEntry) -> Option<String> {
    let trimmed = model_id.trim();
    if trimmed.is_empty() {
        return None;
    }
    if model_index
        .models
        .iter()
        .any(|candidate| candidate == trimmed)
    {
        return Some(trimmed.to_string());
    }
    model_index.alias_to_model.get(trimmed).cloned()
}

fn normalize_provider(
    provider_id: &str,
    provider: &Map<String, Value>,
) -> Result<NormalizedProvider, String> {
    let enabled = normalize_enabled(provider.get("enabled"));
    let provider_type = detect_provider_type(provider);
    let provider_module = read_optional_string(provider.get("type"))
        .or_else(|| read_optional_string(provider.get("module")));
    let endpoint = read_optional_string(provider.get("endpoint"))
        .or_else(|| read_optional_string(provider.get("baseURL")))
        .or_else(|| read_optional_string(provider.get("baseUrl")))
        .unwrap_or_default();
    let compatibility_profile = resolve_compatibility_profile(provider_id, provider)?;
    let headers = normalize_headers(provider.get("headers"));
    let responses_node = as_object(provider.get("responses"));
    let responses_config = normalize_responses_config(
        provider_id,
        &provider_type,
        &compatibility_profile,
        provider,
        responses_node,
    );
    let process_mode = normalize_process_mode(provider_id, provider.get("process"))?;
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
    let deepseek = None;
    let server_tools_disabled = provider
        .get("serverToolsDisabled")
        .and_then(parse_bool_like)
        .unwrap_or(false)
        || as_object(provider.get("serverTools"))
            .and_then(|record| record.get("enabled"))
            .and_then(Value::as_bool)
            == Some(false);
    let model_capabilities = normalize_provider_model_capabilities(provider);
    let model_compatibility_profiles = normalize_model_compatibility_profiles(provider);

    Ok(NormalizedProvider {
        provider_type: provider_type.clone(),
        provider_module,
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
        extensions: normalize_provider_extensions(provider),
        server_tools_disabled,
        model_capabilities,
        model_compatibility_profiles,
    })
}

fn collect_provider_models(provider: &Map<String, Value>) -> Result<ModelIndexEntry, String> {
    let models_declared = provider.contains_key("models");
    let mut collected: Vec<String> = Vec::new();
    let mut alias_to_model: BTreeMap<String, String> = BTreeMap::new();
    let mut compatibility_profiles: BTreeMap<String, String> = BTreeMap::new();
    let mut direct_semantics: BTreeMap<String, String> = BTreeMap::new();
    let mut seen = HashSet::new();

    if let Some(models_value) = provider.get("models") {
        match models_value {
            Value::Array(items) => {
                for item in items {
                    let Some(model_obj) = item.as_object() else {
                        continue;
                    };
                    if let Some(model_id) = read_optional_string(model_obj.get("id")) {
                        let direct_semantic =
                            normalize_model_direct_semantic(&model_id, model_obj)?;
                        direct_semantics.insert(model_id.trim().to_string(), direct_semantic);
                        if let Some(profile) =
                            read_optional_string(model_obj.get("compatibilityProfile"))
                        {
                            compatibility_profiles.insert(model_id.trim().to_string(), profile);
                        }
                        push_unique_trimmed(&mut collected, &mut seen, &model_id);
                    }
                    if let Some(model_id) = read_optional_string(model_obj.get("id")) {
                        if let Some(alias) = read_optional_string(model_obj.get("alias")) {
                            push_model_alias(&mut alias_to_model, alias.trim(), model_id.trim())?;
                        }
                    }
                    if let Some(aliases) = model_obj.get("aliases").and_then(Value::as_array) {
                        for alias in aliases {
                            if let Some(value) = alias.as_str() {
                                push_model_alias(
                                    &mut alias_to_model,
                                    value.trim(),
                                    model_obj
                                        .get("id")
                                        .and_then(Value::as_str)
                                        .map(str::trim)
                                        .unwrap_or(""),
                                )?;
                            }
                        }
                    }
                }
            }
            Value::Object(models_map) => {
                for (model_name, model_raw) in models_map {
                    let canonical_model_id = model_name.trim().to_string();
                    push_unique_trimmed(&mut collected, &mut seen, &canonical_model_id);
                    if let Some(model_obj) = model_raw.as_object() {
                        let direct_semantic =
                            normalize_model_direct_semantic(&canonical_model_id, model_obj)?;
                        direct_semantics.insert(canonical_model_id.clone(), direct_semantic);
                        if let Some(profile) =
                            read_optional_string(model_obj.get("compatibilityProfile"))
                        {
                            compatibility_profiles.insert(canonical_model_id.clone(), profile);
                        }
                        if let Some(aliases) = model_obj.get("aliases").and_then(Value::as_array) {
                            for alias in aliases {
                                if let Some(value) = alias.as_str() {
                                    push_model_alias(
                                        &mut alias_to_model,
                                        value.trim(),
                                        &canonical_model_id,
                                    )?;
                                }
                            }
                        }
                    } else if !model_raw.is_null() {
                        return Err(format!(
                            "Provider model {} must be an object",
                            canonical_model_id
                        ));
                    } else {
                        direct_semantics.insert(canonical_model_id.clone(), "routing".to_string());
                    }
                }
            }
            _ => {}
        }
    }

    Ok(ModelIndexEntry {
        declared: models_declared,
        models: collected,
        alias_to_model,
        compatibility_profiles,
        direct_semantics,
    })
}

fn normalize_model_direct_semantic(
    model_id: &str,
    model: &Map<String, Value>,
) -> Result<String, String> {
    for forbidden in [
        "modelPassthrough",
        "thinkingPassthrough",
        "restoreResponseModel",
    ] {
        if model.contains_key(forbidden) {
            return Err(format!(
                "Provider model {} uses forbidden direct semantic field {}",
                model_id, forbidden
            ));
        }
    }
    Ok(
        match validate_config_direct_02(model_id, model.get("direct"))?.semantic_class {
            DirectSemanticClass::Routing => "routing",
            DirectSemanticClass::Passthrough => "passthrough",
        }
        .to_string(),
    )
}

fn push_model_alias(
    alias_to_model: &mut BTreeMap<String, String>,
    alias: &str,
    canonical_model_id: &str,
) -> Result<(), String> {
    let alias = alias.trim();
    let canonical = canonical_model_id.trim();
    if alias.is_empty() || canonical.is_empty() {
        return Ok(());
    }
    if let Some(existing) = alias_to_model.get(alias) {
        if existing != canonical {
            return Err(format!(
                "Model alias {} already maps to {} and cannot also map to {}",
                alias, existing, canonical
            ));
        }
        return Ok(());
    }
    alias_to_model.insert(alias.to_string(), canonical.to_string());
    Ok(())
}

fn extract_provider_auth_entries(
    provider_id: &str,
    provider: &Map<String, Value>,
) -> Result<Vec<ProviderAuthEntry>, String> {
    let auth = as_object(provider.get("auth")).cloned().unwrap_or_default();
    let mut entries: Vec<ProviderAuthEntry> = Vec::new();
    let mut alias_set = HashSet::new();
    let base_type_source = read_optional_string(auth.get("type"));
    let base_raw_type_source = read_optional_string(auth.get("rawType"));
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
                    &base_raw_type_source,
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
                    &base_raw_type_source,
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
                    &base_raw_type_source,
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
                            &base_raw_type_source,
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
            raw_type: base_raw_type_source.clone(),
            secret_ref: read_optional_string(auth.get("secretRef")),
            token_file: read_optional_string(auth.get("tokenFile"))
                .or_else(|| read_optional_string(auth.get("token_file"))),
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

    let base_raw_type = base_type_info
        .raw
        .as_deref()
        .unwrap_or_default()
        .trim()
        .to_lowercase();
    if is_removed_auth_type(base_raw_type.as_str()) {
        return Err(format!(
            "Provider {} uses removed non-apikey auth; configure auth.type=apikey",
            provider_id
        ));
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
                    raw_type: base_raw_type_source.clone(),
                    value: Some(String::new()),
                    token_file: read_optional_string(auth.get("tokenFile"))
                        .or_else(|| read_optional_string(auth.get("token_file"))),
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
    candidate.value.is_some() || candidate.secret_ref.is_some() || candidate.token_file.is_some()
}

fn auth_candidate_has_effective_material(
    candidate: &AuthCandidate,
    defaults: &AuthFieldDefaults,
) -> bool {
    candidate.value.is_some()
        || candidate.secret_ref.is_some()
        || candidate.token_file.is_some()
        || defaults.secret_ref.is_some()
        || defaults.token_file.is_some()
}

fn push_auth_entry_from_record(
    provider_id: &str,
    record: Option<&Map<String, Value>>,
    alias_override: Option<String>,
    base_type_source: &Option<String>,
    base_raw_type_source: &Option<String>,
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
    let raw_type_hint = read_optional_string(record.get("rawType"))
        .or_else(|| base_raw_type_source.clone())
        .or_else(|| type_hint.clone());
    let candidate = build_auth_candidate(
        type_hint,
        base_type_info,
        AuthCandidate {
            raw_type: raw_type_hint,
            value: read_optional_string(record.get("value"))
                .or_else(|| read_optional_string(record.get("apiKey"))),
            secret_ref: read_optional_string(record.get("secretRef")),
            token_file: read_optional_string(record.get("tokenFile"))
                .or_else(|| read_optional_string(record.get("token_file"))),
            ..Default::default()
        },
    );
    if !auth_candidate_has_effective_material(&candidate, defaults) {
        return Ok(());
    }
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
    let raw_type = extras
        .raw_type
        .clone()
        .or_else(|| type_info.raw.clone())
        .or_else(|| source.clone());
    extras.type_hint = type_info.raw.clone().or(source);
    extras.raw_type = raw_type;
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
    let raw_type_source = candidate
        .raw_type
        .clone()
        .or_else(|| candidate.type_hint.clone())
        .or_else(|| base_type_info.raw.clone())
        .unwrap_or_else(|| type_source.clone());
    let type_info = interpret_auth_type(Some(type_source.as_str()));
    let entry_type = type_info.auth_type;
    if entry_type != "apiKey" {
        return Err(format!("Provider {} auth.type must be apiKey", provider_id));
    }
    let raw_type_lower = raw_type_source.trim().to_lowercase();
    if is_removed_auth_type(raw_type_lower.as_str()) {
        return Err(format!(
            "Provider {} uses removed auth type {}; configure auth.type=apikey",
            provider_id, raw_type_source
        ));
    }

    let mut normalized = ProviderAuthConfigJson {
        auth_type: entry_type.clone(),
        raw_type: Some(raw_type_source.clone()),
        value: candidate.value.clone(),
        secret_ref: candidate
            .secret_ref
            .clone()
            .or_else(|| defaults.secret_ref.clone()),
        token_file: candidate
            .token_file
            .clone()
            .or_else(|| defaults.token_file.clone()),
        entries: None,
    };

    if normalized.auth_type == "apiKey"
        && normalized.secret_ref.is_none()
        && normalized.token_file.is_none()
    {
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
            .or_else(|| read_optional_string(auth.get("token_file"))),
    }
}

fn interpret_auth_type(value: Option<&str>) -> AuthTypeInfo {
    let Some(raw) = value.map(str::trim).filter(|value| !value.is_empty()) else {
        return AuthTypeInfo {
            auth_type: "apiKey".to_string(),
            raw: None,
        };
    };
    let lower = raw.to_lowercase();
    if lower == "apikey" || lower == "api-key" {
        return AuthTypeInfo {
            auth_type: "apiKey".to_string(),
            raw: Some(raw.to_string()),
        };
    }
    if is_removed_auth_type(lower.as_str()) {
        return AuthTypeInfo {
            auth_type: "removed".to_string(),
            raw: Some(raw.to_string()),
        };
    }
    AuthTypeInfo {
        auth_type: "apiKey".to_string(),
        raw: Some(raw.to_string()),
    }
}

fn is_removed_auth_type(lower_raw_type: &str) -> bool {
    lower_raw_type.contains("oauth")
        || lower_raw_type.contains("account")
        || lower_raw_type.contains("token")
}

#[cfg(test)]
mod alias_tests {
    use super::{
        bootstrap_virtual_router_provider_profiles_json, bootstrap_virtual_router_providers_json,
    };
    use serde_json::{json, Value};

    #[test]
    fn read_context_tokens_uses_largest_declared_context_window() {
        let record = json!({
            "maxContext": 1048576,
            "maxContextTokens": 200000,
            "contextWindow": 200000
        });
        let map = record.as_object().expect("record should be object");
        assert_eq!(super::read_context_tokens(Some(map)), Some(1048576));
    }

    #[test]
    fn provider_bootstrap_strips_visual_capabilities_from_known_non_visual_model() {
        let providers = json!({
            "YKK": {
                "id": "YKK",
                "enabled": true,
                "type": "openai",
                "baseURL": "https://example.invalid/v1",
                "auth": {
                    "type": "apikey",
                    "entries": [{ "alias": "key1", "apiKey": "test" }]
                },
                "models": {
                    "gpt-5.3-codex-spark": {
                        "capabilities": [
                            "tools",
                            "thinking",
                            "multimodal",
                            "vision",
                            "video",
                            "no_reasoning_summary"
                        ]
                    }
                }
            }
        });

        let providers_bootstrap =
            bootstrap_virtual_router_providers_json(providers.to_string()).unwrap();
        let output: Value = serde_json::from_str(&providers_bootstrap).unwrap();
        let capabilities = output["runtimeEntries"]["YKK.key1"]["modelCapabilities"]
            ["gpt-5.3-codex-spark"]
            .as_array()
            .expect("model capabilities");

        assert!(capabilities.contains(&json!("thinking")));
        assert!(capabilities.contains(&json!("no_reasoning_summary")));
        assert!(!capabilities.contains(&json!("multimodal")));
        assert!(!capabilities.contains(&json!("vision")));
        assert!(!capabilities.contains(&json!("video")));
        assert!(!capabilities.contains(&json!("custom_tool")));
    }

    #[test]
    fn provider_bootstrap_derives_custom_tool_capability_from_tools() {
        let providers = json!({
            "YKK": {
                "id": "YKK",
                "enabled": true,
                "type": "openai",
                "baseURL": "https://example.invalid/v1",
                "auth": {
                    "type": "apikey",
                    "entries": [{ "alias": "key1", "apiKey": "test" }]
                },
                "models": {
                    "gpt-5.4-mini": {
                        "capabilities": ["text", "tools"]
                    }
                }
            }
        });

        let providers_bootstrap =
            bootstrap_virtual_router_providers_json(providers.to_string()).unwrap();
        let output: Value = serde_json::from_str(&providers_bootstrap).unwrap();
        let capabilities = output["runtimeEntries"]["YKK.key1"]["modelCapabilities"]
            ["gpt-5.4-mini"]
            .as_array()
            .expect("model capabilities");

        assert!(capabilities.contains(&json!("tools")));
        assert!(capabilities.contains(&json!("custom_tool")));
    }

    #[test]
    fn provider_bootstrap_preserves_canonical_model_ids_when_alias_is_used() {
        let providers = json!({
            "DF": {
                "id": "DF",
                "enabled": true,
                "type": "openai",
                "baseURL": "https://example.invalid/v1",
                "auth": {
                    "type": "apikey",
                    "entries": [{ "alias": "key1", "apiKey": "test" }]
                },
                "models": {
                    "DeepSeek-V4-Pro": {
                        "aliases": ["deepseek-v4-pro"],
                        "supportsStreaming": true,
                        "maxContext": 1048576
                    },
                    "DeepSeek-V4-Flash": {
                        "aliases": ["deepseek-v4-flash"],
                        "supportsStreaming": true,
                        "maxContext": 1048576
                    }
                }
            }
        });

        let providers_bootstrap =
            bootstrap_virtual_router_providers_json(providers.to_string()).unwrap();
        let providers_bootstrap_json: Value = serde_json::from_str(&providers_bootstrap).unwrap();
        let alias_index = providers_bootstrap_json["aliasIndex"].clone();
        let model_index = providers_bootstrap_json["modelIndex"].clone();
        let runtime_entries = providers_bootstrap_json["runtimeEntries"].clone();

        let routed_target_keys = json!(["DF.key1.deepseek-v4-pro"]);
        let profiles = bootstrap_virtual_router_provider_profiles_json(
            routed_target_keys.to_string(),
            alias_index.to_string(),
            model_index.to_string(),
            runtime_entries.to_string(),
        )
        .unwrap();
        let output: Value = serde_json::from_str(&profiles).unwrap();

        assert_eq!(
            output["profiles"]["DF.key1.deepseek-v4-pro"]["modelId"],
            json!("DeepSeek-V4-Pro")
        );
        assert_eq!(
            output["targetRuntime"]["DF.key1.deepseek-v4-pro"]["modelId"],
            json!("DeepSeek-V4-Pro")
        );
    }

    #[test]
    fn provider_bootstrap_compiles_model_direct_semantics_with_routing_default() {
        let providers = json!({
            "DS": {
                "id": "DS",
                "enabled": true,
                "type": "openai",
                "baseURL": "https://example.invalid/v1",
                "auth": {
                    "type": "apikey",
                    "entries": [{ "alias": "key1", "apiKey": "test" }]
                },
                "models": {
                    "routing-model": {},
                    "passthrough-model": {
                        "direct": { "semantics": "passthrough" }
                    }
                }
            }
        });

        let providers_bootstrap =
            bootstrap_virtual_router_providers_json(providers.to_string()).unwrap();
        let providers_bootstrap_json: Value = serde_json::from_str(&providers_bootstrap).unwrap();
        let profiles = bootstrap_virtual_router_provider_profiles_json(
            json!(["DS.key1.routing-model", "DS.key1.passthrough-model"]).to_string(),
            providers_bootstrap_json["aliasIndex"].to_string(),
            providers_bootstrap_json["modelIndex"].to_string(),
            providers_bootstrap_json["runtimeEntries"].to_string(),
        )
        .unwrap();
        let output: Value = serde_json::from_str(&profiles).unwrap();

        assert_eq!(
            output["profiles"]["DS.key1.routing-model"]["directSemantic"],
            json!("routing")
        );
        assert_eq!(
            output["profiles"]["DS.key1.passthrough-model"]["directSemantic"],
            json!("passthrough")
        );
        assert_eq!(
            output["targetRuntime"]["DS.key1.passthrough-model"]["directSemantic"],
            json!("passthrough")
        );
    }

    #[test]
    fn provider_bootstrap_rejects_invalid_direct_semantic_authoring() {
        for direct in [
            json!({"semantics": ""}),
            json!({"semantics": "unknown"}),
            json!({"semantics": []}),
            json!({"modelPassthrough": true}),
        ] {
            let providers = json!({
                "DS": {
                    "id": "DS",
                    "enabled": true,
                    "type": "openai",
                    "baseURL": "https://example.invalid/v1",
                    "auth": {
                        "type": "apikey",
                        "entries": [{ "alias": "key1", "apiKey": "test" }]
                    },
                    "models": {
                        "model": { "direct": direct }
                    }
                }
            });
            assert!(bootstrap_virtual_router_providers_json(providers.to_string()).is_err());
        }
    }

    #[test]
    fn provider_bootstrap_applies_model_level_compatibility_profile_only_to_target_model() {
        let providers = json!({
            "XLC": {
                "id": "XLC",
                "enabled": true,
                "type": "openai",
                "baseURL": "https://xlapis.com/v1",
                "auth": {
                    "type": "apikey",
                    "entries": [{ "alias": "key1", "apiKey": "test" }]
                },
                "models": {
                    "glm-5.2": {
                        "compatibilityProfile": "chat:glm",
                        "supportsStreaming": true,
                        "maxContext": 1048576
                    },
                    "deepseek-v4-pro": {
                        "supportsStreaming": true,
                        "maxContext": 1048576
                    }
                }
            }
        });

        let providers_bootstrap =
            bootstrap_virtual_router_providers_json(providers.to_string()).unwrap();
        let providers_bootstrap_json: Value = serde_json::from_str(&providers_bootstrap).unwrap();
        let alias_index = providers_bootstrap_json["aliasIndex"].clone();
        let model_index = providers_bootstrap_json["modelIndex"].clone();
        let runtime_entries = providers_bootstrap_json["runtimeEntries"].clone();

        let routed_target_keys = json!(["XLC.key1.glm-5.2", "XLC.key1.deepseek-v4-pro"]);
        let profiles = bootstrap_virtual_router_provider_profiles_json(
            routed_target_keys.to_string(),
            alias_index.to_string(),
            model_index.to_string(),
            runtime_entries.to_string(),
        )
        .unwrap();
        let output: Value = serde_json::from_str(&profiles).unwrap();

        assert_eq!(
            output["profiles"]["XLC.key1.glm-5.2"]["compatibilityProfile"],
            json!("chat:glm")
        );
        assert_eq!(
            output["targetRuntime"]["XLC.key1.glm-5.2"]["compatibilityProfile"],
            json!("chat:glm")
        );
        assert_eq!(
            output["profiles"]["XLC.key1.deepseek-v4-pro"]["compatibilityProfile"],
            json!("compat:passthrough")
        );
        assert_eq!(
            output["targetRuntime"]["XLC.key1.deepseek-v4-pro"]["compatibilityProfile"],
            json!("compat:passthrough")
        );
    }

    #[test]
    fn provider_bootstrap_defaults_lmstudio_responses_to_responses_lmstudio_profile() {
        let providers = json!({
            "lmstudio": {
                "id": "lmstudio",
                "enabled": true,
                "type": "responses",
                "baseURL": "http://127.0.0.1:1234/v1",
                "auth": {
                    "type": "apikey",
                    "apiKey": "lm-studio"
                },
                "models": {
                    "ornith-1.0-397b": {
                        "supportsStreaming": true,
                        "maxContext": 131072
                    }
                }
            }
        });

        let providers_bootstrap =
            bootstrap_virtual_router_providers_json(providers.to_string()).unwrap();
        let providers_bootstrap_json: Value = serde_json::from_str(&providers_bootstrap).unwrap();
        let profiles = bootstrap_virtual_router_provider_profiles_json(
            json!(["lmstudio.key1.ornith-1.0-397b"]).to_string(),
            providers_bootstrap_json["aliasIndex"].to_string(),
            providers_bootstrap_json["modelIndex"].to_string(),
            providers_bootstrap_json["runtimeEntries"].to_string(),
        )
        .unwrap();
        let output: Value = serde_json::from_str(&profiles).unwrap();

        assert_eq!(
            output["profiles"]["lmstudio.key1.ornith-1.0-397b"]["compatibilityProfile"],
            json!("responses:lmstudio")
        );
        assert_eq!(
            output["targetRuntime"]["lmstudio.key1.ornith-1.0-397b"]["compatibilityProfile"],
            json!("responses:lmstudio")
        );
    }

    #[test]
    fn provider_bootstrap_rejects_removed_oauth_and_account_auth() {
        let oauth_provider = json!({
            "P": {
                "id": "P",
                "enabled": true,
                "type": "openai",
                "baseURL": "https://example.invalid/v1",
                "auth": { "type": "oauth" },
                "models": { "m": {} }
            }
        });
        assert!(bootstrap_virtual_router_providers_json(oauth_provider.to_string()).is_err());

        let account_provider = json!({
            "P": {
                "id": "P",
                "enabled": true,
                "type": "openai",
                "baseURL": "https://example.invalid/v1",
                "auth": { "type": "legacy-account" },
                "models": { "m": {} }
            }
        });
        assert!(bootstrap_virtual_router_providers_json(account_provider.to_string()).is_err());
    }
}

fn normalize_provider_extensions(_provider: &Map<String, Value>) -> Option<Value> {
    None
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
    if normalized_id == "lmstudio" && provider_type.contains("responses") {
        return Ok("responses:lmstudio".to_string());
    }
    Ok("compat:passthrough".to_string())
}

fn normalize_process_mode(provider_id: &str, value: Option<&Value>) -> Result<String, String> {
    let normalized = value
        .and_then(Value::as_str)
        .map(|value| value.trim().to_lowercase())
        .unwrap_or_else(|| "chat".to_string());
    if normalized.is_empty() || normalized == "chat" {
        return Ok("chat".to_string());
    }
    Err(format!(
        "Provider \"{}\" process=\"{}\" is invalid. Hub Pipeline only supports process=\"chat\".",
        provider_id, normalized
    ))
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

fn normalize_provider_model_capabilities(
    provider: &Map<String, Value>,
) -> Option<BTreeMap<String, Vec<String>>> {
    let mut result = BTreeMap::new();
    for_each_model(provider, |model_id, model| {
        let Some(capabilities) = model.get("capabilities").and_then(Value::as_array) else {
            return;
        };
        let mut valid = normalize_capability_list(
            &Value::Array(capabilities.clone()),
            Some(MODEL_CAPABILITY_ALLOWLIST),
        );
        if model_disallows_visual_capability(&model_id) {
            valid.retain(|capability| !VISUAL_CAPABILITIES.contains(&capability.as_str()));
        }
        if valid.iter().any(|capability| capability == "tools")
            && !model_disallows_custom_tool_capability(&model_id)
            && !valid.iter().any(|capability| capability == "custom_tool")
        {
            valid.push("custom_tool".to_string());
        }
        if model_disallows_custom_tool_capability(&model_id) {
            valid.retain(|capability| capability != "custom_tool");
        }
        if !valid.is_empty() {
            result.insert(model_id, valid);
        }
    });
    // Propagate capabilities from parent model to its aliases.
    // Alias targets like deepseek-v4-vision / deepseek-v4-flash-search
    // inherit their parent model's capabilities so the registry can
    // filter multimodal/web_search pools correctly.
    let mut alias_caps: Vec<(String, String, Vec<String>)> = Vec::new();
    for (model_id, caps) in result.iter() {
        if let Some(model_obj) = resolve_model_by_id(provider, model_id) {
            if let Some(aliases) = model_obj.get("aliases").and_then(Value::as_array) {
                for alias in aliases {
                    if let Some(alias_name) = alias.as_str() {
                        let trimmed = alias_name.trim().to_string();
                        if !trimmed.is_empty() && trimmed != *model_id {
                            alias_caps.push((trimmed, model_id.clone(), caps.clone()));
                        }
                    }
                }
            }
        }
    }
    for (alias_name, _parent_id, caps) in alias_caps {
        if !result.contains_key(&alias_name) {
            result.insert(alias_name, caps);
        }
    }
    if result.is_empty() {
        None
    } else {
        Some(result)
    }
}

fn model_disallows_visual_capability(model_id: &str) -> bool {
    let normalized = model_id.trim().to_ascii_lowercase();
    VISUAL_CAPABILITY_UNSUPPORTED_MODELS
        .iter()
        .any(|model| normalized == *model)
}

fn model_disallows_custom_tool_capability(model_id: &str) -> bool {
    let normalized = model_id.trim().to_ascii_lowercase();
    CUSTOM_TOOL_CAPABILITY_UNSUPPORTED_MODELS
        .iter()
        .any(|model| normalized == *model)
}

fn normalize_model_compatibility_profiles(
    provider: &Map<String, Value>,
) -> Option<BTreeMap<String, String>> {
    let mut result = BTreeMap::new();
    for_each_model(provider, |model_id, model| {
        if let Some(profile) = read_optional_string(model.get("compatibilityProfile")) {
            result.insert(model_id, profile);
        }
    });
    if result.is_empty() {
        None
    } else {
        Some(result)
    }
}

fn resolve_model_by_id<'a>(
    provider: &'a Map<String, Value>,
    target_id: &str,
) -> Option<&'a Map<String, Value>> {
    let models = provider.get("models")?;
    match models {
        Value::Array(items) => {
            for item in items {
                if let Some(obj) = item.as_object() {
                    if obj.get("id").and_then(|v| v.as_str()).unwrap_or("").trim() == target_id {
                        return Some(obj);
                    }
                }
            }
        }
        Value::Object(map) => {
            if let Some(obj) = map.get(target_id).and_then(|v| v.as_object()) {
                return Some(obj);
            }
        }
        _ => {}
    }
    None
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
            } else if [
                "low",
                "medium",
                "high",
                "max",
                "xhigh",
                "extra_high",
                "extra-high",
            ]
            .contains(&normalized.as_str())
            {
                if ["max", "xhigh", "extra_high", "extra-high"].contains(&normalized.as_str()) {
                    Some("high".to_string())
                } else {
                    Some(normalized)
                }
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

fn resolve_model_compatibility_profile(
    runtime: &ProviderRuntimeProfileJson,
    model_info: &ModelIndexEntry,
    model_id: &str,
) -> Option<String> {
    model_info
        .compatibility_profiles
        .get(model_id)
        .cloned()
        .or_else(|| {
            runtime
                .model_compatibility_profiles
                .as_ref()
                .and_then(|map| map.get(model_id).cloned())
        })
        .or_else(|| runtime.compatibility_profile.clone())
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
