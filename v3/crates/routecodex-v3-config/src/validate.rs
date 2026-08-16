use crate::types::*;
use crate::{
    compile_v3_http_sse_keepalive_ms_from_environment, looks_like_secret_literal, validation,
    V3ConfigError,
};
use std::collections::{BTreeMap, BTreeSet};

pub(crate) fn validate_schema(
    authoring: V3Config02AuthoringParsed,
) -> Result<V3Config03SchemaValidated, V3ConfigError> {
    if authoring.version != 3 {
        return Err(validation("config.v3.toml version must be 3"));
    }
    if authoring.servers.is_empty() {
        return Err(validation("at least one server is required"));
    }
    if authoring.providers.is_empty() {
        return Err(validation("at least one provider is required"));
    }
    if authoring.route_groups.is_empty() {
        return Err(validation("at least one route group is required"));
    }

    Ok(V3Config03SchemaValidated { authoring })
}
pub(crate) fn build_resource_registry(
    validated: V3Config03SchemaValidated,
) -> Result<V3Config04ResourceRegistryBuilt, V3ConfigError> {
    let authoring = validated.authoring;
    let hub_v1 = compile_hub_v1(authoring.pipelines.hub_v1)?;
    let compiled_providers = compile_providers(authoring.providers)?;
    let providers = compiled_providers.providers;
    validate_cross_provider_model_web_search_mode_uniqueness(&providers)?;
    let provider_error_action_policies = compiled_providers.provider_error_action_policies;
    let forwarders = compile_forwarders(authoring.forwarders, &providers)?;
    crate::validate_relations::validate_client_aliases(&providers, &forwarders)?;
    let route_groups = compile_route_groups(authoring.route_groups, &providers, &forwarders)?;
    let http_sse_keepalive_ms = compile_v3_http_sse_keepalive_ms_from_environment()?;
    let servers = compile_servers(
        authoring.servers,
        &route_groups,
        hub_v1.is_some(),
        http_sse_keepalive_ms,
    )?;
    ensure_unique_listen_addresses(&servers)?;
    if !servers.values().any(|server| server.enabled) {
        return Err(validation("at least one enabled server is required"));
    }

    let mut features = authoring.features;
    features
        .entry("stopless_center".to_string())
        .or_insert(true);

    Ok(V3Config04ResourceRegistryBuilt {
        version: authoring.version,
        hub_v1,
        servers,
        providers,
        forwarders,
        route_groups,
        features,
        debug: compile_debug(authoring.debug)?,
        error: compile_error(authoring.error, provider_error_action_policies)?,
    })
}
pub(crate) fn publish_manifest(
    registry: V3Config04ResourceRegistryBuilt,
) -> Result<V3Config05ManifestPublished, V3ConfigError> {
    Ok(V3Config05ManifestPublished {
        version: registry.version,
        hub_v1: registry.hub_v1,
        servers: registry.servers,
        providers: registry.providers,
        forwarders: registry.forwarders,
        route_groups: registry.route_groups,
        features: registry.features,
        debug: registry.debug,
        error: registry.error,
    })
}
const HUB_V1_ENTRY_PROTOCOLS: [&str; 4] = ["responses", "anthropic", "gemini", "openai_chat"];
use crate::entry_protocol_validation::{
    endpoint_patterns as expected_entry_protocol_endpoint_patterns,
    execution_modes as expected_entry_protocol_execution_modes,
};
fn compile_hub_v1(
    authoring: Option<V3HubV1AuthoringConfig>,
) -> Result<Option<V3HubV1Manifest>, V3ConfigError> {
    let Some(mut authoring) = authoring else {
        return Ok(None);
    };
    let defaults = crate::defaults::default_hub_v1_authoring();
    if authoring.skeleton.trim().is_empty() {
        authoring.skeleton = defaults.skeleton.clone();
    }
    if authoring.entry_protocols.is_empty() {
        authoring.entry_protocols = defaults.entry_protocols.clone();
    }
    if authoring.hook_set_id.trim().is_empty() {
        authoring.hook_set_id = defaults.hook_set_id.clone();
    }
    if authoring.entry_protocol_bindings.is_empty() {
        authoring.entry_protocol_bindings = defaults.entry_protocol_bindings.clone();
    }
    if authoring.resources.is_empty() {
        authoring.resources = defaults.resources.clone();
    }
    if authoring.hooks.is_empty() {
        authoring.hooks = defaults.hooks.clone();
    }
    if authoring.skeleton != "hub_v1" {
        return Err(validation("hub_v1 skeleton must be hub_v1"));
    }
    let protocols = authoring
        .entry_protocols
        .iter()
        .map(String::as_str)
        .collect::<BTreeSet<_>>();
    if protocols.len() != authoring.entry_protocols.len() {
        return Err(validation(
            "hub_v1 entry_protocols contain duplicate protocol",
        ));
    }
    for protocol in &protocols {
        if !HUB_V1_ENTRY_PROTOCOLS.contains(protocol) {
            return Err(validation(format!(
                "hub_v1 unknown entry protocol {protocol}"
            )));
        }
    }
    if protocols.len() != HUB_V1_ENTRY_PROTOCOLS.len() {
        return Err(validation(
            "hub_v1 entry_protocols must declare all closed protocols",
        ));
    }
    if authoring.hook_set_id.trim().is_empty() {
        return Err(validation("hub_v1 hook_set_id is empty"));
    }
    let entry_protocol_bindings = compile_entry_protocol_bindings(
        authoring.entry_protocol_bindings,
        &authoring.entry_protocols,
    )?;
    let resources = authoring
        .resources
        .into_iter()
        .map(|(resource_id, resource)| {
            require_id("hub_v1 resource", &resource_id)?;
            Ok((
                resource_id.clone(),
                V3HubResourceManifest {
                    resource_id,
                    kind: resource.kind,
                    scope: resource.scope,
                    may_enter_provider_body: false,
                    may_enter_client_body: false,
                },
            ))
        })
        .collect::<Result<BTreeMap<_, _>, V3ConfigError>>()?;

    let mut hook_ids = BTreeSet::new();
    let mut slots = BTreeSet::new();
    let mut hooks = Vec::with_capacity(authoring.hooks.len());
    for hook in authoring.hooks {
        let expected_id = format!(
            "hub_v1.{}.{}.not_implemented",
            hook.node.node_id(),
            hook.phase.as_str()
        );
        if hook.hook_id != expected_id {
            return Err(validation(format!("hub_v1 unknown hook {}", hook.hook_id)));
        }
        if !hook_ids.insert(hook.hook_id.clone()) {
            return Err(validation(format!(
                "hub_v1 duplicate hook {}",
                hook.hook_id
            )));
        }
        if !slots.insert((hook.node, hook.phase)) {
            return Err(validation(format!(
                "hub_v1 duplicate hook slot {} {}",
                hook.node.node_id(),
                hook.phase.as_str()
            )));
        }
        if hook.requirement == V3HubHookRequirement::Required && !hook.enabled {
            return Err(validation(format!(
                "hub_v1 required hook {} cannot be disabled",
                hook.hook_id
            )));
        }
        let allowed = hook
            .allowed_resources
            .iter()
            .cloned()
            .collect::<BTreeSet<_>>();
        let forbidden = hook
            .forbidden_resources
            .iter()
            .cloned()
            .collect::<BTreeSet<_>>();
        if allowed.len() != hook.allowed_resources.len()
            || forbidden.len() != hook.forbidden_resources.len()
        {
            return Err(validation(format!(
                "hub_v1 hook {} has duplicate resource declaration",
                hook.hook_id
            )));
        }
        for resource_id in allowed.union(&forbidden) {
            if !resources.contains_key(resource_id) {
                return Err(validation(format!(
                    "hub_v1 hook {} references unknown resource {resource_id}",
                    hook.hook_id
                )));
            }
        }
        if let Some(resource_id) = allowed.intersection(&forbidden).next() {
            return Err(validation(format!(
                "hub_v1 hook {} both allows and forbids resource {resource_id}",
                hook.hook_id
            )));
        }
        if hook.profile == Some(V3HubHookProfile::Servertool)
            && !matches!(
                hook.node,
                V3HubFixedNode::V3HubReqChatProcess04Governed
                    | V3HubFixedNode::V3HubRespChatProcess03Governed
            )
        {
            return Err(validation(format!(
                "hub_v1 servertool profile is forbidden at node {}",
                hook.node.node_id()
            )));
        }
        hooks.push(V3HubHookManifest {
            hook_id: hook.hook_id,
            node: hook.node,
            phase: hook.phase,
            requirement: hook.requirement,
            enabled: hook.enabled,
            priority: hook.priority,
            order: hook.order,
            allowed_resources: allowed.into_iter().collect(),
            forbidden_resources: forbidden.into_iter().collect(),
            profile: hook.profile,
        });
    }
    for node in V3HubFixedNode::ALL {
        for phase in V3HubHookPhase::ALL {
            if !slots.contains(&(node, phase)) {
                return Err(validation(format!(
                    "hub_v1 hook set is missing required {} hook for {}",
                    phase.as_str(),
                    node.node_id()
                )));
            }
        }
    }
    hooks.sort_by(|left, right| {
        (left.priority, left.order, left.hook_id.as_str()).cmp(&(
            right.priority,
            right.order,
            right.hook_id.as_str(),
        ))
    });
    Ok(Some(V3HubV1Manifest {
        skeleton: "hub_v1".to_string(),
        entry_protocols: HUB_V1_ENTRY_PROTOCOLS
            .iter()
            .map(|value| (*value).to_string())
            .collect(),
        hook_set_id: authoring.hook_set_id,
        entry_protocol_bindings,
        resources,
        hooks,
    }))
}

