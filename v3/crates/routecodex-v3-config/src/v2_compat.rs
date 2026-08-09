// feature_id: v3.v2_config_toml_compat_5555
use crate::{
    provider_directory::{V3Config02AuthoringResolved, V3ProviderDirectorySource},
    validation, V3Config02AuthoringParsed, V3ConfigError, V3ForwarderAuthoringConfig,
    V3ForwarderTargetAuthoringConfig, V3PipelinesAuthoringConfig, V3ProviderAuthAuthoringConfig,
    V3ProviderAuthEntryAuthoringConfig, V3ProviderAuthType, V3ProviderAuthoringConfig,
    V3ProviderConcurrencyAuthoringConfig, V3ProviderHealthAuthoringConfig,
    V3ProviderModelAuthoringConfig, V3ProviderRequestCleanupAuthoringConfig,
    V3ProviderResponsesAuthoringConfig, V3ProviderSemanticErrorPolicyAuthoringConfig,
    V3ResponsesTransportKind, V3RouteGroupAuthoringConfig, V3RoutePoolAuthoringConfig,
    V3RoutePoolMatchAuthoringConfig, V3RoutePoolTargetAuthoringConfig, V3RouteTargetKind,
    V3SelectionPolicy, V3SelectionStrategy, V3ServerAuthoringConfig, V3StreamingPolicy,
    V3WebSearchExecutionMode,
};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::Path;
use std::sync::LazyLock;

/// provider per-request 总超时默认值（毫秒）：300s。
pub(crate) const DEFAULT_PROVIDER_REQUEST_TIMEOUT_MS: u64 = 300_000;

pub(crate) fn compile_v2_config_02_authoring_from_file(
    config_path: &Path,
    raw: &str,
) -> Result<Option<V3Config02AuthoringResolved>, V3ConfigError> {
    if !looks_like_v2_root(raw) {
        return Ok(None);
    }
    let root: V2RootConfig = toml::from_str(raw)?;
    if root.version.trim() != "2.0.0" {
        return Err(validation(format!(
            "v2 config root version {} is unsupported",
            root.version
        )));
    }
    if root.virtualrouter_mode.as_deref() != Some("v2") {
        return Err(validation(
            "v2 config root must declare virtualrouterMode = \"v2\"",
        ));
    }
    let config_dir = config_path.parent().ok_or_else(|| {
        validation(format!(
            "v2 config path {} has no parent directory",
            config_path.display()
        ))
    })?;
    compile_v2_root(config_dir, root).map(Some)
}

fn looks_like_v2_root(raw: &str) -> bool {
    raw.contains("version = \"2.0.0\"")
        || raw.contains("version='2.0.0'")
        || raw.contains("virtualrouterMode = \"v2\"")
        || raw.contains("virtualrouterMode='v2'")
        || raw.contains("[httpserver]")
        || raw.contains("[virtualrouter]")
}

