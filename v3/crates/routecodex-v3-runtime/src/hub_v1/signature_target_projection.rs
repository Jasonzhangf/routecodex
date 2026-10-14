//! Target-standard extension decision, consumed by the existing stage-3 drop chain.
use super::V3OutboundTargetProtocol;
use serde_json::Value;

pub(super) fn unrepresentable_call_extension_paths(
    source: &Value,
    target: V3OutboundTargetProtocol,
) -> Vec<String> {
    // Responses carries the original call-local field; Gemini maps it to the
    // paired Part.thoughtSignature. Chat and Anthropic have no equivalent tool
    // call field. Their existing DROP + RECORD + PRINT policy applies without
    // putting the signature in arguments, a wrapper, or control resources.
    if !matches!(
        target,
        V3OutboundTargetProtocol::OpenAiChat | V3OutboundTargetProtocol::Anthropic
    ) {
        return Vec::new();
    }
    let mut paths = Vec::new();
    for (message_index, message) in source
        .get("messages")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .enumerate()
    {
        for (call_index, call) in message
            .get("tool_calls")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .enumerate()
        {
            if call.get("thought_signature").is_some() {
                paths.push(format!(
                    "$.messages[{message_index}].tool_calls[{call_index}].thought_signature"
                ));
            }
        }
    }
    paths
}
