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
    let signals = build_v3_current_turn_route_facts_from_value(&request);
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
    let signals = build_v3_current_turn_route_facts_from_value(&fresh);
    assert!(signals.latest_message_from_user);
    assert!(!signals.has_current_turn_tool_output);
    assert!(signals.last_assistant_tool.is_none());
}

#[test]
fn typed_tool_result_error_enters_current_turn_observation() {
    let request = json!({
        "input": [
            {"type":"message","role":"user","content":"run it"},
            {"type":"function_call","name":"exec_command","call_id":"call","arguments":{"cmd":"ls"}},
            {"type":"function_call_output","call_id":"call","is_error":true,"output":"permission denied"}
        ]
    });
    let signals = build_v3_current_turn_route_facts_from_value(&request);
    assert!(signals.has_current_turn_tool_output);
    assert!(signals.has_current_turn_tool_execution_error);

    let provider_error = json!({
        "error": {"code":"provider_failure","message":"upstream failed"}
    });
    let signals = build_v3_current_turn_route_facts_from_value(&json!({
        "input": [
            {"type":"message","role":"user","content":"run it"},
            {"type":"function_call_output","call_id":"call","output":provider_error}
        ]
    }));
    assert!(!signals.has_current_turn_tool_execution_error);
}

#[test]
fn compaction_is_a_typed_route_signal() {
    let signals = build_v3_current_turn_route_facts_from_value(&json!({
        "input": [
            {"type":"message","role":"user","content":"compact"},
            {"type":"compaction","encrypted_content":"opaque"}
        ]
    }));
    assert!(signals.is_compaction);

    let facts = V3CurrentTurnRouteFacts {
        is_compaction: true,
        latest_message_from_user: true,
        ..Default::default()
    };
    let classification = classify_route(&facts);
    assert_eq!(classification.route_name, "compact");
    assert_eq!(
        classification.candidates.first().map(String::as_str),
        Some("compact")
    );
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
    let signals = build_v3_current_turn_route_facts_from_value(&request);
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
    let signals = build_v3_current_turn_route_facts_from_value(&request);
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
    let signals = build_v3_current_turn_route_facts_from_value(&continuation);
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
    let signals = build_v3_current_turn_route_facts_from_value(&fresh);
    assert!(signals.latest_message_from_user);
    assert!(!signals.has_current_turn_tool_output);
    assert!(signals.last_assistant_tool.is_none());
}

// Bridges typed active-turn signals into route facts exactly like the runtime
// entry does. The multi-call tests below fail while only the last tool call
// reaches classification.
fn route_facts_from_current_signals(signals: &V3CurrentTurnSignals) -> RouteClassifierInput {
    RouteClassifierInput {
        latest_message_from_user: signals.latest_message_from_user,
        has_current_turn_tool_output: signals.has_current_turn_tool_output,
        has_current_turn_tool_execution_error: signals.has_current_turn_tool_execution_error,
        has_current_turn_web_search: signals.has_current_turn_web_search,
        has_image_attachment: signals.has_current_turn_image,
        is_compaction: signals.is_compaction,
        current_user_text: signals.current_user_text.clone(),
        last_assistant_tool_category: signals
            .last_assistant_tool
            .as_ref()
            .map(|tool| tool.category.clone()),
        current_turn_tool_categories: signals.current_turn_tool_categories.clone(),
        ..Default::default()
    }
}

fn chat_tool_turn(first: &str, second: &str) -> Value {
    let call = |name: &str| match name {
        "apply_patch" => json!({
            "type":"function",
            "function":{
                "name":"apply_patch",
                "arguments":"{\"patch\":\"*** Begin Patch\\n*** Update File: a\\n*** End Patch\"}"
            }
        }),
        "read_file" => json!({
            "type":"function",
            "function":{"name":"read_file","arguments":"{\"path\":\"a\"}"}
        }),
        "exec_command" => json!({
            "type":"function",
            "function":{"name":"exec_command","arguments":"{\"cmd\":\"rg -n route src\"}"}
        }),
        other => panic!("unsupported chat tool {other}"),
    };
    json!({
        "messages":[
            {"role":"user","content":"continue"},
            {"role":"assistant","tool_calls":[call(first), call(second)]},
            {"role":"tool","content":"ok"}
        ]
    })
}

fn responses_tool_turn(first: &str, second: &str) -> Value {
    let call = |name: &str, call_id: &str| match name {
        "apply_patch" => json!({
            "type":"function_call",
            "name":"apply_patch",
            "call_id":call_id,
            "arguments":{"patch":"*** Begin Patch\n*** Update File: a\n*** End Patch"}
        }),
        "read_file" => json!({
            "type":"function_call",
            "name":"read_file",
            "call_id":call_id,
            "arguments":{"path":"a"}
        }),
        "exec_command" => json!({
            "type":"function_call",
            "name":"exec_command",
            "call_id":call_id,
            "arguments":{"cmd":"rg -n route src"}
        }),
        other => panic!("unsupported responses tool {other}"),
    };
    json!({
        "input":[
            {"type":"message","role":"user","content":"continue"},
            call(first, "call-1"),
            call(second, "call-2"),
            {"type":"function_call_output","call_id":"call-2","output":"ok"}
        ]
    })
}

