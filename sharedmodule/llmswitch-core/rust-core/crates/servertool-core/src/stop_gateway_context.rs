//! Stop-gateway context: finish_reason analysis and stop eligibility.
//!
//! Matches `servertool/stop-gateway-context.ts`.
//! Determines whether a model response is eligible for stop-message followup.

use serde::{Deserialize, Serialize};

// ── Types ───────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct StopGatewayContext {
    pub observed: bool,
    pub eligible: bool,
    pub source: String,
    pub reason: String,
    pub choice_index: Option<i32>,
    pub has_tool_calls: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum Payload {
    Chat {
        choices: Vec<ChatChoice>,
    },
    Responses {
        status: Option<String>,
        output: Option<Vec<serde_json::Value>>,
        required_action: Option<serde_json::Value>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatChoice {
    pub finish_reason: Option<String>,
    pub message: Option<ChatMessage>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatMessage {
    pub content: Option<serde_json::Value>,
    pub tool_calls: Option<Vec<serde_json::Value>>,
    pub reasoning_content: Option<serde_json::Value>,
    pub thinking: Option<serde_json::Value>,
    pub reasoning: Option<serde_json::Value>,
    pub reasoning_text: Option<serde_json::Value>,
}

// ── Constants ───────────────────────────────────────────────────────────────

const TOOL_MARKER_PATTERN: &[&str] = &[
    "<|tool_calls_section_begin|>",
    "<|tool_call_begin|>",
    "<|tool_call_argument_begin|>",
];

// ── Public API ──────────────────────────────────────────────────────────────

/// Inspect a response payload and return the stop gateway context.
///
/// Matches TS `inspectStopGatewaySignal(base)`.
pub fn inspect(payload: &serde_json::Value) -> StopGatewayContext {
    match classify_payload(payload) {
        Some(PayloadClass::Chat(choices)) => inspect_chat(choices),
        Some(PayloadClass::Responses {
            status,
            output,
            required_action,
        }) => inspect_responses(status, output, required_action),
        None => StopGatewayContext {
            observed: false,
            eligible: false,
            source: "none".to_string(),
            reason: "invalid_payload".to_string(),
            choice_index: None,
            has_tool_calls: None,
        },
    }
}

/// Check if a response is eligible for servertool stop followup.
/// Matches TS `isStopEligibleForServerTool(base)`.
pub fn is_stop_eligible(payload: &serde_json::Value) -> bool {
    inspect(payload).eligible
}

// ── Internal ────────────────────────────────────────────────────────────────

enum PayloadClass {
    Chat(Vec<ChatChoice>),
    Responses {
        status: Option<String>,
        output: Option<Vec<serde_json::Value>>,
        required_action: Option<serde_json::Value>,
    },
}

fn classify_payload(payload: &serde_json::Value) -> Option<PayloadClass> {
    let obj = payload.as_object()?;

    // Chat format: has "choices" array
    if let Some(choices_val) = obj.get("choices") {
        if let Some(choices) = choices_val.as_array() {
            let parsed: Vec<ChatChoice> = choices
                .iter()
                .filter_map(|c| serde_json::from_value(c.clone()).ok())
                .collect();
            if !parsed.is_empty() {
                return Some(PayloadClass::Chat(parsed));
            }
        }
    }

    // Responses format
    let status = obj
        .get("status")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let output = obj.get("output").and_then(|v| v.as_array()).cloned();
    let required_action = obj
        .get("required_action")
        .filter(|v| v.is_object())
        .cloned();

    Some(PayloadClass::Responses {
        status,
        output,
        required_action,
    })
}

fn inspect_chat(choices: Vec<ChatChoice>) -> StopGatewayContext {
    // Find the LAST choice with a finish_reason
    for choice in choices.into_iter().rev() {
        let finish_reason = match choice.finish_reason {
            Some(ref fr) => fr.trim().to_lowercase(),
            None => continue,
        };

        if finish_reason.is_empty() {
            continue;
        }

        let idx = 0; // relative index within the reversed scan
        let message = choice.message.as_ref();

        if finish_reason == "tool_calls" {
            return StopGatewayContext {
                observed: true,
                eligible: false,
                source: "chat".to_string(),
                reason: "finish_reason_tool_calls".to_string(),
                choice_index: Some(idx),
                has_tool_calls: Some(true),
            };
        }

        if finish_reason != "stop" {
            return StopGatewayContext {
                observed: true,
                eligible: false,
                source: "chat".to_string(),
                reason: format!("finish_reason_{}", finish_reason),
                choice_index: Some(idx),
                has_tool_calls: Some(false),
            };
        }

        // finish_reason == "stop" — check for embedded tool markers
        if has_embedded_tool_markers(message) {
            return StopGatewayContext {
                observed: true,
                eligible: false,
                source: "chat".to_string(),
                reason: "finish_reason_stop_with_embedded_tool_markers".to_string(),
                choice_index: Some(idx),
                has_tool_calls: Some(false),
            };
        }

        let has_tc = message
            .and_then(|m| m.tool_calls.as_ref())
            .map(|tc| !tc.is_empty())
            .unwrap_or(false);

        if is_reasoning_only_empty(message) {
            return StopGatewayContext {
                observed: true,
                eligible: false,
                source: "chat".to_string(),
                reason: "finish_reason_stop_reasoning_only_empty_assistant".to_string(),
                choice_index: Some(idx),
                has_tool_calls: Some(has_tc),
            };
        }

        return StopGatewayContext {
            observed: true,
            eligible: !has_tc,
            source: "chat".to_string(),
            reason: format!("finish_reason_{}", finish_reason),
            choice_index: Some(idx),
            has_tool_calls: Some(has_tc),
        };
    }

    StopGatewayContext {
        observed: false,
        eligible: false,
        source: "chat".to_string(),
        reason: "no_stop_finish_reason".to_string(),
        choice_index: None,
        has_tool_calls: None,
    }
}

fn inspect_responses(
    status: Option<String>,
    output: Option<Vec<serde_json::Value>>,
    required_action: Option<serde_json::Value>,
) -> StopGatewayContext {
    let status_str = status.as_deref().unwrap_or("").to_lowercase();

    // Non-completed status
    if !status_str.is_empty() && status_str != "completed" {
        return StopGatewayContext {
            observed: false,
            eligible: false,
            source: "responses".to_string(),
            reason: format!("status_{}", status_str),
            choice_index: None,
            has_tool_calls: None,
        };
    }

    let has_required_action = required_action.is_some();
    let output_items = output.as_deref().unwrap_or(&[]);

    // No status AND no output
    if status_str.is_empty() && output_items.is_empty() {
        return StopGatewayContext {
            observed: false,
            eligible: false,
            source: "responses".to_string(),
            reason: "no_status_or_output".to_string(),
            choice_index: None,
            has_tool_calls: None,
        };
    }

    // Tool-like output items
    if output_items.iter().any(|item| has_tool_like_output(item)) {
        return StopGatewayContext {
            observed: true,
            eligible: false,
            source: "responses".to_string(),
            reason: "responses_tool_like_output".to_string(),
            choice_index: None,
            has_tool_calls: None,
        };
    }

    // Required action
    if has_required_action {
        return StopGatewayContext {
            observed: true,
            eligible: false,
            source: "responses".to_string(),
            reason: "responses_required_action".to_string(),
            choice_index: None,
            has_tool_calls: None,
        };
    }

    // Clean completed response
    let reason = if status_str.is_empty() {
        "responses_output_completed".to_string()
    } else {
        format!("status_{}", status_str)
    };

    StopGatewayContext {
        observed: true,
        eligible: true,
        source: "responses".to_string(),
        reason,
        choice_index: None,
        has_tool_calls: None,
    }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

fn has_embedded_tool_markers(message: Option<&ChatMessage>) -> bool {
    let msg = match message {
        Some(m) => m,
        None => return false,
    };

    let fields = [
        msg.content.as_ref(),
        msg.reasoning_content.as_ref(),
        msg.thinking.as_ref(),
        msg.reasoning.as_ref(),
        msg.reasoning.as_ref().and_then(|r| r.get("content")),
        msg.reasoning.as_ref().and_then(|r| r.get("text")),
    ];

    fields.iter().flatten().any(|v| contains_tool_marker(v))
}

fn contains_tool_marker(value: &serde_json::Value) -> bool {
    match value {
        serde_json::Value::String(s) => TOOL_MARKER_PATTERN.iter().any(|pat| s.contains(pat)),
        serde_json::Value::Array(arr) => arr.iter().any(|v| contains_tool_marker(v)),
        serde_json::Value::Object(obj) => obj.values().any(|v| contains_tool_marker(v)),
        _ => false,
    }
}

fn has_visible_text(value: Option<&serde_json::Value>) -> bool {
    let v = match value {
        Some(v) => v,
        None => return false,
    };
    match v {
        serde_json::Value::String(s) => !s.trim().is_empty(),
        serde_json::Value::Array(arr) => arr.iter().any(|item| has_visible_text(Some(item))),
        serde_json::Value::Object(obj) => {
            if let Some(text) = obj.get("text").and_then(|t| t.as_str()) {
                if !text.trim().is_empty() {
                    return true;
                }
            }
            if let Some(content) = obj.get("content").and_then(|c| c.as_str()) {
                if !content.trim().is_empty() {
                    return true;
                }
            }
            if let Some(content_arr) = obj.get("content").and_then(|c| c.as_array()) {
                return content_arr.iter().any(|item| has_visible_text(Some(item)));
            }
            if let Some(parts) = obj.get("parts").and_then(|p| p.as_array()) {
                return parts.iter().any(|item| has_visible_text(Some(item)));
            }
            false
        }
        _ => false,
    }
}

fn is_reasoning_only_empty(message: Option<&ChatMessage>) -> bool {
    let msg = match message {
        Some(m) => m,
        None => return false,
    };

    // Has tool calls → not reasoning-only
    if let Some(tcs) = &msg.tool_calls {
        if !tcs.is_empty() {
            return false;
        }
    }

    // Has visible content → not reasoning-only
    if let Some(content) = &msg.content {
        if has_visible_text(Some(content)) {
            return false;
        }
    }

    // Check if any reasoning field has visible text
    let reasoning_fields = [
        msg.reasoning_content.as_ref(),
        msg.thinking.as_ref(),
        msg.reasoning.as_ref(),
        msg.reasoning_text.as_ref(),
    ];

    reasoning_fields
        .iter()
        .flatten()
        .any(|v| has_visible_text(Some(v)))
}

fn has_tool_like_output(value: &serde_json::Value) -> bool {
    let obj = match value.as_object() {
        Some(o) => o,
        None => return false,
    };
    let type_str = match obj.get("type").and_then(|t| t.as_str()) {
        Some(t) => t.trim().to_lowercase(),
        None => return false,
    };
    if type_str.is_empty() {
        return false;
    }
    type_str == "tool_call"
        || type_str == "tool_use"
        || type_str == "function_call"
        || type_str.contains("tool")
}

// ── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn chat_stop_eligible() {
        let payload = json!({
            "choices": [{
                "index": 0,
                "finish_reason": "stop",
                "message": { "role": "assistant", "content": "ok" }
            }]
        });
        let result = inspect(&payload);
        assert!(result.observed);
        assert!(result.eligible);
        assert_eq!(result.reason, "finish_reason_stop");
    }

    #[test]
    fn chat_tool_calls_not_eligible() {
        let payload = json!({
            "choices": [{
                "index": 0,
                "finish_reason": "tool_calls",
                "message": {
                    "role": "assistant",
                    "content": null,
                    "tool_calls": [{ "id": "call_1", "function": { "name": "exec", "arguments": "{}" } }]
                }
            }]
        });
        let result = inspect(&payload);
        assert!(result.observed);
        assert!(!result.eligible);
        assert_eq!(result.reason, "finish_reason_tool_calls");
    }

    #[test]
    fn responses_completed_eligible() {
        let payload = json!({
            "id": "resp_1",
            "status": "completed",
            "output": [{ "type": "message", "content": [{ "type": "output_text", "text": "done" }] }]
        });
        let result = inspect(&payload);
        assert!(result.observed);
        assert!(result.eligible);
    }

    #[test]
    fn responses_tool_output_not_eligible() {
        let payload = json!({
            "id": "resp_1",
            "status": "completed",
            "output": [{ "type": "tool_call", "id": "call_1" }]
        });
        let result = inspect(&payload);
        assert!(result.observed);
        assert!(!result.eligible);
        assert_eq!(result.reason, "responses_tool_like_output");
    }

    #[test]
    fn invalid_payload_not_observed() {
        let payload = json!("not_an_object");
        let result = inspect(&payload);
        assert!(!result.observed);
        assert_eq!(result.source, "none");
    }

    #[test]
    fn embedded_tool_markers_not_eligible() {
        let payload = json!({
            "choices": [{
                "index": 0,
                "finish_reason": "stop",
                "message": { "role": "assistant", "content": "<|tool_call_begin|>test" }
            }]
        });
        let result = inspect(&payload);
        assert!(result.observed);
        assert!(!result.eligible);
        assert!(result.reason.contains("embedded_tool_markers"));
    }

    #[test]
    fn reasoning_only_empty_not_eligible() {
        let payload = json!({
            "choices": [{
                "index": 0,
                "finish_reason": "stop",
                "message": { "role": "assistant", "content": null, "reasoning_content": "thinking..." }
            }]
        });
        let result = inspect(&payload);
        assert!(result.observed);
        assert!(!result.eligible);
        assert!(result.reason.contains("reasoning_only_empty"));
    }

    #[test]
    fn finish_reason_length_not_eligible() {
        let payload = json!({
            "choices": [{
                "index": 0,
                "finish_reason": "length",
                "message": { "role": "assistant", "content": "truncated" }
            }]
        });
        let result = inspect(&payload);
        assert!(result.observed);
        assert!(!result.eligible);
        assert_eq!(result.reason, "finish_reason_length");
    }

    #[test]
    fn required_action_not_eligible() {
        let payload = json!({
            "id": "resp_1",
            "status": "requires_action",
            "required_action": { "type": "submit_tool_outputs" }
        });
        let result = inspect(&payload);
        assert!(!result.observed);
        assert!(!result.eligible);
    }
}
