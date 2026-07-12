// feature_id: vr.metadata_center_surface
use serde_json::Value;

use super::utils::normalize_trimmed_string_values;
use crate::shared_json_utils::read_trimmed_string;

fn read_conversation_scope(metadata_center_snapshot: &Value) -> Option<String> {
    read_trimmed_string(metadata_center_snapshot.get("conversationId"))
        .map(|conversation_id| format!("conversation:{}", conversation_id))
}

fn resolve_continuation_request_chain_key(metadata_center_snapshot: &Value) -> Option<String> {
    let continuation = metadata_center_snapshot
        .get("continuation")
        .and_then(|v| v.as_object())?;
    let continuation_scope = read_trimmed_string(continuation.get("continuationScope"))
        .or_else(|| read_trimmed_string(continuation.get("stickyScope")))?;
    if continuation_scope != "request_chain" {
        return None;
    }
    read_trimmed_string(continuation.get("chainId")).or_else(|| {
        continuation
            .get("resumeFrom")
            .and_then(|v| v.as_object())
            .and_then(|resume_from| read_trimmed_string(resume_from.get("requestId")))
    })
}

fn resolve_continuation_sticky_scope_key(metadata_center_snapshot: &Value) -> Option<String> {
    let continuation = metadata_center_snapshot
        .get("continuation")
        .and_then(|v| v.as_object())?;
    let sticky_scope = read_trimmed_string(continuation.get("stickyScope"))
        .or_else(|| read_trimmed_string(continuation.get("continuationScope")))?;
    match sticky_scope.as_str() {
        "session" => read_trimmed_string(metadata_center_snapshot.get("sessionId"))
            .map(|session_id| format!("session:{}", session_id)),
        "conversation" => read_trimmed_string(metadata_center_snapshot.get("conversationId"))
            .map(|conversation_id| format!("conversation:{}", conversation_id)),
        "request" => read_trimmed_string(metadata_center_snapshot.get("requestId")),
        "request_chain" => resolve_continuation_request_chain_key(metadata_center_snapshot),
        _ => None,
    }
}

pub(crate) fn is_continuation_request(metadata_center_snapshot: &Value) -> bool {
    resolve_continuation_request_chain_key(metadata_center_snapshot).is_some()
}

pub(crate) fn resolve_routing_state_key(metadata_center_snapshot: &Value) -> String {
    if let Some(request_chain_key) =
        resolve_continuation_request_chain_key(metadata_center_snapshot)
    {
        return request_chain_key;
    }
    if let Some(sticky_scope_key) = resolve_continuation_sticky_scope_key(metadata_center_snapshot)
    {
        return sticky_scope_key;
    }

    read_trimmed_string(metadata_center_snapshot.get("requestId"))
        .unwrap_or_else(|| "default".to_string())
}

pub(crate) fn resolve_session_scope(metadata_center_snapshot: &Value) -> Option<String> {
    if let Some(session) = read_trimmed_string(metadata_center_snapshot.get("sessionId")) {
        return Some(format!("session:{}", session));
    }
    read_conversation_scope(metadata_center_snapshot)
}

pub(crate) fn resolve_stop_message_scope(metadata_center_snapshot: &Value) -> Option<String> {
    read_trimmed_string(metadata_center_snapshot.get("sessionId"))
        .map(|session| format!("session:{}", session))
}

pub(crate) fn is_server_tool_followup_request(metadata_center_snapshot: &Value) -> bool {
    metadata_center_snapshot
        .get("runtime_control")
        .and_then(|v| v.as_object())
        .and_then(|rt| rt.get("serverToolFollowup"))
        .and_then(|flag| flag.as_bool())
        .unwrap_or(false)
}

pub(crate) fn build_scoped_session_key(scope: &str) -> String {
    format!("{}::gemini", scope)
}

pub(crate) fn extract_excluded_provider_keys(metadata_center_snapshot: &Value) -> Vec<String> {
    let Some(list) = metadata_center_snapshot
        .get("excludedProviderKeys")
        .and_then(|v| v.as_array())
    else {
        return Vec::new();
    };
    normalize_trimmed_string_values(list.iter())
}

