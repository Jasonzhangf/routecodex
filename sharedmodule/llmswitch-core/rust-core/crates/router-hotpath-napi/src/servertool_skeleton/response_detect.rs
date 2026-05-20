//! response_detect.rs — Servertool skeleton module
//! Phase: Patch 1 (Rust-only skeleton, no business logic)

use serde::Serialize;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResponseDetectOutput {
    pub provider_response_shape: String,
    pub is_canonical_chat_completion_payload: bool,
}

/// Detects response shape and canonical marker.
/// Stub implementation for Patch 1.
pub fn detect_response_shape() -> ResponseDetectOutput {
    // TODO(patch3): move detect/extract semantics here
    ResponseDetectOutput {
        provider_response_shape: "unknown".to_string(),
        is_canonical_chat_completion_payload: false,
    }
}
