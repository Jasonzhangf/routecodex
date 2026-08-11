use super::{V3HubEntryProtocol, V3HubProviderWireProtocol, V3HubTransportIntent};
use crate::protocol_tables::{map_value as table_map_value, V3TableDirection, V3TableKind};
use serde_json::{json, Map, Value};

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
                    if part.get("type").and_then(Value::as_str) == Some("output_text") {
                        if let Some(text) = part.get("text").and_then(Value::as_str) {
                            content.push_str(text);
                        }
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
                    .get("call_id")
                    .and_then(Value::as_str)
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
    let status = object
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or("completed");
    let finish_reason = if !tool_calls.is_empty() || status == "requires_action" {
        "tool_calls"
    } else {
        // responses finish_reason -> hub -> openai_chat（查表；未命中默认 "stop"，与原手写 match 兜底一致）
        match object.get("finish_reason").and_then(Value::as_str) {
            Some(value) => table_map_value(
                V3TableKind::FinishReason,
                "responses",
                value,
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
            .unwrap_or("stop"),
            None => "stop",
        }
    };
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
    if let Some(usage) = object.get("usage").and_then(Value::as_object) {
        let input_tokens = usage
            .get("input_tokens")
            .and_then(Value::as_u64)
            .unwrap_or(0);
        let output_tokens = usage
            .get("output_tokens")
            .and_then(Value::as_u64)
            .unwrap_or(0);
        response.insert(
            "usage".to_string(),
            serde_json::json!({
                "prompt_tokens": input_tokens,
                "completion_tokens": output_tokens,
                "total_tokens": input_tokens + output_tokens
            }),
        );
    }
    Ok(Value::Object(response))
}

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
        self.input_tokens = message
            .get("usage")
            .and_then(Value::as_object)
            .and_then(|usage| usage.get("input_tokens"))
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
        let kind = self
            .active_blocks
            .get(&index)
            .ok_or_else(|| format!("Anthropic content block {index} has no start"))?;
        let delta = object
            .get("delta")
            .and_then(Value::as_object)
            .ok_or_else(|| "Anthropic content_block_delta is missing delta".to_string())?;
        match (kind.as_str(), delta.get("type").and_then(Value::as_str)) {
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
        if self.input_tokens.is_some() || self.output_tokens.is_some() {
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
            if self.input_tokens.is_some() || self.output_tokens.is_some() {
                let prompt_tokens = self.input_tokens.unwrap_or(0);
                let completion_tokens = self.output_tokens.unwrap_or(0);
                chunk.insert(
                    "usage".to_string(),
                    json!({
                        "prompt_tokens": prompt_tokens,
                        "completion_tokens": completion_tokens,
                        "total_tokens": prompt_tokens + completion_tokens
                    }),
                );
            }
        }
        Value::Object(chunk)
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
    emitted_content: bool,
    response_id: Option<String>,
    model: Option<String>,
    tool_call_index: usize,
}

impl Default for V3OpenAiChatResponsesSseTransducer {
    fn default() -> Self {
        Self {
            response_started: false,
            completed: false,
            emitted_content: false,
            response_id: None,
            model: None,
            tool_call_index: 0,
        }
    }
}

impl V3OpenAiChatResponsesSseTransducer {
    pub(crate) fn new() -> Self {
        Self::default()
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
            "response.created" | "response.in_progress" => {
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
            "response.output_text.delta" => {
                let delta = object
                    .get("delta")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                if delta.is_empty() {
                    return Ok(Vec::new());
                }
                self.emitted_content = true;
                Ok(vec![self.chunk(json!({"content": delta}), None)])
            }
            "response.output_item.done" => {
                let Some(item) = object.get("item").and_then(Value::as_object) else {
                    return Ok(Vec::new());
                };
                if item.get("type").and_then(Value::as_str) != Some("function_call") {
                    return Ok(Vec::new());
                }
                let index = self.tool_call_index;
                self.tool_call_index += 1;
                self.emitted_content = true;
                let call_id = item
                    .get("call_id")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                let name = item.get("name").and_then(Value::as_str).unwrap_or_default();
                let arguments = item
                    .get("arguments")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                Ok(vec![self.chunk(
                    json!({"tool_calls": [{
                        "index": index,
                        "id": call_id,
                        "type": "function",
                        "function": {"name": name, "arguments": arguments}
                    }]}),
                    None,
                )])
            }
            "response.completed" => {
                self.completed = true;
                let response = object.get("response").and_then(Value::as_object);
                let status = response
                    .and_then(|response| response.get("status"))
                    .and_then(Value::as_str);
                let finish_reason = if status == Some("completed") {
                    Some("stop")
                } else {
                    None
                };
                Ok(vec![self.chunk(json!({}), finish_reason)])
            }
            // 已知无 Chat 投影的事件：容错跳过（reasoning 摘要等）。
            "response.output_item.added"
            | "response.reasoning_summary_text.delta"
            | "response.reasoning_text.delta" => Ok(Vec::new()),
            // 未知事件：容错跳过（provider 扩展事件不得破坏 client 流）。
            _ => Ok(Vec::new()),
        }
    }

    pub(crate) fn finish(&self) -> Result<(), String> {
        if !self.completed {
            return Err("Responses SSE ended without response.completed".to_string());
        }
        // 空响应识别：completed 但未产生任何 content / tool_calls 帧 —— provider
        // 返回了空文本（客户端会判定 "no visible final answer" 并重试）。归一化为
        // provider 失败进入错误链（记录 health → 连续失败达到阈值 → 拉黑 15 分钟
        // → 下次 route 排除/切 provider），而不是把空文本投影给客户端。
        if !self.emitted_content {
            return Err(
                "provider returned empty response (no content, no tool calls)".to_string(),
            );
        }
        Ok(())
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
}
