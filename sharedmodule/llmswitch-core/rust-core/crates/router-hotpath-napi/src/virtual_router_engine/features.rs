mod media;
mod tools;

use serde_json::{json, Value};

use crate::virtual_router_engine::message_utils::{extract_message_text, get_latest_message_role};
use crate::virtual_router_engine::routing::is_server_tool_followup_request;
use media::analyze_media_attachments;
use tools::{
    choose_higher_priority_tool_category, classify_tool_call_for_report, detect_coding_tool,
    detect_last_assistant_tool_category, detect_vision_tool, detect_web_search_tool_declared,
    detect_web_tool, extract_meaningful_declared_tool_names,
};

fn get_message_role(message: &Value) -> Option<String> {
    message
        .get("role")
        .and_then(|v| v.as_str())
        .map(|v| v.trim().to_ascii_lowercase())
        .filter(|role| role == "user" || role == "assistant" || role == "tool")
}

fn get_responses_context_input(request: &Value) -> Vec<Value> {
    request
        .get("semantics")
        .and_then(|v| v.get("responses"))
        .and_then(|v| v.get("context"))
        .and_then(|v| v.get("input"))
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default()
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
    if get_responses_entry_type(entry) != "message" {
        return None;
    }
    let content = entry.get("content")?;
    if !content.is_string() && !content.is_array() {
        return None;
    }
    Some(json!({ "role": role, "content": content }))
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
        if entry_type != "function_call" {
            continue;
        }
        let Some(name) = obj.get("name").and_then(|v| v.as_str()) else {
            continue;
        };
        let synthesized = json!({
            "type": "function",
            "id": obj.get("id").cloned().unwrap_or(Value::Null),
            "function": {
                "name": name,
                "arguments": obj.get("arguments").cloned().unwrap_or(Value::Null),
            }
        });
        last_assistant_tool = choose_higher_priority_tool_category(
            last_assistant_tool,
            classify_tool_call_for_report(&synthesized),
        );
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
    pub has_video_attachment: bool,
    pub has_remote_video_attachment: bool,
    pub has_local_video_attachment: bool,
    pub has_web_tool: bool,
    pub has_web_search_tool_declared: bool,
    pub has_coding_tool: bool,
    pub has_thinking_keyword: bool,
    pub estimated_tokens: i64,
    pub last_assistant_tool_category: Option<String>,
    pub last_assistant_tool_snippet: Option<String>,
    pub last_assistant_tool_label: Option<String>,
    pub latest_message_from_user: bool,
    pub metadata: Value,
}

