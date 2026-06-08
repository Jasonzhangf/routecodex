use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const STOP_MESSAGE_PERSISTED_LOOKUP_POLICY: &str = "strict_then_sticky_then_session_family";

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StopMessagePersistedLookupPlannerInput {
    pub record: Value,
    pub runtime_metadata: Option<Value>,
    pub options: Option<StopMessagePersistedLookupPlannerOptions>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StopMessagePersistedLookupPlannerOptions {
    pub include_snapshot_lookup: Option<bool>,
    pub include_tombstone_lookup: Option<bool>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StopMessagePersistedLookupPlanOutput {
    pub strict_session_scope: Option<String>,
    pub sticky_key: Option<String>,
    pub candidate_keys: Vec<String>,
    pub lookup_policy: String,
    pub read_stop_message_snapshot: bool,
    pub read_stop_message_tombstone: bool,
}

pub fn plan_stop_message_persisted_lookup(
    input: &StopMessagePersistedLookupPlannerInput,
) -> StopMessagePersistedLookupPlanOutput {
    let merged_metadata =
        merge_runtime_metadata_with_record(&input.record, input.runtime_metadata.as_ref());
    let (strict_session_scope, sticky_key, candidate_keys) =
        collect_stop_message_persisted_candidate_keys(&input.record, &merged_metadata);
    let options = input.options.as_ref();

    StopMessagePersistedLookupPlanOutput {
        strict_session_scope,
        sticky_key,
        candidate_keys,
        lookup_policy: STOP_MESSAGE_PERSISTED_LOOKUP_POLICY.to_string(),
        read_stop_message_snapshot: options
            .and_then(|options| options.include_snapshot_lookup)
            .unwrap_or(true),
        read_stop_message_tombstone: options
            .and_then(|options| options.include_tombstone_lookup)
            .unwrap_or(true),
    }
}

pub fn collect_stop_message_persisted_candidate_keys(
    direct_record: &Value,
    resolver_metadata: &Value,
) -> (Option<String>, Option<String>, Vec<String>) {
    let strict_session_scope = resolve_stop_message_session_scope(resolver_metadata);
    let sticky_key = Some(resolve_servertool_sticky_key(resolver_metadata))
        .filter(|value| !value.trim().is_empty());
    let row = direct_record.as_object();
    let mut candidate_keys: Vec<String> = Vec::new();

    let direct_tmux_keys = [
        row.and_then(|obj| read_trimmed_string(obj.get("tmuxSessionId"))),
        row.and_then(|obj| read_trimmed_string(obj.get("clientTmuxSessionId"))),
        row.and_then(|obj| read_trimmed_string(obj.get("tmux_session_id"))),
        row.and_then(|obj| read_trimmed_string(obj.get("client_tmux_session_id"))),
    ];
    for value in direct_tmux_keys.into_iter().flatten() {
        push_unique_scope_key(&mut candidate_keys, Some(format!("tmux:{}", value)));
    }

    if let Some(session_id) = row.and_then(|obj| read_trimmed_string(obj.get("sessionId"))) {
        push_unique_scope_key(&mut candidate_keys, Some(format!("tmux:{}", session_id)));
        push_unique_scope_key(&mut candidate_keys, Some(format!("session:{}", session_id)));
    }

    if let Some(conversation_id) =
        row.and_then(|obj| read_trimmed_string(obj.get("conversationId")))
    {
        push_unique_scope_key(
            &mut candidate_keys,
            Some(format!("conversation:{}", conversation_id)),
        );
    }

    if !candidate_keys.is_empty() {
        push_unique_scope_key(&mut candidate_keys, strict_session_scope.clone());
        push_unique_scope_key(&mut candidate_keys, sticky_key.clone());
    }

    (strict_session_scope, sticky_key, candidate_keys)
}

pub fn resolve_stop_message_session_scope(metadata: &Value) -> Option<String> {
    let row = metadata.as_object()?;
    if let Some(tmux_session_id) = read_trimmed_string(row.get("clientTmuxSessionId")) {
        return Some(format!("tmux:{tmux_session_id}"));
    }
    if let Some(tmux_session_id) = read_trimmed_string(row.get("client_tmux_session_id")) {
        return Some(format!("tmux:{tmux_session_id}"));
    }
    if let Some(tmux_session_id) = read_trimmed_string(row.get("tmuxSessionId")) {
        return Some(format!("tmux:{tmux_session_id}"));
    }
    if let Some(tmux_session_id) = read_trimmed_string(row.get("tmux_session_id")) {
        return Some(format!("tmux:{tmux_session_id}"));
    }
    if let Some(session_id) = read_trimmed_string(row.get("sessionId")) {
        return Some(format!("session:{session_id}"));
    }
    read_trimmed_string(row.get("conversationId"))
        .map(|conversation_id| format!("conversation:{conversation_id}"))
}

pub fn resolve_servertool_sticky_key(metadata: &Value) -> String {
    if let Some(scope) = resolve_stop_message_scope(metadata) {
        return scope;
    }
    if let Some(session_scope) = resolve_session_scope(metadata) {
        return session_scope;
    }
    resolve_routing_state_key(metadata)
}

fn merge_runtime_metadata_with_record(record: &Value, runtime_metadata: Option<&Value>) -> Value {
    match (record, runtime_metadata) {
        (Value::Object(record), Some(Value::Object(runtime))) => {
            let mut out = runtime.clone();
            for (key, value) in record {
                out.insert(key.clone(), value.clone());
            }
            Value::Object(out)
        }
        (record, _) => record.clone(),
    }
}

fn resolve_stop_message_scope(metadata: &Value) -> Option<String> {
    let explicit = read_trimmed_string(metadata.get("stopMessageClientInjectSessionScope"))
        .or_else(|| read_trimmed_string(metadata.get("stopMessageClientInjectScope")));
    if let Some(explicit) = explicit {
        if explicit.starts_with("tmux:")
            || explicit.starts_with("session:")
            || explicit.starts_with("conversation:")
        {
            return Some(explicit);
        }
    }

    read_trimmed_string(metadata.get("clientTmuxSessionId"))
        .or_else(|| read_trimmed_string(metadata.get("client_tmux_session_id")))
        .or_else(|| read_trimmed_string(metadata.get("tmuxSessionId")))
        .or_else(|| read_trimmed_string(metadata.get("tmux_session_id")))
        .map(|tmux_session_id| format!("tmux:{tmux_session_id}"))
}

fn resolve_session_scope(metadata: &Value) -> Option<String> {
    read_trimmed_string(metadata.get("sessionId"))
        .map(|session_id| format!("session:{session_id}"))
        .or_else(|| {
            read_trimmed_string(metadata.get("conversationId"))
                .map(|conversation_id| format!("conversation:{conversation_id}"))
        })
}

fn resolve_routing_state_key(metadata: &Value) -> String {
    if let Some(request_chain_key) = resolve_continuation_request_chain_key(metadata) {
        return request_chain_key;
    }

    if metadata.get("providerProtocol").and_then(Value::as_str) == Some("openai-responses") {
        if let Some(previous_request_id) = resolve_legacy_responses_request_chain_key(metadata) {
            return previous_request_id;
        }
        if let Some(request_id) = read_trimmed_string(metadata.get("requestId")) {
            return request_id;
        }
    }

    read_trimmed_string(metadata.get("requestId")).unwrap_or_else(|| "default".to_string())
}

fn resolve_continuation_request_chain_key(metadata: &Value) -> Option<String> {
    let continuation = metadata.get("continuation").and_then(Value::as_object)?;
    let continuation_scope = read_trimmed_string(continuation.get("continuationScope"))?;
    if continuation_scope != "request_chain" {
        return None;
    }
    read_trimmed_string(continuation.get("chainId")).or_else(|| {
        continuation
            .get("resumeFrom")
            .and_then(Value::as_object)
            .and_then(|resume_from| read_trimmed_string(resume_from.get("requestId")))
    })
}

fn resolve_legacy_responses_request_chain_key(metadata: &Value) -> Option<String> {
    metadata
        .get("responsesResume")
        .and_then(|resume| read_trimmed_string(resume.get("previousRequestId")))
}

fn push_unique_scope_key(out: &mut Vec<String>, value: Option<String>) {
    let Some(raw) = value else {
        return;
    };
    let normalized = raw.trim();
    if normalized.is_empty() {
        return;
    }
    if !out.iter().any(|entry| entry == normalized) {
        out.push(normalized.to_string());
    }
}

fn read_trimmed_string(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn plan_uses_stable_direct_candidate_order_and_dedupes() {
        let input = StopMessagePersistedLookupPlannerInput {
            record: json!({
                "tmuxSessionId": "tmux-a",
                "clientTmuxSessionId": "tmux-a",
                "sessionId": "sess-a",
                "conversationId": "conv-a"
            }),
            runtime_metadata: None,
            options: None,
        };

        let plan = plan_stop_message_persisted_lookup(&input);

        assert_eq!(plan.strict_session_scope.as_deref(), Some("tmux:tmux-a"));
        assert_eq!(plan.sticky_key.as_deref(), Some("tmux:tmux-a"));
        assert_eq!(
            plan.candidate_keys,
            vec![
                "tmux:tmux-a",
                "tmux:sess-a",
                "session:sess-a",
                "conversation:conv-a"
            ]
        );
        assert_eq!(plan.lookup_policy, STOP_MESSAGE_PERSISTED_LOOKUP_POLICY);
        assert!(plan.read_stop_message_snapshot);
        assert!(plan.read_stop_message_tombstone);
    }

    #[test]
    fn plan_appends_strict_scope_and_sticky_key_after_direct_family() {
        let input = StopMessagePersistedLookupPlannerInput {
            record: json!({
                "sessionId": "record-session"
            }),
            runtime_metadata: Some(json!({
                "clientTmuxSessionId": "runtime-tmux",
                "stopMessageClientInjectScope": "conversation:sticky-conv"
            })),
            options: None,
        };

        let plan = plan_stop_message_persisted_lookup(&input);

        assert_eq!(
            plan.strict_session_scope.as_deref(),
            Some("tmux:runtime-tmux")
        );
        assert_eq!(plan.sticky_key.as_deref(), Some("conversation:sticky-conv"));
        assert_eq!(
            plan.candidate_keys,
            vec![
                "tmux:record-session",
                "session:record-session",
                "tmux:runtime-tmux",
                "conversation:sticky-conv"
            ]
        );
    }

    #[test]
    fn record_metadata_overrides_runtime_metadata_for_scope_resolution() {
        let input = StopMessagePersistedLookupPlannerInput {
            record: json!({
                "sessionId": "record-session"
            }),
            runtime_metadata: Some(json!({
                "sessionId": "runtime-session",
                "conversationId": "runtime-conv"
            })),
            options: None,
        };

        let plan = plan_stop_message_persisted_lookup(&input);

        assert_eq!(
            plan.candidate_keys,
            vec!["tmux:record-session", "session:record-session"]
        );
        assert_eq!(
            plan.strict_session_scope.as_deref(),
            Some("session:record-session")
        );
        assert_eq!(plan.sticky_key.as_deref(), Some("session:record-session"));
    }

    #[test]
    fn options_only_control_snapshot_and_tombstone_reads() {
        let input = StopMessagePersistedLookupPlannerInput {
            record: json!({
                "conversationId": "conv-a"
            }),
            runtime_metadata: None,
            options: Some(StopMessagePersistedLookupPlannerOptions {
                include_snapshot_lookup: Some(false),
                include_tombstone_lookup: Some(false),
            }),
        };

        let plan = plan_stop_message_persisted_lookup(&input);

        assert_eq!(plan.candidate_keys, vec!["conversation:conv-a"]);
        assert!(!plan.read_stop_message_snapshot);
        assert!(!plan.read_stop_message_tombstone);
    }

    #[test]
    fn runtime_metadata_alone_does_not_synthesize_candidate_keys() {
        let input = StopMessagePersistedLookupPlannerInput {
            record: json!({}),
            runtime_metadata: Some(json!({
                "sessionId": "runtime-session"
            })),
            options: None,
        };

        let plan = plan_stop_message_persisted_lookup(&input);

        assert_eq!(
            plan.strict_session_scope.as_deref(),
            Some("session:runtime-session")
        );
        assert_eq!(plan.sticky_key.as_deref(), Some("session:runtime-session"));
        assert!(plan.candidate_keys.is_empty());
    }

    #[test]
    fn sticky_key_preserves_request_chain_before_request_id_default() {
        assert_eq!(
            resolve_servertool_sticky_key(&json!({
                "continuation": {
                    "continuationScope": "request_chain",
                    "resumeFrom": { "requestId": "req-parent" }
                },
                "requestId": "req-child"
            })),
            "req-parent"
        );
        assert_eq!(resolve_servertool_sticky_key(&json!({})), "default");
    }
}
