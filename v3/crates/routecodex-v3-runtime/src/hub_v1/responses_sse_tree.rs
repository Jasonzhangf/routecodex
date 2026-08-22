use serde_json::Value;
use std::fmt;
use thiserror::Error;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct V3ResponsesSseTransportObject {
    event_name: Option<String>,
    data: Value,
}

impl V3ResponsesSseTransportObject {
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
pub struct V3ResponsesSseProtocolMetadata {
    pub event_type: String,
    pub response_id: Option<String>,
    pub output_index: Option<usize>,
    pub item_id: Option<String>,
    pub content_index: Option<usize>,
    pub sequence_number: Option<u64>,
}

impl V3ResponsesSseProtocolMetadata {
    pub fn from_event(event: &Value) -> Result<Self, V3ResponsesSseTreeError> {
        let object = event
            .as_object()
            .ok_or_else(|| V3ResponsesSseTreeError::EventNotObject)?;
        let event_type = object
            .get("type")
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .ok_or(V3ResponsesSseTreeError::MissingEventType)?
            .to_owned();
        Ok(Self {
            event_type,
            response_id: string_field(object, "response_id"),
            output_index: usize_field(object, "output_index"),
            item_id: string_field(object, "item_id"),
            content_index: usize_field(object, "content_index"),
            sequence_number: u64_field(object, "sequence_number"),
        })
    }

    pub fn contains_business_metadata_field(&self, _field: &str) -> bool {
        false
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct V3ResponsesSseHookInput<'a> {
    pub transport: &'a V3ResponsesSseTransportObject,
    pub protocol: &'a V3ResponsesSseProtocolMetadata,
    pub semantic: &'a V3ResponsesSseSemanticObject,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct V3ResponsesSseSemanticObject {
    pub item: Option<V3ResponsesSseOutputItemKind>,
    pub content: Option<V3ResponsesSseContentKind>,
    item_object: Option<V3ResponsesSseOutputItem>,
    pub protocol: V3ResponsesSseProtocolMetadata,
    pub content_value: Option<String>,
    pub content_field: Option<String>,
    pub response: Option<V3ResponsesSseResponseContainer>,
    pub extensions: Vec<V3ResponsesSseExtension>,
}

pub trait V3ResponsesSseSemanticHook {
    fn notify(&mut self, input: &V3ResponsesSseHookInput<'_>);

    fn rewrite(
        &mut self,
        semantic: &mut V3ResponsesSseSemanticObject,
    ) -> Result<(), V3ResponsesSseTreeError>;
}

pub fn apply_v3_responses_sse_semantic_hook(
    semantic: &mut V3ResponsesSseSemanticObject,
    transport: &V3ResponsesSseTransportObject,
    protocol: &V3ResponsesSseProtocolMetadata,
    hook: &mut impl V3ResponsesSseSemanticHook,
) -> Result<(), V3ResponsesSseTreeError> {
    let input = V3ResponsesSseHookInput {
        transport,
        protocol,
        semantic,
    };
    hook.notify(&input);
    hook.rewrite(semantic)
}

impl V3ResponsesSseSemanticObject {
    pub fn new_compat_output_item_event(
        event_type: impl Into<String>,
        output_index: usize,
        item: V3ResponsesSseOutputItem,
    ) -> Self {
        let item_kind = item.kind();
        let item_id = item.identity().item_id.clone();
        Self {
            item: Some(item_kind),
            content: None,
            item_object: Some(item),
            protocol: V3ResponsesSseProtocolMetadata {
                event_type: event_type.into(),
                response_id: None,
                output_index: Some(output_index),
                item_id,
                content_index: None,
                sequence_number: None,
            },
            content_value: None,
            content_field: None,
            response: None,
            extensions: Vec::new(),
        }
    }

    pub fn new_compat_reasoning_summary_part_event(
        event_type: impl Into<String>,
        output_index: usize,
        item_id: impl Into<String>,
        summary_index: usize,
        part_text: impl Into<String>,
    ) -> Self {
        Self {
            item: None,
            content: Some(V3ResponsesSseContentKind::ReasoningSummary),
            item_object: None,
            protocol: V3ResponsesSseProtocolMetadata {
                event_type: event_type.into(),
                response_id: None,
                output_index: Some(output_index),
                item_id: Some(item_id.into()),
                content_index: None,
                sequence_number: None,
            },
            content_value: None,
            content_field: None,
            response: None,
            extensions: vec![
                V3ResponsesSseExtension {
                    name: "summary_index".to_owned(),
                    value: serde_json::Value::from(summary_index),
                },
                V3ResponsesSseExtension {
                    name: "part".to_owned(),
                    value: serde_json::json!({
                        "type":"summary_text",
                        "text":part_text.into()
                    }),
                },
            ],
        }
    }

    pub fn new_compat_reasoning_summary_text_event(
        event_type: impl Into<String>,
        output_index: usize,
        item_id: impl Into<String>,
        summary_index: usize,
        field: impl Into<String>,
        value: impl Into<String>,
    ) -> Self {
        Self::new_compat_content_event(
            event_type,
            output_index,
            item_id,
            summary_index,
            field,
            value,
        )
    }

    fn new_compat_content_event(
        event_type: impl Into<String>,
        output_index: usize,
        item_id: impl Into<String>,
        summary_index: usize,
        field: impl Into<String>,
        value: impl Into<String>,
    ) -> Self {
        let field = field.into();
        Self {
            item: None,
            content: Some(V3ResponsesSseContentKind::ReasoningSummary),
            item_object: None,
            protocol: V3ResponsesSseProtocolMetadata {
                event_type: event_type.into(),
                response_id: None,
                output_index: Some(output_index),
                item_id: Some(item_id.into()),
                content_index: None,
                sequence_number: None,
            },
            content_value: Some(value.into()),
            content_field: Some(field),
            response: None,
            extensions: vec![V3ResponsesSseExtension {
                name: "summary_index".to_owned(),
                value: serde_json::Value::from(summary_index),
            }],
        }
    }

    pub fn to_normalized_value(&self) -> Value {
        let mut value = serde_json::Map::new();
        value.insert(
            "type".to_owned(),
            Value::String(self.protocol.event_type.clone()),
        );
        if let Some(response_id) = &self.protocol.response_id {
            value.insert("response_id".to_owned(), Value::String(response_id.clone()));
        }
        if let Some(output_index) = self.protocol.output_index {
            value.insert("output_index".to_owned(), Value::from(output_index));
        }
        if let Some(item_id) = &self.protocol.item_id {
            value.insert("item_id".to_owned(), Value::String(item_id.clone()));
        }
        if let Some(content_index) = self.protocol.content_index {
            value.insert("content_index".to_owned(), Value::from(content_index));
        }
        if let Some(sequence_number) = self.protocol.sequence_number {
            value.insert("sequence_number".to_owned(), Value::from(sequence_number));
        }
        if let Some(item) = &self.item_object {
            value.insert("item".to_owned(), item.to_normalized_value());
        }
        if let (Some(field), Some(content)) = (&self.content_field, &self.content_value) {
            value.insert(field.clone(), Value::String(content.clone()));
        }
        if let Some(response) = &self.response {
            value.insert("response".to_owned(), response.to_normalized_value());
        }
        for extension in &self.extensions {
            value.insert(extension.name.clone(), extension.value.clone());
        }
        Value::Object(value)
    }

