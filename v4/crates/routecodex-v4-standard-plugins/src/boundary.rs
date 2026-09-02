//! Canonical payload/control boundary for the standard-plugin owner.
//!
//! This module owns the shared predicate that rejects control/debug/snapshot
//! fields in normal payload. Request and response boundaries keep their own
//! key sets so one direction cannot leak the other direction's contract.

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

pub(crate) fn reject_response_control_fields(object: &Map<String, Value>) -> Result<(), String> {
    for key in response_control_keys() {
        if object.contains_key(*key) {
            return Err(format!("standard boundary rejects control field {key}"));
        }
    }
    Ok(())
}

fn response_control_keys() -> &'static [&'static str] {
    &[
        "control",
        "metadata_center",
        "error_chain",
        "route_facts",
        "target_selection",
        "payload_cycle",
        "stopless_state",
        "side_channel",
        "record_ledger",
        "debug",
        "diagnostics",
        "snapshot",
        "extra_fields",
    ]
}
