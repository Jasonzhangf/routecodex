use serde::Deserialize;
use serde_json::Value;

// feature_id: hub.servertool_execution_dispatch_contract

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServertoolDispatchSpecMismatchErrorInput {
    pub request_id: String,
    pub tool_name: String,
    pub native_execution_mode: String,
    pub ts_execution_mode: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServertoolInvalidMixedClientToolsOutcomeErrorInput {
    pub request_id: String,
    pub outcome_mode: String,
    pub requires_pending_injection: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServertoolMissingExecutionContractErrorInput {
    pub request_id: String,
    pub outcome_mode: String,
}

pub fn plan_servertool_dispatch_spec_mismatch_error(
    input: &ServertoolDispatchSpecMismatchErrorInput,
) -> Value {
    serde_json::json!({
        "message": format!(
            "[servertool] dispatch spec mismatch: {}: native={} ts={}",
            input.tool_name.trim(),
            input.native_execution_mode.trim(),
            input.ts_execution_mode.trim(),
        ),
        "code": "SERVERTOOL_HANDLER_FAILED",
        "category": "INTERNAL_ERROR",
        "status": 500,
        "details": {
            "requestId": input.request_id.trim(),
            "toolName": input.tool_name.trim(),
            "nativeExecutionMode": input.native_execution_mode.trim(),
            "tsExecutionMode": input.ts_execution_mode.trim(),
        }
    })
}

pub fn plan_servertool_invalid_mixed_client_tools_outcome_error(
    input: &ServertoolInvalidMixedClientToolsOutcomeErrorInput,
) -> Value {
    serde_json::json!({
        "message": "[servertool] invalid native mixed-client-tools outcome contract",
        "code": "SERVERTOOL_HANDLER_FAILED",
        "category": "INTERNAL_ERROR",
        "status": 500,
        "details": {
            "requestId": input.request_id.trim(),
            "outcomeMode": input.outcome_mode.trim(),
            "requiresPendingInjection": input.requires_pending_injection,
        }
    })
}

pub fn plan_servertool_missing_execution_contract_error(
    input: &ServertoolMissingExecutionContractErrorInput,
) -> Value {
    serde_json::json!({
        "message": "[servertool] missing native execution contract for servertool-only outcome",
        "code": "SERVERTOOL_HANDLER_FAILED",
        "category": "INTERNAL_ERROR",
        "status": 500,
        "details": {
            "requestId": input.request_id.trim(),
            "outcomeMode": input.outcome_mode.trim(),
        }
    })
}

#[cfg(test)]
mod tests {
    use super::{
        plan_servertool_dispatch_spec_mismatch_error,
        plan_servertool_invalid_mixed_client_tools_outcome_error,
        plan_servertool_missing_execution_contract_error, ServertoolDispatchSpecMismatchErrorInput,
        ServertoolInvalidMixedClientToolsOutcomeErrorInput,
        ServertoolMissingExecutionContractErrorInput,
    };

    #[test]
    fn plans_dispatch_spec_mismatch_error() {
        let plan = plan_servertool_dispatch_spec_mismatch_error(
            &ServertoolDispatchSpecMismatchErrorInput {
                request_id: " req-1 ".to_string(),
                tool_name: " web_search ".to_string(),
                native_execution_mode: " guarded ".to_string(),
                ts_execution_mode: " legacy ".to_string(),
            },
        );
        assert_eq!(plan["code"], "SERVERTOOL_HANDLER_FAILED");
        assert_eq!(
            plan["message"],
            "[servertool] dispatch spec mismatch: web_search: native=guarded ts=legacy"
        );
        assert_eq!(plan["details"]["requestId"], "req-1");
    }

    #[test]
    fn plans_invalid_mixed_client_tools_outcome_error() {
        let plan = plan_servertool_invalid_mixed_client_tools_outcome_error(
            &ServertoolInvalidMixedClientToolsOutcomeErrorInput {
                request_id: "req-2".to_string(),
                outcome_mode: "mixed_client_tools".to_string(),
                requires_pending_injection: false,
            },
        );
        assert_eq!(
            plan["message"],
            "[servertool] invalid native mixed-client-tools outcome contract"
        );
        assert_eq!(plan["details"]["requiresPendingInjection"], false);
    }

    #[test]
    fn plans_missing_execution_contract_error() {
        let plan = plan_servertool_missing_execution_contract_error(
            &ServertoolMissingExecutionContractErrorInput {
                request_id: "req-3".to_string(),
                outcome_mode: "servertool_only".to_string(),
            },
        );
        assert_eq!(
            plan["message"],
            "[servertool] missing native execution contract for servertool-only outcome"
        );
        assert_eq!(plan["details"]["outcomeMode"], "servertool_only");
    }
}
