use super::{V3HubEntryProtocol, V3HubProviderWireProtocol, V3HubTransportIntent};
use crate::protocol_tables::{map_value as table_map_value, V3TableDirection, V3TableKind};
use serde_json::{json, Map, Value};
use std::collections::BTreeMap;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum V3OpenAiChatCodecStage {
    ClientInputToHubSemantic,
    HubSemanticToProviderWire,
    ProviderRawToHubResponseSemantic,
    HubResponseSemanticToClientProjection,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct V3OpenAiChatCodecTrace {
    pub stage: V3OpenAiChatCodecStage,
    pub entry_protocol: V3HubEntryProtocol,
    pub provider_protocol: V3HubProviderWireProtocol,
    pub transport_intent: V3HubTransportIntent,
}

macro_rules! payload_wrapper {
    ($name:ident) => {
        #[derive(Debug, Clone, PartialEq)]
        pub struct $name {
            payload: Value,
            trace: V3OpenAiChatCodecTrace,
        }

        impl $name {
            pub fn payload(&self) -> &Value {
                &self.payload
            }
            pub fn trace(&self) -> &V3OpenAiChatCodecTrace {
                &self.trace
            }
        }
    };
}

payload_wrapper!(V3OpenAiChatHubRequestSemantic);
payload_wrapper!(V3OpenAiChatProviderWirePayload);
payload_wrapper!(V3OpenAiChatHubResponseSemantic);
payload_wrapper!(V3OpenAiChatClientProjection);

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum V3OpenAiChatCodecError {
    #[error("OpenAI Chat codec accepts only the OpenAI Chat entry protocol")]
    EntryProtocolNotOpenAiChat,
    #[error("OpenAI Chat codec accepts only the OpenAI Chat provider protocol")]
    ProviderProtocolNotOpenAiChat,
    #[error("OpenAI Chat codec payload must be an object")]
    PayloadNotObject,
    #[error("OpenAI Chat codec payload leaked RouteCodex side-channel field: {field}")]
    SideChannelLeaked { field: String },
    #[error("OpenAI Chat request messages must be an array")]
    MessagesNotArray,
    #[error("OpenAI Chat response choices must be an array")]
    ChoicesNotArray,
    #[error("OpenAI Chat SSE event is malformed")]
    MalformedSseEvent,
    #[error("OpenAI Chat provider error requires error.message")]
    MalformedProviderError,
}

pub fn validate_v3_openai_chat_client_input_payload(
    payload: &Value,
    entry_protocol: V3HubEntryProtocol,
) -> Result<(), V3OpenAiChatCodecError> {
    if entry_protocol != V3HubEntryProtocol::OpenAiChat {
        return Err(V3OpenAiChatCodecError::EntryProtocolNotOpenAiChat);
    }
    validate_request(payload)
}

pub fn validate_v3_openai_chat_provider_response_payload(
    payload: &Value,
    provider_protocol: V3HubProviderWireProtocol,
    transport_intent: V3HubTransportIntent,
) -> Result<(), V3OpenAiChatCodecError> {
    if provider_protocol != V3HubProviderWireProtocol::OpenAiChat {
        return Err(V3OpenAiChatCodecError::ProviderProtocolNotOpenAiChat);
    }
    validate_response(payload, transport_intent)
}

pub fn characterize_v3_openai_chat_client_input_to_hub_semantic(
    payload: Value,
    entry_protocol: V3HubEntryProtocol,
    transport_intent: V3HubTransportIntent,
) -> Result<V3OpenAiChatHubRequestSemantic, V3OpenAiChatCodecError> {
    validate_v3_openai_chat_client_input_payload(&payload, entry_protocol)?;
    Ok(V3OpenAiChatHubRequestSemantic {
        payload,
        trace: trace(
            V3OpenAiChatCodecStage::ClientInputToHubSemantic,
            transport_intent,
        ),
    })
}

pub fn characterize_v3_openai_chat_hub_semantic_to_provider_wire(
    semantic: V3OpenAiChatHubRequestSemantic,
) -> Result<V3OpenAiChatProviderWirePayload, V3OpenAiChatCodecError> {
    validate_request(&semantic.payload)?;
    Ok(V3OpenAiChatProviderWirePayload {
        payload: semantic.payload,
        trace: trace(
            V3OpenAiChatCodecStage::HubSemanticToProviderWire,
            semantic.trace.transport_intent,
        ),
    })
}

pub fn characterize_v3_openai_chat_provider_raw_to_hub_response_semantic(
    payload: Value,
    provider_protocol: V3HubProviderWireProtocol,
    transport_intent: V3HubTransportIntent,
) -> Result<V3OpenAiChatHubResponseSemantic, V3OpenAiChatCodecError> {
    validate_v3_openai_chat_provider_response_payload(
        &payload,
        provider_protocol,
        transport_intent,
    )?;
    Ok(V3OpenAiChatHubResponseSemantic {
        payload,
        trace: trace(
            V3OpenAiChatCodecStage::ProviderRawToHubResponseSemantic,
            transport_intent,
        ),
    })
}

pub fn characterize_v3_openai_chat_hub_response_semantic_to_client_projection(
    semantic: V3OpenAiChatHubResponseSemantic,
) -> Result<V3OpenAiChatClientProjection, V3OpenAiChatCodecError> {
    validate_response(&semantic.payload, semantic.trace.transport_intent)?;
    Ok(V3OpenAiChatClientProjection {
        payload: semantic.payload,
        trace: trace(
            V3OpenAiChatCodecStage::HubResponseSemanticToClientProjection,
            semantic.trace.transport_intent,
        ),
    })
}

/// Read the canonical Responses tool-item identity used for OpenAI Chat
/// `tool_calls[].id`. Canonical items are keyed by `call_id`, but providers may
/// only carry `id`/`tool_call_id`; a present-but-empty field must not win over a
/// later non-empty one, otherwise the projected `tool_calls[].id` is empty and
/// the next turn's `tool_call_id` is rejected as an orphan. If no field carries a
/// non-empty identity the projection yields an empty id, which the request-side
/// governance rejects explicitly rather than fabricating one.
fn read_v3_openai_chat_tool_identity(item: &Map<String, Value>) -> &str {
    for key in ["call_id", "tool_call_id", "id"] {
        if let Some(value) = item.get(key).and_then(Value::as_str) {
            let trimmed = value.trim();
            if !trimmed.is_empty() {
                return trimmed;
            }
        }
    }
    ""
}

/// Project the governed canonical Responses-shaped response into the OpenAI
/// Chat client contract at RespOutbound05.
pub(crate) fn project_v3_openai_chat_client_response_from_canonical(
    canonical: &Value,
) -> Result<Value, String> {
    let object = canonical
        .as_object()
        .ok_or_else(|| "canonical response must be an object".to_string())?;
    let output = object.get("output").and_then(Value::as_array);
    let mut content = String::new();
    let mut refusal = None::<String>;
    let mut reasoning_content = String::new();
    let mut tool_calls = Vec::new();
    for item in output.into_iter().flatten() {
        match item.get("type").and_then(Value::as_str) {
            Some("output_text") => {
                if let Some(text) = item.get("text").and_then(Value::as_str) {
                    content.push_str(text);
                }
            }
            Some("message") => {
                for part in item
                    .get("content")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                {
                    match part.get("type").and_then(Value::as_str) {
                        Some("output_text") => {
                            if let Some(text) = part.get("text").and_then(Value::as_str) {
                                content.push_str(text);
                            }
                        }
                        Some("refusal") => {
                            if let Some(text) = part.get("refusal").and_then(Value::as_str) {
                                refusal.get_or_insert_with(String::new).push_str(text);
                            }
                        }
                        _ => {}
                    }
                }
            }
            Some("reasoning") => {
                for part in item
                    .get("summary")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                {
                    if let Some(text) = part.get("text").and_then(Value::as_str) {
                        if !reasoning_content.is_empty() {
                            reasoning_content.push('\n');
                        }
                        reasoning_content.push_str(text);
                    }
                }
            }
            Some("function_call" | "custom_tool_call") => {
                let call_id = item
                    .as_object()
                    .map(read_v3_openai_chat_tool_identity)
                    .unwrap_or_default();
                let name = item.get("name").and_then(Value::as_str).unwrap_or_default();
                let arguments = item
                    .get("arguments")
                    .and_then(Value::as_str)
                    .or_else(|| item.get("input").and_then(Value::as_str))
                    .unwrap_or_default();
                tool_calls.push(serde_json::json!({
                    "id": call_id,
                    "type": "function",
                    "function": {"name": name, "arguments": arguments}
                }));
            }
            _ => {}
        }
    }
    // A tool call is expressed by the projected `tool_calls` themselves; the
    // canonical `status` no longer carries a fabricated `requires_action`.
    // `finish_reason` is a Chat-only field: it is derived here from the
    // canonical `incomplete_details`, never read from a Responses client
    // object, which has no such field.
    let finish_reason = responses_as_chat_finish_reason(
        !tool_calls.is_empty(),
        object
            .get("incomplete_details")
            .and_then(|details| details.get("reason"))
            .and_then(Value::as_str),
    );
    let mut message = Map::new();
    message.insert("role".to_string(), Value::String("assistant".to_string()));
    if !content.is_empty() {
        message.insert("content".to_string(), Value::String(content));
    } else if tool_calls.is_empty() {
        message.insert("content".to_string(), Value::String(String::new()));
    }
    if !reasoning_content.is_empty() {
        message.insert(
            "reasoning_content".to_string(),
            Value::String(reasoning_content),
        );
    }
    if let Some(refusal) = refusal {
        message.insert("refusal".to_string(), Value::String(refusal));
    }
    if !tool_calls.is_empty() {
        message.insert("tool_calls".to_string(), Value::Array(tool_calls));
    }
    let mut response = Map::new();
    response.insert(
        "id".to_string(),
        object
            .get("id")
            .cloned()
            .unwrap_or_else(|| Value::String("chatcmpl_relay".to_string())),
    );
    response.insert(
        "object".to_string(),
        Value::String("chat.completion".to_string()),
    );
    if let Some(model) = object.get("model") {
        response.insert("model".to_string(), model.clone());
    }
    response.insert(
        "choices".to_string(),
        serde_json::json!([{"index": 0, "message": Value::Object(message), "finish_reason": finish_reason}]),
    );
    if let Some(usage) = object.get("usage") {
        if let Some(normalized) = project_v3_chat_usage_from_canonical(usage) {
            response.insert("usage".to_string(), normalized);
        }
    }
    Ok(Value::Object(response))
}

fn responses_as_chat_finish_reason(has_tool_calls: bool, reason: Option<&str>) -> &'static str {
    if has_tool_calls {
        return "tool_calls";
    }
    match reason {
        Some("max_output_tokens") => "length",
        Some("content_filter") => "content_filter",
        _ => "stop",
    }
}

