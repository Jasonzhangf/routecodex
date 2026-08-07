//! V3 Mode B web_search 本地搜索 hop 语义。
//!
//! 归属 `v3.web_search_servertool_state_machine`：
//! - Resp03 拦截后的搜索 hop（backend binding direct pin + 一次 provider 往返）
//! - 响应文本归一化（Responses output_text / Chat choices）
//! - hosted `web_search_call` 等价投影 + 原 call_id 配对 `function_call_output`
//! - 下一轮 Req04 配对验证收尾（SearchResultCaptured -> Completed）
//!
//! 控制状态只进 ServerToolCenter 控制资源；这里投影的是协议等价结果，
//! 不重建 entry payload、不重入主模型、不做第二套 VR。

use super::V3HubRelayResponseError;
use super::responses_relay_runtime::{
    build_v3_provider_transport_request_for_protocol, find_responses_tool_output_ids,
    provider_target, provider_wire_protocol_for_selected_candidate,
    V3ResponsesRelayRuntimeError, V3ResponsesRelayStoplessControlExecution,
    V3ResponsesRelayStoplessControlScope, V3ResponsesRelayStoplessControlState,
};
use super::{
    build_provider_req_compat_06_from_v3_hub_req_outbound_07,
    build_v3_hub_req_chat_process_04_from_v3_hub_req_continuation_03,
    build_v3_hub_req_continuation_03_from_v3_hub_req_inbound_02,
    build_v3_hub_req_execution_05_from_v3_hub_req_chat_process_04,
    build_v3_hub_req_inbound_01_client_raw,
    build_v3_hub_req_inbound_02_result_from_v3_hub_req_inbound_01,
    build_v3_hub_req_outbound_07_from_v3_hub_req_target_06,
    build_v3_hub_req_target_06_from_v3_hub_req_execution_05,
    build_v3_provider_req_outbound_08_from_provider_req_compat_06,
    build_v3_provider_req_outbound_09_from_v3_provider_req_outbound_08,
    v3_stopless_center_enabled_for_server, V3HubContinuationOwnership, V3HubEntryProtocol,
    V3HubExecutionMode, V3HubInvocationSource, V3HubTargetResolution, V3HubTransportIntent,
    V3ServerToolCenterKey, V3ServerToolInstanceState, V3ServerToolName, V3WebSearchCenterPhase,
    V3WebSearchCenterState,
};
use crate::provider_failure_runtime_policy::{
    resolve_v3_relay_target, resolve_v3_relay_target_outcome,
    v3_relay_provider_policy_now_epoch_ms, V3ProviderFailureRuntimeHealth,
    V3RelayProviderTargetResolution, V3RelayProviderTargetResolutionInput,
};
use routecodex_v3_error::{V3ErrorSourceKind, V3ProviderFailureSessionScope};
use routecodex_v3_provider_responses::{
    build_v3_provider_12_responses_wire_payload, ResponsesTransport, V3ProviderResponseBody,
};
use routecodex_v3_config::V3Config05ManifestPublished;
use serde_json::{json, Value};
use std::collections::BTreeSet;

impl V3ResponsesRelayStoplessControlState {
    fn web_search_center_key(
        scope: &V3ResponsesRelayStoplessControlScope,
    ) -> V3ServerToolCenterKey {
        V3ServerToolCenterKey {
            tool_name: V3ServerToolName::WebSearch,
            scope_key: format!(
                "{}|{}|{}|{}|{}",
                scope.entry_endpoint,
                scope.port,
                scope.routing_group,
                scope.session_id,
                scope.conversation_id
            ),
        }
    }

    pub fn web_search_load_for_scope(
        &self,
        scope: &V3ResponsesRelayStoplessControlScope,
    ) -> Result<Option<V3WebSearchCenterState>, V3ResponsesRelayRuntimeError> {
        match self
            .center
            .load(&Self::web_search_center_key(scope))
            .map_err(|_| V3ResponsesRelayRuntimeError::StoplessControlStatePoisoned)?
        {
            Some(V3ServerToolInstanceState::WebSearch(state)) => Ok(Some(state)),
            Some(_) => Err(V3ResponsesRelayRuntimeError::StoplessControlStatePoisoned),
            None => Ok(None),
        }
    }

