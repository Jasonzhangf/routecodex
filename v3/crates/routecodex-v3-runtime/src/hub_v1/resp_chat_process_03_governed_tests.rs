// resp_chat_process_03_governed 密文治理测试,拆分自 resp_chat_process_03_governed.rs
// 以满足 verify:v3-file-size。语义不变:`use super::*` 与内联 mod tests 等价。

use super::*;

#[test]
fn resp03_json_fields_are_removed_and_projected_without_changing_openai_arguments() {
    let mut payload = json!({
        "choices":[{"message":{
            "role":"assistant",
            "tool_calls":[{"id":"call_json","type":"function","function":{
                "name":"exec_command","arguments":"{\"cmd\":\"pwd\",\"reason\":\"确认当前工作目录\",\"goal_alignment_confidence\":100,\"model_id\":\"x-preview-f-free\"}"
            }}]
        }}]
    });
    let original =
        payload["choices"][0]["message"]["tool_calls"][0]["function"]["arguments"].clone();
    map_v3_toolreason_to_reasoning_content_at_resp03(&mut payload, true);
    let call = &payload["choices"][0]["message"]["tool_calls"][0];
    assert_ne!(call["function"]["arguments"], original);
    assert_eq!(call["function"]["arguments"], "{\"cmd\":\"pwd\"}");
    assert!(call.get("reason").is_none());
    assert!(call.get("goal_alignment_confidence").is_none());
    assert!(call.get("model_id").is_none());
    assert_eq!(
        payload["choices"][0]["message"]["reasoning_content"],
        "调用工具 pwd：确认当前工作目录"
    );
}

#[test]
fn resp03_chat_json_appends_toolreason_after_provider_reasoning() {
    let mut payload = json!({
        "choices":[{"message":{
            "role":"assistant",
            "reasoning_content":"provider summary",
            "tool_calls":[{"id":"call_with_reasoning","type":"function","function":{
                "name":"rcc_probe","arguments":"{\"value\":\"x\",\"reason\":\"确认探针结果\",\"goal_alignment_confidence\":100,\"model_id\":\"ox-alpha\"}"
            }}]
        }}]
    });

    map_v3_toolreason_to_reasoning_content_at_resp03(&mut payload, true);

    assert_eq!(
        payload["choices"][0]["message"]["reasoning_content"],
        "provider summary\n调用工具 rcc_probe：确认探针结果"
    );
    assert!(payload.get("reasoning_content").is_none());
}

#[test]
fn resp03_responses_json_projects_only_into_reasoning_summary() {
    let mut payload = json!({
        "output":[
            {"type":"reasoning","summary":[{"type":"summary_text","text":"provider summary"}]},
            {"type":"function_call","name":"rcc_probe","call_id":"call_responses_reasoning",
             "arguments":"{\"value\":\"x\",\"reason\":\"确认探针结果\",\"goal_alignment_confidence\":100,\"model_id\":\"ox-alpha\"}"}
        ]
    });

    map_v3_toolreason_to_reasoning_content_at_resp03(&mut payload, true);

    assert_eq!(
        payload["output"][0]["summary"][1]["text"],
        "调用工具 rcc_probe：确认探针结果"
    );
    assert!(payload.get("reasoning_content").is_none());
    assert_eq!(payload["output"][1]["arguments"], "{\"value\":\"x\"}");
}

#[test]
fn resp03_chat_delta_fields_are_removed_and_projected_for_relay_conversion() {
    let mut payload = json!({
        "object": "chat.completion.chunk",
        "choices": [{"index": 0, "delta": {"tool_calls": [{
            "index": 0,
            "id": "call_delta",
            "function": {"name": "pwd", "arguments":
                "{\"goal_alignment_confidence\":100,\"model_id\":\"x-preview-f-free\",\"reason\":\"读取当前目录\"}"
            }
        }]}, "finish_reason": null}]
    });

    map_v3_toolreason_to_reasoning_content_at_resp03(&mut payload, true);

    let delta = &payload["choices"][0]["delta"];
    assert_eq!(delta["tool_calls"][0]["function"]["arguments"], "{}");
    assert_eq!(delta["reasoning_content"], "调用工具 pwd：读取当前目录");
    assert!(!serde_json::to_string(&payload)
        .unwrap()
        .contains("goal_alignment_confidence"));
    assert!(!serde_json::to_string(&payload)
        .unwrap()
        .contains("model_id"));
    assert!(!serde_json::to_string(&payload)
        .unwrap()
        .contains("\"reason\""));
}

#[test]
fn resp03_chat_delta_split_toolreason_is_buffered_before_projection() {
    let tool_names = vec!["pwd".to_string()];
    let mut pending_reasons = Vec::new();
    let mut argument_buffers = Vec::new();
    let mut reason_emitted = false;
    let fragments = [
        r#"{"goal_alignment_confidence":100"#,
        r#", "model_id":"x-preview-f-free""#,
        r#", "reason":"确认当前工作目录"}"#,
    ];

    let mut projected = Vec::new();
    for fragment in fragments {
        let mut payload = json!({
            "object": "chat.completion.chunk",
            "choices": [{"index": 0, "delta": {"tool_calls": [{
                "index": 0,
                "function": {"name": "pwd", "arguments": fragment}
            }]}}]
        });
        map_v3_toolreason_stream_event_at_resp03_with_context_and_buffers(
            &mut payload,
            true,
            &tool_names,
            &mut pending_reasons,
            &mut reason_emitted,
            true,
            Some("session-split"),
            Some("request-split"),
            Some(&mut argument_buffers),
        );
        projected.push(payload);
    }

    assert_eq!(
        projected[0].pointer("/choices/0/delta/tool_calls/0/function/arguments"),
        Some(&json!(""))
    );
    assert_eq!(
        projected[1].pointer("/choices/0/delta/tool_calls/0/function/arguments"),
        Some(&json!(""))
    );
    assert_eq!(
        projected[2].pointer("/choices/0/delta/tool_calls/0/function/arguments"),
        Some(&json!("{}"))
    );
    assert_eq!(
        projected[2].pointer("/choices/0/delta/reasoning_content"),
        Some(&json!("调用工具 pwd：确认当前工作目录"))
    );
    assert!(reason_emitted);
    assert!(!projected.iter().any(|payload| {
        payload.to_string().contains("goal_alignment_confidence")
            || payload.to_string().contains("model_id")
            || payload.to_string().contains("\"reason\"")
    }));
}