/// Responses 语义 usage -> OpenAI Chat wire usage 唯一归一化入口（JSON 响应与
/// SSE 终帧共用；禁止在投影层各自复制一份转换）。
///
/// 输入侧语义判定与 `effective_input` / `cached` 推导唯一真源是
/// `super::usage_normalization::split_v3_canonical_usage_cache`，本模块只做字段名投影。
pub(crate) use super::usage_normalization::project_v3_chat_usage_from_canonical;

/// Incremental Anthropic wire-event to OpenAI Chat client transducer.
///
/// The runtime owns byte framing and stream lifecycle. This codec owns event
/// ordering, provider-field interpretation, and client chunk projection.
#[derive(Debug, Default)]
pub(crate) struct V3OpenAiChatAnthropicSseTransducer {
    message_started: bool,
    message_stopped: bool,
    message_id: Option<String>,
    model: Option<String>,
    active_blocks: std::collections::BTreeMap<usize, String>,
    terminal_finish_reason: Option<String>,
    input_tokens: Option<u64>,
    output_tokens: Option<u64>,
    cache_read_input_tokens: Option<u64>,
    cache_creation_input_tokens: Option<u64>,
    local_web_search: bool,
}

impl V3OpenAiChatAnthropicSseTransducer {
    pub(crate) fn new(local_web_search: bool) -> Self {
        Self {
            local_web_search,
            ..Self::default()
        }
    }

