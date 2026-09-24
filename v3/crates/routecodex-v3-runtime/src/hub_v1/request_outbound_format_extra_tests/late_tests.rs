use super::*;

#[test]
fn openai_chat_wire_projects_local_websearch_for_non_gpt_without_mode() {
    // 非 gpt 模型（deepseek/plain-model 等）即使未配 Mode B（None）：标准
    // web_search 声明统一替换为内部 websearch 工具（不区分 provider、不依赖
    // provider 原生搜索能力——搜索由 RouteCodex 本地 hop 执行）。
    let payload = json!({
        "model": "deepseek-v4-flash",
        "messages": [{"role": "user", "content": "search"}],
        "tools": [
            {
                "type": "web_search",
                "external_web_access": true,
                "search_content_types": ["text"]
            },
            {"type": "function", "function": {"name": "read_file"}}
        ]
    });
    let request = build_v3_openai_chat_standard_request_for_selected_web_search_mode(
        &payload,
        V3WebSearchExecutionMode::None,
        false,
    )
    .expect("non-gpt provider must project the local websearch tool");
    assert!(
        request.get("web_search_options").is_none(),
        "non-gpt provider must not receive hosted web_search_options"
    );
    let tools = request["tools"].as_array().expect("tools retained");
    let websearch = tools
        .iter()
        .find(|tool| {
            tool.get("function")
                .and_then(|f| f.get("name"))
                .and_then(Value::as_str)
                == Some("websearch")
        })
        .expect("non-gpt provider must receive the local websearch tool");
    assert_eq!(
        websearch["function"]["description"],
        "Search the web for up-to-date information."
    );
    assert_eq!(
        tools.len(),
        2,
        "read_file + local websearch must both remain"
    );
}

#[test]
fn continuation_history_prefix_renders_byte_identical_across_requests() {
    let history = vec![
        json!({"role": "user", "content": [
            {"type": "text", "text": "The history question with a screenshot attached"},
            {"type": "text", "text": "[Image]"}
        ]}),
        json!({"role": "assistant", "content": "I can see the image in the history."}),
    ];
    let build_wire = |current: &str| {
        let mut messages = history.clone();
        messages.push(json!({"role": "user", "content": current}));
        build_v3_openai_chat_standard_request_from_chat_canonical(&json!({
            "model": "deepseek-v4-flash",
            "messages": messages
        }))
        .expect("OpenAI Chat wire build")
    };
    let wire_a = build_wire("Reply with exactly: CONTINUE_A");
    let wire_b = build_wire("Reply with exactly: CONTINUE_B");
    assert_eq!(
        wire_a["messages"].as_array().unwrap()[..2],
        wire_b["messages"].as_array().unwrap()[..2],
        "history prefix must render byte-identical for the continuation cache"
    );
    assert_ne!(wire_a["messages"][2], wire_b["messages"][2]);
}

#[test]
fn continuation_assistant_reasoning_round_trips_to_wire_reasoning_content() {
    let reasoning =
        "1. The user asks to reply with exactly CONTINUE_B. No other content is needed.";
    let payload = json!({
        "model": "deepseek-v4-flash",
        "messages": [
            {"role": "user", "content": "Reply with exactly: CONTINUE_A"},
            {"role": "assistant", "content": "CONTINUE_A", "reasoning_content": reasoning},
            {"role": "user", "content": "Reply with exactly: CONTINUE_B"}
        ]
    });
    let request = build_v3_openai_chat_standard_request_from_chat_canonical(&payload)
        .expect("OpenAI Chat wire build");
    assert_eq!(
        request["messages"][1]["reasoning_content"], reasoning,
        "client-echoed assistant reasoning must pass to wire reasoning_content untouched"
    );
    assert_eq!(request["messages"][1]["content"], "CONTINUE_A");
}

#[test]
fn anthropic_interleaved_text_and_tool_calls_keep_responses_input_order() {
    let messages = json!([{
        "role":"assistant",
        "content":[{"type":"text","text":"before"},{"type":"text","text":"after"}],
        "tool_calls":[{"id":"call-1","type":"function","function":{"name":"lookup","arguments":"{}"}}],
        "routecodex_chat_extension":{"anthropic_content_order":[
            {"kind":"content","index":0},
            {"kind":"tool_call","index":0},
            {"kind":"content","index":1}
        ]}
    }]);
    let input = super::build_responses_input_from_chat_messages(messages.as_array().unwrap())
        .expect("Responses input projection");
    assert_eq!(input[0]["type"], "message");
    assert_eq!(input[0]["content"][0]["text"], "before");
    assert_eq!(input[1]["type"], "function_call");
    assert_eq!(input[2]["type"], "message");
    assert_eq!(input[2]["content"][0]["text"], "after");
}

#[test]
fn responses_tool_result_projection_keeps_text_and_consumes_unrepresentable_image() {
    let messages = json!([{
        "role":"tool",
        "tool_call_id":"call-1",
        "content":"found",
        "routecodex_chat_extension":{"anthropic_tool_result_content":[
            {"type":"text","text":"found"},
            {"type":"image","source":{"type":"url","url":"https://example.invalid/image"}}
        ]}
    }]);
    let input = super::build_responses_input_from_chat_messages(messages.as_array().unwrap())
        .expect("Responses tool output projection");
    assert_eq!(input[0]["type"], "function_call_output");
    assert_eq!(input[0]["output"], "found");
    assert!(!input.to_string().contains("example.invalid/image"));
}
