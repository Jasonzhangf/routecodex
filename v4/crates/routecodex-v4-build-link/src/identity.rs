//! Active artifact identity carried through the link surface.
//!
//! The resolver consumes the recorded identity values from `artifact.json` as
//! data. It does not recompute packaging hashes or cross-check the AppSDK
//! record graph; that developer/CI identity packaging is retired.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

/// Immutable identity of one resolved Active artifact.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ActiveArtifactDependency {
    pub module_id: String,
    pub active_version: String,
    pub target_triple: String,
    pub artifact_hash: String,
    pub public_api_hash: String,
    /// Present only when the Active artifact itself records a source commit.
    pub source_commit: Option<String>,
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
    /// Present only when the Active artifact itself records a source commit.
    pub source_commit: Option<String>,
    /// Recursive dependency closure. The design doc names this field
    /// `dependency_closure`; the resolver contract keeps `dependencies`.
    pub dependencies: Vec<ActiveArtifactDependency>,
}

/// Resolved link surface: identity plus concrete rlib paths and rustc flags.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ActiveArtifactResolution {
    pub identity: ActiveArtifactIdentity,
    pub artifact_root: PathBuf,
    pub rlib_paths: Vec<PathBuf>,
    pub dependency_resolutions: Vec<ActiveArtifactResolution>,
    pub link_flags: Vec<String>,
}
