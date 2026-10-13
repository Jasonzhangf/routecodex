use super::*;

#[test]
fn provider_internal_transport_request_lane_projects_598_without_provider_policy() {
    let failure = super::responses_relay_failures::provider_runtime_failure(
        V3ProviderError::InternalTransport {
            request_id: "req-internal".to_string(),
            provider_id: "goaichat".to_string(),
            lane: routecodex_v3_provider_responses::V3ProviderInternalTransportLane::Request,
            reason: "handoff transition failed".to_string(),
        },
        "goaichat",
        None,
    );
    assert_eq!(failure.status, 598);
    assert_eq!(
        failure.source_stage,
        "V3ProviderReqOutbound09TransportRequest"
    );
    assert_eq!(failure.provider_status, None);
    assert_eq!(
        failure.policy_error_type,
        "provider_internal_transport_error"
    );
    assert!(failure.terminal_projection.is_some());
    assert!(failure.matched_policy.is_none());
    assert_eq!(
        failure.terminal_disposition,
        Some(routecodex_v3_error::V3ProviderTerminalDisposition::NoResponse)
    );
}

#[test]
fn provider_internal_transport_response_lane_projects_599_without_provider_policy() {
    let failure = super::responses_relay_failures::provider_runtime_failure(
        V3ProviderError::InternalTransport {
            request_id: "req-internal".to_string(),
            provider_id: "goaichat".to_string(),
            lane: routecodex_v3_provider_responses::V3ProviderInternalTransportLane::Response,
            reason: "provider frame sequence mismatch".to_string(),
        },
        "goaichat",
        None,
    );
    assert_eq!(failure.status, 599);
    assert_eq!(failure.source_stage, "V3ProviderRespInbound01Raw");
    assert_eq!(failure.provider_status, None);
    assert_eq!(
        failure.policy_error_type,
        "provider_internal_transport_error"
    );
    assert!(failure.terminal_projection.is_some());
    assert!(failure.matched_policy.is_none());
    assert_eq!(
        failure.terminal_disposition,
        Some(routecodex_v3_error::V3ProviderTerminalDisposition::NoResponse)
    );
}
