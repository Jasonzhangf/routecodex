use futures_util::stream;
use routecodex_v3_runtime::{
    build_v3_hub_req_inbound_01_client_raw,
    build_v3_hub_resp_outbound_05_from_v3_hub_resp_continuation_04,
    build_v3_provider_resp_inbound_01_raw,
    build_v3_server_resp_outbound_06_from_v3_hub_resp_outbound_05,
    compile_v3_hub_relay_request_hooks, compile_v3_hub_relay_response_hooks,
    project_v3_responses_sse_as_anthropic_events, V3HubAttachmentHistoryPolicy,
    V3HubContinuationCommit, V3HubContinuationLookup, V3HubContinuationOwnership,
    V3HubContinuationScope, V3HubEntryProtocol, V3HubExecutionMode, V3HubInvocationSource,
    V3HubProviderWireProtocol, V3HubRelayRequestError, V3HubRelayResponseError,
    V3HubRelayResponseHookProfile, V3HubRelayToolKind, V3HubServertoolRequestProfile,
    V3HubServertoolResponseAction, V3HubTransportIntent,
};
use serde_json::{json, Value};

const HISTORICAL_IMAGE_PLACEHOLDER: &str = "[routecodex historical media released]";

fn scope() -> V3HubContinuationScope {
    scope_for(V3HubEntryProtocol::Responses)
}

fn scope_for(entry_protocol: V3HubEntryProtocol) -> V3HubContinuationScope {
    V3HubContinuationScope::new(
        entry_protocol,
        "server-tool-parity",
        "relay-tool-parity",
        "session-tool-parity",
    )
}

fn raw_request(payload: Value) -> routecodex_v3_runtime::V3HubReqInbound01ClientRaw {
    raw_request_for(
        payload,
        V3HubEntryProtocol::Responses,
        V3HubTransportIntent::Json,
    )
}

fn raw_request_for(
    payload: Value,
    entry_protocol: V3HubEntryProtocol,
    transport_intent: V3HubTransportIntent,
) -> routecodex_v3_runtime::V3HubReqInbound01ClientRaw {
    build_v3_hub_req_inbound_01_client_raw(
        payload,
        entry_protocol,
        V3HubInvocationSource::Client,
        transport_intent,
    )
}

fn relay_response(
    payload: Value,
    transport: V3HubTransportIntent,
) -> routecodex_v3_runtime::V3ProviderRespInbound01Raw {
    relay_response_for(payload, V3HubEntryProtocol::Responses, transport)
}

fn relay_response_for(
    payload: Value,
    entry_protocol: V3HubEntryProtocol,
    transport: V3HubTransportIntent,
) -> routecodex_v3_runtime::V3ProviderRespInbound01Raw {
    build_v3_provider_resp_inbound_01_raw(
        payload,
        entry_protocol,
        provider_protocol_for_entry(entry_protocol),
        V3HubContinuationOwnership::New,
        V3HubExecutionMode::Relay,
        V3HubInvocationSource::Client,
        transport,
    )
}

fn provider_protocol_for_entry(entry_protocol: V3HubEntryProtocol) -> V3HubProviderWireProtocol {
    match entry_protocol {
        V3HubEntryProtocol::Responses => V3HubProviderWireProtocol::Responses,
        V3HubEntryProtocol::Anthropic => V3HubProviderWireProtocol::Responses,
        V3HubEntryProtocol::Gemini => V3HubProviderWireProtocol::Gemini,
        V3HubEntryProtocol::OpenAiChat => V3HubProviderWireProtocol::OpenAiChat,
    }
}

fn restored_multitool_context() -> Value {
    json!({
        "id": "resp_tool_parity",
        "status": "requires_action",
        "output": [
            {"type":"function_call","call_id":"call_function","name":"lookup","arguments":"{}"},
            {"type":"custom_tool_call","call_id":"call_custom","name":"custom.render","input":"{}"},
            {"type":"function_call","call_id":"call_servertool","name":"servertool.exec","arguments":"{}"},
            {"type":"function_call","call_id":"call_apply_patch","name":"apply_patch","arguments":"{}"},
            {"type":"function_call","call_id":"call_mcp","name":"mcp.read_file","arguments":"{}"},
            {"type":"function_call","call_id":"call_native","name":"native.exec_command","arguments":"{}"}
        ]
    })
}

