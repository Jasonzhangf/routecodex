use serde::{Deserialize, Serialize};

/// Servertools that are projected into the client protocol as `exec_command`.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ServertoolOutcome {
    ClientExecCliProjection,
}

pub fn classify_servertool_outcome(tool_name: &str) -> Option<ServertoolOutcome> {
    match tool_name {
        "servertool_fixture" | "web_search" | "vision_auto" => {
            Some(ServertoolOutcome::ClientExecCliProjection)
        }
        _ => None,
    }
}

pub fn is_client_exec_cli_projection(tool_name: &str) -> bool {
    classify_servertool_outcome(tool_name) == Some(ServertoolOutcome::ClientExecCliProjection)
}

pub const DENIED_CLI_MARKERS: &[&str] = &[
    "--ticket",
    "stcli_",
    "rcc_cli_",
    "old_cli_",
    "old_cli_result_",
];

pub fn contains_denied_cli_marker(command: &str) -> bool {
    DENIED_CLI_MARKERS
        .iter()
        .any(|marker| command.contains(marker))
}

pub const DENIED_CLI_PROJECTION_TOOLS: &[&str] = &["fake_exec"];

pub fn is_denied_cli_projection(tool_name: &str) -> bool {
    DENIED_CLI_PROJECTION_TOOLS.contains(&tool_name)
}

pub fn quote_posix_single_argument(raw: &str) -> String {
    format!("'{}'", raw.replace('\'', "'\\''"))
}
