// feature_id: v3.provider_directory_config_compat
use crate::{validation, V3Config02AuthoringParsed, V3ConfigError};
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

pub(crate) struct V3ProviderDirectorySource {
    pub provider_id: String,
    pub canonical_path: PathBuf,
    pub raw_toml: String,
}

pub(crate) struct V3Config02AuthoringResolved {
    pub authoring: V3Config02AuthoringParsed,
    pub provider_sources: Vec<V3ProviderDirectorySource>,
}

pub(crate) fn resolve_v3_provider_directory_from_authoring(
    config_path: &Path,
    mut authoring: V3Config02AuthoringParsed,
) -> Result<V3Config02AuthoringResolved, V3ConfigError> {
    let referenced_models = collect_referenced_provider_models(&authoring);
    if !authoring.providers.is_empty() {
        let missing = referenced_models
            .keys()
            .filter(|provider_id| !authoring.providers.contains_key(*provider_id))
            .cloned()
            .collect::<Vec<_>>();
        if !missing.is_empty() {
            return Err(validation(format!(
                "native v3 config cannot mix inline providers with provider directory sources; missing inline providers: {}",
                missing.join(", ")
            )));
        }
        return Ok(V3Config02AuthoringResolved {
            authoring,
            provider_sources: Vec::new(),
        });
    }

    let config_dir = config_path.parent().ok_or_else(|| {
        validation(format!(
            "v3 config path {} has no parent directory",
            config_path.display()
        ))
    })?;
    let (providers, provider_sources) =
        crate::v2_compat::compile_v2_provider_directory(config_dir, &referenced_models)?;
    authoring.providers = providers;
    Ok(V3Config02AuthoringResolved {
        authoring,
        provider_sources,
    })
}

pub(crate) fn collect_referenced_provider_models(
    authoring: &V3Config02AuthoringParsed,
) -> BTreeMap<String, BTreeSet<String>> {
    let mut referenced = BTreeMap::<String, BTreeSet<String>>::new();
    for forwarder in authoring.forwarders.values() {
        for target in &forwarder.targets {
            collect_target_reference(
                &mut referenced,
                target.provider.as_deref(),
                target.model.as_deref(),
            );
        }
    }
    for group in authoring.route_groups.values() {
        for pool in group.pools.values() {
            for target in &pool.targets {
                collect_target_reference(
                    &mut referenced,
                    target.provider.as_deref(),
                    target.model.as_deref(),
                );
            }
        }
    }
    referenced
}

fn collect_target_reference(
    referenced: &mut BTreeMap<String, BTreeSet<String>>,
    provider: Option<&str>,
    model: Option<&str>,
) {
    let Some(provider) = provider.map(str::trim).filter(|value| !value.is_empty()) else {
        return;
    };
    let models = referenced.entry(provider.to_string()).or_default();
    if let Some(model) = model.map(str::trim).filter(|value| !value.is_empty()) {
        models.insert(model.to_string());
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{parse_v3_config_02_authoring, V3RouteTargetKind};

    #[test]
    fn collects_forwarder_and_direct_pool_provider_references() {
        let authoring = parse_v3_config_02_authoring(
            r#"version = 3
[servers.primary]
bind = "127.0.0.1"
port = 4000
routing_group = "primary"
endpoints = ["responses"]
[forwarders.one]
model = "client"
targets = [{ kind = "provider_model", provider = "from-forwarder", model = "m1" }]
[route_groups.primary.pools.default]
targets = [{ kind = "provider_model", provider = "from-pool", model = "m2" }]
"#,
        )
        .unwrap();
        assert_eq!(
            authoring.forwarders["one"].targets[0].kind,
            V3RouteTargetKind::ProviderModel
        );
        let referenced = collect_referenced_provider_models(&authoring);
        assert_eq!(referenced["from-forwarder"], ["m1".to_string()].into());
        assert_eq!(referenced["from-pool"], ["m2".to_string()].into());
    }
}