fn current_tool_round_payload() -> Value {
    json!({
        "input": [
            {"type":"function_call","call_id":"call_current","name":"lookup","arguments":"{}"},
            {"type":"function_call_output","call_id":"call_current","output":"current ok"}
        ]
    })
}

#[test]
fn protocol_transport_continuation_matrix_uses_one_chat_process_governance_path() {
    let request_hooks = compile_v3_hub_relay_request_hooks();
    let response_hooks = compile_v3_hub_relay_response_hooks();
    let entries = [
        V3HubEntryProtocol::Responses,
        V3HubEntryProtocol::Anthropic,
        V3HubEntryProtocol::OpenAiChat,
        V3HubEntryProtocol::Gemini,
    ];
    let transports = [V3HubTransportIntent::Json, V3HubTransportIntent::Sse];

    for entry in entries {
        for transport in transports {
            let matrix_scope = scope_for(entry);
            let new_outcome = request_hooks
                .run_with_attachment_history_policy(
                    raw_request_for(current_tool_round_payload(), entry, transport),
                    &V3HubContinuationLookup::new(None, matrix_scope.clone()),
                    &V3HubServertoolRequestProfile::disabled(),
                    V3HubAttachmentHistoryPolicy::Preserve,
                )
                .expect("new/current-history tool output must be governed at Req04");
            assert_eq!(new_outcome.continuation(), V3HubContinuationOwnership::New);
            assert_eq!(new_outcome.tool_output_count(), 1);

            let local_lookup =
                V3HubContinuationLookup::new(Some("ctx_tool_parity"), matrix_scope.clone())
                    .with_local_context(
                        "ctx_tool_parity",
                        matrix_scope.clone(),
                        restored_multitool_context(),
                    );
            let local_outcome = request_hooks
                .run_with_attachment_history_policy(
                    raw_request_for(
                        json!({"input":[{"type":"function_call_output","call_id":"call_function","output":"restored ok"}]}),
                        entry,
                        transport,
                    ),
                    &local_lookup,
                    &V3HubServertoolRequestProfile::enabled(["servertool.request"]),
                    V3HubAttachmentHistoryPolicy::Preserve,
                )
                .expect("restored continuation tool output must be governed at Req04");
            assert_eq!(
                local_outcome.continuation(),
                V3HubContinuationOwnership::RouteCodexLocalOwned
            );
            assert!(local_outcome.restored_local_context());
            assert_eq!(local_outcome.tool_output_count(), 1);

            let remote_lookup =
                V3HubContinuationLookup::new(Some("remote_tool_parity"), matrix_scope.clone())
                    .with_remote_binding("remote_tool_parity", matrix_scope);
            let remote_outcome = request_hooks
                .run(
                    raw_request_for(json!({"input":[]}), entry, transport),
                    &remote_lookup,
                    &V3HubServertoolRequestProfile::disabled(),
                )
                .expect("remote continuation classification must not local-restore relay history");
            assert_eq!(
                remote_outcome.continuation(),
                V3HubContinuationOwnership::RemoteProviderOwned
            );
            assert!(!remote_outcome.restored_local_context());

            let resp02 = response_hooks
                .normalize(relay_response_for(
                    restored_multitool_context(),
                    entry,
                    transport,
                ))
                .expect("entry/transport response normalizes before Resp03");
            let resp03 = response_hooks
                .govern(
                    resp02,
                    &V3HubRelayResponseHookProfile::new(["servertool.exec"]),
                )
                .expect("entry/transport response tool harvest is governed at Resp03");
            assert_eq!(
                resp03.tool_call_kinds(),
                vec![
                    V3HubRelayToolKind::Function,
                    V3HubRelayToolKind::Custom,
                    V3HubRelayToolKind::Servertool,
                    V3HubRelayToolKind::ApplyPatch,
                    V3HubRelayToolKind::Mcp,
                    V3HubRelayToolKind::Native,
                ]
            );
        }
    }
}

