use crate::types::*;
use crate::{looks_like_secret_literal, validation, V3ConfigError};
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
    let providers = compile_providers(authoring.providers)?;
    let forwarders = compile_forwarders(authoring.forwarders, &providers)?;
    validate_client_aliases(&providers, &forwarders)?;
    let route_groups = compile_route_groups(authoring.route_groups, &providers, &forwarders)?;
    let servers = compile_servers(authoring.servers, &route_groups, hub_v1.is_some())?;
    ensure_unique_listen_addresses(&servers)?;
    if !servers.values().any(|server| server.enabled) {
        return Err(validation("at least one enabled server is required"));
    }

    Ok(V3Config04ResourceRegistryBuilt {
        version: authoring.version,
        hub_v1,
        servers,
        providers,
        forwarders,
        route_groups,
        features: authoring.features,
        debug: compile_debug(authoring.debug)?,
        error: compile_error(authoring.error)?,
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
fn expected_entry_protocol_endpoint_patterns(protocol: &str) -> Option<&'static [&'static str]> {
    match protocol {
        "responses" => Some(&["/v1/responses"]),
        "anthropic" => Some(&["/v1/messages"]),
        "openai_chat" => Some(&["/v1/chat/completions"]),
        "gemini" => Some(&["/v1beta/models/:model/generateContent"]),
        _ => None,
    }
}

fn expected_entry_protocol_execution_modes(
    protocol: &str,
) -> Option<&'static [V3EntryProtocolExecutionMode]> {
    match protocol {
        "responses" => Some(&[
            V3EntryProtocolExecutionMode::Direct,
            V3EntryProtocolExecutionMode::Relay,
        ]),
        "anthropic" | "openai_chat" | "gemini" => Some(&[V3EntryProtocolExecutionMode::Relay]),
        _ => None,
    }
}

