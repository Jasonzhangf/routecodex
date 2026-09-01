use routecodex_v4_base_node::Scope;
use routecodex_v4_control::{
    ControlEvent, ControlEventBus, ControlEventError, ControlEventKind, ControlEventRegistry,
    DeliveryPolicy,
};

fn scope_a() -> Scope {
    Scope::new("req-event-red", "pipe-event-red", 5520, "session-event-red", "conversation-event-red")
}

fn observation(sequence: u64, scope: Scope) -> ControlEvent {
    ControlEvent::diagnostic(
        "event-observation-1",
        ControlEventKind::Observation,
        "runtime",
        "debug",
        "V4Debug05EventLedgerRecorded",
        scope,
        sequence,
        "causality-1",
        DeliveryPolicy::Synchronous,
        true,
        false,
        "scope-release",
    )
    .expect("registered diagnostic event")
}

#[test]
fn red_event_bus_rejects_duplicate_out_of_order_cross_scope_and_unacked_terminal() {
    let registry = ControlEventRegistry::standard();
    let mut bus = ControlEventBus::new(scope_a(), registry);
    let first = observation(1, scope_a());
    bus.publish(first.clone()).expect("first event");
    assert_eq!(
        bus.publish(first).unwrap_err(),
        ControlEventError::DuplicateEvent
    );

    let mut delayed = observation(3, scope_a());
    delayed.event_id = "event-observation-3".to_string();
    assert_eq!(
        bus.publish(delayed).unwrap_err(),
        ControlEventError::SequenceGap
    );

    let foreign = observation(2, Scope::new("req-foreign", "pipe-event-red", 5520, "session-event-red", "conversation-event-red"));
    assert_eq!(
        bus.publish(foreign).unwrap_err(),
        ControlEventError::ScopeMismatch
    );

    assert_eq!(
        bus.release("event-observation-1").unwrap_err(),
        ControlEventError::OwnerAcknowledgementRequired
    );
}

#[test]
fn red_event_bus_requires_owner_ack_before_terminal_release_and_rejects_duplicate_terminal() {
    let registry = ControlEventRegistry::standard();
    let mut bus = ControlEventBus::new(scope_a(), registry);
    let terminal = ControlEvent::diagnostic(
        "event-terminal-1",
        ControlEventKind::NodeLifecycle,
        "runtime",
        "lifecycle",
        "V4Lifecycle05Terminal",
        scope_a(),
        1,
        "causality-terminal",
        DeliveryPolicy::Synchronous,
        true,
        true,
        "lifecycle-release",
    )
    .expect("registered terminal event");
    bus.publish(terminal).unwrap();
    assert!(bus.ack("event-terminal-1", "wrong-owner").is_err());
    bus.ack("event-terminal-1", "lifecycle").unwrap();
    bus.release("event-terminal-1").unwrap();
    assert_eq!(
        bus.ack("event-terminal-1", "lifecycle").unwrap_err(),
        ControlEventError::DuplicateTerminal
    );
}