#[test]
fn request_governance_matches_function_custom_servertool_and_internal_tool_outputs_to_restored_context(
) {
    let hooks = compile_v3_hub_relay_request_hooks();
    let lookup = V3HubContinuationLookup::new(Some("ctx_tool_parity"), scope()).with_local_context(
        "ctx_tool_parity",
        scope(),
        restored_multitool_context(),
    );
    let outcome = hooks
        .run_with_attachment_history_policy(
            raw_request(json!({
                "input": [
                    {"type":"function_call_output","call_id":"call_function","output":"function ok"},
                    {"type":"custom_tool_call_output","call_id":"call_custom","output":"custom ok"},
                    {"type":"function_call_output","call_id":"call_servertool","output":"servertool ok"},
                    {"type":"function_call_output","call_id":"call_apply_patch","output":"patch ok"},
                    {"type":"function_call_output","call_id":"call_mcp","output":"mcp ok"},
                    {"type":"function_call_output","call_id":"call_native","output":"native ok"}
                ]
            })),
            &lookup,
            &V3HubServertoolRequestProfile::enabled(["servertool.request"]),
            V3HubAttachmentHistoryPolicy::Preserve,
        )
        .expect("Req04 tool governance accepts only outputs backed by restored tool calls");

    assert!(outcome.restored_local_context());
    assert_eq!(outcome.tool_output_count(), 6);
}

#[test]
fn apply_patch_response_is_projected_to_freeform_custom_tool_before_commit() {
    let hooks = compile_v3_hub_relay_response_hooks();
    let patch = "*** Begin Patch\n*** Update File: src/main.rs\n@@\n-old\n+new\n*** End Patch";
    let resp02 = hooks
        .normalize(relay_response(
            json!({
                "id":"resp_apply_patch",
                "status":"requires_action",
                "output":[{
                    "type":"function_call",
                    "call_id":"call_apply_patch_freeform",
                    "name":"apply_patch",
                    "arguments": serde_json::to_string(&json!({"patch": patch})).unwrap()
                }]
            }),
            V3HubTransportIntent::Json,
        ))
        .unwrap();
    let resp03 = hooks
        .govern(resp02, &V3HubRelayResponseHookProfile::empty())
        .unwrap();
    assert_eq!(
        resp03.tool_call_kinds(),
        vec![V3HubRelayToolKind::ApplyPatch]
    );
    let resp04 = hooks.commit(resp03).unwrap();
    let payload = resp04.canonical_context_payload().unwrap();
    assert_eq!(payload["output"][0]["type"], "custom_tool_call");
    assert_eq!(payload["output"][0]["name"], "apply_patch");
    assert_eq!(payload["output"][0]["call_id"], "call_apply_patch_freeform");
    assert_eq!(payload["output"][0]["input"], patch);
    assert!(payload["output"][0].get("arguments").is_none());
}

#[test]
fn apply_patch_tool_output_error_is_normalized_and_kept_as_next_turn_tool_output() {
    let hooks = compile_v3_hub_relay_request_hooks();
    let lookup = V3HubContinuationLookup::new(Some("ctx_apply_patch"), scope()).with_local_context(
        "ctx_apply_patch",
        scope(),
        json!({
            "id": "resp_apply_patch",
            "status": "requires_action",
            "output": [{
                "type": "custom_tool_call",
                "call_id": "call_apply_patch_freeform",
                "name": "apply_patch",
                "input": "*** Begin Patch\n*** Update File: src/main.rs\n@@\n-old\n+new\n*** End Patch"
            }]
        }),
    );
    let outcome = hooks
        .run(
            raw_request(json!({
                "input":[{
                    "type":"custom_tool_call_output",
                    "call_id":"call_apply_patch_freeform",
                    "output":"apply_patch verification failed: invalid patch for /tmp/codex-patch-test/new.txt"
                }]
            })),
            &lookup,
            &V3HubServertoolRequestProfile::disabled(),
        )
        .unwrap();
    assert_eq!(outcome.tool_output_count(), 1);
    let output = outcome.payload()["input"][0]["output"].as_str().unwrap();
    assert!(output.starts_with("APPLY_PATCH_ERROR: apply_patch did not apply"));
    assert!(output.contains("Retry with apply_patch only"));
    assert!(output.contains("workspace-relative"));
    assert!(!output.contains("/tmp/codex-patch-test"));
}

