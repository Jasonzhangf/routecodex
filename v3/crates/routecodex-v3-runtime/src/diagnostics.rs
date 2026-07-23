// feature_id: v3.virtual_router_full_function
use routecodex_v3_config::{
    V3Config05ManifestPublished, V3ForwarderManifest, V3ForwarderTargetManifest,
    V3RoutePoolManifest, V3RoutePoolTargetManifest, V3RouteTargetKind,
};
use routecodex_v3_provider_responses::V3ProviderAvailabilityReader;
use routecodex_v3_target::{V3TargetCandidate, V3TargetInterpreter};
use routecodex_v3_virtual_router::V3VirtualRouter;
use serde_json::{json, Value};

pub fn project_v3_virtual_router_status<R: V3ProviderAvailabilityReader>(
    manifest: &V3Config05ManifestPublished,
    server_id: &str,
    availability: &R,
    now_ms: u64,
) -> Result<Value, String> {
    let server = manifest
        .servers
        .get(server_id)
        .filter(|server| server.enabled)
        .ok_or_else(|| format!("server {server_id} is absent or disabled"))?;
    let group = manifest
        .route_groups
        .get(&server.routing_group)
        .ok_or_else(|| format!("route group {} is absent", server.routing_group))?;
    let pools = group
        .pools
        .values()
        .map(|pool| route_pool_status_snapshot(manifest, &group.id, pool, availability, now_ms))
        .collect::<Vec<Value>>();
    let providers = group
        .pools
        .values()
        .flat_map(|pool| pool.targets.iter())
        .flat_map(|target| route_target_provider_keys(manifest, target))
        .collect::<Vec<String>>();
    Ok(json!({
        "routes": {
            group.id.clone(): {
                "providers": providers,
                "pools": pools,
                "hits": 0
            }
        },
        "health": {
            "source": "process_local_provider_health",
            "nowMs": now_ms
        },
        "forwarders": manifest.forwarders.values().map(|forwarder| forwarder_status_snapshot(forwarder, availability, now_ms)).collect::<Vec<Value>>()
    }))
}

pub fn project_v3_virtual_router_dry_run<R: V3ProviderAvailabilityReader>(
    manifest: &V3Config05ManifestPublished,
    server_id: &str,
    input: &Value,
    availability: &R,
    now_ms: u64,
) -> Result<Value, String> {
    let request = input.get("request").unwrap_or(input);
    let metadata = input.get("metadata").unwrap_or(&Value::Null);
    let endpoint = read_dry_run_endpoint(input, metadata).unwrap_or("/v1/responses");
    let entry_protocol = entry_protocol_from_endpoint(endpoint);
    let facts = crate::build_v3_router_request_facts_for_entry(request, entry_protocol);
    let router = V3VirtualRouter::default();
    let classified = router
        .classify_request_with_facts(manifest, server_id, endpoint, facts)
        .map_err(|error| error.to_string())?;
    let plan = router
        .resolve_route_pool_plan(manifest, classified)
        .map_err(|error| error.to_string())?;
    let hit = router
        .hit_opaque_target_plan_once(plan, deterministic_sample_from_metadata(metadata))
        .map_err(|error| error.to_string())?;
    let target = V3TargetInterpreter::default();
    let expanded = target
        .expand_candidates(
            manifest,
            target.classify_kind(hit.clone()),
            deterministic_sample_from_metadata(metadata),
        )
        .map_err(|error| error.to_string())?;
    let candidate_keys = expanded
        .candidates
        .iter()
        .map(format_candidate_key)
        .collect::<Vec<_>>();
    let candidate_pools = hit
        .target_plan
        .iter()
        .map(|entry| {
            json!({
                "tierIndex": entry.tier_index,
                "poolId": entry.pool_id,
                "targetIndex": entry.target_index,
                "targetKind": format!("{:?}", entry.target_kind),
                "targetId": entry.target_id
            })
        })
        .collect::<Vec<Value>>();
    let selection = target.select_available(expanded, availability, now_ms);
    let decision = match selection {
        Ok(selected) => json!({
            "selectedRouteName": selected.route.routing_group_id,
            "selectedPoolId": selected.route.pool_id,
            "selectedProviderKey": format_candidate_key(&selected.candidate),
            "selectedProviderId": selected.candidate.provider_id,
            "selectedAuthAlias": selected.candidate.auth_alias,
            "selectedModelId": selected.candidate.model_id,
            "selectedWireModel": selected.candidate.wire_model,
            "selectedProviderType": selected.candidate.provider_type,
            "selectedTransport": format!("{:?}", selected.candidate.responses_transport),
            "selectedTargetPath": selected.candidate.path,
            "candidateProviderKeys": candidate_keys,
            "candidatePools": candidate_pools,
            "unavailableCandidates": selected.unavailable_candidates,
            "attempts": selected.attempts,
            "defaultFloorSelection": selected.route.pool_id == "default",
            "wouldReturnProviderNotAvailable": false
        }),
        Err(exhausted) => json!({
            "selectedRouteName": exhausted.route.routing_group_id,
            "selectedPoolId": exhausted.route.pool_id,
            "candidateProviderKeys": candidate_keys,
            "candidatePools": candidate_pools,
            "unavailableCandidates": exhausted.attempted_candidates,
            "defaultFloorSelection": exhausted.route.pool_id == "default",
            "wouldReturnProviderNotAvailable": true
        }),
    };
    Ok(json!({
        "ok": true,
        "status": project_v3_virtual_router_status(manifest, server_id, availability, now_ms)?,
        "diagnosticInput": {
            "serverId": server_id,
            "entryEndpoint": endpoint,
            "entryProtocol": entry_protocol,
            "requestModel": request.get("model").and_then(Value::as_str),
            "metadataRequestId": metadata.get("requestId").and_then(Value::as_str)
        },
        "decision": decision
    }))
}

