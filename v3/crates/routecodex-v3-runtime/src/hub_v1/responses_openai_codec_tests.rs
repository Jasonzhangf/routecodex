// responses_openai_codec tests, split from responses_openai_codec.rs to satisfy
// verify:v3-file-size ratchet. Semantics unchanged: this module is the direct
// child of responses_openai_codec, so `use super::*` resolves identically to
// the former inline `mod tests`.

use super::*;
use serde_json::{json, Value};

#[test]
fn responses_reasoning_effort_normalizes_whitespace_and_case_like_chat_side() {
    let request = build_v3_chat_canonical_request_from_responses_payload(&json!({
        "model": "deepseek-v4-flash",
        "input": "hi",
        "reasoning": {"effort": " XHIGH ", "summary": "detailed"}
    }))
    .expect("whitespace/case-variant effort must be normalized, not rejected");
    assert_eq!(request["reasoning_effort"], "xhigh");
}

#[test]
fn responses_reasoning_effort_preserves_unknown_non_empty_value_for_forward_compatibility() {
    let request = build_v3_chat_canonical_request_from_responses_payload(&json!({
        "model": "deepseek-v4-flash",
        "input": "hi",
        "reasoning": {"effort": " FutureLevel "}
    }))
    .expect("an unknown non-empty effort must survive inbound canonicalization");

    assert_eq!(request["reasoning_effort"], " FutureLevel ");
}

#[test]
fn responses_reasoning_effort_still_rejects_invalid_json_types_and_empty_strings() {
    for effort in [json!(false), json!(42), json!({}), json!([]), json!("   ")] {
        let error = build_v3_chat_canonical_request_from_responses_payload(&json!({
            "model": "deepseek-v4-flash",
            "input": "hi",
            "reasoning": {"effort": effort}
        }))
        .expect_err("non-string or empty effort must remain malformed protocol data");

        assert_eq!(
            error,
            "Responses reasoning.effort must be a non-empty string"
        );
    }
}

#[test]
fn responses_inbound_preserves_text_format_for_target_outbound_whitelist() {
    let format = json!({
        "type": "json_schema",
        "name": "answer_contract",
        "description": "response contract",
        "schema": {"type": "object", "properties": {"answer": {"type": "string"}}},
        "strict": true
    });
    let request = build_v3_chat_canonical_request_from_responses_payload(&json!({
        "model": "gpt-5.5",
        "input": "return structured output",
        "text": {"format": format}
    }))
    .expect("Responses inbound normalization must preserve registered text semantics");

    assert_eq!(
        request["routecodex_chat_extension"]["responses_request"]["text"]["format"], format,
        "ReqInbound must not strip fields before the selected target outbound whitelist"
    );
}

#[test]
fn responses_input_image_url_maps_to_openai_chat_image_url_url() {
    let request = build_v3_chat_canonical_request_from_responses_payload(&json!({
        "model": "gpt-5.5",
        "input": [{
            "type": "message",
            "role": "user",
            "content": [{
                "type": "input_image",
                "image_url": "data:image/png;base64,AAAA",
                "detail": "high"
            }]
        }]
    }))
    .expect("Responses image_url must project to OpenAI Chat image_url.url");

    let image_part = &request["messages"][0]["content"][0];
    assert_eq!(image_part["type"], json!("image_url"));
    assert_eq!(
        image_part["image_url"],
        json!({"url":"data:image/png;base64,AAAA","detail":"high"}),
        "OpenAI Chat provider wire must not emit bare string image_url: {request}"
    );
}

#[test]
fn responses_text_array_preserves_multiple_empty_and_sibling_fields() {
    let request = build_v3_chat_canonical_request_from_responses_payload(&json!({
        "model": "gpt-5.5",
        "input": [{
            "type": "message",
            "role": "user",
            "content": [
                {
                    "type": "input_text",
                    "text": "alpha",
                    "annotations": [{
                        "type": "url_citation",
                        "start_index": 0,
                        "end_index": 5,
                        "url": "https://example.com/alpha"
                    }],
                    "future_sibling": {"keep": true}
                },
                {"type": "input_text", "text": ""},
                {
                    "type": "output_text",
                    "text": "omega",
                    "annotations": []
                }
            ]
        }]
    }))
    .expect("text arrays must preserve source part boundaries and sibling data");

    let content = request["messages"][0]["content"]
        .as_array()
        .unwrap_or_else(|| panic!("text array must stay an array: {request}"));
    assert_eq!(
        content,
        &vec![
            json!({
                "type": "text",
                "text": "alpha",
                "annotations": [{
                    "type": "url_citation",
                    "start_index": 0,
                    "end_index": 5,
                    "url": "https://example.com/alpha"
                }],
                "future_sibling": {"keep": true}
            }),
            json!({"type": "text", "text": ""}),
            json!({"type": "text", "text": "omega", "annotations": []})
        ]
    );
}