#[test]
fn apply_patch_legacy_function_call_accepts_custom_output_after_client_projection() {
    let hooks = compile_v3_hub_relay_request_hooks();
    let lookup = V3HubContinuationLookup::new(Some("ctx_apply_patch_legacy"), scope())
        .with_local_context(
            "ctx_apply_patch_legacy",
            scope(),
            json!({
                "id": "resp_apply_patch_legacy",
                "status": "requires_action",
                "output": [{
                    "type": "function_call",
                    "call_id": "call_apply_patch_legacy",
                    "name": "apply_patch",
                    "arguments": "{}"
                }]
            }),
        );
    let outcome = hooks
        .run(
            raw_request(json!({
                "input":[{
                    "type":"custom_tool_call_output",
                    "call_id":"call_apply_patch_legacy",
                    "output":"aborted"
                }]
            })),
            &lookup,
            &V3HubServertoolRequestProfile::disabled(),
        )
        .unwrap();
    assert_eq!(outcome.tool_output_count(), 1);
    assert!(outcome.payload()["input"][0]["output"]
        .as_str()
        .unwrap()
        .starts_with("APPLY_PATCH_ERROR:"));
}

#[test]
fn stopless_hook_blackbox_projects_cli_then_rewrites_next_request_inside_chat_process() {
    let response_hooks = compile_v3_hub_relay_response_hooks();
    let request_hooks = compile_v3_hub_relay_request_hooks();
    let resp02 = response_hooks
        .normalize(relay_response(
            json!({
                "id":"resp_stopless_blackbox",
                "status":"completed",
                "output":[{"type":"output_text","text":"stopping without schema"}]
            }),
            V3HubTransportIntent::Json,
        ))
        .unwrap();
    let resp03 = response_hooks
        .govern(
            resp02,
            &V3HubRelayResponseHookProfile::empty().with_stopless_reasoning_stop(),
        )
        .unwrap();
    let resp04 = response_hooks.commit(resp03).unwrap();
    let projected = resp04.canonical_context_payload().unwrap().clone();
    assert_eq!(projected["output"][0]["name"], "exec_command");
    assert_eq!(projected["output"][0]["call_id"], "call_stopless_reasoning");
    assert!(projected["output"][0]["arguments"]
        .as_str()
        .unwrap()
        .contains("routecodex hook run reasoningStop"));

    let lookup = V3HubContinuationLookup::new(Some("ctx_stopless_blackbox"), scope())
        .with_local_context("ctx_stopless_blackbox", scope(), projected);
    let outcome = request_hooks
        .run(
            raw_request(json!({
                "input":[{
                    "type":"function_call_output",
                    "call_id":"call_stopless_reasoning",
                    "output":"{\"next_step\":\"blackbox next request text\"}"
                }]
            })),
            &lookup,
            &V3HubServertoolRequestProfile::stopless_reasoning_stop(),
        )
        .unwrap();
    assert_eq!(outcome.tool_output_count(), 0);
    assert_eq!(
        outcome.payload()["input"],
        json!([{"role":"user","content":"blackbox next request text"}])
    );
    assert!(outcome.payload()["instructions"]
        .as_str()
        .unwrap()
        .contains("stopreason"));
    let serialized = serde_json::to_string(outcome.payload()).unwrap();
    for forbidden in [
        "function_call_output",
        "call_stopless_reasoning",
        "routecodex hook run reasoningStop",
        "exec_command",
    ] {
        assert!(
            !serialized.contains(forbidden),
            "rewritten request leaked stopless CLI artifact: {forbidden}"
        );
    }
}

#[test]
fn stopless_hook_blackbox_terminal_schema_does_not_enter_cli_roundtrip() {
    let response_hooks = compile_v3_hub_relay_response_hooks();
    let resp02 = response_hooks
        .normalize(relay_response(
            json!({
                "id":"resp_stopless_terminal_blackbox",
                "status":"completed",
                "output":[{
                    "type":"output_text",
                    "text":"{\"stopreason\":0,\"has_evidence\":1,\"evidence\":[\"done\"]}"
                }]
            }),
            V3HubTransportIntent::Json,
        ))
        .unwrap();
    let resp03 = response_hooks
        .govern(
            resp02,
            &V3HubRelayResponseHookProfile::empty().with_stopless_reasoning_stop(),
        )
        .unwrap();
    assert_eq!(resp03.tool_call_count(), 0);
    let resp04 = response_hooks.commit(resp03).unwrap();
    assert_eq!(resp04.action(), V3HubContinuationCommit::None);
    assert_eq!(resp04.canonical_context_count(), 0);
    assert_eq!(
        resp04.finalized_payload()["output"][0]["text"],
        "{\"stopreason\":0,\"has_evidence\":1,\"evidence\":[\"done\"]}"
    );
}

