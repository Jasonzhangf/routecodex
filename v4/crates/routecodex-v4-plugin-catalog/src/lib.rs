//! V4 PluginCatalog — the immutable registry of verified plugin descriptors
//! and artifact identities. The catalog only records and resolves; it never
//! executes plugins and its snapshot can never be a business request input.

use std::collections::{HashMap, VecDeque};

use routecodex_v4_plugin_contract::DependencySpec;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CatalogEntry {
    pub plugin_id: String,
    pub version: String,
    pub owner: String,
    pub artifact_hash: String,
    pub contract_hash: String,
    pub supported_node_roles: Vec<String>,
    pub services_provided: Vec<String>,
    pub services_injected: Vec<String>,
    pub resources_read: Vec<String>,
    pub resources_written: Vec<String>,
    pub required_tests: Vec<String>,
    #[serde(default)]
    pub depends_on: Vec<DependencySpec>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedDependency {
    pub plugin_id: String,
    pub version: String,
    pub dependency_of: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CatalogError {
    DuplicateConflict {
        plugin_id: String,
        version: String,
    },
    OwnerConflict {
        plugin_id: String,
        owner: String,
        existing_owner: String,
    },
    ArtifactHashMismatch {
        plugin_id: String,
        version: String,
    },
    ContractHashMismatch {
        plugin_id: String,
        version: String,
    },
    MissingDependency {
        plugin_id: String,
        dependency: String,
    },
    UnsatisfiedVersion {
        plugin_id: String,
        dependency: String,
        requirement: String,
        found: String,
    },
    DependencyCycle {
        plugin_id: String,
        dependency: String,
    },
    SnapshotReadOnly,
}

impl std::fmt::Display for CatalogError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::DuplicateConflict {
                plugin_id,
                version,
            } => write!(
                formatter,
                "catalog conflict for {plugin_id}@{version}: identity fields differ"
            ),
            Self::OwnerConflict {
                plugin_id,
                owner,
                existing_owner,
            } => write!(
                formatter,
                "plugin {plugin_id} owned by {owner} conflicts with existing owner {existing_owner}"
            ),
            Self::ArtifactHashMismatch {
                plugin_id,
                version,
            } => write!(
                formatter,
                "{plugin_id}@{version}: artifact hash does not match registered bytes"
            ),
            Self::ContractHashMismatch {
                plugin_id,
                version,
            } => write!(
                formatter,
                "{plugin_id}@{version}: contract hash does not match registered contract"
            ),
            Self::MissingDependency {
                plugin_id,
                dependency,
            } => write!(formatter, "plugin {plugin_id} missing dependency {dependency}"),
            Self::UnsatisfiedVersion {
                plugin_id,
                dependency,
                requirement,
                found,
            } => write!(
                formatter,
                "plugin {plugin_id} dependency {dependency} requires {requirement}, found {found}"
            ),
            Self::DependencyCycle {
                plugin_id,
                dependency,
            } => write!(formatter, "dependency cycle {plugin_id} <-> {dependency}"),
            Self::SnapshotReadOnly => write!(formatter, "catalog snapshot is read-only"),
        }
    }
}

impl std::error::Error for CatalogError {}

fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn version_satisfies(found: &str, requirement: &str) -> bool {
    let requirement = requirement.trim();
    if let Some(min) = requirement.strip_prefix(">=") {
        compare_versions(found, min.trim()).is_ge()
    } else if let Some(min) = requirement.strip_prefix(">") {
        compare_versions(found, min.trim()).is_gt()
    } else {
        found == requirement
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum VersionOrder {
    Lt,
    Eq,
    Gt,
}

impl VersionOrder {
    fn is_ge(self) -> bool {
        matches!(self, VersionOrder::Eq | VersionOrder::Gt)
    }

    fn is_gt(self) -> bool {
        matches!(self, VersionOrder::Gt)
    }
}

fn compare_versions(left: &str, right: &str) -> VersionOrder {
    let parse = |value: &str| -> Vec<u32> {
        value
            .split(|ch: char| !ch.is_ascii_digit())
            .filter_map(|part| part.parse::<u32>().ok())
            .collect()
    };
    let l = parse(left);
    let r = parse(right);
    for (a, b) in l.iter().zip(r.iter()) {
        if a < b {
            return VersionOrder::Lt;
        }
        if a > b {
            return VersionOrder::Gt;
        }
    }
    match l.len().cmp(&r.len()) {
        std::cmp::Ordering::Less => VersionOrder::Lt,
        std::cmp::Ordering::Greater => VersionOrder::Gt,
        std::cmp::Ordering::Equal => VersionOrder::Eq,
    }
}

/// Immutable catalog snapshot. Cannot be mutated and is never a business
/// request input.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CatalogSnapshot {
    entries: Vec<CatalogEntry>,
}

impl CatalogSnapshot {
    pub fn entries(&self) -> &[CatalogEntry] {
        &self.entries
    }
}

#[derive(Debug, Clone, Default)]
pub struct PluginCatalog {
    entries: Vec<CatalogEntry>,
    by_identity: HashMap<(String, String), usize>,
    owner_by_id: HashMap<String, String>,
}

impl PluginCatalog {
    pub fn new() -> Self {
        Self::default()
    }

    /// Register a verified plugin entry. Idempotent when the full identity
    /// (plugin_id + version + artifact_hash + contract_hash) matches; any
    /// identity-field difference is a conflict. Owner is unique per plugin_id.
    /// Artifact and contract digests must match the provided bytes.
    pub fn register(
        &mut self,
        entry: CatalogEntry,
        artifact_bytes: &[u8],
        contract_bytes: &[u8],
    ) -> Result<(), CatalogError> {
        if sha256_hex(artifact_bytes) != entry.artifact_hash {
            return Err(CatalogError::ArtifactHashMismatch {
                plugin_id: entry.plugin_id.clone(),
                version: entry.version.clone(),
            });
        }
        if sha256_hex(contract_bytes) != entry.contract_hash {
            return Err(CatalogError::ContractHashMismatch {
                plugin_id: entry.plugin_id.clone(),
                version: entry.version.clone(),
            });
        }
        let key = (entry.plugin_id.clone(), entry.version.clone());
        if let Some(&index) = self.by_identity.get(&key) {
            let existing = &self.entries[index];
            let same_identity = existing.artifact_hash == entry.artifact_hash
                && existing.contract_hash == entry.contract_hash
                && existing.owner == entry.owner;
            if !same_identity {
                return Err(CatalogError::DuplicateConflict {
                    plugin_id: entry.plugin_id.clone(),
                    version: entry.version.clone(),
                });
            }
            return Ok(());
        }
        if let Some(existing_owner) = self.owner_by_id.get(&entry.plugin_id) {
            if existing_owner != &entry.owner {
                return Err(CatalogError::OwnerConflict {
                    plugin_id: entry.plugin_id.clone(),
                    owner: entry.owner.clone(),
                    existing_owner: existing_owner.clone(),
                });
            }
        }
        self.owner_by_id
            .insert(entry.plugin_id.clone(), entry.owner.clone());
        self.by_identity.insert(key, self.entries.len());
        self.entries.push(entry);
        Ok(())
    }

    /// Immutable snapshot view. The snapshot is read-only by construction.
    pub fn snapshot(&self) -> CatalogSnapshot {
        CatalogSnapshot {
            entries: self.entries.clone(),
        }
    }

    /// Resolve every declared dependency inside the catalog. Missing
    /// dependencies, unsatisfied versions and dependency cycles fail.
    pub fn resolve_dependencies(&self) -> Result<Vec<ResolvedDependency>, CatalogError> {
        let by_id: HashMap<&str, &CatalogEntry> = self
            .entries
            .iter()
            .map(|entry| (entry.plugin_id.as_str(), entry))
            .collect();
        let mut resolved = Vec::new();
        for entry in &self.entries {
            for dependency in &entry.depends_on {
                let target = by_id.get(dependency.plugin_id.as_str()).ok_or_else(|| {
                    CatalogError::MissingDependency {
                        plugin_id: entry.plugin_id.clone(),
                        dependency: dependency.plugin_id.clone(),
                    }
                })?;
                if !version_satisfies(&target.version, &dependency.version_req) {
                    return Err(CatalogError::UnsatisfiedVersion {
                        plugin_id: entry.plugin_id.clone(),
                        dependency: dependency.plugin_id.clone(),
                        requirement: dependency.version_req.clone(),
                        found: target.version.clone(),
                    });
                }
                resolved.push(ResolvedDependency {
                    plugin_id: dependency.plugin_id.clone(),
                    version: target.version.clone(),
                    dependency_of: entry.plugin_id.clone(),
                });
            }
        }
        self.check_dependency_cycles()?;
        Ok(resolved)
    }

    fn check_dependency_cycles(&self) -> Result<(), CatalogError> {
        let mut adjacency: HashMap<&str, Vec<&str>> = HashMap::new();
        for entry in &self.entries {
            adjacency.insert(entry.plugin_id.as_str(), Vec::new());
        }
        for entry in &self.entries {
            for dependency in &entry.depends_on {
                if adjacency.contains_key(dependency.plugin_id.as_str()) {
                    adjacency
                        .get_mut(entry.plugin_id.as_str())
                        .expect("entry exists")
                        .push(dependency.plugin_id.as_str());
                }
            }
        }
        let mut in_degree: HashMap<&str, usize> = adjacency
            .keys()
            .map(|id| (*id, 0usize))
            .collect();
        for targets in adjacency.values() {
            for target in targets {
                *in_degree.get_mut(target).expect("target tracked") += 1;
            }
        }
        let mut queue: VecDeque<&str> = in_degree
            .iter()
            .filter(|(_, degree)| **degree == 0)
            .map(|(id, _)| *id)
            .collect();
        let mut visited = 0usize;
        while let Some(id) = queue.pop_front() {
            visited += 1;
            for target in &adjacency[id] {
                let degree = in_degree.get_mut(target).expect("target tracked");
                *degree -= 1;
                if *degree == 0 {
                    queue.push_back(target);
                }
            }
        }
        if visited != adjacency.len() {
            let remaining: Vec<&str> = in_degree
                .iter()
                .filter(|(_, degree)| **degree > 0)
                .map(|(id, _)| *id)
                .collect();
            let cycle_start = remaining.first().copied().unwrap_or("?");
            let target = adjacency
                .get(cycle_start)
                .and_then(|targets| targets.first())
                .copied()
                .unwrap_or("?");
            return Err(CatalogError::DependencyCycle {
                plugin_id: cycle_start.to_string(),
                dependency: target.to_string(),
            });
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(plugin_id: &str, version: &str, artifact: &str, contract: &str) -> CatalogEntry {
        CatalogEntry {
            plugin_id: plugin_id.to_string(),
            version: version.to_string(),
            owner: "routecodex-v4-plugin-catalog".to_string(),
            artifact_hash: artifact.to_string(),
            contract_hash: contract.to_string(),
            supported_node_roles: vec!["request_chat_process".to_string()],
            services_provided: vec![],
            services_injected: vec![],
            resources_read: vec![],
            resources_written: vec![],
            required_tests: vec!["catalog-l2".to_string()],
            depends_on: vec![],
        }
    }

    fn bytes_for(value: &str) -> Vec<u8> {
        value.as_bytes().to_vec()
    }

    #[test]
    fn idempotent_registration_passes() {
        let artifact = bytes_for("artifact-a");
        let contract = bytes_for("contract-a");
        let artifact_hash = sha256_hex(&artifact);
        let contract_hash = sha256_hex(&contract);
        let mut catalog = PluginCatalog::new();
        let first = entry("v4.request.tool", "0.1.0", &artifact_hash, &contract_hash);
        let second = entry("v4.request.tool", "0.1.0", &artifact_hash, &contract_hash);
        catalog.register(first, &artifact, &contract).unwrap();
        catalog.register(second, &artifact, &contract).unwrap();
        assert_eq!(catalog.snapshot().entries().len(), 1);
    }

    #[test]
    fn identity_conflict_is_rejected() {
        let artifact = bytes_for("artifact-a");
        let contract = bytes_for("contract-a");
        let artifact_hash = sha256_hex(&artifact);
        let contract_hash = sha256_hex(&contract);
        let mut catalog = PluginCatalog::new();
        catalog
            .register(
                entry("v4.request.tool", "0.1.0", &artifact_hash, &contract_hash),
                &artifact,
                &contract,
            )
            .unwrap();
        let other_contract = bytes_for("contract-b");
        let error = catalog
            .register(
                entry(
                    "v4.request.tool",
                    "0.1.0",
                    &artifact_hash,
                    &sha256_hex(&other_contract),
                ),
                &artifact,
                &other_contract,
            )
            .unwrap_err();
        assert!(matches!(error, CatalogError::DuplicateConflict { .. }));
    }

    #[test]
    fn owner_conflict_is_rejected() {
        let artifact = bytes_for("artifact-a");
        let contract = bytes_for("contract-a");
        let artifact_hash = sha256_hex(&artifact);
        let contract_hash = sha256_hex(&contract);
        let mut catalog = PluginCatalog::new();
        catalog
            .register(
                entry("v4.request.tool", "0.1.0", &artifact_hash, &contract_hash),
                &artifact,
                &contract,
            )
            .unwrap();
        let mut other = entry("v4.request.tool", "0.2.0", &artifact_hash, &contract_hash);
        other.owner = "another-owner".to_string();
        let error = catalog.register(other, &artifact, &contract).unwrap_err();
        assert!(matches!(error, CatalogError::OwnerConflict { .. }));
    }

    #[test]
    fn artifact_hash_mismatch_is_rejected() {
        let artifact = bytes_for("artifact-a");
        let contract = bytes_for("contract-a");
        let contract_hash = sha256_hex(&contract);
        let mut catalog = PluginCatalog::new();
        let error = catalog
            .register(
                entry("v4.request.tool", "0.1.0", "bad", &contract_hash),
                &artifact,
                &contract,
            )
            .unwrap_err();
        assert!(matches!(error, CatalogError::ArtifactHashMismatch { .. }));
    }

    #[test]
    fn contract_hash_mismatch_is_rejected() {
        let artifact = bytes_for("artifact-a");
        let contract = bytes_for("contract-a");
        let artifact_hash = sha256_hex(&artifact);
        let mut catalog = PluginCatalog::new();
        let error = catalog
            .register(
                entry("v4.request.tool", "0.1.0", &artifact_hash, "bad"),
                &artifact,
                &contract,
            )
            .unwrap_err();
        assert!(matches!(error, CatalogError::ContractHashMismatch { .. }));
    }

    #[test]
    fn missing_dependency_is_rejected() {
        let artifact = bytes_for("artifact-a");
        let contract = bytes_for("contract-a");
        let artifact_hash = sha256_hex(&artifact);
        let contract_hash = sha256_hex(&contract);
        let mut catalog = PluginCatalog::new();
        let mut dependent = entry("v4.request.dependent", "0.1.0", &artifact_hash, &contract_hash);
        dependent.depends_on = vec![DependencySpec {
            plugin_id: "v4.request.missing".to_string(),
            version_req: "0.1.0".to_string(),
        }];
        catalog
            .register(dependent, &artifact, &contract)
            .unwrap();
        let error = catalog.resolve_dependencies().unwrap_err();
        assert!(matches!(error, CatalogError::MissingDependency { .. }));
    }

    #[test]
    fn unsatisfied_version_is_rejected() {
        let artifact = bytes_for("artifact-a");
        let contract = bytes_for("contract-a");
        let artifact_hash = sha256_hex(&artifact);
        let contract_hash = sha256_hex(&contract);
        let mut catalog = PluginCatalog::new();
        catalog
            .register(
                entry("v4.request.provider", "0.1.0", &artifact_hash, &contract_hash),
                &artifact,
                &contract,
            )
            .unwrap();
        let mut dependent = entry("v4.request.dependent", "0.1.0", &artifact_hash, &contract_hash);
        dependent.depends_on = vec![DependencySpec {
            plugin_id: "v4.request.provider".to_string(),
            version_req: ">=0.2.0".to_string(),
        }];
        catalog
            .register(dependent, &artifact, &contract)
            .unwrap();
        let error = catalog.resolve_dependencies().unwrap_err();
        assert!(matches!(error, CatalogError::UnsatisfiedVersion { .. }));
    }

    #[test]
    fn dependency_cycle_is_rejected() {
        let artifact = bytes_for("artifact-a");
        let contract = bytes_for("contract-a");
        let artifact_hash = sha256_hex(&artifact);
        let contract_hash = sha256_hex(&contract);
        let mut catalog = PluginCatalog::new();
        let mut a = entry("v4.request.a", "0.1.0", &artifact_hash, &contract_hash);
        a.depends_on = vec![DependencySpec {
            plugin_id: "v4.request.b".to_string(),
            version_req: "0.1.0".to_string(),
        }];
        let mut b = entry("v4.request.b", "0.1.0", &artifact_hash, &contract_hash);
        b.depends_on = vec![DependencySpec {
            plugin_id: "v4.request.a".to_string(),
            version_req: "0.1.0".to_string(),
        }];
        catalog.register(a, &artifact, &contract).unwrap();
        catalog.register(b, &artifact, &contract).unwrap();
        let error = catalog.resolve_dependencies().unwrap_err();
        assert!(matches!(error, CatalogError::DependencyCycle { .. }));
    }

    #[test]
    fn snapshot_is_immutable() {
        let artifact = bytes_for("artifact-a");
        let contract = bytes_for("contract-a");
        let artifact_hash = sha256_hex(&artifact);
        let contract_hash = sha256_hex(&contract);
        let mut catalog = PluginCatalog::new();
        catalog
            .register(
                entry("v4.request.tool", "0.1.0", &artifact_hash, &contract_hash),
                &artifact,
                &contract,
            )
            .unwrap();
        let snapshot = catalog.snapshot();
        catalog
            .register(
                entry("v4.request.tool2", "0.1.0", &artifact_hash, &contract_hash),
                &artifact,
                &contract,
            )
            .unwrap();
        assert_eq!(snapshot.entries().len(), 1);
    }

    #[test]
    fn version_requirement_ge_satisfied() {
        assert!(version_satisfies("0.2.0", ">=0.1.0"));
        assert!(version_satisfies("0.1.0", ">=0.1.0"));
        assert!(!version_satisfies("0.0.9", ">=0.1.0"));
    }
}
