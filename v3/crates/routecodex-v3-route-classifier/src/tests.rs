use super::*;
use serde_json::{json, Value};

#[test]
fn active_turn_uses_actual_tool_calls_and_ignores_history() {
    let request = json!({
        "input": [
            {"type":"message","role":"user","content":"old search"},
            {"type":"function_call","name":"exec_command","call_id":"old","arguments":{"cmd":"rg old"}},
            {"type":"function_call_output","call_id":"old","output":"old"},
            {"type":"message","role":"user","content":"apply now"},
            {
                "type":"custom_tool_call",
                "name":"apply_patch",
                "call_id":"new",
                "input":"*** Begin Patch\n*** Update File: a\n*** End Patch"
            },
            {"type":"custom_tool_call_output","call_id":"new","output":"ok"}
        ]
    });
    let signals = extract_active_turn_signals(&request);
    assert!(!signals.latest_message_from_user);
    assert!(signals.has_current_turn_tool_output);
    assert_eq!(
        signals
            .last_assistant_tool
            .as_ref()
            .map(|tool| tool.category.as_str()),
        Some("coding")
    );

    let fresh = json!({
        "input": [
            {"type":"message","role":"user","content":"old"},
            {"type":"function_call","name":"exec_command","call_id":"old","arguments":{"cmd":"rg old"}},
            {"type":"function_call_output","call_id":"old","output":"old"},
            {"type":"message","role":"user","content":"explain only"}
        ]
    });
    let signals = extract_active_turn_signals(&fresh);
    assert!(signals.latest_message_from_user);
    assert!(!signals.has_current_turn_tool_output);
    assert!(signals.last_assistant_tool.is_none());
    assert_eq!(signals.current_user_text, "explain only");
}

#[test]
fn chat_historical_web_search_does_not_activate_current_turn() {
    let request = json!({
        "messages": [
            {"role":"user","content":"old"},
            {"role":"assistant","content":[{"type":"web_search","query":"old"}]},
            {"role":"user","content":"current text only"}
        ]
    });
    let signals = extract_active_turn_signals(&request);
    assert!(signals.latest_message_from_user);
    assert!(!signals.has_current_turn_web_search);
}

#[test]
fn responses_historical_web_search_does_not_activate_current_turn() {
    let request = json!({
        "input": [
            {"type":"message","role":"user","content":"old"},
            {"type":"web_search_call","query":"old"},
            {"type":"message","role":"user","content":"current text only"}
        ]
    });
    let signals = extract_active_turn_signals(&request);
    assert!(signals.latest_message_from_user);
    assert!(!signals.has_current_turn_web_search);
}

#[test]
fn chat_messages_use_only_current_turn_tool_calls() {
    let continuation = json!({
        "messages": [
            {"role":"user","content":"old web search"},
            {
                "role":"assistant",
                "tool_calls":[{
                    "type":"function",
                    "function":{"name":"web_search","arguments":"{\"query\":\"old\"}"}
                }]
            },
            {"role":"tool","content":"old result"},
            {"role":"user","content":"patch the file"},
            {
                "role":"assistant",
                "tool_calls":[{
                    "type":"function",
                    "function":{
                        "name":"apply_patch",
                        "arguments":"{\"patch\":\"*** Begin Patch\\n*** Update File: a\\n*** End Patch\"}"
                    }
                }]
            },
            {"role":"tool","content":"done"}
        ],
        "tools":[{"type":"web_search"}]
    });
    let signals = extract_active_turn_signals(&continuation);
    assert!(!signals.latest_message_from_user);
    assert!(signals.has_current_turn_tool_output);
    assert_eq!(
        signals
            .last_assistant_tool
            .as_ref()
            .map(|tool| tool.category.as_str()),
        Some("coding")
    );

    let fresh = json!({
        "messages": [
            {"role":"user","content":"search the web for old docs"},
            {
                "role":"assistant",
                "tool_calls":[{
                    "type":"function",
                    "function":{"name":"web_search","arguments":"{\"query\":\"old\"}"}
                }]
            },
            {"role":"tool","content":"old result"},
            {"role":"user","content":"continue implementation"}
        ],
        "tools":[{"type":"web_search"}]
    });
    let signals = extract_active_turn_signals(&fresh);
    assert!(signals.latest_message_from_user);
    assert!(!signals.has_current_turn_tool_output);
    assert!(signals.last_assistant_tool.is_none());
    assert_eq!(signals.current_user_text, "continue implementation");
}

#[test]
fn responses_tool_type_matrix_uses_current_turn_call() {
    for (call_type, output_type, argument_key) in [
        ("function_call", "function_call_output", "arguments"),
        ("custom_tool_call", "custom_tool_call_output", "input"),
        ("tool_call", "tool_call_output", "arguments"),
    ] {
        let mut call = serde_json::Map::from_iter([
            ("type".to_string(), Value::String(call_type.to_string())),
            (
                "name".to_string(),
                Value::String("exec_command".to_string()),
            ),
            ("call_id".to_string(), Value::String("call".to_string())),
        ]);
        call.insert(argument_key.to_string(), json!({"cmd":"cargo test"}));
        let request = json!({
            "input": [
                {"type":"message","role":"user","content":"validate"},
                Value::Object(call),
                {"type":output_type,"call_id":"call","output":"ok"}
            ]
        });
        let signals = extract_active_turn_signals(&request);
        assert_eq!(
            signals
                .last_assistant_tool
                .as_ref()
                .map(|tool| tool.category.as_str()),
            Some("other"),
            "{call_type}"
        );
    }
}