    pub fn web_search_store_for_scope(
        &self,
        scope: &V3ResponsesRelayStoplessControlScope,
        state: V3WebSearchCenterState,
    ) -> Result<(), V3ResponsesRelayRuntimeError> {
        self.center
            .store(
                Self::web_search_center_key(scope),
                V3ServerToolInstanceState::WebSearch(state),
            )
            .map_err(|_| V3ResponsesRelayRuntimeError::StoplessControlStatePoisoned)
    }

    pub fn web_search_clear_for_scope(
        &self,
        scope: &V3ResponsesRelayStoplessControlScope,
    ) -> Result<(), V3ResponsesRelayRuntimeError> {
        self.center
            .clear(&Self::web_search_center_key(scope))
            .map_err(|_| V3ResponsesRelayRuntimeError::StoplessControlStatePoisoned)
    }
}

/// Mode B 搜索 hop：一次额外的 provider/search 往返（非主模型 re-entry）。
/// 搜索请求经正常 Hub 链 + VR 路由（backend binding 以 `provider.model`
/// 形式 direct pin），响应文本归一化为 hosted web_search text_result，
/// 状态机迁移 ToolCallObserved -> SearchDispatchPrepared -> SearchInFlight
/// -> SearchResultCaptured。
pub(crate) async fn execute_local_web_search_hop<T: ResponsesTransport>(
    manifest: &V3Config05ManifestPublished,
    server_id: &str,
    failure_session_scope: &V3ProviderFailureSessionScope,
    provider_health: &V3ProviderFailureRuntimeHealth,
    backend_binding: Option<&str>,
    web_search_state: &V3WebSearchCenterState,
    transport: &T,
    request_id: &str,
) -> Result<V3WebSearchCenterState, V3ResponsesRelayRuntimeError> {
    let binding = backend_binding
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            V3ResponsesRelayRuntimeError::WebSearchBackendBindingMissing(
                "metadata_center_local_search requires exactly one backend binding".to_string(),
            )
        })?;
    let query = web_search_state
        .query()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            V3ResponsesRelayRuntimeError::WebSearchDispatchFailed(
                "websearch tool call missing query at dispatch".to_string(),
            )
        })?
        .to_string();
    // 状态机推进：ToolCallObserved -> SearchDispatchPrepared（dispatch 准备）。
    let prepared = web_search_state
        .transition_to(
            V3WebSearchCenterPhase::SearchDispatchPrepared,
            "search_hop_dispatch_prepared",
        )
        .map_err(|reason| V3ResponsesRelayRuntimeError::WebSearchDispatchFailed(reason))?;
    // 1. 搜索请求 payload：model = backend binding（direct pin 到搜索目标），
    //    input = 简短引导 + query，tools 仅 hosted web_search 声明（干净工具
    //    列表、干净上下文、引导提示简单——不携带主模型历史/其他工具），走
    //    JSON transport。
    let guided_text = format!("search the web: {query}");
    let search_payload = json!({
        "model": binding,
        "input": [{
            "type": "message",
            "role": "user",
            "content": [{"type": "input_text", "text": guided_text}]
        }],
        "tools": [{"type": "web_search", "external_web_access": true}],
        "stream": false
    });
    // 2. target 解析：body.model = backend binding -> direct model plan pin。
    let selected = match resolve_v3_relay_target_outcome(V3RelayProviderTargetResolutionInput {
        manifest,
        server_id,
        entry_kind: "responses",
        endpoint_path: "/v1/responses",
        body: &search_payload,
        request_local_excluded_candidates: &BTreeSet::new(),
        failure_session_scope,
        provider_health,
        now_ms: v3_relay_provider_policy_now_epoch_ms()?,
        deterministic_sample: 0,
    }) {
        V3RelayProviderTargetResolution::Selected(selected) => selected,
        V3RelayProviderTargetResolution::Failed(source)
            if source.source_kind == V3ErrorSourceKind::ModelNotFound =>
        {
            return Err(V3ResponsesRelayRuntimeError::ModelNotFound(
                source.message.clone(),
            ))
        }
        V3RelayProviderTargetResolution::Failed(source) => {
            return Err(V3ResponsesRelayRuntimeError::Target(format!(
                "{}: {}",
                source.code, source.message
            )))
        }
        V3RelayProviderTargetResolution::Exhausted {
            attempted_candidates,
        } => {
            return Err(V3ResponsesRelayRuntimeError::Target(format!(
                "selected target exhausted after {attempted_candidates:?}"
            )))
        }
    };
    // 3. 搜索请求入站链（正常 Hub 链构造 req05，非 entry payload 重建）。
    let req01 = build_v3_hub_req_inbound_01_client_raw(
        search_payload,
        V3HubEntryProtocol::Responses,
        V3HubInvocationSource::ServertoolFollowup,
        V3HubTransportIntent::Json,
    );
    let req02 = build_v3_hub_req_inbound_02_result_from_v3_hub_req_inbound_01(req01)
        .map_err(|error| V3ResponsesRelayRuntimeError::InboundCanonical(error.to_string()))?;
    let req03 = build_v3_hub_req_continuation_03_from_v3_hub_req_inbound_02(
        req02,
        V3HubContinuationOwnership::New,
    );
    let req04 = build_v3_hub_req_chat_process_04_from_v3_hub_req_continuation_03(req03);
    let req05 = build_v3_hub_req_execution_05_from_v3_hub_req_chat_process_04(
        req04,
        V3HubExecutionMode::Relay,
    );
    // 4. req06 -> req07 -> compat -> wire -> transport。
    let provider_wire_protocol = provider_wire_protocol_for_selected_candidate(&selected.candidate)
        .map_err(|error| V3ResponsesRelayRuntimeError::Target(error.to_string()))?;
    let req06 = build_v3_hub_req_target_06_from_v3_hub_req_execution_05(
        req05,
        V3HubTargetResolution::Routed,
        selected.candidate.clone(),
    );
    let req07 =
        build_v3_hub_req_outbound_07_from_v3_hub_req_target_06(req06, provider_wire_protocol);
    let target = provider_target(manifest, req07.selected_target())?;
    let req_compat = build_provider_req_compat_06_from_v3_hub_req_outbound_07(req07)
        .map_err(V3ResponsesRelayRuntimeError::ProviderCompat)?;
    let req08 = build_v3_provider_req_outbound_08_from_provider_req_compat_06(req_compat);
    let _req09 = build_v3_provider_req_outbound_09_from_v3_provider_req_outbound_08(req08);
    let provider_semantic = _req09.into_provider_semantic_payload();
    let wire = build_v3_provider_12_responses_wire_payload(request_id, target, provider_semantic)
        .map_err(V3ResponsesRelayRuntimeError::Provider)?;
    let transport_request =
        build_v3_provider_transport_request_for_protocol(provider_wire_protocol, wire)?;
    // 状态机推进：SearchDispatchPrepared -> SearchInFlight（请求已发出）。
    let in_flight = prepared
        .transition_to(
            V3WebSearchCenterPhase::SearchInFlight,
            "search_hop_in_flight",
        )
        .map_err(|reason| V3ResponsesRelayRuntimeError::WebSearchDispatchFailed(reason))?;
    let provider_raw = transport
        .send(transport_request)
        .await
        .map_err(V3ResponsesRelayRuntimeError::Provider)?;
    // 5. 响应归一化：仅接受 JSON body，提取 message 文本作为 text_result。
    let text_result = match provider_raw.into_body() {
        V3ProviderResponseBody::Json(bytes) => {
            let provider_value: Value = serde_json::from_slice(&bytes)
                .map_err(V3ResponsesRelayRuntimeError::ProviderJson)?;
            extract_web_search_text_result(&provider_value).ok_or_else(|| {
                V3ResponsesRelayRuntimeError::WebSearchResultUnavailable(
                    "search provider response has no message text".to_string(),
                )
            })?
        }
        _ => {
            return Err(V3ResponsesRelayRuntimeError::WebSearchResultUnavailable(
                "search hop requires a JSON transport response".to_string(),
            ))
        }
    };
    // 6. 状态迁移 SearchResultCaptured，携带归一化结果。
    let captured = in_flight
        .transition_to(
            V3WebSearchCenterPhase::SearchResultCaptured,
            "search_hop_result_captured",
        )
        .map_err(|reason| V3ResponsesRelayRuntimeError::WebSearchDispatchFailed(reason))?
        .with_normalized_result(Some(json!({
            "query": query,
            "text_result": text_result
        })));
    Ok(captured)
}