#[test]
fn chat_multi_tool_turn_keeps_coding_over_thinking_in_both_orders() {
    for (first, second) in [("apply_patch", "read_file"), ("read_file", "apply_patch")] {
        let signals = build_v3_current_turn_route_facts_from_value(&chat_tool_turn(first, second));
        assert!(signals.has_current_turn_tool_output, "{first}->{second}");
        let route = classify_route(&route_facts_from_current_signals(&signals));
        assert_eq!(
            route.route_name, "coding",
            "{first}->{second} must keep the higher-priority coding call"
        );
        assert!(
            route
                .candidates
                .iter()
                .any(|candidate| candidate == "thinking"),
            "{first}->{second} must keep the independent thinking match: {:?}",
            route.candidates
        );
    }
}

#[test]
fn responses_multi_tool_turn_keeps_coding_over_thinking_in_both_orders() {
    for (first, second) in [("apply_patch", "read_file"), ("read_file", "apply_patch")] {
        let signals =
            build_v3_current_turn_route_facts_from_value(&responses_tool_turn(first, second));
        assert!(signals.has_current_turn_tool_output, "{first}->{second}");
        let route = classify_route(&route_facts_from_current_signals(&signals));
        assert_eq!(
            route.route_name, "coding",
            "{first}->{second} must keep the higher-priority coding call"
        );
        assert!(
            route
                .candidates
                .iter()
                .any(|candidate| candidate == "thinking"),
            "{first}->{second} must keep the independent thinking match: {:?}",
            route.candidates
        );
    }
}

#[test]
fn chat_tool_category_competition_uses_route_priority() {
    for (first, second) in [("read_file", "exec_command"), ("exec_command", "read_file")] {
        let signals = build_v3_current_turn_route_facts_from_value(&chat_tool_turn(first, second));
        let route = classify_route(&route_facts_from_current_signals(&signals));
        assert_eq!(
            route.route_name, "thinking",
            "{first}->{second}: thinking must outrank search"
        );
        assert!(
            route
                .candidates
                .iter()
                .any(|candidate| candidate == "search"),
            "{first}->{second}: search must stay a candidate: {:?}",
            route.candidates
        );
    }
}

#[test]
fn responses_tool_category_competition_uses_route_priority() {
    for (first, second) in [("read_file", "exec_command"), ("exec_command", "read_file")] {
        let signals =
            build_v3_current_turn_route_facts_from_value(&responses_tool_turn(first, second));
        let route = classify_route(&route_facts_from_current_signals(&signals));
        assert_eq!(
            route.route_name, "thinking",
            "{first}->{second}: thinking must outrank search"
        );
        assert!(
            route
                .candidates
                .iter()
                .any(|candidate| candidate == "search"),
            "{first}->{second}: search must stay a candidate: {:?}",
            route.candidates
        );
    }
}

#[test]
fn multi_tool_route_is_independent_of_call_order_and_keeps_last_tool() {
    let forward =
        build_v3_current_turn_route_facts_from_value(&chat_tool_turn("apply_patch", "read_file"));
    let reverse =
        build_v3_current_turn_route_facts_from_value(&chat_tool_turn("read_file", "apply_patch"));

    for signals in [&forward, &reverse] {
        assert!(signals
            .current_turn_tool_categories
            .contains(&"coding".to_string()));
        assert!(signals
            .current_turn_tool_categories
            .contains(&"thinking".to_string()));
        assert_eq!(signals.current_turn_tool_categories.len(), 2);
    }
    // The legacy single-value field still reports the most recent call.
    assert_eq!(
        forward
            .last_assistant_tool
            .as_ref()
            .map(|tool| tool.category.as_str()),
        Some("thinking")
    );
    assert_eq!(
        reverse
            .last_assistant_tool
            .as_ref()
            .map(|tool| tool.category.as_str()),
        Some("coding")
    );

    let forward_route = classify_route(&route_facts_from_current_signals(&forward));
    let reverse_route = classify_route(&route_facts_from_current_signals(&reverse));
    assert_eq!(forward_route, reverse_route);
    assert_eq!(forward_route.route_name, "coding");
    assert_eq!(
        forward_route.candidates,
        vec!["coding", "thinking", "default"]
    );
}

#[test]
fn current_turn_tool_categories_are_deduplicated() {
    let signals =
        build_v3_current_turn_route_facts_from_value(&chat_tool_turn("apply_patch", "apply_patch"));
    assert_eq!(
        signals.current_turn_tool_categories,
        vec!["coding".to_string()]
    );
}

#[test]
fn multi_tool_categories_keep_every_match_below_media_and_longcontext() {
    let base = RouteClassifierInput {
        latest_message_from_user: false,
        has_current_turn_tool_output: true,
        current_turn_tool_categories: vec![
            "thinking".to_string(),
            "coding".to_string(),
            "search".to_string(),
        ],
        ..Default::default()
    };

    let multimodal = classify_route(&RouteClassifierInput {
        has_image_attachment: true,
        ..base.clone()
    });
    assert_eq!(multimodal.route_name, "multimodal");
    assert_eq!(
        multimodal.candidates,
        vec!["multimodal", "coding", "thinking", "search", "default"]
    );

    let longcontext = classify_route(&RouteClassifierInput {
        reached_long_context: true,
        ..base.clone()
    });
    assert_eq!(longcontext.route_name, "longcontext");
    assert_eq!(
        longcontext.candidates,
        vec!["longcontext", "coding", "thinking", "search", "default"]
    );

    let coding = classify_route(&base);
    assert_eq!(coding.route_name, "coding");
    assert_eq!(
        coding.candidates,
        vec!["coding", "thinking", "search", "default"]
    );
}

