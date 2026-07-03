use napi::bindgen_prelude::Result as NapiResult;
use serde::Serialize;
use serde_json::{Map, Value};
use std::collections::BTreeMap;

use crate::shared_json_utils::read_trimmed_string;
use crate::virtual_router_engine::error::format_virtual_router_error;

const DEFAULT_LONG_CONTEXT_THRESHOLD_TOKENS: i64 = 180_000;
const DEFAULT_WARN_RATIO: f64 = 0.9;

fn default_thinking_keywords() -> Vec<String> {
    vec![
        "think step".to_string(),
        "analysis".to_string(),
        "reasoning".to_string(),
        "仔细分析".to_string(),
        "深度思考".to_string(),
    ]
}

fn default_coding_keywords() -> Vec<String> {
    vec![
        "apply_patch".to_string(),
        "write_file".to_string(),
        "create_file".to_string(),
        "shell".to_string(),
        "修改文件".to_string(),
        "写入文件".to_string(),
    ]
}

fn default_background_keywords() -> Vec<String> {
    vec![
        "background".to_string(),
        "context dump".to_string(),
        "上下文".to_string(),
    ]
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ClassifierConfigOutput {
    long_context_threshold_tokens: i64,
    thinking_keywords: Vec<String>,
    coding_keywords: Vec<String>,
    background_keywords: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct HealthWeightedConfigOutput {
    #[serde(skip_serializing_if = "Option::is_none")]
    enabled: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    recover_to_best_on_retry: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    base_weight: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    min_multiplier: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    beta: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    half_life_ms: Option<f64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ContextWeightedConfigOutput {
    #[serde(skip_serializing_if = "Option::is_none")]
    enabled: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    client_cap_tokens: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    gamma: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    max_multiplier: Option<f64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct LoadBalancingConfigOutput {
    strategy: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    weights: Option<BTreeMap<String, f64>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    health_weighted: Option<HealthWeightedConfigOutput>,
    #[serde(skip_serializing_if = "Option::is_none")]
    context_weighted: Option<ContextWeightedConfigOutput>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProviderHealthConfigOutput {
    failure_threshold: i64,
    cooldown_ms: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    fatal_cooldown_ms: Option<i64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ContextRoutingConfigOutput {
    warn_ratio: f64,
    hard_limit: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ExecCommandGuardConfigOutput {
    enabled: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    policy_file: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct WebSearchEngineOutput {
    id: String,
    provider_key: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    default: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    execution_mode: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    direct_activation: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    model_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    max_uses: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    server_tools_disabled: Option<bool>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct WebSearchConfigOutput {
    engines: Vec<WebSearchEngineOutput>,
    inject_policy: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    force: Option<bool>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ApplyPatchConfigOutput {
    mode: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ConfigBootstrapOutput {
    classifier: ClassifierConfigOutput,
    #[serde(skip_serializing_if = "Option::is_none")]
    load_balancing: Option<LoadBalancingConfigOutput>,
    #[serde(skip_serializing_if = "Option::is_none")]
    health: Option<ProviderHealthConfigOutput>,
    context_routing: ContextRoutingConfigOutput,
    #[serde(skip_serializing_if = "Option::is_none")]
    web_search: Option<WebSearchConfigOutput>,
    #[serde(skip_serializing_if = "Option::is_none")]
    exec_command_guard: Option<ExecCommandGuardConfigOutput>,
    #[serde(skip_serializing_if = "Option::is_none")]
    apply_patch: Option<ApplyPatchConfigOutput>,
}

pub(crate) fn bootstrap_virtual_router_config_meta_json(
    section_json: String,
    routing_source_json: String,
) -> NapiResult<String> {
    let section_value: Value = serde_json::from_str(&section_json)
        .map_err(|error| napi::Error::from_reason(error.to_string()))?;
    let section = section_value
        .as_object()
        .ok_or_else(|| napi::Error::from_reason("section must be object".to_string()))?;

    let routing_source_value: Value = serde_json::from_str(&routing_source_json)
        .map_err(|error| napi::Error::from_reason(error.to_string()))?;
    let routing_source = routing_source_value
        .as_object()
        .ok_or_else(|| napi::Error::from_reason("routingSource must be object".to_string()))?;

    let output = ConfigBootstrapOutput {
        classifier: normalize_classifier(section.get("classifier")),
        load_balancing: normalize_load_balancing(section.get("loadBalancing")),
        health: normalize_health(section.get("health")),
        context_routing: normalize_context_routing(section.get("contextRouting")),

        web_search: normalize_web_search(section.get("webSearch"), routing_source).map_err(
            |error| napi::Error::from_reason(format_virtual_router_error("CONFIG_ERROR", error)),
        )?,
        exec_command_guard: normalize_exec_command_guard(section.get("execCommandGuard")),
        apply_patch: normalize_apply_patch_config(resolve_apply_patch_config_node(section))
            .map_err(|error| {
                napi::Error::from_reason(format_virtual_router_error("CONFIG_ERROR", error))
            })?,
    };

    serde_json::to_string(&output).map_err(|error| napi::Error::from_reason(error.to_string()))
}

fn resolve_apply_patch_config_node<'a>(section: &'a Map<String, Value>) -> Option<&'a Value> {
    section
        .get("applyPatch")
        .or_else(|| section.get("apply_patch"))
        .or_else(|| {
            section
                .get("servertool")
                .and_then(|v| v.as_object())
                .and_then(|row| row.get("applyPatch").or_else(|| row.get("apply_patch")))
        })
}

fn normalize_apply_patch_config(
    value: Option<&Value>,
) -> Result<Option<ApplyPatchConfigOutput>, String> {
    let Some(raw) = value else {
        return Ok(Some(ApplyPatchConfigOutput {
            mode: "client".to_string(),
        }));
    };
    let Some(record) = raw.as_object() else {
        return Err("servertool.apply_patch/applyPatch must be object when configured".to_string());
    };
    let mode_raw = record
        .get("mode")
        .and_then(|v| v.as_str())
        .map(|v| v.trim().to_ascii_lowercase())
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| "client".to_string());
    match mode_raw.as_str() {
        "client" | "freeform" => Ok(Some(ApplyPatchConfigOutput {
            mode: "client".to_string(),
        })),
        other => Err(format!(
            "servertool.apply_patch.mode must be client/freeform, got {}",
            other
        )),
    }
}

fn normalize_classifier(value: Option<&Value>) -> ClassifierConfigOutput {
    let record = value.and_then(Value::as_object);
    ClassifierConfigOutput {
        long_context_threshold_tokens: record
            .and_then(|row| row.get("longContextThresholdTokens"))
            .and_then(normalize_finite_i64)
            .unwrap_or(DEFAULT_LONG_CONTEXT_THRESHOLD_TOKENS),
        thinking_keywords: normalize_string_array(
            record.and_then(|row| row.get("thinkingKeywords")),
            default_thinking_keywords(),
        ),
        coding_keywords: normalize_string_array(
            record.and_then(|row| row.get("codingKeywords")),
            default_coding_keywords(),
        ),
        background_keywords: normalize_string_array(
            record.and_then(|row| row.get("backgroundKeywords")),
            default_background_keywords(),
        ),
    }
}

fn normalize_load_balancing(value: Option<&Value>) -> Option<LoadBalancingConfigOutput> {
    let record = value.and_then(Value::as_object)?;
    let strategy_raw = record
        .get("strategy")
        .and_then(Value::as_str)
        .map(|v| v.trim().to_ascii_lowercase())
        .unwrap_or_default();

    let weights = normalize_weights(record.get("weights"));
    let health_weighted = normalize_health_weighted(record.get("healthWeighted"));
    let context_weighted = normalize_context_weighted(record.get("contextWeighted"));

    let has_non_strategy =
        weights.is_some() || health_weighted.is_some() || context_weighted.is_some();
    if strategy_raw.is_empty() && !has_non_strategy {
        return None;
    }

    let strategy = match strategy_raw.as_str() {
        "weighted" => strategy_raw,
        _ => "round-robin".to_string(),
    };

    Some(LoadBalancingConfigOutput {
        strategy,
        weights,
        health_weighted,
        context_weighted,
    })
}

fn normalize_weights(value: Option<&Value>) -> Option<BTreeMap<String, f64>> {
    let record = value.and_then(Value::as_object)?;
    let mut out = BTreeMap::new();
    for (key, value) in record {
        let Some(weight) = normalize_optional_f64(value) else {
            continue;
        };
        out.insert(key.clone(), weight);
    }
    if out.is_empty() {
        None
    } else {
        Some(out)
    }
}

fn normalize_health_weighted(value: Option<&Value>) -> Option<HealthWeightedConfigOutput> {
    let record = value.and_then(Value::as_object)?;
    let output = HealthWeightedConfigOutput {
        enabled: record.get("enabled").and_then(parse_bool_like),
        recover_to_best_on_retry: record.get("recoverToBestOnRetry").and_then(parse_bool_like),
        base_weight: record.get("baseWeight").and_then(normalize_optional_f64),
        min_multiplier: record.get("minMultiplier").and_then(normalize_optional_f64),
        beta: record.get("beta").and_then(normalize_optional_f64),
        half_life_ms: record.get("halfLifeMs").and_then(normalize_optional_f64),
    };
    if output.enabled.is_none()
        && output.recover_to_best_on_retry.is_none()
        && output.base_weight.is_none()
        && output.min_multiplier.is_none()
        && output.beta.is_none()
        && output.half_life_ms.is_none()
    {
        None
    } else {
        Some(output)
    }
}

fn normalize_context_weighted(value: Option<&Value>) -> Option<ContextWeightedConfigOutput> {
    let record = value.and_then(Value::as_object)?;
    let output = ContextWeightedConfigOutput {
        enabled: record.get("enabled").and_then(parse_bool_like),
        client_cap_tokens: record
            .get("clientCapTokens")
            .and_then(normalize_optional_f64),
        gamma: record.get("gamma").and_then(normalize_optional_f64),
        max_multiplier: record.get("maxMultiplier").and_then(normalize_optional_f64),
    };
    if output.enabled.is_none()
        && output.client_cap_tokens.is_none()
        && output.gamma.is_none()
        && output.max_multiplier.is_none()
    {
        None
    } else {
        Some(output)
    }
}

fn normalize_health(value: Option<&Value>) -> Option<ProviderHealthConfigOutput> {
    let record = value.and_then(Value::as_object)?;
    let failure_threshold = record
        .get("failureThreshold")
        .and_then(normalize_finite_i64)?;
    let cooldown_ms = record.get("cooldownMs").and_then(normalize_finite_i64)?;
    let fatal_cooldown_ms = record.get("fatalCooldownMs").and_then(normalize_finite_i64);
    Some(ProviderHealthConfigOutput {
        failure_threshold,
        cooldown_ms,
        fatal_cooldown_ms,
    })
}

fn normalize_context_routing(value: Option<&Value>) -> ContextRoutingConfigOutput {
    let record = value.and_then(Value::as_object);
    let warn_ratio = record
        .and_then(|row| {
            row.get("warnRatio")
                .and_then(normalize_optional_f64)
                .or_else(|| row.get("warn_ratio").and_then(normalize_optional_f64))
        })
        .map(clamp_warn_ratio)
        .unwrap_or(DEFAULT_WARN_RATIO);
    let hard_limit = record
        .and_then(|row| {
            row.get("hardLimit")
                .and_then(parse_bool_like)
                .or_else(|| row.get("hard_limit").and_then(parse_bool_like))
        })
        .unwrap_or(false);
    ContextRoutingConfigOutput {
        warn_ratio,
        hard_limit,
    }
}

fn normalize_exec_command_guard(value: Option<&Value>) -> Option<ExecCommandGuardConfigOutput> {
    let Some(record) = value.and_then(Value::as_object) else {
        return Some(ExecCommandGuardConfigOutput {
            enabled: true,
            policy_file: None,
        });
    };
    let enabled_raw = record.get("enabled");
    let enabled = !matches!(enabled_raw.and_then(parse_bool_like), Some(false))
        && !matches!(enabled_raw.and_then(normalize_optional_f64), Some(0.0));
    if !enabled {
        return None;
    }
    let policy_file = record
        .get("policyFile")
        .and_then(|value| read_trimmed_string(Some(value)))
        .or_else(|| {
            record
                .get("policy_file")
                .and_then(|value| read_trimmed_string(Some(value)))
        });
    Some(ExecCommandGuardConfigOutput {
        enabled: true,
        policy_file,
    })
}

fn normalize_web_search(
    value: Option<&Value>,
    routing_source: &Map<String, Value>,
) -> Result<Option<WebSearchConfigOutput>, String> {
    let Some(record) = value.and_then(Value::as_object) else {
        return Ok(None);
    };
    let engines_node = record.get("engines").and_then(Value::as_array);
    let web_search_route_targets = collect_web_search_route_targets(routing_source);
    let mut engines: Vec<WebSearchEngineOutput> = Vec::new();

    if let Some(entries) = engines_node {
        for raw in entries {
            let Some(node) = raw.as_object() else {
                continue;
            };
            let Some(id) = node
                .get("id")
                .and_then(|value| read_trimmed_string(Some(value)))
            else {
                continue;
            };
            let provider_key_raw = node
                .get("providerKey")
                .and_then(|value| read_trimmed_string(Some(value)))
                .or_else(|| {
                    node.get("provider")
                        .and_then(|value| read_trimmed_string(Some(value)))
                })
                .or_else(|| {
                    node.get("target")
                        .and_then(|value| read_trimmed_string(Some(value)))
                });
            let Some(provider_key) = provider_key_raw else {
                continue;
            };
            if engines.iter().any(|engine| engine.id == id) {
                continue;
            }
            let resolved_provider_key =
                resolve_web_search_engine_provider_key(&provider_key, &web_search_route_targets)
                    .unwrap_or(provider_key);
            let description = node
                .get("description")
                .and_then(|value| read_trimmed_string(Some(value)));
            let default = truthy_option(node.get("default"));
            let execution_mode = node
                .get("executionMode")
                .and_then(|value| read_trimmed_string(Some(value)))
                .or_else(|| {
                    node.get("mode")
                        .and_then(|value| read_trimmed_string(Some(value)))
                })
                .map(|value| value.to_ascii_lowercase())
                .map(|value| {
                    if value == "direct" {
                        "direct".to_string()
                    } else {
                        "servertool".to_string()
                    }
                })
                .unwrap_or_else(|| "servertool".to_string());
            let direct_activation = node
                .get("directActivation")
                .and_then(|value| read_trimmed_string(Some(value)))
                .or_else(|| {
                    node.get("activation")
                        .and_then(|value| read_trimmed_string(Some(value)))
                })
                .map(|value| value.to_ascii_lowercase())
                .and_then(|value| match value.as_str() {
                    "builtin" => Some("builtin".to_string()),
                    "route" => Some("route".to_string()),
                    _ => None,
                })
                .or_else(|| {
                    if execution_mode == "direct" {
                        Some("route".to_string())
                    } else {
                        None
                    }
                });
            let model_id = node
                .get("modelId")
                .and_then(|value| read_trimmed_string(Some(value)));
            let max_uses = node.get("maxUses").and_then(normalize_positive_floor_i64);
            let server_tools_disabled =
                truthy_option(node.get("serverToolsDisabled")).or_else(|| {
                    node.get("serverTools")
                        .and_then(Value::as_object)
                        .and_then(|server_tools| {
                            if matches!(
                                server_tools.get("enabled").and_then(parse_bool_like),
                                Some(false)
                            ) {
                                Some(true)
                            } else {
                                None
                            }
                        })
                });

            engines.push(WebSearchEngineOutput {
                id,
                provider_key: resolved_provider_key,
                description,
                default,
                execution_mode: Some(execution_mode),
                direct_activation,
                model_id,
                max_uses,
                server_tools_disabled,
            });
        }
    }

    if engines.is_empty() {
        return Ok(None);
    }

    let route_targets = collect_web_search_route_targets(routing_source);
    if route_targets.is_empty() {
        return Err(
            "Virtual Router webSearch.engines configured but routing.web_search route is missing or empty"
                .to_string(),
        );
    }
    for engine in &engines {
        if !route_targets
            .iter()
            .any(|target| target == &engine.provider_key)
        {
            return Err(format!(
                "Virtual Router webSearch engine \"{}\" references providerKey \"{}\" which is not present in routing.web_search/search",
                engine.id, engine.provider_key
            ));
        }
    }

    let inject_policy = record
        .get("injectPolicy")
        .and_then(|value| read_trimmed_string(Some(value)))
        .or_else(|| {
            record
                .get("inject_policy")
                .and_then(|value| read_trimmed_string(Some(value)))
        })
        .map(|value| value.to_ascii_lowercase())
        .filter(|value| value == "always" || value == "selective")
        .unwrap_or_else(|| "selective".to_string());

    let mut force = truthy_option(record.get("force"));
    if force != Some(true) {
        force = routing_source
            .get("web_search")
            .and_then(Value::as_array)
            .and_then(|pools| {
                if pools.iter().any(|pool| {
                    pool.as_object()
                        .and_then(|row| row.get("force"))
                        .and_then(parse_bool_like)
                        .unwrap_or(false)
                }) {
                    Some(true)
                } else {
                    None
                }
            });
    }

    Ok(Some(WebSearchConfigOutput {
        engines,
        inject_policy,
        force,
    }))
}

fn normalize_string_array(value: Option<&Value>, fallback: Vec<String>) -> Vec<String> {
    let Some(entries) = value.and_then(Value::as_array) else {
        return fallback;
    };
    let normalized = entries
        .iter()
        .filter_map(|value| read_trimmed_string(Some(value)))
        .collect::<Vec<String>>();
    if normalized.is_empty() {
        fallback
    } else {
        normalized
    }
}

fn truthy_option(value: Option<&Value>) -> Option<bool> {
    match value.and_then(parse_bool_like) {
        Some(true) => Some(true),
        _ => None,
    }
}

fn normalize_non_negative_i64(value: &Value) -> Option<i64> {
    normalize_finite_i64(value).filter(|v| *v >= 0)
}

fn normalize_positive_floor_i64(value: &Value) -> Option<i64> {
    normalize_f64(value)
        .filter(|v| v.is_finite() && *v > 0.0)
        .map(|v| v.floor() as i64)
}

fn normalize_finite_i64(value: &Value) -> Option<i64> {
    if let Some(int_value) = value.as_i64() {
        return Some(int_value);
    }
    if let Some(float_value) = value.as_f64() {
        if float_value.is_finite() {
            return Some(float_value as i64);
        }
    }
    None
}

fn normalize_optional_f64(value: &Value) -> Option<f64> {
    normalize_f64(value)
}

fn normalize_f64(value: &Value) -> Option<f64> {
    match value {
        Value::Number(number) => number.as_f64().filter(|v| v.is_finite()),
        Value::String(raw) => raw.trim().parse::<f64>().ok().filter(|v| v.is_finite()),
        _ => None,
    }
}

fn parse_bool_like(value: &Value) -> Option<bool> {
    match value {
        Value::Bool(bool_value) => Some(*bool_value),
        Value::Number(number) => number.as_f64().filter(|v| v.is_finite()).and_then(|v| {
            if (v - 1.0).abs() < f64::EPSILON {
                Some(true)
            } else if v.abs() < f64::EPSILON {
                Some(false)
            } else {
                None
            }
        }),
        Value::String(raw) => {
            let normalized = raw.trim().to_ascii_lowercase();
            match normalized.as_str() {
                "true" | "1" | "yes" | "y" | "on" => Some(true),
                "false" | "0" | "no" | "n" | "off" => Some(false),
                _ => None,
            }
        }
        _ => None,
    }
}

fn clamp_warn_ratio(value: f64) -> f64 {
    if !value.is_finite() {
        return DEFAULT_WARN_RATIO;
    }
    let clamped = value.max(0.1).min(0.99);
    if clamped.is_finite() {
        clamped
    } else {
        DEFAULT_WARN_RATIO
    }
}

fn collect_web_search_route_targets(routing_source: &Map<String, Value>) -> Vec<String> {
    let Some(route_pools) = routing_source.get("web_search").and_then(Value::as_array) else {
        return Vec::new();
    };
    let mut targets: Vec<String> = Vec::new();
    for pool in route_pools {
        let Some(pool_record) = pool.as_object() else {
            continue;
        };
        let Some(pool_targets) = pool_record.get("targets").and_then(Value::as_array) else {
            continue;
        };
        for target in pool_targets {
            let Some(normalized) = read_trimmed_string(Some(target)) else {
                continue;
            };
            if !targets.iter().any(|candidate| candidate == &normalized) {
                targets.push(normalized);
            }
        }
    }
    targets
}

fn resolve_web_search_engine_provider_key(
    provider_key: &str,
    route_targets: &[String],
) -> Option<String> {
    let input = provider_key.trim();
    if input.is_empty() {
        return None;
    }
    if route_targets.iter().any(|target| target == input) {
        return Some(input.to_string());
    }
    if let Some(target) = route_targets
        .iter()
        .find(|target| target.starts_with(&format!("{}.", input)))
    {
        return Some(target.clone());
    }
    let Some(first_dot) = input.find('.') else {
        return None;
    };
    if first_dot == 0 || first_dot >= input.len() - 1 {
        return None;
    }
    let provider_id = &input[..first_dot];
    let model_suffix = &input[first_dot + 1..];
    route_targets
        .iter()
        .find(|target| {
            target.starts_with(&format!("{}.", provider_id))
                && target.ends_with(&format!(".{}", model_suffix))
        })
        .cloned()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn normalize_exec_command_guard_defaults_to_enabled() {
        let output = normalize_exec_command_guard(None).expect("guard");
        assert!(output.enabled);
        assert!(output.policy_file.is_none());
    }

    #[test]
    fn normalize_web_search_resolves_provider_key_from_route_targets() {
        let section = json!({
            "webSearch": {
                "engines": [{
                    "id": "demo:web_search",
                    "providerKey": "demo"
                }]
            }
        });
        let routing_source = json!({
            "web_search": [{
                "targets": ["demo.key1.kimi-k2"]
            }]
        });
        let output = normalize_web_search(
            section.get("webSearch"),
            routing_source.as_object().expect("routing source"),
        )
        .expect("normalize")
        .expect("web search");
        assert_eq!(output.engines[0].provider_key, "demo.key1.kimi-k2");
    }
}