/// 把搜索 hop 结果投影到客户端可见的 finalized 响应：追加 hosted
/// `web_search_call`（completed、action.search、text_result）与原始
/// call_id 配对的 `function_call_output`。控制状态不进入 payload——
/// 这里投影的是协议等价结果（Codex hosted web_search 契约）。
pub(crate) fn project_web_search_result_into_finalized(
    finalized: &mut Value,
    captured: &V3WebSearchCenterState,
) -> Result<(), V3ResponsesRelayRuntimeError> {
    let call_id = captured
        .original_call_id()
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            V3ResponsesRelayRuntimeError::WebSearchResultUnavailable(
                "websearch call_id missing at projection".to_string(),
            )
        })?;
    let query = captured
        .query()
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            V3ResponsesRelayRuntimeError::WebSearchResultUnavailable(
                "websearch query missing at projection".to_string(),
            )
        })?;
    let text_result = captured
        .normalized_result()
        .and_then(|result| result.get("text_result"))
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            V3ResponsesRelayRuntimeError::WebSearchResultUnavailable(
                "websearch normalized text_result missing at projection".to_string(),
            )
        })?;
    let Some(object) = finalized.as_object_mut() else {
        return Err(V3ResponsesRelayRuntimeError::WebSearchResultUnavailable(
            "finalized provider response must be an object".to_string(),
        ));
    };
    let output = object
        .entry("output")
        .or_insert_with(|| Value::Array(Vec::new()));
    let output = output.as_array_mut().ok_or_else(|| {
        V3ResponsesRelayRuntimeError::WebSearchResultUnavailable(
            "finalized output must be an array".to_string(),
        )
    })?;
    // hosted web_search_call 等价结果（Codex 契约：started/completed、
    // action.search、results[text_result]、ref_id/citation）。
    output.push(json!({
        "type": "web_search_call",
        "id": format!("web_search_{call_id}"),
        "name": "web_search",
        "status": "completed",
        "action": {"type": "search", "query": query},
        "results": [{"type": "text_result", "ref_id": call_id, "text": text_result}]
    }));
    // 原始 call_id 配对的 function_call_output：下一轮 Req04 据此恢复配对注入。
    output.push(json!({
        "type": "function_call_output",
        "call_id": call_id,
        "output": text_result
    }));
    Ok(())
}

