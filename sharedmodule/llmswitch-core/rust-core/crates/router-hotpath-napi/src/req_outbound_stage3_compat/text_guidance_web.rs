use serde_json::Value;

use super::tool_text_request_guidance::apply_tool_text_request_guidance_json;

/// Apply tool text guidance for web-based chat providers (qwenchat-web, deepseek-web, etc).
/// This is a unified abstraction that injects heredoc-wrapped tool call instructions.
pub(crate) fn apply_text_guidance_web_request_compat(
    payload: Value,
) -> Value {
    let payload_json = serde_json::to_string(&payload).unwrap_or_default();
    let result_json = apply_tool_text_request_guidance_json(payload_json.clone(), None)
        .unwrap_or_else(|_| payload_json);
    serde_json::from_str(&result_json).unwrap_or(payload)
}
