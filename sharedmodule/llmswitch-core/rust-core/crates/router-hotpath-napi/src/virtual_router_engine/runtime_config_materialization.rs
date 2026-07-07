use napi::bindgen_prelude::Result as NapiResult;
use serde_json::{json, Map, Value};
use std::collections::{BTreeMap, BTreeSet};

use crate::virtual_router_engine::error::format_virtual_router_error;

pub(crate) fn compile_routecodex_runtime_manifest_json(input_json: String) -> NapiResult<String> {
    let input: Value = serde_json::from_str(&input_json)
        .map_err(|error| napi::Error::from_reason(error.to_string()))?;
    let manifest = compile_routecodex_runtime_manifest(&input).map_err(|error| {
        napi::Error::from_reason(format_virtual_router_error("CONFIG_ERROR", error))
    })?;
    serde_json::to_string(&manifest).map_err(|error| napi::Error::from_reason(error.to_string()))
}

pub(crate) fn collect_v2_config_source_errors_json(input_json: String) -> NapiResult<String> {
    let input: Value = serde_json::from_str(&input_json)
        .map_err(|error| napi::Error::from_reason(error.to_string()))?;
    let user_config = input.get("userConfig").unwrap_or(&input);
    let errors = collect_v2_config_source_errors(user_config);
    serde_json::to_string(&json!({ "errors": errors }))
        .map_err(|error| napi::Error::from_reason(error.to_string()))
}

pub(crate) fn normalize_routecodex_v2_runtime_source_json(
    input_json: String,
) -> NapiResult<String> {
    let input: Value = serde_json::from_str(&input_json)
        .map_err(|error| napi::Error::from_reason(error.to_string()))?;
    let user_config = input.get("userConfig").unwrap_or(&input);
    let normalized = normalize_v2_runtime_source(user_config);
    serde_json::to_string(&json!({ "userConfig": normalized }))
        .map_err(|error| napi::Error::from_reason(error.to_string()))
}

pub(crate) fn resolve_primary_routecodex_routing_policy_group_json(
    input_json: String,
) -> NapiResult<String> {
    let input: Value = serde_json::from_str(&input_json)
        .map_err(|error| napi::Error::from_reason(error.to_string()))?;
    let user_config = input.get("userConfig").unwrap_or(&input);
    let group = resolve_primary_routing_policy_group(user_config);
    serde_json::to_string(&json!({ "routingPolicyGroup": group }))
        .map_err(|error| napi::Error::from_reason(error.to_string()))
}

pub(crate) fn extract_routecodex_materialized_provider_configs_json(
    input_json: String,
) -> NapiResult<String> {
    let input: Value = serde_json::from_str(&input_json)
        .map_err(|error| napi::Error::from_reason(error.to_string()))?;
    let user_config = input.get("userConfig").unwrap_or(&input);
    let provider_configs = extract_materialized_provider_configs_from_user_config(user_config)
        .map_err(|error| {
            napi::Error::from_reason(format_virtual_router_error("CONFIG_ERROR", error))
        })?;
    serde_json::to_string(&json!({ "providerConfigs": provider_configs }))
        .map_err(|error| napi::Error::from_reason(error.to_string()))
}

pub(crate) fn materialize_routecodex_user_config_from_manifest_json(
    input_json: String,
) -> NapiResult<String> {
    let input: Value = serde_json::from_str(&input_json)
        .map_err(|error| napi::Error::from_reason(error.to_string()))?;
    let user_config = input
        .get("userConfig")
        .ok_or_else(|| napi::Error::from_reason("[config] materializer requires userConfig"))?;
    let manifest = input
        .get("manifest")
        .and_then(Value::as_object)
        .ok_or_else(|| {
            napi::Error::from_reason("[config] materializer requires manifest object")
        })?;
    let bootstrap_input = manifest
        .get("virtualRouterBootstrapInput")
        .and_then(Value::as_object)
        .ok_or_else(|| {
            napi::Error::from_reason(
                "[config] materializer requires manifest.virtualRouterBootstrapInput object",
            )
        })?;
    let materialized = materialize_user_config_from_manifest(user_config, bootstrap_input)
        .map_err(|error| {
            napi::Error::from_reason(format_virtual_router_error("CONFIG_ERROR", error))
        })?;
    serde_json::to_string(&json!({ "userConfig": materialized }))
        .map_err(|error| napi::Error::from_reason(error.to_string()))
}

// feature_id: config.provider_profile_materialization
pub(crate) fn build_routecodex_provider_profiles_json(input_json: String) -> NapiResult<String> {
    let input: Value = serde_json::from_str(&input_json)
        .map_err(|error| napi::Error::from_reason(error.to_string()))?;
    let user_config = input.get("userConfig").unwrap_or(&input);
    let profiles = build_provider_profiles(user_config).map_err(|error| {
        napi::Error::from_reason(format_virtual_router_error("CONFIG_ERROR", error))
    })?;
    serde_json::to_string(&json!({ "providerProfiles": profiles }))
        .map_err(|error| napi::Error::from_reason(error.to_string()))
}

// feature_id: config.forwarder_profile_materialization
pub(crate) fn build_routecodex_forwarder_profiles_json(input_json: String) -> NapiResult<String> {
    let input: Value = serde_json::from_str(&input_json)
        .map_err(|error| napi::Error::from_reason(error.to_string()))?;
    let user_config = input.get("userConfig").unwrap_or(&input);
    let known_provider_ids = input
        .get("knownProviderIds")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| pick_string(Some(item)))
                .collect::<BTreeSet<_>>()
        })
        .unwrap_or_default();
    let profiles = build_forwarder_profiles(user_config, &known_provider_ids).map_err(|error| {
        napi::Error::from_reason(format_virtual_router_error("CONFIG_ERROR", error))
    })?;
    serde_json::to_string(&json!({ "forwarderProfiles": profiles }))
        .map_err(|error| napi::Error::from_reason(error.to_string()))
}

fn compile_routecodex_runtime_manifest(input: &Value) -> Result<Value, String> {
    let user_config = input
        .get("userConfig")
        .and_then(Value::as_object)
        .ok_or_else(|| {
            "[config] runtime manifest compiler requires userConfig object".to_string()
        })?;
    let provider_configs = input
        .get("providerConfigs")
        .and_then(Value::as_object)
        .ok_or_else(|| {
            "[config] runtime manifest compiler requires providerConfigs object".to_string()
        })?;
    let options = input.get("options").and_then(Value::as_object);
    let requested_group = options
        .and_then(|node| pick_string(node.get("routingPolicyGroup")))
        .or_else(|| options.and_then(|node| pick_string(node.get("routing_policy_group"))));
    let include_all_routing_policy_groups = options
        .and_then(|node| node.get("includeAllRoutingPolicyGroups"))
        .or_else(|| options.and_then(|node| node.get("include_all_routing_policy_groups")))
        .and_then(Value::as_bool)
        == Some(true);

    let routing = extract_routing_from_user_config(
        user_config,
        requested_group.as_deref(),
        include_all_routing_policy_groups,
    )?;
    let mut referenced_provider_ids = resolve_referenced_provider_ids_from_routing(&routing);
    for provider_id in resolve_provider_ids_from_provider_ports(user_config) {
        referenced_provider_ids.insert(provider_id);
    }
    let referenced_forwarder_ids = resolve_referenced_forwarder_ids_from_routing(&routing);
    let forwarders_source = extract_forwarders_from_user_config(user_config);
    if let Some(source) = &forwarders_source {
        for forwarder_id in source.keys() {
            if !forwarder_id.starts_with("fwd.") {
                return Err(format!(
                    "[forwarder-config] forwarder id '{}' must start with 'fwd.'",
                    forwarder_id
                ));
            }
        }
        for ref_id in &referenced_forwarder_ids {
            if !source.contains_key(ref_id) {
                return Err(format!(
                    "[forwarder-config] routing references unknown forwarder '{}'",
                    ref_id
                ));
            }
        }
    }

    let provider_config_map = normalize_provider_configs(provider_configs)?;
    let forwarders = match forwarders_source {
        Some(source) if !source.is_empty() => Some(normalize_forwarders_for_native(
            &source,
            &provider_config_map,
        )?),
        _ => None,
    };
    if let Some(forwarders_map) = &forwarders {
        for forwarder in forwarders_map.values() {
            let targets = forwarder
                .get("targets")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            for target in targets {
                if let Some(provider_id) = target
                    .as_object()
                    .and_then(|node| pick_string(node.get("providerId")))
                    .or_else(|| {
                        target
                            .as_object()
                            .and_then(|node| pick_string(node.get("providerKey")))
                            .and_then(|key| parse_provider_id_from_provider_key(&key))
                    })
                {
                    referenced_provider_ids.insert(provider_id);
                }
            }
        }
    }

    let mut providers = Map::new();
    for (provider_id, provider_config) in &provider_config_map {
        if !referenced_provider_ids.is_empty() && !referenced_provider_ids.contains(provider_id) {
            continue;
        }
        providers.insert(provider_id.clone(), provider_config.provider.clone());
    }

    let apply_patch = extract_apply_patch_config_from_user_config(user_config);
    let hit_log = extract_policy_group_option_from_user_config(
        user_config,
        "hitLog",
        requested_group.as_deref(),
    );
    let mut bootstrap_input = Map::new();
    bootstrap_input.insert("providers".to_string(), Value::Object(providers));
    bootstrap_input.insert("routing".to_string(), Value::Object(routing));
    if let Some(group) = requested_group {
        bootstrap_input.insert("routingPolicyGroup".to_string(), Value::String(group));
    }
    if let Some(forwarders_map) = forwarders {
        bootstrap_input.insert("forwarders".to_string(), Value::Object(forwarders_map));
    }
    if let Some(apply_patch_config) = &apply_patch {
        bootstrap_input.insert("applyPatch".to_string(), apply_patch_config.clone());
    }
    if let Some(hit_log_config) = &hit_log {
        bootstrap_input.insert("hitLog".to_string(), hit_log_config.clone());
    }

    let mut pipeline_runtime_config = Map::new();
    if let Some(apply_patch_config) = apply_patch {
        pipeline_runtime_config.insert("applyPatch".to_string(), apply_patch_config);
    }
    if let Some(hit_log_config) = hit_log {
        pipeline_runtime_config.insert("hitLog".to_string(), hit_log_config);
    }

    let provider_ids = bootstrap_input
        .get("providers")
        .and_then(Value::as_object)
        .map(|node| node.keys().cloned().map(Value::String).collect::<Vec<_>>())
        .unwrap_or_default();
    let forwarder_ids = bootstrap_input
        .get("forwarders")
        .and_then(Value::as_object)
        .map(|node| node.keys().cloned().map(Value::String).collect::<Vec<_>>())
        .unwrap_or_default();

    Ok(json!({
        "manifestVersion": "routecodex.runtime-config.v1",
        "routingPolicyGroup": bootstrap_input.get("routingPolicyGroup").cloned().unwrap_or(Value::Null),
        "virtualRouterBootstrapInput": Value::Object(bootstrap_input),
        "pipelineRuntimeConfig": Value::Object(pipeline_runtime_config),
        "providerIds": provider_ids,
        "forwarderIds": forwarder_ids
    }))
}