/// 从搜索 provider 响应提取文本结果：优先 Responses `output[].message
/// .content[].output_text.text`，其次 Chat `choices[].message.content`。
pub(crate) fn extract_web_search_text_result(provider_value: &Value) -> Option<String> {
    // Anthropic Messages 格式：content[].text（搜索后端为 anthropic 接口时）。
    if let Some(content) = provider_value.get("content").and_then(Value::as_array) {
        for part in content {
            if part.get("type").and_then(Value::as_str) != Some("text") {
                continue;
            }
            let text = part.get("text").and_then(Value::as_str)?.trim();
            if !text.is_empty() {
                return Some(text.to_string());
            }
        }
    }
    if let Some(output) = provider_value.get("output").and_then(Value::as_array) {
        for item in output {
            if item.get("type").and_then(Value::as_str) != Some("message") {
                continue;
            }
            if let Some(content) = item.get("content").and_then(Value::as_array) {
                for part in content {
                    if part.get("type").and_then(Value::as_str) != Some("output_text") {
                        continue;
                    }
                    let text = part.get("text").and_then(Value::as_str)?.trim();
                    if !text.is_empty() {
                        return Some(text.to_string());
                    }
                }
            }
        }
    }
    if let Some(choices) = provider_value.get("choices").and_then(Value::as_array) {
        for choice in choices {
            if let Some(content) = choice.pointer("/message/content").and_then(Value::as_str) {
                let content = content.trim();
                if !content.is_empty() {
                    return Some(content.to_string());
                }
            }
        }
    }
    None
}

