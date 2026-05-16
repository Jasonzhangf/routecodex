use napi::bindgen_prelude::Result as NapiResult;
use napi_derive::napi;
use serde_json::{json, Value};

const GOAL_TOOL_NAMES: &[&str] = &[
    "get_goal",
    "create_goal",
    "update_goal",
    "request_user_input",
];

fn read_tool_name(tool: &Value) -> String {
    let obj = match tool.as_object() {
        Some(value) => value,
        None => return String::new(),
    };
    if let Some(name) = obj
        .get("name")
        .and_then(|value| value.as_str())
        .map(|value| value.trim().to_ascii_lowercase())
        .filter(|value| !value.is_empty())
    {
        return name;
    }
    obj.get("function")
        .and_then(|value| value.as_object())
        .and_then(|value| value.get("name"))
        .and_then(|value| value.as_str())
        .map(|value| value.trim().to_ascii_lowercase())
        .filter(|value| !value.is_empty())
        .unwrap_or_default()
}

fn is_goal_tool_name(name: &str) -> bool {
    GOAL_TOOL_NAMES.iter().any(|entry| *entry == name)
}

pub fn has_goal_capable_tools(tools: Option<&Value>) -> bool {
    let Some(tool_entries) = tools.and_then(|value| value.as_array()) else {
        return false;
    };
    tool_entries.iter().any(|tool| {
        is_goal_tool_name(read_tool_name(tool).as_str())
            || has_goal_capable_tools(tool.get("tools"))
    })
}

pub fn has_goal_capable_semantics(semantics: Option<&Value>) -> bool {
    let Some(semantics_obj) = semantics.and_then(|value| value.as_object()) else {
        return false;
    };
    if has_goal_capable_tools(semantics_obj.get("tools")) {
        return true;
    }
    let tools_node = semantics_obj.get("tools").and_then(|value| value.as_object());
    has_goal_capable_tools(tools_node.and_then(|value| value.get("clientToolsRaw")))
        || has_goal_capable_tools(tools_node.and_then(|value| value.get("baselineTools")))
        || has_goal_capable_tools(tools_node.and_then(|value| value.get("canonicalTools")))
}

pub fn is_goal_capable_request(value: &Value) -> bool {
    has_goal_capable_tools(value.get("tools"))
        || has_goal_capable_semantics(value.get("semantics"))
}

pub fn is_goal_capable_adapter_context(value: &Value) -> bool {
    let rt_goal_mode = value
        .get("__rt")
        .and_then(|entry| entry.as_object())
        .and_then(|entry| entry.get("goalMode"))
        .and_then(|entry| entry.as_bool())
        .unwrap_or(false);
    rt_goal_mode
        || has_goal_capable_semantics(value.get("requestSemantics"))
        || has_goal_capable_semantics(value.get("semantics"))
        || has_goal_capable_tools(value.get("capturedChatRequest").and_then(|entry| entry.get("tools")))
}

fn read_followup_source(value: &Value) -> String {
    let direct = value
        .get("clientInjectSource")
        .and_then(|entry| entry.as_str())
        .map(|entry| entry.trim().to_string())
        .filter(|entry| !entry.is_empty());
    if let Some(source) = direct {
        return source;
    }
    value
        .get("__rt")
        .and_then(|entry| entry.as_object())
        .and_then(|entry| entry.get("clientInjectSource"))
        .and_then(|entry| entry.as_str())
        .map(|entry| entry.trim().to_string())
        .filter(|entry| !entry.is_empty())
        .unwrap_or_default()
}

fn has_managed_stopless_goal_state(value: &Value) -> bool {
    value
        .get("stoplessGoalState")
        .and_then(|entry| entry.as_object())
        .and_then(|entry| entry.get("status"))
        .and_then(|entry| entry.as_str())
        .map(|entry| {
            let normalized = entry.trim().to_ascii_lowercase();
            !normalized.is_empty() && normalized != "idle"
        })
        .unwrap_or(false)
}

pub fn is_goal_managed_followup_context(value: &Value) -> bool {
    let followup_source = read_followup_source(value);
    if followup_source == "servertool.stopless_goal_continue" {
        return false;
    }
    is_goal_capable_adapter_context(value) || has_managed_stopless_goal_state(value)
}

#[napi]
pub fn resolve_goal_capable_request_json(input_json: String) -> NapiResult<String> {
    let input: Value =
        serde_json::from_str(&input_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let request = input.get("request").unwrap_or(&Value::Null);
    let adapter_context = input.get("adapterContext").unwrap_or(&Value::Null);
    let output = json!({
        "requestGoalCapable": is_goal_capable_request(request),
        "adapterContextGoalCapable": is_goal_capable_adapter_context(adapter_context),
        "followupGoalManagedContext": is_goal_managed_followup_context(adapter_context),
    });
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::is_goal_managed_followup_context;
    use serde_json::json;

    #[test]
    fn stopless_non_goal_followup_is_not_goal_managed() {
        let input = json!({
            "clientInjectSource": "servertool.stopless_goal_continue",
            "stoplessGoalState": {
                "status": "active",
                "objective": "continue",
                "updatedAt": 1,
                "createdAt": 1
            },
            "capturedChatRequest": {
                "tools": [
                    { "type": "function", "function": { "name": "exec_command" } }
                ]
            }
        });
        assert!(!is_goal_managed_followup_context(&input));
    }

    #[test]
    fn real_goal_context_stays_goal_managed() {
        let input = json!({
            "__rt": { "goalMode": true },
            "capturedChatRequest": {
                "tools": [
                    { "type": "function", "function": { "name": "update_goal" } }
                ]
            }
        });
        assert!(is_goal_managed_followup_context(&input));
    }
}
