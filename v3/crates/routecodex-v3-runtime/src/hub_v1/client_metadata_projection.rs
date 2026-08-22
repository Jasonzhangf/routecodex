use serde_json::Map;

const REGISTERED_CLIENT_LOCAL_METADATA_KEYS: &[&str] = &[
    "session_id",
    "thread_id",
    "turn_id",
    "forked_from_thread_id",
    "parent_turn_id",
    "root_turn_id",
    "x-codex-installation-id",
    "x-codex-turn-metadata",
    "x-codex-window-id",
    "x-codex-parent-thread-id",
    "x-openai-subagent",
];

pub(super) fn unsupported_client_metadata_paths(
    client_metadata: &Map<String, serde_json::Value>,
) -> Vec<String> {
    client_metadata
        .keys()
        .filter(|key| {
            key.as_str() != "user_id"
                && !REGISTERED_CLIENT_LOCAL_METADATA_KEYS.contains(&key.as_str())
        })
        .map(|key| format!("$.request.client_metadata.{key}"))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn codex_client_local_metadata_keys_are_registered() {
        let metadata = json!({
            "user_id": "u1",
            "parent_turn_id": "turn_123",
            "x-codex-parent-thread-id": "thread_456",
            "x-openai-subagent": "true",
            "x-codex-window-id": "win_1"
        });
        let paths = unsupported_client_metadata_paths(metadata.as_object().unwrap());
        assert!(
            paths.is_empty(),
            "Codex client-local metadata keys must be registered (silent projection, not fail-fast): {paths:?}"
        );
    }

    #[test]
    fn codex_root_turn_id_is_registered_client_local_metadata() {
        let metadata = json!({
            "root_turn_id": "01a01a18-7c4b-7411-8d6b-07edd690529a"
        });
        let paths = unsupported_client_metadata_paths(metadata.as_object().unwrap());
        assert!(
            paths.is_empty(),
            "Codex root_turn_id is local request context and must not be projected to provider wire: {paths:?}"
        );
    }

    #[test]
    fn unknown_client_metadata_keys_still_fail_fast() {
        let metadata = json!({
            "some_future_opaque_key": {"a": 1}
        });
        let paths = unsupported_client_metadata_paths(metadata.as_object().unwrap());
        assert_eq!(
            paths,
            vec!["$.request.client_metadata.some_future_opaque_key"]
        );
    }
}