#[test]
fn resp03_json_fields_inside_openai_function_object_are_removed_without_touching_arguments() {
    let mut payload = json!({
        "choices":[{"message":{"tool_calls":[{"id":"call_nested","type":"function",
            "function":{"name":"read_file","arguments":"{\"path\":\"README.md\",\"reason\":\"读取项目说明\",\"goal_alignment_confidence\":90,\"model_id\":\"glm-5.2\"}"}}]}}]
    });
    let original =
        payload["choices"][0]["message"]["tool_calls"][0]["function"]["arguments"].clone();
    map_v3_toolreason_to_reasoning_content_at_resp03(&mut payload, true);
    let function = &payload["choices"][0]["message"]["tool_calls"][0]["function"];
    assert_ne!(function["arguments"], original);
    assert_eq!(function["arguments"], "{\"path\":\"README.md\"}");
    assert_eq!(
        payload["choices"][0]["message"]["reasoning_content"],
        "调用工具 read_file：读取项目说明"
    );
}

#[test]
fn resp03_json_fields_are_removed_from_anthropic_tool_use_without_touching_input() {
    let mut payload = json!({
        "content":[{"type":"tool_use","id":"tool_1","name":"read_file","input":{
            "path":"README.md","reason":"读取项目说明","goal_alignment_confidence":90,"model_id":"glm-5.2"
        }}]
    });
    map_v3_toolreason_to_reasoning_content_at_resp03(&mut payload, true);
    assert_eq!(payload["content"][0]["input"], json!({"path":"README.md"}));
    assert_eq!(
        payload["reasoning_content"],
        "调用工具 read_file：读取项目说明"
    );
}

#[test]
fn resp03_json_fields_inside_openai_arguments_are_removed_without_changing_command() {
    let mut payload = json!({
        "output":[{"type":"function_call","call_id":"call_nested_args","name":"exec_command",
            "arguments":"{\"cmd\":\"cat README.md\",\"reason\":\"读取项目说明\",\"goal_alignment_confidence\":90,\"model_id\":\"glm-5.2\"}"}]
    });
    map_v3_toolreason_to_reasoning_content_at_resp03(&mut payload, true);
    let call = payload["output"]
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item.get("type") == Some(&json!("function_call")))
        .unwrap();
    assert_eq!(call["arguments"], "{\"cmd\":\"cat README.md\"}");
    assert!(payload["output"].as_array().unwrap().iter().any(|item| {
        item.get("type") == Some(&json!("reasoning"))
            && item.to_string().contains("调用工具 cat：读取项目说明")
    }));
}

#[test]
fn resp03_malformed_json_fields_preserve_native_tool_call_and_do_not_project_guess() {
    let mut payload = json!({
        "output":[{"type":"function_call","call_id":"call_bad","name":"exec_command",
            "arguments":"{\"cmd\":\"pwd\"}","reason":"","goal_alignment_confidence":"100","model_id":null}]
    });
    let original = payload["output"][0].clone();
    map_v3_toolreason_to_reasoning_content_at_resp03(&mut payload, true);
    assert_eq!(payload["output"][0]["name"], original["name"]);
    assert_eq!(payload["output"][0]["arguments"], original["arguments"]);
    assert_eq!(payload["output"][0].get("reason"), Some(&json!("")));
    assert_eq!(payload["output"][0]["goal_alignment_confidence"], "100");
    assert_eq!(payload["output"][0]["model_id"], Value::Null);
    assert!(payload["output"]
        .as_array()
        .unwrap()
        .iter()
        .all(|item| item.get("type") != Some(&json!("reasoning"))));
}

#[test]
fn resp03_nested_invalid_auxiliary_fields_are_classified_invalid_not_missing() {
    let raw = first_v3_tool_thinking_object_at_resp03(&json!({
        "output": [{
            "type": "function_call",
            "name": "exec_command",
            "arguments": "{\"cmd\":\"pwd\",\"reason\":\"inspect\",\"goal_alignment_confidence\":\"100\",\"model_id\":null}"
        }]
    }))
    .expect("nested auxiliary object must be observed");
    assert_eq!(raw.0, "pwd");
    assert_eq!(
        classify_v3_toolreason_observation_at_resp03(Some(&raw.1)).0,
        V3ToolreasonObservationStatus::Invalid
    );
}

#[test]
fn resp03_observation_label_contains_all_tools_in_one_turn() {
    let raw = first_v3_tool_thinking_object_at_resp03(&json!({
        "choices": [{"message": {"tool_calls": [
            {"type":"function","function":{"name":"rcc_probe","arguments":"{\"value\":\"a\",\"reason\":\"第一探针\",\"goal_alignment_confidence\":100,\"model_id\":\"ox-alpha\"}"}},
            {"type":"function","function":{"name":"rcc_probe_second","arguments":"{\"value\":\"b\",\"reason\":\"第二探针\",\"goal_alignment_confidence\":100,\"model_id\":\"ox-alpha\"}"}}
        ]}}]
    }))
    .expect("multi-tool turn must be observable");

    assert_eq!(raw.0, "rcc_probe、rcc_probe_second");
}

#[test]
fn resp03_toolreason_maps_to_visible_reasoning_content_and_is_removed_from_text() {
    let mut payload = json!({
        "choices":[{"message":{
            "role":"assistant",
            "content":"<toolreason>{\"reason\":\"Need inspect the file.\",\"goal_alignment_confidence\":90}</toolreason>",
            "tool_calls":[{"id":"call_1","type":"function","function":{"name":"exec","arguments":"{}"}}]
        }}]
    });
    map_v3_toolreason_to_reasoning_content_at_resp03(&mut payload, true);
    let message = &payload["choices"][0]["message"];
    assert!(message.get("reasoning_content").is_none());
    assert_eq!(message["content"], "");
    assert!(!payload.to_string().contains("toolreason"));
}

