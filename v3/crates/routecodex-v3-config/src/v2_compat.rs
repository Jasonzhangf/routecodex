// feature_id: v3.v2_config_toml_compat_5555
use crate::{
    validation, V3Config02AuthoringParsed, V3ConfigError, V3ContinuationPolicyAuthoringConfig,
    V3EntryProtocolBindingAuthoringConfig, V3EntryProtocolExecutionMode,
    V3ForwarderAuthoringConfig, V3ForwarderTargetAuthoringConfig, V3HubFixedNode,
    V3HubHookAuthoringConfig, V3HubHookPhase, V3HubHookProfile, V3HubHookRequirement,
    V3HubResourceAuthoringConfig, V3HubResourceKind, V3HubResourceScope, V3HubV1AuthoringConfig,
    V3PipelinesAuthoringConfig, V3ProviderAuthAuthoringConfig, V3ProviderAuthEntryAuthoringConfig,
    V3ProviderAuthType, V3ProviderAuthoringConfig, V3ProviderConcurrencyAuthoringConfig,
    V3ProviderModelAuthoringConfig, V3ProviderResponsesAuthoringConfig, V3ResponsesTransportKind,
    V3RouteGroupAuthoringConfig, V3RoutePoolAuthoringConfig, V3RoutePoolMatchAuthoringConfig,
    V3RoutePoolTargetAuthoringConfig, V3RouteTargetKind, V3SelectionPolicy, V3SelectionStrategy,
    V3ServerAuthoringConfig, V3ServerExecutionAuthoringConfig, V3StreamingPolicy,
};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::Path;

const V2_SECRET_HANDLE_DIR: &str = ".routecodex-v3-secret-handles";

pub(crate) fn compile_v2_config_02_authoring_from_file(
    config_path: &Path,
    raw: &str,
) -> Result<Option<V3Config02AuthoringParsed>, V3ConfigError> {
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
) -> Result<V3Config02AuthoringParsed, V3ConfigError> {
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
    let providers = compile_v2_providers(config_dir, &forwarders)?;
    let available_protocols = available_entry_protocols(&providers);
    let servers = compile_v2_servers(router_ports, &available_protocols)?;
    let route_groups = compile_v2_route_groups(root.virtualrouter.routing_policy_groups)?;

    Ok(V3Config02AuthoringParsed {
        version: 3,
        pipelines: V3PipelinesAuthoringConfig {
            hub_v1: Some(default_v2_hub_v1_authoring()),
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
                    execution: Some(default_v2_server_execution()),
                },
            ))
        })
        .collect()
}

fn available_entry_protocols(
    providers: &BTreeMap<String, V3ProviderAuthoringConfig>,
) -> BTreeSet<String> {
    providers
        .values()
        .filter(|provider| provider.enabled)
        .map(|provider| provider.provider_type.clone())
        .collect()
}