fn route_pool_status_snapshot(
    manifest: &V3Config05ManifestPublished,
    route_name: &str,
    pool: &V3RoutePoolManifest,
    availability: &impl V3ProviderAvailabilityReader,
    now_ms: u64,
) -> Value {
    let resolved_forwarders = pool
        .targets
        .iter()
        .filter_map(|target| target.id.as_ref())
        .filter_map(|id| manifest.forwarders.get(id))
        .map(|forwarder| forwarder_status_snapshot(forwarder, availability, now_ms))
        .collect::<Vec<Value>>();
    let configured_targets = pool
        .targets
        .iter()
        .map(route_pool_target_label)
        .collect::<Vec<String>>();
    let resolved_target_details = pool
        .targets
        .iter()
        .flat_map(|target| route_target_provider_statuses(manifest, target, availability, now_ms))
        .collect::<Vec<Value>>();
    let resolved_targets = resolved_target_details
        .iter()
        .filter_map(|target| target.get("providerKey").and_then(Value::as_str))
        .map(str::to_string)
        .collect::<Vec<String>>();
    let available_targets = resolved_target_details
        .iter()
        .filter(|target| target.get("available").and_then(Value::as_bool) == Some(true))
        .filter_map(|target| target.get("providerKey").and_then(Value::as_str))
        .map(str::to_string)
        .collect::<Vec<String>>();
    let unavailable_providers = resolved_target_details
        .iter()
        .filter(|target| target.get("available").and_then(Value::as_bool) == Some(false))
        .cloned()
        .collect::<Vec<Value>>();
    json!({
        "routeName": route_name,
        "poolId": pool.id,
        "poolMode": format!("{:?}", pool.selection.strategy),
        "configuredTargets": configured_targets,
        "resolvedTargets": resolved_targets,
        "resolvedForwarders": resolved_forwarders,
        "availableTargets": available_targets,
        "unavailableProviders": unavailable_providers,
        "targetStatuses": resolved_target_details,
        "defaultFloor": pool.id == "default" && !pool.targets.is_empty()
    })
}

fn forwarder_status_snapshot(
    forwarder: &V3ForwarderManifest,
    availability: &impl V3ProviderAvailabilityReader,
    now_ms: u64,
) -> Value {
    let targets = forwarder
        .targets
        .iter()
        .map(|target| forwarder_target_status_snapshot(target, availability, now_ms))
        .collect::<Vec<Value>>();
    let target_provider_keys = forwarder
        .targets
        .iter()
        .map(forwarder_target_label)
        .collect::<Vec<String>>();
    let available_provider_keys = targets
        .iter()
        .filter(|target| target.get("available").and_then(Value::as_bool) == Some(true))
        .filter_map(|target| target.get("providerKey").and_then(Value::as_str))
        .map(str::to_string)
        .collect::<Vec<String>>();
    let unavailable_providers = targets
        .iter()
        .filter(|target| target.get("available").and_then(Value::as_bool) == Some(false))
        .cloned()
        .collect::<Vec<Value>>();
    json!({
        "forwarderId": forwarder.id,
        "modelId": forwarder.model,
        "strategy": format!("{:?}", forwarder.selection.strategy),
        "targetProviderKeys": target_provider_keys,
        "availableProviderKeys": available_provider_keys,
        "unavailableProviders": unavailable_providers,
        "available": forwarder.enabled && targets.iter().any(|target| target.get("available").and_then(Value::as_bool) == Some(true)),
        "targets": targets
    })
}

