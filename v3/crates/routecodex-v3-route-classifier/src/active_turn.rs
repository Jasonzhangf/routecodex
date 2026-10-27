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
    /// Every independent tool category observed in the current turn. The
    /// single `last_assistant_tool` still serves existing consumers that need
    /// the most recent call, but route classification must see them all so a
    /// later lower-priority call cannot shadow an earlier higher-priority one.
    pub current_turn_tool_categories: Vec<String>,
    pub current_user_text: String,
}

// Typed current-turn entry carrier.
//
// vr.current_turn_typed_route_facts forbids the route classifier from reading
// raw request payload. This enum is the only input allowed into the typed
// builder; it carries only the structured facts that classify_route consumes
// (role, entry kind, image / web_search / tool flags, current user text). It
// must not expose raw payloads, history beyond the current-turn segment, or
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
    pub text: String,
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
    Tool,
    Other,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct TurnPart {
    pub kind: TurnPartKind,
    pub has_image: bool,
    pub has_web_search: bool,
    pub text: String,
    pub tool_name: String,
    pub tool_arguments: Option<String>,
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
    let latest_user_index = entries
        .iter()
        .rposition(|entry| matches!(entry.role, ChatTurnRole::User));
    let current_user_start = latest_user_index
        .map(|index| chat_current_user_run_start(entries, index))
        .unwrap_or(0);
    let tool_start = if matches!(latest_role, Some(ChatTurnRole::User)) {
        entries.len()
    } else {
        latest_user_index.map(|index| index + 1).unwrap_or(0)
    };
    let mut has_current_turn_tool_output = false;
    let mut has_current_turn_tool_execution_error = false;
    let mut has_current_turn_web_search = false;
    let mut last_assistant_tool = None;
    let mut current_turn_tool_categories = Vec::new();
    for entry in &entries[current_user_start..] {
        if entry.parts.iter().any(|part| part.has_web_search) {
            has_current_turn_web_search = true;
        }
    }
    for entry in &entries[tool_start..] {
        for part in &entry.parts {
            if matches!(entry.role, ChatTurnRole::Assistant) && part.kind == TurnPartKind::ToolCall
            {
                has_current_turn_tool_output = true;
                if !part.tool_name.is_empty() {
                    let arguments = part
                        .tool_arguments
                        .as_deref()
                        .and_then(|raw| serde_json::from_str::<Value>(raw).ok());
                    if let Some(classification) =
                        classify_tool_call(&part.tool_name, arguments.as_ref())
                    {
                        push_tool_category(
                            &mut current_turn_tool_categories,
                            &classification.category,
                        );
                        last_assistant_tool = Some(classification);
                    }
                }
            }
            if matches!(entry.role, ChatTurnRole::Tool) {
                has_current_turn_tool_output = true;
                if part.kind == TurnPartKind::ToolOutput && part.text == "error" {
                    has_current_turn_tool_execution_error = true;
                }
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
                    push_tool_category(&mut current_turn_tool_categories, &classification.category);
                    last_assistant_tool = Some(classification);
                }
            }
        }
    }
    let current_user_text = latest_user_index
        .map(|index| {
            entries[chat_current_user_run_start(entries, index)..=index]
                .iter()
                .rev()
                .map(extract_chat_user_text)
                .find(|text| !text.is_empty())
                .unwrap_or_default()
        })
        .unwrap_or_default();
    V3CurrentTurnSignals {
        latest_message_from_user: matches!(latest_role, Some(ChatTurnRole::User)),
        current_user_text,
        has_current_turn_tool_output,
        has_current_turn_tool_execution_error,
        is_compaction: false,
        has_current_turn_web_search,
        has_current_turn_image: entries[current_user_start..]
            .iter()
            .any(|entry| entry.parts.iter().any(|part| part.has_image)),
        last_assistant_tool,
        current_turn_tool_categories,
    }
}

