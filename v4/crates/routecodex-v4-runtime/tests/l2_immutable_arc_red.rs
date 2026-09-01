use routecodex_v4_runtime::{
    ImmutableContinuationSnapshot, ImmutableProviderRaw, ImmutableRequest, ImmutableResponse,
    ImmutableSemantic, ImmutableWireBytes,
};

#[test]
fn red_immutable_payload_carriers_share_arc_without_mutable_json() {
    let request = ImmutableRequest::from_bytes(br#"{"model":"gpt-5.6-sol"}"#);
    let request_clone = request.clone();
    assert!(request.shares_allocation_with(&request_clone));
    assert_eq!(request.copy_count(), 1);

    let response = ImmutableResponse::from_bytes(br#"{"status":"completed"}"#);
    let raw = ImmutableProviderRaw::from_bytes(response.as_bytes());
    let semantic = ImmutableSemantic::from_bytes(raw.as_bytes());
    let wire = ImmutableWireBytes::from_bytes(semantic.as_bytes());
    let continuation = ImmutableContinuationSnapshot::from_bytes(wire.as_bytes());
    assert!(response.shares_allocation_with(&response.clone()));
    assert!(raw.shares_allocation_with(&raw.clone()));
    assert!(semantic.shares_allocation_with(&semantic.clone()));
    assert!(wire.shares_allocation_with(&wire.clone()));
    assert!(continuation.shares_allocation_with(&continuation.clone()));
}
