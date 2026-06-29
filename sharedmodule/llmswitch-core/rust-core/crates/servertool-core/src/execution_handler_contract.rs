use serde::{Deserialize, Serialize};
use serde_json::Value;

// feature_id: hub.servertool_execution_handler_contract

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServertoolHandlerContractInput {
    #[serde(default)]
    pub has_finalize_function: bool,
    #[serde(default)]
    pub has_chat_response_object: bool,
    #[serde(default)]
    pub has_execution_object: bool,
    #[serde(default)]
    pub has_execution_flow_id: bool,
    #[serde(default)]
    pub has_plan_markers: bool,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum ServertoolHandlerContractAction {
    HandlerPlan,
    HandlerResult,
    InvalidPlanMissingFinalize,
    InvalidPlan,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ServertoolHandlerContractPlan {
    pub action: ServertoolHandlerContractAction,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServertoolMaterializationProgressInput {
    #[serde(default)]
    pub has_finalize_function: bool,
    #[serde(default)]
    pub has_chat_response_object: bool,
    #[serde(default)]
    pub has_execution_object: bool,
    #[serde(default)]
    pub has_execution_flow_id: bool,
    #[serde(default)]
    pub has_plan_markers: bool,
    #[serde(default)]
    pub has_backend_plan: bool,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum ServertoolMaterializationAction {
    FinalizeWithoutBackend,
    ReturnHandlerResult,
    InvalidPlanMissingFinalize,
    InvalidPlanResult,
    UnsupportedBackendPlanKind,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ServertoolMaterializationProgressPlan {
    pub action: ServertoolMaterializationAction,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServertoolHandlerRuntimeActionInput {
    #[serde(default)]
    pub has_finalize_function: bool,
    #[serde(default)]
    pub has_chat_response_object: bool,
    #[serde(default)]
    pub has_execution_object: bool,
    #[serde(default)]
    pub has_execution_flow_id: bool,
    #[serde(default)]
    pub has_plan_markers: bool,
    #[serde(default)]
    pub has_backend_plan: bool,
    #[serde(default)]
    pub backend_kind: Option<String>,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum ServertoolHandlerRuntimeAction {
    FinalizeWithoutBackend,
    ReturnHandlerResult,
    InvalidPlanMissingFinalize,
    InvalidPlanResult,
    UnsupportedBackendPlanKind,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ServertoolHandlerRuntimeActionPlan {
    pub action: ServertoolHandlerRuntimeAction,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub backend_kind: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServertoolHandlerFailedErrorInput {
    pub tool_name: String,
    pub request_id: String,
    pub entry_endpoint: String,
    pub provider_protocol: String,
    pub error: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServertoolUnsupportedBackendPlanKindErrorInput {
    pub request_id: String,
    pub backend_kind: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServertoolInvalidHandlerPlanErrorInput {
    pub request_id: String,
}

pub fn plan_servertool_handler_contract(
    input: &ServertoolHandlerContractInput,
) -> ServertoolHandlerContractPlan {
    if input.has_finalize_function {
        return ServertoolHandlerContractPlan {
            action: ServertoolHandlerContractAction::HandlerPlan,
        };
    }
    if input.has_chat_response_object && input.has_execution_object && input.has_execution_flow_id {
        return ServertoolHandlerContractPlan {
            action: ServertoolHandlerContractAction::HandlerResult,
        };
    }
    if input.has_plan_markers {
        return ServertoolHandlerContractPlan {
            action: ServertoolHandlerContractAction::InvalidPlanMissingFinalize,
        };
    }
    ServertoolHandlerContractPlan {
        action: ServertoolHandlerContractAction::InvalidPlan,
    }
}

pub fn plan_servertool_materialization_progress(
    input: &ServertoolMaterializationProgressInput,
) -> ServertoolMaterializationProgressPlan {
    let contract = plan_servertool_handler_contract(&ServertoolHandlerContractInput {
        has_finalize_function: input.has_finalize_function,
        has_chat_response_object: input.has_chat_response_object,
        has_execution_object: input.has_execution_object,
        has_execution_flow_id: input.has_execution_flow_id,
        has_plan_markers: input.has_plan_markers,
    });
    let action = match contract.action {
        ServertoolHandlerContractAction::HandlerPlan => {
            if input.has_backend_plan {
                ServertoolMaterializationAction::UnsupportedBackendPlanKind
            } else {
                ServertoolMaterializationAction::FinalizeWithoutBackend
            }
        }
        ServertoolHandlerContractAction::HandlerResult => {
            ServertoolMaterializationAction::ReturnHandlerResult
        }
        ServertoolHandlerContractAction::InvalidPlanMissingFinalize => {
            ServertoolMaterializationAction::InvalidPlanMissingFinalize
        }
        ServertoolHandlerContractAction::InvalidPlan => {
            ServertoolMaterializationAction::InvalidPlanResult
        }
    };
    ServertoolMaterializationProgressPlan { action }
}

pub fn plan_servertool_handler_runtime_action(
    input: &ServertoolHandlerRuntimeActionInput,
) -> ServertoolHandlerRuntimeActionPlan {
    let progression =
        plan_servertool_materialization_progress(&ServertoolMaterializationProgressInput {
            has_finalize_function: input.has_finalize_function,
            has_chat_response_object: input.has_chat_response_object,
            has_execution_object: input.has_execution_object,
            has_execution_flow_id: input.has_execution_flow_id,
            has_plan_markers: input.has_plan_markers,
            has_backend_plan: input.has_backend_plan,
        });
    let backend_kind = input
        .backend_kind
        .as_ref()
        .map(|value| value.trim().to_string());
    let action = match progression.action {
        ServertoolMaterializationAction::UnsupportedBackendPlanKind => {
            ServertoolHandlerRuntimeAction::UnsupportedBackendPlanKind
        }
        ServertoolMaterializationAction::FinalizeWithoutBackend => {
            ServertoolHandlerRuntimeAction::FinalizeWithoutBackend
        }
        ServertoolMaterializationAction::ReturnHandlerResult => {
            ServertoolHandlerRuntimeAction::ReturnHandlerResult
        }
        ServertoolMaterializationAction::InvalidPlanMissingFinalize => {
            ServertoolHandlerRuntimeAction::InvalidPlanMissingFinalize
        }
        ServertoolMaterializationAction::InvalidPlanResult => {
            ServertoolHandlerRuntimeAction::InvalidPlanResult
        }
    };
    ServertoolHandlerRuntimeActionPlan {
        action,
        backend_kind: backend_kind.filter(|value| !value.is_empty()),
    }
}

pub fn plan_servertool_handler_failed_error(input: &ServertoolHandlerFailedErrorInput) -> Value {
    serde_json::json!({
        "message": format!("[servertool] handler failed: {}: {}", input.tool_name.trim(), input.error.trim()),
        "code": "SERVERTOOL_HANDLER_FAILED",
        "category": "INTERNAL_ERROR",
        "status": 500,
        "details": {
            "toolName": input.tool_name.trim(),
            "requestId": input.request_id.trim(),
            "entryEndpoint": input.entry_endpoint.trim(),
            "providerProtocol": input.provider_protocol.trim(),
            "error": input.error.trim(),
        }
    })
}

pub fn plan_servertool_unsupported_backend_plan_kind_error(
    input: &ServertoolUnsupportedBackendPlanKindErrorInput,
) -> Value {
    serde_json::json!({
        "message": format!("[servertool] unsupported backend plan kind: {}", input.backend_kind.trim()),
        "code": "SERVERTOOL_HANDLER_FAILED",
        "category": "INTERNAL_ERROR",
        "status": 500,
        "details": {
            "requestId": input.request_id.trim(),
            "backendKind": input.backend_kind.trim(),
        }
    })
}

pub fn plan_servertool_invalid_handler_plan_missing_finalize_error(
    input: &ServertoolInvalidHandlerPlanErrorInput,
) -> Value {
    serde_json::json!({
        "message": "[servertool] invalid handler plan contract: missing finalize",
        "code": "SERVERTOOL_HANDLER_FAILED",
        "category": "INTERNAL_ERROR",
        "status": 500,
        "details": {
            "requestId": input.request_id.trim(),
        }
    })
}

pub fn plan_servertool_invalid_handler_plan_result_error(
    input: &ServertoolInvalidHandlerPlanErrorInput,
) -> Value {
    serde_json::json!({
        "message": "[servertool] invalid handler plan/result contract",
        "code": "SERVERTOOL_HANDLER_FAILED",
        "category": "INTERNAL_ERROR",
        "status": 500,
        "details": {
            "requestId": input.request_id.trim(),
        }
    })
}

#[cfg(test)]
mod tests {
    use super::{
        plan_servertool_handler_contract, plan_servertool_handler_failed_error,
        plan_servertool_handler_runtime_action,
        plan_servertool_invalid_handler_plan_missing_finalize_error,
        plan_servertool_invalid_handler_plan_result_error,
        plan_servertool_materialization_progress,
        plan_servertool_unsupported_backend_plan_kind_error,
        ServertoolHandlerContractAction, ServertoolHandlerContractInput,
        ServertoolHandlerFailedErrorInput, ServertoolHandlerRuntimeAction,
        ServertoolHandlerRuntimeActionInput,
        ServertoolInvalidHandlerPlanErrorInput, ServertoolMaterializationAction,
        ServertoolMaterializationProgressInput, ServertoolUnsupportedBackendPlanKindErrorInput,
    };

    #[test]
    fn plans_handler_contract_actions() {
        assert_eq!(
            plan_servertool_handler_contract(&ServertoolHandlerContractInput {
                has_finalize_function: true,
                has_chat_response_object: false,
                has_execution_object: false,
                has_execution_flow_id: false,
                has_plan_markers: true,
            })
            .action,
            ServertoolHandlerContractAction::HandlerPlan
        );
        assert_eq!(
            plan_servertool_handler_contract(&ServertoolHandlerContractInput {
                has_finalize_function: false,
                has_chat_response_object: true,
                has_execution_object: true,
                has_execution_flow_id: true,
                has_plan_markers: false,
            })
            .action,
            ServertoolHandlerContractAction::HandlerResult
        );
        assert_eq!(
            plan_servertool_handler_contract(&ServertoolHandlerContractInput {
                has_finalize_function: false,
                has_chat_response_object: false,
                has_execution_object: false,
                has_execution_flow_id: false,
                has_plan_markers: true,
            })
            .action,
            ServertoolHandlerContractAction::InvalidPlanMissingFinalize
        );

        assert_eq!(
            plan_servertool_materialization_progress(&ServertoolMaterializationProgressInput {
                has_finalize_function: true,
                has_chat_response_object: false,
                has_execution_object: false,
                has_execution_flow_id: false,
                has_plan_markers: true,
                has_backend_plan: true,
            })
            .action,
            ServertoolMaterializationAction::UnsupportedBackendPlanKind
        );
        assert_eq!(
            plan_servertool_materialization_progress(&ServertoolMaterializationProgressInput {
                has_finalize_function: true,
                has_chat_response_object: false,
                has_execution_object: false,
                has_execution_flow_id: false,
                has_plan_markers: true,
                has_backend_plan: false,
            })
            .action,
            ServertoolMaterializationAction::FinalizeWithoutBackend
        );
        assert_eq!(
            plan_servertool_materialization_progress(&ServertoolMaterializationProgressInput {
                has_finalize_function: false,
                has_chat_response_object: true,
                has_execution_object: true,
                has_execution_flow_id: true,
                has_plan_markers: false,
                has_backend_plan: false,
            })
            .action,
            ServertoolMaterializationAction::ReturnHandlerResult
        );

        assert_eq!(
            plan_servertool_handler_runtime_action(&ServertoolHandlerRuntimeActionInput {
                has_finalize_function: true,
                has_chat_response_object: false,
                has_execution_object: false,
                has_execution_flow_id: false,
                has_plan_markers: true,
                has_backend_plan: true,
                backend_kind: Some("vision_analysis".to_string()),
            })
            .action,
            ServertoolHandlerRuntimeAction::UnsupportedBackendPlanKind
        );
        assert_eq!(
            plan_servertool_handler_runtime_action(&ServertoolHandlerRuntimeActionInput {
                has_finalize_function: true,
                has_chat_response_object: false,
                has_execution_object: false,
                has_execution_flow_id: false,
                has_plan_markers: true,
                has_backend_plan: true,
                backend_kind: Some("web_search".to_string()),
            })
            .action,
            ServertoolHandlerRuntimeAction::UnsupportedBackendPlanKind
        );
        assert_eq!(
            plan_servertool_handler_runtime_action(&ServertoolHandlerRuntimeActionInput {
                has_finalize_function: true,
                has_chat_response_object: false,
                has_execution_object: false,
                has_execution_flow_id: false,
                has_plan_markers: true,
                has_backend_plan: true,
                backend_kind: Some("unknown_backend_kind".to_string()),
            })
            .action,
            ServertoolHandlerRuntimeAction::UnsupportedBackendPlanKind
        );
    }

    #[test]
    fn builds_error_contracts() {
        let handler_failed =
            plan_servertool_handler_failed_error(&ServertoolHandlerFailedErrorInput {
                tool_name: "tool".to_string(),
                request_id: "req-1".to_string(),
                entry_endpoint: "/v1/responses".to_string(),
                provider_protocol: "openai-responses".to_string(),
                error: "boom".to_string(),
            });
        assert_eq!(handler_failed["code"], "SERVERTOOL_HANDLER_FAILED");
        assert_eq!(handler_failed["details"]["toolName"], "tool");

        let unsupported = plan_servertool_unsupported_backend_plan_kind_error(
            &ServertoolUnsupportedBackendPlanKindErrorInput {
                request_id: "req-3".to_string(),
                backend_kind: "unknown_backend_kind".to_string(),
            },
        );
        assert_eq!(
            unsupported["details"]["backendKind"],
            "unknown_backend_kind"
        );

        let invalid_missing = plan_servertool_invalid_handler_plan_missing_finalize_error(
            &ServertoolInvalidHandlerPlanErrorInput {
                request_id: "req-4".to_string(),
            },
        );
        assert_eq!(invalid_missing["details"]["requestId"], "req-4");

        let invalid_result = plan_servertool_invalid_handler_plan_result_error(
            &ServertoolInvalidHandlerPlanErrorInput {
                request_id: "req-5".to_string(),
            },
        );
        assert_eq!(invalid_result["details"]["requestId"], "req-5");
    }
}
