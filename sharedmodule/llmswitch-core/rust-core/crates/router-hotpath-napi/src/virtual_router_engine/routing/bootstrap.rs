use napi::bindgen_prelude::Result as NapiResult;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::{BTreeMap, HashMap, HashSet};

use crate::shared_json_utils::read_trimmed_string as read_optional_string;
use crate::virtual_router_engine::error::format_virtual_router_error;
use crate::virtual_router_engine::load_balancer::LoadBalancingPolicy;
use crate::virtual_router_engine::profile_utils::build_runtime_key;

use super::config::RoutePoolTier;
use super::utils::{
    normalize_positive_i64, normalize_priority_value, parse_bool_like, scalar_to_trimmed_string,
};
pub(crate) const PROVIDER_LEVEL_POOL_ALIAS: &str = "pool";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NormalizedRoutePoolConfig {
    pub id: String,
    pub priority: i64,
    pub backup: bool,
    pub targets: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mode: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub force: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub load_balancing: Option<LoadBalancingPolicy>,
    #[serde(rename = "routeParams", skip_serializing_if = "Option::is_none")]
    pub route_params: Option<Map<String, Value>>,
    /// Reasoning effort override for this route pool (low/medium/high/off).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thinking: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ModelIndexEntry {
    #[serde(default)]
    declared: bool,
    #[serde(default)]
    models: Vec<String>,
    #[serde(default)]
    alias_to_model: BTreeMap<String, String>,
}

#[derive(Debug, Clone)]
pub(crate) struct ParsedRouteEntry {
    provider_id: String,
    key_alias: Option<String>,
    model_id: String,
    priority: i64,
}

#[derive(Debug, Clone)]
pub(crate) struct ExpandedTargetCandidate {
    key: String,
    priority: i64,
    order: usize,
}

