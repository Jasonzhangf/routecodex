// Direct Mode B websearch next-round pair verification test, split from
// kernel/tests.rs to satisfy verify:v3-file-size ratchet. Semantics unchanged:
// this module is a direct child of kernel::tests, so `use super::*` resolves
// identically to the former inline test function.

use super::*;

#[tokio::test]
async fn direct_mode_b_websearch_next_round_pair_verifies_and_completes() {
    let manifest = direct_web_search_mode_b_manifest();
    let continuation_state = V3ResponsesDirectContinuationState::default();
    let stopless_control = V3ResponsesDirectStoplessControlState::default();
    let continuation_scope = V3ResponsesDirectContinuationScope::responses(
        "/v1/responses",
        "session-ws-direct-2",
        "conversation-ws-direct-2",
        4444,
        "default",
    );
    // 前置：上一轮搜索结果已捕获（SearchResultCaptured，original_call_id=call_ws_1）。
    let scope = V3ResponsesDirectStoplessControlScope::from(&continuation_scope);
    let captured = crate::hub_v1::V3WebSearchCenterState::new()
        .transition_to(
            crate::hub_v1::V3WebSearchCenterPhase::LocalToolSurfaceActive,
            "test_seeded",
        )
        .expect("seed surface")
        .transition_to(
            crate::hub_v1::V3WebSearchCenterPhase::ToolCallObserved,
            "test_seeded",
        )
        .expect("seed observed")
        .transition_to(
            crate::hub_v1::V3WebSearchCenterPhase::SearchDispatchPrepared,
            "test_seeded",
        )
        .expect("seed prepared")
        .transition_to(
            crate::hub_v1::V3WebSearchCenterPhase::SearchInFlight,
            "test_seeded",
        )
        .expect("seed in-flight")
        .transition_to(
            crate::hub_v1::V3WebSearchCenterPhase::SearchResultCaptured,
            "test_seeded",
        )
        .expect("seed captured")
        .with_original_call_id(Some("call_ws_1".to_string()))
        .with_query(Some("routecodex".to_string()))
        .with_normalized_result(Some(
            json!({"query": "routecodex", "text_result": "search result"}),
        ));
    stopless_control
        .web_search_store_for_scope(
            &scope,
            captured,
            V3ServerToolCenterWriteOrigin {
                module: "kernel_tests",
                symbol: "direct_web_search_control_pair_then_replay",
                stage: "test",
            },
            Some("test seed web_search state"),
            None,
        )
        .expect("seed center");
    // 下一轮：客户端把上一轮配对 function_call_output 原样送回。
    let raw = test_responses_raw(
        "default",
        "req-ws-direct-2",
        "exec-ws-direct-2",
        json!({
            "model": "client-model",
            "input": [{
                "type": "function_call_output",
                "call_id": "call_ws_1",
                "output": "search result"
            }]
        }),
    );
    let output = execute_v3_responses_direct_runtime_kernel_with_continuation_and_stopless_control(
        &continuation_state,
        &stopless_control,
        &manifest,
        raw,
        continuation_scope.clone(),
        crate::register_responses_direct_hooks(),
        &WebSearchHopTransport,
        2_000,
    )
    .await;
    assert_eq!(output.client_payload.status, 200, "{output:?}");
    // Req04 配对验证：状态机收尾 Completed（不重建 payload）。
    let state = stopless_control
        .web_search_load_for_scope(&scope)
        .expect("center load")
        .expect("websearch state present");
    assert_eq!(
        state.phase(),
        crate::hub_v1::V3WebSearchCenterPhase::Completed
    );
}