#[test]
fn stopless_hook_blackbox_disabled_request_profile_keeps_cli_result_as_tool_output() {
    let response_hooks = compile_v3_hub_relay_response_hooks();
    let request_hooks = compile_v3_hub_relay_request_hooks();
    let resp02 = response_hooks
        .normalize(relay_response(
            json!({
                "id":"resp_stopless_disabled_request_blackbox",
                "status":"completed",
                "output":[{"type":"output_text","text":"missing stop schema"}]
            }),
            V3HubTransportIntent::Json,
        ))
        .unwrap();
    let resp03 = response_hooks
        .govern(
            resp02,
            &V3HubRelayResponseHookProfile::empty().with_stopless_reasoning_stop(),
        )
        .unwrap();
    let resp04 = response_hooks.commit(resp03).unwrap();
    let projected = resp04.canonical_context_payload().unwrap().clone();

    let lookup = V3HubContinuationLookup::new(Some("ctx_stopless_disabled_request"), scope())
        .with_local_context("ctx_stopless_disabled_request", scope(), projected);
    let outcome = request_hooks
        .run(
            raw_request(json!({
                "input":[{
                    "type":"function_call_output",
                    "call_id":"call_stopless_reasoning",
                    "output":"{\"next_step\":\"must remain a tool output\"}"
                }]
            })),
            &lookup,
            &V3HubServertoolRequestProfile::disabled(),
        )
        .unwrap();
    assert_eq!(outcome.tool_output_count(), 1);
    assert_eq!(
        outcome.payload()["input"][0]["type"],
        "function_call_output"
    );
    assert_eq!(
        outcome.payload()["input"][0]["output"],
        "{\"next_step\":\"must remain a tool output\"}"
    );
    assert!(outcome.payload().get("instructions").is_none());
}

#[test]
fn stopless_hook_blackbox_malformed_cli_result_fails_before_next_turn_governance() {
    let response_hooks = compile_v3_hub_relay_response_hooks();
    let request_hooks = compile_v3_hub_relay_request_hooks();
    let resp02 = response_hooks
        .normalize(relay_response(
            json!({
                "id":"resp_stopless_malformed_blackbox",
                "status":"completed",
                "output":[{"type":"output_text","text":"missing stop schema"}]
            }),
            V3HubTransportIntent::Json,
        ))
        .unwrap();
    let resp03 = response_hooks
        .govern(
            resp02,
            &V3HubRelayResponseHookProfile::empty().with_stopless_reasoning_stop(),
        )
        .unwrap();
    let resp04 = response_hooks.commit(resp03).unwrap();
    let projected = resp04.canonical_context_payload().unwrap().clone();

    let lookup = V3HubContinuationLookup::new(Some("ctx_stopless_malformed"), scope())
        .with_local_context("ctx_stopless_malformed", scope(), projected);
    assert!(matches!(
        request_hooks.run(
            raw_request(json!({
                "input":[{
                    "type":"function_call_output",
                    "call_id":"call_stopless_reasoning",
                    "output":"not json"
                }]
            })),
            &lookup,
            &V3HubServertoolRequestProfile::stopless_reasoning_stop(),
        ),
        Err(V3HubRelayRequestError::MalformedStoplessCliOutput {
            reason: "output must be JSON",
            ..
        })
    ));
}