#[test]
fn responses_scalar_input_content_stays_scalar() {
    let request = build_v3_chat_canonical_request_from_responses_payload(&json!({
        "model": "gpt-5.5",
        "input": "hello"
    }))
    .expect("scalar Responses input must canonicalize");

    assert_eq!(request["messages"][0]["content"], json!("hello"));
}

#[test]
fn responses_singleton_text_array_stays_array() {
    let request = build_v3_chat_canonical_request_from_responses_payload(&json!({
        "model": "gpt-5.5",
        "input": [{
            "type": "message",
            "role": "user",
            "content": [{"type": "input_text", "text": "hello"}]
        }]
    }))
    .expect("singleton Responses text array must canonicalize");

    assert_eq!(
        request["messages"][0]["content"],
        json!([{"type": "text", "text": "hello"}])
    );
}

#[test]
fn responses_mixed_text_image_preserves_text_siblings_and_order() {
    let request = build_v3_chat_canonical_request_from_responses_payload(&json!({
        "model": "gpt-5.5",
        "input": [{
            "type": "message",
            "role": "user",
            "content": [
                {
                    "type": "input_text",
                    "text": "before",
                    "annotations": [{"type": "custom_note", "value": "keep"}],
                    "future_sibling": "keep"
                },
                {
                    "type": "input_image",
                    "image_url": "data:image/png;base64,AAAA",
                    "detail": "high"
                },
                {"type": "input_text", "text": "after"}
            ]
        }]
    }))
    .expect("mixed Responses content must preserve text/image boundaries");

    let content = request["messages"][0]["content"]
        .as_array()
        .unwrap_or_else(|| panic!("mixed content must stay an array: {request}"));
    assert_eq!(
        content,
        &vec![
            json!({
                "type": "text",
                "text": "before",
                "annotations": [{"type": "custom_note", "value": "keep"}],
                "future_sibling": "keep"
            }),
            json!({
                "type": "image_url",
                "image_url": {
                    "url": "data:image/png;base64,AAAA",
                    "detail": "high"
                }
            }),
            json!({"type": "text", "text": "after"})
        ]
    );
}

#[test]
fn responses_structured_or_absent_text_is_not_replaced_with_empty_text() {
    let source = json!([
        {"type":"input_text","text":{"nested":[1,true,null]},"tag":"structured"},
        {"type":"input_text","tag":"absent"}
    ]);
    let request = build_v3_chat_canonical_request_from_responses_payload(&json!({
        "input":[{"type":"message","role":"user","content":source}]
    }))
    .unwrap();
    let parts = &request["messages"][0]["content"];
    assert_eq!(
        parts[0]["text"],
        serde_json::to_string(&source[0]["text"]).unwrap()
    );
    assert_eq!(parts[0]["tag"], "structured");
    assert!(parts[1].get("text").is_none());
    assert_eq!(parts[1]["tag"], "absent");
}

#[test]
fn responses_tool_only_function_call_omits_synthetic_empty_content() {
    let request = build_v3_chat_canonical_request_from_responses_payload(&json!({
        "model": "gpt-5.5",
        "input": [{
            "type": "function_call",
            "call_id": "call_tool_only",
            "namespace": "codex_tui",
            "name": "send_message_to_thread",
            "arguments": "{\"thread_id\":\"thread-1\",\"message\":\"hello\"}"
        }]
    }))
    .expect("tool-only function_call must canonicalize");

    let assistant = &request["messages"][0];
    assert_eq!(assistant["role"], json!("assistant"));
    assert!(
        assistant.get("content").is_none(),
        "newly synthesized tool-only assistant must omit empty content: {request}"
    );
    assert_eq!(assistant["tool_calls"][0]["id"], json!("call_tool_only"));
    assert_eq!(
        assistant["tool_calls"][0]["function"]["name"],
        json!("codex_tui__send_message_to_thread")
    );
    assert_eq!(
        assistant["tool_calls"][0]["function"]["arguments"],
        json!("{\"thread_id\":\"thread-1\",\"message\":\"hello\"}")
    );
}

