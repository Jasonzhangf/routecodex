use super::*;
use serde_json::Value;

pub(crate) fn load_v3_responses_relay_stopless_control_state(
    manifest: &V3Config05ManifestPublished,
    server_id: &str,
    stopless_control: Option<&V3ResponsesRelayStoplessControlExecution<'_>>,
) -> Result<Option<V3StoplessCenterState>, V3ResponsesRelayRuntimeError> {
    if !v3_stopless_center_enabled_for_server(manifest, server_id) {
        return Ok(None);
    }
    let Some(stopless_control) = stopless_control else {
        return Ok(None);
    };
    if !stopless_control.scope.has_client_session_scope() {
        return Ok(None);
    }
    stopless_control
        .control
        .load_for_scope(&stopless_control.scope)
}

pub(crate) fn store_v3_responses_relay_stopless_control_state(
    manifest: &V3Config05ManifestPublished,
    server_id: &str,
    stopless_control: Option<&V3ResponsesRelayStoplessControlExecution<'_>>,
    state: V3StoplessCenterState,
) -> Result<(), V3ResponsesRelayRuntimeError> {
    if !v3_stopless_center_enabled_for_server(manifest, server_id) {
        return Ok(());
    }
    let Some(stopless_control) = stopless_control else {
        return Ok(());
    };
    if !stopless_control.commit_effects {
        return Ok(());
    }
    if !stopless_control.scope.has_client_session_scope() {
        return Ok(());
    }
    stopless_control
        .control
        .store_for_scope(
            &stopless_control.scope,
            state,
            V3ServerToolCenterWriteOrigin {
                module: "responses_relay_runtime",
                symbol: "store_v3_responses_relay_stopless_control_state",
                stage: "resp_chat_process_03",
            },
            Some("resp03 save stopless state to relay servertool center"),
            None,
        )
}

pub(crate) fn clear_v3_responses_relay_stopless_control_state(
    manifest: &V3Config05ManifestPublished,
    server_id: &str,
    stopless_control: Option<&V3ResponsesRelayStoplessControlExecution<'_>>,
) -> Result<(), V3ResponsesRelayRuntimeError> {
    if !v3_stopless_center_enabled_for_server(manifest, server_id) {
        return Ok(());
    }
    let Some(stopless_control) = stopless_control else {
        return Ok(());
    };
    if !stopless_control.commit_effects {
        return Ok(());
    }
    if !stopless_control.scope.has_client_session_scope() {
        return Ok(());
    }
    stopless_control
        .control
        .clear_for_scope(
            &stopless_control.scope,
            V3ServerToolCenterWriteOrigin {
                module: "responses_relay_runtime",
                symbol: "clear_v3_responses_relay_stopless_control_state",
                stage: "resp_chat_process_03",
            },
            Some("resp03 clear stopless state after terminal completion"),
            None,
        )
}

pub(crate) fn apply_v3_responses_relay_stopless_control_transition(
    manifest: &V3Config05ManifestPublished,
    server_id: &str,
    stopless_control: Option<&V3ResponsesRelayStoplessControlExecution<'_>>,
    response_stopless_state: Option<V3StoplessCenterState>,
) -> Result<(), V3ResponsesRelayRuntimeError> {
    match response_stopless_state {
        Some(state) => store_v3_responses_relay_stopless_control_state(
            manifest,
            server_id,
            stopless_control,
            state,
        ),
        None => {
            clear_v3_responses_relay_stopless_control_state(manifest, server_id, stopless_control)
        }
    }
}

pub(crate) fn apply_v3_responses_relay_stopless_control_request_transition(
    manifest: &V3Config05ManifestPublished,
    server_id: &str,
    stopless_control: Option<&V3ResponsesRelayStoplessControlExecution<'_>>,
    restored_state_loaded: bool,
    request_stopless_state: Option<&V3StoplessCenterState>,
) -> Result<(), V3ResponsesRelayRuntimeError> {
    match request_stopless_state {
        Some(state) => store_v3_responses_relay_stopless_control_state(
            manifest,
            server_id,
            stopless_control,
            state.clone(),
        ),
        None if restored_state_loaded => {
            clear_v3_responses_relay_stopless_control_state(manifest, server_id, stopless_control)
        }
        None => Ok(()),
    }
}

/// Mode B：Req04 激活的 websearch ServerTool 实例（LocalToolSurfaceActive）
/// 存入 relay ServerToolCenter websearch 桶，供 Resp03 同轮拦截判定。
/// 未激活时不做任何写（不存在"清除未激活状态"的语义）。
pub(crate) fn apply_v3_responses_relay_web_search_control_request_transition(
    manifest: &V3Config05ManifestPublished,
    server_id: &str,
    stopless_control: Option<&V3ResponsesRelayStoplessControlExecution<'_>>,
    request_web_search_state: Option<&V3WebSearchCenterState>,
) -> Result<(), V3ResponsesRelayRuntimeError> {
    let Some(state) = request_web_search_state else {
        return Ok(());
    };
    // web_search 与 stopless 解耦：web_search 配对状态存桶不依赖 stopless
    // feature gate 或 client session scope（stopless 与 web_search 唯一关系是
    // 都使用 servertool center 存储；web_search 自己的配对生命周期独立）。
    let Some(stopless_control) = stopless_control else {
        return Ok(());
    };
    if !stopless_control.commit_effects {
        return Ok(());
    }
    stopless_control
        .control
        .web_search_store_for_scope(
            &stopless_control.scope,
            state.clone(),
            V3ServerToolCenterWriteOrigin {
                module: "responses_relay_runtime",
                symbol: "apply_v3_responses_relay_web_search_control_request_transition",
                stage: "req_chat_process",
            },
            Some("req04 web_search surface activated, store paired state"),
            None,
        )
}

pub(crate) fn clear_v3_responses_relay_stopless_control_on_pre_resp03_terminal(
    manifest: &V3Config05ManifestPublished,
    server_id: &str,
    stopless_control: Option<&V3ResponsesRelayStoplessControlExecution<'_>>,
    request_stopless_state: Option<&V3StoplessCenterState>,
) -> Result<(), V3ResponsesRelayRuntimeError> {
    if request_stopless_state.is_none() {
        return Ok(());
    }
    clear_v3_responses_relay_stopless_control_state(manifest, server_id, stopless_control)
}
