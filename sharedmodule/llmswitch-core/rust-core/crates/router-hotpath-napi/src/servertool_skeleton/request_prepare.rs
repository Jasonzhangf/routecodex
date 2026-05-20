//! request_prepare.rs — Servertool skeleton module
//! Phase: Patch 1 (Rust-only skeleton, no business logic)
//!
//! Responsibility: normalize and prepare request-side tool-call context
//! before servertool dispatch. Currently a no-op stub; business logic
//! will be added in subsequent patches.

use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RequestPrepareInput {
    pub tool_calls: Vec<Value>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RequestPrepareOutput {
    pub tool_calls: Vec<Value>,
}

impl Default for RequestPrepareOutput {
    fn default() -> Self {
        Self { tool_calls: vec![] }
    }
}

/// Prepares the request payload before servertool dispatch.
/// Returns the tool_calls unchanged until Patch 3+.
pub fn prepare_request(_input: RequestPrepareInput) -> RequestPrepareOutput {
    // TODO(patch3): wire real normalization here
    RequestPrepareOutput::default()
}
