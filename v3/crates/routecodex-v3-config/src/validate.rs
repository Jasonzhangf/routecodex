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
    let providers = compile_providers(authoring.providers)?;
    let forwarders = compile_forwarders(authoring.forwarders, &providers)?;
    let route_groups = compile_route_groups(authoring.route_groups, &providers, &forwarders)?;
    let servers = compile_servers(authoring.servers, &route_groups)?;
    ensure_unique_listen_addresses(&servers)?;
    if !servers.values().any(|server| server.enabled) {
        return Err(validation("at least one enabled server is required"));
    }

    Ok(V3Config04ResourceRegistryBuilt {
        version: authoring.version,
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
        servers: registry.servers,
        providers: registry.providers,
        forwarders: registry.forwarders,
        route_groups: registry.route_groups,
        features: registry.features,
        debug: registry.debug,
        error: registry.error,
    })
}

fn compile_servers(
    authoring: BTreeMap<String, V3ServerAuthoringConfig>,
    route_groups: &BTreeMap<String, V3RouteGroupManifest>,
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
            Ok((
                id.clone(),
                V3ServerManifest {
                    id,
                    enabled: server.enabled,
                    bind: server.bind,
                    port: server.port,
                    routing_group: server.routing_group,
                    endpoints: server.endpoints,
                    features: server.features,
                },
            ))
        })
        .collect()
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
                    responses: provider.responses,
                    concurrency: provider.concurrency,
                    features: provider.features,
                },
            ))
        })
        .collect()
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
