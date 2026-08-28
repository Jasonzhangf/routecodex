use serde_json::{json, Value};

use crate::{classify_tool_call, RouteToolCallClassification};

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct V3CurrentTurnSignals {
    pub latest_message_from_user: bool,
    pub has_current_turn_tool_output: bool,
    pub has_current_turn_tool_execution_error: bool,
    pub is_compaction: bool,
    pub has_current_turn_web_search: bool,
    pub has_current_turn_image: bool,
    pub last_assistant_tool: Option<RouteToolCallClassification>,
    pub current_user_text: String,
}

// Typed current-turn entry carrier.
//
// vr.current_turn_typed_route_facts forbids the route classifier from reading
// raw request payload. This enum is the only input allowed into the typed
// builder; it carries only the structured facts that classify_route consumes
// (role, entry kind, image / web_search / tool flags, user text). It must not
// expose request business text, history beyond the current-turn segment, or
// response/SSE metadata carriers.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub enum V3CurrentTurnEntries {
    Chat(Vec<ChatTurnEntry>),
    Responses(Vec<ResponsesTurnEntry>),
    Gemini(Vec<GeminiTurnEntry>),
    PromptText(String),
    #[default]
    Empty,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ChatTurnEntry {
    pub role: ChatTurnRole,
    pub parts: Vec<TurnPart>,
    pub tool_calls: Vec<ChatToolCall>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ChatToolCall {
    pub name: String,
    pub arguments: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum ChatTurnRole {
    #[default]
    User,
    Assistant,
    Tool,
    System,
    Other,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ResponsesTurnEntry {
    pub role: ResponsesTurnRole,
    pub kind: ResponsesTurnKind,
    pub has_image: bool,
    pub has_web_search: bool,
    pub is_tool_output_error: bool,
    pub tool_call_category: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum ResponsesTurnRole {
    #[default]
    User,
    Assistant,
    Tool,
    System,
    Other,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum ResponsesTurnKind {
    #[default]
    Text,
    Image,
    WebSearch,
    ToolCall,
    ToolOutput,
    Compaction,
    Reasoning,
    Other,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct GeminiTurnEntry {
    pub role: GeminiTurnRole,
    pub parts: Vec<TurnPart>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum GeminiTurnRole {
    #[default]
    User,
    Assistant,
    Other,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct TurnPart {
    pub kind: TurnPartKind,
    pub has_image: bool,
    pub has_web_search: bool,
    pub text: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum TurnPartKind {
    #[default]
    Text,
    Image,
    WebSearch,
    ToolCall,
    ToolOutput,
    Other,
}

// Typed boundary builder. classify_route consumes V3CurrentTurnRouteFacts;
// this builder is the sole source of the typed intermediate that fills
// `has_image_attachment` / `has_current_turn_*` fields.
pub fn build_v3_current_turn_route_facts(entries: &V3CurrentTurnEntries) -> V3CurrentTurnSignals {
    match entries {
        V3CurrentTurnEntries::Chat(entries) => extract_chat_signals(entries),
        V3CurrentTurnEntries::Responses(entries) => extract_responses_signals(entries),
        V3CurrentTurnEntries::Gemini(entries) => extract_gemini_signals(entries),
        V3CurrentTurnEntries::PromptText(_) => V3CurrentTurnSignals {
            latest_message_from_user: true,
            ..Default::default()
        },
        V3CurrentTurnEntries::Empty => V3CurrentTurnSignals::default(),
    }
}

fn extract_chat_signals(entries: &[ChatTurnEntry]) -> V3CurrentTurnSignals {
    let latest_role = entries.iter().rev().map(|entry| entry.role).next();
    let latest_user_index = entries.iter().rposition(|entry| matches!(entry.role, ChatTurnRole::User));
    let Some(segment) = chat_active_segment(entries, latest_user_index, latest_role) else {
        let latest_user = latest_user_index.and_then(|index| entries.get(index));
        return V3CurrentTurnSignals {
            latest_message_from_user: matches!(latest_role, Some(ChatTurnRole::User)),
            current_user_text: latest_user.map(extract_chat_user_text).unwrap_or_default(),
            has_current_turn_web_search: latest_user
                .is_some_and(|entry| entry.parts.iter().any(|part| part.has_web_search)),
            has_current_turn_image: latest_user
                .is_some_and(|entry| entry.parts.iter().any(|part| part.has_image)),
            ..Default::default()
        };
    };
    let mut has_current_turn_tool_output = false;
    let mut has_current_turn_tool_execution_error = false;
    let mut has_current_turn_web_search = false;
    let mut has_current_turn_image = latest_user_index
        .and_then(|index| entries.get(index))
        .is_some_and(|entry| entry.parts.iter().any(|part| part.has_image));
    let mut last_assistant_tool = None;
    for entry in segment {
        for part in &entry.parts {
            if part.has_image {
                has_current_turn_image = true;
            }
            if part.has_web_search {
                has_current_turn_web_search = true;
            }
            match entry.role {
                ChatTurnRole::Tool => {
                    has_current_turn_tool_output = true;
                    if part.kind == TurnPartKind::ToolOutput && part.text == "error" {
                        has_current_turn_tool_execution_error = true;
                    }
                }
                _ => {}
            }
        }
        if matches!(entry.role, ChatTurnRole::Assistant) {
            for call in &entry.tool_calls {
                has_current_turn_tool_output = true;
                let arguments = call
                    .arguments
                    .as_deref()
                    .and_then(|raw| serde_json::from_str::<Value>(raw).ok());
                if let Some(classification) = classify_tool_call(&call.name, arguments.as_ref()) {
                    last_assistant_tool = Some(classification);
                }
            }
        }
    }
    V3CurrentTurnSignals {
        latest_message_from_user: matches!(latest_role, Some(ChatTurnRole::User)),
        current_user_text: String::new(),
        has_current_turn_tool_output,
        has_current_turn_tool_execution_error,
        is_compaction: false,
        has_current_turn_web_search,
        has_current_turn_image,
        last_assistant_tool,
    }
}

fn extract_responses_signals(entries: &[ResponsesTurnEntry]) -> V3CurrentTurnSignals {
    let latest_role = entries.iter().rev().map(|entry| entry.role).next();
    let latest_user_index = entries
        .iter()
        .rposition(|entry| matches!(entry.role, ResponsesTurnRole::User));
    let Some(segment) = responses_active_segment(entries, latest_user_index, latest_role) else {
        let current_turn_start = latest_user_index
            .map(|index| {
                entries[..index]
                    .iter()
                    .rposition(|entry| matches!(entry.role, ResponsesTurnRole::User))
                    .map(|previous| previous + 1)
                    .unwrap_or(0)
            })
            .unwrap_or(0);
        return V3CurrentTurnSignals {
            latest_message_from_user: matches!(latest_role, Some(ResponsesTurnRole::User)),
            current_user_text: String::new(),
            is_compaction: latest_user_index.is_some_and(|index| {
                entries[index..].iter().any(|entry| entry.kind == ResponsesTurnKind::Compaction)
            }),
            has_current_turn_web_search: latest_user_index.is_some_and(|index| {
                entries[current_turn_start..=index]
                    .iter()
                    .any(|entry| entry.has_web_search)
            }),
            has_current_turn_image: latest_user_index.is_some_and(|index| {
                entries[current_turn_start..=index].iter().any(|entry| entry.has_image)
            }),
            ..Default::default()
        };
    };
    let mut has_current_turn_tool_output = false;
    let mut has_current_turn_tool_execution_error = false;
    let mut is_compaction = false;
    let mut has_current_turn_web_search = false;
    let mut has_current_turn_image = latest_user_index
        .is_some_and(|index| entries[index..].iter().any(|entry| entry.has_image));
    let mut last_assistant_tool = None;
    for entry in segment {
        if entry.has_image {
            has_current_turn_image = true;
        }
        if entry.has_web_search {
            has_current_turn_web_search = true;
        }
        if entry.kind == ResponsesTurnKind::Compaction {
            is_compaction = true;
        }
        if matches!(
            entry.kind,
            ResponsesTurnKind::ToolCall | ResponsesTurnKind::WebSearch
        ) {
            has_current_turn_tool_output = true;
            if let Some(category) = &entry.tool_call_category {
                last_assistant_tool = classify_category(category);
            }
            continue;
        }
        if matches!(entry.kind, ResponsesTurnKind::ToolOutput) {
            has_current_turn_tool_output = true;
            if entry.is_tool_output_error {
                has_current_turn_tool_execution_error = true;
            }
            continue;
        }
        if entry.role != ResponsesTurnRole::Assistant {
            continue;
        }
        if let Some(category) = &entry.tool_call_category {
            has_current_turn_tool_output = true;
            last_assistant_tool = classify_category(category);
        }
    }
    V3CurrentTurnSignals {
        latest_message_from_user: matches!(latest_role, Some(ResponsesTurnRole::User)),
        current_user_text: String::new(),
        has_current_turn_tool_output,
        has_current_turn_tool_execution_error,
        is_compaction,
        has_current_turn_web_search,
        has_current_turn_image,
        last_assistant_tool,
    }
}

fn extract_gemini_signals(entries: &[GeminiTurnEntry]) -> V3CurrentTurnSignals {
    let latest_role = entries.iter().rev().map(|entry| entry.role).next();
    let latest_user_index = entries.iter().rposition(|entry| matches!(entry.role, GeminiTurnRole::User));
    let segment_start = latest_user_index.unwrap_or(0);
    let mut has_current_turn_image = false;
    let mut has_current_turn_web_search = false;
    for entry in entries.iter().skip(segment_start) {
        for part in &entry.parts {
            if part.has_image {
                has_current_turn_image = true;
            }
            if part.has_web_search {
                has_current_turn_web_search = true;
            }
        }
    }
    V3CurrentTurnSignals {
        latest_message_from_user: matches!(latest_role, Some(GeminiTurnRole::User)),
        has_current_turn_image,
        has_current_turn_web_search,
        ..Default::default()
    }
}

fn chat_active_segment<'a>(
    entries: &'a [ChatTurnEntry],
    latest_user_index: Option<usize>,
    latest_role: Option<ChatTurnRole>,
) -> Option<&'a [ChatTurnEntry]> {
    if matches!(latest_role, Some(ChatTurnRole::User)) {
        return None;
    }
    let start = latest_user_index.map(|index| index + 1).unwrap_or(0);
    Some(&entries[start..])
}

fn responses_active_segment<'a>(
    entries: &'a [ResponsesTurnEntry],
    latest_user_index: Option<usize>,
    latest_role: Option<ResponsesTurnRole>,
) -> Option<&'a [ResponsesTurnEntry]> {
    if matches!(latest_role, Some(ResponsesTurnRole::User)) {
        return None;
    }
    let start = latest_user_index.map(|index| index + 1).unwrap_or(0);
    Some(&entries[start..])
}

fn extract_chat_user_text(entry: &ChatTurnEntry) -> String {
    entry
        .parts
        .iter()
        .find(|part| part.kind == TurnPartKind::Text)
        .map(|part| part.text.clone())
        .unwrap_or_default()
}

fn classify_category(category: &str) -> Option<RouteToolCallClassification> {
    if matches!(
        category,
        "thinking" | "coding" | "search" | "websearch" | "other"
    ) {
        Some(RouteToolCallClassification {
            category: category.to_string(),
            name: String::new(),
            snippet: None,
        })
    } else {
        None
    }
}

// Thin shim that callers using raw `&Value` (e.g. legacy nodes.rs paths)
// must route through. This is the single place that converts raw request
// payload into typed entries; downstream code must only consume the typed
// result, never re-read raw payload.
pub fn build_v3_current_turn_route_facts_from_value(request: &Value) -> V3CurrentTurnSignals {
    let entries = project_v3_current_turn_entries_from_value(request);
    build_v3_current_turn_route_facts(&entries)
}

pub fn project_v3_current_turn_entries_from_value(request: &Value) -> V3CurrentTurnEntries {
    if let Some(messages) = request.get("messages").and_then(value_as_array) {
        if !messages.is_empty() {
            return V3CurrentTurnEntries::Chat(project_chat_entries(&messages));
        }
    }
    if let Some(input) = request.get("input") {
        let entries = project_responses_entries(input);
        if !entries.is_empty() {
            return V3CurrentTurnEntries::Responses(entries);
        }
    }
    if let Some(contents) = request.get("contents").and_then(value_as_array) {
        if !contents.is_empty() {
            return V3CurrentTurnEntries::Gemini(project_gemini_entries(&contents));
        }
    }
    if let Some(prompt) = request
        .get("prompt")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())
    {
        return V3CurrentTurnEntries::PromptText(prompt.to_string());
    }
    if let Some(input) = request
        .pointer("/semantics/responses/context/input")
        .and_then(value_as_array)
    {
        if !input.is_empty() {
            return V3CurrentTurnEntries::Responses(project_responses_entries_from_array(&input));
        }
    }
    V3CurrentTurnEntries::Empty
}

fn project_chat_entries(messages: &[Value]) -> Vec<ChatTurnEntry> {
    messages
        .iter()
        .map(|message| ChatTurnEntry {
            role: chat_role(message.get("role").and_then(Value::as_str)),
            parts: project_chat_parts(message.get("content")),
            tool_calls: project_chat_tool_calls(message.get("tool_calls")),
        })
        .collect()
}

fn project_chat_tool_calls(value: Option<&Value>) -> Vec<ChatToolCall> {
    let Some(items) = value.and_then(Value::as_array) else {
        return Vec::new();
    };
    items
        .iter()
        .map(|item| ChatToolCall {
            name: item
                .pointer("/function/name")
                .or_else(|| item.get("name"))
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            arguments: item
                .pointer("/function/arguments")
                .or_else(|| item.get("arguments"))
                .or_else(|| item.get("input"))
                .map(|value| value.to_string()),
        })
        .collect()
}

fn chat_role(role: Option<&str>) -> ChatTurnRole {
    match role.map(|value| value.trim().to_ascii_lowercase()).as_deref() {
        Some("user") => ChatTurnRole::User,
        Some("assistant") => ChatTurnRole::Assistant,
        Some("tool") => ChatTurnRole::Tool,
        Some("system") => ChatTurnRole::System,
        _ => ChatTurnRole::Other,
    }
}

fn project_chat_parts(value: Option<&Value>) -> Vec<TurnPart> {
    let Some(value) = value else { return Vec::new() };
    match value {
        Value::String(text) => vec![TurnPart {
            kind: TurnPartKind::Text,
            text: text.clone(),
            ..Default::default()
        }],
        Value::Array(items) => items.iter().map(project_chat_part).collect(),
        _ => Vec::new(),
    }
}

fn project_chat_part(value: &Value) -> TurnPart {
    let mut part = TurnPart::default();
    if let Some(obj) = value.as_object() {
        let type_value = obj
            .get("type")
            .and_then(Value::as_str)
            .map(|value| value.trim().to_ascii_lowercase())
            .unwrap_or_default();
        if type_value.contains("image") {
            part.kind = TurnPartKind::Image;
            part.has_image = true;
        }
        if type_value == "web_search" || type_value == "websearch" {
            part.kind = TurnPartKind::WebSearch;
            part.has_web_search = true;
        }
        if matches!(type_value.as_str(), "tool_call" | "tool_use" | "function_call") {
            part.kind = TurnPartKind::ToolCall;
        }
        if matches!(type_value.as_str(), "tool_result" | "tool_output" | "function_call_output") {
            part.kind = TurnPartKind::ToolOutput;
        }
        if part.kind == TurnPartKind::Text || part.kind == TurnPartKind::Other {
            if let Some(text) = obj.get("text").and_then(Value::as_str) {
                part.text = text.to_string();
            }
        }
    }
    if !part.has_image && value_contains_image(value) {
        part.has_image = true;
        if part.kind == TurnPartKind::Text {
            part.kind = TurnPartKind::Image;
        }
    }
    part
}

fn project_responses_entries(value: &Value) -> Vec<ResponsesTurnEntry> {
    let items = match value {
        Value::Array(items) => items.clone(),
        Value::String(text) if !text.trim().is_empty() => vec![json!({"type": "input_text", "text": text})],
        _ => return Vec::new(),
    };
    project_responses_entries_from_array(&items)
}

pub fn project_responses_entries_from_array(items: &[Value]) -> Vec<ResponsesTurnEntry> {
    items.iter().map(project_responses_entry).collect()
}

fn project_responses_entry(value: &Value) -> ResponsesTurnEntry {
    let mut entry = ResponsesTurnEntry::default();
    let role = responses_role_for_value(value);
    entry.role = role;
    let kind = responses_kind_for_value(value);
    entry.kind = kind;
    entry.has_image = value_contains_image(value);
    entry.has_web_search = responses_entry_has_web_search(value);
    entry.is_tool_output_error = matches!(kind, ResponsesTurnKind::ToolOutput)
        && tool_output_is_error(value);
    if matches!(
        kind,
        ResponsesTurnKind::ToolCall | ResponsesTurnKind::WebSearch
    ) {
        if let Some(category) = tool_category_from_call_value(value) {
            entry.tool_call_category = Some(category);
        }
    }
    entry
}

fn responses_role_for_value(value: &Value) -> ResponsesTurnRole {
    if let Some(role) = value.get("role").and_then(Value::as_str) {
        return match role.trim().to_ascii_lowercase().as_str() {
            "user" => ResponsesTurnRole::User,
            "assistant" => ResponsesTurnRole::Assistant,
            "tool" => ResponsesTurnRole::Tool,
            "system" => ResponsesTurnRole::System,
            _ => ResponsesTurnRole::Other,
        };
    }
    let kind = responses_kind_for_value(value);
    match kind {
        ResponsesTurnKind::Text | ResponsesTurnKind::Image => ResponsesTurnRole::User,
        ResponsesTurnKind::WebSearch | ResponsesTurnKind::ToolCall | ResponsesTurnKind::Reasoning => {
            ResponsesTurnRole::Assistant
        }
        ResponsesTurnKind::ToolOutput => ResponsesTurnRole::Tool,
        _ => ResponsesTurnRole::Other,
    }
}

fn responses_kind_for_value(value: &Value) -> ResponsesTurnKind {
    let type_value = value
        .get("type")
        .and_then(Value::as_str)
        .map(|value| value.trim().to_ascii_lowercase())
        .unwrap_or_default();
    if type_value == "image" || type_value.contains("input_image") || type_value.contains("output_image") {
        return ResponsesTurnKind::Image;
    }
    if type_value == "input_text" || type_value == "output_text" || type_value == "text" {
        return ResponsesTurnKind::Text;
    }
    if type_value == "web_search_call" || type_value == "websearch_call" {
        return ResponsesTurnKind::WebSearch;
    }
    if matches!(
        type_value.as_str(),
        "function_call" | "tool_call" | "custom_tool_call"
    ) {
        return ResponsesTurnKind::ToolCall;
    }
    if matches!(
        type_value.as_str(),
        "function_call_output" | "tool_call_output" | "custom_tool_call_output"
    ) {
        return ResponsesTurnKind::ToolOutput;
    }
    if type_value == "compaction" {
        return ResponsesTurnKind::Compaction;
    }
    if type_value == "reasoning" {
        return ResponsesTurnKind::Reasoning;
    }
    ResponsesTurnKind::Other
}

fn responses_entry_has_web_search(value: &Value) -> bool {
    let type_value = value
        .get("type")
        .and_then(Value::as_str)
        .map(|value| value.trim().to_ascii_lowercase())
        .unwrap_or_default();
    // web_search_call is a tool-call type; web_search_part inside content[] is the route fact.
    matches!(type_value.as_str(), "web_search" | "websearch")
}

fn tool_output_is_error(value: &Value) -> bool {
    value
        .get("output")
        .and_then(|output| output.get("is_error"))
        .and_then(Value::as_bool)
        .unwrap_or(false)
        || value
            .get("is_error")
            .and_then(Value::as_bool)
            .unwrap_or(false)
}

fn tool_category_from_call_value(value: &Value) -> Option<String> {
    let entry_type = value
        .get("type")
        .and_then(Value::as_str)
        .map(|value| value.trim().to_ascii_lowercase())
        .unwrap_or_default();
    let name = value
        .pointer("/function/name")
        .or_else(|| value.get("name"))
        .and_then(Value::as_str)
        .or_else(|| (entry_type == "web_search_call").then_some("web_search"))?;
    let arguments = value
        .pointer("/function/arguments")
        .or_else(|| value.get("arguments"))
        .or_else(|| value.get("input"));
    if let Some(classification) = classify_tool_call(name, arguments) {
        return Some(classification.category);
    }
    None
}

fn project_gemini_entries(contents: &[Value]) -> Vec<GeminiTurnEntry> {
    contents
        .iter()
        .map(|content| GeminiTurnEntry {
            role: match content.get("role").and_then(Value::as_str) {
                Some("user") => GeminiTurnRole::User,
                Some("model") => GeminiTurnRole::Assistant,
                _ => GeminiTurnRole::Other,
            },
            parts: project_chat_parts(content.get("parts")),
        })
        .collect()
}

fn value_as_array(value: &Value) -> Option<Vec<Value>> {
    if let Some(items) = value.as_array() {
        return Some(items.clone());
    }
    let raw = value.as_str()?.trim();
    if raw.is_empty() {
        return None;
    }
    serde_json::from_str::<Value>(raw)
        .ok()
        .and_then(|parsed| parsed.as_array().cloned())
}

fn value_contains_image(value: &Value) -> bool {
    match value {
        Value::Array(items) => items.iter().any(value_contains_image),
        Value::Object(values) => {
            let type_value = values
                .get("type")
                .and_then(Value::as_str)
                .map(|value| value.trim().to_ascii_lowercase())
                .unwrap_or_default();
            if type_value.contains("image") {
                return true;
            }
            if values.contains_key("image_url") {
                return true;
            }
            if values.contains_key("inline_data") || values.contains_key("file_data") {
                return true;
            }
            if values
                .get("data")
                .and_then(Value::as_str)
                .map(|value| value.trim().to_ascii_lowercase())
                .is_some_and(|value| value.starts_with("data:image/"))
            {
                return true;
            }
            ["content", "parts"]
                .into_iter()
                .filter_map(|field| values.get(field))
                .any(value_contains_image)
        }
        _ => false,
    }
}
