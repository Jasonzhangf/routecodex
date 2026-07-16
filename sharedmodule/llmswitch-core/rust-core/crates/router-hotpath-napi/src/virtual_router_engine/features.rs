mod media;
mod tools;

use serde_json::{json, Value};
use tiktoken_rs::{
    cl100k_base_singleton, o200k_base_singleton, p50k_base_singleton, p50k_edit_singleton,
    r50k_base_singleton, CoreBPE,
};

use crate::virtual_router_engine::message_utils::{extract_message_text, get_latest_message_role};
use media::analyze_media_attachments;
use tools::{
    classify_tool_call_for_report, detect_apply_patch_tool_choice, detect_coding_tool,
    detect_custom_tool_declared, detect_last_assistant_tool_category, detect_vision_tool,
    detect_web_search_tool_declared, detect_web_tool, extract_meaningful_declared_tool_names,
};

fn get_message_role(message: &Value) -> Option<String> {
    message
        .get("role")
        .and_then(|v| v.as_str())
        .map(|v| v.trim().to_ascii_lowercase())
        .filter(|role| role == "user" || role == "assistant" || role == "tool")
}

fn get_responses_context_input(request: &Value) -> Vec<Value> {
    if let Some(input) = request.get("input").and_then(|v| v.as_array()) {
        if !input.is_empty() {
            return input.clone();
        }
    }
    request
        .get("semantics")
        .and_then(|v| v.get("responses"))
        .and_then(|v| v.get("context"))
        .and_then(|v| v.get("input"))
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default()
}

fn read_tool_name(tool: &Value) -> Option<String> {
    let Some(obj) = tool.as_object() else {
        return None;
    };
    if let Some(name) = obj.get("name").and_then(|v| v.as_str()) {
        let trimmed = name.trim();
        if !trimmed.is_empty() {
            return Some(trimmed.to_ascii_lowercase());
        }
    }
    let function_obj = obj.get("function").and_then(|v| v.as_object())?;
    let function_name = function_obj.get("name").and_then(|v| v.as_str())?;
    let trimmed = function_name.trim();
    if trimmed.is_empty() {
        return None;
    }
    Some(trimmed.to_ascii_lowercase())
}

fn get_message_turn_state(
    messages: &[Value],
) -> (
    Option<String>,
    Option<Value>,
    bool,
    Option<tools::ToolClassification>,
) {
    let latest_message = messages.last().cloned();
    let latest_role = latest_message
        .as_ref()
        .and_then(|message| get_message_role(message));
    let latest_user_index = messages.iter().rposition(|message| {
        message
            .get("role")
            .and_then(|v| v.as_str())
            .map(|v| v.trim().eq_ignore_ascii_case("user"))
            .unwrap_or(false)
    });
    let (segment_start, segment_end) = if let Some(user_index) = latest_user_index {
        if latest_role.as_deref() == Some("user") {
            let previous_user_index = messages[..user_index].iter().rposition(|message| {
                message
                    .get("role")
                    .and_then(|v| v.as_str())
                    .map(|v| v.trim().eq_ignore_ascii_case("user"))
                    .unwrap_or(false)
            });
            (
                previous_user_index.map(|idx| idx + 1).unwrap_or(0),
                user_index,
            )
        } else {
            (user_index + 1, messages.len())
        }
    } else {
        (0, messages.len())
    };

    let mut has_tool_call_responses = false;
    let mut assistant_segment: Vec<Value> = Vec::new();

    for msg in messages[segment_start..segment_end].iter() {
        let role = get_message_role(msg).unwrap_or_default();
        if role == "tool" {
            has_tool_call_responses = true;
            continue;
        }
        if role != "assistant" {
            continue;
        }
        if msg
            .get("tool_calls")
            .and_then(|v| v.as_array())
            .map(|arr| !arr.is_empty())
            .unwrap_or(false)
        {
            has_tool_call_responses = true;
        }
        assistant_segment.push(msg.clone());
    }

    let last_assistant_tool = detect_last_assistant_tool_category(&assistant_segment);
    (
        latest_role,
        latest_message,
        has_tool_call_responses,
        last_assistant_tool,
    )
}

fn get_responses_entry_type(entry: &Value) -> String {
    entry
        .as_object()
        .and_then(|obj| obj.get("type"))
        .and_then(|v| v.as_str())
        .map(|v| v.trim().to_ascii_lowercase())
        .unwrap_or_else(|| "message".to_string())
}

fn is_responses_message_with_role(entry: &Value, target_role: &str) -> bool {
    let Some(obj) = entry.as_object() else {
        return false;
    };
    let entry_type = get_responses_entry_type(entry);
    if entry_type != "message" {
        return false;
    }
    obj.get("role")
        .and_then(|v| v.as_str())
        .map(|v| v.trim().eq_ignore_ascii_case(target_role))
        .unwrap_or(false)
}

fn get_responses_message_role(entry: &Value) -> Option<String> {
    entry
        .as_object()
        .and_then(|obj| obj.get("role"))
        .and_then(|v| v.as_str())
        .map(|v| v.trim().to_ascii_lowercase())
        .filter(|role| role == "user" || role == "assistant" || role == "tool")
}

fn get_responses_entry_role(entry: &Value) -> Option<String> {
    let entry_type = get_responses_entry_type(entry);
    if entry_type == "input_text" || entry_type == "text" || entry_type == "output_text" {
        return Some("user".to_string());
    }
    if entry_type == "message" {
        return get_responses_message_role(entry);
    }
    if entry_type == "function_call" {
        return Some("assistant".to_string());
    }
    if matches!(
        entry_type.as_str(),
        "function_call_output" | "tool_result" | "tool_message"
    ) {
        return Some("tool".to_string());
    }
    None
}

fn get_responses_context_message(entry: &Value, role: &str) -> Option<Value> {
    let entry_type = get_responses_entry_type(entry);
    if entry_type == "input_text" || entry_type == "text" || entry_type == "output_text" {
        let text = entry
            .as_object()
            .and_then(|obj| obj.get("text"))
            .and_then(|v| v.as_str())
            .unwrap_or("");
        return Some(json!({ "role": role, "content": text }));
    }
    if entry_type != "message" {
        return None;
    }
    let content = entry.get("content")?;
    if !content.is_string() && !content.is_array() {
        return None;
    }
    Some(json!({ "role": role, "content": content }))
}

fn collect_responses_message_tool_calls(entry: &Value) -> Vec<Value> {
    let mut out = Vec::new();
    if let Some(tool_calls) = entry.get("tool_calls").and_then(|v| v.as_array()) {
        for call in tool_calls {
            out.push(call.clone());
        }
    }
    if let Some(tool_calls) = entry.get("content").and_then(|v| v.as_array()) {
        for item in tool_calls {
            let item_type = get_responses_entry_type(item);
            if item_type == "function_call" {
                out.push(item.clone());
            }
        }
    }
    out
}