fn forwarder_target_status_snapshot(
    target: &V3ForwarderTargetManifest,
    availability: &impl V3ProviderAvailabilityReader,
    now_ms: u64,
) -> Value {
    provider_target_status_snapshot(
        forwarder_target_label(target),
        target.provider.as_deref(),
        target.key.as_deref(),
        target.model.as_deref(),
        availability,
        now_ms,
    )
}

fn route_target_provider_keys(
    manifest: &V3Config05ManifestPublished,
    target: &V3RoutePoolTargetManifest,
) -> Vec<String> {
    match target.kind {
        V3RouteTargetKind::ProviderModel => vec![route_pool_target_label(target)],
        V3RouteTargetKind::Forwarder => target
            .id
            .as_ref()
            .and_then(|id| manifest.forwarders.get(id))
            .map(|forwarder| {
                forwarder
                    .targets
                    .iter()
                    .map(forwarder_target_label)
                    .collect::<Vec<String>>()
            })
            .unwrap_or_else(|| target.id.clone().into_iter().collect()),
    }
}

fn route_target_provider_statuses(
    manifest: &V3Config05ManifestPublished,
    target: &V3RoutePoolTargetManifest,
    availability: &impl V3ProviderAvailabilityReader,
    now_ms: u64,
) -> Vec<Value> {
    match target.kind {
        V3RouteTargetKind::ProviderModel => vec![provider_target_status_snapshot(
            route_pool_target_label(target),
            target.provider.as_deref(),
            target.key.as_deref(),
            target.model.as_deref(),
            availability,
            now_ms,
        )],
        V3RouteTargetKind::Forwarder => target
            .id
            .as_ref()
            .and_then(|id| manifest.forwarders.get(id))
            .map(|forwarder| {
                forwarder
                    .targets
                    .iter()
                    .map(|target| forwarder_target_status_snapshot(target, availability, now_ms))
                    .collect::<Vec<Value>>()
            })
            .unwrap_or_else(|| {
                target
                    .id
                    .clone()
                    .into_iter()
                    .map(|id| {
                        json!({
                            "providerKey": id,
                            "available": false,
                            "reasons": ["forwarder_missing"]
                        })
                    })
                    .collect()
            }),
    }
}

fn provider_target_status_snapshot(
    provider_key: String,
    provider: Option<&str>,
    key: Option<&str>,
    model: Option<&str>,
    availability: &impl V3ProviderAvailabilityReader,
    now_ms: u64,
) -> Value {
    let Some(provider) = provider else {
        return json!({
            "providerKey": provider_key,
            "available": false,
            "reasons": ["provider_missing"]
        });
    };
    let projection = availability.availability(provider, key, model, now_ms);
    json!({
        "providerKey": provider_key,
        "available": projection.available,
        "reasons": projection.blocked_scopes
    })
}

fn route_pool_target_label(target: &V3RoutePoolTargetManifest) -> String {
    match target.kind {
        V3RouteTargetKind::Forwarder => {
            target.id.clone().unwrap_or_else(|| "forwarder".to_string())
        }
        V3RouteTargetKind::ProviderModel => format_provider_key(
            target.provider.as_deref(),
            target.key.as_deref(),
            target.model.as_deref(),
        ),
    }
}

fn forwarder_target_label(target: &V3ForwarderTargetManifest) -> String {
    match target.kind {
        V3RouteTargetKind::Forwarder => {
            target.id.clone().unwrap_or_else(|| "forwarder".to_string())
        }
        V3RouteTargetKind::ProviderModel => format_provider_key(
            target.provider.as_deref(),
            target.key.as_deref(),
            target.model.as_deref(),
        ),
    }
}

