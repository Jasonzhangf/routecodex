use routecodex_v4_debug::{SubscriptionTopic, V4Debug02BusSubscription};

#[test]
fn dispatch_delivers_only_matching_topic_and_scope() {
    let mut bus = V4Debug02BusSubscription::new();
    bus.subscribe("same", SubscriptionTopic::Diagnostic, "scope-a").unwrap();
    bus.subscribe("other", SubscriptionTopic::Diagnostic, "scope-b").unwrap();
    bus.publish("scope-a", SubscriptionTopic::Diagnostic, "event-a")
        .unwrap();
    let view = bus
        .dispatch("scope-a", SubscriptionTopic::Diagnostic)
        .unwrap();
    assert_eq!(view.len(), 1);
    assert_eq!(view[0].scope_key, "scope-a");
}
