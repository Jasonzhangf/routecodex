use super::*;
use serde_json::Value;

pub(crate) struct V3ResponsesRelayJsonResponseHookInput<'a> {
    pub(crate) provider_value: &'a Value,
    pub(crate) provider_semantic_body: &'a Value,
    pub(crate) manifest: &'a V3Config05ManifestPublished,
    pub(crate) server_id: &'a str,
    pub(crate) provider_id: Option<&'a str>,
    pub(crate) provider_protocol: V3HubProviderWireProtocol,
    pub(crate) provider_response_transport_intent: V3HubTransportIntent,
    pub(crate) compatibility_profile: Option<&'a str>,
    pub(crate) web_search_execution_mode: routecodex_v3_config::V3WebSearchExecutionMode,
    pub(crate) web_search_center_state: Option<V3WebSearchCenterState>,
    pub(crate) stopless_state: Option<&'a V3StoplessCenterState>,
    pub(crate) stopless_control_has_client_session_scope: bool,
    pub(crate) transition_request_id: &'a str,
    pub(crate) transition_updated_at: u64,
    /// 请求侧 VR 路由决策算好的"保留响应密文"标记（仅 gpt 模型 + 单一 provider
    /// 候选时为 true），响应侧 Resp03 只消费此结果，不重复判定。
    pub(crate) retain_response_cipher: bool,
}

pub(crate) fn run_json_response_hooks(
    input: V3ResponsesRelayJsonResponseHookInput<'_>,
    trace: &mut Vec<&'static str>,
) -> Result<
    (
        V3HubContinuationCommit,
        Value,
        Option<V3StoplessCenterState>,
        Option<V3WebSearchCenterState>,
    ),
    V3ResponsesRelayRuntimeError,
> {
    let resp01 = build_v3_provider_resp_inbound_01_raw_with_compat_profile(
        input.provider_value.clone(),
        V3ProviderRespInbound01RawContext::new(
            V3HubEntryProtocol::Responses,
            input.provider_protocol,
            V3HubContinuationOwnership::New,
            V3HubExecutionMode::Relay,
            V3HubInvocationSource::Client,
            input.provider_response_transport_intent,
        )
        .with_compatibility_profile(input.compatibility_profile),
    );
    trace.push("V3ProviderRespInbound01Raw");
    let hooks = compile_v3_hub_relay_response_hooks();
    let mut resp02 = hooks.normalize(resp01)?;
    trace.push("ProviderRespCompat02ProviderCompat");
    if input.provider_protocol == V3HubProviderWireProtocol::OpenAiChat {
        let converted =
            build_v3_responses_provider_response_from_openai_chat_payload_with_manifest(
                resp02.provider_payload(),
                input.provider_semantic_body,
                Some(input.manifest),
                input.provider_id,
            )?;
        resp02.set_responses_semantic_payload(converted);
    }
    trace.push("V3HubRespInbound02Normalized");
    let response_hook_profile = responses_relay_response_hook_profile(
        input.manifest,
        input.server_id,
        input.stopless_state,
        input.stopless_control_has_client_session_scope,
        input.transition_request_id,
        input.transition_updated_at,
        input.web_search_execution_mode,
        input.retain_response_cipher,
    );
    let response_hook_profile = match input.web_search_center_state {
        Some(state) => response_hook_profile.with_web_search_center_state(state),
        None => response_hook_profile,
    };
    let resp03 = hooks.govern(resp02, &response_hook_profile)?;
    trace.push("V3HubRespChatProcess03Governed");
    let resp04 = hooks.commit(resp03)?;
    let action = resp04.action();
    let response_stopless_state = resp04.control_transition().cloned();
    let response_web_search_state = resp04.web_search_transition().cloned();
    trace.push("V3HubRespContinuation04Committed");
    let resp05 = build_v3_hub_resp_outbound_05_from_v3_hub_resp_continuation_04(resp04.into_data());
    let finalized_payload = resp05.client_payload().clone();
    trace.push("V3HubRespOutbound05ClientSemantic");
    trace.push("V3ServerRespOutbound06ClientFrame");
    Ok((
        action,
        finalized_payload,
        response_stopless_state,
        response_web_search_state,
    ))
}

