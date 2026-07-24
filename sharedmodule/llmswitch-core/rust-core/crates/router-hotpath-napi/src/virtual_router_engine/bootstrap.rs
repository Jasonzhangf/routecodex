use napi::bindgen_prelude::Result as NapiResult;
use serde_json::{json, Map, Value};
use std::collections::HashSet;

use crate::virtual_router_engine::error::format_virtual_router_error;
use crate::virtual_router_engine::routing::{push_unique_trimmed, trim_nonempty_str};

pub(crate) fn bootstrap_virtual_router_config_json(input_json: String) -> NapiResult<String> {
    let input_value: Value = serde_json::from_str(&input_json)
        .map_err(|error| napi::Error::from_reason(error.to_string()))?;
    let section = extract_virtual_router_section(&input_value);
    let providers_source = section
        .get("providers")
        .cloned()
        .unwrap_or_else(|| Value::Object(Map::new()));
    if providers_source
        .as_object()
        .map(|providers| providers.is_empty())
        .unwrap_or(true)
    {
        return Err(napi::Error::from_reason(format_virtual_router_error(
            "CONFIG_ERROR",
            "Virtual Router requires at least one provider in configuration",
        )));
    }

    let providers_bootstrap = parse_object_payload(
        super::provider_bootstrap::bootstrap_virtual_router_providers_json(
            providers_source.to_string(),
        )?,
        "providers bootstrap",
    )?;
    let alias_index = require_field(&providers_bootstrap, "aliasIndex")?;
    let model_index = require_field(&providers_bootstrap, "modelIndex")?;
    let runtime_entries = require_field(&providers_bootstrap, "runtimeEntries")?;

    let forwarder_ids = section
        .get("forwarders")
        .and_then(Value::as_object)
        .map(|forwarders| {
            forwarders
                .keys()
                .filter_map(|key| {
                    let trimmed = key.trim();
                    if trimmed.is_empty() {
                        None
                    } else {
                        Some(Value::String(trimmed.to_string()))
                    }
                })
                .collect::<Vec<Value>>()
        })
        .unwrap_or_default();

    let routing_bootstrap = parse_object_payload(
        super::routing::bootstrap_virtual_router_routing_json(
            section
                .get("routing")
                .cloned()
                .unwrap_or_else(|| Value::Object(Map::new()))
                .to_string(),
            alias_index.to_string(),
            model_index.to_string(),
            Some(Value::Array(forwarder_ids).to_string()),
        )?,
        "routing bootstrap",
    )?;
    let routing_source = require_field(&routing_bootstrap, "routingSource")?;
    let routing = require_field(&routing_bootstrap, "routing")?;

    let routed_target_keys = collect_routed_target_keys(
        require_field(&routing_bootstrap, "targetKeys")?,
        section.get("forwarders"),
        &alias_index,
    );
    let provider_profiles = parse_object_payload(
        super::provider_bootstrap::bootstrap_virtual_router_provider_profiles_json(
            Value::Array(routed_target_keys.into_iter().map(Value::String).collect()).to_string(),
            alias_index.to_string(),
            model_index.to_string(),
            runtime_entries.to_string(),
        )?,
        "provider profiles bootstrap",
    )?;

    let config_meta = parse_object_payload(
        super::config_bootstrap::bootstrap_virtual_router_config_meta_json(
            Value::Object(section.clone()).to_string(),
            routing_source.to_string(),
        )?,
        "config meta bootstrap",
    )?;

    let profiles = require_field(&provider_profiles, "profiles")?;
    let target_runtime = require_field(&provider_profiles, "targetRuntime")?;
    let mut config = Map::new();
    config.insert("routing".to_string(), routing.clone());
    config.insert("providers".to_string(), profiles.clone());
    if let Some(routing_policy_group) = section
        .get("routingPolicyGroup")
        .or_else(|| section.get("routing_policy_group"))
        .and_then(Value::as_str)
        .and_then(trim_nonempty_str)
    {
        config.insert(
            "routingPolicyGroup".to_string(),
            Value::String(routing_policy_group),
        );
    }
    config.insert(
        "classifier".to_string(),
        require_field(&config_meta, "classifier")?,
    );
    config.insert(
        "loadBalancing".to_string(),
        config_meta
            .get("loadBalancing")
            .cloned()
            .unwrap_or_else(|| json!({ "strategy": "round-robin" })),
    );
    if let Some(health) = config_meta.get("health") {
        config.insert("health".to_string(), health.clone());
    }
    config.insert(
        "contextRouting".to_string(),
        require_field(&config_meta, "contextRouting")?,
    );
    for key in ["webSearch", "execCommandGuard", "applyPatch", "clock"] {
        if let Some(value) = config_meta.get(key) {
            config.insert(key.to_string(), value.clone());
        }
    }
    if section
        .get("forwarders")
        .and_then(Value::as_object)
        .map(|forwarders| !forwarders.is_empty())
        .unwrap_or(false)
    {
        config.insert(
            "forwarders".to_string(),
            section
                .get("forwarders")
                .cloned()
                .unwrap_or_else(|| Value::Object(Map::new())),
        );
    }

    serde_json::to_string(&json!({
        "config": Value::Object(config),
        "runtime": runtime_entries,
        "targetRuntime": target_runtime,
        "providers": profiles,
        "routing": routing,
    }))
    .map_err(|error| napi::Error::from_reason(error.to_string()))
}

