// feature_id: hub.servertool_server_side_tool_entry_contract
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServertoolEntryPreflightInput {
    pub has_base_object: bool,
    pub adapter_client_disconnected: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ServertoolEntryPreflightAction {
    ReturnPassthroughNonObjectChat,
    ThrowClientDisconnected,
    ContinueToToolFlow,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ServertoolEntryPreflightPlan {
    pub action: ServertoolEntryPreflightAction,
}

pub fn plan_servertool_entry_preflight(
    input: ServertoolEntryPreflightInput,
) -> ServertoolEntryPreflightPlan {
    if !input.has_base_object {
        return ServertoolEntryPreflightPlan {
            action: ServertoolEntryPreflightAction::ReturnPassthroughNonObjectChat,
        };
    }
    if input.adapter_client_disconnected {
        return ServertoolEntryPreflightPlan {
            action: ServertoolEntryPreflightAction::ThrowClientDisconnected,
        };
    }
    ServertoolEntryPreflightPlan {
        action: ServertoolEntryPreflightAction::ContinueToToolFlow,
    }
}

#[cfg(test)]
mod tests {
    use super::{
        plan_servertool_entry_preflight, ServertoolEntryPreflightAction,
        ServertoolEntryPreflightInput,
    };

    #[test]
    fn returns_passthrough_when_chat_response_is_not_an_object() {
        let plan = plan_servertool_entry_preflight(ServertoolEntryPreflightInput {
            has_base_object: false,
            adapter_client_disconnected: false,
        });
        assert_eq!(
            plan.action,
            ServertoolEntryPreflightAction::ReturnPassthroughNonObjectChat
        );
    }

    #[test]
    fn throws_client_disconnected_when_adapter_is_disconnected() {
        let plan = plan_servertool_entry_preflight(ServertoolEntryPreflightInput {
            has_base_object: true,
            adapter_client_disconnected: true,
        });
        assert_eq!(
            plan.action,
            ServertoolEntryPreflightAction::ThrowClientDisconnected
        );
    }

    #[test]
    fn continues_when_base_object_exists_and_client_is_connected() {
        let plan = plan_servertool_entry_preflight(ServertoolEntryPreflightInput {
            has_base_object: true,
            adapter_client_disconnected: false,
        });
        assert_eq!(plan.action, ServertoolEntryPreflightAction::ContinueToToolFlow);
    }
}