pub(crate) fn extract_runtime_now_ms(metadata_center_snapshot: &Value) -> Option<i64> {
    metadata_center_snapshot
        .get("runtimeControl")
        .and_then(|v| v.as_object())
        .and_then(|rt| rt.get("nowMs"))
        .and_then(|v| v.as_i64())
}

#[cfg(test)]
mod tests {
    use super::{
        is_continuation_request, is_server_tool_followup_request, resolve_routing_state_key,
        resolve_stop_message_scope,
    };
    use serde_json::json;

    #[test]
    fn prefers_unified_continuation_request_chain_key() {
        let metadata = json!({
            "metadataCenterSnapshot": {
                "runtimeControl": {
                    "providerProtocol": "openai-chat"
                },
                "requestId": "req_chat_cont_1",
                "sessionId": "session_should_lose",
                "continuation": {
                    "chainId": "req_chain_from_continuation",
                    "continuationScope": "request_chain",
                    "resumeFrom": {
                        "requestId": "req_chain_from_continuation"
                    }
                }
            }
        });

        assert_eq!(
            resolve_routing_state_key(&metadata["metadataCenterSnapshot"]),
            "req_chain_from_continuation".to_string()
        );
    }

    #[test]
    fn uses_explicit_session_continuation_scope() {
        let metadata = json!({
            "metadataCenterSnapshot": {
                "requestId": "req_session_scope",
                "sessionId": "session_should_win",
                "continuation": {
                    "continuationScope": "session"
                }
            }
        });

        assert_eq!(
            resolve_routing_state_key(&metadata["metadataCenterSnapshot"]),
            "session:session_should_win".to_string()
        );
    }

    #[test]
    fn uses_sticky_session_continuation_scope() {
        let metadata = json!({
            "metadataCenterSnapshot": {
                "requestId": "req_sticky_session_scope",
                "sessionId": "sticky_session_should_win",
                "continuation": {
                    "stickyScope": "session"
                }
            }
        });

        assert_eq!(
            resolve_routing_state_key(&metadata["metadataCenterSnapshot"]),
            "session:sticky_session_should_win".to_string()
        );
    }

    #[test]
    fn uses_explicit_request_continuation_scope() {
        let metadata = json!({
            "metadataCenterSnapshot": {
                "requestId": "req_request_scope",
                "sessionId": "session_should_lose",
                "continuation": {
                    "continuationScope": "request"
                }
            }
        });

        assert_eq!(
            resolve_routing_state_key(&metadata["metadataCenterSnapshot"]),
            "req_request_scope".to_string()
        );
    }

    #[test]
    fn prefers_continuation_chain_over_session_scope() {
        let metadata = json!({
            "metadataCenterSnapshot": {
                "runtimeControl": {
                    "providerProtocol": "openai-responses"
                },
                "requestId": "req_responses_2",
                "sessionId": "session_wins",
                "continuation": {
                    "chainId": "req_chain_root",
                    "continuationScope": "request_chain",
                    "resumeFrom": {
                        "requestId": "req_chain_root"
                    }
                }
            }
        });

        assert_eq!(
            resolve_routing_state_key(&metadata["metadataCenterSnapshot"]),
            "req_chain_root".to_string()
        );
    }

    #[test]
    fn falls_back_to_session_scope_for_non_responses_protocol() {
        let metadata = json!({
            "metadataCenterSnapshot": {
                "runtimeControl": {
                    "providerProtocol": "openai-chat"
                },
                "requestId": "req_chat_1",
                "sessionId": "session_1"
            }
        });

        assert_eq!(
            resolve_routing_state_key(&metadata["metadataCenterSnapshot"]),
            "req_chat_1".to_string()
        );
    }