/// Mode B 的编译期 backend binding（`provider.model`）：请求 model 的 manifest
/// `web_search_backend_binding`。搜索 hop 用它 direct pin 搜索目标；Mode B 配置
/// 编译期已保证 exactly one binding，这里仅透传（解析失败按 None，由搜索 hop
/// fail-fast）。
///
/// 解析顺序：1) `provider.model` 直连格式；2) forwarder 别名（按
/// `forwarder.model` / `forwarder.aliases` 匹配）——生产客户端 model 名
/// （如 `MiniMax-M3` / `gpt-5.5`）多为 forwarder 别名，必须可解析。
pub(crate) fn resolve_web_search_mode_and_backend(
    manifest: &V3Config05ManifestPublished,
    model: &str,
) -> (routecodex_v3_config::V3WebSearchExecutionMode, Option<String>) {
    let model = model.trim();
    if let routecodex_v3_config::V3DirectModelResolution::Resolved {
        provider_id,
        model_id,
        ..
    } = manifest.resolve_direct_provider_model(model)
    {
        if let Some(model_manifest) = manifest
            .providers
            .get(&provider_id)
            .and_then(|provider| provider.models.get(&model_id))
        {
            return (
                model_manifest.web_search_execution_mode,
                model_manifest.web_search_backend_binding.clone(),
            );
        }
    }
    if let Some(forwarder) = manifest.forwarders.values().find(|forwarder| {
        forwarder.model == model || forwarder.aliases.iter().any(|alias| alias == model)
    }) {
        for target in &forwarder.targets {
            let (Some(provider_id), Some(model_id)) =
                (target.provider.as_deref(), target.model.as_deref())
            else {
                continue;
            };
            if let Some(model_manifest) = manifest
                .providers
                .get(provider_id)
                .and_then(|provider| provider.models.get(model_id))
            {
                return (
                    model_manifest.web_search_execution_mode,
                    model_manifest.web_search_backend_binding.clone(),
                );
            }
        }
    }
    (routecodex_v3_config::V3WebSearchExecutionMode::None, None)
}

pub(crate) fn resolve_request_web_search_backend_binding(
    manifest: &V3Config05ManifestPublished,
    payload: &Value,
) -> Option<String> {
    let model = payload
        .get("model")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())?;
    resolve_web_search_mode_and_backend(manifest, model).1
}

/// 下一轮 Req04 配对验证：中心存在 `SearchResultCaptured` 且当前请求的
/// tool_outputs 含匹配 original_call_id 的 function_call_output（上一轮投影
/// 已按原 call_id 配对返回客户端）时，状态机收尾为 Completed。
/// 未配对则保持，等待后续轮次。
pub(crate) fn apply_v3_responses_relay_web_search_control_completion(
    manifest: &V3Config05ManifestPublished,
    server_id: &str,
    stopless_control: Option<&V3ResponsesRelayStoplessControlExecution<'_>>,
    payload: &Value,
) -> Result<(), V3ResponsesRelayRuntimeError> {
    if !v3_stopless_center_enabled_for_server(manifest, server_id) {
        return Ok(());
    }
    let Some(execution) = stopless_control else {
        return Ok(());
    };
    if !execution.commit_effects || !execution.scope.has_client_session_scope() {
        return Ok(());
    }
    let Some(state) = execution
        .control
        .web_search_load_for_scope(&execution.scope)?
    else {
        return Ok(());
    };
    if state.phase() != V3WebSearchCenterPhase::SearchResultCaptured {
        return Ok(());
    }
    let Some(call_id) = state.original_call_id() else {
        return Ok(());
    };
    let tool_output_ids = find_responses_tool_output_ids(payload)?;
    if !tool_output_ids.consumed_ids.contains(&call_id.to_string()) {
        return Ok(());
    }
    // 收尾走完整合法迁移链（配对验证时刻，HostedResultProjected /
    // MainModelContinuationPrepared 在语义上已发生）：SearchResultCaptured
    // -> HostedResultProjected -> MainModelContinuationPrepared -> Completed。
    let completed = state
        .transition_to(
            V3WebSearchCenterPhase::HostedResultProjected,
            "req04_pair_verified",
        )
        .and_then(|state| {
            state.transition_to(
                V3WebSearchCenterPhase::MainModelContinuationPrepared,
                "req04_pair_verified",
            )
        })
        .and_then(|state| {
            state.transition_to(V3WebSearchCenterPhase::Completed, "req04_pair_verified")
        })
        .map_err(|reason| V3ResponsesRelayRuntimeError::WebSearchDispatchFailed(reason))?;
    execution
        .control
        .web_search_store_for_scope(&execution.scope, completed)
}