fn extract_virtual_router_section(input: &Value) -> Map<String, Value> {
    let empty_root = Map::new();
    let root = input.as_object().unwrap_or(&empty_root);
    let section_source = root
        .get("virtualrouter")
        .and_then(Value::as_object)
        .unwrap_or(root);

    let mut section = Map::new();
    section.insert(
        "providers".to_string(),
        object_field(section_source, root, "providers")
            .unwrap_or_else(|| Value::Object(Map::new())),
    );
    section.insert(
        "routing".to_string(),
        object_field(section_source, root, "routing").unwrap_or_else(|| Value::Object(Map::new())),
    );
    if let Some(value) = object_field(section_source, root, "forwarders") {
        section.insert("forwarders".to_string(), value);
    }
    for key in [
        "routingPolicyGroup",
        "routing_policy_group",
        "classifier",
        "loadBalancing",
        "health",
        "contextRouting",
        "webSearch",
        "execCommandGuard",
        "clock",
    ] {
        if let Some(value) = section_source.get(key).or_else(|| root.get(key)) {
            section.insert(key.to_string(), value.clone());
        }
    }
    if let Some(value) = section_source
        .get("applyPatch")
        .or_else(|| section_source.get("apply_patch"))
        .or_else(|| {
            section_source
                .get("servertool")
                .and_then(Value::as_object)
                .and_then(|servertool| {
                    servertool
                        .get("applyPatch")
                        .or_else(|| servertool.get("apply_patch"))
                })
        })
        .or_else(|| root.get("applyPatch"))
        .or_else(|| root.get("apply_patch"))
    {
        section.insert("applyPatch".to_string(), value.clone());
    }
    section
}

fn object_field(
    section: &Map<String, Value>,
    root: &Map<String, Value>,
    key: &str,
) -> Option<Value> {
    section
        .get(key)
        .or_else(|| root.get(key))
        .and_then(Value::as_object)
        .map(|value| Value::Object(value.clone()))
}

fn parse_object_payload(raw: String, label: &str) -> NapiResult<Map<String, Value>> {
    let value: Value = serde_json::from_str(&raw).map_err(|error| {
        napi::Error::from_reason(format!("{} returned invalid JSON: {}", label, error))
    })?;
    value
        .as_object()
        .cloned()
        .ok_or_else(|| napi::Error::from_reason(format!("{} returned non-object payload", label)))
}

fn require_field(payload: &Map<String, Value>, key: &str) -> NapiResult<Value> {
    payload.get(key).cloned().ok_or_else(|| {
        napi::Error::from_reason(format!("virtual router bootstrap missing {}", key))
    })
}

fn collect_routed_target_keys(
    target_keys: Value,
    forwarders: Option<&Value>,
    alias_index: &Value,
) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    if let Some(targets) = target_keys.as_array() {
        for target in targets.iter().filter_map(Value::as_str) {
            push_unique_trimmed(&mut out, &mut seen, target);
        }
    }
    collect_forwarder_target_keys(forwarders, alias_index, &mut out, &mut seen);
    out
}

