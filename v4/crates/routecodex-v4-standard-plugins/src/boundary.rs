//! Canonical payload/control boundary for the standard-plugin owner.
//!
//! This module owns the request-lane control-field predicate. Both the
//! `validate_input`/`validate_output` validators and the request plugin
//! handlers route through here so the boundary has one true source.
//! Response-side keys stay in `response_inbound` because the response
//! boundary has a distinct owner and key set.

use serde_json::{Map, Value};

pub(crate) fn request_control_keys() -> &'static [&'static str] {
    &[
        "requestId",
        "control",
        "metadata_center",
        "error_chain",
        "route_facts",
        "target_selection",
        "debug",
        "diagnostics",
        "snapshot",
        "providerId",
    ]
}

pub(crate) fn reject_control_fields(object: &Map<String, Value>) -> Result<(), String> {
    for key in request_control_keys() {
        if object.contains_key(*key) {
            return Err(format!("standard boundary rejects control field {key}"));
        }
    }
    Ok(())
}
