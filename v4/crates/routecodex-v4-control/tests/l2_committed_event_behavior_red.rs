#![cfg(feature = "red-fixtures")]
use routecodex_v4_base_node::Scope;
use routecodex_v4_control::{ControlSignal, ControlSignalKind, MetadataCenter};

#[test]
fn committed_control_transition_exposes_immutable_event_fact() {
    let scope = Scope::new("req", "pipeline", 7777, "session", "conversation");
    let mut center = MetadataCenter::new(scope.clone());
    let record = center
        .register(ControlSignal::new(
            ControlSignalKind::Continuation,
            "continuation",
            "sha256:value",
            scope,
            Some("sha256:payload"),
        ))
        .unwrap();
    let event = record.committed_event().expect("commit must publish event fact");
    assert_eq!(event.control_key(), "continuation");
}