fn classify_responses_function_call(entry: &Value) -> Option<tools::ToolClassification> {
    let obj = entry.as_object()?;
    let name = obj.get("name").and_then(|v| v.as_str())?;
    let synthesized = json!({
        "type": "function",
        "id": obj.get("id").or_else(|| obj.get("call_id")).cloned().unwrap_or(Value::Null),
        "function": {
            "name": name,
            "arguments": obj.get("arguments").cloned().unwrap_or(Value::Null),
        }
    });
    classify_tool_call_for_report(&synthesized)
}

fn collect_responses_tool_signals(entries: &[Value]) -> (bool, Option<tools::ToolClassification>) {
    let mut has_tool_call_responses = false;
    let mut last_assistant_tool = None;

    for entry in entries {
        let obj = match entry.as_object() {
            Some(value) => value,
            None => continue,
        };
        let entry_type = get_responses_entry_type(entry);
        if matches!(
            entry_type.as_str(),
            "function_call" | "function_call_output" | "tool_result" | "tool_message"
        ) {
            has_tool_call_responses = true;
        }
        if entry_type == "function_call" {
            if let Some(classification) = classify_responses_function_call(entry) {
                last_assistant_tool = Some(classification);
            }
            continue;
        }
        if entry_type != "message"
            || !get_responses_message_role(entry)
                .as_deref()
                .is_some_and(|role| role == "assistant")
        {
            continue;
        }
        for call in collect_responses_message_tool_calls(entry) {
            let classification = if get_responses_entry_type(&call) == "function_call" {
                classify_responses_function_call(&call)
            } else {
                classify_tool_call_for_report(&call)
            };
            if let Some(classification) = classification {
                last_assistant_tool = Some(classification);
            }
        }
    }

    (has_tool_call_responses, last_assistant_tool)
}

fn get_responses_context_turn_state(
    request: &Value,
) -> (
    Option<String>,
    Option<Value>,
    bool,
    Option<tools::ToolClassification>,
) {
    let input = get_responses_context_input(request);
    let mut latest_role = None;
    let mut latest_message = None;
    for entry in input.iter().rev() {
        let Some(role) = get_responses_entry_role(entry) else {
            continue;
        };
        latest_message = get_responses_context_message(entry, role.as_str());
        latest_role = Some(role);
        break;
    }

    let latest_user_index = input
        .iter()
        .rposition(|entry| is_responses_message_with_role(entry, "user"));
    let (segment_start, segment_end) = if let Some(user_index) = latest_user_index {
        if latest_role.as_deref() == Some("user") {
            let previous_user_index = input[..user_index]
                .iter()
                .rposition(|entry| is_responses_message_with_role(entry, "user"));
            (
                previous_user_index.map(|idx| idx + 1).unwrap_or(0),
                user_index,
            )
        } else {
            (user_index + 1, input.len())
        }
    } else {
        (0, input.len())
    };
    let (has_tool_call_responses, last_assistant_tool) =
        collect_responses_tool_signals(&input[segment_start..segment_end]);

    (
        latest_role,
        latest_message,
        has_tool_call_responses,
        last_assistant_tool,
    )
}

#[derive(Debug, Clone, Default)]
pub(crate) struct RoutingFeatures {
    pub request_id: Option<String>,
    pub model: Option<String>,
    pub total_messages: usize,
    pub user_text_sample: String,
    pub tool_count: usize,
    pub has_tools: bool,
    pub has_tool_call_responses: bool,
    pub has_vision_tool: bool,
    pub has_image_attachment: bool,
    pub has_provider_wire_media_attachment: bool,
    pub has_video_attachment: bool,
    pub has_remote_video_attachment: bool,
    pub has_local_video_attachment: bool,
    pub has_web_tool: bool,
    pub has_web_search_tool_declared: bool,
    pub has_custom_tool_declared: bool,
    pub has_apply_patch_tool_choice: bool,
    pub has_coding_tool: bool,
    pub has_thinking_keyword: bool,
    pub estimated_tokens: i64,
    pub last_assistant_tool_category: Option<String>,
    pub last_assistant_tool_snippet: Option<String>,
    pub last_assistant_tool_label: Option<String>,
    pub latest_message_from_user: bool,
    pub metadata: Value,
}

#[derive(Debug, Clone, Default)]
struct TurnSegmentState {
    latest_role: Option<String>,
    latest_message: Option<Value>,
    has_tool_call_responses: bool,
    last_assistant_tool: Option<tools::ToolClassification>,
}

fn extract_turn_state(request: &Value) -> TurnSegmentState {
    let has_responses_input = request
        .get("input")
        .and_then(|v| v.as_array())
        .map(|arr| !arr.is_empty())
        .unwrap_or(false)
        || request
            .get("semantics")
            .and_then(|v| v.get("responses"))
            .and_then(|v| v.get("context"))
            .and_then(|v| v.get("input"))
            .and_then(|v| v.as_array())
            .map(|arr| !arr.is_empty())
            .unwrap_or(false);

    let message_state = {
        let messages = request
            .get("messages")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();
        let (role, msg, has_tool, tool) = get_message_turn_state(&messages);
        TurnSegmentState {
            latest_role: role,
            latest_message: msg,
            has_tool_call_responses: has_tool,
            last_assistant_tool: tool,
        }
    };

    // If messages has a fresh user turn, prefer it. Otherwise fall back to responses context.
    if message_state.latest_role.as_deref() == Some("user") || !has_responses_input {
        return message_state;
    }

    let (role, msg, has_tool, tool) = get_responses_context_turn_state(request);
    TurnSegmentState {
        latest_role: role,
        latest_message: msg,
        has_tool_call_responses: has_tool,
        last_assistant_tool: tool,
    }
}

