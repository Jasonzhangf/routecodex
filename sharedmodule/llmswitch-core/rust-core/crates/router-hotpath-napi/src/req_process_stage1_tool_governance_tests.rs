use super::*;
use crate::req_process_stage1_tool_governance_blocks::servertool_injection::resolve_tool_name;
use std::collections::HashSet;

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
    };
    let result = apply_req_process_tool_governance(input).unwrap();
    assert!(result.node_result["success"].as_bool().unwrap());
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
          "clientInjectReady": true,
          "stopMessageEnabled": true,
          "routecodexPortStopMessageEnabled": true
        }),
        entry_endpoint: "/v1/responses".to_string(),
        request_id: "req_stopless_responses_instruction".to_string(),
        has_active_stop_message_for_continue_execution: None,
    };

    let result = apply_req_process_tool_governance(input).unwrap();
    let instructions = result.processed_request["instructions"]
        .as_str()
        .expect("responses instructions");
    assert!(instructions.contains("简洁 summary"));
    assert!(instructions.contains("stopreason 取值：0=finished，1=blocked，2=continue_needed"));
    assert!(instructions.contains("示例 JSON"));
    assert!(instructions.contains("\"stopreason\":0"));
    assert!(instructions.contains("\"reason\":\"已完成并验证\""));
    assert!(result.processed_request["input"].is_array());
}

#[test]
fn test_req_process_does_not_duplicate_stopless_responses_instructions() {
    let existing = "当你准备结束当前轮时，必须同时给出两部分：\n1. 简洁 summary，说明这轮完成了什么或为什么现在必须停。\n2. 回复末尾附一段 JSON，字段必须按真实情况填写。\n标准 JSON 字段：stopreason, reason, has_evidence, evidence, issue_cause, excluded_factors, diagnostic_order, done_steps, next_step, next_suggested_path, needs_user_input, learned。\nstopreason 取值：0=finished，1=blocked，2=continue_needed。\nfinished：表示已经完成，可停止；blocked：表示确实卡住且需要停止；continue_needed：表示还不能停，必须继续推进并给 next_step。";
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
          "stopMessageEnabled": true,
          "routecodexPortStopMessageEnabled": true
        }),
        entry_endpoint: "/v1/responses".to_string(),
        request_id: "req_stopless_responses_instruction_dedup".to_string(),
        has_active_stop_message_for_continue_execution: None,
    };

    let result = apply_req_process_tool_governance(input).unwrap();
    let instructions = result.processed_request["instructions"]
        .as_str()
        .expect("responses instructions");
    assert_eq!(instructions, existing);
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
          "clientInjectReady": true,
          "stopMessageEnabled": true,
          "routecodexPortStopMessageEnabled": true
        }),
        entry_endpoint: "/v1/responses".to_string(),
        request_id: "req_stopless_responses_input".to_string(),
        has_active_stop_message_for_continue_execution: None,
    };

    let result = apply_req_process_tool_governance(input).unwrap();
    let instructions = result.processed_request["instructions"]
        .as_str()
        .expect("responses instructions");
    assert!(instructions.contains("简洁 summary"));
    assert!(instructions.contains("stopreason 取值：0=finished，1=blocked，2=continue_needed"));
    assert!(result.processed_request["input"].is_array());
}

