use serde::{Deserialize, Serialize};

/// The three outcome types for servertool interception in HubRespChatProcess03Governed.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum ServertoolOutcome {
    /// stop_message_auto / review / servertool_fixture -> client-visible exec_command CLI projection
    ClientExecCliProjection,
    /// web_search / vision_auto -> server-side backend route reenter, not visible to client
    BackendRouteReenter,
    /// memory_cache_auto -> server IO only, no client projection
    ServerIoInternal,
}

/// Classify a servertool tool name into its outcome type.
///
/// Returns `None` for unknown tool names (not a registered servertool).
pub fn classify_servertool_outcome(tool_name: &str) -> Option<ServertoolOutcome> {
    match tool_name {
        "stop_message_auto" | "servertool_fixture" => {
            Some(ServertoolOutcome::ClientExecCliProjection)
        }
        "web_search" | "vision_auto" => Some(ServertoolOutcome::BackendRouteReenter),
        "memory_cache_auto" => Some(ServertoolOutcome::ServerIoInternal),
        _ => None,
    }
}

/// Check if a tool name is eligible for client-visible exec_command projection.
pub fn is_client_exec_cli_projection(tool_name: &str) -> bool {
    classify_servertool_outcome(tool_name) == Some(ServertoolOutcome::ClientExecCliProjection)
}

/// Denied marker patterns that must never appear in servertool CLI commands.
pub const DENIED_CLI_MARKERS: &[&str] = &["--ticket", "stcli_", "rcc_cli_"];

/// Check if a CLI command string contains any denied marker.
pub fn contains_denied_cli_marker(cmd: &str) -> bool {
    DENIED_CLI_MARKERS.iter().any(|marker| cmd.contains(marker))
}

/// Denied tool names that must never be classified as ClientExecCliProjection.
pub const DENIED_CLI_PROJECTION_TOOLS: &[&str] = &["fake_exec"];

/// Check if a tool name is denied from client exec CLI projection.
pub fn is_denied_cli_projection(tool_name: &str) -> bool {
    DENIED_CLI_PROJECTION_TOOLS.contains(&tool_name)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stop_message_auto_is_client_exec_cli_projection() {
        assert_eq!(
            classify_servertool_outcome("stop_message_auto"),
            Some(ServertoolOutcome::ClientExecCliProjection)
        );
    }

    #[test]
    fn servertool_fixture_is_client_exec_cli_projection() {
        assert_eq!(
            classify_servertool_outcome("servertool_fixture"),
            Some(ServertoolOutcome::ClientExecCliProjection)
        );
    }

    #[test]
    fn web_search_is_backend_route_reenter() {
        assert_eq!(
            classify_servertool_outcome("web_search"),
            Some(ServertoolOutcome::BackendRouteReenter)
        );
    }

    #[test]
    fn vision_auto_is_backend_route_reenter() {
        assert_eq!(
            classify_servertool_outcome("vision_auto"),
            Some(ServertoolOutcome::BackendRouteReenter)
        );
    }

    #[test]
    fn memory_cache_auto_is_server_io_internal() {
        assert_eq!(
            classify_servertool_outcome("memory_cache_auto"),
            Some(ServertoolOutcome::ServerIoInternal)
        );
    }

    #[test]
    fn unknown_tool_returns_none() {
        assert_eq!(classify_servertool_outcome("unknown_tool"), None);
    }

    #[test]
    fn web_search_is_not_client_exec_cli_projection() {
        assert!(!is_client_exec_cli_projection("web_search"));
    }

    #[test]
    fn vision_auto_is_not_client_exec_cli_projection() {
        assert!(!is_client_exec_cli_projection("vision_auto"));
    }

    #[test]
    fn denied_cli_markers_detected() {
        assert!(contains_denied_cli_marker("cmd --ticket abc"));
        assert!(contains_denied_cli_marker("cmd stcli_123"));
        assert!(contains_denied_cli_marker("cmd rcc_cli_123"));
    }

    #[test]
    fn clean_command_has_no_denied_markers() {
        let cmd = "routecodex servertool run stop_message_auto --input-json '{}'";
        assert!(!contains_denied_cli_marker(cmd));
    }

    #[test]
    fn fake_exec_is_denied_from_cli_projection() {
        assert!(is_denied_cli_projection("fake_exec"));
        assert!(!is_client_exec_cli_projection("fake_exec"));
    }

    #[test]
    fn restore_is_not_a_servertool_outcome() {
        assert_eq!(classify_servertool_outcome("restore"), None);
        assert_eq!(classify_servertool_outcome("restoration"), None);
    }
}