    pub(crate) fn push_event(&mut self, event: Value) -> Result<Vec<Value>, String> {
        let object = event
            .as_object()
            .ok_or_else(|| "Anthropic SSE event must be an object".to_string())?;
        let event_type = object
            .get("type")
            .and_then(Value::as_str)
            .ok_or_else(|| "Anthropic SSE event is missing type".to_string())?;
        if self.message_stopped && event_type != "ping" {
            return Err("Anthropic SSE emitted data after message_stop".to_string());
        }
        match event_type {
            "ping" => Ok(Vec::new()),
            "message_start" => self.message_start(object),
            "content_block_start" => self.content_block_start(object),
            "content_block_delta" => self.content_block_delta(object),
            "content_block_stop" => self.content_block_stop(object),
            "message_delta" => self.message_delta(object),
            "message_stop" => self.message_stop(),
            "error" => Err(object
                .get("error")
                .and_then(Value::as_object)
                .and_then(|error| error.get("message"))
                .and_then(Value::as_str)
                .unwrap_or("Anthropic SSE provider error")
                .to_string()),
            other => Err(format!("Anthropic SSE event type {other} is unsupported")),
        }
    }

    pub(crate) fn finish(&self) -> Result<(), String> {
        if !self.message_stopped || self.terminal_finish_reason.is_none() {
            return Err("Anthropic SSE ended without message_stop".to_string());
        }
        Ok(())
    }

    fn message_start(&mut self, object: &Map<String, Value>) -> Result<Vec<Value>, String> {
        if self.message_started {
            return Err("Anthropic SSE emitted duplicate message_start".to_string());
        }
        let message = object
            .get("message")
            .and_then(Value::as_object)
            .ok_or_else(|| "Anthropic message_start is missing message".to_string())?;
        self.message_started = true;
        self.message_id = message.get("id").and_then(Value::as_str).map(str::to_owned);
        self.model = message
            .get("model")
            .and_then(Value::as_str)
            .map(str::to_owned);
        let usage = message.get("usage").and_then(Value::as_object);
        self.input_tokens = usage
            .and_then(|usage| usage.get("input_tokens"))
            .and_then(Value::as_u64);
        // Anthropic 语义：input_tokens 只记未命中增量，缓存读/写是独立计数，
        // 必须在同一 transducer 内累计后交给唯一 Chat wire 投影入口。
        self.cache_read_input_tokens = usage
            .and_then(|usage| usage.get("cache_read_input_tokens"))
            .and_then(Value::as_u64);
        self.cache_creation_input_tokens = usage
            .and_then(|usage| usage.get("cache_creation_input_tokens"))
            .and_then(Value::as_u64);
        Ok(vec![self.chunk(json!({"role":"assistant"}), None, false)])
    }

