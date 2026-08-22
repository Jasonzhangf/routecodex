//! Typed fail-fast error chain for Active artifact linking.
//!
//! Codes follow the design contract:
//!   ActiveLinkErr01..ActiveLinkErr13. No fallback: every failure is explicit.

/// Typed Active-link error. Each variant carries a human-readable context
/// string; the error code prefix is part of the message so logs and gates can
/// match the design failure matrix.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ActiveLinkError {
    #[error("ActiveLinkErr01IdentityMissing: {0}")]
    IdentityMissing(String),
    #[error("ActiveLinkErr02ManifestInvalid: {0}")]
    ManifestInvalid(String),
    #[error("ActiveLinkErr03ArtifactMissing: {0}")]
    ArtifactMissing(String),
    #[error("ActiveLinkErr04ArtifactHashMismatch: {0}")]
    ArtifactHashMismatch(String),
    #[error("ActiveLinkErr05PublicApiHashMismatch: {0}")]
    PublicApiHashMismatch(String),
    #[error("ActiveLinkErr06TargetMismatch: {0}")]
    TargetMismatch(String),
    #[error("ActiveLinkErr07DependencyClosureMismatch: {0}")]
    DependencyClosureMismatch(String),
    #[error("ActiveLinkErr08SourcePathForbidden: {0}")]
    SourcePathForbidden(String),
    #[error("ActiveLinkErr09SymlinkOrPathEscape: {0}")]
    SymlinkOrPathEscape(String),
    #[error("ActiveLinkErr10StaleOrMissingRecord: {0}")]
    StaleOrMissingRecord(String),
    #[error("ActiveLinkErr11ActiveWriteForbidden: {0}")]
    ActiveWriteForbidden(String),
    #[error("ActiveLinkErr12LinkFailed: {0}")]
    LinkFailed(String),
    #[error("ActiveLinkErr13RustcMismatch: {0}")]
    RustcMismatch(String),
}
