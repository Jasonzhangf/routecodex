//! routecodex-v4-router L2 regression: live policy override lifecycle with
//! baseline anchoring and immutable history.

use routecodex_v4_router::{LivePolicyError, LivePolicyOverride, V4Router08LivePolicyOverride};

#[test]
fn live_policy_override_positive_and_red() {
    let mut registry = V4Router08LivePolicyOverride::new();
    registry
        .set("srv-1", "rg-1", "policy-1", "scope-a", true, true)
        .expect("baseline-anchored set must succeed");
    registry
        .set("srv-1", "rg-1", "policy-2", "scope-a", false, true)
        .expect("second version appends to immutable history");
    let current: &LivePolicyOverride = registry
        .current("srv-1", "rg-1", "scope-a")
        .expect("current must exist");
    assert_eq!(current.policy_version, "policy-2");
    assert!(!current.enabled);
    assert_eq!(registry.history().count(), 2);
    assert!(registry.current("srv-1", "rg-1", "scope-b").is_none());
    assert!(matches!(
        registry.set("srv-1", "rg-1", "policy-3", "scope-a", true, false),
        Err(LivePolicyError::MissingBaseline)
    ));
}