#[test]
fn request_governance_rejects_orphan_output_wrong_kind_and_missing_call_id() {
    let hooks = compile_v3_hub_relay_request_hooks();
    let lookup = V3HubContinuationLookup::new(Some("ctx_tool_parity"), scope()).with_local_context(
        "ctx_tool_parity",
        scope(),
        restored_multitool_context(),
    );

    assert!(matches!(
        hooks.run(
            raw_request(
                json!({"input":[{"type":"function_call_output","call_id":"missing","output":"x"}]})
            ),
            &lookup,
            &V3HubServertoolRequestProfile::disabled(),
        ),
        Err(V3HubRelayRequestError::OrphanToolOutput { .. })
    ));

    assert!(matches!(
        hooks.run(
            raw_request(json!({"input":[{"type":"function_call_output","call_id":"call_function","output":"x"}]})),
            &V3HubContinuationLookup::new(None, scope()),
            &V3HubServertoolRequestProfile::disabled(),
        ),
        Err(V3HubRelayRequestError::OrphanToolOutput { .. })
    ));

    assert!(matches!(
        hooks.run(
            raw_request(json!({"input":[{"type":"function_call_output","call_id":"call_custom","output":"x"}]})),
            &lookup,
            &V3HubServertoolRequestProfile::disabled(),
        ),
        Err(V3HubRelayRequestError::ToolOutputKindMismatch { .. })
    ));

    assert!(matches!(
        hooks.run(
            raw_request(
                json!({"input":[{"type":"custom_tool_call_output","output":"missing id"}]})
            ),
            &V3HubContinuationLookup::new(None, scope()),
            &V3HubServertoolRequestProfile::disabled(),
        ),
        Err(V3HubRelayRequestError::MalformedToolOutput { .. })
    ));
}

#[test]
fn attachment_history_placeholder_releases_only_historical_media_and_preserves_current_payload() {
    let hooks = compile_v3_hub_relay_request_hooks();
    let outcome = hooks
        .run_with_attachment_history_policy(
            raw_request(json!({
                "input": [
                    {"role":"user","content":[{"type":"input_image","image_url":"data:image/png;base64,HISTORY"}]},
                    {"type":"function_call","call_id":"call_inline","name":"vision_lookup","arguments":"{}"},
                    {"type":"function_call_output","call_id":"call_inline","output":"before data:image/png;base64,HISTORY_INLINE after"},
                    {"role":"user","content":[{"type":"input_image","image_url":"data:image/png;base64,CURRENT"}]}
                ]
            })),
            &V3HubContinuationLookup::new(None, scope()),
            &V3HubServertoolRequestProfile::disabled(),
            V3HubAttachmentHistoryPolicy::Placeholder {
                placeholder: HISTORICAL_IMAGE_PLACEHOLDER,
            },
        )
        .expect("Req04 attachment history governance");
    let serialized = serde_json::to_string(outcome.payload()).unwrap();

    assert!(!serialized.contains("HISTORY"));
    assert!(serialized.contains(HISTORICAL_IMAGE_PLACEHOLDER));
    assert!(serialized.contains("data:image/png;base64,CURRENT"));
}

#[test]
fn attachment_history_missing_resource_fails_without_trimming_current_request() {
    let hooks = compile_v3_hub_relay_request_hooks();
    assert!(matches!(
        hooks.run_with_attachment_history_policy(
            raw_request(json!({
                "input": [
                    {"role":"user","content":[{"type":"input_image"}]},
                    {"role":"user","content":[{"type":"input_image","image_url":"data:image/png;base64,CURRENT"}]}
                ]
            })),
            &V3HubContinuationLookup::new(None, scope()),
            &V3HubServertoolRequestProfile::disabled(),
            V3HubAttachmentHistoryPolicy::Placeholder {
                placeholder: HISTORICAL_IMAGE_PLACEHOLDER,
            },
        ),
        Err(V3HubRelayRequestError::AttachmentResourceMissing { .. })
    ));
}