#[test]
fn resp03_toolreason_from_responses_output_text_maps_to_reasoning_item() {
    let mut payload = json!({
        "output": [
            {"type":"output_text","text":"<toolreason>{\"reason\":\"Inspect the target file\",\"goal_alignment_confidence\":95,\"model_id\":\"x-preview-f-free\"}</toolreason>"},
            {"type":"function_call","call_id":"call_1","name":"read_file","arguments":"{}"}
        ]
    });
    map_v3_toolreason_to_reasoning_content_at_resp03(&mut payload, true);
    assert_eq!(payload["output"][0]["type"], "output_text");
    assert_eq!(payload["output"][1]["type"], "function_call");
    assert_eq!(payload["output"][0]["text"], "");
    assert!(!payload.to_string().contains("toolreason"));
}

#[test]
fn resp03_toolreason_from_generic_text_output_item_is_stripped() {
    let mut payload = json!({
        "output": [
            {"type":"text","text":"<toolreason>{\"reason\":\"确认当前工作目录\",\"goal_alignment_confidence\":100,\"model_id\":\"x-preview-f-free\"}</toolreason>"},
            {"type":"function_call","call_id":"call_1","name":"pwd","arguments":"{}"}
        ]
    });

    map_v3_toolreason_to_reasoning_content_at_resp03(&mut payload, true);

    assert_eq!(payload["output"][0]["text"], "");
    assert_eq!(payload["output"][1]["type"], "function_call");
    assert!(!payload.to_string().contains("toolreason"));
}

#[test]
fn resp03_toolreason_never_rewrites_native_tool_arguments() {
    let command = "printf '<toolreason>keep this command literal</toolreason>'";
    let mut payload = json!({
        "choices":[{"message":{
            "content":"<toolreason>{\"reason\":\"Inspect the command\"}</toolreason>",
            "tool_calls":[{"type":"function","function":{
                "name":"exec_command",
                "arguments":format!("{{\"cmd\":{}}}", serde_json::to_string(command).unwrap())
            }}]
        }}]
    });
    let original_arguments =
        payload["choices"][0]["message"]["tool_calls"][0]["function"]["arguments"].clone();
    map_v3_toolreason_to_reasoning_content_at_resp03(&mut payload, true);
    assert_eq!(
        payload["choices"][0]["message"]["tool_calls"][0]["function"]["arguments"],
        original_arguments
    );
    assert!(payload["choices"][0]["message"]
        .get("reasoning_content")
        .is_none());
}

#[test]
fn resp03_toolreason_never_rewrites_gemini_function_call_args() {
    let command = "printf '<toolreason>keep this command literal</toolreason>'";
    let mut payload = json!({
        "candidates":[{"content":{"parts":[
            {"text":"<toolreason>{\"reason\":\"Inspect the command\"}</toolreason>"},
            {"functionCall":{"name":"exec_command","args":{"cmd":command}}}
        ]}}]
    });
    let original_args =
        payload["candidates"][0]["content"]["parts"][1]["functionCall"]["args"].clone();
    map_v3_toolreason_to_reasoning_content_at_resp03(&mut payload, true);
    assert_eq!(
        payload["candidates"][0]["content"]["parts"][1]["functionCall"]["args"],
        original_args
    );
    assert!(
        payload["candidates"][0]["content"]["parts"][1]["functionCall"]["args"]["cmd"]
            .as_str()
            .unwrap()
            .contains("<toolreason>keep this command literal</toolreason>")
    );
}

#[test]
fn resp03_native_reasoning_is_not_toolreason() {
    let mut payload = json!({
        "output": [
            {"type":"reasoning","summary":[{"type":"summary_text","text":"native model reasoning"}]},
            {"type":"function_call","call_id":"call_1","name":"read_file","arguments":"{}"}
        ]
    });
    map_v3_toolreason_to_reasoning_content_at_resp03(&mut payload, true);
    assert_eq!(payload["output"][0]["type"], "reasoning");
    assert_eq!(
        payload["output"][0]["summary"][0]["text"],
        "native model reasoning"
    );
    assert!(!payload.to_string().contains("调用工具"));
}

#[test]
fn resp03_toolreason_debug_projection_off_keeps_console_observation_only() {
    let mut payload = json!({
        "choices": [{
            "message": {
                "content": "<toolreason>{\"reason\":\"Inspect file\",\"goal_alignment_confidence\":80}</toolreason>",
                "tool_calls": [{"type":"function","function":{"name":"read_file"}}]
            }
        }]
    });
    map_v3_toolreason_to_reasoning_content_at_resp03_with_projection(&mut payload, true, false);
    let message = &payload["choices"][0]["message"];
    assert_eq!(message["content"], "");
    assert!(message.get("reasoning_content").is_none());
    assert!(!payload.to_string().contains("toolreason"));
}

#[test]
fn resp03_incomplete_toolreason_is_removed_without_guessing_reason() {
    let mut payload = json!({
        "choices":[{"message":{
            "role":"assistant",
            "content":"before <toolreason>Need inspect",
            "tool_calls":[{"id":"call_1","type":"function","function":{"name":"exec","arguments":"{\"cmd\":\"cat secret\"}"}}]
        }}]
    });
    map_v3_toolreason_to_reasoning_content_at_resp03(&mut payload, true);
    let message = &payload["choices"][0]["message"];
    assert_eq!(message.get("reasoning_content"), None);
    assert_eq!(message["content"], "before ");
    assert!(!payload.to_string().contains("toolreason"));
    assert!(payload.to_string().contains("cat secret"));
}