fn default_v2_hub_v1_authoring() -> V3HubV1AuthoringConfig {
    V3HubV1AuthoringConfig {
        skeleton: "hub_v1".to_string(),
        entry_protocols: vec![
            "responses".to_string(),
            "anthropic".to_string(),
            "gemini".to_string(),
            "openai_chat".to_string(),
        ],
        hook_set_id: "hub_v1.default".to_string(),
        entry_protocol_bindings: vec![
            V3EntryProtocolBindingAuthoringConfig {
                entry_protocol: "responses".to_string(),
                endpoint_patterns: vec!["/v1/responses".to_string()],
                execution_mode: V3EntryProtocolExecutionMode::Direct,
                protocol_profile_owner: "v3.entry_protocol_registry_contract".to_string(),
                implemented: true,
                forbidden_reentry_behavior:
                    "Responses endpoint must not fall through to relay or pending runtime."
                        .to_string(),
                runtime_owner_symbol: Some(
                    "execute_v3_responses_direct_runtime_kernel_with_default_transport_debug_and_continuation"
                        .to_string(),
                ),
                runtime_owner_path: Some("v3/crates/routecodex-v3-runtime/src/kernel.rs".to_string()),
                pending_owner_symbol: None,
                pending_owner_path: None,
            },
            V3EntryProtocolBindingAuthoringConfig {
                entry_protocol: "anthropic".to_string(),
                endpoint_patterns: vec!["/v1/messages".to_string()],
                execution_mode: V3EntryProtocolExecutionMode::Relay,
                protocol_profile_owner: "v3.entry_protocol_registry_contract".to_string(),
                implemented: true,
                forbidden_reentry_behavior:
                    "Anthropic Messages endpoint must not fall through to Responses Direct or pending runtime."
                        .to_string(),
                runtime_owner_symbol: Some(
                    "execute_v3_anthropic_relay_runtime_with_default_transport".to_string(),
                ),
                runtime_owner_path: Some(
                    "v3/crates/routecodex-v3-runtime/src/hub_v1/anthropic_relay_runtime.rs"
                        .to_string(),
                ),
                pending_owner_symbol: None,
                pending_owner_path: None,
            },
            V3EntryProtocolBindingAuthoringConfig {
                entry_protocol: "openai_chat".to_string(),
                endpoint_patterns: vec!["/v1/chat/completions".to_string()],
                execution_mode: V3EntryProtocolExecutionMode::Relay,
                protocol_profile_owner: "v3.entry_protocol_registry_contract".to_string(),
                implemented: true,
                forbidden_reentry_behavior:
                    "OpenAI Chat endpoint must not fall through to Responses Direct or pending runtime."
                        .to_string(),
                runtime_owner_symbol: Some(
                    "execute_v3_openai_chat_relay_runtime_with_default_transport".to_string(),
                ),
                runtime_owner_path: Some(
                    "v3/crates/routecodex-v3-runtime/src/hub_v1/openai_chat_relay_runtime.rs"
                        .to_string(),
                ),
                pending_owner_symbol: None,
                pending_owner_path: None,
            },
            V3EntryProtocolBindingAuthoringConfig {
                entry_protocol: "gemini".to_string(),
                endpoint_patterns: vec!["/v1beta/models/:model/generateContent".to_string()],
                execution_mode: V3EntryProtocolExecutionMode::Relay,
                protocol_profile_owner: "v3.gemini_relay_runtime_integration".to_string(),
                implemented: true,
                forbidden_reentry_behavior:
                    "Gemini endpoint must not fall through to pending or direct runtime.".to_string(),
                runtime_owner_symbol: Some(
                    "execute_v3_gemini_relay_runtime_with_default_transport".to_string(),
                ),
                runtime_owner_path: Some(
                    "v3/crates/routecodex-v3-runtime/src/hub_v1/gemini_relay_runtime.rs"
                        .to_string(),
                ),
                pending_owner_symbol: None,
                pending_owner_path: None,
            },
        ],
        resources: BTreeMap::from([
            (
                "metadata_center".to_string(),
                V3HubResourceAuthoringConfig {
                    kind: V3HubResourceKind::Control,
                    scope: V3HubResourceScope::Request,
                },
            ),
            (
                "continuation_store".to_string(),
                V3HubResourceAuthoringConfig {
                    kind: V3HubResourceKind::Continuation,
                    scope: V3HubResourceScope::Server,
                },
            ),
            (
                "error_chain".to_string(),
                V3HubResourceAuthoringConfig {
                    kind: V3HubResourceKind::Error,
                    scope: V3HubResourceScope::Request,
                },
            ),
            (
                "debug_artifact".to_string(),
                V3HubResourceAuthoringConfig {
                    kind: V3HubResourceKind::Debug,
                    scope: V3HubResourceScope::Debug,
                },
            ),
            (
                "snapshot_buffer".to_string(),
                V3HubResourceAuthoringConfig {
                    kind: V3HubResourceKind::Snapshot,
                    scope: V3HubResourceScope::Debug,
                },
            ),
            (
                "provider_health".to_string(),
                V3HubResourceAuthoringConfig {
                    kind: V3HubResourceKind::ProviderHealth,
                    scope: V3HubResourceScope::Provider,
                },
            ),
        ]),
        hooks: default_v2_hub_v1_hooks(),
    }
}

fn default_v2_hub_v1_hooks() -> Vec<V3HubHookAuthoringConfig> {
    let mut hooks = Vec::new();
    let mut order = 0_u32;
    for node in V3HubFixedNode::ALL {
        for phase in V3HubHookPhase::ALL {
            let optional_disabled = node == V3HubFixedNode::V3HubReqInbound02Normalized
                && phase == V3HubHookPhase::Exit;
            let servertool_profile = phase == V3HubHookPhase::Entry
                && matches!(
                    node,
                    V3HubFixedNode::V3HubReqChatProcess04Governed
                        | V3HubFixedNode::V3HubRespChatProcess03Governed
                );
            let allowed_resources = match (node, phase) {
                (V3HubFixedNode::V3HubReqInbound02Normalized, V3HubHookPhase::Entry) => {
                    vec!["metadata_center".to_string()]
                }
                (V3HubFixedNode::V3HubReqChatProcess04Governed, V3HubHookPhase::Entry)
                | (V3HubFixedNode::V3HubRespChatProcess03Governed, V3HubHookPhase::Entry) => {
                    vec!["continuation_store".to_string()]
                }
                _ => Vec::new(),
            };
            let forbidden_resources = if optional_disabled {
                vec!["continuation_store".to_string()]
            } else {
                Vec::new()
            };
            hooks.push(V3HubHookAuthoringConfig {
                hook_id: format!(
                    "hub_v1.{}.{}.not_implemented",
                    node.node_id(),
                    phase.as_str()
                ),
                node,
                phase,
                requirement: if optional_disabled {
                    V3HubHookRequirement::Optional
                } else {
                    V3HubHookRequirement::Required
                },
                enabled: !optional_disabled,
                priority: 0,
                order,
                allowed_resources,
                forbidden_resources,
                profile: if servertool_profile {
                    Some(V3HubHookProfile::Servertool)
                } else {
                    None
                },
            });
            order += 1;
        }
    }
    hooks
}