#[test]
fn response_governance_classifies_function_custom_servertool_and_internal_tools_before_commit() {
    let hooks = compile_v3_hub_relay_response_hooks();
    let resp02 = hooks
        .normalize(relay_response(
            restored_multitool_context(),
            V3HubTransportIntent::Json,
        ))
        .unwrap();
    let resp03 = hooks
        .govern(
            resp02,
            &V3HubRelayResponseHookProfile::new(["servertool.exec"]),
        )
        .unwrap();
    assert_eq!(
        resp03.tool_call_kinds(),
        vec![
            V3HubRelayToolKind::Function,
            V3HubRelayToolKind::Custom,
            V3HubRelayToolKind::Servertool,
            V3HubRelayToolKind::ApplyPatch,
            V3HubRelayToolKind::Mcp,
            V3HubRelayToolKind::Native,
        ]
    );
    assert_eq!(
        resp03.servertool_action(),
        V3HubServertoolResponseAction::FollowupRequired
    );

    let resp04 = hooks.commit(resp03).unwrap();
    assert_eq!(resp04.action(), V3HubContinuationCommit::LocalContext);
    assert_eq!(
        resp04.canonical_tool_call_kinds(),
        vec![
            V3HubRelayToolKind::Function,
            V3HubRelayToolKind::Custom,
            V3HubRelayToolKind::Servertool,
            V3HubRelayToolKind::ApplyPatch,
            V3HubRelayToolKind::Mcp,
            V3HubRelayToolKind::Native,
        ]
    );
}

#[tokio::test]
async fn responses_sse_arbitrary_chunks_preserve_delta_order_and_terminal_tool_order() {
    let chunks = [
        b"event: response.reasoning_summary_text.delta\ndata: {\"delta\":\"think\"}\n\n"
            .to_vec(),
        b"event: response.output_item.added\ndata: {\"item\":{\"type\":\"function_call\",\"call_id\":\"call_sse\",\"name\":\"lookup\",\"arguments\":\"\"}}\n\n".to_vec(),
        b"event: response.function_call_arguments.delta\ndata: {\"delta\":\"{\\\"q\\\":\"}\n\n"
            .to_vec(),
        b"event: response.function_call_arguments.delta\ndata: {\"delta\":\"\\\"x\\\"}\"}\n\n"
            .to_vec(),
        b"event: response.completed\ndata: {\"response\":{\"id\":\"resp_sse\",\"status\":\"completed\"}}\n\n"
            .to_vec(),
    ];
    let stream = Box::pin(stream::iter(chunks.into_iter().map(Ok)));
    let projection = project_v3_responses_sse_as_anthropic_events(stream)
        .await
        .expect("incremental SSE projection");
    let (canonical, client_events) = projection.into_parts();

    assert_eq!(canonical["output"][0]["type"], "reasoning");
    assert_eq!(canonical["output"][1]["type"], "function_call");
    assert_eq!(canonical["output"][1]["call_id"], "call_sse");
    assert_eq!(canonical["output"][1]["arguments"], "{\"q\":\"x\"}");
    assert_eq!(client_events.last().unwrap()["event"], "message_stop");

    let resp02 = compile_v3_hub_relay_response_hooks()
        .normalize(relay_response(canonical, V3HubTransportIntent::Sse))
        .unwrap();
    let resp03 = compile_v3_hub_relay_response_hooks()
        .govern(resp02, &V3HubRelayResponseHookProfile::empty())
        .unwrap();
    let resp04 = compile_v3_hub_relay_response_hooks()
        .commit(resp03)
        .unwrap();
    let resp05 = build_v3_hub_resp_outbound_05_from_v3_hub_resp_continuation_04(resp04);
    let resp06 = build_v3_server_resp_outbound_06_from_v3_hub_resp_outbound_05(resp05);
    assert_eq!(
        resp06.response_exit_node(),
        "V3ServerRespOutbound06ClientFrame"
    );
    assert_eq!(resp06.transport_intent(), V3HubTransportIntent::Sse);
}

#[test]
fn provider_and_client_payloads_reject_routecodex_control_leakage() {
    let hooks = compile_v3_hub_relay_response_hooks();
    let resp01 = relay_response(
        json!({
            "id":"resp_leak",
            "status":"completed",
            "metadata_center":{"continuation_owner":"relay"},
            "output":[]
        }),
        V3HubTransportIntent::Json,
    );
    assert!(matches!(
        hooks.normalize(resp01),
        Err(V3HubRelayResponseError::SideChannelLeaked { .. })
    ));

    assert!(matches!(
        compile_v3_hub_relay_request_hooks().run(
            raw_request(json!({"input":[],"routecodex_internal":{"debug":true}})),
            &V3HubContinuationLookup::new(None, scope()),
            &V3HubServertoolRequestProfile::disabled(),
        ),
        Err(V3HubRelayRequestError::SideChannelLeaked { .. })
    ));
}