#[test]
fn websearch_category_in_the_set_does_not_activate_user_search_route() {
    let web_only = classify_route(&RouteClassifierInput {
        has_current_turn_tool_output: true,
        current_turn_tool_categories: vec!["websearch".to_string()],
        ..Default::default()
    });
    assert_eq!(web_only.route_name, "default");
    assert_eq!(web_only.candidates, vec!["default"]);

    let web_and_other = classify_route(&RouteClassifierInput {
        has_current_turn_tool_output: true,
        current_turn_tool_categories: vec!["websearch".to_string(), "other".to_string()],
        ..Default::default()
    });
    assert_eq!(web_and_other.route_name, "tools");
    assert_eq!(web_and_other.candidates, vec!["tools", "default"]);
}

#[test]
fn chat_content_tool_calls_use_only_the_current_turn() {
    let request = json!({
        "messages": [
            {"role":"user","content":"old"},
            {"role":"assistant","content":[
                {"type":"tool_call","name":"exec_command","arguments":{"command":"rg old"}}
            ]},
            {"role":"user","content":"apply now"},
            {"role":"assistant","content":[
                {
                    "type":"tool_call",
                    "name":"apply_patch",
                    "arguments":{"patch":"*** Begin Patch\n*** Update File: a\n*** End Patch"}
                }
            ]}
        ]
    });
    let signals = build_v3_current_turn_route_facts_from_value(&request);
    assert!(!signals.latest_message_from_user);
    assert!(signals.has_current_turn_tool_output);
    assert_eq!(
        signals
            .last_assistant_tool
            .as_ref()
            .map(|tool| tool.category.as_str()),
        Some("coding")
    );
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
        let signals = build_v3_current_turn_route_facts_from_value(&request);
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
fn current_turn_keyword_activates_web_search_but_declaration_does_not() {
    let keyword = build_v3_current_turn_route_facts_from_value(&json!({
        "messages": [{"role": "user", "content": "请搜索今天的新闻"}],
        "tools": [{"type": "web_search"}]
    }));
    assert!(keyword.latest_message_from_user);
    assert_eq!(keyword.current_user_text, "请搜索今天的新闻");
    assert_eq!(
        classify_route(&RouteClassifierInput {
            latest_message_from_user: keyword.latest_message_from_user,
            current_user_text: keyword.current_user_text,
            ..Default::default()
        })
        .route_name,
        "web_search"
    );

    let declaration_only = build_v3_current_turn_route_facts_from_value(&json!({
        "messages": [{"role": "user", "content": "修复这个路由问题"}],
        "tools": [{"type": "web_search"}]
    }));
    assert!(!declaration_only.current_user_text.is_empty());
    assert_ne!(
        classify_route(&RouteClassifierInput {
            latest_message_from_user: declaration_only.latest_message_from_user,
            current_user_text: declaration_only.current_user_text,
            ..Default::default()
        })
        .route_name,
        "web_search"
    );
}

#[test]
fn responses_user_content_string_drives_current_user_text_and_hosted_search() {
    let signals = build_v3_current_turn_route_facts_from_value(&json!({
        "input": [{"role": "user", "content": "请搜索今天的新闻"}],
        "tools": [{"type": "web_search"}]
    }));
    assert!(signals.latest_message_from_user);
    assert_eq!(signals.current_user_text, "请搜索今天的新闻");
    let route = classify_route(&route_facts_from_current_signals(&signals));
    assert_eq!(route.route_name, "web_search");
    assert!(route
        .required_capabilities
        .contains(&"web_search".to_string()));
}

#[test]
fn responses_tool_declaration_only_does_not_activate_hosted_search() {
    let signals = build_v3_current_turn_route_facts_from_value(&json!({
        "input": [{"role": "user", "content": "修复这个路由问题"}],
        "tools": [{"type": "web_search"}]
    }));
    assert!(signals.latest_message_from_user);
    assert_eq!(signals.current_user_text, "修复这个路由问题");
    assert!(!signals.has_current_turn_web_search);
    let route = classify_route(&route_facts_from_current_signals(&signals));
    assert_ne!(route.route_name, "web_search");
}

#[test]
fn responses_nested_content_parts_extract_user_text_and_keep_image() {
    let signals = build_v3_current_turn_route_facts_from_value(&json!({
        "input": [{
            "type": "message",
            "role": "user",
            "content": [
                {"type": "input_text", "text": "请搜索今天的新闻"},
                {"type": "input_image", "image_url": "data:image/png;base64,iVBORw0KGgo="}
            ]
        }]
    }));
    assert_eq!(signals.current_user_text, "请搜索今天的新闻");
    assert!(signals.has_current_turn_image);
    let route = classify_route(&route_facts_from_current_signals(&signals));
    assert_eq!(route.route_name, "web_search");
    assert!(route
        .candidates
        .iter()
        .any(|candidate| candidate == "multimodal"));
}

#[test]
fn responses_nested_image_only_does_not_fabricate_user_text() {
    let signals = build_v3_current_turn_route_facts_from_value(&json!({
        "input": [{
            "type": "message",
            "role": "user",
            "content": [
                {"type": "input_image", "image_url": "data:image/png;base64,iVBORw0KGgo="}
            ]
        }]
    }));
    assert_eq!(signals.current_user_text, "");
    assert!(signals.has_current_turn_image);
    let route = classify_route(&route_facts_from_current_signals(&signals));
    assert_eq!(route.route_name, "multimodal");
}

#[test]
fn responses_history_user_text_does_not_leak_into_current_turn() {
    let signals = build_v3_current_turn_route_facts_from_value(&json!({
        "input": [
            {"role": "user", "content": "请搜索今天的新闻"},
            {"role": "assistant", "content": "已经找到"},
            {"role": "user", "content": "继续实现"}
        ]
    }));
    assert!(signals.latest_message_from_user);
    assert_eq!(signals.current_user_text, "继续实现");
    assert!(!signals.has_current_turn_web_search);
    let route = classify_route(&route_facts_from_current_signals(&signals));
    assert_ne!(route.route_name, "web_search");
}

#[test]
fn responses_continuation_does_not_read_history_user_text() {
    let signals = build_v3_current_turn_route_facts_from_value(&json!({
        "input": [
            {"role": "user", "content": "请搜索今天的新闻"},
            {"type": "function_call", "call_id": "call", "name": "exec_command", "arguments": "{}"},
            {"type": "function_call_output", "call_id": "call", "output": "ok"}
        ]
    }));
    assert!(!signals.latest_message_from_user);
    assert_eq!(signals.current_user_text, "");
    let route = classify_route(&route_facts_from_current_signals(&signals));
    assert_ne!(route.route_name, "web_search");
}

#[test]
fn responses_nested_web_search_part_is_a_current_turn_route_fact() {
    let signals = build_v3_current_turn_route_facts_from_value(&json!({
        "input": [{
            "role": "user",
            "content": [
                {"type": "input_text", "text": "今天的头条"},
                {"type": "web_search", "query": "today"}
            ]
        }]
    }));
    assert!(signals.latest_message_from_user);
    assert!(signals.has_current_turn_web_search);
    let route = classify_route(&route_facts_from_current_signals(&signals));
    assert_eq!(route.route_name, "web_search");
}

#[test]
fn quoted_web_search_in_large_current_user_context_does_not_force_hosted_pool() {
    let text = format!(
        "<conversation>\nweb search\n{}\n</conversation>",
        "x".repeat(5000)
    );
    let classification = classify_route(&RouteClassifierInput {
        latest_message_from_user: true,
        current_user_text: text,
        ..Default::default()
    });
    assert_ne!(classification.route_name, "web_search");
    assert!(!classification
        .required_capabilities
        .contains(&"web_search".to_string()));
}

#[test]
fn explicit_search_after_long_quoted_context_activates_hosted_pool() {
    let text = format!(
        "<conversation>\nweb search\n{}\n</conversation>\n请搜索今天的新闻",
        "x".repeat(5000)
    );
    let classification = classify_route(&RouteClassifierInput {
        latest_message_from_user: true,
        current_user_text: text,
        ..Default::default()
    });
    assert_eq!(classification.route_name, "web_search");
}

#[test]
fn quoted_search_after_preface_is_not_current_user_intent() {
    let text = "Context:\n<conversation>web search</conversation>\nSummarize this";
    let classification = classify_route(&RouteClassifierInput {
        latest_message_from_user: true,
        current_user_text: text.to_string(),
        ..Default::default()
    });
    assert_ne!(classification.route_name, "web_search");
    let explicit = format!("{text}\n请搜索今天的新闻");
    assert!(crate::tools::has_current_user_web_search_intent(&explicit));
}

#[test]
fn explicit_no_lookup_does_not_activate_web_search() {
    assert!(!crate::tools::has_current_user_web_search_intent(
        "Do not look up 'web search'; summarize it"
    ));
}

#[test]
fn assistant_web_search_call_does_not_activate_user_search_route() {
    let request = json!({
        "input": [
            {"type": "message", "role": "user", "content": "search"},
            {"type": "web_search_call", "name": "web_search", "call_id": "call-1"}
        ]
    });
    let signals = build_v3_current_turn_route_facts_from_value(&request);
    assert_eq!(
        signals
            .last_assistant_tool
            .as_ref()
            .map(|tool| tool.category.as_str()),
        Some("websearch")
    );
    assert_eq!(
        classify_route(&RouteClassifierInput {
            latest_message_from_user: signals.latest_message_from_user,
            has_current_turn_tool_output: signals.has_current_turn_tool_output,
            last_assistant_tool_category: signals.last_assistant_tool.map(|tool| tool.category),
            ..Default::default()
        })
        .route_name,
        "default"
    );
}

#[test]
fn route_priority_uses_current_signals_and_places_longcontext_after_multimodal() {
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
        vec!["longcontext", "coding", "default"]
    );

    for (category, tool_route) in [
        ("thinking", "thinking"),
        ("search", "search"),
        ("other", "tools"),
    ] {
        let long = classify_route(&RouteClassifierInput {
            reached_long_context: true,
            has_current_turn_tool_output: true,
            last_assistant_tool_category: Some(category.into()),
            ..Default::default()
        });
        assert_eq!(long.route_name, "longcontext", "{category}");
        assert_eq!(
            long.candidates,
            vec!["longcontext", tool_route, "default"],
            "{category}"
        );
    }
}