#[test]
fn test_req_process_responses_input_materializes_stopless_instructions_without_client_inject_ready() {
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
          "clientInjectReason": "tmux_session_missing",
          "stopMessageEnabled": true,
          "routecodexPortStopMessageEnabled": true
        }),
        entry_endpoint: "/v1/responses".to_string(),
        request_id: "req_stopless_responses_no_tmux_inject".to_string(),
        has_active_stop_message_for_continue_execution: None,
    };

    let result = apply_req_process_tool_governance(input).unwrap();
    let instructions = result.processed_request["instructions"]
        .as_str()
        .expect("responses instructions");
    assert!(instructions.contains("简洁 summary"));
    assert!(instructions.contains("stopreason 取值：0=finished，1=blocked，2=continue_needed"));
    assert!(result.processed_request["input"].is_array());
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
fn test_servertool_orchestration_injects_reasoning_stop_tool_with_schema_and_example() {
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
          "stopMessageEnabled": true,
          "routecodexPortStopMessageEnabled": true
        }),
        entry_endpoint: "/v1/chat/completions".to_string(),
        request_id: "req_reasoning_stop_tool_schema".to_string(),
        has_active_stop_message_for_continue_execution: Some(true),
    };

    let result = apply_req_process_tool_governance(input).unwrap();
    let tools = result
        .processed_request
        .as_object()
        .and_then(|row| row.get("tools"))
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();

    let reasoning_stop = tools
        .iter()
        .find(|tool| resolve_tool_name(tool).as_deref() == Some("reasoningStop"))
        .expect("reasoningStop tool");
    let instructions = result
        .processed_request
        .as_object()
        .and_then(|row| row.get("instructions"))
        .and_then(|value| value.as_str())
        .expect("stopless instructions");

    let function = reasoning_stop["function"].as_object().expect("function");
    let description = function["description"].as_str().expect("description");
    let parameters = function["parameters"].as_object().expect("parameters");
    let properties = parameters["properties"].as_object().expect("properties");
    let required = parameters["required"].as_array().expect("required");

    assert!(description.contains("stopreason"), "description={description}");
    assert!(description.contains("0=finished"), "description={description}");
    assert!(description.contains("<rcc_stop_schema>"), "description={description}");
    assert!(description.contains("Schema means the structured JSON contract"), "description={description}");
    assert!(description.contains("Field meanings"), "description={description}");
    assert!(description.contains("\"stopreason\":0"), "description={description}");
    assert!(properties.contains_key("stopreason"));
    assert!(properties.contains_key("reason"));
    assert!(properties.contains_key("next_step"));
    assert!(properties.contains_key("learned"));
    assert!(required.iter().any(|value| value.as_str() == Some("stopreason")));
    assert!(required.iter().any(|value| value.as_str() == Some("reason")));
    assert!(required.iter().any(|value| value.as_str() == Some("has_evidence")));
    assert!(required.iter().any(|value| value.as_str() == Some("next_step")));
    assert!(instructions.contains("直接调用名为 reasoningStop 的 function tool"), "instructions={instructions}");
    assert!(instructions.contains("不要输出或执行 exec_command(cmd=\"reasoningStop\")"), "instructions={instructions}");
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
          "clientInjectReady": true,
          "stopMessageEnabled": true,
          "routecodexPortStopMessageEnabled": true
        }),
        entry_endpoint: "/v1/responses".to_string(),
        request_id: "req_reasoning_stop_budget_terminal".to_string(),
        has_active_stop_message_for_continue_execution: Some(true),
    };

    let result = apply_req_process_tool_governance(input).unwrap();
    let processed = result.processed_request.as_object().expect("processed request");
    assert!(
        processed.get("instructions").is_none(),
        "budget exhausted terminal turn must drop prior stopless instructions"
    );
    let tools = processed
        .get("tools")
        .and_then(|value| value.as_array())
        .cloned()
        .unwrap_or_default();
    let tool_names: HashSet<String> = tools
        .iter()
        .filter_map(resolve_tool_name)
        .collect();
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
fn test_non_terminal_stopless_feedback_keeps_reasoning_stop_controls() {
    let input = ToolGovernanceInput {
        request: serde_json::json!({
          "model": "gpt-4o-mini",
          "input": [
            {
              "type": "function_call_output",
              "call_id": "call_stop_retry",
              "output": "{\"toolName\":\"stop_message_auto\",\"schemaGuidance\":{\"triggerHint\":\"invalid_schema\"}}"
            }
          ]
        }),
        raw_payload: serde_json::json!({}),
        metadata: serde_json::json!({
          "clientInjectReady": true,
          "stopMessageEnabled": true,
          "routecodexPortStopMessageEnabled": true
        }),
        entry_endpoint: "/v1/responses".to_string(),
        request_id: "req_reasoning_stop_retry".to_string(),
        has_active_stop_message_for_continue_execution: Some(true),
    };

    let result = apply_req_process_tool_governance(input).unwrap();
    let processed = result.processed_request.as_object().expect("processed request");
    let instructions = processed
        .get("instructions")
        .and_then(|value| value.as_str())
        .unwrap_or_default();
    assert!(
        instructions.contains("<rcc_stop_schema>"),
        "non-terminal feedback must keep stopless instruction"
    );
    let tools = processed
        .get("tools")
        .and_then(|value| value.as_array())
        .cloned()
        .unwrap_or_default();
    let tool_names: HashSet<String> = tools
        .iter()
        .filter_map(resolve_tool_name)
        .collect();
    assert!(
        tool_names.contains("reasoningStop"),
        "non-terminal feedback must still expose reasoningStop"
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
          "clientInjectReady": true,
          "stopMessageEnabled": true,
          "routecodexPortStopMessageEnabled": true
        }),
        entry_endpoint: "/v1/responses".to_string(),
        request_id: "req_reasoning_stop_schema_pass".to_string(),
        has_active_stop_message_for_continue_execution: Some(true),
    };

    let result = apply_req_process_tool_governance(input).unwrap();
    let processed = result.processed_request.as_object().expect("processed request");
    assert!(processed.get("instructions").is_none());
    let tools = processed
        .get("tools")
        .and_then(|value| value.as_array())
        .cloned()
        .unwrap_or_default();
    let tool_names: HashSet<String> = tools
        .iter()
        .filter_map(resolve_tool_name)
        .collect();
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
          "clientInjectReady": true,
          "stopMessageEnabled": true,
          "routecodexPortStopMessageEnabled": true
        }),
        entry_endpoint: "/v1/responses".to_string(),
        request_id: "req_reasoning_stop_schema_pass_input_only".to_string(),
        has_active_stop_message_for_continue_execution: Some(true),
    };

    let result = apply_req_process_tool_governance(input).unwrap();
    let processed = result.processed_request.as_object().expect("processed request");
    assert!(processed.get("instructions").is_none());
    let tools = processed
        .get("tools")
        .and_then(|value| value.as_array())
        .cloned()
        .unwrap_or_default();
    let tool_names: HashSet<String> = tools
        .iter()
        .filter_map(resolve_tool_name)
        .collect();
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
          "stopMessageEnabled": true,
          "routecodexPortStopMessageEnabled": true,
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
    };

    let result = apply_req_process_tool_governance(input).unwrap();
    let processed = result.processed_request.as_object().expect("processed request");
    assert!(processed.get("instructions").is_none());
    let tools = processed
        .get("tools")
        .and_then(|value| value.as_array())
        .cloned()
        .unwrap_or_default();
    let tool_names: HashSet<String> = tools
        .iter()
        .filter_map(resolve_tool_name)
        .collect();
    assert!(
        !tool_names.contains("reasoningStop"),
        "metadata-center terminal schema_pass must strip reasoningStop without leaking into direct payload"
    );
}