fn extract_materialized_provider_configs_from_user_config(
    user_config: &Value,
) -> Result<Value, String> {
    let providers_node = user_config
        .as_object()
        .and_then(|root| root.get("virtualrouter"))
        .and_then(Value::as_object)
        .and_then(|vr| vr.get("providers"))
        .and_then(Value::as_object);
    let Some(providers_node) = providers_node else {
        return Ok(Value::Null);
    };
    if providers_node.is_empty() {
        return Ok(Value::Null);
    }

    let mut provider_configs = Map::new();
    for (provider_id_raw, provider_value) in providers_node {
        let provider_id = provider_id_raw.trim();
        if provider_id.is_empty() {
            return Err(
                "[config] materialized virtualrouter.providers contains empty provider id"
                    .to_string(),
            );
        }
        let Some(provider_record) = provider_value.as_object() else {
            return Err(format!(
                "[config] materialized virtualrouter.providers[\"{}\"] must be an object",
                provider_id
            ));
        };
        let mut provider = provider_record.clone();
        let provider_node_id = pick_string(provider.get("id"));
        if let Some(provider_node_id) = provider_node_id.as_deref() {
            if provider_node_id != provider_id {
                return Err(format!(
                    "[config] materialized virtualrouter.providers[\"{}\"].id=\"{}\" does not match provider id",
                    provider_id, provider_node_id
                ));
            }
        } else {
            provider.insert("id".to_string(), Value::String(provider_id.to_string()));
        }
        provider_configs.insert(
            provider_id.to_string(),
            json!({
                "version": "2.0.0",
                "providerId": provider_id,
                "provider": Value::Object(provider),
            }),
        );
    }
    Ok(Value::Object(provider_configs))
}

fn materialize_user_config_from_manifest(
    user_config: &Value,
    bootstrap_input: &Map<String, Value>,
) -> Result<Value, String> {
    let Some(root) = user_config.as_object() else {
        return Err("[config] materializer requires userConfig object".to_string());
    };
    let providers = bootstrap_input
        .get("providers")
        .ok_or_else(|| {
            "[config] materializer requires virtualRouterBootstrapInput.providers".to_string()
        })?
        .clone();
    let routing = bootstrap_input
        .get("routing")
        .ok_or_else(|| {
            "[config] materializer requires virtualRouterBootstrapInput.routing".to_string()
        })?
        .clone();

    let mut materialized = root.clone();
    let mut virtualrouter = materialized
        .get("virtualrouter")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    virtualrouter.insert("providers".to_string(), providers);
    virtualrouter.insert("routing".to_string(), routing);
    if let Some(forwarders) = bootstrap_input
        .get("forwarders")
        .filter(|value| !value.is_null())
    {
        virtualrouter.insert("forwarders".to_string(), forwarders.clone());
    }
    if let Some(apply_patch) = bootstrap_input
        .get("applyPatch")
        .filter(|value| !value.is_null())
    {
        virtualrouter.insert("applyPatch".to_string(), apply_patch.clone());
    }
    materialized.insert("virtualrouter".to_string(), Value::Object(virtualrouter));
    Ok(Value::Object(materialized))
}

fn build_provider_profiles(user_config: &Value) -> Result<Value, String> {
    let providers = collect_provider_nodes_for_profiles(user_config);
    let mut profiles = Vec::new();
    let mut by_id = Map::new();
    for (provider_id, raw) in providers {
        let profile = build_provider_profile(&provider_id, &raw)?;
        by_id.insert(provider_id, profile.clone());
        profiles.push(profile);
    }
    Ok(json!({
        "profiles": profiles,
        "byId": Value::Object(by_id)
    }))
}

fn build_forwarder_profiles(
    user_config: &Value,
    known_provider_ids: &BTreeSet<String>,
) -> Result<Value, String> {
    let forwarders = collect_forwarder_nodes_for_profiles(user_config);
    let mut profiles = Vec::new();
    let mut by_id = Map::new();
    for (forwarder_id, raw) in forwarders {
        let profile = build_forwarder_profile(&forwarder_id, &raw, known_provider_ids)?;
        by_id.insert(forwarder_id, profile.clone());
        profiles.push(profile);
    }
    Ok(json!({
        "profiles": profiles,
        "byId": Value::Object(by_id)
    }))
}

fn collect_forwarder_nodes_for_profiles(
    user_config: &Value,
) -> BTreeMap<String, Map<String, Value>> {
    let mut entries = BTreeMap::new();
    merge_forwarder_nodes_for_profiles(
        &mut entries,
        user_config
            .as_object()
            .and_then(|root| root.get("forwarders"))
            .and_then(Value::as_object),
    );
    merge_forwarder_nodes_for_profiles(
        &mut entries,
        user_config
            .as_object()
            .and_then(|root| root.get("virtualrouter"))
            .and_then(Value::as_object)
            .and_then(|vr| vr.get("forwarders"))
            .and_then(Value::as_object),
    );
    entries
}

fn merge_forwarder_nodes_for_profiles(
    entries: &mut BTreeMap<String, Map<String, Value>>,
    forwarders: Option<&Map<String, Value>>,
) {
    let Some(forwarders) = forwarders else {
        return;
    };
    for (forwarder_id, raw) in forwarders {
        if let Some(raw_record) = raw.as_object() {
            entries.insert(forwarder_id.to_string(), raw_record.clone());
        }
    }
}

fn build_forwarder_profile(
    forwarder_id: &str,
    raw: &Map<String, Value>,
    known_provider_ids: &BTreeSet<String>,
) -> Result<Value, String> {
    validate_forwarder_profile_id(forwarder_id)?;
    if raw.contains_key("transportOverride") {
        return Err(format!(
            "[forwarder-profiles] forwarder '{}' transportOverride is not supported (forwarder is a pure index, no field merge)",
            forwarder_id
        ));
    }
    let protocol = pick_string(raw.get("protocol")).ok_or_else(|| {
        format!(
            "[forwarder-profiles] forwarder '{}' missing protocol",
            forwarder_id
        )
    })?;
    if !matches!(
        protocol.as_str(),
        "openai" | "responses" | "anthropic" | "gemini"
    ) {
        return Err(format!(
            "[forwarder-profiles] forwarder '{}' has unsupported protocol '{}'",
            forwarder_id, protocol
        ));
    }
    let model = pick_string(raw.get("model"))
        .or_else(|| pick_string(raw.get("modelId")))
        .ok_or_else(|| {
            format!(
                "[forwarder-profiles] forwarder '{}' missing model",
                forwarder_id
            )
        })?;
    let resolution_mode =
        pick_string(raw.get("resolutionMode")).unwrap_or_else(|| "model-first".to_string());
    if !matches!(resolution_mode.as_str(), "model-first" | "provider-first") {
        return Err(format!(
            "[forwarder-profiles] forwarder '{}' has invalid resolutionMode",
            forwarder_id
        ));
    }
    let strategy = pick_string(raw.get("strategy")).unwrap_or_else(|| "round-robin".to_string());
    if !matches!(strategy.as_str(), "round-robin" | "priority" | "weighted") {
        return Err(format!(
            "[forwarder-profiles] forwarder '{}' has invalid strategy",
            forwarder_id
        ));
    }
    let sticky_key = pick_string(raw.get("stickyKey")).unwrap_or_else(|| "none".to_string());
    if !matches!(sticky_key.as_str(), "session" | "request" | "none") {
        return Err(format!(
            "[forwarder-profiles] forwarder '{}' has invalid stickyKey",
            forwarder_id
        ));
    }
    let targets =
        parse_forwarder_profile_targets(raw.get("targets"), forwarder_id, known_provider_ids)?;
    if targets.is_empty() {
        return Err(format!(
            "[forwarder-profiles] forwarder '{}' has no enabled targets",
            forwarder_id
        ));
    }
    let mut profile = Map::new();
    profile.insert("id".to_string(), Value::String(forwarder_id.to_string()));
    profile.insert("protocol".to_string(), Value::String(protocol));
    profile.insert("model".to_string(), Value::String(model));
    profile.insert("resolutionMode".to_string(), Value::String(resolution_mode));
    profile.insert("strategy".to_string(), Value::String(strategy));
    profile.insert("stickyKey".to_string(), Value::String(sticky_key));
    profile.insert("targets".to_string(), Value::Array(targets));
    if let Some(weights) = parse_forwarder_profile_weights(raw.get("weights")) {
        profile.insert("weights".to_string(), weights);
    }
    Ok(Value::Object(profile))
}