#[cfg(test)]
mod web_search_hop_tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn extract_web_search_text_result_responses_format() {
        let provider_value = json!({
            "id": "resp_search",
            "object": "response",
            "output": [
                {
                    "type": "message",
                    "role": "assistant",
                    "content": [{"type": "output_text", "text": "RouteCodex 是路由代理。"}]
                }
            ],
            "status": "completed"
        });
        assert_eq!(
            extract_web_search_text_result(&provider_value).as_deref(),
            Some("RouteCodex 是路由代理。")
        );
    }

    #[test]
    fn extract_web_search_text_result_chat_format() {
        let provider_value = json!({
            "choices": [{"index": 0, "message": {"role": "assistant", "content": "搜索结果摘要"}}]
        });
        assert_eq!(
            extract_web_search_text_result(&provider_value).as_deref(),
            Some("搜索结果摘要")
        );
    }

    #[test]
    fn extract_web_search_text_result_none_when_no_message_text() {
        let provider_value = json!({"object": "response", "output": [], "status": "completed"});
        assert!(extract_web_search_text_result(&provider_value).is_none());
        let provider_value = json!({
            "choices": [{"index": 0, "message": {"role": "assistant", "content": "   "}}]
        });
        assert!(extract_web_search_text_result(&provider_value).is_none());
    }

    #[test]
    fn project_web_search_result_into_finalized_appends_hosted_result_and_pair() {
        let mut finalized = json!({
            "id": "resp_main",
            "output": [
                {"type": "message", "role": "assistant", "content": [{"type":"output_text","text":"让我搜索"}]}
            ],
            "status": "completed"
        });
        let captured = V3WebSearchCenterState::new()
            .transition_to(
                V3WebSearchCenterPhase::LocalToolSurfaceActive,
                "req04",
            )
            .expect("active")
            .with_original_call_id(Some("call_ws_1"))
            .with_query(Some("routecodex v3"))
            .transition_to(V3WebSearchCenterPhase::ToolCallObserved, "resp03")
            .expect("observed")
            .transition_to(V3WebSearchCenterPhase::SearchDispatchPrepared, "hop")
            .expect("prepared")
            .transition_to(V3WebSearchCenterPhase::SearchInFlight, "hop")
            .expect("in_flight")
            .transition_to(V3WebSearchCenterPhase::SearchResultCaptured, "hop")
            .expect("captured")
            .with_normalized_result(Some(json!({
                "query": "routecodex v3",
                "text_result": "RouteCodex 是路由代理。"
            })));
        project_web_search_result_into_finalized(&mut finalized, &captured).expect("project");
        let output = finalized["output"].as_array().expect("output array");
        assert_eq!(output.len(), 3, "original message + web_search_call + function_call_output");
        let call = &output[1];
        assert_eq!(call["type"], "web_search_call");
        assert_eq!(call["name"], "web_search");
        assert_eq!(call["status"], "completed");
        assert_eq!(call["action"]["type"], "search");
        assert_eq!(call["action"]["query"], "routecodex v3");
        assert_eq!(call["results"][0]["type"], "text_result");
        assert_eq!(call["results"][0]["ref_id"], "call_ws_1");
        assert_eq!(call["results"][0]["text"], "RouteCodex 是路由代理。");
        let pair = &output[2];
        assert_eq!(pair["type"], "function_call_output");
        assert_eq!(pair["call_id"], "call_ws_1");
        assert_eq!(pair["output"], "RouteCodex 是路由代理。");
    }

    #[test]
    fn project_web_search_result_into_finalized_fails_without_text_result() {
        let mut finalized = json!({"id": "resp_main", "output": [], "status": "completed"});
        let captured = V3WebSearchCenterState::new()
            .transition_to(V3WebSearchCenterPhase::LocalToolSurfaceActive, "req04")
            .expect("active")
            .with_original_call_id(Some("call_ws_1"))
            .with_query(Some("x"))
            .transition_to(V3WebSearchCenterPhase::ToolCallObserved, "resp03")
            .expect("observed")
            .transition_to(V3WebSearchCenterPhase::SearchDispatchPrepared, "hop")
            .expect("prepared")
            .transition_to(V3WebSearchCenterPhase::SearchInFlight, "hop")
            .expect("in_flight")
            .transition_to(V3WebSearchCenterPhase::SearchResultCaptured, "hop")
            .expect("captured");
        let error = project_web_search_result_into_finalized(&mut finalized, &captured)
            .expect_err("missing text_result must fail");
        assert!(error.to_string().contains("text_result missing"));
    }
}

