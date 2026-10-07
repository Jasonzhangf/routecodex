use routecodex_v3_runtime::{
    build_v3_hub_req_inbound_01_client_raw, build_v3_hub_req_inbound_02_from_request_invocation,
    compile_v3_hub_relay_request_hooks,
    operation_runner::{
        project_canonical_direct_request, CurrentFieldAssociations, RequestInvocationContext,
        RequestOriginKind, V3RequestContextHandle,
    },
    V3HubEntryProtocol, V3HubInvocationSource, V3HubServertoolRequestProfile, V3HubTransportIntent,
};
use serde_json::json;

#[test]
fn registered_chat_process_cleans_history_after_lossless_inbound() {
    let raw = json!({
        "input": [
            {"role": "user", "content": [{"type": "input_image", "image_url": "data:image/png;base64,aGlzdG9yeQ=="}]},
            {"role": "assistant", "content": "previous answer"},
            {"role": "user", "content": [{"type": "input_image", "image_url": "data:image/png;base64,Y3VycmVudA=="}]}
        ]
    });
    let handle = V3RequestContextHandle::new("history-owner".into(), "responses".into());
    let invocation = RequestInvocationContext::new(
        handle.clone(),
        "history-entry".into(),
        "history-attempt".into(),
        RequestOriginKind::ClientEntry,
    );
    let normalized = build_v3_hub_req_inbound_02_from_request_invocation(
        build_v3_hub_req_inbound_01_client_raw(
            raw.clone(),
            V3HubEntryProtocol::Responses,
            V3HubInvocationSource::Client,
            V3HubTransportIntent::Json,
        ),
        &invocation,
    )
    .unwrap();
    let canonical_before = normalized.payload().clone();
    let pair = handle.original_pair().unwrap();
    let current = CurrentFieldAssociations::from_normalization(&pair.inverse_context);
    let projected = project_canonical_direct_request(
        &canonical_before,
        &pair.inverse_context,
        &current,
        &pair.explicit_history_pairing,
    )
    .unwrap();
    assert_eq!(
        projected.payload, raw,
        "inbound must preserve both image values"
    );

    let outcome = compile_v3_hub_relay_request_hooks()
        .run_from_normalized(normalized, &V3HubServertoolRequestProfile::disabled())
        .unwrap();
    let governed = outcome.payload();
    assert_eq!(
        governed["messages"][0]["content"],
        json!([{"type":"text","text":"[Image]"}])
    );
    assert_eq!(
        governed["messages"][2]["content"],
        canonical_before["messages"][2]["content"]
    );
    assert_eq!(
        governed["messages"][1]["content"],
        canonical_before["messages"][1]["content"]
    );
    assert_eq!(
        handle.original_pair().unwrap(),
        pair,
        "Chat Process cannot mutate the immutable pair"
    );
    assert_eq!(
        project_canonical_direct_request(
            &canonical_before,
            &pair.inverse_context,
            &current,
            &pair.explicit_history_pairing,
        )
        .unwrap()
        .payload,
        raw
    );
}