fn validate_forwarder_profile_id(forwarder_id: &str) -> Result<(), String> {
    if !forwarder_id.starts_with("fwd.") {
        return Err(format!(
            "[forwarder-profiles] forwarder id '{}' must start with 'fwd.'",
            forwarder_id
        ));
    }
    if forwarder_id.len() <= "fwd.".len() {
        return Err(format!(
            "[forwarder-profiles] forwarder id '{}' is empty after prefix",
            forwarder_id
        ));
    }
    Ok(())
}

fn parse_forwarder_profile_targets(
    raw: Option<&Value>,
    forwarder_id: &str,
    known_provider_ids: &BTreeSet<String>,
) -> Result<Vec<Value>, String> {
    let Some(targets) = raw.and_then(Value::as_array) else {
        return Err(format!(
            "[forwarder-profiles] forwarder '{}' targets must be an array",
            forwarder_id
        ));
    };
    let mut out = Vec::new();
    for target in targets {
        let Some(target_record) = target.as_object() else {
            return Err(format!(
                "[forwarder-profiles] forwarder '{}' has invalid target entry",
                forwarder_id
            ));
        };
        let provider_id = pick_string(target_record.get("providerId"))
            .or_else(|| pick_string(target_record.get("providerKey")))
            .ok_or_else(|| {
                format!(
                    "[forwarder-profiles] forwarder '{}' target missing providerId",
                    forwarder_id
                )
            })?;
        if !known_provider_ids.contains(&provider_id) {
            return Err(format!(
                "[forwarder-profiles] forwarder '{}' references unknown providerId '{}'",
                forwarder_id, provider_id
            ));
        }
        let mut normalized = Map::new();
        normalized.insert("providerId".to_string(), Value::String(provider_id));
        if let Some(weight) = pick_positive_i64(target_record.get("weight")) {
            normalized.insert("weight".to_string(), Value::Number(weight.into()));
        }
        if let Some(priority) = pick_number(target_record.get("priority")) {
            if let Some(number) = serde_json::Number::from_f64(priority) {
                normalized.insert("priority".to_string(), Value::Number(number));
            }
        }
        if target_record.get("disabled").and_then(Value::as_bool) == Some(true) {
            normalized.insert("disabled".to_string(), Value::Bool(true));
        }
        out.push(Value::Object(normalized));
    }
    Ok(out)
}

fn parse_forwarder_profile_weights(raw: Option<&Value>) -> Option<Value> {
    let node = raw.and_then(Value::as_object)?;
    let mut out = Map::new();
    for (key, value) in node {
        let Some(number) = pick_number(Some(value)).filter(|value| *value > 0.0) else {
            continue;
        };
        if let Some(number) = serde_json::Number::from_f64(number) {
            out.insert(key.to_string(), Value::Number(number));
        }
    }
    (!out.is_empty()).then(|| Value::Object(out))
}

fn collect_provider_nodes_for_profiles(
    user_config: &Value,
) -> BTreeMap<String, Map<String, Value>> {
    let mut entries = BTreeMap::new();
    merge_provider_nodes_for_profiles(
        &mut entries,
        user_config
            .as_object()
            .and_then(|root| root.get("providers"))
            .and_then(Value::as_object),
    );
    merge_provider_nodes_for_profiles(
        &mut entries,
        user_config
            .as_object()
            .and_then(|root| root.get("virtualrouter"))
            .and_then(Value::as_object)
            .and_then(|vr| vr.get("providers"))
            .and_then(Value::as_object),
    );
    entries
}

fn merge_provider_nodes_for_profiles(
    entries: &mut BTreeMap<String, Map<String, Value>>,
    providers: Option<&Map<String, Value>>,
) {
    let Some(providers) = providers else {
        return;
    };
    for (provider_id, raw) in providers {
        if let Some(raw_record) = raw.as_object() {
            entries.insert(provider_id.to_string(), raw_record.clone());
        }
    }
}

fn build_provider_profile(provider_id: &str, raw: &Map<String, Value>) -> Result<Value, String> {
    let protocol_type_hint = pick_string(raw.get("type"))
        .or_else(|| pick_string(raw.get("providerType")))
        .or_else(|| pick_string(raw.get("protocol")))
        .or_else(|| pick_string(raw.get("module")));
    let module_type = pick_string(
        raw.get("providerModule")
            .or_else(|| raw.get("provider_module")),
    )
    .or_else(|| pick_string(raw.get("module")))
    .or_else(|| pick_string(raw.get("type")))
    .map(|value| value.trim().to_string());
    let protocol =
        resolve_provider_profile_protocol(provider_id, raw, protocol_type_hint.as_deref())?;
    let transport = extract_provider_profile_transport(raw);
    let auth = extract_provider_profile_auth(raw)?;
    let compatibility_profile = extract_provider_compat_profile(provider_id, raw)?;
    let metadata = extract_provider_profile_metadata(raw);

    let mut profile = Map::new();
    profile.insert("id".to_string(), Value::String(provider_id.to_string()));
    profile.insert("protocol".to_string(), Value::String(protocol));
    if let Some(module_type) = module_type.filter(|value| !value.is_empty()) {
        profile.insert("moduleType".to_string(), Value::String(module_type));
    }
    profile.insert("transport".to_string(), transport);
    profile.insert("auth".to_string(), auth);
    if let Some(compatibility_profile) = compatibility_profile {
        profile.insert(
            "compatibilityProfile".to_string(),
            Value::String(compatibility_profile),
        );
    }
    if let Some(metadata) = metadata {
        profile.insert("metadata".to_string(), metadata);
    }
    Ok(Value::Object(profile))
}

fn resolve_provider_profile_protocol(
    provider_id: &str,
    raw: &Map<String, Value>,
    module_type: Option<&str>,
) -> Result<String, String> {
    let raw_type = pick_string(raw.get("providerType"))
        .or_else(|| pick_string(raw.get("protocol")))
        .or_else(|| module_type.and_then(sanitize_provider_profile_type))
        .or_else(|| {
            pick_string(raw.get("module")).and_then(|value| sanitize_provider_profile_type(&value))
        });
    let Some(raw_type) = raw_type else {
        return Ok("openai".to_string());
    };
    let normalized = raw_type.trim();
    if matches!(
        normalized,
        "openai" | "glm" | "lmstudio" | "chat" | "openai-http" | "openai-standard" | "mock"
    ) {
        return Ok("openai".to_string());
    }
    if matches!(
        normalized,
        "responses" | "openai-responses" | "responses-http"
    ) {
        return Ok("responses".to_string());
    }
    if matches!(
        normalized,
        "anthropic" | "anthropic-http" | "claude" | "mimoweb" | "mimoweb-http"
    ) {
        return Ok("anthropic".to_string());
    }
    if matches!(
        normalized,
        "gemini" | "gemini2" | "gemini-chat" | "gemini-http"
    ) {
        return Ok("gemini".to_string());
    }
    Err(format!(
        "[provider-profiles] Provider \"{}\" has unsupported type \"{}\".",
        provider_id, raw_type
    ))
}

fn sanitize_provider_profile_type(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return None;
    }
    let lowered = trimmed.to_ascii_lowercase();
    Some(
        lowered
            .strip_suffix("-provider")
            .unwrap_or(&lowered)
            .to_string(),
    )
}

fn extract_provider_profile_transport(raw: &Map<String, Value>) -> Value {
    let transport_node = raw.get("transport").and_then(Value::as_object);
    let backend_raw = pick_string(raw.get("transportBackend"))
        .or_else(|| transport_node.and_then(|node| pick_string(node.get("backend"))));
    let backend = backend_raw.and_then(|value| match value.trim().to_ascii_lowercase().as_str() {
        "vercel-ai-sdk" => Some("vercel-ai-sdk".to_string()),
        "openai-sdk" => Some("openai-sdk".to_string()),
        "native-http" => Some("native-http".to_string()),
        _ => None,
    });
    let mut transport = Map::new();
    if let Some(base_url) = pick_string(raw.get("baseURL"))
        .or_else(|| pick_string(raw.get("baseUrl")))
        .or_else(|| pick_string(raw.get("base_url")))
    {
        transport.insert("baseUrl".to_string(), Value::String(base_url));
    }
    if let Some(endpoint) = pick_string(raw.get("endpoint")) {
        transport.insert("endpoint".to_string(), Value::String(endpoint));
    }
    if let Some(timeout_ms) = pick_number(raw.get("timeout").or_else(|| raw.get("timeoutMs"))) {
        if let Some(number) = serde_json::Number::from_f64(timeout_ms) {
            transport.insert("timeoutMs".to_string(), Value::Number(number));
        }
    }
    if let Some(max_retries) = pick_number(
        raw.get("retryAttempts")
            .or_else(|| raw.get("retry_attempts")),
    ) {
        if let Some(number) = serde_json::Number::from_f64(max_retries) {
            transport.insert("maxRetries".to_string(), Value::Number(number));
        }
    }
    if let Some(headers) =
        extract_provider_profile_headers(raw.get("headers").or_else(|| raw.get("defaultHeaders")))
    {
        transport.insert("headers".to_string(), headers);
    }
    if let Some(backend) = backend {
        transport.insert("backend".to_string(), Value::String(backend));
    }
    Value::Object(transport)
}