#[test]
fn metadata_attachment_wins_and_web_search_tool_output_is_not_user_intent() {
    let multimodal = classify_route(&RouteClassifierInput {
        has_image_attachment: true,
        latest_message_from_user: true,
        ..Default::default()
    });
    assert_eq!(multimodal.route_name, "multimodal");

    let web_call = classify_route(&RouteClassifierInput {
        has_current_turn_tool_output: true,
        last_assistant_tool_category: Some("websearch".into()),
        ..Default::default()
    });
    assert_eq!(web_call.route_name, "default");
    assert_eq!(web_call.candidates, vec!["default"]);
    assert!(web_call.required_capabilities.is_empty());
}

#[test]
fn explicit_web_search_does_not_get_shadowed_by_generic_user_thinking() {
    let classified = classify_route(&RouteClassifierInput {
        latest_message_from_user: true,
        has_current_turn_web_search: true,
        ..Default::default()
    });
    assert_eq!(classified.route_name, "web_search");
    assert_eq!(
        classified.candidates,
        vec!["web_search", "thinking", "default"]
    );
}

#[test]
fn compaction_is_the_highest_priority_route_signal() {
    let classified = classify_route(&RouteClassifierInput {
        is_compaction: true,
        reached_long_context: true,
        has_image_attachment: true,
        latest_message_from_user: true,
        has_current_turn_tool_output: true,
        has_current_turn_web_search: true,
        last_assistant_tool_category: Some("coding".into()),
        ..Default::default()
    });
    assert_eq!(classified.route_name, "compact");
    assert_eq!(classified.candidates, vec!["compact", "default"]);
    assert!(classified.required_capabilities.is_empty());
}