fn collect_forwarder_target_keys(
    forwarders: Option<&Value>,
    alias_index: &Value,
    out: &mut Vec<String>,
    seen: &mut HashSet<String>,
) {
    let Some(forwarder_map) = forwarders.and_then(Value::as_object) else {
        return;
    };
    for forwarder in forwarder_map.values().filter_map(Value::as_object) {
        let Some(model) = forwarder
            .get("modelId")
            .or_else(|| forwarder.get("model"))
            .and_then(Value::as_str)
            .and_then(trim_nonempty_str)
        else {
            continue;
        };
        let Some(targets) = forwarder.get("targets").and_then(Value::as_array) else {
            continue;
        };
        for target in targets.iter().filter_map(Value::as_object) {
            if let Some(provider_key) = target
                .get("providerKey")
                .and_then(Value::as_str)
                .and_then(trim_nonempty_str)
            {
                push_unique_trimmed(out, seen, &provider_key);
                continue;
            }
            let Some(provider_id) = target
                .get("providerId")
                .and_then(Value::as_str)
                .and_then(trim_nonempty_str)
            else {
                continue;
            };
            let Some(aliases) = alias_index.get(&provider_id).and_then(Value::as_array) else {
                continue;
            };
            for alias in aliases.iter().filter_map(Value::as_str) {
                push_unique_trimmed(out, seen, &format!("{}.{}.{}", provider_id, alias, model));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::bootstrap_virtual_router_config_json;
    use serde_json::{json, Value};

    #[test]
    fn bootstrap_virtual_router_config_json_returns_full_artifacts() {
        let input = json!({
            "virtualrouter": {
                "providers": {
                    "openai": {
                        "type": "openai",
                        "baseURL": "https://example.test/v1",
                        "auth": { "type": "apikey", "apiKey": "test-key" },
                        "models": { "gpt-4o": { "supportsStreaming": true } }
                    }
                },
                "routing": {
                    "default": ["openai.gpt-4o"]
                }
            }
        });

        let raw = bootstrap_virtual_router_config_json(input.to_string()).unwrap();
        let output: Value = serde_json::from_str(&raw).unwrap();
        assert!(output["config"]["providers"]["openai.key1.gpt-4o"].is_object());
        assert!(output["runtime"]["openai.key1"].is_object());
        assert!(output["targetRuntime"]["openai.key1.gpt-4o"].is_object());
        assert_eq!(
            output["config"]["routing"]["default"][0]["targets"][0],
            json!("openai.key1.gpt-4o")
        );
    }

    #[test]
    fn bootstrap_virtual_router_config_preserves_routing_policy_group() {
        let input = json!({
            "routingPolicyGroup": "gateway_priority_5555",
            "providers": {
                "primary": {
                    "type": "responses",
                    "baseURL": "https://primary.example.test/v1",
                    "auth": { "type": "apikey", "apiKey": "primary-key" },
                    "models": { "gpt-test": {} }
                }
            },
            "routing": {
                "default": ["primary.gpt-test"]
            }
        });

        let raw = bootstrap_virtual_router_config_json(input.to_string()).unwrap();
        let output: Value = serde_json::from_str(&raw).unwrap();

        assert_eq!(
            output["config"]["routingPolicyGroup"],
            json!("gateway_priority_5555")
        );
    }

    #[test]
    fn bootstrap_virtual_router_config_rejects_forwarder_provider_key_missing_profile() {
        let input = json!({
            "providers": {
                "asxs-cc": {
                    "type": "responses",
                    "baseURL": "https://api.asxs.example/v1",
                    "auth": { "type": "apikey", "entries": [{ "alias": "cc-oai", "apiKey": "${CC_OAI_KEY}" }] },
                    "models": { "gpt-5.6-terra": {} }
                }
            },
            "forwarders": {
                "fwd.paid.gpt-5.6-luna": {
                    "forwarderId": "fwd.paid.gpt-5.6-luna",
                    "protocol": "openai",
                    "modelId": "gpt-5.6-luna",
                    "resolutionMode": "model-first",
                    "strategy": "weighted",
                    "stickyKey": "session",
                    "targets": [{ "providerKey": "asxs-cc.cc-oai.gpt-5.6-luna", "disabled": false }]
                }
            },
            "routing": {
                "default": [{ "targets": ["fwd.paid.gpt-5.6-luna"] }]
            }
        });

        let error = bootstrap_virtual_router_config_json(input.to_string()).unwrap_err();
        let message = error.to_string();
        assert!(
            message.contains(
                "Routing target asxs-cc.cc-oai.gpt-5.6-luna references unknown model gpt-5.6-luna"
            ),
            "unexpected error: {}",
            message
        );
    }
}