fn extract_provider_profile_headers(value: Option<&Value>) -> Option<Value> {
    let node = value.and_then(Value::as_object)?;
    let mut headers = Map::new();
    for (key, raw) in node {
        if let Some(value) = pick_string(Some(raw)) {
            headers.insert(key.to_string(), Value::String(value));
        }
    }
    (!headers.is_empty()).then(|| Value::Object(headers))
}

fn extract_provider_profile_auth(raw: &Map<String, Value>) -> Result<Value, String> {
    let auth_node = raw.get("auth").and_then(Value::as_object);
    let oauth_node = raw.get("oauth").and_then(Value::as_object).or_else(|| {
        auth_node
            .and_then(|node| node.get("oauth"))
            .and_then(Value::as_object)
    });
    let type_hint = auth_node
        .and_then(|node| pick_string(node.get("type")))
        .or_else(|| pick_string(raw.get("authType")));
    let api_key = auth_node
        .and_then(|node| pick_string(node.get("apiKey")))
        .or_else(|| pick_string(raw.get("apiKey")));
    let secret_ref = auth_node
        .and_then(|node| pick_string(node.get("secretRef")))
        .or_else(|| pick_string(raw.get("secretRef")));
    let env_ref = auth_node
        .and_then(|node| pick_string(node.get("env")))
        .or_else(|| pick_string(raw.get("apiKeyEnv")))
        .or_else(|| pick_string(raw.get("env")));
    let normalized_type = normalize_provider_auth_type(
        type_hint.as_deref(),
        oauth_node.is_some(),
        api_key.as_deref(),
        secret_ref.as_deref(),
        env_ref.as_deref(),
    )?;
    if normalized_type != "apikey" {
        return Ok(json!({ "kind": "none" }));
    }
    let mut auth = Map::new();
    auth.insert("kind".to_string(), Value::String("apikey".to_string()));
    if let Some(entries) = auth_node.and_then(extract_api_key_entries_array) {
        auth.insert("entries".to_string(), entries);
    }
    insert_optional_string(&mut auth, "apiKey", api_key);
    insert_optional_string(&mut auth, "secretRef", secret_ref);
    insert_optional_string(&mut auth, "env", env_ref);
    insert_optional_string(&mut auth, "rawType", type_hint);
    insert_optional_string(
        &mut auth,
        "mobile",
        auth_node
            .and_then(|node| {
                pick_string(node.get("mobile"))
                    .or_else(|| pick_string(node.get("account")))
                    .or_else(|| pick_string(node.get("username")))
            })
            .or_else(|| pick_string(raw.get("mobile")))
            .or_else(|| pick_string(raw.get("account"))),
    );
    insert_optional_string(
        &mut auth,
        "password",
        auth_node
            .and_then(|node| pick_string(node.get("password")))
            .or_else(|| pick_string(raw.get("password"))),
    );
    insert_optional_string(
        &mut auth,
        "accountFile",
        auth_node
            .and_then(|node| {
                pick_string(node.get("accountFile"))
                    .or_else(|| pick_string(node.get("account_file")))
            })
            .or_else(|| pick_string(raw.get("accountFile")))
            .or_else(|| pick_string(raw.get("account_file"))),
    );
    insert_optional_string(
        &mut auth,
        "accountAlias",
        auth_node
            .and_then(|node| {
                pick_string(node.get("accountAlias"))
                    .or_else(|| pick_string(node.get("account_alias")))
            })
            .or_else(|| pick_string(raw.get("accountAlias")))
            .or_else(|| pick_string(raw.get("account_alias"))),
    );
    insert_optional_string(
        &mut auth,
        "tokenFile",
        auth_node
            .and_then(|node| {
                pick_string(node.get("tokenFile")).or_else(|| pick_string(node.get("token_file")))
            })
            .or_else(|| pick_string(raw.get("tokenFile")))
            .or_else(|| pick_string(raw.get("token_file"))),
    );
    Ok(Value::Object(auth))
}

fn normalize_provider_auth_type(
    auth_type: Option<&str>,
    has_oauth_node: bool,
    api_key: Option<&str>,
    secret_ref: Option<&str>,
    env_ref: Option<&str>,
) -> Result<&'static str, String> {
    let normalized = auth_type.map(|value| value.trim().to_ascii_lowercase());
    if normalized
        .as_deref()
        .is_some_and(|value| value.contains("oauth") || value == "bearer-oauth")
    {
        return Err(
            "[provider-profiles] OAuth auth has been removed. Use auth.type=\"apikey\"."
                .to_string(),
        );
    }
    if normalized
        .as_deref()
        .is_some_and(|value| value == "apikey" || value == "bearer")
    {
        return Ok("apikey");
    }
    if has_oauth_node {
        return Err(
            "[provider-profiles] OAuth auth has been removed. Remove the oauth block.".to_string(),
        );
    }
    if api_key.is_some() || secret_ref.is_some() || env_ref.is_some() || normalized.is_some() {
        return Ok("apikey");
    }
    Ok("none")
}

fn extract_api_key_entries_array(auth_node: &Map<String, Value>) -> Option<Value> {
    let entries = auth_node.get("entries").and_then(Value::as_array)?;
    let mut out = Vec::new();
    for entry in entries {
        let Some(entry_node) = entry.as_object() else {
            continue;
        };
        let mut normalized = Map::new();
        insert_optional_string(
            &mut normalized,
            "alias",
            pick_string(entry_node.get("alias")),
        );
        insert_optional_string(
            &mut normalized,
            "apiKey",
            pick_string(entry_node.get("apiKey")),
        );
        insert_optional_string(
            &mut normalized,
            "secretRef",
            pick_string(entry_node.get("secretRef")),
        );
        insert_optional_string(
            &mut normalized,
            "env",
            pick_string(entry_node.get("env")).or_else(|| pick_string(entry_node.get("envRef"))),
        );
        out.push(Value::Object(normalized));
    }
    (!out.is_empty()).then(|| Value::Array(out))
}

fn extract_provider_compat_profile(
    provider_id: &str,
    raw: &Map<String, Value>,
) -> Result<Option<String>, String> {
    let declared = pick_string(raw.get("compatibilityProfile"));
    let mut legacy_fields = Vec::new();
    if raw
        .get("compatibility_profile")
        .and_then(Value::as_str)
        .is_some()
    {
        legacy_fields.push("compatibility_profile");
    }
    if raw.get("compat").and_then(Value::as_str).is_some() {
        legacy_fields.push("compat");
    }
    if let Some(compatibility) = raw.get("compatibility").and_then(Value::as_object) {
        if compatibility
            .get("profile")
            .and_then(Value::as_str)
            .is_some()
        {
            legacy_fields.push("compatibility.profile");
        }
        if compatibility.get("id").and_then(Value::as_str).is_some() {
            legacy_fields.push("compatibility.id");
        }
    }
    if !legacy_fields.is_empty() {
        return Err(format!(
            "[provider-profiles] Provider \"{}\" uses legacy compatibility field(s): {}. Rename to \"compatibilityProfile\".",
            provider_id,
            legacy_fields.join(", ")
        ));
    }
    Ok(declared)
}

fn extract_provider_profile_metadata(raw: &Map<String, Value>) -> Option<Value> {
    let default_model = pick_string(raw.get("defaultModel").or_else(|| raw.get("default_model")));
    let supported_models = raw.get("models").and_then(Value::as_object).map(|models| {
        Value::Array(
            models
                .keys()
                .cloned()
                .map(Value::String)
                .collect::<Vec<_>>(),
        )
    });
    let extensions = raw.get("extensions").and_then(Value::as_object);
    let concurrency = extract_concurrency_metadata(
        raw.get("concurrency")
            .or_else(|| extensions.and_then(|node| node.get("concurrency"))),
    );
    let rpm = extract_rpm_metadata(
        raw.get("rpm")
            .or_else(|| extensions.and_then(|node| node.get("rpm"))),
    );
    let mut metadata = Map::new();
    insert_optional_string(&mut metadata, "defaultModel", default_model);
    if let Some(supported_models) =
        supported_models.filter(|value| value.as_array().is_some_and(|items| !items.is_empty()))
    {
        metadata.insert("supportedModels".to_string(), supported_models);
    }
    if let Some(concurrency) = concurrency {
        metadata.insert("concurrency".to_string(), concurrency);
    }
    if let Some(rpm) = rpm {
        metadata.insert("rpm".to_string(), rpm);
    }
    (!metadata.is_empty()).then(|| Value::Object(metadata))
}

fn extract_concurrency_metadata(raw: Option<&Value>) -> Option<Value> {
    let node = raw.and_then(Value::as_object)?;
    let max_in_flight = pick_positive_i64(
        node.get("maxInFlight")
            .or_else(|| node.get("max_in_flight"))
            .or_else(|| node.get("maxConcurrency")),
    )?;
    let mut out = Map::new();
    out.insert(
        "maxInFlight".to_string(),
        Value::Number(max_in_flight.into()),
    );
    if let Some(acquire_timeout_ms) = pick_positive_i64(
        node.get("acquireTimeoutMs")
            .or_else(|| node.get("acquire_timeout_ms")),
    ) {
        out.insert(
            "acquireTimeoutMs".to_string(),
            Value::Number(acquire_timeout_ms.into()),
        );
    }
    if let Some(stale_lease_ms) = pick_positive_i64(
        node.get("staleLeaseMs")
            .or_else(|| node.get("stale_lease_ms")),
    ) {
        out.insert(
            "staleLeaseMs".to_string(),
            Value::Number(stale_lease_ms.into()),
        );
    }
    Some(Value::Object(out))
}