fn compile_entry_protocol_bindings(
    authoring: Vec<V3EntryProtocolBindingAuthoringConfig>,
    declared_protocols: &[String],
) -> Result<Vec<V3EntryProtocolBindingManifest>, V3ConfigError> {
    let declared = declared_protocols.iter().cloned().collect::<BTreeSet<_>>();
    let mut protocols = BTreeSet::new();
    let mut endpoint_patterns = BTreeSet::new();
    let mut bindings = Vec::with_capacity(authoring.len());

    for binding in authoring {
        let entry_protocol = binding.entry_protocol.trim().to_string();
        if entry_protocol.is_empty() {
            return Err(validation(
                "entry protocol binding has empty entry_protocol",
            ));
        }
        if !HUB_V1_ENTRY_PROTOCOLS.contains(&entry_protocol.as_str()) {
            return Err(validation(format!(
                "hub_v1 unknown entry protocol binding {entry_protocol}"
            )));
        }
        if !declared.contains(&entry_protocol) {
            return Err(validation(format!(
                "hub_v1 config allowed protocol {entry_protocol} lacks entry declaration"
            )));
        }
        if !protocols.insert(entry_protocol.clone()) {
            return Err(validation(format!(
                "hub_v1 duplicate entry protocol binding {entry_protocol}"
            )));
        }
        if binding.endpoint_patterns.is_empty() {
            return Err(validation(format!(
                "hub_v1 entry protocol binding {entry_protocol} endpoint_patterns is empty"
            )));
        }
        let mut normalized_patterns = Vec::with_capacity(binding.endpoint_patterns.len());
        for pattern in binding.endpoint_patterns {
            let pattern = pattern.trim().to_string();
            if pattern.is_empty() {
                return Err(validation(format!(
                    "hub_v1 entry protocol binding {entry_protocol} endpoint pattern is empty"
                )));
            }
            if !endpoint_patterns.insert(pattern.clone()) {
                return Err(validation(format!(
                    "hub_v1 duplicate endpoint pattern {pattern}"
                )));
            }
            normalized_patterns.push(pattern);
        }
        let expected_patterns = expected_entry_protocol_endpoint_patterns(&entry_protocol)
            .expect("closed protocol has endpoint pattern");
        if normalized_patterns
            != expected_patterns
                .iter()
                .map(|value| (*value).to_string())
                .collect::<Vec<_>>()
        {
            return Err(validation(format!(
                "hub_v1 entry protocol binding {entry_protocol} endpoint_patterns must be {:?}",
                expected_patterns
            )));
        }
        let expected_modes = expected_entry_protocol_execution_modes(&entry_protocol)
            .expect("closed protocol has execution modes");
        if !expected_modes.contains(&binding.execution_mode) {
            let expected = expected_modes
                .iter()
                .map(|mode| mode.as_str())
                .collect::<Vec<_>>()
                .join(" or ");
            return Err(validation(format!(
                "hub_v1 {entry_protocol} entry protocol must be {expected}",
            )));
        }
        if binding.protocol_profile_owner.trim().is_empty() {
            return Err(validation(format!(
                "hub_v1 entry protocol binding {entry_protocol} protocol_profile_owner is empty"
            )));
        }
        if binding.forbidden_reentry_behavior.trim().is_empty() {
            return Err(validation(format!(
                "hub_v1 entry protocol binding {entry_protocol} forbidden_reentry_behavior is empty"
            )));
        }
        let runtime_owner_symbol = trim_optional(binding.runtime_owner_symbol);
        let runtime_owner_path = trim_optional(binding.runtime_owner_path);
        let pending_owner_symbol = trim_optional(binding.pending_owner_symbol);
        let pending_owner_path = trim_optional(binding.pending_owner_path);
        match binding.execution_mode {
            V3EntryProtocolExecutionMode::Direct | V3EntryProtocolExecutionMode::Relay => {
                if !binding.implemented {
                    return Err(validation(format!(
                        "hub_v1 entry protocol binding {entry_protocol} direct/relay mode must be implemented"
                    )));
                }
                if runtime_owner_symbol.is_none() || runtime_owner_path.is_none() {
                    return Err(validation(format!(
                        "hub_v1 implemented entry protocol binding {entry_protocol} must declare runtime owner symbol and path"
                    )));
                }
                if pending_owner_symbol.is_some() || pending_owner_path.is_some() {
                    return Err(validation(format!(
                        "hub_v1 implemented entry protocol binding {entry_protocol} must not declare pending owner"
                    )));
                }
            }
            V3EntryProtocolExecutionMode::PendingNotImplemented => {
                if binding.implemented {
                    return Err(validation(format!(
                        "hub_v1 pending entry protocol binding {entry_protocol} must not be implemented"
                    )));
                }
                if pending_owner_symbol.is_none() || pending_owner_path.is_none() {
                    return Err(validation(format!(
                        "hub_v1 pending entry protocol binding {entry_protocol} must declare explicit pending owner symbol and path"
                    )));
                }
                if runtime_owner_symbol.is_some() || runtime_owner_path.is_some() {
                    return Err(validation(format!(
                        "hub_v1 pending entry protocol binding {entry_protocol} must not declare runtime owner"
                    )));
                }
            }
        }

        bindings.push(V3EntryProtocolBindingManifest {
            entry_protocol,
            endpoint_patterns: normalized_patterns,
            execution_mode: binding.execution_mode,
            protocol_profile_owner: binding.protocol_profile_owner.trim().to_string(),
            implemented: binding.implemented,
            forbidden_reentry_behavior: binding.forbidden_reentry_behavior.trim().to_string(),
            runtime_owner_symbol,
            runtime_owner_path,
            pending_owner_symbol,
            pending_owner_path,
        });
    }

    if protocols != declared {
        return Err(validation(
            "hub_v1 entry protocol binding registry must declare all hub_v1 entry protocols",
        ));
    }
    bindings.sort_by(|left, right| {
        let left_index = HUB_V1_ENTRY_PROTOCOLS
            .iter()
            .position(|protocol| *protocol == left.entry_protocol)
            .expect("validated protocol");
        let right_index = HUB_V1_ENTRY_PROTOCOLS
            .iter()
            .position(|protocol| *protocol == right.entry_protocol)
            .expect("validated protocol");
        left_index.cmp(&right_index)
    });
    Ok(bindings)
}

