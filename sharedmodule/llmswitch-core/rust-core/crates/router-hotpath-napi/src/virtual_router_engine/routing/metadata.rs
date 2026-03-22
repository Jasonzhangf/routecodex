use serde_json::Value;

pub(crate) fn resolve_sticky_key(metadata: &Value) -> String {
    if let Some(protocol) = metadata.get("providerProtocol").and_then(|v| v.as_str()) {
        if protocol == "openai-responses" {
            if let Some(resume) = metadata.get("responsesResume") {
                if let Some(prev) = resume.get("previousRequestId").and_then(|v| v.as_str()) {
                    if !prev.trim().is_empty() {
                        return prev.trim().to_string();
                    }
                }
            }
            if let Some(request_id) = metadata.get("requestId").and_then(|v| v.as_str()) {
                return request_id.to_string();
            }
        }
    }
    if let Some(session) = metadata.get("sessionId").and_then(|v| v.as_str()) {
        if !session.trim().is_empty() {
            return format!("session:{}", session.trim());
        }
    }
    if let Some(conv) = metadata.get("conversationId").and_then(|v| v.as_str()) {
        if !conv.trim().is_empty() {
            return format!("conversation:{}", conv.trim());
        }
    }
    metadata
        .get("requestId")
        .and_then(|v| v.as_str())
        .unwrap_or("default")
        .to_string()
}

pub(crate) fn resolve_session_scope(metadata: &Value) -> Option<String> {
    if let Some(session) = metadata.get("sessionId").and_then(|v| v.as_str()) {
        let trimmed = session.trim();
        if !trimmed.is_empty() {
            return Some(format!("session:{}", trimmed));
        }
    }
    if let Some(conv) = metadata.get("conversationId").and_then(|v| v.as_str()) {
        let trimmed = conv.trim();
        if !trimmed.is_empty() {
            return Some(format!("conversation:{}", trimmed));
        }
    }
    None
}

fn read_metadata_token(metadata: &Value, key: &str) -> String {
    metadata
        .get(key)
        .and_then(|v| v.as_str())
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
        .unwrap_or_default()
}

pub(crate) fn resolve_stop_message_scope(metadata: &Value) -> Option<String> {
    let explicit = read_metadata_token(metadata, "stopMessageClientInjectSessionScope");
    let explicit = if !explicit.is_empty() {
        explicit
    } else {
        read_metadata_token(metadata, "stopMessageClientInjectScope")
    };
    if !explicit.is_empty() {
        if explicit.starts_with("tmux:")
            || explicit.starts_with("session:")
            || explicit.starts_with("conversation:")
        {
            return Some(explicit);
        }
    }
    let tmux_session = read_metadata_token(metadata, "clientTmuxSessionId");
    let tmux_session = if !tmux_session.is_empty() {
        tmux_session
    } else {
        read_metadata_token(metadata, "client_tmux_session_id")
    };
    let tmux_session = if !tmux_session.is_empty() {
        tmux_session
    } else {
        read_metadata_token(metadata, "tmuxSessionId")
    };
    let tmux_session = if !tmux_session.is_empty() {
        tmux_session
    } else {
        read_metadata_token(metadata, "tmux_session_id")
    };
    if !tmux_session.is_empty() {
        return Some(format!("tmux:{}", tmux_session));
    }
    resolve_session_scope(metadata)
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
