// feature_id: hub.servertool_server_side_tool_entry_contract
use serde::{Deserialize, Serialize};
use serde_json::Value;

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

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServertoolEntryContextInput {
    pub include_tool_call_handler_names: Option<Vec<Value>>,
    pub exclude_tool_call_handler_names: Option<Vec<Value>>,
    pub include_auto_hook_ids: Option<Vec<Value>>,
    pub exclude_auto_hook_ids: Option<Vec<Value>>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ServertoolEntryContextPlan {
    pub include_tool_call_names: Option<Vec<String>>,
    pub exclude_tool_call_names: Option<Vec<String>>,
    pub include_auto_hook_ids: Option<Vec<String>>,
    pub exclude_auto_hook_ids: Option<Vec<String>>,
}

pub fn plan_servertool_entry_context(
    input: ServertoolEntryContextInput,
) -> ServertoolEntryContextPlan {
    ServertoolEntryContextPlan {
        include_tool_call_names: normalize_filter_tokens(input.include_tool_call_handler_names),
        exclude_tool_call_names: normalize_filter_tokens(input.exclude_tool_call_handler_names),
        include_auto_hook_ids: normalize_filter_tokens(input.include_auto_hook_ids),
        exclude_auto_hook_ids: normalize_filter_tokens(input.exclude_auto_hook_ids),
    }
}

fn normalize_filter_tokens(values: Option<Vec<Value>>) -> Option<Vec<String>> {
    let mut normalized = Vec::new();
    for raw in values.unwrap_or_default() {
        let Some(raw) = raw.as_str() else {
            continue;
        };
        let value = raw.trim().to_lowercase();
        if !value.is_empty() && !normalized.contains(&value) {
            normalized.push(value);
        }
    }
    if normalized.is_empty() {
        None
    } else {
        Some(normalized.into_iter().collect())
    }
}

#[cfg(test)]
mod tests {
    use super::{
        plan_servertool_entry_context, plan_servertool_entry_preflight,
        ServertoolEntryPreflightAction, ServertoolEntryPreflightInput,
    };
    use serde_json::Value;

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
        assert_eq!(
            plan.action,
            ServertoolEntryPreflightAction::ContinueToToolFlow
        );
    }

    #[test]
    fn normalizes_entry_context_filters_in_rust() {
        let plan = plan_servertool_entry_context(super::ServertoolEntryContextInput {
            include_tool_call_handler_names: Some(vec![
                Value::String(" Web_Search ".to_string()),
                Value::Null,
                Value::String("".to_string()),
                Value::String("web_search".to_string()),
            ]),
            exclude_tool_call_handler_names: Some(vec![Value::String(" Vision_Auto ".to_string())]),
            include_auto_hook_ids: Some(vec![Value::String(" Stop_Message_Auto ".to_string())]),
            exclude_auto_hook_ids: Some(vec![]),
        });

        assert_eq!(
            plan,
            super::ServertoolEntryContextPlan {
                include_tool_call_names: Some(vec!["web_search".to_string()]),
                exclude_tool_call_names: Some(vec!["vision_auto".to_string()]),
                include_auto_hook_ids: Some(vec!["stop_message_auto".to_string()]),
                exclude_auto_hook_ids: None,
            }
        );
    }
}
