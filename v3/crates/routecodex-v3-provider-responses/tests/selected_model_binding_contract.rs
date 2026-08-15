use routecodex_v3_config::V3ResponsesTransportKind;
use routecodex_v3_provider_responses::{
    build_v3_provider_12_responses_wire_payload, V3ProviderAuthHandle, V3ProviderAuthSecretHandle,
    V3ResponsesProviderTarget,
};
use serde_json::json;

fn target() -> V3ResponsesProviderTarget {
    V3ResponsesProviderTarget {
        provider_id: "selected-provider".to_string(),
        provider_type: "responses".to_string(),
        base_url: "https://provider.invalid/v1".to_string(),
        canonical_model_id: "provider-model-id".to_string(),
        wire_model: "provider-wire-model".to_string(),
        compatibility_profile: None,
        auth: V3ProviderAuthHandle {
            alias: "primary".to_string(),
            secret: V3ProviderAuthSecretHandle::Environment("TEST_KEY".to_string()),
        },
        responses_transport: V3ResponsesTransportKind::Http,
        websocket_v2_url: None,
        provider_request_cleanup: Default::default(),
        request_timeout_ms: 300_000,
        sse_first_frame_timeout_ms: None,
        initial_concurrency_budget: 8,
    }
}

#[test]
fn provider_wire_rejects_unbound_client_model_instead_of_rewriting_it_late() {
    let result = build_v3_provider_12_responses_wire_payload(
        "req-model-binding-negative",
        target(),
        json!({
            "model": "client-route-alias",
            "input": "hello"
        }),
    );

    assert!(
        result.is_err(),
        "ProviderReqOutbound wire owner must validate the route-selected wire model, not silently rewrite a stale client model"
    );

    let padded = build_v3_provider_12_responses_wire_payload(
        "req-model-binding-padded",
        target(),
        json!({
            "model": " provider-wire-model ",
            "input": "hello"
        }),
    );
    assert!(
        padded.is_err(),
        "Provider12 must compare the raw bound model and reject whitespace normalization"
    );
}