#[test]
fn resp03_multiple_toolreasons_pair_by_tool_call_order_and_strip_duplicates() {
    let mut payload = json!({
        "choices":[{"message":{
            "role":"assistant",
            "content":"<toolreason>Inspect file.</toolreason><toolreason>Run test.</toolreason><toolreason>duplicate.</toolreason>",
            "tool_calls":[
                {"id":"call_1","type":"function","function":{"name":"cat","arguments":"{}"}},
                {"id":"call_2","type":"function","function":{"name":"test","arguments":"{}"}}
            ]
        }}]
    });
    map_v3_toolreason_to_reasoning_content_at_resp03(&mut payload, true);
    let message = &payload["choices"][0]["message"];
    assert!(message.get("reasoning_content").is_none());
    assert_eq!(message["content"], "");
    assert!(!payload.to_string().contains("toolreason"));
    assert!(!payload.to_string().contains("duplicate."));
}

#[test]
fn resp03_responses_post_call_toolreason_maps_once_and_preserves_calls() {
    let mut payload = json!({
        "id": "resp_post_reason",
        "output": [
            {"type":"function_call","call_id":"call_1","name":"exec_command","arguments":"{\"cmd\":\"pwd\"}"},
            {"type":"function_call","call_id":"call_2","name":"read_file","arguments":"{\"path\":\"config.toml\"}"},
            {"type":"message","role":"assistant","content":[
                {"type":"output_text","text":"<toolreason>确认工具结果所需的工作状态</toolreason>"}
            ]}
        ]
    });

    map_v3_toolreason_to_reasoning_content_at_resp03(&mut payload, true);

    assert_eq!(payload["output"][2]["type"], "message");
    assert_eq!(payload["output"][2]["content"][0]["text"], "");
    assert_eq!(payload["output"][0]["name"], "exec_command");
    assert_eq!(payload["output"][1]["name"], "read_file");
    assert!(!payload.to_string().contains("toolreason"));
}

#[test]
fn resp03_toolreason_label_deduplicates_shell_wrappers_and_commands() {
    assert_eq!(
        format_toolreason_tool_label(&[
            "exec_command".to_string(),
            "exec_command".to_string(),
            "test".to_string(),
            "sed".to_string(),
            "sed".to_string(),
            "rg".to_string(),
        ]),
        "test、sed、rg"
    );
}

#[test]
fn resp03_toolreason_uses_shell_command_as_display_tool_for_exec_command() {
    let mut payload = json!({
        "output": [
            {"type":"function_call","name":"exec_command","arguments":"{\"cmd\":\"curl -fsS http://127.0.0.1:7777/health\"}"},
            {"type":"message","content":[{"type":"output_text","text":"<toolreason>检查服务健康状态</toolreason>"}]}
        ]
    });
    map_v3_toolreason_to_reasoning_content_at_resp03(&mut payload, true);
    assert_eq!(payload["output"][1]["type"], "message");
    assert_eq!(payload["output"][1]["content"][0]["text"], "");
    assert!(!payload.to_string().contains("调用工具 exec_command"));
}

#[test]
fn resp03_duplicate_native_auxiliary_keys_are_invalid_and_not_projected() {
    let duplicate = r#"{"cmd":"pwd","reason":"确认当前目录","goal_alignment_confidence":100,"model_id":"x-preview-f-free","reason":"获取当前日期","goal_alignment_confidence":100,"model_id":"x-preview-f-free"}"#;
    assert!(json_object_has_duplicate_keys_at_resp03(duplicate));
    assert!(
        v3_tool_thinking_fields_from_parameter_value_at_resp03(&Value::String(
            duplicate.to_string()
        ))
        .is_none()
    );

    let mut payload = json!({
        "choices": [{
            "delta": {
                "tool_calls": [{
                    "index": 0,
                    "function": {"name": "pwd", "arguments": duplicate}
                }]
            }
        }]
    });
    map_v3_openai_chat_toolreason_delta_at_resp03(&mut payload, true);
    let function = &payload["choices"][0]["delta"]["tool_calls"][0]["function"];
    assert_eq!(function["arguments"], duplicate);
    assert!(payload["choices"][0]["delta"]
        .get("reasoning_content")
        .is_none());
}

#[test]
fn resp03_toolreason_strips_model_thinking_tags_before_projection() {
    let mut payload = json!({
        "output": [
            {"type":"function_call","name":"cat","arguments":"{}"},
            {"type":"message","content":[{"type":"output_text","text":"<toolreason>{\"reason\":\"***<think>检查目标文件</think>***\",\"goal_alignment_confidence\":100}</toolreason>"}]}
        ]
    });

    map_v3_toolreason_to_reasoning_content_at_resp03(&mut payload, true);

    assert_eq!(payload["output"][1]["type"], "message");
    assert_eq!(payload["output"][1]["content"][0]["text"], "");
    assert!(!payload.to_string().contains("<think>"));
    assert!(!payload.to_string().contains("</think>"));
    assert!(!payload.to_string().contains("toolreason"));
}

#[test]
fn resp03_strips_orphan_toolreason_close_and_responses_output_text_marker() {
    let mut payload = json!({
        "output_text": "visible</toolreason>",
        "output": [{
            "type": "message",
            "content": [{"type": "output_text", "text": "answer<toolreason>inspect state"}]
        }, {
            "type": "function_call",
            "name": "inspect_state"
        }]
    });

    map_v3_toolreason_to_reasoning_content_at_resp03(&mut payload, true);

    assert_eq!(payload["output_text"], "visible");
    assert_eq!(payload["output"][0]["content"][0]["text"], "answer");
    assert!(!payload.to_string().contains("<toolreason>"));
    assert!(!payload.to_string().contains("</toolreason>"));
}

#[test]
fn resp03_toolreason_without_tool_call_is_hard_stripped_without_reasoning_guess() {
    let mut payload = json!({
        "choices":[{"message":{
            "role":"assistant",
            "content":"<toolreason>Do something.</toolreason>"
        }}]
    });
    map_v3_toolreason_to_reasoning_content_at_resp03(&mut payload, true);
    let message = &payload["choices"][0]["message"];
    assert_eq!(message["content"], "");
    assert_eq!(message.get("reasoning_content"), None);
    assert!(!payload.to_string().contains("toolreason"));
}