pub(crate) fn build_routing_features(request: &Value, metadata: &Value) -> RoutingFeatures {
    let turn_state = extract_turn_state(request);
    let latest_message_role = turn_state.latest_role.clone().unwrap_or_else(|| {
        let messages = request
            .get("messages")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();
        get_latest_message_role(&messages).unwrap_or_default()
    });
    let latest_user_text = if latest_message_role == "user" {
        if let Some(msg) = &turn_state.latest_message {
            extract_message_text(msg)
        } else {
            "".to_string()
        }
    } else {
        "".to_string()
    };
    let normalized_user_text = latest_user_text.to_lowercase();
    let meaningful_declared_tools = extract_meaningful_declared_tool_names(request.get("tools"));
    let has_tools = !meaningful_declared_tools.is_empty();
    let estimated_tokens = estimate_request_tokens(request);
    let has_thinking = detect_keyword(&normalized_user_text, &THINKING_KEYWORDS);
    let has_vision_tool = detect_vision_tool(request.get("tools"));
    let media_signals = if latest_message_role == "user" {
        analyze_media_attachments(turn_state.latest_message.as_ref())
    } else {
        analyze_media_attachments(None)
    };
    let has_image_attachment = media_signals.has_any_media;
    let has_provider_wire_media_attachment = contains_provider_wire_media_attachment(request);
    let has_coding_tool = detect_coding_tool(request.get("tools"));
    let has_web_tool = detect_web_tool(request.get("tools"));
    let has_thinking_keyword =
        has_thinking || detect_extended_thinking_keyword(&normalized_user_text);
    let last_assistant_tool_label = turn_state
        .last_assistant_tool
        .as_ref()
        .and_then(|tool| tool.label.clone());

    let metadata_copy = metadata.clone();
    let messages = request
        .get("messages")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();

    RoutingFeatures {
        request_id: metadata
            .get("requestId")
            .and_then(|v| v.as_str())
            .map(|v| v.to_string()),
        model: request
            .get("model")
            .and_then(|v| v.as_str())
            .map(|v| v.to_string()),
        total_messages: messages.len(),
        user_text_sample: latest_user_text.chars().take(2000).collect(),
        tool_count: meaningful_declared_tools.len(),
        has_tools,
        has_tool_call_responses: turn_state.has_tool_call_responses,
        has_vision_tool,
        has_image_attachment,
        has_provider_wire_media_attachment,
        has_video_attachment: media_signals.has_video,
        has_remote_video_attachment: media_signals.has_remote_video,
        has_local_video_attachment: media_signals.has_local_video,
        has_web_tool,
        has_web_search_tool_declared: detect_web_search_tool_declared(request.get("tools")),
        has_custom_tool_declared: detect_custom_tool_declared(request.get("tools"))
            || contains_responses_custom_tool_payload(request),
        has_apply_patch_tool_choice: detect_apply_patch_tool_choice(request.get("tool_choice")),
        has_coding_tool,
        has_thinking_keyword,
        estimated_tokens,
        last_assistant_tool_category: turn_state
            .last_assistant_tool
            .as_ref()
            .map(|tool| tool.category.clone()),
        last_assistant_tool_snippet: turn_state
            .last_assistant_tool
            .as_ref()
            .and_then(|tool| tool.snippet.clone()),
        last_assistant_tool_label,
        latest_message_from_user: latest_message_role == "user",
        metadata: metadata_copy,
    }
}

fn contains_responses_custom_tool_payload(value: &Value) -> bool {
    match value {
        Value::Array(items) => items.iter().any(contains_responses_custom_tool_payload),
        Value::Object(record) => {
            let entry_type = record
                .get("type")
                .and_then(Value::as_str)
                .map(|raw| raw.trim().to_ascii_lowercase())
                .unwrap_or_default();
            if entry_type == "custom_tool_call" || entry_type == "custom_tool_call_output" {
                return true;
            }
            record.values().any(contains_responses_custom_tool_payload)
        }
        _ => false,
    }
}

pub(crate) fn estimate_request_tokens_payload_json(input_json: String) -> napi::Result<String> {
    let input: Value = serde_json::from_str(&input_json).map_err(|error| {
        napi::Error::from_reason(format!("invalid token estimate input: {}", error))
    })?;
    let request = input.get("request").unwrap_or(&input);
    let metadata = input.get("metadata").unwrap_or(&Value::Null);
    let features = build_routing_features(request, metadata);
    serde_json::to_string(&serde_json::json!({
        "tokens": features.estimated_tokens.max(0)
    }))
    .map_err(|error| {
        napi::Error::from_reason(format!("serialize token estimate output failed: {}", error))
    })
}

// feature_id: vr.route_token_estimation
fn estimate_request_tokens(request: &Value) -> i64 {
    let encoder = select_legacy_request_encoder(request);
    let mut total_tokens: usize = 0;
    if let Some(messages) = request.get("messages").and_then(|v| v.as_array()) {
        for msg in messages {
            total_tokens += count_message_tokens(msg, encoder);
        }
    }
    let request_extras = count_request_extras_tokens(request, encoder);
    total_tokens += request_extras;
    let responses_context_tokens = count_responses_context_tokens(request, encoder);
    total_tokens.max(responses_context_tokens + request_extras) as i64
}

fn select_legacy_request_encoder(request: &Value) -> &'static CoreBPE {
    let model = request
        .get("model")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or("");
    match legacy_tiktoken_encoding_name(model) {
        "o200k_base" => o200k_base_singleton(),
        "p50k_base" => p50k_base_singleton(),
        "p50k_edit" => p50k_edit_singleton(),
        "r50k_base" | "gpt2" => r50k_base_singleton(),
        _ => cl100k_base_singleton(),
    }
}

fn legacy_tiktoken_encoding_name(model: &str) -> &'static str {
    match model {
        "gpt-4o"
        | "gpt-4o-2024-05-13"
        | "gpt-4o-2024-08-06"
        | "gpt-4o-2024-11-20"
        | "gpt-4o-mini-2024-07-18"
        | "gpt-4o-mini"
        | "gpt-4o-search-preview"
        | "gpt-4o-search-preview-2025-03-11"
        | "gpt-4o-mini-search-preview"
        | "gpt-4o-mini-search-preview-2025-03-11"
        | "gpt-4o-audio-preview"
        | "gpt-4o-audio-preview-2024-12-17"
        | "gpt-4o-audio-preview-2024-10-01"
        | "gpt-4o-mini-audio-preview"
        | "gpt-4o-mini-audio-preview-2024-12-17"
        | "o1"
        | "o1-2024-12-17"
        | "o1-mini"
        | "o1-mini-2024-09-12"
        | "o1-preview"
        | "o1-preview-2024-09-12"
        | "o1-pro"
        | "o1-pro-2025-03-19"
        | "o3"
        | "o3-2025-04-16"
        | "o3-mini"
        | "o3-mini-2025-01-31"
        | "o4-mini"
        | "o4-mini-2025-04-16"
        | "chatgpt-4o-latest"
        | "gpt-4o-realtime"
        | "gpt-4o-realtime-preview-2024-10-01"
        | "gpt-4o-realtime-preview-2024-12-17"
        | "gpt-4o-mini-realtime-preview"
        | "gpt-4o-mini-realtime-preview-2024-12-17"
        | "gpt-4.1"
        | "gpt-4.1-2025-04-14"
        | "gpt-4.1-mini"
        | "gpt-4.1-mini-2025-04-14"
        | "gpt-4.1-nano"
        | "gpt-4.1-nano-2025-04-14"
        | "gpt-4.5-preview"
        | "gpt-4.5-preview-2025-02-27"
        | "gpt-5"
        | "gpt-5-2025-08-07"
        | "gpt-5-nano"
        | "gpt-5-nano-2025-08-07"
        | "gpt-5-mini"
        | "gpt-5-mini-2025-08-07"
        | "gpt-5-chat-latest" => "o200k_base",
        "text-davinci-003" | "text-davinci-002" | "code-davinci-002" | "code-davinci-001"
        | "code-cushman-002" | "code-cushman-001" | "davinci-codex" | "cushman-codex" => {
            "p50k_base"
        }
        "text-davinci-edit-001" | "code-davinci-edit-001" => "p50k_edit",
        "text-davinci-001"
        | "text-curie-001"
        | "text-babbage-001"
        | "text-ada-001"
        | "davinci"
        | "curie"
        | "babbage"
        | "ada"
        | "text-similarity-davinci-001"
        | "text-similarity-curie-001"
        | "text-similarity-babbage-001"
        | "text-similarity-ada-001"
        | "text-search-davinci-doc-001"
        | "text-search-curie-doc-001"
        | "text-search-babbage-doc-001"
        | "text-search-ada-doc-001"
        | "code-search-babbage-code-001"
        | "code-search-ada-code-001" => "r50k_base",
        "gpt2" => "gpt2",
        _ => "cl100k_base",
    }
}

