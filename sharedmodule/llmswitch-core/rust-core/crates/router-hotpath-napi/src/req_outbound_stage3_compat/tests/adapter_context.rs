use super::*;
use serde_json::json;

#[test]
fn builds_native_req_outbound_compat_adapter_context_from_metadata_center_snapshot_only() {
    let result = build_native_req_outbound_compat_adapter_context(Some(&json!({
        "runtimeControl": {
            "providerProtocol": " openai-responses ",
            "routeId": " center-route "
        },
        "requestTruth": {
            "requestId": " center-request ",
            "clientRequestId": " center-client-request ",
            "sessionId": " center-session ",
            "conversationId": " center-conversation ",
            "entryEndpoint": " /v1/responses "
        },
        "providerObservation": {
            "providerKey": " center.key1 ",
            "assignedModelId": " center-model ",
            "clientModelId": " center-client-model ",
            "compatibilityProfile": " responses:c4m ",
            "target": {
                "providerId": " center-provider "
            }
        }
    })))
    .expect("native adapter context should build");

    assert_eq!(
        result.provider_protocol.as_deref(),
        Some("openai-responses")
    );
    assert_eq!(
        result.compatibility_profile.as_deref(),
        Some("responses:c4m")
    );
    assert_eq!(result.provider_key.as_deref(), Some("center.key1"));
    assert_eq!(result.provider_id.as_deref(), Some("center-provider"));
    assert_eq!(result.request_id.as_deref(), Some("center-request"));
    assert_eq!(
        result.client_request_id.as_deref(),
        Some("center-client-request")
    );
    assert_eq!(result.session_id.as_deref(), Some("center-session"));
    assert_eq!(
        result.conversation_id.as_deref(),
        Some("center-conversation")
    );
    assert_eq!(result.entry_endpoint.as_deref(), Some("/v1/responses"));
    assert_eq!(result.route_id.as_deref(), Some("center-route"));
    assert_eq!(result.model_id.as_deref(), Some("center-model"));
    assert_eq!(
        result.client_model_id.as_deref(),
        Some("center-client-model")
    );
    assert!(result.captured_chat_request.is_none());
    assert!(result.original_model_id.is_none());
    assert!(result.runtime_key.is_none());
}

#[test]
fn fails_when_metadata_center_provider_protocol_is_missing() {
    let error = build_native_req_outbound_compat_adapter_context(Some(&json!({
        "runtimeControl": {
            "routeId": "center-route"
        },
        "requestTruth": {
            "requestId": "center-request"
        }
    })))
    .expect_err("missing providerProtocol must fail");

    assert_eq!(
        error,
        "Native req outbound compat adapter context requires metadata center runtime_control.providerProtocol"
    );
}
