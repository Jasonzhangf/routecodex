// resp_chat_process_03_governed 密文治理测试,拆分自 resp_chat_process_03_governed.rs
// 以满足 verify:v3-file-size。语义不变:`use super::*` 与内联 mod tests 等价。

use super::*;

#[test]
fn resp03_records_typed_toolreason_observation_for_relay_missing_and_ok() {
    let observation = V3RuntimeStreamObservation::default();
    let missing = serde_json::json!({
        "output": [{"type":"function_call","name":"exec","arguments":"{\"cmd\":\"pwd\"}"}]
    });
    record_v3_toolreason_observation_at_resp03(
        &missing, &observation, Some("s"), Some("r"), Some("m"),
    ).expect("missing observation");
    let snapshot = observation.snapshot().expect("snapshot");
    assert_eq!(snapshot.toolreason.as_ref().map(|v| v.status.as_str()), Some("MISSING"));
    assert_eq!(snapshot.toolreason.as_ref().map(|v| v.stage.as_str()), Some("resp03_json"));

    let ok = serde_json::json!({
        "output": [{"type":"function_call","name":"exec","arguments":"{\"cmd\":\"pwd\",\"reason\":\"确认目录\"}"}]
    });
    record_v3_toolreason_observation_at_resp03(
        &ok, &observation, Some("s"), Some("r2"), Some("m"),
    ).expect("ok observation");
    let snapshot = observation.snapshot().expect("snapshot");
    assert_eq!(snapshot.toolreason.as_ref().map(|v| v.status.as_str()), Some("OK"));
    assert_eq!(snapshot.toolreason.as_ref().and_then(|v| v.reason.as_deref()), Some("确认目录"));
}

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
fn resp03_completed_response_strips_and_creates_one_reasoning_item() {
    let mut payload = json!({
        "type": "response.completed",
        "response": {
            "id": "resp_completed",
            "output": [{
                "id": "call_completed",
                "type": "function_call",
                "name": "exec_command",
                "call_id": "call_completed",
                "arguments": "{\"cmd\":\"pwd\",\"reason\":\"确认当前工作目录\",\"goal_alignment_confidence\":100,\"model_id\":\"x-preview-f-free\"}"
            }]
        }
    });
    let mut tool_names = Vec::new();
    let mut pending_reasons = Vec::new();
    let mut reason_emitted = false;
    let mut argument_buffers = Vec::new();

    collect_v3_responses_sse_tool_name_at_resp03(&payload, &mut tool_names);
    map_v3_toolreason_stream_event_at_resp03_with_context_and_buffers(
        &mut payload,
        true,
        &tool_names,
        &mut pending_reasons,
        &mut reason_emitted,
        true,
        Some("session-completed"),
        Some("request-completed"),
        Some(&mut argument_buffers),
    );

    let output = payload["response"]["output"].as_array().unwrap();
    let function_call = output
        .iter()
        .find(|item| item["type"] == "function_call")
        .expect("function call must remain in completed response");
    assert_eq!(function_call["arguments"], "{\"cmd\":\"pwd\"}");
    assert_eq!(
        output
            .iter()
            .filter(|item| item["type"] == "reasoning")
            .count(),
        1
    );
    assert_eq!(
        output
            .iter()
            .find(|item| item["type"] == "reasoning")
            .unwrap()["summary"][0]["text"],
        "调用工具 pwd：确认当前工作目录"
    );
    assert!(reason_emitted);
}

#[test]
fn resp03_completed_non_tool_failure_does_not_become_toolreason_missing() {
    let mut payload = json!({
        "type": "response.completed",
        "response": {
            "id": "resp_network_error",
            "status": "failed",
            "output": []
        }
    });
    let tool_names = vec!["exec_command".to_string()];
    let mut pending_reasons = Vec::new();
    let mut reason_emitted = false;
    let mut argument_buffers = Vec::new();

    map_v3_toolreason_stream_event_at_resp03_with_context_and_buffers(
        &mut payload,
        true,
        &tool_names,
        &mut pending_reasons,
        &mut reason_emitted,
        true,
        Some("session-network-error"),
        Some("request-network-error"),
        Some(&mut argument_buffers),
    );

    assert!(!reason_emitted);
    assert_eq!(payload["response"]["output"], json!([]));
}