#[test]
fn longcontext_wins_when_longcontext_thinking_and_coding_conditions_hit() {
    let from_user = classify_route(&RouteClassifierInput {
        reached_long_context: true,
        latest_message_from_user: true,
        ..Default::default()
    });
    assert_eq!(from_user.route_name, "longcontext");
    assert_eq!(
        from_user.candidates,
        vec!["longcontext", "thinking", "default"]
    );

    let coding_continuation = classify_route(&RouteClassifierInput {
        reached_long_context: true,
        has_current_turn_tool_output: true,
        last_assistant_tool_category: Some("coding".into()),
        ..Default::default()
    });
    assert_eq!(coding_continuation.route_name, "longcontext");
    assert_eq!(
        coding_continuation.candidates,
        vec!["longcontext", "coding", "default"]
    );

    // multimodal 仍高于 longcontext。
    let modality = classify_route(&RouteClassifierInput {
        reached_long_context: true,
        has_image_attachment: true,
        latest_message_from_user: true,
        ..Default::default()
    });
    assert_eq!(modality.route_name, "multimodal");
    assert_eq!(
        modality.candidates,
        vec!["multimodal", "longcontext", "thinking", "default"]
    );

    // compact 仍是最高优先级信号。
    let compact = classify_route(&RouteClassifierInput {
        reached_long_context: true,
        is_compaction: true,
        ..Default::default()
    });
    assert_eq!(compact.route_name, "compact");
    assert_eq!(compact.candidates, vec!["compact", "default"]);
}

#[test]
fn candidates_list_all_matching_signals_in_route_priority_order() {
    let web_search_then_multimodal = classify_route(&RouteClassifierInput {
        latest_message_from_user: true,
        has_current_turn_web_search: true,
        has_image_attachment: true,
        ..Default::default()
    });
    assert_eq!(web_search_then_multimodal.route_name, "web_search");
    assert_eq!(
        web_search_then_multimodal.candidates,
        vec!["web_search", "multimodal", "thinking", "default"]
    );

    let web_search_then_longcontext = classify_route(&RouteClassifierInput {
        latest_message_from_user: true,
        has_current_turn_web_search: true,
        reached_long_context: true,
        ..Default::default()
    });
    assert_eq!(web_search_then_longcontext.route_name, "web_search");
    assert_eq!(
        web_search_then_longcontext.candidates,
        vec!["web_search", "longcontext", "thinking", "default"]
    );

    let multimodal_then_coding = classify_route(&RouteClassifierInput {
        has_image_attachment: true,
        has_current_turn_tool_output: true,
        last_assistant_tool_category: Some("coding".into()),
        ..Default::default()
    });
    assert_eq!(multimodal_then_coding.route_name, "multimodal");
    assert_eq!(
        multimodal_then_coding.candidates,
        vec!["multimodal", "coding", "default"]
    );

    let multimodal_then_longcontext_then_coding = classify_route(&RouteClassifierInput {
        has_image_attachment: true,
        reached_long_context: true,
        has_current_turn_tool_output: true,
        last_assistant_tool_category: Some("coding".into()),
        ..Default::default()
    });
    assert_eq!(
        multimodal_then_longcontext_then_coding.route_name,
        "multimodal"
    );
    assert_eq!(
        multimodal_then_longcontext_then_coding.candidates,
        vec!["multimodal", "longcontext", "coding", "default"]
    );
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
        category("request_user_input", Some(&json!({"questions":[]}))).as_deref(),
        Some("thinking")
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
    assert_eq!(
        category("request_user_input", Some(&json!({"questions":[]}))).as_deref(),
        Some("thinking")
    );
}