    fn content_block_start(&mut self, object: &Map<String, Value>) -> Result<Vec<Value>, String> {
        self.require_started("content_block_start")?;
        let index = object
            .get("index")
            .and_then(Value::as_u64)
            .ok_or_else(|| "Anthropic content_block_start is missing index".to_string())?
            as usize;
        if self.active_blocks.contains_key(&index) {
            return Err(format!("Anthropic content block {index} started twice"));
        }
        let block = object
            .get("content_block")
            .and_then(Value::as_object)
            .ok_or_else(|| "Anthropic content_block_start is missing content_block".to_string())?;
        let kind = block
            .get("type")
            .and_then(Value::as_str)
            .ok_or_else(|| "Anthropic content block is missing type".to_string())?;
        self.active_blocks.insert(index, kind.to_string());
        if kind != "tool_use" {
            return Ok(Vec::new());
        }
        let name = block
            .get("name")
            .and_then(Value::as_str)
            .ok_or_else(|| "Anthropic tool_use is missing name".to_string())?;
        if self.local_web_search && matches!(name, "websearch" | "web_search") {
            return Err("ROUTECODEX_GOVERNANCE_REJECTED: Anthropic web_search has no Chat result projection".to_string());
        }
        let id = block
            .get("id")
            .and_then(Value::as_str)
            .ok_or_else(|| "Anthropic tool_use is missing id".to_string())?;
        Ok(vec![self.chunk(
            json!({"tool_calls":[{"index":index,"id":id,"type":"function","function":{"name":name,"arguments":""}}]}),
            None,
            false,
        )])
    }

    fn content_block_delta(&mut self, object: &Map<String, Value>) -> Result<Vec<Value>, String> {
        self.require_started("content_block_delta")?;
        let index = object
            .get("index")
            .and_then(Value::as_u64)
            .ok_or_else(|| "Anthropic content_block_delta is missing index".to_string())?
            as usize;
        let delta = object
            .get("delta")
            .and_then(Value::as_object)
            .ok_or_else(|| "Anthropic content_block_delta is missing delta".to_string())?;
        let delta_type = delta.get("type").and_then(Value::as_str);
        if !self.active_blocks.contains_key(&index) && delta_type == Some("signature_delta") {
            return Ok(Vec::new());
        }
        let kind = self
            .active_blocks
            .get(&index)
            .ok_or_else(|| format!("Anthropic content block {index} has no start"))?;
        match (kind.as_str(), delta_type) {
            ("text", Some("text_delta")) => Ok(vec![self.chunk(
                json!({"content": delta.get("text").and_then(Value::as_str).ok_or("Anthropic text_delta is missing text")?}),
                None,
                false,
            )]),
            ("thinking", Some("thinking_delta")) => Ok(vec![self.chunk(
                json!({"reasoning_content": delta.get("thinking").and_then(Value::as_str).ok_or("Anthropic thinking_delta is missing thinking")?}),
                None,
                false,
            )]),
            ("tool_use", Some("input_json_delta")) => Ok(vec![self.chunk(
                json!({"tool_calls":[{"index":index,"function":{"arguments":delta.get("partial_json").and_then(Value::as_str).ok_or("Anthropic input_json_delta is missing partial_json")?}}]}),
                None,
                false,
            )]),
            ("thinking", Some("signature_delta")) => Ok(Vec::new()),
            (_, Some("citations_delta")) => Ok(Vec::new()),
            (kind, delta_type) => Err(format!(
                "Anthropic delta {delta_type:?} does not match content block {kind}"
            )),
        }
    }

    fn content_block_stop(&mut self, object: &Map<String, Value>) -> Result<Vec<Value>, String> {
        self.require_started("content_block_stop")?;
        let index = object
            .get("index")
            .and_then(Value::as_u64)
            .ok_or_else(|| "Anthropic content_block_stop is missing index".to_string())?
            as usize;
        self.active_blocks
            .remove(&index)
            .map(|_| Vec::new())
            .ok_or_else(|| format!("Anthropic content block {index} stopped without start"))
    }

    fn message_delta(&mut self, object: &Map<String, Value>) -> Result<Vec<Value>, String> {
        self.require_started("message_delta")?;
        if let Some(reason) = object
            .get("delta")
            .and_then(Value::as_object)
            .and_then(|delta| delta.get("stop_reason"))
            .and_then(Value::as_str)
        {
            self.terminal_finish_reason = Some(
                // anthropic stop_reason -> hub -> openai_chat（查表；未命中默认 "stop"，与原 match 兜底一致）
                table_map_value(
                    V3TableKind::FinishReason,
                    "anthropic",
                    reason,
                    V3TableDirection::Inbound,
                )
                .ok()
                .flatten()
                .and_then(|hub| {
                    table_map_value(
                        V3TableKind::FinishReason,
                        "openai_chat",
                        hub,
                        V3TableDirection::Outbound,
                    )
                    .ok()
                    .flatten()
                })
                .unwrap_or("stop")
                .to_string(),
            );
        }
        // MiniMax anthropic 兼容接口（线上抓包实证 2026-08-09）：message_start
        // 的 usage.input_tokens 是占位 0，真实 input_tokens 与 output_tokens 一起
        // 出现在 message_delta 的 usage 里。两个字段都必须在此覆盖更新（官方
        // Anthropic 接口 message_delta 只带 output_tokens，input 已在 message_start
        // 为真实值；覆盖语义对两者兼容：有值才覆盖，缺值保留已有）。
        if let Some(usage) = object.get("usage").and_then(Value::as_object) {
            if let Some(input) = usage.get("input_tokens").and_then(Value::as_u64) {
                self.input_tokens = Some(input);
            }
            if let Some(output) = usage.get("output_tokens").and_then(Value::as_u64) {
                self.output_tokens = Some(output);
            }
            if let Some(read) = usage.get("cache_read_input_tokens").and_then(Value::as_u64) {
                self.cache_read_input_tokens = Some(read);
            }
            if let Some(creation) = usage
                .get("cache_creation_input_tokens")
                .and_then(Value::as_u64)
            {
                self.cache_creation_input_tokens = Some(creation);
            }
        }
        Ok(Vec::new())
    }

