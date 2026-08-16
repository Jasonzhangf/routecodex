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
    assert_eq!(messages[2], json!({"role": "user", "content": "继续"}));
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
    assert_eq!(messages[2], json!({"role": "user", "content": "继续"}));
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
fn responses_web_search_call_rejects_side_channel_before_tool_result_stringification() {
    let error = build_v3_chat_canonical_request_from_responses_payload(&json!({
        "model": "gpt-5.5",
        "input": [{
            "type": "web_search_call",
            "status": "failed",
            "action": {"type": "search", "query": "RouteCodex"},
            "routeHint": "debug-control"
        }]
    }))
    .expect_err(
        "RouteCodex control fields must fail before provider tool-result JSON stringification",
    );
    assert!(
        error.contains("side-channel field") && error.contains("routeHint"),
        "unexpected error: {error}"
    );

    let error = build_v3_chat_canonical_request_from_responses_payload(&json!({
        "model": "gpt-5.5",
        "input": [{
            "type": "web_search_call",
            "status": "failed",
            "action": {"type": "search", "query": "RouteCodex", "_debug": true}
        }]
    }))
    .expect_err("private debug fields must fail before provider tool-result JSON stringification");
    assert!(
        error.contains("private debug field") && error.contains("_debug"),
        "unexpected error: {error}"
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