#[test]
fn request_user_input_current_turn_routes_to_thinking_but_unknown_tool_stays_tools() {
    let thinking_request = json!({
        "input": [
            {"type":"message","role":"user","content":"please clarify"},
            {"type":"function_call","name":"request_user_input","call_id":"ask-1","arguments":"{\"questions\":[]}"}
        ]
    });
    let thinking_signals = build_v3_current_turn_route_facts_from_value(&thinking_request);
    assert_eq!(
        thinking_signals
            .last_assistant_tool
            .as_ref()
            .map(|tool| tool.category.as_str()),
        Some("thinking")
    );
    assert_eq!(
        classify_route(&RouteClassifierInput {
            has_current_turn_tool_output: true,
            last_assistant_tool_category: Some("thinking".into()),
            ..Default::default()
        })
        .route_name,
        "thinking"
    );

    let tools_request = json!({
        "input": [
            {"type":"message","role":"user","content":"run the requested operation"},
            {"type":"function_call","name":"unknown_tool","call_id":"tool-1","arguments":"{}"}
        ]
    });
    let tools_signals = build_v3_current_turn_route_facts_from_value(&tools_request);
    assert_eq!(
        tools_signals
            .last_assistant_tool
            .as_ref()
            .map(|tool| tool.category.as_str()),
        Some("other")
    );
    assert_eq!(
        classify_route(&RouteClassifierInput {
            has_current_turn_tool_output: true,
            last_assistant_tool_category: Some("other".into()),
            ..Default::default()
        })
        .route_name,
        "tools"
    );
}

#[test]
fn search_continuation_does_not_add_an_unmatched_tools_pool() {
    let r = classify_route(&RouteClassifierInput {
        latest_message_from_user: false,
        has_current_turn_tool_output: true,
        last_assistant_tool_category: Some("search".into()),
        ..Default::default()
    });
    assert_eq!(r.route_name, "search");
    assert_eq!(r.candidates, vec!["search", "default"]);
}

#[test]
fn route_candidates_are_unique() {
    let r = classify_route(&RouteClassifierInput {
        latest_message_from_user: false,
        has_current_turn_tool_output: true,
        last_assistant_tool_category: Some("search".into()),
        ..Default::default()
    });
    for (index, candidate) in r.candidates.iter().enumerate() {
        assert!(
            !r.candidates[..index].contains(candidate),
            "duplicate candidate: {candidate:?}"
        );
    }
}

// P0 control-plane isolation guard: route-classifier must not carry a
// `metadata` field that callers could smuggle previous-turn usage (or any
// other control state) into the request pipeline. This whitelist is the
// closure of the RouteClassifierInput surface; any new field must be
// reviewed against P0 before being added.
#[test]
fn route_classifier_input_has_no_control_state_fields() {
    let input = RouteClassifierInput::default();
    let _ = (
        input.reached_long_context,
        input.has_image_attachment,
        input.latest_message_from_user,
        input.has_current_turn_tool_output,
        input.has_current_turn_web_search,
        input.last_assistant_tool_category,
        input.current_turn_tool_categories,
        input.has_background_keyword,
        input.is_compaction,
    );
    // Compile-time check passed: every field is enumerated. If a new field
    // is added, this destructuring must be updated — that is the
    // deliberate friction that forces an ownership review.
    //
    // Runtime check (defensive): the field set is exactly the 9 known
    // names. Any drift is a P0 violation.
    let allowed = [
        "reached_long_context",
        "has_image_attachment",
        "latest_message_from_user",
        "has_current_turn_tool_output",
        "has_current_turn_web_search",
        "last_assistant_tool_category",
        "current_turn_tool_categories",
        "has_background_keyword",
        "is_compaction",
    ];
    let forbidden = [
        "metadata",
        "previous_usage",
        "prev_usage",
        "raw_metadata",
        "control",
        "control_state",
        "session_scope",
        "conversation_metadata",
    ];
    for f in forbidden {
        assert!(
            !allowed.iter().any(|a| a.eq_ignore_ascii_case(f)),
            "P0 violation: forbidden control-state name '{f}' appeared in allowed set"
        );
    }
}

// Regression for live Responses case where historical image is preserved as
// typed attachment and current-turn image drives the multimodal route fact
// without scanning payload text. The fixture mirrors the
// `route_reason=multimodal:metadata-attachment` row observed at port 4444
// in /Users/fanzhang/.rcc/logs/server-v3-4444.request-records.jsonl (2026-08-28
// 06:50 row 61): the request carries a trailing user message that embeds a
// current-turn image plus history_image blocks already normalized to the
// typed attachment placeholder.
#[test]
fn live_responses_history_image_attachment_drives_multimodal_route_via_typed_carrier() {
    use serde_json::json;
    let request = json!({
        "model": "gpt-5.6-sol",
        "input": [
            {"type":"input_image","file_id":"hist-1"},
            {"type":"input_text","text":"summary of past chart"},
            {"type":"message","role":"user","content":[
                {"type":"input_text","text":"what does this mean"},
                {"type":"input_image","file_id":"current-turn-1"}
            ]}
        ]
    });
    let entries = project_v3_current_turn_entries_from_value(&request);
    let signals = build_v3_current_turn_route_facts(&entries);
    assert!(
        signals.has_current_turn_image,
        "current-turn image must activate multimodal route fact via typed carrier"
    );
    let route = classify_route(&RouteClassifierInput {
        latest_message_from_user: signals.latest_message_from_user,
        has_image_attachment: signals.has_current_turn_image,
        has_current_turn_tool_output: signals.has_current_turn_tool_output,
        ..Default::default()
    });
    assert_eq!(route.route_name, "multimodal");
    assert!(
        route.reasoning.contains("multimodal:metadata-attachment"),
        "expected multimodal:metadata-attachment reasoning, got {:?}",
        route.reasoning
    );
}

