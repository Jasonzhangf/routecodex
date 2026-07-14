use super::*;
use crate::req_process_stage1_tool_governance_blocks::servertool_injection::resolve_tool_name;
use crate::stopless_current_turn::STOPLESS_TRANSPARENT_CONTINUATION_PROMPT;
use std::collections::HashSet;

fn first_responses_system_input_text(value: &serde_json::Value) -> &str {
    value["input"][0]["content"][0]["text"]
        .as_str()
        .expect("provider-visible responses system input text")
}

fn first_chat_system_message_text(value: &serde_json::Value) -> &str {
    value["messages"][0]["content"]
        .as_str()
        .expect("provider-visible chat system message text")
}

#[test]
fn test_apply_tool_governance_basic() {
    let input = ToolGovernanceInput {
        request: serde_json::json!({
          "model": "gpt-4",
          "messages": [{"role": "user", "content": "hello"}]
        }),
        raw_payload: serde_json::json!({}),
        metadata: serde_json::json!({
          "entryEndpoint": "/v1/chat/completions"
        }),
        entry_endpoint: "/v1/chat/completions".to_string(),
        request_id: "req_123".to_string(),
        has_active_stop_message_for_continue_execution: None,
        metadata_center_snapshot: serde_json::json!({}),
    };
    let result = apply_req_process_tool_governance(input).unwrap();
    assert!(result.node_result["success"].as_bool().unwrap());
}

#[test]
fn test_req_chatprocess_entry_lifts_responses_resume_and_tombstones_metadata() {
    let input = ToolGovernanceInput {
        request: serde_json::json!({
          "model": "gpt-4o",
          "input": [
            {
              "type": "message",
              "role": "user",
              "content": [{"type": "input_text", "text": "continue"}]
            }
          ]
        }),
        raw_payload: serde_json::json!({}),
        metadata: serde_json::json!({
          "entryEndpoint": "/v1/responses",
          "responsesResume": {
            "previousRequestId": "req_prev",
            "restoredFromResponseId": "resp_prev",
            "routeHint": "thinking",
            "toolOutputsDetailed": [
              {
                "callId": "call_1",
                "outputText": "ok"
              }
            ]
          }
        }),
        entry_endpoint: "/v1/responses".to_string(),
        request_id: "req_chatprocess_resume_lift".to_string(),
        has_active_stop_message_for_continue_execution: None,
        metadata_center_snapshot: serde_json::json!({}),
    };

    let result = apply_req_process_tool_governance(input).unwrap();
    let semantics = result.processed_request["semantics"]
        .as_object()
        .expect("chatprocess semantics");
    assert_eq!(
        semantics["responses"]["resume"]["restoredFromResponseId"].as_str(),
        Some("resp_prev")
    );
    assert_eq!(
        semantics["continuation"]["continuationScope"].as_str(),
        Some("request_chain")
    );
    assert_eq!(
        semantics["continuation"]["toolContinuation"]["submittedToolCallIds"][0].as_str(),
        Some("call_1")
    );
    assert!(result.metadata["responsesResume"].is_null());
}

#[test]
fn test_req_chatprocess_restores_stopless_count_from_responses_resume_tool_output() {
    let stopless_stdout = serde_json::json!({
        "ok": true,
        "toolName": "stop_message_auto",
        "flowId": "stop_message_flow",
        "repeatCount": 1,
        "maxRepeats": 3,
        "continuationPrompt": "继续执行原任务",
        "schemaFeedback": {
            "reasonCode": "stop_schema_next_step_missing",
            "missingFields": ["next_step"]
        },
        "input": {
            "flowId": "stop_message_flow",
            "repeatCount": 1,
            "maxRepeats": 3,
            "triggerHint": "invalid_schema"
        }
    });
    let input = ToolGovernanceInput {
        request: serde_json::json!({
          "model": "gpt-4o",
          "input": [
            {
              "type": "message",
              "role": "user",
              "content": [{"type": "input_text", "text": "continue"}]
            }
          ]
        }),
        raw_payload: serde_json::json!({}),
        metadata: serde_json::json!({
          "entryEndpoint": "/v1/responses.submit_tool_outputs",
          "responsesResume": {
            "previousRequestId": "req_prev",
            "restoredFromResponseId": "resp_prev",
            "routeHint": "thinking",
            "toolOutputsDetailed": [
              {
                "callId": "call_stopless_cli_1",
                "outputText": stopless_stdout.to_string()
              }
            ]
          }
        }),
        entry_endpoint: "/v1/responses.submit_tool_outputs".to_string(),
        request_id: "req_chatprocess_stopless_resume_count".to_string(),
        has_active_stop_message_for_continue_execution: None,
        metadata_center_snapshot: serde_json::json!({
          "requestTruth": {
            "requestId": "req_chatprocess_stopless_resume_count",
            "sessionId": "sess_chatprocess_stopless_resume_count"
          },
          "runtimeControl": {
            "stopMessage": {
              "enabled": true
            }
          }
        }),
    };

    let result = apply_req_process_tool_governance(input).unwrap();
    let stopless = &result.metadata["runtime_control"]["stopless"];
    assert_eq!(stopless["repeatCount"], serde_json::json!(1));
    assert_eq!(stopless["maxRepeats"], serde_json::json!(3));
    assert_eq!(
        stopless["sessionId"],
        serde_json::json!("sess_chatprocess_stopless_resume_count")
    );
    assert_eq!(stopless["triggerHint"], serde_json::json!("invalid_schema"));
    assert_eq!(
        stopless["schemaFeedback"]["reasonCode"],
        serde_json::json!("stop_schema_next_step_missing")
    );
    assert_ne!(stopless["repeatCount"], serde_json::json!(0));
}

#[test]
fn test_req_chatprocess_transparent_continuation_preserves_snapshot_repeat_count() {
    let input = ToolGovernanceInput {
        request: serde_json::json!({
          "model": "gpt-5.3-codex",
          "input": [
            {
              "type": "message",
              "role": "user",
              "content": [{
                "type": "input_text",
                "text": STOPLESS_TRANSPARENT_CONTINUATION_PROMPT
              }]
            }
          ]
        }),
        raw_payload: serde_json::json!({}),
        metadata: serde_json::json!({
          "entryEndpoint": "/v1/responses.submit_tool_outputs",
          "runtime_control": {
            "stopless": {
              "active": true,
              "flowId": "stop_message_flow",
              "repeatCount": 0,
              "maxRepeats": 3
            }
          }
        }),
        entry_endpoint: "/v1/responses.submit_tool_outputs".to_string(),
        request_id: "req_stopless_transparent_preserve_count".to_string(),
        has_active_stop_message_for_continue_execution: Some(true),
        metadata_center_snapshot: serde_json::json!({
          "requestTruth": {
            "requestId": "req_stopless_transparent_preserve_count",
            "sessionId": "sess_stopless_transparent_preserve_count"
          },
          "runtimeControl": {
            "stopMessage": {
              "enabled": true
            },
            "stopless": {
              "active": true,
              "flowId": "stop_message_flow",
              "sessionId": "sess_stopless_transparent_preserve_count",
              "repeatCount": 1,
              "maxRepeats": 3,
              "triggerHint": "invalid_schema",
              "schemaFeedback": {
                "reasonCode": "stop_schema_next_step_missing",
                "missingFields": ["next_step"]
              }
            }
          }
        }),
    };

    let result = apply_req_process_tool_governance(input).unwrap();
    let stopless = &result.metadata["runtime_control"]["stopless"];
    assert_eq!(
        stopless["repeatCount"],
        serde_json::json!(1),
        "transparent stopless user prompt must preserve the private consecutive-stop count"
    );
    assert_eq!(
        stopless["sessionId"],
        serde_json::json!("sess_stopless_transparent_preserve_count")
    );
    assert_eq!(stopless["triggerHint"], serde_json::json!("invalid_schema"));
}

#[test]
fn test_req_chatprocess_relay_materialized_resume_restores_private_repeat_count() {
    let stopless_stdout = serde_json::json!({
        "ok": true,
        "toolName": "stop_message_auto",
        "flowId": "stop_message_flow",
        "repeatCount": 1,
        "maxRepeats": 3,
        "schemaFeedback": {
            "reasonCode": "stop_schema_next_step_missing",
            "missingFields": ["next_step"]
        },
        "input": {
            "flowId": "stop_message_flow",
            "repeatCount": 1,
            "maxRepeats": 3,
            "triggerHint": "invalid_schema"
        }
    });
    let input = ToolGovernanceInput {
        request: serde_json::json!({
          "model": "gpt-5.3-codex",
          "input": [
            {
              "type": "message",
              "role": "user",
              "content": [{
                "type": "input_text",
                "text": STOPLESS_TRANSPARENT_CONTINUATION_PROMPT
              }]
            }
          ]
        }),
        raw_payload: serde_json::json!({}),
        metadata: serde_json::json!({
          "entryEndpoint": "/v1/responses",
          "responsesResume": {
            "continuationOwner": "relay",
            "materializedMode": "submit_tool_outputs",
            "toolOutputsDetailed": [{
              "callId": "call_stopless_relay_resume",
              "outputText": stopless_stdout.to_string()
            }]
          },
          "runtime_control": {
            "stopless": {
              "active": true,
              "flowId": "stop_message_flow",
              "repeatCount": 0,
              "maxRepeats": 3
            }
          }
        }),
        entry_endpoint: "/v1/responses".to_string(),
        request_id: "req_stopless_relay_materialized_resume".to_string(),
        has_active_stop_message_for_continue_execution: Some(true),
        metadata_center_snapshot: serde_json::json!({
          "requestTruth": {
            "requestId": "req_stopless_relay_materialized_resume",
            "sessionId": "sess_stopless_relay_materialized_resume"
          },
          "runtimeControl": {
            "stopMessage": {
              "enabled": true
            },
            "stopless": {
              "active": true,
              "flowId": "stop_message_flow",
              "sessionId": "sess_stopless_relay_materialized_resume",
              "repeatCount": 0,
              "maxRepeats": 3
            }
          }
        }),
    };

    let result = apply_req_process_tool_governance(input).unwrap();
    let stopless = &result.metadata["runtime_control"]["stopless"];
    assert_eq!(
        stopless["repeatCount"],
        serde_json::json!(1),
        "relay-materialized submit must consume current responsesResume tool output even after the internal endpoint becomes /v1/responses"
    );
    assert_eq!(stopless["triggerHint"], serde_json::json!("invalid_schema"));
    assert_eq!(
        stopless["schemaFeedback"]["reasonCode"],
        serde_json::json!("stop_schema_next_step_missing")
    );
}

