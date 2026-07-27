mod defaults;
mod provider_directory;
mod store;
mod types;
mod v2_compat;
mod validate;

pub use store::{default_v3_config_path, V3ConfigLoadedSnapshot, V3ConfigStore, V3ConfigWritePlan};
pub use types::*;

use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

#[derive(Debug, thiserror::Error)]
pub enum V3ConfigError {
    #[error("config io failed: {0}")]
    Io(#[from] std::io::Error),
    #[error("config parse failed: {0}")]
    Parse(#[from] toml::de::Error),
    #[error("config serialization failed: {0}")]
    Serialize(#[from] toml::ser::Error),
    #[error("config validation failed: {0}")]
    Validation(String),
}

pub(crate) fn read_v3_config_01_file_source(
    path: impl AsRef<Path>,
) -> Result<V3Config01FileSource, V3ConfigError> {
    let path = path.as_ref().to_path_buf();
    let raw_toml = std::fs::read_to_string(&path)?;
    Ok(V3Config01FileSource { path, raw_toml })
}

pub fn parse_v3_config_02_authoring(raw: &str) -> Result<V3Config02AuthoringParsed, V3ConfigError> {
    Ok(toml::from_str(raw)?)
}

pub(crate) fn try_compile_v2_config_02_authoring_from_file(
    config_path: impl AsRef<Path>,
    raw: &str,
) -> Result<Option<provider_directory::V3Config02AuthoringResolved>, V3ConfigError> {
    v2_compat::compile_v2_config_02_authoring_from_file(config_path.as_ref(), raw)
}

pub fn validate_v3_config_03_schema_from_v3_config_02(
    authoring: V3Config02AuthoringParsed,
) -> Result<V3Config03SchemaValidated, V3ConfigError> {
    validate::validate_schema(authoring)
}

pub fn build_v3_config_04_resource_registry_from_v3_config_03(
    validated: V3Config03SchemaValidated,
) -> Result<V3Config04ResourceRegistryBuilt, V3ConfigError> {
    validate::build_resource_registry(validated)
}

pub fn publish_v3_config_05_manifest_from_v3_config_04(
    registry: V3Config04ResourceRegistryBuilt,
) -> Result<V3Config05ManifestPublished, V3ConfigError> {
    validate::publish_manifest(registry)
}

pub fn compile_v3_config_05_manifest(
    authoring: V3Config02AuthoringParsed,
) -> Result<V3Config05ManifestPublished, V3ConfigError> {
    publish_v3_config_05_manifest_from_v3_config_04(
        build_v3_config_04_resource_registry_from_v3_config_03(
            validate_v3_config_03_schema_from_v3_config_02(authoring)?,
        )?,
    )
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct V3CatalogModelRef {
    pub visible_id: String,
    pub provider_id: String,
    pub model_id: String,
    pub capabilities: BTreeSet<String>,
}

pub fn collect_v3_route_group_catalog_model_refs(
    manifest: &V3Config05ManifestPublished,
    routing_group: &str,
) -> BTreeMap<String, V3CatalogModelRef> {
    let mut out = BTreeMap::new();
    let Some(group) = manifest.route_groups.get(routing_group) else {
        return out;
    };
    let mut visiting_forwarders = BTreeSet::new();
    for pool in group.pools.values() {
        for target in &pool.targets {
            collect_v3_catalog_model_refs_from_target(
                manifest,
                target,
                None,
                &mut visiting_forwarders,
                &mut out,
            );
        }
    }
    out
}

fn collect_v3_catalog_model_refs_from_target(
    manifest: &V3Config05ManifestPublished,
    target: &V3RoutePoolTargetManifest,
    visible_ids_override: Option<&[String]>,
    visiting_forwarders: &mut BTreeSet<String>,
    out: &mut BTreeMap<String, V3CatalogModelRef>,
) {
    match target.kind {
        V3RouteTargetKind::ProviderModel => {
            let (Some(provider_id), Some(model_id)) =
                (target.provider.as_ref(), target.model.as_ref())
            else {
                return;
            };
            let Some(provider) = manifest.providers.get(provider_id) else {
                return;
            };
            if !provider.enabled {
                return;
            }
            let Some(model) = provider.models.get(model_id) else {
                return;
            };
            let visible_ids = visible_ids_override
                .map(|ids| ids.to_vec())
                .unwrap_or_else(|| v3_model_catalog_visible_ids(&model.id, &model.aliases));
            for visible_id in visible_ids {
                insert_v3_catalog_model_ref(
                    out,
                    visible_id,
                    provider_id.clone(),
                    model_id.clone(),
                    model.capabilities.iter().cloned().collect(),
                );
            }
        }
        V3RouteTargetKind::Forwarder => {
            let Some(forwarder_id) = target.id.as_ref() else {
                return;
            };
            if !visiting_forwarders.insert(forwarder_id.clone()) {
                return;
            }
            if let Some(forwarder) = manifest.forwarders.get(forwarder_id) {
                if forwarder.enabled {
                    let visible_ids =
                        visible_ids_override
                            .map(|ids| ids.to_vec())
                            .unwrap_or_else(|| {
                                v3_model_catalog_visible_ids(&forwarder.model, &forwarder.aliases)
                            });
                    for child in &forwarder.targets {
                        collect_v3_catalog_model_refs_from_forwarder_target(
                            manifest,
                            child,
                            &visible_ids,
                            visiting_forwarders,
                            out,
                        );
                    }
                }
            }
            visiting_forwarders.remove(forwarder_id);
        }
    }
}

fn collect_v3_catalog_model_refs_from_forwarder_target(
    manifest: &V3Config05ManifestPublished,
    target: &V3ForwarderTargetManifest,
    visible_ids: &[String],
    visiting_forwarders: &mut BTreeSet<String>,
    out: &mut BTreeMap<String, V3CatalogModelRef>,
) {
    let route_target = V3RoutePoolTargetManifest {
        kind: target.kind.clone(),
        id: target.id.clone(),
        provider: target.provider.clone(),
        model: target.model.clone(),
        key: target.key.clone(),
        priority: target.priority,
        weight: target.weight,
    };
    collect_v3_catalog_model_refs_from_target(
        manifest,
        &route_target,
        Some(visible_ids),
        visiting_forwarders,
        out,
    );
}

fn v3_model_catalog_visible_ids(model_id: &str, aliases: &[String]) -> Vec<String> {
    if aliases.is_empty() {
        vec![model_id.to_string()]
    } else {
        aliases.to_vec()
    }
}

fn insert_v3_catalog_model_ref(
    out: &mut BTreeMap<String, V3CatalogModelRef>,
    visible_id: String,
    provider_id: String,
    model_id: String,
    capabilities: BTreeSet<String>,
) {
    let visible_id = visible_id.trim().to_string();
    if visible_id.is_empty()
        || is_v3_hidden_codex_future_model(&visible_id)
        || is_v3_hidden_codex_future_model(&model_id)
    {
        return;
    }
    out.entry(visible_id.clone())
        .and_modify(|existing| existing.capabilities.extend(capabilities.iter().cloned()))
        .or_insert(V3CatalogModelRef {
            visible_id,
            provider_id,
            model_id,
            capabilities,
        });
}

fn is_v3_hidden_codex_future_model(model_id: &str) -> bool {
    let trimmed = model_id.trim();
    trimmed == "gpt-5.6" || trimmed.starts_with("gpt-5.6-")
}

pub fn looks_like_secret_literal(value: &str) -> bool {
    let trimmed = value.trim();
    trimmed.starts_with("sk-")
        || trimmed.starts_with("Bearer ")
        || trimmed.contains("api_key=")
        || trimmed.contains("OPENAI_API_KEY=")
        || trimmed.len() > 128
}

pub fn resolve_routecodex_package_version_from_executable(executable: &Path) -> Option<String> {
    std::env::var("ROUTECODEX_VERSION")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .or_else(|| read_nearest_routecodex_package_version(executable))
}

fn read_nearest_routecodex_package_version(executable: &Path) -> Option<String> {
    for ancestor in executable.ancestors() {
        let package_json = ancestor.join("package.json");
        let Ok(raw) = std::fs::read_to_string(package_json) else {
            continue;
        };
        let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&raw) else {
            continue;
        };
        if parsed
            .get("name")
            .and_then(serde_json::Value::as_str)
            .map(|value| value == "routecodex")
            .unwrap_or(false)
        {
            return parsed
                .get("version")
                .and_then(serde_json::Value::as_str)
                .map(str::to_string);
        }
    }
    None
}

pub(crate) fn validation(message: impl Into<String>) -> V3ConfigError {
    V3ConfigError::Validation(message.into())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn compile_catalog_scope_manifest() -> V3Config05ManifestPublished {
        let source = r#"
version = 3

[pipelines.hub_v1]
skeleton = "hub_v1"

[servers.primary]
bind = "127.0.0.1"
port = 4444
routing_group = "primary"
endpoints = ["responses"]

[servers.secondary]
bind = "127.0.0.1"
port = 5555
routing_group = "secondary"
endpoints = ["responses"]

[providers.cc]
type = "responses"
base_url = "https://api.example.com/v1"
default_model = "gpt-5.5"
auth = { type = "api_key", entries = [{ alias = "key", env = "CC_API_KEY" }] }
responses = { process = "chat", streaming = "always" }

[providers.cc.models."gpt-5.5"]
wire_name = "gpt-5.5"
capabilities = ["text", "reasoning", "tools", "web_search", "multimodal"]
supports_streaming = true
supports_thinking = true

[providers.cc.models."gpt-5.6-sol"]
wire_name = "gpt-5.6-sol"
capabilities = ["text", "reasoning", "tools", "web_search", "multimodal"]
supports_streaming = true
supports_thinking = true

[providers.other]
type = "responses"
base_url = "https://api.other.example/v1"
default_model = "other"
auth = { type = "api_key", entries = [{ alias = "key", env = "OTHER_API_KEY" }] }
responses = { process = "chat", streaming = "always" }

[providers.other.models.other]
wire_name = "other-wire"
aliases = ["other-alias"]
capabilities = ["text", "tools"]
supports_streaming = true
supports_thinking = false

[providers.other.models.offroute]
wire_name = "offroute-wire"
aliases = ["offroute-alias"]
capabilities = ["text", "tools", "web_search"]
supports_streaming = true
supports_thinking = false

[forwarders."fwd.primary"]
model = "gpt-5.5"
aliases = ["gpt-5.5"]
selection = { strategy = "priority" }
targets = [
  { kind = "provider_model", provider = "cc", model = "gpt-5.5", key = "key", priority = 1 },
  { kind = "provider_model", provider = "other", model = "other", key = "key", priority = 2 }
]

[forwarders."fwd.secondary"]
model = "other-visible"
aliases = ["other-visible"]
selection = { strategy = "priority" }
targets = [{ kind = "provider_model", provider = "other", model = "other", key = "key", priority = 1 }]

[route_groups.primary.pools.default]
selection = { strategy = "priority" }
targets = [{ kind = "forwarder", id = "fwd.primary", priority = 1 }]

[route_groups.primary.pools.future]
selection = { strategy = "priority" }
match = { precedence = 10, models = ["gpt-5.6-sol"] }
targets = [{ kind = "provider_model", provider = "cc", model = "gpt-5.6-sol", key = "key", priority = 1 }]

[route_groups.secondary.pools.default]
selection = { strategy = "priority" }
targets = [{ kind = "forwarder", id = "fwd.secondary", priority = 1 }]
"#;
        compile_v3_config_05_manifest(parse_v3_config_02_authoring(source).unwrap()).unwrap()
    }

    #[test]
    fn route_group_catalog_refs_expand_forwarders_without_offroute_models() {
        let manifest = compile_catalog_scope_manifest();
        let refs = collect_v3_route_group_catalog_model_refs(&manifest, "primary");

        assert!(refs.contains_key("gpt-5.5"));
        assert_eq!(refs["gpt-5.5"].provider_id, "cc");
        assert_eq!(refs["gpt-5.5"].model_id, "gpt-5.5");
        assert!(refs["gpt-5.5"].capabilities.contains("web_search"));
        assert!(refs["gpt-5.5"].capabilities.contains("multimodal"));
        assert!(!refs.contains_key("other"));
        assert!(!refs.contains_key("other-alias"));
        assert!(!refs.contains_key("offroute-alias"));
        assert!(!refs.contains_key("gpt-5.6-sol"));
    }

    #[test]
    fn route_group_catalog_refs_are_listener_group_scoped() {
        let manifest = compile_catalog_scope_manifest();
        let refs = collect_v3_route_group_catalog_model_refs(&manifest, "secondary");

        assert!(refs.contains_key("other-visible"));
        assert_eq!(refs["other-visible"].provider_id, "other");
        assert_eq!(refs["other-visible"].model_id, "other");
        assert!(!refs.contains_key("gpt-5.5"));
        assert!(!refs.contains_key("offroute-alias"));
        assert!(!refs.contains_key("gpt-5.6-sol"));
    }
}