    pub fn item(&self) -> Option<&V3ResponsesSseOutputItem> {
        self.item_object.as_ref()
    }

    pub fn set_content_value(&mut self, field: impl Into<String>, value: impl Into<String>) {
        self.content_field = Some(field.into());
        self.content_value = Some(value.into());
    }

    pub fn set_event_type(&mut self, event_type: impl Into<String>) {
        self.protocol.event_type = event_type.into();
    }

    pub fn set_extension_object_text(
        &mut self,
        extension_name: &str,
        field: &str,
        value: impl Into<String>,
    ) -> Result<(), V3ResponsesSseTreeError> {
        let extension = self
            .extensions
            .iter_mut()
            .find(|extension| extension.name == extension_name)
            .ok_or_else(|| {
                V3ResponsesSseTreeError::Projection(format!("missing extension {extension_name}"))
            })?;
        let object = extension.value.as_object_mut().ok_or_else(|| {
            V3ResponsesSseTreeError::Projection(format!(
                "extension {extension_name} is not an object"
            ))
        })?;
        object.insert(field.to_owned(), Value::String(value.into()));
        Ok(())
    }

    pub fn replace_response_output(
        &mut self,
        output: Vec<V3ResponsesSseOutputItem>,
    ) -> Result<(), V3ResponsesSseTreeError> {
        let response = self.response.as_mut().ok_or_else(|| {
            V3ResponsesSseTreeError::Projection("missing typed response container".to_owned())
        })?;
        response.output = Some(output);
        Ok(())
    }

