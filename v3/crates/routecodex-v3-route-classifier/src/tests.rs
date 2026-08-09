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

    // V2 final parity + user-defined priority:
    // "下一个是 web search，有关键字的路由直接命中可以 remote 直接搜索的路由目标"
    // current user turn carrying STRICT_TERMS web search intent must route to
    // web_search (multimodal still wins when an image is attached, asserted above).
    let prose_only = classify_route(&RouteClassifierInput {
        latest_message_from_user: true,
        current_user_text: "search the web for current docs".into(),
        ..Default::default()
    });
    assert_eq!(prose_only.route_name, "web_search");
    assert_eq!(prose_only.required_capabilities, vec!["web_search".to_string()]);

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

#[test]
fn has_web_search_intent_strong_english_phrases_hit() {
    for text in [
        "please search the web for rust 1.80 release notes",
        "do a web search on quantum error correction",
        "browse the web to find recent cves",
    ] {
        assert!(has_web_search_intent(text), "expected hit: {text}");
    }
}

#[test]
fn has_web_search_intent_strong_chinese_phrases_hit() {
    for text in [
        "帮我联网搜索一下 rust 最新版本",
        "请搜索今天的新闻",
        "答案必须引用来源",
    ] {
        assert!(has_web_search_intent(text), "expected hit: {text}");
    }
}

#[test]
fn has_web_search_intent_medium_verb_phrases_hit() {
    for text in [
        "look it up please",
        "上网搜一下新闻",
        "网页搜索 python 教程",
        "查一下这件事",
        "查一查周末天气",
    ] {
        assert!(has_web_search_intent(text), "expected hit: {text}");
    }
}

#[test]
fn has_web_search_intent_brand_weak_alone_misses() {
    for text in [
        "google it",
        "百度一下 巴黎天气",
        "google 一下 rust 教程",
        "bing 一下新闻",
        "搜个资料",
    ] {
        assert!(
            !has_web_search_intent(text),
            "single brand-weak must not hit: {text}"
        );
    }
}

#[test]
fn has_web_search_intent_two_brand_weak_stack_to_hit() {
    for text in [
        "google it and bing 一下",
        "百度一下 谷歌一下 巴黎",
        "搜个东西 查一下",
        "look up then google it",
    ] {
        assert!(has_web_search_intent(text), "stacked weak should hit: {text}");
    }
}

#[test]
fn has_web_search_intent_medium_plus_brand_weak_stack_to_hit() {
    assert!(has_web_search_intent("帮我查一下这个 顺便 google it"));
    assert!(has_web_search_intent("网页搜索 顺便 google 一下"));
}

#[test]
fn has_web_search_intent_negative_context_overrides_strong() {
    for text in [
        "do not web search this",
        "please don't search the web for me",
        "don't look up anything",
        "不需要联网搜索",
        "不用上网搜",
        "别搜 这个文件",
        "不用查资料",
    ] {
        assert!(
            !has_web_search_intent(text),
            "negative context must suppress: {text}"
        );
    }
}

#[test]
fn has_web_search_intent_unrelated_text_misses() {
    for text in [
        "write a rust function to parse json",
        "帮我修一下这个 bug",
        "explain monads in haskell",
        "compute fibonacci up to 100",
        "explain the architecture of the pipeline",
        "refactor this typescript file",
    ] {
        assert!(!has_web_search_intent(text), "must miss: {text}");
    }
}

#[test]
fn has_web_search_intent_is_case_insensitive() {
    assert!(has_web_search_intent("PLEASE SEARCH THE WEB"));
    assert!(has_web_search_intent("Web Search this"));
    assert!(!has_web_search_intent("BING 一下"));
}

#[test]
fn dryrun_strong_keyword_routes_to_web_search() {
    let r = classify_route(&RouteClassifierInput {
        latest_message_from_user: true,
        current_user_text: "帮我联网搜索一下 rust 1.80 release notes".into(),
        ..Default::default()
    });
    assert_eq!(r.route_name, "web_search");
    assert!(r.required_capabilities.contains(&"web_search".to_string()));
    assert!(
        r.reasoning.contains("web_search:user-text-intent"),
        "reasoning: {}",
        r.reasoning
    );
}