fn count_message_tokens(message: &Value, encoder: &CoreBPE) -> usize {
    let mut total = 0;
    if let Some(role) = message.get("role").and_then(Value::as_str) {
        total += count_text_tokens(role, encoder);
    }
    if let Some(content) = message.get("content") {
        total += count_content_tokens(content, encoder);
    }
    if let Some(tool_calls) = message.get("tool_calls").and_then(Value::as_array) {
        for call in tool_calls {
            total += count_json_value_as_text_tokens(call, encoder);
        }
    }
    if let Some(name) = message.get("name").and_then(Value::as_str) {
        total += count_text_tokens(name, encoder);
    }
    if let Some(tool_call_id) = message.get("tool_call_id").and_then(Value::as_str) {
        total += count_text_tokens(tool_call_id, encoder);
    }
    total
}

fn count_request_extras_tokens(request: &Value, encoder: &CoreBPE) -> usize {
    let mut total = 0;
    if let Some(tools) = request.get("tools").and_then(Value::as_array) {
        for tool in tools {
            total += count_json_value_as_text_tokens(tool, encoder);
        }
    }
    if let Some(parameters) = request.get("parameters") {
        total += count_json_value_as_text_tokens(parameters, encoder);
    }
    total
}

fn count_responses_context_tokens(request: &Value, encoder: &CoreBPE) -> usize {
    let top_level = request
        .get("input")
        .map(|input| count_structured_tokens(input, encoder))
        .unwrap_or(0);
    let semantic_context = if let Some(input) = request
        .get("semantics")
        .and_then(|v| v.get("responses"))
        .and_then(|v| v.get("context"))
        .and_then(|v| v.get("input"))
        .and_then(|v| v.as_array())
    {
        input
            .iter()
            .map(|entry| count_structured_tokens(entry, encoder))
            .sum()
    } else {
        0
    };
    top_level.max(semantic_context)
}

fn count_content_tokens(content: &Value, encoder: &CoreBPE) -> usize {
    match content {
        Value::String(text) => count_content_string_tokens(text, encoder),
        Value::Array(items) => items
            .iter()
            .map(|part| count_content_part_tokens(part, encoder))
            .sum(),
        Value::Object(map) => count_content_object_tokens(map, encoder),
        _ => 0,
    }
}

fn count_content_string_tokens(raw: &str, encoder: &CoreBPE) -> usize {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return 0;
    }
    let likely_json = (trimmed.starts_with('{') && trimmed.ends_with('}'))
        || (trimmed.starts_with('[') && trimmed.ends_with(']'));
    if likely_json {
        if let Ok(parsed) = serde_json::from_str::<Value>(trimmed) {
            return count_content_tokens(&parsed, encoder);
        }
    }
    count_text_tokens(raw, encoder)
}

fn count_content_part_tokens(part: &Value, encoder: &CoreBPE) -> usize {
    match part {
        Value::String(text) => count_text_tokens(text, encoder),
        Value::Object(map) => count_content_object_tokens(map, encoder),
        _ => count_structured_tokens(part, encoder),
    }
}

fn count_content_object_tokens(map: &serde_json::Map<String, Value>, encoder: &CoreBPE) -> usize {
    if detect_media_kind(map).is_some() {
        return 0;
    }
    if let Some(text) = map.get("text").and_then(|v| v.as_str()) {
        return count_text_tokens(text, encoder);
    }
    if let Some(content) = map.get("content").and_then(|v| v.as_str()) {
        return count_text_tokens(content, encoder);
    }
    count_json_value_as_text_tokens(&Value::Object(map.clone()), encoder)
}

fn count_structured_tokens(value: &Value, encoder: &CoreBPE) -> usize {
    match value {
        Value::Null => 0,
        Value::Bool(v) => count_text_tokens(&v.to_string(), encoder),
        Value::Number(v) => count_text_tokens(&v.to_string(), encoder),
        Value::String(v) => count_text_tokens(v, encoder),
        Value::Array(values) => values
            .iter()
            .map(|entry| count_structured_tokens(entry, encoder))
            .sum(),
        Value::Object(map) => {
            if detect_media_kind(map).is_some() {
                let type_len = map
                    .get("type")
                    .and_then(|v| v.as_str())
                    .map(|v| count_text_tokens(v, encoder))
                    .unwrap_or_else(|| count_text_tokens("media", encoder));
                return type_len + count_text_tokens("[omitted_media]", encoder);
            }
            map.iter()
                .map(|(key, entry)| {
                    count_text_tokens(key, encoder) + count_structured_tokens(entry, encoder)
                })
                .sum()
        }
    }
}

fn count_json_value_as_text_tokens(value: &Value, encoder: &CoreBPE) -> usize {
    let text = serde_json::to_string(value).expect("serde_json::Value serialization cannot fail");
    count_text_tokens(&text, encoder)
}

fn count_text_tokens(text: &str, encoder: &CoreBPE) -> usize {
    if text.trim().is_empty() {
        return 0;
    }
    encoder.count_with_special_tokens(text)
}