    pub fn rewrite_item_content(
        &mut self,
        rewrite: V3ResponsesSseContentRewrite,
    ) -> Result<(), V3ResponsesSseTreeError> {
        let item = self
            .item_object
            .take()
            .ok_or_else(|| V3ResponsesSseTreeError::Projection("missing typed item".to_owned()))?;
        self.item_object = Some(rewrite_v3_responses_sse_content(item, rewrite)?);
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum V3ResponsesSseContentKind {
    OutputText,
    Refusal,
    ReasoningText,
    ReasoningSummary,
    FunctionArguments,
    CustomToolInput,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum V3ResponsesSseOutputItemKind {
    /// Explicit compatibility node for legacy provider projections that
    /// expose output text as an output item instead of message content.
    OutputText,
    Message,
    Reasoning,
    FunctionCall,
    CustomToolCall,
    FunctionCallOutput,
    WebSearchCall,
    FileSearchCall,
    CodeInterpreterCall,
    ComputerCall,
    McpCall,
    McpListTools,
    McpApprovalRequest,
    ToolSearchCall,
    ApplyPatchCall,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct V3ResponsesSseExtension {
    pub name: String,
    pub value: Value,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct V3ResponsesSseUsage {
    pub input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
    pub total_tokens: Option<u64>,
    pub extensions: Vec<V3ResponsesSseExtension>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct V3ResponsesSseResponseError {
    pub error_type: Option<String>,
    pub code: Option<String>,
    pub message: Option<String>,
    pub extensions: Vec<V3ResponsesSseExtension>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct V3ResponsesSseResponseContainer {
    pub id: Option<String>,
    pub status: Option<String>,
    pub model: Option<String>,
    pub output: Option<Vec<V3ResponsesSseOutputItem>>,
    pub usage: Option<V3ResponsesSseUsage>,
    pub error: Option<V3ResponsesSseResponseError>,
    pub extensions: Vec<V3ResponsesSseExtension>,
}

impl V3ResponsesSseResponseContainer {
    pub fn to_normalized_value(&self) -> Value {
        let mut value = serde_json::Map::new();
        if let Some(id) = &self.id {
            value.insert("id".to_owned(), Value::String(id.clone()));
        }
        if let Some(status) = &self.status {
            value.insert("status".to_owned(), Value::String(status.clone()));
        }
        if let Some(model) = &self.model {
            value.insert("model".to_owned(), Value::String(model.clone()));
        }
        if let Some(output) = &self.output {
            value.insert(
                "output".to_owned(),
                Value::Array(
                    output
                        .iter()
                        .map(V3ResponsesSseOutputItem::to_normalized_value)
                        .collect(),
                ),
            );
        }
        if let Some(usage) = &self.usage {
            let mut usage_value = serde_json::Map::new();
            if let Some(tokens) = usage.input_tokens {
                usage_value.insert("input_tokens".to_owned(), Value::from(tokens));
            }
            if let Some(tokens) = usage.output_tokens {
                usage_value.insert("output_tokens".to_owned(), Value::from(tokens));
            }
            if let Some(tokens) = usage.total_tokens {
                usage_value.insert("total_tokens".to_owned(), Value::from(tokens));
            }
            for extension in &usage.extensions {
                usage_value.insert(extension.name.clone(), extension.value.clone());
            }
            value.insert("usage".to_owned(), Value::Object(usage_value));
        }
        if let Some(error) = &self.error {
            let mut error_value = serde_json::Map::new();
            if let Some(error_type) = &error.error_type {
                error_value.insert("type".to_owned(), Value::String(error_type.clone()));
            }
            if let Some(code) = &error.code {
                error_value.insert("code".to_owned(), Value::String(code.clone()));
            }
            if let Some(message) = &error.message {
                error_value.insert("message".to_owned(), Value::String(message.clone()));
            }
            for extension in &error.extensions {
                error_value.insert(extension.name.clone(), extension.value.clone());
            }
            value.insert("error".to_owned(), Value::Object(error_value));
        }
        for extension in &self.extensions {
            value.insert(extension.name.clone(), extension.value.clone());
        }
        Value::Object(value)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum V3ResponsesSseTypedOutputItem {
    OutputText(V3ResponsesSseOutputItem),
    Message(V3ResponsesSseOutputItem),
    Reasoning(V3ResponsesSseOutputItem),
    FunctionCall(V3ResponsesSseOutputItem),
    CustomToolCall(V3ResponsesSseOutputItem),
    FunctionCallOutput(V3ResponsesSseOutputItem),
    WebSearchCall(V3ResponsesSseOutputItem),
    FileSearchCall(V3ResponsesSseOutputItem),
    CodeInterpreterCall(V3ResponsesSseOutputItem),
    ComputerCall(V3ResponsesSseOutputItem),
    McpCall(V3ResponsesSseOutputItem),
    McpListTools(V3ResponsesSseOutputItem),
    McpApprovalRequest(V3ResponsesSseOutputItem),
    ToolSearchCall(V3ResponsesSseOutputItem),
    ApplyPatchCall(V3ResponsesSseOutputItem),
}

impl V3ResponsesSseTypedOutputItem {
    pub fn from_item(item: V3ResponsesSseOutputItem) -> Self {
        match item.kind() {
            V3ResponsesSseOutputItemKind::OutputText => Self::OutputText(item),
            V3ResponsesSseOutputItemKind::Message => Self::Message(item),
            V3ResponsesSseOutputItemKind::Reasoning => Self::Reasoning(item),
            V3ResponsesSseOutputItemKind::FunctionCall => Self::FunctionCall(item),
            V3ResponsesSseOutputItemKind::CustomToolCall => Self::CustomToolCall(item),
            V3ResponsesSseOutputItemKind::FunctionCallOutput => Self::FunctionCallOutput(item),
            V3ResponsesSseOutputItemKind::WebSearchCall => Self::WebSearchCall(item),
            V3ResponsesSseOutputItemKind::FileSearchCall => Self::FileSearchCall(item),
            V3ResponsesSseOutputItemKind::CodeInterpreterCall => Self::CodeInterpreterCall(item),
            V3ResponsesSseOutputItemKind::ComputerCall => Self::ComputerCall(item),
            V3ResponsesSseOutputItemKind::McpCall => Self::McpCall(item),
            V3ResponsesSseOutputItemKind::McpListTools => Self::McpListTools(item),
            V3ResponsesSseOutputItemKind::McpApprovalRequest => Self::McpApprovalRequest(item),
            V3ResponsesSseOutputItemKind::ToolSearchCall => Self::ToolSearchCall(item),
            V3ResponsesSseOutputItemKind::ApplyPatchCall => Self::ApplyPatchCall(item),
        }
    }

    pub fn item(&self) -> &V3ResponsesSseOutputItem {
        match self {
            Self::OutputText(item)
            | Self::Message(item)
            | Self::Reasoning(item)
            | Self::FunctionCall(item)
            | Self::CustomToolCall(item)
            | Self::FunctionCallOutput(item)
            | Self::WebSearchCall(item)
            | Self::FileSearchCall(item)
            | Self::CodeInterpreterCall(item)
            | Self::ComputerCall(item)
            | Self::McpCall(item)
            | Self::McpListTools(item)
            | Self::McpApprovalRequest(item)
            | Self::ToolSearchCall(item)
            | Self::ApplyPatchCall(item) => item,
        }
    }

    fn item_mut(&mut self) -> &mut V3ResponsesSseOutputItem {
        match self {
            Self::OutputText(item)
            | Self::Message(item)
            | Self::Reasoning(item)
            | Self::FunctionCall(item)
            | Self::CustomToolCall(item)
            | Self::FunctionCallOutput(item)
            | Self::WebSearchCall(item)
            | Self::FileSearchCall(item)
            | Self::CodeInterpreterCall(item)
            | Self::ComputerCall(item)
            | Self::McpCall(item)
            | Self::McpListTools(item)
            | Self::McpApprovalRequest(item)
            | Self::ToolSearchCall(item)
            | Self::ApplyPatchCall(item) => item,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum V3ResponsesSseTerminalState {
    Completed,
    Incomplete,
    Failed,
    Cancelled,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct V3ResponsesSseReducerState {
    pub response: Option<V3ResponsesSseResponseContainer>,
    pub items: Vec<V3ResponsesSseTypedOutputItem>,
    pub output_text: String,
    pub terminal: Option<V3ResponsesSseTerminalState>,
    pub sequence_number: Option<u64>,
    pub extensions: Vec<V3ResponsesSseExtension>,
}

/// Typed representation of a non-streaming Responses JSON document.
///
/// JSON and SSE share the same response container and output-item nodes. The
/// JSON boundary may use `Value` while decoding, but the projected document is
/// rebuilt exclusively from typed container/items and explicit extensions.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct V3ResponsesJsonDocument {
    pub object: Option<String>,
    pub response: V3ResponsesSseResponseContainer,
    pub output_present: bool,
    pub items: Vec<V3ResponsesSseTypedOutputItem>,
    pub extensions: Vec<V3ResponsesSseExtension>,
}

impl V3ResponsesJsonDocument {
    pub fn from_json(value: &Value) -> Result<Self, V3ResponsesSseTreeError> {
        let object = value
            .as_object()
            .ok_or(V3ResponsesSseTreeError::EventNotObject)?;
        let mut response = parse_response_container(value)?;
        response.extensions.retain(|extension| {
            matches!(
                extension.name.as_str(),
                "id" | "status" | "model" | "usage" | "error"
            )
        });
        let output_present = object.contains_key("output");
        let items = match object.get("output") {
            None => Vec::new(),
            Some(output) => output
                .as_array()
                .ok_or(V3ResponsesSseTreeError::OutputNotArray)?
                .iter()
                .map(|item| {
                    classify_v3_responses_sse_output_item(item)
                        .map(V3ResponsesSseTypedOutputItem::from_item)
                })
                .collect::<Result<Vec<_>, _>>()?,
        };
        let extensions = event_extensions(
            object,
            &[
                "object", "id", "status", "model", "usage", "error", "output",
            ],
        );
        Ok(Self {
            object: string_field(object, "object"),
            response,
            output_present,
            items,
            extensions,
        })
    }

    pub fn to_normalized_value(&self) -> Value {
        let mut value = self.response.to_normalized_value();
        let Some(value_object) = value.as_object_mut() else {
            return value;
        };
        if let Some(object) = &self.object {
            value_object.insert("object".to_owned(), Value::String(object.clone()));
        }
        if self.output_present {
            value_object.insert(
                "output".to_owned(),
                Value::Array(
                    self.items
                        .iter()
                        .map(|item| item.item().to_normalized_value())
                        .collect(),
                ),
            );
        }
        for extension in &self.extensions {
            value_object.insert(extension.name.clone(), extension.value.clone());
        }
        value
    }
}

impl Default for V3ResponsesSseReducerState {
    fn default() -> Self {
        Self {
            response: None,
            items: Vec::new(),
            output_text: String::new(),
            terminal: None,
            sequence_number: None,
            extensions: Vec::new(),
        }
    }
}

impl V3ResponsesSseReducerState {
    pub fn apply_event(&mut self, event: &Value) -> Result<(), V3ResponsesSseTreeError> {
        let metadata = V3ResponsesSseProtocolMetadata::from_event(event)?;
        self.sequence_number = metadata.sequence_number.or(self.sequence_number);
        match metadata.event_type.as_str() {
            "response.created" | "response.in_progress" => {
                if let Some(response) = event.get("response") {
                    self.response = Some(parse_response_container(response)?);
                }
            }
            "response.output_item.added" | "response.output_item.done" => {
                let item = event
                    .get("item")
                    .ok_or(V3ResponsesSseTreeError::MissingOutputItem)?;
                let typed = V3ResponsesSseTypedOutputItem::from_item(
                    classify_v3_responses_sse_output_item(item)?,
                );
                let mut typed = typed;
                if typed.item().identity().output_index.is_none() {
                    typed.item_mut().identity.output_index = metadata.output_index;
                }
                let identity = typed.item().identity().clone();
                if let Some(existing) = self.items.iter_mut().find(|existing| {
                    let current = existing.item().identity();
                    (identity.item_id.is_some() && current.item_id == identity.item_id)
                        || (identity.output_index.is_some()
                            && current.output_index == identity.output_index)
                }) {
                    *existing = typed;
                } else {
                    self.items.push(typed);
                }
            }
            "response.content_part.added" | "response.content_part.done" => {
                if let Some(item) = self.item_mut_for_event(&metadata) {
                    if let Some(part) = event.get("part").or_else(|| event.get("content_part")) {
                        item.set_message_content_part(part)?;
                    }
                }
            }
            "response.output_text.delta" => {
                if let Some(delta) = event.get("delta").and_then(Value::as_str) {
                    self.output_text.push_str(delta);
                }
            }
            "response.output_text.done" => {
                if let Some(text) = event.get("text").and_then(Value::as_str) {
                    self.output_text = text.to_owned();
                }
            }
            "response.function_call_arguments.delta" => {
                if let Some(delta) = event.get("delta").and_then(Value::as_str) {
                    if let Some(item) = self.item_mut_for_event(&metadata) {
                        item.append_function_arguments(delta);
                    }
                }
            }
            "response.function_call_arguments.done" => {
                if let Some(arguments) = event.get("arguments").and_then(Value::as_str) {
                    if let Some(item) = self.item_mut_for_event(&metadata) {
                        item.set_function_arguments(arguments);
                    }
                }
            }
            "response.custom_tool_call_input.delta" => {
                if let Some(delta) = event.get("delta").and_then(Value::as_str) {
                    if let Some(item) = self.item_mut_for_event(&metadata) {
                        item.append_custom_tool_input(delta);
                    }
                }
            }
            "response.custom_tool_call_input.done" => {
                if let Some(input) = event.get("input").and_then(Value::as_str) {
                    if let Some(item) = self.item_mut_for_event(&metadata) {
                        item.set_custom_tool_input(input);
                    }
                }
            }
            "response.reasoning_summary_part.added" | "response.reasoning_summary_part.done" => {
                if let Some(summary_index) = event
                    .get("summary_index")
                    .and_then(Value::as_u64)
                    .and_then(|value| usize::try_from(value).ok())
                {
                    if let Some(item) = self.item_mut_for_event(&metadata) {
                        if let Some(part) = event.get("part") {
                            item.set_reasoning_summary_part(summary_index, part)?;
                        }
                    }
                }
            }
            "response.reasoning_summary_text.delta" => {
                if let (Some(summary_index), Some(delta)) = (
                    event
                        .get("summary_index")
                        .and_then(Value::as_u64)
                        .and_then(|value| usize::try_from(value).ok()),
                    event.get("delta").and_then(Value::as_str),
                ) {
                    if let Some(item) = self.item_mut_for_event(&metadata) {
                        item.append_reasoning_summary_text(summary_index, delta);
                    }
                }
            }
            "response.reasoning_summary_text.done" => {
                if let (Some(summary_index), Some(text)) = (
                    event
                        .get("summary_index")
                        .and_then(Value::as_u64)
                        .and_then(|value| usize::try_from(value).ok()),
                    event.get("text").and_then(Value::as_str),
                ) {
                    if let Some(item) = self.item_mut_for_event(&metadata) {
                        item.set_reasoning_summary_text(summary_index, text);
                    }
                }
            }
            "response.completed" => self.terminal = Some(V3ResponsesSseTerminalState::Completed),
            "response.incomplete" => self.terminal = Some(V3ResponsesSseTerminalState::Incomplete),
            "response.failed" => self.terminal = Some(V3ResponsesSseTerminalState::Failed),
            "response.cancelled" => self.terminal = Some(V3ResponsesSseTerminalState::Cancelled),
            _ => {}
        }
        Ok(())
    }

    fn item_mut_for_event(
        &mut self,
        metadata: &V3ResponsesSseProtocolMetadata,
    ) -> Option<&mut V3ResponsesSseOutputItem> {
        self.items
            .iter_mut()
            .enumerate()
            .find_map(|(position, item)| {
                let candidate = item.item_mut();
                let identity = candidate.identity();
                if metadata.item_id.as_deref() == identity.item_id.as_deref()
                    || metadata.output_index == identity.output_index
                    || metadata.output_index == Some(position)
                {
                    Some(candidate)
                } else {
                    None
                }
            })
    }
}

impl V3ResponsesSseOutputItemKind {
    fn parse(value: &str) -> Result<Self, V3ResponsesSseTreeError> {
        match value {
            "output_text" => Ok(Self::OutputText),
            "message" => Ok(Self::Message),
            "reasoning" => Ok(Self::Reasoning),
            "function_call" => Ok(Self::FunctionCall),
            "custom_tool_call" => Ok(Self::CustomToolCall),
            "function_call_output" => Ok(Self::FunctionCallOutput),
            "web_search_call" => Ok(Self::WebSearchCall),
            "file_search_call" => Ok(Self::FileSearchCall),
            "code_interpreter_call" => Ok(Self::CodeInterpreterCall),
            "computer_call" => Ok(Self::ComputerCall),
            "mcp_call" => Ok(Self::McpCall),
            "mcp_list_tools" => Ok(Self::McpListTools),
            "mcp_approval_request" => Ok(Self::McpApprovalRequest),
            "tool_search_call" => Ok(Self::ToolSearchCall),
            "apply_patch_call" => Ok(Self::ApplyPatchCall),
            other => Err(V3ResponsesSseTreeError::UnsupportedItemType {
                item_type: other.to_owned(),
            }),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct V3ResponsesSseItemIdentity {
    pub item_id: Option<String>,
    pub output_index: Option<usize>,
    pub status: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct V3ResponsesSseMessageContentPart {
    pub part_type: String,
    pub text: Option<String>,
    pub refusal: Option<String>,
    pub extensions: Vec<V3ResponsesSseExtension>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct V3ResponsesSseReasoningSummary {
    pub summary_type: String,
    pub text: Option<String>,
    pub extensions: Vec<V3ResponsesSseExtension>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum V3ResponsesSseItemPayload {
    OutputText {
        text: Option<String>,
    },
    Message {
        content: Vec<V3ResponsesSseMessageContentPart>,
        content_present: bool,
    },
    Reasoning {
        summary: Vec<V3ResponsesSseReasoningSummary>,
        summary_present: bool,
    },
    FunctionCall {
        call_id: Option<String>,
        name: Option<String>,
        arguments: Option<String>,
    },
    CustomToolCall {
        call_id: Option<String>,
        name: Option<String>,
        input: Option<String>,
    },
    StructuredExtensions(Vec<V3ResponsesSseExtension>),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct V3ResponsesSseOutputItem {
    kind: V3ResponsesSseOutputItemKind,
    identity: V3ResponsesSseItemIdentity,
    payload: V3ResponsesSseItemPayload,
    extensions: Vec<V3ResponsesSseExtension>,
    rewritten_content: Option<String>,
}

impl V3ResponsesSseOutputItem {
    pub fn kind(&self) -> V3ResponsesSseOutputItemKind {
        self.kind
    }

    pub fn identity(&self) -> &V3ResponsesSseItemIdentity {
        &self.identity
    }

    pub fn rewritten_content(&self) -> Option<&str> {
        self.rewritten_content.as_deref()
    }

    pub fn reasoning_summary_texts(&self) -> Option<Vec<String>> {
        let V3ResponsesSseItemPayload::Reasoning { summary, .. } = &self.payload else {
            return None;
        };
        Some(
            summary
                .iter()
                .filter_map(|entry| entry.text.clone())
                .collect(),
        )
    }

    pub fn message_output_texts(&self) -> Option<Vec<String>> {
        let V3ResponsesSseItemPayload::Message { content, .. } = &self.payload else {
            return None;
        };
        Some(
            content
                .iter()
                .filter(|part| part.part_type == "output_text")
                .filter_map(|part| part.text.clone())
                .collect(),
        )
    }

    pub fn replace_message_output_texts(
        &mut self,
        texts: &[String],
    ) -> Result<(), V3ResponsesSseTreeError> {
        let V3ResponsesSseItemPayload::Message { content, .. } = &mut self.payload else {
            return Err(V3ResponsesSseTreeError::IncompatibleContentRewrite {
                content: "text".to_owned(),
                item_type: self.kind.to_string(),
            });
        };
        let mut text_index = 0usize;
        for part in content.iter_mut() {
            if part.part_type != "output_text" {
                continue;
            }
            part.text = Some(texts.get(text_index).cloned().unwrap_or_default());
            text_index += 1;
        }
        Ok(())
    }

    pub fn into_reasoning_compat_item(self, summary_text: Vec<String>) -> Self {
        Self {
            kind: V3ResponsesSseOutputItemKind::Reasoning,
            identity: self.identity,
            payload: V3ResponsesSseItemPayload::Reasoning {
                summary: summary_text
                    .into_iter()
                    .map(|text| V3ResponsesSseReasoningSummary {
                        summary_type: "summary_text".to_owned(),
                        text: Some(text),
                        extensions: Vec::new(),
                    })
                    .collect(),
                summary_present: true,
            },
            extensions: self.extensions,
            rewritten_content: None,
        }
    }

    pub fn new_reasoning_compat_item(
        item_id: Option<String>,
        output_index: Option<usize>,
        status: Option<String>,
        summary_text: Vec<String>,
    ) -> Self {
        Self {
            kind: V3ResponsesSseOutputItemKind::Reasoning,
            identity: V3ResponsesSseItemIdentity {
                item_id,
                output_index,
                status,
            },
            payload: V3ResponsesSseItemPayload::Reasoning {
                summary: summary_text
                    .into_iter()
                    .map(|text| V3ResponsesSseReasoningSummary {
                        summary_type: "summary_text".to_owned(),
                        text: Some(text),
                        extensions: Vec::new(),
                    })
                    .collect(),
                summary_present: true,
            },
            extensions: Vec::new(),
            rewritten_content: None,
        }
    }

    pub fn to_normalized_value(&self) -> Value {
        let mut value = serde_json::Map::new();
        value.insert("type".to_owned(), Value::String(self.kind.to_string()));
        if let Some(id) = &self.identity.item_id {
            value.insert("id".to_owned(), Value::String(id.clone()));
        }
        if let Some(output_index) = self.identity.output_index {
            value.insert("output_index".to_owned(), Value::from(output_index));
        }
        if let Some(status) = &self.identity.status {
            value.insert("status".to_owned(), Value::String(status.clone()));
        }
        match &self.payload {
            V3ResponsesSseItemPayload::OutputText { text } => {
                if let Some(text) = text {
                    value.insert("text".to_owned(), Value::String(text.clone()));
                }
            }
            V3ResponsesSseItemPayload::Message {
                content,
                content_present,
            } => {
                if *content_present {
                    value.insert(
                        "content".to_owned(),
                        Value::Array(content.iter().map(message_content_part_value).collect()),
                    );
                }
            }
            V3ResponsesSseItemPayload::Reasoning {
                summary,
                summary_present,
            } => {
                if *summary_present {
                    value.insert(
                        "summary".to_owned(),
                        Value::Array(summary.iter().map(reasoning_summary_value).collect()),
                    );
                }
            }
            V3ResponsesSseItemPayload::FunctionCall {
                call_id,
                name,
                arguments,
            } => {
                if let Some(call_id) = call_id {
                    value.insert("call_id".to_owned(), Value::String(call_id.clone()));
                }
                if let Some(name) = name {
                    value.insert("name".to_owned(), Value::String(name.clone()));
                }
                if let Some(arguments) = arguments {
                    value.insert("arguments".to_owned(), Value::String(arguments.clone()));
                }
            }
            V3ResponsesSseItemPayload::CustomToolCall {
                call_id,
                name,
                input,
            } => {
                if let Some(call_id) = call_id {
                    value.insert("call_id".to_owned(), Value::String(call_id.clone()));
                }
                if let Some(name) = name {
                    value.insert("name".to_owned(), Value::String(name.clone()));
                }
                if let Some(input) = input {
                    value.insert("input".to_owned(), Value::String(input.clone()));
                }
            }
            V3ResponsesSseItemPayload::StructuredExtensions(extensions) => {
                for extension in extensions {
                    value.insert(extension.name.clone(), extension.value.clone());
                }
            }
        }
        let mut value = Value::Object(value);
        if let Some(rewritten) = &self.rewritten_content {
            apply_typed_content_rewrite(&mut value, self.kind, rewritten);
        }
        let Some(value_object) = value.as_object_mut() else {
            return value;
        };
        for extension in &self.extensions {
            value_object.insert(extension.name.clone(), extension.value.clone());
        }
        value
    }

    fn set_message_content_part(&mut self, part: &Value) -> Result<(), V3ResponsesSseTreeError> {
        let V3ResponsesSseItemPayload::Message { content, .. } = &mut self.payload else {
            return Ok(());
        };
        let parsed = parse_message_content_part(part)?;
        if let Some(index) = part
            .get("index")
            .and_then(Value::as_u64)
            .and_then(|value| usize::try_from(value).ok())
        {
            while content.len() <= index {
                content.push(V3ResponsesSseMessageContentPart {
                    part_type: "output_text".to_owned(),
                    text: Some(String::new()),
                    refusal: None,
                    extensions: Vec::new(),
                });
            }
            content[index] = parsed;
        } else {
            content.push(parsed);
        }
        Ok(())
    }

    fn append_function_arguments(&mut self, delta: &str) {
        if let V3ResponsesSseItemPayload::FunctionCall { arguments, .. } = &mut self.payload {
            arguments.get_or_insert_with(String::new).push_str(delta);
        }
    }

    fn set_function_arguments(&mut self, arguments: &str) {
        if let V3ResponsesSseItemPayload::FunctionCall {
            arguments: current, ..
        } = &mut self.payload
        {
            *current = Some(arguments.to_owned());
        }
    }

    fn append_custom_tool_input(&mut self, delta: &str) {
        if let V3ResponsesSseItemPayload::CustomToolCall { input, .. } = &mut self.payload {
            input.get_or_insert_with(String::new).push_str(delta);
        }
    }

    fn set_custom_tool_input(&mut self, input: &str) {
        if let V3ResponsesSseItemPayload::CustomToolCall { input: current, .. } = &mut self.payload
        {
            *current = Some(input.to_owned());
        }
    }

    fn set_reasoning_summary_part(
        &mut self,
        index: usize,
        part: &Value,
    ) -> Result<(), V3ResponsesSseTreeError> {
        let V3ResponsesSseItemPayload::Reasoning { summary, .. } = &mut self.payload else {
            return Ok(());
        };
        let parsed = parse_reasoning_summary_part(part)?;
        while summary.len() <= index {
            summary.push(V3ResponsesSseReasoningSummary {
                summary_type: "summary_text".to_owned(),
                text: Some(String::new()),
                extensions: Vec::new(),
            });
        }
        summary[index] = parsed;
        Ok(())
    }

    fn append_reasoning_summary_text(&mut self, index: usize, delta: &str) {
        if let V3ResponsesSseItemPayload::Reasoning { summary, .. } = &mut self.payload {
            while summary.len() <= index {
                summary.push(V3ResponsesSseReasoningSummary {
                    summary_type: "summary_text".to_owned(),
                    text: Some(String::new()),
                    extensions: Vec::new(),
                });
            }
            summary[index]
                .text
                .get_or_insert_with(String::new)
                .push_str(delta);
        }
    }

    fn set_reasoning_summary_text(&mut self, index: usize, text: &str) {
        self.append_reasoning_summary_text(index, "");
        if let V3ResponsesSseItemPayload::Reasoning { summary, .. } = &mut self.payload {
            if let Some(entry) = summary.get_mut(index) {
                entry.text = Some(text.to_owned());
            }
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum V3ResponsesSseContentRewrite {
    Text(String),
    Refusal(String),
    Reasoning(String),
    FunctionArguments(String),
    CustomToolInput(String),
}

#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum V3ResponsesSseTreeError {
    #[error("Responses semantic SSE event payload must be a JSON object with a string 'type' field")]
    EventNotObject,
    #[error("Responses SSE event is missing type")]
    MissingEventType,
    #[error("Responses SSE output item event is missing item")]
    MissingOutputItem,
    #[error("Responses JSON output must be an array")]
    OutputNotArray,
    #[error("unsupported Responses output item type: {item_type}")]
    UnsupportedItemType { item_type: String },
    #[error("Responses SSE content rewrite {content} is incompatible with item type {item_type}")]
    IncompatibleContentRewrite { content: String, item_type: String },
    #[error("Responses SSE projection failed: {0}")]
    Projection(String),
}

impl fmt::Display for V3ResponsesSseOutputItemKind {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::OutputText => "output_text",
            Self::Message => "message",
            Self::Reasoning => "reasoning",
            Self::FunctionCall => "function_call",
            Self::CustomToolCall => "custom_tool_call",
            Self::FunctionCallOutput => "function_call_output",
            Self::WebSearchCall => "web_search_call",
            Self::FileSearchCall => "file_search_call",
            Self::CodeInterpreterCall => "code_interpreter_call",
            Self::ComputerCall => "computer_call",
            Self::McpCall => "mcp_call",
            Self::McpListTools => "mcp_list_tools",
            Self::McpApprovalRequest => "mcp_approval_request",
            Self::ToolSearchCall => "tool_search_call",
            Self::ApplyPatchCall => "apply_patch_call",
        })
    }
}

pub fn classify_v3_responses_sse_output_item(
    item: &Value,
) -> Result<V3ResponsesSseOutputItem, V3ResponsesSseTreeError> {
    let object = item
        .as_object()
        .ok_or(V3ResponsesSseTreeError::EventNotObject)?;
    let item_type = object
        .get("type")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or(V3ResponsesSseTreeError::MissingEventType)?;
    let kind = V3ResponsesSseOutputItemKind::parse(item_type)?;
    let payload = match kind {
        V3ResponsesSseOutputItemKind::OutputText => V3ResponsesSseItemPayload::OutputText {
            text: string_field(object, "text"),
        },
        V3ResponsesSseOutputItemKind::Message => V3ResponsesSseItemPayload::Message {
            content: parse_message_content(object.get("content"))?,
            content_present: object.contains_key("content"),
        },
        V3ResponsesSseOutputItemKind::Reasoning => V3ResponsesSseItemPayload::Reasoning {
            summary: parse_reasoning_summary(object.get("summary"))?,
            summary_present: object.contains_key("summary"),
        },
        V3ResponsesSseOutputItemKind::FunctionCall => V3ResponsesSseItemPayload::FunctionCall {
            call_id: string_field(object, "call_id"),
            name: string_field(object, "name"),
            arguments: string_field(object, "arguments"),
        },
        V3ResponsesSseOutputItemKind::CustomToolCall => V3ResponsesSseItemPayload::CustomToolCall {
            call_id: string_field(object, "call_id"),
            name: string_field(object, "name"),
            input: string_field(object, "input"),
        },
        _ => V3ResponsesSseItemPayload::StructuredExtensions(event_extensions(
            object,
            &["type", "id", "output_index", "status"],
        )),
    };
    let extensions = event_extensions(
        object,
        &[
            "type",
            "id",
            "output_index",
            "status",
            "text",
            "content",
            "summary",
            "call_id",
            "name",
            "arguments",
            "input",
        ],
    );
    Ok(V3ResponsesSseOutputItem {
        kind,
        identity: V3ResponsesSseItemIdentity {
            item_id: string_field(object, "id"),
            output_index: usize_field(object, "output_index"),
            status: string_field(object, "status"),
        },
        payload,
        extensions,
        rewritten_content: None,
    })
}

pub fn classify_v3_responses_sse_event(
    event: &Value,
) -> Result<V3ResponsesSseSemanticObject, V3ResponsesSseTreeError> {
    let metadata = V3ResponsesSseProtocolMetadata::from_event(event)?;
    let item_object = event
        .get("item")
        .filter(|value| !value.is_null())
        .map(classify_v3_responses_sse_output_item)
        .transpose()?;
    let item = item_object.as_ref().map(|item| item.kind());
    let content = match metadata.event_type.as_str() {
        "response.output_text.delta" | "response.output_text.done" => {
            Some(V3ResponsesSseContentKind::OutputText)
        }
        "response.refusal.delta" | "response.refusal.done" => {
            Some(V3ResponsesSseContentKind::Refusal)
        }
        "response.reasoning_text.delta" | "response.reasoning_text.done" => {
            Some(V3ResponsesSseContentKind::ReasoningText)
        }
        "response.reasoning_summary_text.delta" | "response.reasoning_summary_text.done" => {
            Some(V3ResponsesSseContentKind::ReasoningSummary)
        }
        "response.function_call_arguments.delta" | "response.function_call_arguments.done" => {
            Some(V3ResponsesSseContentKind::FunctionArguments)
        }
        "response.custom_tool_call_input.delta" | "response.custom_tool_call_input.done" => {
            Some(V3ResponsesSseContentKind::CustomToolInput)
        }
        _ => None,
    };
    let (content_field, content_value) =
        if let Some(value) = event.get("delta").and_then(Value::as_str) {
            (Some("delta".to_owned()), Some(value.to_owned()))
        } else if let Some(value) = event.get("text").and_then(Value::as_str) {
            (Some("text".to_owned()), Some(value.to_owned()))
        } else if let Some(value) = event.get("refusal").and_then(Value::as_str) {
            (Some("refusal".to_owned()), Some(value.to_owned()))
        } else {
            (None, None)
        };
    let extensions = event_extensions(
        event
            .as_object()
            .ok_or(V3ResponsesSseTreeError::EventNotObject)?,
        &[
            "type",
            "response_id",
            "output_index",
            "item_id",
            "content_index",
            "sequence_number",
            "item",
            "delta",
            "text",
            "refusal",
            "response",
        ],
    );
    Ok(V3ResponsesSseSemanticObject {
        item,
        content,
        item_object,
        protocol: metadata,
        content_value,
        content_field,
        response: event
            .get("response")
            .filter(|value| !value.is_null())
            .map(parse_response_container)
            .transpose()?,
        extensions,
    })
}

fn apply_typed_content_rewrite(
    item: &mut Value,
    kind: V3ResponsesSseOutputItemKind,
    rewritten: &str,
) {
    match kind {
        V3ResponsesSseOutputItemKind::OutputText => {
            if let Some(object) = item.as_object_mut() {
                object.insert("text".to_owned(), Value::String(rewritten.to_owned()));
            }
        }
        V3ResponsesSseOutputItemKind::FunctionCall => {
            if let Some(object) = item.as_object_mut() {
                object.insert("arguments".to_owned(), Value::String(rewritten.to_owned()));
            }
        }
        V3ResponsesSseOutputItemKind::CustomToolCall => {
            if let Some(object) = item.as_object_mut() {
                object.insert("input".to_owned(), Value::String(rewritten.to_owned()));
            }
        }
        V3ResponsesSseOutputItemKind::Message => {
            if let Some(content) = item.get_mut("content").and_then(Value::as_array_mut) {
                for part in content {
                    let Some(part_object) = part.as_object_mut() else {
                        continue;
                    };
                    if part_object.get("type").and_then(Value::as_str) == Some("refusal") {
                        part_object
                            .insert("refusal".to_owned(), Value::String(rewritten.to_owned()));
                        return;
                    }
                    if part_object.get("type").and_then(Value::as_str) == Some("output_text") {
                        part_object.insert("text".to_owned(), Value::String(rewritten.to_owned()));
                        return;
                    }
                }
            }
        }
        V3ResponsesSseOutputItemKind::Reasoning => {
            if let Some(summary) = item.get_mut("summary").and_then(Value::as_array_mut) {
                if let Some(summary_object) = summary.first_mut().and_then(Value::as_object_mut) {
                    summary_object.insert("text".to_owned(), Value::String(rewritten.to_owned()));
                }
            }
        }
        _ => {}
    }
}

fn parse_message_content(
    value: Option<&Value>,
) -> Result<Vec<V3ResponsesSseMessageContentPart>, V3ResponsesSseTreeError> {
    let Some(value) = value else {
        return Ok(Vec::new());
    };
    let parts = value
        .as_array()
        .ok_or(V3ResponsesSseTreeError::EventNotObject)?;
    parts.iter().map(parse_message_content_part).collect()
}

fn parse_message_content_part(
    value: &Value,
) -> Result<V3ResponsesSseMessageContentPart, V3ResponsesSseTreeError> {
    let object = value
        .as_object()
        .ok_or(V3ResponsesSseTreeError::EventNotObject)?;
    let part_type =
        string_field(object, "type").ok_or(V3ResponsesSseTreeError::MissingEventType)?;
    let extensions = event_extensions(object, &["type", "text", "refusal"]);
    Ok(V3ResponsesSseMessageContentPart {
        part_type,
        text: string_field(object, "text"),
        refusal: string_field(object, "refusal"),
        extensions,
    })
}

fn parse_reasoning_summary(
    value: Option<&Value>,
) -> Result<Vec<V3ResponsesSseReasoningSummary>, V3ResponsesSseTreeError> {
    let Some(value) = value else {
        return Ok(Vec::new());
    };
    let parts = value
        .as_array()
        .ok_or(V3ResponsesSseTreeError::EventNotObject)?;
    parts.iter().map(parse_reasoning_summary_part).collect()
}

fn parse_reasoning_summary_part(
    value: &Value,
) -> Result<V3ResponsesSseReasoningSummary, V3ResponsesSseTreeError> {
    let object = value
        .as_object()
        .ok_or(V3ResponsesSseTreeError::EventNotObject)?;
    Ok(V3ResponsesSseReasoningSummary {
        summary_type: string_field(object, "type")
            .ok_or(V3ResponsesSseTreeError::MissingEventType)?,
        text: string_field(object, "text"),
        extensions: event_extensions(object, &["type", "text"]),
    })
}

fn message_content_part_value(part: &V3ResponsesSseMessageContentPart) -> Value {
    let mut value = serde_json::Map::new();
    value.insert("type".to_owned(), Value::String(part.part_type.clone()));
    if let Some(text) = &part.text {
        value.insert("text".to_owned(), Value::String(text.clone()));
    }
    if let Some(refusal) = &part.refusal {
        value.insert("refusal".to_owned(), Value::String(refusal.clone()));
    }
    for extension in &part.extensions {
        value.insert(extension.name.clone(), extension.value.clone());
    }
    Value::Object(value)
}

fn reasoning_summary_value(summary: &V3ResponsesSseReasoningSummary) -> Value {
    let mut value = serde_json::Map::new();
    value.insert(
        "type".to_owned(),
        Value::String(summary.summary_type.clone()),
    );
    if let Some(text) = &summary.text {
        value.insert("text".to_owned(), Value::String(text.clone()));
    }
    for extension in &summary.extensions {
        value.insert(extension.name.clone(), extension.value.clone());
    }
    Value::Object(value)
}

pub fn rewrite_v3_responses_sse_content(
    mut item: V3ResponsesSseOutputItem,
    rewrite: V3ResponsesSseContentRewrite,
) -> Result<V3ResponsesSseOutputItem, V3ResponsesSseTreeError> {
    let compatible = match (&rewrite, item.kind) {
        (V3ResponsesSseContentRewrite::Text(_), V3ResponsesSseOutputItemKind::OutputText)
        | (V3ResponsesSseContentRewrite::Text(_), V3ResponsesSseOutputItemKind::Message)
        | (V3ResponsesSseContentRewrite::Refusal(_), V3ResponsesSseOutputItemKind::Message)
        | (V3ResponsesSseContentRewrite::Reasoning(_), V3ResponsesSseOutputItemKind::Reasoning)
        | (
            V3ResponsesSseContentRewrite::FunctionArguments(_),
            V3ResponsesSseOutputItemKind::FunctionCall,
        )
        | (
            V3ResponsesSseContentRewrite::CustomToolInput(_),
            V3ResponsesSseOutputItemKind::CustomToolCall,
        ) => true,
        _ => false,
    };
    if !compatible {
        let content = match rewrite {
            V3ResponsesSseContentRewrite::Text(_) | V3ResponsesSseContentRewrite::Refusal(_) => {
                "message"
            }
            V3ResponsesSseContentRewrite::Reasoning(_) => "reasoning",
            V3ResponsesSseContentRewrite::FunctionArguments(_) => "function_call",
            V3ResponsesSseContentRewrite::CustomToolInput(_) => "custom_tool_call",
        };
        return Err(V3ResponsesSseTreeError::IncompatibleContentRewrite {
            content: content.to_owned(),
            item_type: item.kind.to_string(),
        });
    }
    item.rewritten_content = Some(match rewrite {
        V3ResponsesSseContentRewrite::Text(value)
        | V3ResponsesSseContentRewrite::Refusal(value)
        | V3ResponsesSseContentRewrite::Reasoning(value)
        | V3ResponsesSseContentRewrite::FunctionArguments(value)
        | V3ResponsesSseContentRewrite::CustomToolInput(value) => value,
    });
    Ok(item)
}

pub fn project_v3_responses_sse_item_json(item: &V3ResponsesSseOutputItem) -> Value {
    item.to_normalized_value()
}

pub fn project_v3_responses_sse_item_sse(
    event_name: Option<String>,
    item: &V3ResponsesSseOutputItem,
) -> Result<Vec<u8>, V3ResponsesSseTreeError> {
    let data_json = serde_json::to_string(&project_v3_responses_sse_item_json(item))
        .map_err(|error| V3ResponsesSseTreeError::Projection(error.to_string()))?;
    crate::sse_object_pipeline::SseObjectFrame::from_event_json(event_name, data_json)
        .and_then(|object| object.encode_sse())
        .map_err(|error| V3ResponsesSseTreeError::Projection(error.to_string()))
}

pub fn project_v3_responses_sse_event_json(semantic: &V3ResponsesSseSemanticObject) -> Value {
    semantic.to_normalized_value()
}

pub fn project_v3_responses_sse_event_sse(
    event_name: Option<String>,
    semantic: &V3ResponsesSseSemanticObject,
) -> Result<Vec<u8>, V3ResponsesSseTreeError> {
    let data_json = serde_json::to_string(&project_v3_responses_sse_event_json(semantic))
        .map_err(|error| V3ResponsesSseTreeError::Projection(error.to_string()))?;
    crate::sse_object_pipeline::SseObjectFrame::from_event_json(event_name, data_json)
        .and_then(|object| object.encode_sse())
        .map_err(|error| V3ResponsesSseTreeError::Projection(error.to_string()))
}

fn string_field(object: &serde_json::Map<String, Value>, field: &str) -> Option<String> {
    object
        .get(field)
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
}

pub(crate) fn parse_response_container(
    response: &Value,
) -> Result<V3ResponsesSseResponseContainer, V3ResponsesSseTreeError> {
    let object = response
        .as_object()
        .ok_or(V3ResponsesSseTreeError::EventNotObject)?;
    let known = ["id", "status", "model", "output", "usage", "error"];
    let extensions = object
        .iter()
        .filter(|(name, _)| !known.contains(&name.as_str()))
        .map(|(name, value)| V3ResponsesSseExtension {
            name: name.clone(),
            value: value.clone(),
        })
        .collect();
    let usage = object
        .get("usage")
        .filter(|value| !value.is_null())
        .map(parse_usage)
        .transpose()?;
    let error = object
        .get("error")
        .filter(|value| !value.is_null())
        .map(parse_response_error)
        .transpose()?;
    let output = object
        .get("output")
        .filter(|value| !value.is_null())
        .map(|value| {
            value
                .as_array()
                .ok_or(V3ResponsesSseTreeError::OutputNotArray)?
                .iter()
                .map(classify_v3_responses_sse_output_item)
                .collect()
        })
        .transpose()?;
    Ok(V3ResponsesSseResponseContainer {
        id: string_field(object, "id"),
        status: string_field(object, "status"),
        model: string_field(object, "model"),
        output,
        usage,
        error,
        extensions,
    })
}

fn parse_usage(value: &Value) -> Result<V3ResponsesSseUsage, V3ResponsesSseTreeError> {
    let object = value
        .as_object()
        .ok_or(V3ResponsesSseTreeError::EventNotObject)?;
    let known = ["input_tokens", "output_tokens", "total_tokens"];
    let extensions = object
        .iter()
        .filter(|(name, _)| !known.contains(&name.as_str()))
        .map(|(name, value)| V3ResponsesSseExtension {
            name: name.clone(),
            value: value.clone(),
        })
        .collect();
    Ok(V3ResponsesSseUsage {
        input_tokens: object.get("input_tokens").and_then(Value::as_u64),
        output_tokens: object.get("output_tokens").and_then(Value::as_u64),
        total_tokens: object.get("total_tokens").and_then(Value::as_u64),
        extensions,
    })
}

fn parse_response_error(
    value: &Value,
) -> Result<V3ResponsesSseResponseError, V3ResponsesSseTreeError> {
    let object = value
        .as_object()
        .ok_or(V3ResponsesSseTreeError::EventNotObject)?;
    let known = ["type", "code", "message"];
    let extensions = object
        .iter()
        .filter(|(name, _)| !known.contains(&name.as_str()))
        .map(|(name, value)| V3ResponsesSseExtension {
            name: name.clone(),
            value: value.clone(),
        })
        .collect();
    Ok(V3ResponsesSseResponseError {
        error_type: string_field(object, "type"),
        code: string_field(object, "code"),
        message: string_field(object, "message"),
        extensions,
    })
}

fn event_extensions(
    object: &serde_json::Map<String, Value>,
    known: &[&str],
) -> Vec<V3ResponsesSseExtension> {
    object
        .iter()
        .filter(|(name, _)| !known.contains(&name.as_str()))
        .map(|(name, value)| V3ResponsesSseExtension {
            name: name.clone(),
            value: value.clone(),
        })
        .collect()
}

fn usize_field(object: &serde_json::Map<String, Value>, field: &str) -> Option<usize> {
    object
        .get(field)
        .and_then(Value::as_u64)
        .map(|value| value as usize)
}

fn u64_field(object: &serde_json::Map<String, Value>, field: &str) -> Option<u64> {
    object.get(field).and_then(Value::as_u64)
}

#[path = "responses_sse_tree_tests.rs"]
mod tests;