#[test]
fn responses_function_call_preserves_source_content_and_reasoning() {
    let request = build_v3_chat_canonical_request_from_responses_payload(&json!({
        "model": "gpt-5.5",
        "input": [{
            "type": "function_call",
            "call_id": "call_with_content",
            "name": "lookup",
            "arguments": "{\"q\":\"x\"}",
            "content": [{"type": "output_text", "text": "source text"}],
            "reasoning_content": "source reasoning"
        }]
    }))
    .expect("source-provided function_call content must canonicalize");

    let assistant = &request["messages"][0];
    assert_eq!(
        assistant["content"],
        json!([{"type": "text", "text": "source text"}])
    );
    assert_eq!(assistant["reasoning_content"], json!("source reasoning"));
    assert_eq!(
        assistant["tool_calls"][0]["function"]["arguments"],
        json!("{\"q\":\"x\"}")
    );
}

#[test]
fn responses_image_codec_preserves_future_siblings_for_duplicate_urls() {
    let request = build_v3_chat_canonical_request_from_responses_payload(&json!({
        "model": "gpt-5.5",
        "input": [{
            "type": "message",
            "role": "user",
            "content": [
                {"type":"input_image","image_url":"data:image/png;base64,AAAA","future_sibling":{"occurrence":1}},
                {"type":"input_image","image_url":"data:image/png;base64,AAAA","future_sibling":{"occurrence":2}}
            ]
        }]
    }))
    .expect("Responses image siblings must project through the exported codec boundary");
    let content = request["messages"][0]["content"]
        .as_array()
        .expect("projected image content");
    assert_eq!(content.len(), 2);
    assert_eq!(
        content[0]["image_url"]["url"],
        content[1]["image_url"]["url"]
    );
    assert_eq!(content[0]["future_sibling"], json!({"occurrence":1}));
    assert_eq!(content[1]["future_sibling"], json!({"occurrence":2}));
}

#[test]
fn responses_web_search_current_turn_item_projects_to_canonical_tools() {
    let canonical = build_v3_chat_canonical_request_from_responses_payload(&json!({
        "model": "gpt-5.5",
        "input": [
            {"type": "web_search", "query": "latest OpenAI news"},
            {
                "type": "message",
                "role": "user",
                "content": [{"type": "input_text", "text": "search the web for latest OpenAI news"}]
            }
        ]
    }))
    .expect("responses web_search current-turn item must project to canonical");
    let tools = canonical
        .get("tools")
        .and_then(Value::as_array)
        .expect("canonical tools");
    assert!(tools
        .iter()
        .any(|tool| { tool.get("type").and_then(Value::as_str) == Some("web_search") }));
}

#[test]
fn responses_inbound_restores_codex_integer_tool_schema_types() {
    for description in [
        "Runs a command in a PTY, returning output or a session ID.",
        "Runs a command in a PTY, returning output or a session ID for ongoing interaction.",
    ] {
        assert_registered_codex_integer_tool_schema_types(description);
    }
}