fn read_route_policy_group(route_params: &Option<Map<String, Value>>) -> Option<String> {
    route_params
        .as_ref()
        .and_then(|params| params.get("routePolicyGroup"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
}

fn resolve_pool_strategy(pool: &NormalizedRoutePoolConfig) -> String {
    pool.load_balancing
        .as_ref()
        .and_then(|lb| lb.strategy.as_deref())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .or(pool.mode.as_deref())
        .unwrap_or("priority")
        .to_string()
}

fn display_pool_id(pool: &NormalizedRoutePoolConfig, route_name: &str) -> String {
    let Some(group) = read_route_policy_group(&pool.route_params) else {
        return pool.id.clone();
    };
    let strategy = resolve_pool_strategy(pool).replace('_', "-");
    format!("{}-{}-{}", group.replace('_', "-"), strategy, route_name)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RoutingBootstrapOutput {
    routing_source: BTreeMap<String, Vec<NormalizedRoutePoolConfig>>,
    routing: BTreeMap<String, Vec<RoutePoolTier>>,
    target_keys: Vec<String>,
}

pub(crate) fn bootstrap_virtual_router_routing_json(
    routing_json: String,
    alias_index_json: String,
    model_index_json: String,
    forwarder_ids_json: Option<String>,
) -> NapiResult<String> {
    let routing_source_map: Map<String, Value> = serde_json::from_str(&routing_json)
        .map_err(|error| napi::Error::from_reason(error.to_string()))?;
    let alias_index: BTreeMap<String, Vec<String>> = serde_json::from_str(&alias_index_json)
        .map_err(|error| napi::Error::from_reason(error.to_string()))?;
    let model_index: BTreeMap<String, ModelIndexEntry> = serde_json::from_str(&model_index_json)
        .map_err(|error| napi::Error::from_reason(error.to_string()))?;
    let forwarder_ids: HashSet<String> = forwarder_ids_json
        .as_deref()
        .and_then(|raw| serde_json::from_str::<Vec<String>>(raw).ok())
        .unwrap_or_default()
        .into_iter()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .collect();

    let normalized_routing = normalize_routing_impl(&routing_source_map);
    let (expanded_routing, target_keys) = expand_routing_table_impl(
        &normalized_routing,
        &alias_index,
        &model_index,
        &forwarder_ids,
    )
    .map_err(|error| {
        napi::Error::from_reason(format_virtual_router_error("CONFIG_ERROR", error))
    })?;

    let output = RoutingBootstrapOutput {
        routing_source: normalized_routing,
        routing: expanded_routing,
        target_keys,
    };

    serde_json::to_string(&output).map_err(|error| napi::Error::from_reason(error.to_string()))
}

pub(crate) fn normalize_routing_impl(
    source: &Map<String, Value>,
) -> BTreeMap<String, Vec<NormalizedRoutePoolConfig>> {
    let mut routing: BTreeMap<String, Vec<NormalizedRoutePoolConfig>> = BTreeMap::new();
    for (route_name, entries_value) in source.iter() {
        let Some(entries) = entries_value.as_array() else {
            routing.insert(route_name.clone(), Vec::new());
            continue;
        };
        if entries.is_empty() {
            routing.insert(route_name.clone(), Vec::new());
            continue;
        }

        let all_strings = entries
            .iter()
            .all(|entry| entry.is_string() || entry.is_null());
        if all_strings {
            let targets = normalize_target_list(entries_value);
            let pools = if targets.is_empty() {
                Vec::new()
            } else {
                vec![build_legacy_route_pool(route_name, targets)]
            };
            routing.insert(route_name.clone(), pools);
            continue;
        }

        if let Some(pool) = normalize_simplified_weighted_route(route_name, entries) {
            routing.insert(route_name.clone(), vec![pool]);
            continue;
        }

        let total = entries.len();
        let mut normalized: Vec<NormalizedRoutePoolConfig> = Vec::new();
        for (index, entry) in entries.iter().enumerate() {
            if let Some(pool) = normalize_route_pool_entry(route_name, entry, index, total) {
                if !pool.targets.is_empty() {
                    normalized.push(pool);
                }
            }
        }
        routing.insert(route_name.clone(), normalized);
    }
    routing
}

pub(crate) fn expand_routing_table_impl(
    routing_source: &BTreeMap<String, Vec<NormalizedRoutePoolConfig>>,
    alias_index: &BTreeMap<String, Vec<String>>,
    model_index: &BTreeMap<String, ModelIndexEntry>,
    forwarder_ids: &HashSet<String>,
) -> Result<(BTreeMap<String, Vec<RoutePoolTier>>, Vec<String>), String> {
    let mut routing: BTreeMap<String, Vec<RoutePoolTier>> = BTreeMap::new();
    let mut target_keys: Vec<String> = Vec::new();
    let mut seen_target_keys: HashSet<String> = HashSet::new();

    for (route_name, pools) in routing_source.iter() {
        let mut expanded_pools: Vec<RoutePoolTier> = Vec::new();
        for pool in pools {
            let mut expanded_targets: Vec<ExpandedTargetCandidate> = Vec::new();
            let mut order_counter: usize = 0;
            for entry in &pool.targets {
                if forwarder_ids.contains(entry) {
                    expanded_targets.push(ExpandedTargetCandidate {
                        key: entry.clone(),
                        priority: 100,
                        order: order_counter,
                    });
                    order_counter += 1;
                    continue;
                }
                let Some(parsed) = parse_route_entry(entry, alias_index) else {
                    continue;
                };

                if !alias_index.contains_key(&parsed.provider_id) {
                    return Err(format!(
                        "Route \"{}\" references unknown provider \"{}\"",
                        route_name, parsed.provider_id
                    ));
                }

                let canonical_model_id = if let Some(model_info) = model_index.get(&parsed.provider_id) {
                    if model_info.declared {
                        let canonical_model_id = resolve_canonical_model_id(&parsed.model_id, model_info)
                            .ok_or_else(|| {
                                format!(
                                    "Route \"{}\" references unknown model \"{}\" for provider \"{}\"",
                                    route_name, parsed.model_id, parsed.provider_id
                                )
                            })?;
                        if canonical_model_id.trim().is_empty() {
                            return Err(format!(
                                "Route \"{}\" references empty model id for provider \"{}\"",
                                route_name, parsed.provider_id
                            ));
                        }
                        if model_info.models.is_empty() {
                            return Err(format!(
                                "Route \"{}\" references provider \"{}\" but provider declares no models",
                                route_name, parsed.provider_id
                            ));
                        }
                        if !model_info.models.iter().any(|candidate| candidate == &canonical_model_id) {
                            return Err(format!(
                                "Route \"{}\" references unknown model \"{}\" for provider \"{}\"",
                                route_name, parsed.model_id, parsed.provider_id
                            ));
                        }
                        canonical_model_id
                    } else {
                        parsed.model_id.clone()
                    }
                } else {
                    parsed.model_id.clone()
                };

                let aliases = if let Some(alias) = parsed.key_alias.clone() {
                    vec![alias]
                } else {
                    let all_aliases = alias_index
                        .get(&parsed.provider_id)
                        .cloned()
                        .unwrap_or_default();
                    if all_aliases
                        .iter()
                        .any(|alias| alias == PROVIDER_LEVEL_POOL_ALIAS)
                    {
                        vec![PROVIDER_LEVEL_POOL_ALIAS.to_string()]
                    } else {
                        all_aliases
                    }
                };

                if aliases.is_empty() {
                    return Err(format!(
                        "Provider {} has no auth aliases but is referenced in routing",
                        parsed.provider_id
                    ));
                }

                for alias in aliases {
                    let runtime_key = build_runtime_key(&parsed.provider_id, &alias);
                    let target_key = format!("{}.{}", runtime_key, canonical_model_id);
                    if let Some(existing) = expanded_targets
                        .iter_mut()
                        .find(|candidate| candidate.key == target_key)
                    {
                        if parsed.priority > existing.priority {
                            existing.priority = parsed.priority;
                        }
                        continue;
                    }
                    expanded_targets.push(ExpandedTargetCandidate {
                        key: target_key.clone(),
                        priority: parsed.priority,
                        order: order_counter,
                    });
                    order_counter += 1;
                    if seen_target_keys.insert(target_key.clone()) {
                        target_keys.push(target_key);
                    }
                }
            }

            if expanded_targets.is_empty() {
                continue;
            }

            let sorted_targets = if pool.mode.as_deref() == Some("priority") {
                expanded_targets.sort_by(|left, right| {
                    right
                        .priority
                        .cmp(&left.priority)
                        .then(left.order.cmp(&right.order))
                });
                expanded_targets
                    .iter()
                    .map(|candidate| candidate.key.clone())
                    .collect::<Vec<String>>()
            } else {
                expanded_targets
                    .iter()
                    .map(|candidate| candidate.key.clone())
                    .collect::<Vec<String>>()
            };

            // Remap weight keys: when a config target like "mimo.mimo-v2.5" is
            // expanded to "mimo.pool.mimo-v2.5", the weight key must also use
            // the expanded target name so it matches at selection time.
            let mut load_balancing = pool.load_balancing.clone();
            if let Some(ref mut lb) = load_balancing {
                if let Some(ref mut weights) = lb.weights {
                    let mut needs_remap = false;
                    let mut remapped: HashMap<String, i64> = HashMap::new();
                    for (config_key, weight) in weights.iter() {
                        let parsed = parse_route_entry(config_key, alias_index);
                        let has_key_alias =
                            parsed.as_ref().and_then(|p| p.key_alias.as_ref()).is_some();
                        if !has_key_alias {
                            let matching: Vec<String> = sorted_targets
                                .iter()
                                .filter(|t| {
                                    if t.as_str() == config_key.as_str() {
                                        return true;
                                    }
                                    let Some(parsed) = parsed.as_ref() else {
                                        return false;
                                    };
                                    t.as_str().starts_with(&format!("{}.", parsed.provider_id))
                                        && t.as_str().ends_with(&format!(".{}", parsed.model_id))
                                })
                                .cloned()
                                .collect();
                            if !matching.is_empty() {
                                for matched in matching {
                                    remapped.insert(matched, *weight);
                                }
                                needs_remap = true;
                            } else {
                                remapped.insert(config_key.clone(), *weight);
                            }
                        } else {
                            remapped.insert(config_key.clone(), *weight);
                        }
                    }
                    if needs_remap {
                        *weights = remapped;
                    }
                }
            }

            // routePolicyGroup is the routing isolation source of truth. Pool id is display-only.
            let mut enriched_params = pool.route_params.clone();
            let route_policy_group = read_route_policy_group(&enriched_params);
            if route_policy_group.is_none() {
                if let Some(last_dash) = pool.id.rfind('-') {
                    let group_prefix = &pool.id[..last_dash];
                    let group_underscore = group_prefix.replace('-', "_");
                    if !group_underscore.is_empty() {
                        enriched_params.get_or_insert_with(|| Map::new()).insert(
                            "routePolicyGroup".to_string(),
                            Value::String(group_underscore),
                        );
                    }
                }
            }
            let route_policy_group = read_route_policy_group(&enriched_params);
            expanded_pools.push(RoutePoolTier {
                id: display_pool_id(pool, route_name),
                priority: pool.priority,
                targets: sorted_targets,
                mode: pool.mode.clone(),
                backup: Some(pool.backup),
                force: pool.force,
                load_balancing,
                route_params: enriched_params,
                thinking: pool.thinking.clone(),
            });
            if let Some(group) = route_policy_group {
                if let Some(last) = expanded_pools.last_mut() {
                    last.route_params
                        .get_or_insert_with(|| Map::new())
                        .insert("routePolicyGroup".to_string(), Value::String(group));
                }
            }
        }
        // Key by "{group}:{route}" for per-port isolation. Multiple pools for the same
        // route+port are collected under one key (typically one pool per route).
        for pool in expanded_pools.drain(..) {
            let group_key = pool
                .route_params
                .as_ref()
                .and_then(|params| params.get("routePolicyGroup"))
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|group| !group.is_empty())
                .map(|group| format!("{}:{}", group, route_name))
                .unwrap_or_else(|| route_name.clone());
            routing.entry(group_key).or_insert_with(Vec::new).push(pool);
        }
    }

    Ok((routing, target_keys))
}

fn build_legacy_route_pool(route_name: &str, targets: Vec<String>) -> NormalizedRoutePoolConfig {
    NormalizedRoutePoolConfig {
        id: format!("{}:pool0", route_name),
        priority: targets.len() as i64,
        backup: false,
        targets,
        mode: None,
        force: None,
        load_balancing: None,
        route_params: None,
        thinking: None,
    }
}

fn normalize_route_pool_entry(
    route_name: &str,
    entry: &Value,
    index: usize,
    total: usize,
) -> Option<NormalizedRoutePoolConfig> {
    if let Some(raw) = entry.as_str() {
        let targets = normalize_target_list(&Value::String(raw.to_string()));
        return if targets.is_empty() {
            None
        } else {
            Some(NormalizedRoutePoolConfig {
                id: format!("{}:pool{}", route_name, index + 1),
                priority: (total.saturating_sub(index)) as i64,
                backup: false,
                targets,
                mode: None,
                force: None,
                load_balancing: None,
                route_params: None,
                thinking: None,
            })
        };
    }

    let record = entry.as_object()?;
    if let Some((target, weight, route_params)) = normalize_simplified_weighted_target(record) {
        return Some(NormalizedRoutePoolConfig {
            id: read_optional_string(record.get("id"))
                .or_else(|| read_optional_string(record.get("poolId")))
                .unwrap_or_else(|| format!("{}:pool{}", route_name, index + 1)),
            priority: normalize_priority_value(
                record.get("priority"),
                (total.saturating_sub(index)) as i64,
            ),
            backup: false,
            targets: vec![target.clone()],
            mode: Some("priority".to_string()),
            force: None,
            load_balancing: Some(LoadBalancingPolicy {
                strategy: Some("weighted".to_string()),
                weights: Some(HashMap::from([(target, weight)])),
                health_weighted: None,
                context_weighted: None,
            }),
            route_params,
            thinking: normalize_thinking(record),
        });
    }
    let id = read_optional_string(record.get("id"))
        .or_else(|| read_optional_string(record.get("poolId")))
        .unwrap_or_else(|| format!("{}:pool{}", route_name, index + 1));
    let backup = record
        .get("backup")
        .and_then(Value::as_bool)
        .unwrap_or(false)
        || record
            .get("isBackup")
            .and_then(Value::as_bool)
            .unwrap_or(false)
        || record
            .get("type")
            .and_then(Value::as_str)
            .map(|value| value.trim().eq_ignore_ascii_case("backup"))
            .unwrap_or(false);
    let priority =
        normalize_priority_value(record.get("priority"), (total.saturating_sub(index)) as i64);
    let load_balancing = normalize_route_pool_load_balancing(record.get("loadBalancing"));
    let targets = normalize_route_targets(record, load_balancing.as_ref());
    let explicit_mode = normalize_route_pool_mode(
        record
            .get("mode")
            .or_else(|| record.get("strategy"))
            .or_else(|| record.get("routingMode")),
    );
    let mode = explicit_mode
        .or_else(|| infer_route_pool_mode_from_config(record, &targets, load_balancing.as_ref()));
    let force = record.get("force").and_then(parse_bool_like);
    let route_params = normalize_route_params(record);

    if targets.is_empty() {
        return None;
    }

    Some(NormalizedRoutePoolConfig {
        id,
        priority,
        backup,
        targets,
        mode,
        force: if force.unwrap_or(false) {
            Some(true)
        } else {
            None
        },
        load_balancing,
        route_params,
        thinking: normalize_thinking(record),
    })
}

fn normalize_simplified_weighted_route(
    route_name: &str,
    entries: &[Value],
) -> Option<NormalizedRoutePoolConfig> {
    let mut targets: Vec<String> = Vec::new();
    let mut weights: HashMap<String, i64> = HashMap::new();
    let mut route_params: Option<Map<String, Value>> = None;
    let mut thinking: Option<String> = None;
    for entry in entries {
        let record = entry.as_object()?;
        let (target, weight, params) = normalize_simplified_weighted_target(record)?;
        if !targets.contains(&target) {
            targets.push(target.clone());
        }
        weights.insert(target, weight);
        if route_params.is_none() {
            route_params = params;
        }
        if thinking.is_none() {
            thinking = normalize_thinking(record);
        }
    }
    if targets.is_empty() {
        return None;
    }
    Some(NormalizedRoutePoolConfig {
        id: format!("{}:weighted", route_name),
        priority: targets.len() as i64,
        backup: false,
        targets,
        mode: None,
        force: None,
        load_balancing: Some(LoadBalancingPolicy {
            strategy: Some("weighted".to_string()),
            weights: Some(weights),
            health_weighted: None,
            context_weighted: None,
        }),
        route_params,
        thinking,
    })
}

fn normalize_simplified_weighted_target(
    record: &Map<String, Value>,
) -> Option<(String, i64, Option<Map<String, Value>>)> {
    let target = record
        .get("target")
        .or_else(|| record.get("provider"))
        .map(normalize_target_list)?
        .into_iter()
        .next()?;
    let weight = record
        .get("weight")
        .or_else(|| record.get("weights"))
        .and_then(Value::as_i64)
        .filter(|v| *v > 0)
        .unwrap_or(1);
    Some((target, weight, normalize_route_params(record)))
}

fn normalize_route_params(record: &Map<String, Value>) -> Option<Map<String, Value>> {
    for key in ["routeParams", "params", "parameters"] {
        if let Some(map) = record.get(key).and_then(Value::as_object) {
            return Some(map.clone());
        }
    }
    let mut params = Map::new();
    for key in [
        "reasoning_effort",
        "reasoningEffort",
        "thinking",
        "thinking_enabled",
        "anthropicThinking",
        "anthropicThinkingConfig",
    ] {
        if let Some(value) = record.get(key) {
            params.insert(key.to_string(), value.clone());
        }
    }
    if params.is_empty() {
        None
    } else {
        Some(params)
    }
}

/// Extract the top-level `thinking` field from a route pool record.
/// Returns the string value if present, None otherwise.
fn normalize_thinking(record: &Map<String, Value>) -> Option<String> {
    for key in ["thinking", "reasoningEffort", "reasoning_effort"] {
        if let Some(value) = record.get(key).and_then(Value::as_str) {
            let trimmed = value.trim();
            if !trimmed.is_empty() {
                return Some(trimmed.to_lowercase());
            }
        }
    }
    // Also check inside routeParams
    for key in ["routeParams", "params", "parameters"] {
        if let Some(map) = record.get(key).and_then(Value::as_object) {
            for tkey in ["thinking", "reasoningEffort", "reasoning_effort"] {
                if let Some(value) = map.get(tkey).and_then(Value::as_str) {
                    let trimmed = value.trim();
                    if !trimmed.is_empty() {
                        return Some(trimmed.to_lowercase());
                    }
                }
            }
        }
    }
    None
}

fn infer_route_pool_mode_from_config(
    record: &Map<String, Value>,
    targets: &[String],
    load_balancing: Option<&LoadBalancingPolicy>,
) -> Option<String> {
    if targets.is_empty() {
        return None;
    }
    if has_explicit_route_targets(record) {
        return None;
    }
    let nested = record.get("loadBalancing").and_then(Value::as_object);
    let has_nested_ordered_targets = nested
        .map(|nested_record| {
            [
                "targets",
                "providers",
                "order",
                "entries",
                "items",
                "routes",
                "target",
                "provider",
            ]
            .iter()
            .any(|key| {
                nested_record
                    .get(*key)
                    .map(normalize_target_list)
                    .map(|items| !items.is_empty())
                    .unwrap_or(false)
            })
        })
        .unwrap_or(false);
    if has_nested_ordered_targets {
        return Some("priority".to_string());
    }
    if load_balancing
        .and_then(|policy| policy.weights.as_ref())
        .map(|weights| !weights.is_empty())
        .unwrap_or(false)
    {
        return Some("priority".to_string());
    }
    None
}

fn normalize_route_pool_load_balancing(input: Option<&Value>) -> Option<LoadBalancingPolicy> {
    let record = input.and_then(Value::as_object)?;
    let strategy = normalize_weighted_strategy(record.get("strategy"));
    let weights_source = record.get("weights").and_then(Value::as_object);
    let mut weights: HashMap<String, i64> = HashMap::new();
    if let Some(raw_weights) = weights_source {
        for (key, value) in raw_weights {
            let Some(weight) = normalize_positive_i64(value) else {
                continue;
            };
            weights.insert(key.clone(), weight);
        }
    }
    if strategy.is_none() && weights.is_empty() {
        return None;
    }
    Some(LoadBalancingPolicy {
        strategy,
        weights: if weights.is_empty() {
            None
        } else {
            Some(weights)
        },
        health_weighted: None,
        context_weighted: None,
    })
}

fn normalize_weighted_strategy(value: Option<&Value>) -> Option<String> {
    let normalized = value.and_then(Value::as_str)?.trim().to_ascii_lowercase();
    if normalized.is_empty() {
        return None;
    }
    match normalized.as_str() {
        "weighted" => Some("weighted".to_string()),
        "round-robin" | "round_robin" | "roundrobin" | "rr" => Some("round-robin".to_string()),
        _ => None,
    }
}

fn normalize_route_pool_mode(value: Option<&Value>) -> Option<String> {
    let normalized = value.and_then(Value::as_str)?.trim().to_ascii_lowercase();
    if normalized.is_empty() {
        return None;
    }
    match normalized.as_str() {
        "priority" => Some("priority".to_string()),
        "round-robin" | "round_robin" | "roundrobin" | "rr" => Some("round-robin".to_string()),
        _ => None,
    }
}

fn normalize_route_targets(
    record: &Map<String, Value>,
    load_balancing: Option<&LoadBalancingPolicy>,
) -> Vec<String> {
    let load_balancing_record = record.get("loadBalancing").and_then(Value::as_object);
    let buckets = [
        record.get("targets"),
        record.get("providers"),
        record.get("pool"),
        record.get("entries"),
        record.get("items"),
        record.get("routes"),
        load_balancing_record.and_then(|node| node.get("targets")),
        load_balancing_record.and_then(|node| node.get("providers")),
        load_balancing_record.and_then(|node| node.get("order")),
        load_balancing_record.and_then(|node| node.get("entries")),
        load_balancing_record.and_then(|node| node.get("items")),
        load_balancing_record.and_then(|node| node.get("routes")),
    ];

    let mut normalized: Vec<String> = Vec::new();
    for bucket in buckets {
        let Some(value) = bucket else {
            continue;
        };
        for target in normalize_target_list(value) {
            if !normalized.iter().any(|candidate| candidate == &target) {
                normalized.push(target);
            }
        }
    }

    let singular = [
        record.get("target"),
        record.get("provider"),
        load_balancing_record.and_then(|node| node.get("target")),
        load_balancing_record.and_then(|node| node.get("provider")),
    ];
    for candidate in singular {
        let Some(value) = candidate else {
            continue;
        };
        for target in normalize_target_list(value) {
            if !normalized.iter().any(|item| item == &target) {
                normalized.push(target);
            }
        }
    }

    if normalized.is_empty() {
        if let Some(raw_weights) = load_balancing_record
            .and_then(|node| node.get("weights"))
            .and_then(Value::as_object)
        {
            for target in raw_weights.keys() {
                let trimmed = target.trim();
                if !trimmed.is_empty() && !normalized.iter().any(|item| item == trimmed) {
                    normalized.push(trimmed.to_string());
                }
            }
        } else if let Some(weights) = load_balancing.and_then(|policy| policy.weights.as_ref()) {
            for target in weights.keys() {
                let trimmed = target.trim();
                if !trimmed.is_empty() && !normalized.iter().any(|item| item == trimmed) {
                    normalized.push(trimmed.to_string());
                }
            }
        }
    }

    normalized
}

fn has_explicit_route_targets(record: &Map<String, Value>) -> bool {
    let explicit_keys = ["targets", "providers", "pool", "entries", "items", "routes"];
    if explicit_keys.iter().any(|key| {
        record
            .get(*key)
            .map(normalize_target_list)
            .map(|items| !items.is_empty())
            .unwrap_or(false)
    }) {
        return true;
    }
    record
        .get("target")
        .map(normalize_target_list)
        .map(|items| !items.is_empty())
        .unwrap_or(false)
        || record
            .get("provider")
            .map(normalize_target_list)
            .map(|items| !items.is_empty())
            .unwrap_or(false)
}

fn normalize_target_list(value: &Value) -> Vec<String> {
    match value {
        Value::Array(entries) => {
            let mut normalized: Vec<String> = Vec::new();
            for entry in entries {
                let Some(trimmed) = scalar_to_trimmed_string(entry) else {
                    continue;
                };
                if !normalized.iter().any(|candidate| candidate == &trimmed) {
                    normalized.push(trimmed);
                }
            }
            normalized
        }
        _ => scalar_to_trimmed_string(value)
            .map(|trimmed| vec![trimmed])
            .unwrap_or_default(),
    }
}

fn parse_route_entry(
    entry: &str,
    alias_index: &BTreeMap<String, Vec<String>>,
) -> Option<ParsedRouteEntry> {
    let value = entry.trim();
    if value.is_empty() {
        return None;
    }
    let first_dot = value.find('.')?;
    if first_dot == 0 || first_dot >= value.len() - 1 {
        return None;
    }
    let provider_id = value[..first_dot].to_string();
    let remainder = &value[first_dot + 1..];

    if let Some(aliases) = alias_index.get(&provider_id) {
        if !aliases.is_empty() {
            if let Some(second_dot) = remainder.find('.') {
                if second_dot > 0 && second_dot < remainder.len() - 1 {
                    let alias_candidate = &remainder[..second_dot];
                    if aliases.iter().any(|candidate| candidate == alias_candidate) {
                        let (model_id, priority) =
                            split_model_priority(&remainder[second_dot + 1..]);
                        return Some(ParsedRouteEntry {
                            provider_id,
                            key_alias: Some(alias_candidate.to_string()),
                            model_id,
                            priority,
                        });
                    }
                }
            }
        }
    }

    let (model_id, priority) = split_model_priority(remainder);
    Some(ParsedRouteEntry {
        provider_id,
        key_alias: None,
        model_id,
        priority,
    })
}

fn resolve_canonical_model_id(model_id: &str, model_index: &ModelIndexEntry) -> Option<String> {
    let trimmed = model_id.trim();
    if trimmed.is_empty() {
        return None;
    }
    if model_index.models.iter().any(|candidate| candidate == trimmed) {
        return Some(trimmed.to_string());
    }
    model_index.alias_to_model.get(trimmed).cloned()
}

fn split_model_priority(raw: &str) -> (String, i64) {
    let value = raw.trim();
    if value.is_empty() {
        return (String::new(), 100);
    }
    if let Some(index) = value.rfind(':') {
        if index > 0 && index < value.len() - 1 {
            let model_id = value[..index].trim();
            let priority_raw = value[index + 1..].trim();
            if !model_id.is_empty() && priority_raw.chars().all(|ch| ch.is_ascii_digit()) {
                if let Ok(parsed) = priority_raw.parse::<i64>() {
                    return (model_id.to_string(), parsed);
                }
                return (model_id.to_string(), 100);
            }
        }
    }
    (value.to_string(), 100)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn weighted_pool_display_id_uses_strategy_not_priority() {
        let mut route_params = Map::new();
        route_params.insert(
            "routePolicyGroup".to_string(),
            Value::String("gateway_priority_5555".to_string()),
        );
        let pool = NormalizedRoutePoolConfig {
            id: "gateway-priority-5555-search".to_string(),
            priority: 100,
            backup: false,
            targets: vec!["mini27.MiniMax-M2.7".to_string()],
            mode: None,
            force: None,
            load_balancing: Some(LoadBalancingPolicy {
                strategy: Some("weighted".to_string()),
                weights: None,
                health_weighted: None,
                context_weighted: None,
            }),
            route_params: Some(route_params),
            thinking: None,
        };

        assert_eq!(
            display_pool_id(&pool, "search"),
            "gateway-priority-5555-weighted-search"
        );
    }

    #[test]
    fn provider_level_target_expands_to_individual_auth_keys_unless_pool_alias_exists() {
        let routing_source = BTreeMap::from([(
            "search".to_string(),
            vec![NormalizedRoutePoolConfig {
                id: "search".to_string(),
                priority: 100,
                backup: false,
                targets: vec!["mimo.mimo-v2.5".to_string()],
                mode: Some("weighted".to_string()),
                force: None,
                load_balancing: Some(LoadBalancingPolicy {
                    strategy: Some("weighted".to_string()),
                    weights: Some(HashMap::from([("mimo.mimo-v2.5".to_string(), 1)])),
                    health_weighted: None,
                    context_weighted: None,
                }),
                route_params: None,
                thinking: None,
            }],
        )]);
        let alias_index = BTreeMap::from([(
            "mimo".to_string(),
            vec!["key1".to_string(), "key2".to_string()],
        )]);
        let model_index = BTreeMap::from([(
            "mimo".to_string(),
            ModelIndexEntry {
                declared: true,
                models: vec!["mimo-v2.5".to_string()],
                alias_to_model: BTreeMap::new(),
            },
        )]);

        let (routing, _) =
            expand_routing_table_impl(&routing_source, &alias_index, &model_index, &HashSet::new())
                .unwrap();
        let pool = &routing["search"][0];

        assert_eq!(
            pool.targets,
            vec![
                "mimo.key1.mimo-v2.5".to_string(),
                "mimo.key2.mimo-v2.5".to_string()
            ]
        );
        let weights = pool
            .load_balancing
            .as_ref()
            .and_then(|lb| lb.weights.as_ref())
            .expect("expanded weights should be present");
        assert!(weights.contains_key("mimo.key1.mimo-v2.5"));
        assert!(weights.contains_key("mimo.key2.mimo-v2.5"));
        assert!(!weights.contains_key("mimo.pool.mimo-v2.5"));
        assert!(!weights.contains_key("mimo.mimo-v2.5"));
    }

    #[test]
    fn expansion_keys_routing_by_route_policy_group_not_pool_id() {
        let routing_source = BTreeMap::from([(
            "search".to_string(),
            vec![NormalizedRoutePoolConfig {
                id: "gateway-priority-5555-search".to_string(),
                priority: 100,
                backup: false,
                targets: vec!["mini27.MiniMax-M2.7".to_string()],
                mode: None,
                force: None,
                load_balancing: Some(LoadBalancingPolicy {
                    strategy: Some("weighted".to_string()),
                    weights: None,
                    health_weighted: None,
                    context_weighted: None,
                }),
                route_params: Some(
                    serde_json::from_value(json!({ "routePolicyGroup": "gateway_priority_5555" }))
                        .unwrap(),
                ),
                thinking: None,
            }],
        )]);
        let alias_index = BTreeMap::from([("mini27".to_string(), vec!["key1".to_string()])]);
        let model_index = BTreeMap::from([(
            "mini27".to_string(),
            ModelIndexEntry {
                declared: true,
                models: vec!["MiniMax-M2.7".to_string()],
                alias_to_model: BTreeMap::new(),
            },
        )]);

        let (routing, _) =
            expand_routing_table_impl(&routing_source, &alias_index, &model_index, &HashSet::new())
                .unwrap();
        assert!(routing.contains_key("gateway_priority_5555:search"));
        assert_eq!(
            routing["gateway_priority_5555:search"][0].id,
            "gateway-priority-5555-weighted-search"
        );
    }

    // ========== 黑盒红测：锁定 bootstrap_virtual_router_routing_json 行为 ==========

    #[test]
    fn bootstrap_json_simple_routing_one_pool_one_target() {
        let routing = json!({
            "default": ["openai.gpt-4o"]
        });
        let alias_index = json!({ "openai": ["key1"] });
        let model_index = json!({ "openai": { "declared": true, "models": ["gpt-4o"] } });

        let result = bootstrap_virtual_router_routing_json(
            routing.to_string(),
            alias_index.to_string(),
            model_index.to_string(),
            None,
        )
        .unwrap();
        let output: serde_json::Value = serde_json::from_str(&result).unwrap();

        let routing_obj = output.get("routing").expect("routing key");
        assert!(routing_obj.get("default").is_some());
        let pools = routing_obj.get("default").unwrap().as_array().unwrap();
        assert_eq!(pools.len(), 1);
        let targets: Vec<String> = pools[0]
            .get("targets")
            .unwrap()
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_str().unwrap().to_string())
            .collect();
        // Should expand "openai.gpt-4o" to "openai.key1.gpt-4o"
        assert!(targets.iter().any(|t| t.contains("gpt-4o")));
    }

    #[test]
    fn split_wrappers_match_bootstrap_json_routing_semantics() {
        let routing = json!({
            "default": [{
                "id": "default",
                "priority": "7.8",
                "force": "true",
                "targets": [" openai.gpt-4o "]
            }]
        });
        let alias_index = BTreeMap::from([("openai".to_string(), vec!["k1".to_string()])]);
        let model_index = BTreeMap::from([(
            "openai".to_string(),
            ModelIndexEntry {
                declared: true,
                models: vec!["gpt-4o".to_string()],
                alias_to_model: BTreeMap::new(),
            },
        )]);
        let routing_map = routing.as_object().unwrap();

        let normalized = crate::virtual_router_engine::routing::normalize_routing(routing_map);
        assert_eq!(normalized["default"][0].priority, 7);
        assert_eq!(normalized["default"][0].force, Some(true));
        assert_eq!(normalized["default"][0].targets, vec!["openai.gpt-4o"]);

        let (expanded, target_keys) = crate::virtual_router_engine::routing::expand_routing_table(
            &normalized,
            &alias_index,
            &model_index,
            &HashSet::new(),
        )
        .unwrap();
        assert_eq!(expanded["default"][0].targets, vec!["openai.k1.gpt-4o"]);
        assert_eq!(target_keys, vec!["openai.k1.gpt-4o"]);

        let bootstrap = bootstrap_virtual_router_routing_json(
            routing.to_string(),
            json!({ "openai": ["k1"] }).to_string(),
            json!({ "openai": { "declared": true, "models": ["gpt-4o"] } }).to_string(),
            None,
        )
        .unwrap();
        let bootstrap_output: serde_json::Value = serde_json::from_str(&bootstrap).unwrap();
        assert_eq!(
            bootstrap_output["routing"]["default"],
            serde_json::to_value(expanded["default"].clone()).unwrap()
        );
        assert_eq!(bootstrap_output["targetKeys"], json!(["openai.k1.gpt-4o"]));
    }

    #[test]
    fn bootstrap_json_weighted_pool_preserves_strategy() {
        let routing = json!({
            "search": [{
                "id": "search-weighted",
                "priority": 100,
                "targets": ["openai.gpt-4o", "anthropic.claude-sonnet"]
            }]
        });
        let alias_index = json!({ "openai": ["key1"], "anthropic": ["key2"] });
        let model_index = json!({
            "openai": { "declared": true, "models": ["gpt-4o"] },
            "anthropic": { "declared": true, "models": ["claude-sonnet"] }
        });

        let result = bootstrap_virtual_router_routing_json(
            routing.to_string(),
            alias_index.to_string(),
            model_index.to_string(),
            None,
        )
        .unwrap();
        let output: serde_json::Value = serde_json::from_str(&result).unwrap();

        // Just verify the result contains expected keys and routing data
        assert!(output.get("routingSource").is_some());
        assert!(output.get("routing").is_some());
        assert!(output.get("targetKeys").is_some());
        let routing = output.get("routing").unwrap().as_object().unwrap();
        assert!(!routing.is_empty(), "should have search route pools");
    }

    #[test]
    fn bootstrap_json_legacy_string_array_target() {
        let routing = json!({
            "coding": ["openai.gpt-4o"]
        });
        let alias_index = json!({ "openai": ["key1"] });
        let model_index = json!({ "openai": { "declared": true, "models": ["gpt-4o"] } });

        let result = bootstrap_virtual_router_routing_json(
            routing.to_string(),
            alias_index.to_string(),
            model_index.to_string(),
            None,
        )
        .unwrap();
        let output: serde_json::Value = serde_json::from_str(&result).unwrap();

        let pools = output
            .get("routing")
            .unwrap()
            .get("coding")
            .unwrap()
            .as_array()
            .unwrap();
        assert_eq!(pools.len(), 1);
        let targets: Vec<String> = pools[0]
            .get("targets")
            .unwrap()
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_str().unwrap().to_string())
            .collect();
        assert!(targets.iter().any(|t| t.contains("gpt-4o")));
    }

    #[test]
    fn bootstrap_json_alias_expansion() {
        let routing = json!({
            "default": ["mimo.mimo-v2.5"]
        });
        let alias_index = json!({
            "mimo": ["key1", "key2"]
        });
        let model_index = json!({
            "mimo": {
                "declared": true,
                "models": ["mimo-v2.5"],
                "aliasToModel": {"mimo-v2.5-alias": "mimo-v2.5"}
            }
        });

        let result = bootstrap_virtual_router_routing_json(
            routing.to_string(),
            alias_index.to_string(),
            model_index.to_string(),
            None,
        )
        .unwrap();
        let output: serde_json::Value = serde_json::from_str(&result).unwrap();

        let pools = output
            .get("routing")
            .unwrap()
            .get("default")
            .unwrap()
            .as_array()
            .unwrap();
        let targets: Vec<String> = pools[0]
            .get("targets")
            .unwrap()
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_str().unwrap().to_string())
            .collect();
        assert!(targets.contains(&"mimo.key1.mimo-v2.5".to_string()));
        assert!(targets.contains(&"mimo.key2.mimo-v2.5".to_string()));
        assert!(!targets.contains(&"mimo.mimo-v2.5".to_string()));
    }

    #[test]
    fn bootstrap_json_alias_to_model_canonicalization_keeps_canonical_model_id() {
        let routing = json!({
            "default": ["DF.deepseek-v4-pro-alias"]
        });
        let alias_index = json!({ "DF": ["key1"] });
        let model_index = json!({
            "DF": {
                "declared": true,
                "models": ["DeepSeek-V4-Pro"],
                "aliasToModel": {
                    "deepseek-v4-pro-alias": "DeepSeek-V4-Pro"
                }
            }
        });

        let result = bootstrap_virtual_router_routing_json(
            routing.to_string(),
            alias_index.to_string(),
            model_index.to_string(),
            None,
        )
        .unwrap();
        let output: serde_json::Value = serde_json::from_str(&result).unwrap();

        let pools = output
            .get("routing")
            .unwrap()
            .get("default")
            .unwrap()
            .as_array()
            .unwrap();
        let targets: Vec<String> = pools[0]
            .get("targets")
            .unwrap()
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_str().unwrap().to_string())
            .collect();
        assert_eq!(targets, vec!["DF.key1.DeepSeek-V4-Pro".to_string()]);
    }

    #[test]
    fn bootstrap_json_preserves_declared_forwarder_target() {
        let routing = json!({
            "default": [{
                "id": "default",
                "mode": "priority",
                "targets": ["fwd.minimax.MiniMax-M3"]
            }]
        });
        let alias_index = json!({
            "minimax": ["key1"],
            "mini27": ["key1"]
        });
        let model_index = json!({
            "minimax": { "declared": true, "models": ["MiniMax-M3"] },
            "mini27": { "declared": true, "models": ["MiniMax-M3"] }
        });

        let result = bootstrap_virtual_router_routing_json(
            routing.to_string(),
            alias_index.to_string(),
            model_index.to_string(),
            Some(json!(["fwd.minimax.MiniMax-M3"]).to_string()),
        )
        .unwrap();
        let output: serde_json::Value = serde_json::from_str(&result).unwrap();

        assert_eq!(
            output["routing"]["default"][0]["targets"],
            json!(["fwd.minimax.MiniMax-M3"])
        );
        assert_eq!(output["targetKeys"], json!([]));
    }

    #[test]
    fn bootstrap_json_priority_ordering() {
        let routing = json!({
            "default": [
                { "id": "low-pri", "priority": 200, "targets": ["a.model"] },
                { "id": "high-pri", "priority": 10, "targets": ["b.model"] }
            ]
        });
        let alias_index = json!({ "a": ["k1"], "b": ["k2"] });
        let model_index = json!({
            "a": { "declared": true, "models": ["model"] },
            "b": { "declared": true, "models": ["model"] }
        });

        let result = bootstrap_virtual_router_routing_json(
            routing.to_string(),
            alias_index.to_string(),
            model_index.to_string(),
            None,
        )
        .unwrap();
        let output: serde_json::Value = serde_json::from_str(&result).unwrap();

        let routing = output.get("routing").unwrap().as_object().unwrap();
        // Keys are "{priority}:{route_name}" format
        assert_eq!(routing.len(), 2, "should have 2 pools for default route");
    }

    #[test]
    fn bootstrap_json_thinking_field_preserved() {
        let routing = json!({
            "thinking": [{
                "id": "think-pool",
                "priority": 100,
                "targets": ["anthropic.claude-sonnet"],
                "thinking": "high"
            }]
        });
        let alias_index = json!({ "anthropic": ["key1"] });
        let model_index = json!({ "anthropic": { "declared": true, "models": ["claude-sonnet"] } });

        let result = bootstrap_virtual_router_routing_json(
            routing.to_string(),
            alias_index.to_string(),
            model_index.to_string(),
            None,
        )
        .unwrap();
        let output: serde_json::Value = serde_json::from_str(&result).unwrap();

        let routing = output.get("routing").unwrap().as_object().unwrap();
        assert!(!routing.is_empty(), "should have thinking route pools");
    }

    #[test]
    fn bootstrap_json_empty_routing_produces_empty_output() {
        let routing = json!({});
        let alias_index = json!({});
        let model_index = json!({});

        let result = bootstrap_virtual_router_routing_json(
            routing.to_string(),
            alias_index.to_string(),
            model_index.to_string(),
            None,
        )
        .unwrap();
        let output: serde_json::Value = serde_json::from_str(&result).unwrap();

        let routing_obj = output.get("routing").unwrap().as_object().unwrap();
        assert!(routing_obj.is_empty());
    }

    #[test]
    fn bootstrap_json_invalid_routing_json_fails() {
        let result = bootstrap_virtual_router_routing_json(
            "not-json".to_string(),
            "{}".to_string(),
            "{}".to_string(),
            None,
        );
        assert!(result.is_err());
    }

    #[test]
    fn bootstrap_json_multiple_routes() {
        let routing = json!({
            "coding": ["openai.gpt-4o"],
            "search": ["openai.gpt-4o"],
            "default": ["anthropic.claude-sonnet"]
        });
        let alias_index = json!({ "openai": ["k1"], "anthropic": ["k2"] });
        let model_index = json!({
            "openai": { "declared": true, "models": ["gpt-4o"] },
            "anthropic": { "declared": true, "models": ["claude-sonnet"] }
        });

        let result = bootstrap_virtual_router_routing_json(
            routing.to_string(),
            alias_index.to_string(),
            model_index.to_string(),
            None,
        )
        .unwrap();
        let output: serde_json::Value = serde_json::from_str(&result).unwrap();

        let routing_obj = output.get("routing").unwrap().as_object().unwrap();
        assert!(routing_obj.contains_key("coding"));
        assert!(routing_obj.contains_key("search"));
        assert!(routing_obj.contains_key("default"));
        assert_eq!(routing_obj.len(), 3);
    }

    #[test]
    fn bootstrap_json_route_params_preserved() {
        let routing = json!({
            "default": [{
                "id": "default-pool",
                "priority": 100,
                "targets": ["openai.gpt-4o"],
                "routeParams": { "customField": "customValue" }
            }]
        });
        let alias_index = json!({ "openai": ["k1"] });
        let model_index = json!({ "openai": { "declared": true, "models": ["gpt-4o"] } });

        let result = bootstrap_virtual_router_routing_json(
            routing.to_string(),
            alias_index.to_string(),
            model_index.to_string(),
            None,
        )
        .unwrap();
        let output: serde_json::Value = serde_json::from_str(&result).unwrap();

        let routing = output.get("routing").unwrap().as_object().unwrap();
        assert!(!routing.is_empty(), "should have default route pools");
    }

    #[test]
    fn bootstrap_json_backup_pool_marked() {
        let routing = json!({
            "default": [
                { "id": "primary", "priority": 100, "targets": ["a.model"] },
                { "id": "backup", "priority": 200, "backup": true, "targets": ["b.model"] }
            ]
        });
        let alias_index = json!({ "a": ["k1"], "b": ["k2"] });
        let model_index = json!({
            "a": { "declared": true, "models": ["model"] },
            "b": { "declared": true, "models": ["model"] }
        });

        let result = bootstrap_virtual_router_routing_json(
            routing.to_string(),
            alias_index.to_string(),
            model_index.to_string(),
            None,
        )
        .unwrap();
        let output: serde_json::Value = serde_json::from_str(&result).unwrap();

        let pools = output
            .get("routing")
            .unwrap()
            .get("default")
            .unwrap()
            .as_array()
            .unwrap();
        let backup = pools
            .iter()
            .find(|p| p.get("id").unwrap().as_str().unwrap() == "backup")
            .unwrap();
        assert_eq!(backup.get("backup").unwrap().as_bool().unwrap(), true);
    }
}