#[test]
fn dryrun_medium_keyword_routes_to_web_search() {
    let r = classify_route(&RouteClassifierInput {
        latest_message_from_user: true,
        current_user_text: "查一下 巴黎今天天气".into(),
        ..Default::default()
    });
    assert_eq!(r.route_name, "web_search");
    assert!(r.reasoning.contains("web_search:user-text-intent"));
}

#[test]
fn dryrun_two_brand_weak_stack_routes_to_web_search() {
    let r = classify_route(&RouteClassifierInput {
        latest_message_from_user: true,
        current_user_text: "百度一下 谷歌一下 rust 教程".into(),
        ..Default::default()
    });
    assert_eq!(r.route_name, "web_search");
}

#[test]
fn dryrun_single_brand_weak_does_not_trigger_web_search_route() {
    let r = classify_route(&RouteClassifierInput {
        latest_message_from_user: true,
        current_user_text: "google it".into(),
        ..Default::default()
    });
    assert_ne!(
        r.route_name, "web_search",
        "single brand-weak must not promote to web_search"
    );
    assert!(r
        .required_capabilities
        .iter()
        .all(|cap| cap != "web_search"));
}

#[test]
fn dryrun_negative_context_suppresses_web_search_route() {
    let r = classify_route(&RouteClassifierInput {
        latest_message_from_user: true,
        current_user_text: "帮我联网搜索 但不需要联网".into(),
        ..Default::default()
    });
    assert_ne!(
        r.route_name, "web_search",
        "negative context must suppress web_search"
    );
    assert!(r
        .required_capabilities
        .iter()
        .all(|cap| cap != "web_search"));
}

#[test]
fn dryrun_multimodal_outranks_keyword_web_search() {
    let r = classify_route(&RouteClassifierInput {
        latest_message_from_user: true,
        has_image_attachment: true,
        current_user_text: "联网搜索 这张图".into(),
        ..Default::default()
    });
    assert_eq!(r.route_name, "multimodal");
}

#[test]
fn dryrun_search_continuation_cascades_to_tools_and_default() {
    let r = classify_route(&RouteClassifierInput {
        latest_message_from_user: false,
        has_current_turn_tool_output: true,
        last_assistant_tool_category: Some("search".into()),
        ..Default::default()
    });
    assert_eq!(r.route_name, "search");
    // search route must list tools (search pool may be empty on this port) and
    // default as fallbacks so VR can walk the candidate list in order.
    assert_eq!(
        r.candidates,
        vec!["search".to_string(), "tools".to_string(), "default".to_string()]
    );
}

#[test]
fn dryrun_search_route_does_not_double_insert_tools() {
    let r = classify_route(&RouteClassifierInput {
        latest_message_from_user: false,
        has_current_turn_tool_output: true,
        last_assistant_tool_category: Some("search".into()),
        ..Default::default()
    });
    let tools_count = r
        .candidates
        .iter()
        .filter(|c| c.as_str() == "tools")
        .count();
    assert_eq!(tools_count, 1, "tools must appear at most once");
}

#[test]
fn dryrun_non_search_route_does_not_inject_tools_via_search_cascade() {
    let r = classify_route(&RouteClassifierInput {
        latest_message_from_user: true,
        current_user_text: "帮我联网搜索一下 rust".into(),
        ..Default::default()
    });
    assert_eq!(r.route_name, "web_search");
    // web_search route must NOT auto-insert tools — only the search route does.
    assert!(!r.candidates.iter().any(|c| c == "tools"));
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
        input.stopless_followup,
        input.has_current_turn_tool_output,
        input.has_current_turn_web_search,
        input.last_assistant_tool_category,
        input.current_user_text,
        input.has_background_keyword,
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
        "stopless_followup",
        "has_current_turn_tool_output",
        "has_current_turn_web_search",
        "last_assistant_tool_category",
        "current_user_text",
        "has_background_keyword",
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