/// 把搜索 hop 结果投影到客户端可见的 finalized 响应：追加 hosted
/// `web_search_call`（completed、action.search、text_result）与原始
/// call_id 配对的 `function_call_output`。控制状态不进入 payload——
/// 这里投影的是协议等价结果（Codex hosted web_search 契约）。
/// 从搜索 provider 响应提取文本结果：优先 Responses `output[].message
/// .content[].output_text.text`，其次 Chat `choices[].message.content`。
/// Req04 阶段（route 之前）的 Mode B 判定：按请求声明的 model 的编译期
/// `web_search_execution_mode` 解析。请求 model 无法解析时按 `None`（不激活
/// 本地搜索）。selected target 的 mode 由 Resp03 侧 response profile 再校验。
pub(crate) fn resolve_request_web_search_execution_mode(
    manifest: &V3Config05ManifestPublished,
    payload: &Value,
) -> routecodex_v3_config::V3WebSearchExecutionMode {
    let Some(model) = payload
        .get("model")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return routecodex_v3_config::V3WebSearchExecutionMode::None;
    };
    resolve_web_search_mode_and_backend(manifest, model).0
}

/// Mode B 的编译期 backend binding（`provider.model`）：请求 model 的 manifest
/// `web_search_backend_binding`。搜索 hop 用它 direct pin 搜索目标；Mode B 配置
/// 编译期已保证 exactly one binding，这里仅透传（解析失败按 None，由搜索 hop
/// fail-fast）。
pub(crate) fn responses_relay_request_hook_profile(
    manifest: &V3Config05ManifestPublished,
    server_id: &str,
    stopless_state: Option<&V3StoplessCenterState>,
    stopless_control_has_client_session_scope: bool,
    transition_request_id: &str,
    transition_updated_at: u64,
    web_search_execution_mode: routecodex_v3_config::V3WebSearchExecutionMode,
) -> V3HubServertoolRequestProfile {
    let base = if web_search_execution_mode.is_metadata_center_local_search() {
        // Mode B：Req04 需在工具面含标准 web_search 声明时激活 websearch
        // ServerTool 实例（LocalToolSurfaceActive），供 Resp03 同轮拦截。
        V3HubServertoolRequestProfile::enabled(["servertool.request"])
            .with_web_search_execution_mode(web_search_execution_mode)
    } else {
        V3HubServertoolRequestProfile::disabled()
    };
    if !v3_stopless_center_enabled_for_server(manifest, server_id)
        || !stopless_control_has_client_session_scope
    {
        return base;
    }
    let mut profile = V3HubServertoolRequestProfile::stopless_reasoning_stop()
        .with_stopless_transition_context(transition_request_id, transition_updated_at);
    if web_search_execution_mode.is_metadata_center_local_search() {
        profile = profile.with_web_search_execution_mode(web_search_execution_mode);
    }
    match stopless_state {
        Some(state) => profile.with_stopless_center_state(state.clone()),
        None => profile,
    }
}

pub(crate) fn responses_relay_response_hook_profile(
    manifest: &V3Config05ManifestPublished,
    server_id: &str,
    stopless_state: Option<&V3StoplessCenterState>,
    stopless_control_has_client_session_scope: bool,
    transition_request_id: &str,
    transition_updated_at: u64,
    web_search_execution_mode: routecodex_v3_config::V3WebSearchExecutionMode,
    retain_response_cipher: bool,
) -> V3HubRelayResponseHookProfile {
    let profile = if web_search_execution_mode
        == routecodex_v3_config::V3WebSearchExecutionMode::NativeRemoteSearchToolMix
        || web_search_execution_mode.is_metadata_center_local_search()
    {
        // Mode A（原生搜索）与 Mode B（本地 ServerToolCenter 治理）都不走
        // 客户端 exec_command 投影；Resp03 按 profile.mode 分别处理。
        V3HubRelayResponseHookProfile::empty()
            .with_web_search_execution_mode(web_search_execution_mode)
            .with_retain_response_cipher(retain_response_cipher)
    } else {
        // 未声明 web_search 执行模式的兼容路径：保持既有 exec_command 投影。
        V3HubRelayResponseHookProfile::empty()
            .with_servertool_name("web_search")
            .with_retain_response_cipher(retain_response_cipher)
    };
    if !v3_stopless_center_enabled_for_server(manifest, server_id)
        || !stopless_control_has_client_session_scope
    {
        return profile;
    }
    let profile = profile
        .with_stopless_reasoning_stop()
        .with_stopless_transition_context(transition_request_id, transition_updated_at);
    match stopless_state {
        Some(state) => profile.with_stopless_center_state(state.clone()),
        None => profile,
    }
}
