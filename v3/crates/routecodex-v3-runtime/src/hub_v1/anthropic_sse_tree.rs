use serde_json::{Map, Value};
use std::collections::BTreeMap;
use thiserror::Error;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct V3AnthropicSseTransportObject {
    event_name: Option<String>,
    data: Value,
}

impl V3AnthropicSseTransportObject {
    pub(crate) fn new(event_name: Option<String>, data: Value) -> Self {
        Self { event_name, data }
    }
    pub(crate) fn event_name(&self) -> Option<&str> {
        self.event_name.as_deref()
    }
    pub(crate) fn data(&self) -> &Value {
        &self.data
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct V3AnthropicSseProtocolMetadata {
    pub(crate) event_type: String,
    pub(crate) index: Option<usize>,
    pub(crate) message_id: Option<String>,
    pub(crate) sequence_number: Option<u64>,
}

impl V3AnthropicSseProtocolMetadata {
    pub(crate) fn from_event(event: &Value) -> Result<Self, V3AnthropicSseTreeError> {
        let object = event
            .as_object()
            .ok_or(V3AnthropicSseTreeError::EventNotObject)?;
        let event_type = object
            .get("type")
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .ok_or(V3AnthropicSseTreeError::MissingEventType)?
            .to_owned();
        Ok(Self {
            event_type,
            index: object
                .get("index")
                .and_then(Value::as_u64)
                .map(|value| value as usize),
            message_id: object
                .get("message_id")
                .and_then(Value::as_str)
                .map(str::to_owned)
                .or_else(|| {
                    object
                        .get("message")
                        .and_then(|message| message.get("id"))
                        .and_then(Value::as_str)
                        .map(str::to_owned)
                }),
            sequence_number: object.get("sequence_number").and_then(Value::as_u64),
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct V3AnthropicSseExtension {
    pub(crate) name: String,
    pub(crate) value: Value,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct V3AnthropicSseUsage {
    pub(crate) input_tokens: Option<u64>,
    pub(crate) output_tokens: Option<u64>,
    pub(crate) cache_read_input_tokens: Option<u64>,
    pub(crate) cache_creation_input_tokens: Option<u64>,
    pub(crate) extensions: Vec<V3AnthropicSseExtension>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct V3AnthropicSseMessage {
    pub(crate) id: Option<String>,
    pub(crate) model: Option<String>,
    pub(crate) role: Option<String>,
    pub(crate) stop_reason: Option<String>,
    pub(crate) stop_sequence: Option<String>,
    pub(crate) usage: Option<V3AnthropicSseUsage>,
    pub(crate) extensions: Vec<V3AnthropicSseExtension>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum V3AnthropicSseBlockKind {
    Text,
    ToolUse,
    Thinking,
    RedactedThinking,
    ServerToolUse,
    WebSearchToolResult,
    Extension(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum V3AnthropicSseDelta {
    Text(String),
    InputJsonFragment(String),
    Thinking(String),
    Signature(String),
    Extension {
        delta_type: String,
        fields: Vec<V3AnthropicSseExtension>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct V3AnthropicSseBlock {
    pub(crate) index: usize,
    pub(crate) kind: V3AnthropicSseBlockKind,
    pub(crate) id: Option<String>,
    pub(crate) name: Option<String>,
    pub(crate) text: String,
    pub(crate) input_json: String,
    pub(crate) input: Option<Value>,
    pub(crate) thinking: String,
    pub(crate) signature: Option<String>,
    pub(crate) redacted_data: Option<String>,
    pub(crate) stopped: bool,
    pub(crate) extensions: Vec<V3AnthropicSseExtension>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum V3AnthropicSseTerminalState {
    MessageStop,
    Error,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct V3AnthropicSseSemanticObject {
    pub(crate) protocol: V3AnthropicSseProtocolMetadata,
    pub(crate) message: Option<V3AnthropicSseMessage>,
    pub(crate) block: Option<V3AnthropicSseBlock>,
    pub(crate) delta: Option<V3AnthropicSseDelta>,
    pub(crate) usage: Option<V3AnthropicSseUsage>,
    pub(crate) terminal: Option<V3AnthropicSseTerminalState>,
    pub(crate) extensions: Vec<V3AnthropicSseExtension>,
}

pub(crate) struct V3AnthropicSseHookInput<'a> {
    pub(crate) transport: &'a V3AnthropicSseTransportObject,
    pub(crate) protocol: &'a V3AnthropicSseProtocolMetadata,
    pub(crate) semantic: &'a V3AnthropicSseSemanticObject,
}

pub(crate) trait V3AnthropicSseSemanticHook {
    fn notify(&mut self, input: &V3AnthropicSseHookInput<'_>);
    fn rewrite(
        &mut self,
        semantic: &mut V3AnthropicSseSemanticObject,
    ) -> Result<(), V3AnthropicSseTreeError>;
}

pub(crate) fn apply_v3_anthropic_sse_semantic_hook(
    semantic: &mut V3AnthropicSseSemanticObject,
    transport: &V3AnthropicSseTransportObject,
    protocol: &V3AnthropicSseProtocolMetadata,
    hook: &mut impl V3AnthropicSseSemanticHook,
) -> Result<(), V3AnthropicSseTreeError> {
    let input = V3AnthropicSseHookInput {
        transport,
        protocol,
        semantic,
    };
    hook.notify(&input);
    hook.rewrite(semantic)
}

#[derive(Debug, Default, Clone)]
pub(crate) struct V3AnthropicSseReducerState {
    pub(crate) message: Option<V3AnthropicSseMessage>,
    pub(crate) blocks: BTreeMap<usize, V3AnthropicSseBlock>,
    pub(crate) usage: Option<V3AnthropicSseUsage>,
    pub(crate) message_start_seen: bool,
    pub(crate) message_stop_seen: bool,
    pub(crate) terminal: Option<V3AnthropicSseTerminalState>,
    pub(crate) extensions: Vec<V3AnthropicSseExtension>,
}

impl V3AnthropicSseReducerState {
    pub(crate) fn apply_event(&mut self, event: &Value) -> Result<(), V3AnthropicSseTreeError> {
        let protocol = V3AnthropicSseProtocolMetadata::from_event(event)?;
        if self.message_stop_seen && protocol.event_type != "ping" {
            return Err(V3AnthropicSseTreeError::EventAfterMessageStop);
        }
        match protocol.event_type.as_str() {
            "ping" => Ok(()),
            "error" => {
                self.terminal = Some(V3AnthropicSseTerminalState::Error);
                Err(V3AnthropicSseTreeError::ProviderError(
                    event
                        .pointer("/error/message")
                        .and_then(Value::as_str)
                        .unwrap_or("Anthropic stream error")
                        .to_owned(),
                ))
            }
            "message_start" => self.apply_message_start(event),
            "content_block_start" => self.apply_block_start(&protocol, event),
            "content_block_delta" => self.apply_block_delta(&protocol, event),
            "content_block_stop" => self.apply_block_stop(&protocol),
            "message_delta" => self.apply_message_delta(event),
            "message_stop" => {
                if !self.message_start_seen {
                    return Err(V3AnthropicSseTreeError::MessageStartRequired);
                }
                for block in self.blocks.values_mut() {
                    if matches!(
                        block.kind,
                        V3AnthropicSseBlockKind::Text
                            | V3AnthropicSseBlockKind::Thinking
                            | V3AnthropicSseBlockKind::RedactedThinking
                    ) {
                        block.stopped = true;
                    }
                }
                self.message_stop_seen = true;
                self.terminal = Some(V3AnthropicSseTerminalState::MessageStop);
                Ok(())
            }
            _ => {
                self.extensions.extend(object_extensions(
                    event,
                    &["type", "index", "message_id", "sequence_number"],
                ));
                Ok(())
            }
        }
    }

    fn apply_message_start(&mut self, event: &Value) -> Result<(), V3AnthropicSseTreeError> {
        let message = event
            .get("message")
            .ok_or(V3AnthropicSseTreeError::MessageRequired)?;
        let parsed = parse_message(message)?;
        if let Some(existing) = self.message.as_mut() {
            if !self.blocks.is_empty() {
                return Err(V3AnthropicSseTreeError::DuplicateMessageAfterBlock);
            }
            if existing.id != parsed.id
                || existing.role != parsed.role
                || existing.model != parsed.model
            {
                return Err(V3AnthropicSseTreeError::DuplicateMessageMismatch);
            }
            if parsed.model.is_some() {
                existing.model = parsed.model;
            }
            if parsed.usage.is_some() {
                existing.usage = merge_usage(existing.usage.take(), parsed.usage);
            }
            existing.extensions.extend(parsed.extensions);
        } else {
            self.message = Some(parsed);
        }
        self.message_start_seen = true;
        Ok(())
    }

    fn apply_block_start(
        &mut self,
        protocol: &V3AnthropicSseProtocolMetadata,
        event: &Value,
    ) -> Result<(), V3AnthropicSseTreeError> {
        self.require_started()?;
        let index = protocol
            .index
            .ok_or(V3AnthropicSseTreeError::IndexRequired)?;
        if self.blocks.contains_key(&index) {
            return Err(V3AnthropicSseTreeError::DuplicateBlock(index));
        }
        let block = event
            .get("content_block")
            .ok_or(V3AnthropicSseTreeError::ContentBlockRequired)?;
        self.blocks.insert(index, parse_block(index, block)?);
        Ok(())
    }

    fn apply_block_delta(
        &mut self,
        protocol: &V3AnthropicSseProtocolMetadata,
        event: &Value,
    ) -> Result<(), V3AnthropicSseTreeError> {
        self.require_started()?;
        let index = protocol
            .index
            .ok_or(V3AnthropicSseTreeError::IndexRequired)?;
        // Some Anthropic-compatible gateways emit a reasoning signature before
        // the corresponding content_block_start. It carries no standalone
        // business content; consume it without inventing a block, then keep
        // strict ordering for every delta that carries content.
        if !self.blocks.contains_key(&index)
            && event
                .pointer("/delta/type")
                .and_then(Value::as_str)
                == Some("signature_delta")
        {
            return Ok(());
        }
        let block = self
            .blocks
            .get_mut(&index)
            .ok_or(V3AnthropicSseTreeError::BlockNotStarted(index))?;
        if block.stopped {
            return Err(V3AnthropicSseTreeError::BlockAlreadyStopped(index));
        }
        let delta = event
            .get("delta")
            .ok_or(V3AnthropicSseTreeError::DeltaRequired)?;
        apply_delta(block, delta)
    }

    fn apply_block_stop(
        &mut self,
        protocol: &V3AnthropicSseProtocolMetadata,
    ) -> Result<(), V3AnthropicSseTreeError> {
        self.require_started()?;
        let index = protocol
            .index
            .ok_or(V3AnthropicSseTreeError::IndexRequired)?;
        let block = self
            .blocks
            .get_mut(&index)
            .ok_or(V3AnthropicSseTreeError::BlockNotStarted(index))?;
        block.stopped = true;
        Ok(())
    }

    fn apply_message_delta(&mut self, event: &Value) -> Result<(), V3AnthropicSseTreeError> {
        self.require_started()?;
        if let Some(delta) = event.get("delta") {
            if let Some(message) = &mut self.message {
                message.stop_reason = delta
                    .get("stop_reason")
                    .and_then(Value::as_str)
                    .map(str::to_owned)
                    .or_else(|| message.stop_reason.take());
                message.stop_sequence = delta
                    .get("stop_sequence")
                    .and_then(Value::as_str)
                    .map(str::to_owned)
                    .or_else(|| message.stop_sequence.take());
            }
        }
        if let Some(usage) = event.get("usage") {
            let incoming = parse_usage(usage)?;
            let baseline = self.usage.take().or_else(|| {
                self.message
                    .as_ref()
                    .and_then(|message| message.usage.clone())
            });
            self.usage = merge_usage(baseline, Some(incoming));
        }
        Ok(())
    }

    fn require_started(&self) -> Result<(), V3AnthropicSseTreeError> {
        self.message_start_seen
            .then_some(())
            .ok_or(V3AnthropicSseTreeError::MessageStartRequired)
    }

    pub(crate) fn to_message_value(&self) -> Result<Value, V3AnthropicSseTreeError> {
        let message = self
            .message
            .as_ref()
            .ok_or(V3AnthropicSseTreeError::MessageStartRequired)?;
        let mut value = Map::new();
        if let Some(id) = &message.id {
            value.insert("id".to_owned(), Value::String(id.clone()));
        }
        value.insert("type".to_owned(), Value::String("message".to_owned()));
        if let Some(role) = &message.role {
            value.insert("role".to_owned(), Value::String(role.clone()));
        }
        if let Some(model) = &message.model {
            value.insert("model".to_owned(), Value::String(model.clone()));
        }
        if let Some(reason) = &message.stop_reason {
            value.insert("stop_reason".to_owned(), Value::String(reason.clone()));
        }
        if let Some(sequence) = &message.stop_sequence {
            value.insert("stop_sequence".to_owned(), Value::String(sequence.clone()));
        }
        let mut content = Vec::new();
        for block in self.blocks.values() {
            if !block.stopped {
                return Err(V3AnthropicSseTreeError::BlockNotStopped(block.index));
            }
            let mut item = Map::new();
            match &block.kind {
                V3AnthropicSseBlockKind::Text => {
                    item.insert("type".to_owned(), Value::String("text".to_owned()));
                    item.insert("text".to_owned(), Value::String(block.text.clone()));
                }
                V3AnthropicSseBlockKind::Thinking => {
                    item.insert("type".to_owned(), Value::String("thinking".to_owned()));
                    item.insert("thinking".to_owned(), Value::String(block.thinking.clone()));
                    if let Some(signature) = &block.signature {
                        item.insert("signature".to_owned(), Value::String(signature.clone()));
                    }
                }
                V3AnthropicSseBlockKind::RedactedThinking => {
                    item.insert(
                        "type".to_owned(),
                        Value::String("redacted_thinking".to_owned()),
                    );
                    item.insert(
                        "data".to_owned(),
                        Value::String(block.redacted_data.clone().unwrap_or_default()),
                    );
                }
                V3AnthropicSseBlockKind::ToolUse => {
                    item.insert("type".to_owned(), Value::String("tool_use".to_owned()));
                    if let Some(id) = &block.id {
                        item.insert("id".to_owned(), Value::String(id.clone()));
                    }
                    if let Some(name) = &block.name {
                        item.insert("name".to_owned(), Value::String(name.clone()));
                    }
                    let input = if !block.input_json.is_empty() {
                        serde_json::from_str(&block.input_json)
                            .map_err(|_| V3AnthropicSseTreeError::MalformedToolInput)?
                    } else if let Some(input) = block.input.clone() {
                        input
                    } else {
                        Value::Object(Map::new())
                    };
                    item.insert("input".to_owned(), input);
                }
                V3AnthropicSseBlockKind::ServerToolUse
                | V3AnthropicSseBlockKind::WebSearchToolResult
                | V3AnthropicSseBlockKind::Extension(_) => {
                    item.insert(
                        "type".to_owned(),
                        Value::String(block_kind_name(&block.kind)),
                    );
                    item.insert("text".to_owned(), Value::String(block.text.clone()));
                }
            }
            for extension in &block.extensions {
                item.insert(extension.name.clone(), extension.value.clone());
            }
            content.push(Value::Object(item));
        }
        value.insert("content".to_owned(), Value::Array(content));
        if let Some(usage) = self.usage.clone().or_else(|| message.usage.clone()) {
            value.insert("usage".to_owned(), usage.to_value());
        }
        for extension in &message.extensions {
            value.insert(extension.name.clone(), extension.value.clone());
        }
        Ok(Value::Object(value))
    }
}

fn block_kind_name(kind: &V3AnthropicSseBlockKind) -> String {
    match kind {
        V3AnthropicSseBlockKind::Text => "text",
        V3AnthropicSseBlockKind::ToolUse => "tool_use",
        V3AnthropicSseBlockKind::Thinking => "thinking",
        V3AnthropicSseBlockKind::RedactedThinking => "redacted_thinking",
        V3AnthropicSseBlockKind::ServerToolUse => "server_tool_use",
        V3AnthropicSseBlockKind::WebSearchToolResult => "web_search_tool_result",
        V3AnthropicSseBlockKind::Extension(value) => value,
    }
    .to_owned()
}

impl V3AnthropicSseUsage {
    fn to_value(&self) -> Value {
        let mut value = Map::new();
        if let Some(tokens) = self.input_tokens {
            value.insert("input_tokens".to_owned(), Value::from(tokens));
        }
        if let Some(tokens) = self.output_tokens {
            value.insert("output_tokens".to_owned(), Value::from(tokens));
        }
        if let Some(tokens) = self.cache_read_input_tokens {
            value.insert("cache_read_input_tokens".to_owned(), Value::from(tokens));
        }
        if let Some(tokens) = self.cache_creation_input_tokens {
            value.insert(
                "cache_creation_input_tokens".to_owned(),
                Value::from(tokens),
            );
        }
        for extension in &self.extensions {
            value.insert(extension.name.clone(), extension.value.clone());
        }
        Value::Object(value)
    }
}

fn merge_usage(
    previous: Option<V3AnthropicSseUsage>,
    incoming: Option<V3AnthropicSseUsage>,
) -> Option<V3AnthropicSseUsage> {
    match (previous, incoming) {
        (None, None) => None,
        (Some(previous), None) => Some(previous),
        (None, Some(incoming)) => Some(incoming),
        (Some(mut previous), Some(incoming)) => {
            previous.input_tokens = incoming.input_tokens.or(previous.input_tokens);
            previous.output_tokens = incoming.output_tokens.or(previous.output_tokens);
            previous.cache_read_input_tokens = incoming
                .cache_read_input_tokens
                .or(previous.cache_read_input_tokens);
            previous.cache_creation_input_tokens = incoming
                .cache_creation_input_tokens
                .or(previous.cache_creation_input_tokens);
            previous.extensions.extend(incoming.extensions);
            Some(previous)
        }
    }
}

fn parse_message(value: &Value) -> Result<V3AnthropicSseMessage, V3AnthropicSseTreeError> {
    let object = value
        .as_object()
        .ok_or(V3AnthropicSseTreeError::MessageNotObject)?;
    Ok(V3AnthropicSseMessage {
        id: string(object, "id"),
        model: string(object, "model"),
        role: string(object, "role"),
        stop_reason: string(object, "stop_reason"),
        stop_sequence: string(object, "stop_sequence"),
        usage: object.get("usage").map(parse_usage).transpose()?,
        extensions: object_extensions(
            value,
            &[
                "id",
                "model",
                "type",
                "role",
                "content",
                "stop_reason",
                "stop_sequence",
                "usage",
            ],
        ),
    })
}

fn parse_usage(value: &Value) -> Result<V3AnthropicSseUsage, V3AnthropicSseTreeError> {
    let object = value
        .as_object()
        .ok_or(V3AnthropicSseTreeError::UsageNotObject)?;
    Ok(V3AnthropicSseUsage {
        input_tokens: u64_field(object, "input_tokens"),
        output_tokens: u64_field(object, "output_tokens"),
        cache_read_input_tokens: u64_field(object, "cache_read_input_tokens"),
        cache_creation_input_tokens: u64_field(object, "cache_creation_input_tokens"),
        extensions: object_extensions(
            value,
            &[
                "input_tokens",
                "output_tokens",
                "cache_read_input_tokens",
                "cache_creation_input_tokens",
            ],
        ),
    })
}

fn parse_block(
    index: usize,
    value: &Value,
) -> Result<V3AnthropicSseBlock, V3AnthropicSseTreeError> {
    let object = value
        .as_object()
        .ok_or(V3AnthropicSseTreeError::ContentBlockNotObject)?;
    let kind = match object
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or("extension")
    {
        "text" => V3AnthropicSseBlockKind::Text,
        "tool_use" => V3AnthropicSseBlockKind::ToolUse,
        "thinking" => {
            if object
                .keys()
                .any(|key| !["type", "thinking", "signature"].contains(&key.as_str()))
            {
                return Err(V3AnthropicSseTreeError::MalformedReasoningContent);
            }
            V3AnthropicSseBlockKind::Thinking
        }
        "redacted_thinking" => {
            if object
                .keys()
                .any(|key| !["type", "data"].contains(&key.as_str()))
            {
                return Err(V3AnthropicSseTreeError::MalformedReasoningContent);
            }
            V3AnthropicSseBlockKind::RedactedThinking
        }
        "server_tool_use" => V3AnthropicSseBlockKind::ServerToolUse,
        "web_search_tool_result" => V3AnthropicSseBlockKind::WebSearchToolResult,
        other => V3AnthropicSseBlockKind::Extension(other.to_owned()),
    };
    Ok(V3AnthropicSseBlock {
        index,
        kind,
        id: string(object, "id"),
        name: string(object, "name"),
        text: string(object, "text").unwrap_or_default(),
        input_json: String::new(),
        input: object.get("input").cloned(),
        thinking: string(object, "thinking").unwrap_or_default(),
        signature: string(object, "signature"),
        redacted_data: string(object, "data"),
        stopped: false,
        extensions: object_extensions(
            value,
            &[
                "type",
                "id",
                "name",
                "input",
                "text",
                "thinking",
                "signature",
            ],
        ),
    })
}

fn apply_delta(
    block: &mut V3AnthropicSseBlock,
    delta: &Value,
) -> Result<(), V3AnthropicSseTreeError> {
    let object = delta
        .as_object()
        .ok_or(V3AnthropicSseTreeError::DeltaNotObject)?;
    match object
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or_default()
    {
        "text_delta" => block.text.push_str(
            object
                .get("text")
                .and_then(Value::as_str)
                .ok_or(V3AnthropicSseTreeError::TextDeltaRequired)?,
        ),
        "input_json_delta" => block.input_json.push_str(
            object
                .get("partial_json")
                .and_then(Value::as_str)
                .ok_or(V3AnthropicSseTreeError::InputJsonFragmentRequired)?,
        ),
        "thinking_delta" => block.thinking.push_str(
            object
                .get("thinking")
                .and_then(Value::as_str)
                .ok_or(V3AnthropicSseTreeError::ThinkingDeltaRequired)?,
        ),
        "signature_delta" => {
            let signature = object
                .get("signature")
                .and_then(Value::as_str)
                .ok_or(V3AnthropicSseTreeError::MalformedReasoningContent)?;
            block.signature = Some(signature.to_owned());
        }
        delta_type => block.extensions.extend(object_extensions(delta, &["type"])),
    }
    Ok(())
}

fn string(object: &Map<String, Value>, field: &str) -> Option<String> {
    object.get(field).and_then(Value::as_str).map(str::to_owned)
}
fn u64_field(object: &Map<String, Value>, field: &str) -> Option<u64> {
    object.get(field).and_then(Value::as_u64)
}
fn object_extensions(value: &Value, known: &[&str]) -> Vec<V3AnthropicSseExtension> {
    value
        .as_object()
        .into_iter()
        .flat_map(|object| object.iter())
        .filter(|(key, _)| !known.contains(&key.as_str()))
        .map(|(name, value)| V3AnthropicSseExtension {
            name: name.clone(),
            value: value.clone(),
        })
        .collect()
}

#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub(crate) enum V3AnthropicSseTreeError {
    #[error("Anthropic SSE event must be an object")]
    EventNotObject,
    #[error("Anthropic SSE event type is missing")]
    MissingEventType,
    #[error("Anthropic message_start requires a message object")]
    MessageRequired,
    #[error("Anthropic message must be an object")]
    MessageNotObject,
    #[error("Anthropic usage must be an object")]
    UsageNotObject,
    #[error("Anthropic content block must be an object")]
    ContentBlockNotObject,
    #[error("Anthropic delta must be an object")]
    DeltaNotObject,
    #[error("Anthropic stream requires message_start before content/message delta")]
    MessageStartRequired,
    #[error("Anthropic content block index is required")]
    IndexRequired,
    #[error("Anthropic content block {0} was not started")]
    BlockNotStarted(usize),
    #[error("Anthropic content block {0} was already stopped")]
    BlockAlreadyStopped(usize),
    #[error("Anthropic content block {0} ended without content_block_stop")]
    BlockNotStopped(usize),
    #[error("Anthropic content block {0} was started more than once")]
    DuplicateBlock(usize),
    #[error("Anthropic message_start repeated with different identity")]
    DuplicateMessageMismatch,
    #[error(
        "Anthropic provider event stream emitted duplicate message_start after content_block_start"
    )]
    DuplicateMessageAfterBlock,
    #[error("Anthropic codec malformed reasoning content")]
    MalformedReasoningContent,
    #[error("Anthropic tool input JSON is malformed")]
    MalformedToolInput,
    #[error("Anthropic stream emitted an event after message_stop")]
    EventAfterMessageStop,
    #[error("Anthropic content_block_start requires content_block")]
    ContentBlockRequired,
    #[error("Anthropic content_block_delta requires delta")]
    DeltaRequired,
    #[error("Anthropic text_delta requires text")]
    TextDeltaRequired,
    #[error("Anthropic input_json_delta requires partial_json fragment")]
    InputJsonFragmentRequired,
    #[error("Anthropic thinking_delta requires thinking")]
    ThinkingDeltaRequired,
    #[error("Anthropic provider error: {0}")]
    ProviderError(String),
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn indexed_blocks_accumulate_and_usage_replaces() {
        let mut state = V3AnthropicSseReducerState::default();
        for event in [
            json!({"type":"message_start","message":{"id":"m1","type":"message","role":"assistant","model":"claude","content":[],"usage":{"input_tokens":3}}}),
            json!({"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"t1","name":"exec","input":{}}}),
            json!({"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\"x\":"}}),
            json!({"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"1}"}}),
            json!({"type":"content_block_stop","index":1}),
            json!({"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":1}}),
            json!({"type":"message_delta","delta":{},"usage":{"output_tokens":2}}),
        ] {
            state.apply_event(&event).unwrap();
        }
        assert_eq!(state.blocks[&1].input_json, "{\"x\":1}");
        assert_eq!(state.usage.as_ref().unwrap().output_tokens, Some(2));
    }

    #[test]
    fn signature_delta_before_block_start_is_ignored_as_compatibility_tail() {
        let mut state = V3AnthropicSseReducerState::default();
        state
            .apply_event(&json!({
                "type":"message_start",
                "message":{"id":"m1","role":"assistant","content":[]}
            }))
            .unwrap();
        state
            .apply_event(&json!({
                "type":"content_block_delta",
                "index":0,
                "delta":{"type":"signature_delta","signature":"sig"}
            }))
            .unwrap();
        assert!(state.blocks.is_empty());
    }
    #[test]
    fn lifecycle_and_error_are_explicit() {
        let mut state = V3AnthropicSseReducerState::default();
        assert!(state.apply_event(&json!({"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"x"}})).is_err());
        state.apply_event(&json!({"type":"message_start","message":{"id":"m","type":"message","role":"assistant","content":[]}})).unwrap();
        assert!(matches!(
            state.apply_event(&json!({"type":"error","error":{"message":"bad"}})),
            Err(V3AnthropicSseTreeError::ProviderError(_))
        ));
        assert_eq!(state.terminal, Some(V3AnthropicSseTerminalState::Error));
    }
}
