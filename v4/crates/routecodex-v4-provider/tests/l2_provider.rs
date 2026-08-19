//! routecodex-v4-provider L2 regression: session-scoped availability.

use routecodex_v4_provider::{
    project_provider_compat, validate_provider_wire_payload, AvailabilityRecord, AvailabilityState,
    V4Availability01SessionScoped,
};
use serde_json::json;

#[test]
fn session_scoped_availability_positive_and_red() {
    let mut registry = V4Availability01SessionScoped::new();
    registry
        .record(
            "srv-1",
            "rg-1",
            "session-a",
            "provider-1",
            AvailabilityState::Healthy,
            0,
        )
        .expect("record must succeed");
    let record: &AvailabilityRecord = registry
        .get("srv-1", "rg-1", "session-a", "provider-1")
        .expect("session record must exist");
    assert_eq!(record.state, AvailabilityState::Healthy);
    registry
        .record(
            "srv-1",
            "rg-1",
            "session-a",
            "provider-1",
            AvailabilityState::Unavailable,
            3,
        )
        .expect("same-session update must replace the record");
    assert_eq!(
        registry
            .get("srv-1", "rg-1", "session-a", "provider-1")
            .expect("updated record")
            .consecutive_errors,
        3
    );
    // Different session must never observe the other session's availability.
    assert!(registry
        .get("srv-1", "rg-1", "session-b", "provider-1")
        .is_none());
    assert_eq!(registry.records().count(), 1);
}

#[test]
fn responses_direct_and_registered_relay_compat_are_explicit() {
    let semantic = json!({"model": "provider-model", "input": "hello"});
    assert_eq!(
        project_provider_compat(&semantic, "responses", "responses", "direct").unwrap(),
        semantic
    );
    assert_eq!(
        project_provider_compat(&semantic, "responses", "responses", "relay").unwrap(),
        semantic
    );
    let error = project_provider_compat(&semantic, "responses", "anthropic", "relay")
        .expect_err("unregistered compat must fail fast");
    assert_eq!(error.code, "provider_compat_unmapped");
}

#[test]
fn provider_wire_rejects_control_fields_but_preserves_protocol_metadata() {
    validate_provider_wire_payload(&json!({
        "model": "provider-model",
        "metadata": {"client": "preserved"}
    }))
    .expect("Responses protocol metadata is data-plane input");
    let error = validate_provider_wire_payload(&json!({
        "model": "provider-model",
        "target_selection": {"provider_id": "leak"}
    }))
    .expect_err("control resource leak must fail fast");
    assert_eq!(error.code, "provider_wire_control_leak");
}