    fn message_stop(&mut self) -> Result<Vec<Value>, String> {
        self.require_started("message_stop")?;
        if !self.active_blocks.is_empty() {
            return Err("Anthropic message_stop arrived before content_block_stop".to_string());
        }
        self.message_stopped = true;
        let finish_reason = self
            .terminal_finish_reason
            .clone()
            .unwrap_or_else(|| "stop".to_string());
        let mut output = vec![self.chunk(json!({}), Some(&finish_reason), false)];
        // 唯一判据：canonical_usage() 同时决定终帧是否携带 usage 与携带什么内容，
        // 避免门禁条件与投影条件分叉（仅缓存字段出现时也必须一致）。
        if self.canonical_usage().is_some() {
            output.push(self.chunk(json!({}), None, true));
        }
        Ok(output)
    }

    fn require_started(&self, event: &str) -> Result<(), String> {
        if self.message_started {
            Ok(())
        } else {
            Err(format!("Anthropic {event} arrived before message_start"))
        }
    }

    fn chunk(&self, delta: Value, finish_reason: Option<&str>, choices_empty: bool) -> Value {
        let mut chunk = Map::new();
        chunk.insert(
            "id".to_string(),
            self.message_id
                .as_ref()
                .map(|value| Value::String(value.clone()))
                .unwrap_or(Value::Null),
        );
        chunk.insert(
            "object".to_string(),
            Value::String("chat.completion.chunk".to_string()),
        );
        if let Some(model) = &self.model {
            chunk.insert("model".to_string(), Value::String(model.clone()));
        }
        let finish = finish_reason
            .map(|reason| Value::String(reason.to_string()))
            .unwrap_or(Value::Null);
        if choices_empty {
            chunk.insert("choices".to_string(), Value::Array(Vec::new()));
        } else {
            chunk.insert(
                "choices".to_string(),
                json!([{"index":0,"delta":delta,"finish_reason":finish}]),
            );
        }
        if choices_empty {
            if let Some(usage) = self.canonical_usage() {
                chunk.insert("usage".to_string(), usage);
            }
        }
        Value::Object(chunk)
    }

    /// 累计的 Anthropic usage 归一化为 canonical Responses 语义 usage，再交给唯一
    /// Chat wire 投影入口；禁止在本 transducer 内复制缓存/子计数换算。
    fn canonical_usage(&self) -> Option<Value> {
        if self.input_tokens.is_none()
            && self.output_tokens.is_none()
            && self.cache_read_input_tokens.is_none()
            && self.cache_creation_input_tokens.is_none()
        {
            return None;
        }
        let mut usage = Map::new();
        if let Some(value) = self.input_tokens {
            usage.insert("input_tokens".to_string(), Value::from(value));
        }
        if let Some(value) = self.output_tokens {
            usage.insert("output_tokens".to_string(), Value::from(value));
        }
        if let Some(value) = self.cache_read_input_tokens {
            usage.insert("cache_read_input_tokens".to_string(), Value::from(value));
        }
        if let Some(value) = self.cache_creation_input_tokens {
            usage.insert(
                "cache_creation_input_tokens".to_string(),
                Value::from(value),
            );
        }
        project_v3_chat_usage_from_canonical(&Value::Object(usage))
    }
}

fn trace(
    stage: V3OpenAiChatCodecStage,
    transport_intent: V3HubTransportIntent,
) -> V3OpenAiChatCodecTrace {
    V3OpenAiChatCodecTrace {
        stage,
        entry_protocol: V3HubEntryProtocol::OpenAiChat,
        provider_protocol: V3HubProviderWireProtocol::OpenAiChat,
        transport_intent,
    }
}

fn validate_request(payload: &Value) -> Result<(), V3OpenAiChatCodecError> {
    reject_side_channel_fields(payload)?;
    payload
        .get("messages")
        .and_then(Value::as_array)
        .ok_or(V3OpenAiChatCodecError::MessagesNotArray)?;
    Ok(())
}

fn validate_response(
    payload: &Value,
    transport: V3HubTransportIntent,
) -> Result<(), V3OpenAiChatCodecError> {
    reject_side_channel_fields(payload)?;
    match transport {
        V3HubTransportIntent::Json => validate_json_response(payload),
        V3HubTransportIntent::Sse => validate_sse_event(payload),
    }
}

fn validate_json_response(payload: &Value) -> Result<(), V3OpenAiChatCodecError> {
    if payload.get("error").is_some() {
        return validate_provider_error(payload);
    }
    let choices = payload
        .get("choices")
        .and_then(Value::as_array)
        .ok_or(V3OpenAiChatCodecError::ChoicesNotArray)?;
    for choice in choices {
        require_object(choice)?;
    }
    Ok(())
}