fn assert_registered_codex_integer_tool_schema_types(description: &str) {
    let request = super::super::responses_openai_codec::build_v3_chat_canonical_request_from_responses_payload_for_req_inbound_compat(&json!({
        "model": "gpt-5.5",
        "tools": [
            {
                "type": "function",
                "name": "exec_command",
                "description": description,
                "strict": false,
                "parameters": {
                    "type": "object",
                    "additionalProperties": false,
                    "properties": {
                        "cmd": {"type": "string"},
                        "justification": {"type": "string"},
                        "login": {"type": "boolean"},
                        "yield_time_ms": {"type": "number"},
                        "max_output_tokens": {"type": "number"},
                        "prefix_rule": {"type": "array", "items": {"type": "string"}},
                        "sandbox_permissions": {"type": "string", "enum": ["use_default", "require_escalated"]},
                        "shell": {"type": "string"},
                        "tty": {"type": "boolean"},
                        "workdir": {"type": "string"}
                    },
                    "required": ["cmd"]
                }
            },
            {
                "type": "function",
                "name": "write_stdin",
                "description": "Writes characters to an existing unified exec session and returns recent output.",
                "strict": false,
                "parameters": {
                    "type": "object",
                    "additionalProperties": false,
                    "properties": {
                        "chars": {"type": "string"},
                        "session_id": {"type": "number"},
                        "yield_time_ms": {"type": "number"},
                        "max_output_tokens": {"type": "number"}
                    },
                    "required": ["session_id"]
                }
            },
            {
                "type": "function",
                "name": "user_tool",
                "parameters": {
                    "type": "object",
                    "properties": {"ratio": {"type": "number"}}
                }
            }
        ],
        "input": [{
            "type": "message",
            "role": "user",
            "content": [{"type": "input_text", "text": "run it"}]
        }]
    }))
    .expect("Responses request must canonicalize");

    let tools = request["tools"].as_array().expect("canonical tools");
    assert_eq!(
        tools[0]["parameters"]["properties"]["yield_time_ms"]["type"],
        "integer"
    );
    assert_eq!(
        tools[0]["parameters"]["properties"]["max_output_tokens"]["type"],
        "integer"
    );
    assert_eq!(
        tools[0]["parameters"]["properties"]["cmd"]["type"],
        "string"
    );
    assert_eq!(
        tools[1]["parameters"]["properties"]["session_id"]["type"],
        "integer"
    );
    assert_eq!(
        tools[1]["parameters"]["properties"]["yield_time_ms"]["type"],
        "integer"
    );
    assert_eq!(
        tools[1]["parameters"]["properties"]["max_output_tokens"]["type"],
        "integer"
    );
    assert_eq!(
        tools[2]["parameters"]["properties"]["ratio"]["type"],
        "number"
    );

    let anthropic_wire = super::super::encode_v3_responses_semantic_as_anthropic_request(request)
        .expect("canonical Responses payload must project to Anthropic wire");
    let anthropic_tool = &anthropic_wire["tools"][0];
    assert_eq!(
        anthropic_tool["input_schema"]["properties"]["yield_time_ms"]["type"],
        "integer"
    );
    assert_eq!(
        anthropic_tool["input_schema"]["properties"]["max_output_tokens"]["type"],
        "integer"
    );
}

#[test]
fn responses_inbound_does_not_rewrite_string_session_id_schema() {
    let request = super::super::responses_openai_codec::build_v3_chat_canonical_request_from_responses_payload_for_req_inbound_compat(&json!({
        "model": "gpt-5.5",
        "tools": [{
            "type": "function",
            "name": "write_stdin",
            "parameters": {
                "type": "object",
                "properties": {"session_id": {"type": "string"}}
            }
        }],
        "input": [{
            "type": "message",
            "role": "user",
            "content": [{"type": "input_text", "text": "poll"}]
        }]
    }))
    .expect("Responses request must canonicalize");

    assert_eq!(
        request["tools"][0]["parameters"]["properties"]["session_id"]["type"],
        "string"
    );
}