#[test]
fn resp03_toolreason_placeholder_is_missing_not_visible_reasoning() {
    let mut payload = json!({
        "choices": [{
            "message": {
                "content": "<toolreason>...</toolreason>",
                "tool_calls": [{"function": {"name": "exec_command"}}]
            }
        }]
    });

    map_v3_toolreason_to_reasoning_content_at_resp03(&mut payload, true);

    let message = &payload["choices"][0]["message"];
    assert_eq!(message.get("reasoning_content"), None);
    assert!(!payload.to_string().contains("toolreason"));
}

#[test]
fn resp03_toolreason_prompt_fragment_and_mapped_reasoning_are_missing() {
    for reason in [
        "，填入这一次调用的真实当前动机，再输出结束标签",
        "具体动机、结束标签",
        "调用工具 exec_command：获取当前工作目录",
    ] {
        let mut payload = json!({
            "choices": [{
                "message": {
                    "content": format!("<toolreason>{reason}</toolreason>"),
                    "tool_calls": [{"function": {"name": "exec_command"}}]
                }
            }]
        });

        map_v3_toolreason_to_reasoning_content_at_resp03(&mut payload, true);

        assert_eq!(
            payload["choices"][0]["message"].get("reasoning_content"),
            None
        );
    }
}

/* legacy fence/text contract removed: native tool-argument JSON is the only source */
/*
    let reason_frame = format!(
        "data: {}\r\n\r\n",
        json!({
            "type": "response.output_text.done",
            "output_index": 0,
            "text": "<toolreason>确认当前工作目录</toolreason>"
        })
    );
    let first_tool_frame = format!(
        "data: {}\n\n",
        json!({
            "type": "response.output_item.done",
            "output_index": 0,
            "item": {
                "type": "function_call",
                "call_id": "call_1",
                "name": "exec_command",
                "arguments": "{\"cmd\":\"pwd\"}"
            }
        })
    );
    let second_tool_frame = format!(
        "data: {}\n\n",
        json!({
            "type": "response.output_item.done",
            "output_index": 1,
            "item": {
                "type": "function_call",
                "call_id": "call_2",
                "name": "read_file",
                "arguments": "{\"path\":\"config.toml\"}"
            }
        })
    );
    let split = reason_frame
        .find("<toolreason>")
        .expect("reason frame must contain the marker");
    let mut buffer = Vec::new();
    let mut tool_names = Vec::new();
    let mut pending_reasons = Vec::new();
    let mut reason_emitted = false;
    let mut output = project_v3_toolreason_sse_chunk_at_resp03(
        &mut buffer,
        &mut tool_names,
        &mut pending_reasons,
        &mut reason_emitted,
        reason_frame[..split].as_bytes(),
    );
    output.extend(project_v3_toolreason_sse_chunk_at_resp03(
        &mut buffer,
        &mut tool_names,
        &mut pending_reasons,
        &mut reason_emitted,
        reason_frame[split..].as_bytes(),
    ));
    output.extend(project_v3_toolreason_sse_chunk_at_resp03(
        &mut buffer,
        &mut tool_names,
        &mut pending_reasons,
        &mut reason_emitted,
        first_tool_frame.as_bytes(),
    ));
    output.extend(project_v3_toolreason_sse_chunk_at_resp03(
        &mut buffer,
        &mut tool_names,
        &mut pending_reasons,
        &mut reason_emitted,
        second_tool_frame.as_bytes(),
    ));

    let output = String::from_utf8(output).expect("projected SSE must remain UTF-8");
    assert!(!output.contains("toolreason"));
    assert_eq!(output.matches("event: response.reasoning_summary_text.delta").count(), 1);
    assert!(output.contains("\"type\":\"reasoning\""));
    assert!(output.contains("\"summary\":[{\"text\":"));
    assert!(output.contains("确认当前工作目录"));
    assert!(output.contains("\"type\":\"function_call\""));
    assert!(output.contains("\"call_id\":\"call_1\""));
    assert!(output.contains("\"call_id\":\"call_2\""));
    assert!(output.contains("{\\\"cmd\\\":\\\"pwd\\\"}"));
    assert!(output.contains("{\\\"path\\\":\\\"config.toml\\\"}"));
}

#[test]
fn direct_sse_post_call_toolreason_waits_past_tool_done_and_maps_once() {
    let tool_frame = format!(
        "data: {}\n\n",
        json!({
            "type": "response.output_item.done",
            "output_index": 0,
            "item": {
                "type": "function_call",
                "call_id": "call_post_1",
                "name": "exec_command",
                "arguments": "{\"cmd\":\"pwd\"}"
            }
        })
    );
    let message_frame = format!(
        "data: {}\n\n",
        json!({
            "type": "response.output_item.done",
            "output_index": 1,
            "item": {
                "type": "message",
                "content": [{"type": "output_text", "text": "<toolreason>确认当前工作目录</toolreason>"}]
            }
        })
    );
    let mut buffer = Vec::new();
    let mut tool_names = Vec::new();
    let mut pending_reasons = Vec::new();
    let mut reason_emitted = false;

    let mut output = project_v3_toolreason_sse_chunk_at_resp03(
        &mut buffer,
        &mut tool_names,
        &mut pending_reasons,
        &mut reason_emitted,
        tool_frame.as_bytes(),
    );
    output.extend(project_v3_toolreason_sse_chunk_at_resp03(
        &mut buffer,
        &mut tool_names,
        &mut pending_reasons,
        &mut reason_emitted,
        message_frame.as_bytes(),
    ));

    let output = String::from_utf8(output).expect("projected SSE must remain UTF-8");
    assert!(!output.contains("toolreason"));
    assert_eq!(
        output
            .matches("event: response.reasoning_summary_text.delta")
            .count(),
        1
    );
    assert!(output.contains("确认当前工作目录"));
    assert!(output.contains("call_post_1"));
    assert!(
        reason_emitted,
        "post-call reason must be mapped when its message item closes"
    );
}

#[test]
fn direct_sse_terminal_toolreason_projects_when_reason_arrives_after_tool_done() {
    let tool_frame = format!(
        "data: {}\n\n",
        json!({
            "type": "response.output_item.done",
            "output_index": 0,
            "item": {"type": "function_call", "call_id": "call_terminal", "name": "cat", "arguments": "{}"}
        })
    );
    let reason_frame = format!(
        "data: {}\n\n",
        json!({
            "type": "response.output_text.delta",
            "output_index": 1,
            "delta": "<toolreason>读取目标文件</toolreason>"
        })
    );
    let completed_frame = format!(
        "data: {}\n\n",
        json!({
            "type": "response.completed",
            "response": {"output": [{"type": "function_call", "name": "cat", "arguments": "{}"}]}
        })
    );
    let mut buffer = Vec::new();
    let mut tool_names = Vec::new();
    let mut pending_reasons = Vec::new();
    let mut reason_emitted = false;
    let mut output = project_v3_toolreason_sse_chunk_at_resp03(
        &mut buffer, &mut tool_names, &mut pending_reasons, &mut reason_emitted, tool_frame.as_bytes()
    );
    output.extend(project_v3_toolreason_sse_chunk_at_resp03(
        &mut buffer, &mut tool_names, &mut pending_reasons, &mut reason_emitted, reason_frame.as_bytes()
    ));
    output.extend(project_v3_toolreason_sse_chunk_at_resp03(
        &mut buffer, &mut tool_names, &mut pending_reasons, &mut reason_emitted, completed_frame.as_bytes()
    ));
    let output = String::from_utf8(output).expect("projected SSE must remain UTF-8");
    assert!(output.contains("\"type\":\"reasoning\""));
    assert!(output.contains("读取目标文件"));
    assert!(!output.contains("toolreason"));
    assert!(reason_emitted);
}

*/
#[test]
fn direct_sse_native_reasoning_is_not_reprojected_as_toolreason() {
    let completed_frame = format!(
        "data: {}\n\n",
        json!({
            "type": "response.completed",
            "response": {"output": [
                {"id":"native_reasoning_1","type":"reasoning","status":"completed","summary":[{"type":"summary_text","text":"原生模型思考"}]},
                {"type":"function_call","name":"cat","arguments":"{}"}
            ]}
        })
    );
    let mut buffer = Vec::new();
    let mut tool_names = Vec::new();
    let mut pending_reasons = Vec::new();
    let mut reason_emitted = false;
    let output = project_v3_toolreason_sse_chunk_at_resp03(
        &mut buffer,
        &mut tool_names,
        &mut pending_reasons,
        &mut reason_emitted,
        completed_frame.as_bytes(),
    );
    let output = String::from_utf8(output).expect("projected SSE must remain UTF-8");
    // The native reasoning item remains transparent to the client. It must
    // not be re-emitted as a toolreason summary event.
    assert!(output.contains("原生模型思考"));
    assert!(!output.contains("response.reasoning_summary_text.delta"));
    assert!(output.contains("\"type\":\"reasoning\""));
    assert!(
        reason_emitted,
        "the tool call still receives one missing observation"
    );
}