fn validate_sse_event(payload: &Value) -> Result<(), V3OpenAiChatCodecError> {
    let object = require_object(payload)?;
    if object.get("object").and_then(Value::as_str) != Some("chat.completion.chunk")
        || !matches!(object.get("choices"), Some(Value::Array(_)))
    {
        return Err(V3OpenAiChatCodecError::MalformedSseEvent);
    }
    Ok(())
}

fn validate_provider_error(payload: &Value) -> Result<(), V3OpenAiChatCodecError> {
    let valid = payload
        .get("error")
        .and_then(Value::as_object)
        .and_then(|error| error.get("message"))
        .and_then(Value::as_str)
        .is_some_and(|message| !message.is_empty());
    if valid {
        Ok(())
    } else {
        Err(V3OpenAiChatCodecError::MalformedProviderError)
    }
}

fn reject_side_channel_fields(payload: &Value) -> Result<(), V3OpenAiChatCodecError> {
    for key in require_object(payload)?.keys() {
        if routecodex_v3_provider_responses::V3_ROUTECODEX_CONTROL_PAYLOAD_KEYS
            .contains(&key.as_str())
        {
            return Err(V3OpenAiChatCodecError::SideChannelLeaked { field: key.clone() });
        }
    }
    Ok(())
}

fn require_object(payload: &Value) -> Result<&Map<String, Value>, V3OpenAiChatCodecError> {
    payload
        .as_object()
        .ok_or(V3OpenAiChatCodecError::PayloadNotObject)
}

/// Responses 协议 SSE -> OpenAI Chat SSE 的流式转换器（provider 解耦）：
/// 客户端 Chat SSE 由本转换器生成，provider 的 responses SSE 事件
/// （response.created / output_text.delta / output_item.done / completed）
/// 逐帧映射为 chat.completion.chunk。未映射事件容错跳过，不允许把
/// provider 的 responses SSE 直接当作 chat SSE 透传（缺 choices 会
/// 让 chat SSE 状态机 fail-fast -> 客户端 EOF）。
pub(crate) struct V3OpenAiChatResponsesSseTransducer {
    response_started: bool,
    completed: bool,
    emitted_items: BTreeMap<usize, Map<String, Value>>,
    summary_part_indices: BTreeMap<usize, u64>,
    response_id: Option<String>,
    model: Option<String>,
    tool_call_index: usize,
    emitted_tool_call: bool,
    include_usage: bool,
}

impl Default for V3OpenAiChatResponsesSseTransducer {
    fn default() -> Self {
        Self {
            response_started: false,
            completed: false,
            emitted_items: BTreeMap::new(),
            summary_part_indices: BTreeMap::new(),
            response_id: None,
            model: None,
            tool_call_index: 0,
            emitted_tool_call: false,
            include_usage: true,
        }
    }
}

impl V3OpenAiChatResponsesSseTransducer {
    pub(crate) fn new() -> Self {
        Self::default()
    }

    pub(crate) fn new_with_usage_option(include_usage: bool) -> Self {
        Self {
            include_usage,
            ..Self::default()
        }
    }

