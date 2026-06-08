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
    pub eligible: bool,
    pub skip_reason: Option<String>,
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
    let normalized_input = normalize_backend_route_input(&input.tool_name, input.input)?;
    let hint = build_servertool_backend_route_hint_01_from_hub_resp_chatprocess_03(
        ServertoolHubRespChatProcess03Input {
            tool_name: input.tool_name,
            flow_id: input.flow_id,
            input: normalized_input,
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
            eligible: true,
            skip_reason: None,
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
        "vision_auto" => {
            let skip_reason = resolve_vision_skip_reason(&hint.input);
            ServertoolBackendRoutePolicy01Planned {
                tool_name: hint.tool_name,
                flow_id: normalize_flow_id(&hint.flow_id, "vision_auto_flow"),
                route_hint: hint.route_hint,
                execution_mode: ServertoolBackendRouteExecutionMode::Reenter,
                eligible: skip_reason.is_none(),
                skip_reason,
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
            }
        }
        _ => return Err(ServertoolOutcomeError::InvalidField("toolName")),
    };
    Ok(policy)
}

fn normalize_backend_route_input(
    tool_name: &str,
    input: Value,
) -> Result<Value, ServertoolOutcomeError> {
    match tool_name {
        "web_search" => normalize_web_search_input(input),
        "vision_auto" => Ok(input),
        _ => Ok(input),
    }
}

fn normalize_web_search_input(input: Value) -> Result<Value, ServertoolOutcomeError> {
    let normalized = match input {
        Value::String(raw) => {
            let trimmed = raw.trim();
            if trimmed.is_empty() {
                Value::Object(serde_json::Map::new())
            } else {
                let parsed = serde_json::from_str::<Value>(trimmed)
                    .map_err(|_| ServertoolOutcomeError::InvalidField("input"))?;
                parsed
                    .as_object()
                    .ok_or(ServertoolOutcomeError::InvalidField("input"))?;
                parsed
            }
        }
        Value::Object(_) => input,
        Value::Null => Value::Object(serde_json::Map::new()),
        _ => return Err(ServertoolOutcomeError::InvalidField("input")),
    };
    let mut obj = normalized
        .as_object()
        .cloned()
        .ok_or(ServertoolOutcomeError::InvalidField("input"))?;
    if let Some(query) = read_trimmed_string(obj.get("query")) {
        obj.insert("query".to_string(), Value::String(query));
    }
    if let Some(engine) = read_trimmed_string(obj.get("engine")) {
        obj.insert("engine".to_string(), Value::String(engine));
    }
    if let Some(recency) = read_trimmed_string(obj.get("recency")) {
        obj.insert("recency".to_string(), Value::String(recency));
    }
    obj.insert(
        "count".to_string(),
        Value::Number(serde_json::Number::from(normalize_web_search_count(
            obj.get("count"),
        ))),
    );
    Ok(Value::Object(obj))
}

fn normalize_web_search_count(value: Option<&Value>) -> u64 {
    let parsed = match value {
        Some(Value::Number(number)) => number.as_u64().or_else(|| {
            number
                .as_i64()
                .and_then(|item| if item > 0 { Some(item as u64) } else { None })
        }),
        Some(Value::String(raw)) => raw.trim().parse::<u64>().ok(),
        _ => None,
    };
    parsed
        .filter(|count| *count > 0)
        .map(|count| count.min(10))
        .unwrap_or(10)
}

fn read_trimmed_string(value: Option<&Value>) -> Option<String> {
    let raw = value.and_then(Value::as_str)?.trim();
    if raw.is_empty() {
        None
    } else {
        Some(raw.to_string())
    }
}

fn resolve_vision_skip_reason(input: &Value) -> Option<String> {
    if has_qwen_image_generation_flag(input) {
        return Some("qwen_image_generation".to_string());
    }
    None
}

fn has_qwen_image_generation_flag(value: &Value) -> bool {
    let Some(obj) = value.as_object() else {
        return false;
    };
    if is_enabled_object(obj.get("qwenImageGeneration")) {
        return true;
    }
    if let Some(adapter) = obj.get("adapterContext") {
        if has_qwen_image_generation_flag(adapter) {
            return true;
        }
    }
    if let Some(rt) = obj.get("__rt") {
        if has_qwen_image_generation_flag(rt) {
            return true;
        }
    }
    if let Some(captured) = obj.get("capturedChatRequest") {
        if has_qwen_image_generation_flag(captured) {
            return true;
        }
    }
    if let Some(metadata) = obj.get("metadata") {
        if has_qwen_image_generation_flag(metadata) {
            return true;
        }
    }
    false
}

fn is_enabled_object(value: Option<&Value>) -> bool {
    let Some(obj) = value.and_then(Value::as_object) else {
        return false;
    };
    match obj.get("enabled") {
        Some(Value::Bool(true)) => true,
        Some(Value::String(raw)) => matches!(
            raw.trim().to_ascii_lowercase().as_str(),
            "true" | "1" | "yes" | "on"
        ),
        _ => false,
    }
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
        assert!(plan.eligible);
        assert!(plan.skip_reason.is_none());
        assert_eq!(plan.input["query"], "latest rust");
        assert_eq!(plan.input["count"], 10);
        assert_eq!(
            plan.finalize.context_decoration_mode.as_deref(),
            Some("web_search_summary")
        );
    }

    #[test]
    fn parses_web_search_arguments_string_as_rust_owned_input() {
        let plan = plan_servertool_backend_route_policy_01_from_hub_resp_chatprocess_03(
            ServertoolBackendRoutePolicyInput {
                tool_name: "web_search".to_string(),
                flow_id: None,
                input: json!(r#"{"query":"routecodex","count":3}"#),
                entry_endpoint: None,
            },
        )
        .expect("web_search backend route plan");
        assert_eq!(plan.input["query"], "routecodex");
        assert_eq!(plan.input["count"], 3);
    }

    #[test]
    fn normalizes_web_search_count_bounds() {
        let plan = plan_servertool_backend_route_policy_01_from_hub_resp_chatprocess_03(
            ServertoolBackendRoutePolicyInput {
                tool_name: "web_search".to_string(),
                flow_id: None,
                input: json!({"query":"routecodex","count":999}),
                entry_endpoint: None,
            },
        )
        .expect("web_search backend route plan");
        assert_eq!(plan.input["count"], 10);
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
        assert!(plan.eligible);
        assert!(plan.skip_reason.is_none());
    }

    #[test]
    fn vision_backend_route_policy_rejects_qwen_image_generation() {
        let plan = plan_servertool_backend_route_policy_01_from_hub_resp_chatprocess_03(
            ServertoolBackendRoutePolicyInput {
                tool_name: "vision_auto".to_string(),
                flow_id: None,
                input: json!({
                    "adapterContext": {
                        "__rt": {
                            "qwenImageGeneration": {
                                "enabled": true,
                                "mode": "edit"
                            }
                        }
                    }
                }),
                entry_endpoint: None,
            },
        )
        .expect("vision backend route plan");
        assert!(!plan.eligible);
        assert_eq!(plan.skip_reason.as_deref(), Some("qwen_image_generation"));
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
