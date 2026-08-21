// resp_chat_process_03_governed 密文治理测试,拆分自 resp_chat_process_03_governed.rs
// 以满足 verify:v3-file-size。语义不变:`use super::*` 与内联 mod tests 等价。

use super::*;

#[test]
fn resp03_toolreason_maps_to_visible_reasoning_content_and_is_removed_from_text() {
    let mut payload = json!({
        "choices":[{"message":{
            "role":"assistant",
            "content":"<toolreason>Need inspect the file.</toolreason>",
            "tool_calls":[{"id":"call_1","type":"function","function":{"name":"exec","arguments":"{}"}}]
        }}]
    });
    map_v3_toolreason_to_reasoning_content_at_resp03(&mut payload, true);
    let message = &payload["choices"][0]["message"];
    assert_eq!(
        message["reasoning_content"],
        "◦ 调用工具 exec，因为 Need inspect the file."
    );
    assert_eq!(message["content"], "");
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
    assert_eq!(
        message["reasoning_content"],
        "◦ 调用工具 cat、test，因为 Inspect file."
    );
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

    assert_eq!(
        payload["output"][2]["reasoning_content"],
        "◦ 调用工具 pwd、read_file，因为 确认工具结果所需的工作状态"
    );
    assert_eq!(payload["output"][2]["content"][0]["text"], "");
    assert_eq!(payload["output"][0]["name"], "exec_command");
    assert_eq!(payload["output"][1]["name"], "read_file");
    assert!(!payload.to_string().contains("toolreason"));
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
    assert_eq!(
        payload["output"][1]["reasoning_content"],
        "◦ 调用工具 curl，因为 检查服务健康状态"
    );
    assert!(!payload.to_string().contains("调用工具 exec_command"));
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
        "◦ 调用工具 exec_command，因为 获取当前工作目录",
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

#[test]
fn direct_sse_toolreason_maps_one_reason_per_turn_and_preserves_tool_calls() {
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
    assert_eq!(output.matches("event: response.output_text.delta").count(), 1);
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
    assert_eq!(output.matches("reasoning_content").count(), 1);
    assert!(output.contains("确认当前工作目录"));
    assert!(output.contains("call_post_1"));
    assert!(
        reason_emitted,
        "post-call reason must be mapped when its message item closes"
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
    assert_eq!(tool_names, vec!["exec_command|"]);
    assert!(!reason_emitted);

    finalize_v3_toolreason_observation_at_resp03(
        &tool_names,
        &mut pending_reasons,
        &mut reason_emitted,
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
    assert_eq!(
        payload["reasoning_content"],
        "◦ 调用工具 lookup，因为 Need lookup."
    );
    assert_eq!(payload["content"][0]["text"], "");
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
