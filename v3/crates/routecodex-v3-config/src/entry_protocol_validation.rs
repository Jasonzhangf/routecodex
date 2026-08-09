use crate::types::V3EntryProtocolExecutionMode;

pub(crate) fn endpoint_patterns(protocol: &str) -> Option<&'static [&'static str]> {
    match protocol {
        "responses" => Some(&["/v1/responses"]),
        "anthropic" => Some(&["/v1/messages"]),
        "openai_chat" => Some(&["/v1/chat/completions"]),
        "gemini" => Some(&["/v1beta/models/:model/generateContent"]),
        _ => None,
    }
}

pub(crate) fn execution_modes(
    _protocol: &str,
) -> Option<&'static [V3EntryProtocolExecutionMode]> {
    Some(&[
        V3EntryProtocolExecutionMode::Direct,
        V3EntryProtocolExecutionMode::Relay,
    ])
}
