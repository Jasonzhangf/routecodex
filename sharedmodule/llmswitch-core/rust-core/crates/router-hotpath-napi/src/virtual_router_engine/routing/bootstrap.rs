use napi::bindgen_prelude::Result as NapiResult;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Number, Value};
use std::collections::{BTreeMap, HashMap, HashSet};

use crate::virtual_router_engine::error::format_virtual_router_error;
use crate::virtual_router_engine::load_balancer::LoadBalancingPolicy;

use super::config::RoutePoolTier;

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
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ModelIndexEntry {
    #[serde(default)]
    declared: bool,
    #[serde(default)]
    models: Vec<String>,
}

#[derive(Debug, Clone)]
struct ParsedRouteEntry {
    provider_id: String,
    key_alias: Option<String>,
    model_id: String,
    priority: i64,
}

#[derive(Debug, Clone)]
struct ExpandedTargetCandidate {
    key: String,
    priority: i64,
    order: usize,
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
) -> NapiResult<String> {
    let routing_source_map: Map<String, Value> = serde_json::from_str(&routing_json)
        .map_err(|error| napi::Error::from_reason(error.to_string()))?;
    let alias_index: BTreeMap<String, Vec<String>> = serde_json::from_str(&alias_index_json)
        .map_err(|error| napi::Error::from_reason(error.to_string()))?;
    let model_index: BTreeMap<String, ModelIndexEntry> = serde_json::from_str(&model_index_json)
        .map_err(|error| napi::Error::from_reason(error.to_string()))?;

    let normalized_routing = normalize_routing(&routing_source_map);
    let (expanded_routing, target_keys) =
        expand_routing_table(&normalized_routing, &alias_index, &model_index).map_err(|error| {
            napi::Error::from_reason(format_virtual_router_error("CONFIG_ERROR", error))
        })?;

    let output = RoutingBootstrapOutput {
        routing_source: normalized_routing,
        routing: expanded_routing,
        target_keys,
    };

    serde_json::to_string(&output).map_err(|error| napi::Error::from_reason(error.to_string()))
}

fn normalize_routing(
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

fn expand_routing_table(
    routing_source: &BTreeMap<String, Vec<NormalizedRoutePoolConfig>>,
    alias_index: &BTreeMap<String, Vec<String>>,
    model_index: &BTreeMap<String, ModelIndexEntry>,
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
                let Some(parsed) = parse_route_entry(entry, alias_index) else {
                    continue;
                };

                if !alias_index.contains_key(&parsed.provider_id) {
                    return Err(format!(
                        "Route \"{}\" references unknown provider \"{}\"",
                        route_name, parsed.provider_id
                    ));
                }

                if let Some(model_info) = model_index.get(&parsed.provider_id) {
                    if model_info.declared {
                        if parsed.model_id.trim().is_empty() {
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
                        if !model_info
                            .models
                            .iter()
                            .any(|candidate| candidate == &parsed.model_id)
                        {
                            return Err(format!(
                                "Route \"{}\" references unknown model \"{}\" for provider \"{}\"",
                                route_name, parsed.model_id, parsed.provider_id
                            ));
                        }
                    }
                }

                let aliases = if let Some(alias) = parsed.key_alias.clone() {
                    vec![alias]
                } else {
                    alias_index
                        .get(&parsed.provider_id)
                        .cloned()
                        .unwrap_or_default()
                };

                if aliases.is_empty() {
                    return Err(format!(
                        "Provider {} has no auth aliases but is referenced in routing",
                        parsed.provider_id
                    ));
                }

                for alias in aliases {
                    let runtime_key = build_runtime_key(&parsed.provider_id, &alias);
                    let target_key = format!("{}.{}", runtime_key, parsed.model_id);
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

            expanded_pools.push(RoutePoolTier {
                id: pool.id.clone(),
                priority: pool.priority,
                targets: sorted_targets,
                mode: pool.mode.clone(),
                backup: Some(pool.backup),
                force: pool.force,
                load_balancing: pool.load_balancing.clone(),
            });
        }
        routing.insert(route_name.clone(), expanded_pools);
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
            })
        };
    }

    let record = entry.as_object()?;
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
    })
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
        alias_selection: None,
    })
}

fn normalize_weighted_strategy(value: Option<&Value>) -> Option<String> {
    let normalized = value.and_then(Value::as_str)?.trim().to_ascii_lowercase();
    if normalized.is_empty() {
        return None;
    }
    match normalized.as_str() {
        "weighted" => Some("weighted".to_string()),
        "sticky" => Some("sticky".to_string()),
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

fn scalar_to_trimmed_string(value: &Value) -> Option<String> {
    match value {
        Value::String(raw) => {
            let trimmed = raw.trim();
            if trimmed.is_empty() {
                None
            } else {
                Some(trimmed.to_string())
            }
        }
        Value::Number(raw) => {
            let trimmed = raw.to_string();
            if trimmed.is_empty() {
                None
            } else {
                Some(trimmed)
            }
        }
        _ => None,
    }
}

fn normalize_priority_value(value: Option<&Value>, fallback: i64) -> i64 {
    match value {
        Some(Value::Number(number)) => normalize_json_number(number).unwrap_or(fallback),
        Some(Value::String(raw)) => raw
            .trim()
            .parse::<f64>()
            .ok()
            .map(|parsed| parsed as i64)
            .unwrap_or(fallback),
        _ => fallback,
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

fn build_runtime_key(provider_id: &str, key_alias: &str) -> String {
    format!("{}.{}", provider_id, key_alias)
}

fn read_optional_string(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.to_string())
}

fn parse_bool_like(value: &Value) -> Option<bool> {
    if let Some(boolean) = value.as_bool() {
        return Some(boolean);
    }
    value
        .as_str()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.eq_ignore_ascii_case("true"))
}

fn normalize_positive_i64(value: &Value) -> Option<i64> {
    let parsed = match value {
        Value::Number(number) => normalize_json_number(number),
        Value::String(raw) => raw.trim().parse::<f64>().ok().map(|parsed| parsed as i64),
        _ => None,
    }?;
    if parsed > 0 {
        Some(parsed)
    } else {
        None
    }
}

fn normalize_json_number(number: &Number) -> Option<i64> {
    if let Some(value) = number.as_i64() {
        return Some(value);
    }
    number.as_f64().and_then(|value| {
        if value.is_finite() {
            Some(value as i64)
        } else {
            None
        }
    })
}