fn format_provider_key(provider: Option<&str>, key: Option<&str>, model: Option<&str>) -> String {
    match (provider, key, model) {
        (Some(provider), Some(key), Some(model)) => format!("{provider}.{key}.{model}"),
        (Some(provider), None, Some(model)) => format!("{provider}.{model}"),
        (Some(provider), Some(key), None) => format!("{provider}.{key}"),
        (Some(provider), None, None) => provider.to_string(),
        _ => "unknown".to_string(),
    }
}

fn read_dry_run_endpoint<'a>(input: &'a Value, metadata: &'a Value) -> Option<&'a str> {
    [
        input.get("entryEndpoint"),
        input.get("entry_endpoint"),
        input.get("endpoint"),
        input.get("path"),
        metadata.get("entryEndpoint"),
        metadata.get("entry_endpoint"),
        metadata.get("endpoint"),
        metadata.get("path"),
    ]
    .into_iter()
    .flatten()
    .filter_map(Value::as_str)
    .map(str::trim)
    .find(|value| !value.is_empty())
}

fn entry_protocol_from_endpoint(endpoint: &str) -> &str {
    if endpoint.starts_with("/v1/messages") {
        "anthropic"
    } else if endpoint.starts_with("/v1/chat/completions") {
        "openai_chat"
    } else if endpoint.starts_with("/v1beta/models/") && endpoint.ends_with("/generateContent") {
        "gemini"
    } else {
        "responses"
    }
}

fn deterministic_sample_from_metadata(metadata: &Value) -> u64 {
    metadata
        .get("deterministicSample")
        .or_else(|| metadata.get("deterministic_sample"))
        .and_then(Value::as_u64)
        .unwrap_or(0)
}

