use routecodex_v3_runtime::{
    build_v3_hub_req_inbound_01_client_raw, compile_v3_hub_relay_request_hooks,
    V3HubContinuationLookup, V3HubContinuationOwnership, V3HubContinuationScope,
    V3HubEntryProtocol, V3HubInvocationSource, V3HubRelayRequestError, V3HubRelayRequestHookEvent,
    V3HubRequestSemanticProtocol, V3HubServertoolRequestProfile, V3HubTransportIntent,
};
use serde_json::json;

fn raw(payload: serde_json::Value) -> routecodex_v3_runtime::V3HubReqInbound01ClientRaw {
    build_v3_hub_req_inbound_01_client_raw(
        payload,
        V3HubEntryProtocol::Responses,
        V3HubInvocationSource::Client,
        V3HubTransportIntent::Json,
    )
}

fn scope() -> V3HubContinuationScope {
    V3HubContinuationScope::new(
        V3HubEntryProtocol::Responses,
        "server-a",
        "group-a",
        "session-a",
    )
}

#[test]
fn new_request_is_lossless_and_runs_every_entry_exit_hook() {
    let hooks = compile_v3_hub_relay_request_hooks();
    let payload = json!({"model":"client-alias","input":[{"role":"user","content":"hi"}],"metadata":{"client":"kept"}});
    let governed = hooks
        .run(
            raw(payload.clone()),
            &V3HubContinuationLookup::new(None, scope()),
            &V3HubServertoolRequestProfile::disabled(),
        )
        .unwrap();
    assert_eq!(governed.payload(), &payload);
    assert_eq!(
        governed.semantic_protocol(),
        V3HubRequestSemanticProtocol::Chat
    );
    assert_eq!(governed.continuation(), V3HubContinuationOwnership::New);
    assert!(!governed.restored_local_context());
    assert_eq!(
        governed.hook_events(),
        &[
            V3HubRelayRequestHookEvent::Req01Entry,
            V3HubRelayRequestHookEvent::Req01Exit,
            V3HubRelayRequestHookEvent::Req02Entry,
            V3HubRelayRequestHookEvent::Req02Exit,
            V3HubRelayRequestHookEvent::Req03Entry,
            V3HubRelayRequestHookEvent::Req03Exit,
            V3HubRelayRequestHookEvent::Req04Entry,
            V3HubRelayRequestHookEvent::Req04ToolGoverned,
            V3HubRelayRequestHookEvent::Req04HistoryGoverned,
            V3HubRelayRequestHookEvent::ServertoolOptionalNoop,
            V3HubRelayRequestHookEvent::Req04Exit,
        ]
    );
}

#[test]
fn remote_binding_is_classified_without_local_restore() {
    let hooks = compile_v3_hub_relay_request_hooks();
    let lookup = V3HubContinuationLookup::new(Some("resp_remote"), scope())
        .with_remote_binding("resp_remote", scope());
    let governed = hooks
        .run(
            raw(json!({"input":[]})),
            &lookup,
            &V3HubServertoolRequestProfile::disabled(),
        )
        .unwrap();
    assert_eq!(
        governed.continuation(),
        V3HubContinuationOwnership::RemoteProviderOwned
    );
    assert!(!governed.restored_local_context());
}

#[test]
fn local_context_restores_at_req04_before_servertool_governance() {
    let hooks = compile_v3_hub_relay_request_hooks();
    let lookup = V3HubContinuationLookup::new(Some("rcc_local"), scope()).with_local_context(
        "rcc_local",
        scope(),
        json!({"input":[{"role":"assistant","content":"prior"}]}),
    );
    let governed = hooks
        .run(
            raw(json!({"input":[{"type":"function_call_output","call_id":"c1","output":"ok"}]})),
            &lookup,
            &V3HubServertoolRequestProfile::enabled(["servertool.request"]),
        )
        .unwrap();
    assert_eq!(
        governed.continuation(),
        V3HubContinuationOwnership::RouteCodexLocalOwned
    );
    assert!(governed.restored_local_context());
    assert_eq!(
        governed.local_context().unwrap()["input"][0]["content"],
        "prior"
    );
    let events = governed.hook_events();
    let restore = events
        .iter()
        .position(|e| *e == V3HubRelayRequestHookEvent::Req04LocalContextRestored)
        .unwrap();
    let servertool = events
        .iter()
        .position(|e| *e == V3HubRelayRequestHookEvent::Req04ServertoolGoverned)
        .unwrap();
    assert!(restore < servertool);
}

#[test]
fn classification_is_fail_fast_for_missing_or_cross_scope_binding() {
    let hooks = compile_v3_hub_relay_request_hooks();
    let missing = V3HubContinuationLookup::new(Some("missing"), scope());
    assert!(matches!(
        hooks.run(
            raw(json!({})),
            &missing,
            &V3HubServertoolRequestProfile::disabled()
        ),
        Err(V3HubRelayRequestError::ContinuationNotFound { .. })
    ));

    let other_scope = V3HubContinuationScope::new(
        V3HubEntryProtocol::Responses,
        "server-b",
        "group-a",
        "session-a",
    );
    let mismatch = V3HubContinuationLookup::new(Some("rcc_local"), scope()).with_local_context(
        "rcc_local",
        other_scope,
        json!({"input":[]}),
    );
    assert!(matches!(
        hooks.run(
            raw(json!({})),
            &mismatch,
            &V3HubServertoolRequestProfile::disabled()
        ),
        Err(V3HubRelayRequestError::ContinuationScopeMismatch { .. })
    ));
}

#[test]
fn classification_rejects_dual_local_and_remote_owners() {
    let hooks = compile_v3_hub_relay_request_hooks();
    let lookup = V3HubContinuationLookup::new(Some("duplicate"), scope())
        .with_local_context("duplicate", scope(), json!({"input":[]}))
        .with_remote_binding("duplicate", scope());
    assert!(matches!(
        hooks.run(
            raw(json!({})),
            &lookup,
            &V3HubServertoolRequestProfile::disabled()
        ),
        Err(V3HubRelayRequestError::AmbiguousContinuationOwnership { .. })
    ));
}

#[test]
fn malformed_tool_output_and_required_hook_failure_are_explicit() {
    let hooks = compile_v3_hub_relay_request_hooks();
    let malformed = json!({"input":[{"type":"function_call_output","output":"missing call id"}]});
    assert!(matches!(
        hooks.run(
            raw(malformed),
            &V3HubContinuationLookup::new(None, scope()),
            &V3HubServertoolRequestProfile::disabled()
        ),
        Err(V3HubRelayRequestError::MalformedToolOutput { .. })
    ));

    assert!(matches!(
        hooks.run(
            raw(json!({})),
            &V3HubContinuationLookup::new(None, scope()),
            &V3HubServertoolRequestProfile::required_failure("req04.required")
        ),
        Err(V3HubRelayRequestError::RequiredHookFailed { .. })
    ));
}