    pub(crate) fn push_event(&mut self, event: Value) -> Result<Vec<Value>, String> {
        let object = event
            .as_object()
            .ok_or_else(|| "Responses SSE event must be an object".to_string())?;
        let event_type = object
            .get("type")
            .and_then(Value::as_str)
            .ok_or_else(|| "Responses SSE event is missing type".to_string())?;
        if self.completed {
            return Ok(Vec::new());
        }
        match event_type {
            "response.created" => {
                if self.response_started {
                    return Err("Responses SSE emitted duplicate response.created".to_string());
                }
                self.response_started = true;
                let response = object.get("response").and_then(Value::as_object);
                self.response_id = response
                    .and_then(|response| response.get("id"))
                    .and_then(Value::as_str)
                    .map(str::to_owned);
                self.model = response
                    .and_then(|response| response.get("model"))
                    .and_then(Value::as_str)
                    .map(str::to_owned);
                Ok(vec![self.chunk(json!({"role": "assistant"}), None)])
            }
            "response.in_progress" => {
                // Official Responses SSE streams emit response.in_progress after
                // response.created as a status transition. It is idempotent here:
                // it starts the response when it arrives first (some implementations
                // emit no created event) and otherwise carries no output.
                if !self.response_started {
                    self.response_started = true;
                    let response = object.get("response").and_then(Value::as_object);
                    self.response_id = response
                        .and_then(|response| response.get("id"))
                        .and_then(Value::as_str)
                        .map(str::to_owned);
                    self.model = response
                        .and_then(|response| response.get("model"))
                        .and_then(Value::as_str)
                        .map(str::to_owned);
                    return Ok(vec![self.chunk(json!({"role": "assistant"}), None)]);
                }
                Ok(Vec::new())
            }
            "response.output_text.delta" => {
                let delta = object
                    .get("delta")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                if delta.is_empty() {
                    return Ok(Vec::new());
                }
                self.record_delta(object, "content", delta);
                Ok(vec![self.chunk(json!({"content": delta}), None)])
            }
            "response.refusal.delta" => {
                let delta = object
                    .get("delta")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                if delta.is_empty() {
                    return Ok(Vec::new());
                }
                self.record_delta(object, "refusal", delta);
                Ok(vec![self.chunk(json!({"refusal": delta}), None)])
            }
            "response.output_item.done" => {
                let Some(item) = object.get("item").and_then(Value::as_object) else {
                    return Ok(Vec::new());
                };
                let index = object
                    .get("output_index")
                    .and_then(Value::as_u64)
                    .map(|index| index as usize)
                    .unwrap_or(self.tool_call_index);
                self.output_item_chunks(index, &Value::Object(item.clone()))
            }
            "response.completed" => {
                self.completed = true;
                let response = object.get("response").and_then(Value::as_object);
                let mut chunks = self.terminal_output_chunks(response)?;
                let status = response
                    .and_then(|response| response.get("status"))
                    .and_then(Value::as_str);
                let finish_reason = if status == Some("completed") {
                    Some(responses_as_chat_finish_reason(
                        self.emitted_tool_call,
                        None,
                    ))
                } else {
                    None
                };
                chunks.push(self.chunk(json!({}), finish_reason));
                if let Some(usage) = response.and_then(|response| response.get("usage")) {
                    if let Some(chunk) = self.usage_chunk(usage) {
                        chunks.push(chunk);
                    }
                }
                Ok(chunks)
            }
            // Preserve the JSON projection's terminal mapping. Chat has no
            // standard reason for opaque Responses incomplete reasons; `stop`
            // closes the transport without guessing length or content_filter.
            "response.incomplete" => {
                self.completed = true;
                let response = object.get("response").and_then(Value::as_object);
                let reason = object
                    .get("incomplete_details")
                    .and_then(Value::as_object)
                    .and_then(|details| details.get("reason"))
                    .and_then(Value::as_str)
                    .or_else(|| {
                        response
                            .and_then(|response| response.get("incomplete_details"))
                            .and_then(Value::as_object)
                            .and_then(|details| details.get("reason"))
                            .and_then(Value::as_str)
                    });
                let mut chunks = self.terminal_output_chunks(response)?;
                let finish_reason = responses_as_chat_finish_reason(self.emitted_tool_call, reason);
                chunks.push(self.chunk(json!({}), Some(finish_reason)));
                if let Some(usage) = response.and_then(|response| response.get("usage")) {
                    if let Some(chunk) = self.usage_chunk(usage) {
                        chunks.push(chunk);
                    }
                }
                Ok(chunks)
            }
            // 事件通知/参数收口帧由 Responses 语义层消费；Chat 投影没有
            // 对应的独立 chunk，但必须接受它们，直到 response.completed。
            "response.output_item.added"
            | "response.content_part.added"
            | "response.content_part.done"
            | "response.output_text.done"
            | "response.output_text.annotation.added"
            | "response.function_call_arguments.delta"
            | "response.function_call_arguments.done"
            | "response.reasoning_text.done"
            | "response.reasoning_summary_part.added"
            | "response.reasoning_summary_part.done"
            | "response.reasoning_summary_text.done"
            | "response.reasoning_signature.delta"
            | "response.reasoning_image.delta"
            | "response.custom_tool_call_input.delta"
            | "response.custom_tool_call_input.done"
            | "response.refusal.done"
            | "response.web_search_call.in_progress"
            | "response.web_search_call.searching"
            | "response.web_search_call.completed"
            | "response.file_search_call.in_progress"
            | "response.file_search_call.searching"
            | "response.file_search_call.completed"
            | "response.mcp_call.in_progress"
            | "response.mcp_call.arguments.delta"
            | "response.mcp_call.arguments.done"
            | "response.mcp_call.completed"
            | "response.computer_call.in_progress"
            | "response.computer_call_output.in_progress"
            | "response.computer_call_output.completed"
            | "response.code_interpreter_call.in_progress"
            | "response.code_interpreter_call_code.delta"
            | "response.code_interpreter_call_code.done"
            | "response.code_interpreter_call.completed"
            | "response.image_generation_call.in_progress"
            | "response.image_generation_call.partial_image"
            | "response.image_generation_call.completed"
            | "response.audio.delta"
            | "response.audio.done"
            | "response.audio_transcript.delta"
            | "response.audio_transcript.done"
            | "response.requires_action"
            | "response.done" => Ok(Vec::new()),
            // reasoning 内容必须投影给客户端（与 Anthropic thinking_delta 投影
            // reasoning_content 一致）：reasoning-only 响应不得被当作空响应丢弃。
            "response.reasoning_summary_text.delta" | "response.reasoning_text.delta" => {
                let delta = object
                    .get("delta")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                if delta.is_empty() {
                    return Ok(Vec::new());
                }
                let mut delta = delta.to_owned();
                if event_type == "response.reasoning_summary_text.delta" {
                    let index = object
                        .get("output_index")
                        .and_then(Value::as_u64)
                        .unwrap_or(0) as usize;
                    let part = object
                        .get("summary_index")
                        .and_then(Value::as_u64)
                        .unwrap_or(0);
                    let previous = self.summary_part_indices.insert(index, part);
                    if previous.is_some_and(|previous| previous != part)
                        && self
                            .emitted_items
                            .get(&index)
                            .and_then(|item| item.get("reasoning_content"))
                            .and_then(Value::as_str)
                            .is_some_and(|text| !text.is_empty())
                    {
                        delta.insert(0, '\n');
                    }
                }
                self.record_delta(object, "reasoning_content", &delta);
                Ok(vec![self.chunk(json!({"reasoning_content": delta}), None)])
            }
            other => Err(format!("Responses SSE event type {other} is unsupported")),
        }
    }