#[test]
fn responses_inbound_does_not_rewrite_same_named_user_tool_schema() {
    let request = super::super::responses_openai_codec::build_v3_chat_canonical_request_from_responses_payload_for_req_inbound_compat(&json!({
        "model": "gpt-5.5",
        "tools": [{
            "type": "function",
            "name": "exec_command",
            "description": "User-defined command tool",
            "strict": false,
            "parameters": {
                "type": "object",
                "additionalProperties": false,
                "properties": {
                    "cmd": {"type": "string"},
                    "justification": {"type": "string"},
                    "login": {"type": "boolean"},
                    "max_output_tokens": {"type": "number", "minimum": 1},
                    "prefix_rule": {"type": "array", "items": {"type": "string"}},
                    "sandbox_permissions": {"type": "string", "enum": ["use_default", "require_escalated"]},
                    "shell": {"type": "string"},
                    "tty": {"type": "boolean"},
                    "workdir": {"type": "string"},
                    "yield_time_ms": {"type": "number"}
                },
                "required": ["cmd"]
            }
        }],
        "input": [{
            "type": "message",
            "role": "user",
            "content": [{"type": "input_text", "text": "custom"}]
        }]
    }))
    .expect("Responses request must canonicalize");

    assert_eq!(
        request["tools"][0]["parameters"]["properties"]["yield_time_ms"]["type"],
        "number"
    );
    assert_eq!(
        request["tools"][0]["parameters"]["properties"]["max_output_tokens"]["type"],
        "number"
    );
}
#[test]
fn responses_web_search_call_projects_to_openai_chat_tool_pair_with_synthetic_id() {
    let request = build_v3_chat_canonical_request_from_responses_payload(&json!({
        "model": "gpt-5.5",
        "input": [
            {
                "type": "web_search_call",
                "status": "failed",
                "action": {
                    "type": "search",
                    "query": "微信小程序 发布流程",
                    "queries": ["微信小程序 发布流程", "微信小程序 request 合法域名"]
                }
            },
            {
                "type": "message",
                "role": "user",
                "content": [{"type": "input_text", "text": "继续"}]
            }
        ]
    }))
    .expect("web_search_call history must project to legal OpenAI Chat tool pair");

    let messages = request["messages"].as_array().expect("messages");
    assert_eq!(
        messages.len(),
        3,
        "must emit pair plus following user: {request}"
    );
    assert_eq!(messages[0]["role"], json!("assistant"));
    assert_eq!(messages[0]["content"], json!(""));
    assert_eq!(
        messages[0]["tool_calls"][0]["id"],
        json!("call_routecodex_web_search_0")
    );
    assert_eq!(
        messages[0]["tool_calls"][0]["function"]["name"],
        json!("web_search")
    );
    let arguments: Value = serde_json::from_str(
        messages[0]["tool_calls"][0]["function"]["arguments"]
            .as_str()
            .expect("arguments string"),
    )
    .expect("web_search arguments must be JSON");
    assert_eq!(
        arguments,
        json!({
            "type": "search",
            "query": "微信小程序 发布流程",
            "queries": ["微信小程序 发布流程", "微信小程序 request 合法域名"]
        })
    );
    assert_eq!(messages[1]["role"], json!("tool"));
    assert_eq!(
        messages[1]["tool_call_id"],
        json!("call_routecodex_web_search_0"),
        "tool result must pair with assistant tool_call"
    );
    let result: Value = serde_json::from_str(
        messages[1]["content"]
            .as_str()
            .expect("tool result content string"),
    )
    .expect("tool result content must preserve web_search event as JSON");
    assert_eq!(result["type"], json!("web_search_call"));
    assert_eq!(result["status"], json!("failed"));
    assert_eq!(result["action"], arguments);
    assert_eq!(
        messages[2],
        json!({"role": "user", "content": [{"type": "text", "text": "继续"}]})
    );
}
#[test]
fn responses_tool_search_call_and_output_normalize_as_adjacent_chat_extensions() {
    let discovered_tools = json!([{
        "type": "namespace",
        "name": "mcp__node_repl",
        "tools": [{
            "type": "function",
            "name": "js",
            "description": "Run JS",
            "parameters": {"type": "object"}
        }]
    }]);
    let request = build_v3_chat_canonical_request_from_responses_payload(&json!({
        "model": "gpt-5.5",
        "input": [
            {
                "type": "tool_search_call",
                "call_id": "call_FTUTqdbVH4EQwpp0DWcX5q6M",
                "execution": "client",
                "status": "completed",
                "arguments": {
                    "query": "multi-agent send message to existing agent status resume agent",
                    "limit": 8
                }
            },
            {
                "type": "tool_search_output",
                "id": "tso_123",
                "call_id": "call_FTUTqdbVH4EQwpp0DWcX5q6M",
                "execution": "client",
                "status": "completed",
                "tools": discovered_tools
            },
            {
                "type": "message",
                "role": "user",
                "content": [{"type": "input_text", "text": "继续"}]
            }
        ]
    }))
    .expect("tool_search call/output must normalize to adjacent Chat tool history");

    let messages = request["messages"].as_array().expect("messages");
    assert_eq!(
        messages.len(),
        3,
        "must emit pair plus following user: {request}"
    );
    assert_eq!(messages[0]["role"], json!("assistant"));
    assert_eq!(
        messages[0]["tool_calls"][0]["id"],
        json!("call_FTUTqdbVH4EQwpp0DWcX5q6M")
    );
    assert_eq!(
        messages[0]["tool_calls"][0]["function"]["name"],
        json!("tool_search")
    );
    assert_eq!(
        messages[0]["tool_calls"][0]["routecodex_chat_extension"]["responses_tool_call_type"],
        json!("tool_search_call")
    );
    let arguments: Value = serde_json::from_str(
        messages[0]["tool_calls"][0]["function"]["arguments"]
            .as_str()
            .expect("tool_search arguments string"),
    )
    .expect("tool_search arguments must be JSON");
    assert_eq!(
        arguments,
        json!({
            "query": "multi-agent send message to existing agent status resume agent",
            "limit": 8
        })
    );
    assert_eq!(messages[1]["role"], json!("tool"));
    assert_eq!(
        messages[1]["tool_call_id"],
        json!("call_FTUTqdbVH4EQwpp0DWcX5q6M")
    );
    let result: Value = serde_json::from_str(
        messages[1]["content"]
            .as_str()
            .expect("tool result content string"),
    )
    .expect("tool result content must preserve discovered tools as JSON");
    assert_eq!(result, discovered_tools);
    assert_eq!(
        messages[1]["routecodex_chat_extension"],
        json!({
            "responses_tool_output_type": "tool_search_output",
            "responses_output_field": "tools",
            "responses_item_id": "tso_123",
            "responses_status": "completed",
            "responses_execution": "client"
        })
    );
    assert_eq!(
        messages[2],
        json!({"role": "user", "content": [{"type": "text", "text": "继续"}]})
    );
    assert!(
        messages.iter().all(|message| {
            message.get("type").and_then(Value::as_str) != Some("tool_search_call")
        }),
        "OpenAI Chat messages must not embed native Responses tool_search_call items: {request}"
    );
}
#[test]
fn responses_tool_search_output_without_matching_call_fails_in_inbound_owner() {
    let error = build_v3_chat_canonical_request_from_responses_payload(&json!({
        "model": "gpt-5.5",
        "input": [{
            "type": "tool_search_output",
            "call_id": "call_missing",
            "status": "completed",
            "execution": "client",
            "tools": []
        }]
    }))
    .expect_err("orphan tool_search_output must not cross ReqInbound02");

    assert!(
        error.contains("no preceding assistant tool_call"),
        "unexpected error: {error}"
    );
}
#[test]
fn responses_function_call_item_id_enters_chat_extension() {
    let request = build_v3_chat_canonical_request_from_responses_payload(&json!({
        "model": "gpt-5.5",
        "input": [{
            "type": "function_call",
            "id": "fc_original",
            "call_id": "call_original",
            "name": "lookup",
            "arguments": "{\"q\":\"x\"}"
        }]
    }))
    .expect("Responses function_call must normalize to Chat canonical");

    let tool_call = &request["messages"][0]["tool_calls"][0];
    assert_eq!(tool_call["id"], "call_original");
    assert_eq!(
        tool_call["routecodex_chat_extension"]["responses_item_id"],
        "fc_original"
    );
}
#[test]
fn responses_web_search_call_preserves_existing_id_for_tool_pair() {
    let request = build_v3_chat_canonical_request_from_responses_payload(&json!({
        "model": "gpt-5.5",
        "input": [{
            "type": "web_search_call",
            "id": "ws_123",
            "status": "completed",
            "action": {"type": "open_page", "url": "https://example.com"},
            "result": {"title": "Example"},
            "result_items": [{"url": "https://example.com", "title": "Example"}],
            "output": "opened"
        }]
    }))
    .expect("web_search_call with id must project");

    let messages = request["messages"].as_array().expect("messages");
    assert_eq!(messages.len(), 2, "web_search_call must be atomic pair");
    assert_eq!(messages[0]["tool_calls"][0]["id"], json!("ws_123"));
    assert_eq!(messages[1]["tool_call_id"], json!("ws_123"));
    let result: Value = serde_json::from_str(messages[1]["content"].as_str().unwrap())
        .expect("tool result content JSON");
    assert_eq!(result["id"], json!("ws_123"));
    assert_eq!(result["result"], json!({"title": "Example"}));
    assert_eq!(
        result["result_items"],
        json!([{"url": "https://example.com", "title": "Example"}])
    );
    assert_eq!(result["output"], json!("opened"));
}
#[test]
fn responses_web_search_call_never_emits_unpaired_tool_call_or_native_item() {
    let request = build_v3_chat_canonical_request_from_responses_payload(&json!({
        "model": "gpt-5.5",
        "input": [{
            "type": "web_search_call",
            "status": "failed"
        }]
    }))
    .expect("web_search_call without action still projects as empty-argument pair");

    let messages = request["messages"].as_array().expect("messages");
    assert_eq!(messages.len(), 2, "must not emit only assistant tool_call");
    assert_eq!(messages[0]["role"], json!("assistant"));
    assert_eq!(messages[1]["role"], json!("tool"));
    let call_id = messages[0]["tool_calls"][0]["id"].as_str().unwrap();
    assert_eq!(messages[1]["tool_call_id"], json!(call_id));
    let arguments: Value = serde_json::from_str(
        messages[0]["tool_calls"][0]["function"]["arguments"]
            .as_str()
            .unwrap(),
    )
    .expect("empty action arguments JSON");
    assert_eq!(arguments, json!({}));
    assert!(
        messages
            .iter()
            .all(|message| message.get("type").and_then(Value::as_str) != Some("web_search_call")),
        "provider Chat messages must not contain a native Responses input item object: {request}"
    );
}
#[test]
fn responses_web_search_call_normalizes_to_chat_extension_at_req_inbound() {
    let payload = json!({
        "model": "gpt-5.5",
        "input": [{
            "type": "web_search_call",
            "status": "failed",
            "action": {"type": "search", "query": "RouteCodex"}
        }]
    });
    let request = build_v3_chat_canonical_request_from_responses_payload_for_req_inbound(&payload)
        .expect("ReqInbound must normalize web_search_call into Chat extension history without raw payload carry");
    let messages = request["messages"].as_array().expect("messages");
    assert_eq!(messages.len(), 2, "{request}");
    assert_eq!(
        messages[0]["tool_calls"][0]["function"]["name"],
        "web_search"
    );
    assert_eq!(
        messages[1]["tool_call_id"],
        messages[0]["tool_calls"][0]["id"]
    );
}
#[test]
fn responses_web_search_call_preserves_business_names_before_tool_result_stringification() {
    let request = build_v3_chat_canonical_request_from_responses_payload(&json!({
        "model": "gpt-5.5",
        "input": [{
            "type": "web_search_call",
            "status": "failed",
            "action": {"type": "search", "query": "RouteCodex"},
            "routeHint": "debug-control"
        }]
    }))
    .expect("hosted tool business fields remain representable");
    assert!(request.to_string().contains("debug-control"));

    let request = build_v3_chat_canonical_request_from_responses_payload(&json!({
        "model": "gpt-5.5",
        "input": [{
            "type": "web_search_call",
            "status": "failed",
            "action": {"type": "search", "query": "RouteCodex", "routeHint": "nested-control"}
        }]
    }))
    .expect("nested business fields remain representable");
    assert!(request.to_string().contains("nested-control"));

    let request = build_v3_chat_canonical_request_from_responses_payload(&json!({
        "model": "gpt-5.5",
        "input": [{
            "type": "web_search_call",
            "status": "failed",
            "action": {"type": "search", "query": "RouteCodex", "_debug": true}
        }]
    }))
    .expect("underscore business names remain representable");
    assert!(request.to_string().contains("_debug"));
}