fn format_candidate_key(candidate: &V3TargetCandidate) -> String {
    format!(
        "{}:{}:{}",
        candidate.provider_id, candidate.auth_alias, candidate.model_id
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use routecodex_v3_config::{compile_v3_config_05_manifest, parse_v3_config_02_authoring};
    use routecodex_v3_provider_responses::{
        V3ProviderAllAvailable, V3ProviderAvailabilityProjection,
    };

    #[test]
    fn virtual_router_status_projects_route_group_pools_and_forwarders() {
        let authoring = parse_v3_config_02_authoring(
            r#"
version = 3
[servers.a]
bind = "127.0.0.1"
port = 5555
routing_group = "gateway"
endpoints = ["responses"]
[providers.test]
type = "responses"
base_url = "http://127.0.0.1:9/v1"
default_model = "test"
auth = { type = "api_key", entries = [{ alias = "key1", env = "TEST_KEY" }] }
[providers.test.models.test]
wire_name = "wire-test"
capabilities = ["text"]
[forwarders.fwd]
model = "test"
targets = [{ kind = "provider_model", provider = "test", model = "test", key = "key1", priority = 1 }]
[route_groups.gateway.pools.gate]
selection = { strategy = "priority" }
match = { precedence = 1, models = ["test"] }
targets = [{ kind = "forwarder", id = "fwd", priority = 1 }]
[route_groups.gateway.pools.default]
selection = { strategy = "priority" }
targets = [{ kind = "provider_model", provider = "test", model = "test", key = "key1", priority = 1 }]
"#,
        )
        .expect("config");
        let manifest = compile_v3_config_05_manifest(authoring).expect("manifest");
        let status =
            project_v3_virtual_router_status(&manifest, "a", &V3ProviderAllAvailable, 1_000)
                .expect("status");
        assert_eq!(
            status["routes"]["gateway"]["pools"][0]["routeName"],
            "gateway"
        );
        assert!(status["routes"]["gateway"]["providers"]
            .as_array()
            .expect("providers")
            .contains(&Value::String("test.key1.test".to_string())));
        assert_eq!(status["forwarders"][0]["forwarderId"], "fwd");
    }

    #[test]
    fn virtual_router_status_projects_process_local_health_and_fresh_availability_recovery() {
        let authoring = parse_v3_config_02_authoring(
            r#"
version = 3
[servers.a]
bind = "127.0.0.1"
port = 5555
routing_group = "gateway"
endpoints = ["responses"]
[providers.test]
type = "responses"
base_url = "http://127.0.0.1:9/v1"
default_model = "test"
auth = { type = "api_key", entries = [{ alias = "key1", env = "TEST_KEY" }] }
[providers.test.models.test]
wire_name = "wire-test"
capabilities = ["text"]
[route_groups.gateway.pools.default]
selection = { strategy = "priority" }
targets = [{ kind = "provider_model", provider = "test", model = "test", key = "key1", priority = 1 }]
"#,
        )
        .expect("config");
        let manifest = compile_v3_config_05_manifest(authoring).expect("manifest");
        let cooled_availability = CooledAvailability { until_ms: 903_000 };

        let cooled = project_v3_virtual_router_status(&manifest, "a", &cooled_availability, 3_001)
            .expect("status");
        let default_pool = &cooled["routes"]["gateway"]["pools"][0];
        assert_eq!(default_pool["availableTargets"], json!([]));
        assert_eq!(
            default_pool["unavailableProviders"][0]["providerKey"],
            "test.key1.test"
        );
        assert!(default_pool["unavailableProviders"][0]["reasons"][0]
            .as_str()
            .expect("reason")
            .contains("provider_key:test:key1:test"));
        assert_eq!(cooled["health"]["source"], "process_local_provider_health");

        let recovered =
            project_v3_virtual_router_status(&manifest, "a", &V3ProviderAllAvailable, 3_002)
                .expect("fresh status");
        assert_eq!(
            recovered["routes"]["gateway"]["pools"][0]["availableTargets"][0],
            "test.key1.test"
        );

        let after_cooldown =
            project_v3_virtual_router_status(&manifest, "a", &cooled_availability, 903_000)
                .expect("status");
        assert_eq!(
            after_cooldown["routes"]["gateway"]["pools"][0]["availableTargets"][0],
            "test.key1.test"
        );
    }

    struct CooledAvailability {
        until_ms: u64,
    }

    impl V3ProviderAvailabilityReader for CooledAvailability {
        fn availability(
            &self,
            provider_id: &str,
            auth_alias: Option<&str>,
            model_id: Option<&str>,
            now_ms: u64,
        ) -> V3ProviderAvailabilityProjection {
            let blocked = now_ms < self.until_ms;
            V3ProviderAvailabilityProjection {
                provider_id: provider_id.to_string(),
                auth_alias: auth_alias.map(str::to_string),
                model_id: model_id.map(str::to_string),
                available: !blocked,
                blocked_scopes: blocked
                    .then(|| {
                        format!(
                            "provider_key:{}:{}:{}:controlled status failure",
                            provider_id,
                            auth_alias.unwrap_or("-"),
                            model_id.unwrap_or("-")
                        )
                    })
                    .into_iter()
                    .collect(),
            }
        }
    }

    #[test]
    fn virtual_router_dry_run_projects_selected_provider_without_network_or_metadata_leak() {
        let authoring = parse_v3_config_02_authoring(
            r#"
version = 3
[servers.a]
bind = "127.0.0.1"
port = 5555
routing_group = "gateway"
endpoints = ["responses"]
[providers.test]
type = "responses"
base_url = "http://127.0.0.1:9/v1"
default_model = "test"
auth = { type = "api_key", entries = [{ alias = "key1", env = "TEST_KEY" }] }
[providers.test.models.test]
[route_groups.gateway.pools.default]
selection = { strategy = "priority" }
targets = [{ kind = "provider_model", provider = "test", model = "test", key = "key1", priority = 1 }]
"#,
        )
        .expect("config");
        let manifest = compile_v3_config_05_manifest(authoring).expect("manifest");
        let input = json!({
            "request": {
                "model": "test",
                "input": "diagnostics sample",
                "stream": true
            },
            "metadata": {
                "requestId": "diag-1",
                "entryEndpoint": "/v1/responses",
                "providerKey": "must-not-become-provider-payload"
            }
        });
        let output = project_v3_virtual_router_dry_run(
            &manifest,
            "a",
            &input,
            &V3ProviderAllAvailable,
            1_000,
        )
        .expect("dry-run");
        assert_eq!(output["ok"], true);
        assert_eq!(output["decision"]["selectedProviderKey"], "test:key1:test");
        assert_eq!(output["decision"]["selectedPoolId"], "default");
        assert_eq!(output["diagnosticInput"]["metadataRequestId"], "diag-1");
        assert!(!serde_json::to_string(&output)
            .expect("serialized diagnostics")
            .contains("must-not-become-provider-payload"));
    }
}