fn default_v2_server_execution() -> V3ServerExecutionAuthoringConfig {
    V3ServerExecutionAuthoringConfig {
        allowed_modes: vec!["direct".to_string(), "relay".to_string()],
        allowed_invocation_sources: vec![
            "client".to_string(),
            "servertool_followup".to_string(),
            "dry_run".to_string(),
        ],
        allowed_transports: vec!["json".to_string(), "sse".to_string()],
        continuation: V3ContinuationPolicyAuthoringConfig {
            allowed_owners: vec![
                "none".to_string(),
                "remote_provider".to_string(),
                "routecodex_local".to_string(),
            ],
            scope_keys: vec![
                "entry_protocol".to_string(),
                "server".to_string(),
                "routing_group".to_string(),
                "session".to_string(),
            ],
        },
    }
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
) -> Result<BTreeMap<String, V3RouteGroupAuthoringConfig>, V3ConfigError> {
    groups
        .into_iter()
        .map(|(group_id, group)| {
            let mut pools = BTreeMap::new();
            for (route_id, mut routes) in group.routing {
                routes.sort_by_key(|route| std::cmp::Reverse(route.priority.unwrap_or(0)));
                let mut targets = Vec::new();
                let mut next_priority = 1_i32;
                for route in routes {
                    for target_id in route.targets {
                        targets.push(V3RoutePoolTargetAuthoringConfig {
                            kind: V3RouteTargetKind::Forwarder,
                            id: Some(target_id),
                            provider: None,
                            model: None,
                            key: None,
                            priority: Some(next_priority),
                            weight: Some(1),
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
                    Some(V3RoutePoolMatchAuthoringConfig {
                        precedence: Some(route_precedence(&route_id)),
                        entry_protocol: None,
                        models: Vec::new(),
                        required_capabilities: vec![route_id.clone()],
                        min_input_tokens: None,
                        max_input_tokens: None,
                    })
                };
                pools.insert(
                    route_id.clone(),
                    V3RoutePoolAuthoringConfig {
                        selection: V3SelectionPolicy {
                            strategy: V3SelectionStrategy::Priority,
                        },
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
        "thinking" => 10,
        "coding" => 11,
        "longcontext" => 12,
        "tools" => 20,
        "search" => 21,
        "web_search" => 22,
        "multimodal" => 30,
        "vision" => 31,
        _ => 100,
    }
}

fn compile_v2_providers(
    config_dir: &Path,
    forwarders: &BTreeMap<String, V3ForwarderAuthoringConfig>,
) -> Result<BTreeMap<String, V3ProviderAuthoringConfig>, V3ConfigError> {
    let mut referenced = BTreeSet::new();
    for forwarder in forwarders.values() {
        for target in &forwarder.targets {
            if let Some(provider) = &target.provider {
                referenced.insert(provider.clone());
            }
        }
    }
    referenced
        .into_iter()
        .map(|provider_id| {
            let path = config_dir
                .join("provider")
                .join(&provider_id)
                .join("config.v2.toml");
            let raw = fs::read_to_string(&path).map_err(|error| {
                validation(format!(
                    "v2 provider config {} read failed: {error}",
                    path.display()
                ))
            })?;
            let source_hash = format!("{:x}", Sha256::digest(raw.as_bytes()));
            let parsed: V2ProviderConfigFile = toml::from_str(&raw)?;
            let provider = parsed.provider;
            let provider_id_from_file = parsed.provider_id.unwrap_or_else(|| provider.id.clone());
            if provider_id_from_file != provider_id || provider.id != provider_id {
                return Err(validation(format!(
                    "v2 provider config {} identity mismatch for {provider_id}",
                    path.display()
                )));
            }
            let auth = compile_v2_auth(config_dir, &provider_id, source_hash, provider.auth)?;
            let provider_type = match provider.provider_type.as_str() {
                "openai" => "openai_chat",
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
            Ok((
                provider_id.clone(),
                V3ProviderAuthoringConfig {
                    enabled: provider.enabled.unwrap_or(true),
                    provider_type,
                    base_url: provider.base_url,
                    default_model: provider.default_model,
                    auth,
                    models: compile_v2_provider_models(provider.models),
                    responses,
                    concurrency: provider.concurrency.map(|concurrency| {
                        V3ProviderConcurrencyAuthoringConfig {
                            max_in_flight: concurrency.max_in_flight.unwrap_or(8),
                            acquire_timeout_ms: concurrency.acquire_timeout_ms.unwrap_or(60000),
                            stale_lease_ms: concurrency.stale_lease_ms.unwrap_or(300000),
                        }
                    }),
                    health: None,
                    features: BTreeMap::new(),
                },
            ))
        })
        .collect()
}

fn compile_v2_auth(
    config_dir: &Path,
    provider_id: &str,
    source_hash: String,
    auth: V2ProviderAuthConfig,
) -> Result<V3ProviderAuthAuthoringConfig, V3ConfigError> {
    let entries = if let Some(entries) = auth.entries {
        entries
    } else {
        vec![V2ProviderAuthEntry {
            alias: Some("key1".to_string()),
            api_key: auth.api_key,
            env: auth.env,
        }]
    };
    let mut v3_entries = Vec::new();
    for entry in entries {
        let alias = entry.alias.unwrap_or_else(|| "key1".to_string());
        if let Some(env) = entry.env {
            v3_entries.push(V3ProviderAuthEntryAuthoringConfig {
                alias,
                env: Some(env),
                token_file: None,
            });
            continue;
        }
        let api_key = entry.api_key.ok_or_else(|| {
            validation(format!(
                "v2 provider {provider_id} auth {alias} missing apiKey or env"
            ))
        })?;
        let token_file = materialize_v2_secret_token_file(
            config_dir,
            provider_id,
            &alias,
            &source_hash,
            api_key,
        )?;
        v3_entries.push(V3ProviderAuthEntryAuthoringConfig {
            alias,
            env: None,
            token_file: Some(token_file),
        });
    }
    Ok(V3ProviderAuthAuthoringConfig {
        auth_type: V3ProviderAuthType::ApiKey,
        entries: v3_entries,
    })
}

fn materialize_v2_secret_token_file(
    config_dir: &Path,
    provider_id: &str,
    alias: &str,
    source_hash: &str,
    secret: String,
) -> Result<String, V3ConfigError> {
    let dir = config_dir
        .join(V2_SECRET_HANDLE_DIR)
        .join(provider_id)
        .join(alias);
    fs::create_dir_all(&dir)?;
    let path = dir.join(format!("{}.token", &source_hash[..16]));
    fs::write(&path, format!("{}\n", secret.trim()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600))?;
    }
    Ok(path.display().to_string())
}

fn compile_v2_provider_models(
    models: BTreeMap<String, V2ProviderModelConfig>,
) -> BTreeMap<String, V3ProviderModelAuthoringConfig> {
    models
        .into_iter()
        .map(|(id, model)| {
            (
                id.clone(),
                V3ProviderModelAuthoringConfig {
                    wire_name: Some(id),
                    aliases: Vec::new(),
                    capabilities: normalize_v2_capabilities(model.capabilities),
                    supports_streaming: model.supports_streaming.unwrap_or(false),
                    supports_thinking: model.supports_thinking.unwrap_or(false),
                    thinking: model.thinking,
                    max_tokens: model.max_tokens,
                    max_context_tokens: model
                        .max_context_tokens
                        .or(model.context_window)
                        .or(model.max_context),
                    features: BTreeMap::new(),
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
    #[serde(default)]
    forwarders: BTreeMap<String, V2ForwarderConfig>,
    #[serde(default)]
    routing_policy_groups: BTreeMap<String, V2RoutingPolicyGroup>,
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
    #[serde(default)]
    models: BTreeMap<String, V2ProviderModelConfig>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct V2ProviderAuthConfig {
    api_key: Option<String>,
    env: Option<String>,
    entries: Option<Vec<V2ProviderAuthEntry>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct V2ProviderAuthEntry {
    alias: Option<String>,
    api_key: Option<String>,
    env: Option<String>,
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
    capabilities: Vec<String>,
    supports_streaming: Option<bool>,
    supports_thinking: Option<bool>,
    thinking: Option<String>,
    max_tokens: Option<u64>,
    max_context: Option<u64>,
    max_context_tokens: Option<u64>,
    context_window: Option<u64>,
}