#[test]
fn responses_tool_search_output_preserves_private_named_json_schema_definitions() {
    let tools = json!([{
        "type": "namespace",
        "name": "mcp__codex_apps__chatgpt_space",
        "tools": [{
            "type": "function",
            "name": "_patch_page",
            "parameters": {
                "type": "object",
                "$defs": {
                    "_PatchPageChange": {
                        "type": "object",
                        "properties": {"block_id": {"type": "string"}}
                    }
                },
                "properties": {
                    "changes": {"items": {"$ref": "#/$defs/_PatchPageChange"}}
                }
            }
        }]
    }]);
    let request = build_v3_chat_canonical_request_from_responses_payload(&json!({
        "model": "gpt-5.5",
        "input": [
            {"type": "tool_search_call", "call_id": "call_search", "arguments": {}},
            {"type": "tool_search_output", "call_id": "call_search", "tools": tools}
        ]
    }))
    .expect("tool search output JSON Schema names are business data, not proxy control fields");

    let serialized = request["messages"][1]["content"]
        .as_str()
        .expect("tool search output is preserved in tool content");
    let normalized_tools: Value = serde_json::from_str(serialized).expect("tool list JSON");
    assert_eq!(normalized_tools, tools);
}

#[test]
fn responses_tool_search_output_keeps_client_schema_keys_with_leading_underscore() {
    // 线上样本：客户端 `tool_search_output` 携带 ChatGPT Space 工具目录，其中一个
    // 工具的 JSON Schema `$defs` 名是 `_ReplaceBlock`。它属于客户端数据，不是
    // RouteCodex 控制键；inbound canonicalization 必须原样保留，不能 400。
    let canonical = build_v3_chat_canonical_request_from_responses_payload(&json!({
        "model": "gpt-5.5",
        "input": [{
            "type": "tool_search_call",
            "call_id": "call_tool_search_1",
            "execution": "client",
            "status": "completed",
            "arguments": {"query": "chatgpt space page edit", "limit": 8}
        }, {
            "type": "tool_search_output",
            "id": "tso_1",
            "call_id": "call_tool_search_1",
            "status": "completed",
            "execution": "client",
            "tools": [{
                "type": "namespace",
                "name": "mcp__codex_apps__chatgpt_space",
                "tools": [{
                    "type": "function",
                    "name": "apply_page_changes",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "changes": {"type": "array", "items": {"$ref": "#/$defs/_ReplaceBlock"}}
                        },
                        "$defs": {
                            "_ReplaceBlock": {
                                "type": "object",
                                "properties": {"block_id": {"type": "string"}},
                                "required": ["block_id"]
                            }
                        }
                    }
                }]
            }]
        }, {
            "role": "user",
            "content": [{"type": "input_text", "text": "continue"}]
        }]
    }))
    .expect("client tool catalog underscore keys must pass inbound canonicalization");
    let serialized = canonical.to_string();
    assert!(
        serialized.contains("_ReplaceBlock"),
        "client schema definition must survive canonicalization: {serialized}"
    );
}