#[test]
fn resp03_strips_echoed_auxiliary_schema_fields_without_descriptions() {
    let mut payload = json!({
        "type": "response.completed",
        "response": {
            "tools": [{
                "type": "function",
                "function": {
                    "name": "apply_patch",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "input": {"type": "string"},
                            "goal_alignment_confidence": {"type": "integer"},
                            "model_id": {"type": "string"}
                        },
                        "required": ["input", "goal_alignment_confidence", "model_id"]
                    }
                }
            }]
        }
    });

    map_v3_toolreason_to_reasoning_content_at_resp03(&mut payload, true);

    let parameters = &payload["response"]["tools"][0]["function"]["parameters"];
    assert!(parameters["properties"].get("input").is_some());
    assert!(parameters["properties"]
        .get("goal_alignment_confidence")
        .is_none());
    assert!(parameters["properties"].get("model_id").is_none());
    assert_eq!(parameters["required"], json!(["input"]));
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
fn resp03_responses_argument_deltas_are_hidden_until_done_and_native_args_survive() {
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
            "type": "response.function_call_arguments.delta",
            "output_index": 0,
            "delta": fragment
        });
        map_v3_toolreason_stream_event_at_resp03_with_context_and_buffers_and_expected_model(
            &mut payload,
            true,
            &tool_names,
            &mut pending_reasons,
            &mut reason_emitted,
            true,
            Some("session-responses-delta"),
            Some("request-responses-delta"),
            Some(&mut argument_buffers),
            Some("x-preview-f-free"),
        );
        projected.push(payload);
    }

    let mut done = json!({
        "type": "response.function_call_arguments.done",
        "output_index": 0,
        "arguments": "{}"
    });
    map_v3_toolreason_stream_event_at_resp03_with_context_and_buffers_and_expected_model(
        &mut done,
        true,
        &tool_names,
        &mut pending_reasons,
        &mut reason_emitted,
        true,
        Some("session-responses-delta"),
        Some("request-responses-delta"),
        Some(&mut argument_buffers),
        Some("x-preview-f-free"),
    );

    assert!(projected.iter().all(|payload| {
        payload.get("delta") == Some(&json!(""))
            && !payload.to_string().contains("goal_alignment_confidence")
            && !payload.to_string().contains("model_id")
            && !payload.to_string().contains("\"reason\"")
    }));
    assert_eq!(done["arguments"], "{}");
    assert_eq!(pending_reasons.len(), 1);
    assert!(!reason_emitted);
}