fn compile_v2_root(
    config_dir: &Path,
    root: V2RootConfig,
) -> Result<V3Config02AuthoringResolved, V3ConfigError> {
    let router_ports = root
        .httpserver
        .ports
        .into_iter()
        .filter(|port| port.mode.as_deref().unwrap_or("router") == "router")
        .collect::<Vec<_>>();
    if router_ports.is_empty() {
        return Err(validation("v2 config has no router httpserver.ports"));
    }

    let mut referenced_forwarders = BTreeSet::new();
    for port in &router_ports {
        let group_id = port.routing_policy_group.as_deref().ok_or_else(|| {
            validation(format!(
                "v2 router port {} missing routingPolicyGroup",
                port.port
            ))
        })?;
        let group = root
            .virtualrouter
            .routing_policy_groups
            .get(group_id)
            .ok_or_else(|| {
                validation(format!(
                    "v2 router port {} references unknown routingPolicyGroup {group_id}",
                    port.port
                ))
            })?;
        for routes in group.routing.values() {
            for route in routes {
                for target in &route.targets {
                    referenced_forwarders.insert(target.clone());
                }
            }
        }
    }

    let forwarders = compile_v2_forwarders(&root.virtualrouter.forwarders, &referenced_forwarders)?;
    let (providers, provider_sources) = compile_v2_providers(config_dir, &forwarders)?;
    let available_protocols = available_entry_protocols(&providers);
    let servers = compile_v2_servers(router_ports, &available_protocols)?;
    let long_context_threshold_tokens = root
        .virtualrouter
        .classifier
        .as_ref()
        .and_then(|classifier| classifier.long_context_threshold_tokens)
        .unwrap_or(180_000);
    let route_groups = compile_v2_route_groups(
        root.virtualrouter.routing_policy_groups,
        long_context_threshold_tokens,
    )?;

    Ok(V3Config02AuthoringResolved {
        authoring: V3Config02AuthoringParsed {
            version: 3,
            pipelines: V3PipelinesAuthoringConfig {
                hub_v1: Some(crate::defaults::default_hub_v1_authoring()),
            },
            servers,
            providers,
            forwarders,
            route_groups,
            features: BTreeMap::from([
                ("responses_direct".to_string(), true),
                ("debug_events".to_string(), true),
            ]),
            debug: Default::default(),
            error: Default::default(),
        },
        provider_sources,
    })
}

fn compile_v2_servers(
    ports: Vec<V2HttpServerPort>,
    available_protocols: &BTreeSet<String>,
) -> Result<BTreeMap<String, V3ServerAuthoringConfig>, V3ConfigError> {
    ports
        .into_iter()
        .map(|port| {
            let group = port.routing_policy_group.ok_or_else(|| {
                validation(format!(
                    "v2 router port {} missing routingPolicyGroup",
                    port.port
                ))
            })?;
            let id = port
                .name
                .unwrap_or_else(|| format!("v2_router_{}", port.port));
            let endpoints = ["responses", "anthropic", "gemini", "openai_chat"]
                .into_iter()
                .filter(|protocol| available_protocols.contains(*protocol))
                .map(ToOwned::to_owned)
                .collect::<Vec<_>>();
            if endpoints.is_empty() {
                return Err(validation(format!(
                    "v2 router port {} has no enabled protocol providers",
                    port.port
                )));
            }
            Ok((
                id,
                V3ServerAuthoringConfig {
                    enabled: true,
                    bind: port.host.unwrap_or_else(|| "0.0.0.0".to_string()),
                    port: port.port,
                    routing_group: group,
                    endpoints,
                    features: BTreeMap::new(),
                    execution: Some(crate::defaults::default_server_execution()),
                    expose_models: Vec::new(),
                },
            ))
        })
        .collect()
}

fn available_entry_protocols(
    providers: &BTreeMap<String, V3ProviderAuthoringConfig>,
) -> BTreeSet<String> {
    let mut protocols = BTreeSet::new();
    for provider in providers.values().filter(|provider| provider.enabled) {
        match provider.provider_type.as_str() {
            "anthropic" => {
                protocols.insert("anthropic".to_string());
                protocols.insert("responses".to_string());
            }
            "openai_chat" => {
                protocols.insert("openai_chat".to_string());
                protocols.insert("responses".to_string());
            }
            "responses" => {
                protocols.insert("responses".to_string());
            }
            "gemini" => {
                protocols.insert("gemini".to_string());
            }
            value => {
                protocols.insert(value.to_string());
            }
        }
    }
    protocols
}

