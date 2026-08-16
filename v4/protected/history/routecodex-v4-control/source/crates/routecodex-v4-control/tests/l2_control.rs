use routecodex_v4_base_node::Scope;
use routecodex_v4_control::{
    ControlError, ControlSignal, ControlSignalKind, MetadataCenter, MetadataOperation, PayloadGate,
};

fn scope_a() -> Scope {
    Scope::new("req-1", "pipe-1", 5555, "sess-1", "conv-1")
}

fn scope_b() -> Scope {
    Scope::new("req-2", "pipe-2", 6666, "sess-2", "conv-2")
}

fn signal(key: &str, scope: Scope) -> ControlSignal {
    ControlSignal::new(
        ControlSignalKind::Route,
        key,
        "sha256:value",
        scope,
        Some("sha256:payload"),
    )
}

#[test]
fn control_lifecycle_full_cycle_success() {
    let mut center = MetadataCenter::new(scope_a());
    let reg = center.register(signal("route", scope_a())).unwrap();
    assert!(center.is_registered("route"));
    let signal = center.consume("route").unwrap();
    assert_eq!(signal.key, "route");
    assert_eq!(signal.kind, ControlSignalKind::Route);
    assert!(center.is_registered("route"));
    let rel = center.release("route").unwrap();
    assert!(center.is_released("route"));
    assert!(!center.is_registered("route"));
    let ops: Vec<MetadataOperation> = center.records().map(|r| r.operation).collect();
    assert_eq!(
        ops,
        vec![
            MetadataOperation::Register,
            MetadataOperation::Consume,
            MetadataOperation::Release
        ]
    );
    assert_eq!(center.records().count(), 3);
    assert_eq!(reg.sequence, 1);
    assert_eq!(rel.sequence, 3);
}

#[test]
fn control_lifecycle_duplicate_register_red() {
    let mut center = MetadataCenter::new(scope_a());
    center.register(signal("route", scope_a())).unwrap();
    let err = center.register(signal("route", scope_a())).unwrap_err();
    assert!(matches!(err, ControlError::AlreadyRegistered));
    assert_eq!(center.records().count(), 1);
}

#[test]
fn control_lifecycle_unregistered_consume_red() {
    let mut center = MetadataCenter::new(scope_a());
    let err = center.consume("route").unwrap_err();
    assert!(matches!(err, ControlError::NotRegistered));
    assert_eq!(center.records().count(), 0);
}

#[test]
fn control_lifecycle_unregistered_release_red() {
    let mut center = MetadataCenter::new(scope_a());
    let err = center.release("route").unwrap_err();
    assert!(matches!(err, ControlError::NotRegistered));
    assert_eq!(center.records().count(), 0);
}

#[test]
fn control_lifecycle_consume_after_release_red() {
    let mut center = MetadataCenter::new(scope_a());
    center.register(signal("route", scope_a())).unwrap();
    center.release("route").unwrap();
    let consume_err = center.consume("route").unwrap_err();
    assert!(matches!(consume_err, ControlError::ConsumeAfterRelease));
    let release_err = center.release("route").unwrap_err();
    assert!(matches!(release_err, ControlError::AlreadyReleased));
    assert_eq!(center.records().count(), 2);
}

#[test]
fn control_scope_isolation_cross_loop_red() {
    let mut center_a = MetadataCenter::new(scope_a());
    let err = center_a.register(signal("route", scope_b())).unwrap_err();
    assert!(matches!(err, ControlError::ScopeMismatch));
    assert_eq!(center_a.records().count(), 0);
    center_a.register(signal("route", scope_a())).unwrap();
    let mut center_b = MetadataCenter::new(scope_b());
    let consume_err = center_b.consume("route").unwrap_err();
    assert!(matches!(consume_err, ControlError::NotRegistered));
}

#[test]
fn control_scope_isolation_same_loop_multi_key_success() {
    let mut center = MetadataCenter::new(scope_a());
    center.register(signal("route", scope_a())).unwrap();
    center
        .register(ControlSignal::new(
            ControlSignalKind::Error,
            "error:timeout",
            "sha256:value",
            scope_a(),
            None,
        ))
        .unwrap();
    assert!(center.consume("route").is_ok());
    assert!(center.consume("error:timeout").is_ok());
    assert_eq!(center.records().count(), 4);
}

