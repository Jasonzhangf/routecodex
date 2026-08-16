//! routecodex-v4-plugin-manager — candidate transaction + atomic publish.
//!
//! Owns the unique active pointer and immutable audit ledger for the plugin
//! chain. Consumes only the typed `LifecyclePort` declared in this crate; the
//! real Cordis adapter is bound by the integration owner. Never imports
//! Cordis internals and never inspects plugin payload.

pub mod audit;
pub mod lifecycle;
pub mod manager;

pub use audit::{AuditAction, AuditError, AuditRecord, AuditResult, AuditSink};
pub use lifecycle::NullLifecyclePort;
pub use manager::{
    ActiveChain, CandidateId, CandidateState, LifecyclePort, ManagerError, PluginCandidate,
    PluginManager, PublishOutcome,
};

pub const ACTIVE_POINTER_KIND: &str = "node_plugin_chain";