#[test]
fn direct_sse_reasoning_done_gets_client_reasoning_lifecycle_before_original_done() {
    let reasoning_done = format!(
        "data: {}\n\n",
        json!({
            "type": "response.output_item.done",
            "output_index": 0,
            "item": {
                "id": "rs_toolreason_1",
                "type": "reasoning",
                "status": "completed",
                "summary": [
                    {"type": "summary_text", "text": "自然思考"},
                    {"type": "summary_text", "text": "调用工具 cat：读取目标文件"}
                ]
            }
        })
    );
    let mut buffer = Vec::new();
    let mut tool_names = vec!["cat".to_string()];
    let mut pending_reasons = Vec::new();
    let mut reason_emitted = true;

    let output = project_v3_toolreason_sse_chunk_at_resp03(
        &mut buffer,
        &mut tool_names,
        &mut pending_reasons,
        &mut reason_emitted,
        reasoning_done.as_bytes(),
    );
    let output = String::from_utf8(output).expect("projected SSE must remain UTF-8");
    let added = output
        .find("event: response.output_item.added")
        .expect("client reasoning lifecycle must start with output_item.added");
    let done_marker = "\"type\":\"response.output_item.done\"";
    assert!(
        output.matches(done_marker).count() >= 2,
        "projected and original reasoning done frames must both be present: {output}"
    );
    let original_done = output
        .rfind(done_marker)
        .expect("original reasoning done frame must remain");
    assert!(added < original_done);
    assert!(output.contains("event: response.reasoning_summary_text.delta"));
    assert!(output.contains("调用工具 cat：读取目标文件"));
    assert!(!output.contains("<toolreason>"));
}

#[test]
fn direct_sse_plain_output_text_is_not_toolreason_without_fence() {
    let text_frame = format!(
        "data: {}\n\n",
        json!({
            "type": "response.output_text.delta",
            "output_index": 0,
            "delta": "普通模型输出，不是工具调用说明"
        })
    );
    let call_frame = format!(
        "data: {}\n\n",
        json!({
            "type": "response.output_item.done",
            "output_index": 0,
            "item": {"type": "function_call", "name": "cat", "arguments": "{}"}
        })
    );
    let mut buffer = Vec::new();
    let mut tool_names = Vec::new();
    let mut pending_reasons = Vec::new();
    let mut reason_emitted = false;
    let mut output = project_v3_toolreason_sse_chunk_at_resp03(
        &mut buffer,
        &mut tool_names,
        &mut pending_reasons,
        &mut reason_emitted,
        text_frame.as_bytes(),
    );
    output.extend(project_v3_toolreason_sse_chunk_at_resp03(
        &mut buffer,
        &mut tool_names,
        &mut pending_reasons,
        &mut reason_emitted,
        call_frame.as_bytes(),
    ));
    let output = String::from_utf8(output).expect("projected SSE must remain UTF-8");
    assert!(output.contains("普通模型输出，不是工具调用说明"));
    assert!(!output.contains("response.reasoning_summary_text.delta"));
    assert!(
        reason_emitted,
        "the tool call still receives one missing observation"
    );
}

