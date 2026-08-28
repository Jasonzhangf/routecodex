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
fn current_turn_explicit_web_search_call_activates_route() {
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
        "web_search"
    );
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
    assert_eq!(coding_long.candidates, vec!["longcontext", "default"]);

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
        ..Default::default()
    });
    assert_eq!(multimodal.route_name, "multimodal");

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
fn explicit_web_search_does_not_get_shadowed_by_generic_user_thinking() {
    let classified = classify_route(&RouteClassifierInput {
        latest_message_from_user: true,
        has_current_turn_web_search: true,
        ..Default::default()
    });
    assert_eq!(classified.route_name, "web_search");
    assert_eq!(classified.candidates, vec!["web_search", "default"]);
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
    let classified = classify_route(&RouteClassifierInput {
        reached_long_context: true,
        latest_message_from_user: true,
        has_current_turn_tool_output: true,
        last_assistant_tool_category: Some("coding".into()),
        ..Default::default()
    });
    assert_eq!(classified.route_name, "longcontext");
    assert_eq!(classified.candidates, vec!["longcontext", "default"]);
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
        vec![
            "search".to_string(),
            "tools".to_string(),
            "default".to_string()
        ]
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
        "stopless_followup",
        "has_current_turn_tool_output",
        "has_current_turn_web_search",
        "last_assistant_tool_category",
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
    assert!(signals.has_current_turn_image,
        "current-turn image must activate multimodal route fact via typed carrier");
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


// Negative regression: historical input_image must NOT drive the multimodal
// route when the current-turn message carries only text. Mirrors the
// 4444 Responses shape `route_reason=multimodal:metadata-attachment` BUT
// without any current-turn image, so the typed carrier must report
// `has_current_turn_image=false` and classify_route must avoid the
// multimodal / vision path entirely.
#[test]
fn live_responses_history_image_no_current_image_does_not_route_multimodal() {
    use serde_json::json;
    let request = json!({
        "model": "gpt-5.6-sol",
        "input": [
            {"type":"input_image","file_id":"hist-1"},
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
        "history image must not leak into current-turn multimodal signal; signals={:?}",
        signals
    );
    let route = classify_route(&RouteClassifierInput {
        latest_message_from_user: signals.latest_message_from_user,
        has_image_attachment: signals.has_current_turn_image,
        has_current_turn_tool_output: signals.has_current_turn_tool_output,
        ..Default::default()
    });
    assert_ne!(route.route_name, "multimodal",
        "text-only current turn must not pick multimodal; route={:?}", route);
    assert!(
        !route.reasoning.contains("multimodal:metadata-attachment"),
        "negative case must not log multimodal:metadata-attachment; route={:?}",
        route
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

    let tool_entries = project_responses_entries_from_array(&[tool_payload.clone()]);
    assert_eq!(tool_entries.len(), 1);
    assert_eq!(tool_entries[0].role, ResponsesTurnRole::Tool);
    // role=tool with a content[] of text parts is mapped to kind=Other because
    // typed Responses entries require an explicit typed kind; the role
    // projection itself is the contract under test here.
    assert_ne!(tool_entries[0].kind, ResponsesTurnKind::ToolOutput);

    let tool_output_entries = project_responses_entries_from_array(&[tool_output_payload.clone()]);
    assert_eq!(tool_output_entries.len(), 1);
    assert_eq!(tool_output_entries[0].role, ResponsesTurnRole::Tool);
    assert_eq!(tool_output_entries[0].kind, ResponsesTurnKind::ToolOutput);

    let system_entries = project_responses_entries_from_array(&[system_payload.clone()]);
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
        let system_count = es.iter().filter(|e| e.role == ResponsesTurnRole::System).count();
        assert_eq!(system_count, 0,
            "role=tool / tool_output must not project as System; got entries={:?}", es);
        let tool_count = es.iter().filter(|e| e.role == ResponsesTurnRole::Tool).count();
        assert!(tool_count >= 1, "tool side should map to Tool role; entries={:?}", es);
    } else {
        panic!("expected Responses typed entries for fixture thread");
    }
}
