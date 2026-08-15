//! Deterministic compiled Active index (`v4/build-control/active-index.json`).
//!
//! The index is derived solely from immutable Active artifacts + freeze
//! records + `rustc -vV`; the resolver re-derives it and compares
//! `manifest_hash` so drift fails fast.

use crate::error::ActiveLinkError;
use crate::identity::{canonical, sha256_hex, ActiveArtifactIdentity};
use crate::resolver::{host_triple, resolve, rustc_version};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

/// Compiled deterministic Active index contract.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ActiveArtifactManifest {
    pub schema_version: u32,
    pub project_id: String,
    pub built_at_commit: String,
    pub rustc_version: String,
    pub host_triple: String,
    pub entries: Vec<ActiveArtifactIdentity>,
    pub manifest_hash: String,
}

impl ActiveArtifactManifest {
    /// Hash of the canonical serialization without `manifest_hash`.
    pub fn recompute_manifest_hash(&self) -> Result<String, ActiveLinkError> {
        let mut value = serde_json::to_value(self)
            .map_err(|e| ActiveLinkError::ManifestInvalid(format!("index serialize: {e}")))?;
        value
            .as_object_mut()
            .ok_or_else(|| ActiveLinkError::ManifestInvalid("index not object".into()))?
            .remove("manifest_hash");
        Ok(sha256_hex(canonical(&value).as_bytes()))
    }

    pub fn validate(&self) -> Result<(), ActiveLinkError> {
        if self.schema_version != 1 {
            return Err(ActiveLinkError::ManifestInvalid(format!(
                "schema_version {} != 1",
                self.schema_version
            )));
        }
        let expected = self.recompute_manifest_hash()?;
        if expected != self.manifest_hash {
            return Err(ActiveLinkError::ManifestInvalid(format!(
                "manifest_hash mismatch: recorded {} != recomputed {}",
                self.manifest_hash, expected
            )));
        }
        Ok(())
    }
}

/// Single owner of the compiled Active index.
pub struct IndexBuilder;

impl IndexBuilder {
    /// Build the index from Active artifacts + freeze records under `root`.
    ///
    /// `built_at_commit` is the VCS commit of the caller (deterministic input;
    /// the CLI derives it from `git rev-parse HEAD` unless overridden).
    pub fn build(
        root: &Path,
        built_at_commit: &str,
    ) -> Result<ActiveArtifactManifest, ActiveLinkError> {
        let project_file = root.join(".appsdk/project.json");
        let project: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&project_file).map_err(|e| {
                ActiveLinkError::ManifestInvalid(format!("read {}: {e}", project_file.display()))
            })?)
            .map_err(|e| ActiveLinkError::ManifestInvalid(format!("parse project.json: {e}")))?;
        let project_id = project
            .get("project_id")
            .and_then(serde_json::Value::as_str)
            .ok_or_else(|| ActiveLinkError::ManifestInvalid("project_id missing".into()))?
            .to_string();

        let rustc_version = rustc_version()?;
        let host_triple = host_triple()?;

        let records_dir = root.join(".appsdk/records");
        let mut modules = Vec::new();
        let entries = fs::read_dir(&records_dir)
            .map_err(|e| {
                ActiveLinkError::StaleOrMissingRecord(format!(
                    "read records dir {}: {e}",
                    records_dir.display()
                ))
            })?
            .filter_map(|entry| entry.ok())
            .filter_map(|entry| {
                let name = entry.file_name().to_string_lossy().into_owned();
                name.strip_prefix("freeze-record-")
                    .and_then(|rest| rest.strip_suffix(".json"))
                    .map(|module_id| (module_id.to_string(), entry.path()))
            })
            .collect::<Vec<_>>();

        let mut sorted = entries;
        sorted.sort_by(|a, b| a.0.cmp(&b.0));
        for (module_id, path) in sorted {
            let freeze: serde_json::Value =
                serde_json::from_str(&fs::read_to_string(&path).map_err(|e| {
                    ActiveLinkError::StaleOrMissingRecord(format!("read {}: {e}", path.display()))
                })?)
                .map_err(|e| {
                    ActiveLinkError::StaleOrMissingRecord(format!(
                        "parse freeze record {}: {e}",
                        path.display()
                    ))
                })?;
            let active_version = freeze
                .get("active_version")
                .and_then(serde_json::Value::as_str)
                .ok_or_else(|| {
                    ActiveLinkError::StaleOrMissingRecord(format!(
                        "freeze record {module_id} missing active_version"
                    ))
                })?;
            let resolution = resolve(root, &module_id, active_version, &host_triple)?;
            modules.push(resolution.identity);
        }

        let mut manifest = ActiveArtifactManifest {
            schema_version: 1,
            project_id,
            built_at_commit: built_at_commit.to_string(),
            rustc_version,
            host_triple,
            entries: modules,
            manifest_hash: String::new(),
        };
        manifest.manifest_hash = manifest.recompute_manifest_hash()?;
        Ok(manifest)
    }

    /// Write the index to `build-control/active-index.json` under `root`.
    /// Writes are only allowed outside the Active zone.
    pub fn write(
        root: &Path,
        manifest: &ActiveArtifactManifest,
    ) -> Result<PathBuf, ActiveLinkError> {
        let output = root.join("build-control/active-index.json");
        crate::resolver::assert_outside_active(root, &output)?;
        let parent = output.parent().ok_or_else(|| {
            ActiveLinkError::LinkFailed("build-control path has no parent".into())
        })?;
        fs::create_dir_all(parent).map_err(|e| {
            ActiveLinkError::LinkFailed(format!("create {}: {e}", parent.display()))
        })?;
        let tmp = parent.join(format!(".active-index.{}.tmp", std::process::id()));
        let text = serde_json::to_string_pretty(manifest)
            .map_err(|e| ActiveLinkError::LinkFailed(format!("serialize index: {e}")))?;
        fs::write(&tmp, text + "\n")
            .map_err(|e| ActiveLinkError::LinkFailed(format!("write {}: {e}", tmp.display())))?;
        fs::rename(&tmp, &output).map_err(|e| {
            ActiveLinkError::LinkFailed(format!(
                "rename {} -> {}: {e}",
                tmp.display(),
                output.display()
            ))
        })?;
        Ok(output)
    }

    /// Re-derive the index and compare `manifest_hash` with the on-disk index.
    pub fn verify(
        root: &Path,
        built_at_commit: &str,
    ) -> Result<ActiveArtifactManifest, ActiveLinkError> {
        let rebuilt = Self::build(root, built_at_commit)?;
        let file = root.join("build-control/active-index.json");
        let disk: ActiveArtifactManifest =
            serde_json::from_str(&fs::read_to_string(&file).map_err(|e| {
                ActiveLinkError::ManifestInvalid(format!("read {}: {e}", file.display()))
            })?)
            .map_err(|e| {
                ActiveLinkError::ManifestInvalid(format!("parse {}: {e}", file.display()))
            })?;
        if disk != rebuilt {
            return Err(ActiveLinkError::ManifestInvalid(format!(
                "index drift: on-disk {} != rebuilt {} ({} entries vs {})",
                disk.manifest_hash,
                rebuilt.manifest_hash,
                disk.entries.len(),
                rebuilt.entries.len()
            )));
        }
        rebuilt.validate()?;
        Ok(rebuilt)
    }
}
