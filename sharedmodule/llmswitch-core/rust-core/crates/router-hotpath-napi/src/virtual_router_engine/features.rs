mod media;
mod tools;

use serde_json::{json, Value};

use crate::virtual_router_engine::message_utils::{extract_message_text, get_latest_message_role};
use crate::virtual_router_engine::routing::is_server_tool_followup_request;
use media::analyze_media_attachments;
use tools::{
    detect_coding_tool, detect_last_assistant_tool_category, detect_vision_tool,
    detect_web_search_tool_declared, detect_web_tool, extract_meaningful_declared_tool_names,
};

fn get_latest_responses_context_message(request: &Value) -> Option<(String, Value)> {
    let input = request
        .get("semantics")
        .and_then(|v| v.get("responses"))
        .and_then(|v| v.get("context"))
        .and_then(|v| v.get("input"))
        .and_then(|v| v.as_array())?;

    for entry in input.iter().rev() {
        let obj = match entry.as_object() {
            Some(value) => value,
            None => continue,
        };
        let entry_type = obj
            .get("type")
            .and_then(|v| v.as_str())
            .map(|v| v.trim().to_ascii_lowercase())
            .unwrap_or_else(|| "message".to_string());
        if entry_type != "message" {
            continue;
        }
        let role = obj
            .get("role")
            .and_then(|v| v.as_str())
            .map(|v| v.trim().to_ascii_lowercase())
            .unwrap_or_else(|| "user".to_string());
        if role != "user" && role != "assistant" && role != "tool" {
            continue;
        }
        let content = match obj.get("content") {
            Some(value) if value.is_string() || value.is_array() => value.clone(),
            _ => continue,
        };
        return Some((role.clone(), json!({ "role": role, "content": content })));
    }

    None
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
    let responses_latest_message = get_latest_responses_context_message(request);

    let latest_message_role = if !messages.is_empty() {
        get_latest_message_role(&messages).unwrap_or_default()
    } else {
        responses_latest_message
            .as_ref()
            .map(|(role, _)| role.clone())
            .unwrap_or_default()
    };

    let latest_message = if !messages.is_empty() {
        messages.last()
    } else {
        responses_latest_message
            .as_ref()
            .map(|(_, message)| message)
    };
    let assistant_messages: Vec<Value> = messages
        .iter()
        .filter(|msg| msg.get("role").and_then(|v| v.as_str()) == Some("assistant"))
        .cloned()
        .collect();
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
    let has_tool_call_responses = assistant_messages.iter().any(|msg| {
        msg.get("tool_calls")
            .and_then(|v| v.as_array())
            .map(|arr| !arr.is_empty())
            .unwrap_or(false)
    });
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
    let last_assistant_tool = detect_last_assistant_tool_category(&assistant_messages);
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
    let approx_text_tokens = (total_chars as f64 / 4.0).ceil() as i64;
    approx_text_tokens.max(0)
}

#[cfg(test)]
mod tests {
    use super::build_routing_features;
    use serde_json::json;

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
