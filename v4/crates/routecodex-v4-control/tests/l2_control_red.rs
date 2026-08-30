use routecodex_v4_base_node::Scope;
use routecodex_v4_control::{ControlError, ControlSignal, ControlSignalKind, PayloadGate};

#[test]
fn protocol_metadata_to_control_is_rejected() {
    let error = ControlSignal::try_from_protocol_metadata("retry", "true").unwrap_err();
    assert_eq!(error, ControlError::ProtocolMetadataNotControl);
}

#[test]
fn payload_control_reconstruction_and_write_are_rejected() {
    let scope = Scope::new(
        "req-red",
        "pipe-red",
        5555,
        "session-red",
        "conversation-red",
    );
    let reconstruction =
        ControlSignal::try_reconstruct_from_payload("sha256:payload", scope.clone());
    assert_eq!(
        reconstruction.unwrap_err(),
        ControlError::ControlNotReconstructibleFromPayload
    );

    let signal = ControlSignal::new(
        ControlSignalKind::Retry,
        "retry:red",
        "sha256:value",
        scope,
        None,
    );
    let mut gate = PayloadGate::new();
    assert_eq!(
        gate.write_control(&signal).unwrap_err(),
        ControlError::ControlIntoPayload
    );
}
