//! Active artifact identity and hashing primitives.
//!
//! Hashing is byte-compatible with the appsdk compiler/verifier (the single
//! Active artifact producer): `public_api_hash` is derived from artifact
//! entries (`path\0hash\0` per entry) and `artifact_hash` is the canonical
//! serialization of the artifact object with `artifact_hash` and `stage`
//! removed.

use crate::error::ActiveLinkError;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::PathBuf;

/// One entry of an Active artifact manifest (`artifacts[]` in artifact.json).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ArtifactEntry {
    pub path: String,
    pub hash: String,
}

/// Immutable identity of one resolved Active artifact.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ActiveArtifactDependency {
    pub module_id: String,
    pub active_version: String,
    pub target_triple: String,
    pub artifact_hash: String,
    pub public_api_hash: String,
    pub source_commit: String,
}

/// Typed identity contract for a resolved Active artifact.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ActiveArtifactIdentity {
    pub module_id: String,
    pub active_version: String,
    pub target_triple: String,
    /// Producer `rustc -vV` release recorded at freeze time. Existing frozen
    /// artifacts predate this field (`None`); once recorded, the resolver
    /// fails fast when the current toolchain release differs.
    pub producer_rustc_version: Option<String>,
    pub artifact_hash: String,
    pub public_api_hash: String,
    pub source_commit: String,
    /// Recursive dependency closure. The design doc names this field
    /// `dependency_closure`; the resolver contract keeps `dependencies`.
    pub dependencies: Vec<ActiveArtifactDependency>,
}

/// Resolved link surface: identity plus concrete rlib paths and rustc flags.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ActiveArtifactResolution {
    pub identity: ActiveArtifactIdentity,
    pub manifest_hash: String,
    pub artifact_root: PathBuf,
    pub rlib_paths: Vec<PathBuf>,
    pub dependency_resolutions: Vec<ActiveArtifactResolution>,
    pub link_flags: Vec<String>,
}

/// sha256 with the `sha256:` prefix used across appsdk records.
pub fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("sha256:{:x}", hasher.finalize())
}

/// Canonical JSON serialization compatible with appsdk `canonical()`:
/// object keys sorted, no whitespace, arrays joined by `,`.
pub fn canonical(value: &serde_json::Value) -> String {
    match value {
        serde_json::Value::Null => "null".into(),
        serde_json::Value::Bool(value) => value.to_string(),
        serde_json::Value::Number(value) => value.to_string(),
        serde_json::Value::String(value) => serde_json::to_string(value).unwrap(),
        serde_json::Value::Array(values) => format!(
            "[{}]",
            values.iter().map(canonical).collect::<Vec<_>>().join(",")
        ),
        serde_json::Value::Object(values) => {
            let mut keys = values.keys().collect::<Vec<_>>();
            keys.sort();
            format!(
                "{{{}}}",
                keys.iter()
                    .map(|key| {
                        format!(
                            "{}:{}",
                            serde_json::to_string(key).unwrap(),
                            canonical(&values[*key])
                        )
                    })
                    .collect::<Vec<_>>()
                    .join(",")
            )
        }
    }
}

/// Recompute `public_api_hash` from artifact entries using the appsdk
/// algorithm: for each entry `path\0hash\0`, then sha256 of the concatenation.
pub fn recompute_public_api_hash(entries: &[ArtifactEntry]) -> String {
    let mut hasher = Sha256::new();
    for entry in entries {
        hasher.update(entry.path.as_bytes());
        hasher.update([0u8]);
        hasher.update(entry.hash.as_bytes());
        hasher.update([0u8]);
    }
    format!("sha256:{:x}", hasher.finalize())
}

/// Recompute the signed `artifact_hash` of an artifact.json object:
/// canonicalize the object without `artifact_hash` and `stage`, then sha256.
pub fn recompute_artifact_hash(artifact: &serde_json::Value) -> Result<String, ActiveLinkError> {
    let mut unsigned = artifact
        .as_object()
        .cloned()
        .ok_or_else(|| ActiveLinkError::ManifestInvalid("artifact.json is not an object".into()))?;
    unsigned.remove("artifact_hash");
    unsigned.remove("stage");
    Ok(sha256_hex(
        canonical(&serde_json::Value::Object(unsigned)).as_bytes(),
    ))
}
