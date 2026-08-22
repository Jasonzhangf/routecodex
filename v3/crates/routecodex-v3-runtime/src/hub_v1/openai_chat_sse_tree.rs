use serde_json::Value;
use std::collections::BTreeMap;
use thiserror::Error;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct V3OpenAiChatSseTransportObject {
    event_name: Option<String>,
    data: Value,
}

impl V3OpenAiChatSseTransportObject {
    pub fn new(event_name: Option<String>, data: Value) -> Self {
        Self { event_name, data }
    }

    pub fn event_name(&self) -> Option<&str> {
        self.event_name.as_deref()
    }
    pub fn data(&self) -> &Value {
        &self.data
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct V3OpenAiChatSseProtocolMetadata {
    pub object: String,
    pub id: Option<String>,
    pub created: Option<u64>,
    pub model: Option<String>,
    pub system_fingerprint: Option<String>,
}

impl V3OpenAiChatSseProtocolMetadata {
    pub fn from_chunk(chunk: &Value) -> Result<Self, V3OpenAiChatSseTreeError> {
        let object = chunk
            .as_object()
            .ok_or(V3OpenAiChatSseTreeError::ChunkNotObject)?;
        let object_type = object
            .get("object")
            .and_then(Value::as_str)
            .filter(|value| *value == "chat.completion.chunk")
            .ok_or(V3OpenAiChatSseTreeError::WrongObjectType)?
            .to_owned();
        Ok(Self {
            object: object_type,
            id: string_field(object, "id"),
            created: object.get("created").and_then(Value::as_u64),
            model: string_field(object, "model"),
            system_fingerprint: string_field(object, "system_fingerprint"),
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct V3OpenAiChatSseHookInput<'a> {
    pub transport: &'a V3OpenAiChatSseTransportObject,
    pub protocol: &'a V3OpenAiChatSseProtocolMetadata,
    pub semantic: &'a V3OpenAiChatSseSemanticObject,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct V3OpenAiChatSseSemanticObject {
    pub choices: Vec<V3OpenAiChatSseChoice>,
    pub protocol: V3OpenAiChatSseProtocolMetadata,
    pub usage: Option<V3OpenAiChatSseUsage>,
    pub extensions: Vec<V3OpenAiChatSseExtension>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct V3OpenAiChatSseExtension {
    pub name: String,
    pub value: Value,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct V3OpenAiChatSseUsage {
    pub prompt_tokens: Option<u64>,
    pub completion_tokens: Option<u64>,
    pub total_tokens: Option<u64>,
    pub extensions: Vec<V3OpenAiChatSseExtension>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum V3OpenAiChatSseTerminalState {
    Stop,
    Length,
    ToolCalls,
    ContentFilter,
    FunctionCall,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct V3OpenAiChatSseReducerState {
    pub id: Option<String>,
    pub model: Option<String>,
    pub created: Option<u64>,
    pub system_fingerprint: Option<String>,
    pub choices: Vec<V3OpenAiChatSseChoice>,
    pub usage: Option<V3OpenAiChatSseUsage>,
    pub terminal: Option<V3OpenAiChatSseTerminalState>,
    pub extensions: Vec<V3OpenAiChatSseExtension>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct V3OpenAiChatSseMaterializedToolCall {
    pub call_id: Option<String>,
    pub kind: Option<String>,
    pub function_name: Option<String>,
    pub function_arguments: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct V3OpenAiChatSseMaterializedChoice {
    pub role: Option<String>,
    pub content: String,
    pub reasoning_content: String,
    pub refusal: String,
    pub finish_reason: Option<String>,
    pub tool_calls: BTreeMap<usize, V3OpenAiChatSseMaterializedToolCall>,
}

impl V3OpenAiChatSseMaterializedChoice {
    fn apply_delta(
        &mut self,
        choice: &V3OpenAiChatSseChoice,
    ) -> Result<(), V3OpenAiChatSseTreeError> {
        if let Some(finish_reason) = &choice.finish_reason {
            self.finish_reason = Some(finish_reason.clone());
        }
        match &choice.delta {
            V3OpenAiChatSseDelta::Empty => {}
            V3OpenAiChatSseDelta::Role(role) => self.role = Some(role.clone()),
            V3OpenAiChatSseDelta::Text(text) => self.content.push_str(text),
            V3OpenAiChatSseDelta::Reasoning(text) => self.reasoning_content.push_str(text),
            V3OpenAiChatSseDelta::Refusal(text) => self.refusal.push_str(text),
            V3OpenAiChatSseDelta::ToolCall(call) => {
                let tool_call = self.tool_calls.entry(call.position).or_default();
                if call.call_id.is_some() {
                    tool_call.call_id = call.call_id.clone();
                }
                if call.name.is_some() {
                    tool_call.function_name = call.name.clone();
                }
                if let Some(arguments) = &call.arguments {
                    tool_call.function_arguments.push_str(arguments);
                }
                if tool_call.kind.is_none() {
                    tool_call.kind = Some("function".to_owned());
                }
            }
        }
        Ok(())
    }

    fn to_message_value(&self, index: usize) -> Result<Value, V3OpenAiChatSseTreeError> {
        let mut message = serde_json::Map::new();
        message.insert(
            "role".to_owned(),
            Value::String(self.role.clone().unwrap_or_else(|| "assistant".to_owned())),
        );
        message.insert("content".to_owned(), Value::String(self.content.clone()));
        if !self.reasoning_content.is_empty() {
            message.insert(
                "reasoning_content".to_owned(),
                Value::String(self.reasoning_content.clone()),
            );
        }
        if !self.refusal.is_empty() {
            message.insert("refusal".to_owned(), Value::String(self.refusal.clone()));
        }
        if !self.tool_calls.is_empty() {
            let mut calls = Vec::new();
            for (position, call) in &self.tool_calls {
                let id = call.call_id.clone().ok_or_else(|| {
                    V3OpenAiChatSseTreeError::Projection(format!(
                        "Chat tool call[{position}] at choice[{index}] is missing id"
                    ))
                })?;
                let name = call.function_name.clone().ok_or_else(|| {
                    V3OpenAiChatSseTreeError::Projection(format!(
                        "Chat tool call[{position}] at choice[{index}] is missing function name"
                    ))
                })?;
                calls.push(serde_json::json!({
                    "id": id,
                    "type": call.kind.clone().unwrap_or_else(|| "function".to_owned()),
                    "function": {"name": name, "arguments": call.function_arguments}
                }));
            }
            message.insert("tool_calls".to_owned(), Value::Array(calls));
        }
        Ok(serde_json::json!({
            "index": index,
            "message": Value::Object(message),
            "finish_reason": self.finish_reason.clone().map(Value::String).unwrap_or(Value::Null)
        }))
    }
}

impl Default for V3OpenAiChatSseReducerState {
    fn default() -> Self {
        Self {
            id: None,
            model: None,
            created: None,
            system_fingerprint: None,
            choices: Vec::new(),
            usage: None,
            terminal: None,
            extensions: Vec::new(),
        }
    }
}

impl V3OpenAiChatSseReducerState {
    pub fn has_tool_calls(&self) -> bool {
        self.choices
            .iter()
            .any(|choice| matches!(choice.delta, V3OpenAiChatSseDelta::ToolCall(_)))
    }

    pub fn apply_chunk(&mut self, chunk: &Value) -> Result<(), V3OpenAiChatSseTreeError> {
        let metadata = V3OpenAiChatSseProtocolMetadata::from_chunk(chunk)?;
        self.id = metadata.id.or(self.id.take());
        self.model = metadata.model.or(self.model.take());
        self.created = metadata.created.or(self.created);
        self.system_fingerprint = metadata
            .system_fingerprint
            .or(self.system_fingerprint.take());
        let semantic = classify_v3_openai_chat_sse_chunk(chunk)?;
        for choice in semantic.choices {
            if let Some(reason) = choice.finish_reason.as_deref() {
                self.terminal = Some(parse_terminal_state(reason)?);
            }
            self.choices.push(choice);
        }
        if let Some(usage) = chunk.get("usage").filter(|value| !value.is_null()) {
            self.usage = Some(parse_chat_usage(usage)?);
        }
        Ok(())
    }

    pub fn materialize_completion(&self) -> Result<Value, V3OpenAiChatSseTreeError> {
        let mut choices: BTreeMap<usize, V3OpenAiChatSseMaterializedChoice> = BTreeMap::new();
        for choice in &self.choices {
            choices
                .entry(choice.index)
                .or_default()
                .apply_delta(choice)?;
        }
        if choices.is_empty() {
            return Err(V3OpenAiChatSseTreeError::Projection(
                "Chat stream response did not contain choices".to_owned(),
            ));
        }
        let mut response = serde_json::Map::new();
        response.insert(
            "id".to_owned(),
            Value::String(
                self.id
                    .clone()
                    .unwrap_or_else(|| "chatcmpl_openai_chat_stream".to_owned()),
            ),
        );
        response.insert(
            "object".to_owned(),
            Value::String("chat.completion".to_owned()),
        );
        response.insert(
            "choices".to_owned(),
            Value::Array(
                choices
                    .iter()
                    .map(|(index, choice)| choice.to_message_value(*index))
                    .collect::<Result<Vec<_>, _>>()?,
            ),
        );
        if let Some(model) = &self.model {
            response.insert("model".to_owned(), Value::String(model.clone()));
        }
        if let Some(created) = self.created {
            response.insert("created".to_owned(), Value::from(created));
        }
        if let Some(usage) = &self.usage {
            let mut usage_value = serde_json::Map::new();
            if let Some(tokens) = usage.prompt_tokens {
                usage_value.insert("prompt_tokens".to_owned(), Value::from(tokens));
            }
            if let Some(tokens) = usage.completion_tokens {
                usage_value.insert("completion_tokens".to_owned(), Value::from(tokens));
            }
            if let Some(tokens) = usage.total_tokens {
                usage_value.insert("total_tokens".to_owned(), Value::from(tokens));
            }
            for extension in &usage.extensions {
                usage_value.insert(extension.name.clone(), extension.value.clone());
            }
            response.insert("usage".to_owned(), Value::Object(usage_value));
        }
        Ok(Value::Object(response))
    }
}

pub trait V3OpenAiChatSseSemanticHook {
    fn notify(&mut self, input: &V3OpenAiChatSseHookInput<'_>);

    fn rewrite(
        &mut self,
        semantic: &mut V3OpenAiChatSseSemanticObject,
    ) -> Result<(), V3OpenAiChatSseTreeError>;
}

pub fn apply_v3_openai_chat_sse_semantic_hook(
    semantic: &mut V3OpenAiChatSseSemanticObject,
    transport: &V3OpenAiChatSseTransportObject,
    protocol: &V3OpenAiChatSseProtocolMetadata,
    hook: &mut impl V3OpenAiChatSseSemanticHook,
) -> Result<(), V3OpenAiChatSseTreeError> {
    let input = V3OpenAiChatSseHookInput {
        transport,
        protocol,
        semantic,
    };
    hook.notify(&input);
    hook.rewrite(semantic)
}

impl V3OpenAiChatSseSemanticObject {
    pub fn to_normalized_value(&self) -> Value {
        let mut value = serde_json::Map::new();
        value.insert(
            "object".to_owned(),
            Value::String(self.protocol.object.clone()),
        );
        if let Some(id) = &self.protocol.id {
            value.insert("id".to_owned(), Value::String(id.clone()));
        }
        if let Some(created) = self.protocol.created {
            value.insert("created".to_owned(), Value::from(created));
        }
        if let Some(model) = &self.protocol.model {
            value.insert("model".to_owned(), Value::String(model.clone()));
        }
        if let Some(fingerprint) = &self.protocol.system_fingerprint {
            value.insert(
                "system_fingerprint".to_owned(),
                Value::String(fingerprint.clone()),
            );
        }
        value.insert(
            "choices".to_owned(),
            Value::Array(
                self.choices
                    .iter()
                    .map(V3OpenAiChatSseChoice::to_normalized_value)
                    .collect(),
            ),
        );
        if let Some(usage) = &self.usage {
            let mut usage_value = serde_json::Map::new();
            if let Some(tokens) = usage.prompt_tokens {
                usage_value.insert("prompt_tokens".to_owned(), Value::from(tokens));
            }
            if let Some(tokens) = usage.completion_tokens {
                usage_value.insert("completion_tokens".to_owned(), Value::from(tokens));
            }
            if let Some(tokens) = usage.total_tokens {
                usage_value.insert("total_tokens".to_owned(), Value::from(tokens));
            }
            for extension in &usage.extensions {
                usage_value.insert(extension.name.clone(), extension.value.clone());
            }
            value.insert("usage".to_owned(), Value::Object(usage_value));
        }
        for extension in &self.extensions {
            value.insert(extension.name.clone(), extension.value.clone());
        }
        Value::Object(value)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct V3OpenAiChatSseChoice {
    pub index: usize,
    pub delta: V3OpenAiChatSseDelta,
    pub finish_reason: Option<String>,
    pub extensions: Vec<V3OpenAiChatSseExtension>,
    pub delta_extensions: Vec<V3OpenAiChatSseExtension>,
}

impl V3OpenAiChatSseChoice {
    pub fn to_normalized_value(&self) -> Value {
        let mut delta = serde_json::Map::new();
        match &self.delta {
            V3OpenAiChatSseDelta::Text(text) => {
                delta.insert("content".to_owned(), Value::String(text.clone()));
            }
            V3OpenAiChatSseDelta::Reasoning(text) => {
                let field = if delta.contains_key("reasoning_content") {
                    "reasoning_content"
                } else {
                    "reasoning"
                };
                delta.insert(field.to_owned(), Value::String(text.clone()));
            }
            V3OpenAiChatSseDelta::Refusal(refusal) => {
                delta.insert("refusal".to_owned(), Value::String(refusal.clone()));
            }
            V3OpenAiChatSseDelta::ToolCall(call) => {
                let mut function = serde_json::Map::new();
                if let Some(name) = &call.name {
                    function.insert("name".to_owned(), Value::String(name.clone()));
                }
                if let Some(arguments) = &call.arguments {
                    function.insert("arguments".to_owned(), Value::String(arguments.clone()));
                }
                let mut tool_call = serde_json::Map::new();
                tool_call.insert("index".to_owned(), Value::from(call.position));
                if let Some(id) = &call.call_id {
                    tool_call.insert("id".to_owned(), Value::String(id.clone()));
                }
                tool_call.insert("function".to_owned(), Value::Object(function));
                delta.insert(
                    "tool_calls".to_owned(),
                    Value::Array(vec![Value::Object(tool_call)]),
                );
            }
            V3OpenAiChatSseDelta::Empty | V3OpenAiChatSseDelta::Role(_) => {}
        }
        if let V3OpenAiChatSseDelta::Role(role) = &self.delta {
            delta.insert("role".to_owned(), Value::String(role.clone()));
        }
        for extension in &self.delta_extensions {
            delta.insert(extension.name.clone(), extension.value.clone());
        }
        let mut value = serde_json::Map::new();
        value.insert("index".to_owned(), Value::from(self.index));
        value.insert("delta".to_owned(), Value::Object(delta));
        if let Some(finish_reason) = &self.finish_reason {
            value.insert(
                "finish_reason".to_owned(),
                Value::String(finish_reason.clone()),
            );
        } else {
            value.insert("finish_reason".to_owned(), Value::Null);
        }
        for extension in &self.extensions {
            value.insert(extension.name.clone(), extension.value.clone());
        }
        Value::Object(value)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum V3OpenAiChatSseDelta {
    Empty,
    Role(String),
    Text(String),
    Reasoning(String),
    Refusal(String),
    ToolCall(V3OpenAiChatSseToolCall),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct V3OpenAiChatSseToolCall {
    pub position: usize,
    pub call_id: Option<String>,
    pub name: Option<String>,
    pub arguments: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum V3OpenAiChatSseContentRewrite {
    Text(String),
    Reasoning(String),
    Refusal(String),
    FunctionArguments(String),
}

#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum V3OpenAiChatSseTreeError {
    #[error("OpenAI Chat SSE chunk must be a JSON object")]
    ChunkNotObject,
    #[error("OpenAI Chat SSE chunk object must be chat.completion.chunk")]
    WrongObjectType,
    #[error("OpenAI Chat SSE chunk choices must be an array")]
    ChoicesNotArray,
    #[error("OpenAI Chat SSE choice must be a JSON object")]
    ChoiceNotObject,
    #[error("OpenAI Chat SSE choice index is missing or invalid")]
    ChoiceIndexInvalid,
    #[error("OpenAI Chat SSE delta must be an object")]
    DeltaNotObject,
    #[error("OpenAI Chat SSE tool call must be an object")]
    ToolCallNotObject,
    #[error("OpenAI Chat SSE usage must be an object")]
    UsageNotObject,
    #[error("OpenAI Chat SSE finish reason is unsupported: {finish_reason}")]
    UnknownFinishReason { finish_reason: String },
    #[error("OpenAI Chat SSE content rewrite is incompatible with the delta")]
    IncompatibleContentRewrite,
    #[error("OpenAI Chat SSE projection failed: {0}")]
    Projection(String),
}

pub fn classify_v3_openai_chat_sse_chunk(
    chunk: &Value,
) -> Result<V3OpenAiChatSseSemanticObject, V3OpenAiChatSseTreeError> {
    let object = chunk
        .as_object()
        .ok_or(V3OpenAiChatSseTreeError::ChunkNotObject)?;
    let choices = object
        .get("choices")
        .and_then(Value::as_array)
        .ok_or(V3OpenAiChatSseTreeError::ChoicesNotArray)?;
    let protocol = V3OpenAiChatSseProtocolMetadata::from_chunk(chunk)?;
    let usage = object
        .get("usage")
        .filter(|value| !value.is_null())
        .map(parse_chat_usage)
        .transpose()?;
    let extensions = object_extensions(
        object,
        &[
            "object",
            "id",
            "created",
            "model",
            "system_fingerprint",
            "choices",
            "usage",
        ],
    );
    choices
        .iter()
        .map(classify_choice)
        .collect::<Result<Vec<_>, _>>()
        .map(|choices| V3OpenAiChatSseSemanticObject {
            choices,
            protocol,
            usage,
            extensions,
        })
}

pub fn rewrite_v3_openai_chat_sse_content(
    choice: &mut V3OpenAiChatSseChoice,
    rewrite: V3OpenAiChatSseContentRewrite,
) -> Result<(), V3OpenAiChatSseTreeError> {
    match (&mut choice.delta, rewrite) {
        (V3OpenAiChatSseDelta::Text(value), V3OpenAiChatSseContentRewrite::Text(rewritten))
        | (
            V3OpenAiChatSseDelta::Reasoning(value),
            V3OpenAiChatSseContentRewrite::Reasoning(rewritten),
        )
        | (
            V3OpenAiChatSseDelta::Refusal(value),
            V3OpenAiChatSseContentRewrite::Refusal(rewritten),
        )
        | (
            V3OpenAiChatSseDelta::ToolCall(V3OpenAiChatSseToolCall {
                arguments: Some(value),
                ..
            }),
            V3OpenAiChatSseContentRewrite::FunctionArguments(rewritten),
        ) => {
            *value = rewritten;
            Ok(())
        }
        _ => Err(V3OpenAiChatSseTreeError::IncompatibleContentRewrite),
    }
}

pub fn project_v3_openai_chat_sse_choice_json(choice: &V3OpenAiChatSseChoice) -> Value {
    choice.to_normalized_value()
}

pub fn project_v3_openai_chat_sse_choice_sse(
    event_name: Option<String>,
    choice: &V3OpenAiChatSseChoice,
) -> Result<Vec<u8>, V3OpenAiChatSseTreeError> {
    let data_json = serde_json::to_string(&project_v3_openai_chat_sse_choice_json(choice))
        .map_err(|error| V3OpenAiChatSseTreeError::Projection(error.to_string()))?;
    crate::sse_object_pipeline::SseObjectFrame::from_event_json(event_name, data_json)
        .and_then(|object| object.encode_sse())
        .map_err(|error| V3OpenAiChatSseTreeError::Projection(error.to_string()))
}

pub fn project_v3_openai_chat_sse_chunk_json(semantic: &V3OpenAiChatSseSemanticObject) -> Value {
    semantic.to_normalized_value()
}

pub fn project_v3_openai_chat_sse_chunk_sse(
    event_name: Option<String>,
    semantic: &V3OpenAiChatSseSemanticObject,
) -> Result<Vec<u8>, V3OpenAiChatSseTreeError> {
    let data_json = serde_json::to_string(&project_v3_openai_chat_sse_chunk_json(semantic))
        .map_err(|error| V3OpenAiChatSseTreeError::Projection(error.to_string()))?;
    crate::sse_object_pipeline::SseObjectFrame::from_event_json(event_name, data_json)
        .and_then(|object| object.encode_sse())
        .map_err(|error| V3OpenAiChatSseTreeError::Projection(error.to_string()))
}

fn classify_choice(choice: &Value) -> Result<V3OpenAiChatSseChoice, V3OpenAiChatSseTreeError> {
    let object = choice
        .as_object()
        .ok_or(V3OpenAiChatSseTreeError::ChoiceNotObject)?;
    let index = object
        .get("index")
        .and_then(Value::as_u64)
        .map(|value| value as usize)
        .ok_or(V3OpenAiChatSseTreeError::ChoiceIndexInvalid)?;
    let delta = object
        .get("delta")
        .ok_or(V3OpenAiChatSseTreeError::DeltaNotObject)?;
    let delta_object = delta
        .as_object()
        .ok_or(V3OpenAiChatSseTreeError::DeltaNotObject)?;
    let has_tool_calls = delta_object
        .get("tool_calls")
        .and_then(Value::as_array)
        .is_some_and(|calls| !calls.is_empty());
    // A tool-call delta may carry the Resp03 toolreason projection in the
    // same delta. Keep the reasoning field as an extension in that shape;
    // otherwise the tool-call semantic branch would consume the call and
    // silently drop the co-located reasoning projection.
    let delta_extensions = if has_tool_calls {
        object_extensions(delta_object, &["content", "refusal", "role", "tool_calls"])
    } else {
        object_extensions(
            delta_object,
            &[
                "content",
                "reasoning_content",
                "reasoning",
                "refusal",
                "role",
                "tool_calls",
            ],
        )
    };
    let semantic_delta = if has_tool_calls {
        let tool_calls = delta_object
            .get("tool_calls")
            .and_then(Value::as_array)
            .ok_or(V3OpenAiChatSseTreeError::ToolCallNotObject)?;
        let call = tool_calls
            .first()
            .ok_or(V3OpenAiChatSseTreeError::ToolCallNotObject)?;
        let call_object = call
            .as_object()
            .ok_or(V3OpenAiChatSseTreeError::ToolCallNotObject)?;
        let function = call_object.get("function").and_then(Value::as_object);
        V3OpenAiChatSseDelta::ToolCall(V3OpenAiChatSseToolCall {
            position: call_object
                .get("index")
                .and_then(Value::as_u64)
                .unwrap_or(0) as usize,
            call_id: string_field(call_object, "id"),
            name: function.and_then(|value| string_field(value, "name")),
            arguments: function.and_then(|value| string_field(value, "arguments")),
        })
    } else if let Some(value) = delta_object.get("content").and_then(Value::as_str) {
        V3OpenAiChatSseDelta::Text(value.to_owned())
    } else if let Some(value) = delta_object
        .get("reasoning_content")
        .or_else(|| delta_object.get("reasoning"))
        .and_then(Value::as_str)
    {
        V3OpenAiChatSseDelta::Reasoning(value.to_owned())
    } else if let Some(value) = delta_object.get("refusal").and_then(Value::as_str) {
        V3OpenAiChatSseDelta::Refusal(value.to_owned())
    } else if let Some(value) = delta_object.get("role").and_then(Value::as_str) {
        V3OpenAiChatSseDelta::Role(value.to_owned())
    } else {
        V3OpenAiChatSseDelta::Empty
    };
    let extensions = object_extensions(object, &["index", "delta", "finish_reason"]);
    Ok(V3OpenAiChatSseChoice {
        index,
        delta: semantic_delta,
        finish_reason: string_field(object, "finish_reason"),
        extensions,
        delta_extensions,
    })
}

fn object_extensions(
    object: &serde_json::Map<String, Value>,
    known: &[&str],
) -> Vec<V3OpenAiChatSseExtension> {
    object
        .iter()
        .filter(|(name, _)| !known.contains(&name.as_str()))
        .map(|(name, value)| V3OpenAiChatSseExtension {
            name: name.clone(),
            value: value.clone(),
        })
        .collect()
}

fn string_field(object: &serde_json::Map<String, Value>, field: &str) -> Option<String> {
    object
        .get(field)
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
}

fn parse_terminal_state(
    finish_reason: &str,
) -> Result<V3OpenAiChatSseTerminalState, V3OpenAiChatSseTreeError> {
    match finish_reason {
        "stop" => Ok(V3OpenAiChatSseTerminalState::Stop),
        "length" => Ok(V3OpenAiChatSseTerminalState::Length),
        "tool_calls" => Ok(V3OpenAiChatSseTerminalState::ToolCalls),
        "content_filter" => Ok(V3OpenAiChatSseTerminalState::ContentFilter),
        "function_call" => Ok(V3OpenAiChatSseTerminalState::FunctionCall),
        other => Err(V3OpenAiChatSseTreeError::UnknownFinishReason {
            finish_reason: other.to_owned(),
        }),
    }
}

fn parse_chat_usage(value: &Value) -> Result<V3OpenAiChatSseUsage, V3OpenAiChatSseTreeError> {
    let object = value
        .as_object()
        .ok_or(V3OpenAiChatSseTreeError::UsageNotObject)?;
    let known = ["prompt_tokens", "completion_tokens", "total_tokens"];
    let extensions = object
        .iter()
        .filter(|(name, _)| !known.contains(&name.as_str()))
        .map(|(name, value)| V3OpenAiChatSseExtension {
            name: name.clone(),
            value: value.clone(),
        })
        .collect();
    Ok(V3OpenAiChatSseUsage {
        prompt_tokens: object.get("prompt_tokens").and_then(Value::as_u64),
        completion_tokens: object.get("completion_tokens").and_then(Value::as_u64),
        total_tokens: object.get("total_tokens").and_then(Value::as_u64),
        extensions,
    })
}

/// Typed non-streaming Chat completion document.
///
/// Chat JSON and Chat SSE use different wire envelopes, but both are decoded
/// into explicit protocol nodes before Relay performs any cross-protocol
/// projection. The JSON boundary may inspect `Value`; no raw document is
/// retained in this tree.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct V3OpenAiChatJsonDocument {
    pub object: String,
    pub id: Option<String>,
    pub created: Option<u64>,
    pub model: Option<String>,
    pub system_fingerprint: Option<String>,
    pub choices: Vec<V3OpenAiChatJsonChoice>,
    pub usage: Option<V3OpenAiChatJsonUsage>,
    pub extensions: Vec<V3OpenAiChatSseExtension>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct V3OpenAiChatJsonChoice {
    pub index: usize,
    pub message: V3OpenAiChatJsonMessage,
    pub finish_reason: Option<String>,
    pub extensions: Vec<V3OpenAiChatSseExtension>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct V3OpenAiChatJsonMessage {
    pub role: Option<String>,
    pub content: Option<V3OpenAiChatJsonContent>,
    pub content_present: bool,
    pub refusal: Option<String>,
    pub refusal_present: bool,
    pub tool_calls: Vec<V3OpenAiChatJsonToolCall>,
    pub tool_calls_present: bool,
    pub extensions: Vec<V3OpenAiChatSseExtension>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum V3OpenAiChatJsonContent {
    Text(String),
    Parts(Vec<V3OpenAiChatJsonContentPart>),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct V3OpenAiChatJsonContentPart {
    pub part_type: String,
    pub text: Option<String>,
    pub refusal: Option<String>,
    pub extensions: Vec<V3OpenAiChatSseExtension>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct V3OpenAiChatJsonToolCall {
    pub call_id: Option<String>,
    pub call_type: Option<String>,
    pub function_name: Option<String>,
    pub function_arguments: Option<String>,
    pub extensions: Vec<V3OpenAiChatSseExtension>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct V3OpenAiChatJsonUsage {
    pub prompt_tokens: Option<u64>,
    pub completion_tokens: Option<u64>,
    pub total_tokens: Option<u64>,
    pub extensions: Vec<V3OpenAiChatSseExtension>,
}

#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum V3OpenAiChatJsonTreeError {
    #[error("OpenAI Chat JSON document must be an object")]
    DocumentNotObject,
    #[error("OpenAI Chat JSON object must be chat.completion")]
    WrongObjectType,
    #[error("OpenAI Chat JSON choices must be an array")]
    ChoicesNotArray,
    #[error("OpenAI Chat JSON choice must be an object")]
    ChoiceNotObject,
    #[error("OpenAI Chat JSON choice index is missing or invalid")]
    ChoiceIndexInvalid,
    #[error("OpenAI Chat JSON choice message must be an object")]
    MessageNotObject,
    #[error("OpenAI Chat JSON message content has unsupported shape")]
    ContentShapeInvalid,
    #[error("OpenAI Chat JSON content part must be an object")]
    ContentPartNotObject,
    #[error("OpenAI Chat JSON tool call must be an object")]
    ToolCallNotObject,
    #[error("OpenAI Chat JSON tool call function must be an object")]
    ToolFunctionNotObject,
    #[error("OpenAI Chat JSON usage must be an object")]
    UsageNotObject,
    #[error("OpenAI Chat JSON projection failed: {0}")]
    Projection(String),
}

impl V3OpenAiChatJsonDocument {
    pub fn from_json(value: &Value) -> Result<Self, V3OpenAiChatJsonTreeError> {
        let object = value
            .as_object()
            .ok_or(V3OpenAiChatJsonTreeError::DocumentNotObject)?;
        let object_type = object
            .get("object")
            .and_then(Value::as_str)
            .filter(|value| *value == "chat.completion")
            .ok_or(V3OpenAiChatJsonTreeError::WrongObjectType)?
            .to_owned();
        let choices = object
            .get("choices")
            .and_then(Value::as_array)
            .ok_or(V3OpenAiChatJsonTreeError::ChoicesNotArray)?
            .iter()
            .map(parse_v3_openai_chat_json_choice)
            .collect::<Result<Vec<_>, _>>()?;
        let usage = object
            .get("usage")
            .map(parse_v3_openai_chat_json_usage)
            .transpose()?;
        Ok(Self {
            object: object_type,
            id: string_field(object, "id"),
            created: object.get("created").and_then(Value::as_u64),
            model: string_field(object, "model"),
            system_fingerprint: string_field(object, "system_fingerprint"),
            choices,
            usage,
            extensions: object_extensions(
                object,
                &[
                    "object",
                    "id",
                    "created",
                    "model",
                    "system_fingerprint",
                    "choices",
                    "usage",
                ],
            ),
        })
    }

    pub fn to_normalized_value(&self) -> Value {
        let mut value = serde_json::Map::new();
        value.insert("object".to_owned(), Value::String(self.object.clone()));
        if let Some(id) = &self.id {
            value.insert("id".to_owned(), Value::String(id.clone()));
        }
        if let Some(created) = self.created {
            value.insert("created".to_owned(), Value::from(created));
        }
        if let Some(model) = &self.model {
            value.insert("model".to_owned(), Value::String(model.clone()));
        }
        if let Some(fingerprint) = &self.system_fingerprint {
            value.insert(
                "system_fingerprint".to_owned(),
                Value::String(fingerprint.clone()),
            );
        }
        value.insert(
            "choices".to_owned(),
            Value::Array(
                self.choices
                    .iter()
                    .map(V3OpenAiChatJsonChoice::to_normalized_value)
                    .collect(),
            ),
        );
        if let Some(usage) = &self.usage {
            value.insert("usage".to_owned(), usage.to_normalized_value());
        }
        for extension in &self.extensions {
            value.insert(extension.name.clone(), extension.value.clone());
        }
        Value::Object(value)
    }
}

impl V3OpenAiChatJsonChoice {
    fn to_normalized_value(&self) -> Value {
        let mut value = serde_json::Map::new();
        value.insert("index".to_owned(), Value::from(self.index));
        value.insert("message".to_owned(), self.message.to_normalized_value());
        if let Some(reason) = &self.finish_reason {
            value.insert("finish_reason".to_owned(), Value::String(reason.clone()));
        } else {
            value.insert("finish_reason".to_owned(), Value::Null);
        }
        for extension in &self.extensions {
            value.insert(extension.name.clone(), extension.value.clone());
        }
        Value::Object(value)
    }
}

impl V3OpenAiChatJsonMessage {
    fn to_normalized_value(&self) -> Value {
        let mut value = serde_json::Map::new();
        if let Some(role) = &self.role {
            value.insert("role".to_owned(), Value::String(role.clone()));
        }
        if self.content_present {
            value.insert(
                "content".to_owned(),
                self.content
                    .as_ref()
                    .map(V3OpenAiChatJsonContent::to_normalized_value)
                    .unwrap_or(Value::Null),
            );
        }
        if self.refusal_present {
            value.insert(
                "refusal".to_owned(),
                self.refusal
                    .as_ref()
                    .map(|refusal| Value::String(refusal.clone()))
                    .unwrap_or(Value::Null),
            );
        }
        if self.tool_calls_present {
            value.insert(
                "tool_calls".to_owned(),
                Value::Array(
                    self.tool_calls
                        .iter()
                        .map(V3OpenAiChatJsonToolCall::to_normalized_value)
                        .collect(),
                ),
            );
        }
        for extension in &self.extensions {
            value.insert(extension.name.clone(), extension.value.clone());
        }
        Value::Object(value)
    }
}

impl V3OpenAiChatJsonContent {
    fn to_normalized_value(&self) -> Value {
        match self {
            Self::Text(text) => Value::String(text.clone()),
            Self::Parts(parts) => Value::Array(
                parts
                    .iter()
                    .map(V3OpenAiChatJsonContentPart::to_normalized_value)
                    .collect(),
            ),
        }
    }
}

impl V3OpenAiChatJsonContentPart {
    fn to_normalized_value(&self) -> Value {
        let mut value = serde_json::Map::new();
        value.insert("type".to_owned(), Value::String(self.part_type.clone()));
        if let Some(text) = &self.text {
            value.insert("text".to_owned(), Value::String(text.clone()));
        }
        if let Some(refusal) = &self.refusal {
            value.insert("refusal".to_owned(), Value::String(refusal.clone()));
        }
        for extension in &self.extensions {
            value.insert(extension.name.clone(), extension.value.clone());
        }
        Value::Object(value)
    }
}

impl V3OpenAiChatJsonToolCall {
    fn to_normalized_value(&self) -> Value {
        let mut function = serde_json::Map::new();
        if let Some(name) = &self.function_name {
            function.insert("name".to_owned(), Value::String(name.clone()));
        }
        if let Some(arguments) = &self.function_arguments {
            function.insert("arguments".to_owned(), Value::String(arguments.clone()));
        }
        let mut value = serde_json::Map::new();
        if let Some(id) = &self.call_id {
            value.insert("id".to_owned(), Value::String(id.clone()));
        }
        if let Some(call_type) = &self.call_type {
            value.insert("type".to_owned(), Value::String(call_type.clone()));
        }
        value.insert("function".to_owned(), Value::Object(function));
        for extension in &self.extensions {
            value.insert(extension.name.clone(), extension.value.clone());
        }
        Value::Object(value)
    }
}

impl V3OpenAiChatJsonUsage {
    fn to_normalized_value(&self) -> Value {
        let mut value = serde_json::Map::new();
        if let Some(tokens) = self.prompt_tokens {
            value.insert("prompt_tokens".to_owned(), Value::from(tokens));
        }
        if let Some(tokens) = self.completion_tokens {
            value.insert("completion_tokens".to_owned(), Value::from(tokens));
        }
        if let Some(tokens) = self.total_tokens {
            value.insert("total_tokens".to_owned(), Value::from(tokens));
        }
        for extension in &self.extensions {
            value.insert(extension.name.clone(), extension.value.clone());
        }
        Value::Object(value)
    }
}

fn parse_v3_openai_chat_json_choice(
    value: &Value,
) -> Result<V3OpenAiChatJsonChoice, V3OpenAiChatJsonTreeError> {
    let object = value
        .as_object()
        .ok_or(V3OpenAiChatJsonTreeError::ChoiceNotObject)?;
    let index = object
        .get("index")
        .and_then(Value::as_u64)
        .and_then(|value| usize::try_from(value).ok())
        .ok_or(V3OpenAiChatJsonTreeError::ChoiceIndexInvalid)?;
    let message = parse_v3_openai_chat_json_message(
        object
            .get("message")
            .ok_or(V3OpenAiChatJsonTreeError::MessageNotObject)?,
    )?;
    Ok(V3OpenAiChatJsonChoice {
        index,
        message,
        finish_reason: string_field(object, "finish_reason"),
        extensions: object_extensions(object, &["index", "message", "finish_reason"]),
    })
}

fn parse_v3_openai_chat_json_message(
    value: &Value,
) -> Result<V3OpenAiChatJsonMessage, V3OpenAiChatJsonTreeError> {
    let object = value
        .as_object()
        .ok_or(V3OpenAiChatJsonTreeError::MessageNotObject)?;
    let content = match object.get("content") {
        None | Some(Value::Null) => None,
        Some(Value::String(text)) => Some(V3OpenAiChatJsonContent::Text(text.clone())),
        Some(Value::Array(parts)) => Some(V3OpenAiChatJsonContent::Parts(
            parts
                .iter()
                .map(parse_v3_openai_chat_json_content_part)
                .collect::<Result<Vec<_>, _>>()?,
        )),
        Some(_) => return Err(V3OpenAiChatJsonTreeError::ContentShapeInvalid),
    };
    let tool_calls = object
        .get("tool_calls")
        .map(|value| {
            value
                .as_array()
                .ok_or(V3OpenAiChatJsonTreeError::ToolCallNotObject)?
                .iter()
                .map(parse_v3_openai_chat_json_tool_call)
                .collect::<Result<Vec<_>, _>>()
        })
        .transpose()?
        .unwrap_or_default();
    Ok(V3OpenAiChatJsonMessage {
        role: string_field(object, "role"),
        content,
        content_present: object.contains_key("content"),
        refusal: string_field(object, "refusal"),
        refusal_present: object.contains_key("refusal"),
        tool_calls,
        tool_calls_present: object.contains_key("tool_calls"),
        extensions: object_extensions(object, &["role", "content", "refusal", "tool_calls"]),
    })
}

fn parse_v3_openai_chat_json_content_part(
    value: &Value,
) -> Result<V3OpenAiChatJsonContentPart, V3OpenAiChatJsonTreeError> {
    let object = value
        .as_object()
        .ok_or(V3OpenAiChatJsonTreeError::ContentPartNotObject)?;
    let part_type =
        string_field(object, "type").ok_or(V3OpenAiChatJsonTreeError::ContentPartNotObject)?;
    Ok(V3OpenAiChatJsonContentPart {
        part_type,
        text: string_field(object, "text"),
        refusal: string_field(object, "refusal"),
        extensions: object_extensions(object, &["type", "text", "refusal"]),
    })
}

fn parse_v3_openai_chat_json_tool_call(
    value: &Value,
) -> Result<V3OpenAiChatJsonToolCall, V3OpenAiChatJsonTreeError> {
    let object = value
        .as_object()
        .ok_or(V3OpenAiChatJsonTreeError::ToolCallNotObject)?;
    let function = object
        .get("function")
        .and_then(Value::as_object)
        .ok_or(V3OpenAiChatJsonTreeError::ToolFunctionNotObject)?;
    Ok(V3OpenAiChatJsonToolCall {
        call_id: string_field(object, "id"),
        call_type: string_field(object, "type"),
        function_name: string_field(function, "name"),
        function_arguments: string_field(function, "arguments"),
        extensions: object_extensions(object, &["id", "type", "function"]),
    })
}

fn parse_v3_openai_chat_json_usage(
    value: &Value,
) -> Result<V3OpenAiChatJsonUsage, V3OpenAiChatJsonTreeError> {
    let object = value
        .as_object()
        .ok_or(V3OpenAiChatJsonTreeError::UsageNotObject)?;
    Ok(V3OpenAiChatJsonUsage {
        prompt_tokens: object.get("prompt_tokens").and_then(Value::as_u64),
        completion_tokens: object.get("completion_tokens").and_then(Value::as_u64),
        total_tokens: object.get("total_tokens").and_then(Value::as_u64),
        extensions: object_extensions(
            object,
            &["prompt_tokens", "completion_tokens", "total_tokens"],
        ),
    })
}

#[path = "openai_chat_sse_tree_tests.rs"]
mod tests;