#[test]
fn resp03_responses_missing_toolreason_restores_buffered_native_arguments() {
    let tool_names = vec!["apply_patch".to_string()];
    let mut pending_reasons = Vec::new();
    let mut argument_buffers = Vec::new();
    let mut reason_emitted = false;
    let native_arguments =
        r#"{"patch":"*** Begin Patch\n*** Update File: README.md\n*** End Patch"}"#;

    let mut delta = json!({
        "type": "response.function_call_arguments.delta",
        "output_index": 0,
        "delta": native_arguments
    });
    map_v3_toolreason_stream_event_at_resp03_with_context_and_buffers_and_expected_model(
        &mut delta,
        true,
        &tool_names,
        &mut pending_reasons,
        &mut reason_emitted,
        true,
        Some("session-responses-missing"),
        Some("request-responses-missing"),
        Some(&mut argument_buffers),
        Some("x-preview-f-free"),
    );

    let mut done = json!({
        "type": "response.function_call_arguments.done",
        "output_index": 0,
        "arguments": "{}"
    });
    map_v3_toolreason_stream_event_at_resp03_with_context_and_buffers_and_expected_model(
        &mut done,
        true,
        &tool_names,
        &mut pending_reasons,
        &mut reason_emitted,
        true,
        Some("session-responses-missing"),
        Some("request-responses-missing"),
        Some(&mut argument_buffers),
        Some("x-preview-f-free"),
    );

    assert_eq!(delta["delta"], "");
    assert_eq!(done["arguments"], native_arguments);
    assert!(pending_reasons.is_empty());
    assert!(!reason_emitted);
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
fn resp03_plain_control_text_is_not_a_json_v2_source() {
    let mut payload = json!({
        "choices":[{"message":{
            "role":"assistant",
            "content":"<legacy-control>{\"reason\":\"Need inspect the file.\",\"goal_alignment_confidence\":90}</legacy-control>",
            "tool_calls":[{"id":"call_1","type":"function","function":{"name":"exec","arguments":"{}"}}]
        }}]
    });
    map_v3_toolreason_to_reasoning_content_at_resp03(&mut payload, true);
    let message = &payload["choices"][0]["message"];
    assert_eq!(message["content"], "<legacy-control>{\"reason\":\"Need inspect the file.\",\"goal_alignment_confidence\":90}</legacy-control>");
    assert!(message.get("reasoning_content").is_none());
}

#[test]
fn resp03_plain_responses_text_is_not_projected() {
    let mut payload = json!({
        "output": [
            {"type":"output_text","text":"<legacy-control>{\"reason\":\"Inspect the target file\",\"goal_alignment_confidence\":95,\"model_id\":\"x-preview-f-free\"}</legacy-control>"},
            {"type":"function_call","call_id":"call_1","name":"read_file","arguments":"{}"}
        ]
    });
    map_v3_toolreason_to_reasoning_content_at_resp03(&mut payload, true);
    assert_eq!(payload["output"][0]["type"], "output_text");
    assert_eq!(
        payload["output"][0]["text"]
            .as_str()
            .unwrap()
            .contains("<legacy-control>"),
        true
    );
    assert_eq!(payload["output"][1]["type"], "function_call");
}

#[test]
fn resp03_plain_generic_text_is_not_stripped() {
    let mut payload = json!({
        "output": [
            {"type":"text","text":"<legacy-control>{\"reason\":\"确认当前工作目录\",\"goal_alignment_confidence\":100,\"model_id\":\"x-preview-f-free\"}</legacy-control>"},
            {"type":"function_call","call_id":"call_1","name":"pwd","arguments":"{}"}
        ]
    });

    map_v3_toolreason_to_reasoning_content_at_resp03(&mut payload, true);

    assert!(payload["output"][0]["text"]
        .as_str()
        .unwrap()
        .contains("<legacy-control>"));
    assert_eq!(payload["output"][1]["type"], "function_call");
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
fn resp03_duplicate_native_auxiliary_keys_are_invalid_and_not_projected() {
    let duplicate = r#"{"cmd":"pwd","reason":"确认当前目录","goal_alignment_confidence":100,"model_id":"x-preview-f-free","reason":"获取当前日期","goal_alignment_confidence":100,"model_id":"x-preview-f-free"}"#;
    assert!(json_object_has_duplicate_keys_at_resp03(duplicate));
    assert!(v3_tool_thinking_fields_from_parameter_value_at_resp03(
        &Value::String(duplicate.to_string()),
        None
    )
    .is_none());

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
fn resp03_wrong_wire_model_does_not_block_phase1_reason_projection() {
    let arguments = r#"{"cmd":"pwd","reason":"确认当前目录","goal_alignment_confidence":100,"model_id":"other-model"}"#;
    let mut payload = json!({
        "choices":[{"message":{
            "role":"assistant",
            "tool_calls":[{"id":"call_model_mismatch","type":"function","function":{
                "name":"exec_command","arguments":arguments
            }}]
        }}]
    });

    map_v3_toolreason_to_reasoning_content_at_resp03_with_expected_model_and_context(
        &mut payload,
        true,
        true,
        Some("x-preview-f-free"),
        V3ToolreasonObservationContext {
            session_id: Some("session-model-mismatch"),
            request_id: Some("request-model-mismatch"),
        },
    );

    let call = &payload["choices"][0]["message"]["tool_calls"][0];
    assert_eq!(call["function"]["arguments"], "{\"cmd\":\"pwd\"}");
    assert_eq!(
        payload["choices"][0]["message"]["reasoning_content"],
        "调用工具 pwd：确认当前目录"
    );
}

#[test]
fn resp03_matching_wire_model_strips_and_projects() {
    let mut payload = json!({
        "choices":[{"message":{
            "role":"assistant",
            "tool_calls":[{"id":"call_model_match","type":"function","function":{
                "name":"exec_command","arguments":"{\"cmd\":\"pwd\",\"reason\":\"确认当前目录\",\"goal_alignment_confidence\":100,\"model_id\":\"x-preview-f-free\"}"
            }}]
        }}]
    });

    map_v3_toolreason_to_reasoning_content_at_resp03_with_expected_model_and_context(
        &mut payload,
        true,
        true,
        Some("x-preview-f-free"),
        V3ToolreasonObservationContext {
            session_id: Some("session-model-match"),
            request_id: Some("request-model-match"),
        },
    );

    let function = &payload["choices"][0]["message"]["tool_calls"][0]["function"];
    assert_eq!(function["arguments"], "{\"cmd\":\"pwd\"}");
    assert_eq!(
        payload["choices"][0]["message"]["reasoning_content"],
        "调用工具 pwd：确认当前目录"
    );
}

#[test]
fn resp03_phase1_reason_only_projects_without_optional_diagnostics() {
    let mut payload = json!({
        "output":[{"type":"custom_tool_call","call_id":"call_reason_only",
            "name":"apply_patch","input":"*** Begin Patch\n*** End Patch",
            "reason":"应用用户要求的最小补丁"}]
    });

    map_v3_toolreason_to_reasoning_content_at_resp03_with_expected_model_and_context(
        &mut payload,
        true,
        true,
        Some("MiniMax-M3"),
        V3ToolreasonObservationContext {
            session_id: Some("session-reason-only"),
            request_id: Some("request-reason-only"),
        },
    );

    assert_eq!(
        payload["output"][1]["input"],
        "*** Begin Patch\n*** End Patch"
    );
    assert_eq!(
        payload["output"][0]["summary"][0]["text"],
        "调用工具 apply_patch：应用用户要求的最小补丁"
    );
    assert!(payload["output"][1].get("reason").is_none());
    assert!(payload.get("reasoning_content").is_none());
}

#[test]
fn resp03_custom_tool_wrapper_strips_only_toolreason_fields_and_preserves_raw_input() {
    let raw_patch = "*** Begin Patch\n*** Add File: /tmp/toolreason-test.txt\n+ok\n*** End Patch";
    let mut payload = json!({
        "output":[{"type":"custom_tool_call","call_id":"call_custom_model_match",
            "name":"apply_patch","input":raw_patch,
            "reason":"写入最小补丁验证 custom tool",
            "goal_alignment_confidence":100,
            "model_id":"MiniMax-M3"}]
    });

    map_v3_toolreason_to_reasoning_content_at_resp03_with_expected_model_and_context(
        &mut payload,
        true,
        true,
        Some("MiniMax-M3"),
        V3ToolreasonObservationContext {
            session_id: Some("session-custom-model-match"),
            request_id: Some("request-custom-model-match"),
        },
    );

    assert_eq!(payload["output"][1]["input"], raw_patch);
    assert!(payload["output"][1].get("reason").is_none());
    assert!(payload["output"][1]
        .get("goal_alignment_confidence")
        .is_none());
    assert!(payload["output"][1].get("model_id").is_none());
    assert_eq!(
        payload["output"][0]["summary"][0]["text"],
        "调用工具 apply_patch：写入最小补丁验证 custom tool"
    );
}

#[test]
fn resp03_custom_tool_wrapper_model_mismatch_still_projects_and_preserves_raw_input() {
    let raw_patch = "*** Begin Patch\n*** Add File: /tmp/toolreason-test.txt\n+ok\n*** End Patch";
    let mut payload = json!({
        "output":[{"type":"custom_tool_call","call_id":"call_custom_model_mismatch",
            "name":"apply_patch","input":raw_patch,
            "reason":"写入最小补丁验证 custom tool",
            "goal_alignment_confidence":100,
            "model_id":"other-model"}]
    });
    let before = payload.clone();

    map_v3_toolreason_to_reasoning_content_at_resp03_with_expected_model_and_context(
        &mut payload,
        true,
        true,
        Some("MiniMax-M3"),
        V3ToolreasonObservationContext {
            session_id: Some("session-custom-model-mismatch"),
            request_id: Some("request-custom-model-mismatch"),
        },
    );

    assert_ne!(payload, before);
    assert_eq!(payload["output"][1]["input"], raw_patch);
    assert_eq!(
        payload["output"][0]["summary"][0]["text"],
        "调用工具 apply_patch：写入最小补丁验证 custom tool"
    );
}

#[test]
fn resp03_custom_tool_nested_json_wrapper_projects_reason_and_restores_native_input() {
    let raw_patch = "*** Begin Patch\n*** Update File: src/example.txt\n-old\n+new\n*** End Patch";
    let wrapped_input = serde_json::to_string(&json!({
        "input": raw_patch,
        "reason": "更新用户指定文件",
        "goal_alignment_confidence": 100,
        "model_id": "x-preview-f-free"
    }))
    .expect("custom wrapper must serialize");
    let mut payload = json!({
        "output":[{"type":"custom_tool_call","call_id":"call_custom_nested",
            "name":"apply_patch","input":wrapped_input}]
    });

    map_v3_toolreason_to_reasoning_content_at_resp03_with_expected_model_and_context(
        &mut payload,
        true,
        true,
        Some("x-preview-f-free"),
        V3ToolreasonObservationContext {
            session_id: Some("session-custom-nested"),
            request_id: Some("request-custom-nested"),
        },
    );

    assert_eq!(payload["output"][1]["input"], raw_patch);
    assert!(payload["output"][1].get("reason").is_none());
    assert!(payload["output"][1]
        .get("goal_alignment_confidence")
        .is_none());
    assert!(payload["output"][1].get("model_id").is_none());
    assert_eq!(
        payload["output"][0]["summary"][0]["text"],
        "调用工具 apply_patch：更新用户指定文件"
    );
}

#[test]
fn resp03_custom_tool_malformed_nested_wrapper_is_left_byte_semantically_unchanged() {
    let wrapped_input = r#"{"input":"*** Begin Patch\n*** End Patch","reason":42}"#;
    let mut payload = json!({
        "output":[{"type":"custom_tool_call","call_id":"call_custom_invalid_nested",
            "name":"apply_patch","input":wrapped_input}]
    });
    let before = payload.clone();

    map_v3_toolreason_to_reasoning_content_at_resp03_with_expected_model_and_context(
        &mut payload,
        true,
        true,
        Some("x-preview-f-free"),
        V3ToolreasonObservationContext {
            session_id: Some("session-custom-invalid-nested"),
            request_id: Some("request-custom-invalid-nested"),
        },
    );

    assert_eq!(payload, before);
}

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
fn direct_sse_native_reasoning_done_is_not_toolreason_source() {
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
    let done_marker = "\"type\":\"response.output_item.done\"";
    assert_eq!(output.matches(done_marker).count(), 1);
    assert!(!output.contains("event: response.output_item.added"));
    assert!(!output.contains("event: response.reasoning_summary_text.delta"));
    assert!(output.contains("调用工具 cat：读取目标文件"));
    assert!(!output.contains("<legacy-control>"));
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
fn resp03_terminal_observes_pending_toolreason_without_tool_name() {
    let mut pending_reasons = vec![Some(
        r#"{"cmd":"pwd","reason":"确认当前工作目录"}"#.to_string(),
    )];
    let mut reason_emitted = false;

    finalize_v3_toolreason_observation_at_resp03_with_context(
        &[],
        &mut pending_reasons,
        &mut reason_emitted,
        V3ToolreasonObservationContext {
            session_id: Some("session_missing_tool_name"),
            request_id: Some("request_missing_tool_name"),
        },
    );

    assert!(
        reason_emitted,
        "a completed tool argument is still a governed turn when its display name is absent"
    );
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
