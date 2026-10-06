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
fn opaque_instructions_remain_reversible_when_memory_guidance_is_enabled() {
    let raw = json!({
        "model": "gpt-5.5",
        "input": [{"role": "user", "content": "hello"}],
        "instructions": 7
    });
    let handle = V3RequestContextHandle::new("memory-instruction-owner".into(), "responses".into());
    let invocation = RequestInvocationContext::new(
        handle.clone(),
        "memory-instruction-entry".into(),
        "memory-instruction-attempt".into(),
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
    .expect("lossless inbound must retain the non-Chat instruction value");
    let canonical = normalized.payload().clone();
    let pair = handle.original_pair().unwrap();
    let current = CurrentFieldAssociations::from_normalization(&pair.inverse_context);
    assert_eq!(
        project_canonical_direct_request(
            &canonical,
            &pair.inverse_context,
            &current,
            &pair.explicit_history_pairing,
        )
        .unwrap()
        .payload,
        raw,
        "normalization must preserve instructions and every other original field"
    );

    let profile = V3HubServertoolRequestProfile::enabled([]).with_memory_raw_capture_enabled(true);
    let governed = compile_v3_hub_relay_request_hooks()
        .run_from_normalized(normalized, &profile)
        .expect("opaque instructions must not block registered Chat Process guidance");
    let instructions = governed.payload()["instructions"]
        .as_str()
        .expect("memory guidance must be emitted at the registered processing point");
    assert!(instructions.contains("routecodex.memory.raw-entry.v1"));
    assert_eq!(governed.payload()["messages"], canonical["messages"]);
    assert_eq!(handle.original_pair().unwrap(), pair);
    assert_eq!(
        project_canonical_direct_request(
            &canonical,
            &pair.inverse_context,
            &current,
            &pair.explicit_history_pairing,
        )
        .unwrap()
        .payload,
        raw,
        "guidance injection must leave the original request reversible"
    );
}