#[test]
fn test_terminal_budget_exhausted_reason_code_in_metadata_center_still_strips_reasoning_stop_controls()
{
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
          "stopMessageEnabled": true,
          "routecodexPortStopMessageEnabled": true,
          "runtime_control": {
            "stopless": {
              "sessionId": "sess-stopless-budget-reason-code",
              "flowId": "stop_message_flow",
              "repeatCount": 3,
              "maxRepeats": 3,
              "triggerHint": "stop_schema_budget_exhausted",
              "continuationPrompt": "不要再继续执行了",
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
    };

    let result = apply_req_process_tool_governance(input).unwrap();
    let processed = result.processed_request.as_object().expect("processed request");
    assert!(processed.get("instructions").is_none());
    let tools = processed
        .get("tools")
        .and_then(|value| value.as_array())
        .cloned()
        .unwrap_or_default();
    let tool_names: HashSet<String> = tools
        .iter()
        .filter_map(resolve_tool_name)
        .collect();
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
          "stopMessageEnabled": true,
          "routecodexPortStopMessageEnabled": true,
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
    };

    let result = apply_req_process_tool_governance(input).unwrap();
    let processed = result.processed_request.as_object().expect("processed request");
    let instructions = processed
        .get("instructions")
        .and_then(|value| value.as_str())
        .unwrap_or_default();
    assert!(
        instructions.contains("<rcc_stop_schema>"),
        "legacy captured tool results must not act as terminal metadata-center truth"
    );
    let tools = processed
        .get("tools")
        .and_then(|value| value.as_array())
        .cloned()
        .unwrap_or_default();
    let tool_names: HashSet<String> = tools
        .iter()
        .filter_map(resolve_tool_name)
        .collect();
    assert!(
        tool_names.contains("reasoningStop"),
        "legacy captured tool results alone must not strip reasoningStop"
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
    };

    let result = apply_req_process_tool_governance(input).unwrap();
    assert_apply_patch_custom_freeform_tool(&result.processed_request["tools"][0]);
}

#[test]
fn test_chat_process_apply_patch_direct_responses_tool_shape_projects_custom_freeform_tool()
{
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
