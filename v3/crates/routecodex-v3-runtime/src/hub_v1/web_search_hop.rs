//! V3 Mode B web_search 状态机与结果投影语义。
//!
//! 归属 `v3.web_search_servertool_state_machine`：
//! - 响应文本归一化（Responses output_text / Chat choices）
//! - hosted `web_search_call` 等价投影 + 原 call_id 配对 `function_call_output`
//! - 下一轮 Req04 配对验证收尾（SearchResultCaptured -> Completed）
//!
//! 控制状态只进 ServerToolCenter 控制资源；这里投影的是协议等价结果，
//! 不重建 entry payload、不重入主模型、不做第二套 VR。搜索执行由
//! typed hooks sidecar helper 独占。

use super::responses_relay_runtime::{
    find_responses_tool_output_ids, V3ResponsesRelayRuntimeError,
    V3ResponsesRelayServerToolExecution, V3ResponsesRelayServerToolScope,
    V3ResponsesRelayServerToolState,
};
use super::V3HubRelayResponseError;
use super::{
    V3ServerToolCenterKey, V3ServerToolCenterWriteOrigin, V3ServerToolInstanceState,
    V3ServerToolName, V3WebSearchCenterPhase, V3WebSearchCenterState,
};
use routecodex_v3_config::V3Config05ManifestPublished;
use serde_json::{json, Value};
use servertool_core::web_search_contract::WebSearchSource;

impl V3ResponsesRelayServerToolState {
    fn web_search_center_key(scope: &V3ResponsesRelayServerToolScope) -> V3ServerToolCenterKey {
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
        scope: &V3ResponsesRelayServerToolScope,
    ) -> Result<Option<V3WebSearchCenterState>, V3ResponsesRelayRuntimeError> {
        match self
            .center
            .load(&Self::web_search_center_key(scope))
            .map_err(|_| V3ResponsesRelayRuntimeError::ServerToolStatePoisoned)?
        {
            Some(V3ServerToolInstanceState::WebSearch(state)) => Ok(Some(state)),
            Some(_) => Err(V3ResponsesRelayRuntimeError::ServerToolStatePoisoned),
            None => Ok(None),
        }
    }

    pub fn web_search_store_for_scope(
        &self,
        scope: &V3ResponsesRelayServerToolScope,
        state: V3WebSearchCenterState,
        written_by: V3ServerToolCenterWriteOrigin,
        reason: Option<&str>,
        request_id: Option<&str>,
    ) -> Result<(), V3ResponsesRelayRuntimeError> {
        self.center
            .store(
                Self::web_search_center_key(scope),
                V3ServerToolInstanceState::WebSearch(state),
                written_by,
                reason,
                request_id,
            )
            .map_err(|_| V3ResponsesRelayRuntimeError::ServerToolStatePoisoned)
    }

    pub fn web_search_clear_for_scope(
        &self,
        scope: &V3ResponsesRelayServerToolScope,
        written_by: V3ServerToolCenterWriteOrigin,
        reason: Option<&str>,
        request_id: Option<&str>,
    ) -> Result<(), V3ResponsesRelayRuntimeError> {
        self.center
            .clear(
                &Self::web_search_center_key(scope),
                written_by,
                reason,
                request_id,
            )
            .map_err(|_| V3ResponsesRelayRuntimeError::ServerToolStatePoisoned)
    }
}