fn compile_v2_forwarders(
    forwarders: &BTreeMap<String, V2ForwarderConfig>,
    referenced_forwarders: &BTreeSet<String>,
) -> Result<BTreeMap<String, V3ForwarderAuthoringConfig>, V3ConfigError> {
    referenced_forwarders
        .iter()
        .map(|id| {
            let forwarder = forwarders
                .get(id)
                .ok_or_else(|| validation(format!("v2 route references unknown forwarder {id}")))?;
            let strategy = selection_strategy(forwarder.strategy.as_deref());
            let targets = forwarder
                .targets
                .iter()
                .filter(|target| !target.disabled.unwrap_or(false))
                .enumerate()
                .map(|(index, target)| V3ForwarderTargetAuthoringConfig {
                    kind: V3RouteTargetKind::ProviderModel,
                    id: None,
                    provider: Some(target.provider_id.clone()),
                    model: Some(forwarder.model.clone()),
                    key: target.alias.clone(),
                    priority: Some(target.priority.unwrap_or((index + 1) as i32)),
                    weight: Some(target.weight.unwrap_or(1)),
                })
                .collect::<Vec<_>>();
            if targets.is_empty() {
                return Err(validation(format!(
                    "v2 forwarder {id} has no enabled targets"
                )));
            }
            Ok((
                id.clone(),
                V3ForwarderAuthoringConfig {
                    enabled: true,
                    model: forwarder.model.clone(),
                    aliases: Vec::new(),
                    selection: V3SelectionPolicy { strategy },
                    targets,
                    features: BTreeMap::new(),
                },
            ))
        })
        .collect()
}

fn compile_v2_route_groups(
    groups: BTreeMap<String, V2RoutingPolicyGroup>,
    long_context_threshold_tokens: u64,
) -> Result<BTreeMap<String, V3RouteGroupAuthoringConfig>, V3ConfigError> {
    groups
        .into_iter()
        .map(|(group_id, group)| {
            let mut pools = BTreeMap::new();
            for (route_id, mut routes) in group.routing {
                routes.sort_by_key(|route| std::cmp::Reverse(route.priority.unwrap_or(0)));
                // v2 declares loadBalancing per tier; v3 pools have one policy,
                // so the highest-priority tier that declares one wins.
                let load_balancing = routes
                    .iter()
                    .find_map(|route| route.load_balancing.as_ref());
                let strategy = load_balancing
                    .map(|policy| selection_strategy(policy.strategy.as_deref()))
                    .unwrap_or(V3SelectionStrategy::Priority);
                let tier_weights = load_balancing
                    .map(|policy| policy.weights.clone())
                    .unwrap_or_default();
                let mut targets = Vec::new();
                let mut next_priority = 1_i32;
                for route in &routes {
                    for target_id in &route.targets {
                        let weight = tier_weights
                            .get(target_id)
                            .map(|value| (value.round().max(1.0)) as u32)
                            .unwrap_or(1);
                        targets.push(V3RoutePoolTargetAuthoringConfig {
                            kind: V3RouteTargetKind::Forwarder,
                            id: Some(target_id.clone()),
                            provider: None,
                            model: None,
                            key: None,
                            priority: Some(next_priority),
                            weight: Some(weight),
                        });
                        next_priority += 1;
                    }
                }
                if targets.is_empty() {
                    return Err(validation(format!(
                        "v2 route group {group_id} route {route_id} has no targets"
                    )));
                }
                let match_rule = if route_id == "default" {
                    None
                } else {
                    let is_long_context = route_id == "longcontext";
                    Some(V3RoutePoolMatchAuthoringConfig {
                        precedence: Some(route_precedence(&route_id)),
                        entry_protocol: None,
                        models: Vec::new(),
                        required_capabilities: if is_long_context {
                            Vec::new()
                        } else {
                            vec![route_id.clone()]
                        },
                        min_input_tokens: is_long_context.then_some(long_context_threshold_tokens),
                        max_input_tokens: None,
                    })
                };
                pools.insert(
                    route_id.clone(),
                    V3RoutePoolAuthoringConfig {
                        selection: V3SelectionPolicy { strategy },
                        match_rule,
                        targets,
                        features: BTreeMap::new(),
                    },
                );
            }
            if !pools.contains_key("default") {
                return Err(validation(format!(
                    "v2 route group {group_id} must declare routing.default"
                )));
            }
            Ok((
                group_id.clone(),
                V3RouteGroupAuthoringConfig {
                    pools,
                    features: BTreeMap::new(),
                },
            ))
        })
        .collect()
}

