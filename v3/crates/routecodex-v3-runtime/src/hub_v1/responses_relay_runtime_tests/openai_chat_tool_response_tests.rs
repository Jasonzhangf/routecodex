use super::*;

#[test]
fn openai_chat_custom_tool_response_round_trips_to_responses_custom_call() {
    let response = build_v3_responses_provider_response_from_openai_chat_payload(
        &json!({
            "id": "chatcmpl_apply_patch",
            "choices": [{
                "message": {
                    "role": "assistant",
                    "content": "",
                    "tool_calls": [{
                        "id": "call_apply_patch",
                        "type": "custom",
                        "custom": {
                            "name": "apply_patch",
                            "input": "*** Begin Patch\n*** End Patch"
                        }
                    }]
                },
                "finish_reason": "tool_calls"
            }]
        }),
        &json!({
            "tools": [{
                "type":"custom",
                "name":"apply_patch",
                "format":{"type":"grammar","syntax":"lark","definition":"start: patch"}
            }]
        }),
    )
    .expect("Chat function projection must reverse to the declared Responses custom tool");

    assert_eq!(response["status"], "requires_action");
    assert_eq!(response["output"][0]["type"], "custom_tool_call");
    assert_eq!(response["output"][0]["name"], "apply_patch");
    assert_eq!(
        response["output"][0]["input"],
        "*** Begin Patch\n*** End Patch"
    );
}

#[test]
fn openai_chat_function_tool_call_with_custom_declared_name_round_trips_as_custom_call() {
    let response = build_v3_responses_provider_response_from_openai_chat_payload(
        &json!({
            "id": "chatcmpl_apply_patch_flattened",
            "choices": [{
                "message": {
                    "role": "assistant",
                    "content": "",
                    "tool_calls": [{
                        "id": "call_apply_patch_2",
                        "type": "function",
                        "function": {
                            "name": "apply_patch",
                            "arguments": "{\"input\":\"*** Begin Patch\\n*** End Patch\",\"reason\":\"修改目标文件\",\"goal_alignment_confidence\":100,\"model_id\":\"gpt-test\"}"
                        }
                    }]
                },
                "finish_reason": "tool_calls"
            }]
        }),
        &json!({
            "tools": [{"type":"custom","name":"apply_patch"}]
        }),
    )
    .expect("flattened function tool_call must reverse to the declared Responses custom tool");

    assert_eq!(response["status"], "requires_action");
    assert_eq!(response["output"][0]["type"], "custom_tool_call");
    assert_eq!(response["output"][0]["name"], "apply_patch");
    assert_eq!(
        response["output"][0]["input"],
        "*** Begin Patch\n*** End Patch"
    );
}

#[test]
fn openai_chat_provider_structured_reasoning_keeps_summary_encrypted_and_replay_content() {
    let response = build_v3_responses_provider_response_from_openai_chat_payload(
        &json!({
            "id": "chatcmpl_structured_reasoning",
            "choices": [{
                "message": {
                    "role": "assistant",
                    "content": "visible answer",
                    "reasoning": {
                        "summary": [{"type":"summary_text","text":"safe summary"}],
                        "content": [{"type":"reasoning_text","text":"private chain"}],
                        "encrypted_content": "enc-opaque"
                    }
                },
                "finish_reason": "stop"
            }]
        }),
        &json!({"tools":[]}),
    )
    .expect("OpenAI Chat structured reasoning must project to Responses");

    assert_eq!(response["status"], "completed");
    assert_eq!(response["output"][0]["type"], "reasoning");
    assert_eq!(response["output"][0]["summary"][0]["text"], "safe summary");
    assert_eq!(response["output"][0]["encrypted_content"], "enc-opaque");
    assert_eq!(
        response["output"][0]["content"][0]["text"], "safe summary",
        "Responses reasoning item must carry replay-safe plaintext content"
    );
    assert_eq!(response["output"][1]["type"], "output_text");
    assert_eq!(response["output"][1]["text"], "visible answer");
    assert!(
        !response.to_string().contains("private chain"),
        "private reasoning.content must not be serialized into the client payload: {response}"
    );
}

#[test]
fn openai_chat_provider_usage_normalizes_to_hub_canonical_token_names() {
    let response = build_v3_responses_provider_response_from_openai_chat_payload(
        &json!({
            "id": "chatcmpl_usage_shape",
            "choices": [{
                "message": {"role": "assistant", "content": "ok"},
                "finish_reason": "stop"
            }],
            "usage": {
                "prompt_tokens": 11,
                "prompt_tokens_details": {"cached_tokens": 5},
                "completion_tokens": 7,
                "completion_tokens_details": {"reasoning_tokens": 2},
                "total_tokens": 18
            }
        }),
        &json!({"tools":[]}),
    )
    .expect("OpenAI Chat response must project to Responses");

    assert_eq!(response["usage"]["input_tokens"], 11);
    assert_eq!(
        response["usage"]["input_tokens_details"]["cached_tokens"],
        5
    );
    assert_eq!(response["usage"]["output_tokens"], 7);
    assert_eq!(
        response["usage"]["output_tokens_details"]["reasoning_tokens"],
        2
    );
    assert_eq!(response["usage"]["total_tokens"], 18);
    assert!(
            response["usage"].get("prompt_tokens").is_none(),
            "Hub canonical response usage must not expose OpenAI Chat provider-wire prompt_tokens: {response}"
        );
    assert!(
            response["usage"].get("completion_tokens").is_none(),
            "Hub canonical response usage must not expose OpenAI Chat provider-wire completion_tokens: {response}"
        );
}