pub(crate) fn build_routing_features(request: &Value, metadata: &Value) -> RoutingFeatures {
    let messages = request
        .get("messages")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let (
        message_latest_role,
        message_latest_message,
        message_has_tool_call_responses,
        message_last_assistant_tool,
    ) = get_message_turn_state(&messages);
    let (
        responses_latest_role,
        responses_latest_message,
        responses_has_tool_call_responses,
        responses_last_assistant_tool,
    ) = get_responses_context_turn_state(request);
    let current_user_from_messages = message_latest_role.as_deref() == Some("user");
    let current_user_from_responses =
        !current_user_from_messages && responses_latest_role.as_deref() == Some("user");
    let latest_message_role = if current_user_from_messages || current_user_from_responses {
        "user".to_string()
    } else {
        responses_latest_role
            .clone()
            .or(message_latest_role.clone())
            .unwrap_or_else(|| get_latest_message_role(&messages).unwrap_or_default())
    };

    let latest_message = if current_user_from_messages {
        message_latest_message.as_ref()
    } else if current_user_from_responses {
        responses_latest_message.as_ref()
    } else {
        responses_latest_message
            .as_ref()
            .or(message_latest_message.as_ref())
    };
    let latest_user_text = if latest_message_role == "user" {
        if let Some(msg) = latest_message {
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
    let (has_tool_call_responses, last_assistant_tool) = if current_user_from_messages {
        (message_has_tool_call_responses, message_last_assistant_tool)
    } else if current_user_from_responses {
        (
            responses_has_tool_call_responses,
            responses_last_assistant_tool,
        )
    } else if responses_latest_role.is_some() {
        (
            responses_has_tool_call_responses,
            responses_last_assistant_tool,
        )
    } else {
        (message_has_tool_call_responses, message_last_assistant_tool)
    };
    let estimated_tokens = read_finite_floor_i64(metadata.get("estimatedInputTokens"))
        .or_else(|| read_finite_floor_i64(metadata.get("estimatedTokens")))
        .or_else(|| read_finite_floor_i64(metadata.get("estimated_tokens")))
        .unwrap_or_else(|| estimate_request_tokens(request, &latest_user_text));
    let has_thinking = detect_keyword(&normalized_user_text, &THINKING_KEYWORDS);
    let has_vision_tool = detect_vision_tool(request.get("tools"));
    let media_signals = if latest_message_role == "user" {
        analyze_media_attachments(latest_message)
    } else {
        analyze_media_attachments(None)
    };
    let has_image_attachment = media_signals.has_any_media;
    let has_coding_tool = detect_coding_tool(request.get("tools"));
    let has_web_tool = detect_web_tool(request.get("tools"));
    let has_thinking_keyword =
        has_thinking || detect_extended_thinking_keyword(&normalized_user_text);
    let last_assistant_tool_label = last_assistant_tool
        .as_ref()
        .and_then(|tool| tool.label.clone());

    let mut metadata_copy = metadata.clone();
    if let Value::Object(map) = &mut metadata_copy {
        if let Some(antigravity_session_id) = extract_antigravity_session_id(&messages) {
            map.insert(
                "antigravitySessionId".to_string(),
                Value::String(antigravity_session_id),
            );
        }
    }

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
        has_tool_call_responses,
        has_vision_tool,
        has_image_attachment,
        has_video_attachment: media_signals.has_video,
        has_remote_video_attachment: media_signals.has_remote_video,
        has_local_video_attachment: media_signals.has_local_video,
        has_web_tool,
        has_web_search_tool_declared: detect_web_search_tool_declared(request.get("tools")),
        has_coding_tool,
        has_thinking_keyword,
        estimated_tokens,
        last_assistant_tool_category: last_assistant_tool
            .as_ref()
            .map(|tool| tool.category.clone()),
        last_assistant_tool_snippet: last_assistant_tool
            .as_ref()
            .and_then(|tool| tool.snippet.clone()),
        last_assistant_tool_label,
        latest_message_from_user: latest_message_role == "user"
            && !is_server_tool_followup_request(metadata),
        metadata: metadata_copy,
    }
}

fn extract_antigravity_session_id(messages: &[Value]) -> Option<String> {
    let contents: Vec<Value> = messages
        .iter()
        .map(|msg| {
            let role = if msg.get("role").and_then(|v| v.as_str()) == Some("user") {
                "user"
            } else {
                "assistant"
            };
            let text = extract_message_text(msg);
            json!({
                "role": role,
                "parts": [{ "text": text }]
            })
        })
        .collect();
    let payload = json!({ "contents": contents });
    let session_id =
        crate::req_outbound_stage3_compat::gemini_cli::extract_antigravity_gemini_session_id(
            &payload,
        );
    let trimmed = session_id.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

fn estimate_request_tokens(request: &Value, latest_user_text: &str) -> i64 {
    let mut total_chars: usize = latest_user_text.len();
    if let Some(messages) = request.get("messages").and_then(|v| v.as_array()) {
        for msg in messages {
            total_chars += extract_message_text(msg).len();
        }
    }
    let message_estimate = (total_chars as f64 / 4.0).ceil() as i64;
    let responses_estimate = estimate_responses_context_tokens(request);
    message_estimate.max(responses_estimate).max(0)
}

fn estimate_responses_context_tokens(request: &Value) -> i64 {
    let mut total_chars: usize = 0;
    if let Some(input) = request
        .get("semantics")
        .and_then(|v| v.get("responses"))
        .and_then(|v| v.get("context"))
        .and_then(|v| v.get("input"))
        .and_then(|v| v.as_array())
    {
        for entry in input {
            total_chars += estimate_structured_chars(entry);
        }
    }
    if let Some(tools) = request.get("tools") {
        total_chars += estimate_structured_chars(tools);
    }
    if total_chars == 0 {
        return 0;
    }
    (total_chars as f64 / 3.0).ceil() as i64
}

fn estimate_structured_chars(value: &Value) -> usize {
    match value {
        Value::Null => 0,
        Value::Bool(v) => v.to_string().len(),
        Value::Number(v) => v.to_string().len(),
        Value::String(v) => v.len(),
        Value::Array(values) => values.iter().map(estimate_structured_chars).sum(),
        Value::Object(map) => {
            if detect_media_kind(map).is_some() {
                let type_len = map
                    .get("type")
                    .and_then(|v| v.as_str())
                    .map(|v| v.len())
                    .unwrap_or(5);
                return type_len + "[omitted_media]".len();
            }
            map.iter()
                .map(|(key, entry)| key.len() + estimate_structured_chars(entry))
                .sum()
        }
    }
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

#[cfg(test)]
mod tests {
    use super::build_routing_features;
    use serde_json::{json, Value};

    #[test]
    fn estimate_tokens_accounts_for_large_payloads() {
        let big = "x".repeat(800_000);
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
        let features = build_routing_features(&request, &json!({ "estimatedInputTokens": 200000 }));
        assert!(
            features.estimated_tokens >= 180_000,
            "expected large payload to exceed longcontext threshold, got {}",
            features.estimated_tokens
        );
    }

    #[test]
    fn estimate_tokens_accounts_for_large_responses_context_without_metadata_hint() {
        let large_output = "y".repeat(2_200);
        let input: Vec<Value> = (0..280)
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
        let features = build_routing_features(&request, &json!({}));
        assert!(
            features.estimated_tokens >= 180_000,
            "expected responses context payload to exceed longcontext threshold, got {}",
            features.estimated_tokens
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
            Some("read")
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
    fn previous_turn_tool_signals_prefer_search_over_read_in_responses_context() {
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
            Some("search")
        );
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
}

fn read_finite_floor_i64(value: Option<&Value>) -> Option<i64> {
    let v = value?;
    if let Some(num) = v.as_i64() {
        return Some(num);
    }
    if let Some(num) = v.as_u64() {
        if num <= i64::MAX as u64 {
            return Some(num as i64);
        }
        return Some(i64::MAX);
    }
    if let Some(num) = v.as_f64() {
        if num.is_finite() {
            return Some(num.floor() as i64);
        }
    }
    None
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
