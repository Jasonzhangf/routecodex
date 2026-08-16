use serde::{Deserialize, Serialize};
use serde_json::Value;

// feature_id: hub.servertool_execution_state_contract

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ServertoolExecutionSummary {
    pub flow_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub followup: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ServertoolExecutedToolCall {
    pub id: String,
    pub name: String,
    pub arguments: String,
    pub execution_mode: String,
    pub strip_after_execute: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ServertoolExecutedRecord {
    pub tool_call: ServertoolExecutedToolCall,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub execution: Option<ServertoolExecutionSummary>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ServertoolExecutionLoopStateValue {
    pub executed_tool_calls: Vec<ServertoolExecutedRecord>,
    pub executed_ids: Vec<String>,
    pub executed_flow_ids: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_execution: Option<ServertoolExecutionSummary>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServertoolAppendExecutedRecordInput {
    #[serde(default)]
    pub state: Option<ServertoolExecutionLoopStateValue>,
    pub tool_call: ServertoolExecutedToolCall,
    #[serde(default)]
    pub execution: Option<ServertoolExecutionSummary>,
}

pub fn create_servertool_execution_loop_state() -> ServertoolExecutionLoopStateValue {
    ServertoolExecutionLoopStateValue {
        executed_tool_calls: Vec::new(),
        executed_ids: Vec::new(),
        executed_flow_ids: Vec::new(),
        last_execution: None,
    }
}

pub fn append_executed_tool_record(
    input: ServertoolAppendExecutedRecordInput,
) -> ServertoolExecutionLoopStateValue {
    let mut state = input
        .state
        .unwrap_or_else(create_servertool_execution_loop_state);
    let record = ServertoolExecutedRecord {
        tool_call: normalize_tool_call(input.tool_call),
        execution: input.execution.map(normalize_execution),
    };
    let tool_call_id = record.tool_call.id.clone();
    if !tool_call_id.is_empty() && !state.executed_ids.iter().any(|id| id == &tool_call_id) {
        state.executed_ids.push(tool_call_id);
    }
    if let Some(execution) = record.execution.as_ref() {
        if !execution.flow_id.is_empty() {
            state.executed_flow_ids.push(execution.flow_id.clone());
        }
        state.last_execution = Some(execution.clone());
    }
    state.executed_tool_calls.push(record);
    state
}

fn normalize_tool_call(input: ServertoolExecutedToolCall) -> ServertoolExecutedToolCall {
    ServertoolExecutedToolCall {
        id: input.id.trim().to_string(),
        name: input.name.trim().to_string(),
        arguments: input.arguments,
        execution_mode: {
            let mode = input.execution_mode.trim();
            if mode.is_empty() {
                "guarded".to_string()
            } else {
                mode.to_string()
            }
        },
        strip_after_execute: input.strip_after_execute,
    }
}

fn normalize_execution(input: ServertoolExecutionSummary) -> ServertoolExecutionSummary {
    ServertoolExecutionSummary {
        flow_id: input.flow_id.trim().to_string(),
        followup: input.followup,
    }
}

#[cfg(test)]
mod tests {
    use super::{
        append_executed_tool_record, create_servertool_execution_loop_state,
        ServertoolAppendExecutedRecordInput, ServertoolExecutedToolCall,
        ServertoolExecutionLoopStateValue, ServertoolExecutionSummary,
    };
    use serde_json::json;

    #[test]
    fn creates_empty_execution_loop_state() {
        let state = create_servertool_execution_loop_state();
        assert!(state.executed_tool_calls.is_empty());
        assert!(state.executed_ids.is_empty());
        assert!(state.executed_flow_ids.is_empty());
        assert!(state.last_execution.is_none());
    }

    #[test]
    fn appends_executed_record_and_updates_last_execution() {
        let state = append_executed_tool_record(ServertoolAppendExecutedRecordInput {
            state: None,
            tool_call: ServertoolExecutedToolCall {
                id: " call_1 ".to_string(),
                name: " web_search ".to_string(),
                arguments: "{}".to_string(),
                execution_mode: " backend ".to_string(),
                strip_after_execute: true,
            },
            execution: Some(ServertoolExecutionSummary {
                flow_id: " flow_1 ".to_string(),
                followup: Some(json!({ "requestIdSuffix": ":servertool_followup" })),
            }),
        });
        assert_eq!(state.executed_tool_calls.len(), 1);
        assert_eq!(state.executed_tool_calls[0].tool_call.id, "call_1");
        assert_eq!(state.executed_ids, vec!["call_1"]);
        assert_eq!(state.executed_flow_ids, vec!["flow_1"]);
        assert_eq!(
            state.last_execution,
            Some(ServertoolExecutionSummary {
                flow_id: "flow_1".to_string(),
                followup: Some(json!({ "requestIdSuffix": ":servertool_followup" })),
            })
        );
    }

    #[test]
    fn append_dedupes_executed_id_but_keeps_record_history() {
        let existing = ServertoolExecutionLoopStateValue {
            executed_tool_calls: vec![],
            executed_ids: vec!["call_1".to_string()],
            executed_flow_ids: vec!["flow_1".to_string()],
            last_execution: None,
        };
        let state = append_executed_tool_record(ServertoolAppendExecutedRecordInput {
            state: Some(existing),
            tool_call: ServertoolExecutedToolCall {
                id: "call_1".to_string(),
                name: "web_search".to_string(),
                arguments: "{}".to_string(),
                execution_mode: "".to_string(),
                strip_after_execute: true,
            },
            execution: None,
        });
        assert_eq!(state.executed_ids, vec!["call_1"]);
        assert_eq!(state.executed_tool_calls.len(), 1);
        assert_eq!(
            state.executed_tool_calls[0].tool_call.execution_mode,
            "guarded"
        );
    }
}
