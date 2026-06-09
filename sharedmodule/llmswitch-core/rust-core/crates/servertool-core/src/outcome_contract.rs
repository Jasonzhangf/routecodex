use serde::{Deserialize, Serialize};
use serde_json::Value;

/// The three outcome types for servertool interception in HubRespChatProcess03Governed.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum ServertoolOutcome {
    /// stop_message_auto / servertool_fixture -> client-visible exec_command CLI projection
    ClientExecCliProjection,
    /// web_search / vision_auto -> server-side backend route reenter, not visible to client
    BackendRouteReenter,
    /// memory_cache_auto -> server IO only, no client projection
    ServerIoInternal,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ServertoolHubRespChatProcess03Input {
    pub tool_name: String,
    pub flow_id: Option<String>,
    pub input: Value,
    pub repeat_count: Option<u32>,
    pub max_repeats: Option<u32>,
    pub reasoning_text: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ServertoolClientExecCliProjection01Planned {
    pub tool_name: String,
    pub flow_id: String,
    pub exec_command: String,
    pub input: Value,
    pub repeat_count: u32,
    pub max_repeats: u32,
    pub reasoning_text: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ServertoolBackendRouteHint01Planned {
    pub tool_name: String,
    pub flow_id: String,
    pub input: Value,
    pub route_hint: String,
    pub reasoning_text: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ServertoolServerIoInternal01Observed {
    pub tool_name: String,
    pub flow_id: String,
    pub input: Value,
    pub internal_kind: String,
}

#[derive(Debug, Clone, PartialEq)]
pub enum ServertoolOutcomeError {
    UnsupportedTool(String),
    WrongOutcome {
        tool_name: String,
        expected: ServertoolOutcome,
        actual: ServertoolOutcome,
    },
    DeniedTool(String),
    DeniedMarker(&'static str),
    DeniedInternalCarrier(&'static str),
    MissingField(&'static str),
    InvalidField(&'static str),
}

impl std::fmt::Display for ServertoolOutcomeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ServertoolOutcomeError::UnsupportedTool(tool) => {
                write!(f, "SERVERTOOL_UNSUPPORTED_TOOL: {tool}")
            }
            ServertoolOutcomeError::WrongOutcome {
                tool_name,
                expected,
                actual,
            } => write!(
                f,
                "SERVERTOOL_OUTCOME_MISMATCH: {tool_name} expected {expected:?} actual {actual:?}"
            ),
            ServertoolOutcomeError::DeniedTool(tool) => {
                write!(f, "SERVERTOOL_DENIED_TOOL: {tool}")
            }
            ServertoolOutcomeError::DeniedMarker(marker) => {
                write!(f, "SERVERTOOL_DENIED_CLI_MARKER: {marker}")
            }
            ServertoolOutcomeError::DeniedInternalCarrier(carrier) => {
                write!(f, "SERVERTOOL_DENIED_INTERNAL_CARRIER: {carrier}")
            }
            ServertoolOutcomeError::MissingField(field) => {
                write!(f, "SERVERTOOL_OUTCOME_MISSING_FIELD: {field}")
            }
            ServertoolOutcomeError::InvalidField(field) => {
                write!(f, "SERVERTOOL_OUTCOME_INVALID_FIELD: {field}")
            }
        }
    }
}

impl std::error::Error for ServertoolOutcomeError {}

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
pub const DENIED_CLI_MARKERS: &[&str] = &[
    "--ticket",
    "stcli_",
    "rcc_cli_",
    "old_cli_",
    "old_cli_result_",
];

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

pub fn build_servertool_client_exec_cli_projection_01_from_hub_resp_chatprocess_03(
    input: ServertoolHubRespChatProcess03Input,
) -> Result<ServertoolClientExecCliProjection01Planned, ServertoolOutcomeError> {
    validate_outcome(&input.tool_name, ServertoolOutcome::ClientExecCliProjection)?;
    validate_no_internal_carrier(&input.input)?;
    let flow_id = match input.tool_name.as_str() {
        "stop_message_auto" => {
            let flow_id = resolve_flow_id(&input, "stop_message_flow")?;
            if flow_id != "stop_message_flow" {
                return Err(ServertoolOutcomeError::InvalidField("flowId"));
            }
            flow_id
        }
        _ => resolve_flow_id(&input, "servertool_cli_projection")?,
    };
    let repeat_count = input
        .repeat_count
        .or_else(|| read_u32(&input.input, "repeatCount"))
        .unwrap_or(0);
    let max_repeats = input
        .max_repeats
        .or_else(|| read_u32(&input.input, "maxRepeats"))
        .unwrap_or(0);
    if input.tool_name == "stop_message_auto" {
        if max_repeats == 0 || repeat_count > max_repeats {
            return Err(ServertoolOutcomeError::InvalidField(
                "repeatCount/maxRepeats",
            ));
        }
        let continuation_prompt = read_non_empty_string(&input.input, "continuationPrompt")?;
        let payload = serde_json::json!({
            "flowId": flow_id,
            "continuationPrompt": continuation_prompt,
            "repeatCount": repeat_count,
            "maxRepeats": max_repeats
        });
        let exec_command = build_exec_command(&input.tool_name, &payload)?;
        validate_no_denied_cli_marker(&exec_command)?;
        return Ok(ServertoolClientExecCliProjection01Planned {
            tool_name: input.tool_name,
            flow_id,
            exec_command,
            input: payload,
            repeat_count,
            max_repeats,
            reasoning_text: input.reasoning_text,
        });
    }

    let exec_command = build_exec_command(&input.tool_name, &input.input)?;
    validate_no_denied_cli_marker(&exec_command)?;
    Ok(ServertoolClientExecCliProjection01Planned {
        tool_name: input.tool_name,
        flow_id,
        exec_command,
        input: input.input,
        repeat_count,
        max_repeats,
        reasoning_text: input.reasoning_text,
    })
}

pub fn build_servertool_backend_route_hint_01_from_hub_resp_chatprocess_03(
    input: ServertoolHubRespChatProcess03Input,
) -> Result<ServertoolBackendRouteHint01Planned, ServertoolOutcomeError> {
    validate_outcome(&input.tool_name, ServertoolOutcome::BackendRouteReenter)?;
    validate_no_internal_carrier(&input.input)?;
    let flow_id = resolve_flow_id(&input, "servertool_backend_route")?;
    Ok(ServertoolBackendRouteHint01Planned {
        route_hint: match input.tool_name.as_str() {
            "web_search" => "servertool_backend_route:web_search".to_string(),
            "vision_auto" => "servertool_backend_route:vision_auto".to_string(),
            _ => return Err(ServertoolOutcomeError::InvalidField("toolName")),
        },
        tool_name: input.tool_name,
        flow_id,
        input: input.input,
        reasoning_text: input.reasoning_text,
    })
}

pub fn build_servertool_server_io_internal_01_from_hub_resp_chatprocess_03(
    input: ServertoolHubRespChatProcess03Input,
) -> Result<ServertoolServerIoInternal01Observed, ServertoolOutcomeError> {
    validate_outcome(&input.tool_name, ServertoolOutcome::ServerIoInternal)?;
    validate_no_internal_carrier(&input.input)?;
    let flow_id = resolve_flow_id(&input, "servertool_server_io_internal")?;
    Ok(ServertoolServerIoInternal01Observed {
        tool_name: input.tool_name,
        flow_id,
        input: input.input,
        internal_kind: "server_io_internal:memory_cache".to_string(),
    })
}

fn validate_outcome(
    tool_name: &str,
    expected: ServertoolOutcome,
) -> Result<(), ServertoolOutcomeError> {
    if is_denied_cli_projection(tool_name) {
        return Err(ServertoolOutcomeError::DeniedTool(tool_name.to_string()));
    }
    let actual = classify_servertool_outcome(tool_name)
        .ok_or_else(|| ServertoolOutcomeError::UnsupportedTool(tool_name.to_string()))?;
    if actual != expected {
        return Err(ServertoolOutcomeError::WrongOutcome {
            tool_name: tool_name.to_string(),
            expected,
            actual,
        });
    }
    Ok(())
}

fn resolve_flow_id(
    input: &ServertoolHubRespChatProcess03Input,
    default_flow_id: &'static str,
) -> Result<String, ServertoolOutcomeError> {
    if let Some(flow_id) = input
        .flow_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        return Ok(flow_id.to_string());
    }
    if let Some(flow_id) = input
        .input
        .get("flowId")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        return Ok(flow_id.to_string());
    }
    Ok(default_flow_id.to_string())
}

fn build_exec_command(tool_name: &str, input: &Value) -> Result<String, ServertoolOutcomeError> {
    if !is_safe_tool_name(tool_name) {
        return Err(ServertoolOutcomeError::InvalidField("toolName"));
    }
    if !input.is_object() {
        return Err(ServertoolOutcomeError::InvalidField("input"));
    }
    let input_json =
        serde_json::to_string(input).map_err(|_| ServertoolOutcomeError::InvalidField("input"))?;
    let command = format!(
        "routecodex servertool run {tool_name} --input-json {}",
        quote_posix_single_argument(&input_json)
    );
    validate_no_denied_cli_marker(&command)?;
    Ok(command)
}

pub fn quote_posix_single_argument(raw: &str) -> String {
    let mut quoted = String::with_capacity(raw.len() + 2);
    quoted.push('\'');
    for ch in raw.chars() {
        if ch == '\'' {
            quoted.push_str("'\\''");
        } else {
            quoted.push(ch);
        }
    }
    quoted.push('\'');
    quoted
}

fn validate_no_denied_cli_marker(command: &str) -> Result<(), ServertoolOutcomeError> {
    for marker in DENIED_CLI_MARKERS {
        if command.contains(marker) {
            return Err(ServertoolOutcomeError::DeniedMarker(marker));
        }
    }
    Ok(())
}

const DENIED_INTERNAL_CARRIER_KEYS: &[&str] = &[
    "__rt",
    "__nativeResponsePlan",
    "metadata",
    "metaCarrier",
    "snapshot",
    "debug",
    "debugCarrier",
    "ticket",
];

fn validate_no_internal_carrier(value: &Value) -> Result<(), ServertoolOutcomeError> {
    match value {
        Value::Object(map) => {
            for key in map.keys() {
                for denied in DENIED_INTERNAL_CARRIER_KEYS {
                    if key == denied {
                        return Err(ServertoolOutcomeError::DeniedInternalCarrier(denied));
                    }
                }
            }
            for item in map.values() {
                validate_no_internal_carrier(item)?;
            }
        }
        Value::Array(items) => {
            for item in items {
                validate_no_internal_carrier(item)?;
            }
        }
        Value::String(text) => {
            for denied in DENIED_INTERNAL_CARRIER_KEYS {
                if text.contains(denied) {
                    return Err(ServertoolOutcomeError::DeniedInternalCarrier(denied));
                }
            }
        }
        _ => {}
    }
    Ok(())
}

fn is_safe_tool_name(tool_name: &str) -> bool {
    !tool_name.is_empty()
        && tool_name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.'))
}

fn read_non_empty_string(
    value: &Value,
    field: &'static str,
) -> Result<String, ServertoolOutcomeError> {
    value
        .get(field)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .ok_or(ServertoolOutcomeError::MissingField(field))
}

fn read_u32(value: &Value, field: &'static str) -> Option<u32> {
    value
        .get(field)
        .and_then(Value::as_u64)
        .and_then(|number| u32::try_from(number).ok())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

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
    fn unknown_tool_is_rejected_by_projection_builder() {
        let err = build_servertool_client_exec_cli_projection_01_from_hub_resp_chatprocess_03(
            ServertoolHubRespChatProcess03Input {
                tool_name: "unknown_tool".to_string(),
                flow_id: None,
                input: json!({}),
                repeat_count: None,
                max_repeats: None,
                reasoning_text: None,
            },
        )
        .expect_err("unknown tool must fail-fast");
        assert_eq!(
            err,
            ServertoolOutcomeError::UnsupportedTool("unknown_tool".to_string())
        );
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
        assert!(DENIED_CLI_MARKERS.contains(&"--ticket"));
        assert!(DENIED_CLI_MARKERS.contains(&"stcli_"));
        assert!(DENIED_CLI_MARKERS.contains(&"rcc_cli_"));
        assert!(DENIED_CLI_MARKERS.contains(&"old_cli_"));
        assert!(DENIED_CLI_MARKERS.contains(&"old_cli_result_"));
        assert!(contains_denied_cli_marker("cmd --ticket abc"));
        assert!(contains_denied_cli_marker("cmd stcli_123"));
        assert!(contains_denied_cli_marker("cmd rcc_cli_123"));
        assert!(contains_denied_cli_marker("cmd old_cli_123"));
        assert!(contains_denied_cli_marker("cmd old_cli_result_123"));
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

    #[test]
    fn builds_stop_message_auto_client_exec_projection_plan() {
        let plan = build_servertool_client_exec_cli_projection_01_from_hub_resp_chatprocess_03(
            ServertoolHubRespChatProcess03Input {
                tool_name: "stop_message_auto".to_string(),
                flow_id: Some("stop_message_flow".to_string()),
                input: json!({
                    "continuationPrompt": "continue with full schema",
                    "repeatCount": 1,
                    "maxRepeats": 3
                }),
                repeat_count: None,
                max_repeats: None,
                reasoning_text: Some("intercepted stop text".to_string()),
            },
        )
        .expect("projection plan");
        assert_eq!(plan.tool_name, "stop_message_auto");
        assert_eq!(plan.flow_id, "stop_message_flow");
        assert_eq!(plan.repeat_count, 1);
        assert_eq!(plan.max_repeats, 3);
        assert_eq!(plan.input["flowId"], "stop_message_flow");
        assert!(plan
            .exec_command
            .contains("routecodex servertool run stop_message_auto"));
        assert!(!contains_denied_cli_marker(&plan.exec_command));
    }

    #[test]
    fn builds_fixture_client_exec_projection_plan() {
        let plan = build_servertool_client_exec_cli_projection_01_from_hub_resp_chatprocess_03(
            ServertoolHubRespChatProcess03Input {
                tool_name: "servertool_fixture".to_string(),
                flow_id: None,
                input: json!({"value":1}),
                repeat_count: None,
                max_repeats: None,
                reasoning_text: None,
            },
        )
        .expect("fixture projection plan");
        assert_eq!(plan.flow_id, "servertool_cli_projection");
        assert_eq!(
            plan.exec_command,
            "routecodex servertool run servertool_fixture --input-json '{\"value\":1}'"
        );
    }

    #[test]
    fn client_exec_projection_shell_quotes_json_apostrophes() {
        let plan = build_servertool_client_exec_cli_projection_01_from_hub_resp_chatprocess_03(
            ServertoolHubRespChatProcess03Input {
                tool_name: "servertool_fixture".to_string(),
                flow_id: None,
                input: json!({"value":"can't stop"}),
                repeat_count: None,
                max_repeats: None,
                reasoning_text: None,
            },
        )
        .expect("fixture projection plan");
        assert_eq!(
            plan.exec_command,
            "routecodex servertool run servertool_fixture --input-json '{\"value\":\"can'\\''t stop\"}'"
        );
    }

    #[test]
    fn web_search_cannot_build_client_exec_projection_plan() {
        let err = build_servertool_client_exec_cli_projection_01_from_hub_resp_chatprocess_03(
            ServertoolHubRespChatProcess03Input {
                tool_name: "web_search".to_string(),
                flow_id: None,
                input: json!({"query":"x"}),
                repeat_count: None,
                max_repeats: None,
                reasoning_text: None,
            },
        )
        .expect_err("web_search must not be client exec projection");
        assert_eq!(
            err,
            ServertoolOutcomeError::WrongOutcome {
                tool_name: "web_search".to_string(),
                expected: ServertoolOutcome::ClientExecCliProjection,
                actual: ServertoolOutcome::BackendRouteReenter
            }
        );
    }

    #[test]
    fn builds_web_search_backend_route_hint() {
        let plan = build_servertool_backend_route_hint_01_from_hub_resp_chatprocess_03(
            ServertoolHubRespChatProcess03Input {
                tool_name: "web_search".to_string(),
                flow_id: None,
                input: json!({"query":"x"}),
                repeat_count: None,
                max_repeats: None,
                reasoning_text: Some("need web search".to_string()),
            },
        )
        .expect("backend route plan");
        assert_eq!(plan.flow_id, "servertool_backend_route");
        assert_eq!(plan.route_hint, "servertool_backend_route:web_search");
    }

    #[test]
    fn vision_auto_cannot_build_client_exec_projection_plan() {
        let err = build_servertool_client_exec_cli_projection_01_from_hub_resp_chatprocess_03(
            ServertoolHubRespChatProcess03Input {
                tool_name: "vision_auto".to_string(),
                flow_id: None,
                input: json!({"image":"x"}),
                repeat_count: None,
                max_repeats: None,
                reasoning_text: None,
            },
        )
        .expect_err("vision_auto must not be client exec projection");
        assert_eq!(
            err,
            ServertoolOutcomeError::WrongOutcome {
                tool_name: "vision_auto".to_string(),
                expected: ServertoolOutcome::ClientExecCliProjection,
                actual: ServertoolOutcome::BackendRouteReenter
            }
        );
    }

    #[test]
    fn builds_memory_cache_server_io_internal_observation() {
        let observed = build_servertool_server_io_internal_01_from_hub_resp_chatprocess_03(
            ServertoolHubRespChatProcess03Input {
                tool_name: "memory_cache_auto".to_string(),
                flow_id: None,
                input: json!({"key":"x"}),
                repeat_count: None,
                max_repeats: None,
                reasoning_text: None,
            },
        )
        .expect("server io observation");
        assert_eq!(observed.flow_id, "servertool_server_io_internal");
        assert_eq!(observed.internal_kind, "server_io_internal:memory_cache");
    }

    #[test]
    fn memory_cache_auto_is_rejected_by_client_projection_builder() {
        let err = build_servertool_client_exec_cli_projection_01_from_hub_resp_chatprocess_03(
            ServertoolHubRespChatProcess03Input {
                tool_name: "memory_cache_auto".to_string(),
                flow_id: None,
                input: json!({"key":"x"}),
                repeat_count: None,
                max_repeats: None,
                reasoning_text: None,
            },
        )
        .expect_err("memory_cache_auto must not project to client exec");
        assert_eq!(
            err,
            ServertoolOutcomeError::WrongOutcome {
                tool_name: "memory_cache_auto".to_string(),
                expected: ServertoolOutcome::ClientExecCliProjection,
                actual: ServertoolOutcome::ServerIoInternal
            }
        );
    }

    #[test]
    fn memory_cache_auto_is_rejected_by_backend_route_builder() {
        let err = build_servertool_backend_route_hint_01_from_hub_resp_chatprocess_03(
            ServertoolHubRespChatProcess03Input {
                tool_name: "memory_cache_auto".to_string(),
                flow_id: None,
                input: json!({"key":"x"}),
                repeat_count: None,
                max_repeats: None,
                reasoning_text: None,
            },
        )
        .expect_err("memory_cache_auto must not be backend route");
        assert_eq!(
            err,
            ServertoolOutcomeError::WrongOutcome {
                tool_name: "memory_cache_auto".to_string(),
                expected: ServertoolOutcome::BackendRouteReenter,
                actual: ServertoolOutcome::ServerIoInternal
            }
        );
    }

    #[test]
    fn fake_exec_is_denied_by_projection_builder() {
        let err = build_servertool_client_exec_cli_projection_01_from_hub_resp_chatprocess_03(
            ServertoolHubRespChatProcess03Input {
                tool_name: "fake_exec".to_string(),
                flow_id: None,
                input: json!({}),
                repeat_count: None,
                max_repeats: None,
                reasoning_text: None,
            },
        )
        .expect_err("fake_exec must be denied");
        assert_eq!(
            err,
            ServertoolOutcomeError::DeniedTool("fake_exec".to_string())
        );
    }

    #[test]
    fn denied_marker_in_projection_input_fails_fast() {
        let err = build_servertool_client_exec_cli_projection_01_from_hub_resp_chatprocess_03(
            ServertoolHubRespChatProcess03Input {
                tool_name: "servertool_fixture".to_string(),
                flow_id: None,
                input: json!({"value":"old_cli_result_123"}),
                repeat_count: None,
                max_repeats: None,
                reasoning_text: None,
            },
        )
        .expect_err("old marker must be denied");
        assert_eq!(err, ServertoolOutcomeError::DeniedMarker("old_cli_"));
    }

    #[test]
    fn internal_carrier_in_projection_input_fails_fast() {
        let err = build_servertool_client_exec_cli_projection_01_from_hub_resp_chatprocess_03(
            ServertoolHubRespChatProcess03Input {
                tool_name: "servertool_fixture".to_string(),
                flow_id: None,
                input: json!({"metadata":{"debug":true}}),
                repeat_count: None,
                max_repeats: None,
                reasoning_text: None,
            },
        )
        .expect_err("internal carrier must be denied");
        assert_eq!(
            err,
            ServertoolOutcomeError::DeniedInternalCarrier("metadata")
        );
    }

    #[test]
    fn internal_carrier_in_backend_route_hint_fails_fast() {
        let err = build_servertool_backend_route_hint_01_from_hub_resp_chatprocess_03(
            ServertoolHubRespChatProcess03Input {
                tool_name: "web_search".to_string(),
                flow_id: None,
                input: json!({"__rt":{"requestId":"req_internal"}}),
                repeat_count: None,
                max_repeats: None,
                reasoning_text: None,
            },
        )
        .expect_err("internal carrier must be denied");
        assert_eq!(err, ServertoolOutcomeError::DeniedInternalCarrier("__rt"));
    }

    #[test]
    fn internal_carrier_in_server_io_observation_fails_fast() {
        let err = build_servertool_server_io_internal_01_from_hub_resp_chatprocess_03(
            ServertoolHubRespChatProcess03Input {
                tool_name: "memory_cache_auto".to_string(),
                flow_id: None,
                input: json!({"snapshot":{"requestId":"req_internal"}}),
                repeat_count: None,
                max_repeats: None,
                reasoning_text: None,
            },
        )
        .expect_err("internal carrier must be denied");
        assert_eq!(
            err,
            ServertoolOutcomeError::DeniedInternalCarrier("snapshot")
        );
    }

    #[test]
    fn stop_message_auto_requires_valid_repeat_budget() {
        let err = build_servertool_client_exec_cli_projection_01_from_hub_resp_chatprocess_03(
            ServertoolHubRespChatProcess03Input {
                tool_name: "stop_message_auto".to_string(),
                flow_id: Some("stop_message_flow".to_string()),
                input: json!({
                    "continuationPrompt": "continue",
                    "repeatCount": 4,
                    "maxRepeats": 3
                }),
                repeat_count: None,
                max_repeats: None,
                reasoning_text: None,
            },
        )
        .expect_err("invalid budget must fail");
        assert_eq!(
            err,
            ServertoolOutcomeError::InvalidField("repeatCount/maxRepeats")
        );
    }
}
