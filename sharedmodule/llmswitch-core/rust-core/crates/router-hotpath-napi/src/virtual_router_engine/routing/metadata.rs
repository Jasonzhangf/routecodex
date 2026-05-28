use serde_json::Value;

use crate::shared_json_utils::read_trimmed_string;

fn read_conversation_scope(metadata: &Value) -> Option<String> {
    read_trimmed_string(metadata.get("conversationId"))
        .map(|conversation_id| format!("conversation:{}", conversation_id))
}

fn resolve_continuation_request_chain_key(metadata: &Value) -> Option<String> {
    let continuation = metadata.get("continuation").and_then(|v| v.as_object())?;
    let sticky_scope = read_trimmed_string(continuation.get("stickyScope"))?;
    if sticky_scope != "request_chain" {
        return None;
    }
    read_trimmed_string(continuation.get("chainId")).or_else(|| {
        continuation
            .get("resumeFrom")
            .and_then(|v| v.as_object())
            .and_then(|resume_from| read_trimmed_string(resume_from.get("requestId")))
    })
}

fn resolve_legacy_responses_request_chain_key(metadata: &Value) -> Option<String> {
    metadata
        .get("responsesResume")
        .and_then(|resume| read_trimmed_string(resume.get("previousRequestId")))
}

pub(crate) fn is_continuation_request(metadata: &Value) -> bool {
    resolve_continuation_request_chain_key(metadata).is_some()
        || resolve_legacy_responses_request_chain_key(metadata).is_some()
}

pub(crate) fn resolve_sticky_key(metadata: &Value) -> String {
    if let Some(request_chain_key) = resolve_continuation_request_chain_key(metadata) {
        return request_chain_key;
    }

    if let Some(protocol) = metadata.get("providerProtocol").and_then(|v| v.as_str()) {
        if protocol == "openai-responses" {
            if let Some(previous_request_id) = resolve_legacy_responses_request_chain_key(metadata)
            {
                return previous_request_id;
            }
            if let Some(request_id) = read_trimmed_string(metadata.get("requestId")) {
                return request_id;
            }
        }
    }
    read_trimmed_string(metadata.get("requestId"))
        .unwrap_or_else(|| "default".to_string())
}

pub(crate) fn resolve_session_scope(metadata: &Value) -> Option<String> {
    if let Some(session) = read_trimmed_string(metadata.get("sessionId")) {
        return Some(format!("session:{}", session));
    }
    read_conversation_scope(metadata)
}

pub(crate) fn resolve_stop_message_scope(metadata: &Value) -> Option<String> {
    let explicit = read_trimmed_string(metadata.get("stopMessageClientInjectSessionScope")).unwrap_or_default();
    let explicit = if !explicit.is_empty() {
        explicit
    } else {
        read_trimmed_string(metadata.get("stopMessageClientInjectScope")).unwrap_or_default()
    };
    if !explicit.is_empty() {
        if explicit.starts_with("tmux:")
            || explicit.starts_with("session:")
            || explicit.starts_with("conversation:")
        {
            return Some(explicit);
        }
    }
    let tmux_session = read_trimmed_string(metadata.get("clientTmuxSessionId")).unwrap_or_default();
    let tmux_session = if !tmux_session.is_empty() {
        tmux_session
    } else {
        read_trimmed_string(metadata.get("client_tmux_session_id")).unwrap_or_default()
    };
    let tmux_session = if !tmux_session.is_empty() {
        tmux_session
    } else {
        read_trimmed_string(metadata.get("tmuxSessionId")).unwrap_or_default()
    };
    let tmux_session = if !tmux_session.is_empty() {
        tmux_session
    } else {
        read_trimmed_string(metadata.get("tmux_session_id")).unwrap_or_default()
    };
    if !tmux_session.is_empty() {
        return Some(format!("tmux:{}", tmux_session));
    }
    None
}

pub(crate) fn is_server_tool_followup_request(metadata: &Value) -> bool {
    let rt = metadata.get("__rt").and_then(|v| v.as_object());
    if let Some(rt) = rt {
        if let Some(flag) = rt.get("serverToolFollowup") {
            if flag.as_bool() == Some(true) {
                return true;
            }
            if let Some(text) = flag.as_str() {
                return text.trim().eq_ignore_ascii_case("true");
            }
        }
    }
    false
}