    pub(crate) fn finish(&self) -> Result<(), String> {
        if !self.completed {
            return Err("Responses SSE ended without response.completed".to_string());
        }
        Ok(())
    }

    fn record_delta(&mut self, event: &Map<String, Value>, field: &str, delta: &str) {
        let index = event
            .get("output_index")
            .and_then(Value::as_u64)
            .unwrap_or(0) as usize;
        let item = self.emitted_items.entry(index).or_default();
        let text = item
            .entry(field)
            .or_insert_with(|| Value::String(String::new()));
        if let Value::String(text) = text {
            text.push_str(delta);
        }
    }

    // Full items and terminal output use the JSON projection owner. Keep each
    // output index separate so an earlier tool or text delta cannot hide another item.
    fn terminal_output_chunks(
        &mut self,
        response: Option<&Map<String, Value>>,
    ) -> Result<Vec<Value>, String> {
        let Some(response) = response else {
            return Ok(Vec::new());
        };
        if self.response_id.is_none() {
            self.response_id = response
                .get("id")
                .and_then(Value::as_str)
                .map(str::to_owned);
        }
        if self.model.is_none() {
            self.model = response
                .get("model")
                .and_then(Value::as_str)
                .map(str::to_owned);
        }
        let Some(output) = response.get("output").and_then(Value::as_array) else {
            return Ok(Vec::new());
        };
        let mut chunks = Vec::new();
        for (index, item) in output.iter().enumerate() {
            chunks.extend(self.output_item_chunks(index, item)?);
        }
        Ok(chunks)
    }

    fn output_item_chunks(&mut self, index: usize, item: &Value) -> Result<Vec<Value>, String> {
        let projected = project_v3_openai_chat_client_response_from_canonical(
            &json!({"status":"completed", "output":[item]}),
        )?;
        let mut message = projected["choices"][0]["message"].clone();
        let emitted = self.emitted_items.entry(index).or_default();
        for field in ["content", "refusal", "reasoning_content"] {
            if let Some(full) = message[field].as_str() {
                let prior = emitted
                    .get(field)
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                let remaining = full.strip_prefix(prior).unwrap_or(full).to_owned();
                emitted.insert(field.to_owned(), Value::String(full.to_owned()));
                message.as_object_mut().unwrap().remove(field);
                if !remaining.is_empty() {
                    message[field] = Value::String(remaining);
                }
            } else {
                message.as_object_mut().unwrap().remove(field);
            }
        }
        if emitted.contains_key("tool_calls") {
            message.as_object_mut().unwrap().remove("tool_calls");
        }
        if let Some(calls) = message.get_mut("tool_calls").and_then(Value::as_array_mut) {
            for call in calls {
                call["index"] = Value::from(self.tool_call_index);
                self.tool_call_index += 1;
                self.emitted_tool_call = true;
            }
            emitted.insert("tool_calls".to_owned(), Value::Bool(true));
        }
        if ["content", "refusal", "reasoning_content", "tool_calls"]
            .into_iter()
            .any(|field| message.get(field).is_some())
        {
            Ok(vec![self.chunk(message, None)])
        } else {
            Ok(Vec::new())
        }
    }

    fn chunk(&self, delta: Value, finish_reason: Option<&str>) -> Value {
        let mut chunk = Map::new();
        chunk.insert(
            "id".to_string(),
            self.response_id
                .clone()
                .map(Value::String)
                .unwrap_or(Value::Null),
        );
        chunk.insert(
            "object".to_string(),
            Value::String("chat.completion.chunk".to_string()),
        );
        if let Some(model) = &self.model {
            chunk.insert("model".to_string(), Value::String(model.clone()));
        }
        let finish = finish_reason
            .map(|reason| Value::String(reason.to_string()))
            .unwrap_or(Value::Null);
        chunk.insert(
            "choices".to_string(),
            json!([{"index": 0, "delta": delta, "finish_reason": finish}]),
        );
        Value::Object(chunk)
    }

    fn usage_chunk(&self, usage: &Value) -> Option<Value> {
        if !self.include_usage {
            return None;
        }
        let normalized = project_v3_chat_usage_from_canonical(usage)?;
        let mut chunk = self.chunk(json!({}), None);
        let object = chunk.as_object_mut()?;
        object.insert("choices".to_string(), Value::Array(Vec::new()));
        object.insert("usage".to_string(), normalized);
        Some(chunk)
    }
}

#[cfg(test)]
#[path = "openai_chat_codec_tests.rs"]
mod openai_chat_codec_tests;
