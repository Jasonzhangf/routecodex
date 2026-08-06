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

pub const V3_DEFAULT_HTTP_SSE_KEEPALIVE_MS: u64 = 3_000;

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

pub fn resolve_v3_http_sse_keepalive_ms(
    routecodex_value: Option<&str>,
    legacy_value: Option<&str>,
) -> Result<u64, V3ConfigError> {
    if legacy_value.is_some() {
        return Err(validation(
            "RCC_HTTP_SSE_KEEPALIVE_MS is not supported; use ROUTECODEX_HTTP_SSE_KEEPALIVE_MS",
        ));
    }

    fn parse(value: &str) -> Result<u64, V3ConfigError> {
        let trimmed = value.trim();
        let parsed = trimmed.parse::<u64>().map_err(|_| {
            validation(
                "ROUTECODEX_HTTP_SSE_KEEPALIVE_MS must be a positive integer number of milliseconds",
            )
        })?;
        if parsed == 0 {
            return Err(validation(
                "ROUTECODEX_HTTP_SSE_KEEPALIVE_MS must be a positive integer number of milliseconds",
            ));
        }
        Ok(parsed)
    }

    match routecodex_value {
        Some(value) => parse(value),
        None => Ok(V3_DEFAULT_HTTP_SSE_KEEPALIVE_MS),
    }
}

pub(crate) fn compile_v3_http_sse_keepalive_ms_from_environment() -> Result<u64, V3ConfigError> {
    fn read(name: &str) -> Result<Option<String>, V3ConfigError> {
        std::env::var_os(name)
            .map(|value| {
                value.into_string().map_err(|_| {
                    validation(format!(
                        "{name} must contain valid UTF-8 positive integer milliseconds"
                    ))
                })
            })
            .transpose()
    }

    let routecodex_value = read("ROUTECODEX_HTTP_SSE_KEEPALIVE_MS")?;
    let legacy_value = read("RCC_HTTP_SSE_KEEPALIVE_MS")?;
    resolve_v3_http_sse_keepalive_ms(routecodex_value.as_deref(), legacy_value.as_deref())
}

#[cfg(test)]
mod http_sse_keepalive_environment_tests {
    use super::*;
    use std::ffi::OsString;
    use std::sync::Mutex;

    static ENVIRONMENT_LOCK: Mutex<()> = Mutex::new(());
    const PRIMARY: &str = "ROUTECODEX_HTTP_SSE_KEEPALIVE_MS";
    const LEGACY: &str = "RCC_HTTP_SSE_KEEPALIVE_MS";

    struct EnvironmentRestore {
        primary: Option<OsString>,
        legacy: Option<OsString>,
    }

    impl EnvironmentRestore {
        fn capture() -> Self {
            Self {
                primary: std::env::var_os(PRIMARY),
                legacy: std::env::var_os(LEGACY),
            }
        }
    }

    impl Drop for EnvironmentRestore {
        fn drop(&mut self) {
            match self.primary.take() {
                Some(value) => std::env::set_var(PRIMARY, value),
                None => std::env::remove_var(PRIMARY),
            }
            match self.legacy.take() {
                Some(value) => std::env::set_var(LEGACY, value),
                None => std::env::remove_var(LEGACY),
            }
        }
    }

    #[test]
    fn http_sse_keepalive_environment_compiler_rejects_invalid_primary() {
        let _lock = ENVIRONMENT_LOCK.lock().unwrap();
        let _restore = EnvironmentRestore::capture();
        std::env::set_var(PRIMARY, "invalid");
        std::env::remove_var(LEGACY);

        let error = compile_v3_http_sse_keepalive_ms_from_environment().unwrap_err();
        assert!(error.to_string().contains(PRIMARY), "{error}");
    }

    #[test]
    fn http_sse_keepalive_environment_compiler_rejects_legacy_variable() {
        let _lock = ENVIRONMENT_LOCK.lock().unwrap();
        let _restore = EnvironmentRestore::capture();
        std::env::set_var(PRIMARY, "25");
        std::env::set_var(LEGACY, "25");

        let error = compile_v3_http_sse_keepalive_ms_from_environment().unwrap_err();
        assert!(error.to_string().contains("not supported"), "{error}");
    }

    #[cfg(unix)]
    #[test]
    fn http_sse_keepalive_environment_compiler_rejects_non_utf8_values() {
        use std::os::unix::ffi::OsStringExt;

        let _lock = ENVIRONMENT_LOCK.lock().unwrap();
        let _restore = EnvironmentRestore::capture();
        std::env::set_var(PRIMARY, OsString::from_vec(vec![0xff]));
        std::env::remove_var(LEGACY);

        let error = compile_v3_http_sse_keepalive_ms_from_environment().unwrap_err();
        assert!(error.to_string().contains("valid UTF-8"), "{error}");
    }
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

pub fn resolve_routecodex_package_version_from_executable(_executable: &Path) -> Option<String> {
    let embedded = option_env!("ROUTECODEX_BUILD_VERSION")
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .expect("ROUTECODEX_BUILD_VERSION must be embedded at compile time");
    Some(embedded.to_string())
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