/// 本地 `websearch` / hosted `web_search` 工具调用（Resp03 拦截提取）。
#[derive(Debug)]
pub(crate) struct V3LocalWebSearchToolCall {
    pub(crate) call_id: String,
    pub(crate) query: String,
    pub(crate) count: Option<u32>,
    pub(crate) recency: Option<String>,
    pub(crate) content_types: Vec<String>,
}

/// 提取 provider 响应中的第一个本地 `websearch` / hosted `web_search`
/// function call 并做参数校验（query 必填非空；count/recency/content_types
/// 可选）。Mode B 同轮激活校验由调用方用 profile.web_search_local_surface_active()
/// 完成。
pub(crate) fn first_local_websearch_tool_call(
    payload: &Value,
) -> Result<Option<V3LocalWebSearchToolCall>, V3HubRelayResponseError> {
    let Some(output) = payload.get("output").and_then(Value::as_array) else {
        return Ok(None);
    };
    for (index, item) in output.iter().enumerate() {
        let item_type = item.get("type").and_then(Value::as_str).unwrap_or_default();
        if !matches!(item_type, "function_call" | "tool_call" | "custom_tool_call") {
            continue;
        }
        let name = item
            .get("name")
            .and_then(Value::as_str)
            .or_else(|| item.pointer("/function/name").and_then(Value::as_str));
        if !name.is_some_and(|value| {
            let value = value.trim();
            value.eq_ignore_ascii_case("websearch") || value.eq_ignore_ascii_case("web_search")
        }) {
            continue;
        }
        let call_id = item
            .get("call_id")
            .or_else(|| item.get("id"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or(V3HubRelayResponseError::MalformedToolCall {
                index,
                reason: "websearch tool call missing call_id",
            })?
            .to_string();
        let raw_arguments = item
            .get("arguments")
            .or_else(|| item.get("input"))
            .or_else(|| item.pointer("/function/arguments"))
            .and_then(Value::as_str)
            .ok_or(V3HubRelayResponseError::MalformedToolCall {
                index,
                reason: "websearch tool call missing arguments",
            })?;
        let arguments = raw_arguments.parse::<Value>().map_err(|_| {
            V3HubRelayResponseError::MalformedToolCall {
                index,
                reason: "websearch tool call arguments must be valid JSON",
            }
        })?;
        let query = arguments
            .get("query")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or(V3HubRelayResponseError::MalformedToolCall {
                index,
                reason: "websearch tool call requires a non-empty query",
            })?
            .to_string();
        let count = arguments
            .get("count")
            .and_then(Value::as_u64)
            .and_then(|value| u32::try_from(value).ok());
        let recency = arguments
            .get("recency")
            .and_then(Value::as_str)
            .map(str::to_string);
        let content_types = arguments
            .get("content_types")
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_default();
        return Ok(Some(V3LocalWebSearchToolCall {
            call_id,
            query,
            count,
            recency,
            content_types,
        }));
    }
    Ok(None)
}

/// 提取同响应 hosted `web_search_tool_result`（MiniMax hosted search）中
/// 与 call_id 匹配的搜索结果文本；无匹配项返回 None（走本地搜索 hop）。
pub(crate) fn hosted_web_search_result_text(payload: &Value, call_id: &str) -> Option<String> {
    let mut parts = Vec::new();
    for item in payload
        .get("output")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        if item.get("type").and_then(Value::as_str) != Some("web_search_tool_result") {
            continue;
        }
        if item.get("tool_use_id").and_then(Value::as_str) != Some(call_id) {
            continue;
        }
        for result in item
            .get("content")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            if result.get("type").and_then(Value::as_str) != Some("web_search_result") {
                continue;
            }
            let title = result
                .get("title")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty());
            let url = result
                .get("url")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty());
            let text = result
                .get("text")
                .or_else(|| result.get("content"))
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty());
            let mut part = String::new();
            if let Some(title) = title {
                part.push_str(title);
            }
            if let Some(url) = url {
                if !part.is_empty() {
                    part.push(' ');
                }
                part.push_str(url);
            }
            if let Some(text) = text {
                if !part.is_empty() {
                    part.push('\n');
                }
                part.push_str(text);
            }
            if !part.is_empty() {
                parts.push(part);
            }
        }
    }
    if parts.is_empty() {
        None
    } else {
        Some(parts.join("\n\n"))
    }
}
