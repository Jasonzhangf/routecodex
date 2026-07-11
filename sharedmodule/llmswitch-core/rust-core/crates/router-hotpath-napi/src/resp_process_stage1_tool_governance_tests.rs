use super::*;
use crate::resp_process_stage1_tool_governance_blocks::exec_command_args::strip_python_heredoc_pseudo_escapes;
use crate::resp_process_stage1_tool_governance_blocks::json_args::read_string_array_command;
use crate::resp_process_stage1_tool_governance_blocks::orchestrator::prepare_payload_for_governance;
use serde_json::Value;

use crate::resp_process_stage1_tool_governance_blocks::apply_patch_schema_args::normalize_apply_patch_text;
use crate::resp_process_stage1_tool_governance_blocks::apply_patch_text::{
    decode_escaped_newlines_if_needed, extract_apply_patch_text, normalize_apply_patch_header_line,
    normalize_apply_patch_header_path,
};
use crate::resp_process_stage1_tool_governance_blocks::display_sanitize::{
    sanitize_textual_marker_field_in_message, strip_text_tool_wrapper_noise,
    strip_tool_call_marker_payload,
};
use crate::resp_process_stage1_tool_governance_blocks::exec_command_args::read_command_from_args;
use crate::resp_process_stage1_tool_governance_blocks::json_args::{
    parse_json_record, parse_tool_args_json_with_artifact_repair,
};
use crate::resp_process_stage1_tool_governance_blocks::message_content::read_message_text_candidates;
use crate::resp_process_stage1_tool_governance_blocks::text_harvest_extract::{
    collect_harvest_text_variants, extract_reasoning_inline_exec_command_arg_key,
    extract_tool_prefixed_exec_command_block, extract_xml_named_tool_call_blocks,
    extract_xml_tool_call_blocks,
};
use crate::resp_process_stage1_tool_governance_blocks::text_harvest_strict::harvest_text_tool_calls_from_payload;
use crate::resp_process_stage1_tool_governance_blocks::tool_args::{
    normalize_tool_args, normalize_tool_args_preserving_raw_shape,
};
use crate::resp_process_stage1_tool_governance_blocks::tool_call_entry::{
    extract_json_candidates_from_text, extract_tool_call_entries_from_malformed_tool_calls_text,
    extract_tool_call_entries_from_unknown, normalize_tool_call_entry,
    parse_tool_calls_shape_from_text,
};
use crate::resp_process_stage1_tool_governance_blocks::tool_call_governance::{
    count_normalized_tool_calls, maybe_harvest_empty_tool_calls_from_json_content,
    normalize_apply_patch_tool_calls, remap_tool_calls_for_client_protocol,
};
use crate::resp_process_stage1_tool_governance_blocks::xml_text_utils::{
    strip_xml_tags_preserve_text, unwrap_xml_cdata_sections,
};
use crate::shared_json_utils::{
    extract_balanced_json_array_at, extract_balanced_json_object_at, read_workdir_from_args,
};
use crate::shared_tool_mapping::normalize_routecodex_tool_name;
use crate::shared_tooling::extract_rcc_tool_call_fence_segments;
use serde_json::json;
use serde_json::Map;

#[test]
fn test_prepare_payload_for_governance_coerces_responses_shape_without_shell_fence_guess() {
    let payload = serde_json::json!({
        "object": "response",
        "id": "resp_stage1_native",
        "model": "gpt-test",
        "status": "completed",
        "output_text": "<function_calls>```bash\npwd\n```</function_calls>",
        "output": []
    });

    let prepared = prepare_payload_for_governance(&payload).unwrap();
    assert!(prepared.summary.converted);
    assert!(prepared.summary.shape_sanitized);
    assert_eq!(prepared.summary.harvested_tool_calls, 0);
    assert!(
        prepared.prepared_payload["choices"][0]["message"]["tool_calls"]
            .as_array()
            .cloned()
            .unwrap_or_default()
            .is_empty()
    );
}

#[test]
fn test_govern_response_preserves_shell_fence_truth_when_function_calls_wrapper_has_no_valid_tool_call(
) {
    let input = ToolGovernanceInput {
        payload: serde_json::json!({
            "choices": [{
                "message": {
                    "content": "<function_calls>```bash\npwd\n```</function_calls>",
                    "tool_calls": []
                },
                "finish_reason": "stop"
            }]
        }),
        client_protocol: "openai-chat".to_string(),
        entry_endpoint: "/v1/responses".to_string(),
        request_id: "req_stage1_shell_fence".to_string(),
    };

    let governed = govern_response(input).unwrap();
    assert_eq!(governed.summary.tool_calls_normalized, 0);
    assert_eq!(
        governed.governed_payload["choices"][0]["finish_reason"],
        "stop"
    );
    assert_eq!(
        governed.governed_payload["choices"][0]["message"]["content"],
        "```bash\npwd\n```"
    );
}

#[test]
fn test_govern_response_preserves_requested_shell_command_name_for_openai_chat() {
    let input = ToolGovernanceInput {
        payload: serde_json::json!({
            "__rcc_tool_governance": { "requestedToolNames": ["shell_command"] },
            "choices": [{
                "finish_reason": "tool_calls",
                "message": {
                    "content": "",
                    "role": "assistant",
                    "tool_calls": [{
                        "id": "native:run_command:2",
                        "type": "function",
                        "function": {
                            "name": "shell_command",
                            "arguments": "{\"command\":\"echo ok\"}"
                        }
                    }]
                }
            }]
        }),
        client_protocol: "openai-chat".to_string(),
        entry_endpoint: "/v1/responses".to_string(),
        request_id: "req_preserve_shell_command".to_string(),
    };

    let governed = govern_response(input).unwrap();
    let call = &governed.governed_payload["choices"][0]["message"]["tool_calls"][0];
    assert_eq!(call["function"]["name"], "shell_command");
    assert_eq!(call["function"]["arguments"], "{\"command\":\"echo ok\"}");
}

#[test]
fn test_govern_response_does_not_repair_reasoning_stop_into_exec_command_when_requested() {
    let input = ToolGovernanceInput {
        payload: serde_json::json!({
            "__rcc_tool_governance": { "requestedToolNames": ["exec_command", "reasoningStop"] },
            "choices": [{
                "finish_reason": "tool_calls",
                "message": {
                    "content": "",
                    "role": "assistant",
                    "tool_calls": [{
                        "id": "call_reasoning_stop",
                        "type": "function",
                        "function": {
                            "name": "reasoningStop",
                            "arguments": "{\"stopreason\":0,\"reason\":\"done\",\"has_evidence\":1,\"evidence\":\"verified\"}"
                        }
                    }]
                }
            }]
        }),
        client_protocol: "openai-chat".to_string(),
        entry_endpoint: "/v1/responses".to_string(),
        request_id: "req_preserve_reasoning_stop".to_string(),
    };

    let governed = govern_response(input).unwrap();
    let call = &governed.governed_payload["choices"][0]["message"]["tool_calls"][0];
    assert_eq!(call["function"]["name"], "reasoningStop");
    let args = call["function"]["arguments"].as_str().unwrap_or("");
    assert!(args.contains("\"stopreason\":0"));
    assert!(!args.contains("\"cmd\":\"reasoningStop\""));
}

#[test]
fn test_govern_response_does_not_repair_reasoning_stop_into_exec_command_without_requested_tools() {
    let input = ToolGovernanceInput {
        payload: serde_json::json!({
            "choices": [{
                "finish_reason": "tool_calls",
                "message": {
                    "content": "",
                    "role": "assistant",
                    "tool_calls": [{
                        "id": "call_reasoning_stop_ns",
                        "type": "function",
                        "function": {
                            "name": "reasoningStop",
                            "arguments": "{\"stopreason\":2,\"reason\":\"continue\",\"next_step\":\"run focused tests\"}"
                        }
                    }]
                }
            }]
        }),
        client_protocol: "openai-chat".to_string(),
        entry_endpoint: "/v1/responses".to_string(),
        request_id: "req_preserve_reasoning_stop_ns".to_string(),
    };

    let governed = govern_response(input).unwrap();
    let call = &governed.governed_payload["choices"][0]["message"]["tool_calls"][0];
    assert_eq!(call["function"]["name"], "reasoningStop");
    let args = call["function"]["arguments"].as_str().unwrap_or("");
    assert!(args.contains("\"stopreason\":2"));
    assert!(!args.contains("\"cmd\":\"reasoningStop\""));
}

#[test]
fn test_govern_response_terminal_reasoning_stop_releases_normal_stop_even_when_requested_tools_only_list_client_tools(
) {
    let input = ToolGovernanceInput {
        payload: serde_json::json!({
            "__rcc_tool_governance": { "requestedToolNames": ["exec_command"] },
            "choices": [{
                "finish_reason": "tool_calls",
                "message": {
                    "content": "我会按 stop hook 收尾",
                    "role": "assistant",
                    "tool_calls": [{
                        "id": "call_reasoning_stop_requested_exec_only",
                        "type": "function",
                        "function": {
                            "name": "reasoningStop",
                            "arguments": "{\"stopreason\":0,\"reason\":\"done\",\"has_evidence\":1,\"evidence\":\"verified\",\"issue_cause\":\"fixed\",\"excluded_factors\":\"none\",\"diagnostic_order\":\"1. inspect 2. verify\",\"done_steps\":\"confirmed stopless path\",\"next_step\":\"无\",\"next_suggested_path\":\"无\",\"needs_user_input\":false,\"learned\":\"preserve internal stop hook before later interception\"}"
                        }
                    }]
                }
            }]
        }),
        client_protocol: "openai-chat".to_string(),
        entry_endpoint: "/v1/responses".to_string(),
        request_id: "req_preserve_reasoning_stop_requested_exec_only".to_string(),
    };

    let governed = govern_response(input).unwrap();
    assert_eq!(
        governed.governed_payload["choices"][0]["finish_reason"],
        "stop"
    );
    assert!(governed.governed_payload["choices"][0]["message"]
        .get("tool_calls")
        .is_none());
    assert_eq!(
        governed.governed_payload["choices"][0]["message"]["content"],
        "我会按 stop hook 收尾"
    );
}

#[test]
fn test_govern_response_repairs_malformed_exec_command_reasoning_stop_back_to_reasoning_stop() {
    let input = ToolGovernanceInput {
        payload: serde_json::json!({
            "__rcc_tool_governance": { "requestedToolNames": ["exec_command", "reasoningStop"] },
            "choices": [{
                "finish_reason": "tool_calls",
                "message": {
                    "content": "",
                    "role": "assistant",
                    "tool_calls": [{
                        "id": "call_malformed_reasoning_stop_exec_command",
                        "type": "function",
                        "function": {
                            "name": "exec_command",
                            "arguments": "{\"cmd\":\"reasoningStop\",\"stopreason\":2,\"reason\":\"第一轮故意缺 schema\"}"
                        }
                    }]
                }
            }]
        }),
        client_protocol: "openai-chat".to_string(),
        entry_endpoint: "/v1/responses".to_string(),
        request_id: "req_repair_reasoning_stop_from_exec_command".to_string(),
    };

    let governed = govern_response(input).unwrap();
    let call = &governed.governed_payload["choices"][0]["message"]["tool_calls"][0];
    assert_eq!(call["function"]["name"], "reasoningStop");
    let args = call["function"]["arguments"].as_str().unwrap_or("");
    assert!(args.contains("\"stopreason\":2"));
    assert!(args.contains("第一轮故意缺 schema"));
    assert!(!args.contains("\"cmd\":\"reasoningStop\""));
}

#[test]
fn test_prepare_payload_for_governance_does_not_guess_function_style_apply_patch_semantics() {
    let payload = serde_json::json!({
        "object": "response",
        "id": "resp_stage1_apply_patch",
        "model": "custom-model",
        "status": "completed",
        "output_text": "apply_patch(path=\"hello.txt\", content=\"hello\")",
        "output": []
    });

    let prepared = prepare_payload_for_governance(&payload).unwrap();
    assert!(prepared.summary.converted);
    assert_eq!(prepared.summary.harvested_tool_calls, 0);
}

#[test]
fn test_govern_response_coerces_responses_shape_and_harvests_dsml_wrapper() {
    let input = ToolGovernanceInput {
        payload: serde_json::json!({
            "object": "response",
            "id": "resp_stage1_deepseek_dsml",
            "model": "gpt-test",
            "status": "completed",
            "output_text": "<|DSML|tool_calls>\n<|DSML|invoke name=\"exec_command\">\n<|DSML|parameter name=\"cmd\"><![CDATA[pwd]]></|DSML|parameter>\n</|DSML|invoke>\n</|DSML|tool_calls>",
            "output": [],
            "__rcc_tool_governance": {
                "requestedToolNames": ["exec_command"]
            }
        }),
        client_protocol: "openai-chat".to_string(),
        entry_endpoint: "/v1/responses".to_string(),
        request_id: "req_stage1_deepseek_dsml".to_string(),
    };

    let governed = govern_response(input).unwrap();
    assert!(governed.summary.applied);
    assert_eq!(governed.summary.tool_calls_normalized, 1);
    assert_eq!(
        governed.governed_payload["choices"][0]["finish_reason"],
        "tool_calls"
    );
    assert_eq!(
        governed.governed_payload["choices"][0]["message"]["tool_calls"][0]["function"]["name"],
        "exec_command"
    );
    let args: Value = serde_json::from_str(
        governed.governed_payload["choices"][0]["message"]["tool_calls"][0]["function"]
            ["arguments"]
            .as_str()
            .unwrap_or("{}"),
    )
    .unwrap_or(Value::Null);
    assert_eq!(args["cmd"], "pwd");
}

#[test]
fn test_govern_response_harvests_double_pipe_fullwidth_dsml_reasoning_stop() {
    let input = ToolGovernanceInput {
        payload: serde_json::json!({
            "choices": [{
                "finish_reason": "stop",
                "index": 0,
                "message": {
                    "role": "assistant",
                    "content": "<｜｜DSML｜｜tool_calls>\n<｜｜DSML｜｜invoke name=\"reasoningStop\">\n<｜｜DSML｜｜parameter name=\"next_step\" string=\"true\">等待第二轮工具结果后继续验证</｜｜DSML｜｜parameter>\n<｜｜DSML｜｜parameter name=\"reason\" string=\"true\">第二轮还没做完</｜｜DSML｜｜parameter>\n<｜｜DSML｜｜parameter name=\"stopreason\" string=\"false\">2</｜｜DSML｜｜parameter>\n</｜｜DSML｜｜invoke>\n</｜｜DSML｜｜tool_calls>"
                }
            }],
            "model": "glm-5.2",
            "object": "chat.completion",
            "__rcc_tool_governance": {
                "requestedToolNames": ["reasoningStop"]
            }
        }),
        client_protocol: "openai-responses".to_string(),
        entry_endpoint: "/v1/responses".to_string(),
        request_id: "req_stage1_dsml_reasoning_stop".to_string(),
    };

    let governed = govern_response(input).unwrap();
    assert!(governed.summary.applied);
    assert_eq!(governed.summary.tool_calls_normalized, 1);
    assert_eq!(
        governed.governed_payload["choices"][0]["finish_reason"],
        "tool_calls"
    );
    assert_eq!(
        governed.governed_payload["choices"][0]["message"]["tool_calls"][0]["function"]["name"],
        "reasoningStop"
    );
    let args: Value = serde_json::from_str(
        governed.governed_payload["choices"][0]["message"]["tool_calls"][0]["function"]
            ["arguments"]
            .as_str()
            .unwrap_or("{}"),
    )
    .unwrap_or(Value::Null);
    assert_eq!(args["stopreason"], 2);
    assert_eq!(args["reason"], "第二轮还没做完");
}

#[test]
fn test_govern_response_harvests_dsml_wrapper_inside_ran_transcript_with_right_gutter_noise() {
    let input = ToolGovernanceInput {
        payload: serde_json::json!({
            "choices": [{
                "message": {
                    "content": concat!(
                        "• Ran tool transcript\n",
                        "                                                                                │·······························\n",
                        "└ <DSML|tool_calls>                                                             │·······························\n",
                        "  <DSML|invoke name=\"view_image\">                                              │·······························\n",
                        "  <DSML|parameter name=\"path\">[Image #1]</DSML|parameter>                      │·······························\n",
                        "  </DSML|invoke>                                                                │·······························\n",
                        "  </DSML|tool_calls>                                                            │·······························\n",
                        "                                                                                │·······························\n",
                        "› Summarize recent commits                                                      │·······························\n"
                    ),
                    "tool_calls": []
                },
                "finish_reason": "stop"
            }],
            "__rcc_tool_governance": {
                "requestedToolNames": ["view_image"],
                "enableTextHarvest": true
            }
        }),
        client_protocol: "openai-chat".to_string(),
        entry_endpoint: "/v1/responses".to_string(),
        request_id: "req_stage1_dsml_ran_transcript".to_string(),
    };

    let governed = govern_response(input).unwrap();
    assert_eq!(governed.summary.tool_calls_normalized, 1);
    assert_eq!(
        governed.governed_payload["choices"][0]["finish_reason"],
        "tool_calls"
    );
    assert_eq!(
        governed.governed_payload["choices"][0]["message"]["tool_calls"][0]["function"]["name"],
        "view_image"
    );
    let args: Value = serde_json::from_str(
        governed.governed_payload["choices"][0]["message"]["tool_calls"][0]["function"]
            ["arguments"]
            .as_str()
            .unwrap_or("{}"),
    )
    .unwrap_or(Value::Null);
    assert_eq!(args["path"], "[Image #1]");
    let content = governed.governed_payload["choices"][0]["message"]["content"]
        .as_str()
        .unwrap_or("");
    assert!(!content.contains("DSML"));
    assert!(!content.contains("tool transcript"));
    assert!(!content.contains("Summarize recent commits"));
}

#[test]
fn test_prepare_payload_for_governance_strips_empty_tool_calls_json_noise_from_content() {
    let payload = serde_json::json!({
        "choices": [{
            "message": {
                "content": "done\n• {\"tool_calls\":[]}"
            },
            "finish_reason": "stop"
        }]
    });

    let prepared = prepare_payload_for_governance(&payload).unwrap();
    assert_eq!(
        prepared.prepared_payload["choices"][0]["message"]["content"],
        "done"
    );
    assert_eq!(
        prepared.prepared_payload["choices"][0]["finish_reason"],
        "stop"
    );
}

