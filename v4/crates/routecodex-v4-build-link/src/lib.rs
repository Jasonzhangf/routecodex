//! V4 Active-only artifact linking resolver (design V4-ACTIVE-LINK-001).
//!
//! Single owner of the V4 Active link surface. It resolves frozen module
//! Active artifacts, checks target/rustc compatibility and dependency
//! closure, and emits `rustc --extern` link flags. There is no source
//! fallback, no dual resolver, and no write path into Active artifacts.

pub mod error;
pub mod identity;
pub mod resolver;

pub use error::ActiveLinkError;
pub use identity::{ActiveArtifactDependency, ActiveArtifactIdentity, ActiveArtifactResolution};
pub use resolver::{emit_link_flags, resolve};