fn extract_rpm_metadata(raw: Option<&Value>) -> Option<Value> {
    let node = raw.and_then(Value::as_object)?;
    let requests_per_minute = pick_positive_i64(
        node.get("requestsPerMinute")
            .or_else(|| node.get("requests_per_minute"))
            .or_else(|| node.get("maxRequestsPerMinute"))
            .or_else(|| node.get("max_requests_per_minute"))
            .or_else(|| node.get("limit")),
    )?;
    let mut out = Map::new();
    out.insert(
        "requestsPerMinute".to_string(),
        Value::Number(requests_per_minute.into()),
    );
    if let Some(acquire_timeout_ms) = pick_positive_i64(
        node.get("acquireTimeoutMs")
            .or_else(|| node.get("acquire_timeout_ms")),
    ) {
        out.insert(
            "acquireTimeoutMs".to_string(),
            Value::Number(acquire_timeout_ms.into()),
        );
    }
    Some(Value::Object(out))
}

fn insert_optional_string(map: &mut Map<String, Value>, key: &str, value: Option<String>) {
    if let Some(value) = value.filter(|value| !value.is_empty()) {
        map.insert(key.to_string(), Value::String(value));
    }
}

const ROUTING_POLICY_OPTIONAL_KEYS: [&str; 8] = [
    "loadBalancing",
    "classifier",
    "health",
    "contextRouting",
    "webSearch",
    "execCommandGuard",
    "servertool",
    "session",
];

fn collect_v2_config_source_errors(user_config: &Value) -> Vec<String> {
    let Some(root) = user_config.as_object() else {
        return vec!["v2 config must be an object".to_string()];
    };
    let mut errors = Vec::new();
    let mode = pick_string(root.get("virtualrouterMode"))
        .map(|value| value.to_ascii_lowercase())
        .unwrap_or_default();
    if mode != "v2" && !is_implicit_v2_config(root) {
        errors.push("RouteCodex only supports virtualrouterMode=\"v2\"".to_string());
    }

    let allowed_top_level = BTreeSet::from([
        "version",
        "httpserver",
        "virtualrouter",
        "virtualrouterMode",
        "servertool",
    ]);
    for key in root.keys() {
        if !allowed_top_level.contains(key.as_str()) {
            errors.push(format!("v2 config disallows top-level field \"{}\"", key));
        }
    }

    match root.get("httpserver").and_then(Value::as_object) {
        Some(httpserver) => {
            let allowed_http =
                BTreeSet::from(["host", "port", "apikey", "ports", "sameProtocolBehavior"]);
            for key in httpserver.keys() {
                if !allowed_http.contains(key.as_str()) {
                    errors.push(format!("v2 config disallows httpserver field \"{}\"", key));
                }
            }
            if !httpserver
                .get("ports")
                .and_then(Value::as_array)
                .is_some_and(|ports| !ports.is_empty())
            {
                errors.push("v2 config requires non-empty httpserver.ports[]".to_string());
            }
        }
        None => errors.push("v2 config requires httpserver.ports[]".to_string()),
    }

    let Some(vr) = root.get("virtualrouter").and_then(Value::as_object) else {
        errors.push("v2 config requires virtualrouter.routingPolicyGroups".to_string());
        return errors;
    };
    let allowed_vr = BTreeSet::from([
        "routingPolicyGroups",
        "forwarders",
        "activeRoutingPolicyGroup",
        "routing",
    ]);
    for key in vr.keys() {
        if !allowed_vr.contains(key.as_str()) {
            errors.push(format!(
                "v2 config disallows virtualrouter field \"{}\"",
                key
            ));
        }
    }
    let Some(groups_node) = vr.get("routingPolicyGroups").and_then(Value::as_object) else {
        errors.push("v2 config requires non-empty virtualrouter.routingPolicyGroups".to_string());
        return errors;
    };
    if groups_node.is_empty() {
        errors.push("v2 config requires non-empty virtualrouter.routingPolicyGroups".to_string());
        return errors;
    }
    let mut allowed_group_keys = BTreeSet::from(["routing"]);
    for key in ROUTING_POLICY_OPTIONAL_KEYS {
        allowed_group_keys.insert(key);
    }
    for (group_id, group_node) in groups_node {
        if group_id.trim().is_empty() {
            errors.push("v2 routingPolicyGroups contains empty group id".to_string());
            continue;
        }
        let Some(group) = group_node.as_object() else {
            errors.push(format!(
                "v2 routingPolicyGroups[\"{}\"] must be an object",
                group_id
            ));
            continue;
        };
        for key in group.keys() {
            if !allowed_group_keys.contains(key.as_str()) {
                errors.push(format!(
                    "v2 routingPolicyGroups[\"{}\"] disallows field \"{}\"",
                    group_id, key
                ));
            }
        }
        let routing = group.get("routing").and_then(Value::as_object);
        match routing {
            Some(routing) if routing_default_has_explicit_target(routing) => {}
            Some(_) => errors.push(format!(
                "v2 routingPolicyGroups[\"{}\"].routing.default must define an explicit non-empty default provider tier",
                group_id
            )),
            None => errors.push(format!(
                "v2 routingPolicyGroups[\"{}\"] must define routing",
                group_id
            )),
        }
    }
    errors
}

fn normalize_v2_runtime_source(user_config: &Value) -> Value {
    let Some(root) = user_config.as_object() else {
        return user_config.clone();
    };
    let mut normalized = root.clone();
    if pick_string(normalized.get("virtualrouterMode")).is_none()
        && is_implicit_v2_config(&normalized)
    {
        normalized.insert(
            "virtualrouterMode".to_string(),
            Value::String("v2".to_string()),
        );
    }
    Value::Object(normalized)
}

fn route_entry_has_target(entry: &Value) -> bool {
    let Some(record) = entry.as_object() else {
        return false;
    };
    pick_string(record.get("target")).is_some()
        || pick_string(record.get("provider")).is_some()
        || record
            .get("targets")
            .and_then(Value::as_array)
            .is_some_and(|targets| {
                targets
                    .iter()
                    .any(|target| pick_string(Some(target)).is_some())
            })
}

fn routing_default_has_explicit_target(routing: &Map<String, Value>) -> bool {
    let Some(default_route) = routing.get("default") else {
        return false;
    };
    if let Some(entries) = default_route.as_array() {
        return entries.iter().any(route_entry_has_target);
    }
    route_entry_has_target(default_route)
}

fn is_implicit_v2_config(user_config: &Map<String, Value>) -> bool {
    user_config.get("version").and_then(Value::as_str) == Some("2.0.0")
        && user_config
            .get("virtualrouter")
            .and_then(Value::as_object)
            .and_then(|vr| vr.get("routingPolicyGroups"))
            .and_then(Value::as_object)
            .is_some()
}

fn resolve_primary_routing_policy_group(user_config: &Value) -> Option<String> {
    let root = user_config.as_object()?;
    let ports = root
        .get("httpserver")
        .and_then(Value::as_object)
        .and_then(|node| node.get("ports"))
        .and_then(Value::as_array)?;
    for port in ports {
        let Some(port_record) = port.as_object() else {
            continue;
        };
        let mode = pick_string(port_record.get("mode"))
            .map(|value| value.to_ascii_lowercase())
            .unwrap_or_default();
        if !mode.is_empty() && mode != "router" {
            continue;
        }
        if let Some(group) = pick_string(port_record.get("routingPolicyGroup")) {
            return Some(group);
        }
    }
    let virtualrouter = root.get("virtualrouter").and_then(Value::as_object)?;
    let groups = virtualrouter
        .get("routingPolicyGroups")
        .and_then(Value::as_object)?;
    if let Some(active_group) = pick_string(virtualrouter.get("activeRoutingPolicyGroup")) {
        if groups
            .get(&active_group)
            .and_then(Value::as_object)
            .is_some()
        {
            return Some(active_group);
        }
    }
    let group_ids: Vec<String> = groups
        .keys()
        .filter_map(|group_id| {
            let trimmed = group_id.trim();
            (!trimmed.is_empty()).then(|| trimmed.to_string())
        })
        .collect();
    if group_ids.len() == 1 {
        group_ids.into_iter().next()
    } else {
        None
    }
}

#[derive(Clone)]
struct ProviderConfigRecord {
    provider: Value,
}

fn normalize_provider_configs(
    provider_configs: &Map<String, Value>,
) -> Result<BTreeMap<String, ProviderConfigRecord>, String> {
    let mut out = BTreeMap::new();
    for (provider_id_raw, value) in provider_configs {
        let provider_id = provider_id_raw.trim();
        if provider_id.is_empty() {
            return Err("[config] providerConfigs contains empty provider id".to_string());
        }
        let record = value.as_object().ok_or_else(|| {
            format!(
                "[config] providerConfigs[\"{}\"] must be an object",
                provider_id
            )
        })?;
        let provider = record.get("provider").cloned().ok_or_else(|| {
            format!(
                "[config] providerConfigs[\"{}\"].provider is required",
                provider_id
            )
        })?;
        if !provider.is_object() {
            return Err(format!(
                "[config] providerConfigs[\"{}\"].provider must be an object",
                provider_id
            ));
        }
        out.insert(provider_id.to_string(), ProviderConfigRecord { provider });
    }
    Ok(out)
}

