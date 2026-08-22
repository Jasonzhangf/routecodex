// Forwarder-cycle / client-alias relation validation, split from validate.rs
// to satisfy verify:v3-file-size. Semantics unchanged; only call sites were
// prefixed with `validate_relations::`.

use super::{validation, V3ConfigError};
use crate::types::*;
use std::collections::{BTreeMap, BTreeSet};

pub(super) fn validate_forwarder_cycles(
    forwarders: &BTreeMap<String, V3ForwarderManifest>,
) -> Result<(), V3ConfigError> {
    fn visit(
        id: &str,
        forwarders: &BTreeMap<String, V3ForwarderManifest>,
        visiting: &mut BTreeSet<String>,
        visited: &mut BTreeSet<String>,
    ) -> Result<(), V3ConfigError> {
        if visited.contains(id) {
            return Ok(());
        }
        if !visiting.insert(id.to_string()) {
            return Err(validation(format!(
                "forwarder target graph contains cycle at {id}"
            )));
        }
        for child in forwarders[id]
            .targets
            .iter()
            .filter(|target| target.kind == V3RouteTargetKind::Forwarder)
            .filter_map(|target| target.id.as_deref())
        {
            visit(child, forwarders, visiting, visited)?;
        }
        visiting.remove(id);
        visited.insert(id.to_string());
        Ok(())
    }
    let mut visiting = BTreeSet::new();
    let mut visited = BTreeSet::new();
    for id in forwarders.keys() {
        visit(id, forwarders, &mut visiting, &mut visited)?;
    }
    Ok(())
}

pub(super) fn validate_client_aliases(
    providers: &BTreeMap<String, V3ProviderManifest>,
    forwarders: &BTreeMap<String, V3ForwarderManifest>,
) -> Result<(), V3ConfigError> {
    fn register(
        names: &mut BTreeMap<String, String>,
        name: &str,
        canonical: &str,
    ) -> Result<(), V3ConfigError> {
        if let Some(existing) = names.get(name) {
            if existing != canonical {
                return Err(validation(format!(
                    "ambiguous client alias {name} maps to both {existing} and {canonical}"
                )));
            }
        } else {
            names.insert(name.to_string(), canonical.to_string());
        }
        Ok(())
    }

    let mut names = BTreeMap::new();
    for provider in providers.values() {
        for model in provider.models.values() {
            register(&mut names, &model.id, &model.id)?;
            for alias in &model.aliases {
                register(&mut names, alias, &model.id)?;
            }
        }
    }
    for forwarder in forwarders.values() {
        register(&mut names, &forwarder.model, &forwarder.model)?;
        for alias in &forwarder.aliases {
            register(&mut names, alias, &forwarder.model)?;
        }
    }
    Ok(())
}
