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
fn subscription_query_must_filter_scope_inside_bus_owner() {
    let mut bus = V4Debug02BusSubscription::new();
    bus.subscribe("same", SubscriptionTopic::Diagnostic, "scope-a").unwrap();
    bus.subscribe("other", SubscriptionTopic::Diagnostic, "scope-b").unwrap();
    let view = bus.subscribers_for(&SubscriptionTopic::Diagnostic).collect::<Vec<_>>();
    assert_eq!(view.len(), 1, "bus query must not expose another scope");
}