#[test]
fn test_req_chatprocess_new_user_turn_resets_stale_stopless_snapshot_and_history() {
    let stale_stopless_stdout = serde_json::json!({
        "ok": true,
        "toolName": "stop_message_auto",
        "flowId": "stop_message_flow",
        "repeatCount": 3,
        "maxRepeats": 3,
        "schemaGuidance": {
            "triggerHint": "budget_exhausted"
        },
        "input": {
            "flowId": "stop_message_flow",
            "repeatCount": 3,
            "maxRepeats": 3,
            "triggerHint": "budget_exhausted"
        }
    });
    let input = ToolGovernanceInput {
        request: serde_json::json!({
          "model": "gpt-5.3-codex",
          "input": [
            {
              "type": "function_call",
              "call_id": "call_stale_stopless_round_3",
              "name": "exec_command",
              "arguments": "{\"cmd\":\"routecodex hook run reasoningStop --input-json '{\\\"flowId\\\":\\\"stop_message_flow\\\",\\\"repeatCount\\\":3,\\\"maxRepeats\\\":3}'\"}"
            },
            {
              "type": "function_call_output",
              "call_id": "call_stale_stopless_round_3",
              "output": stale_stopless_stdout.to_string()
            },
            {
              "type": "message",
              "role": "user",
              "content": [{
                "type": "input_text",
                "text": "这是新任务，第一次停止必须重新触发 stopless"
              }]
            }
          ]
        }),
        raw_payload: serde_json::json!({}),
        metadata: serde_json::json!({
          "entryEndpoint": "/v1/responses"
        }),
        entry_endpoint: "/v1/responses".to_string(),
        request_id: "req_stopless_new_user_reset".to_string(),
        has_active_stop_message_for_continue_execution: Some(true),
        metadata_center_snapshot: serde_json::json!({
          "requestTruth": {
            "requestId": "req_stopless_new_user_reset",
            "sessionId": "sess_stopless_new_user_reset"
          },
          "runtimeControl": {
            "stopMessage": {
              "enabled": true
            },
            "stopless": {
              "active": true,
              "flowId": "stop_message_flow",
              "repeatCount": 3,
              "maxRepeats": 3,
              "triggerHint": "budget_exhausted"
            }
          }
        }),
    };

    let result = apply_req_process_tool_governance(input).unwrap();
    let stopless = &result.metadata["runtime_control"]["stopless"];
    assert_eq!(stopless["active"], serde_json::json!(true));
    assert_eq!(
        stopless["repeatCount"],
        serde_json::json!(0),
        "a real user turn must clear the completed stopless cycle before the next stop"
    );
    assert_eq!(stopless["maxRepeats"], serde_json::json!(3));
    assert!(
        stopless.get("triggerHint").is_none(),
        "stale terminal trigger must not survive a new user turn: {stopless}"
    );
    let serialized = result.processed_request.to_string();
    assert!(serialized.contains("这是新任务，第一次停止必须重新触发 stopless"));
    assert!(
        !serialized.contains("call_stale_stopless_round_3")
            && !serialized.contains("\"repeatCount\":3"),
        "previous-cycle stopless tool history must not reach the provider: {serialized}"
    );
    assert!(
        serialized.contains("<rcc_stop_schema>") && !serialized.contains("reasoningStop"),
        "new user turn must remain stopless-enabled through the schema contract without internal tool: {serialized}"
    );
}

#[test]
fn test_req_chatprocess_real_user_continue_execution_resets_stale_stopless_snapshot() {
    let stale_stopless_stdout = serde_json::json!({
        "ok": true,
        "toolName": "stop_message_auto",
        "flowId": "stop_message_flow",
        "repeatCount": 2,
        "maxRepeats": 3,
        "trigger": "invalid_schema"
    });
    let input = ToolGovernanceInput {
        request: serde_json::json!({
          "model": "gpt-5.3-codex",
          "input": [
            {
              "type": "function_call",
              "name": "reasoningStop",
              "call_id": "call_stale_before_real_continue",
              "arguments": "{}"
            },
            {
              "type": "function_call_output",
              "call_id": "call_stale_before_real_continue",
              "output": stale_stopless_stdout.to_string()
            },
            {
              "type": "message",
              "role": "user",
              "content": [{
                "type": "input_text",
                "text": "继续执行"
              }]
            }
          ]
        }),
        raw_payload: serde_json::json!({}),
        metadata: serde_json::json!({
          "entryEndpoint": "/v1/responses"
        }),
        entry_endpoint: "/v1/responses".to_string(),
        request_id: "req_stopless_real_user_continue_reset".to_string(),
        has_active_stop_message_for_continue_execution: Some(true),
        metadata_center_snapshot: serde_json::json!({
          "requestTruth": {
            "requestId": "req_stopless_real_user_continue_reset",
            "sessionId": "sess_stopless_real_user_continue_reset"
          },
          "runtimeControl": {
            "stopMessage": {
              "enabled": true
            },
            "stopless": {
              "active": true,
              "flowId": "stop_message_flow",
              "sessionId": "sess_stopless_real_user_continue_reset",
              "repeatCount": 2,
              "maxRepeats": 3,
              "triggerHint": "invalid_schema"
            }
          }
        }),
    };

    let result = apply_req_process_tool_governance(input).unwrap();
    let stopless = &result.metadata["runtime_control"]["stopless"];
    assert_eq!(
        stopless["repeatCount"],
        serde_json::json!(0),
        "a real user turn must reset the streak even when its text equals a legacy transparent prompt"
    );
    assert!(
        stopless.get("triggerHint").is_none(),
        "real user input must clear stale stopless classification: {stopless}"
    );
    let serialized = serde_json::to_string(&result.processed_request).unwrap();
    assert!(
        !serialized.contains("call_stale_before_real_continue"),
        "a real user turn must remove previous-cycle stopless tool history: {serialized}"
    );
    assert!(
        serialized.contains("继续执行"),
        "the real user turn must remain provider-visible: {serialized}"
    );
}

#[test]
fn test_req_chatprocess_new_user_turn_cuts_off_stale_materialized_guidance() {
    let input = ToolGovernanceInput {
        request: serde_json::json!({
          "model": "gpt-5.3-codex",
          "input": [
            {
              "type": "message",
              "role": "user",
              "content": [{
                "type": "input_text",
                "text": "上一轮执行结果：repeatCount=3/3；reasonCode=stop_schema_missing；missingFields=stopreason。"
              }]
            },
            {
              "type": "message",
              "role": "user",
              "content": [{
                "type": "input_text",
                "text": "审计新的 stopless 问题"
              }]
            }
          ]
        }),
        raw_payload: serde_json::json!({}),
        metadata: serde_json::json!({
          "entryEndpoint": "/v1/responses"
        }),
        entry_endpoint: "/v1/responses".to_string(),
        request_id: "req_stopless_new_user_guidance_reset".to_string(),
        has_active_stop_message_for_continue_execution: Some(true),
        metadata_center_snapshot: serde_json::json!({
          "requestTruth": {
            "requestId": "req_stopless_new_user_guidance_reset",
            "sessionId": "sess_stopless_new_user_guidance_reset"
          },
          "runtimeControl": {
            "stopMessage": {
              "enabled": true
            }
          }
        }),
    };

    let result = apply_req_process_tool_governance(input).unwrap();
    let stopless = &result.metadata["runtime_control"]["stopless"];
    assert_eq!(stopless["active"], serde_json::json!(true));
    assert_eq!(
        stopless["repeatCount"],
        serde_json::json!(0),
        "materialized guidance before the latest real user turn belongs to the previous cycle"
    );
    assert!(
        stopless.get("schemaFeedback").is_none(),
        "previous-cycle feedback must not be injected into the new task: {stopless}"
    );
}

#[test]
fn test_req_chatprocess_stopreason_continue_uses_next_step_as_live_prompt() {
    let live_next_step =
        "运行 cargo test -p router-hotpath-napi req_process_stage1_tool_governance";
    let stopless_stdout = serde_json::json!({
        "ok": true,
        "toolName": "stop_message_auto",
        "flowId": "stop_message_flow",
        "repeatCount": 1,
        "maxRepeats": 3,
        "continuationPrompt": live_next_step,
        "schemaFeedback": {
            "reasonCode": "stop_schema_continue_next_step",
            "missingFields": []
        },
        "input": {
            "flowId": "stop_message_flow",
            "repeatCount": 1,
            "maxRepeats": 3,
            "triggerHint": "non_terminal_schema"
        }
    });
    let input = ToolGovernanceInput {
        request: serde_json::json!({
          "model": "gpt-4o",
          "input": [
            {
              "type": "function_call",
              "id": "call_stopless_live_prompt",
              "call_id": "call_stopless_live_prompt",
              "name": "exec_command",
              "arguments": "{\"cmd\":\"routecodex hook run reasoningStop --input-json '{\\\"flowId\\\":\\\"stop_message_flow\\\",\\\"repeatCount\\\":1,\\\"maxRepeats\\\":3,\\\"triggerHint\\\":\\\"non_terminal_schema\\\"}'\"}"
            },
            {
              "type": "function_call_output",
              "call_id": "call_stopless_live_prompt",
              "output": stopless_stdout.to_string()
            }
          ]
        }),
        raw_payload: serde_json::json!({}),
        metadata: serde_json::json!({
          "entryEndpoint": "/v1/responses.submit_tool_outputs",
          "responsesResume": {
            "previousRequestId": "req_prev",
            "restoredFromResponseId": "resp_prev",
            "routeHint": "thinking",
            "toolOutputsDetailed": [
              {
                "callId": "call_stopless_live_prompt",
                "outputText": stopless_stdout.to_string()
              }
            ]
          }
        }),
        entry_endpoint: "/v1/responses.submit_tool_outputs".to_string(),
        request_id: "req_chatprocess_stopless_live_prompt".to_string(),
        has_active_stop_message_for_continue_execution: None,
        metadata_center_snapshot: serde_json::json!({
          "requestTruth": {
            "requestId": "req_chatprocess_stopless_live_prompt",
            "sessionId": "sess_chatprocess_stopless_live_prompt"
          },
          "runtimeControl": {
            "stopMessage": {
              "enabled": true
            }
          }
        }),
    };

    let result = apply_req_process_tool_governance(input).unwrap();
    let serialized = serde_json::to_string(&result.processed_request).unwrap();
    assert!(
        serialized.contains(live_next_step),
        "provider-facing request must include the exact stopreason=2 next_step as the live continuation prompt: {serialized}"
    );
    assert!(
        !serialized.contains("继续执行你给出的 next_step"),
        "provider-facing continuation must not replace the live next_step with generic guidance: {serialized}"
    );
    assert_eq!(
        result.metadata["runtime_control"]["stopless"]["continuationPrompt"].as_str(),
        Some(live_next_step),
        "runtime control must preserve the live next_step prompt"
    );
}