fn trim_optional(value: Option<String>) -> Option<String> {
    value
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn compile_servers(
    authoring: BTreeMap<String, V3ServerAuthoringConfig>,
    route_groups: &BTreeMap<String, V3RouteGroupManifest>,
    hub_v1_enabled: bool,
    http_sse_keepalive_ms: u64,
) -> Result<BTreeMap<String, V3ServerManifest>, V3ConfigError> {
    authoring
        .into_iter()
        .map(|(id, server)| {
            require_id("server", &id)?;
            if server.bind.trim().is_empty() {
                return Err(validation(format!("server {id} bind is empty")));
            }
            if server.port == 0 {
                return Err(validation(format!("server {id} port must be non-zero")));
            }
            if !route_groups.contains_key(&server.routing_group) {
                return Err(validation(format!(
                    "server {id} references unknown routing group {}",
                    server.routing_group
                )));
            }
            if server.endpoints.is_empty() {
                return Err(validation(format!("server {id} has no endpoints")));
            }
            let mut endpoints = BTreeSet::new();
            for endpoint in server.endpoints {
                if !HUB_V1_ENTRY_PROTOCOLS.contains(&endpoint.as_str()) {
                    return Err(validation(format!(
                        "server {id} declares unknown endpoint {endpoint}"
                    )));
                }
                if !endpoints.insert(endpoint.clone()) {
                    return Err(validation(format!(
                        "server {id} declares duplicate endpoint {endpoint}"
                    )));
                }
            }
            let execution = match server.execution {
                Some(execution) => Some(compile_server_execution(&id, execution)?),
                None if hub_v1_enabled => Some(compile_server_execution(
                    &id,
                    crate::defaults::default_server_execution(),
                )?),
                None => None,
            };
            Ok((
                id.clone(),
                V3ServerManifest {
                    id,
                    enabled: server.enabled,
                    bind: server.bind,
                    port: server.port,
                    routing_group: server.routing_group,
                    endpoints: HUB_V1_ENTRY_PROTOCOLS
                        .iter()
                        .filter(|endpoint| endpoints.contains(**endpoint))
                        .map(|endpoint| (*endpoint).to_string())
                        .collect(),
                    features: server.features,
                    execution,
                    http_sse_keepalive_ms,
                    expose_models: server.expose_models,
                },
            ))
        })
        .collect()
}

fn compile_server_execution(
    server_id: &str,
    authoring: V3ServerExecutionAuthoringConfig,
) -> Result<V3ServerExecutionManifest, V3ConfigError> {
    fn closed_list(
        server_id: &str,
        label: &str,
        values: Vec<String>,
        allowed: &[&str],
    ) -> Result<Vec<String>, V3ConfigError> {
        if values.is_empty() {
            return Err(validation(format!(
                "hub_v1 server {server_id} {label} cannot be empty"
            )));
        }
        let unique = values.iter().map(String::as_str).collect::<BTreeSet<_>>();
        if unique.len() != values.len() {
            return Err(validation(format!(
                "hub_v1 server {server_id} {label} contains duplicate declaration"
            )));
        }
        for value in &unique {
            if !allowed.contains(value) {
                return Err(validation(format!(
                    "hub_v1 server {server_id} {label} contains unknown value {value}"
                )));
            }
        }
        Ok(allowed
            .iter()
            .filter(|value| unique.contains(**value))
            .map(|value| (*value).to_string())
            .collect())
    }

    Ok(V3ServerExecutionManifest {
        allowed_modes: closed_list(
            server_id,
            "allowed_modes",
            authoring.allowed_modes,
            &["direct", "relay"],
        )?,
        allowed_invocation_sources: closed_list(
            server_id,
            "allowed_invocation_sources",
            authoring.allowed_invocation_sources,
            &["client", "servertool_followup", "dry_run"],
        )?,
        allowed_transports: closed_list(
            server_id,
            "allowed_transports",
            authoring.allowed_transports,
            &["json", "sse"],
        )?,
        continuation: V3ContinuationPolicyManifest {
            allowed_owners: closed_list(
                server_id,
                "continuation.allowed_owners",
                authoring.continuation.allowed_owners,
                &["none", "remote_provider", "routecodex_local"],
            )?,
            scope_keys: {
                let scope_keys = closed_list(
                    server_id,
                    "continuation.scope_keys",
                    authoring.continuation.scope_keys,
                    &["entry_protocol", "server", "routing_group", "session"],
                )?;
                if scope_keys.len() != 4 {
                    return Err(validation(format!(
                        "hub_v1 server {server_id} continuation.scope_keys must declare the complete isolation scope"
                    )));
                }
                scope_keys
            },
        },
    })
}

struct V3CompiledProviders {
    providers: BTreeMap<String, V3ProviderManifest>,
    provider_error_action_policies: Vec<V3ProviderErrorActionPolicyAuthoringConfig>,
}

fn compile_providers(
    authoring: BTreeMap<String, V3ProviderAuthoringConfig>,
) -> Result<V3CompiledProviders, V3ConfigError> {
    let mut providers = BTreeMap::new();
    let mut provider_error_action_policies = Vec::new();
    for (id, provider) in authoring {
        require_id("provider", &id)?;
        if provider.provider_type.trim().is_empty() {
            return Err(validation(format!("provider {id} type is empty")));
        }
        if !matches!(
            provider.provider_type.as_str(),
            "responses" | "anthropic" | "gemini" | "openai_chat"
        ) {
            return Err(validation(format!(
                "provider {id} declares unknown protocol {}",
                provider.provider_type
            )));
        }
        if provider.base_url.trim().is_empty() {
            return Err(validation(format!("provider {id} base_url is empty")));
        }
        if provider.models.is_empty() {
            return Err(validation(format!("provider {id} has no models")));
        }
        if !provider.models.contains_key(&provider.default_model) {
            return Err(validation(format!(
                "provider {id} default_model {} is not a canonical models key",
                provider.default_model
            )));
        }
        let auth = compile_auth(&id, provider.auth)?;
        let provider_type = provider.provider_type;
        let mut models = compile_models(&id, provider.models)?;
        let responses = compile_provider_responses(&id, provider.responses, &models)?;
        apply_implicit_provider_model_capabilities(&provider_type, &mut models);
        let health = compile_provider_health(&id, provider.health)?;
        let provider_request_cleanup =
            compile_provider_request_cleanup(&id, provider.provider_request_cleanup)?;
        // v3-native inline provider 只消费已登记给 v3-native 的默认映射
        // （opencode-go -> responses:deepseek-console-go）；v2
        // provider-directory 表里的 cc/lmstudio/minimax 等默认不得静默注入
        // v3-native 配置。显式声明仍优先于编译默认。
        let compatibility_profile = normalize_v3_provider_compatibility_profile(
            provider
                .compatibility_profile
                .or_else(|| resolve_v3_native_provider_default_compatibility_profile(&id)),
        );
        let semantic_error_policy = provider.semantic_error_policy;
        provider_error_action_policies.extend(semantic_error_policy.into_iter().map(|policy| {
            V3ProviderErrorActionPolicyAuthoringConfig {
                policy_id: policy.policy_id,
                scope: V3ProviderErrorPolicyScopeAuthoringConfig {
                    provider_id: Some(id.clone()),
                    provider_type: Some(provider_type.clone()),
                    model_id: None,
                    routing_group: None,
                },
                matcher: policy.matcher,
                path: None,
                action: Some(policy.action),
            }
        }));
        providers.insert(
            id.clone(),
            V3ProviderManifest {
                id,
                enabled: provider.enabled,
                provider_type,
                base_url: provider.base_url.trim_end_matches('/').to_string(),
                default_model: provider.default_model,
                auth,
                models,
                responses,
                concurrency: provider.concurrency,
                health,
                provider_request_cleanup,
                compatibility_profile,
                features: provider.features,
                request_timeout_ms: provider.request_timeout_ms,
            },
        );
    }
    Ok(V3CompiledProviders {
        providers,
        provider_error_action_policies,
    })
}

fn normalize_v3_provider_compatibility_profile(profile: Option<String>) -> Option<String> {
    profile
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

/// v3-native inline provider 的 compatibility profile 编译默认：只允许已
/// 登记给 v3-native 的条目，避免 v2 provider-directory 的整表默认静默改变
/// v3-native 既有配置的 wire 行为。当前唯一已登记条目是 opencode-go 的
/// `responses:deepseek-console-go`（Console Go 网关工具映射 + 交错工具段
/// reasoning 注入契约）。
fn resolve_v3_native_provider_default_compatibility_profile(provider_id: &str) -> Option<String> {
    match provider_id.trim() {
        "opencode-go" => Some("responses:deepseek-console-go".to_string()),
        _ => None,
    }
}

fn compile_provider_responses(
    provider_id: &str,
    responses: Option<V3ProviderResponsesAuthoringConfig>,
    _models: &BTreeMap<String, V3ProviderModelManifest>,
) -> Result<Option<V3ProviderResponsesAuthoringConfig>, V3ConfigError> {
    let Some(responses) = responses else {
        return Ok(None);
    };

    match responses.transport {
        V3ResponsesTransportKind::Http => {
            if responses.websocket_v2_url.is_some() {
                return Err(validation(format!(
                    "provider {provider_id} HTTP transport cannot declare websocket_v2_url"
                )));
            }
        }
        V3ResponsesTransportKind::WebsocketV2 => {
            let endpoint = responses
                .websocket_v2_url
                .as_deref()
                .map(str::trim)
                .filter(|endpoint| !endpoint.is_empty())
                .ok_or_else(|| {
                    validation(format!("provider {provider_id} websocket_v2_url is required for websocket_v2 transport"))
                })?;
            if !(endpoint.starts_with("ws://") || endpoint.starts_with("wss://")) {
                return Err(validation(format!(
                    "provider {provider_id} websocket_v2_url must use ws:// or wss://"
                )));
            }
            if endpoint.chars().any(char::is_whitespace) {
                return Err(validation(format!(
                    "provider {provider_id} websocket_v2_url cannot contain whitespace"
                )));
            }
        }
    }

    Ok(Some(responses))
}

fn apply_implicit_provider_model_capabilities(
    provider_type: &str,
    models: &mut BTreeMap<String, V3ProviderModelManifest>,
) {
    if provider_type != "responses" {
        return;
    }
    for model in models.values_mut() {
        if is_gpt_series_provider_model(model) {
            ensure_model_capability(model, "text");
        }
    }
}

fn is_gpt_series_provider_model(model: &V3ProviderModelManifest) -> bool {
    is_gpt_series_model_id(&model.id) || is_gpt_series_model_id(&model.wire_name)
}

/// gpt 系列模型判定：委托内部配置层家族判定（internal.toml [model_families.gpt]），
/// 校验面不内联模型名 / 前缀规则。
fn is_gpt_series_model_id(model_id: &str) -> bool {
    crate::internal::is_v3_gpt_family_model(model_id)
}

fn ensure_model_capability(model: &mut V3ProviderModelManifest, capability: &str) {
    if !model
        .capabilities
        .iter()
        .any(|existing| existing == capability)
    {
        model.capabilities.push(capability.to_string());
    }
}

fn compile_provider_health(
    provider_id: &str,
    health: Option<V3ProviderHealthAuthoringConfig>,
) -> Result<Option<V3ProviderHealthAuthoringConfig>, V3ConfigError> {
    let Some(health) = health else {
        return Ok(None);
    };
    if health.enabled && health.failure_threshold == 0 {
        return Err(validation(format!(
            "provider {provider_id} health failure_threshold must be positive when enabled"
        )));
    }
    if health.enabled && health.cooldown_ms == 0 {
        return Err(validation(format!(
            "provider {provider_id} health cooldown_ms must be positive when enabled"
        )));
    }
    Ok(Some(health))
}

fn compile_provider_request_cleanup(
    provider_id: &str,
    cleanup: V3ProviderRequestCleanupAuthoringConfig,
) -> Result<V3ProviderRequestCleanupAuthoringConfig, V3ConfigError> {
    let mut historical_fields = Vec::new();
    let mut seen = BTreeSet::new();
    for raw_field in cleanup.historical_fields {
        let field = raw_field.trim();
        if field.is_empty() {
            return Err(validation(format!(
                "provider {provider_id} provider_request_cleanup historical_fields contains empty selector"
            )));
        }
        if field.split('.').any(|part| part.trim().is_empty()) {
            return Err(validation(format!(
                "provider {provider_id} provider_request_cleanup historical field {field} contains an empty path segment"
            )));
        }
        if !field
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '_' || ch == '-' || ch == '.')
        {
            return Err(validation(format!(
                "provider {provider_id} provider_request_cleanup historical field {field} contains unsupported selector characters"
            )));
        }
        if !seen.insert(field.to_string()) {
            return Err(validation(format!(
                "provider {provider_id} provider_request_cleanup historical field {field} is duplicated"
            )));
        }
        historical_fields.push(field.to_string());
    }
    Ok(V3ProviderRequestCleanupAuthoringConfig { historical_fields })
}

fn compile_auth(
    provider_id: &str,
    authoring: V3ProviderAuthAuthoringConfig,
) -> Result<V3ProviderAuthManifest, V3ConfigError> {
    if authoring.entries.is_empty() {
        return Err(validation(format!(
            "provider {provider_id} auth entries are empty"
        )));
    }
    let mut aliases = BTreeSet::new();
    let mut entries = Vec::new();
    for entry in authoring.entries {
        require_id("auth alias", &entry.alias)?;
        if !aliases.insert(entry.alias.clone()) {
            return Err(validation(format!(
                "provider {provider_id} has duplicate auth alias {}",
                entry.alias
            )));
        }
        let handle_count = usize::from(entry.env.is_some())
            + usize::from(entry.token_file.is_some())
            + usize::from(entry.secret_file.is_some())
            + usize::from(entry.api_key.is_some());
        if handle_count != 1 {
            return Err(validation(format!(
                "provider {provider_id} auth {} must define exactly one of env, token_file, secret_file, or api_key", entry.alias
            )));
        }
        if entry.secret_file.is_some() != entry.secret_key.is_some() {
            return Err(validation(format!(
                "provider {provider_id} auth {} secret_file and secret_key must be declared together", entry.alias
            )));
        }
        if entry
            .secret_file
            .as_deref()
            .is_some_and(|path| path.trim().is_empty())
        {
            return Err(validation(format!(
                "provider {provider_id} auth {} secret_file cannot be empty",
                entry.alias
            )));
        }
        if entry
            .secret_key
            .as_deref()
            .is_some_and(|key| key.trim().is_empty())
        {
            return Err(validation(format!(
                "provider {provider_id} auth {} secret_key cannot be empty",
                entry.alias
            )));
        }
        if let (Some(secret_file), Some(secret_key)) = (&entry.secret_file, &entry.secret_key) {
            // 集中 secret 文件在编译期解析校验：文件可读、key 存在、值非空——fail-fast
            // 在 config check / 启动阶段暴露；值不写入 manifest（避免明文进快照）。
            crate::read_v3_secret_file_key(secret_file, secret_key).map_err(|error| {
                validation(format!(
                    "provider {provider_id} auth {} secret_file validation failed: {error}",
                    entry.alias
                ))
            })?;
        }
        if let Some(env) = &entry.env {
            if env.trim().is_empty() || looks_like_secret_literal(env) {
                return Err(validation(format!(
                    "provider {provider_id} auth {} env must be a secret handle name",
                    entry.alias
                )));
            }
        }
        if entry
            .token_file
            .as_deref()
            .is_some_and(|path| path.trim().is_empty())
        {
            return Err(validation(format!(
                "provider {provider_id} auth {} token_file cannot be empty",
                entry.alias
            )));
        }
        if entry
            .api_key
            .as_deref()
            .is_some_and(|secret| secret.trim().is_empty())
        {
            return Err(validation(format!(
                "provider {provider_id} auth {} api_key cannot be empty",
                entry.alias
            )));
        }
        entries.push(V3ProviderAuthEntryManifest {
            alias: entry.alias,
            env: entry.env,
            token_file: entry.token_file,
            secret_file: entry.secret_file,
            secret_key: entry.secret_key,
            api_key: entry.api_key,
        });
    }
    Ok(V3ProviderAuthManifest {
        auth_type: authoring.auth_type,
        entries,
    })
}

fn compile_models(
    provider_id: &str,
    authoring: BTreeMap<String, V3ProviderModelAuthoringConfig>,
) -> Result<BTreeMap<String, V3ProviderModelManifest>, V3ConfigError> {
    let mut names = BTreeSet::new();
    let mut models = BTreeMap::new();
    for (id, model) in authoring {
        require_id("model", &id)?;
        if !names.insert(id.clone()) {
            return Err(validation(format!(
                "provider {provider_id} has duplicate model id {id}"
            )));
        }
        for alias in &model.aliases {
            require_id("model alias", alias)?;
            if !names.insert(alias.clone()) {
                return Err(validation(format!(
                    "provider {provider_id} has ambiguous model name {alias}"
                )));
            }
        }
        let mut capabilities = BTreeSet::new();
        for capability in &model.capabilities {
            if capability == "streaming" {
                return Err(validation(format!(
                    "provider {provider_id} model {id} capability streaming is a transport intent, not a model capability; use supports_streaming"
                )));
            }
            if !matches!(
                capability.as_str(),
                "text"
                    | "reasoning"
                    | "tools"
                    | "web_search"
                    | "multimodal"
                    | "vision"
                    | "longcontext"
                    | "no_reasoning_summary"
                    | "remote_continuation"
                    | "local_materialization"
                    | "tool_outputs"
            ) {
                return Err(validation(format!(
                    "provider {provider_id} model {id} declares unknown capability {capability}"
                )));
            }
            if !capabilities.insert(capability) {
                return Err(validation(format!(
                    "provider {provider_id} model {id} declares duplicate capability {capability}"
                )));
            }
        }
        match (
            model.web_search_execution_mode,
            model.web_search_backend.as_deref(),
        ) {
            (mode, binding)
                if mode.is_metadata_center_local_search()
                    && binding.is_none_or(|value| value.trim().is_empty()) =>
            {
                return Err(validation(format!(
                    "provider {provider_id} model {id} metadata_center_local_search requires exactly one web_search_backend binding"
                )));
            }
            (mode, Some(_)) if !mode.is_metadata_center_local_search() => {
                return Err(validation(format!(
                    "provider {provider_id} model {id} declares web_search_backend but execution mode {} does not use a local search backend",
                    mode.as_str()
                )));
            }
            _ => {}
        }
        models.insert(
            id.clone(),
            V3ProviderModelManifest {
                wire_name: model.wire_name.unwrap_or_else(|| id.clone()),
                id,
                aliases: model.aliases,
                capabilities: model.capabilities,
                web_search_execution_mode: model.web_search_execution_mode,
                web_search_backend_binding: model.web_search_backend,
                supports_streaming: model.supports_streaming,
                supports_thinking: model.supports_thinking,
                thinking: model.thinking,
                max_tokens: model.max_tokens,
                max_context_tokens: model.max_context_tokens,
                features: model.features,
            },
        );
    }
    Ok(models)
}

fn validate_cross_provider_model_web_search_mode_uniqueness(
    providers: &BTreeMap<String, V3ProviderManifest>,
) -> Result<(), V3ConfigError> {
    let mut model_modes: BTreeMap<String, (V3WebSearchExecutionMode, &str)> = BTreeMap::new();
    for (provider_id, provider) in providers {
        for (model_id, model) in &provider.models {
            if let Some((existing_mode, existing_provider)) = model_modes.get(model_id) {
                if existing_mode != &model.web_search_execution_mode {
                    return Err(validation(format!(
                        "model {model_id} is declared by providers {existing_provider} and {provider_id} with conflicting web_search_execution_mode ({:?} vs {:?}); the same model name must resolve to the same execution mode",
                        existing_mode, model.web_search_execution_mode
                    )));
                }
            } else {
                model_modes.insert(
                    model_id.clone(),
                    (model.web_search_execution_mode, provider_id),
                );
            }
        }
    }
    Ok(())
}

fn compile_forwarders(
    authoring: BTreeMap<String, V3ForwarderAuthoringConfig>,
    providers: &BTreeMap<String, V3ProviderManifest>,
) -> Result<BTreeMap<String, V3ForwarderManifest>, V3ConfigError> {
    let forwarder_ids = authoring.keys().cloned().collect::<BTreeSet<_>>();
    let compiled = authoring
        .into_iter()
        .map(|(id, forwarder)| {
            require_id("forwarder", &id)?;
            require_id("forwarder model", &forwarder.model)?;
            if forwarder.targets.is_empty() {
                return Err(validation(format!("forwarder {id} has no targets")));
            }
            let mut targets = Vec::new();
            for target in forwarder.targets {
                match target.kind {
                    V3RouteTargetKind::ProviderModel => {
                        let provider = target.provider.as_deref().ok_or_else(|| {
                            validation(format!(
                                "forwarder {id} provider_model target missing provider"
                            ))
                        })?;
                        let model = target.model.as_deref().ok_or_else(|| {
                            validation(format!(
                                "forwarder {id} provider_model target missing model"
                            ))
                        })?;
                        validate_provider_model_ref(
                            &format!("forwarder {id}"),
                            provider,
                            model,
                            providers,
                        )?;
                        validate_auth_alias_ref(
                            &format!("forwarder {id}"),
                            provider,
                            target.key.as_deref(),
                            providers,
                        )?;
                        if target.id.is_some() {
                            return Err(validation(format!(
                                "forwarder {id} provider_model target cannot define id"
                            )));
                        }
                    }
                    V3RouteTargetKind::Forwarder => {
                        let child = target.id.as_deref().ok_or_else(|| {
                            validation(format!("forwarder {id} forwarder target missing id"))
                        })?;
                        if !forwarder_ids.contains(child) {
                            return Err(validation(format!(
                                "forwarder {id} references unknown forwarder {child}"
                            )));
                        }
                        if target.provider.is_some()
                            || target.model.is_some()
                            || target.key.is_some()
                        {
                            return Err(validation(format!(
                                "forwarder {id} forwarder target cannot define provider/model/key"
                            )));
                        }
                    }
                }
                validate_selection_weight(
                    &format!("forwarder {id}"),
                    &forwarder.selection,
                    target.priority,
                    target.weight,
                )?;
                targets.push(V3ForwarderTargetManifest {
                    kind: target.kind,
                    id: target.id,
                    provider: target.provider,
                    model: target.model,
                    key: target.key,
                    priority: target.priority,
                    weight: target.weight,
                });
            }
            Ok((
                id.clone(),
                V3ForwarderManifest {
                    id,
                    enabled: forwarder.enabled,
                    model: forwarder.model,
                    aliases: forwarder.aliases,
                    selection: forwarder.selection,
                    targets,
                    features: forwarder.features,
                },
            ))
        })
        .collect::<Result<BTreeMap<_, _>, V3ConfigError>>()?;
    crate::validate_relations::validate_forwarder_cycles(&compiled)?;
    Ok(compiled)
}

fn compile_route_groups(
    authoring: BTreeMap<String, V3RouteGroupAuthoringConfig>,
    providers: &BTreeMap<String, V3ProviderManifest>,
    forwarders: &BTreeMap<String, V3ForwarderManifest>,
) -> Result<BTreeMap<String, V3RouteGroupManifest>, V3ConfigError> {
    authoring
        .into_iter()
        .map(|(group_id, group)| {
            require_id("route group", &group_id)?;
            let default_pool = group.pools.get("default").ok_or_else(|| {
                validation(format!("route group {group_id} must define default pool"))
            })?;
            if default_pool.targets.is_empty() {
                return Err(validation(format!(
                    "route group {group_id} default pool is empty"
                )));
            }
            let pools = group
                .pools
                .into_iter()
                .map(|(pool_id, pool)| {
                    require_id("route pool", &pool_id)?;
                    if pool.targets.is_empty() {
                        return Err(validation(format!(
                            "route group {group_id} pool {pool_id} is empty"
                        )));
                    }
                    let mut targets = Vec::new();
                    let match_rule = match (pool_id.as_str(), pool.match_rule) {
                        ("default", Some(_)) => {
                            return Err(validation(format!(
                                "route group {group_id} default pool cannot declare match or precedence"
                            )))
                        }
                        ("default", None) => None,
                        (_, Some(match_rule)) => {
                            Some(compile_pool_match(&group_id, &pool_id, match_rule)?)
                        }
                        (_, None) => {
                            return Err(validation(format!(
                                "route group {group_id} non-default pool {pool_id} must declare match"
                            )))
                        }
                    };
                    for target in pool.targets {
                        match target.kind {
                            V3RouteTargetKind::ProviderModel => {
                                let provider = target.provider.as_deref().ok_or_else(|| {
                                    validation(format!("route group {group_id} pool {pool_id} provider_model target missing provider"))
                                })?;
                                let model = target.model.as_deref().ok_or_else(|| {
                                    validation(format!("route group {group_id} pool {pool_id} provider_model target missing model"))
                                })?;
                                validate_provider_model_ref(&format!("route group {group_id} pool {pool_id}"), provider, model, providers)?;
                                validate_auth_alias_ref(&format!("route group {group_id} pool {pool_id}"), provider, target.key.as_deref(), providers)?;
                                if target.id.is_some() {
                                    return Err(validation(format!("route group {group_id} pool {pool_id} provider_model target cannot define id")));
                                }
                            }
                            V3RouteTargetKind::Forwarder => {
                                let id = target.id.as_deref().ok_or_else(|| {
                                    validation(format!("route group {group_id} pool {pool_id} forwarder target missing id"))
                                })?;
                                if !forwarders.contains_key(id) {
                                    return Err(validation(format!(
                                        "route group {group_id} pool {pool_id} references unknown forwarder {id}"
                                    )));
                                }
                                if target.provider.is_some() || target.model.is_some() || target.key.is_some() {
                                    return Err(validation(format!("route group {group_id} pool {pool_id} forwarder target cannot define provider/model/key")));
                                }
                            }
                        }
                        validate_selection_weight(
                            &format!("route group {group_id} pool {pool_id}"),
                            &pool.selection,
                            target.priority,
                            target.weight,
                        )?;
                        targets.push(V3RoutePoolTargetManifest {
                            kind: target.kind,
                            id: target.id,
                            provider: target.provider,
                            model: target.model,
                            key: target.key,
                            priority: target.priority,
                            weight: target.weight,
                        });
                    }
                    Ok((
                        pool_id.clone(),
                        V3RoutePoolManifest {
                            id: pool_id,
                            selection: pool.selection,
                            match_rule,
                            targets,
                            features: pool.features,
                        },
                    ))
                })
                .collect::<Result<BTreeMap<_, _>, V3ConfigError>>()?;
            Ok((
                group_id.clone(),
                V3RouteGroupManifest {
                    id: group_id,
                    pools,
                    features: group.features,
                },
            ))
        })
        .collect()
}

fn compile_pool_match(
    group_id: &str,
    pool_id: &str,
    authoring: V3RoutePoolMatchAuthoringConfig,
) -> Result<V3RoutePoolMatchManifest, V3ConfigError> {
    let precedence = authoring.precedence.ok_or_else(|| {
        validation(format!(
            "route group {group_id} non-default pool {pool_id} must declare precedence"
        ))
    })?;
    if pool_id == "longcontext" && authoring.min_input_tokens.is_none() {
        return Err(validation(format!(
            "route group {group_id} longcontext pool must declare min_input_tokens"
        )));
    }
    if authoring.entry_protocol.is_none()
        && authoring.models.is_empty()
        && authoring.required_capabilities.is_empty()
        && authoring.min_input_tokens.is_none()
        && authoring.max_input_tokens.is_none()
    {
        return Err(validation(format!(
            "route group {group_id} pool {pool_id} pool match has no criteria"
        )));
    }
    if matches!(
        (authoring.min_input_tokens, authoring.max_input_tokens),
        (Some(min), Some(max)) if min > max
    ) {
        return Err(validation(format!(
            "route group {group_id} pool {pool_id} pool match token range is invalid"
        )));
    }
    let models =
        unique_sorted_nonempty_values(group_id, pool_id, "models", authoring.models, None)?;
    if authoring
        .required_capabilities
        .iter()
        .any(|capability| capability == "streaming")
    {
        return Err(validation(format!(
            "route group {group_id} pool {pool_id} required_capabilities streaming is a transport intent, not a route capability"
        )));
    }
    let required_capabilities = unique_sorted_nonempty_values(
        group_id,
        pool_id,
        "required_capabilities",
        authoring.required_capabilities,
        Some(&[
            "text",
            "reasoning",
            "thinking",
            "coding",
            "longcontext",
            "tools",
            "search",
            "web_search",
            "multimodal",
            "vision",
            "remote_continuation",
            "local_materialization",
            "tool_outputs",
        ]),
    )?;
    let entry_protocol = match authoring.entry_protocol {
        Some(protocol) if HUB_V1_ENTRY_PROTOCOLS.contains(&protocol.as_str()) => Some(protocol),
        Some(protocol) => {
            return Err(validation(format!(
                "route group {group_id} pool {pool_id} pool match entry_protocol contains unknown value {protocol}"
            )))
        }
        None => None,
    };
    Ok(V3RoutePoolMatchManifest {
        precedence,
        entry_protocol,
        models,
        required_capabilities,
        min_input_tokens: authoring.min_input_tokens,
        max_input_tokens: authoring.max_input_tokens,
    })
}

fn unique_sorted_nonempty_values(
    group_id: &str,
    pool_id: &str,
    field: &str,
    values: Vec<String>,
    allowed: Option<&[&str]>,
) -> Result<Vec<String>, V3ConfigError> {
    let mut unique = BTreeSet::new();
    for value in values {
        if value.trim().is_empty() {
            return Err(validation(format!(
                "route group {group_id} pool {pool_id} pool match {field} contains empty value"
            )));
        }
        if allowed.is_some_and(|allowed| !allowed.contains(&value.as_str())) {
            return Err(validation(format!(
                "route group {group_id} pool {pool_id} pool match {field} contains unknown value {value}"
            )));
        }
        if !unique.insert(value.clone()) {
            return Err(validation(format!(
                "route group {group_id} pool {pool_id} pool match {field} contains duplicate value {value}"
            )));
        }
    }
    Ok(unique.into_iter().collect())
}

fn validate_provider_model_ref(
    owner: &str,
    provider_id: &str,
    model_id: &str,
    providers: &BTreeMap<String, V3ProviderManifest>,
) -> Result<(), V3ConfigError> {
    let provider = providers
        .get(provider_id)
        .ok_or_else(|| validation(format!("{owner} references unknown provider {provider_id}")))?;
    if !provider.models.contains_key(model_id) {
        return Err(validation(format!(
            "{owner} provider {provider_id} does not declare canonical model {model_id}"
        )));
    }
    Ok(())
}

fn validate_auth_alias_ref(
    owner: &str,
    provider_id: &str,
    alias: Option<&str>,
    providers: &BTreeMap<String, V3ProviderManifest>,
) -> Result<(), V3ConfigError> {
    let Some(alias) = alias else {
        return Ok(());
    };
    let provider = &providers[provider_id];
    if !provider
        .auth
        .entries
        .iter()
        .any(|entry| entry.alias == alias)
    {
        return Err(validation(format!(
            "{owner} provider {provider_id} references unknown auth alias {alias}"
        )));
    }
    Ok(())
}

fn compile_debug(authoring: V3DebugAuthoringConfig) -> Result<V3DebugManifest, V3ConfigError> {
    if authoring
        .log_file
        .as_deref()
        .is_some_and(|path| path.trim().is_empty())
    {
        return Err(validation("debug log_file cannot be empty"));
    }
    let snapshot_stages = authoring
        .snapshot_stages
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    Ok(V3DebugManifest {
        log_console: authoring.log_console,
        log_file: authoring.log_file,
        snapshots: authoring.snapshots,
        // Live sample persistence is a lifecycle authorization, never a config
        // compilation default.  The lifecycle layer may opt in explicitly.
        codex_samples: false,
        snapshot_stages,
        snapshot_direct: authoring.snapshot_direct.unwrap_or(true),
        dry_run: authoring.dry_run,
        retention: authoring.retention,
        full_codex_sampling: false,
    })
}

include!("validate/provider_error_policy.rs");

fn ensure_unique_listen_addresses(
    servers: &BTreeMap<String, V3ServerManifest>,
) -> Result<(), V3ConfigError> {
    let mut addresses = BTreeSet::new();
    for server in servers.values().filter(|server| server.enabled) {
        let address = format!("{}:{}", server.bind, server.port);
        if !addresses.insert(address.clone()) {
            return Err(validation(format!(
                "enabled servers share listen address {address}"
            )));
        }
    }
    Ok(())
}

fn require_id(kind: &str, id: &str) -> Result<(), V3ConfigError> {
    if id.trim().is_empty() {
        Err(validation(format!("{kind} id is empty")))
    } else {
        Ok(())
    }
}

#[cfg(test)]
mod tests;