#[test]
fn direct_sse_strips_legacy_toolreason_fence_from_message_item() {
    let message_done = format!(
        "data: {}\n\n",
        json!({
            "type": "response.output_item.done",
            "output_index": 1,
            "item": {
                "type": "message",
                "role": "assistant",
                "content": [{
                    "type": "output_text",
                    "text": "<toolreason>{\"reason\":\"打印当前工作目录\",\"goal_alignment_confidence\":100}</toolreason>"
                }]
            }
        })
    );
    let mut buffer = Vec::new();
    let mut tool_names = vec!["exec_command".to_string()];
    let mut pending_reasons = Vec::new();
    let mut reason_emitted = false;

    let output = project_v3_toolreason_sse_chunk_at_resp03(
        &mut buffer,
        &mut tool_names,
        &mut pending_reasons,
        &mut reason_emitted,
        message_done.as_bytes(),
    );
    let output = String::from_utf8(output).expect("projected SSE must remain UTF-8");

    assert!(
        !output.contains("<toolreason>"),
        "legacy fence leaked: {output}"
    );
    assert!(
        !output.contains("goal_alignment_confidence"),
        "schema leaked: {output}"
    );
    assert!(
        !output.contains("打印当前工作目录"),
        "unmapped fence reason leaked: {output}"
    );
}

#[test]
fn direct_sse_toolreason_delta_is_stripped_before_client_projection() {
    let delta_frame = format!(
        "data: {}\n\n",
        json!({
            "type": "response.output_text.delta",
            "delta": "<toolreason>Inspect workspace</toolreason>"
        })
    );
    let mut buffer = Vec::new();
    let mut tool_names = vec!["exec_command".to_string()];
    let mut pending_reasons = Vec::new();
    let mut reason_emitted = false;

    let output = project_v3_toolreason_sse_chunk_at_resp03(
        &mut buffer,
        &mut tool_names,
        &mut pending_reasons,
        &mut reason_emitted,
        delta_frame.as_bytes(),
    );

    let output = String::from_utf8(output).expect("projected SSE must remain UTF-8");
    assert!(!output.contains("toolreason"));
    assert!(!output.contains("Inspect workspace"));
    assert!(output.contains("\"delta\":\"\""));
}

#[test]
fn direct_sse_toolreason_closeout_logs_missing_when_no_done_event_arrives() {
    let tool_frame = format!(
        "data: {}\n\n",
        json!({
            "type": "response.output_item.added",
            "output_index": 0,
            "item": {
                "type": "function_call",
                "call_id": "call_closeout_1",
                "name": "exec_command",
                "arguments": "{}"
            }
        })
    );
    let mut buffer = Vec::new();
    let mut tool_names = Vec::new();
    let mut pending_reasons = Vec::new();
    let mut reason_emitted = false;

    let output = project_v3_toolreason_sse_chunk_at_resp03(
        &mut buffer,
        &mut tool_names,
        &mut pending_reasons,
        &mut reason_emitted,
        tool_frame.as_bytes(),
    );
    assert!(String::from_utf8(output)
        .expect("projected SSE must remain UTF-8")
        .contains("call_closeout_1"));
    assert_eq!(tool_names, vec![""]);
    assert!(!reason_emitted);

    finalize_v3_toolreason_observation_at_resp03_with_context(
        &tool_names,
        &mut pending_reasons,
        &mut reason_emitted,
        V3ToolreasonObservationContext {
            session_id: Some("session_closeout_1"),
            request_id: Some("request_closeout_1"),
        },
    );
    assert!(
        reason_emitted,
        "turn closeout must account for the tool call"
    );
}

#[test]
fn resp03_anthropic_text_toolreason_maps_against_tool_use() {
    let mut payload = json!({
        "role":"assistant",
        "content":[
            {"type":"text","text":"<toolreason>Need lookup.</toolreason>"},
            {"type":"tool_use","id":"tool_1","name":"lookup","input":{}}
        ]
    });
    map_v3_toolreason_to_reasoning_content_at_resp03(&mut payload, true);
    assert!(payload.get("reasoning_content").is_none());
    assert_eq!(payload["content"][0]["text"], "");
    assert!(!payload.to_string().contains("toolreason"));
}

#[test]
fn resp03_anthropic_thinking_fence_maps_without_replacing_native_thinking() {
    let mut payload = json!({
        "output": [
            {
                "type": "reasoning",
                "summary": [{
                    "type": "summary_text",
                    "text": "先检查环境。<toolreason>{\"reason\":\"确认当前工作目录\",\"goal_alignment_confidence\":100}</toolreason>继续思考。"
                }]
            },
            {"type":"function_call", "name":"pwd", "call_id":"call_pwd", "arguments":"{}"}
        ]
    });

    map_v3_toolreason_to_reasoning_content_at_resp03(&mut payload, true);

    assert_eq!(
        payload["output"][0]["summary"][0]["text"],
        "先检查环境。继续思考。"
    );
    assert_eq!(payload["output"][1]["type"], "function_call");
    assert!(!payload.to_string().contains("toolreason"));
}

#[test]
fn resp03_anthropic_native_thinking_without_fence_stays_native() {
    let mut payload = json!({
        "output": [
            {
                "type": "reasoning",
                "summary": [{"type":"summary_text", "text":"原生模型思考"}]
            },
            {"type":"function_call", "name":"pwd", "call_id":"call_pwd", "arguments":"{}"}
        ]
    });

    map_v3_toolreason_to_reasoning_content_at_resp03(&mut payload, true);

    assert_eq!(payload["output"].as_array().map(Vec::len), Some(2));
    assert_eq!(payload["output"][0]["summary"][0]["text"], "原生模型思考");
    assert!(!payload.to_string().contains("toolreason"));
}

