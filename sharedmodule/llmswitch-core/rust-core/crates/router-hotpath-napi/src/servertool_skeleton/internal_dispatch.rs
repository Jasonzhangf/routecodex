//! internal_dispatch.rs — Servertool skeleton module
//! Phase: Patch 1 (Rust-only skeleton, no business logic)

use serde::Serialize;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InternalDispatchPlan {
    pub executable_tool_calls: Vec<serde_json::Value>,
    pub skipped_tool_calls: Vec<serde_json::Value>,
}

/// Builds dispatch plan for servertool handlers.
/// Stub implementation for Patch 1.
pub fn plan_internal_dispatch() -> InternalDispatchPlan {
    // TODO(patch4): move dispatch planning semantics here
    InternalDispatchPlan {
        executable_tool_calls: vec![],
        skipped_tool_calls: vec![],
    }
}
