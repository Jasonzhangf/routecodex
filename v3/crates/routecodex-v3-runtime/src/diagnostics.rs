// feature_id: v3.virtual_router_full_function
use routecodex_v3_config::{
    V3Config05ManifestPublished, V3ForwarderManifest, V3ForwarderTargetManifest,
    V3RoutePoolManifest, V3RoutePoolTargetManifest, V3RouteTargetKind,
};
use serde_json::{json, Value};

pub fn project_v3_virtual_router_status(
    manifest: &V3Config05ManifestPublished,
    server_id: &str,
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
        .map(|pool| route_pool_status_snapshot(manifest, &group.id, pool))
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
        "health": {},
        "forwarders": manifest.forwarders.values().map(forwarder_status_snapshot).collect::<Vec<Value>>()
    }))
}

fn route_pool_status_snapshot(
    manifest: &V3Config05ManifestPublished,
    route_name: &str,
    pool: &V3RoutePoolManifest,
) -> Value {
    let resolved_forwarders = pool
        .targets
        .iter()
        .filter_map(|target| target.id.as_ref())
        .filter_map(|id| manifest.forwarders.get(id))
        .map(forwarder_status_snapshot)
        .collect::<Vec<Value>>();
    let configured_targets = pool
        .targets
        .iter()
        .map(route_pool_target_label)
        .collect::<Vec<String>>();
    let resolved_targets = pool
        .targets
        .iter()
        .flat_map(|target| route_target_provider_keys(manifest, target))
        .collect::<Vec<String>>();
    json!({
        "routeName": route_name,
        "poolId": pool.id,
        "poolMode": format!("{:?}", pool.selection.strategy),
        "configuredTargets": configured_targets,
        "resolvedTargets": resolved_targets,
        "resolvedForwarders": resolved_forwarders,
        "availableTargets": resolved_targets,
        "unavailableProviders": [],
        "defaultFloor": pool.id == "default" && !pool.targets.is_empty()
    })
}

fn forwarder_status_snapshot(forwarder: &V3ForwarderManifest) -> Value {
    let targets = forwarder
        .targets
        .iter()
        .map(forwarder_target_status_snapshot)
        .collect::<Vec<Value>>();
    let target_provider_keys = forwarder
        .targets
        .iter()
        .map(forwarder_target_label)
        .collect::<Vec<String>>();
    json!({
        "forwarderId": forwarder.id,
        "modelId": forwarder.model,
        "strategy": format!("{:?}", forwarder.selection.strategy),
        "targetProviderKeys": target_provider_keys,
        "availableProviderKeys": target_provider_keys,
        "unavailableProviders": [],
        "available": forwarder.enabled && !forwarder.targets.is_empty(),
        "targets": targets
    })
}

fn forwarder_target_status_snapshot(target: &V3ForwarderTargetManifest) -> Value {
    json!({
        "providerKey": forwarder_target_label(target),
        "available": true,
        "reasons": []
    })
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

#[cfg(test)]
mod tests {
    use super::*;
    use routecodex_v3_config::{compile_v3_config_05_manifest, parse_v3_config_02_authoring};

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
        let status = project_v3_virtual_router_status(&manifest, "a").expect("status");
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
}
