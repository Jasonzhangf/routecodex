use serde_json::Map;

const REGISTERED_CLIENT_LOCAL_METADATA_KEYS: &[&str] = &[
    "session_id",
    "thread_id",
    "turn_id",
    "forked_from_thread_id",
    "x-codex-installation-id",
    "x-codex-turn-metadata",
    "x-codex-window-id",
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
