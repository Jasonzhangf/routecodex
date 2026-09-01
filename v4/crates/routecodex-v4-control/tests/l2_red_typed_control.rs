use routecodex_v4_base_node::Scope;
use routecodex_v4_control::{ControlCommand, ControlCommittedEvent, MetadataCenter};

#[test]
fn committed_typed_command_emits_immutable_event_fact() {
    let scope = Scope::new("request-a", "v4-skeleton", 5520, "session-a", "conversation-a");
    let mut center = MetadataCenter::new(scope.clone());
    let record = center.commit(ControlCommand::Register {
        resource: "continuation".into(),
        value: "seed".into(),
        scope,
    }).unwrap();
    let event: ControlCommittedEvent = record.committed_event().unwrap();
    assert_eq!(event.resource(), "continuation");
}

#[test]
fn invalid_typed_transitions_fail_fast() {
    let scope = Scope::new("request-a", "v4-skeleton", 5520, "session-a", "conversation-a");
    let mut center = MetadataCenter::new(scope.clone());
    assert!(center.commit(ControlCommand::Consume { resource: "missing".into(), scope }).is_err());
}