#[test]
fn responses_compaction_input_item_is_discarded_before_chat_encoding() {
    let with_compaction = build_v3_chat_canonical_request_from_responses_payload(&json!({
        "model": "gpt-5.5",
        "input": [{
            "type": "message",
            "role": "user",
            "content": [{"type": "input_text", "text": "hi"}]
        }, {
            "type": "compaction",
            "encrypted_content": "gAAAAABjYW5vbmljYWwtc2VjcmV0LWl2LXNhbHQ="
        }]
    }))
    .expect("client compaction item with encrypted content must be discarded, not rejected");

    let without_compaction = build_v3_chat_canonical_request_from_responses_payload(&json!({
        "model": "gpt-5.5",
        "input": [{
            "type": "message",
            "role": "user",
            "content": [{"type": "input_text", "text": "hi"}]
        }]
    }))
    .expect("baseline without compaction must encode");

    assert_eq!(
        with_compaction, without_compaction,
        "compaction item must not leak into provider chat messages"
    );
}

#[test]
fn responses_unknown_input_item_type_still_fails_fast() {
    let error = build_v3_chat_canonical_request_from_responses_payload(&json!({
        "model": "gpt-5.5",
        "input": [{
            "type": "message",
            "role": "user",
            "content": [{"type": "input_text", "text": "hi"}]
        }, {
            "type": "future_mystery_item",
            "payload": {"anything": true}
        }]
    }))
    .expect_err("genuinely unknown Responses input item types must keep failing fast");
    assert!(
        error.contains("unsupported Responses input item type"),
        "unexpected error: {error}"
    );
}