#[test]
fn resp03_rejects_prompt_placeholder_as_toolreason() {
    let mut payload = json!({
        "output": [
            {"type":"message", "content":[{"type":"output_text", "text":"<toolreason>+ 一句真实、具体、简短的当前动机 +</toolreason>"}]},
            {"type":"function_call", "name":"exec_command", "call_id":"call_placeholder", "arguments":"{}"}
        ]
    });

    map_v3_toolreason_to_reasoning_content_at_resp03(&mut payload, true);

    assert_eq!(payload.pointer("/output/0/reasoning_content"), None);
    assert_eq!(
        payload
            .pointer("/output/0/content/0/text")
            .and_then(Value::as_str),
        Some("")
    );
}

#[test]
fn responses_resp03_accepts_registered_incomplete_terminal_and_rejects_malformed_details() {
    for reason in ["max_output_tokens", "content_filter"] {
        let governance = build_v3_responses_resp03_protocol_governance(&json!({
            "status":"incomplete",
            "incomplete_details":{"reason":reason},
            "output":[]
        }))
        .expect("registered Responses incomplete reason must remain a terminal response");
        assert_eq!(
            governance.status_terminality,
            V3HubResponseTerminality::Terminal
        );
    }

    for payload in [
        json!({"status":"incomplete","output":[]}),
        json!({"status":"incomplete","incomplete_details":{"reason":"internal_error"},"output":[]}),
    ] {
        let error = match build_v3_responses_resp03_protocol_governance(&payload) {
            Ok(_) => {
                panic!("malformed Responses incomplete details must fail at typed terminal owner")
            }
            Err(error) => error,
        };
        assert!(matches!(
            error,
            V3HubRelayResponseError::InvalidIncompleteDetails { .. }
        ));
    }
}

#[test]
fn resp03_recursive_strips_codex_ciphers_but_keeps_anthropic_signature() {
    // recursive 层按值前缀区分：Codex 密文（rsn_ / gAAAA 开头）丢弃（客户端
    // 透明无感知）；anthropic 链的 thinking signature 载体（redacted_thinking.data
    // / thinking.signature，值不是 rsn_/gAAAA 前缀）保留给客户端做签名校验。
    let mut payload = json!({
        "id": "resp_mixed_ciphers",
        "status": "completed",
        "output": [
            {
                "type": "reasoning",
                "id": "rs_rsn",
                "encrypted_content": "rsn_KEEP_MARKER",
                "summary": [{"type": "summary_text", "text": "rsn plain"}]
            },
            {
                "type": "reasoning",
                "id": "rs_gaaaa",
                "encrypted_content": "gAAAAABqdG2IiB8zk0noWkFn0EuwCPiNRjdGDTNeOEH",
                "summary": [{"type": "summary_text", "text": "gaaaa plain"}]
            },
            {
                "type": "reasoning",
                "id": "rs_sig",
                "encrypted_content": "sig-anthropic-signature",
                "summary": [{"type": "summary_text", "text": "signed thought"}]
            },
            {
                "type": "reasoning",
                "id": "rs_resp04",
                "encrypted_content": "resp04-signature",
                "summary": [{"type": "summary_text", "text": "resp04 plain"}]
            }
        ]
    });

    routecodex_v3_provider_responses::apply_v3_response_cipher_policy(&mut payload, false);

    let output = payload["output"].as_array().unwrap();
    // rsn_ / gAAAA Codex 密文剥离，明文 summary 保留。
    assert!(
        !output[0].to_string().contains("encrypted_content"),
        "rsn_ 密文必须剥离: {}",
        output[0]
    );
    assert_eq!(output[0]["summary"][0]["text"], "rsn plain");
    assert!(
        !output[1].to_string().contains("encrypted_content"),
        "gAAAA Codex 密文必须剥离: {}",
        output[1]
    );
    assert_eq!(output[1]["summary"][0]["text"], "gaaaa plain");
    // anthropic thinking signature 载体必须保留（非 rsn_/gAAAA 前缀）。
    assert_eq!(
        output[2]["encrypted_content"], "sig-anthropic-signature",
        "anthropic thinking signature 载体不得被剥离"
    );
    assert_eq!(output[2]["summary"][0]["text"], "signed thought");
    assert_eq!(
        output[3]["encrypted_content"], "resp04-signature",
        "anthropic thinking signature 载体不得被剥离"
    );
}

#[test]
fn resp03_anthropic_signature_survives_govern_path() {
    // anthropic 链的 thinking signature（非 rsn_/gAAAA 前缀）在完整 govern
    // 路径（strip -> harvest -> repair）后仍保留，客户端可用它做签名校验。
    let payload = json!({
        "id": "msg_anthropic_sig",
        "type": "message",
        "role": "assistant",
        "content": [
            {"type": "text", "text": "signed thought"},
            {"type": "redacted_thinking", "data": "sig-anthropic-signature"}
        ],
        "stop_reason": "end_turn"
    });
    let resp01 = build_v3_provider_resp_inbound_01_raw(
        payload,
        V3HubEntryProtocol::Responses,
        V3HubProviderWireProtocol::Anthropic,
        V3HubContinuationOwnership::New,
        V3HubExecutionMode::Relay,
        V3HubInvocationSource::Client,
        V3HubTransportIntent::Json,
    );
    let compat = build_provider_resp_compat_02_from_v3_provider_resp_inbound_01(resp01).unwrap();
    let resp02 = build_v3_hub_resp_inbound_02_from_provider_resp_compat_02(compat).unwrap();
    let stripped = strip_v3_resp03_encrypted_reasoning_content(resp02, false);

    let payload = serde_json::to_string(&*stripped.previous.previous.payload.0).unwrap();
    assert!(
        payload.contains("sig-anthropic-signature"),
        "anthropic thinking signature 载体不得被剥离: {payload}"
    );
    assert!(payload.contains("signed thought"));
}
