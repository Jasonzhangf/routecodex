//! routecodex-v4-router L2 regression: live policy override lifecycle with
//! baseline anchoring and immutable history.

use routecodex_v4_router::{
    route_request, LivePolicyError, LivePolicyOverride, ProviderCandidate, TargetSelectionError,
    V4Router08LivePolicyOverride,
};
use serde_json::json;

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

fn request_candidates() -> Vec<ProviderCandidate> {
    vec![ProviderCandidate {
        provider_id: "cc-sol".to_string(),
        config_path: "/tmp/cc-sol.toml".to_string(),
        protocol: "responses".to_string(),
        model: "gpt-5.6-sol".to_string(),
        priority: 1,
        entry_models: vec!["gpt-5.5".to_string(), "gpt-5.6".to_string()],
        execution_mode: "direct".to_string(),
    }]
}

#[test]
fn vr_admits_entry_model_and_selects_distinct_provider_model() {
    let decision = route_request(&request_candidates(), &json!({"model": "gpt-5.5"}))
        .expect("entry alias must route");
    assert_eq!(decision.entry_model.as_deref(), Some("gpt-5.5"));
    assert_eq!(decision.target.model, "gpt-5.6-sol");
    assert_eq!(decision.target.execution_mode, "direct");
}

#[test]
fn vr_owns_invalid_and_unknown_model_admission() {
    assert!(matches!(
        route_request(&request_candidates(), &json!({"model": 5})),
        Err(TargetSelectionError::InvalidModel(_))
    ));
    assert!(matches!(
        route_request(&request_candidates(), &json!({"model": "unknown"})),
        Err(TargetSelectionError::ModelUnavailable(model)) if model == "unknown"
    ));
    assert!(route_request(&request_candidates(), &json!({"input": "hello"})).is_ok());
}