pub(crate) fn store_v3_responses_relay_web_search_state(
    server_tool_state: Option<&V3ResponsesRelayServerToolExecution<'_>>,
    state: Option<&V3WebSearchCenterState>,
) -> Result<(), V3ResponsesRelayRuntimeError> {
    let Some(state) = state else { return Ok(()) };
    let Some(execution) = server_tool_state else {
        return Ok(());
    };
    if !execution.commit_effects || !execution.scope.has_client_session_scope() {
        return Ok(());
    }
    execution.control.web_search_store_for_scope(
        &execution.scope,
        state.clone(),
        V3ServerToolCenterWriteOrigin {
            module: "responses_relay_runtime",
            symbol: "store_v3_responses_relay_web_search_state",
            stage: "req04_server_tool",
        },
        Some("persist web_search server tool state"),
        None,
    )
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
    let normalized = captured.normalized_result().ok_or_else(|| {
        V3ResponsesRelayRuntimeError::WebSearchResultUnavailable(
            "websearch normalized result missing at projection".to_string(),
        )
    })?;
    let text_result = normalized
        .get("text_result")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty());
    let sources: Vec<WebSearchSource> = normalized
        .get("sources")
        .cloned()
        .map(serde_json::from_value)
        .transpose()
        .map_err(|error| {
            V3ResponsesRelayRuntimeError::WebSearchResultUnavailable(format!(
                "websearch normalized sources are malformed at projection: {error}"
            ))
        })?
        .unwrap_or_default();
    if text_result.is_none() && sources.is_empty() {
        return Err(V3ResponsesRelayRuntimeError::WebSearchResultUnavailable(
            "websearch normalized result has neither text_result nor sources at projection"
                .to_string(),
        ));
    }
    let mut results = Vec::new();
    if let Some(text_result) = text_result {
        results.push(json!({
            "type": "text_result",
            "ref_id": call_id,
            "text": text_result
        }));
    }
    results.extend(sources.iter().map(|source| {
        json!({
            "type": "text_result",
            "ref_id": source.ref_id,
            "title": source.title,
            "url": source.url
        })
    }));
    let paired_output = if text_result.is_some() && sources.is_empty() {
        Value::String(
            text_result
                .expect("text_result presence was checked for the legacy string shape")
                .to_string(),
        )
    } else {
        json!({
            "type": "web_search_tool_result",
            "results": results
        })
    };
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
        "results": results
    }));
    // 原始 call_id 配对的 function_call_output：下一轮 Req04 据此恢复配对注入。
    output.push(json!({
        "type": "function_call_output",
        "call_id": call_id,
        "output": paired_output
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
) -> (
    routecodex_v3_config::V3WebSearchExecutionMode,
    Option<String>,
) {
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
    // forwarder 匹配：请求 model 命中 forwarder.model/aliases 时收集其 target
    // 的 mode；Local 立即返回。Native 不短路——继续检查 pool（同一 wire 模型
    // 可能由 Mode A forwarder 与 Mode B pool 直连 provider 分别声明，pool 的
    // Local 必须保守激活，Resp03 再按 selected candidate 精确决定）。
    let mut forwarder_first_match: Option<(
        routecodex_v3_config::V3WebSearchExecutionMode,
        Option<String>,
    )> = None;
    for forwarder in manifest.forwarders.values() {
        if forwarder.model != model && !forwarder.aliases.iter().any(|alias| alias == model) {
            continue;
        }
        for target in &forwarder.targets {
            let (Some(provider_id), Some(model_id)) =
                (target.provider.as_deref(), target.model.as_deref())
            else {
                continue;
            };
            let Some(model_manifest) = manifest
                .providers
                .get(provider_id)
                .and_then(|provider| provider.models.get(model_id))
            else {
                continue;
            };
            let matched = (
                model_manifest.web_search_execution_mode,
                model_manifest.web_search_backend_binding.clone(),
            );
            if matched.0.is_metadata_center_local_search() {
                return matched;
            }
            forwarder_first_match.get_or_insert(matched);
        }
    }
    // route_group pool 直连（provider_model target，无 forwarder）也按 model
    // 解析：VR 配置把 multimodal / web_search 能力 pool 直连 MiniMax-M3 时，
    // Req04 的 Mode B 判定不能依赖 forwarder 存在。能力信号与入口协议无关，
    // pool 的 match 谓词不含 entry_protocol 时 chat 入口同样命中。
    // wire_name 共享场景（同 upstream model 被 Mode A / Mode B 两个 provider
    // 以不同本地 id 声明）：只要 pool 内任一匹配 provider 是本地搜索模式，
    // Req04 就保守激活本地搜索 surface，Resp03 再按 selected candidate 的
    // execution mode 决定是否拦截——Mode A（Native）不受影响。
    let mut first_match: Option<(
        routecodex_v3_config::V3WebSearchExecutionMode,
        Option<String>,
    )> = None;
    for group in manifest.route_groups.values() {
        for pool in group.pools.values() {
            for target in &pool.targets {
                let (Some(provider_id), Some(model_id)) =
                    (target.provider.as_deref(), target.model.as_deref())
                else {
                    continue;
                };
                let model_manifest = manifest
                    .providers
                    .get(provider_id)
                    .and_then(|provider| provider.models.get(model_id))
                    .filter(|model_manifest| {
                        model_id == model || (model_manifest.wire_name.trim() == model)
                    });
                let Some(model_manifest) = model_manifest else {
                    continue;
                };
                let matched = (
                    model_manifest.web_search_execution_mode,
                    model_manifest.web_search_backend_binding.clone(),
                );
                if matched.0.is_metadata_center_local_search() {
                    return matched;
                }
                first_match.get_or_insert(matched);
            }
        }
    }
    if let Some(matched) = forwarder_first_match {
        return matched;
    }
    if let Some(matched) = first_match {
        return matched;
    }
    (routecodex_v3_config::V3WebSearchExecutionMode::None, None)
}

/// 下一轮 Req04 配对验证：中心存在 `SearchResultCaptured` 且当前请求的
/// tool_outputs 含匹配 original_call_id 的 function_call_output（上一轮投影
/// 已按原 call_id 配对返回客户端）时，状态机收尾为 Completed。
/// 未配对则保持，等待后续轮次。
pub(crate) fn apply_v3_responses_relay_web_search_control_completion(
    manifest: &V3Config05ManifestPublished,
    server_id: &str,
    server_tool_state: Option<&V3ResponsesRelayServerToolExecution<'_>>,
    payload: &Value,
) -> Result<(), V3ResponsesRelayRuntimeError> {
    let Some(execution) = server_tool_state else {
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
    execution.control.web_search_store_for_scope(
        &execution.scope,
        completed,
        V3ServerToolCenterWriteOrigin {
            module: "web_search_hop",
            symbol: "apply_v3_web_search_control_completion_for_hop",
            stage: "req04_pair_verified",
        },
        Some("req04 pair verified, persist completed web_search state"),
        None,
    )
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
    fn first_local_websearch_tool_call_detects_openai_chat_choices_shape() {
        // chat 入口（openai_chat relay）的 provider payload 是 OpenAI Chat 形态
        // `choices[].message.tool_calls`，web_search 声明经 outbound 投影为本地
        // websearch function tool；Resp03 拦截必须能识别该形态（当前只识别
        // Responses `output[]`，此测试为红测，期望绿后拦截生效）。
        let payload = json!({
            "id": "chatcmpl_ws",
            "choices": [{
                "index": 0,
                "message": {
                    "role": "assistant",
                    "content": "",
                    "tool_calls": [{
                        "id": "call_ws_chat",
                        "type": "function",
                        "function": {
                            "name": "websearch",
                            "arguments": "{\"query\":\"RouteCodex docs\"}"
                        }
                    }]
                },
                "finish_reason": "tool_calls"
            }]
        });
        let call = first_local_websearch_tool_call(&payload)
            .expect("OpenAI Chat choices shape must parse");
        let call = call.expect("OpenAI Chat websearch function call must be detected");
        assert_eq!(call.call_id, "call_ws_chat");
        assert_eq!(call.query, "RouteCodex docs");
    }

    #[test]
    fn first_local_websearch_tool_call_detects_anthropic_tool_use_shape() {
        // anthropic 入口（anthropic relay）的 provider payload 是 Anthropic
        // Messages 形态 `content[].tool_use`，hosted web_search 声明以
        // name=web_search 的 tool_use 返回；Resp03 拦截必须能识别该形态。
        let payload = json!({
            "id": "msg_ws",
            "type": "message",
            "role": "assistant",
            "content": [
                {"type": "text", "text": ""},
                {
                    "type": "tool_use",
                    "id": "call_ws_anthropic",
                    "name": "web_search",
                    "input": {"query": "RouteCodex docs", "count": 5}
                }
            ],
            "stop_reason": "tool_use"
        });
        let call =
            first_local_websearch_tool_call(&payload).expect("Anthropic tool_use shape must parse");
        let call = call.expect("Anthropic web_search tool_use must be detected");
        assert_eq!(call.call_id, "call_ws_anthropic");
        assert_eq!(call.query, "RouteCodex docs");
        assert_eq!(call.count, Some(5));
    }

    #[test]
    fn first_local_websearch_tool_call_detects_openai_chat_sse_delta_shape() {
        // OpenAI-wire SSE chunk 形态：choices[].delta.tool_calls（名称首帧出现，
        // arguments 跨帧增量）。Mode B 逐帧拦截必须能识别该形态。
        let payload = json!({
            "id": "chatcmpl-chunk-1",
            "object": "chat.completion.chunk",
            "choices": [{
                "index": 0,
                "delta": {
                    "role": "assistant",
                    "tool_calls": [{
                        "index": 0,
                        "id": "call_delta_ws",
                        "type": "function",
                        "function": {"name": "websearch", "arguments": ""}
                    }]
                },
                "finish_reason": null
            }]
        });
        let call = first_local_websearch_tool_call(&payload).expect("SSE delta shape must parse");
        let call = call.expect("SSE delta websearch tool call must be detected");
        assert_eq!(call.call_id, "call_delta_ws");
        assert_eq!(call.query, "");
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
            .transition_to(V3WebSearchCenterPhase::LocalToolSurfaceActive, "req04")
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
        assert_eq!(
            output.len(),
            3,
            "original message + web_search_call + function_call_output"
        );
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
    fn project_web_search_result_into_finalized_projects_sources_without_text_result() {
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
            .expect("captured")
            .with_normalized_result(Some(json!({
                "query": "x",
                "text_result": null,
                "sources": [{
                    "refId": "source-1",
                    "url": "https://example.com",
                    "title": "Example"
                }]
            })));
        project_web_search_result_into_finalized(&mut finalized, &captured).expect("project");
        let output = finalized["output"].as_array().expect("output array");
        let call = &output[0];
        assert_eq!(call["type"], "web_search_call");
        assert_eq!(call["id"], "web_search_call_ws_1");
        assert_eq!(call["results"][0]["type"], "text_result");
        assert_eq!(call["results"][0]["ref_id"], "source-1");
        assert_eq!(call["results"][0]["title"], "Example");
        assert_eq!(call["results"][0]["url"], "https://example.com");
        assert!(call["results"][0].get("text").is_none());
        assert!(call.get("phase").is_none());
        let pair = &output[1];
        assert_eq!(pair["type"], "function_call_output");
        assert_eq!(pair["call_id"], "call_ws_1");
        assert_eq!(pair["output"]["type"], "web_search_tool_result");
        assert_eq!(pair["output"]["results"], call["results"]);
    }

    #[test]
    fn project_web_search_result_into_finalized_projects_text_and_sources() {
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
            .expect("captured")
            .with_normalized_result(Some(json!({
                "query": "x",
                "text_result": "summary",
                "sources": [{
                    "refId": "source-1",
                    "url": "https://example.com",
                    "title": "Example"
                }]
            })));
        project_web_search_result_into_finalized(&mut finalized, &captured).expect("project");
        let output = finalized["output"].as_array().expect("output array");
        let call = &output[0];
        assert_eq!(call["id"], "web_search_call_ws_1");
        assert_eq!(call["results"].as_array().expect("results").len(), 2);
        assert_eq!(call["results"][0]["ref_id"], "call_ws_1");
        assert_eq!(call["results"][0]["text"], "summary");
        assert_eq!(call["results"][1]["ref_id"], "source-1");
        assert_eq!(call["results"][1]["title"], "Example");
        assert_eq!(call["results"][1]["url"], "https://example.com");
        let pair = &output[1];
        assert_eq!(pair["call_id"], "call_ws_1");
        assert_eq!(pair["output"]["type"], "web_search_tool_result");
        assert_eq!(pair["output"]["results"], call["results"]);
    }

    #[test]
    fn project_web_search_result_into_finalized_fails_without_text_or_sources() {
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
            .expect("captured")
            .with_normalized_result(Some(json!({
                "query": "x",
                "text_result": null,
                "sources": []
            })));
        let error = project_web_search_result_into_finalized(&mut finalized, &captured)
            .expect_err("missing text_result and sources must fail");
        assert!(error
            .to_string()
            .contains("neither text_result nor sources"));
    }

    #[test]
    fn resolve_web_search_mode_and_backend_matches_route_group_pool_direct_target() {
        // 4444 真实配置形态：route_group pool 直连 provider_model（无 forwarder）。
        // Req04 Mode B 判定必须能按 model 解析出 metadata_center_local_search。
        let manifest = routecodex_v3_config::compile_v3_config_05_manifest(
            routecodex_v3_config::parse_v3_config_02_authoring(
                r#"
version = 3
[servers.s]
bind = "127.0.0.1"
port = 1
routing_group = "g"
endpoints = ["openai_chat", "responses", "anthropic"]
[providers.mm]
type = "anthropic"
base_url = "https://api.minimaxi.com/anthropic"
default_model = "MiniMax-M3"
auth = { type = "api_key", entries = [{ alias = "key1", env = "MM_KEY" }] }
[providers.mm.models."MiniMax-M3"]
wire_name = "MiniMax-M3"
capabilities = ["text", "tools", "multimodal", "vision", "web_search"]
web_search_execution_mode = "metadata_center_local_search"
web_search_backend = "MiniMax-M3"
[route_groups.g.pools.web_search]
selection = { strategy = "priority" }
match = { precedence = 20, required_capabilities = ["web_search"] }
targets = [{ kind = "provider_model", provider = "mm", model = "MiniMax-M3", key = "key1", priority = 1 }]
[route_groups.g.pools.default]
selection = { strategy = "priority" }
targets = [{ kind = "provider_model", provider = "mm", model = "MiniMax-M3", key = "key1", priority = 1 }]
"#,
            )
            .unwrap(),
        )
        .unwrap();
        let (mode, backend) = resolve_web_search_mode_and_backend(&manifest, "MiniMax-M3");
        assert!(
            mode.is_metadata_center_local_search(),
            "pool 直连 model 必须解析出 Mode B，got: {mode:?}"
        );
        assert_eq!(backend.as_deref(), Some("MiniMax-M3"));
    }

    #[test]
    fn resolve_web_search_mode_and_backend_prefers_local_when_wire_name_shared_across_providers() {
        // 同一 wire 模型名被两个 provider 声明（Mode A Native 与 Mode B Local，
        // 本地 id 不同）：请求 model 命中 pool 内任一 Local provider 时，
        // Req04 必须保守激活本地搜索 surface（Resp03 再按 selected mode 决定
        // 是否拦截），Mode A 不受影响。
        let manifest = routecodex_v3_config::compile_v3_config_05_manifest(
            routecodex_v3_config::parse_v3_config_02_authoring(
                r#"
version = 3
[servers.s]
bind = "127.0.0.1"
port = 1
routing_group = "g"
endpoints = ["openai_chat", "responses", "anthropic"]
[providers.mm_anthropic]
type = "anthropic"
base_url = "https://api.minimaxi.com/anthropic"
default_model = "MiniMax-M3"
auth = { type = "api_key", entries = [{ alias = "key1", env = "MM_A_KEY" }] }
[providers.mm_anthropic.models."MiniMax-M3"]
capabilities = ["text", "tools", "multimodal", "vision", "web_search"]
web_search_execution_mode = "native_remote_search_tool_mix"
[providers.mm_openai]
type = "openai_chat"
base_url = "https://api.minimaxi.com/v1"
default_model = "MiniMax-M3-local"
auth = { type = "api_key", entries = [{ alias = "key1", env = "MM_O_KEY" }] }
[providers.mm_openai.models."MiniMax-M3-local"]
wire_name = "MiniMax-M3"
capabilities = ["text", "tools", "multimodal", "vision", "web_search"]
web_search_execution_mode = "metadata_center_local_search"
web_search_backend = "MiniMax-M3"
[route_groups.g.pools.web_search]
selection = { strategy = "priority" }
match = { precedence = 20, required_capabilities = ["web_search"] }
targets = [
  { kind = "provider_model", provider = "mm_anthropic", model = "MiniMax-M3", key = "key1", priority = 1 },
  { kind = "provider_model", provider = "mm_openai", model = "MiniMax-M3-local", key = "key1", priority = 2 }
]
[route_groups.g.pools.default]
selection = { strategy = "priority" }
targets = [{ kind = "provider_model", provider = "mm_anthropic", model = "MiniMax-M3", key = "key1", priority = 1 }]
"#,
            )
            .unwrap(),
        )
        .unwrap();
        let (mode, backend) = resolve_web_search_mode_and_backend(&manifest, "MiniMax-M3");
        assert!(
            mode.is_metadata_center_local_search(),
            "请求 wire 名同时命中 Native/Local provider 时必须保守激活 Mode B，got: {mode:?}"
        );
        assert_eq!(backend.as_deref(), Some("MiniMax-M3"));
    }
}

/// 本地 `websearch` / hosted `web_search` 工具调用（Resp03 拦截提取）。
#[derive(Debug)]
pub(crate) struct V3LocalWebSearchToolCall {
    pub(crate) call_id: String,
    /// 实际匹配的工具名：本地 `websearch`（Mode B 出站 function）或
    /// hosted `web_search`（anthropic wire server tool）。入口 codec 据此
    /// 区分"必须本地 hop/拦截"与"可透传客户端执行"。
    pub(crate) name: String,
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
    // 候选 tool call 项跨协议泛化：Responses `output[]`（function_call /
    // tool_call / custom_tool_call）、OpenAI Chat `choices[].message.tool_calls[]`
    // （function）、Anthropic `content[].tool_use`。入口协议只决定 provider
    // payload 形态，web_search 拦截语义（Resp03 Mode B）对所有入口一致。
    let mut candidates: Vec<(usize, &Value)> = Vec::new();
    if let Some(output) = payload.get("output").and_then(Value::as_array) {
        for (index, item) in output.iter().enumerate() {
            let item_type = item.get("type").and_then(Value::as_str).unwrap_or_default();
            if matches!(
                item_type,
                "function_call" | "tool_call" | "custom_tool_call"
            ) {
                candidates.push((index, item));
            }
        }
    }
    if candidates.is_empty() {
        if let Some(choices) = payload.get("choices").and_then(Value::as_array) {
            for (choice_index, choice) in choices.iter().enumerate() {
                // JSON 完成形态：choices[].message.tool_calls。
                if let Some(tool_calls) = choice
                    .pointer("/message/tool_calls")
                    .and_then(Value::as_array)
                {
                    for (index, item) in tool_calls.iter().enumerate() {
                        candidates.push((choice_index * 1000 + index, item));
                    }
                }
                // SSE chunk 形态：choices[].delta.tool_calls（OpenAI wire 逐帧
                // 事件）。名称通常在首帧出现，arguments 跨帧增量——按 name
                // 判定即可拦截（call_id 缺失时由校验报错）。
                if let Some(tool_calls) = choice
                    .pointer("/delta/tool_calls")
                    .and_then(Value::as_array)
                {
                    for (index, item) in tool_calls.iter().enumerate() {
                        candidates.push((choice_index * 1000 + index, item));
                    }
                }
            }
        }
    }
    if candidates.is_empty() {
        if let Some(content) = payload.get("content").and_then(Value::as_array) {
            for (index, item) in content.iter().enumerate() {
                if item.get("type").and_then(Value::as_str) == Some("tool_use") {
                    candidates.push((index, item));
                }
            }
        }
    }
    for (index, item) in candidates {
        let name = item
            .get("name")
            .and_then(Value::as_str)
            .or_else(|| item.pointer("/function/name").and_then(Value::as_str));
        let matched_name = match name.map(str::trim) {
            Some(value) if value.eq_ignore_ascii_case("websearch") => "websearch",
            Some(value) if value.eq_ignore_ascii_case("web_search") => "web_search",
            _ => continue,
        };
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
        let arguments = match item
            .get("arguments")
            .or_else(|| item.get("input"))
            .or_else(|| item.pointer("/function/arguments"))
        {
            // Responses / OpenAI Chat：arguments 是 JSON 字符串。SSE chunk
            // 首帧 arguments 常为空串（跨帧增量），按空对象处理——拦截判定
            // 只依赖 name + call_id，不要求首帧已含完整参数。
            Some(Value::String(raw)) if raw.trim().is_empty() => json!({}),
            Some(Value::String(raw)) => {
                raw.parse::<Value>()
                    .map_err(|_| V3HubRelayResponseError::MalformedToolCall {
                        index,
                        reason: "websearch tool call arguments must be valid JSON",
                    })?
            }
            // Anthropic tool_use：input 是结构化对象。
            Some(value @ (Value::Object(_) | Value::Array(_))) => value.clone(),
            _ => {
                return Err(V3HubRelayResponseError::MalformedToolCall {
                    index,
                    reason: "websearch tool call missing arguments",
                })
            }
        };
        let query = arguments
            .get("query")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            // SSE chunk 首帧可无 query（arguments 空对象，跨帧增量）；此时
            // 仅完成 name 拦截判定，query 由后续帧补齐。
            .or_else(|| (arguments.as_object().is_some_and(|row| row.is_empty())).then_some(""))
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
            name: matched_name.to_string(),
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