fn compile_hub_v1(
    authoring: Option<V3HubV1AuthoringConfig>,
) -> Result<Option<V3HubV1Manifest>, V3ConfigError> {
    let Some(authoring) = authoring else {
        return Ok(None);
    };
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
                None if hub_v1_enabled => {
                    return Err(validation(format!(
                        "hub_v1 server {id} is missing execution declarations"
                    )))
                }
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

fn compile_providers(
    authoring: BTreeMap<String, V3ProviderAuthoringConfig>,
) -> Result<BTreeMap<String, V3ProviderManifest>, V3ConfigError> {
    authoring
        .into_iter()
        .map(|(id, provider)| {
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
            let models = compile_models(&id, provider.models)?;
            let responses = compile_provider_responses(&id, provider.responses, &models)?;
            let health = compile_provider_health(&id, provider.health)?;
            Ok((
                id.clone(),
                V3ProviderManifest {
                    id,
                    enabled: provider.enabled,
                    provider_type: provider.provider_type,
                    base_url: provider.base_url.trim_end_matches('/').to_string(),
                    default_model: provider.default_model,
                    auth,
                    models,
                    responses,
                    concurrency: provider.concurrency,
                    health,
                    features: provider.features,
                },
            ))
        })
        .collect()
}

fn compile_provider_responses(
    provider_id: &str,
    responses: Option<V3ProviderResponsesAuthoringConfig>,
    models: &BTreeMap<String, V3ProviderModelManifest>,
) -> Result<Option<V3ProviderResponsesAuthoringConfig>, V3ConfigError> {
    let requires_remote_continuation = models.values().any(|model| {
        model
            .capabilities
            .iter()
            .any(|capability| capability == "remote_continuation")
    });
    let Some(responses) = responses else {
        if requires_remote_continuation {
            return Err(validation(format!(
                "provider {provider_id} remote_continuation requires responses websocket_v2 transport"
            )));
        }
        return Ok(None);
    };

    match responses.transport {
        V3ResponsesTransportKind::Http => {
            if responses.websocket_v2_url.is_some() {
                return Err(validation(format!(
                    "provider {provider_id} HTTP transport cannot declare websocket_v2_url"
                )));
            }
            if requires_remote_continuation {
                return Err(validation(format!(
                    "provider {provider_id} remote_continuation requires responses websocket_v2 transport"
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
                    validation(format!(
                        "provider {provider_id} websocket_v2_url is required for websocket_v2 transport"
                    ))
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
        if entry.env.is_none() && entry.token_file.is_none() {
            return Err(validation(format!(
                "provider {provider_id} auth {} needs env or token_file",
                entry.alias
            )));
        }
        if entry.env.is_some() && entry.token_file.is_some() {
            return Err(validation(format!(
                "provider {provider_id} auth {} cannot define both env and token_file",
                entry.alias
            )));
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
        entries.push(V3ProviderAuthEntryManifest {
            alias: entry.alias,
            env: entry.env,
            token_file: entry.token_file,
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
                    | "streaming"
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
        if capabilities.contains(&"remote_continuation".to_string())
            && !capabilities.contains(&"tool_outputs".to_string())
        {
            return Err(validation(format!(
                "provider {provider_id} model {id} remote_continuation requires tool_outputs"
            )));
        }
        if capabilities.contains(&"local_materialization".to_string())
            && !capabilities.contains(&"tool_outputs".to_string())
        {
            return Err(validation(format!(
                "provider {provider_id} model {id} local_materialization requires tool_outputs"
            )));
        }
        if capabilities.contains(&"tool_outputs".to_string())
            && !capabilities.contains(&"remote_continuation".to_string())
            && !capabilities.contains(&"local_materialization".to_string())
        {
            return Err(validation(format!(
                "provider {provider_id} model {id} tool_outputs requires a continuation capability"
            )));
        }
        models.insert(
            id.clone(),
            V3ProviderModelManifest {
                wire_name: model.wire_name.unwrap_or_else(|| id.clone()),
                id,
                aliases: model.aliases,
                capabilities: model.capabilities,
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
    validate_forwarder_cycles(&compiled)?;
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
                                    validation(format!(
                                        "route group {group_id} pool {pool_id} provider_model target missing provider"
                                    ))
                                })?;
                                let model = target.model.as_deref().ok_or_else(|| {
                                    validation(format!(
                                        "route group {group_id} pool {pool_id} provider_model target missing model"
                                    ))
                                })?;
                                validate_provider_model_ref(
                                    &format!("route group {group_id} pool {pool_id}"),
                                    provider,
                                    model,
                                    providers,
                                )?;
                                validate_auth_alias_ref(
                                    &format!("route group {group_id} pool {pool_id}"),
                                    provider,
                                    target.key.as_deref(),
                                    providers,
                                )?;
                                if target.id.is_some() {
                                    return Err(validation(format!("route group {group_id} pool {pool_id} provider_model target cannot define id")));
                                }
                            }
                            V3RouteTargetKind::Forwarder => {
                                let id = target.id.as_deref().ok_or_else(|| {
                                    validation(format!(
                                        "route group {group_id} pool {pool_id} forwarder target missing id"
                                    ))
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
            "streaming",
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

fn validate_forwarder_cycles(
    forwarders: &BTreeMap<String, V3ForwarderManifest>,
) -> Result<(), V3ConfigError> {
    fn visit(
        id: &str,
        forwarders: &BTreeMap<String, V3ForwarderManifest>,
        visiting: &mut BTreeSet<String>,
        visited: &mut BTreeSet<String>,
    ) -> Result<(), V3ConfigError> {
        if visited.contains(id) {
            return Ok(());
        }
        if !visiting.insert(id.to_string()) {
            return Err(validation(format!(
                "forwarder target graph contains cycle at {id}"
            )));
        }
        for child in forwarders[id]
            .targets
            .iter()
            .filter(|target| target.kind == V3RouteTargetKind::Forwarder)
            .filter_map(|target| target.id.as_deref())
        {
            visit(child, forwarders, visiting, visited)?;
        }
        visiting.remove(id);
        visited.insert(id.to_string());
        Ok(())
    }
    let mut visiting = BTreeSet::new();
    let mut visited = BTreeSet::new();
    for id in forwarders.keys() {
        visit(id, forwarders, &mut visiting, &mut visited)?;
    }
    Ok(())
}

fn validate_client_aliases(
    providers: &BTreeMap<String, V3ProviderManifest>,
    forwarders: &BTreeMap<String, V3ForwarderManifest>,
) -> Result<(), V3ConfigError> {
    fn register(
        names: &mut BTreeMap<String, String>,
        name: &str,
        canonical: &str,
    ) -> Result<(), V3ConfigError> {
        if let Some(existing) = names.get(name) {
            if existing != canonical {
                return Err(validation(format!(
                    "ambiguous client alias {name} maps to both {existing} and {canonical}"
                )));
            }
        } else {
            names.insert(name.to_string(), canonical.to_string());
        }
        Ok(())
    }

    let mut names = BTreeMap::new();
    for provider in providers.values() {
        for model in provider.models.values() {
            register(&mut names, &model.id, &model.id)?;
            for alias in &model.aliases {
                register(&mut names, alias, &model.id)?;
            }
        }
    }
    for forwarder in forwarders.values() {
        register(&mut names, &forwarder.model, &forwarder.model)?;
        for alias in &forwarder.aliases {
            register(&mut names, alias, &forwarder.model)?;
        }
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
    Ok(V3DebugManifest {
        log_console: authoring.log_console,
        log_file: authoring.log_file,
        snapshots: authoring.snapshots,
        dry_run: authoring.dry_run,
        retention: authoring.retention,
    })
}

fn compile_error(authoring: V3ErrorAuthoringConfig) -> Result<V3ErrorManifest, V3ConfigError> {
    let policies = authoring
        .policies
        .into_iter()
        .map(|(id, policy)| {
            require_id("error policy", &id)?;
            if policy.action.trim().is_empty() {
                return Err(validation(format!("error policy {id} action is empty")));
            }
            Ok((
                id,
                V3ErrorPolicyManifest {
                    action: policy.action,
                    cooldown_ms: policy.cooldown_ms,
                    max_attempts: policy.max_attempts,
                },
            ))
        })
        .collect::<Result<_, V3ConfigError>>()?;
    Ok(V3ErrorManifest { policies })
}

fn validate_selection_weight(
    owner: &str,
    policy: &V3SelectionPolicy,
    priority: Option<i32>,
    weight: Option<u32>,
) -> Result<(), V3ConfigError> {
    match policy.strategy {
        V3SelectionStrategy::Priority if priority.is_none() => Err(validation(format!(
            "{owner} priority selection target missing priority"
        ))),
        V3SelectionStrategy::Weighted if weight.unwrap_or(0) == 0 => Err(validation(format!(
            "{owner} weighted selection target needs positive weight"
        ))),
        V3SelectionStrategy::RoundRobin => Ok(()),
        _ => Ok(()),
    }
}

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