#[test]
fn test_req_chatprocess_restores_stopless_count_from_semantics_input_tool_output() {
    let stopless_stdout = serde_json::json!({
        "ok": true,
        "toolName": "stop_message_auto",
        "flowId": "stop_message_flow",
        "repeatCount": 1,
        "maxRepeats": 3,
        "continuationPrompt": "继续执行原任务",
        "schemaFeedback": {
            "reasonCode": "stop_schema_next_step_missing",
            "missingFields": ["next_step"]
        },
        "input": {
            "flowId": "stop_message_flow",
            "repeatCount": 1,
            "maxRepeats": 3,
            "triggerHint": "invalid_schema"
        }
    });
    let input = ToolGovernanceInput {
        request: serde_json::json!({
          "model": "gpt-4o",
          "messages": [
            {
              "role": "user",
              "content": "上一轮 invalid schema 已转成自然语言指导。"
            }
          ],
          "semantics": {
            "input": [
              {
                "type": "function_call_output",
                "call_id": "call_stopless_cli_1",
                "output": stopless_stdout.to_string()
              }
            ]
          }
        }),
        raw_payload: serde_json::json!({}),
        metadata: serde_json::json!({
          "entryEndpoint": "/v1/responses.submit_tool_outputs",
          "runtime_control": {
            "stopless": {
              "flowId": "stop_message_flow",
              "repeatCount": 0,
              "maxRepeats": 3,
              "active": true
            }
          }
        }),
        entry_endpoint: "/v1/responses.submit_tool_outputs".to_string(),
        request_id: "req_chatprocess_stopless_semantics_input_count".to_string(),
        has_active_stop_message_for_continue_execution: None,
        metadata_center_snapshot: serde_json::json!({
          "requestTruth": {
            "requestId": "req_chatprocess_stopless_semantics_input_count",
            "sessionId": "sess_chatprocess_stopless_semantics_input_count"
          },
          "runtimeControl": {
            "stopMessage": {
              "enabled": true
            }
          }
        }),
    };

    let result = apply_req_process_tool_governance(input).unwrap();
    let stopless = &result.metadata["runtime_control"]["stopless"];
    assert_eq!(stopless["repeatCount"], serde_json::json!(1));
    assert_eq!(stopless["maxRepeats"], serde_json::json!(3));
    assert_eq!(
        stopless["sessionId"],
        serde_json::json!("sess_chatprocess_stopless_semantics_input_count")
    );
    assert_eq!(stopless["triggerHint"], serde_json::json!("invalid_schema"));
    assert_eq!(
        stopless["schemaFeedback"]["reasonCode"],
        serde_json::json!("stop_schema_next_step_missing")
    );
}

#[test]
fn test_req_chatprocess_missing_session_id_does_not_write_stopless_state() {
    let stopless_stdout = serde_json::json!({
        "ok": true,
        "toolName": "stop_message_auto",
        "flowId": "stop_message_flow",
        "repeatCount": 1,
        "maxRepeats": 3,
        "input": {
            "flowId": "stop_message_flow",
            "repeatCount": 1,
            "maxRepeats": 3,
            "triggerHint": "invalid_schema"
        }
    });
    let input = ToolGovernanceInput {
        request: serde_json::json!({
          "model": "gpt-4o",
          "input": [
            {
              "type": "function_call_output",
              "call_id": "call_stopless_cli_1",
              "output": stopless_stdout.to_string()
            }
          ]
        }),
        raw_payload: serde_json::json!({}),
        metadata: serde_json::json!({
          "entryEndpoint": "/v1/responses.submit_tool_outputs"
        }),
        entry_endpoint: "/v1/responses.submit_tool_outputs".to_string(),
        request_id: "req_chatprocess_stopless_missing_session".to_string(),
        has_active_stop_message_for_continue_execution: None,
        metadata_center_snapshot: serde_json::json!({
          "requestTruth": {
            "requestId": "req_chatprocess_stopless_missing_session"
          },
          "runtimeControl": {
            "stopMessage": {
              "enabled": true
            }
          }
        }),
    };

    let result = apply_req_process_tool_governance(input).unwrap();
    assert!(
        result.metadata["runtime_control"].get("stopless").is_none(),
        "missing request-truth sessionId must not write stopless runtime state: {}",
        result.metadata
    );
}