fn route_precedence(route_id: &str) -> i32 {
    match route_id {
        "multimodal" | "vision" => 10,
        "web_search" => 20,
        "longcontext" => 30,
        "thinking" => 40,
        "coding" => 50,
        "search" => 60,
        "tools" => 70,
        _ => 100,
    }
}

fn compile_v2_providers(
    config_dir: &Path,
    forwarders: &BTreeMap<String, V3ForwarderAuthoringConfig>,
) -> Result<
    (
        BTreeMap<String, V3ProviderAuthoringConfig>,
        Vec<V3ProviderDirectorySource>,
    ),
    V3ConfigError,
> {
    let mut referenced_models = BTreeMap::<String, BTreeSet<String>>::new();
    for forwarder in forwarders.values() {
        for target in &forwarder.targets {
            if let Some(provider) = &target.provider {
                let models = referenced_models.entry(provider.clone()).or_default();
                if let Some(model) = &target.model {
                    models.insert(model.clone());
                }
            }
        }
    }
    compile_v2_provider_directory(config_dir, &referenced_models)
}

pub(crate) fn compile_v2_provider_directory(
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
        let models = compile_v2_provider_models(provider.models, Some(selected_models));
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

fn resolve_v2_provider_default_compatibility_profile(provider_id: &str) -> Option<String> {
    static PROVIDER_RESOLUTION_CONFIG: LazyLock<V2ProviderResolutionConfig> = LazyLock::new(|| {
        serde_json::from_str(include_str!(
            "../../../../sharedmodule/llmswitch-core/src/conversion/compat/provider-resolution-config.json"
        ))
        .expect("V2 provider resolution compatibility profile config must parse")
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
    let entries = if let Some(entries) = auth.entries {
        entries
    } else {
        vec![V2ProviderAuthEntry {
            alias: Some("key1".to_string()),
            api_key: auth.api_key,
            env: auth.env,
            token_file: auth.token_file,
        }]
    };
    let mut v3_entries = Vec::new();
    for entry in entries {
        let alias = entry.alias.unwrap_or_else(|| "key1".to_string());
        let handle_count = usize::from(entry.env.is_some())
            + usize::from(entry.token_file.is_some())
            + usize::from(entry.api_key.is_some());
        if handle_count != 1 {
            return Err(validation(format!(
                "v2 provider {provider_id} auth {alias} must declare exactly one of apiKey, env, or tokenFile"
            )));
        }
        if let Some(env) = entry.env {
            v3_entries.push(V3ProviderAuthEntryAuthoringConfig {
                alias,
                env: Some(env),
                token_file: None,
                api_key: None,
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
                env: None,
                token_file: Some(token_file.to_string()),
                api_key: None,
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
            env: None,
            token_file: None,
            api_key: Some(api_key),
        });
    }
    Ok(V3ProviderAuthAuthoringConfig {
        auth_type: V3ProviderAuthType::ApiKey,
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
                    wire_name: model.wire_name.or_else(|| Some(id)),
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

fn selection_strategy(value: Option<&str>) -> V3SelectionStrategy {
    match value {
        Some("weighted") => V3SelectionStrategy::Weighted,
        Some("round-robin") | Some("round_robin") => V3SelectionStrategy::RoundRobin,
        _ => V3SelectionStrategy::Priority,
    }
}

fn streaming_policy(value: Option<&str>) -> Option<V3StreamingPolicy> {
    match value {
        Some("always") => Some(V3StreamingPolicy::Always),
        Some("client") => Some(V3StreamingPolicy::Client),
        Some("never") => Some(V3StreamingPolicy::Never),
        _ => None,
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct V2RootConfig {
    version: String,
    virtualrouter_mode: Option<String>,
    httpserver: V2HttpServer,
    virtualrouter: V2VirtualRouter,
}

#[derive(Debug, Deserialize)]
struct V2HttpServer {
    #[serde(default)]
    ports: Vec<V2HttpServerPort>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct V2HttpServerPort {
    name: Option<String>,
    port: u16,
    host: Option<String>,
    mode: Option<String>,
    routing_policy_group: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct V2VirtualRouter {
    classifier: Option<V2ClassifierConfig>,
    #[serde(default)]
    forwarders: BTreeMap<String, V2ForwarderConfig>,
    #[serde(default)]
    routing_policy_groups: BTreeMap<String, V2RoutingPolicyGroup>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct V2ClassifierConfig {
    long_context_threshold_tokens: Option<u64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct V2ForwarderConfig {
    model: String,
    strategy: Option<String>,
    #[serde(default)]
    targets: Vec<V2ForwarderTarget>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct V2ForwarderTarget {
    provider_id: String,
    alias: Option<String>,
    priority: Option<i32>,
    weight: Option<u32>,
    disabled: Option<bool>,
}

#[derive(Debug, Deserialize)]
struct V2RoutingPolicyGroup {
    #[serde(default)]
    routing: BTreeMap<String, Vec<V2RouteTier>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct V2RouteTier {
    priority: Option<i32>,
    #[serde(default)]
    targets: Vec<String>,
    load_balancing: Option<V2LoadBalancing>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct V2LoadBalancing {
    strategy: Option<String>,
    #[serde(default)]
    weights: BTreeMap<String, f64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct V2ProviderConfigFile {
    provider_id: Option<String>,
    provider: V2ProviderConfig,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct V2ProviderConfig {
    id: String,
    enabled: Option<bool>,
    #[serde(rename = "type")]
    provider_type: String,
    #[serde(alias = "baseURL")]
    base_url: String,
    default_model: String,
    auth: V2ProviderAuthConfig,
    responses: Option<V2ProviderResponsesConfig>,
    concurrency: Option<V2ProviderConcurrencyConfig>,
    #[serde(default, alias = "compatibilityProfile")]
    compatibility_profile: Option<String>,
    #[serde(default)]
    models: BTreeMap<String, V2ProviderModelConfig>,
    #[serde(default)]
    v3: Option<V2ProviderV3Config>,
    /// per-request 总超时（毫秒）；默认 300_000（300s）。覆盖连接、响应头等待与 body 读取。
    #[serde(default)]
    timeout: Option<u64>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct V2ProviderV3Config {
    #[serde(default)]
    health: Option<V3ProviderHealthAuthoringConfig>,
    #[serde(default, alias = "semantic_error_policy")]
    semantic_error_policy: Vec<V3ProviderSemanticErrorPolicyAuthoringConfig>,
    #[serde(default, alias = "provider_request_cleanup")]
    provider_request_cleanup: V3ProviderRequestCleanupAuthoringConfig,
    #[serde(default)]
    features: BTreeMap<String, bool>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct V2ProviderAuthConfig {
    api_key: Option<String>,
    env: Option<String>,
    token_file: Option<String>,
    entries: Option<Vec<V2ProviderAuthEntry>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct V2ProviderAuthEntry {
    alias: Option<String>,
    api_key: Option<String>,
    env: Option<String>,
    token_file: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct V2ProviderResponsesConfig {
    process: String,
    streaming: Option<String>,
    #[serde(default)]
    transport: Option<V3ResponsesTransportKind>,
    #[serde(default, alias = "websocket_v2_url", alias = "websocketV2URL")]
    websocket_v2_url: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct V2ProviderConcurrencyConfig {
    max_in_flight: Option<u32>,
    acquire_timeout_ms: Option<u64>,
    stale_lease_ms: Option<u64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct V2ProviderModelConfig {
    #[serde(default)]
    wire_name: Option<String>,
    #[serde(default)]
    aliases: Vec<String>,
    #[serde(default)]
    capabilities: Vec<String>,
    supports_streaming: Option<bool>,
    supports_thinking: Option<bool>,
    thinking: Option<String>,
    max_tokens: Option<u64>,
    max_context: Option<u64>,
    max_context_tokens: Option<u64>,
    context_window: Option<u64>,
    /// Mode B 显式声明（v2 配置可选；缺省时按 `web_search_direct`
    /// capability 兼容推断 Mode A）。生产 v2 配置通过此字段启用
    /// `metadata_center_local_search` 与编译期 backend binding。
    ///
    /// 兼容两种写法：`rename_all = "camelCase"` 的 `webSearchExecutionMode`
    /// 与生产 v2 配置实际使用的 `web_search_execution_mode`（snake_case）。
    #[serde(default, alias = "web_search_execution_mode")]
    web_search_execution_mode: Option<V3WebSearchExecutionMode>,
    #[serde(default, alias = "web_search_backend")]
    web_search_backend: Option<String>,
    #[serde(default)]
    features: BTreeMap<String, bool>,
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn snake_case_web_search_mode_parses_via_alias() {
        let parsed: V2ProviderModelConfig = toml::from_str(
            r#"
wireName = "MiniMax-M3"
capabilities = ["web_search"]
web_search_execution_mode = "metadata_center_local_search"
web_search_backend = "MiniMax-M3"
"#,
        )
        .expect("parse");
        assert_eq!(
            parsed.web_search_execution_mode().as_str(),
            "metadata_center_local_search",
            "snake_case web_search_execution_mode must parse (found {:?})",
            parsed.web_search_execution_mode()
        );
        assert_eq!(
            parsed.web_search_backend.as_deref(),
            Some("MiniMax-M3")
        );
    }

    #[test]
    fn camel_case_web_search_mode_still_parses() {
        let parsed: V2ProviderModelConfig = toml::from_str(
            r#"
wireName = "MiniMax-M3"
webSearchExecutionMode = "metadata_center_local_search"
webSearchBackend = "MiniMax-M3"
"#,
        )
        .expect("parse");
        assert_eq!(parsed.web_search_execution_mode().as_str(), "metadata_center_local_search");
        assert_eq!(parsed.web_search_backend.as_deref(), Some("MiniMax-M3"));
    }

    #[test]
    fn provider_timeout_parses_into_manifest_request_timeout_ms() {
        // 端到端：v2 provider 文件 `[provider].timeout` 经 V2→V3 兼容层必须写入
        // `V3ProviderAuthoringConfig.request_timeout_ms`（曾因 serde 静默丢弃
        // snake_case 字段导致 9 分钟超时永远不生效）。
        // 三层验证：(1) V2 schema 解析 (2) compile_v2_provider_directory 端到点
        // 写入 (3) 缺省字段 → DEFAULT_PROVIDER_REQUEST_TIMEOUT_MS fallback。
        use std::io::Write;

        // (1) V2 schema 解析层：snake_case timeout 必须被接受
        let parsed: V2ProviderConfigFile = toml::from_str(
            r#"
providerId = "test-provider"

[provider]
id = "test-provider"
enabled = true
type = "openai"
baseURL = "http://127.0.0.1:9999/v1"
timeout = 900000
defaultModel = "model"

[provider.auth]
type = "apikey"
apiKey = "test-key"
"#,
        )
        .expect("parse");
        assert_eq!(parsed.provider.timeout, Some(900_000), "snake_case timeout must parse");

        // (2) 端到点：临时 provider 目录 → compile_v2_provider_directory →
        //      manifest request_timeout_ms == 900_000
        let tmp = std::env::temp_dir().join(format!(
            "rccv3-timeout-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock")
                .as_nanos()
        ));
        let provider_dir = tmp.join("provider").join("test-provider");
        std::fs::create_dir_all(&provider_dir).expect("create provider dir");
        let mut file = std::fs::File::create(provider_dir.join("config.v2.toml")).expect("file");
        file.write_all(
            br#"
providerId = "test-provider"

[provider]
id = "test-provider"
enabled = true
type = "openai"
baseURL = "http://127.0.0.1:9999/v1"
timeout = 900000
defaultModel = "model"

[provider.auth]
type = "apikey"
apiKey = "test-key"
"#,
        )
        .expect("write");

        let mut referenced_models: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
        referenced_models.insert("test-provider".to_string(), BTreeSet::new());
        let (providers, _sources) =
            compile_v2_provider_directory(&tmp, &referenced_models).expect("compile v2 provider dir");
        let authoring = providers
            .get("test-provider")
            .expect("provider compiled");
        assert_eq!(
            authoring.request_timeout_ms, 900_000,
            "V2→V3 end-to-end: timeout=900_000 must land in request_timeout_ms (was silently dropped)"
        );
        std::fs::remove_dir_all(&tmp).ok();

        // (2b) 缺省字段端到点：无 timeout 时，V2→V3 fallback 必须等于
        //      DEFAULT_PROVIDER_REQUEST_TIMEOUT_MS（300_000），不能为 0/默认
        //      隐藏 bug。
        let tmp_default = std::env::temp_dir().join(format!(
            "rccv3-timeout-default-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock")
                .as_nanos()
        ));
        let provider_dir_default = tmp_default.join("provider").join("test-provider");
        std::fs::create_dir_all(&provider_dir_default).expect("create provider dir");
        let mut file_default =
            std::fs::File::create(provider_dir_default.join("config.v2.toml")).expect("file");
        file_default
            .write_all(
                br#"
providerId = "test-provider"

[provider]
id = "test-provider"
enabled = true
type = "openai"
baseURL = "http://127.0.0.1:9999/v1"
defaultModel = "model"

[provider.auth]
type = "apikey"
apiKey = "test-key"
"#,
            )
            .expect("write");
        let (providers_default, _sources_default) = compile_v2_provider_directory(
            &tmp_default,
            &referenced_models,
        )
        .expect("compile v2 provider dir (absent timeout)");
        let authoring_default = providers_default
            .get("test-provider")
            .expect("provider compiled");
        assert_eq!(
            authoring_default.request_timeout_ms,
            DEFAULT_PROVIDER_REQUEST_TIMEOUT_MS,
            "absent timeout must fall back to DEFAULT_PROVIDER_REQUEST_TIMEOUT_MS (300_000)"
        );
        std::fs::remove_dir_all(&tmp_default).ok();

        // (3) V2 schema 解析层：snake_case timeout 必须被接受；缺省字段 → None
        let parsed: V2ProviderConfigFile = toml::from_str(
            r#"
providerId = "test-provider"

[provider]
id = "test-provider"
enabled = true
type = "openai"
baseURL = "http://127.0.0.1:9999/v1"
timeout = 900000
defaultModel = "model"

[provider.auth]
type = "apikey"
apiKey = "test-key"
"#,
        )
        .expect("parse");
        assert_eq!(parsed.provider.timeout, Some(900_000), "snake_case timeout must parse");

        let absent: V2ProviderConfigFile = toml::from_str(
            r#"
providerId = "test-provider"

[provider]
id = "test-provider"
enabled = true
type = "openai"
baseURL = "http://127.0.0.1:9999/v1"
defaultModel = "model"

[provider.auth]
type = "apikey"
apiKey = "test-key"
"#,
        )
        .expect("parse");
        assert_eq!(absent.provider.timeout, None, "absent timeout must be None (default applies later)");
    }
}
