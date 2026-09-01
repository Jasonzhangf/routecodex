use routecodex_v4_debug::{DiagnosticEventEnvelope, ReadOnlySubscriberView, SubscriptionTopic, V4Debug02BusSubscription};

#[test]
fn matching_scope_and_topic_receive_published_fact() {
    let mut bus = V4Debug02BusSubscription::new();
    bus.subscribe("reader", SubscriptionTopic::Diagnostic, "request-a").unwrap();
    let envelope = DiagnosticEventEnvelope::new(
        SubscriptionTopic::Diagnostic,
        "request-a",
        "node-a",
        "sha256:event",
    );
    bus.publish(envelope).unwrap();
    let views: Vec<ReadOnlySubscriberView> = bus
        .dispatch(&SubscriptionTopic::Diagnostic, "request-a")
        .unwrap();
    assert_eq!(views[0].events().len(), 1);
}

#[test]
fn cross_scope_and_topic_are_not_delivered() {
    let mut bus = V4Debug02BusSubscription::new();
    bus.subscribe("reader", SubscriptionTopic::Diagnostic, "request-a").unwrap();
    bus.publish(DiagnosticEventEnvelope::new(
        SubscriptionTopic::StateTransition,
        "request-b",
        "node-a",
        "sha256:event",
    )).unwrap();
    assert!(bus.dispatch(&SubscriptionTopic::Diagnostic, "request-a").unwrap().is_empty());
}
