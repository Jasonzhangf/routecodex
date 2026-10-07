use routecodex_v3_runtime::{
    build_v3_hub_req_inbound_01_client_raw, build_v3_hub_req_inbound_02_from_request_invocation,
    operation_runner::{
        execute_v3_operation_runner_request_capture_client_json, project_canonical_direct_request,
        CurrentFieldAssociations, RequestInvocationContext, RequestOriginKind,
        V3RequestContextHandle,
    },
    V3HubEntryProtocol, V3HubInvocationSource, V3HubTransportIntent,
};
use serde_json::{json, Value};

fn inbound(
    payload: Value,
    protocol: V3HubEntryProtocol,
    invocation: &RequestInvocationContext,
) -> Result<routecodex_v3_runtime::V3HubReqInbound02Normalized, String> {
    let captured = execute_v3_operation_runner_request_capture_client_json(payload)
        .map_err(|error| error.to_string())?;
    build_v3_hub_req_inbound_02_from_request_invocation(
        build_v3_hub_req_inbound_01_client_raw(
            captured,
            protocol,
            V3HubInvocationSource::Client,
            V3HubTransportIntent::Json,
        ),
        invocation,
    )
}

#[test]
fn hub_sdk_inbound_roundtrips_all_four_registered_protocols() {
    let samples = [
        (
            "responses",
            V3HubEntryProtocol::Responses,
            json!({
                "model":"m", "input":[{"role":"user","content":"hello"}],
                "tools":[{"type":"custom","name":"apply_patch","format":{"type":"text"}}],
                "vendor.key[0]":{"keep":null}
            }),
        ),
        (
            "openai-chat",
            V3HubEntryProtocol::OpenAiChat,
            json!({
                "model":"m", "messages":[{"role":"user","content":"hello"}],
                "tools":[{"type":"function","function":{"name":"exec","parameters":{"type":"object"}}}]
            }),
        ),
        (
            "anthropic",
            V3HubEntryProtocol::Anthropic,
            json!({
                "model":"m", "messages":[{"role":"user","content":[{"type":"text","text":"hello"}]}],
                "tools":[{"name":"mcp","input_schema":{"type":"object"}}], "max_tokens":50
            }),
        ),
        (
            "gemini",
            V3HubEntryProtocol::Gemini,
            json!({
                "contents":[{"role":"user","parts":[{"text":"hello"}]}],
                "tools":[{"functionDeclarations":[{"name":"exec","parameters":{"type":"object"}}]}],
                "generationConfig":{"maxOutputTokens":50}
            }),
        ),
    ];
    for (protocol, entry_protocol, raw) in samples {
        let handle =
            V3RequestContextHandle::new(format!("hub-sdk-{protocol}"), protocol.to_string());
        let invocation = RequestInvocationContext::new(
            handle.clone(),
            format!("{protocol}-entry"),
            format!("{protocol}-attempt"),
            RequestOriginKind::ClientEntry,
        );
        let normalized = inbound(raw.clone(), entry_protocol, &invocation).unwrap();
        assert_eq!(normalized.entry_protocol(), entry_protocol);
        let pair = handle.original_pair().unwrap();
        let current = CurrentFieldAssociations::from_normalization(&pair.inverse_context);
        let projected = project_canonical_direct_request(
            normalized.payload(),
            &pair.inverse_context,
            &current,
            &pair.explicit_history_pairing,
        )
        .unwrap();
        assert_eq!(projected.payload, raw, "{protocol}");
        assert_eq!(handle.original_pair().unwrap(), pair);
        assert!(
            handle.current_field_associations().is_err(),
            "REQ02 does not own the current-slot writer"
        );
    }
}

#[test]
fn hub_sdk_inbound_reentry_preserves_canonical_data_and_original_pair() {
    let handle = V3RequestContextHandle::new("hub-sdk-reentry".into(), "responses".into());
    let entry = RequestInvocationContext::new(
        handle.clone(),
        "entry".into(),
        "attempt-1".into(),
        RequestOriginKind::ClientEntry,
    );
    let normalized = inbound(
        json!({"model":"m","input":"hello"}),
        V3HubEntryProtocol::Responses,
        &entry,
    )
    .unwrap();
    let original_pair = handle.original_pair().unwrap();
    let mut canonical = normalized.payload().clone();
    canonical["model"] = json!("current-model");
    for (index, origin) in [
        RequestOriginKind::Retry,
        RequestOriginKind::InternalFollowup,
    ]
    .into_iter()
    .enumerate()
    {
        let invocation = RequestInvocationContext::new(
            handle.clone(),
            format!("reentry-{index}"),
            format!("attempt-{}", index + 2),
            origin,
        );
        let replay = inbound(
            canonical.clone(),
            V3HubEntryProtocol::Responses,
            &invocation,
        )
        .unwrap();
        assert_eq!(replay.payload(), &canonical);
        assert_eq!(handle.original_pair().unwrap(), original_pair);
    }
}

#[test]
fn hub_sdk_inbound_keeps_missing_or_terminated_reentry_explicit() {
    let handle = V3RequestContextHandle::new("hub-sdk-terminal".into(), "responses".into());
    let invocation = RequestInvocationContext::new(
        handle.clone(),
        "missing-reentry".into(),
        "attempt-2".into(),
        RequestOriginKind::Retry,
    );
    assert!(inbound(
        json!({"messages":[]}),
        V3HubEntryProtocol::Responses,
        &invocation
    )
    .is_err());
    let finalizer = handle.take_finalizer().unwrap();
    drop(finalizer);
    let entry = RequestInvocationContext::new(
        handle.clone(),
        "terminated-entry".into(),
        "attempt-3".into(),
        RequestOriginKind::ClientEntry,
    );
    assert!(inbound(
        json!({"input":"hello"}),
        V3HubEntryProtocol::Responses,
        &entry
    )
    .is_err());
    assert!(handle.original_pair().is_err());
}