pub(crate) fn build_scoped_session_key(scope: &str) -> String {
    format!("{}::gemini", scope)
}

pub(crate) fn extract_excluded_provider_keys(metadata: &Value) -> Vec<String> {
    let mut out = Vec::new();
    let Some(list) = metadata
        .get("excludedProviderKeys")
        .and_then(|v| v.as_array())
    else {
        return out;
    };
    for entry in list {
        if let Some(text) = entry.as_str() {
            let trimmed = text.trim();
            if !trimmed.is_empty() {
                out.push(trimmed.to_string());
            }
        }
    }
    out
}

pub(crate) fn extract_runtime_now_ms(metadata: &Value) -> Option<i64> {
    let rt = metadata.get("__rt").and_then(|v| v.as_object())?;
    rt.get("nowMs").and_then(|v| v.as_i64())
}

#[cfg(test)]
mod tests {
    use super::{is_continuation_request, resolve_sticky_key, resolve_stop_message_scope};
    use serde_json::json;

    #[test]
    fn prefers_unified_continuation_request_chain_key() {
        let metadata = json!({
            "providerProtocol": "openai-chat",
            "requestId": "req_chat_cont_1",
            "sessionId": "session_should_lose",
            "continuation": {
                "chainId": "req_chain_from_continuation",
                "stickyScope": "request_chain",
                "resumeFrom": {
                    "requestId": "req_chain_from_continuation"
                }
            }
        });

        assert_eq!(
            resolve_sticky_key(&metadata),
            "req_chain_from_continuation".to_string()
        );
    }

    #[test]
    fn uses_explicit_session_sticky_scope() {
        let metadata = json!({
            "requestId": "req_session_scope",
            "sessionId": "session_should_win",
            "continuation": {
                "stickyScope": "session"
            }
        });

        assert_eq!(
            resolve_sticky_key(&metadata),
            "req_session_scope".to_string()
        );
    }

    #[test]
    fn uses_explicit_request_sticky_scope() {
        let metadata = json!({
            "requestId": "req_request_scope",
            "sessionId": "session_should_lose",
            "continuation": {
                "stickyScope": "request"
            }
        });

        assert_eq!(
            resolve_sticky_key(&metadata),
            "req_request_scope".to_string()
        );
    }

    #[test]
    fn prefers_responses_resume_chain_over_session_scope() {
        let metadata = json!({
            "providerProtocol": "openai-responses",
            "requestId": "req_responses_2",
            "sessionId": "session_wins",
            "responsesResume": {
                "previousRequestId": "req_chain_root"
            }
        });

        assert_eq!(resolve_sticky_key(&metadata), "req_chain_root".to_string());
    }

    #[test]
    fn falls_back_to_session_scope_for_non_responses_protocol() {
        let metadata = json!({
            "providerProtocol": "openai-chat",
            "requestId": "req_chat_1",
            "sessionId": "session_1"
        });

        assert_eq!(resolve_sticky_key(&metadata), "req_chat_1".to_string());
    }

    #[test]
    fn non_continuation_request_is_not_sticky() {
        let metadata = json!({
            "providerProtocol": "openai-responses",
            "requestId": "req_1",
            "sessionId": "session_1"
        });
        assert_eq!(is_continuation_request(&metadata), false);
    }

    #[test]
    fn responses_resume_is_continuation_request() {
        let metadata = json!({
            "providerProtocol": "openai-responses",
            "requestId": "req_2",
            "responsesResume": { "previousRequestId": "req_1" }
        });
        assert_eq!(is_continuation_request(&metadata), true);
    }

    #[test]
    fn stop_message_scope_does_not_fallback_to_plain_session_scope() {
        let metadata = json!({
            "providerProtocol": "openai-chat",
            "requestId": "req_chat_cont_1",
            "sessionId": "session_should_not_become_stop_scope"
        });

        assert_eq!(resolve_stop_message_scope(&metadata), None);
    }

    #[test]
    fn stop_message_scope_uses_tmux_scope_when_present() {
        let metadata = json!({
            "providerProtocol": "openai-chat",
            "requestId": "req_chat_tmux_scope_1",
            "sessionId": "session_should_lose",
            "tmuxSessionId": "tmux-session-1"
        });

        assert_eq!(
            resolve_stop_message_scope(&metadata),
            Some("tmux:tmux-session-1".to_string())
        );
    }
}