fn extract_routing_from_user_config(
    user_config: &Map<String, Value>,
    requested_group: Option<&str>,
    include_all_routing_policy_groups: bool,
) -> Result<Map<String, Value>, String> {
    let vr_node = user_config
        .get("virtualrouter")
        .and_then(Value::as_object)
        .ok_or_else(|| {
            "[config] v2 config requires virtualrouter.routingPolicyGroups".to_string()
        })?;
    let groups_node = vr_node
        .get("routingPolicyGroups")
        .and_then(Value::as_object)
        .ok_or_else(|| {
            "[config] v2 config requires virtualrouter.routingPolicyGroups".to_string()
        })?;

    let mut group_entries = Vec::new();
    for (group_id_raw, group_node) in groups_node {
        let group_id = group_id_raw.trim();
        if group_id.is_empty() || !group_node.is_object() {
            continue;
        }
        if let Some(requested) = requested_group {
            if group_id != requested {
                continue;
            }
        }
        group_entries.push((group_id.to_string(), group_node.as_object().unwrap()));
    }
    if requested_group.is_some() && group_entries.is_empty() {
        return Err(format!(
            "[config] v2 config missing virtualrouter.routingPolicyGroups[\"{}\"]",
            requested_group.unwrap()
        ));
    }
    if requested_group.is_none() && !include_all_routing_policy_groups && group_entries.len() > 1 {
        return Err(
            "[config] v2 config with multiple routingPolicyGroups requires an explicit routingPolicyGroup"
                .to_string(),
        );
    }
    if group_entries.is_empty() {
        return Err(
            "[config] v2 config requires virtualrouter.routingPolicyGroups with at least one group"
                .to_string(),
        );
    }

    let mut routing = Map::new();
    for (group_id, group_node) in group_entries {
        let group_routing = match group_node.get("routing").and_then(Value::as_object) {
            Some(value) => value,
            None => continue,
        };
        for (route_type, route_entry) in group_routing {
            if !route_entry.is_object() && !route_entry.is_array() {
                continue;
            }
            let tagged = with_route_policy_group_tag(route_entry, &group_id);
            let tagged_array = match tagged {
                Value::Array(items) => items,
                other => vec![other],
            };
            let mut existing = routing
                .remove(route_type)
                .and_then(|value| value.as_array().cloned())
                .unwrap_or_default();
            existing.extend(tagged_array);
            routing.insert(route_type.clone(), Value::Array(existing));
        }
    }
    if routing.is_empty() {
        return Err(
            "[config] v2 config requires virtualrouter.routingPolicyGroups group with routing field"
                .to_string(),
        );
    }
    Ok(routing)
}

fn with_route_policy_group_tag(route_entry: &Value, group_id: &str) -> Value {
    if let Some(items) = route_entry.as_array() {
        return Value::Array(
            items
                .iter()
                .map(|item| with_route_policy_group_tag(item, group_id))
                .collect(),
        );
    }
    let Some(record) = route_entry.as_object() else {
        return route_entry.clone();
    };
    let mut out = record.clone();
    let mut route_params = out
        .get("routeParams")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    if pick_string(route_params.get("routePolicyGroup")).is_none() {
        route_params.insert(
            "routePolicyGroup".to_string(),
            Value::String(group_id.to_string()),
        );
    }
    out.insert("routeParams".to_string(), Value::Object(route_params));
    Value::Object(out)
}

fn extract_policy_group_option_from_user_config(
    user_config: &Map<String, Value>,
    key: &str,
    requested_group: Option<&str>,
) -> Option<Value> {
    let vr_node = user_config
        .get("virtualrouter")
        .and_then(Value::as_object)?;
    let groups_node = vr_node
        .get("routingPolicyGroups")
        .and_then(Value::as_object)?;
    if let Some(requested) = requested_group {
        if let Some(group) = groups_node.get(requested).and_then(Value::as_object) {
            if let Some(value) = group.get(key).filter(|value| value.is_object()) {
                return Some(value.clone());
            }
        }
    }
    vr_node.get(key).filter(|value| value.is_object()).cloned()
}

fn resolve_referenced_provider_ids_from_routing(routing: &Map<String, Value>) -> BTreeSet<String> {
    let mut provider_ids = BTreeSet::new();
    for entries in routing.values() {
        for entry in route_entries(entries) {
            let Some(record) = entry.as_object() else {
                continue;
            };
            if let Some(targets) = record.get("targets").and_then(Value::as_array) {
                for target in targets {
                    if let Some(provider_id) = pick_string(Some(target))
                        .and_then(|key| parse_provider_id_from_provider_key(&key))
                    {
                        provider_ids.insert(provider_id);
                    }
                }
            }
            if let Some(provider_id) = pick_string(record.get("target"))
                .and_then(|key| parse_provider_id_from_provider_key(&key))
            {
                provider_ids.insert(provider_id);
            }
            let weights = record
                .get("loadBalancing")
                .and_then(Value::as_object)
                .and_then(|node| node.get("weights"))
                .and_then(Value::as_object);
            if let Some(weights) = weights {
                for target in weights.keys() {
                    if let Some(provider_id) = parse_provider_id_from_provider_key(target) {
                        provider_ids.insert(provider_id);
                    }
                }
            }
        }
    }
    provider_ids
}

fn resolve_referenced_forwarder_ids_from_routing(routing: &Map<String, Value>) -> BTreeSet<String> {
    let mut ids = BTreeSet::new();
    for entries in routing.values() {
        for entry in route_entries(entries) {
            let Some(record) = entry.as_object() else {
                continue;
            };
            if let Some(targets) = record.get("targets").and_then(Value::as_array) {
                for target in targets {
                    collect_forwarder_id(target, &mut ids);
                }
            }
            if let Some(target) = record.get("target") {
                collect_forwarder_id(target, &mut ids);
            }
        }
    }
    ids
}

fn route_entries(entries: &Value) -> Vec<&Value> {
    if let Some(items) = entries.as_array() {
        return items.iter().collect();
    }
    if entries.is_null() {
        Vec::new()
    } else {
        vec![entries]
    }
}

fn collect_forwarder_id(target: &Value, ids: &mut BTreeSet<String>) {
    if let Some(trimmed) = pick_string(Some(target)) {
        if trimmed.starts_with("fwd.") && trimmed.len() > 4 {
            ids.insert(trimmed);
        }
    }
}