#[test]
fn test_collect_harvest_text_variants_does_not_decode_nested_exec_command_newline_escapes() {
    let raw = r#"<tool_call>
{\"tool_calls\":[{\"id\":\"call_1\",\"type\":\"function\",\"function\":{\"name\":\"exec_command\",\"arguments\":\"{\\\"cmd\\\":\\\"bash -lc 'python3 << \\\\\\\"PYTHON\\\\\\\"\\ncontent = content.replace(\\\\\\\"import x;\\\\\\\", \\\\\\\"import x;\\\\\\\\nimport y;\\\\\\\")\\nPYTHON'\\\"}\"}}]}
</tool_call>"#;

    let variants = collect_harvest_text_variants(raw);
    let joined = variants.join("\n---VARIANT---\n");
    assert!(joined.contains("\\\\nimport y;"));
    assert!(!joined.contains(";nimport y;"));
}

#[test]
fn test_govern_response_empty_payload() {
    let input = ToolGovernanceInput {
        payload: serde_json::json!({"choices": []}),
        client_protocol: "openai-chat".to_string(),
        entry_endpoint: "/v1/chat".to_string(),
        request_id: "req_123".to_string(),
    };
    let result = govern_response(input).unwrap();
    assert!(!result.summary.applied);
    assert_eq!(result.summary.tool_calls_normalized, 0);
    assert_eq!(result.summary.apply_patch_repaired, 0);
}

#[test]
fn test_govern_response_with_tool_calls() {
    let input = ToolGovernanceInput {
        payload: serde_json::json!({"choices": [{"message": {"tool_calls": [{"function": {"name": "exec_command", "arguments": "{}"}}]}}]}),
        client_protocol: "openai-chat".to_string(),
        entry_endpoint: "/v1/chat".to_string(),
        request_id: "req_123".to_string(),
    };
    let result = govern_response(input).unwrap();
    assert!(result.summary.applied);
    assert_eq!(result.summary.tool_calls_normalized, 1);
    let call_id = result.governed_payload["choices"][0]["message"]["tool_calls"][0]["id"]
        .as_str()
        .unwrap_or("");
    assert!(call_id.starts_with("call_harvested_"));
}

#[test]
fn test_govern_response_assigns_formal_servertool_call_id() {
    let input = ToolGovernanceInput {
        payload: serde_json::json!({
            "choices": [{
                "message": {
                    "tool_calls": [{
                        "function": {
                            "name": "continue_execution",
                            "arguments": "{\"stop_reason\":\"task_completed\",\"is_completed\":true}"
                        }
                    }]
                }
            }]
        }),
        client_protocol: "openai-chat".to_string(),
        entry_endpoint: "/v1/chat".to_string(),
        request_id: "req_srvtool_123".to_string(),
    };
    let result = govern_response(input).unwrap();
    let call_id = result.governed_payload["choices"][0]["message"]["tool_calls"][0]["id"]
        .as_str()
        .unwrap_or("");
    assert!(call_id.starts_with("call_servertool_continue_execution_"));
}

#[test]
fn test_govern_response_apply_patch_repair() {
    let input = ToolGovernanceInput {
        payload: serde_json::json!({"choices": [{"message": {"tool_calls": [{"function": {"name": "apply_patch", "arguments": "{\"patch\": \"test\"}"}}]}}]}),
        client_protocol: "openai-chat".to_string(),
        entry_endpoint: "/v1/chat".to_string(),
        request_id: "req_123".to_string(),
    };
    let result = govern_response(input).unwrap();
    assert!(result.summary.applied);
    assert_eq!(result.summary.apply_patch_repaired, 1);
    let args = result.governed_payload["choices"][0]["message"]["tool_calls"][0]["function"]
        ["arguments"]
        .as_str()
        .unwrap_or("");
    let parsed: Value = serde_json::from_str(args).unwrap();
    let patch = parsed["patch"].as_str().unwrap_or("");
    assert_eq!(patch, "test");
    assert!(parsed.get("input").is_none());
}

#[test]
fn test_govern_response_apply_patch_inline_create_file_shape() {
    let input = ToolGovernanceInput {
        payload: serde_json::json!({
            "choices": [{
                "message": {
                    "tool_calls": [{
                        "function": {
                            "name": "apply_patch",
                            "arguments": "*** Begin Patch *** Create File: src/a.ts\nconsole.log('ok')\n*** End Patch"
                        }
                    }]
                }
            }]
        }),
        client_protocol: "openai-chat".to_string(),
        entry_endpoint: "/v1/chat".to_string(),
        request_id: "req_123".to_string(),
    };
    let result = govern_response(input).unwrap();
    let args = result.governed_payload["choices"][0]["message"]["tool_calls"][0]["function"]
        ["arguments"]
        .as_str()
        .unwrap_or("");
    let parsed: Value = serde_json::from_str(args).unwrap();
    let patch = parsed["patch"].as_str().unwrap_or("");
    assert!(patch.contains("*** Begin Patch"));
    assert!(patch.contains("*** Add File: src/a.ts"));
    assert!(patch.contains("+console.log('ok')"));
    assert!(parsed.get("input").is_none());
}

#[test]
fn test_govern_response_apply_patch_simple_minus_plus_with_file_context_converts_to_canonical_patch(
) {
    let input = ToolGovernanceInput {
        payload: serde_json::json!({
            "choices": [{
                "message": {
                    "tool_calls": [{
                        "function": {
                            "name": "apply_patch",
                            "arguments": serde_json::to_string(&serde_json::json!({
                                "patch": "- old\n+ new",
                                "filePath": "sample.txt",
                                "fileContent": "old"
                            })).unwrap()
                        }
                    }]
                }
            }]
        }),
        client_protocol: "openai-chat".to_string(),
        entry_endpoint: "/v1/chat".to_string(),
        request_id: "req_hashline_response_apply_patch_simple_minus_plus".to_string(),
    };
    let result = govern_response(input).unwrap();
    let args = result.governed_payload["choices"][0]["message"]["tool_calls"][0]["function"]
        ["arguments"]
        .as_str()
        .unwrap_or("");
    let parsed: Value = serde_json::from_str(args).unwrap();
    let patch = parsed["patch"].as_str().unwrap_or("");
    assert_eq!(
        patch,
        "*** Begin Patch
*** Update File: sample.txt
@@
-old
+new
*** End Patch"
    );
    assert!(parsed.get("input").is_none());
    assert!(parsed.get("filePath").is_none());
    assert!(parsed.get("fileContent").is_none());
}

#[test]
fn test_govern_response_apply_patch_current_schema_preserves_filepath_and_patch_without_guard() {
    let input = ToolGovernanceInput {
        payload: serde_json::json!({
            "choices": [{
                "message": {
                    "tool_calls": [{
                        "function": {
                            "name": "apply_patch",
                            "arguments": serde_json::to_string(&serde_json::json!({
                                "filePath": "tmp/apply-patch-smoke.txt",
                                "patch": "+ alpha\n+ beta"
                            })).unwrap()
                        }
                    }]
                }
            }]
        }),
        client_protocol: "openai-chat".to_string(),
        entry_endpoint: "/v1/chat".to_string(),
        request_id: "req_apply_patch_current_schema_no_guard".to_string(),
    };
    let result = govern_response(input).unwrap();
    let args = result.governed_payload["choices"][0]["message"]["tool_calls"][0]["function"]
        ["arguments"]
        .as_str()
        .unwrap_or("");
    let parsed: Value = serde_json::from_str(args).unwrap();
    // Servertool {filePath, patch} → canonical {patch}
    let patch_value = parsed["patch"].as_str().unwrap_or("");
    assert!(
        patch_value.starts_with("*** Begin Patch"),
        "servertool filePath+patch should convert to canonical format"
    );
    assert!(patch_value.contains("*** Add File: tmp/apply-patch-smoke.txt"));
    assert!(patch_value.contains("+ alpha"));
    assert!(patch_value.contains("+ beta"));
    assert!(patch_value.contains("*** End Patch"));
    assert!(
        parsed.get("input").is_none(),
        "input should be removed after conversion"
    );
    assert!(
        parsed.get("filePath").is_none(),
        "filePath should be removed after conversion"
    );
    assert!(parsed.get("fileContent").is_none());
}

#[test]
fn test_govern_response_apply_patch_simple_add_with_empty_file_context_converts_to_add_file_patch()
{
    let input = ToolGovernanceInput {
        payload: serde_json::json!({
            "choices": [{
                "message": {
                    "tool_calls": [{
                        "function": {
                            "name": "apply_patch",
                            "arguments": serde_json::to_string(&serde_json::json!({
                                "patch": "+ smoke-ok",
                                "filePath": "rcc_apply_patch_smoke.txt",
                                "fileContent": ""
                            })).unwrap()
                        }
                    }]
                }
            }]
        }),
        client_protocol: "openai-chat".to_string(),
        entry_endpoint: "/v1/chat".to_string(),
        request_id: "req_hashline_response_apply_patch_simple_add".to_string(),
    };
    let result = govern_response(input).unwrap();
    let args = result.governed_payload["choices"][0]["message"]["tool_calls"][0]["function"]
        ["arguments"]
        .as_str()
        .unwrap_or("");
    let parsed: Value = serde_json::from_str(args).unwrap();
    let patch = parsed["patch"].as_str().unwrap_or("");
    assert_eq!(
        patch,
        "*** Begin Patch\n*** Add File: rcc_apply_patch_smoke.txt\n+smoke-ok\n*** End Patch"
    );
    assert!(parsed.get("input").is_none());
    assert!(parsed.get("filePath").is_none());
    assert!(parsed.get("fileContent").is_none());
}

#[test]
fn test_govern_response_apply_patch_hashline_shape_is_converted_to_canonical_patch() {
    let input = ToolGovernanceInput {
        payload: serde_json::json!({
            "choices": [{
                "message": {
                    "tool_calls": [{
                        "function": {
                            "name": "apply_patch",
                            "arguments": serde_json::to_string(&serde_json::json!({
                                "patch": "+ 2 deadbeef\nhello",
                                "filePath": "note.txt",
                                "fileContent": "hello"
                            })).unwrap()
                        }
                    }]
                }
            }]
        }),
        client_protocol: "openai-chat".to_string(),
        entry_endpoint: "/v1/chat".to_string(),
        request_id: "req_hashline_response_apply_patch".to_string(),
    };
    let result = govern_response(input).unwrap();
    let args = result.governed_payload["choices"][0]["message"]["tool_calls"][0]["function"]
        ["arguments"]
        .as_str()
        .unwrap_or("");
    let parsed: Value = serde_json::from_str(args).unwrap();
    let patch = parsed["patch"].as_str().unwrap_or("");
    assert!(patch.contains("*** Begin Patch"));
    assert!(patch.contains("*** Update File: note.txt"));
    assert!(patch.contains("@@"));
    assert!(patch.contains("+hello"));
    assert!(parsed.get("input").is_none());
    assert!(parsed.get("filePath").is_none());
    assert!(parsed.get("file_path").is_none());
}

#[test]
fn test_govern_response_apply_patch_hashline_missing_file_content_fails_closed_with_guard_patch() {
    let input = ToolGovernanceInput {
        payload: serde_json::json!({
            "choices": [{
                "message": {
                    "tool_calls": [{
                        "function": {
                            "name": "apply_patch",
                            "arguments": serde_json::to_string(&serde_json::json!({
                                "patch": "+ 2 deadbeef\nhello",
                                "filePath": "note.txt"
                            })).unwrap()
                        }
                    }]
                }
            }]
        }),
        client_protocol: "openai-chat".to_string(),
        entry_endpoint: "/v1/chat".to_string(),
        request_id: "req_hashline_response_apply_patch_missing_file_content".to_string(),
    };
    let result = govern_response(input).unwrap();
    let args = result.governed_payload["choices"][0]["message"]["tool_calls"][0]["function"]
        ["arguments"]
        .as_str()
        .unwrap_or("");
    let parsed: Value = serde_json::from_str(args).unwrap();
    let patch = parsed["patch"].as_str().unwrap_or("");
    assert!(patch.contains("APPLY_PATCH_ERROR:"));
    assert!(patch.contains("__APPLY_PATCH_ERROR__/"));
    assert!(!patch.contains("\"filePath\""));
    assert!(!patch.contains("+ 2 deadbeef"));
    assert!(parsed.get("input").is_none());
}

#[test]
fn test_govern_response_apply_patch_canonical_patch_with_stray_filepath_stays_canonical() {
    let input = ToolGovernanceInput {
        payload: serde_json::json!({
            "choices": [{
                "message": {
                    "tool_calls": [{
                        "function": {
                            "name": "apply_patch",
                            "arguments": serde_json::to_string(&serde_json::json!({
                                "filePath": "test_apply_patch/sample.txt",
                                "input": "*** Begin Patch\n*** Update File: test_apply_patch/sample.txt\n@@ -1,3 +1,3 @@\n Original line 1\n-Original line 2\n+Modified line 2: UPDATED!\n Original line 3\n*** End Patch",
                                "patch": "*** Begin Patch\n*** Update File: test_apply_patch/sample.txt\n@@ -1,3 +1,3 @@\n Original line 1\n-Original line 2\n+Modified line 2: UPDATED!\n Original line 3\n*** End Patch"
                            })).unwrap()
                        }
                    }]
                }
            }]
        }),
        client_protocol: "openai-chat".to_string(),
        entry_endpoint: "/v1/chat".to_string(),
        request_id: "req_apply_patch_canonical_with_stray_filepath".to_string(),
    };
    let result = govern_response(input).unwrap();
    let args = result.governed_payload["choices"][0]["message"]["tool_calls"][0]["function"]
        ["arguments"]
        .as_str()
        .unwrap_or("");
    let parsed: Value = serde_json::from_str(args).unwrap();
    let patch = parsed["patch"].as_str().unwrap_or("");
    assert!(patch.contains("*** Begin Patch"));
    assert!(patch.contains("*** Update File: test_apply_patch/sample.txt"));
    assert!(patch.contains("+Modified line 2: UPDATED!"));
    assert!(parsed.get("input").is_none());
    assert!(parsed.get("filePath").is_none());
    assert!(parsed.get("file_path").is_none());
}

#[test]
fn test_govern_response_apply_patch_strips_quoted_paths() {
    let input = ToolGovernanceInput {
        payload: serde_json::json!({
            "choices": [{
                "message": {
                    "tool_calls": [{
                        "function": {
                            "name": "apply_patch",
                            "arguments": "*** Begin Patch
*** Add File: \"src/quoted.ts\"
+console.log('ok')
*** End Patch"
                        }
                    }]
                }
            }]
        }),
        client_protocol: "openai-chat".to_string(),
        entry_endpoint: "/v1/chat".to_string(),
        request_id: "req_quoted_path".to_string(),
    };
    let result = govern_response(input).unwrap();
    let args = result.governed_payload["choices"][0]["message"]["tool_calls"][0]["function"]
        ["arguments"]
        .as_str()
        .unwrap_or("");
    let parsed: Value = serde_json::from_str(args).unwrap();
    let patch = parsed["patch"].as_str().unwrap_or("");
    assert!(patch.contains("*** Add File: src/quoted.ts"));
    assert!(!patch.contains("APPLY_PATCH_ERROR:"));
}

#[test]
fn test_govern_response_apply_patch_raw_string_is_repaired_into_schema() {
    let input = ToolGovernanceInput {
        payload: serde_json::json!({
            "choices": [{
                "message": {
                    "tool_calls": [{
                        "function": {
                            "name": "apply_patch",
                            "arguments": "*** Begin Patch
*** Add File: raw.txt
+raw
*** End Patch"
                        }
                    }]
                }
            }]
        }),
        client_protocol: "openai-chat".to_string(),
        entry_endpoint: "/v1/chat".to_string(),
        request_id: "req_raw_apply_patch_schema_guard".to_string(),
    };
    let result = govern_response(input).unwrap();
    let args = result.governed_payload["choices"][0]["message"]["tool_calls"][0]["function"]
        ["arguments"]
        .as_str()
        .unwrap_or("");
    let parsed: Value = serde_json::from_str(args).unwrap();
    let patch = parsed["patch"].as_str().unwrap_or("");
    assert!(patch.contains("*** Add File: raw.txt"));
    assert!(patch.contains("+raw"));
    assert!(parsed.get("input").is_none());
}

#[test]
fn test_govern_response_apply_patch_nested_input_patch_is_converted_to_canonical_patch() {
    let input = ToolGovernanceInput {
        payload: serde_json::json!({
            "choices": [{
                "message": {
                    "tool_calls": [{
                        "function": {
                            "name": "apply_patch",
                            "arguments": serde_json::to_string(&serde_json::json!({
                                "input": {
                                    "filePath": "tmp/ap002.txt",
                                    "patch": "- hello\n- \n- world\n+ new\n+ keep"
                                }
                            })).unwrap()
                        }
                    }]
                }
            }]
        }),
        client_protocol: "openai-chat".to_string(),
        entry_endpoint: "/v1/chat".to_string(),
        request_id: "req_nested_input_line_edit_apply_patch".to_string(),
    };
    let result = govern_response(input).unwrap();
    let args = result.governed_payload["choices"][0]["message"]["tool_calls"][0]["function"]
        ["arguments"]
        .as_str()
        .unwrap_or("");
    let parsed: Value = serde_json::from_str(args).unwrap();
    let patch = parsed["patch"].as_str().unwrap_or("");
    assert!(patch.contains("*** Begin Patch"));
    assert!(patch.contains("*** Update File: tmp/ap002.txt"));
    assert!(patch.contains("- hello"));
    assert!(patch.contains("- "));
    assert!(patch.contains("- world"));
    assert!(patch.contains("+ new"));
    assert!(patch.contains("+ keep"));
    assert!(parsed.get("input").is_none());
}

#[test]
fn test_govern_response_apply_patch_text_field_is_accepted_when_information_is_sufficient() {
    let input = ToolGovernanceInput {
        payload: serde_json::json!({
            "choices": [{
                "message": {
                    "tool_calls": [{
                        "function": {
                            "name": "apply_patch",
                            "arguments": serde_json::to_string(&serde_json::json!({
                                "filePath": "tmp/ap002.txt",
                                "text": "- hello\n- \n- world\n+ new\n+ keep"
                            })).unwrap()
                        }
                    }]
                }
            }]
        }),
        client_protocol: "openai-chat".to_string(),
        entry_endpoint: "/v1/chat".to_string(),
        request_id: "req_text_field_line_edit_apply_patch".to_string(),
    };
    let result = govern_response(input).unwrap();
    let args = result.governed_payload["choices"][0]["message"]["tool_calls"][0]["function"]
        ["arguments"]
        .as_str()
        .unwrap_or("");
    let parsed: Value = serde_json::from_str(args).unwrap();
    let patch = parsed["patch"].as_str().unwrap_or("");
    assert!(patch.contains("*** Update File: tmp/ap002.txt"));
    assert!(patch.contains("+ new"));
    assert!(patch.contains("+ keep"));
    assert!(!patch.contains("APPLY_PATCH_ERROR:"));
}

#[test]
fn test_strip_orphan_function_calls_tag() {
    let input = ToolGovernanceInput {
        payload: serde_json::json!({"choices": [{"message": {"content": "<function_calls>{\"name\": \"test\"}</function_calls>"}}]}),
        client_protocol: "openai-chat".to_string(),
        entry_endpoint: "/v1/chat".to_string(),
        request_id: "req_123".to_string(),
    };
    let result = govern_response(input).unwrap();
    let content = result.governed_payload["choices"][0]["message"]
        .get("content")
        .and_then(Value::as_str)
        .unwrap_or("");
    assert!(!content.contains("<function_calls>"));
    assert!(!content.contains("</function_calls>"));
}

#[test]
fn test_strip_orphan_tool_markup_lines() {
    let input = ToolGovernanceInput {
        payload: serde_json::json!({
            "choices": [{
                "message": {
                    "content": "Done.\n</parameter>\n</function>\n</tool_call>"
                }
            }]
        }),
        client_protocol: "openai-chat".to_string(),
        entry_endpoint: "/v1/chat".to_string(),
        request_id: "req_orphan_tool_markup".to_string(),
    };
    let result = govern_response(input).unwrap();
    assert_eq!(
        result.governed_payload["choices"][0]["message"]["content"],
        "Done."
    );
}

#[test]
fn test_normalize_tool_name_shell_command_aliases_to_exec_command() {
    assert_eq!(
        normalize_routecodex_tool_name(Some("functions.shell_command")),
        Some("exec_command".to_string())
    );
    assert_eq!(
        normalize_routecodex_tool_name(Some("totally_unknown_tool")),
        Some("totally_unknown_tool".to_string())
    );
    assert_eq!(
        normalize_routecodex_tool_name(Some("mailbox.status")),
        Some("mailbox.status".to_string())
    );
}

#[test]
fn test_normalize_tool_name_edge_cases() {
    assert!(normalize_routecodex_tool_name(Some("")).is_none());
    assert!(normalize_routecodex_tool_name(Some("   ")).is_none());
    assert!(normalize_routecodex_tool_name(Some("functions.")).is_none());
    assert_eq!(
        normalize_routecodex_tool_name(Some("  FuNcTiOnS.SHELL_COMMAND ")),
        Some("exec_command".to_string())
    );
}

#[test]
fn test_parse_json_record_edge_cases() {
    let empty = Value::String("   ".to_string());
    let parsed = parse_json_record(Some(&empty)).unwrap();
    assert!(parsed.is_empty());

    let none = parse_json_record(Some(&Value::Null));
    assert!(none.is_none());

    let raw = Value::String("{\"note\":\"a\rb\"}".to_string());
    let parsed = parse_json_record(Some(&raw)).unwrap();
    assert_eq!(parsed.get("note").and_then(Value::as_str), Some("a\rb"));

    let arr = Value::Array(vec![Value::Null, Value::String("".to_string())]);
    assert!(read_string_array_command(Some(&arr)).is_none());
}

#[test]
fn test_workdir_and_tool_args_missing_paths() {
    let mut args = Map::new();
    args.insert("input".to_string(), json!({"cwd": "/tmp/cwd"}));
    assert_eq!(read_workdir_from_args(&args), Some("/tmp/cwd".to_string()));

    let raw_args = json!({});
    assert!(normalize_tool_args("shell", Some(&raw_args)).is_none());

    let raw_args = json!({"session_id": "abc"});
    assert!(normalize_tool_args("write_stdin", Some(&raw_args)).is_none());
}

#[test]
fn test_extract_balanced_json_object_edges() {
    assert!(extract_balanced_json_object_at("xx", 0).is_none());
    assert!(extract_balanced_json_object_at("{", 0).is_none());
}

#[test]
fn test_extract_json_candidates_edge_cases() {
    let text = "```json\n{\"a\":1}\n";
    assert!(extract_json_candidates_from_text(text).is_empty());

    let text = "\"tool_calls\"";
    assert!(!extract_json_candidates_from_text(text).is_empty());
}

#[test]
fn test_message_candidates_misc() {
    let msg = json!({"content": [1, {"text": "x"}, {"content": "y"}]});
    let parts = read_message_text_candidates(msg.as_object().unwrap());
    assert_eq!(parts.len(), 2);
}

#[test]
fn test_strip_orphan_function_calls_tag_json_empty() {
    let result = strip_orphan_function_calls_tag_json("".to_string());
    assert!(result.is_err());
}

#[test]
fn test_normalize_apply_patch_tool_calls_noop_and_count() {
    let normalized = normalize_tool_args(
        "apply_patch",
        Some(&Value::String(
            r#"{"patch":"*** Begin Patch\n*** End Patch"}"#.to_string(),
        )),
    )
    .unwrap();
    let mut payload = json!({
        "choices": [{
            "message": {
                "tool_calls": [{"function": {"name": "apply_patch", "arguments": normalized.clone()}}]
            }
        }]
    });
    let repaired = normalize_apply_patch_tool_calls(&mut payload);
    assert_eq!(repaired, 0);
    let args = payload["choices"][0]["message"]["tool_calls"][0]["function"]["arguments"]
        .as_str()
        .unwrap_or("");
    let parsed: Value = serde_json::from_str(args).unwrap();
    assert!(parsed.get("input").is_none());

    let payload = json!({
        "choices": [{
            "message": {"tool_calls": [{"function": {"name": "exec_command", "arguments": "{}"}}, {"function": {"name": "exec_command", "arguments": "{}"}}]}
        }]
    });
    assert_eq!(count_normalized_tool_calls(&payload), 2);
}

#[test]
fn test_harvest_tool_calls_from_function_calls_json() {
    let input = ToolGovernanceInput {
        payload: serde_json::json!({
            "choices": [{
                "message": {
                    "tool_calls": [],
                    "content": "<function_calls>{\"tool_calls\":[{\"id\":\"call_abc\",\"type\":\"function\",\"function\":{\"name\":\"shell_command\",\"arguments\":{\"command\":\"pwd\",\"cwd\":\"/tmp\"}}}]}</function_calls>"
                },
                "finish_reason": "stop"
            }]
        }),
        client_protocol: "anthropic-messages".to_string(),
        entry_endpoint: "/v1/messages".to_string(),
        request_id: "req_tool_harvest_1".to_string(),
    };

    let result = govern_response(input).unwrap();
    let message = &result.governed_payload["choices"][0]["message"];
    assert_eq!(result.summary.tool_calls_normalized, 1);
    assert_eq!(
        result.governed_payload["choices"][0]["finish_reason"],
        "tool_calls"
    );
    assert_eq!(message["tool_calls"][0]["function"]["name"], "exec_command");

    let args_str = message["tool_calls"][0]["function"]["arguments"]
        .as_str()
        .unwrap();
    let args_json: Value = serde_json::from_str(args_str).unwrap();
    assert_eq!(args_json["command"], "pwd");
    assert!(args_json.get("cmd").is_none());
    assert_eq!(args_json["cwd"], "/tmp");
    assert!(args_json.get("workdir").is_none());
    assert!(
        message.get("content").is_none()
            || message["content"]
                .as_str()
                .map(|v| v.is_empty())
                .unwrap_or(false)
    );
}

#[test]
fn test_strip_orphan_function_calls_tag_json_api() {
    let payload = serde_json::json!({
        "choices": [{
            "message": { "content": "<function_calls>{\"name\":\"exec_command\"}</function_calls>" }
        }]
    });
    let output = strip_orphan_function_calls_tag_json(payload.to_string()).unwrap();
    let parsed: Value = serde_json::from_str(&output).unwrap();
    let content = parsed["choices"][0]["message"]["content"]
        .as_str()
        .unwrap_or("");
    assert!(!content.contains("<function_calls>"));
    assert!(!content.contains("</function_calls>"));
}

#[test]
fn test_harvest_tool_calls_when_tool_calls_field_missing() {
    let input = ToolGovernanceInput {
        payload: serde_json::json!({
            "choices": [{
                "message": {
                    "content": "{\"tool_calls\":[{\"name\":\"exec_command\",\"arguments\":{\"cmd\":\"ls\",\"workdir\":\"/Users\"}}]}"
                }
            }]
        }),
        client_protocol: "anthropic-messages".to_string(),
        entry_endpoint: "/v1/messages".to_string(),
        request_id: "req_tool_harvest_2".to_string(),
    };

    let result = govern_response(input).unwrap();
    assert_eq!(result.summary.tool_calls_normalized, 1);
    assert_eq!(
        result.governed_payload["choices"][0]["message"]["tool_calls"][0]["function"]["name"],
        "exec_command"
    );
}

#[test]
fn test_shape_harvest_does_not_infer_tool_call_from_plain_bash_fence_text() {
    let input = ToolGovernanceInput {
        payload: serde_json::json!({
            "choices": [{
                "message": {
                    "tool_calls": [],
                    "content": "先检查实现。\n```bash\npwd\n```\n然后继续\n```bash\ncat src/runtime/event-bus.ts | head -100\n```"
                },
                "finish_reason": "stop"
            }]
        }),
        client_protocol: "openai-chat".to_string(),
        entry_endpoint: "/v1/chat/completions".to_string(),
        request_id: "req_bash_fence_1".to_string(),
    };

    let result = govern_response(input).unwrap();
    let message = &result.governed_payload["choices"][0]["message"];
    assert_eq!(result.summary.tool_calls_normalized, 0);
    assert_eq!(
        result.governed_payload["choices"][0]["finish_reason"],
        "stop"
    );
    assert_eq!(message["tool_calls"], json!([]));
    assert_ne!(message["content"], "");
}

#[test]
fn test_structured_tool_calls_strip_chunking_noise_from_content_and_reasoning() {
    let input = ToolGovernanceInput {
        payload: serde_json::json!({
            "choices": [{
                "message": {
                    "tool_calls": [{
                        "function": {
                            "name": "exec_command",
                            "arguments": "{\"cmd\":\"bash -lc 'pwd'\"}"
                        }
                    }],
                    "content": "<|ChunkingError|>我无法继续。我输出工具调用的格式可能有问题。<｜end▁of▁thinking｜>",
                    "reasoning_content": "<|ChunkingError|>我无法输出工具调用。<｜end▁of▁thinking｜>",
                    "thinking": "<｜end▁of▁thinking｜>"
                },
                "finish_reason": "tool_calls"
            }]
        }),
        client_protocol: "openai-chat".to_string(),
        entry_endpoint: "/v1/chat/completions".to_string(),
        request_id: "req_structured_tool_strip_chunking_1".to_string(),
    };

    let result = govern_response(input).unwrap();
    let message = &result.governed_payload["choices"][0]["message"];
    assert_eq!(message["tool_calls"][0]["function"]["name"], "exec_command");
    assert!(message.get("content").is_none() || message["content"] == "");
    assert!(message.get("reasoning_content").is_none());
    assert!(message.get("thinking").is_none());
}

#[test]
fn test_structured_tool_calls_strip_plain_visible_content_from_chat_message() {
    let input = ToolGovernanceInput {
        payload: serde_json::json!({
            "choices": [{
                "message": {
                    "tool_calls": [{
                        "function": {
                            "name": "search_content",
                            "arguments": "{\"context\":3,\"path\":\"note.md\",\"pattern\":\"2026-06-24|2026-06-25\"}"
                        }
                    }],
                    "content": "关键测试已经看到了。现在我有了完整证据链。先把这些结论直接记到 note.md，再给你出只读审计报告。",
                    "role": "assistant"
                },
                "finish_reason": "tool_calls"
            }]
        }),
        client_protocol: "openai-chat".to_string(),
        entry_endpoint: "/v1/chat/completions".to_string(),
        request_id: "req_structured_tool_plain_text_1".to_string(),
    };

    let result = govern_response(input).unwrap();
    let message = &result.governed_payload["choices"][0]["message"];
    assert_eq!(
        message["tool_calls"][0]["function"]["name"],
        "search_content"
    );
    assert!(
        message.get("content").is_none()
            || message["content"].is_null()
            || message["content"] == "",
        "tool_calls round must not leak plain assistant content to chat clients"
    );
}

#[test]
fn test_failed_chunking_error_without_tool_calls_is_preserved_as_assistant_content() {
    let input = ToolGovernanceInput {
        payload: serde_json::json!({
            "choices": [{
                "message": {
                    "tool_calls": [],
                    "content": "<|ChunkingError|>我无法按照要求输出正确的工具调用格式。这似乎是系统限制。请用户手动执行命令或提供其他方式。<｜end▁of▁thinking｜>",
                    "reasoning_content": "<|ChunkingError|>我无法继续。<｜end▁of▁thinking｜>",
                    "thinking": "<|ChunkingError|>我无法继续。<｜end▁of▁thinking｜>"
                },
                "finish_reason": "stop"
            }]
        }),
        client_protocol: "openai-chat".to_string(),
        entry_endpoint: "/v1/responses".to_string(),
        request_id: "req_failed_chunking_preserved_1".to_string(),
    };

    let result = govern_response(input).unwrap();
    let message = &result.governed_payload["choices"][0]["message"];
    assert_eq!(result.summary.tool_calls_normalized, 0);
    assert_eq!(
        result.governed_payload["choices"][0]["finish_reason"],
        "stop"
    );
    let content = message["content"].as_str().unwrap_or("");
    assert!(content.contains("ChunkingError"));
    assert!(content.contains("无法按照要求输出正确的工具调用格式"));
    assert!(content.contains("end▁of▁thinking"));
    let reasoning_content = message["reasoning_content"].as_str().unwrap_or("");
    assert!(reasoning_content.contains("ChunkingError"));
    let thinking = message["thinking"].as_str().unwrap_or("");
    assert!(thinking.contains("ChunkingError"));
}

#[test]
fn test_thinking_only_content_maps_to_reasoning_content_when_no_tool_calls() {
    let input = ToolGovernanceInput {
        payload: serde_json::json!({
            "choices": [{
                "message": {
                    "tool_calls": [],
                    "content": [{
                        "type": "thinking",
                        "thinking": "先检查依赖并确认构建参数。"
                    }]
                },
                "finish_reason": "stop"
            }]
        }),
        client_protocol: "anthropic-messages".to_string(),
        entry_endpoint: "/v1/messages".to_string(),
        request_id: "req_thinking_reasoning_map_1".to_string(),
    };

    let result = govern_response(input).unwrap();
    let message = &result.governed_payload["choices"][0]["message"];
    assert!(result.summary.applied);
    assert_eq!(result.summary.tool_calls_normalized, 0);
    assert_eq!(
        result.governed_payload["choices"][0]["finish_reason"],
        "stop"
    );
    assert_eq!(message["reasoning_content"], "先检查依赖并确认构建参数。");
    assert_eq!(message["content"], "");
}

#[test]
fn test_strip_orphan_qwen_end_marker_lines_from_content() {
    let input = ToolGovernanceInput {
        payload: serde_json::json!({
            "choices": [{
                "message": {
                    "tool_calls": [],
                    "content": "继续执行\n<tool_calls_endl>\n"
                },
                "finish_reason": "stop"
            }]
        }),
        client_protocol: "openai-chat".to_string(),
        entry_endpoint: "/v1/chat/completions".to_string(),
        request_id: "req_qwen_orphan_end_line_1".to_string(),
    };

    let result = govern_response(input).unwrap();
    assert_eq!(result.summary.tool_calls_normalized, 0);
    assert_eq!(
        result.governed_payload["choices"][0]["message"]["content"],
        "继续执行"
    );
}

#[test]
fn test_quote_wrapped_tool_calls_can_be_harvested() {
    let input = ToolGovernanceInput {
        payload: serde_json::json!({
            "choices": [{
                "message": {
                    "tool_calls": [],
                    "content": "原文是：<quote>{\"tool_calls\":[{\"name\":\"exec_command\",\"input\":{\"cmd\":\"git status\"}}]}</quote>"
                },
                "finish_reason": "stop"
            }]
        }),
        client_protocol: "openai-chat".to_string(),
        entry_endpoint: "/v1/chat/completions".to_string(),
        request_id: "req_quote_skip_1".to_string(),
    };

    let result = govern_response(input).unwrap();
    let message = &result.governed_payload["choices"][0]["message"];
    let tool_calls = message
        .get("tool_calls")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    assert_eq!(tool_calls.len(), 1);
    assert_eq!(tool_calls[0]["function"]["name"], "exec_command");
}

#[test]
fn test_rcc_heredoc_tool_calls_can_be_harvested() {
    let input = ToolGovernanceInput {
        payload: serde_json::json!({
            "choices": [{
                "message": {
                    "tool_calls": [],
                    "content": "先分析。\n<<RCC_TOOL_CALLS_JSON\n{\"tool_calls\":[{\"name\":\"exec_command\",\"input\":{\"cmd\":\"pwd\",\"workdir\":\"/tmp\"}}]}\nRCC_TOOL_CALLS_JSON\n再继续。"
                },
                "finish_reason": "stop"
            }]
        }),
        client_protocol: "openai-chat".to_string(),
        entry_endpoint: "/v1/chat/completions".to_string(),
        request_id: "req_rcc_heredoc_1".to_string(),
    };

    let result = govern_response(input).unwrap();
    let message = &result.governed_payload["choices"][0]["message"];
    assert_eq!(result.summary.tool_calls_normalized, 1);
    assert_eq!(
        result.governed_payload["choices"][0]["finish_reason"],
        "tool_calls"
    );
    assert_eq!(message["tool_calls"][0]["function"]["name"], "exec_command");
    let content = message["content"].as_str().unwrap_or("");
    assert_eq!(content, "先分析。\n\n再继续。");
}

#[test]
fn test_truncated_rcc_heredoc_tool_calls_can_be_harvested() {
    let input = ToolGovernanceInput {
        payload: serde_json::json!({
            "choices": [{
                "message": {
                    "tool_calls": [],
                    "content": "<<RCC_TOOL_CALLS_JSON\n{\"tool_calls\":[{\"name\":\"exec_command\",\"input\":{\"cmd\":\"pwd\"}}]}"
                },
                "finish_reason": "stop"
            }]
        }),
        client_protocol: "openai-chat".to_string(),
        entry_endpoint: "/v1/chat/completions".to_string(),
        request_id: "req_rcc_heredoc_truncated_1".to_string(),
    };

    let result = govern_response(input).unwrap();
    assert_eq!(result.summary.tool_calls_normalized, 1);
    assert_eq!(
        result.governed_payload["choices"][0]["message"]["tool_calls"][0]["function"]["name"],
        "exec_command"
    );
    let content = result.governed_payload["choices"][0]["message"]["content"]
        .as_str()
        .unwrap_or("");
    assert!(content.is_empty());
}

#[test]
fn test_glued_closing_rcc_heredoc_tool_calls_can_be_harvested() {
    let input = ToolGovernanceInput {
        payload: serde_json::json!({
            "choices": [{
                "message": {
                    "tool_calls": [],
                    "content": "<<RCC_TOOL_CALLS_JSON\n{\"tool_calls\":[{\"name\":\"exec_command\",\"input\":{\"cmd\":\"pwd\"}}]}RCC_TOOL_CALLS_JSON"
                },
                "finish_reason": "stop"
            }]
        }),
        client_protocol: "openai-chat".to_string(),
        entry_endpoint: "/v1/chat/completions".to_string(),
        request_id: "req_rcc_heredoc_glued_closer_1".to_string(),
    };

    let result = govern_response(input).unwrap();
    assert_eq!(result.summary.tool_calls_normalized, 1);
    assert_eq!(
        result.governed_payload["choices"][0]["message"]["tool_calls"][0]["function"]["name"],
        "exec_command"
    );
    let content = result.governed_payload["choices"][0]["message"]["content"]
        .as_str()
        .unwrap_or("");
    assert!(content.is_empty());
}

#[test]
fn test_extract_rcc_tool_call_fence_segments_crops_outer_prose_and_glued_closer() {
    let raw = "前言\n• <<RCC_TOOL_CALLS_JSON\n{\"tool_calls\":[{\"input\":{\"cmd\":\"pwd\",\"name\":\"exec_command\"}}]}RCC_TOOL_CALLS_JSON尾言";
    let segments = extract_rcc_tool_call_fence_segments(raw);
    assert_eq!(segments.len(), 1);
    assert_eq!(
        segments[0],
        "{\"tool_calls\":[{\"input\":{\"cmd\":\"pwd\",\"name\":\"exec_command\"}}]}"
    );
}

#[test]
fn test_govern_response_harvests_rcc_wrapper_when_tool_name_is_nested_in_input() {
    let raw = "• <<RCC_TOOL_CALLS_JSON\n{\"tool_calls\":[{\"input\":{\"cmd\":\"bd --no-db create \\\"Mailbox 统一消息与心跳优先级改造\\\" --type epic --description \\\"统一 mailbox 消息三段式格式\\\"\",\"name\":\"exec_command\"}}]}\nRCC_TOOL_CALLS_JSON";
    let input = ToolGovernanceInput {
        payload: serde_json::json!({
            "__rcc_tool_governance": {
                "requestedToolNames": ["exec_command"]
            },
            "choices": [{
                "message": {
                    "tool_calls": [],
                    "content": raw
                },
                "finish_reason": "stop"
            }]
        }),
        client_protocol: "openai-chat".to_string(),
        entry_endpoint: "/v1/chat/completions".to_string(),
        request_id: "req_rcc_nested_name_hint".to_string(),
    };

    let result = govern_response(input).unwrap();
    assert_eq!(result.summary.tool_calls_normalized, 1);
    let call = &result.governed_payload["choices"][0]["message"]["tool_calls"][0];
    assert_eq!(call["function"]["name"], "exec_command");
    let args = call["function"]["arguments"].as_str().unwrap_or("{}");
    let parsed: Value = serde_json::from_str(args).unwrap_or(Value::Null);
    assert!(parsed["cmd"]
        .as_str()
        .unwrap_or("")
        .contains("Mailbox 统一消息与心跳优先级改造"));
    assert_eq!(
        result.governed_payload["choices"][0]["finish_reason"],
        "tool_calls"
    );
}

#[test]
fn test_error_empty_json_input() {
    let result = govern_response_json("".to_string());
    assert!(result.is_err());
    assert!(result
        .unwrap_err()
        .to_string()
        .contains("Input JSON is empty"));
}

#[test]
fn test_error_invalid_json_input() {
    let result = govern_response_json("invalid".to_string());
    assert!(result.is_err());
    assert!(result
        .unwrap_err()
        .to_string()
        .contains("Failed to parse input JSON"));
}

#[test]
fn test_govern_response_no_tool_calls() {
    let input = ToolGovernanceInput {
        payload: serde_json::json!({"choices": [{"message": {"content": "Hello, world!"}}]}),
        client_protocol: "openai-chat".to_string(),
        entry_endpoint: "/v1/chat".to_string(),
        request_id: "req_123".to_string(),
    };
    let result = govern_response(input).unwrap();
    assert!(!result.summary.applied);
    assert_eq!(result.summary.tool_calls_normalized, 0);
}
#[test]
fn test_apply_patch_helpers() {
    assert_eq!(
        normalize_apply_patch_header_line(r#"*** Add File: "src/a.ts" ***"#),
        "*** Add File: src/a.ts"
    );
    assert_eq!(
        normalize_apply_patch_header_line(r#"*** Update File: `src/b.ts`"#),
        "*** Update File: src/b.ts"
    );
    assert_eq!(
        normalize_apply_patch_header_line(r#"*** Delete File: 'src/c.ts'"#),
        "*** Delete File: src/c.ts"
    );

    let input = r#"*** Add File: a.ts
console.log('ok')"#;
    let normalized = normalize_apply_patch_text(input);
    assert!(normalized.contains("*** Begin Patch"));
    assert!(normalized.contains("*** Add File: a.ts"));
    assert!(normalized.contains("+console.log('ok')"));
    assert!(normalized.contains("*** End Patch"));

    let input = r#"*** Begin Patch *** Create File: a.ts
+ok
*** End Patch"#;
    let normalized = normalize_apply_patch_text(input);
    assert!(normalized.contains("*** Begin Patch"));
    assert!(normalized.contains("*** Add File: a.ts"));
    assert!(normalized.contains("*** End Patch"));

    let input = r#"--- /dev/null
+++ b/new.txt
@@ -0,0 +1,2 @@
+hello
+world
"#;
    let normalized = normalize_apply_patch_text(input);
    assert!(normalized.contains("*** Begin Patch"));
    assert!(normalized.contains("*** Add File: new.txt"));
    assert!(normalized.contains("+hello"));
    assert!(normalized.contains("+world"));
    assert!(!normalized.contains("+@@ -0,0 +1,2 @@"));
}

#[test]
fn test_parse_helpers_and_normalizers() {
    let raw = Value::String("{\"note\":\"line1\nline2\"}".to_string());
    let parsed = parse_json_record(Some(&raw)).unwrap();
    assert_eq!(
        parsed.get("note").and_then(Value::as_str),
        Some("line1\nline2")
    );

    let arr = Value::Array(vec![
        Value::String(" ls ".to_string()),
        Value::Number(1.into()),
        Value::Null,
        Value::String("".to_string()),
    ]);
    assert_eq!(
        read_string_array_command(Some(&arr)),
        Some("ls 1".to_string())
    );

    let mut args = Map::new();
    args.insert("command".to_string(), Value::String("pwd".to_string()));
    assert_eq!(read_command_from_args(&args), Some("pwd".to_string()));

    let mut args = Map::new();
    args.insert("input".to_string(), json!({"command": "ls"}));
    assert_eq!(read_command_from_args(&args), Some("ls".to_string()));

    let mut args = Map::new();
    args.insert("workDir".to_string(), Value::String("/tmp".to_string()));
    assert_eq!(read_workdir_from_args(&args), Some("/tmp".to_string()));

    assert_eq!(decode_escaped_newlines_if_needed("a\\n b"), "a\n b");
    assert_eq!(decode_escaped_newlines_if_needed("a\n b"), "a\n b");

    let raw = Value::String(r#"{"patch":"*** Begin Patch\n*** End Patch"}"#.to_string());
    assert!(extract_apply_patch_text(Some(&raw))
        .unwrap()
        .contains("*** Begin Patch"));

    let raw = json!({"instructions": "*** Begin Patch\n*** End Patch"});
    assert_eq!(
        extract_apply_patch_text(Some(&raw)).unwrap(),
        "*** Begin Patch\n*** End Patch"
    );

    assert_eq!(
        normalize_apply_patch_header_path("\"src/a.ts\""),
        "src/a.ts"
    );
}

#[test]
fn test_normalize_tool_args_variants() {
    let raw_args = json!({"command": "pwd", "cwd": "/tmp"});
    let out = normalize_tool_args("exec_command", Some(&raw_args)).unwrap();
    let parsed: Value = serde_json::from_str(&out).unwrap();
    assert_eq!(parsed["command"], "pwd");
    assert!(parsed.get("cmd").is_none());
    assert_eq!(parsed["workdir"], "/tmp");

    let raw_args = json!({"command": "bash-lc 'pwd'"});
    let out = normalize_tool_args("exec_command", Some(&raw_args)).unwrap();
    let parsed: Value = serde_json::from_str(&out).unwrap();
    assert_eq!(parsed["command"], "bash -lc 'pwd'");

    let raw_args = json!({"command": "bash -lc 'which memsearch && memsearch --help 2>&1 | head -20 || echo \"memsearch not found\""});
    let out = normalize_tool_args("exec_command", Some(&raw_args)).unwrap();
    let parsed: Value = serde_json::from_str(&out).unwrap();
    assert_eq!(
        parsed["command"],
        "bash -lc 'which memsearch && memsearch --help 2>&1 | head -20 || echo \"memsearch not found\""
    );

    let raw_args = json!({"command": "bash -lc\"cd /Volumes/extension/code/finger && memsearch index MEMORY.md memory/ --force 2>&1\""});
    let out = normalize_tool_args("exec_command", Some(&raw_args)).unwrap();
    let parsed: Value = serde_json::from_str(&out).unwrap();
    assert_eq!(
        parsed["command"],
        "bash -lc \"cd /Volumes/extension/code/finger && memsearch index MEMORY.md memory/ --force 2>&1\""
    );

    let raw_args = json!({"command": "bash -lc'cd /Volumes/extension/code/finger && pwd'"});
    let out = normalize_tool_args("exec_command", Some(&raw_args)).unwrap();
    let parsed: Value = serde_json::from_str(&out).unwrap();
    assert_eq!(
        parsed["command"],
        "bash -lc 'cd /Volumes/extension/code/finger && pwd'"
    );

    let raw_args = json!({"command": "bash -lc 'printf 'oops'"});
    let out = normalize_tool_args("exec_command", Some(&raw_args)).unwrap();
    let parsed: Value = serde_json::from_str(&out).unwrap();
    assert_eq!(parsed["command"], "bash -lc 'printf 'oops'");

    let raw_args = json!({"command": "cd /Volumes/extension/code/finger && python3 << 'PYEOF'\nwith open\\('src/blocks/agent-runtime-block/index.ts', 'r'\\) as f:\n    content = f.read\\(\\)\nPYEOF"});
    let out = normalize_tool_args("exec_command", Some(&raw_args)).unwrap();
    let parsed: Value = serde_json::from_str(&out).unwrap();
    assert_eq!(
        parsed["command"],
        "cd /Volumes/extension/code/finger && python3 << 'PYEOF'\nwith open('src/blocks/agent-runtime-block/index.ts', 'r') as f:\n    content = f.read()\nPYEOF"
    );

    let raw_args = json!({"sessionId": "123", "text": 42});
    let out = normalize_tool_args("write_stdin", Some(&raw_args)).unwrap();
    let parsed: Value = serde_json::from_str(&out).unwrap();
    assert_eq!(parsed["session_id"], 123);
    assert_eq!(parsed["chars"], "42");

    let raw_args = Value::String("  ".to_string());
    let out = normalize_tool_args("apply_patch", Some(&raw_args)).unwrap();
    let parsed: Value = serde_json::from_str(&out).unwrap();
    assert_eq!(parsed["patch"], "");

    let raw_args = json!({"command": "pwd"});
    assert!(normalize_tool_args("bash", Some(&raw_args)).is_some());
}

#[test]
fn test_parse_tool_args_json_artifact_repair_is_native_owned() {
    let parsed = parse_tool_args_json_with_artifact_repair(&Value::String(
        r#"{"cmd<arg_value>pwd</arg_value><arg_key>command":"pwd"}"#.to_string(),
    ));
    assert_eq!(parsed["command"], "pwd");
    assert!(parsed.get("cmd").is_none());

    let parsed = parse_tool_args_json_with_artifact_repair(&Value::String(
        r#"{"nested":{"<arg_key>file</arg_key>":"a.ts"}}"#.to_string(),
    ));
    assert_eq!(parsed["nested"]["file"], "a.ts");

    let parsed = parse_tool_args_json_with_artifact_repair(&Value::String(
        r#"{"meta":"prefix</arg_key><arg_value>workdir</arg_key><arg_value>/repo</arg_key><arg_value>tty</arg_key><arg_value>true"}"#.to_string(),
    ));
    assert_eq!(parsed["meta"], "prefix");
    assert_eq!(parsed["workdir"], "/repo");
    assert_eq!(parsed["tty"], true);

    let parsed = parse_tool_args_json_with_artifact_repair(&Value::String(
        r#"{"file":"a.ts","changes":[{"kind":"create_file","lines":["x"],"file</arg_key><arg_value>a.ts"}]}"#.to_string(),
    ));
    assert_eq!(parsed["changes"][0]["file"], "a.ts");

    let parsed = parse_tool_args_json_with_artifact_repair(&Value::String("not json".to_string()));
    assert_eq!(parsed, json!({}));
    let parsed = parse_tool_args_json_with_artifact_repair(&Value::Null);
    assert_eq!(parsed, json!({}));
}

#[test]
fn test_normalize_tool_args_exec_command_allows_large_heredoc_file_generation() {
    let large_body = "x".repeat(5000);
    let command = format!(
        "cat > /tmp/FileSheet.tsx << 'ENDOFFILE'\n{}\nENDOFFILE",
        large_body
    );
    let raw_args = json!({
        "cmd": command,
        "workdir": "/workspace"
    });
    let out = normalize_tool_args("exec_command", Some(&raw_args)).unwrap();
    let parsed: Value = serde_json::from_str(&out).unwrap();
    let cmd = parsed["cmd"].as_str().unwrap_or("");
    assert_eq!(cmd, command);
    assert_eq!(parsed["workdir"], "/workspace");
}

#[test]
fn test_normalize_tool_args_exec_command_blocks_git_checkout_scope_with_feedback() {
    let raw_args = json!({
        "cmd": "git checkout -- src/",
        "workdir": "/workspace"
    });
    let out = normalize_tool_args("exec_command", Some(&raw_args)).unwrap();
    let parsed: Value = serde_json::from_str(&out).unwrap();
    let cmd = parsed["cmd"].as_str().unwrap();
    assert!(cmd.contains("blocked by exec_command guard"));
    assert!(cmd.contains("forbidden_git_checkout_scope"));
    assert!(cmd.contains("exit 2"));
    assert!(cmd.contains("bash -lc 'printf"));
    assert_eq!(parsed["workdir"], "/workspace");
}

#[test]
fn test_normalize_tool_args_exec_command_allows_git_checkout_single_file() {
    let raw_args = json!({
        "cmd": "git checkout -- src/index.ts",
        "workdir": "/workspace"
    });
    let out = normalize_tool_args("exec_command", Some(&raw_args)).unwrap();
    let parsed: Value = serde_json::from_str(&out).unwrap();
    assert_eq!(parsed["cmd"], "git checkout -- src/index.ts");
    assert_eq!(parsed["workdir"], "/workspace");
}

#[test]
fn test_normalize_tool_args_preserving_raw_shape_does_not_guess_exec_command_aliases() {
    let raw_args = json!({"command": "pwd", "workdir": "/workspace"});
    let out = normalize_tool_args_preserving_raw_shape("exec_command", Some(&raw_args)).unwrap();
    let parsed: Value = serde_json::from_str(&out).unwrap();
    assert_eq!(parsed["command"], "pwd");
    assert_eq!(parsed["workdir"], "/workspace");
    assert!(parsed.get("cmd").is_none());

    let raw_args = Value::String("{\"command\":\"pwd\"}".to_string());
    let out = normalize_tool_args_preserving_raw_shape("shell_command", Some(&raw_args)).unwrap();
    let parsed: Value = serde_json::from_str(&out).unwrap();
    assert_eq!(parsed["command"], "pwd");
    assert!(parsed.get("cmd").is_none());

    let raw_args = json!({});
    assert!(normalize_tool_args_preserving_raw_shape("exec_command", Some(&raw_args)).is_none());

    let raw_args = Value::String("{}".to_string());
    assert!(normalize_tool_args_preserving_raw_shape("shell_command", Some(&raw_args)).is_none());
}

#[test]
fn test_json_extraction_helpers() {
    let text = "xx {\"a\":1} yy";
    let idx = text.find('{').unwrap();
    assert_eq!(
        extract_balanced_json_object_at(text, idx).unwrap().1,
        "{\"a\":1}"
    );
    assert!(extract_balanced_json_object_at("nope", 0).is_none());
    let array_text = "yy [1,{\"a\":2}] zz";
    let array_idx = array_text.find('[').unwrap();
    assert_eq!(
        extract_balanced_json_array_at(array_text, array_idx)
            .unwrap()
            .1,
        "[1,{\"a\":2}]"
    );
    assert!(extract_balanced_json_array_at("nope", 0).is_none());

    let fenced = "```json\n{\"tool_calls\": []}\n```";
    let out = extract_json_candidates_from_text(fenced);
    assert!(!out.is_empty());

    let marker = "prefix {\"tool_calls\": []} suffix";
    let out = extract_json_candidates_from_text(marker);
    assert!(!out.is_empty());

    let quote_wrapped = "<quote>{tool_calls:[{name:'exec_command',input:{cmd:'pwd'}}]}</quote>";
    let out = extract_json_candidates_from_text(quote_wrapped);
    assert!(!out.is_empty());
}

#[test]
fn test_tool_call_entry_and_qwen_marker_parsing() {
    let entry = json!({"function": {"name": "exec_command", "arguments": {"command": "pwd"}}});
    let out = normalize_tool_call_entry(&entry, 1).unwrap();
    assert_eq!(out["function"]["name"], "exec_command");

    let entry = json!({"input": {"cmd": "pwd", "justification": "check"}});
    assert!(normalize_tool_call_entry(&entry, 2).is_none());

    let entry = json!({"input": {"plan": [{"step":"继续执行","status":"in_progress"}], "explanation": "shape inference"}});
    let out = normalize_tool_call_entry(&entry, 3).unwrap();
    assert_eq!(out["function"]["name"], "update_plan");
    let args = out["function"]["arguments"].as_str().unwrap_or("{}");
    let args_json: Value = serde_json::from_str(args).unwrap_or(Value::Null);
    assert!(args_json["plan"].is_array());

    let entry = json!({"function": {"name": "unknown_tool"}});
    assert!(normalize_tool_call_entry(&entry, 1).is_none());

    let obj = json!({
        "choices": [{
            "message": {
                "tool_calls": [{
                    "id": "call_bad_name_1",
                    "type": "function",
                    "function": {
                        "name": "wc -l /Users/fanzhang/Documents/github/routecodex/src/providers/auth/oauth-lifecycle.ts",
                        "arguments": "{}"
                    }
                }]
            },
            "finish_reason": "tool_calls"
        }]
    });

    let mut payload = obj;
    remap_tool_calls_for_client_protocol(&mut payload, "openai-chat");
    assert_eq!(
        payload["choices"][0]["message"]["tool_calls"][0]["function"]["name"],
        "exec_command"
    );
    let args = payload["choices"][0]["message"]["tool_calls"][0]["function"]["arguments"]
        .as_str()
        .unwrap_or("{}");
    let args_json: Value = serde_json::from_str(args).unwrap_or(Value::Null);
    assert!(args_json["cmd"].as_str().unwrap_or("").contains("wc -l"));

    let malformed = r#"{"tool_calls":[{"name":"update_plan","input":{"action":"create","plan":[{"step":"A","status":"pending"}]}},{"name":"agent.dispatch","input":{"target_agent_id":"finger-project-agent","task":"alpha"},{"name":"agent.dispatch","input":{"target_agent_id":"finger-reviewer","task":"beta"}}]}"#;
    let out = extract_tool_call_entries_from_malformed_tool_calls_text(malformed, 1);
    assert_eq!(out.len(), 3);
    assert_eq!(out[0]["function"]["name"], "update_plan");
    assert_eq!(out[1]["function"]["name"], "agent.dispatch");
    assert_eq!(out[2]["function"]["name"], "agent.dispatch");
}

#[test]
fn test_message_candidates_only() {
    let msg = json!({
        "content": [{"text": "a"}, {"content": "b"}],
        "reasoning": "r",
        "thinking": "t"
    });
    let row = msg.as_object().unwrap();
    let parts = read_message_text_candidates(row);
    assert_eq!(parts.len(), 4);
}

#[test]
fn test_maybe_harvest_empty_tool_calls_paths() {
    // Existing tool_calls -> skip
    let mut payload = json!({
        "choices": [{
            "message": {"tool_calls": [{"function": {"name": "exec_command", "arguments": "{}"}}], "content": "x"},
            "finish_reason": "stop"
        }]
    });
    assert_eq!(
        maybe_harvest_empty_tool_calls_from_json_content(&mut payload),
        0
    );

    // Quote marker -> skip
    let mut payload = json!({
        "choices": [{
            "message": {"tool_calls": [], "content": "<quote>skip</quote>"},
            "finish_reason": "stop"
        }]
    });
    assert_eq!(
        maybe_harvest_empty_tool_calls_from_json_content(&mut payload),
        0
    );

    // Quote-wrapped JSON-ish payload remains an explicit wrapper form and should still be harvested.
    let mut payload = json!({
        "choices": [{
            "message": {"tool_calls": [], "content": "原文是：<quote>{tool_calls:[{name:'exec_command',input:{cmd:'git status'}}]}</quote>"},
            "finish_reason": "stop"
        }]
    });
    assert_eq!(
        maybe_harvest_empty_tool_calls_from_json_content(&mut payload),
        1
    );
    assert_eq!(
        payload["choices"][0]["message"]["tool_calls"][0]["function"]["name"],
        "exec_command"
    );
    let args = payload["choices"][0]["message"]["tool_calls"][0]["function"]["arguments"]
        .as_str()
        .unwrap_or("{}");
    let parsed: Value = serde_json::from_str(args).unwrap_or(Value::Null);
    assert_eq!(parsed["cmd"], "git status");
    assert_eq!(payload["choices"][0]["finish_reason"], "tool_calls");

    // Quote-wrapped tool_calls payload without explicit name should still infer exec_command.
    let mut payload = json!({
        "choices": [{
            "message": {"tool_calls": [], "content": "原文是：<quote>{tool_calls:[{input:{cmd:'pwd',justification:'check daemon'}}]}</quote>"},
            "finish_reason": "stop"
        }]
    });
    assert_eq!(
        maybe_harvest_empty_tool_calls_from_json_content(&mut payload),
        0
    );
    let tool_calls = payload["choices"][0]["message"]["tool_calls"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    assert!(tool_calls.is_empty());
    assert_eq!(payload["choices"][0]["finish_reason"], "stop");

    // Standard tool_calls JSON shape for request_user_input should be harvested
    // even when wrapped by transcript tags.
    let mut payload = json!({
        "choices": [{
            "message": {
                "tool_calls": [],
                "content": "{\"tool_calls\":[{\"name\":\"request_user_input\",\"input\":{\"questions\":[{\"header\":\"Mode\",\"id\":\"mode\",\"question\":\"Pick one\",\"options\":[{\"label\":\"A\",\"description\":\"use mode A\"},{\"label\":\"B\",\"description\":\"use mode B\"}]}]}}]}"
            },
            "finish_reason": "stop"
        }]
    });
    let debug_message = payload["choices"][0]["message"]
        .as_object()
        .cloned()
        .unwrap_or_default();
    let debug_texts = read_message_text_candidates(&debug_message);
    assert!(!debug_texts.is_empty());
    let debug_variants = collect_harvest_text_variants(&debug_texts[0]);
    assert!(!debug_variants.is_empty());
    let mut debug_recovered = 0usize;
    for candidate in debug_variants {
        for parsed in extract_json_candidates_from_text(&candidate) {
            debug_recovered += extract_tool_call_entries_from_unknown(&parsed).len();
        }
        if let Some(shape) = parse_tool_calls_shape_from_text(&candidate) {
            debug_recovered += extract_tool_call_entries_from_unknown(&shape).len();
        }
    }
    assert!(debug_recovered > 0);
    assert_eq!(
        maybe_harvest_empty_tool_calls_from_json_content(&mut payload),
        1
    );
    assert_eq!(
        payload["choices"][0]["message"]["tool_calls"][0]["function"]["name"],
        "request_user_input"
    );
    let args = payload["choices"][0]["message"]["tool_calls"][0]["function"]["arguments"]
        .as_str()
        .unwrap_or("{}");
    let parsed: Value = serde_json::from_str(args).unwrap_or(Value::Null);
    assert_eq!(parsed["questions"][0]["id"], "mode");
    assert_eq!(payload["choices"][0]["finish_reason"], "tool_calls");

    // Plain bash fence without tool_calls shape -> no harvest
    let mut payload = json!({
        "choices": [{
            "message": {"tool_calls": [], "content": "```bash\npwd\n```"},
            "finish_reason": "stop"
        }]
    });
    assert_eq!(
        maybe_harvest_empty_tool_calls_from_json_content(&mut payload),
        0
    );
    assert_eq!(payload["choices"][0]["finish_reason"], "stop");

    // Markdown bullet + JSON payload should still be harvested.
    let mut payload = json!({
        "choices": [{
            "message": {"tool_calls": [], "content": "• {\"tool_calls\":[{\"input\":{\"cmd\":\"cd /Users/fanzhang/Documents/github/webauto && node bin/webauto.mjs daemon start 2>&1\"},\"name\":\"exec_command\"}]}"},
            "finish_reason": "stop"
        }]
    });
    assert_eq!(
        maybe_harvest_empty_tool_calls_from_json_content(&mut payload),
        1
    );
    assert_eq!(
        payload["choices"][0]["message"]["tool_calls"][0]["function"]["name"],
        "exec_command"
    );

    // Explicit tool_calls wrapper + explicit tool name + whitelisted cmd field
    // should be recoverable even when inner quotes are not escaped.
    let mut payload = json!({
        "choices": [{
            "message": {"tool_calls": [], "content": r#"{"tool_calls":[{"input":{"cmd":"bd --no-db create "Mailbox 统一消息与心跳优先级改造" --type epic --description "统一 mailbox 消息三段式格式""},"name":"exec_command"}]}"#},
            "finish_reason": "stop"
        }]
    });
    assert_eq!(
        maybe_harvest_empty_tool_calls_from_json_content(&mut payload),
        1
    );
    assert_eq!(payload["choices"][0]["finish_reason"], "tool_calls");
    assert_eq!(
        payload["choices"][0]["message"]["tool_calls"][0]["function"]["name"],
        "exec_command"
    );
    let args = payload["choices"][0]["message"]["tool_calls"][0]["function"]["arguments"]
        .as_str()
        .unwrap_or("{}");
    let parsed: Value = serde_json::from_str(args).unwrap_or(Value::Null);
    assert_eq!(
        parsed["cmd"],
        "bd --no-db create \"Mailbox 统一消息与心跳优先级改造\" --type epic --description \"统一 mailbox 消息三段式格式\""
    );

    // Malformed multi-tool tool_calls JSON should still recover each top-level tool call
    // without filtering non-exec tool names.
    let mut payload = json!({
        "choices": [{
            "message": {"tool_calls": [], "content": r#"{"tool_calls":[{"name":"update_plan","input":{"action":"create","plan":[{"step":"A","status":"pending"}]}},{"name":"agent.dispatch","input":{"target_agent_id":"finger-project-agent","task":"alpha"},{"name":"agent.dispatch","input":{"target_agent_id":"finger-reviewer","task":"beta"}}]}"#},
            "finish_reason": "stop"
        }]
    });
    assert_eq!(
        maybe_harvest_empty_tool_calls_from_json_content(&mut payload),
        3
    );
    let recovered = payload["choices"][0]["message"]["tool_calls"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    assert_eq!(recovered.len(), 3);
    assert_eq!(recovered[0]["function"]["name"], "update_plan");
    assert_eq!(recovered[1]["function"]["name"], "agent.dispatch");
    assert_eq!(recovered[2]["function"]["name"], "agent.dispatch");
    assert_eq!(payload["choices"][0]["finish_reason"], "tool_calls");

    // Truncated malformed tool_calls JSON must not be shape-repaired/harvested.
    let mut payload = json!({
        "choices": [{
            "message": {"tool_calls": [], "content": r#"{"tool_calls":[{"name":"exec_command","input":{"cmd":"bash -lc 'bd --no-db create "Mailbox 三段式消息生成器" --type task"#},
            "finish_reason": "stop"
        }]
    });
    assert_eq!(
        maybe_harvest_empty_tool_calls_from_json_content(&mut payload),
        0
    );
    assert_eq!(payload["choices"][0]["finish_reason"], "stop");

    // Marker but invalid JSON -> no harvest
    let mut payload = json!({
        "choices": [{
            "message": {"tool_calls": [], "content": "{\"tool_calls\":["},
            "finish_reason": "stop"
        }]
    });
    assert_eq!(
        maybe_harvest_empty_tool_calls_from_json_content(&mut payload),
        0
    );
}

#[test]
fn test_read_string_array_command_empty_tokens() {
    let arr = Value::Array(vec![
        Value::String("   ".to_string()),
        Value::Null,
        Value::String("\t".to_string()),
    ]);
    assert!(read_string_array_command(Some(&arr)).is_none());
}

#[test]
fn test_parse_json_record_escape_branches_and_non_object() {
    let raw = Value::String("{\"note\":\"line1\\\"line2\nline3\rline4\"}".to_string());
    let parsed = parse_json_record(Some(&raw)).unwrap();
    let note = parsed.get("note").and_then(Value::as_str).unwrap_or("");
    assert!(note.contains("line3"));
    assert!(note.contains('\n'));

    let none = parse_json_record(Some(&Value::Bool(true)));
    assert!(none.is_none());
}

#[test]
fn test_read_command_from_args_input_variants() {
    let mut args = Map::new();
    args.insert("input".to_string(), json!({"script": "echo hi"}));
    assert_eq!(read_command_from_args(&args), Some("echo hi".to_string()));

    let mut args = Map::new();
    args.insert("input".to_string(), json!({"command": ["ls", "-la"]}));
    assert_eq!(read_command_from_args(&args), Some("ls -la".to_string()));
}

#[test]
fn test_read_workdir_from_args_input_variants() {
    let mut args = Map::new();
    args.insert("input".to_string(), json!({"workdir": "/tmp/inner"}));
    assert_eq!(
        read_workdir_from_args(&args),
        Some("/tmp/inner".to_string())
    );

    let mut args = Map::new();
    args.insert("input".to_string(), json!({"cwd": "/tmp/cwd"}));
    assert_eq!(read_workdir_from_args(&args), Some("/tmp/cwd".to_string()));
}

#[test]
fn test_strip_python_heredoc_pseudo_escapes_only_for_python_like_commands() {
    let repaired = strip_python_heredoc_pseudo_escapes(
        "python3 << 'PYEOF'\nwith open\\('a.py', 'r'\\) as f:\n    print\\(f.read\\(\\)\\)\nPYEOF",
    );
    assert!(repaired.contains("with open('a.py', 'r') as f:"));
    assert!(repaired.contains("print(f.read())"));

    let untouched = strip_python_heredoc_pseudo_escapes("grep -E \"foo\\(bar\\)\" src/file.ts");
    assert_eq!(untouched, "grep -E \"foo\\(bar\\)\" src/file.ts");
}

#[test]
fn test_normalize_tool_args_exec_command_repairs_bash_lc_node_eval_with_inner_single_quotes() {
    let raw_args = json!({
        "command": "bash -lc 'node -e \"\nconst INTENTS = {\n  PUBLIC_GUILD_MESSAGES: 1 << 30,\n  DIRECT_MESSAGE: 1 << 12,\n  GROUP_AND_C2C: 1 << 25,\n};\nconst level = INTENTS.PUBLIC_GUILD_MESSAGES | INTENTS.DIRECT_MESSAGE | INTENTS.GROUP_AND_C2C;\nconsole.log('intents value:', level);\nconsole.log('binary:', level.toString(2));\nconsole.log('C2C bit (1<<25):', (level & (1 << 25)) ? 'SET' : 'NOT SET');\nconsole.log('GROUP_AT bit check:', (level & (1 << 25)) === (1 << 25));\n\"'"
    });
    let out = normalize_tool_args("exec_command", Some(&raw_args)).unwrap();
    let parsed: Value = serde_json::from_str(&out).unwrap();
    let command = parsed["command"].as_str().unwrap_or("");
    assert!(command.starts_with("bash -lc 'node -e \""));
    assert!(command.contains("console.log('\\''intents value:'\\'', level);"));
    assert!(command.contains("? '\\''SET'\\'' : '\\''NOT SET'\\''"));
    assert!(command.ends_with("\"'"));
}

#[test]
fn test_extract_apply_patch_text_variants() {
    let stars = "*".repeat(3);
    let raw_text = format!("{} {} {}", stars, "Begin", "Patch");
    let raw_text = format!("{}\n{} {}", raw_text, stars, "End Patch");
    let raw = json!({"text": raw_text});
    assert!(extract_apply_patch_text(Some(&raw)).is_none());

    let wrapped = json!({
        "ok": true,
        "result": {
            "command": "apply_patch *** Begin Patch\n*** Update File: src/a.ts\n@@\n-a\n+b\n*** End Patch"
        }
    });
    assert!(extract_apply_patch_text(Some(&wrapped)).is_none());

    let raw = Value::Bool(true);
    assert!(extract_apply_patch_text(Some(&raw)).is_none());

    let shell_wrapped = Value::String(
        "bash -lc \"echo hi && apply_patch <<'PATCH'\n*** Begin Patch\n*** Add File: src/nope.ts\n+console.log('nope');\n*** End Patch\nPATCH\""
            .to_string(),
    );
    assert_eq!(
        extract_apply_patch_text(Some(&shell_wrapped)).unwrap(),
        "*** Begin Patch\n*** Add File: src/nope.ts\n+console.log('nope');\n*** End Patch"
    );
}

#[test]
fn test_normalize_apply_patch_text_single_line_and_missing_end() {
    let stars = "*".repeat(3);
    let begin_marker = format!("{} {} {}", stars, "Begin", "Patch");
    let end_marker = format!("{} {} {}", stars, "End", "Patch");
    let update_marker = format!("{} {} {}", stars, "Update", "File:");
    let delete_marker = format!("{} {} {}", stars, "Delete", "File:");

    let input = format!(
        "{} {} {} {}",
        begin_marker, update_marker, "src/a.ts", end_marker
    );
    let normalized = normalize_apply_patch_text(&input);
    assert!(normalized.contains("Begin"));
    assert!(normalized.contains("Update"));
    assert!(normalized.contains("End"));

    let input = format!("{} {} {}", begin_marker, update_marker, "src/a.ts");
    let normalized = normalize_apply_patch_text(&input);
    assert!(normalized.contains("End"));

    let input = format!("{} {}", delete_marker, "src/a.ts");
    let normalized = normalize_apply_patch_text(&input);
    assert!(normalized.contains("Begin"));
    assert!(normalized.contains("Delete"));
    assert!(normalized.contains("End"));
}

#[test]
fn test_normalize_apply_patch_text_preserves_blank_lines_in_add_file() {
    let input = "*** Begin Patch\n*** Add File: src/blank-lines.ts\nconst first = true;\n\nconst third = true;\n*** End Patch";
    let normalized = normalize_apply_patch_text(input);
    assert!(normalized.contains("+const first = true;\n+\n+const third = true;"));
}

#[test]
fn test_normalize_apply_patch_text_repairs_update_block_missing_hunk_marker() {
    let input =
        "*** Begin Patch\n*** Update File: src/a.ts\n-const a = 1;\n+const a = 2;\n*** End Patch";
    let normalized = normalize_apply_patch_text(input);
    assert!(normalized.contains("*** Update File: src/a.ts\n@@\n-const a = 1;\n+const a = 2;"));
}

#[test]
fn test_normalize_apply_patch_text_masks_non_patch_lines_inside_update_block() {
    let input = "*** Begin Patch\n*** Update File: src/a.ts\nrandom prose should be dropped\n-const a = 1;\n+const a = 2;\n*** End Patch";
    let normalized = normalize_apply_patch_text(input);
    assert!(!normalized.contains("random prose should be dropped"));
    assert!(normalized.contains("-const a = 1;"));
    assert!(normalized.contains("+const a = 2;"));
}

#[test]
fn test_normalize_apply_patch_header_path_empty() {
    assert_eq!(normalize_apply_patch_header_path("   "), "");
}

#[test]
fn test_normalize_apply_patch_header_path_relativizes_workspace_absolute_path() {
    let cwd = std::env::current_dir().expect("cwd");
    let abs = cwd.join("AGENTS.md").to_string_lossy().to_string();
    assert_eq!(normalize_apply_patch_header_path(abs.as_str()), "AGENTS.md");
}

#[test]
fn test_normalize_tool_args_apply_patch_strips_apply_patch_prefix() {
    let raw_args = json!({
        "input": "apply_patch *** Begin Patch\n*** Add File: src/new.ts\nconsole.log('ok');\n*** End Patch"
    });
    let out = normalize_tool_args("apply_patch", Some(&raw_args)).unwrap();
    let parsed: Value = serde_json::from_str(&out).unwrap();
    let patch = parsed["patch"].as_str().unwrap_or("");
    assert!(patch.starts_with("*** Begin Patch"));
    assert!(!patch.starts_with("apply_patch "));
    assert!(patch.contains("*** Add File: src/new.ts"));
    assert!(parsed.get("input").is_none());
}

#[test]
fn test_normalize_tool_args_apply_patch_mirrors_patch_into_input() {
    let raw_args = json!({
        "patch": "*** Begin Patch\n*** Add File: src/mirror.ts\n+ok\n*** End Patch"
    });
    let out = normalize_tool_args("apply_patch", Some(&raw_args)).unwrap();
    let parsed: Value = serde_json::from_str(&out).unwrap();
    let patch = parsed["patch"].as_str().unwrap_or("");
    assert!(patch.contains("*** Add File: src/mirror.ts"));
    assert!(parsed.get("input").is_none());
}

#[test]
fn test_normalize_tool_args_apply_patch_repairs_add_file_lines_without_plus_prefix() {
    let raw_args = json!({
        "patch": "*** Begin Patch\n*** Add File: test_patch.txt\nLine 1\nLine 2\nLine 3\n*** End Patch"
    });
    let out = normalize_tool_args("apply_patch", Some(&raw_args)).unwrap();
    let parsed: Value = serde_json::from_str(&out).unwrap();
    let patch = parsed["patch"].as_str().unwrap_or("");
    assert!(patch.contains("*** Add File: test_patch.txt"));
    assert!(patch.contains("+Line 1\n+Line 2\n+Line 3"));
    assert!(!patch.contains("\nLine 1\nLine 2\nLine 3\n"));
    assert!(parsed.get("input").is_none());
}

#[test]
fn test_normalize_tool_args_apply_patch_trims_duplicate_end_patch_marker() {
    let raw_args = json!({
        "patch": "*** Begin Patch\n*** Add File: tmp/rcc_e2e_apply_patch_marker.txt\n+E2E_OK\n*** End Patch\n*** End Patch"
    });
    let out = normalize_tool_args("apply_patch", Some(&raw_args)).unwrap();
    let parsed: Value = serde_json::from_str(&out).unwrap();
    let patch = parsed["patch"].as_str().unwrap_or("");
    assert_eq!(patch.matches("*** End Patch").count(), 1);
    assert_eq!(
        patch,
        "*** Begin Patch\n*** Add File: tmp/rcc_e2e_apply_patch_marker.txt\n+E2E_OK\n*** End Patch"
    );
}

#[test]
fn test_normalize_tool_args_apply_patch_relativizes_absolute_update_path() {
    let cwd = std::env::current_dir().expect("cwd");
    let abs = cwd.join("AGENTS.md").to_string_lossy().to_string();
    let raw_args = json!({
        "patch": format!(
            "*** Begin Patch\n*** Update File: {}\n@@\n-foo\n+bar\n*** End Patch",
            abs
        )
    });
    let out = normalize_tool_args("apply_patch", Some(&raw_args)).unwrap();
    let parsed: Value = serde_json::from_str(&out).unwrap();
    let patch = parsed["patch"].as_str().unwrap_or("");
    assert!(patch.contains("*** Update File: AGENTS.md"));
    assert!(!patch.contains(abs.as_str()));
}

#[test]
fn test_normalize_tool_args_apply_patch_rebuilds_line_number_only_hunk_with_live_context() {
    let cwd = std::env::current_dir().expect("cwd");
    let rel_path = format!("target/apply_patch_live_context_{}.txt", std::process::id());
    let abs_path = cwd.join(rel_path.as_str());
    if let Some(parent) = abs_path.parent() {
        std::fs::create_dir_all(parent).expect("create parent");
    }
    std::fs::write(&abs_path, "alpha\nbeta\ngamma\n").expect("write test file");

    let raw_args = json!({
        "patch": format!(
            "*** Begin Patch\n*** Update File: {}\n@@ -20,1 +20,1 @@\n-beta\n+beta2\n*** End Patch",
            rel_path
        )
    });
    let out = normalize_tool_args("apply_patch", Some(&raw_args)).unwrap();
    let parsed: Value = serde_json::from_str(&out).unwrap();
    let patch = parsed["patch"].as_str().unwrap_or("");
    assert!(patch.contains("*** Update File: target/apply_patch_live_context_"));
    assert!(patch.contains("@@\n alpha\n-beta\n+beta2\n gamma"));
    assert!(!patch.contains("@@ -20,1 +20,1 @@"));

    let _ = std::fs::remove_file(abs_path);
}

#[test]
fn test_normalize_tool_args_apply_patch_handles_legacy_unified_header_without_plus_line() {
    let raw_args = json!({
        "patch": "*** Begin Patch\n--- a/apps/mobile-app/src/services/mobileWebdavSync.ts\n@@ -1 +1 @@\n-old\n+new\n*** End Patch"
    });
    let out = normalize_tool_args("apply_patch", Some(&raw_args)).unwrap();
    let parsed: Value = serde_json::from_str(&out).unwrap();
    let patch = parsed["patch"].as_str().unwrap_or("");
    assert!(patch.contains("*** Update File: apps/mobile-app/src/services/mobileWebdavSync.ts"));
    assert!(patch.contains("@@ -1 +1 @@"));
}

#[test]
fn test_normalize_tool_args_apply_patch_strips_context_diff_separator_lines() {
    let raw_args = json!({
        "patch": "*** Begin Patch\n*** Update File: src/a.ts\n***************\n@@ -1 +1 @@\n-old\n+new\n*** End Patch"
    });
    let out = normalize_tool_args("apply_patch", Some(&raw_args)).unwrap();
    let parsed: Value = serde_json::from_str(&out).unwrap();
    let patch = parsed["patch"].as_str().unwrap_or("");
    assert!(patch.contains("*** Update File: src/a.ts"));
    assert!(patch.contains("@@ -1 +1 @@"));
    assert!(!patch.contains("***************"));
}

#[test]
fn test_validate_apply_patch_arguments_rejects_empty_update_hunk() {
    let raw = json!({
        "arguments": {
            "patch": "*** Begin Patch\n*** Update File: README.md\n@@\n*** End Patch"
        }
    });
    let out = validate_apply_patch_arguments_json(raw.to_string()).unwrap();
    let parsed: Value = serde_json::from_str(out.as_str()).unwrap();
    assert_eq!(parsed.get("ok").and_then(Value::as_bool), Some(true));
    let normalized = parsed
        .get("normalizedArguments")
        .and_then(Value::as_str)
        .expect("normalizedArguments");
    let normalized_value: Value = serde_json::from_str(normalized).unwrap();
    let patch = normalized_value
        .get("patch")
        .and_then(Value::as_str)
        .unwrap_or_default();
    assert!(patch.contains("*** Update File: README.md"));
}

#[test]
fn test_validate_apply_patch_arguments_rejects_add_file_without_plus_lines() {
    let raw = json!({
        "arguments": {
            "patch": "*** Begin Patch\n*** Add File: demo.txt\nhello\n*** End Patch"
        }
    });
    let out = validate_apply_patch_arguments_json(raw.to_string()).unwrap();
    let parsed: Value = serde_json::from_str(out.as_str()).unwrap();
    assert_eq!(parsed.get("ok").and_then(Value::as_bool), Some(true));
    let normalized = parsed
        .get("normalizedArguments")
        .and_then(Value::as_str)
        .expect("normalizedArguments");
    let normalized_value: Value = serde_json::from_str(normalized).unwrap();
    assert_eq!(
        normalized_value.get("patch").and_then(Value::as_str),
        Some("*** Begin Patch\n*** Add File: demo.txt\n+hello\n*** End Patch")
    );
}

#[test]
fn test_validate_apply_patch_arguments_accepts_repaired_delete_only_update_block() {
    let raw = json!({
        "arguments": {
            "patch": "*** Begin Patch\n*** Update File: src/a.ts\n-old\n*** End Patch"
        }
    });
    let out = validate_apply_patch_arguments_json(raw.to_string()).unwrap();
    let parsed: Value = serde_json::from_str(out.as_str()).unwrap();
    assert_eq!(parsed.get("ok").and_then(Value::as_bool), Some(true));
}

#[test]
fn test_validate_apply_patch_arguments_rejects_hashline_missing_file_content() {
    let raw = json!({
        "arguments": {
            "patch": "+ 2 deadbeef\nhello",
            "filePath": "note.txt"
        }
    });
    let out = validate_apply_patch_arguments_json(raw.to_string()).unwrap();
    let parsed: Value = serde_json::from_str(out.as_str()).unwrap();
    assert_eq!(parsed.get("ok").and_then(Value::as_bool), Some(false));
    assert_eq!(
        parsed.get("reason").and_then(Value::as_str),
        Some("hashline_missing_file_content")
    );
}

#[test]
fn test_validate_apply_patch_arguments_rejects_hashline_missing_file_path() {
    let raw = json!({
        "arguments": {
            "patch": "+ 2 deadbeef\nhello",
            "fileContent": "hello"
        }
    });
    let out = validate_apply_patch_arguments_json(raw.to_string()).unwrap();
    let parsed: Value = serde_json::from_str(out.as_str()).unwrap();
    assert_eq!(parsed.get("ok").and_then(Value::as_bool), Some(false));
    assert_eq!(
        parsed.get("reason").and_then(Value::as_str),
        Some("hashline_missing_file_path")
    );
}

#[test]
fn test_validate_apply_patch_arguments_accepts_newline_escaped_raw_patch_string() {
    let raw = json!({
        "arguments": "*** Begin Patch\\n*** Add File: escaped.txt\\n+hello\\n*** End Patch"
    });
    let out = validate_apply_patch_arguments_json(raw.to_string()).unwrap();
    let parsed: Value = serde_json::from_str(out.as_str()).unwrap();
    assert_eq!(parsed.get("ok").and_then(Value::as_bool), Some(true));
    let normalized = parsed
        .get("normalizedArguments")
        .and_then(Value::as_str)
        .expect("normalizedArguments");
    let normalized_value: Value = serde_json::from_str(normalized).unwrap();
    let patch = normalized_value
        .get("patch")
        .and_then(Value::as_str)
        .unwrap_or_default();
    assert!(patch.contains("*** Begin Patch"));
    assert!(patch.contains("*** Add File: escaped.txt"));
    assert!(patch.contains("\n*** End Patch"));
}

#[test]
fn test_validate_apply_patch_arguments_repairs_line_number_hunk_with_inline_context_trailer() {
    let raw = json!({
        "arguments": {
            "patch": "*** Begin Patch\n*** Update File: /Users/fanzhang/Documents/github/routecodex/sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/lib.rs\n@@ -94,6 +94,7 @@ mod shared_tool_mapping;\n mod shared_tooling;\n+mod primary_exhausted_to_default_pool_blocks;\n mod snapshot_tool_failures;\n mod stop_message_auto_blocks;\n*** End Patch"
        }
    });
    let out = validate_apply_patch_arguments_json(raw.to_string()).unwrap();
    let parsed: Value = serde_json::from_str(out.as_str()).unwrap();
    assert_eq!(parsed.get("ok").and_then(Value::as_bool), Some(true));
    let normalized = parsed
        .get("normalizedArguments")
        .and_then(Value::as_str)
        .expect("normalizedArguments");
    let normalized_value: Value = serde_json::from_str(normalized).unwrap();
    let patch = normalized_value
        .get("patch")
        .and_then(Value::as_str)
        .unwrap_or_default();
    assert!(patch.contains("*** Update File: "));
    assert!(patch.ends_with("*** End Patch"));
    assert!(patch.contains("src/lib.rs"));
    assert!(!patch.contains("@@ -94,6 +94,7 @@"));
    assert!(patch.contains("@@\n mod shared_tool_mapping;\n mod shared_tooling;\n+mod primary_exhausted_to_default_pool_blocks;"));
}

#[test]
fn test_validate_apply_patch_arguments_classifies_structured_missing_changes() {
    let raw = json!({
        "arguments": {
            "background": "getStatusColor(agent.status)",
            "onClick": "{() => onSelectAgent?.(agent.id)}"
        }
    });
    let out = validate_apply_patch_arguments_json(raw.to_string()).unwrap();
    let parsed: Value = serde_json::from_str(out.as_str()).unwrap();
    assert_eq!(parsed.get("ok").and_then(Value::as_bool), Some(false));
    assert_eq!(
        parsed.get("reason").and_then(Value::as_str),
        Some("missing_changes")
    );
}

#[test]
fn test_validate_apply_patch_arguments_classifies_structured_missing_field() {
    let raw = json!({
        "arguments": {
            "file": "sample.txt",
            "changes": [{"kind": "replace", "lines": ["new"]}]
        }
    });
    let out = validate_apply_patch_arguments_json(raw.to_string()).unwrap();
    let parsed: Value = serde_json::from_str(out.as_str()).unwrap();
    assert_eq!(parsed.get("ok").and_then(Value::as_bool), Some(false));
    assert_eq!(
        parsed.get("reason").and_then(Value::as_str),
        Some("missing_field")
    );
}

#[test]
fn test_validate_apply_patch_arguments_classifies_structured_invalid_lines() {
    let raw = json!({
        "arguments": {
            "file": "sample.txt",
            "changes": [{"kind": "replace", "target": "old"}]
        }
    });
    let out = validate_apply_patch_arguments_json(raw.to_string()).unwrap();
    let parsed: Value = serde_json::from_str(out.as_str()).unwrap();
    assert_eq!(parsed.get("ok").and_then(Value::as_bool), Some(false));
    assert_eq!(
        parsed.get("reason").and_then(Value::as_str),
        Some("invalid_lines")
    );
}

#[test]
fn test_validate_apply_patch_arguments_repairs_arg_key_invalid_json_artifact() {
    let raw = json!({
        "arguments": "{\"file\":\"a.ts\",\"changes\":[{\"kind\":\"create_file\",\"lines\":[\"x\"],\"file</arg_key><arg_value>a.ts\"}]}"
    });
    let out = validate_apply_patch_arguments_json(raw.to_string()).unwrap();
    let parsed: Value = serde_json::from_str(out.as_str()).unwrap();
    assert_eq!(parsed.get("ok").and_then(Value::as_bool), Some(true));
    let normalized = parsed
        .get("normalizedArguments")
        .and_then(Value::as_str)
        .expect("normalizedArguments");
    let normalized_value: Value = serde_json::from_str(normalized).unwrap();
    let patch = normalized_value
        .get("patch")
        .and_then(Value::as_str)
        .unwrap_or_default();
    assert!(patch.contains("*** Add File: a.ts"));
    assert!(patch.contains("+x"));
}

#[test]
fn test_validate_apply_patch_arguments_syncs_patch_and_input_after_arg_key_artifact_repair() {
    let patch_text = "*** Begin Patch\n*** Delete File: .apply_patch_escape_test.txt\n*** End Patch";
    let injected = format!(
        "{patch_text}</arg_key><arg_value>input</arg_key><arg_value>{patch_text}"
    );
    let raw = json!({
        "arguments": {
            "patch": injected
        }
    });
    let out = validate_apply_patch_arguments_json(raw.to_string()).unwrap();
    let parsed: Value = serde_json::from_str(out.as_str()).unwrap();
    assert_eq!(parsed.get("ok").and_then(Value::as_bool), Some(true));
    let normalized = parsed
        .get("normalizedArguments")
        .and_then(Value::as_str)
        .expect("normalizedArguments");
    let normalized_value: Value = serde_json::from_str(normalized).unwrap();
    let patch = normalized_value
        .get("patch")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let input = normalized_value
        .get("input")
        .and_then(Value::as_str)
        .unwrap_or_default();
    assert_eq!(patch, patch_text);
    assert_eq!(input, patch_text);
    assert!(!patch.contains("</arg_key><arg_value>"));
}

#[test]
fn test_validate_apply_patch_arguments_unrecoverable_arg_key_invalid_json_stays_invalid_json() {
    let raw = json!({
        "arguments": "{\"file\":\"a.ts\",\"changes\":[{\"kind\":\"create_file\",\"lines\":[\"x\"],\"file</arg_key><arg_value>a.ts}]}"
    });
    let out = validate_apply_patch_arguments_json(raw.to_string()).unwrap();
    let parsed: Value = serde_json::from_str(out.as_str()).unwrap();
    assert_eq!(parsed.get("ok").and_then(Value::as_bool), Some(false));
    assert_eq!(
        parsed.get("reason").and_then(Value::as_str),
        Some("invalid_json")
    );
}

#[test]
#[ignore = "diagnostic replay against local /Volumes error samples"]
fn test_validate_apply_patch_arguments_replay_latest_20260516_samples() {
    let base = std::path::Path::new("/Volumes/extension/.rcc/errorsamples/apply-patch-regression");
    if !base.exists() {
        eprintln!("skip sample replay: {} not found", base.display());
        return;
    }
    let mut total = 0usize;
    let mut failed = 0usize;
    for entry in std::fs::read_dir(base).expect("read sample dir").flatten() {
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) != Some("json") {
            continue;
        }
        let raw = match std::fs::read_to_string(&path) {
            Ok(v) => v,
            Err(_) => continue,
        };
        let sample: Value = match serde_json::from_str(&raw) {
            Ok(v) => v,
            Err(_) => continue,
        };
        let ts = sample
            .get("timestamp")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if !ts.starts_with("2026-05-16") {
            continue;
        }
        total += 1;
        let args_text = sample
            .get("originalArgs")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let args: Value = serde_json::from_str(args_text)
            .unwrap_or_else(|_| Value::String(args_text.to_string()));
        let input = json!({ "arguments": args });
        let out = validate_apply_patch_arguments_json(input.to_string()).unwrap();
        let parsed: Value = serde_json::from_str(&out).unwrap();
        let ok = parsed.get("ok").and_then(Value::as_bool).unwrap_or(false);
        if !ok {
            failed += 1;
            eprintln!(
                "sample not repaired: {} reason={}",
                path.display(),
                parsed
                    .get("reason")
                    .and_then(Value::as_str)
                    .unwrap_or("unknown")
            );
        }
    }
    eprintln!("sample replay summary: total={total} failed={failed}");
    assert!(total > 0);
}

#[test]
fn test_normalize_tool_args_write_stdin_number_and_input() {
    let raw_args = json!({"session_id": 7, "input": "abc"});
    let out = normalize_tool_args("write_stdin", Some(&raw_args)).unwrap();
    let parsed: Value = serde_json::from_str(&out).unwrap();
    assert_eq!(parsed["session_id"], 7);
    assert_eq!(parsed["chars"], "abc");

    let raw_args = json!({"session_id": true});
    assert!(normalize_tool_args("write_stdin", Some(&raw_args)).is_none());
}

#[test]
fn test_normalize_tool_args_shell_input_command() {
    let raw_args = json!({"input": {"command": "pwd"}});
    let out = normalize_tool_args("shell", Some(&raw_args)).unwrap();
    let parsed: Value = serde_json::from_str(&out).unwrap();
    assert_eq!(parsed["command"], "pwd");
    assert!(parsed.get("cmd").is_none());
    assert_eq!(parsed.as_object().map(|row| row.len()), Some(1));
}

#[test]
fn test_normalize_tool_args_exec_command_input_string_shape() {
    let raw_args = json!({"input": "git status"});
    let out = normalize_tool_args("exec_command", Some(&raw_args)).unwrap();
    let parsed: Value = serde_json::from_str(&out).unwrap();
    assert_eq!(parsed["cmd"], "git status");
    assert_eq!(parsed.as_object().map(|row| row.len()), Some(1));
}

#[test]
fn test_normalize_tool_args_exec_command_nested_args_command_shape() {
    let raw_args = json!({"args": {"command": "ls -la"}, "cwd": "/workspace"});
    let out = normalize_tool_args("exec_command", Some(&raw_args)).unwrap();
    let parsed: Value = serde_json::from_str(&out).unwrap();
    assert_eq!(parsed["command"], "ls -la");
    assert!(parsed.get("cmd").is_none());
    assert_eq!(parsed["workdir"], "/workspace");
}

#[test]
fn test_normalize_tool_args_exec_command_preserves_supported_shell_fields() {
    let raw_args = json!({
        "command": "pwd",
        "workdir": "/workspace",
        "yield_time_ms": 30000,
        "tty": true,
        "login": false,
        "max_output_tokens": 2048,
        "justification": "inspect repo"
    });
    let out = normalize_tool_args("execute_command", Some(&raw_args)).unwrap();
    let parsed: Value = serde_json::from_str(&out).unwrap();
    assert_eq!(parsed["command"], "pwd");
    assert!(parsed.get("cmd").is_none());
    assert_eq!(parsed["workdir"], "/workspace");
    assert_eq!(parsed["yield_time_ms"], 30000);
    assert_eq!(parsed["tty"], true);
    assert_eq!(parsed["login"], false);
    assert_eq!(parsed["max_output_tokens"], 2048);
    assert_eq!(parsed["justification"], "inspect repo");
}

#[test]
fn test_normalize_tool_args_exec_command_preserves_raw_shell_text() {
    let raw_args = json!({
        "cmd": "catdocs/design/project-dispatch-operation-architecture.md",
        "workdir": "/workspace"
    });
    let out = normalize_tool_args("exec_command", Some(&raw_args)).unwrap();
    let parsed: Value = serde_json::from_str(&out).unwrap();
    assert_eq!(
        parsed["cmd"],
        "catdocs/design/project-dispatch-operation-architecture.md"
    );

    let raw_args = json!({
        "cmd": "ls -la /Volumes/extension/code/finger/docs/design/project-dispatch-operation-architecture.md2>&1 &&head -200 /Volumes/extension/code/finger/docs/design/project-dispatch-operation-architecture.md"
    });
    let out = normalize_tool_args("exec_command", Some(&raw_args)).unwrap();
    let parsed: Value = serde_json::from_str(&out).unwrap();
    assert_eq!(
        parsed["cmd"],
        "ls -la /Volumes/extension/code/finger/docs/design/project-dispatch-operation-architecture.md2>&1 &&head -200 /Volumes/extension/code/finger/docs/design/project-dispatch-operation-architecture.md"
    );
}

#[test]
fn test_normalize_tool_args_exec_command_preserves_find_predicates() {
    let raw_args = json!({
        "cmd": "bash -lc 'cd /Volumes/extension/code/wterm && find . -type f ( -name \"*.ts\" -o -name \"*.tsx\" -o -name \"*.js\" -o -name \"*.jsx\" -o -name \"*.json\" ) -not -path \"./node_modules/*\" -not -path \"./.next/*\" -not -path \"./dist/*\" | head -100'"
    });
    let out = normalize_tool_args("exec_command", Some(&raw_args)).unwrap();
    let parsed: Value = serde_json::from_str(&out).unwrap();
    let cmd = parsed["cmd"].as_str().unwrap_or("");
    assert!(cmd.contains("find . -type f ("));
    assert!(cmd.contains("-o -name \"*.json\""));
    assert!(cmd.contains(") -not -path"));
}

#[test]
fn test_normalize_tool_args_preserving_raw_shape_preserves_find_predicates() {
    let raw_args = json!({
        "command": "bash -lc 'cd /Volumes/extension/code/wterm && find . -type f ( -name \"*.ts\" -o -name \"*.tsx\" -o -name \"*.js\" -o -name \"*.jsx\" -o -name \"*.json\" ) -not -path \"./node_modules/*\" | head -100'",
        "workdir": "/Volumes/extension/code/wterm"
    });
    let out = normalize_tool_args_preserving_raw_shape("exec_command", Some(&raw_args)).unwrap();
    let parsed: Value = serde_json::from_str(&out).unwrap();
    let cmd = parsed["command"].as_str().unwrap_or("");
    assert!(cmd.contains("find . -type f ("));
    assert!(cmd.contains("-o -name \"*.json\""));
    assert!(cmd.contains(") -not -path"));
    assert_eq!(parsed["workdir"], "/Volumes/extension/code/wterm");
}

#[test]
fn test_normalize_tool_args_exec_command_preserves_find_exec_separator() {
    let raw_args = json!({
        "cmd": "bash -lc 'find . -type f -name \"*.ts\" -exec sed -n \"1,3p\" {} ; | head -5'"
    });
    let out = normalize_tool_args("exec_command", Some(&raw_args)).unwrap();
    let parsed: Value = serde_json::from_str(&out).unwrap();
    let cmd = parsed["cmd"].as_str().unwrap_or("");
    assert!(cmd.contains("-exec sed -n \"1,3p\" {} ;"));
}

#[test]
fn test_normalize_tool_args_preserving_raw_shape_preserves_find_exec_separator() {
    let raw_args = json!({
        "command": "bash -lc 'find . -type f -name \"*.ts\" -exec sed -n \"1,3p\" {} ; | head -5'"
    });
    let out = normalize_tool_args_preserving_raw_shape("exec_command", Some(&raw_args)).unwrap();
    let parsed: Value = serde_json::from_str(&out).unwrap();
    let cmd = parsed["command"].as_str().unwrap_or("");
    assert!(cmd.contains("-exec sed -n \"1,3p\" {} ;"));
    assert!(parsed.get("cmd").is_none());
}

#[test]
fn test_normalize_tool_args_preserving_raw_shape_preserves_nested_input_find_shell() {
    let raw_args = json!({
        "input": {
            "command": "bash -lc 'find . -type f ( -name \"*.ts\" -o -name \"*.tsx\" ) -exec sed -n \"1,3p\" {} ; | head -5'"
        },
        "workdir": "/workspace"
    });
    let out = normalize_tool_args_preserving_raw_shape("exec_command", Some(&raw_args)).unwrap();
    let parsed: Value = serde_json::from_str(&out).unwrap();
    let cmd = parsed["input"]["command"].as_str().unwrap_or("");
    assert!(cmd.contains("find . -type f ("));
    assert!(cmd.contains(") -exec sed -n \"1,3p\" {} ;"));
    assert_eq!(parsed["workdir"], "/workspace");
    assert!(parsed.get("cmd").is_none());
}

#[test]
fn test_normalize_tool_args_exec_command_does_not_repair_missing_outer_quote() {
    let raw_args = json!({
        "command": "bash -lc 'ls -la ~/.fin/runtime/projects/fin/'; echo \"---\"; cat ~/.fin/runtime/projects/fin/registry.json 2>/dev/null | jq \".[] | {project_id, presence_state, unfinished_task_count, active_session_id}\" | head -30"
    });
    let out = normalize_tool_args("exec_command", Some(&raw_args)).unwrap();
    let parsed: Value = serde_json::from_str(&out).unwrap();
    assert_eq!(
        parsed["command"],
        "bash -lc 'ls -la ~/.fin/runtime/projects/fin/'; echo \"---\"; cat ~/.fin/runtime/projects/fin/registry.json 2>/dev/null | jq \".[] | {project_id, presence_state, unfinished_task_count, active_session_id}\" | head -30"
    );
}

#[test]
fn test_normalize_tool_args_write_stdin_data_field() {
    let raw_args = json!({"sessionId": "42", "data": {"x": 1}});
    let out = normalize_tool_args("write_stdin", Some(&raw_args)).unwrap();
    let parsed: Value = serde_json::from_str(&out).unwrap();
    assert_eq!(parsed["session_id"], 42);
    assert_eq!(parsed["chars"], "{\"x\":1}");
}

#[test]
fn test_normalize_tool_call_entry_input_and_missing_args() {
    let entry = json!({"function": {"name": "exec_command", "input": {"command": "pwd"}}});
    let out = normalize_tool_call_entry(&entry, 1).unwrap();
    assert_eq!(out["function"]["name"], "exec_command");

    let entry = json!({"function": {"name": "exec_command", "arguments": {"command": "pwd"}}});
    let out = normalize_tool_call_entry(&entry, 1).unwrap();
    let args = out["function"]["arguments"].as_str().unwrap_or("{}");
    let parsed: Value = serde_json::from_str(args).unwrap_or(Value::Null);
    assert_eq!(parsed["command"], "pwd");
    assert!(parsed.get("cmd").is_none());

    let entry = json!({"function": {"name": "exec_command", "arguments": {}}});
    assert!(normalize_tool_call_entry(&entry, 1).is_none());

    let entry = Value::String("not an object".to_string());
    assert!(normalize_tool_call_entry(&entry, 1).is_none());
}

#[test]
fn test_normalize_tool_call_entry_hoists_nested_wrapper_metadata_from_arguments_only_shape() {
    let entry = json!({
        "arguments": {
            "cmd": "bash -lc 'grep -n -A 20 '\\\"running\\\" =>' /Users/fanzhang/Documents/github/fin/rust/crates/runtime/src/scheduler.rs'",
            "id": "call_1",
            "name": "exec_command"
        }
    });
    let out = normalize_tool_call_entry(&entry, 1).unwrap();
    assert_eq!(out["id"], "call_1");
    assert_eq!(out["function"]["name"], "exec_command");
    let args: Value = serde_json::from_str(out["function"]["arguments"].as_str().unwrap_or("{}"))
        .unwrap_or(Value::Null);
    assert_eq!(
        args["cmd"],
        "bash -lc 'grep -n -A 20 '\\\"running\\\" =>' /Users/fanzhang/Documents/github/fin/rust/crates/runtime/src/scheduler.rs'"
    );
    assert!(args.get("id").is_none());
    assert!(args.get("name").is_none());
}

#[test]
fn test_normalize_tool_call_entry_request_user_input_shape() {
    let entry = json!({
        "name": "request_user_input",
        "input": {
            "questions": [{
                "header": "Mode",
                "id": "mode",
                "question": "Pick one",
                "options": [
                    {"label": "A", "description": "use mode A"},
                    {"label": "B", "description": "use mode B"}
                ]
            }]
        }
    });
    let out = normalize_tool_call_entry(&entry, 1).unwrap();
    assert_eq!(out["function"]["name"], "request_user_input");
    let args = out["function"]["arguments"].as_str().unwrap_or("{}");
    let parsed: Value = serde_json::from_str(args).unwrap_or(Value::Null);
    assert_eq!(parsed["questions"][0]["id"], "mode");
}

#[test]
fn test_normalize_tool_call_entry_infers_update_plan_from_root_shape_without_name() {
    let entry = json!({
        "explanation": "修复 scheduler 决策逻辑",
        "plan": [
            {"status": "in_progress", "step": "修改 running 分支"},
            {"status": "pending", "step": "编译并测试"}
        ]
    });
    let out = normalize_tool_call_entry(&entry, 1).unwrap();
    assert_eq!(out["function"]["name"], "update_plan");
    let args: Value = serde_json::from_str(out["function"]["arguments"].as_str().unwrap_or("{}"))
        .unwrap_or(Value::Null);
    assert_eq!(args["explanation"], "修复 scheduler 决策逻辑");
    assert_eq!(args["plan"][0]["step"], "修改 running 分支");
    assert_eq!(args["plan"][0]["status"], "in_progress");
    assert_eq!(args["plan"][1]["step"], "编译并测试");
}

#[test]
fn test_extract_tool_call_entries_from_unknown_non_object() {
    let value = Value::String("oops".to_string());
    assert!(extract_tool_call_entries_from_unknown(&value).is_empty());
}

#[test]
fn test_extract_tool_call_entries_from_unknown_object() {
    let value = json!({"name": "exec_command", "arguments": {"command": "pwd"}});
    let out = extract_tool_call_entries_from_unknown(&value);
    assert_eq!(out.len(), 1);
    assert_eq!(out[0]["function"]["name"], "exec_command");
}

#[test]
fn test_extract_tool_call_entries_from_unknown_preserves_explicit_execute_command_alias() {
    let value = json!({
        "tool_calls": [{
            "name": "execute_command",
            "input": {
                "cmd": "bash -lc 'pwd'",
                "workdir": "/workspace",
                "yield_time_ms": 300
            }
        }]
    });
    let out = extract_tool_call_entries_from_unknown(&value);
    assert_eq!(out.len(), 1);
    assert_eq!(out[0]["function"]["name"], "exec_command");
    let args: Value =
        serde_json::from_str(out[0]["function"]["arguments"].as_str().unwrap_or("{}"))
            .unwrap_or(Value::Null);
    assert_eq!(args["cmd"], "bash -lc 'pwd'");
    assert_eq!(args["workdir"], "/workspace");
    assert_eq!(args["yield_time_ms"], 300);
}

#[test]
fn test_extract_tool_call_entries_from_unknown_does_not_infer_apply_patch_without_name() {
    let value = json!({
        "tool_calls": [{
            "input": {
                "command": "apply_patch *** Begin Patch\n*** Add File: hello.txt\n+hello\n*** End Patch"
            }
        }]
    });
    let out = extract_tool_call_entries_from_unknown(&value);
    assert!(out.is_empty());
}

#[test]
fn test_extract_tool_call_entries_from_unknown_request_user_input() {
    let value = json!({
        "tool_calls": [{
            "name": "request_user_input",
            "input": {
                "questions": [{
                    "header": "Mode",
                    "id": "mode",
                    "question": "Pick one",
                    "options": [
                        {"label": "A", "description": "use mode A"},
                        {"label": "B", "description": "use mode B"}
                    ]
                }]
            }
        }]
    });
    let out = extract_tool_call_entries_from_unknown(&value);
    assert_eq!(out.len(), 1);
    assert_eq!(out[0]["function"]["name"], "request_user_input");
}

#[test]
fn test_extract_xml_tool_call_blocks_exec_command() {
    let text = r#"
我来审查这些文件。
<tool_call>
{"name":"exec_command","input":{"cmd":"cat a.ts","workdir":"/tmp"}}
</tool_call>
<tool_call>
{"name":"exec_command","input":{"cmd":"cat b.ts","workdir":"/tmp"}}
</tool_call>
"#;
    let out = extract_xml_tool_call_blocks(text, 1);
    assert_eq!(out.len(), 2);
    assert_eq!(out[0]["function"]["name"], "exec_command");
    let args0: Value =
        serde_json::from_str(out[0]["function"]["arguments"].as_str().unwrap_or("{}"))
            .unwrap_or(Value::Null);
    assert_eq!(args0["cmd"], "cat a.ts");
    assert_eq!(args0["workdir"], "/tmp");
}

#[test]
fn test_extract_xml_tool_call_blocks_minimax_namespace_invoke() {
    let text = r#"
<minimax:tool_call>
<invoke name="exec_command">
<parameter name="cmd">cat note.md 2>/dev/null | sed -n '400,600p'</parameter>
</invoke>
</minimax:tool_call>
"#;
    let out = extract_xml_tool_call_blocks(text, 1);
    assert_eq!(out.len(), 1);
    assert_eq!(out[0]["function"]["name"], "exec_command");
    let args: Value =
        serde_json::from_str(out[0]["function"]["arguments"].as_str().unwrap_or("{}"))
            .unwrap_or(Value::Null);
    assert_eq!(args["cmd"], "cat note.md 2>/dev/null | sed -n '400,600p'");
}

#[test]
fn test_extract_xml_tool_call_blocks_repairs_extra_trailing_closer_inside_wrapper() {
    let text = r#"
<tool_call>
{"name":"exec_command","arguments":{"cmd":"bash -lc 'curl -s -o /dev/null -w \"%{http_code}\" http://127.0.0.1:4040/'"},"id":"check_webdebug","justification":"验证 fin web-debug 是否运行"}}
</tool_call>
"#;
    let out = extract_xml_tool_call_blocks(text, 1);
    assert_eq!(out.len(), 1);
    assert_eq!(out[0]["id"], "check_webdebug");
    assert_eq!(out[0]["function"]["name"], "exec_command");
    let args: Value =
        serde_json::from_str(out[0]["function"]["arguments"].as_str().unwrap_or("{}"))
            .unwrap_or(Value::Null);
    assert_eq!(
        args["cmd"],
        "bash -lc 'curl -s -o /dev/null -w \"%{http_code}\" http://127.0.0.1:4040/'"
    );
}

#[test]
fn test_extract_xml_tool_call_blocks_repairs_missing_trailing_closer_inside_wrapper() {
    let text = r#"
<tool_call>
{"name":"exec_command","arguments":{"cmd":"bash -lc 'echo \"=== 最终状态报告 ===\" && echo \"6. web-debug HTTP: $(curl -s -o /dev/null -w \"%{http_code}\" http://127.0.0.1:4040/)\"'"}
</tool_call>
"#;
    let out = extract_xml_tool_call_blocks(text, 1);
    assert_eq!(out.len(), 1);
    assert_eq!(out[0]["function"]["name"], "exec_command");
    let args: Value =
        serde_json::from_str(out[0]["function"]["arguments"].as_str().unwrap_or("{}"))
            .unwrap_or(Value::Null);
    assert_eq!(
        args["cmd"],
        "bash -lc 'echo \"=== 最终状态报告 ===\" && echo \"6. web-debug HTTP: $(curl -s -o /dev/null -w \"%{http_code}\" http://127.0.0.1:4040/)\"'"
    );
}

#[test]
fn test_extract_xml_tool_call_blocks_salvages_wrapper_attribute_name_without_guessing_args() {
    let text = r#"
<tool_call name="exec_command">
{"arguments":{"cmd":"bash -lc 'pwd'","justification":"check cwd"}}
</tool_call>
"#;
    let out = extract_xml_tool_call_blocks(text, 1);
    assert_eq!(out.len(), 1);
    assert_eq!(out[0]["function"]["name"], "exec_command");
    let args: Value =
        serde_json::from_str(out[0]["function"]["arguments"].as_str().unwrap_or("{}"))
            .unwrap_or(Value::Null);
    assert_eq!(args["cmd"], "bash -lc 'pwd'");
    assert_eq!(args["justification"], "check cwd");
}

#[test]
fn test_extract_xml_named_tool_call_blocks_execute_command_with_masked_args() {
    let text = r#"
先检查关键文件：
<execute_command>
<command>ls -la /Volumes/extension/code/finger/HEARTBEAT.md /Volumes/extension/code/finger/DELIVERY.md 2>&1</command>
<workdir>/Volumes/extension/code/finger</workdir>
</execute_command>
"#;
    let out = extract_xml_named_tool_call_blocks(text, 1);
    assert_eq!(out.len(), 1);
    assert_eq!(out[0]["function"]["name"], "exec_command");
    let args: Value =
        serde_json::from_str(out[0]["function"]["arguments"].as_str().unwrap_or("{}"))
            .unwrap_or(Value::Null);
    assert_eq!(
        args["command"],
        "ls -la /Volumes/extension/code/finger/HEARTBEAT.md /Volumes/extension/code/finger/DELIVERY.md 2>&1"
    );
    assert_eq!(args["workdir"], "/Volumes/extension/code/finger");
}

#[test]
fn test_extract_tool_prefixed_exec_command_block() {
    let text = r#"
tool:exec_command (tool:exec_command)
  <command>which flutter</command>
  <timeout_ms>10000</timeout_ms>
  </tool:exec_command>
"#;
    let entry = extract_tool_prefixed_exec_command_block(text, 1).unwrap();
    assert_eq!(entry["function"]["name"], "exec_command");
    let args: Value = serde_json::from_str(entry["function"]["arguments"].as_str().unwrap_or("{}"))
        .unwrap_or(Value::Null);
    assert_eq!(args["cmd"], "which flutter");
}

#[test]
fn test_extract_reasoning_inline_exec_command_arg_key() {
    let text = r#"exec_command<arg_key>cmd</arg_key><arg_value>pwd</arg_value></tool_call>"#;
    let entry = extract_reasoning_inline_exec_command_arg_key(text, 1).unwrap();
    assert_eq!(entry["function"]["name"], "exec_command");
    let args: Value = serde_json::from_str(entry["function"]["arguments"].as_str().unwrap_or("{}"))
        .unwrap_or(Value::Null);
    assert_eq!(args["cmd"], "pwd");
}

#[test]
fn test_extract_xml_named_tool_call_blocks_recovers_when_inner_tags_are_truncated() {
    let text = r#"
<execute_command>
<command>pwd
<workdir>/tmp</workdir>
</execute_command>
"#;
    let out = extract_xml_named_tool_call_blocks(text, 1);
    assert_eq!(out.len(), 1);
    assert_eq!(out[0]["function"]["name"], "exec_command");
    let args: Value =
        serde_json::from_str(out[0]["function"]["arguments"].as_str().unwrap_or("{}"))
            .unwrap_or(Value::Null);
    assert_eq!(args["command"], "pwd");
    assert_eq!(args["workdir"], "/tmp");
}

#[test]
fn test_extract_xml_named_tool_call_blocks_generic_command_wrapper_masks_nested_tags() {
    let text = r#"
<command>
  <grep_command>
  cd /Volumes/extension/code/finger && grep -n "agentRegistry\|registerAgent\|getAgent" src/orchestration/message-hub.ts | head -30
  </grep_command>
</command>
"#;
    let out = extract_xml_named_tool_call_blocks(text, 1);
    assert_eq!(out.len(), 1);
    assert_eq!(out[0]["function"]["name"], "exec_command");
    let args: Value =
        serde_json::from_str(out[0]["function"]["arguments"].as_str().unwrap_or("{}"))
            .unwrap_or(Value::Null);
    assert_eq!(
        args["command"],
        r#"cd /Volumes/extension/code/finger && grep -n "agentRegistry\|registerAgent\|getAgent" src/orchestration/message-hub.ts | head -30"#
    );
}

#[test]
fn test_extract_xml_named_tool_call_blocks_generic_command_wrapper_preserves_masked_args() {
    let text = r#"
<command>
  <grep_command>
  cd /Volumes/extension/code/finger && grep -n "resolveTargetModule\|moduleLookup" src/blocks/agent-runtime-block/index.ts | head -30
  </grep_command>
  <workdir>/Volumes/extension/code/finger</workdir>
  <yield_time_ms>30000</yield_time_ms>
</command>
"#;
    let out = extract_xml_named_tool_call_blocks(text, 1);
    assert_eq!(out.len(), 1);
    assert_eq!(out[0]["function"]["name"], "exec_command");
    let args: Value =
        serde_json::from_str(out[0]["function"]["arguments"].as_str().unwrap_or("{}"))
            .unwrap_or(Value::Null);
    assert_eq!(
        args["command"],
        r#"cd /Volumes/extension/code/finger && grep -n "resolveTargetModule\|moduleLookup" src/blocks/agent-runtime-block/index.ts | head -30"#
    );
    assert_eq!(args["workdir"], "/Volumes/extension/code/finger");
    assert_eq!(args["yield_time_ms"], 30000);
}

#[test]
fn test_extract_xml_named_tool_call_blocks_invoke_parameter_attribute_wrapper_inside_tool_calls() {
    let text = r#"<tool_calls>
<invoke name="exec_command">
<parameter name="cmd" string="true">tail -100 ~/.finger/logs/daemon.log | tail -20</parameter>
</invoke>
</tool_calls>"#;
    let out = extract_xml_named_tool_call_blocks(text, 1);
    assert_eq!(out.len(), 1);
    assert_eq!(out[0]["function"]["name"], "exec_command");
    let args: Value =
        serde_json::from_str(out[0]["function"]["arguments"].as_str().unwrap_or("{}"))
            .unwrap_or(Value::Null);
    assert_eq!(
        args["cmd"].as_str().unwrap_or(""),
        "tail -100 ~/.finger/logs/daemon.log | tail -20"
    );
}

#[test]
fn test_extract_xml_named_tool_call_blocks_dsml_parameter_cdata_wrapper() {
    let text = r#"<|DSML|tool_calls>
<|DSML|invoke name="exec_command">
<|DSML|parameter name="cmd"><![CDATA[bash -lc 'pwd']]></|DSML|parameter>
</|DSML|invoke>
</|DSML|tool_calls>"#;
    let out = extract_xml_named_tool_call_blocks(text, 1);
    assert_eq!(out.len(), 1);
    assert_eq!(out[0]["function"]["name"], "exec_command");
    let args: Value =
        serde_json::from_str(out[0]["function"]["arguments"].as_str().unwrap_or("{}"))
            .unwrap_or(Value::Null);
    assert_eq!(args["cmd"].as_str().unwrap_or(""), "bash -lc 'pwd'");
}

#[test]
fn test_unwrap_xml_cdata_sections_merges_split_segments() {
    let raw = "<![CDATA[bash -lc 'echo ]]]]><![CDATA[> ok']]>";
    assert_eq!(unwrap_xml_cdata_sections(raw), "bash -lc 'echo ]]> ok'");
}

#[test]
fn test_govern_response_rejects_function_style_tool_intent_without_whitelisted_wrapper() {
    let input = ToolGovernanceInput {
        payload: serde_json::json!({
            "choices": [{
                "message": {
                    "tool_calls": [],
                    "content": r#"exec_command(cmd="bash -lc'pwd'")"#
                },
                "finish_reason": "stop"
            }],
            "tools": [{
                "type": "function",
                "function": {
                    "name": "exec_command",
                    "parameters": {
                        "type": "object",
                        "properties": { "cmd": { "type": "string" } },
                        "required": ["cmd"]
                    }
                }
            }]
        }),
        client_protocol: "openai-chat".to_string(),
        entry_endpoint: "/v1/chat/completions".to_string(),
        request_id: "req_function_style_exec_command_harvest_1".to_string(),
    };

    let result = govern_response(input).unwrap();
    let message = &result.governed_payload["choices"][0]["message"];
    assert_eq!(result.summary.tool_calls_normalized, 0);
    assert_eq!(
        result.governed_payload["choices"][0]["finish_reason"],
        "stop"
    );
    assert!(message["tool_calls"]
        .as_array()
        .cloned()
        .unwrap_or_default()
        .is_empty());
    assert_eq!(message["content"], r#"exec_command(cmd="bash -lc'pwd'")"#);
}

#[test]
fn test_govern_response_rejects_tool_prefixed_function_style_without_whitelisted_wrapper() {
    let input = ToolGovernanceInput {
        payload: serde_json::json!({
            "choices": [{
                "message": {
                    "tool_calls": [],
                    "content": r#"```toolexec_command(command="head -n3 docs/ARCHITECTURE.md")```"#
                },
                "finish_reason": "stop"
            }],
            "tools": [{
                "type": "function",
                "function": {
                    "name": "exec_command",
                    "parameters": {
                        "type": "object",
                        "properties": { "cmd": { "type": "string" } },
                        "required": ["cmd"]
                    }
                }
            }]
        }),
        client_protocol: "openai-chat".to_string(),
        entry_endpoint: "/v1/chat/completions".to_string(),
        request_id: "req_function_style_exec_command_tool_prefixed".to_string(),
    };

    let result = govern_response(input).unwrap();
    let message = &result.governed_payload["choices"][0]["message"];
    assert_eq!(result.summary.tool_calls_normalized, 0);
    assert_eq!(
        result.governed_payload["choices"][0]["finish_reason"],
        "stop"
    );
    assert!(message["tool_calls"]
        .as_array()
        .cloned()
        .unwrap_or_default()
        .is_empty());
    assert_eq!(
        message["content"],
        r#"```toolexec_command(command="head -n3 docs/ARCHITECTURE.md")```"#
    );
}

#[test]
fn test_normalize_tool_args_update_plan_steps_alias() {
    let normalized = normalize_tool_args(
        "update_plan",
        Some(&serde_json::json!({
            "steps": [
                {"name": "inspect", "status": "in_progress"},
                {"name": "report", "status": "pending"}
            ]
        })),
    )
    .unwrap_or_default();
    let args: Value = serde_json::from_str(normalized.as_str()).unwrap_or(Value::Null);
    assert_eq!(args["plan"][0]["step"], "inspect");
    assert_eq!(args["plan"][0]["status"], "in_progress");
    assert_eq!(args["plan"][1]["step"], "report");
    assert_eq!(args["plan"][1]["status"], "pending");
}

#[test]
fn test_harvest_text_tool_calls_preserves_real_failed_compact_exec_commands() {
    let mut payload = json!({
        "choices": [{
            "message": {
                "tool_calls": [],
                "content": "{\"tool_calls\":[\
                        {\"name\":\"exec_command\",\"input\":{\"cmd\":\"catdocs/design/project-dispatch-operation-architecture.md\"}},\
                        {\"name\":\"exec_command\",\"input\":{\"cmd\":\"ls -la /Volumes/extension/code/finger/docs/design/project-dispatch-operation-architecture.md2>&1 &&head -200 /Volumes/extension/code/finger/docs/design/project-dispatch-operation-architecture.md\"}}\
                    ]}"
            },
            "finish_reason": "stop"
        }]
    });
    assert_eq!(harvest_text_tool_calls_from_payload(&mut payload), 2);
    let tool_calls = payload["choices"][0]["message"]["tool_calls"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    assert_eq!(tool_calls.len(), 2);

    let args0: Value = serde_json::from_str(
        tool_calls[0]["function"]["arguments"]
            .as_str()
            .unwrap_or("{}"),
    )
    .unwrap_or(Value::Null);
    assert_eq!(
        args0["cmd"],
        "catdocs/design/project-dispatch-operation-architecture.md"
    );
    assert!(args0.get("workdir").is_none());

    let args1: Value = serde_json::from_str(
        tool_calls[1]["function"]["arguments"]
            .as_str()
            .unwrap_or("{}"),
    )
    .unwrap_or(Value::Null);
    assert_eq!(
        args1["cmd"],
        "ls -la /Volumes/extension/code/finger/docs/design/project-dispatch-operation-architecture.md2>&1 &&head -200 /Volumes/extension/code/finger/docs/design/project-dispatch-operation-architecture.md"
    );
    assert_eq!(payload["choices"][0]["finish_reason"], "tool_calls");
}

#[test]
fn test_normalize_tool_args_preserving_raw_shape_keeps_single_exec_command_alias_shape() {
    let raw_args = json!({"command":"bd --no-db ready"});
    let normalized =
        normalize_tool_args_preserving_raw_shape("shell_command", Some(&raw_args)).unwrap();
    let parsed: Value = serde_json::from_str(&normalized).unwrap_or(Value::Null);
    assert_eq!(parsed["command"], "bd --no-db ready");
    assert!(parsed.get("cmd").is_none());

    let raw_args = json!({"cmd":"echo hello"});
    let normalized =
        normalize_tool_args_preserving_raw_shape("exec_command", Some(&raw_args)).unwrap();
    let parsed: Value = serde_json::from_str(&normalized).unwrap_or(Value::Null);
    assert_eq!(parsed["cmd"], "echo hello");
    assert!(parsed.get("command").is_none());
}

#[test]
fn test_normalize_tool_args_preserving_raw_shape_exec_command_keeps_nested_command_only_shape() {
    let raw_args = json!({
        "input": {
            "command": "bash -lc 'pwd'"
        },
        "workdir": "/workspace"
    });
    let normalized =
        normalize_tool_args_preserving_raw_shape("exec_command", Some(&raw_args)).unwrap();
    let parsed: Value = serde_json::from_str(&normalized).unwrap_or(Value::Null);
    assert_eq!(parsed["input"]["command"], "bash -lc 'pwd'");
    assert!(parsed.get("cmd").is_none());
    assert!(parsed.get("command").is_none());
    assert_eq!(parsed["workdir"], "/workspace");
}

#[test]
fn test_harvest_tool_calls_from_xml_named_tool_blocks() {
    let input = ToolGovernanceInput {
        payload: serde_json::json!({
            "__rcc_tool_governance": {
                "enableTextHarvest": true,
            },
            "choices": [{
                "message": {
                    "tool_calls": [],
                    "content": "现在我需要查看关键的项目管理文件。\n让我先检查项目根目录是否有 HEARTBEAT.md 和 DELIVERY.md：\n\n<execute_command>\n<command>ls -la /Volumes/extension/code/finger/HEARTBEAT.md /Volumes/extension/code/finger/DELIVERY.md /Volumes/extension/code/finger/MEMORY.md /Volumes/extension/code/finger/CACHE.md 2>&1</command>\n<workdir>/Volumes/extension/code/finger</workdir>\n</execute_command>"
                },
                "finish_reason": "stop"
            }]
        }),
        client_protocol: "openai-chat".to_string(),
        entry_endpoint: "/v1/responses".to_string(),
        request_id: "req_xml_named_tool_harvest_1".to_string(),
    };

    let result = govern_response(input).unwrap();
    let message = &result.governed_payload["choices"][0]["message"];
    assert_eq!(result.summary.tool_calls_normalized, 1);
    assert_eq!(
        result.governed_payload["choices"][0]["finish_reason"],
        "tool_calls"
    );
    assert_eq!(message["tool_calls"][0]["function"]["name"], "exec_command");
    let args: Value = serde_json::from_str(
        message["tool_calls"][0]["function"]["arguments"]
            .as_str()
            .unwrap_or("{}"),
    )
    .unwrap_or(Value::Null);
    assert_eq!(
        args["command"],
        "ls -la /Volumes/extension/code/finger/HEARTBEAT.md /Volumes/extension/code/finger/DELIVERY.md /Volumes/extension/code/finger/MEMORY.md /Volumes/extension/code/finger/CACHE.md 2>&1"
    );
    assert_eq!(args["workdir"], "/Volumes/extension/code/finger");
    let content = message["content"].as_str().unwrap_or("");
    assert!(content.contains("现在我需要查看关键的项目管理文件"));
    assert!(!content.contains("<execute_command>"));
}

#[test]
fn test_harvest_tool_calls_from_xml_invoke_parameter_attribute_blocks() {
    let input = ToolGovernanceInput {
        payload: serde_json::json!({
            "__rcc_tool_governance": {
                "enableTextHarvest": true,
            },
            "choices": [{
                "message": {
                    "tool_calls": [],
                    "content": "我先检查 dispatch 日志。\n<tool_calls>\n<invoke name=\"exec_command\">\n<parameter name=\"cmd\" string=\"true\">tail -100 ~/.finger/logs/daemon.log | grep -E \"finger-system-agent.*complete|finger-project-agent.*complete|dispatch.*complete\" | tail -20</parameter>\n</invoke>\n</tool_calls>"
                },
                "finish_reason": "stop"
            }]
        }),
        client_protocol: "openai-chat".to_string(),
        entry_endpoint: "/v1/responses".to_string(),
        request_id: "req_xml_invoke_attr_harvest_1".to_string(),
    };

    let result = govern_response(input).unwrap();
    let message = &result.governed_payload["choices"][0]["message"];
    assert_eq!(result.summary.tool_calls_normalized, 1);
    assert_eq!(
        result.governed_payload["choices"][0]["finish_reason"],
        "tool_calls"
    );
    assert_eq!(message["tool_calls"][0]["function"]["name"], "exec_command");
    let args: Value = serde_json::from_str(
        message["tool_calls"][0]["function"]["arguments"]
            .as_str()
            .unwrap_or("{}"),
    )
    .unwrap_or(Value::Null);
    assert_eq!(
        args["cmd"],
        "tail -100 ~/.finger/logs/daemon.log | grep -E \"finger-system-agent.*complete|finger-project-agent.*complete|dispatch.*complete\" | tail -20"
    );
    let content = message["content"].as_str().unwrap_or("");
    assert!(content.contains("我先检查 dispatch 日志"));
    assert!(!content.contains("<tool_calls>"));
    assert!(!content.contains("<invoke name=\"exec_command\">"));
    assert!(!content.contains("<parameter name=\"cmd\""));
}

#[test]
fn test_extract_json_candidates_unclosed_fence() {
    let text = "```json\n{\"a\":1}\n";
    let out = extract_json_candidates_from_text(text);
    assert!(out.is_empty());
}

#[test]
fn test_collect_harvest_text_variants_masks_wrapper_lines_and_bullet_prefix() {
    let text = "• <<RCC_TOOL_CALLS_JSON\n{\"tool_calls\":[{\"name\":\"apply_patch\",\"input\":{\"patch\":\"*** Begin Patch\\n*** Add File: demo.txt\\n+hi\\n*** End Patch\"}}]}\nRCC_TOOL_CALLS_JSON";
    let variants = collect_harvest_text_variants(text);
    assert!(!variants.is_empty());
    assert!(variants
        .iter()
        .any(|item| item.contains("\"tool_calls\"") && !item.contains("<<RCC_TOOL_CALLS_JSON")));
}

#[test]
fn test_harvest_text_tool_calls_recovers_bullet_prefixed_apply_patch_json_wrapper() {
    let mut payload = json!({
        "__rcc_tool_governance": {
            "enableTextHarvest": true,
            "requestedToolNames": ["apply_patch"]
        },
        "tools": [{
            "type": "function",
            "function": {
                "name": "apply_patch"
            }
        }],
        "choices": [{
            "message": {
                "tool_calls": [],
                "content": r#"• {"tool_calls":[{"name":"apply_patch","input":{"patch":"*** Begin Patch
*** Add File: demo.txt
+hi
*** End Patch"}}]}"#
            },
            "finish_reason": "stop"
        }]
    });
    assert_eq!(harvest_text_tool_calls_from_payload(&mut payload), 1);
    let tool_calls = payload["choices"][0]["message"]["tool_calls"]
        .as_array()
        .unwrap();
    assert_eq!(tool_calls[0]["function"]["name"], "apply_patch");
    let args: Value = serde_json::from_str(
        tool_calls[0]["function"]["arguments"]
            .as_str()
            .expect("arguments text"),
    )
    .expect("arguments json");
    assert_eq!(
        args["patch"].as_str().unwrap(),
        "*** Begin Patch\n*** Add File: demo.txt\n+hi\n*** End Patch"
    );
}

#[test]
fn test_harvest_text_tool_calls_recovers_noisy_exec_command_json_wrapper_with_trailing_status() {
    let mut payload = json!({
        "__rcc_tool_governance": {
            "enableTextHarvest": true,
            "requestedToolNames": ["exec_command"]
        },
        "choices": [{
            "message": {
                "tool_calls": [],
                "content": "⏺ {\"tool_calls\":[{\"name\":\"shell_command\",\"input\":{\"command\":\"bd --no-db ready\"}},{\"name\":\"shell_command\",\"input\":{\"command\":\"bd --no-db list --status in_progress\"}}]}\n\n✻ Baked for 41s"
            },
            "finish_reason": "stop"
        }]
    });
    assert_eq!(harvest_text_tool_calls_from_payload(&mut payload), 2);
    let tool_calls = payload["choices"][0]["message"]["tool_calls"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    assert_eq!(tool_calls.len(), 2);
    assert_eq!(tool_calls[0]["function"]["name"], "exec_command");
    assert_eq!(tool_calls[1]["function"]["name"], "exec_command");
    let args0: Value = serde_json::from_str(
        tool_calls[0]["function"]["arguments"]
            .as_str()
            .unwrap_or("{}"),
    )
    .unwrap_or(Value::Null);
    let args1: Value = serde_json::from_str(
        tool_calls[1]["function"]["arguments"]
            .as_str()
            .unwrap_or("{}"),
    )
    .unwrap_or(Value::Null);
    assert_eq!(args0["command"], "bd --no-db ready");
    assert_eq!(args1["command"], "bd --no-db list --status in_progress");
}

#[test]
fn test_harvest_text_tool_calls_recovers_escaped_exec_command_transcript_with_trailing_text() {
    let mut payload = json!({
        "__rcc_tool_governance": {
            "enableTextHarvest": true,
            "requestedToolNames": ["exec_command"]
        },
        "choices": [{
            "message": {
                "tool_calls": [],
                "content": "{\\\"tool_calls\\\":[{\\\"name\\\":\\\"exec_command\\\",\\\"input\\\":{\\\"cmd\\\":\\\"npm run build:dev\\\",\\\"workdir\\\":\\\"/Users/fanzhang/Documents/github/routecodex\\\"}}]}<｜User｜>> routecodex@0.89.2125 build:dev<｜Assistant｜>继续执行"
            },
            "finish_reason": "stop"
        }]
    });
    assert_eq!(harvest_text_tool_calls_from_payload(&mut payload), 1);
    let call = &payload["choices"][0]["message"]["tool_calls"][0];
    assert_eq!(call["function"]["name"], "exec_command");
    let args: Value = serde_json::from_str(call["function"]["arguments"].as_str().unwrap_or("{}"))
        .unwrap_or(Value::Null);
    assert_eq!(args["cmd"], "npm run build:dev");
    assert_eq!(
        args["workdir"],
        "/Users/fanzhang/Documents/github/routecodex"
    );
}

#[test]
fn test_harvest_text_tool_calls_recovers_trailing_exec_command_json_after_prose() {
    let mut payload = json!({
        "__rcc_tool_governance": {
            "enableTextHarvest": true,
            "requestedToolNames": ["exec_command"]
        },
        "choices": [{
            "message": {
                "tool_calls": [],
                "content": "我将按以下步骤执行：\n\n1. 先检查项目状态\n2. 再执行构建\n\n让我立即开始：\n\n{\"tool_calls\":[{\"name\":\"exec_command\",\"input\":{\"command\":\"bd --no-db ready\"}}]}"
            },
            "finish_reason": "stop"
        }]
    });
    assert_eq!(harvest_text_tool_calls_from_payload(&mut payload), 1);
    let call = &payload["choices"][0]["message"]["tool_calls"][0];
    assert_eq!(call["function"]["name"], "exec_command");
    let args: Value = serde_json::from_str(call["function"]["arguments"].as_str().unwrap_or("{}"))
        .unwrap_or(Value::Null);
    assert_eq!(args["command"], "bd --no-db ready");
}

#[test]
fn test_harvest_text_tool_calls_recovers_exec_command_inside_chunked_transcript_shape() {
    let mut payload = json!({
        "__rcc_tool_governance": {
            "enableTextHarvest": true,
            "requestedToolNames": ["exec_command"]
        },
        "choices": [{
            "message": {
                "tool_calls": [],
                "content": "Chunk ID: abc\nWall time: 0.1s\nProcess exited with code 0\nOriginal token count: 12\nOutput:\n<tool_call>\n{\"arguments\":{\"cmd\":\"echo next\"},\"id\":\"call_1\",\"name\":\"exec_command\"}\n</tool_call>\n"
            },
            "finish_reason": "stop"
        }]
    });
    assert_eq!(harvest_text_tool_calls_from_payload(&mut payload), 1);
    let call = &payload["choices"][0]["message"]["tool_calls"][0];
    assert_eq!(call["function"]["name"], "exec_command");
    let args: Value = serde_json::from_str(call["function"]["arguments"].as_str().unwrap_or("{}"))
        .unwrap_or(Value::Null);
    assert_eq!(args["cmd"], "echo next");
}

#[test]
fn test_harvest_text_tool_calls_strips_right_gutter_noise_before_exec_command_recovery() {
    let mut payload = json!({
        "__rcc_tool_governance": {
            "enableTextHarvest": true,
            "requestedToolNames": ["exec_command"]
        },
        "choices": [{
            "message": {
                "tool_calls": [],
                "content": "Chunk ID: abc\nWall time: 0.1s\nProcess exited with code 1\nOriginal token count: 12\nOutput:\n<tool_call>                                                                    │··········································\n{\"arguments\":{\"cmd\":\"python3 -V\"},\"id\":\"call_1\",\"name\":\"exec_command\"} │··········································\n</tool_call>                                                                   │··········································\n"
            },
            "finish_reason": "stop"
        }]
    });
    assert_eq!(harvest_text_tool_calls_from_payload(&mut payload), 1);
    let call = &payload["choices"][0]["message"]["tool_calls"][0];
    assert_eq!(call["function"]["name"], "exec_command");
    let args: Value = serde_json::from_str(call["function"]["arguments"].as_str().unwrap_or("{}"))
        .unwrap_or(Value::Null);
    assert_eq!(args["cmd"], "python3 -V");
}

#[test]
fn test_read_message_text_candidates_edge_paths() {
    let msg = json!({"content": "   "});
    let parts = read_message_text_candidates(msg.as_object().unwrap());
    assert!(parts.is_empty());

    let msg = json!({"content": [1, {"text": "ok"}, {"content": "more"}]});
    let parts = read_message_text_candidates(msg.as_object().unwrap());
    assert_eq!(parts.len(), 2);

    let msg = json!({"content": 123});
    let parts = read_message_text_candidates(msg.as_object().unwrap());
    assert!(parts.is_empty());
}

#[test]
fn test_govern_response_json_success() {
    let input = ToolGovernanceInput {
        payload: serde_json::json!({"choices": []}),
        client_protocol: "openai-chat".to_string(),
        entry_endpoint: "/v1/chat".to_string(),
        request_id: "req_json_ok".to_string(),
    };
    let output = govern_response_json(serde_json::to_string(&input).unwrap()).unwrap();
    let parsed: Value = serde_json::from_str(&output).unwrap();
    assert!(parsed.get("summary").is_some());
}

#[test]
fn test_govern_response_json_js_function_coverage() {
    let input = ToolGovernanceInput {
        payload: serde_json::json!({"choices": []}),
        client_protocol: "openai-chat".to_string(),
        entry_endpoint: "/v1/chat".to_string(),
        request_id: "req_json_js".to_string(),
    };
    let output = govern_response_json(serde_json::to_string(&input).unwrap()).unwrap();
    assert!(output.contains("\"summary\""));
}

#[test]
fn test_govern_response_preserves_structured_tool_calls_not_in_requested_allowlist() {
    let input = ToolGovernanceInput {
        payload: serde_json::json!({
            "__rcc_tool_governance": {
                "requestedToolNames": ["exec_command"]
            },
            "choices": [{
                "message": {
                    "content": "保持正文",
                    "tool_calls": [{
                        "function": {
                            "name": "mailbox.status",
                            "arguments": r#"{"target":"finger-system-agent"}"#
                        }
                    }]
                },
                "finish_reason": "tool_calls"
            }]
        }),
        client_protocol: "openai-chat".to_string(),
        entry_endpoint: "/v1/chat/completions".to_string(),
        request_id: "req_allowlist_drop_structured".to_string(),
    };

    let result = govern_response(input).unwrap();
    assert_eq!(result.summary.disallowed_tool_calls_dropped, 0);
    assert_eq!(result.summary.tool_calls_normalized, 1);
    assert_eq!(
        result.governed_payload["choices"][0]["finish_reason"],
        "tool_calls"
    );
    let tool_calls = result.governed_payload["choices"][0]["message"]["tool_calls"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    assert_eq!(tool_calls.len(), 1);
    assert_eq!(tool_calls[0]["function"]["name"], "mailbox.status");
    assert_eq!(
        result.governed_payload["choices"][0]["message"]["content"],
        Value::Null
    );
    assert!(result
        .governed_payload
        .get("__rcc_tool_governance")
        .is_none());
}

#[test]
fn test_govern_response_allows_shell_alias_when_exec_command_requested() {
    let input = ToolGovernanceInput {
        payload: serde_json::json!({
            "__rcc_tool_governance": {
                "requestedToolNames": ["exec_command"]
            },
            "choices": [{
                "message": {
                    "tool_calls": [{
                        "function": {
                            "name": "shell_command",
                            "arguments": {"command": "pwd"}
                        }
                    }]
                },
                "finish_reason": "tool_calls"
            }]
        }),
        client_protocol: "openai-chat".to_string(),
        entry_endpoint: "/v1/chat/completions".to_string(),
        request_id: "req_allowlist_shell_alias".to_string(),
    };

    let result = govern_response(input).unwrap();
    assert_eq!(result.summary.disallowed_tool_calls_dropped, 0);
    assert_eq!(result.summary.tool_calls_normalized, 1);
    assert_eq!(
        result.governed_payload["choices"][0]["message"]["tool_calls"][0]["function"]["name"],
        "exec_command"
    );
}

#[test]
fn test_govern_response_harvest_respects_requested_allowlist_and_preserves_text() {
    let input = ToolGovernanceInput {
        payload: serde_json::json!({
            "__rcc_tool_governance": {
                "requestedToolNames": ["exec_command"]
            },
            "choices": [{
                "message": {
                    "tool_calls": [],
                    "content": r#"<function_calls>{"tool_calls":[{"name":"mailbox.status","input":{"target":"finger-system-agent"}}]}</function_calls>
        保留正文"#
                },
                "finish_reason": "stop"
            }]
        }),
        client_protocol: "openai-chat".to_string(),
        entry_endpoint: "/v1/chat/completions".to_string(),
        request_id: "req_allowlist_harvest_drop".to_string(),
    };

    let result = govern_response(input).unwrap();
    assert_eq!(result.summary.disallowed_tool_calls_dropped, 0);
    assert_eq!(result.summary.tool_calls_normalized, 0);
    assert_eq!(
        result.governed_payload["choices"][0]["finish_reason"],
        "stop"
    );
    let tool_calls = result.governed_payload["choices"][0]["message"]["tool_calls"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    assert!(tool_calls.is_empty());
    let content = result.governed_payload["choices"][0]["message"]["content"]
        .as_str()
        .unwrap_or("");
    assert_eq!(content, "保留正文");
}

#[test]
fn test_govern_response_harvests_minimax_namespace_tool_call_text() {
    let input = ToolGovernanceInput {
        payload: serde_json::json!({
            "__rcc_tool_governance": {
                "requestedToolNames": ["exec_command"]
            },
            "choices": [{
                "message": {
                    "tool_calls": [],
                    "content": "\n<minimax:tool_call>\n<invoke name=\"exec_command\">\n<parameter name=\"cmd\">cat note.md 2&gt;/dev/null | sed -n '400,600p'</parameter>\n</invoke>\n</minimax:tool_call>"
                },
                "finish_reason": "stop"
            }]
        }),
        client_protocol: "openai-responses".to_string(),
        entry_endpoint: "/v1/responses".to_string(),
        request_id: "req_minimax_namespace_tool_call".to_string(),
    };

    let result = govern_response(input).unwrap();
    assert_eq!(result.summary.tool_calls_normalized, 1);
    assert_eq!(
        result.governed_payload["choices"][0]["finish_reason"],
        "tool_calls"
    );
    assert_eq!(
        result.governed_payload["choices"][0]["message"]["tool_calls"][0]["function"]["name"],
        "exec_command"
    );
    assert!(result.governed_payload["choices"][0]["message"]["content"].is_null());
    let args: Value = serde_json::from_str(
        result.governed_payload["choices"][0]["message"]["tool_calls"][0]["function"]["arguments"]
            .as_str()
            .unwrap_or("{}"),
    )
    .unwrap_or(Value::Null);
    assert_eq!(args["cmd"], "cat note.md 2>/dev/null | sed -n '400,600p'");
}

#[test]
fn test_govern_response_harvests_sentinel_split_provider_tool_call_text() {
    let input = ToolGovernanceInput {
        payload: serde_json::json!({
            "__rcc_tool_governance": {
                "requestedToolNames": ["exec_command"]
            },
            "choices": [{
                "message": {
                    "tool_calls": [],
                    "content": "让我看 req_process_stage2_route_select：]<]provider[>[\n<tool_call>\n]<]provider[>[<invoke name=\"exec_command\">]<]provider[>[<cmd>find sharedmodule/llmswitch-core -name 'route_select*.rs' 2>/dev/null</cmd>]<]provider[>[</invoke>\n]<]provider[>[</tool_call>"
                },
                "finish_reason": "stop"
            }]
        }),
        client_protocol: "openai-responses".to_string(),
        entry_endpoint: "/v1/responses".to_string(),
        request_id: "req_provider_sentinel_split_tool_call".to_string(),
    };

    let result = govern_response(input).unwrap();
    let serialized = serde_json::to_string(&result.governed_payload).unwrap();
    assert!(!serialized.contains("]<]provider[>["));
    assert_eq!(result.summary.tool_calls_normalized, 1);
    assert_eq!(
        result.governed_payload["choices"][0]["finish_reason"],
        "tool_calls"
    );
    assert_eq!(
        result.governed_payload["choices"][0]["message"]["tool_calls"][0]["function"]["name"],
        "exec_command"
    );
    assert!(result.governed_payload["choices"][0]["message"]["content"].is_null());
    assert_eq!(
        result.governed_payload["choices"][0]["message"]["reasoning"]["content"][0]["type"],
        "reasoning_text"
    );
    assert_eq!(
        result.governed_payload["choices"][0]["message"]["reasoning"]["content"][0]["text"],
        "让我看 req_process_stage2_route_select："
    );
    let args: Value = serde_json::from_str(
        result.governed_payload["choices"][0]["message"]["tool_calls"][0]["function"]["arguments"]
            .as_str()
            .unwrap_or("{}"),
    )
    .unwrap_or(Value::Null);
    assert_eq!(
        args["cmd"],
        "find sharedmodule/llmswitch-core -name 'route_select*.rs' 2>/dev/null"
    );
}

#[test]
fn test_govern_response_moves_minimax_sentinel_prefix_to_reasoning() {
    let input = ToolGovernanceInput {
        payload: json!({
            "choices": [{
                "message": {
                    "role": "assistant",
                    "content": "DNS 已切回 coder2。Step 2：恢复 coder2 sub2api。]<]minimax[>[

• minimax:tool_call (minimax:tool_call)

  </minimax:tool_call>",
                    "tool_calls": [{
                        "id": "call_1",
                        "type": "function",
                        "function": {
                            "name": "exec_command",
                            "arguments": "{\"cmd\":\"pwd\"}"
                        }
                    }]
                },
                "finish_reason": "tool_calls"
            }]
        }),
        client_protocol: "openai-responses".to_string(),
        entry_endpoint: "/v1/responses".to_string(),
        request_id: "req_minimax_sentinel_reasoning".to_string(),
    };

    let result = govern_response(input).unwrap();
    let message = &result.governed_payload["choices"][0]["message"];
    assert!(message["content"].is_null());
    assert_eq!(message["reasoning"]["content"][0]["type"], "reasoning_text");
    assert_eq!(
        message["reasoning"]["content"][0]["text"],
        "DNS 已切回 coder2。Step 2：恢复 coder2 sub2api。"
    );
    let serialized = serde_json::to_string(&result.governed_payload).unwrap();
    assert!(!serialized.contains("]<]minimax[>["));
    assert!(!serialized.contains("minimax:tool_call"));
}

#[test]
fn test_govern_response_strips_minimax_sentinel_from_native_tool_arguments() {
    let input = ToolGovernanceInput {
        payload: json!({
            "choices": [{
                "message": {
                    "role": "assistant",
                    "content": null,
                    "tool_calls": [{
                        "id": "call_1",
                        "type": "function",
                        "function": {
                            "name": "exec_command",
                            "arguments": "{\"cmd\":\"cd /repo && npx tsc --noEmit]<]minimax[>[\",\"workdir\":\"/repo/android]<]minimax[>[\",\"nested\":{\"note\":\"ok]<]minimax[>[\"}}"
                        }
                    }]
                },
                "finish_reason": "tool_calls"
            }]
        }),
        client_protocol: "openai-responses".to_string(),
        entry_endpoint: "/v1/responses".to_string(),
        request_id: "req_minimax_sentinel_tool_args".to_string(),
    };

    let result = govern_response(input).unwrap();
    let serialized = serde_json::to_string(&result.governed_payload).unwrap();
    assert!(!serialized.contains("]<]minimax[>["));
    let message = &result.governed_payload["choices"][0]["message"];
    let args: Value = serde_json::from_str(
        message["tool_calls"][0]["function"]["arguments"]
            .as_str()
            .unwrap_or("{}"),
    )
    .unwrap_or(Value::Null);
    assert_eq!(args["cmd"], "cd /repo && npx tsc --noEmit");
    assert_eq!(args["workdir"], "/repo/android");
    assert_eq!(args["nested"]["note"], "ok");
}

#[test]
fn test_govern_response_strips_minimax_sentinel_from_raw_response_text() {
    let input = ToolGovernanceInput {
        payload: json!({
            "body": {
                "data": {
                    "content": [{
                        "type": "text",
                        "text": "修 test 文件的语法错：]<]minimax[>[\n</title>"
                    }],
                    "stop_reason": "end_turn"
                }
            }
        }),
        client_protocol: "openai-responses".to_string(),
        entry_endpoint: "/v1/responses".to_string(),
        request_id: "req_minimax_sentinel_raw_text".to_string(),
    };

    let result = govern_response(input).unwrap();
    let serialized = serde_json::to_string(&result.governed_payload).unwrap();
    assert!(!serialized.contains("]<]minimax[>["));
    assert!(serialized.contains("修 test 文件的语法错"));
}

#[test]
fn test_govern_response_cleans_explicit_wrapper_when_tool_calls_are_unharvested() {
    let input = ToolGovernanceInput {
        payload: serde_json::json!({
            "__rcc_tool_governance": {
                "requestedToolNames": ["exec_command"]
            },
            "choices": [{
                "message": {
                    "tool_calls": [],
                    "content": r#"<function_calls>{"tool_calls":[{"name":"mailbox.status","input":{"target":"finger-system-agent"}}]}</function_calls>"#
                },
                "finish_reason": "stop"
            }]
        }),
        client_protocol: "openai-chat".to_string(),
        entry_endpoint: "/v1/chat/completions".to_string(),
        request_id: "req_preserve_wrapper_only_when_unharvested".to_string(),
    };

    let result = govern_response(input).unwrap();
    assert_eq!(result.summary.tool_calls_normalized, 0);
    assert_eq!(
        result.governed_payload["choices"][0]["finish_reason"],
        "stop"
    );
    let tool_calls = result.governed_payload["choices"][0]["message"]["tool_calls"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    assert!(tool_calls.is_empty());
    assert!(
        result.governed_payload["choices"][0]["message"]
            .get("content")
            .is_none()
            || result.governed_payload["choices"][0]["message"]["content"]
                .as_str()
                .map(|v| !v.contains("<function_calls>") && !v.contains("</function_calls>"))
                .unwrap_or(true)
    );
}

#[test]
fn test_strip_tool_call_marker_payload_preserves_trailing_prose_for_closed_function_calls() {
    let raw = "<function_calls>```bash\npwd\n```</function_calls>\n保留正文";
    assert_eq!(strip_tool_call_marker_payload(raw), "保留正文");
}

#[test]
fn test_strip_text_tool_wrapper_noise_strips_search_query_tags_but_preserves_text() {
    let raw = "<search>\n<query>context rebuild rebuild_context</query>\n</search>";
    assert_eq!(
        strip_text_tool_wrapper_noise(raw),
        "context rebuild rebuild_context"
    );
}

#[test]
fn test_strip_xml_tags_preserve_text_keeps_line_breaks() {
    let raw = "<review>\n第一行\n\n第二行 <search>query</search>\n</review>";
    assert_eq!(strip_xml_tags_preserve_text(raw), "第一行\n\n第二行 query");
}

#[test]
fn test_sanitize_textual_marker_field_preserves_inner_text_when_wrapper_only_content_would_empty() {
    let mut message = serde_json::json!({
        "content": "<function_calls>保留内部文本</function_calls>"
    })
    .as_object()
    .cloned()
    .unwrap();
    assert!(sanitize_textual_marker_field_in_message(
        &mut message,
        "content"
    ));
    assert_eq!(message["content"], "保留内部文本");
}

#[test]
fn test_sanitize_textual_marker_field_preserves_trailing_text_when_rcc_wrapper_starts_first() {
    let raw = "<<RCC_TOOL_CALLS_JSON\n{\"tool_calls\":[{\"name\":\"exec_command\",\"input\":{\"cmd\":\"pwd\"}}]}\nRCC_TOOL_CALLS_JSON\n保留正文";
    assert_eq!(strip_tool_call_marker_payload(raw), "保留正文");
    let mut message = serde_json::json!({
        "content": raw
    })
    .as_object()
    .cloned()
    .unwrap();
    assert!(sanitize_textual_marker_field_in_message(
        &mut message,
        "content"
    ));
    assert_eq!(message["content"], "保留正文");
}

#[test]
fn test_sanitize_textual_marker_field_preserves_malformed_rcc_wrapper_without_name() {
    let raw = "<<RCC_TOOL_CALLS_JSON\n{\"tool_calls\":[{\"input\":{\"cmd\":\"pwd\"}}]}\nRCC_TOOL_CALLS_JSON";
    let mut message = serde_json::json!({
        "content": raw
    })
    .as_object()
    .cloned()
    .unwrap();
    assert!(!sanitize_textual_marker_field_in_message(
        &mut message,
        "content"
    ));
    assert_eq!(message["content"], raw);
}

#[test]
fn test_sanitize_textual_marker_field_preserves_malformed_rcc_wrapper_multiline_whitespace() {
    let raw = "<<RCC_TOOL_CALLS_JSON\n{\"tool_calls\":[{\"input\":{\"cmd\":\"bash -lc 'cat << \\\"EOF\\\"\\n  line1\\n    line2\\nEOF\\n'\"}}]}\nRCC_TOOL_CALLS_JSON";
    let mut message = serde_json::json!({
        "content": raw
    })
    .as_object()
    .cloned()
    .unwrap();
    assert!(!sanitize_textual_marker_field_in_message(
        &mut message,
        "content"
    ));
    assert_eq!(message["content"], raw);
}

#[test]
fn test_govern_response_preserves_malformed_rcc_wrapper_when_name_missing() {
    let raw = "<<RCC_TOOL_CALLS_JSON\n{\"tool_calls\":[{\"input\":{\"cmd\":\"pwd\"}}]}\nRCC_TOOL_CALLS_JSON";
    let input = ToolGovernanceInput {
        payload: serde_json::json!({
            "__rcc_tool_governance": {
                "requestedToolNames": ["exec_command"]
            },
            "choices": [{
                "message": {
                    "tool_calls": [],
                    "content": raw
                },
                "finish_reason": "stop"
            }]
        }),
        client_protocol: "openai-chat".to_string(),
        entry_endpoint: "/v1/chat/completions".to_string(),
        request_id: "req_preserve_malformed_rcc_missing_name".to_string(),
    };

    let output = govern_response(input).unwrap();
    let tool_calls = output.governed_payload["choices"][0]["message"]["tool_calls"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    assert!(tool_calls.is_empty());
    assert_eq!(
        output.governed_payload["choices"][0]["finish_reason"],
        "stop"
    );
    assert_eq!(
        output.governed_payload["choices"][0]["message"]["content"],
        raw
    );
}

#[test]
fn test_govern_response_clears_tool_prefixed_exec_command_wrapper_content_to_null() {
    let input = ToolGovernanceInput {
        payload: serde_json::json!({
            "id": "resp_test_1",
            "object": "response",
            "created_at": 1,
            "model": "test-model",
            "status": "completed",
            "output": [],
            "output_text": "tool:exec_command (tool:exec_command)\n  <command>which flutter</command>\n  <timeout_ms>10000</timeout_ms>\n  </tool:exec_command>"
        }),
        client_protocol: "openai-responses".to_string(),
        entry_endpoint: "/v1/responses".to_string(),
        request_id: "req_test_resp_process_normalize".to_string(),
    };

    let result = govern_response(input).unwrap();
    let message = &result.governed_payload["choices"][0]["message"];
    let args: Value = serde_json::from_str(
        message["tool_calls"][0]["function"]["arguments"]
            .as_str()
            .unwrap_or("{}"),
    )
    .unwrap_or(Value::Null);
    assert_eq!(args["cmd"], "which flutter");
    assert!(message["content"].is_null());
}

#[test]
fn test_govern_response_adds_cmd_for_exec_command_after_shell_wrapper_harvest() {
    let input = ToolGovernanceInput {
        payload: serde_json::json!({
            "choices": [{
                "message": {
                    "tool_calls": [],
                    "content": "{\"tool_calls\":[{\"name\":\"shell_command\",\"input\":{\"command\":\"bd --no-db ready\"}},{\"name\":\"shell_command\",\"input\":{\"command\":\"bd --no-db list --status in_progress\"}}]}"
                },
                "finish_reason": "stop"
            }]
        }),
        client_protocol: "anthropic-messages".to_string(),
        entry_endpoint: "/v1/messages".to_string(),
        request_id: "req_test_empty_tool_calls_json_wrapper".to_string(),
    };

    let result = govern_response(input).unwrap();
    let calls = result.governed_payload["choices"][0]["message"]["tool_calls"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    assert_eq!(calls.len(), 2);
    let args0: Value =
        serde_json::from_str(calls[0]["function"]["arguments"].as_str().unwrap_or("{}"))
            .unwrap_or(Value::Null);
    let args1: Value =
        serde_json::from_str(calls[1]["function"]["arguments"].as_str().unwrap_or("{}"))
            .unwrap_or(Value::Null);
    assert_eq!(args0["cmd"], "bd --no-db ready");
    assert_eq!(args1["cmd"], "bd --no-db list --status in_progress");
    assert_eq!(args0["command"], "bd --no-db ready");
    assert_eq!(args1["command"], "bd --no-db list --status in_progress");
}

#[test]
fn test_govern_response_removes_reasoning_content_after_inline_exec_command_harvest() {
    let input = ToolGovernanceInput {
        payload: serde_json::json!({
            "choices": [{
                "message": {
                    "reasoning_content": "[Time/Date]: utc=`2026-03-10T12:19:19.410Z` local=`2026-03-10 20:19:19.410 +08:00` tz=`Asia/Shanghai` nowMs=`1773145159410` ntpOffsetMs=`33`\nexec_command<arg_key>cmd</arg_key><arg_value>pwd</arg_value></tool_call>"
                },
                "finish_reason": "stop"
            }]
        }),
        client_protocol: "openai-responses".to_string(),
        entry_endpoint: "/v1/responses".to_string(),
        request_id: "req_test_reasoning_native_tool".to_string(),
    };

    let result = govern_response(input).unwrap();
    let message = &result.governed_payload["choices"][0]["message"];
    let args: Value = serde_json::from_str(
        message["tool_calls"][0]["function"]["arguments"]
            .as_str()
            .unwrap_or("{}"),
    )
    .unwrap_or(Value::Null);
    assert_eq!(args["cmd"], "pwd");
    assert!(message.get("reasoning_content").is_none());
}

#[test]
fn test_govern_response_preserves_malformed_rcc_wrapper_multiline_whitespace_when_name_missing() {
    let raw = "<<RCC_TOOL_CALLS_JSON\n{\"tool_calls\":[{\"input\":{\"cmd\":\"bash -lc 'cat << \\\"EOF\\\"\\n  line1\\n    line2\\nEOF\\n'\"}}]}\nRCC_TOOL_CALLS_JSON";
    let input = ToolGovernanceInput {
        payload: serde_json::json!({
            "__rcc_tool_governance": {
                "enableTextHarvest": true,
                "requestedToolNames": ["exec_command"]
            },
            "choices": [{
                "message": {
                    "tool_calls": [],
                    "content": raw
                },
                "finish_reason": "stop"
            }]
        }),
        client_protocol: "openai-chat".to_string(),
        entry_endpoint: "/v1/chat/completions".to_string(),
        request_id: "req_preserve_malformed_rcc_multiline_whitespace".to_string(),
    };

    let output = govern_response(input).unwrap();
    let tool_calls = output.governed_payload["choices"][0]["message"]["tool_calls"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    assert!(tool_calls.is_empty());
    assert_eq!(
        output.governed_payload["choices"][0]["finish_reason"],
        "stop"
    );
    assert_eq!(
        output.governed_payload["choices"][0]["message"]["content"],
        raw
    );
}

#[test]
fn test_govern_response_recovers_generic_text_harvest_update_plan_tool_call_without_name() {
    let raw = "<tool_call>\n{\"explanation\":\"修复 scheduler 决策逻辑：当 execution_state 为 running 但 owner_loop_action 指示有 ready 任务可派发时，不应等待 running 完成而应直接派发。\",\"plan\":[{\"status\":\"in_progress\",\"step\":\"修改 scheduler.rs derive_scheduler_decision 中的 running 分支，允许覆盖为 dispatch_ready_task\"},{\"status\":\"pending\",\"step\":\"编译并测试修改\"},{\"status\":\"pending\",\"step\":\"清理状态并重新启动 daemon 验证\"}]}\n</tool_call>";
    let input = ToolGovernanceInput {
        payload: serde_json::json!({
            "__rcc_tool_governance": {
                "enableTextHarvest": true,
                "requestedToolNames": ["update_plan"]
            },
            "choices": [{
                "message": {
                    "tool_calls": [],
                    "content": raw
                },
                "finish_reason": "stop"
            }]
        }),
        client_protocol: "openai-chat".to_string(),
        entry_endpoint: "/v1/chat/completions".to_string(),
        request_id: "req_generic_text_harvest_update_plan_without_name".to_string(),
    };

    let output = govern_response(input).unwrap();
    let tool_calls = output.governed_payload["choices"][0]["message"]["tool_calls"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    assert_eq!(tool_calls.len(), 1);
    assert_eq!(tool_calls[0]["function"]["name"], "update_plan");
    let args: Value = serde_json::from_str(
        tool_calls[0]["function"]["arguments"]
            .as_str()
            .unwrap_or("{}"),
    )
    .unwrap_or(Value::Null);
    assert_eq!(args["plan"][0]["status"], "in_progress");
    assert_eq!(
        args["plan"][0]["step"],
        "修改 scheduler.rs derive_scheduler_decision 中的 running 分支，允许覆盖为 dispatch_ready_task"
    );
    assert!(output.governed_payload["choices"][0]["message"]["content"]
        .as_str()
        .unwrap_or("")
        .is_empty());
    assert_eq!(
        output.governed_payload["choices"][0]["finish_reason"],
        "tool_calls"
    );
}

#[test]
fn test_govern_response_sanitizes_marker_text_when_structured_tool_calls_already_exist() {
    let raw = "• <<RCC_TOOL_CALLS_JSON\n{\"tool_calls\":[{\"name\":\"exec_command\",\"input\":{\"cmd\":\"pwd\"}}]}\nRCC_TOOL_CALLS_JSON";
    let input = ToolGovernanceInput {
        payload: serde_json::json!({
            "choices": [{
                "message": {
                    "tool_calls": [{
                        "id": "call_existing",
                        "type": "function",
                        "function": {
                            "name": "exec_command",
                            "arguments": "{\"cmd\":\"pwd\"}"
                        }
                    }],
                    "content": raw
                },
                "finish_reason": "stop"
            }]
        }),
        client_protocol: "openai-chat".to_string(),
        entry_endpoint: "/v1/chat/completions".to_string(),
        request_id: "req_existing_tool_calls_sanitize_1".to_string(),
    };

    let result = govern_response(input).unwrap();
    let message = &result.governed_payload["choices"][0]["message"];
    assert_eq!(
        result.governed_payload["choices"][0]["finish_reason"],
        "tool_calls"
    );
    assert_eq!(message["tool_calls"][0]["function"]["name"], "exec_command");
    assert!(message["content"].is_null());
}

#[test]
fn test_govern_response_strips_codex_transcript_tool_call_leak() {
    let leaked = r#"Assistant requested tool calls: - id=call_00_wpSa0J6o4cVOVh9s20T3294 type=function name=exec_command arguments={"cmd":"cd /Users/fanzhang/Documents/github/routecodex && awk 'NR==1,/^mod virtual_router_engine;$/{print; if($0~/^mod virtual_router_engine;$/){print \"mod virtual_router_hit_log;\"}}' sharedmodule/llmswitch-core/rust-core/crates/router-hotpath"}"#;
    let input = ToolGovernanceInput {
        payload: serde_json::json!({
            "choices": [{
                "message": {
                    "role": "assistant",
                    "content": leaked
                },
                "finish_reason": "stop"
            }]
        }),
        client_protocol: "openai-chat".to_string(),
        entry_endpoint: "/v1/chat/completions".to_string(),
        request_id: "req_codex_transcript_tool_leak".to_string(),
    };

    let result = govern_response(input).unwrap();
    let message = &result.governed_payload["choices"][0]["message"];
    assert!(
        message.get("content").is_none()
            || message["content"].is_null()
            || message["content"]
                .as_str()
                .is_some_and(|text| text.is_empty())
    );
    let serialized = result.governed_payload.to_string();
    assert!(!serialized.contains("Assistant requested tool calls"));
    assert!(!serialized.contains("call_00_wpSa0J6o4cVOVh9s20T3294"));
    assert!(!serialized.contains("mod virtual_router_hit_log"));
}

#[test]
fn test_rcc_heredoc_tail_is_stripped_when_exec_command_runs_bd_cli() {
    let input = ToolGovernanceInput {
        payload: serde_json::json!({
            "choices": [{
                "message": {
                    "tool_calls": [],
                    "content": "开始分析。\n<<RCC_TOOL_CALLS_JSON\n{\"tool_calls\":[{\"input\":{\"cmd\":\"bd --no-db create '多轨实现' --description '为 Finger 项目增加 multi-track 支持'\"},\"name\":\"exec_command\"}]}\nRCC_TOOL_CALLS_JSON\n› Implement {feature}\nMacstudio.0:zsh*"
                },
                "finish_reason": "stop"
            }]
        }),
        client_protocol: "openai-chat".to_string(),
        entry_endpoint: "/v1/chat/completions".to_string(),
        request_id: "req_rcc_strip_tail_recover_1".to_string(),
    };

    let result = govern_response(input).unwrap();
    let message = &result.governed_payload["choices"][0]["message"];
    assert!(result.summary.applied);
    assert_eq!(result.summary.tool_calls_normalized, 1);
    assert_eq!(
        result.governed_payload["choices"][0]["finish_reason"],
        "tool_calls"
    );
    assert_eq!(message["tool_calls"][0]["function"]["name"], "exec_command");
    let args: Value = serde_json::from_str(
        message["tool_calls"][0]["function"]["arguments"]
            .as_str()
            .unwrap_or("{}"),
    )
    .unwrap_or(Value::Null);
    assert_eq!(
        args["cmd"],
        "bd --no-db create '多轨实现' --description '为 Finger 项目增加 multi-track 支持'"
    );
    let content = message["content"].as_str().unwrap_or("");
    assert_eq!(content, "开始分析。");
    assert!(!content.contains("RCC_TOOL_CALLS_JSON"));
    assert!(!content.contains("Implement {feature}"));
    assert!(!content.contains("Macstudio.0:zsh*"));
}

#[test]
fn test_govern_response_preserves_allowed_multi_tool_calls() {
    let input = ToolGovernanceInput {
        payload: serde_json::json!({
            "__rcc_tool_governance": {
                "requestedToolNames": ["exec_command", "apply_patch"]
            },
            "choices": [{
                "message": {
                    "tool_calls": [{
                        "function": {
                            "name": "apply_patch",
                            "arguments": "*** Begin Patch\n*** Add File: hello.txt\n+hello\n*** End Patch"
                        }
                    }]
                },
                "finish_reason": "tool_calls"
            }]
        }),
        client_protocol: "openai-chat".to_string(),
        entry_endpoint: "/v1/chat/completions".to_string(),
        request_id: "req_allowlist_multi_keep".to_string(),
    };

    let result = govern_response(input).unwrap();
    assert_eq!(result.summary.disallowed_tool_calls_dropped, 0);
    assert_eq!(result.summary.tool_calls_normalized, 1);
    assert_eq!(
        result.governed_payload["choices"][0]["message"]["tool_calls"][0]["function"]["name"],
        "apply_patch"
    );
}

#[test]
fn test_govern_response_preserves_apply_patch_shell_fallback_write_for_client_feedback() {
    let input = ToolGovernanceInput {
        payload: serde_json::json!({
            "__rcc_tool_governance": {
                "requestedToolNames": ["exec_command", "apply_patch"]
            },
            "choices": [{
                "message": {
                    "content": "Delete also fails. Patch tool is non-functional. Try a no-op or with explicit working dir using exec_command as a fallback write. Use a wrapper that writes via exec_command with tee/cat <<EOF; fall back is required.",
                    "tool_calls": [{
                        "function": {
                            "name": "exec_command",
                            "arguments": {
                                "cmd": "cat > tmp/ap_probe5.txt <<'EOF'\nhello\nEOF\ncat tmp/ap_probe5.txt"
                            }
                        }
                    }]
                },
                "finish_reason": "tool_calls"
            }]
        }),
        client_protocol: "openai-chat".to_string(),
        entry_endpoint: "/v1/chat/completions".to_string(),
        request_id: "req_apply_patch_shell_fallback_live_minimax".to_string(),
    };

    let result = govern_response(input).unwrap();
    let choice = &result.governed_payload["choices"][0];
    let message = &choice["message"];
    assert_eq!(result.summary.disallowed_tool_calls_dropped, 0);
    assert_eq!(choice["finish_reason"], "tool_calls");
    let tool_calls = message["tool_calls"].as_array().unwrap();
    assert_eq!(tool_calls.len(), 1);
    assert_eq!(tool_calls[0]["function"]["name"], "exec_command");
    assert_eq!(message["content"], Value::Null);
    let arguments = tool_calls[0]["function"]["arguments"].as_str().unwrap();
    assert!(arguments.contains("cat > tmp/ap_probe5.txt"));
}

#[test]
fn test_govern_response_preserves_read_only_exec_command_when_apply_patch_is_mentioned() {
    let input = ToolGovernanceInput {
        payload: serde_json::json!({
            "__rcc_tool_governance": {
                "requestedToolNames": ["exec_command", "apply_patch"]
            },
            "choices": [{
                "message": {
                    "content": "I will inspect existing files before preparing apply_patch.",
                    "tool_calls": [{
                        "function": {
                            "name": "exec_command",
                            "arguments": {"cmd": "cat tmp/ap_probe5.txt"}
                        }
                    }]
                },
                "finish_reason": "tool_calls"
            }]
        }),
        client_protocol: "openai-chat".to_string(),
        entry_endpoint: "/v1/chat/completions".to_string(),
        request_id: "req_apply_patch_read_only_exec_allowed".to_string(),
    };

    let result = govern_response(input).unwrap();
    let message = &result.governed_payload["choices"][0]["message"];
    assert_eq!(result.summary.disallowed_tool_calls_dropped, 0);
    assert_eq!(
        result.governed_payload["choices"][0]["finish_reason"],
        "tool_calls"
    );
    assert_eq!(message["tool_calls"][0]["function"]["name"], "exec_command");
}

#[test]
fn test_remap_tool_calls_for_client_protocol_reverses_write_stdin_args() {
    // Red test: write_stdin args are normalized on req side (sessionId → session_id, text → chars)
    // but response side doesn't reverse. This test confirms the fix works.
    let mut payload = serde_json::json!({
        "choices": [{
            "message": {
                "role": "assistant",
                "tool_calls": [{
                    "id": "write_1",
                    "type": "function",
                    "function": {
                        "name": "write_stdin",
                        "arguments": "{\"session_id\":123,\"chars\":\"echo hello\"}"
                    }
                }]
            },
            "finish_reason": "tool_calls"
        }]
    });
    remap_tool_calls_for_client_protocol(&mut payload, "openai-chat");
    let tool_call = &payload["choices"][0]["message"]["tool_calls"][0];
    let args: serde_json::Value =
        serde_json::from_str(tool_call["function"]["arguments"].as_str().unwrap()).unwrap();
    // After fix: session_id → sessionId, chars → text
    assert_eq!(args.get("sessionId").and_then(|v| v.as_i64()), Some(123));
    assert_eq!(args.get("session_id"), None);
    assert_eq!(
        args.get("text").and_then(|v| v.as_str()),
        Some("echo hello")
    );
    assert_eq!(args.get("chars"), None);
    assert_eq!(tool_call["function"]["name"], "write_stdin");
}

#[test]
fn test_strip_orphan_function_calls_tag_json_js_function_coverage() {
    let payload = serde_json::json!({
        "choices": [{
            "message": { "content": "<function_calls>{\\\"name\\\":\\\"exec_command\\\"}</function_calls>" }
        }]
    });
    let output = strip_orphan_function_calls_tag_json(payload.to_string()).unwrap();
    assert!(!output.contains("<function_calls>"));
}

#[test]
fn test_govern_response_json_matches_core_shape() {
    let input = ToolGovernanceInput {
        payload: serde_json::json!({
            "choices": [{
                "message": {"role":"assistant","content":"ok"},
                "finish_reason":"stop"
            }]
        }),
        client_protocol: "openai-chat".to_string(),
        entry_endpoint: "/v1/chat/completions".to_string(),
        request_id: "req_equiv_resp".to_string(),
    };
    let core = serde_json::to_value(govern_response(input).expect("core")).unwrap();
    let json_input = serde_json::json!({
        "payload": {
            "choices": [{
                "message": {"role":"assistant","content":"ok"},
                "finish_reason":"stop"
            }]
        },
        "client_protocol": "openai-chat",
        "entry_endpoint": "/v1/chat/completions",
        "request_id": "req_equiv_resp"
    });
    let json_out: serde_json::Value =
        serde_json::from_str(&govern_response_json(json_input.to_string()).expect("json")).unwrap();
    assert_eq!(json_out["governed_payload"], core["governed_payload"]);
    assert_eq!(json_out["summary"], core["summary"]);
}