#[test]
fn shared_route_priority_matches_v2() {
    let fresh = classify_route(&RouteClassifierInput {
        latest_message_from_user: true,
        ..Default::default()
    });
    assert_eq!(fresh.route_name, "thinking");
    assert_eq!(fresh.candidates, vec!["thinking", "default"]);

    let coding_long = classify_route(&RouteClassifierInput {
        reached_long_context: true,
        has_current_turn_tool_output: true,
        last_assistant_tool_category: Some("coding".into()),
        ..Default::default()
    });
    assert_eq!(coding_long.route_name, "longcontext");
    assert_eq!(
        coding_long.candidates,
        vec!["longcontext", "default"]
    );

    for category in ["thinking", "search", "other"] {
        let long = classify_route(&RouteClassifierInput {
            reached_long_context: true,
            has_current_turn_tool_output: true,
            last_assistant_tool_category: Some(category.into()),
            ..Default::default()
        });
        assert_eq!(long.route_name, "longcontext", "{category}");
        assert_eq!(long.candidates, vec!["longcontext", "default"]);
    }
}

#[test]
fn metadata_attachment_wins_and_web_search_tool_evidence_is_route() {
    let multimodal = classify_route(&RouteClassifierInput {
        has_image_attachment: true,
        latest_message_from_user: true,
        current_user_text: "search the web".into(),
        ..Default::default()
    });
    assert_eq!(multimodal.route_name, "multimodal");

    let prose_only = classify_route(&RouteClassifierInput {
        latest_message_from_user: true,
        current_user_text: "search the web for current docs".into(),
        ..Default::default()
    });
    assert_eq!(prose_only.route_name, "thinking");
    assert!(prose_only.required_capabilities.is_empty());

    let web_call = classify_route(&RouteClassifierInput {
        has_current_turn_tool_output: true,
        last_assistant_tool_category: Some("websearch".into()),
        ..Default::default()
    });
    assert_eq!(web_call.route_name, "web_search");
    assert_eq!(web_call.candidates, vec!["web_search", "default"]);
    assert_eq!(web_call.required_capabilities, vec!["web_search"]);
}

#[test]
fn explicit_web_search_part_in_current_user_turn_is_routed_to_web_search() {
    // 用户轮显式 web_search part（Responses input 数组 / chat content part）必须产生
    // web_search 能力。此前只在 continuation（websearch 工具延续）判定——用户轮
    // 显式 web_search 请求落 default（openai_chat）→ openai_chat encoding 不支持
    // web_search part → 500（真实故障 20260808）。
    let classified = classify_route(&RouteClassifierInput {
        latest_message_from_user: true,
        has_current_turn_web_search: true,
        ..Default::default()
    });
    assert_eq!(classified.route_name, "web_search");
    assert!(classified
        .required_capabilities
        .contains(&"web_search".to_string()));
}

#[test]
fn strict_web_search_terms_do_not_accept_generic_search_words() {
    for text in [
        "search only",
        "google this",
        "bing query",
        "搜索代码",
        "百度一下",
        "finish the research task",
    ] {
        assert!(!has_web_search_intent(text), "{text}");
    }
    for text in [
        "search the web for docs",
        "browse the web",
        "with sources",
        "联网搜索最新资料",
        "请搜索并引用来源",
    ] {
        assert!(has_web_search_intent(text), "{text}");
    }
}

#[test]
fn tool_call_category_matches_v2_command_semantics() {
    let category = |name: &str, arguments: Option<&Value>| {
        classify_tool_call(name, arguments).map(|classification| classification.category)
    };
    let read = json!({"command":"cat src/lib.rs"});
    let search = json!({"command":"rg -n route src"});
    let tools = json!({"command":"cargo test"});
    let valid_patch = json!({"patch":"*** Begin Patch\n*** Update File: a\n*** End Patch"});
    let malformed_patch = json!({"patch":"not a patch"});
    assert_eq!(
        category("exec_command", Some(&read)).as_deref(),
        Some("thinking")
    );
    assert_eq!(
        category("exec_command", Some(&search)).as_deref(),
        Some("search")
    );
    assert_eq!(
        category("exec_command", Some(&tools)).as_deref(),
        Some("other")
    );
    assert_eq!(
        category("apply_patch", Some(&valid_patch)).as_deref(),
        Some("coding")
    );
    assert_eq!(category("apply_patch", Some(&malformed_patch)), None);
    assert_eq!(
        category("web_search", Some(&json!({"query":"x"}))).as_deref(),
        Some("websearch")
    );
}