fn extract_responses_signals(entries: &[ResponsesTurnEntry]) -> V3CurrentTurnSignals {
    let latest_role = entries.iter().rev().map(|entry| entry.role).next();
    let latest_user_index = entries
        .iter()
        .rposition(|entry| matches!(entry.role, ResponsesTurnRole::User));
    let current_turn_start = latest_user_index
        .map(|index| responses_current_user_run_start(entries, index))
        .unwrap_or(0);
    let tool_start = if matches!(latest_role, Some(ResponsesTurnRole::User)) {
        entries.len()
    } else {
        latest_user_index.map(|index| index + 1).unwrap_or(0)
    };
    let mut has_current_turn_tool_output = false;
    let mut has_current_turn_tool_execution_error = false;
    let mut is_compaction = false;
    let mut has_current_turn_web_search = false;
    let mut last_assistant_tool = None;
    let mut current_turn_tool_categories = Vec::new();
    let current_user_text = if matches!(latest_role, Some(ResponsesTurnRole::User)) {
        latest_user_index
            .map(|index| {
                let start = responses_current_user_run_start(entries, index);
                entries[start..=index]
                    .iter()
                    .filter(|entry| entry.role == ResponsesTurnRole::User)
                    .map(|entry| entry.text.as_str())
                    .filter(|text| !text.is_empty())
                    .collect::<Vec<_>>()
                    .join("\n")
            })
            .unwrap_or_default()
    } else {
        String::new()
    };
    for entry in &entries[current_turn_start..] {
        if entry.has_web_search {
            has_current_turn_web_search = true;
        }
        if entry.kind == ResponsesTurnKind::Compaction {
            is_compaction = true;
        }
    }
    for entry in &entries[tool_start..] {
        if matches!(
            entry.kind,
            ResponsesTurnKind::ToolCall | ResponsesTurnKind::WebSearch
        ) {
            has_current_turn_tool_output = true;
            if let Some(category) = &entry.tool_call_category {
                if let Some(classification) = classify_category(category) {
                    push_tool_category(&mut current_turn_tool_categories, &classification.category);
                    last_assistant_tool = Some(classification);
                }
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
            if let Some(classification) = classify_category(category) {
                push_tool_category(&mut current_turn_tool_categories, &classification.category);
                last_assistant_tool = Some(classification);
            }
        }
    }
    V3CurrentTurnSignals {
        latest_message_from_user: matches!(latest_role, Some(ResponsesTurnRole::User)),
        current_user_text,
        has_current_turn_tool_output,
        has_current_turn_tool_execution_error,
        is_compaction,
        has_current_turn_web_search,
        has_current_turn_image: entries[current_turn_start..]
            .iter()
            .any(|entry| entry.has_image),
        last_assistant_tool,
        current_turn_tool_categories,
    }
}

fn extract_gemini_signals(entries: &[GeminiTurnEntry]) -> V3CurrentTurnSignals {
    let latest_role = entries.iter().rev().map(|entry| entry.role).next();
    let latest_user_index = entries
        .iter()
        .rposition(|entry| matches!(entry.role, GeminiTurnRole::User));
    let current_turn_start = latest_user_index.unwrap_or(0);
    let latest_user = latest_user_index.and_then(|index| entries.get(index));
    let mut has_current_turn_image = false;
    let mut has_current_turn_tool_output = false;
    let mut has_current_turn_web_search = false;
    let mut last_assistant_tool = None;
    let mut current_turn_tool_categories = Vec::new();
    for entry in entries.iter().skip(current_turn_start) {
        for part in &entry.parts {
            has_current_turn_image |= part.has_image;
            if part.has_web_search {
                has_current_turn_web_search = true;
            }
            if matches!(part.kind, TurnPartKind::ToolCall | TurnPartKind::ToolOutput) {
                has_current_turn_tool_output = true;
            }
            if part.kind == TurnPartKind::ToolCall && !part.tool_name.is_empty() {
                let arguments = part
                    .tool_arguments
                    .as_deref()
                    .and_then(|raw| serde_json::from_str::<Value>(raw).ok());
                if let Some(classification) =
                    classify_tool_call(&part.tool_name, arguments.as_ref())
                {
                    push_tool_category(&mut current_turn_tool_categories, &classification.category);
                    last_assistant_tool = Some(classification);
                }
            }
        }
    }
    V3CurrentTurnSignals {
        latest_message_from_user: matches!(latest_role, Some(GeminiTurnRole::User)),
        has_current_turn_tool_output,
        has_current_turn_web_search,
        has_current_turn_image,
        last_assistant_tool,
        current_turn_tool_categories,
        current_user_text: latest_user
            .map(|entry| {
                entry
                    .parts
                    .iter()
                    .find(|part| part.kind == TurnPartKind::Text)
                    .map(|part| part.text.clone())
                    .unwrap_or_default()
            })
            .unwrap_or_default(),
        ..Default::default()
    }
}

fn chat_current_user_run_start(entries: &[ChatTurnEntry], latest_user_index: usize) -> usize {
    let mut start = latest_user_index;
    while start > 0 && matches!(entries[start - 1].role, ChatTurnRole::User) {
        start -= 1;
    }
    start
}

fn responses_current_user_run_start(
    entries: &[ResponsesTurnEntry],
    latest_user_index: usize,
) -> usize {
    // An explicit message is the current-turn boundary when an earlier user
    // carrier exists. Its nested content is already represented by the message
    // entry; never inherit image facts from preceding history/tool output.
    if entries[latest_user_index].kind == ResponsesTurnKind::Other {
        return if entries[..latest_user_index]
            .iter()
            .any(|entry| entry.role == ResponsesTurnRole::User)
        {
            latest_user_index
        } else {
            0
        };
    }
    let mut start = latest_user_index;
    while start > 0 {
        let previous = &entries[start - 1];
        if previous.role != ResponsesTurnRole::User || previous.kind == ResponsesTurnKind::Other {
            break;
        }
        start -= 1;
    }
    start
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

fn push_tool_category(categories: &mut Vec<String>, category: &str) {
    if !category.is_empty() && !categories.iter().any(|existing| existing == category) {
        categories.push(category.to_string());
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
            parts: project_chat_parts(
                message.get("content"),
                message.get("role").and_then(Value::as_str) == Some("tool"),
            ),
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
    match role
        .map(|value| value.trim().to_ascii_lowercase())
        .as_deref()
    {
        Some("user") => ChatTurnRole::User,
        Some("assistant") => ChatTurnRole::Assistant,
        Some("tool") => ChatTurnRole::Tool,
        Some("system") => ChatTurnRole::System,
        _ => ChatTurnRole::Other,
    }
}

fn project_chat_parts(value: Option<&Value>, tool_output: bool) -> Vec<TurnPart> {
    let Some(value) = value else {
        return Vec::new();
    };
    match value {
        Value::String(text) => vec![TurnPart {
            kind: TurnPartKind::Text,
            text: text.clone(),
            has_image: tool_output && string_carries_image(text),
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
        let function_call = obj.get("functionCall").or_else(|| obj.get("function_call"));
        let function_response = obj
            .get("functionResponse")
            .or_else(|| obj.get("function_response"));
        if type_value.contains("image") {
            part.kind = TurnPartKind::Image;
            part.has_image = true;
        }
        if type_value == "web_search" || type_value == "websearch" {
            part.kind = TurnPartKind::WebSearch;
            part.has_web_search = true;
        }
        if matches!(
            type_value.as_str(),
            "tool_call" | "tool_use" | "function_call" | "functioncall"
        ) || function_call.is_some()
        {
            part.kind = TurnPartKind::ToolCall;
        }
        if matches!(
            type_value.as_str(),
            "tool_result"
                | "tool_output"
                | "function_call_output"
                | "function_response"
                | "functionresponse"
        ) || function_response.is_some()
        {
            part.kind = TurnPartKind::ToolOutput;
        }
        if part.kind == TurnPartKind::Text || part.kind == TurnPartKind::Other {
            if let Some(text) = obj.get("text").and_then(Value::as_str) {
                part.text = text.to_string();
            }
        }
        if part.kind == TurnPartKind::ToolCall {
            let call = function_call.unwrap_or(value);
            part.tool_name = call
                .get("name")
                .or_else(|| call.pointer("/function/name"))
                .or_else(|| obj.get("name"))
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            part.tool_arguments = ["args", "arguments", "input"]
                .into_iter()
                .find_map(|field| call.get(field))
                .map(Value::to_string);
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
        Value::String(text) if !text.trim().is_empty() => {
            vec![json!({"type": "input_text", "text": text})]
        }
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
    entry.is_tool_output_error =
        matches!(kind, ResponsesTurnKind::ToolOutput) && tool_output_is_error(value);
    if role == ResponsesTurnRole::User
        && !matches!(
            kind,
            ResponsesTurnKind::ToolCall
                | ResponsesTurnKind::ToolOutput
                | ResponsesTurnKind::WebSearch
        )
    {
        entry.text = responses_user_text(value);
    }
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
        ResponsesTurnKind::WebSearch
        | ResponsesTurnKind::ToolCall
        | ResponsesTurnKind::Reasoning => ResponsesTurnRole::Assistant,
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
    if type_value == "image"
        || type_value.contains("input_image")
        || type_value.contains("output_image")
    {
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
    if matches!(type_value.as_str(), "web_search" | "websearch") {
        return true;
    }
    // web_search_call is a tool-call type; a web_search part inside content[]
    // is the user-level route fact.
    value.get("content").is_some_and(contains_web_search_part)
}

fn contains_web_search_part(value: &Value) -> bool {
    match value {
        Value::Array(items) => items.iter().any(contains_web_search_part),
        Value::Object(values) => {
            let type_value = values
                .get("type")
                .and_then(Value::as_str)
                .map(|value| value.trim().to_ascii_lowercase())
                .unwrap_or_default();
            if matches!(type_value.as_str(), "web_search" | "websearch") {
                return true;
            }
            ["content", "parts"]
                .into_iter()
                .filter_map(|field| values.get(field))
                .any(contains_web_search_part)
        }
        _ => false,
    }
}

fn responses_user_text(value: &Value) -> String {
    let mut parts = Vec::new();
    collect_responses_text(value.get("content").unwrap_or(value), &mut parts);
    parts.join("\n")
}

fn collect_responses_text(value: &Value, out: &mut Vec<String>) {
    match value {
        Value::String(text) => {
            let text = text.trim();
            if !text.is_empty() {
                out.push(text.to_string());
            }
        }
        Value::Array(items) => {
            for item in items {
                collect_responses_text(item, out);
            }
        }
        Value::Object(values) => {
            if let Some(text) = values.get("text").and_then(Value::as_str) {
                let text = text.trim();
                if !text.is_empty() {
                    out.push(text.to_string());
                }
            }
            if let Some(content) = values.get("content") {
                collect_responses_text(content, out);
            }
        }
        _ => {}
    }
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
        .map(|content| {
            let parts = project_chat_parts(content.get("parts"), false);
            let role = match content.get("role").and_then(Value::as_str) {
                Some("user")
                    if parts
                        .iter()
                        .any(|part| part.kind == TurnPartKind::ToolOutput) =>
                {
                    GeminiTurnRole::Tool
                }
                Some("user") => GeminiTurnRole::User,
                Some("model") => GeminiTurnRole::Assistant,
                _ => GeminiTurnRole::Other,
            };
            GeminiTurnEntry { role, parts }
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
        Value::String(_) => false,
        Value::Object(values) => {
            let type_value = values
                .get("type")
                .and_then(Value::as_str)
                .map(|value| value.trim().to_ascii_lowercase())
                .unwrap_or_default();
            if matches!(type_value.as_str(), "text" | "input_text" | "output_text") {
                return false;
            }
            if type_value.contains("image") {
                return true;
            }
            if values.contains_key("image_url") {
                return true;
            }
            if values.contains_key("inline_data")
                || values.contains_key("file_data")
                || values.contains_key("inlineData")
                || values.contains_key("fileData")
            {
                return true;
            }
            if values
                .get("data")
                .or_else(|| values.get("file_url"))
                .and_then(Value::as_str)
                .is_some_and(is_v3_inline_image_reference)
            {
                return true;
            }
            // Only a tool-output carrier may encode image parts as JSON text
            // or a bare reference. Native message strings remain ordinary text.
            if matches!(
                type_value.as_str(),
                "function_call_output"
                    | "tool_call_output"
                    | "custom_tool_call_output"
                    | "tool_result"
                    | "tool_output"
            ) && ["content", "output"]
                .into_iter()
                .filter_map(|field| values.get(field))
                .filter_map(Value::as_str)
                .any(string_carries_image)
            {
                return true;
            }
            ["content", "parts", "output"]
                .into_iter()
                .filter_map(|field| values.get(field))
                .any(value_contains_image)
        }
        _ => false,
    }
}

fn string_carries_image(text: &str) -> bool {
    let trimmed = text.trim();
    if is_v3_inline_image_reference(text) {
        return true;
    }
    if trimmed.starts_with('[') || trimmed.starts_with('{') {
        if let Ok(value) = serde_json::from_str::<Value>(trimmed) {
            return value_contains_image(&value);
        }
    }
    false
}

pub fn is_v3_inline_image_reference(text: &str) -> bool {
    let trimmed = text.trim();
    trimmed.starts_with("data:image/") && !trimmed.chars().any(char::is_whitespace)
}
