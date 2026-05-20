//! outcome_resolve.rs — Servertool skeleton module
//! Phase: Patch 1 (Rust-only skeleton, no business logic)

use serde::Serialize;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OutcomeResolvePlan {
    pub mixed_client_tools: bool,
    pub finalize_only: bool,
}

/// Resolves follow-up outcome plan.
/// Stub implementation for Patch 1.
pub fn resolve_outcome() -> OutcomeResolvePlan {
    // TODO(patch5): move outcome planning semantics here
    OutcomeResolvePlan {
        mixed_client_tools: false,
        finalize_only: true,
    }
}
