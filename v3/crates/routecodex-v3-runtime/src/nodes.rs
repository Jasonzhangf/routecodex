use futures_util::Stream;
use routecodex_v3_error::{
    build_v3_error_01_source_raised, V3Error01SourceRaised, V3ErrorSourceKind,
    V3ProviderFailureSessionScope,
};
use routecodex_v3_route_classifier::{
    classify_route, extract_active_turn_signals, RouteClassifierInput,
};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};
use std::fmt;
use std::pin::Pin;

#[derive(Debug, Clone, PartialEq)]
pub struct V3Server03HttpRequestRaw {
    pub server_id: String,
    pub failure_session_scope: V3ProviderFailureSessionScope,
    pub request_id: String,
    pub execution_id: String,
    pub method: String,
    pub path: String,
    pub body: Value,
}

pub fn build_v3_server_03_http_request_raw(
    server_id: String,
    failure_session_scope: V3ProviderFailureSessionScope,
    request_id: String,
    execution_id: String,
    method: String,
    path: String,
    body: Value,
) -> V3Server03HttpRequestRaw {
    V3Server03HttpRequestRaw {
        server_id,
        failure_session_scope,
        request_id,
        execution_id,
        method,
        path,
        body,
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct V3Req04StandardizedResponses {
    pub body: Value,
    pub protocol_context: V3ProtocolContext,
}

/// Chat 入口标准化（与 V3Req04StandardizedResponses 同构，协议不同）：
/// 校验 chat 协议必需字段（messages），应用唯一登记的历史图片占位清理，
/// 不携带 continuation locator（chat 无 previous_response_id）。
#[derive(Debug, Clone, PartialEq)]
pub struct V3Req04StandardizedChat {
    pub body: Value,
    pub protocol_context: V3ProtocolContext,
}

/// Chat direct 执行策略节点（与 V3ResponsesDirect11Policy 同构）。
#[derive(Debug, Clone, PartialEq)]
pub struct V3ChatDirect11Policy {
    pub target: routecodex_v3_target::V3Target10ConcreteProviderSelected,
    pub request_id: String,
    pub request_body: Value,
}

pub fn build_v3_chat_direct_11_policy_from_v3_target_10(
    selected: routecodex_v3_target::V3Target10ConcreteProviderSelected,
    standardized: &V3Req04StandardizedChat,
) -> V3ChatDirect11Policy {
    V3ChatDirect11Policy {
        target: selected,
        request_id: standardized.protocol_context.request_id.clone(),
        request_body: standardized.body.clone(),
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct V3ProtocolContext {
    pub server_id: String,
    pub failure_session_scope: V3ProviderFailureSessionScope,
    pub request_id: String,
    pub execution_id: String,
    pub endpoint: String,
    pub method: String,
    pub previous_response_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct V3ResponsesDirect11Policy {
    pub target: routecodex_v3_target::V3Target10ConcreteProviderSelected,
    pub request_id: String,
    pub request_body: Value,
    pub previous_response_id: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum V3Execution11ProtocolDecisionMode {
    SameProtocolDirect,
    HubRelay,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct V3Execution11ProtocolDecision {
    pub mode: V3Execution11ProtocolDecisionMode,
    pub entry_protocol: crate::hub_v1::V3HubProviderWireProtocol,
    pub selected_provider_protocol: crate::hub_v1::V3HubProviderWireProtocol,
    pub target: routecodex_v3_target::V3Target10ConcreteProviderSelected,
}

pub type V3ClientSseStream =
    Pin<Box<dyn Stream<Item = Result<Vec<u8>, V3Error01SourceRaised>> + Send>>;

pub enum V3ClientBody {
    Json(Value),
    Bytes(Vec<u8>),
    Sse(V3ClientSseStream),
}

impl fmt::Debug for V3ClientBody {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Json(value) => formatter.debug_tuple("Json").field(value).finish(),
            Self::Bytes(bytes) => formatter
                .debug_struct("Bytes")
                .field("byte_len", &bytes.len())
                .finish(),
            Self::Sse(_) => formatter.write_str("Sse(<client-event-stream>)"),
        }
    }
}

#[derive(Debug)]
pub struct V3Resp15ClientPayload {
    pub status: u16,
    pub headers: BTreeMap<String, String>,
    pub body: V3ClientBody,
}

pub fn build_v3_req_04_standardized_responses_from_v3_server_03(
    raw: V3Server03HttpRequestRaw,
) -> Result<V3Req04StandardizedResponses, String> {
    if let Some(key) = crate::hub_v1::find_v3_hub_side_channel_key(&raw.body) {
        return Err(format!(
            "RouteCodex side-channel field {key} cannot enter request payload"
        ));
    }
    let mut body = raw.body;
    let previous_response_id = match body.get("previous_response_id") {
        None | Some(Value::Null) => None,
        Some(Value::String(value)) => {
            let value = value.trim();
            if value.is_empty() {
                return Err("previous_response_id must be null or a non-empty string".to_string());
            }
            Some(value.to_string())
        }
        Some(_) => {
            return Err("previous_response_id must be null or a non-empty string".to_string())
        }
    };
    if body.get("previous_response_id").is_some() {
        body.as_object_mut()
            .ok_or_else(|| "Responses request payload must be an object".to_string())?
            .remove("previous_response_id");
    }
    // 与 chat direct / relay req_inbound 一致：历史轮图片占位符做语义等价归一化
    // （只清理历史轮图片引用，不影响当前轮输入；禁止在不可变区做任何修补）。
    crate::hub_v1::normalize_v3_history_image_placeholders(&mut body);
    Ok(V3Req04StandardizedResponses {
        protocol_context: V3ProtocolContext {
            server_id: raw.server_id,
            failure_session_scope: raw.failure_session_scope,
            request_id: raw.request_id,
            execution_id: raw.execution_id,
            endpoint: raw.path,
            method: raw.method,
            previous_response_id,
        },
        body,
    })
}

pub fn build_v3_chat_req_04_standardized_from_v3_server_03(
    raw: V3Server03HttpRequestRaw,
) -> Result<V3Req04StandardizedChat, String> {
    if let Some(key) = crate::hub_v1::find_v3_hub_side_channel_key(&raw.body) {
        return Err(format!(
            "RouteCodex side-channel field {key} cannot enter request payload"
        ));
    }
    let mut body = raw.body;
    if body.get("messages").and_then(Value::as_array).is_none() {
        return Err("Chat request payload must contain a messages array".to_string());
    }
    crate::hub_v1::normalize_v3_history_image_placeholders(&mut body);
    Ok(V3Req04StandardizedChat {
        protocol_context: V3ProtocolContext {
            server_id: raw.server_id,
            failure_session_scope: raw.failure_session_scope,
            request_id: raw.request_id,
            execution_id: raw.execution_id,
            endpoint: raw.path,
            method: raw.method,
            previous_response_id: None,
        },
        body,
    })
}

pub fn build_v3_router_request_facts_from_v3_req_04_chat(
    standardized: &V3Req04StandardizedChat,
    manifest: &routecodex_v3_config::V3Config05ManifestPublished,
) -> routecodex_v3_virtual_router::V3RouterRequestFacts {
    build_v3_router_request_facts_for_entry_with_control(
        &standardized.body,
        "openai_chat",
        configured_v3_longcontext_threshold_tokens(
            manifest,
            &standardized.protocol_context.server_id,
        ),
        false,
        Some(manifest),
    )
}

pub fn build_v3_router_request_facts_from_v3_req_04(
    standardized: &V3Req04StandardizedResponses,
    manifest: &routecodex_v3_config::V3Config05ManifestPublished,
) -> routecodex_v3_virtual_router::V3RouterRequestFacts {
    build_v3_router_request_facts_for_entry_with_control(
        &standardized.body,
        "responses",
        configured_v3_longcontext_threshold_tokens(
            manifest,
            &standardized.protocol_context.server_id,
        ),
        false,
        Some(manifest),
    )
}

pub fn build_v3_router_request_facts_for_entry(
    body: &Value,
    entry_protocol: &str,
    longcontext_threshold_tokens: Option<u64>,
) -> routecodex_v3_virtual_router::V3RouterRequestFacts {
    // 与真实路由一致：路由判定必须基于历史轮图片已归一化的 payload
    // （禁止 diagnostics dry-run / tests 与 cleaned 标准化路径发散）。
    let mut normalized = body.clone();
    crate::hub_v1::normalize_v3_history_image_placeholders(&mut normalized);
    build_v3_router_request_facts_for_entry_with_control(
        &normalized,
        entry_protocol,
        longcontext_threshold_tokens,
        false,
        None,
    )
}

/// relay 目标解析（provider_failure_runtime_policy）使用的 facts 构建：
/// 携带 manifest，使 Mode B（web_search_execution_mode=metadata_center_local_search）
/// 的 web_search 声明贡献路由能力。真实故障 20260808：无 manifest 的
/// `build_v3_router_request_facts_for_entry` 使 Mode B 判定失效 → web_search
/// pool 不命中 → 落 default。
pub(crate) fn build_v3_router_request_facts_for_entry_with_manifest(
    body: &Value,
    entry_protocol: &str,
    longcontext_threshold_tokens: Option<u64>,
    manifest: &routecodex_v3_config::V3Config05ManifestPublished,
) -> routecodex_v3_virtual_router::V3RouterRequestFacts {
    let mut normalized = body.clone();
    crate::hub_v1::normalize_v3_history_image_placeholders(&mut normalized);
    build_v3_router_request_facts_for_entry_with_control(
        &normalized,
        entry_protocol,
        longcontext_threshold_tokens,
        false,
        Some(manifest),
    )
}

fn build_v3_router_request_facts_for_entry_with_control(
    body: &Value,
    entry_protocol: &str,
    longcontext_threshold_tokens: Option<u64>,
    stopless_followup: bool,
    manifest: Option<&routecodex_v3_config::V3Config05ManifestPublished>,
) -> routecodex_v3_virtual_router::V3RouterRequestFacts {
    let mut capabilities = BTreeSet::from(["text".to_string()]);
    let input_tokens = estimate_v3_routing_input_tokens(body);
    let active_turn = extract_active_turn_signals(body);
    let has_image_attachment = has_v3_protocol_image_attachment(body);
    // 客户端显式声明 websearch 工具（function/custom 名为 websearch/web_search）
    // 是 typed current-turn 路由事实：候选 Mode B pool 必须据此命中，禁止依赖
    // 请求文本意图推断（r4 typed facts 设计：不扫描 payload 文本重建控制）。
    let declares_web_search_tool = request_declares_v3_web_search_tool(body, manifest);
    let route_classification = classify_route(&RouteClassifierInput {
        reached_long_context: longcontext_threshold_tokens
            .is_some_and(|threshold| input_tokens >= threshold),
        has_image_attachment,
        latest_message_from_user: active_turn.latest_message_from_user,
        stopless_followup,
        has_current_turn_tool_output: active_turn.has_current_turn_tool_output,
        has_current_turn_web_search: active_turn.has_current_turn_web_search
            || declares_web_search_tool,
        last_assistant_tool_category: active_turn
            .last_assistant_tool
            .as_ref()
            .map(|tool| tool.category.clone()),
        current_user_text: active_turn.current_user_text,
        has_background_keyword: false,
    });
    for capability in &route_classification.required_capabilities {
        capabilities.insert(capability.clone());
    }
    if has_image_attachment {
        capabilities.insert("multimodal".to_string());
        capabilities.insert("vision".to_string());
    }
    if active_turn.has_current_turn_tool_output {
        capabilities.insert("tool_outputs".to_string());
    }
    if request_declares_v3_client_tool_surface(body) {
        capabilities.insert("tools".to_string());
    }
    if declares_web_search_tool {
        capabilities.insert("web_search".to_string());
    }
    routecodex_v3_virtual_router::V3RouterRequestFacts {
        entry_protocol: entry_protocol.to_string(),
        client_model: body
            .get("model")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToOwned::to_owned),
        capabilities,
        input_tokens,
        route_classification,
    }
}

fn request_declares_v3_client_tool_surface(body: &Value) -> bool {
    body.get("tools")
        .and_then(Value::as_array)
        .is_some_and(|tools| tools.iter().any(is_v3_client_tool_declaration))
        || body
            .get("input")
            .and_then(Value::as_array)
            .is_some_and(|items| {
                items.iter().any(|item| {
                    item.get("type").and_then(Value::as_str) == Some("additional_tools")
                        && item
                            .get("tools")
                            .and_then(Value::as_array)
                            .is_some_and(|tools| tools.iter().any(is_v3_client_tool_declaration))
                })
            })
}

/// 客户端显式声明 websearch 工具：typed 当前轮路由事实，驱动 VR 命中候选 Mode B pool。
///
/// 两种形状按不同契约判定：
/// - function/custom 名为 websearch/web_search/web-search：无条件贡献 web_search
///   能力（fixlist item 1 验收：请求 model 非 Mode B（forwarder）但声明 websearch
///   工具时，VR 必须因 web_search 意图路由到 Mode B pool，再由候选 mode 在投影
///   层 fail-fast——Mode B 判定按 selected 候选 model 而非请求 model）。
/// - 标准 `{"type":"web_search"}` / `{"type":"web_search_preview"}` /
///   `{"type":"web_search_20250305","name":"web_search"}`：仅当请求 model 配置
///   Mode B 时贡献（v2-parity：非 Mode B 模型的原生 hosted 搜索由 provider 直接
///   处理，声明不改变路由）。
fn request_declares_v3_web_search_tool(
    body: &Value,
    manifest: Option<&routecodex_v3_config::V3Config05ManifestPublished>,
) -> bool {
    let declares = |tools: &Value, predicate: fn(&Value) -> bool| {
        tools
            .as_array()
            .is_some_and(|tools| tools.iter().any(predicate))
    };
    let declares_anywhere = |predicate: fn(&Value) -> bool| {
        body.get("tools").is_some_and(|tools| declares(tools, predicate))
            || body
                .get("input")
                .and_then(Value::as_array)
                .is_some_and(|items| {
                    items.iter().any(|item| {
                        item.get("type").and_then(Value::as_str) == Some("additional_tools")
                            && item.get("tools").is_some_and(|tools| declares(tools, predicate))
                    })
                })
    };
    // function/custom 命名 websearch 工具：无条件贡献（fixlist item 1）。
    if declares_anywhere(is_v3_web_search_function_tool_declaration) {
        return true;
    }
    // 标准形状：请求 model 必须配置 Mode B 才贡献（v2-parity）。
    let Some(manifest) = manifest else {
        return false;
    };
    let Some(model) = body
        .get("model")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return false;
    };
    let mode =
        crate::hub_v1::web_search_hop::resolve_web_search_mode_and_backend(manifest, model).0;
    mode.is_metadata_center_local_search()
        && declares_anywhere(is_v3_web_search_standard_declaration)
}

fn is_v3_web_search_function_tool_declaration(tool: &Value) -> bool {
    let kind = tool
        .get("type")
        .and_then(Value::as_str)
        .map(|value| value.trim().to_ascii_lowercase())
        .unwrap_or_default();
    if !matches!(kind.as_str(), "function" | "custom" | "") {
        return false;
    }
    let name = tool
        .pointer("/function/name")
        .or_else(|| tool.get("name"))
        .and_then(Value::as_str)
        .map(|value| value.trim().to_ascii_lowercase())
        .unwrap_or_default();
    matches!(name.as_str(), "websearch" | "web_search" | "web-search")
}

fn is_v3_web_search_standard_declaration(tool: &Value) -> bool {
    let kind = tool
        .get("type")
        .and_then(Value::as_str)
        .map(|value| value.trim().to_ascii_lowercase())
        .unwrap_or_default();
    matches!(kind.as_str(), "web_search" | "web_search_preview" | "web_search_20250305")
}

fn is_v3_client_tool_declaration(tool: &Value) -> bool {
    let kind = tool
        .get("type")
        .and_then(Value::as_str)
        .map(|value| value.trim().to_ascii_lowercase())
        .unwrap_or_default();
    if matches!(kind.as_str(), "web_search" | "web_search_preview") {
        return false;
    }
    let name = tool
        .pointer("/function/name")
        .or_else(|| tool.get("name"))
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or_default();
    !name.is_empty() && matches!(kind.as_str(), "function" | "custom" | "")
}

fn has_v3_protocol_image_attachment(body: &Value) -> bool {
    ["messages", "input", "contents"]
        .into_iter()
        .filter_map(|field| body.get(field))
        .any(value_contains_v3_protocol_image)
}

fn value_contains_v3_protocol_image(value: &Value) -> bool {
    match value {
        Value::Array(items) => items.iter().any(value_contains_v3_protocol_image),
        Value::Object(values) => {
            detect_v3_media_kind(values) == Some("image")
                || ["content", "parts"]
                    .into_iter()
                    .filter_map(|field| values.get(field))
                    .any(value_contains_v3_protocol_image)
        }
        _ => false,
    }
}

pub fn configured_v3_longcontext_threshold_tokens(
    manifest: &routecodex_v3_config::V3Config05ManifestPublished,
    server_id: &str,
) -> Option<u64> {
    manifest
        .servers
        .get(server_id)
        .and_then(|server| manifest.route_groups.get(&server.routing_group))
        .and_then(|group| group.pools.get("longcontext"))
        .and_then(|pool| pool.match_rule.as_ref())
        .and_then(|match_rule| match_rule.min_input_tokens)
}

fn estimate_v3_routing_input_tokens(body: &Value) -> u64 {
    crate::token_estimation::estimate_v3_request_tokens(body)
}

pub(crate) fn detect_v3_media_kind(
    values: &serde_json::Map<String, Value>,
) -> Option<&'static str> {
    let type_value = values
        .get("type")
        .and_then(Value::as_str)
        .map(|value| value.trim().to_ascii_lowercase())
        .unwrap_or_default();
    if type_value.contains("video") {
        return Some("video");
    }
    if type_value.contains("image") {
        return Some("image");
    }
    if values.contains_key("video_url") {
        return Some("video");
    }
    if values.contains_key("image_url") {
        return Some("image");
    }
    let data = values
        .get("data")
        .and_then(Value::as_str)
        .map(|value| value.trim().to_ascii_lowercase())
        .unwrap_or_default();
    if data.starts_with("data:video/") {
        return Some("video");
    }
    if data.starts_with("data:image/") {
        return Some("image");
    }
    None
}

pub fn build_v3_responses_direct_11_policy_from_v3_target_10(
    selected: routecodex_v3_target::V3Target10ConcreteProviderSelected,
    standardized: &V3Req04StandardizedResponses,
) -> V3ResponsesDirect11Policy {
    V3ResponsesDirect11Policy {
        target: selected,
        request_id: standardized.protocol_context.request_id.clone(),
        request_body: standardized.body.clone(),
        previous_response_id: standardized.protocol_context.previous_response_id.clone(),
    }
}

pub fn build_v3_execution_11_protocol_decision_from_v3_target_10(
    selected: routecodex_v3_target::V3Target10ConcreteProviderSelected,
    entry_protocol: &str,
    allowed_modes: &[String],
) -> Result<V3Execution11ProtocolDecision, V3Error01SourceRaised> {
    let entry_protocol = entry_protocol_wire_protocol(entry_protocol)?;
    let selected_provider_protocol = crate::hub_v1::provider_wire_protocol_for_provider_type(
        &selected.candidate.provider_id,
        &selected.candidate.provider_type,
    )
    .map_err(|error| {
        build_v3_error_01_source_raised(
            V3ErrorSourceKind::RuntimeFailure,
            "V3Execution11ProtocolDecision",
            "provider_protocol_unresolved",
            error,
        )
    })?;
    let direct_allowed = allowed_modes
        .iter()
        .any(|mode| mode.trim().eq_ignore_ascii_case("direct"));
    let relay_allowed = allowed_modes
        .iter()
        .any(|mode| mode.trim().eq_ignore_ascii_case("relay"));
    let responses_process_requires_relay = selected_provider_protocol
        == crate::hub_v1::V3HubProviderWireProtocol::Responses
        && selected
            .candidate
            .responses_process
            .as_deref()
            .map(|process| process.trim().eq_ignore_ascii_case("chat"))
            .unwrap_or(false);
    let mode = if responses_process_requires_relay {
        if !relay_allowed {
            return Err(build_v3_error_01_source_raised(
                V3ErrorSourceKind::RuntimeFailure,
                "V3Execution11ProtocolDecision",
                "responses_process_chat_relay_not_allowed",
                "responses provider process=chat requires relay mode but relay is not allowed",
            ));
        }
        V3Execution11ProtocolDecisionMode::HubRelay
    } else if entry_protocol == selected_provider_protocol {
        if direct_allowed {
            V3Execution11ProtocolDecisionMode::SameProtocolDirect
        } else if relay_allowed {
            V3Execution11ProtocolDecisionMode::HubRelay
        } else {
            return Err(build_v3_error_01_source_raised(
                V3ErrorSourceKind::RuntimeFailure,
                "V3Execution11ProtocolDecision",
                "protocol_same_execution_mode_not_allowed",
                "same protocol selected target requires direct or relay mode but neither is allowed",
            ));
        }
    } else if relay_allowed {
        V3Execution11ProtocolDecisionMode::HubRelay
    } else {
        return Err(build_v3_error_01_source_raised(
            V3ErrorSourceKind::RuntimeFailure,
            "V3Execution11ProtocolDecision",
            "protocol_mismatch_relay_not_allowed",
            format!(
                "entry protocol {:?} selected provider protocol {:?} requires relay but relay is not allowed",
                entry_protocol, selected_provider_protocol
            ),
        ));
    };
    Ok(V3Execution11ProtocolDecision {
        mode,
        entry_protocol,
        selected_provider_protocol,
        target: selected,
    })
}

fn entry_protocol_wire_protocol(
    entry_protocol: &str,
) -> Result<crate::hub_v1::V3HubProviderWireProtocol, V3Error01SourceRaised> {
    match entry_protocol.trim() {
        "responses" | "openai_responses" | "openai-responses" => {
            Ok(crate::hub_v1::V3HubProviderWireProtocol::Responses)
        }
        "anthropic" | "anthropic_messages" | "anthropic-messages" => {
            Ok(crate::hub_v1::V3HubProviderWireProtocol::Anthropic)
        }
        "openai_chat" | "openai-chat" | "chat_completions" | "chat-completions" => {
            Ok(crate::hub_v1::V3HubProviderWireProtocol::OpenAiChat)
        }
        "gemini" | "gemini_chat" | "gemini-chat" => {
            Ok(crate::hub_v1::V3HubProviderWireProtocol::Gemini)
        }
        other => Err(build_v3_error_01_source_raised(
            V3ErrorSourceKind::RuntimeFailure,
            "V3Execution11ProtocolDecision",
            "entry_protocol_unresolved",
            format!("unsupported entry protocol for protocol decision: {other}"),
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::{
        build_v3_req_04_standardized_responses_from_v3_server_03,
        build_v3_router_request_facts_for_entry, build_v3_router_request_facts_for_entry_with_control,
        build_v3_server_03_http_request_raw,
    };
    use routecodex_v3_config::{compile_v3_config_05_manifest, parse_v3_config_02_authoring};
    use routecodex_v3_error::V3ProviderFailureSessionScope;
    use serde_json::json;

    const TEST_LONGCONTEXT_THRESHOLD_TOKENS: Option<u64> = Some(180_000);

    #[test]
    fn req04_preserves_responses_data_and_extracts_typed_continuation_locator() {
        let raw = build_v3_server_03_http_request_raw(
            "server".to_string(),
            V3ProviderFailureSessionScope::new("server", "default", "request")
                .expect("failure scope"),
            "request".to_string(),
            "execution".to_string(),
            "POST".to_string(),
            "/v1/responses".to_string(),
            json!({
                "model":"gpt-5.5",
                "previous_response_id":"resp_typed_1",
                "input":[{"role":"user","content":[{"type":"input_text","text":"hello"}]}],
                "include":["reasoning.encrypted_content"]
            }),
        );

        let normalized = build_v3_req_04_standardized_responses_from_v3_server_03(raw)
            .expect("Responses inbound must preserve same-protocol data");

        assert!(normalized.body.get("messages").is_none());
        assert!(normalized.body.get("input").is_some());
        assert_eq!(normalized.body["include"][0], "reasoning.encrypted_content");
        assert!(normalized.body.get("previous_response_id").is_none());
        assert_eq!(
            normalized.protocol_context.previous_response_id.as_deref(),
            Some("resp_typed_1")
        );
    }

    #[test]
    fn req04_treats_null_previous_response_id_as_fresh_request() {
        let raw = build_v3_server_03_http_request_raw(
            "server".to_string(),
            V3ProviderFailureSessionScope::new("server", "default", "request")
                .expect("failure scope"),
            "request".to_string(),
            "execution".to_string(),
            "POST".to_string(),
            "/v1/responses".to_string(),
            json!({
                "model":"gpt-5.5",
                "previous_response_id": null,
                "input":[{"role":"user","content":[{"type":"input_text","text":"hello"}]}]
            }),
        );

        let normalized = build_v3_req_04_standardized_responses_from_v3_server_03(raw)
            .expect("null previous_response_id is semantically absent");

        assert!(normalized.protocol_context.previous_response_id.is_none());
        assert!(normalized.body.get("previous_response_id").is_none());
        assert_eq!(normalized.body["model"], "gpt-5.5");
    }

    #[test]
    fn req04_rejects_malformed_previous_response_id_instead_of_starting_fresh() {
        for previous_response_id in [json!(""), json!(42), json!({"id":"resp_1"}), json!([])] {
            let raw = build_v3_server_03_http_request_raw(
                "server".to_string(),
                V3ProviderFailureSessionScope::new("server", "default", "request")
                    .expect("failure scope"),
                "request".to_string(),
                "execution".to_string(),
                "POST".to_string(),
                "/v1/responses".to_string(),
                json!({
                    "model":"gpt-5.5",
                    "previous_response_id": previous_response_id,
                    "input":"hello"
                }),
            );

            let error = build_v3_req_04_standardized_responses_from_v3_server_03(raw)
                .expect_err("malformed continuation locator must fail before routing");
            assert_eq!(
                error,
                "previous_response_id must be null or a non-empty string"
            );
        }
    }

    #[test]
    fn v3_routing_token_estimate_omits_image_payload_bytes() {
        let base = json!({
            "model": "gpt-5.6-sol",
            "input": [
                {
                    "role": "user",
                    "content": [
                        { "type": "input_text", "text": "Describe this image." }
                    ]
                }
            ],
            "tools": []
        });
        let with_image = json!({
            "model": "gpt-5.6-sol",
            "input": [
                {
                    "role": "user",
                    "content": [
                        { "type": "input_text", "text": "Describe this image." },
                        {
                            "type": "input_image",
                            "image_url": {
                                "url": format!("data:image/png;base64,{}", "A".repeat(1_200_000))
                            }
                        }
                    ]
                }
            ],
            "tools": []
        });

        let base_tokens = build_v3_router_request_facts_for_entry(
            &base,
            "responses",
            TEST_LONGCONTEXT_THRESHOLD_TOKENS,
        )
        .input_tokens;
        let image_tokens = build_v3_router_request_facts_for_entry(
            &with_image,
            "responses",
            TEST_LONGCONTEXT_THRESHOLD_TOKENS,
        )
        .input_tokens;

        assert!(
            image_tokens <= base_tokens + 8,
            "V3 routing token estimate must omit image/base64 bytes like the V2 Rust estimator; base={base_tokens}, image={image_tokens}"
        );
    }

    #[test]
    fn v3_routing_facts_use_protocol_image_as_multimodal_signal() {
        let request = json!({
            "model": "gpt-5.6-sol",
            "input": [
                {
                    "role": "user",
                    "content": [
                        {"type": "input_text", "text": "Describe this image."},
                        {"type": "input_image", "image_url": {"url": "data:image/png;base64,AAAA"}}
                    ]
                }
            ],
            "tools": []
        });

        let facts = build_v3_router_request_facts_for_entry(
            &request,
            "responses",
            TEST_LONGCONTEXT_THRESHOLD_TOKENS,
        );

        assert!(facts.capabilities.contains("multimodal"));
        assert!(facts.capabilities.contains("vision"));
    }

    #[test]
    fn v3_routing_facts_ignore_client_metadata_image_claim_without_protocol_image() {
        let request = json!({
            "model": "gpt-5.6-sol",
            "metadata": {"hasImageAttachment": true},
            "input": [{
                "role": "user",
                "content": [
                    {"type": "input_text", "text": "Describe this image [Image #1]."}
                ]
            }]
        });

        let facts = build_v3_router_request_facts_for_entry(
            &request,
            "responses",
            TEST_LONGCONTEXT_THRESHOLD_TOKENS,
        );

        assert!(!facts.capabilities.contains("multimodal"));
        assert!(!facts.capabilities.contains("vision"));
    }

    #[test]
    fn v3_routing_facts_ignore_client_runtime_control_metadata() {
        let request = json!({
            "model": "gpt-5.5",
            "metadata": {"runtime_control": {"serverToolFollowup": true}},
            "input": [{"role":"user","content":"continue"}]
        });

        let facts = build_v3_router_request_facts_for_entry(
            &request,
            "responses",
            TEST_LONGCONTEXT_THRESHOLD_TOKENS,
        );

        assert_eq!(facts.route_classification.route_name, "thinking");
        assert_eq!(
            facts.route_classification.candidates,
            ["thinking", "default"]
        );
    }

    #[test]
    fn v3_routing_facts_do_not_model_stream_as_capability() {
        let request = json!({
            "model": "gpt-5.5",
            "stream": true,
            "input": [
                {
                    "role": "user",
                    "content": [
                        {"type": "input_text", "text": "ping"}
                    ]
                }
            ]
        });

        let facts = build_v3_router_request_facts_for_entry(
            &request,
            "responses",
            TEST_LONGCONTEXT_THRESHOLD_TOKENS,
        );

        assert!(facts.capabilities.contains("text"));
        assert!(
            !facts.capabilities.contains("streaming"),
            "stream is a transport intent, not a routing/model capability"
        );
    }

    #[test]
    fn v3_routing_facts_do_not_use_reasoning_as_route_signal() {
        let request = json!({
            "model": "gpt-5.5",
            "reasoning": {"effort": "medium"},
            "input": [
                {"role":"user","content":"apply the patch"},
                {
                    "type":"custom_tool_call",
                    "name":"apply_patch",
                    "call_id":"call_patch",
                    "input":"*** Begin Patch\n*** Update File: a\n*** End Patch"
                },
                {
                    "type":"custom_tool_call_output",
                    "call_id":"call_patch",
                    "output":"Done!"
                }
            ]
        });

        let facts = build_v3_router_request_facts_for_entry(
            &request,
            "responses",
            TEST_LONGCONTEXT_THRESHOLD_TOKENS,
        );

        assert_eq!(facts.route_classification.route_name, "coding");
        assert!(!facts.capabilities.contains("coding"));
        assert!(!facts.capabilities.contains("thinking"));
        assert!(!facts.capabilities.contains("reasoning"));
    }

    #[test]
    fn v3_routing_facts_mark_current_user_input_as_thinking() {
        let request = json!({
            "model": "gpt-5.5",
            "input": [{"role":"user","content":"继续按照合同进行修复"}]
        });

        let facts = build_v3_router_request_facts_for_entry(
            &request,
            "responses",
            TEST_LONGCONTEXT_THRESHOLD_TOKENS,
        );

        assert!(
            !facts.capabilities.contains("thinking"),
            "thinking is a route classification, not a target capability: {:?}",
            facts.capabilities
        );
        assert_eq!(facts.route_classification.route_name, "thinking");
        assert_eq!(
            facts.route_classification.candidates,
            ["thinking", "default"]
        );
    }

    #[test]
    fn v3_routing_facts_use_configured_longcontext_threshold() {
        let request = json!({
            "model": "gpt-5.5",
            "input": [{"role":"user","content":"short request"}]
        });

        let below_configured_threshold =
            build_v3_router_request_facts_for_entry(&request, "responses", Some(10_000));
        assert_eq!(
            below_configured_threshold.route_classification.route_name,
            "thinking"
        );

        let at_configured_threshold =
            build_v3_router_request_facts_for_entry(&request, "responses", Some(1));
        assert_eq!(
            at_configured_threshold.route_classification.route_name,
            "longcontext"
        );
        assert_eq!(
            at_configured_threshold.route_classification.candidates,
            ["longcontext", "default"]
        );
    }

    #[test]
    fn v3_routing_facts_mark_declared_codex_tool_surface_for_tools_pool() {
        let request = json!({
            "model": "gpt-5.5",
            "input": [
                {
                    "role": "developer",
                    "tools": [
                        {"type":"function","name":"exec_command"},
                        {"type":"function","name":"apply_patch"},
                        {"type":"function","name":"tool_search"}
                    ],
                    "type": "additional_tools"
                },
                {"role":"user","content":"继续实现并验证"}
            ]
        });

        let facts = build_v3_router_request_facts_for_entry(
            &request,
            "responses",
            TEST_LONGCONTEXT_THRESHOLD_TOKENS,
        );

        assert_eq!(facts.route_classification.route_name, "thinking");
        assert!(!facts.capabilities.contains("thinking"));
        assert!(facts.capabilities.contains("tools"));
        assert!(!facts.capabilities.contains("coding"));
        assert!(!facts.capabilities.contains("search"));
    }

    #[test]
    fn v3_routing_facts_ignore_stringified_tool_surface_text() {
        let request = json!({
            "model": "gpt-5.5",
            "input": "[{\"role\":\"developer\",\"type\":\"additional_tools\",\"tools\":[{\"type\":\"function\",\"name\":\"exec_command\"}]}]",
            "messages": [{"role":"user","content":"继续实现并验证"}]
        });

        let facts = build_v3_router_request_facts_for_entry(
            &request,
            "responses",
            TEST_LONGCONTEXT_THRESHOLD_TOKENS,
        );

        assert!(!facts.capabilities.contains("tools"));
    }

    #[test]
    fn v3_routing_facts_ignore_declared_web_search_builtin_surface() {
        let request = json!({
            "model": "gpt-5.5",
            "tools": [
                {"type":"web_search"},
                {"type":"web_search_preview"}
            ],
            "input": [{"role":"user","content":"continue the implementation"}]
        });

        let facts = build_v3_router_request_facts_for_entry(
            &request,
            "responses",
            TEST_LONGCONTEXT_THRESHOLD_TOKENS,
        );

        assert_eq!(facts.route_classification.route_name, "thinking");
        assert!(!facts.capabilities.contains("thinking"));
        assert!(!facts.capabilities.contains("tools"));
        assert!(!facts.capabilities.contains("web_search"));
        assert!(!facts.capabilities.contains("coding"));
    }

    #[test]
    fn v3_routing_facts_canonical_web_search_tool_declaration_contributes_capability() {
        // canonical（responses → chat）的 tools 数组含标准 `{"type":"web_search"}`
        // 声明（responses web_search item 转换形状）+ Mode B 请求 model 时
        // 必须产生 web_search 能力——真实路由的 facts 在 canonical 上构建
        // （kernel/foundation 传 req04 的 canonical payload），仅检测原始 input
        // part 或 function/custom websearch 名都会漏检 → web_search pool 不命中、
        // 落 default（真实故障 20260808）。
        let manifest = manifest_mode_b_websearch_for_routing_facts();
        let request = json!({
            "model": "MiniMax-M3",
            "messages": [{"role": "user", "content": "search routecodex"}],
            "tools": [{"type": "web_search"}]
        });
        let facts = build_v3_router_request_facts_for_entry_with_control(
            &request,
            "responses",
            TEST_LONGCONTEXT_THRESHOLD_TOKENS,
            false,
            Some(&manifest),
        );
        assert!(
            facts.capabilities.contains("web_search"),
            "canonical web_search tool declaration must contribute web_search capability: {:?}",
            facts.capabilities
        );
    }

    #[test]
    fn v3_routing_facts_anthropic_hosted_web_search_20250305_declaration_contributes_capability() {
        // anthropic hosted server tool 风格声明（`{"type":"web_search_20250305",
        // "name":"web_search"}`，MiniMax/Anthropic hosted web_search）与 responses
        // 标准 `{"type":"web_search"}` 是两种 web search capability 形状，都必须
        // 贡献 web_search 路由能力（声明决定路由）——否则 anthropic 入口的 hosted
        // web_search 声明不命中 web_search 池、落 default（真实故障风险）。
        let manifest = manifest_mode_b_websearch_for_routing_facts();
        let request = json!({
            "model": "MiniMax-M3",
            "messages": [{"role": "user", "content": "search routecodex"}],
            "tools": [{"type": "web_search_20250305", "name": "web_search"}]
        });
        let facts = build_v3_router_request_facts_for_entry_with_control(
            &request,
            "responses",
            TEST_LONGCONTEXT_THRESHOLD_TOKENS,
            false,
            Some(&manifest),
        );
        assert!(
            facts.capabilities.contains("web_search"),
            "anthropic hosted web_search_20250305 declaration must contribute web_search capability: {:?}",
            facts.capabilities
        );
    }

    #[test]
    fn v3_routing_facts_canonical_web_search_declaration_without_mode_b_model_stays_idle() {
        // v2-parity：非 Mode B 模型（gpt-5.5 原生 hosted）的 web_search 声明
        // 不贡献 web_search 路由能力（provider 原生处理搜索，无需本地 hop 路由）。
        let manifest = manifest_mode_b_websearch_for_routing_facts();
        let request = json!({
            "model": "gpt-5.5",
            "messages": [{"role": "user", "content": "continue"}],
            "tools": [{"type": "web_search"}]
        });
        let facts = build_v3_router_request_facts_for_entry_with_control(
            &request,
            "responses",
            TEST_LONGCONTEXT_THRESHOLD_TOKENS,
            false,
            Some(&manifest),
        );
        assert!(
            !facts.capabilities.contains("web_search"),
            "non-Mode-B model web_search declaration must not contribute: {:?}",
            facts.capabilities
        );
    }

    fn manifest_mode_b_websearch_for_routing_facts(
    ) -> routecodex_v3_config::V3Config05ManifestPublished {
        compile_v3_config_05_manifest(
            parse_v3_config_02_authoring(
                r#"
version = 3
[servers.controlled]
bind = "127.0.0.1"
port = 1
routing_group = "controlled"
[providers.mm]
type = "anthropic"
base_url = "https://api.minimaxi.com/anthropic"
default_model = "MiniMax-M3"
auth = { type = "api_key", entries = [{ alias = "key1", env = "MM_KEY" }] }
[providers.mm.models.MiniMax-M3]
wire_name = "MiniMax-M3"
capabilities = ["text", "tools", "web_search"]
web_search_execution_mode = "metadata_center_local_search"
web_search_backend = "MiniMax-M3"
[route_groups.controlled.pools.web_search]
selection = { strategy = "priority" }
match = { precedence = 20, required_capabilities = ["web_search"] }
targets = [{ kind = "provider_model", provider = "mm", model = "MiniMax-M3", key = "key1", priority = 1 }]
[route_groups.controlled.pools.default]
selection = { strategy = "priority" }
targets = [{ kind = "provider_model", provider = "mm", model = "MiniMax-M3", key = "key1", priority = 1 }]
"#,
            )
            .unwrap(),
        )
        .unwrap()
    }

    #[test]
    fn v3_routing_facts_current_turn_web_search_input_part_contributes_capability() {
        // 当前轮显式 web_search part（Responses input 数组）必须产生 web_search
        // 能力（否则 web_search pool 不命中、落 default——真实故障 20260808）。
        let request = json!({
            "model": "MiniMax-M3",
            "input": [
                {"type": "web_search", "query": "routecodex"},
                {
                    "type": "message",
                    "role": "user",
                    "content": [{"type": "input_text", "text": "search routecodex"}]
                }
            ]
        });
        let facts = build_v3_router_request_facts_for_entry(
            &request,
            "responses",
            TEST_LONGCONTEXT_THRESHOLD_TOKENS,
        );
        assert!(
            facts.capabilities.contains("web_search"),
            "responses input web_search part must contribute web_search capability: {:?}",
            facts.capabilities
        );
    }

    #[test]
    fn v3_routing_facts_classify_actual_current_turn_tools() {
        let classify = |name: &str, arguments: serde_json::Value| {
            let request = json!({
                "model": "gpt-5.5",
                "tools": [{"type":"web_search"}],
                "input": [
                    {"role":"user","content":"continue"},
                    {
                        "type":"function_call",
                        "name":name,
                        "call_id":"call_tool",
                        "arguments":arguments
                    },
                    {
                        "type":"function_call_output",
                        "call_id":"call_tool",
                        "output":"ok"
                    }
                ]
            });
            build_v3_router_request_facts_for_entry(
                &request,
                "responses",
                TEST_LONGCONTEXT_THRESHOLD_TOKENS,
            )
        };

        let thinking = classify("exec_command", json!({"cmd":"cat src/lib.rs"}));
        assert_eq!(thinking.route_classification.route_name, "thinking");
        assert!(!thinking.capabilities.contains("thinking"));
        assert!(!thinking.capabilities.contains("web_search"));

        let search = classify("exec_command", json!({"cmd":"rg -n route src"}));
        assert_eq!(search.route_classification.route_name, "search");
        assert!(!search.capabilities.contains("search"));

        let tools = classify("exec_command", json!({"cmd":"cargo test"}));
        assert_eq!(tools.route_classification.route_name, "tools");
        assert!(!tools.capabilities.contains("tools"));

        let web = classify("web_search", json!({"query":"latest release"}));
        assert_eq!(web.route_classification.route_name, "web_search");
        assert_eq!(
            web.route_classification.candidates,
            ["web_search", "default"]
        );
        assert!(web.capabilities.contains("web_search"));
    }

    #[test]
    fn v3_routing_facts_ignore_historical_tools_after_new_user_turn() {
        let request = json!({
            "model": "gpt-5.5",
            "input": [
                {"role":"user","content":"search the repo"},
                {
                    "type":"function_call",
                    "name":"exec_command",
                    "call_id":"call_old",
                    "arguments":{"cmd":"rg -n route src"}
                },
                {"type":"function_call_output","call_id":"call_old","output":"old"},
                {"role":"user","content":"now explain the result"}
            ]
        });

        let facts = build_v3_router_request_facts_for_entry(
            &request,
            "responses",
            TEST_LONGCONTEXT_THRESHOLD_TOKENS,
        );

        assert_eq!(facts.route_classification.route_name, "thinking");
        assert!(!facts.capabilities.contains("thinking"));
        assert!(!facts.capabilities.contains("search"));
        assert!(!facts.capabilities.contains("tools"));
    }

    #[test]
    fn v3_routing_facts_classify_old_failure_sample_as_coding_not_web_search() {
        let request = json!({
            "model": "gpt-5.5",
            "metadata": null,
            "reasoning": {"effort":"medium","summary":"detailed"},
            "tools": [
                {"type":"web_search"},
                {"type":"custom","name":"apply_patch"}
            ],
            "input": [
                {"type":"message","role":"user","content":[{"type":"input_text","text":"continue"}]},
                {
                    "type":"custom_tool_call",
                    "name":"apply_patch",
                    "call_id":"call_019fa961f9cc765083b8b8d3",
                    "input":"*** Update File: v3/crates/routecodex-v3-server/src/lib.rs"
                },
                {
                    "type":"custom_tool_call_output",
                    "call_id":"call_019fa961f9cc765083b8b8d3",
                    "output":"apply_patch verification failed"
                }
            ]
        });

        let facts = build_v3_router_request_facts_for_entry(
            &request,
            "responses",
            TEST_LONGCONTEXT_THRESHOLD_TOKENS,
        );

        assert_eq!(facts.route_classification.route_name, "coding");
        assert!(!facts.capabilities.contains("coding"));
        assert!(!facts.capabilities.contains("web_search"));
        assert_eq!(facts.route_classification.candidates, ["coding", "default"]);
    }

    #[test]
    fn v3_routing_token_estimate_omits_stringified_media_payloads() {
        let base_input = serde_json::to_string(&json!([
            { "type": "input_text", "text": "Summarize this clip." }
        ]))
        .unwrap();
        let base = json!({
            "model": "gpt-5.6-sol",
            "input": base_input,
            "tools": []
        });
        let stringified = serde_json::to_string(&json!([
            { "type": "input_text", "text": "Summarize this clip." },
            {
                "type": "input_video",
                "video_url": format!("data:video/mp4;base64,{}", "B".repeat(1_200_000))
            }
        ]))
        .unwrap();
        let with_video = json!({
            "model": "gpt-5.6-sol",
            "input": stringified,
            "tools": []
        });

        let base_tokens = build_v3_router_request_facts_for_entry(
            &base,
            "responses",
            TEST_LONGCONTEXT_THRESHOLD_TOKENS,
        )
        .input_tokens;
        let video_tokens = build_v3_router_request_facts_for_entry(
            &with_video,
            "responses",
            TEST_LONGCONTEXT_THRESHOLD_TOKENS,
        )
        .input_tokens;

        assert!(
            video_tokens <= base_tokens + 12,
            "V3 routing token estimate must omit stringified media/base64 bytes like the V2 Rust estimator; base={base_tokens}, video={video_tokens}"
        );
    }
}
