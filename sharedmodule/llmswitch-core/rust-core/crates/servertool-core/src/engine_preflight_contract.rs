// feature_id: hub.servertool_engine_preflight_contract
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ServertoolEnginePreflightInput {
    pub has_synthetic_control_text: bool,
    pub stop_signal_observed: bool,
    #[serde(default)]
    pub stopless_disabled_on_direct_route: Option<bool>,
    #[serde(default)]
    pub adapter_context: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum ServertoolEnginePreflightAction {
    ReturnOriginalChat,
    ReturnOriginalChatDirectPassthrough,
    ContinueToEngine,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ServertoolEnginePreflightPlan {
    pub action: ServertoolEnginePreflightAction,
}

pub fn plan_servertool_engine_preflight(
    input: ServertoolEnginePreflightInput,
) -> ServertoolEnginePreflightPlan {
    let stopless_disabled_on_direct_route =
        input.stopless_disabled_on_direct_route.unwrap_or_else(|| {
            resolve_stopless_disabled_on_direct_route(input.adapter_context.as_ref())
        });
    if input.has_synthetic_control_text {
        return ServertoolEnginePreflightPlan {
            action: ServertoolEnginePreflightAction::ReturnOriginalChat,
        };
    }
    if input.stop_signal_observed && stopless_disabled_on_direct_route {
        return ServertoolEnginePreflightPlan {
            action: ServertoolEnginePreflightAction::ReturnOriginalChatDirectPassthrough,
        };
    }
    ServertoolEnginePreflightPlan {
        action: ServertoolEnginePreflightAction::ContinueToEngine,
    }
}

fn resolve_stopless_disabled_on_direct_route(adapter_context: Option<&Value>) -> bool {
    let Some(adapter_context) = adapter_context.and_then(Value::as_object) else {
        return false;
    };
    let metadata = adapter_context.get("metadata").and_then(Value::as_object);
    let runtime = adapter_context.get("__rt").and_then(Value::as_object);
    let route_name = read_trimmed_string(adapter_context.get("routeName"))
        .or_else(|| metadata.and_then(|value| read_trimmed_string(value.get("routeName"))))
        .or_else(|| runtime.and_then(|value| read_trimmed_string(value.get("routeName"))));
    let Some(route_name) = route_name else {
        return false;
    };
    let lower = route_name.to_ascii_lowercase();
    lower.starts_with("router-direct") || lower.starts_with("provider-direct")
}

fn read_trimmed_string(value: Option<&Value>) -> Option<String> {
    let text = value?.as_str()?.trim();
    if text.is_empty() {
        return None;
    }
    Some(text.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn returns_original_chat_for_synthetic_control_text() {
        let plan = plan_servertool_engine_preflight(ServertoolEnginePreflightInput {
            has_synthetic_control_text: true,
            stop_signal_observed: true,
            stopless_disabled_on_direct_route: Some(true),
            adapter_context: None,
        });
        assert_eq!(
            plan.action,
            ServertoolEnginePreflightAction::ReturnOriginalChat
        );
    }

    #[test]
    fn returns_direct_passthrough_when_observed_stopless_is_disabled() {
        let plan = plan_servertool_engine_preflight(ServertoolEnginePreflightInput {
            has_synthetic_control_text: false,
            stop_signal_observed: true,
            stopless_disabled_on_direct_route: Some(true),
            adapter_context: None,
        });
        assert_eq!(
            plan.action,
            ServertoolEnginePreflightAction::ReturnOriginalChatDirectPassthrough
        );
    }

    #[test]
    fn continues_to_engine_when_not_blocked() {
        let plan = plan_servertool_engine_preflight(ServertoolEnginePreflightInput {
            has_synthetic_control_text: false,
            stop_signal_observed: true,
            stopless_disabled_on_direct_route: Some(false),
            adapter_context: None,
        });
        assert_eq!(
            plan.action,
            ServertoolEnginePreflightAction::ContinueToEngine
        );
    }

    #[test]
    fn derives_direct_passthrough_from_adapter_context_route_name() {
        let plan = plan_servertool_engine_preflight(ServertoolEnginePreflightInput {
            has_synthetic_control_text: false,
            stop_signal_observed: true,
            stopless_disabled_on_direct_route: None,
            adapter_context: Some(serde_json::json!({
                "metadata": {
                    "routeName": "router-direct/testing"
                }
            })),
        });
        assert_eq!(
            plan.action,
            ServertoolEnginePreflightAction::ReturnOriginalChatDirectPassthrough
        );
    }
}
