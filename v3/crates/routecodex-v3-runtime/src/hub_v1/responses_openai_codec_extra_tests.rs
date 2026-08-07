use super::*;

#[test]
fn codex_client_metadata_keeps_source_identity_in_chat_extension() {
    let turn_metadata = "x".repeat(577);
    let request = build_v3_chat_canonical_request_from_responses_payload(&json!({
        "model": "gpt-5.5",
        "input": "hello",
        "client_metadata": {
            "session_id": "019fbd31-bb6e-7a43-bfb2-17a1e46ec23b",
            "x-codex-turn-metadata": turn_metadata
        }
    }))
    .expect("Codex client metadata is payload data");

    let extension = &request["routecodex_chat_extension"]["responses_request"];
    assert_eq!(
        extension["client_metadata"]["x-codex-turn-metadata"],
        "x".repeat(577)
    );
    assert!(extension.get("metadata").is_none());
}

#[test]
fn responses_output_text_followed_by_function_call_stays_single_assistant_message() {
    let request = build_v3_chat_canonical_request_from_responses_payload(&json!({
        "model": "deepseek-v4-flash",
        "input": [
            {
                "type": "message",
                "role": "user",
                "content": [{"type": "input_text", "text": "检查没有提交的代码进行提交"}]
            },
            {
                "type": "output_text",
                "text": "These three untracked entries aren't code — they're local tool artifacts:"
            },
            {
                "type": "function_call",
                "call_id": "call_7a486047c3f24ed91528903420a4d962",
                "name": "exec_command",
                "arguments": "{\"cmd\":\"cd /Users/fanzhang/Documents/github/camo && git status\"}"
            },
            {
                "type": "function_call_output",
                "call_id": "call_7a486047c3f24ed91528903420a4d962",
                "output": "On branch main"
            },
            {
                "type": "message",
                "role": "user",
                "content": [{"type": "input_text", "text": "推送到远端"}]
            }
        ]
    }))
    .expect("Responses output_text+function_call must project to Chat");

    let messages = request["messages"].as_array().expect("messages");
    assert_eq!(
        messages.len(),
        4,
        "must not split assistant text and tool_calls: {request}"
    );
    assert_eq!(messages[1]["role"], json!("assistant"));
    assert_eq!(
        messages[1]["content"],
        json!("These three untracked entries aren't code — they're local tool artifacts:")
    );
    assert_eq!(
        messages[1]["tool_calls"][0]["function"]["name"],
        json!("exec_command")
    );
    assert_eq!(messages[2]["role"], json!("tool"));
    assert_eq!(messages[3]["role"], json!("user"));
}

#[test]
fn responses_explicit_assistant_message_then_function_call_coalesces_same_turn() {
    // Codex relay 输入实证（713075 样本）：同轮 assistant 输出以
    // message(role=assistant, content=[output_text]) + function_call 呈现。
    // 合并保持单条 assistant（content + tool_calls），否则 provider chat
    // renderer 插入 EOS 破坏前缀缓存。
    let request = build_v3_chat_canonical_request_from_responses_payload(&json!({
        "model": "gpt-5.5",
        "input": [
            {
                "type": "message",
                "role": "assistant",
                "content": [{"type": "output_text", "text": "turn one"}]
            },
            {
                "type": "function_call",
                "call_id": "call_z",
                "name": "z_tool",
                "arguments": "{}"
            },
            {
                "type": "function_call_output",
                "call_id": "call_z",
                "output": "result"
            }
        ]
    }))
    .expect("assistant message + function_call must project to Chat");

    let messages = request["messages"].as_array().expect("messages");
    assert_eq!(
        messages.len(),
        2,
        "same-turn assistant text and tool_calls must coalesce: {request}"
    );
    assert_eq!(messages[0]["role"], json!("assistant"));
    assert_eq!(messages[0]["content"], json!("turn one"));
    assert_eq!(
        messages[0]["tool_calls"][0]["id"],
        json!("call_z"),
        "function_call after same-turn assistant message must merge into it"
    );
    assert_eq!(messages[1]["role"], json!("tool"));
    assert_eq!(messages[1]["tool_call_id"], json!("call_z"));
}

#[test]
fn responses_two_nonempty_assistant_messages_keep_history_boundaries() {
    let request = build_v3_chat_canonical_request_from_responses_payload(&json!({
        "model": "gpt-5.5",
        "input": [
            {
                "type": "message",
                "role": "assistant",
                "content": [{"type": "output_text", "text": "turn one"}]
            },
            {
                "type": "message",
                "role": "assistant",
                "content": [{"type": "output_text", "text": "turn two"}]
            }
        ]
    }))
    .expect("two assistant messages must project to Chat");

    let messages = request["messages"].as_array().expect("messages");
    assert_eq!(
        messages.len(),
        2,
        "two non-empty assistant messages are independent history, must not coalesce: {request}"
    );
    assert_eq!(messages[0]["content"], json!("turn one"));
    assert_eq!(messages[1]["content"], json!("turn two"));
}

#[test]
fn responses_assistant_message_reasoning_function_call_coalesces_single_turn() {
    // Codex relay 真实形态（样本 713075）：同一 assistant 轮 = message(文本) +
    // reasoning + function_call 连续 items。三者必须合并为单条 assistant
    // （content + reasoning_content + tool_calls），否则相邻 assistant 消息
    // 让 provider chat renderer 插入 EOS，破坏前缀缓存（usage_cache 0%）。
    let request = build_v3_chat_canonical_request_from_responses_payload(&json!({
        "model": "gpt-5.5",
        "input": [
            {
                "type": "message",
                "role": "assistant",
                "content": [{"type": "output_text", "text": "These three untracked entries aren't code — they're local tool artifacts:"}]
            },
            {
                "type": "reasoning",
                "id": "reasoning-1",
                "summary": [{"type": "summary_text", "text": "Need to inspect."}]
            },
            {
                "type": "function_call",
                "call_id": "call_1",
                "name": "exec_command",
                "arguments": "{\"cmd\":\"git status\"}"
            },
            {
                "type": "function_call_output",
                "call_id": "call_1",
                "output": "On branch main"
            },
            {
                "type": "message",
                "role": "user",
                "content": [{"type": "input_text", "text": "继续"}]
            }
        ]
    }))
    .expect("message+reasoning+function_call must project to Chat");

    let messages = request["messages"].as_array().expect("messages");
    assert_eq!(
        messages.len(),
        3,
        "single coalesced assistant + tool + user: {request}"
    );
    assert_eq!(messages[0]["role"], json!("assistant"));
    assert_eq!(
        messages[0]["content"],
        json!("These three untracked entries aren't code — they're local tool artifacts:")
    );
    assert_eq!(messages[0]["reasoning_content"], json!("Need to inspect."));
    assert_eq!(
        messages[0]["tool_calls"][0]["id"],
        json!("call_1"),
        "function_call must merge into same-turn assistant message"
    );
    assert_eq!(messages[1]["role"], json!("tool"));
    assert_eq!(messages[2]["role"], json!("user"));
}
