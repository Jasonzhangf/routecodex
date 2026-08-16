//! routecodex-v4-provider L2 regression: session-scoped availability.

use routecodex_v4_provider::{
    AvailabilityRecord, AvailabilityState, V4Availability01SessionScoped,
};

#[test]
fn session_scoped_availability_positive_and_red() {
    let mut registry = V4Availability01SessionScoped::new();
    registry
        .record("srv-1", "rg-1", "session-a", "provider-1", AvailabilityState::Healthy, 0)
        .expect("record must succeed");
    let record: &AvailabilityRecord = registry
        .get("srv-1", "rg-1", "session-a", "provider-1")
        .expect("session record must exist");
    assert_eq!(record.state, AvailabilityState::Healthy);
    registry
        .record("srv-1", "rg-1", "session-a", "provider-1", AvailabilityState::Unavailable, 3)
        .expect("same-session update must replace the record");
    assert_eq!(
        registry
            .get("srv-1", "rg-1", "session-a", "provider-1")
            .expect("updated record")
            .consecutive_errors,
        3
    );
    // Different session must never observe the other session's availability.
    assert!(registry.get("srv-1", "rg-1", "session-b", "provider-1").is_none());
    assert_eq!(registry.records().count(), 1);
}