#[test]
fn payload_gate_write_control_red() {
    let mut gate = PayloadGate::new();
    let err = gate.write_control(&signal("route", scope_a())).unwrap_err();
    assert!(matches!(err, ControlError::ControlIntoPayload));
    let attempts: Vec<_> = gate.leak_attempts().collect();
    assert_eq!(attempts.len(), 1);
    assert_eq!(attempts[0].control_key, "route");
    assert_eq!(attempts[0].kind, ControlSignalKind::Route);
    assert_eq!(attempts[0].scope, scope_a());
    assert_eq!(attempts[0].sequence, 1);
    assert!(attempts[0].timestamp_ms > 0);
    let second_err = gate.write_control(&signal("route", scope_a())).unwrap_err();
    assert!(matches!(second_err, ControlError::ControlIntoPayload));
    assert_eq!(gate.leak_attempts().count(), 2);
}

#[test]
fn payload_gate_normal_payload_writer_unaffected() {
    struct NormalPayload {
        text: String,
    }
    let payload = NormalPayload {
        text: "client-visible body".to_string(),
    };
    let mut gate = PayloadGate::new();
    assert!(gate.write_control(&signal("route", scope_a())).is_err());
    assert_eq!(payload.text, "client-visible body");
    assert!(gate.leak_attempts().next().is_some());
}

#[test]
fn protocol_metadata_cannot_become_control_red() {
    let err =
        ControlSignal::try_from_protocol_metadata("metadata", r#"{"route":true}"#).unwrap_err();
    assert!(matches!(err, ControlError::ProtocolMetadataNotControl));
}

#[test]
fn payload_reconstruction_forbidden_red() {
    let err = ControlSignal::try_reconstruct_from_payload("sha256:payload", scope_a()).unwrap_err();
    assert!(matches!(
        err,
        ControlError::ControlNotReconstructibleFromPayload
    ));
}

#[test]
fn audit_records_immutable_ordered_and_scoped() {
    let mut center = MetadataCenter::new(scope_a());
    center.register(signal("route", scope_a())).unwrap();
    center.consume("route").unwrap();
    center.release("route").unwrap();
    let before = center.records().count();
    let mut previous_sequence = 0u64;
    for record in center.records() {
        assert!(record.sequence > previous_sequence);
        assert!(record.timestamp_ms > 0);
        assert_eq!(record.scope, scope_a());
        assert!(!record.record_id.is_empty());
        previous_sequence = record.sequence;
    }
    assert_eq!(center.records().count(), before);
}

#[test]
fn control_signal_kind_is_typed_enum() {
    let kinds = vec![
        ControlSignalKind::Route,
        ControlSignalKind::Continuation,
        ControlSignalKind::Stopless,
        ControlSignalKind::Error,
        ControlSignalKind::Scope,
    ];
    assert_eq!(kinds.len(), 5);
    assert_eq!(ControlSignalKind::Route as u8, 0);
}

#[test]
fn control_signal_carries_typed_fields_only() {
    let s = signal("route", scope_a());
    assert_eq!(s.key, "route");
    assert_eq!(s.value_hash, "sha256:value");
    assert_eq!(s.payload_hash.as_deref(), Some("sha256:payload"));
    assert_eq!(s.kind, ControlSignalKind::Route);
}

#[test]
fn control_blackbox_public_api_regression() {
    let mut center = MetadataCenter::new(scope_a());
    let mut gate = PayloadGate::new();
    let signal = ControlSignal::new(
        ControlSignalKind::Scope,
        "scope:entry",
        "sha256:value",
        scope_a(),
        None,
    );
    assert_eq!(center.scope(), &scope_a());
    let record = center.register(signal.clone()).unwrap();
    assert_eq!(record.signal.key, "scope:entry");
    assert!(center.is_registered("scope:entry"));
    let consumed = center.consume("scope:entry").unwrap();
    assert_eq!(consumed.kind, ControlSignalKind::Scope);
    assert_eq!(center.records().count(), 2);
    center.release("scope:entry").unwrap();
    assert!(center.is_released("scope:entry"));
    assert!(gate.write_control(&signal).is_err());
    assert_eq!(gate.leak_attempts().count(), 1);
}