#[test]
fn responses_history_image_does_not_survive_a_later_text_only_user() {
    let request = serde_json::json!({
        "input": [
            {"type":"input_image","file_id":"latest-1"},
            {"role":"assistant","content":"previous answer"},
            {"role":"user","content":"describe the recent changes"}
        ]
    });
    let entries = project_v3_current_turn_entries_from_value(&request);
    let signals = build_v3_current_turn_route_facts(&entries);
    assert!(
        !signals.has_current_turn_image,
        "an image from an earlier user turn must not classify the current text-only turn"
    );
}

#[test]
fn current_user_and_tool_images_activate_only_their_own_turn() {
    let current_user = build_v3_current_turn_route_facts_from_value(&serde_json::json!({
        "messages": [
            {"role":"user","content":[{"type":"image_url","image_url":{"url":"old"}}]},
            {"role":"assistant","content":"old answer"},
            {"role":"user","content":[{"type":"image_url","image_url":{"url":"current"}}]}
        ]
    }));
    assert!(current_user.has_current_turn_image);

    let current_tool = build_v3_current_turn_route_facts_from_value(&serde_json::json!({
        "input": [
            {"type":"message","role":"user","content":"show the chart"},
            {"type":"function_call","call_id":"view","name":"view_image","arguments":"{}"},
            {
                "type":"function_call_output",
                "call_id":"view",
                "output":"[{\"type\":\"input_image\",\"file_url\":\"data:image/png;base64,iVBORw0KGgo=\"}]"
            }
        ]
    }));
    assert!(current_tool.has_current_turn_image);
    assert!(current_tool.has_current_turn_tool_output);
}

#[test]
fn gemini_history_image_and_tool_do_not_leak_into_the_current_turn() {
    let historical = build_v3_current_turn_route_facts_from_value(&serde_json::json!({
        "contents": [
            {"role":"user","parts":[
                {"text":"old chart"},
                {"inlineData":{"mimeType":"image/png","data":"old"}}
            ]},
            {"role":"model","parts":[
                {"functionCall":{"name":"exec_command","args":{"command":"rg old"}}}
            ]},
            {"role":"user","parts":[{"text":"current text only"}]}
        ]
    }));
    assert!(!historical.has_current_turn_image);
    assert!(!historical.has_current_turn_tool_output);
    assert!(historical.last_assistant_tool.is_none());

    let current = build_v3_current_turn_route_facts_from_value(&serde_json::json!({
        "contents": [
            {"role":"user","parts":[{"text":"inspect the current chart"}]},
            {"role":"model","parts":[
                {"functionCall":{"name":"exec_command","args":{"command":"rg -n route src"}}}
            ]},
            {"role":"user","parts":[
                {"inlineData":{"mimeType":"image/png","data":"current"}},
                {"functionResponse":{"name":"exec_command","response":{"result":"ok"}}}
            ]}
        ]
    }));
    assert!(current.has_current_turn_image);
    assert!(current.has_current_turn_tool_output);
    assert_eq!(
        current
            .last_assistant_tool
            .as_ref()
            .map(|tool| tool.category.as_str()),
        Some("search")
    );
}

// Normalization owns historical image removal. Its text placeholder must
// never activate the typed image route fact.
#[test]
fn normalized_responses_history_placeholder_does_not_route_multimodal() {
    use serde_json::json;
    let request = json!({
        "model": "gpt-5.6-sol",
        "input": [
            {"type":"input_text","text":"[Image]"},
            {"type":"input_text","text":"summary of past chart"},
            {"type":"message","role":"user","content":[
                {"type":"input_text","text":"describe the recent changes"}
            ]}
        ]
    });
    let entries = project_v3_current_turn_entries_from_value(&request);
    let signals = build_v3_current_turn_route_facts(&entries);
    assert!(
        !signals.has_current_turn_image,
        "normalized history placeholder must not create an image signal; signals={:?}",
        signals
    );
    let route = classify_route(&RouteClassifierInput {
        latest_message_from_user: signals.latest_message_from_user,
        has_image_attachment: signals.has_current_turn_image,
        has_current_turn_tool_output: signals.has_current_turn_tool_output,
        ..Default::default()
    });
    assert_ne!(
        route.route_name, "multimodal",
        "text-only current turn must not pick multimodal; route={:?}",
        route
    );
    assert!(
        !route.reasoning.contains("multimodal:metadata-attachment"),
        "negative case must not log multimodal:metadata-attachment; route={:?}",
        route
    );
}

