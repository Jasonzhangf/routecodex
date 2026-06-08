use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::outcome_contract::{
    build_servertool_backend_route_hint_01_from_hub_resp_chatprocess_03,
    ServertoolHubRespChatProcess03Input, ServertoolOutcomeError,
};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ServertoolBackendRoutePolicyInput {
    pub tool_name: String,
    pub flow_id: Option<String>,
    pub input: Value,
    pub entry_endpoint: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ServertoolBackendRoutePolicy01Planned {
    pub tool_name: String,
    pub flow_id: String,
    pub route_hint: String,
    pub execution_mode: ServertoolBackendRouteExecutionMode,
    pub shape_guard: ServertoolBackendRouteShapeGuard,
    pub origin_delta: ServertoolBackendRouteOriginDelta,
    pub finalize: ServertoolBackendRouteFinalizePolicy,
    pub input: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum ServertoolBackendRouteExecutionMode {
    Reenter,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ServertoolBackendRouteShapeGuard {
    pub allow_requires_action: bool,
    pub preserve_streaming: bool,
    pub fail_on_missing_payload: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ServertoolBackendRouteOriginDelta {
    pub requires_origin_seed: bool,
    pub apply_assistant_delta: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ServertoolBackendRouteFinalizePolicy {
    pub context_decoration_mode: Option<String>,
    pub short_circuit_requires_action: bool,
}

pub fn plan_servertool_backend_route_policy_01_from_hub_resp_chatprocess_03(
    input: ServertoolBackendRoutePolicyInput,
) -> Result<ServertoolBackendRoutePolicy01Planned, ServertoolOutcomeError> {
    let hint = build_servertool_backend_route_hint_01_from_hub_resp_chatprocess_03(
        ServertoolHubRespChatProcess03Input {
            tool_name: input.tool_name,
            flow_id: input.flow_id,
            input: input.input,
            repeat_count: None,
            max_repeats: None,
            reasoning_text: None,
        },
    )?;
    let policy = match hint.tool_name.as_str() {
        "web_search" => ServertoolBackendRoutePolicy01Planned {
            tool_name: hint.tool_name,
            flow_id: normalize_flow_id(&hint.flow_id, "web_search_flow"),
            route_hint: hint.route_hint,
            execution_mode: ServertoolBackendRouteExecutionMode::Reenter,
            shape_guard: ServertoolBackendRouteShapeGuard {
                allow_requires_action: false,
                preserve_streaming: true,
                fail_on_missing_payload: true,
            },
            origin_delta: ServertoolBackendRouteOriginDelta {
                requires_origin_seed: true,
                apply_assistant_delta: true,
            },
            finalize: ServertoolBackendRouteFinalizePolicy {
                context_decoration_mode: Some("web_search_summary".to_string()),
                short_circuit_requires_action: false,
            },
            input: hint.input,
        },
        "vision_auto" => ServertoolBackendRoutePolicy01Planned {
            tool_name: hint.tool_name,
            flow_id: normalize_flow_id(&hint.flow_id, "vision_auto_flow"),
            route_hint: hint.route_hint,
            execution_mode: ServertoolBackendRouteExecutionMode::Reenter,
            shape_guard: ServertoolBackendRouteShapeGuard {
                allow_requires_action: false,
                preserve_streaming: true,
                fail_on_missing_payload: true,
            },
            origin_delta: ServertoolBackendRouteOriginDelta {
                requires_origin_seed: true,
                apply_assistant_delta: true,
            },
            finalize: ServertoolBackendRouteFinalizePolicy {
                context_decoration_mode: None,
                short_circuit_requires_action: false,
            },
            input: hint.input,
        },
        _ => return Err(ServertoolOutcomeError::InvalidField("toolName")),
    };
    Ok(policy)
}

fn normalize_flow_id(actual: &str, default_flow_id: &'static str) -> String {
    let normalized = actual.trim();
    if normalized.is_empty() || normalized == "servertool_backend_route" {
        return default_flow_id.to_string();
    }
    normalized.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::outcome_contract::ServertoolOutcome;
    use serde_json::json;

    #[test]
    fn plans_web_search_backend_route_policy() {
        let plan = plan_servertool_backend_route_policy_01_from_hub_resp_chatprocess_03(
            ServertoolBackendRoutePolicyInput {
                tool_name: "web_search".to_string(),
                flow_id: None,
                input: json!({"query":"latest rust"}),
                entry_endpoint: Some("/v1/responses".to_string()),
            },
        )
        .expect("web_search backend route plan");
        assert_eq!(plan.tool_name, "web_search");
        assert_eq!(plan.flow_id, "web_search_flow");
        assert_eq!(plan.route_hint, "servertool_backend_route:web_search");
        assert_eq!(
            plan.execution_mode,
            ServertoolBackendRouteExecutionMode::Reenter
        );
        assert!(plan.shape_guard.preserve_streaming);
        assert!(plan.shape_guard.fail_on_missing_payload);
        assert!(plan.origin_delta.requires_origin_seed);
        assert_eq!(
            plan.finalize.context_decoration_mode.as_deref(),
            Some("web_search_summary")
        );
    }

    #[test]
    fn plans_vision_backend_route_policy() {
        let plan = plan_servertool_backend_route_policy_01_from_hub_resp_chatprocess_03(
            ServertoolBackendRoutePolicyInput {
                tool_name: "vision_auto".to_string(),
                flow_id: None,
                input: json!({"image":"data"}),
                entry_endpoint: None,
            },
        )
        .expect("vision backend route plan");
        assert_eq!(plan.tool_name, "vision_auto");
        assert_eq!(plan.flow_id, "vision_auto_flow");
        assert_eq!(plan.route_hint, "servertool_backend_route:vision_auto");
        assert!(plan.finalize.context_decoration_mode.is_none());
    }

    #[test]
    fn stop_message_auto_cannot_build_backend_route_policy() {
        let err = plan_servertool_backend_route_policy_01_from_hub_resp_chatprocess_03(
            ServertoolBackendRoutePolicyInput {
                tool_name: "stop_message_auto".to_string(),
                flow_id: None,
                input: json!({}),
                entry_endpoint: None,
            },
        )
        .expect_err("stop_message_auto is client exec, not backend route");
        assert_eq!(
            err,
            ServertoolOutcomeError::WrongOutcome {
                tool_name: "stop_message_auto".to_string(),
                expected: ServertoolOutcome::BackendRouteReenter,
                actual: ServertoolOutcome::ClientExecCliProjection
            }
        );
    }

    #[test]
    fn memory_cache_auto_cannot_build_backend_route_policy() {
        let err = plan_servertool_backend_route_policy_01_from_hub_resp_chatprocess_03(
            ServertoolBackendRoutePolicyInput {
                tool_name: "memory_cache_auto".to_string(),
                flow_id: None,
                input: json!({}),
                entry_endpoint: None,
            },
        )
        .expect_err("memory cache is server io internal, not backend route");
        assert_eq!(
            err,
            ServertoolOutcomeError::WrongOutcome {
                tool_name: "memory_cache_auto".to_string(),
                expected: ServertoolOutcome::BackendRouteReenter,
                actual: ServertoolOutcome::ServerIoInternal
            }
        );
    }
}
