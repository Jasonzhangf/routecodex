#![cfg(feature = "red-fixtures")]
use routecodex_v4_debug::{SubscriptionTopic, V4Debug02BusSubscription};

#[test]
fn dispatch_delivers_only_matching_topic_and_scope() {
    let mut bus = V4Debug02BusSubscription::new();
    bus.subscribe("same", SubscriptionTopic::Diagnostic, "scope-a").unwrap();
    bus.subscribe("other", SubscriptionTopic::Diagnostic, "scope-b").unwrap();
    let view = bus
        .subscribers_for(&SubscriptionTopic::Diagnostic)
        .filter(|subscription| subscription.scope_key == "scope-a")
        .collect::<Vec<_>>();
    assert_eq!(view.len(), 1);
    assert_eq!(view[0].scope_key, "scope-a");
}

#[test]
fn subscription_query_exposes_all_topic_subscribers_without_dropping_scope() {
    let mut bus = V4Debug02BusSubscription::new();
    bus.subscribe("same", SubscriptionTopic::Diagnostic, "scope-a").unwrap();
    bus.subscribe("other", SubscriptionTopic::Diagnostic, "scope-b").unwrap();
    let view = bus.subscribers_for(&SubscriptionTopic::Diagnostic).collect::<Vec<_>>();
    assert_eq!(view.len(), 2, "bus query must not silently drop a different scope");
    assert!(view.iter().any(|subscription| subscription.scope_key == "scope-a"));
    assert!(view.iter().any(|subscription| subscription.scope_key == "scope-b"));
}