#[test]
fn test_req_process_responses_input_materializes_stopless_instructions_when_client_inject_ready() {
    let input = ToolGovernanceInput {
        request: serde_json::json!({
          "model": "gpt-4",
          "input": [
            {
              "type": "message",
              "role": "user",
              "content": [{"type": "input_text", "text": "继续排查"}]
            }
          ]
        }),
        raw_payload: serde_json::json!({}),
        metadata: serde_json::json!({
          "entryEndpoint": "/v1/responses",
          "clientInjectReady": true
        }),
        entry_endpoint: "/v1/responses".to_string(),
        request_id: "req_stopless_responses_instruction".to_string(),
        has_active_stop_message_for_continue_execution: None,
        metadata_center_snapshot: serde_json::json!({
          "requestTruth": {
            "sessionId": "sess_stopless_responses_instruction"
          },
          "runtimeControl": {
            "stopMessage": {
              "enabled": true
            }
          }
        }),
    };

    let result = apply_req_process_tool_governance(input).unwrap();
    let instructions = first_responses_system_input_text(&result.processed_request);
    assert!(instructions.contains("停止输出合同"));
    assert!(instructions.contains("必选合同"));
    assert!(instructions.contains("<rcc_stop_schema>"));
    assert!(instructions.contains("字段类型"));
    assert!(
        instructions.contains("stopreason=0(finished) 必须同时写 has_evidence=1 和非空 evidence")
    );
    assert!(instructions.contains("stopreason=1(blocked) 必须写非空 reason"));
    assert!(instructions.contains("stopreason=2(continue_needed)"));
    assert!(
        instructions.contains("needs_user_input=true 时 next_step 必须是要直接询问用户的完整问题")
    );
    assert!(instructions.contains("finished 示例"));
    assert!(!instructions.contains("reasoningStop"));
    assert_eq!(result.processed_request["input"][0]["role"], "system");
    let tools = result.processed_request["tools"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    assert!(
        !tools.iter().any(|tool| {
            tool.get("function")
                .and_then(|function| function.get("name"))
                .and_then(|name| name.as_str())
                == Some("reasoningStop")
        }),
        "provider tools must not expose internal reasoningStop: {tools:?}"
    );
}

#[test]
fn test_req_process_prefers_metadata_center_snapshot_for_stop_message_injection() {
    let input = ToolGovernanceInput {
        request: serde_json::json!({
          "model": "gpt-4",
          "input": [
            {
              "type": "message",
              "role": "user",
              "content": [{"type": "input_text", "text": "继续排查"}]
            }
          ]
        }),
        raw_payload: serde_json::json!({}),
        metadata: serde_json::json!({
          "entryEndpoint": "/v1/responses",
          "clientInjectReady": true
        }),
        entry_endpoint: "/v1/responses".to_string(),
        request_id: "req_stopless_snapshot_injection".to_string(),
        has_active_stop_message_for_continue_execution: None,
        metadata_center_snapshot: serde_json::json!({
          "requestTruth": {
            "sessionId": "sess_stopless_snapshot_injection"
          },
          "runtimeControl": {
            "stopMessage": {
              "enabled": true
            }
          }
        }),
    };

    let result = apply_req_process_tool_governance(input).unwrap();
    let instructions = first_responses_system_input_text(&result.processed_request);
    assert!(instructions.contains("停止输出合同"));
    assert!(instructions.contains("必选合同"));
    assert!(!instructions.contains("reasoningStop"));
    assert!(!instructions.contains("已收敛"));
    assert!(!instructions.contains("任务已经完成"));
    assert!(!instructions.contains("直接收尾"));
    assert!(!result.processed_request["tools"]
        .as_array()
        .cloned()
        .unwrap_or_default()
        .iter()
        .any(|tool| {
            tool.get("function")
                .and_then(|function| function.get("name"))
                .and_then(|name| name.as_str())
                == Some("reasoningStop")
        }));
}

#[test]
fn test_req_process_does_not_inject_stopless_from_legacy_rt_residue() {
    let input = ToolGovernanceInput {
        request: serde_json::json!({
          "model": "gpt-4",
          "input": [
            {
              "type": "message",
              "role": "user",
              "content": [{"type": "input_text", "text": "继续排查"}]
            }
          ]
        }),
        raw_payload: serde_json::json!({}),
        metadata: serde_json::json!({
          "entryEndpoint": "/v1/responses",
          "clientInjectReady": true,
          "__rt": {
            "stopMessageEnabled": true
          }
        }),
        entry_endpoint: "/v1/responses".to_string(),
        request_id: "req_stopless_legacy_rt_residue".to_string(),
        has_active_stop_message_for_continue_execution: None,
        metadata_center_snapshot: serde_json::json!({}),
    };

    let result = apply_req_process_tool_governance(input).unwrap();
    assert!(result.processed_request.get("instructions").is_none());
    assert!(result
        .processed_request
        .get("tools")
        .map(|value| value
            .as_array()
            .map(|items| items.is_empty())
            .unwrap_or(false))
        .unwrap_or(true));
}

#[test]
fn test_req_process_replaces_stale_top_level_stopless_responses_instructions() {
    let existing = "legacy stop schema instruction for reasoningStop\n<rcc_stop_schema>\n{\"stopreason\":2,\"reason\":\"当前状态\",\"has_evidence\":0,\"evidence\":\"\",\"next_step\":\"下一步动作\",\"needs_user_input\":false}\n</rcc_stop_schema>";
    let input = ToolGovernanceInput {
        request: serde_json::json!({
          "model": "gpt-4",
          "instructions": existing,
          "input": [
            {
              "type": "message",
              "role": "user",
              "content": [{"type": "input_text", "text": "继续排查"}]
            }
          ]
        }),
        raw_payload: serde_json::json!({}),
        metadata: serde_json::json!({
          "entryEndpoint": "/v1/responses",
          "clientInjectReady": true,
        }),
        entry_endpoint: "/v1/responses".to_string(),
        request_id: "req_stopless_responses_instruction_dedup".to_string(),
        has_active_stop_message_for_continue_execution: None,
        metadata_center_snapshot: serde_json::json!({
          "requestTruth": {
            "sessionId": "sess_stopless_responses_instruction_dedup"
          },
          "runtimeControl": {
            "stopMessage": {
              "enabled": true
            }
          }
        }),
    };

    let result = apply_req_process_tool_governance(input).unwrap();
    assert_eq!(
        result.processed_request.get("instructions"),
        None,
        "ReqChatProcess must not keep stale stopless top-level instructions"
    );
    let instructions = first_responses_system_input_text(&result.processed_request);
    assert!(instructions.contains("必选合同"));
    assert!(!instructions.contains("reasoningStop"));
}

#[test]
fn test_req_process_responses_input_still_materializes_stopless_contract() {
    let input = ToolGovernanceInput {
        request: serde_json::json!({
          "model": "gpt-4.1",
          "input": [
            {
              "type": "message",
              "role": "user",
              "content": [{"type": "input_text", "text": "继续执行"}]
            }
          ]
        }),
        raw_payload: serde_json::json!({}),
        metadata: serde_json::json!({
          "entryEndpoint": "/v1/responses",
          "clientInjectReady": true
        }),
        entry_endpoint: "/v1/responses".to_string(),
        request_id: "req_stopless_responses_input".to_string(),
        has_active_stop_message_for_continue_execution: None,
        metadata_center_snapshot: serde_json::json!({
          "requestTruth": {
            "sessionId": "sess_stopless_responses_input"
          },
          "runtimeControl": {
            "stopMessage": {
              "enabled": true
            }
          }
        }),
    };

    let result = apply_req_process_tool_governance(input).unwrap();
    let instructions = first_responses_system_input_text(&result.processed_request);
    assert!(instructions.contains("停止输出合同"));
    assert!(instructions.contains("必选合同"));
    assert!(instructions.contains("finished 示例"));
    assert!(!instructions.contains("reasoningStop"));
    assert!(!instructions.contains("已收敛"));
    assert!(!instructions.contains("任务已经完成"));
    assert!(!instructions.contains("直接收尾"));
    assert!(instructions.contains("<rcc_stop_schema>"));
    assert_eq!(result.processed_request["input"][0]["role"], "system");
}

#[test]
fn test_req_process_responses_input_materializes_stopless_instructions_without_client_inject_ready()
{
    let input = ToolGovernanceInput {
        request: serde_json::json!({
          "model": "gpt-5.5",
          "input": [
            {
              "type": "message",
              "role": "user",
              "content": [{"type": "input_text", "text": "请直接回复一句“阶段完成”，然后结束。<**stopless:on**>"}]
            }
          ]
        }),
        raw_payload: serde_json::json!({}),
        metadata: serde_json::json!({
          "entryEndpoint": "/v1/responses",
          "clientInjectReady": false,
          "clientInjectReason": "tmux_session_missing"
        }),
        entry_endpoint: "/v1/responses".to_string(),
        request_id: "req_stopless_responses_no_tmux_inject".to_string(),
        has_active_stop_message_for_continue_execution: None,
        metadata_center_snapshot: serde_json::json!({
          "requestTruth": {
            "sessionId": "sess_stopless_responses_no_tmux_inject"
          },
          "runtimeControl": {
            "stopMessage": {
              "enabled": true
            }
          }
        }),
    };

    let result = apply_req_process_tool_governance(input).unwrap();
    let instructions = first_responses_system_input_text(&result.processed_request);
    assert!(instructions.contains("停止输出合同"));
    assert!(instructions.contains("必选合同"));
    assert!(instructions.contains("finished 示例"));
    assert!(!instructions.contains("reasoningStop"));
    assert!(!instructions.contains("已收敛"));
    assert!(!instructions.contains("任务已经完成"));
    assert!(!instructions.contains("直接收尾"));
    assert!(instructions.contains("<rcc_stop_schema>"));
    assert_eq!(result.processed_request["input"][0]["role"], "system");
}

#[test]
fn test_error_empty_json_input() {
    let result = apply_req_process_tool_governance_json("".to_string());
    assert!(result.is_err());
    assert!(result
        .unwrap_err()
        .to_string()
        .contains("Input JSON is empty"));
}

#[test]
fn test_anthropic_alias_semantics() {
    let input = ToolGovernanceInput {
        request: serde_json::json!({
          "model": "claude-3",
          "messages": [{"role": "user", "content": "hi"}]
        }),
        raw_payload: serde_json::json!({}),
        metadata: serde_json::json!({
          "entryEndpoint": "/v1/messages",
          "providerProtocol": "anthropic-messages"
        }),
        entry_endpoint: "/v1/messages".to_string(),
        request_id: "req_456".to_string(),
        has_active_stop_message_for_continue_execution: None,
        metadata_center_snapshot: serde_json::json!({}),
    };
    let result = apply_req_process_tool_governance(input).unwrap();
    let processed = result.processed_request.as_object().unwrap();
    assert!(processed["metadata"]["preserveNativeToolNames"]
        .as_bool()
        .unwrap());
}

#[test]
fn test_processed_request_shape_and_node_metadata() {
    let input = ToolGovernanceInput {
        request: serde_json::json!({
          "model": "gpt-4o-mini",
          "messages": [{"role": "user", "content": "hello"}],
          "parameters": {"stream": true}
        }),
        raw_payload: serde_json::json!({}),
        metadata: serde_json::json!({
          "entryEndpoint": "/v1/chat/completions",
          "capturedContext": {"k": "v"}
        }),
        entry_endpoint: "/v1/chat/completions".to_string(),
        request_id: "req_789".to_string(),
        has_active_stop_message_for_continue_execution: None,
        metadata_center_snapshot: serde_json::json!({}),
    };
    let result = apply_req_process_tool_governance(input).unwrap();
    let processed = result.processed_request.as_object().unwrap();
    assert!(processed.get("processed").is_some());
    assert!(processed.get("processingMetadata").is_some());
    assert_eq!(
        processed["processingMetadata"]["streaming"]["enabled"].as_bool(),
        Some(true)
    );
    assert_eq!(
        result.node_result["metadata"]["node"].as_str(),
        Some("hub-chat-process")
    );
}

#[test]
fn test_chat_process_filters_namespace_mcp_aggregator_tools() {
    let input = ToolGovernanceInput {
        request: serde_json::json!({
          "model": "gpt-4o",
          "messages": [
            {"role": "assistant", "content": null, "tool_calls": [
              {"id": "call_drop", "type": "function", "function": {"name": "mcp__node_repl", "arguments": "{}"}},
              {"id": "call_keep", "type": "function", "function": {"name": "mcp__node_repl__js", "arguments": "{}"}}
            ]},
            {"role": "tool", "tool_call_id": "call_keep", "content": "ok"}
          ],
          "tools": [
            {"type": "function", "function": {"name": "mcp__node_repl", "parameters": {}}},
            {"type": "function", "function": {"name": "mcp__node_repl__js", "parameters": {"type": "object"}}}
          ]
        }),
        raw_payload: serde_json::json!({}),
        metadata: serde_json::json!({"entryEndpoint": "/v1/responses"}),
        entry_endpoint: "/v1/responses".to_string(),
        request_id: "req_filter_namespace_mcp".to_string(),
        has_active_stop_message_for_continue_execution: None,
        metadata_center_snapshot: serde_json::json!({}),
    };
    let result = apply_req_process_tool_governance(input).unwrap();
    let messages = result.processed_request["messages"].as_array().unwrap();
    let tool_calls = messages[0]["tool_calls"].as_array().unwrap();
    assert_eq!(tool_calls.len(), 1);
    assert_eq!(tool_calls[0]["id"].as_str(), Some("call_keep"));
    let tools = result.processed_request["tools"].as_array().unwrap();
    assert_eq!(tools.len(), 1);
    assert_eq!(
        tools[0]["function"]["name"].as_str(),
        Some("mcp__node_repl__js")
    );
}

#[test]
fn test_chat_process_merges_consecutive_assistant_tool_call_messages() {
    let input = ToolGovernanceInput {
        request: serde_json::json!({
          "model": "gpt-4o",
          "messages": [
            {"role": "assistant", "content": null, "tool_calls": [
              {"id": "call_a", "type": "function", "function": {"name": "first", "arguments": "{}"}}
            ]},
            {"role": "assistant", "content": null, "tool_calls": [
              {"id": "call_b", "type": "function", "function": {"name": "second", "arguments": "{}"}}
            ]},
            {"role": "tool", "tool_call_id": "call_a", "content": "a"},
            {"role": "tool", "tool_call_id": "call_b", "content": "b"}
          ]
        }),
        raw_payload: serde_json::json!({}),
        metadata: serde_json::json!({"entryEndpoint": "/v1/responses"}),
        entry_endpoint: "/v1/responses".to_string(),
        request_id: "req_merge_tool_calls".to_string(),
        has_active_stop_message_for_continue_execution: None,
        metadata_center_snapshot: serde_json::json!({}),
    };
    let result = apply_req_process_tool_governance(input).unwrap();
    let messages = result.processed_request["messages"].as_array().unwrap();
    assert_eq!(messages.len(), 3);
    assert_eq!(messages[0]["role"].as_str(), Some("assistant"));
    assert_eq!(messages[0]["tool_calls"].as_array().unwrap().len(), 2);
    assert_eq!(messages[1]["role"].as_str(), Some("tool"));
    assert_eq!(messages[2]["role"].as_str(), Some("tool"));
}

#[test]
fn test_post_governed_media_cleanup_preserves_followup_messages_and_context() {
    let input = ToolGovernanceInput {
        request: serde_json::json!({
          "model": "kimi-k2.5",
          "messages": [
            {
              "role": "user",
              "content": [
                { "type": "input_text", "text": "look" },
                { "type": "input_image", "image_url": "data:image/png;base64,AAA" }
              ]
            },
            { "role": "assistant", "content": "ok" },
            { "role": "tool", "content": "done" }
          ],
          "semantics": {
            "responses": {
              "context": {
                "input": [
                  {
                    "type": "message",
                    "role": "user",
                    "content": [
                      { "type": "input_text", "text": "look" },
                      { "type": "input_image", "image_url": "data:image/png;base64,AAA" }
                    ]
                  },
                  {
                    "type": "message",
                    "role": "assistant",
                    "content": [
                      { "type": "output_text", "text": "ok" }
                    ]
                  },
                  {
                    "type": "function_call_output",
                    "call_id": "call_1",
                    "output": "done"
                  }
                ]
              }
            }
          }
        }),
        raw_payload: serde_json::json!({}),
        metadata: serde_json::json!({
          "entryEndpoint": "/v1/responses"
        }),
        entry_endpoint: "/v1/responses".to_string(),
        request_id: "req_media_followup".to_string(),
        has_active_stop_message_for_continue_execution: None,
        metadata_center_snapshot: serde_json::json!({}),
    };

    let result = apply_req_process_tool_governance(input).unwrap();
    let processed = result.processed_request.as_object().unwrap();
    let messages = processed["messages"].as_array().unwrap();
    let first_content = messages[0]["content"].as_array().unwrap();
    assert_eq!(first_content[1]["type"].as_str(), Some("input_image"));
    assert_eq!(
        first_content[1]["image_url"].as_str(),
        Some("data:image/png;base64,AAA")
    );
    assert!(processed["metadata"]
        .as_object()
        .and_then(|meta| meta.get("hasImageAttachment"))
        .is_none());

    let context_input = processed["semantics"]["responses"]["context"]["input"]
        .as_array()
        .unwrap();
    let context_first_content = context_input[0]["content"].as_array().unwrap();
    assert_eq!(
        context_first_content[1]["type"].as_str(),
        Some("input_image")
    );
    assert_eq!(
        context_first_content[1]["image_url"].as_str(),
        Some("data:image/png;base64,AAA")
    );
}

#[test]
fn test_post_governed_media_cleanup_preserves_latest_user_media_turn() {
    let input = ToolGovernanceInput {
        request: serde_json::json!({
          "model": "kimi-k2.5",
          "messages": [
            {
              "role": "user",
              "content": [
                { "type": "input_text", "text": "look" },
                { "type": "input_image", "image_url": "data:image/png;base64,BBB" }
              ]
            }
          ]
        }),
        raw_payload: serde_json::json!({}),
        metadata: serde_json::json!({
          "entryEndpoint": "/v1/responses"
        }),
        entry_endpoint: "/v1/responses".to_string(),
        request_id: "req_media_current_turn".to_string(),
        has_active_stop_message_for_continue_execution: None,
        metadata_center_snapshot: serde_json::json!({}),
    };

    let result = apply_req_process_tool_governance(input).unwrap();
    let processed = result.processed_request.as_object().unwrap();
    let messages = processed["messages"].as_array().unwrap();
    let first_content = messages[0]["content"].as_array().unwrap();
    assert_eq!(first_content[1]["type"].as_str(), Some("input_image"));
    assert_eq!(
        processed["metadata"]["hasImageAttachment"].as_bool(),
        Some(true)
    );
}

#[test]
fn test_servertool_orchestration_keeps_removed_clock_absent_and_continue_hidden() {
    let input = ToolGovernanceInput {
        request: serde_json::json!({
          "model": "gpt-4o-mini",
          "messages": [{"role": "user", "content": "hello"}],
          "tools": [
            {
              "type": "function",
              "function": {
                "name": "exec_command",
                "parameters": { "type": "object", "properties": { "cmd": { "type": "string" } }, "required": ["cmd"] }
              }
            }
          ],
          "parameters": {
            "stream": true
          }
        }),
        raw_payload: serde_json::json!({}),
        metadata: serde_json::json!({
          "tmuxSessionId": "s-1",
          "__rt": {
            "webSearch": {
              "engines": [
                { "id": "google" }
              ]
            }
          }
        }),
        entry_endpoint: "/v1/chat/completions".to_string(),
        request_id: "req_tools".to_string(),
        has_active_stop_message_for_continue_execution: None,
        metadata_center_snapshot: serde_json::json!({}),
    };

    let result = apply_req_process_tool_governance(input).unwrap();
    let tools = result
        .processed_request
        .as_object()
        .and_then(|row| row.get("tools"))
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let mut names: HashSet<String> = HashSet::new();
    for tool in tools {
        let name = resolve_tool_name(&tool);
        if let Some(v) = name {
            names.insert(v);
        }
    }
    assert!(names.contains("exec_command"));
    assert!(!names.contains("clock"));
    assert!(!names.contains("continue_execution"));
}

#[test]
fn test_tool_governance_preserves_top_level_tool_choice_and_stream() {
    let input = ToolGovernanceInput {
        request: serde_json::json!({
          "model": "gpt-4o-mini",
          "messages": [{"role": "user", "content": "read files"}],
          "tools": [
            {
              "type": "function",
              "function": {
                "name": "exec_command",
                "parameters": { "type": "object", "properties": { "cmd": { "type": "string" } }, "required": ["cmd"] }
              }
            }
          ],
          "tool_choice": "auto",
          "stream": true
        }),
        raw_payload: serde_json::json!({}),
        metadata: serde_json::json!({}),
        entry_endpoint: "/v1/chat/completions".to_string(),
        request_id: "req_tool_choice_preserve".to_string(),
        has_active_stop_message_for_continue_execution: None,
        metadata_center_snapshot: serde_json::json!({}),
    };

    let result = apply_req_process_tool_governance(input).unwrap();
    let processed = result.processed_request.as_object().unwrap();
    assert_eq!(processed["tool_choice"].as_str(), Some("auto"));
    assert_eq!(processed["stream"].as_bool(), Some(true));
    assert_eq!(
        processed["tools"][0]["function"]["name"].as_str(),
        Some("exec_command")
    );
}

#[test]
fn test_servertool_orchestration_skips_direct_web_search_tool_injection() {
    let input = ToolGovernanceInput {
        request: serde_json::json!({
          "model": "gpt-4o-mini",
          "messages": [{"role": "user", "content": "search latest routecodex news"}],
          "parameters": {
            "stream": true
          }
        }),
        raw_payload: serde_json::json!({}),
        metadata: serde_json::json!({
          "tmuxSessionId": "s-1",
          "__rt": {
            "webSearch": {
              "engines": [
                {
                  "id": "native-search",
                  "providerKey": "demo.key1.model",
                  "executionMode": "direct",
                  "directActivation": "route"
                }
              ]
            }
          }
        }),
        entry_endpoint: "/v1/chat/completions".to_string(),
        request_id: "req_tools_direct_search".to_string(),
        has_active_stop_message_for_continue_execution: None,
        metadata_center_snapshot: serde_json::json!({}),
    };

    let result = apply_req_process_tool_governance(input).unwrap();
    let tools = result
        .processed_request
        .as_object()
        .and_then(|row| row.get("tools"))
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let mut names: HashSet<String> = HashSet::new();
    for tool in tools {
        if let Some(v) = resolve_tool_name(&tool) {
            names.insert(v);
        }
    }
    assert!(!names.contains("websearch"));
    assert!(!names.contains("clock"));
    assert!(!names.contains("continue_execution"));
}

#[test]
fn test_servertool_orchestration_injects_websearch_for_servertool_engines() {
    let input = ToolGovernanceInput {
        request: serde_json::json!({
          "model": "gpt-4o-mini",
          "messages": [{"role": "user", "content": "please search the web for latest routecodex updates"}],
          "parameters": {
            "stream": true
          }
        }),
        raw_payload: serde_json::json!({}),
        metadata: serde_json::json!({
          "tmuxSessionId": "s-1",
          "__rt": {
            "webSearch": {
              "engines": [
                {
                  "id": "servertool-search",
                  "providerKey": "demo.key1.model",
                  "executionMode": "servertool"
                }
              ]
            }
          }
        }),
        entry_endpoint: "/v1/chat/completions".to_string(),
        request_id: "req_tools_servertool_search".to_string(),
        has_active_stop_message_for_continue_execution: None,
        metadata_center_snapshot: serde_json::json!({}),
    };

    let result = apply_req_process_tool_governance(input).unwrap();
    let tools = result
        .processed_request
        .as_object()
        .and_then(|row| row.get("tools"))
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let mut names: HashSet<String> = HashSet::new();
    for tool in tools {
        if let Some(v) = resolve_tool_name(&tool) {
            names.insert(v);
        }
    }
    assert!(names.contains("web_search"));
}

#[test]
fn test_servertool_orchestration_skips_websearch_when_direct_and_servertool_both_present() {
    let input = ToolGovernanceInput {
        request: serde_json::json!({
          "model": "gpt-4o-mini",
          "messages": [{"role": "user", "content": "search latest routecodex news"}],
          "parameters": {
            "stream": true
          }
        }),
        raw_payload: serde_json::json!({}),
        metadata: serde_json::json!({
          "tmuxSessionId": "s-1",
          "__rt": {
            "webSearch": {
              "engines": [
                {
                  "id": "native-search",
                  "providerKey": "demo.key1.model",
                  "executionMode": "direct",
                  "directActivation": "route"
                },
                {
                  "id": "servertool-search",
                  "providerKey": "demo.key1.model",
                  "executionMode": "servertool"
                }
              ]
            }
          }
        }),
        entry_endpoint: "/v1/chat/completions".to_string(),
        request_id: "req_tools_both_search_modes".to_string(),
        has_active_stop_message_for_continue_execution: None,
        metadata_center_snapshot: serde_json::json!({}),
    };

    let result = apply_req_process_tool_governance(input).unwrap();
    let tools = result
        .processed_request
        .as_object()
        .and_then(|row| row.get("tools"))
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let mut names: HashSet<String> = HashSet::new();
    for tool in tools {
        if let Some(v) = resolve_tool_name(&tool) {
            names.insert(v);
        }
    }
    assert!(!names.contains("websearch"));
}

#[test]
fn test_servertool_orchestration_uses_explicit_stop_message_flag_instead_of_runtime_metadata() {
    let input = ToolGovernanceInput {
        request: serde_json::json!({
          "model": "gpt-4o-mini",
          "messages": [{"role": "user", "content": "hello"}],
          "parameters": {
            "stream": true
          }
        }),
        raw_payload: serde_json::json!({}),
        metadata: serde_json::json!({
          "clientInjectReady": true,
          "__rt": {
            "stopMessageState": {
              "stopMessageText": "halt",
              "stopMessageMaxRepeats": 2,
              "stopMessageStageMode": "on"
            }
          }
        }),
        entry_endpoint: "/v1/chat/completions".to_string(),
        request_id: "req_explicit_stop_flag".to_string(),
        has_active_stop_message_for_continue_execution: Some(false),
        metadata_center_snapshot: serde_json::json!({}),
    };

    let result = apply_req_process_tool_governance(input).unwrap();
    let tools = result
        .processed_request
        .as_object()
        .and_then(|row| row.get("tools"))
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();

    let mut names: HashSet<String> = HashSet::new();
    for tool in tools {
        if let Some(v) = resolve_tool_name(&tool) {
            names.insert(v);
        }
    }

    assert!(!names.contains("continue_execution"));
}

#[test]
fn test_servertool_orchestration_injects_complete_stop_schema_system_contract_without_internal_tool(
) {
    let input = ToolGovernanceInput {
        request: serde_json::json!({
          "model": "gpt-4o-mini",
          "messages": [{"role": "user", "content": "继续修 stopless"}],
          "tools": [
            {
              "type": "function",
              "function": {
                "name": "exec_command",
                "parameters": { "type": "object", "properties": { "cmd": { "type": "string" } }, "required": ["cmd"] }
              }
            }
          ]
        }),
        raw_payload: serde_json::json!({}),
        metadata: serde_json::json!({
          "clientInjectReady": true,
        }),
        entry_endpoint: "/v1/chat/completions".to_string(),
        request_id: "req_reasoning_stop_tool_schema".to_string(),
        has_active_stop_message_for_continue_execution: Some(true),
        metadata_center_snapshot: serde_json::json!({
          "requestTruth": {
            "sessionId": "sess_reasoning_stop_tool_schema"
          },
          "runtimeControl": {
            "stopMessage": {
              "enabled": true
            }
          }
        }),
    };

    let result = apply_req_process_tool_governance(input).unwrap();
    let tools = result
        .processed_request
        .as_object()
        .and_then(|row| row.get("tools"))
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();

    let instructions = first_chat_system_message_text(&result.processed_request);
    assert!(
        !tools
            .iter()
            .any(|tool| resolve_tool_name(tool).as_deref() == Some("reasoningStop")),
        "internal stop hook tool must not reach the provider: {tools:?}"
    );
    assert!(
        instructions.contains("必选合同"),
        "instructions={instructions}"
    );
    assert!(
        instructions.contains("可选字段"),
        "instructions={instructions}"
    );
    assert!(
        instructions.contains("字段类型"),
        "instructions={instructions}"
    );
    assert!(
        instructions.contains("0=finished"),
        "instructions={instructions}"
    );
    assert!(
        instructions.contains("1=blocked"),
        "instructions={instructions}"
    );
    assert!(
        instructions.contains("2=continue_needed"),
        "instructions={instructions}"
    );
    assert!(
        instructions.contains("finished 示例")
            && instructions.contains("blocked 示例")
            && instructions.contains("continue_needed 示例"),
        "instructions={instructions}"
    );
    assert!(
        instructions.contains("\"stopreason\":0")
            && instructions.contains("\"stopreason\":1")
            && instructions.contains("\"stopreason\":2"),
        "instructions={instructions}"
    );
    assert!(
        instructions.contains("<rcc_stop_schema>") && instructions.contains("</rcc_stop_schema>"),
        "instructions={instructions}"
    );
    assert!(
        !instructions.contains("reasoningStop")
            && !instructions.contains("servertool")
            && !instructions.contains("hook"),
        "system contract must not expose internal stopless machinery: {instructions}"
    );
    assert!(
        !instructions.contains("已收敛") && !instructions.contains("任务已经完成"),
        "instructions must not make task-state judgments for the model: {instructions}"
    );
}

#[test]
fn test_terminal_budget_exhausted_stopless_turn_strips_reasoning_stop_controls() {
    let input = ToolGovernanceInput {
        request: serde_json::json!({
          "model": "gpt-4o-mini",
          "instructions": "当你准备结束当前轮时，必须使用唯一 stop schema 合同。\n优先路径：直接调用名为 reasoningStop 的 function tool，并把完整 JSON schema 放进该 tool call 的 arguments。\n禁止把 reasoningStop 当成 shell / CLI 命令；不要输出或执行 exec_command(cmd=\"reasoningStop\")。\n如果你直接 finish_reason=stop，正文末尾必须附：\n<rcc_stop_schema>\n{\"stopreason\":2,\"reason\":\"当前状态原因\",\"has_evidence\":0,\"evidence\":\"\",\"issue_cause\":\"\",\"excluded_factors\":\"\",\"diagnostic_order\":\"\",\"done_steps\":\"\",\"next_step\":\"如果仍需继续，写立刻执行的下一步；否则写无\",\"next_suggested_path\":\"\",\"needs_user_input\":false,\"learned\":\"\"}\n</rcc_stop_schema>",
          "input": [
            {
              "type": "function_call_output",
              "call_id": "call_stop_budget_terminal",
              "output": "{\"toolName\":\"stop_message_auto\",\"summary\":\"stopless budget exhausted\",\"schemaGuidance\":{\"triggerHint\":\"budget_exhausted\"}}"
            }
          ],
          "tools": [
            {
              "type": "function",
              "function": {
                "name": "reasoningStop",
                "parameters": { "type": "object", "properties": { "stopreason": { "type": "integer" } } }
              }
            },
            {
              "type": "function",
              "function": {
                "name": "exec_command",
                "parameters": { "type": "object", "properties": { "cmd": { "type": "string" } }, "required": ["cmd"] }
              }
            }
          ],
          "tool_choice": "required"
        }),
        raw_payload: serde_json::json!({}),
        metadata: serde_json::json!({
          "clientInjectReady": true
        }),
        entry_endpoint: "/v1/responses".to_string(),
        request_id: "req_reasoning_stop_budget_terminal".to_string(),
        has_active_stop_message_for_continue_execution: Some(true),
        metadata_center_snapshot: serde_json::json!({
          "runtimeControl": {
            "stopMessage": {
              "enabled": true
            }
          }
        }),
    };

    let result = apply_req_process_tool_governance(input).unwrap();
    let processed = result
        .processed_request
        .as_object()
        .expect("processed request");
    assert!(
        processed.get("instructions").is_none(),
        "budget exhausted terminal turn must drop prior stopless instructions"
    );
    let tools = processed
        .get("tools")
        .and_then(|value| value.as_array())
        .cloned()
        .unwrap_or_default();
    let tool_names: HashSet<String> = tools.iter().filter_map(resolve_tool_name).collect();
    assert!(
        !tool_names.contains("reasoningStop"),
        "budget exhausted terminal turn must not expose reasoningStop again"
    );
    assert!(
        tool_names.contains("exec_command"),
        "non-stopless tools must be preserved"
    );
    assert!(
        processed
            .get("tool_choice")
            .and_then(|value| value.as_str())
            != Some("required"),
        "budget exhausted terminal turn must not keep required tool choice"
    );
}

#[test]
fn test_non_terminal_stopless_feedback_keeps_schema_contract_without_internal_tool() {
    let input = ToolGovernanceInput {
        request: serde_json::json!({
          "model": "gpt-4o-mini",
          "input": [
            {
              "type": "function_call_output",
              "call_id": "call_stop_retry",
              "output": "{\"toolName\":\"stop_message_auto\",\"flowId\":\"stop_message_flow\",\"repeatCount\":1,\"maxRepeats\":3,\"schemaGuidance\":{\"triggerHint\":\"invalid_schema\"},\"input\":{\"flowId\":\"stop_message_flow\",\"repeatCount\":1,\"maxRepeats\":3,\"triggerHint\":\"invalid_schema\"}}"
            }
          ]
        }),
        raw_payload: serde_json::json!({}),
        metadata: serde_json::json!({
          "clientInjectReady": true
        }),
        entry_endpoint: "/v1/responses".to_string(),
        request_id: "req_reasoning_stop_retry".to_string(),
        has_active_stop_message_for_continue_execution: Some(true),
        metadata_center_snapshot: serde_json::json!({
          "requestTruth": {
            "sessionId": "sess-stopless-request-owner"
          },
          "runtimeControl": {
            "stopMessage": {
              "enabled": true
            }
          }
        }),
    };

    let result = apply_req_process_tool_governance(input).unwrap();
    let processed = result
        .processed_request
        .as_object()
        .expect("processed request");
    let instructions = first_responses_system_input_text(&result.processed_request);
    assert!(
        instructions.contains("<rcc_stop_schema>"),
        "non-terminal feedback must keep stopless instruction"
    );
    assert!(
        result.metadata["runtime_control"]["stopless"]["sessionId"]
            == serde_json::json!("sess-stopless-request-owner"),
        "request ChatProcess must bind CLI-derived stopless runtime control to current request truth sessionId: {}",
        result.metadata
    );
    let tools = processed
        .get("tools")
        .and_then(|value| value.as_array())
        .cloned()
        .unwrap_or_default();
    let tool_names: HashSet<String> = tools.iter().filter_map(resolve_tool_name).collect();
    assert!(
        !tool_names.contains("reasoningStop"),
        "non-terminal feedback must not expose internal reasoningStop"
    );
}

#[test]
fn test_submit_tool_outputs_stopless_cli_updates_runtime_control() {
    let cli_output = serde_json::json!({
        "ok": true,
        "kind": "stop_message_auto",
        "tool": "stop_message_auto",
        "input": {
            "flowId": "stop_message_flow",
            "repeatCount": 1,
            "maxRepeats": 3,
            "triggerHint": "invalid_schema"
        },
        "schemaFeedback": {
            "reasonCode": "stop_schema_next_step_missing",
            "missingFields": ["next_step"]
        }
    });
    let input = ToolGovernanceInput {
        request: serde_json::json!({
          "model": "gpt-5.3-codex",
          "tool_outputs": [
            {
              "tool_call_id": "call_stop_retry",
              "output": cli_output.to_string()
            }
          ]
        }),
        raw_payload: serde_json::json!({}),
        metadata: serde_json::json!({
          "entryEndpoint": "/v1/responses.submit_tool_outputs",
          "clientInjectReady": true
        }),
        entry_endpoint: "/v1/responses.submit_tool_outputs".to_string(),
        request_id: "req_submit_stopless_runtime_control".to_string(),
        has_active_stop_message_for_continue_execution: Some(true),
        metadata_center_snapshot: serde_json::json!({
          "runtimeControl": {
            "stopMessage": {
              "enabled": true
            }
          }
        }),
    };

    let result = apply_req_process_tool_governance(input).unwrap();
    let stopless = &result.metadata["runtime_control"]["stopless"];
    assert_eq!(stopless["flowId"].as_str(), Some("stop_message_flow"));
    assert_eq!(stopless["repeatCount"].as_u64(), Some(1));
    assert_eq!(stopless["maxRepeats"].as_u64(), Some(3));
    assert_eq!(stopless["triggerHint"].as_str(), Some("invalid_schema"));
    assert_eq!(
        stopless["schemaFeedback"]["reasonCode"].as_str(),
        Some("stop_schema_next_step_missing")
    );
}

#[test]
fn test_plain_user_guidance_resets_snapshot_runtime_control() {
    let input = ToolGovernanceInput {
        request: serde_json::json!({
          "model": "gpt-5.3-codex",
          "input": [
            {
              "type": "message",
              "role": "user",
              "content": [{
                "type": "input_text",
                "text": "上一轮执行结果：repeatCount=1/3；reasonCode=stop_schema_next_step_missing；missingFields=next_step。"
              }]
            }
          ],
          "tools": [
            {
              "type": "function",
              "function": {
                "name": "exec_command",
                "parameters": { "type": "object" }
              }
            }
          ]
        }),
        raw_payload: serde_json::json!({}),
        metadata: serde_json::json!({
          "entryEndpoint": "/v1/responses",
          "clientInjectReady": true
        }),
        entry_endpoint: "/v1/responses".to_string(),
        request_id: "req_materialized_stopless_snapshot_control".to_string(),
        has_active_stop_message_for_continue_execution: Some(true),
        metadata_center_snapshot: serde_json::json!({
          "runtimeControl": {
            "stopMessage": {
              "enabled": true
            },
            "stopless": {
              "active": true,
              "flowId": "stop_message_flow",
              "repeatCount": 1,
              "maxRepeats": 3,
              "triggerHint": "invalid_schema",
              "schemaFeedback": {
                "reasonCode": "stop_schema_next_step_missing",
                "missingFields": ["next_step"]
              }
            }
          }
        }),
    };

    let result = apply_req_process_tool_governance(input).unwrap();
    assert!(
        result.metadata["runtime_control"]["stopless"].is_null(),
        "plain user guidance must not preserve private snapshot state without current structured evidence: {}",
        result.metadata
    );
}

#[test]
fn test_plain_user_guidance_does_not_reconstruct_runtime_control() {
    let input = ToolGovernanceInput {
        request: serde_json::json!({
          "model": "gpt-5.3-codex",
          "input": [
            {
              "type": "message",
              "role": "user",
              "content": [{
                "type": "input_text",
                "text": "上一轮执行结果：repeatCount=1/3；reasonCode=stop_schema_next_step_missing；missingFields=next_step。\n任务还没完成，但当前没有明确 next_step；缺少这些字段：next_step。"
              }]
            }
          ],
          "tools": [
            {
              "type": "function",
              "function": {
                "name": "exec_command",
                "parameters": { "type": "object" }
              }
            }
          ]
        }),
        raw_payload: serde_json::json!({}),
        metadata: serde_json::json!({
          "entryEndpoint": "/v1/responses",
          "clientInjectReady": true
        }),
        entry_endpoint: "/v1/responses".to_string(),
        request_id: "req_materialized_stopless_guidance_control".to_string(),
        has_active_stop_message_for_continue_execution: Some(true),
        metadata_center_snapshot: serde_json::json!({
          "runtimeControl": {
            "stopMessage": {
              "enabled": true
            }
          }
        }),
    };

    let result = apply_req_process_tool_governance(input).unwrap();
    assert!(
        result.metadata["runtime_control"]["stopless"].is_null(),
        "plain user guidance must not reconstruct private stopless state: {}",
        result.metadata
    );
}

#[test]
fn test_terminal_schema_pass_stopless_turn_strips_reasoning_stop_controls() {
    let input = ToolGovernanceInput {
        request: serde_json::json!({
          "model": "gpt-4o-mini",
          "instructions": "当你准备结束当前轮时，必须使用唯一 stop schema 合同。\n优先路径：直接调用名为 reasoningStop 的 function tool，并把完整 JSON schema 放进该 tool call 的 arguments。\n禁止把 reasoningStop 当成 shell / CLI 命令；不要输出或执行 exec_command(cmd=\"reasoningStop\")。\n如果你直接 finish_reason=stop，正文末尾必须附：\n<rcc_stop_schema>\n{\"stopreason\":2,\"reason\":\"当前状态原因\",\"has_evidence\":0,\"evidence\":\"\",\"issue_cause\":\"\",\"excluded_factors\":\"\",\"diagnostic_order\":\"\",\"done_steps\":\"\",\"next_step\":\"如果仍需继续，写立刻执行的下一步；否则写无\",\"next_suggested_path\":\"\",\"needs_user_input\":false,\"learned\":\"\"}\n</rcc_stop_schema>",
          "input": [
            {
              "type": "function_call_output",
              "call_id": "call_stop_schema_pass",
              "output": "{\"toolName\":\"stop_message_auto\",\"summary\":\"stopless terminal schema accepted\",\"schemaGuidance\":{\"triggerHint\":\"schema_pass\"}}"
            }
          ],
          "tools": [
            {
              "type": "function",
              "function": {
                "name": "reasoningStop",
                "parameters": { "type": "object", "properties": { "stopreason": { "type": "integer" } } }
              }
            }
          ]
        }),
        raw_payload: serde_json::json!({}),
        metadata: serde_json::json!({
          "clientInjectReady": true
        }),
        entry_endpoint: "/v1/responses".to_string(),
        request_id: "req_reasoning_stop_schema_pass".to_string(),
        has_active_stop_message_for_continue_execution: Some(true),
        metadata_center_snapshot: serde_json::json!({
          "runtimeControl": {
            "stopMessage": {
              "enabled": true
            }
          }
        }),
    };

    let result = apply_req_process_tool_governance(input).unwrap();
    let processed = result
        .processed_request
        .as_object()
        .expect("processed request");
    assert!(processed.get("instructions").is_none());
    let tools = processed
        .get("tools")
        .and_then(|value| value.as_array())
        .cloned()
        .unwrap_or_default();
    let tool_names: HashSet<String> = tools.iter().filter_map(resolve_tool_name).collect();
    assert!(
        !tool_names.contains("reasoningStop"),
        "terminal schema_pass turn must not expose reasoningStop again"
    );
}

#[test]
fn test_terminal_schema_pass_input_trigger_only_still_strips_reasoning_stop_controls() {
    let input = ToolGovernanceInput {
        request: serde_json::json!({
          "model": "gpt-4o-mini",
          "instructions": "当你准备结束当前轮时，必须使用唯一 stop schema 合同。\n优先路径：直接调用名为 reasoningStop 的 function tool，并把完整 JSON schema 放进该 tool call 的 arguments。\n禁止把 reasoningStop 当成 shell / CLI 命令；不要输出或执行 exec_command(cmd=\"reasoningStop\")。\n如果你直接 finish_reason=stop，正文末尾必须附：\n<rcc_stop_schema>\n{\"stopreason\":2,\"reason\":\"当前状态原因\",\"has_evidence\":0,\"evidence\":\"\",\"issue_cause\":\"\",\"excluded_factors\":\"\",\"diagnostic_order\":\"\",\"done_steps\":\"\",\"next_step\":\"如果仍需继续，写立刻执行的下一步；否则写无\",\"next_suggested_path\":\"\",\"needs_user_input\":false,\"learned\":\"\"}\n</rcc_stop_schema>",
          "input": [
            {
              "type": "function_call_output",
              "call_id": "call_stop_schema_pass_input_only",
              "output": "{\"toolName\":\"stop_message_auto\",\"summary\":\"stopless terminal schema accepted\",\"input\":{\"triggerHint\":\"schema_pass\",\"flowId\":\"stop_message_flow\",\"repeatCount\":2,\"maxRepeats\":3}}"
            }
          ],
          "tools": [
            {
              "type": "function",
              "function": {
                "name": "reasoningStop",
                "parameters": { "type": "object", "properties": { "stopreason": { "type": "integer" } } }
              }
            }
          ]
        }),
        raw_payload: serde_json::json!({}),
        metadata: serde_json::json!({
          "clientInjectReady": true
        }),
        entry_endpoint: "/v1/responses".to_string(),
        request_id: "req_reasoning_stop_schema_pass_input_only".to_string(),
        has_active_stop_message_for_continue_execution: Some(true),
        metadata_center_snapshot: serde_json::json!({
          "runtimeControl": {
            "stopMessage": {
              "enabled": true
            }
          }
        }),
    };

    let result = apply_req_process_tool_governance(input).unwrap();
    let processed = result
        .processed_request
        .as_object()
        .expect("processed request");
    assert!(processed.get("instructions").is_none());
    let tools = processed
        .get("tools")
        .and_then(|value| value.as_array())
        .cloned()
        .unwrap_or_default();
    let tool_names: HashSet<String> = tools.iter().filter_map(resolve_tool_name).collect();
    assert!(
        !tool_names.contains("reasoningStop"),
        "terminal schema_pass input trigger must not expose reasoningStop again"
    );
}

#[test]
fn test_terminal_schema_pass_metadata_center_runtime_control_still_strip_reasoning_stop_controls() {
    let input = ToolGovernanceInput {
        request: serde_json::json!({
          "model": "gpt-4o-mini",
          "instructions": "当你准备结束当前轮时，必须使用唯一 stop schema 合同。\n优先路径：直接调用名为 reasoningStop 的 function tool，并把完整 JSON schema 放进该 tool call 的 arguments。\n禁止把 reasoningStop 当成 shell / CLI 命令；不要输出或执行 exec_command(cmd=\"reasoningStop\")。\n如果你直接 finish_reason=stop，正文末尾必须附：\n<rcc_stop_schema>\n{\"stopreason\":2,\"reason\":\"当前状态原因\",\"has_evidence\":0,\"evidence\":\"\",\"issue_cause\":\"\",\"excluded_factors\":\"\",\"diagnostic_order\":\"\",\"done_steps\":\"\",\"next_step\":\"如果仍需继续，写立刻执行的下一步；否则写无\",\"next_suggested_path\":\"\",\"needs_user_input\":false,\"learned\":\"\"}\n</rcc_stop_schema>",
          "input": [
            {
              "type": "message",
              "role": "user",
              "content": [{ "type": "input_text", "text": "继续执行当前任务" }]
            }
          ],
          "tools": [
            {
              "type": "function",
              "function": {
                "name": "reasoningStop",
                "parameters": { "type": "object", "properties": { "stopreason": { "type": "integer" } } }
              }
            }
          ]
        }),
        raw_payload: serde_json::json!({}),
        metadata: serde_json::json!({
          "clientInjectReady": true,
          "runtime_control": {
            "stopless": {
              "sessionId": "sess-stopless-runtime-control",
              "flowId": "stop_message_flow",
              "repeatCount": 2,
              "maxRepeats": 3,
              "triggerHint": "schema_pass",
              "continuationPrompt": "",
              "schemaFeedback": {
                "reasonCode": "stop_schema_pass"
              },
              "active": true,
              "updatedAt": 1782000000000u64
            }
          }
        }),
        entry_endpoint: "/v1/responses".to_string(),
        request_id: "req_reasoning_stop_schema_pass_metadata_center".to_string(),
        has_active_stop_message_for_continue_execution: Some(true),
        metadata_center_snapshot: serde_json::json!({
          "runtimeControl": {
            "stopMessage": {
              "enabled": true
            }
          }
        }),
    };

    let result = apply_req_process_tool_governance(input).unwrap();
    let processed = result
        .processed_request
        .as_object()
        .expect("processed request");
    assert!(processed.get("instructions").is_none());
    let tools = processed
        .get("tools")
        .and_then(|value| value.as_array())
        .cloned()
        .unwrap_or_default();
    let tool_names: HashSet<String> = tools.iter().filter_map(resolve_tool_name).collect();
    assert!(
        !tool_names.contains("reasoningStop"),
        "metadata-center terminal schema_pass must strip reasoningStop without leaking into direct payload"
    );
}

#[test]
fn test_terminal_budget_exhausted_reason_code_in_metadata_center_still_strips_reasoning_stop_controls(
) {
    let input = ToolGovernanceInput {
        request: serde_json::json!({
          "model": "gpt-4o-mini",
          "instructions": "当你准备结束当前轮时，必须使用唯一 stop schema 合同。\n优先路径：直接调用名为 reasoningStop 的 function tool，并把完整 JSON schema 放进该 tool call 的 arguments。\n禁止把 reasoningStop 当成 shell / CLI 命令；不要输出或执行 exec_command(cmd=\"reasoningStop\")。\n如果你直接 finish_reason=stop，正文末尾必须附：\n<rcc_stop_schema>\n{\"stopreason\":2,\"reason\":\"当前状态原因\",\"has_evidence\":0,\"evidence\":\"\",\"issue_cause\":\"\",\"excluded_factors\":\"\",\"diagnostic_order\":\"\",\"done_steps\":\"\",\"next_step\":\"如果仍需继续，写立刻执行的下一步；否则写无\",\"next_suggested_path\":\"\",\"needs_user_input\":false,\"learned\":\"\"}\n</rcc_stop_schema>",
          "input": [
            {
              "type": "message",
              "role": "user",
              "content": [{ "type": "input_text", "text": "继续执行当前任务" }]
            }
          ],
          "tools": [
            {
              "type": "function",
              "function": {
                "name": "reasoningStop",
                "parameters": { "type": "object", "properties": { "stopreason": { "type": "integer" } } }
              }
            }
          ]
        }),
        raw_payload: serde_json::json!({}),
        metadata: serde_json::json!({
          "clientInjectReady": true,
          "runtime_control": {
            "stopless": {
              "sessionId": "sess-stopless-budget-reason-code",
              "flowId": "stop_message_flow",
              "repeatCount": 3,
              "maxRepeats": 3,
              "triggerHint": "stop_schema_budget_exhausted",
              "continuationPrompt": "继续；按上一轮反馈处理。",
              "schemaFeedback": {
                "reasonCode": "stop_schema_budget_exhausted"
              },
              "active": true,
              "updatedAt": 1782000000001u64
            }
          }
        }),
        entry_endpoint: "/v1/responses".to_string(),
        request_id: "req_reasoning_stop_budget_exhausted_reason_code_metadata_center".to_string(),
        has_active_stop_message_for_continue_execution: Some(true),
        metadata_center_snapshot: serde_json::json!({
          "runtimeControl": {
            "stopMessage": {
              "enabled": true
            }
          }
        }),
    };

    let result = apply_req_process_tool_governance(input).unwrap();
    let processed = result
        .processed_request
        .as_object()
        .expect("processed request");
    assert!(processed.get("instructions").is_none());
    let tools = processed
        .get("tools")
        .and_then(|value| value.as_array())
        .cloned()
        .unwrap_or_default();
    let tool_names: HashSet<String> = tools.iter().filter_map(resolve_tool_name).collect();
    assert!(
        !tool_names.contains("reasoningStop"),
        "metadata-center budget-exhausted reason code must still strip reasoningStop"
    );
}

#[test]
fn test_captured_tool_results_alone_no_longer_strip_reasoning_stop_controls() {
    let input = ToolGovernanceInput {
        request: serde_json::json!({
          "model": "gpt-4o-mini",
          "input": [
            {
              "type": "message",
              "role": "user",
              "content": [{ "type": "input_text", "text": "继续执行当前任务" }]
            }
          ]
        }),
        raw_payload: serde_json::json!({}),
        metadata: serde_json::json!({
          "clientInjectReady": true,
          "runtime_control": {
            "stopless": {
              "active": true
            }
          },
          "context": {
            "__captured_tool_results": [
              {
                "tool_call_id": "call_stop_schema_pass_captured",
                "call_id": "call_stop_schema_pass_captured",
                "name": "reasoningStop",
                "output": "{\"toolName\":\"stop_message_auto\",\"summary\":\"stopless terminal schema accepted\",\"input\":{\"triggerHint\":\"schema_pass\",\"flowId\":\"stop_message_flow\",\"repeatCount\":2,\"maxRepeats\":3}}"
              }
            ]
          }
        }),
        entry_endpoint: "/v1/responses".to_string(),
        request_id: "req_reasoning_stop_schema_pass_captured_legacy_only".to_string(),
        has_active_stop_message_for_continue_execution: Some(true),
        metadata_center_snapshot: serde_json::json!({
          "requestTruth": {
            "sessionId": "sess_reasoning_stop_schema_pass_captured_legacy_only"
          },
          "runtimeControl": {
            "stopMessage": {
              "enabled": true
            }
          }
        }),
    };

    let result = apply_req_process_tool_governance(input).unwrap();
    let processed = result
        .processed_request
        .as_object()
        .expect("processed request");
    let instructions = first_responses_system_input_text(&result.processed_request);
    assert!(
        instructions.contains("<rcc_stop_schema>"),
        "legacy captured tool results must not act as terminal metadata-center truth"
    );
    let tools = processed
        .get("tools")
        .and_then(|value| value.as_array())
        .cloned()
        .unwrap_or_default();
    let tool_names: HashSet<String> = tools.iter().filter_map(resolve_tool_name).collect();
    assert!(
        !tool_names.contains("reasoningStop"),
        "provider request must not expose reasoningStop even when legacy captured tool results are ignored"
    );
}

fn assert_apply_patch_custom_freeform_tool(tool: &serde_json::Value) {
    assert_eq!(tool["type"].as_str(), Some("custom"));
    assert_eq!(tool["name"].as_str(), Some("apply_patch"));
    assert!(tool.get("function").is_none());
    assert!(tool.get("parameters").is_none());
    let definition = tool["format"]["definition"]
        .as_str()
        .expect("apply_patch grammar definition");
    assert!(definition.contains("begin_patch: \"*** Begin Patch\" LF"));
    assert!(definition.contains("end_patch: \"*** End Patch\" LF?"));
    let serialized = serde_json::to_string(tool).expect("serialize apply_patch tool");
    assert!(!serialized.contains("\"input\""));
    assert!(!serialized.contains("\"filePath\""));
    assert!(!serialized.contains("\"fileContent\""));
}

#[test]
fn test_chat_process_apply_patch_declared_legacy_fields_projects_custom_freeform_tool() {
    let input = ToolGovernanceInput {
        request: serde_json::json!({
          "model": "MiniMax-M2.7",
          "messages": [{"role": "user", "content": "edit file"}],
          "tools": [
            {
              "type": "function",
              "function": {
                "name": "apply_patch",
                "description": "Edit files through apply_patch. Upstream authoring mode is decided by schema; client still receives canonical apply_patch back.",
                "parameters": {
                  "type": "object",
                  "properties": {
                    "patch": {
                      "type": "string",
                      "description": "Patch text using *** Begin Patch / *** End Patch grammar. Paths are workspace-relative."
                    },
                    "input": {
                      "type": "string",
                      "description": "Backward-compatible alias of patch for schema-shaped callers only. Prefer patch."
                    },
                    "filePath": {
                      "type": "string",
                      "description": "target file path"
                    },
                    "fileContent": {
                      "type": "string",
                      "description": "current file content"
                    }
                  },
                  "required": ["patch"]
                }
              }
            }
          ]
        }),
        raw_payload: serde_json::json!({}),
        metadata: serde_json::json!({
          "entryEndpoint": "/v1/responses",
          "__rt": { "applyPatch": { "mode": "servertool" } }
        }),
        entry_endpoint: "/v1/responses".to_string(),
        request_id: "req_apply_patch_no_rewrite_servertool_mode".to_string(),
        has_active_stop_message_for_continue_execution: None,
        metadata_center_snapshot: serde_json::json!({}),
    };

    let result = apply_req_process_tool_governance(input).unwrap();
    assert_apply_patch_custom_freeform_tool(&result.processed_request["tools"][0]);
}

#[test]
fn test_chat_process_apply_patch_without_internal_fields_projects_custom_freeform_tool_by_default()
{
    let input = ToolGovernanceInput {
        request: serde_json::json!({
          "model": "MiniMax-M2.7",
          "messages": [{"role": "user", "content": "edit file"}],
          "tools": [
            {
              "type": "function",
              "function": {
                "name": "apply_patch",
                "description": "Edit files by patch",
                "parameters": {
                  "type": "object",
                  "properties": {
                    "patch": {
                      "type": "string",
                      "description": "Patch text using *** Begin Patch / *** End Patch grammar."
                    }
                  },
                  "required": ["patch"]
                }
              }
            }
          ]
        }),
        raw_payload: serde_json::json!({}),
        metadata: serde_json::json!({
          "entryEndpoint": "/v1/responses"
        }),
        entry_endpoint: "/v1/responses".to_string(),
        request_id: "req_apply_patch_canonical_contract".to_string(),
        has_active_stop_message_for_continue_execution: None,
        metadata_center_snapshot: serde_json::json!({}),
    };

    let result = apply_req_process_tool_governance(input).unwrap();
    assert_apply_patch_custom_freeform_tool(&result.processed_request["tools"][0]);
}

#[test]
fn test_chat_process_apply_patch_direct_responses_tool_shape_projects_custom_freeform_tool() {
    let input = ToolGovernanceInput {
        request: serde_json::json!({
          "model": "glm-4.7",
          "messages": [{"role": "user", "content": "edit file"}],
          "tools": [
            {
              "type": "function",
              "name": "apply_patch",
              "description": "Edit files through apply_patch. Upstream authoring mode is decided by schema; client still receives canonical apply_patch back.",
              "parameters": {
                "type": "object",
                "properties": {
                  "patch": {
                    "type": "string",
                    "description": "Patch text using *** Begin Patch / *** End Patch grammar. Paths are workspace-relative."
                  },
                  "input": {
                    "type": "string",
                    "description": "Backward-compatible alias of patch for schema-shaped callers only. Prefer patch."
                  },
                  "filePath": {
                    "type": "string",
                    "description": "target file path"
                  },
                  "fileContent": {
                    "type": "string",
                    "description": "current file content"
                  }
                },
                "required": ["patch"],
                "additionalProperties": false
              }
            }
          ]
        }),
        raw_payload: serde_json::json!({}),
        metadata: serde_json::json!({
          "entryEndpoint": "/v1/responses",
          "__rt": { "applyPatch": { "mode": "servertool" } }
        }),
        entry_endpoint: "/v1/responses".to_string(),
        request_id: "req_apply_patch_direct_shape_no_rewrite".to_string(),
        has_active_stop_message_for_continue_execution: None,
        metadata_center_snapshot: serde_json::json!({}),
    };

    let result = apply_req_process_tool_governance(input).unwrap();
    assert_apply_patch_custom_freeform_tool(&result.processed_request["tools"][0]);
}

#[test]
fn test_apply_req_process_tool_governance_json_matches_core_shape() {
    let input = ToolGovernanceInput {
        request: serde_json::json!({
            "model": "gpt-4",
            "messages": [{"role": "user", "content": "hello"}]
        }),
        raw_payload: serde_json::json!({}),
        metadata: serde_json::json!({"entryEndpoint": "/v1/chat/completions"}),
        entry_endpoint: "/v1/chat/completions".to_string(),
        request_id: "req_equiv_req".to_string(),
        has_active_stop_message_for_continue_execution: None,
        metadata_center_snapshot: serde_json::json!({}),
    };
    let input_json = serde_json::to_string(&input).unwrap();
    let core_input: ToolGovernanceInput = serde_json::from_str(&input_json).unwrap();
    let core =
        serde_json::to_value(apply_req_process_tool_governance(core_input).expect("core")).unwrap();
    let json_out: serde_json::Value =
        serde_json::from_str(&apply_req_process_tool_governance_json(input_json).expect("json"))
            .unwrap();
    assert_eq!(
        json_out["processedRequest"]["messages"],
        core["processedRequest"]["messages"]
    );
    assert_eq!(
        json_out["processedRequest"]["model"],
        core["processedRequest"]["model"]
    );
    assert_eq!(
        json_out["processedRequest"]["tools"],
        core["processedRequest"]["tools"]
    );
    assert_eq!(
        json_out["processedRequest"]["processed"]["status"],
        core["processedRequest"]["processed"]["status"]
    );
    assert_eq!(
        json_out["processedRequest"]["processed"]["appliedRules"],
        core["processedRequest"]["processed"]["appliedRules"]
    );
    assert_eq!(
        json_out["nodeResult"]["success"],
        core["nodeResult"]["success"]
    );
    assert_eq!(json_out["nodeResult"]["stage"], core["nodeResult"]["stage"]);
}