#[test]
fn responses_system_message_between_pending_tool_call_and_result_defers_to_preserve_tool_adjacency()
{
    let request = build_v3_chat_canonical_request_from_responses_payload(&json!({
        "model": "gpt-5.5",
        "input": [{
            "type": "function_call",
            "name": "dummy_tool",
            "call_id": "call_01repro400",
            "arguments": "{}"
        }, {
            "type": "message",
            "role": "system",
            "content": [{"type": "input_text", "text": "system after pending tool call"}]
        }, {
            "type": "function_call_output",
            "call_id": "call_01repro400",
            "output": "tool output"
        }]
    }))
    .expect("system message after a pending tool call must defer instead of rejecting");

    let messages = request["messages"].as_array().expect("messages");
    assert_eq!(messages.len(), 3, "{request}");
    assert_eq!(messages[0]["role"], json!("assistant"));
    assert_eq!(messages[0]["tool_calls"][0]["id"], json!("call_01repro400"));
    assert_eq!(messages[1]["role"], json!("tool"));
    assert_eq!(messages[1]["tool_call_id"], json!("call_01repro400"));
    assert_eq!(messages[2]["role"], json!("system"));
    assert_eq!(
        messages[2]["content"],
        json!([{"type": "text", "text": "system after pending tool call"}])
    );
}
