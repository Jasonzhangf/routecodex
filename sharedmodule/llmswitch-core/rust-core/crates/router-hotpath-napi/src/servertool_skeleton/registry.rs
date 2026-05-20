//! registry.rs — Servertool skeleton module
//! Phase: Patch 1 (Rust-only skeleton, no business logic)

/// Registry key constants for servertool skeleton stages.
pub const REQUEST_PREPARE_STAGE: &str = "request_prepare";
pub const RESPONSE_DETECT_STAGE: &str = "response_detect";
pub const INTERNAL_DISPATCH_STAGE: &str = "internal_dispatch";
pub const OUTCOME_RESOLVE_STAGE: &str = "outcome_resolve";
pub const FINALIZE_STRIP_STAGE: &str = "finalize_strip";
