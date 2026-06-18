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
          "clientInjectReady": true
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
          "clientInjectReady": true
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
          "clientInjectReady": true
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
fn test_chat_process_apply_patch_declared_legacy_fields_no_longer_rewrite_in_servertool_mode() {
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
    let tool = result.processed_request["tools"][0]["function"]
        .as_object()
        .unwrap();
    let properties = tool["parameters"]["properties"].as_object().unwrap();
    let patch_desc = properties["patch"]["description"].as_str().unwrap_or("");
    assert!(patch_desc.contains("*** Begin Patch"));
    assert!(properties.contains_key("patch"));
    assert!(!properties.contains_key("input"));
    assert!(!properties.contains_key("filePath"));
    assert!(!properties.contains_key("fileContent"));
    let required = tool["parameters"]["required"].as_array().unwrap();
    assert_eq!(required, &vec![serde_json::json!("patch")]);
}

#[test]
fn test_chat_process_apply_patch_without_internal_fields_keeps_client_contract_by_default() {
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
    let tool = result.processed_request["tools"][0]["function"]
        .as_object()
        .unwrap();
    let properties = tool["parameters"]["properties"].as_object().unwrap();
    assert!(properties.contains_key("patch"));
    assert!(!properties.contains_key("filePath"));
    assert!(!properties.contains_key("fileContent"));
    let patch_desc = properties["patch"]["description"].as_str().unwrap_or("");
    assert!(patch_desc.contains("*** Begin Patch"));
}

#[test]
fn test_chat_process_apply_patch_direct_responses_tool_shape_no_longer_rewrites_in_servertool_mode()
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
    let tool = result.processed_request["tools"][0].as_object().unwrap();
    let properties = tool["parameters"]["properties"].as_object().unwrap();
    let patch_desc = properties["patch"]["description"].as_str().unwrap_or("");
    assert!(patch_desc.contains("*** Begin Patch"));
    assert!(!properties.contains_key("input"));
    assert!(!properties.contains_key("filePath"));
    assert!(!properties.contains_key("fileContent"));
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
