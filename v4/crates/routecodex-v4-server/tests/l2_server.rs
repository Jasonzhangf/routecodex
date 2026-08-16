//! routecodex-v4-server L2 regression: console/identity/evidence resources.

use routecodex_v4_server::{
    RequestIdentityError, V4ConsoleTerminalOutput, V4ErrorEvidenceFlushOnTerminalFailure,
    V4RequestIdCounter, WireEvidenceError,
};

#[test]
fn console_output_projection_positive() {
    let mut console = V4ConsoleTerminalOutput::new();
    console.write("srv-1", "req-1", "responses", "info", "route ok");
    assert_eq!(console.lines().count(), 1);
    assert_eq!(console.lines().next().unwrap().severity, "info");
}

#[test]
fn request_identity_counter_positive_and_red() {
    let mut counter = V4RequestIdCounter::new();
    let first = counter
        .next_request_identity("srv-1", "2026-08-16")
        .expect("identity must be issued");
    let second = counter
        .next_request_identity("srv-1", "2026-08-16")
        .expect("identity must be issued");
    assert_eq!(first.sequence, 1);
    assert_eq!(second.sequence, 2);
    assert_ne!(first.request_id, second.request_id);
    assert!(matches!(
        counter.next_request_identity("", "2026-08-16"),
        Err(RequestIdentityError::EmptyServerId)
    ));
}

#[test]
fn wire_evidence_terminal_failure_positive_and_red() {
    let mut evidence = V4ErrorEvidenceFlushOnTerminalFailure::new();
    let record = evidence
        .flush("responses", "localhost", 5555, "req-1", "req.json", b"{}")
        .expect("terminal failure flush must succeed");
    assert_eq!(record.wire_bytes, b"{}");
    assert_eq!(evidence.records().count(), 1);
    assert!(matches!(
        evidence.flush("responses", "localhost", 5555, "", "req.json", b"{}"),
        Err(WireEvidenceError::EmptyRequestId)
    ));
}