    #[test]
    fn non_continuation_request_is_not_continuation() {
        let metadata = json!({
            "metadataCenterSnapshot": {
                "runtimeControl": {
                    "providerProtocol": "openai-responses"
                },
                "requestId": "req_1",
                "sessionId": "session_1"
            }
        });
        assert_eq!(
            is_continuation_request(&metadata["metadataCenterSnapshot"]),
            false
        );
    }

    #[test]
    fn request_chain_continuation_is_continuation_request() {
        let metadata = json!({
            "metadataCenterSnapshot": {
                "runtimeControl": {
                    "providerProtocol": "openai-responses"
                },
                "requestId": "req_2",
                "continuation": {
                    "continuationScope": "request_chain",
                    "resumeFrom": { "requestId": "req_1" }
                }
            }
        });
        assert_eq!(
            is_continuation_request(&metadata["metadataCenterSnapshot"]),
            true
        );
    }

    #[test]
    fn stop_message_scope_falls_back_to_plain_session_scope() {
        let metadata = json!({
            "metadataCenterSnapshot": {
                "runtimeControl": {
                    "providerProtocol": "openai-chat"
                },
                "requestId": "req_chat_cont_1",
                "sessionId": "session_should_not_become_stop_scope"
            }
        });

        assert_eq!(
            resolve_stop_message_scope(&metadata["metadataCenterSnapshot"]),
            Some("session:session_should_not_become_stop_scope".to_string())
        );
    }

    #[test]
    fn stop_message_scope_ignores_tmux_and_inject_fallbacks() {
        let metadata = json!({
            "metadataCenterSnapshot": {
                "runtimeControl": {
                    "providerProtocol": "openai-chat"
                },
                "requestId": "req_chat_tmux_scope_1",
                "sessionId": "session_should_lose",
                "tmuxSessionId": "tmux-session-1",
                "stopMessageClientInjectScope": "conversation:legacy",
                "stopMessageClientInjectSessionScope": "tmux:legacy"
            }
        });

        assert_eq!(
            resolve_stop_message_scope(&metadata["metadataCenterSnapshot"]),
            Some("session:session_should_lose".to_string())
        );
    }

    #[test]
    fn stop_message_scope_requires_session_id() {
        let metadata = json!({
            "metadataCenterSnapshot": {
                "runtimeControl": {
                    "providerProtocol": "openai-chat"
                },
                "requestId": "req_chat_tmux_scope_2",
                "tmuxSessionId": "tmux-session-2",
                "conversationId": "conversation-2",
                "stopMessageClientInjectScope": "conversation:legacy"
            }
        });

        assert_eq!(
            resolve_stop_message_scope(&metadata["metadataCenterSnapshot"]),
            None
        );
    }

    #[test]
    fn routing_state_prefers_runtime_control_provider_protocol() {
        let metadata = json!({
            "metadataCenterSnapshot": {
                "providerProtocol": "openai-chat",
                "requestId": "req_runtime_control_responses",
                "runtimeControl": {
                    "providerProtocol": "openai-responses"
                },
                "continuation": {
                    "chainId": "req_chain_runtime_control",
                    "continuationScope": "request_chain"
                }
            }
        });

        assert_eq!(
            resolve_routing_state_key(&metadata["metadataCenterSnapshot"]),
            "req_chain_runtime_control".to_string()
        );
    }

    #[test]
    fn servertool_followup_request_reads_runtime_control_only() {
        assert!(is_server_tool_followup_request(
            &json!({
                "metadataCenterSnapshot": {
                    "runtime_control": { "serverToolFollowup": true }
                },
                "serverToolFollowup": false,
                "__rt": { "serverToolFollowup": false }
            })["metadataCenterSnapshot"]
        ));
        assert!(!is_server_tool_followup_request(
            &json!({
                "metadataCenterSnapshot": {},
                "serverToolFollowup": true,
                "__rt": { "serverToolFollowup": true }
            })["metadataCenterSnapshot"]
        ));
        assert!(!is_server_tool_followup_request(
            &json!({
                "metadataCenterSnapshot": {
                    "runtime_control": { "serverToolFollowup": "true" }
                }
            })["metadataCenterSnapshot"]
        ));
    }
}