fn resolve_provider_ids_from_provider_ports(user_config: &Map<String, Value>) -> BTreeSet<String> {
    let mut ids = BTreeSet::new();
    let ports = user_config
        .get("httpserver")
        .and_then(Value::as_object)
        .and_then(|node| node.get("ports"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    for port in ports {
        let Some(port_record) = port.as_object() else {
            continue;
        };
        let mode = pick_string(port_record.get("mode"))
            .map(|value| value.to_ascii_lowercase())
            .unwrap_or_default();
        if mode != "provider" {
            continue;
        }
        if let Some(provider_id) = pick_string(port_record.get("providerBinding"))
            .and_then(|key| parse_provider_id_from_provider_key(&key))
        {
            ids.insert(provider_id);
        }
    }
    ids
}

fn extract_apply_patch_config_from_user_config(user_config: &Map<String, Value>) -> Option<Value> {
    let vr_node = user_config.get("virtualrouter").and_then(Value::as_object);
    let top_servertool = user_config.get("servertool").and_then(Value::as_object);
    let vr_servertool = vr_node
        .and_then(|node| node.get("servertool"))
        .and_then(Value::as_object);
    let candidates = [
        top_servertool.and_then(|node| node.get("applyPatch")),
        top_servertool.and_then(|node| node.get("apply_patch")),
        vr_servertool.and_then(|node| node.get("applyPatch")),
        vr_servertool.and_then(|node| node.get("apply_patch")),
    ];
    let first = candidates
        .into_iter()
        .flatten()
        .find(|value| value.is_object())?;
    let mut out = first.as_object()?.clone();
    let mode = pick_string(out.get("mode"))
        .map(|value| value.to_ascii_lowercase())
        .unwrap_or_default();
    if mode == "freeform" {
        out.insert("mode".to_string(), Value::String("client".to_string()));
    }
    Some(Value::Object(out))
}

fn extract_forwarders_from_user_config(
    user_config: &Map<String, Value>,
) -> Option<BTreeMap<String, Map<String, Value>>> {
    let vr_node = user_config.get("virtualrouter").and_then(Value::as_object);
    let candidates = [
        vr_node.and_then(|node| node.get("forwarders")),
        user_config.get("forwarders"),
    ];
    for candidate in candidates.into_iter().flatten() {
        let Some(candidate_map) = candidate.as_object() else {
            continue;
        };
        let mut filtered = BTreeMap::new();
        for (key, value) in candidate_map {
            if key.starts_with("fwd.") {
                if let Some(record) = value.as_object() {
                    filtered.insert(key.clone(), record.clone());
                }
            }
        }
        if !filtered.is_empty() {
            return Some(filtered);
        }
    }
    None
}

fn normalize_forwarders_for_native(
    source: &BTreeMap<String, Map<String, Value>>,
    provider_configs: &BTreeMap<String, ProviderConfigRecord>,
) -> Result<Map<String, Value>, String> {
    let mut out = Map::new();
    for (id, raw) in source {
        let mut entry = raw.clone();
        if pick_string(entry.get("forwarderId")).is_none() {
            entry.insert("forwarderId".to_string(), Value::String(id.clone()));
        }
        if pick_string(entry.get("protocol")).is_none() {
            return Err(format!("[forwarder-config] {} missing protocol", id));
        }
        let normalized_model_id = pick_string(entry.get("modelId"));
        let authoring_model = pick_string(entry.get("model"));
        if normalized_model_id.is_some()
            && authoring_model.is_some()
            && normalized_model_id != authoring_model
        {
            return Err(format!(
                "[forwarder-config] {} has conflicting model/modelId",
                id
            ));
        }
        let model_id = authoring_model.or(normalized_model_id);
        let Some(model_id) = model_id else {
            return Err(format!("[forwarder-config] {} missing top-level model", id));
        };
        entry.insert("modelId".to_string(), Value::String(model_id.clone()));
        entry.remove("model");
        if pick_string(entry.get("resolutionMode")).is_none() {
            entry.insert(
                "resolutionMode".to_string(),
                Value::String("model-first".to_string()),
            );
        }
        if pick_string(entry.get("strategy")).is_none() {
            entry.insert(
                "strategy".to_string(),
                Value::String("round-robin".to_string()),
            );
        }
        if pick_string(entry.get("stickyKey")).is_none() {
            entry.insert("stickyKey".to_string(), Value::String("none".to_string()));
        }
        if let Some(targets) = entry.get("targets").and_then(Value::as_array).cloned() {
            let mut normalized_targets = Vec::new();
            for target in targets {
                let Some(target_record) = target.as_object() else {
                    continue;
                };
                for provider_key in resolve_forwarder_target_provider_keys(
                    id,
                    &model_id,
                    target_record,
                    provider_configs,
                )? {
                    let mut normalized = Map::new();
                    normalized.insert("providerKey".to_string(), Value::String(provider_key));
                    if let Some(provider_id) = pick_string(target_record.get("providerId")) {
                        normalized.insert("providerId".to_string(), Value::String(provider_id));
                    }
                    if let Some(weight) = pick_number(target_record.get("weight")) {
                        normalized.insert("weight".to_string(), json!(weight));
                    }
                    if let Some(priority) = pick_number(target_record.get("priority")) {
                        normalized.insert("priority".to_string(), json!(priority));
                    }
                    normalized.insert(
                        "disabled".to_string(),
                        Value::Bool(
                            target_record.get("disabled").and_then(Value::as_bool) == Some(true),
                        ),
                    );
                    normalized_targets.push(Value::Object(normalized));
                }
            }
            entry.insert("targets".to_string(), Value::Array(normalized_targets));
        }
        out.insert(id.clone(), Value::Object(entry));
    }
    Ok(out)
}

fn resolve_forwarder_target_provider_keys(
    forwarder_id: &str,
    forwarder_model_id: &str,
    target: &Map<String, Value>,
    provider_configs: &BTreeMap<String, ProviderConfigRecord>,
) -> Result<Vec<String>, String> {
    if let Some(provider_key) = pick_string(target.get("providerKey")) {
        return Ok(vec![provider_key]);
    }
    if pick_string(target.get("provider")).is_some() {
        return Err(format!(
            "[forwarder-config] {} target must declare providerId",
            forwarder_id
        ));
    }
    let provider_id = pick_string(target.get("providerId")).ok_or_else(|| {
        format!(
            "[forwarder-config] {} target requires providerId",
            forwarder_id
        )
    })?;
    let provider_config = provider_configs.get(&provider_id).ok_or_else(|| {
        format!(
            "[forwarder-config] {} target providerId '{}' is not configured",
            forwarder_id, provider_id
        )
    })?;
    let target_model_id =
        pick_string(target.get("modelId")).or_else(|| pick_string(target.get("model")));
    if let Some(target_model_id) = target_model_id {
        if target_model_id != forwarder_model_id {
            return Err(format!(
                "[forwarder-config] {} target '{}' model '{}' must match forwarder.model '{}'",
                forwarder_id, provider_id, target_model_id, forwarder_model_id
            ));
        }
    }
    let provider = provider_config.provider.as_object().ok_or_else(|| {
        format!(
            "[config] providerConfigs[\"{}\"].provider must be an object",
            provider_id
        )
    })?;
    if !provider_declares_model(provider, forwarder_model_id) {
        return Err(format!(
            "[forwarder-config] {} target '{}' does not declare model '{}'",
            forwarder_id, provider_id, forwarder_model_id
        ));
    }
    let aliases = provider_auth_aliases(provider);
    if aliases.is_empty() {
        return Err(format!(
            "[forwarder-config] {} target '{}' has no auth aliases",
            forwarder_id, provider_id
        ));
    }
    Ok(aliases
        .into_iter()
        .map(|alias| format!("{}.{}.{}", provider_id, alias, forwarder_model_id))
        .collect())
}

fn provider_auth_aliases(provider: &Map<String, Value>) -> Vec<String> {
    let auth = provider.get("auth").and_then(Value::as_object);
    let mut aliases = Vec::new();
    let mut seen = BTreeSet::new();
    if let Some(entries) = auth
        .and_then(|node| node.get("entries"))
        .and_then(Value::as_array)
    {
        for entry in entries {
            if let Some(record) = entry.as_object() {
                add_alias(pick_string(record.get("alias")), &mut aliases, &mut seen);
            }
        }
    }
    if let Some(keys) = auth.and_then(|node| node.get("keys")) {
        if let Some(items) = keys.as_array() {
            for item in items {
                if let Some(record) = item.as_object() {
                    add_alias(pick_string(record.get("alias")), &mut aliases, &mut seen);
                } else if pick_string(Some(item)).is_some() {
                    add_alias(None, &mut aliases, &mut seen);
                }
            }
        } else if let Some(map) = keys.as_object() {
            for alias in map.keys() {
                add_alias(Some(alias.clone()), &mut aliases, &mut seen);
            }
        }
    }
    if aliases.is_empty()
        && (pick_string(provider.get("apiKey")).is_some()
            || auth
                .and_then(|node| pick_string(node.get("apiKey")))
                .is_some()
            || auth
                .and_then(|node| pick_string(node.get("value")))
                .is_some())
    {
        add_alias(None, &mut aliases, &mut seen);
    }
    aliases
}

fn add_alias(alias: Option<String>, aliases: &mut Vec<String>, seen: &mut BTreeSet<String>) {
    let base = alias.unwrap_or_else(|| format!("key{}", seen.len() + 1));
    let mut normalized = base.clone();
    let mut index = 1;
    while seen.contains(&normalized) {
        normalized = format!("{}_{}", base, index);
        index += 1;
    }
    seen.insert(normalized.clone());
    aliases.push(normalized);
}

fn provider_declares_model(provider: &Map<String, Value>, model_id: &str) -> bool {
    let normalized_model_id = model_id.trim();
    if normalized_model_id.is_empty() {
        return false;
    }
    if let Some(models) = provider.get("models") {
        if let Some(items) = models.as_array() {
            return items.iter().any(|model| {
                model
                    .as_object()
                    .and_then(|node| pick_string(node.get("id")))
                    .as_deref()
                    == Some(normalized_model_id)
            });
        }
        if let Some(map) = models.as_object() {
            return map.contains_key(normalized_model_id);
        }
    }
    let default_model = pick_string(provider.get("defaultModel"))
        .or_else(|| pick_string(provider.get("modelId")))
        .or_else(|| pick_string(provider.get("model")));
    default_model.as_deref() == Some(normalized_model_id)
}

fn parse_provider_id_from_provider_key(provider_key: &str) -> Option<String> {
    provider_key
        .split('.')
        .next()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn pick_string(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn pick_number(value: Option<&Value>) -> Option<f64> {
    match value {
        Some(Value::Number(number)) => number.as_f64(),
        Some(Value::String(raw)) => raw.trim().parse::<f64>().ok(),
        _ => None,
    }
}

fn pick_positive_i64(value: Option<&Value>) -> Option<i64> {
    let parsed = pick_number(value)?;
    if !parsed.is_finite() {
        return None;
    }
    let normalized = parsed.floor() as i64;
    (normalized > 0).then_some(normalized)
}

#[cfg(test)]
mod tests {
    use super::{
        build_routecodex_provider_profiles_json, collect_v2_config_source_errors_json,
        compile_routecodex_runtime_manifest_json,
        extract_routecodex_materialized_provider_configs_json,
        materialize_routecodex_user_config_from_manifest_json,
        normalize_routecodex_v2_runtime_source_json,
        resolve_primary_routecodex_routing_policy_group_json,
    };
    use serde_json::{json, Value};

    #[test]
    fn compiles_runtime_manifest_from_decoded_records() {
        let input = json!({
            "userConfig": {
                "servertool": { "apply_patch": { "mode": "freeform" } },
                "httpserver": {
                    "ports": [
                        { "port": 5520, "mode": "router", "routingPolicyGroup": "beta" },
                        { "port": 7001, "mode": "provider", "providerBinding": "side.key1.side-model" }
                    ]
                },
                "virtualrouter": {
                    "forwarders": {
                        "fwd.gpt.gpt-5.5": {
                            "protocol": "openai",
                            "model": "gpt-5.5",
                            "targets": [{ "providerId": "freepool", "weight": 3 }]
                        }
                    },
                    "routingPolicyGroups": {
                        "alpha": {
                            "routing": { "default": [{ "id": "alpha-route", "targets": ["unused.alpha-model"] }] }
                        },
                        "beta": {
                            "hitLog": { "enabled": true },
                            "routing": { "default": [{ "id": "beta-route", "target": "fwd.gpt.gpt-5.5" }] }
                        }
                    }
                }
            },
            "providerConfigs": {
                "freepool": {
                    "provider": {
                        "id": "freepool",
                        "type": "openai",
                        "auth": { "entries": [{ "alias": "key1" }, { "alias": "key2" }] },
                        "models": { "gpt-5.5": {} }
                    }
                },
                "side": {
                    "provider": {
                        "id": "side",
                        "type": "openai",
                        "auth": { "entries": [{ "alias": "key1" }] },
                        "models": { "side-model": {} }
                    }
                },
                "unused": {
                    "provider": {
                        "id": "unused",
                        "type": "openai",
                        "auth": { "entries": [{ "alias": "key1" }] },
                        "models": { "alpha-model": {} }
                    }
                }
            },
            "options": { "routingPolicyGroup": "beta" }
        });
        let raw = compile_routecodex_runtime_manifest_json(input.to_string()).unwrap();
        let manifest: Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(manifest["manifestVersion"], "routecodex.runtime-config.v1");
        assert_eq!(manifest["routingPolicyGroup"], "beta");
        assert!(manifest["virtualRouterBootstrapInput"]["providers"]["freepool"].is_object());
        assert!(manifest["virtualRouterBootstrapInput"]["providers"]["side"].is_object());
        assert!(manifest["virtualRouterBootstrapInput"]["providers"]["unused"].is_null());
        assert_eq!(
            manifest["virtualRouterBootstrapInput"]["routing"]["default"][0]["routeParams"]
                ["routePolicyGroup"],
            "beta"
        );
        assert_eq!(
            manifest["virtualRouterBootstrapInput"]["forwarders"]["fwd.gpt.gpt-5.5"]["targets"][1]
                ["providerKey"],
            "freepool.key2.gpt-5.5"
        );
        assert_eq!(
            manifest["virtualRouterBootstrapInput"]["applyPatch"]["mode"],
            "client"
        );
    }

    #[test]
    fn validates_v2_config_source_layout_in_rust() {
        let input = json!({
            "userConfig": {
                "version": "2.0.0",
                "providers": { "legacy": {} },
                "httpserver": {
                    "ports": [{ "port": 5555, "mode": "router", "routingPolicyGroup": "default" }]
                },
                "virtualrouter": {
                    "routingPolicyGroups": {
                        "default": {
                            "routing": {
                                "coding": [{ "id": "coding", "targets": ["demo.model"] }]
                            }
                        }
                    }
                }
            }
        });
        let raw = collect_v2_config_source_errors_json(input.to_string()).unwrap();
        let output: Value = serde_json::from_str(&raw).unwrap();
        let errors = output["errors"].as_array().unwrap();
        assert!(errors.iter().any(|error| {
            error
                .as_str()
                .unwrap_or_default()
                .contains("disallows top-level field \"providers\"")
        }));
        assert!(errors.iter().any(|error| {
            error
                .as_str()
                .unwrap_or_default()
                .contains("routingPolicyGroups[\"default\"].routing.default")
        }));
    }

    #[test]
    fn normalizes_implicit_v2_runtime_source_in_rust() {
        let input = json!({
            "userConfig": {
                "version": "2.0.0",
                "httpserver": {
                    "ports": [{ "port": 5555, "mode": "router", "routingPolicyGroup": "default" }]
                },
                "virtualrouter": {
                    "routingPolicyGroups": {
                        "default": {
                            "routing": {
                                "default": [{ "id": "default", "targets": ["demo.model"] }]
                            }
                        }
                    }
                }
            }
        });
        let raw = normalize_routecodex_v2_runtime_source_json(input.to_string()).unwrap();
        let output: Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(output["userConfig"]["virtualrouterMode"], "v2");
    }

    #[test]
    fn resolves_primary_routing_policy_group_in_rust() {
        let input = json!({
            "userConfig": {
                "httpserver": {
                    "ports": [
                        { "port": 7001, "mode": "provider", "routingPolicyGroup": "ignored" },
                        { "port": 5555, "mode": "router", "routingPolicyGroup": "canary" }
                    ]
                },
                "virtualrouter": {
                    "activeRoutingPolicyGroup": "default",
                    "routingPolicyGroups": {
                        "default": { "routing": { "default": [{ "targets": ["demo.model"] }] } },
                        "canary": { "routing": { "default": [{ "targets": ["demo.model"] }] } }
                    }
                }
            }
        });
        let raw = resolve_primary_routecodex_routing_policy_group_json(input.to_string()).unwrap();
        let output: Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(output["routingPolicyGroup"], "canary");

        let active_only = json!({
            "userConfig": {
                "httpserver": { "ports": [] },
                "virtualrouter": {
                    "activeRoutingPolicyGroup": "default",
                    "routingPolicyGroups": {
                        "default": { "routing": { "default": [{ "targets": ["demo.model"] }] } },
                        "canary": { "routing": { "default": [{ "targets": ["demo.model"] }] } }
                    }
                }
            }
        });
        let raw =
            resolve_primary_routecodex_routing_policy_group_json(active_only.to_string()).unwrap();
        let output: Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(output["routingPolicyGroup"], "default");
    }

    #[test]
    fn extracts_materialized_provider_configs_in_rust() {
        let input = json!({
            "userConfig": {
                "virtualrouter": {
                    "providers": {
                        "demo": {
                            "type": "openai",
                            "models": { "demo-model": {} }
                        }
                    }
                }
            }
        });
        let raw = extract_routecodex_materialized_provider_configs_json(input.to_string()).unwrap();
        let output: Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(output["providerConfigs"]["demo"]["version"], "2.0.0");
        assert_eq!(output["providerConfigs"]["demo"]["providerId"], "demo");
        assert_eq!(output["providerConfigs"]["demo"]["provider"]["id"], "demo");

        let mismatch = json!({
            "userConfig": {
                "virtualrouter": {
                    "providers": {
                        "demo": { "id": "other" }
                    }
                }
            }
        });
        let error = extract_routecodex_materialized_provider_configs_json(mismatch.to_string())
            .unwrap_err();
        assert!(error.to_string().contains("does not match provider id"));
    }

    #[test]
    fn materializes_user_config_virtualrouter_from_rust_manifest() {
        let input = json!({
            "userConfig": {
                "version": "2.0.0",
                "virtualrouterMode": "v2",
                "virtualrouter": {
                    "routingPolicyGroups": {
                        "default": { "routing": { "default": [{ "targets": ["demo.mock-1"] }] } }
                    },
                    "activeRoutingPolicyGroup": "default"
                }
            },
            "manifest": {
                "manifestVersion": "routecodex.runtime-config.v1",
                "virtualRouterBootstrapInput": {
                    "providers": { "demo": { "type": "mock-provider" } },
                    "routing": { "default": [{ "id": "primary", "targets": ["demo.mock-1"] }] },
                    "forwarders": { "fwd.demo.mock-1": { "targets": [{ "providerKey": "demo.key1.mock-1" }] } },
                    "applyPatch": { "mode": "client" },
                    "hitLog": { "enabled": true }
                }
            }
        });
        let raw = materialize_routecodex_user_config_from_manifest_json(input.to_string()).unwrap();
        let output: Value = serde_json::from_str(&raw).unwrap();
        let vr = &output["userConfig"]["virtualrouter"];
        assert_eq!(vr["providers"]["demo"]["type"], "mock-provider");
        assert_eq!(vr["routing"]["default"][0]["id"], "primary");
        assert!(vr["routingPolicyGroups"]["default"].is_object());
        assert_eq!(vr["activeRoutingPolicyGroup"], "default");
        assert!(vr["forwarders"]["fwd.demo.mock-1"].is_object());
        assert_eq!(vr["applyPatch"]["mode"], "client");
        assert!(vr["hitLog"].is_null());
    }

    #[test]
    fn builds_provider_profiles_in_rust() {
        let input = json!({
            "userConfig": {
                "virtualrouter": {
                    "providers": {
                        "glm": {
                            "type": "glm",
                            "baseUrl": "https://glm.example.com",
                            "apiKey": "${GLM_KEY}",
                            "compatibilityProfile": "chat:glm",
                            "headers": { "X-Test": "demo" },
                            "timeout": 45000,
                            "retryAttempts": 2,
                            "models": { "glm-4": {}, "glm-4.5": {} },
                            "concurrency": { "maxInFlight": 1 },
                            "rpm": { "requestsPerMinute": 80 }
                        },
                        "mimoweb": {
                            "type": "mimoweb",
                            "baseURL": "https://aistudio.xiaomimimo.com",
                            "auth": { "type": "apikey", "apiKey": "" }
                        }
                    }
                }
            }
        });
        let raw = build_routecodex_provider_profiles_json(input.to_string()).unwrap();
        let output: Value = serde_json::from_str(&raw).unwrap();
        let profiles = &output["providerProfiles"];
        assert_eq!(profiles["byId"]["glm"]["protocol"], "openai");
        assert_eq!(
            profiles["byId"]["glm"]["transport"]["baseUrl"],
            "https://glm.example.com"
        );
        assert_eq!(profiles["byId"]["glm"]["auth"]["kind"], "apikey");
        assert_eq!(profiles["byId"]["glm"]["auth"]["apiKey"], "${GLM_KEY}");
        assert_eq!(
            profiles["byId"]["glm"]["metadata"]["supportedModels"][0],
            "glm-4"
        );
        assert_eq!(profiles["byId"]["mimoweb"]["protocol"], "anthropic");
        assert_eq!(profiles["byId"]["mimoweb"]["moduleType"], "mimoweb");
    }

    #[test]
    fn rejects_removed_provider_profile_shapes_in_rust() {
        let oauth = json!({
            "userConfig": {
                "providers": {
                    "bad": { "type": "openai", "auth": { "type": "oauth" } }
                }
            }
        });
        let error = build_routecodex_provider_profiles_json(oauth.to_string()).unwrap_err();
        assert!(error.to_string().contains("OAuth auth has been removed"));

        let legacy = json!({
            "userConfig": {
                "providers": {
                    "legacy": { "type": "openai", "compat": "old.compat" }
                }
            }
        });
        let error = build_routecodex_provider_profiles_json(legacy.to_string()).unwrap_err();
        assert!(error.to_string().contains("legacy compatibility field"));
    }
}