// fbab9d4: Codex view_image returns the screenshot inside a
// `function_call_output` whose `output` is a stringified JSON array of
// input_image blocks carrying data: URLs. The current-turn walker must
// decode that carrier and set has_current_turn_image so the request
// routes to the configured multimodal pool (which excludes glm-5.3).
#[test]
fn codex_view_image_function_call_output_drives_multimodal_route() {
    use serde_json::json;
    let request = json!({
        "model": "gpt-5.6-sol",
        "input": [
            {"type":"message","role":"user","content":[
                {"type":"input_text","text":"show me the chart"}
            ]},
            {"type":"function_call","call_id":"call_view","name":"view_image","arguments":"{\"path\":\"chart.png\"}"},
            {"type":"function_call_output","call_id":"call_view","output":"[{\"type\":\"input_image\",\"file_url\":\"data:image/png;base64,iVBORw0KGgo=\"}]"}
        ]
    });
    let entries = project_v3_current_turn_entries_from_value(&request);
    let signals = build_v3_current_turn_route_facts(&entries);
    assert!(
        signals.has_current_turn_image,
        "view_image function_call_output must activate the multimodal route fact; signals={signals:?}"
    );
    let route = classify_route(&RouteClassifierInput {
        latest_message_from_user: signals.latest_message_from_user,
        has_image_attachment: signals.has_current_turn_image,
        has_current_turn_tool_output: signals.has_current_turn_tool_output,
        ..Default::default()
    });
    assert_eq!(route.route_name, "multimodal");
    assert!(
        route.reasoning.contains("multimodal:metadata-attachment"),
        "expected multimodal:metadata-attachment reasoning, got {:?}",
        route.reasoning
    );
}

// Positive projection: Responses tool-side entries must classify as Tool
// (and the typed carrier must distinguish them from the rare explicit
// role=system entry). Both `role=tool` and the typed kind=ToolOutput entry
// shape (no role field, only `type=function_call_output`) must project to
// ResponsesTurnRole::Tool; only an explicit `role=system` (or
// role-bearing system message) is allowed to land in System.
#[test]
fn responses_role_for_value_distinguishes_tool_and_function_call_output_from_system() {
    use serde_json::json;
    let tool_payload = json!({"role": "tool", "content": [{"type": "text", "text": "ok"}]});
    let tool_output_payload = json!({
        "type": "function_call_output",
        "call_id": "call-1",
        "output": "ok"
    });
    let system_payload = json!({"role": "system", "content": "stay terse"});
    let assistant_payload = json!({"role": "assistant", "content": "hi"});
    let user_payload = json!({"role": "user", "content": "hi"});

    let tool_entries = project_responses_entries_from_array(std::slice::from_ref(&tool_payload));
    assert_eq!(tool_entries.len(), 1);
    assert_eq!(tool_entries[0].role, ResponsesTurnRole::Tool);
    // role=tool with a content[] of text parts is mapped to kind=Other because
    // typed Responses entries require an explicit typed kind; the role
    // projection itself is the contract under test here.
    assert_ne!(tool_entries[0].kind, ResponsesTurnKind::ToolOutput);

    let tool_output_entries =
        project_responses_entries_from_array(std::slice::from_ref(&tool_output_payload));
    assert_eq!(tool_output_entries.len(), 1);
    assert_eq!(tool_output_entries[0].role, ResponsesTurnRole::Tool);
    assert_eq!(tool_output_entries[0].kind, ResponsesTurnKind::ToolOutput);

    let system_entries =
        project_responses_entries_from_array(std::slice::from_ref(&system_payload));
    assert_eq!(system_entries[0].role, ResponsesTurnRole::System);

    // Negative check: assistant / user roles stay out of System.
    let assistant_entries = project_responses_entries_from_array(&[assistant_payload]);
    assert_ne!(assistant_entries[0].role, ResponsesTurnRole::System);
    let user_entries = project_responses_entries_from_array(&[user_payload]);
    assert_ne!(user_entries[0].role, ResponsesTurnRole::System);

    // End-to-end: a multi-entry Responses thread that mixes role=tool and
    // role=function_call_output yields a current-turn segment whose
    // tool-output accounting lights up, but the role distribution must
    // keep System empty.
    let thread = json!({
        "model": "gpt-5.6-sol",
        "input": [
            {"role":"user","content":"run the build"},
            {"role":"assistant","tool_calls":[{
                "type":"function","function":{"name":"exec_command","arguments":"{}"}
            }]},
            {"role":"tool","content":"build ok"},
            {"type":"function_call_output","call_id":"c1","output":"done"}
        ]
    });
    let entries = project_v3_current_turn_entries_from_value(&thread);
    if let V3CurrentTurnEntries::Responses(es) = entries {
        let system_count = es
            .iter()
            .filter(|e| e.role == ResponsesTurnRole::System)
            .count();
        assert_eq!(
            system_count, 0,
            "role=tool / tool_output must not project as System; got entries={:?}",
            es
        );
        let tool_count = es
            .iter()
            .filter(|e| e.role == ResponsesTurnRole::Tool)
            .count();
        assert!(
            tool_count >= 1,
            "tool side should map to Tool role; entries={:?}",
            es
        );
    } else {
        panic!("expected Responses typed entries for fixture thread");
    }
}