fn detect_media_kind(map: &serde_json::Map<String, Value>) -> Option<&'static str> {
    let type_value = map
        .get("type")
        .and_then(|v| v.as_str())
        .map(|v| v.trim().to_ascii_lowercase())
        .unwrap_or_default();
    if type_value.contains("video") {
        return Some("video");
    }
    if type_value.contains("image") {
        return Some("image");
    }
    if map.contains_key("video_url") {
        return Some("video");
    }
    if map.contains_key("image_url") {
        return Some("image");
    }
    let data_value = map
        .get("data")
        .and_then(|v| v.as_str())
        .map(|v| v.trim().to_ascii_lowercase())
        .unwrap_or_default();
    if data_value.starts_with("data:video/") {
        return Some("video");
    }
    if data_value.starts_with("data:image/") {
        return Some("image");
    }
    None
}

fn contains_provider_wire_media_attachment(value: &Value) -> bool {
    match value {
        Value::Array(items) => items.iter().any(contains_provider_wire_media_attachment),
        Value::Object(map) => {
            if detect_media_kind(map).is_some() {
                return true;
            }
            map.values().any(contains_provider_wire_media_attachment)
        }
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::build_routing_features;
    use serde_json::{json, Value};

    #[test]
    fn responses_exec_command_tool_output_segment_preserves_last_tool_category() {
        let request = json!({
            "input": [
                {
                    "type": "message",
                    "role": "user",
                    "content": [{"type": "input_text", "text": "修复脚本"}]
                },
                {
                    "type": "function_call",
                    "name": "exec_command",
                    "call_id": "call_read",
                    "arguments": "{\"cmd\":\"sed -n '1,220p' scripts/unsloth-studioctl.sh\",\"workdir\":\"/repo\"}"
                },
                {
                    "type": "function_call_output",
                    "call_id": "call_read",
                    "output": "script contents"
                }
            ],
            "tools": [{
                "type": "function",
                "name": "exec_command",
                "parameters": {"type": "object"}
            }]
        });

        let features = build_routing_features(&request, &json!({}));

        assert!(!features.latest_message_from_user);
        assert!(features.has_tool_call_responses);
        assert_eq!(
            features.last_assistant_tool_category.as_deref(),
            Some("thinking")
        );
    }

    #[test]
    fn estimate_tokens_accounts_for_large_payloads() {
        let big = "x ".repeat(220_000);
        let request = json!({
            "model": "glm-5",
            "messages": [
                { "role": "user", "content": big },
                { "role": "assistant", "content": "ok" }
            ],
            "tools": [
                { "name": "tool", "description": "d", "parameters": { "type": "object" } }
            ],
            "parameters": { "reasoning": { "effort": "high" } }
        });
        let features = build_routing_features(&request, &json!({ "estimatedInputTokens": 1 }));
        assert!(
            features.estimated_tokens >= 180_000,
            "expected large non-media payload to exceed longcontext threshold without trusting metadata hints, got {}",
            features.estimated_tokens
        );
    }

    #[test]
    fn estimate_tokens_matches_retired_tiktoken_model_table() {
        let alias_request = json!({
            "model": "gpt-5.6-sol",
            "messages": [
                { "role": "user", "content": "你好 hello" }
            ]
        });
        let known_request = json!({
            "model": "gpt-5",
            "messages": [
                { "role": "user", "content": "你好 hello" }
            ]
        });

        assert_eq!(
            build_routing_features(&alias_request, &json!({})).estimated_tokens,
            4
        );
        assert_eq!(
            build_routing_features(&known_request, &json!({})).estimated_tokens,
            3
        );
    }

    #[test]
    fn estimate_tokens_accounts_for_structured_tool_payload_without_metadata_hint() {
        let compact_request = json!({
            "model": "glm-5",
            "messages": [
                { "role": "user", "content": "run tool" }
            ],
            "tools": []
        });
        let big_args = "grep needle src && ".repeat(200);
        let request = json!({
            "model": "glm-5",
            "messages": [
                { "role": "user", "content": "run tool" }
            ],
            "tools": [
                {
                    "type": "function",
                    "function": {
                        "name": "exec_command",
                        "description": "tool",
                        "parameters": {
                            "type": "object",
                            "properties": {
                                "cmd": {
                                    "type": "string",
                                    "description": big_args
                                }
                            }
                        }
                    }
                }
            ]
        });
        let compact = build_routing_features(&compact_request, &json!({})).estimated_tokens;
        let features = build_routing_features(&request, &json!({}));
        assert!(
            features.estimated_tokens > compact + 200,
            "expected structured payload to increase estimate, compact={compact}, actual={}",
            features.estimated_tokens
        );
    }

    #[test]
    fn estimate_tokens_accounts_for_large_responses_context_without_metadata_hint() {
        let compact_request = json!({
            "model": "glm-5",
            "messages": [
                { "role": "assistant", "content": "followup" }
            ],
            "semantics": { "responses": { "context": { "input": [] } } }
        });
        let large_output = "result line ".repeat(300);
        let input: Vec<Value> = (0..8)
            .map(|idx| {
                json!({
                    "type": "function_call_output",
                    "call_id": format!("call_{idx}"),
                    "output": large_output
                })
            })
            .collect();
        let request = json!({
            "model": "glm-5",
            "messages": [
                { "role": "assistant", "content": "followup" }
            ],
            "tools": [
                { "type": "function", "function": { "name": "exec_command", "parameters": { "type": "object" } } }
            ],
            "semantics": {
                "responses": {
                    "context": {
                        "input": input
                    }
                }
            }
        });
        let compact = build_routing_features(&compact_request, &json!({})).estimated_tokens;
        let features = build_routing_features(&request, &json!({}));
        assert!(
            features.estimated_tokens > compact + 200,
            "expected responses context payload to increase estimate, compact={compact}, actual={}",
            features.estimated_tokens
        );
    }

    #[test]
    fn estimate_tokens_accounts_for_large_top_level_responses_input_without_metadata_hint() {
        let compact_request = json!({
            "model": "glm-5",
            "input": [
                {
                    "type": "message",
                    "role": "user",
                    "content": [{"type": "input_text", "text": "brief"}]
                }
            ],
            "tools": []
        });
        let large_text = "x ".repeat(220_000);
        let request = json!({
            "model": "glm-5",
            "input": [
                {
                    "type": "message",
                    "role": "user",
                    "content": [{"type": "input_text", "text": large_text}]
                }
            ],
            "tools": []
        });

        let compact = build_routing_features(&compact_request, &json!({})).estimated_tokens;
        let features = build_routing_features(&request, &json!({ "estimatedInputTokens": 1 }));
        assert!(
            features.estimated_tokens > compact + 180_000,
            "expected top-level Responses input text to drive Rust estimate even when metadata is low, compact={compact}, actual={}",
            features.estimated_tokens
        );
    }

    #[test]
    fn estimate_tokens_omits_media_payloads_in_top_level_responses_input() {
        let base_request = json!({
            "model": "gpt-5.6-sol",
            "input": [
                {
                    "type": "message",
                    "role": "user",
                    "content": [
                        { "type": "input_text", "text": "Describe this image" }
                    ]
                }
            ],
            "tools": []
        });
        let image_request = json!({
            "model": "gpt-5.6-sol",
            "input": [
                {
                    "type": "message",
                    "role": "user",
                    "content": [
                        { "type": "input_text", "text": "Describe this image" },
                        {
                            "type": "input_image",
                            "image_url": format!("data:image/png;base64,{}", "A".repeat(200_000))
                        }
                    ]
                }
            ],
            "tools": []
        });

        let base = build_routing_features(&base_request, &json!({})).estimated_tokens;
        let actual = build_routing_features(&image_request, &json!({})).estimated_tokens;
        assert!(
            actual <= base + 8,
            "expected top-level Responses media payload bytes to be omitted, base={base}, actual={actual}"
        );
    }

    #[test]
    fn estimate_tokens_omits_media_payloads_in_message_content_parts() {
        let base_request = json!({
            "model": "gpt-4o",
            "messages": [
                {
                    "role": "user",
                    "content": [
                        { "type": "input_text", "text": "Describe this image" }
                    ]
                }
            ],
            "tools": []
        });
        let image_request = json!({
            "model": "gpt-4o",
            "messages": [
                {
                    "role": "user",
                    "content": [
                        { "type": "input_text", "text": "Describe this image" },
                        {
                            "type": "input_image",
                            "image_url": {
                                "url": format!("data:image/png;base64,{}", "A".repeat(200_000))
                            }
                        }
                    ]
                }
            ],
            "tools": []
        });
        let base = build_routing_features(&base_request, &json!({})).estimated_tokens;
        let actual = build_routing_features(&image_request, &json!({})).estimated_tokens;
        assert_eq!(base, 4);
        assert_eq!(actual, 4);
        assert!(
            actual <= base + 8,
            "expected media payload to be omitted from token estimate, base={base}, actual={actual}"
        );
    }

    #[test]
    fn estimate_tokens_ignores_client_metadata_when_media_payload_is_present() {
        let request = json!({
            "model": "gpt-5.6-sol",
            "messages": [
                {
                    "role": "user",
                    "content": [
                        { "type": "input_text", "text": "Describe this image" },
                        {
                            "type": "input_image",
                            "image_url": {
                                "url": format!("data:image/png;base64,{}", "A".repeat(200_000))
                            }
                        }
                    ]
                }
            ],
            "tools": []
        });

        let actual = build_routing_features(
            &request,
            &json!({
                "estimatedInputTokens": 250_000,
                "estimatedTokens": 250_000,
                "estimated_tokens": 250_000
            }),
        )
        .estimated_tokens;

        assert!(
            actual < 180_000,
            "client metadata token estimates must not override Rust media-byte omission, got {actual}"
        );
    }

    #[test]
    fn estimate_tokens_omits_media_payloads_in_stringified_structured_content() {
        let base_request = json!({
            "model": "gpt-4o",
            "messages": [
                { "role": "user", "content": "Summarize this clip" }
            ],
            "tools": []
        });
        let structured_content = serde_json::to_string(&json!([
            { "type": "input_text", "text": "Summarize this clip" },
            {
                "type": "input_video",
                "video_url": format!("data:video/mp4;base64,{}", "B".repeat(200_000))
            }
        ]))
        .unwrap();
        let video_request = json!({
            "model": "gpt-4o",
            "messages": [
                { "role": "user", "content": structured_content }
            ],
            "tools": []
        });
        let base = build_routing_features(&base_request, &json!({})).estimated_tokens;
        let actual = build_routing_features(&video_request, &json!({})).estimated_tokens;
        assert!(
            actual <= base + 12,
            "expected stringified media payload to be omitted from token estimate, base={base}, actual={actual}"
        );
    }

    #[test]
    fn previous_turn_tool_signals_ignore_older_message_history_before_latest_user_boundary() {
        let request = json!({
            "model": "glm-5",
            "messages": [
                { "role": "user", "content": "old request" },
                {
                    "role": "assistant",
                    "content": "old tool turn",
                    "tool_calls": [
                        {
                            "id": "call_old",
                            "type": "function",
                            "function": {
                                "name": "exec_command",
                                "arguments": "{\"cmd\":\"rg needle src\"}"
                            }
                        }
                    ]
                },
                { "role": "user", "content": "intermediate request" },
                { "role": "assistant", "content": "plain answer" },
                { "role": "user", "content": "Please think step by step now." }
            ]
        });

        let features = build_routing_features(&request, &json!({}));
        assert!(!features.has_tool_call_responses);
        assert_eq!(features.last_assistant_tool_category, None);
        assert_eq!(features.user_text_sample, "Please think step by step now.");
    }

    #[test]
    fn previous_turn_tool_signals_capture_only_adjacent_message_round() {
        let request = json!({
            "model": "glm-5",
            "messages": [
                { "role": "user", "content": "inspect file" },
                {
                    "role": "assistant",
                    "content": "tool turn",
                    "tool_calls": [
                        {
                            "id": "call_read",
                            "type": "function",
                            "function": {
                                "name": "exec_command",
                                "arguments": "{\"cmd\":\"cat README.md\"}"
                            }
                        }
                    ]
                },
                { "role": "user", "content": "Please think step by step before changing anything." }
            ]
        });

        let features = build_routing_features(&request, &json!({}));
        assert!(features.has_tool_call_responses);
        assert_eq!(
            features.last_assistant_tool_category.as_deref(),
            Some("thinking")
        );
    }

    #[test]
    fn previous_turn_python_read_tool_is_classified_as_thinking_continuation() {
        let request = json!({
            "model": "glm-5",
            "messages": [
                { "role": "user", "content": "读一下 README" },
                {
                    "role": "assistant",
                    "content": "tool turn",
                    "tool_calls": [
                        {
                            "id": "call_read_py",
                            "type": "function",
                            "function": {
                                "name": "exec_command",
                                "arguments": "{\"cmd\":\"python -c \\\"from pathlib import Path; print(Path('README.md').read_text())\\\"\"}"
                            }
                        }
                    ]
                },
                { "role": "tool", "tool_call_id": "call_read_py", "name": "exec_command", "content": "README" },
                { "role": "user", "content": "继续分析" }
            ]
        });

        let features = build_routing_features(&request, &json!({}));
        assert!(features.has_tool_call_responses);
        assert_eq!(
            features.last_assistant_tool_category.as_deref(),
            Some("thinking")
        );
    }

    #[test]
    fn previous_turn_tool_signals_ignore_older_responses_context_history_before_latest_user_boundary(
    ) {
        let request = json!({
            "model": "glm-5",
            "semantics": {
                "responses": {
                    "context": {
                        "input": [
                            { "type": "message", "role": "user", "content": "old request" },
                            {
                                "type": "function_call",
                                "id": "call_old",
                                "name": "exec_command",
                                "arguments": "{\"cmd\":\"find . -name '*.rs'\"}"
                            },
                            { "type": "message", "role": "user", "content": "intermediate request" },
                            { "type": "message", "role": "assistant", "content": "plain answer" },
                            { "type": "message", "role": "user", "content": "latest request" }
                        ]
                    }
                }
            }
        });

        let features = build_routing_features(&request, &json!({}));
        assert!(!features.has_tool_call_responses);
        assert_eq!(features.last_assistant_tool_category, None);
        assert_eq!(features.user_text_sample, "latest request");
    }

    #[test]
    fn previous_turn_tool_signals_use_latest_read_not_prior_search_in_responses_context() {
        let request = json!({
            "model": "glm-5",
            "tools": [
                {
                    "type": "function",
                    "function": {
                        "name": "exec_command",
                        "parameters": {
                            "type": "object",
                            "properties": {
                                "cmd": { "type": "string" }
                            }
                        }
                    }
                }
            ],
            "semantics": {
                "responses": {
                    "context": {
                        "input": [
                            { "type": "message", "role": "user", "content": "先搜再读" },
                            {
                                "type": "function_call",
                                "id": "call_search",
                                "name": "exec_command",
                                "arguments": "{\"cmd\":\"rg -n routing sharedmodule/llmswitch-core\"}"
                            },
                            {
                                "type": "function_call",
                                "id": "call_read",
                                "name": "exec_command",
                                "arguments": "{\"cmd\":\"cat sharedmodule/llmswitch-core/src/router/virtual-router/classifier.ts\"}"
                            },
                            { "type": "function_call_output", "call_id": "call_search", "output": "..." },
                            { "type": "function_call_output", "call_id": "call_read", "output": "..." },
                            { "type": "message", "role": "user", "content": "继续" }
                        ]
                    }
                }
            }
        });

        let features = build_routing_features(&request, &json!({}));
        assert!(features.has_tool_call_responses);
        assert_eq!(
            features.last_assistant_tool_category.as_deref(),
            Some("thinking")
        );
    }

    #[test]
    fn responses_context_search_pattern_replace_stays_search_not_coding() {
        let request = json!({
            "model": "glm-5",
            "tools": [
                {
                    "type": "function",
                    "function": {
                        "name": "exec_command",
                        "parameters": {
                            "type": "object",
                            "properties": {
                                "cmd": { "type": "string" }
                            }
                        }
                    }
                }
            ],
            "semantics": {
                "responses": {
                    "context": {
                        "input": [
                            { "type": "message", "role": "user", "content": "搜 replace 相关位置" },
                            {
                                "type": "function_call",
                                "id": "call_search",
                                "name": "exec_command",
                                "arguments": "{\"cmd\":\"rg -n 'replace' sharedmodule/llmswitch-core\"}"
                            },
                            {
                                "type": "function_call_output",
                                "call_id": "call_search",
                                "output": "matched"
                            }
                        ]
                    }
                }
            }
        });

        let features = build_routing_features(&request, &json!({}));
        assert!(!features.latest_message_from_user);
        assert!(features.has_tool_call_responses);
        assert_eq!(
            features.last_assistant_tool_category.as_deref(),
            Some("search")
        );
    }

    #[test]
    fn responses_input_latest_user_turn_overrides_historical_semantics_continuation() {
        let request = json!({
            "model": "gpt-5.4",
            "input": [
                { "type": "input_text", "text": "现在解释一下这段日志，不要改代码" }
            ],
            "semantics": {
                "responses": {
                    "context": {
                        "input": [
                            { "type": "message", "role": "user", "content": "改一下文件" },
                            {
                                "type": "function_call",
                                "id": "call_patch_1",
                                "name": "apply_patch",
                                "arguments": "{\"filePath\":\"a.ts\",\"patch\":\"-a\\n+b\"}"
                            },
                            {
                                "type": "function_call_output",
                                "call_id": "call_patch_1",
                                "output": "ok"
                            }
                        ]
                    }
                }
            }
        });

        let features = build_routing_features(&request, &json!({}));
        assert!(features.latest_message_from_user);
        assert_eq!(
            features.user_text_sample,
            "现在解释一下这段日志，不要改代码"
        );
        assert!(!features.has_tool_call_responses);
        assert_eq!(features.last_assistant_tool_category, None);
    }

    #[test]
    fn responses_context_current_tool_continuation_after_latest_user_boundary_is_not_user_turn() {
        let request = json!({
            "model": "glm-5",
            "tools": [
                {
                    "type": "function",
                    "function": {
                        "name": "exec_command",
                        "parameters": {
                            "type": "object",
                            "properties": {
                                "cmd": { "type": "string" }
                            }
                        }
                    }
                }
            ],
            "semantics": {
                "responses": {
                    "context": {
                        "input": [
                            { "type": "message", "role": "user", "content": "先搜配置" },
                            {
                                "type": "function_call",
                                "id": "call_search",
                                "name": "exec_command",
                                "arguments": "{\"cmd\":\"rg -n routing sharedmodule/llmswitch-core\"}"
                            },
                            {
                                "type": "function_call_output",
                                "call_id": "call_search",
                                "output": "matched"
                            }
                        ]
                    }
                }
            }
        });

        let features = build_routing_features(&request, &json!({}));
        assert!(!features.latest_message_from_user);
        assert!(features.has_tool_call_responses);
        assert_eq!(
            features.last_assistant_tool_category.as_deref(),
            Some("search")
        );
        assert_eq!(features.user_text_sample, "");
    }

    #[test]
    fn responses_wire_input_user_message_is_current_user_turn() {
        let request = json!({
            "model": "glm-5",
            "input": [{
                "type": "message",
                "role": "user",
                "content": [{ "type": "input_text", "text": "Please answer normally." }]
            }],
            "tools": [{ "type": "function", "function": { "name": "apply_patch" } }]
        });

        let features = build_routing_features(&request, &json!({}));
        assert!(features.latest_message_from_user);
        assert_eq!(features.user_text_sample, "Please answer normally.");
        assert!(!features.has_tool_call_responses);
        assert_eq!(features.last_assistant_tool_category, None);
    }

    #[test]
    fn responses_wire_input_image_placeholder_is_media_intent() {
        let request = json!({
            "model": "glm-5",
            "input": [{
                "type": "message",
                "role": "user",
                "content": [
                    { "type": "input_text", "text": "请看这张图 [Image #1]" }
                ]
            }]
        });

        let features = build_routing_features(&request, &json!({}));
        assert!(features.latest_message_from_user);
        assert!(features.has_image_attachment);
    }

    #[test]
    fn provider_wire_media_attachment_detects_real_image_payload() {
        let request = json!({
            "input": [
                {
                    "type": "message",
                    "role": "user",
                    "content": [
                        { "type": "input_text", "text": "describe" },
                        { "type": "input_image", "image_url": "data:image/png;base64,AAAA" }
                    ]
                }
            ]
        });

        let features = build_routing_features(&request, &json!({}));

        assert!(features.has_image_attachment);
        assert!(features.has_provider_wire_media_attachment);
    }

    #[test]
    fn provider_wire_media_attachment_ignores_image_placeholder_text() {
        let request = json!({
            "input": [
                {
                    "type": "message",
                    "role": "user",
                    "content": [
                        { "type": "input_text", "text": "[Image omitted]" }
                    ]
                }
            ]
        });

        let features = build_routing_features(&request, &json!({}));

        assert!(features.has_image_attachment);
        assert!(!features.has_provider_wire_media_attachment);
    }

    #[test]
    fn current_user_image_placeholder_is_media_intent() {
        let request = json!({
            "model": "glm-5",
            "messages": [{
                "role": "user",
                "content": [
                    { "type": "text", "text": "<image name=[Image #1]>" },
                    { "type": "text", "text": "[Image omitted]" },
                    { "type": "text", "text": "</image>" },
                    { "type": "text", "text": "[Image #1]这两个节点通吗？" }
                ]
            }]
        });

        let features = build_routing_features(&request, &json!({}));

        assert!(features.latest_message_from_user);
        assert!(features.has_image_attachment);
    }

    #[test]
    fn responses_wire_input_function_call_output_uses_current_turn_tool_call() {
        let request = json!({
            "model": "glm-5",
            "input": [
                { "type": "message", "role": "user", "content": [{ "type": "input_text", "text": "Patch this file." }] },
                {
                    "type": "message",
                    "role": "assistant",
                    "content": [],
                    "tool_calls": [{
                        "id": "call_apply_patch_1",
                        "type": "function",
                        "function": { "name": "apply_patch", "arguments": "{\"patch\":\"*** Begin Patch\"}" }
                    }]
                },
                { "type": "function_call_output", "call_id": "call_apply_patch_1", "output": "ok" }
            ],
            "tools": [{ "type": "function", "function": { "name": "read_file" } }]
        });

        let features = build_routing_features(&request, &json!({}));
        assert!(!features.latest_message_from_user);
        assert!(features.has_tool_call_responses);
        assert_eq!(
            features.last_assistant_tool_category.as_deref(),
            Some("coding")
        );
    }

    #[test]
    fn exec_command_only_declared_tools_are_counted_as_tools() {
        let request = json!({
            "model": "glm-5",
            "messages": [
                { "role": "user", "content": "继续" }
            ],
            "tools": [
                {
                    "type": "function",
                    "function": {
                        "name": "exec_command",
                        "parameters": {
                            "type": "object",
                            "properties": {
                                "cmd": { "type": "string" }
                            }
                        }
                    }
                }
            ]
        });

        let features = build_routing_features(&request, &json!({}));
        assert!(features.has_tools);
        assert_eq!(features.tool_count, 1);
    }

    #[test]
    fn malformed_exec_command_followup_does_not_set_last_assistant_tool_category() {
        let request = json!({
            "model": "glm-5",
            "messages": [
                { "role": "user", "content": "写文件" },
                {
                    "role": "assistant",
                    "content": null,
                    "tool_calls": [
                        {
                            "id": "call_bad_exec",
                            "type": "function",
                            "function": {
                                "name": "exec_command",
                                "arguments": "{\"cmd\":\"\"}"
                            }
                        }
                    ]
                },
                { "role": "tool", "tool_call_id": "call_bad_exec", "name": "exec_command", "content": "bad args" }
            ]
        });

        let features = build_routing_features(&request, &json!({}));
        assert!(features.has_tool_call_responses);
        assert_eq!(features.last_assistant_tool_category, None);
    }

    #[test]
    fn goal_mode_user_turn_is_not_demoted_by_stale_servertool_followup_flag() {
        let request = json!({
            "model": "mimo-v2.5-pro",
            "messages": [
                { "role": "assistant", "content": "previous tool step" },
                { "role": "user", "content": "继续规划并输出 /goal 提示词" }
            ],
            "tools": [
                { "type": "function", "function": { "name": "exec_command" } }
            ]
        });
        let metadata = json!({
            "__rt": {
                "serverToolFollowup": true
            }
        });

        let features = build_routing_features(&request, &metadata);
        assert!(features.latest_message_from_user);
        assert_eq!(features.user_text_sample, "继续规划并输出 /goal 提示词");
    }

    #[test]
    fn declared_coding_tools_without_valid_assistant_tool_call_do_not_create_coding_continuation() {
        let request = json!({
            "model": "glm-5",
            "tools": [
                {
                    "type": "function",
                    "function": {
                        "name": "exec_command",
                        "parameters": {
                            "type": "object",
                            "properties": {
                                "cmd": { "type": "string" }
                            }
                        }
                    }
                },
                {
                    "type": "function",
                    "function": {
                        "name": "apply_patch",
                        "parameters": {
                            "type": "object",
                            "properties": {
                                "patch": { "type": "string" }
                            }
                        }
                    }
                }
            ],
            "messages": [
                { "role": "user", "content": "继续" }
            ]
        });

        let features = build_routing_features(&request, &json!({}));
        assert!(features.has_tools);
        assert_eq!(features.last_assistant_tool_category, None);
    }
}

fn detect_keyword(text: &str, keywords: &[&str]) -> bool {
    if text.is_empty() {
        return false;
    }
    keywords
        .iter()
        .any(|keyword| text.contains(&keyword.to_lowercase()))
}

fn detect_extended_thinking_keyword(text: &str) -> bool {
    if text.is_empty() {
        return false;
    }
    let keywords = [
        "仔细分析",
        "思考",
        "超级思考",
        "深度思考",
        "careful analysis",
        "deep thinking",
        "deliberate",
    ];
    keywords.iter().any(|keyword| text.contains(keyword))
}

const THINKING_KEYWORDS: [&str; 5] = [
    "let me think",
    "chain of thought",
    "cot",
    "reason step",
    "deliberate",
];
